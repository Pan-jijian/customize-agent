/**
 * 正文图件生成（4.55.18 用户指认：图位只出字符、导出 PDF/DOCX 里没有"图"）：
 *
 * 现状与缺口：正文的「图位」此前只有图题行 + 等效数据表（4.55.12 W5 的载体），导出后是字符而非图形。
 * 本模块用 **SVG 矢量图**补齐真正的图——数据全部来自一体化蓝图（零 LLM、零编造）：
 *   · 施工进度计划横道图 / 总进度计划图 ← blueprint.schedule（工序 × 起止天序，关键线路着色）
 *   · 施工进度计划网络图 ← 同一 schedule 的节点-箭头链（关键线路加粗）
 *   · 项目管理机构图 ← 标准岗位层级（岗位为行业通用职能名，不含任何人员实名数据）
 * 施工总平面布置图**不自动绘制**：需要场地几何（红线/坐标/尺寸），自动生成必然编造，仍以数据表承载。
 *
 * 呈现口径：SVG 文本用 300dpi 级尺寸（viewBox 宽 760、字号 12–14px），导出 HTML/PDF 直接用矢量；
 * DOCX 由导出侧光栅化为 2× PNG 内联（文档格式限制，见 export.ts）。
 */
import type { BlueprintData } from './integratedBlueprint';

export interface GeneratedFigure {
  /** 图名（与图位规格同名，用于替换图题行） */
  name: string;
  /** 资产文件名（写入 generatedDocuments/assets/） */
  fileName: string;
  /** SVG 全文 */
  svg: string;
}

const FONT = `font-family="'PingFang SC','Microsoft YaHei','Noto Sans CJK SC',sans-serif"`;
const CRITICAL_COLOR = '#b45309';
const NORMAL_COLOR = '#1d4ed8';
const GRID_COLOR = '#e5e7eb';
const TEXT_COLOR = '#111827';

