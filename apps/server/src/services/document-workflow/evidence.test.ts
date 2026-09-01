import { describe, expect, it } from 'vitest';
import type { DocumentEvidence, DocumentGenerationDiagnostics, DocumentGenerationStrategy, DocumentTemplateChapter } from './types';
import {
  buildEvidenceBundle,
  cleanEvidenceText,
  dedupeChapterEvidence,
  dedupeGlobalEvidence,
  EvidenceClaimRegistry,
  evidenceBundlePrompt,
  evidenceLine,
  evidencePromptBudgetForTarget,
  evidencePromptImportance,
  evidenceQualityScore,
  extractKeyParameterWindows,
  isExemptEvidenceSource,
  readableSourceLabel,
  sanitizeEvidenceContent,
  selectEvidenceByBudget,
  uniqueEvidence,
} from './evidence';

function evidenceItem(overrides: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'ch-1', filePath: '招标文件.pdf', score: 0.9, content: '项目名称：合肥市某区安置房项目。', ...overrides };
}

function diagnosticsOf(): DocumentGenerationDiagnostics {
  return {
    strategy: {} as DocumentGenerationStrategy,
    metrics: [],
    llm: { calls: 0, failures: 0, maxActive: 0, retries: 0 },
    semantic: { embedCacheHits: 0, embedCacheMisses: 0 },
    evidence: { raw: 0, used: 0, filteredNoise: 0, budgetDropped: 0, avgNoiseScore: 0, avgFactDensity: 0, searchQueries: 0, searchMs: 0, contextChars: 0, t0Chars: 0, t1Chars: 0, t2Lines: 0, omittedChars: 0 },
    quality: { blockingCount: 0, importantCount: 0, minorCount: 0, repairedCount: 0 },
  };
}

describe('readableSourceLabel', () => {
  it('按角色/处理类型映射资料类别', () => {
    expect(readableSourceLabel({ roleId: 'tender' })).toContain('规则资料');
    expect(readableSourceLabel({ processingType: 'table' })).toContain('表格资料');
    expect(readableSourceLabel({ processingType: 'drawing' })).toContain('视觉资料');
    expect(readableSourceLabel({ processingType: 'reference' })).toContain('文本资料');
  });

  it('带小节标题且序号递增', () => {
    expect(readableSourceLabel({ processingType: 'table', sectionTitle: '工程量清单' }, 2)).toBe('表格资料片段3（工程量清单）');
  });
});

describe('cleanEvidenceText / evidenceQualityScore', () => {
  it('移除 CAD 实体 token 与文件名引用并归一空白', () => {
    const cleaned = cleanEvidenceText('AcDbEntity 招标文件.pdf 内容  继续\n\n\n下一段');
    expect(cleaned).not.toContain('AcDbEntity');
    expect(cleaned).not.toContain('招标文件.pdf');
    expect(cleaned).not.toContain('   ');
    expect(cleaned).not.toContain('\n\n\n');
  });

  it('中文事实高密度内容判定可用', () => {
    const quality = evidenceQualityScore('项目名称：合肥市某区安置房项目，建设地点：合肥市蜀山区，质量标准：合格，计划工期：540日历天，验收标准按国家规范执行。');
    expect(quality.shouldUse).toBe(true);
    expect(quality.noiseScore).toBeLessThan(0.5);
    expect(quality.factDensity).toBeGreaterThan(0.2);
  });

  it('过短内容不可用', () => {
    expect(evidenceQualityScore('短文本').shouldUse).toBe(false);
  });
});

describe('sanitizeEvidenceContent', () => {
  it('高质量内容原样保留', () => {
    const content = '计划工期：540日历天。质量标准：合格，符合国家验收规范要求。';
    expect(sanitizeEvidenceContent('招标文件.pdf', content)).toBe(content);
  });

  it('低质量噪声内容压缩为参数行摘要', () => {
    const noisy = 'AcDbEntity Polyline Model Layout 图层 页码 打印 版权所有\n管径DN100\n厚度60mm\n混凝土C30';
    const result = sanitizeEvidenceContent('图纸.dwg', noisy);
    expect(result).toContain('资料参数行摘要：');
    expect(result).toContain('管径DN100');
    expect(result).toContain('厚度60mm');
  });

  it('页码行被过滤', () => {
    const content = '第 1 页 共 3 页\n项目名称：合肥市某区安置房项目，建设规模：总建筑面积28570.36平方米，计划工期：540日历天，质量标准：合格。';
    expect(sanitizeEvidenceContent('招标文件.pdf', content)).not.toContain('第 1 页');
  });

  it('附件格式兜底提示且不引用文件名', () => {
    const result = sanitizeEvidenceContent('管线图.dwg', '噪声噪声');
    expect(result).toContain('该资料为DWG格式附件');
    expect(result).toContain('正式正文不得引用文件名');
  });
});

