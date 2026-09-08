import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoDocumentSpecPackage } from '@/services/document-core/autoDocumentSpecTypes';
import { DEFAULT_DOCUMENT_DOMAIN_PROFILE } from '@/services/document-core/documentDomainProfileService';
import type { DocumentEvidence, DocumentFact, DocumentFactsModel, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter, StructuredTableFact } from '@/services/document-workflow/types';
import {
  buildChapterFactNeeds,
  buildFactsModel,
  buildSchemaFacts,
  buildSpecAuthorityMap,
  cleanPdfHeadingNoise,
  extractBillItemFacts,
  extractFacts,
  extractFactsWithLlm,
  extractLocalFactPool,
  extractPreciseFactsFromEvidence,
  extractProjectBasicFactsFromEvidence,
  extractStructuredFacts,
  extractStructuredTables,
  factNeedsCoveragePrompt,
  factsForChapterNeeds,
  fieldExtractionPattern,
  isValidProjectBasicFactValue,
  normalizeOcrFactText,
  normalizedFactValue,
  reliableFactForTarget,
  resolveChapterFactNeeds,
  sanitizeExtractedFacts,
  sanitizeFactPool,
  shouldRunLlmFactExtraction,
} from '@/services/document-workflow/factsModel';

const buildSemanticSimilarityMock = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<(leftText: string, rightText: string) => number>>());
const callDocumentLlmJsonMock = vi.hoisted(() => vi.fn<(system: string, prompt: string, options?: unknown) => Promise<unknown>>());
const getProjectRootMock = vi.hoisted(() => vi.fn<() => string>());
const getProjectKbRootMock = vi.hoisted(() => vi.fn<(root: string) => string>());
const xlsxReadFileMock = vi.hoisted(() => vi.fn<(file: string) => unknown>());
const xlsxSheetToJsonMock = vi.hoisted(() => vi.fn<(sheet: unknown, options?: unknown) => string[][]>());

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: buildSemanticSimilarityMock }));
vi.mock('@/services/document-workflow/llmClient', () => ({ callDocumentLlmJson: callDocumentLlmJsonMock }));
vi.mock('@/services/knowledge/kbService', () => ({ getProjectRoot: getProjectRootMock, getProjectKbRoot: getProjectKbRootMock }));
vi.mock('xlsx', () => ({ readFile: xlsxReadFileMock, utils: { sheet_to_json: xlsxSheetToJsonMock } }));

let projectRoot = '';
let kbRoot = '';

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-model-root-'));
  kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-model-kb-'));
  getProjectRootMock.mockReturnValue(projectRoot);
  getProjectKbRootMock.mockReturnValue(kbRoot);
  buildSemanticSimilarityMock.mockReset();
  buildSemanticSimilarityMock.mockResolvedValue(() => 0);
  callDocumentLlmJsonMock.mockReset();
  callDocumentLlmJsonMock.mockResolvedValue(undefined);
  xlsxReadFileMock.mockReset();
  xlsxSheetToJsonMock.mockReset();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(kbRoot, { recursive: true, force: true });
});

function evidenceItem(overrides: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'ch-1', filePath: '/data/招标文件.txt', score: 0.9, content: '项目名称：合肥市某区安置房项目', ...overrides };
}

function templateChapter(overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'ch-1', title: '工程概况', purpose: '说明项目概况', queries: [], requiredFacts: ['项目名称'], ...overrides };
}

function templateOf(chapters: DocumentTemplateChapter[] = [templateChapter()]): DocumentTemplate {
  return { id: 'tpl-1', name: '施工组织设计模板', description: '', category: 'document', outputTitle: '施工组织设计', chapters };
}

function specOf(overrides: Partial<AutoDocumentSpecPackage> = {}): AutoDocumentSpecPackage {
  return {
    id: 'spec-1',
    name: '施工组织设计',
    description: '',
    factFields: [{ id: 'project_name', name: '项目名称', type: 'auto', required: true, sourceRoleIds: [] }],
    chapterMode: 'fixed',
    chapterRules: [],
    dynamicChapterRule: { source: 'file_role' },
    gateRules: [],
    ...overrides,
  };
}

function factOf(overrides: Partial<DocumentFact> = {}): DocumentFact {
  return { key: '项目名称', value: '合肥市某区安置房项目', sourceFile: '/data/招标文件.txt', roleId: 'project_basic_fact', confidence: 0.9, ...overrides };
}

describe('extractFacts', () => {
  it('按 requiredFacts 提取并标注来源与角色', () => {
    const facts = extractFacts(templateOf(), [evidenceItem()]);
    expect(facts['项目名称']).toBe('项目名称：合肥市某区安置房项目（来源：/data/招标文件.txt，角色：未标注）');
  });

  it('有角色标注时来源包含角色', () => {
    const facts = extractFacts(templateOf(), [evidenceItem({ roleId: 'tender_document' })]);
    expect(facts['项目名称']).toContain('角色：tender_document');
  });

  it('spec.factFields 按 sourceRoleIds 过滤证据角色', () => {
    const spec = specOf({ factFields: [{ id: 'project_code', name: '项目编号', type: 'auto', required: false, sourceRoleIds: ['tender_document'] }] });
    const template = templateOf();
    const tender = evidenceItem({ roleId: 'tender_document', content: '项目编号：HF2024-001\n项目名称：合肥项目' });
    const boq = evidenceItem({ roleId: 'boq', filePath: '/data/清单.xlsx', content: '项目编号：HF2024-002' });
    const facts = extractFacts(template, [tender, boq], spec);
    expect(facts['项目编号']).toContain('HF2024-001');
    expect(facts['项目编号']).not.toContain('HF2024-002');
    expect(facts['项目名称']).toContain('合肥项目');
  });
});

