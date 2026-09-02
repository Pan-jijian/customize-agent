import { createProvider, thinkingCapabilityForModel } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { getConfigStore } from '@/services/common/configService';
import type { DocumentGenerationDiagnostics } from './types';
import { stableHash } from './utils';

const DOCUMENT_LLM_PROVIDER_CACHE = new Map<string, ReturnType<typeof createProvider>>();
let activeDocumentLlmCalls = 0;

// 瞬态重试退避：1200ms 基数 + 0-800ms jitter。全并发架构下批量瞬态失败（429/5xx）会同步重试形成
// 端点风暴，jitter 打散重试相位；上限 2s 仍远小于章节降级链的分钟级代价
const LLM_RETRY_DELAY_BASE_MS = 1200;
const LLM_RETRY_DELAY_JITTER_MS = 800;
// 2.7 服务端过载退避增强：503/overloaded 类错误改指数退避（2s→4s→8s，上限 30s + 0-1s jitter）——
// 过载期固定 1.2-2s 密集重试会加剧服务端压力与排队（实测 503 重试 13 次）；
// 上限 30s 仍远低于章节降级链的分钟级代价；DOCUMENT_LLM_RETRY_BACKOFF=0 回退固定退避
const LLM_OVERLOAD_BACKOFF_BASE_MS = 2000;
const LLM_OVERLOAD_BACKOFF_CAP_MS = 30000;
function isOverloadedLlmError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /503|overloaded|服务繁忙/iu.test(text);
}
/** 重试退避时长（导出供单测）：503/overloaded 指数退避，其余瞬态固定退避 */
export function retryDelayMs(error?: unknown, attempt = 0): number {
  if (process.env.DOCUMENT_LLM_RETRY_BACKOFF !== '0' && error && isOverloadedLlmError(error)) {
    const backoff = Math.min(LLM_OVERLOAD_BACKOFF_CAP_MS, LLM_OVERLOAD_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
    return backoff + Math.floor(Math.random() * 1000);
  }
  return LLM_RETRY_DELAY_BASE_MS + Math.floor(Math.random() * LLM_RETRY_DELAY_JITTER_MS);
}

/**
 * 全局 LLM 并发上限：用户既定决策——LLM 并发调用不应受限制（实测模型端点并发量高，不会因并发限流）。
 * 默认完全解除上限（Number.POSITIVE_INFINITY，所有调用全并发、无排队）；DOCUMENT_LLM_MAX_CONCURRENCY
 * 可显式覆盖（正整数 = 指定上限，0 = 完全解除）。仅瞬态错误重试（429/5xx）保留端点保护语义，与并发上限无关。
 */
const rawMaxConcurrency = Number(process.env.DOCUMENT_LLM_MAX_CONCURRENCY);
const envMaxConcurrency = Number.isFinite(rawMaxConcurrency)
  ? (rawMaxConcurrency === 0 ? Number.POSITIVE_INFINITY : (rawMaxConcurrency > 0 ? Math.floor(rawMaxConcurrency) : undefined))
  : undefined;
let llmMaxConcurrency: number = envMaxConcurrency ?? Number.POSITIVE_INFINITY;

/** 文档目标字数与全局并发上限解耦：所有规模统一使用 llmMaxConcurrency（默认无上限，env 可覆盖） */
export function concurrencyForDocumentScale(_targetWords: number) {
  return llmMaxConcurrency;
}

/** 生成开始时保持并发上限不变（不再按规模降档），仅受 env 强制覆盖约束 */
export function raiseDocumentLlmConcurrencyForScale(_targetWords: number) {
  llmMaxConcurrency = envMaxConcurrency ?? Number.POSITIVE_INFINITY;
  return llmMaxConcurrency;
}
/**
 * 全局连续失败计数：成功清零、失败递增；连续失败≥5 时章节小节并发降级为串行。
 * 阈值从 2 提到 5：偶发失败（单模型瞬时抽风）不应使整体并发塌缩，只有持续性失败才降级。
 */
let llmFailureStreak = 0;

interface LlmSlotWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

const llmSlotQueue: LlmSlotWaiter[] = [];

function acquireLlmSlot(signal?: AbortSignal): Promise<() => void> {
  return new Promise<() => void>((resolve, reject) => {
    if (activeDocumentLlmCalls < llmMaxConcurrency) {
      activeDocumentLlmCalls += 1;
      resolve(releaseLlmSlot);
      return;
    }
    const waiter: LlmSlotWaiter = { resolve, reject, settled: false };
    llmSlotQueue.push(waiter);
    const onAbort = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      const index = llmSlotQueue.indexOf(waiter);
      if (index >= 0) llmSlotQueue.splice(index, 1);
      reject(new Error('用户中止'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function releaseLlmSlot() {
  activeDocumentLlmCalls = Math.max(0, activeDocumentLlmCalls - 1);
  const next = llmSlotQueue.shift();
  if (next && !next.settled) {
    next.settled = true;
    activeDocumentLlmCalls += 1;
    next.resolve(releaseLlmSlot);
  }
}

// P1-3 缓存友好调度（不降并发）：发射窗口内到达的请求按「system + user 稳定段」指纹排序后发射，
// 同前缀请求背靠背发出——服务端按到达顺序串行 prefill，前一个请求写入的 prefix cache 由下一个
// 同前缀请求命中（历史：各章平铺并发下同前缀请求被其他章节请求打散，缓存写入后错过命中窗口）。
// 3.3 窗口自适应：在飞请求 ≥16 时窗口 120ms → 500ms（高并发期到达密度高，宽窗口聚合更多同指纹
// 请求再统一排序发射，命中窗口更大）；低并发保持 120ms 快发射。
// DOCUMENT_PREFIX_SCHEDULE_WINDOW_MS 显式设置时优先（保留覆盖能力，0=关闭调度）。
// 4.17.1 前缀预热（实测驱动的根因修复）：DeepSeek prefix cache 在请求完成后才落盘，
// 并发到达的同前缀请求互相看不到对方的前缀单元 → 实测并发同前缀全部 0% 命中（远端真实生成
// 命中率因此崩到 ~30%）；预热=同指纹家族并发发射前先发 maxTokens=1 的纯前缀轻量请求落盘，
// 实测预热后并发全部命中 94%+。DOCUMENT_PREFIX_WARMUP=0 关闭预热（回退为排序后直接并发发射）。
interface ScheduledLlmLaunch {
  fingerprint: string;
  launch: () => void;
  /** 前缀预热请求（maxTokens=1，内容=共享前缀本体）；仅组内 ≥2 请求且该前缀未预热过时触发 */
  warmup?: () => Promise<void>;
  /** 预热前缀本体 hash：warmed 判定的真实 key（同 fingerprint 跨文档前缀不同，不能按 fingerprint 记预热状态） */
  warmupKey?: string;
}
let scheduleBuffer: ScheduledLlmLaunch[] = [];
let scheduleTimer: NodeJS.Timeout | null = null;
/** 已预热前缀集合（key=前缀本体 hash，进程级；前缀已落盘的家族后续窗口直接并发发射） */
const warmedPrefixKeys = new Set<string>();
function prefixWarmupEnabled() {
  return process.env.DOCUMENT_PREFIX_WARMUP !== '0';
}
const PREFIX_SCHEDULE_DEFAULT_WINDOW_MS = 120;
const PREFIX_SCHEDULE_ADAPTIVE_THRESHOLD = 16;
const PREFIX_SCHEDULE_ADAPTIVE_WINDOW_MS = 500;
const prefixScheduleWindowOverride = (() => {
  const raw = Number(process.env.DOCUMENT_PREFIX_SCHEDULE_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
})();
/** 3.3 调度窗口决策（导出供单测）：显式 env 覆盖优先；否则按在飞请求数自适应（≥16 → 500ms） */
export function prefixScheduleWindowFor(activeCalls: number, override?: number): number {
  if (override !== undefined) return override;
  return activeCalls >= PREFIX_SCHEDULE_ADAPTIVE_THRESHOLD ? PREFIX_SCHEDULE_ADAPTIVE_WINDOW_MS : PREFIX_SCHEDULE_DEFAULT_WINDOW_MS;
}
function currentPrefixScheduleWindowMs(): number {
  return prefixScheduleWindowFor(activeDocumentLlmCalls, prefixScheduleWindowOverride);
}

function schedulePrefixFriendlyLaunch(fingerprint: string, launch: () => void, warmup?: () => Promise<void>, warmupKey?: string) {
  const windowMs = currentPrefixScheduleWindowMs();
  if (windowMs <= 0) {
    launch();
    return;
  }
  scheduleBuffer.push({ fingerprint, launch, warmup, warmupKey });
  if (scheduleTimer) return;
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    const batch = scheduleBuffer;
    scheduleBuffer = [];
    flushScheduledLaunches(batch);
  }, windowMs);
}

/** 窗口攒批发射：指纹排序分组后，组内 ≥2 请求且前缀未预热 → 先预热落盘再并发发射；否则直接并发发射（导出供单测） */
export function flushScheduledLaunches(batch: ScheduledLlmLaunch[]) {
  const ordered = sortScheduledLaunches(batch);
  const groups: ScheduledLlmLaunch[][] = [];
  for (const item of ordered) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.fingerprint === item.fingerprint) last.push(item);
    else groups.push([item]);
  }
  for (const group of groups) {
    const candidate = group.find(item => item.warmup && item.warmupKey);
    const needWarmup = prefixWarmupEnabled()
      && group.length >= 2
      && candidate?.warmup
      && candidate.warmupKey
      && !warmedPrefixKeys.has(candidate.warmupKey);
    if (!needWarmup) {
      for (const item of group) item.launch();
      continue;
    }
    const warmupKey = candidate.warmupKey!;
    warmedPrefixKeys.add(warmupKey);
    void candidate.warmup!()
      .catch(() => {
        // 预热失败（瞬态网络等）：移除预热标记供后续窗口重试；正式请求照常发射，退化为无预热并发
        warmedPrefixKeys.delete(warmupKey);
      })
      .then(() => {
        for (const item of group) item.launch();
      });
  }
}

/** P1-9 失败 streak 隔离：优先取 per-generation diagnostics 的 streak（多文档并发生成互不降级），无 diagnostics 时回退全局值 */
export function getDocumentLlmFailureStreak(diagnostics?: { llm?: { failureStreak?: number } }) {
  return diagnostics?.llm?.failureStreak ?? llmFailureStreak;
}

export function getDocumentLlmMaxConcurrency() {
  return llmMaxConcurrency;
}

export function isTransientLlmError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  // abort/timeout 纳入瞬态：provider 层硬超时（响应头已回但 body 挂起时 AbortSignal.timeout 触发 abort）
  // 属服务端 stall 类瞬态故障，重试一次大概率恢复；用户主动中止已在调用点按 signal.aborted 先行拦截，不受影响
  return /connection error|econnrefused|econnreset|fetch failed|network|socket|eai_again|enotfound|etimedout|429|502|503|504|rate ?limit|too many requests|overloaded|服务繁忙|连接失败|abort|timeout|timed ?out/iu.test(text);
}

/** 上下文超长错误识别（deepseek 输入超窗口返回 400）：供调用方做「缩减输入后降级重试」，
 * 非瞬态不重试的 400 类错误里只有这一类值得重试（缩小输入即可成功）。
 * 另有「JSON 输出被截断」形态（200 响应但输出预算耗尽/输入超长导致生成中断，describeJsonParseFailure
 * 输出的“JSON 被截断（…未闭合…）”）：输入超长为根因时压缩证据降级重试同样有效，一并识别 */
export function isContextOverflowLlmError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /maximum context length|context ?length|context ?window|too many tokens|input.{0,24}too long|prompt.{0,24}too long|请求.{0,16}(超长|过长|超出)|上下文.{0,16}(超长|超出|过长|窗口)/iu.test(text)
    || (/400/u.test(text) && /context|too ?long|token|length|上下文/iu.test(text))
    || /JSON.{0,10}被截断|JSON.{0,10}未闭合/iu.test(text);
}

export function providerFactoryName(providerName: string, providerConfig?: { protocol?: string }) {
  const protocol = resolveProtocol(providerName, providerConfig);
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'google') return 'google';
  if (protocol === 'ollama') return 'ollama';
  if (protocol === 'openrouter') return 'openrouter';
  // deepseek 走专用 Provider：能力声明含真实 8192 输出上限与 reasoning_content 提取，
  // 而非 openai 兼容工厂的 16384 声明（会被官方 API 拒绝）
  if (/deepseek/iu.test(providerName)) return 'deepseek';
  return 'openai';
}

