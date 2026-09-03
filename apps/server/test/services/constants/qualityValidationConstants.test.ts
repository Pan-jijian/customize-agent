import { describe, expect, it } from 'vitest';
import type { GateRuleEvaluator } from '@/services/document-core/autoDocumentSpecTypes';
import type { DocumentDraftChapter, DocumentFact, DocumentFactsModel, PromptBinding } from '@/services/document-workflow/types';
import type { SpecGateRuleContext } from '@/services/types/qualityValidationTypes';
import {
  CHAPTER_HEADING_RE,
  DOCUMENT_BASIC_INFO_BLOCK_RE,
  DOCUMENT_BASIC_INFO_FIELDS,
  DOCUMENT_BASIC_INFO_TABLE_RE,
  EXPORT_BLOCKING_ISSUE_RE,
  EXPORT_GATE_PRECISION_ISSUE_RE,
  EXPORT_GATE_PROJECT_CONTAMINATION_RE,
  FALLBACK_GATE_EVALUATORS,
  FORMAL_PLACEHOLDER_PATTERNS,
  LINE_SPLIT_RE,
  MARKDOWN_IMAGE_RE,
  MARKDOWN_SECTION_HEADING_RE,
  MARKDOWN_TABLE_BLOCK_SPLIT_RE,
  MARKDOWN_TABLE_DIVIDER_RE,
  MARKDOWN_TABLE_ROW_RE,
  MARKDOWN_TOP_HEADING_RE,
  NON_BLANK_RE,
  PRECISE_FACT_MIN_TOKEN_COUNT,
  PRECISE_FACT_MIN_USAGE_RATE,
  PRECISE_FACT_SOURCE_RE,
  PRECISE_FACT_TOKEN_RE,
  PROMPT_EXAMPLE_BLOCK_RE,
  QUALITY_SEVERITY_RULES,
  SPEC_GATE_RULE_HANDLERS,
  STRUCTURED_DATA_CONTENT_RE,
  SPECIFICATION_CONTENT_RE,
  TOC_BLOCK_RE,
  TOC_INDENTED_SECTION_LINE_RE,
  TOC_SECTION_LINE_RE,
  WHITESPACE_RE,
} from '@/services/constants/qualityValidationConstants';

describe('导出阻断类正则', () => {
  it('EXPORT_BLOCKING_ISSUE_RE 命中典型阻断问题', () => {
    expect(EXPORT_BLOCKING_ISSUE_RE.test('出现禁用文本：请补充')).toBe(true);
    expect(EXPORT_BLOCKING_ISSUE_RE.test('章节生成失败，请重试')).toBe(true);
    expect(EXPORT_BLOCKING_ISSUE_RE.test('空小节：1.2 无内容')).toBe(true);
    expect(EXPORT_BLOCKING_ISSUE_RE.test('文档质量基准评分未达标')).toBe(true);
  });

  it('EXPORT_BLOCKING_ISSUE_RE 不命中正常文本', () => {
    expect(EXPORT_BLOCKING_ISSUE_RE.test('本章内容完整，通过校验')).toBe(false);
  });

  it('EXPORT_GATE_PRECISION_ISSUE_RE 只命中精确参数问题', () => {
    expect(EXPORT_GATE_PRECISION_ISSUE_RE.test('可靠精确参数使用不足')).toBe(true);
    expect(EXPORT_GATE_PRECISION_ISSUE_RE.test('章节缺少证据')).toBe(false);
  });

  it('EXPORT_GATE_PROJECT_CONTAMINATION_RE 命中污染与冲突', () => {
    expect(EXPORT_GATE_PROJECT_CONTAMINATION_RE.test('其他对象名称混入')).toBe(true);
    expect(EXPORT_GATE_PROJECT_CONTAMINATION_RE.test('文档编号错误')).toBe(true);
    expect(EXPORT_GATE_PROJECT_CONTAMINATION_RE.test('事实一致性冲突')).toBe(true);
    expect(EXPORT_GATE_PROJECT_CONTAMINATION_RE.test('正文疑似混入')).toBe(true);
    expect(EXPORT_GATE_PROJECT_CONTAMINATION_RE.test('质量良好')).toBe(false);
  });
});

