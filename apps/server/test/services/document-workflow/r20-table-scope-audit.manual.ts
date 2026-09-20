/**
 * R20 C4 规划污染过滤·r19 真实产物回归（manual：不进常规门禁）。
 * 目的（P2-C4 出口验证）：
 * 1. r19 真实规划表（drafts JSON .draft.chapters[].tablePlans，26 张）逐张过 auditPlannedTableScope；
 * 2. 判据取真实数据：招标范围段（tender-text.txt 招标公告 2.6/2.9 原文）+ 清单分部全景
 *    （draft.factsModel → extractBoqDivisionCoverage，与生产同链路）；
 * 3. 期望：真实数据下零误剔（含此前误判的「外装饰材料色彩报审清单」——工程含公厕外墙真石漆/
 *    墙面彩绘（清单），设计说明 5.6「所有外装饰材料色彩需报小样」（图纸），均属本标段内容）；
 *    剔除项明细打印供人工复查。
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/services/document-workflow/r20-table-scope-audit.manual.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditPlannedTableScope, type PlannedTableScopeEntry } from '@/services/document-workflow/tableScopeAudit';
import { extractBoqDivisionCoverage, formatBoqDivisionCoverage } from '@/services/document-workflow/documentFactTrace';
import { displayChapterTitle } from '@/services/document-workflow/outline';
import type { DocumentFactsModel, DocumentTemplateChapter } from '@/services/document-workflow/types';

const PROJECT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', '3c3f04667c69');
const R19_DRAFTS_JSON = path.join(PROJECT_DIR, 'generatedDocuments', 'drafts', 'doc-1789649400094-b1151314.json');
const TENDER_TEXT = path.join(process.cwd(), '.dbg', 'tender-text.txt');

/** 从招标全文截取真实范围段（招标公告 2.6 建设规模 / 2.9 招标范围原文之间） */
function realScopeSentences(tender: string): string[] {
  const cut = (startMarker: string, endMarker: string) => {
    const start = tender.indexOf(startMarker);
    if (start < 0) return '';
    const end = tender.indexOf(endMarker, start + startMarker.length);
    return tender.slice(start + startMarker.length, end > start ? end : start + 500).trim();
  };
  return [
    cut('2.6 建设规模：', '2.7 '),
    cut('2.9 招标范围：', '2.10 '),
  ].filter(Boolean);
}

describe('R20 C4 规划污染过滤·r19 真实产物回归', () => {
  it('外装饰表被剔除，其余规划表保留（真实 LLM 范围核对）', async () => {
    if (!fs.existsSync(R19_DRAFTS_JSON) || !fs.existsSync(TENDER_TEXT)) {
      console.log('[c4-scope] 数据缺失，跳过');
      return;
    }
    const record = JSON.parse(fs.readFileSync(R19_DRAFTS_JSON, 'utf8')) as { draft?: { chapters?: DocumentTemplateChapter[]; factsModel?: DocumentFactsModel } };
    const chapters = record.draft?.chapters || [];
    const tables: PlannedTableScopeEntry[] = chapters.flatMap(chapter =>
      (chapter.tablePlans || []).map(plan => ({
        chapterTitle: displayChapterTitle(chapter.title),
        title: plan.title,
        fields: (plan.fields || []).map(field => (field as { name?: string }).name || String(field)),
      })));
    const requirementSummary = realScopeSentences(fs.readFileSync(TENDER_TEXT, 'utf8').replace(/\s+/gu, ' '));
    const boqCoverageSummary = formatBoqDivisionCoverage(extractBoqDivisionCoverage(record.draft?.factsModel as DocumentFactsModel));
    console.log(`\n[c4-scope] 规划表=${tables.length} 张，招标范围判据=${requirementSummary.length} 条，清单全景行数=${boqCoverageSummary.split('\n').length}`);
    console.log(`[c4-scope] 招标范围判据首条：${requirementSummary[0]?.slice(0, 80)}...`);
    const result = await auditPlannedTableScope({ tables, requirementSummary, boqCoverageSummary, templateName: record.draft?.chapters?.[0] ? '施工组织设计' : undefined });
    console.log(`[c4-scope] 剔除 ${result.removed.length} 项：`);
    for (const item of result.removed) console.log(`  ✗ ${item.chapterTitle}：${item.title}（${item.reason}）`);
    if (result.skipped) console.log(`[c4-scope] skipped=${result.skipped}`);
    const keptTitles = tables.filter(table => !result.removed.some(item => item.title === table.title)).map(table => table.title);
    console.log(`[c4-scope] 保留 ${keptTitles.length} 张：${keptTitles.join('、')}`);
    // 出口断言（r20 修正）：判据链修复（GB 分部/中文序数/村组段落入全景）+ 语义关联规则后，
    // 26 张规划表均属本标段内容 → 零误剔（含此前误判的外装饰表：清单有公厕外墙真石漆/墙面彩绘，
    // 图纸设计说明 5.6 要求外装饰材料色彩报小样——表字段与其逐一对应）
    const removedTitles = result.removed.map(item => item.title);
    for (const keep of ['外装饰材料色彩报审清单', '施工机械设备投入计划表', '劳动力配置汇总表', '道路结构层材料验收控制表', '绿化苗木与种植物资进场计划表', '绿化栽植质量检查记录表', '生态池及排水工程材料进场计划表', '施工总平面布置要素控制表']) {
      expect(removedTitles).not.toContain(keep);
    }
    expect(result.removed.length).toBe(0);
  }, 120000);
});
