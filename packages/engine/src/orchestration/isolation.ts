// @customize-agent/engine — Multi-strategy sub-agent isolation
//
// 两种隔离策略，按优先级自动选择：
//   1. GitWorktreeIsolation — git worktree（最优，需 git + git repo）
//   2. SnapshotIsolation     — 内存快照（纯 JS，零外部依赖，始终可用）
//
// 非技术用户无 git 环境 → 自动使用 SnapshotIsolation，不会崩溃。

import { execa } from 'execa';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { WorkspaceSnapshotService, type WorkspaceSnapshot } from '@customize-agent/tools';
import { reportNonFatalError } from '@customize-agent/types';

// ── 公共类型 ──────────────────────────────────────────────────────────────────

export interface IsolationContext {
  /** 子 Agent 的工作目录（可能是原目录或临时 worktree 目录） */
  path: string;
  /** 使用的隔离策略标识 */
  strategy: 'git-worktree' | 'snapshot';
  /** 唯一 ID，用于清理和日志 */
  isolationId: string;
  /** git 分支名（仅 git-worktree 策略） */
  branch?: string;
  /** 内部状态：快照引用（仅 snapshot 策略） */
  _snapshot?: WorkspaceSnapshot;
}

export interface MergeResult {
  success: boolean;
  conflicts: string[];
}

export interface IsolationStrategy {
  readonly name: string;
  /** 检测此策略在当前环境是否可用 */
  isAvailable(): Promise<boolean>;
  /** 创建隔离环境 */
  create(isolationId: string, task: { expectedFiles: string[] }): Promise<IsolationContext>;
  /** 合并回主工作区（子 Agent 执行完成后调用） */
  merge(context: IsolationContext, taskSuccess: boolean): Promise<MergeResult>;
  /** 销毁隔离环境（释放资源） */
  destroy(context: IsolationContext): Promise<void>;
  /** 清理残留的隔离环境（如孤儿 worktree） */
  cleanupOrphans(): Promise<void>;
}

// ── 策略 A: Git Worktree 隔离 ────────────────────────────────────────────────

export class GitWorktreeIsolation implements IsolationStrategy {
  readonly name = 'git-worktree';
  private projectRoot: string;
  private tempDir: string;
  private locked = false;
  private pendingLocks: Array<() => void> = [];

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.tempDir = path.join(os.tmpdir(), 'customize-agent-worktrees');
  }

  /** FIFO 互斥锁 — 保护 git ref 操作不被并发写乱 */
  private async _acquireLock(): Promise<void> {
    if (!this.locked) { this.locked = true; return; }
    return new Promise<void>(resolve => { this.pendingLocks.push(resolve); });
  }

  /** 释放 FIFO 互斥锁 */
  private _releaseLock(): void {
    const next = this.pendingLocks.shift();
    if (next) { next(); } else { this.locked = false; }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const git = await execa({ cwd: this.projectRoot, reject: false })`git --version`;
      if (git.exitCode !== 0) return false;
      const check = await execa({ cwd: this.projectRoot, reject: false })`git rev-parse --is-inside-work-tree`;
      return check.exitCode === 0 && check.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async create(isolationId: string): Promise<IsolationContext> {
    await this._acquireLock();
    try {
      const branch = `agent/${isolationId}`;
      const worktreePath = path.join(this.tempDir, isolationId);

      await fs.mkdir(this.tempDir, { recursive: true });

      await execa({ cwd: this.projectRoot })`git branch ${branch}`;
      await execa({ cwd: this.projectRoot })`git worktree add ${worktreePath} ${branch}`;

      return {
        path: worktreePath,
        strategy: 'git-worktree',
        isolationId,
        branch,
      };
    } finally {
      this._releaseLock();
    }
  }

  async merge(context: IsolationContext, _taskSuccess: boolean): Promise<MergeResult> {
    if (!context.branch) return { success: false, conflicts: [] };

    await this._acquireLock();
    try {
      const status = await execa({ cwd: context.path, reject: false })`git status --porcelain`;
      if (status.stdout.trim()) {
        await execa({ cwd: context.path, reject: false })`git add -A`;
        const commit = await execa({ cwd: context.path, reject: false })`git commit -m ${`agent: ${context.isolationId}`}`;
        if (commit.exitCode !== 0) {
          return { success: false, conflicts: [commit.stderr || commit.stdout || 'commit failed'] };
        }
      }

      const result = await execa({
        cwd: this.projectRoot,
        reject: false,
      })`git merge --no-ff ${context.branch}`;

      if (result.exitCode === 0) return { success: true, conflicts: [] };

      // 中止合并，避免留下冲突态
      await execa({ cwd: this.projectRoot, reject: false })`git merge --abort`;

      const conflicts: string[] = [];
      const diffResult = await execa({
        cwd: this.projectRoot,
        reject: false,
      })`git diff --name-only --diff-filter=U`;
      for (const line of diffResult.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) conflicts.push(trimmed);
      }
      return { success: false, conflicts };
    } catch (err) {
      return { success: false, conflicts: [(err as Error).message] };
    } finally {
      this._releaseLock();
    }
  }

  async destroy(context: IsolationContext): Promise<void> {
    await this._acquireLock();
    try {
      await execa({ cwd: this.projectRoot, reject: false })`git worktree remove ${context.path} --force`;
      if (context.branch) {
        await execa({ cwd: this.projectRoot, reject: false })`git branch -D ${context.branch}`;
      }
    } catch (err) {
      reportNonFatalError({
        source: 'isolation.destroy_worktree',
        error: err,
        details: { path: context.path, branch: context.branch },
      });
    }
    finally {
      this._releaseLock();
    }
  }

  async cleanupOrphans(): Promise<void> {
    try {
      const result = await execa({ cwd: this.projectRoot, reject: false })`git worktree list --porcelain`;
      for (const line of result.stdout.split('\n')) {
        if (line.startsWith('worktree ') && line.includes(this.tempDir)) {
          const worktreePath = line.slice('worktree '.length);
          try {
            await execa({ cwd: this.projectRoot, reject: false })`git worktree remove ${worktreePath} --force`;
          } catch (err) {
            reportNonFatalError({ source: 'isolation.cleanup_orphan', error: err, details: { worktreePath } });
          }
        }
      }
    } catch (err) {
      reportNonFatalError({ source: 'isolation.cleanup_orphans', error: err });
    }
  }
}

