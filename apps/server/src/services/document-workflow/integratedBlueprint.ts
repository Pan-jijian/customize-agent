import { computeProjectId } from '@customize-agent/knowledge';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { majorConstructionSkeletonNames, parseMajorConstructionPackages } from './chapterPostProcessing';
import type { ChapterIntentClassifier } from './chapterIntentClassifier';
import type { CanonicalFactModel, DocumentEvidence, DocumentFact, DocumentGenerationDiagnostics, ValidationIssue } from './types';
import { cleanPdfHeadingNoise } from './factsModel';
import { stringifyFactValue, normalizeSubsectionTitleForDedup, workPackageThemeLabel } from './utils';
import { composeBlockTitle, disambiguateBlockTitles } from './sectionNamingGovernance';
import { parseChineseNumber } from './budget';
import { DIVISION_SECTION_RE, MAJOR_CONTENT_SECTION_RE, THREE_SOURCE_WRITE_RULES, isCriticalSectionTitle } from './writingSpec';
import { loadBoqChunksFromKb, mergeBillOfQuantitiesResults, parseBillOfQuantities, pickBillOfQuantityFiles } from './billOfQuantitiesParser';
import type { BillOfQuantitiesResult, BoqEntry } from './billOfQuantitiesParser';
import { matchProcessKnowledgeCards, PROCESS_KNOWLEDGE_CARDS } from './constructionProcessKnowledge';
import { validateJsonAgainstSchema } from './llmClient';
import type { DocumentJsonSchema } from './llmClient';
import { buildAuthorityIndex, renderAuthorityDomains, type AuthorityDomain } from './authorityIndex';
import { generatedRoot } from '../document-core/generatedDocumentService';
import { bridgeTunnelStrategy, buildingStrategy, climateForZone, generalStrategy, highwayStrategy, resolveClimateByLocation, resolveDerivationStrategy, villageMunicipalStrategy, waterConservancyStrategy, type BlueprintDerivationStrategy, type LaborQuotaRow } from './blueprintDerivationStrategies';

/**
 * 施工组织设计一体化蓝图（一期旁路版）：
 * 生成前一次性产出整篇文档的结构化蓝图 JSON——大纲、量化数据、工序链、工艺参数、
 * 劳动力配置、机械选型、施工方法全部锁定；冻结后各章节智能体只读蓝图切片展开正文。
 *
 * 数据四来源模型：
 * - L1a material：项目资料直填（清单解析产物确定性直填，零 LLM）；
 * - L1b standard：参考文档资产规划（读取模板参考库标准板块参考文档 + 确定性规则判定，
 *   如危大判定按 37 号令阈值规则与清单挖深数据；读不到的内容标记缺口，不凭记忆编造）；
 * - L2 derived：计划推导（清单汇总 + 经验区间系数推导，定额工效知识不全时降级为区间表达，
 *   不硬锁具体值）；一期为确定性区间推导，LLM 初稿优化二期接入；
 * - L3 组织规划：施工部署/重难点（一期确定性归纳，锚定清单村分组与资料特征原文；LLM 规划二期接入）。
 *
 * 三期收口定位：旧 planDataMaster/decisionLock 管线已删除，蓝图是唯一计划类数值权威源——
 * 构建蓝图、落盘 assets/blueprint.json、打印诊断；任何阶段失败沿确定性回退继续，永不阻断生成。
 */

// ═══════════════════════════════ 类型定义 ═══════════════════════════════

export interface BlueprintMeta {
  version: string;
  projectCode?: string;
  docType: string;
  createdAt: string;
  sourceMaterials: string[];
}

export interface BlueprintProject {
  name: string;
  scope: string;
  works: string[];
  /** 建设地点（基本事实提取，用于地方性法规/气候口径匹配） */
  location?: string;
}

export interface BlueprintContract {
  totalDays: number;
  qualityStandard: string;
  pricingFile: string;
  /** 合同估算价（万元）：造价锚定校验与劳动力量级窗口的锚点；商务禁区，参数桶不渲染，仅基本信息表例外 */
  estimatedAmount?: number;
}

export interface BlueprintClimate {
  rainySeason?: string;
  highTemp?: string;
  winter?: string;
}

export interface BlueprintMilestone {
  key: string;
  label: string;
  duration?: number;
  basis: string;
}

export interface BlueprintLabor {
  /** 劳动力峰值区间（推导过程口径，定额工效知识不全 → 区间表达） */
  peak: { min: number; max: number };
  /** 全项目唯一劳动力峰值口径（区间中值收敛，决策锁与写作层只引用该值，不得自设其他峰值） */
  peakValue: number;
  peakBasis: string;
  byPhase: Array<{ phase: string; min?: number; max?: number; basis: string }>;
  byTrade: Array<{ trade: string; min?: number; max?: number; basis: string }>;
  /** 工种构成唯一口径：按工种工程量区间中值比例收敛，合计恒等于 peakValue
   * （写作层工种表唯一数据源；区间中值之和与峰值自相矛盾是丰乐镇三套矛盾口径根因） */
  composition: Array<{ trade: string; count: number; basis: string }>;
}

export interface BlueprintEquipmentItem {
  name: string;
  spec?: string;
  quantity?: number;
  min?: number;
  max?: number;
  basis: string;
}

export interface BlueprintMaterialPlanItem {
  name: string;
  quantity?: number;
  unit: string;
  /** 清单明确给出的型号/规格/参数（混凝土强度等级/管径/功率/厚度/尺寸，确定性提取；写作层必须原样引用，不得自编规格） */
  spec?: string;
  batchDesc?: string;
  basis: string;
}

export interface BlueprintFundPlan {
  wageRule: string;
  usagePlan: string;
}

export interface BlueprintTestPlanItem {
  scope: string;
  count?: number;
  basis: string;
}

export interface BlueprintEarthworkBalance {
  excavation?: number;
  backfill?: number;
  disposal?: number;
  basis: string;
}

export interface BlueprintTempUtilities {
  powerLoad: string;
  waterUsage: string;
}

export interface BlueprintRedLineFact {
  key: string;
  value: string;
  /** 依据（清单特征原文/资料证据） */
  source: string;
  /** 金额类红线事实：商务禁区，渲染正文时跳过（合同估算价例外） */
  amount?: boolean;
}

/** 决策锁条目（三期收口：原 decisionLock.ts 类型移入蓝图模块；数据一致性检测器按条目 id 取同类目元数据） */
export interface DecisionLockEntry {
  id: string;
  label: string;
  values: string[];
}

/** 类目元数据（锁构建与语义矛盾检测器同源比对：relevance/options/否定口径单一事实源） */
export interface DecisionCategoryMeta {
  id: string;
  label: string;
  relevance: RegExp;
  options: Array<{ value: string; aliases: RegExp }>;
  /** 互斥类目：取值物理互斥（模板体系/混凝土供应/基坑支护），多值共存时只能锁最高分唯一值 */
  exclusive?: boolean;
}

export interface BlueprintDecisionLock {
  entries: DecisionLockEntry[];
}

export interface BlueprintQuantity {
  value: number;
  unit: string;
  sourceFile?: string;
  seq?: number;
  /** 分村/分工程明细（V5 P1：同名条目按 villageGroup/section 分组的分项值；value=全部合计）。
   * 分村多值合法性判定与跨工程同值复制检测的依据（探测到分组值才算合法分层口径） */
  groups?: Array<{ group: string; value: number }>;
}

export interface BlueprintInspectionBatch {
  scope: string;
  planDesc: string;
}

export interface BlueprintStandardBlock {
  id: string;
  title: string;
  /** 内容来源（参考文档资产文件名） */
  source: string;
  items: string[];
  note?: string;
  /** 缺口标记：参考文档未覆盖的内容，二期由规划 LLM 读取其他资料规划 */
  gap?: boolean;
}

export interface BlueprintDeployment {
  sections: Array<{ name: string; basis: string }>;
  sequence: string;
  sequenceBasis: string;
  flow: string;
}

export interface BlueprintDifficulty {
  name: string;
  measure: string;
  basis: string;
}

export interface BlueprintData {
  project: BlueprintProject;
  contract: BlueprintContract;
  climate: BlueprintClimate;
  milestones: BlueprintMilestone[];
  resources: {
    labor: BlueprintLabor;
    equipment: BlueprintEquipmentItem[];
  };
  materialsPlan: BlueprintMaterialPlanItem[];
  fundPlan: BlueprintFundPlan;
  testPlan: BlueprintTestPlanItem[];
  earthworkBalance: BlueprintEarthworkBalance;
  tempUtilities: BlueprintTempUtilities;
  /** L1a 评审红线事实专项（外部评审高危点，must_cite 进正文；amount 条目不进正文） */
  redLineFacts: BlueprintRedLineFact[];
  /** 金额禁区规则：金额类数据禁入正文（合同估算价例外） */
  amountRule: string;
  decisionLock: BlueprintDecisionLock;
  /** L1a 清单条目聚合（名称 → 数量口径） */
  quantities: Record<string, BlueprintQuantity>;
  /** L1a 材料规格权威（清单同名条目特征 C 标号众数，跨章规格错位确定性修复依据） */
  specAuthorities: Record<string, string>;
  inspectionBatches: BlueprintInspectionBatch[];
  /** L1b 标准板块（参考文档资产读取 + 规则判定） */
  standardBlocks: BlueprintStandardBlock[];
  /** L3 施工部署 */
  constructionDeployment: BlueprintDeployment;
  /** L3 重难点逐项列明（十项评审⑩硬要求） */
  keyDifficulties: BlueprintDifficulty[];
  /** 编制依据法规清单（从招标文件/基本事实确定性提取书名号法规及文号，注入编制依据小节；
   * 提取为空时写作层降级公共知识法规清单） */
  basisRegulations: string[];
  drawingNote: string;
}

export interface BlueprintRequiredParam {
  path: string;
  mode: 'must_cite' | 'may_reference';
  strict?: boolean;
}

export interface BlueprintWorkPackageQuantity {
  value: number;
  unit: string;
}

export interface BlueprintWorkPackage {
  name: string;
  kind: 'major' | 'general';
  quantities: Record<string, BlueprintWorkPackageQuantity>;
  /** L1：清单条目原序归纳的工序链 */
  processChain: string[];
  /** L1：清单项目特征原文做法 */
  methods: string[];
  /** L1：清单特征参数原文 + 知识卡补（标注来源） */
  params: Array<{ key: string; value: string; source: 'boq' | 'knowledge_card' }>;
  /** L1：验收要求（清单特征 + 知识卡补） */
  acceptance: string[];
  /** L1：规范/图集（清单特征提取 + 知识卡补） */
  standards: string[];
  /** 内容来源：boq=清单原文归纳 / knowledge_card=知识卡补 / fallback=现有解析产物回退 */
  source: 'boq' | 'knowledge_card' | 'fallback';
  /** 该工作包覆盖的清单条目序号（覆盖校验：清单条目零丢失） */
  coveredSeqs: number[];
}

export interface BlueprintSubSection {
  id: string;
  title: string;
  targetWords?: number;
  requiredParams: BlueprintRequiredParam[];
  scoredItems: string[];
  tablePlans: string[];
  workPackages: BlueprintWorkPackage[];
}

export interface BlueprintChapter {
  id: string;
  title: string;
  isActive: boolean;
  requiredParams: BlueprintRequiredParam[];
  scoredItems: string[];
  subSections: BlueprintSubSection[];
}

export interface BlueprintOutline {
  chapters: BlueprintChapter[];
}

/** P14 蓝图分层权威 id：蓝图参数桶按权威粒度提供可用性（per-check 映射），替代二元 passed 的数值密集章阻断判定 */
export type BlueprintAuthorityId = 'laborPeak' | 'schedule' | 'blueprint';

export interface BlueprintValidationReport {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; message: string }>;
  /** P14 per-check 权威可用性映射：某道校验失败只使依赖它的权威不可用（如劳动力区间异常
   * 仅 laborPeak 不可用，进度/资源章仍可放行）；缺省（旧数据/占位构造）消费端视为全不可用（保守阻断） */
  authorityAvailability?: Record<BlueprintAuthorityId, boolean>;
}

export interface BlueprintBuildDiagnostics {
  stage: string;
  boq?: { sourceFile: string; totalEntries: number; complete: boolean; villageCount: number; pagesMissingTotal: number };
  standardBlocksLoaded: number;
  standardBlockGaps: string[];
  laborDerivationBasis: string;
  llmCalls: number;
  fallbackUsed: string[];
  warnings: string[];
  durationMs: number;
}

export interface IntegratedBlueprint {
  meta: BlueprintMeta;
  data: BlueprintData;
  outline: BlueprintOutline;
  validation: BlueprintValidationReport;
  diagnostics: BlueprintBuildDiagnostics;
}

/** 构建输入（documentGenerator 旁路调用） */
export interface BuildIntegratedBlueprintInput {
  projectRoot: string;
  /** 绑定资料相对路径（串项目隔离：清单文件只从绑定资料中识别） */
  boundFilePaths: string[];
  /** 有效章节目录（模板 chapters） */
  chapterTitles: string[];
  templateName?: string;
  /** 项目基本事实（canonical 渲染文本，提取工期/质量/计价口径） */
  basicFacts?: string;
  /** 写作证据（决策锁/危大判定数据源） */
  evidence?: DocumentEvidence[];
  /** 事实池（决策锁输入） */
  facts?: DocumentFact[];
  signal?: AbortSignal;
  diagnostics?: DocumentGenerationDiagnostics;
}

/** 蓝图版本与文档类型 */
export const BLUEPRINT_VERSION = '2.0.0';
export const BLUEPRINT_DOC_TYPE = '单位工程施工组织设计';
/** 金额禁区规则（渲染层与校验层共用口径） */
export const BLUEPRINT_AMOUNT_RULE = '商务禁区延续：金额类数据禁入正文（合同估算价例外），fund_plan/red_line_facts 渲染时遵守';

// ═══════════════════════════════ JSON Schema（轻量 schema，与 draft-07 语义对齐） ═══════════════════════════════

export const BLUEPRINT_JSON_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['meta', 'data', 'outline'],
  properties: {
    meta: { type: 'object', required: true, properties: { version: { type: 'string', required: true, minLength: 1 }, docType: { type: 'string', required: true, minLength: 1 }, createdAt: { type: 'string', required: true, minLength: 1 }, sourceMaterials: { type: 'array', required: true, items: { type: 'string' } } } },
    data: {
      type: 'object',
      required: true,
      properties: {
        project: { type: 'object', required: true, properties: { name: { type: 'string', required: true, minLength: 1 }, scope: { type: 'string', required: true }, works: { type: 'array', required: true, items: { type: 'string' } } } },
        contract: { type: 'object', required: true, properties: { totalDays: { type: 'number', required: true }, qualityStandard: { type: 'string', required: true }, pricingFile: { type: 'string', required: true } } },
        milestones: { type: 'array', required: true, minItems: 1, items: { type: 'object' } },
        resources: { type: 'object', required: true, properties: { labor: { type: 'object', required: true }, equipment: { type: 'array', required: true } } },
        materialsPlan: { type: 'array', required: true },
        redLineFacts: { type: 'array', required: true },
        quantities: { type: 'object', required: true },
        standardBlocks: { type: 'array', required: true },
        keyDifficulties: { type: 'array', required: true, minItems: 1 },
      },
    },
    outline: { type: 'object', required: true, properties: { chapters: { type: 'array', required: true, minItems: 1 } } },
  },
};

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
 * groups 供权威索引做分村合法性判定与跨工程同值复制检测 */
