/**
 * llmClient F1 修复轮失效治理单测：
 * callDocumentLlmJsonWithRetry 在 JSON 解析/schema 校验失败时重试一次（失败原因回注提示词），
 * 二次仍失败才放弃并透传失败原因；成功路径与网络失败路径不重试。
 * 底层 LLM 调用通过 invokeLlm 注入桩（模块内部词法绑定无法被 vi.mock 拦截）。
 */
import { describe, expect, it, vi } from 'vitest';
import { amplifiedTruncationMaxTokens, callDocumentLlm, callDocumentLlmJsonWithRetry, contextLayerChars, flushScheduledLaunches, isContextOverflowLlmError, isTransientLlmError, llmPrefixFingerprint, prefixScheduleWindowFor, repairTruncatedJson, retryDelayMs, sortScheduledLaunches, type DocumentJsonSchema } from '@/services/document-workflow/llmClient';
import type { DocumentGenerationDiagnostics } from '@/services/document-workflow/types';

// 无活跃模型配置：callDocumentLlm 观测累计发生在 provider 调用之前，
// mock 掉 configService 让 getActiveModelWithProvider 返回 undefined，避免触碰真实配置存储
vi.mock('@/services/common/configService', () => ({
  getConfigStore: () => ({
    load: () => ({ models: { reasoning: { active: '', list: [] }, action: { active: '', list: [] }, reader: { active: '', list: [] } }, providers: {} }),
  }),
}));

const bareDiagnostics = () => ({ llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, inputChars: 0 } }) as unknown as DocumentGenerationDiagnostics;

const schema: DocumentJsonSchema = {
  type: 'object',
  required: ['patches'],
  properties: { patches: { type: 'array', minItems: 1, items: { type: 'object' } } },
};

describe('callDocumentLlmJsonWithRetry（F1 JSON/Schema 失败重试）', () => {
  it('首次解析失败 → 带失败原因重试一次后成功', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('{"patches": [{"replacement": "x"}]')  // JSON 被截断
      .mockResolvedValueOnce('{"patches": [{"replacement": "x"}]}');
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', {}, invoke);
    expect(result?.patches).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    // 重试提示词必须携带上一次失败原因与 JSON 收敛指令
    expect(invoke.mock.calls[1][1]).toContain('重试修正');
    expect(invoke.mock.calls[1][1]).toContain('JSON 解析失败');
  });

  it('schema 校验失败 → 重试 2 次（共 3 次调用）仍失败 → undefined 且 outFailure 透传原因', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('{"patches": []}')
      .mockResolvedValueOnce('{"patches": []}')
      .mockResolvedValueOnce('{"patches": []}');
    const outFailure: { value?: string } = {};
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', { schema, outFailure }, invoke);
    expect(result).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(outFailure.value).toContain('JSON Schema 校验失败');
    // 每次重试提示词均携带上一次失败原因
    expect(invoke.mock.calls[1][1]).toContain('JSON Schema 校验失败');
    expect(invoke.mock.calls[2][1]).toContain('JSON Schema 校验失败');
  });

  it('schema 校验失败 → 重试成功返回结果', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('{"patches": []}')
      .mockResolvedValueOnce('{"patches": [{}]}');
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', { schema }, invoke);
    expect(result?.patches).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('成功路径不重试', async () => {
    const invoke = vi.fn().mockResolvedValueOnce('{"patches": [{}]}');
    await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', { schema }, invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('网络/空响应失败不触发 JSON 重试', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(undefined);
    const outFailure: { value?: string } = {};
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', { outFailure }, invoke);
    expect(result).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(outFailure.value).toBeUndefined();
  });
});

