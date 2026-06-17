import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { Message } from '@code-agent/types';

// 审计事件类型

export type AuditEventType =
  | 'session_metadata'
  | 'task_start'
  | 'llm_request'
  | 'llm_response'
  | 'tool_call'
  | 'tool_result'
  | 'permission_check'
  | 'error'
  | 'route_decision'
  | 'task_finish';

/** 单条审计事件 */
export interface AuditEvent {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 事件类型 */
  event: AuditEventType;
  /** 会话 ID */
  sessionId: string;
  /** 事件负载（各事件类型字段不同） */
  payload: Record<string, unknown>;
}

/** 会话元数据 */
export interface SessionMetadata {
  sessionId: string;
  startTime: string;
  cwd: string;
  task: string;
  provider: string;
  model: string;
}

/** 会话历史条目（用于 --list-sessions） */
export interface SessionEntry {
  id: string;
  date: string;
  taskPreview: string;
  eventCount: number;
}

/**
 * 审计日志器 — JSONL 格式，一行一个 JSON 事件。
 * 支持从日志重建完整对话历史（用于会话恢复）。
 */
export class AuditLogger {
  private logDir: string;
  private logFile: string;
  private sessionId: string;
  private events: AuditEvent[] = [];  // 内存缓冲，定期刷盘

  constructor(sessionId: string, logDir?: string) {
    this.sessionId = sessionId;
    this.logDir = logDir ?? path.join(os.homedir(), '.code-agent', 'logs');
    this.logFile = path.join(this.logDir, `${sessionId}.jsonl`);
  }

  /** 初始化日志目录 */
  async init(): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true });
  }

  /** 记录一条事件（追加到内存 + 异步写盘） */
  async log(event: AuditEventType, payload: Record<string, unknown> = {}): Promise<void> {
    const entry: AuditEvent = {
      timestamp: new Date().toISOString(),
      event,
      sessionId: this.sessionId,
      payload,
    };
    this.events.push(entry);

    // 写入 JSONL（一行一个 JSON）
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(this.logFile, line, 'utf-8').catch(() => {
      // 静默失败，不中断 Agent 主流程
    });
  }

  /** 获取全部事件 */
  getEvents(): ReadonlyArray<AuditEvent> {
    return this.events;
  }

  /** 获取事件数量 */
  get eventCount(): number {
    return this.events.length;
  }

  // 便捷方法 — 每种事件类型一个方法

  /** 记录会话元数据 */
  async logSessionMetadata(meta: SessionMetadata): Promise<void> {
    await this.log('session_metadata', meta as unknown as Record<string, unknown>);
  }

  /** 记录任务开始 */
  async logTaskStart(task: string): Promise<void> {
    await this.log('task_start', { task });
  }

  /** 记录 LLM 请求 */
  async logLLMRequest(messages: Message[]): Promise<void> {
    await this.log('llm_request', { messageCount: messages.length, lastUserMessage: messages[messages.length - 1]?.content?.slice(0, 200) });
  }

  /** 记录 LLM 响应 */
  async logLLMResponse(content: string, tokensUsed?: { prompt: number; completion: number }): Promise<void> {
    await this.log('llm_response', {
      contentPreview: content.slice(0, 500),
      ...tokensUsed,
    });
  }

  /** 记录工具调用 */
  async logToolCall(toolName: string, args: Record<string, unknown>): Promise<void> {
    await this.log('tool_call', { toolName, args });
  }

  /** 记录工具执行结果 */
  async logToolResult(toolName: string, result: string, durationMs: number): Promise<void> {
    await this.log('tool_result', { toolName, resultPreview: result.slice(0, 500), durationMs });
  }

  /** 记录权限检查 */
  async logPermissionCheck(toolName: string, permission: string, reason?: string): Promise<void> {
    await this.log('permission_check', { toolName, permission, reason });
  }

  /** 记录错误 */
  async logError(error: Error, context?: string): Promise<void> {
    await this.log('error', { message: error.message, stack: error.stack?.slice(0, 1000), context });
  }

  /** 记录路由决策 */
  async logRouteDecision(from: string, to: string, reason: string): Promise<void> {
    await this.log('route_decision', { from, to, reason });
  }

  /** 记录任务完成 */
  async logTaskFinish(summary: string, costUsd?: number, rounds?: number): Promise<void> {
    await this.log('task_finish', { summary, costUsd, rounds });
  }

  // 静态方法 — 会话恢复与列表

  /**
   * 从 JSONL 日志重建对话历史（用于 --resume）。
   * 提取所有 user/assistant 消息对，按时间排序。
   */
  static async loadHistory(sessionId: string, logDir?: string): Promise<Message[]> {
    const dir = logDir ?? path.join(os.homedir(), '.code-agent', 'logs');
    const logFile = path.join(dir, `${sessionId}.jsonl`);

    try {
      const content = await fs.readFile(logFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const messages: Message[] = [];

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as AuditEvent;
          // 重建消息：从 llm_request 提取 user 消息，从 llm_response 提取 assistant 消息
          if (event.event === 'llm_request') {
            const lastMsg = event.payload.lastUserMessage as string | undefined;
            if (lastMsg) {
              messages.push({ role: 'user', content: lastMsg });
            }
          } else if (event.event === 'llm_response') {
            const preview = event.payload.contentPreview as string | undefined;
            if (preview) {
              messages.push({ role: 'assistant', content: preview });
            }
          }
        } catch {
          // 跳过损坏行
        }
      }

      return messages;
    } catch {
      return [];
    }
  }

  /**
   * 列出所有历史会话。
   * 返回会话 ID、日期、任务概述、事件数。
   */
  static async listSessions(logDir?: string): Promise<SessionEntry[]> {
    const dir = logDir ?? path.join(os.homedir(), '.code-agent', 'logs');

    try {
      const files = await fs.readdir(dir);
      const jsonlFiles = files.filter((f: string) => f.endsWith('.jsonl'));
      const sessions: SessionEntry[] = [];

      for (const file of jsonlFiles) {
        const id = file.replace('.jsonl', '');
        const fullPath = path.join(dir, file);
        const stat = await fs.stat(fullPath);
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);

        // 从首条 session_metadata 提取任务信息
        let taskPreview = '未知任务';
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as AuditEvent;
            if (event.event === 'task_start') {
              taskPreview = String(event.payload.task ?? '未知任务').slice(0, 100);
              break;
            }
            if (event.event === 'session_metadata') {
              taskPreview = String(event.payload.task ?? '未知任务').slice(0, 100);
            }
          } catch { continue; }
        }

        sessions.push({
          id,
          date: stat.mtime.toISOString(),
          taskPreview,
          eventCount: lines.length,
        });
      }

      return sessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    } catch {
      return [];
    }
  }
}
