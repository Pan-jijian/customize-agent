import type { Message } from '@customize-agent/types';
import type { WorkspaceSnapshot } from '@customize-agent/tools';
import type { AgentExecutor } from '../agent/executor.js';
import type { I18nManager } from '../i18n/manager.js';
import { t } from '../tui/renderer.js';

type Turn = { message: Message; index: number };
type SelectList = <T>(title: string, items: Array<{ label: string; detail?: string; value: T }>) => Promise<T | null>;

export interface SessionCommandDeps {
  history: Message[];
  executor: AgentExecutor;
  i18n: I18nManager;
  selectList: SelectList;
  getSessionId: () => string;
  setSessionId: (id: string) => void;
  setDraft: (text: string) => void;
  findSnapshotForTurn: (index: number) => WorkspaceSnapshot | undefined;
  loadSnapshot: (id: string) => Promise<WorkspaceSnapshot | null>;
  restoreSnapshot: (snapshot: WorkspaceSnapshot) => Promise<void>;
}

/**
 * 会话管理命令：回退（rewind）、恢复（resume）、查看历史会话。
 * 支持仅回退对话或同时恢复工作区快照。
 */
export class SessionCommands {
  constructor(private deps: SessionCommandDeps) {}

  async rewind(args: string): Promise<void> {
    const userTurns = this.deps.history
      .map((message, index) => ({ message, index }))
      .filter(turn => turn.message.role === 'user');
    if (!userTurns.length) {
      process.stdout.write(t.dim(this.deps.i18n.t('cmd.no_rewind') + '\n\n'));
      return;
    }
    const selected = args
      ? userTurns[Math.max(0, userTurns.length - Number.parseInt(args, 10))]
      : await this.deps.selectList(this.deps.i18n.t('help.rewind'), userTurns.slice().reverse().map((turn, i) => ({
          label: `${i + 1}. ${turn.message.content.slice(0, 80).replace(/\n/g, ' ')}`,
          detail: `#${turn.index}`,
          value: turn,
        })));
    if (!selected) return;

    const scope = await this.deps.selectList(this.deps.i18n.t('help.rewind'), [
      { label: this.deps.i18n.t('cmd.rewind_scope_chat'), detail: this.deps.i18n.t('cmd.rewind_scope_chat_desc'), value: 'chat' as const },
      { label: this.deps.i18n.t('cmd.rewind_scope_all'), detail: this.deps.i18n.t('cmd.rewind_scope_all_desc'), value: 'all' as const },
    ]);
    if (!scope) return;

    const original = selected.message.content;
    this.deps.history.splice(selected.index);
    if (scope === 'all') await this.restoreSnapshotForTurn(selected);
    this.deps.setDraft(original);
    process.stdout.write(t.success(this.deps.i18n.t('cmd.rewind_done') + '\n\n'));
  }

  async resume(args: string): Promise<void> {
    const { AuditLogger } = await import('@customize-agent/runtime');
    const sessions = await AuditLogger.listSessions();
    if (!sessions.length) {
      process.stdout.write(t.dim(this.deps.i18n.t('cmd.no_sessions') + '\n\n'));
      return;
    }
    const id = args.trim() && args.trim() !== 'last'
      ? args.trim()
      : await this.deps.selectList(this.deps.i18n.t('help.resume'), sessions.slice(0, 20).map(session => ({
          label: session.taskPreview,
          detail: `${session.id} · ${session.date}`,
          value: session.id,
        })));
    if (!id) return;
    const scope = await this.deps.selectList(this.deps.i18n.t('help.resume'), [
      { label: this.deps.i18n.t('cmd.resume_scope_chat'), detail: this.deps.i18n.t('cmd.resume_scope_chat_desc'), value: 'chat' as const },
      { label: this.deps.i18n.t('cmd.resume_scope_all'), detail: this.deps.i18n.t('cmd.resume_scope_all_desc'), value: 'all' as const },
    ]);
    if (!scope) return;
    const loaded = await AuditLogger.loadHistory(id);
    this.deps.history.length = 0;
    this.deps.history.push({ role: 'system', content: this.deps.executor.getSystemPrompt() }, ...loaded.filter(message => message.role !== 'system'));
    this.deps.setSessionId(id);
    if (scope === 'all') await this.restoreSnapshotById(id);
    process.stdout.write(t.success(this.deps.i18n.t('cmd.resume_done', { id }) + '\n\n'));
  }

  async sessions(): Promise<void> {
    try {
      const { AuditLogger } = await import('@customize-agent/runtime');
      const sessions = await AuditLogger.listSessions();
      if (!sessions.length) { process.stdout.write(t.dim(this.deps.i18n.t('cmd.no_sessions') + '\n\n')); return; }
      process.stdout.write(t.dim(`${this.deps.i18n.t('cmd.sessions_total')} ${sessions.length}\n`));
      for (const session of sessions.slice(0, 20)) {
        process.stdout.write(`  ${t.text(session.id)}\n    ${t.dim(this.deps.i18n.t('session.date_label') + ':')} ${session.date}  ${t.dim(this.deps.i18n.t('session.events_label') + ':')} ${session.eventCount}\n    ${t.dim(this.deps.i18n.t('session.task_label') + ':')} ${session.taskPreview}\n\n`);
      }
    } catch (err) {
      process.stdout.write(t.error(`Error: ${(err as Error).message}\n\n`));
    }
  }

  private async restoreSnapshotForTurn(turn: Turn): Promise<void> {
    const snapshot = this.deps.findSnapshotForTurn(turn.index) ?? await this.deps.loadSnapshot(this.deps.getSessionId());
    await this.restoreSnapshot(snapshot);
  }

  private async restoreSnapshotById(id: string): Promise<void> {
    const snapshot = await this.deps.loadSnapshot(id);
    await this.restoreSnapshot(snapshot);
  }

  private async restoreSnapshot(snapshot: WorkspaceSnapshot | null | undefined): Promise<void> {
    if (snapshot) {
      try {
        await this.deps.restoreSnapshot(snapshot);
      } catch {
        process.stdout.write(t.warning(this.deps.i18n.t('cmd.rewind_snapshot_failed') + '\n'));
      }
    } else {
      process.stdout.write(t.warning(this.deps.i18n.t('cmd.rewind_snapshot_missing') + '\n'));
    }
  }
}
