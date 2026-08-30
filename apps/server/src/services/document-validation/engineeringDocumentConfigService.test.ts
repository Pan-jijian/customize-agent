/**
 * engineeringDocumentConfigService 单测（homedir mock 到临时目录）：
 * 读取默认/损坏回退/写入往返/normalize 字段过滤与 technicalDetailGate 透传。
 * 绝不触碰真实 ~/.customize-agent。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readEngineeringDocumentConfig, writeEngineeringDocumentConfig, type EngineeringDocumentConfig } from './engineeringDocumentConfigService';

let tempDir = '';

// Node ESM 命名空间不可配置，无法 spyOn；以模块级 mock 重定向 homedir 到临时目录
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempDir };
});

function emptyConfig(): EngineeringDocumentConfig {
  return {
    reviewStandardQueries: [],
    reviewChapterTemplateMatchers: [],
    reviewChapterSectionDefaults: { firstChapterSections: [], chapterSections: [], firstChapterTableSections: [], firstChapterTableRequirements: [] },
    templates: [],
    roles: [],
    roleConfigs: [],
    qualityBenchmarks: [],
    autoSpecGates: [],
    chapterTitleFilters: [],
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-config-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('readEngineeringDocumentConfig', () => {
  it('无配置文件 → 返回默认空配置', () => {
    expect(readEngineeringDocumentConfig()).toEqual(emptyConfig());
  });

  it('配置文件损坏 JSON → 回退默认配置', () => {
    const dir = path.join(tempDir, '.customize-agent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'engineering-document-config.json'), '{ broken', 'utf-8');
    expect(readEngineeringDocumentConfig()).toEqual(emptyConfig());
  });

  it('配置目录不存在时自动创建后返回默认', () => {
    expect(readEngineeringDocumentConfig()).toEqual(emptyConfig());
    expect(fs.existsSync(path.join(tempDir, '.customize-agent'))).toBe(true);
  });
});

describe('writeEngineeringDocumentConfig 与往返', () => {
  it('写入后读取往返一致', () => {
    const config = {
      ...emptyConfig(),
      reviewStandardQueries: ['查询1', '', '查询2'],
      reviewChapterTemplateMatchers: ['施工组织设计'],
    };
    writeEngineeringDocumentConfig(config);
    const loaded = readEngineeringDocumentConfig();
    expect(loaded.reviewStandardQueries).toEqual(['查询1', '查询2']);
    expect(loaded.reviewChapterTemplateMatchers).toEqual(['施工组织设计']);
  });

  it('写入文件为 2 空格缩进 JSON', () => {
    writeEngineeringDocumentConfig(emptyConfig());
    const raw = fs.readFileSync(path.join(tempDir, '.customize-agent', 'engineering-document-config.json'), 'utf-8');
    expect(raw).toContain('\n  "reviewStandardQueries"');
  });

  it('非数组字段类型写入时被 normalize 为默认值', () => {
    const config = {
      ...emptyConfig(),
      templates: 'not-array' as unknown as EngineeringDocumentConfig['templates'],
      roles: undefined as unknown as EngineeringDocumentConfig['roles'],
    };
    writeEngineeringDocumentConfig(config);
    const loaded = readEngineeringDocumentConfig();
    expect(loaded.templates).toEqual([]);
    expect(loaded.roles).toEqual([]);
  });

  it('sectionDefaults 部分缺失补全默认值', () => {
    const config = {
      ...emptyConfig(),
      reviewChapterSectionDefaults: { firstChapterSections: ['章节A'] } as EngineeringDocumentConfig['reviewChapterSectionDefaults'],
    };
    writeEngineeringDocumentConfig(config);
    const loaded = readEngineeringDocumentConfig();
    expect(loaded.reviewChapterSectionDefaults.firstChapterSections).toEqual(['章节A']);
    expect(loaded.reviewChapterSectionDefaults.chapterSections).toEqual([]);
    expect(loaded.reviewChapterSectionDefaults.firstChapterTableRequirements).toEqual([]);
  });

  it('technicalDetailGate 透传', () => {
    const config = {
      ...emptyConfig(),
      technicalDetailGate: {
        templateMatchers: ['施工组织设计'],
        minTechnicalFactUsageRate: 0.6,
        minMethodParameterCount: 3,
        minQuantitativeFactCount: 4,
        minStandardCount: 2,
        minProcessActionCount: 5,
        minInspectionActionCount: 3,
        maxGenericPhraseCountPer1800Chars: 6,
        minAssignedFactCountForBlocking: 2,
        genericPhrases: ['加强管理'],
      },
    };
    writeEngineeringDocumentConfig(config);
    const loaded = readEngineeringDocumentConfig();
    expect(loaded.technicalDetailGate?.minStandardCount).toBe(2);
    expect(loaded.technicalDetailGate?.genericPhrases).toEqual(['加强管理']);
  });

  it('autoSpecGates 数组整体透传（不深过滤）', () => {
    const config = {
      ...emptyConfig(),
      autoSpecGates: [
        { templateMatchers: ['', 'x'], requiredFacts: ['', 'f1'], requiredTexts: [], forbiddenTexts: [] },
      ],
      chapterTitleFilters: [],
    };
    writeEngineeringDocumentConfig(config);
    const loaded = readEngineeringDocumentConfig();
    expect(loaded.autoSpecGates).toHaveLength(1);
    expect(loaded.autoSpecGates[0]!.templateMatchers).toEqual(['', 'x']);
    expect(loaded.autoSpecGates[0]!.requiredFacts).toEqual(['', 'f1']);
  });
});