describe('extractStructuredTables', () => {
  it('文本回退解析 | 分隔表格', () => {
    const tables = extractStructuredTables([evidenceItem({
      processingType: 'table',
      content: '名称|单位|数量\n钢筋|t|100\n水泥|t|200',
      sectionTitle: '工程量清单',
    })]);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      tableType: 'table',
      headers: ['名称', '单位', '数量'],
      rows: [['钢筋', 't', '100'], ['水泥', 't', '200']],
      sourceFile: '/data/招标文件.txt',
      sourceRange: '工程量清单',
    });
  });

  it('同 filePath 只解析一次', () => {
    const tables = extractStructuredTables([
      evidenceItem({ processingType: 'table', content: '名称|单位\n钢筋|t' }),
      evidenceItem({ processingType: 'table', content: '名称|单位\n水泥|t' }),
    ]);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.headers).toEqual(['名称', '单位']);
  });

  it('xlsx 文件走 XLSX 解析分支', () => {
    fs.writeFileSync(path.join(projectRoot, '清单.xlsx'), '');
    xlsxReadFileMock.mockReturnValue({
      SheetNames: ['Sheet1', 'EmptySheet'],
      Sheets: { Sheet1: { '!ref': 'A1:B3' }, EmptySheet: { '!ref': 'A1:A1' } },
    });
    xlsxSheetToJsonMock.mockImplementation((sheet: unknown) => {
      const ref = (sheet as { '!ref'?: string })['!ref'];
      return ref === 'A1:B3' ? [['名称', '单位'], ['钢筋', 't'], ['水泥', 't']] : [['']];
    });
    const tables = extractStructuredTables([evidenceItem({ filePath: '清单.xlsx', roleId: 'bill', processingType: 'bill_of_quantities' })]);
    expect(xlsxReadFileMock).toHaveBeenCalledWith(path.join(projectRoot, '清单.xlsx'), { cellDates: true, sheetStubs: false });
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      tableType: 'bill',
      sheet: 'Sheet1',
      headers: ['名称', '单位'],
      rows: [['钢筋', 't'], ['水泥', 't']],
      sourceFile: '清单.xlsx',
      sourceRange: 'A1:B3',
    });
  });

  it('非表格 processingType 的证据被过滤', () => {
    const tables = extractStructuredTables([evidenceItem({ processingType: 'reference', content: '名称|单位\n钢筋|t' })]);
    expect(tables).toHaveLength(0);
  });
});

describe('fieldExtractionPattern', () => {
  it('规模/工期字段使用长窗口跨逗号到句末', () => {
    const match = fieldExtractionPattern('建设规模').exec('建设规模：总占地面积约10970平方米，单体建筑面积28570.36平方米。计划工期：540日历天');
    expect(match?.[1]).toBe('总占地面积约10970平方米，单体建筑面积28570.36平方米');
  });

  it('普通字段短窗口在逗号截断', () => {
    const match = fieldExtractionPattern('质量标准').exec('质量标准：合格，符合国家验收规范');
    expect(match?.[1]).toBe('合格');
  });
});

describe('extractStructuredFacts', () => {
  it('正则通道生成结构化事实', () => {
    const facts = extractStructuredFacts([evidenceItem({ content: '计划工期：540日历天。质量目标：合格。' })], templateOf([templateChapter({ requiredFacts: ['计划工期'] })]));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ key: '计划工期', fieldId: '计划工期', fieldName: '计划工期', value: '540日历天', roleId: 'unknown', confidence: 0.9 });
  });

  it('PDF 标题标记与跨行空白清洗', () => {
    const facts = extractStructuredFacts([evidenceItem({ content: '建设规模：单体建筑面积28570.36平方\n\n### 米。' })], templateOf([templateChapter({ requiredFacts: ['建设规模'] })]));
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe('单体建筑面积28570.36平方米');
  });

  it('值内出现下一字段名时截断', () => {
    const facts = extractStructuredFacts(
      [evidenceItem({ content: '建设规模：总建筑面积28570.36平方米\n计划工期：540日历天' })],
      templateOf([templateChapter({ requiredFacts: ['建设规模', '计划工期'] })]),
    );
    expect(facts.map(item => item.value)).toEqual(['总建筑面积28570.36平方米', '540日历天']);
  });
});

describe('reliableFactForTarget', () => {
  const target = { id: '项目名称', name: '项目名称', required: true, sourceRoleIds: [] as string[], extractionHint: '' };

  it('值过短或超长低置信不可靠', () => {
    expect(reliableFactForTarget(factOf({ value: 'x' }), target)).toBe(false);
    expect(reliableFactForTarget(factOf({ value: '长'.repeat(230), confidence: 0.7 }), target)).toBe(false);
    expect(reliableFactForTarget(factOf({ value: '长'.repeat(230), confidence: 0.9 }), target)).toBe(true);
  });

  it('按角色区分置信度阈值', () => {
    expect(reliableFactForTarget(factOf({ confidence: 0.6 }), target)).toBe(true);
    expect(reliableFactForTarget(factOf({ roleId: 'other', confidence: 0.6 }), target)).toBe(false);
    expect(reliableFactForTarget(factOf({ roleId: 'other', confidence: 0.6, sourceRef: { filePath: '/data/x.txt', roleId: 'other' } }), target)).toBe(true);
  });

  it('identity 不匹配目标返回 false', () => {
    expect(reliableFactForTarget(factOf({ key: '质量标准', fieldName: '质量标准' }), target)).toBe(false);
  });
});

describe('shouldRunLlmFactExtraction', () => {
  it('无 required 目标时按高质量事实数判定', () => {
    const template = templateOf([templateChapter({ requiredFacts: [] })]);
    const fiveFacts = Array.from({ length: 5 }, () => factOf({ value: '合格' }));
    expect(shouldRunLlmFactExtraction(fiveFacts, template)).toBe(true);
    const twelveFacts = Array.from({ length: 12 }, () => factOf({ value: '合格' }));
    expect(shouldRunLlmFactExtraction(twelveFacts, template)).toBe(false);
  });

  it('有 required 目标时按覆盖率判定', () => {
    const template = templateOf([templateChapter({ requiredFacts: ['项目名称', '质量标准'] })]);
    expect(shouldRunLlmFactExtraction([factOf()], template)).toBe(true);
    expect(shouldRunLlmFactExtraction([factOf(), factOf({ key: '质量标准', value: '合格' })], template)).toBe(false);
  });
});

