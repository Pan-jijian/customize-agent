/**
 * t3-mf M1 组：markdownComposer 清洗/归一/标题治理纯函数族边界枚举。
 * 覆盖：removeUnwantedDrawingImages / normalizeProductionText / normalizeTenderSourcePageRefs /
 * hasInlineListCollision / normalizeInlineListBreaks / normalizeMarkdownTableDividers /
 * stripMarkdownDocumentFence / cleanFormalSourcePhrases / sourcePhraseIssues /
 * sectionHeadingIssues / dedupeTertiaryH4Titles / sectionDuplicateIssues / mergeTableLineBreaks /
 * sanitizeFormalMarkdown / removeAdjacentDuplicateHeadings / dedupeCrossLevelHeadingDuplicates /
 * dedupeRepeatedBlocksWithinSections / extractGeneratedSections / normalizeTertiaryHeadings /
 * tertiaryHeadingIssues / inferChapterSectionsFromMarkdown / applyPromptDocumentRules /
 * ensureFormalToc / findChapterBlock / plannedStructurePrompt / plannedStructureIssues /
 * promptDocumentRuleIssues / finalizeDocumentMarkdown / composeDocumentMarkdown / 规则常量族。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_L0_COMMON_PREFIX,
  FORMAL_WRITING_RULES,
  L0_WRITER_SYSTEM_PREFIX,
  MARKDOWN_TABLE_FORMAT_RULES,
  SECTION_GENERATION_SAFETY_RULES,
  TENDER_BID_WRITING_RULES,
  applyPromptDocumentRules,
  cleanFormalSourcePhrases,
  composeDocumentMarkdown,
  dedupeCrossLevelHeadingDuplicates,
  dedupeRepeatedBlocksWithinSections,
  dedupeTertiaryH4Titles,
  docSystemPrefix,
  ensureFormalToc,
  extractGeneratedSections,
  finalizeDocumentMarkdown,
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
} from '@/services/document-workflow/markdownComposer';
import type { DocumentDraftChapter, DocumentTemplate, DocumentTemplateChapter, PromptDocumentRuleSet } from '@/services/document-workflow/types';

const draftChapter = (title: string, content = '', sections: string[] = []): DocumentDraftChapter => ({
  id: 'd1', title, content, evidence: [], missingFacts: [], sections,
});
const tplChapter = (title: string, sections: string[] = [], tableSections: string[] = []): DocumentTemplateChapter => ({
  id: 't1', title, purpose: '', queries: [], requiredFacts: [], sections, tableSections,
});

// ═══════ M1 图纸图片清理 ═══════
describe('M1 removeUnwantedDrawingImages', () => {
  it('forbid=false → 原样', () => {
    const md = '![图纸1](a.png)';
    expect(removeUnwantedDrawingImages(md, false)).toBe(md);
  });

  it('forbid=true + 图纸图 → 整行删除', () => {
    const md = '正文\n![给排水图纸](a.png)\n后续';
    expect(removeUnwantedDrawingImages(md, true)).toBe('正文\n\n后续');
  });

  it('CAD/地图/平面图类图 → 删除', () => {
    const md = '![总平面图](p.png)';
    expect(removeUnwantedDrawingImages(md, true)).toBe('');
  });

  it('非图纸图（现场照片）→ 保留', () => {
    const md = '![现场照片](f.png)';
    expect(removeUnwantedDrawingImages(md, true)).toBe(md);
  });
});

// ═══════ M2 产出文本归一 ═══════
describe('M2 normalizeProductionText', () => {
  it('m2/m²/㎡2 形态 → 平方米（数字紧贴 m 不转换）', () => {
    // 真行为：\b 词边界——数字紧贴 m（'80m²'）无边界不转换；'120 m2' 空格形态与 '60㎡2'（㎡ 非 \w）转换
    expect(normalizeProductionText('面积 120 m2 与 80m² 及 60㎡2')).toBe('面积 120 平方米 与 80m² 及 60平方米');
  });

  it('m3 空格形态 → 立方米', () => {
    expect(normalizeProductionText('土方 100 m3、20 m3')).toBe('土方 100 立方米、20 立方米');
  });

  it('数字紧贴 m3/上标 m³ → 原样（\b 无边界不转换）', () => {
    expect(normalizeProductionText('土方 100m3、20 m³')).toBe('土方 100m3、20 m³');
  });

  it('mm2/cm2/km2 空格形态 → 平方毫米/平方厘米/平方千米', () => {
    expect(normalizeProductionText('5 mm2、3 cm2、2 km2')).toBe('5 平方毫米、3 平方厘米、2 平方千米');
  });

  it('数字紧贴 mm2/cm2/km2 → 原样', () => {
    expect(normalizeProductionText('5mm2、3cm2、2km2')).toBe('5mm2、3cm2、2km2');
  });

  it('数字+平方（后跟数字）→ 数字平方米', () => {
    expect(normalizeProductionText('约120平方，其中')).toBe('约120平方米，其中');
  });

  it('「原则上」剔除', () => {
    expect(normalizeProductionText('原则上按规范执行')).toBe('按规范执行');
  });

  it('×/≤/≥/± 两侧空白归一', () => {
    expect(normalizeProductionText('a × b ≤ c ≥ d ± e')).toBe('a×b≤c≥d±e');
  });

  it('「120平方米」已合法不重复替换', () => {
    expect(normalizeProductionText('面积120平方米')).toBe('面积120平方米');
  });

  it('无变化输入原样返回', () => {
    expect(normalizeProductionText('普通正文')).toBe('普通正文');
  });
});

// ═══════ M3 招标页码引用归一 ═══════
describe('M3 normalizeTenderSourcePageRefs', () => {
  it('PDF 第 N 页 → 相关资料', () => {
    expect(normalizeTenderSourcePageRefs('详见 PDF 第 5 页。')).toBe('详见 相关资料。');
  });

  it('PDF 第 5-8 页 范围形态 → 相关资料', () => {
    expect(normalizeTenderSourcePageRefs('详见 PDF 第 5-8 页。')).toBe('详见 相关资料。');
  });

  it('PDF 第 残片（无数字）→ 前缀保留、残片删除', () => {
    expect(normalizeTenderSourcePageRefs('日期：2026年8月19 日 PDF 第')).toBe('日期：2026年8月19 日 ');
  });

  it('第 N 页/共 M 页 → 页码对逐侧归一为相关资料', () => {
    // 真行为：L84 的「/共」形态要求斜杠后直接接数字，「第 5 页/共 10 页」不匹配，由两侧「第 N 页」规则
    // 分别归一为「相关资料」
    expect(normalizeTenderSourcePageRefs('第 5 页/共 10 页')).toBe('相关资料/相关资料');
  });

  it('第 N 页 → 相关资料', () => {
    expect(normalizeTenderSourcePageRefs('见第 3 页')).toBe('见相关资料');
  });

  it('装饰工程施工图纸 12 页 → 装饰工程施工图纸', () => {
    expect(normalizeTenderSourcePageRefs('装饰工程施工图纸 12 页')).toBe('装饰工程施工图纸');
  });

  it('12 页 装饰专业图纸 → 装饰专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('12 页 装饰专业图纸')).toBe('装饰专业图纸');
  });

  it('给排水（5 页）→ 给排水专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('给排水（5 页）')).toBe('给排水专业图纸');
  });

  it('依据图纸（3页）→ 依据施工图纸（前缀并入工程名）', () => {
    // 真行为：L91 工程名正则先于 L93 兜底执行，$1 取「依据」
    expect(normalizeTenderSourcePageRefs('依据图纸（3页）执行')).toBe('依据施工图纸执行');
  });

  it('依据清单（3页）→ 依据工程量清单', () => {
    expect(normalizeTenderSourcePageRefs('依据清单（3页）填写')).toBe('依据工程量清单填写');
  });

  it('资料（5页）→ 项目资料', () => {
    expect(normalizeTenderSourcePageRefs('资料（5页）')).toBe('项目资料');
  });

  it('重复相关资料归并（前缀被兜底规则吃掉）', () => {
    // 真行为：L96 兜底正则吃「位于」前缀后归并重复
    expect(normalizeTenderSourcePageRefs('位于相关资料 相关资料 处')).toBe('相关资料 处');
  });

  it('无页码引用 → 原样', () => {
    expect(normalizeTenderSourcePageRefs('普通正文无页码')).toBe('普通正文无页码');
  });
});

// ═══════ M4 行内列表 ═══════
describe('M4 hasInlineListCollision / normalizeInlineListBreaks', () => {
  it('行内两处编号列表 → 冲突', () => {
    expect(hasInlineListCollision('首先完成检查。1. 开始铺设。2. 进行碾压')).toBe(true);
  });

  it('带单位小数（1.2mm）→ 不冲突', () => {
    expect(hasInlineListCollision('厚度 1.2mm 与 2.5MPa 控制')).toBe(false);
  });

  it('单处编号 → 不冲突', () => {
    expect(hasInlineListCollision('完成检查。1. 开始铺设')).toBe(false);
  });

  it('句末标点+编号 → 拆行', () => {
    expect(normalizeInlineListBreaks('完成检查；1. 开始铺设。')).toBe('完成检查；\n1. 开始铺设。');
  });

  it('（1）形态拆行', () => {
    expect(normalizeInlineListBreaks('完成检查。（1）开始铺设。')).toBe('完成检查。\n（1）开始铺设。');
  });

  it('表格行不拆', () => {
    const md = '| 步骤 | 1. 内容 |';
    expect(normalizeInlineListBreaks(md)).toBe(md);
  });

  it('3 连空行归一为双换行', () => {
    expect(normalizeInlineListBreaks('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

// ═══════ M5 表格分隔线归一 ═══════
describe('M5 normalizeMarkdownTableDividers', () => {
  it('标准表格 → 分隔行归一为 --- 形态（非原样）', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |';
    expect(normalizeMarkdownTableDividers(md)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('无分隔线表格（表头+数据连续）→ 自动插入分隔线', () => {
    const md = '| 序号 | 内容 |\n| 1 | 说明 |';
    const out = normalizeMarkdownTableDividers(md);
    expect(out).toContain('| 序号 | 内容 |');
    expect(out).toContain('| --- | --- |');
    expect(out).toContain('| 1 | 说明 |');
  });

  it('数据行缺行尾竖线 → 补齐为表头列数', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2';
    const out = normalizeMarkdownTableDividers(md);
    expect(out).toContain('| 1 | 2 |');
  });

  it('表头缺竖线（3 列）→ 不识别为表格，原样', () => {
    // 真行为：isMarkdownTableRow 要求首尾竖线齐全，缺尾竖线表头整表不做分隔线补插
    const md = '| a | b | c\n| 1 | 2 | 3';
    expect(normalizeMarkdownTableDividers(md)).toBe(md);
  });

  it('非表格行原样', () => {
    const md = '普通正文\n下一段';
    expect(normalizeMarkdownTableDividers(md)).toBe(md);
  });

  it('3 连空行归一', () => {
    expect(normalizeMarkdownTableDividers('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

// ═══════ M6 代码围栏剥离 ═══════
describe('M6 stripMarkdownDocumentFence', () => {
  it('```markdown 围栏 → 内容', () => {
    expect(stripMarkdownDocumentFence('```markdown\n# 标题\n正文\n```')).toBe('# 标题\n正文');
  });

  it('``` 裸围栏 → 内容', () => {
    expect(stripMarkdownDocumentFence('```\n正文\n```')).toBe('正文');
  });

  it('无围栏 → 原样', () => {
    expect(stripMarkdownDocumentFence('# 标题\n正文')).toBe('# 标题\n正文');
  });

  it('围栏外带空白 → 内内容 trim', () => {
    expect(stripMarkdownDocumentFence('  ```md\n内容\n```  ')).toBe('内容');
  });
});

// ═══════ M7 来源罗列清洗 ═══════
describe('M7 cleanFormalSourcePhrases / sourcePhraseIssues', () => {
  it('正文来源罗列 → 清洗后直接进入正文', () => {
    const cleaned = cleanFormalSourcePhrases('本方案根据招标文件、工程量清单、设计图纸，对主体结构施工作出安排。');
    expect(cleaned).not.toContain('招标文件、工程量清单');
  });

  it('编制依据节 → 保留罗列', () => {
    const md = '### 编制依据\n1. 招标文件、补疑澄清文件\n2. 工程量清单';
    expect(cleanFormalSourcePhrases(md)).toContain('招标文件、补疑澄清文件');
  });

  it('表格行 → 跳过清洗', () => {
    const md = '| 依据 | 招标文件、工程量清单 |';
    expect(cleanFormalSourcePhrases(md)).toBe(md);
  });

  it('「本节根据招标文件…」→ 残留「本节」', () => {
    // 真行为：L247 删除「根据…编制」后残留「本节」，L250 兜底正则要求「根据/依据」词面不命中
    expect(cleanFormalSourcePhrases('本节根据招标文件及设计图纸编制。')).toBe('本节');
  });

  it('sourcePhraseIssues：来源罗列 → blocker', () => {
    const issues = sourcePhraseIssues('本方案根据招标文件、工程量清单及设计图纸，作出施工安排。');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('第 1 行');
  });

  it('sourcePhraseIssues：编制依据节 → 豁免', () => {
    expect(sourcePhraseIssues('### 编制依据\n1. 招标文件、补疑澄清文件')).toEqual([]);
  });

  it('sourcePhraseIssues：粗体表名 → format blocker', () => {
    const issues = sourcePhraseIssues('**关键节点控制表**');
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('format');
  });

  it('sourcePhraseIssues 上限 20 条', () => {
    const md = Array.from({ length: 25 }, () => '本方案根据招标文件及设计图纸，作出安排。').join('\n');
    expect(sourcePhraseIssues(md)).toHaveLength(20);
  });
});

// ═══════ M8 H4 标题治理 ═══════
describe('M8 sectionHeadingIssues / dedupeTertiaryH4Titles', () => {
  it('H4 与 H3 同名 → 结构 warning', () => {
    const md = '### 绿化工程\n#### 绿化工程\n正文';
    const issues = sectionHeadingIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('同名');
  });

  it('H4 词尾粘连（非豁免滑窗重复）→ warning', () => {
    const md = '#### 现场踏勘施工条件现场条件\n正文';
    const issues = sectionHeadingIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('粘连');
  });

  it('H4 超 14 字且非专业方案后缀 → 过长 warning', () => {
    const md = '#### 现场踏勘施工条件与周边环境保护措施\n正文';
    const issues = sectionHeadingIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('过长');
  });

  it('「工程施工方案」后缀超 14 字 → 豁免', () => {
    const md = '#### 土方开挖与基坑支护工程施工方案\n正文';
    expect(sectionHeadingIssues(md)).toEqual([]);
  });

  it('正常 H4 → 无 issue', () => {
    expect(sectionHeadingIssues('#### 沟槽开挖\n正文')).toEqual([]);
  });

  it('dedupeTertiaryH4Titles：同名 H4 追加「要点」', () => {
    const out = dedupeTertiaryH4Titles('### 绿化工程\n#### 绿化工程\n正文');
    expect(out.markdown).toContain('#### 绿化工程要点');
    expect(out.fixedCount).toBe(1);
  });

  it('dedupeTertiaryH4Titles：不同名 → 原样 fixedCount 0', () => {
    const out = dedupeTertiaryH4Titles('### 绿化工程\n#### 养护管理\n正文');
    expect(out.markdown).toContain('#### 养护管理');
    expect(out.fixedCount).toBe(0);
  });

  it('dedupeTertiaryH4Titles：编号前缀同名 → 仍修复', () => {
    const out = dedupeTertiaryH4Titles('### 2.1 绿化工程\n#### 2.1.1 绿化工程\n正文');
    expect(out.markdown).toContain('绿化工程要点');
    expect(out.fixedCount).toBe(1);
  });
});

// ═══════ M9 跨小节重复 ═══════
describe('M9 sectionDuplicateIssues', () => {
  const longSentence = '主体结构施工采用标准化模板支撑体系并配置专职质量员每日检查。';

  it('两节 3 句重合且比例达标 → warning', () => {
    // 真行为：句指纹用 Set 去重——同一句复制 3 遍只有 1 个指纹，需 3 个不同长句才能触发 3 句阈值
    const sentenceA = '主体结构施工采用标准化模板支撑体系并配置专职质量员每日检查。';
    const sentenceB = '基坑支护采用拉森钢板桩围护体系并按设计深度分层开挖。';
    const sentenceC = '混凝土浇筑前必须完成钢筋隐蔽工程验收并留存影像资料。';
    const md = ['## 第一章 施工方案', '### 1.1 节一', sentenceA, sentenceB, sentenceC, '第一节独有内容甲。', '### 1.2 节二', sentenceA, sentenceB, sentenceC, '第二节独有内容乙。'].join('\n');
    const issues = sectionDuplicateIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('1.1 节一');
    expect(issues[0].message).toContain('1.2 节二');
  });

  it('无重合 → 无 issue', () => {
    const md = ['## 第一章 施工方案', '### 1.1 节一', longSentence, '### 1.2 节二', '基坑支护采用拉森钢板桩并设专职安全员每日巡查。'].join('\n');
    expect(sectionDuplicateIssues(md)).toEqual([]);
  });

  it('重合不足 3 句 → 不报', () => {
    const md = ['## 第一章 施工方案', '### 1.1 节一', longSentence, '独一甲', '独一乙', '独一丙', '### 1.2 节二', longSentence, longSentence, '独二甲', '独二乙'].join('\n');
    expect(sectionDuplicateIssues(md)).toEqual([]);
  });

  it('跨章相同 → 不比对', () => {
    const md = ['## 第一章 施工方案', '### 1.1 节一', longSentence, '## 第二章 质量保证', '### 2.1 节二', longSentence].join('\n');
    expect(sectionDuplicateIssues(md)).toEqual([]);
  });

  it('表格行与标题行不参与指纹', () => {
    const md = ['## 第一章 施工方案', '### 1.1 节一', longSentence, '| a | b |', '### 1.2 节二', longSentence].join('\n');
    expect(sectionDuplicateIssues(md)).toEqual([]);
  });

  it('低于 24 字句不参与指纹', () => {
    const md = ['## 第一章 施工方案', '### 1.1 节一', '短句甲。', '短句乙。', '短句丙。', '### 1.2 节二', '短句甲。', '短句乙。', '短句丙。'].join('\n');
    expect(sectionDuplicateIssues(md)).toEqual([]);
  });
});

// ═══════ M10 表格断行合并 ═══════
describe('M10 mergeTableLineBreaks', () => {
  it('表格数据行后断行（含 2 竖线）→ 合并进上一行', () => {
    // 真行为：isBrokenRow 要求上一行是完整表格行（首尾竖线齐全），缺尾竖线残行不合并
    const md = '| 序号 | 内容 |\n|---|---|\n| 1 | 部分内容 |\n其余说明 | 补充 |';
    const out = mergeTableLineBreaks(md);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain('部分内容其余说明；补充');
  });

  it('断行紧跟分隔行 → 转为 | 开头行', () => {
    const md = '| 序号 | 内容 |\n|---|---|\n数据断行首段 | 数据断行二段 |';
    const out = mergeTableLineBreaks(md);
    expect(out).toContain('| 数据断行首段 | 数据断行二段 |');
  });

  it('单竖线残行 → 不合并', () => {
    const md = '| 序号 | 内容 |\n|---|---|\n| 1 | 甲 |\n只有一个竖线 | 残行';
    const out = mergeTableLineBreaks(md);
    expect(out).toContain('只有一个竖线');
  });

  it('标题行后文本 → 不合并', () => {
    const md = '### 标题\n正文 | 带竖线 | 的段落';
    expect(mergeTableLineBreaks(md)).toBe(md);
  });

  it('普通文本 → 原样', () => {
    const md = '段落一\n段落二';
    expect(mergeTableLineBreaks(md)).toBe(md);
  });
});

// ═══════ M11 正式文档清洗总链 ═══════
describe('M11 sanitizeFormalMarkdown', () => {
  it('H4 词尾等长两段粘连 → 去重', () => {
    expect(sanitizeFormalMarkdown('#### 现场条件现场条件\n正文')).toBe('#### 现场条件\n正文');
  });

  it('句末标点+行内 H3 → 拆行为独立标题', () => {
    const out = sanitizeFormalMarkdown('复查记录留存影像资料。### 危大工程专项施工方案审批流程\n正文');
    expect(out).toContain('\n\n### 危大工程专项施工方案审批流程');
  });

  it('表格前导句 + 同行表头（单管道对）→ 拆行', () => {
    // 真行为：拆行正则只匹配单管道对收尾形态，多列表头行不拆
    const out = sanitizeFormalMarkdown('具体安排如下表。| 关键节点控制表 |');
    expect(out).toContain('如下表。\n| 关键节点控制表 |');
  });

  it('整行粗体（非提示语）→ H4 标题', () => {
    expect(sanitizeFormalMarkdown('**沟槽开挖工程**\n正文')).toBe('#### 沟槽开挖工程\n正文');
  });

  it('粗体带冒号 → 保留原样', () => {
    expect(sanitizeFormalMarkdown('**注意：** 本段强调')).toBe('**注意：** 本段强调');
  });

  it('承包人案/承包人法 术语 → 归一', () => {
    expect(sanitizeFormalMarkdown('承包人案经审批后执行承包人法：先测量后开挖。')).toBe('方案经审批后执行施工方法：先测量后开挖。');
  });

  it('后台流程话术行 → 删除（无空行归并）', () => {
    // 真行为：行删除后前后行直接相邻（\n 单换行），不补空行
    expect(sanitizeFormalMarkdown('正文\n知识库证据已召回\n后文')).toBe('正文\n后文');
  });

  it('「以上内容已依据…」自我总结段（后跟空行）→ 删除', () => {
    // 真行为：删除正则要求后跟空行（(?=\n\s*\n)），无空行形态不删除
    const out = sanitizeFormalMarkdown('正文\n以上内容已依据本项目资料编写完成\n\n后文');
    expect(out).not.toContain('以上内容已依据');
  });

  it('来源行（来源：xxx）→ 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n来源：招标文件第3页\n后文')).toBe('正文\n\n后文');
  });

  it('ASCII 流程图行（纯符号）→ 删除', () => {
    // 真行为：ASCII_FLOW_LINE_RE 只匹配纯符号行，含文字分支行（'├── 步骤A'）不整行命中
    expect(sanitizeFormalMarkdown('正文\n→→→→\n后文')).toBe('正文\n\n后文');
  });

  it('文件名行（xxx.pdf）→ 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n招标文件.pdf\n后文')).toBe('正文\n\n后文');
  });

  it('一级标题行 → 删前缀符号保留标题文本', () => {
    // 真行为：只删 '# ' 前缀符号（L506 ^#\s+），标题文本保留
    expect(sanitizeFormalMarkdown('# 文档标题\n正文')).toBe('文档标题\n正文');
  });

  it('招标术语 H4（补充条款）→ 标题行与后续短行删除', () => {
    // 真行为：'补充条款' 命中招标条款碎片判别 → 标题行删除；后续 '内容' 短行因前一行
    // 是指令型标题（L515 短行保护规则）一并删除
    expect(sanitizeFormalMarkdown('正文\n#### 补充条款\n内容')).toBe('正文');
  });

  it('特殊气候枚举行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n雨季、冬季、高温、台风、大风等特殊气候\n后文')).toBe('正文\n后文');
  });

  it('尾字「如下」行 → 删除（单字行保留）', () => {
    // 真行为：'安排如下' 命中尾字规则删除；'项目'（2 字）不命中任何规则保留
    expect(sanitizeFormalMarkdown('安排如下\n项目\n正文')).toBe('项目\n正文');
  });
});

// ═══════ M12 相邻重复标题 ═══════
describe('M12 removeAdjacentDuplicateHeadings', () => {
  it('双标题叠加 ## ### → 降级保留 ###', () => {
    expect(removeAdjacentDuplicateHeadings('## ### 施工部署\n正文')).toBe('### 施工部署\n正文');
  });

  it('相邻同结构标题 → 删后行', () => {
    const md = '### 施工部署\n### 施工部署\n正文';
    expect(removeAdjacentDuplicateHeadings(md)).toBe('### 施工部署\n正文');
  });

  it('正文隔断 → 不删', () => {
    const md = '### 施工部署\n正文A\n### 施工部署\n正文B';
    expect(removeAdjacentDuplicateHeadings(md)).toBe(md);
  });

  it('编号不影响结构同源判定', () => {
    const md = '### 1.1 施工部署\n### 1.1 施工部署\n正文';
    expect(removeAdjacentDuplicateHeadings(md)).toBe('### 1.1 施工部署\n正文');
  });

  it('无重复 → 原样', () => {
    const md = '## 第一章 施工方案\n### 1.1 施工部署\n正文';
    expect(removeAdjacentDuplicateHeadings(md)).toBe(md);
  });
});

// ═══════ M13 跨层级同名块去重 ═══════
describe('M13 dedupeCrossLevelHeadingDuplicates', () => {
  const sentence = '本小节采用标准化模板支撑体系并配置专职质量员每日检查。';

  it('H2/H3 同名 + 指纹重合 ≥50% → 删较短块', () => {
    // 真行为：同名 H3 只在「同一 H2 块内」与 H2 比对（scope 到下一 H2 为止），中间插入其他
    // H2 章会截断扫描范围——同名 H3 必须位于该 H2 块内部
    const md = ['## 新技术应用', sentence, sentence, '### 新技术应用', sentence, '## 下一章', '正文'].join('\n');
    const out = dedupeCrossLevelHeadingDuplicates(md);
    expect(out).toContain('## 新技术应用');
    expect(out).not.toContain('### 新技术应用');
  });

  it('重合不足 50% → H2 降级 H3 保留独有内容', () => {
    const md = ['## 新技术应用', '独有甲独有甲独有甲独有甲独有甲独有甲。', '独有乙独有乙独有乙独有乙独有乙独有乙。', '### 新技术应用', sentence].join('\n');
    const out = dedupeCrossLevelHeadingDuplicates(md);
    expect(out).toContain('### 新技术应用');
  });

  it('无同名块 → 原样', () => {
    const md = '## 第一章 施工方案\n### 1.1 施工部署\n正文';
    expect(dedupeCrossLevelHeadingDuplicates(md)).toBe(md);
  });

  it('首个块为 H2 同名场景（开篇重复）→ 同样处理', () => {
    const md = ['## 新技术应用', sentence, sentence, '### 新技术应用', sentence].join('\n');
    const out = dedupeCrossLevelHeadingDuplicates(md);
    expect(out).not.toContain('### 新技术应用');
  });

  it('章节标题与 H3 不同名 → 不受影响', () => {
    const md = ['## 第一章 施工方案', '### 1.1 施工部署', '正文'].join('\n');
    expect(dedupeCrossLevelHeadingDuplicates(md)).toBe(md);
  });
});

// ═══════ M14 同小节相邻段重复 ═══════
describe('M14 dedupeRepeatedBlocksWithinSections', () => {
  const longParagraph = '施工流程：先进行基层清理，再放线定位，随后分层摊铺，然后碾压，最后做压实度检测并验收。';

  it('相邻 3 段内完全重复段（≥24 字）→ 删除', () => {
    const md = ['### 1.1 施工流程', longParagraph, '', longParagraph].join('\n');
    const out = dedupeRepeatedBlocksWithinSections(md);
    expect(out).toContain(longParagraph);
    expect(out.match(/基层清理/gu)).toHaveLength(1);
  });

  it('标题行重置窗口（跨小节重复不删）', () => {
    const md = ['### 1.1 节一', longParagraph, '', '### 1.2 节二', longParagraph].join('\n');
    const out = dedupeRepeatedBlocksWithinSections(md);
    expect(out.match(/基层清理/gu)).toHaveLength(2);
  });

  it('短段（<24 字）→ 不删除', () => {
    const md = '### 1.1 节一\n短段甲。\n\n短段甲。';
    expect(dedupeRepeatedBlocksWithinSections(md)).toBe(md);
  });

  it('窗口超 3 段后重复 → 保留', () => {
    // 真行为：recentFingerprints 只保留最近 3 段（slice(-3)），第 4 段插入时首段指纹已挤出窗口
    const md = ['### 1.1 节一', longParagraph, '', '段落乙段落乙段落乙段落乙段落乙段落乙。', '', '段落丙段落丙段落丙段落丙段落丙段落丙。', '', '段落丁段落丁段落丁段落丁段落丁段落丁。', '', longParagraph].join('\n');
    const out = dedupeRepeatedBlocksWithinSections(md);
    expect(out.match(/基层清理/gu)).toHaveLength(2);
  });
});

// ═══════ M15 成稿小节提取与编号 ═══════
describe('M15 extractGeneratedSections / normalizeTertiaryHeadings / tertiaryHeadingIssues', () => {
  it('提取 H3 标题（displayChapterTitle 归一去编号）', () => {
    expect(extractGeneratedSections('### 1.1 施工部署\n### 1.2 施工进度计划')).toEqual(['施工部署', '施工进度计划']);
  });

  it('指令型标题不提取', () => {
    expect(extractGeneratedSections('### 是否涉及危大工程')).toEqual([]);
  });

  it('重复标题去重', () => {
    expect(extractGeneratedSections('### 1.1 施工部署\n### 1.2 施工部署')).toEqual(['施工部署']);
  });

  it('normalizeTertiaryHeadings：H4 补三级编号', () => {
    const md = '### 1.1 施工部署\n#### 施工准备\n#### 现场布置';
    const out = normalizeTertiaryHeadings(md);
    expect(out).toContain('#### 1.1.1 施工准备');
    expect(out).toContain('#### 1.1.2 现场布置');
  });

  it('粗体表名 → H4 编号', () => {
    const md = '### 1.1 施工部署\n**关键节点控制表**';
    const out = normalizeTertiaryHeadings(md);
    expect(out).toContain('#### 1.1.1 关键节点控制表');
  });

  it('H5 → H4', () => {
    expect(normalizeTertiaryHeadings('##### 子标题')).toBe('#### 子标题');
  });

  it('tertiaryHeadingIssues：H4 缺 X.Y.Z 编号 → warning', () => {
    const issues = tertiaryHeadingIssues('### 1.1 施工部署\n#### 无编号标题');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('1.1.x 编号');
  });

  it('tertiaryHeadingIssues：有编号 → 无 issue', () => {
    expect(tertiaryHeadingIssues('### 1.1 施工部署\n#### 1.1.1 施工准备')).toEqual([]);
  });
});

// ═══════ M16 章节小节推断 ═══════
describe('M16 inferChapterSectionsFromMarkdown', () => {
  const chapters = [draftChapter('施工组织总设计', '', ['规划小节甲']), draftChapter('工程质量保证措施', '')];

  it('从正文 H3 提取各章小节', () => {
    const md = '## 第一章 施工组织总设计\n### 1.1 施工部署\n## 第二章 工程质量保证措施\n### 2.1 质量体系';
    const sections = inferChapterSectionsFromMarkdown(md, chapters);
    expect(sections[0]).toEqual(['施工部署']);
    expect(sections[1]).toEqual(['质量体系']);
  });

  it('章缺失 → 回退规划小节', () => {
    const md = '## 第一章 施工组织总设计\n### 1.1 施工部署';
    const sections = inferChapterSectionsFromMarkdown(md, chapters);
    expect(sections[1]).toEqual([]);
    expect(sections[0]).toEqual(['施工部署']);
  });

  it('章内无 H3 → 回退规划小节', () => {
    const md = '## 第一章 施工组织总设计\n正文无小节\n## 第二章 工程质量保证措施\n### 2.1 质量体系';
    const sections = inferChapterSectionsFromMarkdown(md, chapters);
    expect(sections[0]).toEqual(['规划小节甲']);
  });

  it('正文目录块剔除后提取', () => {
    const md = '## 目录\n 1.1 施工部署\n\n<div class="page-break"></div>\n\n## 第一章 施工组织总设计\n### 1.1 施工部署';
    const sections = inferChapterSectionsFromMarkdown(md, chapters);
    expect(sections[0]).toEqual(['施工部署']);
  });
});

// ═══════ M17 提示词规则应用 ═══════
describe('M17 applyPromptDocumentRules', () => {
  it('无 rules → 基础术语替换', () => {
    expect(applyPromptDocumentRules('本施工方高度重视此项工作')).toBe('我公司严格落实此项工作');
  });

  it('无 rules → 粗体转 H4 + 承包人法', () => {
    expect(applyPromptDocumentRules('**沟槽开挖工程**\n承包人法：先测量后开挖。')).toBe('#### 沟槽开挖工程\n施工方法：先测量后开挖。');
  });

  it('requiredTables 缺失 → 表插入对应章（粗体表名转 H4）', () => {
    const rules: PromptDocumentRuleSet = { forbiddenTerms: [], preferredTerms: [], requiredTables: ['劳动力计划表'] };
    const md = '## 第二章 劳动力组织\n正文';
    const out = applyPromptDocumentRules(md, rules);
    // 真行为：插入模板的粗体表名随后被 applyForbiddenTermReplacements 转为 H4 标题
    expect(out).toContain('#### 劳动力计划表');
    expect(out).toContain('| 控制项目 |');
  });

  it('requiredTables 已存在（粗体表名）→ 不重复插入且粗体转 H4', () => {
    const rules: PromptDocumentRuleSet = { forbiddenTerms: [], preferredTerms: [], requiredTables: ['劳动力计划表'] };
    const md = '## 第二章 劳动力组织\n**劳动力计划表**\n| a | b |';
    expect(applyPromptDocumentRules(md, rules)).toBe('## 第二章 劳动力组织\n#### 劳动力计划表\n| a | b |');
  });

  it('preferredTerms 替换', () => {
    const rules: PromptDocumentRuleSet = { forbiddenTerms: [], preferredTerms: [{ from: '总包单位', to: '我公司' }], requiredTables: [] };
    expect(applyPromptDocumentRules('总包单位负责协调。', rules)).toBe('我公司负责协调。');
  });

  it('施工方替换带边界保护（施工方案/施工方法不误替换）', () => {
    const rules: PromptDocumentRuleSet = { forbiddenTerms: [], preferredTerms: [{ from: '施工方', to: '我公司' }], requiredTables: [] };
    expect(applyPromptDocumentRules('施工方按施工方案组织施工方法。', rules)).toBe('我公司按施工方案组织施工方法。');
  });

  it('forbiddenTerms 商务表名 → 整行删除', () => {
    const rules: PromptDocumentRuleSet = { forbiddenTerms: ['报价明细表'], preferredTerms: [], requiredTables: [] };
    const out = applyPromptDocumentRules('正文\n报价明细表见附件\n后文', rules);
    expect(out).not.toContain('报价明细表');
  });

  it('forbidCover → 封面块移除', () => {
    const rules: PromptDocumentRuleSet = { forbidCover: true, forbiddenTerms: [], preferredTerms: [], requiredTables: [] };
    const md = '<div class="document-cover">封面内容</div>\n\n<div class="page-break"></div>\n\n# 标题\n\n正文';
    const out = applyPromptDocumentRules(md, rules);
    expect(out).not.toContain('document-cover');
    expect(out).not.toContain('# 标题');
  });

  it('forbidToc → 目录块移除', () => {
    const rules: PromptDocumentRuleSet = { forbidToc: true, forbiddenTerms: [], preferredTerms: [], requiredTables: [] };
    const md = '## 目录\n 1.1 小节\n\n<div class="page-break"></div>\n\n## 第一章 施工方案';
    const out = applyPromptDocumentRules(md, rules);
    expect(out).not.toContain('## 目录');
  });
});

// ═══════ M18 正式目录 ═══════
describe('M18 ensureFormalToc', () => {
  const chapters = [draftChapter('施工组织总设计', '## 第一章 施工组织总设计\n### 1.1 施工部署\n正文', ['施工部署'])];

  it('正文无目录 → 前插目录+分页', () => {
    const md = '## 第一章 施工组织总设计\n### 1.1 施工部署\n正文';
    const out = ensureFormalToc(md, chapters);
    expect(out).toContain('## 目录');
    expect(out.indexOf('## 目录')).toBeLessThan(out.indexOf('## 第一章'));
  });

  it('已有目录 → 以确定性目录替换正文目录页', () => {
    const md = '## 目录\n 污染目录项\n\n<div class="page-break"></div>\n\n## 第一章 施工组织总设计\n### 1.1 施工部署\n正文';
    const out = ensureFormalToc(md, chapters);
    expect(out).not.toContain('污染目录项');
    expect(out).toContain('1.1 施工部署');
  });

  it('含分页符 → 目录插入分页符后', () => {
    const md = '<div class="page-break"></div>\n## 第一章 施工组织总设计\n### 1.1 施工部署\n正文';
    const out = ensureFormalToc(md, chapters);
    expect(out).toContain('## 目录');
  });

  it('章标题带编号归一（第一章）', () => {
    const md = '## 第一章 施工组织总设计\n### 1.1 施工部署\n正文';
    const out = ensureFormalToc(md, chapters);
    expect(out).toContain('第一章 施工组织总设计');
  });
});

// ═══════ M19 章块定位 ═══════
describe('M19 findChapterBlock', () => {
  it('按归一标题定位章块', () => {
    const block = findChapterBlock('## 第一章 施工组织总设计\n正文A\n## 第二章 质量保证\n正文B', '施工组织总设计');
    expect(block).toBeTruthy();
    expect(block?.body).toBe('\n正文A\n');
  });

  it('未找到 → undefined', () => {
    expect(findChapterBlock('## 第一章 施工组织总设计\n正文', '不存在的章')).toBeUndefined();
  });

  it('block 含起始与结束索引', () => {
    const md = '## 第一章 施工组织总设计\n正文A\n## 第二章 质量保证\n正文B';
    const block = findChapterBlock(md, '施工组织总设计');
    expect(block?.heading).toBe('## 第一章 施工组织总设计');
    expect(md.slice(block?.start || 0, block?.end)).toBe('## 第一章 施工组织总设计\n正文A\n');
  });
});

// ═══════ M20 规划结构 ═══════
describe('M20 plannedStructurePrompt / plannedStructureIssues', () => {
  const template: DocumentTemplate = {
    id: 't', name: '模板', outputTitle: '', description: '', category: '',
    chapters: [tplChapter('施工组织总设计', ['施工部署', '施工进度计划'])],
  };

  it('prompt 含章与规划小节', () => {
    const prompt = plannedStructurePrompt(template);
    expect(prompt).toContain('- 施工组织总设计');
    expect(prompt).toContain('规划小节：施工部署、施工进度计划');
  });

  it('prompt：无小节章 → 仅标题行', () => {
    const empty = { ...template, chapters: [tplChapter('施工组织总设计')] };
    expect(plannedStructurePrompt(empty)).toBe('- 施工组织总设计');
  });

  it('plannedStructureIssues：章缺失 → error', () => {
    const issues = plannedStructureIssues('## 第一章 其他章\n正文', template);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('缺少章节标题');
  });

  it('plannedStructureIssues：tableSections 无表格 → warning', () => {
    const withTable = { ...template, chapters: [tplChapter('施工组织总设计', [], ['主要工程量表'])] };
    const issues = plannedStructureIssues('## 第一章 施工组织总设计\n正文无表格', withTable);
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('table');
  });

  it('plannedStructureIssues：齐全 → 无 issue', () => {
    const md = '## 第一章 施工组织总设计\n### 1.1 施工部署\n| a | b |\n|---|---|';
    expect(plannedStructureIssues(md, template)).toEqual([]);
  });
});

// ═══════ M21 提示词规则校验 ═══════
describe('M21 promptDocumentRuleIssues', () => {
  // 真行为：buildSemanticGate 首次调用嵌入正例+负例原型（前 3 正例 [1,0]、后 3 负例 [0,1]），
  // 判定时嵌入候选 [1,0]：正例分 1 ≥ 阈值且严格大于负例分才命中——负例同向 [1,0] 时 1>1 不成立恒不命中
  let callCount = 0;
  const embedMock = async (texts: string[]) => {
    callCount += 1;
    return callCount === 1 ? texts.map((_, index) => (index < 3 ? [1, 0] : [0, 1])) : texts.map(() => [1, 0]);
  };
  const baseRules: PromptDocumentRuleSet = { forbiddenTerms: [], preferredTerms: [], requiredTables: [] };

  it('无 rules → 无 issue', async () => {
    expect(await promptDocumentRuleIssues('正文')).toEqual([]);
  });

  it('强句式指令标题 → error', async () => {
    const issues = await promptDocumentRuleIssues('## 是否涉及危大工程专项施工方案\n正文', baseRules);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('指令标题');
  });

  it('弱词根指令标题 + 语义命中 → error', async () => {
    const issues = await promptDocumentRuleIssues('## 如何编写施工方案\n正文', baseRules, embedMock);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('指令标题');
  });

  it('coverPolicy required 缺封面 → error', async () => {
    const rules = { ...baseRules, coverPolicy: 'required' as const };
    const issues = await promptDocumentRuleIssues('## 第一章 施工方案', rules);
    expect(issues.some(issue => issue.message.includes('封面'))).toBe(true);
  });

  it('tocPolicy required 缺目录 → error', async () => {
    const rules = { ...baseRules, tocPolicy: 'required' as const };
    const issues = await promptDocumentRuleIssues('## 第一章 施工方案', rules);
    expect(issues.some(issue => issue.message.includes('目录'))).toBe(true);
  });

  it('forbidCover 残留封面 → error', async () => {
    const rules = { ...baseRules, forbidCover: true };
    const issues = await promptDocumentRuleIssues('# 标题\n正文', rules);
    expect(issues.some(issue => issue.message.includes('残留封面'))).toBe(true);
  });

  it('requiredTables 缺表格 → error（level，severity 未定义）', async () => {
    // 真行为：requiredTables 缺失 issue 直接以 level:'error' 产出，不经过 L1332 的 warning 升级映射（severity 未定义）
    const rules = { ...baseRules, requiredTables: ['劳动力计划表'] };
    const issues = await promptDocumentRuleIssues('## 第一章 施工方案\n正文', rules);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].severity).toBeUndefined();
    expect(issues[0].message).toContain('劳动力计划表');
  });

  it('requiredKeywords 缺失 → 升级 error', async () => {
    const rules = { ...baseRules, requiredKeywords: ['样板引路'] };
    const issues = await promptDocumentRuleIssues('正文', rules);
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
  });

  it('forbiddenTerms 商务豁免词 → 不报', async () => {
    const rules = { ...baseRules, forbiddenTerms: ['综合单价'] };
    const issues = await promptDocumentRuleIssues('正文含综合单价记录。', rules);
    expect(issues.some(issue => issue.message.includes('禁止词'))).toBe(false);
  });

  it('minChars 不足 → warning', async () => {
    const rules = { ...baseRules, minChars: 1000 } as PromptDocumentRuleSet & { minChars?: number };
    const issues = await promptDocumentRuleIssues('短正文', rules);
    expect(issues.some(issue => issue.message.includes('长度低于'))).toBe(true);
  });
});

// ═══════ M22 终稿链 ═══════
describe('M22 finalizeDocumentMarkdown / composeDocumentMarkdown', () => {
  it('finalize：无提示词规则 → 输出目录与正文', () => {
    const chapters = [draftChapter('施工组织总设计', '## 第一章 施工组织总设计\n### 1.1 施工部署\n正文', ['施工部署'])];
    const out = finalizeDocumentMarkdown(chapters[0].content, chapters);
    expect(out.markdown).toContain('## 目录');
    expect(out.markdown).toContain('第一章 施工组织总设计');
  });

  it('finalize：tocPolicy forbidden → 不生成目录', () => {
    const rules: PromptDocumentRuleSet = { tocPolicy: 'forbidden', forbiddenTerms: [], preferredTerms: [], requiredTables: [] };
    const chapters = [draftChapter('施工组织总设计', '## 第一章 施工组织总设计\n### 1.1 施工部署\n正文', ['施工部署'])];
    const out = finalizeDocumentMarkdown(chapters[0].content, chapters, { promptRules: rules });
    expect(out.markdown).not.toContain('## 目录');
  });

  it('finalize：sections 缺失 → 从正文推断补齐', () => {
    const chapters = [draftChapter('施工组织总设计', '## 第一章 施工组织总设计\n### 1.1 施工部署\n正文')];
    const out = finalizeDocumentMarkdown(chapters[0].content, chapters);
    expect(out.chapters[0].sections).toEqual(['施工部署']);
  });

  it('composeDocumentMarkdown：草稿 → 完整文档（封面+目录+正文）', () => {
    const draft = {
      title: '测试项目施工组织设计',
      facts: [],
      chapters: [draftChapter('施工组织总设计', '### 1.1 施工部署\n正文', ['施工部署'])],
    };
    const md = composeDocumentMarkdown(draft as never);
    expect(md).toContain('第一章 施工组织总设计');
    expect(md).toContain('施工部署');
  });

  it('composeDocumentMarkdown：forbidDrawingImages → 图纸图清除', () => {
    const draft = {
      title: '测试项目',
      facts: [],
      chapters: [draftChapter('施工组织总设计', '### 1.1 施工部署\n![总平面图](p.png)\n正文', ['施工部署'])],
    };
    const md = composeDocumentMarkdown(draft as never, { forbidDrawingImages: true });
    expect(md).not.toContain('总平面图');
  });

  it('finalize：空章节列表 → 目录仍生成', () => {
    const out = finalizeDocumentMarkdown('正文', []);
    expect(out.markdown).toContain('## 目录');
  });
});

// ═══════ M23 规则常量与 system 前缀 ═══════
describe('M23 规则常量与 system 前缀', () => {
  it('MARKDOWN_TABLE_FORMAT_RULES 含表格硬约束', () => {
    expect(MARKDOWN_TABLE_FORMAT_RULES).toContain('GFM 表格格式');
    expect(MARKDOWN_TABLE_FORMAT_RULES).toContain('空单元格');
  });

  it('TENDER_BID_WRITING_RULES 含五要素与闭环句式', () => {
    expect(TENDER_BID_WRITING_RULES).toContain('内容落地五要素');
    expect(TENDER_BID_WRITING_RULES).toContain('闭环句式密度硬约束');
  });

  it('FORMAL_WRITING_RULES 首行自限声明', () => {
    expect(FORMAL_WRITING_RULES.startsWith('以下规则仅用于保障导出格式正确和事实安全')).toBe(true);
    expect(FORMAL_WRITING_RULES).toContain('导出格式');
  });

  it('FORMAL_WRITING_RULES 含写作三源规则；旧“计划类字段自行推导”条目已删除', () => {
    expect(FORMAL_WRITING_RULES).toContain('【写作三源规则】');
    expect(FORMAL_WRITING_RULES).toContain('F·项目事实源');
    expect(FORMAL_WRITING_RULES).toContain('D·系统推导源');
    expect(FORMAL_WRITING_RULES).not.toContain('必须基于项目工程量、总工期、工序流水与定额工效推导出具体数值');
    // 三源规则随全局写作前缀注入（Writer 家族 system 前缀共享）
    expect(L0_WRITER_SYSTEM_PREFIX).toContain('【写作三源规则】');
  });

  it('SECTION_GENERATION_SAFETY_RULES 含日期禁令', () => {
    expect(SECTION_GENERATION_SAFETY_RULES).toContain('禁止编造具体日期');
  });

  it('DOCUMENT_L0_COMMON_PREFIX 含事实分级', () => {
    expect(DOCUMENT_L0_COMMON_PREFIX).toContain('事实分级');
    expect(DOCUMENT_L0_COMMON_PREFIX).toContain('后台流程话术');
  });

  it('L0_WRITER_SYSTEM_PREFIX = 公共前缀+身份+写作规则+安全规则', () => {
    expect(L0_WRITER_SYSTEM_PREFIX).toContain('施工组织设计文档写作专家');
    expect(L0_WRITER_SYSTEM_PREFIX).toContain('事实分级');
  });

  it('writerSystemPrefix：默认含统一公共段与身份句', () => {
    const system = writerSystemPrefix('旧前缀');
    expect(system).toContain('事实分级');
    expect(system).toContain('施工组织设计文档写作专家。');
  });

  it('docSystemPrefix：默认含公共前缀与 role', () => {
    const system = docSystemPrefix('评审专家身份');
    expect(system).toContain('事实分级');
    expect(system).toContain('评审专家身份');
  });
});
