import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeJsonParseFailure, validateJsonAgainstSchema, type DocumentJsonSchema } from '../src/services/document-workflow/llmClient';
import { callDocumentLlmJson } from '../src/services/document-workflow/llmClient';
import { callDocumentLlm } from '../src/services/document-workflow/llmClient';
import type { DocumentGenerationDiagnostics } from '../src/services/document-workflow/types';

const chatMock = vi.fn();

vi.mock('@/services/common/configService', () => ({
  getConfigStore: () => ({
    load: () => ({
      models: {
        reasoning: { active: 'test-model', list: [{ name: 'test-model', provider: 'test-provider' }] },
        action: { active: 'test-model', list: [] },
        reader: { active: 'test-model', list: [] },
      },
      providers: { 'test-provider': { apiKey: 'test-key', baseUrl: 'http://localhost:1', protocol: 'openai', directEndpoint: '' } },
    }),
  }),
}));

vi.mock('@customize-agent/llm', () => ({
  createProvider: vi.fn(() => ({
    capabilities: { maxOutputTokens: 8192 },
    chat: chatMock,
  })),
  // 未注册画像 → decideThinkingPolicy 保守不注入思考参数（与旧行为一致）
  thinkingCapabilityForModel: vi.fn(() => undefined),
}));

function makeDiagnostics(): DocumentGenerationDiagnostics {
  return {
    strategy: { mode: 'balanced' },
    metrics: [],
    llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, failureStreak: 0, schemaFailures: 0 },
    evidence: { raw: 0, used: 0, filteredNoise: 0, budgetDropped: 0, avgNoiseScore: 0, avgFactDensity: 0, searchQueries: 0, searchMs: 0, contextChars: 0 },
    quality: { blockingCount: 0, importantCount: 0, minorCount: 0, repairedCount: 0 },
  } as unknown as DocumentGenerationDiagnostics;
}

const BLOCKS_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['blocks'],
  properties: {
    blocks: {
      type: 'array',
      required: true,
      minItems: 1,
      items: {
        type: 'object',
        required: true,
        properties: {
          title: { type: 'string', required: true, minLength: 2 },
          subPoints: { type: 'array', required: true, minItems: 1, items: { type: 'object', required: true } },
        },
      },
    },
  },
};

afterEach(() => {
  chatMock.mockReset();
  chatMock.mockResolvedValue({ content: '{"blocks":[{"title":"主题块","subPoints":[{"title":"要点"}]}]}' });
});

describe('validateJsonAgainstSchema', () => {
  it('通过合法对象', () => {
    const errors = validateJsonAgainstSchema(
      { blocks: [{ title: '主题块', subPoints: [{ title: '要点' }] }] },
      BLOCKS_SCHEMA,
    );
    expect(errors).toEqual([]);
  });

  it('报告缺失必填字段（含顶层与嵌套路径）', () => {
    const errors = validateJsonAgainstSchema({}, BLOCKS_SCHEMA);
    expect(errors.some(error => error.includes('缺失字段 $.blocks'))).toBe(true);

    const nested = validateJsonAgainstSchema(
      { blocks: [{ title: '主题块' }] },
      BLOCKS_SCHEMA,
    );
    expect(nested.some(error => error.includes('缺失字段 $.blocks[0].subPoints'))).toBe(true);
  });

  it('报告类型错误与条数约束', () => {
    const typeErrors = validateJsonAgainstSchema({ blocks: 'not-array' }, BLOCKS_SCHEMA);
    expect(typeErrors.some(error => error.includes('字段 $.blocks 类型错误'))).toBe(true);

    const itemErrors = validateJsonAgainstSchema({ blocks: [] }, BLOCKS_SCHEMA);
    expect(itemErrors.some(error => error.includes('字段 $.blocks 条数不足'))).toBe(true);
  });

  it('根节点非对象时报根节点类型错误', () => {
    const errors = validateJsonAgainstSchema([1, 2], BLOCKS_SCHEMA);
    expect(errors[0]).toContain('根节点类型错误');
  });
});

