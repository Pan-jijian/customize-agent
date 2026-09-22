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
 * - blueprint.testInstruments → testInstruments 直出（C2：产地/年份/台时数如实留空，不造数据）；
 * - blueprint.schedule → schedule 直出（C2 图类附表表格化：图件说明 + 工序数据表）；
 * - blueprint.tempLand → tempLand 直出（C2：figure=总平面设施数据表，table=临时用地表）；
 * - 蓝图数据源为空 → 输出招标表头骨架并显性标注数据缺口（不造数据）；
 * - manual 图类 → 输出图件说明（C2 起图件说明块单独不计承载，须有数据化内容）。
 * C2 D4：附表区内内部推导话术由 cleanAppendixInternalPhrases 确定性中性化（唯一口径/经验
 * 工效区间/清单特征批注/附加工程量等 → 中性表述或移除；岗位+频次管理流程句移除）。
 * 正文表格归集路径已删除：附表数据唯一来源为蓝图，正文表格不重复承载（正文禁表口径下正文亦不出现表格）。
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
/** C2 附表四表格化表头（图类附表以数据表承接：工序/持续天数/起止天序/关键线路/说明） */
const SCHEDULE_HEADER = ['工序', '持续天数', '起止天序', '关键线路', '说明'];
/** C2 附表五表格化表头（施工总平面设施数据表；面积按设施配置或劳动力人均指标推导） */
const SITE_FACILITY_HEADER = ['设施', '面积（平方米）', '位置', '说明'];

/**
 * 列裁剪（4.55.22 用户口径）：**只输出每一行都有真实值的列**。
 *
 * 原实现把「国别产地/制造年份/额定功率/生产能力/用于施工部位」五列**硬编码为「—」**
 * （注释称"如实留空不造数据"）。用户口径：表格单元格不得为空、不得用「—/——」占位，
 * **每格必须有内容且有值**。而 `BlueprintEquipmentItem` 只有 `name/spec/quantity/basis`——
 * 这五列在数据模型里**根本没有权威来源**，留空与编造都不允许，唯一诚实的做法是**不出该列**。
 * 列裁剪是确定性的：全列有值才出，任一行为空即整列不出（不留半空列）。
 */
function pruneEmptyColumns<T>(header: string[], rows: T[][]): { header: string[]; rows: T[][] } {
  const keep = header.map((_, columnIndex) => rows.every(row => String(row[columnIndex] ?? '').trim() !== '' && String(row[columnIndex] ?? '').trim() !== DASH));
  return {
    header: header.filter((_, columnIndex) => keep[columnIndex]),
    rows: rows.map(row => row.filter((_, columnIndex) => keep[columnIndex])),
  };
}

/** 设备附表：拟投入本标段的主要施工设备表（蓝图 resources.equipment 直出；备注列承载蓝图依据）
 * 无权威来源的列（国别产地/制造年份/额定功率/生产能力/用于施工部位）整列不出——见 pruneEmptyColumns */
function renderEquipmentAppendix(data?: BlueprintData): string[] | '' {
  const items = data?.resources?.equipment || [];
  if (items.length === 0) return appendixGapSkeleton(EQUIPMENT_HEADER, '施工设备配置');
  // 4.55.22：投产信息列（国别产地/制造年份/额定功率/生产能力/用于施工部位）**有源就填**——
  // 从蓝图该项保留的源标签字段（extractLabeledAttributes）按表头名取值；无源则该列整列不出
  //（pruneEmptyColumns）。按字段名硬编码留空再靠检测端豁免，是「生成端与检测端口径打架」的老路。
  const pick = (item: { attributes?: Record<string, string> }, headerLabel: string): string => {
    const attributes = item.attributes;
    if (!attributes) return '';
    // 表头可能带单位后缀（「额定功率（kW）」），源标签通常不带——按去括号后的词干匹配
    const stem = headerLabel.replace(/[（(].*$/u, '').trim();
    for (const [label, value] of Object.entries(attributes)) {
      if (!value) continue;
      if (label === stem || label.includes(stem) || stem.includes(label)) return value;
    }
    return '';
  };
  const rows = items.map((item, index) => [
    String(index + 1),
    item.name,
    item.spec || pick(item, '型号规格'),
    quantityText(item),
    pick(item, '国别产地'),
    pick(item, '制造年份'),
    pick(item, '额定功率'),
    pick(item, '生产能力'),
    pick(item, '用于施工部位'),
    item.basis || '',
  ]);
  const pruned = pruneEmptyColumns(EQUIPMENT_HEADER, rows);
  return renderTable(pruned.header, pruned.rows);
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
    const comp = pruneEmptyColumns(['工种', '人数', '备注'], composition.map(item => [item.trade, String(item.count), item.basis || '']));
    parts.push('**（一）劳动力工种配置**', '', ...renderTable(comp.header, comp.rows));
  }
  if (byPhase.length > 0) {
    if (parts.length > 0) parts.push('');
    const phase = pruneEmptyColumns(['施工阶段', '人数', '备注'], byPhase.map(item => [item.phase, quantityText(item), item.basis || '']));
    parts.push('**（二）分阶段劳动力投入计划**', '', ...renderTable(phase.header, phase.rows));
  }
  return parts;
}