export function getActiveModelWithProvider() {
  const config = getConfigStore().load();
  const activeModel = config.models.reasoning.active || config.models.action.active || config.models.reader.active;
  const selected = [...config.models.reasoning.list, ...config.models.action.list, ...config.models.reader.list].find(model => model.name === activeModel);
  if (!selected) return undefined;
  const providerConfig = config.providers[selected.provider];
  if (!providerConfig) return undefined;
  return { model: selected, provider: providerConfig };
}

/**
 * 任务类型：决定是否要求模型关闭思考（思维链）。
 * - structuredGeneration：受约束的结构化生成/抽取/对照任务（成稿、规划、审查、修复）——
 *   不需要多步推理，质量靠外部 Review→Repair 循环而非内部思维链，要求关思考。
 * - reasoning：需要深度推理的交互场景（聊天、复杂分析）——保持模型默认。
 * callDocumentLlm 是文档生成专用客户端，默认 structuredGeneration。
 */
export type DocumentLlmTaskKind = 'structuredGeneration' | 'reasoning' | 'default';

export interface ThinkingDecision {
  /** 是否向 provider 传 disableThinking（翻译为厂商参数） */
  disableThinking: boolean;
  /** compact=正文独占输出池（maxTokens 直通）；relaxed=思考不可关且共享池，预算放大保正文 */
  budgetMode: 'compact' | 'relaxed';
  /** 模型思考不可关时的告警（写入 diagnostics 供进度展示） */
  warning?: string;
}

