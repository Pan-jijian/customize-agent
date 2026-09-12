import { describe, expect, it, vi } from 'vitest';
import {
  CONSTRUCTION_ORG_GENERIC_PHRASES,
  constructionOrgBlueprintRuleLines,
  constructionOrgBonusModuleIssues,
  constructionOrgBonusModulePrompt,
  constructionOrgChapterRulePrompt,
  constructionOrgControlLoopIssues,
  constructionOrgDivisionSectionIssues,
  constructionOrgGenericLanguageIssues,
  constructionOrgMajorContentIssues,
  constructionOrgProfessionalChainIssues,
  constructionOrgProjectTypePrompt,
  majorContentGovernanceIssues,
  perPackageContentElementIssues,
} from '@/services/document-workflow/constructionOrgQualityRules';
import type { DocumentDraftChapter, DocumentFactsModel, DocumentTemplateChapter, EvidenceFactIndex } from '@/services/document-workflow/types';

vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {}
  return { LocalTransformersEmbeddingProvider };
});

const chapter = (title: string, content: string, sections: string[] = []): DocumentDraftChapter => ({ id: title, title, content, evidence: [], missingFacts: [], sections });

/** 空话语义 gate 注入的确定性嵌入：空话词面 [1,0]（与空话原型点积 1）、具体措施词面 [0,1]、其余 [0,0] */
const embedDocuments = async (texts: string[]) => texts.map(text => {
  const generic = /精心组织|科学管理|精益求精|全力保障|高效推进|力争一流|最大限度|显著提升|大力落实|充分确保|严格把控/u.test(text);
  const concrete = /分批进场|实测实量|洒水养护|劳动力|每周|记录数据/u.test(text);
  return [generic && !concrete ? 1 : 0, concrete ? 1 : 0];
});

const templateChapter = (title: string, sections: string[] = [], queries: string[] = []): DocumentTemplateChapter => ({ id: title, title, purpose: '', queries, requiredFacts: [], sections });

function factsModel(project: DocumentFactsModel['project'] = [], preciseFacts: DocumentFactsModel['preciseFacts'] = []): DocumentFactsModel {
  const emptyIndex: EvidenceFactIndex = { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] };
  return { project, schedule: [], quality: [], safety: [], resources: [], preciseFacts, bills: [], drawings: [], rules: [], specifications: [], tables: [], schemaFacts: {}, factIndex: emptyIndex, missing: [], conflicts: [] };
}

const fact = (fieldName: string, value: string): DocumentFactsModel['project'][number] => ({ fieldId: 'f1', fieldName, key: fieldName, value, sourceFile: '招标文件.pdf', roleId: '', confidence: 1 });

describe('CONSTRUCTION_ORG_GENERIC_PHRASES（空话词表）', () => {
  it('词表非空且均为非空字符串', () => {
    expect(CONSTRUCTION_ORG_GENERIC_PHRASES.length).toBeGreaterThan(0);
    expect(CONSTRUCTION_ORG_GENERIC_PHRASES.every(phrase => phrase.length > 0)).toBe(true);
  });
});

describe('constructionOrgChapterRulePrompt（章节级专项写作规则）', () => {
  it('非施组上下文返回空', () => {
    expect(constructionOrgChapterRulePrompt(templateChapter('工程概况'))).toBe('');
  });

  it('施组章节返回基础规则并触发加分模块提示', () => {
    const prompt = constructionOrgChapterRulePrompt(templateChapter('施工组织设计总说明'));
    expect(prompt).toContain('【施工组织设计专项写作规则】');
    expect(prompt).toContain('禁止空话套话');
    expect(prompt).toContain('高分补充');
  });

  it('质量类章节注入质量闭环提示', () => {
    const prompt = constructionOrgChapterRulePrompt(templateChapter('质量管理体系'));
    expect(prompt).toContain('质量类内容必须形成');
    expect(prompt).toContain('自检—互检—交接检—整改—复查—资料归档');
  });

  it('安全类章节注入安全闭环提示', () => {
    const prompt = constructionOrgChapterRulePrompt(templateChapter('安全管理措施'));
    expect(prompt).toContain('安全类内容必须形成');
  });
});

