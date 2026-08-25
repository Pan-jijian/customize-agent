import { describe, expect, it } from 'vitest';
import { cleanInputSections, fallbackStructureForSections, plannedSectionCoverageMap, uncoveredPlannerSections } from '../src/services/document-workflow/chapterPlanner';
import type { DocumentTemplateChapter } from '../src/services/document-workflow/types';

function makeChapter(sections: string[]): DocumentTemplateChapter {
  return {
    id: 'ch-test',
    title: '第二章 施工部署',
    purpose: '',
    sections,
    queries: [],
    requiredFacts: [],
    tablePlans: [],
    pinnedEvidenceFilePaths: [],
  };
}

describe('cleanInputSections', () => {
  it('过滤占位/指令型标题、剥离编号前缀并去重', () => {
    const cleaned = cleanInputSections(makeChapter([
      '总体要求',
      '1.1 施工总体部署',
      '施工总体部署',
      '3.2 施工进度计划',
      '施工进度计划',
      '请按照提示词要求输出',
      '安全管理体系',
      '安',
    ]));
    expect(cleaned).toEqual(['施工总体部署', '施工进度计划', '安全管理体系']);
  });

  it('细目过少时保持原样（供调用方判断是否值得规划）', () => {
    const cleaned = cleanInputSections(makeChapter(['施工总体部署', '施工进度计划', '安全管理体系']));
    expect(cleaned).toEqual(['施工总体部署', '施工进度计划', '安全管理体系']);
  });
});

describe('fallbackStructureForSections', () => {
  const sections = [
    '施工进度计划',
    '工期保证措施',
    '进度纠偏措施',
    '关键节点计划',
    '工序穿插安排',
    '进度预警机制',
    '季节性施工安排',
    '质量管理体系',
    '质量验收标准',
    '三检制度',
    '样板引路制度',
    '安全管理体系',
    '危大工程管控',
    '应急预案编制',
  ];
  const structure = fallbackStructureForSections(sections, '第二章 施工部署', 20000);

  it('按语义域分组且每块不超过 6 个 H4 要点', () => {
    expect(structure.llmPlanned).toBe(false);
    // 工期进度 5 条、施工组织 2 条、质量验收 4 条、安全风险 3 条 → 4 块
    expect(structure.blocks).toHaveLength(4);
    expect(structure.blocks.every(block => block.subPoints.length >= 1 && block.subPoints.length <= 6)).toBe(true);
    expect(structure.blocks.map(block => block.title)).toEqual(['施工进度计划', '工序穿插安排', '质量管理体系', '安全管理体系']);
  });

  it('100% 覆盖所有输入细目，无遗漏', () => {
    expect([...structure.coveredSections].sort()).toEqual([...sections].sort());
    expect(uncoveredPlannerSections(sections, structure)).toEqual([]);
  });

  it('块目标字数限制在 1200~2200', () => {
    expect(structure.blocks.every(block => block.targetWords >= 1200 && block.targetWords <= 2200)).toBe(true);
  });

  it('每个输入细目都作为某块的 H4 要点被映射（sources 展开后全量覆盖）', () => {
    const mapped = structure.blocks.flatMap(block => block.subPoints.flatMap(point => point.sources));
    expect([...mapped].sort()).toEqual([...sections].sort());
  });

  it('域内高相似细目合并进同一 H4（sources 多条），目录瘦身', () => {
    const mergeable = [
      '施工进度计划',
      '施工进度计划编制',
      '隐蔽工程验收',
      '隐蔽工程验收记录',
      '质量管理体系',
    ];
    const merged = fallbackStructureForSections(mergeable, '第二章 施工部署', 12000);
    const subPointCount = merged.blocks.reduce((sum, block) => sum + block.subPoints.length, 0);
    // 「施工进度计划/施工进度计划编制」「隐蔽工程验收/隐蔽工程验收记录」两对高重叠细目各合并为一个 H4
    expect(subPointCount).toBe(3);
    expect(subPointCount).toBeLessThan(mergeable.length);
    const allSources = merged.blocks.flatMap(block => block.subPoints.flatMap(point => point.sources));
    expect([...allSources].sort()).toEqual([...mergeable].sort());
  });
});

describe('plannedSectionCoverageMap', () => {
  it('把合并后的 H4 映射回每条输入细目（Reviewer 承接校验用）', () => {
    const structure = {
      blocks: [
        {
          title: '质量管理体系与保证措施',
          subPoints: [
            { title: '质量管控闭环', sources: ['三检制度', '样板引路制度', '隐蔽工程验收'] },
            { title: '质量目标与验收标准', sources: ['质量验收标准'] },
          ],
          facts: [],
          targetWords: 1600,
        },
      ],
      coveredSections: ['三检制度', '样板引路制度', '隐蔽工程验收', '质量验收标准'],
      fallbackSections: [],
      llmPlanned: true,
    };
    const map = plannedSectionCoverageMap(['三检制度', '样板引路制度', '隐蔽工程验收', '质量验收标准'], structure);
    expect(map['三检制度']).toEqual(['质量管控闭环']);
    expect(map['样板引路制度']).toEqual(['质量管控闭环']);
    expect(map['隐蔽工程验收']).toEqual(['质量管控闭环']);
    expect(map['质量验收标准']).toEqual(['质量目标与验收标准']);
  });
});
