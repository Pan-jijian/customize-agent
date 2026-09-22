/**
 * 参数义务满足率归因（4.55.29）：把真实 draft 的参数池逐条分类，定位「相关而遗漏」的构成。
 * 输出：.dbg/diag-param-pool-out.txt
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { buildParameterUsageAudit, classifyParameterUsage } from '@/services/document-workflow/chapterParameterFacts';
import type { DocumentFactsModel } from '@/services/document-workflow/types';

const PROJECT_ID = process.env.PROJECT_ID ?? '3c3f04667c69';
const DRAFT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', PROJECT_ID, 'generatedDocuments', 'drafts');
const OUT: string[] = [];
const log = (line = '') => OUT.push(line);

describe('参数池归因', () => {
  it('逐条列出相关而遗漏', () => {
    const docId = process.env.DOC_ID ?? 'doc-1790104980418-d47a002e';
    const draft = JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, `${docId}.json`), 'utf8')) as {
      markdown: string;
      draft: { factsModel: DocumentFactsModel };
      checkpointChapters?: Array<{ title: string; sections?: string[] }>;
      partialChapters?: Array<{ title: string; sections?: string[] }>;
    };
    const factsModel = draft.draft.factsModel;
    const chapters = (draft.checkpointChapters?.length ? draft.checkpointChapters : draft.partialChapters) || [];
    log(`章节数 ${chapters.length}：${chapters.map(c => c.title).join(' | ')}`);
    const audit = buildParameterUsageAudit({ markdown: draft.markdown, factsModel, chapters });
    log('审计：' + JSON.stringify({ total: audit?.totalParams, used: audit?.usedParams, missed: audit?.relevantMissedCount, irrelevant: audit?.irrelevantMissedCount, noise: audit?.noiseExcludedCount, rate: audit?.rate }));
    const breakdown = classifyParameterUsage(draft.markdown, factsModel, chapters);
    log(`\n=== relevantMissed 全量（${breakdown.relevantMissed.length}） ===`);
    breakdown.relevantMissed.forEach((fact, index) => {
      log(`${String(index + 1).padStart(3)}. [${fact.key}] ${String(fact.value).slice(0, 100)}`);
    });
    log(`\n=== irrelevantMissed（${breakdown.irrelevantMissed.length}） ===`);
    breakdown.irrelevantMissed.forEach((fact, index) => log(`${String(index + 1).padStart(3)}. [${fact.key}] ${String(fact.value).slice(0, 80)}`));
    log(`\n=== used 样本（前 30/${breakdown.used.length}） ===`);
    breakdown.used.slice(0, 30).forEach((fact, index) => log(`${String(index + 1).padStart(3)}. [${fact.key}] ${String(fact.value).slice(0, 80)}`));

    const outPath = path.resolve(process.cwd(), '.dbg', 'diag-param-pool-out.txt');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, OUT.join('\n'), 'utf8');
  }, 600_000);
});
