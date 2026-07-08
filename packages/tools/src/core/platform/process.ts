// @customize-agent/tools — 跨平台进程管理
//
// 提供统一的进程终止和清理信号处理，兼容 Windows、macOS 和 Linux。
//
// Windows：使用 taskkill /T /F（进程树终止）
// Unix：使用 SIGTERM + 3 秒超时降级为 SIGKILL

import { execa } from 'execa';
import { isWindows } from './utils.js';
import type { ProcessReference } from './types.js';

/**
 * 跨平台进程终止。
 *
 * @param proc - 类进程对象，可选 pid 和 kill 方法。
 *   同时支持 Node.js ChildProcess 和简单 {pid} 对象。
 */
export async function killProcess(proc: ProcessReference | null | undefined): Promise<void> {
  if (!proc) return;

  // 如果有 PID，优先使用平台特定终止方式
  if (proc.pid) {
    await killByPid(proc.pid);
    return;
  }

  // 回退：使用 kill 方法（适用于 ChildProcess）
  if (proc.kill && typeof proc.kill === 'function') {
    try {
      (proc.kill as () => boolean)();
    } catch {
      // Windows 上 .kill() 不带信号即可工作
      // Unix 上默认发送 SIGTERM
    }
  }
}

/**
 * 按根 PID 终止进程树。
 * Windows：使用 taskkill /T /F 终止整个进程树
 * Unix：使用 SIGTERM + 3 秒超时降级为 SIGKILL
 */
export async function killByPid(pid: number): Promise<void> {
  if (isWindows()) {
    // Windows：taskkill 带 /T（进程树）和 /F（强制）
    try {
      await execa('taskkill', ['/T', '/F', '/PID', String(pid)], { reject: false });
    } catch {
      // 进程可能已退出 — 忽略
    }
    return;
  }

  // Unix：先 SIGTERM，超时后 SIGKILL
  try {
    process.kill(pid, 'SIGTERM');

    // 最多等待 3 秒优雅退出
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        try {
          process.kill(pid, 0); // 检查进程是否存在
        } catch {
          // 进程已不存在
          clearInterval(checkInterval);
          resolve();
        }
      }, 200);

      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 3_000);
    });

    // 强制终止（如仍运行中）
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已退出 — 正常
    }
  } catch {
    // 进程已退出或 PID 无效 — 正常
  }
}

// ── 清理信号管理 ───────────────────────────────────────────────────────────

type CleanupHandler = () => void | Promise<void>;

const cleanupHandlers = new Set<CleanupHandler>();
let cleanupRegistered = false;

/**
 * 注册进程终止信号触发的清理处理器。
 *
 * 支持的信号：
 *   - SIGINT（Ctrl+C）— 所有平台
 *   - SIGTERM — 所有平台（Windows 上由 Node.js 模拟）
 *   - exit — 所有平台（process.exit() 触发）
 *
 * 处理器自动去重 — 注册同一函数两次不会重复执行。
 */
export function onCleanup(handler: CleanupHandler): void {
  cleanupHandlers.add(handler);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    registerGlobalCleanup();
  }
}

/**
 * 移除之前注册的清理处理器。
 */
export function offCleanup(handler: CleanupHandler): void {
  cleanupHandlers.delete(handler);
}

let cleanupRunning = false;

async function runAllCleanupHandlers(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;

  for (const handler of cleanupHandlers) {
    try {
      await handler();
    } catch {
      // 尽力清理 — 不让一个处理器阻塞其他处理器
    }
  }
}

function registerGlobalCleanup(): void {
  // ⚠️ 清理处理器仅设置 exitCode，不强制 process.exit()
  // 调用方可在清理完成后自行决定是否退出进程
  process.once('SIGINT', () => {
    void runAllCleanupHandlers().then(() => { process.exitCode = 130; });
  });

  process.once('SIGTERM', () => {
    void runAllCleanupHandlers().then(() => { process.exitCode = 143; });
  });

  // 'exit' 事件是同步的 — 触发处理器但不阻塞退出
  process.on('exit', () => {
    for (const handler of cleanupHandlers) {
      try {
        void handler();
        // 如果处理器返回 Promise，无法在 'exit' 中 await
        // 尽力同步执行，希望及时完成
      } catch {
        // 尽力执行
      }
    }
  });
}

/**
 * 立即关闭所有进程并运行清理处理器。
 * 在程序化调用 process.exit() 前调用。
 */
export async function shutdown(): Promise<void> {
  await runAllCleanupHandlers();
}
