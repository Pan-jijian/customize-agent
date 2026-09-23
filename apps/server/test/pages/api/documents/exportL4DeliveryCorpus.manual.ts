/**
 * L4-2/L4-6/L4-7/L4-8 真实语料零误报取证（manual：不进常规门禁）。
 * 语料：/tmp/l3corpus/*.md（真实终稿抽取，见 l3-blindspots-evidence.manual.ts）；缺失即跳过。
 * 口径：全程只调用生产函数（prepareExportMarkdown → markdownToDocxXml），统计新判据在真实终稿上的
 * blocker/notice 命中与样本 —— 证明「docx 阶段产物守恒 / 目录对账 / 声明剥离」在真实文档上零误报。
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/pages/api/documents/exportL4DeliveryCorpus.manual.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import { __documentExportTest__ } from '@/pages/api/documents/export';
import { stripClarificationNarrative, stripDrawingPointerPhrases, stripMaterialResidueLines } from '@/services/document-workflow/materialResidue';

const CORPUS_DIR = '/tmp/l3corpus';
const { createExportRenderAudit, markdownToDocxXml, prepareExportMarkdown, isTableCaptionLine, looksLikeHeaderRow } = __documentExportTest__;

function loadCorpus() {
  if (!fs.existsSync(CORPUS_DIR)) return [] as Array<{ name: string; markdown: string }>;
  return fs.readdirSync(CORPUS_DIR).filter(name => name.endsWith('.md')).sort()
    .map(name => ({ name, markdown: fs.readFileSync(path.join(CORPUS_DIR, name), 'utf8') }));
}

describe('L4 交付层真实语料零误报取证', () => {
  it('24 份真实终稿：新判据命中统计 + 样本', () => {
    const corpus = loadCorpus();
    if (corpus.length === 0) {
      console.log('[l4-corpus] 语料不存在，跳过（node /tmp/l3corpus.mjs）');
      return;
    }
    const prepareCodes = new Map<string, number>();
    const docxCodes = new Map<string, number>();
    const samples: string[] = [];
    const opsTotals: Record<string, number> = {};
    for (const doc of corpus) {
      const prepared = prepareExportMarkdown(doc.markdown);
      const audit = createExportRenderAudit('observe');
      markdownToDocxXml(prepared.markdown, undefined, undefined, audit);
      const collect = (codes: Map<string, number>, list: Array<{ code: string; message: string }>) => {
        for (const item of list) {
          codes.set(item.code, (codes.get(item.code) || 0) + 1);
          if (samples.length < 40) samples.push(`${doc.name} ${item.code}: ${item.message.slice(0, 160)}`);
        }
      };
      collect(prepareCodes, [...prepared.audit.blockers, ...prepared.audit.notices]);
      collect(docxCodes, [...audit.blockers, ...audit.notices]);
      for (const [key, value] of Object.entries(prepared.audit.ops)) opsTotals[key] = (opsTotals[key] || 0) + value;
      for (const [key, value] of Object.entries(audit.ops)) opsTotals[key] = (opsTotals[key] || 0) + value;
    }
    console.log(`[l4-corpus] 文档数 ${corpus.length}（总字数 ${corpus.reduce((sum, doc) => sum + doc.markdown.length, 0)}）`);
    console.log('[l4-corpus] prepareExportMarkdown 命中：', Object.fromEntries([...prepareCodes].sort()));
    console.log('[l4-corpus] docx 阶段命中：', Object.fromEntries([...docxCodes].sort()));
    console.log('[l4-corpus] ops 合计：', opsTotals);
    for (const sample of samples) console.log(`[l4-corpus] ${sample}`);
  });

  it('真稿目录篡改后必须按正文重建（L4-7 实效：模拟「正文改了、目录没改」）', () => {
    const corpus = loadCorpus();
    if (corpus.length === 0) {
      console.log('[l4-corpus] 语料不存在，跳过');
      return;
    }
    let tampered = 0;
    let rebuilt = 0;
    let failed: string[] = [];
    for (const doc of corpus) {
      const line = doc.markdown.split('\n').find(item => /^  \d+\.\d+ \S/u.test(item));
      const tocEntries = doc.markdown.split('\n').filter(item => /^\s{0,2}\d+\.\d+ \S/u.test(item)).length;
      if (!line || tocEntries === 0) continue;
      tampered += 1;
      // 篡改目录首条小节编号+标题（正文不动）：模拟用户改动正文后目录未同步
      const stale = doc.markdown.replace(line, '  9.99 已废弃章节');
      const audit = createExportRenderAudit('observe');
      const prepared = prepareExportMarkdown(stale);
      const ok = audit.ops.tocRebuilt === 1 || prepared.audit.ops.tocRebuilt === 1;
      const rebuiltOk = !prepared.markdown.includes('9.99 已废弃章节') && prepared.markdown.includes(line.trim());
      if (ok && rebuiltOk) rebuilt += 1;
      else if (failed.length < 5) failed.push(`${doc.name}: rebuilt=${prepared.audit.ops.tocRebuilt} 残留篡改=${prepared.markdown.includes('9.99 已废弃章节')}`);
    }
    console.log(`[l4-corpus] 目录篡改实验：可篡改 ${tampered} 份 / 已重建 ${rebuilt} 份 / 失败 ${failed.length}`);
    for (const item of failed) console.log(`[l4-corpus] 失败样本 ${item}`);
  });

  it('L4-4/L4-5 判据样本取证（表头形态判定 + 表题行命中，人工复核误报）', () => {
    const corpus = loadCorpus();
    if (corpus.length === 0) {
      console.log('[l4-corpus] 语料不存在，跳过');
      return;
    }
    const captionSamples: string[] = [];
    const nonHeaderSamples: string[] = [];
    let captionLines = 0;
    let tables = 0;
    let nonHeaderTables = 0;
    for (const doc of corpus) {
      const lines = doc.markdown.replace(/\r?\n/gu, '\n').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = (lines[index] || '').trim();
        if (!line || /^(?:#{1,6}\s|\||[-*+]\s|\d+[.、]\s|```|<div|\[\[PAGE)/u.test(line)) continue;
        if (!isTableCaptionLine(line)) continue;
        captionLines += 1;
        if (captionSamples.length < 8) captionSamples.push(`${doc.name}:${index + 1} ${line.slice(0, 120)}`);
      }
      for (let index = 0; index < lines.length; index += 1) {
        const row = (lines[index] || '').trim();
        const next = (lines[index + 1] || '').trim() === '' ? (lines[index + 2] || '').trim() : (lines[index + 1] || '').trim();
        if (!/^\|.*\|$/u.test(row) || !/^\|[\s:|-]+\|$/u.test(next)) continue;
        tables += 1;
        const cells = row.replace(/^\||\|$/gu, '').split('|').map(cell => cell.trim());
        if (looksLikeHeaderRow(cells)) continue;
        nonHeaderTables += 1;
        if (nonHeaderSamples.length < 8) nonHeaderSamples.push(`${doc.name}:${index + 1} ${row.slice(0, 120)}`);
      }
    }
    console.log(`[l4-corpus] 表题行判据命中 ${captionLines} 行（样本 ${captionSamples.length}）：`);
    for (const sample of captionSamples) console.log(`  表题 ${sample}`);
    console.log(`[l4-corpus] 表格 ${tables} 张 / 首行不按表头渲染 ${nonHeaderTables} 张：`);
    for (const sample of nonHeaderSamples) console.log(`  非表头 ${sample}`);
  });

  it('L4-8 剥离逐处取证（真稿前 N 处 before/after，供「信息零丢失」人工复核）', () => {
    const corpus = loadCorpus();
    if (corpus.length === 0) {
      console.log('[l4-corpus] 语料不存在，跳过');
      return;
    }
    const target = corpus.find(doc => doc.name === 'doc08.md') || corpus[0];
    const lines = target.markdown.replace(/\r?\n/gu, '\n').split('\n');
    let shown = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || /^(?:#{1,6}\s|\||[-*+]\s|\d+[.、]\s|```|<div|\[\[PAGE)/u.test(trimmed)) continue;
      const narrative = stripClarificationNarrative(line);
      const pointer = stripDrawingPointerPhrases(narrative.text);
      const after = stripMaterialResidueLines(pointer.text);
      if (after !== line && shown < 12) {
        shown += 1;
        console.log(`[l4-corpus] 剥离处 ${shown}（${target.name}）：\n  原：${line.trim().slice(0, 200)}\n  后：${after.trim().slice(0, 200)}`);
      }
    }
    console.log(`[l4-corpus] 剥离处取证：${target.name} 展示 ${shown} 处`);
  });
});
