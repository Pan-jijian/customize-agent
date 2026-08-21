import { describe, expect, it, vi } from 'vitest';
import { callDocumentLlmJson } from '../src/services/document-workflow/llmClient';

vi.mock('../src/services/document-workflow/llmClient', () => ({
  callDocumentLlmJson: vi.fn(),
}));

import { buildProjectGraph } from '../src/services/document-workflow/projectGraph';
import type { DocumentEvidence, ProjectGraph } from '../src/services/document-workflow/types';

const emptyGraph: ProjectGraph = { works: [], methods: [], resources: [], schedule: [], standards: [], risks: [], requirements: [], siteConditions: [], addendumChanges: [], gaps: [], generatedAt: Date.now() };

function evidence(): DocumentEvidence[] {
  return [{
    filePath: '招标文件正文.pdf',
    title: '项目概况',
    sectionTitle: '招标范围',
    content: '招标项目名称：徽光阁项目施工。建设地点：安徽省合肥市庐阳区安庆路城隍庙内。建设规模：建筑面积约4645㎡。计划工期：45日历天。质量标准：合格。招标范围：本项目维修改造包含室内装饰工程、屋面维修、水电安装工程、智能化安装工程、消防改造工程、加固工程等。主要材料包含墙面饰面材料、电气设备及消防设备。现场存在既有建筑保护和交叉作业风险。',
    score: 1,
    sourceRole: 'project_overview',
  }];
}

describe('buildProjectGraph', () => {
  it('fails instead of returning deterministic fallback when LLM graph stays empty', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue(emptyGraph);

    const result = await buildProjectGraph({ evidence: evidence(), requirement: 'empty-llm-test' });

    expect(result.graph).toBeUndefined();
    expect(result.stage.status).toBe('failed');
    expect(result.stage.message).not.toContain('确定性兜底');
    expect(callDocumentLlmJson).toHaveBeenCalledTimes(12);
  });

  it('builds a valid graph from domain LLM extraction', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValueOnce({
      ...emptyGraph,
      works: [{ name: '维修改造工程', scope: '室内装饰、屋面维修、水电安装、智能化安装、消防改造、加固工程等。', sourceFiles: ['招标文件正文.pdf'], relatedItems: [] }],
      requirements: [{ category: '项目名称', detail: '徽光阁项目施工', sourceFiles: ['招标文件正文.pdf'] }],
    }).mockResolvedValueOnce({
      ...emptyGraph,
      methods: [{ name: '维修改造施工方法', steps: ['施工准备', '分区施工', '验收移交'], applicableWorks: ['维修改造工程'], sourceFiles: ['招标文件正文.pdf'] }],
    }).mockResolvedValueOnce({
      ...emptyGraph,
      resources: [{ name: '墙面饰面材料', type: 'material', spec: '', quantity: '', unit: '', sourceFiles: ['招标文件正文.pdf'] }],
    }).mockResolvedValueOnce({
      ...emptyGraph,
      schedule: [{ milestone: '总工期控制', duration: '45日历天', startDate: '', endDate: '', sourceFiles: ['招标文件正文.pdf'] }],
      standards: [{ code: '质量标准', description: '合格', sourceFiles: ['招标文件正文.pdf'] }],
    }).mockResolvedValueOnce({
      ...emptyGraph,
      risks: [{ risk: '既有建筑保护和交叉作业风险', level: 'medium', mitigation: '分区组织施工并落实成品保护。', sourceFiles: ['招标文件正文.pdf'] }],
      siteConditions: [{ condition: '既有建筑保护', impact: '施工组织需控制交叉作业影响。', sourceFiles: ['招标文件正文.pdf'] }],
    }).mockResolvedValueOnce({
      ...emptyGraph,
      requirements: [{ category: '建设地点', detail: '安徽省合肥市庐阳区安庆路城隍庙内', sourceFiles: ['招标文件正文.pdf'] }],
    });

    const result = await buildProjectGraph({ evidence: evidence(), requirement: 'domain-success-test' });

    expect(result.stage.status).toBe('success');
    expect(result.graph?.works[0]?.name).toBe('维修改造工程');
    expect(result.graph?.schedule[0]?.duration).toBe('45日历天');
    expect(result.stage.message).not.toContain('确定性兜底');
  });
});
