import type { BidAppendixEntry } from './bidComposition';
import type { BlueprintData } from './integratedBlueprint';

const NL = String.fromCharCode(10);
const DASH = '—';

/**
 * 文末附表区（招标附表清单直出）+ 标准封面。
 *
 * 附表数据源为一体化蓝图（BlueprintData.composition.appendixPlan 逐项绑定 dataSource）：
 * - blueprint.equipment → resources.equipment 确定性直出（备注列承载蓝图依据，可审计）；
 * - blueprint.labor → resources.labor.composition + byPhase 直出（两小节）；
 * - blueprint.testInstruments / blueprint.tempLand → 蓝图无对应数据源，输出招标表头骨架并
 *   显性标注数据缺口（不造数据）；
 * - figure / manual → 输出图件说明或按招标格式编制标注（不猜表头、不造数据）。
 * 正文表格归集路径已删除：暗标正文禁表、明标正文表格不重复承载附表数据，附表唯一数据源为蓝图。
 */

/** 施工组织设计标准封面：标题 + 项目基本信息表 */
export function composeEnhancedCoverMarkdown(title: string, facts?: Record<string, string>) {
  const factMap = facts || {};
  const pick = (...keys: string[]) => {
    const key = keys.find(item => Boolean(factMap[item]));
    return key ? String(factMap[key]).split('（来源')[0].trim() : '';
  };
  const projectName = pick('工程名称', '项目名称', '工程名');
  const builder = pick('建设单位', '建设单位名称', '发包人');
  const contractor = pick('施工单位', '承包单位', '承包人');
  const location = pick('建设地点', '工程地点', '项目地址');
  const scale = pick('建设规模', '建筑面积', '工程规模');
  const duration = pick('计划工期', '工期', '总工期');
  const quality = pick('质量标准', '质量目标', '质量等级');
  const infoRows = [
    ['工程名称', projectName || title],
    ['建设单位', builder],
    ['编制单位', contractor || builder],
    ['建设地点', location],
    ['建设规模', scale],
    ['计划工期', duration],
    ['质量标准', quality],
  ].filter(row => Boolean(row[1]));
  const coverTable = infoRows.length > 0
    ? ['', '| 项目 | 内容 |', '| --- | --- |', ...infoRows.map(row => `| ${row[0]} | ${row[1].replace(/\|/gu, '／')} |`)].join(NL)
    : '';
  return ['<div class="document-cover">', `# ${title}`, coverTable, '</div>'].filter(Boolean).join(NL);
}

/** CJK 语境断词空格（PDF 提取/生成断词产生“一般土方 开挖”类空格；只清理汉字与中文标点之间，保留拉丁/数字间距） */
const CJK_SPACE_RE = /([\u3400-\u9fff\u3000-\u303f\uff00-\uffef])[ \u3000]+(?=[\u3400-\u9fff\u3000-\u303f\uff00-\uffef])/gu;

/** 单元格清洗：竖线替换全角（防破坏表格结构）+ 断词空格清理 */
function cleanCell(value: string): string {
  return (value || '').replace(/\|/gu, '／').replace(CJK_SPACE_RE, '$1').trim();
}

