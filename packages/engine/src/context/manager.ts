/**
 * 上下文切块的优先级分组。
 */
export type ChunkPriority = 'system' | 'high' | 'medium' | 'low';

/**
 * 上下文切块 — 来源无关的抽象表示 (ADR-17)。
 * ContextManager 对所有来源一视同仁，按优先级排序、按 token 预算裁剪。
 */
export interface ContextChunk {
  /** 裁剪优先级：system(0) 永不裁剪，high(1-99), medium(100-199), low(200+) */
  priority: number;
  /** 文本内容 */
  content: string;
  /** 预估 token 数 */
  tokens: number;
  /** 来源标识 */
  source: string;
  /** 保留轮数（过期自动丢弃） */
  ttl?: number;
  /** 同 source 新 chunk 到达时的合并策略 */
  mergeStrategy?: 'replace' | 'append' | 'summarize';
  /** 不可裁剪标记（当前轮和上一轮的实时反馈） */
  uncuttable?: boolean;
}

/**
 * ContextSource 接口 (ADR-17)。
 * 所有上下文来源（Memory、SubAgent、Planner、LSP、工具结果等）必须实现此接口。
 */
export interface ContextSource {
  readonly id: string;
  readonly priority: number;
  /** 收集当前会话的上下文切块 */
  collect(session: unknown, currentRound: number): Promise<ContextChunk[]>;
}

// ============================================================
// 内置 ContextSource 实现
// ============================================================

/** System Prompt — 优先级 0，永不裁剪 */
export class SystemPromptSource implements ContextSource {
  readonly id = 'system_prompt';
  readonly priority = 0;

  constructor(private content: string) {}

  async collect(_session: unknown, _currentRound: number): Promise<ContextChunk[]> {
    return [{
      priority: this.priority,
      content: this.content,
      tokens: Math.ceil(this.content.length / 4),
      source: this.id,
      ttl: Infinity,
    }];
  }
}

/** 工具定义 — 优先级 1，永不裁剪 */
export class ToolDefinitionSource implements ContextSource {
  readonly id = 'tool_definitions';
  readonly priority = 1;

  constructor(private schema: string) {}

  async collect(_session: unknown, _currentRound: number): Promise<ContextChunk[]> {
    return [{
      priority: this.priority,
      content: this.schema,
      tokens: Math.ceil(this.schema.length / 4),
      source: this.id,
      ttl: Infinity,
    }];
  }
}

/** 工具执行结果 — 优先级 100，保留 3 轮，当前轮不可裁剪 */
export class ToolResultSource implements ContextSource {
  readonly id = 'tool_result';
  readonly priority = 100;

  async collect(_session: unknown, _currentRound: number): Promise<ContextChunk[]> {
    return []; // 由 ContextManager 直接注入（避免重复收集）
  }
}

// ============================================================
// ContextManager — 收集 → 排序 → 裁剪 → 注入管道
// ============================================================

export interface ContextManagerConfig {
  /** 上下文最大 token 预算 */
  maxTokens?: number;
  /** 裁剪触发阈值（token 占比，默认 0.75） */
  trimThreshold?: number;
  /** Observation 压缩阈值（字符数，默认 3000） */
  observationCompressThreshold?: number;
}

/**
 * 上下文管理器 (ADR-17)。
 *
 * 核心功能：
 *   1. 统一收集所有 ContextSource 的切块
 *   2. 按优先级排序（数字低的先保留）
 *   3. 按 token 预算从低优先级开始裁剪
 *   4. Observation 过长时压缩（保留头尾）
 *   5. 提示词缓存优化（System Prompt 放在最前）
 */
export class ContextManager {
  private sources: ContextSource[] = [];
  private config: Required<ContextManagerConfig>;

  constructor(config: ContextManagerConfig = {}) {
    this.config = {
      maxTokens: config.maxTokens ?? 100_000,
      trimThreshold: config.trimThreshold ?? 0.75,
      observationCompressThreshold: config.observationCompressThreshold ?? 3000,
    };
  }

  /** 注册上下文来源 */
  registerSource(source: ContextSource): void {
    this.sources.push(source);
  }

  /** 移除上下文来源 */
  unregisterSource(id: string): void {
    this.sources = this.sources.filter(s => s.id !== id);
  }

