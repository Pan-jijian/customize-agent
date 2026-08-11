/**
 * Token 感知的预算管理器
 *
 * 替代所有粗暴的 slice(0, N) 截断。
 *
 * 核心原则：
 * 1. 对于 LLM 输入 — 使用 token 计数 + 语义边界（段落/句子）截断
 * 2. 对于数组 — 使用 selectByScore 评分排序后选择
 * 3. 对于显示文本 — 明确标注为 display truncation
 * 4. 所有截断都必须记录丢弃日志
 */

import { selectByScore, type SelectionResult } from './selection';

/** 粗略估算中文文本的 token 数（中文 ≈1.5 字符/token，英文 ≈4 字符/token） */
export function estimateTokens(text: string): number {
  let chineseChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    if (/[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/u.test(ch)) {
      chineseChars += 1;
    } else {
      otherChars += 1;
    }
  }
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 在 token 预算内安全截断文本
 * - 优先在段落边界（双换行）处截断
 * - 其次在句子边界（。；）处截断
 * - 记录丢弃的字符数
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  label = 'text',
): { truncated: string; droppedChars: number; droppedLog: string } {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return { truncated: text, droppedChars: 0, droppedLog: '' };

  // 按段落分割，逐段累加直到接近预算
  const paragraphs = text.split(/\n{2,}/u);
  let result = '';
  let currentTokens = 0;
  let droppedChars = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (currentTokens + paraTokens <= maxTokens) {
      result += (result ? '\n\n' : '') + para;
      currentTokens += paraTokens;
    } else {
      // 尝试在句子边界截断最后一个段落
      const sentences = para.split(/(?<=[。；])/u);
      let partialPara = '';
      for (const sent of sentences) {
        const sentTokens = estimateTokens(sent);
        if (currentTokens + sentTokens <= maxTokens) {
          partialPara += sent;
          currentTokens += sentTokens;
        } else {
          droppedChars += sent.length;
        }
      }
      if (partialPara) result += (result ? '\n\n' : '') + partialPara;
      break;
    }
  }

  // 准确计算丢弃字符数
  droppedChars = text.length - result.length;
  const droppedLog = droppedChars > 0
    ? `[token-budget] ${label}: 预算 ${maxTokens} tokens → 保留 ${estimateTokens(result)} tokens，丢弃 ${droppedChars} 字符`
    : '';

  return { truncated: result, droppedChars, droppedLog };
}

/**
 * 在 token 预算内从数组中评分选择最重要的项
 * 这是 selectByScore 的 token 感知包装
 */
export function selectForTokenBudget<T>(
  items: T[],
  scoreFn: (item: T) => number,
  maxTokens: number,
  formatFn: (item: T) => string = item => String(item),
  label = 'items',
): SelectionResult<T> & { totalTokens: number } {
  const result = selectByScore(
    items,
    scoreFn,
    {
      maxItems: items.length, // 不按数量截断
      maxChars: maxTokens * 2, // 粗略估算：2 字符 ≈ 1 token
      charFn: item => estimateTokens(formatFn(item)),
    },
    label,
  );

  return {
    ...result,
    totalTokens: result.selected.reduce((sum, item) => sum + estimateTokens(formatFn(item)), 0),
  };
}
