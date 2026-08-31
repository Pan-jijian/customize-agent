/**
 * evidenceContentSafety 单测：证据内容安全分区的词面召回 + 双向语义判定。
 * 本地模型实例经 vi.mock 替换（避免加载 Transformers.js 重依赖），
 * embedDocuments 注入确定性二维向量：投标程序语境 [1,0] / 施工语境 [0,1]，
 * 使投标程序样本与投标原型点积=1、与施工原型点积=0（施工样本反之）。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {}
  return { LocalTransformersEmbeddingProvider };
});

import { buildBidProcedureJudge, filterOffTopicSections, filterOffTopicSectionsForChapters, partitionEvidenceByContentSafety } from './evidenceContentSafety';
import type { DocumentEvidence, DocumentTemplateChapter } from './types';

const STRONG_BID_RE = /评标|投标|澄清|评审|中标|保证金|开标|递交|廉洁|行贿|串标|围标|报价|清单计量/u;
const STRONG_CONSTRUCTION_RE = /劳动力|班组|混凝土|钢筋|基坑|支护|机械|质量|安全|进度|材料/u;
const VAGUE_RE = /纪律|施工|教育/u;

/**
 * 确定性嵌入模拟真实 bge 相似度梯度：
 * 强商务词（评标/报价等）→ [1,0]（与投标程序原型点积=1）；
 * 强施工词 → [0,1]；模糊词（纪律/施工）→ [0,0.5]（与两类原型中等相似，靠严格大于保护放行）。
 */
const embedDocuments = async (texts: string[]) => texts.map(text => {
  const strongBid = STRONG_BID_RE.test(text);
  const strongConstruction = STRONG_CONSTRUCTION_RE.test(text);
  const bid = strongBid && !strongConstruction ? 1 : 0;
  const construction = strongConstruction ? 1 : (VAGUE_RE.test(text) ? 0.5 : 0);
  return [bid, construction];
});

function evidence(partial: Partial<DocumentEvidence>): DocumentEvidence {
  return { chapterId: 'ch-1', filePath: '招标文件.pdf', score: 0.9, content: '', ...partial };
}

