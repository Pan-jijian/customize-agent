/**
 * 4.55.24 指向型表述判据（用户口径 D2：「不存在资料没给参数的情形」）。
 *
 * 实测基线（巢湖 4.55.23 终稿 doc-1790086852103-f8d8dd35）：
 * `按设计图纸` 58 处、`参见《钢筋混凝土及砖砌排水检查井》20S515/29` 4 处、
 * `详见……大样图` 3 处、OCR 错字变体 `烷2015S209` 1 处。
 *
 * 本判据与 `drawing-reference`（图纸事实引用率）不同轴：后者测"引用得够不够"，
 * 本条测"是否以指向替代具体做法"。故两者独立成判据、互不替代。
 */
import { describe, expect, it } from 'vitest';
import { drawingPointerPhraseIssues } from '@/services/document-workflow/qualityValidation';

const messagesOf = (markdown: string) => drawingPointerPhraseIssues(markdown).map(issue => issue.message);

describe('4.55.24 指向型表述判据', () => {
  it('实测形态「按设计图纸控制」→ blocker（附句样）', () => {
    const issues = drawingPointerPhraseIssues('室内外高差按设计图纸控制，基础下做100厚碎石垫层。');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].provenance?.detectorId).toBe('drawing-pointer-phrase');
    expect(issues[0].message).toContain('按设计图纸… 1 处');
    expect(issues[0].suggestion).toContain('室内外高差按设计图纸控制');
  });

  it('实测形态「参见《…》20S515/29」与 OCR 错字变体「烷2015S209」均判', () => {
    expect(messagesOf('具体做法参见《钢筋混凝土及砖砌排水检查井》20S515/29。')).toHaveLength(1);
    expect(messagesOf('单个雨水口接出管详见烷2015S209大样图。')).toHaveLength(1);
  });

  it('裸图集号指向（「雨水口按皖2015S209/93~相关专业图纸」）判', () => {
    expect(messagesOf('雨水口按皖2015S209/93~相关专业图纸施工。')).toHaveLength(1);
  });

  it('缺资料搪塞（「资料未提供该参数」「待确认」）判', () => {
    expect(messagesOf('防水层厚度资料未提供该参数。')).toHaveLength(1);
    expect(messagesOf('基础垫层厚度待确认后实施。')).toHaveLength(1);
  });

  it('编制依据语境中的规范/图集罗列不误伤（正当引用）', () => {
    expect(drawingPointerPhraseIssues('编制依据包括《钢筋混凝土及砖砌排水检查井》20S515。')).toEqual([]);
    expect(drawingPointerPhraseIssues('本工程依据《危险性较大的分部分项工程安全管理规定》住建部令第37号执行。')).toEqual([]);
  });

  it('写实的做法描述不误伤', () => {
    expect(drawingPointerPhraseIssues('基础下做100厚碎石垫层，100厚C15混凝土垫层，垫层每侧比基础宽100mm。')).toEqual([]);
    expect(drawingPointerPhraseIssues('基坑开挖深度1.7m，采用放坡开挖，坡率1:0.5。')).toEqual([]);
  });

  it('空文档零产出（纯函数幂等）', () => {
    expect(drawingPointerPhraseIssues('')).toEqual([]);
  });
});
