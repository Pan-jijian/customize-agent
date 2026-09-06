import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeProjectId } from '@customize-agent/knowledge';
import { buildBaseProjectGraph } from '@/services/document-workflow/agentWorkflow';
import type { ConstructionOrganizationGraph, ProjectIntelligenceIntentEntry } from '@/services/document-workflow/projectIntelligence';

vi.mock('@/services/knowledge/kbOperationLog', () => ({ upsertKbOperation: vi.fn() }));
// 守卫测试用真实 startProjectIntelligenceBuild：仅 mock 外部依赖 getMultiProjectManager/listKnowledgeFiles 控制构建时序
// （partial self-mock 替换 buildProjectIntelligence 无效——同模块内部互调是词法引用，不经导出命名空间）
vi.mock('@/services/knowledge/kbService', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/knowledge/kbService')>();
  return { ...actual, getMultiProjectManager: vi.fn(), listKnowledgeFiles: vi.fn(), getStorageRoot: vi.fn() };
});
// LLM 图谱构建为外部模块：降级落盘测试用 reject 模拟 LLM 失败
vi.mock('@/services/document-workflow/projectGraph', () => ({ buildProjectGraph: vi.fn() }));

import { buildProjectIntelligence, buildProjectIntelligenceSync, chapterIntentTags, constructionOrganizationPrompt, evidenceFromIntentIndex, extractContentFacts, extractSpreadsheetFacts, intentRelevance, isIrrelevantProjectGap, mergeProjectGraphs, readProjectIntelligence, sampledSignals, startProjectIntelligenceBuild } from '@/services/document-workflow/projectIntelligence';
import { buildProjectGraph } from '@/services/document-workflow/projectGraph';
import { getMultiProjectManager, getStorageRoot, listKnowledgeFiles } from '@/services/knowledge/kbService';
import { upsertKbOperation } from '@/services/knowledge/kbOperationLog';

function graphOf(): ConstructionOrganizationGraph {
  return {
    workPackages: [{
      name: '结构加固工程',
      scope: '主体结构加固施工',
      quantities: ['混凝土C30：120m³'],
      materials: ['钢筋｜HRB400'],
      process: ['定位放线', '剔凿清理', '植筋施工'],
      methods: ['粘贴碳纤维布'],
      acceptance: ['植筋拉拔试验合格'],
      sourceFiles: ['结构加固.xls'],
    }],
    controlMatrix: [{
      feature: '高支模区域',
      difficulty: '支撑体系风险',
      relatedWorkPackages: ['结构加固工程'],
      methods: ['专项方案'],
      qualityControls: ['验收合格'],
      safetyControls: ['旁站监督'],
    }],
    qualityControls: ['验收合格'],
    safetyControls: ['旁站监督'],
    resourcePlans: ['钢筋｜HRB400｜50t'],
    acceptanceRecords: ['检验批验收记录'],
    evidenceRankingHints: ['优先使用工程量清单、图纸设计说明、技术规范'],
  };
}

// 每个测试独立的临时存储根：缓存/scope 快照落盘不污染真实知识库目录
beforeEach(() => {
  vi.mocked(getStorageRoot).mockReturnValue(path.join(os.tmpdir(), `intel-test-${Date.now()}-${Math.random()}`));
});

describe('constructionOrganizationPrompt', () => {
  it('无图谱或无工作包返回空串', () => {
    expect(constructionOrganizationPrompt(undefined)).toBe('');
    expect(constructionOrganizationPrompt({ ...graphOf(), workPackages: [] })).toBe('');
  });

  it('渲染工作包列表（范围/工程量/流程/验收）', () => {
    const prompt = constructionOrganizationPrompt(graphOf());
    expect(prompt).toContain('## 施工组织设计专项图谱');
    expect(prompt).toContain('主要施工工作包：');
    expect(prompt).toContain('1. 结构加固工程｜范围：主体结构加固施工');
    expect(prompt).toContain('工程量/材料：混凝土C30：120m³；钢筋｜HRB400；粘贴碳纤维布');
    expect(prompt).toContain('流程：定位放线→剔凿清理→植筋施工');
    expect(prompt).toContain('验收：植筋拉拔试验合格');
  });

  it('输出结构化 JSON 数据与重点难点矩阵', () => {
    const prompt = constructionOrganizationPrompt(graphOf());
    expect(prompt).toContain('施工工作包结构化数据：');
    expect(prompt).toContain('"name":"结构加固工程"');
    expect(prompt).toContain('重点难点—施工内容—措施矩阵：');
    expect(prompt).toContain('- 高支模区域 → 结构加固工程 → 专项方案；验收合格；旁站监督');
  });

  it('证据优先级提示作为尾行注入', () => {
    const prompt = constructionOrganizationPrompt(graphOf());
    expect(prompt).toContain('优先使用工程量清单、图纸设计说明、技术规范');
  });
});

