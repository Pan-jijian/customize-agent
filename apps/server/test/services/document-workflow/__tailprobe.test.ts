import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';
import { sentenceTailRepeatHits, sentenceTailRepeatIssues } from '@/services/document-workflow/templatingGovernance';

it('probe', () => {
  const p = join(homedir(), '.customize-agent/projects/3c3f04667c69/generatedDocuments/assets/巢湖施工组织设计-doc-1790200390338-0dcb3982.md');
  if (!existsSync(p)) { console.log('missing'); return; }
  const md = readFileSync(p, 'utf8');
  const hits = sentenceTailRepeatHits(md);
  console.log('hits:', JSON.stringify(hits.slice(0, 6).map(h => [h.tail, h.count])));
  console.log('issues:', sentenceTailRepeatIssues(md).map(i => i.level + ':' + i.message.slice(0, 60)));
});
