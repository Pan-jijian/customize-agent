/**
 * 4.55.29 诊断脚本（离线复算，不生成）：把服务真实产出的 draft 直接喂给评分/检测链路，
 * 逐分量定位「测量误报」与「真实缺陷」。
 *
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/diag-45529.manual.ts
 * 输出：.dbg/diag-45529-out.txt（vitest 拦截 console，结果落盘读取）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { MANDATORY_MODULE_QUERIES, COMPLIANCE_ITEM_QUERIES, splitScoringBlocks } from '@/services/document-workflow/tenderBidScoring';
import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from '@/services/document-workflow/semanticSimilarity';
import { RealLocalEmbeddingProvider } from './helpers/real-embedding';

const OUT: string[] = [];
const log = (line = '') => { OUT.push(line); };

const PROJECT_ID = process.env.PROJECT_ID ?? '3c3f04667c69';
const DRAFT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', PROJECT_ID, 'generatedDocuments', 'drafts');

interface DraftLike { markdown?: string; wordCount?: number }

function loadDraft(docId: string): DraftLike {
  return JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, `${docId}.json`), 'utf8')) as DraftLike;
}

function latestDraftIds(count: number): string[] {
  return fs.readdirSync(DRAFT_DIR)
    .filter(name => name.endsWith('.json') && !name.endsWith('.meta.json') && name.startsWith('doc-'))
    .map(name => ({ name, mtime: fs.statSync(path.join(DRAFT_DIR, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, count)
    .map(entry => entry.name.replace(/\.json$/u, ''));
}

describe('45529 诊断复算', () => {
  it('强制模块覆盖逐项定位', async () => {
    const docIds = process.env.DOC_IDS ? process.env.DOC_IDS.split(',') : latestDraftIds(1);
    const embedder = new RealLocalEmbeddingProvider();
    for (const docId of docIds) {
      const draft = loadDraft(docId);
      const markdown = draft.markdown || '';
      const blocks = splitScoringBlocks(markdown);
      log(`\n===== ${docId} 块数=${blocks.length} 字数=${markdown.length} =====`);
      const querySimilarity = await buildSemanticSimilarity(
        blocks,
        [...MANDATORY_MODULE_QUERIES, ...COMPLIANCE_ITEM_QUERIES],
        texts => embedder.embedDocuments(texts),
      );
      let hits = 0;
      for (const query of MANDATORY_MODULE_QUERIES) {
        let best = 0;
        let bestIndex = -1;
        blocks.forEach((block, index) => {
          const score = querySimilarity(block, query);
          if (score > best) { best = score; bestIndex = index; }
        });
        const hit = best >= SEMANTIC_COVERAGE_THRESHOLD;
        if (hit) hits += 1;
        log(`  [${hit ? '命中' : '缺口'}] ${query} 最高余弦=${best.toFixed(3)} 块#${bestIndex}`);
        if (!hit) log(`        最佳块：${String(blocks[bestIndex] ?? '').replace(/\s+/gu, ' ').slice(0, 200)}`);
      }
      log(`  ── 强制模块 ${hits}/${MANDATORY_MODULE_QUERIES.length} ──`);
      for (const query of COMPLIANCE_ITEM_QUERIES) {
        let best = 0;
        blocks.forEach(block => { const score = querySimilarity(block, query); if (score > best) best = score; });
        log(`  [合规 ${best >= SEMANTIC_COVERAGE_THRESHOLD ? '命中' : '缺口'}] ${query} ${best.toFixed(3)}`);
      }
    }
    const outPath = path.resolve(process.cwd(), '.dbg', 'diag-45529-out.txt');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, OUT.join('\n'), 'utf8');
  }, 600_000);
});
