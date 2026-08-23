/**
 * 参考文件质量画像提取（纯函数，无 IO）。
 * 用于模板参考库：把用户上传的优秀入围施组文件解析为可量化的质量特征，
 * 作为生成后质量对标的基准。画像只描述"形"（参数密度、工序链、结构），
 * 不提取事实内容——参考文件永不作为生成的事实材料。
 */

/** 参考文件支持的工程类型（覆盖建筑行业主要招标类型） */
export const REFERENCE_PROJECT_TYPES = ['房建', '市政', '公路', '桥梁与隧道', '水利水电', '电力', '机电安装', '装饰装修', '园林绿化', '铁路', '港口与航道', '矿山冶金', '其他'] as const;
export type ReferenceProjectType = (typeof REFERENCE_PROJECT_TYPES)[number];

/** 参考文件质量画像 */
export interface ReferenceQualityProfile {
  /** 全文有效字数（去空白，含目录/页眉等提取噪声） */
  wordCount: number;
  /** 正文有效字数（≥16 字且含中文的正文段落字数合计，参数密度与每章字数的分母口径） */
  effectiveWordCount: number;
  /** 工艺参数密度：命中数 / 千正文有效字数（mm/MPa/养护天数/间距偏差/中文单位等） */
  paramDensity: number;
  /** 工艺参数命中总数 */
  paramCount: number;
  /** 工序链覆盖率：含"→"段落数 / 总段落数（0-1） */
  arrowChainCoverage: number;
  /** 段落重复率：重复段落数 / 总段落数（0-1，越低越好） */
  duplicationRate: number;
  /** 表格数量 */
  tableCount: number;
  /** 一级章节数（第X章/第X篇） */
  sectionCount: number;
  /** 二级小节数（第X节/第X条；三级"一、/（一）/1.1"另计为 subitemCount，不混级） */
  subsectionCount: number;
  /** 三级子目数（"一、/（一）/1.1"形态，小节之下的细分条目） */
  subitemCount: number;
  /** 平均每章字数（正文有效字数口径） */
  avgSectionWords: number;
  /** 一级章节标题结构（去序号前缀、去空白断字与尾部页码） */
  headingStructure: string[];
  /** 表格标题清单（用于类型画像的常见表格统计） */
  tableTitles: string[];
  /** 工艺参数词条计数（中文参数词 + 数值参数归并，用于类型画像的高频参数统计） */
  paramTokens: Array<{ token: string; count: number }>;
  /** 参与覆盖率计算的正文段落总数（供类型画像加权聚合） */
  segmentCount: number;
  /** 含"→"工序链的段落数（供类型画像加权聚合） */
  arrowChainSegmentCount: number;
  /** 重复段落数（供类型画像加权聚合） */
  duplicatedSegmentCount: number;
}

/** 工艺参数口径（分支一：英文/符号单位；与质量校验的参数落位校验保持一致） */
const PARAM_HIT_RE = /(?:\d+(?:\.\d+)?\s*(?:mm|cm|m|㎡|m²|m2|m3|m³|kg|t|MPa|kPa|kN|V|KV|kV|A|天|%)(?![a-zA-Z\u4e00-\u9fa5])|\d+(?:\.\d+)?\s*(?:米|厘米|毫米|吨|千克|公斤|平方米|立方米)(?!\d)|(?:养护|搭接长度|试验压力|间距|偏差|坡度|含水率|压实度|强度等级|标号|厚度|宽度|高度|深度|直径|桩长|桩径))/gu;

/** 工序链：与 chapterPostProcessing 的箭头链口径一致 */
const ARROW_CHAIN_RE = /→|->/u;

/** 表格标记：正式表格标题行（"XX表/XX清单"结尾）或框线表格 */
const TABLE_MARK_RE = /^(?:[一二三四五六七八九十\d]+[、.．]?\s*)?[\u4e00-\u9fa5（）()、，A-Za-z0-9+\-·\s]{2,28}(?:表|清单)(?:[:：]|\s*$)/mu;