/** C2 附表二：试验检测仪器配置表（蓝图 testInstruments 直出；产地/年份/台时数为投产信息，如实留空不编造） */
function renderInstrumentAppendix(data?: BlueprintData): string[] | '' {
  const items = data?.testInstruments || [];
  if (items.length === 0) return appendixGapSkeleton(INSTRUMENT_HEADER, '试验检测仪器配置');
  const rows = items.map((item, index) => [
    String(index + 1),
    item.name,
    item.spec || '',
    quantityText(item),
    '', '', '',
    item.purpose || '',
    item.basis || '',
  ]);
  // 同设备附表：无权威来源的列（国别产地/制造年份/已使用台时数）整列不出（见 pruneEmptyColumns）
  const pruned = pruneEmptyColumns(INSTRUMENT_HEADER, rows);
  return renderTable(pruned.header, pruned.rows);
}

/** C2 附表四：进度计划表（图类附表表格化：图件说明 + 工序数据表，图件按表绘制）。
 * 数据源 schedule 由里程碑顺序累加推导（起止天序）；无数据时保留图件说明（不造数据）。 */
function renderScheduleAppendix(data?: BlueprintData): string[] {
  const note = '> **图件说明**：本附表以施工进度网络图（或以横道图）形式表达，标明计划开工日期、竣工日期及各关键日期节点；工序逻辑与工期安排与本施工组织设计进度计划一致，图件按下列工序数据表绘制。';
  const items = data?.schedule || [];
  if (items.length === 0) return [note];
  const rows = items.map(item => [
    item.label,
    String(item.duration),
    `第${item.startDay}～${item.endDay}天`,
    item.critical ? '关键线路' : '非关键线路',
    item.basis || '',
  ]);
  const pruned = pruneEmptyColumns(SCHEDULE_HEADER, rows);
  return [note, '', ...renderTable(pruned.header, pruned.rows)];
}

/** C2 附表五：施工总平面设施数据表（图类附表表格化：图件说明 + 设施数据表，图件按表绘制） */
function renderSiteFacilityAppendix(data?: BlueprintData): string[] {
  const note = '> **图件说明**：本附表为施工总平面布置图，反映现场临时设施布置（含加工车间、现场办公、设备及仓储、供电、供水、卫生、生活、道路、消防等设施）；图件按下列设施数据表绘制，并附相应文字说明。';
  const items = data?.tempLand || [];
  if (items.length === 0) return [note];
  const rows = items.map(item => [
    item.purpose,
    typeof item.area === 'number' ? String(item.area) : '',
    item.location || '',
    item.note || '',
  ]);
  const pruned = pruneEmptyColumns(SITE_FACILITY_HEADER, rows);
  return [note, '', ...renderTable(pruned.header, pruned.rows)];
}