describe('constructionOrgBlueprintRuleLines（蓝图规则行）', () => {
  it('施组章节规则行带前缀，非施组为空', () => {
    const lines = constructionOrgBlueprintRuleLines(templateChapter('施工组织设计总说明'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every(line => line.startsWith('   - '))).toBe(true);
    expect(constructionOrgBlueprintRuleLines(templateChapter('普通说明'))).toEqual([]);
  });
});

describe('constructionOrgProjectTypePrompt（专业工序链约束）', () => {
  it('市政类型触发市政工序链', () => {
    const prompt = constructionOrgProjectTypePrompt({ templateName: '市政道路工程施工组织设计', chapters: [] });
    expect(prompt).toContain('【专业工序链约束】');
    expect(prompt).toContain('市政类章节应按');
  });

  it('无专业类型返回空', () => {
    expect(constructionOrgProjectTypePrompt({ templateName: '普通文档', chapters: [] })).toBe('');
  });
});

describe('constructionOrgGenericLanguageIssues（空话套话检测，词面召回+语义复核）', () => {
  it('命中空话短语报 warning 并去重', async () => {
    const issues = await constructionOrgGenericLanguageIssues([chapter('施工部署', '本项目精心组织、精心组织、科学管理施工。')], embedDocuments);
    expect(issues.length).toBe(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('精心组织');
    expect(issues[0].message).toContain('科学管理');
  });

  it('无空话短语不报', async () => {
    expect(await constructionOrgGenericLanguageIssues([chapter('施工部署', '现场按周检查并整改。')], embedDocuments)).toHaveLength(0);
  });

  it('词面命中但语义属具体措施不计空话（负例零误杀）', async () => {
    const content = '施工前精心组织劳动力分批进场并逐人登记交底，每道工序完成后实测实量并记录数据。';
    expect(await constructionOrgGenericLanguageIssues([chapter('施工部署', content)], embedDocuments)).toHaveLength(0);
  });

  it('词面未命中直接短路（合法正文不触发语义判定）', async () => {
    expect(await constructionOrgGenericLanguageIssues([chapter('施工部署', '混凝土浇筑后每天洒水养护不少于两次并形成记录。')], embedDocuments)).toHaveLength(0);
  });
});

describe('constructionOrgControlLoopIssues（控制闭环检测）', () => {
  it('质量章缺半数以上闭环词报 warning', () => {
    const issues = constructionOrgControlLoopIssues([chapter('质量管理措施', '现场进行自检。')]);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('质量闭环');
  });

  it('闭环词齐全不报', () => {
    const content = '自检、互检、交接检、整改、复查、归档全部落实。';
    expect(constructionOrgControlLoopIssues([chapter('质量管理措施', content)])).toHaveLength(0);
  });

  it('非质量/安全类章节不检查', () => {
    expect(constructionOrgControlLoopIssues([chapter('工程概况', '概况内容。')])).toHaveLength(0);
  });
});

describe('constructionOrgProfessionalChainIssues（专业工序链校验）', () => {
  it('房建内容混入市政工序报混入警告', () => {
    const markdown = '本工程为房建工程施工组织设计。';
    const model = factsModel([fact('范围', '主体结构施工'), fact('内容', '沥青摊铺与水稳层作业')]);
    const issues = constructionOrgProfessionalChainIssues({ markdown, factsModel: model, chapters: [] });
    expect(issues.some(issue => issue.message.includes('混入不匹配工序'))).toBe(true);
  });

  it('房建工序链覆盖不足报警告', () => {
    const markdown = '本工程为房建工程施工组织设计。';
    const model = factsModel();
    const issues = constructionOrgProfessionalChainIssues({ markdown, factsModel: model, chapters: [] });
    expect(issues.some(issue => issue.message.includes('工序链覆盖不足'))).toBe(true);
  });

  it('工序链覆盖充分且无混入不报', () => {
    const markdown = '本工程为房建工程施工组织设计。';
    const model = factsModel([fact('内容', '施工准备、主体结构、竣工验收')]);
    expect(constructionOrgProfessionalChainIssues({ markdown, factsModel: model, chapters: [] })).toHaveLength(0);
  });

  it('无专业类型命中不检查', () => {
    const model = factsModel([fact('内容', '普通说明')]);
    expect(constructionOrgProfessionalChainIssues({ markdown: '普通文档。', factsModel: model, chapters: [] })).toHaveLength(0);
  });
});

describe('constructionOrgBonusModulePrompt（隐藏高分模块提示）', () => {
  it('命中加分模块返回提示', () => {
    const prompt = constructionOrgBonusModulePrompt(templateChapter('质量保证措施', ['隐蔽工程验收'], ['影像资料']));
    expect(prompt).toContain('【隐藏高分模块触发】');
    expect(prompt).toContain('影像资料留存');
  });

  it('未命中返回空', () => {
    expect(constructionOrgBonusModulePrompt(templateChapter('工程概况'))).toBe('');
  });
});

describe('constructionOrgMajorContentIssues（项目主要施工内容门禁）', () => {
  const goodPackage = (index: number, name: string, method = '采用机械开挖并组织专业班组铺设施工，逐层检测压实度，闭水试验验收合格后形成记录报告闭环。') => `#### 2.3.${index} ${name}\n施工概况：${name}范围明确，工程量1200m，材料HDPE管。\n施工流程：放线定位→沟槽开挖→管道铺设→分层回填→压实检测。\n施工方法：${method}`;
  const fiveGood = [
    goodPackage(1, '室外道排工程'), goodPackage(2, '屋面维修工程'), goodPackage(3, '外墙装饰工程'),
    goodPackage(4, '安装工程'), goodPackage(5, '土方开挖工程'),
  ].join('\n');

  it('施组文档缺主要施工内容小节报缺失 blocker', () => {
    const chapters = [chapter('施工组织设计编制说明', '本工程计划工期540日历天。')];
    const issues = constructionOrgMajorContentIssues(chapters);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('缺少');
  });

  it('完整 5 工作包无问题', () => {
    const content = `### 2.3 项目主要施工内容\n${fiveGood}`;
    expect(constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)])).toHaveLength(0);
  });

  it('工作包不足 5 个报 blocker', () => {
    const content = `### 2.3 项目主要施工内容\n${[goodPackage(1, '室外道排工程'), goodPackage(2, '屋面维修工程'), goodPackage(3, '外墙装饰工程')].join('\n')}`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('专业工程不足');
  });

  it('工作包内容要素不全报 blocker（三要素硬门槛）', () => {
    const content = `### 2.3 项目主要施工内容\n${goodPackage(1, '室外道排工程')}\n${goodPackage(2, '屋面维修工程')}\n${goodPackage(3, '外墙装饰工程')}\n${goodPackage(4, '安装工程')}\n#### 2.3.5 土方开挖工程\n施工概况：范围明确。\n施工流程：放线→开挖。`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('内容要素不全'))).toBe(true);
  });

  it('脏事实进入工作包报污染 blocker', () => {
    const content = `### 2.3 项目主要施工内容\n${goodPackage(1, '室外道排工程')}\n${goodPackage(2, '屋面维修工程')}\n${goodPackage(3, '外墙装饰工程')}\n${goodPackage(4, '安装工程')}\n#### 2.3.5 土方开挖工程\n施工概况：资料内容事实：未检索到。\n施工流程：放线→开挖。\n施工方法：采用机械开挖分层回填压实，验收合格形成记录报告闭环。`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('脏事实或标题污染'))).toBe(true);
  });

  it('施工方法过弱报 blocker', () => {
    const content = `### 2.3 项目主要施工内容\n${goodPackage(1, '室外道排工程')}\n${goodPackage(2, '屋面维修工程')}\n${goodPackage(3, '外墙装饰工程')}\n${goodPackage(4, '安装工程')}\n#### 2.3.5 土方开挖工程\n施工概况：范围明确，工程量1200m。\n施工流程：放线→开挖。\n施工方法：机械施工。`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('施工方法过弱'))).toBe(true);
  });

  it('流程段混入说明性事实报流程污染 blocker', () => {
    const content = `### 2.3 项目主要施工内容\n${goodPackage(1, '室外道排工程')}\n${goodPackage(2, '屋面维修工程')}\n${goodPackage(3, '外墙装饰工程')}\n${goodPackage(4, '安装工程')}\n#### 2.3.5 土方开挖工程\n施工概况：范围明确，工程量1200m。\n施工流程：本项目为老旧小区改造项目。\n施工方法：采用机械开挖分层回填压实，验收合格形成记录报告闭环。`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('流程污染'))).toBe(true);
  });

  it('同名专业工程重复出现报重复 blocker', () => {
    const content = `### 2.3 项目主要施工内容\n${goodPackage(1, '室外道排工程')}\n${goodPackage(2, '室外道排工程')}\n${goodPackage(3, '外墙装饰工程')}\n${goodPackage(4, '安装工程')}\n${goodPackage(5, '土方开挖工程')}`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('重复专业工程小节'))).toBe(true);
  });

  it('参数与事实细度不足报 blocker', () => {
    const barePackage = (index: number, name: string) => `#### 2.3.${index} ${name}\n施工概况：${name}范围明确。\n施工流程：放线定位→开挖→回填。\n施工方法：采用机械开挖并组织专业班组施工，逐层检测压实度，验收合格后形成记录报告闭环。`;
    const content = `### 2.3 项目主要施工内容\n${[barePackage(1, '室外道排工程'), barePackage(2, '屋面维修工程'), barePackage(3, '外墙装饰工程'), barePackage(4, '安装工程'), barePackage(5, '土方开挖工程')].join('\n')}`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('事实细度不足'))).toBe(true);
  });

  it('全表格承载正文（无实质段落文本）报 blocker', () => {
    const content = `### 2.3 项目主要施工内容\n| 分部分项工程 | 工程内容 | 单位 | 工程量 |\n| --- | --- | --- | --- |\n| 道路工程 | 沥青混凝土路面 | m² | 12000 |\n| 道路工程 | 路床碾压 | m² | 15000 |\n| 排水工程 | 钢筋混凝土管铺设 | m | 800 |`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('表格替代专业工程正文'))).toBe(true);
  });

  it('段落正文 + 数据附表（工程量汇总）不判表格承载（与 fixTableBorneContentSections 同源口径校准）', () => {
    const content = `### 2.3 项目主要施工内容\n${fiveGood}\n| 分部分项工程 | 单位 | 工程量 |\n| --- | --- | --- |\n| 道路工程 | m² | 12000 |\n| 排水工程 | m | 800 |`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('表格替代专业工程正文'))).toBe(false);
  });

  it('全部工作包无工序顺序表达报 blocker', () => {
    const noSequencePackage = (index: number, name: string) => `#### 2.3.${index} ${name}\n施工概况：${name}范围明确，工程量1200m，材料HDPE管。\n施工流程：管道铺设作业。\n施工方法：采用机械开挖并组织专业班组铺设施工，逐层检测压实度，验收合格后形成记录报告闭环。`;
    const content = `### 2.3 项目主要施工内容\n${[noSequencePackage(1, '室外道排工程'), noSequencePackage(2, '屋面维修工程'), noSequencePackage(3, '外墙装饰工程'), noSequencePackage(4, '安装工程'), noSequencePackage(5, '土方开挖工程')].join('\n')}`;
    const issues = constructionOrgMajorContentIssues([chapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('工序顺序'))).toBe(true);
  });

  it('非施组文档不检查', () => {
    expect(constructionOrgMajorContentIssues([chapter('工程概况', '本项目位于合肥市。')])).toHaveLength(0);
  });
});

