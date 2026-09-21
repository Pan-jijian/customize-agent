/**
 * 阶段 D 冻结前四道校验（Schema/事实锚定/覆盖/内部一致性 + per-check 权威可用性映射）
 *
 * S6 零行为拆分自 integratedBlueprint.ts（门面 re-export，对外导出不变）：仅机械搬迁，未改动任何语句与常量。
 */
import { bridgeTunnelStrategy, buildingStrategy, generalStrategy, highwayStrategy, villageMunicipalStrategy, waterConservancyStrategy, type BlueprintDerivationStrategy } from '../blueprintDerivationStrategies';
import type { ChapterIntentClassifier } from '../chapterIntentClassifier';
import { validateJsonAgainstSchema } from '../llmClient';
import type { BillOfQuantitiesResult } from '../billOfQuantitiesParser';
import { deriveQuantitiesFromBoq } from './parse';
import { BLUEPRINT_JSON_SCHEMA } from './types';
import type { BlueprintAuthorityId, BlueprintData, BlueprintValidationReport, IntegratedBlueprint } from './types';

// ═══════════════════════════════ 阶段 D：蓝图校验（冻结前四道） ═══════════════════════════════

/** 策略组登记表（id → 策略）：蓝图记录 strategyId，校验按此精确取用（不合并策略组做宽查找） */
const STRATEGIES_BY_ID: Record<BlueprintDerivationStrategy['id'], BlueprintDerivationStrategy> = {
  'village-municipal': villageMunicipalStrategy,
  'building': buildingStrategy,
  'general': generalStrategy,
  'bridge-tunnel': bridgeTunnelStrategy,
  'highway': highwayStrategy,
  'water-conservancy': waterConservancyStrategy,
};

/** 校验 1：Schema 校验（结构/类型/必填/边界，轻量 schema 与 draft-07 语义对齐） */
function validateBlueprintSchema(blueprint: IntegratedBlueprint): string[] {
  return validateJsonAgainstSchema(blueprint, BLUEPRINT_JSON_SCHEMA);
}

/** 校验 2：事实锚定校验（L1a 值 ∈ 清单聚合值集；红线事实逐条有源；金额禁区） */
function validateBlueprintFacts(blueprint: IntegratedBlueprint, boq?: BillOfQuantitiesResult): string[] {
  const errors: string[] = [];
  if (boq) {
    const expected = deriveQuantitiesFromBoq(boq);
    for (const [name, quantity] of Object.entries(blueprint.data.quantities)) {
      const source = expected[name];
      if (!source) {
        errors.push(`quantities.${name} 不在清单解析产物值集中（疑似编造）`);
        continue;
      }
      if (source.value !== quantity.value) {
        errors.push(`quantities.${name} 数值 ${quantity.value} 与清单聚合值 ${source.value} 不一致`);
      }
    }
  }
  for (const fact of blueprint.data.redLineFacts) {
    if (!fact.value || !fact.source) errors.push(`红线事实「${fact.key}」缺值或缺来源`);
  }
  // 设备单位一致性（丰乐镇第 3 轮）：basis 工程量必须与清单同单位同特征聚合一致（「124 套」混单位虚数拦截）；
  // 映射表按蓝图记录的推导策略 id 精确取用（不合并策略组：同名设备各策略组 pattern 不同，宽查找会掩盖错配）
  if (boq) {
    const strategy = STRATEGIES_BY_ID[blueprint.data.strategyId];
    if (!strategy) {
      errors.push(`蓝图推导策略 id「${blueprint.data.strategyId}」不在策略组登记表（设备单位一致性校验无法执行）`);
    } else {
      for (const item of blueprint.data.resources?.equipment || []) {
        const mapping = strategy.equipmentMapping.find(candidate => candidate.name === item.name);
        if (!mapping) continue;
        const hits = boq.entries.filter(entry => mapping.pattern.test(`${entry.name} ${entry.description}`) && entry.unit === mapping.unit);
        const totalQty = hits.reduce((sum, entry) => sum + entry.quantity, 0);
        const basisQtyMatch = /合计约\s*([\d.]+)/u.exec(item.basis);
        if (basisQtyMatch && Number(basisQtyMatch[1]) !== Math.round(totalQty)) {
          errors.push(`机械「${item.name}」basis 工程量 ${basisQtyMatch[1]} 与清单同单位聚合 ${Math.round(totalQty)} 不一致`);
        }
      }
    }
  }
  return errors;
}

