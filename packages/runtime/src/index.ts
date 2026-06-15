import type { Message } from '@code-agent/types';

// ============================================================
// LifecycleAware — 统一组件生命周期接口 (ADR-16)
// 所有需要 init/shutdown 的组件必须实现此接口。
// restart() 严禁更换类实例指针（就地重置契约），防止 Stale Reference。
// ============================================================

export interface LifecycleAware {
  readonly name: string;
  readonly dependencies?: string[];

  init?(): Promise<void>;
  healthCheck?(): Promise<boolean>;
  shutdown?(): Promise<void>;

  /** 自恢复：shutdown → init，但严禁更换类实例指针 (ADR-16) */
  restart?(): Promise<void>;
  /** 运行时热更新配置 */
  reload?(config: Record<string, unknown>): Promise<void>;
  /** 依赖组件故障回调，通知本组件进入降级模式 */
  onDependencyFailure?(failedComponent: string): Promise<void>;
  /** Resume 时恢复内部状态 */
  onRestore?(snapshot: unknown): Promise<void>;
}

/** 组件运行状态 */
export type ComponentStatus = 'uninitialized' | 'initializing' | 'healthy' | 'degraded' | 'failed' | 'shutdown';

/** 组件状态追踪信息 */
export interface ComponentState {
  /** 组件实例 */
  component: LifecycleAware;
  /** 当前状态 */
  status: ComponentStatus;
  /** 连续失败次数（自愈用） */
  failureCount: number;
  /** 启动时间戳 */
  startedAt?: number;
}

/**
 * 拓扑排序：按 dependencies 构建 DAG，确定初始化顺序。
 * 依赖项先于被依赖项初始化。
 */
