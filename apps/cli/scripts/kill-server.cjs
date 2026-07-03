// 在安装/升级前停止所有 customize-agent server 进程
// 避免 Windows EBUSY: resource busy or locked 错误
const { execSync } = require('child_process');
const os = require('os');

const DASHBOARD_PORT = 17321;
const CHROMA_PORT = 17322;

function killPort(port) {
  try {
    if (os.platform() === 'win32') {
      // Windows: 使用 netstat 找到占用端口的 PID 并终止
      const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf8',
        timeout: 3000,
      });
      const lines = result.trim().split('\n');
      const killed = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !killed.has(pid)) {
          killed.add(pid);
          try {
            execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 });
            console.log(`  Killed process PID ${pid} on port ${port}`);
          } catch {
            // 进程可能已经退出
          }
        }
      }
    } else {
      // macOS / Linux: 使用 lsof 找到占用端口的 PID 并终止
      try {
        const result = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
          encoding: 'utf8',
          timeout: 3000,
        });
        const pids = result.trim().split('\n').filter(Boolean);
        for (const pid of pids) {
          try {
            process.kill(Number(pid), 'SIGTERM');
            console.log(`  Killed process PID ${pid} on port ${port}`);
          } catch {
            // 进程可能已经退出
          }
        }
      } catch {
        // lsof 没找到任何进程 — 正常
      }
    }
  } catch {
    // 端口上没有监听进程 — 正常
  }
}

console.log('[customize-agent] Stopping running server processes...');
killPort(DASHBOARD_PORT);
killPort(CHROMA_PORT);
console.log('[customize-agent] Done.');
