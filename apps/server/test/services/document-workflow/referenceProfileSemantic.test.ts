/**
 * referenceProfileSemantic 单测：语义画像补充层（embedding 段落去重 + LLM 联合批注 + 质量点评）。
 *
 * callDocumentLlmJson 被两处调用：块批注（prompt 含【块N】标记）与质量点评（prompt 含"章节结构："前缀），
 * mock 按 prompt 形态分流；embedDocuments 通过 buildSemanticProfileEnrichment 参数注入可控向量。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const llmJsonMock = vi.hoisted(() => vi.fn<(system: string, prompt: string, options?: unknown) => Promise<unknown>>());
vi.mock('@/services/document-workflow/llmClient', () => ({
  callDocumentLlmJson: llmJsonMock,
}));

import { buildSemanticProfileEnrichment } from '@/services/document-workflow/referenceProfileSemantic';

/** 批注调用：按输入块数返回全 false 批注；点评调用：返回空点评 */
function mockDefaultLlm() {
  llmJsonMock.mockImplementation(async (_system, prompt) => {
    if (prompt.includes('【块')) {
      const count = (prompt.match(/【块\d+】/gu) || []).length;
      return { blocks: Array.from({ length: count }, () => ({ fiveElementComplete: false, arrowChain: false })) };
    }
    return { highlights: [], weaknesses: [], benchmarkable: '' };
  });
}

beforeEach(() => {
  llmJsonMock.mockReset();
  mockDefaultLlm();
});

