/**
 * 一次性诊断（manual，不进 CI 门禁）：定位「空小节补写为何不生效」。
 *
 * 实测背景：三轮真实自测中「空小节」恒为 3 条（数字不动）。已查明这三个小节在**章草稿里
 * 就已经是空的**（标题后紧跟下一个标题），即 `collectSectionContentGaps` 本应判为
 * `planned empty` 并交补写轮——但补写轮的报告显示补写的是别的小节。
 *
 * 本脚本对真实 draft 跑缺口判据，回答三个问题：
 *   ① 这三个空小节有没有被 `collectSectionContentGaps` 识别？
 *   ② 识别成了什么 reason（missing_planned_section / empty / too_short）？
 *   ③ `planned` 标志是否为 true（补写轮的过滤条件是 `empty && planned`）？
 *
 * 用法：pnpm exec vitest run --config vitest.manual.config.ts apps/server/test/services/document-workflow/diag-emptysection.manual.ts --reporter=verbose
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectSectionContentGaps, emptySectionSpans } from '@/services/document-workflow/qualityValidation';

const DOC_ID = process.env.DIAG_DOC || 'doc-1790178570374-cfb0a0da';

function loadDraft(): { chapters: Array<{ title: string; content: string; sections?: string[] }> } {
  const file = path.join(os.homedir(), '.customize-agent', 'projects', '3c3f04667c69', 'generatedDocuments', 'drafts', `${DOC_ID}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { draft?: { chapters?: Array<{ title: string; content: string; sections?: string[] }> } };
  return { chapters: record.draft?.chapters || [] };
}

describe('诊断：空小节补写为何不生效', () => {
  it('在真实 draft 上跑缺口判据，核对三个空小节的归类', () => {
    const { chapters } = loadDraft();
    console.log(`[diag] 章数=${chapters.length}`);
    const gaps = collectSectionContentGaps('', chapters);
    console.log(`[diag] 缺口总数=${gaps.length}`);
    const byReason: Record<string, number> = {};
    for (const gap of gaps) byReason[gap.reason] = (byReason[gap.reason] || 0) + 1;
    console.log(`[diag] 按 reason: ${JSON.stringify(byReason)}`);
    console.log(`[diag] 补写轮过滤条件命中（missing ∪ empty&&planned ∪ too_short&&planned）: ${
      gaps.filter(gap => gap.reason === 'missing_planned_section' || ((gap.reason === 'empty' || gap.reason === 'too_short') && gap.planned)).length}`);

    // 三个实测空小节
    const targets = ['作业面勘察与条件核实', '门卫照明回路与应急照明安装', '绿色施工与四节一环保措施'];
    for (const title of targets) {
      const hit = gaps.filter(gap => String(gap.sectionTitle).includes(title) || title.includes(String(gap.sectionTitle)));
      console.log(`[diag] 「${title}」→ 缺口命中 ${hit.length} 条：${hit.map(gap => `${gap.reason}(planned=${gap.planned},bodyLength=${gap.bodyLength})`).join(' / ') || '（未出现在缺口清单）'}`);
    }
    // 各章规划小节里是否真的含这三个标题
    for (const chapter of chapters) {
      const sections = (chapter.sections || []).map(section => String(section));
      for (const title of targets) {
        const declared = sections.some(section => section.includes(title) || title.includes(section));
        if (declared) console.log(`[diag] 「${title}」声明在章「${chapter.title.slice(0, 16)}」的规划小节中 ✓`);
      }
    }
    // ④ 关键：`sectionBodyForTitle` 认为它匹配到了哪个标题？（匹配到有正文的**别的**标题
    //    会让缺口判据认为"该小节已满足"，而真正的空标题仍在——两判据对同一文档结论矛盾）
    for (const title of targets) {
      for (const chapter of chapters) {
        if (!(chapter.sections || []).some(section => String(section).includes(title) || title.includes(String(section)))) continue;
        const headings = [...String(chapter.content).matchAll(/^(#{3,4})\s+(.+)$/gmu)].map(match => ({ level: match[1]!.length, title: match[2]!.trim() }));
        const exact = headings.filter(heading => heading.title.replace(/^\d+(?:\.\d+)*\s*/u, '').replace(/工程$/u, '') === title.replace(/工程$/u, ''));
        console.log(`[diag] 「${title}」在章内同名/近名标题 ${exact.length} 个：${exact.map(heading => `H${heading.level}:${heading.title}`).join(' / ') || '（无完全同名标题）'}`);
        const near = headings.filter(heading => heading.title.includes(title.slice(0, 4)) || title.includes(heading.title.replace(/^\d+(?:\.\d+)*\s*/u, '').slice(0, 4)));
        if (near.length > 0) console.log(`[diag]   近名前 4 字命中：${near.slice(0, 5).map(heading => `H${heading.level}:${heading.title}`).join(' / ')}`);
      }
    }
    console.log('[diag] === 全部缺口逐条 ===');
    for (const gap of gaps) console.log(`[diag]   [${gap.reason}] planned=${gap.planned} len=${gap.bodyLength} 章=${String(gap.chapterTitle).slice(0, 14)} 节=${gap.sectionTitle}`);
    // 该章的规划小节过滤后还剩哪些（补写轮只处理过滤后的 plannedSections）
    for (const chapter of chapters) {
      console.log(`[diag] 章「${String(chapter.title).slice(0, 18)}」规划小节 ${(chapter.sections || []).length} 个；正文 H3 数 ${[...String(chapter.content).matchAll(/^###\s+/gmu)].length}；正文 H4 数 ${[...String(chapter.content).matchAll(/^####\s+/gmu)].length}`);
    }
    console.log('[diag] === emptySectionSpans 直接跑（终检「空小节」判据）===');
    for (const chapter of chapters) {
      const spans = emptySectionSpans(chapter as never);
      if (spans.length === 0) continue;
      console.log(`[diag] 章「${String(chapter.title).slice(0, 16)}」空壳 ${spans.length} 处：`);
      for (const span of spans) console.log(`[diag]   行${span.line} H${span.level} planned=${span.planned} 「${span.rawTitle}」`);
    }
    expect(chapters.length).toBeGreaterThan(0);
  });
});
