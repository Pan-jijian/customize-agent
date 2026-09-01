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
function retryDelayMs(): number {
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

export async function callDocumentLlm(system: string, prompt: string, jsonOnly = false, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; disableThinkingBoost?: boolean; taskKind?: DocumentLlmTaskKind; contextLayers?: Partial<Record<ContextLayerKey, number>> } = {}): Promise<string | undefined> {
  if (options.diagnostics) {
    options.diagnostics.llm.calls += 1;
    // 上下文输入观测：system + user 字符总量 + L0-L3 分层统计（3.4：分层占比供上下文瘦身前后对比验收）
    options.diagnostics.llm.inputChars = (options.diagnostics.llm.inputChars || 0) + system.length + prompt.length;
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
      const response = await provider.chat([
        { role: 'system', content: jsonOnly ? `${system}\n只返回 JSON，不要返回 markdown。` : system },
        { role: 'user', content: thinkingTrimmingHint ? `${prompt}\n\n（重要：缩短思考过程，直接给出最终结论。）` : prompt },
      ], { temperature: options.temperature ?? (jsonOnly ? 0 : 0.3), maxTokens: maxTokensArg, signal: options.signal, disableThinking: decision.disableThinking });
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
        await new Promise<void>(resolve => { setTimeout(resolve, retryDelayMs()); });
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
  const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (actualType !== field.type) return [`字段 ${path} 类型错误（期望 ${field.type}，得到 ${actualType}）`];
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

export async function callDocumentLlmJsonWithRetry<T>(system: string, prompt: string, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; schema?: DocumentJsonSchema; disableThinkingBoost?: boolean; taskKind?: DocumentLlmTaskKind; outFailure?: { value?: string }; contextLayers?: Partial<Record<ContextLayerKey, number>> } = {}, invokeLlm?: (attemptSystem: string, attemptPrompt: string) => Promise<string | undefined>): Promise<T | undefined> {
  // 历史缺陷：规划/审查/修复类 jsonOnly 调用一次失败即放弃，造成章节降级与后续数轮无效修复；
  // 失败原因回注提示词让模型收敛，秒级重试代价远小于分钟级降级链。
  // 4.12.12 收敛：JSON 截断类失败重试时放大 maxTokens（截断根因多为 token 上限不足，同额度重试必再截断——
  // 实测 schema 校验失败 30 次主要来自截断输出）；重试次数 1 → 2，每次重试附上次失败原因
  const maxJsonAttempts = 2;
  let lastFailure: string | undefined;
  let retryMaxTokens = options.maxTokens;
  const invoke = invokeLlm ?? ((attemptSystem: string, attemptPrompt: string) => callDocumentLlm(attemptSystem, attemptPrompt, true, { maxTokens: retryMaxTokens, temperature: options.temperature, signal: options.signal, diagnostics: options.diagnostics, disableThinkingBoost: options.disableThinkingBoost, taskKind: options.taskKind, contextLayers: options.contextLayers }));
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
          if (attempt >= maxJsonAttempts) {
            if (options.outFailure) options.outFailure.value = message;
            return undefined;
          }
          continue;
        }
      }
      return parsed;
    } catch {
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

export async function callDocumentLlmJson<T>(system: string, prompt: string, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; schema?: DocumentJsonSchema; disableThinkingBoost?: boolean; taskKind?: DocumentLlmTaskKind; outFailure?: { value?: string }; contextLayers?: Partial<Record<ContextLayerKey, number>> } = {}): Promise<T | undefined> {
  return callDocumentLlmJsonWithRetry(system, prompt, options);
}
