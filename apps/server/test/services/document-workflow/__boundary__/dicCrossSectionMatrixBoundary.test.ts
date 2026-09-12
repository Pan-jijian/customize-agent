/**
 * dicCrossSectionMatrixBoundary：跨节数值锚点检测器 crossSectionNumericConflictIssues 全锚点深挖矩阵（R 组）。
 * 覆盖增量维度（与 dicNumericBoundary C1-C3 基线互补）：
 *  - R1/R2 全 19 锚点谱系（含反向模式、同物异名、表格行、长窗口形态）单口径/两口径；
 *  - R3 number 类 20% 阈值精确边界（maxValue*0.2）；
 *  - R4 code 类无阈值直接互斥（C标号/A标号/项目编号）；
 *  - R5 四豁免谱系：并列枚举 / 工序切换 / 不少于下限 / 否定声明句；
 *  - R6 部位分组：跨部位隔离 / 同部位互斥 / 无标注归组 / 多部位总量 / 每台X配备 / 表格行部位列 / 阶段词不入部位；
 *  - R7 反向模式与枚举标点排除（历史缺陷 h15/h16 回归）；
 *  - R8 同物异名同池互查；R9 多值/多锚点/截断。
 * 全部为确定性正则提取与数值比较判定，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import { crossSectionNumericConflictIssues } from '@/services/document-workflow/documentIntegrityChecks';

// ── R1. 锚点全谱系单口径不报 ──

describe('R1 crossSection 全锚点单口径不报', () => {
  const singles: Array<[string, string]> = [
    ['xps 正向', '挤塑聚苯板厚度30mm。'],
    ['xps 反向', '130mm厚挤塑聚苯板。'],
    ['垫层 C15', '垫层采用C15混凝土。'],
    ['变压器 正向', '变压器315kVA。'],
    ['变压器 反向', '800kVA变压器。'],
    ['模板周转', '模板周转次数8次。'],
    ['砌块 A5.0', '蒸压加气混凝土砌块A5.0。'],
    ['灭火器', '灭火器20具。'],
    ['潜水泵', '潜水泵4台。'],
    ['提升泵（同物异名）', '提升泵4台。'],
    ['急救箱', '急救箱3个。'],
    ['计划工期 正向', '计划工期210日历天。'],
    ['计划工期 反向', '210日历天总工期。'],
    ['装配率', '装配率38.4%。'],
    ['装配率 长窗口计算为', '装配率按安徽省《装配式建筑评价技术标准》DB34/T 3830-2025计算为38.4%。'],
    ['项目编号', '项目编号2026ANNGZ50062。'],
    ['塔式起重机 型号中间', '塔式起重机TC6015共2台。'],
    ['施工电梯', '施工电梯2台。'],
    ['汽车吊', '汽车吊2台。'],
    ['钢筋切断机', '钢筋切断机4台。'],
    ['钢筋弯曲机', '钢筋弯曲机3台。'],
    ['机动工期', '机动工期15天。'],
    ['自然村 美丽宜居前缀', '9个美丽宜居自然村。'],
    ['圆盘锯', '圆盘锯1台。'],
  ];
  it.each(singles)('R1 %s', (_label, md) => {
    expect(crossSectionNumericConflictIssues(md)).toEqual([]);
  });
});

// ── R2. 锚点全谱系两口径冲突报 ──

describe('R2 crossSection 全锚点两口径冲突报', () => {
  const conflicts: Array<[string, string]> = [
    ['XPS 30 vs 130', '挤塑聚苯板厚度30mm。XPS厚度130mm。'],
    ['垫层 C15 vs C20（code 直接互斥）', '垫层采用C15混凝土。垫层混凝土强度等级C20。'],
    ['变压器 315 vs 800', '变压器315kVA。变压器800kVA。'],
    ['模板周转 8 vs 6', '模板周转次数8次。模板周转使用6次。'],
    ['砌块 A5.0 vs A3.5（code）', '砌块A5.0。砌块A3.5。'],
    ['灭火器 20 vs 40', '灭火器20具。灭火器40具。'],
    ['潜水泵 4 vs 8', '潜水泵4台。潜水泵8台。'],
    ['急救箱 3套 vs 4个', '急救箱3套。急救箱4个。'],
    ['总工期 45 vs 210', '计划工期45日历天。总工期210日历天。'],
    ['装配率 30 vs 38.4', '装配率30%。装配率38.4%。'],
    ['项目编号 两套（code）', '项目编号2026ANNGZ50062。招标项目编号2026ANNGZ50112。'],
    ['塔吊 1 vs 2', '塔式起重机1台。塔吊2台。'],
    ['升降机 4 vs 电梯 1（同物异名）', '施工升降机4台。施工电梯1台。'],
    ['汽车起重机 2 vs 汽车吊 1（同物异名）', '汽车起重机2台。汽车吊1台。'],
    ['钢筋切断机 1 vs 4', '钢筋切断机1台。钢筋切断机4台。'],
    ['钢筋弯曲机 1 vs 3', '钢筋弯曲机1台。钢筋弯曲机3台。'],
    ['机动工期 15 vs 缓冲 20', '机动工期15天。缓冲20天。'],
    ['自然村 9 vs 12', '9个自然村。12个自然村。'],
    ['圆盘锯 1 vs 6', '圆盘锯1台。圆盘锯6台。'],
  ];
  it.each(conflicts)('R2 %s', (_label, md) => {
    const issues = crossSectionNumericConflictIssues(md);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe('blocker');
  });
});

// ── R3. number 类不同数值即互斥（无差异阈值，十五版机械四套数字 5 vs 4 形态） ──

describe('R3 crossSection number 类无差异阈值（不同数值即互斥）', () => {
  it('R3-1 差恰 20%（20 vs 24）→ 报', () => {
    expect(crossSectionNumericConflictIssues('灭火器20具。灭火器24具。').length).toBe(1);
  });
  it('R3-2 差 24%（20 vs 26）→ 报', () => {
    expect(crossSectionNumericConflictIssues('灭火器20具。灭火器26具。').length).toBe(1);
  });
  it('R3-3 差恰 20%（100 vs 125）→ 报', () => {
    expect(crossSectionNumericConflictIssues('变压器100kVA。变压器125kVA。').length).toBe(1);
  });
  it('R3-4 差 26%（100 vs 126）→ 报', () => {
    expect(crossSectionNumericConflictIssues('变压器100kVA。变压器126kVA。').length).toBe(1);
  });
  it('R3-5 小数装配率差 20% 内 → 报', () => {
    expect(crossSectionNumericConflictIssues('装配率30%。装配率36%。').length).toBe(1);
  });
  it('R3-6 小数装配率差 20% 外（30 vs 38）→ 报', () => {
    expect(crossSectionNumericConflictIssues('装配率30%。装配率38%。').length).toBe(1);
  });
});

// ── R4. code 类无阈值直接互斥 ──

describe('R4 crossSection code 类直接互斥（无 20% 阈值门）', () => {
  it('R4-1 垫层 C15 vs C20（差异远超 20%）→ 报', () => {
    expect(crossSectionNumericConflictIssues('垫层采用C15混凝土。垫层采用C20混凝土。').length).toBe(1);
  });
  it('R4-2 砌块 A5.0 vs A5.1（微小差异也互斥）→ 报', () => {
    expect(crossSectionNumericConflictIssues('砌块A5.0。砌块A5.1。').length).toBe(1);
  });
  it('R4-3 项目编号邻号互斥 → 报', () => {
    expect(crossSectionNumericConflictIssues('项目编号2026ANNGZ50062。项目编号2026ANNGZ50063。').length).toBe(1);
  });
});

// ── R5. 四豁免谱系 ──

describe('R5 crossSection 豁免谱系', () => {
  it('R5-1 并列枚举豁免（50mm/70mm）→ 不报', () => {
    expect(crossSectionNumericConflictIssues('挤塑聚苯板厚度50mm/70mm。')).toEqual([]);
  });
  it('R5-2 并列枚举全角斜杠豁免 → 不报', () => {
    expect(crossSectionNumericConflictIssues('挤塑聚苯板厚度50mm／70mm。')).toEqual([]);
  });
  it('R5-3 工序切换豁免（垫层，浇筑完成后再浇筑 C30 属上层构件）→ 不报', () => {
    expect(crossSectionNumericConflictIssues('垫层采用C15混凝土。垫层浇筑完成后再浇筑C30混凝土。')).toEqual([]);
  });
  it('R5-4 不少于下限豁免（40具 与 不少于20具 不互斥）→ 不报', () => {
    expect(crossSectionNumericConflictIssues('干粉灭火器按不少于20具配置。灭火器40具。')).toEqual([]);
  });
  it('R5-5 否定声明句豁免（不再出现引用旧值）→ 不报', () => {
    const md = '现场统一配置汽车吊1台。本章及后续章节不再出现"汽车吊2台"等与施工部署不一致的数量表述。';
    expect(crossSectionNumericConflictIssues(md)).toEqual([]);
  });
});

// ── R6. 部位分组 ──

describe('R6 crossSection 部位分组隔离与归组', () => {
  it('R6-1 不同部位不同规格不互斥 → 不报', () => {
    expect(crossSectionNumericConflictIssues('屋面XPS厚度50mm。墙面XPS厚度130mm。')).toEqual([]);
  });
  it('R6-2 同部位两规格互斥 → 报', () => {
    expect(crossSectionNumericConflictIssues('屋面XPS厚度50mm。屋面XPS厚度130mm。').length).toBe(1);
  });
  it('R6-3 无标注值归入唯一部位组 → 报（30 未标注 vs 屋面 130）', () => {
    expect(crossSectionNumericConflictIssues('XPS厚度30mm。屋面采用130mm厚XPS。').length).toBe(1);
  });
  it('R6-4 多部位组并存时未标注值是总量口径 → 不报', () => {
    expect(crossSectionNumericConflictIssues('灭火器40具。办公区灭火器4具。库房灭火器2具。')).toEqual([]);
  });
  it('R6-5 每台X配备部位组隔离 → 不报', () => {
    expect(crossSectionNumericConflictIssues('每台燃油机械配备干粉灭火器1具。办公区灭火器4具。')).toEqual([]);
  });
  it('R6-6 每台X同部位两值互斥 → 报', () => {
    expect(crossSectionNumericConflictIssues('每台燃油机械配备干粉灭火器1具。每台燃油机械配备干粉灭火器4具。').length).toBe(1);
  });
  it('R6-7 表格行部位列归组同部位互斥 → 报', () => {
    const md = '| 灭火器 | 干粉4kg | 12具 | 材料库 |\n| 灭火器 | 干粉4kg | 40具 | 材料库 |';
    expect(crossSectionNumericConflictIssues(md).length).toBe(1);
  });
  it('R6-8 阶段词不入部位组（主体结构阶段不隔离）→ 报', () => {
    expect(crossSectionNumericConflictIssues('主体结构阶段配置施工电梯2台。施工电梯1台。').length).toBe(1);
  });
});

// ── R7. 反向模式与枚举标点排除（历史缺陷回归） ──

describe('R7 crossSection 反向模式谱系', () => {
  it('R7-1 反向 vs 反向（130mm厚 vs 30mm厚）→ 报', () => {
    expect(crossSectionNumericConflictIssues('130mm厚挤塑聚苯板。30mm厚XPS。').length).toBe(1);
  });
  it('R7-2 变压器反向 vs 反向 → 报', () => {
    expect(crossSectionNumericConflictIssues('800kVA变压器。315kVA变压器。').length).toBe(1);
  });
  it('R7-3 塔吊反向（2台TC6015）vs 正向（1台）→ 报', () => {
    expect(crossSectionNumericConflictIssues('2台TC6015塔式起重机。1台塔式起重机。').length).toBe(1);
  });
  it('R7-4 反向模式枚举标点排除（2台、汽车吊 不误采）→ 不报', () => {
    expect(crossSectionNumericConflictIssues('施工电梯2台、汽车吊1台。')).toEqual([]);
  });
  it('R7-5 正向模式枚举标点排除（塔吊范围内配置钢筋切断机 不误采）→ 不报', () => {
    expect(crossSectionNumericConflictIssues('塔吊覆盖范围内，配置钢筋切断机GQ40共4台。')).toEqual([]);
  });
});

// ── R8. 同物异名同池互查 ──

describe('R8 crossSection 同物异名同池', () => {
  it('R8-1 潜水泵 vs 提升泵两口径 → 报', () => {
    expect(crossSectionNumericConflictIssues('潜水泵4台。提升泵8台。').length).toBe(1);
  });
  it('R8-2 潜水泵 vs 提升泵同值 → 不报', () => {
    expect(crossSectionNumericConflictIssues('潜水泵4台。提升泵4台。')).toEqual([]);
  });
  it('R8-3 施工升降机 vs 施工电梯两口径 → 报', () => {
    expect(crossSectionNumericConflictIssues('施工升降机4台。施工电梯1台。').length).toBe(1);
  });
  it('R8-4 汽车起重机 vs 汽车吊两口径 → 报', () => {
    expect(crossSectionNumericConflictIssues('汽车起重机2台。汽车吊1台。').length).toBe(1);
  });
});

// ── R9. 多值/多锚点/截断 ──

describe('R9 crossSection 多值与截断', () => {
  it('R9-1 同组三值 → 单条报', () => {
    const issues = crossSectionNumericConflictIssues('灭火器20具。灭火器40具。灭火器60具。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('60具');
  });
  it('R9-2 九锚点冲突 → 全量报出（上限 16 防截断）', () => {
    const md = 'XPS厚度30mm。XPS厚度130mm。变压器315kVA。变压器800kVA。模板周转次数8次。模板周转使用6次。'
      + '灭火器20具。灭火器40具。潜水泵4台。潜水泵8台。急救箱3个。急救箱4个。'
      + '塔式起重机1台。塔吊2台。施工升降机4台。施工电梯1台。汽车起重机2台。汽车吊1台。';
    expect(crossSectionNumericConflictIssues(md).length).toBe(9);
  });
  it('R9-3 多锚点各自报（2 条）', () => {
    const issues = crossSectionNumericConflictIssues('XPS厚度30mm。XPS厚度130mm。灭火器20具。灭火器40具。');
    expect(issues.length).toBe(2);
  });
  it('R9-4 部位隔离与同部位互斥混合 → 仅同部位报', () => {
    const issues = crossSectionNumericConflictIssues('屋面XPS厚度50mm。屋面XPS厚度130mm。墙面XPS厚度20mm。');
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('屋面');
  });
});
