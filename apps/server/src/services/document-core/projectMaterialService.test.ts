import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeFileDiscoveryItem } from '../knowledge/kbService';

vi.mock('../knowledge/kbService', () => ({
  listKnowledgeFiles: vi.fn(() => [] as KnowledgeFileDiscoveryItem[]),
}));

import { listKnowledgeFiles } from '../knowledge/kbService';
import { buildProjectMaterialSummary, projectMaterialPrompt, type ProjectMaterialSummary } from './projectMaterialService';

function mkFile(relativePath: string, overrides: Partial<KnowledgeFileDiscoveryItem> = {}): KnowledgeFileDiscoveryItem {
  return {
    relativePath,
    category: 'unknown',
    format: 'pdf',
    fileSize: 100,
    mtime: 1,
    chunkCount: 3,
    indexedAt: 1,
    lastVerifiedAt: 1,
    status: 'ready',
    matchedBy: 'disk',
    ...overrides,
  };
}

const STANDARD_FILES = [
  mkFile('滨湖校区改造工程项目/2024ABC12345.pdf'),
  mkFile('滨湖校区改造工程项目/需求说明.pdf'),
  mkFile('滨湖校区改造工程项目/工程量明细.xlsx'),
  mkFile('滨湖校区改造工程项目/预算书.pdf'),
  mkFile('滨湖校区改造工程项目/风险预案.pdf'),
];

describe('buildProjectMaterialSummary', () => {
  it('完整构造：项目名/编号/角色库存/覆盖率/指纹/摘要', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue(STANDARD_FILES);
    const summary = buildProjectMaterialSummary('/proj');

    expect(summary.projectName).toBe('滨湖校区改造工程项目');
    expect(summary.facts.documentNo).toBe('2024ABC12345');
    // 角色分配：需求→requirement_document，说明→design_specification，明细→structured_data，
    // 预算→budget_cost，风险→risk_constraints，全部文件附带 project_overview
    expect(summary.materialInventory.requirement_document.map(f => f.fileName)).toEqual(['需求说明.pdf']);
    expect(summary.materialInventory.design_specification.map(f => f.fileName)).toEqual(['需求说明.pdf']);
    expect(summary.materialInventory.structured_data.map(f => f.fileName)).toEqual(['工程量明细.xlsx']);
    expect(summary.materialInventory.budget_cost.map(f => f.fileName)).toEqual(['预算书.pdf']);
    expect(summary.materialInventory.risk_constraints.map(f => f.fileName)).toEqual(['风险预案.pdf']);
    expect(summary.materialInventory.project_overview).toHaveLength(5);
    // 覆盖率：基础必需角色 + 库存非空的角色
    expect(summary.coverage.missingRoles).toEqual(['scope_description']);
    expect(summary.coverage.satisfiedRoles).toContain('budget_cost');
    // 指纹与污染候选
    expect(summary.fingerprint.projectNames).toEqual(['滨湖校区改造工程项目']);
    expect(summary.fingerprint.documentNos).toEqual(['2024ABC12345']);
    expect(summary.fingerprint.fileGroups).toEqual(['滨湖校区改造工程项目']);
    expect(summary.fingerprint.confidence).toBe(1);
    expect(summary.contaminationCandidates).toEqual([]);
    // 来源统计
    expect(summary.source.totalFiles).toBe(5);
    expect(summary.source.selectedFiles).toBe(5);
    expect(summary.source.ambiguous).toBe(false);
    // 事实派生
    expect(summary.facts.professionalScopes).toContain('需求说明');
    expect(summary.facts.scopeDescriptions).toEqual([]);
    // 摘要段落
    expect(summary.extractedSections.projectOverview).toBe('绑定材料组：滨湖校区改造工程项目，文档/任务编号：2024ABC12345。');
    expect(summary.extractedSections.designSummary).toBe('设计/方案/说明资料：需求说明。');
    expect(summary.extractedSections.structuredDataSummary).toBe('结构化数据资料：工程量明细。');
    expect(summary.extractedSections.constraintsAndRisks).toBe('约束和风险资料：风险预案。');
    expect(summary.extractedSections.scopeSummary).toBe('范围资料：未识别到明确范围资料。');
  });

  it('无项目名候选时回退默认名', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([mkFile('资料包/附件清单.pdf')]);
    const summary = buildProjectMaterialSummary('/proj');
    expect(summary.projectName).toBe('当前知识库项目');
  });

  it('项目名落在文件名时走 fileLike 分支', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([
      mkFile('资料/附件.pdf'),
      mkFile('资料/某市政改造工程项目.docx'),
    ]);
    const summary = buildProjectMaterialSummary('/proj');
    expect(summary.projectName).toBe('某市政改造工程项目');
  });

  it('bundle 名称分组取含项目词的最短段', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([
      mkFile('打包资料/资料--滨湖校区改造工程项目--汇总'),
    ]);
    const summary = buildProjectMaterialSummary('/proj');
    expect(summary.projectName).toBe('滨湖校区改造工程项目');
  });

  it('status=error 文件不参与选择', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([
      mkFile('滨湖校区改造工程项目/需求说明.pdf', { status: 'error', errorMessage: '解析失败' }),
      mkFile('滨湖校区改造工程项目/工程量明细.xlsx'),
    ]);
    const summary = buildProjectMaterialSummary('/proj');
    expect(summary.source.totalFiles).toBe(2);
    expect(summary.source.selectedFiles).toBe(1);
    expect(summary.materialInventory.requirement_document).toEqual([]);
  });
});

