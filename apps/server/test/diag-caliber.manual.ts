/**
 * 口径终检复算（4.55.29）：用真实 draft 的 factsModel 重建真值层，对同一份正文跑口径一致性终检，
 * 逐条列出「仍报缺口」的属性——用于验证形态闸的收敛效果与残留项的真伪。
 * 输出：.dbg/diag-caliber-out.txt
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { caliberConsistencyIssues } from '@/services/document-workflow/qualityValidation';
import { buildAuthoritativeValues } from '@/services/document-workflow/authoritativeValues';
import { classifyValueShape } from '@/services/document-workflow/valueOverride';
import type { DocumentFactsModel } from '@/services/document-workflow/types';

const PROJECT_ID = process.env.PROJECT_ID ?? '3c3f04667c69';
const DRAFT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', PROJECT_ID, 'generatedDocuments', 'drafts');
const OUT: string[] = [];
const log = (line = '') => OUT.push(line);

describe('口径终检复算', () => {
  it('真值层 vs 正文', async () => {
    const docId = process.env.DOC_ID ?? 'doc-1790104980418-d47a002e';
    const draft = JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, `${docId}.json`), 'utf8')) as {
      markdown: string;
      draft: { factsModel: DocumentFactsModel };
    };
    const factsModel = draft.draft.factsModel;
    const truthFacts = [
      ...(factsModel.preciseFacts || []), ...(factsModel.project || []),
      ...(factsModel.schedule || []), ...(factsModel.quality || []), ...(factsModel.safety || []),
    ].map(fact => ({ key: fact.key, label: fact.fieldName, value: fact.value, sourceFile: fact.sourceFile }));
    const audit = buildAuthoritativeValues({ facts: truthFacts });
    log(`受管属性 ${audit.resolved.length} 项，噪声剔除 ${audit.noiseRejected.length} 项`);
    const issues = caliberConsistencyIssues(draft.markdown, audit.resolved);
    log(`口径终检：${issues.length} 条`);
    issues.forEach((issue, index) => log(`${String(index + 1).padStart(3)}. ${issue.message.slice(0, 160)}`));
    log('\n── 全部受管属性（形态标注） ──');
    audit.resolved.forEach((item, index) => {
      const shape = classifyValueShape(String(item.value));
      log(`${String(index + 1).padStart(3)}. [${shape}] ${item.attribute} = ${String(item.value).slice(0, 70)}（裁决 ${item.rule}）`);
    });
    const outPath = path.resolve(process.cwd(), '.dbg', 'diag-caliber-out.txt');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, OUT.join('\n'), 'utf8');
  }, 300_000);
});