describe('buildSemanticProfileEnrichment', () => {
  it('空文本（无段落无块）→ undefined 且不触发任何 LLM 调用', async () => {
    const result = await buildSemanticProfileEnrichment('', []);
    expect(result).toBeUndefined();
    expect(llmJsonMock).not.toHaveBeenCalled();
  });

  it('段落 <8 且无 ≥30 字块：语义去重跳过、批注跳过，点评仍产出', async () => {
    const embedDocuments = vi.fn<(texts: string[]) => Promise<number[][]>>();
    const text = Array.from({ length: 7 }, (_, i) => `第${i}段内容描述现场作业要求说明。`).join('\n\n');
    const result = await buildSemanticProfileEnrichment(text, ['工程概况'], embedDocuments);
    expect(embedDocuments).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result?.semanticDuplicationRate).toBe(0);
    expect(result?.semanticSegmentCount).toBe(0);
    expect(result?.llmFiveElement).toBeUndefined();
    expect(result?.qualityNotes).toEqual({ highlights: [], weaknesses: [], benchmarkable: '' });
  });

  it('≥8 段 embedding 去重：重复对占比 = 重复对数 / 组合数', async () => {
    const dup = '本段落描述重复内容需要被语义去重识别出来';
    const unique = Array.from({ length: 6 }, (_, i) => `唯一段落内容编号为${i}用于语义去重对照。`);
    const text = [dup, dup, ...unique].join('\n');
    const embedDocuments = async (texts: string[]) => texts.map(item => {
      if (item.startsWith('本段落描述重复')) return [2, 0, 0, 0, 0, 0, 0, 0];
      // 唯一段映射到互不重叠的 one-hot 维度，两两 dot=0
      const idx = Number(item.match(/编号为(\d+)/)?.[1] ?? 0) + 1;
      return Array.from({ length: 8 }, (_, i) => (i === idx ? 1 : 0));
    });
    const result = await buildSemanticProfileEnrichment(text, [], embedDocuments);
    expect(result?.semanticSegmentCount).toBe(8);
    // 8 段两两组合 28 对，仅 1 对重复
    expect(result?.semanticDuplicationRate).toBeCloseTo(1 / 28);
  });

  it('注入向量数量与抽样段数不一致 → 语义去重降级 undefined', async () => {
    const text = Array.from({ length: 8 }, (_, i) => `第${i}段内容描述现场作业要求与验收说明。`).join('\n');
    const embedDocuments = async (texts: string[]) => texts.slice(0, 3).map(() => [1, 0]);
    const result = await buildSemanticProfileEnrichment(text, [], embedDocuments);
    expect(result?.semanticDuplicationRate).toBe(0);
    expect(result?.semanticSegmentCount).toBe(0);
  });

  it('embedding 抛错 → 独立降级，LLM 批注与点评不受影响', async () => {
    const text = '本施工段工序流程安排与资源配置明细及验收要求说明完整无遗漏。';
    const embedDocuments = async (): Promise<number[][]> => {
      throw new Error('embedding boom');
    };
    const result = await buildSemanticProfileEnrichment(text, [], embedDocuments);
    expect(result).toBeDefined();
    expect(result?.llmFiveElement).toBeDefined();
    expect(result?.qualityNotes).toBeDefined();
  });

  it('LLM 批注聚合：五要素闭合块与工序链抽样密度还原为全文口径', async () => {
    llmJsonMock.mockImplementation(async (_system, prompt) => {
      if (prompt.includes('【块')) {
        const count = (prompt.match(/【块\d+】/gu) || []).length;
        return { blocks: Array.from({ length: count }, (_, i) => ({ fiveElementComplete: i < 2, arrowChain: i === 0 })) };
      }
      return { highlights: [], weaknesses: [], benchmarkable: '' };
    });
    const text = [
      '第一施工段：本施工段工序流程安排与资源配置明细及验收要求完整。',
      '第二施工段：本施工段工序流程安排与资源配置明细及验收要求完整。',
      '第三施工段：本施工段工序流程安排与资源配置明细及验收要求完整。',
    ].join('\n\n');
    const result = await buildSemanticProfileEnrichment(text, []);
    expect(result?.llmFiveElement).toEqual({ completeBlocks: 2, sampledBlocks: 3, totalBlocks: 3 });
    expect(result?.llmArrowChain).toEqual({ chainSegments: 1, sampledSegments: 3, totalSegments: 3 });
  });

  it('批注批次失败（无 blocks 返回）→ 批注层降级，点评仍产出', async () => {
    llmJsonMock.mockImplementation(async (_system, prompt) => {
      if (prompt.includes('【块')) return undefined;
      return { highlights: ['结构清晰'], weaknesses: [], benchmarkable: '可对标' };
    });
    const text = '本施工段工序流程安排与资源配置明细及验收要求说明完整无遗漏。';
    const result = await buildSemanticProfileEnrichment(text, []);
    expect(result?.llmFiveElement).toBeUndefined();
    expect(result?.qualityNotes?.highlights).toEqual(['结构清晰']);
  });

  it('点评调用抛错 → 静默降级 undefined，不中断语义层其余环节', async () => {
    llmJsonMock.mockImplementation(async (_system, prompt) => {
      if (prompt.includes('【块')) {
        return { blocks: [{ fiveElementComplete: true, arrowChain: true }] };
      }
      throw new Error('notes boom');
    });
    const text = '本施工段工序流程安排与资源配置明细及验收要求说明完整无遗漏。';
    const result = await buildSemanticProfileEnrichment(text, []);
    expect(result).toBeDefined();
    expect(result?.llmFiveElement).toBeDefined();
    expect(result?.qualityNotes).toBeUndefined();
  });

  it('点评字段清洗：highlights 截断 5 条、非数组字段清空、非字符串归空', async () => {
    llmJsonMock.mockImplementation(async (_system, prompt) => {
      if (prompt.includes('【块')) return { blocks: [] };
      return { highlights: ['一', '二', '三', '四', '五', '六'], weaknesses: '不是数组', benchmarkable: 123 };
    });
    const text = '本施工段工序流程安排与资源配置明细及验收要求说明完整无遗漏。';
    const result = await buildSemanticProfileEnrichment(text, []);
    expect(result?.qualityNotes).toEqual({ highlights: ['一', '二', '三', '四', '五'], weaknesses: [], benchmarkable: '' });
  });

  it('超过 60 块分批标注：每批 60 块，批注调用 2 次', async () => {
    const text = Array.from({ length: 61 }, (_, i) => `第${i}段：本施工段工序流程安排与资源配置明细及验收要求说明完整。`).join('\n\n');
    await buildSemanticProfileEnrichment(text, []);
    const annotateCalls = llmJsonMock.mock.calls.filter(([, prompt]) => prompt.includes('【块'));
    expect(annotateCalls).toHaveLength(2);
    expect(llmJsonMock.mock.calls.filter(([, prompt]) => prompt.includes('章节结构：'))).toHaveLength(1);
  });

  it('全部环节失败 → 返回 undefined（不阻塞参考库可用性）', async () => {
    llmJsonMock.mockImplementation(async (_system, prompt) => {
      if (prompt.includes('【块')) return undefined;
      throw new Error('notes boom');
    });
    const embedDocuments = async (): Promise<number[][]> => {
      throw new Error('embedding boom');
    };
    const text = '本施工段工序流程安排与资源配置明细及验收要求说明完整无遗漏。';
    const result = await buildSemanticProfileEnrichment(text, [], embedDocuments);
    expect(result).toBeUndefined();
  });
});
