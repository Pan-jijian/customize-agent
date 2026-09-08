/**
 * 边界矩阵（P1 第 28 批 · EE 组）
 * 覆盖：excavationDepthLockIssues 深挖增量（门槛/窗口宽度/排除词谱系/时间单位边界）/
 * excavationDepthFromFacts 深挖增量（精确过滤边界/多源取最大/关键词门谱系/canonical 滑标防御）/
 * excavationHazardClassificationIssues 深挖增量（分级精确边界/suggestion 数值注入）/
 * foundationFormResidueIssues 增量（六桩词谱系/块豁免/标题匹配变体/块边界）/
 * fixForbiddenConfigurationTerms 增量（逗号形态/计数/变体）/
 * 四器清洗链组合（顺序应用/幂等）
 * 原则：每条用例独立断言意义；真实实现行为一律锁定，不迎合用例改实现。
 */
import { describe, expect, it } from 'vitest';
import {
  excavationDepthFromFacts, excavationDepthLockIssues,
  excavationHazardClassificationIssues, fixAdjacentPhraseDuplication,
  fixAmbiguousEitherOrCandidates, fixForbiddenConfigurationTerms,
  fixInternalTerminology, foundationFormResidueIssues,
} from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

const depthModel = (value: string) => factsOf({ canonical: { byKey: { excavation_depth: { value } } } as never });

// ── EE1. excavationDepthLockIssues 深挖增量 ──

describe('EE1 基坑深度锁定：门槛与窗口宽度', () => {
  it('EE1 pitHits 2 处不检、3 处报（精确门槛）', () => {
    expect(excavationDepthLockIssues('基坑。开挖。')).toHaveLength(0);
    expect(excavationDepthLockIssues('基坑。开挖。支护。')).toHaveLength(1);
  });
  it('EE1 仅「支护」三次也触发（三词独立计数）', () => {
    expect(excavationDepthLockIssues('支护。支护。支护。')).toHaveLength(1);
  });
  it('EE1 去空格后计数（基 坑 开 挖 分散空格）', () => {
    expect(excavationDepthLockIssues('基 坑 开 挖。边坡支护。深度表述缺失。')).toHaveLength(1);
  });
  it('EE1 「深度」后 12 字内数值锁定（窗口上限含等）', () => {
    expect(excavationDepthLockIssues(`基坑开挖。边坡支护。深度${'甲'.repeat(12)}5.85m。`)).toHaveLength(0);
  });
  it('EE1 「深度」后 13 字超窗不锁定 → 报', () => {
    expect(excavationDepthLockIssues(`基坑开挖。边坡支护。深度${'甲'.repeat(13)}5.85m。`)).toHaveLength(1);
  });
  it('EE1 冒号形态锁定（深度：5.85m）', () => {
    expect(excavationDepthLockIssues('基坑开挖。边坡支护。开挖深度：5.85m。')).toHaveLength(0);
  });
  it('EE1 「达」形态锁定（深度达5.85m）', () => {
    expect(excavationDepthLockIssues('基坑开挖。边坡支护。开挖深度达5.85m。')).toHaveLength(0);
  });
  it('EE1 无数字的排除词句（深度参考图纸）→ 报', () => {
    expect(excavationDepthLockIssues('基坑开挖。边坡支护。开挖深度参考设计图纸执行。')).toHaveLength(1);
  });
});

