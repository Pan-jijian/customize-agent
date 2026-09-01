import { describe, expect, it, vi } from 'vitest';
import type { DocumentDraftChapter, DocumentTemplate, GeneratedDocumentDraft, PromptDocumentRuleSet } from './types';
import {
  L0_WRITER_SYSTEM_PREFIX,
  DOCUMENT_L0_COMMON_PREFIX,
  docSystemPrefix,
  FORMAL_WRITING_RULES,
  SECTION_GENERATION_SAFETY_RULES,
  applyPromptDocumentRules,
  cleanFormalSourcePhrases,
  composeDocumentMarkdown,
  ensureFormalToc,
  dedupeCrossLevelHeadingDuplicates,
  dedupeRepeatedBlocksWithinSections,
  extractGeneratedSections,
  findChapterBlock,
  hasInlineListCollision,
  inferChapterSectionsFromMarkdown,
  mergeTableLineBreaks,
  normalizeInlineListBreaks,
  normalizeMarkdownTableDividers,
  normalizeProductionText,
  normalizeTenderSourcePageRefs,
  normalizeTertiaryHeadings,
  plannedStructureIssues,
  plannedStructurePrompt,
  promptDocumentRuleIssues,
  removeAdjacentDuplicateHeadings,
  removeUnwantedDrawingImages,
  sanitizeFormalMarkdown,
  sectionDuplicateIssues,
  sectionHeadingIssues,
  sourcePhraseIssues,
  stripMarkdownDocumentFence,
  tertiaryHeadingIssues,
  writerSystemPrefix,
} from './markdownComposer';

vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {}
  return { LocalTransformersEmbeddingProvider };
});

/**
 * 指令型标题语义 gate 注入的确定性嵌入：
 * 指令/说明类词面（如何/编写/注意事项/按需/要求/判断）→ [1,0] 命中正例原型；
 * 合法小节词面（危大工程/安全措施/质量验收/成品保护）→ [0,1] 命中负例原型（放行）；
 * 其余 → [0,0] 不触发语义扩围。
 */
const embedDocuments = async (texts: string[]) => texts.map(text => {
  const legalLike = /危大工程|安全措施|质量验收|检测要求|成品保护/u.test(text);
  const instructionLike = !legalLike && /如何|编写|注意事项|按需|说明|要求|判断/u.test(text);
  return [instructionLike ? 1 : 0, legalLike ? 1 : 0];
});

function chapterOf(overrides: Partial<DocumentDraftChapter> = {}): DocumentDraftChapter {
  return { id: 'ch-1', title: '工程概况', content: '', evidence: [], missingFacts: [], ...overrides };
}

function ruleSetOf(overrides: Partial<PromptDocumentRuleSet> = {}): PromptDocumentRuleSet {
  return { forbiddenTerms: [], preferredTerms: [], requiredTables: [], ...overrides };
}

describe('removeUnwantedDrawingImages', () => {
  it('forbid 为 true 时移除图纸图片行', () => {
    const markdown = '正文段落。\n\n![总平面图示意](images/plan.png)\n\n后续内容。';
    const result = removeUnwantedDrawingImages(markdown, true);
    expect(result).not.toContain('![总平面图示意]');
    expect(result).toContain('正文段落。');
    expect(removeUnwantedDrawingImages(markdown, false)).toBe(markdown);
  });
});

describe('normalizeProductionText', () => {
  it('单位上标与运算符号归一', () => {
    expect(normalizeProductionText('面积 28570.36 m2')).toBe('面积 28570.36 平方米'); // 现状锁定：m2→平方米 替换后保留原空格
    expect(normalizeProductionText('体积 100 m3')).toBe('体积 100 立方米'); // 现状锁定：m3→立方米 替换后保留原空格
    expect(normalizeProductionText('600 × 300 × 10')).toBe('600×300×10');
    expect(normalizeProductionText('± 0.000')).toBe('±0.000');
    expect(normalizeProductionText('原则上应保证质量')).toBe('应保证质量');
  });
});

