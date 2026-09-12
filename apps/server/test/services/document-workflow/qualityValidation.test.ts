/**
 * qualityValidation 单测：截断词表扩展 + 占位式表达。
 * 均为 L2 确定性结构检测，无需语义通道。
 */
import { describe, expect, it, vi } from 'vitest';
import { applyDeterministicConsistencyFixesToMarkdown, basisRegulationsCoverageIssues, boqPlacementIssues, resourceBreakdownConsistencyIssues, collectSectionContentGaps, evaluationCriteriaCoreKeywords, formalContentIntegrityIssues, formalHeadingHierarchyIssues, formalPlaceholderIssues, processSpecConflictIssues, punctuationArtifactIssues } from '@/services/document-workflow/qualityValidation';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';
import type { DocumentFactsModel } from '@/services/document-workflow/types';

// 语义兜底 stub：测试环境不加载本地嵌入模型（@huggingface/transformers 缺席），
// 返回 0 相似度使 boqPlacementIssues 的语义路径退化为「无命中」确定性行为
vi.mock('@/services/document-workflow/semanticSimilarity', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/document-workflow/semanticSimilarity')>();
  return { ...actual, buildSemanticSimilarity: async () => () => 0 };
});

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

describe('boqPlacementIssues 口径行排除（V5 P6 run1 实测）', () => {
  function tablesFactsModel(headers: string[], rows: string[][]): DocumentFactsModel {
    return {
      project: [], schedule: [], quality: [], safety: [], resources: [],
      drawings: [], rules: [], bills: [], preciseFacts: [], schemaFacts: {}, factIndex: {},
      missing: [], conflicts: [], specifications: [], canonical: { byKey: {} },
      tables: [{ headers, rows }],
    } as unknown as DocumentFactsModel;
  }

  it('分部小计/合计口径行与空残片行不计入分母（明细全落位不报）', async () => {
    const model = tablesFactsModel(['项目编码', '项目名称', '单位', '工程量'], [
      ['030901010001', '挖一般土方', 'm3', '100'],
      ['030901010002', '回填方', 'm3', '50'],
      ['', '分部小计', '', ''],
      ['', '合计', '', ''],
      ['', '', '', ''],
    ]);
    const issues = await boqPlacementIssues('本工程完成挖一般土方与回填方施工，铺装层改造同步推进。', [], model);
    expect(issues).toEqual([]);
    // 口径行未被排除时：分母 4、分部小计+合计未落位 → 2/4=50% <60% 报 error
  });

  it('真实未落位明细仍报（口径行排除不掩盖真缺陷）', async () => {
    const model = tablesFactsModel(['项目编码', '项目名称', '单位', '工程量'], [
      ['030901010001', '挖一般土方', 'm3', '100'],
      ['030901010002', '混凝土管铺设', 'm', '80'],
      ['', '分部小计', '', ''],
    ]);
    const issues = await boqPlacementIssues('本工程完成挖一般土方施工。', [], model);
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain('清单项落位不足');
    expect(issues[0]!.message).toContain('/2 项');
    expect(issues[0]!.message).toContain('混凝土管铺设');
  });
});

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

