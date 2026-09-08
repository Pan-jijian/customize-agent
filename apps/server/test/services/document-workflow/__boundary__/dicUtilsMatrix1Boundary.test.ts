/**
 * 边界矩阵（P2 第 1 批 · WW 组 · utils 纯函数族 1）
 * 断言按源码规则推导（hasProcessSequenceExpression/workPackage 三要素/标题去重族）。
 */
import { describe, expect, it } from 'vitest';
import { dedupeRepeatedSubsections, findDuplicateH4Titles, findExtraneousBlockTitles, hasProcessSequenceExpression, looseTitleFamilyMatch, normalizeSubsectionTitleForDedup, removeExtraneousBlockSections, stripExtraneousBlockHeadings, workPackageContentElementFlags, workPackageContentElementsComplete, workPackageElementsMeetLenientGate } from '@/services/document-workflow/utils';

// ── W1. hasProcessSequenceExpression 谱系 ──

describe('W1 工序顺序表达：六形态谱系', () => {
  it.each([
    ['A→B→C', 1],
    ['基层清理->放线定位->分层摊铺', 1],
    ['开挖=>支护=>浇筑', 1],
    ['按以下顺序施工：清表、开挖、回填', 1],
    ['依次完成放线、开挖、支护', 1],
    ['先后完成清表与开挖', 1],
    ['先清表后开挖再浇筑', 1],
    ['采用顺序施工组织', 1],
    ['流水顺序：一区先施工，二区跟进', 1],
    ['基层清理-放线定位-分层摊铺', 1],
    ['基层清理—放线定位—分层摊铺', 1],
    ['基层清理～放线定位～分层摊铺', 1],
    ['基层清理~放线定位~分层摊铺', 1],
    ['本项目共三层，采用现浇结构', 0],
    ['', 0],
  ] as const)('W1 「%s」→ %s', (text, exp: number) => {
    expect(hasProcessSequenceExpression(text) ? 1 : 0).toBe(exp);
  });
  it('W1 编号步骤 ≥2 步命中（阿拉伯/括号/中文/第N步）', () => {
    expect(hasProcessSequenceExpression('1. 清表\n2. 开挖')).toBe(true);
    expect(hasProcessSequenceExpression('（1）清表\n（2）开挖')).toBe(true);
    expect(hasProcessSequenceExpression('一、清表\n二、开挖')).toBe(true);
    expect(hasProcessSequenceExpression('第一步清表\n第二步开挖')).toBe(true);
  });
  it('W1 编号步骤 1 步不命中', () => {
    expect(hasProcessSequenceExpression('1. 清表')).toBe(false);
    expect(hasProcessSequenceExpression('（1）清表')).toBe(false);
    expect(hasProcessSequenceExpression('第一步清表')).toBe(false);
  });
  it('W1 列表符 ≥2 行命中（-/*/•/数字.）', () => {
    expect(hasProcessSequenceExpression('- 清表\n- 开挖')).toBe(true);
    expect(hasProcessSequenceExpression('* 清表\n* 开挖')).toBe(true);
    expect(hasProcessSequenceExpression('• 清表\n• 开挖')).toBe(true);
    expect(hasProcessSequenceExpression('1. 清表\n2. 开挖')).toBe(true);
  });
  it('W1 列表符 1 行不命中', () => {
    expect(hasProcessSequenceExpression('- 清表')).toBe(false);
  });
  it('W1 连接线链仅 2 环节不命中', () => {
    expect(hasProcessSequenceExpression('基层清理-放线定位')).toBe(false);
  });
});

// ── W2. workPackageContentElementFlags 谱系 ──

