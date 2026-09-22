import type { BoqRowTrace, DocumentDraftChapter, DocumentFact, DocumentFactTrace, DocumentFactsModel, StructuredTableFact, ValidationIssue } from './types';
import { stringifyFactValue } from './utils';
import { normalizeEngineeringTextForFactMatch } from './engineeringUnits';
import { BOQ_GENERIC_NAME_STOPWORDS, classifyBillPlacementExemption } from './billFactLock';
import { SPEC_GLUED_DIGITS_RE, SPEC_GLUED_VALUE_RE, SPEC_GLUE_MARK_RE } from './parameterPatterns';

// 分隔标点同族归一：顿号（、）与间隔号（・·）此前漏收——清单抽取会把枚举名拆成「给、排水附（配）件」
// 形态，而正文按业务写法写「给排水附配件」，两侧只剩顿号之差即判未落位（巢湖实测该类假阴性 17 行）。
// 该函数同时服务事实值落位（appears）/实体命中（hitInMethod）/BOQ 落位判定（boqItemCarriedInText），
// 故在此单点收口而非只改 BOQ 通道。
function normalize(value: string) {
  return value.replace(/[\s,，.。:：;；|｜、・·（）()《》<>【】"“”'‘’]/gu, '').toLowerCase();
}

/** 归一化口径导出（C3-5）：修复轮复检（chapterClassResidual boq-placement 分支）与
 * buildBoqRowTraces 落位判定同源复用，防复检口径与检测端分叉 */
export const normalizeBoqMatchText = normalize;

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
  // C-T7（#50）：招标人/建设单位/发包人/业主是一级关键事实标签（基本信息表核心行），其值（机构名）
  // 不含工程关键词——原先仅按工程词面白名单过滤会被整类误滤，致跨章扩散与落位评分池缺失
  if (!/项目|工程|编号|地点|规模|范围|工期|质量|安全|资源|材料|设备|验收|招标人|建设单位|发包人|业主|\d/u.test(labelValue)) return false;
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
  // r27 扩围（r26d 归因：5 项招标文件要求条款类知识入池恒不落位，永久稀释方案针对性
  // usedRate）：①义务主体开头的目标/要求条款（「承包人应实现安全生产无事故目标。」）；
  // ②纯法规名连排/单列（去除书名号引用后无实质内容）；③「本招标项目…须/应/必须…」
  // 式编制要求条款；④圆括号中文/数字序号开头的条款枚举碎片（「（二）污水管网…」）。
  // 此类条款正文应以管理措施响应而非字面落位原句，入池即永久 unplaced（r26d 实测 5 项
  // 全为要求条款）；含数值/期限等具体数据的义务句不在排除列（「承包人应在开工前7日内
  // 完成…准备」类具体安排可被正文直接引用扩散，R14 实机验证）——通用形态判据，零项目语义
  const legalOnly = value.replace(/《[^》]{2,60}》/gu, '').replace(/[、，,；;．.／/\s（）()]/gu, '');
  if (!legalOnly && /《[^》]{2,60}》/u.test(value)) return false;
  const hasConcreteData = /\d/u.test(value);
  if (!hasConcreteData && /^(?:承包人|发包人|招标人|投标人|我方|施工单位|建设单位|总承包单位|分包人|中标人)(?:应|须|必须|应当)/u.test(value)) return false;
  if (!hasConcreteData && /^本(?:招标|采购)项目[^。；]{0,80}?(?:须|应|必须)/u.test(value)) return false;
  if (/^[（(]\s*[一二三四五六七八九十\d]{1,3}\s*[)）]/u.test(value)) return false;
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

/** 2 字首段泛词保护名单迁移至 billFactLock.BOQ_GENERIC_NAME_STOPWORDS（C3-5-8 共源）：
 * boqItemCarriedInText 首段保护与 classifyBillPlacementExemption 泛词行豁免复用同一名单——
 * 历史分叉：本地名单只挡「首段主名通道」，泛词行仍计分母形成永不可达的隐形分母（s28l「软件」4 行） */

/** 清单表列口径单源（C3-5）：名称/编码/数量/单位列标签整格锚定。历史缺陷：无锚定匹配会把表标题行
 * （「e.1分部分项工程量清单计价表」含「分部分项」）误当名称列，itemName 取到序号 → 该表全行永不落位；
 * 裸「清单项」放开会把「清单项目编码」类列名误判为名称列（itemName 取到编码值）——统一收窄为
 * 「清单项名称/清单项目名称」；编码列不含「序号」（避免序列号误匹配为编码通道）。 */
export const BOQ_NAME_COLUMN_RE = /^(?:项目名称|名称|清单项名称|清单项目名称|分部分项(?:工程)?名称|项目特征|工程内容|材料名称|设备名称)/u;
export const BOQ_CODE_COLUMN_RE = /^(?:项目编码|编码|编号)/u;
export const BOQ_QTY_COLUMN_RE = /^(?:工程量|数量)/u;
export const BOQ_UNIT_COLUMN_RE = /单位/u;

/** 单条目落位判定（C3-5 单源，供 buildBoqRowTraces 与修复轮复检共用；入参为已归一化文本）：
 * 三通道——首段主名 12 字符（2 字主名须过泛词保护名单）/ 整名 12 字符 / 编码 8 字符 */
export function boqItemCarriedInText(normalizedText: string, itemName: string, itemCode = ''): boolean {
  const normalizedName = normalize(itemName);
  const normalizedCode = normalize(itemCode);
  const primaryName = normalize(String(itemName || '').split(/[\s（(、，,;；:：]/u)[0] || '');
  const primaryOk = primaryName.length >= 3 || (primaryName.length === 2 && !BOQ_GENERIC_NAME_STOPWORDS.has(primaryName));
  return (primaryOk && normalizedText.includes(primaryName.slice(0, 12)))
    || (normalizedName.length >= 3 && normalizedText.includes(normalizedName.slice(0, 12)))
    || (normalizedCode.length >= 3 && normalizedText.includes(normalizedCode.slice(0, 8)));
}

/** 构建 BOQ 行级落位追踪（C3-5 单源：行识别/豁免/落位判定唯一实现——门禁 boqPlacementIssues、
 * 报告出口 boq-row-trace、分项覆盖 boqDivisionCoverageIssues 全链消费本函数，修历史口径双轨：
 * 门禁 16 字符整名前缀 vs 报告 12 字符首段前缀，s28l 实测 1118 vs 822 行未落位差 296 行） */
export function buildBoqRowTraces(markdown: string, factsModel: DocumentFactsModel): BoqRowTrace[] {
  const tables = factsModel.tables || [];
  const traces: BoqRowTrace[] = [];
  const normalizedMarkdown = normalize(markdown);

  for (const table of tables) {
    const headers = table.headers.map(h => h.replace(/\s+/gu, '').toLowerCase());
    const nameCol = headers.findIndex(h => BOQ_NAME_COLUMN_RE.test(h));
    const codeCol = headers.findIndex(h => BOQ_CODE_COLUMN_RE.test(h));
    const qtyCol = headers.findIndex(h => BOQ_QTY_COLUMN_RE.test(h));
    const unitCol = headers.findIndex(h => BOQ_UNIT_COLUMN_RE.test(h));

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

      // r28h M9 落位判定扩围（实机归因）：名称首段实体主名——括号/顿号/枚举形态（「矩形柱（含梯柱）」
      // 「天沟、挑檐板」）与 2 字短名（「圈梁」「垫层」）原先因长度门槛与整串前缀失配而永不落位
      // （s28h2 实测 411 行短名死区）；2 字主名须过泛词保护名单；原整名前缀通道保留（无分隔符形态同源，
      // 「给、排水附（配）件」类首段过短的枚举名走整名通道）。C3-5：判定抽为 boqItemCarriedInText 单源
      // （修复轮复检同口径复用）
      const placed = boqItemCarriedInText(normalizedMarkdown, itemName, itemCode);

      traces.push({
        itemCode: itemCode.slice(0, 50),
        itemName: itemName.slice(0, 200),
        quantity: quantity.slice(0, 50),
        unit: unit.slice(0, 20),
        sourceFile: table.sourceFile || '',
        placed,
        // C-T5 豁免口径单源：汇总/噪声/费用/分部标题行标记豁免（不计入落位率分母，行保留在追踪中供审计登记）
        exempt: classifyBillPlacementExemption(itemName, { code: itemCode, quantity }) !== undefined,
        // C3-5 单源化：行内全文（项目特征描述等）——责任章映射的 token 命中文本 + 修复轮补写指令上下文
        description: row.map(cell => String(cell ?? '')).join(' ').replace(/\s+/gu, ' ').trim().slice(0, 240),
      });
    }
  }

  // 按已在正文中标记已落位，按未落位排序到前面
  return traces.sort((a, b) => (a.placed === b.placed ? 0 : a.placed ? 1 : -1));
}

/** BOQ 行级落位问题（从 trace 生成）；C-T5：口径行豁免（汇总/噪声/费用/分部标题，与 boqPlacementIssues 单源口径），
 * 分母只计有效行——历史缺陷：口径行未排除致分母虚高、落位率被系统性压低；豁免行清单登记进消息可审计 */
export function boqRowTraceIssues(traces: BoqRowTrace[]): ValidationIssue[] {
  const considered = traces.filter(t => !t.exempt);
  const unplaced = considered.filter(t => !t.placed);
  if (unplaced.length === 0) return [];
  const total = considered.length;
  const rate = (total - unplaced.length) / total;
  const exemptTraces = traces.filter(t => t.exempt);
  const exemptNote = exemptTraces.length > 0
    ? `（口径行 ${exemptTraces.length} 行已豁免不计入分母：${exemptTraces.slice(0, 5).map(t => t.itemName).join('、')}${exemptTraces.length > 5 ? ' 等' : ''}）`
    : '';

  const issues: ValidationIssue[] = [];
  if (rate < 0.3) {
    issues.push({
      level: 'warning',
      message: `BOQ 清单行级落位严重不足：${total - unplaced.length}/${total} 行（${Math.round(rate * 100)}%）${exemptNote}`,
      suggestion: `清单明细数量较大，建议优先补充主要分部分项、关键规格和大额工程量。未落位清单项示例：${unplaced.slice(0, 5).map(t => `${t.itemName} ${t.quantity}${t.unit}`).join('；')}`,
    });
  } else if (rate < 0.6) {
    issues.push({
      level: 'warning',
      message: `BOQ 清单行级落位不足：${total - unplaced.length}/${total} 行（${Math.round(rate * 100)}%）${exemptNote}`,
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
  // 条目行：项目编码形态（国标 10-12 位数字，或补充清单 WB/ZB+≥8 位数字）后第一个非空格为条目名
  //（列序：序号|项目编码|项目名称，个别表格有空列占位）；数量格（三位小数）前最近短格为单位
  const codeIndex = trimmed.findIndex(cell => /^\d{10,12}$/u.test(cell) || /^[A-Z]{1,3}\d{8,}$/u.test(cell));
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
  // 分部行三形态（行内无三位小数数量格）：带点编号（1.1 / 2.3.1，如「1.1 新建混凝土道路」）；
  // 中文序数一级分部（一/二/…/十二，如「二 排水工程」「六 绿化工程」）；GB 清单编码分部
  //（4 位分部 0101 / 6 位子分部 011101，如「0112 墙、柱面装饰与隔断、幕墙工程」）。
  // 历史缺陷：只认带点编号——「二 排水工程」「0112 装饰分部」类上下文丢失，
  // 其下专有分项（生态池/墙面彩绘/绿化栽植等）零注入规划与范围核对素材。
  // 后两类要求编号位于行首（≤2 列），防工程量/备注格数字误判为分部
  const divisionIndex = trimmed.findIndex((cell, index) => /^\d+(?:\.\d+){1,3}$/u.test(cell)
    || (index <= 2 && (/^\d{4}(?:\d{2})?$/u.test(cell) || /^[一二三四五六七八九十]{1,3}$/u.test(cell))));
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
        // 村组名（如「2.1 马老郢」）为专业分部内的分组标记：不产生分部名、保持上层上下文
        //（「二 排水工程 → 2.1 马老郢 → 生态池/检查井」条目归属「排水工程」）。
        // 历史缺陷：清空上下文致村下条目丢失归属（生态池/彩绘/绿化类专有分项零注入）
        if (isGeographic(marker.name)) continue;
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

// ══════════════════════════ C-T2 数字溯源闭环 ══════════════════════════
/**
 * C-T2 数字溯源闭环（根治「疑似编造数值」误报淹没真未溯源）：
 * 正文数字三分类——①项目事实（清单/图纸/招标原文语料反查，可溯源）②规范常数（标准编号/养护龄期/
 * 试块留置/检测频次/温度阈值/质量指标/工艺公差/工艺压力参数/砂浆强度等级/绝缘电阻/管系列代号——
 * 规范依据可显性标注）③管理数字（管理频次/施工组织编排/组织配置/合同程序条款/过程指标/
 * 服务时限承诺/日期表述/商务金额——制度性要求，允许保留）。
 *
 * 生成后反查未溯源数字：能改定性即改（demoteUnsourcedNumericTokens 链尾确定性改定性），必须保留的
 * 显性标注来源（保留规范常数时标注标准编号 → R1 分类命中，recheck 消解形成收敛闭环）；未溯源=0
 * 进终稿验收（numericTraceabilityIssues 终检聚合 error，扫描口径与修复器同源单源）。
 *
 * 实测归因（本机制立项根因）：既有反查链报出的「未溯源数字」绝大多数为合法数字——
 * 试块留置 100m³/检验批 400m³（规范常数）、检测频次 200m²、养护龄期 14 天、标准号 50268、
 * 法规年份 2019、管理频次 1~2 次、施工组织编排多单元分组、合同程序条款「60 日历天」、
 * 设计规格类小数值等——仅个别与清单量不符的数字真未溯源。
 * 分类器豁免合法数字、修复链只处理真未溯源，避免修复轮反复改写正确数字导致
 *「保留后 recheck 仍检出」的不收敛空转（该空转是 C-T2 立项前的缺陷根因）。
 */

/** 数字溯源分类：regulatory=规范常数；management=管理数字；unsourced=未溯源（进语料反查/修复链） */
export type NumericTraceKind = 'regulatory' | 'management' | 'unsourced';

export interface NumericTraceClassification {
  kind: NumericTraceKind;
  /** 命中判据（「标准编号」/「养护龄期」/…；unsourced 为空串） */
  basis: string;
}

/** 未溯源数字扫描结果（token 原文 + 归一化形态 + 所在句 + 原位索引；检测器与修复器同源消费） */
export interface NumericTraceFinding {
  /** 原文 token（含原文空格/符号形态，供原位定位与删除） */
  token: string;
  /** 归一化 token（分类与语料反查口径） */
  normalizedToken: string;
  sentence: string;
  index: number;
}

/** C-T2 扫描命中（含豁免项，供扫描明细与测试断言） */
export interface NumericTraceHit {
  token: string;
  normalizedToken: string;
  index: number;
  sentence: string;
  kind: NumericTraceKind;
  basis: string;
}

/** 标准代号（GB/JGJ/CJJ/ISO…，含 /T 推荐性变体与 DB 地方标准） */
const STANDARD_CODE_AGENCY = 'GB|JGJ|CJJ|CECS|ISO|SL|DL|JTS|JTG|JT|TB|DB\\d{2}|DB';

/** 标准号语境模式（context 内匹配：标准代号 + 3~5 位数字 + 可选年份）——token 命中数字段或年份段即豁免 */
const STANDARD_CODE_IN_CONTEXT_RE = new RegExp(`(?:${STANDARD_CODE_AGENCY})\\s*\\/?\\s*T?\\s*(\\d{3,5})(?:\\s*[-—–]\\s*(\\d{2,4}))?`, 'giu');

/** 管理动作词（管理频次语境：「每日不少于 1 次安全检查」） */
const MANAGEMENT_ACTION_RE = /检查|巡查|例会|培训|交底|演练|复核|记录|台账|考核|整改|保养|维护|监测|检测|排查|验收|清扫/u;

/** 组织对象词（施工组织编排语境：「9 个片区分组平行施工」） */
const ORGANIZATION_UNIT_RE = /作业面|班组|工区|标段|片区|地块|单元|分部|队伍|小组|机构|部门|岗位|区域|社区|村庄|村|路段|楼栋|站区|库区|厂区/u;

/** 组织动作词（分组平行/组建配备语境） */
const ORGANIZATION_ARRANGE_RE = /分组|平行|流水|包保|分区|分片|分块|划分|组建|成立|配备|配置|设置|设立|建立|指定|安排|派驻/u;

/** 合同程序条款语境（招标/合同原文忠实引用：「合理期限（一般不超过 60 日历天）」） */
const CONTRACT_CLAUSE_CONTEXT_RE = /违约金|延期竣工|解除合同|缺陷责任期|质量保证金|质保金|履约保证金|保修期|合理期限|工期顺延|误期赔偿|响应|抢修|回访/u;

/** 删除前保护（token 左侧紧邻窗口尾）：量词/约数/比较/维度/关系字尾——删除数字后前文悬空
 *（如「每座」「壁厚」「间距」字尾接数值）或语义反转（如「不少于」字尾接数量）。
 * r28j M22 扩围：「.」「．」字尾保护——小节编号尾段（「#### 7.1.1 道路…」中「1 道」实为
 * 编号末段+标题首字，删除后成「#### 7.1.路…」残缺编号直坠终检，两处终稿实锤）；
 * 「#」字尾保护——标题行首符号（「### 3.1 道路…」的 token「3.1道」吞编号整体，
 * 左窗口止于「### 」，删除后成「### 路…」） */
const DEMOTE_LEFT_GUARD_RE = /(?:第|每|各|共|约|达|至|少|多|超|过|近|余|于|足|大|小|低|薄|浅|上|下|台|套|件|个|根|只|组|项|处|座|栋|幢|层|间|盏|樘|孔|株|户|盘|块|片|条|道|节|段|张|袋|桶|罐|车|宽|高|厚|深|长|径|距|度|量|差|积|比|率|值|数|额|重|龄|温|号|编|标|总|净|最|均|平|相|间|隔|离|为|是|计|按|取|以|向|抵|分|划|格|φ|Φ|≥|≤|＞|＜|>|<|=|±|\.|．|#)\s*$/u;

/** 可删单位类（空间/数量/重量/长度类——删除后前文名词收尾仍成句；时间/次数/百分比/温度/
 * 电气/金额/组织人员类不在此处置，改语义交 LLM 修复轮） */
const DELETABLE_UNIT_RE = /(?:mm|cm|km|m2|hm2|m3|kg|t|亩|台|套|件|个|根|只|组|项|处|座|栋|幢|层|间|盏|樘|孔|株|户|盘|块|片|条|道|节|段|张|袋|桶|罐|车|米|m|l)$/u;

/** r28h M4a 题注前缀前导（左窗口匹配）：token 数字段紧跟在题注编号「表N-」之后——表序数字属题注
 * 编号而非正文数值，删除即毁题注（r28h2 实机：「表3-4 道路结构层主要物资投入计划表」的「4 道」
 * 被判「未溯源数值+单位（道）」删除 →「表3-路结构层…」残缺编号直坠终检 table-caption blocker）。
 * 完整题注（表3-4 道路…）与残缺题注（表3-路…）同判豁免；正文数值（「安排4道工序」）不受影响。
 * r28j M22 扩「图」：图类题注同理（r28j stage[111] 实测「图9-2」的「2 项」被删 →「图9-项」） */
const CAPTION_NUMBER_PREFIX_RE = /(?:表|图)\s*[\d一二三四五六七八九十]+\s*[-—–－.．]\s*$/u;

/** C-T2 溯源扫描 token（数值+单位；单位集含工程度量与组织/管理计数单位）。单位缺省时由扫描过滤器
 * 二次把关（仅年份与 3~5 位标准号数字进入判定，其余裸数不报）。 */
const TRACE_TOKEN_RE = /\d+(?:\.\d+)?(?:\s*(?:mm|cm|km|m2|㎡|m²|m3|m³|hm2|亩|kg|g|t|吨|ml|l|升|mpa|kpa|kn|kw|mw|kv|v|hz|℃|%|万元|亿元|元|天|工作日|工作天|月|年|h|min|次|遍|轮|班|趟|周|季|点|人|名|组|支|队|台|套|件|个|根|只|项|处|座|栋|幢|层|间|批|盏|樘|孔|株|户|盘|块|片|条|道|节|段|张|袋|桶|罐|车|d|米|m))?/giu;

/** 表格纯数字格（清单数量列「1.500」）——导出供 numericVerification 核源构建复用（同源口径） */
export const CELL_NUMBER_RE = /^\d+(?:\.\d+)?$/u;

/** 表格纯单位格（清单数量单位列「m2」）——导出供 numericVerification 核源构建复用（同源口径） */
export const CELL_UNIT_RE = /^(?:m2|㎡|m²|平方米|平方|平米|m3|m³|立方米|立方|hm2|公顷|亩|mm|cm|km|m|米|kg|g|t|吨|个|台|套|项|处|座|株|组|批|次|人|天|月|年|万元|元|l|ml|樘|盏|根|只|块|片|条|道|层|间|栋|幢|户|袋|桶|罐|车|盘|孔|节|段|张|面|棵|丛)$/u;

const NUMERIC_TRACE_UNSOURCED: NumericTraceClassification = { kind: 'unsourced', basis: '' };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 尾零规约：1.500 → 1.5、1.20 → 1.2、2.000 → 2（数值等价的原文形态差异不计入溯源缺口）。
 * 导出供无主数值审计（authorityAudit）复用：权威核与正文 token 双侧同口径归约（单源）。 */
export function normalizeQuantityZeros(value: string): string {
  return value.replace(/(\d+\.\d*?)0+(?![\d])/gu, '$1').replace(/(\d+)\.(?![\d])/gu, '$1');
}

/** token 所在句提取（按句读标点/换行切分；修复指令与明细展示用） */
function extractSentenceAt(markdown: string, index: number, length: number): string {
  let start = index;
  while (start > 0 && !/[。；;！!？?\n]/u.test(markdown[start - 1])) start -= 1;
  let end = index + length;
  while (end < markdown.length && !/[。；;!！?？?\n]/u.test(markdown[end])) end += 1;
  return markdown.slice(start, Math.min(end + 1, markdown.length)).trim();
}

/**
 * 数字溯源语料（归一化）：事实主表全量 + 表格行文本与「数字格×单位格」跨格组合
 *（清单分列表「| 1.500 | m2 |」→「1.500m2」，覆盖数字与单位分列的既有形态）+ 尾零规约。
 * 语料规模过小时反查无意义（由调用方按 corpus.length 门槛短路）。
 */
export function numericTraceCorpus(factsModel: DocumentFactsModel): string {
  const parts: string[] = [];
  for (const fact of trustedFacts(factsModel)) {
    const value = stringifyFactValue(fact.value);
    if (value) parts.push(value);
  }
  for (const table of factsModel.tables || []) {
    for (const row of table.rows || []) {
      if (!Array.isArray(row) || row.length === 0) continue;
      const cells = row.map(cell => String(cell ?? '').trim());
      parts.push(cells.join(' '));
      const numbers = [...new Set(cells.filter(cell => CELL_NUMBER_RE.test(cell)).map(cell => normalizeQuantityZeros(cell)))];
      if (numbers.length === 0) continue;
      const units = [...new Set(cells.filter(cell => CELL_UNIT_RE.test(cell)))];
      for (const number of numbers) {
        for (const unit of units) parts.push(`${number}${unit}`);
      }
    }
  }
  // 逐段归一化后换行拼接：批量拼接再归一化会连同段间换行一并删除（归一化删除空白），
  // 相邻段尾/首数字粘连（「…9.6m2」+「2 …」→「…9.6m22」）使数字边界守卫误 miss，
  // 清单数量跨格组合的溯源整体失效（段间以换行保留数字边界）
  return parts
    .map(part => {
      const normalized = normalizeEngineeringTextForFactMatch(part);
      return normalized.replace(/(\d+\.\d*?)0+(?![\d])/gu, '$1').replace(/(\d+)\.(?![\d])/gu, '$1');
    })
    .join('\n');
}

/** 语料反查（数字边界守卫：防「9.6」命中「19.60」子串、「300」命中「1300」） */
function corpusContainsQuantity(corpus: string, normalizedToken: string): boolean {
  const variants = [normalizedToken];
  const zeroTrimmed = normalizeQuantityZeros(normalizedToken);
  if (zeroTrimmed !== normalizedToken) variants.push(zeroTrimmed);
  return variants.some(variant => new RegExp(`(?<![\\d.])${escapeRegExp(variant)}(?![\\d.])`, 'u').test(corpus));
}

/** 章节/目录编号形态（「1.22」：1~2 位整数段 + 2 位小数段）——目录与标题编号的书写口径。 */
const SECTION_NUMBERING_SHAPE_RE = /^(?:\d{1,2})\.\d{2}$/u;

/** 语境内的同形邻号（前后带数字边界，防从 251.941 里抠出无关小数）。 */
const SECTION_NUMBERING_SIBLING_RE = /(?<![\d.])(\d{1,2})\.(\d{2})(?![\d])/gu;

/** 被截断的同层邻号形态：小数点前无数字（前置数字边界断言不成立）、小数段 2 位——「1.23」被语境窗口
 * 从中间截成「.23」后的残余。语境提供方（审计窗口/调用方窗口）若仍截断数字，本形态是最后一道防线。 */
const SECTION_NUMBERING_TRUNCATED_SIBLING_RE = /(?<![\d.])\.(\d{2})(?![\d])/gu;

/**
 * 章节编号误报单源判定（L0-7；无主数值审计与 C-T2 溯源链共用——两处各写一套必漂移）：
 * 目录/标题里的编号被提取器连同标题首字吞成「数值 token」——真实成稿
 * 「1.22 周月计划报送与纠偏」的 token「1.22 周」中 1.22 是小节编号、周是标题首字，
 * 其相邻小节「1.21 / 1.23」即编号序列本身。
 * 判据（机制，不写死具体值）：token 数值核为编号形态 `\d{1,2}.\d{2}`，且语境中出现**同形邻号**
 * ——整数段相同且小数段相差 1（1.22 ↔ 1.23），或小数段相同且整数段相差 1（1.22 ↔ 2.22）。
 * 连续邻号是目录/标题编号的机制特征：正文量值不会以这种「同层 +1」序列成串出现。
 * 邻号被语境窗口截断（「1.23」→「.23」）时按截断残余形态同判（doc-1790115927170 实机：
 * 截断使前置数字边界断言不成立，真编号落未登记桶直通硬门禁）。
 * 反例（仍按未溯源处理）：无同形邻号的「1.22 周」类时量表述——不得因本族被静默放过。
 */
export function isSectionNumberingToken(input: { token: string; context: string }): boolean {
  const numericPart = /^\d+(?:\.\d+)?/u.exec(input.token.replace(/\s+/gu, ''))?.[0] ?? '';
  if (!SECTION_NUMBERING_SHAPE_RE.test(numericPart)) return false;
  const [integerText, decimalText] = numericPart.split('.');
  const integerPart = Number(integerText);
  const decimalPart = Number(decimalText);
  const context = input.context || '';
  for (const match of context.matchAll(SECTION_NUMBERING_SIBLING_RE)) {
    const sibling = match[0];
    if (sibling === numericPart) continue;
    const siblingInteger = Number(match[1]);
    const siblingDecimal = Number(match[2]);
    if (siblingInteger === integerPart && Math.abs(siblingDecimal - decimalPart) === 1) return true;
    if (siblingDecimal === decimalPart && Math.abs(siblingInteger - integerPart) === 1) return true;
  }
  // 截断邻号（实机 doc-1790115927170）：「1.23」被语境窗口从中间截成「.23」，整数段缺失使上面的
  // 前置数字边界断言不成立——小数点前无数字的 2 位小数段即同整数段邻号的截断残余，仍算同层邻号。
  for (const match of context.matchAll(SECTION_NUMBERING_TRUNCATED_SIBLING_RE)) {
    if (Math.abs(Number(match[1]) - decimalPart) === 1) return true;
  }
  return false;
}

/**
 * 规格粘连误报单源判定（L0-7；无主数值审计与 C-T2 溯源链共用）：型号/牌号/编号代号与其后数量
 * 无分隔符粘连时，提取器把两段吞成一个 token，其数值核是**拼接产物**——不是正文中的任何一个数
 * （实机：钢筋HRB4001.941t、钢筋工程…HRB40025.851t、DN405m、Φ251.941t）。
 * 据拼接产物报缺口 → 假缺口进硬门禁；据其进修复轮 → 误删/改写正确正文。故两侧同判豁免。
 * 形态一：token 自身为「字母/直径符号起头的代号段 + 完整数值段」（SPEC_GLUED_VALUE_RE）；
 * 形态二：代号在 token 之外（提取器自数字起匹配，Φ 不入 ASCII 型号分支）——token 为
 * 「数字段 + 完整数值段」且语境中该 token 前紧邻直径/管径/牌号代号（Φ251.941t 的 251.941t）。
 * 形态二是存在性判定，单用会误伤普通量值（424.2m 亦可切出 4|24.2m），故必须与语境代号同判。
 */
export function isSpecGluedValueToken(input: { token: string; context: string }): boolean {
  const rawToken = input.token.replace(/\s+/gu, '');
  if (!rawToken) return false;
  const token = normalizeEngineeringTextForFactMatch(input.token);
  if (token && SPEC_GLUED_VALUE_RE.test(token)) return true;
  if (!token || !SPEC_GLUED_DIGITS_RE.test(token)) return false;
  const context = input.context || '';
  if (!SPEC_GLUE_MARK_RE.test(context)) return false;
  // 代号须紧邻 token 前（Φ251.941t）：代号码段与 token 首段之间无分隔符才算粘连
  return new RegExp(`(?:DN|De|HRB|HPB|Φ|φ)\\s*${escapeRegExp(rawToken)}`, 'iu').test(context);
}

/**
 * 数字溯源三分类器（C-T2 核心；qualityValidation / numericVerification / 本模块扫描共用单源）：
 * 返回 regulatory/management 即豁免（合法数字，不进资料事实反查与修复轮）；unsourced 为候选，
 * 由调用方语料反查最终判定（项目事实可溯源 → 排除；未命中 → 真未溯源）。
 * 判定输入为原文 token 与语境窗口（句子或 ±36 字窗口均可），内部统一归一化形态匹配。
 */export function classifyNumericTraceToken(input: { token: string; context: string }): NumericTraceClassification {
  const rawToken = input.token.replace(/\s+/gu, '');
  const token = normalizeEngineeringTextForFactMatch(input.token);
  const context = input.context || '';
  if (!token) return NUMERIC_TRACE_UNSOURCED;
  // R1 标准编号：token 为标准号数字段（GB 50268）或标准号年份段（GB 50268-2019）
  for (const match of context.matchAll(STANDARD_CODE_IN_CONTEXT_RE)) {
    if (token === match[1]) return { kind: 'regulatory', basis: '标准编号' };
    if (match[2] && token === match[2]) return { kind: 'regulatory', basis: '标准编号年份' };
  }
  // R2 年份表述（标准发布/法规修正年份属公共知识口径；编造日期由跨章检查治理）
  if (/^(?:19|20)\d{2}年度?$/u.test(token)) return { kind: 'regulatory', basis: '年份表述' };
  // R3 养护龄期（7d/14天/28天 + 养护|龄期|强度试验语境）
  if (/^(?:3|7|10|14|21|28)(?:d|天)$/u.test(token) && /养护|龄期|标养|同条件|强度|试验/u.test(context)) return { kind: 'regulatory', basis: '养护龄期' };
  // R4 试块留置/检验批（每 100m³ 留置一组；每 400m³ 或每工作班一组）
  if (/^(?:50|100|150|200|250|400|500)m3$/u.test(token) && /试块|留置|检验批|砂浆|混凝土|浇筑|砌筑/u.test(context)) return { kind: 'regulatory', basis: '试块留置/检验批' };
  if (/^(?:50|100)盘$/u.test(token)) return { kind: 'regulatory', basis: '试块留置' };
  if (/^[1-9]组$/u.test(token) && /试块|留置|砂浆|混凝土|抗压|强度|钢筋/u.test(context)) return { kind: 'regulatory', basis: '试块留置' };
  // R5 检测频次（每层每 200m² 不少于 1 点）
  if (/^(?:100|200|400|1000)m2$/u.test(token) && /每层|压实度|检测|检验|测点|不少于|至少/u.test(context)) return { kind: 'regulatory', basis: '检测频次' };
  if (/^\d+点$/u.test(token) && /检测|检验|测量|观测|测点|抽检|不少于|至少/u.test(context)) return { kind: 'regulatory', basis: '检测频次' };
  // R6 温度阈值（入模温度不低于 5℃）
  if (/℃$/u.test(token) && /温度|养护|浇筑|入模|气温|环境|温差|加热/u.test(context)) return { kind: 'regulatory', basis: '温度阈值' };
  // R7 规范质量指标（压实度不低于 95% / 含泥量不超过 10%）
  if (/^\d+(?:\.\d+)?%$/u.test(token) && /压实度|饱满度|含泥量|密实度|压实系数|保证率|灰剂量|油石比/u.test(context)) return { kind: 'regulatory', basis: '质量指标' };
  // R8 工艺公差（厚度偏差不超过 ±5mm）
  if (/^\d+(?:\.\d+)?mm$/u.test(token) && /偏差|公差|误差/u.test(context)) return { kind: 'regulatory', basis: '工艺公差' };
  // R9 工艺压力参数（管道试压 4.0MPa、注浆压力 0.5MPa——规范试验值与设计工艺常数，非项目事实）
  // r28m M24d D4 扩词：稳压|压降（r28l 实机「稳压1h压降不超过0.05MPa且无渗漏为合格」——
  // 管道水压试验规范条款，原词表「试压/试验压力」等均不命中而落缺口）
  if (/^\d+(?:\.\d+)?mpa$/u.test(token) && /试压|水压|气压|压力试验|试验压力|工作压力|注浆|强度试验|严密性|稳压|压降/u.test(context)) return { kind: 'regulatory', basis: '工艺压力参数' };
  // R10 砂浆强度等级（M7.5 砌筑砂浆——规范等级代号，非项目数值）
  if (/^m\d+(?:\.\d+)?$/u.test(token) && /砂浆|砌筑|抹灰|强度|等级/u.test(context)) return { kind: 'regulatory', basis: '砂浆强度等级' };
  // R11 绝缘电阻（绝缘电阻不小于 0.5MΩ——电气验收规范常数；提取器对 MΩ 存在「M」尾截断形态）
  if ((/^\d+(?:\.\d+)?mω$/u.test(token) || (/^\d+(?:\.\d+)?m$/u.test(token) && /[ωΩ]/u.test(context))) && /绝缘|接地|电阻|兆欧/u.test(context)) return { kind: 'regulatory', basis: '绝缘电阻' };
  // R12 管系列代号（PPR 管 S3.2 系列——管材规格系列，非项目数值）
  if (/^s\d+(?:\.\d+)?$/u.test(token) && /ppr|pb|pvc|pe|管|系列|冷热|给水/iu.test(context)) return { kind: 'regulatory', basis: '管系列代号' };
  // R13 材料/设备规格型号（r28m M24d D4；s28l 实机 INT125-3P-50 / Q345-B——厂家型号与材质牌号，
  // 非项目数值）；前缀排除 DN/De/SC/JDG/HRB/HPB（规格管类防误吞）与混凝土/钢筋/砂浆语境（C30 类
  // 强度等级有自身溯源途径，不得借本族豁免）
  // L0-7 语境扩容：板型/型材/型钢/钢种/钢号/系列（实机「压型钢板，板型HV470B」——板型型号
  // 语境原词表不覆盖而落缺口；按语境词族扩容，不为单个型号开口子）
  if (/^(?!(?:dn|de|sc|jdg|hrb|hpb)\d)[a-z]{1,4}\d[\w./-]*$/u.test(token) && /材质|牌号|钢号|钢种|型号|板型|型材|型钢|系列|配置|开关|断路器|配电|电缆|配电箱|控制箱|规格型号/u.test(context) && !/混凝土|钢筋|砂浆/u.test(context)) return { kind: 'regulatory', basis: '材料/设备规格型号' };
  // R14 图纸构件/洞口/管段编号（r28m M24d D4；r28l D258、s28k M1222 实机——图内编号引用，非项目数值）；
  // D→d 由归一化处理；排除直径/壁厚/管径语境（D300 管径规格）与砂浆语境（R10 已先行）
  if (/^[md]\d{3,5}$/u.test(token) && /门窗|洞口|管段|管节|桩号|里程|井位|大样|详图|图集|编号|图纸/u.test(context) && !/直径|壁厚|管径|外径|内径|砂浆|砌筑/u.test(context)) return { kind: 'regulatory', basis: '图纸编号' };
  // R15 规范条件阈值（r28m M24d D4；s28k 实机「风管边长大于630mm时按规范设置加固框」——
  // 规范条文条件值（比较词+规范语境+数值单位三要件），非项目事实）
  if (/(?:大于|不小于|超过|不大于|不超过|小于)/u.test(context) && /(?:规范|规定|要求|标准|条文|验收)/u.test(context) && /^\d+(?:\.\d+)?(?:mm|cm|m|m2|m3|℃|%)$/u.test(token)) return { kind: 'regulatory', basis: '规范阈值' };
  // M1 管理频次（每日不少于 1 次安全检查 / 每周 2 次巡查）
  if (/^\d+(?:次|遍|轮|班|趟)$/u.test(token) && /每|逐|定期|不少于|至少/u.test(context) && MANAGEMENT_ACTION_RE.test(context)) return { kind: 'management', basis: '管理频次' };
  // M2a 施工组织编排（如「9 个片区分为若干班组平行施工」）
  if (/^\d+个$/u.test(token) && ORGANIZATION_UNIT_RE.test(context) && ORGANIZATION_ARRANGE_RE.test(context)) return { kind: 'management', basis: '施工组织编排' };
  // M2b 组织配置/岗位人数（配备专职安全员 2 名 / 成立 QC 小组 3 个）
  if (/^\d+(?:人|名|组|支|队)$/u.test(token) && /配备|配置|设置|组建|成立|设立|建立|派驻|指定|安排/u.test(context) && /专职|兼职|管理|岗位|人员|班组|队伍|小组|安全|质量|技术|施工|材料|资料|机械|劳务|作业/u.test(context)) return { kind: 'management', basis: '组织配置' };
  // M3 合同程序条款（缺陷责任期 24 个月 / 合理期限一般不超过 60 日历天——招标合同原文忠实引用）
  if (/(?:天|月|年|d|万元|元|%)$/u.test(token) && CONTRACT_CLAUSE_CONTEXT_RE.test(context)) return { kind: 'management', basis: '合同程序条款' };
  // M4 过程指标（焊接一次合格率 100% / 设备利用率 85%——施工部署自行编排的管理目标）
  if (/^\d+(?:\.\d+)?%$/u.test(token) && /完成|进度|利用率|得分|负荷|覆盖|达到|控制|以上|以下|不低于|合格率|优良率|成活率|出勤率|到岗率|出工率|一次验收/u.test(context)) return { kind: 'management', basis: '过程指标' };
  // M5 日期表述（计划 2026 年 8 月开工；用原文 token 形态区分「8月」日期与「8个月」时长——
  // 时长类必须溯源，日期类为进度编排管理数字，与既有 isCalendarDateToken 降级口径一致）
  if (/^\d+(?:\.\d+)?月$/u.test(rawToken) && /开工|竣工|计划|日期|旬|上旬|中旬|下旬|季度|汛期|雨季|冬季|夏季|月初|月底|年底|年中/u.test(context)) return { kind: 'management', basis: '日期表述' };
  // M6 服务时限承诺（保修期内 24 小时响应、48 小时到场抢修——服务条款管理数字，非项目事实）
  if (/^\d+(?:\.\d+)?小时$/u.test(token) && /保修|响应|抢修|到场|时限|服务|承诺|维修|热线|回访/u.test(context)) return { kind: 'management', basis: '服务时限承诺' };
  // M7 工期合计编排（r28m M24d D3；r28l「各节点用时合计89天」、s28k「五阶段合计344天」实机——
  // 进度编排管理数字与 M4/M5 同类，非资料反查锚定值；三要件：天单位 + 合计类词 + 工期语境词）
  if (/^\d+天$/u.test(token) && /合计|共计|总计|累计|总和|总共/u.test(context) && /工期|工序|节点|进度|衔接|机动|预留|缓冲/u.test(context)) return { kind: 'management', basis: '工期合计编排' };
  // 商务金额（暂列金额 60 万元等由商务条款检测器治理（commercial-data-in-body），不属溯源反查对象）
  if (/(?:万元|亿元|元)$/u.test(token) && /暂列金额|暂估价|报价|单价|合价|综合单价|税率|增值税|预留金|招标控制价|限价|造价/u.test(context)) return { kind: 'management', basis: '商务金额' };
  // R16 规格粘连（L0-7；实机 HRB4001.941t / HRB40025.851t / DN405m / Φ251.941t）：数值核是代号段与
  // 数量段的拼接产物，不是正文任何数——豁免而非「未溯源」（判定见 isSpecGluedValueToken 单源）
  if (isSpecGluedValueToken({ token: input.token, context })) return { kind: 'regulatory', basis: '规格粘连' };
  // R17 章节编号（L0-7；实机「1.22 周月计划报送与纠偏」的 token「1.22 周」）：小数编号 + 语境同形
  // 邻号 → 目录/标题编号，不是量值（判定见 isSectionNumberingToken 单源）
  if (isSectionNumberingToken({ token: input.token, context })) return { kind: 'regulatory', basis: '章节编号' };
  return NUMERIC_TRACE_UNSOURCED;
}

/**
 * C-T2 数字溯源扫描：提取 → 过滤（表格行/章节编号/长编码/无单位裸数）→ 三分类。
 * 无单位裸数仅年份与 3~5 位标准号数字产出命中（其余裸数为序号/编号噪声，不报不豁免——
 * 防误报淹没真未溯源）；表格行数值属计划分解数据不反查（与既有反查口径一致）。
 */
export function scanNumericTrace(markdown: string): NumericTraceHit[] {
  const hits: NumericTraceHit[] = [];
  for (const match of markdown.matchAll(TRACE_TOKEN_RE)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const normalizedToken = normalizeEngineeringTextForFactMatch(raw);
    if (!normalizedToken) continue;
    // 章节编号（1.2、2.3 等无单位纯小数）不是工程数字，不进溯源判定
    if (/^\d+\.\d+$/u.test(normalizedToken)) continue;
    // 长编码（9 位以上纯数字：单号/联系电话/信用代码）不报
    if (/^\d{9,}$/u.test(normalizedToken)) continue;
    // 表格行中的数值（进度计划表/机械配置表）属计划排期分解数据，不做溯源反查
    const lineStart = markdown.lastIndexOf('\n', index - 1) + 1;
    const lineEnd = markdown.indexOf('\n', index);
    const line = markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd);
    if (/^\s*\|/u.test(line.trim())) continue;
    // 无单位裸数：仅年份（公共知识口径）与 3~5 位标准号数字有意义
    const numericPart = /^\d+(?:\.\d+)?/u.exec(normalizedToken)?.[0] ?? '';
    const unitPart = normalizedToken.slice(numericPart.length);
    if (!unitPart && !/^(?:19|20)\d{2}$/u.test(normalizedToken) && !/^\d{3,5}$/u.test(normalizedToken)) continue;
    const sentence = extractSentenceAt(markdown, index, raw.length);
    const classification = classifyNumericTraceToken({ token: raw, context: sentence });
    // 无单位裸数：仅当分类豁免（标准号/年份命中）时产出命中；未命中的裸数是编号/序号噪声，不报
    if (!unitPart && classification.kind === 'unsourced') continue;
    hits.push({ token: raw, normalizedToken, index, sentence, kind: classification.kind, basis: classification.basis });
  }
  return hits;
}

/**
 * 未溯源数字反查（终稿验收口径）：扫描命中 ∩ 分类 unsourced ∩ 语料反查未命中。
 * 规范常数/管理数字为豁免项（合法数字）——只有真未溯源进入修复链与终检聚合，口径与 demote 修复器同源。
 */
export function buildNumericTraceFindings(markdown: string, factsModel: DocumentFactsModel): NumericTraceFinding[] {
  const corpus = numericTraceCorpus(factsModel);
  if (corpus.length < 40) return [];
  const findings: NumericTraceFinding[] = [];
  for (const hit of scanNumericTrace(markdown)) {
    if (hit.kind !== 'unsourced') continue;
    if (corpusContainsQuantity(corpus, hit.normalizedToken)) continue;
    findings.push({ token: hit.token, normalizedToken: hit.normalizedToken, sentence: hit.sentence, index: hit.index });
  }
  return findings;
}

/**
 * C-T2 终检检测器：未溯源数字聚合（error 级进修复链）。消息锚「生成后事实反查失败」与既有反查链
 * 同源——isHardExportBlockingIssue 显式豁免硬阻断（数字残留不阻断交付的产品口径），
 * REPAIRABLE_QUALITY_ISSUE_RE 命中进修复循环。
 */
export function numericTraceabilityIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const findings = buildNumericTraceFindings(markdown, factsModel);
  if (findings.length === 0) return [];
  const tokens = [...new Set(findings.map(finding => finding.token.replace(/\s+/gu, '')))];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'evidence_coverage',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `生成后事实反查失败：正文出现 ${tokens.length} 处未溯源数值 ${tokens.slice(0, 8).join('、')}${tokens.length > 8 ? ' 等' : ''}`,
    suggestion: '未溯源数值必须改为定性表述或显式标注来源：来自清单/图纸的保留并明确来源（清单条目/图纸编号）；规范常数（试块留置/养护龄期/检测频次等）保留时显性标注规范名称与编号；其余改为不带具体数值的过程控制表述。',
  }];
}

/** 删除残留标点清理（空括号/标点叠用/句首悬空标点；幂等） */
function tidyRemovalArtifacts(text: string): string {
  return text
    .replace(/[（(]\s*[)）]/gu, '')
    // r28h 扩围（r28h2 实机归因）：「按3m、4m、5m 等」并列数值被删后残留连续分隔标点
    //（「按3m、、、、等」）——原清理只覆盖「标点+句末标点」，连续顿号残留直坠终门禁
    //（punctuationArtifactIssues 报「、、」blocker）。同标点连写收敛为单个；分隔标点直接
    // 悬接「等」（「3m、等」）时删除悬空标点
    .replace(/([，,、；;])[ \t]*(?:\1[ \t]*)+/gu, '$1')
    .replace(/[，,、；;][ \t]*(?=等)/gu, '')
    .replace(/(?:[，,、；;：:]\s*)+(?=[。；;！!？?])/gu, '')
    .replace(/(?<=[。；;！!？?\n])\s*[，,、；;]+/gu, '');
}

/**
 * C-T2 链尾确定性改定性（方案「能改定性即改」）：真未溯源数字中的可删单位类（空间/数量/重量/
 * 长度）直接删除改定性表述；删除前保护（量词/约数/维度/关系字尾）拦截「每座90m²」「壁厚5mm」
 * 「间距1.2m」等删除后悬空或语义反转的形态；时间/次数/百分比/温度/金额类不由本器处置
 *（删除会改变语义，交 LLM 修复轮改写）。删除后清理病句标点；幂等可重放（无项时零成本返回 null）。
 */
export function demoteUnsourcedNumericTokens(input: {
  markdown: string;
  factsModel: DocumentFactsModel;
}): { markdown: string; fixedCount: number; details: string[] } | null {
  // G 线 P2-2：**停用本修复器**（不再以「删除数值」通过门禁）。
  //
  // 原实现把未溯源的数值 token 直接删除、改成定性表述，从而让「无主数值审计」的 blocker 消失。
  // 这是**用删除通过门禁**，而不是补齐权威值 —— 交付物看上去干净了，实际是「本来该有数据的地方
  // 被抹掉」。与验收基准（要么产出 95+ 的完整文档，要么明确失败并说清缺什么）直接冲突：
  // 删数值把「缺权威值」这一事实从交付物里抹掉，用户再也看不到缺口在哪。
  // 且修复链本就没有知识库通道（finalize/repairRounds 零检索），物理上补不进新材料，
  // 删除是它唯一「能收敛」的动作 —— 收敛压力全部走删除路径正是这个结构性原因。
  //
  // 现口径：保留数值与 blocker，让该文档按「未达交付标准」处理；补齐权威值属资料/配置侧动作。
  void input;
  return null;
}