describe('EE1 基坑深度锁定：排除词谱系补全', () => {
  it.each(['不小于3m', '不低于3m', '高于5m', '低于5m', '每层1m', '依据勘察报告5.85m'])(
    'EE1 排除词“%s”不算锁定',
    (fragment) => {
      expect(excavationDepthLockIssues(`基坑开挖。边坡支护。开挖深度${fragment}。`)).toHaveLength(1);
    },
  );
  it('EE1 时间单位天排除（深度3天）', () => {
    expect(excavationDepthLockIssues('基坑开挖。边坡支护。分层开挖深度3天完成。')).toHaveLength(1);
  });
  it('EE1 数字后窗口内时间单位连带排除（深度5.85m范围内24h）', () => {
    expect(excavationDepthLockIssues('基坑开挖。边坡支护。开挖深度5.85m范围内24h完成垫层。')).toHaveLength(1);
  });
  it('EE1 标点截断窗口后时间单位不影响锁定（深度5.85m，24h内完成）', () => {
    expect(excavationDepthLockIssues('基坑开挖。边坡支护。开挖深度5.85m，24h内完成垫层。')).toHaveLength(0);
  });
  it('EE1 排除窗口在前、锁定句在后 → 不报（首个有效窗口即锁定）', () => {
    expect(excavationDepthLockIssues('基坑开挖。边坡支护。开挖深度超过3m属危大。本工程开挖深度5.85m。')).toHaveLength(0);
  });
  it('EE1 锁定句在前、排除窗口在后 → 不报（遍历顺序无关）', () => {
    expect(excavationDepthLockIssues('基坑开挖。边坡支护。本工程开挖深度5.85m。开挖深度超过3m属危大。')).toHaveLength(0);
  });
  it('EE1 message 与 suggestion 形态（无示例数值泄漏）', () => {
    const issues = excavationDepthLockIssues('基坑开挖。边坡支护。开挖深度按图纸确定。');
    expect(issues[0].message).toContain('基坑深度数值未锁定');
    expect(issues[0].suggestion).toContain('≥5m');
    expect(issues[0].suggestion).not.toContain('5.85');
    expect(issues[0].severity).toBe('blocker');
  });
});

// ── EE2. excavationDepthFromFacts 深挖增量 ──

describe('EE2 深度提取：关键词门谱系与精确过滤', () => {
  it('EE2 preciseFacts 关键词命中采值', () => {
    const model = factsOf({ preciseFacts: [factOf({ fieldName: '开挖深度', value: '5.2m' })] });
    expect(excavationDepthFromFacts(model)).toBe(5.2);
  });
  it('EE2 「坡底线」关键词命中采值（负标高取绝对值）', () => {
    const model = factsOf({ drawings: [factOf({ fieldName: '坡底线', value: '标高-6.1m' })] });
    expect(excavationDepthFromFacts(model)).toBe(6.1);
  });
  it('EE2 「坑底标高」关键词命中采值', () => {
    const model = factsOf({ project: [factOf({ fieldName: '坑底标高', value: '7.3m' })] });
    expect(excavationDepthFromFacts(model)).toBe(7.3);
  });
  it('EE2 过滤下界精确：1m 保留、0.99m 排除', () => {
    expect(excavationDepthFromFacts(depthModel('1m'))).toBe(1);
    expect(excavationDepthFromFacts(depthModel('0.99m'))).toBeUndefined();
  });
  it('EE2 过滤上界精确：49.9m 保留、50m 排除', () => {
    expect(excavationDepthFromFacts(depthModel('49.9m'))).toBe(49.9);
    expect(excavationDepthFromFacts(depthModel('50m'))).toBeUndefined();
  });
  it('EE2 多图纸值取最大（无 canonical）', () => {
    const model = factsOf({
      drawings: [factOf({ fieldName: '基坑深度', value: '4.2m' }), factOf({ fieldName: '基坑深度', value: '5.8m' })],
    });
    expect(excavationDepthFromFacts(model)).toBe(5.8);
  });
  it('EE2 canonical 缺失不滑标（图纸值独立提取）', () => {
    const model = factsOf({ drawings: [factOf({ fieldName: '基坑深度', value: '4.5m' })] });
    expect(excavationDepthFromFacts(model)).toBe(4.5);
  });
  it('EE2 空模型 → undefined', () => {
    expect(excavationDepthFromFacts(factsOf({}))).toBeUndefined();
  });
  it('EE2 factTexts 比较式条文排除（16m及以上不采）', () => {
    const model = factsOf({ drawings: [factOf({ fieldName: '开挖深度', value: '开挖深度16m及以上' })] });
    expect(excavationDepthFromFacts(model)).toBeUndefined();
  });
  it('EE2 canonical 比较式被排除 + 图纸正常值兜底', () => {
    const model = factsOf({
      canonical: { byKey: { excavation_depth: { value: '开挖深度16m及以上' } } } as never,
      drawings: [factOf({ fieldName: '基坑深度', value: '4.5m' })],
    });
    expect(excavationDepthFromFacts(model)).toBe(4.5);
  });
  it('EE2 图纸无关键词门数值不误采（现场宽度 28m）', () => {
    const model = factsOf({ drawings: [factOf({ fieldName: '现场宽度', value: '28m' })] });
    expect(excavationDepthFromFacts(model)).toBeUndefined();
  });
});

