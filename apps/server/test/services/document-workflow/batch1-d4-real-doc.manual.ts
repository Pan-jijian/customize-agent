/**
 * D4 数值对账真实文档复测（manual：不进常规门禁）——丰乐镇修复版终稿 0 误报验证。
 * 数据源（全部真实）：
 * - 正文：记录 doc-1789282728522-56964917 的 markdown（70955 字 / wordCount 65841 口径）；
 * - 事实主表：记录 draft.factsModel；
 * - 清单事实锁 + 蓝图 quantities：由项目 kb.db 真实清单 chunks 确定性重建
 *   （parseBillOfQuantities → buildBillFactLock / deriveQuantitiesFromBoq，与生成管线同源同口径）。
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/services/document-workflow/batch1-d4-real-doc.manual.ts
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
import { factReconciliationIssues } from '@/services/document-workflow/factReconciliation';

const PROJECT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', '3c3f04667c69');
const RECORD_PATH = path.join(PROJECT_DIR, 'generatedDocuments', 'drafts', 'doc-1789282728522-56964917.json');
const KB_DB = path.join(PROJECT_DIR, 'kb.db');

/** 从 kb.db 动态解析丰乐镇清单文件相对路径（路径含不可见字符差异，硬编码易漂移） */
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

describe('D4 数值对账·丰乐镇修复版复测（0 误报）', () => {
  it('全量对账 0 误报', () => {
    if (!fs.existsSync(RECORD_PATH) || !fs.existsSync(KB_DB)) {
      console.log('[d4] 记录或 kb.db 不存在，跳过');
      return;
    }
    const record = JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8')) as {
      markdown?: string;
      editedMarkdown?: string;
      wordCount?: number;
      draft?: { factsModel?: DocumentFactsModel };
    };
    const markdown = record.editedMarkdown || record.markdown || '';
    const factsModel = record.draft?.factsModel;
    const boqFile = resolveBoqFilePath(KB_DB);
    if (!boqFile) {
      console.log('[d4] 未解析到清单文件，跳过');
      return;
    }
    const chunks = loadBoqChunksFromKb(KB_DB, boqFile);
    const boq = parseBillOfQuantities({ chunks, sourceFile: boqFile });
    const billFactLock = buildBillFactLock({ boq });
    const quantities = deriveQuantitiesFromBoq(boq);
    const blueprintData = { quantities } as unknown as BlueprintData;
    const specPairCount = (billFactLock?.entries || []).reduce((sum, entry) => sum + entry.specQuantityPairs.length, 0);
    console.log(`[d4] 清单文件=${boqFile}`);
    console.log(`[d4] chunks=${chunks.length} 首片标题=${JSON.stringify(chunks.slice(0, 3).map(chunk => chunk.sectionTitle))}`);
    console.log(`[d4] markdown ${markdown.length} 字（wordCount ${record.wordCount}）；清单 ${boq.totalEntries} 条目；lock ${billFactLock?.entries.length ?? 0} 条 / 规格对 ${specPairCount}；quantities ${Object.keys(quantities).length} 项；factsModel ${factsModel ? '有' : '无'}`);
    const issues = factReconciliationIssues({ markdown, billFactLock, blueprintData, factsModel });
    // 调试落盘：锁/聚合/列表供离线校验（.dbg 不入库）
    fs.writeFileSync(path.join(os.homedir(), 'Desktop/codeing/customize-agent/.dbg/b1-d4-lock-dump.json'), JSON.stringify({ entries: billFactLock?.entries || [], quantities, issues }, null, 1));
    console.log(`[d4] issues=${issues.length}`);
    for (const issue of issues) console.log(`[d4] [${issue.severity}] ${issue.message}`);
    expect(issues, '真实文档 D4 复测出现疑似误报（见上）').toHaveLength(0);
  });
});