export function topologicalSort(components: LifecycleAware[]): LifecycleAware[] {
  const nameSet = new Set(components.map(c => c.name));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const c of components) {
    inDegree.set(c.name, 0);
    adjacency.set(c.name, []);
  }

  for (const c of components) {
    for (const dep of c.dependencies ?? []) {
      if (!nameSet.has(dep)) {
        throw new Error(`[Lifecycle] Component "${c.name}" depends on unknown component "${dep}"`);
      }
      adjacency.get(dep)!.push(c.name);
      inDegree.set(c.name, (inDegree.get(c.name) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) queue.push(name);
  }

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

  if (sorted.length !== components.length) {
    throw new Error('[Lifecycle] Circular dependency detected in component dependencies');
  }

  return sorted;
}

/**
 * 按初始化顺序依次 init 所有组件。任一失败则逆序 shutdown 已初始化组件。
 */
export async function initializeComponents(
  sorted: LifecycleAware[],
): Promise<ComponentState[]> {
  const states: ComponentState[] = [];
  const initialized: ComponentState[] = [];

  for (const comp of sorted) {
    const state: ComponentState = { component: comp, status: 'initializing' as ComponentStatus, failureCount: 0, startedAt: Date.now() };
    states.push(state);

    try {
      if (comp.init) await comp.init();
      state.status = 'healthy';
      initialized.push(state);
    } catch (err) {
      state.status = 'failed';
      // 逆序 shutdown 已初始化的组件
      for (const s of initialized.reverse()) {
        try {
          if (s.component.shutdown) await s.component.shutdown();
        } catch { /* best-effort */ }
        s.status = 'shutdown';
      }
      throw new Error(
        `[Lifecycle] Failed to initialize "${comp.name}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  return states;
}

/**
 * 按初始化逆序 shutdown 所有组件。单个超时 5s。
 */
export async function shutdownComponents(states: ComponentState[]): Promise<void> {
  const reversed = [...states].reverse();
  for (const state of reversed) {
    if (state.status === 'shutdown') continue;
    try {
      const result = await Promise.race([
        state.component.shutdown?.(),
        new Promise<void>(resolve => setTimeout(resolve, 5000)),
      ]);
      if (result === undefined) {
        console.warn(`[Lifecycle] Shutdown timeout for "${state.component.name}"`);
      }
    } catch (err) {
      console.warn(`[Lifecycle] Shutdown error for "${state.component.name}": ${(err as Error).message}`);
    }
    state.status = 'shutdown';
  }
}

// ============================================================
// Session
// ============================================================

/** 会话创建配置 */
export interface SessionConfig {
  /** 唯一会话 ID */
  id: string;
  /** 项目工作目录 */
  cwd: string;
  /** 任务描述 */
  task?: string;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

/** 会话实体 — 整个任务生命周期的核心数据 */
export interface Session {
  /** 唯一会话 ID */
  readonly id: string;
  /** 项目工作目录 */
  readonly cwd: string;
  /** 创建时间戳 */
  readonly createdAt: number;
  /** 当前任务 */
  task?: string;
  /** 会话状态 */
  status: SessionStatus;
  /** 附加元数据 */
  metadata: Record<string, unknown>;
  /** 对话历史 */
  history: Message[];
}

/** 会话状态枚举 */
export type SessionStatus = 'active' | 'suspended' | 'completed' | 'failed' | 'cancelled';

/** 创建新的会话实例 */
export function createSession(config: SessionConfig): Session {
  return {
    id: config.id,
    cwd: config.cwd,
    createdAt: Date.now(),
    task: config.task,
    status: 'active',
    metadata: config.metadata ?? {},
    history: [],
  };
}

// ============================================================
// TaskState — 状态机 (ADR-19)
// ============================================================

export enum TaskState {
  IDLE = 'IDLE',
  PLANNING = 'PLANNING',
  WAIT_APPROVAL = 'WAIT_APPROVAL',
  EXECUTING = 'EXECUTING',
  TESTING = 'TESTING',
  REVIEWING = 'REVIEWING',
  FINISHED = 'FINISHED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  // 子智能体/Worktree 扩展状态
  WAIT_SUBTASK = 'WAIT_SUBTASK',
  MERGING = 'MERGING',
  CONFLICT_RESOLVING = 'CONFLICT_RESOLVING',
  PAUSED = 'PAUSED',
  RECOVERING = 'RECOVERING',
}

/** 状态迁移事件 — 触发状态机流转 */
export type TaskStateEvent =
  | 'start_planning'
  | 'plan_complete'
  | 'user_approved'
  | 'user_rejected'
  | 'execution_start'
  | 'execution_complete'
  | 'testing_start'
  | 'testing_complete'
  | 'review_start'
  | 'review_complete'
  | 'task_finish'
  | 'error'
  | 'cancel'
  | 'suspend'
  | 'resume'
  | 'subtask_dispatch'
  | 'subtask_complete'
  | 'merge_start'
  | 'merge_conflict'
  | 'merge_complete';

type TransitionMap = Partial<Record<TaskState, Partial<Record<TaskStateEvent, TaskState>>>>;

const transitions: TransitionMap = {
  [TaskState.IDLE]: {
    start_planning: TaskState.PLANNING,
    execution_start: TaskState.EXECUTING,
  },
  [TaskState.PLANNING]: {
    plan_complete: TaskState.WAIT_APPROVAL,
    error: TaskState.FAILED,
    cancel: TaskState.CANCELLED,
  },
  [TaskState.WAIT_APPROVAL]: {
    user_approved: TaskState.EXECUTING,
    user_rejected: TaskState.IDLE,
    cancel: TaskState.CANCELLED,
  },
  [TaskState.EXECUTING]: {
    execution_complete: TaskState.TESTING,
    subtask_dispatch: TaskState.WAIT_SUBTASK,
    error: TaskState.FAILED,
    cancel: TaskState.CANCELLED,
    suspend: TaskState.PAUSED,
  },
  [TaskState.TESTING]: {
    testing_complete: TaskState.REVIEWING,
    error: TaskState.FAILED,
    cancel: TaskState.CANCELLED,
  },
  [TaskState.REVIEWING]: {
    review_complete: TaskState.FINISHED,
    error: TaskState.FAILED,
    cancel: TaskState.CANCELLED,
  },
  [TaskState.WAIT_SUBTASK]: {
    subtask_complete: TaskState.EXECUTING,
    merge_start: TaskState.MERGING,
    error: TaskState.FAILED,
    cancel: TaskState.CANCELLED,
  },
  [TaskState.MERGING]: {
    merge_conflict: TaskState.CONFLICT_RESOLVING,
    merge_complete: TaskState.EXECUTING,
    error: TaskState.FAILED,
    cancel: TaskState.CANCELLED,
  },
  [TaskState.CONFLICT_RESOLVING]: {
    merge_complete: TaskState.EXECUTING,
    error: TaskState.FAILED,
    cancel: TaskState.CANCELLED,
  },
  [TaskState.PAUSED]: {
    resume: TaskState.EXECUTING,
    cancel: TaskState.CANCELLED,
  },
  [TaskState.RECOVERING]: {
    execution_start: TaskState.EXECUTING,
    error: TaskState.FAILED,
    cancel: TaskState.CANCELLED,
  },
};

/**
 * 任务状态机 — 管理 Agent 任务生命周期的状态流转。
 * 支持主流程 + 子智能体/Worktree 扩展状态。非法迁移直接抛异常。
 */
export class StateMachine {
  private _state: TaskState = TaskState.IDLE;
  private listeners: Array<(from: TaskState, to: TaskState) => void> = [];

  /** 获取当前状态 */
  get state(): TaskState {
    return this._state;
  }

  /** 执行状态迁移，非法迁移会抛异常 */
  transition(event: TaskStateEvent): TaskState {
    const from = this._state;
    const nextMap = transitions[from];
    if (!nextMap) {
      throw new Error(`[StateMachine] No transitions defined from state "${from}"`);
    }
    const next = nextMap[event];
    if (!next) {
      throw new Error(`[StateMachine] Invalid transition "${event}" from state "${from}"`);
    }
    this._state = next;
    for (const listener of this.listeners) {
      try { listener(from, next); } catch { /* fire-and-forget */ }
    }
    return next;
  }

  /** 强制设置状态（用于恢复 checkpoint 等场景，跳过迁移校验） */
  forceState(state: TaskState): void {
    this._state = state;
  }

  /** 注册状态变更监听器，返回取消注册函数 */
  onChange(listener: (from: TaskState, to: TaskState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }
}

// ============================================================
// EventBus — 类型安全的三层分层事件总线
// ============================================================

// L0 — 系统事件
export interface SystemEvents {
  'runtime:ready': Record<string, never>;
  'runtime:shutdown': { reason: string };
  'component:degraded': { component: string; reason: string };
  'component:recovered': { component: string };
  'session:started': { sessionId: string };
  'session:ended': { sessionId: string; reason: string };
}

// L1 — 领域事件
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

// L2 — 遥测事件
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

type Listener<T> = (data: T) => void;

/**
 * 类型安全的事件总线 — 三层分层 (L0 系统 / L1 领域 / L2 遥测)。
 * 解耦 Logger、Metrics、Web UI、Progress Bar 等消费者。
 */
export class EventBus {
  private listeners = new Map<string, Set<Listener<unknown>>>();

  /** 注册事件监听器，返回取消注册函数 */
  on<K extends keyof AgentEvents>(event: K, listener: Listener<AgentEvents[K]>): () => void {
    const key = event as string;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(listener as Listener<unknown>);
    return () => {
      this.listeners.get(key)?.delete(listener as Listener<unknown>);
    };
  }

  /** 注册一次性事件监听器（触发后自动取消） */
  once<K extends keyof AgentEvents>(event: K, listener: Listener<AgentEvents[K]>): void {
    const off = this.on(event, data => {
      off();
      listener(data);
    });
  }

  /** 发送事件，所有注册的监听器同步执行 */
  emit<K extends keyof AgentEvents>(event: K, data: AgentEvents[K]): void {
    const listeners = this.listeners.get(event as string);
    if (!listeners) return;
    for (const listener of listeners) {
      try { listener(data); } catch (err) { console.warn(`[EventBus] Listener error for "${event as string}":`, err); }
    }
  }

  /** 移除所有监听器 */
  removeAll(): void {
    this.listeners.clear();
  }
}

// ============================================================
// CancellationToken
// ============================================================

/**
 * 取消令牌 — 支持取消传播，长时间操作可检查 isCancelled 提前退出。
 * cancel() 触发后所有 onCancel 回调立即执行。
 */
export class CancellationToken {
  private _cancelled = false;
  private _reason = '';
  private listeners: Array<(reason: string) => void> = [];

  /** 是否已取消 */
  get cancelled(): boolean { return this._cancelled; }
  /** 取消原因 */
  get reason(): string { return this._reason; }

  /** 触发取消，通知所有监听器 */
  cancel(reason: string): void {
    if (this._cancelled) return;
    this._cancelled = true;
    this._reason = reason;
    for (const listener of this.listeners) {
      try { listener(reason); } catch { /* fire-and-forget */ }
    }
  }

  /** 注册取消回调，返回取消注册函数 */
  onCancel(listener: (reason: string) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter(l => l !== listener); };
  }

  /** 如果已取消则抛出异常 */
  throwIfCancelled(): void {
    if (this._cancelled) {
      throw new Error(`[Cancelled] ${this._reason}`);
    }
  }

  /** 重置取消状态 */
  reset(): void {
    this._cancelled = false;
    this._reason = '';
  }
}

// ============================================================
// ExecutionContext — 依赖注入容器
// ============================================================

/**
 * 执行上下文 — 运行时依赖注入容器。
 * 业务组件禁止在 init() 时固化依赖引用，必须通过 ctx.get() 运行时动态获取 (ADR-16)。
 */
export class ExecutionContext {
  private services = new Map<string, unknown>();

  /** 注册服务实例 */
  register<T>(name: string, instance: T): void {
    this.services.set(name, instance);
  }

  /** 获取服务实例（不存在则抛异常） */
  get<T>(name: string): T {
    const instance = this.services.get(name);
    if (!instance) {
      throw new Error(`[ExecutionContext] Service "${name}" not registered`);
    }
    return instance as T;
  }

  /** 安全获取服务实例（不存在返回 undefined） */
  tryGet<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  /** 检查服务是否已注册 */
  has(name: string): boolean {
    return this.services.has(name);
  }
}

// ============================================================
// Checkpoint — 会话检查点
// ============================================================

/** 会话检查点 — 用于 Resume 时恢复状态 */
export interface Checkpoint {
  /** 会话 ID */
  sessionId: string;
  /** 任务状态 */
  taskState: TaskState;
  /** 当前轮数 */
  round: number;
  /** 已花费费用 */
  costUsd: number;
  /** 检查点时间戳 */
  timestamp: number;
  /** 对话历史 */
  history: Message[];
  /** 附加元数据 */
  metadata: Record<string, unknown>;
}

// ============================================================
// Runtime Config & TaskResult
// ============================================================

/** 运行时配置 */
export interface RuntimeConfig {
  /** 项目工作目录 */
  cwd: string;
  /** 会话 ID（可选，不指定则自动生成） */
  sessionId?: string;
  /** 最大预算上限（美元，默认 $3.00） */
  maxBudgetUsd?: number;
  /** 检查点间隔（轮数，默认 15） */
  checkpointInterval?: number;
}

/** 任务执行结果 */
export interface TaskResult {
  /** 是否成功 */
  success: boolean;
  /** 结果摘要 */
  summary: string;
  /** 实际执行轮数 */
  rounds: number;
  /** 实际花费（美元） */
  costUsd: number;
  /** 执行耗时（毫秒） */
  durationMs: number;
}
