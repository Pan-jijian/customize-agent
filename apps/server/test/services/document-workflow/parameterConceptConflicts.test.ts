/**
 * h13b parameterConceptConflictIssues 单测：纯通用量词过滤 + 极端差异（>4 倍）簇跳过。
 * 语义通道 mock：验证 L1 词面过滤在聚类前生效，bge 仅负责概念聚类。
 * P6 追加：概念黑名单（对象计数类）/ 单位一致性（跨单位不互比）/ 倍数门 4（4~20 倍收口）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parameterConceptConflictIssues } from '@/services/document-workflow/parameterConceptConflicts';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ getLocalSemanticProvider: vi.fn() }));

import { getLocalSemanticProvider } from '@/services/document-workflow/semanticSimilarity';

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

  it('同簇含极端差异（>4 倍）→ 簇级跳过不报（跨对象 bge 误聚豁免）', async () => {
    embedMock.mockResolvedValue([[1, 0], [1, 0]]);
    const markdown = '围挡高度2.5m。围挡高度1.8m。地下1层。地下80层。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('同簇显著差异（>2% 且 ≤4 倍）→ 正常报冲突', async () => {
    embedMock.mockResolvedValue([[1, 0], [0, 0]]);
    const markdown = '围挡高度2.5m。围挡高度1.8m。喷锚厚度80mm。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => /围挡高度/u.test(issue.message))).toBe(true);
  });

  it('对象计数类概念黑名单（自然村/标段/点位等）→ 聚类前全过滤（run1 实测误报收口）', async () => {
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '本项目涉及13个自然村施工区域。招标范围为本项目分为1个标段。施工区域分布在13个自然村。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    // 全部被黑名单过滤 → 无概念可嵌入，聚类通道不被调用
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('同簇跨单位数值不互比（m/天/台）→ 不报（单位一致性防线，run1 实测误报收口）', async () => {
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '围挡高度不低于2.5m。复查频次每周不少于2天。水泵配置不少于3台。';
    const issues = await parameterConceptConflictIssues(markdown);
    // 簇级 3/2=1.5 倍 < 4 不跳；单位分组后 m{2.5}/天{2}/台{3} 均为单值 → 不报
    expect(issues).toEqual([]);
  });

  it('同簇 4~20 倍差异（跨对象误聚簇）→ 簇级倍数门4 跳过（run1 实测误报收口）', async () => {
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '电缆保护管敷设68993.93m。电力电缆敷设14249.23m。综合管线敷设总量58250m。';
    const issues = await parameterConceptConflictIssues(markdown);
    // 68993.93/14249.23≈4.84 倍：旧 >20 倍门不拦（run1 生产误报现场），倍数门4 整簇跳过
    expect(issues).toEqual([]);
  });
});
