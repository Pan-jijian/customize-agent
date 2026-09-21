import { A as BID_DISCIPLINE_PHRASES, B as init_semanticSimilarity, C as init_tuningProfile, D as init_documentRoleService, E as init_projectMaterialService, G as MARKDOWN_TABLE_ROW_RE, H as FORMAL_PLACEHOLDER_PATTERNS, I as init_budget, K as TABLE_PLACEHOLDER_APPROX_RE, L as SEMANTIC_COVERAGE_THRESHOLD, M as stableHash, N as stringifyFactValue, O as getProjectRoot, P as documentTextLength, R as buildSemanticSimilarity, S as init_llmClient, T as init_configService, U as LINE_SPLIT_RE, V as init_constants, W as MARKDOWN_TABLE_DIVIDER_RE, X as __esmMin, _ as init_writingSpec, b as init_semanticGate, c as init_projectMaterialProfile, d as init_factMatching, f as init_projectGraph, g as init_constructionOrgTablePlan, h as mergeTableLineBreaks, j as init_utils, k as init_kbService, l as init_agentWorkflow, m as init_markdownComposer, p as docSystemPrefix, q as TABLE_PLACEHOLDER_CELL_FORMS_RE, r as init_outline$1, s as init_templateStore, u as init_evidence, v as init_workflowRules, w as tuningProfile, x as concurrencyForDocumentScale, y as buildSemanticGate, z as getLocalSemanticProvider } from "./outline-CDnkJb_C.js";
import { a as init_promptRuleExtraction, o as init_sectionNamingGovernance, s as init_sectionFingerprint } from "./promptRuleExtraction-Dnb4RKtl.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeProjectId } from "@customize-agent/knowledge";
import * as path$1 from "path";
import * as os$1 from "os";
import * as fs$1 from "fs";
import "xlsx";
var init_documentFactTrace = __esmMin((() => {
	new RegExp(`(?:GB|JGJ|CJJ|CECS|ISO|SL|DL|JTS|JTG|JT|TB|DB\\d{2}|DB)\\s*\\/?\\s*T?\\s*(\\d{3,5})(?:\\s*[-—–]\\s*(\\d{2,4}))?`, "giu");
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
//#region apps/server/src/services/document-workflow/integrity/authorities/authorities.ts
/** 劳动力数值语境分组（F6）：management=管理口径、trade=工种口径（含工种名）、peak=总峰值口径。
*  数字前 30 字符窗口内判定，窗口从最近分隔符（，、，;；:：）后截断——
*  防「主体结构阶段投入钢筋工60人、木工80人，高峰人数约220人」的 220 被前句工种词串染；
*  检测器 resourceConsistencyIssues 与确定性修复器 fixLaborPeakConflicts 共用同一分组口径
*  （检测/修复同源，避免双份实现漂移）
*  P1 修复（评分报告「按高峰期总人数20人配置专职安全员2名」的 20 被误划管理组根因）：
*  只判数字前窗口（主语）——数字后 12 字符是谓语（「配置专职安全员2名」的「安全员」属后一个数字），
*  原 before+after 联合窗口把总人数误划入 management 组，与 peak 组失去互查资格 → 20 vs 86 漏检 */
function laborPeakStageOf(markdown, index) {
	const before = markdown.slice(0, index);
	const boundary = Math.max(before.lastIndexOf("。"), before.lastIndexOf("；"), before.lastIndexOf(";"), before.lastIndexOf("\n"));
	let segment = markdown.slice(Math.max(0, boundary + 1), index);
	const cut = Math.max(segment.lastIndexOf("，"), segment.lastIndexOf("、"));
	if (cut >= 0 && (/(?:高峰期|高峰|峰值)/u.test(segment.slice(0, cut)) || !TRADE_WORKER_WORD_RE.test(segment.slice(0, cut)))) segment = segment.slice(cut + 1);
	let best;
	let bestPos = -1;
	for (const word of LABOR_STAGE_LIMIT_WORDS) {
		const pos = segment.lastIndexOf(word);
		if (pos > bestPos) {
			bestPos = pos;
			best = word;
		}
	}
	const generic = [...segment.matchAll(/[^，,。；;：:\n]{1,14}阶段/gu)].filter((match) => {
		const phrase = match[0].slice(0, -2);
		return !/^(?:各|每个|不同|相应)/u.test(phrase) && !/^[一二三四五六七八九十\d]{1,3}个/u.test(phrase) && !LABOR_STAGE_LIMIT_WORDS.some((word) => word.startsWith(phrase));
	}).pop();
	if (generic && (generic.index ?? 0) > bestPos) best = generic[0];
	return best;
}
/** 从 markdown 表格中识别劳动力相关表格块（表头结构识别，非内容词判定） */
function collectLaborTableBlocks(markdown) {
	const blocks = [];
	const lines = markdown.split(/\r?\n/u);
	const tableRowLineRe = /^\|.+\|$/u;
	const STAGE_COL_RE = /阶段|时期|工期|工序|进度/u;
	const COUNT_COL_RE = /人数|劳动力|作业人员|施工人员|投入人数/u;
	const separatorCellRe = /^:?-{3,}:?$/u;
	const cleanHeaderCell = (cell) => cell.replace(/[*_`~]/gu, "").trim();
	for (let index = 0; index < lines.length; index += 1) {
		if (!tableRowLineRe.test(lines[index].trim())) continue;
		const rows = [];
		while (index < lines.length && tableRowLineRe.test(lines[index].trim())) {
			rows.push(lines[index].trim());
			index += 1;
		}
		index -= 1;
		if (rows.length < 3) continue;
		const cellsOf = (row) => row.split("|").map((item) => item.trim()).slice(1, -1);
		let headerCells;
		let dataRows;
		const separatorRow = rows.findIndex((row, rowIndex) => rowIndex > 0 && cellsOf(row).every((cell) => separatorCellRe.test(cell)));
		if (separatorRow === 1 && rows.length >= 3) {
			headerCells = cellsOf(rows[0]).map(cleanHeaderCell);
			dataRows = rows.slice(2);
		} else if (separatorRow === -1 && rows.length >= 2) {
			const first = cellsOf(rows[0]).map(cleanHeaderCell);
			if (STAGE_COL_RE.test(first.join("|")) && COUNT_COL_RE.test(first.join("|"))) {
				headerCells = first;
				dataRows = rows.slice(1);
			} else continue;
		} else continue;
		const stageCol = headerCells.findIndex((cell) => STAGE_COL_RE.test(cell));
		const peakCol = headerCells.findIndex((cell) => /高峰|峰值/u.test(cell) && COUNT_COL_RE.test(cell));
		const countCol = peakCol >= 0 ? peakCol : headerCells.findIndex((cell) => COUNT_COL_RE.test(cell));
		if (countCol < 0) continue;
		if (stageCol >= 0 && stageCol === countCol) continue;
		if (/岗位/u.test(headerCells.join("|")) && /职责|持证|职称/u.test(headerCells.join("|"))) continue;
		const hasTradeCol = headerCells.some((cell) => /工种|岗位|班组|人员类别|管理人员/u.test(cell));
		const tradeCol = hasTradeCol ? headerCells.findIndex((cell) => /工种|岗位|班组|人员类别|管理人员/u.test(cell)) : -1;
		const countCells = [];
		let totalCell;
		let detailSum = 0;
		const tradeCells = [];
		for (const row of dataRows) {
			const cells = cellsOf(row);
			const cell = cells[countCol] || "";
			const match = /^([\d,]+)\s*人?$/u.exec(cell);
			if (!match) continue;
			const value = Number(match[1].replace(/[,，]/gu, ""));
			if (!Number.isFinite(value) || value <= 0) continue;
			if (cells.some((item, cellIndex) => cellIndex !== countCol && /合计|总计|小计/u.test(item))) {
				totalCell = value;
				continue;
			}
			countCells.push(value);
			detailSum += value;
			if (tradeCol >= 0) {
				const tradeRaw = (cells[tradeCol] || "").replace(/[*_`~]/gu, "").trim();
				const tradeName = TRADE_WORKER_WORD_RE.exec(tradeRaw)?.[0];
				if (tradeName) tradeCells.push({
					trade: tradeName,
					value
				});
			}
		}
		if (countCells.length === 0 && totalCell === void 0) continue;
		const peak = Math.max(...countCells.length > 0 ? countCells : [totalCell || 0]);
		blocks.push({
			countCells,
			totalCell,
			detailSum,
			peak,
			hasPeakCol: peakCol >= 0,
			hasTradeCol,
			hasStageCol: stageCol >= 0,
			tradeCells
		});
	}
	return blocks;
}
var PEAK_LABOR_RE, LABOR_STAGE_LIMIT_WORDS, TRADE_WORKER_WORD_RE;
var init_authorities = __esmMin((() => {
	PEAK_LABOR_RE = /(?:高峰期|高峰|峰值)[^。；;\n]{0,20}?(?:约)?\s*([\d,]+)\s*人/g;
	LABOR_STAGE_LIMIT_WORDS = [
		"基坑与基础",
		"二次结构与砌体",
		"施工准备",
		"地下结构",
		"主体结构",
		"装饰装修",
		"机电安装",
		"室外工程",
		"收尾调试",
		"临时设施",
		"土方",
		"基坑",
		"基础"
	];
	TRADE_WORKER_WORD_RE = /(?:铺装工|钢筋工|混凝土工|架子工|砌筑工|抹灰工|防水工|油漆工|水暖工|水电工|管道工|电焊工|起重工|机械工|司索工|信号工|塔吊司机|测量工|试验工|绿化工|管网工|装修工|装饰工|安装工|养护工|保温工|幕墙工|防腐工|操作工|市政工|模板工|木工|瓦工|焊工|电工|普工)(?!程|序|艺|期)/u;
}));
/** A2 总入口：跨章数值/支护体系矛盾确定性修复（劳动力峰值 → 节点工期 → 材料/设备数量 → 支护体系，顺序执行互不重叠） */
//#endregion
//#region apps/server/src/services/document-workflow/evidenceContentSafety.ts
var init_evidenceContentSafety = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	init_outline$1();
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
//#region apps/server/src/services/document-workflow/factsModel.ts
var init_factsModel = __esmMin((() => {
	init_kbService();
	init_documentDomainProfileService();
	init_factMatching();
	init_llmClient();
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
//#region apps/server/src/services/document-workflow/helpers/projectBasicInfo.ts
var init_projectBasicInfo = __esmMin((() => {
	init_factsModel();
	init_factGovernance();
	init_markdownCleanup();
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
//#region apps/server/src/services/document-workflow/resourceBreakdownNumbers.ts
/** 机械名归一：undefined 表示该捕获非设备名（量词残留/片段/辅助配置），调用方丢弃 */
function normalizeEquipmentClaimName(captured) {
	const cleaned = captured.replace(/\s+/gu, "");
	let name = cleaned;
	for (let index = cleaned.length - 1; index >= 0; index -= 1) {
		if (!EQUIPMENT_NAME_PREFIX_STOP_RE.test(cleaned[index])) continue;
		if (EQUIPMENT_AUXILIARY_PREFIX_RE.test(cleaned.slice(0, index + 1))) return void 0;
		name = cleaned.slice(index + 1);
		break;
	}
	if (name.length < 2) return void 0;
	if (EQUIPMENT_NAME_QUANTIFIER_PREFIX_RE.test(name)) return void 0;
	if (EQUIPMENT_NAME_FRAGMENT_RE.test(name)) return void 0;
	return name;
}
/** 机械台数宣称扫描：名称（2~8 字，机/吊/泵/车/夯 结尾）+ ≤12 桥接字（禁跨句读/顿逗/表格竖线）
* + 数字 + 台/套/辆；名称经虚词截断归一，否定分句不采（正文与资料事实短值共用） */
function scanEquipmentCountClaims(text) {
	const claims = [];
	const pattern = new RegExp(`([\\p{Script=Han}A-Za-z0-9]{2,8}(?:${EQUIPMENT_NAME_SUFFIX_SOURCE}))[^\\d。；;\\n|、，]{0,12}(\\d+)\\s*(?:台|套|辆)`, "gu");
	for (const match of text.matchAll(pattern)) {
		const start = match.index ?? 0;
		const clauseStart = Math.max(text.lastIndexOf("，", start), text.lastIndexOf("。", start), text.lastIndexOf("；", start), text.lastIndexOf(";", start), text.lastIndexOf("\n", start), text.lastIndexOf("、", start));
		if (EQUIPMENT_CLAIM_NEGATION_RE.test(text.slice(clauseStart + 1, start + match[1].length))) continue;
		const name = normalizeEquipmentClaimName(match[1]);
		if (!name) continue;
		const count = Number(match[2]);
		if (!Number.isFinite(count) || count <= 0) continue;
		claims.push({
			name,
			raw: match[1],
			count,
			start,
			text: match[0]
		});
	}
	return claims;
}
var EQUIPMENT_NAME_SUFFIX_SOURCE, EQUIPMENT_NAME_PREFIX_STOP_RE, EQUIPMENT_NAME_QUANTIFIER_PREFIX_RE, EQUIPMENT_NAME_FRAGMENT_RE, EQUIPMENT_AUXILIARY_PREFIX_RE, EQUIPMENT_CLAIM_NEGATION_RE;
var init_resourceBreakdownNumbers = __esmMin((() => {
	EQUIPMENT_NAME_SUFFIX_SOURCE = "机|吊|泵|车|夯";
	EQUIPMENT_NAME_PREFIX_STOP_RE = /[为配置备启投拟需计划增租赁购采设进出按据由从向对把被使等该此其每各和与及或在是将宜并可未非不另又还有部现中套余的用入要场阶段]/u;
	EQUIPMENT_NAME_QUANTIFIER_PREFIX_RE = /^(?:[台辆部具个组米吨座])/u;
	EQUIPMENT_NAME_FRAGMENT_RE = /^(?:主力|主要|常用|配套|相关|专用|通用|各类|多种|其余|剩余|上述|前者|后者)/u;
	EQUIPMENT_AUXILIARY_PREFIX_RE = /(?:备用|租赁|租用)/u;
	EQUIPMENT_CLAIM_NEGATION_RE = /不使用|不采用|不配置|无需|未采用|不得使用|禁止使用/u;
	new RegExp(`([\\p{Script=Han}A-Za-z0-9]{2,8}(?:${EQUIPMENT_NAME_SUFFIX_SOURCE}))$`, "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/internalTerminologyAnchors.ts
var INTERNAL_TERM_EXACT_RE;
var init_internalTerminologyAnchors = __esmMin((() => {
	init_semanticSimilarity();
	INTERNAL_TERM_EXACT_RE = /工作包|事实卡|事实主表|后台数据库|落位|峰值口径|控制口径|数据口径/gu;
})), DRAWING_SIGNATURE_PATTERN;
var init_poolNoise = __esmMin((() => {
	DRAWING_SIGNATURE_PATTERN = "专用章|出图|设计研究总院|工程设计(?:甲|乙|丙)级|资质证书|证书编号";
	new RegExp(DRAWING_SIGNATURE_PATTERN, "u");
	new RegExp(DRAWING_SIGNATURE_PATTERN, "gu");
}));
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
//#region apps/server/src/services/document-workflow/factReconciliation.ts
function escapeRegexLiteral$1(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
/** 数值字面量解析：去千分位逗号/空白（含全角） */
function parseNumeric(raw) {
	const cleaned = raw.replace(/[,，\s]/gu, "");
	const value = Number.parseFloat(cleaned);
	return Number.isFinite(value) ? value : void 0;
}
/** 数值近似相等：两位小数容差 + 浮点相对容差（合计对账口径） */
function nearlyEqual(a, b) {
	return Math.abs(a - b) <= .01 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));
}
/** 转写宽容相等（r26 实测：正文整数为权威小数值的截断/舍入转写，如权威 1757.12 → 正文 1757）：
* 在 nearlyEqual 基础上额外接受「正文整数值 = 权威值截断或四舍五入」。仅用于绑定值 vs 条目数量/
* 同名值集的吻合判定——不得用于 foreign 归属判定（防把无关条目的小数值错认为本值归属）。 */
function transcribedEqual(textValue, authorityValue) {
	if (nearlyEqual(textValue, authorityValue)) return true;
	return Number.isInteger(textValue) && (Math.trunc(authorityValue) === textValue || Math.round(authorityValue) === textValue);
}
/** 规格归一键（去空白 + 小写）：specValues/aggregateSpecs 与正文抽取共用口径 */
function normalizeSpecKey(spec) {
	return spec.replace(/\s+/gu, "").toLowerCase();
}
/** 有序数值池近似查找（二分定位 + 邻位复核：容差带内的权威值命中判定） */
function poolHasApprox(sorted, value) {
	let lo = 0;
	let hi = sorted.length;
	while (lo < hi) {
		const mid = lo + hi >> 1;
		if (sorted[mid] < value) lo = mid + 1;
		else hi = mid;
	}
	for (let index = Math.max(0, lo - 1); index <= Math.min(sorted.length - 1, lo + 1); index += 1) if (nearlyEqual(sorted[index], value)) return true;
	return false;
}
/** 单位归一：同口径单位族收敛到规范形（米→m、平方米→m2、立方米→m3、公里→km、吨→t） */
function normalizeUnit(unit) {
	const u = (unit || "").trim().toLowerCase();
	return {
		"米": "m",
		"m": "m",
		"公里": "km",
		"km": "km",
		"千米": "km",
		"平方米": "m2",
		"㎡": "m2",
		"m²": "m2",
		"m2": "m2",
		"平方": "m2",
		"立方米": "m3",
		"m³": "m3",
		"m3": "m3",
		"方": "m3",
		"吨": "t",
		"t": "t",
		"千克": "kg",
		"kg": "kg"
	}[u] ?? u;
}
/** 单位匹配正则片段（正文用字与清单单位字面差异同族收敛） */
function unitAliasPattern(unit) {
	switch (normalizeUnit(unit)) {
		case "m": return "(?:m|米)";
		case "km": return "(?:km|公里|千米)";
		case "m2": return "(?:m2|m²|㎡|平方米)";
		case "m3": return "(?:m3|m³|立方米)";
		case "t": return "(?:t|吨)";
		case "kg": return "(?:kg|千克)";
		default: return escapeRegexLiteral$1((unit || "").trim());
	}
}
/** 数值显示变体（千分位/去尾零）：分项显式存在性检查用 */
function numberVariants(value) {
	const plain = `${value}`;
	const variants = new Set([plain]);
	const [intPart, decimalPart] = plain.split(".");
	if (intPart.length >= 4) variants.add(`${intPart.replace(/\B(?=(\d{3})+(?!\d))/gu, ",")}${decimalPart ? `.${decimalPart}` : ""}`);
	return [...variants];
}
/** 事实主表数值收集（字符串内数字 token 化提取：maximal match 防子串误配） */
function collectFactModelNumbers(factsModel, out) {
	if (!factsModel) return;
	const visit = (value) => {
		if (typeof value === "number") {
			if (Number.isFinite(value)) out.push(value);
			return;
		}
		if (typeof value === "string") {
			for (const match of value.matchAll(/\d+(?:\.\d+)?/gu)) out.push(Number.parseFloat(match[0]));
			return;
		}
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}
		if (value && typeof value === "object") Object.values(value).forEach(visit);
	};
	[
		factsModel.project,
		factsModel.schedule,
		factsModel.quality,
		factsModel.safety,
		factsModel.resources,
		factsModel.preciseFacts,
		factsModel.bills,
		factsModel.drawings,
		factsModel.rules,
		factsModel.specifications,
		factsModel.tables
	].forEach(visit);
}
/**
* 权威视图构建：清单事实锁（条目级权威）+ 蓝图 quantities（聚合口径）+ 事实主表（数字池扩容）。
* 清单缺失时蓝图与事实主表仍可独立支撑（无任何权威时各规则自行跳过）。
*/
function buildReconciliationAuthority(input) {
	const entries = [];
	const numberPool = [];
	const specValues = /* @__PURE__ */ new Map();
	const aggregateSpecs = /* @__PURE__ */ new Map();
	const lock = input.billFactLock;
	if (lock) for (const entry of lock.entries) {
		const value = Number.isFinite(entry.quantity) ? entry.quantity : void 0;
		if (value !== void 0) {
			entries.push({
				name: (entry.name || "").trim(),
				value,
				unit: (entry.unit || "").trim(),
				description: entry.description || "",
				source: "bill"
			});
			numberPool.push(value);
		}
		for (const pair of entry.specQuantityPairs || []) {
			const specKey = (pair.spec || "").replace(/\s+/gu, "").toLowerCase();
			const pairMatch = /^([\d,，]+(?:\.\d+)?)\s*(.*)$/u.exec((pair.quantity || "").trim());
			const pairValue = pairMatch ? parseNumeric(pairMatch[1]) : void 0;
			if (!specKey || pairValue === void 0) continue;
			const list = specValues.get(specKey) || [];
			list.push({
				value: pairValue,
				unit: (pairMatch?.[2] || "").trim(),
				entryName: entry.name,
				spec: (pair.spec || "").trim()
			});
			specValues.set(specKey, list);
			numberPool.push(pairValue);
		}
	}
	const quantities = input.blueprintData?.quantities ?? {};
	for (const [name, quantity] of Object.entries(quantities)) {
		if (typeof quantity?.value !== "number" || !Number.isFinite(quantity.value)) continue;
		entries.push({
			name: name.trim(),
			value: quantity.value,
			unit: (quantity.unit || "").trim(),
			description: "",
			source: "blueprint"
		});
		numberPool.push(quantity.value);
		for (const group of quantity.groups ?? []) numberPool.push(group.value);
		const breakdown = quantity.specBreakdown ?? [];
		if (breakdown.length >= 2) {
			const splitSum = breakdown.reduce((sum, item) => sum + item.value, 0);
			aggregateSpecs.set(name.trim(), {
				value: quantity.value,
				unit: (quantity.unit || "").trim(),
				specs: new Map(breakdown.map((item) => [normalizeSpecKey(item.spec), item.value])),
				breakdown: breakdown.map((item) => ({
					spec: item.spec,
					value: item.value
				})),
				partitioned: nearlyEqual(splitSum, quantity.value)
			});
			for (const split of breakdown) numberPool.push(split.value);
		}
	}
	collectFactModelNumbers(input.factsModel, numberPool);
	return {
		entries,
		numberPool,
		specValues,
		aggregateSpecs
	};
}
/** 条目名与文本的类别重叠（≥2 字公共连续子串）：合计分项归因与误报收口共用 */
function nameOverlapsText(name, text, minLength = 2) {
	if (!name || !text) return false;
	const max = Math.min(name.length, 8);
	for (let length = max; length >= minLength; length -= 1) for (let start = 0; start + length <= name.length; start += 1) if (text.includes(name.slice(start, start + length))) return true;
	return false;
}
/** 分项值在窗口内显式展示（数值≥100 时允许裸数；小值须与同族单位邻接，防噪声命中） */
function componentShown(window, entry) {
	const unitAlt = unitAliasPattern(entry.unit);
	for (const variant of numberVariants(entry.value)) {
		const escaped = escapeRegexLiteral$1(variant);
		if (new RegExp(`${escaped}\\s*(?:${unitAlt})|(?:${unitAlt})\\s*${escaped}`, "u").test(window)) return true;
		if (entry.value >= 100 && new RegExp(`(?<![\\d.])${escaped}(?![\\d])`, "u").test(window)) return true;
	}
	return false;
}
/** 分项和查找：≥2 个与上下文类别重叠的条目，其值之和 ≈ 合计值 */
function findBreakdownComponents(candidates, total, context) {
	const related = candidates.filter((entry) => entry.name.length >= 2 && nameOverlapsText(entry.name, context));
	if (related.length < 2 || related.length > 24) return [];
	for (let i = 0; i < related.length; i += 1) for (let j = i + 1; j < related.length; j += 1) {
		const left = related[i];
		const right = related[j];
		if (left.name === right.name && nearlyEqual(left.value, right.value)) continue;
		if (nearlyEqual(left.value + right.value, total)) return [left, right];
	}
	return [];
}
/**
* 合计聚合闭包：total 可被"与合计句上下文名称相关的组和"（多村组同名聚合 / 跨类别合分项）闭合：
* - 相关组和 1~2 项本身 ≈ total（案例：挖淤泥、流砂 21273 = 6 村组同名条目之和）；
* - 相关组和 1~2 项 + 任一权威值池值补差 ≈ total（案例：16037.54 = 8205.53 + 7525.01 + 307）。
* 补差项只允许单值命中（数字池 = 清单条目 + 规格拆分 + 蓝图 quantities + 事实主表）。
*/
function aggregationClosure(total, unit, context, authority, poolSorted) {
	const groupSums = /* @__PURE__ */ new Map();
	for (const entry of authority.entries) {
		if (!(entry.value > 0) || normalizeUnit(entry.unit) !== unit) continue;
		const key = `${entry.source}\u0000${entry.name}`;
		groupSums.set(key, (groupSums.get(key) || 0) + entry.value);
	}
	const relatedValues = [];
	for (const [key, sum] of groupSums) {
		if (!nameOverlapsText(key.slice(key.indexOf("\0") + 1), context)) continue;
		if (!relatedValues.some((value) => nearlyEqual(value, sum))) relatedValues.push(sum);
		if (relatedValues.length >= 24) break;
	}
	if (relatedValues.length === 0) return false;
	const closed = (sum) => nearlyEqual(sum, total) || poolHasApprox(poolSorted, total - sum);
	if (relatedValues.some((sum) => closed(sum))) return true;
	for (let i = 0; i < relatedValues.length; i += 1) for (let j = i + 1; j < relatedValues.length; j += 1) if (closed(relatedValues[i] + relatedValues[j])) return true;
	return false;
}
function scanTotalClaimFindings(markdown, authority) {
	const findings = [];
	if (authority.entries.length === 0) return findings;
	const seen = /* @__PURE__ */ new Set();
	const poolSorted = [...authority.numberPool].sort((left, right) => left - right);
	for (const match of markdown.matchAll(TOTAL_CLAIM_RE)) {
		const total = parseNumeric(match[1]);
		if (total === void 0) continue;
		const unit = normalizeUnit(match[2]);
		const index = match.index ?? 0;
		const matchEnd = index + match[0].length;
		const candidates = authority.entries.filter((entry) => entry.value > 0 && normalizeUnit(entry.unit) === unit);
		if (candidates.length === 0) continue;
		const context = markdown.slice(Math.max(0, index - 40), index + match[0].length + 40);
		const anchorScope = markdown.slice(Math.max(0, index - 20), index + match[0].length);
		const anchor = candidates.filter((entry) => entry.name.length >= 3 && anchorScope.includes(entry.name)).sort((left, right) => right.name.length - left.name.length)[0];
		if (anchor) {
			if (nearlyEqual(anchor.value, total)) {
				const breakdown = findBreakdownComponents(candidates, total, context);
				if (breakdown.length >= 2) {
					const window = markdown.slice(Math.max(0, index - 150), index + match[0].length + 150);
					const missing = breakdown.filter((entry) => !componentShown(window, entry));
					if (missing.length > 0) {
						const breakdownText = breakdown.map((entry) => `「${entry.name}」${entry.value}${entry.unit}`).join(" + ");
						const message = `合计数值应分项显式：「${anchor.name} ${total}${match[2]}」= ${breakdownText}，但正文未展示分项（缺 ${missing.map((entry) => `${entry.name} ${entry.value}${entry.unit}`).join("、")}），无法核对合计来源`;
						if (!seen.has(message)) {
							seen.add(message);
							findings.push({
								issue: {
									level: "warning",
									severity: "warning",
									category: "fact_consistency",
									owner: "llm",
									repairability: "llm_repairable",
									message,
									suggestion: `在合计值附近补充分项明细（${breakdownText}），使合计数值可逐项核对；分项值必须取自工程量清单原文，不得改动。`
								},
								matchStart: index,
								matchEnd
							});
						}
					}
				}
				continue;
			}
			const residual = total - anchor.value;
			const other = candidates.find((entry) => entry !== anchor && entry.name !== anchor.name && nearlyEqual(entry.value, residual));
			if (other) {
				const window = markdown.slice(Math.max(0, index - 150), index + match[0].length + 150);
				if (componentShown(window, anchor) && componentShown(window, other)) continue;
				const message = `合计值与权威不符：「${anchor.name}」清单权威 ${anchor.value}${match[2]}；正文 ${total}${match[2]} \u2248 ${anchor.value} + ${other.value}（「${other.name}」）——若「${other.name}」应计入「${anchor.name}」合计，须在正文显式分项；若不应计入（重复计入），须改回权威值 ${anchor.value}${match[2]}`;
				if (!seen.has(message)) {
					seen.add(message);
					findings.push({
						issue: {
							level: "error",
							severity: "blocker",
							category: "fact_consistency",
							owner: "llm",
							repairability: "llm_repairable",
							message,
							suggestion: `核对合计口径：「${anchor.name}」合计为 ${anchor.value}${match[2]}（清单权威）。若正文需表达 ${anchor.value} + ${other.value}，则显式写成「${anchor.name} ${anchor.value}${match[2]}、${other.name} ${other.value}${match[2]}，合计 ${total}${match[2]}」；否则将合计改回 ${anchor.value}${match[2]}（差额 ${Math.round(residual * 1e4) / 1e4}${match[2]} 属「${other.name}」，不得并入）。`
						},
						matchStart: index,
						matchEnd
					});
				}
				continue;
			}
			if (aggregationClosure(total, unit, context, authority, poolSorted)) continue;
			const message = `合计值与权威不符：「${anchor.name}」合计为 ${anchor.value}${match[2]}（清单权威），正文写 ${total}${match[2]}，且差额不属任何清单条目，需核对合计口径`;
			if (!seen.has(message)) {
				seen.add(message);
				findings.push({
					issue: {
						level: "warning",
						severity: "warning",
						category: "fact_consistency",
						owner: "llm",
						repairability: "llm_repairable",
						message,
						suggestion: `核对「${anchor.name}」的合计口径：若为多分项之和，请写明与权威一致的分项分解；若为单一总量，改为清单权威值 ${anchor.value}${anchor.unit || match[2]}。`
					},
					matchStart: index,
					matchEnd
				});
			}
			continue;
		}
		const breakdown = findBreakdownComponents(candidates, total, context);
		if (breakdown.length >= 2) {
			const window = markdown.slice(Math.max(0, index - 150), index + match[0].length + 150);
			const missing = breakdown.filter((entry) => !componentShown(window, entry));
			if (missing.length > 0) {
				const breakdownText = breakdown.map((entry) => `「${entry.name}」${entry.value}${entry.unit}`).join(" + ");
				const message = `合计数值应分项显式：正文合计 ${total}${match[2]} = ${breakdownText}，但未展示分项（缺 ${missing.map((entry) => `${entry.name} ${entry.value}${entry.unit}`).join("、")}），无法核对合计来源`;
				if (!seen.has(message)) {
					seen.add(message);
					findings.push({
						issue: {
							level: "warning",
							severity: "warning",
							category: "fact_consistency",
							owner: "llm",
							repairability: "llm_repairable",
							message,
							suggestion: `在合计值附近补充分项明细（${breakdownText}）；分项值必须取自工程量清单原文，不得改动。`
						},
						matchStart: index,
						matchEnd
					});
				}
			}
			continue;
		}
		{
			const nameSums = /* @__PURE__ */ new Map();
			for (const entry of candidates) nameSums.set(entry.name, (nameSums.get(entry.name) || 0) + entry.value);
			let nameSumHit = false;
			for (const sum of nameSums.values()) if (nearlyEqual(sum, total)) {
				nameSumHit = true;
				break;
			}
			if (nameSumHit) continue;
		}
		if (aggregationClosure(total, unit, context, authority, poolSorted)) continue;
		const related = candidates.filter((entry) => nameOverlapsText(entry.name, context));
		const unitMatched = candidates.some((entry) => nearlyEqual(entry.value, total));
		const poolHit = authority.numberPool.some((value) => nearlyEqual(value, total));
		if (!unitMatched && !poolHit && related.length > 0) {
			const message = `合计值无权威来源：正文「${match[0].trim()}」在清单事实锁与蓝图参数桶中找不到同值来源，违反无据不写`;
			if (seen.has(message)) continue;
			seen.add(message);
			findings.push({
				issue: {
					level: "error",
					severity: "blocker",
					category: "fact_consistency",
					owner: "llm",
					repairability: "llm_repairable",
					message,
					suggestion: "删除该合计数值或改为与清单权威一致的合计值；无权威来源的合计数不得进入交付文本。"
				},
				matchStart: index,
				matchEnd
			});
		}
	}
	return findings;
}
/** 检测端入口（行为保持）：扫描命中只取 issue */
function scanTotalClaims(markdown, authority) {
	return scanTotalClaimFindings(markdown, authority).map((finding) => finding.issue);
}
/** 规格 → 所属名称合计条目（R20）：同一规格至多归属首个体现在 aggregateSpecs 的条目 */
function findAggregateSpecInfo(authority, specKey) {
	for (const [entryName, info] of authority.aggregateSpecs) if (info.specs.has(specKey)) return {
		entryName,
		info
	};
}
function scanSpecBindingHits(markdown, authority) {
	const hits = [];
	if (authority.specValues.size === 0 && authority.aggregateSpecs.size === 0) return hits;
	const seen = /* @__PURE__ */ new Set();
	for (const match of markdown.matchAll(SPEC_CANDIDATE_RE)) {
		const specKey = normalizeSpecKey(match[0]);
		const bound = authority.specValues.get(specKey) ?? [];
		const aggregateOwner = findAggregateSpecInfo(authority, specKey);
		if (bound.length === 0 && !aggregateOwner) continue;
		const matchEnd = (match.index ?? 0) + match[0].length;
		const after = markdown.slice(matchEnd, matchEnd + 36);
		const valueMatch = /^([^。；;\n|]{0,16}?)([\d,，]+(?:\.\d+)?)\s*(座|个|套|盏|台|根|块|樘|扇|片|组|件|孔|米|m|km|公里|平方米|m2|㎡|m²|立方米|m3|m³|吨|t|kg)(?![a-zA-Z0-9²³])/u.exec(after);
		if (!valueMatch) continue;
		if (SLOT_WORD_RE.test(valueMatch[1])) continue;
		if (/不大于|不超过|不得大于|不得超过/.test(valueMatch[1])) continue;
		if (valueMatch[3] === "台") {
			const suffixStart = matchEnd + valueMatch[1].length + valueMatch[2].length + valueMatch[3].length;
			if (DEVICE_BODY_RE.test(valueMatch[1]) || DEVICE_BODY_RE.test(markdown.slice(suffixStart, suffixStart + 12))) continue;
		}
		if (/总长|全长|长度|管长|延米/u.test(valueMatch[1]) && /^(?:m|米|km|公里)$/u.test(valueMatch[3])) continue;
		const value = parseNumeric(valueMatch[2]);
		if (value === void 0) continue;
		if (bound.some((item) => nearlyEqual(item.value, value))) continue;
		const specSum = aggregateOwner?.info.specs.get(specKey);
		if (specSum !== void 0 && nearlyEqual(specSum, value)) continue;
		const entryGroupTotals = /* @__PURE__ */ new Map();
		for (const item of bound) {
			const existing = entryGroupTotals.get(item.entryName);
			if (existing) existing.value += item.value;
			else entryGroupTotals.set(item.entryName, {
				value: item.value,
				unit: item.unit
			});
		}
		const groupSums = [...entryGroupTotals.values()].sort((left, right) => right.value - left.value);
		if (bound.length >= 2 && groupSums.some((sum) => nearlyEqual(sum.value, value))) continue;
		if (aggregateOwner?.info.partitioned && specSum !== void 0 && nearlyEqual(aggregateOwner.info.value, value)) {
			const gapKey = normalizeSpecKey(valueMatch[1]);
			if (![...aggregateOwner.info.specs.keys()].some((key) => key !== specKey && gapKey.includes(key))) {
				const decomposition = aggregateOwner.info.breakdown.map((item) => `${item.spec} ${item.value}${aggregateOwner.info.unit}`).join(" + ");
				const message = `规格-数值绑定错位：「${match[0]}」处数值 ${value}${valueMatch[3]} 是「${aggregateOwner.entryName}」的跨规格名称合计（${decomposition}），不属于单一规格「${match[0]}」——名称合计不得挂给单一规格，须写该规格小计 ${specSum}${valueMatch[3]}（确需写合计须显式分解）`;
				if (!seen.has(message)) {
					seen.add(message);
					const valueStart = matchEnd + valueMatch[1].length;
					hits.push({
						issue: {
							level: "error",
							severity: "blocker",
							category: "fact_consistency",
							owner: "llm",
							repairability: "llm_repairable",
							message,
							suggestion: `「${match[0]}」的数量须写该规格小计 ${specSum}${valueMatch[3]}；名称合计须显式分解为 ${decomposition}（合计 ${aggregateOwner.info.value}${aggregateOwner.info.unit}），不得把合计值挂在单一规格名下。`
						},
						specToken: match[0],
						value,
						unit: valueMatch[3],
						valueStart,
						valueEnd: valueStart + valueMatch[2].length,
						groupSumCandidates: [{
							value: specSum,
							unit: aggregateOwner.info.unit
						}, ...groupSums.filter((sum) => !nearlyEqual(sum.value, value))]
					});
				}
			}
			continue;
		}
		let foreign;
		for (const [otherSpec, items] of authority.specValues) {
			if (otherSpec === specKey) continue;
			const hit = items.find((item) => nearlyEqual(item.value, value));
			if (hit) {
				foreign = {
					spec: hit.spec || otherSpec,
					entryName: hit.entryName
				};
				break;
			}
		}
		if (!foreign) continue;
		if (valueMatch[1] && nameOverlapsText(foreign.entryName, valueMatch[1])) continue;
		const message = `规格-数值绑定错位：正文「${match[0]} ${value}${valueMatch[3]}」中 ${value}${valueMatch[3]} 属规格「${foreign.spec}」（清单条目「${foreign.entryName}」），不属于「${match[0]}」的清单数量`;
		if (seen.has(message)) continue;
		seen.add(message);
		const valueStart = matchEnd + valueMatch[1].length;
		hits.push({
			issue: {
				level: "error",
				severity: "blocker",
				category: "fact_consistency",
				owner: "llm",
				repairability: "llm_repairable",
				message,
				suggestion: `「${match[0]}」的数量必须引用清单中该规格条目的原值（如 ${bound.map((item) => `${item.value}${item.unit}`).join("、")}）；「${foreign.spec}」的数量不得张冠李戴至「${match[0]}」。`
			},
			specToken: match[0],
			value,
			unit: valueMatch[3],
			valueStart,
			valueEnd: valueStart + valueMatch[2].length,
			groupSumCandidates: groupSums.filter((sum) => !nearlyEqual(sum.value, value))
		});
	}
	for (const match of markdown.matchAll(SPEC_CANDIDATE_RE)) {
		const specKey = normalizeSpecKey(match[0]);
		const owner = findAggregateSpecInfo(authority, specKey);
		if (!owner?.info.partitioned) continue;
		const specSum = owner.info.specs.get(specKey);
		if (specSum === void 0) continue;
		const idx = match.index ?? 0;
		const before = markdown.slice(Math.max(0, idx - 24), idx);
		const valueMatch = /([\d,，]+(?:\.\d+)?)\s*(座|个|套|盏|台|根|块|樘|扇|片|组|件|孔|米|m|km|公里|平方米|m2|㎡|m²|立方米|m3|m³|吨|t|kg)\s*([^。；;\n|0-9²³]{0,12})$/u.exec(before);
		if (!valueMatch) continue;
		const gap = valueMatch[3];
		if (!/[（(]|为|系|采用|型号|规格|灯型|类型/u.test(gap)) continue;
		if (SLOT_WORD_RE.test(gap)) continue;
		const value = parseNumeric(valueMatch[1]);
		if (value === void 0) continue;
		if (!nearlyEqual(owner.info.value, value) || nearlyEqual(specSum, value)) continue;
		if (!nameOverlapsText(owner.entryName, before)) continue;
		const windowText = normalizeSpecKey(markdown.slice(Math.max(0, idx - 60), idx + 60));
		if ([...owner.info.specs.keys()].filter((key) => windowText.includes(key)).length >= 2) continue;
		const valueStart = idx - gap.length - valueMatch[2].length - valueMatch[1].length;
		const dedupeKey = `${specKey}@${valueStart}`;
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		const decomposition = owner.info.breakdown.map((item) => `${item.spec} ${item.value}${owner.info.unit}`).join(" + ");
		hits.push({
			issue: {
				level: "error",
				severity: "blocker",
				category: "fact_consistency",
				owner: "llm",
				repairability: "llm_repairable",
				message: `规格-数值绑定错位：正文「…${value}${valueMatch[2]}${gap}${match[0]}…」中 ${value}${valueMatch[2]} 为「${owner.entryName}」的跨规格名称合计（${decomposition}），其后紧随单一规格「${match[0]}」易被读作全部为该规格；名称合计须显式分解`,
				suggestion: `数量 ${value}${valueMatch[2]} 保留不动；把规格表述改为显式分解，如「${value}${valueMatch[2]}（${decomposition}）」或逐规格列写「${decomposition}」；不得以名称合计搭配单一规格描述。`
			},
			specToken: match[0],
			value,
			unit: valueMatch[2],
			valueStart,
			valueEnd: valueStart + valueMatch[1].length,
			groupSumCandidates: []
		});
	}
	if (authority.aggregateSpecs.size > 0) {
		let lineStart = 0;
		for (const line of markdown.split("\n")) {
			const startOfLine = lineStart;
			lineStart += line.length + 1;
			if (!line.includes("|")) continue;
			if (/^\s*\|?[\s:|-]*\|?\s*$/u.test(line)) continue;
			const byEntry = /* @__PURE__ */ new Map();
			for (const item of line.matchAll(SPEC_CANDIDATE_RE)) {
				const key = normalizeSpecKey(item[0]);
				const owner = findAggregateSpecInfo(authority, key);
				if (!owner?.info.partitioned) continue;
				const specSum = owner.info.specs.get(key);
				if (specSum === void 0) continue;
				const list = byEntry.get(owner.entryName) || [];
				if (!list.some((existing) => existing.key === key)) list.push({
					key,
					raw: item[0].trim(),
					specSum
				});
				byEntry.set(owner.entryName, list);
			}
			if (byEntry.size !== 1) continue;
			const [entryName, specs] = [...byEntry.entries()][0];
			if (specs.length !== 1) continue;
			const info = authority.aggregateSpecs.get(entryName);
			if (!info) continue;
			const { key: specKey, raw: specRaw, specSum } = specs[0];
			if (!nameOverlapsText(entryName, line)) continue;
			for (const cell of line.matchAll(/\|([^|\n]*)/gu)) {
				const cellText = cell[1].trim();
				const numberMatch = /^([\d,，]+(?:\.\d+)?)\s*(?:座|个|套|盏|台|根|块|樘|扇|片|组|件|孔|米|m|km|公里|平方米|m2|㎡|m²|立方米|m3|m³|吨|t|kg)?$/u.exec(cellText);
				if (!numberMatch) continue;
				const value = parseNumeric(numberMatch[1]);
				if (value === void 0) continue;
				if (!nearlyEqual(info.value, value) || nearlyEqual(specSum, value)) continue;
				if ((authority.specValues.get(specKey) ?? []).some((item) => nearlyEqual(item.value, value))) continue;
				const valueStart = startOfLine + (cell.index ?? 0) + 1 + cell[1].indexOf(numberMatch[1]);
				const dedupeKey = `${specKey}@${valueStart}`;
				if (seen.has(dedupeKey)) continue;
				seen.add(dedupeKey);
				const decomposition = info.breakdown.map((item) => `${item.spec} ${item.value}${info.unit}`).join(" + ");
				hits.push({
					issue: {
						level: "error",
						severity: "blocker",
						category: "fact_consistency",
						owner: "llm",
						repairability: "llm_repairable",
						message: `规格-数值绑定错位：表格行「${specRaw}…」的数量 ${value}${info.unit} 是「${entryName}」的跨规格名称合计（${decomposition}），该行规格为「${specRaw}」应填其小计 ${specSum}${info.unit}`,
						suggestion: `该行数量改为 ${specSum}${info.unit}；名称合计请另立「合计」行或显式分解为 ${decomposition}。`
					},
					specToken: specRaw,
					value,
					unit: info.unit,
					valueStart,
					valueEnd: valueStart + numberMatch[1].length,
					groupSumCandidates: [{
						value: specSum,
						unit: info.unit
					}]
				});
			}
		}
	}
	return hits;
}
function scanSpecQuantityBindings(markdown, authority) {
	return scanSpecBindingHits(markdown, authority).map((hit) => hit.issue);
}
function scanSlotSemantics(markdown, authority) {
	const issues = [];
	const seen = /* @__PURE__ */ new Set();
	for (const match of markdown.matchAll(SLOT_DEPTH_RE)) {
		const raw = parseNumeric(match[1]);
		if (raw === void 0) continue;
		const unit = match[2];
		if ((unit === "mm" ? raw / 1e3 : unit === "cm" ? raw / 100 : raw) <= 10) continue;
		const lengthEntry = authority.entries.find((entry) => nearlyEqual(entry.value, raw) && /总长|全长|总长度|长度|管线/u.test(entry.name));
		const message = `数值语义槽位错位：正文「${match[0].trim()}」——埋深/覆土数值 ${raw}${unit} 超出物理合理范围（管道埋深一般 <10m）${lengthEntry ? `，且该数值与权威「${lengthEntry.name}」(${lengthEntry.value}${lengthEntry.unit})一致，疑似把总长/长度口径误用作埋深` : "，疑似口径混用"}`;
		if (seen.has(message)) continue;
		seen.add(message);
		issues.push({
			level: "error",
			severity: "blocker",
			category: "fact_consistency",
			owner: "llm",
			repairability: "llm_repairable",
			message,
			suggestion: `核对槽位语义：埋深/覆土深度应在 0.3～10m 合理区间（以设计图纸为准）；总长/长度类数值不得用于埋深描述${lengthEntry ? `（「${lengthEntry.name}」为 ${lengthEntry.value}${lengthEntry.unit}）` : ""}。`
		});
	}
	return issues;
}
/** 近似可推导判定：精确命中或按量级容差命中权威数字池（百位±5、十位±1、千位±10/2%） */
function approximateDerivable(value, pool) {
	const scaleTolerance = value >= 1e3 ? Math.max(10, value * .02) : value >= 100 ? 5 : value >= 10 ? 1 : .5;
	return pool.some((candidate) => Math.abs(candidate - value) <= scaleTolerance || Math.abs(candidate - value) <= Math.max(1e-6, Math.abs(candidate) * .02));
}
function scanApproximateClaims(markdown, authority) {
	const issues = [];
	if (authority.numberPool.length === 0) return issues;
	const seen = /* @__PURE__ */ new Set();
	const check = (raw, unit, whole) => {
		const value = parseNumeric(raw);
		if (value === void 0) return;
		if (approximateDerivable(value, authority.numberPool)) return;
		const message = `近似数值不可推导：正文「${whole.trim()}」的 ${value}${unit} 在清单/蓝图/事实主表中无同值或近似来源，违反无据不写`;
		if (seen.has(message)) return;
		seen.add(message);
		issues.push({
			level: "error",
			severity: "blocker",
			category: "fact_consistency",
			owner: "llm",
			repairability: "llm_repairable",
			message,
			suggestion: "删除该近似表述，或改用权威数据可推导的数值（清单/蓝图同值口径）；「约/近」类近似数值必须可闭合到权威来源。"
		});
	};
	for (const match of markdown.matchAll(APPROX_PREFIX_RE)) {
		const at = match.index ?? 0;
		const prefixChar = markdown.slice(Math.max(0, at - 1), at);
		if (APPROX_PREFIX_EXEMPT_RE.test(prefixChar)) continue;
		check(match[1], match[2], match[0]);
	}
	for (const match of markdown.matchAll(APPROX_SUFFIX_RE)) check(match[1], match[2], match[0]);
	return issues;
}
/** D4.6a 豁免：名称相关组和（正文以更短/更具体名引用清单组，值 = 该组全部条目之和；案例：栽植色带（生态池外围）90m² 实指清单组「栽植色带（生态池外围一圈）」） */
function relatedGroupTotalHit(value, name, localContext, groupTotals) {
	for (const [groupName, sums] of groupTotals) {
		if (groupName === name) continue;
		if (!groupName.includes(name) && !name.includes(groupName) && !nameOverlapsText(groupName, localContext)) continue;
		if (sums.some((sum) => nearlyEqual(sum, value))) return true;
	}
	return false;
}
/** D4.6a 豁免：正文自洽演算（窗口内两数之和/差恰等于该值；案例：总量 8205.53m、其中 7965m、未标规格 240.53m） */
function windowArithmeticHit(markdown, at, nameLength, value) {
	const window = markdown.slice(Math.max(0, at - 40), at + nameLength + 40);
	const numbers = [];
	for (const numMatch of window.matchAll(/\d+(?:\.\d+)?/gu)) {
		const parsed = Number.parseFloat(numMatch[0]);
		if (Number.isFinite(parsed) && !nearlyEqual(parsed, value)) numbers.push(parsed);
	}
	for (let i = 0; i < numbers.length; i += 1) for (let j = i + 1; j < numbers.length; j += 1) {
		if (nearlyEqual(numbers[i] + numbers[j], value)) return true;
		if (nearlyEqual(Math.abs(numbers[i] - numbers[j]), value)) return true;
	}
	return false;
}
/** D4.6a 豁免：同名条目子集和（4.31 丰乐镇 v6 #4-61）：正文绑定值恰为一组同名清单条目（多村组分项）
* 的子集之和时属聚合口径的正常引用（案例：挖一般土方 4040.45 = 同名 37 条全和 4187.38 − 146.93），
* 原“同名值集（单条）/组和（整组）”豁免覆盖不到的任意子集被逐条误报「绑定无源」——
* 丰乐镇 58 条同根因（4040.45/146.93/158.25/572.3/633 五个子集和对不同村组权威循环误报）。
* meet-in-middle 精确 cents 判定：池上限 40 条防组合爆炸；单元素表示由同名值集豁免覆盖，此处只认
* ≥2 元素组合（池内存在同值单条即返回 false）。
* 4.32 扩围（丰乐镇 v6 复测「回填方 4270」44 条放大误报）：同名池超 40 条上限时原实现整体返回
* false，44 条「回填方」池的 4270 = 3570 + 700（两值组合）失去豁免，命中的每个同名条目逐条误报
* 「绑定无源」——超限池退化为浅组合判定（正向两值和 / 全和减单值 / 全和减两值和，O(n²) 任意池
* 大小），深组合（≥3 元素）仍仅对 ≤40 池由 meet-in-middle 判定；浅组合不允许单元素表示。 */
function subsetSumCentsHit(poolCents, targetCents) {
	if (poolCents.length < 2 || targetCents <= 0) return false;
	const sorted = [...poolCents].sort((left, right) => left - right);
	if (sorted.some((cents) => cents === targetCents)) return false;
	const total = sorted.reduce((sum, cents) => sum + cents, 0);
	if (targetCents > total) return false;
	const reverseTarget = total - targetCents;
	if (reverseTarget > 0 && reverseTarget !== targetCents) {
		const ceiling = Math.max(targetCents, reverseTarget);
		for (let i = 0; i < sorted.length; i += 1) for (let j = i + 1; j < sorted.length; j += 1) {
			const pairSum = sorted[i] + sorted[j];
			if (pairSum > ceiling) break;
			if (pairSum === targetCents || pairSum === reverseTarget) return true;
		}
		let lo = 0;
		let hi = sorted.length - 1;
		while (lo <= hi) {
			const mid = lo + hi >> 1;
			if (sorted[mid] === reverseTarget) return sorted.length >= 3;
			if (sorted[mid] < reverseTarget) lo = mid + 1;
			else hi = mid - 1;
		}
	} else for (let i = 0; i < sorted.length; i += 1) for (let j = i + 1; j < sorted.length; j += 1) {
		const pairSum = sorted[i] + sorted[j];
		if (pairSum > targetCents) break;
		if (pairSum === targetCents) return true;
	}
	if (sorted.length > 40) return false;
	const half = Math.ceil(sorted.length / 2);
	const first = sorted.slice(0, half);
	const second = sorted.slice(half);
	const sumsOf = (items) => {
		let sums = new Set([0]);
		for (const item of items) {
			const next = /* @__PURE__ */ new Set();
			for (const partial of sums) {
				next.add(partial);
				next.add(partial + item);
			}
			sums = next;
		}
		return sums;
	};
	const secondSums = sumsOf(second);
	for (const firstSum of sumsOf(first)) if (secondSums.has(targetCents - firstSum)) return true;
	return false;
}
function scanNameBindingFindings(markdown, authority, lock) {
	const findings = [];
	const seen = /* @__PURE__ */ new Set();
	const reportedBindings = /* @__PURE__ */ new Set();
	const sameNameSamples = /* @__PURE__ */ new Map();
	if (lock) for (const entry of lock.entries) {
		const sampleName = (entry.name || "").trim();
		if (sampleName.length < 2 || !Number.isFinite(entry.quantity)) continue;
		const sampleKey = `${sampleName}\u0000${normalizeUnit(entry.unit)}`;
		const bucket = sameNameSamples.get(sampleKey) || {
			count: 0,
			samples: []
		};
		bucket.count += 1;
		const sample = `${entry.quantity}${entry.unit}`;
		if (bucket.samples.length < 3 && !bucket.samples.includes(sample)) bucket.samples.push(sample);
		sameNameSamples.set(sampleKey, bucket);
	}
	const authorityText = authority.entries.map((entry) => `${entry.name} ${entry.description}`).join("\n");
	const groupTotals = /* @__PURE__ */ new Map();
	{
		const keySums = /* @__PURE__ */ new Map();
		for (const entry of authority.entries) {
			if (!(entry.value > 0)) continue;
			const key = `${entry.source}\u0000${entry.name}`;
			const bucket = keySums.get(key);
			if (bucket) bucket.sum += entry.value;
			else keySums.set(key, {
				name: entry.name,
				sum: entry.value
			});
		}
		for (const bucket of keySums.values()) {
			const list = groupTotals.get(bucket.name) || [];
			list.push(bucket.sum);
			groupTotals.set(bucket.name, list);
		}
	}
	const subsetPoolCache = /* @__PURE__ */ new Map();
	const subsetHitCache = /* @__PURE__ */ new Map();
	const groupDeltaCache = /* @__PURE__ */ new Map();
	const subsetSumExempt = (targetName, targetUnit, target) => {
		const poolKey = `${targetName}\u0000${targetUnit}`;
		let pool = subsetPoolCache.get(poolKey);
		if (!pool) {
			pool = authority.entries.filter((entry) => entry.name === targetName && normalizeUnit(entry.unit) === targetUnit && entry.value > 0).map((entry) => Math.round(entry.value * 100));
			subsetPoolCache.set(poolKey, pool);
		}
		if (pool.length < 2) return false;
		const hitKey = `${poolKey}\u0000${Math.round(target * 100)}`;
		const cached = subsetHitCache.get(hitKey);
		if (cached !== void 0) return cached;
		const hit = subsetSumCentsHit(pool, Math.round(target * 100));
		subsetHitCache.set(hitKey, hit);
		return hit;
	};
	/** D4.6a 豁免：组和补差（4.31 丰乐镇 v6 检查井 557）：正文值 = 同名条目组和 + 权威池任一值
	* （557 = 塑料检查井 25 条组和 555 + 砌筑检查井 2）——跨名称聚合口径的正常引用；
	* 与 aggregationClosure「相关组和 + 补差」同构（单值补差边界，不得放宽为任意两值拼合）。 */
	const groupDeltaExempt = (targetName, target) => {
		const sums = groupTotals.get(targetName) || [];
		if (sums.length === 0) return false;
		const cacheKey = `${targetName}\u0000${Math.round(target * 100)}`;
		const cached = groupDeltaCache.get(cacheKey);
		if (cached !== void 0) return cached;
		const hit = sums.some((sum) => authority.numberPool.some((pool) => nearlyEqual(sum + pool, target)));
		groupDeltaCache.set(cacheKey, hit);
		return hit;
	};
	if (lock) for (const entry of lock.entries) {
		const name = (entry.name || "").trim();
		if (name.length < 2 || GENERIC_NAME_RE.test(name) || !Number.isFinite(entry.quantity)) continue;
		let from = 0;
		let occurrences = 0;
		while (occurrences < 6) {
			const at = markdown.indexOf(name, from);
			if (at < 0) break;
			from = at + name.length;
			occurrences += 1;
			if (/\d$/u.test(name) && /^[\d.]/u.test(markdown.slice(at + name.length, at + name.length + 1))) {
				from = at + 1;
				continue;
			}
			if (markdown.slice(at + name.length, at + name.length + 1) === "量") continue;
			const window = markdown.slice(at + name.length, at + name.length + 20);
			const valueMatch = /^([^。；;\n|]{0,12}?)([\d,，]+(?:\.\d+)?)\s*(座|个|套|处|盏|棵|株|樘|扇|根|块|片|组|件|孔|间|栋|幢|户|米|m|km|公里|平方米|m2|㎡|m²|立方米|m3|m³|kg|吨|t)(?![a-zA-Z0-9²³])/u.exec(window);
			if (!valueMatch) continue;
			if (SLOT_WORD_RE.test(valueMatch[1])) continue;
			const value = parseNumeric(valueMatch[2]);
			if (value === void 0) continue;
			if (transcribedEqual(value, entry.quantity)) continue;
			const unit = normalizeUnit(valueMatch[3]);
			if (unit !== normalizeUnit(entry.unit)) continue;
			if (authority.entries.some((other) => other.name === name && transcribedEqual(value, other.value) && normalizeUnit(other.unit) === unit)) continue;
			if ((groupTotals.get(name) || []).some((sum) => nearlyEqual(sum, value))) continue;
			if (subsetSumExempt(name, unit, value)) continue;
			if (groupDeltaExempt(name, value)) continue;
			const localContext = markdown.slice(Math.max(0, at - 32), at + name.length + 20);
			if (relatedGroupTotalHit(value, name, localContext, groupTotals)) continue;
			const foreign = authority.entries.find((other) => other.name !== name && nearlyEqual(other.value, value) && normalizeUnit(other.unit) === unit);
			if (foreign && nameOverlapsText(foreign.name, localContext)) continue;
			if (foreign) {
				const bindingKey = `${at}\u0000${value}\u0000${unit}`;
				if (reportedBindings.has(bindingKey)) continue;
				reportedBindings.add(bindingKey);
				const samples = sameNameSamples.get(`${name}\u0000${unit}`);
				const message = samples && samples.count > 1 ? `名称-数值绑定错位：「${name}」处数值 ${value}${valueMatch[3]} 属清单条目「${foreign.name}」（${foreign.value}${foreign.unit}），与同名清单条目（共 ${samples.count} 条，如 ${samples.samples.join("、")} 等）的权威数量均不符` : `名称-数值绑定错位：「${name}」处数值 ${value}${valueMatch[3]} 属清单条目「${foreign.name}」（${foreign.value}${foreign.unit}），与「${name}」清单数量 ${entry.quantity}${entry.unit} 不符`;
				if (seen.has(message)) continue;
				seen.add(message);
				findings.push({
					issue: {
						level: "error",
						severity: "blocker",
						category: "fact_consistency",
						owner: "llm",
						repairability: "llm_repairable",
						message,
						suggestion: samples && samples.count > 1 ? `核对「${name}」的数量口径：同名清单条目共 ${samples.count} 条（如 ${samples.samples.join("、")} 等），逐一核对后引用对应条目数量；引用「${foreign.name}」数量时须明确对象名称，不得张冠李戴。` : `核对「${name}」的数量口径：清单权威值为 ${entry.quantity}${entry.unit}；引用「${foreign.name}」数量时须明确对象名称，不得张冠李戴。`
					},
					matchStart: at,
					matchEnd: at + name.length + valueMatch[0].length
				});
				continue;
			}
			if (windowArithmeticHit(markdown, at, name.length, value)) continue;
			if (authority.numberPool.some((candidate) => nearlyEqual(candidate, value))) continue;
			const bindingKey = `${at}\u0000${value}\u0000${unit}`;
			if (reportedBindings.has(bindingKey)) continue;
			reportedBindings.add(bindingKey);
			const samples = sameNameSamples.get(`${name}\u0000${unit}`);
			const message = samples && samples.count > 1 ? `名称-数值绑定无源：「${name}」处数值 ${value}${valueMatch[3]} 与同名清单条目（共 ${samples.count} 条，如 ${samples.samples.join("、")} 等）的权威数量均不符，且在全部权威数据中找不到同值来源` : `名称-数值绑定无源：「${name}」处数值 ${value}${valueMatch[3]} 与清单权威 ${entry.quantity}${entry.unit} 不符，且在全部权威数据中找不到同值来源`;
			if (seen.has(message)) continue;
			seen.add(message);
			findings.push({
				issue: {
					level: "error",
					severity: "blocker",
					category: "fact_consistency",
					owner: "llm",
					repairability: "llm_repairable",
					message,
					suggestion: samples && samples.count > 1 ? `核对「${name}」的数量口径：同名清单条目共 ${samples.count} 条（如 ${samples.samples.join("、")} 等），逐一核对后引用对应条目的权威数量；无权威来源的数值不得与清单条目名称绑定出现。` : `将「${name}」的数量改为清单权威值 ${entry.quantity}${entry.unit}；无权威来源的数值不得与清单条目名称绑定出现。`
				},
				matchStart: at,
				matchEnd: at + name.length + valueMatch[0].length
			});
		}
	}
	for (const match of markdown.matchAll(MATERIAL_OBJECT_RE)) {
		const compound = match[0];
		if (authorityText.includes(compound)) continue;
		const objectWord = match[2];
		const after = markdown.slice((match.index ?? 0) + compound.length, (match.index ?? 0) + compound.length + 16);
		const valueMatch = /^([^。；;\n|]{0,10}?)([\d,，]+(?:\.\d+)?)\s*(樘|扇|套|座|盏|个)(?![a-zA-Z0-9²³])/u.exec(after);
		if (!valueMatch) continue;
		const value = parseNumeric(valueMatch[2]);
		if (value === void 0) continue;
		const sameObject = authority.entries.find((entry) => entry.name.includes(objectWord) && nearlyEqual(entry.value, value) && normalizeUnit(entry.unit) === normalizeUnit(valueMatch[3]));
		if (!sameObject) continue;
		const message = `名称口径不符：正文「${compound} ${value}${valueMatch[3]}」——${value}${valueMatch[3]} 对应清单「${sameObject.name}」条目，清单中不存在「${compound}」，名称与清单权威不符`;
		if (seen.has(message)) continue;
		seen.add(message);
		const compoundStart = match.index ?? 0;
		findings.push({
			issue: {
				level: "error",
				severity: "blocker",
				category: "fact_consistency",
				owner: "llm",
				repairability: "llm_repairable",
				message,
				suggestion: `名称必须与清单条目口径一致：将「${compound}」改为「${sameObject.name}」（或清单原文名称）；名称与数量绑定不得自行替换材质/类型限定词。`
			},
			matchStart: compoundStart,
			matchEnd: compoundStart + compound.length + valueMatch[0].length
		});
	}
	return findings;
}
/** 检测端入口（行为保持）：扫描命中只取 issue */
function scanNameBindings(markdown, authority, lock) {
	return scanNameBindingFindings(markdown, authority, lock).map((finding) => finding.issue);
}
/**
* D4 数值对账六类检测器（终检 standard-final 组）：
* 输入 = 最终 markdown + 清单事实锁 + 蓝图参数桶 + 事实主表；权威缺失的规则自行跳过。
*/
function factReconciliationIssues(input) {
	const markdown = input.markdown || "";
	if (!markdown) return [];
	const authority = buildReconciliationAuthority(input);
	if (authority.entries.length === 0 && authority.numberPool.length === 0) return [];
	const issues = [
		...scanTotalClaims(markdown, authority),
		...scanSpecQuantityBindings(markdown, authority),
		...scanSlotSemantics(markdown, authority),
		...scanApproximateClaims(markdown, authority),
		...scanNameBindings(markdown, authority, input.billFactLock)
	];
	const deduped = [];
	const seen = /* @__PURE__ */ new Set();
	for (const issue of issues) {
		const key = `${issue.severity || issue.level}|${issue.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(issue);
		if (deduped.length >= MAX_ISSUES) break;
	}
	return deduped;
}
var SLOT_WORD_RE, TOTAL_CLAIM_RE, SPEC_CANDIDATE_RE, DEVICE_BODY_RE, SLOT_DEPTH_RE, APPROX_PREFIX_RE, APPROX_SUFFIX_RE, APPROX_PREFIX_EXEMPT_RE, GENERIC_NAME_RE, MATERIAL_OBJECT_RE, MAX_ISSUES;
var init_factReconciliation = __esmMin((() => {
	SLOT_WORD_RE = /(?:每|厚度|宽度|高度|深度|长度|直径|间距|净距|坡度|标高|偏差|误差|系数|等级|龄期|温度|含水率|压实度|密度|功率|电压|照度|色温|耐火|强度|抗渗|配合比|搭接|错缝|含水|埋深|覆土|预留|预埋|伸缩|沉降|变形|垂直度|平整度|倾角|坡度|模数|螺距|壁厚|净空|层高|埋设|位置|距离|半径|周长|坡度)/u;
	TOTAL_CLAIM_RE = /(?:合计|共计|总计|总共|总量|总数|总长|全长|总长度|总数量|总面积|总重量|小计)(?:为|达|约|共|计)?\s*([\d,，]+(?:\.\d+)?)\s*(立方米|m³|m3|平方米|㎡|m²|m2|公里|千米|km|kg|吨|t|座|个|套|处|盏|棵|株|樘|扇|根|块|片|组|件|孔|间|栋|幢|户|米|m)(?![a-zA-Z0-9²³])/gu;
	SPEC_CANDIDATE_RE = /(?:DN|De|Φ|φ|Ø|dn|de)\s*\d+(?:\.\d+)?|(?<![A-Za-z0-9])[CM]\d{2,3}(?![0-9])|HRB\d+|HPB\d+|(?<![A-Za-z0-9])\d{2,4}\s*[×xX*]\s*\d{2,4}(?![0-9])|(?<![A-Za-z0-9])\d+(?:\.\d+)?\s*[kK]?[Ww](?![A-Za-z0-9])/gu;
	DEVICE_BODY_RE = /运输车|搅拌车|罐车|挖掘机|挖机|装载机|压路机|摊铺机|打夯机|夯实机|洒水车|浇水车|吊车|起重机|泵车|地泵|发电机组|发电机|电焊机|空压机|水泵|提升泵|潜水泵|雾炮机|机械|设备|机具|车辆|机组/u;
	SLOT_DEPTH_RE = /(?:埋深|覆土(?:厚度|深度)?|管顶覆土)(?:不小于|不大于|不低于|不超过|约|为|达|控制在|一般|宜|应)?[^。；;\n|]{0,10}?([\d,，]+(?:\.\d+)?)\s*(mm|cm|米|m)(?![a-zA-Z0-9²³])/gu;
	APPROX_PREFIX_RE = /(?:约为|大约|约计|约|将近|近)\s*([\d,，]+(?:\.\d+)?)\s*(点|处|座|个|套|盏|棵|株|樘|扇|根|块|片|组|件|孔|间|栋|幢|户|米|公里|km|m2|㎡|m²|平方米|m3|m³|立方米|kg|吨|t|l|升|kw|w)(?![a-zA-Z0-9²³³])/giu;
	APPROX_SUFFIX_RE = /([\d,，]+(?:\.\d+)?)\s*余\s*(点|处|座|个|套|盏|棵|株|樘|扇|根|块|片|组|件|孔|间|栋|幢|户|米|公里|km|m2|㎡|m²|平方米|m3|m³|立方米|kg|吨|t)(?![a-zA-Z0-9²³])/gu;
	APPROX_PREFIX_EXEMPT_RE = /[节制合履签违公盟密租最接靠邻附距离]/u;
	GENERIC_NAME_RE = /^(?:管道|工程|材料|项目|施工|工作|设备|设施|系统|区域|场地|道路|建筑|结构|基础|主体|管网|土建|安装|装饰|装修|土方|绿化|照明|给水|排水|电气|挖方|填方|回填|弃方|外运|运输|检测|试验|测量|清理|拆除|清淤|维护|养护|管理|服务|其他|以上|以下|其中|包括|采用|使用|型号|规格|数量|单位|合计|总计|长度|面积|体积|重量)$/u;
	MATERIAL_OBJECT_RE = /(木质|木|铝合金|铝|不锈钢|塑钢|塑料|塑|钢|铁|砼|混凝土|铸铁|铜|复合)(门|窗|井|灯|护栏|围栏|盖板|雨水口)/gu;
	MAX_ISSUES = 60;
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
			id: "sentence-pattern-repeat",
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
			id: "basis-regulations-cross",
			scope: "full-document",
			category: "fact_consistency"
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
	[...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS];
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
var init_chapterParameterFacts = __esmMin((() => {
	init_factsModel();
	init_poolNoise();
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
//#region apps/server/src/services/document-workflow/numericalConsistency.ts
/** 两段文本的最长公共连续汉字子串长度（同位置判定：连续重合 ≥3 个汉字才算同位置）。
* 集合重叠会把"采用/养护"等分散高频字计入，连续子串要求位置与顺序双重一致。
* 亦被概况复述检测（detectors.overviewRecapIssues）复用为逐字搬用判定。 */
function longestCommonHanSubstring(left, right) {
	const a = left.match(/[\p{Script=Han}]/gu) || [];
	const b = right.match(/[\p{Script=Han}]/gu) || [];
	if (a.length === 0 || b.length === 0) return 0;
	let best = 0;
	const dp = new Array(b.length).fill(0);
	for (let i = 0; i < a.length; i += 1) {
		let prev = 0;
		for (let j = 0; j < b.length; j += 1) {
			const carry = dp[j];
			dp[j] = a[i] === b[j] ? prev + 1 : 0;
			prev = carry;
			if (dp[j] > best) best = dp[j];
		}
	}
	return best;
}
/** longestCommonHanSubstring 的带位置变体：返回最长公共连续汉字子串的长度与其在 left 原文
* 中的下标区间 [start, end)（V5 P4b-2 阶段名拼接歧义判定用——需知道最长命中片段未覆盖的
* 残余前/后片段）。长度口径与 longestCommonHanSubstring 严格一致（同一 DP 与严格改进口径）。 */
function longestCommonHanSubstringSpan(left, right) {
	const aMatches = [...left.matchAll(/[\p{Script=Han}]/gu)];
	const b = right.match(/[\p{Script=Han}]/gu) || [];
	if (aMatches.length === 0 || b.length === 0) return {
		length: 0,
		start: 0,
		end: 0
	};
	let best = 0;
	let bestI = -1;
	const dp = new Array(b.length).fill(0);
	for (let i = 0; i < aMatches.length; i += 1) {
		let prev = 0;
		for (let j = 0; j < b.length; j += 1) {
			const carry = dp[j];
			dp[j] = aMatches[i][0] === b[j] ? prev + 1 : 0;
			prev = carry;
			if (dp[j] > best) {
				best = dp[j];
				bestI = i;
			}
		}
	}
	if (best === 0 || bestI < 0) return {
		length: 0,
		start: 0,
		end: 0
	};
	const startMatch = aMatches[bestI - best + 1];
	const endMatch = aMatches[bestI];
	return {
		length: best,
		start: startMatch.index,
		end: endMatch.index + endMatch[0].length
	};
}
var init_numericalConsistency = __esmMin((() => {}));
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
/** 概念归一化：去除单位词与标点后仅保留概念词面 */
function normalizeConcept(concept) {
	return concept.replace(/(?:mm|cm|m|MPa|kN|kV|kW|℃|元|万元|人|天|日|个|层|樘|处|套|台|t|吨)/gu, "").replace(/[\s,，、；;：:（）()]/gu, "");
}
function dot$1(left, right) {
	const length = Math.min(left.length, right.length);
	let sum = 0;
	for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
	return sum;
}
/** 出现位所在句文本（r18 B2 总量分解句豁免）：向前/后扩至句界（。；; 换行），无边界时取到文首/文尾 */
function sentenceTextAt(markdown, index) {
	const marks = [
		"。",
		"；",
		";",
		"\n"
	];
	let start = 0;
	for (const mark of marks) {
		const at = markdown.lastIndexOf(mark, index - 1);
		if (at + 1 > start) start = at + 1;
	}
	let end = markdown.length;
	for (const mark of marks) {
		const at = markdown.indexOf(mark, index);
		if (at >= 0 && at < end) end = at;
	}
	return markdown.slice(start, end);
}
/** 值文本在完整匹配内的偏移定位（prefix 字符类可含数字，「3号塑料管3m」类 indexOf 会误中前缀数字）：
* 优先从单位反向回溯（数字与单位紧邻、允许空白），失败回退首个同文本命中 */
function locateValueOffset(matchText, valueText, unitText) {
	if (!unitText) return matchText.indexOf(valueText);
	const unitAt = matchText.lastIndexOf(unitText);
	if (unitAt >= 0) {
		const direct = unitAt - valueText.length;
		if (direct >= 0 && matchText.slice(direct, unitAt) === valueText) return direct;
		const loose = new RegExp(`(${valueText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")})\\s*$`, "u").exec(matchText.slice(0, unitAt));
		if (loose && loose.index !== void 0) return loose.index;
	}
	return matchText.indexOf(valueText);
}
function extractParamTokens(markdown) {
	const tokenByRaw = /* @__PURE__ */ new Map();
	let lineStart = 0;
	for (const line of markdown.split("\n")) {
		const trimmed = line.trim();
		const currentLineStart = lineStart;
		lineStart += line.length + 1;
		if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) continue;
		for (const match of line.matchAll(new RegExp(PARAM_TOKEN_RE.source, "gu"))) {
			let prefix = (match[1] || "").trim();
			let valueText = match[2];
			const trailingDigits = /\d+$/u.exec(prefix);
			if (trailingDigits) {
				prefix = prefix.slice(0, trailingDigits.index).trim();
				valueText = `${trailingDigits[0]}${valueText}`;
			}
			const value = Number(valueText);
			const unit = match[3] || "";
			const suffixRaw = (match[4] || "").trim();
			const embeddedItem = /[与和及][^与和及]{0,12}?\d/u.exec(suffixRaw);
			const suffix = embeddedItem ? suffixRaw.slice(0, embeddedItem.index) : suffixRaw;
			const rawConcept = `${prefix}${suffix}`.replace(/[\s,，、；;：:]/gu, "");
			const strippedConcept = rawConcept.replace(CONCEPT_LEAD_IN_RE, "").replace(CONCEPT_TASK_DEADLINE_RE, "");
			const concept = strippedConcept.length >= 2 ? strippedConcept : rawConcept;
			if (concept.length < 2 || !/[\u4e00-\u9fa5A-Za-z]{2,}/u.test(concept) || !Number.isFinite(value) || value <= 0) continue;
			if (GENERIC_MEASURE_WORDS.some((word) => normalizeConcept(concept) === word)) continue;
			if (BARE_RELATION_WORDS.some((word) => normalizeConcept(concept) === word)) continue;
			if (CONCEPT_BLACKLIST_RE.test(concept)) continue;
			if (VARIANT_QUALIFIER_RE.test(concept)) continue;
			const occurrence = {
				matchIndex: currentLineStart + (match.index || 0),
				valueOffset: locateValueOffset(match[0], valueText, match[3] || ""),
				valueText
			};
			const existing = tokenByRaw.get(match[0]);
			if (existing) {
				existing.occurrences.push(occurrence);
				continue;
			}
			tokenByRaw.set(match[0], {
				concept,
				value,
				unit,
				raw: match[0],
				occurrences: [occurrence]
			});
		}
	}
	return [...tokenByRaw.values()].slice(0, 60);
}
/** 并查集：两两语义相似 ≥0.6 的概念合并为同簇（自组织聚类） */
function clusterConcepts(concepts, similarity) {
	const parent = new Map(concepts.map((concept) => [concept, concept]));
	const find = (node) => {
		const root = parent.get(node) || node;
		return root === node ? node : (parent.set(node, find(root)), parent.get(node) || node);
	};
	const union = (left, right) => {
		parent.set(find(left), find(right));
	};
	for (let left = 0; left < concepts.length; left += 1) for (let right = left + 1; right < concepts.length; right += 1) if (similarity(concepts[left], concepts[right]) >= .6) union(concepts[left], concepts[right]);
	return parent;
}
/**
* 冲突组扫描（4.27.0 从 parameterConceptConflictIssues 抽出，行为保持）：
* L1 正则提取 → bge 概念自组织聚类 → 同簇同单位显著差异判定，返回结构化冲突组。
* 检测端（message 生成）与 A1 裁决器（三分支替换/降级）共用同一扫描口径（检测定位=修复定位）。
*/
async function conceptConflictGroups(markdown) {
	const tokens = extractParamTokens(markdown);
	if (tokens.length < 3) return { groups: [] };
	const concepts = [...new Set(tokens.map((token) => token.concept))];
	if (concepts.length < 2) return { groups: [] };
	const vectors = await getLocalSemanticProvider().embedDocuments(concepts);
	if (vectors.length !== concepts.length) {
		const detail = `本地语义模型嵌入数量不一致：期望 ${concepts.length} 条，实际 ${vectors.length} 条`;
		console.warn(`[gen] parameter-concept-conflict degraded: ${detail}`);
		return {
			groups: [],
			degraded: {
				level: "warning",
				severity: "warning",
				category: "format",
				owner: "system",
				repairability: "manual_review",
				message: `参数概念口径冲突检测已降级跳过：${detail}`,
				suggestion: "语义模型输出异常，本轮未执行该检测维度；可稍后重新生成复核。"
			}
		};
	}
	const vectorOf = new Map(concepts.map((concept, index) => [concept, vectors[index]]));
	const similarity = (left, right) => {
		const leftVector = vectorOf.get(left);
		const rightVector = vectorOf.get(right);
		if (!leftVector || !rightVector || leftVector.length === 0 || rightVector.length === 0) return 0;
		return dot$1(leftVector, rightVector);
	};
	const parent = clusterConcepts(concepts, similarity);
	const find = (node) => {
		let current = node;
		while ((parent.get(current) || current) !== current) current = parent.get(current) || current;
		return current;
	};
	const clusters = /* @__PURE__ */ new Map();
	for (const token of tokens) {
		const root = find(token.concept);
		const group = clusters.get(root) || [];
		group.push(token);
		clusters.set(root, group);
	}
	const groups = [];
	for (const group of clusters.values()) {
		if (group.length < 2) continue;
		if (Math.max(...group.map((token) => token.value)) > Math.min(...group.map((token) => token.value)) * 4) continue;
		const byUnit = /* @__PURE__ */ new Map();
		for (const token of group) {
			const unitGroup = byUnit.get(token.unit) || [];
			unitGroup.push(token);
			byUnit.set(token.unit, unitGroup);
		}
		for (const unitGroupAll of byUnit.values()) {
			if (unitGroupAll.length < 2) continue;
			const byDimension = /* @__PURE__ */ new Map();
			for (const token of unitGroupAll) {
				const dimension = CONCEPT_DIMENSION_WORDS.find((word) => token.raw.includes(word)) || "";
				const bucket = byDimension.get(dimension) || [];
				bucket.push(token);
				byDimension.set(dimension, bucket);
			}
			const unitGroups = [...byDimension.keys()].filter((key) => key !== "").length >= 2 && !byDimension.has("") ? [...byDimension.values()] : [unitGroupAll];
			for (const unitGroup of unitGroups) {
				if (unitGroup.length < 2) continue;
				const actions = unitGroup.map((token) => CONCEPT_ACTION_WORDS.find((word) => token.raw.includes(word)) || "");
				if (actions.length >= 2 && actions.every((action) => action !== "") && new Set(actions).size === actions.length) continue;
				const instanceMatches = unitGroup.map((token) => /^([\u4e00-\u9fa5]{2,})([一二三四五六七八九十]|\d+)$/u.exec(token.concept)).filter((match) => match !== null);
				if (instanceMatches.length === unitGroup.length && instanceMatches.length >= 2 && new Set(instanceMatches.map((match) => match[1])).size === 1 && new Set(instanceMatches.map((match) => match[2])).size === instanceMatches.length) continue;
				const perEveryBases = unitGroup.map((token) => {
					const at = token.raw.indexOf("按每");
					return at >= 0 ? token.raw.slice(0, at) : null;
				});
				if (perEveryBases.every((basis) => basis !== null)) {
					if (!perEveryBases.some((left, leftIndex) => Boolean(left) && perEveryBases.some((right, rightIndex) => leftIndex !== rightIndex && Boolean(right) && (left === right || left.includes(right) || right.includes(left))))) continue;
				}
				if (unitGroup.every((token) => token.occurrences.some((occurrence) => /违约金|解除合同|提高至|自第|逾期超过/u.test(markdown.slice(Math.max(0, occurrence.matchIndex - 30), occurrence.matchIndex + token.raw.length + 40))))) continue;
				const values = [...new Set(unitGroup.map((token) => token.value))];
				if (values.length < 2) continue;
				const maxValue = Math.max(...values);
				if (maxValue - Math.min(...values) <= maxValue * .02) continue;
				const valuesSum = values.reduce((sum, value) => sum + value, 0);
				if ([...new Set(unitGroup.flatMap((token) => token.occurrences.map((occurrence) => sentenceTextAt(markdown, occurrence.matchIndex))))].some((sentence) => /(?:总量|合计|总计|共计)/u.test(sentence) && /(?:其中|分别为|分为)/u.test(sentence) && unitGroup.every((token) => token.occurrences.some((occurrence) => sentenceTextAt(markdown, occurrence.matchIndex) === sentence)) && [...sentence.matchAll(/\d+(?:\.\d+)?/gu)].some((match) => Math.abs(Number(match[0]) - valuesSum) <= Math.max(.5, valuesSum * .01)))) continue;
				if (unitGroup.filter((token) => token.occurrences.some((occurrence) => {
					const after = markdown.slice(occurrence.matchIndex, occurrence.matchIndex + token.raw.length + 12);
					const before = markdown.slice(Math.max(0, occurrence.matchIndex - 12), occurrence.matchIndex);
					return /[、/](?:与)?[A-Za-z]?\d/u.test(after) || /[、/](?:与)?[A-Za-z]?\d/u.test(before);
				})).length >= 2) continue;
				if (unitGroup.length >= 2 && unitGroup.every((left, leftIndex) => unitGroup.every((right, rightIndex) => {
					if (leftIndex >= rightIndex) return true;
					if (left.value === right.value) return true;
					const shorterConcept = left.concept.length <= right.concept.length ? left.concept : right.concept;
					const longerConcept = left.concept.length <= right.concept.length ? right.concept : left.concept;
					if (shorterConcept.length >= 4 && shorterConcept.length < longerConcept.length && longerConcept.endsWith(shorterConcept) && /^[板梁柱墙底顶]/u.test(shorterConcept)) return true;
					const span = longestCommonHanSubstringSpan(left.concept, right.concept);
					if (span.length < 2) return false;
					const common = left.concept.slice(span.start, span.end);
					const leftRest = left.concept.replace(common, "");
					const rightRest = right.concept.replace(common, "");
					return leftRest.length > 0 && rightRest.length > 0 && !leftRest.includes(rightRest) && !rightRest.includes(leftRest);
				}))) continue;
				groups.push({
					concept: unitGroup[0].concept,
					values: unitGroup
				});
				if (groups.length >= 4) break;
			}
			if (groups.length >= 4) break;
		}
		if (groups.length >= 4) break;
	}
	return { groups };
}
/** 清单单位文本归一（参数 token 单位捕获对 m²/m³ 截尾，须从 raw 原文回取后归一） */
function normalizeUnitToken(unit) {
	return unit.replace(/㎡/gu, "m2").replace(/m²/giu, "m2").replace(/m³/giu, "m3").replace(/\s+/gu, "").toLowerCase();
}
/** token 的原文单位文本（值文本之后紧邻）：如 raw="马圩组46.7m²" → "m²" */
function rawUnitOf(value) {
	const first = value.occurrences[0];
	if (!first) return value.unit;
	const at = value.raw.indexOf(first.valueText);
	if (at < 0) return value.unit;
	return value.raw.slice(at + first.valueText.length) || value.unit;
}
function normalizeLockName(text) {
	return text.replace(/[（(][^）)]*[）)]/gu, "").replace(/[\s,，、；;：:]/gu, "");
}
/** 条目名与概念相关：完全相等，或较长者包含较短者（较短 ≥3 字防两字短名误配） */
function lockNameRelated(entryName, concept) {
	const name = normalizeLockName(entryName);
	const target = normalizeLockName(concept);
	if (name.length < 2 || target.length < 2) return false;
	if (name === target) return true;
	const shorter = name.length <= target.length ? name : target;
	const longer = name.length <= target.length ? target : name;
	return shorter.length >= 3 && longer.includes(shorter);
}
/** 值 → 清单条目命中（数额精确相等[相对容差 0.1%] + 单位兼容 + 语境相关[条目名/村组出现在值邻近窗口]）。
* r9：ctx.entries 可显式覆盖枚举池（蓝图伪条目与清单锁条目并池，裁决源扩展用） */
function lockEntriesForConceptValue(value, ctx) {
	const entries = ctx.entries ?? ctx.billFactLock?.entries ?? [];
	if (entries.length === 0) return [];
	const tolerance = Math.max(.01, value.value * .001);
	const unitText = normalizeUnitToken(rawUnitOf(value));
	const windows = value.occurrences.map((occurrence) => ctx.markdown.slice(Math.max(0, occurrence.matchIndex - 48), occurrence.matchIndex + occurrence.valueOffset + occurrence.valueText.length + 48)).join("\n");
	const matched = [];
	for (const entry of entries) {
		if (!Number.isFinite(entry.quantity) || entry.quantity <= 0) continue;
		if (Math.abs(entry.quantity - value.value) > tolerance) continue;
		const entryUnit = normalizeUnitToken(entry.unit);
		if (unitText && entryUnit && unitText !== entryUnit) continue;
		const nameRelated = lockNameRelated(entry.name, value.concept);
		const villageRelated = entry.villageGroup.trim().length >= 2 && windows.includes(entry.villageGroup.trim());
		if (!nameRelated && !villageRelated) continue;
		matched.push({
			entry,
			nameRelated
		});
		if (matched.length >= 8) break;
	}
	return matched;
}
/** 蓝图参数桶 → 伪清单条目（r9 扩围：第二裁决源）。仅参与分支①（各值分属不同口径=误报降级）
* 的命中判定，不作分支②单锚锁值来源——蓝图聚合/分组值硬替换正文风险高于收益（宁交 LLM）。
* 伪条目 seq 在蓝图池内自增（少量重叠无影响——互斥检查为同源语义，非全局唯一性保证）。 */
function blueprintPseudoEntries(quantities) {
	if (!quantities) return [];
	const entries = [];
	let seq = 1;
	const pushEntry = (name, quantity, unit, sourceFile, villageGroup) => {
		entries.push({
			seq,
			name,
			description: "",
			quantity,
			unit,
			section: "",
			subsection: villageGroup,
			villageGroup,
			sourceFile,
			specQuantityPairs: []
		});
		seq += 1;
	};
	for (const [name, item] of Object.entries(quantities)) {
		const unit = item.unit || "";
		const sourceFile = item.sourceFile || "";
		if (Number.isFinite(item.value) && item.value > 0) pushEntry(name, item.value, unit, sourceFile, "");
		for (const group of item.groups || []) {
			if (!Number.isFinite(group.value) || group.value <= 0) continue;
			pushEntry(`${name}（${group.group}）`, group.value, unit, sourceFile, group.group);
		}
	}
	return entries;
}
/** 单组三分支裁决（纯函数；两裁决源均缺失时恒无锚→分支③，与历史行为一致）。
* r9 扩围（r9 实机 #9 归因：正文两合法口径被概念聚类误报冲突）：裁决池 = 清单锁条目（唯一
* 锁值来源）+ 蓝图参数桶伪条目（仅分支①命中依据）——「塑料管铺设 8205.53m/7525.01m」两值
* 各自命中蓝图 DN200/DN110 口径 → 分支①降级，不再裸坠 LLM 修复轮。 */
function arbitrateConceptGroup(group, ctx) {
	if (group.values.length < 2) return { verdict: "no-anchor" };
	const billEntries = ctx.billFactLock?.entries ?? [];
	const pseudoEntries = blueprintPseudoEntries(ctx.blueprintQuantities);
	if (billEntries.length === 0 && pseudoEntries.length === 0) return { verdict: "no-anchor" };
	const hits = group.values.map((value) => ({
		value,
		matches: lockEntriesForConceptValue(value, {
			markdown: ctx.markdown,
			entries: [...billEntries, ...pseudoEntries]
		}),
		billMatches: lockEntriesForConceptValue(value, {
			markdown: ctx.markdown,
			entries: billEntries
		})
	}));
	if (hits.every((hit) => hit.matches.length > 0)) {
		if (hits.every((left, leftIndex) => hits.every((right, rightIndex) => leftIndex === rightIndex || !left.matches.some((leftMatch) => right.matches.some((rightMatch) => rightMatch.entry.seq === leftMatch.entry.seq))))) return {
			verdict: "distinct-lock-entries",
			entries: hits.map((hit) => `「${hit.matches[0].entry.name}」（${hit.value.value}${hit.value.unit}）`).join("、")
		};
	}
	const anchored = hits.filter((hit) => hit.billMatches.length > 0);
	const unanchored = hits.filter((hit) => hit.matches.length === 0);
	if (anchored.length === 1 && unanchored.length > 0 && anchored.length + unanchored.length === hits.length) {
		const best = anchored[0].billMatches.find((match) => match.nameRelated);
		if (best) return {
			verdict: "single-lock-entry",
			lockValue: best.entry.quantity,
			lockUnit: best.entry.unit,
			entryName: best.entry.name,
			nonLock: unanchored.map((hit) => hit.value)
		};
	}
	return { verdict: "no-anchor" };
}
async function parameterConceptConflictIssues(markdown, opts) {
	const scan = await conceptConflictGroups(markdown);
	if (scan.degraded) return [scan.degraded];
	if (scan.groups.length === 0) return [];
	const blocking = [];
	const acquitted = [];
	for (const group of scan.groups) {
		const arbitration = arbitrateConceptGroup(group, {
			markdown,
			billFactLock: opts?.billFactLock,
			blueprintQuantities: opts?.blueprintQuantities
		});
		if (arbitration.verdict === "distinct-lock-entries") acquitted.push({
			group,
			entries: arbitration.entries
		});
		else blocking.push(group);
	}
	const issues = [];
	if (blocking.length > 0) {
		const conflicts = blocking.map((group) => `“${group.concept}”出现多个口径：${[...new Set(group.values.map((value) => value.raw))].slice(0, 3).join("、")}`);
		issues.push({
			level: "error",
			severity: "blocker",
			category: "fact_consistency",
			owner: "llm",
			repairability: "llm_repairable",
			message: `同一参数概念出现多口径数值冲突：${conflicts.join("；")}`,
			suggestion: "以绑定资料（图纸/清单/规范）裁决口径为准统一数值表述：每个参数概念全文只保留一个口径数值，删除矛盾表述。"
		});
	}
	if (acquitted.length > 0) issues.push({
		level: "info",
		severity: "suggestion",
		category: "fact_consistency",
		owner: "system",
		repairability: "not_repair_needed",
		message: `参数概念多口径已裁决为不同清单条目口径（不构成冲突）：${acquitted.map(({ group, entries }) => `“${group.concept}”对应${entries}`).join("；")}`,
		suggestion: "各数值分别对应不同的工程量清单条目，正文已带条目名区分，无需处理。"
	});
	return issues;
}
var PARAM_TOKEN_RE, GENERIC_MEASURE_WORDS, BARE_RELATION_WORDS, CONCEPT_LEAD_IN_RE, CONCEPT_TASK_DEADLINE_RE, CONCEPT_BLACKLIST_RE, VARIANT_QUALIFIER_RE, CONCEPT_ACTION_WORDS, CONCEPT_DIMENSION_WORDS;
var init_parameterConceptConflicts = __esmMin((() => {
	init_semanticSimilarity();
	init_numericalConsistency();
	PARAM_TOKEN_RE = /([\u4e00-\u9fa5A-Za-z0-9（）()]{1,12}?)(\d+(?:\.\d+)?)\s*(m²|m³|㎡|mm|cm|m|米|MPa|kN|kV|kW|℃|°C|万元|元|人|天|日|个|层|樘|处|套|台|t|吨)([\u4e00-\u9fa5A-Za-z0-9（）()]{0,8})/gu;
	GENERIC_MEASURE_WORDS = [
		"直径",
		"厚度",
		"宽度",
		"长度",
		"高度",
		"深度",
		"间距",
		"距离",
		"标高",
		"偏差",
		"数量",
		"面积",
		"体积",
		"重量",
		"压力",
		"温度",
		"强度",
		"等级",
		"坡度",
		"规格",
		"尺寸",
		"层数",
		"次数",
		"跨度",
		"半径",
		"总长",
		"全长"
	];
	BARE_RELATION_WORDS = [
		"以内",
		"以外",
		"以上",
		"以下",
		"之间",
		"左右",
		"以前",
		"以后",
		"之前",
		"之后"
	];
	CONCEPT_LEAD_IN_RE = /^(?:主要|本工程|本项目|全项目)?(?:作业对象|作业内容|施工内容|工作内容|工程内容|施工对象|施工范围|工程规模|建设内容|建设规模)为/u;
	CONCEPT_TASK_DEADLINE_RE = /^(?:由)?责任[\u4e00-\u9fa5]{0,4}在(?:内)?完成/u;
	CONCEPT_BLACKLIST_RE = /自然村|村组|标段|区域|点位|养护|地上|地下|建筑高度|[\u4e00-\u9fa5]{1,4}组$/u;
	VARIANT_QUALIFIER_RE = /^(?:局部|个别|少数|多数|大部分)/u;
	CONCEPT_ACTION_WORDS = [
		"开挖",
		"封闭",
		"回填",
		"浇筑",
		"铺筑",
		"摊铺",
		"供应",
		"编制",
		"提交",
		"签订",
		"安装",
		"养护",
		"试验",
		"拆除",
		"砌筑"
	];
	CONCEPT_DIMENSION_WORDS = [
		"直径",
		"半径",
		"穴径",
		"胸径",
		"地径",
		"冠幅",
		"厚度",
		"宽度",
		"长度",
		"高度",
		"深度",
		"穴深",
		"间距",
		"距离",
		"标高",
		"坡度",
		"跨度",
		"株距",
		"行距"
	];
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
//#region apps/server/src/services/document-workflow/basisRegulationsCross.ts
var init_basisRegulationsCross = __esmMin((() => {
	init_qualityValidation();
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
	init_basisRegulationsCross();
}));
//#endregion
//#region apps/server/src/services/document-workflow/tenderBidChecks.ts
var init_tenderBidChecks = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
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
//#region apps/server/src/services/document-workflow/drawingFactLock.ts
var init_drawingFactLock = __esmMin((() => {
	init_evidence();
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
	init_basisRegulationsCross();
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
//#region apps/server/src/services/document-workflow/finalize/repairRounds/basisRegulationsCrossRepair.ts
var init_basisRegulationsCrossRepair = __esmMin((() => {
	init_qualityValidation();
	init_basisRegulationsCross();
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
//#region apps/server/src/services/document-workflow/integrity/fixers/fixers.ts
var init_fixers = __esmMin((() => {
	init_constants();
	init_integratedBlueprint();
	init_detectors();
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
	init_basisRegulationsCrossRepair();
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
function dot(left, right) {
	const length = Math.min(left.length, right.length);
	let sum = 0;
	for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
	return sum;
}
function chunkText(text) {
	const paragraphs = text.split(/\n+/u).map((item) => item.trim()).filter(Boolean);
	const chunks = [];
	let current = "";
	for (const paragraph of paragraphs) if (current && current.length + paragraph.length + 1 > 400) {
		chunks.push(current);
		current = paragraph;
	} else current = current ? `${current}\n${paragraph}` : paragraph;
	if (current) chunks.push(current);
	if (chunks.length <= MAX_CHUNKS) return chunks;
	const sampled = [chunks[0]];
	const step = (chunks.length - 2) / (MAX_CHUNKS - 2);
	for (let index = 1; index < MAX_CHUNKS - 1; index += 1) sampled.push(chunks[Math.min(chunks.length - 2, Math.round(1 + (index - 1) * step))]);
	sampled.push(chunks[chunks.length - 1]);
	return sampled;
}
function maxSimilarity(blockVectors, anchorVectors) {
	let max = 0;
	for (const block of blockVectors) for (const anchor of anchorVectors) {
		const similarity = dot(block, anchor);
		if (similarity > max) max = similarity;
	}
	return max;
}
function dimensionCoverage(blockVectors, anchorCache) {
	const coverage = {};
	for (const dimension of Object.keys(DIMENSION_ANCHORS)) coverage[dimension] = maxSimilarity(blockVectors, anchorCache.get(`dimension:${dimension}`) || []) >= SEMANTIC_COVERAGE_THRESHOLD;
	return coverage;
}
function contentNeedCoverage(blockVectors, anchorCache) {
	const coverage = {};
	for (const needKey of Object.keys(CONTENT_NEED_ANCHORS)) coverage[needKey] = maxSimilarity(blockVectors, anchorCache.get(`need:${needKey}`) || []) >= SEMANTIC_COVERAGE_THRESHOLD;
	return coverage;
}
/** 构建专业深度语义分类器：预嵌入全部锚点；本地语义模型恒可用（本地 ONNX 推理），失败直接抛出 */
async function buildProfessionalDepthClassifier() {
	const provider = getLocalSemanticProvider();
	const anchorGroups = [
		...Object.keys(DIMENSION_ANCHORS).map((dimension) => [`dimension:${dimension}`, DIMENSION_ANCHORS[dimension]]),
		...Object.keys(CONTENT_NEED_ANCHORS).map((needKey) => [`need:${needKey}`, CONTENT_NEED_ANCHORS[needKey]]),
		["concrete", [...CONCRETE_ANCHORS]],
		["closedLoop", [...CLOSED_LOOP_ANCHORS]]
	];
	const anchorCache = /* @__PURE__ */ new Map();
	for (const [key, anchors] of anchorGroups) {
		const vectors = await provider.embedDocuments(anchors);
		if (vectors.length !== anchors.length) throw new Error(`本地语义模型锚点嵌入数量不一致：${key} ${vectors.length}/${anchors.length}`);
		anchorCache.set(key, vectors);
	}
	const blockCache = /* @__PURE__ */ new Map();
	const embedBlocks = async (text) => {
		const cached = blockCache.get(text);
		if (cached !== void 0) return cached;
		const chunks = chunkText(text);
		const vectors = await provider.embedDocuments(chunks);
		blockCache.set(text, vectors);
		return vectors;
	};
	return { async analyze(text) {
		if (!text.trim()) return void 0;
		const blocks = await embedBlocks(text);
		if (blocks.length === 0) return void 0;
		return {
			dimensions: dimensionCoverage(blocks, anchorCache),
			contentNeeds: contentNeedCoverage(blocks, anchorCache),
			concrete: maxSimilarity(blocks, anchorCache.get("concrete") || []) >= SEMANTIC_COVERAGE_THRESHOLD,
			closedLoop: maxSimilarity(blocks, anchorCache.get("closedLoop") || []) >= SEMANTIC_COVERAGE_THRESHOLD
		};
	} };
}
var DIMENSION_ANCHORS, CONTENT_NEED_ANCHORS, CONCRETE_ANCHORS, CLOSED_LOOP_ANCHORS, MAX_CHUNKS;
var init_professionalDepthClassifier = __esmMin((() => {
	init_semanticSimilarity();
	DIMENSION_ANCHORS = {
		factuality: [
			"本章关键数据以招标文件、工程量清单与施工图纸为依据",
			"正文引用的工期、面积、金额与绑定资料口径一致",
			"施工内容与项目实际工程范围对应而非通用模板描述"
		],
		structure: [
			"内容按施工准备、工艺流程、施工方法、验收标准的顺序组织",
			"章节内有清晰的工作阶段划分与工序步骤",
			"段落之间有先后衔接与层次递进关系"
		],
		depth: [
			"包含关键工序控制点、隐蔽工程验收与检验批划分",
			"关键技术环节给出工艺参数与质量标准",
			"针对本项目特点展开专业分析而非通用做法罗列"
		],
		executable: [
			"明确责任主体、检查频次与记录台账要求",
			"给出可执行的资源进场、调配与投入安排",
			"措施可落地执行并配验收复核机制"
		],
		specificity: [
			"结合本项目建设地点、工程规模与计划工期展开",
			"引用本项目工程量数据支撑施工部署",
			"措施针对本项目工程特点制定而非通用套话"
		],
		consistency: [
			"章节间工期、质量、安全数据口径一致",
			"本章内容与总进度计划、质量目标相互呼应",
			"章节内前后表述无矛盾冲突"
		]
	};
	CONTENT_NEED_ANCHORS = {
		schedule: ["采用关键线路法编制进度计划，明确关键节点与动态纠偏措施", "计划节点与资源投入相匹配，含穿插施工与资源保障安排"],
		quality: ["材料进场验收与复验、隐蔽工程验收、质量问题整改与复验闭环", "质量资料归档与检验批验收记录"],
		safety: [
			"风险源辨识、临电消防管理、安全检查与隐患整改闭环",
			"应急预案、应急物资与演练安排",
			"文明施工责任分区、现场保洁与防尘降噪、检查整改销项闭环管理"
		],
		resource: ["劳动力、材料、设备进场计划、验收、保管与调配", "资源投入与进度节点相匹配"],
		construction: ["施工准备、工艺流程、工序控制点与验收标准交底", "施工方法与工艺参数明确具体"]
	};
	CONCRETE_ANCHORS = [
		"材料进场验收、工序控制点、隐蔽工程验收记录",
		"检验批划分、技术交底、整改复查闭环",
		"引用本项目工程量清单与设计图纸参数"
	];
	CLOSED_LOOP_ANCHORS = [
		"自检互检交接检、整改复查、资料归档",
		"风险辨识、专项交底、现场检查、隐患整改、复查销项",
		"计划分解、偏差识别、资源纠偏、节点复核"
	];
	MAX_CHUNKS = 20;
}));
var init_tableScopeAudit = __esmMin((() => {
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
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationBudget.ts
/** 按平均章节目标字数确定每章证据预算区间 */
function evidenceBudgetRange(avgChapterTarget) {
	if (avgChapterTarget >= 6e3) return {
		floorChars: 14e3,
		ceilingChars: 4e4
	};
	if (avgChapterTarget >= 3e3) return {
		floorChars: 11e3,
		ceilingChars: 28e3
	};
	return {
		floorChars: 8e3,
		ceilingChars: 18e3
	};
}
function buildGenerationBudget(input) {
	const chapterCount = Math.max(1, input.chapters.length);
	const avgChapterTargetSafe = input.targetWords > 0 ? Math.round(input.targetWords / chapterCount) : 1200;
	const strategy = input.strategy;
	const triggers = [];
	const sparse = input.materialFileCount < 4 && input.evidenceCount < 6;
	const autoChapterConcurrency = chapterCount;
	const configured = Number.isFinite(input.configuredChapterConcurrency) && input.configuredChapterConcurrency > 0 ? Math.floor(input.configuredChapterConcurrency) : void 0;
	const chapterConcurrency = Math.max(1, Math.min(chapterCount, configured ?? autoChapterConcurrency));
	const llmConcurrency = concurrencyForDocumentScale(input.targetWords);
	const reviewConcurrency = (() => {
		if (strategy.mode === "fast") return 1;
		return Math.max(1, chapterCount);
	})();
	const { floorChars, ceilingChars } = evidenceBudgetRange(avgChapterTargetSafe);
	const repairRoundBudget = (() => {
		if (strategy.repairRoundBudget) return strategy.repairRoundBudget;
		const base = 2;
		const scaleBoost = input.targetWords >= 2e4 ? 1 : 0;
		const sparseBoost = sparse ? 1 : 0;
		return Math.max(2, Math.min(4, base + scaleBoost + sparseBoost));
	})();
	const repairPoolBudget = Math.min(repairRoundBudget * chapterCount, Math.max(12, chapterCount * 2));
	if (strategy.mode === "strict") triggers.push("strict：风险领域关键词命中（专项/安全/质量/验收/合同/合规等）");
	if (input.targetWords >= 4e4) triggers.push("strict：目标篇幅超长（≥4 万字）");
	if (sparse) triggers.push("strict：资料稀疏（资料包文件 <4 且可用证据 <6 条）");
	if (strategy.mode === "fast") triggers.push("fast：小文档（≤6000 字且 ≤4 章）全局审查降级为 35% 抽检");
	if (strategy.mode === "longform") triggers.push("longform：长文档（≥3 万字或 ≥8 章）");
	if (strategy.mode === "balanced") triggers.push("balanced：常规篇幅文档，标准审查深度");
	triggers.push(`全章节并行生成（${chapterConcurrency}/${chapterCount} 章同批），审查流水线 ${reviewConcurrency} 路，全局 LLM 并发不设上限，每章证据预算 ${Math.round(floorChars / 1e3)}k-${Math.round(ceilingChars / 1e3)}k 字符，修复轮次预算每章 ${repairRoundBudget} 轮（文档级总池 ${repairPoolBudget} 轮，收敛判定优先）`);
	return {
		strategy,
		chapterConcurrency,
		reviewConcurrency,
		llmConcurrency,
		evidenceFloorChars: floorChars,
		evidenceCeilingChars: ceilingChars,
		repairRoundBudget,
		repairPoolBudget,
		triggers
	};
}
/**
* U1 生成前体检：运行前校验阶段预估生成策略与预算（目标字数为近似估算）。
* 供 validateDocumentTemplateRun 调用，注意该模块与 rolePipeline 存在依赖链，
* 引用方（templateStore）需动态 import 以避免模块环。
*/
function previewGenerationBudgetForTemplate(input) {
	const chapterCount = Math.max(1, input.chapters.length);
	const targetWords = Math.max(0, Math.round(input.targetWords ?? 0));
	const strategy = selectDocumentGenerationStrategy({
		template: input.template,
		targetWords,
		requirement: input.requirement,
		materialFileCount: input.materialFileCount,
		evidenceCount: input.evidenceCount
	});
	const budget = buildGenerationBudget({
		template: input.template,
		chapters: input.chapters,
		targetWords,
		requirement: input.requirement,
		materialFileCount: input.materialFileCount,
		evidenceCount: input.evidenceCount,
		hasVeryLargeExplicitChapter: input.hasVeryLargeExplicitChapter ?? false,
		configuredChapterConcurrency: input.configuredChapterConcurrency ?? 0,
		strategy
	});
	return {
		mode: strategy.mode,
		enableGlobalReview: strategy.enableGlobalReview,
		globalReviewSamplingRate: strategy.globalReviewSamplingRate ?? 1,
		repairRoundBudget: budget.repairRoundBudget,
		chapterConcurrency: budget.chapterConcurrency,
		reviewConcurrency: budget.reviewConcurrency,
		evidenceFloorChars: budget.evidenceFloorChars,
		evidenceCeilingChars: budget.evidenceCeilingChars,
		targetWords,
		chapterCount,
		triggers: budget.triggers
	};
}
var init_generationBudget = __esmMin((() => {
	init_rolePipeline();
	init_llmClient();
}));
//#endregion
//#region apps/server/src/services/knowledge/kbOperationLog.ts
function logPath(projectRoot) {
	return path$1.join(os$1.homedir(), ".customize-agent", "projects", computeProjectId(projectRoot), "kb-operations.jsonl");
}
function readAll(projectRoot) {
	const file = logPath(projectRoot);
	if (!fs$1.existsSync(file)) return [];
	return fs$1.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}
function trimToRecentEntries(records) {
	if (records.length <= OPERATION_LOG_LIMIT) return records;
	const keepIds = new Set([...records].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, OPERATION_LOG_LIMIT).map((record) => record.id));
	return records.filter((record) => keepIds.has(record.id));
}
function writeAll(projectRoot, records) {
	const file = logPath(projectRoot);
	fs$1.mkdirSync(path$1.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs$1.writeFileSync(tmp, `${trimToRecentEntries(records).map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	fs$1.renameSync(tmp, file);
	const cached = logCache.get(projectRoot);
	if (cached) cached.mtimeMs = logFileMtimeMs(file);
}
function logFileMtimeMs(file) {
	try {
		return fs$1.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}
/** 读取项目日志（含启动恢复）。文件 mtime 未变时命中内存缓存；
* 外部直接改写日志文件（如 clearKbOperations 删除文件）后 mtime 归零，同样触发重读。 */
function cachedRecords(projectRoot) {
	const file = logPath(projectRoot);
	const mtimeMs = logFileMtimeMs(file);
	const cached = logCache.get(projectRoot);
	if (cached && cached.mtimeMs === mtimeMs) return cached.records;
	const records = readAllRecovered(projectRoot);
	logCache.set(projectRoot, {
		mtimeMs: logFileMtimeMs(file),
		records
	});
	return records;
}
/**
* 读取任务日志并把“重启遗留”的 processing 记录标记为中断。
* 任务实际运行在当前进程内，日志仅持久化到磁盘；进程退出（重启/被杀）后
* 遗留的 processing 记录永远不会再被更新，前端会持续显示“有任务在跑”。
* 仅标记 updatedAt 早于本进程启动时刻的记录：本进程刚提交、正在运行的新任务
* 必须跳过，否则 worker 首条 IPC 日志触发其他 bundle 实例的首次读取时，
* 会把新任务误标为“服务重启导致任务中断”，前端轮询到 error 后弹报错。
*/
function readAllRecovered(projectRoot) {
	const records = readAll(projectRoot);
	const interrupted = records.filter((record) => record.status === "processing" && record.updatedAt < PROCESS_START_AT);
	if (interrupted.length > 0) {
		const now = Date.now();
		for (const record of interrupted) {
			record.status = "error";
			record.stage = "error";
			record.error = "服务重启导致任务中断，未完成";
			record.message = record.error;
			record.updatedAt = now;
		}
		writeAll(projectRoot, records);
	}
	return records;
}
function upsertKbOperation(projectRoot, patch) {
	const now = Date.now();
	const records = cachedRecords(projectRoot);
	const index = records.findIndex((record) => record.id === patch.id);
	const current = index >= 0 ? records[index] : void 0;
	const next = {
		id: patch.id,
		type: patch.type,
		title: patch.title,
		stage: patch.stage ?? current?.stage ?? "uploading",
		status: patch.status ?? current?.status ?? "processing",
		message: patch.message ?? current?.message ?? "",
		percent: patch.percent ?? current?.percent ?? 0,
		fileName: patch.fileName ?? current?.fileName,
		filePath: patch.filePath ?? current?.filePath,
		chunkCount: patch.chunkCount ?? current?.chunkCount,
		textLength: patch.textLength ?? current?.textLength,
		extractionMode: patch.extractionMode ?? current?.extractionMode,
		error: patch.status && patch.status !== "error" ? void 0 : patch.error ?? current?.error,
		details: patch.details ?? current?.details,
		createdAt: current?.createdAt ?? now,
		updatedAt: now
	};
	if (index >= 0) records[index] = next;
	else records.push(next);
	writeAll(projectRoot, records);
	return next;
}
var OPERATION_LOG_LIMIT, PROCESS_START_AT, logCache;
var init_kbOperationLog = __esmMin((() => {
	OPERATION_LOG_LIMIT = 200;
	PROCESS_START_AT = Math.round(Date.now() - process.uptime() * 1e3);
	logCache = /* @__PURE__ */ new Map();
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
	init_evidence();
	init_outline$1();
	init_factMatching();
	init_markdownComposer();
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
//#endregion
//#region apps/server/src/services/document-core/generatedDocumentService.ts
function failRunningStages(stages, message) {
	return stages?.map((stage) => stage.status === "running" ? {
		...stage,
		status: "failed",
		message
	} : stage);
}
function fallbackFailedTitle(record) {
	return record.title && record.title !== "生成中" && record.title !== "排队中" ? record.title : `${record.templateName || "文档"}生成失败`;
}
function summarizeCheckpointChapters(chapters) {
	return (chapters || []).map((chapter) => ({
		id: chapter.id,
		title: chapter.title,
		chars: documentTextLength(chapter.content),
		status: chapter.inProgress ? "in_progress" : chapter.content.trim().length > 0 ? "completed" : "failed",
		updatedAt: Date.now(),
		timedOut: chapter.timedOut,
		elapsedMs: chapter.elapsedMs
	}));
}
/** 心跳写盘保底间隔（阶段签名未变时的最小写盘间隔）：默认 30s，与中断宽限联动（宽限 clamp ≥3×心跳） */
function resolveHeartbeatSaveIntervalMs() {
	return Math.max(3e4, Math.min(3e5, Number(process.env.DOCUMENT_PROGRESS_HEARTBEAT_SAVE_INTERVAL_MS ?? 3e4)));
}
function defaultProcessAliveProbe(pid) {
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
/** 中断判定单源（markStaleGeneratingRecord 与轮询短路 generatingRecordRequiresFullPoll 共用，杜绝口径漂移）：
* 1) 宽限期内不判；2) 有归属进程：存活→不判（跨实例保护，超 24h 兜底防 PID 复用悬挂）；已退出→立即判（process-exited）；
* 3) 无归属（升级前存量记录）：早于本进程启动→判；否则超 24h→判。 */
function evaluateStaleInterruption(input) {
	if (input.status !== "generating" && input.status !== "queued") return { stale: false };
	const now = Date.now();
	if (now - input.updatedAt < RECENT_UPDATE_GRACE_MS) return { stale: false };
	if (input.ownerPid) {
		if (processAliveProbe(input.ownerPid)) {
			if (now - input.updatedAt < ABANDONED_RECORD_STALE_MS) return { stale: false };
			return {
				stale: true,
				reason: "heartbeat-lost"
			};
		}
		return {
			stale: true,
			reason: "process-exited"
		};
	}
	if (input.updatedAt < PROCESS_STARTED_AT) return {
		stale: true,
		reason: "owner-unknown"
	};
	if (now - input.updatedAt >= ABANDONED_RECORD_STALE_MS) return {
		stale: true,
		reason: "owner-unknown"
	};
	return { stale: false };
}
function generatedProjectId(projectRoot = getProjectRoot()) {
	return computeProjectId(path.resolve(projectRoot));
}
function generatedRoot(projectRoot = getProjectRoot()) {
	const root = path.join(os.homedir(), ".customize-agent", "projects", generatedProjectId(projectRoot), "generatedDocuments");
	fs.mkdirSync(path.join(root, "drafts"), { recursive: true });
	fs.mkdirSync(path.join(root, "assets"), { recursive: true });
	return root;
}
function indexPath(projectRoot = getProjectRoot()) {
	return path.join(generatedRoot(projectRoot), "index.json");
}
function assetsPath(projectRoot = getProjectRoot()) {
	return path.join(generatedRoot(projectRoot), "assets.json");
}
function draftPath(id, projectRoot = getProjectRoot()) {
	return path.join(generatedRoot(projectRoot), "drafts", `${id}.json`);
}
function draftMetaPath(id, projectRoot = getProjectRoot()) {
	return path.join(generatedRoot(projectRoot), "drafts", `${id}.meta.json`);
}
function writeGeneratedDocumentMeta(record, projectRoot) {
	writeJson(draftMetaPath(record.id, projectRoot), {
		updatedAt: record.updatedAt,
		status: record.status,
		completedAt: record.completedAt,
		ownerPid: record.ownerPid,
		ownerStartedAt: record.ownerStartedAt
	});
}
function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}
/** 原子写 JSON：先写临时文件再 rename，避免进程崩溃时写坏一半的 draft/index 文件 */
function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
	fs.renameSync(tmp, file);
}
function getActiveTaskByDocumentId(documentId) {
	for (const task of tasks.values()) if (task.documentId === documentId) return task;
	return null;
}
function markStaleGeneratingRecord(record, projectRoot = getProjectRoot()) {
	if (record.status !== "generating" && record.status !== "queued" || getActiveTaskByDocumentId(record.id)) return record;
	if (record.status === "queued" && generationQueue.some((job) => job.documentId === record.id)) return record;
	const verdict = evaluateStaleInterruption(record);
	if (!verdict.stale) return record;
	const message = record.status === "queued" ? "排队任务未执行（生成进程已退出或服务重启），请重新发起生成" : "生成任务已中断，请点击继续生成或重新生成";
	const status = record.checkpointChapters?.length ? "warning" : "failed";
	console.warn(`[gen] interrupted: doc=${record.id} reason=${verdict.reason} ownerPid=${record.ownerPid ?? "none"} lastHeartbeat=${new Date(record.updatedAt).toISOString()}`);
	const next = {
		...record,
		title: fallbackFailedTitle(record),
		status,
		error: record.error || message,
		executionStages: failRunningStages(record.executionStages, message),
		completedAt: Date.now(),
		interruptedAt: Date.now(),
		interruptionReason: verdict.reason,
		warningIssues: record.checkpointChapters?.length ? [...record.warningIssues || [], message] : record.warningIssues
	};
	if (record.taskId) upsertDocumentOperation(projectRoot, {
		taskId: record.taskId,
		title: `生成 ${next.title}`,
		status: status === "warning" ? "warning" : "error",
		percent: 100,
		message,
		stages: next.executionStages,
		error: message
	});
	return next;
}
function listGeneratedDocuments(projectRoot = getProjectRoot()) {
	return readJson(indexPath(projectRoot), []).map((item) => {
		if (item.status !== "generating" && item.status !== "queued") return item;
		const fullRecord = readJson(draftPath(item.id, projectRoot), null);
		if (!fullRecord) return item;
		const next = markStaleGeneratingRecord(fullRecord, projectRoot);
		const saved = next !== fullRecord ? saveGeneratedDocument(next, projectRoot, { preserveUpdatedAt: true }) : next;
		return {
			...toGeneratedDocumentListItem(saved),
			queuePosition: saved.status === "queued" ? getQueuedDocumentPosition(saved.id) : void 0
		};
	}).sort((a, b) => (b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt));
}
function getGeneratedDocument(id, projectRoot = getProjectRoot()) {
	const record = readJson(draftPath(id, projectRoot), null);
	if (!record) return null;
	const next = markStaleGeneratingRecord(record, projectRoot);
	return ensureGeneratedDocumentAsset(next !== record ? saveGeneratedDocument(next, projectRoot, { preserveUpdatedAt: true }) : next, projectRoot);
}
function saveGeneratedDocument(record, projectRoot = getProjectRoot(), options) {
	const now = Date.now();
	const next = trimEvidenceContent({
		...record,
		updatedAt: options?.preserveUpdatedAt ? record.updatedAt : now
	});
	writeJson(draftPath(next.id, projectRoot), next);
	writeGeneratedDocumentMeta(next, projectRoot);
	const list = readJson(indexPath(projectRoot), []).filter((item) => item.id !== next.id);
	list.unshift(toGeneratedDocumentListItem(next));
	writeJson(indexPath(projectRoot), list);
	return next;
}
function listGeneratedAssets(projectRoot = getProjectRoot()) {
	return readJson(assetsPath(projectRoot), []).sort((a, b) => b.updatedAt - a.updatedAt);
}
function upsertGeneratedAssets(assets, documentId, projectRoot = getProjectRoot()) {
	const now = Date.now();
	const next = [...listGeneratedAssets(projectRoot)];
	for (const asset of assets) {
		const index = next.findIndex((item) => item.id === asset.id);
		const source = asset.path?.startsWith("generatedDocuments/assets/") || asset.status === "generated" || asset.status === "prompt_ready" ? "generated" : "knowledge_base";
		const record = {
			...asset,
			name: path.basename(asset.path || asset.url || asset.id),
			source,
			indexed: index >= 0 ? next[index].indexed : false,
			usedByDocumentIds: index >= 0 ? [...new Set([...next[index].usedByDocumentIds, documentId])] : [documentId],
			createdAt: index >= 0 ? next[index].createdAt : now,
			updatedAt: now
		};
		if (index >= 0) next[index] = {
			...next[index],
			...record
		};
		else next.push(record);
	}
	writeJson(assetsPath(projectRoot), next);
	return next;
}
function generatedDocumentAssetPath(record) {
	return `generatedDocuments/assets/${safeKnowledgeFileName(record.title)}-${record.id}.md`;
}
function upsertGeneratedDocumentAsset(record, projectRoot = getProjectRoot()) {
	const markdown = record.editedMarkdown || record.markdown;
	if (!markdown?.trim()) return null;
	const relativePath = generatedDocumentAssetPath(record);
	const absolutePath = path.join(generatedRoot(projectRoot), relativePath.replace(/^generatedDocuments\//u, ""));
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(absolutePath, markdown, "utf8");
	const asset = {
		id: `document-${record.id}`,
		type: "file",
		role: "generated",
		path: relativePath,
		status: "generated",
		message: "模板运行生成的 Markdown 文档，仅登记到生成资源，不进入知识库"
	};
	return upsertGeneratedAssets([asset], record.id, projectRoot).find((item) => item.id === asset.id) || null;
}
function ensureGeneratedDocumentAsset(record, projectRoot = getProjectRoot()) {
	if (record.status === "generating" || !(record.editedMarkdown || record.markdown)?.trim()) return record;
	const assetId = `document-${record.id}`;
	if (record.assets?.some((asset) => asset.id === assetId && asset.path)) return record;
	const asset = upsertGeneratedDocumentAsset(record, projectRoot);
	if (!asset) return record;
	return saveGeneratedDocument({
		...record,
		assets: [asset, ...(record.assets || []).filter((item) => item.id !== asset.id)]
	}, projectRoot);
}
function safeKnowledgeFileName(name) {
	return name.replace(/[\\/:*?"<>|]/gu, "_").slice(0, 120) || "generated-document";
}
function trimChapterEvidence(chapter) {
	const maxItems = Math.max(4, Math.floor(tuningProfile().persistEvidenceMaxItems ?? 10));
	const maxChars = Math.max(300, Math.floor(tuningProfile().persistEvidenceItemChars ?? 900));
	return {
		...chapter,
		evidence: (chapter.evidence || []).slice(0, maxItems).map((item) => ({
			...item,
			content: typeof item.content === "string" ? item.content.replace(/\s+/gu, " ").slice(0, maxChars) : ""
		}))
	};
}
function toGeneratedDocumentListItem(record) {
	const latestStage = [...record.executionStages || record.draft?.executionStages || []].reverse().find((stage) => stage.message || stage.subtitle || stage.roleId);
	const chapters = record.partialChapters || summarizeCheckpointChapters(record.checkpointChapters || record.draft?.checkpointChapters || record.draft?.chapters);
	const validationIssues = record.draft?.validationIssues || [];
	const blockerCount = record.draft?.exportGate ? record.draft.exportGate.blockingIssues?.length ?? 0 : validationIssues.filter((issue) => issue.severity === "blocker" || issue.level === "error").length;
	const warningCount = validationIssues.filter((issue) => issue.severity === "warning" || issue.level === "warning").length || record.warningIssues?.length || 0;
	const suggestionCount = validationIssues.filter((issue) => issue.severity === "suggestion" || issue.level === "info").length;
	return {
		id: record.id,
		taskId: record.taskId,
		templateId: record.templateId,
		templateName: record.templateName,
		templateVersion: record.templateVersion,
		title: record.title,
		requirement: record.requirement,
		projectRoot: record.projectRoot,
		projectId: record.projectId,
		knowledgeBasePath: record.knowledgeBasePath,
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		completedAt: record.completedAt,
		elapsedMs: record.completedAt ? record.completedAt - record.createdAt : record.updatedAt - record.createdAt,
		error: record.error,
		warningIssues: (record.warningIssues || []).slice(0, 12),
		warningCount,
		blockerCount,
		suggestionCount,
		wordCount: documentTextLength(record.editedMarkdown || record.markdown || record.draft?.markdown || ""),
		chapterCount: chapters?.length || record.draft?.chapters?.length || 0,
		completedChapterCount: (chapters || []).filter((chapter) => chapter.status === "completed").length,
		latestStage: latestStage?.subtitle || latestStage?.roleName || latestStage?.roleId,
		latestMessage: latestStage?.message,
		assets: (record.assets || []).slice(0, 8),
		partialChapters: chapters
	};
}
function trimEvidenceContent(record) {
	const draft = record.draft ? {
		...record.draft,
		chapters: record.draft.chapters?.map(trimChapterEvidence),
		checkpointChapters: record.draft.checkpointChapters?.map(trimChapterEvidence)
	} : record.draft;
	return {
		...record,
		draft,
		checkpointChapters: record.checkpointChapters?.map(trimChapterEvidence)
	};
}
function documentOperationDetails(stages) {
	return (stages || []).filter((stage) => stage.type === "role_binding" || stage.roleId === "runtime-prompt-rules" || stage.roleId === "document-readiness" || stage.status === "failed").flatMap((stage) => [`${stage.subtitle || stage.roleName || stage.roleId}：${stage.message || stage.status}`, ...(stage.details || []).slice(0, 8).map((detail) => `  - ${detail}`)]).slice(0, 80);
}
function upsertDocumentOperation(projectRoot, input) {
	upsertKbOperation(projectRoot, {
		id: input.taskId,
		type: "document",
		title: input.title,
		stage: input.status === "processing" ? "generating" : input.status === "error" ? "error" : "done",
		status: input.status,
		percent: input.percent,
		message: input.message,
		error: input.error,
		details: documentOperationDetails(input.stages)
	});
}
/** 排队位次（1 起）：不在队列中返回 undefined */
function getQueuedDocumentPosition(documentId) {
	const index = generationQueue.findIndex((job) => job.documentId === documentId);
	return index >= 0 ? index + 1 : void 0;
}
var globalDocumentTaskStore, tasks, generationQueue, ABANDONED_RECORD_STALE_MS, PROCESS_STARTED_AT, RECENT_UPDATE_GRACE_MS, processAliveProbe;
var init_generatedDocumentService = __esmMin((() => {
	init_document_workflow();
	init_semanticSimilarity();
	init_qualityValidation();
	init_kbService();
	init_budget();
	init_tuningProfile();
	init_kbOperationLog();
	globalDocumentTaskStore = globalThis;
	tasks = globalDocumentTaskStore.__generatedDocumentTasks ??= /* @__PURE__ */ new Map();
	generationQueue = globalDocumentTaskStore.__generatedDocumentQueue ??= [];
	ABANDONED_RECORD_STALE_MS = Math.max(60 * 6e4, Number(process.env.DOCUMENT_ABANDONED_RECORD_STALE_MS ?? 1440 * 6e4));
	PROCESS_STARTED_AT = globalDocumentTaskStore.__generatedDocumentProcessStartedAt ??= Date.now();
	RECENT_UPDATE_GRACE_MS = Math.max(Math.max(3e4, Number(process.env.DOCUMENT_RECENT_UPDATE_GRACE_MS ?? 18e4)), resolveHeartbeatSaveIntervalMs() * 3);
	processAliveProbe = defaultProcessAliveProbe;
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
/** 决策项语法模式判定（4.36 D3）：两侧选项词任一命中类目选项 aliases 即返回该类目。
* 两可表述检测器（ambiguous-either-or）与修复链归一（fixAmbiguousEitherOrCandidates）共用——
* 「减振吊架或减振基础」「同步或分段浇筑」「柔性或半刚性」类形态从此走决策注册表，
* 不再逐条扩充硬编码句式表（句式追不上形态的无穷性）。 */
function matchDecisionCategory(sideA, sideB) {
	return DECISION_CATEGORIES.find((category) => {
		const covered = (text) => category.options.some((option) => option.aliases.test(text) || option.weakAliases?.test(text));
		return category.options.some((option) => option.aliases.test(sideA) || option.aliases.test(sideB)) && covered(sideA) && covered(sideB);
	});
}
var DECISION_CATEGORIES;
var init_decisionLock = __esmMin((() => {
	init_factsModel();
	DECISION_CATEGORIES = [
		{
			id: "vertical_transport",
			label: "垂直运输方式",
			relevance: /塔吊|塔式起重机|施工电梯|施工升降机|物料提升机|垂直运输/u,
			options: [
				{
					value: "塔式起重机",
					aliases: /塔吊|塔式起重机/
				},
				{
					value: "施工升降机",
					aliases: /施工电梯|施工升降机/
				},
				{
					value: "物料提升机",
					aliases: /物料提升机/
				},
				{
					value: "汽车式起重机",
					aliases: /汽车吊|汽车式起重机/
				}
			]
		},
		{
			id: "formwork",
			label: "模板体系",
			relevance: /模板/u,
			exclusive: true,
			options: [
				{
					value: "木胶合板模板",
					aliases: /木胶合板|覆膜胶合板|胶合板模板|木模板/
				},
				{
					value: "钢模板",
					aliases: /钢模板|定型钢模/
				},
				{
					value: "铝合金模板",
					aliases: /铝合金模板|铝模/
				},
				{
					value: "大模板",
					aliases: /大模板/
				},
				{
					value: "爬升模板",
					aliases: /爬升模板|爬模/
				}
			]
		},
		{
			id: "concrete_supply",
			label: "混凝土供应",
			relevance: /混凝土/u,
			exclusive: true,
			options: [{
				value: "商品混凝土（预拌）",
				aliases: /商品混凝土|预拌混凝土/
			}, {
				value: "自拌混凝土",
				aliases: /自拌混凝土|现场拌制混凝土|现场搅拌混凝土/
			}]
		},
		{
			id: "scaffold",
			label: "脚手架体系",
			relevance: /脚手架|爬架/u,
			options: [
				{
					value: "落地式钢管脚手架",
					aliases: /落地式[^，。；;]{0,6}脚手架|落地脚手架/
				},
				{
					value: "悬挑式脚手架",
					aliases: /悬挑[^，。；;]{0,6}脚手架|悬挑脚手架/
				},
				{
					value: "附着式升降脚手架",
					aliases: /附着式升降脚手架|爬架/
				},
				{
					value: "门式脚手架",
					aliases: /门式脚手架/
				},
				{
					value: "盘扣式脚手架",
					aliases: /盘扣/
				},
				{
					value: "碗扣式脚手架",
					aliases: /碗扣/
				}
			]
		},
		{
			id: "foundation_support",
			label: "基坑支护形式",
			relevance: /基坑|支护/u,
			exclusive: true,
			options: [
				{
					value: "放坡开挖",
					aliases: /放坡/
				},
				{
					value: "土钉墙支护",
					aliases: /土钉墙|土钉支护/
				},
				{
					value: "灌注桩支护",
					aliases: /灌注桩|钻孔灌注桩|排桩支护/
				},
				{
					value: "钢板桩支护",
					aliases: /钢板桩|拉森桩/
				},
				{
					value: "地下连续墙",
					aliases: /地下连续墙|地连墙/
				},
				{
					value: "锚杆（索）支护",
					aliases: /锚杆|锚索/
				},
				{
					value: "喷锚支护",
					aliases: /喷锚/
				}
			]
		},
		{
			id: "earthwork_haul",
			label: "土方外运方式",
			relevance: /土方|渣土|弃土/u,
			options: [
				{
					value: "自卸汽车外运",
					aliases: /自卸汽车|自卸车/
				},
				{
					value: "密闭渣土车外运",
					aliases: /密闭式?[^，。；;]{0,4}车|渣土车/
				},
				{
					value: "场内平衡利用",
					aliases: /场内平衡|就地平衡|场内调配|回填利用/
				}
			]
		},
		{
			id: "foundation_form",
			label: "基础形式",
			relevance: /基础/u,
			options: [
				{
					value: "独立基础",
					aliases: /独立基础/
				},
				{
					value: "条形基础",
					aliases: /条形基础|带形基础/
				},
				{
					value: "筏板基础",
					aliases: /筏板基础|筏形基础|满堂基础/
				},
				{
					value: "桩基础",
					aliases: /桩基础|桩基/u
				},
				{
					value: "箱形基础",
					aliases: /箱形基础|箱型基础/
				}
			]
		},
		{
			id: "vibration_isolation",
			label: "设备减振方式",
			relevance: /减振|隔振|减震|振动/u,
			options: [
				{
					value: "减振吊架",
					aliases: /减振吊架|隔振吊架|减震吊架|弹性吊架/
				},
				{
					value: "减振基础",
					aliases: /减振基础|隔振基础|减震基础|惯性基础/
				},
				{
					value: "橡胶隔振垫",
					aliases: /橡胶隔振垫|橡胶减振垫|隔振垫/
				},
				{
					value: "弹簧减振器",
					aliases: /弹簧减振器|弹簧隔振器|阻尼弹簧减振器/
				}
			]
		},
		{
			id: "concrete_pouring",
			label: "混凝土浇筑连续组织",
			relevance: /浇筑/u,
			options: [{
				value: "连续浇筑",
				aliases: /连续浇筑|一次浇筑|整体浇筑/,
				weakAliases: /同步浇筑|同步施工|同步/u
			}, {
				value: "分段浇筑",
				aliases: /分段浇筑|分仓浇筑|跳仓浇筑|分区浇筑/
			}]
		},
		{
			id: "pavement_structure",
			label: "路面结构类型",
			relevance: /路面|基层|面层|沥青|水泥稳定/u,
			options: [
				{
					value: "柔性路面",
					aliases: /沥青混凝土路面|沥青混凝土面层|沥青路面|沥青面层/,
					weakAliases: /柔性/u
				},
				{
					value: "半刚性路面",
					aliases: /半刚性/u
				},
				{
					value: "刚性路面",
					aliases: /刚性路面|水泥混凝土路面|水泥混凝土面层/
				}
			]
		}
	];
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
}));
//#endregion
//#region apps/server/src/services/document-workflow/integrity/detectors/detectors.ts
/**
* V5 P6 阶段短语提取（检测器家族共用）：数字前「X阶段」短语的阶段名归属——
* 修复声明回指句「…该阶段劳动力按蓝图推导统一为238人」中「该阶段」是回指不作阶段名，
* 需回溯实义阶段。限定在本值所在句的末逗号段内搜索（与 laborPeakStageOf 的 boundary/cut
* 同源，防跨句/跨列举段继承假阶段——N1-7「分阶段投入。高峰期20人」不得从「分阶段」
* 取到阶段名）；段内从右往左取第一个非指代候选：候选为词表词（LABOR_STAGE_LIMIT_WORDS）
* 缩写（「主体阶段」「装饰阶段」是「主体结构」「装饰装修」简称）不作限定（h14 契约）；
* 完整词表词返回本体（与 laborPeakStageOf 零漂移：P1 多链同行互查、N1-13 依赖两者
* 字符串相等）；自造阶段返回「X阶段」形态（N1-11/N1-12 契约）。
*/
function extractStagePhrase(markdown, lineStart, valueIndex) {
	const boundary = Math.max(markdown.lastIndexOf("。", valueIndex), markdown.lastIndexOf("；", valueIndex), markdown.lastIndexOf(";", valueIndex), markdown.lastIndexOf("\n", valueIndex));
	let segment = markdown.slice(Math.max(lineStart, boundary + 1), valueIndex);
	const cut = Math.max(segment.lastIndexOf("，"), segment.lastIndexOf(","), segment.lastIndexOf("、"));
	if (cut >= 0 && (/(?:高峰期|高峰|峰值)/u.test(segment.slice(0, cut)) || !TRADE_WORKER_WORD_RE.test(segment.slice(0, cut)))) segment = segment.slice(cut + 1);
	const candidates = [...segment.matchAll(/([^，,。；;、\n]{1,14})阶段/gu)].map((match) => match[1]);
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const name = candidates[index];
		if (!name || /^(?:该|本|此|上述|这|其|相应|各)$/u.test(name)) continue;
		const exact = LABOR_STAGE_LIMIT_WORDS.find((word) => word === name);
		if (exact) return exact;
		if (LABOR_STAGE_LIMIT_WORDS.some((word) => word.startsWith(name))) continue;
		return `${name}阶段`;
	}
}
/**
* 4.32.0 回指阶段实义解析（丰乐镇复测「216 vs 168」暴露误报）：「该/本阶段同时在场人数 N 人」是
* 阶段口径回指句，前文必有实义锚点（「道路铺装工程阶段处于…区间。该阶段同时在场人数为216人」→
* 道路铺装工程阶段；「第一阶段为施工准备与清杂拆除…。本阶段同时在场人数168人」→ 第一阶段）——
* 双回指句都取占位「（回指阶段）」时互判同阶段互斥（216 vs 168 假报）。本函数向值前 160 字窗口
* 从右往左找锚点：「第N阶段」序号形态优先（分阶段工期节的强制锚形态），其次非指代「X阶段」短语
* （沿用 extractStagePhrase 的过滤与词表口径，数量形态含「个」、定语形态以「的」结尾的候选除外）；
* 解析失败返回 undefined，调用方退回占位（保守隔离不误报）。
*/
function resolveRefStage(markdown, valueIndex) {
	const windowText = markdown.slice(Math.max(0, valueIndex - 160), valueIndex);
	const numbered = [...windowText.matchAll(/第[一二三四五六七八九十百\d]{1,4}阶段/gu)].pop();
	if (numbered) return numbered[0];
	const candidates = [...windowText.matchAll(/([^，,。；;、\n]{1,14})阶段/gu)];
	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const name = candidates[index][1];
		if (!name || /^(?:该|本|此|上述|这|其|相应|各)$/u.test(name)) continue;
		if (/个/u.test(name) || /的$/u.test(name)) continue;
		const exact = LABOR_STAGE_LIMIT_WORDS.find((word) => word === name);
		if (exact) return exact;
		if (LABOR_STAGE_LIMIT_WORDS.some((word) => word.startsWith(name))) continue;
		return `${name}阶段`;
	}
}
function laborGroupOf(markdown, valueIndex, lineStart) {
	const windowStart = Math.max(lineStart, valueIndex - 30);
	const before = markdown.slice(windowStart, valueIndex);
	const cut = Math.max(before.lastIndexOf("，"), before.lastIndexOf("、"), before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf("；"), before.lastIndexOf("："), before.lastIndexOf(":"), before.lastIndexOf("。"));
	const effectiveStart = cut >= 0 ? windowStart + cut + 1 : windowStart;
	const subjectWindow = markdown.slice(effectiveStart, valueIndex);
	if (MANAGEMENT_PERSONNEL_WORD_RE.test(subjectWindow)) return { group: "management" };
	const tradeMatch = subjectWindow.match(TRADE_WORKER_WORD_RE);
	if (tradeMatch?.[0]) return {
		group: "trade",
		trade: tradeMatch[0]
	};
	return { group: "peak" };
}
/**
* P1 箭头链峰值提取（评分报告 P1「劳动力按32人→86人→48人分阶段投入」漏检根因）：
*  LABOR_COUNT_RE 只抓链上首值 32，真实峰值 86 不可见 → 与正文「20人」矛盾漏检；
*  链内多值属分阶段合法序列（32/48 是低峰阶段），只取链上最大值入峰值池，
*  链内其他值不得当独立口径互查（否则 32 vs 86 会误报互斥）。
*  链起点＝箭头连接符前的最后一个劳动力语境词——「管理人员18人，劳动力按32人→86人→48人」
*  的 18 在链起点之前（管理口径正常入池），「劳动力按32人→86人」的链起点是劳动力（取全链峰值）。
*  链尾＝链所在句的句边界（。；;）且不跨逗号段——同段下一句/下一段链的独立宣称（「…约40人」
*  「装饰装修阶段20人→50人→30人」）不得被前一链吞掉（P1 测试回归根因 + 多链同行扩围修复）。
*  语境词含「阶段」：支撑「装饰装修阶段20人→50人→30人」形态的链起点定位。 */
function chainPeaksOf(line) {
	const results = [];
	for (const arrow of line.matchAll(/(?:→|—|–|~|～)/gu)) {
		const arrowIdx = arrow.index ?? 0;
		const prefix = line.slice(0, arrowIdx);
		const contextMatch = /(?:劳动力|作业人员|施工人员|高峰期|高峰|峰值|阶段)[^，。；;]*$/u.exec(prefix);
		if (!contextMatch) continue;
		const start = contextMatch.index;
		if (results.some((chain) => chain.start === start)) continue;
		const sentenceCut = /[。；;]/u.exec(line.slice(arrowIdx));
		const matches = [...(line.slice(start, sentenceCut ? arrowIdx + sentenceCut.index : void 0).split(/[，,]/u)[0] || "").matchAll(/([\d,]+)\s*人/g)];
		const values = matches.map((match) => Number(match[1].replace(/[,，]/gu, ""))).filter((value) => Number.isFinite(value) && value > 0);
		if (values.length < 2) continue;
		const last = matches[matches.length - 1];
		results.push({
			peak: Math.max(...values),
			start,
			end: start + (last.index ?? 0) + last[0].length
		});
	}
	return results;
}
/** 劳动力峰值数字位置 → 阶段限定词（与检测器 resourceConsistencyIssues 模式 1 同源同口径） */
function resourceConsistencyIssues(markdown, options) {
	const issues = [];
	const laborPeakAuthority = options?.laborPeakAuthority;
	const bodyPeaks = [];
	const chainHandledKeys = /* @__PURE__ */ new Set();
	for (const pattern of [
		PEAK_LABOR_RE,
		LABOR_COUNT_RE,
		STAGE_LABOR_RE
	]) for (const match of markdown.matchAll(pattern)) {
		const lineStart = markdown.lastIndexOf("\n", match.index) + 1;
		let lineEnd = markdown.indexOf("\n", match.index);
		if (lineEnd === -1) lineEnd = markdown.length;
		const line = markdown.slice(lineStart, lineEnd);
		if (/^\s*\|.*\|\s*$/u.test(line)) continue;
		const value = Number(match[1].replace(/[,，]/gu, ""));
		const valueIndex = match.index + match[0].indexOf(match[1]);
		if (/按蓝图[^。；;\n]{0,16}?(?:统一|调整|修正|核定)\s*(?:为|至)\s*$/u.test(markdown.slice(Math.max(0, valueIndex - 40), valueIndex))) continue;
		const hitChain = chainPeaksOf(line).find((chain) => valueIndex - lineStart >= chain.start && valueIndex - lineStart < chain.end);
		if (hitChain !== void 0) {
			const chainKey = `${lineStart}:${hitChain.start}:${hitChain.end}`;
			if (!chainHandledKeys.has(chainKey)) {
				chainHandledKeys.add(chainKey);
				bodyPeaks.push({
					value: hitChain.peak,
					text: line.trim().slice(0, 40),
					stage: laborPeakStageOf(markdown, valueIndex),
					group: "peak"
				});
			}
			continue;
		}
		if (Number.isFinite(value) && value > 0) {
			const { group, trade } = laborGroupOf(markdown, valueIndex, lineStart);
			const stagePhrase = extractStagePhrase(markdown, lineStart, valueIndex);
			const refStage = stagePhrase === void 0 && (/(?:该|本|此|这|其|上述)$/u.test(markdown.slice(Math.max(0, match.index - 2), match.index)) || /(?:该|本|此|这|其|上述)(?:阶段|期间)[^。；;\n]{0,12}?$/u.test(markdown.slice(match.index, valueIndex)));
			const stage = pattern === STAGE_LABOR_RE ? stagePhrase === void 0 ? refStage ? resolveRefStage(markdown, valueIndex) ?? "（回指阶段）" : "" : stagePhrase.endsWith("阶段") ? stagePhrase : `${stagePhrase}阶段` : stagePhrase ?? laborPeakStageOf(markdown, valueIndex) ?? "";
			bodyPeaks.push({
				value,
				text: match[0].trim().slice(0, 40),
				stage,
				group,
				trade
			});
		}
	}
	const tableBlocks = collectLaborTableBlocks(markdown);
	const laborIssue = (message, suggestion) => issues.push({
		level: "error",
		severity: "blocker",
		category: "fact_consistency",
		owner: "llm",
		repairability: "llm_repairable",
		message,
		suggestion
	});
	for (let i = 0; i < bodyPeaks.length; i += 1) for (let j = i + 1; j < bodyPeaks.length; j += 1) {
		const [a, b] = [bodyPeaks[i], bodyPeaks[j]];
		if (a.group !== b.group) continue;
		if (a.group === "trade" && a.trade !== b.trade) continue;
		if (a.stage && b.stage && a.stage !== b.stage) continue;
		if (!a.stage !== !b.stage) {
			const [total, staged] = a.stage ? [b, a] : [a, b];
			if (total.value >= staged.value) continue;
		}
		const diff = Math.abs(a.value - b.value) / Math.max(a.value, b.value);
		if (a.value !== b.value) {
			laborIssue(`劳动力数据矛盾：正文“${a.text}”（${a.value} 人）与“${b.text}”（${b.value} 人）互斥（相差 ${Math.round(diff * 100)}%）`, laborPeakAuthority !== void 0 && laborPeakAuthority > 0 ? `劳动力峰值数据必须全文唯一：以蓝图劳动力峰值 ${laborPeakAuthority} 人为准统一正文各处峰值表述，删除矛盾数字。` : "劳动力峰值数据必须全文唯一：以分阶段投入明细表为准统一正文各处峰值表述，删除矛盾数字。");
			i = bodyPeaks.length;
			break;
		}
	}
	const peakColTablePeaks = tableBlocks.filter((block) => block.hasPeakCol).map((block) => block.peak);
	if (peakColTablePeaks.length >= 2) {
		const max = Math.max(...peakColTablePeaks);
		const min = Math.min(...peakColTablePeaks);
		const diff = Math.abs(max - min) / max;
		if (max !== min) laborIssue(`劳动力数据矛盾：分阶段投入明细表峰值 ${min} 人与另一劳动力表峰值 ${max} 人互斥（相差 ${Math.round(diff * 100)}%）`, "劳动力峰值数据必须全文唯一：统一各劳动力表格的峰值数据，删除矛盾表格数字。");
	}
	const peakGroupPeaks = bodyPeaks.filter((entry) => entry.group === "peak");
	const maxBodyPeak = peakGroupPeaks.reduce((maxPeak, entry) => Math.max(maxPeak, entry.value), 0);
	const tablePeak = tableBlocks.filter((block) => !block.hasTradeCol).length > 0 ? Math.max(...tableBlocks.filter((block) => !block.hasTradeCol).map((block) => block.peak)) : void 0;
	if (tablePeak !== void 0 && maxBodyPeak > 0) {
		if (maxBodyPeak > tablePeak && !(laborPeakAuthority !== void 0 && laborPeakAuthority > 0 && maxBodyPeak === laborPeakAuthority)) laborIssue(`劳动力数据矛盾：正文表述“${peakGroupPeaks.find((entry) => entry.value === maxBodyPeak)?.text || ""}”达 ${maxBodyPeak} 人，而分阶段投入明细表最大峰值为 ${tablePeak} 人（超出 ${Math.round((maxBodyPeak - tablePeak) / tablePeak * 100)}%）`, "劳动力投入数据必须全文统一：以分阶段明细表为准复核正文峰值表述，删除与表格矛盾的“高峰期 X 人”措辞或调整表格数据。");
	}
	const controlCaps = [];
	for (const match of markdown.matchAll(/(?:高峰期|高峰|峰值)[^。；;\n]{0,16}?控制(?:在|为|到)?(?:约)?\s*([\d,]+)\s*人(?:以内|以下|之内)?/gu)) {
		const value = Number(match[1].replace(/[,，]/gu, ""));
		if (Number.isFinite(value) && value > 0) controlCaps.push(value);
	}
	if (controlCaps.length > 0) {
		const cap = Math.max(...controlCaps);
		const exceedingPeaks = [...bodyPeaks, ...tablePeak !== void 0 ? [{ value: tablePeak }] : []].filter((entry) => entry.value > cap);
		if (exceedingPeaks.length > 0) {
			const exceed = Math.max(...exceedingPeaks.map((entry) => entry.value));
			laborIssue(`劳动力数据矛盾：正文“高峰期总人数控制在${cap}人”的上限表述与峰值表述 ${exceed} 人不自洽（阶段高峰投入超出控制上限 ${Math.round((exceed - cap) / cap * 100)}%）`, "总量控制上限与各阶段峰值必须自洽：阶段高峰人数不得超过全文宣称的高峰控制人数；以分阶段投入明细表为准修正控制目标或各阶段峰值表述。");
		}
	}
	for (const line of markdown.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed || /^\s*\|/u.test(trimmed) || /^#{1,6}\s/u.test(trimmed)) continue;
		for (const sentence of trimmed.split(/(?<=[。；;])/u)) {
			const resultMatch = /=\s*([\d,]+)\s*人/u.exec(sentence);
			if (!resultMatch) continue;
			const left = sentence.slice(0, resultMatch.index);
			if (!/[＋+]/u.test(left)) continue;
			const segments = left.split(/[＋+]/u);
			let sum = 0;
			let hasTerm = false;
			for (const segment of segments) {
				const termMatch = segment.match(/(\d+)\s*[×xX]\s*(\d+)/u) || segment.match(/(\d+)\s*人?\s*$/u);
				if (!termMatch) continue;
				hasTerm = true;
				sum += termMatch[2] !== void 0 ? Number(termMatch[1]) * Number(termMatch[2]) : Number(termMatch[1]);
			}
			if (!hasTerm) continue;
			const total = Number(resultMatch[1].replace(/[,，]/gu, ""));
			if (!Number.isFinite(total) || total <= 0 || sum <= 0) continue;
			const snapshot = sentence.trim().slice(0, 60);
			if (sum !== total) laborIssue(`劳动力数据矛盾：正文班组加总算式“${snapshot}”左侧求和 ${sum} 人 ≠ 结果 ${total} 人`, "班组人数加总必须与合计一致：核对各班组人数或修正合计数字。");
			const claimMatch = /(?:投入|配置|安排|组织|总人数)[^。；;＝=＋+]{0,16}?([\d,]+)\s*人/u.exec(sentence);
			if (claimMatch) {
				const claimValue = Number(claimMatch[1].replace(/[,，]/gu, ""));
				const claimWindow = sentence.slice(0, claimMatch.index + claimMatch[0].length);
				const isApprox = /[约近余]|左右/u.test(claimWindow.slice(-16));
				if (Number.isFinite(claimValue) && claimValue > 0 && !isApprox && claimValue !== total) laborIssue(`劳动力数据矛盾：正文宣称总人数 ${claimValue} 人与班组加总算式结果 ${total} 人自相矛盾（相差 ${Math.round(Math.abs(claimValue - total) / Math.max(claimValue, total) * 100)}%）`, "宣称总人数必须与班组加总一致：统一总人数与各班组人数，删除矛盾数字。");
			}
		}
	}
	for (const block of tableBlocks) {
		if (block.totalCell === void 0 || block.countCells.length < 2) continue;
		const diff = Math.abs(block.totalCell - block.detailSum) / Math.max(block.totalCell, block.detailSum);
		if (block.totalCell !== block.detailSum) laborIssue(`劳动力数据矛盾：劳动力表合计行 ${block.totalCell} 人与明细行之和 ${block.detailSum} 人不符（差 ${Math.round(diff * 100)}%）`, "劳动力表合计必须等于各明细行人数之和：统一合计行与明细行数据，删除矛盾数字。");
	}
	const totalWorkdays = [...markdown.matchAll(/(?:总|合计|总计|共)[^。；;\n|]{0,8}?([\d,]+)\s*(?:个)?工日/gu)].map((match) => Number(match[1].replace(/[,，]/gu, ""))).filter((value) => Number.isFinite(value) && value > 0);
	const totalDays = [...markdown.matchAll(/(?:工期|总工期|计划工期)[^。；;\n]{0,16}?(\d{2,4})\s*(?:个)?(?:日历)?天/gu)].map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value >= 30 && value <= 3e3);
	if (totalWorkdays.length > 0 && maxBodyPeak > 0 && totalDays.length > 0) {
		const maxWorkdays = Math.max(...totalWorkdays);
		const maxDays = Math.max(...totalDays);
		const arithmeticCeiling = maxBodyPeak * maxDays;
		if (maxWorkdays > arithmeticCeiling) laborIssue(`劳动力数据矛盾：总工日 ${maxWorkdays} 个超过峰值 ${maxBodyPeak} 人×总工期 ${maxDays} 天的算术上限 ${arithmeticCeiling} 个，不可能成立`, "总工日不得超过劳动力峰值×总工期的算术上限：按各阶段人数×阶段工期重算总工日，或修正峰值人数/总工期表述。");
	}
	return issues.slice(0, 5);
}
function stripUnderminingContexts(sentence) {
	const stripped = sentence.replace(REMEDIATION_CONDITION_CLAUSE_RE, "").replace(NEGATED_DEFICIENCY_RE, "").replace(PROHIBITED_EXCUSE_CLAUSE_RE, "");
	const marker = stripped.match(HYPOTHETICAL_MARKER_RE);
	return marker && marker.index !== void 0 ? stripped.slice(0, marker.index) : stripped;
}
async function selfUnderminingCandidateIssues(markdown) {
	const issues = [];
	const sentences = markdown.split(/\n+/u).filter((line) => line.trim() && !/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(line)).flatMap((line) => line.split(/[。；;]/u)).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 12);
	if (sentences.length === 0) return issues;
	const UNDERMINING_NEGATIVE_RE = /尚未|未完成|未明确|未采用|未落实|未确定|未闭合|存在缺口|有待|待补充|待完善|跟踪完善|不够|不明确|缺失|缺少|缺乏|风险较大|难以保证|无法保证|正在办理|暂未|未能|需进一步|不进行分包|不再分包|不转包/u;
	const underminingSimilarity = await buildSemanticSimilarity(sentences, [...SELF_UNDERMINING_QUERIES]);
	const hits = [...new Set(sentences.filter((sentence) => UNDERMINING_NEGATIVE_RE.test(stripUnderminingContexts(sentence)) && !POSITIVE_SELF_REFERENCE_RE.test(sentence) && !SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test(sentence) && SELF_UNDERMINING_QUERIES.some((query) => underminingSimilarity(sentence, query) >= .6)))];
	if (hits.length === 0) return issues;
	for (const hit of hits) issues.push({
		level: "error",
		severity: "blocker",
		category: "style",
		owner: "llm",
		repairability: "llm_repairable",
		message: `自伤表述候选：“${hit}”暴露投标短板，需按上下文判定后改写`,
		suggestion: "投标文件不得主动暴露“专项设计未完成/指标存在缺口”等短板：改写为正向落实表述（如“按施工图绿色建筑专篇编制专项方案，逐项落实评分项并跟踪验收”）；如属现场条件合理风险描述（地质/管线尚不明确），保留但需配套勘查与应对措施。"
	});
	return issues.slice(0, 3);
}
/** 装饰层厚度确定性修复（检测定位=修复定位）：≥100mm 的装饰语境厚度除以 10（200→20、100→10） */
function laborPeakConflictIssues(markdown) {
	const issues = [];
	const totalValues = [...markdown.matchAll(/高峰期总人数(\d+)人|劳动力总人数(\d+)人|总人数(\d+)人/gu)].map((match) => Number(match[1] || match[2] || match[3])).filter((value) => value > 0);
	const peakValues = [...markdown.matchAll(/高峰(?:期)?人数(\d+)人|峰值(?:需求|人数)?[为约]?(\d+)人/gu)].map((match) => Number(match[1] || match[2])).filter((value) => value > 0);
	const totalSet = [...new Set(totalValues)];
	const peakSet = [...new Set(peakValues)];
	if (totalSet.filter((total) => peakSet.some((peak) => peak !== total)).length > 0) issues.push({
		level: "error",
		severity: "blocker",
		category: "fact_consistency",
		owner: "llm",
		repairability: "llm_repairable",
		message: `劳动力峰值口径矛盾：正文「总人数」出现 ${totalSet.join("人、")}人 与「高峰人数」出现 ${peakSet.join("人、")}人 并存，峰值人数必须唯一`,
		suggestion: "全文劳动力峰值只允许一个口径：统一总人数与高峰人数为同一数值，删除矛盾口径；分阶段梯次投入人数（准备阶段/主体阶段/竣工阶段）属合法动态配置，不在统一范围内。"
	});
	const tradePeaksByTable = /* @__PURE__ */ new Map();
	for (const block of collectLaborTableBlocks(markdown)) {
		if (!block.hasTradeCol || block.tradeCells.length === 0) continue;
		const perTable = /* @__PURE__ */ new Map();
		for (const cell of block.tradeCells) {
			const current = perTable.get(cell.trade) ?? 0;
			if (cell.value > current) perTable.set(cell.trade, cell.value);
		}
		for (const [trade, value] of perTable) {
			const list = tradePeaksByTable.get(trade) ?? [];
			list.push(value);
			tradePeaksByTable.set(trade, list);
		}
	}
	const tradeConflicts = [...tradePeaksByTable.entries()].filter(([, values]) => values.length >= 2 && new Set(values).size >= 2);
	if (tradeConflicts.length > 0) issues.push({
		level: "error",
		severity: "blocker",
		category: "fact_consistency",
		owner: "llm",
		repairability: "llm_repairable",
		message: `同工种跨表高峰人数矛盾：${tradeConflicts.map(([trade, values]) => `${trade} ${values.join("人、")}人`).join("；")} 各表并存，同一工种高峰人数必须唯一`,
		suggestion: "同一工种在各表中的高峰人数必须一致：以工种配置表（第五章）为权威口径统一各表数值；分阶段投入计划表内同工种不同阶段的动态配置属合法数据，不参与统一。"
	});
	return issues;
}
/** 提取正文「用水/生活用水语境 + 高峰人数 X 人」形态的值（蓝图值化句同形态，与劳动力峰值互查） */
function waterPeakLaborValues(markdown) {
	const values = [];
	for (const match of markdown.matchAll(/(?:生活用水|施工用水|临时用水|用水)[^。；;\n]{0,24}(?:高峰(?:期)?人数|高峰人数)[^。；;\n]{0,8}?([\d,]+)\s*人/gu)) {
		const value = Number(match[1].replace(/[,，]/gu, ""));
		if (Number.isFinite(value) && value > 0) values.push(value);
	}
	return values;
}
/** 用水高峰人数 vs 劳动力峰值关联检测：用水语境高峰人数与劳动力峰值不一致 → error */
function waterLaborPeakAssociationIssues(markdown) {
	const waterPeaks = waterPeakLaborValues(markdown);
	if (waterPeaks.length === 0) return [];
	const laborPeaks = [];
	for (const match of markdown.matchAll(/高峰(?:期)?人数([\d,]+)人|峰值(?:需求|人数)?[为约]?([\d,]+)人|劳动力峰值[^。；;\n]{0,8}?([\d,]+)\s*人/gu)) {
		const raw = (match[1] || match[2] || match[3] || "").replace(/[,，]/gu, "");
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0) continue;
		const valueIndex = (match.index ?? 0) + match[0].indexOf(match[1] || match[2] || match[3] || "");
		const prefix = markdown.slice(Math.max(0, valueIndex - 24), valueIndex);
		if (/生活用水|施工用水|临时用水|用水/u.test(prefix)) continue;
		if (laborPeakStageOf(markdown, valueIndex)) continue;
		laborPeaks.push(value);
	}
	const laborSet = [...new Set(laborPeaks)];
	if (laborSet.length === 0) return [];
	const waterSet = [...new Set(waterPeaks)];
	if (waterSet.filter((water) => laborSet.every((labor) => labor !== water)).length === 0) return [];
	return [{
		level: "error",
		severity: "blocker",
		category: "fact_consistency",
		owner: "llm",
		repairability: "llm_repairable",
		message: `用水高峰人数与劳动力峰值不一致：临时用水按高峰人数 ${waterSet.join("人、")}人 计算，而劳动力峰值为 ${laborSet.join("人、")}人，两处引用必须为同一数值`,
		suggestion: "临时用水高峰人数与劳动力峰值为同一批施工人员的两个引用口径：统一改为劳动力峰值人数，删除自编的用水人数口径。"
	}];
}
/** 提取节点日期样本：三种形态（正序完成式/倒序锁定式/表格式完成列）全部收口为 {key, day, raw} */
function extractNodeScheduleDays(markdown) {
	const samples = [];
	const keyOf = (text) => {
		const normalized = text === "封顶" ? "主体结构封顶" : text;
		return SCHEDULE_NODE_ANCHORS.find((anchor) => anchor.re.test(normalized))?.key;
	};
	const pushIfNode = (nodeText, day, raw) => {
		const key = keyOf(nodeText);
		if (key !== void 0 && Number.isFinite(day) && day >= 1 && day <= 3e3) samples.push({
			key,
			day,
			raw
		});
	};
	for (const match of markdown.matchAll(/第(\d{2,3})日[^。；;\n]{0,14}?完成[^。；;\n，、]{0,12}?(基坑支护及土方外运|装饰装修及幕墙|机电安装及智能化调试|室外工程及竣工验收|地下结构出正负零|主体结构封顶|正负零|封顶)/gu)) pushIfNode(match[2], Number(match[1]), match[0].slice(0, 40));
	for (const match of markdown.matchAll(/(基坑支护|正负零|封顶|装饰装修|机电安装|竣工验收)(?:(?!(?:第\d{2,3}[日天]|，|、)).){0,8}?完成[^。；;\n]{0,10}?第(\d{2,3})[日天]/gu)) pushIfNode(match[1], Number(match[2]), match[0].slice(0, 40));
	for (const match of markdown.matchAll(/(主体(?:结构)?封顶)(?!后)(?:(?!(?:第\d{2,3}[日天]|，|、|完成|\||[。；;\n])).){0,20}?第(\d{2,3})日/gu)) pushIfNode(match[1], Number(match[2]), match[0].slice(0, 40));
	for (const anchor of SCHEDULE_NODE_ANCHORS) {
		const rowRe = new RegExp(`^\\s*\\|\\s*[^|]*${anchor.re.source}[^|]*\\s*\\|\\s*开工(?:令下发)?后第(\\d{2,3})日\\s*\\|`, "gum");
		for (const match of markdown.matchAll(rowRe)) pushIfNode(match[0], Number(match[1]), match[0].slice(0, 40));
	}
	const seen = /* @__PURE__ */ new Set();
	return samples.filter((sample) => {
		const dedupeKey = `${sample.key}:${sample.raw}`;
		if (seen.has(dedupeKey)) return false;
		seen.add(dedupeKey);
		return true;
	});
}
function nodeScheduleConsistencyIssues(markdown) {
	const issues = [];
	const byNode = /* @__PURE__ */ new Map();
	for (const sample of extractNodeScheduleDays(markdown)) {
		const group = byNode.get(sample.key) || [];
		group.push(sample);
		byNode.set(sample.key, group);
	}
	for (const anchor of SCHEDULE_NODE_ANCHORS) {
		const group = byNode.get(anchor.key);
		if (!group || group.length < 2) continue;
		const days = [...new Set(group.map((sample) => sample.day))];
		if (days.length < 2) continue;
		const raws = [...new Set(group.map((sample) => sample.raw))].slice(0, 4).join("、");
		issues.push({
			level: "error",
			severity: "blocker",
			category: "fact_consistency",
			owner: "llm",
			repairability: "llm_repairable",
			message: `节点工期口径矛盾：“${anchor.label}”节点出现 ${days.map((day) => `${day}日`).join(" 与 ")} 两套口径：${raws}`,
			suggestion: `关键节点完成时间必须全文唯一：以总进度计划表为准统一“${anchor.label}”节点日期，删除正文/其他表中矛盾的“第N日”表述。`
		});
	}
	return issues.slice(0, 4);
}
/** 部位词前紧邻实体限定词时组合为限定词+部位词（限定词与部位词不同源不重叠） */
function qualifyLocationHit(locationHit, sourceText, hitIndex) {
	const before = sourceText.slice(Math.max(0, hitIndex - 8), hitIndex);
	const qualifierMatch = before.match(LOCATION_ENTITY_QUALIFIER_RE);
	if (!qualifierMatch || qualifierMatch.index === void 0) return locationHit;
	const gap = before.slice((qualifierMatch.index ?? 0) + qualifierMatch[0].length);
	if (/^[的施工区域现场]{0,3}$/u.test(gap)) return `${qualifierMatch[0]}${locationHit}`;
	return locationHit;
}
/** 从匹配窗口提取部位组：窗口从最近分隔符（，、，;；。|）后截断（防跨句串染：
*  「外墙…A5.0。内墙…A3.5」的内墙匹配窗口不得吞入前句「外墙」），并先剥离「XX阶段」
*  阶段限定语境（「主体结构阶段配置施工电梯2台」的阶段词不是部位，不参与部位分组）；
*  无部位词则归入默认组（''） */
function locationGroupForMatch(markdown, matchIndex, raw, lineStart) {
	const lineEndIndex = markdown.indexOf("\n", matchIndex);
	const lineText = markdown.slice(lineStart, lineEndIndex === -1 ? markdown.length : lineEndIndex);
	if (/^\s*\|/u.test(lineText) && /\|\s*$/u.test(lineText.trim())) {
		const lineStageStripped = lineText.replace(/[\u4e00-\u9fa5]{2,6}阶段/gu, "");
		const lineHits = [...lineStageStripped.matchAll(new RegExp(LOCATION_WORD_SOURCE, "gu"))];
		const lastHit = lineHits[lineHits.length - 1];
		return lastHit ? qualifyLocationHit(lastHit[0], lineStageStripped, lastHit.index ?? 0) : "";
	}
	const windowStart = Math.max(lineStart, matchIndex - 16);
	const before = markdown.slice(windowStart, matchIndex);
	const cut = Math.max(before.lastIndexOf("，"), before.lastIndexOf("、"), before.lastIndexOf(","), before.lastIndexOf(";"), before.lastIndexOf("；"), before.lastIndexOf("。"));
	const effectiveStart = cut >= 0 ? windowStart + cut + 1 : windowStart;
	const stageStripped = markdown.slice(effectiveStart, matchIndex + raw.length).replace(/[\u4e00-\u9fa5]{2,6}阶段/gu, "");
	const perUnit = [...stageStripped.matchAll(PER_UNIT_LOCATION_RE)];
	if (perUnit.length > 0) return perUnit[perUnit.length - 1]?.[0] ?? "";
	const hits = [...stageStripped.matchAll(new RegExp(LOCATION_WORD_SOURCE, "gu"))];
	const lastHit = hits[hits.length - 1];
	return lastHit ? qualifyLocationHit(lastHit[0], stageStripped, lastHit.index ?? 0) : "";
}
function isUnitPairRatioMatch(markdown, matchIndex, raw) {
	const segStart = Math.max(markdown.lastIndexOf("，", matchIndex), markdown.lastIndexOf(",", matchIndex), markdown.lastIndexOf("。", matchIndex), markdown.lastIndexOf("；", matchIndex), markdown.lastIndexOf(";", matchIndex), markdown.lastIndexOf("\n", matchIndex), markdown.lastIndexOf("|", matchIndex)) + 1;
	const unitPairWindow = markdown.slice(segStart, matchIndex + raw.length);
	return /每[^，,。；;\n|]{0,16}(?:对应|配备|配置|配套|编组|配)[^，,。；;\n|]{0,10}\d+\s*[台辆][^，,。；;\n|]{0,6}$/u.test(unitPairWindow);
}
/** 表格行匹配是否处于资源共用表块语境（r25 B2 归因·零专名）：仅表格行生效；从匹配行向上、
* 向下逐行探取（跳过表格行、空行与题注行），任一方向首个普通行命中共享词即成立；撞标题行或
* 扫描预算（1200 字符）耗尽即止（保守不豁免）。非表格行返回 false——正文部位分组口径不受影响。 */
function tableBlockHasSharingContext(markdown, matchIndex, lineStart) {
	const lineEndIndex = markdown.indexOf("\n", matchIndex);
	const lineEnd = lineEndIndex === -1 ? markdown.length : lineEndIndex;
	const lineText = markdown.slice(lineStart, lineEnd);
	if (!/^\s*\|/u.test(lineText) || !/\|\s*$/u.test(lineText.trim())) return false;
	const probe = (lines) => {
		for (const line of lines) {
			if (/^\s*\|/u.test(line) || !line.trim()) continue;
			if (/^\s*\*{0,2}表\s*[\d一二三四五六七八九十]+\s*[-–—][\d.]+/u.test(line)) continue;
			if (/^#{1,6}\s/u.test(line)) return false;
			return RESOURCE_SHARING_CONTEXT_RE.test(line);
		}
		return false;
	};
	const upwardStart = Math.max(0, lineStart - 1200);
	const upward = markdown.slice(upwardStart, lineStart).split("\n");
	upward.pop();
	if (probe(upward.reverse())) return true;
	return probe(markdown.slice(lineEnd + 1, lineEnd + 1 + 1200).split("\n"));
}
function crossSectionNumericConflictIssues(markdown) {
	const issues = [];
	for (const anchor of CROSS_SECTION_ANCHORS) {
		const valuesByGroup = /* @__PURE__ */ new Map();
		const rawsByGroup = /* @__PURE__ */ new Map();
		const pumpWordSeparation = anchor.key === "pump" && /潜水泵/u.test(markdown) && /提升泵/u.test(markdown);
		for (const pattern of anchor.patterns) for (const match of markdown.matchAll(pattern)) {
			const raw = match[0].slice(0, 40);
			if (match[1] !== void 0) {
				const entityRe = CROSS_SECTION_ANCHOR_ENTITY_RE[anchor.key];
				const entityMatch = entityRe ? entityRe.exec(raw) : null;
				const digitIdx = raw.indexOf(match[1]);
				if (entityMatch && digitIdx >= 0 && entityMatch.index > digitIdx) {
					const between = raw.slice(digitIdx + String(match[1]).length, entityMatch.index);
					if (/^\s*(?:台|辆|套|个|座|m|mm|天)?\s*[与和及、，,]{1,2}\s*$/u.test(between)) continue;
				}
			}
			if (/(?:循环使用|轮换使用|交替使用|分组使用)/u.test(markdown.slice(match.index || 0, (match.index || 0) + raw.length + 30)) && /(?:作业面|区段|分段|片区|分区|工区)/u.test(markdown.slice(Math.max(0, (match.index || 0) - 20), match.index || 0))) continue;
			if (anchor.key === "trenchClearing") {
				const segStart = Math.max(markdown.lastIndexOf("。", match.index), markdown.lastIndexOf("；", match.index), markdown.lastIndexOf("\n", match.index)) + 1;
				if (/基槽|围栏|菜园/u.test(markdown.slice(segStart, (match.index || 0) + raw.length))) continue;
			}
			if (ENUMERATION_VALUE_RE.test(raw)) continue;
			{
				const digitOffset = match[1] !== void 0 ? raw.indexOf(String(match[1])) : -1;
				if (digitOffset >= 0) {
					const digitAbs = (match.index || 0) + digitOffset;
					if (/半径|倒角|圆弧|弧度/u.test(markdown.slice(Math.max(0, digitAbs - 6), digitAbs))) continue;
				}
			}
			if (PROCESS_SWITCH_WORD_RE.test(raw)) continue;
			if (anchor.key === "scheduleDays") {
				const digitAt = raw.indexOf(String(match[1]));
				if (digitAt >= 0 && /(?:阶段|第\d+日|至第|共|集中)/u.test(markdown.slice(Math.max(0, (match.index || 0) + digitAt - 16), (match.index || 0) + digitAt))) continue;
				const segStart = Math.max(markdown.lastIndexOf("。", match.index), markdown.lastIndexOf("；", match.index), markdown.lastIndexOf("\n", match.index)) + 1;
				const segEnd = markdown.indexOf("。", (match.index || 0) + raw.length);
				const segText = markdown.slice(segStart, segEnd === -1 ? markdown.length : segEnd);
				if (/合理期限|书面技术要求|审核认可|响应闭环|答复期限|反馈期限|技术澄清/u.test(segText)) continue;
			}
			if (/按不少于|不少于/u.test(raw)) continue;
			if (/[中内](?:调配|取用|挪用|借用|调用|划拨)|(?:从|由)[^。；;\n]{0,20}?[中内](?:调配|取用|挪用|借用|调用|划拨)/u.test(raw)) continue;
			if (/增配|增补|追加|补足|另配|增设/u.test(raw)) continue;
			if (anchor.key === "villageCount") {
				const orgTail = markdown.slice((match.index || 0) + raw.length, (match.index || 0) + raw.length + 12);
				if (/分组|施工组|网格|责任区|单元|片区|班组|包保|作业面|施工点|施工段/u.test(orgTail)) continue;
			}
			if (isUnitPairRatioMatch(markdown, match.index || 0, raw)) continue;
			const lineStart = markdown.lastIndexOf("\n", match.index) + 1;
			let lineEnd = markdown.indexOf("\n", match.index);
			if (lineEnd === -1) lineEnd = markdown.length;
			if (NEGATIVE_DECLARATION_RE.test(markdown.slice(lineStart, lineEnd))) continue;
			if (tableBlockHasSharingContext(markdown, match.index || 0, lineStart)) continue;
			const group = locationGroupForMatch(markdown, match.index || 0, raw, lineStart);
			const groupKey = pumpWordSeparation && group ? `${raw.match(/潜水泵|提升泵/u)?.[0] ?? ""}｜${group}` : group;
			const values = valuesByGroup.get(groupKey) || /* @__PURE__ */ new Set();
			values.add(match[1]);
			valuesByGroup.set(groupKey, values);
			const raws = rawsByGroup.get(groupKey) || [];
			raws.push(raw);
			rawsByGroup.set(groupKey, raws);
		}
		const unlabeledKeys = [...valuesByGroup.keys()].filter((key) => key === "" || key.endsWith("｜"));
		for (const unlabeledKey of unlabeledKeys) {
			const unlabeled = valuesByGroup.get(unlabeledKey);
			if (!unlabeled || unlabeled.size === 0) continue;
			const labeledCandidates = [...valuesByGroup.keys()].filter((key) => key !== unlabeledKey && key.startsWith(unlabeledKey) && !key.slice(unlabeledKey.length).includes("｜"));
			if (labeledCandidates.length !== 1) continue;
			const targetKey = labeledCandidates[0] || "";
			const target = valuesByGroup.get(targetKey);
			if (!target) continue;
			for (const value of unlabeled) target.add(value);
			const targetRaws = rawsByGroup.get(targetKey) || [];
			targetRaws.push(...rawsByGroup.get(unlabeledKey) || []);
			rawsByGroup.set(targetKey, targetRaws);
			valuesByGroup.delete(unlabeledKey);
			rawsByGroup.delete(unlabeledKey);
		}
		for (const [groupKey, values] of valuesByGroup) {
			if (values.size < 2) continue;
			const group = groupKey.includes("｜") ? groupKey.slice(groupKey.indexOf("｜") + 1) : groupKey;
			const raws = rawsByGroup.get(groupKey) || [];
			if (anchor.kind === "code") issues.push({
				level: "error",
				severity: "blocker",
				category: "fact_consistency",
				owner: "llm",
				repairability: "llm_repairable",
				message: `材料参数口径矛盾：“${anchor.label}”${group ? `在部位「${group}」` : "在未标注部位语境下"}出现 ${[...values].map((value) => `${value}${anchor.unit}`).join(" 与 ")} 两套口径：${[...new Set(raws)].slice(0, 3).join("、")}`,
				suggestion: `同一材料同一部位只允许一个口径：以设计图纸/工程量清单为准统一“${anchor.label}”${group ? `在部位「${group}」的取值` : ""}，删除矛盾表述；不同部位允许不同规格，不得全文归一为一种。`
			});
			else {
				const numbers = [...values].map(Number).filter(Number.isFinite);
				if (numbers.length < 2) continue;
				issues.push({
					level: "error",
					severity: "blocker",
					category: "fact_consistency",
					owner: "llm",
					repairability: "llm_repairable",
					message: `材料/设备数量口径矛盾：“${anchor.label}”${group ? `在部位「${group}」` : "在未标注部位语境下"}出现 ${numbers.map((value) => `${value}${anchor.unit}`).join(" 与 ")} 两套口径：${[...new Set(raws)].slice(0, 3).join("、")}`,
					suggestion: `同一设备/材料同一部位只允许一个口径：以应急物资清单/施工部署为准统一“${anchor.label}”${group ? `在部位「${group}」的取值` : ""}，删除矛盾表述；总量与分区配置属不同口径，不得互相归一。`
				});
			}
		}
	}
	return issues.slice(0, 16);
}
/** 规格 token 类型推断：从权威规格值推导正则，只校验同类型规格（避免「垫层…HRB400 钢筋」误比对混凝土标号） */
function specTokenPattern(spec) {
	if (/^C\d{2,3}$/.test(spec)) return /C\d{2,3}/u;
	if (/^M\d/.test(spec)) return /M\d+(?:\.\d+)?/u;
	if (/^P\d{1,2}$/.test(spec)) return /(?<![A-Za-z])P\d{1,2}/u;
	if (/^A\d+(?:\.\d+)?$/.test(spec)) return /A\d+(?:\.\d+)?/u;
	if (/^B\d+(?:\.\d+)?$/.test(spec)) return /B\d+(?:\.\d+)?/u;
	if (/^HRB/.test(spec) || /^HPB/.test(spec)) return /HRB\d{3,4}|HPB\d{3}/u;
	if (/mm$/.test(spec)) return /\d+(?:\.\d+)?\s*mm/u;
	return null;
}
function escapeRegexLiteral(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
/** F14 规格写错部位检测：正文规格 vs 清单权威映射（specAuthorityMap）比对——
*  同一部位语境出现该部位权威之外的规格（垫层写成 C35 而权威 C15）→ blocker（确定性可判）；
*  权威映射缺失或规格类型不可推导时静默跳过（不误伤无清单项目）。
*  4.27.0 A2：扫描结构化（hits）——裁决器与检测端共用同一扫描口径（检测定位=修复定位）。 */
function scanSpecLocationMismatchHits(markdown, specAuthorityMap) {
	const hits = [];
	if (!specAuthorityMap) return hits;
	const allLocations = [...new Set(Object.values(specAuthorityMap).flat().map((item) => item.location).filter(Boolean))];
	for (const placements of Object.values(specAuthorityMap)) {
		if (placements.length < 2) continue;
		const scanned = /* @__PURE__ */ new Set();
		for (const placement of placements) {
			const { location, spec } = placement;
			if (!location || !spec || location.length < 2) continue;
			const pattern = specTokenPattern(spec);
			if (!pattern) continue;
			const scanKey = `${location}|${pattern.source}`;
			if (scanned.has(scanKey)) continue;
			scanned.add(scanKey);
			const authoritySpecs = new Set(placements.filter((item) => item.location === location).map((item) => {
				const exact = specTokenPattern(item.spec);
				if (exact && exact.source === pattern.source) return item.spec;
				const loose = new RegExp(`^(?:${pattern.source})`, "u").exec(item.spec);
				return loose ? loose[0] : null;
			}).filter((token) => token !== null));
			const locationRe = new RegExp(`${escapeRegexLiteral(location)}[^。；;\n|]{0,40}?(${pattern.source})`, "gu");
			for (const match of markdown.matchAll(locationRe)) {
				const found = match[1] || "";
				if (PROCESS_SWITCH_WORD_RE.test(match[0])) continue;
				if (PROCESS_PARAM_RE.test(match[0]) || ENUMERATION_DECLARE_RE.test(match[0])) continue;
				const beforeFound = markdown.slice(Math.max(0, (match.index || 0) - 40), match.index || 0);
				if (ENUMERATION_DECLARE_RE.test(beforeFound)) continue;
				const afterFound = markdown.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 10);
				if (/范围内|范围/u.test(afterFound)) continue;
				if (/(?:工作宽度|作业宽度|操作空间|工作面)/u.test(afterFound) || /^、\s*\d/u.test(afterFound)) continue;
				if (/^\s*厚(?:\s*[\d:：]|覆膜|木|胶合)/u.test(afterFound)) continue;
				if (new RegExp(`^(?:或|[、,，/])\\s*(?:${pattern.source})`, "u").test(afterFound)) continue;
				const contextBefore = markdown.slice(Math.max(0, match.index || 0), (match.index || 0) + match[0].length);
				if (/(?:标高|高程|平整度|轴线|垂直度|高差)[^。；;\n|]{0,10}(?:偏差|误差|不超过|不得大于|不大于)/u.test(contextBefore.slice(-28))) continue;
				if (/(?:偏差|误差|公差|缝隙|接缝|拼缝|高差|顺直度|垂直度|平整度|轴线|标高|高程)[^。；;\n|]{0,16}(?:不超过|不得大于|不大于|控制在|±|≤)/u.test(contextBefore.slice(-36))) continue;
				const preFound = match[0].slice(0, match[0].indexOf(found));
				if (/(?:间距|中心距|净距|排距|间隔)[^。；;\n|，,、]{0,8}$/u.test(preFound)) continue;
				const foundAt = match[0].indexOf(found);
				if (foundAt > location.length && /(?:涵头|面层|基层|垫层|管基|基础|梁|板|柱|墙|地坪|路面)/u.test(match[0].slice(location.length, foundAt))) continue;
				const locationStart = match.index || 0;
				const collisionLocation = allLocations.find((candidate) => candidate.length > location.length && candidate.endsWith(location) && markdown.slice(locationStart + location.length - candidate.length, locationStart + location.length) === candidate);
				if (collisionLocation) {
					if (new Set(placements.filter((item) => item.location === collisionLocation && specTokenPattern(item.spec)?.source === pattern.source).map((item) => item.spec)).has(found)) continue;
				}
				if (authoritySpecs.has(found)) continue;
				const uniqueAuthority = authoritySpecs.size === 1 ? [...authoritySpecs][0] : void 0;
				const valueStart = locationStart + foundAt;
				hits.push({
					issue: {
						level: "error",
						severity: "blocker",
						category: "fact_consistency",
						owner: "llm",
						repairability: "llm_repairable",
						message: `规格错位：“${location}”使用的规格 ${found} 与工程量清单权威（${[...authoritySpecs].join("/")}）不一致`,
						suggestion: `按工程量清单将“${location}”的规格统一为 ${[...authoritySpecs].join("/")}；同一材料不同部位允许不同规格，但同一部位不得混用其他部位的规格。`
					},
					location,
					replacement: uniqueAuthority ? {
						start: valueStart,
						end: valueStart + found.length,
						replacement: uniqueAuthority,
						detail: `规格错位“${location}” ${found}→${uniqueAuthority}（以工程量清单锁定口径为准）`
					} : void 0
				});
				if (hits.length >= 8) return hits;
			}
		}
	}
	return hits.slice(0, 8);
}
/** 检测端入口（行为保持）：扫描命中只取 issue */
function specLocationMismatchIssues(markdown, specAuthorityMap) {
	return scanSpecLocationMismatchHits(markdown, specAuthorityMap).map((hit) => hit.issue);
}
function ambiguousEitherOrIssues(markdown) {
	const normalized = markdown.replace(/\s+/gu, "");
	const hits = /* @__PURE__ */ new Set();
	const headerCellTexts = [];
	{
		const headerLines = markdown.split(/\n/u);
		for (let i = 0; i + 1 < headerLines.length; i += 1) {
			const line = headerLines[i] ?? "";
			if (!/^\s*\|/u.test(line)) continue;
			if (!/^\s*\|[\s:|-]+\|\s*$/u.test((headerLines[i + 1] ?? "").trim())) continue;
			for (const cell of line.split("|")) {
				const cellText = cell.replace(/\s+/gu, "");
				if (cellText.length >= 2) headerCellTexts.push(cellText);
			}
		}
	}
	const inTableHeader = (text) => headerCellTexts.some((cell) => cell.includes(text));
	for (const match of normalized.matchAll(/([一-龥]{2,8})\/([一-龥]{2,8})/gu)) {
		const wordFamilyHit = DESIGN_PARAM_WORD_RE.test(match[1]) || DESIGN_PARAM_WORD_RE.test(match[2]);
		const decisionCategory = matchDecisionCategory(match[1], match[2]);
		if (!wordFamilyHit && !decisionCategory) continue;
		if (inTableHeader(match[0])) continue;
		const start = Math.max(0, (match.index || 0) - 12);
		const end = Math.min(normalized.length, (match.index || 0) + match[0].length + 12);
		const window = normalized.slice(start, end);
		if (/管线|管道|电缆|给水|排水/u.test(window)) continue;
		if (!/采用|形式|方式|方案|选用|拟用|拟采用|为/u.test(window)) {
			if (!decisionCategory || /不得|禁止|不应|不宜|避免|严禁|无需/u.test(window)) continue;
		}
		hits.add(`“${match[1]}/${match[2]}”`);
	}
	for (const match of normalized.matchAll(/[（(]\s*或[^）)]{1,48}[）)]/gu)) {
		const inner = match[0].slice(1, -1);
		if (!/按图纸|按实|按图|待定|另行|视[^，。；]{0,8}而定|根据实际/u.test(inner)) continue;
		const start = Math.max(0, (match.index || 0) - 20);
		const window = normalized.slice(start, (match.index || 0) + match[0].length);
		if (!DESIGN_PARAM_WORD_RE.test(window)) continue;
		hits.add(match[0].slice(0, 30));
	}
	for (const match of normalized.matchAll(/([一-龥]{2,8})或([一-龥]{2,8})/gu)) {
		const wordFamilyHit = DESIGN_PARAM_WORD_RE.test(match[1]) || DESIGN_PARAM_WORD_RE.test(match[2]);
		const decisionCategory = matchDecisionCategory(match[1], match[2]);
		if (!wordFamilyHit && !decisionCategory) continue;
		if (/(?:可能)?(?:达到|超过|大于|小于|高于|低于|不少于|不超过)或(?:达到|超过|大于|小于|高于|低于|不少于|不超过)/u.test(match[0])) continue;
		if (inTableHeader(match[1]) || inTableHeader(match[2])) continue;
		const start = Math.max(0, (match.index || 0) - 12);
		const window = normalized.slice(start, (match.index || 0) + match[1].length);
		if (/管线|管道|电缆|给水|排水/u.test(window)) continue;
		if (!/按|采用|选用|拟用|拟采用|方案|为/u.test(window)) {
			if (!decisionCategory || /不得|禁止|不应|不宜|避免|严禁|无需/u.test(window)) continue;
		}
		const preceding = normalized.slice(Math.max(0, (match.index || 0) - 6), match.index || 0);
		if (/临时/u.test(preceding + match[0]) && /支护|围护|放坡|坡率|开挖/u.test(match[0])) continue;
		if (/围挡|警示|防护栏|爬梯|栈桥|便道/u.test(match[0])) continue;
		const facilityWindow = normalized.slice(Math.max(0, (match.index || 0) - 30), (match.index || 0) + match[0].length + 12);
		if (/临时|临建|可拆卸|可周转|撤场/u.test(facilityWindow) && /集装箱|活动房|板房|棚房|岗亭|彩钢/u.test(match[1] + match[2])) continue;
		if (/顺接|衔接|接顺|接入|连通|找坡|找平/u.test(match[2])) continue;
		const afterWindow = normalized.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 6);
		if (/^(?:顺接|衔接|接顺|接入|连通|找坡|找平)/u.test(afterWindow)) continue;
		if (/(?:前|后)$/u.test(match[0])) continue;
		if (/^(?:之前|之后|前|后)/u.test(afterWindow)) continue;
		{
			const chainStart = Math.max(0, (match.index || 0) - 8);
			const chainEnd = Math.min(normalized.length, (match.index || 0) + match[0].length + 8);
			if (normalized.slice(chainStart, chainEnd).includes("→")) continue;
		}
		const defectPair = match[1] + match[2];
		if (/(?:强度不足|固定不牢|松动|变形|开裂|渗漏|破损|脱落|锈蚀|超差|不合格|缺陷|损坏|缺失|偏差|偏移|沉降|位移|错台|起皮|空鼓)/u.test(defectPair)) {
			const disposalWindow = normalized.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 40);
			if (/返工|返修|整改|修复|加固|更换|补强|补做|处理|消除|纠正|复验|复查|销项|验收/u.test(disposalWindow)) continue;
		}
		if (CONNECTION_CRAFT_TAIL_RE.test(match[1]) && CONNECTION_CRAFT_TERM_RE.test(match[2])) continue;
		const left = match[1].replace(/^.*?(地下连续墙|钢板桩|灌注桩|支护桩|土钉墙|基础|支护|围护|结构|开挖|放坡|喷锚|排桩|连续墙|土钉|锚杆|形式|体系)/u, "$1");
		hits.add(`${left}或${match[2]}`);
	}
	if (hits.size === 0) return [];
	return [{
		level: "error",
		severity: "blocker",
		category: "fact_consistency",
		owner: "llm",
		repairability: "llm_repairable",
		message: `关键设计决策两可表述：${[...hits].join("、")} 以并列/悬置形态表述，基础形式、支护形式等关键决策必须在正文中唯一确定`,
		suggestion: "以设计图纸/勘察报告/工程量清单为准锁定唯一决策并删除两可表述：明确写出本项目基础形式与支护形式的具体做法（如「基础形式为筏板基础」「基坑支护采用放坡+喷锚」），禁止「或…按图纸实施」类悬置话术。"
	}];
}
var STAGE_LABOR_RE, LABOR_COUNT_RE, MANAGEMENT_PERSONNEL_WORD_RE, HAZARD_CATEGORY_TERMS, NL, SELF_UNDERMINING_QUERIES, POSITIVE_SELF_REFERENCE_RE, SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE, REMEDIATION_CONDITION_CLAUSE_RE, NEGATED_DEFICIENCY_RE, PROHIBITED_EXCUSE_CLAUSE_RE, HYPOTHETICAL_MARKER_RE, SCHEDULE_NODE_ANCHORS, CROSS_SECTION_ANCHORS, CROSS_SECTION_ANCHOR_ENTITY_RE, ENUMERATION_VALUE_RE, NEGATIVE_DECLARATION_RE, PROCESS_SWITCH_WORD_RE, PROCESS_PARAM_RE, ENUMERATION_DECLARE_RE, LOCATION_WORD_SOURCE, PER_UNIT_LOCATION_RE, LOCATION_ENTITY_QUALIFIER_RE, RESOURCE_SHARING_CONTEXT_RE, DESIGN_PARAM_WORD_RE, CONNECTION_CRAFT_TERM_RE, CONNECTION_CRAFT_TAIL_RE;
var init_detectors = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	init_evidenceContentSafety();
	init_authorities();
	init_integratedBlueprint();
	init_semanticAdjudication();
	STAGE_LABOR_RE = /(?:阶段|期间)[^。；;\n]{0,12}?(?:约)?\s*([\d,]+)\s*人/g;
	LABOR_COUNT_RE = /(?:劳动力|作业人员|施工人员)(?:(?!(?:不得超过|不超过|不大于|不少于|不低于|不应超过|不应少于|不得大于|不得少于|至少|最多))[^。；;\n]){0,16}?(?:约)?\s*([\d,]+)\s*人/g;
	MANAGEMENT_PERSONNEL_WORD_RE = /项目经理|技术负责人|项目班子|管理人员|管理层|施工员|质量员|质检员|安全员|材料员|资料员|测量员|试验员|造价员|预算员/u;
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
	SELF_UNDERMINING_QUERIES = [
		"专项设计文件尚未完成，待后续补充",
		"评分指标存在缺口尚未明确",
		"依据承诺函后续跟踪完善",
		"本项目未采用行业认定的新技术、新工艺、新设备、新材料"
	];
	POSITIVE_SELF_REFERENCE_RE = /编制范围为[^。；;]{0,40}?所界定的全部施工内容|作为施工组织的控制性约束条件|分项验收[，,]?验收记录经监理工程师签字确认后归档|(?:执行|按|依据|按照)[^。；;]{0,10}?(?:〔|【)?20\d{2}(?:〕|】)?\s*\d+\s*号\s*(?:文件|办法|规定)?/u;
	SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE = /未落实[^。；;]{0,24}?(?:整改|复查|销项|复验)|未(?:明确|列明|注明)[^。；;]{0,36}?按[^。；;]{0,44}?(?:执行|选取|确定|取用|调整|选用)|(?:发现|对|明确|约定|签订|制定|建立|规定|凡|任何|所有|新增)[^。；;]{0,48}?(?:缺失|损坏|不全|脱岗|未审批|不合格|未完成|未明确|未落实|隐患)[^。；;]{0,72}?(?:整改|复查|销项|约谈|补齐|补拍|重拍|补传|重新上传|补测|复测|补报|归档|复核|确认|登记|通知|上报|通报|更新|处置|修复|更换|纠正|恢复|完善|处理|落实|责任|时限|考核|处罚|扣减|调离|清退|停止作业|恢复施工|补录|追查)|(?:不得|严禁|禁止)[^。；;]{0,40}?(?:避免|防止)[^。；;]{0,20}?(?:返工|窝工|损失|事故)|(?:重难点|难点)(?:源于|在于)[^。；;]{0,80}?(?:若|如)未[^。；;]{0,40}?(?:将|会|可能)|(?:考核|考评|评比|评分)[^。；;]{0,50}?(?:不合格|不达标|不到位|不称职|失职|缺失|超时|违规)[^。；;]{0,36}?(?:绩效扣减|扣减|扣款|调离|清退|退场|问责|处罚|奖惩|奖罚)|(?:如|若)[^。；;]{0,60}?(?:发包人|招标人|建设单位)[^。；;]{0,60}?(?:有权|可要求|可以要求|可提出|可以提出)|[^。；;]{0,24}?时[，,][^。；;]{0,32}?(?:发包人|招标人|建设单位)[^。；;]{0,60}?(?:有权|可要求|可以要求|可提出|可以提出)|未[^。；;]{0,16}?不放过|(?:凡|任何|所有)[^。；;]{0,24}?未[^。；;]{0,40}?(?:人员|工人)[^。；;]{0,20}?(?:不得|严禁|禁止)[^。；;]{0,20}?(?:进入|上岗|进场|作业)|未[^。；;]{0,32}?(?:前|的)[^。；;]{0,32}?(?:不得|严禁|禁止|不予|不办理|不签发|不安排|不组织|不批准|不开放|不下发|不投入使用)|(?:未能|未按|未完成|未明确|未落实|未闭合|未审批|缺失|损坏|缺漏|不合格|隐患)[^。；;]{0,40}?(?:整改|复查|销项|恢复|复核|确认|登记|更新|处置|修复|更换|纠正|完善|落实|补齐|补测|复测|归档|通知|上报|通报|约谈|扣减|停止作业)[^。；;]{0,20}?(?:复查|销项|确认|登记|归档|责任|时限|考核|处罚|扣减|调离|清退|落实|复核|恢复|整改|处置|更新|完成|闭合)|未(?:完成|通过|复审|核验|审查|审核|验收|办理|达标|整改|闭合|接受|取得)[^。；;]{0,32}?(?:不得|严禁|禁止|不予|不办理|不签发|不安排|不组织|不批准|不开放)[^。；;]{0,16}?(?:上岗|作业|进场|进入|担任|从事|投用|使用|操作|开工|复工|施工|回填|浇筑|砌筑|铺筑|摊铺|安装|隐蔽|覆盖|封闭|推进|实施|开放|通行|吊装|拆除|验收)|(?:对|针对)[^。；;]{0,20}?未[^。；;]{0,24}?(?:的|区段|部位|工序|作业面|任务|班组)[^。；;]{0,60}?(?:调整|调拨|调配|增派|增补|加强|优化)[^。；;]{0,60}?(?:确保|保障|保证)[^。；;]{0,24}?(?:不突破|不超|满足|达标|完成|实现)|(?:统计|评估|分析|核算|汇总|排查|监测)[^。；;]{0,30}?(?:未能|未按|未完成|未明确|未落实|缺失|损坏|损失|不合格|隐患|滞后|影响)[^。；;]{0,50}?(?:组织|调整|调拨|调配|增派|增补|补充|加密|加强|优化|纠偏|补位)[^。；;]{0,50}?(?:确保|保障|保证)[^。；;]{0,24}?(?:不[^。；;]{0,6}?(?:突破|超期|滞后|延误|影响|低于|少于|超过)|满足|达标|完成|实现|符合)|(?:缺失|损坏|缺漏|过期|失效)[^。；;]{0,24}?(?:当日|当天|立即|及时|随时|限期|按批|按次|定期)[^。；;]{0,16}?(?:补充|更换|修复|整改|处置|更新|补齐|完善|销项)|未[^。；;]{0,20}?(?:的|区段|部位|工序|作业面|任务|班组|段落)[^。；;]{0,48}?(?:由|经|责成|交|指定)[^。；;]{0,16}?(?:组织|安排|负责|落实|实施|调配|增派|督办|责成)[^。；;]{0,40}?(?:清运|清理|处置|处理|整改|完善|补充|调整|加固|返工|修复|恢复|回填|浇筑|作业|施工|外运|归集)[^。；;]{0,40}?(?:直至|确保|保证|实现|不留|无遗留|达标|闭合|清零|完成|销项)/u;
	REMEDIATION_CONDITION_CLAUSE_RE = /未[^，。；;\n]{1,12}的[，,]?(?:由|经|应|须|需|统一|一律|责成)[^，。；;\n]{0,16}?(?:补齐|补正|补录|补报|整改|纠正|复核|复验|复测|返工|修整|处理)[^，。；;\n]{0,20}?(?:方可|才能|不得|严禁)/gu;
	NEGATED_DEFICIENCY_RE = /(?:无|没有|不存在|未发现|未出现|杜绝|避免|防止|严禁|不得出现)(?:出现|发生|存在|产生)?(?:尚未完成|尚未|未完成|未明确|未采用|未落实|未确定|未闭合|存在缺口|有待|待补充|待完善|跟踪完善|不够|不明确|缺失|缺少|缺乏|风险较大|难以保证|无法保证|正在办理|暂未|未能|需进一步)/gu;
	PROHIBITED_EXCUSE_CLAUSE_RE = /(?:不得|严禁|禁止|绝不|不能|不可)以[^，。；]{1,24}为(?:由|借口|理由)/gu;
	HYPOTHETICAL_MARKER_RE = /(?:倘若|如果|一旦|万一|若(?!干))/u;
	SCHEDULE_NODE_ANCHORS = [
		{
			key: "excavation",
			label: "基坑支护及土方外运",
			re: /基坑支护/u
		},
		{
			key: "zero",
			label: "地下结构出正负零",
			re: /正负零|地下室结构/u
		},
		{
			key: "topping",
			label: "主体结构封顶",
			re: /主体(?:结构)?封顶/u
		},
		{
			key: "decoration",
			label: "装饰装修及幕墙",
			re: /装饰装修/u
		},
		{
			key: "mep",
			label: "机电安装及智能化调试",
			re: /机电安装/u
		},
		{
			key: "completion",
			label: "室外工程及竣工验收",
			re: /竣工验收/u
		}
	];
	CROSS_SECTION_ANCHORS = [
		{
			key: "xps",
			label: "挤塑聚苯板（XPS）厚度",
			unit: "mm",
			kind: "number",
			patterns: [/(?:挤塑聚苯|XPS)(?:(?!(?:宽度|拼缝|不大于|不超过|小于|≤|采用|使用|选用|铺设|粘贴|半径|倒角|圆弧|弧度)).){0,40}?(\d+(?:\.\d+)?)\s*mm/gu, /(\d+(?:\.\d+)?)\s*mm[^。；;\n|]{0,10}?(?:挤塑聚苯|XPS)/gu]
		},
		{
			key: "cushion",
			label: "垫层混凝土强度等级",
			unit: "C标号",
			kind: "code",
			patterns: [/(?<!混凝土)垫层[^。；;\n|]{0,20}?(C\d{2})/gu]
		},
		{
			key: "transformer",
			label: "箱式变压器容量",
			unit: "kVA",
			kind: "number",
			patterns: [/(\d+)\s*kVA[^。；;\n|]{0,12}?变压器/gu, /变压器[^。；;\n|]{0,12}?(\d+)\s*kVA/gu]
		},
		{
			key: "formwork",
			label: "模板周转次数",
			unit: "次",
			kind: "number",
			patterns: [/模板周转(?:次数|使用)?[^。；;\n|]{0,15}?(\d+)\s*次/gu]
		},
		{
			key: "block",
			label: "蒸压加气混凝土砌块强度等级",
			unit: "A标号",
			kind: "code",
			patterns: [/(?:蒸压加气混凝土|加气混凝土)?砌块[^。；;\n]{0,24}?(A\d+(?:\.\d+)?)/gu]
		},
		{
			key: "extinguisher",
			label: "干粉灭火器数量",
			unit: "具",
			kind: "number",
			patterns: [/灭火器[^。；;\n]{0,24}?(\d+)\s*具/gu]
		},
		{
			key: "pump",
			label: "潜水泵（提升泵）数量",
			unit: "台",
			kind: "number",
			patterns: [/(?:潜水泵|提升泵)[^。；;\n]{0,24}?(\d+)\s*台/gu]
		},
		{
			key: "firstaid",
			label: "急救箱数量",
			unit: "套/个",
			kind: "number",
			patterns: [/急救箱[^。；;\n|]{0,24}?(\d+)\s*(?:套|个)/gu]
		},
		{
			key: "scheduleDays",
			label: "计划总工期",
			unit: "日历天",
			kind: "number",
			patterns: [
				/^\s*\|\s*计划工期\s*\|\s*(\d{1,4})\s*个?\s*日历天\s*\|/gmu,
				/(?:计划工期|合同工期|工期总日历天数|工期控制|工期目标|总工期)[^。；;\n|]{0,12}?(\d{1,4})\s*个?\s*日历天/gu,
				/(\d{1,4})\s*个?\s*日历天[^。；;\n|]{0,8}?(?:总工期|倒排|分解|为唯一|完成)/gu
			]
		},
		{
			key: "prefabRatio",
			label: "装配率",
			unit: "%",
			kind: "number",
			patterns: [
				/装配率[^。；;\n|]{0,14}?(\d+(?:\.\d+)?)\s*%/gu,
				/装配率[^。；;\n|]{0,44}?计算为(\d+(?:\.\d+)?)\s*%/gu,
				/(\d+(?:\.\d+)?)\s*%(?:(?![，,。；;\n|]).){0,10}?装配率/gu
			]
		},
		{
			key: "projectCode",
			label: "项目编号",
			unit: "",
			kind: "code",
			patterns: [/(?:招标项目编号|项目编号)[^。；;\n|]{0,8}?(20\d{2}[A-Z]{1,8}\d{2,10})/gu]
		},
		{
			key: "towerCrane",
			label: "塔式起重机（塔吊）数量",
			unit: "台",
			kind: "number",
			patterns: [/(?:塔式起重机|塔吊)[^。；;\n|、，]{0,30}?(\d+)\s*台/gu, /(\d+)\s*台[A-Za-z0-9/\-–—～~]{0,16}\s{0,2}(?:塔式起重机|塔吊)/gu]
		},
		{
			key: "hoist",
			label: "施工升降机（施工电梯）数量",
			unit: "台",
			kind: "number",
			patterns: [/(?:施工升降机|施工电梯)[^。；;\n|、，]{0,30}?(\d+)\s*台/gu, /(\d+)\s*台[A-Za-z0-9/\-–—～~]{0,16}\s{0,2}(?:施工升降机|施工电梯)/gu]
		},
		{
			key: "truckCrane",
			label: "汽车起重机（汽车吊）数量",
			unit: "台",
			kind: "number",
			patterns: [/(?:汽车起重机|汽车吊)[^。；;\n|、，]{0,30}?(\d+)\s*台/gu, /(\d+)\s*台[A-Za-z0-9/\-–—～~]{0,16}\s{0,2}(?:汽车起重机|汽车吊)/gu]
		},
		{
			key: "rebarCutter",
			label: "钢筋切断机数量",
			unit: "台",
			kind: "number",
			patterns: [/钢筋切断机[^。；;\n|]{0,24}?(\d+)\s*台/gu]
		},
		{
			key: "rebarBender",
			label: "钢筋弯曲机数量",
			unit: "台",
			kind: "number",
			patterns: [/钢筋弯曲机[^。；;\n|]{0,24}?(\d+)\s*台/gu]
		},
		{
			key: "slackDays",
			label: "机动工期（工序衔接与验收缓冲）",
			unit: "天",
			kind: "number",
			patterns: [/(?:机动工期|缓冲)[^。；;\n|]{0,16}?(\d{1,3})\s*天/gu, /预留[^。；;\n|]{0,8}?(\d{1,3})\s*天[^。；;\n|]{0,10}?(?:机动|缓冲)/gu]
		},
		{
			key: "villageCount",
			label: "自然村数量",
			unit: "个自然村",
			kind: "number",
			patterns: [/(\d+)\s*个[^，。；、\s\n]{0,8}?自然村(?!分组|施工组)/gu]
		},
		{
			key: "circularSaw",
			label: "圆盘锯数量",
			unit: "台",
			kind: "number",
			patterns: [/圆盘锯[^。；;\n|]{0,24}?(\d+)\s*台/gu]
		},
		{
			key: "excavator",
			label: "挖掘机数量",
			unit: "台",
			kind: "number",
			patterns: [/(?:履带式)?挖掘机[^。；;\n、，]{0,40}?(\d+)\s*台/gu, /(\d+)\s*台[^、，。；\n|]{0,12}?(?:履带式)?挖掘机/gu]
		},
		{
			key: "dumpTruck",
			label: "自卸汽车数量",
			unit: "台/辆",
			kind: "number",
			patterns: [/自卸汽车[^。；;\n、，]{0,40}?(\d+)\s*(?:台|辆)/gu, /(\d+)\s*(?:台|辆)[^、，。；\n|]{0,12}?自卸汽车/gu]
		},
		{
			key: "roller",
			label: "压路机数量",
			unit: "台",
			kind: "number",
			patterns: [/(?:振动)?压路机[^。；;\n、，]{0,40}?(\d+)\s*台/gu, /(\d+)\s*台[^、，。；\n|]{0,12}?(?:振动)?压路机/gu]
		},
		{
			key: "rammer",
			label: "蛙式打夯机数量",
			unit: "台",
			kind: "number",
			patterns: [/蛙式打夯机[^。；;\n、，]{0,40}?(\d+)\s*台/gu, /(\d+)\s*台[^、，。；\n|]{0,12}?蛙式打夯机/gu]
		},
		{
			key: "mixerTruck",
			label: "混凝土搅拌运输车数量",
			unit: "台",
			kind: "number",
			patterns: [/混凝土搅拌运输车[^。；;\n、，]{0,40}?(\d+)\s*台/gu, /(\d+)\s*台[^、，。；\n|]{0,12}?混凝土搅拌运输车/gu]
		},
		{
			key: "concreteMixer",
			label: "混凝土搅拌机数量",
			unit: "台",
			kind: "number",
			patterns: [/混凝土搅拌机[^。；;\n、，]{0,40}?(\d+)\s*台/gu, /(\d+)\s*台[^、，。；\n|]{0,12}?混凝土搅拌机/gu]
		},
		{
			key: "sprinkler",
			label: "洒水车数量",
			unit: "台/辆",
			kind: "number",
			patterns: [/洒水车[^。；;\n、，]{0,40}?(\d+)\s*(?:台|辆)/gu, /(\d+)\s*(?:台|辆)[^、，。；\n|]{0,12}?洒水车/gu]
		},
		{
			key: "aerialLift",
			label: "高空作业车数量",
			unit: "台",
			kind: "number",
			patterns: [/高空作业车[^。；;\n、，]{0,40}?(\d+)\s*台/gu, /(\d+)\s*台[^、，。；\n|]{0,12}?高空作业车/gu]
		},
		{
			key: "pondBackfill",
			label: "沟塘回填方量",
			unit: "m³",
			kind: "number",
			patterns: [
				/(?:沟塘|水塘|池塘|河塘|鱼塘|塘内|渠道|淤泥|流砂|清淤)[^。；;\n|]{0,30}?回填方(?:总量)?[^。；;\n|]{0,16}?(\d+(?:\.\d+)?)\s*m[3³]/gu,
				/(?:沟塘|水塘|池塘|河塘|鱼塘|塘内|渠道|淤泥|流砂|清淤)[^；;\n|]{0,30}?回填方总量[^。；;\n|]{0,16}?(\d+(?:\.\d+)?)\s*m[3³]/gu,
				/回填方(?:总量)?[^。；;\n|]{0,16}?(\d+(?:\.\d+)?)\s*m[3³][^。；;\n|]{0,30}?(?:沟塘|水塘|池塘|河塘|鱼塘|塘内|渠道|淤泥|流砂|清淤)/gu
			]
		},
		{
			key: "trenchClearing",
			label: "沟槽槽底人工清底预留厚度",
			unit: "mm",
			kind: "number",
			patterns: [/槽底预留(\d+)mm人工清底/gu]
		},
		{
			key: "houseExcavation",
			label: "距房屋人工开挖保护距离",
			unit: "m",
			kind: "number",
			patterns: [/距房屋(\d+(?:\.\d+)?)m(?:内|范围内)[^。；;\n|]{0,10}?人工开挖/gu]
		}
	];
	CROSS_SECTION_ANCHOR_ENTITY_RE = {
		pump: /潜水泵|提升泵/u,
		towerCrane: /塔式起重机|塔吊/u,
		hoist: /施工升降机|施工电梯/u,
		truckCrane: /汽车起重机|汽车吊/u,
		rebarCutter: /钢筋切断机/u,
		rebarBender: /钢筋弯曲机/u,
		circularSaw: /圆盘锯/u,
		excavator: /挖掘机/u,
		dumpTruck: /自卸汽车|自卸车/u,
		roller: /压路机/u,
		rammer: /蛙式打夯机|打夯机/u,
		mixerTruck: /混凝土搅拌运输车|搅拌车/u,
		concreteMixer: /混凝土搅拌机/u,
		sprinkler: /洒水车/u,
		aerialLift: /高空作业车/u,
		extinguisher: /灭火器/u,
		firstaid: /急救箱/u
	};
	ENUMERATION_VALUE_RE = /\d+(?:\.\d+)?\s*(?:mm|kVA|次|具|台|套|个)\s*[/／]\s*\d+/u;
	NEGATIVE_DECLARATION_RE = /不再出现|不得出现|严禁出现|避免出现|不采用|未采用|予以删除|已删除|取消|纠正为|更正为/u;
	PROCESS_SWITCH_WORD_RE = /再浇筑|再浇|后浇筑|后浇|然后浇筑|然后再浇|上层|上部|面层浇筑|其上浇筑|浇筑完成后再/u;
	PROCESS_PARAM_RE = /分层厚度|分层浇筑|分层振捣|焊缝高度|焊缝厚度|焊脚尺寸|锚固深度|保护层厚度|搭接长度|锚固长度|预留|踏步高度|踏步宽度|踏步高|踏步宽|台阶高度|台阶宽度|内厚|外厚|抹面|抹灰|粉刷|垫高|架空|离地|支垫/u;
	ENUMERATION_DECLARE_RE = /分别为|分别对应|分别用于|分别按|依次为|依次/u;
	LOCATION_WORD_SOURCE = "女儿墙|外墙|内墙|隔墙|地梁|圈梁|构造柱|过梁|垫层|承台|筏板|底板|基础|主体|梁|柱|墙|楼板|屋面|地面|楼面|顶板|楼梯|阳台|雨篷|台阶|散水|坡道|找坡|找平|保护层|防水层|保温层|隔汽层|地坪|办公区|生活区|库房|加工区|堆放区|驻地|周转场|停放区|仓库|材料库|路基|沟槽|基槽|基坑|路槽";
	PER_UNIT_LOCATION_RE = /每[台辆架套部][一-龥A-Za-z0-9]{1,8}/gu;
	LOCATION_ENTITY_QUALIFIER_RE = /项目部|总协调|工人生活|施工办公|办公|生活|临时|总部|标段|片区/u;
	RESOURCE_SHARING_CONTEXT_RE = /共用[^。；;\n]{0,10}|不(?:再)?单独(?:增配|新增|购置|添置|配置)|不另行(?:增配|新增|购置)|轮换使用|周转使用|交叉使用/u;
	DESIGN_PARAM_WORD_RE = /基础|支护|围护|桩|结构|开挖|放坡|喷锚|排桩|连续墙|土钉|锚杆|标高|深度|形式|体系/u;
	CONNECTION_CRAFT_TERM_RE = /^(?:焊接|螺栓连接|铆接|法兰连接|承插连接|卡箍连接|粘接|卡压连接|卡扣连接|螺纹连接|高强螺栓连接)(?:固定|安装|连接|紧固)?$/u;
	CONNECTION_CRAFT_TAIL_RE = /(?:焊接|螺栓连接|铆接|法兰连接|承插连接|卡箍连接|粘接|卡压连接|卡扣连接|螺纹连接|高强螺栓连接)$/u;
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentIntegrityChecks.ts
var init_documentIntegrityChecks = __esmMin((() => {
	init_authorities();
	init_detectors();
	init_fixers();
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
//#endregion
//#region apps/server/src/services/document-workflow/rolePipeline.ts
function selectDocumentGenerationStrategy(input) {
	const chapterCount = input.template.chapters.length;
	const avgChapterTarget = chapterCount > 0 ? input.targetWords / chapterCount : input.targetWords;
	const text = `${input.template.name}\n${input.template.category || ""}\n${input.requirement || ""}`;
	const riskKeywords = /专项|安全|质量|验收|审核|合同|合规|审计|风控|风险/u.test(text);
	const veryLong = input.targetWords >= 4e4;
	const sparseMaterials = (input.materialFileCount ?? 0) < 4 && (input.evidenceCount ?? 0) < 6;
	const strict = riskKeywords || veryLong || sparseMaterials;
	const longform = input.targetWords >= 3e4 || chapterCount >= 8 || avgChapterTarget >= 4e3;
	const compact = input.targetWords <= 6e3 && chapterCount <= 4 && !strict;
	const globalReviewEnabled = process.env.DOCUMENT_GLOBAL_CONSISTENCY_REVIEW !== "0" && (strict || compact || process.env.DOCUMENT_GLOBAL_CONSISTENCY_REVIEW === "1");
	return {
		mode: strict ? "strict" : longform ? "longform" : compact ? "fast" : "balanced",
		enableChapterReview: true,
		enableGlobalReview: globalReviewEnabled,
		enableFinalQualityReview: true,
		globalReviewSamplingRate: globalReviewEnabled && compact ? .35 : 1
	};
}
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
/** 表格单元格不可见字符归一（全角空格 \u3000 / 不换行空格 \u00a0 / 零宽与变体空格 \u2000-\u200f\u202f\u205f / BOM \ufeff）。
* 十度实测缺陷：LLM 输出的空表格单元格有时以全角空格等不可见字符填充，cell.trim() 无法识别，
* 检测/修复/审计三层全部漏网；清洗层剥离后三层同口径以 cell === '' 判定空单元格。 */
function stripTableCellInvisibleChars(text) {
	return text.replace(/[\u3000\u00a0\u2000-\u200f\u202f\u205f\ufeff]/gu, "");
}
var init_markdownCleanup = __esmMin((() => {
	init_markdownComposer();
	init_outline$1();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/qualityValidation.ts
function markdownTables(markdown) {
	const tableBlocks = [];
	const lines = markdown.split(LINE_SPLIT_RE);
	for (let index = 0; index < lines.length; index += 1) {
		if (!MARKDOWN_TABLE_ROW_RE.test(lines[index])) continue;
		const block = [];
		while (index < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[index])) {
			block.push(lines[index]);
			index += 1;
		}
		index -= 1;
		if (block.some((line) => MARKDOWN_TABLE_DIVIDER_RE.test(line))) tableBlocks.push(block.join("\n"));
	}
	return tableBlocks;
}
/** 表格占位符单元格判定单源（D-T5）：阻断层 markdownTableQualityIssues、警告层 formalPlaceholderIssues
* 与 patchGuard 预检三处共用。词形见 TABLE_PLACEHOLDER_CELL_FORMS_RE（含「无」扩围）+ 约N 模糊量；
* 豁免口径：①合计/小计/总计/累计行的「—」为不适用语义（cellIndex>0，行首格即合计标签）；
* ②规格型号/规格/型号/额定功率/功率/生产能力/产能列的「—」为「源资料不提供、强填诱导编造」合法形态
* （丰乐镇实测：蛙式打夯机无型号，LLM 修复轮曾编造 HW-60；r28g B7 扩围额定功率/生产能力）。
* C5 扩围（s28l 实机 8 行×3 列 24 处误报）：国别产地/制造年份/用于施工部位/已使用台时数为设备
* 仪器附表生成端硬编码「—」的投产信息列（composeAppendices renderEquipmentAppendix/
* renderInstrumentAppendix 注明「如实留空不编造」），与规格类列同族豁免——生成端故意留空与
* 检测端报阻断的口径冲突在此单源消解（豁免列与附表生成端表头保持对齐）。
* 其余占位词（若干/约/待定/无等）任何行任何列均不豁免，只豁免单个/多个破折号形态。
* r28f #42 归因：警告层此前用裸正则（无豁免口径），豁免列「—」被照报（实测 23 处误报）——统一到本判定。 */
function isNonExemptTablePlaceholderCell(cell, refs) {
	if (!TABLE_PLACEHOLDER_CELL_FORMS_RE.test(cell) && !TABLE_PLACEHOLDER_APPROX_RE.test(cell)) return false;
	if (!/^(?:—+|-+)$/u.test(cell)) return true;
	if (refs.cellIndex > 0 && /^(?:合计|小计|总计|累计)/u.test(refs.rowFirstCell || "")) return false;
	if (refs.headerCell && /规格型号|规格|型号|额定功率|功率|生产能力|产能|国别产地|制造年份|用于施工部位|已使用台时数/u.test(refs.headerCell)) return false;
	return true;
}
/** 表格占位符非豁免命中扫描（D-T5）：表块解析与 markdownTableQualityIssues 同源（连续表格行且
* 分隔线位于第二行；无分隔线/碎表由「表格分隔线位置不规范」独立阻断，不在此重复）。
* 命中含表头/行首/列位/格值定位，供警告层定级与 patchGuard 片段预检消费。 */
function scanTablePlaceholderCells(markdown) {
	const hits = [];
	for (const block of markdownTables(markdown)) {
		const rows = block.split(LINE_SPLIT_RE).filter((line) => MARKDOWN_TABLE_ROW_RE.test(line));
		if (rows.length < 2 || !MARKDOWN_TABLE_DIVIDER_RE.test(rows[1] || "")) continue;
		const cells = rows.map((line) => line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split(/(?<!\\)\|/u).map((cell) => stripTableCellInvisibleChars(cell.trim())));
		const header = cells[0] || [];
		for (const row of cells.slice(2)) for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
			const cell = row[cellIndex] || "";
			if (isNonExemptTablePlaceholderCell(cell, {
				rowFirstCell: row[0] || "",
				headerCell: header[cellIndex],
				cellIndex
			})) hits.push({
				header,
				rowFirstCell: row[0] || "",
				cellIndex,
				cell
			});
		}
	}
	return hits;
}
function markdownTableQualityIssues(markdown) {
	markdown = mergeTableLineBreaks(markdown);
	const issues = [];
	{
		const lines = markdown.split(LINE_SPLIT_RE);
		for (let index = 1; index < lines.length; index += 1) {
			const line = (lines[index] || "").trim();
			const prev = (lines[index - 1] || "").trim();
			if (Boolean(line) && !/^\|/u.test(line) && line.endsWith("|") && (line.match(/\|/gu) || []).length === 1 && !/^#{1,6}\s/u.test(line) && MARKDOWN_TABLE_ROW_RE.test(prev)) issues.push({
				level: "error",
				message: `表格断行残片：${line}`,
				suggestion: "该行是表格数据行整列丢失的残片：合并回所属表格行并补齐缺失列，或删除该残行。"
			});
		}
	}
	if (/按审批确认执行/u.test(markdown)) issues.push({
		level: "error",
		message: "表格存在自动兜底污染内容：按审批确认执行",
		suggestion: "正式投标表格不得使用通用兜底短语，应保留真实业务内容或删除该行。"
	});
	const basicInfoTableBlocks = [];
	for (const match of markdown.matchAll(/\|\s*信息项\s*\|\s*内容\s*\|/gu)) {
		const rest = markdown.slice(match.index || 0);
		const tableLines = [];
		for (const line of rest.split(LINE_SPLIT_RE)) {
			if (tableLines.length > 0 && !MARKDOWN_TABLE_ROW_RE.test(line)) break;
			tableLines.push(line);
		}
		basicInfoTableBlocks.push(tableLines.join("\n"));
	}
	const duplicatedBasicInfoTableCount = basicInfoTableBlocks.filter((block) => /项目名称|招标人|建设单位|发包人|建设地点|招标范围|计划工期|合同估算价|质量标准/u.test(block)).length;
	if (duplicatedBasicInfoTableCount > 1) issues.push({
		level: "error",
		message: `项目基础信息类表格重复：${duplicatedBasicInfoTableCount} 处`,
		suggestion: "项目名称、招标人、建设地点、工期、质量等基础信息只能集中输出一次。"
	});
	const repeatedDividerRows = markdown.match(/^\|\s*---\s*\|\s*---\s*\|\s*$/gmu) || [];
	if (repeatedDividerRows.length > 60) issues.push({
		level: "error",
		message: `表格分隔线异常重复：${repeatedDividerRows.length} 行`,
		suggestion: "请修复表格规范化逻辑，禁止把数据行拆成多个碎表。"
	});
	for (const block of markdownTables(markdown)) {
		const rows = block.split(LINE_SPLIT_RE).filter((line) => MARKDOWN_TABLE_ROW_RE.test(line));
		if (rows.length < 2) continue;
		if (!MARKDOWN_TABLE_DIVIDER_RE.test(rows[1] || "")) {
			issues.push({
				level: "error",
				message: `表格分隔线位置不规范：${rows[0] || ""}`,
				suggestion: "Markdown 表格必须紧跟表头输出分隔线，例如 |---|---|，中间不得插入正文或其他管道行。"
			});
			continue;
		}
		const cells = rows.map((line) => line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split(/(?<!\\)\|/u).map((cell) => stripTableCellInvisibleChars(cell.trim())));
		const header = cells[0] || [];
		const genericHeaders = header.filter((cell) => /^(?:列|字段|内容|备注)\d+$/u.test(cell));
		if (genericHeaders.length > 0) issues.push({
			level: "error",
			message: `表格存在泛化表头：${genericHeaders.join("、")}`,
			suggestion: "正式投标表格必须使用业务字段表头，不得出现“列5/字段1/内容2”等临时表头。"
		});
		const expectedColumns = header.length;
		if (cells.find((row, rowIndex) => rowIndex !== 1 && row.length !== expectedColumns)) issues.push({
			level: "error",
			message: `表格列数不一致：${header.join("、")}`,
			suggestion: "请统一表头和数据行列数；不应通过自动填充兜底词修补表格。"
		});
		const dataRows = cells.slice(2);
		const emptyCellRow = dataRows.find((row) => row.some((cell) => cell === ""));
		if (emptyCellRow) issues.push({
			level: "error",
			message: `表格存在空单元格：${header.join("、")}（“${emptyCellRow[0] || ""}”行）`,
			suggestion: "正式交付表格不得出现空单元格；缺失数据应从资料补齐或按业务口径填写具体值，不得留空。"
		});
		const placeholderCellRow = dataRows.find((row) => row.some((cell, cellIndex) => isNonExemptTablePlaceholderCell(cell, {
			rowFirstCell: row[0] || "",
			headerCell: header[cellIndex],
			cellIndex
		})));
		if (placeholderCellRow) {
			const placeholderCell = placeholderCellRow.find((cell, cellIndex) => isNonExemptTablePlaceholderCell(cell, {
				rowFirstCell: placeholderCellRow[0] || "",
				headerCell: header[cellIndex],
				cellIndex
			})) || "";
			issues.push({
				level: "error",
				message: `表格存在占位符单元格：${header.join("、")}（“${placeholderCellRow[0] || ""}”行“${placeholderCell}”）`,
				suggestion: "正式交付表格不得用“—/若干/约/待定”等占位或模糊表达代替具体数据；应从资料补齐具体数值。"
			});
		}
	}
	return issues;
}
function normalizedFactValue(fact) {
	return `${fact.fieldName || fact.key} ${stringifyFactValue(fact.value)}`.replace(/\s+/gu, " ").trim();
}
function durationValues(text) {
	const values = /* @__PURE__ */ new Set();
	for (const pattern of [
		/\d+\s*日历天(?!内)/gu,
		/(?:计划工期|合同工期|总工期|工期|施工周期)[^\n。；;]{0,12}\d+\s*天/gu,
		/(?:计划工期|合同工期|总工期|工期|施工周期)[^\n。；;]{0,12}\d+\s*(?:个月|月)/gu
	]) for (const match of text.matchAll(pattern)) {
		const value = match[0].match(/\d+\s*(?:日历天|天|个月|月)/u)?.[0]?.replace(/\s+/gu, "");
		if (value) values.add(value);
	}
	return [...values];
}
async function buildScaleGapGate(embedDocuments) {
	return buildSemanticGate({
		prototypes: [...SCALE_GAP_SEMANTIC_PROTOTYPES],
		negativePrototypes: [...SCALE_GAP_LEGAL_PROTOTYPES],
		embedDocuments
	});
}
async function buildCostGapGate(embedDocuments) {
	return buildSemanticGate({
		prototypes: [...COST_GAP_SEMANTIC_PROTOTYPES],
		negativePrototypes: [...COST_GAP_LEGAL_PROTOTYPES],
		embedDocuments
	});
}
async function scopedNumericEntries(text, scopeRe, unitRe, gapWords, prefixWords, gapGate) {
	const entries = [];
	const skipped = [];
	const seen = /* @__PURE__ */ new Set();
	const pattern = new RegExp(`(?:${scopeRe.source})(?:[^\\n。；;，,]{0,14}?)(\\d{2,}(?:[.,]\\d+)?\\s*万?)\\s*(${unitRe.source})`, "giu");
	const matches = [...text.matchAll(pattern)];
	const uncertain = gapGate ? matches.filter((match) => {
		const gap = match[0].slice(0, match[0].indexOf(match[1]));
		const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
		return !(gapWords && gapWords.test(gap) || prefixWords && prefixWords.test(prefix));
	}).map((match) => {
		const gap = match[0].slice(0, match[0].indexOf(match[1]));
		const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
		return {
			index: match.index ?? 0,
			context: `${prefix}${gap}`.replace(/\s+/gu, "").slice(-24)
		};
	}) : [];
	const uncertainFlags = uncertain.length > 0 ? await gapGate(uncertain.map((item) => item.context)) : [];
	const semanticSkip = new Set(uncertain.filter((_, index) => uncertainFlags[index]).map((item) => item.index));
	for (const match of matches) {
		const value = match[1].replace(/[,，]/gu, "").replace(/\s+/gu, "");
		const unit = match[2];
		const gap = match[0].slice(0, match[0].indexOf(match[1]));
		const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
		if (gapWords && gapWords.test(gap) || prefixWords && prefixWords.test(prefix) || semanticSkip.has(match.index ?? 0)) {
			skipped.push({
				value,
				unit,
				scope: match[0].slice(0, gap.length).replace(/\s+/gu, ""),
				context: `${prefix}${gap}`.replace(/\s+/gu, "").slice(-24)
			});
			continue;
		}
		const scope = match[0].match(scopeRe)?.[0] || "";
		const key = `${value}|${unit}`;
		if (!value || seen.has(key)) continue;
		seen.add(key);
		entries.push({
			value,
			unit,
			scope
		});
	}
	return {
		entries,
		skipped
	};
}
function resolveScaleExpectation(text, scaleGapGate) {
	return scopedNumericEntries(text, SCALE_SCOPE_RE, SCALE_UNIT_RE, SCALE_GAP_WORDS_RE, SCALE_PREFIX_WORDS_RE, scaleGapGate).then(({ entries }) => {
		const areaEntry = entries.find((entry) => entry.scope.replace(/^总/u, "") === "建筑面积");
		if (/占地|用地/u.test(text)) return areaEntry;
		return entries[0];
	});
}
function scaledNumericValue(entry) {
	const normalized = entry.value.replace(/[,，]/gu, "").trim();
	const wan = /^([\d.]+)万/u.exec(normalized);
	const base = wan ? Number(wan[1]) * 1e4 : Number(normalized);
	if (!Number.isFinite(base)) return NaN;
	if (/亿元/u.test(entry.unit)) return base * 1e8;
	if (/万元/u.test(entry.unit)) return base * 1e4;
	return base;
}
async function crossChapterConsistencyIssues(markdown, factsModel, scopeConflicts, analyses, embedDocuments) {
	const issues = [];
	const scaleGapGate = await buildScaleGapGate(embedDocuments);
	const costGapGate = await buildCostGapGate(embedDocuments);
	const scopeWinner = (kind) => scopeConflicts?.find((conflict) => conflict.kind === kind && conflict.resolution && conflict.confidence !== "low")?.resolution;
	const numericEntryFromResolution = (resolution) => {
		const match = /(\d+(?:\.\d+)?)\s*(㎡|m²|m2|平方米|万元|亿元)/u.exec(resolution);
		return match ? {
			value: match[1],
			unit: match[2]
		} : void 0;
	};
	const expectedSchedule = scopeWinner("duration") ?? factsModel.schedule.map(normalizedFactValue).find((value) => /\d+\s*(?:日历天|天|个月|月)|计划工期|合同工期/u.test(value));
	const expectedQuality = factsModel.quality.map(normalizedFactValue).find((value) => /质量|合格|优良/u.test(value));
	if (expectedSchedule) {
		const expectedDuration = durationValues(expectedSchedule)[0];
		const nonTableMarkdown = markdown.split("\n").filter((line) => !/^\s*\|/u.test(line.trim())).join("\n");
		const durationConflictRe = /(?:计划工期|合同工期|总工期|工期|施工周期)[^\d。；;\n|]{0,18}(\d{1,4})\s*日历天/gu;
		const conflicting = [];
		for (const match of nonTableMarkdown.matchAll(durationConflictRe)) {
			const context = nonTableMarkdown.slice(Math.max(0, (match.index || 0) - 8), match.index || 0) + match[0];
			if (/顺延|延长|展期|不超过|不大于|最多|累计|第\d+日/u.test(context)) continue;
			if (/基坑|支护|桩基|土方|基础|主体|装饰|装修|安装|室外|分项|分阶段|阶段|关键线路|单层|每层|地下室|砌体|二次结构|收尾|调试/u.test(context)) continue;
			const value = `${match[1]}日历天`;
			if (value !== expectedDuration && !conflicting.includes(value)) conflicting.push(value);
		}
		if (expectedDuration && conflicting.length >= 1) issues.push({
			level: "error",
			severity: "blocker",
			category: "fact_consistency",
			owner: "llm",
			repairability: "llm_repairable",
			message: `跨章一致性冲突：正文出现与资料工期不一致的表述 ${conflicting.slice(0, 6).join("、")}`,
			suggestion: `请统一使用资料中的工期口径：${expectedSchedule}`
		});
	}
	if (expectedQuality && !/质量标准|质量目标|合格|优良/u.test(markdown)) {
		if (!(analyses && [...analyses.values()].some((analysis) => analysis.contentNeeds.quality))) issues.push({
			level: "error",
			message: "跨章一致性缺口：正文未稳定体现资料中的质量目标",
			suggestion: `请在工程概况、质量保证和验收相关章节统一体现：${expectedQuality}`
		});
	}
	const areaResolution = scopeWinner("area");
	const scaleFactCandidates = factsModel.project.map(normalizedFactValue).filter((value) => /建设规模|建筑面积/u.test(value));
	const scaleResolutions = await Promise.all(scaleFactCandidates.map((value) => resolveScaleExpectation(value, scaleGapGate)));
	const expectedScale = areaResolution ?? scaleFactCandidates.find((_, index) => scaleResolutions[index] !== void 0);
	if (expectedScale) {
		const scaleMain = areaResolution ? numericEntryFromResolution(areaResolution) : await resolveScaleExpectation(expectedScale, scaleGapGate);
		const { entries: scaleMatches, skipped: scaleSkipped } = await scopedNumericEntries(markdown, SCALE_SCOPE_RE, SCALE_UNIT_RE, SCALE_GAP_WORDS_RE, SCALE_PREFIX_WORDS_RE, scaleGapGate);
		if (scaleMain) {
			const scaleConflicts = scaleMatches.filter((entry) => scaledNumericValue(entry) !== scaledNumericValue(scaleMain));
			if (scaleConflicts.length >= 1) issues.push({
				level: "error",
				message: `跨章一致性冲突：正文出现与资料建设规模不一致的表述 ${scaleConflicts.slice(0, 6).map((entry) => `${entry.value}${entry.unit}`).join("、")}`,
				suggestion: `请统一使用资料中的建设规模口径：${expectedScale.slice(0, 80)}`
			});
		}
		if (scaleSkipped.length > 0) {
			const cardParts = [areaResolution ? `建筑总量裁决值：${areaResolution}` : "", ...factsModel.project.map(normalizedFactValue).filter((value) => /建设规模|建筑面积|占地/u.test(value)).slice(0, 3)].filter(Boolean);
			issues.push({
				level: "warning",
				severity: "warning",
				category: "fact_consistency",
				owner: "llm",
				repairability: "llm_repairable",
				message: `规模口径复核：正文 ${scaleSkipped.slice(0, 3).map((item) => `“${item.context.slice(-14)}${item.value}${item.unit}”`).join("、")} 等 ${scaleSkipped.length} 处数值与口径词之间混入子项/专项口径词，需核对口径归属`,
				suggestion: `依据项目规模事实卡逐处核对该数值的口径归属（${cardParts.join("；") || "无可用事实卡，以绑定资料原文为准"}）：与事实卡对应口径一致的数值保留原样，口径错位或数值不一致的数值改正为事实卡对应口径值，不得把子项/专项口径数值改成建筑总量数值。`
			});
		}
	}
	const costResolution = scopeWinner("cost");
	const expectedCost = costResolution ?? factsModel.project.map(normalizedFactValue).find((value) => /合同估算|投资估算|最高投标限价|招标控制价|总投资|工程造价/u.test(value));
	if (expectedCost) {
		const costMain = costResolution ? numericEntryFromResolution(costResolution) : (await scopedNumericEntries(expectedCost, COST_SCOPE_RE, COST_UNIT_RE, COST_GAP_WORDS_RE, void 0, costGapGate)).entries[0];
		const costMatches = (await scopedNumericEntries(markdown, COST_SCOPE_RE, COST_UNIT_RE, COST_GAP_WORDS_RE, void 0, costGapGate)).entries;
		if (costMain) {
			const costConflicts = costMatches.filter((entry) => scaledNumericValue(entry) !== scaledNumericValue(costMain));
			if (costConflicts.length >= 1) issues.push({
				level: "error",
				message: `跨章一致性冲突：正文出现与资料估算价不一致的表述 ${costConflicts.slice(0, 6).map((entry) => `${entry.value}${entry.unit}`).join("、")}`,
				suggestion: `请统一使用资料中的估算价口径：${expectedCost.slice(0, 80)}`
			});
		}
	}
	const equipmentMatches = /* @__PURE__ */ new Map();
	for (const claim of scanEquipmentCountClaims(markdown)) {
		if (isUnitPairRatioMatch(markdown, claim.start, claim.text)) continue;
		const equipment = claim.name;
		const value = String(claim.count);
		const context = markdown.slice(Math.max(0, claim.start - 20), claim.start + claim.raw.length);
		const key = /组|本组|每组|村/u.test(context) ? `${equipment}@group` : equipment;
		const list = equipmentMatches.get(key) || [];
		if (!list.includes(value)) list.push(value);
		equipmentMatches.set(key, list);
	}
	for (const [key, values] of equipmentMatches) {
		if (values.length < 2) continue;
		const isGroup = key.endsWith("@group");
		const equipment = key.replace(/@group$/u, "");
		const conflictText = values.join("、");
		if (isGroup) issues.push({
			level: "warning",
			severity: "warning",
			category: "fact_consistency",
			owner: "llm",
			repairability: "llm_repairable",
			message: `设备分组口径提示：正文「${equipment}」存在分组配置台数 ${conflictText} 多值并存，需注明分组与全项目总量的调度关系`,
			suggestion: `分组配置（组/村级）与全项目总量并存时，必须在正文注明「本组配置、按总表调度」或明确分组数量与总量数量之间的对应关系，避免评标误读为口径矛盾。`
		});
		else issues.push({
			level: "error",
			severity: "blocker",
			category: "fact_consistency",
			owner: "llm",
			repairability: "llm_repairable",
			message: `跨章一致性冲突：正文「${equipment}」配置台数出现互相矛盾的取值 ${conflictText}`,
			suggestion: `全项目「${equipment}」配置总量必须全文唯一：以全项目机械配置总表为准统一全部表述；分组配置必须显式注明「本组配置、按总表调度」并删除与总表矛盾的全项目口径数字。`
		});
	}
	for (const { label, re, contextAware } of [{
		label: "隔油池数量",
		re: /隔油池[^\d。；;\n|：:，,、]{0,6}(\d+)\s*座/gu
	}, {
		label: "挖沟槽土方",
		re: /挖沟槽[^\d。；;\n|]{0,15}([\d,]+(?:\.\d+)?)\s*m[³3]/gu,
		contextAware: true
	}]) {
		const entries = [];
		for (const match of markdown.matchAll(re)) {
			const value = match[1].replace(/,/gu, "");
			if (entries.some((entry) => entry.value === value)) continue;
			entries.push({
				value,
				context: markdown.slice(Math.max(0, (match.index || 0) - 24), match.index || 0)
			});
		}
		if (entries.length >= 2) {
			if (contextAware && entries.every((left, index) => entries.slice(index + 1).every((right) => longestCommonHanSubstring(left.context, right.context) < 6))) continue;
			const values = entries.map((entry) => entry.value).join("、");
			issues.push({
				level: "error",
				severity: "blocker",
				category: "fact_consistency",
				owner: "llm",
				repairability: "llm_repairable",
				message: `跨章一致性冲突：正文${label}出现互相矛盾的取值 ${values}`,
				suggestion: `${label}必须全文唯一：以工程量清单为最高优先级裁定正确值，将正文全部相关表述统一为该值，并删除其余矛盾口径。`
			});
		}
	}
	if (expectedSchedule) {
		const expectedDurationForStage = durationValues(expectedSchedule)[0];
		const expectedDays = Number(/(\d+)\s*(?:日历天|天)/u.exec(expectedDurationForStage || "")?.[1]);
		for (const match of markdown.matchAll(/各阶段工期(?:分别)?为?\s*[：:]?\s*([\d]+(?:\s*[、,，]?\s*\d+)*)\s*(?:天|日历天)/gu)) {
			const sum = match[1].split(/[、,，]/u).map((part) => Number(part.trim())).filter((value) => Number.isFinite(value)).reduce((total, value) => total + value, 0);
			if (Number.isFinite(expectedDays) && sum > 0 && sum !== expectedDays) issues.push({
				level: "error",
				severity: "blocker",
				category: "fact_consistency",
				owner: "llm",
				repairability: "llm_repairable",
				message: `跨章一致性冲突：正文各阶段工期文字表述（${match[1]}天）合计 ${sum} 天，与总工期 ${expectedDays} 天不符`,
				suggestion: `各阶段工期加总必须等于总工期 ${expectedDays} 天：核对各阶段天数并修正文字表述，或与阶段计划表保持一致。`
			});
		}
	}
	for (const match of markdown.matchAll(/每间(?:可)?容纳\s*(\d+)\s*人/gu)) {
		const capacity = Number(match[1]);
		if (capacity >= 100) issues.push({
			level: "error",
			severity: "blocker",
			category: "fact_consistency",
			owner: "llm",
			repairability: "llm_repairable",
			message: `逻辑校验失败：正文出现「每间容纳 ${capacity} 人」的宿舍配置表述，单间宿舍不可能容纳 100 人以上`,
			suggestion: `宿舍容纳人数按单间 4~8 人配置计算间数（如高峰 216 人按每间 8 人需 27 间），修正配置表述为「每间 X 人、共 Y 间，满足高峰在场人数」的完整口径。`
		});
	}
	for (const match of markdown.matchAll(/第(\d+)\s*日\s*[~～—至到]\s*第(\d+)\s*日/gu)) if (match[1] === match[2]) issues.push({
		level: "error",
		severity: "blocker",
		category: "fact_consistency",
		owner: "llm",
		repairability: "llm_repairable",
		message: `逻辑校验失败：正文出现「第 ${match[1]} 日～第 ${match[2]} 日」的零长度区间表述`,
		suggestion: `起止日相同的区间属笔误：按该事项所属施工阶段的实际起止日修正（如进场时间应为阶段开始前）。`
	});
	return issues;
}
/** D-T1 章级补写靶线：资源类章（机械设备/劳动力计划）对齐验收判据 ≥10/12（r28f 实机 2/12、
* 4/12 根治标靶），其余章统一 PROFESSIONAL_SCORE_LINE；检测报出与修复复检同源消费 */
function professionalScoreTargetLine(title) {
	if (/资源|材料|设备|劳动力/u.test(title)) return 10;
	return 8;
}
/** 六维评分单源（覆盖维度数 ×2 = 12 分制总分；检测报出/修复复检共用，禁止第二份打分口径） */
function professionalDepthTotal(dimensions) {
	return DEPTH_DIMENSION_ORDER.filter((dimension) => dimensions[dimension]).length * 2;
}
/** 薄弱维度单源（未覆盖维度按序提取；空数组表示六维全覆盖） */
function professionalWeakDimensions(dimensions) {
	return DEPTH_DIMENSION_ORDER.filter((dimension) => !dimensions[dimension]);
}
/** 任务卡焦点表（按章类型给出补写方向；低于补写线的章随 issue suggestion 注入修复指令） */
function professionalScoreFocus(title) {
	if (/概况|工程|项目/u.test(title)) return "事实依据、项目特异性";
	if (/部署|总体|组织/u.test(title)) return "组织结构、可执行闭环、跨章一致性";
	if (/进度|工期/u.test(title)) return "进度结构、工期一致性、纠偏机制";
	if (/质量/u.test(title)) return "质量深度、验收复验、资料闭环";
	if (/安全|文明|危大|风险/u.test(title)) return "风险覆盖、应急响应、检查整改";
	if (/资源|材料|设备|劳动力/u.test(title)) return "资源依据、进场调配、进度支撑";
	return "事实依据、专业深度、可执行性";
}
function professionalScoreIssues(chapters, analyses) {
	const issues = [];
	for (const chapter of chapters) {
		const text = chapter.content;
		if (documentTextLength(text) < 800) continue;
		const focus = professionalScoreFocus(chapter.title);
		const analysis = analyses?.get(chapter.title);
		if (!analysis) continue;
		const total = professionalDepthTotal(analysis.dimensions);
		if (total < professionalScoreTargetLine(chapter.title)) {
			const weak = professionalWeakDimensions(analysis.dimensions).join("、") || focus;
			issues.push({
				level: "warning",
				message: `${chapter.title} 专业评分不足：${total}/12，薄弱维度：${weak}`,
				suggestion: `请按章节任务卡补齐${focus}，并写出资料依据、实施流程、专业控制点和检查整改闭环。`,
				chapterId: chapter.id,
				provenance: {
					detectorId: "professional-score",
					fingerprint: stableHash(`${chapter.title}\u0000${total}`)
				}
			});
		}
	}
	return issues;
}
function formalPlaceholderIssues(markdown) {
	const issues = [];
	if (/【本小节生成未达标，需重新生成】/u.test(markdown)) issues.push({
		level: "error",
		message: "生成未完成：存在未达标小节，需要重新生成或补写后才能导出",
		suggestion: "请重新生成未达标小节，禁止将占位内容作为正式正文。"
	});
	for (const pattern of FORMAL_PLACEHOLDER_PATTERNS) if (pattern.test(markdown)) issues.push({
		level: "warning",
		message: `存在占位式表达：${pattern.source}`,
		suggestion: "请改写为来自资料的准确事实；资料确实未提供时，改写为正式管理措施，不留空值或“见资料/按文件”。"
	});
	const tablePlaceholderHits = scanTablePlaceholderCells(markdown);
	if (tablePlaceholderHits.length > 0) {
		const first = tablePlaceholderHits[0];
		issues.push({
			level: "warning",
			message: `存在占位式表达：表格数据格占位符（${first.header.join("、")}“${first.rowFirstCell}”行“${first.cell}”）共 ${tablePlaceholderHits.length} 处`,
			suggestion: "请改写为来自资料的准确事实；资料确实未提供时，改写为正式管理措施，不留空值或“见资料/按文件”。"
		});
	}
	return issues;
}
var SCALE_GAP_WORDS_RE, SCALE_PREFIX_WORDS_RE, COST_GAP_WORDS_RE, SCALE_GAP_SEMANTIC_PROTOTYPES, SCALE_GAP_LEGAL_PROTOTYPES, COST_GAP_SEMANTIC_PROTOTYPES, COST_GAP_LEGAL_PROTOTYPES, SCALE_SCOPE_RE, SCALE_UNIT_RE, COST_SCOPE_RE, COST_UNIT_RE, DEPTH_DIMENSION_ORDER;
var init_qualityValidation = __esmMin((() => {
	init_constants();
	init_semanticSimilarity();
	init_budget();
	init_documentFactTrace();
	init_outline$1();
	init_markdownComposer();
	init_markdownCleanup();
	init_drawingFactLock();
	init_resourceBreakdownNumbers();
	init_factMatching();
	init_templateStore();
	init_utils();
	init_writingSpec();
	init_tenderBidChecks();
	init_semanticGate();
	init_numericalConsistency();
	init_detectors();
	SCALE_GAP_WORDS_RE = /占地|用地|地下|地上|办公|生活|附属|辅助|绿化|道路|广场|门卫|配电|泵房|锅炉房|车库|车棚|岗亭|传达|警卫|样板房|售楼|门房|单栋|各栋|楼层|每层|单层|架空|雨棚|堆场/u;
	SCALE_PREFIX_WORDS_RE = /办公区|生活区|加工区|施工区|堆场|门卫|配电|泵房|锅炉房|车库|车棚|岗亭|传达|警卫|样板房|售楼|门房|地下室|楼层|单层|每层|架空|雨棚/u;
	COST_GAP_WORDS_RE = /暂列|暂估|费率|税率|利润|规费|安全文明|措施费|人工费|材料费|机械费|管理费|暂定/u;
	SCALE_GAP_SEMANTIC_PROTOTYPES = [
		"地下建筑面积与地上建筑面积的分项指标",
		"配套用房与附属用房的建筑面积",
		"占地面积与绿化面积的用地指标"
	];
	SCALE_GAP_LEGAL_PROTOTYPES = ["总建筑面积的总体规模指标", "建设规模的总量数值"];
	COST_GAP_SEMANTIC_PROTOTYPES = ["暂列金额与暂估价的子项费用", "人工费与材料费的分项费用"];
	COST_GAP_LEGAL_PROTOTYPES = ["合同估算价的总金额口径", "投资估算的总体金额"];
	SCALE_SCOPE_RE = /(?<![地上地下门卫室值班室配电室配电房泵房水泵房锅炉房公厕车库车棚岗亭传达室警卫室样板房售楼处门房])总?建筑面积|总?建设规模/u;
	SCALE_UNIT_RE = /㎡|m²|m2|平方米/u;
	COST_SCOPE_RE = /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价|工程总投资|总投资|工程造价/u;
	COST_UNIT_RE = /万元|亿元/u;
	DEPTH_DIMENSION_ORDER = [
		"factuality",
		"structure",
		"depth",
		"executable",
		"specificity",
		"consistency"
	];
}));
//#endregion
export { parameterConceptConflictIssues as A, upsertGeneratedDocumentAsset as C, buildProfessionalDepthClassifier as D, previewGenerationBudgetForTemplate as E, init_factReconciliation as M, init_professionalDepthClassifier as O, upsertGeneratedAssets as S, init_generationBudget as T, getQueuedDocumentPosition as _, professionalScoreIssues as a, listGeneratedDocuments as b, init_detectors as c, resourceConsistencyIssues as d, selfUnderminingCandidateIssues as f, getGeneratedDocument as g, generatedRoot as h, markdownTableQualityIssues as i, factReconciliationIssues as j, init_parameterConceptConflicts as k, laborPeakConflictIssues as l, waterLaborPeakAssociationIssues as m, formalPlaceholderIssues as n, ambiguousEitherOrIssues as o, specLocationMismatchIssues as p, init_qualityValidation as r, crossSectionNumericConflictIssues as s, crossChapterConsistencyIssues as t, nodeScheduleConsistencyIssues as u, init_generatedDocumentService as v, buildGenerationBudget as w, saveGeneratedDocument as x, listGeneratedAssets as y };
