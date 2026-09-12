/**
 * 4.19 成稿质量五模块修复单测（A~E）：
 * A 编号归一根治（finalize 单调+幂等 / 目录正文编号对应校验）
 * B 工作包三要素硬门（宽松门 workPackageElementsMeetLenientGate）
 * C 危大判定闭环（危大分级交叉质检 / 支护形式事实一致性）
 * D 参数一致性（设备进场时间合理性）
 * E 规划卫生（规划小节归一去重）
 */
import { describe, expect, it, vi } from 'vitest';
import { finalizeDocumentMarkdown } from '@/services/document-workflow/markdownComposer';
import { sectionCountOverflowIssues, sectionNumberingIssues, tocBodyConsistencyIssues } from '@/services/document-workflow/qualityValidation';
import { workPackageElementsMeetLenientGate } from '@/services/document-workflow/utils';
import { equipmentEntryTimingIssues, excavationDepthFromFacts, excavationHazardClassificationIssues, supportFormFactConsistencyIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { dedupePlannedSections } from '@/services/document-workflow/promptRuleExtraction';
import { buildCanonicalFacts, collectStructuredFactCandidates, extractDrawingAnnotationFacts } from '@/services/document-workflow/factGovernance';
import { crossChapterConsistencyIssues } from '@/services/document-workflow/qualityValidation';
import type { DocumentDraftChapter, DocumentFactsModel } from '@/services/document-workflow/types';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));
vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {}
  return { LocalTransformersEmbeddingProvider };
});

/** 深度主表事实卡 mock（canonical 简写，仅新检查器消费的槽位） */
function factsModelWithDepth(depth: string): DocumentFactsModel {
  return {
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [], bills: [],
    drawings: [], rules: [], specifications: [], schemaFacts: {}, factIndex: {}, missing: [],
    conflicts: [], preciseFacts: [],
    canonical: { byKey: { excavation_depth: { key: 'excavation_depth', label: '基坑开挖深度', value: depth, normalizedValue: depth, sourceType: 'drawing', confidence: 0.9, priority: 10, locked: true } } },
  } as unknown as DocumentFactsModel;
}

function factsModelWithSupportForm(value: string): DocumentFactsModel {
  return {
    project: [], schedule: [], quality: [], safety: [], resources: [], tables: [], bills: [],
    drawings: [], rules: [], specifications: [], schemaFacts: {}, factIndex: {}, missing: [],
    conflicts: [], preciseFacts: [],
    canonical: { byKey: { foundation_support_form: { key: 'foundation_support_form', label: '基坑支护形式', value, normalizedValue: value, sourceType: 'drawing', confidence: 0.9, priority: 10, locked: true } } },
  } as unknown as DocumentFactsModel;
}

// ── A：编号归一根治（finalize 单调化 + 幂等）──