  /**
   * 核心裁剪方法：收集所有来源 → 按优先级排序 → 按 token 预算裁剪。
   *
   * 裁剪规则：
   *   - system/high 优先级优先保留
   *   - uncuttable 标记强制保留（最近 2 轮实时反馈）
   *   - 高优先级历史内容超过预算时 summarize 压缩而非直接丢弃
   *   - 低优先级过期 chunk（TTL 耗尽）自动丢弃
   */
  async buildContext(
    session: unknown,
    currentRound: number,
    toolResultChunks?: ContextChunk[],
  ): Promise<ContextChunk[]> {
    // 1. 收集所有来源
    const allChunks: ContextChunk[] = [];
    for (const source of this.sources) {
      try {
        const chunks = await source.collect(session, currentRound);
        allChunks.push(...chunks);
      } catch {
        // 某个来源失败不影响其他来源
      }
    }

    // 2. 追加工具结果（如果有）
    if (toolResultChunks) {
      allChunks.push(...toolResultChunks);
    }

    // 3. TTL 过期过滤
    const alive = allChunks.filter(c => c.ttl === undefined || c.ttl === Infinity || c.ttl >= 0);

    // 4. 计算总 token 数
    const totalTokens = alive.reduce((sum, c) => sum + c.tokens, 0);

    // 5. 如果超出预算 → 裁剪
    if (totalTokens > this.config.maxTokens * this.config.trimThreshold) {
      return this._trim(alive, totalTokens);
    }

    return alive;
  }

  /**
   * 裁剪策略：
   *   - 保留 uncuttable 切块（最近 2 轮实时反馈）
   *   - 保留 system/high 优先级切块
   *   - medium 优先级尝试 summarize 压缩
   *   - low 优先级直接丢弃
   */
  private _trim(chunks: ContextChunk[], _totalTokens: number): ContextChunk[] {
    const budget = this.config.maxTokens;

    // 排序：priority 小的在前（更重要）
    const sorted = [...chunks].sort((a, b) => a.priority - b.priority);

    const result: ContextChunk[] = [];
    let usedTokens = 0;

    for (const chunk of sorted) {
      // uncuttable 强制全额保留
      if (chunk.uncuttable) {
        result.push(chunk);
        usedTokens += chunk.tokens;
        continue;
      }

      // system/high (priority < 100) — 尽量保留
      if (chunk.priority < 100) {
        if (usedTokens + chunk.tokens <= budget) {
          result.push(chunk);
          usedTokens += chunk.tokens;
        } else if (chunk.mergeStrategy === 'summarize') {
          // 高优先级但超预算 → 压缩
          const compressed = this._summarizeChunk(chunk);
          result.push(compressed);
          usedTokens += compressed.tokens;
        }
        continue;
      }

      // medium/low — 有空间就加，没空间就丢弃
      if (usedTokens + chunk.tokens <= budget) {
        result.push(chunk);
        usedTokens += chunk.tokens;
      }
    }

    return result;
  }

  /** 切块压缩：保留前 1/3 + 后 1/4 */
  private _summarizeChunk(chunk: ContextChunk): ContextChunk {
    const maxLen = 500;
    if (chunk.content.length <= maxLen) return chunk;

    const head = chunk.content.slice(0, Math.floor(maxLen * 0.6));
    const tail = chunk.content.slice(-Math.floor(maxLen * 0.4));
    return {
      ...chunk,
      content: `${head}\n...[已压缩 ${chunk.content.length - maxLen} 字符]...\n${tail}`,
      tokens: Math.ceil(maxLen / 4),
    };
  }

  /**
   * Observation 压缩：超长工具结果截头尾。
   * 例如 5000 行编译错误 → 保留前 30 行 + 最后 10 行。
   */
  compressObservation(observation: string): string {
    const threshold = this.config.observationCompressThreshold;
    if (observation.length <= threshold) return observation;

    const lines = observation.split('\n');
    const head = lines.slice(0, 30);
    const tail = lines.slice(-10);
    return [
      ...head,
      `... [已截断 ${lines.length - 40} 行 / ${observation.length} 字符] ...`,
      ...tail,
    ].join('\n');
  }

  /**
   * 构建提示词缓存优化的消息数组。
   * System Prompt + 工具定义作为静态前缀，放在最前面。
   */
  buildCacheFriendlyMessages(context: ContextChunk[]): Array<{ role: string; content: string }> {
    const systemChunks = context.filter(c => c.priority <= 1);
    const otherChunks = context.filter(c => c.priority > 1);

    const messages: Array<{ role: string; content: string }> = [];

    // 静态前缀（匹配 prompt caching cache break 边界）
    if (systemChunks.length > 0) {
      messages.push({
        role: 'system',
        content: systemChunks.map(c => c.content).join('\n\n'),
      });
    }

    // 其他内容
    for (const chunk of otherChunks) {
      messages.push({ role: 'user', content: `[${chunk.source}]:\n${chunk.content}` });
    }

    return messages;
  }
}
