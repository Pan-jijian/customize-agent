/**
 * 边界矩阵（P1 第 30 批 · GG 组）
 * 覆盖：coverage 报告提取的 documentIntegrityChecks.ts 半覆盖分支行精准选题——
 * 每条用例锚定一个此前只走过单侧的分支，把真/假侧都跑实：
 *  L1748/1749/1750（cnNumberToArabic 十形态真分支）、L1818（养护红线单行文档 lineEnd 兜底）、
 *  L1985-1994（无部位标注值并入唯一部位组）、L2170-2171（计划工期字段空值/正常值）、
 *  L2219-2230（两可形态 B/C 多命中循环）、L2390（支护外来词单行文档 lineEnd 兜底）、
 *  L2591（无分隔行嵌入表头表切分）、L2836（tenderRequirements extracted=false）、
 *  L2941（人材机 h4 层级错位三元组合）、L3129（firstCellOf 空单元格兜底）、
 *  L3134-3136（lastDayOf 相对量豁免取末值）、L3156（同键两行取大）、
 *  L3228（体系缩放 +1 计数）、L3238（众数平局取大）、L3287（众数冲突阈值 false 侧）、
 *  L3430（段落窗 paraStart 非 -1）、L3448-3449（best 更近候选更新）、
 *  L3499（工期权威 0 值兜底）、L3512（canonical 无日历天续扫）、L3640（数字短语结构符号跳过）、
 *  L3670（跨单位粘连折叠）、L3726（质量补全 block.index 非 0）、L4186（目录十X章序）。
 * 原则：每条用例独立断言意义；真实实现行为一律锁定，不迎合用例改实现。
 */
import { describe, expect, it } from 'vitest';
import {
  ambiguousEitherOrIssues,
  applyNumericConsistencyDeterministicFixes,
  basicInfoScheduleFieldIssues,
  crossSectionNumericConflictIssues,
  duplicateTableIssues,
  extractGreeningMaintenanceAuthority,
  extractScheduleAuthority,
  fabricatedAwardIssues,
  fixAdjacentPhraseDuplication,
  fixQuantityAuthorityConflicts,
  fixQualityAssuranceCoverage,
  fixTocFromBody,
  greeningMaintenanceMismatchIssues,
  resourceTriadSectionHierarchyIssues,
  supportFormFactConsistencyIssues,
} from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

// ── GG1. cnNumberToArabic：十形态真分支（L1748/L1749/L1750） ──

describe('GG1 养护期中文数字：十形态谱系', () => {
  const billsOf = (years: string) => factsOf({ bills: [factOf({ key: '喷播植草籽', value: `养护期${years}年` })] });
  it('GG1 「十八」十X 形态（L1749 真分支）→ 18', () => {
    expect(extractGreeningMaintenanceAuthority(billsOf('十八'))).toBe(18);
  });
  it('GG1 「二十」X十 形态（L1750 真分支）→ 20', () => {
    expect(extractGreeningMaintenanceAuthority(billsOf('二十'))).toBe(20);
  });
  it('GG1 「十」单字（L1748）→ 10', () => {
    expect(extractGreeningMaintenanceAuthority(billsOf('十'))).toBe(10);
  });
  it('GG1 「二十一」三字形态 → 解析 21 超 20 上限 → 不采', () => {
    expect(extractGreeningMaintenanceAuthority(billsOf('二十一'))).toBeUndefined();
  });
});

// ── GG2. crossSectionNumericConflictIssues：无部位标注值并入唯一部位组（L1985-1994） ──