describe('constructionOrgBonusModuleIssues（隐藏高分模块建议）', () => {
  it('触发加分模块但正文未覆盖报 info 建议', () => {
    const issues = constructionOrgBonusModuleIssues([chapter('质量保证措施', '隐蔽工程验收按规范执行。')]);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].level).toBe('info');
    expect(issues.some(issue => issue.message.includes('影像资料留存'))).toBe(true);
  });

  it('正文已覆盖模块标题不报', () => {
    const content = '隐蔽工程验收按规范执行，整改前后对比影像资料留存。';
    const issues = constructionOrgBonusModuleIssues([chapter('质量保证措施', content)]);
    expect(issues.some(issue => issue.message.includes('影像资料留存'))).toBe(false);
  });

  it('无模块触发不报', () => {
    expect(constructionOrgBonusModuleIssues([chapter('工程概况', '本项目位于合肥市。')])).toHaveLength(0);
  });
});

describe('constructionOrgDivisionSectionIssues（分部分项专项验收器）', () => {
  const divisionPackage = (index: number, name: string, method?: string) => `#### 分项${index} ${name}\n施工概况：${name}范围明确，作业条件具备，主要工程量800m³，采用机械配合人工组织实施。\n工艺流程：测量放线→分层开挖→边坡修整→基底验槽→钎探记录。\n施工方法：${method || '采用机械开挖分层作业，边坡坡度1:1放坡，基底标高偏差控制在50mm以内，压实度不低于93%，每层验收合格后方可进入下一层作业，全部完成后形成闭水试验记录、钎探记录与隐蔽工程验收资料归档闭环。'}`;
  const fiveDivision = [divisionPackage(1, '土方开挖'), divisionPackage(2, '基础工程'), divisionPackage(3, '主体结构'), divisionPackage(4, '防水工程'), divisionPackage(5, '装饰装修')].join('\n');

  it('无分部分项候选章不检查', () => {
    expect(constructionOrgDivisionSectionIssues([chapter('工程概况', '内容。')])).toHaveLength(0);
  });

  it('章标题无锚定词、正文 H4 形态关键小节（#### 3.1.1 主要分部分项工程施工方案）走全文兜底验证', () => {
    // 轮7 实测：planner 历史管线把关键小节规划为 H4 要点，章 sections 无锚定词 → 候选为空，
    // 验收器整条跳过导致该小节无人把关（5 个分项、缺 8 个骨架名、无任何报错）；
    // 修复后候选为空时全文兜底提取（H3/H4 双兼容），分项不足必须被拦截
    const content = `### 3.1 施工方案\n#### 3.1.1 主要分部分项工程施工方案\n${[divisionPackage(1, '土方开挖'), divisionPackage(2, '基础工程')].join('\n')}`;
    const issues = constructionOrgDivisionSectionIssues([chapter('施工方案总体部署', content)]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('分项不足'))).toBe(true);
  });

  it('H4 形态关键小节内容完整走全文兜底不误报缺失', () => {
    const content = `### 3.1 施工方案\n#### 3.1.1 主要分部分项工程施工方案\n${fiveDivision}`;
    const issues = constructionOrgDivisionSectionIssues([chapter('施工方案总体部署', content)]);
    // 兜底提取到小节内容并完成验证（5 个分项完整），不再报「小节缺失或标题结构异常」
    expect(issues.some(issue => issue.message.includes('缺失'))).toBe(false);
  });

  it('完整 5 分项无问题', () => {
    const content = `### 主要分部分项工程施工方案\n${fiveDivision}`;
    expect(constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', content)])).toHaveLength(0);
  });

  it('分项少于 3 个报分项不足 blocker', () => {
    const content = `### 主要分部分项工程施工方案\n${[divisionPackage(1, '土方开挖'), divisionPackage(2, '基础工程')].join('\n')}`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('分项不足'))).toBe(true);
  });

  it('分项 3~4 个仅报扩充建议 warning', () => {
    const content = `### 主要分部分项工程施工方案\n${[divisionPackage(1, '土方开挖'), divisionPackage(2, '基础工程'), divisionPackage(3, '主体结构')].join('\n')}`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', content)]);
    expect(issues.length).toBe(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('建议扩充');
  });

  it('分项内容要素不全报 blocker（三要素硬门槛）', () => {
    const content = `### 主要分部分项工程施工方案\n${divisionPackage(1, '土方开挖')}\n${divisionPackage(2, '基础工程')}\n${divisionPackage(3, '主体结构')}\n${divisionPackage(4, '防水工程')}\n#### 分项5 装饰装修\n施工概况：装饰范围明确。\n工艺流程：基层处理→面层施工。`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('内容要素不全'))).toBe(true);
  });

  it('脏事实/空话进入分项报 blocker', () => {
    const content = `### 主要分部分项工程施工方案\n${divisionPackage(1, '土方开挖')}\n${divisionPackage(2, '基础工程')}\n${divisionPackage(3, '主体结构')}\n${divisionPackage(4, '防水工程')}\n#### 分项5 装饰装修\n施工概况：资料内容事实：未检索到。\n工艺流程：基层处理→面层施工。\n施工方法：采用机械作业，坡度1:1放坡，基底标高偏差控制在50mm内，压实度不低于93%，验收合格后形成记录归档闭环。`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('脏事实或空话污染'))).toBe(true);
  });

  it('分项工序顺序缺失报 blocker', () => {
    const noChainPackage = (index: number, name: string) => `#### 分项${index} ${name}\n施工概况：${name}范围明确，作业条件具备，主要工程量800m³，采用机械配合人工组织实施。\n工艺流程：基层处理与面层作业。\n施工方法：采用机械作业，边坡坡度1:1放坡，基底标高偏差控制在50mm以内，压实度不低于93%，每层验收合格后方可进入下一层作业，全部完成后形成闭水试验记录、钎探记录与隐蔽工程验收资料归档闭环。`;
    const content = `### 主要分部分项工程施工方案\n${[noChainPackage(1, '土方开挖'), noChainPackage(2, '基础工程'), noChainPackage(3, '主体结构'), noChainPackage(4, '防水工程'), noChainPackage(5, '装饰装修')].join('\n')}`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('工序顺序表达'))).toBe(true);
  });

  it('分项工艺参数不足报 blocker', () => {
    const noParamPackage = (index: number, name: string) => `#### 分项${index} ${name}\n施工概况：${name}范围明确，作业条件具备，采用机械配合人工组织实施。\n工艺流程：测量放线→分层作业→基底检查→验收记录。\n施工方法：采用机械作业分层施工，每层作业完成后验收合格方可进入下一层，全部完成后形成作业记录与验收资料归档闭环。`;
    const content = `### 主要分部分项工程施工方案\n${[noParamPackage(1, '土方开挖'), noParamPackage(2, '基础工程'), noParamPackage(3, '主体结构'), noParamPackage(4, '防水工程'), noParamPackage(5, '装饰装修')].join('\n')}`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('工艺参数不足'))).toBe(true);
  });

  it('分项正文过短报 blocker', () => {
    const content = `### 主要分部分项工程施工方案\n${divisionPackage(1, '土方开挖')}\n${divisionPackage(2, '基础工程')}\n${divisionPackage(3, '主体结构')}\n${divisionPackage(4, '防水工程')}\n#### 分项5 装饰装修\n施工概况：范围明确。\n工艺流程：基层处理。\n施工方法：机械作业。`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('正文过短'))).toBe(true);
  });

  it('分项深度失衡报 warning 建议', () => {
    const longMethod = '采用机械开挖分层作业，边坡坡度1:1放坡，基底标高偏差控制在50mm以内，压实度不低于93%，每层验收合格后方可进入下一层作业，' + '每日检查记录并整改闭环，'.repeat(50) + '全部完成后形成闭水试验记录与隐蔽验收资料归档闭环。';
    const content = `### 主要分部分项工程施工方案\n${divisionPackage(1, '土方开挖')}\n${divisionPackage(2, '基础工程')}\n${divisionPackage(3, '主体结构')}\n${divisionPackage(4, '防水工程')}\n${divisionPackage(5, '装饰装修', longMethod)}`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.level === 'warning' && issue.message.includes('深度失衡'))).toBe(true);
  });

  it('候选章小节缺失报 blocker', () => {
    const issues = constructionOrgDivisionSectionIssues([chapter('主要分部分项工程施工方案', '只有概述没有分项方案。')]);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('缺失');
  });

  it('章-节两级新结构：章下 H3 小节即分项方案，不误报缺失（统一融合规划产物）', () => {
    const divisionH3 = (name: string) => `### 2.1 ${name}\n施工概况：${name}范围明确，作业条件具备，主要工程量800m³，采用机械配合人工组织实施。\n工艺流程：测量放线→分层开挖→边坡修整→基底验槽→钎探记录。\n施工方法：采用机械开挖分层作业，边坡坡度1:1放坡，基底标高偏差控制在50mm以内，压实度不低于93%，每层验收合格后方可进入下一层作业，全部完成后形成闭水试验记录与隐蔽验收资料归档闭环。`;
    const content = `## 主要施工方法\n${divisionH3('场地平整与土方回填方法')}\n${divisionH3('排水管道施工方法')}\n${divisionH3('交通信号施工方法')}\n${divisionH3('绿化种植施工方法')}\n## 下一章\n其他内容。`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要施工方法', content)]);
    // 4 个 H3 小节被识别为 4 个分项方案，不报「缺失」不报「分项不足」（阈值 blocker=3）
    expect(issues.some(issue => issue.message.includes('缺失'))).toBe(false);
    expect(issues.some(issue => issue.message.includes('分项不足'))).toBe(false);
  });

  it('章-节两级新结构：章下无 H3 子标题时报缺失 blocker（不假性通过）', () => {
    const content = `## 主要施工方法\n本章采用先进施工工艺，严格按照规范组织施工。`;
    const issues = constructionOrgDivisionSectionIssues([chapter('主要施工方法', content)]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('缺失'))).toBe(true);
  });
});