/**
 * 任务类型 × 模型思考能力 × 用户偏好 → 思考策略决策（纯函数，供测试覆盖全组合）。
 * 用户偏好（模型配置 thinking 选项）优先级高于任务策略：
 * disabled/enabled 强制覆盖；follow-task（默认）跟随任务策略。
 */
export function decideThinkingPolicy(taskKind: DocumentLlmTaskKind, modelName: string, userPreference?: 'follow-task' | 'enabled' | 'disabled'): ThinkingDecision {
  const capability = thinkingCapabilityForModel(modelName);
  // 用户显式强制关思考：可关模型直接关；不可关模型告警降级（与任务策略一致）
  if (userPreference === 'disabled') {
    if (!capability || capability.disable === 'unsupported') {
      return {
        disableThinking: false,
        budgetMode: capability?.budgetPolicy === 'shared' ? 'relaxed' : 'compact',
        warning: `当前模型 ${modelName} 思考不可关闭（厂商限制），已忽略“强制关闭思考”配置；建议切换 deepseek 或 gpt 系列模型`,
      };
    }
    return { disableThinking: true, budgetMode: 'compact' };
  }
  // 用户显式强制开思考：覆盖任务策略（即使结构化生成也保留思考）
  if (userPreference === 'enabled') return { disableThinking: false, budgetMode: 'compact' };
  if (taskKind !== 'structuredGeneration') return { disableThinking: false, budgetMode: 'compact' };
  // 未注册画像的模型：不注入思考参数（保持厂商默认行为），预算保守直通
  if (!capability) return { disableThinking: false, budgetMode: 'compact' };
  if (capability.disable === 'unsupported') {
    // 思考不可关（如 Gemini 3/3.1 Pro）：shared 池模型正文预算必须放大，separate 池不抢正文只影响耗时
    return {
      disableThinking: false,
      budgetMode: capability.budgetPolicy === 'shared' ? 'relaxed' : 'compact',
      warning: `当前模型 ${modelName} 思考不可关闭（厂商限制），生成耗时受限；建议切换 deepseek 或 gpt 系列模型`,
    };
  }
  return { disableThinking: true, budgetMode: 'compact' };
}

/** 上下文分层键：L0=system 恒定段 / L1=任务级指令 / L2=章级段 / L3=小节级段（3.4 分层统计口径） */
export type ContextLayerKey = 'l0' | 'l1' | 'l2' | 'l3';

