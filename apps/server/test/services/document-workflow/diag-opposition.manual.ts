/**
 * 一次性诊断（manual，不进 CI 门禁）：复现 `clarificationAmendmentIssues` 的
 * 「明确对立」误报——实测 8 条 blocker 的 `opposition` 摘录全是目录行。
 * 用法：pnpm vitest run --config vitest.manual.config.ts apps/server/test/.../diag-opposition.manual.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeEngineeringTextForFactMatch } from '@/services/document-workflow/engineeringUnits';

const DOC_ID = process.env.DIAG_DOC || 'doc-1790163579960-6bbab0c2';
const OPPOSITION_RE = /(?:不采用|不设置|不设|不需要|不需|无需|不予|不再|不做|不考虑|不进行|不涉及|取消)/u;

function loadMarkdown(): string {
  const draft = path.join(os.homedir(), '.customize-agent', 'projects', '3c3f04667c69', 'generatedDocuments', 'drafts', `${DOC_ID}.json`);
  const record = JSON.parse(fs.readFileSync(draft, 'utf8')) as { markdown?: string };
  return record.markdown || '';
}

describe('诊断：明确对立误报的「句子」到底是什么', () => {
  it('旧口径（按归一文本切句）复现误报', () => {
    const doc = normalizeEngineeringTextForFactMatch(loadMarkdown());
    const parts = doc.split(/[。；;]/u);
    console.log(`[diag·旧] 归一后长度=${doc.length} 切分块数=${parts.length}`);
    console.log(`[diag·旧] 首块长度=${parts[0]?.length} 含否定词=${OPPOSITION_RE.test(parts[0] ?? '')}`);
    console.log(`[diag·旧] 首块前 60 字（即每条 blocker 的"证据"）：${parts[0]?.slice(0, 60)}`);
    expect(parts.length).toBe(1);
  });

  it('新口径（句界取自原文 + 邻近闸）不再把整篇当成一句话', () => {
    const raw = loadMarkdown();
    const sentences = raw.split(/[。；;！？\n]+/u).map(s => s.trim()).filter(s => s.length >= 6 && s.length <= 200);
    console.log(`[diag·新] 原文切出小句数=${sentences.length}`);
    const withNegation = sentences.filter(s => OPPOSITION_RE.test(normalizeEngineeringTextForFactMatch(s)));
    console.log(`[diag·新] 含否定词的小句数=${withNegation.length}`);
    for (const s of withNegation) console.log(`[diag·新]   ${s.slice(0, 70)}`);
    // 旧口径下「含否定词」恒为真（整篇一块）；新口径下应只剩真实否定句
    expect(withNegation.length).toBeLessThan(10);
  });
});
