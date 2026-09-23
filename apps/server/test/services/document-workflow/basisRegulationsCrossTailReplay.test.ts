/**
 * 链尾编制依据引用小句回补（4.55.31 巢湖终稿 22 处缺口归因：回退/清洗损伤）。
 *
 * 缺陷链：`stageBasisRegulationsCrossRepair` Phase B 以「…按《X》（编号）控制…」形态把声明条目
 * 补进章草稿（阶段 success、复检清零），其后的链尾确定性清洗
 * （runSurfaceDeterministicCleans → fixFormalSourceResidue → materialResidue.stripDrawingPointerPhrases）
 * 的 `POINTER_CLAUSE_PATTERNS[0]`（锚词＋《书名号》）比检测端判据宽，把这类引用小句**整句删除**；
 * 清洗在最后一次净变更点之后执行、其后无重建无重放 → 「报告说改了、产物里没有」。
 *
 * 处置：链尾以章草稿为源，把「由《标准名》（编号）引用触发被误删、且该标准已在编制依据声明」的
 * 小句按清洗后形态精确对齐回插；真指向（图集号/按图纸/缺资料）照旧不回补。
 * 断言：正例回补 1 处、负例零回补、清洗后形态已被后续轮次改写时绝不猜写。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/rolePipeline', () => ({
  repairChapterByQuality: vi.fn(),
  repairPatchGuard: vi.fn(() => undefined),
}));

import { replayTailStrippedBasisCitations } from '@/services/document-workflow/finalize/repairRounds/basisRegulationsCrossRepair';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const DECLARATION = [
  '## 第1章 编制依据',
  '《建筑地基基础工程施工质量验收标准》（GB 50202-2018）',
].join('\n');

/** 章草稿（含引用小句）与交付 markdown（清洗后，引用小句被整句删除） */
const DRAFT_WITH_CITATION = [
  '## 第2章 基础施工',
  '桩位偏差与基底标高按《建筑地基基础工程施工质量验收标准》（GB 50202-2018）控制，验收记录由质检员按检验批签认。',
].join('\n');
const MARKDOWN_STRIPPED = [
  DECLARATION,
  '',
  '## 第2章 基础施工',
  '验收记录由质检员按检验批签认。',
].join('\n');

function makeSession(chapters: Array<{ id: string; title: string; content: string }>, finalMarkdown: string) {
  return {
    finalMarkdown,
    finalChapterDrafts: chapters.map(chapter => ({ ...chapter, evidence: [], missingFacts: [], sections: [] })),
  } as unknown as FinalizeSession;
}

describe('链尾编制依据引用回补（markdown-only 确定性重放）', () => {
  it('正例：由引用触发被清洗误删的引用小句按清洗后形态精确回插（标准已在声明侧）', () => {
    const session = makeSession([{ id: 'ch2', title: '基础施工', content: DRAFT_WITH_CITATION }], MARKDOWN_STRIPPED);
    const result = replayTailStrippedBasisCitations(session);
    expect(result.restored).toBe(1);
    expect(result.markdown).toContain('桩位偏差与基底标高按《建筑地基基础工程施工质量验收标准》（GB 50202-2018）控制');
    expect(result.markdown).toContain('验收记录由质检员按检验批签认。');
    expect(result.labels).toContain('GB50202-2018');
    // 只重放正文：声明侧区段原样保留
    expect(result.markdown).toContain('## 第1章 编制依据');
  });

  it('负例：真指向（图集号引用替代做法）不回补——回补会引入检测端 blocker', () => {
    const draft = [
      '## 第2章 检查井施工',
      '具体做法参见《钢筋混凝土及砖砌排水检查井》20S515/29，井筒砌筑按图集分层错缝进行。',
    ].join('\n');
    const finalMarkdown = [
      DECLARATION,
      '',
      '## 第2章 检查井施工',
      '井筒砌筑按图集分层错缝进行。',
    ].join('\n');
    const result = replayTailStrippedBasisCitations(makeSession([{ id: 'ch2', title: '检查井施工', content: draft }], finalMarkdown));
    expect(result.restored).toBe(0);
    expect(result.markdown).toBe(finalMarkdown);
  });

  it('负例：引用未在声明侧（未声明标准）不回补——避免制造新的对账口径来源', () => {
    const draft = [
      '## 第2章 基础施工',
      '桩位偏差按《建筑地基基础工程施工质量验收标准》（GB 50202-2018）控制，验收记录由质检员签认。',
    ].join('\n');
    const finalMarkdown = [
      '## 第1章 编制依据',
      '《砌体结构工程施工质量验收规范》（GB 50203-2011）',
      '',
      '## 第2章 基础施工',
      '验收记录由质检员签认。',
    ].join('\n');
    const result = replayTailStrippedBasisCitations(makeSession([{ id: 'ch2', title: '基础施工', content: draft }], finalMarkdown));
    expect(result.restored).toBe(0);
    expect(result.markdown).toBe(finalMarkdown);
  });

  it('负例：清洗后形态在 markdown 中不存在（后续轮次已改写）→ 不猜写、不回补', () => {
    const finalMarkdown = [
      DECLARATION,
      '',
      '## 第2章 基础施工',
      '验收记录由资料员按检验批签认并存档。',
    ].join('\n');
    const result = replayTailStrippedBasisCitations(makeSession([{ id: 'ch2', title: '基础施工', content: DRAFT_WITH_CITATION }], finalMarkdown));
    expect(result.restored).toBe(0);
    expect(result.markdown).toBe(finalMarkdown);
  });
});
