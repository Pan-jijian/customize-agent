import { describe, expect, it } from 'vitest';
import { planChapterTask, planDocument } from './agentPlanner';
import type { AgentWorkflowContext } from './agentWorkflow';
import type { DocumentTemplate } from './types';

const EMPTY_GRAPH = {
  works: [], methods: [], resources: [], schedule: [], standards: [], risks: [], requirements: [], siteConditions: [],
  addendumChanges: [], gaps: [], generatedAt: 0,
};

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

describe('planDocument 退化小节与语义扩展兜底（真实生成回归：章节任务未就绪根因）', () => {
  it('无预设小节章节：小节=章节标题，资源类顿号标题命中语义扩展兜底查询', () => {
    const template = minimalTemplate([{ id: 'ch-1', title: '确保人、材、机的保障体系与措施', sections: [], queries: [], requiredFacts: [], purpose: '' }]);
    const { plan } = planDocument({ template, context: minimalContext() });
    const chapter = plan.chapters[0];
    expect(chapter.sections).toHaveLength(1);
    expect(chapter.sections[0].title).toBe('确保人、材、机的保障体系与措施');
    // 顿号形态「人、材、机」必须命中资源类兜底查询（修复前 /人材机/ 只匹配连续字符，此处全空）
    expect(chapter.sections[0].evidenceQueries).toContain('清单 工程量 材料 设备 机械 劳动力 规格 型号 数量 单位');
  });

  it('连续形态「人材机」标题仍命中资源类兜底查询（回归保护）', () => {
    const template = minimalTemplate([{ id: 'ch-1', title: '人材机保障体系', sections: [], queries: [], requiredFacts: [], purpose: '' }]);
    const { plan } = planDocument({ template, context: minimalContext() });
    expect(plan.chapters[0].sections[0].evidenceQueries).toContain('清单 工程量 材料 设备 机械 劳动力 规格 型号 数量 单位');
  });

  it('工期/质量类标题的兜底查询不受影响（回归保护）', () => {
    const template = minimalTemplate([{ id: 'ch-1', title: '确保工期与质量的保障体系与措施', sections: [], queries: [], requiredFacts: [], purpose: '' }]);
    const { plan } = planDocument({ template, context: minimalContext() });
    const queries = plan.chapters[0].sections[0].evidenceQueries;
    expect(queries).toContain('工期 日历天 节点 进度 计划 开工 竣工 关键线路');
    expect(queries).toContain('质量 验收 合格 标准 规范 检验批 隐蔽 复试 样板');
  });
});

describe('planChapterTask 退化小节兜底', () => {
  const chapter = { id: 'ch-1', title: '确保人、材、机的保障体系与措施', sections: [], queries: [], requiredFacts: [], purpose: '' };

  it('退化小节词面匹配全空但章节证据非空 → 就绪（章=节，章节证据天然属于该小节）', () => {
    const { plan } = planDocument({ template: minimalTemplate([chapter]), context: minimalContext() });
    // 证据不含任何兜底查询 token（无「材料/设备/机械」等），仅词面匹配必然全空
    const evidence = [{ chapterId: 'ch-1', filePath: 'a.md', score: 1, content: '施工组织保障与实施措施内容。', source: 'search' }];
    const { task } = planChapterTask({ plan, chapter, context: minimalContext(), evidence });
    expect(task.sections[0].ready).toBe(true);
    expect(task.sections[0].evidenceIds.length).toBeGreaterThan(0);
    expect(task.ready).toBe(true);
  });

  it('退化小节且章节证据为空 → 仍判 blocker（章节确实无支撑）', () => {
    const { plan } = planDocument({ template: minimalTemplate([chapter]), context: minimalContext() });
    const { task } = planChapterTask({ plan, chapter, context: minimalContext(), evidence: [] });
    expect(task.sections[0].ready).toBe(false);
    expect(task.ready).toBe(false);
    expect(task.sections[0].issues[0]?.message).toContain('缺少事实、图谱或证据支撑');
  });

  it('退化小节图谱兜底：图谱含章节标题 token 时 graphNodeIds 非空', () => {
    const { plan } = planDocument({ template: minimalTemplate([chapter]), context: minimalContext() });
    const graph = {
      ...EMPTY_GRAPH,
      works: [{ name: '主体工程', scope: '确保人材机供应与机械设备调度', sourceFiles: ['a.md'], relatedItems: [] }],
    };
    const { task } = planChapterTask({ plan, chapter, context: minimalContext({ baseProjectGraph: graph }), evidence: [] });
    expect(task.sections[0].ready).toBe(true);
    expect(task.sections[0].graphNodeIds.length).toBeGreaterThan(0);
  });

  it('非退化多小节章节不受兜底影响：无支撑小节仍判 blocker', () => {
    const multiChapter = { id: 'ch-1', title: '确保工期与质量的保障体系与措施', sections: ['进度组织', '质量控制'], queries: [], requiredFacts: [], purpose: '' };
    const { plan } = planDocument({ template: minimalTemplate([multiChapter]), context: minimalContext() });
    const { task } = planChapterTask({ plan, chapter: multiChapter, context: minimalContext(), evidence: [] });
    expect(task.sections.every(section => !section.ready)).toBe(true);
    expect(task.ready).toBe(false);
  });
});