/** C2 附表六：临时用地表（蓝图 tempLand 直出；表头按招标原文格式，需用时间列取设施时长口径） */
function renderTempLandAppendix(data?: BlueprintData): string[] | '' {
  const items = data?.tempLand || [];
  if (items.length === 0) return appendixGapSkeleton(TEMP_LAND_HEADER, '临时用地规划');
  const rows = items.map(item => [
    item.purpose,
    typeof item.area === 'number' ? String(item.area) : '',
    item.location || '',
    item.duration || '',
  ]);
  const pruned = pruneEmptyColumns(TEMP_LAND_HEADER, rows);
  return renderTable(pruned.header, pruned.rows);
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

/** 单条附表渲染（按数据源与 kind 绑定分发；C2：四附表数据化，图类附表表格化落位；
 * 无法识别的表类附表输出按招标格式编制标注，不猜表头） */
function renderAppendixEntry(entry: BidAppendixEntry, data?: BlueprintData): string[] | '' {
  switch (entry.dataSource) {
    case 'blueprint.equipment':
      return renderEquipmentAppendix(data);
    case 'blueprint.labor':
      return renderLaborAppendix(data);
    case 'blueprint.testInstruments':
      return renderInstrumentAppendix(data);
    case 'blueprint.schedule':
      return renderScheduleAppendix(data);
    case 'blueprint.tempLand':
      return entry.kind === 'figure' ? renderSiteFacilityAppendix(data) : renderTempLandAppendix(data);
    default:
      if (entry.kind === 'figure') return graphAppendixNote(entry.title);
      return ['> 本附表按招标文件规定的格式与内容要求编制。'];
  }
}

/** C2 D4 中性化映射：附表区内部推导话术 → 投标人中性表述（确定性、幂等、不引入新事实）。
 * 顺序敏感：先清长句（含附加量尾注），再清括号批注与兜底残句。 */
const APPENDIX_NEUTRALIZE_RULES: Array<{ pattern: RegExp; replace: string }> = [
  // 工种构成「唯一口径」中值收敛标注 → 中性配置表述
  { pattern: /工种构成唯一口径[：:]?按工种工程量区间中值比例收敛[（(][^）)]*[）)]/gu, replace: '按工种工程量比例配置' },
  // 分阶段依据（经验区间 + 峰值封顶标注）→ 中性测算表述
  { pattern: /阶段条目工程量约\s*[\d.]+\s*[^\s×]*\s*×\s*经验工效区间\s*÷\s*阶段\s*\d+\s*天[（(][^）)]*封顶[）)]/gu, replace: '按本阶段工程量及劳动力需用量测算' },
  // 工种依据（经验降级与定额命中两形态）→ 中性测算表述
  { pattern: /工种工程量约\s*[\d.]+\s*[^\s×]*\s*×\s*经验工效区间\s*÷\s*工期\s*\d+\s*天[（(][^）)]*[）)]/gu, replace: '按工种工程量及劳动力需用量测算' },
  { pattern: /工种工程量约\s*[\d.]+\s*[^\s×]*\s*×\s*定额工效[^÷]*÷\s*工期\s*\d+\s*天[（(][^）)]*[）)]/gu, replace: '按工种工程量及定额工效测算' },
  // 设备依据尾部「相关条目工程量合计」附注 → 移除
  { pattern: /[；;]\s*相关条目工程量合计约\s*[\d.]+\s*\S*/gu, replace: '' },
  // 清单批注（清单特征/清单条目）→ 移除
  { pattern: /[（(]清单(?:特征|条目)[）)]/gu, replace: '' },
  // 峰值区间和口径标注 → 中性表述
  { pattern: /各工种人数区间之和\s*[\d.]+~[\d.]+\s*人[（(][^）)]*[）)]/gu, replace: '按各工种配置人数合计测算' },
  // 兜底残句（单独出现的内部注记）
  { pattern: /[（(]定额工效知识不全[^）)]*[）)]/gu, replace: '' },
  { pattern: /[（(]定额知识库命中[）)]/gu, replace: '' },
];

/** 管理流程句移除（引用块/行级）：岗位+频次模式不进附表区（源头已隔离，此处为链尾兜底，幂等） */
const APPENDIX_FLOW_SENTENCE_RULES: Array<{ pattern: RegExp; replace: string }> = [
  { pattern: /[；，,]?\s*相关内容纳入施工组织设计与作业流程管理[^。\n]*。?/gu, replace: '' },
  { pattern: /[；，,]?\s*[^。；\n]{0,40}(?:资料员|测量员|施工员|质检员|安全员|材料员|技术员|试验员|预算员|机械员|监理员)[^。；\n]{0,40}(?:每日|每周|每月|每班|定期)[^。；\n]{0,40}。?/gu, replace: '' },
];

/**
 * C2 D4：附表区内部推导话术确定性清洗（幂等）——作用于「## 附表…」起的文末附表区。
 * ①中性化映射（单元格/文本级）：唯一口径/经验工效区间/清单批注/附加工程量 → 中性表述或移除；
 * ②管理流程句移除（行级）：岗位+频次模式不进附表区。
 * 清洗后不引入新事实；无附表区或未命中时原样返回（可重入）。
 */
