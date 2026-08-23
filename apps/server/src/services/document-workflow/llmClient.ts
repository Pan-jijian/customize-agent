import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { getConfigStore } from '@/services/common/configService';
import type { DocumentGenerationDiagnostics } from './types';
import { stableHash } from './utils';

const DOCUMENT_LLM_PROVIDER_CACHE = new Map<string, ReturnType<typeof createProvider>>();
let activeDocumentLlmCalls = 0;

const LLM_RETRY_DELAY_MS = 1200;

/** 全局 LLM 并发上限：避免多文档 × 多章节 × 多小节同时打爆模型端点（默认 4，可用 DOCUMENT_LLM_MAX_CONCURRENCY 覆盖） */
const rawMaxConcurrency = Number(process.env.DOCUMENT_LLM_MAX_CONCURRENCY);
const llmMaxConcurrency = Number.isFinite(rawMaxConcurrency) && rawMaxConcurrency > 0 ? Math.floor(rawMaxConcurrency) : 4;
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

export function getDocumentLlmFailureStreak() {
  return llmFailureStreak;
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

export async function callDocumentLlm(system: string, prompt: string, jsonOnly = false, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {}): Promise<string | undefined> {
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
    const baseMaxTokens = thinkingModel && options.maxTokens
      ? Math.min(Math.ceil(options.maxTokens * 6), outputCap)
      : options.maxTokens;
    // 空响应标记：推理模型思考阶段耗尽输出预算时 content 可能为空；
    // 严禁把 thinkingContent（模型思维链）当作正文返回，否则思考过程会泄漏进文档
    const EMPTY_CONTENT = Symbol('empty-content');
    const attemptOnce = async (maxTokensArg: number | undefined): Promise<string> => {
      if (options.signal?.aborted) throw new Error('用户中止');
      const response = await provider.chat([
        { role: 'system', content: jsonOnly ? `${system}\n只返回 JSON，不要返回 markdown。` : system },
        { role: 'user', content: prompt },
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
        // 空响应重试时把输出预算提升到模型上限，给思考阶段与正文留足空间
        const attemptMaxTokens = attempt === 0 ? baseMaxTokens : (thinkingModel ? outputCap : baseMaxTokens);
        const content = await attemptOnce(attemptMaxTokens);
        llmFailureStreak = 0;
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
      options.diagnostics.llm.lastError = lastError instanceof Error ? lastError.message : lastError === EMPTY_CONTENT ? '空响应（思考阶段耗尽输出预算）' : String(lastError);
    }
    return undefined;
  } finally {
    release();
  }
}

function extractJsonPayload(response: string) {
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

export async function callDocumentLlmJson<T>(system: string, prompt: string, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {}): Promise<T | undefined> {
  const response = await callDocumentLlm(system, prompt, true, { maxTokens: options.maxTokens, temperature: options.temperature, signal: options.signal, diagnostics: options.diagnostics });
  if (!response) return undefined;
  try {
    return JSON.parse(extractJsonPayload(response)) as T;
  } catch {
    return undefined;
  }
}