/** 调用点各层字符数求和（组装处同源表达式传入；空段自动忽略） */
export function contextLayerChars(parts: Array<string | undefined | false>): number {
  return parts.filter((part): part is string => Boolean(part)).reduce((sum, part) => sum + part.length, 0);
}

/**
 * P1-3 缓存调度指纹：调用方显式 prefixKey（章级/节级缓存分组键）优先——同章各块/各小节请求
 * 共享 L0-L2 前缀，经调度器背靠背发射即可命中；缺省回退旧启发式（system + user 前 2000 字符）。
 * 历史缺陷：写作 prompt 首位是 6101 字符主控提示词，前 2000 字符对所有请求完全相同，
 * 指纹失去区分度 → 调度退化为无序发射 → 章级共享段（L2）设计命中率落空。
 * 提取为纯函数供单测覆盖分组正确性（同 key 聚合/跨 key 隔离/无 key 回退）。
 */
export function llmPrefixFingerprint(system: string, prompt: string, prefixKey?: string): string {
  return prefixKey ? prefixKey : stableHash(`${system}\n${prompt.slice(0, 2000)}`);
}

/** 4.1 per-调用分量观测桶：按 prefixKey 分组惰性创建（无 prefixKey 归入 '(none)'） */
function callBreakdownBucket(diagnostics: DocumentGenerationDiagnostics, prefixKey?: string) {
  const breakdown = diagnostics.llm.callBreakdown ?? (diagnostics.llm.callBreakdown = {});
  const key = prefixKey || '(none)';
  return breakdown[key] ?? (breakdown[key] = { calls: 0, inputChars: 0, l3Chars: 0, cacheHitTokens: 0, cacheMissTokens: 0 });
}

/** 缓存友好发射调度器主体：窗口内收集请求并按指纹排序后按序发射（sort 提取供纯函数单测） */
export function sortScheduledLaunches<T extends { fingerprint: string }>(batch: T[]): T[] {
  return [...batch].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
}

