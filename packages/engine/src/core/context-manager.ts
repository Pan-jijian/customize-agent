import { estimateTokens } from '@customize-agent/llm';
import type { Message } from '@customize-agent/types';
import type { ILLMProvider } from '@customize-agent/llm';

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

// 内置 ContextSource 实现

/** System Prompt — 优先级 0，永不裁剪 */
export class SystemPromptSource implements ContextSource {
  readonly id = 'system_prompt';
  readonly priority = 0;

  constructor(private content: string) {}

  async collect(_session: unknown, _currentRound: number): Promise<ContextChunk[]> {
    return [{
      priority: this.priority,
      content: this.content,
      tokens: estimateTokens(this.content),
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
      tokens: estimateTokens(this.schema),
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

// ContextManager — 收集 → 排序 → 裁剪 → 注入管道

export interface ContextManagerConfig {
  /** 上下文最大 token 预算 */
  maxTokens?: number;
  /** 裁剪触发阈值（token 占比，默认 0.75） */
  trimThreshold?: number;
  /** Observation 压缩阈值（字符数，默认 3000） */
  observationCompressThreshold?: number;
}

/** 轻量消息压缩的上下文水位线 */
const WARN_PCT = 0.60;   // 60%: 打印警告
const LIGHT_PCT = 0.75;  // 75%: 轻量裁剪旧 tool 结果
const FULL_PCT = 0.85;   // 85%: LLM 摘要压缩

/**
 * 上下文管理器 (ADR-17)。
 *
 * 核心功能：
 *   1. 统一收集所有 ContextSource 的切块
 *   2. 按优先级排序（数字低的先保留）
 *   3. 按 token 预算从低优先级开始裁剪
 *   4. Observation 过长时压缩（保留头尾）
 *   5. 提示词缓存优化（System Prompt 放在最前）
 *   6. 消息数组压缩（轻量截断 + LLM 摘要），供 AgentExecutor 和子智能体共用
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
    const alive = allChunks.filter(c => c.ttl === undefined || c.ttl === Infinity || c.ttl > currentRound);

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

    const sorted = [...chunks].sort((a, b) => a.priority - b.priority);

    const result: ContextChunk[] = [];
    let usedTokens = 0;

    for (const chunk of sorted) {
      if (chunk.uncuttable) {
        result.push(chunk);
        usedTokens += chunk.tokens;
        continue;
      }

      if (chunk.priority < 100) {
        if (usedTokens + chunk.tokens <= budget) {
          result.push(chunk);
          usedTokens += chunk.tokens;
        } else if (chunk.mergeStrategy === 'summarize') {
          const compressed = this._summarizeChunk(chunk);
          result.push(compressed);
          usedTokens += compressed.tokens;
        }
        continue;
      }

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
      tokens: Math.ceil(maxLen / 3),
    };
  }

  /**
   * Observation 压缩：超长工具结果截头尾。
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
   */
  buildCacheFriendlyMessages(context: ContextChunk[]): Array<{ role: string; content: string }> {
    const systemChunks = context.filter(c => c.priority <= 1);
    const otherChunks = context.filter(c => c.priority > 1);

    const messages: Array<{ role: string; content: string }> = [];

    if (systemChunks.length > 0) {
      messages.push({
        role: 'system',
        content: systemChunks.map(c => c.content).join('\n\n'),
      });
    }

    for (const chunk of otherChunks) {
      messages.push({ role: 'user', content: `[${chunk.source}]:\n${chunk.content}` });
    }

    return messages;
  }

  // ── 消息数组压缩（从 AgentExecutor 下沉，供 CLI 和子智能体共用）──

  /**
   * 压缩对话消息数组，使其适配 token 预算。
   * 三级水位：60% 警告 → 75% 轻量截断 → 85% LLM 摘要。
   *
   * @returns 压缩后的消息数组（原地修改 + 返回同一引用）
   */
  async compactMessages(
    working: Message[],
    provider: ILLMProvider,
    currentTokens: number,
  ): Promise<{ didCompact: boolean; newTokens: number }> {
    const limit = provider.capabilities.maxContextTokens;
    let tokens = currentTokens;

    if (tokens > limit * FULL_PCT) {
      await this._llmCompact(working, provider);
      tokens = await this._countTokens(provider, working);
      return { didCompact: true, newTokens: tokens };
    }

    if (tokens > limit * LIGHT_PCT) {
      this._lightCompact(working);
      tokens = await this._countTokens(provider, working);
      return { didCompact: true, newTokens: tokens };
    }

    return { didCompact: false, newTokens: tokens };
  }

  /** 是否需要打印上下文警告 */
  shouldWarn(currentTokens: number, maxTokens: number): boolean {
    return currentTokens > maxTokens * WARN_PCT;
  }

  /**
   * 查找尾部保留边界：从末尾向前找最近的 assistant 消息，保证 tool 消息有前置 tool_calls。
   * 返回 { tailStart, TAIL } 或 null（消息太短无需压缩）。
   */
  private _findTailStart(working: Message[], minHead: number): { tailStart: number; TAIL: number } | null {
    let TAIL = 8; // 最后 4 轮完整保留
    let tailStart = working.length - TAIL;
    while (tailStart > minHead && tailStart < working.length && working[tailStart]?.role !== 'assistant') {
      tailStart++; TAIL++;
    }
    if (tailStart >= working.length) return null;
    return { tailStart, TAIL };
  }

  /** 轻量压缩：截断旧 tool 结果到 200 字符，不动用户消息和 assistant 思考 */
  private _lightCompact(working: Message[]): void {
    const MIN_HEAD = 2;
    const boundary = this._findTailStart(working, MIN_HEAD);
    if (!boundary || working.length <= boundary.TAIL) return;
    for (let i = MIN_HEAD; i < working.length - boundary.TAIL; i++) {
      const m = working[i]!;
      if (m.role === 'user') continue;
      if (m.role === 'tool' && m.content && m.content.length > 200) {
        m.content = m.content.slice(0, 197) + '...';
      }
    }
  }

  /** LLM 摘要压缩：调用模型生成结构化摘要，替换旧消息 */
  private async _llmCompact(working: Message[], provider: ILLMProvider): Promise<void> {
    const HEAD = 2;
    const boundary = this._findTailStart(working, HEAD);
    if (!boundary || working.length <= HEAD + boundary.TAIL) return;
    const TAIL = boundary.TAIL;

    const compacted: Message[] = [];
    const protectedUserMsgs: Message[] = [];
    for (let i = HEAD; i < working.length - TAIL; i++) {
      const m = working[i]!;
      if (m.role === 'user') {
        protectedUserMsgs.push(m);
      } else {
        compacted.push(m);
      }
    }

    if (compacted.length === 0) return;

    const compactText = compacted.map(m =>
      `[${m.role}] ${(m.content ?? '').slice(0, 500)}`
    ).join('\n---\n');

    const summaryPrompt: Message[] = [
      { role: 'system', content: '你是一个对话摘要器。将以下 Agent 对话历史压缩为一份结构化摘要，包含：1) 用户任务 2) 已完成操作（工具调用统计）3) 关键发现/决策 4) 待办事项。用中文输出，不超过 800 字。只输出摘要，不要解释。' },
      { role: 'user', content: `请压缩以下对话历史：\n\n${compactText}` },
    ];

    try {
      const res = await provider.chat(summaryPrompt);
      const summary = `[上下文压缩] 此前对话已自动总结：\n${res.content.trim()}`;
      const summaryMsg: Message = { role: 'user', content: summary };

      const tail = working.splice(working.length - TAIL, TAIL);
      working.splice(HEAD, working.length - HEAD, ...protectedUserMsgs, summaryMsg);
      working.push(...tail);
    } catch {
      this._lightCompact(working);
    }
  }

  /** 用 Provider 真实 API 计数 */
  private async _countTokens(provider: ILLMProvider, msgs: Message[]): Promise<number> {
    try { return await provider.countTokens(msgs); }
    catch { return Math.ceil(msgs.reduce((s, m) => s + (m.content?.length ?? 0), 0) / 3); }
  }
}