export function cleanAppendixInternalPhrases(markdown: string): string {
  const start = markdown.search(/^##\s*附表/mu);
  if (start < 0) return markdown;
  const head = markdown.slice(0, start);
  let zone = markdown.slice(start);
  // C2 实测（s28l）：提取/生成产物存在 CJK 断词空格（「相关 条目工程量合计约」「（清单特征 ）」），
  // 不归一会致规则漏配（话术残留）——按 cleanCell 同源口径逐行归一后清洗（对无空格文本零影响）；
  // 标题行除外（「## 附表一 名称」的编号分隔空格属结构，不得归一，否则标题与承载判定失配）
  zone = zone.split(NL)
    .map(line => (/^#{1,6}\s/u.test(line.trim()) ? line : line.replace(CJK_SPACE_RE, '$1')))
    .join(NL);
  for (const rule of APPENDIX_NEUTRALIZE_RULES) zone = zone.replace(rule.pattern, rule.replace);
  for (const rule of APPENDIX_FLOW_SENTENCE_RULES) zone = zone.replace(rule.pattern, rule.replace);
  // 句移除后可能残留空引用行（「> 」）与多余空行 → 收敛
  zone = zone.replace(/^>\s*$/gmu, '');
  zone = zone.replace(/\n{3,}/gu, `${NL}${NL}`);
  return head + zone;
}

/**
 * 文末附表区：按招标附表清单（appendixPlan）逐项直出「附表N 名称」+ 数据内容/表头骨架/图件说明。
 * 数据源为一体化蓝图；蓝图无数据源的附表按招标表头生成骨架并显性标注缺口（不造数据）。
 * C2 D4：出口整体过清洗器（源头净版），链尾另有 delivery-structure-closure 兜底复洗（幂等）。
 */
export function composeTenderAppendixMarkdown(plan: BidAppendixEntry[], blueprintData?: BlueprintData) {
  const sections: string[] = [];
  for (const entry of plan) {
    const body = renderAppendixEntry(entry, blueprintData);
    if (body && body.length > 0) sections.push([`## ${entry.title}`, '', ...body].join(NL));
  }
  if (sections.length === 0) return '';
  return cleanAppendixInternalPhrases(sections.join(`${NL}${NL}`));
}

/** 幂等追加文末附表区（无附表清单时不改动原文；已存在相同附表标题时跳过） */
export function appendTenderAppendixSections(markdown: string, appendix?: { plan: BidAppendixEntry[]; blueprintData?: BlueprintData } | undefined) {
  if (!appendix || appendix.plan.length === 0) return markdown;
  if (appendix.plan.some(entry => markdown.includes(`## ${entry.title}`))) return markdown;
  const section = composeTenderAppendixMarkdown(appendix.plan, appendix.blueprintData);
  if (!section) return markdown;
  return `${markdown.replace(/\s+$/u, '')}${NL}${NL}<div class="page-break"></div>${NL}${NL}${section}${NL}`;
}

/** C2 D1 数据缺口说明块特征（骨架「本表为…编制」）：出现即不计承载 */
const APPENDIX_GAP_NOTE_RE = /^>\s*本表为[^\n]*(?:表头格式|格式与内容要求)[^\n]*编制/mu;

/** 表格真实数据行计数：表格块首行（表头）与分隔行之外的「有效单元格 ≥2（非空、非 —）」行；
 * 全部单元格为空/— 的行不计；多表格块独立识别（如劳动力附表两小节）。 */
function countAppendixDataRows(body: string): number {
  let inTable = false;
  let dataRows = 0;
  for (const line of body.split(NL)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      inTable = true; // 表格块首行 = 表头行（不计数）
      continue;
    }
    const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
    if (cells.every(cell => /^:?-{2,}:?$/u.test(cell))) continue; // 分隔行（| --- | --- |）
    const valid = cells.filter(cell => cell && cell !== DASH && cell !== '-').length;
    if (valid >= 2) dataRows += 1;
  }
  return dataRows;
}

/**
 * 附表条目承载判定（F-T2 承载率口径，C2 D1 内容级加固）：标题落位 + 内容承载——
 * ①骨架说明块（「本表为…按招标文件规定的表头格式编制」+ 空表头）不计承载（缺口话术即未承载）；
 * ②表类与图类统一须有 ≥2 条真实数据行（表头行/分隔行之外，有效单元格 ≥2 非空非 —）；
 * ③图类纯图件说明块不计承载（C2 图类附表表格化后由数据表承载）。
 */
export function appendixEntryCarried(markdown: string, entry: BidAppendixEntry): boolean {
  const heading = `## ${entry.title}`;
  const start = markdown.indexOf(heading);
  if (start < 0) return false;
  const rest = markdown.slice(start + heading.length);
  const boundary = rest.search(/(?=^##\s)/mu);
  const body = (boundary >= 0 ? rest.slice(0, boundary) : rest).trim();
  if (!body) return false;
  if (APPENDIX_GAP_NOTE_RE.test(body)) return false;
  return countAppendixDataRows(body) >= 2;
}
