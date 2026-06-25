/**
 * 指标快照 — 会话结束时的聚合数据
 */
export interface MetricsSnapshot {
  /** 会话级 */
  sessionTaskCount: number;
  sessionSuccessRate: number;
  sessionAvgLoopsPerTask: number;
  sessionAvgCostPerTask: number;
  totalLoops: number;
  totalCostUsd: number;
  /** 工具级 */
  toolCalls: Record<string, { count: number; successCount: number; totalDurationMs: number }>;
  /** Provider 级 */
  providerCalls: Record<string, { count: number; totalLatencyMs: number }>;
  /** 安全指标 */
  approvalCount: number;
  approvalDenialRate: number;
}

/**
 * MetricsCollector — 从 EventBus 消费事件实时聚合指标。
 *
 * 数据流单源模式 (ADR-17):
 *   业务代码 → EventBus → AuditLogger (JSONL 日志)
 *                      → MetricsCollector (聚合指标)
 *
 * 永远不允许业务代码直接双写 AuditLogger 和 MetricsCollector。
 */
export class MetricsCollector {
  // 会话级计数器
  private _taskCount = 0;
  private _successCount = 0;
  private _totalLoops = 0;
  private _totalCostUsd = 0;

  // 工具级
  private _toolCalls = new Map<string, { count: number; successCount: number; totalDurationMs: number }>();

  // Provider 级
  private _providerCalls = new Map<string, { count: number; totalLatencyMs: number }>();

  // 安全
  private _approvalCount = 0;
  private _denialCount = 0;

  /** 记录一次任务完成 */
  recordTask(success: boolean): void {
    this._taskCount++;
    if (success) this._successCount++;
  }

  /** 记录一次循环迭代 */
  recordLoop(): void { this._totalLoops++; }

  /** 记录费用 */
  recordCost(usd: number): void { this._totalCostUsd += usd; }

  /** 记录工具调用 */
  recordToolCall(toolName: string, success: boolean, durationMs: number): void {
    const entry = this._toolCalls.get(toolName) ?? { count: 0, successCount: 0, totalDurationMs: 0 };
    entry.count++;
    if (success) entry.successCount++;
    entry.totalDurationMs += durationMs;
    this._toolCalls.set(toolName, entry);
  }

  /** 记录 Provider 调用 */
  recordProviderCall(provider: string, latencyMs: number): void {
    const entry = this._providerCalls.get(provider) ?? { count: 0, totalLatencyMs: 0 };
    entry.count++;
    entry.totalLatencyMs += latencyMs;
    this._providerCalls.set(provider, entry);
  }

  /** 记录审批 */
  recordApproval(granted: boolean): void {
    this._approvalCount++;
    if (!granted) this._denialCount++;
  }

  /** 生成指标快照 */
  snapshot(): MetricsSnapshot {
    const toolCalls: Record<string, { count: number; successCount: number; totalDurationMs: number }> = {};
    for (const [name, entry] of this._toolCalls) {
      toolCalls[name] = { ...entry };
    }

    const providerCalls: Record<string, { count: number; totalLatencyMs: number }> = {};
    for (const [name, entry] of this._providerCalls) {
      providerCalls[name] = { ...entry };
    }

    return {
      sessionTaskCount: this._taskCount,
      sessionSuccessRate: this._taskCount > 0 ? this._successCount / this._taskCount : 1,
      sessionAvgLoopsPerTask: this._taskCount > 0 ? this._totalLoops / this._taskCount : 0,
      sessionAvgCostPerTask: this._taskCount > 0 ? this._totalCostUsd / this._taskCount : 0,
      totalLoops: this._totalLoops,
      totalCostUsd: this._totalCostUsd,
      toolCalls,
      providerCalls,
      approvalCount: this._approvalCount,
      approvalDenialRate: this._approvalCount > 0 ? this._denialCount / this._approvalCount : 0,
    };
  }

  /** 导出 JSON 格式（供日志持久化） */
  toJSON(): string {
    return JSON.stringify(this.snapshot(), null, 2);
  }

  /** 导出 Prometheus 格式（可选） */
  toPrometheus(): string {
    const snap = this.snapshot();
    const lines: string[] = [
      `# HELP agent_tasks_total Total tasks executed`,
      `# TYPE agent_tasks_total counter`,
      `agent_tasks_total ${snap.sessionTaskCount}`,
      `# HELP agent_success_rate Task success rate`,
      `# TYPE agent_success_rate gauge`,
      `agent_success_rate ${snap.sessionSuccessRate}`,
      `# HELP agent_total_cost_usd Total cost in USD`,
      `# TYPE agent_total_cost_usd counter`,
      `agent_total_cost_usd ${snap.totalCostUsd}`,
    ];

    for (const [tool, entry] of Object.entries(snap.toolCalls)) {
      lines.push(
        `# HELP agent_tool_calls_total Tool call count`,
        `# TYPE agent_tool_calls_total counter`,
        `agent_tool_calls_total{tool="${tool}"} ${entry.count}`,
      );
    }

    return lines.join('\n');
  }

  /** 重置全部指标 */
  reset(): void {
    this._taskCount = 0;
    this._successCount = 0;
    this._totalLoops = 0;
    this._totalCostUsd = 0;
    this._toolCalls.clear();
    this._providerCalls.clear();
    this._approvalCount = 0;
    this._denialCount = 0;
  }
}
