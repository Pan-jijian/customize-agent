/**
 * 4.55.29 L1-5 gate 阻断口径：classifyBlockingIssue 的 message 白名单放行修正。
 *
 * 变更前该函数有四条按 message 的整体放行（目录与正文／生成后事实反查失败／规划小节正文过短／
 * 证据使用覆盖率偏低），构成「检测到但不阻断」的后门：检测器报了、报告里有，交付闸门却放行。
 * 本用例锁定修正后的口径（逐条依据见 qualityValidation.ts 内注释）：
 * - 目录与正文不一致：阻断（正文/目录漂移是硬扣分点，且有确定性修复器 fixTocFromBody）；
 * - 生成后事实反查失败：阻断（生产者显式标注 blocker/evidence_coverage/llm_repairable，属修复链收敛范围）；
 * - 规划小节正文过短：阻断（正文 1–179 字的空洞小节必须补写，由补写轮收敛）；
 * - 证据使用覆盖率偏低：按等级（error 阻断 / warning 放行）——唯一生产者是 warning 级粗判据，
 *   保留「告警不阻断」语义，但不再由消息文本决定放行。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyBlockingIssue, sectionContentIntegrityIssues, tocBodyConsistencyIssues } from '@/services/document-workflow/qualityValidation';
import type { ValidationIssue } from '@/services/document-workflow/types';

const WORKFLOW_SRC = path.resolve(__dirname, '../../../src/services/document-workflow');
const readSrc = (relative: string) => readFileSync(path.join(WORKFLOW_SRC, relative), 'utf8');

function classifyBody(): string {
  const src = readSrc('qualityValidation.ts');
  const start = src.indexOf('export function classifyBlockingIssue');
  const end = src.indexOf('export function headingDuplicateIssues');
  return src.slice(start, end);
}

describe('4.55.29 L1-5 目录与正文不一致：阻断', () => {
  it('tocBodyConsistencyIssues 产物（编号↔名称漂移）一律阻断', () => {
    const markdown = ['## 目录', '1.1 施工准备', '', '## 第一章 工程概况', '### 1.1 施工准备与部署', '正文段落。'].join('\n');
    const issues = tocBodyConsistencyIssues(markdown);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every(issue => issue.message.includes('目录与正文'))).toBe(true);
    for (const issue of issues) expect(classifyBlockingIssue(issue)).toBe(true);
  });

  it('节数守恒漂移（正文多一节）同样阻断', () => {
    const markdown = ['## 目录', '1.1 施工准备', '', '## 第一章 工程概况', '### 1.1 施工准备', '正文。', '### 1.2 施工部署', '正文。'].join('\n');
    const issues = tocBodyConsistencyIssues(markdown);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) expect(classifyBlockingIssue(issue)).toBe(true);
  });
});

describe('4.55.29 L1-5 生成后事实反查失败：阻断', () => {
  it('未溯源数值（显式 blocker 标注的检测器产物）进入阻断集', () => {
    // 生产者口径锁定：documentFactTrace.numericTraceabilityIssues 的标注必须保持显式 blocker，
    // 否则「未溯源数值」会再次落回消息白名单 —— 这里同时锁定消息锚与标注三段。
    const src = readSrc('documentFactTrace.ts');
    expect(src).toContain('生成后事实反查失败：正文出现');
    expect(src).toContain("severity: 'blocker'");
    expect(src).toContain("category: 'evidence_coverage'");
    expect(src).toContain("repairability: 'llm_repairable'");
    const issue: ValidationIssue = {
      level: 'error',
      severity: 'blocker',
      category: 'evidence_coverage',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: '生成后事实反查失败：正文出现 3 处未溯源数值 12、34、56',
    };
    expect(classifyBlockingIssue(issue)).toBe(true);
  });
});

describe('4.55.29 L1-5 规划小节正文过短：阻断', () => {
  it('sectionContentIntegrityIssues 的 too_short 产物阻断', () => {
    const markdown = ['## 第一章 工程概况', '### 1.1 施工准备', '本节仅一句话说明，远未达到正文完整度要求。'].join('\n');
    const chapters = [{ id: 'c1', title: '第一章 工程概况', content: markdown, sections: ['施工准备'] }];
    const issues = sectionContentIntegrityIssues(markdown, chapters);
    const shortIssue = issues.find(issue => issue.message.includes('规划小节正文过短'));
    expect(shortIssue).toBeTruthy();
    expect(classifyBlockingIssue(shortIssue as ValidationIssue)).toBe(true);
  });
});

describe('4.55.29 L1-5 证据使用覆盖率偏低：按等级（error 阻断 / warning 放行）', () => {
  it('warning 级（唯一生产者 documentDeliveryReport 的口径）不阻断', () => {
    expect(classifyBlockingIssue({ level: 'warning', message: '证据使用覆盖率偏低：正文中未明显使用工期相关事实' })).toBe(false);
  });

  it('error 级阻断（不再由消息文本决定放行）', () => {
    expect(classifyBlockingIssue({ level: 'error', message: '证据使用覆盖率偏低：正文中未明显使用工期相关事实' })).toBe(true);
  });
});

describe('4.55.29 L1-5 白名单残留锁定', () => {
  it('四条 message 整体放行不得复活', () => {
    const body = classifyBody();
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/if \(\/目录与正文\/u\.test\(issue\.message\)\) return false;/u);
    expect(body).not.toMatch(/if \(\/生成后事实反查失败\/u\.test\(issue\.message\)\) return false;/u);
    expect(body).not.toMatch(/if \(\/规划小节正文过短\/u\.test\(issue\.message\)\) return false;/u);
    expect(body).not.toContain('证据使用覆盖率偏低|章节逻辑依赖不足');
  });
});