describe('QUALITY_SEVERITY_RULES', () => {
  it('按顺序命中阻断类', () => {
    const rule = QUALITY_SEVERITY_RULES.find(r => r.pattern.test('章节生成失败'));
    expect(rule?.severity).toBe('blocking');
  });

  it('按顺序命中重要类', () => {
    const rule = QUALITY_SEVERITY_RULES.find(r => r.pattern.test('量化参数密度不足'));
    expect(rule?.severity).toBe('important');
  });

  it('未命中返回 undefined', () => {
    const rule = QUALITY_SEVERITY_RULES.find(r => r.pattern.test('完全无关的内容'));
    expect(rule).toBeUndefined();
  });
});

describe('FALLBACK_GATE_EVALUATORS', () => {
  it('required_fact 映射 fact exists', () => {
    expect(FALLBACK_GATE_EVALUATORS.required_fact({ target: '工期' } as never)).toEqual({ subject: 'fact', operator: 'exists', target: '工期' });
  });

  it('required_chapter 映射 chapter exists', () => {
    expect(FALLBACK_GATE_EVALUATORS.required_chapter({ target: '第一章' } as never)).toEqual({ subject: 'chapter', operator: 'exists', target: '第一章' });
  });

  it('required_file_role / required_prompt_role 映射 exists', () => {
    expect(FALLBACK_GATE_EVALUATORS.required_file_role({ target: '图纸' } as never)).toEqual({ subject: 'file_role', operator: 'exists', target: '图纸' });
    expect(FALLBACK_GATE_EVALUATORS.required_prompt_role({ target: '工程师' } as never)).toEqual({ subject: 'prompt_role', operator: 'exists', target: '工程师' });
  });

  it('source_required 映射 all_have_source', () => {
    expect(FALLBACK_GATE_EVALUATORS.source_required({} as never)).toEqual({ subject: 'source', operator: 'all_have_source' });
  });

  it('forbidden_text 映射 document not_contains', () => {
    expect(FALLBACK_GATE_EVALUATORS.forbidden_text({ value: '请补充' } as never)).toEqual({ subject: 'document', operator: 'not_contains', value: '请补充' });
  });

  it('min_chapter_length 映射 min_length 并解析数值', () => {
    expect(FALLBACK_GATE_EVALUATORS.min_chapter_length({ target: '章', value: '500' } as never)).toEqual({ subject: 'chapter', operator: 'min_length', target: '章', min: 500 });
    expect(FALLBACK_GATE_EVALUATORS.min_chapter_length({ target: '章', value: 'abc' } as never)).toEqual({ subject: 'chapter', operator: 'min_length', target: '章', min: undefined });
  });

  it('table_required 映射 table min_count 1', () => {
    expect(FALLBACK_GATE_EVALUATORS.table_required({} as never)).toEqual({ subject: 'table', operator: 'min_count', min: 1 });
  });
});

function makeContext(evaluator: GateRuleEvaluator, overrides: Partial<SpecGateRuleContext> = {}): SpecGateRuleContext {
  return {
    rule: { id: 'r1', name: 'r1', type: 'x', level: 'error' },
    evaluator,
    target: evaluator.target ?? '',
    value: evaluator.value ?? '',
    min: evaluator.min ?? 0,
    markdown: '',
    textScope: '',
    factNames: new Set(),
    chapterTitles: new Set(),
    tableBlocks: [],
    imageRefs: [],
    estimatedPages: 0,
    allFacts: [],
    factsModel: { tables: [] } as unknown as DocumentFactsModel,
    projectBindings: [],
    promptBindings: [],
    ...overrides,
  };
}

