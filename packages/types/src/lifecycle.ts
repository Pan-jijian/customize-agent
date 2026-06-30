// @customize-agent/types — 组件生命周期类型 (ADR-16)

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
