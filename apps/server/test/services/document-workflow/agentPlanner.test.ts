import { afterEach, describe, expect, it, vi } from 'vitest';
import { planChapterTask, planDocument } from '@/services/document-workflow/agentPlanner';
import type { AgentWorkflowContext } from '@/services/document-workflow/agentWorkflow';
import type { DocumentTemplate } from '@/services/document-workflow/types';

const EMPTY_GRAPH = {
  works: [], methods: [], resources: [], schedule: [], standards: [], risks: [], requirements: [], siteConditions: [],
  addendumChanges: [], gaps: [], generatedAt: 0,
};

/** 测试用「原型词命中」嵌入：向量维度=类别原型词表，文本包含原型词则该维为 1（归一化后余弦=共享词比例）。
 * 确定性可控：正则不命中但含原型词（如「劳动力配置」）的标题只能靠语义分类获得查询扩展。 */
const PROTOTYPE_WORDS = ['安全生产', '文明施工', '危大工程', '应急预案', '风险管控', '施工工期', '进度计划', '关键节点', '开工时间', '竣工时间', '质量验收', '质量目标', '检验批', '隐蔽工程', '材料复试', '人材机资源', '劳动力配置', '材料供应', '设备机械', '工程量清单', '工程概况', '项目概况', '建设地点', '建设规模', '招标范围', '施工部署', '流水施工', '施工区段', '工序穿插'];

function protoWordEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map(text => {
    const vector: number[] = PROTOTYPE_WORDS.map(word => (text.includes(word) ? 1 : 0));
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map(value => value / norm);
  }));
}

function failingEmbed(): Promise<number[][]> {
  return Promise.reject(new Error('semantic model unavailable'));
}

function minimalContext(overrides: Partial<AgentWorkflowContext> = {}): AgentWorkflowContext {
  return {
    runId: 'run-1',
    templateId: 'tpl-1',
    requirement: '',
    projectRoot: '/tmp/project',
    materialScope: { selectedRoots: ['/tmp/project'], selectedFiles: [], totalAvailableFiles: 0, ambiguous: false, locked: true, reason: '', rejectedRoots: [], scopeHash: 'scope-1' },
    materialSnapshot: { files: [], totalFiles: 0, totalChunks: 0, roots: [], createdAt: 0, snapshotHash: '' },
    nodes: [],
    facts: [],
    baseProjectGraph: EMPTY_GRAPH,
    issues: [],
    createdAt: 0,
    ...overrides,
  };
}

function minimalTemplate(chapters: DocumentTemplate['chapters']): DocumentTemplate {
  return {
    id: 'tpl-1', name: '测试模板', version: 1,
    chapters, domain: 'construction', kind: 'bid', outputTitle: '测试文档', description: '',
  } as unknown as DocumentTemplate;
}

const RESOURCE_QUERY = '清单 工程量 材料 设备 机械 劳动力 规格 型号 数量 单位';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('planDocument 语义查询扩展（语义模型判别为主，正则仅作降级兜底）', () => {
  it('语义分类贡献：正则不命中但含原型词的标题获得资源类查询词（新形态标题不再依赖正则枚举）', async () => {
    // 「劳动力配置」是资源类原型词，但不在正则 /资源|材料|机械|设备|人材机/ 中——该查询词只能来自语义分类
    const template = minimalTemplate([{ id: 'ch-1', title: '劳动力配置保障体系', sections: [], queries: [], requiredFacts: [], purpose: '' }]);
    const { plan } = await planDocument({ template, context: minimalContext(), embedDocuments: protoWordEmbed });
    expect(plan.chapters[0].sections[0].evidenceQueries).toContain(RESOURCE_QUERY);
  });

  it('语义模型失败 → 回退确定性正则：顿号形态「人、材、机」标题仍获得资源类查询词', async () => {
    const template = minimalTemplate([{ id: 'ch-1', title: '确保人、材、机的保障体系与措施', sections: [], queries: [], requiredFacts: [], purpose: '' }]);
    const { plan } = await planDocument({ template, context: minimalContext(), embedDocuments: failingEmbed });
    expect(plan.chapters[0].sections[0].evidenceQueries).toContain(RESOURCE_QUERY);
  });

  it('DOCUMENT_QUERY_EXPANSION_SEMANTIC=0 → 不调用语义模型，正则兜底仍生效', async () => {
    vi.stubEnv('DOCUMENT_QUERY_EXPANSION_SEMANTIC', '0');
    const embedSpy = vi.fn(protoWordEmbed);
    const template = minimalTemplate([{ id: 'ch-1', title: '确保人、材、机的保障体系与措施', sections: [], queries: [], requiredFacts: [], purpose: '' }]);
    const { plan } = await planDocument({ template, context: minimalContext(), embedDocuments: embedSpy });
    expect(embedSpy).not.toHaveBeenCalled();
    expect(plan.chapters[0].sections[0].evidenceQueries).toContain(RESOURCE_QUERY);
  });

  it('连续形态「人材机」标题正则仍命中（回归保护）', async () => {
    const template = minimalTemplate([{ id: 'ch-1', title: '人材机保障体系', sections: [], queries: [], requiredFacts: [], purpose: '' }]);
    const { plan } = await planDocument({ template, context: minimalContext(), embedDocuments: protoWordEmbed });
    expect(plan.chapters[0].sections[0].evidenceQueries).toContain(RESOURCE_QUERY);
  });

  it('语义与正则并集：语义分类与正则各自命中的查询词同时保留', async () => {
    const template = minimalTemplate([{ id: 'ch-1', title: '确保工期与质量的保障体系与措施', sections: [], queries: [], requiredFacts: [], purpose: '' }]);
    const { plan } = await planDocument({ template, context: minimalContext(), embedDocuments: protoWordEmbed });
    const queries = plan.chapters[0].sections[0].evidenceQueries;
    expect(queries).toContain('工期 日历天 节点 进度 计划 开工 竣工 关键线路');
    expect(queries).toContain('质量 验收 合格 标准 规范 检验批 隐蔽 复试 样板');
  });
});

