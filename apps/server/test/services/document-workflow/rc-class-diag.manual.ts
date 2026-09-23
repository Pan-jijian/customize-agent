/**
 * C 类五项（4.59 R-C）真实文档复现诊断（manual：不进常规门禁）。
 *
 * 目的：把「C 类五项到底是不是稳定现象、条数与报告是否一致、产出它的源码位置」固定成可复跑证据。
 * 数据源（全部真实、只读）：
 * - 正文：assets/巢湖施工组织设计-doc-1790178570374-cfb0a0da.md（= drafts 记录里的 markdown，sha1 已核对一致）
 *         assets/巢湖施工组织设计-doc-1790176444035-ea380252.md
 * - 章节：drafts/doc-*.json → draft.chapters（终检入参）
 * - 蓝图：assets/blueprint.json → data（= session.blueprintData）
 * - 招标要求模型：cache/document-workflow/<projHash>/tender-requirements-*.json（最新一份）
 * - 对照：reports/doc-*-review.md 的 blocker 清单（用户看到的数字）
 *
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/services/document-workflow/rc-class-diag.manual.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  constructionOrgDivisionSectionIssues,
  majorContentGovernanceIssues,
} from '@/services/document-workflow/constructionOrgQualityRules';
import { markdownTableQualityIssues, resourceBreakdownConsistencyIssues } from '@/services/document-workflow/qualityValidation';
import { tenderRequirementResponseGaps } from '@/services/document-workflow/tenderRequirements';
import { workPackageContentElementFlags } from '@/services/document-workflow/utils';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';
import type { DocumentDraftChapter, TenderRequirementEntry } from '@/services/document-workflow/types';

/** 诊断输出落盘（vitest 控制台拦截下 console.log 不进 stdout；写文件保证可复跑读取） */
const OUT_PATH = '/tmp/cclass-diag.txt';
fs.writeFileSync(OUT_PATH, '');
const report = (...parts: unknown[]) => {
  fs.appendFileSync(OUT_PATH, `${parts.map(part => String(part)).join(' ')}\n`);
};

const PROJECT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', '3c3f04667c69');
const ASSETS = path.join(PROJECT_DIR, 'generatedDocuments', 'assets');
const DRAFTS = path.join(PROJECT_DIR, 'generatedDocuments', 'drafts');

const DOCS = [
  { id: 'doc-1790176444035-ea380252', file: '巢湖施工组织设计-doc-1790176444035-ea380252.md' },
  { id: 'doc-1790178570374-cfb0a0da', file: '巢湖施工组织设计-doc-1790178570374-cfb0a0da.md' },
];

function loadDoc(id: string, file: string) {
  const markdown = fs.readFileSync(path.join(ASSETS, file), 'utf8');
  const record = JSON.parse(fs.readFileSync(path.join(DRAFTS, `${id}.json`), 'utf8')) as {
    markdown?: string;
    draft?: { chapters?: DocumentDraftChapter[] };
  };
  const chapters = record.draft?.chapters ?? [];
  return { markdown, chapters };
}

/** 招标要求模型：取 cache 里最近写入的一份（含本会话条款原文） */
function loadTenderEntries(): TenderRequirementEntry[] {
  const dir = path.join(os.homedir(), '.customize-agent', 'cache', 'document-workflow');
  const hashDirs = fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir, name)).isDirectory());
  const files: Array<{ file: string; mtime: number }> = [];
  for (const hash of hashDirs) {
    for (const name of fs.readdirSync(path.join(dir, hash))) {
      if (!name.startsWith('tender-requirements-')) continue;
      const full = path.join(dir, hash, name);
      files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
    }
  }
  files.sort((left, right) => right.mtime - left.mtime);
  for (const candidate of files) {
    try {
      const model = JSON.parse(fs.readFileSync(candidate.file, 'utf8')) as { entries?: TenderRequirementEntry[] };
      if ((model.entries?.length ?? 0) > 0) return model.entries!;
    } catch { /* 损坏缓存跳过 */ }
  }
  return [];
}

const blueprintData = (JSON.parse(fs.readFileSync(path.join(ASSETS, 'blueprint.json'), 'utf8')) as {
  data: BlueprintData;
  validation?: { passed?: boolean };
}).data;

