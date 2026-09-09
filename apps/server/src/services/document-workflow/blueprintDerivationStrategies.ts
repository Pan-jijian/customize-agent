/**
 * 蓝图 L2 推导策略表（工程类型注册制）：
 * 劳动力/机械/里程碑/检验批/重难点/临时水电等计划推导的确定性参数按工程类型注册为策略组，
 * 运行时由 resolveDerivationStrategy 双信号解析（清单村分组+分部特征优先，suggestProjectType
 * 文本判别兜底）——村域市政整治类项目命中 village-municipal（丰乐镇口径，行为零变化），
 * 房建类命中 building，桥隧/公路/水利命中二期策略组，其余走 general 通用兜底（量级正确、不产生荒谬值）。
 * 全部为确定性常量，零 LLM；经验系数注释标注「定额工效知识不全，降级区间表达」。
 * laborQuotaTable 为权威定额数据接入点：命中定额行 → 定额工日区间，未命中 → 经验区间降级。
 * 内置编造的定额编号/数值会写进投标文档推导依据（数据造假风险，违反事实来源分级红线），
 * 故当前六策略组一律不配置——须由权威来源（如安徽省建设工程定额库）导入后才可启用。
 */
import { suggestProjectType, type ReferenceProjectType } from './referenceQualityProfile';
import type { BillOfQuantitiesResult, BoqEntry } from './billOfQuantitiesParser';

export interface BlueprintMilestoneGroup {
  key: string;
  label: string;
  pattern: RegExp;
}

export interface BlueprintInspectionBatchRule {
  scope: string;
  namePattern: RegExp;
  /** 空串 = 不限单位 */
  unit: string;
  /** 0 = 不按数量分（只写总量）；>0 = ceil(总量/divisor) 批/点/段 */
  divisor: number;
  /** 描述模板：{count}=批次数、{total}=总量 */
  descTemplate: string;
}

export interface BlueprintDifficultyTemplate {
  /** 条目名（函数形态支持动态数量词，如「20 个自然村分散施工组织协调」） */
  name: string | ((boq: BillOfQuantitiesResult) => string);
  measure: string;
  basis: string;
  /** 命中才写入（确定性规则，零 LLM） */
  test: (boq: BillOfQuantitiesResult) => boolean;
}

/** 定额工效知识库行：替换经验区间系数的精确工日口径。
 * 数据须来自权威定额库导入（编号与工日值均须真实可溯源）；未命中行降级策略组经验区间。 */
export interface LaborQuotaRow {
  /** 定额子目名 */
  subName: string;
  /** 条目名称+特征匹配 */
  pattern: RegExp;
  unit: string;
  /** 工日/单位区间（定额口径） */
  min: number;
  max: number;
  /** 定额编号（依据标注用，须为权威定额库真实编号） */
  code: string;
  /** 数据口径来源（注明定额库名称与版本） */
  source: string;
}

export type BlueprintClimateZoneId = 'east' | 'south' | 'north' | 'northeast' | 'northwest' | 'southwest' | 'central';

export interface BlueprintClimateZone {
  rainySeason: string;
  highTemp: string;
  winter: string;
}

export interface BlueprintDerivationStrategy {
  id: 'village-municipal' | 'building' | 'general' | 'bridge-tunnel' | 'highway' | 'water-conservancy';
  projectTypes: ReferenceProjectType[];
  milestoneGroups: BlueprintMilestoneGroup[];
  /** 条目 → 劳动桶分组（laborUnitRange 的键） */
  groupOfEntry: (entry: BoqEntry) => string;
  tradeMapping: Array<{ trade: string; pattern: RegExp }>;
  laborUnitRange: Record<string, { unit: string; min: number; max: number }>;
  equipmentMapping: Array<{ name: string; spec: string; pattern: RegExp; unit: string; basis: string }>;
  machinePowerTable: Array<{ name: string; kw: number }>;
  /** 造价锚定人工费占比（市政/绿化经验口径见村域组注释，房建另档） */
  laborCostRatio: { min: number; max: number };
  dailyWage: { min: number; max: number };
  inspectionBatchRules: BlueprintInspectionBatchRule[];
  difficultyTemplates: BlueprintDifficultyTemplate[];
  /** 定额工效知识库（权威定额数据接入点）：命中行 → 定额工日区间；未配置/未命中 → laborUnitRange 经验区间降级。
   * 数据须来自权威定额库导入（编号与工日值真实可溯源）；当前六策略组一律不配置，杜绝编造数据进入投标文档 */
  laborQuotaTable?: LaborQuotaRow[];
  /** 无村分组时的施工组织话术 */
  deploymentFlowFallback: string;
  /** 多施工段并行话术（仅村域组提供；缺省 → 输出 fallback） */
  multiVillageFlow?: (count: number) => string;
  /** 清单无分部名时的分部编排顺序兜底 */
  sequenceFallback: string;
  /** 气候区域：undefined = 不注入气候值（宁缺毋错，写作层按建设地点常识处理） */
  climateZone?: BlueprintClimateZoneId;
  /** 临时用电定性表述（无电动机具时） */
  powerFallbackText: string;
  /** 临时用水句尾口径 */
  waterNoteText: string;
}

// ═══════════════════════════════ 气候区域表（替换硬编码华东值） ═══════════════════════════════

const CLIMATE_ZONES: Array<{ zone: BlueprintClimateZoneId; pattern: RegExp; climate: BlueprintClimateZone }> = [
  { zone: 'east', pattern: /上海|江苏|浙江|安徽|福建|江西|山东/u, climate: { rainySeason: '6-8月', highTemp: '7-8月', winter: '12-2月' } },
  { zone: 'south', pattern: /广东|广西|海南/u, climate: { rainySeason: '4-9月', highTemp: '6-9月', winter: '12-2月' } },
  { zone: 'north', pattern: /北京|天津|河北|山西|内蒙古/u, climate: { rainySeason: '7-8月', highTemp: '7-8月', winter: '11-3月' } },
  { zone: 'northeast', pattern: /辽宁|吉林|黑龙江/u, climate: { rainySeason: '7-8月', highTemp: '7月', winter: '11-3月' } },
  { zone: 'northwest', pattern: /陕西|甘肃|宁夏|青海|新疆/u, climate: { rainySeason: '7-8月', highTemp: '7-8月', winter: '11-3月' } },
  { zone: 'southwest', pattern: /四川|重庆|云南|贵州|西藏/u, climate: { rainySeason: '6-9月', highTemp: '7-8月', winter: '12-2月' } },
  { zone: 'central', pattern: /湖北|湖南|河南/u, climate: { rainySeason: '6-8月', highTemp: '7-8月', winter: '12-2月' } },
];

/** 气候区 → 季节施工口径（确定性常量） */
export function climateForZone(zone: BlueprintClimateZoneId | undefined): BlueprintClimateZone {
  if (!zone) return { rainySeason: '', highTemp: '', winter: '' };
  return CLIMATE_ZONES.find(item => item.zone === zone)?.climate || { rainySeason: '', highTemp: '', winter: '' };
}

/** 建设地点 → 气候区匹配；匹配不到返回空（宁缺毋错，不注入错误气候值） */
export function resolveClimateByLocation(location: string): BlueprintClimateZone {
  for (const item of CLIMATE_ZONES) {
    if (item.pattern.test(location)) return { ...item.climate };
  }
  return { rainySeason: '', highTemp: '', winter: '' };
}

// ═══════════════════════════════ 策略组 A：村域市政整治（丰乐镇口径，行为零变化） ═══════════════════════════════

