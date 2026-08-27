import { describe, expect, it } from 'vitest';
import { buildTenderBidScores, closedLoopBlockStats } from '../src/services/document-workflow/tenderBidScoring';
import { closedLoopDensityIssues } from '../src/services/document-workflow/qualityValidation';
import type { DocumentDraftChapter, DocumentFactTrace } from '../src/services/document-workflow/types';

// 三要素齐全的闭环块模板（≥30 字）：责任岗位 + 检查频次 + 整改闭环
const CLOSED_BLOCK = '项目经理每日组织质量巡查并形成检查记录，发现偏差当场责令整改，由质检员复查确认后销项闭环，资料员归档台账备查。';

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

describe('executability 评分口径保持（每 1500 字至少 1 段闭环句式）', () => {
  it('闭环块达到目标数（短文档 target=6）时满分', () => {
    const markdown = Array.from({ length: 6 }, () => CLOSED_BLOCK).join('\n\n');
    expect(scores(markdown).executability).toBe(100);
  });

  it('无闭环块时为 0 分', () => {
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
