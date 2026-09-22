/**
 * W5 图类要求承载检查防回归。
 * 招标要求横道图/网络图/平面布置图/机构图等，而图可能无法产出（暗标禁图/无绘图能力）；
 * 此时须由等效数据表承载同一信息。现有「图位覆盖」只查有图时的图题落位，不查这一路。
 */
import { describe, expect, it } from 'vitest';
import { figureSubstituteTableIssues } from '@/services/document-workflow/documentIntegrityChecks';

describe('figureSubstituteTableIssues', () => {
  // 4.55.12 口径收紧（巢湖实测）：裸图题不再判「已有承载」——图题是形态声明，须有数据表/框图内容
  it('图题下有内容承载（数据表）→ 无需替代（不误报）', () => {
    const md = ['## 第十章 施工总平面布置图', '', '图 10-1 施工总平面布置图', '', '| 设施 | 面积（平方米） | 位置 |', '| --- | --- | --- |', '| 钢筋加工区 | 800 | 场地东侧 |'].join('\n');
    expect(figureSubstituteTableIssues(md, [{ chapterTitle: '施工总平面布置图', name: '施工总平面布置图' }])).toHaveLength(0);
  });

  it('图题下有文字框图承载（≥8 汉字正文行）→ 无需替代', () => {
    const md = '## 第十章 施工总平面布置图\n\n图 10-1 施工总平面布置图\n\n钢筋加工区设于场地东侧，办公区设于北侧入口处，临时道路环形布置。';
    expect(figureSubstituteTableIssues(md, [{ chapterTitle: '施工总平面布置图', name: '施工总平面布置图' }])).toHaveLength(0);
  });

  it('裸图题（图题下无任何内容）→ 报无承载（原口径只认图名出现，故漏报）', () => {
    const md = '## 第十章 施工总平面布置图\n\n图 10-1 施工总平面布置图\n\n说明文字。';
    const issues = figureSubstituteTableIssues(md, [{ chapterTitle: '施工总平面布置图', name: '施工总平面布置图' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('无承载');
  });

  it('无图题但有序列表格承载 → 视为等效替代（不误报）', () => {
    const md = ['## 第八章 确保工期的技术组织措施', '', '| 施工阶段 | 起止天数 | 关键节点 |', '| --- | --- | --- |', '| 基础 | 1-30 | 验槽 |'].join('\n');
    expect(figureSubstituteTableIssues(md, [{ chapterTitle: '确保工期的技术组织措施', name: '施工进度计划横道图' }])).toHaveLength(0);
  });

  it('无图题也无等效表 → 报缺口（该要求落空）', () => {
    const md = '## 第八章 确保工期的技术组织措施\n\n本节按总工期倒排各阶段工序，确保节点兑现。';
    const issues = figureSubstituteTableIssues(md, [{ chapterTitle: '确保工期的技术组织措施', name: '施工进度计划横道图' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('图类要求无承载');
    expect(issues[0]!.message).toContain('进度计划横道图');
    expect(issues[0]!.suggestion).toContain('进度计划表');
  });

  it('无图类要求 → 不参与判定', () => {
    expect(figureSubstituteTableIssues('任意正文', [])).toHaveLength(0);
  });
});
