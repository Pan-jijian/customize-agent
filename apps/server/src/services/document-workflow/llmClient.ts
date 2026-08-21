import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { getConfigStore } from '@/services/common/configService';
import type { DocumentGenerationDiagnostics } from './types';
import { stableHash } from './utils';

const DOCUMENT_LLM_PROVIDER_CACHE = new Map<string, ReturnType<typeof createProvider>>();
let activeDocumentLlmCalls = 0;

const LLM_RETRY_DELAY_MS = 1200;

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
  activeDocumentLlmCalls += 1;
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
    const attemptOnce = async (): Promise<string> => {
      if (options.signal?.aborted) throw new Error('用户中止');
      const response = await provider.chat([
        { role: 'system', content: jsonOnly ? `${system}\n只返回 JSON，不要返回 markdown。` : system },
        { role: 'user', content: prompt },
      ], { temperature: options.temperature ?? (jsonOnly ? 0 : 0.3), maxTokens: options.maxTokens, signal: options.signal });
      return response.content.trim();
    };
    // 瞬态错误重试一次：连接失败/限流/5xx 等快速失败的错误直接导致章节降级和后续数轮无效修复，
    // 秒级重试代价远小于分钟级降级链；成功路径不重试，重试遵守 AbortSignal
    const maxAttempts = 1;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      if (options.signal?.aborted) throw new Error('用户中止');
      try {
        return await attemptOnce();
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) throw new Error('用户中止', { cause: error });
        if (!isTransientLlmError(error) || attempt >= maxAttempts) break;
        if (options.diagnostics) options.diagnostics.llm.retries += 1;
        await new Promise<void>(resolve => { setTimeout(resolve, LLM_RETRY_DELAY_MS); });
      }
    }
    if (options.diagnostics) {
      options.diagnostics.llm.failures += 1;
      options.diagnostics.llm.lastError = lastError instanceof Error ? lastError.message : String(lastError);
    }
    return undefined;
  } finally {
    activeDocumentLlmCalls = Math.max(0, activeDocumentLlmCalls - 1);
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
