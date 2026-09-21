/**
 * 权威值占位符协议（G 线 P2-1）：**让计划类数值不经过 LLM 生成**。
 *
 * ## 要根治什么
 *
 * 计划的终极形态是「LLM 输出值引用占位符，由权威层确定性填充」——从架构上消除
 * 「先写错再改对」。现状是反过来的：LLM 先按自己的理解把峰值/工期/工程量写进正文，
 * 再由 `alignChapterContentToBlueprint`（P1-8）与 S5 引用判定把这些错值**纠回来**，
 * 纠不回的残留进终门禁。这条链上每一环都在赔偿同一个结构性错误：**数值的产出方不该是 LLM**。
 *
 * ## 协议
 *
 * 写作层被要求：凡计划类数值（总工期/劳动力峰值/养护期/工程量等**有权威源**的值），
 * 一律写成 `{{AUTH:<path>}}`，不得自行写数。生成后由 `fillAuthorityPlaceholders`
 * 用权威值确定性替换。path 与蓝图 `BlueprintRequiredParam.path` 同源，
 * 故「注入哪些 token」与「写后对齐哪些锚点」共用同一份权威域路由（见 P1-1 注册表）。
 *
 * ## 失效模式（关键设计约束）
 *
 * **LLM 不遵守协议时，结果必须降级为「今日行为」，而不是更差**：
 * - 没有占位符 → 填充是 no-op，正文与今天完全一致，仍由 P1-8 对齐网兜底；
 * - 写了占位符但 path 无权威值 → **不静默删除**，保留原样并计入 `unresolved` 上报
 *   （静默删除等于 P2-2 明令禁止的「以删除通过门禁」）；
 * - 写了畸形 token（如 `{{AUTH:}}`）→ 计入 `malformed` 上报，同样不擅自删改。
 *
 * 因此本机制**可以安全上线并逐步启用**：先注入协议让模型试用，实测遵守率后再决定是否
 * 让检测端把「残留占位符」列为阻断项。
 */
import type { BlueprintData } from './types';

/** 占位符 token 形态：`{{AUTH:<path>}}`。双花括号在正式中文正文里近乎不出现，冲突风险低 */
export const AUTHORITY_PLACEHOLDER_RE = /\{\{AUTH:([^}]*)\}\}/gu;

export interface AuthorityPlaceholderFillResult {
  markdown: string;
  /** 成功填入的 token（含 path 与填入值，供诊断） */
  filled: Array<{ path: string; value: string }>;
  /** path 有占位符但**无权威值**：原样保留并上报（不静默删除） */
  unresolved: string[];
  /** 畸形 token（空 path 等）：原样保留并上报 */
  malformed: string[];
}

/**
 * 权威值渲染（**单源**）：占位符填充与 `renderBlueprintMustCiteValues` 共用同一实现，
 * 避免「注入一个值、填充另一个值」的双份真相。返回 undefined 表示该 path 当前无权威值。
 */
export function renderAuthorityValue(path: string, data: BlueprintData): string | undefined {
  if (path === 'data.contract.total_days') {
    return data.contract.totalDays > 0 ? `${data.contract.totalDays} 日历天` : undefined;
  }
  if (path === 'data.resources.labor.peak_value') {
    return data.resources.labor.peakValue > 0 ? `${data.resources.labor.peakValue} 人` : undefined;
  }
  if (path === 'data.redline.greening_maintenance') {
    // 红线事实按 key 匹配（amount 类为商务禁区，渲染正文时跳过——与 renderBlueprintMustCiteValues 同口径）
    const fact = (data.redLineFacts ?? []).find(item => !item.amount && /养护|苗木|绿化/u.test(item.key));
    return fact?.value ? String(fact.value) : undefined;
  }
  if (path.startsWith('data.quantities.')) {
    const quantity = data.quantities?.[path.slice('data.quantities.'.length)];
    return quantity && quantity.value > 0 ? `${quantity.value}${quantity.unit ?? ''}` : undefined;
  }
  return undefined;
}

/**
 * 占位符确定性填充。纯字符串变换，无 LLM、无 IO——可被任意链路安全调用（幂等：
 * 已填充的正文不含 token，二次调用 no-op）。
 */
export function fillAuthorityPlaceholders(markdown: string, data?: BlueprintData): AuthorityPlaceholderFillResult {
  const filled: Array<{ path: string; value: string }> = [];
  const unresolved: string[] = [];
  const malformed: string[] = [];
  if (!data) {
    // 无蓝图数据时不做任何替换，但把 token 全数登记为未决——静默留着会让用户看到 {{AUTH:...}}
    for (const match of markdown.matchAll(AUTHORITY_PLACEHOLDER_RE)) {
      const path = (match[1] ?? '').trim();
      (path ? unresolved : malformed).push(path || match[0]);
    }
    return { markdown, filled, unresolved, malformed };
  }
  const next = markdown.replace(AUTHORITY_PLACEHOLDER_RE, (token, rawPath: string) => {
    const path = (rawPath ?? '').trim();
    if (!path) { malformed.push(token); return token; }
    const value = renderAuthorityValue(path, data);
    if (!value) { unresolved.push(path); return token; }
    filled.push({ path, value });
    return value;
  });
  return { markdown: next, filled, unresolved, malformed };
}

/**
 * 注入给写作层的占位符目录：列出本章**可用**的 token 及其权威值预览。
 *
 * 只列有权威值的 path —— 列了却没有值的 token 会诱导模型写出无法填充的占位符，
 * 最终以未决形式上报警告，属自造噪声。
 */
export function renderAuthorityPlaceholderCatalog(paths: string[], data: BlueprintData): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const value = renderAuthorityValue(path, data);
    if (!value) continue;
    lines.push(`- \`{{AUTH:${path}}}\` → ${value}`);
  }
  return lines;
}
