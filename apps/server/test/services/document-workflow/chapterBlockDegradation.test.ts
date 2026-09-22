/**
 * 4.55.30 章级显式降级（块失守不再导致整章丢弃）——正反例锚点。
 *
 * 实机事故（doc-1790115927170-f00280f9，巢湖模板）：34 个规划块仅 1 块（「主要施工内容」）失守，
 * 其余 33 块已成稿却被整章丢弃 → 目标 5.0 万字只成 3.36 万字、清单落位 52.8%、总分 85→83。
 * 本用例覆盖：
 * ① 正向：1 块失守 → 章照常以成功块成稿（失守块无正文、不填兜底）+ partial 阶段 + blocker 进终门禁；
 * ② 反向：全失败 / 0 成功块 → 仍整章阻断（不组装空章）；
 * ③ 反向：无失守块（或痕迹与正文不一致）→ 不降级、无 blocker（防误报）；
 * ④ C7 优先：末轮仅篇幅超产走 C7 对冲接纳，非篇幅类失守才走本降级（两条判据的衔接）；
 * ⑤ 原因文本单源：类别→人话映射与回退话术。
 */
import { describe, expect, it } from 'vitest';
import type { DocumentDraftChapter, DocumentFactsModel, ValidationIssue } from '@/services/document-workflow/types';
import {
  assessChapterBlockDegradation,
  attachChapterBlockDegradation,
  blockFailureReasonText,
  buildValidationIssues,
  chapterDegradationStageText,
  readChapterBlockDegradation,
  salvageChapterByOverProduceAcceptance,
} from '@/services/document-workflow/chapterGeneration';
import { blockDeliveryOutcomeStatus } from '@/services/document-workflow/finalize/repairRounds/repairOutcome';

/** 34 块中第 5 块（「主要施工内容」）失守的事故同形输入 */
function incidentShape() {
  const blockTitles = Array.from({ length: 34 }, (_, index) => (index === 4 ? '主要施工内容' : `主题块 ${index + 1}`));
  const sections: Array<string | undefined> = blockTitles.map((title, index) => (index === 4 ? undefined : `### ${title}\n\n${'本块正文。'.repeat(20)}`));
  const exhaustedBlocks = [{
    index: 4,
    title: '主要施工内容',
    failureKinds: ['density'],
    // 末轮尝试原文：C7 才会用它填回正文，本降级路径**绝不允许**把它写进章正文
    lastAttempt: '### 主要施工内容\n\n末轮尝试原文（密度不足，不得成文）',
    retryFeedback: '量化参数未落位：材料参数 3/5，密度缺口（1.5 个/千字）',
  }];
  return { blockTitles, sections, exhaustedBlocks };
}

/** 复刻 stageChapterLoop 章收口判定链（C7 先判 → 不适用才降级），用于端到端断言正反例 */
function closeChapter(input: { sections: Array<string | undefined>; blockTitles: string[]; exhaustedBlocks: Array<{ index: number; title?: string; failureKinds?: string[]; lastAttempt?: string; retryFeedback?: string }>; blockTargetWords: number[] }) {
  let llmContent: string | undefined;
  let degradation: ReturnType<typeof assessChapterBlockDegradation>;
  const acceptance = salvageChapterByOverProduceAcceptance({ sections: input.sections, exhaustedBlocks: input.exhaustedBlocks, blockTargetWords: input.blockTargetWords });
  if (acceptance) {
    llmContent = `## 测试章\n\n${acceptance.sections.join('\n\n')}`;
  } else {
    degradation = assessChapterBlockDegradation({ sections: input.sections, blockTitles: input.blockTitles, exhaustedBlocks: input.exhaustedBlocks });
    if (degradation) llmContent = `## 测试章\n\n${input.sections.filter((section): section is string => Boolean(section && section.trim())).join('\n\n')}`;
  }
  return { llmContent, degradation, acceptance };
}

function blockingIssuesFor(chapter: DocumentDraftChapter): ValidationIssue[] {
  return buildValidationIssues({ warnings: [], errors: [] }, { conflicts: [] } as unknown as DocumentFactsModel, [chapter])
    .filter(issue => issue.severity === 'blocker');
}