describe('perPackageContentElementIssues（G1 逐专业工程三要素判定）', () => {
  it('平铺式缺「作业对象与工程量」报 blocker 并点名缺维', () => {
    const markdown = `## 第一章 工程概况

### 1.2 项目主要施工内容

本工程雨水管网施工按“测量放线→沟槽开挖→管道安装→回填压实→闭水试验”顺序组织，采用波纹管承插连接，试验压力0.1MPa，检测合格后验收归档。
`;
    const issues = perPackageContentElementIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('作业对象与工程量');
    expect(issues[0].message).not.toContain('工序顺序');
    expect(issues[0].message).not.toContain('施工方法');
  });

  it('标签型 H4 组织缺概况时整块判定报缺维（2.14 楼地面装饰工程形态）', () => {
    const markdown = `## 第二章 主要施工方法

### 2.14 楼地面装饰工程

#### 2.14.1 施工流程
基层清理→找平→铺贴→勾缝→养护。

#### 2.14.2 施工方法
采用干硬性水泥砂浆找平，缝宽3mm，平整度偏差不超过2mm，完成后洒水养护并验收记录。
`;
    const issues = perPackageContentElementIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('作业对象与工程量');
  });

  it('专业工程型 H4 逐块判定：仅缺方法的块被点名', () => {
    const markdown = `## 第一章 工程概况

### 1.2 项目主要施工内容

#### 1.2.1 道路工程
作业对象为村内道路硬化，工程量20931.02平方米，工序按“路基处理→碎石摊铺→碾压→混凝土浇筑”顺序组织，采用振动压路机碾压，压实度检测不低于93%并形成验收记录。

#### 1.2.2 亮化工程
作业对象为村内路灯，共118套。
`;
    const issues = perPackageContentElementIssues(markdown);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('亮化工程');
    expect(issues[0].message).toContain('工序顺序');
  });

  it('三要素齐全（自然成文）不误报', () => {
    const markdown = `## 第二章 主要施工方法

### 2.7 亮化工程
本工程亮化工程覆盖20个自然村，主要工程量包括太阳能路灯118套。施工流程按“基础定位放线→基坑开挖→基础浇筑→立杆安装→调试亮灯”顺序组织，采用混凝土C20基础、螺栓预埋连接，垂直度偏差不超过杆高的0.5%，调试合格后形成验收记录。
`;
    expect(perPackageContentElementIssues(markdown)).toEqual([]);
  });

  it('非关键小节不参与判定', () => {
    const markdown = `## 第三章 质量保证措施

### 3.1 质量目标
本项目质量目标为合格。
`;
    expect(perPackageContentElementIssues(markdown)).toEqual([]);
  });
});