describe('callDocumentLlmJsonWithRetry（4.12.12 重试收敛：截断类失败最多 2 次重试）', () => {
  it('JSON 截断失败 → 重试 2 次后第三次成功（共 3 次调用），重试提示词含截断原因', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('{"patches": [{"replacement": "x"}') // 截断
      .mockResolvedValueOnce('{"patches": [{"replacement": "x"}') // 截断
      .mockResolvedValueOnce('{"patches": [{"replacement": "x"}]}');
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', {}, invoke);
    expect(result?.patches).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[1][1]).toContain('JSON 被截断');
    expect(invoke.mock.calls[2][1]).toContain('JSON 被截断');
  });

  it('JSON 截断 3 次均失败 → undefined 且 outFailure 含截断原因（上限 3 次调用）', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('{"a": 1')
      .mockResolvedValueOnce('{"a": 1')
      .mockResolvedValueOnce('{"a": 1');
    const outFailure: { value?: string } = {};
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', { outFailure }, invoke);
    expect(result).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(outFailure.value).toContain('JSON 被截断');
  });

  it('非截断语法错误同样可重试（重试提示词不含「被截断」措辞）', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('not json at all')
      .mockResolvedValueOnce('{"patches": [{}]}');
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', { schema }, invoke);
    expect(result?.patches).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toContain('JSON 解析失败');
  });
});

describe('amplifiedTruncationMaxTokens（截断重试 maxTokens 放大 1.5 倍）', () => {
  it('给定额度放大 1.5 倍并向上取整', () => {
    expect(amplifiedTruncationMaxTokens(1000)).toBe(1500);
    expect(amplifiedTruncationMaxTokens(4096)).toBe(6144);
    expect(amplifiedTruncationMaxTokens(4097)).toBe(6146);
  });

  it('缺省/0 按 2000 基准放大为 3000', () => {
    expect(amplifiedTruncationMaxTokens(undefined)).toBe(3000);
    expect(amplifiedTruncationMaxTokens(0)).toBe(3000);
  });
});

describe('isContextOverflowLlmError（上下文超长识别，含 JSON 输出截断）', () => {
  it('provider 输入超窗口报错 → true', () => {
    expect(isContextOverflowLlmError(new Error('maximum context length exceeded'))).toBe(true);
    expect(isContextOverflowLlmError('400 context length too long')).toBe(true);
  });

  it('中文上下文超长报错 → true', () => {
    expect(isContextOverflowLlmError('请求失败：上下文长度超出模型限制')).toBe(true);
    expect(isContextOverflowLlmError('400 请求体过长')).toBe(true);
  });

  it('JSON 输出被截断（describeJsonParseFailure 输出形态）→ true 触发压缩证据降级重试', () => {
    expect(isContextOverflowLlmError('JSON 解析失败：JSON 被截断（{ 未闭合 2 个），截断位置响应末段：…')).toBe(true);
  });

  it('JSON 截断措辞变体（紧凑写法/大小写）→ true', () => {
    expect(isContextOverflowLlmError('JSON解析失败：输出被截断')).toBe(true);
    expect(isContextOverflowLlmError('json 被截断（{ 未闭合 1 个）')).toBe(true);
  });

  it('JSON 语法错误（非截断）与普通失败 → false 不降级', () => {
    expect(isContextOverflowLlmError('JSON 解析失败：JSON 语法错误，出错位置响应末段：…')).toBe(false);
    expect(isContextOverflowLlmError('网络连接失败')).toBe(false);
    expect(isContextOverflowLlmError('invalid api key')).toBe(false);
  });

  it('空值与非字符串输入安全返回 false（不抛异常）', () => {
    expect(isContextOverflowLlmError('')).toBe(false);
    expect(isContextOverflowLlmError(undefined)).toBe(false);
    expect(isContextOverflowLlmError(null)).toBe(false);
    expect(isContextOverflowLlmError(500)).toBe(false);
    expect(isContextOverflowLlmError({ code: 400, message: 'context' })).toBe(false);
  });

  it('瞬态错误不误判为上下文超长（走瞬时重试而非降级重试）', () => {
    expect(isContextOverflowLlmError('fetch failed')).toBe(false);
    expect(isContextOverflowLlmError('429 too many requests')).toBe(false);
  });
});

