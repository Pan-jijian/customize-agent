import { describe, it, expect, vi } from 'vitest';
import { withRetry, isRetryableError } from '../src/retry.js';

describe('isRetryableError', () => {
  it('5xx 状态码应可重试', () => {
    expect(isRetryableError(new Error('status 500'))).toBe(true);
    expect(isRetryableError(new Error('status 502'))).toBe(true);
    expect(isRetryableError(new Error('status 503'))).toBe(true);
    expect(isRetryableError(new Error('status 504'))).toBe(true);
  });

  it('429 rate limit 应可重试', () => {
    expect(isRetryableError(new Error('status 429'))).toBe(true);
  });

  it('408 timeout 应可重试', () => {
    expect(isRetryableError(new Error('status 408'))).toBe(true);
  });

  it('网络错误应可重试', () => {
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryableError(new Error('network error'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
  });

  it('400 错误不应重试', () => {
    expect(isRetryableError(new Error('status 400'))).toBe(false);
  });

  it('401 错误不应重试', () => {
    expect(isRetryableError(new Error('status 401'))).toBe(false);
  });

  it('普通 Error 不应重试', () => {
    expect(isRetryableError(new Error('something else'))).toBe(false);
  });

  it('非 Error 类型不应重试', () => {
    expect(isRetryableError('string error')).toBe(false);
  });
});

describe('withRetry', () => {
  it('函数一次成功时不应重试', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('可重试错误应重试并最终返回成功', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('status 500'))
      .mockRejectedValueOnce(new Error('status 503'))
      .mockResolvedValue('eventual success');

    const result = await withRetry(fn, { baseDelayMs: 10 });
    expect(result).toBe('eventual success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('不可重试错误应立即抛出', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('status 400'));

    await expect(withRetry(fn, { baseDelayMs: 10 })).rejects.toThrow('status 400');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('超过最大重试次数应抛出最后一次错误', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('status 500'));

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 10 })).rejects.toThrow('status 500');
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('重试时应触发 onRetry 回调', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('status 500'))
      .mockResolvedValue('ok');

    await withRetry(fn, { baseDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('重试时应触发 onRetry 回调', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValue('ok');

    await withRetry(fn, { baseDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
