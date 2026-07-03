// 安装/升级前停止所有 customize-agent 进程，避免 Windows EBUSY
// 关键：先杀 CLI 进程（防止自动重启 server），再杀 server 进程
var execSync = require('child_process').execSync;
var isWin = process.platform === 'win32';
var DASHBOARD_PORT = 17321;
var CHROMA_PORT = 17322;

// stderr 输出 — npm install 时 stdout 可能被缓冲，stderr 确保可见
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

// ─── 策略 1: 先杀 CLI 进程（最关键！防止 CLI 自动重启 server）───
function killCLIProcess() {
  if (isWin) {
    // PowerShell: 杀所有运行 customize-agent CLI 的 node.exe
    var psResult = run(
      'powershell -NoProfile -Command "' +
      '$procs = Get-Process -Name node -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.CommandLine -match \\"customize-agent\\" -or $_.CommandLine -match \\"dist[\\\\\\\\/]index\\\\.js\\" -or $_.CommandLine -match \\"@customize-agent\\" }; ' +
      'if ($procs) { $procs | ForEach-Object { Write-Host \\"KILLING_CLI:\\" $_.Id; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } }"',
      15000
    );
    if (psResult && psResult.indexOf('KILLING_CLI:') !== -1) {
      log('Killed CLI process(es): ' + psResult.replace(/KILLING_CLI:/g, '').trim());
    }

    // wmic 兜底
    var wmicOut = run('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', 8000);
    if (wmicOut) {
      var lines = wmicOut.split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('customize-agent') !== -1 || line.indexOf('dist\\index.js') !== -1) {
          var fields = line.split(',');
          var pid = fields[fields.length - 1].trim();
          if (pid && /^\d+$/.test(pid) && pid !== String(process.pid)) {
            run('taskkill /F /PID ' + pid, 3000);
            log('Killed CLI process (wmic): PID ' + pid);
          }
        }
      }
    }
  } else {
    // macOS/Linux: pkill -f 匹配 CLI 进程
    var result = run('pkill -f "customize-agent" 2>/dev/null; pkill -f "dist/index.js" 2>/dev/null', 5000);
    if (result) log('Killed CLI process(es) on macOS/Linux');
  }
}

// ─── 策略 2: 按端口杀 server 进程 ───
function killPort(port) {
  if (isWin) {
    // PowerShell Get-NetTCPConnection
    var psResult = run(
      'powershell -NoProfile -Command "' +
      '$conns = Get-NetTCPConnection -LocalPort ' + port + ' -ErrorAction SilentlyContinue; ' +
      'if ($conns) { $ids = ($conns | Select-Object -ExpandProperty OwningProcess -Unique); ' +
      '$ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue; Write-Host \\"KILLED_PORT_' + port + ': $_\\" } }"',
      10000
    );
    if (psResult && psResult.indexOf('KILLED_PORT') !== -1) log('Port ' + port + ': ' + psResult.trim());

    // netstat + taskkill 兜底
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
          log('Killed port ' + port + ' process: PID ' + pid + ' (netstat)');
        }
      }
    }
  } else {
    var result = run('lsof -tiTCP:' + port + ' -sTCP:LISTEN', 3000);
    if (!result) return;
    var pids = result.split('\n').filter(Boolean);
    for (var j = 0; j < pids.length; j++) {
      try { process.kill(Number(pids[j]), 'SIGTERM'); log('Killed port ' + port + ': PID ' + pids[j]); } catch (e) { /* already dead */ }
    }
  }
}

// ─── 策略 3: 按命令行杀残留 server 进程 ───
function killServerByCommandLine() {
  if (isWin) {
    run(
      'powershell -NoProfile -Command "' +
      'Get-Process -Name node -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.CommandLine -match \\"server\\\\.js\\" } | ' +
      'ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Write-Host \\"KILLED_SERVER:\\" $_.Id }"',
      10000
    );
  } else {
    run('pkill -f "server.js" 2>/dev/null', 5000);
  }
}

// ══════════════════════════════════════════════
// 执行流程
// ══════════════════════════════════════════════

log('Stopping all customize-agent processes...');

// 第一步: 先杀 CLI 进程！防止 CLI 重启 server
killCLIProcess();
sleep(1000);

// 第二步: 用端口 + 命令行反复杀 server
for (var attempt = 0; attempt < 3; attempt++) {
  killPort(DASHBOARD_PORT);
  killPort(CHROMA_PORT);
  if (attempt === 0) {
    killServerByCommandLine();
  }
  if (attempt < 2) {
    sleep(2000);
  }
}

// 第三步: Windows 最终等待文件句柄释放
if (isWin) {
  log('Waiting for Windows to release file handles...');
  sleep(3000);
}

log('Done. Safe to install.');