describe('normalizeTenderSourcePageRefs', () => {
  it('页码引用归一为相关资料', () => {
    expect(normalizeTenderSourcePageRefs('详见 PDF 第 5-8 页')).toBe('详见 相关资料');
    expect(normalizeTenderSourcePageRefs('依据招标文件第 3 页')).toBe('依据招标文件相关资料');
  });

  it('专业图纸页数归一为图纸表述', () => {
    expect(normalizeTenderSourcePageRefs('给排水工程（共12页）')).toBe('给排水工程施工图纸'); // L65 专业工程+页数整体归一为“X施工图纸”
    expect(normalizeTenderSourcePageRefs('装饰工程施工图纸（共30页）')).toBe('装饰工程施工图纸');
  });
});

describe('hasInlineListCollision / normalizeInlineListBreaks', () => {
  it('连续行内列表标记判定冲突', () => {
    expect(hasInlineListCollision('措施包括 1. 准备工作 2. 实施检查')).toBe(true);
    expect(hasInlineListCollision('规格 1.5mm 与 2.0mm')).toBe(false);
  });

  it('句末标点后列表标记拆行', () => {
    expect(normalizeInlineListBreaks('流程说明。1. 第一步')).toBe('流程说明。\n1. 第一步');
  });
});

describe('normalizeMarkdownTableDividers', () => {
  it('裸表头自动补分隔行', () => {
    const result = normalizeMarkdownTableDividers('| 名称 | 单位 |\n| 钢筋 | t |');
    expect(result).toContain('| --- | --- |');
    expect(result).toContain('| 钢筋 | t |');
  });

  it('数据行列数补齐到表头列数', () => {
    const result = normalizeMarkdownTableDividers('| 名称 | 单位 | 数量 |\n|---|---|---|\n| 钢筋 | t |');
    expect(result).toContain('| 钢筋 | t |  |');
  });
});

describe('stripMarkdownDocumentFence', () => {
  it('剥离代码围栏', () => {
    expect(stripMarkdownDocumentFence('```markdown\n# 标题\n正文\n```')).toBe('# 标题\n正文');
    expect(stripMarkdownDocumentFence('# 无围栏标题')).toBe('# 无围栏标题');
  });
});

describe('cleanFormalSourcePhrases / sourcePhraseIssues', () => {
  it('正文来源罗列话术被删除', () => {
    const result = cleanFormalSourcePhrases('本工程根据招标文件、补疑澄清文件、设计图纸及工程量清单，确定工期为540日历天。');
    expect(result).toBe('确定工期为540日历天。'); // 现状锁定：SOURCE_ENUMERATION_PHRASE_RE 连同“本工程”前缀一起消费
  });

  it('编制依据小节豁免集中罗列', () => {
    const markdown = '## 编制依据\n依据招标文件、设计图纸、现行规范。';
    expect(cleanFormalSourcePhrases(markdown)).toBe(markdown);
  });

  it('来源罗列与粗体表名标记问题', () => {
    const issues = sourcePhraseIssues('依据招标文件、设计图纸，确定工期。\n\n**施工进度计划表**');
    expect(issues.some(item => item.message.includes('资料来源罗列话术'))).toBe(true);
    expect(issues.some(item => item.message.includes('粗体段落充当表名'))).toBe(true);
  });
});

describe('sectionHeadingIssues', () => {
  it('H4 与三级小节同名报结构重复', () => {
    const issues = sectionHeadingIssues('### 1.1 施工准备\n\n#### 施工准备\n正文。');
    expect(issues.some(item => item.message.includes('与本章三级小节同名'))).toBe(true);
  });

  it('H4 词尾粘连与过长多主题报错', () => {
    const issues = sectionHeadingIssues('#### 现场条件现场条件\n\n#### 施工现场安全生产文明施工与质量管理综合措施详解');
    expect(issues.some(item => item.message.includes('词尾粘连'))).toBe(true);
    expect(issues.some(item => item.message.includes('过长疑似多主题拼接'))).toBe(true);
  });

  it('专业工程方案标准命名豁免过长判定', () => {
    const issues = sectionHeadingIssues('#### 给排水及消防水系统安装工程施工方案');
    expect(issues).toHaveLength(0);
  });
});