/** 校验 3：覆盖校验（清单条目零丢失 + 重难点逐项列明） */
function validateBlueprintCoverage(blueprint: IntegratedBlueprint, boq?: BillOfQuantitiesResult): string[] {
  const errors: string[] = [];
  const allPackages = blueprint.outline.chapters.flatMap(chapter => chapter.subSections).flatMap(section => section.workPackages);
  if (boq) {
    // 清单条目零丢失：每条目的 seq 必须被某工作包 coveredSeqs 覆盖（按 seq 全集判定，
    // 不按 workPackage.name 与分部名匹配——小节名规范化（「其他」→「环境整治工程」）后名字会变）。
    // 无分部分节结构的条目（section 空）豁免：无施工方法小节可归属，构建层已跳过（不合成占位小节）
    const coveredSeqs = new Set<number>();
    for (const workPackage of allPackages) {
      for (const seq of workPackage.coveredSeqs) coveredSeqs.add(seq);
    }
    const missing = boq.entries.filter(entry => entry.section && !coveredSeqs.has(entry.seq));
    if (missing.length > 0) {
      errors.push(`清单条目零丢失校验失败：${missing.length} 条未被工作包覆盖（如序号 ${missing.slice(0, 5).map(entry => entry.seq).join('、')}）`);
    }
  }
  if (blueprint.data.keyDifficulties.length === 0) errors.push('重难点及保证措施未逐项列明');
  return errors;
}

/** 校验 4：内部一致性校验（里程碑总和 ≤ 总工期；劳动力/机械区间自洽；六百分百恰为六条） */
function validateBlueprintConsistency(blueprint: IntegratedBlueprint): string[] {
  const errors: string[] = [];
  const totalDays = blueprint.data.contract?.totalDays || 0;
  const milestoneSum = (blueprint.data.milestones || []).reduce((sum, item) => sum + (item.duration || 0), 0);
  if (totalDays > 0 && milestoneSum > totalDays) {
    errors.push(`里程碑总和 ${milestoneSum} 天超过总工期 ${totalDays} 天`);
  }
  const { labor } = blueprint.data.resources || {};
  if (labor) {
    if (labor.peak && labor.peak.min > labor.peak.max) errors.push(`劳动力峰值区间异常（min ${labor.peak.min} > max ${labor.peak.max}）`);
    if (labor.peakValue > 0 && labor.peak && (labor.peakValue < labor.peak.min || labor.peakValue > labor.peak.max)) {
      errors.push(`劳动力峰值唯一口径 ${labor.peakValue} 人超出推导区间 ${labor.peak.min}~${labor.peak.max} 人`);
    }
    for (const item of labor.byTrade || []) {
      if ((item.min || 0) > (item.max || 0)) errors.push(`工种「${item.trade}」人数区间异常`);
    }
  }
  // P3.6 决策锁数据条目完备性硬检查（空壳锁根治）：提取源已有值但锁条目缺失时校验失败——
  // 空壳锁 passed=true 进写作链时参数桶无权威数值、模型自由发挥产生数值矛盾（历史主根因）
  const lockIds = new Set((blueprint.data.decisionLock?.entries ?? []).map(entry => entry.id));
  if (blueprint.data.contract?.totalDays > 0 && !lockIds.has('contract_days')) {
    errors.push(`决策锁缺失数据条目 contract_days（总工期 ${blueprint.data.contract.totalDays} 日历天未入锁）`);
  }
  if (labor && labor.peakValue > 0 && !lockIds.has('labor_peak')) {
    errors.push(`决策锁缺失数据条目 labor_peak（劳动力峰值 ${labor.peakValue} 人未入锁）`);
  }
  if (blueprint.data.redLineFacts?.some(fact => fact.key === '自然村数量') && !lockIds.has('village_count')) {
    errors.push('决策锁缺失数据条目 village_count（自然村数量红线事实未入锁）');
  }
  for (const item of blueprint.data.resources?.equipment || []) {
    if ((item.min || 0) > (item.max || 0)) errors.push(`机械「${item.name}」台数区间异常`);
  }
  return errors;
}

