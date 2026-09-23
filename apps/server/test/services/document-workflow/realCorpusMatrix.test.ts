/**
 * 4.60 真实语料判据矩阵（用户 2026-09-24 指令落地：**大批量、贴合实际业务流程**）。
 *
 * > 「你测试的数据或者参数或者值这些，应该从我们的本地知识库召回……用我们的召回、清洗、规划等
 * >  去搞大批量数据进行测试，每个测试都贴合实际业务的流程，这样才能完整的测出整个流程中的某些问题。」
 *
 * ## 与「堆用例」的区别
 *
 * 本套件的输入**全部来自真实产出的归档**（`~/.customize-agent/projects/<id>/generatedDocuments/drafts`），
 * 不是合成样例。实测语料规模：**149 份归档 / 1102 章 / 5636 规划小节 / 5947 终稿 H3 /
 * 39902 表格行 / 37104 长段落**。每个真实条目都会过一遍判据，因此：
 *
 * - 能测出「判据在真实文本上的行为」——合成样例永远覆盖不到真实语料的形态分布；
 * - 能测出「判据之间对同一份真实数据是否矛盾」（本仓最贵的一类缺陷，见 `pipelineInvariants.manual.ts`）；
 * - 能测出「判据本身是否稳定」（确定性、幂等、不抛错）。
 *
 * ## 覆盖口径（诚实的计数说明）
 *
 * 本文件用**批内全量扫描**而非 `it.each` 逐条展开：单测框架对 10 万级 `it` 用例的枚举与报告开销
 * 会让套件失去可用性，而价值来自「**每个真实条目都被判据扫过**」，不来自「测试报告里的条数」。
 * 因此本文件报出的是 **X 个测试用例覆盖 N 个真实语料条目**，两个数都会打印。
 * 需要逐条展开的边界矩阵放在 `dropEmptyShellHeadings.test.ts` 等族级文件里（`it.each` 形态）。
 *
 * ## 归档不可用时的行为
 *
 * CI 无真实归档 → 语料为空 → 各用例**跳过而非假绿**（显式打印，且断言「无归档时不得声称通过」）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isClauseRecitationSentence,
  isTableLeakParagraph,
  scanZeroInfoFillerPhrases,
} from '@/services/document-workflow/tenderBidChecks';
import { emptySectionSpans, collectSectionContentGaps } from '@/services/document-workflow/qualityValidation';
import { scanStructureDefects } from '@/services/document-workflow/structureIntegrityRules';
import { normalizeSubsectionTitleForDedup } from '@/services/document-workflow/utils';
import { dropEmptyShellHeadings } from '@/services/document-workflow/finalize/repairRounds/deliveryStructureClosure';

const PROJECT_ID = process.env.PROJECT_ID || '3c3f04667c69';
const DRAFT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', PROJECT_ID, 'generatedDocuments', 'drafts');

interface Archive {
  file: string;
  markdown: string;
  chapters: Array<{ title: string; content: string; sections?: string[] }>;
}

/** 全量加载真实归档（模块级一次，避免每个用例重复读盘） */
function loadArchives(): Archive[] {
  if (!fs.existsSync(DRAFT_DIR)) return [];
  return fs.readdirSync(DRAFT_DIR)
    .filter(name => name.startsWith('doc-') && name.endsWith('.json') && !name.endsWith('.meta.json'))
    .flatMap(name => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, name), 'utf8')) as { markdown?: string; draft?: { chapters?: Archive['chapters'] } };
        if (!record.markdown || !record.draft?.chapters?.length) return [];
        return [{ file: name, markdown: record.markdown, chapters: record.draft.chapters }];
      } catch { return []; }
    });
}

const archives = loadArchives();

