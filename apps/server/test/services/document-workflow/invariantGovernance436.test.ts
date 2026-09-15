/**
 * 4.36 不变量治理批次回归（INV-1 结构 / INV-2 单源 / INV-3 来源 / INV-4 完整性）：
 * - A2 renumberSectionHeadings：H3 编号空档原子重放、H4 父前缀同步、目录区保护、幂等；
 *   章片段模式（stage5 接线）：写作侧未编号章标题行不清除权威章号、陈旧「## 第N章」以调用方章序为准、
 *   未传/非法章序宁缺不假、链步骤消费 ctx.chapterNumber；
 * - C1 scanPunctuationBalance：全角括号/书名号不闭合块级 blocking、平衡不误报、行定位、
 *   写时反馈与终检包装接线；
 * - D1/D3 决策项注册表：matchDecisionCategory 双侧覆盖规则（强弱别名协同）、
 *   locateDecisionOptionAnchor 锚定（含 end 贴缘数据）、fixAmbiguousEitherOrCandidates
 *   决策锁裁决三态（有锁归一/无锁缺口/双侧贴缘拒绝）；决策锁多值共存（面层沥青+基层半刚性
 *   合法组合不误报语义矛盾——pavement_structure exclusive 复查修正）；
 * - B2 hasWorkInjuryInsuranceStatement：检测定位=修复定位单源（书名号剥离、邻近动词窗口）。
 */
import { describe, expect, it } from 'vitest';
import { renumberSectionHeadings, scanStructureDefects, structureIntegrityFeedback, structureIntegrityIssues } from '@/services/document-workflow/structureIntegrityRules';
import { decisionLockCategoryMeta, extractDecisionLockEntries, locateDecisionOptionAnchor, matchDecisionCategory } from '@/services/document-workflow/integratedBlueprint';
import { semanticChoiceConflicts } from '@/services/document-workflow/dataConsistencyReview';
import { SURFACE_FIX_STEPS } from '@/services/document-workflow/deterministicFixChains';
import { fixAmbiguousEitherOrCandidates } from '@/services/document-workflow/documentIntegrityChecks';
import { hasWorkInjuryInsuranceStatement } from '@/services/document-workflow/utils';

const occurrenceCount = (text: string, sub: string) => text.split(sub).length - 1;