/** P14 per-check 权威可用性计算（纯函数，validateBlueprint 消费 + 单测直接锁定）：
 * - Schema/事实锚定失败 → 数值无源，全部权威不可用；
 * - 覆盖校验失败 → 清单条目缺失，仅蓝图整体可用性受损（不损伤已锚定数值本身）；
 * - 内部一致性按错误归属细分（现正则；第 4 期语义化）：里程碑/总工期 → schedule、
 *   劳动力/工种 → laborPeak、机械 → blueprint；六百分百等无关条目不损伤任何权威 */
export function computeBlueprintAuthorityAvailability(input: {
  schemaPassed: boolean;
  factPassed: boolean;
  coveragePassed: boolean;
  consistencyErrors: string[];
  /** G 线 P0-6：清单源可用性。缺省视为可用（保持既有调用方行为）；
   *  清单不可用时 laborPeak/schedule/blueprint 三项权威均由清单推导 → 一律不可用。 */
  boqAvailable?: boolean;
}): Record<BlueprintAuthorityId, boolean> {
  const scheduleConsistencyOk = !input.consistencyErrors.some(error => /里程碑|总工期/u.test(error));
  const laborConsistencyOk = !input.consistencyErrors.some(error => /劳动力|工种/u.test(error));
  const machineConsistencyOk = !input.consistencyErrors.some(error => /机械/u.test(error));
  const boqOk = input.boqAvailable !== false;
  return {
    laborPeak: boqOk && input.schemaPassed && input.factPassed && laborConsistencyOk,
    schedule: boqOk && input.schemaPassed && input.factPassed && scheduleConsistencyOk,
    blueprint: boqOk && input.schemaPassed && input.factPassed && input.coveragePassed && machineConsistencyOk,
  };
}

/** P14 数值密集章所需蓝图权威（现正则映射：与阻断处历史正则等价拆分；
 * P17 第 4 期：传入 chapterIntentClassifier 时语义优先、正则兑底（union 只增不减）） */
export function chapterBlueprintAuthoritiesNeeded(title: string, classifier?: ChapterIntentClassifier): BlueprintAuthorityId[] {
  if (classifier) return classifier.needsBlueprintAuthority(title);
  const needed: BlueprintAuthorityId[] = [];
  if (/劳动力/u.test(title)) needed.push('laborPeak');
  if (/资源配置|资源|机械|设备|机具/u.test(title)) needed.push('blueprint');
  if (/进度计划|进度|工期/u.test(title)) needed.push('schedule');
  return [...new Set(needed)];
}

/** P14 章级蓝图权威缺口判定（阻断判定 + 消息精确化的统一消费点）：
 * 返回本章所需权威的缺失清单与失败校验项名；无 authorityAvailability（旧数据/占位构造）时保守全阻断 */
/**
 * 按域过滤蓝图数据（G 线 P1-5）。
 *
 * **缺陷**：注入侧此前是「全有全无」——`validation.passed ? data : undefined`。
 * 只要有一项校验没过，**整套**蓝图数据（含完全可用的域）都不注入写作层，
 * 于是「劳动力权威不可用」会连带把进度/清单/图纸等可用权威一并掐断，章级损失被放大成篇级损失。
 *
 * **现口径**：按 `authorityAvailability` 逐域过滤——不可用的域**清零**（而非删字段，
 * 保持类型兼容与消费侧读取路径不变），其余照常注入。清零比删除更安全：消费侧若漏判
 * 仍会读到「0/空」而不是 `undefined` 崩栈，且锚点卡渲染对该域自然产出空内容。
 *
 * 未提供 availability（旧数据/占位构造）时**原样返回**——由调用方的 passed 二元判定兜底，
 * 避免在无信息时擅自清空数据。
 */
