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
import { collectRequirementAnchors, tenderRequirementResponseGaps } from '@/services/document-workflow/tenderRequirements';
import { workPackageContentElementFlags, workPackageContentElementsComplete } from '@/services/document-workflow/utils';
import { loadBetterSqlite3 } from '@customize-agent/knowledge';
import { buildBillFactLock } from '@/services/document-workflow/billFactLock';
import { resolveBillOfQuantities } from '@/services/document-workflow/integratedBlueprint';
import type { BillFactLock } from '@/services/document-workflow/billFactLock';
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
/** 生成期 projectRoot 实测值：computeProjectId(仓库根) = 3c3f04667c69 = 本项目目录名，
 * 即 dev 环境下生成管线传的是仓库根，kb.db 落在项目目录下（传项目目录会算成 8f28d607dc90 → 找不到库） */
const PROJECT_ROOT = '/Users/pan/Desktop/codeing/customize-agent';

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

const blueprintRecord = JSON.parse(fs.readFileSync(path.join(ASSETS, 'blueprint.json'), 'utf8')) as {
  meta?: { sourceMaterials?: string[] };
  data: BlueprintData;
  validation?: { passed?: boolean };
};
const blueprintData = blueprintRecord.data;
/** 生成期绑定资料清单（= session.prepare.materialFilePaths，蓝图 meta 落盘同源） */
const boundFilePaths = blueprintRecord.meta?.sourceMaterials ?? [];

/** 清单事实锁：与生成管线同源（resolveBillOfQuantities → buildBillFactLock）——
 * 巢湖清单是 8 份分单位工程 .xls，必须走并集解析（单文件口径会取错清单） */
function buildLock(): BillFactLock | undefined {
  try {
    const { boq, warning } = resolveBillOfQuantities({ projectRoot: PROJECT_ROOT, boundFilePaths });
    report(`[lock] 绑定资料=${boundFilePaths.length} 份；warning=${warning ?? '无'}`);
    if (!boq) return undefined;
    report(`[lock] 清单条目=${boq.totalEntries}`);
    return buildBillFactLock({ boq });
  } catch (error) {
    report(`[lock] 构建失败：${(error as Error).message}`);
    return undefined;
  }
}

const billFactLock = buildLock();