/** 条目归类 → L2 推导分组（名称关键词 → 分组；与丰乐镇多轮实测口径一致） */
function villageGroupOfEntry(entry: BoqEntry): string {
  const text = `${entry.name} ${entry.description}`;
  if (/塑料管|管道|检查井|雨水口|化粪池|涵管/u.test(text)) return '管道铺设';
  if (/挖一般土方|挖沟槽|挖基坑|回填|清淤|余方|弃置|土方/u.test(text) && entry.unit === 'm3') return '土方工程';
  // 「混凝土」词加 m3 单位条件：m² 计量的混凝土路面/场地硬化不落 m³ 口径桶（否则单位不匹配被丢弃，道路工种缺失）
  if (/混凝土|垫层|涵头|压顶/u.test(text) && entry.unit === 'm3') return '混凝土工程';
  // 注意不含「碎石」：级配碎石垫层（m²）含「垫层」词，落 m² 铺装桶会与 m³ 混凝土条目混桶
  // （单位混加根治要求其不产生工种），保持丰乐镇实测行为（垫层分支拦截后丢弃）
  if (/水泥混凝土|路床|铺装|道路|青砖|散水|块料/u.test(text) && entry.unit === 'm2') return '道路铺装';
  if (/砌筑|砌体|砖/u.test(text)) return '砌筑工程';
  if (/绿化|栽植|种植|苗木|草籽|喷播|灌木|乔木|色带|草坪/u.test(text)) return '绿化工程';
  return '安装工程';
}

export const villageMunicipalStrategy: BlueprintDerivationStrategy = {
  id: 'village-municipal',
  projectTypes: ['市政', '园林绿化'],
  milestoneGroups: [
    { key: 'prep', label: '施工准备与清杂拆除', pattern: /清杂|拆除|场地平整|临时/u },
    { key: 'pipe', label: '污水管网工程', pattern: /塑料管|检查井|管网|排水|化粪池|雨水口/u },
    { key: 'road', label: '道路铺装工程', pattern: /道路|路床|水泥混凝土|级配碎石|路缘石|青砖|散水|过路涵/u },
    { key: 'landscape', label: '景观与绿化工程', pattern: /景观|绿化|栽植|种植|苗木|喷播|小菜园|沟塘|清淤/u },
    { key: 'lighting', label: '亮化与收尾工程', pattern: /路灯|亮化|配电|电缆|防雷/u },
  ],
  groupOfEntry: villageGroupOfEntry,
  tradeMapping: [
    { trade: '管道工', pattern: /塑料管|管道|检查井|雨水口|化粪池|闭水|涵管|排水/u },
    { trade: '混凝土工', pattern: /混凝土|水泥砂浆|垫层|涵头|压顶/u },
    { trade: '瓦工', pattern: /砌筑|砌体|砖|路缘石|铺装|侧石|平石|块料|踏步|台阶/u },
    { trade: '绿化工', pattern: /绿化|栽植|种植|苗木|草籽|喷播|养护|灌木|乔木|色带|草坪/u },
    { trade: '电工', pattern: /路灯|配电|电缆|强电|防雷|接地|灯具|亮化/u },
    { trade: '普工', pattern: /土方|清杂|拆除|平整|回填|清淤|开挖/u },
  ],
  laborUnitRange: {
    管道铺设: { unit: 'm', min: 0.15, max: 0.3 },
    土方工程: { unit: 'm3', min: 0.08, max: 0.15 },
    混凝土工程: { unit: 'm3', min: 0.8, max: 1.5 },
    道路铺装: { unit: 'm2', min: 0.3, max: 0.6 },
    砌筑工程: { unit: 'm3', min: 1.2, max: 2.0 },
    绿化工程: { unit: 'm2', min: 0.08, max: 0.15 },
    安装工程: { unit: '项', min: 0, max: 0 },
  },
  equipmentMapping: [
    { name: '挖掘机', spec: '0.6~1.0m³', pattern: /人机配合|开挖|挖土|沟槽/u, unit: 'm3', basis: '人机配合开挖（清单特征）' },
    { name: '自卸汽车', spec: '8t', pattern: /余方弃置|弃方|外运|回填/u, unit: 'm3', basis: '土方运输与回填（清单条目）' },
    { name: '压路机', spec: '8~12t', pattern: /碾压|压实度/u, unit: 'm2', basis: '路床碾压与压实度要求（清单特征）' },
    { name: '蛙式打夯机', spec: '', pattern: /回填|夯实/u, unit: 'm3', basis: '沟槽回填夯实（清单条目）' },
    { name: '混凝土搅拌运输车', spec: '', pattern: /商品混凝土|C\d{2}混凝土/u, unit: 'm3', basis: '商品混凝土运输（清单特征）' },
    { name: '插入式振捣器', spec: '', pattern: /混凝土浇筑|振捣/u, unit: 'm3', basis: '混凝土浇筑（清单条目）' },
    { name: '洒水车', spec: '', pattern: /养护|绿化|喷播|栽植/u, unit: 'm2', basis: '绿化养护与洒水（清单条目）' },
    { name: '高空作业车', spec: '', pattern: /路灯|灯具安装/u, unit: '套', basis: '路灯安装（清单条目）' },
  ],
  machinePowerTable: [
    { name: '挖掘机', kw: 90 },
    { name: '自卸汽车', kw: 120 },
    { name: '压路机', kw: 75 },
    { name: '蛙式打夯机', kw: 3 },
    { name: '混凝土搅拌运输车', kw: 110 },
    { name: '插入式振捣器', kw: 1.5 },
    { name: '洒水车', kw: 90 },
    { name: '高空作业车', kw: 60 },
  ],
  laborCostRatio: { min: 0.15, max: 0.25 },
  dailyWage: { min: 250, max: 350 },
  inspectionBatchRules: [
    { scope: '污水管网管道', namePattern: /塑料管|管道/u, unit: 'm', divisor: 200, descTemplate: '管道闭水试验分段检验，按每 200m 一段划分约 {count} 段（总长 {total}m）' },
    { scope: '道路工程', namePattern: /水泥混凝土|级配碎石|路床/u, unit: 'm2', divisor: 200, descTemplate: '路床压实度按每层每 200m² 不少于 1 点检验，约 {count} 点（总面积 {total}m²）' },
    { scope: '检查井', namePattern: /检查井/u, unit: '', divisor: 1, descTemplate: '检查井逐座验收，共 {total} 座' },
  ],
  difficultyTemplates: [
    {
      name: boq => `${boq.villages.length} 个自然村分散施工组织协调`,
      measure: '按自然村分组划分施工段，多村平行施工 + 村内流水作业，配置专职协调员',
      basis: '清单按自然村分组',
      test: boq => boq.villages.length >= 2,
    },
    {
      name: '雨季管网沟槽施工',
      measure: '雨季排水与边坡防护，分段开挖、快速回填（联动季节施工措施板块）',
      basis: '清单含沟槽开挖与管道铺设条目',
      test: boq => boq.entries.some(entry => /挖沟槽|沟槽开挖|塑料管铺设/u.test(`${entry.name} ${entry.description}`)),
    },
    {
      name: '村庄内道路施工交通疏导',
      measure: '分段封闭施工，设置临时道路保障居民出行（补疑条款：居民出行临时道路）',
      basis: '清单含道路工程条目且村内施工',
      test: boq => boq.villages.length > 0 && boq.entries.some(entry => /道路|路床|路面/u.test(entry.name)),
    },
    {
      name: '既有杆管线保护',
      measure: '开挖前探测交底，杆线保护措施费含在清单单价内',
      basis: '清单特征原文含杆线保护条款',
      test: boq => boq.entries.some(entry => /杆线|管线保护|既有管线/u.test(entry.description)),
    },
  ],
  deploymentFlowFallback: '分区段流水作业',
  multiVillageFlow: (count: number) => `多村平行施工 + 村内流水作业（${count} 个自然村分组）`,
  sequenceFallback: '清杂拆除 → 管网道路 → 景观绿化 → 亮化收尾',
  climateZone: 'east',
  powerFallbackText: '临时用电以村庄既有电源分散接入为主，各施工组单独设置配电箱与计量表（柴油机械不计入用电负荷，电动机具零星分散）',
  waterNoteText: '施工用水以洒水车供水为主，总用水量按管网分段配置',
};

