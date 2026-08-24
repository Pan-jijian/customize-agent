import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { referenceBenchmarkForType, referenceParadigmText, referenceQualityTargetLines, type TemplateReferenceRecord } from '../src/services/document-workflow/templateReferenceService';
import type { ReferenceQualityProfile, ReferenceProjectType } from '../src/services/document-workflow/referenceQualityProfile';

const indexPath = () => path.join(os.homedir(), '.customize-agent', 'template-references', 'references.json');

/** 参数密度可配置的合成画像：聚合口径验证需要不同样本的密度/计数各不相同 */
function makeProfile(input: {
  wordCount: number;
  paramDensity: number;
  arrowChainSegmentCount: number;
  duplicatedSegmentCount: number;
  tableCount: number;
  headings: string[];
}): ReferenceQualityProfile {
  const { wordCount, paramDensity, arrowChainSegmentCount, duplicatedSegmentCount, tableCount, headings } = input;
  return {
    wordCount,
    effectiveWordCount: wordCount,
    paramDensity,
    paramCount: Math.round(wordCount * paramDensity / 1000),
    arrowChainCoverage: arrowChainSegmentCount / 100,
    duplicationRate: duplicatedSegmentCount / 100,
    tableCount,
    sectionCount: headings.length,
    subsectionCount: headings.length * 4,
    subitemCount: headings.length * 6,
    avgSectionWords: Math.round(wordCount / headings.length),
    headingStructure: headings,
    tableTitles: [],
    paramTokens: [{ token: '养护', count: 5 }],
    segmentCount: 100,
    arrowChainSegmentCount,
    duplicatedSegmentCount,
  };
}

function makeRecord(id: string, projectType: ReferenceProjectType, profile: ReferenceQualityProfile): TemplateReferenceRecord {
  return { id, fileName: `${id}.pdf`, projectType, typeSource: 'manual', uploadedAt: Date.now(), fileSize: 1024, filePath: `files/${id}.pdf`, status: 'ready', qualityProfile: profile };
}

const ORIGINAL_INDEX = (() => { try { return fs.existsSync(indexPath()) ? fs.readFileSync(indexPath(), 'utf-8') : ''; } catch { return ''; } })();

describe('参考库对标基准聚合口径（主参考概念已移除）', () => {
  beforeAll(() => {
    const recordA = makeRecord('ref-bench-a', '房建', makeProfile({ wordCount: 20000, paramDensity: 12, arrowChainSegmentCount: 60, duplicatedSegmentCount: 5, tableCount: 10, headings: ['编制依据', '工程概况', '施工部署', '主要施工方案', '质量保证措施', '安全文明施工'] }));
    const recordB = makeRecord('ref-bench-b', '房建', makeProfile({ wordCount: 30000, paramDensity: 8, arrowChainSegmentCount: 90, duplicatedSegmentCount: 15, tableCount: 20, headings: ['编制依据', '工程概况', '施工部署', '施工总平面布置', '主要施工方案', '质量保证措施', '安全文明施工', '绿色施工'] }));
    const recordC = makeRecord('ref-bench-c', '市政', makeProfile({ wordCount: 15000, paramDensity: 10, arrowChainSegmentCount: 40, duplicatedSegmentCount: 3, tableCount: 6, headings: ['工程概况', '施工方案', '质量措施'] }));
    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify([recordA, recordB, recordC]), 'utf-8');
  });

  afterAll(() => {
    if (ORIGINAL_INDEX) { fs.mkdirSync(path.dirname(indexPath()), { recursive: true }); fs.writeFileSync(indexPath(), ORIGINAL_INDEX, 'utf-8'); }
  });

  it('0 份样本时无基准（undefined）', () => {
    expect(referenceBenchmarkForType('公路')).toBeUndefined();
  });

  it('1 份样本同样构成基准（不再要求多份）', () => {
    const benchmark = referenceBenchmarkForType('市政');
    expect(benchmark).toBeDefined();
    expect(benchmark!.sourceCount).toBe(1);
    expect(benchmark!.profile.paramDensity).toBeCloseTo(10, 5);
    expect(benchmark!.profile.tableCount).toBe(6);
    expect(benchmark!.profile.sectionCount).toBe(3);
  });

  it('多份样本取类型画像加权聚合（参数密度按有效字数加权，计数类等权平均）', () => {
    const benchmark = referenceBenchmarkForType('房建');
    expect(benchmark).toBeDefined();
    expect(benchmark!.sourceCount).toBe(2);
    // 参数密度：总参数数 / 总有效字数 = (240 + 240) / 50000 * 1000 = 9.6
    expect(benchmark!.profile.paramDensity).toBeCloseTo(9.6, 5);
    // 工序链覆盖率：总工序链段 / 总段落 = 150 / 200 = 0.75
    expect(benchmark!.profile.arrowChainCoverage).toBeCloseTo(0.75, 5);
    // 重复率：总重复段 / 总段落 = 20 / 200 = 0.1
    expect(benchmark!.profile.duplicationRate).toBeCloseTo(0.1, 5);
    // 表格/章节：等权平均
    expect(benchmark!.profile.tableCount).toBe(15);
    expect(benchmark!.profile.sectionCount).toBe(7);
  });

  it('章节范式取全部样本标题频次聚合（高频优先，非单文件）', () => {
    const paradigm = referenceParadigmText('房建');
    expect(paradigm).toBeDefined();
    expect(paradigm!.sourceCount).toBe(2);
    // 两样本共有标题应排在独有标题之前
    const text = paradigm!.text;
    expect(text.indexOf('编制依据')).toBeLessThan(text.indexOf('施工总平面布置'));
    expect(text.indexOf('绿色施工')).toBeGreaterThan(text.indexOf('安全文明施工'));
  });

  it('单样本蓝图注入同样给出量化目标（此前 ≥2 份才给）', () => {
    const lines = referenceQualityTargetLines({ templateName: '市政道路工程', chapterTitles: ['工程概况'], requirement: '市政道路施工组织设计', targetWords: 15000 });
    expect(lines.length).toBeGreaterThan(0);
    const densityLine = lines.find(line => line.includes('工艺参数密度参考'));
    expect(densityLine).toBeDefined();
  });

  it('无同类型样本时蓝图注入返回空（不注入任何内容）', () => {
    const lines = referenceQualityTargetLines({ templateName: '水利水电工程', chapterTitles: ['工程概况'], targetWords: 10000 });
    expect(lines).toEqual([]);
  });
});
