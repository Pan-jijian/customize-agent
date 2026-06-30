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
