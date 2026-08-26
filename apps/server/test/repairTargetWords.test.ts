import { describe, expect, it } from 'vitest';
import { anchorTitleForSection, criticalSectionBlockerLine, hasDepthWarningIssues, repairTargetWordsForSection } from '../src/services/document-workflow/documentGeneratorHelpers';
import { criticalSectionBlockerMinChars } from '../src/services/document-workflow/chapterPostProcessing';

describe('repairTargetWordsForSection 补写目标对齐 Reviewer 深度通过线', () => {
  it('关键小节基线：项目主要施工内容 ≥ 2200 字', () => {
    expect(repairTargetWordsForSection('项目主要施工内容')).toBe(2200);
  });

  it('关键小节基线：主要分部分项工程施工方案 ≥ 1800 字', () => {
    expect(repairTargetWordsForSection('主要分部分项工程施工方案')).toBe(1800);
  });

  it('普通小节基线 760 字', () => {
    expect(repairTargetWordsForSection('施工现场平面布置')).toBe(760);
  });

  it('anchorMinChars 对齐：目标 = ceil(anchorMinChars / 0.8)，一次补写即可复审通过', () => {
    expect(repairTargetWordsForSection('施工现场平面布置', 0, 1760)).toBe(2200);
  });

  it('Repairer 验收线 0.7×目标 ≥ Reviewer 通过线 0.8×anchorMinChars（参数化）', () => {
    for (const anchorMinChars of [500, 900, 1200, 1500, 1760, 2200, 2600]) {
      const target = repairTargetWordsForSection('施工现场平面布置', 0, anchorMinChars);
      expect(Math.floor(target * 0.7)).toBeGreaterThanOrEqual(Math.floor(anchorMinChars * 0.8));
    }
  });

  it('taskMinChars 参与取最大值', () => {
    expect(repairTargetWordsForSection('施工现场平面布置', 2500, 0)).toBe(2500);
  });

  it('三者同时存在时取最大', () => {
    expect(repairTargetWordsForSection('施工现场平面布置', 2500, 1760)).toBe(2500);
    expect(repairTargetWordsForSection('施工现场平面布置', 700, 1760)).toBe(2200);
  });
});

describe('hasDepthWarningIssues 检测 warning 级正文不足问题', () => {
  it('warning 级正文不足命中', () => {
    expect(hasDepthWarningIssues([{ level: 'warning', severity: 'warning', message: '施工现场平面布置 正文不足，未达到任务最小深度' }])).toBe(true);
  });

  it('blocker 级正文不足不命中（由 blockingReviewIssues 路径处理）', () => {
    expect(hasDepthWarningIssues([{ level: 'error', severity: 'blocker', message: '项目主要施工内容 正文不足，未达到任务最小深度' }])).toBe(false);
  });

  it('其他 warning 消息不命中', () => {
    expect(hasDepthWarningIssues([{ level: 'warning', severity: 'warning', message: '施工现场平面布置 工序链箭头缺失：当前 0 个"→"' }])).toBe(false);
  });

  it('空问题列表不命中', () => {
    expect(hasDepthWarningIssues([])).toBe(false);
  });
});

describe('criticalSectionBlockerLine Final Gate 阻断线不超过修复验收线（修复达标必过阻断）', () => {
  const criticalSections = [
    '项目特点、重点、难点分析',
    '项目主要施工内容',
    '主要分部分项工程施工方案',
    '主要施工方法',
    '危大工程专项施工方案审批流程',
    '原材料进场复试与见证取样',
  ];

  it('阻断线 ≤ 修复验收线（数学不变量，历史缺陷：主要施工方法 1760 > 1200 修好仍被阻断）', () => {
    for (const title of criticalSections) {
      expect(criticalSectionBlockerLine(title)).toBeLessThanOrEqual(criticalSectionBlockerMinChars(title));
    }
  });

  it('主要施工方法阻断线收敛到 1200（修复验收线）', () => {
    expect(criticalSectionBlockerLine('主要施工方法')).toBe(1200);
  });

  it('主要分部分项工程施工方案阻断线保持 800', () => {
    expect(criticalSectionBlockerLine('主要分部分项工程施工方案')).toBe(800);
  });

  it('项目主要施工内容阻断线保持 1760（1760 < 验收线 1800）', () => {
    expect(criticalSectionBlockerLine('项目主要施工内容')).toBe(1760);
  });

  it('项目特点、重点、难点分析阻断线保持 1440', () => {
    expect(criticalSectionBlockerLine('项目特点、重点、难点分析')).toBe(1440);
  });

  it('未知小节返回 0', () => {
    expect(criticalSectionBlockerLine('施工现场平面布置')).toBe(0);
  });
});

describe('anchorTitleForSection 锚点标题解析（Repairer 补写目标查深度表键）', () => {
  it('有 plannedCoverage 映射时返回首个承接标题（标题被语义重写的场景）', () => {
    expect(anchorTitleForSection({ '施工现场平面布置': ['平面布置与临时设施'] }, '施工现场平面布置')).toBe('平面布置与临时设施');
  });

  it('无映射时返回规划标题本身', () => {
    expect(anchorTitleForSection({}, '施工现场平面布置')).toBe('施工现场平面布置');
    expect(anchorTitleForSection(undefined, '施工现场平面布置')).toBe('施工现场平面布置');
  });

  it('映射为空数组时返回规划标题本身', () => {
    expect(anchorTitleForSection({ '施工现场平面布置': [] }, '施工现场平面布置')).toBe('施工现场平面布置');
  });

  it('多个承接标题时取首个', () => {
    expect(anchorTitleForSection({ '主要施工方法': ['桩基工程施工方法', '主体结构施工方法'] }, '主要施工方法')).toBe('桩基工程施工方法');
  });
});
