import { describe, expect, it } from 'vitest';
import { buildTenderBidScores, closedLoopBlockStats } from '../src/services/document-workflow/tenderBidScoring';
import { closedLoopDensityIssues } from '../src/services/document-workflow/qualityValidation';
import type { DocumentDraftChapter, DocumentFactTrace } from '../src/services/document-workflow/types';

// 五要素齐全的闭环块（≥30 字）：方案＋流程＋责任人＋时间节点＋验收标准，同时满足闭环句式三要素口径
const CLOSED_BLOCK = '项目经理每日组织质量巡查，严格执行质量管理制度，按巡查流程分步骤实施，发现偏差当场责令整改，由质检员复查确认后销项闭环，资料员归档台账备查。';

function scores(markdown: string) {
  return buildTenderBidScores({ markdown, chapters: [] as DocumentDraftChapter[], factTraces: [] as DocumentFactTrace[], issues: [] });
}

describe('closedLoopBlockStats（可落地性闭环句式分块口径）', () => {
  it('同一块内三要素齐全才算闭环块，缺任一要素不计', () => {
    const markdown = [
      CLOSED_BLOCK,
      '',
      '施工员负责现场施工与质量控制工作，并做好相关记录。',
      '',
      '每周对现场进行检查。',
      '',
      '发现问题及时整改并复查。',
    ].join('\n');
    expect(closedLoopBlockStats(markdown).closedLoopBlocks).toBe(1);
  });

  it('三要素分属不同块不计入闭环', () => {
    const markdown = [
      '项目经理是项目质量的第一责任人，对施工质量全面负责并组织开展相关工作。',
      '',
      '每日对施工现场进行例行巡查，检查施工质量与安全状态。',
      '',
      '对发现的问题及时整改并复查销项。',
    ].join('\n');
    expect(closedLoopBlockStats(markdown).closedLoopBlocks).toBe(0);
  });

  it('短块（不足 30 字）即使三要素齐全也不计入', () => {
    const markdown = '项目经理每日复查整改。';
    expect(closedLoopBlockStats(markdown).closedLoopBlocks).toBe(0);
  });
});

describe('executability 评分口径保持（每 1500 字至少 1 段五要素闭合块）', () => {
  it('五要素闭合块达到目标数（短文档 target=6）时满分', () => {
    const markdown = Array.from({ length: 6 }, () => CLOSED_BLOCK).join('\n\n');
    expect(scores(markdown).executability).toBe(100);
  });

  it('无五要素闭合块时为 0 分', () => {
    const markdown = [
      '施工员负责现场施工与质量控制工作，并做好相关记录。',
      '',
      '每周对现场进行检查。',
      '',
      '发现问题及时整改并复查。',
    ].join('\n');
    expect(scores(markdown).executability).toBe(0);
  });
});

// 合规性新口径：危大两步确认（10%）+ 应急预案八部分（10%）
const COMPLIANCE_BASE = '辨识 专项施工方案 专家论证 交底 监测 验收 三级配电 两级保护 漏电保护 实名制 工资专用账户 应急预案 绿色施工';
const DANGEROUS_TWO_STEP = '本工程基坑属超危大工程，开挖深度8.5米，需组织专家论证。';
const EMERGENCY_EIGHT = '总则：应急组织机构及职责明确，风险分析与危险源辨识完整，应急物资设备与通讯保障到位，专项应急预案齐全，应急响应流程清晰，后期处置与事故调查安排明确，定期组织培训演练。';

describe('compliance 评分新口径（危大两步确认＋应急预案八部分各占 10%）', () => {
  it('强制项全命中且危大两步＋应急八部分齐全时满分', () => {
    const markdown = `${COMPLIANCE_BASE}\n\n${DANGEROUS_TWO_STEP}\n\n${EMERGENCY_EIGHT}`;
    expect(scores(markdown).compliance).toBe(100);
  });

  it('危大两步不完整时合规分低于满分', () => {
    const markdown = `${COMPLIANCE_BASE}\n\n本工程基坑属超危大工程，需组织专家论证。\n\n${EMERGENCY_EIGHT}`;
    const score = scores(markdown).compliance;
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });
});

describe('closedLoopDensityIssues（全文级确定性检测）', () => {
  it('闭环句式密度达标时不产生告警', () => {
    const markdown = Array.from({ length: 6 }, () => CLOSED_BLOCK).join('\n\n');
    expect(closedLoopDensityIssues(markdown)).toEqual([]);
  });

  it('闭环句式密度不足时给 1 条 warning 指导修订', () => {
    const markdown = [CLOSED_BLOCK, '', CLOSED_BLOCK, '', '施工员负责现场施工与质量控制工作，并做好相关记录。', '', '每周对现场进行检查。'].join('\n');
    const issues = closedLoopDensityIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: 'warning' });
    expect(issues[0]?.message).toContain('闭环句式密度不足');
  });
});
