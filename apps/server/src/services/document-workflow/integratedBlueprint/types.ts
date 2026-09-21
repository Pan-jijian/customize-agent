/**
 * 蓝图类型定义与 JSON Schema 常量（S6 零行为拆分：类型/版本常量/schema 机械搬迁自 integratedBlueprint.ts）
 *
 * S6 零行为拆分自 integratedBlueprint.ts（门面 re-export，对外导出不变）：仅机械搬迁，未改动任何语句与常量。
 */
import type { BlueprintDerivationStrategy } from '../blueprintDerivationStrategies';
import type { BidCompositionSpec } from '../bidComposition';
import type { DocumentJsonSchema } from '../llmClient';
import type { DocumentEvidence, DocumentFact, DocumentGenerationDiagnostics } from '../types';

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
  /** 合同估算价（万元）：金额禁区提取（金额权威条目源），参数桶不渲染，仅基本信息表例外 */
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

/** 试验检测仪器配置行（C2 附表二数据源）：策略组确定性配置的行业通用仪器——
 * 投标人拟配备口径（非项目事实推导）；型号/产地/年份等填报列如实留空（—），不得编造 */
export interface BlueprintInstrumentItem {
  name: string;
  spec?: string;
  quantity?: number;
  purpose: string;
  basis: string;
}

/** 临时设施/用地规划行（C2 附表五/六共用数据源）：用途（设施名）/面积/位置/需用时间 +
 * 说明（总平面数据表列）；面积来自策略组配置或按劳动力峰值人均指标推导 */
export interface BlueprintTempLandItem {
  purpose: string;
  area?: number;
  location: string;
  duration: string;
  note: string;
  basis: string;
}

/** 进度计划工序行（C2 附表四数据源）：里程碑顺序累加推导（起止天序），
 * 关键线路=主体施工工序链（prep 准备与清杂为前导不占关键线路） */
export interface BlueprintScheduleItem {
  seq: number;
  label: string;
  duration: number;
  startDay: number;
  endDay: number;
  critical: boolean;
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
  options: Array<{
    value: string;
    aliases: RegExp;
    /** 4.36 D3 定位弱别名（「同步或分段浇筑」的「同步」类弱形态）：仅用于两可归一替换范围锚定
     * （locateDecisionOptionAnchor），不参与锁计分——防裸词混入计分侧造成锁值偏移 */
    weakAliases?: RegExp;
  }>;
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
   * 分村多值合法性判定与跨工程同值复制检测的依据（探测到分组值才算合法分层口径 ） */
  groups?: Array<{ group: string; value: number }>;
  /** 规格-数量拆分（R20 路灯「100W 共118套」根因治理）：同名条目跨规格时按特征描述规格 token
   * （100W/120W 等）分组的各规格小计；值=名称合计的共享规格组（如全组同高 4.5m）已过滤，≥2 组才保留。
   * 写作层逐项照抄依据（禁将规格小计写为名称合计、禁合计挂单一规格）+ 规格-数量绑定断言的权威 */
  specBreakdown?: Array<{ spec: string; value: number }>;
}

