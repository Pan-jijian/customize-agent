import { describe, expect, it } from 'vitest';
import {
  decideThinkingPolicy,
  concurrencyForDocumentScale,
  raiseDocumentLlmConcurrencyForScale,
  getDocumentLlmMaxConcurrency,
  providerFactoryName,
} from '../src/services/document-workflow/llmClient';

describe('decideThinkingPolicy 任务类型 × 模型思考能力决策矩阵', () => {
  describe('structuredGeneration（文档生成任务：不需要思维链，要求关思考）', () => {
    it('deepseek-v4-pro：关思考（硬关参数由 provider 翻译）', () => {
      expect(decideThinkingPolicy('structuredGeneration', 'deepseek-v4-pro')).toEqual({ disableThinking: true, budgetMode: 'compact' });
    });

    it('gpt-5.5：关思考（reasoning effort none）', () => {
      expect(decideThinkingPolicy('structuredGeneration', 'gpt-5.5')).toEqual({ disableThinking: true, budgetMode: 'compact' });
    });

    it('gemini-3.1-pro：思考不可关 → 不关 + 独立预算 + 告警', () => {
      const decision = decideThinkingPolicy('structuredGeneration', 'gemini-3.1-pro-preview');
      expect(decision.disableThinking).toBe(false);
      expect(decision.budgetMode).toBe('compact'); // separate 池：思考不抢正文预算
      expect(decision.warning).toMatch(/思考不可关闭/);
    });

    it('未知模型：保守不注入参数、预算直通、无告警', () => {
      const decision = decideThinkingPolicy('structuredGeneration', 'unknown-model-x');
      expect(decision).toEqual({ disableThinking: false, budgetMode: 'compact' });
    });

    it('qwen/glm（未来模型）：可关则关', () => {
      expect(decideThinkingPolicy('structuredGeneration', 'qwen-max').disableThinking).toBe(true);
      expect(decideThinkingPolicy('structuredGeneration', 'glm-4.6').disableThinking).toBe(true);
    });
  });

  describe('reasoning/default（交互场景：保留模型默认思考）', () => {
    it('reasoning × deepseek：不关思考', () => {
      expect(decideThinkingPolicy('reasoning', 'deepseek-v4-pro')).toEqual({ disableThinking: false, budgetMode: 'compact' });
    });

    it('default × gpt-5.5：不关思考', () => {
      expect(decideThinkingPolicy('default', 'gpt-5.5').disableThinking).toBe(false);
    });

    it('reasoning × gemini：不关思考、无告警（思考本可用）', () => {
      const decision = decideThinkingPolicy('reasoning', 'gemini-3.1-pro-preview');
      expect(decision.disableThinking).toBe(false);
      expect(decision.warning).toBeUndefined();
    });
  });

  describe('用户配置偏好（模型设置 thinking 选项）优先级高于任务策略', () => {
    it('disabled 强制关思考：可关模型即使 reasoning 任务也关', () => {
      const decision = decideThinkingPolicy('reasoning', 'deepseek-v4-pro', 'disabled');
      expect(decision).toEqual({ disableThinking: true, budgetMode: 'compact' });
    });

    it('enabled 强制开思考：结构化生成也保留思考（覆盖任务策略）', () => {
      const decision = decideThinkingPolicy('structuredGeneration', 'gpt-5.5', 'enabled');
      expect(decision).toEqual({ disableThinking: false, budgetMode: 'compact' });
    });

    it('disabled × 不可关模型（gemini 3.x）：忽略配置并告警降级', () => {
      const decision = decideThinkingPolicy('structuredGeneration', 'gemini-3.1-pro-preview', 'disabled');
      expect(decision.disableThinking).toBe(false);
      expect(decision.warning).toMatch(/已忽略.*强制关闭思考/);
    });

    it('follow-task（默认）：与未设置行为一致', () => {
      expect(decideThinkingPolicy('structuredGeneration', 'deepseek-v4-pro', 'follow-task'))
        .toEqual(decideThinkingPolicy('structuredGeneration', 'deepseek-v4-pro'));
    });
  });
});

describe('并发上限解除（用户既定决策：LLM 并发不受限）', () => {
  it('所有文档规模统一默认上限 64（不再 8/16/24/32 分档）', () => {
    for (const words of [2000, 20000, 50000, 100000, 200000]) {
      expect(concurrencyForDocumentScale(words)).toBeGreaterThanOrEqual(64);
    }
  });

  it('生成开始时并发上限保持 64，不随规模降档', () => {
    expect(raiseDocumentLlmConcurrencyForScale(200000)).toBeGreaterThanOrEqual(64);
    expect(getDocumentLlmMaxConcurrency()).toBeGreaterThanOrEqual(64);
  });
});

describe('providerFactoryName 协议与模型工厂映射', () => {
  it('deepseek 走专用 Provider（能力声明含真实 8192 上限）', () => {
    expect(providerFactoryName('deepseek-v4-pro', { protocol: 'openai' })).toBe('deepseek');
  });

  it('gpt-5.5 走 openai 兼容工厂', () => {
    expect(providerFactoryName('gpt-5.5', { protocol: 'openai' })).toBe('openai');
  });

  it('gemini 经 openai 协议网关走 openai 工厂', () => {
    expect(providerFactoryName('gemini-3.1-pro-preview', { protocol: 'openai' })).toBe('openai');
  });

  it('anthropic/google 协议原生映射', () => {
    expect(providerFactoryName('claude-sonnet-4-5', { protocol: 'anthropic' })).toBe('anthropic');
    expect(providerFactoryName('gemini-2.5-flash', { protocol: 'google' })).toBe('google');
  });
});