export async function callDocumentLlm(system: string, prompt: string, jsonOnly = false, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; disableThinkingBoost?: boolean; taskKind?: DocumentLlmTaskKind; contextLayers?: Partial<Record<ContextLayerKey, number>>; prefixKey?: string } = {}): Promise<string | undefined> {
  if (options.diagnostics) {
    options.diagnostics.llm.calls += 1;
    // 上下文输入观测：system + user 字符总量 + L0-L3 分层统计（3.4：分层占比供上下文瘦身前后对比验收）
    options.diagnostics.llm.inputChars = (options.diagnostics.llm.inputChars || 0) + system.length + prompt.length;
    // 4.1 per-调用分量观测：按 prefixKey 分组累计 次数/输入字符/L3 字符（cache token 在 usage 成功路径累计）
    const bucket = callBreakdownBucket(options.diagnostics, options.prefixKey);
    bucket.calls += 1;
    bucket.inputChars += system.length + prompt.length;
    bucket.l3Chars += options.contextLayers?.l3 || 0;
    if (options.contextLayers) {
      const layers = options.diagnostics.llm.layerChars ?? (options.diagnostics.llm.layerChars = { l0: 0, l1: 0, l2: 0, l3: 0 });
      layers.l0 += options.contextLayers.l0 || 0;
      layers.l1 += options.contextLayers.l1 || 0;
      layers.l2 += options.contextLayers.l2 || 0;
      layers.l3 += options.contextLayers.l3 || 0;
    } else {
      // P5 可观测：未传 contextLayers 的调用（项目图谱/全局审查/定向修复等）单独累计，
      // 用于归因「分层统计之外」的输入大头——历史缺陷：3719 万字符输入中 478 万字符无法归层
      options.diagnostics.llm.unlayeredChars = (options.diagnostics.llm.unlayeredChars || 0) + system.length + prompt.length;
    }
  }
  const release = await acquireLlmSlot(options.signal);
  if (options.diagnostics) options.diagnostics.llm.maxActive = Math.max(options.diagnostics.llm.maxActive, activeDocumentLlmCalls);
  try {
    const active = getActiveModelWithProvider();
    if (!active) return undefined;
    const { model: selected, provider: providerConfig } = active;
    const providerKey = stableHash({ provider: selected.provider, model: selected.name, baseUrl: providerConfig.baseUrl, directEndpoint: providerConfig.directEndpoint, protocol: providerConfig.protocol, apiKeyHash: providerConfig.apiKey ? stableHash(providerConfig.apiKey) : '' });
    let provider = DOCUMENT_LLM_PROVIDER_CACHE.get(providerKey);
    if (!provider) {
      provider = createProvider(providerFactoryName(selected.provider, providerConfig), { baseUrl: providerConfig.baseUrl, apiKey: providerConfig.apiKey, modelName: selected.name, directEndpoint: providerConfig.directEndpoint });
      DOCUMENT_LLM_PROVIDER_CACHE.set(providerKey, provider);
    }
    const modelName = selected.name.toLowerCase();
    // 任务类型 × 模型思考能力 × 用户配置偏好 → 决策（本客户端文档生成专用，默认 structuredGeneration）
    const decision = decideThinkingPolicy(options.taskKind ?? 'structuredGeneration', modelName, selected.thinking);
    if (decision.warning && options.diagnostics && !options.diagnostics.llm.thinkingWarning) {
      options.diagnostics.llm.thinkingWarning = decision.warning;
    }
    // deepseek 官方 API 输出上限 8192（专用 Provider 已声明）；openai 兼容工厂报告的 16384 对 deepseek 必须收敛
    const rawOutputCap = provider.capabilities?.maxOutputTokens || 8192;
    const outputCap = /deepseek/iu.test(modelName) ? Math.min(rawOutputCap, 8192) : rawOutputCap;
    // 思考关闭后正文独占输出池，maxTokens 直通；仅当思考不可关且与正文共享池（relaxed）时放大预算保正文。
    // disableThinkingBoost 已废弃（思考由 disableThinking 硬关而非预算博弈），保留签名兼容存量调用点。
    const baseMaxTokens = decision.budgetMode === 'relaxed' && options.maxTokens
      ? Math.min(Math.ceil(options.maxTokens * 6), outputCap)
      : options.maxTokens;
    // 空响应标记：推理模型思考阶段耗尽输出预算时 content 可能为空；
    // 严禁把 thinkingContent（模型思维链）当作正文返回，否则思考过程会泄漏进文档
    const EMPTY_CONTENT = Symbol('empty-content');
    const attemptOnce = async (maxTokensArg: number | undefined, thinkingTrimmingHint = false): Promise<string> => {
      if (options.signal?.aborted) throw new Error('用户中止');
      const prefixFingerprint = llmPrefixFingerprint(system, prompt, options.prefixKey);
      // 4.17.1 前缀预热素材：共享前缀 = prompt 截断到 L3 变化段起点（contextLayers.l3 同源口径），
      // system 与正式发射逐字节一致（含 jsonOnly 后缀）；前缀 <500 字符无预热价值（不足 64-token 块粒度收益）
      const warmup = (() => {
        const l3Chars = options.contextLayers?.l3 || 0;
        if (l3Chars <= 0 || l3Chars >= prompt.length) return undefined;
        const warmupSystem = jsonOnly ? `${system}\n只返回 JSON，不要返回 markdown。` : system;
        const warmupPrefix = prompt.slice(0, prompt.length - l3Chars);
        if (warmupPrefix.length < 500) return undefined;
        const warmupKey = stableHash(`${warmupSystem}\n${warmupPrefix}`);
        return {
          warmupKey,
          warmup: () => {
            const bucket = options.diagnostics ? callBreakdownBucket(options.diagnostics, options.prefixKey) : undefined;
            if (bucket) { bucket.calls += 1; bucket.inputChars += warmupSystem.length + warmupPrefix.length; }
            return provider.chat([
              { role: 'system', content: warmupSystem },
              { role: 'user', content: warmupPrefix },
            ], { temperature: 0, maxTokens: 1, signal: options.signal, disableThinking: decision.disableThinking })
              .then(warmResp => {
                if (bucket && warmResp.usage) {
                  bucket.cacheHitTokens += warmResp.usage.promptCacheHitTokens || 0;
                  bucket.cacheMissTokens += warmResp.usage.promptCacheMissTokens || 0;
                }
              })
              .then(() => undefined);
          },
        };
      })();
      const response = await new Promise<Awaited<ReturnType<typeof provider.chat>>>((resolve, reject) => {
        schedulePrefixFriendlyLaunch(prefixFingerprint, () => {
          if (options.signal?.aborted) {
            reject(new Error('用户中止'));
            return;
          }
          provider.chat([
            { role: 'system', content: jsonOnly ? `${system}\n只返回 JSON，不要返回 markdown。` : system },
            { role: 'user', content: thinkingTrimmingHint ? `${prompt}\n\n（重要：缩短思考过程，直接给出最终结论。）` : prompt },
          ], { temperature: options.temperature ?? (jsonOnly ? 0 : 0.3), maxTokens: maxTokensArg, signal: options.signal, disableThinking: decision.disableThinking })
            .then(resolve)
            .catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
        }, warmup?.warmup, warmup?.warmupKey);
      });
      const content = response.content?.trim() ?? '';
      if (content) {
        // usage 指标累计（仅成功路径；失败/空响应无有效 usage 不累计）
        // prompt_cache_hit/miss_tokens 为 DeepSeek prefix cache 指标，用于验证 system/user 分离的缓存收益
        if (options.diagnostics && response.usage) {
          const stats = options.diagnostics.llm;
          stats.inputTokens = (stats.inputTokens || 0) + response.usage.promptTokens;
          stats.outputTokens = (stats.outputTokens || 0) + response.usage.completionTokens;
          stats.promptCacheHitTokens = (stats.promptCacheHitTokens || 0) + (response.usage.promptCacheHitTokens || 0);
          stats.promptCacheMissTokens = (stats.promptCacheMissTokens || 0) + (response.usage.promptCacheMissTokens || 0);
          // 4.1 per-调用分量：缓存命中/未命中 token 同组累计（仅成功路径有有效 usage）
          const bucket = callBreakdownBucket(options.diagnostics, options.prefixKey);
          bucket.cacheHitTokens += response.usage.promptCacheHitTokens || 0;
          bucket.cacheMissTokens += response.usage.promptCacheMissTokens || 0;
          // 推理 token 观测：生成任务要求关闭思考，reasoningTokens>0 说明 disableThinking 未生效
          // （空响应/正文截断类缺陷的根因观测点，4a）
          if (response.usage.reasoningTokens) stats.reasoningTokens = (stats.reasoningTokens || 0) + response.usage.reasoningTokens;
        }
        return content;
      }
      throw EMPTY_CONTENT;
    };
    // 瞬态错误/空响应重试一次：连接失败、限流、5xx 或思考耗尽预算导致的空响应
    // 直接导致章节降级和后续数轮无效修复，秒级重试代价远小于分钟级降级链；成功路径不重试，重试遵守 AbortSignal
    const maxAttempts = 1;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) throw new Error('用户中止');
      try {
        // 空响应重试提示词收敛：输出预算保持不变（放大预算已被实测证伪——思考阶段会同步吃掉新增预算），
        // 改为在用户提示词后追加“缩短思考”指令，把共享输出池让给正文；瞬态错误重试不追加（网络重试与提示词无关）
        const attemptMaxTokens = baseMaxTokens;
        const thinkingTrimmingHint = attempt === 1 && lastError === EMPTY_CONTENT;
        const content = await attemptOnce(attemptMaxTokens, thinkingTrimmingHint);
        llmFailureStreak = 0;
        // P1-9：per-generation streak 同步清零（成功即恢复并发），多文档互不影响
        if (options.diagnostics) options.diagnostics.llm.failureStreak = 0;
        return content;
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) throw new Error('用户中止', { cause: error });
        if ((error !== EMPTY_CONTENT && !isTransientLlmError(error)) || attempt >= maxAttempts) break;
        if (options.diagnostics) options.diagnostics.llm.retries += 1;
        // 2.7：503/overloaded 类错误按重试序指数退避（2s→4s→8s，上限 30s），其余瞬态保持固定退避
        await new Promise<void>(resolve => { setTimeout(resolve, retryDelayMs(error, attempt)); });
      }
    }
    llmFailureStreak += 1;
    if (options.diagnostics) {
      options.diagnostics.llm.failures += 1;
      // P1-9：per-generation streak 同步递增，章节并发降级只作用于本生成任务
      options.diagnostics.llm.failureStreak = (options.diagnostics.llm.failureStreak || 0) + 1;
      options.diagnostics.llm.lastError = lastError instanceof Error ? lastError.message : lastError === EMPTY_CONTENT ? '空响应（思考阶段耗尽输出预算）' : String(lastError);
    }
    return undefined;
  } finally {
    release();
  }
}

