/**
 * 骨架名提取全链路确定性复现（manual，不入 vitest 常规集）：
 * 丰乐镇真实数据验证 majorConstructionSkeletonNames 三来源（图谱/招标范围/清单条目）在
 * 完整上下文 + 真实章节证据集下的实际表现。P1.2 修复前提验证：
 * ① constructionOrgContext（完整上下文与瘦身版都含）中的工作包行能否被 parseMajorConstructionPackages 提取；
 * ② 串染项目工作包（舒城/合肥师范）是否混入图谱名（B7 项目名过滤是否拦截）；
 * ③ 真实第一章证据集（10 条）下 scopeNames/billNames 能否兑底 ≥3 骨架名。
 * 运行：npx vitest run --config /tmp/vitest-manual.config.ts
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  majorConstructionSkeletonNames,
  parseMajorConstructionPackages,
  scopeEngineeringNames,
} from '../src/services/document-workflow/chapterPostProcessing';
import { constructionOrganizationPrompt } from '../src/services/document-workflow/projectIntelligence';
import type { DocumentEvidence } from '../src/services/document-workflow/types';

const PROJECT_ROOT = '/Users/pan/.customize-agent/projects/3c3f04667c69';
const DRAFT = `${PROJECT_ROOT}/generatedDocuments/drafts/doc-1788704851993-9bfa7d76.json`;

function loadDraftEvidence(chapterTitleIncludes: string): DocumentEvidence[] {
  const draft = JSON.parse(readFileSync(DRAFT, 'utf8'));
  const chapter = (draft.checkpointChapters || []).find((c: { title: string }) => c.title.includes(chapterTitleIncludes));
  if (!chapter) throw new Error(`draft 无章节 ${chapterTitleIncludes}`);
  return (chapter.evidence || []).map((e: Record<string, unknown>) => ({
    chapterId: String(e.chapterId || 'chapter'),
    filePath: String(e.filePath || ''),
    score: Number(e.score || 1),
    content: String(e.content || ''),
    roleId: String(e.roleId || 'other'),
    processingType: String(e.processingType || 'reference'),
    sectionTitle: e.sectionTitle ? String(e.sectionTitle) : undefined,
    source: String(e.source || 'draft'),
  }));
}

function loadConstructionOrgContext(): string {
  const intelligence = JSON.parse(readFileSync(`${PROJECT_ROOT}/project-intelligence/project-intelligence.json`, 'utf8'));
  return constructionOrganizationPrompt(intelligence.constructionOrganizationGraph);
}

describe('丰乐镇骨架名提取三来源真实数据复现', () => {
  it('图谱/招标范围/清单三通道 + 串染检查', { timeout: 120000 }, () => {
    const orgContext = loadConstructionOrgContext();
    console.log(`[0] constructionOrgContext ${orgContext.length} 字符`);
    console.log(`    含「施工工作包结构化数据」=${orgContext.includes('施工工作包结构化数据')} 含「｜范围：」行=${/^\d+\.\s.+?｜范围：/mu.test(orgContext)}`);

    // ① 图谱通道：constructionOrgContext 是完整上下文与瘦身版共有部分
    const packages = parseMajorConstructionPackages(orgContext, []);
    console.log(`[1] 图谱包提取 ${packages.length} 个:`);
    for (const pkg of packages) console.log(`    - ${pkg.name} | ${pkg.scope.slice(0, 60)}`);

    // ② 第一章真实证据集（上一轮生成实际使用）
    const ch1 = loadDraftEvidence('工程概况');
    console.log(`[2] 第一章证据 ${ch1.length} 条，${ch1.reduce((s, e) => s + e.content.length, 0)} 字符`);
    const zw = ch1.filter(e => e.content.includes('招标范围'));
    console.log(`    含「招标范围」chunk ${zw.length} 条：`);
    for (const e of zw) console.log(`      - ${e.sectionTitle?.slice(0, 26)} | ${e.content.replace(/\n/g, ' ').slice(0, 130)}`);

    const scope = scopeEngineeringNames(orgContext, ch1);
    console.log(`[3] 招标范围通道提取 ${scope.length} 个: ${scope.join('、') || '(空)'}`);

    const merged = majorConstructionSkeletonNames(orgContext, ch1);
    console.log(`[4] 三来源合并（第一章证据）: ${merged.length} 个 → ${merged.join('、') || '(空)'}`);

    // ③ 主要施工方法章证据集（含 PDF 第 4 页「2.9招标范围」正文 chunk）
    const ch2 = loadDraftEvidence('主要施工方法');
    const merged2 = majorConstructionSkeletonNames(orgContext, ch2);
    console.log(`[5] 三来源合并（主要施工方法章证据）: ${merged2.length} 个 → ${merged2.join('、') || '(空)'}`);

    // ④ 证据 filePath 空格损坏检查：draft 落盘的「编 制」与磁盘「编制」不一致 → 清单磁盘解析哑火
    const boqEvidence = ch2.filter(e => /xls/u.test(e.filePath));
    for (const e of boqEvidence) {
      console.log(`[5a] 清单证据 filePath=${JSON.stringify(e.filePath)} 含空格损坏=${/\s{2,}|(?<=[\u4e00-\u9fff])\s(?=[\u4e00-\u9fff])/u.test(e.filePath)}`);
    }
    // 路径清洗后（空格移除）重跑：验证 billNames 磁盘解析兑底
    const cleanedCh2 = ch2.map(e => ({ ...e, filePath: e.filePath.replace(/\s+/gu, '') }));
    const merged2Cleaned = majorConstructionSkeletonNames(orgContext, cleanedCh2);
    console.log(`[5b] 路径清洗后三来源合并（主要施工方法章）: ${merged2Cleaned.length} 个 → ${merged2Cleaned.join('、') || '(空)'}`);

    // ⑤ 真实清单文件（2026年度…建设项目.xls）直接入证据：验证清单条目兑底能力
    const realBoqEvidence: DocumentEvidence[] = [{
      chapterId: 'chapter',
      filePath: '9.14--2026年度丰乐镇20个美丽宜居自然村建设项目(1)/4、工程量清单和编制说明/2026年度丰乐镇20个美丽宜居自然村建设项目.xls',
      score: 2,
      content: '',
      roleId: 'bill_of_quantities',
      processingType: 'table',
      source: 'manual',
    }];
    const merged3 = majorConstructionSkeletonNames(orgContext, realBoqEvidence);
    console.log(`[6] 真实清单文件入证据后三来源合并: ${merged3.length} 个 → ${merged3.join('、') || '(空)'}`);

    // ⑥ 骨架锁定的 minCount=3 门槛判定
    console.log(`[7] 第一章证据下骨架锁定触发=${merged.length >= 3}；主要施工方法章证据下触发=${merged2.length >= 3}；路径清洗后触发=${merged2Cleaned.length >= 3}；真实清单入证据触发=${merged3.length >= 3}`);

    // 验证假设：完整上下文（orgContext 属于完整上下文的子集）下三来源之一应可兑底
    // 串染防线：图谱包不应含舒城/合肥师范项目名形态
    for (const pkg of packages) {
      expect(pkg.name).not.toMatch(/舒城|合肥师范/u);
    }
    expect(true).toBe(true);
  });
});