describe('callDocumentLlm 上下文观测（3.4 inputChars + L0-L3 分层累计）', () => {
  it('calls/inputChars/layerChars 一次性累计（无活跃模型同样观测，不触发 provider）', async () => {
    const diagnostics = bareDiagnostics();
    const content = await callDocumentLlm('系统段', '用户段', false, {
      diagnostics,
      contextLayers: { l0: 3, l1: 4, l2: 5, l3: 6 },
    });
    expect(content).toBeUndefined();
    expect(diagnostics.llm.calls).toBe(1);
    expect(diagnostics.llm.inputChars).toBe('系统段'.length + '用户段'.length);
    expect(diagnostics.llm.layerChars).toEqual({ l0: 3, l1: 4, l2: 5, l3: 6 });
  });

  it('多次调用分层字符逐次累加，未传层保持 0', async () => {
    const diagnostics = bareDiagnostics();
    await callDocumentLlm('s', 'p', false, { diagnostics, contextLayers: { l1: 5 } });
    await callDocumentLlm('s', 'p', false, { diagnostics, contextLayers: { l2: 7 } });
    expect(diagnostics.llm.layerChars).toEqual({ l0: 0, l1: 5, l2: 7, l3: 0 });
    expect(diagnostics.llm.calls).toBe(2);
  });

  it('未传 contextLayers 时 layerChars 保持未初始化', async () => {
    const diagnostics = bareDiagnostics();
    await callDocumentLlm('s', 'p', false, { diagnostics });
    expect(diagnostics.llm.inputChars).toBe(2);
    expect(diagnostics.llm.layerChars).toBeUndefined();
  });

  it('contextLayerChars 过滤空段并求和（空字符串/false/undefined 自动忽略）', () => {
    expect(contextLayerChars(['甲乙', '', false, undefined, '丙丁'])).toBe(4);
    expect(contextLayerChars([])).toBe(0);
  });
});

describe('callDocumentLlm per-调用分量观测（4.1 callBreakdown 按 prefixKey 分组）', () => {
  it('同 prefixKey 聚合累计 次数/输入字符/L3 字符；跨 key 隔离', async () => {
    const diagnostics = bareDiagnostics();
    await callDocumentLlm('系统一', '正文一', false, { diagnostics, prefixKey: 'repair:c1', contextLayers: { l3: 10 } });
    await callDocumentLlm('系统二', '正文二', false, { diagnostics, prefixKey: 'repair:c1', contextLayers: { l3: 20 } });
    await callDocumentLlm('系统三', '正文三', false, { diagnostics, prefixKey: 'draft:c2', contextLayers: { l3: 5 } });
    const breakdown = diagnostics.llm.callBreakdown!;
    expect(Object.keys(breakdown)).toHaveLength(2);
    expect(breakdown['repair:c1']).toMatchObject({
      calls: 2,
      inputChars: '系统一'.length + '正文一'.length + '系统二'.length + '正文二'.length,
      l3Chars: 30,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
    });
    expect(breakdown['draft:c2']).toMatchObject({ calls: 1, l3Chars: 5 });
  });

  it('无 prefixKey 归入 (none)；未传 contextLayers 时 l3Chars 为 0', async () => {
    const diagnostics = bareDiagnostics();
    await callDocumentLlm('甲乙', '丙丁', false, { diagnostics });
    expect(diagnostics.llm.callBreakdown?.['(none)']).toMatchObject({ calls: 1, inputChars: 4, l3Chars: 0 });
  });
});

