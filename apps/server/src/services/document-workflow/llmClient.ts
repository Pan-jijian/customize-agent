import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { getConfigStore } from '@/services/common/configService';
import type { DocumentGenerationDiagnostics } from './types';
import { stableHash } from './utils';

const DOCUMENT_LLM_PROVIDER_CACHE = new Map<string, ReturnType<typeof createProvider>>();
let activeDocumentLlmCalls = 0;

const LLM_RETRY_DELAY_MS = 1200;

/** 全局 LLM 并发上限：避免多文档 × 多章节 × 多小节同时打爆模型端点（默认 8，可用 DOCUMENT_LLM_MAX_CONCURRENCY 覆盖） */
const rawMaxConcurrency = Number(process.env.DOCUMENT_LLM_MAX_CONCURRENCY);
const envMaxConcurrency = Number.isFinite(rawMaxConcurrency) && rawMaxConcurrency > 0 ? Math.floor(rawMaxConcurrency) : undefined;
let llmMaxConcurrency = envMaxConcurrency ?? 8;

/** 按文档目标字数计算全局并发档位：文档越大调用越多，并发上限越高；20 万字级文档走 32 档 */
export function concurrencyForDocumentScale(targetWords: number) {
  if (targetWords <= 20000) return 8;
  if (targetWords <= 80000) return 16;
  if (targetWords <= 150000) return 24;
  return 32;
}

/** 生成开始时按文档规模提升全局并发上限（只升不降：多文档并发生成互不踩踏；上限始终受 env 强制覆盖约束） */
export function raiseDocumentLlmConcurrencyForScale(targetWords: number) {
  const scaled = concurrencyForDocumentScale(targetWords);
  const ceiling = envMaxConcurrency ?? scaled;
  llmMaxConcurrency = Math.max(llmMaxConcurrency, Math.min(scaled, ceiling));
  return llmMaxConcurrency;
}
/** 全局连续失败计数：成功清零、失败递增；连续失败≥2 时章节小节并发降级为串行，避免失败率高的模型被无脑并发反复击穿 */
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

function isTransientLlmError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /connection error|econnrefused|econnreset|fetch failed|network|socket|eai_again|enotfound|etimedout|429|502|503|504|rate ?limit|too many requests|overloaded|服务繁忙|连接失败/iu.test(text);
}

export function providerFactoryName(providerName: string, providerConfig?: { protocol?: string }) {
  const protocol = resolveProtocol(providerName, providerConfig);
  if (protocol === 'anthropic') return 'anthropic';
  if (protocol === 'google') return 'google';
  if (protocol === 'ollama') return 'ollama';
  if (protocol === 'openrouter') return 'openrouter';
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

export async function callDocumentLlm(system: string, prompt: string, jsonOnly = false, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; disableThinkingBoost?: boolean } = {}): Promise<string | undefined> {
  if (options.diagnostics) options.diagnostics.llm.calls += 1;
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
    // reasoning 模型（deepseek-v4-pro 等）思考阶段与正文共享 max_tokens 预算，实测思考占 70%+，
    // 预算不足会导致 content 为空、整节生成被当作空响应丢弃；对声明 supportsThinking 的模型放大输出预算。
    // 经 openai 协议接入的 deepseek 推理模型工厂能力位是 false，需按模型名模式补充识别
    const modelName = selected.name.toLowerCase();
    const thinkingModel = provider.capabilities?.supportsThinking === true
      || /reasoning|thinking|reasoner|deepseek.*pro|o[1-9]|^r[1-9]/iu.test(modelName);
    // deepseek 官方 API 输出上限为 8192，openai 兼容工厂报告的 16384 必须收敛，否则会被 API 拒绝
    const rawOutputCap = provider.capabilities?.maxOutputTokens || 8192;
    const outputCap = /deepseek/iu.test(modelName) ? Math.min(rawOutputCap, 8192) : rawOutputCap;
    // disableThinkingBoost（p3-s2）：小步化调用（如主题块成稿）按目标字数 1:1.2 直接设定输出预算，不再 ×6 放大——
    // 小预算强制模型缩短思考，把共享输出池让给正文；×6 放大只保留给整章级大调用
    const baseMaxTokens = thinkingModel && options.maxTokens && !options.disableThinkingBoost
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
      ], { temperature: options.temperature ?? (jsonOnly ? 0 : 0.3), maxTokens: maxTokensArg, signal: options.signal });
      const content = response.content?.trim() ?? '';
      if (content) return content;
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
        await new Promise<void>(resolve => { setTimeout(resolve, LLM_RETRY_DELAY_MS); });
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

export async function callDocumentLlmJson<T>(system: string, prompt: string, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; schema?: DocumentJsonSchema; disableThinkingBoost?: boolean; outFailure?: { value?: string } } = {}): Promise<T | undefined> {
  const response = await callDocumentLlm(system, prompt, true, { maxTokens: options.maxTokens, temperature: options.temperature, signal: options.signal, diagnostics: options.diagnostics, disableThinkingBoost: options.disableThinkingBoost });
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
        recordJsonValidationFailure(options.diagnostics, message);
        if (options.outFailure) options.outFailure.value = message;
        return undefined;
      }
    }
    return parsed;
  } catch {
    const message = `JSON 解析失败：${describeJsonParseFailure(payload)}`;
    recordJsonValidationFailure(options.diagnostics, message);
    if (options.outFailure) options.outFailure.value = message;
    return undefined;
  }
}