export interface BlueprintInspectionBatch {
  scope: string;
  planDesc: string;
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
  /** 推导策略组 id（生成时记录；校验/复盘按此精确对照策略组参数，不合并策略组推断） */
  strategyId: BlueprintDerivationStrategy['id'];
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
  /** C2 附表二数据源：试验检测仪器配置（策略组确定性配置；附表区备注列经中性化出口） */
  testInstruments: BlueprintInstrumentItem[];
  /** C2 附表五/六数据源：临时设施与用地规划（用途/面积/位置/需用时间/说明） */
  tempLand: BlueprintTempLandItem[];
  /** C2 附表四数据源：进度计划工序表（里程碑顺序累加；起止天序 + 关键线路标注） */
  schedule: BlueprintScheduleItem[];
  earthworkBalance: BlueprintEarthworkBalance;
  tempUtilities: BlueprintTempUtilities;
  /** L1a 红线事实专项（must_cite 进正文；amount 条目不进正文） */
  redLineFacts: BlueprintRedLineFact[];
  /** 金额禁区规则：金额类数据禁入正文（合同估算价例外） */
  amountRule: string;
  decisionLock: BlueprintDecisionLock;
  /** L1a 清单条目聚合（名称 → 数量口径） */
  quantities: Record<string, BlueprintQuantity>;
  /** L1a 材料规格权威（清单同名条目特征 C 标号众数，跨章规格错位确定性修复依据） */
  specAuthorities: Record<string, string>;
  inspectionBatches: BlueprintInspectionBatch[];
  /** L3 施工部署 */
  constructionDeployment: BlueprintDeployment;
  /** L3 重难点逐项列明 */
  keyDifficulties: BlueprintDifficulty[];
  /** 编制依据法规清单（从招标文件/基本事实确定性提取书名号法规及文号，注入编制依据小节；
   * 提取为空时写作层降级公共知识法规清单） */
  basisRegulations: string[];
  drawingNote: string;
  /** 标书编制规格承接（阶段 1 判定直传）：标书类型/正文口径/文末附表清单（含数据源绑定）/格式要求/身份禁语。
   * 终稿附表区按 appendixPlan 从本蓝图数据直出；正文禁表/禁图口径供写作与门禁消费；落盘可审计 */
  composition?: BidCompositionSpec;
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
  tablePlans: string[];
  workPackages: BlueprintWorkPackage[];
}

export interface BlueprintChapter {
  id: string;
  title: string;
  isActive: boolean;
  requiredParams: BlueprintRequiredParam[];
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
  /** 标书编制规格（阶段 1 判定直传承接入蓝图：类型/正文口径/附表清单落盘可审计） */
  composition?: BidCompositionSpec;
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
        strategyId: { type: 'string', required: true, minLength: 1 },
        project: { type: 'object', required: true, properties: { name: { type: 'string', required: true, minLength: 1 }, scope: { type: 'string', required: true }, works: { type: 'array', required: true, items: { type: 'string' } } } },
        contract: { type: 'object', required: true, properties: { totalDays: { type: 'number', required: true }, qualityStandard: { type: 'string', required: true }, pricingFile: { type: 'string', required: true } } },
        milestones: { type: 'array', required: true, minItems: 1, items: { type: 'object' } },
        // G 线 P1-6：空**权威**拒绝——`quantities` 此前只要类型对就通过（空对象也合法），
        // 于是「零权威骨架蓝图」能在 schema 层蒙混过关，下游据 authorityAvailability 认为齐备、
        // 写作层拿不到任何值。工程量恒派生自清单，空即代表派生未发生，故用 minProperties 拒绝。
        //
        // **未**对 equipment / materialsPlan 施加 minItems：实测（dicBlueprintLaborPrecision
        // 边界用例）仅含单一土方条目的合法项目这两项本就为空，加了会把「小但真实」的项目
        // 一并挡在门外；而零权威骨架已由 P0-6 的「0. 清单源可用性」检查独立拦下，
        // 此处不必叠加第二道——叠加的代价是误伤，收益仅是重复拦截。
        resources: { type: 'object', required: true, properties: { labor: { type: 'object', required: true }, equipment: { type: 'array', required: true } } },
        materialsPlan: { type: 'array', required: true },
        redLineFacts: { type: 'array', required: true },
        // quantities 是 Record（键为工程量名），无原生 minItems ⇒ 用 minProperties 拒绝空对象
        quantities: { type: 'object', required: true, minProperties: 1 },
        keyDifficulties: { type: 'array', required: true, minItems: 1 },
        composition: { type: 'object' },
      },
    },
    outline: { type: 'object', required: true, properties: { chapters: { type: 'array', required: true, minItems: 1 } } },
  },
};