describe('planChapterTask 退化小节兜底（结构推理：章=节时章节证据天然属于该小节）', () => {
  const chapter = { id: 'ch-1', title: '确保人、材、机的保障体系与措施', sections: [], queries: [], requiredFacts: [], purpose: '' };

  it('退化小节词面匹配全空但章节证据非空 → 就绪', async () => {
    const { plan } = await planDocument({ template: minimalTemplate([chapter]), context: minimalContext(), embedDocuments: protoWordEmbed });
    const evidence = [{ chapterId: 'ch-1', filePath: 'a.md', score: 1, content: '施工组织保障与实施措施内容。', source: 'search' }];
    const { task } = planChapterTask({ plan, chapter, context: minimalContext(), evidence });
    expect(task.sections[0].ready).toBe(true);
    expect(task.sections[0].evidenceIds.length).toBeGreaterThan(0);
    expect(task.ready).toBe(true);
  });

  it('退化小节且章节证据为空 → 仍判 blocker（章节确实无支撑）', async () => {
    const { plan } = await planDocument({ template: minimalTemplate([chapter]), context: minimalContext(), embedDocuments: protoWordEmbed });
    const { task } = planChapterTask({ plan, chapter, context: minimalContext(), evidence: [] });
    expect(task.sections[0].ready).toBe(false);
    expect(task.ready).toBe(false);
    expect(task.sections[0].issues[0]?.message).toContain('缺少事实、图谱或证据支撑');
  });

  it('退化小节图谱兜底：图谱含章节标题 token 时 graphNodeIds 非空', async () => {
    const { plan } = await planDocument({ template: minimalTemplate([chapter]), context: minimalContext(), embedDocuments: protoWordEmbed });
    const graph = {
      ...EMPTY_GRAPH,
      works: [{ name: '主体工程', scope: '确保人材机供应与机械设备调度', sourceFiles: ['a.md'], relatedItems: [] }],
    };
    const { task } = planChapterTask({ plan, chapter, context: minimalContext({ baseProjectGraph: graph }), evidence: [] });
    expect(task.sections[0].ready).toBe(true);
    expect(task.sections[0].graphNodeIds.length).toBeGreaterThan(0);
  });

  it('非退化多小节章节不受兜底影响：无支撑小节仍判 blocker', async () => {
    const multiChapter = { id: 'ch-1', title: '确保工期与质量的保障体系与措施', sections: ['进度组织', '质量控制'], queries: [], requiredFacts: [], purpose: '' };
    const { plan } = await planDocument({ template: minimalTemplate([multiChapter]), context: minimalContext(), embedDocuments: protoWordEmbed });
    const { task } = planChapterTask({ plan, chapter: multiChapter, context: minimalContext(), evidence: [] });
    expect(task.sections.every(section => !section.ready)).toBe(true);
    expect(task.ready).toBe(false);
  });
});