describe('majorContentGovernanceIssues（G2 清单口径治理）', () => {
  it('关键小节含 Markdown 表格报 blocker', () => {
    const markdown = `## 第一章 工程概况

### 1.2 项目主要施工内容

| 名称 | 单位 | 数量 |
| --- | --- | --- |
| 级配碎石 | m² | 20931.02 |
`;
    const issues = majorContentGovernanceIssues(markdown);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some(issue => issue.message.includes('表格'))).toBe(true);
  });

  it('关键小节含「分部小计」报 blocker', () => {
    const markdown = `## 第一章 工程概况

### 1.2 项目主要施工内容

道路工程分部小计 20931.02m²，其中级配碎石摊铺 18949.52m²。
`;
    const issues = majorContentGovernanceIssues(markdown);
    expect(issues.some(issue => issue.message.includes('清单内部口径词'))).toBe(true);
  });

  it('弱口径词「合计」无工程量单位不误报（合计投入 60 人）', () => {
    const markdown = `## 第一章 工程概况

### 1.2 项目主要施工内容

本工程高峰投入劳动力合计60人，作业对象与工程量、工序顺序、施工方法要素齐全。
`;
    expect(majorContentGovernanceIssues(markdown)).toEqual([]);
  });

  it('非关键小节的「合计」不受管辖', () => {
    const markdown = `## 第五章 资源保障

### 5.1 劳动力配置

现场劳动力合计投入120人，分两班作业。
`;
    expect(majorContentGovernanceIssues(markdown)).toEqual([]);
  });

  it('「措施项目」作为专业工程类别名词不误报（2.18 措施项目小节）', () => {
    const markdown = `## 第二章 主要施工方法

### 2.18 措施项目

本工程措施项目主要包括临时设施、施工降排水、脚手架搭设与安全防护等，作业对象与工程量、工序顺序、施工方法要素齐全。
`;
    expect(majorContentGovernanceIssues(markdown)).toEqual([]);
  });

  it('「措施项目费」属清单计价口径仍报 blocker', () => {
    const markdown = `## 第一章 工程概况

### 1.2 项目主要施工内容

本工程措施项目费按分部分项工程费的比例计取，措施项目清单详见报价文件。
`;
    const issues = majorContentGovernanceIssues(markdown);
    expect(issues.some(issue => issue.message.includes('清单内部口径词'))).toBe(true);
  });
});