describe('describeJsonParseFailure', () => {
  it('识别未闭合括号的截断响应并给出末段', () => {
    const message = describeJsonParseFailure('{"blocks":[{"title":"施工部署","subPoints":[{"title":"施工总体部署"');
    expect(message).toContain('JSON 被截断');
    expect(message).toContain('截断位置响应末段');
  });

  it('闭合但语法错误时报告语法错误', () => {
    const message = describeJsonParseFailure('{"blocks": [{"title": "施工部署" invalid}]}');
    expect(message).toContain('JSON 语法错误');
  });
});

describe('callDocumentLlmJson schema 校验', () => {
  it('schema 校验失败返回 undefined 并记录可诊断原因', async () => {
    chatMock.mockResolvedValue({ content: '{"blocks": "not-an-array"}' });
    const diagnostics = makeDiagnostics();
    const result = await callDocumentLlmJson<{ blocks: unknown }>('sys', 'prompt', { maxTokens: 1000, diagnostics, schema: BLOCKS_SCHEMA });
    expect(result).toBeUndefined();
    expect(diagnostics.llm.schemaFailures).toBe(1);
    expect(diagnostics.llm.lastError).toContain('JSON Schema 校验失败');
    expect(diagnostics.llm.lastError).toContain('$.blocks 类型错误');
  });

  it('JSON 截断时解析失败原因含截断位置', async () => {
    chatMock.mockResolvedValue({ content: '{"blocks":[{"title":"施工部署"' });
    const diagnostics = makeDiagnostics();
    const result = await callDocumentLlmJson<{ blocks: unknown }>('sys', 'prompt', { maxTokens: 1000, diagnostics, schema: BLOCKS_SCHEMA });
    expect(result).toBeUndefined();
    expect(diagnostics.llm.lastError).toContain('JSON 被截断');
  });

  it('未传 schema 时保持宽松行为（仅 JSON 解析）', async () => {
    chatMock.mockResolvedValue({ content: '{"anything": true}' });
    const diagnostics = makeDiagnostics();
    const result = await callDocumentLlmJson<{ anything: boolean }>('sys', 'prompt', { maxTokens: 1000, diagnostics });
    expect(result).toEqual({ anything: true });
    expect(diagnostics.llm.schemaFailures).toBe(0);
  });
});

describe('callDocumentLlm 空响应重试提示词收敛', () => {
  it('空响应重试时输出预算不变且提示词追加「缩短思考」', async () => {
    chatMock
      .mockResolvedValueOnce({ content: '' })
      .mockResolvedValueOnce({ content: '最终结论正文' });
    const result = await callDocumentLlm('sys', '原始提示词', false, { maxTokens: 1000 });
    expect(result).toBe('最终结论正文');
    expect(chatMock).toHaveBeenCalledTimes(2);
    // 第二次尝试：输出预算保持不变（不再放大到 8192）
    const secondCall = chatMock.mock.calls[1];
    const secondMessages = secondCall[0] as Array<{ role: string; content: string }>;
    expect(secondMessages[1].content).toContain('原始提示词');
    expect(secondMessages[1].content).toContain('缩短思考');
    expect(secondCall[1].maxTokens).toBe(1000);
  }, 10000);

  it('瞬态错误重试不追加缩短思考提示词', async () => {
    chatMock
      .mockRejectedValueOnce(new Error('fetch failed connection error'))
      .mockResolvedValueOnce({ content: '重试成功' });
    const result = await callDocumentLlm('sys', '原始提示词', false, { maxTokens: 1000 });
    expect(result).toBe('重试成功');
    const secondCall = chatMock.mock.calls[1];
    const secondMessages = secondCall[0] as Array<{ role: string; content: string }>;
    expect(secondMessages[1].content).toBe('原始提示词');
  }, 10000);

  it('成功响应不重试且不带收敛提示词', async () => {
    chatMock.mockResolvedValue({ content: '一次成功' });
    const result = await callDocumentLlm('sys', '原始提示词', false, { maxTokens: 1000 });
    expect(result).toBe('一次成功');
    expect(chatMock).toHaveBeenCalledTimes(1);
    const messages = chatMock.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages[1].content).toBe('原始提示词');
  });
});