function escapeXml(text: string): string {
  return String(text).replace(/[<>&"']/gu, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char] || char));
}

/** 文件名 slug（中文保留，非法字符替换） */
function slugOf(name: string): string {
  return name.replace(/[^一-龥\w-]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '') || 'figure';
}

/** 横道图/总进度计划图：工序 × 起止天序（关键线路着色） */
export function buildScheduleGanttSvg(schedule: BlueprintData['schedule']): string | undefined {
  const items = (schedule || []).filter(item => item && Number.isFinite(item.startDay) && Number.isFinite(item.endDay));
  if (items.length === 0) return undefined;
  const rowHeight = 26;
  const top = 46;
  const left = 150;
  const right = 40;
  const width = 760;
  const chartWidth = width - left - right;
  const height = top + items.length * rowHeight + 34;
  const maxDay = Math.max(...items.map(item => item.endDay), 1);
  const x = (day: number) => left + (day / maxDay) * chartWidth;
  // 时间轴刻度（≈8 格，取整为整数天）
  const tickStep = Math.max(1, Math.round(maxDay / 8));
  const ticks: number[] = [];
  for (let day = 0; day <= maxDay; day += tickStep) ticks.push(day);
  if (ticks[ticks.length - 1] !== maxDay) ticks.push(maxDay);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${left}" y="24" ${FONT} font-size="14" font-weight="700" fill="${TEXT_COLOR}">施工进度计划横道图（单位：天）</text>`,
  ];
  for (const day of ticks) {
    parts.push(`<line x1="${x(day).toFixed(1)}" y1="${top - 8}" x2="${x(day).toFixed(1)}" y2="${(top + items.length * rowHeight).toFixed(1)}" stroke="${GRID_COLOR}" stroke-width="1"/>`);
    parts.push(`<text x="${x(day).toFixed(1)}" y="${top - 14}" ${FONT} font-size="10" fill="#6b7280" text-anchor="middle">第${day}天</text>`);
  }
  items.forEach((item, index) => {
    const y = top + index * rowHeight;
    const barY = y + 5;
    const barHeight = rowHeight - 12;
    const barX = x(item.startDay);
    const barWidth = Math.max(2, x(item.endDay) - barX);
    const label = item.label.length > 16 ? `${item.label.slice(0, 16)}…` : item.label;
    parts.push(`<text x="${left - 10}" y="${(y + rowHeight / 2 + 4).toFixed(1)}" ${FONT} font-size="12" fill="${TEXT_COLOR}" text-anchor="end">${escapeXml(label)}</text>`);
    parts.push(`<rect x="${barX.toFixed(1)}" y="${barY}" width="${barWidth.toFixed(1)}" height="${barHeight}" rx="2" fill="${item.critical ? CRITICAL_COLOR : NORMAL_COLOR}" opacity="0.85"/>`);
    parts.push(`<text x="${(barX + barWidth + 6).toFixed(1)}" y="${(y + rowHeight / 2 + 4).toFixed(1)}" ${FONT} font-size="11" fill="#374151">${item.duration}天</text>`);
  });
  parts.push(`<text x="${left}" y="${height - 12}" ${FONT} font-size="11" fill="#6b7280">■ 关键线路 / ■ 非关键线路（总工期 ${maxDay} 天，工序起止天序与进度计划表一致）</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

/** 网络图：节点-箭头链（关键线路加粗着色） */
export function buildScheduleNetworkSvg(schedule: BlueprintData['schedule']): string | undefined {
  const items = (schedule || []).filter(item => item && item.label);
  if (items.length === 0) return undefined;
  const width = 760;
  const boxWidth = 116;
  const boxHeight = 54;
  const gapX = items.length > 5 ? 18 : 28;
  const perRow = Math.min(items.length, Math.max(3, Math.floor((width - 40 + gapX) / (boxWidth + gapX))));
  const rows = Math.ceil(items.length / perRow);
  const height = 40 + rows * (boxHeight + 46);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="20" y="24" ${FONT} font-size="14" font-weight="700" fill="${TEXT_COLOR}">施工进度计划网络图（箭头链=工序逻辑，加粗=关键线路）</text>`,
  ];
  items.forEach((item, index) => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;
    const x = 20 + column * (boxWidth + gapX);
    const y = 40 + row * (boxHeight + 46);
    const stroke = item.critical ? CRITICAL_COLOR : NORMAL_COLOR;
    const label = item.label.length > 9 ? `${item.label.slice(0, 9)}…` : item.label;
    parts.push(`<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="6" fill="#f9fafb" stroke="${stroke}" stroke-width="${item.critical ? 2.4 : 1.2}"/>`);
    parts.push(`<text x="${x + boxWidth / 2}" y="${y + 22}" ${FONT} font-size="11" fill="${TEXT_COLOR}" text-anchor="middle">${escapeXml(label)}</text>`);
    parts.push(`<text x="${x + boxWidth / 2}" y="${y + 40}" ${FONT} font-size="10" fill="#6b7280" text-anchor="middle">${item.duration}天（第${item.startDay}～${item.endDay}天）</text>`);
    if (column < perRow - 1 && index < items.length - 1) {
      const arrowY = y + boxHeight / 2;
      parts.push(`<line x1="${x + boxWidth}" y1="${arrowY}" x2="${x + boxWidth + gapX - 6}" y2="${arrowY}" stroke="${stroke}" stroke-width="${item.critical ? 2.4 : 1.2}" marker-end="url(#arrow-${item.critical ? 'c' : 'n'})"/>`);
    } else if (index < items.length - 1) {
      const nextY = y + boxHeight + 46 + boxHeight / 2;
      parts.push(`<path d="M ${x + boxWidth / 2} ${y + boxHeight} L ${x + boxWidth / 2} ${nextY} L ${20 + boxWidth / 2} ${nextY}" fill="none" stroke="${stroke}" stroke-width="${item.critical ? 2.4 : 1.2}"/>`);
    }
  });
  parts.unshift(
    `<defs><marker id="arrow-n" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${NORMAL_COLOR}"/></marker>` +
    `<marker id="arrow-c" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${CRITICAL_COLOR}"/></marker></defs>`,
  );
  parts.push('</svg>');
  return parts.join('\n');
}

