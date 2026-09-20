/**
 * canonicalTermAnchors 单测：规范术语显性落位链尾兜底——sectionRe 精准落点优先、章级回退
 * （术语零标题可依时落章内首个小节/章标题后）、lead 前缀幂等重放、drafts 同步（H4 三级编号
 * 差异与 H2 章号差异按去编号标题体回退；另见扬尘章级回退落地与 isolateCanonicalAnchorLines
 * 锚句行独立化用例）。全部为通用工程形态，无项目专名。
 */
import { describe, expect, it } from 'vitest';
import { CANONICAL_TERM_ANCHORS, enforceCanonicalTermAnchorsInSections, isolateCanonicalAnchorLines } from '@/services/document-workflow/finalize/repairRounds/canonicalTermAnchors';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

function draftChapter(title: string, content: string): DocumentDraftChapter {
  return { id: 'ch-1', title, content, evidence: [], missingFacts: [] };
}

const EMERGENCY_LEAD = '生产安全事故应急预案与应急演练：开工前完成应急预案编制，明确应急响应流程与处置措施，按计划组织演练并复盘修订。';
const HAZARD_LEAD = '危险源辨识与风险识别评估：施工前对作业面逐项开展辨识评估，形成危险源清单并落实分级管控措施。';
const DISCLOSURE_LEAD = '安全技术交底：各分项工程施工前对作业人员进行安全技术交底，交底双方签字确认后组织实施。';

describe('enforceCanonicalTermAnchorsInSections', () => {
  it('sectionRe 全级落空时章级回退：锚句落在匹配章的章内首个小节标题后', () => {
    const markdown = ['# 总则', '', '## 安全保证措施', '', '### 现场安全管理', '', '正文内容。'].join('\n');
    const result = enforceCanonicalTermAnchorsInSections({ markdown, chapters: [] });
    expect(result).not.toBeNull();
    const lines = result!.markdown.split('\n');
    const heading = lines.findIndex(line => line.trim() === '### 现场安全管理');
    expect(heading).toBeGreaterThanOrEqual(0);
    // 应急预案（sectionRe 无匹配 → fallbackChapterRe 命中）与危险源（tier 宽松匹配）均落该小节后
    const emergency = lines.findIndex(line => line.startsWith('生产安全事故应急预案与应急演练：'));
    const hazard = lines.findIndex(line => line.startsWith('危险源辨识与风险识别评估：'));
    expect(emergency).toBeGreaterThan(heading);
    expect(hazard).toBeGreaterThan(heading);
    // 锚句为标题行后独立段落（标题 / 空行 / 锚句）
    expect(lines[emergency - 1]).toBe('');
  });

  it('sectionRe 精准命中时不走章级回退：锚句落在强语义小节后', () => {
    const markdown = ['# 总则', '', '## 安全保证措施', '', '### 现场安全管理', '', '正文一。', '', '### 应急预案管理', '', '正文二。'].join('\n');
    const result = enforceCanonicalTermAnchorsInSections({ markdown, chapters: [] });
    expect(result).not.toBeNull();
    const lines = result!.markdown.split('\n');
    const emergencyHeading = lines.findIndex(line => line.trim() === '### 应急预案管理');
    expect(lines[emergencyHeading + 2]).toMatch(/^生产安全事故应急预案与应急演练：/u);
    // 章节结构不被改动：原文小节标题与正文仍在
    expect(lines.some(line => line.trim() === '### 现场安全管理')).toBe(true);
    expect(lines.some(line => line.trim() === '正文二。')).toBe(true);
  });

  it('lead 前缀已在全文出现：幂等跳过（重放不重复插入）', () => {
    const markdown = [
      '# 总则', '',
      '## 安全保证措施', '',
      '### 现场安全管理', '',
      EMERGENCY_LEAD, '',
      HAZARD_LEAD, '',
      DISCLOSURE_LEAD,
    ].join('\n');
    expect(enforceCanonicalTermAnchorsInSections({ markdown, chapters: [] })).toBeNull();
  });

  it('drafts 同步：H4 在正文已编号（#### 5.1.2 …）、drafts 无编号时按标题体回退落入章 content', () => {
    const markdown = ['# 总则', '', '## 劳动力安排计划', '', '### 5.1 用工配置', '', '#### 5.1.2 薪酬兑付管理', '', '正文内容。'].join('\n');
    const draft = draftChapter('劳动力安排计划', ['## 劳动力安排计划', '', '### 5.1 用工配置', '', '#### 薪酬兑付管理', '', '正文内容。'].join('\n'));
    const result = enforceCanonicalTermAnchorsInSections({ markdown, chapters: [draft] });
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('农民工工资专用账户与工资支付保障：');
    const draftLines = draft.content.split('\n');
    const idx = draftLines.findIndex(line => line.trim() === '#### 薪酬兑付管理');
    expect(idx).toBeGreaterThanOrEqual(0);
    // 锚句落 drafts 对应小节标题后（标题 / 空行 / 锚句）
    expect(draftLines[idx + 2]).toMatch(/^农民工工资专用账户与工资支付保障：/u);
  });

  it('章级回退无小节时锚句落章标题后，drafts 章首 H2（无章号）同步', () => {
    const markdown = ['# 总则', '', '## 第七章 安全保证措施', '', '正文内容。'].join('\n');
    const draft = draftChapter('安全保证措施', ['## 安全保证措施', '', '正文内容。'].join('\n'));
    const result = enforceCanonicalTermAnchorsInSections({ markdown, chapters: [draft] });
    expect(result).not.toBeNull();
    const lines = result!.markdown.split('\n');
    const h2 = lines.findIndex(line => line.trim() === '## 第七章 安全保证措施');
    expect(lines.slice(h2, h2 + 10).some(line => line.startsWith('生产安全事故应急预案与应急演练：'))).toBe(true);
    const draftLines = draft.content.split('\n');
    expect(draftLines.slice(0, 10).some(line => line.startsWith('生产安全事故应急预案与应急演练：'))).toBe(true);
  });

  it('扬尘锚术语零标题可依时走章级回退（fallbackChapterRe 命中文明施工章，落章内首个 H3 后）', () => {
    const markdown = ['# 总则', '', '## 第九章 确保文明施工的技术组织措施', '', '### 文明施工管理', '', '文明施工按标准执行。'].join('\n');
    const result = enforceCanonicalTermAnchorsInSections({ markdown, chapters: [] });
    expect(result).not.toBeNull();
    expect(result!.inserted).toHaveLength(1);
    const lines = result!.markdown.split('\n');
    const h3 = lines.findIndex(line => line.trim() === '### 文明施工管理');
    expect(h3).toBeGreaterThanOrEqual(0);
    expect(lines[h3 + 2]).toMatch(/^扬尘污染防治措施：/u);
  });
});

