import type { ILLMProvider } from '../interface.js';

// 类型定义

/** 任务分析结果 */
export interface TaskAnalysis {
  /** simple | medium | complex */
  complexity: 'simple' | 'medium' | 'complex';
  /** 任务领域 */
  domain: 'code_search' | 'code_generation' | 'refactoring' | 'planning' | 'debugging' | 'general';
  /** 是否包含敏感数据 */
  containsSecrets: boolean;
  /** 预估 token 消耗 */
  estimatedTokens: number;
}

/** 路由规则 */
export interface RouteRule {
  name: string;
  condition: (analysis: TaskAnalysis) => boolean;
  providerName: string;
  priority: number;
}

/** 路由策略接口 — 可插拔，用户可注入自定义策略 */
export interface RoutingStrategy {
  readonly name: string;
  route(analysis: TaskAnalysis, providers: Map<string, ILLMProvider>): Promise<ILLMProvider | null>;
}

/** 单次 LLM 调用记录 */
export interface CallRecord {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  timestamp: number;
}

// 模型定价表 ($/1M tokens)

const PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.14, output: 0.28 },
  'deepseek-v4-pro': { input: 0.50, output: 2.00 },
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'gpt-5.3-codex': { input: 1.25, output: 10.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5': { input: 0.80, output: 4.00 },
  'gemini-2.5-pro': { input: 1.25, output: 10.00 },
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
};

// 质量升级链（便宜→强大）
const QUALITY_UPGRADE_CHAIN = ['deepseek', 'openai', 'anthropic'];
const FALLBACK_CHAIN = ['deepseek', 'openai', 'anthropic', 'openrouter'];

// TaskAnalyzer — 任务特征分析

/** 关键词启发式分析任务复杂度、领域和隐私需求 */
export class TaskAnalyzer {
  analyze(task: string): TaskAnalysis {
    const complexity = this._detectComplexity(task);
    const domain = this._detectDomain(task);
    const containsSecrets = this._detectSecrets(task);
    const estimatedTokens = this._estimateTokens(task);

    return { complexity, domain, containsSecrets, estimatedTokens };
  }

  private _detectComplexity(task: string): TaskAnalysis['complexity'] {
    const complexPatterns = [
      '重构', 'refactor', '架构', 'architecture', '迁移', 'migration',
      '整个系统', 'entire system', '全部', 'all files',
    ];
    const mediumPatterns = [
      '修复多个', 'fix multiple', '优化', 'optimize', '添加功能', 'add feature',
      '实现', 'implement',
    ];

    const lower = task.toLowerCase();
    if (complexPatterns.some(p => lower.includes(p.toLowerCase()))) return 'complex';
    if (mediumPatterns.some(p => lower.includes(p.toLowerCase()))) return 'medium';
    return 'simple';
  }

  private _detectDomain(task: string): TaskAnalysis['domain'] {
    const lower = task.toLowerCase();
    if (/搜索|查找|找到|在哪里|search|find|locate|where is/.test(lower)) return 'code_search';
    if (/规划|架构|设计|plan|architect|design/.test(lower)) return 'planning';
    if (/调试|debug|修复.*bug|fix.*bug|报错|error/.test(lower)) return 'debugging';
    if (/重构|refactor|重写|rewrite/.test(lower)) return 'refactoring';
    if (/生成|创建|添加|generate|create|add|implement|build/.test(lower)) return 'code_generation';
    return 'general';
  }

  private _detectSecrets(task: string): boolean {
    const lower = task.toLowerCase();
    return /密钥|密码|secret|password|token|credential|\.env|private key/.test(lower);
  }

  private _estimateTokens(task: string): number {
    return Math.ceil(task.length / 4);
  }
}

// 可插拔路由策略

/** 成本优先策略 — 选择最便宜的可用 Provider */
export class CostFirstStrategy implements RoutingStrategy {
  readonly name = 'cost-first';

  private costRank: Record<string, number> = {
    deepseek: 1, ollama: 0, openrouter: 2, google: 3, openai: 4, anthropic: 5,
  };

  async route(_analysis: TaskAnalysis, providers: Map<string, ILLMProvider>): Promise<ILLMProvider | null> {
    // 按成本从低到高排序，选第一个健康的
    const sorted = Array.from(providers.entries())
      .sort(([, a], [, b]) => (this.costRank[a.name] ?? 5) - (this.costRank[b.name] ?? 5));
    for (const [, p] of sorted) {
      if (await p.healthCheck()) return p;
    }
    return null;
  }
}