describe('readProjectIntelligence', () => {
  it('缓存文件不存在返回 undefined', () => {
    const missingRoot = path.join(os.tmpdir(), `project-intelligence-missing-${Date.now()}-${Math.random()}`);
    expect(readProjectIntelligence(missingRoot)).toBeUndefined();
  });
});

describe('chapterIntentTags 真实施组模板章节覆盖', () => {
  it('6 章模板每章均命中至少一个意图标签', () => {
    const cases: Array<[string, string[]]> = [
      ['针对工程项目整体理解', ['工程概况']],
      ['工程重点难点及危大工程的保障体系与措施', ['安全危大', '工程概况']],
      ['拟采用的新技术、新工艺', ['施工方法']],
      ['确保工期与质量的保障体系与措施', ['工期进度', '质量验收']],
      ['确保人、材、机的保障体系与措施', ['人材机']],
      ['确保安全文明生产的管理体系与措施', ['安全危大', '环境文明']],
    ];
    for (const [title, expected] of cases) {
      const tags = chapterIntentTags(title);
      for (const tag of expected) expect(tags, `${title} 应命中 ${tag}`).toContain(tag);
    }
  });
});

describe('evidenceFromIntentIndex 章节意图证据分配', () => {
  const entries: ProjectIntelligenceIntentEntry[] = [
    { intent: '工期进度', filePath: '招标文件.pdf', title: '招标文件.pdf', content: '本工程计划工期为540日历天', score: 0.82, roleId: 'tender_document' },
    { intent: '工程概况', filePath: '招标文件.pdf', title: '招标文件.pdf', content: '总建筑面积28570平方米', score: 0.82, roleId: 'tender_document' },
    { intent: '人材机', filePath: '清单.xls', title: '清单.xls', content: '劳动力计划：高峰期420人', score: 0.8, roleId: 'bill_of_quantities' },
    { intent: '施工方法', filePath: '图纸.dwg', title: '图纸.dwg', content: '屋面保温层采用130mm挤塑聚苯板', score: 0.8, roleId: 'drawing' },
    { intent: '安全危大', filePath: '图纸.dwg', title: '图纸.dwg', content: '深基坑支护专项方案论证', score: 0.79, roleId: 'drawing' },
    { intent: '环境文明', filePath: '招标文件.pdf', title: '招标文件.pdf', content: '扬尘治理六个百分百要求', score: 0.78, roleId: 'tender_document' },
  ];

  it('真实 6 章模板每章均获得意图证据（含第一章与第五章）', () => {
    const template = {
      id: 'tpl-1', name: '施工组织设计模板', description: '', category: 'document' as const, outputTitle: '施工组织设计',
      chapters: [
        { id: 'ch1', title: '针对工程项目整体理解', sections: [], requiredFacts: [] },
        { id: 'ch2', title: '工程重点难点及危大工程的保障体系与措施', sections: [], requiredFacts: [] },
        { id: 'ch3', title: '拟采用的新技术、新工艺', sections: [], requiredFacts: [] },
        { id: 'ch4', title: '确保工期与质量的保障体系与措施', sections: [], requiredFacts: [] },
        { id: 'ch5', title: '确保人、材、机的保障体系与措施', sections: [], requiredFacts: [] },
        { id: 'ch6', title: '确保安全文明生产的管理体系与措施', sections: [], requiredFacts: [] },
      ],
    };
    const selected = new Set(['招标文件.pdf', '清单.xls', '图纸.dwg']);
    const byChapter = evidenceFromIntentIndex({ template: template as never, entries, selected });
    for (const chapter of template.chapters) {
      expect(byChapter[chapter.id]?.length || 0, `${chapter.title} 应有意图证据`).toBeGreaterThan(0);
    }
    expect(byChapter.ch1?.[0]?.content).toContain('总建筑面积');
    expect(byChapter.ch5?.[0]?.content).toContain('劳动力计划');
  });

  it('非选中文件的条目不进入证据', () => {
    const template = {
      id: 'tpl-1', name: '施工组织设计模板', description: '', category: 'document' as const, outputTitle: '施工组织设计',
      chapters: [{ id: 'ch5', title: '确保人、材、机的保障体系与措施', sections: [], requiredFacts: [] }],
    };
    const byChapter = evidenceFromIntentIndex({ template: template as never, entries, selected: new Set(['清单.xls']) });
    expect(byChapter.ch5?.length || 0).toBeGreaterThan(0);
    expect(byChapter.ch5?.every(ev => ev.filePath === '清单.xls')).toBe(true);
  });
});