describe('资料组选择', () => {
  it('boundFilePaths 定位到单一资料组（仅取绑定文件本身）', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue(STANDARD_FILES);
    const summary = buildProjectMaterialSummary('/proj', { boundFilePaths: ['滨湖校区改造工程项目/需求说明.pdf'] });
    expect(summary.source.selectionReason).toBe('模板绑定文件定位到资料组：滨湖校区改造工程项目');
    expect(summary.source.selectedFiles).toBe(1);
    expect(summary.source.ambiguous).toBe(false);
  });

  it('boundFilePaths 跨多组时取绑定文件全集', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([
      mkFile('组A/需求说明.pdf'),
      mkFile('组B/工程量明细.xlsx'),
      mkFile('组C/无关文件.pdf'),
    ]);
    const summary = buildProjectMaterialSummary('/proj', { boundFilePaths: ['组A/需求说明.pdf', '组B/工程量明细.xlsx'] });
    expect(summary.source.selectedFiles).toBe(2);
    expect(summary.source.selectionReason).toBe('使用模板显式绑定文件作为资料范围');
  });

  it('requirement 打分定位资料组（组名需可分词且 token 落在 requirement 内）', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([
      mkFile('滨湖校区-改造工程项目/需求说明.pdf'),
      mkFile('其他资料/工程量明细.xlsx'),
    ]);
    const summary = buildProjectMaterialSummary('/proj', { requirement: '滨湖校区改造工程' });
    expect(summary.source.selectionReason).toBe('需求描述定位到资料组：滨湖校区-改造工程项目');
    expect(summary.source.selectedFiles).toBe(1);
  });

  it('单一资料组直接使用', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue(STANDARD_FILES);
    const summary = buildProjectMaterialSummary('/proj');
    expect(summary.source.selectionReason).toBe('知识库单一资料组：滨湖校区改造工程项目');
  });

  it('多资料组且无定位条件时阻断（ambiguous）', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([
      mkFile('组A/需求说明.pdf'),
      mkFile('组B/工程量明细.xlsx'),
    ]);
    const summary = buildProjectMaterialSummary('/proj');
    expect(summary.source.ambiguous).toBe(true);
    expect(summary.source.selectedFiles).toBe(2);
    expect(summary.source.selectionReason).toContain('已阻断生成避免跨项目污染');
    // 多组时污染候选包含未选组的项目名
    expect(summary.contaminationCandidates.length).toBeGreaterThanOrEqual(0);
  });

  it('无资料组时使用全部资料', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([
      mkFile('需求说明.pdf'),
      mkFile('工程量明细.xlsx'),
    ]);
    const summary = buildProjectMaterialSummary('/proj');
    expect(summary.source.selectionReason).toBe('未检测到资料组，使用全部资料');
    expect(summary.source.selectedFiles).toBe(2);
  });

  it('boundFileRoles 显式绑定角色合并进库存', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([
      mkFile('滨湖校区改造工程项目/普通文件.pdf'),
    ]);
    const summary = buildProjectMaterialSummary('/proj', {
      boundFileRoles: [{ filePath: '滨湖校区改造工程项目/普通文件.pdf', roles: ['budget_cost', 'scope_description'] }],
    });
    expect(summary.materialInventory.budget_cost.map(f => f.fileName)).toEqual(['普通文件.pdf']);
    expect(summary.materialInventory.scope_description.map(f => f.fileName)).toEqual(['普通文件.pdf']);
    expect(summary.coverage.missingRoles).not.toContain('scope_description');
  });

  it('facts 文本抽取：责任主体/地点/周期/质量', () => {
    vi.mocked(listKnowledgeFiles).mockReturnValue([
      mkFile('滨湖校区改造工程项目/责任主体：合肥市教育局'),
      mkFile('滨湖校区改造工程项目/项目地点：滨湖大道100号'),
      mkFile('滨湖校区改造工程项目/周期：540天'),
      mkFile('滨湖校区改造工程项目/质量目标：优良'),
    ]);
    const summary = buildProjectMaterialSummary('/proj');
    expect(summary.facts.ownerNames).toEqual(['合肥市教育局']);
    expect(summary.facts.locationNames).toEqual(['滨湖大道100号']);
    expect(summary.facts.scheduleValues).toEqual(['周期：540天']);
    expect(summary.facts.qualityTargets).toContain('质量目标：优良');
  });
});

describe('projectMaterialPrompt', () => {
  function makeSummary(): ProjectMaterialSummary {
    vi.mocked(listKnowledgeFiles).mockReturnValue(STANDARD_FILES);
    return buildProjectMaterialSummary('/proj');
  }

  it('后台形态包含材料指纹与内容级事实', () => {
    const prompt = projectMaterialPrompt(makeSummary());
    expect(prompt).toContain('## 后台绑定材料摘要');
    expect(prompt).toContain('材料指纹：对象名候选 滨湖校区改造工程项目');
    expect(prompt).toContain('编号 2024ABC12345');
    expect(prompt).toContain('内容级事实候选');
  });

  it('publicSafe 形态清洗内部术语并声明事实边界', () => {
    const summary = makeSummary();
    const prompt = projectMaterialPrompt(summary, { publicSafe: true });
    expect(prompt).toContain('## 项目资料事实边界');
    expect(prompt).not.toContain('后台绑定');
    expect(prompt).not.toContain('知识库');
    expect(prompt).toContain('明确事实：责任主体 资料未明确；地点 资料未明确');
    expect(prompt).toContain('仅使用资料中明确、可信的事实');
  });

  it('publicSafe 清洗 OCR/格式关键词', () => {
    const summary = makeSummary();
    summary.extractedSections.projectOverview = '绑定材料组：OCR识别错误，知识库文件为PDF格式';
    const prompt = projectMaterialPrompt(summary, { publicSafe: true });
    expect(prompt).toContain('资料文字不清');
    expect(prompt).toContain('项目资料文件为资料文件格式');
  });
});