describe('partitionEvidenceByContentSafety', () => {
  it('空输入返回空分区', async () => {
    await expect(partitionEvidenceByContentSafety([], embedDocuments)).resolves.toEqual({ safe: [], excluded: [] });
  });

  it('词面未命中直接放行（短路，不触发语义判定）', async () => {
    const item = evidence({ content: '本工程基础采用灌注桩施工，桩身混凝土强度等级为C30。' });
    const result = await partitionEvidenceByContentSafety([item], embedDocuments);
    expect(result.safe).toEqual([item]);
    expect(result.excluded).toEqual([]);
  });

  it('评标纪律章节证据被排除（含禁写词面正例）', async () => {
    const item = evidence({ sectionTitle: '纪律和监督', content: '不得接触评标委员会成员，不得打听评标专家名单，评标纪律要求严格。' });
    const result = await partitionEvidenceByContentSafety([item], embedDocuments);
    expect(result.excluded).toEqual([item]);
    expect(result.safe).toEqual([]);
  });

  it('无禁词词面变体被排除（评审争议处理与澄清配合）', async () => {
    const item = evidence({ sectionTitle: '评审争议处理与澄清配合', content: '评审结果确认后进入中标公示环节，投标人按程序配合澄清答复。' });
    const result = await partitionEvidenceByContentSafety([item], embedDocuments);
    expect(result.excluded).toEqual([item]);
  });

  it('评标办法与分值构成章节被排除', async () => {
    const item = evidence({ sectionTitle: '评标办法', content: '技术文件评审分值5分，评委按三档酌情赋分。' });
    const result = await partitionEvidenceByContentSafety([item], embedDocuments);
    expect(result.excluded).toEqual([item]);
  });

  it('商务报价类内容被排除（清单计量与报价口径）', async () => {
    const item = evidence({ sectionTitle: '清单计量与报价口径', content: '投标人应按招标清单计量规则编制报价。' });
    const result = await partitionEvidenceByContentSafety([item], embedDocuments);
    expect(result.excluded).toEqual([item]);
  });

  it('劳动纪律施工内容放行（负例保护）', async () => {
    const item = evidence({ content: '施工现场劳动纪律与班组作业管理制度：工人每日班前安全教育后上岗。' });
    const result = await partitionEvidenceByContentSafety([item], embedDocuments);
    expect(result.safe).toEqual([item]);
    expect(result.excluded).toEqual([]);
  });

  it('质量纪律施工内容放行（负例保护）', async () => {
    const item = evidence({ content: '质量纪律：每道工序经检验合格后方可进入下道工序施工。' });
    const result = await partitionEvidenceByContentSafety([item], embedDocuments);
    expect(result.safe).toEqual([item]);
  });

  it('含澄清词面的施工技术内容放行（语义复核压制词面）', async () => {
    const item = evidence({ content: '基坑支护方案澄清说明：放坡喷锚支护参数按图纸要求调整施工。' });
    const result = await partitionEvidenceByContentSafety([item], embedDocuments);
    expect(result.safe).toEqual([item]);
  });

  it('混合集合分区完整且互斥', async () => {
    const discipline = evidence({ sectionTitle: '纪律和监督', content: '评标纪律要求。' });
    const labor = evidence({ content: '劳动力配置计划与高峰期人数安排。' });
    const procedure = evidence({ sectionTitle: '评审争议处理与澄清配合', content: '中标公示流程。' });
    const quality = evidence({ content: '质量保证措施与验收标准施工执行。' });
    const result = await partitionEvidenceByContentSafety([discipline, labor, procedure, quality], embedDocuments);
    expect(result.excluded).toEqual([discipline, procedure]);
    expect(result.safe).toEqual([labor, quality]);
    expect(result.excluded.length + result.safe.length).toBe(4);
  });
});