// ═══════════════════════════════ 策略组 B：房建（保守经验区间，量级正确优先） ═══════════════════════════════

/** 房建条目归类（定额工效知识不全，降级区间表达；三期接入定额知识库） */
function buildingGroupOfEntry(entry: BoqEntry): string {
  const text = `${entry.name} ${entry.description}`;
  if (/土方|挖方|回填|弃置|清淤/u.test(text) && entry.unit === 'm3') return '土方工程';
  if (/钢筋|植筋/u.test(text)) return '钢筋工程';
  if (/模板|支模/u.test(text)) return '模板工程';
  if (/混凝土|垫层|现浇/u.test(text)) return '混凝土工程';
  if (/砌筑|砌体|砖/u.test(text)) return '砌筑工程';
  if (/防水|卷材|涂膜/u.test(text)) return '防水工程';
  if (/保温|挤塑|聚苯/u.test(text)) return '保温工程';
  if (/装饰|抹灰|涂料|吊顶|幕墙|墙砖|地砖|油漆|门窗/u.test(text)) return '装饰工程';
  if (/电气|给排水|配电|照明|灯具|插座|管线|穿线|桥架|暖通|消防|电梯/u.test(text)) return '安装电气';
  return '安装工程';
}

export const buildingStrategy: BlueprintDerivationStrategy = {
  id: 'building',
  projectTypes: ['房建', '装饰装修'],
  milestoneGroups: [
    { key: 'prep', label: '施工准备与三通一平', pattern: /清杂|拆除|场地平整|临建|临时|三通一平/u },
    { key: 'foundation', label: '基础工程', pattern: /桩基|基础|基坑|地下室|降水|支护|土方|挖方|回填/u },
    { key: 'structure', label: '主体结构工程', pattern: /钢筋|模板|砌体|主体|框架|剪力墙|现浇|混凝土/u },
    { key: 'finish', label: '装饰装修工程', pattern: /装饰|抹灰|防水|保温|门窗|屋面|涂料|吊顶|幕墙/u },
    { key: 'mep', label: '安装与收尾工程', pattern: /电气|给排水|暖通|消防|电梯|智能化|收尾|竣工|调试/u },
  ],
  groupOfEntry: buildingGroupOfEntry,
  tradeMapping: [
    { trade: '钢筋工', pattern: /钢筋|植筋/u },
    { trade: '模板工', pattern: /模板|支模/u },
    { trade: '防水工', pattern: /防水|卷材|涂膜/u },
    { trade: '架子工', pattern: /脚手架|外架/u },
    { trade: '抹灰工', pattern: /抹灰|粉刷|抹面/u },
    { trade: '水电工', pattern: /电气|给排水|配电|照明|灯具|插座|管线|穿线|桥架/u },
    { trade: '保温工', pattern: /保温|挤塑|聚苯/u },
    { trade: '混凝土工', pattern: /混凝土|水泥砂浆|垫层/u },
    { trade: '瓦工', pattern: /砌筑|砌体|砖|块料|铺装|墙砖|地砖/u },
    { trade: '普工', pattern: /土方|清杂|拆除|平整|回填|清淤|开挖/u },
  ],
  laborUnitRange: {
    土方工程: { unit: 'm3', min: 0.08, max: 0.15 },
    钢筋工程: { unit: 't', min: 0.8, max: 1.5 },
    模板工程: { unit: 'm2', min: 0.3, max: 0.6 },
    混凝土工程: { unit: 'm3', min: 0.8, max: 1.5 },
    砌筑工程: { unit: 'm3', min: 1.2, max: 2.0 },
    防水工程: { unit: 'm2', min: 0.06, max: 0.12 },
    保温工程: { unit: 'm2', min: 0.15, max: 0.3 },
    装饰工程: { unit: 'm2', min: 0.2, max: 0.4 },
    安装电气: { unit: 'm', min: 0.08, max: 0.15 },
    安装工程: { unit: '项', min: 0, max: 0 },
  },
  equipmentMapping: [
    { name: '挖掘机', spec: '0.6~1.0m³', pattern: /开挖|挖土|基坑|土方/u, unit: 'm3', basis: '土方开挖（清单特征）' },
    { name: '自卸汽车', spec: '8t', pattern: /余方弃置|弃方|外运|回填/u, unit: 'm3', basis: '土方运输与回填（清单条目）' },
    { name: '插入式振捣器', spec: '', pattern: /混凝土浇筑|振捣/u, unit: 'm3', basis: '混凝土浇筑（清单条目）' },
    { name: '蛙式打夯机', spec: '', pattern: /回填|夯实/u, unit: 'm3', basis: '回填夯实（清单条目）' },
    { name: '塔式起重机', spec: 'QTZ63', pattern: /塔吊|塔式起重机/u, unit: '项', basis: '主体结构垂直运输（清单特征）' },
    { name: '施工升降机', spec: 'SC200/200', pattern: /施工电梯|施工升降机/u, unit: '项', basis: '人员与材料垂直运输（清单特征）' },
    { name: '钢筋加工机械', spec: '', pattern: /钢筋/u, unit: 't', basis: '钢筋加工（清单条目）' },
    { name: '电焊机', spec: '', pattern: /焊接|钢结构|预埋/u, unit: 't', basis: '钢结构焊接与预埋（清单条目）' },
    { name: '混凝土输送泵', spec: '', pattern: /泵送|混凝土泵/u, unit: 'm3', basis: '混凝土泵送（清单特征）' },
  ],
  machinePowerTable: [
    { name: '挖掘机', kw: 90 },
    { name: '自卸汽车', kw: 120 },
    { name: '插入式振捣器', kw: 1.5 },
    { name: '蛙式打夯机', kw: 3 },
    { name: '塔式起重机', kw: 45 },
    { name: '施工升降机', kw: 33 },
    { name: '钢筋加工机械', kw: 15 },
    { name: '电焊机', kw: 15 },
    { name: '混凝土输送泵', kw: 90 },
    { name: '物料提升机', kw: 11 },
  ],
  laborCostRatio: { min: 0.18, max: 0.3 },
  dailyWage: { min: 250, max: 350 },
  inspectionBatchRules: [
    { scope: '钢筋工程', namePattern: /钢筋/u, unit: 't', divisor: 60, descTemplate: '钢筋按进场检验批划分，每 60t 一批，约 {count} 批（总量 {total}t）' },
    { scope: '混凝土工程', namePattern: /混凝土/u, unit: 'm3', divisor: 100, descTemplate: '混凝土按浇筑批次留置标准养护试件，每 100m³ 一批，约 {count} 批（总量 {total}m³）' },
    { scope: '砌体工程', namePattern: /砌体|砌筑/u, unit: 'm3', divisor: 250, descTemplate: '砌体工程按砌筑量划分检验批，每 250m³ 一批，约 {count} 批（总量 {total}m³）' },
    { scope: '防水工程', namePattern: /防水/u, unit: 'm2', divisor: 0, descTemplate: '防水工程按施工段划分检验批并做蓄水（淋水）试验（总量 {total}m²）' },
  ],
  difficultyTemplates: [
    {
      name: '深基坑施工',
      measure: '分层开挖、及时支护与信息化监测，编制专项施工方案并按危大工程规定组织专家论证',
      basis: '清单特征含基坑开挖深度',
      test: boq => boq.entries.some(entry => {
        const match = /(?:挖深|开挖深度|基坑深度|坑深)[^。；;]{0,12}(\d+(?:\.\d+)?)\s*m/u.exec(entry.description);
        return !!match && Number.parseFloat(match[1] || '0') >= 3;
      }),
    },
    {
      name: '高支模施工',
      measure: '编制专项施工方案并组织专家论证，支架验收合格后方可浇筑',
      basis: '清单特征含支模高度',
      test: boq => boq.entries.some(entry => /支模高度|高支模|模板支撑[^。；;]{0,12}\d+(?:\.\d+)?\s*m/u.test(`${entry.name} ${entry.description}`)),
    },
    {
      name: '大体积混凝土施工',
      measure: '分层浇筑、测温养护，掺加缓凝剂与矿物掺合料控制水化热',
      basis: '清单特征含大体积混凝土/筏板基础',
      test: boq => boq.entries.some(entry => /大体积|基础底板|筏板/u.test(`${entry.name} ${entry.description}`)),
    },
    {
      name: '垂直运输组织',
      measure: '塔吊与施工电梯合理布位，编制群塔作业防碰撞方案',
      basis: '清单特征含塔吊/施工电梯',
      test: boq => boq.entries.some(entry => /塔吊|塔式起重机|施工电梯|施工升降机/u.test(`${entry.name} ${entry.description}`)),
    },
    {
      name: '紧邻既有建筑保护',
      measure: '开工前房屋现状鉴定，设置沉降观测点，控制开挖对周边扰动',
      basis: '清单特征含紧邻既有建筑',
      test: boq => boq.entries.some(entry => /紧邻|既有建筑|相邻建筑|周边建筑/u.test(entry.description)),
    },
  ],
  // laborQuotaTable 不配置：定额数据须来自权威定额库导入（编号与工日值真实可溯源），内置编造数据会污染投标文档推导依据
  deploymentFlowFallback: '分区段流水作业',
  sequenceFallback: '施工准备 → 基础工程 → 主体结构 → 装饰装修 → 安装收尾',
  climateZone: 'central',
  powerFallbackText: '临时用电由现场总配电箱接入，采用 TN-S 三相五线制，各分配电箱单独计量（柴油机械不计入用电负荷）',
  waterNoteText: '施工用水以市政供水为主，总用水量按施工段分区配置',
};