describe('isolateCanonicalAnchorLines（锚句行独立化：补空行不改字）', () => {
  const dustLead = CANONICAL_TERM_ANCHORS.find(anchor => anchor.probe === '扬尘污染防治')!.lead;
  const stripBlank = (text: string) => text.split('\n').filter(line => line.trim() !== '').join('\n');

  it('锚句行前后粘连正文时补空行独立成段（前 1 后 1，共 2 处）', () => {
    const markdown = ['# 总则', '', '## 第九章 确保文明施工的技术组织措施', '文明施工按标准执行。', dustLead, '后续正文内容。', '', '## 第十章 竣工验收'].join('\n');
    const result = isolateCanonicalAnchorLines(markdown);
    expect(result.isolated).toBe(2);
    const lines = result.markdown.split('\n');
    const anchor = lines.findIndex(line => line.trim().startsWith(dustLead.slice(0, 20)));
    expect(anchor).toBeGreaterThan(0);
    expect(lines[anchor]).toBe(dustLead);
    expect(lines[anchor - 1]).toBe('');
    expect(lines[anchor + 1]).toBe('');
  });

  it('幂等：复跑零变更（isolated=0，输出全等）', () => {
    const markdown = ['# 总则', '', '文明施工按标准执行。', dustLead, '后续正文内容。'].join('\n');
    const first = isolateCanonicalAnchorLines(markdown);
    expect(first.isolated).toBe(2);
    const second = isolateCanonicalAnchorLines(first.markdown);
    expect(second.isolated).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });

  it('不改字：除空行增减外字符序列全等', () => {
    const markdown = ['# 总则', '', '文明施工按标准执行。', dustLead, '后续正文内容。', '', '其他段落。'].join('\n');
    const result = isolateCanonicalAnchorLines(markdown);
    expect(stripBlank(result.markdown)).toBe(stripBlank(markdown));
  });

  it('无锚句行零变更；文首锚句仅补后空行', () => {
    const plain = ['# 总则', '', '普通正文内容。'].join('\n');
    const none = isolateCanonicalAnchorLines(plain);
    expect(none.isolated).toBe(0);
    expect(none.markdown).toBe(plain);
    const head = isolateCanonicalAnchorLines([dustLead, '后续正文。'].join('\n'));
    expect(head.isolated).toBe(1);
    expect(head.markdown.split('\n')[1]).toBe('');
  });
});
