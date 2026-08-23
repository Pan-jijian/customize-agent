import { describe, expect, it } from 'vitest';
import { sectionStructureIssue } from '../src/services/document-workflow/chapterGeneration';
import { professionalSectionTaskCard } from '../src/services/document-workflow/promptRuleExtraction';
import { reviewChapterDraft } from '../src/services/document-workflow/agentPlanner';
import type { AgentWorkflowContext } from '../src/services/document-workflow/agentWorkflow';
import type { ProjectGraph } from '../src/services/document-workflow/types';

// “项目主要施工内容”节模板：5 个工作包，方法段正文是否含“→”由 buildBlock 注入
const buildBlock = (installMethod: string, othersWithArrow: boolean) => `### 项目主要施工内容

#### 安装工程

施工概况：安装工程属于本项目主要施工内容，实施范围为含配电箱安装等。配电箱均为非标箱，采用挂墙安装。

施工流程：箱位定位→柜内元器件接线→挂墙安装→通电调试。

施工方法：${installMethod}

#### 结构加固改造工程

施工概况：结构加固改造工程属于本项目主要施工内容，实施范围为含砌块墙等。砌块墙为加气混凝土砌块、M5.0混合砂浆。

施工流程：基层清理→放线定位→铺浆砌筑→墙顶塞缝。

施工方法：${othersWithArrow ? '砌筑顺序按基层清理→放线定位→排砖撂底→铺浆砌筑→墙顶塞缝组织，灰缝厚度控制在8~12mm。' : '砌块墙采用加气混凝土砌块与M5.0混合砂浆砌筑，砌筑前弹线定位、排砖撂底，灰缝厚度控制在8~12mm。'}

#### 拆除工程

施工概况：拆除工程属于本项目主要施工内容，实施范围为楼地面及天棚拆除。

施工流程：围挡隔离→分层拆除→垃圾清运。

施工方法：${othersWithArrow ? '作业顺序按围挡防护→切断连接→分层剔凿→渣土归堆→外运组织，湿法作业降尘。' : '拆除采用自上而下分层作业，湿法作业降尘，垃圾清运日产日清。'}

#### 装饰工程

施工概况：装饰工程属于本项目主要施工内容，实施范围为墙面抹灰、墙地砖铺贴及吊顶。

施工流程：基层处理→抹灰→铺贴。

施工方法：${othersWithArrow ? '作业顺序按基层清理→打点冲筋→分层抹灰→养护检查组织，每遍抹灰厚度≤7mm。' : '抹灰采用打点冲筋、分层抹灰工艺，每遍抹灰厚度≤7mm。'}

#### 室外道排工程

施工概况：室外道排工程属于本项目主要施工内容，实施范围为室外雨污水管网。

施工流程：沟槽开挖→管道安装→闭水试验→回填。

施工方法：${othersWithArrow ? '安装顺序按沟槽开挖→垫层铺设→管道安装→闭水试验→分层回填组织，回填分层厚度≤250mm。' : '管道安装轴线偏差≤15mm，回填分层厚度≤250mm，形成闭水试验记录闭环。'}
`;

const arrowInstallMethod = '配电箱采用挂墙方式安装，箱体安装牢固、盘面垂直；安装顺序按箱位定位→弹线钻孔→膨胀螺栓固定→箱体找正组织；柜内元器件按系统图接线，导线分色标识；安装完成后进行绝缘电阻测试与通电试运行，形成检测记录闭环。';
const plainInstallMethod = '配电箱采用挂墙方式安装，箱体安装牢固、盘面垂直；柜内元器件按系统图接线，导线分色标识；安装完成后进行绝缘电阻测试与通电试运行，形成检测记录闭环。';

describe('sectionStructureIssue 工序链箭头硬门（项目主要施工内容）', () => {
  it('flags method paragraphs without arrow chains when all methods lack arrows', () => {
    const issue = sectionStructureIssue('项目主要施工内容', buildBlock(plainInstallMethod, false));
    expect(issue).toContain('工序链箭头缺失');
  });

  it('flags a single method paragraph missing arrow chain even when others have arrows', () => {
    const issue = sectionStructureIssue('项目主要施工内容', buildBlock(plainInstallMethod, true));
    expect(issue).toContain('工序链箭头缺失');
  });

  it('accepts sections where every method paragraph contains an arrow chain', () => {
    const issue = sectionStructureIssue('项目主要施工内容', buildBlock(arrowInstallMethod, true));
    expect(issue).toBe('');
  });
});

describe('professionalSectionTaskCard 工序链箭头写作要求', () => {
  it('requires arrow chains for construction method sections', () => {
    const card = professionalSectionTaskCard('确保工期与质量的保障体系与措施', '主要分部分项工程施工方案');
    expect(card).toContain('箭头工序链');
    expect(card).toContain('→');
    expect(card).toContain('硬性格式要求');
  });

  it('requires arrow chains for process-sequence sections', () => {
    const card = professionalSectionTaskCard('确保工期与质量的保障体系与措施', '三检制度');
    expect(card).toContain('箭头链');
    expect(card).toContain('→');
  });

  it('does not require arrow chains for organization sections', () => {
    const card = professionalSectionTaskCard('确保工期与质量的保障体系与措施', '项目管理组织机构与职责');
    expect(card).not.toContain('箭头链');
  });
});

describe('reviewChapterDraft 工序链箭头密度审查', () => {
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
  const flowSection = {
    title: '主要分部分项工程施工流程',
    objective: '',
    requiredFacts: [],
    requiredGraphNodes: [],
    evidenceQueries: [],
    forbiddenPhrases: [],
    minChars: 300,
    factIds: [],
    evidenceIds: [],
    graphNodeIds: [],
    ready: true,
    issues: [],
  };
  const plainFlowBody = Array.from({ length: 12 }, (_item, index) => `第${index + 1}步由责任班组对作业面进行条件核查，确认作业面清理、标高复核和材料到位情况后，向专业工长申报工序交接。工长收到申报后组织测量员复测控制线，复核偏差在允许范围内方可批准进入下一道工序。工序实施过程中由质检员按检验批抽查记录，关键节点留存影像资料。完成后由监理工程师组织验收确认，验收记录归档保存。`).join('');

  it('reports warning when a process section has no arrow chains', () => {
    const draft = { id: 'ch1', title: '第一章', content: `### 主要分部分项工程施工流程\n\n${plainFlowBody}`, evidence: [], missingFacts: [], sections: [] };
    const task = { taskId: 't1', chapterId: 'ch1', title: '第一章', facts: [], evidence: [], graphContext: '', sections: [flowSection], ready: true, issues: [] };
    const review = reviewChapterDraft({ task, draft, context });
    expect(review.issues.some(issue => /工序链箭头缺失/u.test(issue.message))).toBe(true);
  });

  it('passes when a process section contains arrow chains', () => {
    const arrowFlowBody = `${'本工程施工流程按作业面条件核查→工序交接申报→测量复核→批准进入→过程抽查→监理验收组织，各环节落实责任人。'.repeat(12)}`;
    const draft = { id: 'ch1', title: '第一章', content: `### 主要分部分项工程施工流程\n\n${arrowFlowBody}`, evidence: [], missingFacts: [], sections: [] };
    const task = { taskId: 't1', chapterId: 'ch1', title: '第一章', facts: [], evidence: [], graphContext: '', sections: [flowSection], ready: true, issues: [] };
    const review = reviewChapterDraft({ task, draft, context });
    expect(review.issues.some(issue => /工序链箭头缺失/u.test(issue.message))).toBe(false);
  });
});