export function extractJsonPayload(response: string) {
  const trimmed = response.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1]?.trim();
  if (fenced) return fenced;
  const objectStart = trimmed.indexOf('{');
  const objectEnd = trimmed.lastIndexOf('}');
  const arrayStart = trimmed.indexOf('[');
  const arrayEnd = trimmed.lastIndexOf(']');
  const objectPayload = objectStart >= 0 && objectEnd > objectStart ? trimmed.slice(objectStart, objectEnd + 1) : '';
  const arrayPayload = arrayStart >= 0 && arrayEnd > arrayStart ? trimmed.slice(arrayStart, arrayEnd + 1) : '';
  if (objectPayload && (!arrayPayload || objectStart <= arrayStart)) return objectPayload;
  if (arrayPayload) return arrayPayload;
  return trimmed;
}

/** 轻量 JSON Schema 字段定义（规划/审查/修复类 jsonOnly 调用的输出约束，避免引入重依赖） */
export interface DocumentJsonSchemaField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  /** object 内字段是否必填（缺失即报错） */
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  /** array 元素约束 */
  items?: DocumentJsonSchemaField;
  /** object 子字段约束 */
  properties?: Record<string, DocumentJsonSchemaField>;
}

export interface DocumentJsonSchema {
  type: 'object';
  required?: string[];
  properties: Record<string, DocumentJsonSchemaField>;
}

/** 校验单个值：返回错误明细（含字段路径，如 $.blocks[2].subPoints[0].title），供诊断透传 */
function validateSchemaField(value: unknown, field: DocumentJsonSchemaField, path: string): string[] {
  let actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  // 数字字符串宽容：LLM 结构化输出常把数值写成字符串（如 count:"320"），严格类型检查会拒绝整份
  // 输出并触发重试直至失败（计划数据主表 schema 失败 6 次即此根因）；字符串可无损转 number 时按 number 接受，
  // 数值归一化由消费方（buildPlanDataMaster 等）完成
  if (field.type === 'number' && actualType === 'string') {
    const trimmed = String(value).trim();
    const parsed = Number(trimmed);
    if (trimmed !== '' && Number.isFinite(parsed)) actualType = 'number';
  }
  if (actualType !== field.type) return [`字段 ${path} 类型错误（期望 ${field.type}，得到 ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}）`];
  const errors: string[] = [];
  if (field.type === 'string') {
    const text = value as string;
    if (field.minLength !== undefined && text.length < field.minLength) errors.push(`字段 ${path} 长度不足（期望 ≥${field.minLength}，得到 ${text.length}）`);
    if (field.maxLength !== undefined && text.length > field.maxLength) errors.push(`字段 ${path} 长度超限（期望 ≤${field.maxLength}，得到 ${text.length}）`);
  } else if (field.type === 'array') {
    const items = value as unknown[];
    if (field.minItems !== undefined && items.length < field.minItems) errors.push(`字段 ${path} 条数不足（期望 ≥${field.minItems}，得到 ${items.length}）`);
    if (field.maxItems !== undefined && items.length > field.maxItems) errors.push(`字段 ${path} 条数超限（期望 ≤${field.maxItems}，得到 ${items.length}）`);
    if (field.items) items.forEach((item, index) => errors.push(...validateSchemaField(item, field.items as DocumentJsonSchemaField, `${path}[${index}]`)));
  } else if (field.type === 'object' && field.properties) {
    const record = value as Record<string, unknown>;
    for (const [key, subField] of Object.entries(field.properties)) {
      const subValue = record[key];
      if (subValue === undefined) {
        if (subField.required) errors.push(`缺失字段 ${path}.${key}`);
        continue;
      }
      errors.push(...validateSchemaField(subValue, subField, `${path}.${key}`));
    }
  }
  return errors;
}

