import { describe, expect, it } from 'vitest';
import { boqRowTraceIssues, buildBoqRowTraces, buildDocumentFactTraces, cleanFactValue, factTraceIssues, isActionableFactValue, isActionableTraceFact } from './documentFactTrace';
import type { DocumentFact, DocumentFactsModel } from './types';

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
});
