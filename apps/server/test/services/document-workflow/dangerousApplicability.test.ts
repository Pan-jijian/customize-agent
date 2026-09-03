/**
 * dangerousApplicability 单测：危大工程适用性兜底检测（C4）——L1 正则前提参数提取、
 * L2 阈值比较（建办质〔2018〕31号常见门槛）、辨识区提取与别名词面覆盖判定。
 */
import { describe, expect, it } from 'vitest';
import { dangerousApplicabilityIssues } from '@/services/document-workflow/dangerousApplicability';

describe('dangerousApplicabilityIssues', () => {
  it('正文无任何适用前提时静默跳过（不制造义务）', () => {
    expect(dangerousApplicabilityIssues('普通施工内容，无危大前提参数。')).toEqual([]);
  });

  it('基坑开挖深度 ≥3m 判适用，<3m 不适用', () => {
    // 实现事实：词头字符集 [约为达至] 不含空格，"深度为 5m" 带空格永不命中 → 前提提取需词头与数字紧邻
    expect(dangerousApplicabilityIssues('基坑开挖深度为5.2m。')).toHaveLength(1);
    expect(dangerousApplicabilityIssues('基坑开挖深度约2m。')).toEqual([]);
  });

  it('高大模板：支撑高度 ≥8m 或线荷载 ≥10kN 判适用', () => {
    expect(dangerousApplicabilityIssues('模板支撑体系搭设高度为9m。')).toHaveLength(1);
    expect(dangerousApplicabilityIssues('模板支撑搭设高度约6m。')).toEqual([]);
    expect(dangerousApplicabilityIssues('集中线荷载约为15kN。')).toHaveLength(1);
  });

  it('脚手架：搭设高度 ≥15m 或悬挑式判适用', () => {
    expect(dangerousApplicabilityIssues('落地式钢管脚手架搭设高度为24m。')).toHaveLength(1);
    expect(dangerousApplicabilityIssues('脚手架搭设高度约10m。')).toEqual([]);
    expect(dangerousApplicabilityIssues('本工程采用悬挑式脚手架。')).toHaveLength(1);
  });

  it('起重吊装：设备名与作业形态词（垂直运输/起重伤害）双覆盖', () => {
    expect(dangerousApplicabilityIssues('现场配置塔式起重机 2 台。')).toHaveLength(1);
    expect(dangerousApplicabilityIssues('材料垂直运输涉及的起重伤害风险。')).toHaveLength(1);
  });

  it('吊篮/拆除工程词面即适用', () => {
    expect(dangerousApplicabilityIssues('高处作业吊篮用于幕墙安装。')).toHaveLength(1);
    expect(dangerousApplicabilityIssues('本工程包含拆除工程。')).toHaveLength(1);
  });

  it('正文从未出现「危大」字样：全部适用项漏辨识（blocker）', () => {
    const issues = dangerousApplicabilityIssues('基坑开挖深度为5m，现场配置塔式起重机。');
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('全文未编制危大工程辨识清单');
    expect(issues[0].message).toContain('基坑支护与降水工程');
    expect(issues[0].message).toContain('起重吊装及安装拆卸工程');
    expect(issues[0].suggestion).toContain('建办质〔2018〕31号');
  });

  it('辨识区覆盖全部别名时无问题', () => {
    const markdown = [
      '基坑开挖深度为5m，现场配置塔式起重机。',
      '### 危大工程辨识清单',
      '- 基坑支护：本工程基坑开挖深度 5m，按危大工程管理。',
      '- 起重吊装：塔式起重机安拆按危大工程管理。',
    ].join('\n');
    expect(dangerousApplicabilityIssues(markdown)).toEqual([]);
  });

  it('辨识区遗漏适用项别名时产出 blocker 并列出遗漏项', () => {
    // 实现事实：辨识区 = 含"危大"行前后各 6 行；正文前提行与清单标题间需隔 >6 行才不被纳入辨识区
    const markdown = [
      '基坑开挖深度为5m，现场配置塔式起重机。',
      ...Array.from({ length: 7 }, (_, i) => `中间内容第 ${i} 行。`),
      '### 危大工程辨识清单',
      '- 基坑支护：按危大工程管理。',
    ].join('\n');
    const issues = dangerousApplicabilityIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('危大工程辨识清单遗漏适用项');
    expect(issues[0].message).toContain('起重吊装及安装拆卸工程');
    expect(issues[0].message).not.toContain('基坑支护与降水工程');
  });

  it('辨识区只取含「危大」行前后各 6 行', () => {
    const markdown = [
      '塔式起重机 2 台。',
      ...Array.from({ length: 8 }, (_, i) => `正文第 ${i} 行。`),
      '### 危大工程辨识清单',
      '- 起重吊装：按危大工程管理。',
    ].join('\n');
    expect(dangerousApplicabilityIssues(markdown)).toEqual([]);
  });
});
