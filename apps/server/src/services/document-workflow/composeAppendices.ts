const NL = String.fromCharCode(10);

/**
 * L5 编排导出：封面信息块 / 附图图位索引 / 关键工艺参数汇总附录。
 * 正文完成后追加到 Markdown 末尾，强化表格化渲染与图位管理。
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

function collectChapterTitles(markdown: string) {
  return [...markdown.matchAll(/^##\s+(.+)$/gmu)].map(match => ({ index: match.index || 0, title: (match[1] || '').trim() }));
}

function chapterTitleAt(titles: Array<{ index: number; title: string }>, index: number) {
  let current = '';
  for (const item of titles) {
    if (item.index > index) break;
    current = item.title;
  }
  return current;
}

/** 附录A：附图与图位索引 —— 归集正文引用的图号与引用上下文 */
export function composeDrawingIndexMarkdown(markdown: string) {
  const chapterTitles = collectChapterTitles(markdown);
  const refs = new Map<string, { chapter: string; caption: string }>();
  const drawingRefRe = /图\s*\d+(?:[-—–._]\s*\d+)?/gu;
  for (const match of markdown.matchAll(drawingRefRe)) {
    const index = match.index || 0;
    const before = markdown.slice(Math.max(0, index - 10), index);
    const tail = markdown.slice(index + match[0].length, index + match[0].length + 40);
    if (!/[见详参见如按依引用]/u.test(before) && !/所示|做法|大样|剖面|平面|立面|示意|附图/u.test(tail)) continue;
    const ref = match[0].replace(/\s+/gu, '');
    if (refs.has(ref)) continue;
    const caption = tail.replace(/\s+/gu, ' ').split(/[。；;|]/u)[0]?.trim().slice(0, 24) || '';
    refs.set(ref, { chapter: chapterTitleAt(chapterTitles, index), caption });
  }
  if (refs.size === 0) return '';
  const rows = [...refs.entries()].map(([ref, info]) => `| ${ref} | ${info.chapter} | ${info.caption ? `正文引用，上下文：${info.caption}` : '正文引用'} |`);
  return [
    '',
    '## 附录A：附图与图位索引',
    '',
    '> 图位说明：正文引用的图号由编制人按正式图纸目录替换核验，插图位置以各章小节内容对应布置。',
    '',
    '| 图号 | 所属章节 | 引用说明 |',
    '| --- | --- | --- |',
    ...rows,
  ].join(NL);
}

/** 附录B：关键工艺参数汇总 —— 归集正文工艺参数声明，供评标快速检索 */
export function composeProcessParameterSummaryMarkdown(markdown: string) {
  const chapterTitles = collectChapterTitles(markdown);
  const paramTermRe = /间距|偏差|厚度|压实度|坡度|强度等级|抗渗|配合比|坍落度|搭接长度|锚固长度|保护层|焊缝|闭水|严密性|垂直度|平整度|标高|涂层|养护|偏差值/u;
  const paramValueRe = /\d+(?:\.\d+)?\s*(?:mm|MPa|kN|kPa|℃|%|cm|m2|m3)/u;
  const rows: string[] = [];
  const seen = new Set<string>();
  const excludedTitles = new Set(['目录']);
  let offset = 0;
  for (const line of markdown.split(NL)) {
    offset += line.length + 1;
    if (!paramTermRe.test(line) || !paramValueRe.test(line)) continue;
    if (/^\s*[|#]/u.test(line)) continue;
    const compact = line.replace(/\s+/gu, ' ').trim();
    if (compact.length < 14 || compact.length > 100) continue;
    const chapter = chapterTitleAt(chapterTitles, offset);
    if (excludedTitles.has(chapter)) continue;
    const key = compact.slice(0, 36);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(`| ${chapter} | ${compact.replace(/\|/gu, '／')} |`);
    if (rows.length >= 40) break;
  }
  if (rows.length < 3) return '';
  return [
    '',
    '## 附录B：关键工艺参数汇总',
    '',
    '> 本表由正文工艺参数自动归集，供评标快速检索；正式投标文件以设计图纸与专项施工方案为准。',
    '',
    '| 所属章节 | 工艺参数要点 |',
    '| --- | --- |',
    ...rows,
  ].join(NL);
}

/** 汇总生成文档尾部的图位索引与参数汇总附录（无内容时返回空字符串） */
export function composeDocumentAppendicesMarkdown(markdown: string) {
  return [composeDrawingIndexMarkdown(markdown), composeProcessParameterSummaryMarkdown(markdown)].filter(Boolean).join(NL);
}

interface MarkdownTableBlock {
  header: string[];
  lines: string[];
}

/** 提取 markdown 全部表格块（表头行+分隔行开头，直到非表格行结束） */
function extractMarkdownTableBlocks(markdown: string): MarkdownTableBlock[] {
  const lines = markdown.split(NL);
  const tables: MarkdownTableBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    const next = (lines[index + 1] || '').trim();
    if (line.startsWith('|') && /^\|\s*:?-{3,}/u.test(next)) {
      const blockLines: string[] = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        blockLines.push(lines[index]);
        index += 1;
      }
      const header = blockLines[0].split('|').map(cell => cell.trim()).filter(Boolean);
      tables.push({ header, lines: blockLines });
      continue;
    }
    index += 1;
  }
  return tables;
}

