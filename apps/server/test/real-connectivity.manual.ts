import { describe, it, expect } from 'vitest';
import { callDocumentLlm } from '../src/services/document-workflow/llmClient';

describe('fixed llm client', () => {
  it('returns non-empty even with small budget on reasoning model', async () => {
    const r1 = await callDocumentLlm('你是施工组织设计专家。', '用一句话说明施工组织设计的核心目标。', false, { maxTokens: 200 });
    console.log('SMALL BUDGET RESULT:', JSON.stringify(r1)?.slice(0, 150));
    expect(r1).toBeTruthy();
  }, 120_000);

  it('budget amplification yields real content', async () => {
    const r2 = await callDocumentLlm('你是施工组织设计专家。', '写一段约150字的施工准备说明，含人员、材料、机具。', false, { maxTokens: 2200 });
    console.log('AMPLIFIED RESULT len:', r2?.length, '| head:', JSON.stringify(r2)?.slice(0, 100));
    expect((r2 || '').length).toBeGreaterThan(150);
  }, 180_000);
});
