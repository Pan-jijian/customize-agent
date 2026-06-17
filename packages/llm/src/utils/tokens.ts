import type { Message } from '@code-agent/types';

/**
 * 字符→token 换算系数。
 * 英文 ~4 字符/token，中文 ~1-2 字符/token，代码 ~3-4 字符/token。
 * 取 3.5 作为混合语言的中位保守估算（偏安全：略微高估 token 数，提前触发压缩/限流）。
 * 精确计数需调用各模型原生 tokenizer，此估算用于无 API 调用时的近似计算。
 */
const CHARS_PER_TOKEN = 3.5;

/** 估算文本 token 数（混合语言保守估算） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** 从 Message 数组估算 token 总数 */
export function countTokensFromMessages(messages: Message[]): number {
  const text = messages.map(m => m.content).join('\n');
  return estimateTokens(text);
}
