/**
 * h13b parameterConceptConflictIssues 单测：纯通用量词过滤 + 极端差异（>20 倍）簇跳过。
 * 语义通道 mock：验证 L1 词面过滤在聚类前生效，bge 仅负责概念聚类。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parameterConceptConflictIssues } from './parameterConceptConflicts';

vi.mock('./semanticSimilarity', () => ({ getLocalSemanticProvider: vi.fn() }));

import { getLocalSemanticProvider } from './semanticSimilarity';

const providerMock = vi.mocked(getLocalSemanticProvider);
const embedMock = vi.fn<(texts: string[]) => Promise<number[][]>>();

beforeEach(() => {
  vi.clearAllMocks();
  embedMock.mockResolvedValue([]);
  providerMock.mockReturnValue({ embedDocuments: embedMock } as never);
});

describe('parameterConceptConflictIssues（h13b 过滤）', () => {
  it('纯通用量词概念（直径/厚度）全过滤 → 不报且不调用嵌入（不同对象同量词不误聚）', async () => {
    const markdown = '直径22mm的锚杆与直径48.3mm的钢管分别验收。厚度80mm的垫层一次浇筑。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('同簇含极端差异（>20 倍）→ 簇级跳过不报（跨对象 bge 误聚豁免）', async () => {
    embedMock.mockResolvedValue([[1, 0], [1, 0]]);
    const markdown = '围挡高度2.5m。围挡高度1.8m。地下1层。地下80层。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('同簇显著差异（>2% 且 ≤20 倍）→ 正常报冲突', async () => {
    embedMock.mockResolvedValue([[1, 0], [0, 0]]);
    const markdown = '围挡高度2.5m。围挡高度1.8m。喷锚厚度80mm。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => /围挡高度/u.test(issue.message))).toBe(true);
  });
});