/** 编制依据小节法规/规范完整性检测：法规由写作模型自行列写，检测只兑底「具体条目存在」（十度实测缺陷） */
describe('basisRegulationsCoverageIssues 编制依据法规/规范完整性兑底', () => {
  const blueprint = (location: string, basisRegulations: string[] = []): BlueprintData => ({ project: { location }, basisRegulations } as unknown as BlueprintData);
  const section = (body: string) => `## 第一章 编制依据与说明\n${body}\n## 第二章 工程概况`;

  it('完整法规清单（法+条例+规范）→ 无 issue', () => {
    const markdown = section('依据《中华人民共和国建筑法》（主席令第91号）、《建设工程质量管理条例》（国务院令第279号）、《给水排水管道工程施工及验收规范》（GB 50268-2008）等编制。');
    expect(basisRegulationsCoverageIssues(markdown)).toEqual([]);
  });

  it('无编制依据小节 → 静默跳过（模板结构差异不误伤）', () => {
    expect(basisRegulationsCoverageIssues('## 第一章 工程概况\n本项目位于肥西县。')).toEqual([]);
  });

  it('只写类别话术（无书名号法规）→ 报缺少国家法律法规与条例', () => {
    const markdown = section('本施组编制依据国家现行法律、行政法规、地方性法规及施工验收规范。');
    const issues = basisRegulationsCoverageIssues(markdown);
    expect(issues.some(issue => issue.message.includes('国家法律法规'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('条例'))).toBe(true);
  });

  it('有法+条例但无验收规范 → 报缺少施工验收规范', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》编制。');
    const issues = basisRegulationsCoverageIssues(markdown);
    expect(issues.some(issue => issue.message.includes('验收规范'))).toBe(true);
  });

  it('规范只写编号形态（无书名号）同样通过', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》，施工质量验收执行 GB 50268-2008 等现行规范。');
    expect(basisRegulationsCoverageIssues(markdown)).toEqual([]);
  });

  it('建设地点含省/市但缺地方性法规 → 报缺少地方性法规', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）编制。');
    const issues = basisRegulationsCoverageIssues(markdown, blueprint('安徽省合肥市肥西县丰乐镇'));
    expect(issues.some(issue => issue.message.includes('地方性法规'))).toBe(true);
  });

  it('建设地点含省且列出含省名法规 → 通过', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》、《安徽省建筑市场管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）编制。');
    expect(basisRegulationsCoverageIssues(markdown, blueprint('安徽省合肥市肥西县丰乐镇'))).toEqual([]);
  });

  it('招标文件引用法规全部漏写 → 报未列招标文件引用法规', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《建设工程质量管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）编制。');
    const issues = basisRegulationsCoverageIssues(markdown, blueprint('', ['《合肥市公共资源交易管理条例》']));
    expect(issues.some(issue => issue.message.includes('招标文件引用法规'))).toBe(true);
  });

  it('招标文件引用法规部分照抄 → 不阻断（≥1 条出现）', () => {
    const markdown = section('依据《中华人民共和国建筑法》、《合肥市公共资源交易管理条例》、《给水排水管道工程施工及验收规范》（GB 50268-2008）编制。');
    const issues = basisRegulationsCoverageIssues(markdown, blueprint('', ['《合肥市公共资源交易管理条例》']));
    expect(issues).toEqual([]);
  });
});

/** 资源章数值拆分一致性兑底：工种构成/机械台数/同名多规格材料拆分与蓝图权威漂移即 error（十度实测缺陷） */
describe('resourceBreakdownConsistencyIssues 资源拆分一致性兑底', () => {
  const bp = (labor: any, equipment: any[] = [], materialsPlan: any[] = []): BlueprintData => ({ resources: { labor, equipment }, materialsPlan } as unknown as BlueprintData);

  it('工种构成与蓝图一致 → 无 issue', () => {
    const data = bp({ composition: [{ trade: '混凝土工', count: 12, basis: '' }, { trade: '钢筋工', count: 8, basis: '' }] });
    expect(resourceBreakdownConsistencyIssues('高峰期投入混凝土工12人、钢筋工8人。', data)).toEqual([]);
  });

  it('工种构成漂移 → 报不一致', () => {
    const data = bp({ composition: [{ trade: '混凝土工', count: 12, basis: '' }] });
    const issues = resourceBreakdownConsistencyIssues('高峰期投入混凝土工15人。', data);
    expect(issues.some(issue => issue.message.includes('工种构成'))).toBe(true);
  });

  it('「钢筋混凝土工」不误命「混凝土工」（前置汉字边界跳过）', () => {
    const data = bp({ composition: [{ trade: '混凝土工', count: 12, basis: '' }] });
    expect(resourceBreakdownConsistencyIssues('钢筋混凝土工班组负责主体结构。', data)).toEqual([]);
  });

  it('词表含复合工种「钢筋混凝土工」时不按子串「混凝土工」重复比对', () => {
    const data = bp({ composition: [{ trade: '钢筋混凝土工', count: 15, basis: '' }, { trade: '混凝土工', count: 12, basis: '' }] });
    expect(resourceBreakdownConsistencyIssues('高峰期投入钢筋混凝土工15人。', data)).toEqual([]);
  });

  it('机械台数与蓝图一致 → 无 issue', () => {
    const data = bp({ composition: [] }, [{ name: '挖掘机', quantity: 2, spec: '' }]);
    expect(resourceBreakdownConsistencyIssues('土方阶段配置挖掘机2台。', data)).toEqual([]);
  });

  it('机械台数漂移 → 报不一致', () => {
    const data = bp({ composition: [] }, [{ name: '挖掘机', quantity: 2, spec: '' }]);
    const issues = resourceBreakdownConsistencyIssues('土方阶段配置挖掘机3台。', data);
    expect(issues.some(issue => issue.message.includes('机械台数'))).toBe(true);
  });

  it('同名多规格机械按规格语境单独比对（不互串）', () => {
    const data = bp({ composition: [] }, [{ name: '挖掘机', quantity: 2, spec: '0.6m³' }, { name: '挖掘机', quantity: 1, spec: '1.0m³' }]);
    expect(resourceBreakdownConsistencyIssues('配置挖掘机（0.6m³）2台、挖掘机（1.0m³）1台。', data)).toEqual([]);
  });

  it('材料同名多规格拆分与蓝图一致 → 无 issue', () => {
    const data = bp({ composition: [] }, [], [{ name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '' }, { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '' }]);
    expect(resourceBreakdownConsistencyIssues('一般路灯 100W 109套 + 120W 9套。', data)).toEqual([]);
  });

  it('材料拆分数量漂移 → 报不一致（丰乐镇实测 118=111+7 分配缺陷）', () => {
    const data = bp({ composition: [] }, [], [{ name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '' }, { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '' }]);
    const issues = resourceBreakdownConsistencyIssues('一般路灯 100W 111套 + 120W 7套。', data);
    expect(issues.some(issue => issue.message.includes('材料规格拆分'))).toBe(true);
  });

  it('合计行豁免（组合计 118 套不按单规格比对）', () => {
    const data = bp({ composition: [] }, [], [{ name: '一般路灯', spec: '100W', quantity: 109, unit: '套', basis: '' }, { name: '一般路灯', spec: '120W', quantity: 9, unit: '套', basis: '' }]);
    expect(resourceBreakdownConsistencyIssues('| 合计 | 一般路灯 100W+120W | 118套 |', data)).toEqual([]);
  });

  it('无蓝图 → 静默跳过', () => {
    expect(resourceBreakdownConsistencyIssues('高峰期投入200人。')).toEqual([]);
  });
});