describe('4.55.30 assessChapterBlockDegradation（章级显式降级判据）', () => {
  it('正样本：34 块中 1 块失守 → 返回降级记录（计划数/丢弃块标题/失败原因），成功块不受影响', () => {
    const { sections, blockTitles, exhaustedBlocks } = incidentShape();
    const degradation = assessChapterBlockDegradation({ sections, blockTitles, exhaustedBlocks });
    expect(degradation).toBeDefined();
    expect(degradation?.plannedBlocks).toBe(34);
    expect(degradation?.deliveredBlocks).toBe(33);
    expect(degradation?.droppedBlocks).toHaveLength(1);
    expect(degradation?.droppedBlocks[0]?.index).toBe(4);
    expect(degradation?.droppedBlocks[0]?.title).toBe('主要施工内容');
    expect(degradation?.droppedBlocks[0]?.reason).toBe('量化参数密度不足');
    expect(blockDeliveryOutcomeStatus({ plannedBlocks: 34, droppedBlocks: 1 })).toBe('partial');
  });

  it('正样本：降级阶段文本为「N/M 块成稿、丢弃 X 块：<标题>」，并逐块给出失败原因/缺陷反馈', () => {
    const { sections, blockTitles, exhaustedBlocks } = incidentShape();
    const degradation = assessChapterBlockDegradation({ sections, blockTitles, exhaustedBlocks })!;
    const { head, details } = chapterDegradationStageText(degradation);
    expect(head).toBe('33/34 块成稿、丢弃 1 块：主要施工内容');
    const joined = details.join('\n');
    expect(joined).toContain('失守块「主要施工内容」（第 5/34 块）：量化参数密度不足');
    expect(joined).toContain('缺陷反馈：量化参数未落位');
    expect(joined).toContain('失守块不产出正文（不填充兜底内容）');
    expect(joined).toContain('导出门禁与交付复核清单');
  });

  it('正样本：端到端（C7 不适用 → 降级）章照常成稿，失守块无正文、末轮尝试原文不得混入', () => {
    const { sections, blockTitles, exhaustedBlocks } = incidentShape();
    const outcome = closeChapter({ sections, blockTitles, exhaustedBlocks, blockTargetWords: blockTitles.map(() => 2000) });
    expect(outcome.acceptance).toBeUndefined();
    expect(outcome.degradation).toBeDefined();
    expect(outcome.llmContent).toBeDefined();
    // 33 块正文 + 章标题，失守块标题不作为小节出现在正文里（只在元数据/记录中）
    expect(outcome.llmContent!.split('\n').filter(line => line.startsWith('### '))).toHaveLength(33);
    expect(outcome.llmContent!).not.toContain('末轮尝试原文');
    expect(outcome.llmContent!).not.toContain('主要施工内容');
    expect(blockDeliveryOutcomeStatus({ plannedBlocks: outcome.degradation!.plannedBlocks, droppedBlocks: outcome.degradation!.plannedBlocks - outcome.degradation!.deliveredBlocks })).toBe('partial');
  });

  it('负样本：全部块失守（34/34）→ 不降级（照旧章阻断，缺章节由缺章 blocker 呈现）', () => {
    const blockTitles = Array.from({ length: 34 }, (_, index) => `主题块 ${index + 1}`);
    const sections: Array<string | undefined> = blockTitles.map(() => undefined);
    const exhaustedBlocks = blockTitles.map((title, index) => ({ index, title, failureKinds: ['density'] }));
    expect(assessChapterBlockDegradation({ sections, blockTitles, exhaustedBlocks })).toBeUndefined();
    const outcome = closeChapter({ sections, blockTitles, exhaustedBlocks, blockTargetWords: blockTitles.map(() => 2000) });
    expect(outcome.llmContent).toBeUndefined(); // 不组装空章
    expect(outcome.degradation).toBeUndefined();
  });

  it('负样本：0 个成功块（3 块规划全失守）→ 不降级、不产出空章', () => {
    const blockTitles = ['块一', '块二', '块三'];
    const sections: Array<string | undefined> = [undefined, undefined, undefined];
    const exhaustedBlocks = blockTitles.map((title, index) => ({ index, title, failureKinds: ['under-produce'] }));
    expect(assessChapterBlockDegradation({ sections, blockTitles, exhaustedBlocks })).toBeUndefined();
  });

  it('负样本：无失守块（隔离重写已补回）→ 不降级；痕迹与正文不一致的块不计入丢弃', () => {
    const { blockTitles, sections } = incidentShape();
    expect(assessChapterBlockDegradation({ sections, blockTitles, exhaustedBlocks: [] })).toBeUndefined();
    // 痕迹存在但正文已补回（index 4 有正文）→ 该块不算失守 → 不降级
    const repaired = [...sections];
    repaired[4] = '### 主要施工内容\n\n隔离重写补回的正文。';
    expect(assessChapterBlockDegradation({ sections: repaired, blockTitles, exhaustedBlocks: [{ index: 4, title: '主要施工内容', failureKinds: ['density'] }] })).toBeUndefined();
  });

  it('边界：空 sections / 单块章（1 块规划）→ 不降级（无「部分」可保）', () => {
    expect(assessChapterBlockDegradation({ sections: [], blockTitles: [], exhaustedBlocks: [{ index: 0, failureKinds: ['density'] }] })).toBeUndefined();
    expect(assessChapterBlockDegradation({ sections: [undefined], blockTitles: ['唯一块'], exhaustedBlocks: [{ index: 0, failureKinds: ['density'] }] })).toBeUndefined();
  });
});

