import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 错误边界模块顶层会执行 installProcessErrorHandlers；homedir 重定向保证记录日志不落真实目录。
// errorLogService 的日志路径是模块加载时固化的常量；vi.mock 工厂被 hoist 不能引用任何
// 外部 import（TDZ），因此工厂内动态 import 依赖、自管理目录状态，测试经 os.homedir() 读取。
vi.mock('os', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  let fixedDir = '';
  const mockOs = {
    homedir: () => {
      if (!fixedDir) fixedDir = mkdtempSync(join('/tmp', 'ca-apiboundary-test-'));
      return fixedDir;
    },
    tmpdir: () => '/tmp',
  };
  return { ...mockOs, default: mockOs };
});

import type { NextApiResponse } from 'next';
import { withApiErrorBoundary } from '@/services/common/apiErrorBoundary';

type MockRes = { headersSent: boolean; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };

function makeRes(overrides: Partial<MockRes> = {}): MockRes {
  const res: MockRes = {
    headersSent: false,
    status: vi.fn(() => res),
    json: vi.fn(() => res),
    ...overrides,
  };
  return res;
}

function invoke(wrapped: ReturnType<typeof withApiErrorBoundary>, res: MockRes) {
  return wrapped({} as never, res as unknown as NextApiResponse);
}

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), '.customize-agent'), { recursive: true, force: true });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  fs.rmSync(os.homedir(), { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('withApiErrorBoundary', () => {
  it('handler 正常完成时不写响应（返回值不透传）', async () => {
    const handler = vi.fn(async () => 'ok');
    const wrapped = withApiErrorBoundary('unit', handler);
    const res = makeRes();
    const result = await invoke(wrapped, res);
    expect(result).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('handler 抛错时返回 500 统一响应并记录日志', async () => {
    const handler = vi.fn(async () => { throw new Error('业务异常'); });
    const wrapped = withApiErrorBoundary('unit', handler);
    const res = makeRes();
    await invoke(wrapped, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: '业务异常', requestId: expect.stringMatching(/^err_/) });
    expect(console.error).toHaveBeenCalled();
  });

  it('非 Error 异常返回通用 message', async () => {
    const handler = vi.fn(async () => { throw '裸字符串'; });
    const wrapped = withApiErrorBoundary('unit', handler);
    const res = makeRes();
    await invoke(wrapped, res);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error', requestId: expect.stringMatching(/^err_/) });
  });

  it('headers 已发送时不再写响应体', async () => {
    const handler = vi.fn(async () => { throw new Error('late'); });
    const wrapped = withApiErrorBoundary('unit', handler);
    const res = makeRes({ headersSent: true });
    await invoke(wrapped, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('记录 functionName（匿名函数回退 anonymous）', async () => {
    // vi.fn 包装后 name 为 'Mock'，须用真实函数验证 functionName 记录
    async function namedHandler() { throw new Error('x'); }
    const res = makeRes();
    await invoke(withApiErrorBoundary('unit', namedHandler), res);
    const logs = fs.readFileSync(path.join(os.homedir(), '.customize-agent', 'logs', 'errors.jsonl'), 'utf8');
    expect(logs).toContain('"functionName":"namedHandler"');
    const res2 = makeRes();
    await invoke(withApiErrorBoundary('unit', async () => { throw new Error('y'); }), res2);
    const logs2 = fs.readFileSync(path.join(os.homedir(), '.customize-agent', 'logs', 'errors.jsonl'), 'utf8');
    expect(logs2).toContain('"functionName":"anonymous"');
  });
});