describe('punctuationArtifactIssues（十度：断句/残句/拼接错误确定性兑底）', () => {
  it('句读标点叠用「。；」 → error（丰乐镇实测「销项。；污水」形态）', () => {
    const issues = punctuationArtifactIssues('整改结果由项目经理复查确认后闭合。；污水管网工程阶段同时安排土方开挖。');
    expect(issues.some(issue => /句读标点叠用/u.test(issue.message))).toBe(true);
    expect(issues.every(issue => issue.level === 'error')).toBe(true);
  });

  it('连续句号「。。」 → error（省略号误写形态）', () => {
    const issues = punctuationArtifactIssues('质检员复查确认后销项。。材料员在每批材料进场后完成外观检查。');
    expect(issues.some(issue => /句读标点叠用/u.test(issue.message))).toBe(true);
  });

  it('全角括号不闭合（拼接丢失） → error', () => {
    const markdown = '国家法律法规包括《中华人民共和国建筑法》（主席令第91号公布，2019年修正）、《中华人民共和国招标投标法》（主席令第21号公布，2017安全生产法》（主席令第70号公布，2021年修正）。';
    const issues = punctuationArtifactIssues(markdown);
    expect(issues.some(issue => issue.message.includes('全角括号不闭合'))).toBe(true);
  });

  it('书名号不闭合（拼接丢失） → error（丰乐镇实测第 80 行）', () => {
    const markdown = '国家法律法规包括《中华人民共和国建筑法》（主席令第91号公布，2019年修正）、《中华人民共和国招标投标法》（主席令第21号公布，2017安全生产法》（主席令第70号公布，2021年修正）。';
    const issues = punctuationArtifactIssues(markdown);
    expect(issues.some(issue => issue.message.includes('书名号不闭合'))).toBe(true);
  });

  it('正常成稿（括号书名号成对、无标点叠用） → 零 issue', () => {
    const markdown = [
      '国家法律法规包括《中华人民共和国建筑法》（主席令第91号公布，2019年修正）、《建设工程质量管理条例》（国务院令第279号）。',
      '施工验收规范标准包括《城镇道路工程施工与质量验收规范》（CJJ 1-2008）。',
    ].join('\n');
    expect(punctuationArtifactIssues(markdown)).toEqual([]);
  });

  it('句号+右引号「。”」与省略号「……」不误报', () => {
    const markdown = '标准要求：“质量合格。”踏勘发现各自然村道路宽度普遍较窄……后续逐村复核。';
    expect(punctuationArtifactIssues(markdown)).toEqual([]);
  });

  it('表格行与标题行的标点形态不参与叠用检测（口径豁免）', () => {
    const markdown = '## 第1章 工程概况\n| 序号 | 内容 |\n| --- | --- |\n| 1 | 建设规模：道路硬化及亮化提升。； |\n';
    expect(punctuationArtifactIssues(markdown)).toEqual([]);
  });
});