describe('sectionDuplicateIssues', () => {
  it('跨小节重复句占比超阈值报重复', () => {
    const repeated = [
      '现场设置专职安全员每日巡查，发现隐患立即整改并复查销项，确保施工全过程安全受控。',
      '项目部每周组织一次综合安全检查，重点核查临时用电、临边防护与消防设施状态，检查记录归档备查。',
      '所有进场作业人员必须完成三级安全教育培训并考核合格，特种作业人员持有效证件方可上岗作业。',
    ];
    // 现状锁定：句子按指纹 Set 去重（相同句只计 1 个指纹），需两节重合 ≥3 个不同句才满足 overlap >= 3（L364）
    const markdown = ['## 第一章 工程概况', '### 1.1 施工准备', ...repeated, '### 1.2 现场布置', ...repeated, '### 1.3 临时用电', ...repeated].join('\n\n');
    const issues = sectionDuplicateIssues(markdown);
    expect(issues.some(item => item.message.includes('正文重复'))).toBe(true);
  });
});

describe('mergeTableLineBreaks', () => {
  it('表格单元格断行合并进上一数据行', () => {
    const result = mergeTableLineBreaks('| 名称 | 数量 |\n| 钢筋 | 100 |\n吨 | 说明 | 备注'); // 断行判定需 ≥2 个竖线（L389）且上一行是完整表格行（首尾 |）
    expect(result).toContain('100吨；说明');
  });

  it('断行紧跟分隔行时转为独立表格行', () => {
    const result = mergeTableLineBreaks('| 名称 | 单位 |\n|---|---|\n钢筋 | t | 备注');
    expect(result).toContain('| 钢筋 | t |');
  });
});

describe('sanitizeFormalMarkdown', () => {
  it('粗体表名转 H4 且内部话术行被过滤', () => {
    const markdown = '**施工进度计划表**\n\n该小节围绕内容进行补充说明。\n\n正文正常内容。';
    const result = sanitizeFormalMarkdown(markdown);
    expect(result).toContain('#### 施工进度计划表');
    expect(result).not.toContain('该小节围绕');
    expect(result).toContain('正文正常内容。');
  });

  it('行内伪标题拆行为独立标题行', () => {
    const result = sanitizeFormalMarkdown('复查记录留存影像资料。### 危大工程专项施工方案审批流程'); // 拆行正则要求句末标点后直接接 #（L434），无半角点
    expect(result).toContain('影像资料。');
    expect(result).toContain('### 危大工程专项施工方案审批流程');
  });

  it('工作流后台话术整行删除', () => {
    const result = sanitizeFormalMarkdown('本节内容围绕知识库证据组织。\n\n正文正常内容。');
    expect(result).not.toContain('知识库证据');
    expect(result).toContain('正文正常内容。');
  });
});

describe('removeAdjacentDuplicateHeadings', () => {
  it('双标题叠加降级保留内层标题', () => {
    expect(removeAdjacentDuplicateHeadings('## ### 施工准备')).toBe('### 施工准备');
  });

  it('相邻重复标题只保留首个', () => {
    const result = removeAdjacentDuplicateHeadings('## 施工准备\n\n## 施工准备\n\n正文。');
    expect(result).toBe('## 施工准备\n\n正文。');
  });
});

describe('extractGeneratedSections', () => {
  it('提取三级小节并过滤指令式标题', () => {
    const sections = extractGeneratedSections('### 工程概况\n\n### 是否涉及施工内容判断\n\n### 施工部署');
    expect(sections).toEqual(['工程概况', '施工部署']);
  });
});

describe('normalizeTertiaryHeadings / tertiaryHeadingIssues', () => {
  it('H4 自动补 X.Y.Z 编号', () => {
    const result = normalizeTertiaryHeadings('## 第一章 工程概况\n\n### 1.1 施工准备\n\n#### 施工机械配置');
    expect(result).toContain('#### 1.1.1 施工机械配置');
  });

  it('缺失编号的 H4 报编号问题', () => {
    const issues = tertiaryHeadingIssues('### 1.1 施工准备\n\n#### 施工机械配置');
    expect(issues.some(item => item.message.includes('缺少 1.1.x 编号'))).toBe(true);
  });
});

