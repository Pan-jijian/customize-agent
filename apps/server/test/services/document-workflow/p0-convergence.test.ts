/**
 * P0 收敛六项单测：
 * - P0-2/P0-3 资料范围解析单点化（createAgentWorkflowContext 接受外部 materialScope，preflight 不再重复构建）
 * - P0-4 展示收敛（precomputed 时不重复展示图谱缓存节点；runtime 时保留预备分析节点）
 * - P0-5 事实池裁决收敛（数值冲突补疑优先、文本冲突优先级收敛、同值去重、多值保留）
 * - P0-6 纪律类事实过滤（入库抽取与生成拼接点共用口径）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type KnowledgeFile = { relativePath: string; chunkCount?: number; indexedAt?: number; status?: string };
const listKnowledgeFilesMock = vi.hoisted(() => vi.fn<(projectRoot: string) => KnowledgeFile[]>());
vi.mock('@/services/knowledge/kbService', () => ({ listKnowledgeFiles: listKnowledgeFilesMock }));

import { agentWorkflowStages, createAgentWorkflowContext, resolveAgentMaterialScope, type AgentMaterialScope } from '@/services/document-workflow/agentWorkflow';
import { arbitrateFactPool } from '@/services/document-workflow/factGovernance';
import { filterBidDisciplineFacts } from '@/services/document-workflow/utils';
import type { DocumentFact, DocumentTemplate, ProjectGraph } from '@/services/document-workflow/types';

const file = (relativePath: string, overrides: Partial<KnowledgeFile> = {}): KnowledgeFile => ({ relativePath, chunkCount: 10, indexedAt: 123, status: 'ready', ...overrides });

const template = (overrides: Partial<DocumentTemplate> = {}): DocumentTemplate => ({ id: 't-1', name: '房建施工组织设计', description: '', category: '施工组织设计', outputTitle: '施工组织设计', chapters: [], ...overrides });

const fact = (overrides: Partial<DocumentFact> & { key: string; value: string }): DocumentFact => ({ sourceFile: '资料/招标文件.pdf', roleId: 'tender_document', confidence: 80, ...overrides });

const scopeFixture = (): AgentMaterialScope => ({
  selectedRoots: ['庐江项目'],
  selectedFiles: ['庐江项目/招标文件.pdf', '庐江项目/工程量清单.xlsx'],
  totalAvailableFiles: 2,
  ambiguous: false,
  locked: true,
  reason: '模板绑定资料组',
  rejectedRoots: [],
  scopeHash: 's-hash',
});

beforeEach(() => {
  listKnowledgeFilesMock.mockReset();
});

describe('P0-2/P0-3 资料范围解析单点化', () => {
  it('createAgentWorkflowContext 接受外部 materialScope：不重复内部解析，引用一致', () => {
    listKnowledgeFilesMock.mockReturnValue([file('庐江项目/招标文件.pdf'), file('庐江项目/工程量清单.xlsx')]);
    const external = scopeFixture();
    const context = createAgentWorkflowContext({ template: template(), projectRoot: '/proj', facts: [], materialScope: external });
    expect(context.materialScope).toBe(external);
    expect(context.materialSnapshot.files).toHaveLength(2);
  });

  it('未传 materialScope 时仍内部解析（行为兼容）', () => {
    listKnowledgeFilesMock.mockReturnValue([file('庐江项目/招标文件.pdf'), file('庐江项目/工程量清单.xlsx')]);
    const scope = resolveAgentMaterialScope('/proj', template({ projectBindings: [{ materialRootPath: '庐江项目' }] }));
    const context = createAgentWorkflowContext({ template: template({ projectBindings: [{ materialRootPath: '庐江项目' }] }), projectRoot: '/proj', facts: [] });
    expect(context.materialScope.scopeHash).toBe(scope.scopeHash);
    expect(context.materialScope.selectedFiles).toEqual(scope.selectedFiles);
  });
});

describe('P0-4 展示收敛', () => {
  const graph: ProjectGraph = { works: [{ name: '主体工程', scope: '', sourceFiles: [], relatedItems: [] }], methods: [], resources: [], schedule: [], standards: [], risks: [], requirements: [], siteConditions: [], addendumChanges: [], gaps: [], generatedAt: 0 };

  it('precomputed（命中入库缓存）：不重复展示图谱缓存节点，只保留范围锁定与资料快照', () => {
    listKnowledgeFilesMock.mockReturnValue([file('庐江项目/招标文件.pdf'), file('庐江项目/工程量清单.xlsx')]);
    const context = createAgentWorkflowContext({ template: template(), projectRoot: '/proj', facts: [], materialScope: scopeFixture(), projectGraph: graph, projectGraphSource: 'project-intelligence' });
    const stages = agentWorkflowStages(context);
    expect(stages.map(stage => stage.subtitle)).toEqual(['Agent 资料范围锁定', 'Agent 资料快照']);
    expect(stages.some(stage => stage.roleId === 'agent-project-graph-cache')).toBe(false);
  });

  it('runtime（缓存缺失）：保留运行期图谱预备分析节点', () => {
    listKnowledgeFilesMock.mockReturnValue([file('庐江项目/招标文件.pdf'), file('庐江项目/工程量清单.xlsx')]);
    const context = createAgentWorkflowContext({ template: template(), projectRoot: '/proj', facts: [], materialScope: scopeFixture() });
    const stages = agentWorkflowStages(context);
    expect(stages.map(stage => stage.subtitle)).toEqual(['Agent 资料范围锁定', 'Agent 资料快照', 'Agent 项目图谱预备分析']);
    expect(stages.some(stage => stage.roleId === 'agent-project-graph-runtime')).toBe(true);
  });
});

describe('P0-5 事实池裁决收敛', () => {
  it('数值冲突（工期）：补疑修正文件权威最高，败选值改写为胜选值并收敛单值', () => {
    const pool = [
      fact({ fieldId: 'schedule_requirement', key: '计划工期', value: '210日历天', sourceFile: '资料/招标文件.pdf' }),
      fact({ fieldId: 'schedule_requirement', key: '计划工期', value: '90日历天', sourceFile: '资料/补疑文件.pdf' }),
    ];
    const arbitrated = arbitrateFactPool(pool, '/proj');
    const durations = arbitrated.filter(item => item.fieldId === 'schedule_requirement');
    expect(durations).toHaveLength(1);
    expect(durations[0]!.value).toContain('90');
    expect(durations[0]!.sourceFile).toBe('资料/补疑文件.pdf');
  });

  it('文本类冲突（质量标准）：补疑来源优先级更高，败选值丢弃', () => {
    const pool = [
      fact({ fieldId: 'quality_standard', key: '质量标准', value: '合格', sourceFile: '资料/招标文件.pdf' }),
      fact({ fieldId: 'quality_standard', key: '质量标准', value: '合格，争创优质工程', sourceFile: '资料/补疑文件.pdf' }),
    ];
    const arbitrated = arbitrateFactPool(pool, '/proj');
    const quality = arbitrated.filter(item => item.fieldId === 'quality_standard');
    expect(quality).toHaveLength(1);
    expect(quality[0]!.sourceFile).toBe('资料/补疑文件.pdf');
    expect(quality[0]!.value).toBe('合格，争创优质工程');
  });

  it('同 key 同值（双通道重复抽取）：归一化去重为单条', () => {
    const pool = [
      fact({ fieldId: 'project_location', key: '建设地点', value: '庐江县丰乐镇', sourceFile: '资料/招标文件.pdf' }),
      fact({ fieldId: 'project_location', key: '建设地点', value: '庐江县 丰乐镇', sourceFile: '资料/补疑文件.pdf' }),
    ];
    const arbitrated = arbitrateFactPool(pool, '/proj');
    const locations = arbitrated.filter(item => item.fieldId === 'project_location');
    expect(locations).toHaveLength(1);
    expect(locations[0]!.sourceFile).toBe('资料/补疑文件.pdf');
  });

  it('多值事实（清单条目/材料规格）：不在单值口径内，保留多值不受影响', () => {
    const pool = [
      fact({ key: '材料规格', value: 'C15混凝土垫层', sourceFile: '资料/工程量清单.xlsx' }),
      fact({ key: '材料规格', value: 'C30主体结构', sourceFile: '资料/工程量清单.xlsx' }),
    ];
    const arbitrated = arbitrateFactPool(pool, '/proj');
    expect(arbitrated.filter(item => item.key === '材料规格')).toHaveLength(2);
  });

  it('无冲突事实池：原样返回不丢条目', () => {
    const pool = [
      fact({ key: '施工方法', value: '明挖法施工' }),
      fact({ key: '风险点', value: '深基坑坍塌风险' }),
    ];
    const arbitrated = arbitrateFactPool(pool, '/proj');
    expect(arbitrated).toHaveLength(2);
  });
});

describe('P0-6 纪律类事实过滤', () => {
  it('投标/评标纪律类事实被过滤（源头断流）', () => {
    const pool = [
      fact({ key: '纪律要求', value: '严禁弄虚作假' }),
      fact({ key: '廉洁要求', value: '廉洁从业承诺' }),
      fact({ key: '评标纪律', value: '不得干扰评标' }),
    ];
    expect(filterBidDisciplineFacts(pool)).toHaveLength(0);
  });

  it('正常施工类事实保留，劳动纪律不误伤', () => {
    const pool = [
      fact({ key: '劳动纪律', value: '施工现场劳动纪律管理' }),
      fact({ key: '质量标准', value: '合格' }),
    ];
    expect(filterBidDisciplineFacts(pool)).toHaveLength(2);
  });
});
