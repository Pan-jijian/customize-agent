import { describe, expect, it } from 'vitest';
import { buildConstructionOrgTablePlans, sectionTablePlans, tablePlanExecutionGaps, tablePlansPrompt, unassignedSectionTablePlans } from '../src/services/document-workflow/constructionOrgTablePlan';
import type { DocumentTemplateChapter, ProjectGraph } from '../src/services/document-workflow/types';

function chapter(id: string, title: string, sections: string[] = [], tableSections: string[] = []): DocumentTemplateChapter {
  return { id, title, purpose: title, queries: [title], requiredFacts: [], sections, tableSections };
}

const graph: ProjectGraph = {
  works: [{ name: '道路及雨污水管网工程', scope: '包含沟槽开挖、管道铺设、道路恢复', sourceFiles: ['招标文件.docx'], relatedItems: ['沟槽开挖', '管道闭水试验'] }],
  methods: [{ name: '管道施工', steps: ['测量放线', '沟槽开挖', '管道安装', '闭水试验'], applicableWorks: ['雨污水管网'], sourceFiles: ['施工说明.docx'] }],
  resources: [
    { name: '挖掘机', type: 'equipment', spec: '1m³', quantity: '2', unit: '台', sourceFiles: ['清单.xlsx'] },
    { name: '管道安装班组', type: 'labor', spec: '', quantity: '12', unit: '人', sourceFiles: ['组织设计.docx'] },
  ],
  schedule: [{ milestone: '管网施工完成', duration: '30日历天', startDate: '', endDate: '', sourceFiles: ['招标文件.docx'] }],
  standards: [{ code: 'GB 50268', description: '给水排水管道工程施工及验收规范', sourceFiles: ['招标文件.docx'] }],
  risks: [{ risk: '沟槽坍塌及临近地下管线破坏', level: 'high', mitigation: '开挖前探测，分段支护，专人监测', sourceFiles: ['招标文件.docx'] }],
  requirements: [{ category: '文明施工', detail: '落实扬尘治理和农民工工资实名制管理', sourceFiles: ['招标文件.docx'] }],
  siteConditions: [{ condition: '临近居民区及既有地下管线', impact: '需控制噪声、扬尘并做好管线保护', sourceFiles: ['踏勘记录.docx'] }],
  addendumChanges: [],
  gaps: [],
  generatedAt: Date.now(),
};

describe('construction organization table plan', () => {
  it('derives table plans with fields from chapter modules and project graph', () => {
    const [overview, safety, resources] = buildConstructionOrgTablePlans({
      projectGraph: graph,
      chapters: [
        chapter('c1', '工程概况与施工部署', ['编制说明与工程概况']),
        chapter('c2', '安全文明保障措施', ['安全管理、风险分级与危大工程管控', '文明施工、扬尘、噪声与绿色施工']),
        chapter('c3', '资源配置计划', ['资源配置计划']),
      ],
    });

    expect(overview.tablePlans?.map(plan => plan.title)).toContain('工程概况一览表');
    expect(overview.tablePlans?.find(plan => plan.title === '工程概况一览表')?.fields.map(field => field.name)).toContain('计划工期');
    expect(safety.tablePlans?.map(plan => plan.title)).toContain('危险源辨识与风险分级管控清单');
    expect(safety.tablePlans?.map(plan => plan.title)).toContain('环境污染物管控指标一览表');
    expect(resources.tablePlans?.map(plan => plan.title)).toContain('主要施工机械设备投入计划表');
    expect(resources.tablePlans?.map(plan => plan.title)).toContain('分阶段劳动力动态投入计划表');
  });

  it('renders strict table prompt with headers and source domains', () => {
    const [safety] = buildConstructionOrgTablePlans({
      projectGraph: graph,
      chapters: [chapter('c1', '安全保障措施', ['安全管理、风险分级与危大工程管控'])],
    });
    const prompt = tablePlansPrompt(safety);
    expect(prompt).toContain('危险源辨识与风险分级管控清单');
    expect(prompt).toContain('表头字段：危险源 | 风险等级 | 存在部位 | 管控措施 | 监测频次 | 闭环要求');
    expect(prompt).toContain('可按标准施工组织流程填写，但必须贴合本章和项目场景');
  });

  it('preserves existing table plans during second-pass planning', () => {
    const [firstPass] = buildConstructionOrgTablePlans({
      projectGraph: graph,
      chapters: [chapter('c1', '资源配置计划', ['资源配置计划'])],
    });
    const [secondPass] = buildConstructionOrgTablePlans({
      projectGraph: graph,
      chapters: [{ ...firstPass, sections: [...(firstPass.sections || []), '进度计划与工期保障'] }],
    });

    expect(secondPass.tablePlans?.map(plan => plan.title)).toContain('主要施工机械设备投入计划表');
    expect(secondPass.tablePlans?.map(plan => plan.title)).toContain('关键施工节点控制计划表');
  });
});

