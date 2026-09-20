/**
 * 阶段 0 资料解析与提取（清单解析、量/红线事实派生、村数/规格权威/合同/依据/地点提取、基础事实与项目名渲染）——确定性零 LLM
 *
 * S6 零行为拆分自 integratedBlueprint.ts（门面 re-export，对外导出不变）：仅机械搬迁，未改动任何语句与常量。
 */
import { computeProjectId } from '@customize-agent/knowledge';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBoqChunksFromKb, mergeBillOfQuantitiesResults, parseBillOfQuantities, pickBillOfQuantityFiles } from '../billOfQuantitiesParser';
import type { BillOfQuantitiesResult, BoqEntry } from '../billOfQuantitiesParser';
import { extractSpecTokens } from '../billFactLock';
import type { CanonicalFactModel } from '../types';
import type { BlueprintQuantity, BlueprintRedLineFact } from './types';

// ═══════════════════════════════ 阶段 0：资料解析（确定性，零 LLM） ═══════════════════════════════

/** 解析项目绑定资料中的工程量清单（串项目隔离：只从 boundFilePaths 中识别清单文件）。
 * 一个标段可绑定多个清单文件（每文件一个单位工程，招标实务常态）——全部解析后合并，
 * 不再取首个解析成功文件返回（历史缺陷：舒城一标段 13 份单位工程清单只用了 1 份） */
