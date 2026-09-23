/**
 * §L3-1~6 六个检测盲区·真实终稿取证脚本（manual：不进常规门禁）。
 *
 * 数据源：真实终稿记录（巢湖项目 3c3f04667c69）抽出的 markdown 语料 /tmp/l3corpus/*.md，
 * doc00 = 目标稿 doc-1790144107028-aaba7ba3（35MB，847 行）；doc01 = doc-1790141547504。
 * 本脚本**只调用生产函数**（判据实现即取证口径，避免脚本与实现漂移），并行取两类证据：
 *   ① 既有检测器在同一正文上的产出（证明盲区确实零报出）；
 *   ② 六个判据的命中数 + 全部样本（供逐条真伪判定）。
 *
 * 语料重建：node /tmp/l3corpus.mjs（从 ~/.customize-agent 各项目的 generatedDocuments/drafts 抽取）
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/services/document-workflow/l3-blindspots-evidence.manual.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { gluedClauseIssues, structureIntegrityIssues, tailOrphanBlockIssues, truncatedSentenceIssues } from '@/services/document-workflow/structureIntegrityRules';
import { punctuationArtifactIssues, markdownTableQualityIssues } from '@/services/document-workflow/qualityValidation';
import { duplicateParagraphIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { professionalChainScan, sectionProcessChainMixingIssues } from '@/services/document-workflow/constructionOrgQualityRules';
import { scanTableCaptionDefects, scanTableNumberingGaps, tableCaptionDefectIssues, tableNumberingGapIssues } from '@/services/document-workflow/constructionOrgTablePlan';
import { paragraphNearDuplicateIssues, scanParagraphNearDuplicates } from '@/services/document-workflow/integrity/detectors/detectors';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

const CORPUS_DIR = '/tmp/l3corpus';

function loadCorpus(): Array<{ name: string; markdown: string }> {
  if (!fs.existsSync(CORPUS_DIR)) return [];
  return fs.readdirSync(CORPUS_DIR)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => ({ name, markdown: fs.readFileSync(path.join(CORPUS_DIR, name), 'utf8') }));
}

/** 语料只有 markdown：按 H2 合成章（L3-6 需要 chapters 输入） */
function chaptersOf(markdown: string): DocumentDraftChapter[] {
  return markdown.split(/(?=^##\s)/mu).flatMap(block => {
    const heading = block.match(/^##\s+(.+)$/mu);
    if (!heading) return [];
    return [{ id: heading[1].trim(), title: heading[1].trim(), content: block } as unknown as DocumentDraftChapter];
  });
}

const CORPUS = loadCorpus();
const TARGET = CORPUS.find(item => item.name === 'doc00.md');

describe('L3-1~6 盲区取证（真实终稿语料）', () => {
  it('doc00 既有检测器基线（盲区必须证明既有检测器零报出）', () => {
    if (!TARGET) {
      console.log('[l3] 语料不存在，跳过（先运行 node /tmp/l3corpus.mjs）');
      return;
    }
    const markdown = TARGET.markdown;
    console.log(`[l3] doc00 ${markdown.length} 字 / ${markdown.split('\n').length} 行`);
    const baseline = {
      structure: structureIntegrityIssues(markdown, { excludeKinds: ['truncated-line'] }),
      truncated: truncatedSentenceIssues(markdown),
      punctuation: punctuationArtifactIssues(markdown),
      tableQuality: markdownTableQualityIssues(markdown),
      duplicateParagraph: duplicateParagraphIssues(markdown),
    };
    for (const [key, issues] of Object.entries(baseline)) {
      console.log(`[baseline:${key}] ${issues.length}`);
      for (const issue of (issues as Array<{ message?: string }>).slice(0, 12)) console.log(`   - ${(issue.message || '').slice(0, 150)}`);
    }
    const baselineText = Object.values(baseline).flat().map(issue => (issue as unknown as { message?: string }).message || '').join('\n');
    const lines = markdown.split('\n');
    for (const lineNo of [843, 845, 847]) {
      const text = (lines[lineNo - 1] || '').trim();
      const reported = text && baselineText.includes(text.slice(0, 30));
      console.log(`[覆盖判定] 第 ${lineNo} 行「${text.slice(0, 26)}…」既有检测器${reported ? '已报出' : '零报出（盲区）'}`);
    }
  });

  it('六条判据·全语料命中统计（生产函数直调）', () => {
    for (const doc of CORPUS) {
      const md = doc.markdown;
      const l31 = tailOrphanBlockIssues(md);
      const l32 = scanTableNumberingGaps(md);
      const l33 = scanTableCaptionDefects(md);
      const l34 = gluedClauseIssues(md);
      const l35 = scanParagraphNearDuplicates(md);
      const l36 = sectionProcessChainMixingIssues(chaptersOf(md));
      console.log(`[${doc.name}] L3-1=${l31.length} L3-2=${l32.length} L3-3=${l33.length} L3-4=${l34.length} L3-5=${l35.length} L3-6=${l36.length}`);
    }
    if (!TARGET) return;
    const md = TARGET.markdown;
    console.log('=== doc00 L3-1 明细 ===');
    for (const issue of tailOrphanBlockIssues(md)) console.log(`  ${issue.message.slice(0, 160)}`);
    console.log('=== doc00 L3-2 明细 ===');
    for (const issue of tableNumberingGapIssues(md)) console.log(`  ${issue.message}`);
    console.log('=== doc00 L3-3 明细 ===');
    for (const defect of scanTableCaptionDefects(md)) console.log(`  L${defect.line} ${defect.kind} 「${defect.raw}」`);
    console.log('=== doc00 L3-4 明细 ===');
    for (const issue of gluedClauseIssues(md)) console.log(`  ${issue.message.slice(0, 170)}`);
    console.log('=== doc00 L3-5 明细 ===');
    for (const hit of scanParagraphNearDuplicates(md)) console.log(`  L${hit.firstLine}~L${hit.secondLine} j=${hit.skeletonJaccard} num=${hit.numberOverlap} 「${hit.excerpt}」`);
    console.log(`[doc00] paragraphNearDuplicateIssues=${paragraphNearDuplicateIssues(md).length} professionalChainScan=${professionalChainScan({ chapters: chaptersOf(md), documentText: md }).length}`);
  });

  it('非目标稿命中明细（判据精度旁证：doc01 表题残缺 / 全语料近重复）', () => {
    const doc01 = CORPUS.find(item => item.name === 'doc01.md');
    if (doc01) {
      console.log('=== doc01 L3-3 明细（同项目另一终稿）===');
      for (const issue of tableCaptionDefectIssues(doc01.markdown)) console.log(`  ${issue.message.slice(0, 150)}`);
    }
    console.log('=== 全语料 L3-5 逐条 ===');
    for (const doc of CORPUS) {
      for (const hit of scanParagraphNearDuplicates(doc.markdown)) {
        console.log(`  [${doc.name}] L${hit.firstLine}~L${hit.secondLine} j=${hit.skeletonJaccard} num=${hit.numberOverlap} 「${hit.excerpt}」`);
      }
    }
    console.log('=== 全语料 L3-2 逐条（表号跳号）===');
    for (const doc of CORPUS) {
      for (const issue of tableNumberingGapIssues(doc.markdown)) console.log(`  [${doc.name}] ${issue.message.slice(0, 150)}`);
    }
    console.log('=== 全语料 L3-4 逐条（句子粘连）===');
    for (const doc of CORPUS) {
      for (const issue of gluedClauseIssues(doc.markdown)) console.log(`  [${doc.name}] ${issue.message.slice(0, 190)}`);
    }
    console.log('=== 全语料 L3-6 逐条（工序域混杂·放宽判据）===');
    for (const doc of CORPUS) {
      for (const issue of sectionProcessChainMixingIssues(chaptersOf(doc.markdown))) console.log(`  [${doc.name}] ${issue.message.slice(0, 170)}`);
    }
    console.log('=== 全语料 L3-1 前 8 条（游离块）===');
    for (const doc of CORPUS) {
      for (const issue of tailOrphanBlockIssues(doc.markdown).slice(0, 8)) console.log(`  [${doc.name}] ${issue.message.slice(0, 130)}`);
    }
  });
});
