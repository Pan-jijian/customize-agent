/**
 * 4.55.29 根修回归集（方案 docs/rootfix-plan-4.55.29.md）。
 *
 * 全部用例取自**服务真实产出** `doc-1790104980418-d47a002e` 的实测缺陷形态：
 * 每一条先锁定「误报必须消失」，再锁定「真缺陷仍必须报出」——只做前者会把判据放宽成不设防。
 */
import { describe, expect, it } from 'vitest';
import { caliberConsistencyIssues, crossChapterConsistencyIssues } from '@/services/document-workflow/qualityValidation';
import { attributeValueShapeMismatch, backfillCaliberPlacements, rejectValueNoise, renderTruthConstraintBlock } from '@/services/document-workflow/authoritativeValues';
import { detectFactConflicts } from '@/services/document-workflow/factsModel';
import { splitScoringBlocks } from '@/services/document-workflow/tenderBidScoring';
import { classifyValueShape } from '@/services/document-workflow/valueOverride';
import type { DocumentFactsModel } from '@/services/document-workflow/types';
import { RealLocalEmbeddingProvider } from '../../helpers/real-embedding';

const embedder = new RealLocalEmbeddingProvider();

describe('L0-1 缺席声明不得作为真值', () => {
  it.each([
    '未在资料中明确体现',
    '【未在资料中明确体现】',
    '资料中未体现',
    '未明确',
    '待补充',
    '系统暂未从知识库确认',
    '暂无',
    '详见',
  ])('整值缺席声明「%s」被剔除', value => {
    expect(rejectValueNoise(value)).toBeTruthy();
  });

  it.each([
    '未经处理的原土',
    '未筛分碎石',
    'C30 混凝土（未掺外加剂）',
    '330日历天',
    '2026年10月10日',
  ])('带实质内容的合法值「%s」不得误剔', value => {
    expect(rejectValueNoise(value)).toBeUndefined();
  });
});