describe('inferChapterSectionsFromMarkdown', () => {
  it('从正文提取章节小节', () => {
    const sections = inferChapterSectionsFromMarkdown('## 第一章 工程概况\n\n### 1.1 施工准备\n正文。', [{ title: '工程概况', sections: ['施工准备'] }]);
    expect(sections[0]!.some(item => item.includes('施工准备'))).toBe(true);
  });
});

describe('applyPromptDocumentRules', () => {
  it('requiredTables 注入对应章节', () => {
    const result = applyPromptDocumentRules('## 第一章 工程概况\n\n正文内容。', ruleSetOf({ requiredTables: ['应急物资配置表'] }));
    expect(result).toContain('应急物资配置表');
    expect(result).toContain('| 控制项目 |');
  });

  it('forbiddenTerms 整行删除与 preferredTerms 替换', () => {
    const result = applyPromptDocumentRules('报价明细表内容。\n施工方负责组织施工。', ruleSetOf({ forbiddenTerms: ['报价明细表'], preferredTerms: [{ from: '施工方', to: '我公司' }] }));
    expect(result).not.toContain('报价明细表');
    expect(result).toContain('我公司负责组织施工。');
  });

  it('无 rules 时执行默认禁词替换', () => {
    expect(applyPromptDocumentRules('承包人案编制要求')).toContain('方案编制要求');
  });
});

describe('ensureFormalToc', () => {
  it('生成目录页并收录小节', () => {
    const result = ensureFormalToc('## 第一章 工程概况\n\n### 1.1 施工准备\n正文。', [{ title: '工程概况', sections: ['施工准备'], content: '' }]);
    expect(result).toContain('## 目录');
    expect(result).toContain('1.1 施工准备');
  });
});

describe('findChapterBlock', () => {
  it('定位章节区间', () => {
    const block = findChapterBlock('## 第一章 工程概况\n\n正文内容。', '工程概况');
    expect(block?.body).toContain('正文内容。');
    expect(findChapterBlock('无章节', '工程概况')).toBeUndefined();
  });
});

describe('plannedStructurePrompt / plannedStructureIssues', () => {
  const template: DocumentTemplate = {
    id: 'tpl-1', name: '施工组织设计模板', description: '', category: 'document', outputTitle: '施工组织设计',
    chapters: [{ id: 'ch-1', title: '工程概况', purpose: '', queries: [], requiredFacts: [], sections: ['施工准备'], tableSections: ['进度计划表'] }],
  };

  it('渲染规划结构与表格规划', () => {
    const prompt = plannedStructurePrompt(template);
    expect(prompt).toContain('工程概况');
    expect(prompt).toContain('规划小节：施工准备');
    expect(prompt).toContain('表格小节：进度计划表');
  });

  it('缺表格章节报必要表格缺失', () => {
    const issues = plannedStructureIssues('## 第一章 工程概况\n正文。', template);
    expect(issues.some(item => item.message.includes('缺少必要的正式表格'))).toBe(true);
  });
});

describe('promptDocumentRuleIssues', () => {
  it('封面/目录/关键词/禁用词逐项检出', async () => {
    const issues = await promptDocumentRuleIssues('正文内容。', ruleSetOf({
      coverPolicy: 'required',
      tocPolicy: 'required',
      requiredKeywords: ['文明施工'],
      forbiddenTerms: ['后台话术'],
    }), embedDocuments);
    expect(issues.some(item => item.message.includes('缺少提示词要求的封面'))).toBe(true);
    expect(issues.some(item => item.message.includes('缺少提示词要求的目录'))).toBe(true);
    expect(issues.some(item => item.message.includes('文明施工'))).toBe(true);
    const hitIssues = await promptDocumentRuleIssues('正文包含后台话术。', ruleSetOf({ forbiddenTerms: ['后台话术'] }), embedDocuments);
    expect(hitIssues.some(item => item.message.includes('后台话术'))).toBe(true);
  });

  it('无 rules 返回空数组', async () => {
    expect(await promptDocumentRuleIssues('正文。', undefined, embedDocuments)).toEqual([]);
  });

  it('弱词根指令标题经语义复核命中：如何编写类标题报指令标题', async () => {
    const issues = await promptDocumentRuleIssues('## 如何编写施工方案\n\n正文内容。', ruleSetOf(), embedDocuments);
    expect(issues.some(item => item.message.includes('疑似提示词指令标题'))).toBe(true);
  });

  it('弱词根但语义合法的标题零误杀：是否设置安全防护设施不报', async () => {
    const issues = await promptDocumentRuleIssues('## 是否设置安全防护设施\n\n正文内容。', ruleSetOf(), embedDocuments);
    expect(issues.some(item => item.message.includes('疑似提示词指令标题'))).toBe(false);
  });
});