/** 把一行表格文本拆成单元格（保留中间空单元格；去除首尾边框空位） */
function splitTableRow(line: string): string[] {
  const parts = line.split('|');
  if (parts.length > 0 && (parts[0] ?? '').trim() === '') parts.shift();
  if (parts.length > 0 && (parts[parts.length - 1] ?? '').trim() === '') parts.pop();
  return parts.map(cell => cell.trim());
}

/** 表格块 → 数据行（去表头与分隔行） */
function tableDataRows(table: MarkdownTableBlock): string[][] {
  return table.lines.slice(2).map(splitTableRow).filter(row => row.length > 0);
}

/** 表头列定位（按模式顺序返回第一个命中列索引；未命中返回 -1） */
function columnIndex(header: string[], patterns: RegExp[]): number {
  for (const pattern of patterns) {
    const index = header.findIndex(cell => pattern.test(cell));
    if (index >= 0) return index;
  }
  return -1;
}

/** 表头须同时命中每个分组（组间 AND、组内 OR） */
function headerMatches(header: string[], groups: RegExp[][]): boolean {
  return groups.every(group => group.some(pattern => header.some(cell => pattern.test(cell))));
}

/** CJK 语境断词空格（PDF 提取/生成断词产生“一般土方 开挖”类空格；只清理汉字与中文标点之间，保留拉丁/数字间距） */
const CJK_SPACE_RE = /([\u3400-\u9fff\u3000-\u303f\uff00-\uffef])[ \u3000]+(?=[\u3400-\u9fff\u3000-\u303f\uff00-\uffef])/gu;

/** 单元格清洗：竖线替换全角（防破坏表格结构）+ 断词空格清理 */
function cleanCell(value: string): string {
  return (value || '').replace(/\|/gu, '／').replace(CJK_SPACE_RE, '$1').trim();
}

/** 原文表格行清洗（分隔行原样保留，数据行单元格做断词空格清理） */
function cleanTableLines(lines: string[]): string[] {
  return lines.map(line => (/^\|[\s:|-]+$/u.test(line) ? line : `| ${splitTableRow(line).map(cleanCell).join(' | ')} |`));
}

/** markdown 表格渲染 */
function renderTable(header: string[], rows: string[][]): string[] {
  return [
    `| ${header.map(cleanCell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${row.map(cleanCell).join(' | ')} |`),
  ];
}

/** 占位符归一（“—”“-”“/”等视为无数据） */
function meaningfulValue(value: string): string {
  const trimmed = (value || '').trim();
  return /^[-—－–—/／]+$/u.test(trimmed) ? '' : trimmed;
}

const DASH = '—';

/**
 * 4.35 附表一：拟投入本标段的主要施工设备表。
 * 正文按章分散的多张设备/机械表（设备计划章、总平面章、机电安装表等）全量归集，
 * 按设备名称去重合并（规格/数量/功率/用途取首个非空），再按招标列格式渲染；无数据列填“—”。
 */