/** 质量优先策略 — 选择推理能力最强的 Provider */
export class QualityFirstStrategy implements RoutingStrategy {
  readonly name = 'quality-first';

  private qualityRank: Record<string, number> = {
    anthropic: 1, openai: 2, google: 3, deepseek: 4, openrouter: 5, ollama: 6,
  };

  async route(_analysis: TaskAnalysis, providers: Map<string, ILLMProvider>): Promise<ILLMProvider | null> {
    const sorted = Array.from(providers.entries())
      .sort(([, a], [, b]) => (this.qualityRank[a.name] ?? 6) - (this.qualityRank[b.name] ?? 6));
    for (const [, p] of sorted) {
      if (await p.healthCheck()) return p;
    }
    return null;
  }
}

/** 延迟优先策略 — 选择响应最快的 Provider（通常是最便宜/最简单的） */
export class LatencyFirstStrategy implements RoutingStrategy {
  readonly name = 'latency-first';

  async route(_analysis: TaskAnalysis, providers: Map<string, ILLMProvider>): Promise<ILLMProvider | null> {
    // Ollama 本地 → DeepSeek Flash → OpenRouter → 其他
    const order = ['ollama', 'deepseek', 'openrouter', 'google', 'openai', 'anthropic'];
    for (const name of order) {
      const p = providers.get(name);
      if (p && await p.healthCheck()) return p;
    }
    return null;
  }
}

/** 隐私优先策略 — 敏感数据必须路由到本地模型 */
export class PrivacyFirstStrategy implements RoutingStrategy {
  readonly name = 'privacy-first';

  async route(analysis: TaskAnalysis, providers: Map<string, ILLMProvider>): Promise<ILLMProvider | null> {
    if (analysis.containsSecrets) {
      const ollama = providers.get('ollama');
      if (ollama && await ollama.healthCheck()) return ollama;
      // 本地不可用 → 返回 null 表示拒绝路由任务
      return null;
    }
    // 非敏感任务委托给成本优先
    return new CostFirstStrategy().route(analysis, providers);
  }
}

// CostTracker — 成本累加与上限检查

/** 成本追踪器 — 记录每次 LLM 调用费用，支持预算上限检查 */
export class CostTracker {
  private records: CallRecord[] = [];
  private totalCost: number = 0;
  private maxBudget: number;

  constructor(maxBudgetUsd: number = 3.0) {
    this.maxBudget = maxBudgetUsd;
  }

  /** 计算单次调用的成本 */
  calculateCost(_providerName: string, modelName: string, promptTokens: number, completionTokens: number): number {
    // 匹配定价（支持前缀匹配）
    let pricing = PRICING[modelName];
    if (!pricing) {
      // 按 provider 前缀匹配
      for (const [key, p] of Object.entries(PRICING)) {
        if (modelName.includes(key.split('-')[0] ?? '')) {
          pricing = p;
          break;
        }
      }
    }
    pricing = pricing ?? { input: 0.50, output: 2.00 };

    return (promptTokens / 1_000_000) * pricing.input +
           (completionTokens / 1_000_000) * pricing.output;
  }

  /** 记录一次调用 */
  record(providerName: string, modelName: string, promptTokens: number, completionTokens: number): void {
    const costUsd = this.calculateCost(providerName, modelName, promptTokens, completionTokens);
    this.records.push({
      provider: providerName,
      model: modelName,
      promptTokens,
      completionTokens,
      costUsd,
      timestamp: Date.now(),
    });
    this.totalCost += costUsd;
  }

  /** 获取总费用 */
  get totalCostUsd(): number { return this.totalCost; }

  /** 获取调用次数 */
  get callCount(): number { return this.records.length; }

  /** 获取最近一次调用记录 */
  get lastCall(): CallRecord | undefined { return this.records[this.records.length - 1]; }

  /** 获取全部记录 */
  getRecords(): ReadonlyArray<CallRecord> { return this.records; }

  /** 检查是否超出预算 */
  isOverBudget(): boolean { return this.totalCost >= this.maxBudget; }

  /** 获取剩余预算 */
  remainingBudget(): number { return Math.max(0, this.maxBudget - this.totalCost); }