describe('extractContentFacts 元数据噪音过滤', () => {
  it('编号/资料类型/标题残留元数据句不入事实', () => {
    const facts = extractContentFacts([
      '项目编号: ABC123456。资料类型: document/office ##徽光阁项目施工招标工程量清单、最高投标限价 # 编制补疑1 # 项目编号',
      '本工程计划工期为540日历天，质量标准为合格，总建筑面积28570平方米',
      '资料名称: 附件.doc 创建时间: 2026-08-01',
    ]);
    expect(facts.some(fact => fact.includes('项目编号'))).toBe(false);
    expect(facts.some(fact => fact.includes('资料类型'))).toBe(false);
    expect(facts.some(fact => fact.includes('资料名称'))).toBe(false);
    expect(facts.some(fact => fact.includes('徽光阁'))).toBe(false);
    expect(facts.some(fact => fact.includes('计划工期'))).toBe(true);
  });
});

const baseGraph = (): Parameters<typeof mergeProjectGraphs>[0] => ({
  works: [], methods: [], resources: [], schedule: [{ milestone: '计划工期', duration: '540个日历天', startDate: '开工之日', endDate: '', sourceFiles: [] }],
  standards: [], risks: [], requirements: [], siteConditions: [], addendumChanges: [], gaps: [], generatedAt: 0,
});

describe('mergeProjectGraphs 已解决缺口清理', () => {
  it('图谱已含工期事实时，移除「工期未找到」类 gap', () => {
    const merged = mergeProjectGraphs(baseGraph(), {
      ...baseGraph(), schedule: [],
      gaps: ['计划工期（540个日历天）在提供的资料中未直接出现，无法从证据中确认', '补疑澄清文件的具体内容未在提供的资料中体现'],
    });
    expect(merged.schedule.some(item => item.duration === '540个日历天')).toBe(true);
    expect(merged.gaps.some(gap => gap.includes('计划工期'))).toBe(false);
    expect(merged.gaps.some(gap => gap.includes('补疑'))).toBe(true);
  });

  it('图谱无对应事实时保留 gap（保守不误删）', () => {
    const merged = mergeProjectGraphs(baseGraph(), {
      ...baseGraph(), schedule: [],
      gaps: ['质量标准（LY/T 1923-2010）在提供的资料中未找到直接证据'],
    });
    expect(merged.gaps.some(gap => gap.includes('质量标准'))).toBe(true);
  });

  it('多标准合并括号声明分段匹配图谱已有标准后移除', () => {
    const graph = baseGraph();
    graph.standards = [{ code: 'LY/T 1923-2010', description: '国家林业局《室内木质门》标准', sourceFiles: [] }, { code: 'DB34/T1264-2010', description: '安徽省地方标准《住宅装饰装修验收标准》', sourceFiles: [] }];
    const merged = mergeProjectGraphs(graph, {
      ...baseGraph(), schedule: [],
      gaps: ['质量标准（LY/T 1923-2010、DB34/T1264-2010）在提供的资料中未找到直接证据'],
    });
    expect(merged.gaps.some(gap => gap.includes('LY/T 1923'))).toBe(false);
  });

  it('无括号泛化声称「未提供计划工期」且 schedule 已有事实时移除', () => {
    const merged = mergeProjectGraphs(baseGraph(), {
      ...baseGraph(), schedule: [],
      gaps: ['未提供计划工期、质量标准等招标管理要求的原文证据', '未提供消防检测验收的具体验收标准或规范编号'],
    });
    expect(merged.gaps.some(gap => gap.includes('计划工期'))).toBe(false);
    // 消防验收规范确实不在图谱中 → 保留
    expect(merged.gaps.some(gap => gap.includes('消防检测验收'))).toBe(true);
  });
});

