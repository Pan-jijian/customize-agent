import { execa } from 'execa';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

/** Worktree 上下文 */
export interface WorktreeContext {
  /** Worktree 目录路径 */
  path: string;
  /** 临时分支名 */
  branch: string;
  /** 子智能体 ID */
  subagentId: string;
}

/**
 * 安全 Worktree 管理器 (ADR-9)。
 *
 * AsyncMutex 仅覆盖 Worktree 的创建/销毁生命周期管理方法——
 * 保护主仓库全局 refs 不被并发写乱。
 * 子智能体在各 Worktree 内部的 git add/commit 无需加锁，天然并行。
 */
export class SafeWorktreeManager {
  private projectRoot: string;
  private tempDir: string;
  private locked = false;
  private pendingLocks: Array<() => void> = [];

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.tempDir = path.join(os.tmpdir(), 'customize-agent-worktrees');
  }

  /** 获取互斥锁（简单 FIFO 队列实现） */
  private async _acquireLock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>(resolve => {
      this.pendingLocks.push(resolve);
    });
  }

  /** 释放互斥锁 */
  private _releaseLock(): void {
    const next = this.pendingLocks.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  /**
   * 创建隔离 Worktree。
   * 加锁保护（操作 Git 全局 refs）。
   */
  async createWorktree(subagentId: string): Promise<WorktreeContext> {
    await this._acquireLock();
    try {
      const safeId = subagentId.replace(/[^a-zA-Z0-9._-]/g, '-');
      const branch = `agent/${safeId}-${Date.now()}`;
      const worktreePath = path.join(this.tempDir, safeId, String(Date.now()));

      await fs.mkdir(this.tempDir, { recursive: true });

      const insideWorktree = await execa({ cwd: this.projectRoot, reject: false })`git rev-parse --is-inside-work-tree`;
      if (insideWorktree.exitCode !== 0 || insideWorktree.stdout.trim() !== 'true') {
        throw new Error('SafeWorktreeManager requires a Git worktree');
      }

      // 基于当前 HEAD 创建临时分支和隔离 worktree
      await execa({ cwd: this.projectRoot })`git branch ${branch}`;
      await execa({ cwd: this.projectRoot })`git worktree add ${worktreePath} ${branch}`;

      return { path: worktreePath, branch, subagentId };
    } finally {
      this._releaseLock();
    }
  }

  /**
   * 销毁 Worktree 并清理临时分支。
   * 加锁保护（操作 Git 全局 refs）。
   * @param success 子智能体是否执行成功（失败时也可选择保留 worktree 以便排查）
   */
  async destroyWorktree(context: WorktreeContext, success: boolean): Promise<void> {
    await this._acquireLock();
    try {
      // 删除 Worktree
      await execa({ cwd: this.projectRoot, reject: false })`git worktree remove ${context.path} --force`;

      // 删除临时分支
      if (success) {
        await execa({ cwd: this.projectRoot, reject: false })`git branch -D ${context.branch}`;
      }
      // 失败时保留分支，方便人工排查

      // 清理临时目录（如果为空）
      await fs.rmdir(this.tempDir).catch(() => {});
    } finally {
      this._releaseLock();
    }
  }

  /**
   * 安全合并：将 Worktree 分支合并回主分支。
   * 若出现冲突 → 返回冲突文件列表，由 ConflictResolver 处理。
   */
  async safeMerge(context: WorktreeContext): Promise<{ success: boolean; conflicts: string[] }> {
    await this._acquireLock();
    try {
      const status = await execa({ cwd: context.path, reject: false })`git status --porcelain`;
      if (status.stdout.trim()) {
        await execa({ cwd: context.path, reject: false })`git add -A`;
        const commit = await execa({ cwd: context.path, reject: false })`git commit -m ${`agent: ${context.subagentId}`}`;
        if (commit.exitCode !== 0) {
          throw new Error(commit.stderr || commit.stdout || 'git commit failed in worktree');
        }
      }

      // 合并临时分支到当前分支
      const result = await execa({
        cwd: this.projectRoot,
        reject: false,
      })`git merge --no-ff ${context.branch}`;

      if (result.exitCode === 0) {
        return { success: true, conflicts: [] };
      }

      // Git merge 冲突 → 解析冲突文件列表
      const conflicts: string[] = [];
      const conflictResult = await execa({
        cwd: this.projectRoot,
        reject: false,
      })`git diff --name-only --diff-filter=U`;

      for (const line of conflictResult.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) conflicts.push(trimmed);
      }

      return { success: false, conflicts };
    } finally {
      this._releaseLock();
    }
  }

  /** 中止合并（冲突无法自动解决时） */
  async abortMerge(): Promise<void> {
    await this._acquireLock();
    try {
      await execa({ cwd: this.projectRoot, reject: false })`git merge --abort`;
    } finally {
      this._releaseLock();
    }
  }

  /** 列出所有残留的 Worktree */
  async listOrphanWorktrees(): Promise<string[]> {
    try {
      const result = await execa({ cwd: this.projectRoot, reject: false })`git worktree list --porcelain`;
      const lines = result.stdout.split('\n');
      const orphans: string[] = [];
      for (const line of lines) {
        if (line.startsWith('worktree ') && line.includes(this.tempDir)) {
          orphans.push(line.slice('worktree '.length));
        }
      }
      return orphans;
    } catch {
      return [];
    }
  }

  /** 清理所有孤儿 Worktree */
  async cleanupOrphans(): Promise<void> {
    const orphans = await this.listOrphanWorktrees();
    for (const worktreePath of orphans) {
      try {
        await execa({ cwd: this.projectRoot, reject: false })`git worktree remove ${worktreePath} --force`;
      } catch {
        // 删除失败则跳过
      }
    }
  }
}