/** markdown 表格渲染 */
function renderTable(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.map(cleanCell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cleanCell).join(' | ')} |`),
  ];
}

/** 数量口径渲染（quantity 优先；否则 min-max 区间；无数据 → —） */
function quantityText(item: { quantity?: number; min?: number; max?: number }): string {
  if (typeof item.quantity === 'number' && item.quantity > 0) return String(item.quantity);
  const { min, max } = item;
  if (typeof min === 'number' && typeof max === 'number') return min === max ? String(min) : `${min}-${max}`;
  if (typeof min === 'number') return String(min);
  if (typeof max === 'number') return String(max);
  return DASH;
}

/** 数据缺口骨架：编制说明 + 招标表头（不造数据；说明为投标人视角中性表述，无内部流程话术） */
function appendixGapSkeleton(header: string[], gapLabel: string): string[] {
  return [
    `> 本表为${gapLabel}，按招标文件规定的表头格式编制。`,
    '',
    ...renderTable(header, []),
  ];
}

const EQUIPMENT_HEADER = ['序号', '设备名称', '型号规格', '数量', '国别产地', '制造年份', '额定功率（kW）', '生产能力', '用于施工部位', '备注'];
const INSTRUMENT_HEADER = ['序号', '仪器设备名称', '型号规格', '数量', '国别产地', '制造年份', '已使用台时数', '用途', '备注'];
const TEMP_LAND_HEADER = ['用途', '面积（平方米）', '位置', '需用时间'];

/** 设备附表：拟投入本标段的主要施工设备表（蓝图 resources.equipment 直出；备注列承载蓝图依据） */
function renderEquipmentAppendix(data?: BlueprintData): string[] | '' {
  const items = data?.resources?.equipment || [];
  if (items.length === 0) return appendixGapSkeleton(EQUIPMENT_HEADER, '施工设备配置');
  const rows = items.map((item, index) => [
    String(index + 1),
    item.name,
    item.spec || DASH,
    quantityText(item),
    DASH,
    DASH,
    DASH,
    DASH,
    DASH,
    item.basis || DASH,
  ]);
  return renderTable(EQUIPMENT_HEADER, rows);
}

/** 劳动力附表：劳动力计划表（蓝图 resources.labor 直出：工种配置 + 分阶段投入两小节，口径同源） */
function renderLaborAppendix(data?: BlueprintData): string[] | '' {
  const composition = data?.resources?.labor?.composition || [];
  const byPhase = data?.resources?.labor?.byPhase || [];
  if (composition.length === 0 && byPhase.length === 0) {
    return [
      '> 本表为劳动力配置数据，按招标文件规定的表头格式编制。',
      '',
      ...renderTable(['工种', '人数', '备注'], []),
    ];
  }
  const parts: string[] = [];
  if (composition.length > 0) {
    parts.push('**（一）劳动力工种配置**', '', ...renderTable(['工种', '人数', '备注'], composition.map(item => [item.trade, String(item.count), item.basis || DASH])));
  }
  if (byPhase.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('**（二）分阶段劳动力投入计划**', '', ...renderTable(['施工阶段', '人数', '备注'], byPhase.map(item => [item.phase, quantityText(item), item.basis || DASH])));
  }
  return parts;
}

/** 图类附表（进度网络图/总平面图）：图件说明（投标人视角，零内部流程话术） */
function graphAppendixNote(name: string): string[] {
  if (/进度网络图|施工进度网络图|横道图/u.test(name)) {
    return ['> **图件说明**：本附表以施工进度网络图（或以横道图）形式表达，标明计划开工日期、竣工日期及各关键日期节点，工序逻辑与工期安排与本施工组织设计进度计划一致。'];
  }
  if (/总平面/u.test(name)) {
    return ['> **图件说明**：本附表为施工总平面布置图，反映现场临时设施布置（含加工车间、现场办公、设备及仓储、供电、供水、卫生、生活、道路、消防等设施）并附相应文字说明。'];
  }
  return ['> **图件说明**：本附表为图件类附表，按招标文件规定的格式与内容要求以图件形式呈现。'];
}

/** 单条附表渲染（按数据源绑定分发；无法识别的表类附表输出按招标格式编制标注，不猜表头） */
function renderAppendixEntry(entry: BidAppendixEntry, data?: BlueprintData): string[] | '' {
  if (entry.kind === 'figure') return graphAppendixNote(entry.title);
  switch (entry.dataSource) {
    case 'blueprint.equipment':
      return renderEquipmentAppendix(data);
    case 'blueprint.labor':
      return renderLaborAppendix(data);
    case 'blueprint.testInstruments':
      return appendixGapSkeleton(INSTRUMENT_HEADER, '试验检测仪器配置');
    case 'blueprint.tempLand':
      return appendixGapSkeleton(TEMP_LAND_HEADER, '临时用地规划');
    default:
      return ['> 本附表按招标文件规定的格式与内容要求编制。'];
  }
}

/**
 * 文末附表区：按招标附表清单（appendixPlan）逐项直出「附表N 名称」+ 数据内容/表头骨架/图件说明。
 * 数据源为一体化蓝图；蓝图无数据源的附表按招标表头生成骨架并显性标注缺口（不造数据）。
 */
export function composeTenderAppendixMarkdown(plan: BidAppendixEntry[], blueprintData?: BlueprintData) {
  const sections: string[] = [];
  for (const entry of plan) {
    const body = renderAppendixEntry(entry, blueprintData);
    if (body && body.length > 0) sections.push([`## ${entry.title}`, '', ...body].join(NL));
  }
  return sections.length > 0 ? sections.join(`${NL}${NL}`) : '';
}

/** 幂等追加文末附表区（无附表清单时不改动原文；已存在相同附表标题时跳过） */
export function appendTenderAppendixSections(markdown: string, appendix?: { plan: BidAppendixEntry[]; blueprintData?: BlueprintData } | undefined) {
  if (!appendix || appendix.plan.length === 0) return markdown;
  if (appendix.plan.some(entry => markdown.includes(`## ${entry.title}`))) return markdown;
  const section = composeTenderAppendixMarkdown(appendix.plan, appendix.blueprintData);
  if (!section) return markdown;
  return `${markdown.replace(/\s+$/u, '')}${NL}${NL}<div class="page-break"></div>${NL}${NL}${section}${NL}`;
}

/**
 * 附表条目承载判定（F-T2 承载率口径）：标题落位 + 内容承载——
 * 表类=数据/骨架表格或编制说明块，图类=图件说明块；仅有标题而内容缺失不计承载。
 * 与 renderAppendixEntry 的渲染格式同源（标题「## 名称」、内容为表格或引用块）。
 */
export function appendixEntryCarried(markdown: string, entry: BidAppendixEntry): boolean {
  const heading = `## ${entry.title}`;
  const start = markdown.indexOf(heading);
  if (start < 0) return false;
  const rest = markdown.slice(start + heading.length);
  const boundary = rest.search(/(?=^##\s)/mu);
  const body = (boundary >= 0 ? rest.slice(0, boundary) : rest).trim();
  if (!body) return false;
  return /^\|/mu.test(body) || /^>\s/mu.test(body);
}
