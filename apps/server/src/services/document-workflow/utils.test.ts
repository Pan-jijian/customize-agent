/**
 * utils 单测：工序顺序表达检测/小节去重/小节提取/标题可比匹配/基础工具函数/自适应并发与信号量。
 */
import { describe, expect, it } from 'vitest';
import {
  BID_DISCIPLINE_PHRASES,
  Semaphore,
  adaptiveConcurrency,
  asObjectArray,
  asStringArray,
  comparableSectionHeadingMatches,
  comparableSectionTitleText,
  dedupeRepeatedSubsections,
  extractSection,
  findDuplicateH4Titles,
  hasProcessSequenceExpression,
  isBidDisciplineSentence,
  normalizeSubsectionTitleForDedup,
  runWithAdaptiveConcurrency,
  safePlanId,
  stableHash,
  stringifyFactValue,
  throwIfAborted,
} from './utils';

describe('hasProcessSequenceExpression', () => {
  it('箭头链（→/->/=>）', () => {
    expect(hasProcessSequenceExpression('基层清理→放线定位→分层摊铺')).toBe(true);
    expect(hasProcessSequenceExpression('开挖->支护->浇筑')).toBe(true);
    expect(hasProcessSequenceExpression('开挖=>支护')).toBe(true);
  });

  it('顺序词引导', () => {
    expect(hasProcessSequenceExpression('按施工程序顺序进行')).toBe(true);
    expect(hasProcessSequenceExpression('先开挖，后浇筑，最后回填')).toBe(true);
    expect(hasProcessSequenceExpression('各工序依次流水施工')).toBe(true);
  });

  it('编号步骤序列（至少 2 步）', () => {
    expect(hasProcessSequenceExpression('1. 开挖\n2. 浇筑')).toBe(true);
    expect(hasProcessSequenceExpression('（1）测量放线\n（2）基坑开挖')).toBe(true);
    expect(hasProcessSequenceExpression('1. 开挖')).toBe(false);
  });

  it('列表序列（至少 2 行）', () => {
    expect(hasProcessSequenceExpression('- 开挖\n- 浇筑')).toBe(true);
    expect(hasProcessSequenceExpression('• 测量\n• 放线')).toBe(true);
    expect(hasProcessSequenceExpression('- 开挖')).toBe(false);
  });

  it('连接线链（至少 3 个环节）', () => {
    expect(hasProcessSequenceExpression('基层清理-放线定位-分层摊铺')).toBe(true);
    expect(hasProcessSequenceExpression('基层清理—放线定位—分层摊铺')).toBe(true);
    expect(hasProcessSequenceExpression('基层清理-放线定位')).toBe(false);
  });

  it('无工序表达 / 空文本', () => {
    expect(hasProcessSequenceExpression('本工程位于市区，交通便利')).toBe(false);
    expect(hasProcessSequenceExpression('')).toBe(false);
  });
});

describe('normalizeSubsectionTitleForDedup', () => {
  it('剥离编号前缀与括号标注与分隔符', () => {
    expect(normalizeSubsectionTitleForDedup('1.3.2 室外雨污分流改造')).toBe('室外雨污分流改造');
    expect(normalizeSubsectionTitleForDedup('室外雨污分流改造（一期）')).toBe('室外雨污分流改造');
    expect(normalizeSubsectionTitleForDedup('室外 雨污：分流 改造')).toBe('室外雨污分流改造');
  });
});

describe('findDuplicateH4Titles', () => {
  it('同 H3 内归一化重复标题被检出（返回原样标题文本）', () => {
    const markdown = ['### 施工准备', '#### 1.1 场地平整', '正文一', '#### 1.2 场地平整', '正文二'].join('\n');
    expect(findDuplicateH4Titles(markdown)).toEqual(['1.2 场地平整']);
  });

  it('跨 H3 的同名 H4 不判重复', () => {
    const markdown = [
      '### 施工准备',
      '#### 场地平整',
      '### 主体结构',
      '#### 场地平整',
    ].join('\n');
    expect(findDuplicateH4Titles(markdown)).toEqual([]);
  });

  it('H2 重置 H3 作用域', () => {
    const markdown = ['### 施工准备', '#### 场地平整', '## 下一章', '#### 场地平整'].join('\n');
    expect(findDuplicateH4Titles(markdown)).toEqual([]);
  });
});