  /** 生成会话成本汇总 */
  summary(): string {
    const lines = [
      `总成本: $${this.totalCost.toFixed(4)}`,
      `调用次数: ${this.records.length}`,
      `预算上限: $${this.maxBudget.toFixed(2)}`,
      `剩余预算: $${this.remainingBudget().toFixed(4)}`,
    ];
    const byProvider = new Map<string, { calls: number; cost: number }>();
    for (const r of this.records) {
      const entry = byProvider.get(r.provider) ?? { calls: 0, cost: 0 };
      entry.calls++;
      entry.cost += r.costUsd;
      byProvider.set(r.provider, entry);
    }
    if (byProvider.size > 0) {
      lines.push('--- 按 Provider 明细 ---');
      for (const [provider, info] of byProvider) {
        lines.push(`  ${provider}: ${info.calls} 次, $${info.cost.toFixed(4)}`);
      }
    }
    return lines.join('\n');
  }

  reset(): void {
    this.records = [];
    this.totalCost = 0;
  }
}

// HealthManager — 健康检查与故障标记

/** 健康管理器 — 定期健康检查 + 故障标记，30s 内不重复检查 */
export class HealthManager {
  private unhealthy = new Set<string>();
  private lastCheck = new Map<string, number>();
  private checkIntervalMs = 30_000;

  /** 标记 Provider 为健康 */
  markHealthy(name: string): void { this.unhealthy.delete(name); }

  /** 标记 Provider 为故障 */
  markUnhealthy(name: string): void { this.unhealthy.add(name); }

  /** 判断 Provider 是否健康 */
  isHealthy(name: string): boolean { return !this.unhealthy.has(name); }

  /** 定期健康检查（节流：30s 内不重复检查） */
  async check(name: string, provider: ILLMProvider): Promise<boolean> {
    const now = Date.now();
    const last = this.lastCheck.get(name) ?? 0;
    if (now - last < this.checkIntervalMs) {
      return this.isHealthy(name);
    }

    this.lastCheck.set(name, now);
    try {
      const ok = await provider.healthCheck();
      if (ok) this.markHealthy(name);
      else this.markUnhealthy(name);
      return ok;
    } catch {
      this.markUnhealthy(name);
      return false;
    }
  }

  /** 获取健康的 Provider 名称列表 */
  getHealthy(providers: Map<string, ILLMProvider>): string[] {
    return Array.from(providers.keys()).filter(n => this.isHealthy(n));
  }
}

// FallbackManager — 降级链管理

/** 降级链管理器 — L1 故障降级 + L2 质量驱动升级 + Reflection Snapshot */
export class FallbackManager {
  private chain: string[];
  private consecutiveFailures = new Map<string, number>();

  constructor(chain: string[] = FALLBACK_CHAIN) {
    this.chain = chain;
  }

  /** 获取指定 Provider 的下一个降级备选 */
  getFallback(providerName: string): string | null {
    const idx = this.chain.indexOf(providerName);
    if (idx < 0) return null;
    for (let i = idx + 1; i < this.chain.length; i++) {
      const next = this.chain[i];
      if (next) return next;
    }
    return null;
  }

  /** L2 质量升级：连续失败触发模型升级 */
  recordFailure(providerName: string): number {
    const count = (this.consecutiveFailures.get(providerName) ?? 0) + 1;
    this.consecutiveFailures.set(providerName, count);
    return count;
  }

  /** 成功时重置失败计数 */
  recordSuccess(providerName: string): void {
    this.consecutiveFailures.delete(providerName);
  }

  /** 获取升级后的 Provider（如果失败次数达到阈值） */
  getQualityUpgrade(providerName: string): string | null {
    const failures = this.consecutiveFailures.get(providerName) ?? 0;
    if (failures < 2) return null;

    const idx = QUALITY_UPGRADE_CHAIN.indexOf(providerName);
    if (idx < 0 || idx >= QUALITY_UPGRADE_CHAIN.length - 1) return null;
    return QUALITY_UPGRADE_CHAIN[idx + 1] ?? null;
  }

  /** 生成 Reflection Snapshot（升级时保留失败上下文） */
  generateReflectionSnapshot(
    previousModel: string,
    failures: Array<{ toolName: string; error: string }>,
  ): string {
    if (failures.length === 0) return '';
    const lines = [
      '<failed_attempts_summary>',
      `前 ${failures.length} 轮尝试由 ${previousModel} 执行，均因以下错误失败：`,
    ];
    for (const f of failures) {
      lines.push(`- 工具="${f.toolName}" → ${f.error}`);
    }
    lines.push(`核心问题: ${previousModel} 推理能力不足，已自动升级至更强模型`, '</failed_attempts_summary>');
    return lines.join('\n');
  }
}

