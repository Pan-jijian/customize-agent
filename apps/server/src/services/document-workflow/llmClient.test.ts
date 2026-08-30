/**
 * llmClient F1 修复轮失效治理单测：
 * callDocumentLlmJsonWithRetry 在 JSON 解析/schema 校验失败时重试一次（失败原因回注提示词），
 * 二次仍失败才放弃并透传失败原因；成功路径与网络失败路径不重试。
 * 底层 LLM 调用通过 invokeLlm 注入桩（模块内部词法绑定无法被 vi.mock 拦截）。
 */
import { describe, expect, it, vi } from 'vitest';
import { callDocumentLlmJsonWithRetry, isContextOverflowLlmError, type DocumentJsonSchema } from './llmClient';

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

  it('schema 校验失败 → 重试一次；二次仍失败 → undefined 且 outFailure 透传原因', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce('{"patches": []}')
      .mockResolvedValueOnce('{"patches": []}');
    const outFailure: { value?: string } = {};
    const result = await callDocumentLlmJsonWithRetry<{ patches: unknown[] }>('system', 'prompt', { schema, outFailure }, invoke);
    expect(result).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(outFailure.value).toContain('JSON Schema 校验失败');
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