describe('GG2 无部位标注口径合并', () => {
  it('GG2 唯一部位组（屋面）→ 未标注 30mm 并入 → 30 vs 130 互斥报 1 条', () => {
    const issues = crossSectionNumericConflictIssues('挤塑聚苯板30mm。屋面采用130mm挤塑聚苯板。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('挤塑聚苯板');
  });
  it('GG2 多部位组并存 → 未标注总量口径不并入 → 0 条', () => {
    expect(crossSectionNumericConflictIssues('灭火器40具。办公区灭火器4具。库房灭火器2具。')).toHaveLength(0);
  });
});

// ── GG3. basicInfoScheduleFieldIssues：空值与正常值（L2170-2171） ──

describe('GG3 计划工期字段：值形态分支', () => {
  it('GG3 「| 计划工期 | |」空值 → 不报', () => {
    expect(basicInfoScheduleFieldIssues('| 计划工期 | |')).toHaveLength(0);
  });
  it('GG3 「| 计划工期 | 210日历天 |」无违约词 → 不报', () => {
    expect(basicInfoScheduleFieldIssues('| 计划工期 | 210日历天 |')).toHaveLength(0);
  });
});

// ── GG4. ambiguousEitherOrIssues：形态 B/C 多命中循环（L2219-2220/L2229-2230） ──

describe('GG4 两可表述：同句多命中聚合', () => {
  it('GG4 形态 B 两处悬置括号 → 一条 issue 聚合两处', () => {
    const issues = ambiguousEitherOrIssues('基础形式（或按图纸实施）。桩基（或按实确定）。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('（或按图纸实施）');
    expect(issues[0].message).toContain('（或按实确定）');
  });
  it('GG4 形态 C 两处直陈两可 → 一条 issue 聚合两处', () => {
    const issues = ambiguousEitherOrIssues('采用支护桩或排桩，另采用放坡或喷锚。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('支护桩或排桩');
    expect(issues[0].message).toContain('放坡或喷锚');
  });
});

// ── GG5. lastDayOf：相对量豁免后取末值（L3134-3136，经 fixNodeScheduleConflicts） ──

describe('GG5 节点权威表：多第N日取最后非相对量', () => {
  it('GG5 权威行「主体封顶后第30日，第100日」→ 相对量 30 豁免、权威取 100 → 非权威表 80 对齐', () => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 主体结构封顶 | 主体封顶后第30日，第100日 |',
      // 非权威表块前 6 行窗口不得含「总进度计划」标题
      '', '', '', '', '', '', '',
      '## 其他表',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 主体结构封顶 | 第80日 |',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).not.toContain('第80日');
  });
});

// ── GG6. firstCellOf：空单元格行兜底（L3129） ──

describe('GG6 权威表块：空单元格行跳过', () => {
  it('GG6 「| |」行 firstCellOf 空 → 无键无权威不崩溃 → 其余对齐照常 1 处', () => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| |',
      '| 主体结构封顶 | 第100日 |',
      '| 竣工验收 | 第120日 |',
      '', '', '', '', '', '', '',
      '## 其他表',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 主体结构封顶 | 第80日 |',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).not.toContain('第80日');
  });
});

// ── GG7. 同键两行取大（L3156） ──

describe('GG7 节点权威：同键多行取大', () => {
  it('GG7 「竣工清理与预验收」+「竣工验收」同属 completion → 权威取大 120 → 非权威表 90 对齐', () => {
    const markdown = [
      '## 总进度计划',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 竣工清理与预验收 | 第80日 |',
      '| 竣工验收 | 第120日 |',
      '', '', '', '', '', '', '',
      '## 其他表',
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 竣工验收 | 第90日 |',
    ].join('\n');
    const result = applyNumericConsistencyDeterministicFixes(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).not.toContain('第90日');
    expect((result.markdown.match(/第120日/g) || []).length).toBe(2);
  });
});

// ── GG8. extractMarkdownTables：无分隔行嵌入表头切分（L2591，经 duplicateTableIssues） ──

describe('GG8 嵌入表头：无分隔行重复表头切分为两张表', () => {
  it('GG8 数据区中重复表头行（无分隔行）→ 表切为两张 → 判重复 1 条', () => {
    const markdown = [
      '| 节点 | 完成日 |',
      '| --- | --- |',
      '| 开工 | 第1日 |',
      '| 封顶 | 第100日 |',
      '| 节点 | 完成日 |',
      '| 开工 | 第1日 |',
      '| 封顶 | 第100日 |',
    ].join('\n');
    const issues = duplicateTableIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('表格重复');
  });
});

// ── GG9. modeOfValues：平局取大（L3238，经 fixCrossSectionNumericConflicts 众数兜底） ──

describe('GG9 众数权威：平局取大', () => {
  it('GG9 两表格行 4具/20具 各一次 → 平局取大 20 → 4 替换为 20', () => {
    const result = applyNumericConsistencyDeterministicFixes('| 区域 | 灭火器 | 4具 |\n| 区域 | 灭火器 | 20具 |');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).not.toContain('4具');
    expect((result.markdown.match(/20具/g) || []).length).toBe(2);
  });
});

