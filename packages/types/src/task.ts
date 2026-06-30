// @customize-agent/types — 任务状态 & Checkpoint 类型

import type { Message } from './message.js';

export enum TaskState {
  IDLE = 'IDLE', PLANNING = 'PLANNING', WAIT_APPROVAL = 'WAIT_APPROVAL',
  EXECUTING = 'EXECUTING', TESTING = 'TESTING', REVIEWING = 'REVIEWING',
  FINISHED = 'FINISHED', FAILED = 'FAILED', CANCELLED = 'CANCELLED',
  WAIT_SUBTASK = 'WAIT_SUBTASK', MERGING = 'MERGING',
  CONFLICT_RESOLVING = 'CONFLICT_RESOLVING', PAUSED = 'PAUSED', RECOVERING = 'RECOVERING',
}

export type TaskStateEvent =
  | 'start_planning' | 'plan_complete' | 'user_approved' | 'user_rejected'
  | 'execution_start' | 'execution_complete' | 'testing_start' | 'testing_complete'
  | 'review_start' | 'review_complete' | 'task_finish' | 'error' | 'cancel'
  | 'suspend' | 'resume' | 'subtask_dispatch' | 'subtask_complete'
  | 'merge_start' | 'merge_conflict' | 'merge_complete';

export interface Checkpoint {
  sessionId: string; taskState: TaskState; round: number; costUsd: number;
  timestamp: number; history: Message[]; metadata: Record<string, unknown>;
}

export interface RuntimeConfig {
  cwd: string; sessionId?: string; maxBudgetUsd?: number; checkpointInterval?: number;
}

export interface TaskResult {
  success: boolean; summary: string; rounds: number; costUsd: number; durationMs: number;
}