describe('A2 renumberSectionHeadings 编号不变量（INV-1）', () => {
  it('H3 编号空档（1.1/1.2/1.4/1.5）按出现顺序重放为连续单调', () => {
    const markdown = [
      '## 第1章 工程概况',
      '### 1.1 项目基本情况',
      '项目位于合肥市。',
      '### 1.2 建设规模',
      '总建筑面积1万平方米。',
      '### 1.4 周边环境',
      '周边无既有建筑。',
      '### 1.5 施工条件',
      '交通便利。',
    ].join('\n');
    const result = renumberSectionHeadings(markdown);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('### 1.3 周边环境');
    expect(result.markdown).toContain('### 1.4 施工条件');
    expect(result.markdown).not.toContain('### 1.5');
  });

  it('H4 三段编号父前缀随重放同步（2.3→2.2 时 2.3.2→2.2.1）', () => {
    const markdown = [
      '## 第2章 主要施工方法',
      '### 2.1 土方工程',
      '#### 2.1.1 测量放线',
      '内容。',
      '### 2.3 主体结构',
      '#### 2.3.2 钢筋工程',
      '内容。',
    ].join('\n');
    const result = renumberSectionHeadings(markdown);
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('### 2.2 主体结构');
    expect(result.markdown).toContain('#### 2.2.1 钢筋工程');
  });

  it('无空档时零改动（fixedCount=0 且逐字节恒等）', () => {
    const markdown = ['## 第1章 工程概况', '### 1.1 项目基本情况', '内容。', '### 1.2 建设规模', '内容。'].join('\n');
    const result = renumberSectionHeadings(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe(markdown);
  });

  it('目录区（## 目录 至 page-break）内标题不重排', () => {
    const markdown = [
      '## 目录',
      '### 1.1 项目基本情况',
      '### 1.5 建设规模',
      '<div class="page-break"></div>',
      '## 第1章 工程概况',
      '### 1.1 项目基本情况',
      '### 1.5 建设规模',
    ].join('\n');
    const result = renumberSectionHeadings(markdown);
    expect(occurrenceCount(result.markdown, '### 1.5 建设规模')).toBe(1);
    expect(occurrenceCount(result.markdown, '### 1.2 建设规模')).toBe(1);
  });

  it('无 page-break div 成稿：目录区结构驱动退出，正文缺号重排不失效（round-2 死区根治）', () => {
    // 4.39 舒城实机根因：装配链 fixTocFromBody/ensureFormalToc 重建目录后无 page-break div，
    // 旧实现 inToc 永真 → chapterInfos 空 → 函数提前 return → round-2 全文链重编号静默死区，
    // 第2章 6 个节被删后的缺号（2.10-2.14/2.17）从未收敛；目录区必须结构驱动退出
    const markdown = [
      '## 目录',
      '### 1.1 项目基本情况',
      '### 1.5 建设规模',
      '## 第1章 工程概况',
      '### 1.1 项目基本情况',
      '### 1.5 建设规模',
    ].join('\n');
    const result = renumberSectionHeadings(markdown);
    expect(occurrenceCount(result.markdown, '### 1.5 建设规模')).toBe(1);
    expect(occurrenceCount(result.markdown, '### 1.2 建设规模')).toBe(1);
    expect(result.fixedCount).toBe(1);
  });

  it('幂等：重放后重跑零改动且逐字节恒等', () => {
    const markdown = ['## 第1章 工程概况', '### 1.3 项目基本情况', '内容。', '### 1.5 建设规模', '内容。'].join('\n');
    const first = renumberSectionHeadings(markdown);
    expect(first.fixedCount).toBe(2);
    const second = renumberSectionHeadings(first.markdown);
    expect(second.fixedCount).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });

  it('章片段模式：写作侧未编号章标题行不清除权威章号（stage5 真实片段形态）', () => {
    const fragment = ['## 工程概况', '', '### 1.1 项目基本情况', '内容。', '### 1.3 建设规模', '内容。'].join('\n');
    const result = renumberSectionHeadings(fragment, { chapterNumber: 2 });
    expect(result.fixedCount).toBe(2);
    expect(result.markdown).toContain('## 工程概况');
    expect(result.markdown).toContain('### 2.1 项目基本情况');
    expect(result.markdown).toContain('### 2.2 建设规模');
  });

  it('章片段模式：陈旧「## 第N章」行（≤1 条）以调用方章序为准且 H4 父前缀同步', () => {
    const fragment = ['## 第5章 工程概况', '### 5.1 项目基本情况', '内容。', '#### 5.1.2 建设规模', '内容。'].join('\n');
    const result = renumberSectionHeadings(fragment, { chapterNumber: 3 });
    expect(result.markdown).toContain('### 3.1 项目基本情况');
    expect(result.markdown).toContain('#### 3.1.1 建设规模');
  });

  it('章片段模式：未传/非法章序零改动（宁缺不假，防无章号硬编号）', () => {
    const fragment = '### 2.4 周边环境\n内容。';
    expect(renumberSectionHeadings(fragment).fixedCount).toBe(0);
    expect(renumberSectionHeadings(fragment, { chapterNumber: 0 }).fixedCount).toBe(0);
    expect(renumberSectionHeadings(fragment, { chapterNumber: 2.5 }).fixedCount).toBe(0);
  });

  it('链步骤接线：section-renumber 消费 ctx.chapterNumber（stage5 逐章注入/round-2 不注入）', () => {
    const step = SURFACE_FIX_STEPS.find(item => item.key === 'section-renumber');
    expect(step).toBeDefined();
    const injected = step!.fix('### 1.4 周边环境\n内容。', { greeningMaintenanceAuthority: undefined, chapterNumber: 4 });
    expect(injected.markdown).toContain('### 4.1 周边环境');
    expect(injected.fixedCount).toBe(1);
    const noChapter = step!.fix('### 1.4 周边环境\n内容。', { greeningMaintenanceAuthority: undefined });
    expect(noChapter.fixedCount).toBe(0);
  });
});

describe('C1 scanPunctuationBalance 块级成对性（INV-4）', () => {
  it('全角括号不闭合 → punctuation-unbalanced（blocking）且定位至残缺行', () => {
    const markdown = ['本工程概况如下。', '项目位于合肥市（含附属设施', '其他内容。'].join('\n');
    const defects = scanStructureDefects(markdown).blocking.filter(defect => defect.kind === 'punctuation-unbalanced');
    expect(defects).toHaveLength(1);
    expect(defects[0]?.line).toBe(2);
    expect(defects[0]?.message).toContain('全角括号不闭合');
  });

  it('书名号不闭合 → punctuation-unbalanced（blocking）', () => {
    const markdown = '依据《建筑法有关规定执行。';
    const defects = scanStructureDefects(markdown).blocking.filter(defect => defect.kind === 'punctuation-unbalanced');
    expect(defects).toHaveLength(1);
    expect(defects[0]?.message).toContain('书名号不闭合');
  });

  it('成对出现不误报（括号/书名号混合平衡）', () => {
    const markdown = ['项目位于合肥市（含附属设施）。', '依据《建筑法》与《安全生产法》执行。'].join('\n');
    const defects = scanStructureDefects(markdown).blocking.filter(defect => defect.kind === 'punctuation-unbalanced');
    expect(defects).toEqual([]);
  });

  it('写时反馈与终检包装接线（blocking 拦截重写 / 终检 blocker 暴露）', () => {
    const markdown = '项目位于合肥市（含附属设施';
    const feedback = structureIntegrityFeedback(scanStructureDefects(markdown), '1.1');
    expect(feedback).toContain('全角括号不闭合');
    const issues = structureIntegrityIssues(markdown);
    expect(issues.some(issue => issue.message.includes('全角括号不闭合'))).toBe(true);
  });
});

describe('D1/D3 决策项注册表（INV-2 单源）', () => {
  it('matchDecisionCategory 命中远端实锤三形态', () => {
    expect(matchDecisionCategory('减振吊架', '减振基础')?.id).toBe('vibration_isolation');
    expect(matchDecisionCategory('同步', '分段浇筑')?.id).toBe('concrete_pouring');
    expect(matchDecisionCategory('柔性', '半刚性')?.id).toBe('pavement_structure');
    expect(matchDecisionCategory('独立基础', '条形基础')?.id).toBe('foundation_form');
  });

  it('matchDecisionCategory 双侧覆盖规则防误配（弱别名须有对侧强命中背书）', () => {
    // 「柔性接口或刚性接口」两侧只有「柔性」弱形态、无任何强命中 → 非路面结构决策
    expect(matchDecisionCategory('柔性接口', '刚性接口')).toBeUndefined();
    // 弱别名双侧（同步弱 + 交替非选项词）不成立
    expect(matchDecisionCategory('同步', '交替施工')).toBeUndefined();
    // 职业/工艺枚举不命中
    expect(matchDecisionCategory('木工', '钢筋工')).toBeUndefined();
  });

  it('locateDecisionOptionAnchor 锚定（强别名/弱别名，返回贴缘 end 数据）', () => {
    const concrete = matchDecisionCategory('同步', '分段浇筑');
    expect(concrete).toBeDefined();
    expect(locateDecisionOptionAnchor(concrete!, '混凝土采用同步')).toMatchObject({ index: 5, end: 7 });
    const pavement = matchDecisionCategory('柔性', '半刚性');
    expect(pavement).toBeDefined();
    expect(locateDecisionOptionAnchor(pavement!, '柔性')).toMatchObject({ index: 0, end: 2 });
    const foundation = matchDecisionCategory('独立基础', '条形基础');
    expect(foundation).toBeDefined();
    expect(locateDecisionOptionAnchor(foundation!, '基础采用独立基础')).toMatchObject({ index: 4, end: 8 });
  });

  it('D3 裁决：有锁按锁定值归一（保留两侧邻接正文）', () => {
    const lock = [{ id: 'concrete_pouring', label: '混凝土浇筑连续组织', values: ['连续浇筑'] }];
    const result = fixAmbiguousEitherOrCandidates('底板混凝土采用同步或分段浇筑工艺，确保整体性。', { decisionLock: lock });
    expect(result.markdown).toBe('底板混凝土采用连续浇筑工艺，确保整体性。');
    expect(result.fixedCount).toBe(1);
    expect(result.details.some(detail => detail.includes('决策项两可归一'))).toBe(true);
  });

  it('D3 裁决：多命中逆序替换（两处独立收敛）', () => {
    const lock = [{ id: 'concrete_pouring', label: '混凝土浇筑连续组织', values: ['连续浇筑'] }];
    const result = fixAmbiguousEitherOrCandidates('底板混凝土采用同步或分段浇筑；顶板混凝土采用同步或分段浇筑。', { decisionLock: lock });
    expect(result.markdown).toBe('底板混凝土采用连续浇筑；顶板混凝土采用连续浇筑。');
    expect(result.fixedCount).toBe(2);
  });

  it('D3 裁决：无锁转缺口（保留原文并记录待复核，不静默）', () => {
    const markdown = '底板混凝土采用同步或分段浇筑工艺。';
    const result = fixAmbiguousEitherOrCandidates(markdown);
    expect(result.markdown).toBe(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.details.some(detail => detail.includes('缺口待复核'))).toBe(true);
  });

  it('D3 裁决：双侧贴缘拒绝（命中词非左组后缀时不替换，防吞语义后缀）', () => {
    const lock = [{ id: 'vibration_isolation', label: '设备减振方式', values: ['减振基础'] }];
    const markdown = '设备采用减振吊架托架或减振基础安装。';
    const result = fixAmbiguousEitherOrCandidates(markdown, { decisionLock: lock });
    expect(result.markdown).toBe(markdown);
    expect(result.fixedCount).toBe(0);
    expect(result.details.some(detail => detail.includes('缺口待复核'))).toBe(true);
  });

  it('决策锁多值共存：面层沥青+基层半刚性合法组合不误报语义矛盾（exclusive 复查修正）', () => {
    expect(decisionLockCategoryMeta('pavement_structure')?.exclusive).toBeUndefined();
    const evidence = [{ chapterId: 'c1', filePath: '招标文件.pdf', score: 1, content: '路面上面层采用沥青混凝土面层。基层采用半刚性基层（水泥稳定碎石）。' }];
    const locks = extractDecisionLockEntries({ facts: [], evidence });
    const pavement = locks.find(entry => entry.id === 'pavement_structure');
    expect(pavement).toBeDefined();
    expect(pavement!.values).toEqual(expect.arrayContaining(['柔性路面', '半刚性路面']));
    const conflicts = semanticChoiceConflicts('本工程路面上面层采用沥青混凝土面层，基层采用半刚性基层（水泥稳定碎石），压实度符合要求。', locks);
    expect(conflicts.filter(conflict => conflict.categoryId === 'pavement_structure')).toEqual([]);
  });
});

describe('B2 hasWorkInjuryInsuranceStatement 检测定位=修复定位单源', () => {
  it('动词邻近窗口命中（办理/缴纳/参保/缴费/投保）', () => {
    expect(hasWorkInjuryInsuranceStatement('为全体作业人员办理工伤保险并缴纳费用。')).toBe(true);
    expect(hasWorkInjuryInsuranceStatement('工伤保险缴纳率达到100%。')).toBe(true);
  });

  it('书名号引用剥离（《工伤保险条例》引用不构成缴纳表述）', () => {
    expect(hasWorkInjuryInsuranceStatement('依据《工伤保险条例》执行。')).toBe(false);
  });

  it('无关文本不命中', () => {
    expect(hasWorkInjuryInsuranceStatement('安全生产管理措施完善，责任落实到人。')).toBe(false);
  });
});
