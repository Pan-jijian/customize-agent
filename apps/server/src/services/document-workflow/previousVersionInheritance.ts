/** 版本继承（评分报告 v4 回退根因治理）：重生成从零开始，上一版已修好的成果（分项结构/数值口径/
 * 已修复问题）全部丢失，新版本重现旧缺陷（v3 已删的「异常低价计算方式」小节 v4 回归；v3 重写的
 * 施工方法分项结构 v4 回退为 2.1~2.4 四个大类）。
 * 本模块从上一版本成稿中确定性提取三层信号，仅作 LLM 生成参照注入（不直接复写正文）：
 * 1. 结构信号：H2~H4 标题骨架（大纲规划沿用参考——防止重规划丢失专业分项小节）；
 * 2. 事实信号：关键数值口径句（劳动力峰值/工期/建筑面积，与检测器同口径词面）；
 * 3. 一致性信号：上一版已知问题清单（新版负例约束，必须避免重犯）。
 * 旧版数据必须与项目资料一致方可沿用，不一致一律以项目资料为准。 */

import { isHardBannedSectionTitle } from './evidenceContentSafety';

export interface PreviousVersionSignals {
  versionTitle: string;
  completedAt: number;
  structureLines: string[];
  factLines: string[];
  issueLines: string[];
}

/** 上一版本同项目校验：模板与需求一致才允许继承（防同一项目根下其他招标文件的成稿串染——
 * 用户在同一知识库目录先后生成不同招标文件时，上一版可能是另一个项目的数据） */
export function isSameProjectPreviousVersion(item: { templateId?: string; requirement?: string }, input: { templateId: string; requirement?: string }): boolean {
  return (item.templateId || '') === input.templateId && (item.requirement || '').trim() === (input.requirement || '').trim();
}

/** 标题骨架提取：H2 章标题 + H3/H4 小节标题；复选框符号与 outline.ts stripCheckboxSymbols 同口径剥离；
 * 目录/附录类非正文标题不进入结构信号；商务条款串章标题（异常低价/电子保函等）与大纲过滤
 * 同口径排除——继承参照不得把上一版已串章的缺陷小节带回新版本 */
function previousStructureLines(markdown: string): string[] {
  const lines: string[] = [];
  for (const match of markdown.matchAll(/^#{2,4}\s+(.+)$/gmu)) {
    const title = (match[1] || '').replace(/[☑✓✔☐□☒○●◉◇◆]/gu, '').trim();
    if (!title) continue;
    if (/^(?:目录|参考文献|附录)/u.test(title)) continue;
    // 先剥小节编号前缀再判定（与 evidenceContentSafety.isQualificationSectionTitle 同口径）：
    // isHardBannedSectionTitle 的条款碎片分支针对 PDF 解析碎片（outline.ts 条款编号残留规则），
    // 会把去空格后的「1编制说明」类成稿 H2~H4 正常带编号标题误判为条款碎片；成稿标题编号是合法的
    const stripped = title.replace(/^\d{1,3}(?:[.．]\d{1,3})*[、.．]?\s*/u, '');
    if (isHardBannedSectionTitle(stripped)) continue;
    lines.push(title);
  }
  return [...new Set(lines)].slice(0, 80);
}

/** 关键数值口径句提取（仅提取不判定，与 resourceConsistencyIssues/跨章扫描同口径词面） */
function previousFactLines(markdown: string): string[] {
  const facts: string[] = [];
  const patterns = [
    /(?:劳动力|作业人员|施工人员|高峰期|高峰|峰值)[^。；\n\d]{0,18}?([\d,]+)\s*人/gu,
    /(?:总工期|计划工期|工期)[^。；\n\d]{0,12}?(\d{2,4})\s*(?:个)?(?:日历)?天/gu,
    /(?:总建筑面积|建筑面积)[^。；\n\d]{0,10}?([\d,]+(?:\.\d+)?)\s*(?:㎡|平方米|m2|m²)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      // 行边界定位必须覆盖匹配段本身：行首命中时 slice(0, match.index) 只会得到空行
      const lineStart = markdown.lastIndexOf('\n', match.index - 1) + 1;
      const nextBreak = markdown.indexOf('\n', match.index);
      const line = markdown.slice(lineStart, nextBreak < 0 ? undefined : nextBreak).trim().slice(0, 60);
      if (line && !facts.includes(line)) facts.push(line);
    }
  }
  return facts.slice(0, 12);
}

/** 继承提示词块：结构+事实+已知问题三层信号；LLM 只作参照不得照抄（旧版数值与资料矛盾时以资料为准） */
export function buildPreviousVersionInheritancePrompt(signals: PreviousVersionSignals): string {
  if (!signals) return '';
  const lines = [
    '【上一版本继承参考（仅作参照，必须与项目资料一致方可沿用；不一致处一律以项目资料为准）】',
    `上一版本文档《${signals.versionTitle}》的结构与关键口径如下：新版本应尽量保持结构延续性（评审机构按同结构对照评审），并避免重犯上一版已知问题。`,
  ];
  if (signals.structureLines.length > 0) {
    lines.push(`一、上一版本章节与小节结构（共 ${signals.structureLines.length} 项）：`);
    lines.push(...signals.structureLines.slice(0, 40).map(line => `  - ${line}`));
    lines.push('  要求：项目资料支撑相同的章节/小节结构尽量沿用（含施工方法章的专业分项小节），不得因重新规划而丢失上一版已有的专业分项小节。');
  }
  if (signals.factLines.length > 0) {
    lines.push('二、上一版本关键数值口径（数值必须以本项目资料为准，上一版数值仅作一致性参照）：');
    lines.push(...signals.factLines.map(line => `  - ${line}`));
    lines.push('  要求：全文同类数值只能有一个口径；上一版口径与项目资料一致时沿用，不一致时按资料修正。');
  }
  if (signals.issueLines.length > 0) {
    lines.push('三、上一版已知问题（新版必须避免重犯）：');
    lines.push(...signals.issueLines.slice(0, 12).map(line => `  - ${line}`));
  }
  return lines.join('\n');
}

/** 从上一版成稿记录提取继承信号；三层信号全空（无正文/无标题/无问题）时返回 null（不注入） */
export function extractPreviousVersionSignals(record: { title?: string; markdown?: string; warningIssues?: string[]; completedAt?: number }): PreviousVersionSignals | null {
  const markdown = record.markdown || '';
  if (!markdown.trim()) return null;
  const signals: PreviousVersionSignals = {
    versionTitle: record.title || '上一版本',
    completedAt: record.completedAt || 0,
    structureLines: previousStructureLines(markdown),
    factLines: previousFactLines(markdown),
    issueLines: (record.warningIssues || []).slice(0, 12),
  };
  if (signals.structureLines.length === 0 && signals.factLines.length === 0 && signals.issueLines.length === 0) return null;
  return signals;
}