export function deriveQuantitiesFromBoq(boq: BillOfQuantitiesResult): Record<string, BlueprintQuantity> {
  interface NamedQuantityAgg {
    value: number;
    unit: string;
    sourceFile: string;
    seq: number;
    total: number;
    groupTotals: Map<string, number>;
  }
  const byName = new Map<string, NamedQuantityAgg>();
  for (const entry of boq.entries) {
    if (!entry.name) continue;
    const group = (entry.villageGroup || entry.section || '').trim();
    const existing = byName.get(entry.name);
    if (existing) {
      existing.total += entry.quantity;
      if (group) existing.groupTotals.set(group, (existing.groupTotals.get(group) ?? 0) + entry.quantity);
    } else {
      const groupTotals = new Map<string, number>();
      if (group) groupTotals.set(group, entry.quantity);
      byName.set(entry.name, { value: entry.quantity, unit: entry.unit, sourceFile: entry.sourceFile, seq: entry.seq, total: entry.quantity, groupTotals });
    }
  }
  const result: Record<string, BlueprintQuantity> = {};
  for (const [name, item] of byName) {
    const round3 = (value: number) => Math.round(value * 1000) / 1000;
    const groups = [...item.groupTotals.entries()].map(([group, value]) => ({ group, value: round3(value) }));
    result[name] = { value: round3(item.total), unit: item.unit, sourceFile: item.sourceFile, seq: item.seq, groups: groups.length > 0 ? groups : undefined };
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
      const match = /(?:草籽|种子)[^。；;]*?(?:荷兰菊|紫花地丁|白三叶)[^。；;]*/u.exec(entry.description);
      if (match) return match[0].replace(/^[^：:]*[：:]?/u, '').trim();
      const alt = /(?:荷兰菊|紫花地丁|白三叶)[^。；;]*/u.exec(entry.description);
      return alt ? alt[0].trim() : undefined;
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

/** L1a：红线事实从清单特征原文确定性提取（外部评审高危点，must_cite 进正文） */
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

/** L2 推导参数已迁出至 blueprintDerivationStrategies 策略表（工程类型注册制）：
 * 工种映射/工效系数/条目归类/里程碑分组/机械映射/功率表/检验批规则/重难点模板
 * 全部按策略组取用；缺省参数 = village-municipal（历史村域口径），新链路必须显式传策略。 */

/**
 * L2 造价锚定劳动力量级窗口（丰乐镇第 3 轮实测根治）：招标条款「投标报价总人工费与技术
 * 文件劳动力安排计划总人工费不得明显过低」——劳动力峰值必须以合同估算价为锚推导量级窗口：
 * 总人工费区间 = estimatedAmount × 人工费占比（按工程类型策略组取口径，市政/绿化 15%~25%、
 * 房建 18%~30%，合造价〔2022〕8号下限口径）；
 * 总工日区间 = 人工费区间 ÷ 综合工日单价；日均人数 = 总工日 ÷ 有效工期；
 * 峰值区间 = 日均 × 峰值系数 [1.3, 1.6]。1100 万锚定：峰值 ≈ [80, 229] 人。
 */
export function deriveCostAnchoredLaborWindow(estimatedAmountWan: number, effectiveDays: number, strategy: BlueprintDerivationStrategy = villageMunicipalStrategy): { min: number; max: number; detail: string } {
  const { laborCostRatio, dailyWage } = strategy;
  const peakFactor = { min: 1.3, max: 1.6 };
  const days = Math.max(30, Math.round(effectiveDays));
  const laborCostMin = estimatedAmountWan * 10000 * laborCostRatio.min;
  const laborCostMax = estimatedAmountWan * 10000 * laborCostRatio.max;
  const workdaysMin = laborCostMin / dailyWage.max;
  const workdaysMax = laborCostMax / dailyWage.min;
  const min = Math.max(1, Math.round((workdaysMin / days) * peakFactor.min));
  const max = Math.max(min, Math.round((workdaysMax / days) * peakFactor.max));
  return {
    min,
    max,
    detail: `合同估算价 ${estimatedAmountWan} 万元 × 人工费占比 ${Math.round(laborCostRatio.min * 100)}%~${Math.round(laborCostRatio.max * 100)}% ÷ 综合工日单价 ${dailyWage.min}~${dailyWage.max} 元 ÷ 有效工期 ${days} 天 × 峰值系数 1.3~1.6`,
  };
}
export function deriveLaborFromBoq(boq: BillOfQuantitiesResult, totalDays: number, estimatedAmountWan = 0, milestones: BlueprintMilestone[] = [], strategy: BlueprintDerivationStrategy = villageMunicipalStrategy): BlueprintLabor {
  const days = totalDays > 0 ? totalDays : 360;
  const effectiveDays = Math.max(30, Math.round(days * 0.85));
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
      min: Math.max(1, Math.round((slot.min / effectiveDays) * 1.3)),
      max: Math.max(1, Math.round((slot.max / effectiveDays) * 1.6)),
      basis: slot.quota
        ? `工种工程量约 ${Math.round(slot.qty)}${slot.unit} × 定额工效（${slot.quota.subName} ${slot.quota.code}，${slot.quota.min}~${slot.quota.max} 工日/${slot.unit}）÷ 有效工期 ${effectiveDays} 天（定额知识库命中）`
        : `工种工程量约 ${Math.round(slot.qty)}${slot.unit} × 经验工效区间 ÷ 有效工期 ${effectiveDays} 天（定额工效知识不全，降级区间表达）`,
    }));
  const totalMin = byTradeResult.reduce((sum, item) => sum + (item.min || 0), 0);
  const totalMax = byTradeResult.reduce((sum, item) => sum + (item.max || 0), 0);
  // 工程量推导峰值（工种同期在场重叠折算）
  const qtyPeak = { min: Math.max(10, Math.round(totalMin * 0.75)), max: Math.max(10, Math.round(totalMax * 0.9)) };
  // 造价锚定交集（丰乐镇第 3 轮）：与合同估算价量级窗口取交集；无交集以造价锚定为准
  let peak = qtyPeak;
  let peakBasis = `各工种同期在场按 0.75~0.9 重叠系数折算（各工种人数区间之和 ${totalMin}~${totalMax} 人）`;
  if (estimatedAmountWan > 0) {
    const cost = deriveCostAnchoredLaborWindow(estimatedAmountWan, effectiveDays, strategy);
    const intersectMin = Math.max(qtyPeak.min, cost.min);
    const intersectMax = Math.min(qtyPeak.max, cost.max);
    if (intersectMin <= intersectMax) {
      peak = { min: intersectMin, max: intersectMax };
      peakBasis = `工程量推导区间 [${qtyPeak.min}, ${qtyPeak.max}] 与造价锚定区间 [${cost.min}, ${cost.max}] 的交集（${cost.detail}）`;
    } else {
      peak = { min: cost.min, max: cost.max };
      peakBasis = `工程量推导区间 [${qtyPeak.min}, ${qtyPeak.max}] 与造价锚定区间 [${cost.min}, ${cost.max}] 无交集，以造价锚定区间为准（${cost.detail}）`;
    }
  }
  // 峰值唯一口径：区间中值收敛为唯一值（决策锁/参数桶/引用一致性检测全部锚定该值，区间仅保留作推导依据）
  const peakValue = Math.round((peak.min + peak.max) / 2);
  // byPhase：按里程碑分组分桶（十项评审④分阶段计划表数据源，不再恒空）
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
    const duration = milestones.find(item => item.key === group.key)?.duration || Math.max(1, Math.round(effectiveDays / milestoneGroups.length));
    const min = Math.max(1, Math.round((phaseWorkdaysMin / duration) * 1.3));
    const max = Math.max(min, Math.round((phaseWorkdaysMax / duration) * 1.6));
    byPhase.push({
      phase: group.label,
      // 阶段同时在场人数按峰值封顶（丰乐镇实测景观绿化阶段推导 1119 人 > 峰值 176 人荒谬值；
      // 封顶后至少一个阶段达到峰值，与「分阶段投入最大值=峰值」的评审口径自洽）
      min: Math.min(min, peakValue),
      max: Math.min(max, peakValue),
      basis: `阶段条目工程量约 ${Math.round(phaseEntries.reduce((sum, entry) => sum + entry.quantity, 0))} × 经验工效区间 ÷ 阶段 ${duration} 天（不均匀系数 1.3~1.6，同时在场人数按峰值 ${peakValue} 人封顶）`,
    });
  }
  // 收尾阶段兑底：末段分部条目量少时不达劳动桶门槛（村域安装工程 unit「项」系数 0）该阶段被跳过，
  // 而收尾（零星收尾+撤场）是任何工程必经阶段——按峰值 20% 确定性兑底（阶段取策略组最后一组，阶段表不缺收尾行）
  const tailGroup = milestoneGroups[milestoneGroups.length - 1];
  if (byPhase.length > 0 && tailGroup && !byPhase.some(item => item.phase === tailGroup.label)) {
    const tail = Math.max(1, Math.round(peakValue * 0.2));
    byPhase.push({
      phase: tailGroup.label,
      min: tail,
      max: tail,
      basis: `收尾阶段零星作业兜底（峰值 ${peakValue} 人的 20%），不参与工日推导`,
    });
  }
  // 工种构成唯一口径：按工种区间中值比例收敛到合计=峰值（丰乐镇实测区间中值 97+72+1+1+102=273
  // 与峰值 176 自相矛盾——写作层忠实使用后 5.1 节与 5.4 节三套矛盾口径；floor 1 + 最大余数法分配）
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
export function deriveEquipmentFromBoq(boq: BillOfQuantitiesResult, strategy: BlueprintDerivationStrategy = villageMunicipalStrategy): BlueprintEquipmentItem[] {
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

/** L2：物资需用量计划 = 清单条目汇总（主要材料按名称聚合，十项评审②硬要求）；
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
export function deriveMilestonesFromBoq(boq: BillOfQuantitiesResult, totalDays: number, strategy: BlueprintDerivationStrategy = villageMunicipalStrategy): BlueprintMilestone[] {
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
    // 权重 0 兜底（丰乐镇第 3 轮：亮化分部工程量权重 0.0% → 1 天荒谬值；下限 2 天）
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
export function deriveInspectionBatchesFromBoq(boq: BillOfQuantitiesResult, strategy: BlueprintDerivationStrategy = villageMunicipalStrategy): BlueprintInspectionBatch[] {
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
export function deriveTempUtilitiesFromBoq(equipment: BlueprintEquipmentItem[], labor: BlueprintLabor, strategy: BlueprintDerivationStrategy = villageMunicipalStrategy): BlueprintTempUtilities {
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

/** L1b：读取标准板块参考文档资产（模板参考库，非代码常量；随政策更新人工维护） */
export function loadStandardBlockAssets(): Array<{ id: string; title: string; source: string; lines: string[] }> {
  const root = path.join(os.homedir(), '.customize-agent', 'template-references');
  const dir = path.join(root, 'files', 'standard-blocks');
  if (!fs.existsSync(dir)) return [];
  const index = path.join(root, 'standard-blocks.json');
  let ids: string[] = [];
  if (fs.existsSync(index)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(index, 'utf8')) as { blocks?: Array<{ id: string; file: string }> };
      ids = (parsed.blocks || []).map(block => block.id);
    } catch {
      ids = [];
    }
  }
  if (ids.length === 0) {
    ids = fs.readdirSync(dir).filter(name => name.endsWith('.md')).map(name => name.replace(/\.md$/u, ''));
  }
  return ids.flatMap(id => {
    const file = path.join(dir, `${id}.md`);
    if (!fs.existsSync(file)) return [];
    const content = fs.readFileSync(file, 'utf8');
    const title = (/^title:\s*(\S.*)$/mu.exec(content) || [])[1]?.trim() || id;
    const source = (/^source:\s*(\S.*)$/mu.exec(content) || [])[1]?.trim() || '';
    return [{ id, title, source, lines: content.split('\n').filter(Boolean) }];
  });
}

/** L1b：危大工程判定（读取 37 号令参考文档阈值规则 + 清单挖深数据；无深度数据标记待人工确认，不静默判定） */
export function judgeHazardousWorks(boq: BillOfQuantitiesResult, evidenceText: string): { items: string[]; conclusion: string; gap: boolean } {
  const items: string[] = [];
  // 基坑（槽）开挖深度：优先从资料证据中提取具体深度数值
  const depthMatches = [...evidenceText.matchAll(/(?:开挖深度|挖深|基坑深度|沟槽深度)[^。；;\n]{0,30}?(\d+(?:\.\d+)?)\s*m/gu)].map(match => Number(match[1]));
  const hasExcavation = boq.entries.some(entry => /挖一般土方|挖沟槽|挖基坑/u.test(entry.name));
  let conclusion: string;
  let gap = false;
  if (hasExcavation) {
    items.push('基坑（槽）土方开挖、降水——判定阈值：开挖深度超过3m（含3m）属危大工程，超过5m（含5m）属超过一定规模（须专家论证）');
    const maxDepth = depthMatches.length > 0 ? Math.max(...depthMatches) : undefined;
    if (maxDepth === undefined) {
      conclusion = '本项目含沟槽/基坑土方开挖，但资料（清单特征「挖土深度：详见设计图纸」）未给出具体开挖深度，危大等级判定待人工确认（不静默判定）';
      gap = true;
    } else if (maxDepth < 3) {
      conclusion = `资料确认最大开挖深度 ${maxDepth}m < 3m，未达危大工程阈值，按一般土方工程管控`;
    } else if (maxDepth < 5) {
      conclusion = `资料确认最大开挖深度 ${maxDepth}m，达到 3m（含）未达 5m，属危大工程，需编制专项施工方案（施工单位技术负责人审核签字、总监理工程师审查签字）`;
    } else {
      conclusion = `资料确认最大开挖深度 ${maxDepth}m ≥ 5m，属超过一定规模的危大工程，专项方案须专家论证（不少于5名符合专业要求的专家）`;
    }
  } else {
    conclusion = '本项目清单未含基坑（槽）土方开挖条目，基坑工程危大判定不涉及';
  }
  items.push('专家论证程序：超过一定规模的危大工程专项方案组织不少于5名符合专业要求的专家论证；修改后的方案由施工单位技术负责人审核签字、加盖单位公章，并由总监理工程师审查签字、加盖执业印章后方可实施');
  return { items, conclusion, gap };
}

/** L1b：标准板块构建（读取参考文档资产 + 确定性规则判定；读不到的板块标记缺口） */
export function buildStandardBlocks(boq: BillOfQuantitiesResult, evidenceText: string): { blocks: BlueprintStandardBlock[]; gaps: string[] } {
  const assets = loadStandardBlockAssets();
  const blocks: BlueprintStandardBlock[] = [];
  const gaps: string[] = [];
  for (const asset of assets) {
    // 参考文档正文条目：提取列表/编号条目行（跳过 front matter、标题、纯段落说明与 ## 使用规则区块）
    const bodyItems: string[] = [];
    let inHeadingBlock = false;
    for (const line of asset.lines) {
      if (line.startsWith('---') || /^(id|title|source|updatedAt|tags):/u.test(line)) continue;
      if (line.startsWith('# ')) continue;
      if (line.startsWith('## ')) {
        inHeadingBlock = true;
        continue;
      }
      if (inHeadingBlock) continue;
      const trimmed = line.trim();
      if (!/^[-*\d]+[.、]?\s+/u.test(trimmed)) continue; // 只收集列表条目行
      const cleaned = trimmed.replace(/^[-*\d]+[.、]?\s+/u, '').trim();
      if (cleaned) bodyItems.push(cleaned);
    }
    if (asset.id === 'hazardous-works-37') {
      const judgment = judgeHazardousWorks(boq, evidenceText);
      blocks.push({ id: 'hazardous_works', title: '危大工程判定', source: asset.source, items: [...judgment.items, `本项目判定结论：${judgment.conclusion}`], gap: judgment.gap });
    } else {
      blocks.push({ id: asset.id, title: asset.title, source: asset.source, items: bodyItems.slice(0, 30) });
    }
  }
  // 计划 L1b 板块清单中暂未建设参考文档的板块 → 标记缺口（二期由规划 LLM 读取其他资料规划）
  const plannedBlocks = ['organization', 'construction_prep', 'survey_plan', 'product_protection', 'emergency_plans', 'seasonal_measures', 'fire_control', 'tech_management', 'smart_site', 'handover_warranty', 'quality_innovation'];
  for (const id of plannedBlocks) {
    gaps.push(id);
    blocks.push({ id, title: id, source: '（缺口：参考文档资产未建设）', items: [], gap: true });
  }
  return { blocks, gaps };
}

