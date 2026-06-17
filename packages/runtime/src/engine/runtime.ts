import {
  type LifecycleAware,
  type ComponentState,
  type Session,
  type RuntimeConfig,
  type TaskResult,
  type Checkpoint,
  EventBus,
  StateMachine,
  TaskState,
  ExecutionContext,
  CancellationToken,
  createSession,
  topologicalSort,
  initializeComponents,
  shutdownComponents,
} from '../index.js';
import { reconcile, type ReconciliationResult } from '../engine/reconciliation.js';

let runtimeCounter = 0;

/**
 * Agent 运行时 — 所有入口（CLI/Web/VSCode/CI）共享的统一调度层。
 * 职责：管理组件生命周期、Session、主 Loop 控制、状态机、事件总线、取消传播。
 *
 * 硬边界 (ADR-19)：业务逻辑禁止进入 Runtime。业务能力通过 ExecutionContext 注入。
 */
export class AgentRuntime {
  readonly session: Session;
  readonly eventBus: EventBus;
  readonly stateMachine: StateMachine;
  readonly context: ExecutionContext;
  readonly cancellationToken: CancellationToken;

  private components: ComponentState[] = [];
  private loopToken: CancellationToken | null = null;

  private constructor(_config: RuntimeConfig, session: Session) {
    // _config consumed as needed (maxBudgetUsd, checkpointInterval) in Phase 4
    this.session = session;
    this.eventBus = new EventBus();
    this.stateMachine = new StateMachine();
    this.context = new ExecutionContext();
    this.cancellationToken = new CancellationToken();

    // 桥接状态机变更到事件总线
    this.stateMachine.onChange((from, to) => {
      this.eventBus.emit('state:changed', { from, to });
    });

    // 注册自身到 DI 容器，供组件通过 ctx.get() 获取
    this.context.register('runtime', this);
    this.context.register('eventBus', this.eventBus);
    this.context.register('session', this.session);
    this.context.register('stateMachine', this.stateMachine);
    this.context.register('cancellationToken', this.cancellationToken);
    this.context.register('context', this.context);
  }

  // 静态工厂方法

  /** 创建新的 AgentRuntime 实例（内部执行拓扑排序 → init 所有组件） */
  static async create(config: RuntimeConfig): Promise<AgentRuntime> {
    const sessionId = config.sessionId ?? `session-${Date.now()}-${++runtimeCounter}`;
    const session = createSession({ id: sessionId, cwd: config.cwd });

    const runtime = new AgentRuntime(config, session);
    runtime.eventBus.emit('session:started', { sessionId });

    // 组件在 create() 之前通过 registerComponent() 注入，在 start() 中初始化
    return runtime;
  }

  /** 从 checkpoint 恢复 Runtime（跳过已初始化组件，进入 RECOVERING 状态） */
  static async resume(sessionId: string, config: RuntimeConfig): Promise<AgentRuntime> {
    const session = createSession({ id: sessionId, cwd: config.cwd });
    session.status = 'active';

    const runtime = new AgentRuntime(config, session);
    runtime.stateMachine.forceState(TaskState.RECOVERING);

    // 调用方恢复 checkpoint 数据后需执行 performReconciliation 完成物理世界调和
    return runtime;
  }

  // 组件生命周期管理

  /** 注册 LifecycleAware 组件并注入 DI 容器 */
  registerComponent(component: LifecycleAware): void {
    this.components.push({
      component,
      status: 'uninitialized',
      failureCount: 0,
    });
    this.context.register(component.name, component);
  }

  /** 启动所有已注册组件：拓扑排序 → 依次 init */
  async start(): Promise<void> {
    const sorted = topologicalSort(this.components.map(c => c.component));
    this.components = await initializeComponents(sorted);
    this.eventBus.emit('runtime:ready', {});
  }

  /** 挂起会话（保持状态，可恢复） */
  async suspend(): Promise<void> {
    this.session.status = 'suspended';
    this.stateMachine.transition('suspend');
  }