describe('isTransientLlmError（瞬态错误识别，驱动重试一次）', () => {
  it('超时/abort 类错误判瞬态：硬超时 abort 后应重试一次', () => {
    // OpenAI SDK 超时 abort 抛 APIUserAbortError
    expect(isTransientLlmError(new Error('This operation was aborted'))).toBe(true);
    // AbortSignal.timeout 原生 reason
    expect(isTransientLlmError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe(true);
    // fetch 层超时文案
    expect(isTransientLlmError(new Error('fetch failed: request timed out'))).toBe(true);
    expect(isTransientLlmError(new Error('Request timeout after 600000ms'))).toBe(true);
  });

  it('原有瞬态错误识别不回归', () => {
    expect(isTransientLlmError(new Error('fetch failed'))).toBe(true);
    expect(isTransientLlmError(new Error('connection error: ECONNRESET'))).toBe(true);
    expect(isTransientLlmError(new Error('429 rate limit exceeded'))).toBe(true);
    expect(isTransientLlmError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    expect(isTransientLlmError(new Error('服务繁忙，请稍后重试'))).toBe(true);
    expect(isTransientLlmError(new Error('连接失败'))).toBe(true);
  });

  it('非瞬态错误不误判：欠费与上下文超长各有独立处理路径', () => {
    expect(isTransientLlmError(new Error('402 Insufficient Balance'))).toBe(false);
    expect(isTransientLlmError(new Error("This model's maximum context length is 131072 tokens"))).toBe(false);
    expect(isTransientLlmError(new Error('无效 JSON：第 12 行解析失败'))).toBe(false);
    expect(isTransientLlmError(new Error('用户中止'))).toBe(false);
  });
});

describe('repairTruncatedJson（P1-4 截断 JSON 确定性修复）', () => {
  it('顶层对象截断：回退到最后一个完整元素并补闭合括号', () => {
    expect(repairTruncatedJson('{"a":1,"b":2,"c":3')).toBe('{"a":1,"b":2}');
    expect(JSON.parse(repairTruncatedJson('{"a":1,"b":2,"c":3')!)).toEqual({ a: 1, b: 2 });
  });

  it('嵌套对象截断（截断在字符串值中间）：丢弃残缺元素补齐闭合', () => {
    const repaired = repairTruncatedJson('{"blocks":[{"title":"A"},{"title":"施工总平面布置按以');
    expect(repaired).toBe('{"blocks":[{"title":"A"}]}');
    expect(JSON.parse(repaired!)).toEqual({ blocks: [{ title: 'A' }] });
  });

  it('数组元素截断（数字中间）：保留完整元素', () => {
    const repaired = repairTruncatedJson('{"blocks":[{"a":1},{"b":2},{"c":3');
    expect(repaired).toBe('{"blocks":[{"a":1},{"b":2}]}');
  });

  it('引号内花括号不干扰括号栈', () => {
    const repaired = repairTruncatedJson('{"note":"函数 {a} 使用","other":"截断');
    expect(repaired).toBe('{"note":"函数 {a} 使用"}');
  });

  it('首元素残缺（无完整元素边界）返回 undefined', () => {
    expect(repairTruncatedJson('{"blocks":[')).toBeUndefined();
    expect(repairTruncatedJson('{"a":')).toBeUndefined();
  });

  it('括号平衡（非截断语法错误）返回 undefined，不做语法猜测', () => {
    expect(repairTruncatedJson('{"a":1,}')).toBeUndefined();
  });

  it('嵌套对象内层截断：回退到内层最后完整元素（cut 不含逗号，无 trailing comma）', () => {
    expect(repairTruncatedJson('{"a":{"b":1,"c":"残缺')).toBe('{"a":{"b":1}}');
  });
});

describe('callDocumentLlmJsonWithRetry（P1-4 截断修复免重试）', () => {
  it('截断输出确定性修复成功且满足 schema → 不重试直接返回', async () => {
    const invoke = vi.fn().mockResolvedValueOnce('{"patches": [{"replacement": "x"}, {"replacement": "残缺截断');
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', { schema }, invoke);
    expect(result?.patches).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('截断修复产物不满足 schema（minItems 不足）→ 仍走失败原因回注重试', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('{"patches": [')
      .mockResolvedValueOnce('{"patches": [{}]}');
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', { schema }, invoke);
    expect(result?.patches).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][1]).toContain('重试修正');
  });
});

describe('llmPrefixFingerprint（P1-3 章级缓存分组键）', () => {
  it('显式 prefixKey 直接作为指纹（同章请求聚合）', () => {
    expect(llmPrefixFingerprint('system', 'prompt-a', 'writer-block:ch-2')).toBe('writer-block:ch-2');
    expect(llmPrefixFingerprint('system', 'prompt-b', 'writer-block:ch-2')).toBe('writer-block:ch-2');
  });

  it('跨章 prefixKey 指纹互不相同（调度器按章隔离，同章背靠背）', () => {
    const chapterA = llmPrefixFingerprint('system', 'prompt', 'writer-block:ch-1');
    const chapterB = llmPrefixFingerprint('system', 'prompt', 'writer-block:ch-2');
    expect(chapterA).not.toBe(chapterB);
  });

  it('无 prefixKey 回退旧启发式（system + user 前 2000 字符哈希）', () => {
    const first = llmPrefixFingerprint('sys-a', '同一主控提示词开头'.repeat(500));
    const second = llmPrefixFingerprint('sys-a', '同一主控提示词开头'.repeat(500) + '（后段章级差异）');
    // 历史缺陷：前 2000 字符相同 → 指纹相同 → 调度无区分度；该启发式仅作回退保留
    expect(first).toBe(second);
  });

  it('同前缀请求排序后背靠背相邻，不同前缀隔离', () => {
    const ordered = sortScheduledLaunches([
      { fingerprint: 'writer-block:ch-2', launch: () => {} },
      { fingerprint: 'writer-block:ch-1', launch: () => {} },
      { fingerprint: 'writer-block:ch-2', launch: () => {} },
    ]);
    expect(ordered.map(item => item.fingerprint)).toEqual(['writer-block:ch-1', 'writer-block:ch-2', 'writer-block:ch-2']);
  });
});

describe('retryDelayMs（2.7 503 过载指数退避）', () => {
  const overloaded = new Error('503 Server Overloaded');
  const transient429 = new Error('429 Too Many Requests');

  it('503 过载按重试序指数退避 2s→4s→8s（jitter 为 0 时）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(retryDelayMs(overloaded, 0)).toBe(2000);
      expect(retryDelayMs(overloaded, 1)).toBe(4000);
      expect(retryDelayMs(overloaded, 2)).toBe(8000);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('指数退避上限 30s', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(retryDelayMs(overloaded, 10)).toBe(30000);
      // jitter 满幅时不超过 31s
      vi.mocked(Math.random).mockReturnValue(0.999);
      expect(retryDelayMs(overloaded, 10)).toBeLessThanOrEqual(30999);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('非过载瞬态错误保持固定退避（1200ms 基数）', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(retryDelayMs(transient429, 5)).toBe(1200);
      expect(retryDelayMs(undefined, 0)).toBe(1200);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('DOCUMENT_LLM_RETRY_BACKOFF=0 回退固定退避', () => {
    process.env.DOCUMENT_LLM_RETRY_BACKOFF = '0';
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      expect(retryDelayMs(overloaded, 2)).toBe(1200);
    } finally {
      delete process.env.DOCUMENT_LLM_RETRY_BACKOFF;
      vi.restoreAllMocks();
    }
  });
});

describe('prefixScheduleWindowFor（3.3 调度窗口自适应）', () => {
  it('低并发保持 120ms 默认窗口', () => {
    expect(prefixScheduleWindowFor(0)).toBe(120);
    expect(prefixScheduleWindowFor(15)).toBe(120);
  });

  it('在飞 ≥16 时窗口扩至 500ms', () => {
    expect(prefixScheduleWindowFor(16)).toBe(500);
    expect(prefixScheduleWindowFor(64)).toBe(500);
  });

  it('env 显式覆盖优先（含 0=关闭调度）', () => {
    expect(prefixScheduleWindowFor(64, 250)).toBe(250);
    expect(prefixScheduleWindowFor(64, 0)).toBe(0);
    expect(prefixScheduleWindowFor(1, 250)).toBe(250);
  });
});

describe('flushScheduledLaunches（4.17.1 前缀预热调度）', () => {
  // DeepSeek prefix cache 请求完成后才落盘，并发同前缀实测全部 0% 命中；
  // 预热（maxTokens=1 纯前缀先行落盘）后并发实测全部命中 94%+。调度语义：组内 ≥2 且前缀未预热 → 先预热再并发发射。
  const item = (fingerprint: string, events: string[], tag: string, withWarmup = true) => ({
    fingerprint,
    launch: () => { events.push(`launch:${tag}`); },
    warmup: withWarmup ? () => { events.push(`warmup:${tag}`); return Promise.resolve(); } : undefined,
    warmupKey: withWarmup ? `${fingerprint}:${tag}` : undefined,
  });

  it('组内 ≥2 请求：先预热一次，完成后再发射组内全部请求', async () => {
    const events: string[] = [];
    flushScheduledLaunches([
      item('fam-a', events, 'a1'),
      item('fam-a', events, 'a2'),
      item('fam-b', events, 'b1'),
    ]);
    // 同步快照（数组引用会被后续微任务 push 污染，断言用快照）：fam-a 预热同步启动，fam-b 单请求组直接发射
    const syncSnapshot = [...events];
    expect(syncSnapshot).toEqual(['warmup:a1', 'launch:b1']);
    await new Promise(resolve => setTimeout(resolve, 0));
    // fam-a 预热完成后再发射 a1/a2
    expect(events).toEqual(['warmup:a1', 'launch:b1', 'launch:a1', 'launch:a2']);
  });

  it('同前缀已预热（warmupKey 相同）时直接并发发射，不再预热', async () => {
    const events: string[] = [];
    const shared = 'fam-c:c-shared';
    const mk = (tag: string) => ({
      fingerprint: 'fam-c',
      launch: () => { events.push(`launch:${tag}`); },
      warmup: () => { events.push(`warmup:${tag}`); return Promise.resolve(); },
      warmupKey: shared,
    });
    flushScheduledLaunches([mk('c1'), mk('c2')]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['warmup:c1', 'launch:c1', 'launch:c2']);
    events.length = 0;
    // 第二窗口同前缀：已预热 → 直接发射
    flushScheduledLaunches([mk('c3'), mk('c4')]);
    expect(events).toEqual(['launch:c3', 'launch:c4']);
  });

  it('单请求组与无 warmup 素材的组直接发射，不触发预热', async () => {
    const events: string[] = [];
    flushScheduledLaunches([
      item('fam-d', events, 'd1'),
      item('fam-d', events, 'd2', false), // 无 warmup 素材（无 contextLayers.l3 口径）
      item('fam-e', events, 'e1'),
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    // fam-d 组内无可用 warmup（d2 无素材、d1 有）→ 有候选 d1，组内 ≥2 → 预热 d1 后发射
    expect(events.filter(e => e.startsWith('warmup:'))).toEqual(['warmup:d1']);
    expect(events.filter(e => e.startsWith('launch:'))).toEqual(['launch:e1', 'launch:d1', 'launch:d2']);
  });

  it('预热失败：正式请求照常发射（退化为无预热并发）', async () => {
    const events: string[] = [];
    flushScheduledLaunches([
      {
        fingerprint: 'fam-f',
        launch: () => { events.push('launch:f1'); },
        warmup: () => { events.push('warmup:f1'); return Promise.reject(new Error('network')); },
        warmupKey: 'fam-f:f1',
      },
      {
        fingerprint: 'fam-f',
        launch: () => { events.push('launch:f2'); },
        warmup: () => Promise.resolve(),
        warmupKey: 'fam-f:f1',
      },
    ]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual(['warmup:f1', 'launch:f1', 'launch:f2']);
  });
});
