import { describe, expect, it } from 'vitest';
import { buildTargetedRepairInstruction, reviewChapterDraft } from '../src/services/document-workflow/agentPlanner';
import type { AgentChapterTask } from '../src/services/document-workflow/agentPlanner';
import type { AgentWorkflowContext } from '../src/services/document-workflow/agentWorkflow';
import type { DocumentDraftChapter, ProjectGraph } from '../src/services/document-workflow/types';

/**
 * Reviewer 禁止话术大规模测试（语义分层治理：确定性词面标记 + Repairer 语义改写）：
 * 覆盖：工作包标记契约、suggestion 语义改写口径、repairable 判定、正常正文不误报、
 * 其他禁止话术回归、修复指令组装（Repairer 收到语境改写示例）。
 */
const emptyGraph = { works: [], methods: [], resources: [], schedule: [], standards: [], risks: [], requirements: [], siteConditions: [] } as unknown as ProjectGraph;
const context = {
  runId: 'r1',
  templateId: 't1',
  requirement: '',
  projectRoot: '/tmp',
  materialScope: { selectedRoots: ['当前项目'], selectedFiles: [], totalAvailableFiles: 0, ambiguous: false, locked: true, reason: '', rejectedRoots: [], scopeHash: 'h' },
  materialSnapshot: { files: [], totalFiles: 0, totalChunks: 0, roots: ['当前项目'], createdAt: 0, snapshotHash: 's' },
  nodes: [],
  facts: [],
  baseProjectGraph: emptyGraph,
  issues: [],
  createdAt: 0,
} as unknown as AgentWorkflowContext;

const NON_CRITICAL_TITLE = '施工准备与现场布置';

function makeTask(sectionTitle: string = NON_CRITICAL_TITLE): AgentChapterTask {
  return {
    taskId: 't1',
    chapterId: 'ch1',
    title: '第一章',
    facts: [],
    evidence: [],
    graphContext: '',
    sections: [{
      title: sectionTitle,
      objective: '',
      requiredFacts: [],
      requiredGraphNodes: [],
      evidenceQueries: [],
      forbiddenPhrases: [],
      minChars: 260,
      factIds: [],
      evidenceIds: [],
      graphNodeIds: [],
      ready: true,
      issues: [],
    }],
    ready: true,
    issues: [],
  };
}

function makeDraft(content: string): DocumentDraftChapter {
  return { id: 'ch1', title: '第一章', content, evidence: [], missingFacts: [], sections: [] };
}

function issuesFor(content: string, sectionTitle: string = NON_CRITICAL_TITLE) {
  return reviewChapterDraft({ task: makeTask(sectionTitle), draft: makeDraft(content), context }).issues;
}

const LONG_FORMAL_BODY = '本施工准备阶段完成场地围挡搭设、临水临电接入与材料堆场规划，责任岗位为施工员与安全员，每道工序落实自检与专职检查，检查频次每班一次，整改完成后复查销项形成闭环记录。'.repeat(3);

describe('reviewChapterDraft 工作包词面标记', () => {
  it('标题出现“工作包”时报 blocker 禁止话术 issue', () => {
    const issues = issuesFor(`### ${NON_CRITICAL_TITLE}\n#### 拆除工程工作包\n${LONG_FORMAL_BODY}`);
    const hit = issues.find(issue => /禁止话术/u.test(issue.message));
    expect(hit).toBeDefined();
    expect(hit!.level).toBe('error');
    expect(hit!.severity).toBe('blocker');
    expect(hit!.category).toBe('style');
    expect(hit!.owner).toBe('system');
  });

  it('正文叙述出现“工作包”时报 blocker', () => {
    const issues = issuesFor(`### ${NON_CRITICAL_TITLE}\n以下按工作包逐项说明施工概况、施工流程、施工方法。${LONG_FORMAL_BODY}`);
    expect(issues.some(issue => /禁止话术：工作包/u.test(issue.message))).toBe(true);
  });

  it('表格中出现“工作包”时报 blocker', () => {
    const issues = issuesFor(`### ${NON_CRITICAL_TITLE}\n${LONG_FORMAL_BODY}\n| 拆除作业 | 拆除工作包、相邻商铺安全 |`);
    expect(issues.some(issue => /禁止话术：工作包/u.test(issue.message))).toBe(true);
  });

  it('工作包 issue 的 suggestion 要求结合上下文语义改写而非词面替换', () => {
    const issues = issuesFor(`### ${NON_CRITICAL_TITLE}\n#### 拆除工程工作包\n${LONG_FORMAL_BODY}`);
    const hit = issues.find(issue => /禁止话术：工作包/u.test(issue.message));
    expect(hit!.suggestion).toContain('结合上下文语义改写');
    expect(hit!.suggestion).toContain('拆除工程');
    expect(hit!.suggestion).toContain('不得做词面替换');
  });

  it('正常正式术语（专业工程）正文不触发工作包标记', () => {
    const issues = issuesFor(`### ${NON_CRITICAL_TITLE}\n以下按专业工程逐项说明施工概况。${LONG_FORMAL_BODY}`);
    expect(issues.some(issue => /工作包/u.test(issue.message))).toBe(false);
  });
});