describe('extractFactsWithLlm', () => {
  it('空证据直接返回 skipped 阶段', async () => {
    const result = await extractFactsWithLlm([], '提示词', templateOf());
    expect(result.facts).toEqual([]);
    expect(result.stages[0]).toMatchObject({ type: 'fact_extraction', roleId: 'llm-json', status: 'skipped' });
    expect(callDocumentLlmJsonMock).not.toHaveBeenCalled();
  });

  it('LLM 结果按动态 schema 映射', async () => {
    const spec = specOf();
    const template = templateOf([templateChapter({ requiredFacts: [] })]);
    callDocumentLlmJsonMock.mockResolvedValue({ facts: [{ fieldId: 'project_name', key: '项目名称', value: '合肥市某项目', confidence: 0.7 }] });
    const result = await extractFactsWithLlm([evidenceItem({ content: '项目名称：合肥市某项目' })], '你是文档事实抽取器。', template, spec);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ key: '项目名称', fieldId: 'project_name', fieldName: '项目名称', value: '合肥市某项目', roleId: 'llm', confidence: 0.7 });
    expect(result.stages[0]!.status).toBe('success');
    expect(result.stages[0]!.message).toContain('1 条事实');
    const prompt = callDocumentLlmJsonMock.mock.calls[0]![1];
    expect(prompt).toContain('动态事实 schema：');
    expect(prompt).toContain('id=project_name name=项目名称');
  });

  it('LLM 无 facts 时返回 skipped', async () => {
    callDocumentLlmJsonMock.mockResolvedValue({ facts: [] });
    const result = await extractFactsWithLlm([evidenceItem()], '提示词', templateOf());
    expect(result.facts).toEqual([]);
    expect(result.stages[0]!.status).toBe('skipped');
  });

  it('LLM 未返回内容时返回 skipped', async () => {
    const result = await extractFactsWithLlm([evidenceItem()], '提示词', templateOf());
    expect(result.facts).toEqual([]);
    expect(result.stages[0]!.status).toBe('skipped');
  });
});

describe('文本清洗工具', () => {
  it('normalizedFactValue 统一工程度量口径', () => {
    expect(normalizedFactValue(' 总建筑面积 28570.36㎡ ')).toBe('总建筑面积28570.36m2');
    expect(normalizedFactValue(undefined)).toBe('');
  });

  it('cleanPdfHeadingNoise 移除 PDF 标题标记并重新闭合句子', () => {
    expect(cleanPdfHeadingNoise('28570.36平方\n\n### 米')).toBe('28570.36平方米');
    expect(cleanPdfHeadingNoise('正文＃＃＃说明')).toBe('正文说明');
  });

  it('normalizeOcrFactText 归一化空白与 OCR 拆词', () => {
    expect(normalizeOcrFactText('计划 工 期：540 日历天')).toBe('计划工期：540日历天');
    expect(normalizeOcrFactText('质量 标 准：达到 国家验收标准')).toBe('质量标准：达到国家验收标准');
    expect(normalizeOcrFactText('\u3000招标范围：施工总承包')).toBe('招标范围：施工总承包');
  });
});

describe('isValidProjectBasicFactValue', () => {
  it('空 fieldId 或超长值返回 false', () => {
    expect(isValidProjectBasicFactValue(undefined, '合格')).toBe(false);
    expect(isValidProjectBasicFactValue('project_name', 'x'.repeat(261))).toBe(false);
  });

  it('禁用词值返回 false', () => {
    expect(isValidProjectBasicFactValue('project_name', '评标委员会由五人组成')).toBe(false);
    expect(isValidProjectBasicFactValue('project_name', '投标人提供完整资料')).toBe(false);
  });

  it('schedule_requirement 需含工期数量', () => {
    expect(isValidProjectBasicFactValue('schedule_requirement', '540日历天')).toBe(true);
    expect(isValidProjectBasicFactValue('schedule_requirement', '按合同约定执行')).toBe(false);
  });

  it('quality_standard 需合格表述且不混入工期', () => {
    expect(isValidProjectBasicFactValue('quality_standard', '合格')).toBe(true);
    expect(isValidProjectBasicFactValue('quality_standard', '工程质量合格，工期540日历天')).toBe(false);
  });

  it('owner 与 project_code 分支', () => {
    expect(isValidProjectBasicFactValue('owner', '合肥市重点工程建设管理局')).toBe(true);
    expect(isValidProjectBasicFactValue('owner', '投标人')).toBe(false);
    expect(isValidProjectBasicFactValue('project_code', 'HF2024-001')).toBe(true);
    expect(isValidProjectBasicFactValue('project_code', '编号123')).toBe(false);
  });
});

describe('extractProjectBasicFactsFromEvidence', () => {
  it('多模式命中提取项目基本信息', () => {
    const content = [
      '项目名称：合肥市某区安置房项目。',
      '项目编号：HF2024-001。',
      '招标人：合肥市重点工程建设管理局。',
      '建设地点：合肥市蜀山区。',
      '建设规模：总建筑面积28570.36平方米。',
      '招标范围：施工总承包。',
      '计划工期：540日历天。',
      '质量标准：合格。',
      '合同估算价格：约12000万元。',
    ].join('\n');
    const facts = extractProjectBasicFactsFromEvidence([evidenceItem({ content })]);
    expect(facts).toHaveLength(9);
    expect(facts.find(item => item.fieldId === 'project_name')?.value).toBe('合肥市某区安置房项目');
    expect(facts.find(item => item.fieldId === 'project_scale')?.value).toBe('总建筑面积28570.36平方米');
    expect(facts.find(item => item.fieldId === 'schedule_requirement')?.value).toBe('540日历天');
    expect(facts.every(item => item.roleId === 'project_basic_fact' && item.confidence >= 0.82)).toBe(true);
  });

  it('目标性表述（拟建设）不捕获，确定口径捕获', () => {
    expect(extractProjectBasicFactsFromEvidence([evidenceItem({ content: '拟建设总建筑面积约5000㎡。' })])).toHaveLength(0);
    const facts = extractProjectBasicFactsFromEvidence([evidenceItem({ content: '总建筑面积约5000㎡' })]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ fieldId: 'project_scale', value: '总建筑面积约5000㎡' });
  });

  it('报价明细行单独跳过，其余行照常提取，同值去重', () => {
    const facts = extractProjectBasicFactsFromEvidence([evidenceItem({ content: '项目名称：合肥市项目。' })]);
    expect(facts).toHaveLength(1);
    // 商务行过滤按行生效：修复前 OCR 归一化把整文合并为单行，整行含商务词即整体跳过（全部事实丢失）
    const mixed = extractProjectBasicFactsFromEvidence([evidenceItem({ content: '项目名称：合肥市项目。\n报价明细：见清单附件。' })]);
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.value).toBe('合肥市项目');
    const dedup = extractProjectBasicFactsFromEvidence([
      evidenceItem({ content: '项目名称：合肥市项目。' }),
      evidenceItem({ content: '项目名称：合肥市项目。' }),
    ]);
    expect(dedup).toHaveLength(1);
  });

  it('多行无句号内容逐行提取，字段值不跨行吞并', () => {
    // 修复前整文合并单行后 project_name pattern 贪婪捕获“建设地点：…”污染项目名称值
    const facts = extractProjectBasicFactsFromEvidence([evidenceItem({ content: '项目名称：合肥市某区安置房项目\n建设地点：合肥市蜀山区' })]);
    expect(facts).toHaveLength(2);
    expect(facts.find(item => item.fieldId === 'project_name')?.value).toBe('合肥市某区安置房项目');
    expect(facts.find(item => item.fieldId === 'project_location')?.value).toBe('合肥市蜀山区');
  });
});

