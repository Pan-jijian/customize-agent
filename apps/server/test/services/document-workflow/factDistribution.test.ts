/**
 * 关键事实跨章扩散轮（factDistribution）单测：R12 方案针对性分布归因——值级口径与 specificityScore 同源
 * （buildDocumentFactTraces + isActionableTraceFact + 4-60 字 + 空白归一化）。本测试锁定：
 * 1. 落位目标：1 章值补齐到 2 章（加 1 处引用）、0 章值补齐到 2 章（加 2 处引用）；
 * 2. 值级过滤：≥2 章不动、日期型跳过、规则外标签跳过、句子型值直用/短语值走模板；
 * 3. 结构约束：插入句追加在正文块尾（不新增段落边界）、不触概况复述禁用句式、章内句数上限；
 * 4. 幂等：二次执行零插入（值均已跨 ≥2 章）。
 */
import { describe, expect, it } from 'vitest';
import { stageFactDistribution } from '@/services/document-workflow/finalize/repairRounds/factDistribution';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel } from '@/services/document-workflow/types';

function fact(fieldName: string, value: string): DocumentFact {
  return { key: fieldName, value, sourceFile: '/proj/tender.pdf', roleId: 'tender', confidence: 1, fieldName };
}

function chapter(id: string, title: string, content: string): DocumentDraftChapter {
  return { id, title, content, evidence: [], missingFacts: [] };
}

function makeFactsModel(bucket: keyof Pick<DocumentFactsModel, 'project' | 'schedule' | 'quality' | 'safety' | 'resources' | 'preciseFacts' | 'bills' | 'drawings' | 'rules' | 'specifications'>, facts: DocumentFact[]): DocumentFactsModel {
  return {
    project: [], schedule: [], quality: [], safety: [], resources: [], preciseFacts: [], bills: [], drawings: [], rules: [], specifications: [],
    tables: [], schemaFacts: {},
    factIndex: { reliableFacts: [], parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] },
    missing: [], conflicts: [],
    [bucket]: facts,
  } as DocumentFactsModel;
}

function makeSession(chapters: DocumentDraftChapter[], factsModel: DocumentFactsModel): FinalizeSession {
  const rebuild = () => chapters.map(item => `## ${item.title}\n\n${item.content}`).join('\n\n');
  return {
    finalChapterDrafts: chapters,
    finalMarkdown: rebuild(),
    factsModel,
    progressStages: [],
    finalGateRepairStages: [],
    emitProgress: () => {},
    rebuildFinalMarkdown: rebuild,
    recomputeFinalValidationBundle: async () => {},
  } as unknown as FinalizeSession;
}

const BODY_A = '项目部按批准的施工方案组织作业，施工员每日检查工序衔接情况，质检员每周不少于1次复核实测实量数据，发现偏差当日安排整改并复查销项，形成完整记录归档备查。';

