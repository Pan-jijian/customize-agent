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

import { stripDrawingPointerPhrases } from '@/services/document-workflow/materialResidue';
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
  /**
   * 4.55.36 §L3-10 生效后本轮的**语义变更**（原"正例"改写）：
   *
   * 该用例原本构造「桩位偏差与基底标高按《建筑地基基础工程施工质量验收标准》（GB 50202-2018）控制」
   * ——而**这正是 §L3-10 的历史事故形态**（带标准代号的规范引用被指向型清洗器整句删除 → 正文数据丢失）。
   * §L3-10 加了「规范/法规名收尾」与「标题后紧跟标准代号」两条负向先行后，该形态**不再被清洗**：
   * 实测 `stripDrawingPointerPhrases(...).removed === 0`，文本逐字不变（见同目录 pointerPhraseL3.test.ts）。
   *
   * 因此本轮**无事可补**——这不是回补失效，而是**上游误删已被根治**，回补退化为遗留安全网
   *（仅对早期构建/旧 checkpoint 产物可能生效）。生产影响方向严格保守：不误删 ⇒ 无需回补。
   * **反向做法（为保住本用例而弱化 §L3-10）会重新引入正文数据丢失，不可取。**
   */
  it('§L3-10 生效后该形态不再被清洗 → 回补为 no-op（上游误删已根治，非回补失效）', () => {
    const session = makeSession([{ id: 'ch2', title: '基础施工', content: DRAFT_WITH_CITATION }], MARKDOWN_STRIPPED);
    const result = replayTailStrippedBasisCitations(session);
    expect(result.restored).toBe(0);
    // 清洗器对当前草稿的判定：removed = 0（保护生效）
    expect(stripDrawingPointerPhrases(DRAFT_WITH_CITATION).removed).toBe(0);
    expect(stripDrawingPointerPhrases(DRAFT_WITH_CITATION).text).toContain('GB 50202-2018）控制');
  });

  it('遗留安全网语义：清洗器仍会剥离的真指向小句不得回补（回补会引入检测端 blocker）', () => {
    // 对照：图集指向今天仍被剥离（removed=1）——这类是**真指向**，回补即引入 blocker，故不回补。
    // 两者合起来划定本轮的适用边界：只对「曾因标准名被误删」的历史输入生效，对真指向永不生效。
    expect(stripDrawingPointerPhrases('做法详见《钢筋混凝土及砖砌排水检查井》20S515/29。').removed).toBe(1);
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
