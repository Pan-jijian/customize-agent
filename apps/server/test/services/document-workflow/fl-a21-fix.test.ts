import { describe, expect, it } from 'vitest';
import {
  finishThicknessIssues,
  fixFinishThickness,
  laborPeakConflictIssues,
  fixLaborPeakConflict,
  fixSelfUnderminingCandidates,
} from '../../../src/services/document-workflow/documentIntegrityChecks';
import { fixEmptyScoringResponses } from '../../../src/services/document-workflow/tenderRequirements';
import { buildTenderBidScores } from '../../../src/services/document-workflow/tenderBidScoring';
import type { ValidationIssue } from '../../../src/services/document-workflow/types';

describe('B7 装饰层厚度异常（200mm 串染）', () => {
  it('抹面/打底/坐浆 200mm 检出并除 10', () => {
    const md = '沟内壁用1:2水泥砂浆抹面，抹面厚度200mm。外墙真石漆施工前基层用200mm厚1:3水泥砂浆打底、200mm厚1:2.5水泥砂浆找平。广场铺装青砖用200mm厚1:3干硬性水泥砂浆坐浆。';
    const issues = finishThicknessIssues(md);
    expect(issues.length).toBe(1);
    const result = fixFinishThickness(md);
    expect(result.fixedCount).toBe(4);
    expect(result.markdown).toContain('抹面厚度20mm');
    expect(result.markdown).toContain('20mm厚1:3水泥砂浆打底');
    expect(result.markdown).toContain('20mm厚1:2.5水泥砂浆找平');
    expect(result.markdown).toContain('20mm厚1:3干硬性水泥砂浆坐浆');
  });

  it('结构层厚度不动（墙体/垫层/回填虚铺）', () => {
    const md = '砖墙采用煤矸石空心砖砌筑，墙体厚度200mm。检查井周回填中粗砂分层夯实，每层虚铺厚度不超过200mm。';
    expect(finishThicknessIssues(md).length).toBe(0);
    expect(fixFinishThickness(md).fixedCount).toBe(0);
  });

  it('常规装饰厚度（20mm）不误伤', () => {
    const md = '沟内壁抹面厚度20mm，外墙打底20mm。';
    expect(finishThicknessIssues(md).length).toBe(0);
    expect(fixFinishThickness(md).fixedCount).toBe(0);
  });
});

describe('B7 劳动力峰值口径统一', () => {
  it('总人数 181 vs 高峰人数 86 → 多数口径 86 胜出', () => {
    const md = [
      '道路硬化与排水施工高峰期总人数181人，其中混凝土工24人。',
      '该阶段劳动力峰值需求为86人。',
      '高峰人数86人出现在道路硬化与排水施工阶段。',
      '高峰期劳动力86人、混凝土搅拌运输车4台。',
      '项目部在施工高峰期保持181人劳动力峰值。',
    ].join('\n');
    const issues = laborPeakConflictIssues(md);
    expect(issues.length).toBe(1);
    const result = fixLaborPeakConflict(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('高峰期总人数86人');
    expect(result.markdown).not.toContain('高峰期总人数181人');
  });

  it('口径一致时不修', () => {
    const md = '高峰期总人数86人，高峰人数86人。';
    expect(laborPeakConflictIssues(md).length).toBe(0);
    expect(fixLaborPeakConflict(md).fixedCount).toBe(0);
  });
});

describe('B7 自伤句式 A21 形态', () => {
  it('未采用新技术句式改写为正向表述', () => {
    const md = '本项目以成熟可靠的常规工艺为主，未采用行业认定的新技术、新材料、新工艺或新设备。';
    const result = fixSelfUnderminingCandidates(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('本项目工艺选择以成熟可靠为原则');
    expect(result.markdown).not.toContain('未采用');
  });
});

describe('B7 评分响应空响应句改写', () => {
  it('价格调整条款空响应句改写为落实句', () => {
    const md = '招标要求响应（前附表响应条款）：市场价格波动仅对《可调整价差人工和主要材料一览表》中约定的人工、主要材料进行价格调整。本施工组织设计已按上述条款要求逐项落实执行。';
    const result = fixEmptyScoringResponses(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('本工程价格调整范围按《可调整价差人工和主要材料一览表》执行');
    expect(result.markdown).not.toContain('逐项落实执行');
  });

  it('无条款语境行不动', () => {
    const md = '本施工组织设计已按上述条款要求逐项落实执行。';
    const result = fixEmptyScoringResponses(md);
    expect(result.fixedCount).toBe(0);
  });
});

describe('B7 normalization 评分口径', () => {
  it('跨章一致性复核与事实一致性冲突不计入编制规范性', async () => {
    const issues: ValidationIssue[] = [
      { level: 'error', message: '跨章一致性复核：劳动力数据矛盾：合计行 86 人与明细行之和 181 人不符' },
      { level: 'error', message: '事实一致性冲突：招标人 存在多个值：R3C1建设项目招标图纸目录:（9.14） vs 肥西县丰乐镇人民政府' },
      { level: 'error', message: '工程概况 缺少规划小节：重点难点识别与应对' },
      { level: 'warning', message: '同主题表格重复堆叠：4 组相同表头出现 3 次及以上' },
    ];
    const zeroEmbed = async (texts: string[]): Promise<number[][]> => texts.map(() => texts.map(() => 0));
    const scores = await buildTenderBidScores({
      markdown: '# 一、工程概况\n\n施工组织设计正文内容。',
      chapters: [{ id: 'c1', title: '工程概况', content: '施工组织设计正文内容。', sections: [], evidence: [], missingFacts: [] }],
      factTraces: [],
      issues,
      embedDocuments: zeroEmbed,
    });
    // 1 条缺小节 error（-8）+ 1 条表格 warning（-3）= 89；旧口径会因 2 条额外 error 再 -16
    expect(scores.normalization).toBe(89);
  });
});