describe('C 类五项 · 真实文档复现', () => {
  for (const doc of DOCS) {
    const { markdown, chapters } = loadDoc(doc.id, doc.file);

    it(`[${doc.id}] C1 分项方案要素不全`, () => {
      const issues = constructionOrgDivisionSectionIssues(chapters, markdown).filter(issue => issue.message.includes('要素不全'));
      report(`[C1] ${doc.id} blocker 条数=${issues.length}`);
      for (const issue of issues) report(`  · ${issue.message.slice(0, 400)}`);
      // 逐块三要素明细（判据单源：同一个 workPackageContentElementFlags）——
      // 复刻检测器的块准备：章范围（## 到下一 ##）→ 按 ^#### 切 → cutAtEmbeddedHeading 截断
      const divisionChapter = chapters.find(chapter => /主要施工方法/u.test(chapter.title));
      if (divisionChapter) {
        const chapterLines = markdown.split('\n');
        const startIndex = chapterLines.findIndex(line => /^##\s+/u.test(line.trim()) && /主要施工方法/u.test(line));
        let endIndex = chapterLines.length;
        for (let index = startIndex + 1; index < chapterLines.length; index += 1) {
          if (/^##\s+/u.test(chapterLines[index].trim())) { endIndex = index; break; }
        }
        const chapterBody = chapterLines.slice(startIndex, endIndex).join('\n');
        const cutAtEmbeddedHeading = (block: string): string => block.split(/\n(?=#{1,3}\s)/u)[0].trim();
        const rawBlocks = chapterBody.split(/^####\s+/gmu).slice(1);
        const cutBlocks = rawBlocks.map(cutAtEmbeddedHeading).filter(Boolean);
        const flag = (block: string) => {
          const flags = workPackageContentElementFlags(block);
          return !(flags.scope && flags.process && flags.method);
        };
        report(`  [C1] 章=「${divisionChapter.title}」 裸块=${rawBlocks.length} 截断后块=${cutBlocks.length} 裸缺要素=${rawBlocks.filter(flag).length} 截断后缺要素=${cutBlocks.filter(flag).length}`);
        for (const [index, block] of cutBlocks.entries()) {
          const title = (block.split('\n')[0] ?? '').trim().slice(0, 40);
          const flags = workPackageContentElementFlags(block);
          const rawLen = rawBlocks[index]?.replace(/\s/gu, '').length ?? 0;
          if (flags.scope && flags.process && flags.method) continue;
          report(`    - ${title} scope=${flags.scope} process=${flags.process} method=${flags.method} 截断后len=${block.replace(/\s/gu, '').length} 裸len=${rawLen}${rawLen === block.replace(/\s/gu, '').length ? '' : ' ★被cutAtEmbeddedHeading截断'}`);
        }
      }
      expect(issues.length).toBeGreaterThanOrEqual(0);
    });

    it(`[${doc.id}] C5 小节正文含工程量清单内部口径词`, () => {
      const issues = majorContentGovernanceIssues(markdown).filter(issue => issue.message.includes('内部口径词'));
      report(`[C5] ${doc.id} blocker 条数=${issues.length}`);
      for (const issue of issues) report(`  · ${issue.message.slice(0, 260)}`);
      expect(issues.length).toBeGreaterThanOrEqual(0);
    });

    it(`[${doc.id}] C3 表格占位符单元格`, () => {
      const issues = markdownTableQualityIssues(markdown).filter(issue => issue.message.includes('占位符'));
      report(`[C3] ${doc.id} blocker 条数=${issues.length}`);
      for (const issue of issues) report(`  · ${issue.message.slice(0, 240)}`);
      expect(issues.length).toBeGreaterThanOrEqual(0);
    });

    it(`[${doc.id}] C2 材料规格拆分数量与蓝图权威不一致`, () => {
      const issues = resourceBreakdownConsistencyIssues(markdown, blueprintData);
      const material = issues.filter(issue => issue.message.includes('材料'));
      report(`[C2] ${doc.id} 材料类 blocker 条数=${material.length}（全部 ${issues.length}）`);
      for (const issue of material) report(`  · ${issue.message.slice(0, 220)}`);
      expect(material.length).toBeGreaterThanOrEqual(0);
    });
  }

  it('C4 招标要求响应 · 确定性三通道复现（无 LLM 兜底：结果集为上界）', () => {
    const entries = loadTenderEntries();
    report(`[C4] 招标要求条目=${entries.length}`);
    expect(entries.length).toBeGreaterThan(0);
    for (const doc of DOCS) {
      const { markdown } = loadDoc(doc.id, doc.file);
      const gaps = tenderRequirementResponseGaps(entries, markdown);
      const unsatisfied = gaps.filter(gap => !gap.satisfied);
      const partial = unsatisfied.filter(gap => gap.hit.length > 0);
      const zero = unsatisfied.filter(gap => gap.hit.length === 0);
      report(`[C4] ${doc.id} 未满足=${unsatisfied.length} 部分响应候选=${partial.length} 零命中=${zero.length}`);
      for (const gap of partial) report(`  · [部分] ${gap.entry.category}“${gap.entry.text.slice(0, 90)}” hit=${gap.hit.join('/')} missing=${gap.missing.join('/')}`);
      for (const gap of zero) report(`  · [零命中] ${gap.entry.category}“${gap.entry.text.slice(0, 90)}”`);
    }
  });
});