// ═══════════════════════════════ 策略组 C：通用兜底（判别不出类型时的保守口径） ═══════════════════════════════

export const generalStrategy: BlueprintDerivationStrategy = {
  id: 'general',
  projectTypes: ['其他'],
  milestoneGroups: [
    { key: 'prep', label: '施工准备', pattern: /清杂|拆除|场地平整|临建|临时/u },
    { key: 'main', label: '主体工程', pattern: /主体|结构|混凝土|钢筋|模板|砌体|土方|基础|安装/u },
    { key: 'finish', label: '装饰与附属工程', pattern: /装饰|抹灰|防水|保温|门窗|屋面|绿化|景观/u },
    { key: 'install', label: '安装工程', pattern: /电气|给排水|暖通|消防|电梯|灯具|管线|设备/u },
    { key: 'close', label: '收尾与验收', pattern: /收尾|竣工|验收|调试|移交|清理/u },
  ],
  groupOfEntry: villageGroupOfEntry,
  tradeMapping: villageMunicipalStrategy.tradeMapping,
  laborUnitRange: villageMunicipalStrategy.laborUnitRange,
  equipmentMapping: [
    { name: '挖掘机', spec: '0.6~1.0m³', pattern: /开挖|挖土|沟槽|土方/u, unit: 'm3', basis: '土方开挖（清单特征）' },
    { name: '自卸汽车', spec: '8t', pattern: /余方弃置|弃方|外运|回填/u, unit: 'm3', basis: '土方运输与回填（清单条目）' },
    { name: '插入式振捣器', spec: '', pattern: /混凝土浇筑|振捣/u, unit: 'm3', basis: '混凝土浇筑（清单条目）' },
    { name: '蛙式打夯机', spec: '', pattern: /回填|夯实/u, unit: 'm3', basis: '回填夯实（清单条目）' },
    { name: '混凝土搅拌运输车', spec: '', pattern: /商品混凝土|C\d{2}混凝土/u, unit: 'm3', basis: '商品混凝土运输（清单特征）' },
  ],
  machinePowerTable: [
    { name: '挖掘机', kw: 90 },
    { name: '自卸汽车', kw: 120 },
    { name: '插入式振捣器', kw: 1.5 },
    { name: '蛙式打夯机', kw: 3 },
    { name: '混凝土搅拌运输车', kw: 110 },
  ],
  laborCostRatio: { min: 0.15, max: 0.25 },
  dailyWage: { min: 250, max: 350 },
  inspectionBatchRules: [
    { scope: '混凝土工程', namePattern: /混凝土/u, unit: 'm3', divisor: 100, descTemplate: '混凝土按浇筑批次留置标准养护试件，每 100m³ 一批，约 {count} 批（总量 {total}m³）' },
    { scope: '检查井', namePattern: /检查井/u, unit: '', divisor: 1, descTemplate: '检查井逐座验收，共 {total} 座' },
  ],
  difficultyTemplates: [],
  deploymentFlowFallback: '分区段流水作业',
  sequenceFallback: '施工准备 → 主体施工 → 装饰安装 → 收尾验收',
  climateZone: undefined,
  powerFallbackText: '临时用电按现场配电箱分区接入，各用电点单独计量（柴油机械不计入用电负荷，电动机具零星分散）',
  waterNoteText: '施工用水按现场水源分区配置，总用水量按施工段核定',
};

// ═══════════════════════════════ 策略组 D：桥隧（二期组，保守经验区间，量级正确优先） ═══════════════════════════════

/** 桥隧条目归类（定额工效知识不全，降级区间表达；核心子目由定额知识库覆盖） */
function bridgeTunnelGroupOfEntry(entry: BoqEntry): string {
  const text = `${entry.name} ${entry.description}`;
  if (/灌注桩|桩基|钻孔|围堰|承台/u.test(text)) return '桩基与基础工程';
  if (/桥墩|桥台|墩柱|盖梁|系梁|下部/u.test(text)) return '下部结构工程';
  // 上部结构按 m³ 口径；t 计量的钢绞线单列钢绞线工程（否则落入 m³ 桶单位不符被丢弃，张拉工缺失）
  if (/箱梁|梁板|主梁|现浇梁|预制|预应力|张拉|架设|上部/u.test(text) && entry.unit === 'm3') return '上部结构工程';
  if (/钢绞线/u.test(text) && entry.unit === 't') return '钢绞线工程';
  if (/隧道|洞身|仰拱|衬砌|锚杆|喷混|掌子面/u.test(text)) return '隧道工程';
  if (/桥面|铺装|护栏|伸缩缝|防撞/u.test(text)) return '桥面系工程';
  if (/土方|挖方|填方|回填|清淤/u.test(text) && entry.unit === 'm3') return '土方工程';
  if (/钢筋|植筋/u.test(text)) return '钢筋工程';
  if (/模板|支模/u.test(text)) return '模板工程';
  if (/混凝土|现浇/u.test(text)) return '混凝土工程';
  return '安装工程';
}