describe('stageFactDistribution 关键事实跨章扩散', () => {
  it('1 章落位值（质量标准）补齐到 2 章：施工方法章追加引用句', async () => {
    const chapters = [
      chapter('c1', '工程概况', `本工程建设规模与地点如下。${BODY_A}`),
      chapter('c2', '确保工程质量的技术组织措施', `质量目标为工程质量符合合格标准。${BODY_A}`),
      chapter('c3', '主要施工方法', `各分项按图纸与规范组织施工。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('quality', [fact('质量标准', '工程质量符合合格标准')]));
    await stageFactDistribution(session);
    expect(session.finalChapterDrafts[2].content).toContain('工程质量符合合格标准');
    expect(session.finalChapterDrafts[1].content).toContain('工程质量符合合格标准');
    expect(session.progressStages).toHaveLength(1);
    expect(session.progressStages[0].message).toContain('关键事实跨章扩散');
  });

  it('0 章落位值（合同估算价）补齐到 2 章：两目标章各追加一处', async () => {
    const chapters = [
      chapter('c1', '工程概况', `项目基本信息见下表。${BODY_A}`),
      chapter('c2', '拟投入的主要物资计划', `材料按清单锁定值采购。${BODY_A}`),
      chapter('c3', '拟投入的主要施工机械设备计划', `机械按作业面需求配置。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('project', [fact('项目投资估算', '1100万元')]));
    await stageFactDistribution(session);
    expect(session.finalChapterDrafts[1].content).toContain('1100万元');
    expect(session.finalChapterDrafts[2].content).toContain('1100万元');
    expect(session.finalChapterDrafts[0].content).not.toContain('1100万元');
  });

  it('已 ≥2 章落位值不动（计划工期 90日历天）', async () => {
    const chapters = [
      chapter('c1', '工程概况', `计划工期90日历天。${BODY_A}`),
      chapter('c2', '确保工期的技术组织措施', `总工期90日历天按节点倒排。${BODY_A}`),
    ];
    const before = chapters.map(item => item.content);
    const session = makeSession(chapters, makeFactsModel('schedule', [fact('计划工期', '90日历天')]));
    await stageFactDistribution(session);
    expect(session.finalChapterDrafts.map(item => item.content)).toEqual(before);
    expect(session.progressStages).toHaveLength(0);
  });

  it('日期型值与规则外标签跳过，无目标章时不插入', async () => {
    const chapters = [
      chapter('c1', '工程概况', `开工安排详见说明。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('schedule', [
      fact('开工日期', '2026年9月24日'),
      fact('其他事项', '普通描述内容'),
    ]));
    await stageFactDistribution(session);
    expect(session.progressStages).toHaveLength(0);
  });

  it('句子型值直用（本项目位于…）、短语值走模板（工程地处…），均不触概况复述禁用句式', async () => {
    const chapters = [
      chapter('c1', '工程概况', `项目位于丰乐镇域内。${BODY_A}`),
      chapter('c2', '施工总平面布置图', `平面布置按村庄分布统筹。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('project', [
      fact('招标范围', '本项目位于肥西县丰乐镇'),
      fact('建设地点', '安徽省合肥市肥西县'),
    ]));
    await stageFactDistribution(session);
    const c1 = session.finalChapterDrafts[0].content;
    const c2 = session.finalChapterDrafts[1].content;
    expect(c1).toContain('本项目位于肥西县丰乐镇');
    expect(c2).toContain('安徽省合肥市肥西县');
    // 插入句不得以概况复述禁用句式开头（overviewRecapCandidates 同口径）
    const insertedSentences = c2.split(/(?<=。)/u).filter(sentence => sentence.includes('安徽省合肥市肥西县'));
    expect(insertedSentences.length).toBeGreaterThan(0);
    for (const sentence of insertedSentences) {
      expect(/^本项目为|^本工程为|^该项目为|^该工程为/u.test(sentence.trim())).toBe(false);
    }
  });

  it('不插入标题块/表格块/列表块：附加句落在正文段落尾（不新增段落边界）', async () => {
    const chapters = [
      chapter('c1', '工程概况', `## 小节标题\n\n| 信息项 | 内容 |\n| --- | --- |\n| 建设地点 | 安徽省合肥市肥西县 |\n\n- 列表项一\n- 列表项二\n\n${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('project', [fact('建设地点', '安徽省合肥市肥西县')]));
    // 值仅在表格行出现（章内容含值）→ 已达 1 章；无第二目标章 → 不插入
    await stageFactDistribution(session);
    expect(session.progressStages).toHaveLength(0);
  });

  it('幂等：二次执行零重复插入', async () => {
    const chapters = [
      chapter('c1', '工程概况', `本工程概况如下。${BODY_A}`),
      chapter('c2', '确保文明施工的技术组织措施', `文明施工按标准执行。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('project', [fact('建设地点', '安徽省合肥市肥西县')]));
    await stageFactDistribution(session);
    const stageCountAfterFirst = session.progressStages.length;
    const contentAfterFirst = session.finalChapterDrafts[1].content;
    await stageFactDistribution(session);
    expect(session.progressStages).toHaveLength(stageCountAfterFirst);
    expect(session.finalChapterDrafts[1].content).toBe(contentAfterFirst);
  });

  it('项目名称（含年份）跨章扩散：label 感知放行年份守卫（R14 丰乐镇）', async () => {
    const chapters = [
      chapter('c1', '工程概况', `项目名称为2026年度丰乐镇20个美丽宜居自然村建设项目。${BODY_A}`),
      chapter('c2', '确保文明施工的技术组织措施', `文明施工按标准执行。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('project', [fact('项目名称', '2026年度丰乐镇20个美丽宜居自然村建设项目')]));
    await stageFactDistribution(session);
    expect(session.finalChapterDrafts[1].content).toContain('2026年度丰乐镇20个美丽宜居自然村建设项目');
    // 名称类引用句不得踩概况复述禁用句式（overviewRecapCandidates 同口径）
    const inserted = session.finalChapterDrafts[1].content.split(/(?<=。)/u).filter(sentence => sentence.includes('美丽宜居'));
    expect(inserted.length).toBeGreaterThan(0);
    for (const sentence of inserted) {
      expect(/^本项目为|^本工程为|^该项目为|^该工程为/u.test(sentence.trim())).toBe(false);
    }
  });

  it('资源配置要求（句子型、0 章落位）补齐到 2 章：直接引用原句（R14 丰乐镇）', async () => {
    const value = '承包人应在工程开工前7日内，完成包括临时水电报装、临时设施搭建及施工便道修筑在内的全部开工准备工作。';
    const chapters = [
      chapter('c1', '工程概况', `开工准备要求见章头表。${BODY_A}`),
      chapter('c2', '主要施工方法', `各分项按图纸组织施工。${BODY_A}`),
      chapter('c3', '拟投入的主要物资计划', `材料按清单采购。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('project', [fact('资源配置要求', value)]));
    await stageFactDistribution(session);
    expect(session.finalChapterDrafts[1].content).toContain(value);
    expect(session.finalChapterDrafts[2].content).toContain(value);
  });

  it('周期要求（含开工日期）扩散到工期/总平面章：label 感知放行日期守卫（R14 丰乐镇）', async () => {
    const value = '计划开工日期：2026年9月24日（具体开工日期以开工通知为准）';
    const chapters = [
      chapter('c1', '工程概况', `开工安排见章头表。${BODY_A}`),
      chapter('c2', '确保工期的技术组织措施', `总工期按节点倒排。${BODY_A}`),
      chapter('c3', '施工总平面布置图', `平面布置按村庄分布统筹。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('schedule', [fact('周期要求', value)]));
    await stageFactDistribution(session);
    expect(session.finalChapterDrafts[1].content).toContain('2026年9月24日');
    expect(session.finalChapterDrafts[2].content).toContain('2026年9月24日');
  });

  it('项目编号 pattern 拓宽：概况章之外的方法章获得编号引用', async () => {
    const chapters = [
      chapter('c1', '工程概况', `招标项目编号为2026AEEGZ50048。${BODY_A}`),
      chapter('c2', '主要施工方法', `各分项按图纸与规范组织施工。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('project', [fact('项目编号', '2026AEEGZ50048')]));
    await stageFactDistribution(session);
    expect(session.finalChapterDrafts[1].content).toContain('招标项目编号为2026AEEGZ50048');
  });

  it('招标人（0 章落位）扩散到概况/项目管理类章：前缀剥离后按纯值扩散（C-T7 #50）', async () => {
    const chapters = [
      chapter('c1', '工程概况', `项目基本信息见章头表。${BODY_A}`),
      chapter('c2', '项目管理机构与职责', `项目管理机构按公司体系运行。${BODY_A}`),
      chapter('c3', '主要施工方法', `各分项按图纸组织施工。${BODY_A}`),
    ];
    const session = makeSession(chapters, makeFactsModel('project', [fact('招标人', '招标人：肥西县丰乐镇人民政府')]));
    await stageFactDistribution(session);
    const contents = session.finalChapterDrafts.map(item => item.content).join('\n');
    expect(contents).toContain('肥西县丰乐镇人民政府');
    // 扩散值不得带标签前缀（防「本工程招标人为招标人：…」形态写进正文）
    expect(contents).not.toContain('招标人：肥西县丰乐镇人民政府');
    expect(session.progressStages).toHaveLength(1);
  });
});