/**
 * 章级注入用的蓝图数据（G 线 P1-5 的**唯一决策点**）。
 *
 * 三种情形：
 * 1. `validation.passed` → 全量注入（各域权威齐备）。
 * 2. 未过但**清单源可用**（`0. 清单源可用性` 检查通过）→ 按 `authorityAvailability`
 *    逐域过滤后注入：劳动力不可用不注入 labor，进度/清单/图纸照常。这正是 P1-5 的落点 ——
 *    原实现是「全有全无」，任一校验未过即整套不注入，章级损失被放大成篇级损失。
 * 3. 清单源不可用 → **不注入**。这是 P0-6 的防护：清单缺失时 blueprint 会以空清单走完全程，
 *    产出「schema 合法、authorityAvailability 全 true」的**零权威骨架**；若照情形 2 过滤，
 *    availability 全 true ⇒ 骨架被整份注入，写作层拿不到任何真权威值却以为齐备 ——
 *    正是 P0-6 要根治的「零权威骨架蓝图」。
 */
export function blueprintDataForChapterInjection(blueprint?: IntegratedBlueprint): BlueprintData | undefined {
  if (!blueprint) return undefined;
  if (blueprint.validation.passed) return blueprint.data;
  const boqUsable = blueprint.validation.checks.find(check => check.name === '0. 清单源可用性')?.passed ?? false;
  if (!boqUsable) return undefined;
  return filterBlueprintDataByAvailability(blueprint.data, blueprint.validation.authorityAvailability);
}

export function filterBlueprintDataByAvailability(data: BlueprintData, availability?: BlueprintValidationReport['authorityAvailability']): BlueprintData {
  if (!availability) return data;
  let next = data;
  if (!availability.laborPeak) {
    next = {
      ...next,
      resources: {
        ...next.resources,
        labor: { ...next.resources.labor, peak: { min: 0, max: 0 }, peakValue: 0, byPhase: [], byTrade: [], composition: [] },
      },
    };
  }
  if (!availability.schedule) {
    next = { ...next, schedule: [], contract: { ...next.contract, totalDays: 0 } };
  }
  return next;
}

export function chapterBlueprintAuthorityGaps(title: string, validation?: BlueprintValidationReport, classifier?: ChapterIntentClassifier): { missing: BlueprintAuthorityId[]; failedChecks: string[] } {
  const needed = chapterBlueprintAuthoritiesNeeded(title, classifier);
  const failedChecks = validation ? validation.checks.filter(check => !check.passed).map(check => check.name) : [];
  const availability = validation?.authorityAvailability;
  if (!availability) return { missing: needed, failedChecks };
  return { missing: needed.filter(id => !availability[id]), failedChecks };
}

/** 校验 5：标书编制规格承接（信息审计项，恒定计入 checks 但不参与 passed 计算——
 * 阶段 1 判定缺失/未识别属常规项目正常情形，不损伤任何数值权威） */
