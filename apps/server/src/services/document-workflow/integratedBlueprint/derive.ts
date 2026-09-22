/**
 * 阶段 A 参数桶推导（劳动力/机械/材料计划/里程碑/检验批/土方平衡/临时设施/施工部署/重难点；含 buildBlueprintData 主装配）——按策略组参数确定性推导
 *
 * S6 零行为拆分自 integratedBlueprint.ts（门面 re-export，对外导出不变）：仅机械搬迁，未改动任何语句与常量。
 */
import { climateForZone, DEFAULT_INSTRUMENT_TABLE, DEFAULT_SITE_FACILITY_TABLE, resolveClimateByLocation, type BlueprintDerivationStrategy, type LaborQuotaRow } from '../blueprintDerivationStrategies';
import type { BillOfQuantitiesResult, BoqEntry } from '../billOfQuantitiesParser';
import type { DocumentEvidence, DocumentFact } from '../types';
import { buildBlueprintDecisionLock } from './decisionLock';
import { buildAuthoritativeValues } from '../authoritativeValues';
import { collapseOverrideChains, extractValueOverrides } from '../valueOverride';
import { deriveQuantitiesFromBoq, deriveSpecAuthoritiesFromBoq, extractBasisRegulations, extractContractFromFacts, extractLocationFromFacts, extractRedLineFacts, extractVillageCount } from './parse';
import { BLUEPRINT_AMOUNT_RULE } from './types';
import type { BlueprintBuildDiagnostics, BlueprintData, BlueprintDeployment, BlueprintDifficulty, BlueprintEarthworkBalance, BlueprintEquipmentItem, BlueprintInspectionBatch, BlueprintInstrumentItem, BlueprintLabor, BlueprintMaterialPlanItem, BlueprintMilestone, BlueprintScheduleItem, BlueprintTempLandItem, BlueprintTempUtilities } from './types';

/** L2 推导参数已迁出至 blueprintDerivationStrategies 策略表（工程类型注册制）：
 * 工种映射/工效系数/条目归类/里程碑分组/机械映射/功率表/检验批规则/重难点模板
 * 全部按策略组取用，必须显式传策略。 */