// ── EE3. excavationHazardClassificationIssues 深挖增量 ──

describe('EE3 危大分级：精确边界与消息注入', () => {
  it('EE3 深度 undefined 早退', () => {
    expect(excavationHazardClassificationIssues('正文无标注。', factsOf({}))).toHaveLength(0);
  });
  it('EE3 3.0m 精确报 1 条（>=3 门槛含等）', () => {
    const issues = excavationHazardClassificationIssues('正文无标注。', depthModel('3.0m'));
    expect(issues).toHaveLength(1);
  });
  it('EE3 4.99m 报 1 条（<5 不触发超危大）', () => {
    const issues = excavationHazardClassificationIssues('正文无标注。', depthModel('4.99m'));
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('危大工程判定缺失');
  });
  it('EE3 5.0m 精确报 2 条（>=5 门槛含等）', () => {
    expect(excavationHazardClassificationIssues('正文无标注。', depthModel('5.0m'))).toHaveLength(2);
  });
  it('EE3 3m 正文已有危大标注 → 不报', () => {
    expect(excavationHazardClassificationIssues('本工程属危大工程。', depthModel('3.5m'))).toHaveLength(0);
  });
  it('EE3 message 与 suggestion 注入实际深度值', () => {
    const issues = excavationHazardClassificationIssues('正文无标注。', depthModel('5.5m'));
    expect(issues[0].message).toContain('5.5m');
    expect(issues[0].suggestion).toContain('5.5m');
    expect(issues[1].message).toContain('5.5m');
    expect(issues[1].suggestion).toContain('专家论证');
  });
});

// ── EE4. foundationFormResidueIssues 增量 ──