describe('filterOffTopicSections', () => {
  it('空小节清单返回空', async () => {
    await expect(filterOffTopicSections({ sections: [], chapterTitle: '人材机保障' })).resolves.toEqual([]);
  });

  it('词面未命中小节原样放行', async () => {
    const sections = ['劳动力配置计划与高峰期人数安排', '机械设备进场与维护保养计划'];
    await expect(filterOffTopicSections({ sections, chapterTitle: '人材机保障', embedDocuments })).resolves.toEqual(sections);
  });

  it('评标纪律类小节被剔除（评分报告 P1 六小节场景）', async () => {
    const sections = [
      '对与评标活动有关的工作人员的纪律要求',
      '评审争议处理与澄清配合',
      '评审结果确认与后续衔接',
      '评标期间行为管控与资料闭环',
      '清单计量与报价口径的施工落地',
      '投标文件实质性响应与资料闭环',
      '劳动力配置计划与高峰期人数安排',
      '机械设备进场与维护保养计划',
    ];
    const result = await filterOffTopicSections({ sections, chapterTitle: '人材机保障', embedDocuments });
    expect(result).toEqual(['劳动力配置计划与高峰期人数安排', '机械设备进场与维护保养计划']);
  });

  it('施工纪律类小节放行（章主题双向比对保护）', async () => {
    const sections = ['施工纪律与奖惩措施', '班组安全教育与培训要求'];
    const result = await filterOffTopicSections({ sections, chapterTitle: '安全生产管理', embedDocuments });
    expect(result).toEqual(sections);
  });

  it('批量章节过滤保持章节结构（仅 sections 变更）', async () => {
    const chapters: DocumentTemplateChapter[] = [
      { id: 'ch-1', title: '人材机保障', purpose: '', queries: [], requiredFacts: [], sections: ['劳动力配置计划', '评标纪律要求'] },
      { id: 'ch-2', title: '工期与质量保障', purpose: '', queries: [], requiredFacts: [], sections: ['进度计划与关键线路', '质量保证措施'] },
    ];
    const result = await filterOffTopicSectionsForChapters(chapters, embedDocuments);
    expect(result[0]).toEqual({ id: 'ch-1', title: '人材机保障', purpose: '', queries: [], requiredFacts: [], sections: ['劳动力配置计划'] });
    expect(result[1]).toEqual({ id: 'ch-2', title: '工期与质量保障', purpose: '', queries: [], requiredFacts: [], sections: ['进度计划与关键线路', '质量保证措施'] });
  });

  it('确定性硬剔除层：语义模型恒零（不可用承接）时仍剔除条款碎片与纪律黑名单标题（真实生成回归）', async () => {
    // 恒零嵌入模拟语义不可用：只有确定性硬剔除层生效，纪律小节失去证据支撑不得残留
    const zeroEmbed = async (texts: string[]) => texts.map(() => [0, 0]);
    const sections = [
      '1委员会确定中',
      '4对与评标活动有关的工作人员的纪律要求',
      '如我方中标，我方承诺：',
      '00天，计划完成时间：',
      '相当于或不低于以下品牌',
      '补充条款',
      '其他要求',
      '需要补充的其他内容',
      '劳动力配置计划与高峰期人数安排',
      '机械设备进场与维护保养计划',
    ];
    const result = await filterOffTopicSections({ sections, chapterTitle: '确保人、材、机的保障体系与措施', embedDocuments: zeroEmbed });
    expect(result).toEqual(['劳动力配置计划与高峰期人数安排', '机械设备进场与维护保养计划']);
  });

  it('硬剔除层程序词×管理词组合：无编号前缀纪律变体标题被剔除', async () => {
    const zeroEmbed = async (texts: string[]) => texts.map(() => [0, 0]);
    const sections = ['评标期间工作人员行为管控', '投标承诺响应与履约公示'];
    const result = await filterOffTopicSections({ sections, chapterTitle: '施工管理', embedDocuments: zeroEmbed });
    expect(result).toEqual([]);
  });

  it('硬剔除层零误杀：施工合法标题（劳动纪律/质量纪律/技术澄清）放行', async () => {
    const zeroEmbed = async (texts: string[]) => texts.map(() => [0, 0]);
    const sections = ['劳动纪律与班组作业管理制度', '质量纪律与验收标准要求', '图纸疑问与技术澄清管理'];
    const result = await filterOffTopicSections({ sections, chapterTitle: '施工管理', embedDocuments: zeroEmbed });
    expect(result).toEqual(sections);
  });
});

describe('buildBidProcedureJudge（阶段三 3.3 清洗层语义判定器，与证据过滤同口径）', () => {
  it('评标纪律句判定命中', async () => {
    const judge = await buildBidProcedureJudge(embedDocuments);
    await expect(judge(['评标纪律要求严格执行，不得干扰评标活动'])).resolves.toEqual([true]);
  });

  it('施工技术句判定放行', async () => {
    const judge = await buildBidProcedureJudge(embedDocuments);
    await expect(judge(['施工现场按分区管理执行，混凝土浇筑连续进行'])).resolves.toEqual([false]);
  });

  it('施工合法纪律句（劳动纪律/班组管理）判定放行（双向比对保护）', async () => {
    const judge = await buildBidProcedureJudge(embedDocuments);
    await expect(judge(['劳动纪律与班组作业管理制度：班前安全教育后上岗'])).resolves.toEqual([false]);
  });

  it('批量判定结果与输入一一对应', async () => {
    const judge = await buildBidProcedureJudge(embedDocuments);
    const texts = ['评标纪律要求', '基坑支护方案施工', '中标公示流程'];
    await expect(judge(texts)).resolves.toEqual([true, false, true]);
  });

  it('空输入返回空结果', async () => {
    const judge = await buildBidProcedureJudge(embedDocuments);
    await expect(judge([])).resolves.toEqual([]);
  });
});