export function deriveLaborFromBoq(boq: BillOfQuantitiesResult, totalDays: number, milestones: BlueprintMilestone[] = [], strategy: BlueprintDerivationStrategy): BlueprintLabor {
  const days = totalDays > 0 ? totalDays : 360;
  const { groupOfEntry, laborUnitRange, tradeMapping, milestoneGroups } = strategy;
  const byGroup = new Map<string, { trade: string; workdaysMin: number; workdaysMax: number; unit: string; basisQty: number; quota?: LaborQuotaRow }>();
  for (const entry of boq.entries) {
    if (entry.quantity <= 0) continue;
    const group = groupOfEntry(entry);
    // 定额知识库接入点：命中定额行 → 定额工日区间；未命中 → 策略组经验区间降级（六策略组当前均未配置定额表，行为与 4.20.1 一致）
    const quota = strategy.laborQuotaTable?.find(row => row.pattern.test(`${entry.name} ${entry.description}`) && row.unit === entry.unit);
    const coeff = quota || laborUnitRange[group];
    if (!coeff) continue;
    // 单位混加根治（丰乐镇第 3 轮）：条目计量单位与分组系数单位不一致不入桶
    // （级配碎石垫层 m² 曾被按 m³ 系数乘 → 混凝土工 476~1087 人虚高）
    if (entry.unit !== coeff.unit) continue;
    const trade = tradeMapping.find(item => item.pattern.test(`${entry.name} ${entry.description}`))?.trade;
    if (!trade) continue; // 未匹配条目不进任何工种（普工 fallback 曾混单位累加 104663 虚数）
    const key = `${group}|${trade}`;
    const existing = byGroup.get(key) || { trade, workdaysMin: 0, workdaysMax: 0, unit: coeff.unit, basisQty: 0, quota };
    // 同 key 内定额与经验混用 → 降级区间表达（basis 不再宣称定额命中）
    if (existing.quota !== quota) existing.quota = undefined;
    existing.workdaysMin += entry.quantity * coeff.min;
    existing.workdaysMax += entry.quantity * coeff.max;
    existing.basisQty += entry.quantity;
    byGroup.set(key, existing);
  }
  // 工种聚合
  const byTrade = new Map<string, { min: number; max: number; unit: string; qty: number; quota?: LaborQuotaRow }>();
  for (const item of byGroup.values()) {
    const slot = byTrade.get(item.trade) || { min: 0, max: 0, unit: item.unit, qty: 0, quota: item.quota };
    if (slot.quota !== item.quota) slot.quota = undefined;
    slot.min += item.workdaysMin;
    slot.max += item.workdaysMax;
    slot.qty += item.basisQty;
    byTrade.set(item.trade, slot);
  }
  const byTradeResult: BlueprintLabor['byTrade'] = [...byTrade.entries()]
    .sort((left, right) => right[1].max - left[1].max)
    .map(([trade, slot]) => ({
      trade,
      min: Math.max(1, Math.round(slot.min / days)),
      max: Math.max(1, Math.round(slot.max / days)),
      basis: slot.quota
        ? `工种工程量约 ${Math.round(slot.qty)}${slot.unit} × 定额工效（${slot.quota.subName} ${slot.quota.code}，${slot.quota.min}~${slot.quota.max} 工日/${slot.unit}）÷ 工期 ${days} 天（定额知识库命中）`
        : `工种工程量约 ${Math.round(slot.qty)}${slot.unit} × 经验工效区间 ÷ 工期 ${days} 天（定额工效知识不全，降级区间表达）`,
    }));
  const totalMin = byTradeResult.reduce((sum, item) => sum + (item.min || 0), 0);
  const totalMax = byTradeResult.reduce((sum, item) => sum + (item.max || 0), 0);
  // 劳动力投入区间 = 各工种人数区间之和（同期在场上界口径：重叠系数无权威依据，不做折算——宁取保守上界）
  const peak = { min: totalMin, max: totalMax };
  const peakBasis = `各工种人数区间之和 ${totalMin}~${totalMax} 人（同期在场上界口径，不做无依据折算）`;
  // 峰值唯一口径：区间中值收敛为唯一值（决策锁/参数桶/引用一致性检测全部锚定该值，区间仅保留作推导依据）
  const peakValue = Math.round((peak.min + peak.max) / 2);
  // byPhase：按里程碑分组分桶（分阶段计划表数据源，不再恒空）
  const byPhase: BlueprintLabor['byPhase'] = [];
  for (const group of milestoneGroups) {
    // 阶段工效系数解析（三期：定额知识库优先，未命中降级经验区间）
    const phaseCoeffOf = (entry: BoqEntry) => {
      const quota = strategy.laborQuotaTable?.find(row => row.pattern.test(`${entry.name} ${entry.description}`) && row.unit === entry.unit);
      return quota || laborUnitRange[groupOfEntry(entry)];
    };
    const phaseEntries = boq.entries.filter(entry => {
      if (entry.quantity <= 0) return false;
      if (!group.pattern.test(`${entry.name} ${entry.description}`)) return false;
      const c = phaseCoeffOf(entry);
      if (!c || entry.unit !== c.unit) return false;
      return tradeMapping.some(item => item.pattern.test(`${entry.name} ${entry.description}`));
    });
    if (phaseEntries.length === 0) continue;
    const phaseWorkdaysMin = phaseEntries.reduce((sum, entry) => sum + entry.quantity * (phaseCoeffOf(entry)?.min || 0), 0);
    const phaseWorkdaysMax = phaseEntries.reduce((sum, entry) => sum + entry.quantity * (phaseCoeffOf(entry)?.max || 0), 0);
    const duration = milestones.find(item => item.key === group.key)?.duration || Math.max(1, Math.round(days / milestoneGroups.length));
    const min = Math.max(1, Math.round(phaseWorkdaysMin / duration));
    const max = Math.max(min, Math.round(phaseWorkdaysMax / duration));
    byPhase.push({
      phase: group.label,
      // 阶段同时在场人数按峰值封顶（历史实测：景观绿化阶段推导值曾超峰值产生自相矛盾口径；
      // 封顶后至少一个阶段达到峰值，与「分阶段投入最大值=峰值」的口径自洽）
      min: Math.min(min, peakValue),
      max: Math.min(max, peakValue),
      basis: `阶段条目工程量约 ${Math.round(phaseEntries.reduce((sum, entry) => sum + entry.quantity, 0))} × 经验工效区间 ÷ 阶段 ${duration} 天（同时在场人数按峰值 ${peakValue} 人封顶）`,
    });
  }
  // 工种构成唯一口径：按工种区间中值比例收敛到合计=峰值（历史实测区间中值之和与峰值自相矛盾——
  // 写作层忠实使用后产生多套矛盾口径；floor 1 + 最大余数法分配）
  const tradeMids = byTradeResult.map(item => ({ trade: item.trade, mid: Math.max(1, Math.round(((item.min ?? 1) + (item.max ?? item.min ?? 1)) / 2)) }));
  const tradeMidTotal = tradeMids.reduce((sum, item) => sum + item.mid, 0) || 1;
  const quotas = tradeMids.map(item => ({ trade: item.trade, quota: (item.mid * peakValue) / tradeMidTotal }));
  const counts = quotas.map(item => ({ trade: item.trade, count: Math.max(1, Math.floor(item.quota)) }));
  let compositionDelta = peakValue - counts.reduce((sum, item) => sum + item.count, 0);
  if (compositionDelta > 0) {
    // 最大余数法：差额按配额小数部分降序逐个 +1（合计精确等于峰值）
    const order = quotas.map((item, index) => ({ index, frac: item.quota - Math.floor(item.quota) })).sort((left, right) => right.frac - left.frac);
    for (let k = 0; compositionDelta > 0 && k < order.length; k += 1) {
      const slot = order[k];
      if (!slot) continue;
      const target = counts[slot.index];
      if (!target) continue;
      target.count += 1;
      compositionDelta -= 1;
    }
  } else if (compositionDelta < 0) {
    // 工种过多且峰值过小：按配额升序压减 count>1 的工种，保证合计仍等于峰值
    const order = quotas.map((item, index) => ({ index, quota: item.quota })).sort((left, right) => left.quota - right.quota);
    for (let k = 0; compositionDelta < 0 && k < order.length; k += 1) {
      const slot = order[k];
      if (!slot) continue;
      const target = counts[slot.index];
      if (!target || target.count <= 1) continue;
      target.count -= 1;
      compositionDelta += 1;
    }
  }
  const composition: BlueprintLabor['composition'] = counts.map(item => ({
    trade: item.trade,
    count: item.count,
    basis: `工种构成唯一口径：按工种工程量区间中值比例收敛（合计恒等于峰值 ${peakValue} 人）`,
  }));
  return {
    peak,
    peakValue,
    peakBasis,
    byPhase,
    byTrade: byTradeResult,
    composition,
  };
}