function applyGate(evaluator: GateRuleEvaluator, overrides: Partial<SpecGateRuleContext> = {}): string | undefined {
  const context = makeContext(evaluator, overrides);
  for (const handler of SPEC_GATE_RULE_HANDLERS) {
    const result = handler(context);
    if (result !== undefined) return result;
  }
  return undefined;
}

describe('SPEC_GATE_RULE_HANDLERS', () => {
  it('fact exists：缺失时报错，存在时通过', () => {
    expect(applyGate({ subject: 'fact', operator: 'exists', target: '工期' })).toBe('缺少事实 工期');
    expect(applyGate({ subject: 'fact', operator: 'exists', target: '工期' }, { factNames: new Set(['工期']) })).toBeUndefined();
  });

  it('chapter exists：缺失时报错，存在时通过', () => {
    expect(applyGate({ subject: 'chapter', operator: 'exists', target: '第一章' })).toBe('缺少章节 第一章');
    expect(applyGate({ subject: 'chapter', operator: 'exists', target: '第一章' }, { chapterTitles: new Set(['第一章']) })).toBeUndefined();
  });

  it('prompt_role exists：绑定后通过', () => {
    const promptBindings: PromptBinding[] = [{ promptId: 'p1', roleId: 'engineer' }];
    expect(applyGate({ subject: 'prompt_role', operator: 'exists', target: 'engineer' })).toBe('缺少提示词角色 engineer');
    expect(applyGate({ subject: 'prompt_role', operator: 'exists', target: 'engineer' }, { promptBindings })).toBeUndefined();
  });

  it('document contains：缺失时报错', () => {
    expect(applyGate({ subject: 'document', operator: 'contains', value: '安全生产' })).toBe('全文必须包含 安全生产');
    expect(applyGate({ subject: 'document', operator: 'contains', value: '安全' }, { markdown: '安全第一' })).toBeUndefined();
  });

  it('document not_contains：出现禁用文本时报错', () => {
    expect(applyGate({ subject: 'document', operator: 'not_contains', value: '后台流程' }, { markdown: '这是后台流程话术' })).toBe('出现禁用文本 后台流程');
    expect(applyGate({ subject: 'document', operator: 'not_contains', value: '后台流程' }, { markdown: '正常内容' })).toBeUndefined();
  });

  it('regex_match：未匹配时报错', () => {
    const regex = /安全生产/u;
    expect(applyGate({ subject: 'document', operator: 'regex_match', value: '安全正则' }, { regex, textScope: '没有相关内容' })).toBe('未匹配正则 安全正则');
    expect(applyGate({ subject: 'document', operator: 'regex_match', value: '安全正则' }, { regex, textScope: '安全生产责任制' })).toBeUndefined();
  });

  it('regex_not_match：匹配到禁止正则时报错', () => {
    const regex = /后台流程/u;
    expect(applyGate({ subject: 'document', operator: 'regex_not_match', value: '禁用词' }, { regex, textScope: '后台流程泄露' })).toBe('匹配到禁止正则 禁用词');
    expect(applyGate({ subject: 'document', operator: 'regex_not_match', value: '禁用词' }, { regex, textScope: '正常正文' })).toBeUndefined();
  });

  it('chapter contains：内容缺失时报错', () => {
    const chapter: DocumentDraftChapter = { id: 'c1', title: '第一章', content: '正文内容', evidence: [], missingFacts: [] };
    expect(applyGate({ subject: 'chapter', operator: 'contains', target: '第一章', value: '工艺参数' }, { chapter })).toBe('章节 第一章 必须包含 工艺参数');
    expect(applyGate({ subject: 'chapter', operator: 'contains', target: '第一章', value: '正文' }, { chapter })).toBeUndefined();
  });

  it('chapter not_contains：出现禁用文本时报错', () => {
    const chapter: DocumentDraftChapter = { id: 'c1', title: '第一章', content: '后台流程话术', evidence: [], missingFacts: [] };
    expect(applyGate({ subject: 'chapter', operator: 'not_contains', target: '第一章', value: '后台流程' }, { chapter })).toBe('章节 第一章 出现禁用文本 后台流程');
    expect(applyGate({ subject: 'chapter', operator: 'not_contains', target: '第一章', value: '后台流程' }, { chapter: { ...chapter, content: '正常' } })).toBeUndefined();
  });

  it('chapter min_length：字数不足时报错', () => {
    const chapter: DocumentDraftChapter = { id: 'c1', title: '第一章', content: '短', evidence: [], missingFacts: [] };
    expect(applyGate({ subject: 'chapter', operator: 'min_length', target: '第一章', min: 500 }, { chapter })).toBe('章节 第一章 低于 500 字');
    expect(applyGate({ subject: 'chapter', operator: 'min_length', target: '第一章', min: 500 }, { chapter: { ...chapter, content: 'x'.repeat(500) } })).toBeUndefined();
    // 章节不存在时同样报错
    expect(applyGate({ subject: 'chapter', operator: 'min_length', target: '第一章', min: 500 })).toBe('章节 第一章 低于 500 字');
  });

  it('table min_count：数量不足时报错', () => {
    expect(applyGate({ subject: 'table', operator: 'min_count', min: 2 }, { tableBlocks: ['|a|'] })).toBe('表格数量少于 2');
    expect(applyGate({ subject: 'table', operator: 'min_count', min: 1 }, { tableBlocks: ['|a|'] })).toBeUndefined();
  });

  it('table_explanation_required：表格后缺少说明时报错', () => {
    const markdown = '| 列 |\n|---|\n| 值 |\n';
    expect(applyGate({ subject: 'table', operator: 'table_explanation_required' }, { markdown, tableBlocks: ['| 列 |\n|---|\n| 值 |\n'] })).toBe('存在缺少说明文字的表格');
    const withExplain = `| 列 |\n|---|\n| 值 |\n\n以下是对该表格的详细说明，包含足够的说明文字。`;
    expect(applyGate({ subject: 'table', operator: 'table_explanation_required' }, { markdown: withExplain, tableBlocks: ['| 列 |\n|---|\n| 值 |\n'] })).toBeUndefined();
  });

  it('image min_count：数量不足时报错', () => {
    expect(applyGate({ subject: 'image', operator: 'min_count', min: 1 }, { imageRefs: [] })).toBe('图片数量少于 1');
    expect(applyGate({ subject: 'image', operator: 'min_count', min: 1 }, { imageRefs: [{ alt: 'a', url: 'u', index: 0 }] })).toBeUndefined();
  });

  it('page min_count / max_count：页数越界时报错', () => {
    expect(applyGate({ subject: 'page', operator: 'min_count', min: 10 }, { estimatedPages: 5 })).toBe('预计页数 5 少于 10');
    expect(applyGate({ subject: 'page', operator: 'max_count', min: 10 }, { estimatedPages: 15 })).toBe('预计页数 15 超过 10');
    expect(applyGate({ subject: 'page', operator: 'min_count', min: 10 }, { estimatedPages: 12 })).toBeUndefined();
  });

  it('image_caption_required：无 alt 且无说明时报错', () => {
    const markdown = '![](./img.png)';
    expect(applyGate({ subject: 'image', operator: 'image_caption_required' }, { markdown, imageRefs: [{ alt: '', url: './img.png', index: 2 }] })).toBe('存在缺少说明文字的图片');
    expect(applyGate({ subject: 'image', operator: 'image_caption_required' }, { markdown, imageRefs: [{ alt: '示意图', url: './img.png', index: 2 }] })).toBeUndefined();
  });

  it('source all_have_source：存在无来源事实时报错', () => {
    const fact = (sourceFile: string): DocumentFact => ({ key: 'k', value: 'v', sourceFile, roleId: 'r', confidence: 1 });
    expect(applyGate({ subject: 'source', operator: 'all_have_source' }, { allFacts: [fact(''), fact('a.pdf')] })).toBe('存在无来源事实');
    expect(applyGate({ subject: 'source', operator: 'all_have_source' }, { allFacts: [fact('a.pdf')] })).toBeUndefined();
  });

  it('source min_count：来源数量不足时报错（去重计数）', () => {
    const fact = (sourceFile: string): DocumentFact => ({ key: 'k', value: 'v', sourceFile, roleId: 'r', confidence: 1 });
    expect(applyGate({ subject: 'source', operator: 'min_count', min: 2 }, { allFacts: [fact('a.pdf'), fact('a.pdf')] })).toBe('来源数量少于 2');
    expect(applyGate({ subject: 'source', operator: 'min_count', min: 2 }, { allFacts: [fact('a.pdf'), fact('b.pdf')] })).toBeUndefined();
  });

  it('未注册 subject 无 handler 命中', () => {
    expect(applyGate({ subject: 'file_role', operator: 'exists', target: '图纸' })).toBeUndefined();
  });
});