export const bridgeTunnelStrategy: BlueprintDerivationStrategy = {
  id: 'bridge-tunnel',
  projectTypes: ['桥梁与隧道'],
  milestoneGroups: [
    { key: 'prep', label: '施工准备与临时设施', pattern: /清杂|拆除|场地平整|临建|临时|三通一平|测量放样/u },
    { key: 'foundation', label: '基础工程', pattern: /桩基|钻孔|灌注桩|围堰|承台|基础|基坑|降水|支护/u },
    { key: 'substructure', label: '下部结构工程', pattern: /桥墩|桥台|墩柱|盖梁|系梁|支座垫石|下部/u },
    { key: 'superstructure', label: '上部结构工程', pattern: /箱梁|梁板|主梁|现浇梁|预制|预应力|张拉|架设|合龙|上部/u },
    { key: 'tunnel', label: '隧道洞身工程', pattern: /隧道|洞身|仰拱|衬砌|锚杆|喷混|掌子面|二衬/u },
    { key: 'finish', label: '桥面系附属与收尾', pattern: /桥面|铺装|护栏|伸缩缝|防撞|排水|照明|收尾|竣工|交安|绿化/u },
  ],
  groupOfEntry: bridgeTunnelGroupOfEntry,
  tradeMapping: [
    { trade: '桩基工', pattern: /灌注桩|桩基|钻孔/u },
    { trade: '钢筋工', pattern: /钢筋|植筋/u },
    { trade: '模板工', pattern: /模板|支模/u },
    { trade: '混凝土工', pattern: /混凝土|现浇|垫层/u },
    { trade: '张拉工', pattern: /预应力|张拉|钢绞线/u },
    { trade: '焊工', pattern: /焊接|钢结构|预埋件/u },
    { trade: '起重工', pattern: /吊装|架设|梁体|龙门吊|架桥机/u },
    { trade: '隧道工', pattern: /隧道|洞身|衬砌|锚杆|喷混|掌子面/u },
    { trade: '普工', pattern: /土方|清杂|拆除|平整|回填|清淤|开挖/u },
  ],
  laborUnitRange: {
    桩基与基础工程: { unit: 'm3', min: 4, max: 7 },
    下部结构工程: { unit: 'm3', min: 1.5, max: 3 },
    上部结构工程: { unit: 'm3', min: 4, max: 8 },
    钢绞线工程: { unit: 't', min: 1.5, max: 3 },
    隧道工程: { unit: 'm3', min: 1.5, max: 3 },
    桥面系工程: { unit: 'm2', min: 0.4, max: 0.8 },
    土方工程: { unit: 'm3', min: 0.08, max: 0.15 },
    钢筋工程: { unit: 't', min: 0.8, max: 1.5 },
    模板工程: { unit: 'm2', min: 0.3, max: 0.6 },
    混凝土工程: { unit: 'm3', min: 0.8, max: 1.5 },
    安装工程: { unit: '项', min: 0, max: 0 },
  },
  equipmentMapping: [
    { name: '旋挖钻机', spec: '', pattern: /钻孔|灌注桩|桩基/u, unit: 'm3', basis: '桩基成孔（清单条目）' },
    { name: '泥浆泵', spec: '', pattern: /灌注桩|钻孔/u, unit: 'm3', basis: '钻孔泥浆循环（清单条目）' },
    { name: '履带式起重机', spec: '', pattern: /吊装|梁体|预制/u, unit: '项', basis: '构件吊装（清单特征）' },
    { name: '架桥机', spec: '', pattern: /架设|架梁|箱梁/u, unit: '项', basis: '梁体架设（清单条目）' },
    { name: '张拉设备', spec: '', pattern: /预应力|张拉|钢绞线/u, unit: '束', basis: '预应力张拉（清单条目）' },
    { name: '挖掘机', spec: '0.6~1.0m³', pattern: /开挖|挖土|基坑|土方/u, unit: 'm3', basis: '土方开挖（清单特征）' },
    { name: '自卸汽车', spec: '8t', pattern: /余方弃置|弃方|外运|回填/u, unit: 'm3', basis: '土方运输与回填（清单条目）' },
    { name: '混凝土输送泵', spec: '', pattern: /泵送|混凝土泵/u, unit: 'm3', basis: '混凝土泵送（清单特征）' },
    { name: '插入式振捣器', spec: '', pattern: /混凝土浇筑|振捣/u, unit: 'm3', basis: '混凝土浇筑（清单条目）' },
  ],
  machinePowerTable: [
    { name: '旋挖钻机', kw: 130 },
    { name: '泥浆泵', kw: 22 },
    { name: '履带式起重机', kw: 110 },
    { name: '架桥机', kw: 90 },
    { name: '张拉设备', kw: 7.5 },
    { name: '挖掘机', kw: 90 },
    { name: '自卸汽车', kw: 120 },
    { name: '混凝土输送泵', kw: 90 },
    { name: '插入式振捣器', kw: 1.5 },
  ],
  laborCostRatio: { min: 0.12, max: 0.22 },
  dailyWage: { min: 250, max: 350 },
  inspectionBatchRules: [
    { scope: '桩基工程', namePattern: /灌注桩|桩基/u, unit: '', divisor: 1, descTemplate: '钻孔灌注桩逐桩检验（桩位/孔径/沉渣厚度/混凝土充盈系数），共 {total} 根' },
    { scope: '钢筋工程', namePattern: /钢筋/u, unit: 't', divisor: 60, descTemplate: '钢筋按进场检验批划分，每 60t 一批，约 {count} 批（总量 {total}t）' },
    { scope: '混凝土工程', namePattern: /混凝土/u, unit: 'm3', divisor: 100, descTemplate: '混凝土按浇筑批次留置标准养护试件，每 100m³ 一批，约 {count} 批（总量 {total}m³）' },
    { scope: '预应力张拉', namePattern: /预应力|钢绞线/u, unit: '束', divisor: 0, descTemplate: '预应力孔道逐束张拉并记录伸长值（总量 {total} 束）' },
  ],
  difficultyTemplates: [
    { name: '深水基础施工', measure: '围堰施工与排水方案专项设计，汛期前完成基础施工，设置水位监测', basis: '清单特征含围堰/深水基础', test: boq => boq.entries.some(entry => /围堰|深水|水中墩|钢板桩/u.test(`${entry.name} ${entry.description}`)) },
    { name: '大体积混凝土施工', measure: '分层浇筑、测温养护，掺加缓凝剂与矿物掺合料控制水化热', basis: '清单特征含承台/大体积混凝土', test: boq => boq.entries.some(entry => /承台|大体积|基础底板/u.test(`${entry.name} ${entry.description}`)) },
    { name: '预应力张拉控制', measure: '张拉设备标定，双控（应力+伸长值）张拉，孔道压浆密实', basis: '清单特征含预应力/钢绞线', test: boq => boq.entries.some(entry => /预应力|张拉|钢绞线/u.test(`${entry.name} ${entry.description}`)) },
    { name: '隧道开挖与支护', measure: '超前地质预报，短进尺、弱爆破、强支护，监控量测信息化施工', basis: '清单特征含隧道洞身开挖', test: boq => boq.entries.some(entry => /隧道|洞身|掌子面/u.test(`${entry.name} ${entry.description}`)) },
    { name: '架梁起重吊装', measure: '编制吊装专项方案，吊装前试吊与支腿地基验算，专职指挥', basis: '清单特征含梁体架设', test: boq => boq.entries.some(entry => /架设|架梁|架桥机|吊装/u.test(`${entry.name} ${entry.description}`)) },
    { name: '高空作业安全控制', measure: '高墩作业平台封闭防护，设置安全网与临边防护，恶劣天气停止作业', basis: '清单特征含高墩/墩柱', test: boq => boq.entries.some(entry => /高墩|墩柱|盖梁/u.test(`${entry.name} ${entry.description}`)) },
  ],
  // laborQuotaTable 不配置：定额数据须来自权威定额库导入（编号与工日值真实可溯源），内置编造数据会污染投标文档推导依据
  deploymentFlowFallback: '分区段流水作业',
  sequenceFallback: '施工准备 → 基础工程 → 下部结构 → 上部结构 → 隧道洞身 → 桥面系与收尾',
  climateZone: undefined,
  powerFallbackText: '临时用电由现场总配电箱接入，采用 TN-S 三相五线制，各用电点单独计量（柴油机械不计入用电负荷）',
  waterNoteText: '施工用水以现场水源为主，总用水量按施工段核定',
};