/** L2：机械选型与数量区间（清单特征提示 → 机械映射 + 台数区间；映射表按工程类型策略组取用） */
export function deriveEquipmentFromBoq(boq: BillOfQuantitiesResult, strategy: BlueprintDerivationStrategy): BlueprintEquipmentItem[] {
  const result: BlueprintEquipmentItem[] = [];
  for (const mapping of strategy.equipmentMapping) {
    // 名称+单位双条件（丰乐镇第 3 轮：单位不符条目不入桶，根治「124 套」混单位虚数）；
    // unit 为空串 = 不限计量单位（闸门/启闭机等条目 t/樘/项多种计量形态均可命中）
    const hits = boq.entries.filter(entry => mapping.pattern.test(`${entry.name} ${entry.description}`) && (!mapping.unit || entry.unit === mapping.unit));
    if (hits.length === 0) continue;
    const totalQty = hits.reduce((sum, entry) => sum + entry.quantity, 0);
    const min = Math.max(1, Math.min(4, Math.ceil(Math.log10(Math.max(10, totalQty)) - 1)));
    const max = Math.max(min, Math.min(8, min + 2));
    result.push({ name: mapping.name, spec: mapping.spec, min, max, basis: `${mapping.basis}；相关条目工程量合计约 ${Math.round(totalQty)}${hits[0]?.unit || ''}` });
  }
  return result;
}

/** L2：物资需用量计划 = 清单条目汇总（主要材料按名称聚合）；
 * 型号/规格/参数从清单条目特征原文确定性提取（丰乐镇实测材料表「级配碎石10cm厚」
 * 「UPVC管DN110」由 LLM 编造口径——清单明确的规格是事实数据，必须由蓝图承载而非模型自编）。
 * 丰乐镇十四版实测缺陷：同名多规格条目（如一般路灯 100W/120W）按名称聚合后规格与拆分数值双丢失，
 * LLM 只拿到总量自行分配（118 套写 100W 111 + 120W 7，清单实为 109 + 9）——聚合键升级为
 * 「名称+规格」：同名不同规格拆分保留（渲染自然带出逐项数量），同名无规格可区分（如塑料/砌筑检查井）
 * 维持按名称聚合现状（不误拆），确保写作层规格-数量拆分零丢失、零自编。 */