describe('dedupeRepeatedSubsections', () => {
  it('同 H3 内重复小节删除标题与整块正文，跨 H3 保留', () => {
    const content = [
      '### 施工准备',
      '#### 场地平整',
      '正文一',
      '#### 场地平整',
      '正文二',
      '### 主体结构',
      '#### 场地平整',
      '正文三',
    ].join('\n');
    const result = dedupeRepeatedSubsections(content);
    expect(result).toContain('正文一');
    expect(result).not.toContain('正文二');
    expect(result).toContain('正文三');
    // 同 H3 内标题只保留一次
    const occurrences = result.split('\n').filter(line => line.includes('#### 场地平整')).length;
    expect(occurrences).toBe(2);
  });

  it('无重复时原样保留', () => {
    const content = '### 施工准备\n#### 场地平整\n正文';
    expect(dedupeRepeatedSubsections(content)).toBe(content);
  });
});

describe('extractSection（精确模式）', () => {
  const content = [
    '### 1.2 施工部署',
    '部署正文',
    '#### 1.2.1 部署要点',
    '要点正文',
    '### 1.3 施工进度',
    '进度正文',
  ].join('\n');

  it('H3 定界向下包含 H4 子节', () => {
    const section = extractSection(content, '施工部署');
    expect(section).toContain('### 1.2 施工部署');
    expect(section).toContain('部署正文');
    expect(section).toContain('要点正文');
    expect(section).not.toContain('进度正文');
  });

  it('未找到目标返回空串', () => {
    expect(extractSection(content, '不存在的小节')).toBe('');
  });

  it('工作包型关键小节包含同级 H4 工作包正文', () => {
    const workPackageContent = [
      '#### 主要分部分项工程施工方案',
      '概述正文',
      '#### 施工概况',
      '工作包一',
      '#### 施工流程',
      '工作包二',
      '### 下一节',
    ].join('\n');
    const section = extractSection(workPackageContent, '主要分部分项工程施工方案');
    expect(section).toContain('概述正文');
    expect(section).toContain('工作包一');
    expect(section).toContain('工作包二');
    expect(section).not.toContain('下一节');
  });
});

describe('extractSection（模糊模式）', () => {
  it('归一化标题匹配返回最长命中正文（不含标题行）', () => {
    const content = [
      '### 工程特点与重点难点分析',
      '本工程位于市区，特点如下。难点在于工期紧张。',
      '### 施工部署',
      '部署正文内容较长较长较长。',
    ].join('\n');
    const section = extractSection(content, '项目特点、重点、难点分析', { fuzzy: true });
    expect(section).toContain('本工程位于市区');
    expect(section).not.toContain('工程特点与重点难点分析');
  });

  it('未命中返回空串', () => {
    expect(extractSection('### 施工部署\n正文', '完全无关标题', { fuzzy: true })).toBe('');
  });
});

describe('comparableSectionTitleText / comparableSectionHeadingMatches', () => {
  it('标题可比归一化（去编号/空白/泛化词/连接词）', () => {
    expect(comparableSectionTitleText('1.3 项目特点、重点、难点分析')).toBe('特点难点分析');
  });

  it('归一化相等 → 匹配', () => {
    expect(comparableSectionHeadingMatches('工程特点与重点难点分析', '项目特点、重点、难点分析')).toBe(true);
  });

  it('归一化后 <4 字不参与匹配（防误匹配保护）', () => {
    expect(comparableSectionHeadingMatches('主要施工方法', '施工方法')).toBe(false);
    expect(comparableSectionHeadingMatches('施工流程', '主要施工流程')).toBe(false);
  });

  it('空标题不匹配', () => {
    expect(comparableSectionHeadingMatches('', '施工部署')).toBe(false);
  });
});

describe('stableHash', () => {
  it('同结构同哈希、顺序敏感、十六进制 40 位', () => {
    const hash = stableHash({ a: 1, b: [1, 2] });
    expect(hash).toBe(stableHash({ a: 1, b: [1, 2] }));
    expect(hash).not.toBe(stableHash({ a: 1, b: [2, 1] }));
    expect(hash).toMatch(/^[0-9a-f]{40}$/u);
  });
});

describe('asStringArray', () => {
  it('数组去空/单字符串/非法类型', () => {
    expect(asStringArray(['a', ' b ', ''])).toEqual(['a', 'b']);
    expect(asStringArray(' x ')).toEqual(['x']);
    expect(asStringArray('')).toEqual([]);
    expect(asStringArray(123)).toEqual([]);
    expect(asStringArray([null, 'a'])).toEqual(['a']);
  });
});

describe('asObjectArray', () => {
  it('数组过滤非对象/单对象包装', () => {
    expect(asObjectArray([{ a: 1 }, null, 'x'])).toEqual([{ a: 1 }]);
    expect(asObjectArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asObjectArray('x')).toEqual([]);
    expect(asObjectArray(null)).toEqual([]);
  });
});

