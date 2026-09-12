/**
 * t2-cq YY 组：constructionOrgQualityRules 全函数族边界枚举。
 * 覆盖：constructionOrgChapterRulePrompt / constructionOrgBlueprintRuleLines（Y1）、
 * constructionOrgProjectTypePrompt（Y2）、constructionOrgGenericLanguageIssues（Y3，语义 gate mock）、
 * constructionOrgControlLoopIssues（Y4）、constructionOrgProfessionalChainIssues（Y5）、
 * constructionOrgBonusModulePrompt / constructionOrgBonusModuleIssues（Y6）、
 * constructionOrgMajorContentIssues（Y7）、constructionOrgDivisionSectionIssues（Y8）、
 * perPackageContentElementIssues（Y9）、majorContentGovernanceIssues（Y10）、
 * CONSTRUCTION_ORG_GENERIC_PHRASES 词表（Y11）。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
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
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, DocumentTemplateChapter } from '@/services/document-workflow/types';

const tplChapter = (title: string, sections: string[] = [], queries: string[] = []): DocumentTemplateChapter => ({
  id: 't1', title, purpose: '', queries, requiredFacts: [], sections,
});
const draftChapter = (title: string, content: string): DocumentDraftChapter => ({
  id: 'd1', title, content, evidence: [], missingFacts: [],
});

// ═══════ Y1 章级提示词 ═══════
describe('Y1 constructionOrgChapterRulePrompt / BlueprintRuleLines', () => {
  it('标题含「施工组织设计」→ 生成专项提示词', () => {
    const prompt = constructionOrgChapterRulePrompt(tplChapter('施工组织设计'));
    expect(prompt).toContain('【施工组织设计专项写作规则】');
    expect(prompt).toContain('禁止空话套话');
  });

  it('非施工组织语境（工程概况）→ 空串', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('工程概况'))).toBe('');
  });

  it.each(['施工方案', '技术标', '施工组织', '文明施工', '质量目标', '安全管理'])('语境词 %s → 非空', (title) => {
    expect(constructionOrgChapterRulePrompt(tplChapter(title))).not.toBe('');
  });

  it('纯语境词「施工方案」无闭环无加分 → 仅头部+两条基础规则', () => {
    const lines = constructionOrgChapterRulePrompt(tplChapter('施工方案')).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('【施工组织设计专项写作规则】');
    expect(lines[2]).toContain('每项措施至少包含');
  });

  it('质量语境 → 注入质量闭环提示词', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('质量管理'))).toContain('自检—互检—交接检');
  });

  it('安全语境 → 注入安全闭环提示词', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('安全管理'))).toContain('风险辨识—专项交底');
  });

  it('进度语境 → 注入进度闭环提示词', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('施工组织设计', ['施工进度计划']))).toContain('计划分解—日/周检查');
  });

  it('文明语境 → 注入环保闭环提示词', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('文明施工'))).toContain('监测—预警—联动处置');
  });

  it('劳务语境 → 注入工资闭环提示词', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('施工组织设计', ['劳务实名制']))).toContain('实名登记—考勤');
  });

  it('应急语境 → 注入应急闭环提示词', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('施工组织设计', ['应急预案']))).toContain('发现险情—警戒疏散');
  });

  it('sections 参与语境判定（标题无语境词、sections 命中）', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('保障措施', ['安全文明']))).not.toBe('');
  });

  it('技术标 → 加分模块：招标评分项响应索引（bonus 行注入 prompt 文本）', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('技术标编制'))).toContain('招标评分项响应索引');
  });

  it('工程量语境 → 加分模块：主要工程量表格化', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('施工组织设计（工程量清单）'))).toContain('主要工程量表格化');
  });

  it('隐蔽语境 → 加分模块：影像资料', () => {
    expect(constructionOrgChapterRulePrompt(tplChapter('施工方案', ['隐蔽工程验收']))).toContain('影像资料');
  });

  it('blueprintRuleLines：空提示词 → 空数组', () => {
    expect(constructionOrgBlueprintRuleLines(tplChapter('工程概况'))).toEqual([]);
  });

  it('blueprintRuleLines：每行加「   - 」前缀且行数一致', () => {
    const prompt = constructionOrgChapterRulePrompt(tplChapter('安全管理'));
    const lines = constructionOrgBlueprintRuleLines(tplChapter('安全管理'));
    expect(lines).toHaveLength(prompt.split('\n').length);
    expect(lines[0]).toBe(`   - ${prompt.split('\n')[0]}`);
    expect(lines.every(line => line.startsWith('   - '))).toBe(true);
  });
});

// ═══════ Y2 项目类型提示词 ═══════
describe('Y2 constructionOrgProjectTypePrompt', () => {
  it('市政模板名 → 市政工序链约束', () => {
    const prompt = constructionOrgProjectTypePrompt({ templateName: '市政道路工程', chapters: [] });
    expect(prompt).toContain('【专业工序链约束】');
    expect(prompt).toContain('测量放线—管线探测');
  });

  it('老旧小区改造 → 改造工序链约束', () => {
    const prompt = constructionOrgProjectTypePrompt({ templateName: '老旧小区改造项目', chapters: [] });
    expect(prompt).toContain('居民沟通');
  });

  it('装饰+房建双类型 → 两条约束', () => {
    const prompt = constructionOrgProjectTypePrompt({ templateName: '办公楼装饰装修', chapters: [] });
    expect(prompt).toContain('基层处理—防水闭水');
    expect(prompt).toContain('房建类章节');
    expect(prompt.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2);
  });

  it('住宅 → 房建约束', () => {
    expect(constructionOrgProjectTypePrompt({ templateName: '住宅小区', chapters: [] })).toContain('施工准备—基础—主体');
  });

  it('无类型词 → 空串（general 被过滤）', () => {
    expect(constructionOrgProjectTypePrompt({ templateName: '通用工程', chapters: [] })).toBe('');
  });

  it('outputTitle 参与推断', () => {
    expect(constructionOrgProjectTypePrompt({ templateName: 'X项目', outputTitle: '雨污管网工程', chapters: [] })).toContain('市政类章节');
  });

  it('requirement 参与推断（小区改造）', () => {
    expect(constructionOrgProjectTypePrompt({ templateName: 'X项目', requirement: '小区改造', chapters: [] })).toContain('老旧小区改造类章节');
  });

  it('章节标题参与推断（吊顶 → 装饰）', () => {
    expect(constructionOrgProjectTypePrompt({ templateName: 'X项目', chapters: [tplChapter('吊顶工程')] })).toContain('装饰装修类章节');
  });

  it('多类型（道路+装饰）→ 两条约束行', () => {
    const prompt = constructionOrgProjectTypePrompt({ templateName: '道路装饰工程', chapters: [] });
    expect(prompt.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2);
  });

  it('空模板名 → 空串', () => {
    expect(constructionOrgProjectTypePrompt({ templateName: '', chapters: [] })).toBe('');
  });
});

// ═══════ Y3 空话语义 gate（mock 嵌入） ═══════
describe('Y3 constructionOrgGenericLanguageIssues', () => {
  // mock 嵌入：正例原型→[1,0]，负例原型/具体措施句→[0,1]，其余→[1,0]
  //（原型嵌入调用一次：5 正例+3 负例；候选嵌入调用一次）
  const embedMock = async (texts: string[]) => texts.map(text => (/劳动力分批进场|实测实量|洒水养护/u.test(text) ? [0, 1] : [1, 0]));

  it('空章节数组 → 无 issue', async () => {
    expect(await constructionOrgGenericLanguageIssues([], embedMock)).toEqual([]);
  });

  it('正文无空话词面 → 词面召回短路，无 issue', async () => {
    const issues = await constructionOrgGenericLanguageIssues([draftChapter('施工组织设计', '每道工序按标准执行，责任落实到岗，检查记录齐全。')], embedMock);
    expect(issues).toEqual([]);
  });

  it('含「精心组织」句且语义命中 → warning（词面+语义双确认）', async () => {
    const issues = await constructionOrgGenericLanguageIssues([draftChapter('施工组织设计', '我们精心组织施工确保项目顺利推进。')], embedMock);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('精心组织');
    expect(issues[0].message).toContain('空泛套话');
  });

  it('具体措施负例保护：「精心组织劳动力分批进场」不误报', async () => {
    const issues = await constructionOrgGenericLanguageIssues([draftChapter('施工组织设计', '项目部精心组织劳动力分批进场并登记交底，有序展开作业。')], embedMock);
    expect(issues).toEqual([]);
  });

  it('短句过滤：不足 8 字的句子不进入判定', async () => {
    const issues = await constructionOrgGenericLanguageIssues([draftChapter('施工组织设计', '精心组织。')], embedMock);
    expect(issues).toEqual([]);
  });

  it('句子边界按 [。；;\\n] 切分', async () => {
    const issues = await constructionOrgGenericLanguageIssues([draftChapter('施工组织设计', '前置说明句。我们精心组织施工确保推进；再接再厉。')], embedMock);
    expect(issues).toHaveLength(1);
  });

  it('多个空话词命中 → message 列出多个词', async () => {
    const issues = await constructionOrgGenericLanguageIssues([draftChapter('施工组织设计', '我们精心组织科学管理确保工程保质保量推进。')], embedMock);
    expect(issues[0].message).toContain('精心组织');
    expect(issues[0].message).toContain('科学管理');
  });

  it('多章各自报 issue', async () => {
    const issues = await constructionOrgGenericLanguageIssues([
      draftChapter('施工组织设计', '我们精心组织施工确保项目顺利推进。'),
      draftChapter('质量管理', '项目部科学管理各项质量指标。'),
    ], embedMock);
    expect(issues).toHaveLength(2);
  });

  it('suggestion 指向「责任岗位+执行动作」重写', async () => {
    const issues = await constructionOrgGenericLanguageIssues([draftChapter('施工组织设计', '我们精心组织施工确保项目顺利推进。')], embedMock);
    expect(issues[0].suggestion).toContain('责任岗位');
  });

  it('空 content → 无 issue', async () => {
    expect(await constructionOrgGenericLanguageIssues([draftChapter('施工组织设计', '')], embedMock)).toEqual([]);
  });
});

// ═══════ Y4 闭环缺失检测 ═══════
describe('Y4 constructionOrgControlLoopIssues', () => {
  it('质量闭环全词齐 → 无 issue', () => {
    const content = '已完成自检、互检、交接检，发现问题立即整改，复查合格后资料归档。';
    expect(constructionOrgControlLoopIssues([draftChapter('质量管理', content)])).toEqual([]);
  });

  it('质量闭环缺 6 词 → warning', () => {
    const issues = constructionOrgControlLoopIssues([draftChapter('质量管理', '正文')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('质量闭环');
    expect(issues[0].level).toBe('warning');
  });

  it('质量闭环恰好缺 3 词 → 报（ceil(6/2)=3 边界）', () => {
    const issues = constructionOrgControlLoopIssues([draftChapter('质量管理', '已完成自检互检交接检。')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('整改');
    expect(issues[0].message).toContain('复查');
    expect(issues[0].message).toContain('归档');
  });

  it('质量闭环缺 2 词 → 不报（<ceil(6/2)）', () => {
    expect(constructionOrgControlLoopIssues([draftChapter('质量管理', '自检互检交接检完成，问题整改后归档。')])).toEqual([]);
  });

  it('安全闭环缺 6 词 → warning（含提示词）', () => {
    const issues = constructionOrgControlLoopIssues([draftChapter('安全管理', '正文')]);
    expect(issues[0].message).toContain('安全闭环');
    expect(issues[0].suggestion).toContain('风险辨识');
  });

  it('进度闭环缺 3 词 → 报（5 词 ceil=3）', () => {
    const issues = constructionOrgControlLoopIssues([draftChapter('进度管理', '已制定进度计划。')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('进度闭环');
  });

  it('进度闭环缺 2 词 → 不报（5 词 ceil=3）', () => {
    expect(constructionOrgControlLoopIssues([draftChapter('进度管理', '按计划定期检查进度，发现滞后及时纠偏。')])).toEqual([]);
  });

  it('环保闭环缺 2 词 → 报（4 词 ceil=2）', () => {
    const issues = constructionOrgControlLoopIssues([draftChapter('文明施工', '扬尘已开展在线监测。')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('环保闭环');
  });

  it('环保闭环缺 1 词 → 不报', () => {
    expect(constructionOrgControlLoopIssues([draftChapter('文明施工', '扬尘监测预警联动处置及时。')])).toEqual([]);
  });

  it('工资闭环缺 6 词 → warning', () => {
    expect(constructionOrgControlLoopIssues([draftChapter('劳务管理', '正文')])[0].message).toContain('工资闭环');
  });

  it('应急闭环缺词 → warning', () => {
    const issues = constructionOrgControlLoopIssues([draftChapter('应急管理', '发现险情后立即警戒处置。')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('应急闭环');
  });

  it('标题不匹配任何闭环 pattern → 不检查', () => {
    expect(constructionOrgControlLoopIssues([draftChapter('工程概况', '')])).toEqual([]);
  });

  it('sections 参与 pattern 判定（安全+文明双规则同命中）', () => {
    const chapter = { ...draftChapter('保障措施', ''), sections: ['安全文明'] };
    const issues = constructionOrgControlLoopIssues([chapter]);
    expect(issues).toHaveLength(2);
    expect(issues.some(issue => issue.message.includes('安全闭环'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('环保闭环'))).toBe(true);
  });

  it('多规则同章（质量+安全）→ 两条 warning', () => {
    expect(constructionOrgControlLoopIssues([draftChapter('质量安全管理', '')])).toHaveLength(2);
  });

  it('content 含 token 检查用 includes（缺 3 词报出缺失清单）', () => {
    const issues = constructionOrgControlLoopIssues([draftChapter('质量管理', '执行自检互检，问题整改。')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('交接检');
    expect(issues[0].message).toContain('复查');
    expect(issues[0].message).toContain('归档');
  });
});

// ═══════ Y5 专业工序链 ═══════
describe('Y5 constructionOrgProfessionalChainIssues', () => {
  const makeFact = (value: string): DocumentFact => ({ key: 'k', value, sourceFile: 'f', roleId: 'r', confidence: 1 });
  const makeFactsModel = (project: string[] = [], precise: string[] = []): DocumentFactsModel => ({
    project: project.map(makeFact), schedule: [], quality: [], safety: [], resources: [],
    tables: [], drawings: [], bills: [], preciseFacts: precise.map(makeFact), rules: [],
    specifications: [], schemaFacts: {}, factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] }, missing: [], conflicts: [],
  });

  it('全空输入 → 无 issue', () => {
    expect(constructionOrgProfessionalChainIssues({ markdown: '', factsModel: makeFactsModel(), chapters: [] })).toEqual([]);
  });

  it('房建 label 命中但链词 0 → 覆盖不足 warning', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '本工程为房建工程。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('房建工程工序链覆盖不足');
  });

  it('房建链 3 词命中 → 无覆盖不足', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '房建工程：施工准备、土方/基础、主体结构。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues).toEqual([]);
  });

  it('链词 ≥3 即使无 label 也触发检查', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '施工准备、土方/基础、主体结构。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues).toEqual([]);
  });

  it('房建 label + 2 个禁配词 → 疑似混入 warning', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '房建工程涉及管道闭水试验和沥青摊铺。', factsModel: makeFactsModel(), chapters: [] });
    const mixed = issues.find(issue => issue.message.includes('混入'));
    expect(mixed).toBeTruthy();
    expect(mixed?.message).toContain('管道闭水试验');
    expect(mixed?.message).toContain('沥青摊铺');
  });

  it('房建 1 个禁配词 → 不报混入、只报覆盖不足', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '房建工程涉及管道闭水试验。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('覆盖不足');
  });

  it('市政 label + 房建工序词 → 混入 warning', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '市政工程包含主体结构和二次结构施工。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues.some(issue => issue.message.includes('混入'))).toBe(true);
  });

  it('改造 label + 深基坑/高支模 → 混入 warning', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '老旧小区改造涉及大面积深基坑和高支模。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues.some(issue => issue.message.includes('混入'))).toBe(true);
  });

  it('装饰 label + 深基坑/路基压实 → 混入 warning', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '装饰装修工程涉及深基坑和路基压实。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues.some(issue => issue.message.includes('混入'))).toBe(true);
  });

  it('装饰链 3 词命中 → 无 issue', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '装饰装修工程：基层处理、防水闭水、吊顶龙骨。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues).toEqual([]);
  });

  it('factsModel.project 值参与上下文', () => {
    const issues = constructionOrgProfessionalChainIssues({
      markdown: '房建工程。', factsModel: makeFactsModel(['施工准备 土方/基础 主体结构']), chapters: [],
    });
    expect(issues).toEqual([]);
  });

  it('label 未命中且链词 2 → 跳过检查', () => {
    expect(constructionOrgProfessionalChainIssues({ markdown: '施工准备、土方/基础。', factsModel: makeFactsModel(), chapters: [] })).toEqual([]);
  });

  it('链词 2 但 label 命中 → 覆盖不足', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '房建工程：施工准备、土方/基础。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues.some(issue => issue.message.includes('覆盖不足'))).toBe(true);
  });

  it('混入与覆盖不足可同时报', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '房建工程涉及管道闭水试验和沥青摊铺。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues).toHaveLength(2);
  });

  it('禁配词 2 + 链词 3 → 只报混入', () => {
    const issues = constructionOrgProfessionalChainIssues({
      markdown: '房建工程：施工准备、土方/基础、主体结构，涉及管道闭水试验和沥青摊铺。',
      factsModel: makeFactsModel(), chapters: [],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('混入');
  });

  it('normalize 去空白：插空禁配词仍命中', () => {
    const issues = constructionOrgProfessionalChainIssues({ markdown: '房建工程涉及管 道 闭 水 试 验和沥 青 摊 铺。', factsModel: makeFactsModel(), chapters: [] });
    expect(issues.some(issue => issue.message.includes('混入'))).toBe(true);
  });
});

// ═══════ Y6 加分模块提示词与信息 ═══════
describe('Y6 constructionOrgBonusModulePrompt / Issues', () => {
  it.each([
    ['技术标', '招标评分项响应索引'],
    ['工程量清单', '主要工程量一览表'],
    ['隐蔽验收', '影像资料留存'],
    ['改造项目', '变更签证管理'],
    ['动火作业', '危险品专项管理'],
    ['模板周转', '材料损耗与周转控制'],
    ['分户验收', '分户验收'],
  ])('模块词 %s → 触发 %s', (title, moduleTitle) => {
    expect(constructionOrgBonusModulePrompt(tplChapter(title))).toContain(moduleTitle);
  });

  it('prompt 头部为【隐藏高分模块触发】', () => {
    expect(constructionOrgBonusModulePrompt(tplChapter('技术标')).startsWith('【隐藏高分模块触发】')).toBe(true);
  });

  it('无匹配 → 空串', () => {
    expect(constructionOrgBonusModulePrompt(tplChapter('工程概况'))).toBe('');
  });

  it('queries 参与匹配', () => {
    expect(constructionOrgBonusModulePrompt(tplChapter('工程概况', [], ['工程量清单']))).toContain('主要工程量一览表');
  });

  it('多模块 → 多行', () => {
    const prompt = constructionOrgBonusModulePrompt(tplChapter('技术标', ['隐蔽工程验收']));
    expect(prompt).toContain('招标评分项响应索引');
    expect(prompt).toContain('影像资料留存');
  });

  it('issues：pattern 命中但正文缺模块 → info 建议', () => {
    const issues = constructionOrgBonusModuleIssues([draftChapter('技术标响应', '正文')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('info');
    expect(issues[0].message).toContain('招标评分项响应索引');
  });

  it('issues：正文已含模块标题 → 不报', () => {
    expect(constructionOrgBonusModuleIssues([draftChapter('技术标响应', '已设置招标评分项响应索引。')])).toEqual([]);
  });

  it('issues：标题无匹配 → 无 issue', () => {
    expect(constructionOrgBonusModuleIssues([draftChapter('工程概况', '正文')])).toEqual([]);
  });

  it('issues：多模块 → 多条 info', () => {
    const chapter = { ...draftChapter('改造项目', '正文'), sections: ['动火作业'] };
    expect(constructionOrgBonusModuleIssues([chapter])).toHaveLength(2);
  });

  it('issues：suggestion 引用模块 prompt', () => {
    const issues = constructionOrgBonusModuleIssues([draftChapter('隐蔽工程验收', '正文')]);
    expect(issues[0].suggestion).toContain('影像资料');
  });
});

// ═══════ Y7 主要施工内容专项验收 ═══════
describe('Y7 constructionOrgMajorContentIssues', () => {
  const pkg = (name: string, index: number) => `#### ${index} ${name}
施工概况：${name}作业范围${index}000㎡，工程量清单列明作业量${index}00项。
施工流程：测量放线→沟槽开挖→管道铺设→闭水试验→回填压实。
施工方法：机械开挖配合人工清底，槽底标高偏差控制在20mm以内，闭水试验合格后回填，检测合格后形成记录归档。`;
  const majorSection = (count: number) => ['### 项目主要施工内容',
    ...Array.from({ length: count }, (_item, index) => pkg(`污水管网${index + 1}工程`, index + 1))].join('\n');

  it('5 个三要素齐全工作包 → 无 issue', () => {
    expect(constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', majorSection(5))])).toEqual([]);
  });

  it('4 个工作包 → blocker 专业工程不足', () => {
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', majorSection(4))]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('专业工程不足');
    expect(issues[0].message).toContain('当前 4 个');
  });

  it('段落正文 + 数据附表（2 行小表）→ 不报（与 fixTableBorneContentSections 同源口径校准）', () => {
    const content = `${majorSection(5)}\n| 序号 | 内容 |\n|---|---|`;
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('Markdown 表格'))).toBe(false);
  });

  it('内容全为 Markdown 表格（无专业工程段落正文）→ blocker', () => {
    const content = ['### 项目主要施工内容',
      '| 序号 | 专业工程 | 内容 |',
      '|---|---|---|',
      '| 1 | 污水管网工程 | 沟槽开挖与管道铺设 |',
      '| 2 | 道路工程 | 基层处理与沥青摊铺 |',
      '| 3 | 绿化工程 | 种植土换填与苗木栽植 |',
      '| 4 | 给排水工程 | 检查井砌筑与闭水试验 |',
      '| 5 | 安装工程 | 管道附件安装与调试 |'].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('Markdown 表格'))).toBe(true);
  });

  it('同名专业工程重复（去工程尾缀归一）→ blocker', () => {
    const content = ['### 项目主要施工内容', pkg('污水管网工程', 1), pkg('污水管网工程', 2), pkg('道路工程', 3), pkg('给排水工程', 4), pkg('绿化工程', 5)].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('重复专业工程'))).toBe(true);
  });

  it('包内含「资料内容事实」→ blocker 脏事实', () => {
    const content = ['### 项目主要施工内容', '#### 1 污水管网工程', '资料内容事实：见附件', '施工流程：a→b→c', '施工方法：偏差20mm，检测合格后记录归档。', ...Array.from({ length: 4 }, (_item, index) => pkg(`道路${index + 1}工程`, index + 2))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('脏事实'))).toBe(true);
  });

  it('包内嵌入 H5 标题 → blocker 标题污染（H3/H4 嵌入会截断提取）', () => {
    const content = ['### 项目主要施工内容', '#### 1 污水管网工程', '##### 非法五级标题', '施工概况：作业范围1000㎡。', '施工流程：a→b→c', '施工方法：偏差20mm，检测记录归档。', ...Array.from({ length: 4 }, (_item, index) => pkg(`道路${index + 1}工程`, index + 2))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('脏事实或标题污染'))).toBe(true);
  });

  it('施工方法段 <30 字 → blocker 方法过弱', () => {
    const content = ['### 项目主要施工内容', '#### 1 污水管网工程', '施工概况：作业范围1000㎡，作业量50项。', '施工流程：先测量后铺设。', '施工方法：常规做法。', ...Array.from({ length: 4 }, (_item, index) => pkg(`道路${index + 1}工程`, index + 2))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('施工方法过弱'))).toBe(true);
  });

  it('方法段 ≥30 字但工程词 ≥4 且无量化 → blocker 方法过弱', () => {
    const content = ['### 项目主要施工内容', '#### 1 污水管网工程', '施工概况：作业范围1000㎡，作业量50项。', '施工流程：先测量后铺设。', '施工方法：本工程包含给水工程、排水工程、电气工程、暖通工程全部安装内容。', ...Array.from({ length: 4 }, (_item, index) => pkg(`道路${index + 1}工程`, index + 2))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('施工方法过弱'))).toBe(true);
  });

  it('施工流程段含「未尽事宜」→ blocker 流程污染', () => {
    const content = ['### 项目主要施工内容', '#### 1 污水管网工程', '施工概况：作业范围1000㎡，作业量50项。', '施工流程：未尽事宜见补充文件。', '施工方法：偏差20mm以内，检测合格后形成记录归档。', ...Array.from({ length: 4 }, (_item, index) => pkg(`道路${index + 1}工程`, index + 2))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('流程污染'))).toBe(true);
  });

  it('工作包含「按设计图纸执行」→ blocker 概括话术', () => {
    const content = ['### 项目主要施工内容', '#### 1 污水管网工程', '施工概况：作业范围1000㎡，作业量50项。', '施工流程：先测量后铺设。', '施工方法：按设计图纸执行即可。', ...Array.from({ length: 4 }, (_item, index) => pkg(`道路${index + 1}工程`, index + 2))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('概括话术'))).toBe(true);
  });

  it('全节无工序顺序表达 → blocker', () => {
    const flat = (name: string, index: number) => `#### ${index} ${name}
施工概况：${name}作业范围${index}000㎡，作业量${index}00项。
施工流程：管道铺设完成后回填。
施工方法：偏差20mm以内，检测合格后记录归档。`;
    const content = ['### 项目主要施工内容', ...Array.from({ length: 5 }, (_item, index) => flat(`污水管网${index + 1}工程`, index + 1))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('工序顺序表达'))).toBe(true);
  });

  it('参数与事实细度不足 → blocker', () => {
    const thin = (name: string, index: number) => `#### ${index} ${name}
施工概况：${name}作业范围。
施工流程：先测量再铺设。
施工方法：人工开挖。`;
    const content = ['### 项目主要施工内容', ...Array.from({ length: 5 }, (_item, index) => thin(`污水管网${index + 1}工程`, index + 1))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('事实细度不足'))).toBe(true);
  });

  it('候选章但 content 无小节 → blocker 小节缺失', () => {
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', '正文没有小节。')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('缺失');
  });

  it('无候选章 + markdown 兑底（全文有小节）→ 正常校验', () => {
    expect(constructionOrgMajorContentIssues([], `施工组织设计\n${majorSection(5)}`)).toEqual([]);
  });

  it('无候选章 + markdown 无小节 → blocker 缺小节', () => {
    const issues = constructionOrgMajorContentIssues([], '施工组织设计\n正文');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('缺少“项目主要施工内容”小节');
  });

  it('无候选章 + 无施工组织语境 → 无 issue', () => {
    expect(constructionOrgMajorContentIssues([draftChapter('工程概况', '正文')], '')).toEqual([]);
  });

  it('合并块「工程概况与主要施工内容」+5 完整包 → 认可不报缺失', () => {
    const content = ['### 工程概况与主要施工内容', ...Array.from({ length: 5 }, (_item, index) => pkg(`污水管网${index + 1}工程`, index + 1))].join('\n');
    expect(constructionOrgMajorContentIssues([draftChapter('工程概况与主要施工内容', content)])).toEqual([]);
  });

  it('合并块 <5 个完整包 → 小节缺失 blocker', () => {
    const content = ['### 工程概况与主要施工内容', ...Array.from({ length: 4 }, (_item, index) => pkg(`污水管网${index + 1}工程`, index + 1))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('工程概况与主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('缺失'))).toBe(true);
  });

  it('H4 层级小节标题行被剥离后再计数', () => {
    const content = ['#### 1.3.1 项目主要施工内容', ...Array.from({ length: 5 }, (_item, index) => pkg(`污水管网${index + 1}工程`, index + 1))].join('\n');
    expect(constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)])).toEqual([]);
  });

  it('粗体伪标题归一为 H4', () => {
    const content = ['### 项目主要施工内容', '**污水管网工程**', '施工概况：作业范围1000㎡。', '施工流程：a→b→c。', '施工方法：偏差20mm，检测记录归档。'].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.some(issue => issue.message.includes('专业工程不足'))).toBe(true);
  });

  it('多类问题同节 → 多条 blocker', () => {
    const content = ['### 项目主要施工内容', '#### 1 污水管网工程', '资料内容事实：见附件', '施工流程：a→b→c', '施工方法：常规做法。', ...Array.from({ length: 2 }, (_item, index) => pkg(`道路${index + 1}工程`, index + 2))].join('\n');
    const issues = constructionOrgMajorContentIssues([draftChapter('项目主要施工内容', content)]);
    expect(issues.length).toBeGreaterThan(1);
    expect(issues.every(issue => issue.severity === 'blocker')).toBe(true);
  });
});

// ═══════ Y8 分部分项专项验收 ═══════
describe('Y8 constructionOrgDivisionSectionIssues', () => {
  const dpkg = (name: string, index: number) => `#### ${index} ${name}
施工概况：${name}作业面积${index}5000㎡，作业部位覆盖全部设计范围，工程量清单列明作业数量${index}00项，材料规格型号与清单一致，作业边界清晰明确。
施工流程：测量放线→基层处理→分层摊铺→机械碾压→压实度检测→隐蔽验收→成品保护。
施工方法：采用机械摊铺为主人工配合，厚度偏差控制在±20mm以内，压实度不低于95%，试验压力按设计值控制，检测合格后形成记录归档闭环。`;
  const divisionSection = (count: number) => ['### 主要分部分项工程施工方案',
    ...Array.from({ length: count }, (_item, index) => dpkg(`分项${index + 1}工程`, index + 1))].join('\n');

  it('5 个三要素齐全分项方案 → 无 issue', () => {
    expect(constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', divisionSection(5))])).toEqual([]);
  });

  it('2 个分项 → blocker 分项不足', () => {
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', divisionSection(2))]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('分项不足'))).toBe(true);
  });

  it('4 个分项 → warning 建议扩充', () => {
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', divisionSection(4))]);
    const expand = issues.find(issue => issue.level === 'warning');
    expect(expand).toBeTruthy();
    expect(expand?.message).toContain('建议扩充');
  });

  it('恰好 3 个分项 → 无分项不足 blocker、有建议扩充 warning', () => {
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', divisionSection(3))]);
    expect(issues.some(issue => issue.message.includes('分项不足'))).toBe(false);
    expect(issues.some(issue => issue.level === 'warning' && issue.message.includes('建议扩充'))).toBe(true);
  });

  it('分项缺作业对象要素 → blocker 要素不全', () => {
    const bad = '#### 1 分项1工程\n施工流程：a→b→c。\n施工方法：偏差20mm以内，检测合格后记录归档。';
    const content = ['### 主要分部分项工程施工方案', bad, ...Array.from({ length: 4 }, (_item, index) => dpkg(`分项${index + 2}工程`, index + 2))].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('内容要素不全'))).toBe(true);
  });

  it('分项含「按设计图纸执行」→ blocker 概括话术', () => {
    const bad = '#### 1 分项1工程\n施工概况：作业范围1000㎡。\n施工流程：a→b→c。\n施工方法：按设计图纸执行。';
    const content = ['### 主要分部分项工程施工方案', bad, ...Array.from({ length: 4 }, (_item, index) => dpkg(`分项${index + 2}工程`, index + 2))].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('概括话术'))).toBe(true);
  });

  it('分项含「按规范施工」→ blocker 脏事实', () => {
    const bad = '#### 1 分项1工程\n施工概况：作业范围1000㎡。\n施工流程：a→b→c。\n施工方法：按规范施工即可。';
    const content = ['### 主要分部分项工程施工方案', bad, ...Array.from({ length: 4 }, (_item, index) => dpkg(`分项${index + 2}工程`, index + 2))].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('脏事实或空话污染'))).toBe(true);
  });

  it('方法与流程段均无工序顺序表达 → blocker', () => {
    const bad = '#### 1 分项1工程\n施工概况：作业范围1000㎡，数量50项。\n施工流程：沟槽开挖完成后铺设管道。\n施工方法：机械开挖，偏差20mm，压实度95%，检测记录。';
    const content = ['### 主要分部分项工程施工方案', bad, ...Array.from({ length: 4 }, (_item, index) => dpkg(`分项${index + 2}工程`, index + 2))].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('工序顺序表达'))).toBe(true);
  });

  it('工艺参数 <4 个 → blocker 参数不足', () => {
    const bad = '#### 1 分项1工程\n施工概况：作业范围1000㎡。\n施工流程：先开挖后回填。\n施工方法：机械开挖，检测合格后记录归档。';
    const content = ['### 主要分部分项工程施工方案', bad, ...Array.from({ length: 4 }, (_item, index) => dpkg(`分项${index + 2}工程`, index + 2))].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('工艺参数不足'))).toBe(true);
  });

  it('工艺词+数字补足参数（搭接长度+偏差）→ 不报参数不足', () => {
    const pkgWord = '#### 1 分项1工程\n施工概况：作业范围1000㎡。\n施工流程：先铺贴后勾缝。\n施工方法：搭接长度150mm，偏差20mm，检测合格后记录归档。';
    const content = ['### 主要分部分项工程施工方案', pkgWord, ...Array.from({ length: 4 }, (_item, index) => dpkg(`分项${index + 2}工程`, index + 2))].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('工艺参数不足'))).toBe(false);
  });

  it('分项正文 <150 字 → blocker 正文过短', () => {
    const short = (name: string, index: number) => `#### ${index} ${name}\n施工概况：${index}000㎡，${index}0项。\n施工流程：a→b→c。\n施工方法：20mm，95%，检测，记录。`;
    const content = ['### 主要分部分项工程施工方案', short('分项1工程', 1), short('分项2工程', 2), short('分项3工程', 3)].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('正文过短'))).toBe(true);
  });

  it('分项深度失衡（最短 < 最长/3）→ warning', () => {
    const longPkg = (name: string, index: number) => `#### ${index} ${name}\n施工概况：${'长'.repeat(500)}${index}000㎡，${index}0项。\n施工流程：先处理后摊铺。\n施工方法：偏差20mm，压实度95%，检测合格后记录归档。`;
    const shortPkg = `#### 5 分项5工程\n施工概况：${'x'.repeat(120)}，数量50项，面积1000㎡。\n施工流程：a→b→c。\n施工方法：偏差20mm，压实度95%。`;
    const content = ['### 主要分部分项工程施工方案', longPkg('分项1工程', 1), longPkg('分项2工程', 2), longPkg('分项3工程', 3), longPkg('分项4工程', 4), shortPkg].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.level === 'warning' && issue.message.includes('分项深度失衡'))).toBe(true);
  });

  it('候选章但 content 无小节 → blocker 缺失', () => {
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', '正文无小节。')]);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
  });

  it('无候选章 + markdown 全文兑底 → 正常校验', () => {
    expect(constructionOrgDivisionSectionIssues([], `施工组织设计\n${divisionSection(5)}`)).toEqual([]);
  });

  it('无候选章 + 全文无小节 → 无 issue', () => {
    expect(constructionOrgDivisionSectionIssues([draftChapter('工程概况', '正文')], '')).toEqual([]);
  });

  it('粗体伪标题形态 → 切块成功并报粗体污染', () => {
    const boldBlock = (name: string, index: number) => `**${name}**\n施工概况：作业面积${index}5000㎡，数量${index}00项，部位明确。\n施工流程：测量放线→基层处理→分层摊铺→碾压→检测。\n施工方法：厚度偏差20mm，压实度95%，试验合格后记录归档。`;
    const content = ['### 主要分部分项工程施工方案', ...Array.from({ length: 5 }, (_item, index) => boldBlock(`分项${index + 1}工程`, index + 1))].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('脏事实或空话污染'))).toBe(true);
  });

  it('变体标题「主要分部分项施工方案」→ 提取正则同源补全后正常校验', () => {
    const content = divisionSection(5).replace('主要分部分项工程施工方案', '主要分部分项施工方案');
    expect(constructionOrgDivisionSectionIssues([draftChapter('主要分部分项施工方案', content)])).toEqual([]);
  });

  it('H4 层级小节标题行不入分项计数', () => {
    const content = ['#### 1.3.1 主要分部分项工程施工方案', ...Array.from({ length: 5 }, (_item, index) => dpkg(`分项${index + 1}工程`, index + 1))].join('\n');
    expect(constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)])).toEqual([]);
  });

  it('分项恰好 150 字（去空白）→ 不报过短', () => {
    const exact = `#### 1 分项1工程\n施工概况：${'a'.repeat(120)}，数量50项，面积1000㎡。\n施工流程：b→c→d。\n施工方法：偏差20mm，压实度95%。`;
    const content = ['### 主要分部分项工程施工方案', exact, ...Array.from({ length: 4 }, (_item, index) => dpkg(`分项${index + 2}工程`, index + 2))].join('\n');
    const issues = constructionOrgDivisionSectionIssues([draftChapter('主要分部分项工程施工方案', content)]);
    expect(issues.some(issue => issue.message.includes('正文过短'))).toBe(false);
  });
});

// ═══════ Y9 关键小节逐包三要素（G1） ═══════
describe('Y9 perPackageContentElementIssues', () => {
  const pkg = (name: string, index: number) => `#### ${index} ${name}
施工概况：${name}作业范围${index}000㎡，作业量${index}00项。
施工流程：测量放线→沟槽开挖→管道铺设→闭水试验。
施工方法：偏差20mm以内，检测合格后记录归档。`;

  it('H3 关键小节 + 5 个三要素齐全工作包 → 无 issue', () => {
    const md = ['### 项目主要施工内容', ...Array.from({ length: 5 }, (_item, index) => pkg(`污水管网${index + 1}工程`, index + 1))].join('\n');
    expect(perPackageContentElementIssues(md)).toEqual([]);
  });

  it('平铺式缺作业对象 → 精确报缺维', () => {
    const md = '### 项目主要施工内容\n施工流程：先测量后铺设。\n施工方法：偏差20mm，检测记录归档。';
    const issues = perPackageContentElementIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('缺少三要素：作业对象与工程量');
  });

  it('平铺式三要素齐（标签形态）→ 无 issue', () => {
    const md = '### 项目主要施工内容\n施工概况：作业范围1000㎡。\n施工流程：先测量后铺设。\n施工方法：偏差20mm，检测记录归档。';
    expect(perPackageContentElementIssues(md)).toEqual([]);
  });

  it('标签型 H4 缺一维 → 父块整体判定精确报缺', () => {
    const md = ['### 项目主要施工内容', '#### 施工流程', '先基层处理后铺装。', '#### 施工方法', '偏差2mm，检测记录归档。'].join('\n');
    const issues = perPackageContentElementIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('作业对象与工程量');
  });

  it('标签型 H4 三标签齐全 → 无 issue', () => {
    const md = ['### 2.14 楼地面装饰工程', '#### 施工概况', '作业面积500㎡。', '#### 施工流程', '先基层处理后铺装。', '#### 施工方法', '偏差2mm，检测记录归档。'].join('\n');
    expect(perPackageContentElementIssues(md)).toEqual([]);
  });

  it('专业工程型 H4 逐块判定：缺施工方法 → 报包名', () => {
    const md = ['### 项目主要施工内容', '#### 1 污水管网工程', '施工概况：作业范围1000㎡。', '施工流程：先测量后铺设。'].join('\n');
    const issues = perPackageContentElementIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('污水管网工程');
    expect(issues[0].message).toContain('施工方法');
  });

  it('缺多维 → message 列全缺维', () => {
    const md = '### 项目主要施工内容\n#### 1 污水管网工程\n施工流程：先测量后铺设。';
    const issues = perPackageContentElementIssues(md);
    expect(issues[0].message).toContain('作业对象与工程量、施工方法');
  });

  it('suggestion 按缺维给出补写提示', () => {
    const md = '### 项目主要施工内容\n#### 1 污水管网工程\n施工流程：先测量后铺设。';
    const issues = perPackageContentElementIssues(md);
    expect(issues[0].suggestion).toContain('作业对象与工程量');
    expect(issues[0].suggestion).toContain('施工方法');
  });

  it('H2 关键章内 H3 分部逐块判定', () => {
    const md = ['## 第二章 主要施工方法', '### 2.1 楼地面装饰工程', '#### 施工流程', '先基层处理后铺装。', '#### 施工方法', '偏差2mm，检测记录。', '### 2.2 给排水工程', '施工概况：作业范围500㎡。', '施工流程：a→b。', '施工方法：偏差20mm，检测记录。'].join('\n');
    const issues = perPackageContentElementIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('楼地面装饰工程');
  });

  it('H2 关键章无 H3 → 整章判定', () => {
    const md = '## 第二章 主要施工方法\n正文缺要素。';
    const issues = perPackageContentElementIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('小节缺少三要素');
  });

  it('非关键小节 → 无 issue', () => {
    expect(perPackageContentElementIssues('### 施工部署\n正文。')).toEqual([]);
  });

  it('标签型 H4 混在专业工程包中 → 跳过标签、工程包独立判定', () => {
    const md = ['### 项目主要施工内容', '#### 施工流程', '先处理后浇筑。', '#### 1 污水管网工程', '施工概况：作业范围1000㎡。', '施工流程：a→b→c。', '施工方法：偏差20mm，检测记录。'].join('\n');
    expect(perPackageContentElementIssues(md)).toEqual([]);
  });

  it('issue 级别为 error blocker', () => {
    const md = '### 项目主要施工内容\n正文缺要素。';
    const issues = perPackageContentElementIssues(md);
    expect(issues[0].level).toBe('error');
    expect(issues[0].severity).toBe('blocker');
  });
});

// ═══════ Y10 清单口径治理（G2） ═══════
describe('Y10 majorContentGovernanceIssues', () => {
  const inSection = (body: string) => `### 项目主要施工内容\n${body}`;

  it('正文全为 Markdown 表格（≥3 行无实质正文）→ blocker', () => {
    const issues = majorContentGovernanceIssues(inSection('| 序号 | 内容 |\n|---|---|\n| 1 | 沟槽开挖 |\n| 2 | 管道铺设 |'));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('Markdown 表格');
  });

  it('段落叙述 + 数据附表 → 不报（表格承载口径校准：正文已承载主体内容）', () => {
    const issues = majorContentGovernanceIssues(inSection('沟槽开挖采用分段流水作业，管道铺设后分层回填压实，检查井砌筑随管道施工同步推进，回填压实度按规范逐层检测。\n| 序号 | 内容 |\n|---|---|\n| 1 | 沟槽开挖 |\n| 2 | 管道铺设 |'));
    expect(issues).toEqual([]);
  });

  it.each(['分部小计', '本页小计', '按实', '暂估', '综合单价', '规费', '税金'])('清单口径强词 %s → blocker', (word) => {
    const issues = majorContentGovernanceIssues(inSection(`正文包含${word}记录。`));
    expect(issues.some(issue => issue.message.includes('清单内部口径词'))).toBe(true);
  });

  it('措施项目费 → blocker', () => {
    expect(majorContentGovernanceIssues(inSection('本表措施项目费合计见清单。'))).toHaveLength(1);
  });

  it('措施项目+清单 → blocker', () => {
    expect(majorContentGovernanceIssues(inSection('措施项目清单如下。'))).toHaveLength(1);
  });

  it('措施项目+计价 → blocker', () => {
    expect(majorContentGovernanceIssues(inSection('措施项目计价表见附件。'))).toHaveLength(1);
  });

  it('措施项目作为工程类别单独出现 → 不报', () => {
    expect(majorContentGovernanceIssues(inSection('本措施项目包括围挡、临电和场地硬化。'))).toEqual([]);
  });

  it('合计+单位 → blocker（弱词）', () => {
    expect(majorContentGovernanceIssues(inSection('主要工程量合计1250㎡。'))).toHaveLength(1);
  });

  it('小计+单位 → blocker（弱词）', () => {
    expect(majorContentGovernanceIssues(inSection('道路工程小计8600吨。'))).toHaveLength(1);
  });

  it('合计无单位 → 不报', () => {
    expect(majorContentGovernanceIssues(inSection('本段合计数据齐全。'))).toEqual([]);
  });

  it('干净正文 → 无 issue', () => {
    expect(majorContentGovernanceIssues(inSection('道路工程作业面积1250㎡，基层处理完成后摊铺沥青。'))).toEqual([]);
  });

  it('非关键小节 → 无 issue', () => {
    expect(majorContentGovernanceIssues('### 施工部署\n正文含分部小计。')).toEqual([]);
  });

  it('空正文 → 无 issue', () => {
    expect(majorContentGovernanceIssues('### 项目主要施工内容\n')).toEqual([]);
  });

  it('口径词带上下文窗口（前后各 18 字）', () => {
    const issues = majorContentGovernanceIssues(inSection('道路工程完成面层施工后其分部小计数值已核对完毕。'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('分部小计');
  });

  it('H2 关键章内 H3 分部同样治理', () => {
    const md = '## 第二章 主要施工方法\n### 2.1 道路工程\n正文含综合单价记录。';
    const issues = majorContentGovernanceIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('2.1 道路工程');
  });

  it('多口径词同块 → 单条 issue 截断展示前 6 个', () => {
    const issues = majorContentGovernanceIssues(inSection('分部小计、按实、暂估、综合单价、规费、税金、本页小计全部出现。'));
    expect(issues).toHaveLength(1);
  });
});

// ═══════ Y11 空话词表 ═══════
describe('Y11 CONSTRUCTION_ORG_GENERIC_PHRASES', () => {
  it('词表含 11 个空话词', () => {
    expect(CONSTRUCTION_ORG_GENERIC_PHRASES).toHaveLength(11);
  });

  it('词表无重复', () => {
    expect(new Set(CONSTRUCTION_ORG_GENERIC_PHRASES).size).toBe(11);
  });

  it('每个词非空', () => {
    expect(CONSTRUCTION_ORG_GENERIC_PHRASES.every(phrase => phrase.length >= 4)).toBe(true);
  });
});