describe('extractKeyParameterWindows', () => {
  it('短内容原样返回', () => {
    const content = '基坑底标高：15.65';
    expect(extractKeyParameterWindows(content, 600)).toBe(content);
  });

  it('超长内容尾部关键参数前置展示', () => {
    const tail = '图纸节点: A-01\n基坑底标高: 15.65(基坑底标高)\n管底标高: 22.00';
    const content = `${'头部元数据噪声填充。'.repeat(200)}\n${tail}`;
    const result = extractKeyParameterWindows(content, 600);
    expect(result.length).toBeLessThanOrEqual(600);
    expect(result).toContain('超长证据参数窗口提取');
    expect(result).toContain('基坑底标高');
    expect(result).toContain('管底标高');
    expect(result).toContain('图纸节点: A-01');
  });

  it('无参数行时按预算头部截断', () => {
    const content = '普通正文内容。'.repeat(200);
    const result = extractKeyParameterWindows(content, 600);
    expect(result.length).toBeLessThanOrEqual(600);
    expect(result).not.toContain('参数窗口提取');
  });
});

describe('uniqueEvidence', () => {
  it('同文件同内容去重并按加权分数排序', () => {
    const items = [
      evidenceItem({ content: '计划工期：540日历天，质量标准：合格，符合国家验收规范要求。'.repeat(2), score: 0.8 }),
      evidenceItem({ content: '计划工期：540日历天，质量标准：合格，符合国家验收规范要求。'.repeat(2), score: 0.6 }),
    ];
    const result = uniqueEvidence(items);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBeGreaterThan(0.8);
  });

  it('不同内容全部保留', () => {
    const result = uniqueEvidence([
      evidenceItem({ content: '计划工期：540日历天，质量标准：合格，符合国家验收规范要求。' }),
      evidenceItem({ content: '建设规模：总建筑面积28570.36平方米，计划工期：540日历天。' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('limit 截断并累计诊断', () => {
    const diagnostics = diagnosticsOf();
    const result = uniqueEvidence([
      evidenceItem({ content: '计划工期：540日历天，质量标准：合格，符合国家验收规范要求。' }),
      evidenceItem({ content: '建设规模：总建筑面积28570.36平方米，计划工期：540日历天。' }),
    ], 1, diagnostics);
    expect(result).toHaveLength(1);
    expect(diagnostics.evidence.raw).toBe(2);
    expect(diagnostics.evidence.used).toBe(1);
  });
});

describe('EvidenceClaimRegistry / 跨章节去重', () => {
  it('new → duplicate-in-chapter → claimed-by-other-chapter', () => {
    const registry = new EvidenceClaimRegistry();
    const item = evidenceItem();
    expect(registry.claim(item, 'ch-1')).toBe('new');
    expect(registry.claim(item, 'ch-1')).toBe('duplicate-in-chapter');
    expect(registry.claim(item, 'ch-2')).toBe('claimed-by-other-chapter');
  });

  it('豁免源（pinned-evidence 等）跨章保持 new', () => {
    const registry = new EvidenceClaimRegistry();
    const item = evidenceItem({ source: 'pinned-evidence' });
    expect(registry.claim(item, 'ch-1')).toBe('new');
    expect(registry.claim(item, 'ch-2')).toBe('new');
    expect(isExemptEvidenceSource(evidenceItem({ source: 'bound-file' }))).toBe(true);
    expect(isExemptEvidenceSource(evidenceItem())).toBe(false);
  });

  it('duplicateItems 按复用次数降序', () => {
    const registry = new EvidenceClaimRegistry();
    const shared = evidenceItem({ content: '计划工期：540日历天，质量标准：合格，符合国家验收规范要求。' });
    registry.claim(shared, 'ch-1');
    registry.claim(shared, 'ch-2');
    registry.claim(shared, 'ch-3');
    expect(registry.duplicateItems()).toEqual([{ key: expect.any(String), filePath: '招标文件.pdf', chapterIds: ['ch-1', 'ch-2', 'ch-3'], count: 3 }]);
  });

  it('dedupeChapterEvidence 去重并有 minRemaining 兜底', () => {
    const registry = new EvidenceClaimRegistry();
    const a = evidenceItem({ content: '计划工期：540日历天，质量标准：合格，符合国家验收规范要求。', score: 0.9 });
    registry.claim(a, 'ch-1');
    const kept = dedupeChapterEvidence([a, evidenceItem({ content: '建设规模：总建筑面积28570.36平方米，计划工期：540日历天。', score: 0.7 })], 'ch-2', registry, { minRemaining: 2 });
    expect(kept).toHaveLength(2);
    const keptStrict = dedupeChapterEvidence([a, evidenceItem({ content: '建设规模：总建筑面积28570.36平方米，计划工期：540日历天。', score: 0.7 })], 'ch-2', registry, { minRemaining: 8 });
    expect(keptStrict).toHaveLength(2);
  });
});

describe('dedupeGlobalEvidence', () => {
  it('同内容保留最高分', () => {
    const result = dedupeGlobalEvidence([
      evidenceItem({ score: 0.6 }),
      evidenceItem({ score: 0.9 }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(0.9);
  });

  it('豁免源按章节独立保留', () => {
    const result = dedupeGlobalEvidence([
      evidenceItem({ source: 'pinned-evidence', chapterId: 'ch-1' }),
      evidenceItem({ source: 'pinned-evidence', chapterId: 'ch-2' }),
    ]);
    expect(result).toHaveLength(2);
  });
});

describe('selectEvidenceByBudget', () => {
  const rich = (index: number) => evidenceItem({ filePath: `文件${index}.pdf`, content: `计划工期：540日历天，质量标准：合格，符合国家验收规范要求，第${index}份。`, score: 0.9 - index * 0.1 });

  it('maxItems 截断', () => {
    const result = selectEvidenceByBudget([rich(0), rich(1), rich(2)], { maxItems: 2 });
    expect(result).toHaveLength(2);
    expect(result[0]!.filePath).toBe('文件0.pdf');
  });

  it('pinned 证据优先占位', () => {
    const pinned = evidenceItem({ source: 'pinned-evidence', filePath: '固定.pdf', score: 0.1, content: '计划工期：540日历天，质量标准：合格，符合国家验收规范要求。' });
    const result = selectEvidenceByBudget([rich(0), pinned], { maxItems: 1, preservePinned: true });
    expect(result).toHaveLength(1);
    expect(result[0]!.filePath).toBe('固定.pdf');
  });

  it('maxChars 截断并记录 budgetDropped', () => {
    const diagnostics = diagnosticsOf();
    const result = selectEvidenceByBudget([rich(0), rich(1)], { maxChars: 60 }, diagnostics);
    expect(result.length).toBeLessThanOrEqual(1);
    expect(diagnostics.evidence.budgetDropped).toBeGreaterThan(0);
  });
});

describe('evidenceLine', () => {
  it('渲染单行证据引用', () => {
    expect(evidenceLine(evidenceItem())).toContain('文本资料片段1：');
    expect(evidenceLine(evidenceItem())).toContain('项目名称：合肥市某区安置房项目。');
  });
});

describe('buildEvidenceBundle', () => {
  const chapter: DocumentTemplateChapter = { id: 'ch-1', title: '工程概况', purpose: '', queries: [], requiredFacts: ['项目名称'] };

  it('按文件类型分类资源并生成摘要', () => {
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '总平面图.png', processingType: 'drawing', content: '平面布局说明。' }),
      evidenceItem({ filePath: '清单.xlsx', processingType: 'table', content: '钢筋 100t。' }),
      evidenceItem({ filePath: '招标文件.pdf', processingType: 'reference', content: '项目名称：合肥市某区安置房项目。' }),
      evidenceItem({ filePath: '其他.xyz', processingType: 'reference', content: '补充附件内容。' }),
    ]);
    expect(bundle.byKind.map).toHaveLength(1);
    expect(bundle.byKind.table).toHaveLength(1);
    expect(bundle.byKind.document).toHaveLength(1);
    expect(bundle.byKind.attachment).toHaveLength(1);
    expect(bundle.summary).toContain('绑定材料包');
    expect(bundle.summary).toContain('文本片段 4 条');
    expect(bundle.resources).toHaveLength(4);
  });

  it('扩展名归类 spreadsheet 且同文件多证据合并资源与片段', () => {
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '清单.xlsx', content: '项目名称：合肥项目，钢筋 100t。' }),
      evidenceItem({ filePath: '清单.xlsx', content: '水泥 200t。', score: 0.95 }),
    ]);
    expect(bundle.byKind.spreadsheet).toHaveLength(1);
    expect(bundle.resources).toHaveLength(1);
    expect(bundle.resources[0]!.snippets).toHaveLength(2);
    expect(bundle.resources[0]!.score).toBe(0.95);
    expect(bundle.resources[0]!.relatedFacts).toContain('项目名称');
  });
});

describe('evidencePromptBudgetForTarget', () => {
  it('按字数动态计算并受 floor/ceiling 约束', () => {
    // P0-4：每目标字 8 字符（12 → 8 收紧），无字数时按 1200 基准
    expect(evidencePromptBudgetForTarget()).toBe(9600);
    expect(evidencePromptBudgetForTarget(1000)).toBe(8000);
    expect(evidencePromptBudgetForTarget(100)).toBe(8000);
  });
});

describe('evidencePromptImportance', () => {
  it('量化参数/基础事实/requiredFacts/标准编号加权', () => {
    const base = evidencePromptImportance(evidenceItem({ content: '普通内容' }), []);
    const quantified = evidencePromptImportance(evidenceItem({ content: '厚度60mm' }), []);
    expect(quantified).toBeGreaterThan(base);
    const basic = evidencePromptImportance(evidenceItem({ content: '计划工期：540日历天' }), []);
    expect(basic).toBeGreaterThan(base);
    const matched = evidencePromptImportance(evidenceItem({ content: '项目名称：合肥项目' }), ['项目名称']);
    expect(matched).toBeGreaterThan(evidencePromptImportance(evidenceItem({ content: '项目名称：合肥项目' }), []));
    const standard = evidencePromptImportance(evidenceItem({ content: 'GB 50204-2015' }), []);
    expect(standard).toBeGreaterThan(base);
  });
});

describe('evidenceBundlePrompt', () => {
  const chapter: DocumentTemplateChapter = { id: 'ch-1', title: '工程概况', purpose: '', queries: [], requiredFacts: [] };

  it('渲染摘要/结构化资料/文本片段', () => {
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '清单.xlsx', processingType: 'table', content: '钢筋 100t。' }),
      evidenceItem({ filePath: '招标文件.pdf', processingType: 'reference', content: '计划工期：540日历天。' }),
    ]);
    const prompt = evidenceBundlePrompt(bundle, { maxChars: 5000 });
    expect(prompt).toContain('绑定材料包');
    expect(prompt).toContain('结构化资料：');
    expect(prompt).toContain('文本/附件片段：');
    expect(prompt).toContain('计划工期：540日历天');
  });

  it('预算内省略时输出省略提示', () => {
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '清单.xlsx', processingType: 'table', content: '钢筋 100t。' }),
      evidenceItem({ filePath: '招标文件.pdf', processingType: 'reference', content: '计划工期：540日历天。'.repeat(30) }),
    ]);
    const prompt = evidenceBundlePrompt(bundle, { maxChars: 200 });
    expect(prompt).toContain('完整证据池仍保留');
  });

  it('T0 关键事实层全量保留：尾部关键参数不被 T1 预算裁剪挤出', () => {
    const tail = '图纸节点: A-01\n基坑底标高: 15.65(基坑底标高)\n坡率 1:1.0';
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '支护图.dwg', processingType: 'drawing', content: `${'头部噪声填充。'.repeat(400)}\n${tail}` }),
      evidenceItem({ filePath: '招标文件.pdf', processingType: 'reference', content: '计划工期：540日历天，质量标准：合格，符合国家验收规范要求，本章证据原文填充。'.repeat(50) }),
    ]);
    const prompt = evidenceBundlePrompt(bundle, { maxChars: 1500 });
    expect(prompt).toContain('关键事实层');
    expect(prompt).toContain('基坑底标高: 15.65');
    expect(prompt).toContain('坡率 1:1.0');
    expect(prompt).toContain('计划工期：540日历天');
  });

  it('T0 事实层不随 T1 省略而丢失（预算极小场景）', () => {
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '招标文件.pdf', processingType: 'reference', content: '计划工期：540日历天。'.repeat(30) }),
      evidenceItem({ filePath: '补疑.pdf', processingType: 'reference', content: '基坑开挖深度：5.85m，支护形式：放坡+喷锚。'.repeat(20) }),
    ]);
    const prompt = evidenceBundlePrompt(bundle, { maxChars: 400 });
    // T1 预算被压到极小，但 T0 关键事实行（工期/开挖深度/支护形式）必须全量在
    expect(prompt).toContain('关键事实层');
    expect(prompt).toContain('计划工期：540日历天');
    expect(prompt).toContain('基坑开挖深度：5.85m');
  });

  it('每文件至少 1 条 T1 片段（文件覆盖公平性）', () => {
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '高分手头文件.pdf', score: 0.99, content: '项目名称：合肥市某区安置房项目，建设地点：合肥市蜀山区，计划工期：540日历天，质量标准：合格，符合国家验收规范要求，内容填充一。'.repeat(10) }),
      evidenceItem({ filePath: '低分关键文件.pdf', score: 0.2, content: '基坑底标高：15.65，开挖深度：5.85m。' }),
    ]);
    const prompt = evidenceBundlePrompt(bundle, { maxChars: 1200 });
    expect(prompt).toContain('文本/附件片段');
    // 两个文件的 top-1 片段都进入 T1（内容块计数 ≥2，而非高分单文件霸占预算）
    expect((prompt.match(/^内容：$/gm) || []).length).toBeGreaterThanOrEqual(2);
    expect(prompt).toContain('基坑底标高：15.65，开挖深度：5.85m。');
  });

  it('T2 证据目录行：未进 T1 的片段以一行索引呈现且统计省略量', () => {
    const diagnostics = diagnosticsOf();
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '文件A.pdf', processingType: 'reference', content: '项目名称：合肥项目，钢筋 100t，水泥 200t，计划工期：540日历天，内容填充一段较长的叙述以保证超预算。'.repeat(4) }),
      evidenceItem({ filePath: '文件B.pdf', processingType: 'reference', content: '补充说明：基坑支护采用放坡开挖，坡率 1:1.0，质量标准合格。'.repeat(4) }),
      evidenceItem({ filePath: '文件C.pdf', processingType: 'reference', content: '第三份资料：门窗采用断桥铝合金，K 值 2.0。'.repeat(4) }),
    ]);
    const prompt = evidenceBundlePrompt(bundle, { maxChars: 1000, diagnostics });
    expect(prompt).toContain('证据目录');
    expect(diagnostics.evidence.t0Chars).toBeGreaterThan(0);
    expect(diagnostics.evidence.t1Chars).toBeGreaterThan(0);
    expect(diagnostics.evidence.t2Lines).toBeGreaterThan(0);
    expect(diagnostics.evidence.omittedChars).toBeGreaterThan(0);
  });

  it('证据池小于预算时零裁剪（目录与省略提示均不出现）', () => {
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '招标文件.pdf', processingType: 'reference', content: '计划工期：540日历天。' }),
    ]);
    const prompt = evidenceBundlePrompt(bundle, { maxChars: 5000 });
    expect(prompt).not.toContain('证据目录');
    expect(prompt).not.toContain('完整证据池仍保留');
    expect(prompt).toContain('计划工期：540日历天');
  });

  it('标准规范编号行进入 T0 事实层', () => {
    const bundle = buildEvidenceBundle(chapter, [
      evidenceItem({ filePath: '招标文件.pdf', processingType: 'reference', content: '主体结构施工执行 GB 50204-2015《混凝土结构工程施工质量验收规范》，填充叙述内容以构成完整段落文本。'.repeat(5) }),
    ]);
    const prompt = evidenceBundlePrompt(bundle, { maxChars: 2000 });
    expect(prompt).toContain('关键事实层');
    expect(prompt).toContain('GB 50204-2015');
  });
});
