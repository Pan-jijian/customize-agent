import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Node ESM 命名空间不可配置，无法 spyOn；以模块级 mock 重定向 homedir。
// 注意：errorLogService 的 LOG_DIR 是模块加载时固化的常量，工厂执行时就必须创建好
// 固定临时目录；vi.mock 工厂被 hoist，不能引用任何外部 import（TDZ），因此工厂内
// 动态 import 依赖、自管理目录状态，测试经 os.homedir() 读取同一目录。
vi.mock('os', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  let fixedDir = '';
  const mockOs = {
    homedir: () => {
      if (!fixedDir) fixedDir = mkdtempSync(join('/tmp', 'ca-errorlog-test-'));
      return fixedDir;
    },
    tmpdir: () => '/tmp',
  };
  return { ...mockOs, default: mockOs };
});

import {
  clearErrorLogs,
  createProcessErrorHandler,
  installProcessErrorHandlers,
  listErrorLogs,
  recordErrorLog,
  type ErrorLogEntry,
} from '@/services/common/errorLogService';

const logDir = () => path.join(os.homedir(), '.customize-agent', 'logs');
const logFile = () => path.join(logDir(), 'errors.jsonl');

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.customize-agent'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(os.homedir(), { recursive: true, force: true });
});

function readEntries(): ErrorLogEntry[] {
  return fs.readFileSync(logFile(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ErrorLogEntry);
}

describe('recordErrorLog', () => {
  it('记录 Error 实例的消息与堆栈', () => {
    const error = new Error('boom');
    const entry = recordErrorLog({ source: 'test', functionName: 'run', error });
    expect(entry.level).toBe('error');
    expect(entry.source).toBe('test');
    expect(entry.functionName).toBe('run');
    expect(entry.message).toBe('boom');
    expect(entry.stack).toContain('boom');
    expect(entry.id).toMatch(/^err_\d+_[0-9a-f]{8}$/);
    const stored = readEntries();
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe('boom');
  });

  it('记录字符串错误与自定义 level', () => {
    const entry = recordErrorLog({ level: 'warn', source: 's', error: '纯文本错误' });
    expect(entry.level).toBe('warn');
    expect(entry.message).toBe('纯文本错误');
    expect(entry.stack).toBeUndefined();
  });

  it('记录普通对象错误（JSON 序列化）', () => {
    const entry = recordErrorLog({ source: 's', error: { code: 42 } });
    expect(entry.message).toBe('{"code":42}');
  });

  it('循环引用对象回退 String(error)', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const entry = recordErrorLog({ source: 's', error: cyclic });
    expect(entry.message).toBe('[object Object]');
  });

  it('携带 req 信息时记录 method/url/query', () => {
    const entry = recordErrorLog({ source: 's', error: new Error('e'), req: { method: 'POST', url: '/api/x', query: { a: '1' } } as never });
    expect(entry.request).toEqual({ method: 'POST', url: '/api/x', query: { a: '1' } });
  });

  it('携带 meta 时透传', () => {
    const entry = recordErrorLog({ source: 's', error: 'e', meta: { stage: 'generation' } });
    expect(entry.meta).toEqual({ stage: 'generation' });
  });
});

describe('listErrorLogs / clearErrorLogs', () => {
  it('无日志文件时返回空数组', () => {
    expect(listErrorLogs()).toEqual([]);
  });

  it('按最新在前返回', () => {
    recordErrorLog({ source: 's', error: 'first' });
    recordErrorLog({ source: 's', error: 'second' });
    const logs = listErrorLogs();
    expect(logs.map(l => l.message)).toEqual(['second', 'first']);
  });

  it('limit 限制返回条数', () => {
    for (let i = 0; i < 5; i += 1) recordErrorLog({ source: 's', error: `e${i}` });
    const logs = listErrorLogs(3);
    expect(logs).toHaveLength(3);
    expect(logs[0].message).toBe('e4');
  });

  it('损坏行导致整体返回空数组（防御性解析）', () => {
    recordErrorLog({ source: 's', error: 'ok' });
    fs.appendFileSync(logFile(), 'not-json-line\n');
    expect(listErrorLogs()).toEqual([]);
  });

  it('clearErrorLogs 删除日志文件', () => {
    recordErrorLog({ source: 's', error: 'x' });
    clearErrorLogs();
    expect(fs.existsSync(logFile())).toBe(false);
    expect(listErrorLogs()).toEqual([]);
  });
});

describe('日志轮转', () => {
  it('超过 2MB 后轮转归档', () => {
    recordErrorLog({ source: 's', error: 'seed' });
    // 直接写入超限内容，触发下次 append 前的轮转
    fs.writeFileSync(logFile(), Buffer.alloc(2 * 1024 * 1024 + 64, 0x61));
    recordErrorLog({ source: 's', error: 'after-rotate' });
    const archived = fs.readdirSync(logDir()).filter(name => name.startsWith('errors-') && name.endsWith('.jsonl'));
    expect(archived.length).toBeGreaterThanOrEqual(1);
    // 原文件被重建且只含新日志
    const entries = readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('after-rotate');
  });
});

describe('createProcessErrorHandler', () => {
  it('record 与 output 均被调用', () => {
    const record = vi.fn();
    const output = vi.fn();
    const handler = createProcessErrorHandler('uncaughtException', record, output);
    handler(new Error('x'));
    expect(record).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith('uncaughtException', expect.any(Error));
  });

  it('同窗口超过 limit 后不再 output，但仍 record', () => {
    const record = vi.fn();
    const output = vi.fn();
    const handler = createProcessErrorHandler('label', record, output, 2);
    handler('a');
    handler('b');
    handler('c');
    expect(record).toHaveBeenCalledTimes(3);
    expect(output).toHaveBeenCalledTimes(2);
  });

  it('窗口过期后限流重置', () => {
    vi.useFakeTimers();
    try {
      const record = vi.fn();
      const output = vi.fn();
      const handler = createProcessErrorHandler('label', record, output, 1);
      handler('a');
      handler('b');
      expect(output).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(61_000);
      handler('c');
      expect(output).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('record 抛错时静默断链，不触发 output 也不抛出', () => {
    const record = vi.fn(() => { throw new Error('stdout broken'); });
    const output = vi.fn();
    const handler = createProcessErrorHandler('label', record, output);
    expect(() => handler('x')).not.toThrow();
    expect(output).not.toHaveBeenCalled();
  });

  it('output 抛错时静默（防 console 递归风暴）', () => {
    const record = vi.fn();
    const output = vi.fn(() => { throw new Error('EPIPE'); });
    const handler = createProcessErrorHandler('label', record, output);
    expect(() => handler('x')).not.toThrow();
    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe('installProcessErrorHandlers', () => {
  it('只安装一次（幂等）', () => {
    const before = process.listenerCount('uncaughtException');
    installProcessErrorHandlers();
    installProcessErrorHandlers();
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
  });
});