describe('reviewChapterDraft 其他禁止话术回归（FORMAL_FORBIDDEN_PHRASES 全词表）', () => {
  const forbiddenCases: Array<[string, string]> = [
    ['知识库', '本工程知识库检索到相关规范。'],
    ['待确认', '管线位置待确认。'],
    ['资料不足', '该区域资料不足。'],
    ['系统暂未', '系统暂未提供检测数据。'],
    ['不适用', '本条不适用。'],
  ];
  for (const [phrase, sentence] of forbiddenCases) {
    it(`“${phrase}”仍按禁止话术报 blocker（回归）`, () => {
      const issues = issuesFor(`### ${NON_CRITICAL_TITLE}\n${sentence}${LONG_FORMAL_BODY}`);
      expect(issues.some(issue => issue.message.includes(`禁止话术：${phrase}`))).toBe(true);
    });
  }

  it('多短语同时出现时逐条上报', () => {
    const issues = issuesFor(`### ${NON_CRITICAL_TITLE}\n知识库检索后待确认。工作包说明如下。${LONG_FORMAL_BODY}`);
    const forbidden = issues.filter(issue => /禁止话术/u.test(issue.message));
    expect(forbidden.length).toBeGreaterThanOrEqual(3);
  });

  it('全部正式表达时零禁止话术 issue', () => {
    const issues = issuesFor(`### ${NON_CRITICAL_TITLE}\n${LONG_FORMAL_BODY}`);
    expect(issues.filter(issue => /禁止话术/u.test(issue.message))).toEqual([]);
  });
});

describe('reviewChapterDraft 工作包标记的 repairable 判定', () => {
  it('仅工作包 blocker 时 repairable=true（进入 Repairer 语义改写）', () => {
    const review = reviewChapterDraft({ task: makeTask(), draft: makeDraft(`### ${NON_CRITICAL_TITLE}\n#### 拆除工程工作包\n${LONG_FORMAL_BODY}`), context });
    expect(review.repairable).toBe(true);
  });

  it('工作包 + 正文不足同时存在时 repairable=true（深度修复与术语改写同轮处理）', () => {
    const review = reviewChapterDraft({ task: makeTask(), draft: makeDraft('#### 拆除工程工作包\n只有一句话。'), context });
    expect(review.repairable).toBe(true);
  });

  it('全部达标时 repairable=false（不再触发无谓修复轮次）', () => {
    const review = reviewChapterDraft({ task: makeTask(), draft: makeDraft(`### ${NON_CRITICAL_TITLE}\n${LONG_FORMAL_BODY}`), context });
    expect(review.repairable).toBe(false);
  });
});

describe('buildTargetedRepairInstruction 语义改写指令组装', () => {
  it('工作包 issue 进入修复指令且携带语境改写示例', () => {
    const task = makeTask();
    const draft = makeDraft(`### ${NON_CRITICAL_TITLE}\n#### 拆除工程工作包\n${LONG_FORMAL_BODY}`);
    const review = reviewChapterDraft({ task, draft, context });
    const instruction = buildTargetedRepairInstruction({ task, review });
    expect(instruction).toContain('禁止话术：工作包');
    expect(instruction).toContain('结合上下文语义改写');
    expect(instruction).toContain('拆除工程工作包');
  });

  it('无 repairable 问题时返回空指令', () => {
    const review = reviewChapterDraft({ task: makeTask(), draft: makeDraft(`### ${NON_CRITICAL_TITLE}\n${LONG_FORMAL_BODY}`), context });
    expect(buildTargetedRepairInstruction({ task: makeTask(), review })).toBe('');
  });

  it('修复指令不含词面替换式引导（不教 Repairer 用 replace）', () => {
    const task = makeTask();
    const draft = makeDraft(`### ${NON_CRITICAL_TITLE}\n#### 拆除工程工作包\n${LONG_FORMAL_BODY}`);
    const review = reviewChapterDraft({ task, draft, context });
    const instruction = buildTargetedRepairInstruction({ task, review });
    expect(instruction).not.toContain('替换为');
  });
});
