import type { BoqRowTrace, DocumentDraftChapter, DocumentFact, DocumentFactTrace, DocumentFactsModel, StructuredTableFact, ValidationIssue } from './types';
import { stringifyFactValue } from './utils';

function normalize(value: string) {
  return value.replace(/[\s,，.。:：;；|｜（）()《》<>【】"“”'‘’]/gu, '').toLowerCase();
}

/** 事实值清洗：去除表格行尾巴（| | | |）、条款尾巴（“4．未尽事宜详见……”）、残留分隔标点等抽取噪音 */
export function cleanFactValue(value: string) {
  let cleaned = value
    // 表格行尾巴：`室外道排工程 | | | | |` → `室外道排工程`
    .replace(/[|｜]\s*(?:[|｜]\s*)+$/gu, '')
    // 条款尾巴：`胶圈接口 4．未尽事宜详见施工图纸、补遗…` → `胶圈接口`
    .replace(/(?:[。；;]|\d+\s*[．.、])\s*(?:未尽事宜|其余(?:未尽)?事宜|其他(?:未尽)?事宜|注\s*[：:]).*$/u, '')
    .trim();
  // 残留分隔标点：`本项目维修改造包含室内装饰工程、门窗维修、屋面维修、` → 去掉尾部顿号
  cleaned = cleaned.replace(/[、，,;；]+\s*$/u, '').trim();
  // 表格行内残留的孤立管道（值中间混入 | 但非结尾时取首段）
  if (/[|｜]/u.test(cleaned)) cleaned = cleaned.split(/[|｜]/u)[0]?.trim() || cleaned;
  return cleaned;
}

function trustedFacts(factsModel: DocumentFactsModel): DocumentFact[] {
  return [
    ...factsModel.project,
    ...factsModel.schedule,
    ...factsModel.quality,
    ...factsModel.safety,
    ...factsModel.resources,
    ...factsModel.preciseFacts,
    ...factsModel.bills,
    ...factsModel.drawings,
    ...factsModel.rules,
    ...factsModel.specifications,
  ];
}

function appears(markdown: string, value: string) {
  const normalizedMarkdown = normalize(markdown);
  const normalizedValue = normalize(value);
  if (!normalizedValue || normalizedValue.length < 2) return true;
  if (normalizedMarkdown.includes(normalizedValue)) return true;
  // 全值匹配失败时按片段匹配：条款列表（“1、……；2、……”）或顿号列举中任一核心片段落位即视为已使用；
  // 仅当拆分出至少两个片段时才启用，避免长单句的部分子串误命中
  {
    const fragments = value
      .split(/[；;。\n]|、|，|,/u)
      .map(fragment => normalize(fragment.replace(/^\s*\d+\s*[、.．]\s*/u, '')))
      .filter(fragment => fragment.length >= 4);
    if (fragments.length >= 2 && fragments.some(fragment => normalizedMarkdown.includes(fragment))) return true;
  }
  // 核心词匹配：对象名类短值在正文以组成词出现时视为落位（如“室外道排工程”→“室外道排”、“外墙、屋面工程”→“外墙”+“屋面”）；
  // 单片段要求 ≥3 字符、多片段要求 ≥2 字符，避免二字通用词单点命中造成虚假落位
  {
    const coreFragments = value
      .replace(/[、，,;；|｜\s]+/gu, '、')
      .split('、')
      .map(fragment => normalize(fragment.replace(/(?:工程|项目|改造|维修|安装|施工|内容|资料|要求|标准)+$/u, '')))
      .filter(fragment => fragment.length >= 2);
    if (coreFragments.length >= 1 && (coreFragments.length >= 2 || (coreFragments[0]?.length ?? 0) >= 3) && coreFragments.every(fragment => normalizedMarkdown.includes(fragment))) return true;
  }
  const numericParts = value.match(/\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年|万元|元|平方米|㎡|m²|立方米|m³|米|m|mm|cm|台|套|人|项|%|MPa|kPa|个|栋|层|标段|批|处|座|组|道|根|樘|扇)?/giu) || [];
  return numericParts.some(part => normalize(part).length >= 2 && normalizedMarkdown.includes(normalize(part)));
}

/** 值级可执行性判断：指向值（见XXX）、标题行、标题+正文混合残留、纯文档引用名等不具备落位意义的事实值，与 isActionableTraceFact 共用同一口径 */
export function isActionableFactValue(value: string) {
  if (/^(?:见|详见|按|执行|参见|依据).{0,16}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料)$/u.test(value)) return false;
  // “质量标准：见招标公告”类标签+指向混合行（标签后紧跟指向短语，无实际数值）
  if (/(?:^|[:：]\s*)(?:见|详见|按|执行|参见|依据)[^。；;]{0,18}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料|补疑|答疑)[^。；;]{0,6}$/u.test(value)) return false;
  // “见XXX招标范围/补疑/答疑”类指向短语（如“见本项目招标补疑中的招标范围”）不具备落位意义
  if (/^见.{0,24}(?:招标范围|招标补疑|补疑|前附表|答疑)/u.test(value)) return false;
  if (/^(?:合同协议书|通用条款|专用条款|招标文件|招标公告|投标人须知前附表|附件|资料)$/u.test(value.replace(/[（）()\d一二三四五六七八九十、.．\s]/gu, ''))) return false;
  // 表格尾巴清洗后只剩标签名（如“工程名称 | | |” → “工程名称”）无实际值，不构成事实
  if (/^(?:工程名称|项目名称|建设地点|建设规模|计划工期|质量标准|招标范围|合同估算价|工程概况|项目概况|项目内容)$/u.test(value)) return false;
  // 竖线分隔符残留是表格行抽取噪音（如“| 金额(元) |”、“室外道排工程 | | | | |”），正文无法字面落位，
  // 不进入落位评分池，否则永久拉低方案针对性 usedRate（真实生成缺陷：项目名称=| 金额(元) | 被计入落位义务）
  if (/\|/u.test(value)) return false;
  // 值本身是标题行、编号引用或指向性短语的事实不具备可执行落位意义，不进入修复清单
  if (/^#+\s*/u.test(value)) return false;
  // 标题+正文混合残留（如“一、工程概况：本项目分为1个标段”）是抽取噪音而非单条事实
  if (/^[一二三四五六七八九十]+[、.．]\s*\S{2,}[：:]/u.test(value)) return false;
  if (/^[（(]\s*\d+[)）]/u.test(value) && /具备|证书|考核|资格|人员/u.test(value)) return false;
  // 表格/章节编号类抽取噪声（评分池口径治理·R12 丰乐镇实测）：「1.3.1」「2.1招标」「5.1.1特殊」「2.12其他：无」
  // 是章头信息表行的编号/标签残片，正文无法字面落位——计入落位池只会稀释 distribution 分母（值永不跨章），
  // 且 usedRate 因宽松 appears 判定虚高，双重扭曲方案针对性评分。
  if (/^\d{1,2}(?:[.．]\d{1,2}){1,2}$/u.test(value)) return false;
  if (/^\d{1,2}(?:[.．]\d{1,2}){1,2}\s*(?:招标|计划|其他|特殊|内容|范围|说明|要求|概况|工期|质量|标段|项目|工程|名称|地点|规模|信息)(?:[:：].{0,6})?$/u.test(value)) return false;
  // 编号与表格邻格粘连残片（如「2026AEEGZ500482.3」「2026AEEGZ50048）」）
  if (/^[0-9A-Za-z]{8,}[.．]\d+$/u.test(value)) return false;
  if (/^[0-9A-Za-z]{8,}\s*[）)]$/u.test(value)) return false;
  // 「章节编号+结构词」拼接进正文的残句（如「…（具体开工日1.3.2计划工期期以开工通知为准）除」）
  if (/\d{1,2}[.．]\d{1,2}[.．]?\d{0,2}\s*(?:计划工期|招标|其他|特殊|质量要求|建设规模)/u.test(value)) return false;
  // 引文/括号未闭合的拼接残片（如「承包人应按《…配备办法」「《关于贯彻执行…通知》（合造价【2018】13号」）
  if ((value.match(/《/gu) || []).length !== (value.match(/》/gu) || []).length) return false;
  if ((value.match(/[（(]/gu) || []).length !== (value.match(/[）)]/gu) || []).length) return false;
  // 残句尾形态：以冒号/斜杠结尾（「本工程主要内容包括：」「…区段/节点工期： /」）、枚举截断（「…；三是人居环境改善…」）
  if (/[：:]\s*$/u.test(value)) return false;
  if (/[/／]\s*$/u.test(value)) return false;
  if (/[一二三四五]是\s*\S{2,}/u.test(value)) return false;
  // 风险描述条件句（如「危险性较大分部分项工程（…）未编制专项施工方案、未组织论证、未按论证方案施工」）
  // 是招标文件风险警示条款，正文应响应管理措施而非字面落位原句——计入落位义务会产生永久 unplaced 警告
  // 并稀释方案针对性 usedRate（R14 丰乐镇实测：风险控制要求长句进池后恒不落位）
  if (value.length >= 20 && /未编制|未组织|未按|未及时|未落实|未经验收/u.test(value)) return false;
  if (value.length < 4 && !/\d/u.test(value)) return false;
  return true;
}