/** 顶层对象校验：必填字段缺失 + 属性约束，错误上限 6 条防止日志爆炸 */
export function validateJsonAgainstSchema(value: unknown, schema: DocumentJsonSchema): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`根节点类型错误（期望 object，得到 ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}）`];
  }
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of schema.required || []) {
    if (!(key in record)) errors.push(`缺失字段 $.${key}`);
  }
  for (const [key, field] of Object.entries(schema.properties)) {
    const fieldValue = record[key];
    if (fieldValue === undefined) {
      if (field.required) errors.push(`缺失字段 $.${key}`);
      continue;
    }
    errors.push(...validateSchemaField(fieldValue, field, `$.${key}`));
  }
  return errors.slice(0, 6);
}

/** JSON 截断特征探测：未闭合括号/引号 + 响应末段，用于解析失败诊断（截断位置） */
export function describeJsonParseFailure(raw: string): string {
  const payload = extractJsonPayload(raw);
  const openBraces = (payload.match(/\{/gu) || []).length - (payload.match(/\}/gu) || []).length;
  const openBrackets = (payload.match(/\[/gu) || []).length - (payload.match(/\]/gu) || []).length;
  const tail = payload.slice(-80).replace(/\s+/gu, ' ');
  if (openBraces > 0 || openBrackets > 0) return `JSON 被截断（{ 未闭合 ${openBraces} 个、[ 未闭合 ${openBrackets} 个），截断位置响应末段：${tail}`;
  return `JSON 语法错误，出错位置响应末段：${tail}`;
}

/**
 * P1-4 截断 JSON 确定性修复：maxTokens 截断（历史 32 次 schema 失败的主要形态）时，
 * 回退到最后一个「完整元素」边界（该层级最后逗号前）并补齐闭合括号，使 JSON.parse 成功，
 * 避免整轮重试（截断丢掉的残缺尾部元素由上层覆盖校验/门禁兜底）；
 * 修复产物解析失败或边界不存在（首元素即残缺）返回 undefined，交由重试循环兜底，不做语法猜测
 */
export function repairTruncatedJson(raw: string): string | undefined {
  // 剥离 fenced 包裹后从首个 { 或 [ 开始扫描；截断 JSON 末尾本就没有闭合括号，
  // 不能用 extractJsonPayload 的 lastIndexOf('}') 截断——那会丢掉截断信息
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1]?.trim();
  const body = fenced ?? trimmed;
  const braceStart = body.indexOf('{');
  const bracketStart = body.indexOf('[');
  const startIndex = braceStart < 0 ? bracketStart : bracketStart < 0 ? braceStart : Math.min(braceStart, bracketStart);
  if (startIndex < 0) return undefined;
  const jsonish = body.slice(startIndex);
  const stack: Array<'object' | 'array'> = [];
  let inString = false;
  let escaped = false;
  // 各容器层级的最后一个完整元素逗号位置（该层级已写入至少一个完整值）
  const lastCommaByDepth: number[] = [];
  for (let i = 0; i < jsonish.length; i += 1) {
    const ch = jsonish[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? 'object' : 'array');
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      continue;
    }
    if (ch === ',') lastCommaByDepth[stack.length - 1] = i;
  }
  if (stack.length === 0) return undefined;
  // 修复边界 = 最深的有完整元素的层级；首元素残缺（截断发生在第一个值中间）无安全边界
  let cutDepth = -1;
  for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
    if (lastCommaByDepth[depth] !== undefined) { cutDepth = depth; break; }
  }
  if (cutDepth < 0) return undefined;
  const cut = lastCommaByDepth[cutDepth];
  const head = jsonish.slice(0, cut);
  // 需闭合的容器：从最外层到 cutDepth 层（cut 逗号位于 cutDepth 层容器内，该层及其外层容器
  // 均未闭合；更深层容器在 cut 前已闭合，残缺尾部元素整体丢弃无需闭合）
  const closers: string[] = [];
  for (let depth = cutDepth; depth >= 0; depth -= 1) {
    closers.push(stack[depth] === 'object' ? '}' : ']');
  }
  const repaired = `${head}${closers.join('')}`;
  try {
    JSON.parse(repaired);
    return repaired;
  } catch {
    return undefined;
  }
}

/** schema 校验失败记录：写入 diagnostics 供进度展示与测试断言（lastError 覆盖为可诊断原因） */
function recordJsonValidationFailure(diagnostics: DocumentGenerationDiagnostics | undefined, message: string) {
  if (!diagnostics) return;
  diagnostics.llm.schemaFailures = (diagnostics.llm.schemaFailures || 0) + 1;
  diagnostics.llm.lastError = message;
}

/** F1 重试循环核心：JSON 解析/schema 校验失败重试（失败原因回注提示词），重试上限内仍失败才放弃。
 * invokeLlm 可注入（单测注入 mock，生产绑定 callDocumentLlm）——模块内部词法绑定无法被 vi.mock 拦截 */
/**
 * 截断类失败重试时的 maxTokens 放大系数（1.5 倍向上取整，缺省按 2000 基准）：
 * JSON 截断根因多为 token 上限不足，同额度重试必再截断；独立纯函数便于单测观测放大逻辑
 */
export function amplifiedTruncationMaxTokens(current?: number): number {
  return Math.ceil((current || 2000) * 1.5);
}