describe('EE4 桩基残留：六桩词谱系与块豁免', () => {
  const pileWords = ['桩基', '灌注桩', '钻孔桩', '打桩', '成桩', '桩机'];
  it.each(pileWords)('EE4 桩词“%s”两行 → 报 2 处', (word) => {
    const md = `### 地基与基础\n筏板基础施工。\n## 进度计划\n${word}施工。\n${word}检测。`;
    const issues = foundationFormResidueIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('2 处');
  });
  it('EE4 单行单词 → 1 处不报（<2 门槛）', () => {
    const md = '### 地基与基础\n筏板基础施工。\n## 进度计划\n桩基检测。';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it.each(pileWords)('EE4 地基块内单词“%s”豁免不报', (word) => {
    const md = `### 地基与基础\n${word}施工流程。\n## 进度计划\n桩基检测。\n钻孔桩验收。`;
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it('EE4 标题带小节号「### 3.1 地基与基础」匹配块', () => {
    const md = '### 3.1 地基与基础\n筏板基础施工。\n## 进度计划\n桩基检测。\n桩基验收。';
    expect(foundationFormResidueIssues(md)).toHaveLength(1);
  });
  it('EE4 标题「### 地基基础」缺「与」不匹配 → 无块早退不报', () => {
    const md = '### 地基基础\n筏板基础施工。\n## 进度计划\n桩基检测。\n桩基验收。';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it('EE4 块止于下一个 H3 标题（块内无桩词）→ 后文 2 处报', () => {
    const md = '### 地基与基础\n筏板基础施工。\n### 施工部署\n桩基检测。\n桩基验收。';
    const issues = foundationFormResidueIssues(md);
    expect(issues).toHaveLength(1);
  });
  it('EE4 空标题后块（块为空）→ 无豁免 → 2 处报', () => {
    const md = '### 地基与基础\n\n## 进度计划\n桩基检测。\n桩基验收。';
    expect(foundationFormResidueIssues(md)).toHaveLength(1);
  });
  it('EE4 issue 字段与 suggestion 形态', () => {
    const md = '### 地基与基础\n筏板基础施工。\n## 进度计划\n桩基检测。\n桩机验收。';
    const issues = foundationFormResidueIssues(md);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].category).toBe('fact_consistency');
    expect(issues[0].suggestion).toContain('垫层');
  });
});

// ── EE5. fixForbiddenConfigurationTerms 增量 ──

describe('EE5 禁止词清洗：逗号形态与计数', () => {
  it('EE5 无逗号前缀不命中（规则锚定「，将报」）', () => {
    const md = '发现违法行为的将报公共资源交易监督管理部门处理。';
    expect(fixForbiddenConfigurationTerms(md).markdown).toBe(md);
    expect(fixForbiddenConfigurationTerms(md).fixedCount).toBe(0);
  });
  it('EE5 半角逗号不命中（规则仅全角逗号）', () => {
    const md = '发现违法行为的,将报公共资源交易监督管理部门处理。';
    expect(fixForbiddenConfigurationTerms(md).markdown).toBe(md);
    expect(fixForbiddenConfigurationTerms(md).fixedCount).toBe(0);
  });
  it('EE5 两处计数与 details', () => {
    const md = '，将报公共资源交易监督管理部门处理。，将报公共资源交易监督管理部门处理。';
    const result = fixForbiddenConfigurationTerms(md);
    expect(result.fixedCount).toBe(2);
    expect(result.details[0]).toContain('公共资源交易监督管理 2 处');
    expect(result.markdown).not.toContain('公共资源交易监督管理');
  });
  it('EE5 中间插入词变体不命中', () => {
    const md = '，将报有关公共资源交易监督管理部门处理。';
    expect(fixForbiddenConfigurationTerms(md).markdown).toBe(md);
  });
  it('EE5 替换后幂等', () => {
    const first = fixForbiddenConfigurationTerms('，将报公共资源交易监督管理部门处理。');
    const second = fixForbiddenConfigurationTerms(first.markdown);
    expect(second.fixedCount).toBe(0);
    expect(second.details).toEqual([]);
  });
  it('EE5 与内部术语清洗同文组合互不干扰', () => {
    const md = '，将报公共资源交易监督管理部门处理。统一控制口径。';
    const cleaned = fixInternalTerminology(fixForbiddenConfigurationTerms(md).markdown);
    expect(cleaned.markdown).toBe('，由招标人按招标文件规定程序处理。统一控制基准。');
    expect(cleaned.fixedCount).toBe(1);
  });
});

// ── EE6. 四器清洗链组合 ──

describe('EE6 四器清洗链：顺序应用与幂等', () => {
  const CHAIN = (md: string) => {
    const steps = [fixAdjacentPhraseDuplication, fixInternalTerminology, fixForbiddenConfigurationTerms, fixAmbiguousEitherOrCandidates];
    let markdown = md;
    let totalFixed = 0;
    const details: string[] = [];
    for (const step of steps) {
      const result = step(markdown);
      markdown = result.markdown;
      totalFixed += result.fixedCount;
      details.push(...result.details);
    }
    return { markdown, totalFixed, details };
  };
  it('EE6 四器同文命中各自生效', () => {
    const md = '施工进度施工进度。统一控制口径。，将报公共资源交易监督管理部门处理。基坑采用钢板桩或型钢支撑支护。';
    const result = CHAIN(md);
    expect(result.markdown).toBe('施工进度。统一控制基准。，由招标人按招标文件规定程序处理。基坑采用钢板桩支护。');
    expect(result.totalFixed).toBe(4);
  });
  it('EE6 链应用后幂等（二次链零命中）', () => {
    const md = '施工进度施工进度。统一控制口径。，将报公共资源交易监督管理部门处理。基坑采用钢板桩或型钢支撑支护。';
    const first = CHAIN(md);
    const second = CHAIN(first.markdown);
    expect(second.totalFixed).toBe(0);
    expect(second.markdown).toBe(first.markdown);
  });
  it('EE6 仅一器命中其余零改动', () => {
    const result = CHAIN('正常文本，统一控制口径。');
    expect(result.markdown).toBe('正常文本，统一控制基准。');
    expect(result.totalFixed).toBe(1);
  });
  it('EE6 粘连折叠与两可归一顺序互作', () => {
    const md = '钢板桩或型钢支撑支护钢板桩或型钢支撑支护。';
    // 粘连折叠先执行（模式1 相邻块），两可归一再执行
    const result = CHAIN(md);
    expect(result.markdown).toBe('钢板桩支护。');
    expect(result.totalFixed).toBe(2);
  });
});
