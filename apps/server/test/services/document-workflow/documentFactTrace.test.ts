import { describe, expect, it } from 'vitest';
import { boqDivisionCoverageIssues, boqRowTraceIssues, buildBoqRowTraces, buildDocumentFactTraces, buildNumericTraceFindings, classifyNumericTraceToken, cleanFactValue, demoteUnsourcedNumericTokens, enforceBoqDivisionCoverageInMethodChapters, extractBoqDivisionCoverage, factTraceIssues, formatBoqDivisionCoverage, isActionableFactValue, isActionableTraceFact, isSectionNumberingToken, isSpecGluedValueToken, numericTraceabilityIssues, scanNumericTrace } from '@/services/document-workflow/documentFactTrace';
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel } from '@/services/document-workflow/types';

function factsModel(project: DocumentFact[] = [], preciseFacts: DocumentFact[] = [], tables: DocumentFactsModel['tables'] = []): DocumentFactsModel {
  return {
    project,
    schedule: [],
    quality: [],
    safety: [],
    resources: [],
    preciseFacts,
    bills: [],
    drawings: [],
    rules: [],
    specifications: [],
    tables,
    schemaFacts: {},
    factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] },
    missing: [],
    conflicts: [],
  };
}

const fact = (fieldName: string, value: string, sourceFile = '招标文件.pdf'): DocumentFact => ({ fieldId: 'f1', fieldName, key: fieldName, value, sourceFile, roleId: '', confidence: 1 });

describe('cleanFactValue（表格尾巴/条款尾巴/分隔残留清洗）', () => {
  it('表格行尾巴 | | | 去除', () => {
    expect(cleanFactValue('室外道排工程 | | | | |')).toBe('室外道排工程');
  });

  it('条款尾巴「4．未尽事宜详见…」去除', () => {
    expect(cleanFactValue('胶圈接口 4．未尽事宜详见施工图纸、补遗')).toBe('胶圈接口');
  });

  it('尾部顿号/逗号残留去除', () => {
    expect(cleanFactValue('本项目维修改造包含室内装饰工程、门窗维修、屋面维修、')).toBe('本项目维修改造包含室内装饰工程、门窗维修、屋面维修');
  });

  it('值中间混入孤立管道时取首段', () => {
    expect(cleanFactValue('室外道排工程 | 金额(元)')).toBe('室外道排工程');
  });

  it('无噪音值原样保留（仅 trim）', () => {
    expect(cleanFactValue(' 计划工期540日历天 ')).toBe('计划工期540日历天');
  });
});

describe('isActionableFactValue（指向值/标题行/噪音排除）', () => {
  it('「见/详见/按…招标文件」类指向值排除', () => {
    expect(isActionableFactValue('见招标文件专用条款')).toBe(false);
    expect(isActionableFactValue('详见招标公告前附表')).toBe(false);
    expect(isActionableFactValue('质量标准：见招标公告')).toBe(false);
  });

  it('「见XXX招标范围/补疑/答疑」排除', () => {
    expect(isActionableFactValue('见本项目招标补疑中的招标范围')).toBe(false);
  });

  it('纯文件名词（合同协议书/招标文件等）排除', () => {
    expect(isActionableFactValue('合同协议书')).toBe(false);
    expect(isActionableFactValue('投标人须知前附表')).toBe(false);
  });

  it('纯标签名（工程名称/项目名称等）排除', () => {
    expect(isActionableFactValue('工程名称')).toBe(false);
    expect(isActionableFactValue('计划工期')).toBe(false);
  });

  it('含竖线残留噪音排除', () => {
    expect(isActionableFactValue('| 金额(元) |')).toBe(false);
  });

  it('标题+正文混合残留排除', () => {
    expect(isActionableFactValue('一、工程概况：本项目分为1个标段')).toBe(false);
  });

  it('过短无数字值排除；短数字值保留', () => {
    expect(isActionableFactValue('啊')).toBe(false);
    expect(isActionableFactValue('5人')).toBe(true);
  });

  it('正常实质值保留', () => {
    expect(isActionableFactValue('计划工期540日历天')).toBe(true);
    expect(isActionableFactValue('确保黄山杯')).toBe(true);
  });
});

describe('buildDocumentFactTraces（事实落位追踪）', () => {
  it('全值命中判定 used，未命中判定 unplaced', () => {
    const model = factsModel(
      [
        fact('项目名称', '合肥师范学院实训基地'),
        fact('建设规模', '总建筑面积28570平方米'),
      ],
    );
    const traces = buildDocumentFactTraces('本项目为合肥师范学院实训基地，总建筑面积28570平方米。', model);
    expect(traces).toHaveLength(2);
    expect(traces.every(t => t.status === 'used')).toBe(true);
  });

  it('条款列表拆分片段命中即 used（至少 2 片段）', () => {
    const model = factsModel([fact('招标范围', '1、室内装饰工程；2、门窗维修；3、屋面维修')]);
    const traces = buildDocumentFactTraces('本项目包含门窗维修与屋面维修。', model);
    expect(traces[0].status).toBe('used');
  });

  it('核心词组成词落位（工程尾缀剥离）', () => {
    const model = factsModel([fact('招标范围', '室外道排工程、外墙屋面工程')]);
    const traces = buildDocumentFactTraces('室外道排与外墙屋面均纳入维修范围。', model);
    expect(traces[0].status).toBe('used');
  });

  it('数字参数命中（数字+单位）', () => {
    const model = factsModel([fact('计划工期', '540日历天')]);
    const traces = buildDocumentFactTraces('本工程总工期为540日历天。', model);
    expect(traces[0].status).toBe('used');
  });

  it('同 label+value 去重', () => {
    const model = factsModel([
      fact('质量标准', '确保黄山杯', '招标文件.pdf'),
      { ...fact('质量标准', '确保黄山杯', '招标文件.pdf'), fieldId: 'f2' },
    ]);
    const traces = buildDocumentFactTraces('', model);
    expect(traces).toHaveLength(1);
  });
});

