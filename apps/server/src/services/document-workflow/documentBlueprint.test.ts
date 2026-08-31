/**
 * documentBlueprint 单测：文档类型画像、事实域覆盖目标、章节资料支撑度判定、专业写作要点、
 * 章节实施方案/任务卡、全局文档蓝图上下文（事实主表/冲突裁决/参考线/丢弃提示）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildDocumentBlueprintContext,
  chapterExecutionPlanLine,
  chapterTaskCardLine,
  documentProfileForContext,
  factCoverageMatrixLines,
  factCoverageTargetsForTitle,
  professionalPointsForTitle,
  supportLevelForChapter,
} from './documentBlueprint';
import type { DocumentFact, DocumentFactsModel, DocumentTemplate, DocumentTemplateChapter, NumericScopeConflict } from './types';

const templateChapter = (title: string, overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter => ({
  id: `c-${title}`,
  title,
  purpose: `${title}写作目标`,
  queries: [`${title}资料查询`],
  requiredFacts: [`${title}事实`],
  ...overrides,
});

const template = (overrides: Partial<DocumentTemplate> = {}): DocumentTemplate => ({
  id: 't1',
  name: '施工组织设计',
  description: '',
  category: '施工组织设计',
  outputTitle: '合肥某安置房项目施工组织设计',
  chapters: [templateChapter('工程概况'), templateChapter('施工进度计划')],
  ...overrides,
});

const fact = (key: string, value: string, overrides: Partial<DocumentFact> = {}): DocumentFact => ({
  key,
  value,
  sourceFile: '',
  roleId: '',
  confidence: 1,
  ...overrides,
});

type BlueprintFacts = Pick<DocumentFactsModel, 'project' | 'schedule' | 'quality' | 'safety' | 'resources' | 'preciseFacts' | 'bills' | 'drawings' | 'rules' | 'specifications'>;

const factsModel = (overrides: Partial<BlueprintFacts> = {}): BlueprintFacts => ({
  project: [fact('projectName', '合肥市某安置房项目')],
  schedule: [fact('duration', '总工期420日历天')],
  quality: [fact('qualityGoal', '质量目标合格')],
  safety: [fact('safetyGoal', '杜绝死亡事故')],
  resources: [fact('labor', '劳动力高峰120人')],
  preciseFacts: [],
  bills: [fact('billMain', '工程量清单共56项')],
  drawings: [fact('drawingMain', '建筑总图1张')],
  rules: [],
  specifications: [fact('specMain', 'GB50204-2015')],
  ...overrides,
});

describe('documentProfileForContext', () => {
  it('专项施工/危大关键词 → 专项施工方案画像', () => {
    const profile = documentProfileForContext({ template: template({ name: '危大工程专项施工方案' }), chapters: [], requirement: '' });
    expect(profile.type).toBe('专项施工方案');
    expect(profile.focus).toContain('专项对象边界');
  });

  it('投标/招标关键词 → 投标技术方案画像', () => {
    const profile = documentProfileForContext({ template: template(), chapters: [], requirement: '响应招标文件全部要求' });
    expect(profile.type).toBe('投标技术方案');
    expect(profile.focus).toContain('招标响应');
  });

  it('监理关键词 → 监理规划/细则画像', () => {
    const profile = documentProfileForContext({ template: template({ name: '主体结构监理规划' }), chapters: [], requirement: '' });
    expect(profile.type).toBe('监理规划/细则');
    expect(profile.focus).toContain('旁站巡视');
  });

  it('可研关键词 → 可研/项目建议类文档画像', () => {
    const profile = documentProfileForContext({ template: template({ name: '项目可行性研究报告' }), chapters: [], requirement: '' });
    expect(profile.type).toBe('可研/项目建议类文档');
  });

  it('运维关键词 → 运维维护方案画像', () => {
    const profile = documentProfileForContext({ template: template({ name: '设备维护保养方案' }), chapters: [], requirement: '' });
    expect(profile.type).toBe('运维维护方案');
    expect(profile.focus).toContain('巡检频次');
  });

  it('无关键词 → 施工组织设计/施工技术方案默认画像', () => {
    const profile = documentProfileForContext({ template: template(), chapters: [], requirement: '' });
    expect(profile.type).toBe('施工组织设计/施工技术方案');
    expect(profile.focus).toContain('工程概况');
  });

  it('专项施工判定优先于投标判定', () => {
    const profile = documentProfileForContext({ template: template({ name: '深基坑专项施工方案' }), chapters: [], requirement: '响应招标要求' });
    expect(profile.type).toBe('专项施工方案');
  });
});

describe('factCoverageTargetsForTitle', () => {
  it('工程概况类标题 → project + scope', () => {
    expect(factCoverageTargetsForTitle('工程概况')).toEqual(['project', 'scope']);
  });

  it('进度类标题 → project/scope/schedule/resources/quantities', () => {
    expect(factCoverageTargetsForTitle('施工进度计划')).toEqual(['project', 'scope', 'schedule', 'resources', 'quantities']);
  });

  it('质量类标题 → project/quality（无施工词不触发 scope）', () => {
    expect(factCoverageTargetsForTitle('质量保证措施')).toEqual(['project', 'quality']);
  });

  it('安全类标题 → project/scope/safety/quantities', () => {
    expect(factCoverageTargetsForTitle('安全文明施工措施')).toEqual(['project', 'scope', 'safety', 'quantities']);
  });

  it('无关键词标题 → 仅 project（去重后）', () => {
    expect(factCoverageTargetsForTitle('附录说明')).toEqual(['project']);
  });
});

describe('factCoverageMatrixLines', () => {
  it('输出编号 + 标题 + 事实域中文标签', () => {
    const lines = factCoverageMatrixLines([templateChapter('工程概况'), templateChapter('施工进度计划')]);
    expect(lines[0]).toBe('1. 工程概况：项目基础事实、招标范围/施工边界');
    expect(lines[1]).toContain('2. 施工进度计划：');
    expect(lines[1]).toContain('工期与节点');
    expect(lines[1]).toContain('清单/图纸/工程量事实');
  });
});

describe('supportLevelForChapter', () => {
  it('全部事实域支撑 → strong/project-specific', () => {
    const support = supportLevelForChapter(templateChapter('工程概况'), factsModel());
    expect(support.level).toBe('strong');
    expect(support.mode).toBe('project-specific');
    expect(support.missing).toEqual([]);
  });

  it('支撑占比 ≥0.4 且 <0.75 → medium/standard-based', () => {
    // 施工进度计划 targets = [project, scope, schedule, resources, quantities]；
    // 仅 schedule/resources/bills/drawings 支撑（project 空）→ 4/5 = 0.8 为 strong，
    // 故此处清空 bills/drawings，仅 schedule+resources 支撑 → 2/5 = 0.4 → medium
    const support = supportLevelForChapter(
      templateChapter('施工进度计划'),
      factsModel({ project: [], drawings: [], bills: [] }),
    );
    expect(support.level).toBe('medium');
    expect(support.mode).toBe('standard-based');
    expect(support.missing).toEqual(['project', 'scope', 'quantities']);
  });

  it('支撑占比 <0.4 → weak/restricted-general', () => {
    // 质量保证措施 targets = [project, quality]；project/drawings/quality/specifications 全空 → 0/2 → weak
    const support = supportLevelForChapter(templateChapter('质量保证措施'), factsModel({ project: [], drawings: [], quality: [], specifications: [] }));
    expect(support.level).toBe('weak');
    expect(support.mode).toBe('restricted-general');
    expect(support.supported).toEqual([]);
    expect(support.missing).toEqual(['project', 'quality']);
  });

  it('无任何支撑 → weak 且 supported 为空', () => {
    const support = supportLevelForChapter(templateChapter('附录说明'), factsModel({ project: [], drawings: [] }));
    expect(support.level).toBe('weak');
    expect(support.supported).toEqual([]);
    expect(support.missing).toEqual(['project']);
  });

  it('quality 可由 specifications 代偿支撑、safety 可由 rules 代偿', () => {
    // 质量保证措施：project 空、quality 空，但 specifications 非空 → quality 域支撑
    const support = supportLevelForChapter(templateChapter('质量保证措施'), factsModel({ project: [], drawings: [], quality: [] }));
    expect(support.supported).toContain('quality');
  });
});

describe('professionalPointsForTitle', () => {
  it('概况类标题要点', () => {
    const points = professionalPointsForTitle('工程概况');
    expect(points).toHaveLength(3);
    expect(points[0]).toContain('工程基础信息必须与资料一致');
  });

  it('部署类标题要点', () => {
    expect(professionalPointsForTitle('施工总体部署')[0]).toContain('施工组织逻辑');
  });

  it('进度类标题要点', () => {
    expect(professionalPointsForTitle('施工进度计划').some(point => point.includes('总工期和关键线路'))).toBe(true);
  });

  it('质量/安全/资源/施工类标题各有专属要点', () => {
    expect(professionalPointsForTitle('质量保证措施')[0]).toContain('材料进场验收');
    expect(professionalPointsForTitle('安全文明施工')[0]).toContain('作业风险');
    expect(professionalPointsForTitle('劳动力配置计划')[0]).toContain('工程范围和进度组织资源配置');
    expect(professionalPointsForTitle('主要施工方法')[0]).toContain('施工准备、工艺流程');
  });

  it('无关键词标题回落通用要点', () => {
    const points = professionalPointsForTitle('其他说明');
    expect(points).toHaveLength(2);
    expect(points[0]).toContain('对象范围、实施方法、控制要点和验收闭环');
  });
});

describe('chapterExecutionPlanLine', () => {
  it('含写作模式/支撑度/已支撑与缺失事实域/章节目标/组织顺序/禁止内容', () => {
    const line = chapterExecutionPlanLine(templateChapter('施工进度计划', { sections: ['总进度安排', '关键线路'] }), factsModel());
    expect(line).toContain('章节实施方案：施工进度计划');
    expect(line).toContain('写作模式：');
    expect(line).toContain('已支撑事实域：');
    expect(line).toContain('系统暂未确认事实域：');
    expect(line).toContain('章节目标：');
    expect(line).toContain('组织顺序：总进度安排 → 关键线路');
    expect(line).toContain('禁止内容：');
  });

  it('无 sections 时组织顺序回落模板提示', () => {
    const line = chapterExecutionPlanLine(templateChapter('工程概况'), factsModel());
    expect(line).toContain('组织顺序：按模板章节目标展开');
  });
});

describe('chapterTaskCardLine', () => {
  it('含事实域/专业要点/小节任务', () => {
    const line = chapterTaskCardLine(templateChapter('施工进度计划', { sections: ['总进度安排'] }));
    expect(line).toContain('章节任务卡：施工进度计划');
    expect(line).toContain('必须覆盖事实域：project、scope、schedule、resources、quantities');
    expect(line).toContain('小节任务：总进度安排｜');
  });

  it('tablePlans 渲染必写/按需表格清单', () => {
    const line = chapterTaskCardLine(
      templateChapter('工程概况', {
        tablePlans: [
          {
            id: 'tp-1', title: '主要材料表', chapterTitle: '工程概况', moduleTitle: '主要材料',
            fields: [{ name: '材料名称', required: true, sourceDomain: 'resources', sourceHint: '来自资源投入事实', fallbackPolicy: 'projectFactOnly' }, { name: '规格', required: true, sourceDomain: 'methods', sourceHint: '来自施工方法', fallbackPolicy: 'standardAllowed' }],
            sourceDomains: ['resources', 'methods'], required: true, reason: '支撑资源配置',
          },
          {
            id: 'tp-2', title: '参考图集', chapterTitle: '工程概况', moduleTitle: '参考图集',
            fields: [{ name: '图集编号', required: false, sourceDomain: 'standards', sourceHint: '来自规范标准', fallbackPolicy: 'standardAllowed' }],
            sourceDomains: ['standards'], required: false, reason: '按需补充',
          },
        ],
      }),
    );
    expect(line).toContain('本章必须按项目图谱生成以下表格/清单：');
    expect(line).toContain('必写《主要材料表》：字段=材料名称、规格；来源域=resources、methods；支撑资源配置');
    expect(line).toContain('按需《参考图集》');
  });

  it('无 tablePlans 时不渲染表格清单行', () => {
    expect(chapterTaskCardLine(templateChapter('工程概况'))).not.toContain('本章必须按项目图谱生成');
  });
});

describe('buildDocumentBlueprintContext', () => {
  it('factsModel 为空 → 提示事实确认不足且正文禁止编造', () => {
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel({ project: [], schedule: [], quality: [], safety: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [] }),
    });
    expect(blueprint).toContain('系统当前结构化事实确认不足');
    expect(blueprint).toContain('不得编造参数');
  });

  it('渲染文档画像、事实主表与证据追踪清单', () => {
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel(),
    });
    expect(blueprint).toContain('文档类型画像：施工组织设计/施工技术方案');
    expect(blueprint).toContain('可信基础事实主表');
    expect(blueprint).toContain('关键事实证据追踪清单');
    expect(blueprint).toContain('projectName：合肥市某安置房项目');
    expect(blueprint).toContain('事实覆盖矩阵');
    expect(blueprint).toContain('知识库确认覆盖矩阵');
    expect(blueprint).toContain('跨章一致性要求');
  });

  it('requirement 渲染为用户目标行', () => {
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel(),
      requirement: '突出创优目标',
    });
    expect(blueprint).toContain('用户目标：突出创优目标');
  });

  it('同 key+value 事实去重（只保留首个）', () => {
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel({ project: [fact('projectName', '合肥市某安置房项目'), fact('projectName', '合肥市某安置房项目', { sourceFile: '/data/招标文件.docx' })] }),
    });
    const count = (blueprint.match(/projectName：合肥市某安置房项目/gu) || []).length;
    expect(count).toBe(1);
  });

  it('空值事实被过滤', () => {
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel({ project: [fact('empty', '   ')], schedule: [], quality: [], safety: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [] }),
    });
    expect(blueprint).toContain('系统当前结构化事实确认不足');
  });

  it('超过 48 个核心事实时记录丢弃提示', () => {
    const manyFacts = Array.from({ length: 60 }, (_, index) => fact(`precise-${index}`, `专项参数事实第${index}条：钢筋间距150mm`));
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel({ preciseFacts: manyFacts }),
    });
    expect(blueprint).toContain('个低优先级事实未纳入蓝图');
  });

  it('scopeConflicts 有裁决口径时输出裁决行', () => {
    const conflicts: NumericScopeConflict[] = [
      {
        kind: 'area',
        scope: '总建筑面积',
        values: [
          { value: '12000', unit: 'm²', sourceFile: '/data/招标文件.docx', priority: 2 },
          { value: '11500', unit: 'm²', sourceFile: '/data/补疑.docx', priority: 3 },
        ],
        resolution: '以补疑文件 11500m² 为准',
      },
    ];
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel(),
      scopeConflicts: conflicts,
    });
    expect(blueprint).toContain('【源级口径冲突裁决（最高优先级约束）】');
    expect(blueprint).toContain('裁决口径：以补疑文件 11500m² 为准');
    expect(blueprint).toContain('全文必须统一使用该数值');
  });

  it('scopeConflicts 无裁决口径时输出人工复核提示', () => {
    const conflicts: NumericScopeConflict[] = [
      {
        kind: 'duration',
        scope: '计划工期',
        values: [
          { value: '420', unit: '日历天', sourceFile: '/data/招标公告.docx', priority: 2 },
          { value: '400', unit: '日历天', sourceFile: '/data/答疑.docx', priority: 2 },
        ],
      },
    ];
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel(),
      scopeConflicts: conflicts,
    });
    expect(blueprint).toContain('无法自动裁决');
    expect(blueprint).toContain('以澄清/补疑类文件为准');
  });

  it('referenceLines 渲染为软性参考区', () => {
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel(),
      referenceLines: ['同类安置房项目工期约 400 日历天'],
    });
    expect(blueprint).toContain('同类工程质量参考');
    expect(blueprint).toContain('同类安置房项目工期约 400 日历天');
  });

  it('sourceFile 渲染时只保留 basename', () => {
    const blueprint = buildDocumentBlueprintContext({
      template: template(),
      chapters: [templateChapter('工程概况')],
      factsModel: factsModel({ project: [fact('projectName', '合肥市某安置房项目', { sourceFile: '/data/招标文件.docx' })] }),
    });
    expect(blueprint).toContain('（来源：招标文件.docx）');
    expect(blueprint).not.toContain('/data/招标文件.docx');
  });
});
