/**
 * 中文文本匹配工具
 *
 * 解决硬编码 slice(0, N) 在中文字符串匹配中的问题：
 * - 中文词语长度不固定（"土建"2字、"混凝土"3字、"钢结构安装"5字）
 * - 固定截断必然有漏配或误配
 * - 需要基于分词或最长公共子串的语义匹配
 */

/** 从中文文本中提取有意义的 token（2字及以上，去重） */
export function chineseTokens(text: string): string[] {
  // 按中文标点、空格、数字分割
  const raw = text.split(/[，。；：、\s\d（）()《》<>【】"“”'‘’\-/\\|,.:;]+/u).filter(Boolean);
  const tokens = new Set<string>();
  for (const segment of raw) {
    const cleaned = segment.trim();
    if (cleaned.length >= 2) tokens.add(cleaned);
    // 同时对较长的段提取 2-4 字滑动窗口作为补充 token
    if (cleaned.length >= 3) {
      for (let i = 0; i <= cleaned.length - 2; i++) {
        const window = cleaned.slice(i, i + 2);
        if (window.length >= 2 && !/^[a-zA-Z0-9]+$/u.test(window)) tokens.add(window);
      }
    }
  }
  return [...tokens];
}

/**
 * 计算两个中文文本的 token 级匹配分数
 * 返回 0-1 之间的值，≥0.3 视为匹配
 */
export function chineseTokenMatchScore(a: string, b: string): number {
  const tokensA = new Set(chineseTokens(a));
  const tokensB = new Set(chineseTokens(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let hits = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) hits += 1;
    // 模糊匹配：A 的 token 是 B 的 token 的子串或反之
    else if (token.length >= 2) {
      for (const bToken of tokensB) {
        if (bToken.length >= 2 && (bToken.includes(token) || token.includes(bToken))) {
          hits += 0.5;
          break;
        }
      }
    }
  }
  return hits / Math.max(tokensA.size, 1);
}

/**
 * 判断两个中文文本是否基于 token 匹配
 * @param threshold 匹配阈值，默认 0.3
 */
export function chineseTokenMatch(a: string, b: string, threshold = 0.3): boolean {
  return chineseTokenMatchScore(a, b) >= threshold;
}

/**
 * 安全截断：对于中文字符串，使用字符数而非字节数
 * 保留以备将来需要安全显示中文文本的场景使用
 */
export function safeTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}
