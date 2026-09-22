/**
 * 链尾编制依据回补防回归。
 *
 * 实测缺陷（巢湖终稿）：报告记「basis-regulations-cross-repair：未记录（无触发或静默通过）」，
 * 而终检报 13 处「引用未声明」；把该轮同源审计跑在终稿上确实看得到缺口
 *（declaredCodes 10 / declaredNames 25 / usedNotDeclared 13）——**是轮次之后新增的引用无人收口**
 *（链尾要求收口的补写会带入新的《》引用）。故在终门禁前（其后无改写正文的轮次）再跑一次确定性回补。
 */
import { describe, expect, it } from 'vitest';
import { backfillUsedNotDeclared } from '@/services/document-workflow/finalize/repairRounds/basisRegulationsCrossRepair';
import { auditBasisRegulationsCross } from '@/services/document-workflow/basisRegulationsCross';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

const BASIS_CHAPTER = [
  '## 第一章 工程概况',
  '',
  '### 1.1 编制依据',
  '',
  '国家法律法规：《中华人民共和国建筑法》、《建设工程质量管理条例》。',
  '国家/行业现行规范标准：《混凝土结构工程施工质量验收规范》（GB 50204-2015）。',
].join('\n');

const sessionOf = (basisContent: string, bodyTail: string) => {
  const chapters = [
    { id: 'c1', title: '工程概况', content: basisContent, evidence: [], sections: [] },
    { id: 'c2', title: '主要施工方法', content: bodyTail, evidence: [], sections: [] },
  ];
  return {
    finalChapterDrafts: chapters,
    finalMarkdown: chapters.map(chapter => chapter.content).join('\n\n'),
  } as unknown as FinalizeSession;
};

describe('backfillUsedNotDeclared（链尾确定性回补）', () => {
  it('正文引用但未列入编制依据的标准 → 补入编制依据小节（不动正文引用）', () => {
    const session = sessionOf(BASIS_CHAPTER, '## 第二章 主要施工方法\n\n钢筋连接接头按《钢筋机械连接技术规程》（JGJ 107）规定的检验批划分取样送检。');
    const before = auditBasisRegulationsCross(session.finalMarkdown);
    expect(before.usedNotDeclared.length).toBeGreaterThan(0);
    const result = backfillUsedNotDeclared(session);
    expect(result.inserted).toBeGreaterThan(0);
    // 契约：本函数只改章节草稿，finalMarkdown 由调用方重建（documentPipeline 里随后 rebuildFinalMarkdown）
    session.finalMarkdown = (session.finalChapterDrafts as Array<{ content: string }>).map(chapter => chapter.content).join('\n\n');
    const after = auditBasisRegulationsCross(session.finalMarkdown);
    expect(after.usedNotDeclared).toHaveLength(0);
    // 正文引用原样保留（只补编制依据条目）
    expect(session.finalChapterDrafts[1]!.content).toContain('《钢筋机械连接技术规程》（JGJ 107）');
  });

  it('缺口为零 → 不改动任何章节（幂等）', () => {
    const session = sessionOf(BASIS_CHAPTER, '## 第二章 主要施工方法\n\n按 GB 50204-2015 执行。');
    const snapshot = session.finalChapterDrafts.map(chapter => chapter.content);
    const result = backfillUsedNotDeclared(session);
    expect(result.inserted).toBe(0);
    expect(session.finalChapterDrafts.map(chapter => chapter.content)).toEqual(snapshot);
  });

  it('无编制依据区段 → 无定向目标，不猜测改写', () => {
    const session = sessionOf('## 第一章 工程概况\n\n本章为项目概况与现场条件说明。', '## 第二章 主要施工方法\n\n按《钢筋机械连接技术规程》（JGJ 107）执行。');
    const snapshot = session.finalChapterDrafts.map(chapter => chapter.content);
    expect(backfillUsedNotDeclared(session).inserted).toBe(0);
    expect(session.finalChapterDrafts.map(chapter => chapter.content)).toEqual(snapshot);
  });

  it('多次调用结果稳定（第二次无新增）', () => {
    const session = sessionOf(BASIS_CHAPTER, '## 第二章 主要施工方法\n\n按《钢筋机械连接技术规程》（JGJ 107）执行。');
    expect(backfillUsedNotDeclared(session).inserted).toBeGreaterThan(0);
    expect(backfillUsedNotDeclared(session).inserted).toBe(0);
  });
});
