// @deprecated — 会话类型当前未被任何消费者使用，保留供未来会话管理使用
// @customize-agent/types — 会话类型

import type { Message } from './message.js';

export interface SessionConfig { id: string; cwd: string; task?: string; metadata?: Record<string, unknown>; }

export type SessionStatus = 'active' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export interface Session {
  readonly id: string; readonly cwd: string; readonly createdAt: number;
  task?: string; status: SessionStatus; metadata: Record<string, unknown>; history: Message[];
}

export function createSession(config: SessionConfig): Session {
  return { id: config.id, cwd: config.cwd, createdAt: Date.now(), task: config.task, status: 'active', metadata: config.metadata ?? {}, history: [] };
}
