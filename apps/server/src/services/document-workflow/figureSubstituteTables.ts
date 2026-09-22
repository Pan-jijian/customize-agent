/**
 * 图类替代表（W5 正文侧承载，4.55.12 巢湖实测归因）：
 *
 * **现象**：正文出现「图1-1 施工总平面布置图 / 图1-2 施工进度计划横道图 / …图1-5 项目管理机构图」
 * 五条裸图题，其下无任何内容——图位被当作已承载（检测器只认「图名是否出现」），
 * 而 W5 要求的「无图则等效数据表 + 题注」在正文侧根本没有构造器（只有文末附表区有）。
 *
 * **本模块**：把图类规格映射到一体化蓝图的**现成结构化数据**（零编造），
 * 输出可直接注入正文的 Markdown 表行（含题注由调用方补）。数据源与文末附表四/附表五同源
 * （schedule / tempLand），保证同一图类在正文与附表两处口径一致。
 *
 * 无对应蓝图数据（如「项目管理机构图」无岗位数据）→ 返回 undefined，不造数据：
 * 该图类由写作侧「岗位责任矩阵」硬性要求承载，残留缺口交检测器报告。
 */
import type { BlueprintData } from './integratedBlueprint';

/**
 * 项目管理机构层级（单源）：机构替代表用（原在 documentFigures.ts，4.55.25 图件整体删除后迁入）。
 * 岗位名称取自行业通用职能，零人员实名数据。
 */
export const ORG_CHART_HIERARCHY = {
  top: '项目经理',
  second: ['技术负责人', '质量负责人', '安全负责人', '施工负责人', '材料负责人', '资料负责人'],
  third: ['土建施工班组', '钢结构安装班组', '安装专业班组', '装饰装修班组', '试验与检测组'],
} as const;

/** 各图类替代表的表头（单源：表构造与「图类要求是否已以表落实」的覆盖率判定共用） */
export const FIGURE_TABLE_HEADERS = {
  schedule: ['工序', '持续天数', '起止天序', '线路性质', '依据'],
  tempLand: ['设施', '面积（平方米）', '位置', '使用时长', '说明'],
  orgChart: ['层级', '岗位／班组', '直接上级'],
} as const satisfies Record<string, readonly string[]>;

/** 图名 → 该图类替代表的表头行（无匹配图类时 undefined；不依赖蓝图数据，供覆盖率判定使用） */
export function figureTableHeaderRow(figureName: string): string | undefined {
  const name = String(figureName || '').replace(/\s+/gu, '');
  if (!name) return undefined;
  if (/项目管理机构|机构图|组织架构/.test(name)) return `| ${[...FIGURE_TABLE_HEADERS.orgChart].join(' | ')} |`;
  if (/横道图|网络图|进度计划|总进度/.test(name)) return `| ${[...FIGURE_TABLE_HEADERS.schedule].join(' | ')} |`;
  if (/总平面|平面布置/.test(name)) return `| ${[...FIGURE_TABLE_HEADERS.tempLand].join(' | ')} |`;
  return undefined;
}

/**
 * 表行构造（4.55.25 用户口径）：**无数据的行不出，无数据的表不出**。
 * · 任一单元格为空/占位（—、/、待定、无数据…）→ **该行整行丢弃**（不用「—」搪塞）
 * · 有效数据行为 0 → 返回 undefined（该表不出现，宁可少一张表，不出一张空话表）
 */
const PLACEHOLDER_CELL_RE = /^(?:—+|--+|-|\/|待定|待补充|待确认|待查|暂无|无数据|无|若干|N\/A|n\/a|略)$/u;

function tableLines(header: string[], rows: string[][]): string[] | undefined {
  const usable = rows.filter(row => row.length === header.length && row.every(cell => {
    const text = String(cell ?? '').trim();
    return text.length > 0 && !PLACEHOLDER_CELL_RE.test(text);
  }));
  if (usable.length === 0) return undefined;
  const head = `| ${header.join(' | ')} |`;
  const divider = `| ${header.map(() => '---').join(' | ')} |`;
  return [head, divider, ...usable.map(row => `| ${row.join(' | ')} |`)];
}

/** 进度类图（横道图/网络图/总进度计划图）：工序/持续天数/起止天序/线路性质/依据 */
function scheduleTableLines(data: BlueprintData): string[] | undefined {
  const items = data.schedule || [];
  if (items.length === 0) return undefined;
  const rows = items.map(item => [
    item.label,
    Number.isFinite(item.duration) ? String(item.duration) : '',
    `第${item.startDay}～${item.endDay}天`,
    item.critical ? '关键线路' : '非关键线路',
    item.basis || '',
  ]);
  return tableLines([...FIGURE_TABLE_HEADERS.schedule], rows);
}

/** 总平面布置图：设施/面积/位置/使用时长/说明 */
function tempLandTableLines(data: BlueprintData): string[] | undefined {
  const items = data.tempLand || [];
  if (items.length === 0) return undefined;
  const rows = items.map(item => [
    item.purpose,
    typeof item.area === 'number' && Number.isFinite(item.area) ? String(item.area) : '',
    item.location || '',
    item.duration || '',
    item.note || '',
  ]);
  return tableLines([...FIGURE_TABLE_HEADERS.tempLand], rows);
}

/**
 * 项目管理机构图替代表（4.55.24）：
 * 机构图原本恒返回 undefined（原注释：无岗位数据、不造数据），但正文只留裸图题即「图位无承载」，
 * 与「图类一律数据化」口径冲突。现改用机构图的**同一份层级数据**（ORG_CHART_HIERARCHY 单源）
 * 输出「层级／岗位班组／直接上级」表——只陈述层级归属，不编造职责与人数。
 */
function orgChartTableLines(): string[] | undefined {
  const rows: string[][] = [
    ['第一层', ORG_CHART_HIERARCHY.top, '公司管理层'],
    ...ORG_CHART_HIERARCHY.second.map(title => ['第二层', title, ORG_CHART_HIERARCHY.top]),
    ...ORG_CHART_HIERARCHY.third.map(title => ['第三层', title, '各专业负责人']),
  ];
  return tableLines([...FIGURE_TABLE_HEADERS.orgChart], rows);
}

/** 图名 → 替代表行（无匹配图类或无蓝图数据时返回 undefined，调用方保持原形态） */
export function figureSubstituteTableLines(blueprintData: BlueprintData | undefined, figureName: string): string[] | undefined {
  const name = String(figureName || '').replace(/\s+/gu, '');
  if (!name) return undefined;
  // 机构图为纯层级数据（不依赖蓝图），故在蓝图判空之前处理
  if (/项目管理机构|机构图|组织架构/.test(name)) return orgChartTableLines();
  if (!blueprintData) return undefined;
  if (/横道图|网络图|进度计划|总进度/.test(name)) return scheduleTableLines(blueprintData);
  if (/总平面|平面布置/.test(name)) return tempLandTableLines(blueprintData);
  return undefined;
}
