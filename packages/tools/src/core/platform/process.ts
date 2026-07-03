// @customize-agent/tools — Cross-platform process manager
//
// Provides unified process termination and cleanup signal handling
// that works across Windows, macOS, and Linux.
//
// Windows: uses taskkill /T /F (tree kill)
// Unix:    uses SIGTERM with 3s timeout fallback to SIGKILL

import { execa } from 'execa';
import { isWindows } from './utils.js';
import type { ProcessReference } from './types.js';

/**
 * Cross-platform process termination.
 *
 * @param proc - A process-like object with optional pid and kill method.
 *   Works with both Node.js ChildProcess and simple {pid} objects.
 */
export async function killProcess(proc: ProcessReference | null | undefined): Promise<void> {
  if (!proc) return;

  // If we have a PID, prefer platform-specific termination
  if (proc.pid) {
    await killByPid(proc.pid);
    return;
  }

  // Fallback: use the kill method if available (works for ChildProcess)
  if (proc.kill && typeof proc.kill === 'function') {
    try {
      (proc.kill as () => boolean)();
    } catch {
      // On Windows, .kill() without signal works
      // On Unix, SIGTERM is the default
    }
  }
}

/**
 * Kill a process tree by root PID.
 * On Windows: uses taskkill /T /F to kill the entire process tree
 * On Unix: uses SIGTERM with a 3s timeout fallback to SIGKILL
 */
export async function killByPid(pid: number): Promise<void> {
  if (isWindows()) {
    // Windows: taskkill with /T (tree) and /F (force)
    try {
      await execa('taskkill', ['/T', '/F', '/PID', String(pid)], { reject: false });
    } catch {
      // Process may have already exited — ignore
    }
    return;
  }

  // Unix: SIGTERM first, then SIGKILL after timeout
  try {
    process.kill(pid, 'SIGTERM');

    // Wait up to 3 seconds for graceful shutdown
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        try {
          process.kill(pid, 0); // Check if process exists
        } catch {
          // Process no longer exists
          clearInterval(checkInterval);
          resolve();
        }
      }, 200);

      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 3_000);
    });

    // Force kill if still running
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited — ok
    }
  } catch {
    // Process already exited or invalid PID — ok
  }
}

// ── Cleanup Signal Management ──────────────────────────────────────────────

type CleanupHandler = () => void | Promise<void>;

const cleanupHandlers = new Set<CleanupHandler>();
let cleanupRegistered = false;

/**
 * Register a cleanup handler that fires on process termination signals.
 *
 * Supported signals:
 *   - SIGINT (Ctrl+C) — all platforms
 *   - SIGTERM — all platforms (emulated on Windows by Node.js)
 *   - exit — all platforms (fires on process.exit())
 *
 * Handlers are deduplicated — registering the same function twice is a no-op.
 */
export function onCleanup(handler: CleanupHandler): void {
  cleanupHandlers.add(handler);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    registerGlobalCleanup();
  }
}

/**
 * Remove a previously registered cleanup handler.
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
      // Best-effort cleanup — don't let one handler block others
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

  // 'exit' event is synchronous — fire handlers but don't block
  process.on('exit', () => {
    for (const handler of cleanupHandlers) {
      try {
        void handler();
        // If handler returns a promise, we can't await it in 'exit'
        // Best-effort: execute synchronously and hope it resolves in time
      } catch {
        // Best-effort
      }
    }
  });
}

/**
 * Shut down all processes immediately and run cleanup handlers.
 * Call this before programmatic process.exit().
 */
export async function shutdown(): Promise<void> {
  await runAllCleanupHandlers();
}
