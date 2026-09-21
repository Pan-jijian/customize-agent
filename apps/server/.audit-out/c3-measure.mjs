import "node:fs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import "node:path";
import "node:os";
import { MultiProjectManager } from "@customize-agent/knowledge";
import * as path$1 from "path";
import * as os$1 from "os";
import * as fs$1 from "fs";
import "@customize-agent/llm";
import "@customize-agent/runtime";
import "xlsx";
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var init_budget = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/utils.ts
function stableHash(value) {
	return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}
function stringifyFactValue(value) {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
var BID_DISCIPLINE_PHRASES;
var init_utils = __esmMin((() => {
	BID_DISCIPLINE_PHRASES = [
		"评标纪律",
		"投标纪律",
		"行贿",
		"打招呼",
		"递条子",
		"廉洁承诺",
		"廉洁自律",
		"串标",
		"围标",
		"弄虚作假",
		"干扰评标",
		"异常低价",
		"评标基准价"
	];
}));
//#endregion
//#region apps/server/src/services/document-workflow/engineeringUnits.ts
function toHalfWidthChar(char) {
	const code = char.charCodeAt(0);
	if (code >= 65281 && code <= 65374) return String.fromCharCode(code - 65248);
	return char;
}
function normalizeEngineeringMeasure(value) {
	return value.replace(FULL_WIDTH_CHARS, toHalfWidthChar).replace(/\s+/gu, "").replace(/[—–‑﹣]/gu, "-").replace(/[×X＊*]/gu, "x").replace(/[％]/gu, "%").replace(/‰/gu, "permille").replace(/平方米|平方|平米|m²|㎡/giu, "m2").replace(/公顷|hm²/giu, "hm2").replace(/立方米|立方|m³/giu, "m3").replace(/升/gu, "l").replace(/毫升/gu, "ml").replace(/千米|公里/gu, "km").replace(/毫米/gu, "mm").replace(/厘米/gu, "cm").replace(/米/gu, "m").replace(/千克|公斤/gu, "kg").replace(/克/gu, "g").replace(/吨/gu, "t").replace(/人民币万元|万元人民币/gu, "万元").replace(/人民币元|元人民币|¥/gu, "元").replace(/日历天|自然日/gu, "天").replace(/工作日/gu, "工作天").replace(/个月/gu, "月").replace(/小时/gu, "h").replace(/分钟/gu, "min").replace(/兆帕/gu, "mpa").replace(/千帕/gu, "kpa").replace(/千牛/gu, "kn").replace(/牛/gu, "n").replace(/千瓦/gu, "kw").replace(/兆瓦/gu, "mw").replace(/瓦/gu, "w").replace(/千伏/gu, "kv").replace(/伏/gu, "v").replace(/毫安/gu, "ma").replace(/安培|安/gu, "a").replace(/赫兹/gu, "hz").replace(/摄氏度/gu, "℃").replace(/百分之\s*(\d+(?:\.\d+)?)/gu, "$1%").replace(/千分之\s*(\d+(?:\.\d+)?)/gu, "$1permille").replace(/直径\s*(\d+(?:\.\d+)?)/gu, "φ$1").replace(/[Φφ]\s*(\d+(?:\.\d+)?)(?:mm)?/giu, "φ$1").replace(/DN\s*(\d+)/giu, "dn$1").replace(/D\s*(\d+)(?=\b|[^a-z0-9])/giu, "d$1").replace(/\b(KN|MPA|KPA|KW|MW|KV|HZ|DN)\b/giu, (item) => item.toLowerCase()).replace(/[，,、。；;：:|｜()（）【】\]《》<>"“”'‘’[]/gu, "");
}
function normalizeEngineeringTextForFactMatch(value) {
	return normalizeEngineeringMeasure(value).toLowerCase();
}
var FULL_WIDTH_CHARS;
var init_engineeringUnits = __esmMin((() => {
	FULL_WIDTH_CHARS = /[Ａ-Ｚａ-ｚ０-９％＋－．，]/gu;
}));
//#endregion
//#region apps/server/src/services/document-workflow/billFactLock.ts
/** 从条目特征描述中提取规格 token（去重、保持原样） */
function extractSpecTokens(text) {
	return [...new Set((text.match(SPEC_TOKEN_RE) || []).map((item) => item.replace(/\s+/gu, "").trim()))].filter(Boolean).slice(0, 8);
}
/** 章节相关性 token：章节标题/小节标题切词，用于清单条目筛选 */
function chapterRelevanceTokens(chapterTitle, sections = []) {
	return [...new Set(`${chapterTitle} ${sections.join(" ")}`.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9_-]{3,}/gu) || [])].filter((token) => token.length >= 2);
}
/** 判定清单行名是否为落位口径豁免（非落位必要行）；返回豁免类别供审计登记。
* 行上下文（code/quantity）用于分部标题行判据（无编码且无工程量 + 「XX工程」结尾，
* r28h2 实测 57 行、s28h2 96 行分部标题重复行——分部名不是施工内容项） */
function classifyBillPlacementExemption(name, context) {
	const normalized = String(name || "").replace(/\s+/gu, "");
	const normalizedCode = String(context?.code || "").replace(/\s+/gu, "");
	const hasQuantity = Boolean(String(context?.quantity || "").trim());
	if (!normalized) {
		if (/^合\s*计$/u.test(normalizedCode)) return "summary-row";
		if (BILL_PLACEMENT_EXEMPT_NOISE_RE.test(normalizedCode)) return "noise-row";
		if (BILL_PLACEMENT_EXEMPT_NOTE_RE.test(normalizedCode)) return "note-row";
		return "no-name-row";
	}
	if (BILL_PLACEMENT_EXEMPT_NAME_RE.test(normalized)) return "summary-row";
	if (BILL_PLACEMENT_EXEMPT_NOISE_RE.test(normalized)) return "noise-row";
	if (BILL_PLACEMENT_EXEMPT_NOTE_RE.test(normalized) || BILL_PLACEMENT_EXEMPT_NOTE_RE.test(normalizedCode)) return "note-row";
	if (normalized.length <= BILL_PLACEMENT_EXEMPT_FEE_MAX_LEN && (BILL_PLACEMENT_EXEMPT_FEE_RE.test(normalized) || /(?:费|税)(?:小计|合计)$/u.test(normalized))) return "fee-row";
	if (!hasQuantity && BILL_DOTTED_NUMBER_RE.test(normalizedCode)) return "numbered-heading-row";
	if (BILL_ORDINAL_CODE_RE.test(normalizedCode) && BILL_FEE_CATEGORY_NAME_RE.test(normalized)) return "ordinal-category-row";
	if (/工程$/u.test(normalized) && !normalizedCode && !hasQuantity) return "section-title-row";
	if (BOQ_GENERIC_NAME_STOPWORDS.has(normalized)) return "generic-name-row";
}
/** 相关性 token 扩展：多字中文词补双字子词（「排水工程」→「排水」「水工」「工程」），
* 覆盖清单条目名与章标题词面粒度不一致的形态（条目「混凝土排水沟」只含「排水」子词）；
* 导出供 chapterParameterFacts（C-T6 参数按章相关性）复用同一词面口径 */
function expandRelevanceToken(token) {
	if (token.length < 3 || !/[\p{Script=Han}]{2,}/u.test(token)) return [token];
	const expanded = new Set([token]);
	for (let index = 0; index + 2 <= token.length; index += 1) expanded.add(token.slice(index, index + 2));
	return [...expanded];
}
/** 剥离清单特征标准尾句（多段并列时逐段剥离）；责任章映射与单测共用 */
function stripBillDescriptionBoilerplate(text) {
	if (!text) return text;
	let result = text;
	for (let round = 0; round < 4; round += 1) {
		const next = result.replace(BILL_DESC_BOILERPLATE_RE, " ");
		if (next === result) break;
		result = next;
	}
	return result.replace(/\s+/gu, " ").trim();
}
/** C3-5-4 词面命中判定（责任章/建议小节评分单源）：切片原词直接命中；双字子词仅当位于切片
* 首/尾（词边界概率高）且不在停用词表时命中——中段子词多为跨词碰撞碎片（「三级配电两级保护」
* 中段切出「级配」误命中「级配碎石」；「验收闭环与资料同步」中段「资料」） */
function relevanceTokenMatches(token, text) {
	if (!text || !token) return false;
	if (token.length < 3 || !/[\p{Script=Han}]{2,}/u.test(token)) return text.includes(token);
	if (text.includes(token)) return true;
	for (let index = 0; index + 2 <= token.length; index += 1) {
		if (index !== 0 && index + 2 !== token.length) continue;
		const sub = token.slice(index, index + 2);
		if (BILL_SUBWORD_STOPWORDS.has(sub)) continue;
		if (text.includes(sub)) return true;
	}
	return false;
}
/** 清单条目在章内的建议落位小节（写作证据位）：规划小节中与条目文本词面最相关者 */
function pickBillSection(text, sections) {
	let best;
	let bestScore = 0;
	for (const raw of sections) {
		const section = String(raw || "").trim();
		if (section.length < 2) continue;
		let score = 0;
		for (const token of chapterRelevanceTokens(section)) if (relevanceTokenMatches(token, text)) score += 1;
		if (score > bestScore) {
			bestScore = score;
			best = section;
		}
	}
	return best;
}
/**
* 行级任务清单驱动（每行→责任章→写作证据位，方案 C-T5②）：为清单条目分配责任章。
* 判定：各章 token（标题+规划小节切词）与条目（名称/特征/分部/子分部）词面相关分取最高正分章；
* 同分取大纲顺序靠前章。全部零分回退施工方法类章（此类章承载分项施工叙述）；无章上下文时返回 undefined。
* C3-5-4 加固：评分前剥离清单特征标准尾句（boilerplate 通用词不构成归属证据）；双字子词命中限
* 切片首/尾且非停用词（中段碎片不命中）——修历史缺陷：s28l 963 条绿化条目因尾句「验收」「资料」
* 被错归「工程施工的重点和难点及保证措施」章。
*/
function assignBillRowChapter(entry, chapters = []) {
	if (chapters.length === 0) return void 0;
	const text = stripBillDescriptionBoilerplate([
		entry.name,
		entry.description,
		entry.section,
		entry.subsection
	].filter(Boolean).join(" "));
	if (!text) return void 0;
	let bestTitle = "";
	let bestScore = 0;
	let bestSection;
	for (const chapter of chapters) {
		let score = 0;
		for (const token of chapterRelevanceTokens(chapter.title, chapter.sections || [])) if (relevanceTokenMatches(token, text)) score += 1;
		if (score > bestScore) {
			bestScore = score;
			bestTitle = chapter.title;
			bestSection = pickBillSection(text, chapter.sections || []);
		}
	}
	if (bestScore > 0) return {
		chapterTitle: bestTitle,
		section: bestSection
	};
	const fallback = chapters.find((chapter) => BILL_METHOD_CHAPTER_RE.test(chapter.title));
	return fallback ? { chapterTitle: fallback.title } : void 0;
}
var SPEC_TOKEN_RE, BILL_PLACEMENT_EXEMPT_NAME_RE, BILL_PLACEMENT_EXEMPT_NOISE_RE, BILL_PLACEMENT_EXEMPT_FEE_RE, BILL_PLACEMENT_EXEMPT_FEE_MAX_LEN, BILL_DOTTED_NUMBER_RE, BILL_ORDINAL_CODE_RE, BILL_FEE_CATEGORY_NAME_RE, BILL_PLACEMENT_EXEMPT_NOTE_RE, BOQ_GENERIC_NAME_STOPWORDS, BILL_DESC_BOILERPLATE_RE, BILL_SUBWORD_STOPWORDS, BILL_METHOD_CHAPTER_RE;
var init_billFactLock = __esmMin((() => {
	SPEC_TOKEN_RE = /(?:\d+(?:\.\d+)?\s*(?:W|kW|kV|V|A|Hz|mm|cm|m|km|kg|g|t|K|MPa|kN|℃|%|L|mL|s|h|min)\b|C\d{2,}|HRB\d+|HPB\d+|DN\s*\d+|Φ\s*\d+(?:\.\d+)?|φ\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*[×x*]\s*\d+(?:\.\d+)?)/giu;
	BILL_PLACEMENT_EXEMPT_NAME_RE = /^(?:分部小计|本页小计|小计|合计|总计|总价|合价|按实计算|按实结算|暂估|暂列金额|计日工|规费|税金)$/u;
	BILL_PLACEMENT_EXEMPT_NOISE_RE = /分部分项工程量清单|^工程名称[：:]|^第\s*\d+\s*页|^共\s*\d+\s*页|^措施项目$/u;
	BILL_PLACEMENT_EXEMPT_FEE_RE = /(?:费|税|暂估价|暂列金额)$/u;
	BILL_PLACEMENT_EXEMPT_FEE_MAX_LEN = 24;
	BILL_DOTTED_NUMBER_RE = /^\d{1,3}(?:[.．]\d{1,3}){1,4}$/u;
	BILL_ORDINAL_CODE_RE = /^(?:[一二三四五六七八九十]{1,3}|\d{1,2})$/u;
	BILL_FEE_CATEGORY_NAME_RE = /^(?:人工|材料|机械|施工机械|设备|人工费|材料费|机械费|施工机械费|其他|其它)$/u;
	BILL_PLACEMENT_EXEMPT_NOTE_RE = /^说明[：:]/u;
	BOQ_GENERIC_NAME_STOPWORDS = new Set([
		"其他",
		"材料",
		"人工",
		"软件",
		"硬件",
		"机械",
		"设备",
		"建筑",
		"安装",
		"拆除",
		"服务",
		"费用",
		"项目",
		"工程",
		"施工",
		"内容",
		"其中",
		"以上",
		"以下",
		"临时",
		"措施",
		"合计",
		"小计"
	]);
	BILL_DESC_BOILERPLATE_RE = /(?:详见|参见)[^。；;]{0,24}?(?:图纸|图集|答疑|招标文件|政府相关文件|规范)[^。；;]{0,160}/gu;
	BILL_SUBWORD_STOPWORDS = new Set([
		"施工",
		"现场",
		"工程",
		"其他",
		"其它",
		"内容",
		"主要",
		"相关",
		"要求",
		"方法",
		"措施",
		"工作",
		"进行",
		"采用",
		"包括",
		"以及",
		"根据",
		"按照",
		"满足",
		"符合",
		"达到",
		"组织",
		"安排",
		"计划",
		"实施",
		"说明",
		"事项",
		"情况",
		"钢筋",
		"材料",
		"管理"
	]);
	BILL_METHOD_CHAPTER_RE = /施工方法|施工方案|施工工艺|主要施工内容|分部分项/u;
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentFactTrace.ts
function normalize(value) {
	return value.replace(/[\s,，.。:：;；|｜（）()《》<>【】"“”'‘’]/gu, "").toLowerCase();
}
/** 单条目落位判定（C3-5 单源，供 buildBoqRowTraces 与修复轮复检共用；入参为已归一化文本）：
* 三通道——首段主名 12 字符（2 字主名须过泛词保护名单）/ 整名 12 字符 / 编码 8 字符 */
function boqItemCarriedInText(normalizedText, itemName, itemCode = "") {
	const normalizedName = normalize(itemName);
	const normalizedCode = normalize(itemCode);
	const primaryName = normalize(String(itemName || "").split(/[\s（(、，,;；:：]/u)[0] || "");
	return (primaryName.length >= 3 || primaryName.length === 2 && !BOQ_GENERIC_NAME_STOPWORDS.has(primaryName)) && normalizedText.includes(primaryName.slice(0, 12)) || normalizedName.length >= 3 && normalizedText.includes(normalizedName.slice(0, 12)) || normalizedCode.length >= 3 && normalizedText.includes(normalizedCode.slice(0, 8));
}
/** 构建 BOQ 行级落位追踪（C3-5 单源：行识别/豁免/落位判定唯一实现——门禁 boqPlacementIssues、
* 报告出口 boq-row-trace、分项覆盖 boqDivisionCoverageIssues 全链消费本函数，修历史口径双轨：
* 门禁 16 字符整名前缀 vs 报告 12 字符首段前缀，s28l 实测 1118 vs 822 行未落位差 296 行） */
function buildBoqRowTraces(markdown, factsModel) {
	const tables = factsModel.tables || [];
	const traces = [];
	const normalizedMarkdown = normalize(markdown);
	for (const table of tables) {
		const headers = table.headers.map((h) => h.replace(/\s+/gu, "").toLowerCase());
		const nameCol = headers.findIndex((h) => BOQ_NAME_COLUMN_RE.test(h));
		const codeCol = headers.findIndex((h) => BOQ_CODE_COLUMN_RE.test(h));
		const qtyCol = headers.findIndex((h) => BOQ_QTY_COLUMN_RE.test(h));
		const unitCol = headers.findIndex((h) => BOQ_UNIT_COLUMN_RE.test(h));
		for (const row of table.rows) {
			let itemName = nameCol >= 0 ? row[nameCol] || "" : "";
			let itemCode = codeCol >= 0 ? row[codeCol] || "" : "";
			if (!itemName && !itemCode) {
				const codeIdx = row.findIndex((cell) => /^\d{10,12}$/u.test(cell) || /^[A-Z]{1,3}\d{8,}$/u.test(cell));
				if (codeIdx >= 0) {
					itemCode = row[codeIdx] || "";
					itemName = row[codeIdx + 1] || "";
				}
			}
			const quantity = qtyCol >= 0 ? row[qtyCol] || "" : "";
			const unit = unitCol >= 0 ? row[unitCol] || "" : "";
			if (!itemName && !itemCode) continue;
			const placed = boqItemCarriedInText(normalizedMarkdown, itemName, itemCode);
			traces.push({
				itemCode: itemCode.slice(0, 50),
				itemName: itemName.slice(0, 200),
				quantity: quantity.slice(0, 50),
				unit: unit.slice(0, 20),
				sourceFile: table.sourceFile || "",
				placed,
				exempt: classifyBillPlacementExemption(itemName, {
					code: itemCode,
					quantity
				}) !== void 0,
				description: row.map((cell) => String(cell ?? "")).join(" ").replace(/\s+/gu, " ").trim().slice(0, 240)
			});
		}
	}
	return traces.sort((a, b) => a.placed === b.placed ? 0 : a.placed ? 1 : -1);
}
var normalizeBoqMatchText, BOQ_NAME_COLUMN_RE, BOQ_CODE_COLUMN_RE, BOQ_QTY_COLUMN_RE, BOQ_UNIT_COLUMN_RE;
var init_documentFactTrace = __esmMin((() => {
	init_billFactLock();
	normalizeBoqMatchText = normalize;
	BOQ_NAME_COLUMN_RE = /^(?:项目名称|名称|清单项名称|清单项目名称|分部分项(?:工程)?名称|项目特征|工程内容|材料名称|设备名称)/u;
	BOQ_CODE_COLUMN_RE = /^(?:项目编码|编码|编号)/u;
	BOQ_QTY_COLUMN_RE = /^(?:工程量|数量)/u;
	BOQ_UNIT_COLUMN_RE = /单位/u;
	new RegExp(`(?:GB|JGJ|CJJ|CECS|ISO|SL|DL|JTS|JTG|JT|TB|DB\\d{2}|DB)\\s*\\/?\\s*T?\\s*(\\d{3,5})(?:\\s*[-—–]\\s*(\\d{2,4}))?`, "giu");
}));
//#endregion
//#region apps/server/src/services/document-workflow/constants.ts
var CAD_ENTITY_TOKEN_RE, FILE_NAME_RE, CN_NUMERAL_RE;
var init_constants$1 = __esmMin((() => {
	CAD_ENTITY_TOKEN_RE = /\b(?:TDbPipe|TDbPipeValve|TDbPipeFitting|TDbWellh|AcDb\w+|Dwg\w+|Polyline|Hatch|Layer|BlockReference)\b/giu;
	FILE_NAME_RE = /[\w\u4e00-\u9fa5\-—_+]+\.(?:pdf|dwg|docx?|xlsx?|xls|csv|png|jpe?g|webp)\b/giu;
	CN_NUMERAL_RE = "[零〇一二三四五六七八九十百千万两]+";
}));
//#endregion
//#region apps/server/src/services/document-workflow/parameterPatterns.ts
var EVIDENCE_PARAMETER_RE;
var init_parameterPatterns = __esmMin((() => {
	EVIDENCE_PARAMETER_RE = /\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年)|DN\s*\d+|Φ\s*\d+|φ\s*\d+|C\d{2,}|HRB\d+|GB\/?T?\s*[\w.-]+|JGJ\s*[\w.-]+|\d+\s*[×xX]\s*\d+/iu;
}));
function getStorageRoot() {
	return path$1.join(os$1.homedir(), ".customize-agent");
}
function getMultiProjectManager() {
	if (!manager) manager = new MultiProjectManager(getStorageRoot());
	return manager;
}
var manager;
var init_kbService = __esmMin((() => {
	manager = null;
}));
//#endregion
//#region apps/server/src/services/constants/documentRoleConstants.ts
var init_documentRoleConstants = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/constants/engineeringTechnicalFactConstants.ts
var init_engineeringTechnicalFactConstants = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/constants/rolePipelineConstants.ts
var init_rolePipelineConstants = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/constants/qualityValidationConstants.ts
var init_qualityValidationConstants = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/constants/index.ts
var init_constants = __esmMin((() => {
	init_documentRoleConstants();
	init_engineeringTechnicalFactConstants();
	init_rolePipelineConstants();
	init_qualityValidationConstants();
}));
var init_engineeringDocumentConfigService = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-core/documentRoleService.ts
var init_documentRoleService = __esmMin((() => {
	init_constants();
}));
//#endregion
//#region apps/server/src/services/document-core/projectMaterialService.ts
var init_projectMaterialService = __esmMin((() => {
	init_kbService();
}));
//#endregion
//#region apps/server/src/services/common/configService.ts
var init_configService = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/tuningProfile.ts
/** 读取调优配置（JSON 解析失败按全默认处理，仅告警一次） */
function tuningProfile() {
	const raw = process.env.DOCUMENT_TUNING_PROFILE;
	if (profileCache && profileCache.raw === raw) return profileCache.parsed;
	const parsed = {};
	if (raw) try {
		const json = JSON.parse(raw);
		for (const key of TUNING_PROFILE_KEYS) {
			const value = json[key];
			if (typeof value === "number") parsed[key] = value;
			else if (typeof value === "string" && value.trim() !== "") {
				const numeric = Number(value);
				if (Number.isFinite(numeric)) parsed[key] = numeric;
			}
		}
	} catch (error) {
		console.warn(`[tuningProfile] DOCUMENT_TUNING_PROFILE 解析失败，按全默认处理：${String(error)}`);
	}
	profileCache = {
		raw,
		parsed
	};
	return parsed;
}
var TUNING_PROFILE_KEYS, profileCache;
var init_tuningProfile = __esmMin((() => {
	TUNING_PROFILE_KEYS = [
		"chapterConcurrency",
		"sectionConcurrency",
		"sectionGroupConcurrency",
		"sectionGroupSize",
		"sectionGroupTaskConcurrency",
		"plannedBlockConcurrency",
		"tableFixConcurrency",
		"llmMaxConcurrency",
		"writingTaskConcurrency",
		"projectGraphDomainConcurrency",
		"writingTaskMaxWords",
		"blockEvidenceChars",
		"chapterPoolChars",
		"evidenceBudgetRatio",
		"evidenceBudgetCeiling",
		"evidenceCatalogMaxLines",
		"factCoverageCap",
		"factExtractionMaxChars",
		"factExtractionMaxItems",
		"outlineEvidenceChars",
		"persistEvidenceMaxItems",
		"persistEvidenceItemChars",
		"repairEvidenceChars",
		"capacityFeasibilityRecalibration",
		"blueprintBlockQuantityCap",
		"blueprintBlockMaterialCap",
		"blueprintBlockSliceCap"
	];
})), rawMaxConcurrency, envMaxConcurrency;
var init_llmClient = __esmMin((() => {
	init_configService();
	init_tuningProfile();
	rawMaxConcurrency = tuningProfile().llmMaxConcurrency;
	envMaxConcurrency = Number.isFinite(rawMaxConcurrency) ? rawMaxConcurrency === 0 ? Number.POSITIVE_INFINITY : rawMaxConcurrency > 0 ? Math.floor(rawMaxConcurrency) : void 0 : void 0;
	envMaxConcurrency ?? Number.POSITIVE_INFINITY;
	(() => {
		const raw = Number(process.env.DOCUMENT_PREFIX_SCHEDULE_WINDOW_MS);
		return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : void 0;
	})();
}));
//#endregion
//#region apps/server/src/services/document-workflow/templatingGovernance.ts
var STRUCTURE_LABEL_BAN_LINE, SKELETON_FINGERPRINT_BAN_LINE;
var init_templatingGovernance = __esmMin((() => {
	STRUCTURE_LABEL_BAN_LINE = "正文禁止以“施工概况/施工流程/施工方法/工艺流程/施工步骤”等结构标签充当小节标题或段落开头引导（不得出现“施工概况：本项目……”式标签行），要素内容直接融入连贯段落叙述。";
	SKELETON_FINGERPRINT_BAN_LINE = "句式禁止复读：全篇「由技术负责人组织」「合格后方可」「验收合格后」三类骨架表述各自不得超过 2 次，任何同义替换表达全篇不得超过 8 次；同义表达必须逐句轮换、句式多样（动词与语序随句变化），不得集中复用同一说法，保持事实不变（岗位、数值、频次不得丢失）。";
}));
//#endregion
//#region apps/server/src/services/document-workflow/semanticSimilarity.ts
var init_semanticSimilarity = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/semanticGate.ts
var init_semanticGate = __esmMin((() => {
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/workflowRules.ts
var DEFAULT_WORKFLOW_RULES;
var init_workflowRules = __esmMin((() => {
	DEFAULT_WORKFLOW_RULES = {
		factGovernance: {
			thresholdComparison: "不低于|不少于|不高于|不超过|不得少于|不得高于|不得小于|不小于|不大于|大于等于|小于等于|≥|≤|≧|≦|以上|及以上|以内|之内",
			amendmentContext: "修正|调整|变更|更改|更正|改为|澄清|更新|修订",
			aspirationalPrefix: "拟|规划|目标|力争|预计|期望|远期|未来|设想|建议|预期|争取|拟建|规划建设",
			addendumSource: "补疑|答疑|澄清|补充|更正|修改",
			weakAnchorGapThreshold: 9
		},
		writingSpec: {
			criticalSectionAnchors: [
				"主要施工内容",
				"工程概况",
				"项目概况",
				"重点难点",
				"危大工程",
				"应急预案",
				"施工部署",
				"总平面",
				"主要分部分项工程施工方案",
				"主要分部分项施工方案",
				"主要施工方法"
			],
			majorContentSection: "项目主要施工\\s*内容|主要施工\\s*内容",
			divisionSection: "主要分部分项工程施工方案|主要分部分项施工方案|主要施工方法",
			divisionProcessLabel: "工艺流程|施工流程",
			criticalDeepSections: [
				"项目特点.*重点.*难点|重点.*难点.*分析",
				"项目主要施工\\s*内容|主要施工\\s*内容",
				"主要分部分项工程施工方案|主要施工方法",
				"危大工程专项施工方案审批流程",
				"原材料进场复试|见证取样"
			],
			blockerMinChars: {
				emergency: 650,
				majorContent: 1800,
				division: 1200,
				focus: 1500
			},
			divisionQuality: {
				blockerMinPackages: 3,
				minPackages: 5,
				minParamsPerPackage: 4,
				minPackageChars: 150,
				balanceRatio: 1 / 3
			},
			writeRules: {
				majorContent: "【项目主要施工内容专项结构】只能根据绑定材料中的当前项目事实识别施工对象和工作包；不得套用固定行业模板，不得复述完整工程概况，不得写“以图纸清单为准”式空话；不得使用 Markdown 表格。必须按专业工程/分部分项工程逐项展开，每个专业工程单独一个“#### 工作包名称”三级小节（不得把所有专业工程合并成一个小节），内容覆盖三方面要素：①作业对象与工程量（什么部位、什么规模）、②工序安排（先后顺序清晰）、③施工方法（怎么干、用什么参数验收）。呈现形式要求：三方面要素必须融入连贯散文叙述，禁止以“施工概况/施工流程/施工方法”等结构标签充当小节标题或段落开头引导（不得出现“施工概况：……”式标签行），标签词只是后台结构概念、不得入题入文。工作包小节必须与上下文“主要施工工作包”列表一一对应，每个工作包只允许展开一次；严禁把同一个工作包以“X工程”“X工作包”两种口径重复写成两个小节，也不得新增图谱之外的工作包小节。作业对象与工程量要素必须写该工作包对应的本项目作业对象、部位、规模/工程量、材料设备或系统边界，写成连贯叙述，避免“xxx｜工程量”式清单原文罗列；工程量数值必须与工程量清单汇总值一致（只写项目总量，禁止写分部小计、单村分表量或估算值）。工序要素必须有明确的工序顺序表达，形式按小节序号轮换使用（顺序词叙述、编号步骤、有序列表、箭头链四形式；系统已为各小节指定形式，禁止相邻小节使用同一形式、禁止通篇同一形式，如“基层清理→放线定位→分层摊铺→碾压→压实度检测→验收”），每个工作包至少 1 处不少于 4 个环节的工序顺序表达，不得只把工序顺序局限在一处标签段；施工方法要素写成连贯叙述，落到具体工具机具、测量/检测方法、工艺参数、材料规格、穿插关系、质量验收、复试检测和资料闭环，每个工作包施工方法宜落位至少 3 个具体工艺参数（厚度、间距、偏差、含水率、饱满度、坡度、压实度等），参数来自绑定材料或行业通用规范值，禁止“按规范施工”“结合实际执行”式空话，严禁把工程量清单条目原样罗列成“xxx：2台；xxx：1台；”式参数堆砌。严禁出现工程量清单计价表内部口径词：分部小计、本页小计、合计、小计、按实、暂估、综合单价、措施项目费、规费、税金（这些是清单计价表专用标记，正式正文一律不得出现；“措施项目”作为专业工程类别名称可用，但不得与“清单/计价/费”连用）。施工方法写法样例（句式参照，内容按本项目事实替换）：“配电箱采用挂墙方式安装，箱体中心距地1.5m，盘面垂直度偏差不超过1.5/1000；柜内元器件按系统图接线，导线分色标识，接线紧固力矩按规格控制；安装完成后进行绝缘电阻测试并形成通电试运行记录。”至少形成 5 个施工工作包，工作包必须来自绑定材料证据。本小节正文总量不少于 2200 字（每个工作包小节按 300 字以上展开，写足三要素、工序细节与验收要求，防止内容深度不足触发导出阻断）。",
				division: "【主要分部分项工程施工方案专项要求】每个“#### 分项工程方案”三级小节内容需覆盖三方面要素：①作业对象与工程量（本项目作业对象、部位、工程量）、②工序安排（先后顺序清晰）、③施工方法（工具机具、材料规格、工艺参数、验收标准）。呈现形式要求：三方面要素必须融入连贯散文叙述，禁止以“施工概况/施工流程/施工方法”等结构标签充当小节标题或段落开头引导（不得使用结构标签词作为分项小节名），标签词只是后台结构概念、不得入题入文。严禁用“**分项名**”粗体行代替“#### 分项名”小节标题，也不得把多个分项合并写在一个段落里。工程量数值必须与工程量清单汇总值一致（只写项目总量，禁止写分部小计、单村分表量或估算值），严禁出现工程量清单计价表内部口径词：分部小计、本页小计、合计、小计、按实、暂估、综合单价、措施项目费、规费、税金。工序要素必须有明确的工序顺序表达，形式按小节序号轮换使用（顺序词叙述、编号步骤、有序列表、箭头链四形式；系统已为各分项小节指定形式，禁止相邻分项使用同一形式、禁止通篇同一形式，如“基层清理→放线定位→分层摊铺→碾压→压实度检测→验收”），每个分项方案至少 1 处不少于 4 个环节的工序顺序表达，不得只把工序顺序局限在一处标签段；每个分项方案正文必须落位至少 4 个工艺参数（mm、MPa、间距、偏差、坡度、养护天数、试验压力、搭接长度等），参数来自绑定材料或行业通用规范值，不得编造；纯设备配置型小节必须写型号、规格、容量、数量参数；不得写“按规范施工”“结合实际执行”式空话。分项间深度必须均衡：门窗维修、立面修补、设备安装等小分项同样要写足作业对象、工序与工艺参数（每个分项不少于 150 字），不得一句话带过；严禁写“其他专业工序引用相应章节内容”“详见相关章节”等自我消解语，工序安排只能在本分项方案内展开，不得另行拆节复述。",
				labor: "【劳动力配置专项写作规则】工种构成表必须且只能使用锚点“工种构成”：各工种人数与合计（=劳动力峰值）与锚点完全一致，不得改写、不得自设其他工种构成；分阶段劳动力投入表各阶段人数必须与锚点“分阶段劳动力投入”一致，最大值等于劳动力峰值，任何阶段不得超过峰值；正文叙述与表格数值口径一致；规划了表格的小节必须输出正式 Markdown 表格；禁止将各工种人数相加推导峰值、禁止按定额自行估算劳动力数值。",
				material: "【材料配置专项写作规则】主要材料表必须且只能引用锚点“主要材料”清单：材料名称、型号、规格（混凝土强度等级、管径、功率、厚度、尺寸等）、数量与锚点完全一致；清单条目中明确给出的材料型号与参数是事实数据，必须原样引用，不得编造、改写或省略；锚点未列出的材料不得自行添加型号规格。施工方法与工艺叙述中提及的材料型号、规格、参数同样必须以清单特征原文或锚点清单为准。"
			},
			threeSourceRules: [
				"【写作三源规则】正文中的每一个数字与事实只有三种合法来源，三源之外一律不得写入：",
				"F·项目事实源：来自绑定材料、工程量清单、图纸与权威锚点的项目专属事实（工程量、规格、数量、工期、金额、地点、单位名称），一律原样引用，数值、单位、口径与源完全一致，不得改写、拆分或近似。",
				"D·系统推导源：劳动力分配、工种构成、分阶段投入、机械台数、进度时间安排、材料进场时间、试验计划、检验批划分等计划类数值，已由蓝图统一推导并写入权威锚点，一律原样引用；严禁基于工程量、工期、定额或经验重新估算、换算或另设数值，锚点给出多少就写多少。",
				"P·公共规范源：法律法规、标准规范（GB/JGJ/CJJ/DB 系列）与通用施工工艺参数可引用现行有效版本，规范必须带编号，不得虚构编号或引用已废止版本。",
				"三源均无依据时不得编造凑数：不得留空、不得写“另行确定”“按需配置”“根据进度灵活调配”“依据定额计算”等回避话术，也不得用行业先验数字冒充项目数据；此时只写已有三源事实、工艺细节与适用边界。"
			].join("\n")
		}
	};
})), DEFAULT_WRITING_SPEC, THREE_SOURCE_WRITE_RULES;
var init_writingSpec = __esmMin((() => {
	init_workflowRules();
	DEFAULT_WRITING_SPEC = DEFAULT_WORKFLOW_RULES.writingSpec;
	DEFAULT_WRITING_SPEC.criticalSectionAnchors;
	new RegExp(DEFAULT_WRITING_SPEC.majorContentSection, "u");
	new RegExp(DEFAULT_WRITING_SPEC.divisionSection, "u");
	new RegExp(DEFAULT_WRITING_SPEC.divisionProcessLabel, "u");
	DEFAULT_WRITING_SPEC.writeRules.majorContent;
	DEFAULT_WRITING_SPEC.writeRules.division;
	DEFAULT_WRITING_SPEC.writeRules.labor;
	DEFAULT_WRITING_SPEC.writeRules.material;
	THREE_SOURCE_WRITE_RULES = DEFAULT_WRITING_SPEC.threeSourceRules;
	DEFAULT_WRITING_SPEC.criticalDeepSections.map((source) => new RegExp(source, "u"));
	DEFAULT_WRITING_SPEC.divisionQuality.blockerMinPackages, DEFAULT_WRITING_SPEC.divisionQuality.minPackages, DEFAULT_WRITING_SPEC.divisionQuality.minParamsPerPackage, DEFAULT_WRITING_SPEC.divisionQuality.minPackageChars, DEFAULT_WRITING_SPEC.divisionQuality.balanceRatio;
}));
var init_constructionOrgTablePlan = __esmMin((() => {
	new RegExp(`^.{2,36}?表`, "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/markdownComposer.ts
/**
* 3.1 system 前缀统一：全部任务类型共用同一 L0 开头（L0 公共前缀 + FORMAL_WRITING_RULES 完整文本，
* ≥2000 字符），角色差异句后移到 system 尾部固定位置——DeepSeek prefix cache 从 messages[0] 起
* 逐字节匹配，公共段从 ~300 字符扩到 3000+ 字符，跨任务类型（Writer/规划/评审/修复/提取/校准）
* 前缀命中显著上升。FORMAL_WRITING_RULES 首行自带「不得覆盖用户在提示词中已明确的要求」自限声明，
* 对 JSON 提取/评审类调用无副作用（输出契约仍由 L0 第 3 条与调用点 prompt 约束）。
* （原 DOCUMENT_UNIFIED_SYSTEM_PREFIX 回退已固化删除：统一公共段恒开）
*/
function unifiedSystemHead() {
	return [DOCUMENT_L0_COMMON_PREFIX, FORMAL_WRITING_RULES].join("\n\n");
}
/** 3.2 非 Writer 调用点（规划/评审/修复/提取/校准）统一挂接公共前缀：role 为该 调用点角色身份与任务规则，
* 与 Writer 家族共享 DOCUMENT_L0_COMMON_PREFIX 第一段，跨类型 prefix cache 从零命中变为全类型共享。
* 3.1：公共段扩展为 L0 + FORMAL_WRITING_RULES（≥2000 字符），role 保持尾部固定位置。
* （原 DOCUMENT_L0_SYSTEM_PREFIX legacy 回退已固化删除：统一前缀恒开，legacyPrefix 参数保留兼容调用点） */
function docSystemPrefix(role, _legacyPrefix) {
	return [unifiedSystemHead(), role].join("\n\n");
}
var INLINE_LIST_MARKER_RE, CR_CHAR, LF_CHAR, SOURCE_ENUMERATION_PHRASE_RE, MARKDOWN_TABLE_FORMAT_RULES, TENDER_BID_WRITING_RULES, FORMAL_WRITING_RULES, SECTION_GENERATION_SAFETY_RULES, DOCUMENT_L0_COMMON_PREFIX;
var init_markdownComposer = __esmMin((() => {
	init_templatingGovernance();
	init_outline$1();
	init_semanticGate();
	init_writingSpec();
	init_constructionOrgTablePlan();
	INLINE_LIST_MARKER_RE = String.raw`(?:\d+[.、](?=\s|\*\*)\s*|[（(]\d+[）)]\s*|[-*+]\s+)`;
	new RegExp(String.raw`\S.+(?:\s|[。；;])${INLINE_LIST_MARKER_RE}\S.+(?:\s|[。；;])${INLINE_LIST_MARKER_RE}\S`, "u");
	CR_CHAR = String.fromCharCode(13);
	LF_CHAR = String.fromCharCode(10);
	new RegExp(`${CR_CHAR}?${LF_CHAR}`, "u");
	new RegExp(`${LF_CHAR}{3,}`, "gu");
	SOURCE_ENUMERATION_PHRASE_RE = /(?<=^|[。；;\n])(?:本方案|本施工组织设计|本工程|本项目|项目部|我方|我公司|投标人)?(?:根据|依据|结合|按照)?(?:本项目|项目)?(?:招标文件|补疑澄清文件|补遗澄清文件|补疑补遗|答疑(?:回复)?文件|答疑修正口径|补充答疑修正口径|澄清文件|工程量清单|设计图纸|施工图纸|图纸资料|设计修改通知单)(?:[、,，及和与\s]*(?:招标文件|补疑澄清文件|补遗澄清文件|补疑补遗|答疑(?:回复)?文件|答疑修正口径|补充答疑修正口径|澄清文件|工程量清单|设计图纸|施工图纸|图纸资料|设计修改通知单|现行规范|规范)){1,}(?:[^。；;\n]{0,40})?[，,]/gmu;
	new RegExp(SOURCE_ENUMERATION_PHRASE_RE.source, "mu");
	MARKDOWN_TABLE_FORMAT_RULES = [
		"Markdown 表格格式硬约束：凡是输出 Markdown 表格，必须使用标准 GFM 表格格式。",
		"表格必须包含表头行、分隔线和数据行；表头下一行必须是分隔线，例如 |---|---|。",
		"禁止只输出连续的“| 字段 | 值 |”裸表格行；两列键值信息表默认使用表头 | 信息项 | 内容 |。",
		"表头、分隔线和数据行必须连续，中间不得插入正文、说明、空行或补充段落。",
		"表格数据完整性硬约束：数据行每一列都必须有具体数据值，不得出现空单元格；不得用“—/若干/约/待定/暂无/不适用”等占位或模糊表达代替具体数据（合计/小计/总计/累计行的“—”不适用语义除外；规格型号列中无规格型号的小型机具如蛙式打夯机、小型夯实机可写“—”表示机具无型号，同属不适用语义）。数据优先取自本项目资料与蓝图权威锚点；计划类数值（人数、台班、进度时间）必须原样引用蓝图推导值，不得按工程量、工期或定额自行推算另设，不得凭空编造型号。",
		"表格名称/标题不得占用表格单元格（如“竣工清理与移交计划表”作为表头第一格导致整表错位）；表名写在表格上方的正文叙述中，表内第一行从表头列名开始。",
		"正文表格不得展示后台溯源列或系统过程列，如“资料来源/说明”“资料来源/证明”“知识库来源”等。",
		"项目名称、项目编号、招标人/业主/建设单位、建设地点、建设规模、计划工期、质量标准、合同估算价等项目基础信息，只能在项目基本信息表中集中输出一次；后续章节如需引用，应写入正文或专业表格的业务字段，不得重复生成项目基础信息键值表。",
		"表头差异化硬约束：全文各表格表头不得完全相同——各章同构控制表（如“关键节点|计划完成时间|责任岗位|投入资源|检查频次|滞后纠偏措施”）必须加本章主题限定，如首列表名改为“进度关键节点”“质量关键节点”“劳动力关键节点”等主题词，或表前引导句点名用途；禁止全文 3 处及以上完全相同的表头堆叠（同表头多表属模板化凑数形态，评标低分项）。"
	].join("\n");
	TENDER_BID_WRITING_RULES = [
		"【内容落地五要素】每项管控措施必须写全五要素：方案 + 流程 + 责任人 + 时间节点 + 验收标准；责任人落到具体岗位（项目经理/技术负责人/施工员/质检员/安全员/材料员等），检查频次量化到每日/每周/每月/不少于X次，整改落到“整改→复查→销项”闭环。禁止只写“加强、落实、确保”式无责任、无标准、无频次的空话。",
		"【闭环句式密度硬约束】全文每 1500 字至少 1 段完整闭环句式：同一自然段内必须同时出现责任岗位（项目经理/技术负责人/施工员/质检员/安全员/材料员/试验员等）+ 检查频次（每日/每周/每月/不少于X次/定期）+ 整改闭环（整改/复查/销项/复验）三要素，缺一不可；禁止措施段落只有频次数字而无责任岗位，或只有岗位口号而无量化频次。",
		"【空话禁用】措施句不得使用无动作对象、无量化标准的宣传口号式短语作为核心表述，不得以单字虚词（合理、充分、完善、切实、尽量、适时）作为措施句核心动词；一律改写为“责任岗位 + 执行动作 + 量化标准 + 检查频次 + 整改闭环”句式。",
		"【评分点响应】段落首句先回应本节评分点或招标评审关键词，再展开具体措施；一段只写一个主题，避免多个得分点混在大段文字中；三级标题尽量直接放置评分关键词。",
		"【数据表格化】关键数据（建筑面积、层数、总工期、开工竣工节点、设备型号数量、管理人员配置、劳动力人数、材料批次、养护天数、检测频次、检验批划分）优先用表格呈现，不藏在正文大段文字中；正文中数据密集型内容（多组对比数值、多岗位职责分工、多阶段资源配置、多节点工期安排、多类管控指标、多工种劳动力分配）宁可多用表格，直观性优于纯文字叙述。表格前必须有 1～2 句引导叙述说明表格作用与关键结论，表格不能替代小节正文。每张表格应有说明性标题或表前引导句点名用途；同一主题同一数据不得重复堆叠凑数，但内容较多的主题可合理分组为多张表。",
		"【工艺参数密度】正文每 1000 字至少落位 6 处带单位的量化工艺参数（如 20mm、C30、0.5MPa、养护 28 天、搭接长度 500mm、压实度 95%、含水率 3%），均匀分布在各章节而非集中在个别小节；参数必须来自绑定材料或行业通用规范值，不得编造。当绑定材料可提供的参数不足该密度时，以材料全部参数落位为准，禁止用行业先验虚构参数凑数。",
		"【工序顺序表达】施工流程、施工方法、检验验收类叙述必须有清晰的工序顺序表达，形式按小节序号轮换使用：顺序词叙述（先…再…最后…、依次/先后/按…顺序）、编号步骤、有序列表、箭头链；禁止相邻小节同一形式、禁止通篇同一形式（如通篇箭头链）。每个分部分项方案至少 1 处 3 环节以上的工序顺序表达，全文含工序顺序表达的段落占比不低于 8%。",
		"【数据自洽】全文核心数据（工程名称、建设地点、总工期、建筑面积、层数、人员、机械、材料批次、施工阶段划分、危大工程清单）必须前后一致，任何跨章冲突、参数矛盾即为内容缺陷；数据以绑定材料与计划推导结果为准，不得一处一改。",
		"【工艺黄金公式】工艺描述按“工艺名称 + 来源依据 + 适用范围 + 核心工序（按施工顺序 3～5 步）+ 质量控制要点（1～2 个量化指标）”展开；提及规范标准必须带编号（如 GB 50204-2015）并采用现行有效版本，不得虚构或引用已废止版本。",
		"【重难点公式】重难点 = 项目具体条件 + 难度分析 + 影响后果；工程重点 3～5 条、工程难点 3～4 条，每个重难点必须在后续对应章节给出解决措施形成跨章闭环。",
		"【低雷同】不同章节不得复制相同段落；同类措施必须通过句式重构、数据替换、流程细化差异化表达；项目概况叙述（位置＋规模＋建设内容＋工期＋质量目标的连写段）全文只允许在项目基本信息表引导段出现一次，特点分析、重难点分析等小节直接切入特点与对策，禁止再次粘贴项目概况段；不写“本工程严格执行国家有关标准规范”式通用万能句。"
	].join("\n");
	FORMAL_WRITING_RULES = [
		"以下规则仅用于保障导出格式正确和事实安全，不得覆盖用户在提示词中已明确的要求。",
		"严禁使用“根据/依据招标文件、补疑澄清文件、工程量清单及设计图纸”等资料来源罗列开头；正文必须直接写项目事实、施工内容、控制措施、验收节点。编制依据类小节除外：该小节可集中罗列编制依据文件清单。",
		"禁止模板化空话与流程套话：不同小节必须写各自专属的专业内容，逐节落位本项目工程量、设备规格、工艺参数与验收标准，不得复制相同段落，不得用泛化的流程描述代替专业内容；正文末尾不得输出自我总结或合规声明段落。",
		SKELETON_FINGERPRINT_BAN_LINE,
		TENDER_BID_WRITING_RULES,
		"项目概况只交代一次：工程地点、建设规模（总建筑面积）、计划工期、改造范围、保留商铺等总述信息，只在项目概况/工程概况类章节集中交代。其他章节不得以“本项目为……”开头整段复述项目概况；正文直接写本专业内容，确需数据支撑时只引用所需的具体数字（如“按计划工期倒排”“针对改造范围面积”），不复述面积、商铺、工期的完整概况段。",
		"【导出格式】章标题用 ## ，节标题用 ### 加数字编号（如 1.1），小节标题用 #### 加数字编号（如 1.1.1）。禁止用数字编号或粗体代替 ###/#### 标题。",
		MARKDOWN_TABLE_FORMAT_RULES,
		"【段落格式】段落之间必须空行（双换行）分隔，不得用单换行连续写大段文字。列表项逐行独占。步骤描述之间加空行。",
		THREE_SOURCE_WRITE_RULES
	].join("\n");
	SECTION_GENERATION_SAFETY_RULES = [
		"只生成当前节及其节内三级小节正文，不生成其他同级节，不重复章节一级标题。",
		"优先使用当前模板、用户要求、绑定提示词和绑定材料中的事实；项目专属事实（具体数值、时间、规格、人名、品牌、责任主体）缺少依据时不得编造。",
		"禁止编造具体日期：开工日期、竣工日期、具体某月某日只有在绑定材料明确提供时才可写入；材料未提供具体日期时，进度安排一律用相对工期表达（如\"开工令下发后第7日\"\"第1日～第7日\"），不得写\"2026年8月8日\"等绝对日期。",
		"小节应有实质正文；除非用户或模板明确要求纯表格，否则表格只能作为辅助表达，不能整节只有表格。",
		"不得用通用兜底段落、空泛管理话术或后台缺料说明冒充正文；信息不足时只写已有事实、适用边界和待复核口径。",
		"小节标题中的工程类别必须在本节正文有对应施工内容；不得照抄工程量清单章节汇总行名称，本项目未实施的工程类别不得出现在标题与正文中。",
		"除非绑定材料明确提供图集编号，否则不得写“执行/参照XX图集”类引用；做法描述直接写构造层次与材料规格。",
		STRUCTURE_LABEL_BAN_LINE
	].join("\n");
	DOCUMENT_L0_COMMON_PREFIX = [
		"你是专业施工组织设计文档生成智能体，承担文档结构规划、正文写作、质量评审与局部修复任务。",
		"通用硬约束：",
		"1. 事实分级：项目专属事实（工期、金额、工程量、建设规模、人名、公司、品牌、供应商、材料规格、日期节点）必须来自绑定材料，不得编造；公共专业知识（法律法规名称、标准规范编号 GB/JGJ/CJJ/DB 系列、通用施工工艺与行业惯例）可依据现行有效版本直接引用，不得虚构编号或引用已废止版本。",
		"2. 输出中不得出现后台流程话术（知识库、检索、资料类型、提示词角色、规范包、事实字段、缺失项、校验结果、资料未提供、未检索到等）。",
		"3. 严格遵守调用点给出的输出契约：JSON 调用只返回 JSON，正文调用遵循 Markdown 结构要求。"
	].join("\n");
	[
		DOCUMENT_L0_COMMON_PREFIX,
		"你是施工组织设计文档写作专家。",
		FORMAL_WRITING_RULES,
		SECTION_GENERATION_SAFETY_RULES
	].join("\n\n");
}));
var init_projectGraph = __esmMin((() => {
	init_llmClient();
	init_markdownComposer();
	[
		"通读以下项目资料（招标文件、工程量清单、图纸设计说明、补疑文件等），",
		"输出一个 JSON 对象，描述你对该项目的完整理解。",
		"",
		"JSON 字段（全部为数组，无相关信息时返回空数组）：",
		"  works:           [{name, scope, sourceFiles, relatedItems}]",
		"  methods:         [{name, steps, applicableWorks, sourceFiles}]",
		"  resources:       [{name, type:\"material\"|\"equipment\"|\"labor\", spec, quantity, unit, sourceFiles}]",
		"  schedule:        [{milestone, duration, startDate, endDate, sourceFiles}]",
		"  standards:       [{code, description, sourceFiles}]",
		"  risks:           [{risk, level:\"high|medium|low\", mitigation, sourceFiles}]",
		"  requirements:    [{category, detail, sourceFiles}]",
		"  siteConditions:  [{condition, impact, sourceFiles}]",
		"  addendumChanges: [{originalPath, original, revised, sourceFile}]",
		"  gaps:            [string] 仅记录资料中确实缺失且影响施工组织设计编制的事实；证据中已出现的内容不得声称「未提供/未找到」",
		"",
		"只基于资料内容，不编造。每个条目标注来源文件。只返回 JSON。"
	].join("\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/selection.ts
/**
* 按分数排序后选择，记录丢弃日志
*
* @param items 候选项
* @param scoreFn 评分函数（返回数字，越高越重要）
* @param budget 预算（最大项数或最大总字符数）
* @param label 标签（用于日志）
*/
function selectByScore(items, scoreFn, budget, label = "items") {
	const maxItems = budget.maxItems ?? Number.MAX_SAFE_INTEGER;
	const maxChars = budget.maxChars ?? Number.MAX_SAFE_INTEGER;
	const charFn = budget.charFn ?? ((item) => JSON.stringify(item).length);
	const scored = items.map((item) => ({
		item,
		score: scoreFn(item)
	}));
	scored.sort((a, b) => b.score - a.score);
	const selected = [];
	const dropped = [];
	let totalChars = 0;
	for (const { item } of scored) {
		const chars = charFn(item);
		if (selected.length < maxItems && totalChars + chars <= maxChars) {
			selected.push(item);
			totalChars += chars;
		} else dropped.push(item);
	}
	const droppedLog = [];
	if (dropped.length > 0) {
		droppedLog.push(`[selection] ${label}: 预算 ${maxItems}项/${maxChars}字符 → 选中 ${selected.length}项(${totalChars}字符)，丢弃 ${dropped.length}项`);
		for (const item of dropped.slice(0, 10)) {
			const summary = typeof item === "string" ? item.slice(0, 80) : JSON.stringify(item).slice(0, 80);
			droppedLog.push(`  - 丢弃: ${summary}`);
		}
		if (dropped.length > 10) droppedLog.push(`  ... 及其他 ${dropped.length - 10} 项`);
	}
	return {
		selected,
		dropped,
		droppedLog
	};
}
/**
* 文本重要性评分：优先保留包含数字/参数/关键词的文本
*/
function textImportanceScore(text) {
	let score = 0;
	const len = text.length;
	if (len === 0) return 0;
	const numberCount = (text.match(/\d+(?:\.\d+)?/gu) || []).length;
	score += numberCount * 3;
	if (/m[23²³]?|mm|cm|km|t|kg|台|套|个|项|批|次|份|人|日历天|天|月|万元|元|%|MPa|kPa|kN|℃/iu.test(text)) score += 2;
	if (/GB|JGJ|ISO|CJJ|CECS|DL|YB|SH|HG|SY|NB/iu.test(text)) score += 3;
	if (/验收|质量|安全|工期|进度|成本|风险|危大|重点|难点|关键|控制|标准|规范|设计|施工|材料|设备/u.test(text)) score += 1;
	if (len < 20) score -= 1;
	if (/项目名称|工程名称|招标人|建设地点|计划工期|质量标准|合同估算/u.test(text)) score += 2;
	return score;
}
var init_selection = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/agentWorkflow.ts
var init_agentWorkflow = __esmMin((() => {
	init_kbService();
	init_markdownComposer();
}));
//#endregion
//#region apps/server/src/services/document-workflow/projectMaterialProfile.ts
function normalizePathKey(filePath) {
	return filePath.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
}
function inferMaterialKind(filePath) {
	const text = normalizePathKey(filePath).toLowerCase();
	const raw = filePath;
	const signals = [];
	const hit = (pattern, signal) => {
		pattern.lastIndex = 0;
		if (!pattern.test(raw) && !pattern.test(text)) return false;
		signals.push(signal);
		return true;
	};
	if (hit(/补疑|答疑|澄清|疑问回复|答复|变更|更正|补充通知|addendum|clarification/iu, "补疑/澄清关键词")) return {
		kind: "addendum",
		confidence: .92,
		signals
	};
	if (hit(/清单|工程量|分部分项|措施项目|项目特征|招标控制价|boq|bill.?of.?quantities/iu, "清单/工程量关键词")) return {
		kind: "bill_of_quantities",
		confidence: .9,
		signals
	};
	if (hit(/图纸|施工图|建筑图|结构图|安装图|设计图|总平|平面图|立面图|剖面图|节点|dwg|drawing|cad/iu, "图纸/设计关键词")) return {
		kind: "drawing",
		confidence: .88,
		signals
	};
	if (hit(/招标文件|投标人须知|评标办法|招标公告|招标正文|招标需求|tender|bidding/iu, "招标文件关键词")) return {
		kind: "tender_document",
		confidence: .9,
		signals
	};
	if (hit(/合同|协议书|专用条款|通用条款|contract/iu, "合同关键词")) return {
		kind: "contract",
		confidence: .82,
		signals
	};
	if (hit(/技术规范|技术要求|施工规范|验收规范|标准|做法说明|specification|standard/iu, "技术规范关键词")) return {
		kind: "technical_specification",
		confidence: .8,
		signals
	};
	if (hit(/工期|进度|计划|节点|里程碑|schedule/iu, "工期进度关键词")) return {
		kind: "schedule_document",
		confidence: .72,
		signals
	};
	if (hit(/质量|安全|文明|环保|危大|验收|quality|safety/iu, "质量安全关键词")) return {
		kind: "quality_safety_document",
		confidence: .72,
		signals
	};
	return {
		kind: "other",
		confidence: .35,
		signals: ["未命中明确资料类型，按其他资料处理"]
	};
}
var init_projectMaterialProfile = __esmMin((() => {
	init_kbService();
	init_projectGraph();
	init_evidence();
	init_agentWorkflow();
}));
var init_templateStore = __esmMin((() => {
	init_kbService();
	init_documentRoleService();
	init_engineeringDocumentConfigService();
	init_projectMaterialService();
	init_projectMaterialProfile();
	init_agentWorkflow();
	Math.max(5e3, Number(process.env.DOCUMENT_TEMPLATE_VALIDATION_CACHE_TTL_MS ?? 3e4));
}));
var OUTLINE_TAG_NAME_RE;
var init_outline$1 = __esmMin((() => {
	init_constants$1();
	init_templateStore();
	new RegExp(`^(?:第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]|\\d{1,3}[、)）]|\\d{1,3}[.．]\\s|(?:${CN_NUMERAL_RE})[、.．)）])`, "u");
	OUTLINE_TAG_NAME_RE = "(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)";
	new RegExp(`<\\s*${OUTLINE_TAG_NAME_RE}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\s*${OUTLINE_TAG_NAME_RE}\\s*>`, "giu");
}));
//#endregion
//#region apps/server/src/services/document-workflow/factMatching.ts
var init_factMatching = __esmMin((() => {
	init_outline$1();
}));
//#endregion
//#region apps/server/src/services/document-workflow/evidence.ts
function cleanEvidenceText(content) {
	return [...content].filter((char) => {
		const code = char.charCodeAt(0);
		return code === 9 || code === 10 || code === 13 || code >= 32;
	}).join("").replace(CAD_ENTITY_TOKEN_RE, "").replace(FILE_NAME_RE, "").replace(/\b(?:Model|Layout\d*|Entity|Handle|ObjectId|ByLayer|Continuous)\b/giu, "").replace(/[\t ]{2,}/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}
/**
* 关键事实行提取（T0 事实层来源）：数值参数行、项目基础事实行、标准规范编号行。
* 用于证据三层注入的关键事实层——全量保留（评分只决定顺序不决定去留），
* 重要数据（数值/参数/工期/金额/标高/强度等级/规范编号）经此通道不参与预算裁剪。
*/
function extractKeyFactLines(content) {
	const keyLines = cleanEvidenceText(content).split("\n").map((line) => line.trim()).filter(Boolean).filter((line) => {
		const isProjectBasicValue = /计划工期|合同工期|工期|合同估算价|合同估算价格|投资估算|估算价格|工程估算价|最高投标限价|招标控制价|建设地点|建设规模|质量标准/u.test(line);
		if (!isProjectBasicValue && /综合单价|合价|报价明细|投标报价|税率|增值税|利润|预留金|暂列金额|结算/u.test(line)) return false;
		const hasParameter = EVIDENCE_PARAMETER_RE.test(line);
		const hasStdCode = /(?:GB\s*\/?\s*T?|JGJ|CJJ|DB\s*\/?\s*T?|CECS|ISO|IEC)\s*[\w./-]*\d/u.test(line);
		const hasContext = /项目|工程|工期|合同|估算|价格|地点|规模|清单|图纸|设计|规格|型号|数量|单位|材料|设备|管|线|电缆|混凝土|钢筋|砌体|门窗|防水|标准|规范|验收|做法|参数|尺寸|标高|厚度|强度|等级|系统|安装/u.test(line);
		return isProjectBasicValue || hasParameter || hasStdCode || hasContext && /\d/u.test(line) && line.length <= 260;
	});
	const compactLines = [...new Set(keyLines)].map((line) => extractKeyFactPhrases(line)).filter(Boolean);
	return selectByScore([...new Set(compactLines)], (l) => textImportanceScore(l), {}, "key-fact-lines").selected.join("\n");
}
/** 超长行参数短语提取：行 >160 字时抽取「数值+单位」「基础事实短语」「规范编号」子串，
* 保证长段落中的关键数值不因行截断/预算裁剪丢失（重要数据零丢失通道） */
function extractKeyFactPhrases(line) {
	if (line.length <= 160) return line;
	const phrases = line.match(/\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|L|ml|MPa|kPa|℃|%|台|套|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年)|DN\s*\d+|Φ\s*\d+|φ\s*\d+|C\d{2,}|HRB\d+|(?:计划工期|合同工期|合同估算价|投资估算|最高投标限价|招标控制价|建设地点|建设规模|质量标准)[^。；;，,]{0,40}|(?:GB|JGJ|CJJ|DB|CECS|ISO|IEC)\s*\/?\s*T?\s*[\w./-]*\d/gu);
	return phrases && phrases.length > 0 ? [...new Set(phrases)].join("；") : line.slice(0, 160);
}
var init_evidence = __esmMin((() => {
	init_constants$1();
	init_parameterPatterns();
	init_factMatching();
	init_selection();
}));
//#endregion
//#region apps/server/src/services/document-workflow/drawingFactLock.ts
function isDrawingEvidence(item, fileProcessingByPath) {
	const basename = item.filePath.split("/").pop() || item.filePath;
	if (DRAWING_DERIVED_FILE_RE.test(basename)) return false;
	if ((item.processingType || fileProcessingByPath?.get(item.filePath) || "") === "drawing") return true;
	return DRAWING_FILE_RE.test(`${item.filePath} ${item.sectionTitle || ""}`);
}
/** 事实行归一化：去全部空白 + 全角冒号转半角 + 小写（正文落位判定同口径） */
function normalizeToken(value) {
	return value.replace(/\s+/gu, "").replace(/：/gu, ":").toLowerCase();
}
/**
* 事实行 token 提取（正文落位验收锚点）：规格 token（单位数值/C30/DN100/Φ150/尺寸对）+
* 规格代号 + 配比 + 图集编号；归一化后长度 ≥3 且非纯数字（短通用 token 如「4m」不参与判定）；
* C3-6-2 提纯：表格列名残片（colN）与尺寸对拆分残片（xNNN）滤除——两类形态无设计事实语义，
* 入池只会稀释判定质量或制造永不可达 token。
*/
function extractDrawingFactTokens(line) {
	const rawTokens = [
		...extractSpecTokens(line),
		...line.match(SPEC_CODE_TOKEN_RE) || [],
		...line.match(RATIO_TOKEN_RE) || [],
		...line.match(ATLAS_CODE_TOKEN_RE) || []
	];
	return [...new Set(rawTokens.map(normalizeToken).filter((token) => token.length >= 3 && !/^\d+$/u.test(token) && !TABLE_COLUMN_TOKEN_RE.test(token) && !DIMENSION_FRAGMENT_TOKEN_RE.test(token)))];
}
function isSemanticFactLine(line) {
	const cjk = (line.match(CJK_CHAR_RE) || []).length;
	if (cjk < SEMANTIC_CJK_MIN) return false;
	if (cjk / line.length >= SEMANTIC_CJK_RATIO) return true;
	return (line.match(DIGIT_CHAR_RE) || []).length / line.length <= FRAGMENT_DIGIT_RATIO_MAX;
}
/**
* 构建图纸事实锁：图纸类证据 → 按来源文件分组 → 关键事实行提取 + token 判定锚点。
* 无图纸类证据返回 undefined；有图纸但事实行/token 为空的分组计入 unusableDrawings（不纳入验收分母）。
*/
function buildDrawingFactLock(input) {
	const contentByFile = /* @__PURE__ */ new Map();
	for (const item of input.evidence || []) {
		if (!item?.content || !isDrawingEvidence(item, input.fileProcessingByPath)) continue;
		const list = contentByFile.get(item.filePath);
		if (list) list.push(item.content);
		else contentByFile.set(item.filePath, [item.content]);
	}
	if (contentByFile.size === 0) return void 0;
	const groups = [];
	let unusableDrawings = 0;
	for (const [sourceFile, contents] of contentByFile) {
		const seen = /* @__PURE__ */ new Set();
		const factLines = [];
		for (const line of extractKeyFactLines(contents.join("\n")).split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length < FACT_LINE_MIN_CHARS || trimmed.length > FACT_LINE_MAX_CHARS) continue;
			if (!isSemanticFactLine(trimmed)) continue;
			if (seen.has(trimmed)) continue;
			seen.add(trimmed);
			factLines.push(trimmed);
			if (factLines.length >= PER_DRAWING_MAX_LINES) break;
		}
		const tokens = [...new Set(factLines.flatMap((line) => extractDrawingFactTokens(line)))];
		if (tokens.length === 0) {
			unusableDrawings += 1;
			continue;
		}
		groups.push({
			sourceFile,
			factLines,
			tokens
		});
	}
	return {
		groups,
		usableDrawings: groups.length,
		unusableDrawings,
		totalFacts: groups.reduce((sum, group) => sum + group.factLines.length, 0)
	};
}
/** 事实行与章节的相关性分：行命中章节 token（标题/小节切词）越多越相关 */
function lineRelevanceScore(line, tokens) {
	return tokens.reduce((sum, token) => sum + (line.includes(token) ? 1 : 0), 0);
}
/**
* 渲染图纸事实锁注入文本（B-T3 图纸行直读通道，C3-6-3 三段式扩容）：按章节相关性排序事实行后渲染，
* 每份图纸保底行保证各图纸均有进入正文的机会（引用率验收 ≥1 处/份的前提），
* 数据不经检索召回与注入截断直接进入写作提示词。三段结构：
* ① 深段：相关性 top-DEEP_INJECTION_GROUPS 份 × perDrawingMinLines 行（本章核心图纸深注入）；
* ② 相关性段：其余份 × 1 行（该份本章相关性首行），两段合计至 RELEVANCE_STAGE_SHARE 预算；
* ③ 旋转覆盖段：全份按稳定序（sourceFile 字典序）以章节标题 hash 旋转起点逐份 1 行，至预算尽
*   （每章起点不同 → 各份图纸跨章获得注入机会，图纸总数超出预算容量时的覆盖率保障）；
* ④ 全局补足：两段后仍有预算（小池场景）时按「章节相关性 → 图纸序 → 行序」填满。
*/
function renderDrawingFactLockText(lock, chapterTitle, opts = {}) {
	if (!lock || lock.groups.length === 0) return "";
	const defaultMaxChars = /设计|说明|构造|做法|材料|规格|施工方法|施工工艺|技术|结构|设备|安装|布置|质量|安全/u.test(chapterTitle) ? 8e3 : 6e3;
	const maxChars = Math.max(1, opts.maxChars ?? defaultMaxChars);
	const perDrawingMinLines = Math.max(1, opts.perDrawingMinLines ?? 3);
	const tokens = chapterRelevanceTokens(chapterTitle, opts.sections || []);
	const scoredGroups = lock.groups.map((group) => ({
		group,
		ranked: group.factLines.map((line, index) => ({
			line,
			index,
			score: lineRelevanceScore(line, tokens)
		})).sort((a, b) => b.score - a.score || a.index - b.index)
	}));
	const picked = /* @__PURE__ */ new Set();
	const lines = [];
	let total = 0;
	const pushLine = (line, sourceFile) => {
		const key = `${sourceFile}\u0000${line}`;
		if (picked.has(key)) return;
		const rendered = `${sourceFile.split("/").pop() || sourceFile}｜${line}`;
		if (total + rendered.length + 1 > maxChars) return;
		picked.add(key);
		lines.push(rendered);
		total += rendered.length + 1;
	};
	const relevanceBudget = Math.max(1, Math.floor(maxChars * RELEVANCE_STAGE_SHARE));
	for (const { group, ranked } of scoredGroups.slice(0, DEEP_INJECTION_GROUPS)) for (const item of ranked.slice(0, perDrawingMinLines)) pushLine(item.line, group.sourceFile);
	for (const { group, ranked } of scoredGroups.slice(DEEP_INJECTION_GROUPS)) {
		if (total >= relevanceBudget) break;
		if (ranked[0]) pushLine(ranked[0].line, group.sourceFile);
	}
	const stable = [...scoredGroups].sort((left, right) => left.group.sourceFile < right.group.sourceFile ? -1 : left.group.sourceFile > right.group.sourceFile ? 1 : 0);
	const offset = stable.length > 0 ? parseInt(stableHash(`drawing-coverage:${chapterTitle}`).slice(0, 8), 16) % stable.length : 0;
	for (let step = 0; step < stable.length; step += 1) {
		if (total >= maxChars) break;
		const { group, ranked } = stable[(offset + step) % stable.length];
		if (ranked[0]) pushLine(ranked[0].line, group.sourceFile);
	}
	const remaining = scoredGroups.flatMap(({ group, ranked }) => ranked.map((item) => ({
		...item,
		sourceFile: group.sourceFile
	}))).sort((a, b) => b.score - a.score || a.index - b.index);
	for (const item of remaining) {
		if (total >= maxChars) break;
		pushLine(item.line, item.sourceFile);
	}
	if (lines.length === 0) return "";
	const sourceNames = lock.groups.map((group) => group.sourceFile.split("/").pop() || group.sourceFile);
	return [
		"【图纸事实锁——图纸资料确定性事实（数据来自施工图纸解析，逐项照抄，不得编造或改动）】",
		`图纸来源：${sourceNames.slice(0, 6).join("、")}${sourceNames.length > 6 ? ` 等 ${sourceNames.length} 份` : ""}；本节锁定 ${lines.length} 行（行首为来源图纸名）。`,
		"图纸设计说明、构造做法、材料规格与设备参数是施工依据：给出的规格/配比/做法必须逐项照抄原值；图纸未给的不得自行假设或编造。",
		...lines
	].join("\n");
}
/** 正文归一化（与 token 同口径：去全部空白 + 全角冒号转半角 + 小写；C3-6-4 起导出供修复轮复检共源） */
function normalizeDrawingMatchText(markdown) {
	return markdown.replace(/\s+/gu, "").replace(/：/gu, ":").toLowerCase();
}
/**
* 图纸事实落位判定（引用率验收核心）：正文归一化文本命中该图纸任一 token → 该图纸已引用。
* 可用图纸（有可判定 token）为分母；无可用图纸时 rate 记 1（不适用，无缺陷可判）。
*/
function drawingFactPlacement(lock, markdown) {
	if (!lock || lock.groups.length === 0) return {
		referenced: [],
		unreferenced: [],
		rate: 1
	};
	const normalized = normalizeDrawingMatchText(markdown);
	const referenced = [];
	const unreferenced = [];
	for (const group of lock.groups) if (group.tokens.some((token) => normalized.includes(token))) referenced.push(group);
	else unreferenced.push(group);
	return {
		referenced,
		unreferenced,
		rate: referenced.length / lock.groups.length
	};
}
var DRAWING_FILE_RE, DRAWING_DERIVED_FILE_RE, SPEC_CODE_TOKEN_RE, RATIO_TOKEN_RE, ATLAS_CODE_TOKEN_RE, TABLE_COLUMN_TOKEN_RE, DIMENSION_FRAGMENT_TOKEN_RE, PER_DRAWING_MAX_LINES, FACT_LINE_MIN_CHARS, FACT_LINE_MAX_CHARS, CJK_CHAR_RE, DIGIT_CHAR_RE, SEMANTIC_CJK_MIN, SEMANTIC_CJK_RATIO, FRAGMENT_DIGIT_RATIO_MAX, DEEP_INJECTION_GROUPS, RELEVANCE_STAGE_SHARE;
var init_drawingFactLock = __esmMin((() => {
	init_evidence();
	init_billFactLock();
	init_utils();
	DRAWING_FILE_RE = /dwg|dxf|图纸|施工图|设计图|总平面|平面图|立面图|剖面图|大样图|详图|cad/iu;
	DRAWING_DERIVED_FILE_RE = /图纸目录|设计目录|图纸清单|目录表/u;
	SPEC_CODE_TOKEN_RE = /[A-Za-z]{1,5}\s*[-/]?\s*\d{1,5}(?:\.\d+)?/gu;
	RATIO_TOKEN_RE = /\d+\s*[:：]\s*\d+(?:\.\d+)?/gu;
	ATLAS_CODE_TOKEN_RE = /(?<![\d.])\d{2}\s*[A-Za-z]{1,3}\s*\d{2,4}(?:\s*[-—]\s*\d{1,3})?/gu;
	TABLE_COLUMN_TOKEN_RE = /^col\d+$/u;
	DIMENSION_FRAGMENT_TOKEN_RE = /^x\d+$/u;
	PER_DRAWING_MAX_LINES = 400;
	FACT_LINE_MIN_CHARS = 8;
	FACT_LINE_MAX_CHARS = 300;
	CJK_CHAR_RE = /[\u4e00-\u9fff]/gu;
	DIGIT_CHAR_RE = /\d/gu;
	SEMANTIC_CJK_MIN = 2;
	SEMANTIC_CJK_RATIO = .15;
	FRAGMENT_DIGIT_RATIO_MAX = .25;
	DEEP_INJECTION_GROUPS = 6;
	RELEVANCE_STAGE_SHARE = .55;
})), DEFAULT_FACT_FIELDS, COMMON_FORBIDDEN_PATTERNS, COMMON_DIAGNOSTIC_PATTERNS, COMMON_LOW_CONFIDENCE_PATTERNS, DEFAULT_DOCUMENT_DOMAIN_PROFILE;
var init_documentDomainProfileService = __esmMin((() => {
	DEFAULT_FACT_FIELDS = [
		{
			id: "document_identity",
			name: "对象名称",
			aliases: [
				"项目名称",
				"工程名称",
				"文档名称",
				"任务名称",
				"招标项目名称",
				"建设项目名称"
			],
			category: "identity",
			cardinality: "single",
			derivationPolicy: "source_only",
			usagePolicy: "must_use",
			confidencePolicy: {
				minForGeneration: .75,
				minForValidation: .85,
				allowPathOnly: false
			},
			conflictPolicy: "strict"
		},
		{
			id: "schedule_requirement",
			name: "周期要求",
			aliases: [
				"计划工期",
				"工期",
				"周期要求",
				"进度节点要求",
				"开工日期",
				"竣工日期"
			],
			category: "schedule",
			cardinality: "single",
			derivationPolicy: "source_only",
			usagePolicy: "must_use",
			confidencePolicy: {
				minForGeneration: .7,
				minForValidation: .8,
				allowPathOnly: false
			},
			conflictPolicy: "strict"
		},
		{
			id: "quality_requirement",
			name: "质量要求",
			aliases: [
				"质量要求",
				"质量标准",
				"验收要求",
				"评价标准"
			],
			category: "quality",
			cardinality: "multiple",
			derivationPolicy: "source_only",
			usagePolicy: "use_if_relevant",
			confidencePolicy: {
				minForGeneration: .65,
				minForValidation: .75,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		},
		{
			id: "safety_requirement",
			name: "安全合规要求",
			aliases: [
				"安全要求",
				"安全合规要求",
				"风险控制要求",
				"合规要求"
			],
			category: "safety",
			cardinality: "multiple",
			derivationPolicy: "source_only",
			usagePolicy: "use_if_relevant",
			confidencePolicy: {
				minForGeneration: .65,
				minForValidation: .75,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		},
		{
			id: "technical_parameter",
			name: "技术参数",
			aliases: [
				"技术参数",
				"参数规格范围",
				"规格",
				"型号",
				"尺寸",
				"标准编号",
				"材料设备"
			],
			category: "technical",
			cardinality: "multiple",
			derivationPolicy: "source_only",
			usagePolicy: "must_use",
			confidencePolicy: {
				minForGeneration: .7,
				minForValidation: .8,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		},
		{
			id: "resource_plan",
			name: "资源配置",
			aliases: [
				"劳动力",
				"机械",
				"检测设备",
				"应急物资",
				"资源配置",
				"人员配置"
			],
			category: "resource",
			cardinality: "multiple",
			derivationPolicy: "plan_inferable",
			usagePolicy: "use_if_relevant",
			confidencePolicy: {
				minForGeneration: .45,
				minForValidation: .55,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		},
		{
			id: "commercial_data",
			name: "商务数据",
			aliases: [
				"报价",
				"单价",
				"合价",
				"综合单价",
				"预留金",
				"税率",
				"金额",
				"利润"
			],
			category: "commercial",
			cardinality: "multiple",
			derivationPolicy: "forbidden",
			usagePolicy: "do_not_use",
			confidencePolicy: {
				minForGeneration: 1,
				minForValidation: 1,
				allowPathOnly: false
			},
			conflictPolicy: "ignore"
		},
		{
			id: "rule_requirement",
			name: "规则要求",
			aliases: [
				"规则要求",
				"变更说明",
				"实施范围",
				"对象范围",
				"结构化数据范围"
			],
			category: "compliance",
			cardinality: "multiple",
			derivationPolicy: "source_only",
			usagePolicy: "use_if_relevant",
			confidencePolicy: {
				minForGeneration: .6,
				minForValidation: .7,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		}
	];
	COMMON_FORBIDDEN_PATTERNS = [/投标报价|报价明细|单价|合价|综合单价|预留金|暂列金额|税率|增值税|利润|结算/u];
	COMMON_DIAGNOSTIC_PATTERNS = [
		/OCR|识别错误|乱码|无法确认|疑似|不确定|绑定片段|兜底|知识库|提示词|后台|文件路径|PDF|DWG|Excel/u,
		/^#+\s*/u,
		/^见(?:招标|投标人|前附|补疑|图纸|清单|文件|资料|公告|须知)/u
	];
	COMMON_LOW_CONFIDENCE_PATTERNS = [/无法确认|疑似|不确定|需复核|文字模糊|语义断裂|识别错误|乱码/u];
	DEFAULT_DOCUMENT_DOMAIN_PROFILE = {
		id: "default_general_document",
		name: "通用文档",
		factFields: DEFAULT_FACT_FIELDS,
		forbiddenValuePatterns: COMMON_FORBIDDEN_PATTERNS,
		diagnosticValuePatterns: COMMON_DIAGNOSTIC_PATTERNS,
		lowConfidenceValuePatterns: COMMON_LOW_CONFIDENCE_PATTERNS
	};
	({ ...DEFAULT_DOCUMENT_DOMAIN_PROFILE });
}));
//#endregion
//#region apps/server/src/services/document-workflow/evidenceContentSafety.ts
var init_evidenceContentSafety = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	init_outline$1();
}));
//#endregion
//#region apps/server/src/services/document-workflow/factsModel.ts
function normalizeOcrFactText(text) {
	return stringifyFactValue(text).replace(/[\u00A0\u2002-\u200B\u3000]/gu, " ").replace(/([\p{Script=Han}])\s+([\p{Script=Han}])/gu, "$1$2").replace(/(\d)\s+(日历天|天|个月|月|年|万元|元|㎡|平方米|米|m|mm|MPa|kPa|%)/giu, "$1$2").replace(/(合同|投资|工程|项目)\s*估\s*算\s*(?:价格|价)/gu, "$1估算价").replace(/计划\s*工\s*期/gu, "计划工期").replace(/合同\s*工\s*期/gu, "合同工期").replace(/质量\s*标\s*准/gu, "质量标准").replace(/建设\s*地\s*点/gu, "建设地点").replace(/建设\s*规\s*模/gu, "建设规模").replace(/招标\s*范\s*围/gu, "招标范围").replace(/最高\s*投\s*标\s*限\s*价/gu, "最高投标限价").replace(/招标\s*控\s*制\s*价/gu, "招标控制价").replace(/[：:]\s*/gu, "：").replace(/\s+/gu, " ").trim();
}
function factText(fact) {
	return `${fact.key} ${fact.fieldName || ""} ${fact.value} ${fact.roleId} ${fact.processingType || ""} ${fact.sourceFile}`;
}
function isProjectBasicCommercialFact(text) {
	return /合同估算价|合同估算价格|投资估算|估算价格|工程估算价|项目估算价|最高投标限价|招标控制价/u.test(text);
}
/** 商务域事实排除（生成侧零写入红线单源；导出供 chapterParameterFacts C-T6 消费侧二次兜底） */
function isGenerationExcludedFact(fact) {
	const text = factText(fact);
	if (isProjectBasicCommercialFact(text)) return false;
	return /投标保证金|发票类型|开标时间|公共资源交易监督管理|不良行为记录|投诉举报|资质投诉|投标承诺|违约金|中标服务费|交易平台|保证金账户|投标有效期|报价明细|投标报价|单价|合价|税率|增值税|利润|结算/u.test(text);
}
var init_factsModel = __esmMin((() => {
	init_kbService();
	init_documentDomainProfileService();
	init_factMatching();
	init_llmClient();
	init_utils();
	init_semanticSimilarity();
	init_evidenceContentSafety();
})), SUPPORT_FORM_LEXICON;
var init_factGovernance = __esmMin((() => {
	init_factsModel();
	init_workflowRules();
	SUPPORT_FORM_LEXICON = [
		{
			pattern: /土钉/u,
			form: "土钉墙"
		},
		{
			pattern: /锚杆|锚索/u,
			form: "锚杆支护"
		},
		{
			pattern: /喷锚/u,
			form: "喷锚支护"
		},
		{
			pattern: /放坡/u,
			form: "放坡开挖"
		},
		{
			pattern: /地下连续墙/u,
			form: "地下连续墙"
		},
		{
			pattern: /支护桩/u,
			form: "支护桩"
		}
	];
	new RegExp(SUPPORT_FORM_LEXICON.map((item) => item.pattern.source).join("|"), "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/sectionFingerprint.ts
var init_sectionFingerprint = __esmMin((() => {
	init_outline$1();
}));
//#endregion
//#region apps/server/src/services/document-workflow/sectionNamingGovernance.ts
var init_sectionNamingGovernance = __esmMin((() => {
	init_llmClient();
	init_outline$1();
	init_markdownComposer();
	init_sectionFingerprint();
}));
var init_promptRuleExtraction = __esmMin((() => {
	init_budget();
	init_evidence();
	init_llmClient();
	init_outline$1();
	init_markdownComposer();
	init_sectionNamingGovernance();
	init_sectionFingerprint();
}));
//#endregion
//#region apps/server/src/services/document-workflow/bidComposition.ts
/** 勾选标记双形态：标记在词前（「☑暗标」）与词后（「暗标（√）」——两种排版写法均存在） */
function markPatterns(word) {
	const chars = [...word];
	const inner = `${chars[0]}\\s*${chars[1]}`;
	return [new RegExp(`${CHECK_MARK}${MARK_GAP}${inner}`, "u"), new RegExp(`${inner}${MARK_GAP}${CHECK_MARK}`, "u")];
}
var CHECK_MARK, MARK_GAP;
var init_bidComposition = __esmMin((() => {
	init_promptRuleExtraction();
	CHECK_MARK = "[☑√✔✓■●◼☒⊠▣]";
	MARK_GAP = "[\\uFE0E\\uFE0F\\s（）()【】\\[\\]〔〕]*";
	markPatterns("暗标");
	markPatterns("明标");
})), EQUIPMENT_NAME_SUFFIX_SOURCE;
var init_resourceBreakdownNumbers = __esmMin((() => {
	EQUIPMENT_NAME_SUFFIX_SOURCE = "机|吊|泵|车|夯";
	new RegExp(`([\\p{Script=Han}A-Za-z0-9]{2,8}(?:${EQUIPMENT_NAME_SUFFIX_SOURCE}))$`, "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/tenderBidChecks.ts
var init_tenderBidChecks = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/evidenceRetrieval.ts
var init_evidenceRetrieval = __esmMin((() => {
	init_evidence();
	init_factsModel();
	init_projectBasicInfo();
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/factCoverage.ts
var init_factCoverage = __esmMin((() => {
	init_factsModel();
	init_projectBasicInfo();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterPostProcessing.ts
var init_chapterPostProcessing = __esmMin((() => {
	init_evidence();
	init_factsModel();
	init_outline$1();
	init_writingSpec();
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/diagnostics.ts
var init_diagnostics = __esmMin((() => {
	init_templateStore();
	init_chapterPostProcessing();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentGeneratorHelpers.ts
var init_documentGeneratorHelpers = __esmMin((() => {
	init_evidenceRetrieval();
	init_factCoverage();
	init_projectBasicInfo();
	init_markdownCleanup();
	init_diagnostics();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integrity/fixers/fixers.ts
var init_fixers = __esmMin((() => {
	init_constants();
	init_integratedBlueprint();
	init_detectors();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentIntegrityChecks.ts
var init_documentIntegrityChecks = __esmMin((() => {
	init_utils();
	init_detectors();
	init_fixers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/internalTerminologyAnchors.ts
var INTERNAL_TERM_EXACT_RE;
var init_internalTerminologyAnchors = __esmMin((() => {
	init_semanticSimilarity();
	INTERNAL_TERM_EXACT_RE = /工作包|事实卡|事实主表|后台数据库|落位|峰值口径|控制口径|数据口径/gu;
}));
//#endregion
//#region apps/server/src/services/document-workflow/poolNoise.ts
/** 行结构判定（须用原文换行，不能先做空白归一） */
function looksTabularFragmented(raw) {
	const rows = raw.split(/\r?\n/u).map((row) => row.trim()).filter(Boolean);
	if (rows.length < TABULAR_MIN_ROWS) return false;
	if (rows.filter((row) => row.replace(/\s+/gu, "").length <= TABULAR_FRAGMENT_ROW_MAX).length < 2) return false;
	return rows.some((row) => TABULAR_PURE_NUMBER_ROW_RE.test(row));
}
/** 图签特征命中计数（含 g flag 的 match 无 lastIndex 状态污染） */
function countDrawingSignatureHits(text) {
	return (text.match(DRAWING_SIGNATURE_SCAN_RE) || []).length;
}
/**
* 池噪声判定（要求池/参数池同源单源）：命中返回分类标签，未命中返回 undefined。
* 判据顺序：坐标（最强形态）→ 表格残片 → 图签（命中特征且无约束词）→
* 编号粘连族（值首数字串/章节号打头/OCR 零串/表号标号）→ 表单占位 → 孤立日期 →
* 日期时间粘连 → 目录行 → 超长罗列值。
*/
function classifyPoolNoiseText(text) {
	const raw = String(text || "");
	const normalized = raw.replace(/\s+/gu, "");
	if (normalized.length < 3) return void 0;
	const hasConstraint = POOL_CONSTRAINT_WORD_RE.test(normalized);
	if (SHEET_COORDINATE_RE.test(normalized)) return "sheet_coordinate";
	if (TABLE_FRAGMENT_RE.test(normalized) && (!hasConstraint || /CHECKE|SUBITEM/u.test(normalized))) return "table_fragment";
	if (looksTabularFragmented(raw)) return "table_fragment";
	if (countDrawingSignatureHits(normalized) >= 1 && !hasConstraint) return "drawing_signature";
	if (NUMERIC_SMEAR_RE.test(normalized)) return "numeric_smear";
	if (SECTION_NUMBER_HEAD_RE.test(normalized)) return "numeric_smear";
	if (OCR_ZERO_SMEAR_RE.test(normalized)) return "numeric_smear";
	if (INDEX_LABEL_RE.test(normalized)) return "numeric_smear";
	if (FORM_PLACEHOLDER_RE.test(normalized)) return "table_fragment";
	if (DATETIME_SMEAR_RE.test(normalized)) return "table_fragment";
	if (DATE_FRAGMENT_RE.test(normalized)) return "date_fragment";
	if (TOC_LINE_RE.test(normalized)) return "toc_line";
	if (normalized.length > LONG_VALUE_MAX && !VALUE_PUNCTUATION_RE.test(normalized) && LONG_VALUE_LATIN_RE.test(normalized)) return "listing_smear";
}
var POOL_CONSTRAINT_WORD_RE, TOC_LINE_RE, DRAWING_SIGNATURE_PATTERN, DRAWING_SIGNATURE_SCAN_RE, SHEET_COORDINATE_RE, TABLE_FRAGMENT_RE, TABULAR_MIN_ROWS, TABULAR_FRAGMENT_ROW_MAX, TABULAR_PURE_NUMBER_ROW_RE, NUMERIC_SMEAR_RE, SECTION_NUMBER_HEAD_RE, OCR_ZERO_SMEAR_RE, INDEX_LABEL_RE, FORM_PLACEHOLDER_RE, DATE_FRAGMENT_RE, DATETIME_SMEAR_RE, LONG_VALUE_MAX, LONG_VALUE_LATIN_RE, VALUE_PUNCTUATION_RE;
var init_poolNoise = __esmMin((() => {
	POOL_CONSTRAINT_WORD_RE = /(?:确保|保证|达到|满足|符合|不低于|不超过|不得|禁止|严禁|必须|应当|须|应按|执行|遵守|落实|实施|采用|提供|提交|出具|配备|设置|建立|安装|配置|负责|完成|参加|组织|验收|检测|检验|控制|管理|保护|防止|杜绝|承诺|响应|要求|规定|标准|等级|目标|措施|方案|制度|计划|工期|质量|安全)/u;
	TOC_LINE_RE = /^[（(]?[一二三四五六七八九十百\d]{1,3}[、.．)）]\s*[^\n]{2,60}(?:\.{4,}|…{3,})\s*\d{0,4}\s*$/u;
	DRAWING_SIGNATURE_PATTERN = "专用章|出图|设计研究总院|工程设计(?:甲|乙|丙)级|资质证书|证书编号";
	new RegExp(DRAWING_SIGNATURE_PATTERN, "u");
	DRAWING_SIGNATURE_SCAN_RE = new RegExp(DRAWING_SIGNATURE_PATTERN, "gu");
	SHEET_COORDINATE_RE = /R\d{1,4}C\d{1,4}/u;
	TABLE_FRAGMENT_RE = /CHECKE|SUBITEM|子项名称/u;
	TABULAR_MIN_ROWS = 3;
	TABULAR_FRAGMENT_ROW_MAX = 8;
	TABULAR_PURE_NUMBER_ROW_RE = /^[\d.．、()（）\s/／-]{1,16}$/u;
	NUMERIC_SMEAR_RE = /^\d{5,}[\u4e00-\u9fa5]/u;
	SECTION_NUMBER_HEAD_RE = /^[1-9]\d?(?:\.\d{1,2}){2,}[^\d\s]{0,4}$/u;
	OCR_ZERO_SMEAR_RE = /^0{3,}[A-Za-z]?$/u;
	INDEX_LABEL_RE = /^(?![MC]\d)(?![Mm][BbSs]?\d)(?![Ll][Cc]?\d)(?![Aa]\d)(?![Dd][Pp]\d)[A-Za-z]{1,4}\d{0,3}\.\d{1,3}$/u;
	FORM_PLACEHOLDER_RE = /（签章）|\(签章\)|年月日|[:：]\s*[/／]\s*$/u;
	DATE_FRAGMENT_RE = /^(?:\d{4}年|\d{1,2}月)$/u;
	DATETIME_SMEAR_RE = /\d{4}\.\d{1,2}\.\d{3,}/u;
	LONG_VALUE_MAX = 60;
	LONG_VALUE_LATIN_RE = /[A-Za-z]{3,}|[A-Za-z]{1,3}\d{2,}|\d{6,}/u;
	VALUE_PUNCTUATION_RE = /[，。；,;]/u;
}));
//#endregion
//#region apps/server/src/services/document-workflow/tenderRequirements.ts
/**
* 要求池纯度复核（r28h M10 实机归因，单项目未响应条目分型统计后提取的形态判据）：
* 以下形态属投标/合同/考核程序与澄清信息，不是施组应逐条响应的施工义务——LLM 判定层漏判时本地确定性纠正
* （与 isContractProcedureClause 同层接线，reason=non_requirement）：
* ① 答疑澄清（「回复：/答复：」标记）——招标答疑文件的答复条目（含做法/量价澄清），信息经事实/参数池承接，
*    响应义务不成立（s28h2 实测约 1/4 未响应条目）；
* ② 履约考核惩奖细则（扣N分/百分制/考核评分·结果·得分·扣分·奖惩）——养护/履约考核办法条款
*    （s28h2 实测约 1/3；「安全技术考核」「考核合格证书」类施工语境不命中）；
* ③ 质量保修条款（保修范围/派人保修/保修通知）——竣工后合同义务，非施组响应域；
* ④ 投标程序与表单（本表填报说明/投标文件响应程序/拟派承诺/拟分包情况表）——投标文件格式要求；
* ⑤ 勾选表单行（条款首部带编号前缀的「☑」填报项，如「☑本工程采用商品砼」「1.2 ☑本工程采用商品砼」）
*    ——工程信息填报非义务条款；行首 8 字符内限编号/括号/顿点类前缀，正文中间出现的 ☑ 不命中。
*
* D6 池净化扩围（s28l/r28l 实机归因）：图纸图签栏/清单行列坐标/PDF 目录点串行/OCR 表格残片/编号粘连
* ——解析产物结构噪声混入要求池后永久无法锚定正文（锚点命中率被人为拉低且误导修复方向），
* 与参数池同源判定（poolNoise.classifyPoolNoiseText）。命中条目在判定层以 reason='noise' 出池（只出池
* 不删档：保留在 excluded 审计数组），上层据类别对账。
*/
function isRequirementPoolNoiseClause(text) {
	const normalized = text.trim().replace(/\s+/gu, "");
	if (!normalized) return false;
	if (/(?:回复|答复)[:：]/u.test(normalized)) return true;
	if (/扣\d+(?:\.\d+)?分|总分\d+分|百分制|考核(?:办法|评分|结果|得分|扣分|奖惩)/u.test(normalized)) return true;
	if (/质量保修|保修范围|派人保修|保修通知|保修期如下/u.test(normalized)) return true;
	if (/本表(?:应|须|不|需|作)/u.test(normalized)) return true;
	if (/投标文件(?:应|须|应当)[^。；]{0,40}(?:响应|作出响应|包含|包括)/u.test(normalized)) return true;
	if (/我方拟派|无在岗项目|拟分包项目情况表/u.test(normalized)) return true;
	if (/^[（(、.．\d]{0,8}☑/u.test(normalized)) return true;
	if (classifyPoolNoiseText(normalized)) return true;
	return false;
}
/**
* M26 文件引用型核心词判定（要求锚点实机归因之根因 B2）：文号（〔20XX〕N号）或行政文件名
* （办法/通知/规定/条例/细则结尾）是「依据引用」——正文按 M20 方向写制度应用，不逐字复现文号/全称；
* 条款 coreTerms 全为该类词时无正文可锚定内容 → 出池（引用性条款）。词尾限行政文件类，
* 「规范/标准/制度」为技术/管理词不入（防「工程质量标准」「技术规范」类实质要求误出池）。
*/
function isDocumentReferenceTerm(term) {
	const clean = term.replace(/\s+/gu, "");
	if (clean.length < 4) return false;
	return /〔\d{4}〕/u.test(clean) || /(?:办法|通知|规定|条例|细则)$/u.test(clean);
}
/**
* 剥离奖项名前导动词/承诺词（"为争创黄山杯"→"黄山杯"），循环剥离直至稳定。
* requirementAnchorCoverage 与奖项杜撰检测共用，保证锚点提取口径一致
* （具名奖项正则贪婪会吞入前导动词，如"确保黄山杯"整体成锚，与 coreTerms"黄山杯"口径分裂导致误报）。
*/
function stripAwardLeadVerb(award) {
	let result = award;
	for (;;) {
		const stripped = result.replace(/^(?:争创|争取|力争|争获|确保|获得|创建|力创|评为|荣获|标为|目标为|承诺|为)/u, "");
		if (stripped === result || !stripped) break;
		result = stripped;
	}
	return result;
}
/** 全角百分号归一（M26：s28k 正文写作半角「95%/10%」，锚点提取全角「95％/10％」→ 全半角形态差假 miss）：
* 锚点侧与正文侧同源归一——requirementAnchorCoverage（锚）、clauseSegmentCoverage（分句）、
* tenderRequirementResponseGaps 与 requirementAcceptanceIssues（正文入口）四处统一，防口径分裂。 */
function normalizePercent(text) {
	return text.replace(/％/gu, "%");
}
/**
* 锚点等价命中判定（r8 实机 #4 复核）：「0.25-0.5m宽」类范围复合锚点，正文写作
* 「0.25～0.5m」「0.25~0.5m」或省后缀「预留0.25-0.5m」时字面 includes 因连接符/
* 后缀差异失配 → 假部分响应。范围锚点降级为「两端数字均出现即命中」（范围数字组合
* 巧合概率极低）；非范围锚点维持字面包含（不放宽）。
*/
function anchorHit(anchor, normalizedMarkdown) {
	if (normalizedMarkdown.includes(anchor)) return true;
	const range = anchor.match(/(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)/u);
	if (!range) return false;
	return normalizedMarkdown.includes(range[1]) && normalizedMarkdown.includes(range[2]);
}
/**
* 条款锚点全清单（写作卡下发 / 覆盖判定 / 修复缺口反馈单源）：条款内全部关键锚点——
* ① coreTerms 专有名词（≥2 字；引用性词过滤——文号/行政文件名不作锚点，正文按制度应用写不逐字复现；
*    含数字复合词分解——「一次性成活率95%」→「一次性成活率」+「95%」，正文自然写作常被数量词分隔，
*    整串字面匹配假 miss）；
* ② 「数字+单位」组合（纯数字不作锚点；「N.N项」编号切片守卫）；
* ③ 具名奖项/等级（stripAwardLeadVerb 剥离前导动词）。
*/
function collectRequirementAnchors(item, options) {
	const text = normalizePercent(item.text.replace(/\s+/gu, ""));
	const anchors = /* @__PURE__ */ new Set();
	for (const term of item.coreTerms) {
		const clean = normalizePercent(term.replace(/\s+/gu, ""));
		if (clean.length < 2) continue;
		if (isDocumentReferenceTerm(clean)) continue;
		const compound = clean.match(/^(.*?)(\d+(?:\.\d+)?(?:%|％)?)$/u);
		if (compound && compound[1].length >= 2) {
			anchors.add(compound[1]);
			anchors.add(compound[2]);
			continue;
		}
		anchors.add(clean);
	}
	if (!options?.skipNumericAnchors) for (const match of text.matchAll(/(?:\d+(?:\.\d+)?\s*(?:%|％|天|日|万元|亿元|元|米|m|M|mm|毫米|层|年|个|月|周|小时|分钟|项|处|台|套|辆|人|家|次|遍|道|吨|kPa|MPa))/giu)) {
		const anchorText = normalizePercent(match[0].replace(/\s+/gu, ""));
		if (/^\d+\.\d+项$/u.test(anchorText)) continue;
		anchors.add(anchorText);
	}
	for (const match of text.matchAll(/[\u4e00-\u9fa5]{2,6}[杯奖星]/gu)) {
		const award = stripAwardLeadVerb(match[0]);
		if (/^[\u4e00-\u9fa5]{2,7}$/u.test(award)) anchors.add(award);
	}
	return [...anchors];
}
/**
* 条款锚点覆盖判定（300万缺失根治）：条款内全部关键锚点（每个 coreTerms 专有名词、每个"数字+单位"、
* 每个具名奖项/等级）必须各自字面命中正文。字面兜底保留（黄山杯实测 bge 0.50 < 0.6 被误报零响应），
* 升级为锚点全覆盖：全部命中才算完全响应，部分命中报"部分响应"定向补写缺失锚点。
* 锚点集合构建单源（collectRequirementAnchors，与写作卡下发同源）。
*/
function requirementAnchorCoverage(item, normalizedMarkdown, options) {
	const anchors = collectRequirementAnchors(item, options);
	const hit = [];
	const missing = [];
	for (const anchor of anchors) (anchorHit(anchor, normalizedMarkdown) ? hit : missing).push(anchor);
	return {
		total: anchors.length,
		hit,
		missing
	};
}
/**
* 条款原文分句兜底（B 闭环终收尾 4.27.1）：锚点判定用 coreTerms（LLM 概括短语）与正文抄写句
* （「按招标文件要求：<条款原文>」）存在词面错位——分句兜底：条款去括号举例后按标点切分为实质分句
* （≥6 字符），全部分句字面落位正文 = 原文抄写 = 完全响应。防误放行：全部分句命中才放行。
*/
function clauseSegmentCoverage(text, normalizedMarkdown) {
	const segments = normalizePercent(text).replace(/（[^）]*）|\([^)]*\)/gu, "").split(/[，。；、,;\n]/u).map((segment) => segment.replace(/[「」“”"'`\s]/gu, "").trim()).filter((segment) => segment.length >= 6);
	const missing = segments.filter((segment) => !normalizedMarkdown.includes(segment));
	return {
		total: segments.length,
		missing
	};
}
/**
* 投标人口吻转换（4.27.2 语气泄漏治理 · P0）：条款抄写句中的第三人称指代改为投标人口吻——
* 「承包人/投标人/施工单位/承包方/中标人」→「我方」；「投标人本单位」→「本公司」；
* 「本招标项目」→「本项目」；「发包人认为视同」→「视为」；招标文件表格勾选标记（☑√■等，
* r11：前附表资格条款「☑具备…」随提取进入条款原文，不做清洗则补写插入句把模板符号带进正文）。
* 转换三端同源：补写句生成、检测端 voice 分句兜底、交付前元语言清理器（fixTenderMetaLanguage）。
* 导出供要求响应补写轮（requirementResponseRepair）生成定向补写素材。
*/
function bidderVoiceClauseText(text) {
	return text.replace(/[☑☐☒√✓✔×✗■●◼⊠]\s*/gu, "").replace(/投标人本单位|承包人本单位/gu, "本公司").replace(/本招标项目/gu, "本项目").replace(/(?:承包人|发包人)认为视同/gu, "视为").replace(/承包人|投标人|施工单位|承包方|中标人|承包单位|投标单位/gu, "我方");
}
/**
* 条款响应满足判定（检测/补写共享单源）：
* ①锚点全覆盖（coreTerms/数字/奖项字面命中）或 ②条款原文分句全落位（原样抄写句）或
* ③投标人口吻转换后分句全落位（voice 改造后的补写句形态）→ 已满足。
* 历史缺陷（重复补写根因）：各补写器判定口径不一致——stage5 写入的 voice 补写句
* 在终检「锚点全覆盖」口径下不可见 → 重复补写。各端共用本谓词：检测放行、补写幂等严格同源。
*/
function clauseSatisfied(item, normalizedMarkdown) {
	const coverage = requirementAnchorCoverage(item, normalizedMarkdown);
	if (coverage.total > 0 && coverage.missing.length === 0) return true;
	const segmentCoverage = clauseSegmentCoverage(item.text, normalizedMarkdown);
	if (segmentCoverage.total > 0 && segmentCoverage.missing.length === 0) return true;
	const voiceCoverage = clauseSegmentCoverage(bidderVoiceClauseText(item.text), normalizedMarkdown);
	if (voiceCoverage.total > 0 && voiceCoverage.missing.length === 0) return true;
	return false;
}
/**
* 要求响应复检（确定性三通道，修复轮专用包装）：对给定条目逐条判定当前 markdown 中的响应状态
* （命中/缺失锚点 + 是否已满足），与 clauseSatisfied 严格同源——要求响应补写轮
* （requirementResponseRepair）的修复前定位与修复后收敛复检共用本口径。
*/
function tenderRequirementResponseGaps(entries, markdown) {
	const normalized = normalizePercent(markdown.replace(/\s+/gu, ""));
	return entries.map((entry) => {
		const coverage = requirementAnchorCoverage(entry, normalized);
		return {
			entry,
			hit: coverage.hit,
			missing: coverage.missing,
			satisfied: clauseSatisfied(entry, normalized)
		};
	});
}
var init_tenderRequirements = __esmMin((() => {
	init_llmClient();
	init_generatedDocumentService();
	init_factsModel();
	init_evidenceContentSafety();
	init_markdownComposer();
	init_poolNoise();
	[
		docSystemPrefix("你是招标文件条款判定器。"),
		"输入是从招标资料（招标文件/补疑/答疑等）中按原文顺序切分的条款单元（含全局序号与来源）。",
		"对每一条独立完成判定，且必须为每一条给出结果（不得遗漏任何序号）。",
		"",
		"1. isRequirement：该条是否构成对投标人的实质要求（需写入正文响应或必须遵守）？",
		"   - true：明确的目标/等级/标准/参数/义务/禁止性要求（确保、达到、不低于、不得、严禁、必须、应当等约束语义）",
		"   - false：目录、章节导语、说明性/解释性文字、空白表头、格式模板、无约束力的描述",
		"   - 边界判例（格式模板 vs 结构呈现要求）：表格填写/签章格式/装订份数类模板说明 → false；",
		"     「组织机构以框图方式表示」「采用文字并结合图表形式编制」「附网络图、横道图」等呈现形态要求 → true（呈现信息同时进入 structures 通道）",
		"   - 孤立碎片（无问题上下文的「回复：××」「答：××」、表格残片、无法独立理解的半截句）→ false（reason=\"non_requirement\"）",
		"   - 问答对（「问题：×× … 回复：××」）：答复含实质要求（指标/标准/义务/禁止性内容）→ true（按答复内容给出 policy/coreTerms）；纯程序性答复（「按招标文件执行」「详见补遗」）→ false",
		"   - 条款值被明确标注「无」「☑无」「不适用」「/」时 → isRequirement=false（reason=\"no_value\"）",
		"   - 工程量清单条目、项目特征描述、工程量数据不是本通道要求（由清单蓝图通道处理）→ false",
		"2. inScope：该条是否属于施工组织设计正文的职责范围？",
		"   - true：质量/工期/安全/环保目标、创优奖项、绿色建筑/智慧工地/装配式等级、体系基准（六个百分百/四节一环保等）、",
		"     工期与进度约束、人员配置与分包限制、材料工艺与验收标准、禁止性事项、必须遵守的技术约束",
		"   - false：纯投标程序事务（开标时间地点/保证金账户信息/递交解密方式/评标委员会组成）、投标资格条件",
		"     （营业执照/资质证书/业绩要求）、评标否决规则（否决其投标/废标情形）、商务纪律承诺（廉洁承诺）、格式签章要求、",
		"     商务与造价条款（付款/进度款/工程款/结算/保证金/违约金/保函/预付款/税金/税率/报价/综合单价/暂列金额/暂估价/限价/调差等，",
		"     属商务标响应内容，技术标正文不出现）、",
		"     合同履约管理程序条款（施工合同通用/专用条款及合同附件的程序性与责任性约定：资料报送/审批/备案期限、",
		"     违约责任与违约金罚款明细、人员请假/更换/离场批准程序、保险投保办理程序、工程质量保修书程序与保修期限明细、",
		"     试验条件自理、工程照管责任起止、治安保卫程序、分包审批程序、采购与评标程序——属合同管理范畴，技术标正文不逐条抄写；",
		"     但质量/安全/文明/工期目标、人员资格与配置、技术工艺与验收标准类实质要求仍按 true 判定）",
		"3. policy（isRequirement 且 inScope 时必填，其余省略）：",
		"   - \"respond\"：必须在正文显性写出的要求（创优目标/奖项、质量目标、等级指标、体系基准、技术工艺条款、人员与分包约束、验收标准）",
		"   - \"comply\"：不逐条抄写但全文必须遵守的约束（以开工令为准的日期约束、工期总日历天数基准、全局禁止性事项）",
		"4. coreTerms：2-4 个用于正文核对的核心词（专有名词/等级名/体系名/关键数字参数，如「××杯」「二星级」「六个百分百」「300万元」）；",
		"   数字参数必须保留数字与单位；不要泛化词（「施工」「工程」类不能作为核心词）；",
		"   必须是正文中可自然逐字出现的完整词/短语（括号/标点保持原文形态），不得使用去标点拼接的短语碎片或合同填空语言（如「承包人自理」）",
		"5. category：按招标语义命名类别（如「质量创优」「工期进度」「安全文明」「绿色施工」「人员管理」「商务支付」「禁止性要求」），",
		"   同类要求使用同一类别名",
		"6. structures：该条是否明文要求内容的呈现形态？命中时输出数组（element 呈现对象名 + form 形态），无呈现要求时省略该字段：",
		"   - form 枚举：“org_chart”（框图/组织机构图/组织结构图）、“diagram”（网络图/横道图/平面布置图/进度计划图）、“table”（表格/组成表）、“chart_text”（文字结合图表/图表形式编制）",
		"   - element：呈现对象的名词短语（如「项目管理机构」「施工总平面布置」「施工进度计划」），不得与原文无关",
		"   - 边界判例：「组织机构以框图方式表示」→ [{element:\"项目管理机构\",form:\"org_chart\"}]；「采用文字并结合图表形式编制」→ [{element:\"施工组织设计\",form:\"chart_text\"}]；",
		"     纯格式填写说明/签章装订要求（按给定格式填写并盖章/正副本份数）→ 不输出 structures",
		"   - 呈现要求与 isRequirement/inScope 判定相互独立：即使本条因程序/格式原因被判排除，structures 仍须输出",
		"",
		"isRequirement=false 或 inScope=false 时须给出 reason（枚举）：",
		"- \"non_requirement\"：非约束性内容（目录/导语/说明/描述）",
		"- \"out_of_scope\"：超出施组职责（投标程序/资格/评标规则/纪律/格式/商务与造价/合同履约管理程序）",
		"- \"no_value\"：条款值为「无」或不适用",
		"",
		"输出 JSON 结构（覆盖全部序号，每序号必出结果）：",
		"{ \"results\": [",
		"  { \"index\": 0, \"isRequirement\": true, \"inScope\": true, \"policy\": \"respond\", \"coreTerms\": [\"××杯\", \"300万元\"], \"category\": \"质量创优\" },",
		"  { \"index\": 1, \"isRequirement\": false, \"inScope\": false, \"reason\": \"out_of_scope\" },",
		"  { \"index\": 2, \"isRequirement\": false, \"inScope\": false, \"reason\": \"out_of_scope\", \"structures\": [{ \"element\": \"项目管理机构\", \"form\": \"org_chart\" }] }",
		"] }",
		"只返回 JSON。"
	].join("\n");
	[
		docSystemPrefix("你是招标要求章责分配器。"),
		"输入是语义路由置信度偏低的技术标要求条目与本文档全部章节标题列表。",
		"为每条要求裁决其唯一主责章节（写该章节正文时必须响应此要求），逐条必出结果（不得遗漏序号）。",
		"",
		"- chapter：从章节标题列表中选择内容最匹配的一项，必须与列表原文逐字一致",
		"- chapter 填 \"none\"：该条不是可写入技术标正文的实质要求（无问题上下文的残片/客套答复/程序性说明），或没有任何章节能承载其内容",
		"",
		"输出 JSON：{ \"results\": [ { \"index\": 0, \"chapter\": \"章节标题或none\" } ] }，只返回 JSON。"
	].join("\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/deterministicFixChains.ts
var init_deterministicFixChains = __esmMin((() => {
	init_documentIntegrityChecks();
	init_resourceBreakdownNumbers();
	init_markdownComposer();
	init_internalTerminologyAnchors();
	init_documentGeneratorHelpers();
	init_tenderRequirements();
})), FULL_VALIDATION_DETECTORS, STANDARD_FINAL_DETECTORS, AUXILIARY_DETECTORS, PATCH_GUARD_DETECTOR_IDS;
var init_detectorFixerRegistry = __esmMin((() => {
	init_factGovernance();
	init_documentIntegrityChecks();
	init_deterministicFixChains();
	FULL_VALIDATION_DETECTORS = [
		{
			id: "spec-gate-rules",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "auto-spec-validation",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "fact-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "project-contamination",
			scope: "full-document",
			category: "scope"
		},
		{
			id: "project-basic-placeholder",
			scope: "full-document",
			category: "format"
		},
		{
			id: "standard-final",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "fact-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "page-target",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "document-budget",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "formal-text-gate",
			scope: "full-document",
			category: "format"
		},
		{
			id: "heading-uncovered-engineering-items",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "writer-missing-section",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "critical-section-depth",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "critical-section-fact-density",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "chapter-fact-density",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "construction-org-professional-audit",
			scope: "chapter",
			category: "professional_chain"
		}
	];
	STANDARD_FINAL_DETECTORS = [
		{
			id: "toc-consistency",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "section-numbering",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "section-count-overflow",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "heading-duplicate",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "structure-integrity",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "templated-label",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "title-integrity",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "evaluation-criteria-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "requirements-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "fabricated-start-date",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "field-value-mismatch",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "area-arithmetic",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "resource-consistency",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["laborPeak"]
		},
		{
			id: "node-schedule-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "cross-section-numeric-conflict",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "fact-reconciliation",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "greening-maintenance-mismatch",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["greeningMaintenance"]
		},
		{
			id: "street-light-count-mismatch",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "spec-location-mismatch",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "blueprint-citation-consistency",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "cross-project-value-copy",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "phase-labor-mixing",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "equipment-batch-conflict",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "preliminary-action-timing",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "foundation-form-residue",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "ambiguous-either-or",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["supportSystem"]
		},
		{
			id: "excavation-depth-lock",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "excavation-hazard-classification",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "support-form-fact-consistency",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["supportSystem"]
		},
		{
			id: "equipment-entry-timing",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "fabricated-award",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "bidder-qualification-section",
			scope: "full-document",
			category: "scope"
		},
		{
			id: "cross-chapter-duplicate-section",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "basic-info-schedule-field",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "duplicate-table",
			scope: "full-document",
			category: "table"
		},
		{
			id: "duplicate-paragraph",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "paragraph-tail-repeat",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "collision-numbered-heading",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "inverted-date-range",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "resource-triad-section-hierarchy",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "support-system-conflict",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["supportSystem"]
		},
		{
			id: "dangerous-list-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "hazard-exclusion-contradiction",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "six-hundred-percent-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "self-undermining-candidate",
			scope: "full-document",
			category: "style"
		},
		{
			id: "paragraph-opening-repeat",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "flow-form-repeat",
			scope: "full-document",
			category: "style"
		},
		{
			id: "skeleton-fingerprint",
			scope: "full-document",
			category: "style"
		},
		{
			id: "repeated-word",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "commercial-data-in-body",
			scope: "full-document",
			category: "scope"
		},
		{
			id: "overview-recap",
			scope: "full-document",
			category: "style"
		},
		{
			id: "closure-phrase-density-cap",
			scope: "full-document",
			category: "style"
		},
		{
			id: "parameter-concept-conflict",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "internal-terminology-anchor",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "construction-system-coverage",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "dangerous-applicability",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "innovation-tech-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "instruction-like-heading",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "formal-heading-hierarchy",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "formal-content-integrity",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "punctuation-artifact",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "table-quality",
			scope: "full-document",
			category: "table",
			deterministicSafe: true
		},
		{
			id: "table-spam",
			scope: "full-document",
			category: "table",
			deterministicSafe: true
		},
		{
			id: "basis-regulations-coverage",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "resource-breakdown-consistency",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "section-content-integrity",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "professional-content",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "professional-score",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "generic-professional-content",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "management-measure-number",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "closed-loop-density",
			scope: "full-document",
			category: "control_loop"
		},
		{
			id: "cross-chapter-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "process-spec-conflict",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "evidence-usage-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "paragraph-generic",
			scope: "full-document",
			category: "style"
		},
		{
			id: "construction-org-generic-language",
			scope: "chapter",
			category: "style"
		},
		{
			id: "construction-org-control-loop",
			scope: "chapter",
			category: "control_loop"
		},
		{
			id: "construction-org-professional-chain",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "construction-org-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "construction-org-chapter-data-coverage",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "construction-org-major-content",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "construction-org-division-section",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "major-content-governance",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "construction-org-bonus-module",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "chapter-dependency",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "document-delivery-score",
			scope: "full-document",
			category: "professional_chain"
		},
		{
			id: "generated-fact-verification",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "numeric-traceability",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "table-arithmetic-consistency",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "duplicate-basic-info",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "formal-style",
			scope: "full-document",
			category: "style"
		},
		{
			id: "tertiary-heading",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "min-chapter-section",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "precise-fact-usage",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "parameter-obligation-usage",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "boq-placement",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "stage-phrasing",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "emergency-section-depth",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "boq-row-trace",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "drawing-reference",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "web-evidence-leakage",
			scope: "full-document",
			category: "scope"
		},
		{
			id: "formal-placeholder",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "prompt-example-leak",
			scope: "full-document",
			category: "format"
		},
		{
			id: "degenerate-content",
			scope: "chapter",
			category: "style"
		},
		{
			id: "planned-auto-spec-gate",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "bid-composition-body-table",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "bid-composition-body-figure",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "identity-marks-forbidden",
			scope: "full-document",
			category: "format"
		},
		{
			id: "planned-structure",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "table-caption",
			scope: "full-document",
			category: "format"
		},
		{
			id: "prompt-document-rule",
			scope: "full-document",
			category: "format"
		},
		{
			id: "local-adaptation-keyword",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "boq-division-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		}
	];
	AUXILIARY_DETECTORS = [
		{
			id: "authority-audit-gap",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "important-unplaced-facts",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "table-plan-execution",
			scope: "chapter",
			category: "table"
		},
		{
			id: "templating-filler",
			scope: "full-document",
			category: "style"
		},
		{
			id: "templating-difficulty",
			scope: "full-document",
			category: "professional_chain"
		},
		{
			id: "workpackage-skeleton",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "planned-section-completeness",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "global-consistency-review",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "source-enumeration",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "meta-discourse-declaration",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "finish-thickness",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "formula-residue",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "truncated-sentence",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "atlas-reference-phrase",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "block-structure-contract",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "block-fact-density",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "block-templating",
			scope: "chapter",
			category: "style"
		},
		{
			id: "block-attribution-quantification",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "block-numeric-reconciliation",
			scope: "chapter",
			category: "fact_consistency"
		},
		{
			id: "block-format-constraints",
			scope: "chapter",
			category: "format"
		}
	];
	PATCH_GUARD_DETECTOR_IDS = [
		"source-enumeration",
		"internal-terminology-anchor",
		"fabricated-start-date",
		"repeated-word",
		"writer-missing-section",
		"meta-discourse-declaration",
		"formula-residue",
		"finish-thickness",
		"formal-placeholder",
		"truncated-sentence"
	];
	[...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS];
	[
		...FULL_VALIDATION_DETECTORS,
		...STANDARD_FINAL_DETECTORS,
		...AUXILIARY_DETECTORS
	];
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/rebuildFacts.ts
var init_rebuildFacts = __esmMin((() => {
	init_evidence();
	init_factsModel();
	init_factGovernance();
	init_documentIntegrityChecks();
	init_integratedBlueprint();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterParameterFacts.ts
/** 参数文本（相关性计分与渲染共用口径）：键/字段名/值 */
function parameterFactText(fact) {
	return `${fact.key || ""} ${fact.fieldName || ""} ${fact.value || ""}`.trim();
}
/** 可用参数池：空值/噪声/商务/重复剔除（去重键 key|value，池内原始顺序保持）。
* D6 同源净化：表格噪声（图签/坐标/残片/粘连）与要求池共用 poolNoise 判定——一处判定全链生效
* （写作注入/义务审计/修复分配三处消费同一池，噪声零进入义务集）。 */
function usableParameterFacts(factsModel) {
	const empty = {
		usable: [],
		noiseExcluded: []
	};
	if (!factsModel) return empty;
	const pool = factsModel.factIndex?.parameterFacts?.length ? factsModel.factIndex.parameterFacts : factsModel.preciseFacts || [];
	const seen = /* @__PURE__ */ new Set();
	const usable = [];
	const noiseExcluded = [];
	for (const fact of pool) {
		if (!fact) continue;
		const value = String(fact.value || "").trim();
		if (!value) continue;
		if (PARAMETER_NOISE_RE.test(parameterFactText(fact))) continue;
		if (isGenerationExcludedFact(fact)) continue;
		if (PARAMETER_COMMERCIAL_EXTRA_RE.test(parameterFactText(fact))) continue;
		const noiseCategory = classifyPoolNoiseText(value);
		if (noiseCategory) {
			noiseExcluded.push({
				fact,
				category: noiseCategory
			});
			continue;
		}
		const dedupeKey = `${fact.key}|${value}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		usable.push(fact);
	}
	return {
		usable,
		noiseExcluded
	};
}
/** 章 token 展开集（标题+小节切词 → 双字子词展开，一次展开供全池打分复用） */
function chapterParameterTokens(chapterTitle, sections = []) {
	const expanded = /* @__PURE__ */ new Set();
	for (const token of chapterRelevanceTokens(chapterTitle, sections)) for (const item of expandRelevanceToken(token)) expanded.add(item);
	return [...expanded];
}
/** 参数与章的相关性分：展开 token 命中参数文本的个数（>0 即相关；打分序用于注入排序与修复定位） */
function parameterRelevanceScore(fact, expandedTokens) {
	const text = parameterFactText(fact);
	let score = 0;
	for (const token of expandedTokens) if (text.includes(token)) score += 1;
	return score;
}
/** 参数使用判定（字面口径，双端 normalizeEngineeringTextForFactMatch 归一；组合值按段片段兜底） */
function parameterValueUsedIn(normalizedMarkdown, value) {
	const normalizedValue = normalizeEngineeringTextForFactMatch(value);
	if (!normalizedValue) return false;
	if (normalizedMarkdown.includes(normalizedValue)) return true;
	return value.split(/[、，,;；/|]+/u).map((item) => normalizeEngineeringTextForFactMatch(item)).filter((item) => item.length >= 5).some((fragment) => normalizedMarkdown.includes(fragment));
}
/** 参数使用归因（口径单源）：逐池参数做使用判定（字面命中 → used），未使用按「是否与任一章相关」二分归因；
* D6 噪声条目在池入口已出池（noiseExcluded 登记），不计义务 */
function classifyParameterUsage(markdown, factsModel, chapters = []) {
	const { usable: pool, noiseExcluded } = usableParameterFacts(factsModel);
	const normalizedMarkdown = normalizeEngineeringTextForFactMatch(markdown || "");
	const tokenSets = chapters.map((chapter) => chapterParameterTokens(chapter.title, chapter.sections || []));
	const used = [];
	const relevantMissed = [];
	const irrelevantMissed = [];
	for (const fact of pool) {
		if (parameterValueUsedIn(normalizedMarkdown, String(fact.value))) {
			used.push(fact);
			continue;
		}
		(tokenSets.some((tokens) => tokens.length > 0 && parameterRelevanceScore(fact, tokens) > 0) ? relevantMissed : irrelevantMissed).push(fact);
	}
	return {
		totalParams: pool.length,
		used,
		relevantMissed,
		irrelevantMissed,
		noiseExcluded
	};
}
/** 相关而遗漏参数 → 目标章索引的修复分配（逐条按相关性降序取章，同分取大纲靠前章；
* 首选章满额时顺位次优章——仅分数 >0 的章可承载，防单章拥塞（s28l 质量/施工方法两章集中 60+ 条）
* 造成分配浪费；逐章/总量限额防指令膨胀） */
function assignMissingParameterChapters(markdown, factsModel, chapters = [], options = {}) {
	const assignment = /* @__PURE__ */ new Map();
	if (chapters.length === 0) return assignment;
	const maxPerChapter = Math.max(1, options.maxPerChapter ?? PARAMETER_REPAIR_MAX_PER_CHAPTER);
	const maxTotal = Math.max(1, options.maxTotal ?? PARAMETER_REPAIR_MAX_TOTAL);
	const missed = classifyParameterUsage(markdown, factsModel, chapters).relevantMissed;
	if (missed.length === 0) return assignment;
	const tokenSets = chapters.map((chapter) => chapterParameterTokens(chapter.title, chapter.sections || []));
	let assigned = 0;
	for (const fact of missed) {
		if (assigned >= maxTotal) break;
		const value = String(fact.value).trim();
		if (value.length === 0 || value.length > PARAMETER_REPAIR_VALUE_MAX) continue;
		const ranked = tokenSets.map((tokens, index) => ({
			index,
			score: tokens.length === 0 ? 0 : parameterRelevanceScore(fact, tokens)
		})).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.index - right.index);
		for (const candidate of ranked) {
			const list = assignment.get(candidate.index) ?? [];
			if (list.length >= maxPerChapter) continue;
			list.push(value);
			assignment.set(candidate.index, list);
			assigned += 1;
			break;
		}
	}
	return assignment;
}
/**
* 可靠参数义务缺口检测（参数池净化后义务满足率 < 门槛 → error）：
* 与报告出口 buildParameterUsageAudit.rate、修复出口 assignMissingParameterChapters 同源单源
* （classifyParameterUsage）——检测定位=修复定位（content-depth-repair 按 provenance 消费本类 error）。
* 义务集为空或章节缺失（相关口径不可判定）时不判定。
*/
function parameterObligationUsageIssues(markdown, factsModel, chapters = []) {
	if (chapters.length === 0) return [];
	const breakdown = classifyParameterUsage(markdown, factsModel, chapters);
	const obligationTotal = breakdown.used.length + breakdown.relevantMissed.length;
	if (obligationTotal < 8) return [];
	if (breakdown.used.length / obligationTotal >= .9) return [];
	const samples = breakdown.relevantMissed.slice(0, 3).map((fact) => String(fact.value).slice(0, 30));
	return [{
		level: "error",
		category: "fact_consistency",
		owner: "llm",
		repairability: "llm_repairable",
		message: `可靠参数义务落位不足：${breakdown.used.length}/${obligationTotal}（相关而遗漏 ${breakdown.relevantMissed.length} 项${samples.length > 0 ? `，缺失如 ${samples.join("、")}` : ""}）`,
		suggestion: "请将资料中的可靠参数（规格/型号/尺寸/强度/规范编号等）在对应章节的对应位置自然写入，保持原值原形态（数字、单位、编号中的连字符与年份不得改写、拆分或省略）；商务金额、单价、税率、预留金类数据一律不得写入正文。",
		provenance: {
			detectorId: "parameter-obligation-usage",
			fingerprint: stableHash(markdown)
		}
	}];
}
var PARAMETER_NOISE_RE, PARAMETER_COMMERCIAL_EXTRA_RE, PARAMETER_REPAIR_VALUE_MAX, PARAMETER_REPAIR_MAX_PER_CHAPTER, PARAMETER_REPAIR_MAX_TOTAL;
var init_chapterParameterFacts = __esmMin((() => {
	init_billFactLock();
	init_factsModel();
	init_engineeringUnits();
	init_poolNoise();
	init_utils();
	PARAMETER_NOISE_RE = /OCR|乱码|识别错误|无法确认|语义断裂|页码/u;
	PARAMETER_COMMERCIAL_EXTRA_RE = /暂列金额|暂估价|预留金/u;
	PARAMETER_REPAIR_VALUE_MAX = 80;
	PARAMETER_REPAIR_MAX_PER_CHAPTER = 16;
	PARAMETER_REPAIR_MAX_TOTAL = 96;
}));
//#endregion
//#region apps/server/src/services/document-workflow/keyFactPlacement.ts
var init_keyFactPlacement = __esmMin((() => {
	init_factGovernance();
	init_factsModel();
	init_factCoverage();
}));
//#endregion
//#region apps/server/src/services/document-validation/factConsistencyService.ts
var init_factConsistencyService = __esmMin((() => {
	init_documentDomainProfileService();
}));
//#endregion
//#region apps/server/src/services/document-workflow/authorityAudit.ts
var init_authorityAudit = __esmMin((() => {
	init_documentFactTrace();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/numericVerification.ts
var init_numericVerification = __esmMin((() => {
	init_rolePipeline();
	init_evidence();
	init_documentFactTrace();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constructionOrgProjectTypes.ts
var init_constructionOrgProjectTypes = __esmMin((() => {
	init_outline$1();
})), CONSTRUCTION_ORG_GENERIC_PHRASES;
var init_constructionOrgQualityRules = __esmMin((() => {
	init_constructionOrgProjectTypes();
	init_writingSpec();
	init_semanticGate();
	CONSTRUCTION_ORG_GENERIC_PHRASES = [
		"精心组织",
		"科学管理",
		"精益求精",
		"全力保障",
		"高效推进",
		"力争一流",
		"最大限度",
		"显著提升",
		"大力落实",
		"充分确保",
		"严格把控"
	];
	new RegExp(CONSTRUCTION_ORG_GENERIC_PHRASES.join("|"), "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentDeliveryReport.ts
var init_documentDeliveryReport = __esmMin((() => {
	init_qualityValidation();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constructionOrgConsistency.ts
var init_constructionOrgConsistency = __esmMin((() => {
	init_resourceBreakdownNumbers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/parameterConceptConflicts.ts
var init_parameterConceptConflicts = __esmMin((() => {
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/stagePhrasing.ts
var init_stagePhrasing = __esmMin((() => {
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/emergencySectionDepth.ts
var init_emergencySectionDepth = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentFinalValidation.ts
var init_documentFinalValidation = __esmMin((() => {
	init_qualityValidation();
	init_constructionOrgQualityRules();
	init_documentFactTrace();
	init_documentDeliveryReport();
	init_markdownComposer();
	init_constructionOrgConsistency();
	init_documentIntegrityChecks();
	init_semanticSimilarity();
	init_tenderRequirements();
	init_internalTerminologyAnchors();
	init_parameterConceptConflicts();
	init_chapterParameterFacts();
	init_stagePhrasing();
	init_emergencySectionDepth();
	init_outline$1();
	init_integratedBlueprint();
	init_detectorFixerRegistry();
}));
//#endregion
//#region apps/server/src/services/document-workflow/narrativeContext.ts
var init_narrativeContext = __esmMin((() => {
	init_tenderBidChecks();
})), FORBIDDEN_EMPTY_PHRASES;
var init_tenderBidScoring = __esmMin((() => {
	init_documentFactTrace();
	init_semanticSimilarity();
	init_tenderBidChecks();
	init_narrativeContext();
	FORBIDDEN_EMPTY_PHRASES = [
		"精心组织",
		"科学统筹",
		"科学管理",
		"精益求精",
		"全力保障",
		"高效推进",
		"力争优质",
		"力争一流",
		"一流水平",
		"完善体系",
		"最大限度",
		"显著提升",
		"大力落实",
		"严格把控",
		"充分确保",
		"竭力打造",
		"现代化管理",
		"加强管理",
		"提高意识",
		"强化监督",
		"持续完善",
		"及时处理",
		"全方位",
		"常态化",
		"提质增效",
		"高标准",
		"统筹推进"
	];
	[...FORBIDDEN_EMPTY_PHRASES];
}));
//#endregion
//#region apps/server/src/services/document-workflow/evaluationCriteriaMapping.ts
var init_evaluationCriteriaMapping = __esmMin((() => {
	init_semanticSimilarity();
	init_qualityValidation();
	init_narrativeContext();
	init_tenderBidScoring();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentQualityReport.ts
var init_documentQualityReport = __esmMin((() => {
	init_tenderBidScoring();
	init_constructionOrgTablePlan();
	init_drawingFactLock();
	init_markdownComposer();
	init_tenderRequirements();
	init_qualityValidation();
	init_detectors();
	init_evaluationCriteriaMapping();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentRepairStrategies.ts
var init_documentRepairStrategies = __esmMin((() => {
	init_documentFactTrace();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentEvidenceRetrieval.ts
var init_documentEvidenceRetrieval = __esmMin((() => {
	init_evidence();
	init_factMatching();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constructionProcessKnowledge.ts
var PROCESS_KNOWLEDGE_CARDS, CARD_BY_ALIAS, CARD_BY_ID;
var init_constructionProcessKnowledge = __esmMin((() => {
	PROCESS_KNOWLEDGE_CARDS = [
		{
			id: "earthwork-excavation",
			name: "土方开挖",
			aliases: [
				"土方",
				"基坑开挖",
				"土方开挖",
				"挖土"
			],
			process: [
				"测量放线",
				"标高复核",
				"分层开挖",
				"边坡修整",
				"基底验槽"
			],
			params: [
				"分层开挖厚度≤2m",
				"基底标高偏差0~-50mm",
				"边坡坡度按土质取1:0.5~1:1",
				"预留200~300mm人工清底"
			],
			acceptance: [
				"基底验槽",
				"钎探记录",
				"标高与轴线复核",
				"隐蔽验收记录"
			],
			standards: ["GB 50202-2018 建筑地基基础工程施工质量验收标准"]
		},
		{
			id: "earthwork-backfill",
			name: "土方回填",
			aliases: [
				"素土回填",
				"填土碾压",
				"回填",
				"余方弃置",
				"人工清底"
			],
			process: [
				"基底隐蔽验收",
				"分层摊铺",
				"分层碾压",
				"压实度检测",
				"边角补夯",
				"表面整平"
			],
			params: [
				"每层虚铺厚度≤300mm",
				"填土含水率控制在最优含水率±2%",
				"压实系数≥0.94",
				"边角部位采用小型夯实机补夯",
				"压实度每层每100m²不少于1组检测"
			],
			acceptance: [
				"压实度检测报告",
				"回填土施工记录",
				"隐蔽验收记录"
			],
			standards: ["GB 50202-2018 建筑地基基础工程施工质量验收标准", "GB 50268-2008 给水排水管道工程施工及验收规范"]
		},
		{
			id: "foundation-pit-support",
			name: "基坑支护",
			aliases: [
				"基坑支护",
				"钢板桩",
				"土钉墙",
				"支护桩",
				"冠梁"
			],
			process: [
				"测量定位",
				"支护桩成孔",
				"钢筋笼制安",
				"混凝土浇筑",
				"冠梁施工",
				"分层开挖",
				"位移监测"
			],
			params: [
				"桩位偏差≤50mm",
				"垂直度≤1%",
				"冠梁顶标高偏差±10mm",
				"监测频率：开挖期每天1次",
				"报警值按设计位移速率3mm/d"
			],
			acceptance: [
				"桩身完整性检测",
				"锚杆拉拔试验",
				"基坑监测日报",
				"专项方案审批记录"
			],
			standards: ["JGJ 120-2012 建筑基坑支护技术规程", "GB 50497-2019 建筑基坑工程监测技术标准"]
		},
		{
			id: "pile-foundation",
			name: "桩基工程",
			aliases: [
				"桩基",
				"钻孔灌注桩",
				"预制桩",
				"静压桩",
				"PHC管桩"
			],
			process: [
				"测量定位",
				"成孔（压桩）",
				"清孔验收",
				"钢筋笼制安",
				"混凝土灌注",
				"桩身检测"
			],
			params: [
				"桩径偏差±5mm",
				"沉渣厚度≤50mm（端承桩）",
				"充盈系数≥1.0",
				"桩顶标高偏差±10mm",
				"静载试验不少于总桩数1%且≥3根"
			],
			acceptance: [
				"桩基静载试验",
				"低应变/声波透射检测",
				"成孔记录",
				"钢筋隐蔽验收"
			],
			standards: ["JGJ 94-2008 建筑桩基技术规范", "GB 50202-2018"]
		},
		{
			id: "rebar-works",
			name: "钢筋工程",
			aliases: [
				"钢筋",
				"钢筋绑扎",
				"钢筋加工",
				"钢筋连接"
			],
			process: [
				"翻样下料",
				"加工成型",
				"运输堆放",
				"绑扎安装",
				"隐蔽验收"
			],
			params: [
				"直螺纹接头拧紧力矩值按规格控制",
				"接头错开≥35d且≥500mm",
				"保护层垫块间距≤1m",
				"绑扎搭接长度按图集16G101"
			],
			acceptance: [
				"钢筋原材复试",
				"接头工艺检验",
				"隐蔽工程验收记录",
				"保护层实测"
			],
			standards: ["GB 50204-2015 混凝土结构工程施工质量验收规范", "JGJ 18-2012 钢筋焊接及验收规程"]
		},
		{
			id: "formwork-works",
			name: "模板工程",
			aliases: [
				"模板",
				"模板支撑",
				"高支模",
				"脚手架模板"
			],
			process: [
				"方案编制",
				"立杆搭设",
				"主次龙骨铺设",
				"面板安装",
				"验收挂牌",
				"拆模申请"
			],
			params: [
				"立杆间距≤900×900mm（危大）",
				"扫地杆距地≤200mm",
				"水平杆步距≤1500mm",
				"剪刀撑连续设置",
				"拆模强度：板≥75%设计强度"
			],
			acceptance: [
				"高支模专项方案论证",
				"架体验收挂牌",
				"沉降变形监测",
				"拆模令"
			],
			standards: ["JGJ 162-2008 建筑施工模板安全技术规范", "JGJ 130-2011 建筑施工扣件式钢管脚手架安全技术规范"]
		},
		{
			id: "concrete-works",
			name: "混凝土工程",
			aliases: [
				"混凝土",
				"砼浇筑",
				"混凝土浇筑",
				"振捣"
			],
			process: [
				"浇筑申请",
				"坍落度检测",
				"分层浇筑",
				"振捣密实",
				"收面养护",
				"试块留置"
			],
			params: [
				"坍落度按配比±30mm",
				"分层浇筑厚度≤500mm",
				"振动棒快插慢拔",
				"养护≥7d（掺外加剂≥14d）",
				"标养试块每100m³≥1组"
			],
			acceptance: [
				"坍落度检测记录",
				"试块标养与同条件报告",
				"混凝土外观检查",
				"强度评定"
			],
			standards: ["GB 50204-2015", "GB/T 50107-2010 混凝土强度检验评定标准"]
		},
		{
			id: "steel-structure",
			name: "钢结构工程",
			aliases: [
				"钢结构",
				"钢构件",
				"焊接",
				"高强螺栓"
			],
			process: [
				"深化设计",
				"构件加工",
				"进场验收",
				"吊装就位",
				"校正固定",
				"焊接/螺栓连接",
				"涂装"
			],
			params: [
				"高强螺栓初拧终拧扭矩比1.1",
				"焊缝等级按设计一级/二级",
				"挠度允许值L/400",
				"防火涂料厚度按耐火极限"
			],
			acceptance: [
				"焊缝探伤检测",
				"高强螺栓扭矩检查",
				"构件尺寸偏差实测",
				"防火涂料厚度检测"
			],
			standards: ["GB 50205-2020 钢结构工程施工质量验收标准", "JGJ 82-2011 钢结构高强度螺栓连接技术规程"]
		},
		{
			id: "masonry-works",
			name: "砌体工程",
			aliases: [
				"砌体",
				"砌筑",
				"加气块",
				"二次结构"
			],
			process: [
				"弹线定位",
				"排砖撂底",
				"砌筑",
				"构造柱植筋",
				"圈梁浇筑",
				"顶砖处理"
			],
			params: [
				"灰缝厚度8~12mm",
				"垂直度偏差≤5mm（每层）",
				"拉结筋间距≤500mm",
				"顶砖间隔7d斜砌"
			],
			acceptance: [
				"砌筑砂浆试块",
				"构造柱钢筋隐蔽验收",
				"垂直度平整度实测",
				"拉结筋检测"
			],
			standards: ["GB 50203-2011 砌体结构工程施工质量验收规范"]
		},
		{
			id: "waterproofing",
			name: "防水工程",
			aliases: [
				"防水",
				"屋面防水",
				"卫生间防水",
				"地下防水",
				"卷材"
			],
			process: [
				"基层处理",
				"阴阳角附加层",
				"防水层铺贴",
				"搭接密封",
				"闭水/淋水试验",
				"保护层"
			],
			params: [
				"卷材搭接宽度≥100mm",
				"附加层宽度≥500mm",
				"卫生间闭水试验48h",
				"屋面蓄水试验24h",
				"涂膜厚度按设计≥1.5mm"
			],
			acceptance: [
				"闭水/蓄水试验记录",
				"隐蔽验收记录",
				"防水材料复试",
				"淋水试验"
			],
			standards: ["GB 50207-2012 屋面工程质量验收规范", "GB 50208-2011 地下防水工程质量验收规范"]
		},
		{
			id: "plastering",
			name: "抹灰工程",
			aliases: [
				"抹灰",
				"粉刷",
				"墙面抹灰",
				"挂网"
			],
			process: [
				"基层处理",
				"浇水湿润",
				"打点冲筋",
				"分层抹灰",
				"压光",
				"养护"
			],
			params: [
				"不同基体交接处挂网宽≥200mm",
				"每遍抹灰厚度≤7mm",
				"平整度偏差≤4mm",
				"空鼓面积≤400cm²且不连续"
			],
			acceptance: [
				"空鼓敲击检查",
				"平整度垂直度实测",
				"养护记录"
			],
			standards: ["GB 50210-2018 建筑装饰装修工程质量验收标准"]
		},
		{
			id: "tile-paving",
			name: "墙地砖铺贴",
			aliases: [
				"墙地砖",
				"瓷砖",
				"铺贴",
				"石材"
			],
			process: [
				"基层检查",
				"排砖放线",
				"选砖泡水",
				"铺贴",
				"勾缝",
				"成品保护"
			],
			params: [
				"粘结层厚度≤10mm",
				"接缝宽度按设计要求",
				"空鼓率单块≤15%且整面≤5%",
				"平整度偏差≤2mm"
			],
			acceptance: [
				"空鼓锤击检查",
				"平整度实测",
				"坡度泼水检查",
				"成品保护验收"
			],
			standards: ["GB 50210-2018"]
		},
		{
			id: "ceil-partition",
			name: "吊顶与轻质隔墙",
			aliases: [
				"吊顶",
				"轻钢龙骨",
				"隔墙",
				"石膏板"
			],
			process: [
				"弹线定位",
				"龙骨安装",
				"面板安装",
				"接缝处理",
				"面层施工"
			],
			params: [
				"主龙骨间距≤1200mm",
				"吊杆间距≤1000mm",
				"罩面板接缝错开",
				"石膏板接缝处粘贴网格布"
			],
			acceptance: [
				"龙骨隐蔽验收",
				"面板平整度实测",
				"吊顶起拱检查"
			],
			standards: ["GB 50210-2018"]
		},
		{
			id: "painting",
			name: "涂饰工程",
			aliases: [
				"涂料",
				"油漆",
				"乳胶漆",
				"腻子"
			],
			process: [
				"基层清理",
				"刮腻子",
				"打磨",
				"底漆",
				"面漆",
				"修整"
			],
			params: [
				"腻子每遍厚度≤2mm",
				"底漆1遍面漆2遍",
				"施工温度5~35℃",
				"平整度偏差≤2mm"
			],
			acceptance: [
				"涂层色泽均匀检查",
				"无流坠起皮检查",
				"平整度实测"
			],
			standards: ["GB 50210-2018"]
		},
		{
			id: "door-window",
			name: "门窗工程",
			aliases: [
				"门窗",
				"铝合金窗",
				"幕墙",
				"玻璃"
			],
			process: [
				"洞口复核",
				"安装固定",
				"缝隙填塞",
				"打胶密封",
				"开启调试",
				"淋水试验"
			],
			params: [
				"框与墙间隙≤5mm",
				"密封胶连续饱满",
				"窗扇开关力≤50N",
				"气密水密性能按设计等级"
			],
			acceptance: [
				"淋水试验",
				"开启灵活检查",
				"垂直度偏差实测",
				"性能检测报告"
			],
			standards: ["GB 50210-2018", "GB/T 7106-2019 建筑外门窗气密水密抗风压性能检测方法"]
		},
		{
			id: "plumbing",
			name: "给排水工程",
			aliases: [
				"给排水",
				"给水管道",
				"排水管道",
				"管道安装"
			],
			process: [
				"预留预埋",
				"支架安装",
				"管道安装",
				"压力试验",
				"冲洗消毒",
				"通水试验"
			],
			params: [
				"给水管试验压力为工作压力1.5倍且≥0.6MPa",
				"排水管坡度按管径DN50~DN200取2.5%~0.8%",
				"支架间距按管径设置",
				"PPR热熔温度260℃"
			],
			acceptance: [
				"管道水压试验",
				"通球试验",
				"灌水试验",
				"冲洗消毒记录"
			],
			standards: ["GB 50242-2002 建筑给水排水及采暖工程施工质量验收规范"]
		},
		{
			id: "electrical",
			name: "电气工程",
			aliases: [
				"电气",
				"配管",
				"穿线",
				"桥架",
				"配电箱",
				"防雷接地"
			],
			process: [
				"预留预埋",
				"配管桥架",
				"穿线放缆",
				"设备安装",
				"绝缘测试",
				"通电调试"
			],
			params: [
				"管路弯曲半径≥6D（埋地≥10D）",
				"导线绝缘电阻≥0.5MΩ",
				"桥架支架间距≤1.5m",
				"防雷接地电阻≤1Ω"
			],
			acceptance: [
				"绝缘电阻测试",
				"接地电阻测试",
				"通电试运行",
				"隐蔽验收记录"
			],
			standards: ["GB 50303-2015 建筑电气工程施工质量验收规范"]
		},
		{
			id: "hvac",
			name: "通风空调工程",
			aliases: [
				"通风空调",
				"风管",
				"空调",
				"新风",
				"保温"
			],
			process: [
				"风管制作",
				"吊架安装",
				"风管安装",
				"设备安装",
				"严密性试验",
				"系统调试"
			],
			params: [
				"风管支吊架间距≤3m",
				"中压风管漏光法检测",
				"保温层厚度按设计",
				"风口风速按设计值±10%"
			],
			acceptance: [
				"风管严密性试验",
				"风量平衡调试",
				"设备单机试运行",
				"系统联动调试"
			],
			standards: ["GB 50243-2016 通风与空调工程施工质量验收规范"]
		},
		{
			id: "fire-protection",
			name: "消防工程",
			aliases: [
				"消防",
				"消火栓",
				"喷淋",
				"火灾报警",
				"防排烟"
			],
			process: [
				"预留预埋",
				"管道安装",
				"喷头/探测器安装",
				"系统试压",
				"联动调试",
				"检测验收"
			],
			params: [
				"喷淋试验压力≥1.4MPa",
				"消火栓充实水柱≥10m",
				"探测器保护半径按类别",
				"防排烟风管严密性"
			],
			acceptance: [
				"消防水压试验",
				"联动调试记录",
				"消防检测报告",
				"竣工验收备案"
			],
			standards: ["GB 50261-2017 自动喷水灭火系统施工及验收规范", "GB 50166-2019 火灾自动报警系统施工及验收标准"]
		},
		{
			id: "weak-current",
			name: "弱电智能化工程",
			aliases: [
				"弱电",
				"智能化",
				"综合布线",
				"监控",
				"门禁"
			],
			process: [
				"管线预埋",
				"桥架敷设",
				"线缆敷设",
				"设备安装",
				"单机调试",
				"系统联调"
			],
			params: [
				"双绞线弯曲半径≥4D",
				"光缆弯曲半径≥15D",
				"面板安装高度距地300mm",
				"链路测试按TIA-568"
			],
			acceptance: [
				"链路测试报告",
				"单机调试记录",
				"系统联调记录",
				"隐蔽验收"
			],
			standards: ["GB 50311-2016 综合布线系统工程设计规范", "GB 50339-2013 智能建筑工程质量验收规范"]
		},
		{
			id: "municipal-road",
			name: "道路工程",
			aliases: [
				"道路",
				"路基",
				"路面",
				"水稳",
				"沥青"
			],
			process: [
				"测量放线",
				"路基处理",
				"分层碾压",
				"水稳摊铺",
				"沥青摊铺",
				"标线设施"
			],
			params: [
				"路基压实度≥93%（路床）",
				"水稳层7d无侧限抗压强度按设计",
				"沥青压实度≥96%",
				"面层平整度≤5mm（3m直尺）"
			],
			acceptance: [
				"压实度检测",
				"弯沉检测",
				"取芯厚度检测",
				"平整度实测"
			],
			standards: ["CJJ 1-2008 城镇道路工程施工与质量验收规范"]
		},
		{
			id: "municipal-pipe",
			name: "市政管道工程",
			aliases: [
				"管道",
				"雨污水",
				"沟槽",
				"检查井",
				"承插管"
			],
			process: [
				"测量放线",
				"沟槽开挖支护",
				"基础垫层",
				"管道安装",
				"接口处理",
				"闭水试验",
				"回填"
			],
			params: [
				"沟槽开挖放坡按土质1:0.33~1:0.5",
				"垫层厚度按设计≥100mm",
				"管道安装轴线偏差≤15mm",
				"闭水试验渗水量按GB 50268",
				"回填分层厚度≤250mm"
			],
			acceptance: [
				"闭水试验记录",
				"管内底高程检测",
				"管道CCTV检测",
				"回填压实度检测"
			],
			standards: ["GB 50268-2008 给水排水管道工程施工及验收规范"]
		},
		{
			id: "demolition",
			name: "拆除工程",
			aliases: [
				"拆除",
				"墙体拆除",
				"结构拆除",
				"垃圾外运"
			],
			process: [
				"方案编制",
				"围挡隔离",
				"管线切断",
				"分层拆除",
				"垃圾清运",
				"验收交接"
			],
			params: [
				"拆除顺序自上而下",
				"垃圾清运日产日清",
				"湿法作业降尘",
				"既有保留部位防护到位"
			],
			acceptance: [
				"拆除专项方案",
				"既有设施保护检查",
				"垃圾清运记录"
			],
			standards: ["JGJ 147-2016 建筑拆除工程安全技术规范"]
		},
		{
			id: "structural-strengthen",
			name: "结构加固",
			aliases: [
				"结构加固",
				"粘钢",
				"碳纤维",
				"植筋",
				"加大截面"
			],
			process: [
				"设计交底",
				"基层处理",
				"植筋",
				"粘贴加固",
				"养护",
				"检测验收"
			],
			params: [
				"植筋锚固深度按设计≥15d",
				"碳纤维布粘结强度≥2.5MPa",
				"胶粘剂固化时间按产品说明",
				"加大截面混凝土强度等级≥C25"
			],
			acceptance: [
				"拉拔试验",
				"粘结密实度检测",
				"隐蔽验收记录"
			],
			standards: ["GB 50367-2013 混凝土结构加固设计规范", "GB 50550-2010 建筑结构加固工程施工质量验收规范"]
		},
		{
			id: "facade-renovation",
			name: "外立面整治",
			aliases: [
				"外立面",
				"立面修补",
				"真石漆",
				"外保温"
			],
			process: [
				"脚手架搭设",
				"空鼓铲除",
				"界面处理",
				"保温层施工",
				"面层施工",
				"验收落架"
			],
			params: [
				"保温板粘贴面积≥40%",
				"锚栓数量每平米≥6个",
				"抗裂砂浆厚度3~5mm",
				"面层垂直度偏差≤4mm"
			],
			acceptance: [
				"粘结强度现场拉拔",
				"锚栓拉拔试验",
				"平整度实测"
			],
			standards: ["GB 50411-2019 建筑节能工程施工质量验收标准", "JGJ 144-2019 外墙外保温工程技术标准"]
		},
		{
			id: "scaffold",
			name: "脚手架工程",
			aliases: [
				"脚手架",
				"外架",
				"落地架",
				"悬挑架"
			],
			process: [
				"方案编制",
				"基础处理",
				"立杆搭设",
				"连墙件设置",
				"安全网封闭",
				"验收挂牌",
				"拆除"
			],
			params: [
				"立杆纵距≤1.5m",
				"连墙件两步三跨",
				"剪刀撑与地面夹角45°~60°",
				"悬挑架工字钢锚固长度≥1.25倍悬挑长度",
				"架体高于作业层1.5m"
			],
			acceptance: [
				"架体分段验收",
				"连墙件检查",
				"安全网封闭检查"
			],
			standards: ["JGJ 130-2011 建筑施工扣件式钢管脚手架安全技术规范"]
		},
		{
			id: "tower-crane",
			name: "起重吊装",
			aliases: [
				"起重吊装",
				"塔吊",
				"吊装",
				"汽车吊"
			],
			process: [
				"方案编制",
				"设备报验",
				"基础验收",
				"安装调试",
				"检测备案",
				"日常检查",
				"拆除"
			],
			params: [
				"吊装作业半径内警戒",
				"吊索具安全系数≥6",
				"塔吊垂直度≤4‰",
				"风速≥6级停止吊装"
			],
			acceptance: [
				"特种设备检测",
				"安装验收记录",
				"司机指挥持证检查"
			],
			standards: ["JGJ 196-2010 建筑施工塔式起重机安装使用拆卸安全技术规程"]
		},
		{
			id: "electrical-hookup",
			name: "临时用电",
			aliases: [
				"临电",
				"临时用电",
				"三级配电"
			],
			process: [
				"方案编制",
				"线路敷设",
				"配电箱设置",
				"接地保护",
				"验收送电",
				"日常巡检"
			],
			params: [
				"三级配电两级漏保",
				"漏电动作电流≤30mA/0.1s",
				"PE线截面按相线1/2",
				"电缆埋深≥0.7m",
				"配电箱距地1.4~1.6m"
			],
			acceptance: [
				"绝缘电阻测试",
				"接地电阻测试",
				"验收送电记录"
			],
			standards: ["JGJ 46-2005 施工现场临时用电安全技术规范"]
		}
	];
	CARD_BY_ALIAS = /* @__PURE__ */ new Map();
	CARD_BY_ID = /* @__PURE__ */ new Map();
	for (const card of PROCESS_KNOWLEDGE_CARDS) {
		CARD_BY_ID.set(card.id, card);
		CARD_BY_ALIAS.set(card.name, card);
		for (const alias of card.aliases) CARD_BY_ALIAS.set(alias, card);
	}
}));
//#endregion
//#region apps/server/src/services/document-workflow/tableRepairHelpers.ts
var init_tableRepairHelpers = __esmMin((() => {
	init_markdownCleanup();
}));
//#endregion
//#region apps/server/src/services/document-workflow/blockQualityExecutors.ts
var init_blockQualityExecutors = __esmMin((() => {
	init_markdownComposer();
	init_tenderBidChecks();
})), ENGINEERING_OBJECT_SUFFIXES;
var init_chapterGeneration = __esmMin((() => {
	init_evidence();
	init_markdownComposer();
	init_llmClient();
	init_rolePipeline();
	init_promptRuleExtraction();
	init_constructionOrgTablePlan();
	init_bidComposition();
	init_constructionOrgQualityRules();
	init_constructionProcessKnowledge();
	init_integratedBlueprint();
	init_chapterPostProcessing();
	init_tableRepairHelpers();
	init_detectorFixerRegistry();
	init_blockQualityExecutors();
	init_semanticGate();
	init_documentFactTrace();
	init_writingSpec();
	init_chapterPostProcessing();
	ENGINEERING_OBJECT_SUFFIXES = [
		"村",
		"社区",
		"小区",
		"家园",
		"片区",
		"工区",
		"标段"
	];
	ENGINEERING_OBJECT_SUFFIXES.map((suffix) => new RegExp(`[\\u4e00-\\u9fa5A-Za-z0-9]{1,6}${suffix}`, "gu"));
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterReview.ts
var init_chapterReview = __esmMin((() => {
	init_llmClient();
	init_chapterGeneration();
	init_markdownComposer();
})), FILLER_PARAGRAPH_PATTERNS;
var init_constructionOrgAudit = __esmMin((() => {
	init_markdownCleanup();
	init_semanticGate();
	init_tenderBidChecks();
	init_parameterPatterns();
	FILLER_PARAGRAPH_PATTERNS = [
		{
			pattern: /本小节围绕.+展开，结合绑定项目资料/u,
			label: "模板化开篇套话"
		},
		{
			pattern: /明确适用范围、控制目标、责任岗位与过程要求/u,
			label: "泛化目标罗列"
		},
		{
			pattern: /实施前应完成资料核对、技术交底和作业条件确认/u,
			label: "泛化前置条件"
		},
		{
			pattern: /交底覆盖率按\s*100%?\s*控制/u,
			label: "空泛交底承诺"
		},
		{
			pattern: /关键问题在\s*24\s*小时内形成整改责任/u,
			label: "空泛整改时限"
		},
		{
			pattern: /按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织/u,
			label: "通用闭环套话"
		},
		{
			pattern: /按作业条件确认→技术交底→过程实施→自检互检→整改复查/u,
			label: "通用流程套话"
		},
		{
			pattern: /依据本项目已确认资料中的项目边界/u,
			label: "资料依据套话"
		},
		{
			pattern: /执行日巡查、周复核和节点验收制度/u,
			label: "泛化巡查制度"
		},
		{
			pattern: /一般问题\s*7\s*日内闭环/u,
			label: "泛化整改时限"
		},
		{
			pattern: /由项目经理、技术负责人和专职安全员联合复核/u,
			label: "岗位名单堆砌"
		},
		{
			pattern: /确保与总体施工部署、工期计划和验收要求保持一致/u,
			label: "原则性呼应"
		},
		{
			pattern: /结合现场实际情况(?:，|,)?合理(?:组织|安排|布置|配置)/u,
			label: "结合实际套话"
		},
		{
			pattern: /严格(?:执行|落实|按照)国家(?:现行)?(?:有关)?(?:规范|标准|规程)/u,
			label: "规范泛引用"
		},
		{
			pattern: /做到(?:文明施工|安全生产|质量第一|安全第一)/u,
			label: "口号式承诺"
		},
		{
			pattern: /(?:确保|保证)工程(?:质量|安全|进度|文明施工)/u,
			label: "目标口号"
		},
		{
			pattern: /建立(?:健全)?(?:完善)?(?:的)?(?:管理)?体系(?:和|，)?(?:落实|确保|保证)/u,
			label: "体系空话"
		}
	];
	new RegExp(FILLER_PARAGRAPH_PATTERNS.map((item) => `(?:${item.pattern.source})`).join("|"), "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/rebuildAndRecompute.ts
var init_rebuildAndRecompute = __esmMin((() => {
	init_chapterParameterFacts();
	init_keyFactPlacement();
	init_factConsistencyService();
	init_markdownComposer();
	init_bidComposition();
	init_qualityValidation();
	init_documentIntegrityChecks();
	init_internalTerminologyAnchors();
	init_authorityAudit();
	init_numericVerification();
	init_documentFinalValidation();
	init_documentFactTrace();
	init_documentQualityReport();
	init_documentRepairStrategies();
	init_documentEvidenceRetrieval();
	init_factGovernance();
	init_agentWorkflow();
	init_chapterGeneration();
	init_chapterReview();
	init_documentGeneratorHelpers();
	init_constructionOrgTablePlan();
	init_tenderRequirements();
	init_constructionOrgAudit();
	init_blockQualityExecutors();
	init_detectorFixerRegistry();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/factLanding.ts
var init_factLanding = __esmMin((() => {
	init_rolePipeline();
	init_documentGeneratorHelpers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/numericConflictArbiter.ts
var init_numericConflictArbiter = __esmMin((() => {
	init_documentIntegrityChecks();
	init_parameterConceptConflicts();
}));
//#endregion
//#region apps/server/src/services/document-workflow/dataConsistencyReview.ts
var init_dataConsistencyReview = __esmMin((() => {
	init_llmClient();
	init_markdownComposer();
	init_integratedBlueprint();
}));
//#endregion
//#region apps/server/src/services/document-workflow/globalQualityGates.ts
var init_globalQualityGates = __esmMin((() => {
	init_semanticSimilarity();
	init_documentIntegrityChecks();
	init_numericConflictArbiter();
	init_integratedBlueprint();
	init_qualityValidation();
	init_promptRuleExtraction();
	init_chapterReview();
	init_dataConsistencyReview();
	init_constructionOrgTablePlan();
	init_rolePipeline();
	init_constructionOrgAudit();
	init_tenderBidChecks();
	init_chapterPostProcessing();
	init_writingSpec();
	init_constructionOrgQualityRules();
	init_bidComposition();
	init_markdownComposer();
	init_outline$1();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/tableRepair.ts
var init_tableRepair = __esmMin((() => {
	init_rolePipeline();
	init_qualityValidation();
	init_documentGeneratorHelpers();
	init_tableRepairHelpers();
	init_bidComposition();
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/semanticChoice.ts
var init_semanticChoice = __esmMin((() => {
	init_dataConsistencyReview();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/deterministicStage5.ts
var init_deterministicStage5 = __esmMin((() => {
	init_qualityValidation();
	init_documentIntegrityChecks();
	init_integratedBlueprint();
	init_markdownComposer();
	init_deterministicFixChains();
	init_resourceBreakdownNumbers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/autoSpecGateRepair.ts
var init_autoSpecGateRepair = __esmMin((() => {
	init_qualityValidation();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/basisRegulationsRepair.ts
var init_basisRegulationsRepair = __esmMin((() => {
	init_qualityValidation();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/dangerousApplicabilityRepair.ts
var init_dangerousApplicabilityRepair = __esmMin((() => {
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/quotationBalanceRepair.ts
var init_quotationBalanceRepair = __esmMin((() => {
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/fiveElementClosureBoost.ts
var init_fiveElementClosureBoost = __esmMin((() => {
	init_tenderBidChecks();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/requirementResponseRepair.ts
var init_requirementResponseRepair = __esmMin((() => {
	init_rolePipeline();
	init_tenderRequirements();
	init_documentIntegrityChecks();
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/postReviewSurface.ts
var init_postReviewSurface = __esmMin((() => {
	init_documentIntegrityChecks();
	init_qualityValidation();
	init_documentFactTrace();
	init_integratedBlueprint();
	init_tableRepairHelpers();
	init_internalTerminologyAnchors();
	init_detectors();
	init_constructionOrgQualityRules();
	init_constructionOrgTablePlan();
	init_markdownComposer();
	init_bidComposition();
	init_globalQualityGates();
	init_deterministicFixChains();
	init_autoSpecGateRepair();
	init_basisRegulationsRepair();
	init_dangerousApplicabilityRepair();
	init_quotationBalanceRepair();
	init_fiveElementClosureBoost();
	init_fixers();
	init_requirementResponseRepair();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/factDistribution.ts
var init_factDistribution = __esmMin((() => {
	init_documentFactTrace();
	init_factsModel();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/requirementVerification.ts
var init_requirementVerification = __esmMin((() => {
	init_rolePipeline();
	init_llmClient();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/contentDepthRepair.ts
var init_contentDepthRepair = __esmMin((() => {
	init_rolePipeline();
	init_constructionOrgQualityRules();
	init_emergencySectionDepth();
	init_qualityValidation();
	init_chapterParameterFacts();
	init_drawingFactLock();
	init_documentFactTrace();
	init_detectors();
	init_rebuildAndRecompute();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/controlLoopRepair.ts
var init_controlLoopRepair = __esmMin((() => {
	init_rolePipeline();
	init_constructionOrgQualityRules();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/professionalChainRepair.ts
var init_professionalChainRepair = __esmMin((() => {
	init_rolePipeline();
	init_constructionOrgQualityRules();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/lengthCompressionRepair.ts
var init_lengthCompressionRepair = __esmMin((() => {
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/tableCaptionRepair.ts
var init_tableCaptionRepair = __esmMin((() => {
	init_rolePipeline();
	init_bidComposition();
	init_documentGeneratorHelpers();
	init_constructionOrgTablePlan();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/tableArithmeticRepair.ts
var init_tableArithmeticRepair = __esmMin((() => {
	init_rolePipeline();
	init_detectors();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/emptySectionSweep.ts
var init_emptySectionSweep = __esmMin((() => {
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/sectionAlignmentSweep.ts
var init_sectionAlignmentSweep = __esmMin((() => {
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/templatingSweep.ts
var init_templatingSweep = __esmMin((() => {
	init_documentIntegrityChecks();
	init_constructionOrgAudit();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/duplicateThemeMerge.ts
var init_duplicateThemeMerge = __esmMin((() => {
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/deliveryStructureClosure.ts
var init_deliveryStructureClosure = __esmMin((() => {
	init_documentIntegrityChecks();
	init_markdownCleanup();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentProfessionalScore.ts
var init_documentProfessionalScore = __esmMin((() => {
	init_constructionOrgAudit();
	init_markdownCleanup();
	init_tenderBidChecks();
	init_narrativeContext();
}));
var init_templatingReview = __esmMin((() => {
	init_llmClient();
	init_tenderBidChecks();
	init_markdownComposer();
	[
		"你是招标技术标评审专家。对施工组织设计做语义级复核，只报告确定性规则覆盖不到的语义问题。",
		"复核维度（按《施工组织设计全维度校验提示词》判定标尺）：",
		"1. 重难点三级判定：识别精准性（是否点明本项目真实难点而非泛泛而谈）→ 归因合理性（是否说明难点成因/风险来源）→ 对策匹配度（对策是否针对该难点的成因，而非通用措施堆砌）；",
		"2. 术语等效性：同一对象是否前后术语一致（如\"砼\"与\"混凝土\"混用需统一），是否出现词面不同但概念等效的双重标准表述；",
		"3. 四新技术升级价值：若正文声称采用四新技术，其价值表述是否停留在\"提升效率\"式套话，缺少可对标官方推广目录或替代落后工艺的实质说明。",
		"每条问题必须包含：问题所在内容简述+判定依据（对应上面哪条维度）+一句话改进建议。",
		"只报告真实存在的问题，正文无问题时返回空数组；不得编造问题。只返回 JSON。"
	].join("\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/finalGate.ts
var init_finalGate = __esmMin((() => {
	init_qualityValidation();
	init_documentProfessionalScore();
	init_templatingReview();
	init_documentGeneratorHelpers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentPipeline.ts
var init_documentPipeline = __esmMin((() => {
	init_evidence();
	init_documentGeneratorHelpers();
	init_detectorFixerRegistry();
	init_rebuildFacts();
	init_rebuildAndRecompute();
	init_factLanding();
	init_tableRepair();
	init_semanticChoice();
	init_deterministicStage5();
	init_postReviewSurface();
	init_factDistribution();
	init_numericVerification();
	init_requirementResponseRepair();
	init_requirementVerification();
	init_contentDepthRepair();
	init_controlLoopRepair();
	init_professionalChainRepair();
	init_lengthCompressionRepair();
	init_tableCaptionRepair();
	init_tableArithmeticRepair();
	init_emptySectionSweep();
	init_sectionAlignmentSweep();
	init_templatingSweep();
	init_duplicateThemeMerge();
	init_deliveryStructureClosure();
	init_finalGate();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constructionBidStructure.ts
var init_constructionBidStructure = __esmMin((() => {
	init_outline$1();
	init_evidenceContentSafety();
	init_constructionOrgProjectTypes();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterDutyDeclaration.ts
var init_chapterDutyDeclaration = __esmMin((() => {
	init_outline$1();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentWritingTaskBrief.ts
var init_documentWritingTaskBrief = __esmMin((() => {
	init_constructionOrgProjectTypes();
}));
//#endregion
//#region apps/server/src/services/document-workflow/agentPlanner.ts
var FORMAL_FORBIDDEN_PHRASES;
var init_agentPlanner = __esmMin((() => {
	init_utils();
	init_semanticSimilarity();
	init_outline$1();
	init_promptRuleExtraction();
	FORMAL_FORBIDDEN_PHRASES = [
		"知识库",
		"系统暂未",
		"项目资料暂未",
		"资料未明确",
		"暂未明确",
		"待确认",
		"待资料复核",
		"待系统",
		"未检索到",
		"资料不足",
		"无法确认",
		"建议补充",
		"不适用",
		"COL",
		"可核验信息",
		"工作包",
		...BID_DISCIPLINE_PHRASES
	];
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stageChapterLoop.ts
var init_stageChapterLoop = __esmMin((() => {
	init_outline$1();
	init_factMatching();
	init_qualityValidation();
	init_constructionBidStructure();
	init_semanticSimilarity();
	init_evidenceContentSafety();
	init_tenderRequirements();
	init_factsModel();
	init_chapterReview();
	init_chapterDutyDeclaration();
	init_documentWritingTaskBrief();
	init_agentPlanner();
	init_agentWorkflow();
	init_factGovernance();
	init_rolePipeline();
	init_documentEvidenceRetrieval();
	init_drawingFactLock();
	init_chapterParameterFacts();
	init_documentFactTrace();
	init_projectMaterialProfile();
	init_chapterGeneration();
	init_bidComposition();
	init_documentGeneratorHelpers();
	init_integratedBlueprint();
	init_documentIntegrityChecks();
	init_sectionNamingGovernance();
	init_sectionFingerprint();
	init_markdownComposer();
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stageBlueprint.ts
var init_stageBlueprint = __esmMin((() => {
	init_integratedBlueprint();
	init_drawingFactLock();
	init_tenderRequirements();
	init_documentGeneratorHelpers();
}));
var init_requirementCalibration = __esmMin((() => {
	init_llmClient();
	init_outline$1();
	init_promptRuleExtraction();
	init_evidenceContentSafety();
	init_markdownComposer();
	[
		"你是施工组织设计大纲校准专家。输入各章已有小节与招标评分项要求，只输出需要新增的小节。",
		"新增小节必须显性承接评分项要求（如\"创优目标与奖惩承诺\"\"绿色建筑等级达标专项\"\"智慧工地实施\"\"装配式专项施工方案\"），只允许新增，不得修改或删除任何已有小节。",
		"只有当前章节结构确实缺少对应承接小节时才新增；已有小节已覆盖该要求时不要重复新增。",
		"新增小节标题必须具体、可直接成稿，控制在 16 个汉字以内；不得新增与评分项要求无关的小节，不得输出条款碎片（如\"1委员会确定中\"）。",
		"只返回 JSON，不要返回 markdown。"
	].join("\n\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/reviewModuleSections.ts
var init_reviewModuleSections = __esmMin((() => {
	init_outline$1();
	init_tenderRequirements();
	init_promptRuleExtraction();
}));
//#endregion
//#region apps/server/src/services/document-workflow/factTokenClassifier.ts
var init_factTokenClassifier = __esmMin((() => {
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterIntentClassifier.ts
var init_chapterIntentClassifier = __esmMin((() => {
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/professionalDepthClassifier.ts
var init_professionalDepthClassifier = __esmMin((() => {
	init_semanticSimilarity();
})), init_tableScopeAudit = __esmMin((() => {
	init_llmClient();
	init_markdownComposer();
	init_outline$1();
	init_promptRuleExtraction();
	[
		"你是施工组织设计表格规划范围审查专家。输入本标段招标范围判据与各章规划表格清单，逐表判断该表是否超出本标段工程范围。",
		"判定规则：",
		"1. 仅“表名实体未在判据中逐字出现”不得作为剔除依据——先做语义关联检索：表名实体与判据中的具体材料、工艺或部位是否构成上位/下位、同义或配套关系（如「外装饰材料」与判据中「真石漆/涂饰/面砖/彩绘」类具体饰面材料、附属用房的装饰与修缮类工程），存在任一关联即视为在范围内；",
		"2. 剔除需同时满足：①表名实体在招标要求与工程量清单中均无任何对应（含语义关联对应）；②按表名判断该实体明显属于与本标段工程类型不同的其他专业工程领域（如乡村基础设施标段出现高层建筑主体结构、大型工业设备安装类实体；配套附属用房的室内外装饰、局部修缮类工程不得视为不同领域）；③剔除不影响本标段工程内容的完整性；",
		"3. 标书惯例类表格（项目信息、管理措施、机构职责、制度流程、进度节点、检查记录、材料/设备报审与检验记录、汇总统计等不指向特定工程实体的表）一律保留，不得剔除；",
		"4. 判断不确定时保留（本审查宁保留不误剔）。",
		"只返回 JSON，不要返回 markdown。"
	].join("\n\n");
})), init_generationBudget = __esmMin((() => {
	init_rolePipeline();
	init_llmClient();
}));
var init_kbOperationLog = __esmMin((() => {
	Math.round(Date.now() - process.uptime() * 1e3);
}));
//#endregion
//#region apps/server/src/services/document-workflow/projectIntelligence.ts
var init_projectIntelligence = __esmMin((() => {
	init_kbService();
	init_kbOperationLog();
	init_agentWorkflow();
	init_projectGraph();
	init_chapterGeneration();
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stageOutlinePlanning.ts
var init_stageOutlinePlanning = __esmMin((() => {
	init_outline$1();
	init_factMatching();
	init_evidence();
	init_constructionBidStructure();
	init_semanticSimilarity();
	init_evidenceContentSafety();
	init_tenderRequirements();
	init_requirementCalibration();
	init_reviewModuleSections();
	init_factTokenClassifier();
	init_chapterIntentClassifier();
	init_professionalDepthClassifier();
	init_documentWritingTaskBrief();
	init_constructionOrgTablePlan();
	init_tableScopeAudit();
	init_bidComposition();
	init_llmClient();
	init_rolePipeline();
	init_generationBudget();
	init_promptRuleExtraction();
	init_documentFactTrace();
	init_documentGeneratorHelpers();
	init_projectIntelligence();
	init_sectionFingerprint();
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stageUnderstanding.ts
var init_stageUnderstanding = __esmMin((() => {
	init_outline$1();
	init_evidence();
	init_semanticSimilarity();
	init_constructionBidStructure();
	init_projectMaterialProfile();
	init_projectGraph();
	init_projectIntelligence();
	init_agentWorkflow();
	init_agentPlanner();
	init_documentGeneratorHelpers();
	init_documentEvidenceRetrieval();
	init_evidenceContentSafety();
	init_factsModel();
	init_factGovernance();
	init_tenderRequirements();
	init_bidComposition();
}));
var init_requirementSemantics = __esmMin((() => {
	init_llmClient();
	init_markdownComposer();
	[
		docSystemPrefix("你是用户生成要求的语义解析专家。"),
		"把用户的生成提示词完整解析为可逐条核验的结构化要求清单，不得遗漏用户的任何实质要求；不得把通用客套话（如\"请帮我生成\"\"谢谢\"）当作要求。",
		"要求必须逐条短句（每条 ≤60 字）、可核验（生成后能判断是否满足）；一条要求只写一件事，复合要求必须拆分。",
		"globalRequirements：全文级强制要求——写作内容、深度、覆盖面、表格、量化要求等不限定具体章节的要求；若要求明确指向某个章节，必须放入 chapterRequirements 而不是 globalRequirements。",
		"chapterRequirements：章节级要求——chapterTitle 必须原样取自给定的章节列表，不得编造不存在的章节名；同一章节的多条要求合并为一条记录。",
		"factClues：用户提示词中显式给出的项目专属事实线索——含数值、单位、规格、型号、标准编号、日期、地点、规模、金额、目标的短句（如\"一般路灯 100W 109套、120W 9套\"\"计划工期 365 日历天\"\"开挖深度 5.2m\"）；要求类语句（\"必须写X\"）不算事实线索；线索必须原样保留数值与表述，不得改写或换算。",
		"styleRequirements：写作风格与格式要求（语气、详略、表格偏好、禁止风格等），最多 8 条。",
		"只返回 JSON。"
	].join("\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stagePrepare.ts
var init_stagePrepare = __esmMin((() => {
	init_kbService();
	init_configService();
	init_documentRoleService();
	init_projectMaterialService();
	init_documentDomainProfileService();
	init_templateStore();
	init_outline$1();
	init_markdownComposer();
	init_promptRuleExtraction();
	init_requirementSemantics();
	init_agentWorkflow();
	init_projectMaterialProfile();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentGenerator.ts
var init_documentGenerator = __esmMin((() => {
	init_rolePipeline();
	init_documentPipeline();
	init_stageChapterLoop();
	init_stageBlueprint();
	init_stageOutlinePlanning();
	init_stageUnderstanding();
	init_stagePrepare();
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterExpansion.ts
var init_chapterExpansion = __esmMin((() => {
	init_evidence();
	init_markdownComposer();
}));
//#endregion
//#region apps/server/src/services/document-workflow/index.ts
var init_document_workflow = __esmMin((() => {
	init_templateStore();
	init_documentGenerator();
	init_constants$1();
	init_evidence();
	init_outline$1();
	init_factMatching();
	init_markdownComposer();
	init_utils();
	init_budget();
	init_factsModel();
	init_qualityValidation();
	init_llmClient();
	init_rolePipeline();
	init_chapterGeneration();
	init_chapterPostProcessing();
	init_chapterReview();
	init_chapterExpansion();
	init_promptRuleExtraction();
	init_evidenceRetrieval();
	init_factCoverage();
	init_projectBasicInfo();
	init_markdownCleanup();
	init_diagnostics();
	init_documentPipeline();
	init_tableRepairHelpers();
	init_projectMaterialProfile();
	init_agentWorkflow();
	init_agentPlanner();
	init_sectionFingerprint();
}));
/** 心跳写盘保底间隔（阶段签名未变时的最小写盘间隔）：默认 30s，与中断宽限联动（宽限 clamp ≥3×心跳） */
function resolveHeartbeatSaveIntervalMs() {
	return Math.max(3e4, Math.min(3e5, Number(process.env.DOCUMENT_PROGRESS_HEARTBEAT_SAVE_INTERVAL_MS ?? 3e4)));
}
var globalDocumentTaskStore;
var init_generatedDocumentService = __esmMin((() => {
	init_document_workflow();
	init_semanticSimilarity();
	init_qualityValidation();
	init_kbService();
	init_budget();
	init_tuningProfile();
	init_kbOperationLog();
	globalDocumentTaskStore = globalThis;
	globalDocumentTaskStore.__generatedDocumentTasks ??= /* @__PURE__ */ new Map();
	globalDocumentTaskStore.__generatedDocumentQueue ??= [];
	Math.max(60 * 6e4, Number(process.env.DOCUMENT_ABANDONED_RECORD_STALE_MS ?? 1440 * 6e4));
	globalDocumentTaskStore.__generatedDocumentProcessStartedAt ??= Date.now();
	Math.max(Math.max(3e4, Number(process.env.DOCUMENT_RECENT_UPDATE_GRACE_MS ?? 18e4)), resolveHeartbeatSaveIntervalMs() * 3);
}));
//#endregion
//#region apps/server/src/services/document-workflow/blueprintDerivationStrategies.ts
/** 条目归类 → L2 推导分组（名称关键词 → 分组；与丰乐镇多轮实测口径一致） */
function villageGroupOfEntry(entry) {
	const text = `${entry.name} ${entry.description}`;
	if (/塑料管|管道|检查井|雨水口|化粪池|涵管/u.test(text)) return "管道铺设";
	if (/挖一般土方|挖沟槽|挖基坑|回填|清淤|余方|弃置|土方/u.test(text) && entry.unit === "m3") return "土方工程";
	if (/混凝土|垫层|涵头|压顶/u.test(text) && entry.unit === "m3") return "混凝土工程";
	if (/水泥混凝土|路床|铺装|道路|青砖|散水|块料/u.test(text) && entry.unit === "m2") return "道路铺装";
	if (/砌筑|砌体|砖/u.test(text)) return "砌筑工程";
	if (/绿化|栽植|种植|苗木|草籽|喷播|灌木|乔木|色带|草坪/u.test(text)) return "绿化工程";
	return "安装工程";
}
var villageMunicipalStrategy;
var init_blueprintDerivationStrategies = __esmMin((() => {
	villageMunicipalStrategy = {
		id: "village-municipal",
		projectTypes: ["市政", "园林绿化"],
		milestoneGroups: [
			{
				key: "prep",
				label: "施工准备与清杂拆除",
				pattern: /清杂|拆除|场地平整|临时/u
			},
			{
				key: "pipe",
				label: "污水管网工程",
				pattern: /塑料管|检查井|管网|排水|化粪池|雨水口/u
			},
			{
				key: "road",
				label: "道路铺装工程",
				pattern: /道路|路床|水泥混凝土|级配碎石|路缘石|青砖|散水|过路涵/u
			},
			{
				key: "landscape",
				label: "景观与绿化工程",
				pattern: /景观|绿化|栽植|种植|苗木|喷播|小菜园|沟塘|清淤/u
			},
			{
				key: "lighting",
				label: "亮化与收尾工程",
				pattern: /路灯|亮化|配电|电缆|防雷/u
			}
		],
		groupOfEntry: villageGroupOfEntry,
		tradeMapping: [
			{
				trade: "管道工",
				pattern: /塑料管|管道|检查井|雨水口|化粪池|闭水|涵管|排水/u
			},
			{
				trade: "混凝土工",
				pattern: /混凝土|水泥砂浆|垫层|涵头|压顶/u
			},
			{
				trade: "瓦工",
				pattern: /砌筑|砌体|砖|路缘石|铺装|侧石|平石|块料|踏步|台阶/u
			},
			{
				trade: "绿化工",
				pattern: /绿化|栽植|种植|苗木|草籽|喷播|养护|灌木|乔木|色带|草坪/u
			},
			{
				trade: "电工",
				pattern: /路灯|配电|电缆|强电|防雷|接地|灯具|亮化/u
			},
			{
				trade: "普工",
				pattern: /土方|清杂|拆除|平整|回填|清淤|开挖/u
			}
		],
		laborUnitRange: {
			管道铺设: {
				unit: "m",
				min: .15,
				max: .3
			},
			土方工程: {
				unit: "m3",
				min: .08,
				max: .15
			},
			混凝土工程: {
				unit: "m3",
				min: .8,
				max: 1.5
			},
			道路铺装: {
				unit: "m2",
				min: .3,
				max: .6
			},
			砌筑工程: {
				unit: "m3",
				min: 1.2,
				max: 2
			},
			绿化工程: {
				unit: "m2",
				min: .08,
				max: .15
			},
			安装工程: {
				unit: "项",
				min: 0,
				max: 0
			}
		},
		equipmentMapping: [
			{
				name: "挖掘机",
				spec: "0.6~1.0m³",
				pattern: /人机配合|开挖|挖土|沟槽/u,
				unit: "m3",
				basis: "人机配合开挖（清单特征）"
			},
			{
				name: "自卸汽车",
				spec: "8t",
				pattern: /余方弃置|弃方|外运|回填/u,
				unit: "m3",
				basis: "土方运输与回填（清单条目）"
			},
			{
				name: "压路机",
				spec: "8~12t",
				pattern: /碾压|压实度/u,
				unit: "m2",
				basis: "路床碾压与压实度要求（清单特征）"
			},
			{
				name: "蛙式打夯机",
				spec: "",
				pattern: /回填|夯实/u,
				unit: "m3",
				basis: "沟槽回填夯实（清单条目）"
			},
			{
				name: "混凝土搅拌运输车",
				spec: "",
				pattern: /商品混凝土|C\d{2}混凝土/u,
				unit: "m3",
				basis: "商品混凝土运输（清单特征）"
			},
			{
				name: "插入式振捣器",
				spec: "",
				pattern: /混凝土浇筑|振捣/u,
				unit: "m3",
				basis: "混凝土浇筑（清单条目）"
			},
			{
				name: "洒水车",
				spec: "",
				pattern: /养护|绿化|喷播|栽植/u,
				unit: "m2",
				basis: "绿化养护与洒水（清单条目）"
			},
			{
				name: "高空作业车",
				spec: "",
				pattern: /路灯|灯具安装/u,
				unit: "套",
				basis: "路灯安装（清单条目）"
			}
		],
		machinePowerTable: [
			{
				name: "挖掘机",
				kw: 90
			},
			{
				name: "自卸汽车",
				kw: 120
			},
			{
				name: "压路机",
				kw: 75
			},
			{
				name: "蛙式打夯机",
				kw: 3
			},
			{
				name: "混凝土搅拌运输车",
				kw: 110
			},
			{
				name: "插入式振捣器",
				kw: 1.5
			},
			{
				name: "洒水车",
				kw: 90
			},
			{
				name: "高空作业车",
				kw: 60
			}
		],
		inspectionBatchRules: [
			{
				scope: "污水管网管道",
				namePattern: /塑料管|管道/u,
				unit: "m",
				divisor: 200,
				descTemplate: "管道闭水试验分段检验，按每 200m 一段划分约 {count} 段（总长 {total}m）"
			},
			{
				scope: "道路工程",
				namePattern: /水泥混凝土|级配碎石|路床/u,
				unit: "m2",
				divisor: 200,
				descTemplate: "路床压实度按每层每 200m² 不少于 1 点检验，约 {count} 点（总面积 {total}m²）"
			},
			{
				scope: "检查井",
				namePattern: /检查井/u,
				unit: "",
				divisor: 1,
				descTemplate: "检查井逐座验收，共 {total} 座"
			}
		],
		difficultyTemplates: [
			{
				name: (boq) => `${boq.villages.length} 个自然村分散施工组织协调`,
				measure: "按自然村分组划分施工段，多村平行施工 + 村内流水作业，配置专职协调员",
				basis: "清单按自然村分组",
				test: (boq) => boq.villages.length >= 2
			},
			{
				name: "雨季管网沟槽施工",
				measure: "雨季排水与边坡防护，分段开挖、快速回填（联动季节施工措施板块）",
				basis: "清单含沟槽开挖与管道铺设条目",
				test: (boq) => boq.entries.some((entry) => /挖沟槽|沟槽开挖|塑料管铺设/u.test(`${entry.name} ${entry.description}`))
			},
			{
				name: "村庄内道路施工交通疏导",
				measure: "分段封闭施工，设置临时道路保障居民出行（补疑条款：居民出行临时道路）",
				basis: "清单含道路工程条目且村内施工",
				test: (boq) => boq.villages.length > 0 && boq.entries.some((entry) => /道路|路床|路面/u.test(entry.name))
			},
			{
				name: "既有杆管线保护",
				measure: "开挖前探测交底，杆线保护措施费含在清单单价内",
				basis: "清单特征原文含杆线保护条款",
				test: (boq) => boq.entries.some((entry) => /杆线|管线保护|既有管线/u.test(entry.description))
			}
		],
		deploymentFlowFallback: "分区段流水作业",
		multiVillageFlow: (count) => `多村平行施工 + 村内流水作业（${count} 个自然村分组）`,
		sequenceFallback: "清杂拆除 → 管网道路 → 景观绿化 → 亮化收尾",
		climateZone: "east",
		powerFallbackText: "临时用电以村庄既有电源分散接入为主，各施工组单独设置配电箱与计量表（柴油机械不计入用电负荷，电动机具零星分散）",
		waterNoteText: "施工用水以洒水车供水为主，总用水量按管网分段配置"
	};
	villageMunicipalStrategy.tradeMapping, villageMunicipalStrategy.laborUnitRange;
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/decisionLock.ts
var init_decisionLock = __esmMin((() => {
	init_factsModel();
}));
/** 从基本事实文本提取合同口径（工期/质量标准/计价文件；提取不到降级为空串，不编造）。
* P3.6 源头根治：总工期不再裸匹配第一个「N日历天」（质保期/阶段工期 90 天曾被误采为总工期，
* 真实 210 天被漏采）；只从工期类锚点词邻接收值，lookbehind 排除「节点/阶段/分项/关键」工期
* 子项形态（阶段工期 90 天不可顶替总工期），与 scheduleDays 一致性锚点同口径。 */
//#endregion
//#region apps/server/src/services/document-workflow/billOfQuantitiesParser.ts
var init_billOfQuantitiesParser = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/parse.ts
var init_parse = __esmMin((() => {
	init_billOfQuantitiesParser();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/types.ts
var init_types = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/derive.ts
var init_derive = __esmMin((() => {
	init_blueprintDerivationStrategies();
	init_decisionLock();
	init_parse();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/capacity.ts
var init_capacity = __esmMin((() => {
	init_sectionNamingGovernance();
	init_writingSpec();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/outline.ts
var init_outline = __esmMin((() => {
	init_chapterPostProcessing();
	init_constructionProcessKnowledge();
	init_sectionNamingGovernance();
	init_writingSpec();
	init_capacity();
	init_parse();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/validate.ts
var init_validate = __esmMin((() => {
	init_blueprintDerivationStrategies();
	init_llmClient();
	init_parse();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/render.ts
var init_render = __esmMin((() => {
	init_writingSpec();
	init_capacity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/semanticAdjudication.ts
var init_semanticAdjudication = __esmMin((() => {
	init_llmClient();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/citation.ts
var init_citation = __esmMin((() => {
	init_semanticAdjudication();
	init_render();
}));
var init_integratedBlueprint = __esmMin((() => {
	init_generatedDocumentService();
	init_blueprintDerivationStrategies();
	init_constructionProcessKnowledge();
	init_derive();
	init_outline();
	init_parse();
	init_validate();
	init_types();
	init_decisionLock();
	init_render();
	init_citation();
	PROCESS_KNOWLEDGE_CARDS.length;
})), HAZARD_CATEGORY_TERMS, NL;
var init_detectors = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	init_evidenceContentSafety();
	init_integratedBlueprint();
	init_semanticAdjudication();
	HAZARD_CATEGORY_TERMS = [
		"落地式钢管脚手架",
		"悬挑式脚手架",
		"附着式升降脚手架",
		"脚手架",
		"模板支撑",
		"模板工程",
		"起重吊装",
		"吊装",
		"幕墙",
		"钢结构",
		"人工挖孔",
		"拆除",
		"暗挖",
		"爆破",
		"基坑",
		"降排水",
		"降水"
	];
	new RegExp(HAZARD_CATEGORY_TERMS.join("|"), "gu");
	NL = String.fromCharCode(10);
	new RegExp(`(?:^|${NL})(?:#{1,6}\\s+[^${NL}]*${NL}+)?([^${NL}|#][^。！？!?${NL}]{18,60})[。！？!?]`, "gu");
}));
//#endregion
//#region apps/server/src/services/document-workflow/qualityValidation.ts
var init_qualityValidation = __esmMin((() => {
	init_constants();
	init_semanticSimilarity();
	init_documentFactTrace();
	init_outline$1();
	init_markdownComposer();
	init_markdownCleanup();
	init_drawingFactLock();
	init_resourceBreakdownNumbers();
	init_factMatching();
	init_templateStore();
	init_writingSpec();
	init_tenderBidChecks();
	init_semanticGate();
	init_detectors();
}));
var init_patchGuard = __esmMin((() => {
	init_agentPlanner();
	init_documentIntegrityChecks();
	init_internalTerminologyAnchors();
	init_markdownComposer();
	init_qualityValidation();
	init_utils();
	[...FORMAL_FORBIDDEN_PHRASES.filter((phrase) => !BID_DISCIPLINE_PHRASES.includes(phrase)), ...INTERNAL_TERM_EXACT_RE.source.split("|")];
}));
var init_rolePipeline = __esmMin((() => {
	init_constants();
	init_documentRoleService();
	init_templateStore();
	init_evidence();
	init_outline$1();
	init_markdownComposer();
	init_bidComposition();
	init_qualityValidation();
	init_patchGuard();
	init_llmClient();
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/markdownCleanup.ts
var init_markdownCleanup = __esmMin((() => {
	init_markdownComposer();
	init_outline$1();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/projectBasicInfo.ts
function projectBasicFactScore(text) {
	const normalized = normalizeOcrFactText(text);
	let score = 0;
	if (/项目名称|工程名称|招标项目名称|项目编号|招标项目编号|招标人|建设单位|发包人/u.test(normalized)) score += 4;
	if (/计划工期|合同工期|总工期|\d+(?:\.\d+)?\s*(?:日历天|天|个月|月|年)/u.test(normalized)) score += 6;
	if (/合同估算价|投资估算|最高投标限价|招标控制价|\d+(?:\.\d+)?\s*(?:万元|元)/u.test(normalized)) score += 5;
	if (/质量标准|质量目标|合格|优良/u.test(normalized)) score += 4;
	if (/建设地点|建设规模|招标范围|项目概况与招标范围/u.test(normalized)) score += 4;
	if (/工程量|清单|图纸|设计说明|施工范围|施工内容|材料|设备|工艺|验收|复试|检测/u.test(normalized)) score += 3;
	if (/保证金账户|开户行|开户名称|收款账户|汇款|转账账户|电子交易系统|公共资源交易|开标时间|开标地点|评标委员会|评标办法/u.test(normalized)) score -= 4;
	return score;
}
var init_projectBasicInfo = __esmMin((() => {
	init_factsModel();
	init_factGovernance();
	init_markdownCleanup();
}));
//#endregion
//#region .dbg/c3-measure.ts
/**
* C3 测量脚本：数据链类（D6 池净化 + P2 四链扩容）归零验证——覆盖 C3-5 清单落位链与 C3-6 图纸事实引用链：
* ① s28l 清单落位基线复算（C3-5 单源字面口径：buildBoqRowTraces 行识别/豁免/落位判定唯一实现，
*    对照 probe16 基线 982 行/135 unique）；豁免行登记核对（口径行不入分母）；
* ② 修复链离线复算：未落位项 unique 聚合 → 责任章映射（assignBillRowChapter 单源，复现
*    contentDepthRepair.boqPlacementAssignments 口径）→ 分布核对（probe22 实测 4 章 130/3/1/1）
*    → 逐章注入补写 → 复算落位率（目标 ≥92%）→ 未落位归零；
* ③ r28l 同链复算（probe16 基线 37 行/20 unique → 注入归零）；
* ④ 通用性抽查（防误伤）：三通道单源直测（首段主名/整名/编码）、豁免行不进未落位清单、
*    归零后幂等（二次复算零变化）、无未落位项时分配空表（零触发形态）；
* ⑤ C3-6 图纸事实引用链归零验证（图纸锁 KB 重建与 tmp-c3-probe-drawing 同源口径）：分母治理
*    （目录类剔除/token 提纯）+ 注入覆盖扩容（never-injected=0）+ 修复链离线仿真（复现
*    contentDepthRepair.drawingPlacementAssignments 分配口径 → 逐章注入事实行 → 引用率 ≥90%）+
*    通用性直测（提纯正/反样本、幂等、基线已引用份防误伤）；
* ⑥ C3-4 参数义务链 + C3-7 D6 判据加固复算（value 口径，与 usableParameterFacts 判定对象一致）：
*    出池计数与 3 字符残片新可达面（s28l 28 / r28l 2）+ 类别分布 + 义务归因（used/relevantMissed/
*    irrelevantMissed/noiseExcluded，与检测门禁/报告审计/修复分配同源单源）+ 门禁触发状态 +
*    修复分配覆盖 + 保留池合法值零误伤直测。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c3-measure.config.mjs
*   node apps/server/.audit-out/c3-measure.mjs
*/
var require_c3_measure = /* @__PURE__ */ __commonJSMin((() => {
	init_documentFactTrace();
	init_billFactLock();
	init_drawingFactLock();
	init_kbService();
	init_projectBasicInfo();
	init_projectMaterialProfile();
	init_chapterParameterFacts();
	init_poolNoise();
	init_tenderRequirements();
	const DOCS = [{
		name: "r28l 丰乐",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884268681-31f4980c.json"
	}, {
		name: "s28l 舒城",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884273697-ea5fbe91.json"
	}];
	let failures = 0;
	function check(label, pass, detail = "") {
		console.log(`${pass ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`);
		if (!pass) failures += 1;
	}
	function loadDraft(file) {
		const wrapper = JSON.parse(readFileSync(file, "utf8"));
		const layer = wrapper.draft ?? wrapper;
		return {
			markdown: String(layer.markdown ?? wrapper.markdown ?? ""),
			factsModel: layer.factsModel ?? wrapper.factsModel,
			chapters: ((layer.chapters ?? wrapper.chapters) || []).map((chapter) => ({
				id: String(chapter.id || ""),
				title: String(chapter.title || ""),
				content: String(chapter.content || ""),
				sections: (chapter.sections || []).map((section) => typeof section === "string" ? section : String(section?.title || section?.name || "")).filter(Boolean)
			})),
			projectRoot: String(layer.projectRoot || "/Users/pan/Desktop/codeing/customize-agent"),
			sources: (layer.sources || []).map((item) => String(item?.filePath || "")).filter(Boolean)
		};
	}
	/** 复现 contentDepthRepair.boqPlacementAssignments（离线复算口径）：未落位项 unique 聚合
	* （首 40 字符归并）→ 责任章映射（assignBillRowChapter 单源）→ 章索引（标题相等，回退施工方法类章） */
	function planAssignments(traces, chapters) {
		const assignments = /* @__PURE__ */ new Map();
		const unmapped = [];
		const remaining = traces.filter((trace) => !trace.exempt && !trace.placed && trace.itemName.trim());
		const groups = /* @__PURE__ */ new Map();
		for (const trace of remaining) {
			const key = trace.itemName.slice(0, 40);
			const group = groups.get(key);
			if (group) group.rows += 1;
			else groups.set(key, {
				name: trace.itemName,
				code: trace.itemCode,
				rows: 1,
				sample: trace
			});
		}
		for (const group of [...groups.values()].sort((left, right) => right.rows - left.rows)) {
			const assignment = assignBillRowChapter({
				name: group.name,
				description: group.sample.description || ""
			}, chapters);
			const mapped = assignment ? chapters.findIndex((chapter) => chapter.title === assignment.chapterTitle) : -1;
			const index = mapped >= 0 ? mapped : chapters.findIndex((chapter) => /主要施工|分部分项|施工方法/u.test(chapter.title));
			if (index < 0) {
				unmapped.push(group.name);
				continue;
			}
			const list = assignments.get(index) ?? [];
			list.push({
				name: group.name,
				code: group.code,
				rows: group.rows,
				quantity: `${group.sample.quantity || ""}${group.sample.unit || ""}`.trim(),
				section: assignment?.section
			});
			assignments.set(index, list);
		}
		return {
			assignments,
			unmapped,
			groupCount: groups.size
		};
	}
	/** 模拟修复补写（真实修复轮 LLM 输出的最小近似）：逐章章尾注入「名称+工程量」自然句 */
	function injectRepair(markdown, chapters, assignments) {
		let out = markdown;
		let injected = 0;
		for (const [index, items] of assignments) {
			const text = items.map((item) => `本节完成${item.name}${item.quantity ? `（${item.quantity}）` : ""}施工，按清单工程量与相应工艺标准组织作业。`).join("");
			const anchor = chapters[index].content.replace(/\s+$/u, "").slice(-100);
			const at = anchor ? out.lastIndexOf(anchor) : -1;
			out = at >= 0 ? `${out.slice(0, at + anchor.length)}\n\n${text}${out.slice(at + anchor.length)}` : `${out}\n\n${text}`;
			injected += items.length;
		}
		return {
			markdown: out,
			injected
		};
	}
	function boqStats(traces) {
		const effective = traces.filter((trace) => !trace.exempt);
		const missing = effective.filter((trace) => !trace.placed);
		const unique = new Set(missing.filter((trace) => trace.itemName.trim()).map((trace) => trace.itemName.slice(0, 40)));
		return {
			rows: traces.length,
			effective: effective.length,
			exempt: traces.length - effective.length,
			placed: effective.length - missing.length,
			missing: missing.length,
			unique: unique.size,
			rate: effective.length > 0 ? (effective.length - missing.length) / effective.length : null,
			missingNames: missing.map((trace) => trace.itemName)
		};
	}
	const pct = (rate) => rate === null ? "n/a" : `${(rate * 100).toFixed(2)}%`;
	/** 未引用份 → 责任章映射（复现修复轮口径：事实行前 8 行 vs 章 token 相关性 argmax →
	* 回退设计/说明/构造类章 → 回退主要施工/分部分项类章 → 8 章预算截断按份数降序保留） */
	function planDrawingAssignments(lock, markdown, chapters) {
		const { unreferenced } = drawingFactPlacement(lock, markdown);
		const chapterTokens = chapters.map((chapter) => chapterRelevanceTokens(chapter.title, chapter.sections || []).map((token) => token.toLowerCase()));
		const assignments = /* @__PURE__ */ new Map();
		const unmapped = [];
		for (const group of unreferenced) {
			const factText = group.factLines.slice(0, 8).join(" ").toLowerCase();
			let bestIndex = -1;
			let bestScore = 0;
			chapterTokens.forEach((tokens, index) => {
				const score = tokens.reduce((sum, token) => sum + (factText.includes(token) ? 1 : 0), 0);
				if (score > bestScore) {
					bestScore = score;
					bestIndex = index;
				}
			});
			if (bestIndex < 0) bestIndex = chapters.findIndex((chapter) => /设计|说明|构造|做法|施工方法|施工工艺/u.test(chapter.title));
			if (bestIndex < 0) bestIndex = chapters.findIndex((chapter) => /主要施工|分部分项/u.test(chapter.title));
			const name = group.sourceFile.split("/").pop() || group.sourceFile;
			if (bestIndex < 0) {
				unmapped.push(name);
				continue;
			}
			const writeIndex = group.factLines.map((line) => line.replace(/\s+/gu, "").replace(/：/gu, ":").toLowerCase()).findIndex((text) => group.tokens.some((token) => text.includes(token)));
			const writeLine = group.factLines[writeIndex >= 0 ? writeIndex : 0] || "";
			const list = assignments.get(bestIndex) ?? [];
			list.push({
				name,
				lines: [writeLine]
			});
			assignments.set(bestIndex, list);
		}
		return {
			unreferenced,
			assignments: assignments.size > 8 ? new Map([...assignments.entries()].sort((left, right) => right[1].length - left[1].length).slice(0, 8)) : assignments,
			unmapped,
			groupCount: assignments.size
		};
	}
	/** 仿真修复补写（真实修复轮 LLM 输出的最小近似）：逐章章尾注入「设计说明+规格事实行」自然句 */
	function injectDrawingRepair(markdown, chapters, assignments) {
		let out = markdown;
		let injected = 0;
		for (const [index, items] of assignments) {
			const text = items.map((item) => `按设计说明与构造做法施工：${item.lines[0]}。`).join("");
			const anchor = chapters[index].content.replace(/\s+$/u, "").slice(-100);
			const at = anchor ? out.lastIndexOf(anchor) : -1;
			out = at >= 0 ? `${out.slice(0, at + anchor.length)}\n\n${text}${out.slice(at + anchor.length)}` : `${out}\n\n${text}`;
			injected += items.length;
		}
		return {
			markdown: out,
			injected
		};
	}
	/** 图纸锁 KB 重建（与 tmp-c3-probe-drawing 同源口径：sources 快照 ∩ active → chunk 过滤 → buildDrawingFactLock） */
	async function rebuildDrawingLock(projectRoot, sources) {
		const sourceSet = new Set(sources);
		const project = await getMultiProjectManager().getProject(projectRoot);
		const files = project.listFiles().filter((file) => file.status === "active" && sourceSet.has(file.relativePath));
		const processingByPath = /* @__PURE__ */ new Map();
		const evidence = [];
		let drawingFiles = 0;
		for (const file of files) {
			const kind = inferMaterialKind(file.relativePath).kind;
			const processing = kind === "drawing" ? "drawing" : kind === "bill_of_quantities" ? "table" : kind === "technical_specification" ? "specification" : kind === "tender_document" || kind === "addendum" ? "rule" : "reference";
			processingByPath.set(file.relativePath, processing);
			if (processing === "drawing") drawingFiles += 1;
			let detail;
			try {
				detail = project.getFileDetail?.(file.relativePath);
			} catch {
				detail = void 0;
			}
			if (!detail?.chunks?.length) continue;
			for (const chunk of detail.chunks) {
				const score = projectBasicFactScore(`${chunk.sectionTitle || ""}\n${chunk.content || ""}`);
				if (score <= 0) continue;
				evidence.push({
					chapterId: "project-basic",
					filePath: file.relativePath,
					score: 1 + score,
					content: chunk.content,
					processingType: processing,
					sectionTitle: chunk.sectionTitle,
					source: "pinned-evidence"
				});
			}
		}
		return {
			lock: buildDrawingFactLock({
				evidence,
				fileProcessingByPath: processingByPath
			}),
			evidenceCount: evidence.length,
			drawingFiles
		};
	}
	async function drawingC36Section() {
		console.log("\n================ ⑤ C3-6 图纸事实引用归零验证（分母净化 / 注入扩容 / 修复仿真 / 防误伤） ================");
		for (const doc of DOCS) {
			const { markdown, chapters, projectRoot, sources } = loadDraft(doc.file);
			const { lock, evidenceCount, drawingFiles } = await rebuildDrawingLock(projectRoot, sources);
			if (!lock) {
				check(`${doc.name}：图纸锁构建`, false, "无可重建证据（无锁）");
				continue;
			}
			console.log(`  [${doc.name}] drawing 文件 ${drawingFiles}；evidence ${evidenceCount}；lock groups=${lock.groups.length} usable=${lock.usableDrawings} unusable=${lock.unusableDrawings}`);
			check(`${doc.name}：目录类文件零入锁（分母治理）`, lock.groups.every((group) => !/图纸目录|设计目录|图纸清单|目录表/u.test(group.sourceFile.split("/").pop() || group.sourceFile)));
			check(`${doc.name}：token 提纯零残片（colN/xNNN）`, lock.groups.every((group) => group.tokens.every((token) => !/^col\d+$/u.test(token) && !/^x\d+$/u.test(token))));
			const placement = drawingFactPlacement(lock, markdown);
			console.log(`  基线复算：referenced=${placement.referenced.length} unreferenced=${placement.unreferenced.length} rate=${pct(placement.rate)}`);
			if (doc.name.startsWith("r28l")) check("r28l 分母治理实证：目录剔除后 groups 2→1、真实图纸 1/1 全引用（基线 1/2=50% → 净化 100%）", lock.groups.length === 1 && placement.unreferenced.length === 0 && placement.rate === 1, `groups=${lock.groups.length} unref=${placement.unreferenced.length} rate=${pct(placement.rate)}`);
			else check("s28l 基线复算：groups=118 / referenced=89 / unref=29（对照 C3-6-1 probe 基线）", lock.groups.length === 118 && placement.referenced.length === 89 && placement.unreferenced.length === 29, `groups=${lock.groups.length} ref=${placement.referenced.length} unref=${placement.unreferenced.length}`);
			const injected = /* @__PURE__ */ new Set();
			for (const chapter of chapters) {
				const text = renderDrawingFactLockText(lock, chapter.title, { sections: chapter.sections || [] });
				for (const group of lock.groups) {
					const basename = group.sourceFile.split("/").pop() || group.sourceFile;
					if (text.includes(`${basename}｜`)) injected.add(group.sourceFile);
				}
			}
			const neverInjected = lock.groups.filter((group) => !injected.has(group.sourceFile));
			const unrefNeverInjected = placement.unreferenced.filter((group) => !injected.has(group.sourceFile));
			console.log(`  注入覆盖：${injected.size}/${lock.groups.length}（从未注入 ${neverInjected.length}）；未引用 ${placement.unreferenced.length} 中从未注入 ${unrefNeverInjected.length}`);
			check(`${doc.name}：注入全覆盖（never-injected=0；C3-6-3 前 s28l 基线 96/118 从未注入）`, neverInjected.length === 0, `从未注入=${neverInjected.length}`);
			check(`${doc.name}：未引用份全部曾获注入（C3-6-1 基线 s28l 20/29 从未注入）`, unrefNeverInjected.length === 0, `未引用∩从未注入=${unrefNeverInjected.length}`);
			const plan = planDrawingAssignments(lock, markdown, chapters);
			const distribution = [...plan.assignments.entries()].map(([index, items]) => `${chapters[index].title.slice(0, 14)}=${items.length}`).join(" | ");
			console.log(`  修复仿真：未引用 ${plan.unreferenced.length} → 映射 ${plan.assignments.size} 章（分配前 ${plan.groupCount} 章，8 章预算）/ 未映射 ${plan.unmapped.length}；分布：${distribution || "无"}`);
			check(`${doc.name}：未引用份全部可映射责任章（无未映射）`, plan.unmapped.length === 0, `未映射=${plan.unmapped.length}`);
			if (plan.unreferenced.length === 0) check(`${doc.name}：零载荷直通（无未引用 → 修复轮零触发形态）`, plan.assignments.size === 0);
			else {
				const repaired = injectDrawingRepair(markdown, chapters, plan.assignments);
				const after = drawingFactPlacement(lock, repaired.markdown);
				console.log(`  注入 ${repaired.injected} 份事实行 → 复算 referenced=${after.referenced.length}/${lock.groups.length}（${pct(after.rate)}），残留未引用 ${after.unreferenced.length}`);
				check(`${doc.name}：修复仿真后引用率 ≥90%（目标线达成）`, after.rate >= .9, `rate=${pct(after.rate)}`);
				check(`${doc.name}：基线已引用份修复后保持引用（防误伤）`, placement.referenced.every((group) => after.referenced.some((item) => item.sourceFile === group.sourceFile)));
				const idempotent = planDrawingAssignments(lock, repaired.markdown, chapters);
				check(`${doc.name}：归零后幂等（二次复算零未引用/零载荷）`, idempotent.unreferenced.length === 0 && idempotent.assignments.size === 0, `残留 unref=${idempotent.unreferenced.length}`);
			}
		}
		console.log("\n  ── 通用性抽查（防误伤，直测） ──");
		check("提纯直测：colN 列名残片剔除（正文永不含该形态）", extractDrawingFactTokens("图纸目录 col2 col10 名称").length === 0, extractDrawingFactTokens("图纸目录 col2 col10 名称").join(","));
		const sizeTokens = extractDrawingFactTokens("标准图框（420x594）与 18x18x3 厚镀锌钢管");
		check("提纯直测：完整尺寸对保留（420x594/18x18）、拆分残片剔除（x594/x18）", sizeTokens.includes("420x594") && sizeTokens.includes("18x18") && !sizeTokens.includes("x594") && !sizeTokens.includes("x18"), sizeTokens.join(","));
		const specTokens = extractDrawingFactTokens("检查井盖板采用 C25 混凝土，做法参 02S515 页 96，管径 DN100");
		check("提纯反样本：真实规格代号/C25/DN100/图集编号保留不受提纯影响", specTokens.includes("c25") && specTokens.includes("dn100") && specTokens.includes("02s515"), specTokens.join(","));
	}
	/** value 口径池普查（复现 usableParameterFacts 判定对象：键/字段名是分类标签会遮蔽值首形态，仅值参与噪声判定） */
	function censusParameterPool(factsModel) {
		const pool = factsModel.factIndex?.parameterFacts?.length ? factsModel.factIndex.parameterFacts : factsModel.preciseFacts || [];
		const noise = [];
		const kept = [];
		for (const fact of pool) {
			const value = String(fact?.value || "").trim();
			if (!value) continue;
			const category = classifyPoolNoiseText(value);
			if (category) noise.push({
				value,
				category
			});
			else kept.push(value);
		}
		const compact = (value) => value.replace(/\s+/gu, "");
		return {
			pool: pool.length,
			noise,
			kept,
			threeCharNoise: noise.filter((item) => compact(item.value).length === 3).map((item) => item.value),
			threeCharKept: kept.filter((value) => compact(value).length === 3)
		};
	}
	/** 修复分配值 → 取值集（分配 Map 章索引 → 值列表） */
	function assignedParameterValues(assignments) {
		return [...assignments.values()].flat();
	}
	/** 仿真修复补写（参数义务轮形态）：逐章章尾注入「按设计要求采用 X 标准控制」自然句（值原形态照抄） */
	function injectParameterRepair(markdown, chapters, assignments) {
		let out = markdown;
		let injected = 0;
		for (const [index, values] of assignments) {
			const text = values.map((value) => `本节相关部位按设计要求采用 ${value} 标准控制施工质量，验收指标以设计文件为准。`).join("");
			const anchor = chapters[index].content.replace(/\s+$/u, "").slice(-100);
			const at = anchor ? out.lastIndexOf(anchor) : -1;
			out = at >= 0 ? `${out.slice(0, at + anchor.length)}\n\n${text}${out.slice(at + anchor.length)}` : `${out}\n\n${text}`;
			injected += values.length;
		}
		return {
			markdown: out,
			injected
		};
	}
	async function parameterC37Section() {
		console.log("\n================ ⑥ C3-4 参数义务链 + C3-7 D6 判据加固复算（value 口径） ================");
		for (const doc of DOCS) {
			const { markdown, factsModel, chapters } = loadDraft(doc.file);
			const chapterInputs = chapters.map((chapter) => ({
				title: chapter.title,
				sections: chapter.sections || []
			}));
			const census = censusParameterPool(factsModel);
			const categoryCensus = {};
			for (const item of census.noise) categoryCensus[item.category] = (categoryCensus[item.category] || 0) + 1;
			console.log(`  [${doc.name}] 参数池 ${census.pool} 条 → value 口径出池 ${census.noise.length}（${JSON.stringify(categoryCensus)}）/ 保留 ${census.kept.length}`);
			console.log(`  3 字符残片新可达（门槛 3 修正面）：${census.threeCharNoise.join("、") || "无"}`);
			console.log(`  3 字符合法值零误伤：${census.threeCharKept.join("、") || "无"}`);
			if (doc.name.startsWith("r28l")) {
				check("r28l 3 字符残片实证：H.1/E.1 两条新可达出池（对照 C3-7 实机复算）", census.threeCharNoise.length === 2 && ["H.1", "E.1"].every((value) => census.threeCharNoise.includes(value)), `实测=${census.threeCharNoise.length} 条：${census.threeCharNoise.join("、")}`);
				check("r28l 合法 3 字符值零误伤（C60/W3L/C25/C20/C30/8cm 保留）", [
					"C60",
					"W3L",
					"C25",
					"C20",
					"C30",
					"8cm"
				].every((value) => census.threeCharKept.includes(value)), census.threeCharKept.join("、"));
			} else {
				check("s28l 3 字符残片实证：28 条新可达（H.4/O.8/12月/08月/05月 族；对照 C3-7 实机复算）", census.threeCharNoise.length === 28 && [
					"H.4",
					"O.8",
					"12月",
					"08月",
					"05月"
				].every((value) => census.threeCharNoise.includes(value)), `实测=${census.threeCharNoise.length} 条：${census.threeCharNoise.join("、")}`);
				check("s28l 合法 3 字符值零误伤（4mm/5cm/M15/AL1/L63/09m/0mm 保留）", [
					"4mm",
					"5cm",
					"M15",
					"AL1",
					"L63",
					"09m",
					"0mm"
				].every((value) => census.threeCharKept.includes(value)), census.threeCharKept.join("、"));
			}
			const breakdown = classifyParameterUsage(markdown, factsModel, chapterInputs);
			const obligationTotal = breakdown.used.length + breakdown.relevantMissed.length;
			const rate = obligationTotal > 0 ? breakdown.used.length / obligationTotal : null;
			console.log(`  义务归因：used=${breakdown.used.length} / relevantMissed=${breakdown.relevantMissed.length} / irrelevantMissed=${breakdown.irrelevantMissed.length} / noiseExcluded=${breakdown.noiseExcluded.length}；义务满足率 ${rate === null ? "n/a" : `${(rate * 100).toFixed(2)}%`}`);
			check(`${doc.name}：归因四元组守恒（totalParams = used + rMissed + iMissed）`, breakdown.totalParams === breakdown.used.length + breakdown.relevantMissed.length + breakdown.irrelevantMissed.length, `total=${breakdown.totalParams} used=${breakdown.used.length} r=${breakdown.relevantMissed.length} i=${breakdown.irrelevantMissed.length}`);
			check(`${doc.name}：noiseExcluded 与 value 口径出池同源（⊆ 池噪声）`, breakdown.noiseExcluded.every((item) => census.noise.some((entry) => entry.value === String(item.fact.value).trim())), `noiseExcluded=${breakdown.noiseExcluded.length}`);
			const gateIssues = parameterObligationUsageIssues(markdown, factsModel, chapterInputs);
			const gateExpected = chapterInputs.length > 0 && obligationTotal >= 8 && rate < .9;
			console.log(`  门禁状态：${gateIssues.length > 0 ? `触发（${String(gateIssues[0].message).slice(0, 64)}…）` : "静默"}（义务集 ${obligationTotal} 项${obligationTotal < 8 ? `，小于最小值 8 不判定` : ""}）`);
			check(`${doc.name}：门禁与归因同源（触发状态 = rate<门槛 ∧ 义务集≥8）`, gateIssues.length === (gateExpected ? 1 : 0), `触发=${gateIssues.length} 期望=${gateExpected ? 1 : 0}`);
			const assignments = assignMissingParameterChapters(markdown, factsModel, chapterInputs);
			const assignedValues = assignedParameterValues(assignments);
			const missedValues = new Set(breakdown.relevantMissed.map((fact) => String(fact.value).trim()));
			const chapterDistribution = [...assignments.entries()].map(([index, list]) => `${chapters[index].title.slice(0, 12)}=${list.length}`).join(" | ");
			console.log(`  修复分配：${assignedValues.length}/${breakdown.relevantMissed.length} 条 → ${assignments.size} 章（每章 ≤16 / 总量 ≤96）；分布：${chapterDistribution || "无"}`);
			check(`${doc.name}：分配值全部来自义务集（检测定位=修复定位）`, assignedValues.every((value) => missedValues.has(value)), `分配=${assignedValues.length}`);
			check(`${doc.name}：分配限额生效（每章 ≤16 / 总量 ≤96）`, [...assignments.values()].every((list) => list.length <= 16) && assignedValues.length <= 96);
			const repaired = injectParameterRepair(markdown, chapters, assignments);
			const after = classifyParameterUsage(repaired.markdown, factsModel, chapterInputs);
			const afterTotal = after.used.length + after.relevantMissed.length;
			const afterRate = afterTotal > 0 ? after.used.length / afterTotal : null;
			console.log(`  注入 ${repaired.injected} 条 → 复算 used=${after.used.length} relevantMissed=${after.relevantMissed.length}（${afterRate === null ? "n/a" : `${(afterRate * 100).toFixed(2)}%`}）`);
			check(`${doc.name}：修复仿真后义务满足率 ≥90%（或义务集归零）`, afterTotal === 0 || afterRate >= .9, `rate=${afterRate === null ? "n/a" : pct(afterRate)}`);
			check(`${doc.name}：基线已用参数修复后保持 used（防误伤）`, breakdown.used.every((fact) => after.used.some((item) => String(item.value) === String(fact.value))));
			check(`${doc.name}：修复后噪声出池登记不变（净化幂等）`, after.noiseExcluded.length === breakdown.noiseExcluded.length, `前=${breakdown.noiseExcluded.length} 后=${after.noiseExcluded.length}`);
		}
		console.log("\n  ── 通用性抽查（防误伤，直测） ──");
		check("直测：3 字符表号标号新可达（H.4/E.1/O.8 → numeric_smear）", classifyPoolNoiseText("H.4") === "numeric_smear" && classifyPoolNoiseText("E.1") === "numeric_smear" && classifyPoolNoiseText("O.8") === "numeric_smear");
		check("直测：独立月份新可达（12月/05 月 → date_fragment）", classifyPoolNoiseText("12月") === "date_fragment" && classifyPoolNoiseText("05 月") === "date_fragment");
		check("直测：3 字符合法值零误伤（C60/M15/L63/4mm/8cm/09m）", [
			"C60",
			"M15",
			"L63",
			"4mm",
			"8cm",
			"09m"
		].every((value) => classifyPoolNoiseText(value) === void 0));
		check("直测：图签守卫统一（资格条款零误伤 + 图签残片仍判定）", classifyPoolNoiseText("投标人须提供工程设计甲级资质证书") === void 0 && classifyPoolNoiseText("安徽省城建设计研究总院 出图专用章") === "drawing_signature");
	}
	const REQUIREMENT_POOL_BASELINES = [{
		doc: "r28l 丰乐",
		file: "/Users/pan/Desktop/codeing/customize-agent/.dbg/calibration/requirement-pool-r28l.json",
		pool: 88
	}, {
		doc: "s28l 舒城",
		file: "/Users/pan/Desktop/codeing/customize-agent/.dbg/calibration/requirement-pool-s28l.json",
		pool: 353
	}];
	/** 仿真修复补写（要求响应轮最小近似）：缺失锚点逐条注入自然句；
	* 真实修复轮为 LLM 按 voice 素材补写、复检用 tenderRequirementResponseGaps 同源（此处直接以同源口径验证收敛面） */
	function injectRequirementRepair(markdown, missingAnchors) {
		return `${markdown}\n\n${missingAnchors.map((anchor) => `本工程${anchor}相关要求已全面纳入施工管理，逐项按招标文件约定口径落实到位。`).join("")}`;
	}
	async function requirementC32Section() {
		console.log("\n================ ⑦ C3-2 池净化 + C3-3 锚点链归零验证（生成时基线复算） ================");
		for (const base of REQUIREMENT_POOL_BASELINES) {
			const doc = DOCS.find((item) => item.name === base.doc);
			if (!doc) {
				check(`${base.doc}：文档定位`, false);
				continue;
			}
			const { markdown } = loadDraft(doc.file);
			const model = JSON.parse(readFileSync(base.file, "utf8"));
			const entries = model.entries || [];
			const reconciliation = model.reconciliation || {};
			console.log(`  [${doc.name}] 生成时池 ${entries.length} 条（extracted=${model.extracted}；excluded=${(model.excluded || []).length}；reconciliation=${JSON.stringify(reconciliation)}）`);
			check(`${doc.name}：生成时池基数复算（对照固化基线）`, entries.length === base.pool, `实测=${entries.length}`);
			const noiseEntries = entries.filter((entry) => isRequirementPoolNoiseClause(entry.text));
			const noiseCensus = {};
			for (const entry of noiseEntries) {
				const category = classifyPoolNoiseText(entry.text.trim().replace(/\s+/gu, "")) || "clause_rule";
				noiseCensus[category] = (noiseCensus[category] || 0) + 1;
			}
			console.log(`  D6 净化复算：出池 ${noiseEntries.length}/${entries.length}（${JSON.stringify(noiseCensus)}）`);
			const respondCount = entries.filter((entry) => entry.policy !== "comply").length;
			const effective = entries.filter((entry) => entry.policy !== "comply" && !isRequirementPoolNoiseClause(entry.text));
			const gaps = tenderRequirementResponseGaps(effective, markdown);
			const satisfied = gaps.filter((gap) => gap.satisfied).length;
			const anchorsTotal = gaps.reduce((sum, gap) => sum + gap.hit.length + gap.missing.length, 0);
			const anchorsHit = gaps.reduce((sum, gap) => sum + gap.hit.length, 0);
			console.log(`  respond=${respondCount} / comply=${entries.length - respondCount}；净化后 respond ${effective.length} 条：satisfied=${satisfied}（${effective.length > 0 ? pct(satisfied / effective.length) : "n/a"}）`);
			console.log(`  锚点覆盖基线：其中已净化出池 ${noiseEntries.filter((entry) => entry.policy !== "comply").length} 条（旧分母）；净化后锚点 ${anchorsHit}/${anchorsTotal}（${anchorsTotal > 0 ? pct(anchorsHit / anchorsTotal) : "n/a"}）`);
			const missingAll = [...new Set(gaps.flatMap((gap) => gap.missing))];
			const unrepairable = gaps.filter((gap) => !gap.satisfied && gap.hit.length + gap.missing.length === 0).length;
			const after = tenderRequirementResponseGaps(effective, injectRequirementRepair(markdown, missingAll));
			const afterSatisfied = after.filter((gap) => gap.satisfied).length;
			const afterTotal = after.reduce((sum, gap) => sum + gap.hit.length + gap.missing.length, 0);
			const afterHit = after.reduce((sum, gap) => sum + gap.hit.length, 0);
			console.log(`  注入 ${missingAll.length} 个缺失锚点 → 复算 satisfied=${afterSatisfied}/${effective.length}（零锚点不可修复 ${unrepairable}），锚点 ${afterHit}/${afterTotal}（${afterTotal > 0 ? pct(afterHit / afterTotal) : "n/a"}）`);
			check(`${doc.name}：修复仿真后锚点覆盖 ≥88%（P2 目标）或缺失归零`, afterTotal === 0 || afterHit / afterTotal >= .88, `rate=${pct(afterHit / afterTotal)}`);
			check(`${doc.name}：修复仿真后条款全满足（缺失锚点注入面达成）`, afterSatisfied === effective.length - unrepairable, `${afterSatisfied}/${effective.length}（不可修复 ${unrepairable}）`);
			check(`${doc.name}：基线已满足条款修复后保持满足（防误伤）`, gaps.every((gap, index) => !gap.satisfied || after[index].satisfied));
			check(`${doc.name}：池净化判定幂等（同池复算出池面一致）`, entries.filter((entry) => isRequirementPoolNoiseClause(entry.text)).length === noiseEntries.length);
		}
		const asset = JSON.parse(readFileSync("/Users/pan/Desktop/codeing/customize-agent/.dbg/calibration/requirement-assignments-s28l.json", "utf8"));
		const s28lPool = JSON.parse(readFileSync(REQUIREMENT_POOL_BASELINES[1].file, "utf8"));
		const poolTexts = new Set((s28lPool.entries || []).map((entry) => entry.text));
		const assignments = asset.assignments || [];
		const unaccounted = assignments.filter((item) => !poolTexts.has(item.entry.text));
		check("s28l：生成时分配资产 ⊆ 生成时池（对账闭合，同源实证）", unaccounted.length === 0, `total=${asset.total} 未匹配=${unaccounted.length}`);
		const tocAssigned = assignments.filter((item) => classifyPoolNoiseText(item.entry.text.trim().replace(/\s+/gu, "")));
		console.log(`  [s28l 分配资产 ${asset.createdAt}] 生成时 D6 噪声条目曾进入责任章映射：${tocAssigned.length} 条——${tocAssigned.slice(0, 3).map((item) => `${item.chapterTitle}←「${item.entry.text.slice(0, 20)}…」`).join("；") || "无"}`);
		check("s28l 生成时误挂靠实证：目录行等噪声条目曾被分配（现判定全部出池）", tocAssigned.length > 0, `${tocAssigned.length} 条`);
	}
	async function main() {
		const r28l = loadDraft(DOCS[0].file);
		const s28l = loadDraft(DOCS[1].file);
		console.log(`数据加载：r28l md=${r28l.markdown.length} 字符/章 ${r28l.chapters.length}；s28l md=${s28l.markdown.length} 字符/章 ${s28l.chapters.length}`);
		console.log("================ ① s28l 清单落位基线复算（C3-5 单源） ================");
		const s28lTraces = buildBoqRowTraces(s28l.markdown, s28l.factsModel);
		const s28lStats = boqStats(s28lTraces);
		const s28lGenericExempt = s28lTraces.filter((trace) => trace.exempt && BOQ_GENERIC_NAME_STOPWORDS.has(trace.itemName.replace(/\s+/gu, ""))).length;
		console.log(`  行级追踪 ${s28lStats.rows} 行（有效 ${s28lStats.effective} / 豁免 ${s28lStats.exempt}），字面落位 ${s28lStats.placed}/${s28lStats.effective}（${pct(s28lStats.rate)}），未落位 ${s28lStats.missing} 行/unique ${s28lStats.unique} 项`);
		check("基线复算：未落位 978 行（C3-5-8 泛词豁免后；豁免前 982 对照 probe16）", s28lStats.missing === 978, `实测=${s28lStats.missing}`);
		check("基线复算：unique 134 项（C3-5-8 后；豁免前 135）", s28lStats.unique === 134, `实测=${s28lStats.unique}`);
		check("豁免行登记（口径行/版式行不入分母）", s28lStats.exempt >= 696, `豁免=${s28lStats.exempt}`);
		check("泛词短名行登记豁免（C3-5-8 隐形分母消除：「软件」类 4 行）", s28lGenericExempt >= 4, `泛词豁免=${s28lGenericExempt}`);
		check("未落位清单零泛词短名行（泛词不构成落位义务）", !s28lStats.missingNames.some((name) => BOQ_GENERIC_NAME_STOPWORDS.has(name.replace(/\s+/gu, ""))), `残留泛词=${[...new Set(s28lStats.missingNames.filter((name) => BOQ_GENERIC_NAME_STOPWORDS.has(name.replace(/\s+/gu, ""))))].join("、") || "无"}`);
		console.log("\n================ ② s28l 修复链离线复算（分配 → 注入 → 归零） ================");
		const s28lPlan = planAssignments(s28lTraces, s28l.chapters);
		const s28lDistribution = [...s28lPlan.assignments.entries()].map(([index, items]) => `${s28l.chapters[index].title}=${items.length}`).join(" | ");
		console.log(`  责任章分布（${s28lPlan.assignments.size} 章 / ${s28lPlan.groupCount} 类）：${s28lDistribution}`);
		const s28lAssigned = [...s28lPlan.assignments.values()].reduce((sum, list) => sum + list.length, 0);
		check("未落位项全部映射责任章（无遗漏）", s28lPlan.unmapped.length === 0 && s28lAssigned === s28lStats.unique, `分配=${s28lAssigned}/${s28lStats.unique}，unmapped=${s28lPlan.unmapped.length}`);
		check("分布核对：4 章 129/3/1/1（C3-5-8 泛词豁免后；豁免前 130/3/1/1 对照 probe22）", s28lPlan.assignments.size === 4 && [...s28lPlan.assignments.values()].map((list) => list.length).sort((a, b) => b - a).join(",") === "129,3,1,1", s28lDistribution);
		const s28lRepair = injectRepair(s28l.markdown, s28l.chapters, s28lPlan.assignments);
		const s28lAfter = boqStats(buildBoqRowTraces(s28lRepair.markdown, s28l.factsModel));
		console.log(`  注入 ${s28lRepair.injected} 项 → 复算落位 ${s28lAfter.placed}/${s28lAfter.effective}（${pct(s28lAfter.rate)}），未落位 ${s28lAfter.missing} 行/unique ${s28lAfter.unique} 项`);
		if (s28lAfter.missing > 0) console.log(`  残留：${[...new Set(s28lAfter.missingNames)].slice(0, 8).join("、")}`);
		check("补写注入后字面落位率 = 100%（≥92% 目标达成）", s28lAfter.missing === 0, `残留 ${s28lAfter.missing} 行`);
		console.log("\n================ ③ r28l 同链复算（基线 → 分配 → 注入 → 归零） ================");
		const r28lTraces = buildBoqRowTraces(r28l.markdown, r28l.factsModel);
		const r28lStats = boqStats(r28lTraces);
		console.log(`  行级追踪 ${r28lStats.rows} 行（有效 ${r28lStats.effective} / 豁免 ${r28lStats.exempt}），字面落位 ${r28lStats.placed}/${r28lStats.effective}（${pct(r28lStats.rate)}），未落位 ${r28lStats.missing} 行/unique ${r28lStats.unique} 项`);
		check("基线复算：未落位 37 行/unique 20 项（对照 probe16）", r28lStats.missing === 37 && r28lStats.unique === 20, `实测=${r28lStats.missing} 行/${r28lStats.unique} 项`);
		const r28lPlan = planAssignments(r28lTraces, r28l.chapters);
		const r28lDistribution = [...r28lPlan.assignments.entries()].map(([index, items]) => `${r28l.chapters[index].title}=${items.length}`).join(" | ");
		console.log(`  责任章分布：${r28lDistribution}`);
		check("未落位项全部映射（对照 probe22：单章 20 项）", r28lPlan.unmapped.length === 0 && [...r28lPlan.assignments.values()].reduce((sum, list) => sum + list.length, 0) === r28lStats.unique, `分配章数=${r28lPlan.assignments.size}`);
		const r28lAfter = boqStats(buildBoqRowTraces(injectRepair(r28l.markdown, r28l.chapters, r28lPlan.assignments).markdown, r28l.factsModel));
		if (r28lAfter.missing > 0) console.log(`  残留：${[...new Set(r28lAfter.missingNames)].slice(0, 8).join("、")}`);
		check("补写注入后字面落位率 = 100%（≥92% 目标达成）", r28lAfter.missing === 0, `残留 ${r28lAfter.missing} 行`);
		console.log("\n================ ④ 通用性抽查（防误伤） ================");
		const longTrace = s28lTraces.find((trace) => normalizeBoqMatchText(trace.itemName).length >= 12 && trace.itemCode.length >= 8);
		if (longTrace) {
			check("通道①：首段主名 12 字符命中", boqItemCarriedInText(normalizeBoqMatchText(`前文描述 …… ${(String(longTrace.itemName).split(/[\s（(、，,;；:：]/u)[0] || "").slice(0, 12)} …… 后文`), longTrace.itemName, ""));
			check("通道②：整名命中", boqItemCarriedInText(normalizeBoqMatchText(`本节完成${longTrace.itemName}施工。`), longTrace.itemName, ""));
			check("通道③：编码 8 字符命中", boqItemCarriedInText(normalizeBoqMatchText(`工程编码 ${longTrace.itemCode.slice(0, 8)} 对应作业。`), longTrace.itemName, longTrace.itemCode));
			check("直测反样本：无关文本不误判", !boqItemCarriedInText(normalizeBoqMatchText("本节内容与清单条目无关。"), longTrace.itemName, longTrace.itemCode));
		} else check("三通道单源直测（样本选取）", false, "s28l 未找到长度/编码合规样本");
		const missingText = s28lStats.missingNames.join("、");
		check("豁免行形态零进入未落位清单（合计/小计/规费/税金）", !/(?:分部小计|合计|规费|税金)/u.test(missingText));
		check("归零后幂等：二次复算零未落位", boqStats(buildBoqRowTraces(s28lRepair.markdown, s28l.factsModel)).missing === 0);
		check("无未落位项时分配空表（零触发形态）", planAssignments(buildBoqRowTraces(s28lRepair.markdown, s28l.factsModel), s28l.chapters).assignments.size === 0);
		await drawingC36Section();
		await parameterC37Section();
		await requirementC32Section();
		console.log(`\n================ C3 归零验证结论（C3-5 清单落位 + C3-6 图纸引用 + C3-4/C3-7 参数义务 + C3-2/C3-3 要求池净化/锚点）：${failures === 0 ? "PASS（全项通过）" : `FAIL（${failures} 项未通过）`} ================`);
		if (failures > 0) process.exit(1);
	}
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}));
//#endregion
export default require_c3_measure();
export {};
