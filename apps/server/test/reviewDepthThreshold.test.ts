import { describe, expect, it } from 'vitest';
import { reviewChapterDraft } from '../src/services/document-workflow/agentPlanner';
import type { AgentChapterTask } from '../src/services/document-workflow/agentPlanner';
import type { AgentWorkflowContext } from '../src/services/document-workflow/agentWorkflow';
import type { DocumentDraftChapter, ProjectGraph } from '../src/services/document-workflow/types';

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

const SECTION_MIN_CHARS = 2200;

function makeSection() {
  return {
    title: '项目主要施工内容',
    objective: '',
    requiredFacts: [],
    requiredGraphNodes: [],
    evidenceQueries: [],
    forbiddenPhrases: [],
    minChars: SECTION_MIN_CHARS,
    factIds: [],
    evidenceIds: [],
    graphNodeIds: [],
    ready: true,
    issues: [],
  };
}

function makeTask(): AgentChapterTask {
  return { taskId: 't1', chapterId: 'ch1', title: '第一章', facts: [], evidence: [], graphContext: '', sections: [makeSection()], ready: true, issues: [] };
}

function makeDraft(bodyChars: number): DocumentDraftChapter {
  const paragraph = '本工作包施工对象为框架结构改造区域，施工前完成作业面移交、标高复核与管线探测，按拆除清运、结构加固、饰面施工、机电安装的工序顺序组织流水作业，每道工序落实自检、交接检与专职检查，检验批资料与影像记录同步归档，完工后组织分项验收并闭环整改。';
  const repeats = Math.max(1, Math.ceil(bodyChars / paragraph.length));
  const content = `### 项目主要施工内容\n\n${paragraph.repeat(repeats)}`;
  return { id: 'ch1', title: '第一章', content, evidence: [], missingFacts: [], sections: [] };
}

describe('reviewChapterDraft 关键小节深度容忍线（与 Final Gate blocker 口径一致 = minChars × 0.8）', () => {
  it('正文低于 0.8 × minChars 时触发深度修复 error（0.75 线）', () => {
    const review = reviewChapterDraft({ task: makeTask(), draft: makeDraft(Math.floor(SECTION_MIN_CHARS * 0.75)), context });
    expect(review.issues.some(issue => issue.level === 'error' && /正文不足，未达到任务最小深度/u.test(issue.message))).toBe(true);
  });

  it('正文达到 0.8 × minChars 时不再升级为 error（0.85 线）', () => {
    const review = reviewChapterDraft({ task: makeTask(), draft: makeDraft(Math.floor(SECTION_MIN_CHARS * 0.85)), context });
    expect(review.issues.some(issue => issue.level === 'error' && /正文不足，未达到任务最小深度/u.test(issue.message))).toBe(false);
  });
});
