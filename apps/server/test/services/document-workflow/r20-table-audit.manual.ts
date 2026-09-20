/**
 * R20 表格逐表对账·r19 真实产物干跑（manual：不进常规门禁）。
 * 目的（P2-C2 出口验证）：
 * 1. r19 真实规划表（drafts JSON .draft.chapters[].tablePlans）逐张与 r19 终稿 markdown 对账；
 * 2. 缺失清单必须与人工审计一致（6 张真丢表），「劳动力配置汇总表 ↔ 分阶段劳动力投入表」类表名漂移零误报；
 * 3. 数量口径对照：旧口径（≥60% 且缺≥2 才报）全章放行（丢 1 张永远漏网），逐表口径必须检出。
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/services/document-workflow/r20-table-audit.manual.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tablePlanExecutionGaps } from '@/services/document-workflow/constructionOrgTablePlan';
import type { DocumentTemplateChapter } from '@/services/document-workflow/types';

const PROJECT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', '3c3f04667c69');
const DRAFTS_JSON = path.join(PROJECT_DIR, 'generatedDocuments', 'drafts', 'doc-1789649400094-b1151314.json');
const R19_MARKDOWN = path.join(process.cwd(), '.dbg', 'r19-markdown.md');

/** 人工审计确认的 r19 真丢表（python 原型 v2 与逐表对账必须一致命中） */
const EXPECTED_MISSING = [
  '外装饰材料色彩报审清单',
  '机械设备日常检查与维保记录表',
  '劳动力实名制与工资发放检查记录表',
  '危险作业管控台账',
  '工期滞后预警与纠偏台账',
  '施工总平面布置要素控制表',
];

/** r19 终稿 markdown 按二级标题分章（章标题含「第X章」前缀，规划章标题为纯净名，靠 includes 匹配） */
function splitMarkdownChapters(markdown: string): Array<{ title: string; content: string }> {
  const chapters: Array<{ title: string; content: string }> = [];
  let current: { title: string; content: string } | undefined;
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      if (current) chapters.push(current);
      current = { title: heading[1], content: `${line}\n` };
      continue;
    }
    if (current) current.content += `${line}\n`;
  }
  if (current) chapters.push(current);
  return chapters;
}

/** 旧数量口径复刻（markdown 表格计数 + ≥60%/缺≥2 放行判据） */
function legacyFlaggedChapterCount(chapters: DocumentTemplateChapter[], drafts: Array<{ title: string; content: string }>) {
  const countTables = (markdown: string) => markdown.split(/\r?\n/u).filter(line => /^\s*\|?\s*:?-{3,}:?/u.test(line) && line.includes('|')).length;
  let flagged = 0;
  for (const chapter of chapters) {
    const plans = chapter.tablePlans || [];
    if (plans.length === 0) continue;
    const draft = drafts.find(item => item.title === chapter.title) || drafts.find(item => chapter.title.includes(item.title) || item.title.includes(chapter.title));
    if (!draft) continue;
    const actual = countTables(draft.content);
    if (actual >= plans.length * 0.6 || plans.length - actual < 2) continue;
    flagged += 1;
  }
  return flagged;
}

describe('R20 逐表对账·r19 真实产物干跑（6 张真丢必捕 + 漂移零误报）', () => {
  it('逐表对账缺失与人工审计一致，旧数量口径对照全放行', () => {
    if (!fs.existsSync(DRAFTS_JSON) || !fs.existsSync(R19_MARKDOWN)) {
      console.log('[r20-table] drafts JSON 或 r19 markdown 缺失，跳过');
      return;
    }
    const record = JSON.parse(fs.readFileSync(DRAFTS_JSON, 'utf8')) as { draft?: { chapters?: DocumentTemplateChapter[] } };
    const chapters = record.draft?.chapters || [];
    const drafts = splitMarkdownChapters(fs.readFileSync(R19_MARKDOWN, 'utf8'));
    const totalPlans = chapters.reduce((sum, chapter) => sum + (chapter.tablePlans?.length || 0), 0);
    const gaps = tablePlanExecutionGaps(chapters, drafts);
    const missingTitles = gaps.flatMap(gap => gap.plans.map(plan => plan.title));
    // 逐章输出对账明细（诊断用）
    console.log(`\n[r20-table] 规划表合计=${totalPlans}，章数=${chapters.length}，缺口章数=${gaps.length}`);
    for (const chapter of chapters) {
      const plans = chapter.tablePlans || [];
      if (plans.length === 0) continue;
      const gap = gaps.find(item => item.chapterTitle === chapter.title);
      const missing = gap ? gap.plans.map(plan => plan.title) : [];
      console.log(`  ${missing.length > 0 ? '✗' : '✓'} ${chapter.title}（计划 ${plans.length} 张）${missing.length > 0 ? ` 缺失：${missing.join('、')}（实际 ${gap?.actual} 张）` : ''}`);
    }
    console.log(`[r20-table] 缺失合计=${missingTitles.length}：${missingTitles.join('、')}`);
    // 旧口径对照：同一数据下旧数量口径全章放行（正是 r19 丢表漏网的根因证据）
    const legacyFlagged = legacyFlaggedChapterCount(chapters, drafts);
    console.log(`[r20-table] 旧数量口径检出章数=${legacyFlagged}（0 = 漏网实证）`);
    expect(legacyFlagged).toBe(0);
    expect([...missingTitles].sort()).toEqual([...EXPECTED_MISSING].sort());
  });
});
