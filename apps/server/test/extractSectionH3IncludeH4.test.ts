import { describe, expect, it } from 'vitest';
import { extractSection, comparableSectionTitleText } from '../src/services/document-workflow/utils';
import { reviewChapterDraft } from '../src/services/document-workflow/agentPlanner';
import type { AgentChapterTask } from '../src/services/document-workflow/agentPlanner';
import type { AgentWorkflowContext } from '../src/services/document-workflow/agentWorkflow';
import type { DocumentDraftChapter, ProjectGraph } from '../src/services/document-workflow/types';

// 真实生成缺陷回归：徽光阁章 1（工程重点难点及危大工程的保障体系）Reviewer 3 轮修复仍报 2 个阻断问题。
// 根因一：H3 小节正文全部承载于 H4 子节（H3 自身零正文），fuzzy 提取在 H4 处截断 → 提取 0 字 → 误报"正文不足"。
// 根因二：成稿标题把细目顿号改写为"与/及"（"项目特点、重点、难点分析"→"工程特点与重点难点分析"），可比归一化不剥离连接词 → 永久匹配失败。
const CONTENT = [
  '## 工程重点难点及危大工程的保障体系',
  '### 1.1 编制说明与工程概况',
  '编制说明正文段落，说明本方案编制目的与适用范围。',
  '#### 1.1.2 编制依据',
  '编制依据正文段落，列出招标文件与相关规范。',
  '### 工程特点与重点难点分析',
  '#### 工程总体特点',
  `${'本项目为框架结构改造工程，涉及拆除、加固与装饰等多专业交叉施工，总体特点鲜明。'.repeat(20)}`,
  '#### 施工重点分析',
  `${'施工重点在于结构加固与既有管线保护，必须先行探测后施工。'.repeat(16)}`,
  '#### 施工难点分析',
  `${'施工难点集中于高空作业与场地受限条件下的垂直运输组织。'.repeat(16)}`,
  '#### 重难点风险闭环',
  `${'重难点风险逐项识别并落实责任人，检查验收闭环管理。'.repeat(10)}`,
  '### 危大工程及重点难点保障体系',
  '#### 安全目标与责任体系',
  '安全目标为杜绝较大及以上事故，责任逐级分解到岗到人。',
  '### 危大工程专项施工方案审批流程',
  '#### 资料依据与清单边界',
  `${'危大工程方案审批依据住建部危大工程管理规定，清单边界明确。'.repeat(10)}`,
  '#### 方案识别与编制组织',
  `${'方案识别由技术负责人牵头，编制组织按专业分工落实。'.repeat(9)}`,
  '#### 内部评审与报审流程',
  `${'内部评审经项目总工审核后报公司技术部门审批。'.repeat(9)}`,
  '#### 审批后交底与实施闭环',
  `${'审批通过后组织方案交底，实施过程监测验收闭环。'.repeat(9)}`,
].join('\n');

describe('extractSection fuzzy H3 向下包含 H4 子节（真实生成缺陷：H3 自身零正文误报正文不足）', () => {
  it('H3 小节正文全部在 H4 子节时提取包含 H4 正文', () => {
    const body = extractSection(CONTENT, '危大工程专项施工方案审批流程', { fuzzy: true });
    expect(body.length).toBeGreaterThan(800);
    expect(body).toContain('资料依据与清单边界');
    expect(body).toContain('审批后交底与实施闭环');
  });

  it('工作包型小节提取行为保持向下包含同级 H4', () => {
    const workPackageContent = `### 项目主要施工内容\n\n#### 拆除工程施工\n${'拆除工程施工内容段落，垃圾外运与既有设施保护。'.repeat(8)}\n#### 建筑结构加固改造施工\n${'结构加固改造施工内容段落，墙体补强与框架结构处理。'.repeat(8)}`;
    const body = extractSection(workPackageContent, '项目主要施工内容', { fuzzy: true });
    expect(body).toContain('拆除工程施工内容段落');
    expect(body).toContain('结构加固改造施工内容段落');
  });
});

describe('comparableSectionTitleText 剥离连接词（真实生成缺陷：顿号↔与/及标题改写导致永久匹配失败）', () => {
  it('顿号与"与/及/和"连接词不参与可比性', () => {
    expect(comparableSectionTitleText('项目特点、重点、难点分析')).toBe(comparableSectionTitleText('工程特点与重点难点分析'));
    expect(comparableSectionTitleText('安全及文明施工')).toBe(comparableSectionTitleText('安全、文明施工'));
    expect(comparableSectionTitleText('质量、安全、进度控制')).toBe(comparableSectionTitleText('质量安全和进度控制'));
  });

  it('跨标题改写的 critical 小节模糊定位可命中', () => {
    const body = extractSection(CONTENT, '项目特点、重点、难点分析', { fuzzy: true });
    expect(body.length).toBeGreaterThan(1000);
    expect(body).toContain('施工重点分析');
  });
});

describe('reviewChapterDraft 不再误报 H3 零正文小节的阻断问题（回归：3 轮修复空转）', () => {
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

  const makeTask = (): AgentChapterTask => ({
    taskId: 't1',
    chapterId: 'ch1',
    title: '工程重点难点及危大工程的保障体系',
    facts: [],
    evidence: [],
    graphContext: '',
    ready: true,
    issues: [],
    sections: [
      { title: '项目特点、重点、难点分析', objective: '', requiredFacts: [], requiredGraphNodes: [], evidenceQueries: [], forbiddenPhrases: [], minChars: 1800, factIds: [], evidenceIds: [], graphNodeIds: [], ready: true, issues: [] },
      { title: '危大工程专项施工方案审批流程', objective: '', requiredFacts: [], requiredGraphNodes: [], evidenceQueries: [], forbiddenPhrases: [], minChars: 500, factIds: [], evidenceIds: [], graphNodeIds: [], ready: true, issues: [] },
    ],
  });

  it('成稿标题被改写且正文全在 H4 子节时，两个 critical 小节均不报"正文不足"', () => {
    const draft: DocumentDraftChapter = { id: 'ch1', title: '工程重点难点及危大工程的保障体系', content: CONTENT, evidence: [], missingFacts: [], sections: [] };
    const review = reviewChapterDraft({ task: makeTask(), draft, context });
    const depthErrors = review.issues.filter(issue => issue.level === 'error' && /正文不足，未达到任务最小深度/u.test(issue.message));
    expect(depthErrors.map(issue => issue.message)).toEqual([]);
  });
});