function composeEquipmentAppendix(tables: MarkdownTableBlock[]): string[] | '' {
  const collected = new Map<string, { spec: string; qty: string; power: string; usage: string }>();
  for (const table of tables) {
    const header = splitTableRow(table.lines[0] || '');
    // 工程设备安装清单（含安装方式/安装高度/技术参数要求列）不是拟投入施工设备；仪器表由附表二归集
    if (header.some(cell => /安装方式|安装高度|安装位置|技术参数要求/u.test(cell))) continue;
    if (header.some(cell => /仪器/u.test(cell))) continue;
    if (!headerMatches(header, [[/设备名称|机械名称/], [/型号规格|规格型号/], [/数量/]])) continue;
    const nameIdx = columnIndex(header, [/机械设备名称|设备名称|机械名称/u]);
    const specIdx = columnIndex(header, [/型号规格|规格型号/u]);
    const qtyIdx = columnIndex(header, [/数量/u]);
    const powerIdx = columnIndex(header, [/额定功率/u]);
    const usageIdx = columnIndex(header, [/主要作业内容|使用部位|施工部位|用途|投入阶段/u]);
    if (nameIdx < 0 || specIdx < 0 || qtyIdx < 0) continue;
    for (const row of tableDataRows(table)) {
      const name = meaningfulValue(row[nameIdx] || '');
      if (!name || /^合计$/u.test(name) || /^序号$/u.test(name)) continue;
      // 仪器类行分流：由附表二归集（防止测试仪/万用表等混入施工设备表）
      if (INSTRUMENT_NAME_RE.test(name)) continue;
      const current = collected.get(name) || { spec: '', qty: '', power: '', usage: '' };
      collected.set(name, {
        spec: current.spec || meaningfulValue(row[specIdx] || ''),
        qty: current.qty || meaningfulValue(row[qtyIdx] || ''),
        power: current.power || (powerIdx >= 0 ? meaningfulValue(row[powerIdx] || '') : ''),
        usage: current.usage || (usageIdx >= 0 ? meaningfulValue(row[usageIdx] || '') : ''),
      });
    }
  }
  if (collected.size === 0) return '';
  const header = ['序号', '设备名称', '型号规格', '数量', '国别产地', '制造年份', '额定功率（kW）', '生产能力', '用于施工部位', '备注'];
  const rows = [...collected.entries()].map(([name, info], index) => [
    String(index + 1),
    name,
    info.spec || DASH,
    info.qty || DASH,
    DASH,
    DASH,
    info.power || DASH,
    DASH,
    info.usage || DASH,
    DASH,
  ]);
  return renderTable(header, rows);
}

/** 试验/检测仪器名称白名单（仅收录正文确有实词、不推断数量与用途） */
const INSTRUMENT_TERMS = [
  '接地电阻测试仪',
  '绝缘电阻测试仪',
  '耐压测试仪',
  '兆欧表',
  '万用表',
  '全站仪',
  '水准仪',
  '经纬仪',
  '回弹仪',
  '超声波测厚仪',
  '涂层测厚仪',
  '钢筋扫描仪',
  '坍落度筒',
  '灌砂法密度测定仪',
  '环刀法密度测定仪',
  '游标卡尺',
  '光纤熔接机',
  '光时域反射仪',
  '网络测试仪',
  '信号质量分析仪',
];

/** 仪器类名称模式（附表一行级分流：机械表中混编的仪器行转入附表二） */
const INSTRUMENT_NAME_RE = /测试仪|测试表|万用表|兆欧表|熔接机|反射仪|分析仪|测量仪|水准仪|全站仪|经纬仪|回弹仪|测厚仪|扫描仪|探测仪|探伤仪|检漏仪|压力表|温度计|风速仪|卡尺|千分尺|测距仪|测斜仪|应变仪|测定仪|坍落度筒/u;

/**
 * 4.35 附表二：拟配备本标段的试验和检测仪器设备表。
 * 正文仪器设备表（表头须为仪器语义，与施工设备表区分）归集 + 全文仪器词白名单扫描补充（不推断属性）。
 */