/** 一级章节标题："第X章/第X篇"（最明确，优先采用）；单级数字编号"1、"次之；多级"X.X"视为子目防正文误报。捕获组 1=章号（供去重），2=标题 */
const CHAPTER_HEADING_RE = /^第([一二三四五六七八九十百千\d]+)[章篇][、.．]?\s*(.{2,60})$/mu;
const NUMERIC_HEADING_RE = /^\d+[、.．](?!\d)\s*(.{2,20})$/mu;
const CN_NUMBERED_HEADING_RE = /^[一二三四五六七八九十]+[、.．]\s*(.{2,20})$/mu;
/** 二级小节标题："第X节/第X条"（章 → 节 → 目 严格分层，不与其他形态混级） */
const SUBSECTION_HEADING_RE = /^第[一二三四五六七八九十\d]+[节条][、.．]?\s*(.{2,30})$/mu;
/** 三级子目标题："一、/（一）/1.1"（小节之下的细分条目，单独统计，不计入小节） */
const SUBITEM_HEADING_RE = /^(?:[一二三四五六七八九十]+、\s*(.{2,20})|[（(][一二三四五六七八九十\d]+[）)]\s*(.{2,20})|\d+\.\d+(?:\.\d+)*[、.．\s]\s*(.{2,20}))$/mu;

/** 目录点线行与页码行（噪声，不算标题）；覆盖长点线（"....... 2"）与稀疏点线+页码（".. 26"）两种目录形态 */
const NOISE_HEADING_RE = /\.{4,}|\.{2,}\s*\d{1,3}\s*$|—\d+—|第\s*\d+\s*页|^\d{1,3}$/u;

/** 标题中间含逗顿号/冒号视为正文行（真正章节标题中间罕见出现这类标点） */
const BODY_LINE_RE = /[，、；：]/u;

/** 章节标题内的强正文标点：正文行以"第X章"开头引用章节（"第七章一致，不含…"）时的判别依据；顿号"、"是合法组合标题，不在此列 */
const CHAPTER_TITLE_BODY_RE = /[，。；：？！]/u;

