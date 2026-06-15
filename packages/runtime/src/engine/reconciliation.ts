import type { ComponentState, Session, Checkpoint } from '../index.js';
import * as fs from 'fs/promises';
import * as path from 'path';

/** 物理世界调和结果 */
export interface ReconciliationResult {
  /** 调和是否成功 */
  ok: boolean;
  /** 发现的孤儿 Worktree 列表 */
  orphanWorktrees: string[];
  /** 成功恢复的组件名称 */
  restoredComponents: string[];
  /** 恢复失败的组件名称 */
  failedComponents: string[];
}

/**
 * Resume 阶段 B：物理世界调和 (Reconciliation)。
 *
 * 场景：长任务数小时后从 checkpoint 恢复时，JSON 反序列化只能恢复逻辑状态，
 * 但 LSP 子进程、Git Worktree、沙箱句柄等物理资源可能已失效。
 * 本函数扫描物理工作区 → 清理残留 → 通知所有 LifecycleAware 组件执行 onRestore。
 */
export async function reconcile(
  session: Session,
  components: ComponentState[],
  checkpoint: Checkpoint,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    ok: true,
    orphanWorktrees: [],
    restoredComponents: [],
    failedComponents: [],
  };

  // 步骤 1：扫描残留的 Git Worktree 孤儿目录
  try {
    const worktreesDir = path.join(session.cwd, '.git', 'worktrees');
    const entries = await fs.readdir(worktreesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        result.orphanWorktrees.push(entry.name);
      }
    }
    if (result.orphanWorktrees.length > 0) {
      console.warn(
        `[Reconciliation] 发现 ${result.orphanWorktrees.length} 个孤儿 Worktree: ${result.orphanWorktrees.join(', ')}`,
      );
    }
  } catch {
    // .git/worktrees 目录不存在，无孤儿
  }

  // 步骤 2：通知所有 LifecycleAware 组件执行恢复
  for (const state of components) {
    const comp = state.component;
    try {
      if (comp.onRestore) {
        await comp.onRestore({ checkpoint, session });
      }
      // 需要重启的组件（如 LSPManager、SandboxExecutor）执行就地重置
      if (comp.restart) {
        await comp.restart();
      }
      result.restoredComponents.push(comp.name);
      state.status = 'healthy';
    } catch (err) {
      result.failedComponents.push(comp.name);
      state.status = 'degraded';
      console.warn(`[Reconciliation] 恢复 "${comp.name}" 失败: ${(err as Error).message}`);
    }
  }

  if (result.failedComponents.length > 0) {
    result.ok = false;
  }

  return result;
}