describe('4.55.30 降级记录 → 终门禁 blocker（buildValidationIssues）', () => {
  it('正样本：带降级记录的草稿章 → structure/blocker，消息含丢弃块标题与失败原因，定位到章与小节', () => {
    const { sections, blockTitles, exhaustedBlocks } = incidentShape();
    const degradation = assessChapterBlockDegradation({ sections, blockTitles, exhaustedBlocks })!;
    const chapter = attachChapterBlockDegradation({ id: 'chapter-1', title: '主要施工方法与技术措施', content: '## 主要施工方法与技术措施\n\n正文', evidence: [], missingFacts: [], sections: blockTitles }, degradation);
    expect(readChapterBlockDegradation(chapter)).toEqual(degradation);
    const issues = blockingIssuesFor(chapter);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.level).toBe('error');
    expect(issue.severity).toBe('blocker');
    expect(issue.category).toBe('structure');
    expect(issue.repairability).toBe('manual_review');
    expect(issue.chapterId).toBe('chapter-1');
    expect(issue.sectionTitle).toBe('主要施工内容');
    expect(issue.message).toContain('33/34 块成稿、丢弃 1 块：主要施工内容');
    expect(issue.message).toContain('量化参数密度不足');
    expect(issue.suggestion).toContain('主要施工内容');
    expect(issue.provenance?.detectorId).toBe('chapter-block-degradation');
  });

  it('负样本：无降级记录的草稿章 → 不产生任何 structure/blocker（防误报）', () => {
    const chapter: DocumentDraftChapter = { id: 'chapter-2', title: '正常章', content: '## 正常章\n\n正文', evidence: [], missingFacts: [], sections: ['小节 A'] };
    expect(blockingIssuesFor(chapter)).toHaveLength(0);
    expect(readChapterBlockDegradation(chapter)).toBeUndefined();
    // 有正文但无记录 → 同样零降级 blocker
    const { sections, blockTitles } = incidentShape();
    const filled = { id: 'chapter-3', title: '补回章', content: '## 补回章\n\n正文', evidence: [], missingFacts: [], sections: blockTitles, blockDegradation: { plannedBlocks: 34, droppedBlocks: [] } } as unknown as DocumentDraftChapter;
    expect(sections.length).toBe(34);
    expect(blockingIssuesFor(filled)).toHaveLength(0);
  });

  it('降级记录随草稿章节展开复制保留（修复轮 {...chapter} 不丢记录）', () => {
    const { sections, blockTitles, exhaustedBlocks } = incidentShape();
    const degradation = assessChapterBlockDegradation({ sections, blockTitles, exhaustedBlocks })!;
    const chapter = attachChapterBlockDegradation({ id: 'c', title: 't', content: 'x', evidence: [], missingFacts: [], sections: blockTitles }, degradation);
    const copied = { ...chapter, content: '修改后的正文' };
    expect(readChapterBlockDegradation(copied)).toEqual(degradation);
    expect(blockingIssuesFor(copied)).toHaveLength(1);
  });
});