export function deriveMaterialsPlanFromBoq(boq: BillOfQuantitiesResult): BlueprintMaterialPlanItem[] {
  const byKey = new Map<string, { name: string; quantity: number; unit: string; spec?: string }>();
  for (const entry of boq.entries) {
    if (!entry.name || entry.quantity <= 0) continue;
    const spec = extractMaterialSpec(`${entry.name} ${entry.description}`);
    // 有规格 → 按名称+规格聚合（同名多规格拆分保留）；无规格 → 按名称聚合（维持现状不误拆）
    const key = spec ? `${entry.name}||${spec}` : entry.name;
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity += entry.quantity;
    } else {
      byKey.set(key, { name: entry.name, quantity: entry.quantity, unit: entry.unit, spec: spec || undefined });
    }
  }
  // V5 P2 去截断：不再按名称总量选 top 40 名称（截断是隐藏信息——第 41+ 名称在权威里
  // 不存在，检测/修复/渲染三端同时失明）；全量输出，按条目数量降序保持重要对象在前
  return [...byKey.values()]
    .sort((left, right) => right.quantity - left.quantity)
    .map(item => ({
      name: item.name,
      quantity: Math.round(item.quantity * 1000) / 1000,
      unit: item.unit,
      spec: item.spec,
      batchDesc: '按施工段分批进场',
      basis: '清单汇总 + 进度匹配',
    }));
}

/** 材料规格特征白名单（确定性零 LLM）：只认清单语境明确的型号参数形态，
 * 不抓长度/深度/标高类通用数值——写作层材料表必须原样引用这些规格，不得自编 */
const MATERIAL_SPEC_PATTERNS: RegExp[] = [
  /C\d{2,3}/u, // 混凝土/砂浆强度等级（C20/C25）
  /DN\d{2,4}/iu, // 公称直径（DN110/DN200）
  /Φ\d+(?:\.\d+)?/u, // 直径符号（Φ10）
  /\d+(?:\.\d+)?\s*(?:kW|W)/iu, // 功率（60W/1.5kW）
  /厚(?:度)?[：:]*\s*\d+(?:\.\d+)?\s*(?:mm|cm)/u, // 厚度（厚10cm/厚度：10cm）
  /\d+\s*[×xX]\s*\d+(?:\s*[×xX]\s*\d+)?\s*(?:mm|cm)?/u, // 外形尺寸（1000×100×300）
  /HRB\d{3,4}/u, // 钢筋牌号（HRB400）
  /Q\d{3}[A-Z]?/u, // 钢型号（Q235B）
  /YJV[^。；;]{0,12}|VV\d+[^。；;]{0,12}/u, // 电缆型号（YJV22-4×25 / VV22）
];

function extractMaterialSpec(text: string): string {
  const found: string[] = [];
  for (const pattern of MATERIAL_SPEC_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || !match[0]) continue;
    if (found.some(item => item.includes(match[0]!) || match[0]!.includes(item))) continue;
    found.push(match[0]);
  }
  return found.join(' ');
}

/** L2：里程碑按工程分部工程量权重分配总工期（prep 前导工作封顶 8%，总和 ≤ 总工期）；
 * 非 prep 分部权重合计不足 5% 时降级为按总工期均分（根治跨类型项目「360 天工期只推导 37 天」荒谬值） */
export function deriveMilestonesFromBoq(boq: BillOfQuantitiesResult, totalDays: number, strategy: BlueprintDerivationStrategy): BlueprintMilestone[] {
  const days = totalDays > 0 ? totalDays : 360;
  const groups = strategy.milestoneGroups;
  const weights = groups.map(group => ({ ...group, weight: boq.entries.filter(entry => group.pattern.test(`${entry.name} ${entry.description}`)).reduce((sum, entry) => sum + entry.quantity, 0) }));
  // prep（准备与清杂）为前导工作，可与主体工程并行穿插，工期封顶为总工期的 8%（整治类清单
  // 如「房前屋后整理」面积巨大但非独占工期，不按工程量权重直接摊入）
  const prepCapRatio = 0.08;
  const prepDuration = Math.max(1, Math.round(days * prepCapRatio));
  const remainingDays = days - prepDuration;
  const otherGroups = weights.slice(1);
  const rawOtherWeight = otherGroups.reduce((sum, item) => sum + item.weight, 0);
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0);
  // 均分兜底：非 prep 分部权重占比 < 5%（或全 0）→ 策略分组与本项目分部特征不匹配，按总工期均分，
  // basis 注明「均分降级」供 buildBlueprintData 写入诊断警告
  const equalSplit = rawOtherWeight <= 0 || (totalWeight > 0 && rawOtherWeight / totalWeight < 0.05);
  const otherWeight = equalSplit ? 0 : rawOtherWeight;
  const equalShare = otherGroups.length > 0 ? Math.max(2, Math.round((remainingDays * 0.95) / otherGroups.length)) : 0;
  const milestones: BlueprintMilestone[] = [{
    key: 'prep',
    label: groups[0]?.label || '施工准备与清杂拆除',
    duration: prepDuration,
    basis: `前导工作封顶 ${prepCapRatio * 100}% 总工期（清杂整治可与主体并行穿插，不按工程量权重独占）`,
  }];
  for (const group of otherGroups) {
    if (equalSplit) {
      milestones.push({ key: group.key, label: group.label, duration: equalShare, basis: `分部特征未命中策略分组（非 prep 权重占比 ${totalWeight > 0 ? (rawOtherWeight / totalWeight * 100).toFixed(1) : '0.0'}% < 5%），按总工期均分降级（每组 ${equalShare} 天）` });
      continue;
    }
    // 不适用阶段剔除：权重 0 = 本项目清单里没有该分部的任何条目 → 它不是本项目的阶段。
    // 历史实现给权重 0 的阶段发 2 天下限（注释「1 天荒谬值」），于是产出一个本项目并不存在的
    // 阶段与工期，写作层照着写出无依据的该分部内容，劳动力派生又因查无条目而报「资料不足」假告警
    // （丰乐镇：策略模板含「亮化与收尾工程」，但清单 904 条目中无任何亮化条目）。
    // 口径：策略模板只是候选阶段，命中不了清单就不产出——不由兜底凭空造阶段。
    if (group.weight <= 0) continue;
    const duration = Math.max(2, Math.round((group.weight / otherWeight) * remainingDays * 0.95));
    milestones.push({ key: group.key, label: group.label, duration, basis: `分部工程量权重 ${(group.weight / otherWeight * 100).toFixed(1)}% × 剩余工期 ${remainingDays} 天` });
  }
  // 收口：总和超限时从后往前压缩
  let sum = milestones.reduce((acc, item) => acc + (item.duration || 0), 0);
  for (let i = milestones.length - 1; i >= 0 && sum > days; i--) {
    const over = sum - days;
    const cut = Math.min(milestones[i]?.duration || 0, over);
    if (milestones[i] && cut > 0) {
      milestones[i].duration = (milestones[i].duration || 0) - cut;
      sum -= cut;
    }
  }
  return milestones;
}

