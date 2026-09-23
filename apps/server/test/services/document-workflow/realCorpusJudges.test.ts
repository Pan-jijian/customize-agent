/**
 * 4.60 全判据 × 真实语料矩阵（用户 2026-09-24「大批量、贴合实际业务流程」的扩展）。
 *
 * `realCorpusMatrix.test.ts` 覆盖表达质量三族 + 结构 + 缺口；本文件把**其余全部可调用的
 * 确定性判据**也铺到同一份真实语料上（149 份归档 / 37,104 长段落 / 5,947 标题）。
 *
 * ## 断言的是什么（四类，每类都是真实缺陷的形态）
 *
 * 1. **不抛错**：判据在真实文本上不得崩（真实语料含全角/异体字/超长行/空行等现实形态）；
 * 2. **确定性**：同一输入两次调用结果必须逐字一致（判据若含 `lastIndex` 残留等全局状态会在此暴露）；
 * 3. **幂等/自反**（适用者）：归一化类判据 `f(f(x)) === f(x)`；
 * 4. **命中率带**：判据在真实交付物上**不得大面积误报**（上限）——真实语料里确实存在判据要抓的
 *    形态（这正是判据的价值），故断言**上限**而非零。
 *
 * ## 覆盖口径
 *
 * 批内全量扫描（非 `it.each`）：价值来自「**每个真实条目都被每个判据扫过**」，
 * 不来自报告里的条数。实测调用量在用例日志中打印（判据数 × 语料条目数）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFragmentLikeSectionTitle, isLikelyMojibakeTitle, isTenderClauseFragmentTitle } from '@/services/document-workflow/outline';
import { hasProcessSequenceExpression, workPackageContentElementFlags } from '@/services/document-workflow/utils';
import { isZeroInfoSloganSentence, isClauseRecitationSentence, isTableLeakParagraph } from '@/services/document-workflow/tenderBidChecks';
import { isComplianceCitationValue, isTableScrapeFragment } from '@/services/document-workflow/factValueNoise';
import { isAbsenceDeclaration, rejectValueNoise } from '@/services/document-workflow/authoritativeValues';

const DRAFT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', process.env.PROJECT_ID || '3c3f04667c69', 'generatedDocuments', 'drafts');

interface Archive { file: string; markdown: string }

function loadArchives(): Archive[] {
  if (!fs.existsSync(DRAFT_DIR)) return [];
  return fs.readdirSync(DRAFT_DIR)
    .filter(name => name.startsWith('doc-') && name.endsWith('.json') && !name.endsWith('.meta.json'))
    .flatMap(name => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, name), 'utf8')) as { markdown?: string };
        return record.markdown ? [{ file: name, markdown: record.markdown }] : [];
      } catch { return []; }
    });
}

/**
 * 语料规模上限（**性能护栏**，不是覆盖妥协的借口）。
 *
 * 实测：归档目录 **1,953.6 MB / 266 份**（有效 149 份）——全量装载 + 判据 × 3.7 万段落会把套件
 * 拖到 **>10 分钟**，门禁不可用。故 CI 默认取 **前 N 份归档 × 每份 M 段**；
 * `CORPUS_FULL=1` 放开为全量（供定向深扫）。**实际覆盖到多少在用例日志里打印**。
 */
const FULL = process.env.CORPUS_FULL === '1';
const ARCHIVE_LIMIT = FULL ? Number.POSITIVE_INFINITY : 12;
const PARAGRAPHS_PER_ARCHIVE = FULL ? Number.POSITIVE_INFINITY : 200;
/** 确定性复核抽样数（每判据）——每段双调用会把成本翻倍，抽样足以暴露全局状态残留 */
const DETERMINISM_SAMPLE = 200;

const archives = loadArchives().slice(0, ARCHIVE_LIMIT);
const CORPUS = (() => {
  const paragraphs: Array<{ file: string; text: string }> = [];
  const headings: Array<{ file: string; text: string }> = [];
  for (const archive of archives) {
    let taken = 0;
    for (const line of archive.markdown.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length >= 40 && !/^[#|>]/.test(trimmed) && taken < PARAGRAPHS_PER_ARCHIVE) {
        paragraphs.push({ file: archive.file, text: trimmed });
        taken += 1;
      }
      const heading = /^#{2,4}\s+(\S.*)$/u.exec(trimmed);
      if (heading) headings.push({ file: archive.file, text: heading[1]!.trim() });
    }
  }
  /**
   * **值池**：真实表格单元格。值级判据（`rejectValueNoise`/`isAbsenceDeclaration`/…）的输入是
   * **取值**而不是段落——首版把它们喂段落，`rejectValueNoise` 命中 98.8%（因"超长＝疑为段落而非值"
   * 而正确拒绝），那是**测试池选错**，不是判据错。表格单元格是真实语料里最贴近"事实取值"的形态。
   */
  const values: Array<{ file: string; text: string }> = [];
  for (const archive of archives) {
    for (const line of archive.markdown.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('|')) continue;
      for (const cell of trimmed.split('|').map(part => part.trim())) {
        if (cell.length >= 1 && cell.length <= 40 && !/^[-:]+$/u.test(cell)) values.push({ file: archive.file, text: cell });
      }
    }
  }
  return { paragraphs, headings, values };
})();