describe('W2 工作包三要素逐维判定', () => {
  it('W2 三要素齐全', () => {
    const flags = workPackageContentElementFlags('施工概况：本工程为道路工程，工程量约5000㎡。\n施工流程：清表→开挖→回填。\n施工方法：分层摊铺碾压，验收标准按规范。');
    expect(flags).toEqual({ scope: true, process: true, method: true });
    expect(workPackageContentElementsComplete('施工概况：本工程为道路工程，工程量约5000㎡。\n施工流程：清表→开挖→回填。\n施工方法：分层摊铺碾压，验收标准按规范。')).toBe(true);
    expect(workPackageElementsMeetLenientGate('施工概况：本工程为道路工程，工程量约5000㎡。\n施工流程：清表→开挖→回填。\n施工方法：分层摊铺碾压，验收标准按规范。')).toBe(true);
  });
  it.each([
    ['作业对象：路基土方'],
    ['施工部位：底板'],
    ['施工范围：全区'],
    ['概况：本工程'],
  ] as const)('W2 scope 词「%s」→ scope=true', (text) => {
    expect(workPackageContentElementFlags(text).scope).toBe(true);
  });
  it.each(['施工流程：清表', '施工工序：开挖', '施工顺序：先行', '工艺参数：C30', '验收标准：合格', '检测项目齐全', '试验合格', '做好施工记录'])('W2 process/method 词「%s」', (text) => {
    if (/流程|工序|顺序/.test(text)) {
      expect(workPackageContentElementFlags(text).process).toBe(true);
    } else {
      expect(workPackageContentElementFlags(text).method).toBe(true);
    }
  });
  it('W2 「流程：」后无实质内容 → process 靠序列表达兜底', () => {
    expect(workPackageContentElementFlags('流程：\n先清表后开挖').process).toBe(true);
    expect(workPackageContentElementFlags('流程：').process).toBe(false);
  });
  it('W2 空块三要素全 false', () => {
    expect(workPackageContentElementFlags('')).toEqual({ scope: false, process: false, method: false });
  });
  it('W2 只缺一维 → complete false', () => {
    expect(workPackageContentElementsComplete('施工概况：本工程。\n施工方法：按规范。')).toBe(false);
  });
});

// ── W3. normalizeSubsectionTitleForDedup 谱系 ──

describe('W3 标题归一化', () => {
  it.each([
    ['1.3.2 室外雨污分流改造', '室外雨污分流改造'],
    ['1.3.12 室外雨污分流改造', '室外雨污分流改造'],
    ['1 主体结构工程', '主体结构'],
    ['1. 主体结构工程', '主体结构'],
    ['室外雨污分流改造（新建）', '室外雨污分流改造'],
    ['主体 结构 工程', '主体结构'],
    ['主体结构：工程', '主体结构'],
  ] as const)('W3 「%s」→「%s」', (title, exp: string) => {
    expect(normalizeSubsectionTitleForDedup(title)).toBe(exp);
  });
  it('W3 「1.3.2」与「1.3.12」归一后相等（同要点）', () => {
    expect(normalizeSubsectionTitleForDedup('1.3.2 室外雨污分流改造')).toBe(normalizeSubsectionTitleForDedup('1.3.12 室外雨污分流改造'));
  });
  it('W3 工程尾缀剥离后与无尾缀相等', () => {
    expect(normalizeSubsectionTitleForDedup('主体结构工程')).toBe(normalizeSubsectionTitleForDedup('主体结构'));
  });
});

// ── W4. looseTitleFamilyMatch 谱系 ──

describe('W4 标题同源宽松比较', () => {
  it('W4 「主要分部分项施工方案」vs「主要分部分项工程施工方案」→ true', () => {
    expect(looseTitleFamilyMatch('主要分部分项施工方案', '主要分部分项工程施工方案')).toBe(true);
  });
  it('W4 「主体结构工程」vs「主体结构」→ true（工程全剥离）', () => {
    expect(looseTitleFamilyMatch('主体结构工程', '主体结构')).toBe(true);
  });
  it('W4 不同标题 → false', () => {
    expect(looseTitleFamilyMatch('主体结构', '装饰装修')).toBe(false);
  });
  it('W4 两侧均含工程 → true', () => {
    expect(looseTitleFamilyMatch('土方工程工程', '土方工程')).toBe(true);
  });
  it('W4 空串相等 → true', () => {
    expect(looseTitleFamilyMatch('', '')).toBe(true);
  });
});

// ── W5. findDuplicateH4Titles 谱系 ──