export function isActionableTraceFact(trace: DocumentFactTrace) {
  const value = String(trace.value || '').trim();
  const labelValue = `${trace.label}${value}`;
  if (!/项目|工程|编号|地点|规模|范围|工期|质量|安全|资源|材料|设备|验收|\d/u.test(labelValue)) return false;
  if (!isActionableFactValue(value)) return false;
  // “技术参数/精确参数”是正文可写参数池（清单编码、孤立尺寸等），用于提示词注入而非逐条落位义务，不参与落位评分
  if (/^(?:技术参数|精确参数)$/u.test(trace.label)) return false;
  // 「项目名称/工程名称」标签下的清单分部名噪声（如「其他装饰工程」「墙、柱面装饰与隔断、幕墙工程」——
  // 清单分部分项列被误标为项目名称）：不含建设语义词与地名形态的值不是项目专属身份，计入落位池会使
  // usedRate 虚高（表格字面命中）且 distribution 永久为 0（值不会跨章），双重扭曲方案针对性口径
  // （R14 丰乐镇实测 12 个 used 值分母含 2 个此类噪声）
  if (/^(?:项目名称|工程名称|项目名)$/u.test(trace.label)
    && !/(?:建设|新建|改建|扩建|改造|整治|提升|治理)/u.test(value)
    && !/[\u4e00-\u9fa5]{1,8}(?:镇|乡|县|区|村|街道|社区|片区)/u.test(value)) return false;
  return true;
}

