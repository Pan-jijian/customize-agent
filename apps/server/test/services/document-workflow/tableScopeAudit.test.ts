import { beforeEach, describe, expect, it, vi } from 'vitest';
import { auditPlannedTableScope, type PlannedTableScopeEntry } from '@/services/document-workflow/tableScopeAudit';
import type * as LlmClientModule from '@/services/document-workflow/llmClient';

const callDocumentLlmJsonMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());

vi.mock('@/services/document-workflow/llmClient', async (importOriginal) => {
  const actual = await importOriginal<typeof LlmClientModule>();
  return { ...actual, callDocumentLlmJson: callDocumentLlmJsonMock };
});

const entry = (chapterTitle: string, title: string, fields: string[] = []): PlannedTableScopeEntry => ({ chapterTitle, title, fields });

/** 九个规划表（含一项他专业领域疑项）：9 张表的安全阀上限 = floor(9/3) = 3 */
const TABLES: PlannedTableScopeEntry[] = [
  entry('工程概况', '项目基本信息表', ['项目名称', '建设规模']),
  entry('工程概况', '主要工程量汇总表'),
  entry('主要施工方法', '主要施工方法控制参数表', ['工序', '控制参数']),
  entry('主要施工方法', '外装饰材料色彩报审清单', ['材料名称', '色彩', '报审状态']),
  entry('拟投入的主要物资计划', '主要物资投入总量与进场批次表'),
  entry('劳动力安排计划', '劳动力配置汇总表', ['工种', '人数']),
  entry('确保工程质量的技术组织措施', '质量关键节点控制表'),
  entry('确保安全生产的技术组织措施', '危险作业管控台账'),
  entry('施工总平面布置图', '施工总平面布置要素控制表'),
];

const CRITERIA = ['招标范围：村内道路硬化及亮化提升、雨污水管网铺设、景观小品打造与房前屋后环境综合整治。'];
const BOQ = '- 道路工程（路床整形；水泥稳定碎石基层；沥青混凝土面层）\n- 排水工程（HDPE 双壁波纹管；检查井）\n- 绿化工程（乔木栽植；色带栽植）';

beforeEach(() => {
  callDocumentLlmJsonMock.mockReset();
  callDocumentLlmJsonMock.mockResolvedValue(undefined);
});

describe('auditPlannedTableScope 规划表范围核对（R20 C4）', () => {
  it('LLM 判定的超范围表被剔除（章标题与表名逐字匹配）', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({
      outOfScope: [{ chapterTitle: '主要施工方法', title: '外装饰材料色彩报审清单', reason: '属于房建装饰领域实体，与本标段工程范围无关' }],
    });
    const result = await auditPlannedTableScope({ tables: TABLES, requirementSummary: CRITERIA, boqCoverageSummary: BOQ });
    expect(result.removed).toEqual([{ chapterTitle: '主要施工方法', title: '外装饰材料色彩报审清单', reason: '属于房建装饰领域实体，与本标段工程范围无关' }]);
    expect(result.skipped).toBeUndefined();
  });

  it('LLM 输出的表名不存在于规划（幻觉）时忽略不剔除', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({
      outOfScope: [{ chapterTitle: '主要施工方法', title: '幕墙工程验收记录表', reason: '房建实体' }],
    });
    const result = await auditPlannedTableScope({ tables: TABLES, requirementSummary: CRITERIA, boqCoverageSummary: BOQ });
    expect(result.removed).toEqual([]);
  });

  it('LLM 输出带编号前缀的表名按下游同口径归一匹配', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({
      outOfScope: [{ chapterTitle: '主要施工方法', title: '2.2 外装饰材料色彩报审清单', reason: '超范围' }],
    });
    const result = await auditPlannedTableScope({ tables: TABLES, requirementSummary: CRITERIA, boqCoverageSummary: BOQ });
    expect(result.removed.map(item => item.title)).toEqual(['外装饰材料色彩报审清单']);
  });

  it('剔除数超过总数 1/3 时整体放弃（安全阀，防批量误剔）', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({
      outOfScope: TABLES.slice(0, 4).map(item => ({ chapterTitle: item.chapterTitle, title: item.title, reason: '疑超范围' })),
    });
    const result = await auditPlannedTableScope({ tables: TABLES, requirementSummary: CRITERIA, boqCoverageSummary: BOQ });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toContain('1/3');
  });

  it('剔除数在上限内（9 张剔 3 张）正常剔除', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({
      outOfScope: TABLES.slice(0, 3).map(item => ({ chapterTitle: item.chapterTitle, title: item.title, reason: '疑超范围' })),
    });
    const result = await auditPlannedTableScope({ tables: TABLES, requirementSummary: CRITERIA, boqCoverageSummary: BOQ });
    expect(result.removed).toHaveLength(3);
    expect(result.skipped).toBeUndefined();
  });

  it('理由清洗：去空白截断到 40 字', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({
      outOfScope: [{ chapterTitle: '主要施工方法', title: '外装饰材料色彩报审清单', reason: '理由\n带换行 '.repeat(12) }],
    });
    const result = await auditPlannedTableScope({ tables: TABLES, requirementSummary: CRITERIA, boqCoverageSummary: BOQ });
    expect(result.removed[0].reason.length).toBeLessThanOrEqual(40);
    expect(result.removed[0].reason).not.toContain('\n');
  });

  it('LLM 调用失败（undefined）时保留原规划并标注原因', async () => {
    callDocumentLlmJsonMock.mockResolvedValue(undefined);
    const result = await auditPlannedTableScope({ tables: TABLES, requirementSummary: CRITERIA, boqCoverageSummary: BOQ });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toContain('LLM 调用失败');
  });

  it('无范围判据（招标摘要与清单全景均为空）时不调用 LLM', async () => {
    const result = await auditPlannedTableScope({ tables: TABLES, requirementSummary: [] });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toContain('无范围判据');
    expect(callDocumentLlmJsonMock).not.toHaveBeenCalled();
  });

  it('无规划表时直接跳过', async () => {
    const result = await auditPlannedTableScope({ tables: [], requirementSummary: CRITERIA, boqCoverageSummary: BOQ });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toContain('无规划表');
    expect(callDocumentLlmJsonMock).not.toHaveBeenCalled();
  });

  it('prompt 携带范围判据与规划表清单（章分组渲染）', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({ outOfScope: [] });
    await auditPlannedTableScope({ tables: TABLES, requirementSummary: CRITERIA, boqCoverageSummary: BOQ, templateName: '施工组织设计' });
    const prompt = callDocumentLlmJsonMock.mock.calls[0]![1] as string;
    expect(prompt).toContain('本标段招标范围判据');
    expect(prompt).toContain('工程量清单分部分项全景');
    expect(prompt).toContain('【主要施工方法】');
    expect(prompt).toContain('外装饰材料色彩报审清单');
  });
});