describe('composeDocumentMarkdown', () => {
  it('端到端合成封面/目录/章节正文', () => {
    const markdown = composeDocumentMarkdown({
      templateId: 'tpl-1',
      templateName: '施工组织设计模板',
      title: '施工组织设计',
      requirement: '',
      facts: { 项目名称: '合肥项目' },
      chapters: [chapterOf({ content: '### 1.1 施工准备\n现场按计划组织施工准备。' })],
    } as unknown as Omit<GeneratedDocumentDraft, 'markdown'>);
    expect(markdown).toContain('施工组织设计');
    expect(markdown).toContain('## 目录');
    expect(markdown).toContain('第一章 工程概况');
    expect(markdown).toContain('施工准备');
  });
});

describe('L0_WRITER_SYSTEM_PREFIX（3.2 Writer 类 system 前缀统一）', () => {
  it('L0 恒定前缀 = 公共前缀 + 专家身份 + 正式写作规则 + 小节安全规则', () => {
    expect(L0_WRITER_SYSTEM_PREFIX.startsWith(DOCUMENT_L0_COMMON_PREFIX)).toBe(true);
    expect(L0_WRITER_SYSTEM_PREFIX).toContain('你是施工组织设计文档写作专家。');
    expect(L0_WRITER_SYSTEM_PREFIX).toContain(FORMAL_WRITING_RULES);
    expect(L0_WRITER_SYSTEM_PREFIX).toContain(SECTION_GENERATION_SAFETY_RULES);
  });

  it('docSystemPrefix 默认返回公共前缀 + 角色身份（跨类型共享第一段）', () => {
    const original = process.env.DOCUMENT_L0_SYSTEM_PREFIX;
    delete process.env.DOCUMENT_L0_SYSTEM_PREFIX;
    try {
      const prefix = docSystemPrefix('你是章节局部修复专家。');
      expect(prefix.startsWith(DOCUMENT_L0_COMMON_PREFIX)).toBe(true);
      expect(prefix).toContain('你是章节局部修复专家。');
    } finally {
      if (original !== undefined) process.env.DOCUMENT_L0_SYSTEM_PREFIX = original;
    }
  });

  it('docSystemPrefix 在 DOCUMENT_L0_SYSTEM_PREFIX=0 时回退 legacy 前缀', () => {
    const original = process.env.DOCUMENT_L0_SYSTEM_PREFIX;
    process.env.DOCUMENT_L0_SYSTEM_PREFIX = '0';
    try {
      expect(docSystemPrefix('新角色。', '旧前缀。')).toBe('旧前缀。');
    } finally {
      if (original !== undefined) process.env.DOCUMENT_L0_SYSTEM_PREFIX = original;
      else delete process.env.DOCUMENT_L0_SYSTEM_PREFIX;
    }
  });

  it('writerSystemPrefix 默认返回 L0 前缀', () => {
    const original = process.env.DOCUMENT_L0_SYSTEM_PREFIX;
    delete process.env.DOCUMENT_L0_SYSTEM_PREFIX;
    try {
      expect(writerSystemPrefix('legacy')).toBe(L0_WRITER_SYSTEM_PREFIX);
    } finally {
      if (original !== undefined) process.env.DOCUMENT_L0_SYSTEM_PREFIX = original;
    }
  });

  it('DOCUMENT_L0_SYSTEM_PREFIX=0 时回退 legacy 前缀（恢复原有 system 分布）', () => {
    const original = process.env.DOCUMENT_L0_SYSTEM_PREFIX;
    process.env.DOCUMENT_L0_SYSTEM_PREFIX = '0';
    try {
      expect(writerSystemPrefix('你是专业文档的小节生成专家。')).toBe('你是专业文档的小节生成专家。');
    } finally {
      if (original !== undefined) process.env.DOCUMENT_L0_SYSTEM_PREFIX = original;
      else delete process.env.DOCUMENT_L0_SYSTEM_PREFIX;
    }
  });
});