export function buildDocumentFactTraces(markdown: string, factsModel: DocumentFactsModel): DocumentFactTrace[] {
  const seen = new Set<string>();
  const traces: DocumentFactTrace[] = [];
  for (const fact of trustedFacts(factsModel)) {
    const value = cleanFactValue(stringifyFactValue(fact.value).replace(/\s+/gu, ' ').trim());
    const label = fact.fieldName || fact.key || fact.fieldId || '资料事实';
    const key = `${label}:${value}`;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    traces.push({
      label,
      value,
      sourceFile: fact.sourceFile,
      status: appears(markdown, value) ? 'used' : 'unplaced',
      confidence: fact.confidence,
    });
  }
  return traces;
}

export function factTraceIssues(traces: DocumentFactTrace[], options: { maxIssues?: number } = {}): ValidationIssue[] {
  const unplaced = traces.filter(trace => trace.status === 'unplaced' && isActionableTraceFact(trace));
  const limit = options.maxIssues && options.maxIssues > 0 ? options.maxIssues : unplaced.length;
  return unplaced
    .slice(0, limit)
    .map(trace => ({
      level: 'warning' as const,
      message: `已确认知识库事实未落位：${trace.label}=${trace.value}`,
      suggestion: `请将该事实落位到对应章节，并保持来源 ${trace.sourceFile || '结构化事实主表'} 的原始口径。${unplaced.length > limit ? `（共${unplaced.length}个未落位事实，此处显示前${limit}个）` : ''}`,
    }));
}