describe('factTraceIssues（未落位事实告警）', () => {
  it('unplaced 且可执行的事实进入告警，指向值/技术参数不进入', () => {
    const issues = factTraceIssues([
      { label: '计划工期', value: '540日历天', status: 'unplaced', confidence: 1 },
      { label: '技术参数', value: '010101001001', status: 'unplaced', confidence: 1 },
      { label: '质量标准', value: '见招标文件', status: 'unplaced', confidence: 1 },
      { label: '质量标准', value: '确保黄山杯', status: 'used', confidence: 1 },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('warning');
    expect(issues[0].message).toContain('540日历天');
  });

  it('maxIssues 限制条数并给出总数提示', () => {
    const traces = Array.from({ length: 5 }, (_, index) => ({ label: '工期', value: `${index + 1}00日历天`, status: 'unplaced' as const, confidence: 1 }));
    const issues = factTraceIssues(traces, { maxIssues: 2 });
    expect(issues).toHaveLength(2);
    expect(issues[0].suggestion).toContain('共5个未落位事实');
  });
});

describe('buildBoqRowTraces / boqRowTraceIssues（BOQ 行级落位）', () => {
  const model = factsModel([], [], [{
    tableType: '清单',
    headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
    rows: [
      ['1', '010101001001', '平整场地', '1200', 'm2'],
      ['2', '010101003001', '挖一般土方', '5600', 'm3'],
      ['3', '010502001001', '现浇混凝土柱', '320', 'm3'],
    ],
    sourceFile: '清单.xlsx',
  }]);

  it('名称/编码字面命中正文判定 placed，未落位排前', () => {
    const traces = buildBoqRowTraces('主要工序包括平整场地与挖一般土方。', model);
    expect(traces).toHaveLength(3);
    expect(traces.filter(t => t.placed)).toHaveLength(2);
    // 未落位排前
    expect(traces[0].placed).toBe(false);
  });

  it('无名称无编码的行跳过', () => {
    const model2 = factsModel([], [], [{ tableType: '清单', headers: ['单位', '数量'], rows: [['m2', '5']], sourceFile: '清单.xlsx' }]);
    expect(buildBoqRowTraces('', model2)).toHaveLength(0);
  });

  it('落位率 <0.3 报严重不足', () => {
    const traces = buildBoqRowTraces('', model);
    const issues = boqRowTraceIssues(traces);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('严重不足');
  });

  it('落位率 0.3~0.6 报不足', () => {
    const traces = buildBoqRowTraces('主要工序包括平整场地。', model);
    const issues = boqRowTraceIssues(traces);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('落位不足');
  });

  it('全部落位无告警', () => {
    const traces = buildBoqRowTraces('平整场地、挖一般土方、现浇混凝土柱均按规范施工。', model);
    expect(boqRowTraceIssues(traces)).toHaveLength(0);
  });
});

describe('C-T5 落位口径（豁免登记 + 有效行分母）', () => {
  const boq = (rows: string[][]) => factsModel([], [], [{ tableType: '清单', headers: ['序号', '项目编码', '项目名称', '工程量', '单位'], rows, sourceFile: '清单.xlsx' }]);

  it('汇总口径行标记 exempt 且不计入分母（有效行全落位不报）', () => {
    const model = boq([
      ['1', '010101001001', '平整场地', '1200', 'm2'],
      ['', '', '分部小计', '', ''],
      ['', '', '合计', '', ''],
    ]);
    const traces = buildBoqRowTraces('主要工序包括平整场地。', model);
    expect(traces).toHaveLength(3);
    expect(traces.filter(t => t.exempt)).toHaveLength(2);
    // 历史缺陷：口径行未排除 → 1/3=33% 报「严重不足」；修复后有效行 1 行全落位 → 无告警
    expect(boqRowTraceIssues(traces)).toHaveLength(0);
  });

  it('分母只计有效行，豁免行登记进告警消息（可审计）', () => {
    const model = boq([
      ['1', '010101001001', '平整场地', '1200', 'm2'],
      ['2', '010101003001', '挖一般土方', '5600', 'm3'],
      ['', '', '分部小计', '', ''],
    ]);
    const traces = buildBoqRowTraces('主要工序包括平整场地。', model);
    const issues = boqRowTraceIssues(traces);
    expect(issues).toHaveLength(1);
    // 有效行 2（豁免 1 行）：1/2=50% → 0.3~0.6 报「落位不足」；历史口径 1/3=33% 会报「严重不足」
    expect(issues[0]!.message).toContain('落位不足');
    expect(issues[0]!.message).not.toContain('严重不足');
    expect(issues[0]!.message).toContain('/2 行');
    expect(issues[0]!.message).toContain('口径行 1 行已豁免');
  });
});

describe('M9 落位判定扩围（首段实体主名 + 短名救回 + 豁免扩围）', () => {
  const boq = (rows: string[][]) => factsModel([], [], [{ tableType: '清单', headers: ['序号', '项目编码', '项目名称', '工程量', '单位'], rows, sourceFile: '清单.xlsx' }]);

  it('括号/顿号枚举名取首段主名判定（「矩形柱（含梯柱）」正文含「矩形柱」即落位）', () => {
    const model = boq([['1', '010502001001', '矩形柱（含梯柱）', '320', 'm3']]);
    const traces = buildBoqRowTraces('本工程矩形柱采用组合钢模板施工。', model);
    expect(traces[0]!.placed).toBe(true);
  });

  it('2 字短名救回（「圈梁」「垫层」实体词照常判定）', () => {
    const model = boq([
      ['1', '010503002001', '圈梁', '120', 'm3'],
      ['2', '010501003001', '垫层', '240', 'm3'],
    ]);
    const traces = buildBoqRowTraces('圈梁与垫层均按设计图纸施工。', model);
    expect(traces.filter(t => t.placed)).toHaveLength(2);
  });

  it('2 字泛词不救回且豁免（「其他」「材料」在正文必然出现，不构成落位证据；C3-5-8 豁免登记）', () => {
    const model = boq([
      ['1', '010101001001', '其他', '5', '项'],
      ['2', '010101001002', '材料', '10', '批'],
    ]);
    const traces = buildBoqRowTraces('其他材料由总包统一采购，其他事项另行约定。', model);
    expect(traces.filter(t => t.placed)).toHaveLength(0);
    // C3-5-8：泛词短名行豁免登记（隐形分母消除——字面三通道因长度门槛全不可达）；行保留在追踪中供审计
    expect(traces.filter(t => t.exempt)).toHaveLength(2);
  });

  it('豁免扩围：噪声行/费用行/分部标题行登记 exempt 不进分母', () => {
    const model = boq([
      ['1', '010101001001', '平整场地', '1200', 'm2'],
      ['', '', '分部分项工程量清单', '', ''],
      ['', '', '夜间施工增加费', '', ''],
      ['', '', '道路工程', '', ''],
    ]);
    const traces = buildBoqRowTraces('主要工序包括平整场地。', model);
    expect(traces).toHaveLength(4);
    expect(traces.filter(t => t.exempt)).toHaveLength(3);
    // 有效行 1 行全落位 → 无告警（扩围前 1/4=25% 报「严重不足」）
    expect(boqRowTraceIssues(traces)).toHaveLength(0);
  });

  it('豁免行登记进告警消息（扩围类别可审计）', () => {
    const model = boq([
      ['1', '010101001001', '平整场地', '1200', 'm2'],
      ['2', '010101003001', '挖一般土方', '5600', 'm3'],
      ['', '', '措施项目', '', ''],
    ]);
    const traces = buildBoqRowTraces('主要工序包括平整场地。', model);
    const issues = boqRowTraceIssues(traces);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('口径行 1 行已豁免');
  });

  // 巢湖实测（179 行未落位中 17 行为该类）：清单抽取把枚举名拆成「给、排水附（配）件」，
  // 正文按业务写法写「给排水附配件」，两侧只差归一化未收的顿号 → 真落位被判未落位
  it('分隔标点同族归一：清单名含顿号/间隔号，正文按业务写法写出即落位', () => {
    const model = boq([
      ['1', '030404017001', '给、排水附（配）件', '22', '个'],
      ['2', '010515001001', '电梯井壁、电缆井壁模板', '115.23', 'm2'],
      ['3', '030411001001', '接线·端子箱', '4', '台'],
    ]);
    const traces = buildBoqRowTraces(
      '给排水附配件按设计要求安装；电梯井壁电缆井壁模板采用组合钢模；接线端子箱落地安装。',
      model,
    );
    expect(traces.filter(t => t.placed)).toHaveLength(3);
  });

  it('分隔标点归一不制造假落位：正文未写出的条目不因去标点而命中', () => {
    const model = boq([['1', '030404017001', '给、排水附（配）件', '22', '个']]);
    const traces = buildBoqRowTraces('主要工序包括管道冲洗与消毒。', model);
    expect(traces[0]!.placed).toBe(false);
  });
});

describe('isActionableTraceFact（可执行落位义务判定）', () => {
  it('label+value 无关域且非数字 → 排除', () => {
    expect(isActionableTraceFact({ label: '备注', value: '资料待复核', status: 'unplaced', confidence: 1 })).toBe(false);
  });
  it('技术参数/精确参数 label 排除', () => {
    expect(isActionableTraceFact({ label: '技术参数', value: '010101001001', status: 'unplaced', confidence: 1 })).toBe(false);
  });
  it('实质事实保留', () => {
    expect(isActionableTraceFact({ label: '计划工期', value: '540日历天', status: 'unplaced', confidence: 1 })).toBe(true);
  });
  it('项目名称标签下的清单分部名噪声排除，真实项目名（含地名/建设词）保留（R14 丰乐镇）', () => {
    expect(isActionableTraceFact({ label: '项目名称', value: '其他装饰工程', status: 'used', confidence: 1 })).toBe(false);
    expect(isActionableTraceFact({ label: '项目名称', value: '墙、柱面装饰与隔断、幕墙工程', status: 'unplaced', confidence: 1 })).toBe(false);
    expect(isActionableTraceFact({ label: '项目名称', value: '2026年度丰乐镇20个美丽宜居自然村建设项目', status: 'used', confidence: 1 })).toBe(true);
  });
  it('风险描述条件句（未编制专项施工方案…）不构成落位义务', () => {
    expect(isActionableTraceFact({
      label: '风险控制要求',
      value: '危险性较大分部分项工程（包括脚手架、高支模、起重吊装及安装拆卸工程等）未编制专项施工方案、未组织论证的不得施工',
      status: 'unplaced',
      confidence: 1,
    })).toBe(false);
  });
  it('r27 要求条款类知识排除：义务主体开头 / 纯法规名 / 「本招标项目…须」 / 圆括号序号', () => {
    expect(isActionableTraceFact({ label: '安全合规要求', value: '承包人应实现安全生产无事故目标。', status: 'unplaced', confidence: 1 })).toBe(false);
    expect(isActionableTraceFact({ label: '国家法律法规', value: '《中华人民共和国招标投标法》《中华人民共和国安全生产法》', status: 'unplaced', confidence: 1 })).toBe(false);
    expect(isActionableTraceFact({ label: '地方法规规章', value: '《建设工程质量管理条例》', status: 'unplaced', confidence: 1 })).toBe(false);
    expect(isActionableTraceFact({ label: '国家行业地方规范标准', value: '本招标项目施工、验收须达到设计文件的要求。', status: 'unplaced', confidence: 1 })).toBe(false);
    expect(isActionableTraceFact({ label: '施工范围', value: '（二）污水管网、生态处理等污水工程；', status: 'unplaced', confidence: 1 })).toBe(false);
  });
  it('r27 要求条款排除护栏：非义务句式 / 含实质内容法规引用 / 真项目名 / 含具体数据义务句均保留', () => {
    expect(isActionableTraceFact({ label: '安全文明', value: '承包人办公区与生活区分设并落实消防措施', status: 'unplaced', confidence: 1 })).toBe(true);
    expect(isActionableTraceFact({ label: '质量标准', value: '执行《建筑工程施工质量验收统一标准》GB50300合格标准', status: 'unplaced', confidence: 1 })).toBe(true);
    expect(isActionableTraceFact({ label: '项目名称', value: '2026年度某某镇美丽宜居自然村建设项目', status: 'used', confidence: 1 })).toBe(true);
    // 含数值/期限的具体安排句可被正文直接引用扩散，不列入要求条款排除（R14 实机行为）
    expect(isActionableTraceFact({ label: '资源配置要求', value: '承包人应在工程开工前7日内，完成包括临时水电报装、临时设施搭建及施工便道修筑在内的全部开工准备工作。', status: 'unplaced', confidence: 1 })).toBe(true);
  });
});

describe('boqDivisionCoverageIssues（P2/P4 清单分项覆盖义务）', () => {
  const methodChapter = (content: string): DocumentDraftChapter => ({
    id: 'ch-method', title: '第二章 主要分部分项工程施工方法', content, evidence: [], missingFacts: [],
  });
  const chapters = (content: string): DocumentDraftChapter[] => [methodChapter(content)];
  const boqModel = factsModel([], [], [{
    tableType: '清单',
    headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
    rows: [
      ['1', '010101001001', '道路工程施工', '3800', 'm2'],
      ['2', '040203001001', '污水管网铺设', '2170', 'm'],
      ['3', '040204001001', '排水沟砌筑', '860', 'm'],
      ['4', '040205001001', '沟塘清淤', '1200', 'm3'],
      ['5', '010401001001', '公共厕所', '1', '座'],
      ['6', '050307001001', '挖一般土方', '5600', 'm3'],
    ],
    sourceFile: '清单.xlsx',
  }]);

  it('公厕/污水管网/排水沟/沟塘清淤缺失 → error/blocker 且锚定施工方法章（评分报告 P2/P4）', () => {
    const markdown = [
      '## 第二章 主要分部分项工程施工方法',
      '### 2.1 道路工程施工方法',
      '道路工程按测量放线→路基整平→面层铺筑工序施工。',
      '### 2.2 铺装与绿化工程施工方法',
      '铺装与绿化按设计图纸施工。',
    ].join('\n');
    const issues = boqDivisionCoverageIssues(markdown, chapters(markdown), boqModel);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('blocker');
    expect(issues[0]?.chapterId).toBe('ch-method');
    expect(issues[0]?.message).toContain('污水管网');
    expect(issues[0]?.message).toContain('排水沟');
    expect(issues[0]?.message).toContain('公共厕所');
  });

  it('分项全覆盖 → 零报告', () => {
    const markdown = [
      '## 第二章 主要分部分项工程施工方法',
      '### 2.1 道路工程施工方法',
      '道路工程按测量放线→路基整平→面层铺筑工序施工。',
      '### 2.2 污水管网与排水沟施工方法',
      '污水管网按沟槽开挖→管道铺设→闭水试验工序施工；排水沟采用砖砌。',
      '### 2.3 沟塘清淤与公共厕所施工方法',
      '沟塘清淤采用机械清淤；公共厕所按基础→主体→装饰工序施工。',
    ].join('\n');
    expect(boqDivisionCoverageIssues(markdown, chapters(markdown), boqModel)).toEqual([]);
  });

  it('无施工方法章 → 不产生覆盖义务（零报告）', () => {
    const noMethodChapters = [{ id: 'ch-1', title: '第一章 工程概况', content: '道路工程施工。', evidence: [], missingFacts: [] }];
    expect(boqDivisionCoverageIssues('道路工程施工。', noMethodChapters, boqModel)).toEqual([]);
  });

  it('纯工序行（挖一般土方）不单独产生覆盖义务', () => {
    // 仅挖一般土方未覆盖（无实体词分项缺失）→ 零报告
    const markdown = [
      '## 第二章 主要分部分项工程施工方法',
      '### 2.1 道路工程施工方法',
      '道路工程施工。',
      '### 2.2 污水管网与排水沟施工方法',
      '污水管网铺设；排水沟砌筑。',
      '### 2.3 沟塘清淤与公共厕所施工方法',
      '沟塘清淤；公共厕所施工。',
    ].join('\n');
    expect(boqDivisionCoverageIssues(markdown, chapters(markdown), boqModel)).toEqual([]);
  });

  it('宽泛词分项（给水/排水/基础类通用词）不产生覆盖义务 → 零报告', () => {
    const broadModel = factsModel([], [], [{
      tableType: '清单',
      headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
      rows: [
        ['1', '050101001001', '给水系统', '1', '项'],
        ['2', '050201001001', '排水系统', '1', '项'],
        ['3', '010101001001', '基础工程', '1', '项'],
      ],
      sourceFile: '清单.xlsx',
    }]);
    const markdown = [
      '## 第二章 主要分部分项工程施工方法',
      '### 2.1 道路与基础施工方法',
      '道路工程按测量放线→路基整平→面层铺筑工序施工，基础施工满足设计要求。',
    ].join('\n');
    // 宽泛词在施工方法章几乎必然出现，词面命中不足以证明对应分项已覆盖，不产生义务（P4 防误判漏检）
    expect(boqDivisionCoverageIssues(markdown, chapters(markdown), broadModel)).toEqual([]);
  });

  it('公厕同义双向覆盖：清单「公共厕所」×正文「公厕」与反向形态均算已覆盖', () => {
    const aliasModel = (name: string): DocumentFactsModel => factsModel([], [], [{
      tableType: '清单',
      headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
      rows: [['1', '040501004001', name, '1', '座']],
      sourceFile: '清单.xlsx',
    }]);
    const bodyGongce = ['## 第二章 主要分部分项工程施工方法', '### 2.1 公厕施工方法', '公厕按基础→主体→装饰工序施工。'].join('\n');
    const bodyPublicToilet = ['## 第二章 主要分部分项工程施工方法', '### 2.1 公共厕所施工方法', '公共厕所按基础→主体→装饰工序施工。'].join('\n');
    expect(boqDivisionCoverageIssues(bodyGongce, chapters(bodyGongce), aliasModel('公共厕所'))).toEqual([]);
    expect(boqDivisionCoverageIssues(bodyPublicToilet, chapters(bodyPublicToilet), aliasModel('公厕'))).toEqual([]);
  });

  it('清单「公厕」正文两种同义形式均未出现 → 报覆盖缺失', () => {
    const model = factsModel([], [], [{
      tableType: '清单',
      headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
      rows: [['1', '040501004001', '公厕', '1', '座']],
      sourceFile: '清单.xlsx',
    }]);
    const markdown = [
      '## 第二章 主要分部分项工程施工方法',
      '### 2.1 道路工程施工方法',
      '道路工程按测量放线→路基整平→面层铺筑工序施工。',
    ].join('\n');
    const issues = boqDivisionCoverageIssues(markdown, chapters(markdown), model);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('公厕');
  });

  it('清单「菜地整治」正文零命中 → 报覆盖缺失（丰乐镇第五版 P4 漏检修复）', () => {
    const model = factsModel([], [], [{
      tableType: '清单',
      headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
      rows: [['1', '040501005001', '菜地整治', '1500', 'm2']],
      sourceFile: '清单.xlsx',
    }]);
    const markdown = [
      '## 第二章 主要分部分项工程施工方法',
      '### 2.1 道路工程施工方法',
      '道路工程按测量放线→路基整平→面层铺筑工序施工。',
    ].join('\n');
    const issues = boqDivisionCoverageIssues(markdown, chapters(markdown), model);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('菜地');
  });

  it('清单「菜地整治」× 正文「小菜园」同义覆盖 → 零报告', () => {
    const model = factsModel([], [], [{
      tableType: '清单',
      headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
      rows: [['1', '040501005001', '菜地整治', '1500', 'm2']],
      sourceFile: '清单.xlsx',
    }]);
    const markdown = [
      '## 第二章 主要分部分项工程施工方法',
      '### 2.1 小菜园施工方法',
      '小菜园按场地平整→种植土回填→菜畦修筑工序施工。',
    ].join('\n');
    expect(boqDivisionCoverageIssues(markdown, chapters(markdown), model)).toEqual([]);
  });
});

describe('extractBoqDivisionCoverage（r14 E16 清单分部全景：规划/写作注入素材）', () => {
  it('分部行提取（编号+无数量格）+ 条目摘要聚合 + 村名过滤 + 泛词保持父级（公厕/建筑子分部）', () => {
    const model = factsModel([], [], [{
      tableType: '清单',
      headers: [],
      rows: [
        ['', '1.1', '', '新建混凝土道路', ''],
        ['1', '040101001001', '', '挖一般土方', '1．土壤类别：综合', 'm3', '', '359.100'],
        ['', '1.4', '', '青砖步道', ''],
        ['2', '040204002001', '', '人行道板安砌', '1．本地青砖', 'm2', '', '150.000'],
        ['工程名称：马老郢（丁小郢、马小郢、李小郢）、马圩', '', '', '', '', '', '', ''],
        ['', '2.1', '', '马老郢', ''],
        ['', '2.3', '', '公厕', ''],
        ['', '2.3.1', '', '建筑', ''],
        ['3', '010101001001', '', '平整场地', '1．土壤类别：综合', 'm2', '', '24.700'],
      ],
      sourceFile: '清单.xls',
    }]);
    const entries = extractBoqDivisionCoverage(model);
    const names = entries.map(entry => entry.name);
    expect(names).toContain('新建混凝土道路');
    expect(names).toContain('青砖步道');
    expect(names).toContain('公厕');
    // 村级地名与泛词不入全景（泛词「建筑」子分部条目归入父级「公厕」）
    expect(names).not.toContain('马老郢');
    expect(names).not.toContain('建筑');
    expect(entries.find(entry => entry.name === '新建混凝土道路')?.items).toEqual(['挖一般土方 359.1m3']);
    expect(entries.find(entry => entry.name === '青砖步道')?.items).toEqual(['人行道板安砌 150m2']);
    expect(entries.find(entry => entry.name === '公厕')?.items).toEqual(['平整场地 24.7m2']);
  });

  it('中文序数一级分部 + GB 编码分部 + 村组段落归属（r20：二 排水工程/0112 装饰分部/生态池类专有分项入全景）', () => {
    const model = factsModel([], [], [{
      tableType: '清单',
      headers: [],
      rows: [
        // 中文序数一级分部（历史缺陷：只认带点编号致上下文丢失）
        ['', '二', '', '排水工程', ''],
        // 村组名（工程名称行建有地名集合）→ 保持上层上下文（历史缺陷：清空致条目丢失）
        ['工程名称：马老郢、马圩', '', '', '', '', '', '', ''],
        ['', '2.1', '', '马老郢', ''],
        // 字母前缀编码条目（WB/ZB 形态，历史缺陷：只认纯数字致条目掉落）
        ['51', 'WB041111006001', '', '1#生态池（3T/D)', '1、结构做法详见图纸', 'm3', '', '9.600'],
        ['52', '050102007001', '', '栽植色带（生态池外围一圈）', 'x', 'm2', '', '9.600'],
        // GB 清单编码分部（0112 墙柱面装饰）
        ['', '0112', '', '墙、柱面装饰与隔断、幕墙工程', ''],
        ['118', '011406001001', '', '公厕外墙真石漆', 'x', 'm2', '', '102.250'],
      ],
      sourceFile: '清单.xls',
    }]);
    const entries = extractBoqDivisionCoverage(model);
    const names = entries.map(entry => entry.name);
    expect(names).toContain('排水工程');
    expect(names).toContain('墙、柱面装饰与隔断、幕墙工程');
    expect(names).not.toContain('马老郢');
    // 村组段落条目归属上层专业分部（「二 排水工程 → 2.1 马老郢 → 生态池」）
    expect(entries.find(entry => entry.name === '排水工程')?.items).toEqual(['1#生态池（3T/D) 9.6m3', '栽植色带（生态池外围一圈） 9.6m2']);
    // GB 编码分部条目归属（公厕外墙真石漆 → 墙柱面装饰分部）
    expect(entries.find(entry => entry.name === '墙、柱面装饰与隔断、幕墙工程')?.items).toEqual(['公厕外墙真石漆 102.25m2']);
  });

  it('行中后段数字/中文序数不误判为分部（位置约束：编号限行首 ≤ 2 列）', () => {
    const model = factsModel([], [], [{
      tableType: '清单',
      headers: [],
      rows: [
        ['', '1.1', '', '新建混凝土道路', ''],
        ['1', '040101001001', '', '挖一般土方', 'x', 'm3', '', '1436.000'],
        // 尾部 4 位数字 + 中文单位 / 尾部中文序数：不得产生伪分部
        ['', '', '', '零星说明', '1000', '平方米', '', ''],
        ['', '', '', '合计说明', '二', '三', '', ''],
      ],
      sourceFile: '清单.xls',
    }]);
    const names = extractBoqDivisionCoverage(model).map(entry => entry.name);
    expect(names).toContain('新建混凝土道路');
    expect(names).not.toContain('平方米');
    expect(names).not.toContain('二');
  });

  it('跨表分页聚合（同名分部跨表合并 + 无实体词分部靠直属条目保留）', () => {
    const page = (rows: string[][]): DocumentFactsModel['tables'][number] => ({ tableType: '清单', headers: [], rows, sourceFile: '清单.xls' });
    const model = factsModel([], [], [
      page([['', '1.2', '', '入户路', ''], ['1', '040101001002', '', '挖一般土方', 'x', 'm3', '', '100.440']]),
      page([['', '1.2', '', '入户路', ''], ['2', '040202001002', '', '路床(槽)碾压检验', 'x', 'm2', '', '558.000']]),
    ]);
    const entries = extractBoqDivisionCoverage(model);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('入户路');
    expect(entries[0]?.items).toEqual(['挖一般土方 100.44m3', '路床(槽)碾压检验 558m2']);
  });

  it('空 factsModel → 空数组；formatBoqDivisionCoverage 格式化', () => {
    expect(extractBoqDivisionCoverage(factsModel([], [], []))).toEqual([]);
    expect(formatBoqDivisionCoverage([{ name: '过路涵', items: ['挖沟槽土方 30.7m3'] }, { name: '公厕', items: [] }])).toBe('- 过路涵（挖沟槽土方 30.7m3）\n- 公厕');
    expect(formatBoqDivisionCoverage([])).toBe('');
  });
});

describe('enforceBoqDivisionCoverageInMethodChapters（r14 E16 链尾确定性兜底）', () => {
  const coverageModel = factsModel([], [], [{
    tableType: '清单',
    headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
    rows: [
      ['1', '040202009001', '级配碎石', '1436.4', 'm2'],
      ['2', '040204003001', '青砖步道', '150', 'm2'],
      ['3', '040205004001', '过路涵', '50', 'm'],
    ],
    sourceFile: '清单.xlsx',
  }]);
  const markdown = [
    '## 第二章 主要施工方法',
    '### 2.1 道路工程',
    '道路工程按测量放线、路基整平、面层铺筑工序施工。',
    '',
    '## 第三章 物资计划',
    '物资按计划进场。',
  ].join('\n');
  const drafts = (): DocumentDraftChapter[] => [
    { id: 'ch2', title: '主要施工方法', content: '### 2.1 道路工程\n道路工程按测量放线、路基整平、面层铺筑工序施工。', evidence: [], missingFacts: [] },
    { id: 'ch3', title: '物资计划', content: '物资按计划进场。', evidence: [], missingFacts: [] },
  ];

  it('方法章缺专有分项 → 章末补段 + drafts 同步 + 检测清零 + 幂等', () => {
    const chapterDrafts = drafts();
    const fix = enforceBoqDivisionCoverageInMethodChapters({ markdown, chapters: chapterDrafts, factsModel: coverageModel });
    expect(fix).toBeTruthy();
    expect(fix!.appended).toEqual(expect.arrayContaining(['青砖步道', '过路涵']));
    expect(fix!.markdown).toContain('青砖步道分项');
    expect(fix!.markdown).toContain('过路涵分项');
    // 补段位于方法章段落内（下一 H2 之前），且无新标题（H2/H3 计数不变）
    const lines = fix!.markdown.split('\n');
    const paraIdx = lines.findIndex(line => line.includes('本工程工程量清单分项施工方法补充如下'));
    const ch3Idx = lines.findIndex(line => /^##\s.*物资计划/u.test(line));
    expect(paraIdx).toBeGreaterThan(0);
    expect(paraIdx).toBeLessThan(ch3Idx);
    expect((fix!.markdown.match(/^#{1,3}\s/gmu) || []).length).toBe((markdown.match(/^#{1,3}\s/gmu) || []).length);
    // drafts 同步（防 rebuildFinalMarkdown 重拼回退）
    expect(chapterDrafts[0]!.content).toContain('本工程工程量清单分项施工方法补充如下');
    // 检测清零 + 幂等
    expect(boqDivisionCoverageIssues(fix!.markdown, chapterDrafts, coverageModel)).toEqual([]);
    expect(enforceBoqDivisionCoverageInMethodChapters({ markdown: fix!.markdown, chapters: chapterDrafts, factsModel: coverageModel })).toBeNull();
  });

  it('无缺口 / 无方法章 / 空模型 → null（零成本静默）', () => {
    // 覆盖判定以章 drafts 内容为准（methodText 源）：drafts 与 markdown 同步提及全部分项 → 零缺口
    const coveredDrafts = (): DocumentDraftChapter[] => [
      { id: 'ch2', title: '主要施工方法', content: '### 2.1 道路工程\n道路工程按测量放线施工；青砖步道分项按设计标高铺砌；过路涵分项按设计断面施工。', evidence: [], missingFacts: [] },
      { id: 'ch3', title: '物资计划', content: '物资按计划进场。', evidence: [], missingFacts: [] },
    ];
    const covered = ['## 第二章 主要施工方法', '### 2.1 道路工程', '道路工程按测量放线施工；青砖步道分项按设计标高铺砌；过路涵分项按设计断面施工。'].join('\n');
    expect(enforceBoqDivisionCoverageInMethodChapters({ markdown: covered, chapters: coveredDrafts(), factsModel: coverageModel })).toBeNull();
    expect(enforceBoqDivisionCoverageInMethodChapters({ markdown, chapters: [{ id: 'c1', title: '工程概况', content: '概况。', evidence: [], missingFacts: [] }], factsModel: coverageModel })).toBeNull();
    expect(enforceBoqDivisionCoverageInMethodChapters({ markdown, chapters: drafts(), factsModel: factsModel([], [], []) })).toBeNull();
  });
});

// ── C-T2. 数字溯源闭环（三分类矩阵 / 扫描过滤 / 反查聚合 / 链尾改定性） ──

describe('C-T2 classifyNumericTraceToken 三分类（r28f 实测合法数字全豁免）', () => {
  const samples: Array<{ token: string; context: string; kind: string; basis: string }> = [
    { token: '50268', context: '按《给水排水管道工程施工及验收规范》GB 50268 的规定执行', kind: 'regulatory', basis: '标准编号' },
    { token: '2019', context: '依据 GB 50268-2019 验收规范执行', kind: 'regulatory', basis: '标准编号年份' },
    { token: '2019年', context: '该规范于 2019 年发布实施', kind: 'regulatory', basis: '年份表述' },
    { token: '14天', context: '混凝土养护龄期不少于 14 天，同条件养护试块强度达设计值', kind: 'regulatory', basis: '养护龄期' },
    { token: '100m³', context: '每 100m³ 混凝土留置一组试块', kind: 'regulatory', basis: '试块留置/检验批' },
    { token: '400m³', context: '砌筑砂浆每 400m³ 检验批留置一组试块', kind: 'regulatory', basis: '试块留置/检验批' },
    { token: '3组', context: '每层留置 3 组试块送检', kind: 'regulatory', basis: '试块留置' },
    { token: '200m²', context: '压实度检测每层每 200m² 不少于 1 点', kind: 'regulatory', basis: '检测频次' },
    { token: '1点', context: '压实度检测每层不少于 1 点', kind: 'regulatory', basis: '检测频次' },
    { token: '5℃', context: '混凝土入模温度不低于 5℃', kind: 'regulatory', basis: '温度阈值' },
    { token: '95%', context: '路基压实度不低于 95%', kind: 'regulatory', basis: '质量指标' },
    { token: '5mm', context: '面层厚度偏差不超过 ±5mm', kind: 'regulatory', basis: '工艺公差' },
    { token: '1次', context: '每日不少于 1 次安全巡查', kind: 'management', basis: '管理频次' },
    { token: '9个', context: '将 9 个自然村分组平行施工', kind: 'management', basis: '施工组织编排' },
    { token: '2名', context: '项目部配备专职安全员 2 名', kind: 'management', basis: '组织配置' },
    { token: '60天', context: '缺陷责任期内的修复合理期限一般不超过 60 天', kind: 'management', basis: '合同程序条款' },
    { token: '8月', context: '计划 2026 年 8 月开工', kind: 'management', basis: '日期表述' },
    { token: '100%', context: '焊缝一次验收合格率 100%', kind: 'management', basis: '过程指标' },
    { token: '60万元', context: '暂列金额 60 万元由招标人掌握使用', kind: 'management', basis: '商务金额' },
    // M24d D4 R9 扩词：稳压/压降语境（r28l 实机 0.05MPa）
    { token: '0.05MPa', context: '试验压力0.6MPa，稳压1h压降不超过0.05MPa且无渗漏为合格', kind: 'regulatory', basis: '工艺压力参数' },
    // M24d D4 R13 材料/设备规格型号（s28l 实机 INT125-3P-50 / Q345-B）
    { token: 'INT125-3P-50', context: '配电系统执行NSX100N/3P INT125-3P-50主开关配置', kind: 'regulatory', basis: '材料/设备规格型号' },
    { token: 'Q345-B', context: '支撑架体钢管材质采用Q345-B，进场时逐批核对材质证明', kind: 'regulatory', basis: '材料/设备规格型号' },
    // M24d D4 R14 图纸编号（r28l D258 / s28k M1222）
    { token: 'D258', context: '坡度按设计图纸控制，如D258×16.5管段坡度i=0.3', kind: 'regulatory', basis: '图纸编号' },
    { token: 'M1222', context: '复核洞口尺寸与门窗表，M1222洞口尺寸与大样不一致处按补疑确认', kind: 'regulatory', basis: '图纸编号' },
    // M24d D4 R15 规范条件阈值（s28k 实机 630mm）
    { token: '630mm', context: '风管边长大于630mm时按规范设置加固框', kind: 'regulatory', basis: '规范阈值' },
    // M24d D3 M7 工期合计编排（r28l 89天 / s28k 344天）
    { token: '89天', context: '预留机动工期1天，各节点用时合计89天，控制在90日历天总工期以内', kind: 'management', basis: '工期合计编排' },
    { token: '344天', context: '30天、168天、107天，合计344天，预留16天机动工期用于工序衔接', kind: 'management', basis: '工期合计编排' },
    // L0-7 R16 规格粘连（实机成稿 doc-1790104980418：型号/牌号与数量无分隔粘连，数值核为拼接产物）
    { token: 'HRB4001.941t', context: '圈梁C25、有梁板C30，钢筋HRB4001.941t、钢筋连接Φ16共364个', kind: 'regulatory', basis: '规格粘连' },
    { token: 'HRB40025.851t', context: '钢筋工程现浇构件钢筋HRB40025.851t', kind: 'regulatory', basis: '规格粘连' },
    { token: 'DN405m', context: 'DN15管卡间距不大于1.0m，DN405m；', kind: 'regulatory', basis: '规格粘连' },
    { token: '251.941t', context: 'Φ8、Φ10、Φ12、Φ20、Φ251.941t，钢筋连接Φ16共364个', kind: 'regulatory', basis: '规格粘连' },
    // L0-7 R17 章节编号（「1.22 周月计划报送与纠偏」：1.22 是小节编号、周是标题首字，邻号 1.23 即编号序列）
    { token: '1.22 周', context: '总进度计划编制与图表管理 1.22 周月计划报送与纠偏 1.23', kind: 'regulatory', basis: '章节编号' },
    // L0-7 R13 语境扩容：板型（实机「压型钢板，板型HV470B」）
    { token: 'HV470B', context: '屋面压型钢板，板型HV470B，镀铝锌镁量165g/m²', kind: 'regulatory', basis: '材料/设备规格型号' },
  ];
  it.each(samples)('$token → $kind/$basis', ({ token, context, kind, basis }) => {
    const result = classifyNumericTraceToken({ token, context });
    expect(result.kind).toBe(kind);
    expect(result.basis).toBe(basis);
  });

  const unsourcedSamples: Array<{ token: string; context: string }> = [
    { token: '90m²', context: '栽植色带 90m²，按设计标高整地' },
    { token: '8个月', context: '总工期 8 个月，按月排布资源投入' },
    { token: '75kW', context: '现场配备 75kW 柴油发电机' },
    { token: '1.2m', context: '沟槽开挖深度 1.2m' },
    // M24d D4 反向守护：无合计词/无工期语境的纯天数不豁免（真锚定值需溯源）
    { token: '360天', context: '合同工期360天' },
    { token: '500天', context: '合计500天' },
    // M24d D4 反向守护：DN 管径前缀不借型号族豁免；直径语境不借图纸编号族豁免
    { token: 'DN50', context: '配电箱引出DN50管' },
    { token: 'D300', context: '管段直径D300mm' },
    // L0-7 反向守护（一）：真缺口不得借粘连族豁免——无 Φ/DN/HRB 语境代号的纯数值（424.2m 可切出 4|24.2m）、
    // 正文自算合计（6403.78m²）与清单投影缺口（427.000个）必须照常报出
    { token: '424.2m', context: '室外排水塑料管424.2m，按设计坡度敷设' },
    { token: '6403.78m²', context: '检验批总量6403.78m²，按分项工程划分' },
    { token: '427.000个', context: '配套混凝土管道接口427.000个口、砌筑检查井54座' },
    // L0-7 反向守护（二）：整数段带多余前导零不是粘连值段（Φ1000mm 的 1000、φ700人孔 的 700 是真实量值；
    // 若按「纯形态」切分会被切成 1|000 / 7|00 而错判粘连）
    { token: '1000mm', context: 'Φ1000mm检查井井筒，井盖与井筒同径' },
    { token: '700人', context: 'φ700人孔井盖，安装后与路面齐平' },
    // L0-7 反向守护（三）：纯代号（无数量段）不得被粘连族吞掉（HRB400 可切出 4|00）
    { token: 'HRB400', context: '钢筋HRB400，Φ16共364个' },
    { token: 'DN40', context: 'DN40管卡间距不大于1.0m' },
    // L0-7 反向守护（四）：粘连形态但语境无代号不成立（251.941t 无 Φ 前缀即普通量值）；
    // 编号形态但语境无同形邻号不成立（无邻号的「1.22 周」类时量表述照报）
    { token: '251.941t', context: '钢筋用量合计251.941t，按批次进场' },
    { token: '1.22 周', context: '首段养护历时 1.22 周后进入下道工序' },
  ];
  it.each(unsourcedSamples)('未溯源样本 $token 不豁免', ({ token, context }) => {
    const result = classifyNumericTraceToken({ token, context });
    expect(result.kind).toBe('unsourced');
    expect(result.basis).toBe('');
  });

  it('L0-7 R16/R17 判定为「存在性 + 语境」双要件，不写死具体值（同形异构样本随值改变结论）', () => {
    // 粘连族：换任意代号/数量仍成立（机制，非白名单）；代号换成无关字母且无数值段则不成立
    expect(isSpecGluedValueToken({ token: 'XGQ2512.5kg', context: '构架XGQ2512.5kg' })).toBe(true);
    expect(isSpecGluedValueToken({ token: '500kg', context: '钢筋500kg' })).toBe(false);
    // 编号族：整数段/小数段同形邻号任一方向成立（1.22↔1.23 / 1.22↔2.22）；无邻号不成立
    expect(isSectionNumberingToken({ token: '3.14 天', context: '… 3.13 … 3.14 天 … 3.15 …' })).toBe(true);
    expect(isSectionNumberingToken({ token: '1.22 周', context: '总进度计划 1.22 周月计划报送 1.23' })).toBe(true);
    expect(isSectionNumberingToken({ token: '1.22 周', context: '养护历时 1.22 周' })).toBe(false);
    expect(isSectionNumberingToken({ token: '427.000个', context: '接口427.000个' })).toBe(false);
  });

  it('L0-7 收尾：邻号被语境窗口截半（1.23 → .23）仍算同层邻号；小数段不相差 1 或点在数字内则不成立', () => {
    // 实机 doc-1790115927170：目录行 token「1.24 项」的窗口左界落在「1.23」中间
    expect(isSectionNumberingToken({ token: '1.24 项', context: '.23 工伤保险与劳动保障 1.24 项目管理机构与岗位职责 1.2' })).toBe(true);
    expect(isSectionNumberingToken({ token: '1.24 项', context: '… .23 … 1.24 项目管理' })).toBe(true);
    // 反例：截断残余的小数段不相差 1；点号落在数字/小数内部（Φ25.23）不构成邻号；无任何邻号
    expect(isSectionNumberingToken({ token: '1.24 项', context: '.56 与 1.24 项目管理' })).toBe(false);
    expect(isSectionNumberingToken({ token: '1.24 项', context: '钢筋Φ25.23、1.24 项目管理' })).toBe(false);
    expect(isSectionNumberingToken({ token: '1.24 项', context: '1.24 项目管理机构与岗位职责' })).toBe(false);
  });

  it('4.55.31 R17 扩形：一位小数小节编号（「3.8 周」＝3.8 小节 + 标题首字周）按**同形**邻号豁免', () => {
    // 实机 doc-1790125123717：目录「3.7 现场设施与计量装置保护 / 3.8 周边管线与建筑保护措施 / 3.9 …」
    expect(isSectionNumberingToken({ token: '3.8 周', context: '3.7 现场设施与计量装置保护 3.8 周边管线与建筑保护措施 3.9' })).toBe(true);
    // 同小数段邻号方向（2.8 ↔ 3.8）同样成立；两位小数族（1.22 ↔ 1.23）不受扩形影响
    expect(isSectionNumberingToken({ token: '3.8 周', context: '2.8 材料检验试验计划 3.8 周边管线保护' })).toBe(true);
    expect(isSectionNumberingToken({ token: '2.4 月', context: '2.3 总进度网络图与横道图控制 2.4 月周日进度计划报审管理 2.5' })).toBe(true);
    expect(isSectionNumberingToken({ token: '1.22 周', context: '总进度计划 1.22 周月计划报送 1.23' })).toBe(true);
    // 反例（扩形不得吞真实时量）：无同形邻号；邻号**不同形**（小数段位数不同）不成立
    expect(isSectionNumberingToken({ token: '1.5 月', context: '养护历时 1.5 月后进入下道工序' })).toBe(false);
    expect(isSectionNumberingToken({ token: '1.5 月', context: '养护历时 1.5 月，含水率 2.05% 控制' })).toBe(false);
    expect(isSectionNumberingToken({ token: '3.8 天', context: '… 3.75 … 3.8 天 …' })).toBe(false);
    expect(isSectionNumberingToken({ token: '1.22 周', context: '总进度计划 1.22 周月计划报送 1.2 结束' })).toBe(false);
  });
});

describe('C-T2 scanNumericTrace 扫描口径（表格行/章节号/裸数过滤）', () => {
  it('表格行内数值不产出（计划排期分解数据不反查）', () => {
    expect(scanNumericTrace('| 7 | 栽植色带 | 90 | m2 |')).toEqual([]);
  });

  it('章节编号与长编码不产出', () => {
    expect(scanNumericTrace('### 2.3 栽植工程（项目编码 040202009001）')).toEqual([]);
  });

  it('无单位裸数不产出（序号/图号噪声，未命中标准号与年份口径）', () => {
    expect(scanNumericTrace('按图号 300 施工，详见第 500 号变更单')).toEqual([]);
  });

  it('标准编号与年份裸数豁免产出（regulatory）', () => {
    const hits = scanNumericTrace('依据 GB 50268-2019 及 2020 年修正版执行');
    expect(hits.some(hit => hit.normalizedToken === '50268' && hit.kind === 'regulatory')).toBe(true);
    expect(hits.some(hit => hit.normalizedToken === '2019' && hit.kind === 'regulatory')).toBe(true);
  });
});

describe('C-T2 buildNumericTraceFindings / numericTraceabilityIssues（反查与终检聚合）', () => {
  const boqModel = () => factsModel([], [], [{
    tableType: '清单',
    headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
    rows: [
      ['1', '040202009001', '栽植色带', '9.600', 'm2'],
      ['2', '040204003001', '青砖步道', '150', 'm2'],
      ['3', '040205004001', '过路涵', '50', 'm'],
    ],
    sourceFile: '清单.xlsx',
  }]);

  it('清单数量溯源命中（跨格组合+尾零规约：9.6 与 9.600 等价）', () => {
    expect(buildNumericTraceFindings('栽植色带9.6m²，青砖步道150m²，过路涵50m。', boqModel())).toEqual([]);
  });

  it('真未溯源数字报出并经终检聚合 error（消息锚同既有反查链）', () => {
    const md = '栽植色带90m²，按设计标高整地。';
    const findings = buildNumericTraceFindings(md, boqModel());
    expect(findings.map(finding => finding.normalizedToken)).toContain('90m2');
    const issues = numericTraceabilityIssues(md, boqModel());
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.message).toContain('生成后事实反查失败');
    expect(issue.message).toContain('90m²');
    expect(issue.level).toBe('error');
    expect(issue.severity).toBe('blocker');
    expect(issue.category).toBe('evidence_coverage');
    expect(issue.repairability).toBe('llm_repairable');
  });

  it('规范常数豁免与表格行过滤（合法数字不进反查）', () => {
    const md = '每100m³混凝土留置一组试块，养护龄期不少于14天。\n| 7 | 040204003001 | 青砖步道 | 150 | m2 |';
    expect(buildNumericTraceFindings(md, boqModel())).toEqual([]);
  });

  it('语料规模不足（空模型）→ 反查短路', () => {
    expect(buildNumericTraceFindings('栽植色带90m²。', factsModel())).toEqual([]);
    expect(numericTraceabilityIssues('栽植色带90m²。', factsModel())).toEqual([]);
  });
});

describe('C-T2 demoteUnsourcedNumericTokens（G 线 P2-2 停用：不以删除数值通过门禁）', () => {
  const boqModel = () => factsModel([], [], [{
    tableType: '清单',
    headers: ['序号', '项目编码', '项目名称', '工程量', '单位'],
    rows: [['1', '040202009001', '栽植色带', '9.600', 'm2']],
    sourceFile: '清单.xlsx',
  }]);

  // 原实现在此断言「未溯源数值被删除改定性、details 逐条列出、并列顿号清理、题注编号豁免」等 ——
  // 那是**用删除通过门禁**：交付物看上去干净，实际是「本来该有数据的地方被抹掉」，
  // 且修复链无知识库通道、补不进新材料，删除成了它唯一能收敛的动作。
  // 现口径：保留数值与「无主数值审计」blocker，由交付门禁按「未达交付标准」处理。

  it('停用后不再删除未溯源数值（返回 null，markdown 原样）', () => {
    const fix = demoteUnsourcedNumericTokens({ markdown: '栽植色带90m²，按设计标高整地。铺种草皮80m²。', factsModel: boqModel() });
    expect(fix).toBeNull();
  });

  it('幂等：重复调用同样返回 null，不产生任何改写', () => {
    const call = () => demoteUnsourcedNumericTokens({ markdown: '栽植色带90m²。', factsModel: boqModel() });
    expect(call()).toBeNull();
    expect(call()).toBeNull();
  });

  it('含标题表序段的正文同样不改写（原「编号豁免」逻辑随停用一并失效）', () => {
    const fix = demoteUnsourcedNumericTokens({ markdown: '表3-4 道路结构层按3m、4m、5m 等分层摊铺。', factsModel: boqModel() });
    expect(fix).toBeNull();
  });
});

