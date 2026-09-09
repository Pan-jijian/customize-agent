/**
 * t3-mf M3 组：sanitizeFormalMarkdown 未覆盖规则深挖 + 尾函数族矩阵。
 * 覆盖：sanitize 残留规则（H4 词尾去重/伪标题拆行/表格前导句/粗体转H4/承包人替换/
 * 原始资料行/指令后短行/内部话术/特殊气候/结尾词）+ applyPromptDocumentRules 深挖 +
 * promptDocumentRuleIssues 深挖 + findChapterBlock + plannedStructureIssues +
 * ensureFormalToc + finalizeDocumentMarkdown + composeDocumentMarkdown +
 * writerSystemPrefix/docSystemPrefix。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyPromptDocumentRules,
  composeDocumentMarkdown,
  docSystemPrefix,
  ensureFormalToc,
  finalizeDocumentMarkdown,
  findChapterBlock,
  plannedStructureIssues,
  promptDocumentRuleIssues,
  sanitizeFormalMarkdown,
  writerSystemPrefix,
} from '@/services/document-workflow/markdownComposer';
import type { DocumentDraftChapter, DocumentTemplate, DocumentTemplateChapter, PromptDocumentRuleSet } from '@/services/document-workflow/types';

const draftChapter = (title: string, content = '', sections: string[] = []): DocumentDraftChapter => ({
  id: 'd1', title, content, evidence: [], missingFacts: [], sections,
});
const tplChapter = (title: string, sections: string[] = [], tableSections: string[] = []): DocumentTemplateChapter => ({
  id: 't1', title, purpose: '', queries: [], requiredFacts: [], sections, tableSections,
});
const promptRules = (overrides: Partial<PromptDocumentRuleSet> = {}): PromptDocumentRuleSet => ({
  forbiddenTerms: [], preferredTerms: [], requiredTables: [], ...overrides,
});

// ═══════ O1 sanitizeFormalMarkdown 残留规则深挖 ═══════
describe('O1 sanitizeFormalMarkdown 残留规则深挖', () => {
  it('H4 词尾等长重复去重（四字）', () => {
    expect(sanitizeFormalMarkdown('#### 现场条件现场条件')).toBe('#### 现场条件');
  });

  it('H4 词尾两字重复去重', () => {
    expect(sanitizeFormalMarkdown('#### 要点要点')).toBe('#### 要点');
  });

  it('H4 词尾三字重复去重', () => {
    expect(sanitizeFormalMarkdown('#### 施工方法施工方法')).toBe('#### 施工方法');
  });

  it('H4 词尾非等长重复 → 原样', () => {
    expect(sanitizeFormalMarkdown('#### 现场踏勘施工条件现场条件')).toBe('#### 现场踏勘施工条件现场条件');
  });

  it('H4 无重复 → 原样', () => {
    expect(sanitizeFormalMarkdown('#### 施工准备')).toBe('#### 施工准备');
  });

  it('句号+### 行内伪标题 → 拆行（全角句号）', () => {
    // 真行为：拆行 lookbehind 只认全角 [。；;]，半角 . 不拆
    const md = '复查记录留存影像资料。### 危大工程专项施工方案审批流程';
    const result = sanitizeFormalMarkdown(md);
    expect(result).toContain('\n\n### 危大工程专项施工方案审批流程');
    expect(result).not.toContain('影像资料.###');
  });

  it('半角句号+### → 不拆（lookbehind 不含半角点）', () => {
    const md = '复查记录留存影像资料.### 危大工程专项施工方案审批流程';
    expect(sanitizeFormalMarkdown(md)).toBe(md);
  });

  it('分号+#### 行内伪标题 → 拆行且前缀尾分号被删', () => {
    // 真行为：拆行后「完成检查记录；」尾字符分号命中结尾词过滤被删
    expect(sanitizeFormalMarkdown('完成检查记录；#### 验收标准确认流程')).toBe('#### 验收标准确认流程');
  });

  it('详见### 句中引用 → 不拆（非句末标点前置）', () => {
    const md = '详细内容详见### 1.2 施工方法';
    const result = sanitizeFormalMarkdown(md);
    expect(result).not.toContain('\n\n###');
  });

  it('表格前导句拆行（单管道对收尾）', () => {
    const md = '具体安排如下表。| 关键节点控制表 |';
    const result = sanitizeFormalMarkdown(md);
    expect(result).toContain('具体安排如下表。\n| 关键节点控制表 |');
  });

  it('整行粗体 → H4', () => {
    expect(sanitizeFormalMarkdown('**劳动力计划表**')).toBe('#### 劳动力计划表');
  });

  it('整行粗体带冒号 → 保留原文（乱码判定已豁免星号）', () => {
    // 真实缺陷修复：isLikelyMojibakeTitle 此前把星号计为非可读字符，4星+3字 readable=0.43<0.6
    // 误判乱码被删；修复后粗体包裹合法标题与纯文本同判
    expect(sanitizeFormalMarkdown('**注意：**')).toBe('**注意：**');
  });

  it('整行粗体提示语 → 保留原文', () => {
    expect(sanitizeFormalMarkdown('**说明**')).toBe('**说明**');
  });

  it('整行粗体带句号 → 保留原文', () => {
    expect(sanitizeFormalMarkdown('**安全第一。**')).toBe('**安全第一。**');
  });

  it('承包人案 → 方案', () => {
    expect(sanitizeFormalMarkdown('本承包人案编制依据')).toBe('本方案编制依据');
  });

  it('承包人法：→ 施工方法：', () => {
    expect(sanitizeFormalMarkdown('承包人法：先测量后施工')).toBe('施工方法：先测量后施工');
  });

  it('承包人法（无冒号）→ 方法', () => {
    expect(sanitizeFormalMarkdown('承包人法包括测量放线')).toBe('方法包括测量放线');
  });

  it('知识库证据行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文内容\n知识库证据：资料类型 X\n后续内容')).toBe('正文内容\n后续内容');
  });

  it('以上内容已依据块 → 删除（至空行）', () => {
    const md = '正文段落。\n\n以上内容已依据招标文件、设计图纸编制。\n\n后续内容';
    const result = sanitizeFormalMarkdown(md);
    expect(result).not.toContain('以上内容已依据');
    expect(result).toContain('后续内容');
  });

  it('PDF 第 N 页原始资料行 → 页码先归一残留资料词', () => {
    // 真行为：normalizeTenderSourcePageRefs 在 RAW_SOURCE_LINE_RE 之前执行，
    // 「PDF 第 5 页」已转「相关资料」，整行不再以 PDF 开头故不被删除
    expect(sanitizeFormalMarkdown('正文\nPDF 第 5 页 资料\n后续')).toBe('正文\n相关资料 资料\n后续');
  });

  it('文件：xx 原始资料行 → 删除（残留空行保留）', () => {
    // 真行为：删除后空行保留（filter 对空行 return true，\n{3,} 才归并）
    expect(sanitizeFormalMarkdown('正文\n文件：招标文件.pdf\n后续')).toBe('正文\n\n后续');
  });

  it('来源：xx 原始资料行 → 删除（残留空行保留）', () => {
    expect(sanitizeFormalMarkdown('正文\n来源：工程量清单\n后续')).toBe('正文\n\n后续');
  });

  it('指令型标题后短行 → 删除（弱句式指令行本身也删）', () => {
    // 真行为：不带 # 的「按需编写注意事项」行命中 INSTRUCTION_TITLE_RE 被 L527 删，
    // 其后 ≤12 字符短行被 L515 连带删；带 ### 前缀的指令行则先被 INSTRUCTION_HEADING_RE 删除，
    // 后续短行失去指令前置不被连带
    const result = sanitizeFormalMarkdown('按需编写注意事项\n简短说明\n正文内容');
    expect(result).toBe('正文内容');
  });

  it('招标术语 H4 补充条款 → 行删除且后续短行连带删', () => {
    // 真行为：「补充条款」命中 isTenderClauseFragmentTitle（条款碎片判别），
    // 后续「条款内容」行因前一行是指令型标题被 L515 连带删除
    expect(sanitizeFormalMarkdown('正文\n#### 补充条款\n条款内容')).toBe('正文');
  });

  it('内部话术「该小节围绕」→ 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n该小节围绕施工方法进行补充说明\n后续')).toBe('正文\n后续');
  });

  it('内部事实提示行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n仅作为内部事实提取依据\n后续')).toBe('正文\n后续');
  });

  it('后台事实行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n后台事实字段记录\n后续')).toBe('正文\n后续');
  });

  it('特殊气候单行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n雨季\n后续')).toBe('正文\n后续');
  });

  it('单字行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n的\n后续')).toBe('正文\n后续');
  });

  it('「主要包括」结尾行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n控制措施主要包括\n后续')).toBe('正文\n后续');
  });

  it('「如下」结尾行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n具体安排如下\n后续')).toBe('正文\n后续');
  });

  it('「通过」结尾行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n质量保证通过\n后续')).toBe('正文\n后续');
  });

  it('逗号结尾行 → 删除', () => {
    expect(sanitizeFormalMarkdown('正文\n施工内容包括，\n后续')).toBe('正文\n后续');
  });
});

// ═══════ O2 applyPromptDocumentRules 深挖 ═══════
describe('O2 applyPromptDocumentRules 深挖', () => {
  it('无 rules → 默认替换（本施工方→我公司）', () => {
    expect(applyPromptDocumentRules('本施工方负责施工')).toBe('我公司负责施工');
  });

  it('无 rules → 高度重视→严格落实', () => {
    expect(applyPromptDocumentRules('高度重视安全生产工作')).toBe('严格落实安全生产工作');
  });

  it('无 rules → 重中之重→关键控制事项', () => {
    expect(applyPromptDocumentRules('安全是重中之重')).toBe('安全是关键控制事项');
  });

  it('preferredTerms 基本替换（前缀字保留）', () => {
    const rules = promptRules({ preferredTerms: [{ from: '工程项目', to: '本项目' }] });
    expect(applyPromptDocumentRules('该工程项目位于合肥', rules)).toBe('该本项目位于合肥');
  });

  it('preferredTerms from 长度 < 2 → 跳过', () => {
    const rules = promptRules({ preferredTerms: [{ from: '工', to: '项目' }] });
    expect(applyPromptDocumentRules('工程', rules)).toBe('工程');
  });

  it('preferredTerms from===to → 跳过', () => {
    const rules = promptRules({ preferredTerms: [{ from: '施工', to: '施工' }] });
    expect(applyPromptDocumentRules('施工准备', rules)).toBe('施工准备');
  });

  it('preferredTerms 施工方 → 替换（非禁尾）', () => {
    const rules = promptRules({ preferredTerms: [{ from: '施工方', to: '我公司' }] });
    expect(applyPromptDocumentRules('施工方负责现场管理', rules)).toBe('我公司负责现场管理');
  });

  it('preferredTerms 施工方案 → 不替换（法/案/式/针/向/面 保护）', () => {
    const rules = promptRules({ preferredTerms: [{ from: '施工方', to: '我公司' }] });
    expect(applyPromptDocumentRules('施工方案已批准', rules)).toBe('施工方案已批准');
  });

  it('preferredTerms 施工方式 → 不替换', () => {
    const rules = promptRules({ preferredTerms: [{ from: '施工方', to: '我公司' }] });
    expect(applyPromptDocumentRules('施工方式合理', rules)).toBe('施工方式合理');
  });

  it('forbidCover → 删除封面', () => {
    const md = '<div class="document-cover">封面内容</div>\n\n<div class="page-break"></div>\n\n# 标题\n\n正文';
    const rules = promptRules({ forbidCover: true });
    const result = applyPromptDocumentRules(md, rules);
    expect(result).not.toContain('document-cover');
    expect(result).not.toContain('# 标题');
  });

  it('forbidToc → 删除目录', () => {
    const md = '## 目录\n\n第一章 工程概况\n\n<div class="page-break"></div>\n\n## 第一章 工程概况\n\n正文';
    const rules = promptRules({ forbidToc: true });
    const result = applyPromptDocumentRules(md, rules);
    expect(result).not.toContain('## 目录');
  });

  it('forbiddenTerms 报价明细表 → 整行删除', () => {
    const rules = promptRules({ forbiddenTerms: ['报价明细表'] });
    expect(applyPromptDocumentRules('正文\n报价明细表见附件\n后续', rules)).toBe('正文\n后续');
  });

  it('forbiddenTerms 招标控制价 → 整行删除', () => {
    const rules = promptRules({ forbiddenTerms: ['招标控制价'] });
    expect(applyPromptDocumentRules('正文\n招标控制价 1200 万\n后续', rules)).toBe('正文\n后续');
  });

  it('forbiddenTerms 其他词 → 不整行删除（仅检测用）', () => {
    const rules = promptRules({ forbiddenTerms: ['后台话术'] });
    expect(applyPromptDocumentRules('正文\n后台话术内容\n后续', rules)).toBe('正文\n后台话术内容\n后续');
  });

  it('requiredTables 缺失 → 插入（章节间定位）', () => {
    const md = '## 第一章 工程概况\n\n概况正文\n\n## 第二章 劳动力安排\n\n劳动力正文';
    const rules = promptRules({ requiredTables: ['劳动力计划表'] });
    const result = applyPromptDocumentRules(md, rules);
    expect(result).toContain('劳动力计划表');
    expect(result).toContain('| 控制项目 | 控制内容 |');
  });

  it('requiredTables 已存在 → 不重复插入', () => {
    const md = '## 第一章 工程概况\n\n劳动力计划表正文\n\n## 第二章 施工部署';
    const rules = promptRules({ requiredTables: ['劳动力计划表'] });
    const result = applyPromptDocumentRules(md, rules);
    expect((result.match(/劳动力计划表/gu) || [])).toHaveLength(1);
  });

  it('requiredTables 无章节标题 → 追加末尾', () => {
    const md = '正文无任何章节标题';
    const rules = promptRules({ requiredTables: ['劳动力计划表'] });
    const result = applyPromptDocumentRules(md, rules);
    expect(result).toContain('劳动力计划表');
    expect(result.indexOf('正文无任何章节标题')).toBe(0);
  });

  it('requiredTables 项目基本信息已存在 → 跳过', () => {
    const md = '## 第一章 工程概况\n\n| 信息项 | 内容 |\n|---|---|\n| 项目名称 | 某某工程 |';
    const rules = promptRules({ requiredTables: ['项目基本信息表'] });
    const result = applyPromptDocumentRules(md, rules);
    expect((result.match(/项目基本信息表/gu) || [])).toHaveLength(0);
  });

  it('requiredTables 应急表 → 定位应急章', () => {
    const md = '## 第一章 工程概况\n\n概况\n\n## 第二章 应急管理\n\n应急正文';
    const rules = promptRules({ requiredTables: ['应急预案表'] });
    const result = applyPromptDocumentRules(md, rules);
    const insertPos = result.indexOf('应急预案表');
    const chapterTwo = result.indexOf('## 第二章');
    expect(insertPos).toBeGreaterThan(chapterTwo);
  });
});

// ═══════ O3 promptDocumentRuleIssues 深挖 ═══════
describe('O3 promptDocumentRuleIssues 深挖', () => {
  it('无 rules → 空数组', async () => {
    await expect(promptDocumentRuleIssues('正文内容')).resolves.toEqual([]);
  });

  it('指令型强标题 → error', async () => {
    const issues = await promptDocumentRuleIssues('## 是否需要专项施工方案\n\n正文', promptRules());
    expect(issues.some(issue => issue.level === 'error' && issue.message.includes('提示词指令标题'))).toBe(true);
  });

  it('弱词根标题 + 语义 gate 命中 → error', async () => {
    const embedDocuments = async () => [[1, 0]];
    const issues = await promptDocumentRuleIssues('## 注意事项\n\n正文', promptRules(), embedDocuments);
    expect(issues.some(issue => issue.message.includes('提示词指令标题'))).toBe(true);
  });

  it('coverPolicy required 缺封面 → error', async () => {
    const issues = await promptDocumentRuleIssues('## 第一章 工程概况\n\n正文', promptRules({ coverPolicy: 'required' }));
    expect(issues.some(issue => issue.message.includes('缺少提示词要求的封面'))).toBe(true);
  });

  it('coverPolicy required 有封面 → 不报', async () => {
    const issues = await promptDocumentRuleIssues('# 项目标题\n\n## 第一章 工程概况\n\n正文', promptRules({ coverPolicy: 'required' }));
    expect(issues.some(issue => issue.message.includes('缺少提示词要求的封面'))).toBe(false);
  });

  it('tocPolicy required 缺目录 → error', async () => {
    const issues = await promptDocumentRuleIssues('## 第一章 工程概况\n\n正文', promptRules({ tocPolicy: 'required' }));
    expect(issues.some(issue => issue.message.includes('缺少提示词要求的目录'))).toBe(true);
  });

  it('forbidCover 有封面 → error', async () => {
    const issues = await promptDocumentRuleIssues('<div class="document-cover">封面</div>\n\n正文', promptRules({ forbidCover: true }));
    expect(issues.some(issue => issue.message.includes('正文残留封面内容'))).toBe(true);
  });

  it('forbidToc 有目录 → error', async () => {
    const issues = await promptDocumentRuleIssues('## 目录\n\n条目\n\n正文', promptRules({ forbidToc: true }));
    expect(issues.some(issue => issue.message.includes('正文残留目录内容'))).toBe(true);
  });

  it('requiredTables 缺失 → error', async () => {
    const issues = await promptDocumentRuleIssues('## 第一章 工程概况\n\n正文', promptRules({ requiredTables: ['劳动力计划表'] }));
    expect(issues.some(issue => issue.level === 'error' && issue.message.includes('劳动力计划表'))).toBe(true);
  });

  it('requiredTables 表名在但附近无表格 → error', async () => {
    const md = '## 第一章 工程概况\n\n劳动力计划表详见后续安排。';
    const issues = await promptDocumentRuleIssues(md, promptRules({ requiredTables: ['劳动力计划表'] }));
    expect(issues.some(issue => issue.message.includes('劳动力计划表'))).toBe(true);
  });

  it('requiredTables 表名+表格齐 → 不报', async () => {
    const md = '## 第一章 工程概况\n\n劳动力计划表\n\n| 项目 | 内容 |\n|---|---|\n| 人数 | 100 |';
    const issues = await promptDocumentRuleIssues(md, promptRules({ requiredTables: ['劳动力计划表'] }));
    expect(issues.some(issue => issue.message.includes('劳动力计划表'))).toBe(false);
  });

  it('requiredKeywords 缺失 → 升级为 error', async () => {
    const issues = await promptDocumentRuleIssues('正文内容', promptRules({ requiredKeywords: ['绿色施工'] }));
    expect(issues.some(issue => issue.level === 'error' && issue.message.includes('绿色施工'))).toBe(true);
  });

  it('requiredKeywords 命中 → 不报', async () => {
    const issues = await promptDocumentRuleIssues('正文包含绿色施工措施', promptRules({ requiredKeywords: ['绿色施工'] }));
    expect(issues.some(issue => issue.message.includes('绿色施工'))).toBe(false);
  });

  it('forbiddenPatterns 命中 → error（升级）', async () => {
    const issues = await promptDocumentRuleIssues('正文出现后台话术', promptRules({ forbiddenPatterns: ['后台话术'] }));
    expect(issues.some(issue => issue.message.includes('提示词禁止内容'))).toBe(true);
  });

  it('forbiddenTerms 命中 → error（升级）', async () => {
    const issues = await promptDocumentRuleIssues('正文含第三人称表述', promptRules({ forbiddenTerms: ['第三人称'] }));
    expect(issues.some(issue => issue.message.includes('总控提示词禁止词'))).toBe(true);
  });

  it('forbiddenTerms 豁免白名单（报价）→ 不报', async () => {
    const issues = await promptDocumentRuleIssues('报价说明', promptRules({ forbiddenTerms: ['报价'] }));
    expect(issues.some(issue => issue.message.includes('总控提示词禁止词'))).toBe(false);
  });

  it('exactHeadings 缺失 → error', async () => {
    const rules = { exactHeadings: ['第一章 工程概况', '第二章 施工部署'] } as PromptDocumentRuleSet & { exactHeadings: string[] };
    const issues = await promptDocumentRuleIssues('## 第一章 工程概况\n\n正文', rules);
    expect(issues.some(issue => issue.level === 'error' && issue.message.includes('施工部署'))).toBe(true);
  });

  it('exactHeadings 齐 → 不报', async () => {
    const rules = { exactHeadings: ['第一章 工程概况'] } as PromptDocumentRuleSet & { exactHeadings: string[] };
    const issues = await promptDocumentRuleIssues('## 第一章 工程概况\n\n正文', rules);
    expect(issues.some(issue => issue.message.includes('指定一级章节'))).toBe(false);
  });

  it('exactHeadings + forbidExtraHeadings 多出 → warning', async () => {
    const rules = { exactHeadings: ['第一章 工程概况'], forbidExtraHeadings: true } as PromptDocumentRuleSet & { exactHeadings: string[]; forbidExtraHeadings: boolean };
    const issues = await promptDocumentRuleIssues('## 第一章 工程概况\n\n正文\n\n## 第二章 施工部署\n\n正文', rules);
    expect(issues.some(issue => issue.message.includes('未允许的一级章节'))).toBe(true);
  });

  it('forbiddenSubjects 命中 → 升级 error', async () => {
    const rules = { forbiddenSubjects: ['乙方'] } as PromptDocumentRuleSet & { forbiddenSubjects: string[] };
    const issues = await promptDocumentRuleIssues('乙方负责施工', rules);
    expect(issues.some(issue => issue.message.includes('禁用主体表达'))).toBe(true);
  });

  it('minChars 达标 → 不报', async () => {
    const rules = { minChars: 100 } as PromptDocumentRuleSet & { minChars: number };
    const longText = '施工方案正文内容充分详尽，覆盖施工准备过程控制检查验收和资料归档要求，形成责任明确过程可控资料完整的管理闭环，确保现场管理要求与施工进度资源组织和验收节点同步推进，明确各岗位质量安全责任并落实检查频次和整改闭环机制，使各项措施与本工程实施条件相匹配。';
    const issues = await promptDocumentRuleIssues(longText, rules);
    expect(issues.some(issue => issue.message.includes('正文长度低于提示词要求'))).toBe(false);
  });

  it('minChars 低于 95% → warning', async () => {
    const rules = { minChars: 200 } as PromptDocumentRuleSet & { minChars: number };
    const issues = await promptDocumentRuleIssues('短正文', rules);
    expect(issues.some(issue => issue.message.includes('正文长度低于提示词要求'))).toBe(true);
  });

  it('warning 升级映射 severity=blocker', async () => {
    const issues = await promptDocumentRuleIssues('正文出现后台话术', promptRules({ forbiddenPatterns: ['后台话术'] }));
    const upgraded = issues.find(issue => issue.message.includes('提示词禁止内容'));
    expect(upgraded?.level).toBe('error');
  });
});

// ═══════ O4 findChapterBlock ═══════
describe('O4 findChapterBlock', () => {
  it('找到章 → 返回块', () => {
    const md = '## 第一章 工程概况\n\n概况正文\n\n## 第二章 施工部署\n\n部署正文';
    const block = findChapterBlock(md, '工程概况');
    expect(block).toBeDefined();
    expect(block?.body).toContain('概况正文');
    expect(block?.body).not.toContain('部署正文');
  });

  it('章标题带第X章前缀 → 归一匹配', () => {
    const md = '## 第一章 工程概况\n\n概况正文';
    expect(findChapterBlock(md, '第一章 工程概况')).toBeDefined();
  });

  it('未找到 → undefined', () => {
    expect(findChapterBlock('## 第一章 工程概况\n\n正文', '施工方法')).toBeUndefined();
  });

  it('无 H2 结构 → undefined', () => {
    expect(findChapterBlock('纯正文无标题', '工程概况')).toBeUndefined();
  });

  it('末章 body 至文档尾', () => {
    const md = '## 第一章 工程概况\n\n概况正文';
    const block = findChapterBlock(md, '工程概况');
    expect(block?.end).toBe(md.length);
  });

  it('heading 保留原始行', () => {
    const md = '## 第一章 工程概况\n\n正文';
    expect(findChapterBlock(md, '工程概况')?.heading).toBe('## 第一章 工程概况');
  });
});

// ═══════ O5 plannedStructureIssues ═══════
describe('O5 plannedStructureIssues', () => {
  it('缺章节标题 → error', () => {
    const template: DocumentTemplate = { chapters: [tplChapter('工程概况')] } as unknown as DocumentTemplate;
    const issues = plannedStructureIssues('## 第一章 施工部署\n\n正文', template);
    expect(issues.some(issue => issue.level === 'error' && issue.message.includes('工程概况'))).toBe(true);
  });

  it('章节齐 → 无缺失报错', () => {
    const template: DocumentTemplate = { chapters: [tplChapter('工程概况')] } as unknown as DocumentTemplate;
    const issues = plannedStructureIssues('## 第一章 工程概况\n\n正文', template);
    expect(issues.some(issue => issue.message.includes('缺少章节标题'))).toBe(false);
  });

  it('tableSections 无表格 → warning', () => {
    const template: DocumentTemplate = { chapters: [tplChapter('劳动力安排', [], ['劳动力计划表'])] } as unknown as DocumentTemplate;
    const issues = plannedStructureIssues('## 第一章 劳动力安排\n\n正文无表格', template);
    expect(issues.some(issue => issue.level === 'warning' && issue.message.includes('缺少必要的正式表格'))).toBe(true);
  });

  it('tableSections 有表格 → 不报', () => {
    const md = '## 第一章 劳动力安排\n\n| 工种 | 人数 |\n|---|---|\n| 木工 | 10 |';
    const template: DocumentTemplate = { chapters: [tplChapter('劳动力安排', [], ['劳动力计划表'])] } as unknown as DocumentTemplate;
    const issues = plannedStructureIssues(md, template);
    expect(issues.some(issue => issue.message.includes('缺少必要的正式表格'))).toBe(false);
  });

  it('tableSections 空 → 不报表格', () => {
    const template: DocumentTemplate = { chapters: [tplChapter('施工部署', [])] } as unknown as DocumentTemplate;
    const issues = plannedStructureIssues('## 第一章 施工部署\n\n正文', template);
    expect(issues.some(issue => issue.message.includes('缺少必要的正式表格'))).toBe(false);
  });
});

// ═══════ O6 ensureFormalToc ═══════
describe('O6 ensureFormalToc', () => {
  it('无目录无分页 → 头部插入目录', () => {
    const chapters = [draftChapter('工程概况', '## 第一章 工程概况\n\n### 1.1 工程简介\n\n正文')];
    const result = ensureFormalToc('## 第一章 工程概况\n\n### 1.1 工程简介\n\n正文', chapters);
    expect(result.startsWith('## 目录')).toBe(true);
    expect(result).toContain('<div class="page-break"></div>');
  });

  it('有分页符 → 目录插在分页符后', () => {
    const md = '<div class="page-break"></div>\n\n## 第一章 工程概况\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = ensureFormalToc(md, chapters);
    expect(result.indexOf('## 目录')).toBeGreaterThan(result.indexOf('<div class="page-break"></div>'));
  });

  it('已有目录 → 替换为确定性目录', () => {
    const md = '## 目录\n\n旧目录条目\n\n<div class="page-break"></div>\n\n## 第一章 工程概况\n\n### 1.1 工程简介\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = ensureFormalToc(md, chapters);
    expect(result).toContain('第一章 工程概况');
    expect(result).not.toContain('旧目录条目');
  });

  it('目录源 = 正文 H3（无规划小节时）', () => {
    const md = '## 第一章 工程概况\n\n### 1.1 工程简介\n\n### 1.2 建设条件\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = ensureFormalToc(md, chapters);
    expect(result).toContain('1.1 工程简介');
    expect(result).toContain('1.2 建设条件');
  });

  it('正文无 H3 → 回退规划小节', () => {
    const md = '## 第一章 工程概况\n\n正文';
    const chapters = [draftChapter('工程概况', md, ['工程简介', '建设条件'])];
    const result = ensureFormalToc(md, chapters);
    expect(result).toContain('工程简介');
    expect(result).toContain('建设条件');
  });

  it('目录排除指令型小节', () => {
    const md = '## 第一章 工程概况\n\n### 1.1 工程简介\n\n### 1.2 注意事项\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = ensureFormalToc(md, chapters);
    expect(result).not.toContain('注意事项');
  });

  it('多章目录', () => {
    const md = '## 第一章 工程概况\n\n### 1.1 工程简介\n\n正文\n\n## 第二章 施工部署\n\n### 2.1 施工准备\n\n正文';
    const chapters = [draftChapter('工程概况', md), draftChapter('施工部署', md)];
    const result = ensureFormalToc(md, chapters);
    expect(result).toContain('第一章 工程概况');
    expect(result).toContain('第二章 施工部署');
  });

  it('目录不重复渲染（幂等）', () => {
    const md = '## 第一章 工程概况\n\n### 1.1 工程简介\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const once = ensureFormalToc(md, chapters);
    const twice = ensureFormalToc(once, chapters);
    expect((twice.match(/^##\s+目录\s*$/gmu) || [])).toHaveLength(1);
  });
});

// ═══════ O7 finalizeDocumentMarkdown ═══════
describe('O7 finalizeDocumentMarkdown', () => {
  it('forbidDrawingImages → 删除图片行', () => {
    const md = '## 第一章 工程概况\n\n正文\n\n![总平面图](p.png)\n\n后续';
    const chapters = [draftChapter('工程概况', md)];
    const result = finalizeDocumentMarkdown(md, chapters, { forbidDrawingImages: true });
    expect(result.markdown).not.toContain('p.png');
  });

  it('coverPolicy required → 保留封面', () => {
    const md = '<div class="document-cover">封面</div>\n\n<div class="page-break"></div>\n\n## 第一章 工程概况\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = finalizeDocumentMarkdown(md, chapters, { promptRules: promptRules({ coverPolicy: 'required' }) });
    expect(result.markdown).toContain('document-cover');
  });

  it('tocPolicy forbidden → 删除目录', () => {
    const md = '## 目录\n\n目录条目\n\n<div class="page-break"></div>\n\n## 第一章 工程概况\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = finalizeDocumentMarkdown(md, chapters, { promptRules: promptRules({ tocPolicy: 'forbidden' }) });
    expect(result.markdown).not.toContain('## 目录');
  });

  it('tocPolicy 未指定 → 确定性目录替换', () => {
    const md = '## 目录\n\nLLM 脏目录\n\n<div class="page-break"></div>\n\n## 第一章 工程概况\n\n### 1.1 工程简介\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = finalizeDocumentMarkdown(md, chapters, { promptRules: promptRules() });
    expect(result.markdown).toContain('1.1 工程简介');
    expect(result.markdown).not.toContain('LLM 脏目录');
  });

  it('无 promptRules → 封面保留（无规则不触发封面删除）', () => {
    // 真行为：policyMarkdown 仅在 promptRules 存在时才按 cover/tocPolicy 删除封面
    const md = '<div class="document-cover">封面</div>\n\n<div class="page-break"></div>\n\n## 第一章 工程概况\n\n### 1.1 工程简介\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = finalizeDocumentMarkdown(md, chapters);
    expect(result.markdown).toContain('document-cover');
    expect(result.markdown).toContain('1.1 工程简介');
  });

  it('章节编号乱序 → 排序', () => {
    const md = '## 第一章 工程概况\n\n### 1.2 建设条件\n\n条件正文\n\n### 1.1 工程简介\n\n简介正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = finalizeDocumentMarkdown(md, chapters);
    const pos1 = result.markdown.indexOf('### 1.1');
    const pos2 = result.markdown.indexOf('### 1.2');
    expect(pos1).toBeGreaterThan(-1);
    expect(pos2).toBeGreaterThan(-1);
    expect(pos1).toBeLessThan(pos2);
  });

  it('同名 wrapper 章（单 H3 同名+多 H4）→ H4 提升为 H3', () => {
    const md = '## 第一章 施工方法\n\n### 1.1 施工方法\n\n#### 1.1.1 测量放线\n\n测量正文\n\n#### 1.1.2 土方开挖\n\n开挖正文';
    const chapters = [draftChapter('施工方法', md)];
    const result = finalizeDocumentMarkdown(md, chapters);
    expect(result.markdown).toContain('### 1.1 测量放线');
    expect(result.markdown).toContain('### 1.2 土方开挖');
  });

  it('返回 chapters 保持规划 sections', () => {
    const md = '## 第一章 工程概况\n\n正文';
    const chapters = [draftChapter('工程概况', md, ['工程简介'])];
    const result = finalizeDocumentMarkdown(md, chapters);
    expect(result.chapters[0].sections).toEqual(['工程简介']);
  });

  it('无规划 sections → 从正文 H3 推断', () => {
    const md = '## 第一章 工程概况\n\n### 1.1 工程简介\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = finalizeDocumentMarkdown(md, chapters);
    expect(result.chapters[0].sections).toEqual(['工程简介']);
  });

  it('promptRules requiredTables → 注入表格', () => {
    const md = '## 第一章 工程概况\n\n正文';
    const chapters = [draftChapter('工程概况', md)];
    const result = finalizeDocumentMarkdown(md, chapters, { promptRules: promptRules({ requiredTables: ['劳动力计划表'] }) });
    expect(result.markdown).toContain('劳动力计划表');
  });
});

// ═══════ O8 composeDocumentMarkdown ═══════
describe('O8 composeDocumentMarkdown', () => {
  const draftWith = (chapters: DocumentDraftChapter[]) => ({
    id: 'draft1',
    title: '某某工程施工组织设计',
    facts: { projectName: '某某工程' },
    chapters,
    meta: {},
    profile: {},
  });

  it('基本组合：封面+目录+章节', () => {
    const chapters = [draftChapter('工程概况', '## 第一章 工程概况\n\n### 1.1 工程简介\n\n概况正文')];
    const markdown = composeDocumentMarkdown(draftWith(chapters) as never);
    expect(markdown).toContain('某某工程');
    expect(markdown).toContain('## 目录');
    expect(markdown).toContain('概况正文');
  });

  it('包含分页符', () => {
    const chapters = [draftChapter('工程概况', '## 第一章 工程概况\n\n正文')];
    const markdown = composeDocumentMarkdown(draftWith(chapters) as never);
    expect(markdown).toContain('<div class="page-break"></div>');
  });

  it('无 sections → 从正文提取目录小节', () => {
    const chapters = [draftChapter('工程概况', '## 第一章 工程概况\n\n### 1.1 工程简介\n\n正文')];
    const markdown = composeDocumentMarkdown(draftWith(chapters) as never);
    expect(markdown).toContain('1.1 工程简介');
  });

  it('forbidDrawingImages → 图片删除', () => {
    const chapters = [draftChapter('工程概况', '## 第一章 工程概况\n\n![图](a.png)\n\n正文')];
    const markdown = composeDocumentMarkdown(draftWith(chapters) as never, { forbidDrawingImages: true });
    expect(markdown).not.toContain('a.png');
  });

  it('多章顺序拼接', () => {
    const chapters = [
      draftChapter('工程概况', '## 第一章 工程概况\n\n概况正文'),
      draftChapter('施工部署', '## 第二章 施工部署\n\n部署正文'),
    ];
    const markdown = composeDocumentMarkdown(draftWith(chapters) as never);
    expect(markdown.indexOf('概况正文')).toBeLessThan(markdown.indexOf('部署正文'));
  });
});

// ═══════ O9 writerSystemPrefix / docSystemPrefix ═══════
describe('O9 writerSystemPrefix / docSystemPrefix', () => {
  it('默认 → 含 L0 公共前缀', () => {
    const prefix = writerSystemPrefix('LEGACY');
    expect(prefix).toContain('事实分级');
    expect(prefix).not.toBe('LEGACY');
  });

  it('默认 → 写作专家身份句', () => {
    expect(writerSystemPrefix('LEGACY')).toContain('你是施工组织设计文档写作专家');
  });

  it('docSystemPrefix 默认 → L0 + role', () => {
    const prefix = docSystemPrefix('评审角色');
    expect(prefix).toContain('评审角色');
    expect(prefix).toContain('事实分级');
  });
});