function composeInstrumentAppendix(tables: MarkdownTableBlock[], markdown: string): string[] | '' {
  const collected = new Map<string, { spec: string; qty: string; usage: string }>();
  for (const table of tables) {
    const header = splitTableRow(table.lines[0] || '');
    const nameIdx = columnIndex(header, [/仪器设备名称|仪器名称|检测仪器名称|试验仪器名称|仪表名称/u, /机械设备名称|设备名称|机械名称/u]);
    const specIdx = columnIndex(header, [/型号规格|规格型号/u]);
    const qtyIdx = columnIndex(header, [/数量/u]);
    const usageIdx = columnIndex(header, [/检测参数|使用工序|使用部位|用途/u]);
    if (nameIdx < 0 || specIdx < 0 || qtyIdx < 0) continue;
    // 仪器语义表头整表收编；机械/设备表头仅收编仪器类行（其余属施工机械，归附表一）
    const isInstrumentTable = headerMatches(header, [[/仪器设备名称|仪器名称|检测仪器名称|试验仪器/]]);
    for (const row of tableDataRows(table)) {
      const name = meaningfulValue(row[nameIdx] || '');
      if (!name || /^合计$/u.test(name) || /^序号$/u.test(name)) continue;
      if (!isInstrumentTable && !INSTRUMENT_NAME_RE.test(name)) continue;
      const current = collected.get(name) || { spec: '', qty: '', usage: '' };
      collected.set(name, {
        spec: current.spec || meaningfulValue(row[specIdx] || ''),
        qty: current.qty || meaningfulValue(row[qtyIdx] || ''),
        usage: current.usage || (usageIdx >= 0 ? meaningfulValue(row[usageIdx] || '') : ''),
      });
    }
  }
  for (const term of INSTRUMENT_TERMS) {
    if (!markdown.includes(term)) continue;
    // 与已收集名称互为子串视为同一器具（如“万用表”↔“数字万用表”），不重复列
    const duplicated = [...collected.keys()].some(name => name.includes(term) || term.includes(name));
    if (!duplicated) collected.set(term, { spec: '', qty: '', usage: '' });
  }
  if (collected.size === 0) return '';
  const header = ['序号', '仪器设备名称', '型号规格', '数量', '国别产地', '制造年份', '已使用台时数', '用途', '备注'];
  const rows = [...collected.entries()].map(([name, info], index) => [
    String(index + 1),
    name,
    info.spec || DASH,
    info.qty || DASH,
    DASH,
    DASH,
    DASH,
    info.usage || DASH,
    DASH,
  ]);
  return renderTable(header, rows);
}

/**
 * 4.35 附表三：劳动力计划表（招标格式为“工种×施工阶段”两维）。
 * 正文工种配置表与分阶段投入表分别归档展示（数据保真，不跨表推导人数矩阵）。
 */
function composeLaborAppendix(tables: MarkdownTableBlock[]): string[] | '' {
  const tradeTable = tables.find(table => {
    const header = splitTableRow(table.lines[0] || '');
    return /工种/u.test(header[0] || '') && headerMatches(header, [[/人数|配置人数/]]);
  });
  const phaseTable = tables.find(table => {
    const header = splitTableRow(table.lines[0] || '');
    return /施工阶段|阶段/u.test(header[0] || '') && headerMatches(header, [[/人数|在场人数|劳动力/]]);
  });
  if (!tradeTable && !phaseTable) return '';
  const parts: string[] = [];
  if (tradeTable) parts.push('**（一）劳动力工种配置**', '', ...cleanTableLines(tradeTable.lines));
  if (phaseTable) {
    if (parts.length > 0) parts.push('');
    parts.push('**（二）分阶段劳动力投入计划**', '', ...cleanTableLines(phaseTable.lines));
  }
  return parts;
}

/**
 * 4.35 附表六：临时用地表。
 * 正文临建设施表（设施名称/选址位置/占地面积）→ 招标列（用途/面积/位置/需用时间）转换映射；
 * 需用时间按行内语义判定（含“随…移动/转移”为随施工段使用，其余为施工全过程），不推断具体日期。
 */
