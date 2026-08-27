import type { ThinkingCapability } from './interface.js';

/**
 * 模型思考画像注册表（按模型名前缀正则匹配，唯一事实源）。
 *
 * 设计原则：
 * 1. 思考策略按模型能力自适应——deepseek/gpt-5.5 可关、gemini 3.x 不可关，
 *    调用方（如文档生成管线）通过 disableThinking 表达"此任务不需要思维链"，
 *    provider 层按画像翻译成对应厂商参数；不可关的模型显式抛错而不是静默失败。
 * 2. 新增模型（通义千问、智谱 GLM 等）只需在此追加一条画像，
 *    接入时按官方文档验证 disable 参数格式与 budgetPolicy 后修正。
 * 3. budgetPolicy 决定预算策略：shared（思考与正文共享输出池，如 DeepSeek 8192）
 *    关不掉思考时正文预算必须放大；separate（思考独立预算，如 Gemini/GPT-5）
 *    思考不抢正文池，只影响耗时。
 */
export const MODEL_THINKING_PROFILES: Array<{ pattern: RegExp; thinking: ThinkingCapability }> = [
  {
    // DeepSeek 推理模型：思考默认开启（effort=high），与正文共享 8192 输出池；
    // 官方 API 支持 extra_body {"thinking":{"type":"disabled"}} 硬关
    pattern: /deepseek/iu,
    thinking: { defaultEnabled: true, disable: 'deepseek-thinking', budgetPolicy: 'shared' },
  },
  {
    // OpenAI GPT-5 系列推理模型：默认 medium，reasoning.effort=none 等同非推理模型
    pattern: /^gpt-|o[1-9]\d*/iu,
    thinking: { defaultEnabled: true, disable: 'openai-reasoning-effort', budgetPolicy: 'separate' },
  },
  {
    // Gemini 3/3.1 Pro：官方文档明确无法关闭思考（仅 thinking_level 调强度）
    pattern: /gemini-3/iu,
    thinking: { defaultEnabled: true, disable: 'unsupported', budgetPolicy: 'separate' },
  },
  {
    // Gemini 2.5 系列：thinkingBudget=0 可关思考（3.x 忽略此参数，故 3.x 单独注册为 unsupported）
    pattern: /gemini/iu,
    thinking: { defaultEnabled: true, disable: 'gemini-budget', budgetPolicy: 'separate' },
  },
  {
    // 通义千问 Qwen3 混合推理模型：enable_thinking=false 关思考（接入时验证参数名）
    pattern: /qwen/iu,
    thinking: { defaultEnabled: false, disable: 'qwen-enable-thinking', budgetPolicy: 'separate' },
  },
  {
    // 智谱 GLM：thinking {type:disabled} 关思考（接入时按官方文档验证）
    pattern: /glm/iu,
    thinking: { defaultEnabled: true, disable: 'glm-thinking', budgetPolicy: 'separate' },
  },
];

/** 按模型名匹配思考画像；未注册的模型返回 undefined（调用方按"未知"保守处理） */
export function thinkingCapabilityForModel(modelName: string): ThinkingCapability | undefined {
  const normalized = modelName.toLowerCase();
  const hit = MODEL_THINKING_PROFILES.find(entry => entry.pattern.test(normalized));
  return hit?.thinking;
}

/**
 * 把 disableThinking 请求翻译为厂商原生请求体字段（顶层合并）。
 * 不可关的模型抛显式能力错误；未注册画像的模型不注入参数（保持厂商默认行为）。
 */
export function thinkingDisableBody(modelName: string): Record<string, unknown> | null {
  const capability = thinkingCapabilityForModel(modelName);
  if (!capability) return null;
  switch (capability.disable) {
    case 'deepseek-thinking':
      return { thinking: { type: 'disabled' } };
    case 'openai-reasoning-effort':
      return { reasoning: { effort: 'none' } };
    case 'qwen-enable-thinking':
      return { enable_thinking: false };
    case 'glm-thinking':
      return { thinking: { type: 'disabled' } };
    case 'gemini-budget':
      // 3.x 忽略此参数，但保留翻译以兼容 2.5 系列；3.x 场景由调用方走 relaxed 预算+告警
      return { thinkingBudget: 0 };
    case 'unsupported':
      throw new Error(`模型 ${modelName} 不支持关闭思考（Gemini 3/3.1 Pro 官方限制）：生成任务建议切换 deepseek 或 gpt 系列模型`);
    default:
      return null;
  }
}
