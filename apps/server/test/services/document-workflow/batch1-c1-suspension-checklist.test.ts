/**
 * 批 1 C1 复核清单测试（收敛责任制收尾 + 4.50 交付解耦，验收#1「blocker=0 交付或复核清单+条」）：
 * - 结构化条目：分类中文标签 / 定位解析（chapterId→章节标题、sectionTitle、message 编号前缀、全文）/
 *   修复路径追溯（repairability 四类映射）/ 检测器身份（provenance.detectorId）；
 * - 全量保留：>12 条不截断不聚合（替代旧扁平列表「slice(0,12)」行为——人工清单必须逐条可定位）；
 * - banner（warningIssues 置顶条）：复核语义 + 未收敛计数 + 分类/定位摘要 + 完整清单指引；
 * - details（agent-final-gate stage）：逐条全量，含问题原文/修复路径/建议/检测器；
 * - 语义护栏：复核声明必须明确「不影响文档查看与导出」（4.50 交付解耦：阻断不阻止交付，仅提示复核）。
 */
import { describe, expect, it } from 'vitest';
import { buildSuspensionChecklist, formatSuspensionBanner, formatSuspensionDetails } from '@/services/document-workflow/suspensionChecklist';
import type { ValidationIssue } from '@/services/document-workflow/types';

const chapters = [
  { id: 'ch-5', title: '第五章 施工进度计划' },
  { id: 'ch-8', title: '第八章 机械设备配置' },
];

const blockers: ValidationIssue[] = [
  {
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    chapterId: 'ch-5',
    sectionTitle: '5.1 总进度计划',
    message: '合计值与权威不符：正文 16344.54m，清单权威 16037.54m',
    suggestion: '按清单权威 16037.54m 修正合计口径',
    provenance: { detectorId: 'fact-reconciliation', fingerprint: 'fp-1' },
  },
  {
    level: 'error',
    severity: 'blocker',
    category: 'structure',
    owner: 'system',
    repairability: 'local_deterministic',
    message: '5.2 施工准备 正文不足：当前 120 字，要求不少于 250 字',
  },
  {
    level: 'error',
    severity: 'blocker',
    message: '最终正文仍包含未完成小节标记',
  },
];

describe('C1 复核清单：结构化条目（分类/定位/修复路径/检测器）', () => {
  it('chapterId + sectionTitle → 章节标题 / 小节标题定位；分类与修复路径映射', () => {
    const checklist = buildSuspensionChecklist(blockers, chapters);
    expect(checklist.suspended).toBe(true);
    expect(checklist.total).toBe(3);
    const first = checklist.items[0];
    expect(first.index).toBe(1);
    expect(first.category).toBe('数值/事实一致性');
    expect(first.location).toBe('第五章 施工进度计划 / 5.1 总进度计划');
    expect(first.problem).toContain('16344.54');
    expect(first.action).toContain('按清单权威 16037.54m 修正');
    expect(first.repairPath).toContain('LLM 定向修复');
    expect(first.detectorId).toBe('fact-reconciliation');
  });

  it('无章节锚点时：message 编号前缀作定位；无 category 归「其他」；无 suggestion 给通用修订动作', () => {
    const checklist = buildSuspensionChecklist(blockers, chapters);
    const second = checklist.items[1];
    expect(second.category).toBe('结构完整性');
    expect(second.location).toBe('5.2 施工准备');
    expect(second.repairPath).toContain('确定性修复器');
    const third = checklist.items[2];
    expect(third.category).toBe('其他');
    expect(third.location).toBe('全文');
    expect(third.action).toContain('人工核对后修订正文');
    expect(third.repairPath).toBe('自动修复链已执行（残留待人工定位）');
  });

  it('全量保留：>12 条不截断（旧扁平列表 slice(0,12) 行为废弃）', () => {
    const many = Array.from({ length: 15 }, (_, index) => ({
      level: 'error' as const,
      severity: 'blocker' as const,
      category: 'table' as const,
      message: `第 ${index + 1} 项表格缺陷`,
    }));
    const checklist = buildSuspensionChecklist(many);
    expect(checklist.total).toBe(15);
    expect(checklist.items).toHaveLength(15);
    expect(checklist.items[14].index).toBe(15);
  });
});

describe('C1 复核清单：banner（warningIssues 置顶条）', () => {
  it('复核语义 + 未收敛计数 + 分类/定位摘要 + 完整清单指引', () => {
    const banner = formatSuspensionBanner(buildSuspensionChecklist(blockers, chapters));
    expect(banner).toContain('导出门禁未通过：存在 3 项未收敛阻断，不影响文档查看与导出（已转人工复核清单）');
    expect(banner).toContain('【数值/事实一致性】');
    expect(banner).toContain('第五章 施工进度计划 / 5.1 总进度计划');
    expect(banner).toContain('完整清单见执行阶段「Agent 最终门禁」');
  });

  it('超过 limit 时提示剩余条数；长问题裁剪但保留头部定位信息', () => {
    const many: ValidationIssue[] = Array.from({ length: 11 }, (_, index) => ({
      level: 'error',
      severity: 'blocker',
      category: 'style',
      message: `第 ${index + 1} 项超长问题描述${'填充'.repeat(60)}尾部不应出现在横幅`,
    }));
    const banner = formatSuspensionBanner(buildSuspensionChecklist(many));
    expect(banner).toContain('另 3 项');
    expect(banner).toContain('…');
    expect(banner).not.toContain('尾部不应出现在横幅');
  });

  it('语义护栏：横幅明确「不影响文档查看与导出」（4.50 交付解耦：阻断不再挂起交付）', () => {
    const banner = formatSuspensionBanner(buildSuspensionChecklist(blockers, chapters));
    expect(banner).toContain('不影响文档查看与导出');
    expect(banner).not.toContain('不作为交付件');
  });
});

describe('C1 复核清单：details（agent-final-gate stage 明细）', () => {
  it('逐条全量：含问题原文/修复路径/建议/检测器身份', () => {
    const checklist = buildSuspensionChecklist(blockers, chapters);
    const details = formatSuspensionDetails(checklist);
    expect(details).toHaveLength(3);
    expect(details[0]).toContain('【数值/事实一致性】');
    expect(details[0]).toContain('16344.54');
    expect(details[0]).toContain('修复路径：');
    expect(details[0]).toContain('检测器：fact-reconciliation');
    expect(details[1]).not.toContain('检测器：');
  });
});
