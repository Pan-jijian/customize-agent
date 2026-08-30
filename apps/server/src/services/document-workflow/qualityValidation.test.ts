/**
 * qualityValidation 单测：截断词表扩展 + 占位式表达。
 * 均为 L2 确定性结构检测，无需语义通道。
 */
import { describe, expect, it } from 'vitest';
import { formalContentIntegrityIssues, formalPlaceholderIssues } from './qualityValidation';

describe('formalContentIntegrityIssues 截断词表扩展（h13c）', () => {
  it('以「复查合格后」结尾且无句号 → 报截断句', () => {
    const issues = formalContentIntegrityIssues('材料进场检查发现不合格品立即隔离退场，复查合格后');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });

  it('以「设计风」结尾（行尾截断形态）→ 报截断句', () => {
    const issues = formalContentIntegrityIssues('风管严密性试验压力按系统工作压力确定，实测风量与设计风');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });

  it('完整成句（句号收尾）→ 不报截断句', () => {
    const issues = formalContentIntegrityIssues('质检员每周对库存材料进行1次状态检查，复查合格后方可投入使用。');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(false);
  });

  it('页码元信息：任何「PDF 第」形态（含空格数字完整引用）均报残留', () => {
    // 清洗链已归一完整引用并删残片，最终校验文本出现「PDF 第」即清洗缺口，不分形态全部报出
    expect(formalContentIntegrityIssues('详见招标文件PDF 第 3 页。').some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(true);
    expect(formalContentIntegrityIssues('详见招标文件PDF 第。').some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(true);
  });

  it('页码元信息：无 PDF 前缀的「第N页」引用同样报残留（第二分支）', () => {
    expect(formalContentIntegrityIssues('详见工程量清单第 5 页。').some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(true);
  });

  it('页码元信息：页码范围「第 5-8 页」报残留', () => {
    expect(formalContentIntegrityIssues('详见施工图设计文件第 5-8 页。').some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(true);
  });

  it('页码元信息：清洗后的正常引用「相关资料」不误报', () => {
    const issues = formalContentIntegrityIssues('详见招标文件、施工图设计文件、工程量清单及相关资料。');
    expect(issues.some(issue => /正文残留资料页码元信息/u.test(issue.message))).toBe(false);
  });
});

describe('formalPlaceholderIssues 占位式表达（h13c 词表扩展）', () => {
  it('「依据本项目已确认资料」占位式表达 → 报', () => {
    const issues = formalPlaceholderIssues('锚杆注浆压力依据本项目已确认资料确定。');
    expect(issues.some(issue => /占位式表达/u.test(issue.message))).toBe(true);
  });

  it('正常事实表述 → 不报', () => {
    const issues = formalPlaceholderIssues('锚杆注浆压力按0.4MPa～0.6MPa控制。');
    expect(issues.some(issue => /占位式表达/u.test(issue.message))).toBe(false);
  });
});
