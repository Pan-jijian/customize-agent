/**
 * chapterPlanner 单测：fallbackStructureForSections 块目标字数分配（4.12.17）。
 * 历史缺陷：fallback 路径按 ceil(细目数/6) 预估块数把单块目标虚高到 4000（章 8333 字时），
 * 块质检 0.5×目标=2000 字卡在模型单块自然输出（1600~2000 字）上方，实测 4/6 章大面积块判失败
 * → 整章紧凑降级 → 全文字数雪崩；修复后与 LLM 规划路径同口径加权分配 + 目标驱动拆块。
 */
import { describe, expect, it, vi } from 'vitest';

const llmJsonMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
vi.mock('@/services/document-workflow/llmClient', () => ({
  callDocumentLlmJson: llmJsonMock,
  // 3.4 分层统计 helper 与生产实现同源（空段过滤后字符求和）
  contextLayerChars: (parts: Array<string | undefined | false>) => parts.filter((part): part is string => Boolean(part)).reduce((sum, part) => sum + part.length, 0),
}));

import { dedupeBlockTitleDuplicates, fallbackStructureForSections, planChapterStructure } from '@/services/document-workflow/chapterPlanner';
import type { DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';
import type { PlannedChapterStructure } from '@/services/document-workflow/chapterPlanner';

describe('fallbackStructureForSections 块目标分配（4.12.17）', () => {
  it('7 条细目 4 域、章目标 8333：块目标按块数加权分配而非全部虚高 4000', () => {
    const sections = [
      '施工安全管理体系',
      '危大工程管控措施',
      '三检制度与质量验收',
      '样板引路与实测实量',
      '进度计划与工期保障',
      '组织机构与岗位职责',
      '人员管理与劳务实名制',
    ];
    const structure = fallbackStructureForSections(sections, '测试章', 8333);
    expect(structure.blocks.length).toBeGreaterThanOrEqual(3);
    for (const block of structure.blocks) {
      // 修复前每块一律 4000（阈值 2000 卡死自然输出）；修复后按块数/点数加权，单块目标显著低于 4000
      expect(block.targetWords).toBeLessThanOrEqual(3000);
      expect(block.targetWords).toBeGreaterThanOrEqual(1200);
      // 0.4 质检阈值下，模型自然输出（≥1600 字）应能通过：0.4×目标 ≤ 1200
      expect(Math.floor(block.targetWords * 0.4)).toBeLessThanOrEqual(1200);
    }
    // 块目标总和应承接章目标量级（加权后不丢失篇幅预算）
    const total = structure.blocks.reduce((sum, block) => sum + block.targetWords, 0);
    expect(total).toBeGreaterThanOrEqual(5000);
  });

  it('3 条细目同域、章目标 8333：目标驱动拆块为 3 块，单块目标不虚高', () => {
    const sections = ['三检制度落实', '隐蔽工程验收', '质量通病防治'];
    const structure = fallbackStructureForSections(sections, '测试章', 8333);
    // 1 块装不下 8333 字（上限 4000）→ 拆成 3 块（1 点/块）
    expect(structure.blocks.length).toBe(3);
    for (const block of structure.blocks) {
      expect(block.targetWords).toBeLessThanOrEqual(3000);
      expect(block.targetWords).toBeGreaterThanOrEqual(1200);
    }
  });

  it('2 条细目 2 域、章目标 8333：无法再拆时单块目标封顶 4000，0.4 阈值 1600 放行自然输出', () => {
    const sections = ['智慧工地基本级实施', '绿色施工与扬尘控制'];
    const structure = fallbackStructureForSections(sections, '测试章', 8333);
    expect(structure.blocks.length).toBe(2);
    for (const block of structure.blocks) {
      expect(block.targetWords).toBe(4000);
      // 0.4 阈值 1600 字：模型自然输出 1600~2000 字可通过（0.5 阈值 2000 曾卡死）
      expect(Math.floor(block.targetWords * 0.4)).toBe(1600);
    }
  });
});

describe('fallbackStructureForSections 人材机三小节独立成块（h16）', () => {
  it('关键容器小节（项目主要施工内容/主要分部分项工程施工方案）独立成块（H3）且预算保底 3600', () => {
    const sections = [
      '项目主要施工内容',
      '主要分部分项工程施工方案',
      '质量通病防治',
      '施工进度安排',
    ];
    const structure = fallbackStructureForSections(sections, '测试章', 6000);
    const containerBlocks = structure.blocks.filter(block => /项目主要施工内容|主要分部分项工程施工方案/u.test(block.title));
    // 两个容器小节各自独立成块（块标题=小节标题 → H3 入目录），不被同域 bigram 合并吞并
    expect(containerBlocks).toHaveLength(2);
    for (const block of containerBlocks) {
      expect(block.subPoints).toHaveLength(1);
      expect(block.subPoints[0].title).toBe(block.title);
      // 容器块预算保底：承载 12 个骨架工作包三要素正文（每包 ≥300 字），低于 3600 会摊薄
      expect(block.targetWords).toBeGreaterThanOrEqual(3600);
    }
    // 非容器块不受保底影响
    for (const block of structure.blocks.filter(block => !/项目主要施工内容|主要分部分项工程施工方案/u.test(block.title))) {
      expect(block.targetWords).toBeLessThanOrEqual(3000);
    }
  });

  it('人/材/机保障体系三节各自独立成块（H3），不被同域 bigram 合并吞并', () => {
    const sections = [
      '确保人的保障体系与措施',
      '确保材的保障体系与措施',
      '确保机的保障体系与措施',
      '劳动力配置计划与高峰期人数安排',
    ];
    const structure = fallbackStructureForSections(sections, '确保人、材、机的保障体系与措施', 6000);
    // 三节同落「综合管理」域且 bigram 重叠 ≥0.75，修复前被合并成单块；修复后 3 个独立块 + 非标准小节块
    const triadBlocks = structure.blocks.filter(block => /^确保[人材机](?:员|力|料|械|工)?的保障体系与措施$/u.test(block.title));
    expect(triadBlocks.length).toBe(3);
    for (const block of triadBlocks) {
      expect(block.subPoints.length).toBe(1);
      expect(block.subPoints[0].title).toBe(block.title);
    }
  });

  it('非资源三小节章不受影响：同域可合并细目保持原行为', () => {
    const structure = fallbackStructureForSections(['三检制度落实', '隐蔽工程验收'], '测试章', 2400);
    expect(structure.blocks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('彻底 LLM 化：输入细目 ≤8 条也走 LLM 主题块规划（不再跳过）', () => {
  it('4 条细目：LLM 规划被调用且 llmPlanned=true（修复前直接跳过走确定性回退，块标题=细目标题 → H3/H4 同名）', async () => {
    llmJsonMock.mockResolvedValue({
      title: '质量管控措施',
      subPoints: [{ title: '三检制度落实', sources: [] }],
      facts: [],
    });
    const chapter = {
      id: 'c1',
      title: '质量管理体系与措施',
      sections: ['三检制度落实', '样板引路实施', '隐蔽工程验收', '质量通病防治'],
      requiredFacts: [],
    } as unknown as DocumentTemplateChapter;
    const structure = await planChapterStructure({
      template: { id: 't1', name: '测试模板' } as DocumentTemplate,
      chapter,
      evidence: [],
      projectContext: '测试项目',
      roleContext: '',
      targetWords: 4000,
      // 本地语义嵌入替换：全 1 聚为单块（不依赖 bge-small 模型）
      semanticEmbedder: async texts => texts.map(() => texts.map(() => 1)),
    });
    expect(llmJsonMock).toHaveBeenCalled();
    expect(structure.blocks.length).toBeGreaterThanOrEqual(1);
    expect(structure.llmPlanned).toBe(true);
  });
});

describe('dedupeBlockTitleDuplicates 块标题级去重（4.19）', () => {
  const structure = (blocks: PlannedChapterStructure['blocks']): PlannedChapterStructure => ({
    blocks,
    coveredSections: [],
    fallbackSections: [],
    llmPlanned: true,
  });

  it('同名主题块合并：后块 subPoints 去重并入前块，目标字数与 facts 合并（真实回归：第六章同名块双写）', () => {
    const input = structure([
      {
        title: '安全文明生产管理体系与措施',
        subPoints: [
          { title: '安全管理组织机构与制度', sources: ['安全管理体系'] },
          { title: '安全教育培训与持证上岗', sources: ['安全教育培训'] },
        ],
        facts: ['项目部设置专职安全员。'],
        targetWords: 1600,
      },
      {
        title: '安全文明生产管理体系与措施',
        subPoints: [
          { title: '安全教育培训与持证上岗', sources: ['安全教育培训'] },
          { title: '安全防护设施与高处作业管控', sources: ['安全防护设施'] },
        ],
        facts: ['项目部设置专职安全员。', '塔吊司机持证率 100%。'],
        targetWords: 1400,
      },
    ]);
    const result = dedupeBlockTitleDuplicates(input);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].title).toBe('安全文明生产管理体系与措施');
    // 同名 H4 去重后并入：3 个要点而非 4 个
    expect(result.blocks[0].subPoints.map(point => point.title)).toEqual(['安全管理组织机构与制度', '安全教育培训与持证上岗', '安全防护设施与高处作业管控']);
    expect(result.blocks[0].facts).toEqual(['项目部设置专职安全员。', '塔吊司机持证率 100%。']);
    expect(result.blocks[0].targetWords).toBe(3000);
  });

  it('空白差异的同名块同样合并（归一化去空白）', () => {
    const input = structure([
      { title: '周边环境与管线保护管控', subPoints: [{ title: '周边环境、管线与既有建构筑物保护', sources: ['管线保护'] }], facts: [], targetWords: 1200 },
      { title: '周边环境与管线保护管控', subPoints: [{ title: '既有道路与交通组织保护', sources: ['道路保护'] }], facts: [], targetWords: 1200 },
    ]);
    const result = dedupeBlockTitleDuplicates(input);
    expect(result.blocks.length).toBe(1);
    expect(result.blocks[0].subPoints.length).toBe(2);
    expect(result.blocks[0].targetWords).toBe(2400);
  });

  it('无同名块时原样保留（标题与顺序不变）', () => {
    const input = structure([
      { title: '安全文明生产管理体系与措施', subPoints: [{ title: '安全管理组织机构', sources: ['a'] }], facts: [], targetWords: 1200 },
      { title: '文明施工与扬尘噪声管控', subPoints: [{ title: '扬尘防治', sources: ['b'] }], facts: [], targetWords: 1200 },
    ]);
    const result = dedupeBlockTitleDuplicates(input);
    expect(result.blocks.map(block => block.title)).toEqual(['安全文明生产管理体系与措施', '文明施工与扬尘噪声管控']);
    expect(result.blocks[0].subPoints).toEqual([{ title: '安全管理组织机构', sources: ['a'] }]);
  });

  it('合并后 >3 点拆半为（一）（二）后缀块（每块 ≤3 点，facts 归前块，防目标膨胀超出模型单块输出能力）', () => {
    const input = structure([
      {
        title: '工程概况与编制边界',
        subPoints: [
          { title: '工程基本情况', sources: ['a'] },
          { title: '编制依据与范围', sources: ['b'] },
          { title: '建设规模与标段划分', sources: ['c'] },
        ],
        facts: ['总建筑面积 4646㎡。'],
        targetWords: 1600,
      },
      {
        title: '工程概况与编制边界',
        subPoints: [
          { title: '周边环境与管线情况', sources: ['d'] },
          { title: '绿色建筑二星级目标', sources: ['e'] },
        ],
        facts: [],
        targetWords: 1400,
      },
    ]);
    const result = dedupeBlockTitleDuplicates(input);
    // 5 点合并 → 拆 2 块（3+2），每块 ≤3 点
    expect(result.blocks.length).toBe(2);
    expect(result.blocks[0].title).toBe('工程概况与编制边界（一）');
    expect(result.blocks[1].title).toBe('工程概况与编制边界（二）');
    expect(result.blocks[0].subPoints.map(point => point.title)).toEqual(['工程基本情况', '编制依据与范围', '建设规模与标段划分']);
    expect(result.blocks[1].subPoints.map(point => point.title)).toEqual(['周边环境与管线情况', '绿色建筑二星级目标']);
    expect(result.blocks[0].facts).toEqual(['总建筑面积 4646㎡。']);
    expect(result.blocks[1].facts).toEqual([]);
  });

  it('空标题块跳过（不参与合并也不丢）', () => {
    const input = structure([
      { title: '  ', subPoints: [{ title: '兜底要点', sources: ['x'] }], facts: [], targetWords: 800 },
      { title: '   ', subPoints: [{ title: '兜底要点二', sources: ['y'] }], facts: [], targetWords: 800 },
    ]);
    const result = dedupeBlockTitleDuplicates(input);
    expect(result.blocks.length).toBe(2);
  });
});
