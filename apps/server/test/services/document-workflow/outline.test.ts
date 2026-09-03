import { describe, expect, it } from 'vitest';
import {
  displayChapterTitle,
  effectiveTemplateChapters,
  extractExplicitOutlineFromSources,
  formalChapterTitle,
  hasExplicitOutlineBlock,
  isExplicitOutlineClosingLine,
  isExplicitOutlineOpeningLine,
  isTenderClauseFragmentTitle,
  isValidGeneratedChapterTitle,
  normalizeGeneratedChapterTitle,
  uniqueTemplateChapters,
} from '@/services/document-workflow/outline';
import type { AutoDocumentSpecPackage } from '@/services/document-core/autoDocumentSpecTypes';
import type { DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';

const chapter = (id: string, title: string, sections: string[] = []): DocumentTemplateChapter => ({ id, title, purpose: '', queries: [], requiredFacts: [], sections });

describe('isTenderClauseFragmentTitle（招标条款碎片判别）', () => {
  it('条件从句碎片命中', () => {
    expect(isTenderClauseFragmentTitle('如我方中标，我方承诺响应')).toBe(true);
  });

  it('承诺断言碎片命中', () => {
    expect(isTenderClauseFragmentTitle('我方承诺按招标文件要求执行')).toBe(true);
  });

  it('评标委员会动作碎片命中', () => {
    expect(isTenderClauseFragmentTitle('委员会确定中标候选人')).toBe(true);
  });

  it('条款编号残留命中', () => {
    expect(isTenderClauseFragmentTitle('3项规定')).toBe(true);
    expect(isTenderClauseFragmentTitle('56m15：内容')).toBe(true);
    expect(isTenderClauseFragmentTitle('4对与评标活动有关的事宜')).toBe(true);
  });

  it('带百分比条款命中', () => {
    expect(isTenderClauseFragmentTitle('偏差率不超过5%')).toBe(true);
  });

  it('兜底短语命中', () => {
    expect(isTenderClauseFragmentTitle('其他要求')).toBe(true);
    expect(isTenderClauseFragmentTitle('需要补充的其他内容')).toBe(true);
  });

  it('数字+时间单位+逗号碎片命中（真实生成回归：「00天，计划完成时间：」）', () => {
    expect(isTenderClauseFragmentTitle('00天，计划完成时间：')).toBe(true);
    expect(isTenderClauseFragmentTitle('30日历天、计划完成时间')).toBe(true);
    expect(isTenderClauseFragmentTitle('2个月完成主体结构')).toBe(false);
  });

  it('数字+参数列表碎片命中（真实生成回归：「5厘米，其余均为2.0厘米」目录畸形条目）', () => {
    expect(isTenderClauseFragmentTitle('5厘米，其余均为2.0厘米')).toBe(true);
  });

  it('数字粘连名词碎片命中（真实生成回归：「1人员及职责」等目录畸形条目）', () => {
    expect(isTenderClauseFragmentTitle('1人员及职责')).toBe(true);
    expect(isTenderClauseFragmentTitle('2同招标公告发布媒介')).toBe(true);
    expect(isTenderClauseFragmentTitle('1分为分割')).toBe(true);
    // 量词开头合法标题不误伤
    expect(isTenderClauseFragmentTitle('2个月完成主体结构')).toBe(false);
    expect(isTenderClauseFragmentTitle('1层地下室结构施工')).toBe(false);
  });

  it('截断句碎片命中（真实生成回归：标题以未闭合书名号结尾）', () => {
    expect(isTenderClauseFragmentTitle('本招标项目公共建筑根据《民用建筑设计统一标准》（')).toBe(true);
  });

  it('括号悬置碎片命中（4.12.12：左括号后残留「以下简」但非行尾）', () => {
    expect(isTenderClauseFragmentTitle('1发包人委派的发包人代表或监理工程师（以下简')).toBe(true);
    expect(isTenderClauseFragmentTitle('本工程监理单位（以下简称监理人')).toBe(true);
  });

  it('简称句式截断碎片命中（4.12.12：「以下简」残留）', () => {
    expect(isTenderClauseFragmentTitle('（以下简称招标人）委托')).toBe(true);
    expect(isTenderClauseFragmentTitle('以下简称为甲方')).toBe(true);
  });

  it('数字+单位参数碎片命中（4.12.12：PDF 参数列粘连）', () => {
    expect(isTenderClauseFragmentTitle('65m18245.65m），（')).toBe(true);
    expect(isTenderClauseFragmentTitle('12层，建筑高度48.6m')).toBe(true);
  });

  it('评标程序动作碎片命中（4.12.12：「确定评标价」类）', () => {
    expect(isTenderClauseFragmentTitle('确定评标价')).toBe(true);
    expect(isTenderClauseFragmentTitle('确定有效评标价')).toBe(true);
    expect(isTenderClauseFragmentTitle('确定评标基准价')).toBe(true);
    expect(isTenderClauseFragmentTitle('计算评标基准价')).toBe(true);
    expect(isTenderClauseFragmentTitle('确定施工部署')).toBe(false);
  });

  it('补充条款类兜底短语命中（真实生成回归：模板静态 sections 混入「补充条款」）', () => {
    expect(isTenderClauseFragmentTitle('补充条款')).toBe(true);
    expect(isTenderClauseFragmentTitle('建议编制要求如下')).toBe(true);
    expect(isTenderClauseFragmentTitle('投标须知')).toBe(true);
  });

  it('条款编号「数字+款」碎片命中（4.12.14 真实生成回归：目录混入「4款、第5.3款…向招标人提出」）', () => {
    expect(isTenderClauseFragmentTitle('4款、第5.3款和第6.5款的规定先向招标人提出')).toBe(true);
    expect(isTenderClauseFragmentTitle('第5.3款的规定先向招标人提出')).toBe(true);
    expect(isTenderClauseFragmentTitle('12款对评标活动有异议的应当先向招标人提出')).toBe(true);
  });

  it('乱码标题命中（4.12.14 用户自跑资料回归：二进制误读文本混入目录）', () => {
    expect(isTenderClauseFragmentTitle('考堂f肀')).toBe(true);
    expect(isTenderClauseFragmentTitle('渱潑喲W晀耀')).toBe(true);
    expect(isTenderClauseFragmentTitle('VdA«UdA«UdANÒg')).toBe(true);
    expect(isTenderClauseFragmentTitle('爀攀最椀猀琀礀开氀漀挀')).toBe(true);
  });

  it('工程符号与字母编号标题不误杀（K值/型钢/混凝土强度等合法形态）', () => {
    expect(isTenderClauseFragmentTitle('节能门窗K值控制')).toBe(false);
    expect(isTenderClauseFragmentTitle('H型钢梁吊装方案')).toBe(false);
    expect(isTenderClauseFragmentTitle('C30混凝土浇筑方案')).toBe(false);
    expect(isTenderClauseFragmentTitle('钢筋HRB400进场验收')).toBe(false);
    expect(isTenderClauseFragmentTitle('传热系数K值')).toBe(false);
  });

  it('正常章节标题不命中', () => {
    expect(isTenderClauseFragmentTitle('工程概况')).toBe(false);
    expect(isTenderClauseFragmentTitle('施工部署与施工流水组织')).toBe(false);
  });

  it('空标题视为碎片', () => {
    expect(isTenderClauseFragmentTitle('')).toBe(true);
  });

  it('1.4 形态 A：资格条款义务句式命中（实锤 6.6/6.7 资格条款混入目录）', () => {
    expect(isTenderClauseFragmentTitle('具备有效的营业执照')).toBe(true);
    expect(isTenderClauseFragmentTitle('6.6 具备有效的营业执照')).toBe(true);
    expect(isTenderClauseFragmentTitle('6.7 具备有效的资质证书、具备有效的安全生产许可证')).toBe(true);
    // 词表外证照（isQualificationSectionTitle 词面黑名单覆盖不到）同样被句式拦截
    expect(isTenderClauseFragmentTitle('具备有效的食品经营许可证')).toBe(true);
    expect(isTenderClauseFragmentTitle('须提供财务状况证明文件')).toBe(true);
    expect(isTenderClauseFragmentTitle('提供银行资信证明材料')).toBe(true);
  });

  it('1.4 形态 A：合法施组标题不被资格句式误杀', () => {
    expect(isTenderClauseFragmentTitle('施工部署与施工流水组织')).toBe(false);
    expect(isTenderClauseFragmentTitle('起重机械配置与垂直运输方案')).toBe(false);
    expect(isTenderClauseFragmentTitle('具备条件的先行施工区段安排')).toBe(false);
  });

  it('4.17.2 条款义务陈述句命中（庐江实测：「本招标项目经理不得同时兼任…」招标附表条款截断混入目录）', () => {
    expect(isTenderClauseFragmentTitle('本招标项目经理不得同时兼任本招标项目技术负责')).toBe(true);
    expect(isTenderClauseFragmentTitle('投标人不得以他人名义投标')).toBe(true);
    expect(isTenderClauseFragmentTitle('承包人必须投保建筑工程一切险')).toBe(true);
    expect(isTenderClauseFragmentTitle('项目经理不得同时兼任两个项目')).toBe(true);
  });

  it('4.17.2 条款指向句命中（庐江实测：「项目经理业绩具体要求见招标公告」混入目录）', () => {
    expect(isTenderClauseFragmentTitle('项目经理业绩具体要求见招标公告')).toBe(true);
    expect(isTenderClauseFragmentTitle('投标保证金缴纳详见招标文件')).toBe(true);
    expect(isTenderClauseFragmentTitle('资格评审标准详见投标人须知前附表')).toBe(true);
    // 合法小节标题不以“见××”结尾
    expect(isTenderClauseFragmentTitle('招标公告发布的媒介要求')).toBe(false);
  });

  it('4.17.2 数字+短串+顿号碎片命中（庐江实测：「4示媒介、期限」——「4. 公示媒介、期限」"公"字丢失）', () => {
    expect(isTenderClauseFragmentTitle('4示媒介、期限')).toBe(true);
    expect(isTenderClauseFragmentTitle('4.3 4示媒介、期限')).toBe(true);
    // 顿号前是合法短标题时不得误伤
    expect(isTenderClauseFragmentTitle('塔吊、人货电梯等垂直运输设备布置')).toBe(false);
  });

  it('4.17.2 多级编号合法标题不误伤（庐江实测：「1.2 质量管理体系」被残留二级编号误判为数字粘连碎片）', () => {
    expect(isTenderClauseFragmentTitle('1.2 质量管理体系')).toBe(false);
    expect(isTenderClauseFragmentTitle('2.3 资源配置计划')).toBe(false);
    expect(isTenderClauseFragmentTitle('2.3.1 测量放线')).toBe(false);
    expect(isTenderClauseFragmentTitle('4.2 质量管理体系与质量保证措施')).toBe(false);
    // 多级编号条款残留仍被拦截（编号后无分隔符/空白，不进剥离分支）
    expect(isTenderClauseFragmentTitle('3项规定')).toBe(true);
  });
});

describe('显式大纲块识别', () => {
  it('hasExplicitOutlineBlock 识别 OUTLINE/章节大纲 标签', () => {
    expect(hasExplicitOutlineBlock('<OUTLINE>\n第一章 工程概况\n</OUTLINE>')).toBe(true);
    expect(hasExplicitOutlineBlock('<章节大纲>\n工程概况\n</章节大纲>')).toBe(true);
    expect(hasExplicitOutlineBlock('普通正文无大纲。')).toBe(false);
  });

  it('isExplicitOutlineOpeningLine / ClosingLine', () => {
    expect(isExplicitOutlineOpeningLine('<OUTLINE>')).toBe(true);
    expect(isExplicitOutlineOpeningLine('<大纲>')).toBe(true);
    expect(isExplicitOutlineOpeningLine('正文')).toBe(false);
    expect(isExplicitOutlineClosingLine('</OUTLINE>')).toBe(true);
    expect(isExplicitOutlineClosingLine('</大纲>')).toBe(true);
  });
});

describe('extractExplicitOutlineFromSources（显式大纲提取）', () => {
  it('从 OUTLINE 块提取章节标题', () => {
    const chapters = extractExplicitOutlineFromSources([{ text: '<OUTLINE>\n第一章 工程概况\n第二章 施工部署\n</OUTLINE>', source: 's1' }]);
    expect(chapters.map(item => item.title)).toEqual(['工程概况', '施工部署']);
    expect(chapters[0].id).toContain('s1');
  });

  it('宽松格式（大纲：…END）提取', () => {
    const chapters = extractExplicitOutlineFromSources([{ text: '大纲：\n工程概况\n施工部署', source: 's2' }]);
    expect(chapters.map(item => item.title)).toEqual(['工程概况', '施工部署']);
  });

  it('章节不足 2 个返回空', () => {
    expect(extractExplicitOutlineFromSources([{ text: '<OUTLINE>\n第一章 工程概况\n</OUTLINE>', source: 's3' }])).toHaveLength(0);
  });

  it('无大纲返回空', () => {
    expect(extractExplicitOutlineFromSources([{ text: '普通正文。', source: 's4' }])).toHaveLength(0);
  });

  it('条款碎片标题被过滤', () => {
    const chapters = extractExplicitOutlineFromSources([{ text: '<OUTLINE>\n第一章 工程概况\n第二章 如我方中标，我方承诺\n第三章 施工部署\n</OUTLINE>', source: 's5' }]);
    expect(chapters.map(item => item.title)).toEqual(['工程概况', '施工部署']);
  });
});

describe('displayChapterTitle / normalizeGeneratedChapterTitle（标题规范化）', () => {
  it('剥离章节序号与编号前缀', () => {
    expect(displayChapterTitle('第一章 工程概况')).toBe('工程概况');
    expect(displayChapterTitle('1.1 编制依据')).toBe('编制依据');
    expect(displayChapterTitle('（一）施工部署')).toBe('施工部署');
    expect(displayChapterTitle('### 施工部署')).toBe('施工部署');
  });

  it('normalizeGeneratedChapterTitle 合并空白并剥标点', () => {
    expect(normalizeGeneratedChapterTitle('第一章  工程概况 ')).toBe('工程概况');
    expect(normalizeGeneratedChapterTitle('、工程概况')).toBe('工程概况');
  });
});

describe('isValidGeneratedChapterTitle（生成标题合法性）', () => {
  it('正常标题通过', () => {
    expect(isValidGeneratedChapterTitle('工程概况')).toBe(true);
    expect(isValidGeneratedChapterTitle('主要分部分项工程施工方案')).toBe(true);
  });

  it('过短/过长/空标题拒绝', () => {
    expect(isValidGeneratedChapterTitle('')).toBe(false);
    expect(isValidGeneratedChapterTitle('A')).toBe(false);
    expect(isValidGeneratedChapterTitle('很'.repeat(51))).toBe(false);
  });

  it('标题符号/表格/占位符拒绝', () => {
    expect(isValidGeneratedChapterTitle('### 工程概况')).toBe(false);
    expect(isValidGeneratedChapterTitle('| 表格标题 |')).toBe(false);
    expect(isValidGeneratedChapterTitle('。工程概况')).toBe(false);
    expect(isValidGeneratedChapterTitle('{变量} 概况')).toBe(false);
    expect(isValidGeneratedChapterTitle('工程概况。')).toBe(false);
  });

  it('指令式与保留词标题拒绝', () => {
    expect(isValidGeneratedChapterTitle('目录')).toBe(false);
    expect(isValidGeneratedChapterTitle('说明')).toBe(false);
    expect(isValidGeneratedChapterTitle('按需生成')).toBe(false);
  });

  it('污染标题拒绝', () => {
    expect(isValidGeneratedChapterTitle('详见资料说明')).toBe(false);
    expect(isValidGeneratedChapterTitle('完全满足评审要求')).toBe(false);
  });
});

describe('formalChapterTitle（正式章节编号）', () => {
  it('按索引生成第X章标题', () => {
    expect(formalChapterTitle(0, '工程概况')).toBe('第一章 工程概况');
    expect(formalChapterTitle(9, '工程概况')).toBe('第十章 工程概况');
    expect(formalChapterTitle(10, '工程概况')).toBe('第十一章 工程概况');
    expect(formalChapterTitle(19, '工程概况')).toBe('第二十章 工程概况');
    expect(formalChapterTitle(20, '工程概况')).toBe('第二十一章 工程概况');
  });
});

describe('uniqueTemplateChapters（模板章节去重）', () => {
  it('同名章节去重并规范化标题', () => {
    const chapters = [chapter('c1', '第一章 工程概况'), chapter('c2', '工程概况')];
    const result = uniqueTemplateChapters(chapters.map(item => ({ ...item })));
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('工程概况');
  });

  it('污染标题被过滤', () => {
    const chapters = [chapter('c1', '工程概况'), chapter('c2', '见资料说明')];
    const result = uniqueTemplateChapters(chapters.map(item => ({ ...item })));
    expect(result.map(item => item.title)).toEqual(['工程概况']);
  });

  it('preserveExplicitOutline 保留重复标题', () => {
    const chapters = [chapter('c1', '工程概况'), chapter('c2', '工程概况')];
    const result = uniqueTemplateChapters(chapters.map(item => ({ ...item })), { preserveExplicitOutline: true });
    expect(result).toHaveLength(2);
  });
});

describe('effectiveTemplateChapters（有效章节计算）', () => {
  const template = (chapters: DocumentTemplateChapter[]): DocumentTemplate => ({ id: 't1', name: '施工组织设计', outputTitle: '', description: '', category: '', chapters });

  it('无 spec 时仅做去重规范化', () => {
    const result = effectiveTemplateChapters(template([chapter('c1', '第一章 工程概况'), chapter('c2', '工程概况')]));
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('工程概况');
  });

  it('有 spec 时注入 generationHint 到 queries', () => {
    const spec: AutoDocumentSpecPackage = {
      id: 's1', name: '施工组织设计', description: '', factFields: [], chapterMode: 'fixed',
      chapterRules: [{ id: 'c1', title: '工程概况', required: true, order: 1, generationHint: '必须写清建设规模' }],
      dynamicChapterRule: { source: 'fact_group' }, gateRules: [],
    };
    const result = effectiveTemplateChapters(template([chapter('c1', '工程概况')]), spec);
    expect(result[0].queries).toContain('必须写清建设规模');
    expect(result[0].queries).toContain('工程概况');
  });
});
