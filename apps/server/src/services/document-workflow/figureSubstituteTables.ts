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

const DASH = '—';

function tableLines(header: string[], rows: string[][]): string[] {
  const head = `| ${header.join(' | ')} |`;
  const divider = `| ${header.map(() => '---').join(' | ')} |`;
  return [head, divider, ...rows.map(row => `| ${row.join(' | ')} |`)];
}

/** 进度类图（横道图/网络图/总进度计划图）：工序/持续天数/起止天序/线路性质/依据 */
function scheduleTableLines(data: BlueprintData): string[] | undefined {
  const items = data.schedule || [];
  if (items.length === 0) return undefined;
  const rows = items.map(item => [
    item.label,
    Number.isFinite(item.duration) ? String(item.duration) : DASH,
    `第${item.startDay}～${item.endDay}天`,
    item.critical ? '关键线路' : '非关键线路',
    item.basis || DASH,
  ]);
  return tableLines(['工序', '持续天数', '起止天序', '线路性质', '依据'], rows);
}

/** 总平面布置图：设施/面积/位置/使用时长/说明 */
function tempLandTableLines(data: BlueprintData): string[] | undefined {
  const items = data.tempLand || [];
  if (items.length === 0) return undefined;
  const rows = items.map(item => [
    item.purpose,
    typeof item.area === 'number' && Number.isFinite(item.area) ? String(item.area) : DASH,
    item.location || DASH,
    item.duration || DASH,
    item.note || DASH,
  ]);
  return tableLines(['设施', '面积（平方米）', '位置', '使用时长', '说明'], rows);
}

/** 图名 → 替代表行（无匹配图类或无蓝图数据时返回 undefined，调用方保持原形态） */
export function figureSubstituteTableLines(blueprintData: BlueprintData | undefined, figureName: string): string[] | undefined {
  if (!blueprintData) return undefined;
  const name = figureName.replace(/\s+/gu, '');
  if (/横道图|网络图|进度计划|总进度/.test(name)) return scheduleTableLines(blueprintData);
  if (/总平面|平面布置/.test(name)) return tempLandTableLines(blueprintData);
  return undefined;
}