/** L3：施工部署（锚定清单村分组与分部编排顺序；无村分组时按策略组兑底话术，不再输出村域话术） */
export function deriveConstructionDeployment(boq: BillOfQuantitiesResult, strategy: BlueprintDerivationStrategy = villageMunicipalStrategy): BlueprintDeployment {
  const villages = boq.villages.map(village => village.villageGroup);
  const sections = villages.map(name => ({ name, basis: '清单按自然村分组（工程名称）' }));
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

/** L3：重难点识别（逐项列明 + 每项配保证措施，十项评审⑩硬要求；模板按工程类型策略组取用，
 * 只写入有资料特征支撑的条目，零命中时通用兜底） */
export function deriveKeyDifficulties(boq: BillOfQuantitiesResult, strategy: BlueprintDerivationStrategy = villageMunicipalStrategy): BlueprintDifficulty[] {
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

// ═══════════════════════════════ 决策锁确定性提取（三期收口：原 decisionLock.ts 移入蓝图模块内部） ═══════════════════════════════
// 工艺路线/机械选型/材料供应这类"实体-选择"从 factsModel + 证据确定性提取封闭类目
// "项目关键决策表"：类目取值必须有证据支撑（否定句不计分），多源取值按来源权威度裁决
// （补疑/澄清 > 招标文件 > 清单/图纸 > 规范 > 其他，与 scopeConflicts 源级裁决口径同源），
// 同目多值共存（塔吊+施工电梯同属垂直运输）时全部锁定。

/** 封闭决策类目表：垂直运输/模板体系/混凝土供应/脚手架/基坑支护/土方外运 */
const DECISION_CATEGORIES: DecisionCategoryMeta[] = [
  {
    id: 'vertical_transport',
    label: '垂直运输方式',
    relevance: /塔吊|塔式起重机|施工电梯|施工升降机|物料提升机|垂直运输/u,
    options: [
      { value: '塔式起重机', aliases: /塔吊|塔式起重机/ },
      { value: '施工升降机', aliases: /施工电梯|施工升降机/ },
      { value: '物料提升机', aliases: /物料提升机/ },
      { value: '汽车式起重机', aliases: /汽车吊|汽车式起重机/ },
    ],
  },
  {
    id: 'formwork',
    label: '模板体系',
    relevance: /模板/u,
    exclusive: true,
    options: [
      { value: '木胶合板模板', aliases: /木胶合板|覆膜胶合板|胶合板模板|木模板/ },
      { value: '钢模板', aliases: /钢模板|定型钢模/ },
      { value: '铝合金模板', aliases: /铝合金模板|铝模/ },
      { value: '大模板', aliases: /大模板/ },
      { value: '爬升模板', aliases: /爬升模板|爬模/ },
    ],
  },
  {
    id: 'concrete_supply',
    label: '混凝土供应',
    relevance: /混凝土/u,
    exclusive: true,
    options: [
      { value: '商品混凝土（预拌）', aliases: /商品混凝土|预拌混凝土/ },
      { value: '自拌混凝土', aliases: /自拌混凝土|现场拌制混凝土|现场搅拌混凝土/ },
    ],
  },
  {
    id: 'scaffold',
    label: '脚手架体系',
    relevance: /脚手架|爬架/u,
    options: [
      { value: '落地式钢管脚手架', aliases: /落地式[^，。；;]{0,6}脚手架|落地脚手架/ },
      { value: '悬挑式脚手架', aliases: /悬挑[^，。；;]{0,6}脚手架|悬挑脚手架/ },
      { value: '附着式升降脚手架', aliases: /附着式升降脚手架|爬架/ },
      { value: '门式脚手架', aliases: /门式脚手架/ },
      { value: '盘扣式脚手架', aliases: /盘扣/ },
      { value: '碗扣式脚手架', aliases: /碗扣/ },
    ],
  },
  {
    id: 'foundation_support',
    label: '基坑支护形式',
    relevance: /基坑|支护/u,
    exclusive: true,
    options: [
      { value: '放坡开挖', aliases: /放坡/ },
      { value: '土钉墙支护', aliases: /土钉墙|土钉支护/ },
      { value: '灌注桩支护', aliases: /灌注桩|钻孔灌注桩|排桩支护/ },
      { value: '钢板桩支护', aliases: /钢板桩|拉森桩/ },
      { value: '地下连续墙', aliases: /地下连续墙|地连墙/ },
      { value: '锚杆（索）支护', aliases: /锚杆|锚索/ },
      { value: '喷锚支护', aliases: /喷锚/ },
    ],
  },
  {
    id: 'earthwork_haul',
    label: '土方外运方式',
    relevance: /土方|渣土|弃土/u,
    options: [
      { value: '自卸汽车外运', aliases: /自卸汽车|自卸车/ },
      { value: '密闭渣土车外运', aliases: /密闭式?[^，。；;]{0,4}车|渣土车/ },
      { value: '场内平衡利用', aliases: /场内平衡|就地平衡|场内调配|回填利用/ },
    ],
  },
];

/** 否定子句：含选项别名但处于否定语境的提及不计分（"不采用自拌混凝土"不构成自拌的证据支撑） */
const DECISION_NEGATION_RE = /不采用|不使用|不设置|不考虑|不得|禁止|取消/u;

/** 来源权威度（与 scopeConflicts 源级裁决口径同源：补疑/澄清修正文件权威最高） */
function decisionSourceWeight(item: DocumentEvidence) {
  const tag = `${item.filePath || ''} ${item.roleId || ''} ${item.sectionTitle || ''}`;
  if (/补疑|澄清|答疑|修正|更新/u.test(tag)) return 100;
  if (/招标文件|招标公告|投标人须知|前附表/u.test(tag)) return 90;
  if (/清单|工程量/u.test(tag)) return 80;
  if (/图纸|设计|dwg|drawing/iu.test(tag)) return 80;
  if (/规范|标准|规程/u.test(tag)) return 60;
  return 50;
}

interface DecisionMention {
  text: string;
  weight: number;
}

/** 证据句切分 + 事实行合成候选提及（事实已经 1.1 净化门处理，按置信度折算权重） */
function collectDecisionMentions(facts: DocumentFact[], evidence: DocumentEvidence[]): DecisionMention[] {
  const mentions: DecisionMention[] = [];
  for (const item of evidence) {
    const weight = decisionSourceWeight(item);
    const content = cleanPdfHeadingNoise(stringifyFactValue(item.content));
    for (const sentence of content.split(/[。；;\n]/u)) {
      const text = sentence.trim();
      if (text.length < 6 || text.length > 200) continue;
      mentions.push({ text, weight });
    }
  }
  for (const fact of facts) {
    const text = `${fact.key || ''} ${fact.fieldName || ''} ${stringifyFactValue(fact.value)}`.trim();
    if (text.length < 6 || text.length > 200) continue;
    mentions.push({ text, weight: Math.round(Math.max(0.5, Math.min(1, fact.confidence || 0.7)) * 60) });
  }
  return mentions;
}

/** 子句级否定判定：选项别名所在子句含否定词时该提及不计分 */
function mentionClauses(text: string) {
  return text.split(/[，,、：:]/u).map(clause => clause.trim()).filter(Boolean);
}

/**
 * 确定性提取项目关键决策表。
 * 计分：选项在类目相关句中出现即累计来源权重分；入选门槛 = 至少一条权威来源提及（bestWeight ≥60）；
 * 多值共存 = 得分 ≥ max(60, 类目最高分 × 0.4) 的选项全部锁定（≤3 个，按得分降序、同分按值名排序保逐字节一致）。
 */
export function extractDecisionLockEntries(input: { facts: DocumentFact[]; evidence: DocumentEvidence[] }): DecisionLockEntry[] {
  const mentions = collectDecisionMentions(input.facts, input.evidence);
  const entries: DecisionLockEntry[] = [];
  for (const category of DECISION_CATEGORIES) {
    const scores = new Map<string, { score: number; mentions: number; bestWeight: number }>();
    for (const mention of mentions) {
      if (!category.relevance.test(mention.text)) continue;
      const clauses = mentionClauses(mention.text);
      for (const option of category.options) {
        const hitClause = clauses.find(clause => option.aliases.test(clause));
        if (!hitClause || DECISION_NEGATION_RE.test(hitClause)) continue;
        const slot = scores.get(option.value) || { score: 0, mentions: 0, bestWeight: 0 };
        slot.score += mention.weight;
        slot.mentions += 1;
        slot.bestWeight = Math.max(slot.bestWeight, mention.weight);
        scores.set(option.value, slot);
      }
    }
    const ranked = [...scores.entries()]
      .map(([value, stat]) => ({ value, ...stat }))
      .sort((a, b) => b.score - a.score || b.mentions - a.mentions || (a.value < b.value ? -1 : 1));
    const top = ranked[0];
    if (!top || top.bestWeight < 60) continue;
    // 互斥类目唯一化：模板/混凝土/支护体系物理互斥，只锁最高分唯一值（同分取名字典序，保逐字节一致）；
    // 非互斥类目（垂直运输塔吊+电梯、土方外运自卸+场内平衡）保持多值共存锁定语义
    if (category.exclusive) {
      entries.push({ id: category.id, label: category.label, values: [top.value] });
      continue;
    }
    const threshold = Math.max(60, top.score * 0.4);
    const values = ranked.filter(item => item.score >= threshold).slice(0, 3).map(item => item.value);
    if (values.length > 0) entries.push({ id: category.id, label: category.label, values });
  }
  return entries;
}

/** 类目元数据访问：语义矛盾检测器按锁条目 id 取同类目 relevance/options（与锁构建单一事实源，防双写漂移） */
export function decisionLockCategoryMeta(id: string): DecisionCategoryMeta | undefined {
  return DECISION_CATEGORIES.find(category => category.id === id);
}

/** 子句级否定判定（与锁构建同口径）：别名命中子句含否定词时视为否定提及——检测侧"不采用施工电梯"不算冲突 */
export function decisionMentionNegated(text: string, aliases: RegExp): boolean {
  const hitClause = mentionClauses(text).find(clause => aliases.test(clause));
  return !!hitClause && DECISION_NEGATION_RE.test(hitClause);
}

/** 核心工程量（确定性口径：条目数最多的前 3 个分部 × 分部内工程量最大条目；金额类条目除外；同条目数按清单出现顺序）。
 * 无分部分节结构的条目（section 空）不参与：无施工方法小节可归属，不合成内部占位桶 */
function deriveCoreQuantities(boq: BillOfQuantitiesResult): string[] {
  const bySection = new Map<string, BoqEntry[]>();
  for (const entry of boq.entries) {
    if (!entry.name || entry.quantity <= 0) continue;
    if (/暂列|金额|计日工|税|费/u.test(entry.name)) continue;
    if (!entry.section) continue;
    const list = bySection.get(entry.section) || [];
    list.push(entry);
    bySection.set(entry.section, list);
  }
  const ranked = [...bySection.entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 3);
  return ranked.map(([section, entries]) => {
    const top = [...entries].sort((a, b) => b.quantity - a.quantity || (a.name < b.name ? -1 : 1))[0]!;
    return `${top.name} ${top.quantity}${top.unit}（${section}）`;
  });
}

/** 自然村数量（确定性提取）：项目名/基本事实中「N个（美丽宜居）自然村」正则 → 缺失时降级清单自然村分组数。
 * P3.6 源头根治：正则开头不加空格前缀（「丰乐镇20个」无空格形态曾匹配失败降级成清单分组 9 村），
 * 项目名优先匹配（基本事实可能被跨项目串染，项目名是招标文件口径最稳源）。 */
export function extractVillageCount(projectName: string, basicFacts: string): number {
  const projectMatch = /(\d+)\s*个(?:美丽宜居)?自然村/u.exec(projectName);
  if (projectMatch) return Number(projectMatch[1]);
  const factsMatch = /(\d+)\s*个(?:美丽宜居)?自然村/u.exec(basicFacts);
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
export function buildBlueprintDecisionLock(input: {
  facts?: DocumentFact[];
  evidence?: DocumentEvidence[];
  contract?: BlueprintContract;
  labor?: BlueprintLabor;
  boq?: BillOfQuantitiesResult;
  villageCount?: number;
}): BlueprintDecisionLock {
  const entries = extractDecisionLockEntries({ facts: input.facts || [], evidence: input.evidence || [] });
  const dataEntries: DecisionLockEntry[] = [];
  if (input.contract && input.contract.totalDays > 0) {
    dataEntries.push({ id: 'contract_days', label: '总工期', values: [`${input.contract.totalDays} 日历天`] });
  }
  if (input.labor && input.labor.peakValue > 0) {
    dataEntries.push({ id: 'labor_peak', label: '劳动力峰值', values: [`${input.labor.peakValue} 人`] });
  }
  const villageCount = input.villageCount || 0;
  if (villageCount > 0) {
    dataEntries.push({ id: 'village_count', label: '自然村数量', values: [`${villageCount} 个自然村`] });
  }
  if (input.boq) {
    const coreQuantities = deriveCoreQuantities(input.boq);
    if (coreQuantities.length > 0) {
      dataEntries.push({ id: 'core_quantities', label: '核心工程量', values: coreQuantities });
    }
  }
  return { entries: [...entries, ...dataEntries] };
}

/** 从基本事实文本提取合同口径（工期/质量标准/计价文件；提取不到降级为空串，不编造）。
 * P3.6 源头根治：总工期不再裸匹配第一个「N日历天」（质保期/阶段工期 90 天曾被误采为总工期，
 * 真实 210 天被漏采）；只从工期类锚点词邻接收值，lookbehind 排除「节点/阶段/分项/关键」工期
 * 子项形态（阶段工期 90 天不可顶替总工期），与 scheduleDays 一致性锚点同口径。 */
export function extractContractFromFacts(basicFacts: string, boq: BillOfQuantitiesResult): { totalDays: number; qualityStandard: string; pricingFile: string; estimatedAmount: number } {
  const totalDaysMatch = /(?<!节点)(?<!阶段)(?<!分项)(?<!关键)(?:计划工期|合同工期|工期总日历天数|工期控制|工期目标|总工期|工期)[^。；;\n]{0,12}?(\d{1,4})\s*个?\s*日历天/u.exec(basicFacts)
    || /(\d{1,4})\s*个?\s*日历天[^。；;\n]{0,8}?(?:总工期|倒排|分解|完成)/u.exec(basicFacts);
  const totalDays = totalDaysMatch ? Number(totalDaysMatch[1]) : 0;
  const qualityMatch = /质量(?:标准|要求)[^。；;\n]{0,20}?[：:]\s*([^。；;\n]{1,20})/u.exec(basicFacts) || /合格/u.exec(basicFacts);
  const qualityStandard = qualityMatch ? (qualityMatch[1] || '合格').trim() : '';
  const pricingMatch = /(合造价〔\d{4}〕\d+号)/u.exec(basicFacts);
  const pricingFile = pricingMatch ? pricingMatch[1] : '';
  // 合同估算价（万元）：造价锚定劳动力量级窗口的锚点（金额仅蓝图内部校验使用，参数桶不渲染）
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
 * strategy 缺省 = 村域市政组（历史村域口径，现有单测与调用方行为零变化），新链路必须显式传策略 */
export function buildBlueprintData(input: {
  boq: BillOfQuantitiesResult;
  basicFacts?: string;
  evidence?: DocumentEvidence[];
  facts?: DocumentFact[];
  projectName: string;
  strategy?: BlueprintDerivationStrategy;
}): { data: BlueprintData; diagnostics: Pick<BlueprintBuildDiagnostics, 'standardBlocksLoaded' | 'standardBlockGaps' | 'warnings'> } {
  const { boq } = input;
  const strategy = input.strategy || villageMunicipalStrategy;
  const quantities = deriveQuantitiesFromBoq(boq);
  const redLineFacts = extractRedLineFacts(boq);
  // 自然村数量红线事实（P2.4）：项目名正则提取（如「20个美丽宜居自然村」）优先，降级清单分组数；拦截跨项目残留「9 个自然村」
  const villageCount = extractVillageCount(input.projectName, input.basicFacts || '') || boq.villages.length;
  if (villageCount > 0) {
    redLineFacts.push({ key: '自然村数量', value: `${villageCount} 个自然村`, source: '招标文件项目名称（清单自然村分组兜底）' });
  }
  const specAuthorities = deriveSpecAuthoritiesFromBoq(boq);
  const contract = extractContractFromFacts(input.basicFacts || '', boq);
  const milestones = deriveMilestonesFromBoq(boq, contract.totalDays, strategy);
  const labor = deriveLaborFromBoq(boq, contract.totalDays, contract.estimatedAmount || 0, milestones, strategy);
  const equipment = deriveEquipmentFromBoq(boq, strategy);
  const materialsPlan = deriveMaterialsPlanFromBoq(boq);
  const inspectionBatches = deriveInspectionBatchesFromBoq(boq, strategy);
  const earthworkBalance = deriveEarthworkBalanceFromBoq(boq);
  const tempUtilities = deriveTempUtilitiesFromBoq(equipment, labor, strategy);
  const evidenceText = (input.evidence || []).map(item => String(item.content || '')).join('\n');
  const standard = buildStandardBlocks(boq, evidenceText);
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
  if (!climate.rainySeason) {
    warnings.push('气候区域未识别，季节施工由写作层按建设地点常识处理');
  }
  const data: BlueprintData = {
    project: {
      name: input.projectName || '（待提取：项目名称）',
      scope: boq.villages.length > 0 ? `${boq.villages.length} 个自然村分组（${boq.villages.map(village => village.villageGroup).join('、')}）` : '',
      works,
      location,
    },
    contract: { totalDays: contract.totalDays, qualityStandard: contract.qualityStandard, pricingFile: contract.pricingFile, estimatedAmount: contract.estimatedAmount || undefined },
    climate,
    milestones,
    resources: { labor, equipment },
    materialsPlan,
    fundPlan: { wageRule: '工资性工程款按合造价〔2022〕8号执行', usagePlan: '按进度分阶段使用' },
    testPlan: [],
    earthworkBalance,
    tempUtilities,
    redLineFacts,
    amountRule: BLUEPRINT_AMOUNT_RULE,
    decisionLock,
    quantities,
    specAuthorities,
    inspectionBatches,
    standardBlocks: standard.blocks,
    constructionDeployment,
    keyDifficulties,
    basisRegulations: extractBasisRegulations(`${input.basicFacts || ''}\n${evidenceText}`),
    drawingNote: '总平面布置图/横道图/组织机构图为后期人工配图，蓝图只规划对应章节正文内容',
  };
  return { data, diagnostics: { standardBlocksLoaded: standard.blocks.filter(block => !block.gap).length, standardBlockGaps: standard.gaps, warnings } };
}

// ═══════════════════════════════ 阶段 B：outline 大纲规划（一期确定性映射） ═══════════════════════════════

/** 十项评审标准承接映射：评审项 → 章标题关键词（十项评审是蓝图大纲规划的强制输入） */
const EVALUATION_CARRY_TABLE: Array<{ item: string; weight: string; chapterPattern: RegExp }> = [
  { item: '主要施工方法', weight: '1.5', chapterPattern: /主要分部分项|施工方案|施工方法/u },
  { item: '物资计划', weight: '0.5', chapterPattern: /物资|资源配置|材料/u },
  { item: '机械设备计划', weight: '0.5', chapterPattern: /机械|资源配置|设备/u },
  { item: '劳动力安排', weight: '0.5', chapterPattern: /劳动力|资源配置|人员/u },
  { item: '质量措施', weight: '1.5', chapterPattern: /质量/u },
  { item: '安全措施', weight: '1.5', chapterPattern: /安全/u },
  { item: '工期措施', weight: '1.0', chapterPattern: /工期|进度/u },
  { item: '文明施工', weight: '1.0', chapterPattern: /文明施工|环境保护|绿色施工/u },
  { item: '总平面布置图', weight: '0.5', chapterPattern: /总平面|平面布置/u },
  { item: '重难点及保证措施', weight: '1.5', chapterPattern: /重难点|重点|难点|概况/u },
];

/** 三期收口：docType 章节激活裁剪——专项施工方案类文档不承接总平面布置/施工部署类章节（单位工程施工组织设计全激活） */
function resolveChapterActivation(docType: string, chapterTitle: string): boolean {
  if (/专项施工方案|专项方案|危大/u.test(docType) && /总平面|平面布置|施工部署|总体部署/u.test(chapterTitle)) return false;
  return true;
}

/** 清单分部名 → 大纲小节名规范化（丰乐镇实测：清单「八、其他」分部把房前屋后整理/墙面彩绘/杆线整治/
 * 仿木护栏等环境整治条目归入「其他」——计量分部名不是大纲小节名，按条目内容确定性归纳更名；
 * round-27 扩展：房建定额子分部名同样需要规范化——「其他装饰工程」→零星装饰工程、
 * 「措施项目」（模板/脚手架/化粪池费用分部）→按条目归纳、「墙柱面装饰与隔断幕墙工程」无幕墙时去幕墙措辞） */
function normalizeConstructionSectionTitle(section: string, entries: BoqEntry[]): string {
  const trimmed = section.trim();
  if (/^其他$|^其他工程$/u.test(trimmed)) {
    const names = entries.map(entry => entry.name);
    if (names.some(name => /彩绘|护栏|围栏|小品|标识|标牌|墙面|整治/u.test(name))) return '环境整治工程';
    if (names.some(name => /绿化|栽植|铺装|种植/u.test(name))) return '景观附属工程';
    if (names.some(name => /拆除|清理|清淤|清运/u.test(name))) return '清理整治工程';
    return '零星工程';
  }
  if (/^其他装饰/u.test(trimmed)) return '零星装饰工程';
  if (/^措施项目$/u.test(trimmed)) {
    const names = entries.map(entry => entry.name);
    if (names.some(name => /化粪池|吊装|安装/u.test(name))) return '模板、脚手架及化粪池安装工程';
    return '模板与脚手架工程';
  }
  if (/墙[、,]?柱面装饰/u.test(trimmed)) {
    const hasCurtainWall = entries.some(entry => /幕墙|隔断/u.test(entry.name));
    return hasCurtainWall ? trimmed : '墙柱面装饰工程';
  }
  return trimmed;
}

/** 施工方法章小节构建：顶层小节 = 清单分部/单位工程（计量分部名规范化后的大纲小节）；
 * 单位工程（如「2.3 公厕」）内部子分部聚合为小节下子工作包（作为小节内主题块要点），
 * 不再平铺成独立小节（历史缺陷：公厕 15 个子分部升级为 15 个章级小节，房建通用分部名
 * 「门窗工程/墙柱面装饰与隔断幕墙工程」混入美丽乡村项目大纲） */
function buildConstructionMethodSubSections(boq: BillOfQuantitiesResult, chapterId: string): BlueprintSubSection[] {
  const sectionGroups = new Map<string, BoqEntry[]>();
  for (const entry of boq.entries) {
    // 无分部分节结构的条目不参与分桶：不合成「未分部条目」占位小节（系统不创作结构）——
    // 无小节可归属时不进入本章，由覆盖校验按无结构条目豁免；有真实分部的条目正常分桶
    if (!entry.section) continue;
    const list = sectionGroups.get(entry.section) || [];
    list.push(entry);
    sectionGroups.set(entry.section, list);
  }
  const subSections: BlueprintSubSection[] = [];
  let subIndex = 0;
  for (const [section, entries] of sectionGroups) {
    const title = normalizeConstructionSectionTitle(section, entries);
    const isUnitProject = entries.some(entry => entry.sectionKind === 'unit-project');
    const packages: BlueprintWorkPackage[] = [];
    if (isUnitProject) {
      // 单位工程小节：内部子分部（subsection）各为一个工作包，小节内按子分部展开要点
      const bySub = new Map<string, BoqEntry[]>();
      for (const entry of entries) {
        const key = entry.subsection || title;
        const list = bySub.get(key) || [];
        list.push(entry);
        bySub.set(key, list);
      }
      for (const [subName, subEntries] of bySub) {
        // round-27：子分部名同走清单分部名规范化（措施项目→模板脚手架工程、其他装饰工程→零星装饰工程）
        packages.push(buildWorkPackageFromBoqSection(normalizeConstructionSectionTitle(subName, subEntries), subEntries));
      }
    } else {
      packages.push(buildWorkPackageFromBoqSection(title, entries));
    }
    subIndex += 1;
    subSections.push({
      id: `${chapterId}.${subIndex}`,
      title,
      targetWords: 2400,
      requiredParams: packages.flatMap(workPackage => Object.keys(workPackage.quantities).slice(0, 5).map(quantityName => ({ path: `data.quantities.${quantityName}`, mode: 'must_cite' as const, strict: true }))),
      scoredItems: ['评标分项：主要施工方法（1.5）'],
      tablePlans: [],
      workPackages: packages,
    });
  }
  return subSections;
}

/** 阶段 B：模板章节目录 → 蓝图大纲（评审承接声明 + 工作包骨架挂接） */
export function buildBlueprintOutline(input: {
  chapterTitles: string[];
  boq: BillOfQuantitiesResult;
  docType: string;
}): BlueprintOutline {
  const { chapterTitles, boq } = input;
  const chapters: BlueprintChapter[] = chapterTitles.map((title, index) => {
    const id = String(index + 1);
    const scoredItems = EVALUATION_CARRY_TABLE.filter(row => row.chapterPattern.test(title)).map(row => `${row.item}（评审权重 ${row.weight}）`);
    // 主要施工方法章承接全部工作包（确定性挂接：清单分部 → 工作包）。
    // 丰乐镇三期验收实测：泛匹配「主要施工」把「拟投入的主要施工机械、设备计划」误判为施工方法章，
    // 23 个清单分部串入机械章（4.1 道路工程…4.23 管网工程）；机械章无「分部分项/施工方案/施工方法」完整词，泛词已删除
    const isConstructionChapter = /主要分部分项|施工方案|施工方法/u.test(title);
    const subSections: BlueprintSubSection[] = isConstructionChapter ? buildConstructionMethodSubSections(boq, id) : [];
    return { id, title, isActive: resolveChapterActivation(input.docType, title), requiredParams: [], scoredItems, subSections };
  });
  return { chapters };
}

// ═══════════════════════════════ 阶段 C：节级配方补全（清单条目原序归纳，确定性） ═══════════════════════════════

/** 特征描述条款提取：「N．关键词：值」形态（清单项目特征原文直填，不改写数值） */
function extractFeatureClauses(description: string): Array<{ key: string; value: string }> {
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
function extractMethodPhrases(entries: BoqEntry[]): string[] {
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

/** 阶段 C：清单分部条目 → 工作包（工序链按清单条目原序、参数/做法按特征原文提取、知识卡补验收与规范） */
export function buildWorkPackageFromBoqSection(section: string, entries: BoqEntry[]): BlueprintWorkPackage {
  const sorted = [...entries].sort((left, right) => left.seq - right.seq);
  const quantities: Record<string, BlueprintWorkPackageQuantity> = {};
  const byName = new Map<string, number>();
  for (const entry of sorted) {
    if (!entry.name) continue;
    byName.set(entry.name, (byName.get(entry.name) || 0) + entry.quantity);
  }
  for (const [name, total] of byName) {
    const unit = sorted.find(entry => entry.name === name)?.unit || '';
    quantities[name] = { value: Math.round(total * 1000) / 1000, unit };
  }
  // 工序链：清单条目名称原序（去重），条目名称即工序动作
  const processChain = [...new Set(sorted.map(entry => entry.name).filter(Boolean))].slice(0, 16);
  const methods = extractMethodPhrases(sorted);
  const params: BlueprintWorkPackage['params'] = [];
  const seenParams = new Set<string>();
  for (const entry of sorted) {
    for (const clause of extractFeatureClauses(entry.description)) {
      const dedupeKey = `${clause.key}=${clause.value}`;
      if (seenParams.has(dedupeKey)) continue;
      seenParams.add(dedupeKey);
      params.push({ key: clause.key, value: clause.value, source: 'boq' });
      if (params.length >= 24) break;
    }
    if (params.length >= 24) break;
  }
  // 验收：清单特征验收类条款（压实度/试验/隐蔽） + 知识卡补
  const acceptance: string[] = [];
  for (const entry of sorted) {
    const clauses = extractFeatureClauses(entry.description);
    for (const clause of clauses) {
      if (/压实|试验|检测|验收|闭水|合格/u.test(`${clause.key}${clause.value}`) && acceptance.length < 12 && !acceptance.includes(clause.value)) {
        acceptance.push(clause.value);
      }
    }
  }
  const knowledgeCards = matchProcessKnowledgeCards([section]);
  const standards: string[] = [];
  if (acceptance.length === 0 && knowledgeCards.length > 0) {
    acceptance.push(...knowledgeCards[0].acceptance.slice(0, 6).map(item => `${item}（知识卡）`));
  }
  for (const card of knowledgeCards.slice(0, 2)) {
    for (const standard of card.standards) {
      if (!standards.includes(standard)) standards.push(standard);
    }
  }
  return {
    name: section,
    kind: 'major',
    quantities,
    processChain,
    methods,
    params,
    acceptance,
    standards,
    source: 'boq',
    coveredSeqs: sorted.map(entry => entry.seq),
  };
}

/** 阶段 C 回退：现有 parseMajorConstructionPackages 产物直填（蓝图工作包解析失败时启用） */
export function fallbackWorkPackagesFromExisting(projectContext: string, evidence: DocumentEvidence[]): BlueprintWorkPackage[] {
  try {
    const packages = parseMajorConstructionPackages(projectContext, evidence);
    return packages.map(workPackage => ({
      name: workPackage.name,
      kind: 'major' as const,
      quantities: {},
      processChain: workPackage.process || [],
      methods: [],
      params: (workPackage.quantities || []).map(item => ({ key: item, value: item, source: 'boq' as const })),
      acceptance: workPackage.acceptance || [],
      standards: [],
      source: 'fallback' as const,
      coveredSeqs: [],
    }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════ 阶段 D：蓝图校验（冻结前四道） ═══════════════════════════════

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
  // 映射表按工程类型策略组取用——蓝图未记录策略 id，合并全部策略组映射去重查找
  if (boq) {
    const allMappings = [
      ...villageMunicipalStrategy.equipmentMapping,
      ...buildingStrategy.equipmentMapping,
      ...generalStrategy.equipmentMapping,
      ...bridgeTunnelStrategy.equipmentMapping,
      ...highwayStrategy.equipmentMapping,
      ...waterConservancyStrategy.equipmentMapping,
    ];
    for (const item of blueprint.data.resources?.equipment || []) {
      const mapping = allMappings.find(candidate => candidate.name === item.name);
      if (!mapping) continue;
      const hits = boq.entries.filter(entry => mapping.pattern.test(`${entry.name} ${entry.description}`) && entry.unit === mapping.unit);
      const totalQty = hits.reduce((sum, entry) => sum + entry.quantity, 0);
      const basisQtyMatch = /合计约\s*([\d.]+)/u.exec(item.basis);
      if (basisQtyMatch && Number(basisQtyMatch[1]) !== Math.round(totalQty)) {
        errors.push(`机械「${item.name}」basis 工程量 ${basisQtyMatch[1]} 与清单同单位聚合 ${Math.round(totalQty)} 不一致`);
      }
    }
  }
  return errors;
}

/** 校验 3：覆盖校验（清单条目零丢失 + 十项评审承接 + 重难点逐项列明） */
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
  // 十项评审承接：每项评审标准至少一章显性承接
  const carried = new Set<string>();
  for (const chapter of blueprint.outline.chapters) {
    for (const item of chapter.scoredItems) carried.add(item.split('（')[0] || '');
  }
  const uncovered = EVALUATION_CARRY_TABLE.filter(row => ![...carried].some(item => item.includes(row.item))).map(row => row.item);
  if (uncovered.length > 0) errors.push(`十项评审承接缺失：${uncovered.join('、')} 无章/节显性承接声明`);
  if (blueprint.data.keyDifficulties.length === 0) errors.push('重难点及保证措施未逐项列明（十项评审⑩硬要求）');
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
    // 造价锚定量级校验（丰乐镇第 3 轮）：峰值必须落在合同估算价量级窗口（锚定区间外扩 0.6~1.3 倍，
    // 仅拦数量级错误；1222 人曾通过形式校验冻结为荒谬权威值）
    const estimatedAmount = blueprint.data.contract?.estimatedAmount || 0;
    if (estimatedAmount > 0 && labor.peakValue > 0 && totalDays > 0) {
      const effectiveDays = Math.max(30, Math.round(totalDays * 0.85));
      const anchor = deriveCostAnchoredLaborWindow(estimatedAmount, effectiveDays);
      const checkMin = Math.round(anchor.min * 0.6);
      const checkMax = Math.round(anchor.max * 1.3);
      if (labor.peakValue < checkMin || labor.peakValue > checkMax) {
        errors.push(`劳动力峰值 ${labor.peakValue} 人超出造价锚定量级窗口 [${checkMin}, ${checkMax}] 人（合同估算价 ${estimatedAmount} 万元锚定）`);
      }
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
  const sixHundred = (blueprint.data.standardBlocks || []).find(block => block.id === 'six-hundred-percent');
  if (sixHundred && !sixHundred.gap && sixHundred.items.length !== 6) {
    errors.push(`扬尘治理六个百分百板块条目数 ${sixHundred.items.length} 条（应为恰六条）`);
  }
  return errors;
}

/** P14 per-check 权威可用性计算（纯函数，validateBlueprint 消费 + 单测直接锁定）：
 * - Schema/事实锚定失败 → 数值无源，全部权威不可用；
 * - 覆盖校验失败 → 清单条目/评审承接缺失，仅蓝图整体可用性受损（不损伤已锚定数值本身）；
 * - 内部一致性按错误归属细分（现正则；第 4 期语义化）：里程碑/总工期 → schedule、
 *   劳动力/工种 → laborPeak、机械 → blueprint；六百分百等无关条目不损伤任何权威 */
export function computeBlueprintAuthorityAvailability(input: {
  schemaPassed: boolean;
  factPassed: boolean;
  coveragePassed: boolean;
  consistencyErrors: string[];
}): Record<BlueprintAuthorityId, boolean> {
  const scheduleConsistencyOk = !input.consistencyErrors.some(error => /里程碑|总工期/u.test(error));
  const laborConsistencyOk = !input.consistencyErrors.some(error => /劳动力|工种/u.test(error));
  const machineConsistencyOk = !input.consistencyErrors.some(error => /机械/u.test(error));
  return {
    laborPeak: input.schemaPassed && input.factPassed && laborConsistencyOk,
    schedule: input.schemaPassed && input.factPassed && scheduleConsistencyOk,
    blueprint: input.schemaPassed && input.factPassed && input.coveragePassed && machineConsistencyOk,
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
export function chapterBlueprintAuthorityGaps(title: string, validation?: BlueprintValidationReport, classifier?: ChapterIntentClassifier): { missing: BlueprintAuthorityId[]; failedChecks: string[] } {
  const needed = chapterBlueprintAuthoritiesNeeded(title, classifier);
  const failedChecks = validation ? validation.checks.filter(check => !check.passed).map(check => check.name) : [];
  const availability = validation?.authorityAvailability;
  if (!availability) return { missing: needed, failedChecks };
  return { missing: needed.filter(id => !availability[id]), failedChecks };
}

/** 阶段 D 主入口：四道校验，全部通过方可冻结 */
export function validateBlueprint(blueprint: IntegratedBlueprint, boq?: BillOfQuantitiesResult): BlueprintValidationReport {
  const checks: BlueprintValidationReport['checks'] = [];
  const schemaErrors = validateBlueprintSchema(blueprint);
  checks.push({ name: '1. Schema 校验', passed: schemaErrors.length === 0, message: schemaErrors.length === 0 ? '结构/类型/必填/边界全部通过' : schemaErrors.join('；') });
  const factErrors = validateBlueprintFacts(blueprint, boq);
  checks.push({ name: '2. 事实锚定校验', passed: factErrors.length === 0, message: factErrors.length === 0 ? 'L1a 值全部 ∈ 清单解析产物值集，红线事实逐条有源' : factErrors.join('；') });
  const coverageErrors = validateBlueprintCoverage(blueprint, boq);
  checks.push({ name: '3. 覆盖校验', passed: coverageErrors.length === 0, message: coverageErrors.length === 0 ? '清单条目零丢失、十项评审全承接、重难点逐项列明' : coverageErrors.join('；') });
  const consistencyErrors = validateBlueprintConsistency(blueprint);
  checks.push({ name: '4. 内部一致性校验', passed: consistencyErrors.length === 0, message: consistencyErrors.length === 0 ? '里程碑/劳动力/机械区间自洽' : consistencyErrors.join('；') });
  // P14 分层权威：per-check 错误 → authorityAvailability（documentGenerator 数值密集章阻断判定消费）
  const authorityAvailability = computeBlueprintAuthorityAvailability({
    schemaPassed: schemaErrors.length === 0,
    factPassed: factErrors.length === 0,
    coveragePassed: coverageErrors.length === 0,
    consistencyErrors,
  });
  return { passed: checks.every(check => check.passed), checks, authorityAvailability };
}

// ═══════════════════════════════ 渲染函数（二期执行层输入） ═══════════════════════════════

/** 参数桶渲染：全文恒定段（各章写作 prompt 注入，同文档逐字节一致 → prefix cache 可命中） */
export function renderBlueprintDataText(data: BlueprintData): string {
  const lines: string[] = ['【一体化蓝图参数桶——全项目口径唯一权威源，正文引用必须与此一致，不得自行推导不同数值】'];
  lines.push('计划类数值（劳动力人数/工期/工程量/养护期）必须且只能引用以下锚点值：禁止将各工种人数相加推导峰值、禁止按定额自行估算、禁止改写锚点数值。');
  lines.push(`- 项目：${data.project.name}（${data.project.scope}）`);
  // V5 P2 数据驱动渲染：权威条目全量渲染（删除手写行与 12/15/10 物理截断——凡进蓝图 data 的
  // 对象自动进桶，渲染覆盖率测试防“数据有而桶无”复发）；非索引对象（检验批/决策锁/部署/重难点）紧随其后
  lines.push(...renderAuthorityDomains(buildAuthorityIndex(data)));
  if (data.inspectionBatches.length > 0) {
    lines.push(`- 检验批划分：${data.inspectionBatches.map(item => `${item.scope}——${item.planDesc}`).join('；')}`);
  }
  lines.push(`- 临时用电：${data.tempUtilities.powerLoad}`);
  lines.push(`- 临时用水：${data.tempUtilities.waterUsage}`);
  if (data.decisionLock.entries.length > 0) {
    lines.push(`- 关键决策锁：${data.decisionLock.entries.map(entry => `${entry.label}：${entry.values.join('、')}`).join('；')}`);
  }
  if (data.constructionDeployment.sections.length > 0) {
    lines.push(`- 施工部署：${data.constructionDeployment.flow}；施工顺序 ${data.constructionDeployment.sequence}`);
  }
  if (data.keyDifficulties.length > 0) {
    lines.push(`- 重难点（逐项列明）：${data.keyDifficulties.map(item => `${item.name}——${item.measure}`).join('；')}`);
  }
  lines.push(`- 金额禁区：${data.amountRule}`);
  lines.push(data.drawingNote);
  return lines.join('\n');
}

/** 章级数值锚点路由：权威域 → 章标题命中正则（确定性零 LLM；V5 P2 由 8 个手写 render
 * 升级为「域路由表 + 通用渲染器」——命中域的全部权威条目经 renderAuthorityDomains 聚焦注入）。
 * 路由只是「聚焦加分」，不是数据可见性门槛：未命中任何域的章仍在全局参数桶中看到全部权威；
 * 无路由的 domain 默认只进全局桶。行文案单一来源，与全局桶零漂移。 */
export const AUTHORITY_DOMAIN_CHAPTER_ROUTES: Array<{
  domain: AuthorityDomain;
  /** 章标题命中该正则注入该域锚点行 */
  chapterPattern: RegExp;
}> = [
  { domain: 'contract', chapterPattern: /进度|工期|总体|部署|概况|工程|计划/u },
  { domain: 'schedule', chapterPattern: /进度|工期|部署|计划|总体|施工方案|分部分项/u },
  { domain: 'labor', chapterPattern: /劳动力|人员|资源|进度|工期|部署|概况/u },
  { domain: 'equipment', chapterPattern: /机械|设备|资源/u },
  { domain: 'material', chapterPattern: /物资|材料|资源|采购|亮化|路灯|照明/u },
  { domain: 'quantity', chapterPattern: /分部分项|施工方案|施工方法|土方|道路|管网|工程概况/u },
  { domain: 'spec', chapterPattern: /材料|物资|质量|技术|施工方案|分部分项/u },
  { domain: 'earthwork', chapterPattern: /土方|土石方|道路|管网|施工方案|分部分项/u },
  { domain: 'test', chapterPattern: /质量|试验|检测|验收/u },
  { domain: 'redline', chapterPattern: /绿化|种植|养护|苗木|技能|培训|成品保护|质量|亮化|路灯|照明|概况|工程|总体/u },
];

/** 编制依据小节路由（basis_regulations 非索引对象特例：数据源 data.basisRegulations 而非索引） */
const BASIS_REGULATIONS_CHAPTER_PATTERN = /编制|工程概况|项目概况|概况|说明/u;

/** 编制依据小节锚点行：法规/条例/规范由写作模型依据行业公共知识自行列写（不得喂确定性清单，
 * 清单注入会限制模型结合项目实际情况的取舍）；本锚点只给写作要求与项目专属事实——招标文件
 * 引用法规必须照抄；类别话术（「国家现行法律、行政法规」等无具体名称表述）严禁空写，
 * 交付前由 basisRegulationsCoverageIssues 确定性兑底。 */
function renderBasisRegulationsLines(data: BlueprintData): string[] {
  const rows: string[] = [];
  if ((data.basisRegulations ?? []).length > 0) {
    rows.push(`- 招标文件引用法规（项目专属事实，编制依据小节必须列出法规名称及文号）：${data.basisRegulations.join('、')}`);
  }
  rows.push('- 编制依据小节由写作模型自行列写：国家法律法规及文号、工程所在地地方性法规、与本工程分部对应的现行施工验收规范名称及编号；不得空写「国家现行法律、行政法规」等类别话术，不得编造文号');
  return rows;
}

/** 施工验收规范确定性映射已移除（十度实测缺陷治理决策）：规范由写作模型依据行业公共知识
 * 自行列写，不得喂确定性清单；稳定性由交付前检测 basisRegulationsCoverageIssues 兑底。 */

/** 章级数值锚点卡：本章命中的权威域聚焦渲染 + 编制依据特例段（写作层强约束，禁止自行推导/加总/估算）。
 * 章标题未命中任何域且非编制依据章时返回空串（非数值章不注入，避免长文稀释注意力）。 */
export function renderBlueprintChapterAuthorityCard(chapter: BlueprintChapter, data: BlueprintData): string {
  const domains = AUTHORITY_DOMAIN_CHAPTER_ROUTES
    .filter(route => route.chapterPattern.test(chapter.title))
    .map(route => route.domain);
  const lines = renderAuthorityDomains(buildAuthorityIndex(data), domains);
  if (BASIS_REGULATIONS_CHAPTER_PATTERN.test(chapter.title)) {
    lines.push(...renderBasisRegulationsLines(data));
  }
  if (lines.length === 0) return '';
  return [
    '【本章数值锚点——计划类数值必须且只能引用以下锚点值；禁止将各工种人数相加推导峰值、禁止按定额自行估算、禁止改写或自设任何计划类数值】',
    ...lines,
  ].join('\n');
}

/** 章切片渲染：该章 sub_sections + work_packages 展开为「本项目专属事实」文本（执行层只读切片写作）。
 * data 传入时尾部追加章级数值锚点卡（本章必须引用的计划类数值聚焦强约束）。 */
export function renderBlueprintChapterSlice(chapter: BlueprintChapter, data?: BlueprintData): string {
  // M4·写作三源规则：章切片权威提示与全局写作提示词（FORMAL_WRITING_RULES）共用同一份三源规则模板，
  // 写作层在本章看到的全部计划类数值均以切片与章域卡为准，禁止按定额重算（跨工程串位/口径分裂的提示词级防线）
  const lines: string[] = [
    `【第 ${chapter.id} 章「${chapter.title}」蓝图切片——以下项目专属事实由蓝图冻结锁定，正文必须一致引用】`,
    THREE_SOURCE_WRITE_RULES,
  ];
  for (const subSection of chapter.subSections) {
    lines.push(`\n## ${subSection.id} ${subSection.title}（目标 ${subSection.targetWords ?? 2400} 字）`);
    const mustCite = subSection.requiredParams.filter(param => param.mode === 'must_cite').map(param => param.path);
    if (mustCite.length > 0) lines.push(`must_cite 参数（正文必须出现且与蓝图一致）：${mustCite.join('、')}`);
    for (const workPackage of subSection.workPackages) {
      lines.push(`\n### 工作包：${workPackage.name}（${workPackage.kind === 'major' ? '主要' : '一般'}工作包）`);
      const quantityText = Object.entries(workPackage.quantities).map(([name, quantity]) => `${name} ${quantity.value}${quantity.unit}`).join('、');
      if (quantityText) lines.push(`- 工程量：${quantityText}`);
      if (workPackage.processChain.length > 0) lines.push(`- 工序链：${workPackage.processChain.join(' → ')}`);
      if (workPackage.methods.length > 0) lines.push(`- 施工方法（清单特征原文）：${workPackage.methods.join('；')}`);
      if (workPackage.params.length > 0) lines.push(`- 工艺参数：${workPackage.params.map(param => `${param.key}=${param.value}`).join('；')}`);
      if (workPackage.acceptance.length > 0) lines.push(`- 验收要求：${workPackage.acceptance.join('；')}`);
      if (workPackage.standards.length > 0) lines.push(`- 规范依据：${workPackage.standards.join('；')}`);
    }
  }
  const authorityCard = data ? renderBlueprintChapterAuthorityCard(chapter, data) : '';
  return [lines.join('\n'), authorityCard].filter(Boolean).join('\n\n');
}

/** 正则元字符转义（蓝图引用对齐锚定词安全） */
function escapeRegexForAlign(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 单位变体归一（与修复器 quantityUnitVariants 同源，零漂移实测）：清单单位 m2/m3/t 与正文
 *  上标写法（m²/㎡/m³）同义——检测正则只认一种写法时，上标值不入候选，分部拆分豁免
 *  （压膜 404.4+730=1134.4）无法触发导致误报「压膜 404.4」 */
function quantityUnitDetectVariants(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (/(?:m2|m²|㎡)/.test(normalized)) return '(?:㎡|m²|m2)';
  if (/(?:m3|m³)/.test(normalized)) return '(?:m³|m3)';
  if (normalized === 't' || normalized === '吨') return '(?:吨|t)';
  return escapeRegexForAlign(unit);
}

/** 章切片匹配：按模板章标题在蓝图大纲中定位章切片（构建时 title 即模板原始标题） */
export function findBlueprintChapter(blueprint: IntegratedBlueprint, chapterTitle: string): BlueprintChapter | undefined {
  const exact = blueprint.outline.chapters.find(chapter => chapter.title === chapterTitle);
  if (exact) return exact;
  return blueprint.outline.chapters.find(chapter => chapterTitle.includes(chapter.title) || chapter.title.includes(chapterTitle));
}

/** 蓝图引用对齐（二期切换）：章成稿后 must_cite+strict 参数数值与蓝图不一致时确定性回填
 * （只替换数字本身、不动句式，与 planDataMaster 对齐同构；权威源为蓝图 data）；
 * 未出现（missing）仅报告不阻断（缺口数字反馈与修复链兜底）。
 * 覆盖 total_days 与 quantities 两类 strict 口径，其余 path 由参数桶渲染注入强制引用。 */
export function alignChapterContentToBlueprint(markdown: string, chapter: BlueprintChapter, data: BlueprintData): { markdown: string; fixed: Array<{ anchor: string; from: string; to: string }>; missing: string[] } {
  const fixed: Array<{ anchor: string; from: string; to: string }> = [];
  const missing: string[] = [];
  let result = markdown;
  const mustCiteStrict = chapter.subSections.flatMap(section => section.requiredParams.filter(param => param.mode === 'must_cite' && param.strict));
  // 域级锚点（章标题命中即对齐，不依赖 requiredParams 声明）：劳动力峰值/养护期是写作层高频自编数值，
  // 蓝图权威为唯一口径——章标题命中域即强制对齐（检测定位=修复定位同源锚点，与数值锚点卡注入同域）。
  const domainAnchors: BlueprintRequiredParam[] = [];
  if (/劳动力|人员|资源|进度|工期|部署|概况/u.test(chapter.title) && data.resources.labor.peakValue > 0) {
    domainAnchors.push({ path: 'data.resources.labor.peak_value', mode: 'must_cite', strict: true });
  }
  if (/绿化|种植|养护|苗木|技能|培训|成品保护|质量/u.test(chapter.title)) {
    domainAnchors.push({ path: 'data.redline.greening_maintenance', mode: 'must_cite', strict: true });
  }
  const alignedParams = [...mustCiteStrict, ...domainAnchors];
  const seen = new Set<string>();
  for (const param of alignedParams) {
    if (seen.has(param.path)) continue;
    seen.add(param.path);
    if (param.path === 'data.contract.total_days') {
      if (data.contract.totalDays <= 0) continue;
      const dayRe = /(?:总工期|施工工期|合同工期|工期)(?:为|约|共计|控制)?[^\n。；;]{0,20}?(\d+(?:\.\d+)?)\s*(?:日历)?天/gu;
      let matched = false;
      result = result.replace(dayRe, (line, rawValue: string) => {
        matched = true;
        const value = Number(rawValue);
        if (value === data.contract.totalDays || value <= 0) return line;
        fixed.push({ anchor: '总工期', from: `${value}天`, to: `${data.contract.totalDays}天` });
        return line.replace(rawValue, String(data.contract.totalDays));
      });
      if (!matched) missing.push(`总工期 ${data.contract.totalDays} 日历天`);
      continue;
    }
    if (param.path.startsWith('data.quantities.')) {
      const quantityName = param.path.slice('data.quantities.'.length);
      const quantity = data.quantities[quantityName];
      if (!quantity || quantity.value <= 0) continue;
      const unit = quantity.unit || '';
      const valueRe = new RegExp(`${escapeRegexForAlign(quantityName)}[^\\n。；;]{0,40}?(\\d+(?:\\.\\d+)?)\\s*${unit ? escapeRegexForAlign(unit) : ''}`, 'gu');
      let matched = false;
      result = result.replace(valueRe, (line, rawValue: string) => {
        matched = true;
        const value = Number(rawValue);
        if (value === quantity.value || value <= 0) return line;
        fixed.push({ anchor: quantityName, from: `${value}${unit}`, to: `${quantity.value}${unit}` });
        return line.replace(rawValue, String(quantity.value));
      });
      if (!matched) missing.push(`${quantityName} ${quantity.value}${unit}`);
      continue;
    }
    if (param.path === 'data.resources.labor.peak_value') {
      const peakValue = data.resources.labor.peakValue;
      if (peakValue <= 0) continue;
      // 峰值形态覆盖：「高峰人数 N 人」「峰值 N 人」「劳动力总人数 N 人」「各专业班组高峰人数合计为 N 人」
      // ——只替换数值本身、不动句式（「合计为/控制在」等隔断词不阻断锚定，替换后句式仍成立）
      const peakRe = /(?:高峰(?:期)?(?:人数)?|峰值|劳动力(?:总人数|峰值)|各专业班组高峰人数)[^。；;\n]{0,24}?(?:约)?\s*([\d,]+)\s*人/gu;
      let matched = false;
      result = result.replace(peakRe, (line, rawValue: string) => {
        matched = true;
        const value = Number(String(rawValue).replace(/,/g, ''));
        if (!Number.isFinite(value) || value === peakValue || value <= 0) return line;
        fixed.push({ anchor: '劳动力峰值', from: `${rawValue}人`, to: `${peakValue}人` });
        return line.replace(rawValue, String(peakValue));
      });
      if (!matched) missing.push(`劳动力峰值 ${peakValue} 人`);
      continue;
    }
    if (param.path === 'data.redline.greening_maintenance') {
      // 养护期权威：redLineFacts「绿化养护期=二级养护，养护二年」提取年数，正文「养护…X年」与权威不一致时回填
      const maintenanceFact = data.redLineFacts.find(fact => /养护/u.test(fact.key));
      if (!maintenanceFact) continue;
      const authorityMatch = /养护[^。；;|]{0,10}?([一二两三四五六七八九十]+|\d{1,2})\s*年/u.exec(maintenanceFact.value);
      if (!authorityMatch) continue;
      const authorityYears = parseChineseNumber(authorityMatch[1] ?? '');
      if (authorityYears === undefined || !Number.isFinite(authorityYears) || authorityYears <= 0) continue;
      const yearRe = /养护[^。；;\n|]{0,16}?([一二两三四五六七八九十]+|\d{1,2})\s*年/gu;
      let matched = false;
      result = result.replace(yearRe, (line, rawValue: string) => {
        matched = true;
        const value = parseChineseNumber(rawValue);
        if (value === undefined || !Number.isFinite(value) || value === authorityYears || value <= 0) return line;
        fixed.push({ anchor: '养护期', from: `${rawValue}年`, to: `${authorityYears}年` });
        return line.replace(rawValue, String(authorityYears));
      });
      if (!matched) missing.push(`养护期 ${authorityYears} 年`);
      continue;
    }
  }
  return { markdown: result, fixed, missing };
}

/** 章切片 must_cite+strict 参数渲染为「必须引用的数值清单」
 * （块质检第二轮反馈挂接用：未引用时定向反馈重试，不盲目重写） */
export function renderBlueprintMustCiteValues(chapter: BlueprintChapter, data: BlueprintData): string {
  const seen = new Set<string>();
  const values: string[] = [];
  const mustCiteStrict = chapter.subSections.flatMap(section => section.requiredParams.filter(param => param.mode === 'must_cite' && param.strict));
  for (const param of mustCiteStrict) {
    if (seen.has(param.path)) continue;
    seen.add(param.path);
    if (param.path === 'data.contract.total_days' && data.contract.totalDays > 0) {
      values.push(`总工期 ${data.contract.totalDays} 日历天`);
      continue;
    }
    if (param.path.startsWith('data.quantities.')) {
      const quantity = data.quantities[param.path.slice('data.quantities.'.length)];
      if (quantity && quantity.value > 0) values.push(`${param.path.slice('data.quantities.'.length)} ${quantity.value}${quantity.unit}`);
    }
  }
  return values.join('；');
}

// ═══════════════════════════════ 三期收口：章规划确定性转换 + 蓝图引用一致性 ═══════════════════════════════
// （原 blueprintPlanAuthorities 蓝图权威映射已删除：V5 P4 起权威由 AuthorityIndex 全量投影机制生成，见 authorityIndex.ts）

// ── 章规划结构（三期收口：原 chapterPlanner 确定性逻辑移入蓝图模块，LLM 章规划删除）──
// 蓝图章切片（sub_sections + work_packages）确定性转换为「主题块 + H4 要点」执行结构；
// 蓝图切片不可用时按语义域分组确定性回退（永不回退逐小节碎片化成稿）。

export interface PlannedChapterSubPoint {
  /** H4 要点标题（成稿时作为四级小节标题） */
  title: string;
  /** 本 H4 覆盖的输入细目原文（逐字；多条 = 语义合并，覆盖校验与溯源用） */
  sources: string[];
}

export interface PlannedChapterBlock {
  /** 三级主题块标题（目录级小节） */
  title: string;
  /** 本块必须输出的 H4 要点 */
  subPoints: PlannedChapterSubPoint[];
  /** 分配给本块的事实线索（证据关键句，≤60 字/条，来自绑定资料原文） */
  facts: string[];
  /** 本块目标字数（1200~4000） */
  targetWords: number;
  /** 单要点大块拆分后的半块内容分工指令（两半块共享同一要点时靠此指令区分内容边界） */
  halfFocus?: string;
}

export interface PlannedChapterStructure {
  blocks: PlannedChapterBlock[];
  /** 已被映射的输入细目 */
  coveredSections: string[];
  /** 未映射成功、由兜底逻辑挂回的输入细目 */
  fallbackSections: string[];
}

/** 主题块内 H4 要点上限：超过则切分新块，控制单次调用输出量 */
const MAX_SUB_POINTS_PER_BLOCK = 6;
/** 主题块最小/最大目标字数 */
const MIN_BLOCK_TARGET_WORDS = 1200;
const MAX_BLOCK_TARGET_WORDS = 4000;

/** 单位工程多工作包语义化切块：按主题域聚合工作包（域序 = 首现序，同域非相邻包聚合进同一域块防同名），
 * 每域一块；域内超过单块要点上限时续块标题用「单位工程短名+块内首工作包名」——首工作包裸名会跨
 * 单位工程撞名（「零星装饰工程」×4），命名治理器补拼 base 后全局唯一（清单原生名，目录友好） */
function buildThemedBlocksForSubSection(subSectionTitle: string, subPoints: PlannedChapterSubPoint[]): PlannedChapterBlock[] {
  const base = subSectionTitle.replace(/工程$/u, '');
  const groups: Array<{ label: string; points: PlannedChapterSubPoint[] }> = [];
  const groupIndex = new Map<string, number>();
  for (const point of subPoints) {
    const label = workPackageThemeLabel(point.title);
    let index = groupIndex.get(label);
    if (index === undefined) {
      index = groups.length;
      groupIndex.set(label, index);
      groups.push({ label, points: [] });
    }
    groups[index]!.points.push(point);
  }
  const blocks: PlannedChapterBlock[] = [];
  for (const group of groups) {
    for (let offset = 0; offset < group.points.length; offset += MAX_SUB_POINTS_PER_BLOCK) {
      const chunk = group.points.slice(offset, offset + MAX_SUB_POINTS_PER_BLOCK);
      // 拼接命名过长公共串消除（「装饰」+「装饰装修工程」不再产生「装饰装饰装修工程」）
      const title = offset === 0 ? composeBlockTitle(base, group.label) : composeBlockTitle(base, chunk[0]!.title);
      blocks.push({ title, subPoints: chunk, facts: [], targetWords: MIN_BLOCK_TARGET_WORDS });
    }
  }
  return blocks;
}

/** 二字滑窗重叠率：衡量两个标题的语义近似程度（挂接兜底用） */
function bigramOverlap(left: string, right: string) {
  const bigrams = (text: string) => {
    const set = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
    return set;
  };
  const target = bigrams(right);
  const source = [...bigrams(left)];
  if (source.length === 0) return 0;
  return source.filter(pair => target.has(pair)).length / source.length;
}

/** 小节语义域：确定性回退分组用 */
function sectionDomain(sectionTitle: string) {
  if (/工期|进度|节点|计划|纠偏|预警/u.test(sectionTitle)) return '工期进度';
  if (/质量|验收|三检|样板|隐蔽|复试|实测|通病/u.test(sectionTitle)) return '质量验收';
  if (/安全|危大|风险|隐患|应急|临边|洞口|消防|临电/u.test(sectionTitle)) return '安全风险';
  if (/文明|扬尘|噪声|绿色|废水|垃圾|环保|智慧/u.test(sectionTitle)) return '文明绿色';
  if (/劳务|工资|实名|银行|考勤|人员|岗位|组织|职责/u.test(sectionTitle)) return '组织劳务';
  if (/资源|材料|设备|机械|人材机|调配/u.test(sectionTitle)) return '资源保障';
  if (/施工|工艺|流程|顺序|穿插|部署|区段|流水/u.test(sectionTitle)) return '施工组织';
  return '综合管理';
}

/** 人材机三合一章资源三小节判定（结构补挂产物）：必须各自独立成主题块（H3）与 H4 要点，不得被语义域分组合并吞并 */
function isResourceTriadSection(title: string) {
  return /^(?:确保\s*)?[人材机](?:员|力|料|械|工)?\s*的保障体系与措施$/u.test(title);
}

/** 细目文本匹配：去空白后相等或互相包含 */
function sameSectionText(left: string, right: string) {
  const a = left.replace(/\s+/gu, '');
  const b = right.replace(/\s+/gu, '');
  return a === b || a.includes(b) || b.includes(a);
}

/** 按 subPoints 数量加权分配每块目标字数（基数=章目标/块数，浮动 ±25%，封顶 1200~4000）；
 * 长文目标下达：章目标/块数超过单块安全上限时，按 H4 要点对半拆分大块直到均分目标不超上限 */
function allocateBlockTargetWords(blocks: PlannedChapterBlock[], targetWords: number, chapterTitle: string) {
  const maxSplitRounds = 2;
  for (let round = 0; round < maxSplitRounds && blocks.length > 0; round += 1) {
    const perBlock = Math.floor(targetWords / blocks.length);
    if (perBlock <= MAX_BLOCK_TARGET_WORDS) break;
    // 容器块不参与字数上限拆块：其输出单元是工作包 H4 × 三要素，对半拆后新块标题
    // 变为骨架名（容器语义丢失 → 骨架锁定不触发 → 三要素丢失），字数上限场景按其他块拆
    const splittable = blocks.filter(block => block.subPoints.length >= 2 && !isContainerSectionTitle(block.title));
    if (splittable.length === 0) break;
    const biggest = splittable.reduce((left, right) => (right.subPoints.length > left.subPoints.length ? right : left));
    const mid = Math.ceil(biggest.subPoints.length / 2);
    blocks.push({ title: biggest.subPoints[mid].title || biggest.title, subPoints: biggest.subPoints.slice(mid), facts: [], targetWords: 0 });
    biggest.subPoints = biggest.subPoints.slice(0, mid);
  }
  // P2.5 小块下限动态化：蓝图分部章（清单分部逐个成块，块数可达 20+）每块目标为章目标均分
  //（如 8000/23≈348 字），固定 1200 下限会把章字数膨胀到 27600+（块达标线=块目标，全文字数雪崩）；
  // 分部块下限 400 字（每块三要素概览足够），普通章保持 1200 下限；
  // 4.19.8 收口（丰乐镇第三轮实测）：分部章 11 块（>8 但 ≤12）时旧判定 blocks.length>12 不命中，
  // 小分部块（楼地面装饰/亮化工程）目标 1200、达标线 1080，清单事实支撑不足 → 反复重试耗尽 →
  // 「主要施工方法」章失败；判定改为章标题匹配分部章 + 小块数 ≥8 + 每块要点 ≤3（小分部三要素概览形态）
  // 容器块（展开后 subPoints≥3）自带 3600 保底，不参与判定（否则 every 判定被容器块拖垮回 1200）
  const smallBlocks = blocks.filter(block => !isContainerSectionTitle(block.title));
  const divisionStyleChapter = DIVISION_SECTION_RE.test(chapterTitle) && smallBlocks.length >= 8 && smallBlocks.length > 0 && smallBlocks.every(block => block.subPoints.length <= 3);
  const minTarget = divisionStyleChapter ? 400 : MIN_BLOCK_TARGET_WORDS;
  const totalPoints = blocks.reduce((sum, block) => sum + block.subPoints.length, 0) || blocks.length;
  for (const block of blocks) {
    const base = Math.max(minTarget, Math.floor(targetWords / Math.max(1, blocks.length)));
    const weighted = Math.floor((base * 0.75) + (targetWords * 0.25) * (block.subPoints.length / totalPoints));
    block.targetWords = Math.min(MAX_BLOCK_TARGET_WORDS, Math.max(minTarget, weighted));
    // 容器小节块预算保底：工作包容器（项目主要施工内容/主要分部分项工程施工方案）内部
    // 承载多个骨架工作包三要素正文（每包 ≥300 字），块预算低于 3600 时工作包被摊薄
    if (MAJOR_CONTENT_SECTION_RE.test(block.title) || DIVISION_SECTION_RE.test(block.title)) block.targetWords = Math.min(MAX_BLOCK_TARGET_WORDS, Math.max(block.targetWords, 3600));
  }
}

/** 关键施工容器块判定（项目主要施工内容/主要分部分项工程施工方案）：其真实输出单元是
 * 写作层骨架锁定的工作包 H4（每包 × 三要素），与普通单要点块的结构语义不同 */
function isContainerSectionTitle(title: string) {
  return MAJOR_CONTENT_SECTION_RE.test(title) || DIVISION_SECTION_RE.test(title);
}

/** 骨架名去重合并（与 majorConstructionSkeletonNames 同口径的去空白包含比较），并按上限截断 */
function mergeUniqueSkeletonNames(names: string[], cap: number): string[] {
  const merged: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    const compact = name.replace(/\s+/gu, '');
    if (!compact || /^其他$|^其它$|^其他工程$|^其余/u.test(compact)) continue;
    if (merged.some(existing => {
      const existingCompact = existing.replace(/\s+/gu, '');
      return existingCompact.includes(compact) || compact.includes(existingCompact);
    })) continue;
    merged.push(name);
    if (merged.length >= cap) break;
  }
  return merged;
}

/** 单要点大块确定性拆分（丰乐镇实测）：subPoints===1 且 targetWords>2400 的大块拆为两个半块
 * （目标减半+分工指令），半块达标线落在模型单次输出能力内。
 * 丰乐镇三期验收实测：关键施工容器块（项目主要施工内容）拆半后 halfFocus「只写本部分内容，
 * 不得涉及后半部分的具体展开」与骨架锁定三要素硬要求冲突，模型每包只写「施工流程」一段带过，
 * 三要素丢两要素——容器块真实输出单元是工作包 H4（每包 ≥300 字 × 三要素），拆半在错误粒度操作，
 * 容器块一律不拆半（骨架展开后 subPoints≥3 天然免疫，此处为骨架名提取不足时的双保险） */
export function splitSinglePointOversizedBlocks(structure: PlannedChapterStructure): PlannedChapterStructure {
  const oversized = structure.blocks.some(block => block.subPoints.length === 1 && block.targetWords > 2400 && !isContainerSectionTitle(block.title));
  if (!oversized) return structure;
  const blocks = structure.blocks.flatMap(block => {
    if (block.subPoints.length !== 1 || block.targetWords <= 2400 || isContainerSectionTitle(block.title)) return [block];
    const halfTarget = Math.max(1200, Math.floor(block.targetWords / 2));
    // 两半块共享父块标题（不加「（一）（二）」后缀）：写作层章级拼接按相邻同标题剥离后块 H3 外壳
    // 合并为一个小节，目录不出现防撞名后缀（历史缺陷：拆半标题加后缀 → 后缀泄漏进目录）
    return [
      { ...block, targetWords: halfTarget, halfFocus: '本部分为该主题的前半部分，聚焦总体构成与组织框架：逐项列明构成要素、总体规模指标与组织方式；只写本部分内容，不得涉及后半部分的具体展开。' },
      { ...block, targetWords: halfTarget, halfFocus: '本部分为该主题的后半部分，聚焦具体展开与实施要求：逐项展开实施内容、工艺要求与衔接安排；只写本部分内容，不得重复前半部分的总体框架。' },
    ];
  });
  return { ...structure, blocks };
}

/** 确定性回退结构：蓝图切片不可用时按语义域分组，域内高相似细目合并进同一 H4（每块 ≤6 个 H4）；
 * 块顺序严格保持 inputSections 原顺序（域块取该域首次出现位置）——历史实现把人材机/容器块
 * 无条件前置，推翻了规划层 prioritizeOverviewSections 的调序（第一章 1.1 应为「编制说明与工程概况」） */
export function fallbackStructureForSections(inputSections: string[], chapterTitle: string, targetWords: number): PlannedChapterStructure {
  const byDomain = new Map<string, string[]>();
  // 成块单元顺序：人材机三小节与工作包容器小节各自独立成块（H3），普通小节按语义域聚合成块；
  // 单元按 inputSections 首次出现顺序登记（域块位置 = 该域第一个小节的位置）
  const unitOrder: Array<{ kind: 'solo'; section: string } | { kind: 'domain'; key: string }> = [];
  for (const section of inputSections) {
    if (isResourceTriadSection(section) || MAJOR_CONTENT_SECTION_RE.test(section) || DIVISION_SECTION_RE.test(section)) {
      unitOrder.push({ kind: 'solo', section });
      continue;
    }
    const key = sectionDomain(section);
    if (!byDomain.has(key)) {
      byDomain.set(key, []);
      unitOrder.push({ kind: 'domain', key });
    }
    byDomain.get(key)!.push(section);
  }
  // 域内确定性合并：与上一条细目互为包含或二字滑窗重叠率 ≥75% 时并入同一 H4（无 LLM 可用时仍保持目录瘦身）；评标必查细目不参与合并
  const mergeDomainSections = (items: string[]): PlannedChapterSubPoint[] => {
    const merged: PlannedChapterSubPoint[] = [];
    for (const section of items) {
      const last = merged[merged.length - 1];
      const lastSource = last ? last.sources[last.sources.length - 1] : '';
      if (!isCriticalSectionTitle(section) && !isResourceTriadSection(section) && last && (sameSectionText(section, lastSource) || bigramOverlap(section, lastSource) >= 0.75)) {
        last.sources.push(section);
        if (section.length > last.title.length) last.title = section;
      } else {
        merged.push({ title: section, sources: [section] });
      }
    }
    return merged;
  };
  const blocks: PlannedChapterBlock[] = [];
  for (const unit of unitOrder) {
    if (unit.kind === 'solo') {
      blocks.push({ title: unit.section, subPoints: [{ title: unit.section, sources: [unit.section] }], facts: [], targetWords: MIN_BLOCK_TARGET_WORDS });
      continue;
    }
    const mergedPoints = mergeDomainSections(byDomain.get(unit.key) || []);
    for (let offset = 0; offset < mergedPoints.length; offset += MAX_SUB_POINTS_PER_BLOCK) {
      const chunk = mergedPoints.slice(offset, offset + MAX_SUB_POINTS_PER_BLOCK);
      blocks.push({ title: chunk[0].title || chapterTitle, subPoints: chunk, facts: [], targetWords: MIN_BLOCK_TARGET_WORDS });
    }
  }
  // 章目标按块数+点数加权重分配（与蓝图切片转换路径同口径）
  allocateBlockTargetWords(blocks, targetWords, chapterTitle);
  return { blocks, coveredSections: inputSections.slice(), fallbackSections: [] };
}

/**
 * 章规划结构确定性转换（三期收口：蓝图唯一规划路径，LLM 章规划删除）：
 * 蓝图章切片存在 → 每个 sub_section 一个主题块、每个工作包一个 H4 要点（工作包名即要点标题）；
 * 切片缺失 → fallbackStructureForSections 语义域分组兜底（确定性内部回退，永不回退逐小节碎片化）。
 * 三期验收两处写作根因修正：
 * 1. 模板小节零丢失——蓝图路径覆盖不到的模板小节不再只统计不挂回，语义域分组挂回为追加主题块；
 * 2. 容器块骨架同源——提供 projectContext/evidence 时，关键施工容器块的 H4 要点改用
 *    majorConstructionSkeletonNames 展开（与写作层骨架锁定同源提取），拆半不再发生在错误粒度。
 */
export function buildChapterStructureFromBlueprint(input: {
  blueprintChapter?: BlueprintChapter;
  inputSections: string[];
  chapterTitle: string;
  targetWords: number;
  /** 容器小节骨架展开输入（可选）：提供后，关键施工容器块的工作包 H4 名与写作层骨架锁定同源 */
  projectContext?: string;
  evidence?: DocumentEvidence[];
}): PlannedChapterStructure {
  const { blueprintChapter, inputSections, chapterTitle, targetWords } = input;
  let blocks: PlannedChapterBlock[] = [];
  let coveredSections: string[] = [];
  let fallbackSections: string[];
  if (!blueprintChapter || blueprintChapter.subSections.length === 0) {
    const fallback = fallbackStructureForSections(inputSections, chapterTitle, targetWords);
    blocks = fallback.blocks;
    coveredSections = fallback.coveredSections;
    fallbackSections = fallback.fallbackSections;
  } else {
    for (const subSection of blueprintChapter.subSections) {
      const subPoints: PlannedChapterSubPoint[] = subSection.workPackages.map(workPackage => ({ title: workPackage.name, sources: [workPackage.name] }));
      if (subPoints.length > MAX_SUB_POINTS_PER_BLOCK) {
        // 单位工程多工作包按主题域语义化切块（「公厕结构与基础工程」），杜绝「公厕（1）（2）」防撞名泄漏目录
        blocks.push(...buildThemedBlocksForSubSection(subSection.title, subPoints));
      } else {
        blocks.push({ title: subSection.title, subPoints, facts: [], targetWords: MIN_BLOCK_TARGET_WORDS });
      }
    }
    if (blocks.length === 0) {
      const fallback = fallbackStructureForSections(inputSections, chapterTitle, targetWords);
      blocks = fallback.blocks;
      coveredSections = fallback.coveredSections;
      fallbackSections = fallback.fallbackSections;
    } else {
      coveredSections = inputSections.filter(section => blocks.some(block => sameSectionText(block.title, section) || block.subPoints.some(point => point.sources.some(source => sameSectionText(source, section)) || sameSectionText(point.title, section))));
      fallbackSections = inputSections.filter(section => !coveredSections.includes(section));
    }
  }
  // 模板小节零丢失：蓝图路径覆盖不到的模板小节（如「市政工程专项施工工艺」）语义域分组挂回为追加主题块
  if (fallbackSections.length > 0) {
    const appendedBlocks = fallbackStructureForSections(fallbackSections, chapterTitle, targetWords).blocks;
    for (const block of appendedBlocks) {
      const duplicated = blocks.some(existing => sameSectionText(existing.title, block.title)
        || block.subPoints.some(point => existing.subPoints.some(existingPoint => sameSectionText(existingPoint.title, point.title))));
      if (!duplicated) blocks.push(block);
    }
    coveredSections = [...coveredSections, ...fallbackSections];
    fallbackSections = [];
  }
  // 容器块骨架同源展开：关键施工容器块的真实输出单元是工作包 H4（三要素正文），
  // 块规划层用与写作层骨架锁定同一提取函数把 H4 名铺进 subPoints——两套结构同源后，
  // 拆半不再发生在容器块（subPoints≥3），halfFocus 不再与三要素硬要求冲突；
  // 三期验收回归：蓝图 outline 章切片的分部清单（模板大纲确定性解析产物）作为第四来源兑底——
  // 上下文瘦身/证据缺失时三来源全部哑火，容器块不展开 → LLM 自由发挥 → 三要素丢失
  if (input.projectContext && input.evidence) {
    const context = input.projectContext;
    const evidence = input.evidence;
    // P2.5 分部章容器块不展开蓝图分部名：本章蓝图分部名已独立成块（每分部一块），
    // 容器小节（「主要分部分项工程施工方案」模板细目挂回块）再展开同名单会与分部块重复成稿
    //（同一分部写两遍）——分部章的容器块只保留三来源骨架名，不足时退化为概述块
    const outlineNames = DIVISION_SECTION_RE.test(chapterTitle) ? [] : (input.blueprintChapter?.subSections ?? []).map(subSection => subSection.title);
    // P2.7 分部章容器块展开排除分部块标题（P0 验收实测）：三来源骨架名含与蓝图分部同名的工作包
    // （景观工程/绿化工程等）→ 容器块展开后与分部块重复成稿，且写作层 otherBlockTitleSet 会把
    // 这些 H4 判清单外 → 容器块双重必败；与 P2.5「分部章容器块不展开蓝图分部名」同口径：
    // 已独立成块的分部名一律不展开，展开后不足 minCount 即退化为概述块（要素融合提示词接管）
    const divisionBlockTitleSet = DIVISION_SECTION_RE.test(chapterTitle)
      ? new Set(blocks.map(block => normalizeSubsectionTitleForDedup(block.title)).filter(Boolean))
      : new Set<string>();
    blocks = blocks.map(block => {
      if (!isContainerSectionTitle(block.title)) return block;
      // 4.19.5 回归（丰乐镇第二轮验收）：分部章的分部容器块（「主要分部分项工程施工方案」在
      // 「主要施工方法」章内）不展开任何骨架名——本章分部已独立成块，容器块是全章总述小节。
      // 4.19.4 只过滤与分部块同名的骨架名，剩余子特征骨架名（生态池/连接路等，实为分部块内部
      // 工序粒度）仍会展开 → 诱导 LLM 在容器块内复写分部方案（清单外+三要素重复）→
      // 两轮重试+确定性兜底全灭 → 章阻断。容器块保持单要点，写作层对其下发总述提示词（正文直接展开）。
      if (DIVISION_SECTION_RE.test(chapterTitle) && DIVISION_SECTION_RE.test(block.title)) return block;
      const skeletonNames = mergeUniqueSkeletonNames([
        ...majorConstructionSkeletonNames(context, evidence).filter(name => {
          // 4.19.3 回归：骨架名带「3、绿化工程」/「三、绿化工程」式编号+分隔符前缀时，
          // normalizeSubsectionTitleForDedup 剥编号正则（只剥数字+点/空格紧跟）不命中中文编号形态 →
          // 归一化残留编号 → 与分部块标题「绿化工程」不等 → 漏过滤 → 容器块展开分部名 H4 →
          // 与章内分部块 H3 同名 → finalize 串章骨架清理整块删除 → 容器块成空壳。
          // 先剥「编号（含中文数字）+分隔符」前缀再归一化，与分部块标题同口径比较。
          const bare = name.replace(/^[一二三四五六七八九十百\d]+[、.．\s:：-]+/u, '');
          return !divisionBlockTitleSet.has(normalizeSubsectionTitleForDedup(bare));
        }),
        ...outlineNames,
      ], 12);
      if (skeletonNames.length < 3) return block;
      return { ...block, subPoints: skeletonNames.map(name => ({ title: name, sources: [name] })) };
    });
  }
  // 命名治理收口（L1）：章内块标题唯一化——重名者注入序号兜底（极端：续块首包名与域标签同名）
  const governedTitles = disambiguateBlockTitles(blocks.map(block => ({ title: block.title })));
  blocks.forEach((block, index) => { block.title = governedTitles[index]!; });
  // 章目标按最终块集+点数加权重分配（挂回/展开后统一重分配，幂等）
  allocateBlockTargetWords(blocks, targetWords, chapterTitle);
  // C1 管线收敛补齐：空章节确定性兜底（模板细目被大纲主题过滤全部剔除、且无蓝图切片时，
  // 语义域分组无输入可聚 → blocks 为空素下游规划块管线无块可写将阻断整章）。退化为
  // 「整章单块」结构：块标题=章标题、无 H4 要点（正文直接展开），块目标=整章目标（封顶 4000 字）——
  // 保证章节无论小节数（0/1/2/5/30）恒有确定性成稿路径，不再因 blocks=[] 阻断
  if (blocks.length === 0 && chapterTitle.trim()) {
    blocks = [{ title: chapterTitle, subPoints: [], facts: [], targetWords: Math.min(MAX_BLOCK_TARGET_WORDS, Math.max(MIN_BLOCK_TARGET_WORDS, targetWords)) }];
  }
  return { blocks, coveredSections, fallbackSections };
}

/**
 * 蓝图引用一致性质检（三期收口项 3）：执行后全文扫正文数值与蓝图 data/红线事实比对
 * （改造现有跨章一致性检测，权威源为蓝图参数桶）。
 * 总工期/关键工程量：出现与蓝图不一致的取值即 error（修复链定向修复）；
 * 红线事实（非金额）：正文未体现即 warning（缺口观测，不阻断）。
 */
export function blueprintCitationConsistencyIssues(markdown: string, data: BlueprintData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nonTable = markdown.split('\n').filter(line => !/^\s*\|/u.test(line.trim())).join('\n');
  if (data.resources.labor.peakValue > 0) {
    const laborRe = /(?:劳动力峰值|施工高峰|高峰人数|高峰期劳动力|劳动力高峰)(?:为|约|达到|共计)?[^\n。；;]{0,20}?(\d+(?:\.\d+)?)\s*人/gu;
    for (const match of nonTable.matchAll(laborRe)) {
      const value = Number(match[1]);
      if (value > 0 && value !== data.resources.labor.peakValue) {
        issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图引用冲突：正文出现与蓝图不一致的劳动力峰值 ${value} 人`, suggestion: `请统一使用蓝图劳动力峰值：${data.resources.labor.peakValue} 人` });
        break;
      }
    }
  }
  if (data.contract.totalDays > 0) {
    const dayRe = /(?:总工期|施工工期|合同工期|工期)(?:为|约|共计|控制)?[^\n。；;]{0,20}?(\d+(?:\.\d+)?)\s*(?:日历)?天/gu;
    for (const match of nonTable.matchAll(dayRe)) {
      // 阶段细分/管理阈值豁免（与修复器 fixCrossSectionNumericConflicts「scheduleDays」域同源）：
      // 数字前窗口 = match 前 16 字 + match 内数字前文本，覆盖 match 外语境——「该阶段工期仅10天」
      // 的「阶段」（run1 实测「10日历天」误报）、「工期延误超过16天」阈值与「总工期目标分解为29天」
      // 细分链（run1 全量穷举实测）均不判总工期冲突；数字定位取 match 内偏移防窗口内重复数字错位
      const dayWindowStart = Math.max(0, (match.index ?? 0) - 16);
      const dayWindow = nonTable.slice(dayWindowStart, (match.index ?? 0) + match[0].length);
      const dayDigitAt = (match.index ?? 0) - dayWindowStart + match[0].indexOf(String(match[1]));
      if (dayDigitAt > 0 && /按|阶段|拆除|清杂|准备|第\d+日|至第|集中|延误|滞后|分解/u.test(dayWindow.slice(0, dayDigitAt))) continue;
      const value = Number(match[1]);
      if (value > 0 && value !== data.contract.totalDays) {
        issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图引用冲突：正文出现与蓝图不一致的工期表述 ${value}日历天`, suggestion: `请统一使用蓝图总工期：${data.contract.totalDays} 日历天` });
        break;
      }
    }
  }
  for (const fact of data.redLineFacts.filter(item => !item.amount && item.key !== '自然村数量')) {
    // 子串片段匹配（零漂移实测）：事实值为多段串（「二级养护，养护二年」「一般路灯 100W LED
    // 高4.5m 含基础」）时全串匹配必失败——按标点切片段，任一实质片段在正文出现即视为已体现；
    // 泛化空壳片段（其他/具体详见/满足设计要求/纯编号）剔除，防误判体现
    const parts = String(fact.value)
      .split(/[，。；、（）()\]【】：:\s\n[]+/u)
      .map(part => part.trim())
      .filter(part => part.length >= 3
        && !/^[\d.]+$/u.test(part)
        && !/^(?:其他|具体详见|满足设计要求|设计图纸|图集|招标文件|政府相关文件|规范等|资料)$/u.test(part));
    if (parts.length === 0) continue;
    if (!parts.some(part => markdown.includes(part))) {
      issues.push({ level: 'warning', severity: 'warning', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图红线事实缺口：正文未体现「${fact.key}=${fact.value}」`, suggestion: `请在对应章节补写该红线事实（数值必须与蓝图一致）` });
    }
  }
  // 自然村数量（P2.4）：红线事实专项 error 检测——正文出现与蓝图不一致的村数（如跨项目残留「9 个自然村」）即 error
  const villageFact = data.redLineFacts.find(fact => fact.key === '自然村数量');
  const villageAuthority = villageFact ? Number(/(\d+)/u.exec(villageFact.value)?.[1]) : 0;
  if (villageAuthority > 0) {
    const villageRe = /(\d+)\s*个(?:美丽宜居)?自然村(?!分组)/gu;
    for (const match of nonTable.matchAll(villageRe)) {
      // 分区数学豁免（与修复器 villageRe 同源）：数值前 16 字含片区/分为/分成/划分为/每组/每片
      // 是分区数学（「每个片区包含4个自然村」20=5×4）而非村数冲突，不报
      const villageBefore = nonTable.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
      // 分配口径豁免（零漂移实测）：「每台覆盖4个自然村」「每个组3个自然村」是资源分配语境
      if (/片区|分为|分成|划分为|每组|每片|每台|每个|各台|各车|每村/u.test(villageBefore)) continue;
      const value = Number(match[1]);
      if (value > 0 && value !== villageAuthority) {
        issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图红线事实冲突：正文出现与蓝图不一致的自然村数量 ${value} 个`, suggestion: `请统一使用蓝图自然村数量：${villageAuthority} 个自然村` });
        break;
      }
    }
  }
  // 工程量冲突检测：与 fixQuantityAuthorityConflicts 同源豁免（村名/分部语境 + 规格限定 +
  // 分部量句句级豁免）——检测定位=修复定位，修复器豁免的合法形态检测器不得报错，
  // 否则分部量（公厕塑料管铺设7.8m）被误报为冲突且 LLM 修复轮修不掉，导出门禁残留阻断
  const quantityCandidates: Array<{ name: string; value: number; unit: string; authorityValue: number; ns: number }> = [];
  const quantityAnchors: Array<{ ns: number }> = [];
  // 长名优先 + occupied 防重叠（与修复器 fixQuantityAuthorityConflicts 同源）：蓝图
  // 「塑料管铺设」与「塑料管」并存时，正文「塑料管铺设8205.53m」只归长条目，不被短名
  // 「塑料管 7525.01」误报（零漂移实测误报根因）
  const quantityEntries = Object.entries(data.quantities).sort((a, b) => b[0].length - a[0].length);
  const quantityOccupied: Array<{ start: number; end: number }> = [];
  for (const [name, quantity] of quantityEntries) {
    if (!quantity || quantity.value <= 0) continue;
    const unit = quantity.unit || '';
    // 单位变体归一（与修复器 quantityUnitVariants 同源，零漂移实测）：清单 m2/m3/t 与正文
    // 上标写法（m²/㎡/m³）同义——未归一时上标值不入候选、分部拆分豁免无法触发（压膜 404.4 误报根因）；
    // 右边界断言排除「直径不小于10m」类 10mm 的 m 子串误匹配（丰乐镇实测误报根因）
    const unitSuffix = unit ? `${quantityUnitDetectVariants(unit)}(?![0-9A-Za-z])` : '';
    // 名字出现即占位（与修复器 fixQuantityAuthorityConflicts 同构，run1 实测）：长名引用位置
    // 即使清单单位与正文异构（「人行道混凝土垫层424.6m²」长名清单 m3 vs 正文 m²）也由长名
    // 占用，短名（「混凝土垫层」600 口径）不得把该位置的 424.6 误绑到自身（跨条目误报根因）；
    // 跨枚举项取数（「配电箱…AF1为非标箱，距地1400，共1台」的 1400）由窗口截断同源排除
    const nameRe = new RegExp(escapeRegexForAlign(name), 'gu');
    for (const nameMatch of nonTable.matchAll(nameRe)) {
      const ns = nameMatch.index ?? 0;
      const ne = ns + name.length;
      if (quantityOccupied.some(o => ns < o.end && ne > o.start)) continue;
      quantityOccupied.push({ start: ns, end: ne });
      // 值窗口（与修复器窗口截断同源）：名后 40 字、截断于列举分隔符/换行，取第一个「数值+本单位」
      // （左边界断言排除数字串截取，与修复器 unitRe 同源）
      const rawWindow = nonTable.slice(ne, ne + 40);
      const windowStop = Math.min(...[rawWindow.search(/[、。；;，,\n]/u)].filter(pos => pos >= 0).concat([rawWindow.length]));
      const window = rawWindow.slice(0, windowStop);
      const valueRe = new RegExp(`(?<![\\dA-Za-z])(\\d+(?:\\.\\d+)?)\\s*${unitSuffix}`, 'u');
      const match = valueRe.exec(window);
      if (!match) continue;
      // 规格句豁免：名称与数值间出现间距/直径等规格限定词是规格表述非工程量
      // （「立柱间距不大于1200」「直径不小于10m」丰乐镇实测误报根因）
      const windowText = nonTable.slice(ns, ne + (match.index ?? 0) + match[0].length);
      const digitAt = windowText.lastIndexOf(String(match[1]));
      if (digitAt > 0 && /(?:间距|不大于|不小于|≥|≤|直径|宽度|厚度|高度|深度|坡度)[^0-9]*$/u.test(windowText.slice(0, digitAt))) continue;
      // 村名/分部语境豁免（与修复器 VILLAGE_LOCATION_HINT_RE 同源）：名称前 12 字内含
      // 村级地名/分部特征词是分村分表合法量（「化粪池2座…塑料管铺设7.8m」的 池 语境）
      const prefix = nonTable.slice(Math.max(0, ns - 12), ns);
      if (/[郢庄岗塘圩坝池井]/u.test(prefix)) continue;
      // 段落级村名豁免（与修复器 VILLAGE_PARAGRAPH_HINT_RE 同源）：村名列表距条目名远超 12 字窗口
      // 时整段不报（“殷郢组…本分项工程量为：…挖基坑土方42.12m³”分村合法量）
      const paraStartIdx = nonTable.lastIndexOf('\n\n', ns);
      const paraFrom = paraStartIdx === -1 ? 0 : paraStartIdx + 2;
      const paraEndIdx = nonTable.indexOf('\n\n', ns);
      const paraTo = paraEndIdx === -1 ? nonTable.length : paraEndIdx;
      if (/[郢庄岗塘圩坝]/u.test(nonTable.slice(paraFrom, paraTo))) continue;
      // 规格限定词豁免（与修复器 SPEC_QUALIFIER_RE 同源：前置直径450/后置DN200）
      if (/(?:直径|DN|Φ|φ)\\s*\\d+/u.test(nonTable.slice(Math.max(0, ns - 8), ns))) continue;
      if (/(?:直径|DN|Φ|φ)\\s*\\d+/u.test(nonTable.slice(ns + name.length, ns + name.length + 8))) continue;
      const value = Number(match[1]);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (value === quantity.value) { quantityAnchors.push({ ns }); continue; }
      // 分村/分工程明细值豁免（V5 P1 groups 同源，与修复器 isGroupValue 同口径，run1 实测 15 条
      // 「分单体值 vs 全项目合计」误报全源——检测器此前未同步修复器豁免，检测/修复口径漂移）：
      // 值 ∈ 蓝图分项明细集（公共广场 36 台等）是分项引用合法形态，不判冲突
      if ((quantity.groups ?? []).some(group => Math.abs(group.value - value) < 1e-6)) continue;
      quantityCandidates.push({ name, value, unit, authorityValue: quantity.value, ns });
    }
  }
  // 分部量句句级豁免（与修复器同源）：句内不一致候选 ≥2 且存在与权威一致的条目（总量锚点）时，
  // 判为分部/分表量列举句（「挖一般土方146.93/级配碎石480.5/水泥混凝土572.3…」分部量句），整句不报；
  // 一致条目为锚点（非候选），与不一致候选同句并存才构成「总量锚点+分部量」形态
  const sentenceOf = (at: number): { start: number; end: number } => {
    const back = Math.max(nonTable.lastIndexOf('。', at), nonTable.lastIndexOf('\n', at));
    let fwd1 = nonTable.indexOf('。', at);
    if (fwd1 === -1) fwd1 = nonTable.length;
    let fwd2 = nonTable.indexOf('\n', at);
    if (fwd2 === -1) fwd2 = nonTable.length;
    return { start: back + 1, end: Math.min(fwd1, fwd2) + 1 };
  };
  // 分部拆分豁免（零漂移实测）：同名称多个不同值存在子集和等于权威（压膜 404.4+730=1134.4、
  // 道路+景观分部量）是分部量拆分合法口径，不报冲突；数值×100 取整消除浮点误差
  const subsetSumExists = (nums: number[], target: number): boolean => {
    if (nums.length > 10) return false;
    const scaled = nums.map(num => Math.round(num * 100));
    const goal = Math.round(target * 100);
    for (let mask = 1; mask < (1 << scaled.length); mask += 1) {
      let sum = 0;
      let count = 0;
      for (let bit = 0; bit < scaled.length; bit += 1) {
        if ((mask & (1 << bit)) !== 0) { sum += scaled[bit]; count += 1; }
      }
      if (count >= 2 && sum === goal) return true;
    }
    return false;
  };
  const splitExemptNames = new Set<string>();
  {
    const byName = new Map<string, number[]>();
    for (const c of quantityCandidates) {
      const list = byName.get(c.name) ?? [];
      list.push(c.value);
      byName.set(c.name, list);
    }
    for (const [name, values] of byName) {
      const unique = [...new Set(values)];
      if (unique.length >= 2 && subsetSumExists(unique, quantityCandidates.find(c => c.name === name)?.authorityValue ?? 0)) {
        splitExemptNames.add(name);
      }
    }
  }
  const reportedQuantityNames = new Set<string>();
  for (const candidate of quantityCandidates) {
    const sentence = sentenceOf(candidate.ns);
    // 单体量句豁免（与修复器同源，零漂移实测）：「单座公厕…回填方68.68m³」是单体分项量，
    // 公厕/化粪池语境常在本句或前一句（「作业对象为单座公厕基础及化粪池基坑。主要工程量为…」）——
    // 窗口取段落起点至当前句末；「公厕」单字过泛（四章跨单位工程列举句「公厕外脚手架」
    // 会误伤同段真实冲突），仅用单座/化粪池等单体强特征词
    const monoParaStart = nonTable.lastIndexOf('\n\n', candidate.ns);
    const monoParaFrom = monoParaStart === -1 ? 0 : monoParaStart + 2;
    // 「作业对象」段落豁免（run1 实测）：专业工程小节的「本区域作业对象为…主要工程量包括…」
    // 是分部位工程量列举段（分部位真值与全项目合计合法并存），按段落级分部量豁免
    if (/(?:单体|单座|单栋|单幢|每座|每栋|化粪池|作业对象)/u.test(nonTable.slice(monoParaFrom, sentence.end))) continue;
    const peers = quantityCandidates.filter(other => other !== candidate && other.ns >= sentence.start && other.ns < sentence.end);
    const inconsistent = peers.length + 1;
    const consistent = quantityAnchors.filter(anchor => anchor.ns >= sentence.start && anchor.ns < sentence.end).length;
    if (inconsistent >= 2 && consistent >= 1) continue;
    if (splitExemptNames.has(candidate.name)) continue;
    // 同名条目只报一条（多位置同一漂移不刷屏），但不同名称冲突必须全部上报——
    // 首条即 break 会让后续条目冲突漏报（零漂移实测：塑料管先报后路灯 83 永久漏网）
    if (reportedQuantityNames.has(candidate.name)) continue;
    reportedQuantityNames.add(candidate.name);
    issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `蓝图引用冲突：正文出现与蓝图不一致的工程量 ${candidate.name} ${candidate.value}${candidate.unit}`, suggestion: `请统一使用蓝图工程量：${candidate.name} ${candidate.authorityValue}${candidate.unit}` });
  }
  return issues;
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

// ═══════════════════════════════ 主入口：阶段 0 → A → B → C → D ═══════════════════════════════

/** 项目名称提取（basicFacts 中的「项目名称：」口径，提取不到用模板名兜底）。
 * P3.6 源头根治：资料目录带「9.14--」类序号前缀会被事实池带入项目名称口径，
 * 仅当序号前缀后紧跟 4 位年份才剥离（防误伤「9-3小区」类合法项目名）。 */
function extractProjectName(basicFacts: string, templateName?: string): string {
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

/**
 * 构建一体化蓝图（一期旁路主入口）：任何阶段失败沿确定性回退继续，永不 throw；
 * 清单解析失败时降级为「仅大纲骨架 + 空参数桶」蓝图并报告诊断（不阻断现有生成管线）。
 */
export function buildIntegratedBlueprint(input: BuildIntegratedBlueprintInput): IntegratedBlueprint {
  const startedAt = Date.now();
  const diagnostics: BlueprintBuildDiagnostics = {
    stage: '阶段 0',
    standardBlocksLoaded: 0,
    standardBlockGaps: [],
    laborDerivationBasis: '清单汇总 × 经验区间系数（定额工效知识不全，降级区间表达）',
    llmCalls: 0,
    fallbackUsed: [],
    warnings: [],
    durationMs: 0,
  };
  const meta: BlueprintMeta = {
    version: BLUEPRINT_VERSION,
    projectCode: extractProjectName(input.basicFacts || '', input.templateName) || undefined,
    docType: BLUEPRINT_DOC_TYPE,
    createdAt: new Date().toISOString().slice(0, 10),
    sourceMaterials: [...input.boundFilePaths],
  };
  // 阶段 0：清单解析（确定性零 LLM）
  const boqResolution = resolveBillOfQuantities({ projectRoot: input.projectRoot, boundFilePaths: input.boundFilePaths });
  if (boqResolution.warning) diagnostics.warnings.push(boqResolution.warning);
  const boq = boqResolution.boq;
  if (boq) {
    diagnostics.boq = {
      sourceFile: boq.sourceFile,
      totalEntries: boq.totalEntries,
      complete: boq.complete,
      villageCount: boq.villages.length,
      pagesMissingTotal: boq.villages.reduce((sum, village) => sum + village.pagesMissing.length, 0),
    };
    if (!boq.complete) diagnostics.warnings.push('清单解析完整性校验未通过（序号缺口/页码缺失），蓝图覆盖校验将兜底报告');
  }
  // 阶段 A：参数桶（L1a 直填 / L1b 参考资产 / L2 区间推导 / L3 确定性组织规划）
  diagnostics.stage = '阶段 A';
  const emptyBoq: BillOfQuantitiesResult = { entries: [], villages: [], totalEntries: 0, sourceFile: '', complete: false, diagnostics: { totalChunks: 0, markdownChunks: 0, declarationChunks: 0, skippedChunks: 0, droppedIncompleteRows: 0 } };
  const boqForData = boq || emptyBoq;
  // 工程类型策略解析（确定性双信号，零 LLM）→ 各推导函数按策略组参数执行
  const strategy = resolveDerivationStrategy({ basicFacts: input.basicFacts, templateName: input.templateName, chapterTitles: input.chapterTitles, boq: boqForData });
  const dataResult = buildBlueprintData({
    boq: boqForData,
    basicFacts: input.basicFacts,
    evidence: input.evidence,
    facts: input.facts,
    projectName: meta.projectCode || '',
    strategy,
  });
  diagnostics.standardBlocksLoaded = dataResult.diagnostics.standardBlocksLoaded;
  diagnostics.standardBlockGaps = dataResult.diagnostics.standardBlockGaps;
  diagnostics.warnings.push(...dataResult.diagnostics.warnings);
  // 阶段 B + C：大纲与配方（清单分部 → 工作包，确定性归纳）
  diagnostics.stage = '阶段 B/C';
  const outline = buildBlueprintOutline({ chapterTitles: input.chapterTitles, boq: boqForData, docType: meta.docType });
  // 阶段 D：四道校验
  diagnostics.stage = '阶段 D';
  const blueprint: IntegratedBlueprint = { meta, data: dataResult.data, outline, validation: { passed: false, checks: [] }, diagnostics };
  blueprint.validation = validateBlueprint(blueprint, boq);
  if (!blueprint.validation.passed) {
    diagnostics.warnings.push(`蓝图校验未通过：${blueprint.validation.checks.filter(check => !check.passed).map(check => check.name).join('、')}（一期旁路仅报告，不阻断生成）`);
  }
  diagnostics.durationMs = Date.now() - startedAt;
  return blueprint;
}

/** 落盘蓝图到 generatedDocuments/assets/blueprint.json（一期旁路：可复用资产 + 人工审查入口） */
export function saveBlueprintAsset(projectRoot: string, blueprint: IntegratedBlueprint): string {
  const assetPath = path.join(generatedRoot(projectRoot), 'assets', 'blueprint.json');
  fs.writeFileSync(assetPath, JSON.stringify(blueprint, null, 2), 'utf8');
  return assetPath;
}

/** 从落盘资产读取蓝图（同项目二次生成跳过阶段 0/A-C 的复用入口，二期启用） */
export function loadBlueprintAsset(projectRoot: string): IntegratedBlueprint | undefined {
  const assetPath = path.join(generatedRoot(projectRoot), 'assets', 'blueprint.json');
  if (!fs.existsSync(assetPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(assetPath, 'utf8')) as IntegratedBlueprint;
  } catch {
    return undefined;
  }
}

/** 静默导出知识卡常量（阶段 C 知识卡补的兜底检测用，避免未使用导入告警） */
export const BLUEPRINT_KNOWLEDGE_CARD_COUNT = PROCESS_KNOWLEDGE_CARDS.length;