/** L2：检验批划分（工程量 ÷ 批量，确定性推导；规则按工程类型策略组取用） */
export function deriveInspectionBatchesFromBoq(boq: BillOfQuantitiesResult, strategy: BlueprintDerivationStrategy): BlueprintInspectionBatch[] {
  const batches: BlueprintInspectionBatch[] = [];
  for (const rule of strategy.inspectionBatchRules) {
    const hits = boq.entries.filter(entry => rule.namePattern.test(entry.name) && (!rule.unit || entry.unit === rule.unit));
    const total = hits.reduce((sum, entry) => sum + entry.quantity, 0);
    if (total <= 0) continue;
    const count = rule.divisor > 0 ? Math.max(1, Math.ceil(total / rule.divisor)) : 0;
    const planDesc = rule.descTemplate.replace('{count}', String(count)).replace('{total}', String(Math.round(total * 1000) / 1000));
    batches.push({ scope: rule.scope, planDesc });
  }
  return batches;
}

/** L2：土方平衡（清单挖/填/弃量汇总） */
export function deriveEarthworkBalanceFromBoq(boq: BillOfQuantitiesResult): BlueprintEarthworkBalance {
  const excavation = boq.entries.filter(entry => /挖一般土方|挖沟槽土方|挖基坑土方|清淤/u.test(entry.name) && entry.unit === 'm3').reduce((sum, entry) => sum + entry.quantity, 0);
  const backfill = boq.entries.filter(entry => /回填|路肩土|种植土/u.test(entry.name) && entry.unit === 'm3').reduce((sum, entry) => sum + entry.quantity, 0);
  const disposal = Math.max(0, Math.round((excavation - backfill) * 1000) / 1000);
  return {
    excavation: Math.round(excavation * 1000) / 1000,
    backfill: Math.round(backfill * 1000) / 1000,
    disposal,
    basis: '清单挖/填/弃量汇总（挖方含清淤），补疑口径：购土回填运距自行考虑',
  };
}

/** 柴油动力机械（不接电网，不得计入临时用电负荷；丰乐镇第 3 轮：挖掘机/自卸汽车等
 * 按台数乘功率计入 ΣP → 3168kW 荒谬值，正文随之污染） */
const DIESEL_MACHINES = new Set(['挖掘机', '自卸汽车', '压路机', '洒水车', '高空作业车', '混凝土搅拌运输车']);

