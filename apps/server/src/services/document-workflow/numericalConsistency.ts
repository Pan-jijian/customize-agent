import { PRECISE_TOKEN_RE } from './parameterPatterns';

/**
 * 数值一致性核验公共模块（P4 落位核验 / P1 大纲对账 / P5 重写保护 / P8 补写禁写 共享地基）。
 * 全部为确定性提取与对账，零 LLM 调用。
 */

/** 中文单位量化值补充提取：PRECISE_TOKEN_RE 单位组后跟 \b，中文单位（日历天/台/套/个等）后接中文标点时
 * \b 不成立（两侧均非 \w），导致「540日历天」「3台」类工期/数量参数漏提；用标点/空白/结尾前瞻替代尾部 \b。
 * （与 chapterGeneration 内 CHINESE_UNIT_TOKEN_RE 同口径） */
const CHINESE_UNIT_TOKEN_RE = /\b\d+(?:\.\d+)?\s*(?:日历天|小时|分钟|天|周|月|年|万元|元|台|套|个|项|批|次|份|人)(?=[。，,；;：:、\s]|$)/gu;

/** 从任意文本提取数值型 token（与精确参数提取同口径：数值+单位/规范编号/尺寸连乘/中文单位） */
export function extractNumericTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const match of text.matchAll(PRECISE_TOKEN_RE)) tokens.add(match[0].trim());
  for (const match of text.matchAll(CHINESE_UNIT_TOKEN_RE)) tokens.add(match[0].trim());
  return [...tokens];
}

/** 数值 token 的数值核心（比对数字是否一致，忽略单位与大小写差异）："20mm" → "20"，"C30" → "30" */
function numericCore(token: string): string {
  const match = token.match(/\d+(?:\.\d+)?/u);
  return match ? match[0] : token.trim();
}

/** 数值 token 的类型签名（数字替换为 #）："C30" → "C#"，"20mm" → "#MM"，用于同型不同值判定 */
function tokenSignature(token: string): string {
  return token.replace(/\d+(?:\.\d+)?/gu, '#').toUpperCase();
}

/** token 所在紧邻上下文（前后各 4 字符），用于"同位置不同值"判定。
 * 窗口刻意收紧：10 字符窗口会把"本工程采用/混凝土养护"等通用前缀拉进比较范围，
 * 导致不同位置的不同值被误判为同位置写错（4 字符窗口下"模板拆除"vs"砌体养护"不重叠）。 */
function contextAround(text: string, token: string): { before: string; after: string } {
  const index = text.indexOf(token);
  if (index < 0) return { before: '', after: '' };
  return {
    before: text.slice(Math.max(0, index - 4), index),
    after: text.slice(index + token.length, Math.min(text.length, index + token.length + 4)),
  };
}

/** 两段文本的最长公共连续汉字子串长度（同位置判定：连续重合 ≥3 个汉字才算同位置）。
 * 集合重叠会把"采用/养护"等分散高频字计入，连续子串要求位置与顺序双重一致。
 * 亦被概况复述检测（detectors.overviewRecapIssues）复用为逐字搬用判定。 */
export function longestCommonHanSubstring(left: string, right: string): number {
  const a = left.match(/[\p{Script=Han}]/gu) || [];
  const b = right.match(/[\p{Script=Han}]/gu) || [];
  if (a.length === 0 || b.length === 0) return 0;
  let best = 0;
  const dp = new Array<number>(b.length).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    let prev = 0;
    for (let j = 0; j < b.length; j += 1) {
      const carry = dp[j];
      dp[j] = a[i] === b[j] ? prev + 1 : 0;
      prev = carry;
      if (dp[j] > best) best = dp[j];
    }
  }
  return best;
}

export interface NumericReconciliation {
  /** 与证据逐字命中（注入证据或完整证据池）的数值 token */
  confirmed: string[];
  /** 同位置不同值：上下文命中但数值不符（确定性错误的强信号） */
  mismatched: Array<{ found: string; expected: string }>;
  /** 完全无源数值（疑似编造，弱信号，不阻断只观测） */
  unsourced: string[];
}

/**
 * 正文数值与证据侧对账：
 * - confirmed：数值核心在注入证据或完整证据池中命中；
 * - mismatched：数值核心未命中，但同类型签名在证据池中存在且上下文重叠（同位置不同值）；
 * - unsourced：完全无源。
 * 全部只做标记不删改正文，响应策略由调用方决定。
 */
export function reconcileContentNumbers(content: string, evidenceText: string, evidencePoolText = ''): NumericReconciliation {
  const contentTokens = extractNumericTokens(content);
  const evidenceTokens = extractNumericTokens(evidenceText);
  const evidenceCores = new Set(evidenceTokens.map(numericCore));
  const poolTokens = evidencePoolText ? extractNumericTokens(evidencePoolText) : [];
  const poolCores = evidencePoolText ? new Set(poolTokens.map(numericCore)) : evidenceCores;
  const sameTypeTokens = new Map<string, string[]>();
  for (const token of [...evidenceTokens, ...poolTokens]) {
    const signature = tokenSignature(token);
    const list = sameTypeTokens.get(signature) || [];
    list.push(token);
    sameTypeTokens.set(signature, list);
  }
  const confirmed: string[] = [];
  const mismatched: Array<{ found: string; expected: string }> = [];
  const unsourced: string[] = [];
  const poolText = evidencePoolText || evidenceText;
  for (const token of contentTokens) {
    const core = numericCore(token);
    if (evidenceCores.has(core) || poolCores.has(core)) {
      confirmed.push(token);
      continue;
    }
    const sameType = sameTypeTokens.get(tokenSignature(token)) || [];
    const contentCtx = contextAround(content, token);
    let bestCandidate = '';
    let bestOverlap = 0;
    for (const candidate of sameType) {
      const poolCtx = contextAround(poolText, candidate);
      const overlap = Math.max(
        longestCommonHanSubstring(contentCtx.before, poolCtx.before),
        longestCommonHanSubstring(contentCtx.after, poolCtx.after),
      );
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCandidate = candidate;
      }
    }
    if (sameType.length > 0 && bestOverlap >= 3) {
      mismatched.push({ found: token, expected: bestCandidate });
    } else {
      unsourced.push(token);
    }
  }
  return { confirmed, mismatched, unsourced };
}

/** 渲染核验反馈（用于质检重试 feedback 拼接）：错误数值修正指令 + 正确数值保留清单 */
export function renderNumericFeedback(reconciliation: NumericReconciliation, correctCap = 20): string {
  const parts: string[] = [];
  if (reconciliation.mismatched.length > 0) {
    parts.push(`【数值核对不通过——必须修正】正文以下数值与绑定材料不一致：${reconciliation.mismatched.map(item => `${item.found}→${item.expected}`).join('、')}。逐处改回材料原值，不得保留错误数值。`);
  }
  if (reconciliation.confirmed.length > 0) {
    parts.push(`【已核验正确的数值——重写时必须原样保留，不得改动】${reconciliation.confirmed.slice(0, correctCap).join('、')}。`);
  }
  return parts.join('\n');
}
