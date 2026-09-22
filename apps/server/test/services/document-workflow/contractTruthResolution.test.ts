/**
 * 蓝图 contract 读取真值层生效值（4.55.19 切写侧第一步）。
 * 实测缺陷：招标 365 / 答疑澄清 330 时蓝图按 365 推导里程碑与进度计划（起止天序排到 348 天），正文按 330 写。
 */
import { describe, expect, it } from 'vitest';
import { extractContractFromFacts } from '@/services/document-workflow/integratedBlueprint';

const boq = { entries: [], villages: [] } as unknown as Parameters<typeof extractContractFromFacts>[1];

describe('extractContractFromFacts 消费真值层生效值', () => {
  it('答疑变更后工期 330 生效（招标文本中的 365 不再决定蓝图）', () => {
    const contract = extractContractFromFacts('本工程计划工期365日历天，现变更修改为:330日历天。', boq, { 计划工期: '330日历天' });
    expect(contract.totalDays).toBe(330);
  });

  it('无真值层输入时回退变更句解析（行为兼容）', () => {
    expect(extractContractFromFacts('本工程计划工期365日历天，现变更修改为:330日历天。', boq).totalDays).toBe(330);
    expect(extractContractFromFacts('本工程计划工期330日历天。', boq).totalDays).toBe(330);
  });

  it('质量标准/合同金额同样优先取真值层（短语级值才采用）', () => {
    const contract = extractContractFromFacts('质量标准：合格。合同估算价22303.66万元。', boq, { 质量标准: '合格', 合同金额: '22303.66万元' });
    expect(contract.qualityStandard).toBe('合格');
    expect(contract.estimatedAmount).toBe(22303.66);
  });

  it('真值层质量标准为句子级时不采用（回退文本解析，防段落冒充值）', () => {
    const contract = extractContractFromFacts('质量标准：合格。', boq, { 质量标准: '本工程的质量及操作须符合《城市道路工程施工质量验收规程》DGJ08-118-2005的要求。' });
    expect(contract.qualityStandard).toBe('合格');
  });
});
