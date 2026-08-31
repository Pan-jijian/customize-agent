/**
 * projectMaterialProfile 单测：资料类型推断、资料包选择（绑定/需求 scoping/可用性过滤）、
 * 项目资料画像构建、项目理解模型（章节必用资料类型/图谱内容覆盖/提示词）、
 * 计划证据检索与抽样证据（预算截断后 score 由 uniqueEvidence 质量因子重算，仅断言下限）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type KnowledgeFile = { relativePath: string; chunkCount?: number; indexedAt?: number; status?: string };
const listKnowledgeFilesMock = vi.hoisted(() => vi.fn<(projectRoot: string) => KnowledgeFile[]>());
vi.mock('../knowledge/kbService', () => ({ listKnowledgeFiles: listKnowledgeFilesMock }));

import {
  buildProjectMaterialProfile,
  buildProjectUnderstanding,
  expandProjectMaterialBindings,
  inferMaterialKind,
  materialKindLabel,
  materialKindMaps,
  materialProcessingType,
  materialRoleId,
  projectUnderstandingPrompt,
  retrievePlannedMaterialEvidence,
  sampleProjectMaterialEvidence,
  templateProjectBindings,
} from './projectMaterialProfile';
import type { ChapterMaterialPlan, MaterialFileProfile, MaterialKind, ProjectMaterialProfile } from './projectMaterialProfile';
import type { DocumentTemplate, DocumentTemplateChapter, ProjectBinding, ProjectGraph } from './types';

const file = (relativePath: string, overrides: Partial<KnowledgeFile> = {}): KnowledgeFile => ({ relativePath, chunkCount: 10, indexedAt: 123, status: 'ready', ...overrides });

const chapter = (title: string, overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter => ({ id: `c-${title}`, title, purpose: `${title}写作目标`, queries: [], requiredFacts: [], ...overrides });

const template = (chapters: DocumentTemplateChapter[], overrides: Partial<DocumentTemplate> = {}): DocumentTemplate => ({ id: 't-1', name: '房建施工组织设计', description: '', category: '施工组织设计', outputTitle: '施工组织设计', chapters, ...overrides });

const mfile = (filePath: string, kind: MaterialKind, overrides: Partial<MaterialFileProfile> = {}): MaterialFileProfile => ({ filePath, fileName: filePath.split('/').pop() || filePath, kind, confidence: 0.8, priority: 60, summary: '资料摘要', keySignals: [], ...overrides });

const graph = (overrides: Partial<ProjectGraph> = {}): ProjectGraph => ({ works: [], methods: [], resources: [], schedule: [], standards: [], risks: [], requirements: [], siteConditions: [], addendumChanges: [], gaps: [], generatedAt: 0, ...overrides });

const plan = (overrides: Partial<ChapterMaterialPlan> = {}): ChapterMaterialPlan => ({
  chapterId: 'c-工程概况', chapterTitle: '工程概况', writingGoal: '写作目标',
  mustUseMaterialKinds: ['tender_document'],
  evidenceQueries: { tender_document: ['工程概况资料查询'], bill_of_quantities: [], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] },
  mustCover: [], avoidWriting: [],
  ...overrides,
});

beforeEach(() => {
  listKnowledgeFilesMock.mockReset();
});

describe('inferMaterialKind', () => {
  it('补疑/澄清关键词 → addendum', () => {
    const result = inferMaterialKind('/data/招标补疑文件.pdf');
    expect(result.kind).toBe('addendum');
    expect(result.confidence).toBe(0.92);
    expect(result.signals).toContain('补疑/澄清关键词');
  });

  it('清单/工程量关键词 → bill_of_quantities', () => {
    const result = inferMaterialKind('/data/工程量清单.xlsx');
    expect(result.kind).toBe('bill_of_quantities');
    expect(result.confidence).toBe(0.9);
  });

  it('图纸/设计关键词 → drawing', () => {
    const result = inferMaterialKind('/data/施工图纸.dwg');
    expect(result.kind).toBe('drawing');
    expect(result.confidence).toBe(0.88);
  });

  it('招标文件关键词 → tender_document', () => {
    const result = inferMaterialKind('/data/招标文件.docx');
    expect(result.kind).toBe('tender_document');
    expect(result.confidence).toBe(0.9);
  });

  it('合同关键词 → contract', () => {
    const result = inferMaterialKind('/data/施工合同.pdf');
    expect(result.kind).toBe('contract');
    expect(result.confidence).toBe(0.82);
  });

  it('技术规范关键词 → technical_specification', () => {
    const result = inferMaterialKind('/data/技术规范.pdf');
    expect(result.kind).toBe('technical_specification');
    expect(result.confidence).toBe(0.8);
  });

  it('工期进度关键词 → schedule_document', () => {
    const result = inferMaterialKind('/data/施工进度计划.pdf');
    expect(result.kind).toBe('schedule_document');
    expect(result.confidence).toBe(0.72);
  });

  it('质量安全关键词 → quality_safety_document', () => {
    const result = inferMaterialKind('/data/质量安全手册.pdf');
    expect(result.kind).toBe('quality_safety_document');
    expect(result.confidence).toBe(0.72);
  });

  it('未命中任何类型 → other（低置信度）', () => {
    const result = inferMaterialKind('/data/杂项说明.txt');
    expect(result.kind).toBe('other');
    expect(result.confidence).toBe(0.35);
  });

  it('同文件多关键词：按优先级短路（补疑优先于招标）', () => {
    expect(inferMaterialKind('/data/招标补疑与答疑汇总.pdf').kind).toBe('addendum');
  });
});

describe('materialKindLabel / materialRoleId / materialProcessingType', () => {
  it('九种资料类型中文标签', () => {
    expect(materialKindLabel('tender_document')).toBe('招标文件正文');
    expect(materialKindLabel('bill_of_quantities')).toBe('工程量清单');
    expect(materialKindLabel('drawing')).toBe('图纸/设计资料');
    expect(materialKindLabel('addendum')).toBe('补疑/澄清/答疑');
    expect(materialKindLabel('contract')).toBe('合同资料');
    expect(materialKindLabel('technical_specification')).toBe('技术规范/技术要求');
    expect(materialKindLabel('schedule_document')).toBe('工期/进度资料');
    expect(materialKindLabel('quality_safety_document')).toBe('质量安全文明资料');
    expect(materialKindLabel('other')).toBe('其他资料');
  });

  it('未知类型标签兜底"其他资料"', () => {
    expect(materialKindLabel('not-exist' as MaterialKind)).toBe('其他资料');
  });

  it('materialRoleId：kind 原样透传、缺省 other', () => {
    expect(materialRoleId('tender_document')).toBe('tender_document');
    expect(materialRoleId(undefined)).toBe('other');
  });

  it('materialProcessingType：四类加工策略映射', () => {
    expect(materialProcessingType('drawing')).toBe('drawing');
    expect(materialProcessingType('bill_of_quantities')).toBe('table');
    expect(materialProcessingType('technical_specification')).toBe('specification');
    expect(materialProcessingType('tender_document')).toBe('rule');
    expect(materialProcessingType('addendum')).toBe('rule');
    expect(materialProcessingType('contract')).toBe('reference');
  });
});

describe('templateProjectBindings', () => {
  it('过滤空 materialRootPath 并规范化路径（反斜杠/首尾斜杠）', () => {
    const bindings: ProjectBinding[] = [{ materialRootPath: '/资料包/' }, { materialRootPath: '' }, { materialRootPath: '\\资料\\图纸' }];
    expect(templateProjectBindings(template([], { projectBindings: bindings }))).toEqual([{ materialRootPath: '资料包' }, { materialRootPath: '资料/图纸' }]);
  });

  it('无 projectBindings → 空数组', () => {
    expect(templateProjectBindings(template([]))).toEqual([]);
  });
});

describe('expandProjectMaterialBindings', () => {
  it('返回选中文件的相对路径列表', () => {
    listKnowledgeFilesMock.mockReturnValue([file('资料包/招标文件.docx'), file('其他包/清单.xlsx')]);
    const paths = expandProjectMaterialBindings('/proj', template([], { projectBindings: [{ materialRootPath: '资料包' }] }));
    expect(paths).toEqual(['资料包/招标文件.docx']);
  });
});

describe('buildProjectMaterialProfile', () => {
  it('无绑定：全部可用文件按类型分组、按优先级排序、产出未绑定警告', () => {
    listKnowledgeFilesMock.mockReturnValue([
      file('招标文件.docx'),
      file('工程量清单.xlsx'),
      file('补疑文件.pdf'),
    ]);
    const profile = buildProjectMaterialProfile('/proj', template([]));
    expect(profile.files.map(item => item.fileName)).toEqual(['补疑文件.pdf', '招标文件.docx', '工程量清单.xlsx']);
    expect(profile.groups.tender_document).toHaveLength(1);
    expect(profile.groups.bill_of_quantities).toHaveLength(1);
    expect(profile.groups.addendum).toHaveLength(1);
    expect(profile.warnings).toContain('模板未显式绑定项目资料包，已使用当前知识库全部可用资料。');
    // 招标/清单/图纸缺失提醒（此场景仅 addendum/tender/bill，缺图纸）
    expect(profile.warnings.some(warning => warning.includes('图纸'))).toBe(true);
  });

  it('不可用文件过滤：disk/error 状态、未索引、零切片均排除', () => {
    listKnowledgeFilesMock.mockReturnValue([
      file('招标文件.docx'),
      file('草稿.pdf', { status: 'disk' }),
      file('失败.pdf', { status: 'error' }),
      file('未索引.pdf', { indexedAt: 0 }),
      file('空切片.pdf', { chunkCount: 0 }),
    ]);
    const profile = buildProjectMaterialProfile('/proj', template([]));
    expect(profile.files.map(item => item.fileName)).toEqual(['招标文件.docx']);
  });

  it('绑定资料包：只保留根目录下文件', () => {
    listKnowledgeFilesMock.mockReturnValue([
      file('资料包/招标文件.docx'),
      file('其他包/工程量清单.xlsx'),
    ]);
    const profile = buildProjectMaterialProfile('/proj', template([], { projectBindings: [{ materialRootPath: '资料包' }] }));
    expect(profile.files.map(item => item.filePath)).toEqual(['资料包/招标文件.docx']);
    expect(profile.materialRoots).toEqual(['资料包']);
    expect(profile.projectName).toBe('资料包');
  });

  it('绑定包下无可用文件 → 数据包未找到警告', () => {
    listKnowledgeFilesMock.mockReturnValue([file('其他包/招标文件.docx')]);
    const profile = buildProjectMaterialProfile('/proj', template([], { projectBindings: [{ materialRootPath: '资料包' }] }));
    expect(profile.files).toEqual([]);
    expect(profile.warnings).toContain('项目资料包下未找到已完成索引的可用文件。');
  });

  it('projectName 清洗：去扩展名与数字前缀', () => {
    listKnowledgeFilesMock.mockReturnValue([file('123_某某小区项目/招标文件.docx')]);
    const profile = buildProjectMaterialProfile('/proj', template([]));
    expect(profile.projectName).toBe('某某小区项目');
  });

  it('三大关键资料类型缺失 → 对应风险警告', () => {
    listKnowledgeFilesMock.mockReturnValue([file('合同文件.pdf')]);
    const profile = buildProjectMaterialProfile('/proj', template([]));
    expect(profile.warnings.some(warning => warning.includes('招标文件正文'))).toBe(true);
    expect(profile.warnings.some(warning => warning.includes('工程量清单'))).toBe(true);
    expect(profile.warnings.some(warning => warning.includes('图纸'))).toBe(true);
  });

  it('需求 scoping：requirement 命中分组前缀 → 只取该组', () => {
    listKnowledgeFilesMock.mockReturnValue([
      file('某某小区/招标文件.docx'),
      file('某某小区/工程量清单.xlsx'),
      file('其他项目/招标文件.docx'),
    ]);
    const profile = buildProjectMaterialProfile('/proj', template([]), { requirement: '某某小区' });
    expect(profile.files.map(item => item.filePath)).toEqual(['某某小区/招标文件.docx', '某某小区/工程量清单.xlsx']);
    expect(profile.materialRoots).toEqual(['某某小区']);
  });

  it('需求不命中任何分组 → 回退全量资料', () => {
    listKnowledgeFilesMock.mockReturnValue([
      file('某某小区/招标文件.docx'),
      file('其他项目/清单.xlsx'),
    ]);
    const profile = buildProjectMaterialProfile('/proj', template([]), { requirement: '不存在的项目名' });
    expect(profile.files).toHaveLength(2);
  });
});

describe('buildProjectUnderstanding', () => {
  const fullGroups: ProjectMaterialProfile['groups'] = {
    tender_document: [mfile('招标文件.docx', 'tender_document')],
    bill_of_quantities: [mfile('清单.xlsx', 'bill_of_quantities')],
    drawing: [mfile('图纸.dwg', 'drawing')],
    addendum: [mfile('补疑.pdf', 'addendum')],
    contract: [],
    technical_specification: [mfile('规范.pdf', 'technical_specification')],
    schedule_document: [mfile('进度.pdf', 'schedule_document')],
    quality_safety_document: [mfile('质安.pdf', 'quality_safety_document')],
    other: [],
  };
  const profile = (overrides: Partial<ProjectMaterialProfile> = {}): ProjectMaterialProfile => ({ projectName: '某某小区项目', materialRoots: ['某某小区'], files: [], groups: fullGroups, warnings: [], ...overrides });

  it('章节标题 → 必用资料类型映射（各分支标题）', () => {
    const understanding = buildProjectUnderstanding(template([
      chapter('工程概况'), chapter('施工部署'), chapter('主要施工方法'),
      chapter('工期安排与节点计划'), chapter('质量保证措施'), chapter('安全生产与文明管理'),
      chapter('资源配置计划'), chapter('季节性施工措施'),
    ]), profile());
    const kinds = Object.fromEntries(understanding.chapterPlans.map(item => [item.chapterTitle, item.mustUseMaterialKinds]));
    expect(kinds['工程概况']).toEqual(['tender_document', 'addendum', 'bill_of_quantities']);
    expect(kinds['施工部署']).toEqual(['tender_document', 'bill_of_quantities', 'drawing', 'addendum']);
    expect(kinds['主要施工方法']).toEqual(['bill_of_quantities', 'drawing', 'technical_specification', 'addendum']);
    // 进度分支仅对不含"施工/工程"等前置词的纯进度类标题生效（"施工进度计划"被"施工"词优先命中施工分支）
    expect(kinds['工期安排与节点计划']).toEqual(['tender_document', 'addendum', 'schedule_document', 'bill_of_quantities']);
    expect(kinds['质量保证措施']).toEqual(['tender_document', 'technical_specification', 'drawing', 'quality_safety_document', 'addendum']);
    expect(kinds['安全生产与文明管理']).toEqual(['tender_document', 'quality_safety_document', 'drawing', 'addendum']);
    expect(kinds['资源配置计划']).toEqual(['bill_of_quantities', 'drawing', 'tender_document']);
    // "季节性施工措施"含"施工"词，优先命中施工分支而非默认分支（判定顺序锁定现状）
    expect(kinds['季节性施工措施']).toEqual(['bill_of_quantities', 'drawing', 'technical_specification', 'addendum']);
  });

  it('含"施工"词的复合标题优先命中施工分支（判定顺序锁定现状）', () => {
    const understanding = buildProjectUnderstanding(template([chapter('施工进度计划'), chapter('安全文明施工')]), profile());
    const kinds = Object.fromEntries(understanding.chapterPlans.map(item => [item.chapterTitle, item.mustUseMaterialKinds]));
    expect(kinds['施工进度计划']).toEqual(['bill_of_quantities', 'drawing', 'technical_specification', 'addendum']);
    expect(kinds['安全文明施工']).toEqual(['bill_of_quantities', 'drawing', 'technical_specification', 'addendum']);
  });

  it('资料组全空 → mustUseMaterialKinds 兜底为空', () => {
    const emptyGroups: ProjectMaterialProfile['groups'] = { tender_document: [], bill_of_quantities: [], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] };
    const understanding = buildProjectUnderstanding(template([chapter('工程概况')]), profile({ groups: emptyGroups }));
    expect(understanding.chapterPlans[0]?.mustUseMaterialKinds).toEqual([]);
  });

  it('图谱工程内容与工法按 token 匹配并入 mustCover', () => {
    const projectGraph = graph({
      works: [{ name: '土方开挖', scope: '基坑土方开挖与运输', sourceFiles: [], relatedItems: [] }],
      methods: [{ name: '土方开挖方法', steps: ['定位', '开挖'], applicableWorks: ['土方开挖'], sourceFiles: [] }],
    });
    const understanding = buildProjectUnderstanding(template([chapter('土方开挖工程施工', { sections: [], requiredFacts: [] })]), profile(), projectGraph);
    const mustCover = understanding.chapterPlans[0]?.mustCover || [];
    expect(mustCover.some(item => item.includes('土方开挖：'))).toBe(true);
    expect(mustCover).toContain('土方开挖方法');
    expect(understanding.prompt).toContain('## 项目资料图谱分析结果');
  });

  it('无图谱 → 不注入图谱提示词；全局重点与禁止事项齐备', () => {
    const understanding = buildProjectUnderstanding(template([chapter('工程概况')]), profile());
    expect(understanding.prompt).not.toContain('项目资料图谱分析结果');
    expect(understanding.globalWritingFocus.some(item => item.includes('某某小区项目'))).toBe(true);
    expect(understanding.chapterPlans[0]?.avoidWriting).toHaveLength(3);
    expect(understanding.chapterPlans[0]?.mustCover).toContain('工程概况写作目标');
  });
});

describe('projectUnderstandingPrompt', () => {
  it('资料清单逐类输出（有/未识别）与章节计划编号', () => {
    const p = {
      projectName: '某某小区项目', materialRoots: ['某某小区'], warnings: [],
      files: [mfile('招标文件.docx', 'tender_document', { priority: 90 })],
      groups: { tender_document: [mfile('招标文件.docx', 'tender_document')], bill_of_quantities: [], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] },
    };
    const prompt = projectUnderstandingPrompt({
      profile: p, globalWritingFocus: ['全局重点一'],
      chapterPlans: [plan({ chapterTitle: '工程概况' })],
    });
    expect(prompt).toContain('招标文件正文：招标文件.docx(0)');
    expect(prompt).toContain('工程量清单：未识别');
    expect(prompt).toContain('1. 工程概况');
    expect(prompt).toContain('- 写作目标：写作目标');
    expect(prompt).not.toContain('资料风险：');
  });

  it('存在警告时输出资料风险行；graphPrompt 附加尾部', () => {
    const p = {
      projectName: '某某小区项目', materialRoots: [], warnings: ['未识别到招标文件正文'],
      files: [], groups: { tender_document: [], bill_of_quantities: [], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] },
    };
    const prompt = projectUnderstandingPrompt({
      profile: p, globalWritingFocus: [], chapterPlans: [],
      graphPrompt: '## 项目资料图谱分析结果\n### 主要工程内容',
    });
    expect(prompt).toContain('资料风险：未识别到招标文件正文');
    expect(prompt).toContain('## 项目资料图谱分析结果');
  });
});

describe('materialKindMaps', () => {
  it('kindByPath 与 processingByPath 双映射', () => {
    const p = {
      projectName: '', materialRoots: [], warnings: [],
      files: [mfile('/data/图纸.dwg', 'drawing'), mfile('/data/清单.xlsx', 'bill_of_quantities')],
      groups: { tender_document: [], bill_of_quantities: [], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] },
    };
    const maps = materialKindMaps(p);
    expect(maps.kindByPath.get('/data/图纸.dwg')).toBe('drawing');
    expect(maps.processingByPath.get('/data/图纸.dwg')).toBe('drawing');
    expect(maps.processingByPath.get('/data/清单.xlsx')).toBe('table');
  });
});

describe('retrievePlannedMaterialEvidence', () => {
  const searchMock = vi.fn<(projectRoot: string, query: string, options: unknown) => Promise<{ results: Array<{ filePath: string; score: number; content: string; sectionTitle?: string; source?: string }> }>>();
  const manager = { search: searchMock };
  const profileWith = (kind: MaterialKind, filePath: string): ProjectMaterialProfile => {
    const groups: ProjectMaterialProfile['groups'] = { tender_document: [], bill_of_quantities: [], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] };
    groups[kind] = [mfile(filePath, kind, { priority: 90 })];
    return { projectName: '', materialRoots: [], files: [mfile(filePath, kind, { priority: 90 })], groups, warnings: [] };
  };

  beforeEach(() => {
    searchMock.mockReset();
  });

  it('无计划 → 直接空数组且不发起检索', async () => {
    const result = await retrievePlannedMaterialEvidence({ manager, projectRoot: '/proj', chapter: chapter('工程概况'), plan: undefined, profile: profileWith('tender_document', '/data/招标文件.docx'), scopedFilePaths: ['/data/招标文件.docx'], limitPerQuery: 3 });
    expect(result).toEqual([]);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('计划类型文件均不在范围内 → 空数组且不检索', async () => {
    const result = await retrievePlannedMaterialEvidence({ manager, projectRoot: '/proj', chapter: chapter('工程概况'), plan: plan(), profile: profileWith('tender_document', '/data/招标文件.docx'), scopedFilePaths: [], limitPerQuery: 3 });
    expect(result).toEqual([]);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('正常检索：来源标记/优先级加权/角色与加工类型透传', async () => {
    searchMock.mockResolvedValue({ results: [{ filePath: '/data/招标文件.docx', score: 1, content: '现场临时用电按三级配电系统布置，配电箱配置符合规范要求。' }] });
    const result = await retrievePlannedMaterialEvidence({ manager, projectRoot: '/proj', chapter: chapter('工程概况'), plan: plan(), profile: profileWith('tender_document', '/data/招标文件.docx'), scopedFilePaths: ['/data/招标文件.docx'], limitPerQuery: 3 });
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('material-plan:tender_document');
    expect(result[0]?.roleId).toBe('tender_document');
    expect(result[0]?.processingType).toBe('rule');
    // score = 1 + 90/100 + 2 后经 uniqueEvidence 质量因子重算，仅断言高于基础分
    expect(result[0]?.score).toBeGreaterThan(2);
  });

  it('已中止信号 → 抛错', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(retrievePlannedMaterialEvidence({ manager, projectRoot: '/proj', chapter: chapter('工程概况'), plan: plan(), profile: profileWith('tender_document', '/data/招标文件.docx'), scopedFilePaths: ['/data/招标文件.docx'], limitPerQuery: 3, signal: controller.signal })).rejects.toThrow('aborted');
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('sampleProjectMaterialEvidence', () => {
  it('切片计分：数字加成/首块加成/优先级折算，证据带抽样来源标记', () => {
    const p: ProjectMaterialProfile = {
      projectName: '', materialRoots: [], warnings: [],
      files: [mfile('/data/招标正文.txt', 'tender_document', { priority: 90 })],
      groups: { tender_document: [mfile('/data/招标正文.txt', 'tender_document', { priority: 90 })], bill_of_quantities: [], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] },
    };
    const project = {
      getFileDetail: vi.fn((_path: string) => ({
        file: { relativePath: '/data/招标正文.txt' },
        chunks: [
          { content: '现场临时用电按三级配电系统布置，各级配电箱配置符合规范要求。', sectionTitle: '临时用电' },
          { content: '本工程计划工期420日历天，质量目标为一次性验收合格且一次成优。', sectionTitle: '工期' },
        ],
        totalChunkCount: 2,
      })),
    };
    const result = sampleProjectMaterialEvidence({ project, chapter: chapter('工程概况'), profile: p, scopedFilePaths: ['/data/招标正文.txt'] });
    expect(result).toHaveLength(2);
    expect(result.every(item => item.source === 'project-material-sample')).toBe(true);
    expect(result.every(item => item.roleId === 'tender_document')).toBe(true);
    // 数字加成块（420日历天）得分更高排前
    expect(result[0]?.content).toContain('420日历天');
    expect(result[0]?.score).toBeGreaterThan(1.8);
  });

  it('getFileDetail 无切片 → 跳过该文件', () => {
    const p: ProjectMaterialProfile = {
      projectName: '', materialRoots: [], warnings: [],
      files: [mfile('/data/招标文件.docx', 'tender_document')],
      groups: { tender_document: [mfile('/data/招标文件.docx', 'tender_document')], bill_of_quantities: [], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] },
    };
    const project = { getFileDetail: vi.fn(() => undefined) };
    expect(sampleProjectMaterialEvidence({ project, chapter: chapter('工程概况'), profile: p, scopedFilePaths: ['/data/招标文件.docx'] })).toEqual([]);
  });

  it('计划类型过滤：仅抽样计划内资料类型文件', () => {
    const groups: ProjectMaterialProfile['groups'] = { tender_document: [mfile('/data/招标文件.docx', 'tender_document')], bill_of_quantities: [mfile('/data/清单.xlsx', 'bill_of_quantities')], drawing: [], addendum: [], contract: [], technical_specification: [], schedule_document: [], quality_safety_document: [], other: [] };
    const p: ProjectMaterialProfile = { projectName: '', materialRoots: [], warnings: [], files: [mfile('/data/招标文件.docx', 'tender_document'), mfile('/data/清单.xlsx', 'bill_of_quantities')], groups };
    const project = {
      getFileDetail: vi.fn((path: string) => ({
        file: { relativePath: path },
        chunks: [{ content: '现场临时用电按三级配电系统布置，配电箱配置符合规范要求。' }],
        totalChunkCount: 1,
      })),
    };
    const result = sampleProjectMaterialEvidence({ project, chapter: chapter('工程概况'), plan: plan({ mustUseMaterialKinds: ['tender_document'] }), profile: p, scopedFilePaths: ['/data/招标文件.docx', '/data/清单.xlsx'] });
    expect(result.every(item => item.filePath === '/data/招标文件.docx')).toBe(true);
    // 无计划时两种类型都抽样（sort 按 UTF-16 码元，"招" 0x62DB 先于 "清" 0x6E05）
    const all = sampleProjectMaterialEvidence({ project, chapter: chapter('工程概况'), profile: p, scopedFilePaths: ['/data/招标文件.docx', '/data/清单.xlsx'] });
    expect(all.map(item => item.filePath).sort()).toEqual(['/data/招标文件.docx', '/data/清单.xlsx']);
  });
});
