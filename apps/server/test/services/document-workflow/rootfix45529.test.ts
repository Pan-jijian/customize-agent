/**
 * 4.55.29 根修回归集（方案 docs/rootfix-plan-4.55.29.md）。
 *
 * 全部用例取自**服务真实产出** `doc-1790104980418-d47a002e` 的实测缺陷形态：
 * 每一条先锁定「误报必须消失」，再锁定「真缺陷仍必须报出」——只做前者会把判据放宽成不设防。
 */
import { describe, expect, it } from 'vitest';
import { caliberConsistencyIssues, crossChapterConsistencyIssues } from '@/services/document-workflow/qualityValidation';
import { attributeValueShapeMismatch, rejectValueNoise } from '@/services/document-workflow/authoritativeValues';
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
