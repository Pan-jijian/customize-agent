import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { buildBaseProjectGraph } from '@/services/document-workflow/agentWorkflow';
import type { ConstructionOrganizationGraph, ProjectIntelligenceIntentEntry } from '@/services/document-workflow/projectIntelligence';
import { chapterIntentTags, constructionOrganizationPrompt, evidenceFromIntentIndex, extractContentFacts, isIrrelevantProjectGap, mergeProjectGraphs, readProjectIntelligence } from '@/services/document-workflow/projectIntelligence';

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