describe('W5 同 H3 重复 H4 标题检测', () => {
  it('W5 同 H3 下同名 H4 两次 → 报 1 条原样标题', () => {
    const md = '### 主体结构工程\n#### 施工准备\n#### 施工准备';
    const dup = findDuplicateH4Titles(md);
    expect(dup).toEqual(['施工准备']);
  });
  it('W5 编号变体归一后判重复（1.3.2 vs 1.3.12）', () => {
    const md = '### 室外配套\n#### 1.3.2 雨污分流\n#### 1.3.12 雨污分流';
    expect(findDuplicateH4Titles(md)).toEqual(['1.3.12 雨污分流']);
  });
  it('W5 跨 H3 同名 H4 → 不报', () => {
    const md = '### 主体结构\n#### 施工准备\n### 装饰装修\n#### 施工准备';
    expect(findDuplicateH4Titles(md)).toEqual([]);
  });
  it('W5 H2 重置作用域 → 不报', () => {
    const md = '## 第1章\n### 主体结构\n#### 施工准备\n## 第2章\n### 装饰装修\n#### 施工准备';
    expect(findDuplicateH4Titles(md)).toEqual([]);
  });
  it('W5 三次同名 → 报 2 条（后两次）', () => {
    const md = '### 主体结构\n#### 施工准备\n#### 施工准备\n#### 施工准备';
    expect(findDuplicateH4Titles(md)).toEqual(['施工准备', '施工准备']);
  });
  it('W5 H5 不参与 → 0 条', () => {
    const md = '### 主体结构\n##### 施工准备\n##### 施工准备';
    expect(findDuplicateH4Titles(md)).toEqual([]);
  });
  it('W5 H3 前的 H4（无 H3 作用域）也计数', () => {
    const md = '#### 施工准备\n#### 施工准备';
    expect(findDuplicateH4Titles(md)).toEqual(['施工准备']);
  });
});

// ── W6. dedupeRepeatedSubsections 谱系 ──

describe('W6 重复小节去重', () => {
  it('W6 同 H3 重复 H4 → 保留首个、删除后续整块', () => {
    const md = '### 主体结构\n#### 施工准备\n正文A\n#### 施工准备\n正文B';
    const result = dedupeRepeatedSubsections(md);
    expect(result).toContain('正文A');
    expect(result).not.toContain('正文B');
  });
  it('W6 跨 H3 同名 H4 → 全部保留', () => {
    const md = '### 主体结构\n#### 施工准备\n正文A\n### 装饰装修\n#### 施工准备\n正文B';
    const result = dedupeRepeatedSubsections(md);
    expect(result).toContain('正文A');
    expect(result).toContain('正文B');
  });
  it('W6 H3 切换清空 seen → 新 H3 下同前 H3 名不删', () => {
    const md = '### 主体结构\n#### 施工准备\n### 主体结构\n#### 施工准备';
    expect(dedupeRepeatedSubsections(md)).toBe(md);
  });
  it('W6 编号变体归一去重', () => {
    const md = '### 室外\n#### 1.3.2 雨污分流\n正文A\n#### 1.3.12 雨污分流\n正文B';
    const result = dedupeRepeatedSubsections(md);
    expect(result).toContain('正文A');
    expect(result).not.toContain('正文B');
  });
  it('W6 非标题行在 skipping 期间被跳过', () => {
    const md = '### 主体结构\n#### 施工准备\n正文A\n#### 施工准备\n被删正文\n普通行\n#### 其他\n保留';
    const result = dedupeRepeatedSubsections(md);
    expect(result).not.toContain('被删正文');
    expect(result).not.toContain('普通行');
    expect(result).toContain('保留');
  });
});

// ── W7. findExtraneousBlockTitles 谱系 ──

describe('W7 清单外标题检测', () => {
  it('W7 全部合法 → 0 条', () => {
    const md = '### 主体结构工程\n#### 施工准备\n#### 施工流程';
    expect(findExtraneousBlockTitles(md, '主体结构工程', ['施工准备', '施工流程'], [])).toEqual([]);
  });
  it('W7 H3 变体（加工程）→ 不报清单外', () => {
    const md = '### 主体结构\n#### 施工准备';
    expect(findExtraneousBlockTitles(md, '主体结构工程', ['施工准备'], [])).toEqual([]);
  });
  it('W7 串章 H3（其他块标题）→ 报', () => {
    const md = '### 装饰装修工程\n#### 施工准备';
    expect(findExtraneousBlockTitles(md, '主体结构工程', ['施工准备'], ['装饰装修工程'])).toEqual(['装饰装修工程']);
  });
  it('W7 自由发挥 H4 → 报', () => {
    const md = '### 主体结构工程\n#### 施工准备\n#### 自由发挥标题';
    expect(findExtraneousBlockTitles(md, '主体结构工程', ['施工准备'], [])).toEqual(['自由发挥标题']);
  });
  it('W7 allowedExtraTitles 白名单放行', () => {
    const md = '### 主体结构工程\n#### 编制说明与工程概况';
    expect(findExtraneousBlockTitles(md, '主体结构工程', ['施工准备'], [], ['编制说明与工程概况'])).toEqual([]);
  });
  it('W7 H5 不参与扫描 → 0 条', () => {
    const md = '### 主体结构工程\n##### 自由发挥';
    expect(findExtraneousBlockTitles(md, '主体结构工程', ['施工准备'], [])).toEqual([]);
  });
  it('W7 编号变体 H4 归一匹配清单', () => {
    const md = '### 主体结构工程\n#### 1. 施工准备';
    expect(findExtraneousBlockTitles(md, '主体结构工程', ['施工准备'], [])).toEqual([]);
  });
});

