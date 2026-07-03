// Kill all customize-agent processes before install/upgrade (prevents Windows EBUSY)
// Order: kill CLI first (prevents auto-restart of server) → kill server → wait for handle release
var execSync = require('child_process').execSync;
var isWin = process.platform === 'win32';
var DASHBOARD_PORT = 17321;
var CHROMA_PORT = 17322;

function log(msg) {
  process.stderr.write('[customize-agent] ' + msg + '\n');
}

function run(cmd, timeoutMs) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs || 5000, stdio: 'pipe' }).trim();
  } catch (e) { return ''; }
}

function sleep(ms) {
  if (isWin) {
    run('timeout /t ' + Math.ceil(ms / 1000) + ' /nobreak >nul', ms + 3000);
  } else {
    run('sleep ' + (ms / 1000), ms + 3000);
  }
}

// ─── Windows: kill processes by command line (Get-CimInstance is most reliable) ───
function killWindowsByCommandLine(pattern, label) {
  // Strategy A: Get-CimInstance Win32_Process — works on all Win7+/Server2008+ systems
  // Unlike Get-Process, Get-CimInstance always exposes CommandLine regardless of user context
  var psCmd =
    '$filter = "Name=\'node.exe\'"; ' +
    '$procs = Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.CommandLine -like \'*' + pattern + '*\' }; ' +
    'if ($procs) { ' +
    '  foreach ($p in $procs) { ' +
    '    Write-Host "KILL_' + label + ': $($p.ProcessId)"; ' +
    '    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; ' +
    '  } ' +
    '}';

  var result = run('powershell -NoProfile -Command "' + psCmd.replace(/"/g, '\\"') + '"', 15000);
  if (result) {
    result.split(/\r?\n/).filter(function (l) { return l.indexOf('KILL_' + label) !== -1; }).forEach(function (l) { log(l.replace('KILL_' + label + ': ', 'Killed ' + label + ' PID ')); });
  }

  // Strategy B: wmic fallback (deprecated but widely available)
  var wmicOut = run('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', 8000);
  if (wmicOut) {
    var lines = wmicOut.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(pattern) !== -1) {
        var fields = lines[i].split(',');
        var pid = fields[fields.length - 1].trim();
        if (pid && /^\d+$/.test(pid)) {
          run('taskkill /F /PID ' + pid, 3000);
          log('Killed ' + label + ' PID ' + pid + ' (wmic)');
        }
      }
    }
  }
}

function killPort(port) {
  if (isWin) {
    // Strategy: netstat + taskkill
    var out = run('netstat -ano | findstr "LISTENING" | findstr ":' + port + ' "');
    if (out) {
      var lines = out.split(/\r?\n/);
      var killed = {};
      for (var i = 0; i < lines.length; i++) {
        var parts = lines[i].trim().split(/\s+/);
        var pid = parts[parts.length - 1];
        if (pid && !killed[pid] && /^\d+$/.test(pid)) {
          killed[pid] = true;
          run('taskkill /F /PID ' + pid, 3000);
          log('Killed port ' + port + ' PID ' + pid);
        }
      }
    }
  } else {
    // macOS/Linux: lsof + SIGTERM
    var result = run('lsof -tiTCP:' + port + ' -sTCP:LISTEN', 3000);
    if (!result) return;
    var pids = result.split('\n').filter(Boolean);
    for (var j = 0; j < pids.length; j++) {
      try { process.kill(Number(pids[j]), 'SIGTERM'); log('Killed port ' + port + ' PID ' + pids[j]); } catch (e) { /* already dead */ }
    }
  }
}

function killUnixByCommandLine() {
  if (isWin) return;
  // Send SIGTERM to any node process matching customize-agent patterns
  var result = run('pgrep -f "customize-agent|dist/index.js|server.js" 2>/dev/null', 3000);
  if (result) {
    var pids = result.split('\n').filter(Boolean);
    for (var i = 0; i < pids.length; i++) {
      try { process.kill(Number(pids[i]), 'SIGTERM'); log('Killed PID ' + pids[i] + ' (pgrep)'); } catch (e) { /* already dead */ }
    }
  }
}

// ══════════════════════════════════════════════
// Main execution
// ══════════════════════════════════════════════

log('Stopping all customize-agent processes...');

// Step 1: Kill CLI processes FIRST (prevents auto-restart of dashboard server)
if (isWin) {
  killWindowsByCommandLine('customize-agent', 'CLI');
  killWindowsByCommandLine('dist\\\\index.js', 'CLI');
} else {
  killUnixByCommandLine();
}

sleep(1000);

// Step 2: Kill server processes by port + command line (3 rounds)
for (var attempt = 0; attempt < 3; attempt++) {
  killPort(DASHBOARD_PORT);
  killPort(CHROMA_PORT);

  if (attempt === 0 && isWin) {
    killWindowsByCommandLine('server.js', 'SRV');
  }

  if (attempt < 2) {
    sleep(2000);
  }
}

// Step 3: Final wait for Windows to release file handles (critical for EBUSY prevention)
if (isWin) {
  log('Waiting for Windows to release file handles...');
  sleep(3000);
}

log('Done. Safe to install.');