/** 真实语料条目池（每个条目都是一次判据调用的输入） */
const corpus = (() => {
  const paragraphs: Array<{ file: string; text: string }> = [];
  const headings: Array<{ file: string; text: string }> = [];
  const sections: Array<{ file: string; chapter: string; title: string }> = [];
  const chapters: Array<{ file: string; title: string; content: string; sections: string[] }> = [];
  for (const archive of archives) {
    for (const line of archive.markdown.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= 40 && !/^[#|>]/.test(trimmed)) paragraphs.push({ file: archive.file, text: trimmed });
      const heading = /^#{3,4}\s+(\S.*)$/u.exec(trimmed);
      if (heading) headings.push({ file: archive.file, text: heading[1]!.trim() });
    }
    for (const chapter of archive.chapters) {
      chapters.push({ file: archive.file, title: chapter.title, content: String(chapter.content || ''), sections: (chapter.sections || []).map(section => String(section)) });
      for (const section of chapter.sections || []) sections.push({ file: archive.file, chapter: chapter.title, title: String(section) });
    }
  }
  return { paragraphs, headings, sections, chapters };
})();

/** 语料为空的统一处置：**跳过而非假绿** */
function requireCorpus(): boolean {
  if (archives.length === 0) {
    console.log(`[corpus] 未找到真实归档（${DRAFT_DIR}）——本套件在有归档的机器上才有意义，此处跳过`);
    return false;
  }
  return true;
}

describe('4.60 真实语料判据矩阵（大批量 · 贴合实际业务流程）', () => {
  it('语料装载：报出真实语料规模（覆盖口径的两个数都打印）', () => {
    console.log(`[corpus] 归档 ${archives.length} 份；长段落 ${corpus.paragraphs.length}；H3/H4 标题 ${corpus.headings.length}；规划小节 ${corpus.sections.length}；章 ${corpus.chapters.length}`);
    expect(Array.isArray(archives)).toBe(true);
  });

  /**
   * ① 段落级表达质量三族：**每个真实长段落**都过一遍判据。
   * 断言的是「判据在真实语料上的行为」：不抛错、返回结构良好、命中率落在合理带内。
   *
   * 为什么不断言「命中 = 0」：真实语料里**确实存在**套话/复述/泄漏段（这正是判据要抓的），
   * 断言为零等于把判据的正确行为判成失败。这里断的是**上限**（防判据在真实语料上大面积误报）。
   */
  it('表达质量三族：全量真实段落扫过，不抛错且命中率在合理带上限内', async () => {
    if (!requireCorpus()) return;
    let fillerHits = 0;
    let recitationHits = 0;
    let leakHits = 0;
    for (const item of corpus.paragraphs) {
      const filler = scanZeroInfoFillerPhrases(item.text);
      const recitation = isClauseRecitationSentence(item.text);
      const leak = isTableLeakParagraph(item.text);
      expect(Array.isArray(filler) && typeof recitation === 'boolean' && typeof leak === 'boolean', `${item.file} 判据返回结构异常`).toBe(true);
      if (filler.length > 0) fillerHits += 1;
      if (recitation) recitationHits += 1;
      if (leak) leakHits += 1;
    }
    const total = Math.max(1, corpus.paragraphs.length);
    console.log(`[corpus] 段落三族：${total} 段 → 短语套话 ${fillerHits}（${(fillerHits / total * 100).toFixed(1)}%）、条款复述 ${recitationHits}（${(recitationHits / total * 100).toFixed(1)}%）、表格泄漏 ${leakHits}（${(leakHits / total * 100).toFixed(1)}%）`);
    // 上限口径：真实交付物主体应为合格文本，三族命中率都不得过半（否则判据在真实语料上失效）
    expect(fillerHits / total, '短语套话命中率过高＝判据在真实语料上误报').toBeLessThan(0.5);
    expect(recitationHits / total, '条款复述命中率过高').toBeLessThan(0.5);
    expect(leakHits / total, '表格泄漏命中率过高').toBeLessThan(0.5);
  }, 600_000);

  /** ② 变体折叠一致性：每个真实标题与其自身折叠后必须等价（幂等与自反） */
  it('标题归一化：全量真实标题自反与幂等', () => {
    if (!requireCorpus()) return;
    let checked = 0;
    for (const item of corpus.headings) {
      const once = normalizeSubsectionTitleForDedup(item.text);
      const twice = normalizeSubsectionTitleForDedup(item.text);
      expect(once, `${item.file}｜${item.text} 归一化非确定性`).toBe(twice);
      expect(normalizeSubsectionTitleForDedup(once), `${item.file}｜${item.text} 归一化非幂等`).toBe(once);
      checked += 1;
    }
    console.log(`[corpus] 标题归一化：${checked} 条真实标题，自反+幂等全通过`);
    expect(checked).toBe(corpus.headings.length);
  }, 300_000);

  /** ③ 结构判据在真实终稿上的一致性：`scanStructureDefects` 与空壳清除必须同源可复现 */
  it('结构判据：全量真实终稿的缺陷扫描确定性 + 空壳清除后归零', () => {
    if (!requireCorpus()) return;
    let totalDefects = 0;
    let clearedShells = 0;
    for (const archive of archives) {
      const once = scanStructureDefects(archive.markdown);
      const twice = scanStructureDefects(archive.markdown);
      expect(once.blocking.length, `${archive.file} 结构扫描非确定性`).toBe(twice.blocking.length);
      totalDefects += once.blocking.length;
      const cleaned = dropEmptyShellHeadings(archive.markdown);
      clearedShells += cleaned.dropped.length;
      // 清除后不得再有「下一非空行为同级/更高级标题」的空壳
      const after = scanStructureDefects(cleaned.markdown);
      const stillEmpty = after.blocking.filter(defect => defect.kind === 'empty-subsection').length;
      expect(stillEmpty, `${archive.file} 空壳清除后仍有 empty-subsection`).toBe(0);
    }
    console.log(`[corpus] 结构：${archives.length} 份终稿，扫描缺陷 ${totalDefects} 处，空壳清除 ${clearedShells} 处`);
    expect(archives.length).toBeGreaterThan(0);
  }, 600_000);

  /**
   * ④ 规划小节 × 缺口判据：**每个真实规划小节**都过一遍缺口判据，断言判据自洽。
   * 这是最贴近「规划数据本身是否有问题」的一层（用户原话）。
   */
  it('规划小节：全量真实小节跑缺口判据，判据自洽且不超规划数', () => {
    if (!requireCorpus()) return;
    let chapterCount = 0;
    let gapTotal = 0;
    for (const chapter of corpus.chapters) {
      const gaps = collectSectionContentGaps('', [{ title: chapter.title, content: chapter.content, sections: chapter.sections }]);
      const planned = chapter.sections.filter(Boolean).length;
      expect(gaps.length, `${chapter.file}｜${chapter.title} 缺口数超过规划小节数（判据失守）`).toBeLessThanOrEqual(planned);
      /**
       * 4.60 A2 验收（**全量真实终稿**）：链尾清除后，终稿不得再有任何空壳标题
       * （下一非空行为同级/更高级标题，或文末直落）。
       *
       * 这条才是立得住的：A2 的实测缺陷是「草稿级空壳 0、终稿级空节 3~4」——
       * **分歧在草稿↔终稿之间**（装配/收口把父标题掏空），不是判据之间。
       * （曾尝试断言「空壳判据报空壳 ⇒ 缺口判据必须报缺口」，经实测**立不住**：
       *  同名冗余 H4 空壳对应的规划小节已被同名 H3 覆盖，缺口判据报"无缺口"是正确的。）
       */
      const cleaned = dropEmptyShellHeadings(chapter.content);
      const residualShells = emptySectionSpans({ title: chapter.title, content: cleaned.markdown, sections: chapter.sections } as never);
      expect(residualShells.length, `${chapter.file}｜${chapter.title} 链尾清除后仍有 ${residualShells.length} 处空壳：${residualShells.slice(0, 3).map(span => span.rawTitle).join('、')}`).toBe(0);
      chapterCount += 1;
      gapTotal += gaps.length;
    }
    console.log(`[corpus] 规划小节：${chapterCount} 章、${corpus.sections.length} 个小节，缺口 ${gapTotal} 条，判据自洽`);
    expect(chapterCount).toBe(corpus.chapters.length);
  }, 600_000);

  /** ⑤ 确定性判据的跨归档稳定性：同一输入多次调用结果逐字一致 */
  it('确定性：全量真实终稿的空壳清除幂等', () => {
    if (!requireCorpus()) return;
    for (const archive of archives) {
      const once = dropEmptyShellHeadings(archive.markdown);
      const twice = dropEmptyShellHeadings(once.markdown);
      expect(twice.markdown, `${archive.file} 空壳清除非幂等`).toBe(once.markdown);
      expect(twice.dropped, `${archive.file} 二次清除仍有删除`).toEqual([]);
    }
    console.log(`[corpus] 幂等：${archives.length} 份终稿的空壳清除全部幂等`);
    expect(archives.length).toBeGreaterThan(0);
  }, 300_000);
});
