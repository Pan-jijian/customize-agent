/**
 * R20 规格拆分绑定·r19 真实产物干跑（manual：不进常规门禁）。
 * 目的（P1 出口验证）：
 * 1. 由真实 kb.db 清单重建 billFactLock + quantities（含 R20 specBreakdown）→ 复原 P0 根因链的修复态；
 * 2. 基线对照：同一 markdown 分别用「旧口径 quantities（剥除 specBreakdown）」与「新口径」跑 D4 全量对账，
 *    新增命中集合必须全部为路灯「合计挂单项」类（零其他新增 = 真文档零误报）；
 * 3. 确定性修复后：前进/表格形态清零（118→109），值前置形态保留 blocker 交 LLM 轮改述。
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/services/document-workflow/r20-lights-dryrun.manual.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBetterSqlite3 } from '@customize-agent/knowledge';
import { loadBoqChunksFromKb, parseBillOfQuantities } from '@/services/document-workflow/billOfQuantitiesParser';
import { buildBillFactLock } from '@/services/document-workflow/billFactLock';
import { deriveQuantitiesFromBoq } from '@/services/document-workflow/integratedBlueprint';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';
import type { DocumentFactsModel } from '@/services/document-workflow/types';
import { factReconciliationIssues, fixSpecQuantityBindings } from '@/services/document-workflow/factReconciliation';

const PROJECT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', '3c3f04667c69');
const KB_DB = path.join(PROJECT_DIR, 'kb.db');
const R19_MARKDOWN = path.join(process.cwd(), '.dbg', 'r19-markdown.md');

/** 从 kb.db 动态解析丰乐镇清单文件相对路径（与既有 manual 同源） */
function resolveBoqFilePath(dbPath: string): string | undefined {
  const Sqlite = loadBetterSqlite3();
  const db = new Sqlite(dbPath, { readonly: true });
  try {
    const row = db.prepare(
      "SELECT relative_path FROM kb_chunks WHERE relative_path LIKE '%丰乐镇20个美丽宜居自然村建设项目.xls' GROUP BY relative_path ORDER BY COUNT(*) DESC LIMIT 1",
    ).get() as { relative_path?: string } | undefined;
    return row?.relative_path;
  } finally {
    db.close();
  }
}

describe('R20 规格拆分绑定·r19 真实产物干跑（新增命中零误报 + 路灯缺陷必捕）', () => {
  it('旧/新口径基线对照 + 确定性修复收敛', () => {
    if (!fs.existsSync(KB_DB) || !fs.existsSync(R19_MARKDOWN)) {
      console.log('[r20] kb.db 或 r19 markdown 缺失，跳过');
      return;
    }
    const markdown = fs.readFileSync(R19_MARKDOWN, 'utf8');
    const boqFile = resolveBoqFilePath(KB_DB);
    if (!boqFile) {
      console.log('[r20] 未解析到清单文件，跳过');
      return;
    }
    const chunks = loadBoqChunksFromKb(KB_DB, boqFile);
    const boq = parseBillOfQuantities({ chunks, sourceFile: boqFile });
    const billFactLock = buildBillFactLock({ boq });
    const quantitiesNew = deriveQuantitiesFromBoq(boq);
    // 旧口径：剥除 specBreakdown（复现 r19 生成时代的权威形态）
    const quantitiesOld = Object.fromEntries(
      Object.entries(quantitiesNew).map(([name, quantity]) => {
        const { specBreakdown: _drop, ...rest } = quantity;
        return [name, rest];
      }),
    );
    const withBreakdown = Object.entries(quantitiesNew).filter(([, quantity]) => (quantity.specBreakdown?.length ?? 0) >= 2);
    console.log(`[r20] 清单 ${boq.totalEntries} 条目；quantities ${Object.keys(quantitiesNew).length} 项；含规格拆分条目 ${withBreakdown.length} 项`);
    for (const [name, quantity] of withBreakdown.slice(0, 12)) {
      console.log(`[r20] 拆分：${name} = ${quantity.value}${quantity.unit} → ${(quantity.specBreakdown || []).map(item => `${item.spec} ${item.value}`).join(' + ')}`);
    }
    const issuesOld = factReconciliationIssues({ markdown, billFactLock, blueprintData: { quantities: quantitiesOld } as unknown as BlueprintData });
    const issuesNew = factReconciliationIssues({ markdown, billFactLock, blueprintData: { quantities: quantitiesNew } as unknown as BlueprintData });
    const oldKeys = new Set(issuesOld.map(issue => issue.message));
    const added = issuesNew.filter(issue => !oldKeys.has(issue.message));
    const removed = issuesOld.filter(issue => !issuesNew.some(issue2 => issue2.message === issue.message));
    console.log(`[r20] 基线 issues=${issuesOld.length}；新口径 issues=${issuesNew.length}；新增=${added.length}；消失=${removed.length}`);
    for (const issue of added) console.log(`[r20] 新增 [${issue.severity}] ${issue.message}`);
    for (const issue of removed) console.log(`[r20] 消失 [${issue.severity}] ${issue.message}`);
    // 新增命中必须全部为「一般路灯」合计挂单项（零其他新增 = 真文档零误报）；消失必须为空（无误伤收敛）
    expect(added.every(issue => issue.message.includes('一般路灯')), '新增命中出现非路灯项（疑似误报，见上）').toBe(true);
    expect(removed, '旧口径既有命中被新口径吞掉（疑似误伤）').toHaveLength(0);
    expect(added.length, '路灯合计挂单项未被捕获（回归失败）').toBeGreaterThanOrEqual(3);
    expect(added.every(issue => issue.severity === 'blocker' && issue.message.includes('118'))).toBe(true);
    // 确定性修复：前进/表格形态清零，值前置形态保留
    const fixed = fixSpecQuantityBindings(markdown, { billFactLock, blueprintData: { quantities: quantitiesNew } as unknown as BlueprintData });
    console.log(`[r20] 确定性修复 fixedCount=${fixed.fixedCount}`);
    for (const detail of fixed.details) console.log(`[r20] 修复：${detail}`);
    const rescan = factReconciliationIssues({ markdown: fixed.markdown, billFactLock, blueprintData: { quantities: quantitiesNew } as unknown as BlueprintData }).filter(issue => issue.message.includes('一般路灯'));
    console.log(`[r20] 修复后残留路灯项=${rescan.length}（应为值前置形态，交 LLM 轮改述）`);
    for (const issue of rescan) console.log(`[r20] 残留 [${issue.severity}] ${issue.message}`);
    expect(fixed.fixedCount).toBeGreaterThanOrEqual(2);
    expect(rescan.every(issue => issue.message.includes('名称合计须显式分解'))).toBe(true);
    expect(rescan.length).toBe(added.length - fixed.fixedCount);
    fs.writeFileSync(
      path.join(process.cwd(), '.dbg', 'r20-lights-dryrun.json'),
      JSON.stringify({ added, removed, fixedCount: fixed.fixedCount, details: fixed.details, rescan, lightsQuantities: withBreakdown.map(([name, quantity]) => ({ name, value: quantity.value, unit: quantity.unit, specBreakdown: quantity.specBreakdown })) }, null, 1),
    );
  });
});
