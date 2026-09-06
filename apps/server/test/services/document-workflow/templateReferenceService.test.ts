/**
 * 模板参考库服务单测（历史裁决后形态）：
 * 生成中注入已下线，保留的消费点中 referenceStructureSuggestion 有最小样本门槛
 * （1 份样本的"典型章节"是噪音：≥50% 样本 = 1/1），默认 3，env 可调。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { referenceStructureSuggestion } from '@/services/document-workflow/templateReferenceService';
import type { ReferenceQualityProfile } from '@/services/document-workflow/referenceQualityProfile';

// Node ESM 内置模块无法 vi.spyOn，用 vi.mock 工厂模拟参考库索引读取
const indexState = vi.hoisted(() => {
  let records: unknown[] = [];
  return {
    setRecords: (value: unknown[]) => { records = value; },
    getRecords: () => records,
  };
});

vi.mock('node:fs', () => ({
  mkdirSync: () => {},
  existsSync: () => true,
  readFileSync: () => JSON.stringify(indexState.getRecords()),
  writeFileSync: () => {},
  statSync: () => ({ size: 0 }),
  copyFileSync: () => {},
  unlinkSync: () => {},
}));

function qualityProfile(headings: string[]): ReferenceQualityProfile {
  return {
    wordCount: 1000,
    effectiveWordCount: 800,
    paramDensity: 1,
    paramCount: 10,
    arrowChainCoverage: 0.05,
    duplicationRate: 0.1,
    tableCount: 2,
    sectionCount: 3,
    subsectionCount: 4,
    subitemCount: 5,
    avgSectionWords: 300,
    headingStructure: headings,
    tableTitles: [],
    paramTokens: [],
    segmentCount: 10,
    arrowChainSegmentCount: 2,
    duplicatedSegmentCount: 1,
    fiveElementCompleteBlocks: 0,
  };
}

function record(headings: string[]): unknown {
  return {
    id: `ref-${Math.random().toString(36).slice(2, 10)}`,
    fileName: '参考文件.pdf',
    projectType: '房建',
    typeSource: 'manual',
    uploadedAt: Date.now(),
    fileSize: 100,
    filePath: 'files/ref.pdf',
    status: 'ready',
    profileVersion: 4,
    qualityProfile: qualityProfile(headings),
  };
}

describe('referenceStructureSuggestion 最小样本门槛', () => {
  beforeEach(() => { delete process.env.DOCUMENT_REFERENCE_SUGGEST_MIN_SAMPLES; });
  afterEach(() => { delete process.env.DOCUMENT_REFERENCE_SUGGEST_MIN_SAMPLES; });

  it('同类型样本不足 3 份时不给出建议', () => {
    indexState.setRecords([record(['房建分部分项施工方案']), record(['房建分部分项施工方案'])]);
    expect(referenceStructureSuggestion({ templateName: '房建工程施工组织设计', chapterTitles: ['工程概况'] })).toBeUndefined();
  });

  it('同类型样本达到 3 份且存在缺失高频章节时给出建议', () => {
    indexState.setRecords([record(['房建分部分项施工方案']), record(['房建分部分项施工方案']), record(['主体结构施工'])]);
    const suggestion = referenceStructureSuggestion({ templateName: '房建工程施工组织设计', chapterTitles: ['工程概况'] });
    expect(suggestion?.missingHeadings.some(item => item.title === '房建分部分项施工方案')).toBe(true);
  });

  it('env DOCUMENT_REFERENCE_SUGGEST_MIN_SAMPLES 可调高门槛', () => {
    process.env.DOCUMENT_REFERENCE_SUGGEST_MIN_SAMPLES = '5';
    indexState.setRecords([record(['房建分部分项施工方案']), record(['房建分部分项施工方案']), record(['房建分部分项施工方案'])]);
    expect(referenceStructureSuggestion({ templateName: '房建工程施工组织设计', chapterTitles: ['工程概况'] })).toBeUndefined();
  });

  it('env 值非法时回退默认门槛 3', () => {
    process.env.DOCUMENT_REFERENCE_SUGGEST_MIN_SAMPLES = 'abc';
    indexState.setRecords([record(['房建分部分项施工方案']), record(['房建分部分项施工方案']), record(['房建分部分项施工方案'])]);
    const suggestion = referenceStructureSuggestion({ templateName: '房建工程施工组织设计', chapterTitles: ['工程概况'] });
    expect(suggestion?.missingHeadings.some(item => item.title === '房建分部分项施工方案')).toBe(true);
  });
});