describe('safePlanId', () => {
  it('归一化并限长 48 字符，空值回退', () => {
    expect(safePlanId('ABC 中文!#$', 'fallback')).toBe('abc-中文');
    expect(safePlanId('', 'fallback')).toBe('fallback');
    expect(safePlanId('!!!', 'fallback')).toBe('fallback');
    expect(safePlanId('a'.repeat(60), 'fallback')).toHaveLength(48);
  });
});

describe('stringifyFactValue', () => {
  it('各类值序列化', () => {
    expect(stringifyFactValue(null)).toBe('');
    expect(stringifyFactValue(undefined)).toBe('');
    expect(stringifyFactValue('文本')).toBe('文本');
    expect(stringifyFactValue(123)).toBe('123');
    expect(stringifyFactValue(true)).toBe('true');
    expect(stringifyFactValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('throwIfAborted', () => {
  it('无信号或未中止不抛错', () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('已中止抛出用户中止错误', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow('用户中止');
  });
});

describe('adaptiveConcurrency', () => {
  it('全量同批启动（不设档位上限）', () => {
    expect(adaptiveConcurrency({ total: 5, kind: 'chapter' })).toBe(5);
    expect(adaptiveConcurrency({ total: 0, kind: 'search' })).toBe(1);
  });
});

describe('runWithAdaptiveConcurrency', () => {
  it('空数组直接返回空结果', async () => {
    await expect(runWithAdaptiveConcurrency([], async item => item, { kind: 'chapter' })).resolves.toEqual([]);
  });

  it('结果按原顺序落位（异步乱序完成不影响顺序）', async () => {
    const results = await runWithAdaptiveConcurrency([1, 2, 3, 4], async (item, index) => {
      await new Promise(resolve => setTimeout(resolve, index === 3 ? 1 : 10));
      return item * 2;
    }, { kind: 'chapter', concurrency: 4 });
    expect(results).toEqual([2, 4, 6, 8]);
  });

  it('concurrency 限制在有效区间', async () => {
    const worker = async (item: number) => item;
    await expect(runWithAdaptiveConcurrency([1, 2, 3], worker, { kind: 'search', concurrency: 99 })).resolves.toEqual([1, 2, 3]);
  });
});

describe('Semaphore', () => {
  it('限流 2：同时最多 2 个任务在飞', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const jobs = Array.from({ length: 5 }, (_, index) => semaphore.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return index;
    }));
    const results = await Promise.all(jobs);
    expect(maxActive).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('limit 非法值回退为 1 且 run 透传工作结果', async () => {
    const semaphore = new Semaphore(0);
    expect(await semaphore.run(async () => 'done')).toBe('done');
  });
});

describe('isBidDisciplineSentence（评分报告问题2：商务纪律句判定）', () => {
  it('词表词面命中：全部禁写词逐一命中', () => {
    for (const phrase of BID_DISCIPLINE_PHRASES) {
      expect(isBidDisciplineSentence(`我公司严格遵守${phrase}相关规定。`)).toBe(true);
    }
  });

  it('无禁词词面变体（评分报告原文）按语境判定命中', () => {
    // 评分报告（21）原文：无任何禁写词词面，旧 6 词表清洗/检测双漏
    const reportOriginal = '我公司对参与本项目投标及施工组织设计编制的工作人员实行严格的纪律管理，确保投标活动合法合规。';
    expect(isBidDisciplineSentence(reportOriginal)).toBe(true);
  });

  it('廉洁语境 + 评标相关表述命中', () => {
    expect(isBidDisciplineSentence('项目全体人员签订廉洁从业承诺书。')).toBe(true);
    expect(isBidDisciplineSentence('参与评标活动的工作人员签订廉洁自律承诺。')).toBe(true);
  });

  it('技术标合法用法不误伤：劳动纪律/施工纪律/作息纪律不含商务语境词', () => {
    expect(isBidDisciplineSentence('项目部严格执行劳动纪律与考勤管理制度。')).toBe(false);
    expect(isBidDisciplineSentence('施工纪律要求各班组按时参加班前安全交底。')).toBe(false);
    expect(isBidDisciplineSentence('高温季节调整作息时间，保障作业人员休息纪律。')).toBe(false);
    expect(isBidDisciplineSentence('本工程创优目标为确保黄山杯。')).toBe(false);
    expect(isBidDisciplineSentence('项目部组织全员开展安全生产教育培训。')).toBe(false);
  });
});