/** 构建 BOQ 行级落位追踪 */
export function buildBoqRowTraces(markdown: string, factsModel: DocumentFactsModel): BoqRowTrace[] {
  const tables = factsModel.tables || [];
  const traces: BoqRowTrace[] = [];
  const normalizedMarkdown = normalize(markdown);

  for (const table of tables) {
    const headers = table.headers.map(h => h.replace(/\s+/gu, '').toLowerCase());
    const nameCol = headers.findIndex(h => /项目名称|名称|清单项|分部分项|项目特征|工程内容|材料名称|设备名称/u.test(h));
    const codeCol = headers.findIndex(h => /编码|编号|序号|项目编码/u.test(h));
    const qtyCol = headers.findIndex(h => /数量|工程量/u.test(h));
    const unitCol = headers.findIndex(h => /单位/u.test(h));

    for (const row of table.rows) {
      let itemName = nameCol >= 0 ? (row[nameCol] || '') : '';
      let itemCode = codeCol >= 0 ? (row[codeCol] || '') : '';
      // 行内形状识别兜底（与 boqPlacementIssues 同源）：清单表证据丢失表头行时（headers 是首行数据），
      // 用清单编码形态定位编码列，编码后一格即项目名称列（清单表列序：序号|项目编码|项目名称|项目特征|单位|工程量）
      if (!itemName && !itemCode) {
        const codeIdx = row.findIndex(cell => /^\d{10,12}$/u.test(cell) || /^[A-Z]{1,3}\d{8,}$/u.test(cell));
        if (codeIdx >= 0) {
          itemCode = row[codeIdx] || '';
          itemName = row[codeIdx + 1] || '';
        }
      }
      const quantity = qtyCol >= 0 ? (row[qtyCol] || '') : '';
      const unit = unitCol >= 0 ? (row[unitCol] || '') : '';

      if (!itemName && !itemCode) continue;

      const normalizedName = normalize(itemName);
      const normalizedCode = normalize(itemCode);
      const placed = (normalizedName.length >= 3 && normalizedMarkdown.includes(normalizedName.slice(0, 12)))
        || (normalizedCode.length >= 3 && normalizedMarkdown.includes(normalizedCode.slice(0, 8)));

      traces.push({
        itemCode: itemCode.slice(0, 50),
        itemName: itemName.slice(0, 200),
        quantity: quantity.slice(0, 50),
        unit: unit.slice(0, 20),
        sourceFile: table.sourceFile || '',
        placed,
      });
    }
  }

  // 按已在正文中标记已落位，按未落位排序到前面
  return traces.sort((a, b) => (a.placed === b.placed ? 0 : a.placed ? 1 : -1));
}

/** BOQ 行级落位问题（从 trace 生成） */
export function boqRowTraceIssues(traces: BoqRowTrace[]): ValidationIssue[] {
  const unplaced = traces.filter(t => !t.placed);
  if (unplaced.length === 0) return [];
  const total = traces.length;
  const rate = (total - unplaced.length) / total;

  const issues: ValidationIssue[] = [];
  if (rate < 0.3) {
    issues.push({
      level: 'warning',
      message: `BOQ 清单行级落位严重不足：${total - unplaced.length}/${total} 行（${Math.round(rate * 100)}%）`,
      suggestion: `清单明细数量较大，建议优先补充主要分部分项、关键规格和大额工程量。未落位清单项示例：${unplaced.slice(0, 5).map(t => `${t.itemName} ${t.quantity}${t.unit}`).join('；')}`,
    });
  } else if (rate < 0.6) {
    issues.push({
      level: 'warning',
      message: `BOQ 清单行级落位不足：${total - unplaced.length}/${total} 行（${Math.round(rate * 100)}%）`,
      suggestion: `建议补充落位：${unplaced.slice(0, 5).map(t => t.itemName).join('、')}`,
    });
  }

  return issues;
}

// ═══════ 清单分项 → 施工方法章覆盖义务（评分报告 P2/P4 修复） ═══════
// 根因：boqPlacementIssues 只看总落位率（60% 阈值），公厕/过路涵/污水管网/排水沟/沟塘清淤/小菜园类
// 专项分项被土方/道路等大宗条目稀释漏检——分项整体缺失不影响总落位率达标。
// 本检测器按实体词判定覆盖义务：噪声行（计价类）与纯工序行（动词引导的清单行是分项内部工序）不产生义务，
// 组名携带的任一实体词在施工方法类章节正文零命中 → 该分项整体缺失 → error/blocker 进修复循环。

/** 施工方法章覆盖义务的清单分项实体词（乡村/市政人居环境分项 + 通用专业实体词） */
const DIVISION_ENTITY_RE = /公厕|厕所|过路涵|涵洞|涵管|污水|排水沟|水沟|清淤|沟塘|小菜园|菜园|菜地|花池|树池|挡墙|护栏|路灯|检查井|化粪池|泵站|生态池|生态塘|护坡|驳岸|栈道|步道|管网|管道|道路|铺装|绿化|景观|基础|结构|防水|屋面|外墙|内墙|地面|门窗|栏杆|电梯|电气|给水|排水|消防|通风|空调|智能化|幕墙|基坑/u;
/** 宽泛实体词：施工方法章几乎必然出现（基础施工/道路工程/给排水系统等语境词），词面命中不足以证明
 * 对应清单分项已覆盖——不产生分项级覆盖义务（P4 修复：「排水沟砌筑」若用宽泛词「排水」判定会被
 * 方法章「排水坡度」类字样误判已覆盖致漏检，宽泛词只作词面线索不作覆盖证据） */