// ═══════════════════════════════ 策略组 E：公路（二期组，机械化程度高，人工费占比低于桥隧） ═══════════════════════════════

/** 公路条目归类（定额工效知识不全，降级区间表达；核心子目由定额知识库覆盖） */
function highwayGroupOfEntry(entry: BoqEntry): string {
  const text = `${entry.name} ${entry.description}`;
  if (/土方|挖方|填方|清表|软基|路基/u.test(text) && entry.unit === 'm3') return '土方工程';
  if (/水稳|基层|级配|路床/u.test(text) && entry.unit === 'm2') return '路面基层';
  if (/沥青|面层|摊铺/u.test(text) && entry.unit === 'm2') return '沥青面层';
  // m² 计量混凝土路面单列分组（m³ 口径与 m² 口径不混桶，否则单位不匹配被丢弃）
  if (/混凝土|现浇/u.test(text) && entry.unit === 'm2') return '混凝土路面';
  if (/混凝土|现浇/u.test(text)) return '混凝土工程';
  if (/砌筑|砌体|边沟|护坡|挡墙/u.test(text)) return '砌筑工程';
  if (/钢筋|植筋/u.test(text)) return '钢筋工程';
  if (/护栏|标线|标志|交安|波形梁/u.test(text)) return '交安设施';
  return '安装工程';
}

export const highwayStrategy: BlueprintDerivationStrategy = {
  id: 'highway',
  projectTypes: ['公路'],
  milestoneGroups: [
    { key: 'prep', label: '施工准备', pattern: /清杂|拆除|场地平整|临建|临时|三通一平|测量放样/u },
    { key: 'subgrade', label: '路基工程', pattern: /路基|土方|挖方|填方|压实|软基|清表|路床/u },
    { key: 'pavement', label: '路面工程', pattern: /路面|水稳|基层|沥青|面层|摊铺|碾压|级配/u },
    { key: 'bridge', label: '桥涵工程', pattern: /桥梁|桥台|桥墩|桩基|梁板|涵洞|通道|台帽/u },
    { key: 'safety', label: '交安与附属收尾', pattern: /护栏|标线|标志|交安|绿化|排水|边沟|收尾|竣工/u },
  ],
  groupOfEntry: highwayGroupOfEntry,
  tradeMapping: [
    { trade: '机械操作工', pattern: /土方|挖方|填方|清表|路基/u },
    { trade: '压路机司机', pattern: /碾压|压实|路基|路面/u },
    { trade: '摊铺机司机', pattern: /摊铺|沥青|水稳|基层/u },
    { trade: '混凝土工', pattern: /混凝土|现浇|垫层/u },
    { trade: '钢筋工', pattern: /钢筋|植筋/u },
    { trade: '瓦工', pattern: /砌筑|砌体|边沟|护坡|挡墙/u },
    { trade: '交安工', pattern: /护栏|标线|标志|交安|波形梁/u },
    { trade: '普工', pattern: /清杂|拆除|平整|回填|清淤/u },
  ],
  laborUnitRange: {
    土方工程: { unit: 'm3', min: 0.08, max: 0.15 },
    路面基层: { unit: 'm2', min: 0.2, max: 0.4 },
    沥青面层: { unit: 'm2', min: 0.08, max: 0.15 },
    混凝土路面: { unit: 'm2', min: 0.15, max: 0.3 },
    混凝土工程: { unit: 'm3', min: 0.8, max: 1.5 },
    砌筑工程: { unit: 'm3', min: 1.2, max: 2.0 },
    钢筋工程: { unit: 't', min: 0.8, max: 1.5 },
    交安设施: { unit: 'm', min: 0.3, max: 0.6 },
    安装工程: { unit: '项', min: 0, max: 0 },
  },
  equipmentMapping: [
    { name: '推土机', spec: '', pattern: /清表|土方|填方|平整/u, unit: 'm3', basis: '土方摊铺平整（清单条目）' },
    { name: '平地机', spec: '', pattern: /路基|路床|平整/u, unit: 'm2', basis: '路床整平（清单条目）' },
    { name: '装载机', spec: '', pattern: /土方|挖方|填方|清运/u, unit: 'm3', basis: '土方装载（清单条目）' },
    { name: '压路机', spec: '8~12t', pattern: /碾压|压实/u, unit: 'm2', basis: '路基路面碾压（清单特征）' },
    { name: '摊铺机', spec: '', pattern: /摊铺|沥青|水稳/u, unit: 'm2', basis: '路面摊铺（清单条目）' },
    { name: '沥青洒布车', spec: '', pattern: /沥青|透层|粘层/u, unit: 'm2', basis: '沥青洒布（清单条目）' },
    { name: '挖掘机', spec: '0.6~1.0m³', pattern: /开挖|挖土|沟槽|土方/u, unit: 'm3', basis: '土方开挖（清单特征）' },
    { name: '自卸汽车', spec: '8t', pattern: /余方弃置|弃方|外运|回填/u, unit: 'm3', basis: '土方运输与回填（清单条目）' },
    { name: '洒水车', spec: '', pattern: /养护|洒水/u, unit: 'm2', basis: '养护洒水（清单条目）' },
  ],
  machinePowerTable: [
    { name: '推土机', kw: 75 },
    { name: '平地机', kw: 120 },
    { name: '装载机', kw: 160 },
    { name: '压路机', kw: 75 },
    { name: '摊铺机', kw: 110 },
    { name: '沥青洒布车', kw: 60 },
    { name: '挖掘机', kw: 90 },
    { name: '自卸汽车', kw: 120 },
    { name: '洒水车', kw: 90 },
  ],
  laborCostRatio: { min: 0.12, max: 0.2 },
  dailyWage: { min: 250, max: 350 },
  inspectionBatchRules: [
    { scope: '路基压实', namePattern: /路床|路基|填方/u, unit: 'm2', divisor: 1000, descTemplate: '路基压实度按每 1000m² 不少于 1 点检测，约 {count} 点（总面积 {total}m²）' },
    { scope: '水稳基层', namePattern: /水稳|基层/u, unit: 'm2', divisor: 1000, descTemplate: '水稳基层按每 1000m² 一个检验批，约 {count} 批（总面积 {total}m²）' },
    { scope: '沥青面层', namePattern: /沥青|面层/u, unit: 'm2', divisor: 1000, descTemplate: '沥青面层按每 1000m² 一个检验批，约 {count} 批（总面积 {total}m²）' },
  ],
  difficultyTemplates: [
    { name: '软土地基处理', measure: '软基处理方案专项设计（换填/搅拌桩/预压），沉降观测控制填筑速率', basis: '清单特征含软基处理', test: boq => boq.entries.some(entry => /软基|软土|换填|搅拌桩/u.test(`${entry.name} ${entry.description}`)) },
    { name: '交通疏导与半幅施工', measure: '分段半幅封闭施工，设置临时交通标志与导流设施，保障社会车辆通行', basis: '清单特征含保通/半幅施工', test: boq => boq.entries.some(entry => /保通|半幅|交通疏导|既有道路/u.test(`${entry.name} ${entry.description}`)) },
    { name: '路面平整度控制', measure: '摊铺机连续匀速作业，接缝处理与碾压工艺控制，平整度逐层检测', basis: '清单特征含沥青面层', test: boq => boq.entries.some(entry => /沥青|面层/u.test(`${entry.name} ${entry.description}`)) },
    { name: '路基沉降控制', measure: '分层填筑碾压，设置沉降观测点，填筑速率与观测数据联动', basis: '清单特征含高填方路基', test: boq => boq.entries.some(entry => /高填方|填方/u.test(`${entry.name} ${entry.description}`)) },
  ],
  // laborQuotaTable 不配置：定额数据须来自权威定额库导入（编号与工日值真实可溯源），内置编造数据会污染投标文档推导依据
  deploymentFlowFallback: '分段平行流水作业',
  sequenceFallback: '施工准备 → 路基工程 → 路面工程 → 桥涵工程 → 交安与附属收尾',
  climateZone: undefined,
  powerFallbackText: '临时用电由现场总配电箱接入，各用电点单独计量（柴油机械不计入用电负荷）',
  waterNoteText: '施工用水以现场水源为主，总用水量按施工段核定',
};

