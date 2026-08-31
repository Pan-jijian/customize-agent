/**
 * crossChapterDataScan 单测（阶段四）：青天评审确定性前置扫描与定位后置校验。
 */
import { describe, expect, it } from 'vitest';
import { collectDocumentHeadings, formatKnownConflictLines, sanitizeIssueLocation, scanCrossChapterDataConflicts } from './crossChapterDataScan';
import type { DocumentDraftChapter } from './types';

function chapter(id: string, title: string, content: string): DocumentDraftChapter {
  return { id, title, content, evidence: [], missingFacts: [], sections: [], tablePlans: [] };
}

describe('scanCrossChapterDataConflicts 跨章数据矛盾确定性扫描（4.1）', () => {
  it('劳动力高峰跨章多值报疑似矛盾（评分报告 180人/130人 实测场景）', () => {
    const chapters = [
      chapter('c1', '施工部署', '本工程劳动力高峰期为180人，分三阶段投入。'),
      chapter('c2', '资源配置', '劳动力配置计划：高峰期用工130人，各工种按比例配置。'),
    ];
    const conflicts = scanCrossChapterDataConflicts(chapters);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0].field).toBe('劳动力高峰人数');
    expect(conflicts[0].occurrences.map(item => item.value)).toEqual(expect.arrayContaining(['180', '130']));
    expect(conflicts[0].occurrences.map(item => item.chapter)).toEqual(expect.arrayContaining(['施工部署', '资源配置']));
  });

  it('装配率跨章矛盾报疑似（评分报告 30 vs 38.4 实测场景）', () => {
    const chapters = [
      chapter('c1', '装配式施工', '本工程装配率为30%。'),
      chapter('c2', '施工部署', '装配率按38.4%执行。'),
    ];
    const conflicts = scanCrossChapterDataConflicts(chapters);
    expect(conflicts.some(item => item.field === '装配率')).toBe(true);
    const assembly = conflicts.find(item => item.field === '装配率');
    expect(assembly?.occurrences.map(item => item.value)).toEqual(expect.arrayContaining(['30', '38.4']));
  });

  it('支护形式两套体系并存报疑似（评分报告 放坡喷锚 vs 灌注桩 实测场景）', () => {
    const chapters = [
      chapter('c1', '基坑工程', '基坑支护采用放坡喷锚形式。'),
      chapter('c2', '危大工程', '本基坑采用灌注桩支护。'),
    ];
    const conflicts = scanCrossChapterDataConflicts(chapters);
    expect(conflicts.some(item => item.field === '支护形式')).toBe(true);
  });

  it('同章内多值不报（章内矛盾由资源一致性检测覆盖，扫描聚焦跨章盲区）', () => {
    const chapters = [chapter('c1', '施工部署', '劳动力高峰180人，后续调整至130人。')];
    expect(scanCrossChapterDataConflicts(chapters)).toEqual([]);
  });

  it('全章取值一致不报', () => {
    const chapters = [
      chapter('c1', '施工部署', '本工程总工期为540日历天。'),
      chapter('c2', '进度计划', '计划工期540日历天。'),
    ];
    expect(scanCrossChapterDataConflicts(chapters)).toEqual([]);
  });

  it('无关"X人"数字不误报为劳动力', () => {
    const chapters = [
      chapter('c1', '施工部署', '项目部管理人员12人。'),
      chapter('c2', '资源配置', '安全员配置5人。'),
    ];
    expect(scanCrossChapterDataConflicts(chapters)).toEqual([]);
  });
});

describe('formatKnownConflictLines 冲突清单格式化（4.1）', () => {
  it('空清单返回空字符串', () => {
    expect(formatKnownConflictLines([])).toBe('');
  });

  it('输出含字段、取值与章节定位', () => {
    const conflicts = scanCrossChapterDataConflicts([
      chapter('c1', '施工部署', '劳动力高峰180人。'),
      chapter('c2', '资源配置', '高峰期用工130人。'),
    ]);
    const lines = formatKnownConflictLines(conflicts);
    expect(lines).toContain('劳动力高峰人数');
    expect(lines).toContain('180');
    expect(lines).toContain('130');
    expect(lines).toContain('施工部署');
    expect(lines).toContain('资源配置');
  });
});

describe('collectDocumentHeadings / sanitizeIssueLocation 定位后置校验（4.2）', () => {
  const chapters = [
    chapter('c1', '施工部署', '### 2.3 劳动力配置计划\n正文内容。\n### 2.4 机械设备配置\n正文内容。'),
    chapter('c2', '质量保证措施', '正文内容。'),
  ];

  it('标题集合含章节标题与小节标题', () => {
    const headings = collectDocumentHeadings(chapters);
    expect(headings).toEqual(expect.arrayContaining(['施工部署', '质量保证措施', '2.3 劳动力配置计划', '2.4 机械设备配置']));
  });

  it('幻觉定位（"5.4劳动力表"实为 2.3 节）标注待核并保留原定位', () => {
    const headings = collectDocumentHeadings(chapters);
    expect(sanitizeIssueLocation('5.4劳动力表', headings)).toBe('待核（原定位：5.4劳动力表）');
  });

  it('真实小节标题定位保留原样', () => {
    const headings = collectDocumentHeadings(chapters);
    expect(sanitizeIssueLocation('2.3 劳动力配置计划', headings)).toBe('2.3 劳动力配置计划');
  });

  it('互含定位（"劳动力配置计划" ⊂ "2.3 劳动力配置计划"）保留', () => {
    const headings = collectDocumentHeadings(chapters);
    expect(sanitizeIssueLocation('劳动力配置计划', headings)).toBe('劳动力配置计划');
  });

  it('空定位原样返回', () => {
    expect(sanitizeIssueLocation('', collectDocumentHeadings(chapters))).toBe('');
  });
});
