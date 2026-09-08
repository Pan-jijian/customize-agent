/**
 * t2-cq 第二批矩阵（WW2）：utils.ts 剩余纯函数族边界枚举。
 * 覆盖：dedupeCrossSectionSkeletonH4s（章级作用域串章骨架删除）、extractSection（exact/fuzzy 双口径）、
 * comparableSectionTitleText / comparableSectionHeadingMatches（标题可比归一化与 <4 字保护）、
 * alignSectionHeadingsToPlan（C2 备用稿标题对齐）、stableHash / asStringArray / asObjectArray / safePlanId、
 * stringifyFactValue / throwIfAborted / systemConstraintLine、
 * isBidDisciplineSentence / filterBidDisciplineFacts（商务纪律禁写）、
 * adaptiveConcurrency / runWithAdaptiveConcurrency / Semaphore（并发调度）。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  alignSectionHeadingsToPlan,
  adaptiveConcurrency,
  asObjectArray,
  asStringArray,
  BID_DISCIPLINE_PHRASES,
  comparableSectionHeadingMatches,
  comparableSectionTitleText,
  dedupeCrossSectionSkeletonH4s,
  extractSection,
  filterBidDisciplineFacts,
  isBidDisciplineSentence,
  runWithAdaptiveConcurrency,
  safePlanId,
  Semaphore,
  stableHash,
  stringifyFactValue,
  systemConstraintLine,
  SYSTEM_CONSTRAINT_PREFIX,
  throwIfAborted,
} from '@/services/document-workflow/utils';

describe('W10 dedupeCrossSectionSkeletonH4s 章级作用域', () => {
  it('无章标题（无 ##）时原样返回', () => {
    const md = '### 绿化工程\n正文\n';
    expect(dedupeCrossSectionSkeletonH4s(md)).toBe(md);
  });

  it('H4 与章内 H3 同名 → 该 H4 块整块删除（标题+正文至下一标题）', () => {
    const md = [
      '## 第一章',
      '### 绿化工程',
      '分部正文',
      '#### 绿化工程',
      '同名正文',
      '### 道路工程',
      '道路正文',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).not.toContain('#### 绿化工程');
    expect(out).not.toContain('同名正文');
    expect(out).toContain('分部正文');
    expect(out).toContain('### 道路工程');
  });

  it('编号形态 H4「3 绿化工程」与 H3「绿化工程」同名 → 结构性引用不删', () => {
    const md = [
      '## 第一章',
      '### 绿化工程',
      '#### 3 绿化工程',
      '总述正文',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).toContain('#### 3 绿化工程');
    expect(out).toContain('总述正文');
  });

  it('中文数字编号形态 H4「三、绿化工程」同样豁免', () => {
    const md = [
      '## 第一章',
      '### 绿化工程',
      '#### 三、绿化工程',
      '总述正文',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).toContain('#### 三、绿化工程');
  });

  it('容器 H3（主要分部分项工程施工方案）内引用分部名 H4 → 不删', () => {
    const md = [
      '## 第一章',
      '### 主要分部分项工程施工方案',
      '#### 绿化工程',
      '容器总述正文',
      '### 绿化工程',
      '分部正文',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).toContain('#### 绿化工程');
    expect(out).toContain('容器总述正文');
  });

  it('「项目主要施工内容」容器 H3 同样豁免', () => {
    const md = [
      '## 第一章',
      '### 项目主要施工内容',
      '#### 道路工程',
      '内容总述',
      '### 道路工程',
      '分部正文',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).toContain('内容总述');
  });

  it('非泛化 H4 跨 H3 重复 → 保留首次、删后续整块', () => {
    const md = [
      '## 第一章',
      '### 分部A',
      '#### 特殊要点',
      '正文A',
      '### 分部B',
      '#### 特殊要点',
      '正文B',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).toContain('正文A');
    expect(out).not.toContain('正文B');
  });

  it('泛化白名单 H4（施工准备）跨 H3 重复 → 全部保留', () => {
    const md = [
      '## 第一章',
      '### 分部A',
      '#### 施工准备',
      '准备A',
      '### 分部B',
      '#### 施工准备',
      '准备B',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).toContain('准备A');
    expect(out).toContain('准备B');
  });

  it('跨章同名 H4 互不影响（章级作用域重置）', () => {
    const md = [
      '## 第一章',
      '### 分部A',
      '#### 特殊要点',
      '正文A',
      '## 第二章',
      '### 分部C',
      '#### 特殊要点',
      '正文C',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).toContain('正文A');
    expect(out).toContain('正文C');
  });

  it('同名 H4 块删除止于章边界（下一章内容不连坐）', () => {
    const md = [
      '## 第一章',
      '### 绿化工程',
      '#### 绿化工程',
      '同名正文',
      '## 第二章',
      '第二章正文',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).not.toContain('同名正文');
    expect(out).toContain('第二章正文');
  });

  it('被删 H4 块内的 H5 子标题与正文一并删除', () => {
    const md = [
      '## 第一章',
      '### 绿化工程',
      '#### 绿化工程',
      '##### 子要点',
      '子正文',
      '### 下一节',
    ].join('\n');
    const out = dedupeCrossSectionSkeletonH4s(md);
    expect(out).not.toContain('子要点');
    expect(out).not.toContain('子正文');
  });
});

describe('W11 extractSection（exact/fuzzy 双口径）', () => {
  it('exact：H3 标题命中，返回含标题行块至下一 H3', () => {
    const md = [
      '## 第一章',
      '### 施工部署',
      '部署正文',
      '### 施工平面布置',
      '平面正文',
    ].join('\n');
    const out = extractSection(md, '施工部署');
    expect(out).toContain('### 施工部署');
    expect(out).toContain('部署正文');
    expect(out).not.toContain('平面正文');
  });

  it('exact：编号形态 H3「### 1.2 施工部署」同样命中', () => {
    const md = ['### 1.2 施工部署', '部署正文'].join('\n');
    const out = extractSection(md, '施工部署');
    expect(out).toContain('部署正文');
  });

  it('exact：H3 下 H4 子节正文包含', () => {
    const md = [
      '### 施工部署',
      '#### 组织架构',
      '架构正文',
      '### 下一节',
    ].join('\n');
    const out = extractSection(md, '施工部署');
    expect(out).toContain('架构正文');
  });

  it('exact：子串命中——「施工部署与流水组织」含「施工部署」→ 命中', () => {
    const md = ['### 施工部署与流水组织', '正文X'].join('\n');
    expect(extractSection(md, '施工部署')).toContain('正文X');
  });

  it('exact：无匹配 → 空串', () => {
    expect(extractSection('### 施工部署\n正文', '不存在的节')).toBe('');
  });

  it('exact：无 H3 命中时回退 H4 标题（#{3,4} 二级扫描）', () => {
    const md = ['#### 普通要点', '要点正文'].join('\n');
    const out = extractSection(md, '普通要点');
    expect(out).toContain('要点正文');
  });

  it('exact：工作包型 H4（主要施工方法）同级 H4 是正文非边界', () => {
    const md = [
      '#### 主要施工方法',
      '方法正文',
      '#### 施工流程',
      '流程正文',
      '### 上级节',
    ].join('\n');
    const out = extractSection(md, '主要施工方法');
    expect(out).toContain('流程正文');
    expect(out).not.toContain('### 上级节');
  });

  it('exact：非工作包 H4 遇同级 H4 截断', () => {
    const md = [
      '#### 普通要点',
      '要点正文',
      '#### 另一个要点',
      '另一正文',
    ].join('\n');
    const out = extractSection(md, '普通要点');
    expect(out).toContain('要点正文');
    expect(out).not.toContain('另一正文');
  });

  it('fuzzy：H3 精确命中，正文不含标题行', () => {
    const md = ['### 施工部署', '部署正文A', '### 其他'].join('\n');
    const out = extractSection(md, '施工部署', { fuzzy: true });
    expect(out).not.toContain('### 施工部署');
    expect(out).toContain('部署正文A');
  });

  it('fuzzy：H3 命中后 H4 子节正文包含（H3 零正文场景）', () => {
    const md = [
      '### 危大工程专项施工方案审批流程',
      '#### 方案一',
      '方案正文一',
      '#### 方案二',
      '方案正文二',
    ].join('\n');
    const out = extractSection(md, '危大工程专项施工方案审批流程', { fuzzy: true });
    expect(out).toContain('方案正文一');
    expect(out).toContain('方案正文二');
  });

  it('fuzzy：可比标题匹配（项目特点、重点、难点分析 ↔ 工程特点与重点难点分析）', () => {
    const md = ['### 项目特点、重点、难点分析', '特点正文X', '## 下章'].join('\n');
    const out = extractSection(md, '工程特点与重点难点分析', { fuzzy: true });
    expect(out).toContain('特点正文X');
  });

  it('fuzzy：正包含命中（#### 主要施工方法 被「施工方法」命中）', () => {
    const md = ['#### 主要施工方法', '方法正文Y'].join('\n');
    const out = extractSection(md, '施工方法', { fuzzy: true });
    expect(out).toContain('方法正文Y');
  });

  it('fuzzy：多命中取最长正文段', () => {
    const md = [
      '### 施工部署',
      '短',
      '### 施工部署与流水组织',
      '长正文'.repeat(20),
    ].join('\n');
    const out = extractSection(md, '施工部署', { fuzzy: true });
    expect(out).toContain('长正文');
  });

  it('fuzzy：无匹配 → 空串', () => {
    expect(extractSection('### 施工部署\n正文', '不存在的节', { fuzzy: true })).toBe('');
  });
});

describe('W12 comparableSectionTitleText / comparableSectionHeadingMatches', () => {
  it('去编号前缀：#### 1.3.2 室外雨污分流改造 → 室外雨污分流改造', () => {
    expect(comparableSectionTitleText('#### 1.3.2 室外雨污分流改造')).toBe('室外雨污分流改造');
  });

  it('中文数字编号剥离+工程尾缀剥离：### 三、绿化工程 → 绿化', () => {
    expect(comparableSectionTitleText('### 三、绿化工程')).toBe('绿化');
  });

  it('修饰词剥离：项目特点、重点、难点分析 → 特点难点分析', () => {
    expect(comparableSectionTitleText('项目特点、重点、难点分析')).toBe('特点难点分析');
  });

  it('施工(?=方案|流程|方法) 剥离：主要施工方法 → 方法', () => {
    expect(comparableSectionTitleText('主要施工方法')).toBe('方法');
  });

  it('施工部署不剥离（施工后非方案/流程/方法）', () => {
    expect(comparableSectionTitleText('施工部署')).toBe('施工部署');
  });

  it('连接词剥离：工程特点与重点难点分析 → 特点难点分析', () => {
    expect(comparableSectionTitleText('工程特点与重点难点分析')).toBe('特点难点分析');
  });

  it('matches：<4 字保护——「主要施工方法」vs「施工方法」→ false', () => {
    expect(comparableSectionHeadingMatches('主要施工方法', '施工方法')).toBe(false);
  });

  it('matches：施工流程 vs 施工流程 → false（归一化 2 字）', () => {
    expect(comparableSectionHeadingMatches('施工流程', '施工流程')).toBe(false);
  });

  it('matches：重点难点分析 vs 工程特点与重点难点分析 → true（4字子串包含）', () => {
    expect(comparableSectionHeadingMatches('重点难点分析', '工程特点与重点难点分析')).toBe(true);
  });

  it('matches：完全一致（危大方案审批流程）→ true', () => {
    expect(comparableSectionHeadingMatches('危大方案审批流程', '危大方案审批流程')).toBe(true);
  });

  it('matches：空串一侧 → false', () => {
    expect(comparableSectionHeadingMatches('', '施工部署')).toBe(false);
  });

  it('matches：完全无关 → false', () => {
    expect(comparableSectionHeadingMatches('施工部署', '材料管理')).toBe(false);
  });
});

describe('W13 alignSectionHeadingsToPlan 备用稿标题对齐', () => {
  it('计划标题为空 → 原样返回', () => {
    const md = '### 施工部署\n正文';
    expect(alignSectionHeadingsToPlan(md, [])).toBe(md);
  });

  it('变体 H3 对齐到计划标题', () => {
    const md = '### 施工部署与流水组织\n正文X';
    const out = alignSectionHeadingsToPlan(md, ['施工部署']);
    expect(out).toContain('### 施工部署\n正文X');
  });

  it('同一计划标题只对齐一处（第二处保持原样）', () => {
    const md = ['### 施工部署与流水组织', 'A', '### 施工部署及安排', 'B'].join('\n');
    const out = alignSectionHeadingsToPlan(md, ['施工部署']);
    expect(out).toContain('### 施工部署\nA');
    expect(out).toContain('### 施工部署及安排');
  });

  it('headingLevel=3 只对齐 H3（H4 不动）', () => {
    const md = ['#### 施工部署与流水组织', 'H4正文'].join('\n');
    const out = alignSectionHeadingsToPlan(md, ['施工部署'], 3);
    expect(out).toContain('#### 施工部署与流水组织');
  });

  it('headingLevel=4 只对齐 H4', () => {
    const md = ['#### 施工部署与流水组织', 'H4正文'].join('\n');
    const out = alignSectionHeadingsToPlan(md, ['施工部署'], 4);
    expect(out).toContain('#### 施工部署');
  });

  it('精确同标题不占 used 配额（matched===currentTitle 早返回）', () => {
    const md = ['### 施工部署', 'A', '### 施工部署', 'B'].join('\n');
    const out = alignSectionHeadingsToPlan(md, ['施工部署']);
    expect(out).toBe(md);
  });

  it('替换会丢失原标题编号（headingPrefix 只含 ###）', () => {
    const md = '### 1.2 施工部署与流水组织';
    const out = alignSectionHeadingsToPlan(md, ['施工部署']);
    expect(out).toBe('### 施工部署');
  });

  it('无法匹配的标题保持原样', () => {
    const md = '### 完全无关标题\n正文';
    const out = alignSectionHeadingsToPlan(md, ['施工部署']);
    expect(out).toContain('### 完全无关标题');
  });
});

describe('W14 stableHash / asStringArray / asObjectArray / safePlanId', () => {
  it('stableHash：同值同哈希', () => {
    expect(stableHash('合肥肥西')).toBe(stableHash('合肥肥西'));
  });

  it('stableHash：异值异哈希', () => {
    expect(stableHash('合肥肥西')).not.toBe(stableHash('芜湖繁昌'));
  });

  it('stableHash：对象键序敏感（JSON.stringify 口径）', () => {
    expect(stableHash({ a: 1, b: 2 })).not.toBe(stableHash({ b: 2, a: 1 }));
  });

  it('asStringArray：数组元素转字符串去空白、falsy 过滤', () => {
    expect(asStringArray([' 主体 ', '', '0', 0, null, 'b'])).toEqual(['主体', '0', 'b']);
  });

  it('asStringArray：字符串 → 单元素', () => {
    expect(asStringArray(' 单值 ')).toEqual(['单值']);
  });

  it('asStringArray：空串 / null / 数字 → []', () => {
    expect(asStringArray('')).toEqual([]);
    expect(asStringArray(null)).toEqual([]);
    expect(asStringArray(42)).toEqual([]);
  });

  it('asObjectArray：数组过滤非对象', () => {
    expect(asObjectArray([{ a: 1 }, null, 'x', { b: 2 }])).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('asObjectArray：单对象包裹', () => {
    expect(asObjectArray({ a: 1 })).toEqual([{ a: 1 }]);
  });

  it('asObjectArray：null / 字符串 / 空数组 → []', () => {
    expect(asObjectArray(null)).toEqual([]);
    expect(asObjectArray('s')).toEqual([]);
    expect(asObjectArray([])).toEqual([]);
  });

  it('safePlanId：非法字符归一为连字符、去首尾', () => {
    expect(safePlanId('合肥·肥西 丰乐镇_Road!', 'fallback')).toBe('合肥-肥西-丰乐镇-road');
  });

  it('safePlanId：截断 48 字符', () => {
    expect(safePlanId('a'.repeat(60), 'f').length).toBe(48);
  });

  it('safePlanId：全非法字符 → 连续非法字符整体归一为一个连字符后再去首尾 → 空 → fallback', () => {
    expect(safePlanId('!!!', 'fb')).toBe('fb');
  });

  it('safePlanId：空串 → fallback', () => {
    expect(safePlanId('', '备用id')).toBe('备用id');
  });
});

describe('W15 stringifyFactValue / throwIfAborted / systemConstraintLine', () => {
  it('stringifyFactValue：null / undefined → 空串', () => {
    expect(stringifyFactValue(null)).toBe('');
    expect(stringifyFactValue(undefined)).toBe('');
  });

  it('stringifyFactValue：原始类型直转', () => {
    expect(stringifyFactValue('文本')).toBe('文本');
    expect(stringifyFactValue(42)).toBe('42');
    expect(stringifyFactValue(true)).toBe('true');
  });

  it('stringifyFactValue：数组 / 对象 JSON 序列化', () => {
    expect(stringifyFactValue(['a', 1])).toBe('["a",1]');
    expect(stringifyFactValue({ k: 'v' })).toBe('{"k":"v"}');
  });

  it('stringifyFactValue：循环引用回退 String', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(stringifyFactValue(o)).toBe('[object Object]');
  });

  it('throwIfAborted：无 signal / 未中止 → 不抛', () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted({ aborted: false } as AbortSignal)).not.toThrow();
  });

  it('throwIfAborted：已中止 → 抛「用户中止」', () => {
    expect(() => throwIfAborted({ aborted: true } as AbortSignal)).toThrow('用户中止');
  });

  it('systemConstraintLine：统一前缀 + 文本（前缀声明禁止写入正文）', () => {
    expect(systemConstraintLine('约束X')).toBe(`${SYSTEM_CONSTRAINT_PREFIX}约束X`);
    expect(SYSTEM_CONSTRAINT_PREFIX).toContain('禁止写入正文');
  });
});

describe('W16 isBidDisciplineSentence / filterBidDisciplineFacts', () => {
  it.each(BID_DISCIPLINE_PHRASES)('禁写词「%s」→ true', (phrase) => {
    expect(isBidDisciplineSentence(`正文${phrase}内容`)).toBe(true);
  });

  it('「廉洁从业」固定词组 → true', () => {
    expect(isBidDisciplineSentence('坚持廉洁从业')).toBe(true);
  });

  it('纪律 + 商务语境词（投标）→ true（无禁词词面兜底）', () => {
    expect(isBidDisciplineSentence('对参与本项目投标的工作人员实行严格的纪律管理，确保投标活动合法合规')).toBe(true);
  });

  it('廉洁 + 评标语境 → true', () => {
    expect(isBidDisciplineSentence('秉持廉洁文化，尊重评标专家独立评审')).toBe(true);
  });

  it('劳动纪律（无商务语境词）→ false', () => {
    expect(isBidDisciplineSentence('加强劳动纪律管理')).toBe(false);
  });

  it('施工纪律 → false', () => {
    expect(isBidDisciplineSentence('严格执行施工纪律')).toBe(false);
  });

  it('普通技术句 → false', () => {
    expect(isBidDisciplineSentence('混凝土浇筑前进行隐蔽验收')).toBe(false);
  });

  it('filterBidDisciplineFacts：禁词事实剔除、正常事实保留', () => {
    const facts = [
      { key: '评标纪律', value: 'xx' },
      { key: '工期', value: '360日历天' },
      { key: '承诺', value: '不串标' },
    ];
    expect(filterBidDisciplineFacts(facts)).toEqual([{ key: '工期', value: '360日历天' }]);
  });

  it('filterBidDisciplineFacts：key+value 拼接判定', () => {
    const facts = [{ key: '廉洁承诺', value: 'x' }, { key: '质量', value: '合格' }];
    expect(filterBidDisciplineFacts(facts)).toEqual([{ key: '质量', value: '合格' }]);
  });
});

describe('W17 adaptiveConcurrency / runWithAdaptiveConcurrency / Semaphore', () => {
  it('adaptiveConcurrency：全部任务同批（total 即并发）', () => {
    expect(adaptiveConcurrency({ total: 7, kind: 'chapter' })).toBe(7);
  });

  it('adaptiveConcurrency：total=0 → 1', () => {
    expect(adaptiveConcurrency({ total: 0, kind: 'search' })).toBe(1);
  });

  it('runWithAdaptiveConcurrency：空数组 → 空结果', async () => {
    expect(await runWithAdaptiveConcurrency([], async () => 1, { kind: 'chapter' })).toEqual([]);
  });

  it('runWithAdaptiveConcurrency：全部执行且结果顺序与输入一致', async () => {
    const out = await runWithAdaptiveConcurrency([1, 2, 3, 4, 5], async (n) => n * 10, { kind: 'chapter', concurrency: 3 });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('runWithAdaptiveConcurrency：并发峰值不超过指定值', async () => {
    let active = 0;
    let peak = 0;
    await runWithAdaptiveConcurrency(Array.from({ length: 6 }, (_, i) => i), async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
      return n;
    }, { kind: 'llmRepair', concurrency: 2 });
    expect(peak).toBe(2);
  });

  it('runWithAdaptiveConcurrency：未指定 concurrency 时全量并发', async () => {
    let active = 0;
    let peak = 0;
    await runWithAdaptiveConcurrency([1, 2, 3], async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
    }, { kind: 'deepRetrieval' });
    expect(peak).toBe(3);
  });

  it('Semaphore：limit=2 并发峰值受限', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 5 }, () => sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active -= 1;
    })));
    expect(peak).toBe(2);
  });

  it('Semaphore：非法 limit 回退 1', async () => {
    const sem = new Semaphore(0);
    let active = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 3 }, () => sem.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
    })));
    expect(peak).toBe(1);
  });

  it('Semaphore：run 返回工作结果', async () => {
    const sem = new Semaphore(1);
    expect(await sem.run(async () => 42)).toBe(42);
  });

  it('Semaphore：工作抛错后释放许可（后续任务可继续）', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await sem.run(async () => 'ok')).toBe('ok');
  });
});