describe('isIrrelevantProjectGap 施组无关缺口过滤', () => {
  it('评标办法/地质勘察类 gap 判定为无关缺口（确定性排除，防残留注入）', () => {
    const irrelevantGaps = [
      '招标文件中未提供评标办法章节内容，无法抽取评标办法类型、分值构成、技术文件详细评审内容项及评分档位线',
      '技术文件详细评审内容项未在提供的资料中明确出现',
      '未提供详细的地质勘察报告或土壤氡检测数据',
      '未提供地勘报告，无法确认地基承载力设计参数',
      '未提供评标细则，无法确认评标委员会组成',
    ];
    for (const gap of irrelevantGaps) expect(isIrrelevantProjectGap(gap), `${gap} 应判定为无关缺口`).toBe(true);
  });

  it('真实资料缺口不误判为无关缺口', () => {
    const relevantGaps = [
      '未提供消防检测验收的具体验收标准或规范编号',
      '未提供分包工程的具体范围和分包单位信息',
      '补疑澄清文件的具体内容未在提供的资料中体现',
    ];
    for (const gap of relevantGaps) expect(isIrrelevantProjectGap(gap), `${gap} 应保留`).toBe(false);
  });

  it('mergeProjectGraphs 移除评标办法与地质勘察 gap，真实缺口保留', () => {
    const merged = mergeProjectGraphs(baseGraph(), {
      ...baseGraph(), schedule: [],
      gaps: [
        '招标文件中未提供评标办法章节内容，无法抽取评标办法类型、分值构成、技术文件详细评审内容项及评分档位线',
        '未提供详细的地质勘察报告或土壤氡检测数据',
        '未提供消防检测验收的具体验收标准或规范编号',
      ],
    });
    expect(merged.gaps.some(gap => gap.includes('评标办法'))).toBe(false);
    expect(merged.gaps.some(gap => gap.includes('地质勘察'))).toBe(false);
    expect(merged.gaps.some(gap => gap.includes('消防检测验收'))).toBe(true);
  });
});

describe('mergeProjectGraphs 泛化声称按图谱类别清理', () => {
  it('LLM 泛化声称与图谱已有事实矛盾时移除，真实缺失保留', () => {
    const graph = baseGraph();
    // 确定性 base 图谱已有事实：建设规模/工程量清单/验收标准/补疑澄清/风险
    graph.works = [{ name: '当前项目', scope: '建设规模：总建筑面积28570.36平方米', sourceFiles: [], relatedItems: [] }];
    graph.resources = [{ name: '工程量清单', type: 'material', spec: '1土建与装饰工程.xls', quantity: '', unit: '', sourceFiles: [] }];
    graph.standards = [{ code: '验收标准', description: '分部分项工程验收合格', sourceFiles: [] }];
    graph.requirements = [{ category: '补疑澄清', detail: '补疑4：工程量清单与最高投标限价编制补疑', sourceFiles: [] }];
    graph.risks = [{ risk: '深基坑支护专项方案论证', level: 'medium', mitigation: '', sourceFiles: [] }];
    const merged = mergeProjectGraphs(graph, {
      ...baseGraph(), schedule: [], methods: [{ name: '装配式叠合板安装', steps: ['吊装', '固定'], applicableWorks: [], sourceFiles: [] }],
      gaps: [
        '未提供建设规模具体数据（如建筑面积、层数、投资额等）',
        '未提供招标范围明确描述',
        '未提供工程量清单，无法提取具体工程量数据',
        '未提供设备表的具体设备名称、数量、参数等详细信息（仅提及高温消防轴流通风机）',
        '未提供施工进度计划、工期安排等时间信息',
        '未提供明确的开工令时间，无法计算具体开工日期和竣工日期',
        '未提供施工方法、工艺流程等具体施工方案',
        '未提供完整的验收标准清单，仅能提取部分验收要求',
        '未提供补疑澄清文件的具体内容，无法提取补疑澄清文件中的变更信息',
        '未提供项目风险相关内容',
        '未提供明确的竣工验收报告或合同文件，无法确认建设规模以合同为准还是以竣工验收报告为准',
        '未提供劳动力资源的具体信息',
      ],
    });
    for (const removed of ['建设规模', '招标范围', '工程量清单', '设备表', '施工进度计划', '开工令', '施工方法', '验收标准', '补疑澄清', '项目风险', '竣工验收报告']) {
      expect(merged.gaps.some(gap => gap.includes(removed)), `${removed} 类 gap 应已清理`).toBe(false);
    }
    // 劳动力计划确属招标资料未提供的真实缺口 → 保留
    expect(merged.gaps.some(gap => gap.includes('劳动力'))).toBe(true);
  });

  it('category 误标「评标办法」的 requirements 条目确定性清除（内容已在他类覆盖）', () => {
    const graph = baseGraph();
    graph.requirements = [{ category: '工程范围', detail: '包含装配式建筑，装配率不低于30%', sourceFiles: [] }];
    const merged = mergeProjectGraphs(graph, {
      ...baseGraph(), schedule: [],
      requirements: [
        { category: '评标办法', detail: '本工程有装配式技术要求，装配率为30%', sourceFiles: [] },
        { category: '补疑澄清', detail: '补疑4：工程量清单与最高投标限价编制补疑', sourceFiles: [] },
      ],
    });
    expect(merged.requirements.some(item => item.category.includes('评标'))).toBe(false);
    expect(merged.requirements.some(item => item.category === '补疑澄清')).toBe(true);
    expect(merged.requirements.some(item => item.detail.includes('装配率不低于30%'))).toBe(true);
  });
});