/** 去除 PDF 提取文本的行首 markdown 前缀 */
function cleanHeadingLine(line: string): string {
  return line.trim().replace(/^(?:#+\s*)+/u, '').trim();
}

/** 清洗提取出的标题：先剥目录行尾部页码（"工程概况 12"），再去 PDF 断字空白（"确 保工期"）；先剥页码再并空白，避免"2023年度"类合法数字被误删 */
function cleanHeadingTitle(raw: string): string {
  return raw.replace(/[\s.．·]+\d{1,3}$/u, '').replace(/\s+/gu, '').trim();
}

/** 标题被 PDF 断行截断时续接下一短行（"…安全的管" + "理体系与措施"）；仅对 ≥20 字长标题生效，且续行须为 2-15 字非标题短行，降低误接正文风险 */
function joinSplitTitle(title: string, lines: string[], index: number): string {
  if (title.length < 20) return title;
  const next = cleanHeadingLine(lines[index + 1] || '');
  if (next.length < 2 || next.length > 15 || !/[\u4e00-\u9fa5]/u.test(next)) return title;
  if (NOISE_HEADING_RE.test(next)) return title;
  if (CHAPTER_HEADING_RE.test(next) || SUBSECTION_HEADING_RE.test(next) || SUBITEM_HEADING_RE.test(next) || NUMERIC_HEADING_RE.test(next) || CN_NUMBERED_HEADING_RE.test(next)) return title;
  const joined = title + next;
  return joined.length <= 60 ? joined : title;
}

/** 按段落切分：PDF 提取文本常见单行成段，过滤噪声行 */
function textSegments(text: string): string[] {
  return text
    .split(/\n+/u)
    .map(line => line.replace(/\s+/gu, ' ').trim())
    .filter(line => line.length >= 16 && /[\u4e00-\u9fa5]/u.test(line));
}

/** 段落去噪（用于重复率：剥离数字与标点后比较语义骨架） */
function segmentSkeleton(segment: string): string {
  return segment.replace(/[\d\s，。、；：""''（）()%…—\-·]/gu, '');
}

/** 标题候选是否有效（无噪声标记、无句中逗号、不以句末标点结尾） */
function isValidHeading(title: string): boolean {
  return title.length >= 2 && !BODY_LINE_RE.test(title) && !/[。，；]$/u.test(title);
}

/** 章号（中文数字或阿拉伯数字）转数值用于排序："十一"→11、"12"→12；无法解析时排最后 */
function chapterNumberValue(numeral: string): number {
  if (/^\d+$/u.test(numeral)) return Number.parseInt(numeral, 10);
  const digits: Record<string, number> = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let value = 0;
  let pending = 0;
  let parsed = false;
  for (const ch of numeral) {
    if (ch === '十') { value += (pending || 1) * 10; pending = 0; parsed = true; continue; }
    if (ch === '百') { value += (pending || 1) * 100; pending = 0; parsed = true; continue; }
    if (ch === '千') { value += (pending || 1) * 1000; pending = 0; parsed = true; continue; }
    const digit = digits[ch];
    if (digit === undefined) return Number.MAX_SAFE_INTEGER;
    pending = digit;
    parsed = true;
  }
  return parsed ? value + pending : Number.MAX_SAFE_INTEGER;
}

/**
 * 提取一级章节标题结构。
 * 优先级："第X章"（最明确）> 单级数字编号（"1、"）> 中文序号"一、"（简短施组常用，仅作最后降级）。
 * 返回 useCnAsChapter 供小节统计复用（避免"一、"被同时计为章节与小节）。
 */
function extractHeadingStructure(text: string): { headings: string[]; useCnAsChapter: boolean } {
  const chapterMap = new Map<string, string>();
  const numericCandidates: string[] = [];
  const cnCandidates: string[] = [];
  const lines = text.split(/\n+/u);
  for (let i = 0; i < lines.length; i += 1) {
    const line = cleanHeadingLine(lines[i]);
    if (!line || NOISE_HEADING_RE.test(line)) continue;
    const chapterMatch = CHAPTER_HEADING_RE.exec(line);
    if (chapterMatch) {
      // "第X章"前缀本身就是强信号：标题内顿号（"拟采用的新技术、新工艺"）是合法组合标题，
      // 不能套用 BODY_LINE_RE 过滤，否则真实章节会被漏计。
      // 同章号取末次出现：目录行在前、正文行在后，末次为正文标题，天然规避目录行重复计数
      const rawTitle = cleanHeadingTitle(chapterMatch[2] || '');
      if (rawTitle.length >= 2 && !CHAPTER_TITLE_BODY_RE.test(rawTitle)) chapterMap.set(chapterMatch[1], joinSplitTitle(rawTitle, lines, i));
      continue;
    }
    const cnMatch = CN_NUMBERED_HEADING_RE.exec(line);
    if (cnMatch) {
      const title = cleanHeadingTitle(cnMatch[1] || '');
      if (isValidHeading(title)) cnCandidates.push(title);
    }
  }
  // 单级数字编号仅在无"第X章"时统计（与第X章分支互斥，避免重复计数）
  if (chapterMap.size === 0) {
    for (const rawLine of lines) {
      const line = cleanHeadingLine(rawLine);
      if (!line || NOISE_HEADING_RE.test(line)) continue;
      const numericMatch = NUMERIC_HEADING_RE.exec(line);
      if (numericMatch) {
        const title = cleanHeadingTitle(numericMatch[1] || '');
        if (isValidHeading(title)) numericCandidates.push(title);
      }
    }
  }
  let headings: string[];
  let useCnAsChapter = false;
  if (chapterMap.size > 0) headings = [...chapterMap.entries()].sort((a, b) => chapterNumberValue(a[0]) - chapterNumberValue(b[0])).map(([, title]) => title);
  else if (numericCandidates.length >= 2) headings = numericCandidates;
  else { headings = cnCandidates; useCnAsChapter = true; }
  return { headings: [...new Set(headings)], useCnAsChapter };
}

/**
 * 分层统计小节与三级子目：章（第X章）→ 节（第X节/第X条）→ 目（一、/（一）/1.1）严格分层，不混级。
 * "一、"被提升为一级章节（无"第X章"的简短施组降级路径）时，不再计入子目。
 */
function countSubsectionLevels(text: string, skipCnNumbered: boolean): { subsectionCount: number; subitemCount: number } {
  let subsectionCount = 0;
  let subitemCount = 0;
  for (const rawLine of text.split(/\n+/u)) {
    const line = cleanHeadingLine(rawLine);
    if (!line || NOISE_HEADING_RE.test(line)) continue;
    const sectionMatch = SUBSECTION_HEADING_RE.exec(line);
    if (sectionMatch) {
      const title = cleanHeadingTitle(sectionMatch[1] || '');
      if (isValidHeading(title)) subsectionCount += 1;
      continue;
    }
    const itemMatch = SUBITEM_HEADING_RE.exec(line);
    if (itemMatch) {
      const title = cleanHeadingTitle(itemMatch[1] || itemMatch[2] || itemMatch[3] || '');
      if (!isValidHeading(title)) continue;
      // "一、"分支：被提升为一级章节时不计入子目
      if (skipCnNumbered && itemMatch[1] !== undefined) continue;
      subitemCount += 1;
    }
  }
  return { subsectionCount, subitemCount };
}

/** 统计表格标题数（"XX表/XX清单"结尾的标题行 + 框线/管道表格） */
function countTables(text: string): number {
  let count = 0;
  for (const rawLine of text.split(/\n+/u)) {
    const line = cleanHeadingLine(rawLine);
    if (!line) continue;
    if (TABLE_MARK_RE.test(line) || /^┌─/u.test(line) || /^\|.*\|.*\|$/u.test(line)) count += 1;
  }
  return count;
}

/** 提取表格标题清单（"XX表/XX清单"结尾的标题行，截断过长的正文误报） */
function extractTableTitles(text: string): string[] {
  const titles: string[] = [];
  for (const rawLine of text.split(/\n+/u)) {
    const line = cleanHeadingLine(rawLine);
    if (!line || line.length > 40 || line.length < 3) continue;
    if (TABLE_MARK_RE.test(line)) titles.push(line);
  }
  return [...new Set(titles)];
}

/** 中文工艺参数词（与 PARAM_HIT_RE 第二分支口径一致） */
const PARAM_WORD_RE = /(?:养护|搭接长度|试验压力|间距|偏差|坡度|含水率|压实度|强度等级|标号|厚度|宽度|高度|深度|直径|桩长|桩径)/gu;
/** 数值型参数命中（数字+单位，含中文单位），词条统一归并为"数值参数" */
const NUM_UNIT_TOKEN_RE = /(?:\d+(?:\.\d+)?\s*(?:mm|cm|m|㎡|m²|m2|m3|m³|kg|t|MPa|kPa|kN|V|KV|kV|A|天|%)(?![a-zA-Z\u4e00-\u9fa5])|\d+(?:\.\d+)?\s*(?:米|厘米|毫米|吨|千克|公斤|平方米|立方米)(?!\d))/gu;

/** 统计工艺参数词条：中文参数词按词计数，数字+单位统一归并，供类型画像的高频参数展示 */
function extractParamTokens(text: string): Array<{ token: string; count: number }> {
  const counts = new Map<string, number>();
  for (const match of text.match(PARAM_WORD_RE) || []) counts.set(match, (counts.get(match) || 0) + 1);
  const numericCount = (text.match(NUM_UNIT_TOKEN_RE) || []).length;
  if (numericCount > 0) counts.set('数值参数（数字+单位）', (counts.get('数值参数（数字+单位）') || 0) + numericCount);
  return [...counts.entries()].map(([token, count]) => ({ token, count })).sort((a, b) => b.count - a.count);
}

/** 工程类型自动分类建议：强判别词竞争制 + 密度兜底仲裁 */
export function suggestProjectType(text: string): ReferenceProjectType {
  const head = text;
  // 密度兜底先算（仲裁依据）：房建含大量通用词（楼/结构/主体），放最后避免抢占其他类型
  const signals: Array<[ReferenceProjectType, RegExp]> = [
    ['市政', /市政|管网|排水|给水|雨污|污水|燃气/gu],
    ['公路', /公路|路基|路面|沥青/gu],
    ['桥梁与隧道', /桥梁|隧道/gu],
    ['水利水电', /水利|河道|灌溉|防洪/gu],
    ['电力', /电力|供配电|电压|电缆/gu],
    ['机电安装', /机电|暖通|通风|空调|消防|给排水|智能化|电梯/gu],
    ['装饰装修', /装饰|装修|幕墙/gu],
    ['园林绿化', /园林|绿化|景观|苗木/gu],
    ['铁路', /铁路|轨道/gu],
    ['港口与航道', /港口|航道/gu],
    ['矿山冶金', /矿山|冶金/gu],
    ['房建', /房建|建筑|住宅|楼|结构|砌体|基坑|地下室|主体|层高|户型|公共建筑|产业园|厂房/gu],
  ];
  const scores = signals.map(([type, re]) => {
    re.lastIndex = 0;
    const count = (head.match(re) || []).length;
    return { type, count };
  }).sort((a, b) => b.count - a.count);
  const densityBest = scores[0];
  // 强判别词竞争制：部分类型文件大量使用其他类型的通用词（如产业园项目含"跨线桥"、
  // 卫生院项目含"沥青路面"），顺序短路会误判；改为各组计数、命中 ≥3 次且频次最高者胜出。
  // 房建专有词（产业园/厂房/卫生院等）放最前，防止被"桥梁/沥青"等通用词抢占
  const strongSignals: Array<[ReferenceProjectType, RegExp]> = [
    ['房建', /产业园|标准厂房|安置房|住宅小区|保障房|卫生院|门诊楼|办公楼/gu],
    ['市政', /老旧小区|海绵城市|雨污分流|管网改造|管廊/gu],
    ['桥梁与隧道', /桥梁|隧道|盾构|箱梁|斜拉|悬索|涵洞/gu],
    ['公路', /公路|路基|路面|沥青|桩号|互通|匝道/gu],
    ['水利水电', /堤防|水库|泵站|水闸|疏浚|节制闸|水电站|大坝|围堰/gu],
    ['电力', /变电站|输电线路|配电|GIS设备|电缆|架空线路|铁塔|箱变/gu],
    ['铁路', /铁路|轨道|道床|站台|信号机|接触网/gu],
    ['港口与航道', /港口|码头|航道|护岸|堆场|泊位/gu],
    ['矿山冶金', /矿山|矿井|选矿|冶炼|尾矿|轧钢/gu],
  ];
  let bestType: ReferenceProjectType | undefined;
  let bestCount = 0;
  let secondCount = 0;
  for (const [type, re] of strongSignals) {
    re.lastIndex = 0;
    const count = (head.match(re) || []).length;
    if (count >= 3 && count > bestCount) { secondCount = bestCount; bestType = type; bestCount = count; }
    else if (count > secondCount) secondCount = count;
  }
  if (bestType) {
    // 竞争接近（冠军不足亚军 2 倍）且密度兜底存在显著更强的类型信号时，以密度兜底为准，
    // 修正综合体项目（卫生院配套道路、园区基础设施）被通用词带偏的误判
    if (secondCount > 0 && bestCount < secondCount * 2 && densityBest && densityBest.count > bestCount) return densityBest.type;
    return bestType;
  }
  return densityBest && densityBest.count > 0 ? densityBest.type : '其他';
}

/** 构建参考文件质量画像 */
export function buildReferenceQualityProfile(text: string): ReferenceQualityProfile {
  const wordCount = text.replace(/\s/gu, '').length;
  const segments = textSegments(text);
  const effectiveWordCount = segments.reduce((sum, segment) => sum + segment.replace(/\s/gu, '').length, 0);
  const paramCount = (text.match(PARAM_HIT_RE) || []).length;
  const arrowChainSegmentCount = segments.filter(segment => ARROW_CHAIN_RE.test(segment)).length;
  const tableCount = countTables(text);
  const { headings, useCnAsChapter } = extractHeadingStructure(text);
  const sectionCount = headings.length;
  const { subsectionCount, subitemCount } = countSubsectionLevels(text, useCnAsChapter);
  // 重复率：语义骨架（去数字标点）完全一致的段落视为重复
  const skeletonCounts = new Map<string, number>();
  for (const segment of segments) {
    const skeleton = segmentSkeleton(segment);
    if (skeleton.length < 8) continue;
    skeletonCounts.set(skeleton, (skeletonCounts.get(skeleton) || 0) + 1);
  }
  let duplicatedSegmentCount = 0;
  for (const count of skeletonCounts.values()) if (count > 1) duplicatedSegmentCount += count;
  return {
    wordCount,
    effectiveWordCount,
    paramDensity: effectiveWordCount > 0 ? (paramCount * 1000) / effectiveWordCount : 0,
    paramCount,
    arrowChainCoverage: segments.length > 0 ? arrowChainSegmentCount / segments.length : 0,
    duplicationRate: segments.length > 0 ? duplicatedSegmentCount / segments.length : 0,
    tableCount,
    sectionCount,
    subsectionCount,
    subitemCount,
    avgSectionWords: sectionCount > 0 ? Math.round(effectiveWordCount / sectionCount) : 0,
    headingStructure: headings,
    tableTitles: extractTableTitles(text),
    paramTokens: extractParamTokens(text),
    segmentCount: segments.length,
    arrowChainSegmentCount,
    duplicatedSegmentCount,
  };
}
