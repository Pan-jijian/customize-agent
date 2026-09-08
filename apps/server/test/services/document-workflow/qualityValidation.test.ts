/**
 * qualityValidation 单测：截断词表扩展 + 占位式表达。
 * 均为 L2 确定性结构检测，无需语义通道。
 */
import { describe, expect, it } from 'vitest';
import { applyDeterministicConsistencyFixesToMarkdown, collectSectionContentGaps, evaluationCriteriaCoreKeywords, formalContentIntegrityIssues, formalHeadingHierarchyIssues, formalPlaceholderIssues, processSpecConflictIssues } from '@/services/document-workflow/qualityValidation';
import type { DocumentFactsModel } from '@/services/document-workflow/types';

/** 工序规格事实卡 mock（specifications 单条，其余数组空） */
function specFactsModel(specValue: string): DocumentFactsModel {
  return {
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [],
    drawings: [], rules: [], bills: [], preciseFacts: [], schemaFacts: {}, factIndex: {},
    missing: [], conflicts: [],
    specifications: [{ key: '工艺规格', fieldName: '', value: specValue, sourceFile: '清单.xlsx', roleId: 'specification', confidence: 90 }],
    canonical: { byKey: {} },
  } as unknown as DocumentFactsModel;
}

// 语义 gate 全零向量：不触发动作词扩围/撤销，归属判定走确定性词面路径
const embedDocuments = async (texts: string[]) => texts.map(() => [0, 0]);

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

describe('evaluationCriteriaCoreKeywords（4.12.12 核心词剥离残余条款编号）', () => {
  it('「1发包人…」编号残留被剥离，核心词不含「1」', () => {
    const keywords = evaluationCriteriaCoreKeywords('1发包人委派的发包人代表或监理工程师');
    expect(keywords.some(keyword => keyword.includes('发包人'))).toBe(true);
    expect(keywords.every(keyword => !/^\d/u.test(keyword))).toBe(true);
  });

  it('多级编号「1.1 拟采用的新技术」剥离编号（编号在前时前缀保留）', () => {
    expect(evaluationCriteriaCoreKeywords('1.1拟采用的新技术、新工艺')).toEqual(['拟采用的新技术', '新工艺']);
  });

  it('无编号标题核心词不受影响', () => {
    const keywords = evaluationCriteriaCoreKeywords('确保黄山杯奖项创建目标实现');
    expect(keywords.some(keyword => keyword.includes('黄山杯'))).toBe(true);
  });
});

describe('collectLayerNumbers 层厚度物理边界（4.19.5 真实回归：面层…2000mm 误当厚度权威）', () => {
  it('资料「面层平整度偏差不大于2000mm」+ 正文「面层厚度20mm」→ 不报冲突（2000 非厚度语义不成权威）', async () => {
    const issues = await processSpecConflictIssues('地面面层厚度20mm，随打随抹平。', specFactsModel('面层平整度偏差不大于2000mm'), embedDocuments);
    expect(issues).toHaveLength(0);
  });

  it('修复侧同源：正文 20mm 不被批量替换为 2000mm', async () => {
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('地面面层厚度20mm，随打随抹平。', specFactsModel('面层平整度偏差不大于2000mm'), undefined, embedDocuments);
    expect(fixed.fixedCount).toBe(0);
    expect(fixed.markdown).toContain('20mm');
  });

  it('正常厚度（找平层 20mm vs 正文 15mm）仍报冲突并确定性替换', async () => {
    const issues = await processSpecConflictIssues('找平层厚度15mm，随浇随抹。', specFactsModel('找平层厚20mm'), embedDocuments);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('20mm');
    const fixed = await applyDeterministicConsistencyFixesToMarkdown('找平层厚度15mm，随浇随抹。', specFactsModel('找平层厚20mm'), undefined, embedDocuments);
    expect(fixed.markdown).toContain('20mm');
    expect(fixed.markdown).not.toContain('15mm');
  });

  it('边界内大厚度（垫层 800mm，<1000）仍参与一致性判定', async () => {
    const issues = await processSpecConflictIssues('混凝土垫层厚200mm。', specFactsModel('垫层厚800mm'), embedDocuments);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('800mm');
  });
});

describe('formalHeadingHierarchyIssues（P5 复选框符号残留检测）', () => {
  it('小节标题残留 ☑ 符号 → error/blocker（评分报告目录「8.2 ☑电子保函」串章回归）', () => {
    const markdown = [
      '## 目录',
      '',
      '## 第一章 工程概况',
      '### 1.1 编制依据',
      '## 第八章 其他说明',
      '### 8.1 农民工工资支付保障',
      '### 8.2 ☑电子保函',
    ].join('\n');
    const issues = formalHeadingHierarchyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('复选框') && issue.severity === 'blocker')).toBe(true);
  });

  it('✓/□/○ 等变体符号同样命中', () => {
    const markdown = ['## 第一章 工程概况', '### 1.1 编制依据', '### ✓1.2 施工部署', '### □1.3 质量保证措施'].join('\n');
    const issues = formalHeadingHierarchyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('复选框'))).toBe(true);
  });

  it('干净标题零报告', () => {
    const markdown = ['## 第一章 工程概况', '### 1.1 编制依据', '### 1.2 施工部署'].join('\n');
    expect(formalHeadingHierarchyIssues(markdown)).toEqual([]);
  });
});

describe('collectSectionContentGaps 分部章容器小节豁免（4.19.3 回归）', () => {
  it('division 章容器小节空壳被确定性删除后不报 missing_planned_section', () => {
    const markdown = ['## 第二章 主要施工方法', '### 绿化工程', '绿化工程正文'].join('\n');
    const gaps = collectSectionContentGaps(markdown, [
      { title: '主要施工方法', content: '### 绿化工程\n绿化工程正文', sections: ['绿化工程', '主要分部分项工程施工方案'] },
    ]);
    expect(gaps.some(gap => gap.reason === 'missing_planned_section' && /主要分部分项/u.test(gap.sectionTitle))).toBe(false);
  });

  it('非 division 章的容器小节缺失仍正常报 missing_planned_section', () => {
    const gaps = collectSectionContentGaps('### 1.1 编制依据\n编制依据正文', [
      { title: '工程概况', content: '### 1.1 编制依据\n编制依据正文', sections: ['项目主要施工内容'] },
    ]);
    expect(gaps.some(gap => gap.reason === 'missing_planned_section' && /项目主要施工内容/u.test(gap.sectionTitle))).toBe(true);
  });
});

describe('formalContentIntegrityIssues 列表形态豁免（B2）', () => {
  it('列表引导句行尾冒号不判截断', () => {
    const issues = formalContentIntegrityIssues('**编制依据**：招标文件与补疑补遗按以下类别列出：');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(false);
  });

  it('列表项行尾分号不判截断', () => {
    const issues = formalContentIntegrityIssues('- 招标文件及补疑补遗：招标文件、答疑纪要、补疑补遗文件；');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(false);
  });

  it('数字列表行行尾冒号不判截断', () => {
    const issues = formalContentIntegrityIssues('1. 招标文件及补疑补遗：招标文件、答疑纪要；');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(false);
  });

  it('普通段落行尾冒号且无引导词仍判截断（豁免不误伤）', () => {
    const issues = formalContentIntegrityIssues('施工现场平面布置原则：');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });

  it('普通段落以「如下」结尾无句号仍判截断', () => {
    const issues = formalContentIntegrityIssues('本工程主要施工内容如下');
    expect(issues.some(issue => /疑似截断句/u.test(issue.message))).toBe(true);
  });
});