describe('buildBaseProjectGraph 确定性内容事实参与图谱构建', () => {
  it('「资料内容事实」构建 works/schedule/resources，元数据键不参与', () => {
    const facts = [
      { key: '资料内容事实', value: '建设规模：总建筑面积28570.36平方米，为中型公共建筑', sourceFile: '招标文件.pdf', roleId: 'project_overview', processingType: 'project_intelligence', confidence: 0.76 },
      { key: '资料内容事实', value: '计划工期：开工之日起540个日历天', sourceFile: '招标文件.pdf', roleId: 'project_overview', processingType: 'project_intelligence', confidence: 0.76 },
      { key: '资料内容事实', value: '主要材料：C35混凝土、HRB400钢筋', sourceFile: '招标文件.pdf', roleId: 'project_overview', processingType: 'project_intelligence', confidence: 0.76 },
      { key: '资料文件', value: '招标文件.pdf', sourceFile: '招标文件.pdf', roleId: 'project_overview', processingType: 'project_intelligence', confidence: 0.6 },
    ];
    const snapshot = {
      files: [{ path: '招标文件.pdf', root: '招标文件', fileName: '招标文件.pdf', chunkCount: 134, hash: 'h1' }],
      totalFiles: 1, totalChunks: 134, roots: ['招标文件'], createdAt: 0, snapshotHash: 'x',
    };
    const graph = buildBaseProjectGraph({ facts, materialSnapshot: snapshot });
    expect(graph.works.length).toBeGreaterThan(0);
    expect(graph.schedule.some(item => item.duration.includes('540'))).toBe(true);
    expect(graph.resources.some(item => item.spec.includes('C35'))).toBe(true);
    expect(graph.gaps).toEqual([]);
  });
});

describe('extractSpreadsheetFacts 语义列定位（F2）', () => {
  /** 15 列偏移 markdown 表 chunk：标题行 + 真表头 + 数据行 */
  function offset15Chunk(): string {
    return [
      '| E.1 分部分项工程量清单计价表 | | | | | | | | | | | | | | |',
      '| 序号 | 项目编码 | | | 项目名称 | 项目特征描述 | | | | 计量单位 | | | 工程量 | | |',
      '| 1 | 010101001001 | | | 垫层 | 1.混凝土强度等级:C15 | | | | m3 | | | 125.80 | | |',
      '| 2 | 010502001001 | | | 矩形柱 | 1.混凝土强度等级:C35 | | | | m3 | | | 86.40 | | |',
    ].join('\n');
  }

  it('15 列偏移表：表头行按列关键词识别，名称/特征/工程量按语义列提取（非 body[2]/body[3]）', () => {
    const facts = extractSpreadsheetFacts([{ content: offset15Chunk() }]);
    expect(facts).toContain('垫层：1.混凝土强度等级:C15｜125.80m3');
    expect(facts).toContain('矩形柱：1.混凝土强度等级:C35｜86.40m3');
  });

  it('标题行（仅命中「工程量」一组）不误判为表头：其后的真表头重建列映射', () => {
    const facts = extractSpreadsheetFacts([{ content: offset15Chunk() }]);
    expect(facts.length).toBe(2);
  });

  it('大表分块：表头只在首 chunk，列映射跨 chunk 延续', () => {
    const headerChunk = [
      '| 序号 | 项目编码 | | | 项目名称 | 项目特征描述 | | | | 计量单位 | | | 工程量 | | |',
      '| 1 | 010101001001 | | | 垫层 | 1.混凝土强度等级:C15 | | | | m3 | | | 125.80 | | |',
    ].join('\n');
    const dataChunk = [
      '| 2 | 010502001001 | | | 矩形柱 | 1.混凝土强度等级:C35 | | | | m3 | | | 86.40 | | |',
    ].join('\n');
    const facts = extractSpreadsheetFacts([{ content: headerChunk }, { content: dataChunk }]);
    expect(facts).toContain('垫层：1.混凝土强度等级:C15｜125.80m3');
    expect(facts).toContain('矩形柱：1.混凝土强度等级:C35｜86.40m3');
  });

  it('无表头 chunk（旧形态直接数据行）→ 回退历史 body[N] 列位不丢数据', () => {
    const chunk = [
      '| 1 | | 垫层 | 1.混凝土强度等级:C15 | m3 | 125.80 | |',
    ].join('\n');
    const facts = extractSpreadsheetFacts([{ content: chunk }]);
    expect(facts).toContain('垫层：1.混凝土强度等级:C15｜125.80m3');
  });

  it('表头行本身与序号非整数行不产出事实', () => {
    const chunk = [
      '| 序号 | 项目编码 | | | 项目名称 | 项目特征描述 | | | | 计量单位 | | | 工程量 | | |',
      '| 分部小计 | | | | 本页小计 | 汇总本表 | | | | | | | | | |',
    ].join('\n');
    expect(extractSpreadsheetFacts([{ content: chunk }])).toEqual([]);
  });
});