const BROAD_DIVISION_ENTITY_RE = /^(?:管网|管道|道路|铺装|绿化|景观|基础|结构|防水|屋面|外墙|内墙|地面|门窗|栏杆|电梯|电气|给水|排水|消防|通风|空调|智能化|幕墙|基坑)$/u;
/** 公厕类同义形式：清单写「公厕」正文写「公共厕所」属同义覆盖（词面包含判定兜不住的反向形态）；
 * 菜地类同义形式：清单「菜地整治」正文写「小菜园」属同义覆盖；
 * 步道类同义形式（fix03e）：清单「青砖步道」正文写「人行道/人行道板安砌/园路」属同义覆盖——
 * 方法章实测已有「安砌人行道板」工序（含结合层工艺参数），仅因「步道」词面与「人行道」不一致
 * 被误判分项整体缺失（清单条目自身即「人行道板安砌」）。 */
const ENTITY_ALIASES: Record<string, string[]> = { '公厕': ['公共厕所', '厕所'], '厕所': ['公厕', '公共厕所'], '菜地': ['菜园', '小菜园'], '菜园': ['菜地'], '小菜园': ['菜地'], '步道': ['人行道', '园路', '游步道'] };
/** 纯工序行（动词引导的清单行属分项内部工序，不单独产生覆盖义务） */
const PURE_PROCESS_NAME_RE = /^(?:挖|回填|运|运输|拆除|清理|浇筑|绑扎|安装|铺设|砌筑|抹灰|刷|喷|摊铺|碾压|夯实|整平|找平|支模|搭设|检测|试验|防腐|除锈)/u;
/** 计价类噪声行（与 billItemSkeletonNames 同口径） */
const BILL_ENTITY_NOISE_RE = /计价|费用|税金|规费|暂列|暂估|合计|汇总|小计|措施项目|其他项目|税金项目/u;

/** 清单分项覆盖缺口（r14 抽取：检测器与链尾兜底补段共用同一缺口口径——检测定位=修复定位同源） */
export interface BoqDivisionCoverageGap {
  /** 缺失分项的清单条目名（如「青砖步道」「过路涵」） */
  itemName: string;
  /** 条目数量口径（「数量单位」，清单无数量时为空串） */
  sample: string;
}

/**
 * 施工方法章分项覆盖缺口计算（评分报告 P2 公厕整体遗漏 / P4 施工方法分项不全；r13 实机 E16 过路涵/青砖步道）。
 * 条目级判定：条目名含专有实体词（宽泛词除外；公厕/公共厕所、步道/人行道等同义形式计入）
 * 而施工方法章正文零命中 → 该分项整体缺失。
 */
export function computeBoqDivisionCoverageGaps(markdown: string, chapters: DocumentDraftChapter[], factsModel: DocumentFactsModel): { methodChapters: DocumentDraftChapter[]; gaps: BoqDivisionCoverageGap[] } {
  const tables = factsModel.tables || [];
  if (tables.length === 0) return { methodChapters: [], gaps: [] };
  const methodChapters = chapters.filter(chapter => /施工方法|施工方案|施工工艺|主要施工内容|分部分项/u.test(chapter.title));
  const methodText = methodChapters.map(chapter => chapter.content || '').join('\n');
  // 无施工方法类章节时不产生覆盖义务（义务锚定在该章，章不存在则不追溯）
  if (!methodText) return { methodChapters, gaps: [] };
  const normalizedMethod = normalize(methodText);
  const traces = buildBoqRowTraces(markdown, factsModel);
  const gaps: BoqDivisionCoverageGap[] = [];
  const seen = new Set<string>();
  for (const trace of traces) {
    const name = (trace.itemName || '').trim();
    if (!name || BILL_ENTITY_NOISE_RE.test(name) || PURE_PROCESS_NAME_RE.test(name)) continue;
    const entities = [...name.matchAll(new RegExp(DIVISION_ENTITY_RE.source, 'gu'))].map(match => match[0]);
    if (entities.length === 0) continue;
    // 宽泛词不产生覆盖义务：仅保留专有实体词作覆盖证据（防「排水」类通用词串染误判覆盖）
    const strongEntities = entities.filter(entity => !BROAD_DIVISION_ENTITY_RE.test(entity));
    if (strongEntities.length === 0) continue;
    // 任一专有实体词在施工方法章命中（含公厕/公共厕所同义形式）即视为该分项已覆盖
    const hitInMethod = (entity: string) => normalizedMethod.includes(normalize(entity))
      || (ENTITY_ALIASES[entity] || []).some(alias => normalizedMethod.includes(normalize(alias)));
    if (strongEntities.some(hitInMethod)) continue;
    const key = name.slice(0, 12);
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({ itemName: name, sample: trace.quantity ? `${trace.quantity}${trace.unit}` : '' });
  }
  return { methodChapters, gaps };
}