// ═══════════════════════════════ 策略组 F：水利（二期组，水工结构+金属结构安装特征） ═══════════════════════════════

/** 水利条目归类（定额工效知识不全，降级区间表达；核心子目由定额知识库覆盖） */
function waterConservancyGroupOfEntry(entry: BoqEntry): string {
  const text = `${entry.name} ${entry.description}`;
  if (/围堰|导流|截流|清淤|疏浚/u.test(text)) return '土方工程';
  if (/土方|挖方|填方|回填|开挖/u.test(text) && entry.unit === 'm3') return '土方工程';
  if (/闸门|启闭机|埋件|金属结构/u.test(text) && entry.unit === 't') return '金属结构安装';
  if (/护坡|护岸|堤防|格宾|浆砌/u.test(text) && entry.unit === 'm2') return '护坡工程';
  if (/钢筋|植筋/u.test(text)) return '钢筋工程';
  if (/模板|支模/u.test(text)) return '模板工程';
  // 「混凝土」词加 m3 单位条件：m² 计量护坡/衬砌混凝土不落 m³ 口径桶（否则单位不匹配被丢弃）
  if (/混凝土|现浇|底板|闸室|闸墩|泵站|翼墙|消力池/u.test(text) && entry.unit === 'm3') return '混凝土工程';
  if (/砌筑|砌体|砖|挡墙/u.test(text)) return '砌筑工程';
  if (/机电|水泵|电气/u.test(text)) return '安装工程';
  return '安装工程';
}

export const waterConservancyStrategy: BlueprintDerivationStrategy = {
  id: 'water-conservancy',
  projectTypes: ['水利水电'],
  milestoneGroups: [
    { key: 'prep', label: '施工准备与围堰导流', pattern: /清杂|拆除|围堰|导流|截流|临建|临时/u },
    { key: 'earthwork', label: '土方与基础工程', pattern: /土方|挖方|填方|基础|基坑|清淤|疏浚|开挖/u },
    { key: 'structure', label: '闸站结构工程', pattern: /混凝土|钢筋|模板|闸室|闸墩|泵站|翼墙|底板|消力池|挡墙|砌筑/u },
    { key: 'metal', label: '金属结构与机电安装', pattern: /金属结构|闸门|启闭机|埋件|机电|水泵|电气/u },
    { key: 'finish', label: '护坡堤防与收尾', pattern: /护坡|护岸|堤防|绿化|水土保持|收尾|竣工|验收/u },
  ],
  groupOfEntry: waterConservancyGroupOfEntry,
  tradeMapping: [
    { trade: '钢筋工', pattern: /钢筋|植筋/u },
    { trade: '模板工', pattern: /模板|支模/u },
    { trade: '混凝土工', pattern: /混凝土|现浇|底板|闸室|闸墩|泵站|翼墙|消力池/u },
    { trade: '瓦工', pattern: /砌筑|砌体|砖|挡墙|护坡/u },
    { trade: '金属结构安装工', pattern: /金属结构|闸门|启闭机|埋件/u },
    { trade: '机电安装工', pattern: /机电|水泵|电气|配电/u },
    { trade: '潜水工', pattern: /水下|潜水/u },
    { trade: '普工', pattern: /土方|清杂|拆除|平整|回填|清淤|开挖/u },
  ],
  laborUnitRange: {
    土方工程: { unit: 'm3', min: 0.08, max: 0.15 },
    混凝土工程: { unit: 'm3', min: 1.0, max: 2.0 },
    砌筑工程: { unit: 'm3', min: 1.2, max: 2.0 },
    钢筋工程: { unit: 't', min: 0.8, max: 1.5 },
    模板工程: { unit: 'm2', min: 0.3, max: 0.6 },
    金属结构安装: { unit: 't', min: 15, max: 25 },
    护坡工程: { unit: 'm2', min: 0.2, max: 0.4 },
    安装工程: { unit: '项', min: 0, max: 0 },
  },
  equipmentMapping: [
    { name: '挖掘机', spec: '0.6~1.0m³', pattern: /开挖|挖土|基坑|土方|清淤/u, unit: 'm3', basis: '土方开挖（清单特征）' },
    { name: '自卸汽车', spec: '8t', pattern: /余方弃置|弃方|外运|回填/u, unit: 'm3', basis: '土方运输与回填（清单条目）' },
    { name: '装载机', spec: '', pattern: /土方|挖方|填方|清运/u, unit: 'm3', basis: '土方装载（清单条目）' },
    { name: '混凝土输送泵', spec: '', pattern: /泵送|混凝土泵|混凝土/u, unit: 'm3', basis: '混凝土泵送（清单特征）' },
    { name: '履带式起重机', spec: '', pattern: /吊装|闸门|启闭机/u, unit: '', basis: '闸门与启闭机吊装（清单条目，不限计量单位）' },
    { name: '泥浆泵', spec: '', pattern: /围堰|降水|导流|排水/u, unit: '', basis: '基坑降水与排水（清单条目，不限计量单位）' },
    { name: '插入式振捣器', spec: '', pattern: /混凝土|振捣/u, unit: 'm3', basis: '混凝土浇筑（清单条目）' },
    { name: '蛙式打夯机', spec: '', pattern: /回填|夯实/u, unit: 'm3', basis: '回填夯实（清单条目）' },
  ],
  machinePowerTable: [
    { name: '挖掘机', kw: 90 },
    { name: '自卸汽车', kw: 120 },
    { name: '装载机', kw: 160 },
    { name: '混凝土输送泵', kw: 90 },
    { name: '履带式起重机', kw: 110 },
    { name: '泥浆泵', kw: 22 },
    { name: '插入式振捣器', kw: 1.5 },
    { name: '蛙式打夯机', kw: 3 },
  ],
  laborCostRatio: { min: 0.15, max: 0.25 },
  dailyWage: { min: 250, max: 350 },
  inspectionBatchRules: [
    { scope: '混凝土工程', namePattern: /混凝土/u, unit: 'm3', divisor: 100, descTemplate: '混凝土按浇筑批次留置标准养护试件，每 100m³ 一批，约 {count} 批（总量 {total}m³）' },
    { scope: '土方回填', namePattern: /回填|填方/u, unit: 'm3', divisor: 200, descTemplate: '土方回填按每 200m³ 一个检验批检测压实度，约 {count} 批（总量 {total}m³）' },
    { scope: '金属结构', namePattern: /闸门|启闭机/u, unit: '', divisor: 1, descTemplate: '金属结构逐件验收（出厂合格证+安装调试记录），共 {total} 件' },
  ],
  difficultyTemplates: [
    { name: '围堰导流与度汛', measure: '围堰按度汛标准设计施工，汛期值守与应急预案，度汛演练', basis: '清单特征含围堰/导流', test: boq => boq.entries.some(entry => /围堰|导流|度汛|截流/u.test(`${entry.name} ${entry.description}`)) },
    { name: '深基坑降水与支护', measure: '降水方案专项设计，分层开挖及时支护，周边沉降监测', basis: '清单特征含基坑降水', test: boq => boq.entries.some(entry => /降水|基坑|支护/u.test(`${entry.name} ${entry.description}`)) },
    { name: '大体积混凝土施工', measure: '分层浇筑、测温养护，掺加缓凝剂与矿物掺合料控制水化热', basis: '清单特征含底板/大体积混凝土', test: boq => boq.entries.some(entry => /底板|大体积|消力池/u.test(`${entry.name} ${entry.description}`)) },
    { name: '闸门启闭机安装精度控制', measure: '埋件安装精度预控，闸门与启闭机联动调试，止水严密性试验', basis: '清单特征含闸门/启闭机', test: boq => boq.entries.some(entry => /闸门|启闭机/u.test(`${entry.name} ${entry.description}`)) },
    { name: '水下作业安全控制', measure: '潜水作业双人值守，水下作业专项方案与应急预案', basis: '清单特征含水下作业', test: boq => boq.entries.some(entry => /水下|潜水/u.test(`${entry.name} ${entry.description}`)) },
  ],
  // laborQuotaTable 不配置：定额数据须来自权威定额库导入（编号与工日值真实可溯源），内置编造数据会污染投标文档推导依据
  deploymentFlowFallback: '分区段流水作业',
  sequenceFallback: '施工准备与围堰导流 → 土方与基础 → 闸站结构 → 金属结构与机电安装 → 护坡堤防与收尾',
  climateZone: undefined,
  powerFallbackText: '临时用电由现场总配电箱接入，各用电点单独计量（柴油机械不计入用电负荷）',
  waterNoteText: '施工用水以现场水源为主，总用水量按施工段核定',
};

