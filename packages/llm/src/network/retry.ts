/** 重试配置选项 */
export interface RetryOptions {
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
  /** 基础退避延迟 ms（默认 1000） */
  baseDelayMs?: number;
  /** 每次重试时的回调（流式模式可通过 onRetry 发送 type:'reset' chunk 实现回滚） */
  onRetry?: (attempt: number, error: Error) => void;
}

/** 可重试的 HTTP 状态码 */
const RETRYABLE_STATUSES = new Set([429, 408, 500, 502, 503, 504]);

/** 判断错误是否可重试（5xx / 网络错误 / rate limit） */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // 网络错误
    if (msg.includes('econnrefused') || msg.includes('econnreset') ||
        msg.includes('etimedout') || msg.includes('enotfound') ||
        msg.includes('network') || msg.includes('abort') ||
        msg.includes('fetch failed')) {
      return true;
    }
    // HTTP 状态码匹配
    const statusMatch = msg.match(/status(?: code)?\s*(\d{3})/i);
    if (statusMatch) {
      const code = parseInt(statusMatch[1]!, 10);
      return RETRYABLE_STATUSES.has(code);
    }
  }
  return false;
}

/**
 * 带指数退避的重试包装器。
 * 公式: delay = baseDelayMs × 2^attempt + random(0, 1000)ms
 * 4xx 错误（非 429/408）不重试，直接抛异常。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxRetries || !isRetryableError(lastError)) {
        throw lastError;
      }

      options.onRetry?.(attempt + 1, lastError);

      // 指数退避 + 随机抖动
      const jitter = Math.floor(Math.random() * 1000);
      const delay = baseDelayMs * Math.pow(2, attempt) + jitter;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}