/** L2：临时用水用电计算（只计电动机具；值化输出，不得携带公式符号；功率表与定性文本按工程类型策略组取用） */
export function deriveTempUtilitiesFromBoq(equipment: BlueprintEquipmentItem[], labor: BlueprintLabor, strategy: BlueprintDerivationStrategy): BlueprintTempUtilities {
  const { machinePowerTable, powerFallbackText, waterNoteText } = strategy;
  const electricEquipment = equipment.filter(item => !DIESEL_MACHINES.has(item.name));
  const totalKw = electricEquipment.reduce((sum, item) => sum + (machinePowerTable.find(power => power.name === item.name)?.kw || 0) * (item.min || 1), 0);
  const powerLoad = totalKw > 0
    ? `按电动机具负荷计算，用电负荷约 ${Math.round(totalKw * 0.7)} kW（电动机具总功率约 ${Math.round(totalKw)} kW，同时系数 0.7），${powerFallbackText}`
    : powerFallbackText;
  // 值化输出（丰乐镇第 3 轮）：只写计算值与一句话依据，不得携带公式符号（远端客户反馈公式入正文）
  const waterDaily = Math.round((labor.peakValue * 60 / 1000) * 10) / 10;
  const waterUsage = `生活用水按高峰人数 ${labor.peakValue} 人、每人每日 60L 计算，高峰日生活用水量约 ${waterDaily} m³；${waterNoteText}`;
  return { powerLoad, waterUsage };
}

/** L3：施工部署（锚定清单村分组与分部编排顺序；无村分组时按策略组兑底话术，不再输出村域话术） */
export function deriveConstructionDeployment(boq: BillOfQuantitiesResult, strategy: BlueprintDerivationStrategy): BlueprintDeployment {
  const villages = boq.villages.map(village => village.villageGroup);
  const sections = villages.map(name => ({ name, basis: `清单按${strategy.groupLabel}（工程名称）` }));
  // 多村平行话术仅村域组提供（multiVillageFlow）；其他类型多段分组也输出通用兑底（宁缺毋错，不输出「村内流水作业」错配话术）
  const flow = sections.length > 1
    ? (strategy.multiVillageFlow?.(sections.length) || strategy.deploymentFlowFallback)
    : strategy.deploymentFlowFallback;
  // 分部编排顺序：按分部条目工程量权重降序 → 管网/道路先行、绿化亮化收尾
  const sectionOrder = [...new Set(boq.entries.map(entry => entry.section).filter(Boolean))];
  const sequence = sectionOrder.length > 0 ? sectionOrder.join(' → ') : strategy.sequenceFallback;
  return {
    sections,
    sequence,
    sequenceBasis: '清单分部分项编排顺序归纳',
    flow,
  };
}

/** L3：重难点识别（逐项列明 + 每项配保证措施；模板按工程类型策略组取用，
 * 只写入有资料特征支撑的条目，零命中时通用兜底） */
export function deriveKeyDifficulties(boq: BillOfQuantitiesResult, strategy: BlueprintDerivationStrategy): BlueprintDifficulty[] {
  const difficulties: BlueprintDifficulty[] = [];
  for (const template of strategy.difficultyTemplates) {
    if (!template.test(boq)) continue;
    difficulties.push({
      name: typeof template.name === 'function' ? template.name(boq) : template.name,
      measure: template.measure,
      basis: template.basis,
    });
  }
  if (difficulties.length === 0) {
    difficulties.push({ name: '多工序交叉施工组织', measure: '按清单分部分项编排顺序组织流水作业，加强工序衔接检查', basis: '清单分部分项结构' });
  }
  return difficulties;
}

/** C2 附表二：试验检测仪器配置（策略组配置或通用默认集）——「拟配备」口径的行业常规仪器，
 * 型号/数量按策略组配置照抄；投产信息列（产地/年份/台时数）由渲染层留空，不得编造。
 * basis 为中性表述（检定/配置口径），内部推导话术不进投标文档附表。 */
export function deriveTestInstruments(strategy: BlueprintDerivationStrategy): BlueprintInstrumentItem[] {
  const rows = strategy.instrumentTable || DEFAULT_INSTRUMENT_TABLE;
  return rows.map(row => ({
    name: row.name,
    spec: row.spec,
    quantity: row.quantity,
    purpose: row.purpose,
    basis: '检定合格后投入使用',
  }));
}

/** C2 附表四：进度计划工序表（里程碑顺序累加推导起止天序）。
 * prep（准备与清杂）为前导工作不计入关键线路；其余工序按里程碑顺序衔接构成关键线路。 */
export function deriveSchedule(milestones: BlueprintMilestone[]): BlueprintScheduleItem[] {
  const items: BlueprintScheduleItem[] = [];
  let cursor = 1;
  for (const [index, item] of milestones.entries()) {
    const duration = Math.max(1, item.duration || 1);
    const startDay = cursor;
    const endDay = cursor + duration - 1;
    items.push({
      seq: index + 1,
      label: item.label,
      duration,
      startDay,
      endDay,
      critical: item.key !== 'prep',
      basis: item.key === 'prep' ? '前导工作，与主体施工穿插进行' : '按里程碑顺序衔接',
    });
    cursor = endDay + 1;
  }
  return items;
}