describe('4.55.30 与 C7 超产对冲接纳的衔接（C7 优先）', () => {
  const blockTargetWords = [2000, 2000, 2000];

  it('末轮仅篇幅超产 → C7 接纳（chapters 走对冲路径，不落降级）', () => {
    // 章总量 6000 字 ∈ [0.85,1.2]×块预算合计 6000（C7 接纳区间）
    const sections: Array<string | undefined> = ['### A\n\n' + '正文内容。'.repeat(400), undefined, '### C\n\n' + '正文内容。'.repeat(400)];
    const exhaustedBlocks = [{ index: 1, title: 'B', failureKinds: ['over-produce'], lastAttempt: '### B\n\n' + '末轮超产正文。'.repeat(400) }];
    const acceptance = salvageChapterByOverProduceAcceptance({ sections, exhaustedBlocks, blockTargetWords });
    expect(acceptance).toBeDefined();
    // C7 接纳后失守块已有正文 → 降级判据自然不成立（判定链上 C7 先执行，两者互斥）
    expect(assessChapterBlockDegradation({ sections: acceptance!.sections, blockTitles: ['A', 'B', 'C'], exhaustedBlocks })).toBeUndefined();
  });

  it('非篇幅类失守（密度/结构）→ C7 拒收，降级接管（判据互斥，无重叠区间）', () => {
    const sections: Array<string | undefined> = ['### A\n\n' + '正文内容。'.repeat(500), undefined, '### C\n\n' + '正文内容。'.repeat(500)];
    const exhaustedBlocks = [{ index: 1, title: '主要施工内容', failureKinds: ['density'], lastAttempt: '### B\n\n内容偏少' }];
    expect(salvageChapterByOverProduceAcceptance({ sections, exhaustedBlocks, blockTargetWords })).toBeUndefined();
    expect(assessChapterBlockDegradation({ sections, blockTitles: ['A', '主要施工内容', 'C'], exhaustedBlocks })).toBeDefined();
  });

  it('篇幅超产但无末轮内容 → C7 拒收，降级接管（不因 C7 拒收而整章丢弃）', () => {
    const sections: Array<string | undefined> = ['### A\n\n' + '正文内容。'.repeat(500), undefined, '### C\n\n' + '正文内容。'.repeat(500)];
    const exhaustedBlocks = [{ index: 1, title: 'B', failureKinds: ['over-produce'] }];
    expect(salvageChapterByOverProduceAcceptance({ sections, exhaustedBlocks, blockTargetWords })).toBeUndefined();
    expect(assessChapterBlockDegradation({ sections, blockTitles: ['A', 'B', 'C'], exhaustedBlocks })).toBeDefined();
  });
});

describe('4.55.30 blockFailureReasonText（失败原因单源渲染）', () => {
  it('类别映射为人话；多类别并列；未知类别原样保留', () => {
    expect(blockFailureReasonText(['density'])).toBe('量化参数密度不足');
    expect(blockFailureReasonText(['over-produce', 'under-produce'])).toBe('篇幅超产、篇幅欠产');
    expect(blockFailureReasonText(['unknown-kind'])).toBe('unknown-kind');
  });

  it('无类别时回退缺陷反馈首段；两者皆无时给通用话术（原因字段永不为空）', () => {
    expect(blockFailureReasonText(undefined, '小节事实密度不足：材料参数 3/5')).toBe('小节事实密度不足：材料参数 3/5');
    expect(blockFailureReasonText([], '')).toBe('块质检未达标（无类别与反馈记录）');
  });
});
