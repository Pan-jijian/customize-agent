// @customize-agent/types — 跨包类型契约层
// 零外部依赖，任何包都可以安全导入

// ---- Message & LLM 响应 ----

/** 消息体 — Agent 与 LLM 之间的对话单元 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 原生 function calling: assistant 消息中返回的工具调用列表 */
  toolCalls?: ToolCall[];
  /** 原生 function calling: tool 消息中的 tool_call_id */
  toolCallId?: string;
}

/**
 * LLM 返回体 — 单次模型调用的完整响应。
 *
 * 设计原则 (ADR-20 厂商无关抽象):
 *   - 所有字段为所有厂商能力的超集
 *   - 厂商不支持某字段时填入 undefined（不删除字段）
 *   - vendorExtensions 收容厂商特有数据，避免核心类型随厂商变更而修改
 */
export interface LLMResponse {
  content: string;
  thinkingContent?: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
  /** 厂商特有扩展字段（如 x-openai-*, x-anthropic-* 前缀命名空间） */
  vendorExtensions?: Record<string, unknown>;
}

/**
 * 单次工具调用 — LLM function calling / tool_use 的抽象表示。
 * 对齐 MCP CallToolResult 语义，是各厂商原生格式的超集。
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** 厂商特有扩展（如 Anthropic 的 tool_use 原始 content_block） */
  vendorExtensions?: Record<string, unknown>;
}

/** 流式输出的切块类型 — Provider 无关的流式事件 */
export type StreamChunk =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'error'; message: string }
  | { type: 'reset' }
  | { type: 'done' };

/**
 * Function calling 工具定义（Provider 无关的抽象格式）。
 * 基于 JSON Schema 子集，所有厂商均可表达。
 */
export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** 厂商特有扩展 */
  vendorExtensions?: Record<string, unknown>;
}

// ---- 组件生命周期 (ADR-16) ----

/** 统一组件生命周期接口 */
export interface LifecycleAware {
  readonly name: string;
  readonly dependencies?: string[];
  init?(): Promise<void>;
  healthCheck?(): Promise<boolean>;
  shutdown?(): Promise<void>;
  restart?(): Promise<void>;
  reload?(config: Record<string, unknown>): Promise<void>;
  onDependencyFailure?(failedComponent: string): Promise<void>;
  onRestore?(snapshot: unknown): Promise<void>;
}

export type ComponentStatus = 'uninitialized' | 'initializing' | 'healthy' | 'degraded' | 'failed' | 'shutdown';

export interface ComponentState {
  component: LifecycleAware;
  status: ComponentStatus;
  failureCount: number;
  startedAt?: number;
}

// ---- 会话 ----

export interface SessionConfig { id: string; cwd: string; task?: string; metadata?: Record<string, unknown>; }

export type SessionStatus = 'active' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export interface Session {
  readonly id: string; readonly cwd: string; readonly createdAt: number;
  task?: string; status: SessionStatus; metadata: Record<string, unknown>; history: Message[];
}

export function createSession(config: SessionConfig): Session {
  return { id: config.id, cwd: config.cwd, createdAt: Date.now(), task: config.task, status: 'active', metadata: config.metadata ?? {}, history: [] };
}

// ---- 任务状态 ----

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

// ---- Checkpoint & 运行时配置 ----

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

/** 已知二进制文件扩展名（read_file 不可读取） */
export const BINARY_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'svg',
  'woff', 'woff2', 'ttf', 'eot',
  'db', 'db-shm', 'db-wal', 'lock', 'log', 'map',
  'min.js', 'min.css',
  'docx', 'xlsx', 'pptx',
  'zip', 'tar', 'gz', 'bz2', '7z',
  'mp3', 'mp4', 'avi', 'mov', 'webm', 'webp',
  'wasm',
]);

// 事件接口（SystemEvents/DomainEvents/TelemetryEvents）及生命周期工具函数
// 权威实现已迁移至 @customize-agent/runtime 包
