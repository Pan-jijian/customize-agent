import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { referenceWritingSkeletonLines, type TemplateReferenceRecord } from '../src/services/document-workflow/templateReferenceService';
import type { ReferenceQualityProfile, ReferenceProjectType } from '../src/services/document-workflow/referenceQualityProfile';

const indexPath = () => path.join(os.homedir(), '.customize-agent', 'template-references', 'references.json');

function makeProfile(headings: string[], overrides: Partial<ReferenceQualityProfile> = {}): ReferenceQualityProfile {
  const wordCount = 20000;
  return {
    wordCount,
    effectiveWordCount: wordCount,
    paramDensity: 8,
    paramCount: 160,
    arrowChainCoverage: 0.6,
    duplicationRate: 0.05,
    tableCount: 8,
    sectionCount: headings.length,
    subsectionCount: headings.length * 4,
    subitemCount: headings.length * 6,
    avgSectionWords: Math.round(wordCount / headings.length),
    headingStructure: headings,
    tableTitles: [],
    paramTokens: [],
    segmentCount: 100,
    arrowChainSegmentCount: 60,
    duplicatedSegmentCount: 5,
    ...overrides,
  };
}

function makeRecord(id: string, projectType: ReferenceProjectType, profile: ReferenceQualityProfile): TemplateReferenceRecord {
  return { id, fileName: `${id}.pdf`, projectType, typeSource: 'manual', uploadedAt: Date.now(), fileSize: 1024, filePath: `files/${id}.pdf`, status: 'ready', qualityProfile: profile };
}

const ORIGINAL_INDEX = (() => { try { return fs.existsSync(indexPath()) ? fs.readFileSync(indexPath(), 'utf-8') : ''; } catch { return ''; } })();

const SKELETON_A = ['编制依据', '工程概况', '施工部署', '主要分部分项工程施工方案', '质量保证措施', '安全文明施工'];
const SKELETON_B = ['编制依据', '工程概况', '施工部署', '主要分部分项工程施工方案', '质量保证措施', '安全文明施工', '绿色施工'];
const SKELETON_C = ['工程概况', '主要分部分项工程施工方案', '质量保证措施'];

describe('范文写法骨架切片（referenceWritingSkeletonLines）', () => {
  beforeAll(() => {
    const recordA = makeRecord('ref-skeleton-a', '房建', makeProfile(SKELETON_A));
    const recordB = makeRecord('ref-skeleton-b', '房建', makeProfile(SKELETON_B));
    const recordC = makeRecord('ref-skeleton-c', '房建', makeProfile(SKELETON_C));
    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify([recordA, recordB, recordC]), 'utf-8');
  });

  afterAll(() => {
    if (ORIGINAL_INDEX) { fs.mkdirSync(path.dirname(indexPath()), { recursive: true }); fs.writeFileSync(indexPath(), ORIGINAL_INDEX, 'utf-8'); }
  });

  it('无同类型样本时返回空数组（不注入任何内容）', () => {
    expect(referenceWritingSkeletonLines({ templateName: '水利水电工程', chapterTitles: ['工程概况'] })).toEqual([]);
  });

  it('给出章节推进骨架（出现于半数以上样本的章节按典型顺序排列）', () => {
    const lines = referenceWritingSkeletonLines({ templateName: '房建工程', chapterTitles: ['工程概况'], requirement: '住宅小区施工组织设计' });
    expect(lines.length).toBeGreaterThan(0);
    const skeletonLine = lines.find(line => line.includes('章节推进骨架'));
    expect(skeletonLine).toBeDefined();
    // 三份样本均含“工程概况”，且按平均位置“编制依据”先于“工程概况”
    const skeleton = skeletonLine!;
    expect(skeleton.indexOf('编制依据')).toBeLessThan(skeleton.indexOf('工程概况'));
    expect(skeleton.indexOf('工程概况')).toBeLessThan(skeleton.indexOf('施工部署'));
    // 只出现于 2/3 样本的“施工部署”也在骨架中（≥半数）
    expect(skeleton).toContain('施工部署');
    // 只出现于 1/3 样本的“绿色施工”不进骨架
    expect(skeleton).not.toContain('绿色施工');
  });

  it('给出分层展开深度描述（平均每章小节数与子目数）', () => {
    const lines = referenceWritingSkeletonLines({ templateName: '房建工程', chapterTitles: ['工程概况'] });
    const depthLine = lines.find(line => line.includes('分层展开深度'));
    expect(depthLine).toBeDefined();
    expect(depthLine).toContain('个二级小节');
    expect(depthLine).toContain('个三级子目');
  });

  it('方案章节典型组织引用同类样本方案类标题', () => {
    const lines = referenceWritingSkeletonLines({ templateName: '房建工程', chapterTitles: ['工程概况'] });
    const schemeLine = lines.find(line => line.includes('方案章节典型组织'));
    expect(schemeLine).toBeDefined();
    expect(schemeLine).toContain('主要分部分项工程施工方案');
  });

  it('给出分部分项三段式展开模式骨架（不与参考数值混写）', () => {
    const lines = referenceWritingSkeletonLines({ templateName: '房建工程', chapterTitles: ['工程概况'] });
    const patternLine = lines.find(line => line.includes('分部分项展开模式'));
    expect(patternLine).toBeDefined();
    expect(patternLine).toContain('施工概况');
    expect(patternLine).toContain('工艺流程');
    expect(patternLine).toContain('施工方法');
    // 骨架只描述展开模式，不含任何样本数值
    expect(patternLine).not.toMatch(/\d/);
  });
});
