/** 事实冲突复算（4.55.29）：真实 draft 的 factsModel → detectFactConflicts，验证「变更叙述/缺席声明」不再误报。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { detectFactConflicts } from '@/services/document-workflow/factsModel';
import type { DocumentFactsModel } from '@/services/document-workflow/types';
import { RealLocalEmbeddingProvider } from './helpers/real-embedding';

const DRAFT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', process.env.PROJECT_ID ?? '3c3f04667c69', 'generatedDocuments', 'drafts');

describe('事实冲突复算', () => {
  it('detectFactConflicts', async () => {
    const docId = process.env.DOC_ID ?? 'doc-1790115927170-f00280f9';
    const draft = JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, `${docId}.json`), 'utf8')) as { draft: { factsModel: DocumentFactsModel } };
    const fm = draft.draft.factsModel;
    const facts = [...(fm.preciseFacts || []), ...(fm.project || []), ...(fm.schedule || []), ...(fm.quality || []), ...(fm.safety || [])];
    const embedder = new RealLocalEmbeddingProvider();
    const conflicts = await detectFactConflicts(facts, undefined, undefined, texts => embedder.embedDocuments(texts));
    const out = [`事实冲突 ${conflicts.length} 条`, ...conflicts.map((c, i) => `${i + 1}. ${c.slice(0, 220)}`)];
    fs.writeFileSync(path.resolve(process.cwd(), '.dbg', 'diag-conflicts-out.txt'), out.join('\n'), 'utf8');
  }, 600_000);
});
