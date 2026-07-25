import { createProvider } from '@customize-agent/llm';
import { resolveProtocol } from '@customize-agent/runtime';
import { getConfigStore } from '@/services/common/configService';
import type { DocumentGenerationDiagnostics } from './types';
import { stableHash } from './utils';

const DOCUMENT_LLM_PROVIDER_CACHE = new Map<string, ReturnType<typeof createProvider>>();
let activeDocumentLlmCalls = 0;

function configuredDocumentLlmLimit() {
  const raw = process.env.DOCUMENT_LLM_CONCURRENCY;
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

let adaptiveDocumentLlmLimit: number | undefined = configuredDocumentLlmLimit();
let documentLlmFailureStreak = 0;
interface PendingDocumentLlmWaiter { resolve: () => void; reject: (error: Error) => void; active: boolean; onAbort?: () => void; signal?: AbortSignal }
const pendingDocumentLlmResolvers: PendingDocumentLlmWaiter[] = [];

export function getAdaptiveDocumentLlmLimit() {
  return adaptiveDocumentLlmLimit ?? 0;
}

export function limitAdaptiveDocumentLlmLimit(limit: number) {
  if (adaptiveDocumentLlmLimit === undefined || !Number.isFinite(limit) || limit <= 0) return getAdaptiveDocumentLlmLimit();
  adaptiveDocumentLlmLimit = Math.min(adaptiveDocumentLlmLimit, Math.floor(limit));
  return getAdaptiveDocumentLlmLimit();
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

function tuneDocumentLlmConcurrency(success: boolean, diagnostics?: DocumentGenerationDiagnostics) {
  const configured = configuredDocumentLlmLimit();
  const before = adaptiveDocumentLlmLimit;
  if (configured === undefined || adaptiveDocumentLlmLimit === undefined) {
    documentLlmFailureStreak = success ? 0 : documentLlmFailureStreak + 1;
    if (diagnostics) diagnostics.llm.currentLimit = 0;
    return;
  }
  if (!success) {
    documentLlmFailureStreak += 1;
    if (documentLlmFailureStreak >= 2) adaptiveDocumentLlmLimit = Math.max(1, adaptiveDocumentLlmLimit - 1);
  } else {
    documentLlmFailureStreak = 0;
    if (pendingDocumentLlmResolvers.length === 0 && adaptiveDocumentLlmLimit < configured) adaptiveDocumentLlmLimit += 1;
  }
  if (diagnostics) {
    diagnostics.llm.currentLimit = adaptiveDocumentLlmLimit;
    if (before !== adaptiveDocumentLlmLimit) diagnostics.llm.limitAdjustments += 1;
  }
}

function wakeNextDocumentLlmWaiter() {
  while (pendingDocumentLlmResolvers.length > 0) {
    const waiter = pendingDocumentLlmResolvers.shift();
    if (!waiter?.active) continue;
    waiter.active = false;
    waiter.signal?.removeEventListener('abort', waiter.onAbort || (() => undefined));
    waiter.resolve();
    break;
  }
}

async function withDocumentLlmSlot<T>(run: () => Promise<T>, signal?: AbortSignal, diagnostics?: DocumentGenerationDiagnostics) {
  while (adaptiveDocumentLlmLimit !== undefined && activeDocumentLlmCalls >= adaptiveDocumentLlmLimit) {
    const waitStartedAt = Date.now();
    if (diagnostics) diagnostics.llm.throttledWaits += 1;
    if (signal?.aborted) throw new Error('用户中止');
    await new Promise<void>((resolve, reject) => {
      const waiter: PendingDocumentLlmWaiter = { resolve, reject, active: true, signal };
      waiter.onAbort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = pendingDocumentLlmResolvers.indexOf(waiter);
        if (index >= 0) pendingDocumentLlmResolvers.splice(index, 1);
        reject(new Error('用户中止'));
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      pendingDocumentLlmResolvers.push(waiter);
    });
    if (diagnostics) diagnostics.llm.throttledWaitMs += Date.now() - waitStartedAt;
  }
  activeDocumentLlmCalls += 1;
  if (diagnostics) diagnostics.llm.maxActive = Math.max(diagnostics.llm.maxActive, activeDocumentLlmCalls);
  try {
    const result = await run();
    tuneDocumentLlmConcurrency(true, diagnostics);
    return result;
  } catch (error) {
    tuneDocumentLlmConcurrency(false, diagnostics);
    throw error;
  } finally {
    activeDocumentLlmCalls = Math.max(0, activeDocumentLlmCalls - 1);
    wakeNextDocumentLlmWaiter();
  }
}

export async function callDocumentLlm(system: string, prompt: string, jsonOnly = false, options: { maxTokens?: number; temperature?: number; signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {}): Promise<string | undefined> {
  if (options.diagnostics) options.diagnostics.llm.calls += 1;
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
    const hardTimeoutMs = Math.max(30_000, Number(process.env.DOCUMENT_LLM_CALL_TIMEOUT_MS ?? 300_000));
    const response = await withDocumentLlmSlot(() => {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('LLM 调用超时')), hardTimeoutMs);
      });
      let abortListener: (() => void) | undefined;
      const raceItems: Array<Promise<Awaited<ReturnType<typeof provider.chat>>>> = [
        provider.chat([
          { role: 'system', content: jsonOnly ? `${system}
只返回 JSON，不要返回 markdown。` : system },
          { role: 'user', content: prompt },
        ], { temperature: options.temperature ?? (jsonOnly ? 0 : 0.3), maxTokens: options.maxTokens, signal: options.signal }),
        timeoutPromise,
      ];
      if (options.signal) {
        raceItems.push(new Promise<never>((_, reject) => {
          if (options.signal?.aborted) { reject(new Error('用户中止')); return; }
          abortListener = () => reject(new Error('用户中止'));
          options.signal?.addEventListener('abort', abortListener, { once: true });
        }));
      }
      return Promise.race(raceItems).finally(() => {
        if (timer) clearTimeout(timer);
        if (abortListener) options.signal?.removeEventListener('abort', abortListener);
      });
    }, options.signal, options.diagnostics);
    return response.content.trim();
  } catch (error) {
    if (options.diagnostics) options.diagnostics.llm.failures += 1;
    if (options.signal?.aborted) throw new Error('用户中止', { cause: error });
    return undefined;
  }
}

export async function callWithTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parentSignal?: AbortSignal): Promise<T | null> {
  const controller = new AbortController();
  if (parentSignal?.aborted) throw new Error('用户中止');
  const abort = () => controller.abort();
  parentSignal?.addEventListener('abort', abort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const raceItems: Array<Promise<T | null>> = [Promise.resolve().then(() => run(controller.signal)), timeoutPromise];
  if (parentSignal) {
    raceItems.push(new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        if (parentSignal.aborted) reject(new Error('用户中止'));
      }, { once: true });
    }));
  }
  try {
    const result = await Promise.race(raceItems);
    if (parentSignal?.aborted) throw new Error('用户中止');
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
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