describe('C 类五项 · 真实文档复现', () => {
  for (const doc of DOCS) {
    const { markdown, chapters } = loadDoc(doc.id, doc.file);

    it(`[${doc.id}] C1 分项方案要素不全`, () => {
      const allIssues = constructionOrgDivisionSectionIssues(chapters, markdown);
      const issues = allIssues.filter(issue => issue.message.includes('要素不全'));
      report(`[C1] ${doc.id} blocker 条数=${issues.length}（本章全部 blocker=${allIssues.filter(issue => issue.severity === 'blocker').length}）`);
      for (const issue of issues) report(`  · ${issue.message.slice(0, 400)}`);
      for (const issue of allIssues.filter(item => item.severity === 'blocker' && !item.message.includes('要素不全'))) {
        report(`  [C1-其余] ${issue.message.slice(0, 260)}`);
      }
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

    it(`[${doc.id}] C1 修复后逐块归因（豁免/前导继承/词表补漏 三者哪个救了它）`, () => {
      // 归因数据（非判据镜像）：生产判据仍是 constructionOrgQualityRules 单源；此处只打印
      // 「块标题 | H3 前导字数 | 豁免族 | 自块三要素 | 合并后完整」以解释 blocker 归零的机制
      const divisionChapter = chapters.find(chapter => /主要施工方法/u.test(chapter.title));
      if (!divisionChapter) return;
      const chapterLines = markdown.split('\n');
      const startIndex = chapterLines.findIndex(line => /^##\s+/u.test(line.trim()) && /主要施工方法/u.test(line));
      let endIndex = chapterLines.length;
      for (let index = startIndex + 1; index < chapterLines.length; index += 1) {
        if (/^##\s+/u.test(chapterLines[index].trim())) { endIndex = index; break; }
      }
      const body = chapterLines.slice(startIndex, endIndex).join('\n');
      const cutAtEmbeddedHeading = (text: string): string => text.split(/\n(?=#{1,3}\s)/u)[0].trim();
      const NON_PACKAGE = /编制依据|编制说明|编制原则|法律法规|规范标准|标准规范|技术标准|地方性法规|政府规章|文明施工|环境保护|进度计划|网络图|横道图|施工部署|平面布置|组织机构|资源配置|职责分工/u;
      const anchors = [...body.matchAll(/^###\s+([^\n]*)/gmu)].map(match => ({ at: match.index ?? 0, title: (match[1] ?? '').trim(), end: (match.index ?? 0) + match[0].length }));
      const h3At = (offset: number) => {
        let owner: { title: string; end: number } | undefined;
        for (const item of anchors) { if (item.at >= offset) break; owner = { title: item.title, end: item.end }; }
        if (!owner) return { title: '', preamble: '' };
        const preambleLines: string[] = [];
        for (const line of body.slice(owner.end).split('\n')) {
          if (/^#{1,6}\s/u.test(line.trim())) break;
          preambleLines.push(line);
        }
        return { title: owner.title, preamble: preambleLines.join('\n').trim() };
      };
      const h4Anchors = [...body.matchAll(/^####\s+/gmu)].map(match => ({ at: match.index ?? 0, contentStart: (match.index ?? 0) + match[0].length }));
      const packages = h4Anchors.map((anchor, index) => {
        const end = index + 1 < h4Anchors.length ? h4Anchors[index + 1].at : body.length;
        return { offset: anchor.at, block: cutAtEmbeddedHeading(body.slice(anchor.contentStart, end)) };
      }).filter(entry => Boolean(entry.block));
      let exempt = 0;
      for (const entry of packages) {
        const rawTitle = (entry.block.split('\n')[0] ?? '').trim();
        const { title, preamble } = h3At(entry.offset);
        const catchAll = /^[\d.．、\s]*(?:其他|其它)/u.test(rawTitle);
        const nonPackage = NON_PACKAGE.test(`${title} ${rawTitle}`);
        const own = workPackageContentElementFlags(entry.block);
        const merged = workPackageContentElementsComplete(preamble ? `${preamble}\n${entry.block}` : entry.block);
        const reason = catchAll ? '兜底块' : nonPackage ? '非方案主题' : '—';
        if (catchAll || nonPackage) exempt += 1;
        report(`    [归因] ${rawTitle.slice(0, 30)} | H3=「${title}」前导=${preamble.replace(/\s/gu, '').length}字 | 豁免=${reason} | 自块 scope=${own.scope} process=${own.process} method=${own.method} | 合并后完整=${merged} | 块字数=${entry.block.replace(/\s/gu, '').length}`);
      }
      report(`  [C1] ${doc.id} 类别豁免块=${exempt}/${packages.length}`);
      expect(true).toBe(true);
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
      // 无锁（旧口径）与有锁（生产口径）各跑一次——生产终检传 billFactLock，口径分层依赖它
      const withoutLock = resourceBreakdownConsistencyIssues(markdown, blueprintData).filter(issue => issue.message.includes('材料'));
      const issues = resourceBreakdownConsistencyIssues(markdown, blueprintData, billFactLock).filter(issue => issue.message.includes('材料'));
      report(`[C2] ${doc.id} 材料类 blocker 条数=${issues.length}（无锁=${withoutLock.length}）`);
      for (const issue of issues) report(`  · ${issue.message.slice(0, 220)}`);
      expect(issues.length).toBeGreaterThanOrEqual(0);
    });
  }

  it('C4 终稿 blocker 逐条锚点解剖（报告 blocker ↔ 判定通道对照）', () => {
    const entries = loadTenderEntries();
    const reports = fs.readdirSync(path.join(PROJECT_DIR, 'generatedDocuments', 'reports')).filter(name => /ea380252|cfb0a0da/u.test(name));
    for (const name of reports) {
      const text = fs.readFileSync(path.join(PROJECT_DIR, 'generatedDocuments', 'reports', name), 'utf8');
      const docId = name.replace('-review.md', '');
      const { markdown } = loadDoc(docId, DOCS.find(doc => doc.id === docId)!.file);
      const gaps = tenderRequirementResponseGaps(entries, markdown);
      const norm = (value: string) => value.replace(/\s+/gu, '');
      for (const line of text.split('\n')) {
        if (!line.includes('[blocker] 招标要求')) continue;
        const clauseMatch = /招标要求(?:未响应|部分响应)：[^“]*“([^”]+)”/u.exec(line);
        if (!clauseMatch) continue;
        const clauseHead = norm(clauseMatch[1]).slice(0, 18);
        const gap = gaps.find(item => norm(item.entry.text).startsWith(clauseHead));
        const kind = /未响应/u.test(line) ? '零命中' : '部分响应';
        if (!gap) { report(`[C4-解剖] ${docId} ${kind} 未匹配到条目前 18 字：${clauseHead}`); continue; }
        const anchors = collectRequirementAnchors(gap.entry);
        // 修复后判定（生产口径：锚点全覆盖 → 放行；锚点 ∅ → 转 warning 不再阻断）
        const verdict = gap.satisfied ? '已满足（blocker 消失）'
          : anchors.length === 0 ? '锚点 ∅ → 不可核验（blocker 转 warning，留可见记录）'
          : gap.hit.length === 0 ? '仍判零命中（有锚点、全缺）' : '仍判部分响应（有锚点、缺锚点）';
        report(`[C4-解剖] ${docId} ${kind} 报告结论=${verdict}`);
        report(`           锚点=${anchors.join('|') || '（∅）'}`);
        report(`           hit=${gap.hit.join('|') || '（空）'} missing=${gap.missing.join('|') || '（空）'} satisfied=${gap.satisfied}`);
      }
    }
    expect(true).toBe(true);
  });

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