describe('劳动力推导授权与表格执行核验', () => {
  function resourcesChapter(): ReturnType<typeof buildConstructionOrgTablePlans>[number] {
    return buildConstructionOrgTablePlans({
      projectGraph: graph,
      chapters: [chapter('c1', '资源配置计划', ['资源配置计划'])],
    })[0];
  }

  it('labor plan headcount field uses deriveFromProject and generates derivation authorization', () => {
    const resources = resourcesChapter();
    const laborPlan = resources.tablePlans?.find(plan => plan.title === '分阶段劳动力动态投入计划表');
    expect(laborPlan).toBeDefined();
    const headcount = laborPlan!.fields.find(field => field.name === '人数');
    expect(headcount?.fallbackPolicy).toBe('deriveFromProject');
    // 表格治理规则必须给出推导授权，禁止“资料没有就不填”
    expect(resources.tableRequirements?.join('、')).toContain('投标人计划编制类字段');
    const prompt = tablePlansPrompt(resources);
    expect(prompt).toContain('投标人编制类字段授权');
    expect(prompt).toContain('必须推导并落到具体数字');
  });

  it('assigns table plans to matching section titles and reports unassigned plans', () => {
    const resources = resourcesChapter();
    const labor = sectionTablePlans(resources, '分阶段劳动力投入计划');
    expect(labor.map(plan => plan.title)).toContain('分阶段劳动力动态投入计划表');
    const unrelated = sectionTablePlans(resources, '施工平面布置');
    expect(unrelated.map(plan => plan.title)).not.toContain('分阶段劳动力动态投入计划表');
    // 所有小节都不承接时，应写表格全部进入兜底清单
    const unassigned = unassignedSectionTablePlans(resources, ['与表格无关的小节']);
    expect(unassigned.length).toBeGreaterThanOrEqual(2);
  });

  it('tablePlanExecutionGaps reports chapters where actual markdown tables fall far below planned', () => {
    const resources = resourcesChapter();
    const planned = (resources.tablePlans || []).filter(plan => plan.outputDecision?.shouldOutput).length;
    expect(planned).toBeGreaterThanOrEqual(2);
    const gaps = tablePlanExecutionGaps([resources], [{ title: '资源配置计划', content: '本章只有正文，没有 markdown 表格。' }]);
    const gap = gaps.find(item => item.chapterTitle === '资源配置计划');
    expect(gap).toBeDefined();
    expect(gap!.planned).toBe(planned);
    expect(gap!.actual).toBe(0);
  });

  it('tablePlanExecutionGaps passes chapters whose actual table count reaches the execution threshold', () => {
    const resources = resourcesChapter();
    const planned = (resources.tablePlans || []).filter(plan => plan.outputDecision?.shouldOutput).length;
    const LF = String.fromCharCode(10);
    const rows = Array.from({ length: Math.max(0, Math.ceil(planned * 0.6)) }, (_, index) => `| 表${index + 1} | 内容 |`);
    const content = rows.map(row => `${row}${LF}| --- | --- |${LF}| 数据 | 数据 |`).join(LF);
    const gaps = tablePlanExecutionGaps([resources], [{ title: '资源配置计划', content }]);
    expect(gaps.find(item => item.chapterTitle === '资源配置计划')).toBeUndefined();
  });
});
