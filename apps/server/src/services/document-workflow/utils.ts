import { createHash } from 'node:crypto';

export function stableHash(value: unknown) {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function asObjectArray<T extends object>(value: unknown): T[] {
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object') as T[];
  if (value && typeof value === 'object') return [value as T];
  return [];
}

export function safePlanId(value: string, fallback: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/giu, '-').replace(/^-|-$/gu, '').slice(0, 48);
  return normalized || fallback;
}

export function stringifyFactValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('用户中止');
}