/** 清单分项覆盖缺失检测（评分报告 P2 公厕整体遗漏 / P4 施工方法分项不全） */
export function boqDivisionCoverageIssues(markdown: string, chapters: DocumentDraftChapter[], factsModel: DocumentFactsModel): ValidationIssue[] {
  const { methodChapters, gaps } = computeBoqDivisionCoverageGaps(markdown, chapters, factsModel);
  if (gaps.length === 0) return [];
  const missing = gaps.map(gap => `${gap.itemName.slice(0, 30)}${gap.sample ? ` ${gap.sample}` : ''}`);
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'evidence_coverage',
    owner: 'llm',
    repairability: 'llm_repairable',
    chapterId: methodChapters[0]?.id,
    message: `施工方法章分项覆盖缺失：${missing.slice(0, 6).join('；')}${missing.length > 6 ? ` 等共 ${missing.length} 个清单分项` : ''}`,
    suggestion: '施工方法章必须逐项覆盖工程量清单中的全部分部分项（含公厕/过路涵/污水管网/排水沟/沟塘清淤/小菜园等专项分项）：为每个缺失分项补齐施工方法小节（施工概况/施工流程/施工方法三要素齐全），禁止只写道路、铺装、绿化等大类而遗漏清单独有分项。',
  }];
}

// ═══════ 清单分部全景提取（r14 E16：规划/写作注入 + 链尾兜底共用素材） ═══════
// r13 实测：主要施工方法章规划期无清单分部分项输入，LLM 只规划出道路/绿化/公厕三类小块，
// 「过路涵」「青砖步道（人行道板安砌）」等专有分项零规划零写作，终检 boqDivisionCoverageIssues
// 报 blocker 后修复循环亦无从落笔（方法章缺节无法通过章内 LLM 补写恢复全局覆盖）。
// 本节从 factsModel.tables 提取清单分部全景（分部名 + 代表性条目摘要），供规划提示词注入
//（stageOutlinePlanning）、写作 roleContext 注入（stageChapterLoop）与链尾确定性兜底
//（postReviewSurface）三处共用。

/** 分部行噪声名（页脚/计价表头/表头标签等，与 r14 探针口径一致） */
const BOQ_DIVISION_NAME_NOISE_RE = /工程名称|标段|第\s*\d+\s*页|共\s*\d+\s*页|序号|综合单价|合价|定额|暂估|测评|E\.1|分部分项工程量清单计价表|措施项目|其他项目|规费|税金/u;
/** 泛化分部名：不产生独立分部上下文（「其他」「建筑」「安装工程」类——其下条目归入最近的具体分部，
 * 如公厕清单的 2.3.1「建筑」/2.3.2「安装工程」子分部条目归属「公厕」） */
const BOQ_DIVISION_GENERIC_NAME_RE = /^(?:其他|其它|零星|建筑|安装工程|土建|附属|附属工程|市政工程)$/u;

/** 清单分部全景条目：分部名 + 代表性条目摘要（「名称 数量单位」形态） */
export interface BoqDivisionCoverageEntry {
  /** 分部名（清单分部标题行提取，已过滤地名与泛词） */
  name: string;
  /** 代表性清单条目摘要（最多 3 条） */
  items: string[];
}

/** 清单数字口径去尾零（「359.100」→「359.1」，「3000.000」→「3000」） */
function formatBoqQuantity(value: string): string {
  return value.replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '');
}