// ── W8. removeExtraneousBlockSections 谱系 ──

describe('W8 清单外标题块确定性删除', () => {
  it('W8 清单外 H4 整块删除（标题+正文）', () => {
    const md = '### 主体结构工程\n#### 施工准备\n正文A\n#### 自由发挥\n正文B';
    const result = removeExtraneousBlockSections(md, '主体结构工程', ['施工准备']);
    expect(result).toContain('正文A');
    expect(result).not.toContain('自由发挥');
    expect(result).not.toContain('正文B');
  });
  it('W8 串章 H3 标题行删、其下合法 H4 块恢复输出（行为锁定）', () => {
    const md = '### 装饰装修工程\n#### 施工准备\n正文A\n### 主体结构工程\n#### 施工准备\n正文B';
    const result = removeExtraneousBlockSections(md, '主体结构工程', ['施工准备']);
    expect(result).not.toContain('装饰装修工程');
    expect(result).toContain('正文A');
    expect(result).toContain('正文B');
  });
  it('W8 H3 变体保留', () => {
    const md = '### 主体结构\n#### 施工准备\n正文A';
    const result = removeExtraneousBlockSections(md, '主体结构工程', ['施工准备']);
    expect(result).toContain('### 主体结构');
    expect(result).toContain('正文A');
  });
  it('W8 串章 H3 下的合法 H4 块保留（标题行删）', () => {
    const md = '### 装饰装修工程\n#### 施工准备\n正文A\n### 主体结构工程\n#### 施工准备\n正文B';
    const result = removeExtraneousBlockSections(md, '主体结构工程', ['施工准备']);
    expect(result).not.toContain('### 装饰装修工程');
    expect(result).toContain('正文A');
    expect(result).toContain('正文B');
  });
});

// ── W9. stripExtraneousBlockHeadings 谱系 ──

describe('W9 清单外标题行剥离（正文保留）', () => {
  it('W9 清单外 H4 只删标题行、正文保留', () => {
    const md = '### 主体结构工程\n#### 施工准备\n正文A\n#### 自由发挥\n正文B';
    const result = stripExtraneousBlockHeadings(md, '主体结构工程', ['施工准备']);
    expect(result).not.toContain('自由发挥');
    expect(result).toContain('正文B');
    expect(result).toContain('正文A');
  });
  it('W9 串章 H3 只删标题行、正文保留', () => {
    const md = '### 装饰装修工程\n正文A\n### 主体结构工程\n#### 施工准备\n正文B';
    const result = stripExtraneousBlockHeadings(md, '主体结构工程', ['施工准备']);
    expect(result).not.toContain('### 装饰装修工程');
    expect(result).toContain('正文A');
    expect(result).toContain('正文B');
  });
  it('W9 块标题 H3 被写错删除后补回外壳', () => {
    const md = '### 装饰装修工程\n正文A';
    const result = stripExtraneousBlockHeadings(md, '主体结构工程', ['施工准备']);
    expect(result.startsWith('### 主体结构工程')).toBe(true);
    expect(result).toContain('正文A');
  });
  it('W9 块标题 H3 存在时不补外壳', () => {
    const md = '### 主体结构工程\n#### 施工准备\n正文A';
    const result = stripExtraneousBlockHeadings(md, '主体结构工程', ['施工准备']);
    expect(result.startsWith('### 主体结构工程')).toBe(true);
  });
  it('W9 全部合法 → 原样', () => {
    const md = '### 主体结构工程\n#### 施工准备\n正文A';
    expect(stripExtraneousBlockHeadings(md, '主体结构工程', ['施工准备'])).toBe(md);
  });
});
