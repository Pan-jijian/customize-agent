import { describe, expect, it, afterEach } from 'vitest';
import { hardTimeoutSignal } from '../src/providers/openai-base.js';

describe('hardTimeoutSignal（LLM 请求硬超时）', () => {
  const original = process.env.LLM_REQUEST_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.LLM_REQUEST_TIMEOUT_MS;
    else process.env.LLM_REQUEST_TIMEOUT_MS = original;
  });

  it('默认超时（10 分钟）下 signal 不会立即 abort', () => {
    delete process.env.LLM_REQUEST_TIMEOUT_MS;
    const signal = hardTimeoutSignal();
    expect(signal.aborted).toBe(false);
  });

  it('env 短超时后 signal 自动 abort（覆盖响应头已回但 body 挂起场景）', async () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '80';
    const signal = hardTimeoutSignal();
    expect(signal.aborted).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(signal.aborted).toBe(true);
    expect(String(signal.reason)).toMatch(/timeout/iu);
  });

  it('外部 signal 已 abort 时组合 signal 立即跟随 abort', () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '1000';
    const external = AbortSignal.abort(new Error('用户中止'));
    const signal = hardTimeoutSignal(external);
    expect(signal.aborted).toBe(true);
  });

  it('外部 signal 运行中 abort 时组合 signal 跟随 abort', () => {
    process.env.LLM_REQUEST_TIMEOUT_MS = '1000';
    const controller = new AbortController();
    const signal = hardTimeoutSignal(controller.signal);
    expect(signal.aborted).toBe(false);
    controller.abort(new Error('用户中止'));
    expect(signal.aborted).toBe(true);
  });
});