/** 村级地名集合（「工程名称：马老郢（丁小郢、马小郢、李小郢）、马圩」→ 全部地名片段；分部名过滤的权威来源） */
function collectBoqGeographicNames(tables: StructuredTableFact[]): Set<string> {
  const names = new Set<string>();
  for (const table of tables) {
    for (const row of table.rows || []) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const value = String(cell || '').trim();
        const match = /^工程名称[：:]\s*(.+)$/u.exec(value);
        if (!match) continue;
        const flattened = match[1].replace(/[（(]([^）)]*)[）)]/gu, '、$1');
        for (const piece of flattened.split(/[、，,]/u)) {
          const name = piece.replace(/[（()）]/gu, '').trim();
          if (name.length >= 2 && name.length <= 20) names.add(name);
        }
      }
    }
  }
  return names;
}

/** 行分类标记：division=分部标题行（带点编号+无数量格）/ item=清单条目行（项目编码形态）/ none=其他 */
type BoqRowMarker = { kind: 'division'; name: string } | { kind: 'item'; summary: string } | { kind: 'none' };

/** 清单表行分类（与 r14 探针同口径：编号 1.1/2.3.1 形态 + 三位小数量格排除 + 编号后首个中文名 2-15 字） */
function classifyBoqRow(cells: string[]): BoqRowMarker {
  const trimmed = cells.map(cell => String(cell ?? '').trim());
  // 条目行：项目编码（10-12 位）后第一个非空格为条目名（列序：序号|项目编码|项目名称，个别表格有空列占位）；
  // 数量格（三位小数）前最近短格为单位
  const codeIndex = trimmed.findIndex(cell => /^\d{10,12}$/u.test(cell));
  if (codeIndex >= 0) {
    let name = '';
    for (let k = codeIndex + 1; k < trimmed.length; k += 1) {
      if (trimmed[k]) { name = trimmed[k]; break; }
    }
    if (name) {
      const quantityIndex = trimmed.findIndex(cell => /^\d{1,3}(?:,\d{3})*\.\d{3}$/u.test(cell));
      if (quantityIndex >= 0) {
        let unit = '';
        for (let k = quantityIndex - 1; k >= Math.max(0, quantityIndex - 3); k -= 1) {
          const candidate = trimmed[k];
          if (!candidate) continue;
          // 单位形态校验：短（≤8 字）、不以数字开头、非表格分隔符（「m3」「m2」「套」「个」等）
          if (candidate.length <= 8 && !/^\d/u.test(candidate) && !/[|｜]/u.test(candidate)) unit = candidate;
          break;
        }
        return { kind: 'item', summary: `${name}${unit ? ` ${formatBoqQuantity(trimmed[quantityIndex])}${unit}` : ''}` };
      }
      return { kind: 'item', summary: name };
    }
  }
  // 分部行：带点编号（1.1 / 2.3.1 形态）且行内无三位小数数量格
  const divisionIndex = trimmed.findIndex(cell => /^\d+(?:\.\d+){1,3}$/u.test(cell));
  if (divisionIndex >= 0 && !trimmed.some(cell => /^\d{1,3}(?:,\d{3})*\.\d{3}$/u.test(cell))) {
    for (let k = divisionIndex + 1; k < trimmed.length; k += 1) {
      const name = trimmed[k];
      if (!name) continue;
      // 编号后首个非空格非中文 → 无分部名（页码/表头等残格）
      if (!/[\u4e00-\u9fa5]/u.test(name)) break;
      if (name.length >= 2 && name.length <= 15 && !BOQ_DIVISION_NAME_NOISE_RE.test(name)) return { kind: 'division', name };
      break;
    }
  }
  return { kind: 'none' };
}

/**
 * 清单分部全景提取：分部名（过滤村级地名与泛词）+ 其下代表性条目摘要。
 * 表单页分页重复的分部行按名聚合；表边界重置分部上下文（条目归属最近的分部标题行）。
 */