/**
 * 项目管理机构层级（单源）：机构图 SVG 与「机构图替代表」共用同一岗位数据，
 * 岗位名称取自行业通用职能，零人员实名数据。
 */
export const ORG_CHART_HIERARCHY = {
  top: '项目经理',
  second: ['技术负责人', '质量负责人', '安全负责人', '施工负责人', '材料负责人', '资料负责人'],
  third: ['土建施工班组', '钢结构安装班组', '安装专业班组', '装饰装修班组', '试验与检测组'],
} as const;

/** 项目管理机构图：标准岗位层级（岗位名称取自行业通用职能，零人员实名数据） */
export function buildOrgChartSvg(): string {
  const width = 760;
  const height = 380;
  const levelColors = ['#1d4ed8', '#0e7490', '#7c3aed'];
  const box = (x: number, y: number, w: number, h: number, text: string, color: string) => [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="#ffffff" stroke="${color}" stroke-width="1.6"/>`,
    `<text x="${x + w / 2}" y="${y + h / 2 + 5}" ${FONT} font-size="12" fill="${TEXT_COLOR}" text-anchor="middle">${escapeXml(text)}</text>`,
  ].join('');
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img">`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="20" y="24" ${FONT} font-size="14" font-weight="700" fill="${TEXT_COLOR}">项目管理机构图</text>`,
  ];
  // 第一层：项目经理
  const topW = 150;
  const topX = width / 2 - topW / 2;
  parts.push(box(topX, 44, topW, 40, ORG_CHART_HIERARCHY.top, levelColors[0]!));
  // 第二层：技术/质量/安全/施工/材料/资料
  const second = [...ORG_CHART_HIERARCHY.second];
  const secondW = 104;
  const gap = (width - 40 - second.length * secondW) / (second.length - 1);
  const secondY = 140;
  second.forEach((title, index) => {
    const x = 20 + index * (secondW + gap);
    parts.push(`<line x1="${width / 2}" y1="84" x2="${x + secondW / 2}" y2="${secondY}" stroke="${GRID_COLOR}" stroke-width="1.4"/>`);
    parts.push(box(x, secondY, secondW, 38, title, levelColors[1]!));
  });
  // 第三层：作业班组
  const third = [...ORG_CHART_HIERARCHY.third];
  const thirdW = 128;
  const thirdGap = (width - 40 - third.length * thirdW) / (third.length - 1);
  const thirdY = 248;
  third.forEach((title, index) => {
    const x = 20 + index * (thirdW + thirdGap);
    parts.push(`<line x1="${width / 2}" y1="178" x2="${x + thirdW / 2}" y2="${thirdY}" stroke="${GRID_COLOR}" stroke-width="1.2"/>`);
    parts.push(box(x, thirdY, thirdW, 36, title, levelColors[2]!));
  });
  parts.push(`<text x="20" y="${height - 14}" ${FONT} font-size="11" fill="#6b7280">注：图示为项目管理机构与岗位设置（职能层级）；项目部按本图配置管理人员，各岗位职责与协作关系见本章相应小节。</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

/** 图名 → 图件（不支持的图类返回 undefined，调用侧保持数据表/图题承载） */
export function buildFigureForName(blueprintData: BlueprintData | undefined, figureName: string): GeneratedFigure | undefined {
  const name = String(figureName || '').replace(/\s+/gu, '');
  if (!name) return undefined;
  if (/横道图|总进度计划图|进度计划图/.test(name)) {
    const svg = buildScheduleGanttSvg(blueprintData?.schedule || []);
    return svg ? { name, fileName: `fig-${slugOf('进度横道图')}.svg`, svg } : undefined;
  }
  if (/网络图/.test(name)) {
    const svg = buildScheduleNetworkSvg(blueprintData?.schedule || []);
    return svg ? { name, fileName: `fig-${slugOf('进度网络图')}.svg`, svg } : undefined;
  }
  if (/项目管理机构|机构图|组织架构/.test(name)) {
    return { name, fileName: `fig-${slugOf('项目管理机构图')}.svg`, svg: buildOrgChartSvg() };
  }
  return undefined;
}