/** C2 附表五/六：临时设施与用地规划（面积为固定配置或按劳动力峰值人均指标推导；
 * 位置为功能区位口径，不指定具体方位、不编造现场事实） */
export function deriveTempLand(strategy: BlueprintDerivationStrategy, labor: BlueprintLabor): BlueprintTempLandItem[] {
  const rows = strategy.siteFacilityTable || DEFAULT_SITE_FACILITY_TABLE;
  return rows.map(row => ({
    purpose: row.name,
    area: row.area || (row.areaPerCapita ? Math.max(10, Math.round(labor.peakValue * row.areaPerCapita)) : undefined),
    location: row.locationHint,
    duration: row.durationHint,
    note: row.note,
    basis: '施工总平面布置规划',
  }));
}

export function buildBlueprintData(input: {
  boq: BillOfQuantitiesResult;
  basicFacts?: string;
  evidence?: DocumentEvidence[];
  facts?: DocumentFact[];
  projectName: string;
  strategy: BlueprintDerivationStrategy;
}): { data: BlueprintData; diagnostics: Pick<BlueprintBuildDiagnostics, 'warnings'> } {
  const { boq } = input;
  const strategy = input.strategy;
  const quantities = deriveQuantitiesFromBoq(boq);
  const redLineFacts = extractRedLineFacts(boq);
  // 自然村数量红线事实（P2.4）：项目名正则提取（村数表述形如「N个×××自然村」）优先，降级清单分组数；拦截跨项目残留「9 个自然村」。
  // 仅乡村类项目（strategy.villageOriented）产出：非乡村项目把清单分组数当「自然村数量」会造出错误红线事实，
  // 并经 citation.ts 的 village-count 冲突判定污染全文口径（巢湖产业园项目实测）。
  const villageCount = strategy.villageOriented
    ? (extractVillageCount(input.projectName, input.basicFacts || '') || boq.villages.length)
    : 0;
  if (villageCount > 0) {
    redLineFacts.push({ key: '自然村数量', value: `${villageCount} 个自然村`, source: '招标文件项目名称（清单自然村分组兜底）' });
  }
  const specAuthorities = deriveSpecAuthoritiesFromBoq(boq);
  // 4.55.19 真值层（读侧单点真值）：蓝图 contract 不再自行解析文本口径——先裁决再消费。
  // 实测缺陷：招标 365 / 答疑澄清 330 时，蓝图按 365 推导里程碑与进度计划（起止天序排到第 348 天），
  // 而正文按 330 写 → 同文档两套工期。
  const truthAudit = buildAuthoritativeValues({
    facts: (input.facts || []).map(fact => ({ key: fact.key, label: fact.fieldName, value: fact.value, sourceFile: fact.sourceFile })),
    overrides: collapseOverrideChains(extractValueOverrides([
      ...(input.evidence || []).map(item => ({ text: String(item.content || ''), source: `${item.filePath || ''} ${item.sectionTitle || ''}` })),
      ...(input.facts || []).map(fact => ({ text: String(fact.value ?? ''), source: String(fact.sourceFile || '') })),
    ])),
  });
  const truth = new Map(truthAudit.resolved.map(item => [item.attribute, item.value]));
  const contract = extractContractFromFacts(input.basicFacts || '', boq, {
    计划工期: truth.get('计划工期'),
    质量标准: truth.get('质量标准'),
    合同金额: truth.get('合同金额'),
  });
  const milestones = deriveMilestonesFromBoq(boq, contract.totalDays, strategy);
  const labor = deriveLaborFromBoq(boq, contract.totalDays, milestones, strategy);
  const equipment = deriveEquipmentFromBoq(boq, strategy);
  const materialsPlan = deriveMaterialsPlanFromBoq(boq);
  const inspectionBatches = deriveInspectionBatchesFromBoq(boq, strategy);
  const earthworkBalance = deriveEarthworkBalanceFromBoq(boq);
  const tempUtilities = deriveTempUtilitiesFromBoq(equipment, labor, strategy);
  const evidenceText = (input.evidence || []).map(item => String(item.content || '')).join('\n');
  const constructionDeployment = deriveConstructionDeployment(boq, strategy);
  const keyDifficulties = deriveKeyDifficulties(boq, strategy);
  const decisionLock = buildBlueprintDecisionLock({ facts: input.facts, evidence: input.evidence, contract, labor, boq, villageCount });
  const works = [...new Set(boq.entries.map(entry => entry.section).filter(Boolean))];
  // 气候区域化：建设地点 → 气候区表匹配（原硬编码华东值迁入 east 区，丰乐镇行为不变）；
  // 地点缺失时按策略组气候区兜底（村域 → east）；均未命中置空 + 诊断警告（宁缺毋错，不注入错误气候值）
  const location = extractLocationFromFacts(input.basicFacts || '');
  const climate = location ? resolveClimateByLocation(location) : climateForZone(strategy.climateZone);
  const warnings: string[] = [];
  if (milestones.some(item => item.basis.includes('均分降级'))) {
    warnings.push('里程碑分组未命中策略特征（非 prep 权重占比 < 5%），已按总工期均分降级，详见 data.milestones.basis');
  }
  // 策略阶段未命中清单 → 该阶段不产出（见 deriveMilestonesFromBoq）。显式告知而不是静默丢弃：
  // 这既可能是「本项目确实没有该分部」，也可能是「清单解析漏了」或「策略分部特征没覆盖到」，
  // 用户看到才知道该去查哪一端。注意措辞是「本阶段不产出」，不是「劳动力资料不足」——
  // 后者会把「本项目没有的分部」误报成「数据缺失」（丰乐镇亮化分部的历史假告警形态）。
  const derivedPhaseKeys = new Set(milestones.map(item => item.key));
  const unmatchedPhases = strategy.milestoneGroups.slice(1).filter(group => !derivedPhaseKeys.has(group.key));
  if (unmatchedPhases.length > 0) {
    warnings.push(`策略阶段未命中清单，本阶段不产出：${unmatchedPhases.map(group => group.label).join('、')}（本项目清单中无对应分部条目；若确有该分部工作，请检查清单解析完整性或策略分部特征是否覆盖）`);
  }
  if (labor.peakValue <= 0) {
    warnings.push('劳动力数据未产出（清单中无可用工效推导条目）：正文不引用劳动力数值，不得自行估计');
  } else {
    // 核对对象必须是**实际产出**的最后一个阶段，而不是策略模板里的最后一个：
    // 模板阶段命中不了清单时本就不产出（见 deriveMilestonesFromBoq 不适用阶段剔除），
    // 拿模板去核对等于给「本项目没有的分部」报「资料不足」——丰乐镇亮化分部即此形态的假告警。
    const tailGroup = milestones[milestones.length - 1];
    if (tailGroup && !labor.byPhase.some(item => item.phase === tailGroup.label)) {
      // 归因口径（丰乐镇亮化分部实测）：该阶段**有**清单条目（如一般路灯/配电箱/电力电缆），
      // 条目在 deriveLaborFromBoq 里因「分组落入 fallback 组（安装工程）→ 系数单位不匹配（项 vs 套/m/台）
      // 或系数占位为 0」而被跳过，因此**不是"资料不足"，而是"无可用工效系数"**。
      // 原文案「资料不足，不编造人数」会把策略组未配置该类工效的数据缺口误述成资料缺失，
      // 使用者据此去补资料是白费——应指向策略组工效配置（laborQuotaTable 接入点）。
      warnings.push(`分阶段劳动力缺「${tailGroup.label}」行：该阶段条目无可用工效系数（分组/计量单位未匹配到工效，策略组未配置该类工效；不编造人数）`);
    }
  }
  if (!climate.rainySeason) {
    warnings.push('气候区域未识别，季节施工由写作层按建设地点常识处理');
  }
  const data: BlueprintData = {
    strategyId: strategy.id,
    project: {
      name: input.projectName || '（待提取：项目名称）',
      scope: boq.villages.length > 0 ? `${boq.villages.length} 个${strategy.groupLabel}（${boq.villages.map(village => village.villageGroup).join('、')}）` : '',
      works,
      location,
    },
    contract: { totalDays: contract.totalDays, qualityStandard: contract.qualityStandard, pricingFile: contract.pricingFile, estimatedAmount: contract.estimatedAmount || undefined },
    climate,
    milestones,
    resources: { labor, equipment },
    materialsPlan,
    fundPlan: { wageRule: '工资性工程款按工程所在地造价管理规定执行', usagePlan: '按进度分阶段使用' },
    testPlan: [],
    testInstruments: deriveTestInstruments(strategy),
    tempLand: deriveTempLand(strategy, labor),
    schedule: deriveSchedule(milestones),
    earthworkBalance,
    tempUtilities,
    redLineFacts,
    amountRule: BLUEPRINT_AMOUNT_RULE,
    decisionLock,
    quantities,
    specAuthorities,
    inspectionBatches,
    constructionDeployment,
    keyDifficulties,
    basisRegulations: extractBasisRegulations(`${input.basicFacts || ''}\n${evidenceText}`),
    drawingNote: '总平面布置图/横道图/组织机构图为后期人工配图，蓝图只规划对应章节正文内容',
  };
  return { data, diagnostics: { warnings } };
}
