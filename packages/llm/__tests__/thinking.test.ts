import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_THINKING_PROFILES, thinkingCapabilityForModel, thinkingDisableBody } from '../src/thinking';
import { OpenAIProvider } from '../src/providers/openai';

describe('MODEL_THINKING_PROFILES 模型思考画像注册表', () => {
  it('deepseek 系：默认思考、可硬关、与正文共享输出池', () => {
    const capability = thinkingCapabilityForModel('deepseek-v4-pro');
    expect(capability).toEqual({ defaultEnabled: true, disable: 'deepseek-thinking', budgetPolicy: 'shared' });
  });

  it('gpt-5 系：默认思考、reasoning effort none 可关、独立预算', () => {
    const capability = thinkingCapabilityForModel('gpt-5.5');
    expect(capability).toEqual({ defaultEnabled: true, disable: 'openai-reasoning-effort', budgetPolicy: 'separate' });
  });

  it('gemini 3.x：思考不可关闭（官方限制）、独立预算', () => {
    const capability = thinkingCapabilityForModel('gemini-3.1-pro-preview');
    expect(capability).toEqual({ defaultEnabled: true, disable: 'unsupported', budgetPolicy: 'separate' });
  });

  it('qwen（未来接入）：默认不思考、enable_thinking 可关', () => {
    const capability = thinkingCapabilityForModel('qwen-max');
    expect(capability).toEqual({ defaultEnabled: false, disable: 'qwen-enable-thinking', budgetPolicy: 'separate' });
  });

  it('glm（未来接入）：默认思考、thinking disabled 可关', () => {
    const capability = thinkingCapabilityForModel('glm-4.6');
    expect(capability).toEqual({ defaultEnabled: true, disable: 'glm-thinking', budgetPolicy: 'separate' });
  });

  it('模型名大小写不敏感匹配', () => {
    expect(thinkingCapabilityForModel('DeepSeek-V4-Pro')?.disable).toBe('deepseek-thinking');
    expect(thinkingCapabilityForModel('GPT-5.5')?.disable).toBe('openai-reasoning-effort');
  });

  it('未注册模型返回 undefined（调用方保守处理，不注入思考参数）', () => {
    expect(thinkingCapabilityForModel('unknown-model-x')).toBeUndefined();
  });

  it('注册表不空：新增模型只需追加一条画像', () => {
    expect(MODEL_THINKING_PROFILES.length).toBeGreaterThanOrEqual(5);
  });
});

describe('thinkingDisableBody 厂商参数翻译', () => {
  it('deepseek → thinking {type:disabled}', () => {
    expect(thinkingDisableBody('deepseek-v4-pro')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('gpt-5.5 → reasoning {effort:none}（none 等同非推理模型）', () => {
    expect(thinkingDisableBody('gpt-5.5')).toEqual({ reasoning: { effort: 'none' } });
  });

  it('qwen → enable_thinking:false', () => {
    expect(thinkingDisableBody('qwen-max')).toEqual({ enable_thinking: false });
  });

  it('glm → thinking {type:disabled}', () => {
    expect(thinkingDisableBody('glm-4.6')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('gemini → thinkingBudget:0（兼容 2.5，3.x 忽略但调用方另有告警）', () => {
    expect(thinkingDisableBody('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
  });

  it('gemini 3.x unsupported：抛显式能力错误而非静默失败', () => {
    expect(() => thinkingDisableBody('gemini-3.1-pro-preview')).toThrow(/不支持关闭思考/);
  });

  it('未注册模型：返回 null 不注入参数', () => {
    expect(thinkingDisableBody('unknown-model-x')).toBeNull();
  });
});

describe('OpenAICompatProvider 请求体注入（mock fetch 捕获）', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  async function captureRequestBody(modelName: string, options: { disableThinking?: boolean; extraBody?: Record<string, unknown> }) {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ok', reasoning_content: '' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseUrl: 'https://api.example.com', modelName, directEndpoint: true });
    const result = await provider.chat([{ role: 'user', content: 'hello' }], {
      disableThinking: options.disableThinking,
      extraBody: options.extraBody,
    });
    expect(result.content).toBe('ok');
    return captured;
  }

  it('disableThinking=true 且 deepseek：请求体注入 thinking {type:disabled}', async () => {
    const body = await captureRequestBody('deepseek-v4-pro', { disableThinking: true });
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('disableThinking=true 且 gpt-5.5：注入 reasoning {effort:none}', async () => {
    const body = await captureRequestBody('gpt-5.5', { disableThinking: true });
    expect(body.reasoning).toEqual({ effort: 'none' });
  });

  it('disableThinking=false：不注入任何思考参数', async () => {
    const body = await captureRequestBody('deepseek-v4-pro', { disableThinking: false });
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it('extraBody 顶层合并透传（厂商原生参数通道）', async () => {
    const body = await captureRequestBody('deepseek-v4-pro', { extraBody: { custom_param: 42, thinking: { type: 'enabled' } } });
    expect(body.custom_param).toBe(42);
    // extraBody 后合并，可覆盖默认翻译（显式意图优先）
    expect(body.thinking).toEqual({ type: 'enabled' });
  });

  it('disableThinking=true 且 gemini 3.x：抛出能力不支持错误', async () => {
    await expect(captureRequestBody('gemini-3.1-pro-preview', { disableThinking: true })).rejects.toThrow(/不支持关闭思考/);
  });
});