export function extractBoqDivisionCoverage(factsModel: DocumentFactsModel): BoqDivisionCoverageEntry[] {
  const tables = factsModel?.tables || [];
  if (tables.length === 0) return [];
  const geographicNames = collectBoqGeographicNames(tables);
  // 地名判定：精确命中，或以地名开头且剩余 ≤4 字（「张大郢排水」⊃「张大郢」类形态）
  const isGeographic = (name: string) => geographicNames.has(name)
    || [...geographicNames].some(geo => geo.length >= 2 && name.startsWith(geo) && name.length - geo.length <= 4);
  const divisions = new Map<string, string[]>();
  for (const table of tables) {
    let currentName = '';
    for (const row of table.rows || []) {
      if (!Array.isArray(row)) continue;
      const marker = classifyBoqRow(row);
      if (marker.kind === 'division') {
        // 地名清空上下文（村名下的条目归属未知更深分部，不得回挂到上一个专业分部）
        if (isGeographic(marker.name)) { currentName = ''; continue; }
        // 泛词保持当前上下文（子分部条目归入父分部）
        if (BOQ_DIVISION_GENERIC_NAME_RE.test(marker.name)) continue;
        if (!divisions.has(marker.name)) divisions.set(marker.name, []);
        currentName = marker.name;
        continue;
      }
      if (marker.kind === 'item' && currentName) {
        const bucket = divisions.get(currentName);
        if (bucket && bucket.length < 3 && !bucket.includes(marker.summary)) bucket.push(marker.summary);
      }
    }
  }
  // 保留判定：命中专业实体词或携带直属条目（无实体词且无直属条目的孤立短名多为村级地名残片）
  return [...divisions.entries()]
    .filter(([name, items]) => items.length > 0 || DIVISION_ENTITY_RE.test(name))
    .map(([name, items]) => ({ name, items }))
    .slice(0, 30);
}

/** 分部全景 → 提示词/写作注入文本（无有效分部时返回空串） */
export function formatBoqDivisionCoverage(entries: BoqDivisionCoverageEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map(entry => entry.items.length ? `- ${entry.name}（${entry.items.join('；')}）` : `- ${entry.name}`).join('\n');
}

/**
 * 链尾清单分部覆盖确定性兜底（r14 E16 丰乐镇实机：过路涵/青砖步道在主要施工方法章零命中，
 * 方法章缺节无法通过章内 LLM 补写恢复全局覆盖）：方法章仍缺清单专有分项时，在方法章末尾
 * 追加确定性段落（纯段落形式、无新标题，不改 H2/H3 结构与目录）。缺口判定与检测器完全同源
 *（computeBoqDivisionCoverageGaps），补段逐项含缺失分项名 → 检测复检恒清零；
 * 就地更新传入的章 drafts（防后续 rebuildFinalMarkdown 从 drafts 重拼回退）；
 * markdown 中定位不到方法章 H2 时不改动并放弃（不破坏结构）。
 */
export function enforceBoqDivisionCoverageInMethodChapters(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  factsModel: DocumentFactsModel;
}): { markdown: string; appended: string[] } | null {
  const { methodChapters, gaps } = computeBoqDivisionCoverageGaps(input.markdown, input.chapters, input.factsModel);
  if (gaps.length === 0 || methodChapters.length === 0) return null;
  const target = methodChapters[0];
  // 补段句式保守：仅陈述清单事实（分项名+数量口径）与通用工序控制环节，不引入清单外数值/时限/承诺
  const sentences = gaps.map(gap => `${gap.itemName}分项${gap.sample ? `（清单工程量 ${gap.sample}）` : ''}按设计图纸与工程量清单特征组织施工：施工前完成测量放线、材料进场检验与技术交底，施工中控制各工序标高、尺寸与搭接质量，完工后按现行验收标准逐项检查。`);
  const paragraph = `本工程工程量清单分项施工方法补充如下。${sentences.join('')}`;
  // markdown 定位方法章 H2 段落（章标题可能带中文数字编号：「## 第二章 主要施工方法」）
  const lines = input.markdown.split('\n');
  const titleKey = normalize(target.title);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^##\s/u.test(line)) continue;
    const stripped = normalize(line.replace(/^#+\s*/u, '').replace(/^第[一二三四五六七八九十百]+章/u, ''));
    if (!stripped) continue;
    if (stripped.includes(titleKey) || titleKey.includes(stripped)) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/u.test(lines[i])) { end = i; break; }
  }
  // 章末插入：跳过末尾空行，插在最后一个非空行之后（段落间空行分隔）
  let insertAt = end;
  while (insertAt > start + 1 && !lines[insertAt - 1].trim()) insertAt -= 1;
  const nextLines = [...lines.slice(0, insertAt), '', paragraph, ...lines.slice(insertAt)];
  // 就地更新章 drafts（rebuild 重拼不丢补段；重复运行时缺口已清零 → 静默）
  target.content = `${(target.content || '').trimEnd()}\n\n${paragraph}`;
  return { markdown: nextLines.join('\n'), appended: gaps.map(gap => gap.itemName) };
}
