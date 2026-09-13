/**
 * 健康检查 API 测试（4.28.0 E3）：uptime 口径为秒。
 *
 * 背景：原实现返回模块加载至请求的毫秒差（Date.now() - startTime），消费端 settings 页
 * formatUptime 按秒换算 → 显示放大 1000 倍。修复后与 /api/system/stats（process.uptime()）同口径。
 */
import { describe, expect, it, vi } from 'vitest';
import handler from '@/pages/api/health';

type MockRes = { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };

function makeRes(): MockRes {
  const res: MockRes = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
}

describe('GET /api/health', () => {
  it('uptime 按秒返回（毫秒口径会与 process.uptime() 相差千倍）', () => {
    const res = makeRes();
    handler({ method: 'GET' } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0]?.[0] as { status: string; uptime: number; pid: number };
    expect(body.status).toBe('ok');
    expect(Number.isInteger(body.uptime)).toBe(true);
    // 与 process.uptime() 同口径（秒）；毫秒口径下模块加载至断言的耗时差会直接超出容差
    expect(Math.abs(body.uptime - process.uptime())).toBeLessThan(2);
    expect(body.pid).toBe(process.pid);
  });

  it('非 GET 请求返回 405', () => {
    const res = makeRes();
    handler({ method: 'POST' } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
  });
});