// AIGateway — 协调器（仅编排，不嵌入具体路由逻辑）

/** AI Gateway 配置选项 */
export interface GatewayConfig {
  /** 最大预算上限（美元，默认 $3.00） */
  maxBudgetUsd?: number;
  /** 路由策略（默认 CostFirstStrategy） */
  strategy?: RoutingStrategy;
  /** 自定义降级链 */
  failoverChain?: string[];
}

export class AIGateway {
  private providers = new Map<string, ILLMProvider>();
  private analyzer: TaskAnalyzer;
  private costTracker: CostTracker;
  private healthManager: HealthManager;
  private fallbackManager: FallbackManager;
  private strategy: RoutingStrategy;
  private recentFailures: Array<{ toolName: string; error: string }> = [];
  private currentProvider: ILLMProvider | null = null;

  constructor(config: GatewayConfig = {}) {
    this.analyzer = new TaskAnalyzer();
    this.costTracker = new CostTracker(config.maxBudgetUsd ?? 3.0);
    this.healthManager = new HealthManager();
    this.fallbackManager = new FallbackManager(config.failoverChain);
    this.strategy = config.strategy ?? new CostFirstStrategy();
  }

  /** 注册 Provider */
  register(provider: ILLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  /** 获取已注册 Provider */
  getProvider(name: string): ILLMProvider | undefined {
    return this.providers.get(name);
  }

  /** 手动选择 Provider（覆盖自动路由） */
  selectProvider(name: string): ILLMProvider | null {
    const provider = this.providers.get(name);
    if (provider) this.currentProvider = provider;
    return provider ?? null;
  }

  /** 分析任务并自动路由到最优 Provider */
  async routeTask(task: string): Promise<{ provider: ILLMProvider; analysis: TaskAnalysis; snapshot: string } | null> {
    const analysis = this.analyzer.analyze(task);
    let snapshot = '';

    // 优先检查已有 Provider 是否需要质量升级
    if (this.currentProvider) {
      const upgrade = this.fallbackManager.getQualityUpgrade(this.currentProvider.name);
      if (upgrade) {
        const upgraded = this.providers.get(upgrade);
        if (upgraded) {
          snapshot = this.fallbackManager.generateReflectionSnapshot(
            this.currentProvider.name,
            [...this.recentFailures],
          );
          this.recentFailures = [];
          this.fallbackManager.recordSuccess(upgrade);
          this.currentProvider = upgraded;
          return { provider: upgraded, analysis, snapshot };
        }
      }
    }

    // 委托给路由策略
    let selected = await this.strategy.route(analysis, this.providers);

    // L1 容错：首选不可用 → 按降级链 fallback
    if (!selected) {
      for (const name of this.healthManager.getHealthy(this.providers)) {
        const fb = this.providers.get(name);
        if (fb) { selected = fb; break; }
      }
    }

    if (!selected) {
      throw new Error('[Gateway] 所有 Provider 均不可用');
    }

    this.currentProvider = selected;
    return { provider: selected, analysis, snapshot };
  }

  /** 记录工具执行失败（用于质量升级判断） */
  recordToolFailure(toolName: string, error: string): void {
    this.recentFailures.push({ toolName, error });
    if (this.currentProvider) {
      this.fallbackManager.recordFailure(this.currentProvider.name);
    }
  }

  /** 记录工具执行成功 */
  recordToolSuccess(): void {
    if (this.currentProvider) {
      this.fallbackManager.recordSuccess(this.currentProvider.name);
    }
    this.recentFailures = [];
  }

  /** 获取成本追踪器 */
  get cost(): CostTracker { return this.costTracker; }

  /** 获取健康管理器 */
  get health(): HealthManager { return this.healthManager; }

  /** 获取当前选中的 Provider */
  get activeProvider(): ILLMProvider | null { return this.currentProvider; }

  /** 设置路由策略 */
  setStrategy(strategy: RoutingStrategy): void { this.strategy = strategy; }

  /** 生成会话汇总 */
  sessionSummary(): string {
    return this.costTracker.summary();
  }
}