// ── 策略 B: 内存快照隔离（纯 JS，零外部依赖，始终可用）─────────────────────

export class SnapshotIsolation implements IsolationStrategy {
  readonly name = 'snapshot';
  private projectRoot: string;
  private snapshotService: WorkspaceSnapshotService;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.snapshotService = new WorkspaceSnapshotService(projectRoot);
  }

  async isAvailable(): Promise<boolean> {
    // 始终可用 — 纯 JS 实现，零外部依赖
    return true;
  }

  async create(isolationId: string): Promise<IsolationContext> {
    // 在子 Agent 执行前保存完整工作区快照
    const snapshot = await this.snapshotService.takeSnapshot();

    return {
      path: this.projectRoot,
      strategy: 'snapshot',
      isolationId,
      _snapshot: snapshot,
    };
  }

  async merge(context: IsolationContext, taskSuccess: boolean): Promise<MergeResult> {
    if (taskSuccess) {
      // 子 Agent 成功 → 保留文件修改（无需操作，文件已原地修改）
      return { success: true, conflicts: [] };
    }
    // 子 Agent 失败 → 回滚所有文件到快照状态
    if (!context._snapshot) {
      return { success: false, conflicts: ['No snapshot available for rollback'] };
    }
    try {
      await this.snapshotService.restoreSnapshot(context._snapshot);
      return { success: false, conflicts: ['Restored workspace from snapshot'] };
    } catch (err) {
      return { success: false, conflicts: [(err as Error).message] };
    }
  }

  async destroy(context: IsolationContext): Promise<void> {
    // 释放内存中的快照引用
    context._snapshot = undefined;
  }

  async cleanupOrphans(): Promise<void> {
    // 内存快照无持久化残留
  }
}

// ── 工厂函数 — 自动选择最佳隔离策略 ──────────────────────────────────────────

/**
 * 创建最佳的隔离管理器。
 * 自动检测环境，按 git-worktree → snapshot 优先级选择。
 * Snapshot 是始终可用的纯 JS 回退方案，零外部依赖。
 */
export async function createIsolationManager(
  projectRoot: string,
): Promise<IsolationStrategy> {
  const worktree = new GitWorktreeIsolation(projectRoot);
  if (await worktree.isAvailable()) return worktree;

  return new SnapshotIsolation(projectRoot);
}

/**
 * 创建隔离管理器（同步版本，不检测环境）。
 * 调用者自行决定使用哪个策略。
 */
export function createIsolationStrategies(projectRoot: string): {
  worktree: GitWorktreeIsolation;
  snapshot: SnapshotIsolation;
} {
  return {
    worktree: new GitWorktreeIsolation(projectRoot),
    snapshot: new SnapshotIsolation(projectRoot),
  };
}