describe('finalizeDocumentMarkdown 编号单调与幂等（A 模块）', () => {
  const chapters = [
    { title: '第一章 编制说明与工程概况', sections: ['编制说明', '工程概况', '施工部署'], content: [
      '## 第一章 编制说明与工程概况',
      '',
      '### 4.1 编制说明',
      '说明正文。',
      '',
      '### 4.1 工程概况',
      '概况正文。',
      '',
      '### 4.3 施工部署',
      '部署正文。',
    ].join('\n') },
    { title: '第二章 施工组织与技术措施', sections: [], content: [
      '## 第二章 施工组织与技术措施',
      '',
      '### 2.1 基坑支护施工',
      '支护正文。',
    ].join('\n') },
  ] as unknown as DocumentDraftChapter[];

  it('重复/跳号 H3 归一后编号连续单调（1.1/1.2/1.3）', () => {
    const markdown = chapters.map(chapter => chapter.content).join('\n\n');
    const { markdown: finalized } = finalizeDocumentMarkdown(markdown, chapters);
    const numbers = [...finalized.matchAll(/^###\s+(\d+)\.(\d+)\s+/gmu)].map(match => `${match[1]}.${match[2]}`);
    expect(numbers).toEqual(['1.1', '1.2', '1.3', '2.1']);
  });

  it('幂等：第二次归一不再漂移编号与标题', () => {
    const markdown = chapters.map(chapter => chapter.content).join('\n\n');
    const first = finalizeDocumentMarkdown(markdown, chapters);
    const second = finalizeDocumentMarkdown(first.markdown, chapters);
    const pick = (markdown: string) => [...markdown.matchAll(/^###\s+(\d+\.\d+)\s+(.+)$/gmu)].map(match => `${match[1]} ${match[2]}`);
    expect(pick(second.markdown)).toEqual(pick(first.markdown));
  });

  it('重复小节降级为当前小节的 H4，不消耗 H3 编号（降级合并重排）', () => {
    const markdown = [
      '## 第一章 编制说明与工程概况',
      '',
      '### 编制说明',
      '说明正文。',
      '',
      '### 工程概况',
      '概况正文。',
      '',
      '### 编制说明',
      '重复出现的编制说明正文。',
      '',
      '### 施工部署',
      '部署正文。',
    ].join('\n');
    const chapter = { title: '编制说明与工程概况', sections: ['编制说明', '工程概况', '施工部署'], content: markdown } as unknown as DocumentDraftChapter;
    const { markdown: finalized } = finalizeDocumentMarkdown(markdown, [chapter]);
    const h3Numbers = [...finalized.matchAll(/^###\s+(\d+\.\d+)\s+/gmu)].map(match => match[1]);
    // 重复块降级挂到当前小节（1.2.1），施工部署保持 1.3——历史缺陷：降级块消耗编号导致 1.3 缺号、1.4 生效跳号
    expect(h3Numbers).toEqual(['1.1', '1.2', '1.3']);
    expect(finalized).toContain('#### 1.2.1');
  });

  it('降级合并归一后编号连续 → L5 编号门禁不报（修复↔检测闭环）', () => {
    const markdown = [
      '## 第一章 编制说明与工程概况',
      '',
      '### 编制说明',
      '说明正文。',
      '',
      '### 编制说明',
      '重复出现的编制说明正文。',
      '',
      '### 施工部署',
      '部署正文。',
    ].join('\n');
    const chapter = { title: '编制说明与工程概况', sections: ['编制说明', '施工部署'], content: markdown } as unknown as DocumentDraftChapter;
    const { markdown: finalized } = finalizeDocumentMarkdown(markdown, [chapter]);
    const h3Numbers = [...finalized.matchAll(/^###\s+(\d+\.\d+)\s+/gmu)].map(match => match[1]);
    expect(h3Numbers).toEqual(['1.1', '1.2']);
    expect(sectionNumberingIssues(finalized)).toEqual([]);
  });
});

// ── A-2：目录正文编号↔名称对应校验 ──

describe('tocBodyConsistencyIssues 编号对应校验（A-2）', () => {
  const tocBlock = [
    '## 目录',
    '4.1 编制说明',
    '4.2 工程概况',
    '4.3 施工部署',
    '4.4 基坑支护施工',
    '<div class="page-break"></div>',
  ].join('\n');

  it('同一编号目录与正文名称不一致 → 报编号对应错误', () => {
    const markdown = `${tocBlock}\n## 第四章 主要施工方法\n### 4.1 编制说明\n### 4.2 工程概况\n### 4.3 施工部署\n### 4.4 土方开挖施工`;
    const issues = tocBodyConsistencyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('目录与正文同一编号对应不同小节'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('4.4'))).toBe(true);
  });

  it('目录与正文节数不等 → 报数量不一致', () => {
    const markdown = `${tocBlock}\n## 第四章 主要施工方法\n### 4.1 编制说明\n### 4.2 工程概况\n### 4.3 施工部署`;
    const issues = tocBodyConsistencyIssues(markdown);
    expect(issues.some(issue => issue.message.includes('目录与正文小节数量不一致'))).toBe(true);
  });

  it('目录正文编号与名称完全一致 → 不报', () => {
    const markdown = `${tocBlock}\n## 第四章 主要施工方法\n### 4.1 编制说明\n### 4.2 工程概况\n### 4.3 施工部署\n### 4.4 基坑支护施工`;
    expect(tocBodyConsistencyIssues(markdown)).toEqual([]);
  });
});

// ── A-3：L5 编号连续性门禁（sectionNumberingIssues）──

describe('sectionNumberingIssues L5 编号连续性门禁（A-3）', () => {
  it('编号连续（1.1/1.2/1.3）→ 不报', () => {
    const markdown = ['## 第一章 编制说明', '### 1.1 编制说明', '### 1.2 工程概况', '### 1.3 施工部署'].join('\n');
    expect(sectionNumberingIssues(markdown)).toEqual([]);
  });

  it('跳号（1.1/1.3）→ 报缺号 blocker', () => {
    const markdown = ['## 第一章 编制说明', '### 1.1 编制说明', '### 1.3 施工部署'].join('\n');
    const issues = sectionNumberingIssues(markdown);
    expect(issues.some(issue => issue.message.includes('小节编号缺号') && issue.message.includes('1.2'))).toBe(true);
    expect(issues.every(issue => issue.severity === 'blocker' && issue.category === 'structure')).toBe(true);
  });

  it('重复编号（2.2 出现两次）→ 报重复', () => {
    const markdown = ['## 第二章 施工组织', '### 2.1 施工部署', '### 2.2 基坑支护', '### 2.2 土方开挖'].join('\n');
    const issues = sectionNumberingIssues(markdown);
    expect(issues.some(issue => issue.message.includes('小节编号重复') && issue.message.includes('2.2'))).toBe(true);
  });

  it('章号错位（第2章内出现 3.2）→ 报章号错位', () => {
    const markdown = ['## 第二章 施工组织', '### 2.1 施工部署', '### 3.2 基坑支护'].join('\n');
    const issues = sectionNumberingIssues(markdown);
    expect(issues.some(issue => issue.message.includes('小节编号章号错位') && issue.message.includes('3.x'))).toBe(true);
  });

  it('真实缺陷形态复现：降级合并后 1.16/1.19 跳号 → 报缺号', () => {
    // 完整 1..24 序列中缺 1.16、1.19（跳号根因：降级块曾占用编号）
    const numbers = Array.from({ length: 24 }, (_, index) => index + 1).filter(number => number !== 16 && number !== 19);
    const markdown = ['## 第一章 施工组织', ...numbers.map(number => `### 1.${number} 小节${number}`)].join('\n');
    const issues = sectionNumberingIssues(markdown);
    expect(issues.some(issue => issue.message.includes('小节编号缺号') && issue.message.includes('1.16') && issue.message.includes('1.19'))).toBe(true);
  });

  it('多章独立校验：第一章连续不报、第二章缺号报', () => {
    const markdown = [
      '## 第一章 编制说明',
      '### 1.1 编制说明',
      '### 1.2 工程概况',
      '## 第二章 施工组织',
      '### 2.1 施工部署',
      '### 2.3 基坑支护',
    ].join('\n');
    const issues = sectionNumberingIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('第2章');
  });
});

// ── A-4：L5 块数守恒门禁（sectionCountOverflowIssues）──

describe('sectionCountOverflowIssues L5 块数守恒门禁（A-4）', () => {
  const makeChapter = (overrides: Record<string, unknown>): DocumentDraftChapter => ({ id: 'ch-1', title: '施工组织', content: '', sections: [], ...overrides } as unknown as DocumentDraftChapter);

  it('成稿 H3 数 = 规划小节数 → 不报', () => {
    const chapter = makeChapter({
      sections: ['施工部署', '基坑支护施工', '土方开挖施工'],
      content: ['## 施工组织', '### 施工部署', '正文。', '### 基坑支护施工', '正文。', '### 土方开挖施工', '正文。'].join('\n'),
    });
    expect(sectionCountOverflowIssues([chapter])).toEqual([]);
  });

  it('拆半对合并为一个小节（去重后 1 条 vs 正文 1 个 H3）→ 不报', () => {
    const chapter = makeChapter({
      title: '装饰装修工程',
      sections: ['零星装饰工程'],
      content: ['## 装饰装修工程', '### 零星装饰工程', '半块一正文。', '半块二正文。'].join('\n'),
    });
    expect(sectionCountOverflowIssues([chapter])).toEqual([]);
  });

  it('LLM 擅加节（正文 4 个 H3 > 规划 3 个）→ 报超出 + 规划外标题', () => {
    const chapter = makeChapter({
      sections: ['施工部署', '基坑支护施工', '土方开挖施工'],
      content: ['## 施工组织', '### 施工部署', '正文。', '### 基坑支护施工', '正文。', '### 土方开挖施工', '正文。', '### 现场平面布置', '正文。'].join('\n'),
    });
    const issues = sectionCountOverflowIssues([chapter]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('成稿小节超出主题块数');
    expect(issues[0]!.message).toContain('现场平面布置');
    expect(issues[0]!.severity).toBe('blocker');
    expect(issues[0]!.category).toBe('structure');
  });

  it('缺节（正文 2 个 H3 < 规划 3 个）→ 不报（缺节方向由 section-content-integrity 覆盖）', () => {
    const chapter = makeChapter({
      sections: ['施工部署', '基坑支护施工', '土方开挖施工'],
      content: ['## 施工组织', '### 施工部署', '正文。', '### 基坑支护施工', '正文。'].join('\n'),
    });
    expect(sectionCountOverflowIssues([chapter])).toEqual([]);
  });

  it('无规划 sections 的章 → 跳过（无基准不守恒）', () => {
    const chapter = makeChapter({
      sections: [],
      content: ['## 施工组织', '### 施工部署', '正文。', '### 基坑支护施工', '正文。', '### 土方开挖施工', '正文。'].join('\n'),
    });
    expect(sectionCountOverflowIssues([chapter])).toEqual([]);
  });

  it('分部章容器小节豁免：wrapper 提升（容器 → 多个分部块 H3）不误报', () => {
    const chapter = makeChapter({
      title: '主要施工方法',
      sections: ['主要施工方法'],
      content: ['## 主要施工方法', '### 浅基础施工', '正文。', '### 主体结构施工', '正文。', '### 装饰装修施工', '正文。'].join('\n'),
    });
    expect(sectionCountOverflowIssues([chapter])).toEqual([]);
  });

  it('正文附录 H3 双侧豁免：不干扰守恒计数', () => {
    const chapter = makeChapter({
      sections: ['施工部署'],
      content: ['## 施工组织', '### 施工部署', '正文。', '### 附录一 材料清单', '附件正文。'].join('\n'),
    });
    expect(sectionCountOverflowIssues([chapter])).toEqual([]);
  });

  it('多章独立：仅超标章报（正常章不报）', () => {
    const normal = makeChapter({
      id: 'ch-1',
      sections: ['施工部署', '工程概况'],
      content: ['## 施工组织', '### 施工部署', '正文。', '### 工程概况', '正文。'].join('\n'),
    });
    const overflow = makeChapter({
      id: 'ch-2',
      title: '质量控制',
      sections: ['质量目标'],
      content: ['## 质量控制', '### 质量目标', '正文。', '### 质量保证措施', '正文。'].join('\n'),
    });
    const issues = sectionCountOverflowIssues([normal, overflow]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.chapterId).toBe('ch-2');
  });
});

// ── B-1：工作包三要素硬门 ──

describe('workPackageElementsMeetLenientGate 三要素硬门（B 模块）', () => {
  it('概况+工序+方法三要素齐备 → 通过', () => {
    const block = '施工概况：本项目基坑面积约1.2万㎡。\n施工工序：先放线定位，再土方开挖，随后支护施工，最后验收。\n施工方法：采用分层开挖、土钉墙支护工艺。';
    expect(workPackageElementsMeetLenientGate(block)).toBe(true);
  });

  it('只有施工方法、缺工序顺序 → 不通过', () => {
    const block = '施工方法：采用分层开挖工艺，土钉间距1.2m。';
    expect(workPackageElementsMeetLenientGate(block)).toBe(false);
  });

  it('工序顺序（箭头链）+方法、缺概况 → 不通过（三要素全齐才放行）', () => {
    // C1 收紧：降级验收从「工序必备、其余二选一」收紧为三要素齐全（与验收同源），
    // 缺概况要素的块不再被降级放行出厂
    const block = '工艺流程：基层清理 → 放线定位 → 分层摊铺 → 碾压 → 检测验收。\n施工方法：机械碾压，压实度不低于95%。';
    expect(workPackageElementsMeetLenientGate(block)).toBe(false);
  });
});

// ── C-3：危大分级判定交叉质检 ──

describe('excavationHazardClassificationIssues 危大分级（C 模块）', () => {
  it('深度 5.15m 且正文无危大标注 → 报危大+超危大两条', () => {
    const issues = excavationHazardClassificationIssues('基坑开挖按放坡施工，坑底设置排水沟。', factsModelWithDepth('5.15m'));
    expect(issues.length).toBe(2);
    expect(issues[0].message).toContain('危大工程判定缺失');
    expect(issues[1].message).toContain('超危大工程判定缺失');
  });

  it('深度 5.15m 正文已标危大但缺超危大 → 只报超危大', () => {
    const markdown = '本工程基坑开挖深度5.15m，属于危大工程。';
    const issues = excavationHazardClassificationIssues(markdown, factsModelWithDepth('5.15m'));
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('超危大工程判定缺失');
  });

  it('深度 ≥5m 且标注完整（危大+超过一定规模+专家论证）→ 不报', () => {
    const markdown = '本工程基坑开挖深度5.15m，属于超过一定规模的危大工程，专项方案须经专家论证。';
    expect(excavationHazardClassificationIssues(markdown, factsModelWithDepth('5.15m'))).toEqual([]);
  });

  it('深度 <3m → 不检测', () => {
    expect(excavationHazardClassificationIssues('基坑开挖施工。', factsModelWithDepth('2.5m'))).toEqual([]);
  });

  it('无 canonical 槽位时图纸无关键词门的文本不误采（如建筑高度 28.9m）', () => {
    const factsModel = {
      drawings: [{ key: '设计说明', fieldName: '', value: '建筑消防高度28.90米，地上6层' }],
    } as unknown as DocumentFactsModel;
    expect(excavationHazardClassificationIssues('基坑开挖按放坡施工。', factsModel)).toEqual([]);
  });

  it('canonical 值含 3.2m 与条文「16m及以上」→ 取 3.2 不误取 16（不误报超危大）', () => {
    const factsModel = {
      canonical: { byKey: { excavation_depth: { value: '3.2m（图纸标注：坡底线；开挖深度16m及以上的人工挖孔桩工程）' } } },
      drawings: [], project: [], preciseFacts: [],
    } as unknown as DocumentFactsModel;
    expect(excavationHazardClassificationIssues('本工程基坑开挖深度3.2m，属于危大工程。', factsModel)).toEqual([]);
  });

  it('图纸事实文本含条文「开挖深度16m及以上」→ 不采 16 压过真实深度', () => {
    const factsModel = {
      canonical: { byKey: { excavation_depth: { value: '3.2m（图纸标注：坡底线）' } } },
      drawings: [{ key: '设计说明', fieldName: '', value: '开挖深度16m及以上的人工挖孔桩工程' }],
      project: [], preciseFacts: [],
    } as unknown as DocumentFactsModel;
    expect(excavationHazardClassificationIssues('本工程基坑开挖深度3.2m，属于危大工程。', factsModel)).toEqual([]);
  });
});

// ── C-5：基坑深度权威提取（修复链「基坑深度数值未锁定」补写指令的确定性数值来源）──

describe('excavationDepthFromFacts 深度权威提取（C 模块）', () => {
  it('canonical 槽位含 5.15m → 提取 5.15（修复指令权威口径）', () => {
    expect(excavationDepthFromFacts(factsModelWithDepth('5.15m（图纸标注：-5.150 坡底线）'))).toBe(5.15);
  });

  it('canonical 值含条文「16m及以上」→ 取 5.15 不误取 16', () => {
    const factsModel = {
      canonical: { byKey: { excavation_depth: { value: '5.15m（图纸标注：-5.150 坡底线；开挖深度16m及以上的人工挖孔桩工程）' } } },
      drawings: [], project: [], preciseFacts: [],
    } as unknown as DocumentFactsModel;
    expect(excavationDepthFromFacts(factsModel)).toBe(5.15);
  });

  it('无 excavation_depth 事实 → undefined（不注入权威口径）', () => {
    const factsModel = {
      canonical: { byKey: {} },
      drawings: [], project: [], preciseFacts: [],
    } as unknown as DocumentFactsModel;
    expect(excavationDepthFromFacts(factsModel)).toBeUndefined();
  });

  it('图纸事实文本含坡底线标注（无 canonical 槽位）→ 关键词门提取', () => {
    const factsModel = {
      canonical: { byKey: {} },
      drawings: [{ key: '基坑支护平面图', fieldName: '', value: '坡底线 -5.150m' }],
      project: [], preciseFacts: [],
    } as unknown as DocumentFactsModel;
    expect(excavationDepthFromFacts(factsModel)).toBe(5.15);
  });
});

// ── C-4：支护形式事实一致性 ──

describe('supportFormFactConsistencyIssues 支护形式一致性（C 模块）', () => {
  it('资料为土钉墙、正文出现支护桩 → 报资料外支护体系 + 形式未落地', () => {
    const issues = supportFormFactConsistencyIssues('基坑支护采用支护桩，冠梁顶面标高-1.200。', factsModelWithSupportForm('基坑支护形式：土钉墙'));
    expect(issues.length).toBe(2);
    expect(issues[0].message).toContain('支护形式与资料矛盾');
    expect(issues[0].message).toContain('支护桩');
    expect(issues[1].message).toContain('支护形式未落地');
  });

  it('资料为土钉墙、正文落地土钉墙 → 不报', () => {
    expect(supportFormFactConsistencyIssues('基坑支护采用土钉墙，土钉长度6m。', factsModelWithSupportForm('基坑支护形式：土钉墙'))).toEqual([]);
  });

  it('否定声明句「不采用支护桩」→ 不计为编造（仅报形式未落地）', () => {
    const issues = supportFormFactConsistencyIssues('基坑支护不采用支护桩、不设置冠梁，按图纸放坡开挖。', factsModelWithSupportForm('基坑支护形式：土钉墙'));
    expect(issues.some(issue => issue.message.includes('支护形式与资料矛盾'))).toBe(false);
  });

  it('资料支护形式未在正文落地 → 报未落地', () => {
    const issues = supportFormFactConsistencyIssues('基坑开挖与支护施工按规范执行。', factsModelWithSupportForm('基坑支护形式：土钉墙'));
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('支护形式未落地');
  });
});

// ── D-2：设备进场时间合理性 ──

describe('equipmentEntryTimingIssues 设备进场时间（D 模块）', () => {
  const scheduleFactsModel = {
    schedule: [{ key: '计划工期', fieldId: 'schedule_requirement', value: '计划工期：210日历天' }],
  } as unknown as DocumentFactsModel;

  it('总工期 210 天、挖掘机第210日进场 → 已达总工期报荒谬', () => {
    const markdown = '施工部署\n计划工期210日历天。\n挖掘机第210日进场。';
    const issues = equipmentEntryTimingIssues(markdown, scheduleFactsModel);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('设备进场时间荒谬');
    expect(issues[0].message).toContain('挖掘机');
  });

  it('基坑设备晚于基坑支护完成节点进场 → 工序倒挂', () => {
    const markdown = '进度安排\n第75日完成基坑支护及土方外运。\n挖掘机第90日进场。';
    const issues = equipmentEntryTimingIssues(markdown, scheduleFactsModel);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('设备进场工序倒挂');
  });

  it('设备早于基坑支护完成节点且远早于总工期 → 不报', () => {
    const markdown = '进度安排\n计划工期210日历天。\n第75日完成基坑支护及土方外运。\n挖掘机第10日进场。';
    expect(equipmentEntryTimingIssues(markdown, scheduleFactsModel)).toEqual([]);
  });
});

// ── D-1：工期冲突升 error 与子项分层豁免 ──

describe('crossChapterConsistencyIssues 工期口径（D-1）', () => {
  const durationModel = {
    project: [], schedule: [{ key: '计划工期', fieldId: 'schedule_requirement', value: '计划工期：210日历天' }], quality: [],
  } as unknown as DocumentFactsModel;
  // 确定性嵌入替身：避免加载本地语义 provider（总量口径词→负例原型放行）
  const embedDocuments = async (texts: string[]) => texts.map(text => {
    const gapLike = /占地面积|分项费用|暂列金额/u.test(text);
    const totalLike = /总建筑面积|建设规模|合同估算价|投资估算/u.test(text);
    return [gapLike ? 1 : 0, totalLike ? 1 : 0];
  });

  it('正文工期与资料不一致 → 报 error 级跨章冲突', async () => {
    const issues = await crossChapterConsistencyIssues('施工部署\n计划工期45日历天。', durationModel, undefined, undefined, embedDocuments);
    const durationIssues = issues.filter(issue => issue.message.includes('工期不一致'));
    expect(durationIssues.length).toBe(1);
    expect(durationIssues[0].level).toBe('error');
  });

  it('子项分层工期（基础施工工期45日历天）→ 不报总工期冲突', async () => {
    const issues = await crossChapterConsistencyIssues('施工部署\n计划工期210日历天。\n基础施工工期45日历天，主体结构工期120日历天。', durationModel, undefined, undefined, embedDocuments);
    expect(issues.filter(issue => issue.message.includes('工期不一致'))).toEqual([]);
  });

  it('工期顺延条款（顺延不超过30日历天）→ 不报总工期冲突', async () => {
    const issues = await crossChapterConsistencyIssues('施工部署\n计划工期210日历天。\n因不可抗力工期相应顺延不超过30日历天。', durationModel, undefined, undefined, embedDocuments);
    expect(issues.filter(issue => issue.message.includes('工期不一致'))).toEqual([]);
  });
});

// ── E-1：规划小节归一去重 ──

describe('dedupePlannedSections 规划小节去重（E 模块）', () => {
  it('编号残留/尾部标点归一化等价 → 去重保留首次出现', () => {
    const sections = ['4.1 基坑支护施工', '基坑支护施工', '基坑开挖与支护', '基坑开挖与支护。'];
    expect(dedupePlannedSections(sections)).toEqual(['4.1 基坑支护施工', '基坑开挖与支护']);
  });

  it('不同内容小节 → 全保留', () => {
    const sections = ['基坑支护施工', '土方开挖施工', '降水排水施工'];
    expect(dedupePlannedSections(sections)).toEqual(sections);
  });
});

// ── C-0：图纸标注事实补抽（CAD 语义标注 → canonical 槽位） ──

describe('extractDrawingAnnotationFacts 图纸标注事实补抽（C 模块）', () => {
  it('CAD 两行形态「-5.150\n坡底线」→ 深度 5.15m；「钢管土钉开孔大样」→ 土钉墙', () => {
    const facts = extractDrawingAnnotationFacts([
      { content: '-5.150\n坡底线\n钢管土钉开孔大样', filePath: '基坑支护设计图.dwg', processingType: 'drawing' },
    ]);
    const depth = facts.find(fact => fact.fieldId === 'excavation_depth');
    const form = facts.find(fact => fact.fieldId === 'foundation_support_form');
    expect(depth?.value).toContain('5.15m');
    expect(form?.value).toContain('土钉墙');
  });

  it('「1# 基坑开挖深度 5.2m」取 5.2 不取编号 1；「坡比 1:0.75」不误采比值', () => {
    const facts = extractDrawingAnnotationFacts([
      { content: '1# 基坑开挖深度 5.2m\n坡比 1:0.75 坡底线', filePath: '基坑支护设计图.dwg', processingType: 'drawing' },
    ]);
    const depth = facts.find(fact => fact.fieldId === 'excavation_depth');
    expect(depth?.value).toContain('5.2m');
    expect(depth?.value).not.toContain('1m');
  });

  it('「坑底H-1500」集水井大样 H 标注形态 → 不提取深度', () => {
    const facts = extractDrawingAnnotationFacts([
      { content: '集水坑大样\n坑底H-1500', filePath: '基坑大样图.dwg', processingType: 'drawing' },
    ]);
    expect(facts).toEqual([]);
  });

  it('非图纸证据（无 CAD 标识）→ 不产出', () => {
    const facts = extractDrawingAnnotationFacts([
      { content: '基坑采用钢管土钉支护。', filePath: '技术标.pdf' },
    ]);
    expect(facts).toEqual([]);
  });

  it('一行含多支护形式「放坡 + 锚杆」→ 两种形式均采样', () => {
    const facts = extractDrawingAnnotationFacts([
      { content: '放坡 + 锚杆支护段大样', filePath: '基坑支护设计图.dwg', processingType: 'drawing' },
    ]);
    const form = facts.find(fact => fact.fieldId === 'foundation_support_form');
    expect(form?.value).toContain('放坡开挖');
    expect(form?.value).toContain('锚杆支护');
  });

  it('补抽事实经候选评分不被 reject，且进入 canonical 主表（无嵌套重复候选）', () => {
    const facts = extractDrawingAnnotationFacts([
      { content: '-5.150\n坡底线\n钢管土钉开孔大样', filePath: '基坑支护设计图.dwg', processingType: 'drawing' },
    ]);
    const candidates = collectStructuredFactCandidates(facts);
    const depthCandidates = candidates.filter(candidate => candidate.fieldKey === 'excavation_depth');
    const formCandidates = candidates.filter(candidate => candidate.fieldKey === 'foundation_support_form');
    expect(depthCandidates.length).toBe(1);
    expect(depthCandidates[0].rejected).toBe(false);
    expect(formCandidates.length).toBe(1);
    expect(formCandidates[0].rejected).toBe(false);
    const canonical = buildCanonicalFacts({ facts });
    expect(canonical.get('excavation_depth')?.value).toContain('5.15m');
    expect(canonical.get('foundation_support_form')?.value).toContain('土钉墙');
  });

  it('37 号令目录条文「开挖深度16m及以上的人工挖孔桩工程」→ 不采为项目深度', () => {
    const facts = extractDrawingAnnotationFacts([
      { content: '基坑支护说明\n开挖深度16m及以上的人工挖孔桩工程', filePath: '幕墙工程图.dwg', processingType: 'drawing' },
    ]);
    expect(facts.find(fact => fact.fieldId === 'excavation_depth')).toBeUndefined();
  });

  it('条文与真实坡底线标注共存 → 取 5.15m 不取 16m（真实回归形态）', () => {
    const facts = extractDrawingAnnotationFacts([
      { content: '-5.150\n坡底线\n开挖深度16m及以上的人工挖孔桩工程', filePath: '基坑支护设计图.dwg', processingType: 'drawing' },
    ]);
    const depth = facts.find(fact => fact.fieldId === 'excavation_depth');
    expect(depth?.value).toContain('5.15m');
    expect(depth?.value).not.toContain('16m');
  });
});
