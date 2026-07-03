// 安装/升级前停止旧版 server 进程，避免 Windows EBUSY
var execSync = require('child_process').execSync;
var isWin = process.platform === 'win32';
var DASHBOARD_PORT = 17321;
var CHROMA_PORT = 17322;

function run(cmd, timeoutMs) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs || 5000, stdio: 'pipe' }).trim();
  } catch (e) { return ''; }
}

// 真实的 sleep（不占 CPU）—— 用系统命令阻塞等待
function sleep(ms) {
  if (isWin) {
    // Windows: timeout /t 秒数 /nobreak >nul
    run('timeout /t ' + Math.ceil(ms / 1000) + ' /nobreak >nul', ms + 3000);
  } else {
    run('sleep ' + (ms / 1000), ms + 3000);
  }
}

// 按端口杀进程
function killPort(port) {
  if (isWin) {
    // 策略 1: PowerShell Get-NetTCPConnection（Windows 8+/Server 2012+）
    run(
      'powershell -NoProfile -Command "' +
      '$conns = Get-NetTCPConnection -LocalPort ' + port + ' -ErrorAction SilentlyContinue; ' +
      'if ($conns) { $conns | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"',
      10000
    );

    // 策略 2: netstat + taskkill（兜底）
    // 用正则精确匹配端口（避免 17321 匹配 173210）
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
        }
      }
    }
  } else {
    // macOS/Linux: lsof + SIGTERM
    var result = run('lsof -tiTCP:' + port + ' -sTCP:LISTEN', 3000);
    if (!result) return;
    var pids = result.split('\n').filter(Boolean);
    for (var j = 0; j < pids.length; j++) {
      try { process.kill(Number(pids[j]), 'SIGTERM'); } catch (e) { /* already dead */ }
    }
  }
}

// 按进程命令行杀 — 找到任何运行 customize-agent server 的 node 进程
function killByCommandLine() {
  if (!isWin) return;

  // 策略 3a: PowerShell 方式（更可靠）
  run(
    'powershell -NoProfile -Command "' +
    'Get-Process -Name node -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.CommandLine -match \\"customize-agent\\" -or $_.CommandLine -match \\"server\\\\.js\\" } | ' +
    'ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }"',
    10000
  );

  // 策略 3b: wmic 方式（PowerShell 不可用时的兜底）
  var wmicOut = run('wmic process where "name=\'node.exe\'" get processid,commandline /format:csv', 8000);
  if (wmicOut) {
    var lines = wmicOut.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('server.js') !== -1 || line.indexOf('customize-agent') !== -1) {
        // wmic CSV 格式最后一列是 ProcessId
        var fields = line.split(',');
        var pid = fields[fields.length - 1].trim();
        if (pid && /^\d+$/.test(pid)) {
          run('taskkill /F /PID ' + pid, 3000);
        }
      }
    }
  }
}

console.log('[customize-agent] Stopping old server processes...');

for (var attempt = 0; attempt < 3; attempt++) {
  killPort(DASHBOARD_PORT);
  killPort(CHROMA_PORT);
  if (attempt === 0) {
    // 第一轮额外按命令行杀 — 捕获端口监听已断开但进程仍在的情况
    killByCommandLine();
  }
  // 等待进程退出 + Windows 释放文件句柄
  if (attempt < 2) {
    sleep(2000);
  }
}

// Windows: 最终等待确保文件句柄已释放（EBUSY 修复的关键步骤）
// 旧版 server cwd 锁定了 dist/server/apps/server/，taskkill 后 Windows 需要时间回收句柄
if (isWin) {
  sleep(3000);
}

console.log('[customize-agent] Done.');