// ═══════════════════════════════ 策略解析（确定性双信号，零 LLM） ═══════════════════════════════

/**
 * 双信号解析：
 * 1. 清单村分组 + 分部特征（优先，稳定）：boq.villages.length > 0 且清单文本命中「管网/道路/绿化/亮化」
 *    四类信号 ≥ 3 → village-municipal（美丽乡村类项目判别不依赖文本措辞）；
 * 2. 清单分部特征信号（跨类型同等水平）：房建/桥隧/公路/水利资料的分部名与条目名含类型专有词重复出现
 *    （如桥隧「下部结构工程/桥墩/箱梁」）→ 词频 ≥2 直接命中对应策略组。
 *    suggestProjectType 文本判别会因「结构」「基坑」等通用词密度高将桥隧/水利资料误判房建，
 *    故清单特征词优先于文本判别（与村域双信号同一哲学：清单特征优先、文本判别兑底）；
 * 3. 文本判别（兑底）：suggestProjectType(模板名+基本事实+章标题+清单分部) 13 类竞争制判别 →
 *    房建/装饰装修 → building；桥梁与隧道 → bridge-tunnel；公路 → highway；水利水电 → water-conservancy；
 * 4. 其余 → general。
 */
export function resolveDerivationStrategy(input: {
  basicFacts?: string;
  templateName?: string;
  chapterTitles: string[];
  boq: BillOfQuantitiesResult;
}): BlueprintDerivationStrategy {
  const boqText = [...new Set(input.boq.entries.map(entry => `${entry.section} ${entry.subsection} ${entry.name}`))].join(' ');
  const villageSignals = [
    /管网|排水|雨污|污水|给水|检查井/u,
    /道路|路床|路面|路缘石|青砖|散水/u,
    /绿化|栽植|种植|苗木|景观|喷播/u,
    /路灯|亮化|照明/u,
  ];
  const signalHits = villageSignals.filter(pattern => pattern.test(boqText)).length;
  if (input.boq.villages.length > 0 && signalHits >= 3) return villageMunicipalStrategy;
  // 清单分部特征信号（跨类型同等水平）：类型专有词在清单分部名/条目名中重复出现（词频 ≥2）
  // 直接命中对应策略组。桥隧/水利资料的分部名（下部结构/上部结构/闸站结构）含通用词「结构」
  // 会令文本判别密度仲裁误判房建，清单特征优先可根治（条目词频对真实资料鲁棒）。
  const typeSignalGroups: Array<{ strategy: BlueprintDerivationStrategy; patterns: RegExp[] }> = [
    { strategy: buildingStrategy, patterns: [/砌体|装饰|幕墙|地下室|层高|户型|塔吊|塔式起重机|脚手架|抹灰|门窗|屋面|防水/u] },
    { strategy: bridgeTunnelStrategy, patterns: [/桥墩|桥台|墩柱|盖梁|系梁|箱梁|梁板|支座|伸缩缝|桥面|隧道|洞身|衬砌|锚杆/u] },
    { strategy: highwayStrategy, patterns: [/路基|路面|沥青|水稳|摊铺|压实|面层/u] },
    { strategy: waterConservancyStrategy, patterns: [/闸室|闸墩|闸门|启闭机|围堰|导流|堤防|护坡|护岸|疏浚|水下/u] },
  ];
  const signalCounts = typeSignalGroups
    .map(group => ({
      strategy: group.strategy,
      count: group.patterns.reduce((sum, pattern) => {
        const matches = boqText.match(new RegExp(pattern.source, 'gu'));
        return sum + (matches ? matches.length : 0);
      }, 0),
    }))
    .sort((left, right) => right.count - left.count);
  if ((signalCounts[0]?.count || 0) >= 2) return signalCounts[0].strategy;
  const text = `${input.templateName || ''} ${input.basicFacts || ''} ${input.chapterTitles.join(' ')} ${boqText}`;
  const type = suggestProjectType(text);
  if (type === '房建' || type === '装饰装修') return buildingStrategy;
  if (type === '桥梁与隧道') return bridgeTunnelStrategy;
  if (type === '公路') return highwayStrategy;
  if (type === '水利水电') return waterConservancyStrategy;
  return generalStrategy;
}