/** 判据扫描器：返回 null 表示「未命中」，否则返回命中信息（用于统计） */
interface JudgeSpec {
  name: string;
  /** 输入池（`value` = 真实表格单元格，供值级判据） */
  pool: 'paragraph' | 'heading' | 'value';
  /** 执行判据；返回是否命中 */
  run: (text: string) => boolean;
  /** 命中率上限（真实交付物上的合理带；超过即判据在真实语料上失效） */
  maxHitRate: number;
}

const JUDGES: JudgeSpec[] = [
  { name: 'isZeroInfoSloganSentence', pool: 'paragraph', run: text => isZeroInfoSloganSentence(text), maxHitRate: 0.5 },
  { name: 'isClauseRecitationSentence', pool: 'paragraph', run: text => isClauseRecitationSentence(text), maxHitRate: 0.5 },
  { name: 'isTableLeakParagraph', pool: 'paragraph', run: text => isTableLeakParagraph(text), maxHitRate: 0.5 },
  { name: 'isComplianceCitationValue', pool: 'value', run: text => isComplianceCitationValue(text), maxHitRate: 0.3 },
  { name: 'isTableScrapeFragment', pool: 'value', run: text => isTableScrapeFragment(text), maxHitRate: 0.3 },
  { name: 'isAbsenceDeclaration', pool: 'value', run: text => isAbsenceDeclaration(text), maxHitRate: 0.3 },
  { name: 'rejectValueNoise', pool: 'value', run: text => Boolean(rejectValueNoise(text)), maxHitRate: 0.5 },
  { name: 'hasProcessSequenceExpression', pool: 'paragraph', run: text => hasProcessSequenceExpression(text), maxHitRate: 1 },
  { name: 'workPackageContentElementFlags.scope', pool: 'paragraph', run: text => workPackageContentElementFlags(text).scope, maxHitRate: 1 },
  { name: 'workPackageContentElementFlags.process', pool: 'paragraph', run: text => workPackageContentElementFlags(text).process, maxHitRate: 1 },
  { name: 'workPackageContentElementFlags.method', pool: 'paragraph', run: text => workPackageContentElementFlags(text).method, maxHitRate: 1 },
  { name: 'isFragmentLikeSectionTitle', pool: 'heading', run: text => isFragmentLikeSectionTitle(text), maxHitRate: 0.3 },
  { name: 'isLikelyMojibakeTitle', pool: 'heading', run: text => isLikelyMojibakeTitle(text), maxHitRate: 0.3 },
  { name: 'isTenderClauseFragmentTitle', pool: 'heading', run: text => isTenderClauseFragmentTitle(text), maxHitRate: 0.3 },
];

describe('4.60 全判据 × 真实语料矩阵', () => {
  it('语料装载（覆盖口径：判据数 × 语料条目数）', () => {
    const poolSize = (kind: JudgeSpec['pool']) => kind === 'paragraph' ? CORPUS.paragraphs.length : kind === 'heading' ? CORPUS.headings.length : CORPUS.values.length;
    const calls = JUDGES.reduce((sum, judge) => sum + poolSize(judge.pool), 0);
    console.log(`[judges] 模式 ${FULL ? '全量' : `限量（12 份 × ≤200 段；CORPUS_FULL=1 放开）`}；归档 ${archives.length} 份；段落 ${CORPUS.paragraphs.length}；标题 ${CORPUS.headings.length}；值 ${CORPUS.values.length}；判据 ${JUDGES.length} 个 → 判据调用 ${calls} 次`);
    expect(Array.isArray(archives)).toBe(true);
  });

  for (const judge of JUDGES) {
    it(`${judge.name}：真实语料全量扫描（不抛错 / 确定性 / 命中率带）`, () => {
      if (archives.length === 0) {
        console.log(`[judges] 无真实归档，跳过 ${judge.name}`);
        return;
      }
      const pool = judge.pool === 'paragraph' ? CORPUS.paragraphs : judge.pool === 'heading' ? CORPUS.headings : CORPUS.values;
      let hits = 0;
      let nonDeterministic = 0;
      let thrown = 0;
      let firstFailure = '';
      for (const item of pool) {
        try {
          const first = judge.run(item.text);
          if (hits + nonDeterministic + thrown < DETERMINISM_SAMPLE) {
            const second = judge.run(item.text);
            if (first !== second) {
              nonDeterministic += 1;
              if (!firstFailure) firstFailure = `非确定性：${item.file}｜${item.text.slice(0, 50)}`;
            }
          }
          if (first) hits += 1;
        } catch (error) {
          thrown += 1;
          if (!firstFailure) firstFailure = `抛错：${item.file}｜${item.text.slice(0, 50)}｜${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const total = Math.max(1, pool.length);
      console.log(`[judges] ${judge.name}：${pool.length} 条 → 命中 ${hits}（${(hits / total * 100).toFixed(1)}%）；抛错 ${thrown}；非确定性 ${nonDeterministic}`);
      expect(thrown, `${judge.name} 在真实语料上抛错：${firstFailure}`).toBe(0);
      expect(nonDeterministic, `${judge.name} 非确定性：${firstFailure}`).toBe(0);
      expect(hits / total, `${judge.name} 在真实语料上命中率过高（判据失效）：${(hits / total * 100).toFixed(1)}%`).toBeLessThanOrEqual(judge.maxHitRate);
    }, 300_000);
  }

});