describe('startProjectIntelligenceBuild 并发守卫', () => {
  beforeEach(() => {
    vi.mocked(getMultiProjectManager).mockReset();
    vi.mocked(listKnowledgeFiles).mockReset();
    vi.mocked(listKnowledgeFiles).mockReturnValue([] as never);
    vi.mocked(buildProjectGraph).mockReset();
    vi.mocked(upsertKbOperation).mockReset();
  });

  /** 从 upsertKbOperation 调用序列中取 percent === 5 的次数（= 真实构建启动次数：
   * 每次启动恰好写一条 5% 初始日志，中间进度日志均为 percent > 5） */
  const startCount = () => vi.mocked(upsertKbOperation).mock.calls.filter(call => (call[1] as { percent?: number }).percent === 5).length;

  it('无并发时正常触发一次构建，失败后不重跑（无待重跑标记）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(getMultiProjectManager).mockReturnValue({ getProject: vi.fn(() => Promise.reject(new Error('项目不存在'))) } as never);
      startProjectIntelligenceBuild('/proj-guard-once');
      expect(startCount()).toBe(1);
      expect(upsertKbOperation).toHaveBeenCalledWith('/proj-guard-once', expect.objectContaining({ id: expect.any(String), type: 'reindex', title: '项目理解缓存', stage: 'generating', status: 'processing', percent: 5 }));
      await vi.waitFor(() => expect(upsertKbOperation).toHaveBeenCalledWith('/proj-guard-once', expect.objectContaining({ stage: 'error', status: 'error', error: '项目不存在' })));
      expect(startCount()).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('构建进行中多次触发合并为一次串行重跑（不并发构建，不写竞态）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      let rejectFirst!: (reason: Error) => void;
      vi.mocked(getMultiProjectManager).mockReturnValue({
        getProject: vi.fn(() => {
          calls += 1;
          // 首次构建挂起（模拟 LLM 图谱长任务），重跑时立即失败
          return calls === 1
            ? new Promise<never>((_resolve, reject) => { rejectFirst = reject; })
            : Promise.reject(new Error('项目不存在'));
        }),
      } as never);
      // 首次触发启动构建；随后两次触发仅标记待重跑，不启动新构建
      startProjectIntelligenceBuild('/proj-guard');
      startProjectIntelligenceBuild('/proj-guard');
      startProjectIntelligenceBuild('/proj-guard');
      expect(startCount()).toBe(1);
      // 进行中的构建失败结束：期间多次触发合并为一次串行重跑
      rejectFirst(new Error('项目不存在'));
      await vi.waitFor(() => expect(startCount()).toBe(2));
      await vi.waitFor(() => expect(vi.mocked(upsertKbOperation).mock.calls.filter(call => (call[1] as { stage?: string }).stage === 'error').length).toBe(2));
      // 重跑结束后不再有第三次触发
      expect(startCount()).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('构建失败后待重跑标记仍生效（finally 兜底不吞重跑）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(getMultiProjectManager).mockReturnValue({ getProject: vi.fn(() => Promise.reject(new Error('LLM 前置失败'))) } as never);
      startProjectIntelligenceBuild('/proj-guard-fail');
      startProjectIntelligenceBuild('/proj-guard-fail');
      expect(startCount()).toBe(1);
      await vi.waitFor(() => expect(startCount()).toBe(2));
      await vi.waitFor(() => expect(upsertKbOperation).toHaveBeenCalledWith('/proj-guard-fail', expect.objectContaining({ stage: 'error', status: 'error', error: 'LLM 前置失败' })));
      expect(startCount()).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('sampledSignals 尾块信号保留', () => {
  it('信号数不超过上限时全部保留', () => {
    const chunks = Array.from({ length: 10 }, (_, i) => ({ content: `信号内容第${i}条，含施工质量要求` }));
    expect(sampledSignals(chunks)).toHaveLength(10);
  });

  it('超过上限时保留前 limit-4 + 最后 4 条（尾块信号不被裁掉）', () => {
    const chunks = Array.from({ length: 60 }, (_, i) => ({ content: `正文信号第${i}条施工内容` }));
    const signals = sampledSignals(chunks);
    expect(signals).toHaveLength(48);
    expect(signals[0]).toContain('第0条');
    expect(signals[43]).toContain('第43条');
    // 最后 4 条为文档尾部信号（旧实现 slice(0,48) 会丢失）
    expect(signals[44]).toContain('第56条');
    expect(signals[47]).toContain('第59条');
  });

  it('空内容块被过滤后再计上限', () => {
    const chunks = [{ content: '' }, { content: '   ' }, ...Array.from({ length: 50 }, (_, i) => ({ content: `有效信号第${i}条` }))];
    const signals = sampledSignals(chunks);
    expect(signals).toHaveLength(48);
    expect(signals).not.toContain('');
  });
});

describe('intentRelevance 意图相关性评分', () => {
  it('关键词命中加权：长词权重高于短词', () => {
    const longHit = intentRelevance('工期进度', '本工程计划工期为540日历天');
    const shortHit = intentRelevance('工期进度', '施工进度节点按计划推进');
    expect(longHit).toBeGreaterThan(shortHit);
  });

  it('数值驱动事实额外加权（工期天数/工程量数字）', () => {
    const withNumber = intentRelevance('工期进度', '本工程计划工期为540日历天');
    const withoutNumber = intentRelevance('工期进度', '本工程计划工期见招标文件');
    expect(withNumber).toBeGreaterThan(withoutNumber);
  });

  it('无关事实评分为 0（不再混入意图索引）', () => {
    expect(intentRelevance('安全危大', '投标截止时间为2026年9月10日')).toBe(0);
    expect(intentRelevance('未知意图', '任意内容')).toBe(0);
  });
});

describe('buildProjectIntelligence LLM 失败降级落盘', () => {
  const kbFile = { relativePath: '资料/招标文件.pdf', contentHash: 'h1', chunkCount: 3, status: 'ok', indexedAt: 123, category: 'document', format: 'pdf', mtime: 0 };

  it('LLM 图谱构建失败：降级为确定性 base 图谱落盘，缓存仍可用且标记 graphDegraded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(listKnowledgeFiles).mockReturnValue([kbFile] as never);
      vi.mocked(getMultiProjectManager).mockReturnValue({
        getProject: vi.fn(async () => ({ listChunksSampled: () => [{ content: '计划工期：开工之日起540个日历天，质量标准为合格，总建筑面积28570.36平方米' }] })),
      } as never);
      vi.mocked(buildProjectGraph).mockRejectedValue(new Error('LLM 服务不可用'));
      const root = `/proj-degrade-${Date.now()}`;
      const cache = await buildProjectIntelligence(root);
      expect(cache.graphDegraded).toBe(true);
      expect(cache.projectGraphMessage).toContain('降级');
      expect(cache.projectGraphMessage).toContain('LLM 增强失败');
      // 确定性图谱仍含事实驱动的工期节点
      expect(cache.projectGraph.schedule.some(item => String(item.duration).includes('540'))).toBe(true);
      // 缓存已落盘（原子写），且可被 readProjectIntelligence 读取
      const onDisk = JSON.parse(fs.readFileSync(path.join(getStorageRoot(), 'projects', computeProjectId(root), 'project-intelligence', 'project-intelligence.json'), 'utf8'));
      expect(onDisk.graphDegraded).toBe(true);
      expect(readProjectIntelligence(root)).toBeDefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('readProjectIntelligence 惰性自愈重建', () => {
  const cacheFile = (projectRoot: string) => path.join(getStorageRoot(), 'projects', computeProjectId(projectRoot), 'project-intelligence', 'project-intelligence.json');

  it('缓存存在但文件集不匹配：拒绝使用并触发后台重建', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const getProject = vi.fn(() => Promise.reject(new Error('自愈构建失败（预期）')));
      vi.mocked(getMultiProjectManager).mockReturnValue({ getProject } as never);
      const root = `/proj-selfheal-${Date.now()}`;
      fs.mkdirSync(path.dirname(cacheFile(root)), { recursive: true });
      fs.writeFileSync(cacheFile(root), JSON.stringify({
        version: 'project-intelligence-v11',
        projectGraph: { works: [] },
        files: [{ relativePath: 'ghost.txt', contentHash: 'x', chunkCount: 1, status: 'ok' }],
        facts: [], chapterIntentIndex: [],
      }));
      expect(readProjectIntelligence(root)).toBeUndefined();
      // 自愈已触发：后台构建启动（getProject 被调用）
      await vi.waitFor(() => expect(getProject).toHaveBeenCalled());
      // 节流：1 分钟内再次读取不重复触发（第二次 read 不新增构建调用）
      const callsBefore = getProject.mock.calls.length;
      expect(readProjectIntelligence(root)).toBeUndefined();
      expect(getProject.mock.calls.length).toBe(callsBefore);
    } finally {
      warn.mockRestore();
    }
  });

  it('graphDegraded 降级缓存：仍可用，同时后台重试补齐 LLM 增强', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const kbFile = { relativePath: '资料/招标文件.pdf', contentHash: 'h1', chunkCount: 3, status: 'ok', indexedAt: 123, category: 'document', format: 'pdf', mtime: 0 };
      vi.mocked(listKnowledgeFiles).mockReturnValue([kbFile] as never);
      vi.mocked(getMultiProjectManager).mockReturnValue({ getProject: vi.fn(() => Promise.reject(new Error('重试失败（预期）'))) } as never);
      const root = `/proj-degraded-heal-${Date.now()}`;
      fs.mkdirSync(path.dirname(cacheFile(root)), { recursive: true });
      fs.writeFileSync(cacheFile(root), JSON.stringify({
        version: 'project-intelligence-v11',
        projectGraph: { works: [] },
        graphDegraded: true,
        files: [{ relativePath: '资料/招标文件.pdf', contentHash: 'h1', chunkCount: 3, status: 'ok' }],
        facts: [], chapterIntentIndex: [],
        constructionOrganizationGraph: { workPackages: [], controlMatrix: [], qualityControls: [], safetyControls: [], resourcePlans: [], acceptanceRecords: [], evidenceRankingHints: [] },
      }));
      const cache = readProjectIntelligence(root);
      expect(cache).toBeDefined();
      expect(cache?.graphDegraded).toBe(true);
      // 后台重试已触发（getProject 被调用），且不阻塞缓存读取
      await vi.waitFor(() => expect(vi.mocked(getMultiProjectManager).mock.calls.length).toBeGreaterThan(0));
    } finally {
      warn.mockRestore();
    }
  });
});

describe('buildProjectIntelligenceSync 同步构建并发守卫', () => {
  beforeEach(() => {
    vi.mocked(getMultiProjectManager).mockReset();
    vi.mocked(listKnowledgeFiles).mockReset();
    vi.mocked(listKnowledgeFiles).mockReturnValue([] as never);
    vi.mocked(buildProjectGraph).mockReset();
    vi.mocked(upsertKbOperation).mockReset();
  });

  it('构建进行中时复用同一构建（不重复启动，不并发写）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      let releaseGet!: (project: { listChunksSampled: () => never[] }) => void;
      vi.mocked(getMultiProjectManager).mockReturnValue({
        getProject: vi.fn(() => {
          calls += 1;
          return new Promise(resolve => { releaseGet = resolve; });
        }),
      } as never);
      const root = `/proj-sync-guard-${Date.now()}`;
      startProjectIntelligenceBuild(root);
      const syncPromise = buildProjectIntelligenceSync(root);
      expect(calls).toBe(1);
      // 释放挂起：两种触发路径共享同一构建，完成后同步等待方拿到结果
      releaseGet({ listChunksSampled: () => [] } as never);
      const cache = await syncPromise;
      expect(cache.fileCount).toBe(0);
      expect(calls).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('buildProjectIntelligence 进度回调', () => {
  beforeEach(() => {
    vi.mocked(getMultiProjectManager).mockReset();
    vi.mocked(listKnowledgeFiles).mockReset();
    vi.mocked(listKnowledgeFiles).mockReturnValue([] as never);
    vi.mocked(buildProjectGraph).mockReset();
    vi.mocked(upsertKbOperation).mockReset();
  });

  it('onProgress 各阶段回调按顺序触发（files → facts → graph）', async () => {
    const stages: string[] = [];
    vi.mocked(getMultiProjectManager).mockReturnValue({ getProject: vi.fn(async () => ({ listChunksSampled: () => [] })) } as never);
    vi.mocked(buildProjectGraph).mockResolvedValue({ graph: { works: [], methods: [], resources: [], schedule: [], standards: [], risks: [], requirements: [], siteConditions: [], addendumChanges: [], gaps: [], generatedAt: 0 }, stage: { roleId: 'x', status: 'success' } } as never);
    const root = `/proj-progress-${Date.now()}`;
    await buildProjectIntelligence(root, (stage) => { stages.push(stage); });
    expect(stages).toEqual(['files', 'facts', 'graph', 'assembly']);
  });
});