function validateBlueprintComposition(blueprint: IntegratedBlueprint): string {
  const composition = blueprint.data.composition;
  if (!composition) return '未承接标书编制规格（生成输入未提供阶段 1 判定，正文口径与文末附表按常规处理）';
  const typeLabel = composition.bidType === 'blind' ? '暗标' : composition.bidType === 'open' ? '明标' : '未识别勾选标记（按常规口径）';
  const tableCount = composition.appendixPlan.filter(entry => entry.kind === 'table').length;
  const figureCount = composition.appendixPlan.filter(entry => entry.kind === 'figure').length;
  return [
    `标书类型：${typeLabel}`,
    `正文口径：${[composition.bodyTablePolicy === 'forbidden' ? '禁表格（显式禁表句）' : '表格允许', composition.bodyFigurePolicy === 'forbidden' ? '禁图片' : '图片允许'].join('/')}`,
    composition.appendixPlan.length > 0 ? `文末附表 ${composition.appendixPlan.length} 项（表类 ${tableCount}/图类 ${figureCount}）` : '',
  ].filter(Boolean).join('；');
}

/** 阶段 D 主入口：四道校验（阻断判定）+ 标书编制规格承接（信息审计），全部阻断校验通过方可冻结 */
export function validateBlueprint(blueprint: IntegratedBlueprint, boq?: BillOfQuantitiesResult): BlueprintValidationReport {
  const checks: BlueprintValidationReport['checks'] = [];
  // G 线 P0-6 素材不足走失败（不接受降级交付）：清单是四源之一，不可用时蓝图**不得**以
  // emptyBoq 兜底继续。此前 `integratedBlueprint.ts:89` 用空清单走完全程，产出的是
  // 「schema 合法、四项校验全绿、authorityAvailability 全 true」的**零权威骨架蓝图**——
  // 下游据此认为权威齐备（blueprintActive=true），写作层拿不到任何权威值，正文数值只能由
  // 模型自产（正是数值冲突/编造数值的源头），而用户看不到任何缺口信号。
  // 现口径：清单缺失或零条目即判蓝图校验失败，缺口写进 checks 供用户定位。
  const boqUnusable = !boq || boq.entries.length === 0;
  checks.push({
    name: '0. 清单源可用性',
    passed: !boqUnusable,
    message: boqUnusable
      ? '工程量清单缺失或未解析出任何条目：工程量/规格/资源计划类权威值全部无法推导，蓝图不可用。请确认资料包内含工程量清单且已成功解析入库后重试。'
      : `清单可用：${boq.entries.length} 条目、${boq.villages.length} 个单位工程`,
  });
  const schemaErrors = validateBlueprintSchema(blueprint);
  checks.push({ name: '1. Schema 校验', passed: schemaErrors.length === 0, message: schemaErrors.length === 0 ? '结构/类型/必填/边界全部通过' : schemaErrors.join('；') });
  const factErrors = validateBlueprintFacts(blueprint, boq);
  checks.push({ name: '2. 事实锚定校验', passed: factErrors.length === 0, message: factErrors.length === 0 ? 'L1a 值全部 ∈ 清单解析产物值集，红线事实逐条有源' : factErrors.join('；') });
  const coverageErrors = validateBlueprintCoverage(blueprint, boq);
  checks.push({ name: '3. 覆盖校验', passed: coverageErrors.length === 0, message: coverageErrors.length === 0 ? '清单条目零丢失、重难点逐项列明' : coverageErrors.join('；') });
  const consistencyErrors = validateBlueprintConsistency(blueprint);
  checks.push({ name: '4. 内部一致性校验', passed: consistencyErrors.length === 0, message: consistencyErrors.length === 0 ? '里程碑/劳动力/机械区间自洽' : consistencyErrors.join('；') });
  // 校验 5：标书编制规格承接（信息审计项恒 passed：透明度优先，不参与阻断）
  checks.push({ name: '5. 标书编制规格承接', passed: true, message: validateBlueprintComposition(blueprint) });
  // P14 分层权威：per-check 错误 → authorityAvailability（documentGenerator 数值密集章阻断判定消费）
  const authorityAvailability = computeBlueprintAuthorityAvailability({
    schemaPassed: schemaErrors.length === 0,
    factPassed: factErrors.length === 0,
    coveragePassed: coverageErrors.length === 0,
    consistencyErrors,
    boqAvailable: !boqUnusable,
  });
  return { passed: checks.every(check => check.passed), checks, authorityAvailability };
}