export async function callDocumentLlmJsonWithRetry<T>(system: string, prompt: string, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; schema?: DocumentJsonSchema; disableThinkingBoost?: boolean; taskKind?: DocumentLlmTaskKind; outFailure?: { value?: string }; contextLayers?: Partial<Record<ContextLayerKey, number>>; prefixKey?: string } = {}, invokeLlm?: (attemptSystem: string, attemptPrompt: string) => Promise<string | undefined>): Promise<T | undefined> {
  // 历史缺陷：规划/审查/修复类 jsonOnly 调用一次失败即放弃，造成章节降级与后续数轮无效修复；
  // 失败原因回注提示词让模型收敛，秒级重试代价远小于分钟级降级链。
  // 4.12.12 收敛：JSON 截断类失败重试时放大 maxTokens（截断根因多为 token 上限不足，同额度重试必再截断——
  // 实测 schema 校验失败 30 次主要来自截断输出）；重试次数 1 → 2，每次重试附上次失败原因
  const maxJsonAttempts = 2;
  let lastFailure: string | undefined;
  let retryMaxTokens = options.maxTokens;
  const invoke = invokeLlm ?? ((attemptSystem: string, attemptPrompt: string) => callDocumentLlm(attemptSystem, attemptPrompt, true, { maxTokens: retryMaxTokens, temperature: options.temperature, signal: options.signal, diagnostics: options.diagnostics, disableThinkingBoost: options.disableThinkingBoost, taskKind: options.taskKind, contextLayers: options.contextLayers, prefixKey: options.prefixKey }));
  for (let attempt = 0; attempt <= maxJsonAttempts; attempt += 1) {
    if (options.signal?.aborted) return undefined;
    const attemptPrompt = attempt === 0 ? prompt : `${prompt}\n\n（重试修正：上一次输出未通过——${lastFailure ?? '输出无效'}。请重新输出完整合法的 JSON，只返回 JSON。）`;
    const response = await invoke(system, attemptPrompt);
    if (!response) {
      // 空响应/网络失败：原因由 callDocumentLlm 写入 diagnostics.llm.lastError，经 outFailure 带出供调用方定位
      if (options.outFailure && options.diagnostics?.llm.lastError) options.outFailure.value = options.diagnostics.llm.lastError;
      return undefined;
    }
    const payload = extractJsonPayload(response);
    try {
      const parsed = JSON.parse(payload) as T;
      if (options.schema) {
        const errors = validateJsonAgainstSchema(parsed, options.schema);
        if (errors.length > 0) {
          const message = `JSON Schema 校验失败：${errors.join('；')}`;
          lastFailure = message;
          recordJsonValidationFailure(options.diagnostics, message);
          // 缺失字段类失败同样多为输出长度压力（模型为压预算省略字段），放大 maxTokens 重试
          //（历史缺陷：只对「JSON 被截断」放大，缺失字段类同额度重试仍缺字段，主表 6 次失败即此）
          if (message.includes('缺失字段')) retryMaxTokens = amplifiedTruncationMaxTokens(retryMaxTokens);
          if (attempt >= maxJsonAttempts) {
            if (options.outFailure) options.outFailure.value = message;
            return undefined;
          }
          continue;
        }
      }
      return parsed;
    } catch {
      // P1-4：截断类失败先做确定性修复（回退到最后一个完整元素边界并补齐闭合括号），
      // 修复成功按修复产物走 schema 校验并直接返回，避免整轮重试（截断丢掉的残缺尾部
      // 元素由上层覆盖校验/门禁兜底）；修复失败仍走下方失败原因回注重试。
      // 注意用原始响应而非 extractJsonPayload 结果：后者 lastIndexOf('}') 截断会丢掉截断信息
      const repairedPayload = repairTruncatedJson(response);
      if (repairedPayload) {
        try {
          const repairedParsed = JSON.parse(repairedPayload) as T;
          if (options.schema) {
            const repairErrors = validateJsonAgainstSchema(repairedParsed, options.schema);
            if (repairErrors.length === 0) return repairedParsed;
            // 截断修复产物不满足 schema（如数组元素数不足）：按 schema 失败走重试
            const repairMessage = `JSON Schema 校验失败：${repairErrors.join('；')}`;
            lastFailure = repairMessage;
            recordJsonValidationFailure(options.diagnostics, repairMessage);
            if (repairMessage.includes('缺失字段')) retryMaxTokens = amplifiedTruncationMaxTokens(retryMaxTokens);
            if (attempt >= maxJsonAttempts) {
              if (options.outFailure) options.outFailure.value = repairMessage;
              return undefined;
            }
            continue;
          }
          return repairedParsed;
        } catch {
          // 修复产物仍非法：落入下方原解析失败处理
        }
      }
      const message = `JSON 解析失败：${describeJsonParseFailure(payload)}`;
      lastFailure = message;
      // 截断类失败：重试放大 maxTokens（默认调用闭包读取 retryMaxTokens），否则同额度重试必再截断
      if (/JSON 被截断/u.test(message)) {
        retryMaxTokens = amplifiedTruncationMaxTokens(retryMaxTokens);
      }
      recordJsonValidationFailure(options.diagnostics, message);
      if (attempt >= maxJsonAttempts) {
        if (options.outFailure) options.outFailure.value = message;
        return undefined;
      }
      continue;
    }
  }
  return undefined;
}

export async function callDocumentLlmJson<T>(system: string, prompt: string, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; schema?: DocumentJsonSchema; disableThinkingBoost?: boolean; taskKind?: DocumentLlmTaskKind; outFailure?: { value?: string }; contextLayers?: Partial<Record<ContextLayerKey, number>>; prefixKey?: string } = {}): Promise<T | undefined> {
  return callDocumentLlmJsonWithRetry(system, prompt, options);
}