describe('extractPreciseFactsFromEvidence', () => {
  it('量化 token 提取为技术参数事实', () => {
    const facts = extractPreciseFactsFromEvidence([evidenceItem({ roleId: 'specification', content: '外墙保温采用60mm厚XPS板，抗压强度不小于200kPa。' })]);
    expect(facts).toHaveLength(2);
    expect(facts.every(item => item.fieldId === 'technical_parameter' && item.key === '精确参数')).toBe(true);
    expect(facts.map(item => item.value)).toEqual(['60mm', '200kPa']);
    expect(facts.every(item => item.roleId === 'specification' && item.confidence === 0.9)).toBe(true);
  });

  it('低分且来源无用的证据跳过', () => {
    const low = evidenceItem({ filePath: '/x/其余.txt', score: 0.5, content: '厚度60mm' });
    expect(extractPreciseFactsFromEvidence([low])).toHaveLength(0);
    expect(extractPreciseFactsFromEvidence([{ ...low, score: 0.8 }])).toHaveLength(1);
  });

  it('路径含 data 目录不再豁免低分证据（data 子串已收紧为 structured_data）', () => {
    // 修复前 sourceLooksUseful 裸子串 data 命中“/data/”路径，低分证据被误豁免
    expect(extractPreciseFactsFromEvidence([evidenceItem({ filePath: '/data/其余.txt', score: 0.5, content: '厚度60mm' })])).toHaveLength(0);
    // 结构化数据角色仍豁免
    expect(extractPreciseFactsFromEvidence([evidenceItem({ filePath: '/x/其余.txt', roleId: 'structured_data', score: 0.5, content: '厚度60mm' })])).toHaveLength(1);
  });

  it('同文件同 token 去重', () => {
    const facts = extractPreciseFactsFromEvidence([evidenceItem({ content: '厚度60mm，宽度60mm' })]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe('60mm');
  });
});

describe('buildSchemaFacts', () => {
  it('按 spec.factFields id 分组', () => {
    const spec = specOf({ factFields: [
      { id: 'project_name', name: '项目名称', type: 'auto', required: true },
      { id: 'schedule_requirement', name: '计划工期', type: 'auto', required: false },
    ] });
    const facts = [factOf(), factOf({ key: '项目名称2', fieldId: 'project_name', value: '别的项目' }), factOf({ key: '计划工期', value: '540日历天' })];
    const schemaFacts = buildSchemaFacts(facts, spec);
    expect(schemaFacts['project_name']).toHaveLength(2);
    expect(schemaFacts['schedule_requirement']).toHaveLength(1);
  });

  it('无 spec 返回空分组', () => {
    expect(buildSchemaFacts([factOf()], undefined)).toEqual({});
  });
});

describe('buildChapterFactNeeds', () => {
  it('template requiredFacts 与 sections 来源', () => {
    const needs = buildChapterFactNeeds({
      template: templateOf([templateChapter({ requiredFacts: ['项目名称'], sections: ['进度安排'] })]),
      chapter: templateChapter({ requiredFacts: ['项目名称'], sections: ['进度安排'] }),
    });
    const nameNeed = needs.find(item => item.label === '项目名称');
    expect(nameNeed).toMatchObject({ source: 'template', required: true });
    expect(nameNeed!.queries).toContain('项目名称');
    const sectionNeed = needs.find(item => item.label === '进度安排');
    expect(sectionNeed).toMatchObject({ source: 'section', required: false });
  });

  it('plan 来源', () => {
    const needs = buildChapterFactNeeds({
      template: templateOf([templateChapter({ requiredFacts: [] })]),
      chapter: templateChapter({ requiredFacts: [] }),
      plan: { requiredContents: ['施工部署'], evidenceNeeds: ['招标范围'] },
    });
    expect(needs.find(item => item.label === '施工部署')).toMatchObject({ source: 'plan', required: true });
    expect(needs.find(item => item.label === '招标范围')).toMatchObject({ source: 'plan', required: true });
  });

  it('spec chapterRules requiredFactIds 来源', () => {
    const spec = specOf({ chapterRules: [{ id: 'ch-1', title: '工程概况', required: true, order: 1, requiredFactIds: ['project_name'] }] });
    const needs = buildChapterFactNeeds({
      template: templateOf([templateChapter({ requiredFacts: [] })]),
      chapter: templateChapter({ requiredFacts: [] }),
      spec,
    });
    const specNeeds = needs.filter(item => item.label === '项目名称');
    expect(specNeeds).toHaveLength(1);
    expect(specNeeds[0]).toMatchObject({ source: 'spec', fieldId: 'project_name', required: true });
  });

  it('profile/requirement/prompt 来源且 do_not_use 字段被排除', () => {
    // chapterContext 含 requiredFacts，模板声明的“计划工期”直接命中 profile 字段“周期要求”（aliases 检索增强）
    const needs = buildChapterFactNeeds({
      template: templateOf([templateChapter({ title: '工程概况', requiredFacts: ['计划工期'] })]),
      chapter: templateChapter({ title: '工程概况', requiredFacts: ['计划工期'] }),
      requirement: '质量要求必须达到合格',
      promptTexts: '计划工期必须明确写入正文，报价必须明确',
    });
    expect(needs.some(item => item.label === '周期要求' && item.source === 'profile' && item.required)).toBe(true);
    expect(needs.some(item => item.label === '质量要求' && item.source === 'requirement' && item.required)).toBe(true);
    expect(needs.some(item => item.label === '商务数据')).toBe(false);
  });
});

describe('resolveChapterFactNeeds / factsForChapterNeeds', () => {
  const emptyModel = (reliableFacts: DocumentFact[] = []): DocumentFactsModel => ({
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [], drawings: [], bills: [], preciseFacts: [], rules: [], specifications: [],
    schemaFacts: {}, factIndex: { reliableFacts, parameterFacts: [], tableFacts: [], drawingFacts: [], billFacts: [], diagnostics: [] }, missing: [], conflicts: [],
  });

  it('三状态判定：satisfied/low_confidence/证据兜底/missing', () => {
    const needs = [
      { id: 'n1', label: '项目名称', category: 'identity', required: true, queries: ['项目名称'], source: 'template' as const },
      { id: 'n2', label: '质量标准', category: 'quality', required: true, queries: ['质量标准'], source: 'template' as const },
      { id: 'n3', label: '招标范围', category: 'scope', required: true, queries: ['招标范围'], source: 'template' as const },
      { id: 'n4', label: '资质要求', category: 'compliance', required: true, queries: ['资质要求'], source: 'template' as const },
    ];
    const model = emptyModel([factOf(), factOf({ key: '质量标准', value: '合格', confidence: 0.3 })]);
    const resolved = resolveChapterFactNeeds({ needs, factsModel: model, evidence: [evidenceItem({ content: '招标范围：施工总承包' })] });
    expect(resolved.map(item => item.status)).toEqual(['satisfied', 'low_confidence', 'satisfied', 'missing']);
    expect(resolved[2]!.evidence).toHaveLength(1);
    expect(resolved[2]!.facts).toHaveLength(0);
  });

  it('factsForChapterNeeds 去重合并', () => {
    const needs = [
      { id: 'n1', label: '项目名称', category: 'identity', required: true, queries: ['项目名称'], source: 'template' as const },
      { id: 'n2', label: '对象名称', category: 'identity', required: true, queries: ['项目名称'], source: 'template' as const },
    ];
    const resolved = resolveChapterFactNeeds({ needs, factsModel: emptyModel([factOf()]), evidence: [] });
    expect(resolved.every(item => item.status === 'satisfied')).toBe(true);
    expect(factsForChapterNeeds(resolved)).toHaveLength(1);
  });

  it('D2：同置信度下清单来源事实优先于图纸来源', () => {
    // 历史排序只看 confidence：图纸事实数量级碾压时清单数据被淹没（图纸 4207 chunks vs 清单 657），
    // 正文大量「按设计图纸执行」式概括话术；清单来源 +0.05 温和偏移后同档竞争清单先呈现
    const needs = [
      { id: 'n1', label: '钢筋规格', category: 'parameter', required: true, queries: ['钢筋规格'], source: 'template' as const },
    ];
    const drawingFact = factOf({ key: '钢筋规格', value: 'HPB300直径8mm', sourceFile: '/x/结构设计图.dwg', processingType: 'drawing', roleId: 'drawing', confidence: 0.8 });
    const billFact = factOf({ key: '钢筋规格', value: 'HPB300直径8mm钢筋', sourceFile: '/x/工程量清单.xlsx', processingType: 'table', roleId: 'bill', confidence: 0.8 });
    const resolved = resolveChapterFactNeeds({ needs, factsModel: emptyModel([drawingFact, billFact]), evidence: [] });
    expect(resolved[0]!.facts).toHaveLength(2);
    expect(resolved[0]!.facts[0]!.sourceFile).toContain('清单');
    expect(resolved[0]!.facts[1]!.sourceFile).toContain('设计图');
  });
});

describe('factNeedsCoveragePrompt', () => {
  it('渲染必须/相关与状态', () => {
    const resolved = [
      { need: { id: 'n1', label: '项目名称', category: 'identity', required: true, queries: ['项目名称'], source: 'template' as const }, facts: [factOf()], status: 'satisfied' as const, evidence: [] },
      { need: { id: 'n2', label: '招标范围', category: 'scope', required: false, queries: ['招标范围'], source: 'template' as const }, facts: [], status: 'missing' as const, evidence: [evidenceItem({ content: '招标范围：施工总承包' })] },
    ];
    const prompt = factNeedsCoveragePrompt(resolved);
    expect(prompt).toContain('事实需求覆盖卡片：');
    expect(prompt).toContain('- 必须｜项目名称｜satisfied：项目名称=合肥市某区安置房项目（招标文件.txt）');
    expect(prompt).toContain('- 相关｜招标范围｜missing：证据片段：招标范围：施工总承包（招标文件.txt）');
  });

  it('空数组返回空串', () => {
    expect(factNeedsCoveragePrompt([])).toBe('');
  });
});

describe('buildFactsModel', () => {
  it('splitMixedScaleFacts 拆分混合口径建设规模', async () => {
    const model = await buildFactsModel([factOf({
      key: '建设规模',
      fieldName: '建设规模',
      fieldId: 'project_scale',
      value: '项目总占地面积约10970平方米，单体建筑面积28570.36平方米',
    })]);
    const siteFact = model.project.find(item => item.key === '总占地面积');
    const buildFact = model.project.find(item => item.key === '单体建筑面积');
    expect(siteFact).toMatchObject({ fieldId: undefined, value: '总占地面积约10970平方米' });
    expect(buildFact).toMatchObject({ fieldId: 'project_scale', value: '单体建筑面积28570.36平方米' });
  });

  it('按口径分组并构建事实索引', async () => {
    const facts = [
      factOf({ key: '计划工期', value: '540日历天', sourceFile: '/x/a.txt', processingType: 'reference', roleId: 'tender' }),
      factOf({ key: '质量标准', value: '合格', sourceFile: '/x/b.txt', processingType: 'reference', roleId: 'tender' }),
      factOf({ key: '安全目标', value: '零死亡', sourceFile: '/x/c.txt', processingType: 'reference', roleId: 'tender' }),
      factOf({ key: '劳动力计划', value: '120人', sourceFile: '/x/d.txt', processingType: 'reference', roleId: 'tender' }),
      // 暂列金额/单价等商务词命中 COMMON_FORBIDDEN_PATTERNS 会从 reliableFacts 过滤，清单分组用非禁用语料
      factOf({ key: '工程量清单', value: '钢筋120t', sourceFile: '/x/清单.xlsx', processingType: 'table', roleId: 'bill' }),
      factOf({ key: '管径', value: 'DN100', sourceFile: '/x/f.txt', processingType: 'drawing', roleId: 'drawing' }),
      factOf({ key: '精确参数', fieldName: '技术参数', value: '60mm', sourceFile: '/x/g.txt', processingType: 'specification', roleId: 'spec' }),
    ];
    const model = await buildFactsModel(facts);
    expect(model.schedule).toHaveLength(1);
    expect(model.quality).toHaveLength(1);
    expect(model.safety).toHaveLength(1);
    expect(model.resources).toHaveLength(1);
    expect(model.drawings).toHaveLength(1);
    expect(model.bills).toHaveLength(1);
    expect(model.preciseFacts.map(item => item.value)).toContain('60mm');
    expect(model.factIndex.tableFacts.map(item => item.key)).toContain('工程量清单');
    expect(model.factIndex.drawingFacts.map(item => item.key)).toContain('管径');
    expect(model.factIndex.parameterFacts.map(item => item.key)).toContain('计划工期');
  });

  it('D3：纯文本类尺寸/管径/做法不进图纸池（只保留真实图纸来源）', async () => {
    // 历史口径 /设计|尺寸|标高|管径|做法/ 把说明文件里的尺寸描述也算入图纸，图纸池被文本灌水，
    // 清单 vs 图纸优先级失真（用户确认：清单精度更高，图纸仅兑底）；新口径只认 processingType 或图纸类来源词
    const facts = [
      factOf({ key: '管径', value: 'DN100', sourceFile: '/x/说明.txt', processingType: 'reference', roleId: 'spec' }),
      factOf({ key: '做法', value: '水泥砂浆抹灰墙面', sourceFile: '/x/g.txt', processingType: 'reference', roleId: 'spec' }),
      factOf({ key: '尺寸', value: '60mm', sourceFile: '/x/f.txt', processingType: 'drawing', roleId: 'drawing' }),
    ];
    const model = await buildFactsModel(facts);
    expect(model.factIndex.drawingFacts.map(item => item.key)).toEqual(['尺寸']);
  });

  it('conflicts 冲突检测与 missing 去重', async () => {
    const facts = [
      factOf({ key: '计划工期', value: '540日历天', sourceFile: '/data/工期A.txt' }),
      factOf({ key: '计划工期', value: '600日历天', sourceFile: '/data/工期B.txt' }),
    ];
    const model = await buildFactsModel(facts, [], ['事实A', '事实A', '事实B']);
    expect(model.conflicts).toHaveLength(1);
    expect(model.conflicts[0]).toContain('事实冲突：计划工期');
    expect(model.conflicts[0]).toContain('540日历天');
    expect(model.conflicts[0]).toContain('600日历天');
    expect(model.missing).toEqual(['事实A', '事实B']);
  });

  it('无 spec 时 conflictKeys 由事实集合推导且程序性值经语义复核', async () => {
    // 程序性词面特征值（联系人/电话）走 bge 语义复核，mock 恒零 → 不过滤，参与冲突判定
    const model = await buildFactsModel([
      factOf({ key: '项目名称', value: '联系人：张三，电话：13800000000', sourceFile: '/x/a.txt' }),
      factOf({ key: '项目名称', value: '联系人：李四，电话：13900000000', sourceFile: '/x/b.txt' }),
    ]);
    expect(model.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(model.conflicts[0]).toContain('事实冲突：项目名称');
    // 程序性候选值 vs PROCEDURAL_VALUE_PROTOTYPES（8 条原型）
    const proceduralCall = buildSemanticSimilarityMock.mock.calls[0];
    expect(proceduralCall).toBeTruthy();
    expect(proceduralCall![0]).toHaveLength(2);
    expect(proceduralCall![1]).toHaveLength(8);
  });
});

describe('sanitizeExtractedFacts（1.1 事实净化门）', () => {
  const stats = () => ({ truncated: 0, dropped: 0, repaired: 0 });

  it('表格碎片与页码从污染点截断并保留前缀', () => {
    const s = stats();
    const facts = [
      factOf({ key: '工程名称', fieldName: '工程名称', value: '土建与装饰工程|||||标段：|||||第46页共47页' }),
      factOf({ key: '建设地点', fieldName: '建设地点', value: '合肥市经开区第46页共47页' }),
    ];
    const result = sanitizeExtractedFacts(facts, [], s);
    expect(result.map(item => item.value)).toEqual(['土建与装饰工程', '合肥市经开区']);
    expect(s).toMatchObject({ truncated: 2, dropped: 0, repaired: 0 });
  });

  it('标题标记起头的叙述原文直接丢弃', () => {
    const s = stats();
    const result = sanitizeExtractedFacts([
      factOf({ key: '质量目标', fieldName: '质量目标', value: '### 1.1项目概况与招标范围：本项目位于合肥市' }),
    ], [], s);
    expect(result).toHaveLength(0);
    expect(s.dropped).toBe(1);
  });

  it('截断后残余不足 2 字符丢弃', () => {
    const s = stats();
    const result = sanitizeExtractedFacts([factOf({ key: '工程名称', value: '甲|第46页共47页' })], [], s);
    expect(result).toHaveLength(0);
    expect(s.dropped).toBe(1);
  });

  it('非白名单字段值长 >120 字符的叙述段拒收，长文本白名单字段放行', () => {
    const s = stats();
    const result = sanitizeExtractedFacts([
      factOf({ key: '质量目标', fieldName: '质量目标', value: '优'.repeat(150) }),
      factOf({ key: '建设规模', fieldName: '建设规模', fieldId: 'project_scale', value: '总'.repeat(150) }),
    ], [], s);
    expect(result).toHaveLength(1);
    expect(result[0]!.fieldId).toBe('project_scale');
    expect(s.dropped).toBe(1);
  });

  it('编号截断回源补全：证据标签语境存在更长完整编号时取完整值', () => {
    const s = stats();
    const evidence = [evidenceItem({ content: '项目编号：2026AFAGZ50906\n招标人：合肥市某局' })];
    const result = sanitizeExtractedFacts([
      factOf({ key: '项目编号', fieldName: '项目编号', fieldId: 'project_code', value: '2026AF' }),
    ], evidence, s);
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe('2026AFAGZ50906');
    expect(s.repaired).toBe(1);
  });

  it('编号跨行截断场景回源（PDF 编号中间换行）', () => {
    const s = stats();
    const evidence = [evidenceItem({ content: '项目编号：2026AF\nAGZ50906' })];
    const result = sanitizeExtractedFacts([
      factOf({ key: '项目编号', fieldId: 'project_code', value: '2026AF' }),
    ], evidence, s);
    expect(result[0]!.value).toBe('2026AFAGZ50906');
    expect(s.repaired).toBe(1);
  });

  it('编号无更长候选时保持原值，编号含非法字符丢弃', () => {
    const s = stats();
    const result = sanitizeExtractedFacts([
      factOf({ key: '项目编号', fieldId: 'project_code', value: '2026AF' }),
      factOf({ key: '标段编号', value: '2026AF：标段' }),
    ], [evidenceItem({ content: '招标人：合肥市某局' })], s);
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe('2026AF');
    expect(s).toMatchObject({ dropped: 1, repaired: 0 });
  });

  it('干净事实原样保留且计数为零', () => {
    const s = stats();
    const facts = [factOf(), factOf({ key: '质量标准', value: '合格' })];
    const result = sanitizeExtractedFacts(facts, [], s);
    expect(result).toEqual(facts);
    expect(s).toMatchObject({ truncated: 0, dropped: 0, repaired: 0 });
  });
});

describe('extractLocalFactPool 净化门接线', () => {
  afterEach(() => {
    delete process.env.DOCUMENT_FACT_SANITIZE;
  });

  it('默认开启：项目编号截断值回源补全，计数进 diagnostics.factSanitize', () => {
    const diagnostics = {} as unknown as DocumentGenerationDiagnostics;
    const pool = extractLocalFactPool({
      evidence: [evidenceItem({ content: '项目编号：2026AF\n项目编号：2026AFAGZ50906。' })],
      template: templateOf(),
      diagnostics,
    });
    const codes = pool.projectBasicFacts.filter(item => item.fieldId === 'project_code').map(item => item.value);
    expect(codes).toEqual(['2026AFAGZ50906', '2026AFAGZ50906']);
    expect(pool.factSanitize.repaired).toBe(1);
    expect(diagnostics.factSanitize).toMatchObject({ repaired: 1 });
  });

  it('env DOCUMENT_FACT_SANITIZE=0 回退直通', () => {
    process.env.DOCUMENT_FACT_SANITIZE = '0';
    const pool = extractLocalFactPool({
      evidence: [evidenceItem({ content: '项目编号：2026AF\n项目编号：2026AFAGZ50906。' })],
      template: templateOf(),
    });
    const codes = pool.projectBasicFacts.filter(item => item.fieldId === 'project_code').map(item => item.value);
    expect(codes).toEqual(['2026AF', '2026AFAGZ50906']);
    expect(pool.factSanitize).toMatchObject({ truncated: 0, dropped: 0, repaired: 0 });
  });
});

describe('extractBillItemFacts（F4 清单行级事实）', () => {
  /** 15 列偏移清单表：名称/特征/单位/工程量列全部不在历史硬编码列位 */
  function offset15Table(): StructuredTableFact {
    return {
      tableType: 'bill',
      headers: ['序号', '项目编码', '', '', '项目名称', '项目特征描述', '', '', '', '计量单位', '', '', '工程量', '', ''],
      rows: [
        ['1', '010101001001', '', '', '垫层', '1.混凝土种类:商品混凝土；2.混凝土强度等级:C15', '', '', '', 'm3', '', '', '125.80', '', ''],
        ['2', '010502001001', '', '', '矩形柱', '1.混凝土种类:商品混凝土；2.混凝土强度等级:C35', '', '', '', 'm3', '', '', '86.40', '', ''],
      ],
      sourceFile: '清单.xls',
    };
  }

  it('15 列偏移表：按语义列定位提取名称/特征/工程量三元组', () => {
    const facts = extractBillItemFacts([offset15Table()]);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({
      key: '清单条目：垫层',
      fieldId: 'bill_item',
      value: '1.混凝土种类:商品混凝土；2.混凝土强度等级:C15｜工程量：125.80m3',
      processingType: 'bill_of_quantities',
    });
    expect(facts[1]?.key).toBe('清单条目：矩形柱');
    expect(facts[1]?.value).toContain('C35');
  });

  it('序号非纯整数的行（分部小计/合计行）不入事实池', () => {
    const table = offset15Table();
    table.rows = [
      ...table.rows,
      ['分部小计', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['', '合计', '', '', '合计', '本页合计', '', '', '', '', '', '', '', '', ''],
    ];
    const facts = extractBillItemFacts([table]);
    expect(facts).toHaveLength(2);
  });

  it('项目名称或项目特征描述为空的行不入池', () => {
    const table = offset15Table();
    table.rows = [
      ['3', '010101003001', '', '', '', '1.混凝土强度等级:C15', '', '', '', 'm3', '', '', '10', '', ''],
      ['4', '010101004001', '', '', '基础', '', '', '', '', 'm3', '', '', '20', '', ''],
    ];
    const facts = extractBillItemFacts([table]);
    expect(facts).toHaveLength(0);
  });

  it('无序号列的表（非清单类表）：不按序号过滤，名称+特征齐全即收录', () => {
    const table: StructuredTableFact = {
      tableType: 'material',
      headers: ['项目名称', '项目特征描述', '计量单位', '工程量'],
      rows: [
        ['SBS防水卷材', '1.厚度:4mm', '㎡', '500'],
        ['镀锌钢管', '1.规格:DN100', 'm', '120'],
      ],
      sourceFile: '材料表.csv',
    };
    const facts = extractBillItemFacts([table]);
    expect(facts).toHaveLength(2);
    expect(facts[0]?.value).toBe('1.厚度:4mm｜工程量：500㎡');
  });

  it('表头噪声行（合计/汇总行被当数据行）由 HEADER_NOISE 过滤', () => {
    const table = offset15Table();
    table.rows = [['5', '', '', '', '合计', '汇总本表工程量', '', '', '', '', '', '', '', '', '']];
    const facts = extractBillItemFacts([table]);
    expect(facts).toHaveLength(0);
  });

  it('特征描述超长截断到 160 字符', () => {
    const table = offset15Table();
    table.rows = [['9', '010101009001', '', '', '直形墙', `1.混凝土强度等级:C30；2.${'长描述'.repeat(60)}`, '', '', '', 'm3', '', '', '30', '', '']];
    const facts = extractBillItemFacts([table]);
    expect(facts).toHaveLength(1);
    const featurePart = (facts[0]?.value || '').replace(/｜工程量：.+$/u, '');
    expect(featurePart.length).toBeLessThanOrEqual(160);
  });
});

describe('buildSpecAuthorityMap（F11 规格-部位权威映射）', () => {
  function billFact(name: string, feature: string, quantity = '125.80m3'): DocumentFact {
    return {
      key: `清单条目：${name}`,
      fieldName: '清单条目',
      fieldId: 'bill_item',
      value: `${feature}｜工程量：${quantity}`,
      sourceFile: '清单.xls',
      roleId: 'bill_of_quantities',
      processingType: 'bill_of_quantities',
      confidence: 0.92,
    };
  }

  it('多规格按部位聚合：垫层 C15/基础 C30/矩形柱 C35 → 混凝土强度等级 3 placements', () => {
    const map = buildSpecAuthorityMap([
      billFact('垫层', '1.混凝土种类:商品混凝土；2.混凝土强度等级:C15'),
      billFact('基础', '1.混凝土种类:商品混凝土；2.混凝土强度等级:C30'),
      billFact('矩形柱', '1.混凝土种类:商品混凝土；2.混凝土强度等级:C35'),
    ]);
    expect(map['混凝土强度等级']).toHaveLength(3);
    expect(map['混凝土强度等级']).toMatchObject([
      { location: '垫层', spec: 'C15', quantity: '125.80m3' },
      { location: '基础', spec: 'C30' },
      { location: '矩形柱', spec: 'C35' },
    ]);
  });

  it('同部位同规格去重（同名条目多行合并为一条 placement）', () => {
    const map = buildSpecAuthorityMap([
      billFact('垫层', '2.混凝土强度等级:C15', '60m3'),
      billFact('垫层', '2.混凝土强度等级:C15', '40m3'),
    ]);
    expect(map['混凝土强度等级']).toHaveLength(1);
  });

  it('多维度分句：混凝土种类与强度等级各成一维', () => {
    const map = buildSpecAuthorityMap([
      billFact('垫层', '1.混凝土种类:商品混凝土；2.混凝土强度等级:C15'),
    ]);
    expect(map['混凝土强度等级']?.[0]?.spec).toBe('C15');
    expect(map['混凝土种类']?.[0]?.spec).toBe('商品混凝土');
  });

  it('分句序号前缀（「1.」「2、」）剥离后标签仍命中', () => {
    const map = buildSpecAuthorityMap([
      billFact('垫层', '1.垫层材料种类:碎石；2、混凝土强度等级:C15'),
    ]);
    expect(map['混凝土强度等级']?.[0]?.spec).toBe('C15');
    expect(map['垫层材料种类']?.[0]?.spec).toBe('碎石');
  });

  it('无分句结构兜底：特征整体含规格 token 时按 token 归维', () => {
    const map = buildSpecAuthorityMap([
      billFact('垫层', 'C15商品混凝土'),
    ]);
    expect(map['混凝土强度等级']?.[0]).toMatchObject({ location: '垫层', spec: 'C15' });
  });

  it('厚度 token 归「厚度规格」维度', () => {
    const map = buildSpecAuthorityMap([
      billFact('垫层', '4mm厚SBS防水卷材'),
    ]);
    expect(map['厚度规格']?.[0]?.spec).toBe('4mm');
  });

  it('4.19.7 回归：非维度标签值含 mm/MU token 按 token 类型归维，不混入混凝土强度等级维度', () => {
    // 丰乐镇第三轮验收：「有梁板」条目特征无标签分句（如「板厚120mm」）时，旧逻辑把
    // 120mm 归入「混凝土强度等级」维度 → F14 按维度首 placement 的 C 标号 pattern 扫描
    // 「有梁板」附近正文 → C30 被误判与权威 120mm 不一致（跨类型误比对）
    const map = buildSpecAuthorityMap([
      billFact('垫层', '2.混凝土强度等级:C20'),
      billFact('有梁板', '板厚120mm'),
      billFact('砌筑渠道', 'MU10标准砖'),
    ]);
    expect(map['混凝土强度等级']?.map(item => item.spec)).toEqual(['C20']);
    expect(map['厚度规格']?.[0]).toMatchObject({ location: '有梁板', spec: '120mm' });
    expect(map['砌块强度等级']?.[0]?.spec).toBe('MU10');
  });

  it('无规格 token 的事实（土壤类别）→ 空 map', () => {
    const map = buildSpecAuthorityMap([
      billFact('挖一般土方', '1.土壤类别:三类土'),
    ]);
    expect(map).toEqual({});
  });

  it('标签命中维度但值非规格 token（如「商品混凝土」）→ 按标签归维，不产生 token 兜底重复', () => {
    const map = buildSpecAuthorityMap([
      billFact('垫层', '1.混凝土种类:商品混凝土'),
    ]);
    expect(map['混凝土种类']).toHaveLength(1);
    // matched=true 后不再走 token 兜底，「混凝土」不含 C/M/P token，无额外维度
    expect(Object.keys(map)).toEqual(['混凝土种类']);
  });

  it('规格值尾部标点清洗（「C30。」尾随句号）', () => {
    const map = buildSpecAuthorityMap([
      billFact('基础', '2.混凝土强度等级:C30。'),
    ]);
    expect(map['混凝土强度等级']?.[0]?.spec).toBe('C30');
  });

  it('空事实列表 → 空 map', () => {
    expect(buildSpecAuthorityMap([])).toEqual({});
  });
});

describe('sanitizeFactPool（P3.2 乱码过滤+项目范围隔离）', () => {
  it('乱码事实丢弃：CJK 扩展区字符与表格单元格引用噪声', () => {
    const mojibake = factOf({ key: '招标范围', value: '帉䝷搌陓笍免鬐' });
    const cellNoise = factOf({ key: '图纸目录', value: 'R6C3COL3：上海开艺设计集团有限公司' });
    const normal = factOf({ key: '质量标准', value: '工程质量符合国家验收规范合格标准' });
    expect(sanitizeFactPool([mojibake, cellNoise, normal])).toEqual([normal]);
  });

  it('项目名称候选跨项目串染过滤：舒城项目事实丢弃、当前项目保留', () => {
    const current = factOf({ key: '项目名称', fieldId: 'project_name', value: '2026年度丰乐镇20个美丽宜居自然村建设项目' });
    const foreign = factOf({ key: '项目名称候选', value: '舒城县城镇功能活力品质提升一期项目（一标）——公共广场空间改造等提升工程' });
    const location = factOf({ key: '建设地点', value: '丰乐镇境内各自然村' });
    const result = sanitizeFactPool([current, foreign, location]);
    expect(result.map(fact => fact.key)).toEqual(['项目名称', '建设地点']);
  });

  it('招标范围多项目段隔离：仅保留当前项目段', () => {
    const current = factOf({ key: '项目名称', fieldId: 'project_name', value: '2026年度丰乐镇20个美丽宜居自然村建设项目' });
    const scope = factOf({ key: '招标范围', value: '包括但不限于雨污水管网铺设、道路硬化。舒城县城镇功能活力提升项目招标范围包括土方工程、道路工程。' });
    const result = sanitizeFactPool([current, scope]);
    const kept = result.find(fact => fact.key === '招标范围');
    expect(kept?.value).toContain('雨污水管网铺设');
    expect(kept?.value).not.toContain('道路工程');
  });

  it('无项目名称事实时仅乱码过滤（不误杀跨项目候选）', () => {
    const foreign = factOf({ key: '项目名称候选', value: '舒城县城镇功能活力品质提升一期项目' });
    expect(sanitizeFactPool([foreign]).length).toBe(1);
  });
});