  /** 销毁 Runtime：取消令牌 → 逆序 shutdown 所有组件 */
  async destroy(): Promise<void> {
    this.cancellationToken.cancel('runtime destroy');
    await shutdownComponents(this.components);
    this.session.status = 'completed';
    this.eventBus.emit('runtime:shutdown', { reason: 'destroy called' });
    this.eventBus.emit('session:ended', { sessionId: this.session.id, reason: 'destroy' });
  }

  // 健康检查 + 自愈恢复

  /** 对所有组件执行健康检查，不健康组件自动触发自愈 */
  async healthCheck(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    for (const state of this.components) {
      if (state.status === 'shutdown' || state.status === 'failed') {
        results.set(state.component.name, false);
        continue;
      }
      try {
        const healthy = await (state.component.healthCheck?.() ?? Promise.resolve(true));
        results.set(state.component.name, healthy);
        if (!healthy && state.status === 'healthy') {
          await this.attemptRecovery(state);
        }
      } catch {
        results.set(state.component.name, false);
        await this.attemptRecovery(state);
      }
    }
    return results;
  }

  private async attemptRecovery(state: ComponentState): Promise<void> {
    state.failureCount++;
    if (state.failureCount > 3) {
      state.status = 'degraded';
      this.eventBus.emit('component:degraded', {
        component: state.component.name,
        reason: `Failed recovery ${state.failureCount} times`,
      });
      // 通知依赖方进入降级模式
      for (const other of this.components) {
        if (other.component.dependencies?.includes(state.component.name)) {
          try {
            await other.component.onDependencyFailure?.(state.component.name);
          } catch { /* best-effort */ }
        }
      }
      return;
    }

    try {
      if (state.component.restart) {
        await state.component.restart();
      }
      state.status = 'healthy';
      state.failureCount = 0;
      this.eventBus.emit('component:recovered', { component: state.component.name });
    } catch (err) {
      console.warn(`[Runtime] Recovery attempt ${state.failureCount} for "${state.component.name}" failed: ${(err as Error).message}`);
    }
  }

  // 任务执行

  /** 启动主循环执行任务（executeStep 由 Executor 提供） */
  async run(task: string, executeStep: (runtime: AgentRuntime, round: number) => Promise<boolean>): Promise<TaskResult> {
    this.session.task = task;
    this.loopToken = new CancellationToken();
    this.stateMachine.transition('execution_start');
    this.eventBus.emit('task:started', { task });

    let round = 0;
    const startTime = Date.now();
    const totalCost = 0;

    try {
      while (true) {
        this.cancellationToken.throwIfCancelled();
        this.loopToken.throwIfCancelled();

        round++;
        this.eventBus.emit('loop:iteration', { round, cost: totalCost });

        const shouldContinue = await executeStep(this, round);
        if (!shouldContinue) break;
      }

      this.stateMachine.transition('task_finish');
      this.session.status = 'completed';
      const result: TaskResult = {
        success: true,
        summary: `Task completed in ${round} rounds`,
        rounds: round,
        costUsd: totalCost,
        durationMs: Date.now() - startTime,
      };
      this.eventBus.emit('task:completed', { result });
      return result;
    } catch (err) {
      if (this.cancellationToken.cancelled) {
        this.session.status = 'cancelled';
        this.eventBus.emit('task:cancelled', { reason: this.cancellationToken.reason });
        return { success: false, summary: this.cancellationToken.reason, rounds: round, costUsd: totalCost, durationMs: Date.now() - startTime };
      }
      this.session.status = 'failed';
      this.eventBus.emit('task:failed', { error: err as Error });
      return { success: false, summary: (err as Error).message, rounds: round, costUsd: totalCost, durationMs: Date.now() - startTime };
    }
  }

  /** 取消正在执行的任务 */
  async cancel(reason: string): Promise<void> {
    this.cancellationToken.cancel(reason);
    this.loopToken?.cancel(reason);
  }

  // 物理世界调和（Resume 用）

  /** 执行物理世界调和：扫描孤儿 Worktree + 通知组件恢复内部状态 */
  async performReconciliation(checkpoint: Checkpoint): Promise<ReconciliationResult> {
    return reconcile(this.session, this.components, checkpoint);
  }
}