export function resolveBillOfQuantities(input: { projectRoot: string; boundFilePaths: string[] }): { boq?: BillOfQuantitiesResult; warning?: string } {
  const candidates = pickBillOfQuantityFiles(input.boundFilePaths);
  if (candidates.length === 0) return { warning: `绑定资料中未识别到工程量清单 .xls 文件（${input.boundFilePaths.length} 份资料）` };
  const dbPath = path.join(os.homedir(), '.customize-agent', 'projects', computeProjectId(path.resolve(input.projectRoot)), 'kb.db');
  if (!fs.existsSync(dbPath)) return { warning: `项目知识库索引不存在：${dbPath}` };
  const failures: string[] = [];
  const parsed: Array<{ filePath: string; boq: BillOfQuantitiesResult }> = [];
  for (const filePath of candidates) {
    try {
      const chunks = loadBoqChunksFromKb(dbPath, filePath);
      if (chunks.length === 0) {
        failures.push(`${filePath}（索引无切片）`);
        continue;
      }
      const boq = parseBillOfQuantities({ chunks, sourceFile: filePath });
      if (boq.totalEntries > 0) parsed.push({ filePath, boq });
      else failures.push(`${filePath}（解析出 0 条目）`);
    } catch (error) {
      failures.push(`${filePath}（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  if (parsed.length === 0) return { warning: `清单解析失败：${failures.join('；')}` };
  const boq = parsed.length === 1 ? parsed[0]!.boq : mergeBillOfQuantitiesResults(parsed);
  return failures.length > 0
    ? { boq, warning: `部分清单文件解析失败（已并入其余 ${parsed.length} 份）：${failures.join('；')}` }
    : { boq };
}

// ═══════════════════════════════ 阶段 A：data 参数桶构建 ═══════════════════════════════

/** L1a：清单条目聚合为 quantities（按名称聚合，保留首条来源）。
 * V5 P1：分组明细（villageGroup/section）随聚合保留——value 仍为合计（现有消费方零影响），
 * groups 供权威索引做分村合法性判定与跨工程同值复制检测。
 * R20：规格-数量拆分（specBreakdown）随聚合保留——同名条目跨规格（如「一般路灯」100W/120W）时
 * 按特征描述规格 token 分组小计（值=名称合计的共享规格组过滤、≥2 组才保留），供写作逐项照抄与
 * 规格-数量绑定断言（P0 根因：按名称聚合丢失规格维度 → 「100W 共118套」全部 token 命中漏网）。 */
export function deriveQuantitiesFromBoq(boq: BillOfQuantitiesResult): Record<string, BlueprintQuantity> {
  interface NamedQuantityAgg {
    value: number;
    unit: string;
    sourceFile: string;
    seq: number;
    total: number;
    groupTotals: Map<string, number>;
    specTotals: Map<string, number>;
  }
  const byName = new Map<string, NamedQuantityAgg>();
  for (const entry of boq.entries) {
    if (!entry.name) continue;
    const group = (entry.villageGroup || entry.section || '').trim();
    const specTokens = extractSpecTokens(entry.description || '');
    const existing = byName.get(entry.name);
    if (existing) {
      existing.total += entry.quantity;
      if (group) existing.groupTotals.set(group, (existing.groupTotals.get(group) ?? 0) + entry.quantity);
      for (const spec of specTokens) existing.specTotals.set(spec, (existing.specTotals.get(spec) ?? 0) + entry.quantity);
    } else {
      const groupTotals = new Map<string, number>();
      if (group) groupTotals.set(group, entry.quantity);
      const specTotals = new Map<string, number>();
      for (const spec of specTokens) specTotals.set(spec, (specTotals.get(spec) ?? 0) + entry.quantity);
      byName.set(entry.name, { value: entry.quantity, unit: entry.unit, sourceFile: entry.sourceFile, seq: entry.seq, total: entry.quantity, groupTotals, specTotals });
    }
  }
  const result: Record<string, BlueprintQuantity> = {};
  for (const [name, item] of byName) {
    const round3 = (value: number) => Math.round(value * 1000) / 1000;
    const groups = [...item.groupTotals.entries()].map(([group, value]) => ({ group, value: round3(value) }));
    const total = round3(item.total);
    // 规格拆分：剔除值=名称合计的共享规格组（如全组同为「高4.5m」无拆分信息量，保留会误判合计句）；
    // 浮点容差比较——round3 后与合计仍可能有 1e-9 级差
    const specBreakdown = [...item.specTotals.entries()]
      .map(([spec, value]) => ({ spec, value: round3(value) }))
      .filter(split => Math.abs(split.value - total) > 1e-6)
      .sort((left, right) => right.value - left.value);
    result[name] = {
      value: total,
      unit: item.unit,
      sourceFile: item.sourceFile,
      seq: item.seq,
      groups: groups.length > 0 ? groups : undefined,
      specBreakdown: specBreakdown.length >= 2 ? specBreakdown : undefined,
    };
  }
  return result;
}

/** 红线事实提取规则：key → 清单特征关键词（值从清单条目特征描述原文提取，提取不到不写入） */
const RED_LINE_EXTRACTORS: Array<{ key: string; namePattern: RegExp; extract: (entry: BoqEntry) => string | undefined; amount?: boolean }> = [
  {
    key: '绿化养护期',
    namePattern: /养护/u,
    extract: entry => {
      const match = /(?:一级|二级)养护[^。；;]{0,20}/u.exec(entry.description);
      return match ? match[0].trim() : undefined;
    },
  },
  {
    key: '喷播草籽种类',
    namePattern: /喷播|草籽/u,
    extract: entry => {
      // 原文直取（不依赖品种词表）：清单特征「籽种类」条款值原样提取（键形「草（灌木）籽种类」等通用形态）
      const clause = extractFeatureClauses(entry.description).find(item => /籽/u.test(item.key));
      if (!clause) return undefined;
      // 条款编号尾注裁剪（特征文本无换行时 value 可能吞入下一条款「2．养护期：…」）
      return clause.value.replace(/\s*\d+\s*[．.].*$/u, '').trim() || clause.value.trim();
    },
  },
  {
    key: '池塘清淤深度',
    namePattern: /清淤|清塘/u,
    extract: entry => {
      const match = /(?:清淤深度|深度)[^。；;]*?(\d+(?:\.\d+)?)\s*m/u.exec(entry.description);
      return match ? `清淤深度 ${match[1]}m` : undefined;
    },
  },
  {
    key: '过路涵涵头混凝土',
    namePattern: /涵头|过路涵/u,
    extract: entry => {
      const match = /(C\d{2})[^。；;]*混凝土/u.exec(entry.description) || /混凝土[^。；;]*(C\d{2})/u.exec(entry.description);
      return match ? `涵头混凝土 ${match[1]}` : undefined;
    },
  },
  {
    key: '路肩土预留',
    namePattern: /路肩/u,
    extract: entry => {
      const match = /(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*m/u.exec(entry.description);
      return match ? `两侧各预留 ${match[1]}-${match[2]}m` : undefined;
    },
  },
  {
    key: '一般路灯',
    namePattern: /路灯/u,
    extract: entry => {
      const watt = /(\d+)\s*W/u.exec(entry.description);
      const height = /高\s*(\d+(?:\.\d+)?)\s*m/u.exec(entry.description);
      if (!watt && !height) return undefined;
      const parts = ['一般路灯'];
      if (watt) parts.push(`${watt[1]}W LED`);
      if (height) parts.push(`高${height[1]}m`);
      if (/含基础|含灯杆基础|灯杆基础/u.test(entry.description)) parts.push('含基础');
      return parts.join(' ');
    },
  },
  {
    key: '暂列金额',
    namePattern: /暂列金额/u,
    extract: entry => {
      const match = /(\d+(?:\.\d+)?)\s*万元/u.exec(entry.description);
      return match ? `${match[1]}万元` : undefined;
    },
    amount: true,
  },
];

/** L1a：红线事实从清单特征原文确定性提取（must_cite 进正文） */
export function extractRedLineFacts(boq: BillOfQuantitiesResult): BlueprintRedLineFact[] {
  const facts: BlueprintRedLineFact[] = [];
  for (const rule of RED_LINE_EXTRACTORS) {
    // 遍历候选条目直到某条 extract 成功（首条 namePattern 命中但 extract 失败时不放弃，继续找后续条目）
    for (const entry of boq.entries) {
      if (!rule.namePattern.test(`${entry.name} ${entry.description}`)) continue;
      const value = rule.extract(entry);
      if (!value) continue;
      facts.push({ key: rule.key, value, source: `清单条目 ${entry.seq}「${entry.name}」特征原文`, amount: rule.amount });
      break;
    }
  }
  return facts;
}

export function extractVillageCount(projectName: string, basicFacts: string): number {
  // 村名前缀修饰通用化（任意 ≤8 字修饰词，如「美丽宜居」「和美」）——不绑定具体项目名形态
  const projectMatch = /(\d+)\s*个[^，。；、\s\n]{0,8}?自然村/u.exec(projectName);
  if (projectMatch) return Number(projectMatch[1]);
  const factsMatch = /(\d+)\s*个[^，。；、\s\n]{0,8}?自然村/u.exec(basicFacts);
  return factsMatch ? Number(factsMatch[1]) : 0;
}

/** 材料规格权威（确定性提取）：清单条目名精确匹配 + 特征描述 C 标号众数——同材料不同部位允许不同规格，仅锁定同名条目主流规格 */
export function deriveSpecAuthoritiesFromBoq(boq: BillOfQuantitiesResult): Record<string, string> {
  const result: Record<string, string> = {};
  const cushionCodes = boq.entries
    .filter(entry => entry.name === '垫层')
    .map(entry => /C\d{2}/u.exec(entry.description)?.[0])
    .filter((code): code is string => Boolean(code));
  if (cushionCodes.length > 0) {
    const counts = new Map<string, number>();
    for (const code of cushionCodes) counts.set(code, (counts.get(code) || 0) + 1);
    result.cushion = [...counts.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))[0]![0];
  }
  return result;
}

/** L1a：决策锁（蓝图阶段 A 确定性提取，零 LLM 调用）。
 * 封闭工艺类目（垂直运输/模板等）+ 数据口径条目（总工期/劳动力峰值/自然村数量/核心工程量——
 * 写作层参数桶强制引用，正文与蓝图不一致由引用一致性检测器报 error）。 */

export function extractContractFromFacts(basicFacts: string, boq: BillOfQuantitiesResult): { totalDays: number; qualityStandard: string; pricingFile: string; estimatedAmount: number } {
  const totalDaysMatch = /(?<!节点)(?<!阶段)(?<!分项)(?<!关键)(?:计划工期|合同工期|工期总日历天数|工期控制|工期目标|总工期|工期)[^。；;\n]{0,12}?(\d{1,4})\s*个?\s*日历天/u.exec(basicFacts)
    || /(\d{1,4})\s*个?\s*日历天[^。；;\n]{0,8}?(?:总工期|倒排|分解|完成)/u.exec(basicFacts);
  const totalDays = totalDaysMatch ? Number(totalDaysMatch[1]) : 0;
  const qualityMatch = /质量(?:标准|要求)[^。；;\n]{0,20}?[：:]\s*([^。；;\n]{1,20})/u.exec(basicFacts) || /合格/u.exec(basicFacts);
  const qualityStandard = qualityMatch ? (qualityMatch[1] || '合格').trim() : '';
  // 造价文号形态通用化：{机构简称}价〔YYYY〕N号（如「合造价」「皖价」「皖建价」）——不绑定单一城市文号前缀
  const pricingMatch = /([\u4e00-\u9fa5]{1,6}?价〔\d{4}〕\d+号)/u.exec(basicFacts);
  const pricingFile = pricingMatch ? pricingMatch[1] : '';
  // 合同估算价（万元）：金额禁区提取（渲染仅限基本信息表例外，参数桶不渲染）
  const amountMatch = /(?:合同估算价|招标控制价|最高投标限价|项目总投资|投资估算|工程概算)[^。；;\n]{0,20}?([\d,]+(?:\.\d+)?)\s*万/u.exec(basicFacts);
  const estimatedAmount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : 0;
  void boq;
  return { totalDays, qualityStandard, pricingFile, estimatedAmount };
}

/** 编制依据法规清单（确定性提取）：从招标文件/基本事实文本提取书名号法规名及文号形态，
 * 去重、过滤通知/意见类事务性文件、限 14 条。丰乐镇实测：招标文件含《建设工程质量管理条例》
 * 《保障农民工工资支付条例》（国令第724号）《合肥市公共资源交易管理条例》等，提取后注入
 * 编制依据小节，正文不再空写「国家现行法律、行政法规」类别话术。 */
export function extractBasisRegulations(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  // 书名号法规 + 就近文号（国令第N号/令第N号/〔YYYY〕N号；全/半角括号同构消费完整后缀）
  const bookRe = /《([^《》]{2,40}(?:法|条例|办法|规程|规范|标准))》(?:[（(][^）)]{0,24}?(?:国令|令|主席令|〔\d{4}〕)[^）)]{0,24}?[)）])?/gu;
  for (const match of text.matchAll(bookRe)) {
    // PDF 跨行截断清洗：书名号内换行/空白/markdown 标题符号为截断残迹（丰乐镇实测
    // 「中华人民共和国招标投标法实\n\n### 施条例」→ 清洗为「实施条例」）
    const raw = match[1].replace(/[\s#]/gu, '').trim();
    // 过滤：排除事务性通知/意见与跨行截断残名（截断错序清洗后会产生超长错字残名，如
    // 「工程建要求设领域农民工工资专用账户管理暂行办法」，法规名正常不超过 20 字）
    if (/通知|意见|公示|公告/u.test(raw)) continue;
    if (raw.length < 4 || raw.length > 20) continue;
    const suffix = (match[0].match(/[（(]([^）)]{0,24}?(?:国令|令|主席令|〔\d{4}〕)[^）)]{0,24}?)[)）]/u) || [])[1];
    const item = suffix ? `《${raw}》（${suffix.trim()}）` : `《${raw}》`;
    if (seen.has(item)) continue;
    seen.add(item);
    found.push(item);
    if (found.length >= 14) break;
  }
  return found;
}

/** 建设地点提取（基本事实文本；地方性法规与气候口径匹配的输入） */
export function extractLocationFromFacts(basicFacts: string): string {
  if (!basicFacts) return '';
  // [ \t] 不吞换行；非贪婪+前瞻在下一字段词（工期等）或分隔符处截断：跨行贪婪会把下一行字段文本误捕为地点
  const match = /建设地点[：: \t|]*([^。；;\n|]{2,40}?)(?=[，,。；;\n|]|工期|质量标准|合同估算)/u.exec(basicFacts);
  if (!match) return '';
  return match[1].trim().replace(/[，,、\s]+$/gu, '');
}

/** 国家法律法规确定性清单已移除（十度实测缺陷治理决策）：法规/条例/规范由写作模型依据行业
 * 公共知识自行列写，不得喂确定性清单；稳定性由交付前检测 basisRegulationsCoverageIssues 兑底。 */

/** 阶段 A 主入口：data 参数桶构建（L1a 直填 / L1b 参考资产 / L2 区间推导 / L3 确定性组织规划）；
 * strategy 必传（由 resolveDerivationStrategy 解析），不设隐式默认组，避免策略组静默错配 */

/** 特征描述条款提取：「N．关键词：值」形态（清单项目特征原文直填，不改写数值） */
export function extractFeatureClauses(description: string): Array<{ key: string; value: string }> {
  const clauses: Array<{ key: string; value: string }> = [];
  const pattern = /(?:\d+|[一二三四五六七八九十]+)[．.、]\s*([^：:；;。]{1,40}?)[：:]\s*([^。；;\n]{1,80})/gu;
  for (const match of description.matchAll(pattern)) {
    const key = match[1].trim();
    const value = match[2].trim();
    if (/具体详见|其他|满足验收/u.test(key)) continue;
    // 留白类特征值（「N．建筑物檐口高度、层数：详见图纸」）不构成可用参数：跳过，避免留白文字
    // 进入工作包参数与表格被照抄成数据行（舒城第二轮实测：8 处「檐口高度、层数详见图纸」）
    if (/(?:(?:详)?见|按)(?:设计|施工)?图纸|招标文件补疑/u.test(value)) continue;
    if (key && value) clauses.push({ key, value });
  }
  return clauses;
}

/** 做法短语提取：特征描述中含施工动作的条款（「人机配合下管」「含模板、养护、刻痕」类） */
export function extractMethodPhrases(entries: BoqEntry[]): string[] {
  const phrases: string[] = [];
  for (const entry of entries) {
    const clauses = extractFeatureClauses(entry.description);
    for (const clause of clauses) {
      if (/含|配合|安装|铺设|浇筑|夯实|碾压|养护|刻痕|拉毛|切缝|灌缝|喷播|栽植|回填|吊装|固定/u.test(clause.value) && clause.value.length <= 60) {
        phrases.push(`${entry.name}：${clause.value}`);
      }
    }
  }
  return [...new Set(phrases)].slice(0, 20);
}

/** 值尾部编号粘连检测（与 scoreFactCandidate 拒收同口径）：「90日历天2.9」形态的 PDF 编号串行残留 */
const TRAILING_CLAUSE_NOISE_RE = /(?<=[日天])\s*[0-9]+(?:\.[0-9]+)?(?=[\s]*(?:招标|建设|质量|合同|项目|工程|资金|投标|开标|评标|付款|工期|开工|计划|计价|现场|资质|标段|[0-9]{1,3}[.、．]|[，,。；;]|$))/u;

/** 渲染 canonical 基本事实为紧凑文本（蓝图构建输入：建设规模/总工期/质量标准等口径来源；
 * 三期收口：原 planDataMaster.renderBasicFactsForMaster 移入蓝图模块） */
export function renderBasicFactsForBlueprint(canonical: CanonicalFactModel): string {
  const entries = Object.values(canonical.byKey || {})
    .filter(fact => Boolean(fact && fact.label && fact.value))
    .sort((left, right) => (right.priority || 0) - (left.priority || 0));
  if (entries.length === 0) return '';
  return entries.slice(0, 60).map(fact => {
    // 蓝图输入源头清洗：值尾部编号粘连（PDF 编号串行残留）截断到干净段，
    // 防止「90日历天2.9招标范围：…」污染总工期/合同估算价提取（信息表污染同源根因）
    const value = String(fact.value);
    const noise = TRAILING_CLAUSE_NOISE_RE.exec(value);
    const cleaned = noise ? value.slice(0, noise.index).trim() : value;
    return `- ${fact.label}：${cleaned}`;
  }).join('\n');
}

/** 项目名称提取（basicFacts 中的「项目名称：」口径，提取不到用模板名兜底）。
 * P3.6 源头根治：资料目录带「9.14--」类序号前缀会被事实池带入项目名称口径，
 * 仅当序号前缀后紧跟 4 位年份才剥离（防误伤「9-3小区」类合法项目名）。 */
export function extractProjectName(basicFacts: string, templateName?: string): string {
  const stripIndexPrefix = (text: string): string => text.replace(/^\d+(?:\.\d+)*\s*--\s*(?=\d{4}年)/u, '');
  const match = /项目名称[：:]\s*([^\n]{2,60})/u.exec(basicFacts);
  if (match) {
    const raw = stripIndexPrefix(match[1].trim());
    // 截断到后续字段关键词（basicFacts 为单行串时防止吞入工期/质量等字段；
    // 「计划工期」须在「工期」前匹配，否则「计划」两字残留在项目名尾部）
    const cut = raw.split(/计划工期[：:]|合同工期[：:]|总工期[：:]|工期[：:]|质量标准[：:]|计价[：:]|施工地点/u)[0]?.trim() || raw;
    if (cut) return cut;
  }
  const yearMatch = /(\d{4}\s*年度\S{2,40}建设项目)/u.exec(basicFacts);
  if (yearMatch) return stripIndexPrefix(yearMatch[1].trim());
  return templateName || '';
}
