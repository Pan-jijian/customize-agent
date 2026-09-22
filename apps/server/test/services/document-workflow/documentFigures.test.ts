/**
 * 图件生成单测（4.55.18）：正文图位输出 SVG 矢量图（数据来自一体化蓝图，零编造）。
 */
import { describe, expect, it } from 'vitest';
import { buildFigureForName, buildOrgChartSvg, buildScheduleGanttSvg, buildScheduleNetworkSvg } from '@/services/document-workflow/documentFigures';
import { ensureFigurePlaceholders } from '@/services/document-workflow/constructionOrgTablePlan';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

const schedule = [
  { seq: 1, label: '施工准备与三通一平', duration: 29, startDay: 1, endDay: 29, critical: false, basis: '前导' },
  { seq: 2, label: '基础工程', duration: 76, startDay: 30, endDay: 105, critical: true, basis: '里程碑' },
  { seq: 3, label: '主体结构工程', duration: 79, startDay: 106, endDay: 184, critical: true, basis: '里程碑' },
];
const bp = { schedule } as unknown as BlueprintData;

describe('图件生成（SVG，零 LLM）', () => {
  it('横道图：含工序条、关键线路着色与总工期标注', () => {
    const svg = buildScheduleGanttSvg(schedule)!;
    expect(svg).toContain('<svg');
    expect(svg).toContain('施工进度计划横道图');
    expect(svg).toContain('基础工程');
    expect(svg).toContain('#b45309');
    expect(svg).toContain('总工期 184 天');
  });

  it('网络图：节点框 + 箭头标记，关键线路加粗', () => {
    const svg = buildScheduleNetworkSvg(schedule)!;
    expect(svg).toContain('施工进度计划网络图');
    expect(svg).toContain('marker-end');
    expect(svg).toContain('第30～105天');
  });

  it('机构图：标准岗位层级，不含任何人员实名数据', () => {
    const svg = buildOrgChartSvg();
    expect(svg).toContain('项目管理机构图');
    expect(svg).toContain('项目经理');
    expect(svg).toContain('技术负责人');
    expect(svg).toContain('土建施工班组');
    expect(svg).not.toMatch(/姓名|身份证|证书编号/u);
  });

  it('图名映射：进度/机构类出图，总平面布置图不出图（不编造几何）', () => {
    expect(buildFigureForName(bp, '施工进度计划横道图')?.fileName).toContain('.svg');
    expect(buildFigureForName(bp, '施工进度计划网络图')?.fileName).toContain('.svg');
    expect(buildFigureForName(bp, '项目管理机构图')?.fileName).toContain('.svg');
    expect(buildFigureForName(bp, '施工总平面布置图')).toBeUndefined();
  });

  it('无 schedule 数据时进度类图不出图（零编造）', () => {
    expect(buildFigureForName({} as BlueprintData, '施工进度计划横道图')).toBeUndefined();
    expect(buildScheduleGanttSvg([])).toBeUndefined();
  });
});

describe('图位注入优先出图（ensureFigurePlaceholders）', () => {
  it('提供 figureImage 时插图片引用而非替代表', () => {
    const src = ['## 第一章 主要施工方法与技术措施', '', '正文内容。'].join('\n');
    const result = ensureFigurePlaceholders(src, [{ chapterTitle: '第一章 主要施工方法与技术措施', name: '施工进度计划横道图' }], {
      figureImage: name => (name.includes('横道图') ? { fileName: 'fig-进度横道图.svg', svg: '<svg/>' } : undefined),
      substituteTable: () => ['| 工序 | 起止天序 |', '| --- | --- |', '| 基础 | 第1～30天 |'],
    });
    expect(result.markdown).toContain('![施工进度计划横道图](generatedDocuments/assets/fig-进度横道图.svg)');
    expect(result.markdown).not.toContain('| 工序 | 起止天序 |');
    expect(result.markdown.indexOf('![')).toBeLessThan(result.markdown.indexOf('图 施工进度计划横道图'));
  });

  it('既有图题旁无内容时补图（图片插在图题行之前），且幂等', () => {
    const src = ['## 第一章 主要施工方法与技术措施', '', '图1-2 施工进度计划横道图', '', '正文内容。'].join('\n');
    const specs = [{ chapterTitle: '第一章 主要施工方法与技术措施', name: '项目管理机构图' }];
    const result = ensureFigurePlaceholders(src, specs, { figureImage: name => (name.includes('横道图') ? { fileName: 'fig-进度横道图.svg', svg: '<svg/>' } : undefined) });
    expect(result.markdown).toContain('![施工进度计划横道图](generatedDocuments/assets/fig-进度横道图.svg)');
    expect(result.markdown.indexOf('![')).toBeLessThan(result.markdown.indexOf('图1-2 施工进度计划横道图'));
    const replay = ensureFigurePlaceholders(result.markdown, specs, { figureImage: name => (name.includes('横道图') ? { fileName: 'fig-进度横道图.svg', svg: '<svg/>' } : undefined) });
    // 幂等：图题邻域已有图片引用 → 不重复补（其余内容由规格注入路径决定，此处只断言图片未增行）
    expect((replay.markdown.match(/!\[施工进度计划横道图\]/gu) || []).length).toBe(1);
  });

  it('无图件回退替代表（暗标/无数据路径不变）', () => {
    const src = ['## 第一章 主要施工方法与技术措施', '', '正文内容。'].join('\n');
    const result = ensureFigurePlaceholders(src, [{ chapterTitle: '第一章 主要施工方法与技术措施', name: '施工进度计划横道图' }], {
      substituteTable: () => ['| 工序 | 起止天序 |', '| --- | --- |', '| 基础 | 第1～30天 |'],
    });
    expect(result.markdown).toContain('| 工序 | 起止天序 |');
    expect(result.markdown).not.toContain('![');
  });
});
