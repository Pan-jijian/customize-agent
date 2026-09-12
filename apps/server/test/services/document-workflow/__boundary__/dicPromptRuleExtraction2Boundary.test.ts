/**
 * t4-pr PR1 组（第二批）：promptRuleExtraction 大函数族投影矩阵（生成器产出，真实行为锁定）。
 * 覆盖：extractPromptDocumentRules / buildRuntimePromptRules / extractPromptStructuralRules /
 * runtimePromptRulesPrompt / previewPromptRules / detectPromptRuleConflicts / professionalSectionTaskCard。
 */
import { describe, expect, it } from 'vitest';
import {
  buildRuntimePromptRules,
  detectPromptRuleConflicts,
  extractPromptDocumentRules,
  extractPromptStructuralRules,
  previewPromptRules,
  professionalSectionTaskCard,
  runtimePromptRulesPrompt,
} from '@/services/document-workflow/promptRuleExtraction';

describe('extractPromptDocumentRules', () => {
  it('空串', () => {
    const r = extractPromptDocumentRules(...[""]);
    expect(r.coverPolicy).toEqual("unspecified");
    expect(r.tocPolicy).toEqual("unspecified");
    expect(r.requiredTables).toEqual([]);
    expect(r.requiredKeywords).toEqual([]);
    expect(r.forbiddenPatterns).toEqual([]);
  });
  it('要求生成封面', () => {
    const r = extractPromptDocumentRules(...["需要生成封面"]);
    expect(r.coverPolicy).toEqual("required");
    expect(r.forbidCover).toEqual(false);
  });
  it('禁止输出封面', () => {
    const r = extractPromptDocumentRules(...["不得输出封面"]);
    expect(r.coverPolicy).toEqual("forbidden");
    expect(r.forbidCover).toEqual(true);
  });
  it('封面无规则', () => {
    const r = extractPromptDocumentRules(...["封面美观大方"]);
    expect(r.coverPolicy).toEqual("unspecified");
  });
  it('要求输出目录', () => {
    const r = extractPromptDocumentRules(...["必须输出目录"]);
    expect(r.tocPolicy).toEqual("required");
    expect(r.forbidToc).toEqual(false);
  });
  it('不需要目录', () => {
    const r = extractPromptDocumentRules(...["不需要目录"]);
    expect(r.tocPolicy).toEqual("forbidden");
    expect(r.forbidToc).toEqual(true);
  });
  it('封面双规则禁止优先', () => {
    const r = extractPromptDocumentRules(...["需要生成封面；不得输出封面"]);
    expect(r.coverPolicy).toEqual("forbidden");
  });
  it('目录双规则禁止优先', () => {
    const r = extractPromptDocumentRules(...["输出目录；禁止目录"]);
    expect(r.tocPolicy).toEqual("forbidden");
  });
  it('全文必须输出表格', () => {
    const r = extractPromptDocumentRules(...["全文必须输出：项目基本信息表、施工进度计划表"]);
    expect(r.requiredTables).toEqual(["项目基本信息表","施工进度计划表"]);
  });
  it('必须输出表格', () => {
    const r = extractPromptDocumentRules(...["必须输出表格：机械设备配置表"]);
    expect(r.requiredTables).toEqual(["机械设备配置表"]);
  });
  it('表格标题无表字不收录', () => {
    const r = extractPromptDocumentRules(...["全文必须输出：主要内容"]);
    expect(r.requiredTables).toEqual([]);
  });
  it('项目基本信息表隐式', () => {
    const r = extractPromptDocumentRules(...["正文应包含项目基本信息表"]);
    expect(r.requiredTables).toEqual(["项目基本信息表"]);
  });
  it('套话禁止扩展', () => {
    const r = extractPromptDocumentRules(...["严禁套话和空话"]);
    expect(r.forbiddenTerms).toEqual(["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段","高度重视","重中之重"]);
  });
  it('技术标商务禁止扩展', () => {
    const r = extractPromptDocumentRules(...["技术标不得包含商务报价内容"]);
    expect(r.forbiddenTerms).toEqual(["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段","报价明细表"]);
  });
  it('必含关键词', () => {
    const r = extractPromptDocumentRules(...["必须包含以下关键词：BIM、智慧工地"]);
    expect(r.requiredKeywords).toEqual(["BIM","智慧工地"]);
  });
  it('禁用词模式1', () => {
    const r = extractPromptDocumentRules(...["禁用词：套话、空话"]);
    expect(r.forbiddenPatterns).toEqual(["套话","空话"]);
  });
  it('禁止出现词语', () => {
    const r = extractPromptDocumentRules(...["禁止出现以下词语：空泛、口号"]);
    expect(r.forbiddenPatterns).toEqual(["空泛","口号"]);
  });
  it('关键词过滤表格词', () => {
    const r = extractPromptDocumentRules(...["必须包含关键词：表格、章节、BIM"]);
    expect(r.requiredKeywords).toEqual(["BIM"]);
  });
  it('关键词上限24', () => {
    const r = extractPromptDocumentRules(...["必须包含关键词：词0、词1、词2、词3、词4、词5、词6、词7、词8、词9、词10、词11、词12、词13、词14、词15、词16、词17、词18、词19、词20、词21、词22、词23、词24、词25、词26、词27、词28、词29"]);
    expect(r.requiredKeywords?.length).toEqual(24);
  });
  it('禁词上限40', () => {
    const r = extractPromptDocumentRules(...["禁止出现以下词语：词0、词1、词2、词3、词4、词5、词6、词7、词8、词9、词10、词11、词12、词13、词14、词15、词16、词17、词18、词19、词20、词21、词22、词23、词24、词25、词26、词27、词28、词29、词30、词31、词32、词33、词34、词35、词36、词37、词38、词39、词40、词41、词42、词43、词44、词45、词46、词47、词48、词49"]);
    expect(r.forbiddenPatterns?.length).toEqual(40);
  });
  it('转义换行', () => {
    const r = extractPromptDocumentRules(...["必须输出目录\\n必须包含关键词：BIM"]);
    expect(r.tocPolicy).toEqual("required");
    expect(r.requiredKeywords).toEqual(["BIM"]);
  });
  it('preferredTerms 固定', () => {
    const r = extractPromptDocumentRules(...["任何内容"]);
    expect(r.preferredTerms).toEqual([{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}]);
  });
  it('组合全量', () => {
    const r = extractPromptDocumentRules(...["必须输出封面；必须输出目录；全文必须输出：项目基本信息表；必须包含以下关键词：BIM、绿色施工；禁止出现以下词语：空话；严禁套话"]);
    expect(r.coverPolicy).toEqual("required");
    expect(r.tocPolicy).toEqual("required");
    expect(r.requiredTables).toEqual(["项目基本信息表"]);
    expect(r.requiredKeywords).toEqual(["BIM","绿色施工"]);
    expect(r.forbiddenPatterns).toEqual(["空话"]);
    expect(r.forbiddenTerms.length).toEqual(13);
  });
});
describe('buildRuntimePromptRules', () => {
  it('空输入', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":""}]);
    expect(r.sourceHash).toEqual("811c9dc5");
    expect(r.executionSummary).toEqual(["已识别禁用词 11 个"]);
    expect(r.forbidExtraHeadings).toEqual(false);
  });
  it('requirement 合并', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"必须输出封面","requirement":"不得编造任何数据"}]);
    expect(r.coverPolicy).toEqual("required");
    expect(r.forbidFabrication).toEqual(true);
  });
  it('minWords 不少于', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"全文不少于2万字"}]);
    expect(r.minWords).toEqual(20000);
    expect(r.minChars).toEqual(20000);
  });
  it('minWords 至少', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"至少5000字"}]);
    expect(r.minWords).toEqual(5000);
  });
  it('minWords 最低', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"最低8000字"}]);
    expect(r.minWords).toEqual(8000);
  });
  it('minWords 必须生成不少于', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"必须生成不少于1.5万字"}]);
    expect(r.minWords).toEqual(15000);
  });
  it('minWords 不低于不提取', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"全文不低于3万字"}]);
    expect(r.minWords).toEqual(undefined);
  });
  it('minWords 负数不提取', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"不少于0字"}]);
    expect(r.minWords).toEqual(undefined);
  });
  it('OUTLINE 提取', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"<OUTLINE>\n1.施工方案\n2.质量保证措施\n3.安全生产\n</OUTLINE>"}]);
    expect(r.exactHeadings).toEqual(["施工方案","质量保证措施","安全生产"]);
    expect(r.forbidExtraHeadings).toEqual(true);
  });
  it('OUTLINE 指令标题过滤', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"<OUTLINE>\n1.目录\n2.大纲\n3.要求\n</OUTLINE>"}]);
    expect(r.exactHeadings).toEqual([]);
  });
  it('OUTLINE 编号变体', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"<OUTLINE>\n1、施工方案\n- 质量保证\n</OUTLINE>"}]);
    expect(r.exactHeadings).toEqual(["施工方案","质量保证"]);
  });
  it('OUTLINE 长标题过滤', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"<OUTLINE>\n1.长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长\n2.正常标题\n</OUTLINE>"}]);
    expect(r.exactHeadings).toEqual(["正常标题"]);
  });
  it('forbidExtraHeadings 不得新增', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"不得新增一级章节"}]);
    expect(r.forbidExtraHeadings).toEqual(true);
  });
  it('forbidExtraHeadings 严格按名称', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"严格按章节名称生成"}]);
    expect(r.forbidExtraHeadings).toEqual(true);
  });
  it('requiredSubjects 我公司', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"我公司承接本项目"}]);
    expect(r.requiredSubjects).toEqual(["我公司","项目部"]);
  });
  it('forbidFabrication', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"不得编造项目数据"}]);
    expect(r.forbidFabrication).toEqual(true);
  });
  it('requireEvidenceForQuantities', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"所有量化参数必须与资料一致"}]);
    expect(r.requireEvidenceForQuantities).toEqual(true);
  });
  it('preferProjectFacts', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"事实优先于推理"}]);
    expect(r.preferProjectFacts).toEqual(true);
  });
  it('commercialTerms', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"技术标正文不得涉及税率和造价"}]);
    expect(r.commercialTerms).toEqual(["报价明细表"]);
  });
  it('backendTerms 固定', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":""}]);
    expect(r.backendTerms).toEqual(["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"]);
  });
  it('chapterRules 匹配', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"施工方案章节必须包含工艺流程；质量保证章节禁止套话","template":{"id":"tpl-1","name":"","description":"","category":"","outputTitle":"","chapters":[{"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工方案"},{"id":"c2","purpose":"","queries":[],"requiredFacts":[],"title":"质量保证措施"}]}}]);
    expect(r.chapterRules.length).toEqual(1);
    expect(r.chapterRules[0]?.chapterTitle).toEqual("施工方案");
    expect(r.chapterRules[0]?.mustInclude.length).toEqual(1);
    expect(r.chapterRules[1]?.mustNotInclude.length).toEqual(undefined);
  });
  it('chapterRules 无匹配过滤', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"必须输出封面","template":{"id":"tpl-1","name":"","description":"","category":"","outputTitle":"","chapters":[{"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工方案"}]}}]);
    expect(r.chapterRules).toEqual([]);
  });
  it('roleRules 提取', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"","rolePrompts":[{"roleId":"qa","name":"质检","content":"必须重点检查隐蔽工程；禁止放过任何质量问题。"}]}]);
    expect(r.roleRules.length).toEqual(1);
    expect(r.roleRules[0]?.mustDo.length).toEqual(1);
    expect(r.roleRules[0]?.mustNotDo.length).toEqual(1);
  });
  it('roleRules 无命中过滤', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"","rolePrompts":[{"roleId":"x","name":"x","content":"普通内容"}]}]);
    expect(r.roleRules).toEqual([]);
  });
  it('attributedPrompts 溯源命中', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"必须输出封面","attributedPrompts":[{"promptId":"p1","roleId":"r1","name":"主控","content":"必须输出封面"}]}]);
    expect(r.extractionTrace?.[0]?.source.promptId).toEqual("p1");
    expect(r.extractionTrace?.[0]?.source.roleId).toEqual("r1");
  });
  it('attributedPrompts 未命中回退', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"必须输出封面","attributedPrompts":[{"promptId":"p1","roleId":"r1","name":"主控","content":"其他内容"}]}]);
    expect(r.extractionTrace?.[0]?.source.promptId).toEqual("system:generation-control");
  });
  it('executionSummary 组合', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"必须输出封面；全文不少于1万字；必须包含以下关键词：BIM"}]);
    expect(r.executionSummary).toEqual(["已识别封面规则：要求生成","已识别禁用词 11 个","已识别必含关键词：BIM","已识别最低字数要求：10000 字"]);
  });
  it('sourceHash 稳定', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"必须输出封面"}]);
    expect(r.sourceHash).toEqual("f75c83e7");
  });
  it('转义换行归一', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"必须输出封面\\n必须输出目录"}]);
    expect(r.coverPolicy).toEqual("required");
    expect(r.tocPolicy).toEqual("required");
  });
  it('ruleSources 聚合', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"必须输出封面；全文不少于1万字；必须包含以下关键词：BIM；禁止出现以下词语：空话"}]);
    expect(r.ruleSources ? Object.keys(r.ruleSources).length : 0).toEqual(4);
  });
  it('forbiddenTerms 合并去重', () => {
    const r = buildRuntimePromptRules(...[{"promptTexts":"严禁套话"}]);
    expect(r.forbiddenTerms.length).toEqual(13);
  });
});
describe('extractPromptStructuralRules', () => {
  it('无规则', () => {
    const r = extractPromptStructuralRules(...["普通文本"]);
    expect(r.length).toEqual(0);
  });
  it('topList 编号列表', () => {
    const r = extractPromptStructuralRules(...["第一章以下小节设置和排序：\n1.编制说明\n2.工程概况\n3.施工部署"]);
    expect(r.length).toEqual(1);
    expect(r[0]?.chapterIndex).toEqual(0);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["编制说明","施工部署"]);
    expect(r[0]?.requiredSections[0]?.order).toEqual(1);
  });
  it('topList 强制小节', () => {
    const r = extractPromptStructuralRules(...["第一章强制小节：1.编制说明 2.工程概况"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["编制说明 2.工程概况"]);
  });
  it('topList 必须小节', () => {
    const r = extractPromptStructuralRules(...["第一章必须小节：1.编制说明"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["编制说明"]);
  });
  it('数字章号', () => {
    const r = extractPromptStructuralRules(...["第2章强制小节：\n1.质量控制\n2.检验试验"]);
    expect(r[0]?.chapterIndex).toEqual(1);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["质量控制"]);
  });
  it('中文混合章号', () => {
    const r = extractPromptStructuralRules(...["第十二章必须小节：1.施工准备"]);
    expect(r[0]?.chapterIndex).toEqual(11);
  });
  it('章号十', () => {
    const r = extractPromptStructuralRules(...["第十章必须小节：1.测试"]);
    expect(r[0]?.chapterIndex).toEqual(9);
  });
  it('章号二十', () => {
    const r = extractPromptStructuralRules(...["第二十章必须小节：1.测试"]);
    expect(r[0]?.chapterIndex).toEqual(19);
  });
  it('条件规则跳过', () => {
    const r = extractPromptStructuralRules(...["第一章若涉及雨季施工，可设置专项小节"]);
    expect(r.length).toEqual(0);
  });
  it('条件+强制小节不跳过', () => {
    const r = extractPromptStructuralRules(...["第一章以下小节设置和排序：1.雨季 2.冬季"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["雨季 2.冬季"]);
  });
  it('chapters 映射标题', () => {
    const r = extractPromptStructuralRules(...["第一章必须小节：1.编制说明",[{"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"编制说明与工程概况"}]]);
    expect(r[0]?.chapterTitle).toEqual("编制说明与工程概况");
    expect(r[0]?.chapterIndex).toEqual(0);
  });
  it('引号小节模式', () => {
    const r = extractPromptStructuralRules(...["第一章必须包含“施工准备”二级小节"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["施工准备"]);
  });
  it('命名小节模式', () => {
    const r = extractPromptStructuralRules(...["第一章：施工准备——独立的二级小节"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["施工准备"]);
  });
  it('小节标签冒号模式', () => {
    const r = extractPromptStructuralRules(...["必须设置独立的二级小节：质量控制、检验试验"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(undefined);
  });
  it('必须包含模式', () => {
    const r = extractPromptStructuralRules(...["第一章必须包含：编制说明、工程概况"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["编制说明","工程概况"]);
  });
  it('多章聚合', () => {
    const r = extractPromptStructuralRules(...["第一章必须小节：1.编制说明\n第二章必须小节：2.施工准备"]);
    expect(r.length).toEqual(2);
    expect(r[0]?.chapterIndex).toEqual(0);
    expect(r[1]?.chapterIndex).toEqual(1);
  });
  it('同一章合并', () => {
    const r = extractPromptStructuralRules(...["第一章必须小节：1.编制说明\n第一章必须小节：2.施工准备"]);
    expect(r.length).toEqual(1);
    expect(r[0]?.requiredSections.length).toEqual(2);
  });
  it('等价小节去重', () => {
    const r = extractPromptStructuralRules(...["第一章必须小节：1.基坑开挖与支护 2.基坑开挖及支护"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["基坑开挖与支护 2.基坑开挖及支护"]);
  });
  it('无效小节过滤', () => {
    const r = extractPromptStructuralRules(...["第一章必须小节：1.目录 2.大纲 3.编制说明"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["目录 2.大纲 3.编制说明"]);
  });
  it('小节标题过短过滤', () => {
    const r = extractPromptStructuralRules(...["第一章必须小节：1.A 2.编制说明"]);
    expect(r[0]?.requiredSections.map(s=>s.title)).toEqual(["A 2.编制说明"]);
  });
  it('source 截断', () => {
    const r = extractPromptStructuralRules(...["第一章必须小节：1.编制说明\n长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长长"]);
    expect(r[0]?.source?.length).toEqual(14);
  });
});
describe('runtimePromptRulesPrompt', () => {
  it('空规则', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"unspecified" as const,"tocPolicy":"unspecified" as const,"forbidCover":false,"forbidToc":false,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":[],"requiredKeywords":[],"forbiddenPatterns":[],"sourceHash":"811c9dc5","exactHeadings":[],"forbidExtraHeadings":false,"requiredSubjects":[],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":[],"forbidFabrication":false,"requireEvidenceForQuantities":false,"preferProjectFacts":false,"chapterRules":[],"roleRules":[],"executionSummary":["已识别禁用词 11 个"]}]);
    expect(r.includes("运行时规则版本")).toEqual(true);
    expect(r.includes("禁止输出")).toEqual(true);
    expect(r.split("\n").length).toEqual(3);
  });
  it('封面目录双要求', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"required" as const,"tocPolicy":"required" as const,"forbidCover":false,"forbidToc":false,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":[],"requiredKeywords":[],"forbiddenPatterns":[],"sourceHash":"9f5a07d8","exactHeadings":[],"forbidExtraHeadings":false,"requiredSubjects":[],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":[],"forbidFabrication":false,"requireEvidenceForQuantities":false,"preferProjectFacts":false,"chapterRules":[],"roleRules":[],"executionSummary":["已识别封面规则：要求生成","已识别目录规则：要求生成","已识别禁用词 11 个"],"ruleSources":{"coverPolicy":[{"promptId":"system:generation-control","roleId":"generation-control","pattern":"封面|cover","matchedText":"封面"}],"tocPolicy":[{"promptId":"system:generation-control","roleId":"generation-control","pattern":"目录|toc","matchedText":"目录"}]},"extractionTrace":[{"rule":"已识别封面规则：required","source":{"promptId":"system:generation-control","roleId":"generation-control","pattern":"封面|cover"},"matchedText":"封面"},{"rule":"已识别目录规则：required","source":{"promptId":"system:generation-control","roleId":"generation-control","pattern":"目录|toc"},"matchedText":"目录"}]}]);
    expect(r.includes("必须保留封面")).toEqual(true);
    expect(r.includes("确保目录只来自最终合法正文标题")).toEqual(true);
  });
  it('禁止封面目录', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"forbidden" as const,"tocPolicy":"forbidden" as const,"forbidCover":true,"forbidToc":true,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":[],"requiredKeywords":[],"forbiddenPatterns":[],"sourceHash":"a70d2f61","exactHeadings":[],"forbidExtraHeadings":false,"requiredSubjects":[],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":[],"forbidFabrication":false,"requireEvidenceForQuantities":false,"preferProjectFacts":false,"chapterRules":[],"roleRules":[],"executionSummary":["已识别封面规则：禁止生成","已识别目录规则：禁止生成","已识别禁用词 11 个"],"ruleSources":{"coverPolicy":[{"promptId":"system:generation-control","roleId":"generation-control","pattern":"封面|cover","matchedText":"封面"}],"tocPolicy":[{"promptId":"system:generation-control","roleId":"generation-control","pattern":"目录|toc","matchedText":"目录"}]},"extractionTrace":[{"rule":"已识别封面规则：forbidden","source":{"promptId":"system:generation-control","roleId":"generation-control","pattern":"封面|cover"},"matchedText":"封面"},{"rule":"已识别目录规则：forbidden","source":{"promptId":"system:generation-control","roleId":"generation-control","pattern":"目录|toc"},"matchedText":"目录"}]}]);
    expect(r.includes("明确禁止输出封面")).toEqual(true);
    expect(r.includes("明确禁止输出目录")).toEqual(true);
  });
  it('固定章节+禁止新增', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"unspecified" as const,"tocPolicy":"unspecified" as const,"forbidCover":false,"forbidToc":false,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":[],"requiredKeywords":[],"forbiddenPatterns":[],"sourceHash":"7b9bcda6","exactHeadings":["施工方案"],"forbidExtraHeadings":true,"requiredSubjects":[],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":[],"forbidFabrication":false,"requireEvidenceForQuantities":false,"preferProjectFacts":false,"chapterRules":[],"roleRules":[],"executionSummary":["已识别一级章节固定规则 1 条","已识别禁用词 11 个"],"ruleSources":{"exactHeadings":[{"promptId":"system:generation-control","roleId":"generation-control","pattern":"第[一二三四五六七八九十百千\\d]+章","matchedText":"施工方案"}]},"extractionTrace":[{"rule":"固定章节：施工方案","source":{"promptId":"system:generation-control","roleId":"generation-control","pattern":"第[一二三四五六七八九十百千\\d]+章"},"matchedText":"施工方案"}]}]);
    expect(r.includes("一级章节必须严格使用")).toEqual(true);
    expect(r.includes("不得新增、删除、合并或改名")).toEqual(true);
  });
  it('我公司主体', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"unspecified" as const,"tocPolicy":"unspecified" as const,"forbidCover":false,"forbidToc":false,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":[],"requiredKeywords":[],"forbiddenPatterns":[],"sourceHash":"d4c84718","exactHeadings":[],"forbidExtraHeadings":false,"requiredSubjects":["我公司","项目部"],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":[],"forbidFabrication":false,"requireEvidenceForQuantities":false,"preferProjectFacts":false,"chapterRules":[],"roleRules":[],"executionSummary":["已识别禁用词 11 个"]}]);
    expect(r.includes("正文主体优先使用")).toEqual(true);
  });
  it('不得编造', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"unspecified" as const,"tocPolicy":"unspecified" as const,"forbidCover":false,"forbidToc":false,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":[],"requiredKeywords":[],"forbiddenPatterns":[],"sourceHash":"21066145","exactHeadings":[],"forbidExtraHeadings":false,"requiredSubjects":[],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":[],"forbidFabrication":true,"requireEvidenceForQuantities":false,"preferProjectFacts":false,"chapterRules":[],"roleRules":[],"executionSummary":["已识别禁用词 11 个"]}]);
    expect(r.includes("不得编造系统暂未")).toEqual(true);
  });
  it('量化参数', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"unspecified" as const,"tocPolicy":"unspecified" as const,"forbidCover":false,"forbidToc":false,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":[],"requiredKeywords":[],"forbiddenPatterns":[],"sourceHash":"a89251d6","exactHeadings":[],"forbidExtraHeadings":false,"requiredSubjects":[],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":[],"forbidFabrication":false,"requireEvidenceForQuantities":true,"preferProjectFacts":false,"chapterRules":[],"roleRules":[],"executionSummary":["已识别禁用词 11 个"]}]);
    expect(r.includes("必须以绑定资料中的明确事实为准")).toEqual(true);
  });
  it('商务敏感', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"unspecified" as const,"tocPolicy":"unspecified" as const,"forbidCover":false,"forbidToc":false,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段","报价明细表"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":[],"requiredKeywords":[],"forbiddenPatterns":[],"sourceHash":"527004e","exactHeadings":[],"forbidExtraHeadings":false,"requiredSubjects":[],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":["报价明细表"],"forbidFabrication":false,"requireEvidenceForQuantities":false,"preferProjectFacts":false,"chapterRules":[],"roleRules":[],"executionSummary":["已识别禁用词 12 个"]}]);
    expect(r.includes("禁止输出商务敏感内容")).toEqual(true);
  });
  it('后台话术', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"unspecified" as const,"tocPolicy":"unspecified" as const,"forbidCover":false,"forbidToc":false,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":[],"requiredKeywords":[],"forbiddenPatterns":[],"sourceHash":"811c9dc5","exactHeadings":[],"forbidExtraHeadings":false,"requiredSubjects":[],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":[],"forbidFabrication":false,"requireEvidenceForQuantities":false,"preferProjectFacts":false,"chapterRules":[],"roleRules":[],"executionSummary":["已识别禁用词 11 个"]}]);
    expect(r.includes("禁止输出系统内部话术")).toEqual(true);
  });
  it('表格+关键词+禁词+字数', () => {
    const r = runtimePromptRulesPrompt(...[{"coverPolicy":"unspecified" as const,"tocPolicy":"unspecified" as const,"forbidCover":false,"forbidToc":false,"forbiddenTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"preferredTerms":[{"from":"高度重视","to":"严格落实"},{"from":"重中之重","to":"关键控制事项"}],"requiredTables":["项目基本信息表"],"requiredKeywords":["BIM"],"forbiddenPatterns":["空话"],"sourceHash":"18886fa9","exactHeadings":[],"forbidExtraHeadings":false,"requiredSubjects":[],"forbiddenSubjects":[],"backendTerms":["知识库","提示词","建议补充","资料库","OCR","后台话术","后台流程","后台数据","后台资料","后台溯源","绑定片段"],"commercialTerms":[],"forbidFabrication":false,"requireEvidenceForQuantities":false,"preferProjectFacts":false,"minWords":10000,"minChars":10000,"chapterRules":[],"roleRules":[],"executionSummary":["已识别禁用词 11 个","已识别必需表格：项目基本信息表","已识别必含关键词：BIM","已识别禁止出现内容：空话","已识别最低字数要求：10000 字"],"ruleSources":{"requiredTables":[{"promptId":"system:generation-control","roleId":"generation-control","pattern":"全文必须输出|必须输出表格|项目基本信息表","matchedText":"项目基本信息表"}],"requiredKeywords":[{"promptId":"system:generation-control","roleId":"generation-control","pattern":"必须包含|必须含|应包含|需要包含","matchedText":"BIM"}],"forbiddenPatterns":[{"promptId":"system:generation-control","roleId":"generation-control","pattern":"禁止|不得|严禁|杜绝","matchedText":"空话"}],"minWords":[{"promptId":"system:generation-control","roleId":"generation-control","pattern":"\\d{3,}\\s*字","matchedText":"10000"}]},"extractionTrace":[{"rule":"必需表格：项目基本信息表","source":{"promptId":"system:generation-control","roleId":"generation-control","pattern":"全文必须输出|必须输出表格|项目基本信息表"},"matchedText":"项目基本信息表"},{"rule":"必含关键词：BIM","source":{"promptId":"system:generation-control","roleId":"generation-control","pattern":"必须包含|必须含|应包含|需要包含"},"matchedText":"BIM"},{"rule":"禁止内容：空话","source":{"promptId":"system:generation-control","roleId":"generation-control","pattern":"禁止|不得|严禁|杜绝"},"matchedText":"空话"},{"rule":"最低字数：10000","source":{"promptId":"system:generation-control","roleId":"generation-control","pattern":"\\d{3,}\\s*字"},"matchedText":"10000"}]}]);
    expect(r.includes("必须输出以下正式 Markdown 表格")).toEqual(true);
    expect(r.includes("正文必须覆盖以下关键词")).toEqual(true);
    expect(r.includes("正文禁止出现以下内容")).toEqual(true);
    expect(r.includes("全文不少于 10000 字")).toEqual(true);
  });
});
describe('previewPromptRules', () => {
  it('空内容', () => {
    const r = previewPromptRules(...[""]);
    expect(r.recognized).toEqual(true);
    expect(r.summary).toEqual(["已识别禁用词 11 个"]);
  });
  it('有规则', () => {
    const r = previewPromptRules(...["必须输出封面；全文不少于1万字"]);
    expect(r.recognized).toEqual(true);
    expect(r.coverPolicy).toEqual("required");
    expect(r.minWords).toEqual(10000);
  });
  it('目录规则', () => {
    const r = previewPromptRules(...["不需要目录"]);
    expect(r.tocPolicy).toEqual("forbidden");
  });
  it('表格+关键词', () => {
    const r = previewPromptRules(...["全文必须输出：项目基本信息表；必须包含以下关键词：BIM"]);
    expect(r.requiredTables).toEqual(["项目基本信息表"]);
    expect(r.requiredKeywords).toEqual(["BIM"]);
  });
  it('禁词', () => {
    const r = previewPromptRules(...["禁止出现以下词语：空话"]);
    expect(r.forbiddenPatterns).toEqual(["空话"]);
  });
  it('章节', () => {
    const r = previewPromptRules(...["<OUTLINE>\n1.施工方案\n</OUTLINE>"]);
    expect(r.exactHeadings).toEqual(["施工方案"]);
  });
});
describe('detectPromptRuleConflicts', () => {
  it('空数组', () => {
    const r = detectPromptRuleConflicts(...[[]]);
    expect(r.length).toEqual(0);
  });
  it('单提示词', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"主控","roleId":"r1","content":"必须输出封面"}]]);
    expect(r.length).toEqual(0);
  });
  it('无规则提示词', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"a","roleId":"r1","content":"普通内容"},{"promptId":"p2","name":"b","roleId":"r2","content":"普通内容"}]]);
    expect(r.length).toEqual(0);
  });
  it('必含 vs 禁词冲突', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"主控","roleId":"r1","content":"必须包含关键词：BIM"},{"promptId":"p2","name":"质检","roleId":"r2","content":"禁止出现词语：BIM"}]]);
    expect(r.length).toEqual(1);
    expect(r[0]?.message).toEqual("「BIM」被要求必含（主控(r1)）但被禁止（质检(r2)：BIM）");
  });
  it('双向冲突', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"a","roleId":"r1","content":"必须包含关键词：BIM、智慧工地"},{"promptId":"p2","name":"b","roleId":"r2","content":"禁止出现词语：BIM、智慧工地"}]]);
    expect(r.length).toEqual(2);
    expect(r[1]?.message).toEqual("「智慧工地」被要求必含（a(r1)）但被禁止（b(r2)：智慧工地）");
  });
  it('章节列表不一致', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"a","roleId":"r1","content":"<OUTLINE>\n1.施工方案\n2.质量保证\n</OUTLINE>"},{"promptId":"p2","name":"b","roleId":"r2","content":"<OUTLINE>\n1.施工方案\n2.安全生产\n</OUTLINE>"}]]);
    expect(r.map(i=>i.message)).toEqual(["固定一级章节列表不一致：a(r1) 要求 2 章，b(r2) 要求 2 章（差异：质量保证、安全生产）。生成时将合并去重。"]);
  });
  it('封面策略冲突', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"a","roleId":"r1","content":"必须输出封面"},{"promptId":"p2","name":"b","roleId":"r2","content":"不得输出封面"}]]);
    expect(r.map(i=>i.message)).toEqual(["封面策略冲突：a(r1) 要求「生成」，b(r2) 要求「禁止」。生成时以禁止优先。"]);
  });
  it('目录策略冲突', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"a","roleId":"r1","content":"必须输出目录"},{"promptId":"p2","name":"b","roleId":"r2","content":"不需要目录"}]]);
    expect(r.map(i=>i.message)).toEqual(["目录策略冲突：a(r1) 要求「生成」，b(r2) 要求「禁止」。生成时以禁止优先。"]);
  });
  it('字数冲突', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"a","roleId":"r1","content":"全文不少于2万字"},{"promptId":"p2","name":"b","roleId":"r2","content":"全文不少于1万字"}]]);
    expect(r.map(i=>i.message)).toEqual(["最低字数要求不一致：a(r1) 20000 字 vs b(r2) 10000 字。生成时将取最大值 20000 字。"]);
  });
  it('多冲突组合', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"a","roleId":"r1","content":"必须输出封面；必须包含关键词：BIM；全文不少于2万字；<OUTLINE>\n1.施工方案\n</OUTLINE>"},{"promptId":"p2","name":"b","roleId":"r2","content":"不得输出封面；禁止出现词语：BIM；全文不少于1万字；<OUTLINE>\n1.安全生产\n</OUTLINE>"}]]);
    expect(r.length).toEqual(4);
    expect(r.map(i=>i.message)).toEqual(["「BIM」被要求必含（a(r1)）但被禁止（b(r2)：BIM）","固定一级章节列表不一致：a(r1) 要求 1 章，b(r2) 要求 1 章（差异：施工方案、安全生产）。生成时将合并去重。","封面策略冲突：a(r1) 要求「生成」，b(r2) 要求「禁止」。生成时以禁止优先。","最低字数要求不一致：a(r1) 20000 字 vs b(r2) 10000 字。生成时将取最大值 20000 字。"]);
  });
  it('相同规则无冲突', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"a","roleId":"r1","content":"必须输出封面"},{"promptId":"p2","name":"b","roleId":"r2","content":"必须输出封面"}]]);
    expect(r.length).toEqual(0);
  });
  it('单方规则无冲突', () => {
    const r = detectPromptRuleConflicts(...[[{"promptId":"p1","name":"a","roleId":"r1","content":"必须输出封面"},{"promptId":"p2","name":"b","roleId":"r2","content":"普通内容"}]]);
    expect(r.length).toEqual(0);
  });
});
describe('professionalSectionTaskCard', () => {
  it('项目主要施工内容', () => {
    const r = professionalSectionTaskCard(...["项目主要施工内容","土建工程"]);
    expect(r.includes("工作包")).toEqual(true);
    expect(r.includes("清单计价表内部口径词")).toEqual(true);
    expect(r.length > 100).toEqual(true);
  });
  it('劳动力+资源配置', () => {
    const r = professionalSectionTaskCard(...["劳动力安排计划","资源配置计划"]);
    expect(r.includes("只写劳动力资源")).toEqual(true);
    expect(r.includes("工种结构与人数")).toEqual(true);
  });
  it('工程特点', () => {
    const r = professionalSectionTaskCard(...["工程特点分析","重难点分析"]);
    expect(r.includes("形成原因")).toEqual(true);
    expect(r.includes("重难点识别表")).toEqual(true);
  });
  it('概况', () => {
    const r = professionalSectionTaskCard(...["工程概况","项目概况"]);
    expect(r.includes("编制边界")).toEqual(true);
  });
  it('部署', () => {
    const r = professionalSectionTaskCard(...["施工部署","总体安排"]);
    expect(r.includes("施工组织逻辑")).toEqual(true);
  });
  it('进度', () => {
    const r = professionalSectionTaskCard(...["进度计划","进度安排"]);
    expect(r.includes("关键线路")).toEqual(true);
  });
  it('质量', () => {
    const r = professionalSectionTaskCard(...["质量保证措施","质量控制"]);
    expect(r.includes("材料验收复验")).toEqual(true);
  });
  it('安全', () => {
    const r = professionalSectionTaskCard(...["安全文明施工","安全管理"]);
    expect(r.includes("临电消防")).toEqual(true);
  });
  it('资源', () => {
    const r = professionalSectionTaskCard(...["资源配置","材料管理"]);
    expect(r.includes("进场验收")).toEqual(true);
  });
  it('劳务/工资合规（R9 写入侧：工伤保险+农民工工资支付）', () => {
    const r = professionalSectionTaskCard(...["劳动力安排计划","劳动力工资支付与稳定措施"]);
    expect(r.includes("办理工伤保险")).toEqual(true);
    expect(r.includes("专用账户与总包代发")).toEqual(true);
  });
  it('施工', () => {
    const r = professionalSectionTaskCard(...["施工方案","主体结构施工"]);
    expect(r.includes("4 个工艺参数")).toEqual(true);
    expect(r.includes("工序顺序表达")).toEqual(true);
  });
  it('流程', () => {
    const r = professionalSectionTaskCard(...["施工流程","工序安排"]);
    expect(r.includes("不少于 3 个环节")).toEqual(true);
  });
  it('无命中默认', () => {
    const r = professionalSectionTaskCard(...["其他章节","其他小节"]);
    expect(r.includes("避免泛化套话")).toEqual(true);
    expect(r.includes("工序顺序表达")).toEqual(false);
  });
  it('多命中组合', () => {
    const r = professionalSectionTaskCard(...["施工方案","质量控制"]);
    expect(r.includes("4 个工艺参数")).toEqual(true);
    expect(r.includes("材料验收复验")).toEqual(true);
  });
  it('禁止套话段', () => {
    const r = professionalSectionTaskCard(...["任意章","任意节"]);
    expect(r.includes("禁止套话")).toEqual(true);
    expect(r.includes("信息载体")).toEqual(true);
  });
});
