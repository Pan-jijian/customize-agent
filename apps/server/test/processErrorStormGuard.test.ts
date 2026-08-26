import { describe, it, expect, vi } from 'vitest';
import { createProcessErrorHandler } from '../src/services/common/errorLogService';

// 背景：dev server 通过管道启动（如 | head）时 stdout 破裂，任何 console 输出抛 EPIPE；
// uncaughtException 处理器内 console.error 再次抛 EPIPE → 无限递归风暴占满事件循环
// （曾导致生成任务假死、HTTP 无响应）。createProcessErrorHandler 通过
// try-catch 断链 + 60s 窗口限流保证处理器自身永不递归。

describe('createProcessErrorHandler 风暴防护', () => {
  it('output 抛错时处理器不抛异常（EPIPE 断链）', () => {
    const record = vi.fn();
    const output = vi.fn(() => {
      throw new Error('write EPIPE');
    });
    const handler = createProcessErrorHandler('uncaughtException', record, output);
    // 旧实现：handler 内 console.error 抛 EPIPE → V8 在 uncaughtException 处理器内再次 fatalException → 风暴。
    // 新实现：try-catch 吞掉，处理器正常返回，不抛任何异常。
    expect(() => handler(new Error('boom'))).not.toThrow();
    // 断链后 record 仍尽力执行（日志落盘先于 console 输出）
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('record 抛错时处理器同样不抛异常', () => {
    const record = vi.fn(() => {
      throw new Error('log write EPERM');
    });
    const output = vi.fn();
    const handler = createProcessErrorHandler('unhandledRejection', record, output);
    expect(() => handler(new Error('boom'))).not.toThrow();
    expect(output).not.toHaveBeenCalled();
  });

  it('60 秒窗口内 output 被限流，但 record 始终执行', () => {
    const record = vi.fn();
    const output = vi.fn();
    const handler = createProcessErrorHandler('uncaughtException', record, output, 20);
    for (let i = 0; i < 30; i += 1) {
      expect(() => handler(new Error(`boom-${i}`))).not.toThrow();
    }
    // 限流：同一 60s 窗口最多 20 次 output（其余静默），避免日志刷屏
    expect(output).toHaveBeenCalledTimes(20);
    // 日志落盘不受限流影响，每条异常都被记录
    expect(record).toHaveBeenCalledTimes(30);
  });

  it('跨窗口（超过 60 秒）限流计数重置', () => {
    vi.useFakeTimers();
    try {
      const record = vi.fn();
      const output = vi.fn();
      const handler = createProcessErrorHandler('uncaughtException', record, output, 20);
      const start = Date.now();
      for (let i = 0; i < 20; i += 1) handler(new Error(`boom-${i}`));
      expect(output).toHaveBeenCalledTimes(20);
      vi.setSystemTime(start + 61_000);
      handler(new Error('boom-after-window'));
      expect(output).toHaveBeenCalledTimes(21);
    } finally {
      vi.useRealTimers();
    }
  });
});