// ── GG10. fixNodeScheduleConflicts：体系缩放 +1 计数（L3228） ──

describe('GG10 体系缩放：无后续替换时计数 +1', () => {
  it('GG10 缩放 100→540（无权威表无对齐）→ fixedCount 为 1（缩放计数）', () => {
    const result = applyNumericConsistencyDeterministicFixes('开工令下发后第100日完成主体结构封顶。', { scheduleAuthority: 540 });
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('开工令下发后第540日完成主体结构封顶。');
  });
});

// ── GG11. fixQuantityAuthorityConflicts：多段落窗（L3430 paraStart 非 -1） ──

describe('GG11 清单量定点校正：跨段落段落窗', () => {
  it('GG11 名称前有段落分隔 → paraFrom 取段首 → 照常修复 50→100', () => {
    const result = fixQuantityAuthorityConflicts('主要工程量：\n\nC.1项铺装 50m。', [{ name: 'C.1项铺装', value: 100, unit: 'm' }]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('C.1项铺装 100m。');
  });
});

// ── GG12. fixQuantityAuthorityConflicts：窗口内更近候选替换 best（L3448-3449） ──

describe('GG12 清单量定点校正：双候选取更近', () => {
  it('GG12 窗口内 100m 与 85m → 85 更近权威 90 → best 更新为 85 → 替换 85→90', () => {
    const result = fixQuantityAuthorityConflicts('C.1项铺装 100m和85m。', [{ name: 'C.1项铺装', value: 90, unit: 'm' }]);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('C.1项铺装 100m和90m。');
  });
});

// ── GG13. extractScheduleAuthority：0 值兜底（L3499） ──

describe('GG13 工期权威提取：非正数值', () => {
  it('GG13 「计划工期0日历天」→ 0 不采 → undefined', () => {
    const facts = factsOf({ schedule: [factOf({ key: '计划工期', value: '计划工期0日历天' })] });
    expect(extractScheduleAuthority(facts)).toBeUndefined();
  });
  it('GG13 「计划工期210日历天」→ 210（活性锚定）', () => {
    const facts = factsOf({ schedule: [factOf({ key: '计划工期', value: '计划工期210日历天' })] });
    expect(extractScheduleAuthority(facts)).toBe(210);
  });
});

// ── GG14. extractScheduleAuthority：canonical 条目无日历天续扫（L3512） ──

describe('GG14 工期权威提取：canonical 无日历天值', () => {
  it('GG14 canonical 条目「按合同执行」无日历天 → undefined', () => {
    const facts = factsOf({
      canonical: {
        schedule: { s1: [{ label: '计划工期', value: '按合同执行' }] },
      },
    } as never);
    expect(extractScheduleAuthority(facts)).toBeUndefined();
  });
});

// ── GG15. fixAdjacentPhraseDuplication：数字短语含结构符号跳过（L3640） ──

describe('GG15 相邻重复折叠：数字短语结构符号', () => {
  it('GG15 「第311日-完成A第311日-完成」含「-」→ 模式2 全部跳过 → 0 处', () => {
    const result = fixAdjacentPhraseDuplication('第311日-完成A第311日-完成');
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toBe('第311日-完成A第311日-完成');
  });
});

// ── GG17. fixAdjacentPhraseDuplication：跨单位粘连折叠（L3670） ──

describe('GG17 数值单位粘连：跨单位折叠', () => {
  it('GG17 「71.2kW182.5kVA」前单位 kW 后单位 kVA → 保留首块删除粘连块', () => {
    const result = fixAdjacentPhraseDuplication('总功率71.2kW182.5kVA。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('总功率71.2kW。');
  });
});

// ── GG18. fixQualityAssuranceCoverage：6.1 块非文档开头（L3726 block.index 非 0） ──

describe('GG18 质量保障补全：块前有章节', () => {
  it('GG18 6.1 块前有第一章 → insertAt 在块尾（6.2 之前）→ 注入 1 处', () => {
    const markdown = '## 第一章 概述\n内容。\n\n### 6.1 施工部署与施工流水组织\n以安全文明为主线。\n\n### 6.2 进度计划\n内容。';
    const result = fixQualityAssuranceCoverage(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.indexOf('质量保障体系与安全文明管理同频运行')).toBeGreaterThan(-1);
    expect(result.markdown.indexOf('质量保障体系与安全文明管理同频运行')).toBeLessThan(result.markdown.indexOf('### 6.2'));
  });
});

// ── GG19. resourceTriadSectionHierarchyIssues：h4 层级错位（L2934-2943） ──

describe('GG19 人材机：h4 主语与 h3 父级错位', () => {
  it('GG19 机的小节挂在材的小节下 → 报层级错位（三元组合 机≠材）', () => {
    const md = [
      '## 人、材、机保障',
      '### 确保材的保障体系与措施',
      '内容。',
      '#### 机械设备保障',
      '内容。',
      '### 确保人的保障体系与措施',
      '### 确保机的保障体系与措施',
    ].join('\n');
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('层级错位');
  });
  it('GG19 人的小节挂在机的小节下 → 报层级错位（三元组合 人≠机）', () => {
    const md = [
      '## 人、材、机保障',
      '### 确保机的保障体系与措施',
      '内容。',
      '#### 劳动力组织',
      '内容。',
      '### 确保人的保障体系与措施',
      '### 确保材的保障体系与措施',
    ].join('\n');
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('层级错位');
  });
});

// ── GG20. fixTocFromBody：十X 章序（L4186） ──

describe('GG20 目录重建：十X 中文章序', () => {
  const cases = [
    { ordinal: '第十五章', section: '15.1' },
    { ordinal: '第十一章', section: '11.1' },
  ];
  it.each(cases)('GG20 「$ordinal」章序解析 → 目录重建含章行与小节缩进行', ({ ordinal, section }) => {
    const markdown = `## 目录\n\n旧目录行\n\n## ${ordinal} 环境保护\n\n### ${section} 扬尘控制\n\n内容`;
    const result = fixTocFromBody(markdown);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain(`## 目录\n\n${ordinal} 环境保护\n  ${section} 扬尘控制`);
  });
});

// ── GG22. supportFormFactConsistencyIssues：单行文档 lineEnd 兜底（L2390） ──

describe('GG22 支护形式一致性：单行文档', () => {
  it('GG22 无换行单行正文含外来词「冠梁」→ 行末兜底取 length → 报 1 条', () => {
    const facts = factsOf({
      canonical: {
        byKey: {
          foundation_support_form: {
            key: 'foundation_support_form', label: '基坑支护形式', value: '土钉墙', normalizedValue: '土钉墙',
            sourceType: 'tender', confidence: 1, priority: 1, locked: true,
          },
        },
      },
    } as never);
    const issues = supportFormFactConsistencyIssues('基坑支护采用土钉墙，冠梁顶标高按设计。', facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('冠梁');
  });
});

// ── GG23. greeningMaintenanceMismatchIssues：单行文档 lineEnd 兜底（L1818） ──

describe('GG23 养护期红线：单行文档', () => {
  it('GG23 无换行单行正文「养护期一年」vs 清单十年 → 行末兜底 → 报 1 条', () => {
    const facts = factsOf({ bills: [factOf({ key: '喷播植草籽', value: '养护期十年' })] });
    const issues = greeningMaintenanceMismatchIssues('绿化养护期一年，苗木成活率95%。', facts);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('绿化养护期清单红线');
  });
});

// ── GG25. fabricatedAwardIssues：extracted=false 跳过来源 2（L2836） ──

describe('GG25 奖项白名单：tenderRequirements 未提取', () => {
  it('GG25 extracted=false → 来源 2 不参与 → 白名单空 → 正文奖项不检不报', () => {
    const tenderRequirements = {
      extracted: false,
      awardObjectives: [{ text: '确保黄山杯', coreTerms: [] }],
      specialQualityStandards: [],
      awardClauses: [],
      systematicBenchmarks: [],
      dateFabricationProhibited: false,
      prohibitionNotes: [],
      frontScheduleClauses: [],
    };
    expect(fabricatedAwardIssues('本工程确保鲁班奖。', factsOf({}), tenderRequirements)).toHaveLength(0);
  });
});

// ── GG28. 众数冲突阈值 false 侧（L3287） ──

describe('GG28 众数权威：差异未超 20% 不启用', () => {
  it('GG28 两表格行 10具/11具 差异 ≤20% → 无冲突无权威 → 不动', () => {
    const result = applyNumericConsistencyDeterministicFixes('| 区域 | 灭火器 | 10具 |\n| 区域 | 灭火器 | 11具 |');
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('10具');
    expect(result.markdown).toContain('11具');
  });
});
