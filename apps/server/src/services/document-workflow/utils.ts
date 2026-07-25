import { createHash } from 'node:crypto';
import { MAX_DOCUMENT_CACHE_ITEMS } from './constants';

export function stableHash(value: unknown) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

export function setLimitedCache<T>(cache: Map<string, T>, key: string, value: T) {
  if (cache.size >= MAX_DOCUMENT_CACHE_ITEMS) cache.delete(cache.keys().next().value as string);
  cache.set(key, value);
}

export function safePlanId(input: string, fallback: string) {
  return (input || fallback).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/gu, '-').slice(0, 80) || fallback;
}

export function stringifyFactValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(item => stringifyFactValue(item)).filter(Boolean).join('；');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}：${stringifyFactValue(item)}`)
      .filter(Boolean)
      .join('；');
  }
  return String(value);
}

export function asObjectArray<T extends Record<string, unknown>>(value: unknown): T[] {
  if (Array.isArray(value)) return value.filter((item): item is T => !!item && typeof item === 'object' && !Array.isArray(item));
  if (value && typeof value === 'object') return Object.values(value).filter((item): item is T => !!item && typeof item === 'object' && !Array.isArray(item));
  return [];
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => stringifyFactValue(item).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[；;\n]/u).map(item => item.trim()).filter(Boolean);
  return [];
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('用户中止');
}
