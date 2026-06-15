// ============================================================
// @code-agent/types — 跨包类型契约层
// 零外部依赖，任何包都可以安全导入
// ============================================================

// ---- Message & LLM Response ----

/** 消息体 — Agent 与 LLM 之间的对话单元 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 原生 function calling: assistant 消息中返回的工具调用列表 */
  toolCalls?: ToolCall[];
  /** 原生 function calling: tool 消息中的 tool_call_id */
  toolCallId?: string;
}

/** LLM 返回体 — 单次模型调用的完整响应 */
export interface LLMResponse {
  content: string;
  thinkingContent?: string;
  toolCalls?: ToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

/** 单次工具调用 — LLM function calling / tool_use 的抽象表示 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 流式输出的切块类型 — Provider 无关的流式事件 */
export type StreamChunk =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'error'; message: string }
  | { type: 'reset' }
  | { type: 'done' };

/** Function calling 工具定义（Provider 无关的抽象格式） */
export interface FunctionDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

// ---- Diff ----

/** SEARCH/REPLACE 补丁块 */
export interface DiffBlock {
  search: string;
  replace: string;
}

// ---- Lifecycle (ADR-16) ----

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

// ---- Session ----

export interface SessionConfig { id: string; cwd: string; task?: string; metadata?: Record<string, unknown>; }

export type SessionStatus = 'active' | 'suspended' | 'completed' | 'failed' | 'cancelled';

export interface Session {
  readonly id: string; readonly cwd: string; readonly createdAt: number;
  task?: string; status: SessionStatus; metadata: Record<string, unknown>; history: Message[];
}

export function createSession(config: SessionConfig): Session {
  return { id: config.id, cwd: config.cwd, createdAt: Date.now(), task: config.task, status: 'active', metadata: config.metadata ?? {}, history: [] };
}

// ---- Task State ----

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

// ---- Events ----

export interface SystemEvents {
  'runtime:ready': Record<string, never>;
  'runtime:shutdown': { reason: string };
  'component:degraded': { component: string; reason: string };
  'component:recovered': { component: string };
  'session:started': { sessionId: string };
  'session:ended': { sessionId: string; reason: string };
}

export interface DomainEvents {
  'task:started': { task: string };
  'task:completed': { result: unknown };
  'task:failed': { error: Error };
  'task:cancelled': { reason: string };
  'state:changed': { from: TaskState; to: TaskState };
  'loop:iteration': { round: number; cost: number };
  'tool:beforeExecute': { toolName: string; args: Record<string, unknown> };
  'tool:afterExecute': { toolName: string; result: string; durationMs: number };
  'permission:requested': { toolName: string; args: Record<string, unknown> };
  'permission:granted': { toolName: string };
  'permission:denied': { toolName: string; reason: string };
  'provider:switched': { from: string; to: string; reason: string };
}

export interface TelemetryEvents {
  'budget:warning': { used: number; limit: number };
  'budget:exceeded': { used: number; limit: number };
  'checkpoint:reached': { round: number; cost: number };
  'error:recoverable': { error: Error; attempt: number };
  'error:fatal': { error: Error };
  'metric:counter': { name: string; value: number; tags?: Record<string, string> };
  'metric:histogram': { name: string; value: number; tags?: Record<string, string> };
}

export type AgentEvents = SystemEvents & DomainEvents & TelemetryEvents;

// ---- Checkpoint & Runtime Config ----

export interface Checkpoint {
  sessionId: string; taskState: TaskState; round: number;
  costUsd: number; timestamp: number; history: Message[]; metadata: Record<string, unknown>;
}

export interface RuntimeConfig {
  cwd: string; sessionId?: string; maxBudgetUsd?: number; checkpointInterval?: number;
}

export interface TaskResult {
  success: boolean; summary: string; rounds: number; costUsd: number; durationMs: number;
}

// ---- Lifecycle utilities ----

/** 拓扑排序：按 dependencies 构建 DAG，确定初始化顺序 */
export function topologicalSort(components: LifecycleAware[]): LifecycleAware[] {
  const nameSet = new Set(components.map(c => c.name));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const c of components) { inDegree.set(c.name, 0); adjacency.set(c.name, []); }
  for (const c of components) {
    for (const dep of c.dependencies ?? []) {
      if (!nameSet.has(dep)) throw new Error(`[Lifecycle] Component "${c.name}" depends on unknown component "${dep}"`);
      adjacency.get(dep)!.push(c.name);
      inDegree.set(c.name, (inDegree.get(c.name) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [name, degree] of inDegree) { if (degree === 0) queue.push(name); }
  const sorted: LifecycleAware[] = [];
  const nameToComponent = new Map(components.map(c => [c.name, c]));
  while (queue.length > 0) {
    const name = queue.shift()!;
    const comp = nameToComponent.get(name);
    if (comp) sorted.push(comp);
    for (const neighbor of adjacency.get(name) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }
  if (sorted.length !== components.length) throw new Error('[Lifecycle] Circular dependency detected');
  return sorted;
}

/** 按初始化顺序依次 init 所有组件。任一失败则逆序 shutdown 已初始化组件。 */
export async function initializeComponents(sorted: LifecycleAware[]): Promise<ComponentState[]> {
  const states: ComponentState[] = [];
  const initialized: ComponentState[] = [];
  for (const comp of sorted) {
    const state: ComponentState = { component: comp, status: 'initializing', failureCount: 0, startedAt: Date.now() };
    states.push(state);
    try {
      if (comp.init) await comp.init();
      state.status = 'healthy';
      initialized.push(state);
    } catch (err) {
      state.status = 'failed';
      for (const s of initialized.reverse()) {
        try { if (s.component.shutdown) await s.component.shutdown(); } catch { /* best-effort */ }
        s.status = 'shutdown';
      }
      throw new Error(`[Lifecycle] Failed to initialize "${comp.name}": ${(err as Error).message}`, { cause: err });
    }
  }
  return states;
}

/** 按初始化逆序 shutdown 所有组件。单个超时 5s。 */
export async function shutdownComponents(states: ComponentState[]): Promise<void> {
  const reversed = [...states].reverse();
  for (const state of reversed) {
    if (state.status === 'shutdown') continue;
    try {
      await Promise.race([
        state.component.shutdown?.(),
        new Promise<void>(resolve => setTimeout(resolve, 5000)),
      ]);
    } catch (err) {
      console.warn(`[Lifecycle] Shutdown error for "${state.component.name}": ${(err as Error).message}`);
    }
    state.status = 'shutdown';
  }
}
