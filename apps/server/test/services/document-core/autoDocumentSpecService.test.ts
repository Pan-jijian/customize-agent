/**
 * autoDocumentSpecService 单测（配置读取 mock 为空）：
 * getOrCreateAutoDocumentSpec（文档类型推断/事实名推断/章节规则/用户 requirement 解析：
 * 页数 min/max/target、章节增补、禁词与必含词、表格数量）与 autoSpecPrompt 两种输出形态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineeringDocumentConfig } from '@/services/document-validation/engineeringDocumentConfigService';
import type { DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';
import { autoSpecPrompt, getOrCreateAutoDocumentSpec } from '@/services/document-core/autoDocumentSpecService';

const EMPTY_CONFIG: EngineeringDocumentConfig = {
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

vi.mock('@/services/document-validation/engineeringDocumentConfigService', () => ({
  readEngineeringDocumentConfig: vi.fn(() => EMPTY_CONFIG),
}));

function makeChapter(partial: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'ch1', title: '工程概况', purpose: '介绍工程基本情况', queries: [], requiredFacts: [], ...partial };
}

function makeTemplate(partial: Partial<DocumentTemplate> = {}): DocumentTemplate {
  return {
    id: 'tpl-1',
    name: '施工组织设计',
    description: '施工组织设计编制模板',
    category: '施工方案',
    outputTitle: '施工组织设计',
    chapters: [makeChapter()],
    ...partial,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getOrCreateAutoDocumentSpec 基础结构', () => {
  it('文档类型推断为实施方案', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate());
    expect(spec.description).toContain('实施方案');
  });

  it('sourceHash 为 12 位十六进制且受 requirement 影响', () => {
    const a = getOrCreateAutoDocumentSpec(makeTemplate(), '');
    const b = getOrCreateAutoDocumentSpec(makeTemplate(), '不少于20页');
    expect(a.sourceHash).toMatch(/^[0-9a-f]{12}$/u);
    expect(b.sourceHash).not.toBe(a.sourceHash);
  });

  it('spec.id 前缀 auto-模板id-hash 且过滤非法字符', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate({ id: 'tpl 1/工程' }));
    expect(spec.id.startsWith('auto-tpl-1-')).toBe(true);
    expect(spec.id).toMatch(/^[a-zA-Z0-9_-]+$/u);
  });

  it('章节 requiredFacts 直接进入事实名，FACT_RULES 关键词命中补全', () => {
    const template = makeTemplate({
      chapters: [makeChapter({ id: 'ch1', title: '工程概况', purpose: '质量验收要求', requiredFacts: ['总建筑面积'] })],
    });
    const { spec } = getOrCreateAutoDocumentSpec(template);
    const names = spec.factFields.map(field => field.name);
    expect(names).toContain('总建筑面积');
    // '质量'、'验收' 命中质量规则 → 质量要求
    expect(names).toContain('质量要求');
  });

  it('chapterRules 映射模板章节且 minWords 为 900', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate({ chapters: [makeChapter({ requiredFacts: ['总建筑面积'] })] }));
    expect(spec.chapterRules).toHaveLength(1);
    const rule = spec.chapterRules[0]!;
    expect(rule.title).toBe('工程概况');
    expect(rule.minWords).toBe(900);
    expect(rule.order).toBe(0);
    expect(rule.requiredFactIds).toContain('总建筑面积');
  });

  it('gateRules 恒含来源必需与后台话术禁止', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate());
    const names = spec.gateRules.map(rule => rule.name);
    expect(names).toContain('事实必须有来源');
    expect(names).toContain('不得输出后台流程话术');
  });
});

describe('requirement 页数解析', () => {
  function pageRules(requirement: string) {
    return getOrCreateAutoDocumentSpec(makeTemplate(), requirement).spec.gateRules.filter(rule => rule.type === 'user_page_target');
  }

  it('不少于 20 页 → 仅 min 规则', () => {
    const rules = pageRules('不少于20页');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.evaluator?.min).toBe(20);
  });

  it('不超过 15 页 → 仅 max 规则', () => {
    const rules = pageRules('不超过15页');
    expect(rules).toHaveLength(1);
    expect(rules[0]!.evaluator?.min).toBe(15);
  });

  it('控制在 8 页以内 → max 8', () => {
    const rules = pageRules('控制在8页以内');
    expect(rules[0]!.evaluator?.min).toBe(8);
  });

  it('大概 10 页 → min 8 且 max 12（±15% 区间）', () => {
    const rules = pageRules('大概10页');
    const mins = rules.filter(rule => rule.name.includes('不少于'));
    const maxs = rules.filter(rule => rule.name.includes('不超过'));
    expect(mins[0]!.evaluator?.min).toBe(8);
    expect(maxs[0]!.evaluator?.min).toBe(12);
  });

  it('约 5 页 → min 4 且 max 6', () => {
    const rules = pageRules('约5页');
    const mins = rules.filter(rule => rule.name.includes('不少于'));
    const maxs = rules.filter(rule => rule.name.includes('不超过'));
    expect(mins[0]!.evaluator?.min).toBe(4);
    expect(maxs[0]!.evaluator?.min).toBe(6);
  });

  it('无页数要求 → 无页数规则', () => {
    expect(pageRules('按模板执行')).toEqual([]);
  });
});

describe('requirement 章节增补', () => {
  it('必须增加章节：标题 → 用户章节规则与 gate 规则', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '必须增加章节：施工进度计划');
    const userRule = spec.chapterRules.find(rule => rule.title === '施工进度计划');
    expect(userRule).toBeDefined();
    expect(userRule!.minWords).toBe(600);
    expect(userRule!.id.startsWith('user-chapter-')).toBe(true);
    expect(spec.gateRules.some(rule => rule.type === 'user_required_chapter' && rule.target === '施工进度计划')).toBe(true);
  });

  it('目录包括多章节 → 逐项拆分', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '目录包括：一、工程概况、二、施工方案');
    const titles = spec.chapterRules.map(rule => rule.title);
    expect(titles).toContain('工程概况');
    expect(titles).toContain('施工方案');
  });

  it('与模板已有章节重名不重复增补', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '必须增加章节：工程概况');
    const same = spec.chapterRules.filter(rule => rule.title === '工程概况');
    expect(same).toHaveLength(1);
  });

  it('目录中含禁止词的条目被过滤', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '目录包括：不要的内容、施工方案');
    expect(spec.chapterRules.some(rule => rule.title === '不要的内容')).toBe(false);
    expect(spec.chapterRules.some(rule => rule.title === '施工方案')).toBe(true);
  });

  it('章节名自身含禁止词 → 不增补', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '必须增加章节：不能出现的章节');
    expect(spec.chapterRules.some(rule => rule.title.includes('不能出现'))).toBe(false);
  });

  it('「X 章节」尾置形态（无冒号标题）不解析为章节增补', () => {
    // 设计约定：capture 位于「章节：」之后；尾置形态无标题可提取，静默忽略
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '必须包含施工进度计划章节');
    expect(spec.chapterRules.some(rule => rule.title === '施工进度计划')).toBe(false);
  });
});

describe('requirement 禁词与必含词', () => {
  it('禁止出现引号词 → forbidden gate（error 级）', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '禁止出现“豆腐渣工程”字样');
    const gate = spec.gateRules.find(rule => rule.type === 'user_forbidden_text');
    expect(gate).toBeDefined();
    expect(gate!.value).toBe('豆腐渣工程');
    expect(gate!.level).toBe('error');
  });

  it('含章节/页/表格的禁词被过滤', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '不得出现表格相关内容');
    expect(spec.gateRules.some(rule => rule.type === 'user_forbidden_text')).toBe(false);
  });

  it('必须输出引号词 → required gate', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '必须输出“安全文明施工目标”');
    const gate = spec.gateRules.find(rule => rule.type === 'user_required_text');
    expect(gate).toBeDefined();
    expect(gate!.value).toBe('安全文明施工目标');
  });

  it('写明某内容 → required gate', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '写明应急预案');
    const gate = spec.gateRules.find(rule => rule.type === 'user_required_text');
    expect(gate?.value).toBe('应急预案');
  });

  it('无禁词必含要求 → 无对应 gate', () => {
    const { spec } = getOrCreateAutoDocumentSpec(makeTemplate(), '按模板执行');
    expect(spec.gateRules.some(rule => rule.type === 'user_forbidden_text')).toBe(false);
    expect(spec.gateRules.some(rule => rule.type === 'user_required_text')).toBe(false);
  });
});

describe('requirement 表格数量', () => {
  function tableRules(requirement: string) {
    return getOrCreateAutoDocumentSpec(makeTemplate(), requirement).spec.gateRules.filter(rule => rule.type === 'user_format_table');
  }

  it('至少 3 个表格 → min 3', () => {
    expect(tableRules('至少3个表格')[0]!.evaluator?.min).toBe(3);
  });

  it('表格化表达 → min 1', () => {
    expect(tableRules('用表格化表达')[0]!.evaluator?.min).toBe(1);
  });

  it('无表格要求 → 无规则', () => {
    expect(tableRules('按模板执行')).toEqual([]);
  });
});

describe('autoSpecPrompt 输出', () => {
  const { spec, sourceHash } = getOrCreateAutoDocumentSpec(makeTemplate());

  it('公开安全版含事实边界标题', () => {
    const prompt = autoSpecPrompt(spec, sourceHash, { publicSafe: true });
    expect(prompt).toContain('## 文档事实与质量要求');
    expect(prompt).not.toContain('结构化检查摘要');
  });

  it('后台版含结构化检查摘要与版本标识', () => {
    const prompt = autoSpecPrompt(spec, sourceHash);
    expect(prompt).toContain('## 结构化检查摘要');
    expect(prompt).toContain(sourceHash);
    expect(prompt).toContain('不得新增、删除、重排用户或模板章节');
  });

  it('后台版罗列建议关注事实', () => {
    const prompt = autoSpecPrompt(spec, sourceHash);
    expect(prompt).toContain('建议关注事实');
  });
});
