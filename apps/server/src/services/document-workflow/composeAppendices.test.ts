import { describe, expect, it } from 'vitest';
import { composeDocumentAppendicesMarkdown, composeDrawingIndexMarkdown, composeEnhancedCoverMarkdown, composeProcessParameterSummaryMarkdown } from './composeAppendices';

describe('composeEnhancedCoverMarkdown（标准封面）', () => {
  it('无 facts 时仅输出标题并回落工程名称', () => {
    const cover = composeEnhancedCoverMarkdown('某工程施工组织设计');
    expect(cover).toContain('# 某工程施工组织设计');
    expect(cover).toContain('| 项目 | 内容 |');
    expect(cover).toContain('| 工程名称 | 某工程施工组织设计 |');
  });

  it('完整 facts 填充封面信息表', () => {
    const facts = { '工程名称': 'A工程', '建设单位': 'B公司', '施工单位': 'C公司', '建设地点': '合肥市', '建设规模': '10000㎡', '计划工期': '540日历天', '质量标准': '合格' };
    const cover = composeEnhancedCoverMarkdown('标题', facts);
    expect(cover).toContain('| 工程名称 | A工程 |');
    expect(cover).toContain('| 建设单位 | B公司 |');
    expect(cover).toContain('| 编制单位 | C公司 |');
    expect(cover).toContain('| 建设地点 | 合肥市 |');
    expect(cover).toContain('| 计划工期 | 540日历天 |');
    expect(cover).toContain('| 质量标准 | 合格 |');
  });

  it('无施工单位时编制单位回落建设单位', () => {
    const cover = composeEnhancedCoverMarkdown('标题', { '工程名称': 'A工程', '建设单位': 'B公司' });
    expect(cover).toContain('| 编制单位 | B公司 |');
  });

  it('竖线替换与来源标注截断', () => {
    const cover = composeEnhancedCoverMarkdown('标题', { '工程名称': 'A|B工程（来源: 招标文件）' });
    expect(cover).toContain('| 工程名称 | A／B工程 |');
  });
});

describe('composeDrawingIndexMarkdown（附图与图位索引）', () => {
  it('正文引用图号生成索引', () => {
    const markdown = '## 第一章 工程概况\n本工程总平面布置参见图2-1 所示做法，详见附图。';
    const appendix = composeDrawingIndexMarkdown(markdown);
    expect(appendix).toContain('## 附录A：附图与图位索引');
    expect(appendix).toContain('| 图2-1 |');
    expect(appendix).toContain('第一章 工程概况');
  });

  it('无引用上下文（前无引用词、后无图位词）的图号跳过', () => {
    const appendix = composeDrawingIndexMarkdown('本文提到图3，但无引用上下文。');
    expect(appendix).toBe('');
  });

  it('重复图号去重', () => {
    const markdown = '参见图2-1 所示。\n另见 图2-1 大样。';
    const appendix = composeDrawingIndexMarkdown(markdown);
    expect((appendix.match(/图2-1/g) || []).length).toBe(1);
  });

  it('无图引用返回空', () => {
    expect(composeDrawingIndexMarkdown('纯文字正文。')).toBe('');
  });
});

describe('composeProcessParameterSummaryMarkdown（关键工艺参数汇总）', () => {
  it('3 条以上参数行生成汇总表', () => {
    const markdown = '## 第一章 基础工程\n桩位偏差控制在50mm以内并验收。\n搭接长度100mm，接头错开布置。\n压实度不低于95%，分层检测。';
    const appendix = composeProcessParameterSummaryMarkdown(markdown);
    expect(appendix).toContain('## 附录B：关键工艺参数汇总');
    expect(appendix).toContain('| 第一章 基础工程 | 桩位偏差控制在50mm以内并验收。 |');
  });

  it('参数行不足 3 条返回空', () => {
    const markdown = '桩位偏差控制在50mm以内并验收。';
    expect(composeProcessParameterSummaryMarkdown(markdown)).toBe('');
  });

  it('表格行与标题行跳过', () => {
    const markdown = '| 参数 | 数值 |\n| 偏差 | 50mm |\n# 大标题';
    expect(composeProcessParameterSummaryMarkdown(markdown)).toBe('');
  });

  it('目录章节参数行被排除', () => {
    const markdown = '## 目录\n桩位偏差控制在50mm以内并验收。\n搭接长度100mm，接头错开布置。';
    expect(composeProcessParameterSummaryMarkdown(markdown)).toBe('');
  });
});

describe('composeDocumentAppendicesMarkdown（附录聚合）', () => {
  it('图位索引与参数汇总组合输出', () => {
    const markdown = '## 第一章\n参见图2-1 所示。\n桩位偏差控制在50mm以内并验收。\n搭接长度100mm，接头错开布置。\n压实度不低于95%，分层检测。';
    const appendix = composeDocumentAppendicesMarkdown(markdown);
    expect(appendix).toContain('附录A：附图与图位索引');
    expect(appendix).toContain('附录B：关键工艺参数汇总');
  });

  it('无内容返回空', () => {
    expect(composeDocumentAppendicesMarkdown('普通正文。')).toBe('');
  });
});
