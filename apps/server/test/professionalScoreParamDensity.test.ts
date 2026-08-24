import { describe, expect, it } from 'vitest';
import { buildProfessionalScoreReport } from '../src/services/document-workflow/documentProfessionalScore';
import { buildSectionFactCard } from '../src/services/document-workflow/chapterGeneration';
import { QUANTIFIED_BODY_PARAM_RE } from '../src/services/document-workflow/parameterPatterns';
import type { DocumentDraftChapter, DocumentEvidence } from '../src/services/document-workflow/types';

/** 构造约 N 字符的中文正文，并在其中嵌入指定参数片段（参数不重复） */
function buildBody(params: string[], targetChars = 1000): string {
  const fillerUnit = '施工准备阶段应完成现场踏勘与技术交底，明确作业边界与质量控制要点，落实材料进场验收与机械设备调试，形成过程记录。';
  let body = params.join('。');
  while (body.length < targetChars) {
    body += fillerUnit;
  }
  return body.slice(0, targetChars);
}

function chaptersFromBodies(bodies: string[]): DocumentDraftChapter[] {
  return bodies.map((content, index) => ({ id: `ch-${index}`, title: `第${index + 1}章`, content, sections: [], evidence: [], missingFacts: [] }));
}

describe('专业评分参数密度口径（90 分目标）', () => {
  it('factLanding：量化参数密度 5/千字 + 事实词 1 类 → 约 93 分（80 分档以上）', () => {
    const body = buildBody(['施工面积120㎡', '管道长300m', '板厚50mm', '设备2台', '工期15天']);
    const bodyWithFactWord = body.replace(fillerPlaceholder(), '工程量清单') as string;
    const report = buildProfessionalScoreReport(chaptersFromBodies([bodyWithFactWord]), '');
    const factLanding = report.dimensions.find(item => item.key === 'factLanding')!;
    // 密度 5.0 × 18 + 事实词 1.0 × 12 = 102 → clamp 100 附近；目标档位 ≥ 80
    expect(factLanding.score).toBeGreaterThanOrEqual(80);
  });

  it('processParameter：工艺参数密度 5/千字 + 概况数字 → 约 80 分（70 分档以上）', () => {
    const body = buildBody(['建筑面积12000㎡', '板厚50mm', '强度25MPa', '荷载12kN', '温度30℃', '坍落度按规范控制']);
    const report = buildProfessionalScoreReport(chaptersFromBodies([body]), '');
    const processParameter = report.dimensions.find(item => item.key === 'processParameter')!;
    // 工艺参数密度 5.0 × 12 + 20（概况数字存在） = 80
    expect(processParameter.score).toBeGreaterThanOrEqual(70);
  });

  it('量化参数密度为评分与检查共用口径（QUANTIFIED_BODY_PARAM_RE 命中数与评分一致）', () => {
    const body = buildBody(['施工面积120㎡', '管道长300m', '板厚50mm', '设备2台', '工期15天']);
    const quantified = new Set(body.match(QUANTIFIED_BODY_PARAM_RE) || []);
    const density = quantified.size / (body.length / 1000);
    const report = buildProfessionalScoreReport(chaptersFromBodies([body]), '');
    const factLanding = report.dimensions.find(item => item.key === 'factLanding')!;
    // detail 中报告密度应与常量口径一致（每千字 5.0）
    expect(factLanding.detail).toContain('每千字 5.0');
    expect(density).toBeCloseTo(5.0, 1);
  });
});

function fillerPlaceholder(): string {
  return '施工准备阶段应完成现场踏勘与技术交底';
}

describe('小节写作任务卡参数约束', () => {
  it('任务卡包含量化参数落位硬性要求（每千字不少于 2 个不同量化参数）', () => {
    const evidence: DocumentEvidence[] = [{
      chapterId: 'ch-1',
      filePath: '招标文件.pdf',
      content: '建筑面积约12000㎡；计划工期180天；管道规格DN150；混凝土强度等级C30。',
      roleId: '',
      score: 1,
    }];
    const card = buildSectionFactCard('施工准备与部署', evidence);
    expect(card.prompt).toContain('每千字不少于 2 个不同量化参数');
    expect(card.prompt).toContain('同一参数不得反复堆砌凑数');
  });
});