describe('dedupeCrossLevelHeadingDuplicates（4.12.12 跨层级同名整块去重）', () => {
  it('H2 与同名 H3 内容高度重合 → 删除较短块', () => {
    const markdown = [
      '## 3.2 新技术、新工艺、新材料、新设备的应用',
      '本项目拟采用装配式叠合楼板技术，减少现场湿作业。主体结构施工中应用BIM技术进行管线综合排布。',
      '新材料方面采用预拌砂浆，减少现场搅拌扬尘。',
      '### 新技术、新工艺、新材料、新设备的应用',
      '本项目拟采用装配式叠合楼板技术，减少现场湿作业。主体结构施工中应用BIM技术进行管线综合排布。',
      '新材料方面采用预拌砂浆，减少现场搅拌扬尘。新设备方面采用智能升降机提高垂直运输效率。',
    ].join('\n');
    const result = dedupeCrossLevelHeadingDuplicates(markdown);
    expect(result).not.toContain('## 3.2');
    expect(result).toContain('### 新技术、新工艺、新材料、新设备的应用');
    expect(result).toContain('智能升降机');
  });

  it('H2 与同名 H3 内容不重合 → H2 降级为 H3 保留独有内容', () => {
    const markdown = [
      '## 3.2 新技术、新工艺、新材料、新设备的应用',
      '本项目在施工管理中引入信息化平台，实现进度、质量、安全的线上协同管控。',
      '### 新技术、新工艺、新材料、新设备的应用',
      '本项目拟采用装配式叠合楼板技术，减少现场湿作业。主体结构施工中应用BIM技术进行管线综合排布。',
    ].join('\n');
    const result = dedupeCrossLevelHeadingDuplicates(markdown);
    expect(result).toContain('### 3.2 新技术、新工艺、新材料、新设备的应用');
    expect(result).toContain('信息化平台');
    expect(result).toContain('装配式叠合楼板');
  });

  it('无同名跨层级标题 → 原样返回', () => {
    const markdown = '## 3.2 新技术应用\n本项目拟采用装配式叠合楼板技术。\n### 3.3 绿色施工\n现场采用节水节电措施。';
    expect(dedupeCrossLevelHeadingDuplicates(markdown)).toBe(markdown);
  });
});

describe('dedupeRepeatedBlocksWithinSections（4.12.12 同小节相邻块重复去重）', () => {
  const repeated = '土方开挖采用分层分段开挖方式，每层开挖厚度不超过两米，开挖完成后及时进行基底验收。';

  it('同小节内同一段落连续复制 3 遍 → 只保留 1 遍', () => {
    const markdown = `### 施工方法\n${repeated}\n\n${repeated}\n\n${repeated}`;
    const result = dedupeRepeatedBlocksWithinSections(markdown);
    expect(result.split(repeated).length - 1).toBe(1);
  });

  it('标题行重置窗口：跨小节同名段落不误删', () => {
    const markdown = `### 3.1 施工方法\n${repeated}\n### 3.2 施工方法\n${repeated}`;
    const result = dedupeRepeatedBlocksWithinSections(markdown);
    expect(result.split(repeated).length - 1).toBe(2);
  });

  it('短段落（<24 字）不参与判重', () => {
    const markdown = '### 施工方法\n分层开挖，随挖随撑。\n分层开挖，随挖随撑。';
    const result = dedupeRepeatedBlocksWithinSections(markdown);
    expect(result.split('分层开挖，随挖随撑。').length - 1).toBe(2);
  });
});