describe('L0 口径落位判据·值形态闸', () => {
  const ledgerItem = (attribute: string, value: string) => ({
    attribute, value, rule: 'R7', evidence: [{ source: '招标文件.pdf' }], superseded: [],
  });

  it('段落型值不是可逐字复现的口径 → 不报「未落位」', () => {
    // 实测原句：「本招标文件包括」真值层生效值为「（1）招标公告；（2）投标人须知；…」（裁决 R7）
    const issues = caliberConsistencyIssues('第一章 编制说明。', [
      ledgerItem('本招标文件包括', '（1）招标公告；（2）投标人须知；（3）评标及定标办法；（4）合同条款及格式；（'),
      ledgerItem('招标公告项目基本信息', '合肥市滨湖新区南京路号要素交易市场A区（徽州大道与南京路交口）2楼7号开标室'),
      ledgerItem('施工方法工艺流程', '虹吸雨水系统施工必须由虹吸专业公司安装；HDPE管道的连接方法采用热熔连接或者电熔连接'),
    ]);
    expect(issues).toHaveLength(0);
  });

  it('规格型值必须逐字落位，未落位照报', () => {
    const issues = caliberConsistencyIssues('总工期按招标文件要求执行。', [ledgerItem('计划工期', '330日历天')]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('blocker');
    expect(issues[0]!.message).toContain('330日历天');
  });

  it('规格型值已落位 → 零 issue', () => {
    expect(caliberConsistencyIssues('本工程总工期330日历天。', [ledgerItem('计划工期', '330日历天')])).toHaveLength(0);
  });

  it('非口径属性（章节内容型）不得要求逐字落位（caliber=false 直接跳过）', () => {
    // 实测（巢湖 doc-f00280f9）：真值层 40 项属性中绝大多数是章节内容型——
    // 「底坑垫层做法 = C20」「钢筋连接 = Φ16」「主要材料包括 = 2.5mm」「混凝土强度等级 = C40」
    // 写手从未被告知这些是"口径"，要求正文逐字复现「主要材料包括 = 2.5mm」在语义上不成立。
    const issues = caliberConsistencyIssues('第一章 编制说明。', [
      { ...ledgerItem('底坑垫层做法', 'C20'), caliber: false },
      { ...ledgerItem('钢筋连接', 'Φ16'), caliber: false },
      { ...ledgerItem('主要材料包括', '2.5mm'), caliber: false },
      { ...ledgerItem('混凝土强度等级', 'C40'), caliber: false },
    ]);
    expect(issues).toHaveLength(0);
  });

  it('商务口径（暂列金额）不入「须逐字落位」集', () => {
    const issues = caliberConsistencyIssues('技术标正文。', [{ ...ledgerItem('暂列金额', '7000000.00元'), caliber: false }]);
    expect(issues).toHaveLength(0);
  });

  it('项目级口径（计划工期/开工日期/合同金额）仍须逐字落位', () => {
    const issues = caliberConsistencyIssues('技术标正文。', [
      { ...ledgerItem('计划工期', '330日历天'), caliber: true },
      { ...ledgerItem('开工日期', '2026年10月10日'), caliber: true },
    ]);
    expect(issues).toHaveLength(2);
  });

  it('形态判定边界：段落/规格各自归类正确', () => {
    expect(classifyValueShape('（1）招标公告；（2）投标人须知')).toBe('text');
    expect(classifyValueShape('330日历天')).toBe('measure');
    expect(classifyValueShape('157166591.34元')).toBe('money');
    expect(classifyValueShape('2026年10月10日')).toBe('date');
  });
});

describe('L0-3 属性-值形态相容（时间型属性）', () => {
  it('图签串格产物「22.2m」不得挂到「工期关键节点」名下', () => {
    // 实测原值：「1#厂房建筑超高施工增加，檐口高度22.2m、一层」经值 token 抽取后取到 22.2m
    expect(attributeValueShapeMismatch('工期关键节点', '22.2m')).toBeTruthy();
  });

  it('时间型属性的合法值不误剔', () => {
    expect(attributeValueShapeMismatch('工期关键节点', '基础完成、主体封顶、竣工验收')).toBeUndefined();
    expect(attributeValueShapeMismatch('计划工期', '330日历天')).toBeUndefined();
    expect(attributeValueShapeMismatch('开工日期', '2026年10月10日')).toBeUndefined();
  });

  it('非时间型属性不受本判据约束', () => {
    expect(attributeValueShapeMismatch('檐口高度', '22.2m')).toBeUndefined();
  });
});

describe('L0-8 跨章一致性·对象维度', () => {
  const markdownWith = (lines: string[]) => lines.join('\n');

  it('同一工程量按单体分别成量属合法列举，不判冲突', async () => {
    const issues = await caliberScopeProbe(markdownWith([
      '2#门卫按平整场地241.71m²、挖沟槽土方346.88m³、回填方242.96m³组织流水。',
      '3#门卫按平整场地16.07m²、挖沟槽土方37.51m³、回填方29.13m³组织流水。',
      '室外附属工程挖沟槽土方9926.65m³，按分区段平行推进。',
    ]));
    expect(issues).toHaveLength(0);
  });

  it('同一对象同一工程量出现矛盾取值仍必须报出', async () => {
    const issues = await caliberScopeProbe(markdownWith([
      '本项目室外附属工程挖沟槽土方9926.65m³，按分区段平行推进。',
      '本项目室外附属工程挖沟槽土方879.41m³，按分区段平行推进。',
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('blocker');
  });
});

describe('L2-E 判定单元恢复标题承接', () => {
  it('有实质正文的节标题参与判定，正文窗口同时保留', () => {
    const markdown = [
      '### 2.16 扬尘污染防治措施',
      '扬尘治理按六个百分百落实：施工工地周边百分之百围挡，渣土车辆密闭运输，出场前逐车检查篷布闭合。',
      '',
    ].join('\n');
    const units = splitScoringBlocks(markdown);
    expect(units).toContain('扬尘污染防治措施');
    expect(units.some(unit => unit.includes('六个百分百'))).toBe(true);
  });

  it('空壳标题不产出判定单元（r28l 防护不得回退）', () => {
    const markdown = ['### 1.1 编制说明与工程概况', '', '### 1.2 编制专项施工方案', ''].join('\n');
    expect(splitScoringBlocks(markdown)).toHaveLength(0);
  });
});

/** 探针：经公开入口触发跨章一致性检测中的「挖沟槽土方」条目（避免测私有实现） */
async function caliberScopeProbe(markdown: string) {
  const factsModel = { project: [], schedule: [], quality: [], safety: [], billItemFacts: [] } as unknown as DocumentFactsModel;
  const issues = await crossChapterConsistencyIssues(markdown, factsModel, undefined, undefined, embedder.embedDocuments.bind(embedder));
  return issues.filter(issue => /挖沟槽土方/.test(issue.message));
}
describe('L0 事实冲突可比值（变更叙述取生效值 / 缺席声明不入比对）', () => {
  const zeroEmbedding = async (texts: string[]) => texts.map(() => [0, 0, 0]);
  const fact = (value: string, sourceFile: string) => ({ key: '计划工期', fieldName: '计划工期', value, sourceFile } as never);

  it('变更叙述取连接语之后的生效值 → 与另一来源的现行值一致，不报冲突', async () => {
    // 实测（巢湖 doc-f00280f9）：「365日历天，现变更修改为:330日历天」与「330日历天」被判多值冲突
    const conflicts = await detectFactConflicts([
      fact('365日历天，现变更修改为:330日历天', '7招标答疑文件.pdf'),
      fact('330日历天', '招标文件.pdf'),
    ], undefined, undefined, zeroEmbedding);
    expect(conflicts.filter(item => item.includes('计划工期'))).toHaveLength(0);
  });

  it('同槽位真冲突仍必须报出（防判据放宽成不设防）', async () => {
    const conflicts = await detectFactConflicts([
      fact('330日历天', '招标文件.pdf'),
      fact('365日历天', '答疑文件/6招标澄清文件.pdf'),
    ], undefined, undefined, zeroEmbedding);
    expect(conflicts.filter(item => item.includes('计划工期'))).toHaveLength(1);
  });
});
describe('L0 口径须落位清单（读写同源）', () => {
  const resolved = (attribute: string, value: string, extra: Record<string, unknown> = {}) => ({
    subject: '', attribute, value, rule: 'R7', evidence: [{ source: '招标文件.pdf', snippet: value }],
    superseded: [], caliber: true, candidates: [], ...extra,
  }) as never;

  it('无变更的项目级口径也进入「必须在正文出现」清单', () => {
    // 实测：开工日期 2026年10月10日 真值层有值、正文零次 → 终检按「未落位」阻断，
    // 而写手此前只被告知「发生过变更」的属性（本块原有唯一内容）→ 没被要求写
    const block = renderTruthConstraintBlock({ resolved: [resolved('开工日期', '2026年10月10日')], noiseRejected: [] });
    expect(block).toContain('项目级口径（必须在正文出现）');
    expect(block).toContain('开工日期：2026年10月10日');
  });

  it('已发生变更的口径仍走现行值/被取代块，不重复列入须落位清单', () => {
    const block = renderTruthConstraintBlock({
      resolved: [resolved('计划工期', '330日历天', { superseded: ['365日历天'] })],
      noiseRejected: [],
    });
    expect(block).toContain('现行口径（真值层裁决，硬约束）');
    expect(block).toContain('被取代（不得作为现行口径）：365日历天');
    expect(block).not.toContain('项目级口径（必须在正文出现）');
  });

  it('非口径属性不入须落位清单（约束不得膨胀）', () => {
    const block = renderTruthConstraintBlock({
      resolved: [resolved('底坑垫层做法', 'C20', { caliber: false })],
      noiseRejected: [],
    });
    expect(block).toBe('');
  });
});
describe('L0 口径链尾确定性回填', () => {
  const caliber = (attribute: string, value: string, extra: Record<string, unknown> = {}) => ({
    subject: '', attribute, value, rule: 'R7', evidence: [{ source: '招标文件.pdf', snippet: value }],
    superseded: [], caliber: true, candidates: [], ...extra,
  }) as never;

  it('正文逐字缺位的项目级口径由链尾补写（实测：开工日期全篇零次出现）', () => {
    // 实测原文：正文写「开工日期以监理工程师签发开工令之日起算」，真值 2026年10月10日 零次出现
    const markdown = '第一章 工程概况\n本工程开工日期以监理工程师签发开工令之日起算，总工期330日历天。\n';
    const result = backfillCaliberPlacements(markdown, [caliber('开工日期', '2026年10月10日')]);
    expect(result.inserted).toEqual([{ attribute: '开工日期', value: '2026年10月10日' }]);
    expect(result.markdown).toContain('开工日期为2026年10月10日。');
    // 原文一字不删（纯增量插入）
    expect(result.markdown).toContain('本工程开工日期以监理工程师签发开工令之日起算，总工期330日历天。');
  });

  it('已落位的口径不重复插入（幂等）', () => {
    const markdown = '本工程开工日期为2026年10月10日。\n';
    const first = backfillCaliberPlacements(markdown, [caliber('开工日期', '2026年10月10日')]);
    expect(first.inserted).toHaveLength(0);
    const second = backfillCaliberPlacements(first.markdown, [caliber('开工日期', '2026年10月10日')]);
    expect(second.inserted).toHaveLength(0);
  });

  it('属性名全篇零次出现时回落到概况章（项目级口径的自然归宿）', () => {
    // 实测：全篇 0 次「开工日期」——退回锚点①是空转，须落到「工程概况」章末尾
    const markdown = ['## 第一章 工程概况', '本工程为标准化厂房，建筑面积72062.84平方米。', '', '## 第二章 施工部署', '按流水段组织施工。', ''].join('\n');
    const result = backfillCaliberPlacements(markdown, [caliber('开工日期', '2026年10月10日')]);
    expect(result.inserted).toEqual([{ attribute: '开工日期', value: '2026年10月10日' }]);
    expect(result.markdown).toContain('开工日期为2026年10月10日。');
    // 落在概况章内、不越到下一章
    expect(result.markdown.indexOf('开工日期为')).toBeLessThan(result.markdown.indexOf('## 第二章'));
  });

  it('既无属性名又无概况章时不硬塞（不得插入无关段落）', () => {
    const markdown = '## 第一章 施工部署\n按流水段组织施工。\n';
    const result = backfillCaliberPlacements(markdown, [caliber('开工日期', '2026年10月10日')]);
    expect(result.inserted).toHaveLength(0);
    expect(result.markdown).toBe(markdown);
  });

  it('段落型值与非口径属性不插入', () => {
    const markdown = '第一章 概况\n机械设备计划见后。\n';
    expect(backfillCaliberPlacements(markdown, [caliber('机械设备计划', '模板材质由投标人自行选择')]).inserted).toHaveLength(0);
    expect(backfillCaliberPlacements(markdown, [caliber('底坑垫层做法', 'C20', { caliber: false })]).inserted).toHaveLength(0);
  });
});