describe('Markdown 结构正则', () => {
  it('MARKDOWN_TABLE_BLOCK_SPLIT_RE 按空行拆分', () => {
    expect('a\n\nb'.split(MARKDOWN_TABLE_BLOCK_SPLIT_RE)).toEqual(['a', 'b']);
  });

  it('MARKDOWN_TABLE_ROW_RE 识别表格行', () => {
    expect(MARKDOWN_TABLE_ROW_RE.test('| 字段 | 值 |')).toBe(true);
    expect(MARKDOWN_TABLE_ROW_RE.test('普通文本')).toBe(false);
  });

  it('MARKDOWN_TABLE_DIVIDER_RE 识别分隔线', () => {
    expect(MARKDOWN_TABLE_DIVIDER_RE.test('|---|---|')).toBe(true);
    expect(MARKDOWN_TABLE_DIVIDER_RE.test('| 字段 | 值 |')).toBe(false);
  });

  it('MARKDOWN_IMAGE_RE 抽取图片引用', () => {
    const matches = [...'![示意](./a.png) 和 ![b](/b.jpg)'.matchAll(MARKDOWN_IMAGE_RE)];
    expect(matches).toHaveLength(2);
    expect(matches[0].slice(1)).toEqual(['示意', './a.png']);
    MARKDOWN_IMAGE_RE.lastIndex = 0;
  });

  it('CHAPTER_HEADING_RE 识别「第X章」标题', () => {
    expect(CHAPTER_HEADING_RE.test('## 第一章 工程概况')).toBe(true);
    expect(CHAPTER_HEADING_RE.test('## 1.1 小节')).toBe(false);
    CHAPTER_HEADING_RE.lastIndex = 0;
  });

  it('DOCUMENT_BASIC_INFO_BLOCK_RE 识别基本信息块', () => {
    expect(DOCUMENT_BASIC_INFO_BLOCK_RE.test('### 文档基本信息')).toBe(true);
    expect(DOCUMENT_BASIC_INFO_BLOCK_RE.test('### 工程概况')).toBe(false);
  });

  it('DOCUMENT_BASIC_INFO_TABLE_RE 识别基本信息表', () => {
    expect(DOCUMENT_BASIC_INFO_TABLE_RE.test('| 字段 | 内容 |')).toBe(true);
    expect(DOCUMENT_BASIC_INFO_TABLE_RE.test('| 列A | 列B |')).toBe(false);
  });

  it('MARKDOWN_SECTION_HEADING_RE 识别二三级标题', () => {
    expect(MARKDOWN_SECTION_HEADING_RE.test('## 二级')).toBe(true);
    MARKDOWN_SECTION_HEADING_RE.lastIndex = 0;
    expect(MARKDOWN_SECTION_HEADING_RE.test('### 三级')).toBe(true);
    MARKDOWN_SECTION_HEADING_RE.lastIndex = 0;
    expect(MARKDOWN_SECTION_HEADING_RE.test('正文')).toBe(false);
  });

  it('TOC_BLOCK_RE 抽取目录块', () => {
    const match = '## 目录\n1.1 小节\n\n<div class="page-break"></div>\n## 第一章'.match(TOC_BLOCK_RE);
    expect(match?.[1]).toContain('1.1 小节');
    expect(match?.[1]).not.toContain('第一章');
  });

  it('TOC_SECTION_LINE_RE / TOC_INDENTED_SECTION_LINE_RE 识别目录行', () => {
    expect(TOC_SECTION_LINE_RE.test('1.1 工程概况')).toBe(true);
    expect(TOC_INDENTED_SECTION_LINE_RE.test('  2.3 施工方案')).toBe(true);
    expect(TOC_SECTION_LINE_RE.test('第一章 标题')).toBe(false);
  });

  it('MARKDOWN_TOP_HEADING_RE 识别一级标题', () => {
    expect(MARKDOWN_TOP_HEADING_RE.test('# 施工组织设计')).toBe(true);
    expect(MARKDOWN_TOP_HEADING_RE.test('## 二级')).toBe(false);
  });

  it('PRECISE_FACT_SOURCE_RE 识别结构化来源词', () => {
    expect(PRECISE_FACT_SOURCE_RE.test('drawing')).toBe(true);
    expect(PRECISE_FACT_SOURCE_RE.test('表格')).toBe(true);
    expect(PRECISE_FACT_SOURCE_RE.test('散文')).toBe(false);
  });

  it('PRECISE_FACT_TOKEN_RE 抽取精确参数 token', () => {
    const tokens = 'C30混凝土，25mm厚，100万元，GB/T 12345，3×4×5'.match(PRECISE_FACT_TOKEN_RE);
    expect(tokens?.length).toBeGreaterThanOrEqual(4);
    PRECISE_FACT_TOKEN_RE.lastIndex = 0;
  });

  it('STRUCTURED_DATA_CONTENT_RE / SPECIFICATION_CONTENT_RE 识别体现词', () => {
    expect(STRUCTURED_DATA_CONTENT_RE.test('详见表格')).toBe(true);
    expect(SPECIFICATION_CONTENT_RE.test('施工方案如下')).toBe(true);
  });

  it('LINE_SPLIT_RE / WHITESPACE_RE / NON_BLANK_RE 基础工具正则', () => {
    expect('a\r\nb'.split(LINE_SPLIT_RE)).toEqual(['a', 'b']);
    expect('a  b'.replace(WHITESPACE_RE, '_')).toBe('a_b');
    expect(NON_BLANK_RE.test('  内容  ')).toBe(true);
    expect(NON_BLANK_RE.test('   ')).toBe(false);
  });

  it('FORMAL_PLACEHOLDER_PATTERNS 识别占位式表达', () => {
    expect(FORMAL_PLACEHOLDER_PATTERNS.some(p => p.test('详见附件'))).toBe(true);
    expect(FORMAL_PLACEHOLDER_PATTERNS.some(p => p.test('| - |'))).toBe(true);
    expect(FORMAL_PLACEHOLDER_PATTERNS.some(p => p.test('具体做法如下'))).toBe(false);
  });

  it('PROMPT_EXAMPLE_BLOCK_RE 抽取示例片段', () => {
    // 带 g 标志的 match() 不返回捕获组，须用 matchAll 取捕获内容
    const [match] = '示例：\n这是示例正文内容，用于演示抽取逻辑，长度必须超过二十个字符。\n\n正式内容'.matchAll(PROMPT_EXAMPLE_BLOCK_RE);
    expect(match?.[1]).toContain('示例正文内容');
    PROMPT_EXAMPLE_BLOCK_RE.lastIndex = 0;
  });

  it('阈值与字段清单常量', () => {
    expect(PRECISE_FACT_MIN_TOKEN_COUNT).toBe(20);
    expect(PRECISE_FACT_MIN_USAGE_RATE).toBe(0.28);
    expect(DOCUMENT_BASIC_INFO_FIELDS).toContain('对象名称');
    expect(DOCUMENT_BASIC_INFO_FIELDS).toHaveLength(12);
  });
});