function composeTempLandAppendix(tables: MarkdownTableBlock[]): string[] | '' {
  const table = tables.find(table => {
    const header = splitTableRow(table.lines[0] || '');
    return headerMatches(header, [[/设施名称|临时设施|场地名称|用地名称/], [/位置|选址/], [/面积|占地/]]);
  });
  if (!table) return '';
  const header = splitTableRow(table.lines[0] || '');
  const usageIdx = columnIndex(header, [/设施名称|临时设施|场地名称|用地名称|设施/u]);
  const locationIdx = columnIndex(header, [/选址位置|位置|选址/u]);
  const areaIdx = columnIndex(header, [/占地面积|面积/u]);
  if (usageIdx < 0 || locationIdx < 0 || areaIdx < 0) return '';
  const rows = tableDataRows(table)
    .map(row => {
      const usage = meaningfulValue(row[usageIdx] || '');
      const area = meaningfulValue(row[areaIdx] || '').replace(/平方米|m²|m2|㎡/giu, '').trim();
      const location = meaningfulValue(row[locationIdx] || '');
      const duration = /随[^，。；]*?(?:移动|转移)|随用随移/u.test(row.join('')) ? '随施工段使用' : '施工全过程';
      return [usage, area, location, duration];
    })
    .filter(row => row[0]);
  if (rows.length === 0) return '';
  return renderTable(['用途', '面积（平方米）', '位置', '需用时间'], rows);
}

/** 图类附表（进度网络图/总平面图）：不生成图件，输出专业图位说明供编制人绘制后附（招标原文：“图表及格式要求附后”） */
function composeGraphAppendixNote(name: string): string[] | '' {
  if (/进度网络图|施工进度网络图/u.test(name)) {
    return ['> **图件**：施工进度网络图（或以横道图表示）——标明计划开、竣工日期与各关键日期，按本施工组织设计进度计划绘制后附。'];
  }
  if (/总平面/u.test(name) && /图/u.test(name)) {
    return ['> **图件**：施工总平面布置图——绘出现场临时设施布置图（含加工车间、现场办公、设备及仓储、供电、供水、卫生、生活、道路、消防等设施）并附文字说明，绘制后附。'];
  }
  return '';
}

/**
 * 4.35 文末附表区：按招标文件附表清单生成「附表N 名称」+ 表格/图件说明。
 * 表类附表由正文同类表格确定性归集（附表一设备全量合并、附表二仪器、附表三劳动力、附表六临建用地）；
 * 图类附表（进度网络图/总平面图）由编制人人工补充，输出图位说明；正文无数据来源的表类附表跳过（不造数据）。
 */
export function composeTenderAppendixMarkdown(markdown: string, titles: string[]) {
  const tables = extractMarkdownTableBlocks(markdown);
  const sections: string[] = [];
  for (const title of titles) {
    const compactTitle = title.replace(/^附表\s*[一二三四五六七八九十\d]{1,3}\s*[:：]?\s*/u, '').trim();
    let body: string[] | '';
    if (/施工设备表|机械设备表/u.test(compactTitle)) {
      body = composeEquipmentAppendix(tables);
    } else if (/试验.*仪器|检测仪器|试验仪器/u.test(compactTitle)) {
      body = composeInstrumentAppendix(tables, markdown);
    } else if (/劳动力计划/u.test(compactTitle)) {
      body = composeLaborAppendix(tables);
    } else if (/临时用地/u.test(compactTitle)) {
      body = composeTempLandAppendix(tables);
    } else {
      body = composeGraphAppendixNote(compactTitle);
    }
    if (body && body.length > 0) sections.push([`## ${title}`, '', ...body].join(NL));
  }
  return sections.length > 0 ? sections.join(`${NL}${NL}`) : '';
}

/** 幂等追加文末附表区（无附表时不改动原文；已存在相同附表标题时跳过） */
export function appendTenderAppendixSections(markdown: string, appendix?: { titles: string[] } | undefined) {
  if (!appendix || appendix.titles.length === 0) return markdown;
  if (appendix.titles.some(title => markdown.includes(`## ${title}`))) return markdown;
  const section = composeTenderAppendixMarkdown(markdown, appendix.titles);
  if (!section) return markdown;
  return `${markdown.replace(/\s+$/u, '')}${NL}${NL}<div class="page-break"></div>${NL}${NL}${section}${NL}`;
}
