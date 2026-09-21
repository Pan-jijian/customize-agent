import "node:fs";
import "node:path";
import { createHash } from "node:crypto";
import "node:os";
import { loadBetterSqlite3 } from "@customize-agent/knowledge";
import * as path$1 from "path";
import * as os$1 from "os";
import * as fs$1 from "fs";
import "@customize-agent/llm";
import "@customize-agent/runtime";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
//#region apps/server/src/services/document-workflow/composeAppendices.ts
/** 单元格清洗：竖线替换全角（防破坏表格结构）+ 断词空格清理 */
function cleanCell(value) {
	return (value || "").replace(/\|/gu, "／").replace(CJK_SPACE_RE, "$1").trim();
}
/** markdown 表格渲染 */
function renderTable(header, rows) {
	return [
		`| ${header.map(cleanCell).join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.map(cleanCell).join(" | ")} |`)
	];
}
/** 数量口径渲染（quantity 优先；否则 min-max 区间；无数据 → —） */
function quantityText(item) {
	if (typeof item.quantity === "number" && item.quantity > 0) return String(item.quantity);
	const { min, max } = item;
	if (typeof min === "number" && typeof max === "number") return min === max ? String(min) : `${min}-${max}`;
	if (typeof min === "number") return String(min);
	if (typeof max === "number") return String(max);
	return DASH;
}
/** 数据缺口骨架：编制说明 + 招标表头（不造数据；说明为投标人视角中性表述，无内部流程话术） */
function appendixGapSkeleton(header, gapLabel) {
	return [
		`> 本表为${gapLabel}，按招标文件规定的表头格式编制。`,
		"",
		...renderTable(header, [])
	];
}
/** 设备附表：拟投入本标段的主要施工设备表（蓝图 resources.equipment 直出；备注列承载蓝图依据） */
function renderEquipmentAppendix(data) {
	const items = data?.resources?.equipment || [];
	if (items.length === 0) return appendixGapSkeleton(EQUIPMENT_HEADER, "施工设备配置");
	return renderTable(EQUIPMENT_HEADER, items.map((item, index) => [
		String(index + 1),
		item.name,
		item.spec || DASH,
		quantityText(item),
		DASH,
		DASH,
		DASH,
		DASH,
		DASH,
		item.basis || DASH
	]));
}
/** 劳动力附表：劳动力计划表（蓝图 resources.labor 直出：工种配置 + 分阶段投入两小节，口径同源） */
function renderLaborAppendix(data) {
	const composition = data?.resources?.labor?.composition || [];
	const byPhase = data?.resources?.labor?.byPhase || [];
	if (composition.length === 0 && byPhase.length === 0) return [
		"> 本表为劳动力配置数据，按招标文件规定的表头格式编制。",
		"",
		...renderTable([
			"工种",
			"人数",
			"备注"
		], [])
	];
	const parts = [];
	if (composition.length > 0) parts.push("**（一）劳动力工种配置**", "", ...renderTable([
		"工种",
		"人数",
		"备注"
	], composition.map((item) => [
		item.trade,
		String(item.count),
		item.basis || DASH
	])));
	if (byPhase.length > 0) {
		if (parts.length > 0) parts.push("");
		parts.push("**（二）分阶段劳动力投入计划**", "", ...renderTable([
			"施工阶段",
			"人数",
			"备注"
		], byPhase.map((item) => [
			item.phase,
			quantityText(item),
			item.basis || DASH
		])));
	}
	return parts;
}
/** C2 附表二：试验检测仪器配置表（蓝图 testInstruments 直出；产地/年份/台时数为投产信息，如实留空不编造） */
function renderInstrumentAppendix(data) {
	const items = data?.testInstruments || [];
	if (items.length === 0) return appendixGapSkeleton(INSTRUMENT_HEADER, "试验检测仪器配置");
	return renderTable(INSTRUMENT_HEADER, items.map((item, index) => [
		String(index + 1),
		item.name,
		item.spec || DASH,
		quantityText(item),
		DASH,
		DASH,
		DASH,
		item.purpose || DASH,
		item.basis || DASH
	]));
}
/** C2 附表四：进度计划表（图类附表表格化：图件说明 + 工序数据表，图件按表绘制）。
* 数据源 schedule 由里程碑顺序累加推导（起止天序）；无数据时保留图件说明（不造数据）。 */
function renderScheduleAppendix(data) {
	const note = "> **图件说明**：本附表以施工进度网络图（或以横道图）形式表达，标明计划开工日期、竣工日期及各关键日期节点；工序逻辑与工期安排与本施工组织设计进度计划一致，图件按下列工序数据表绘制。";
	const items = data?.schedule || [];
	if (items.length === 0) return [note];
	return [
		note,
		"",
		...renderTable(SCHEDULE_HEADER, items.map((item) => [
			item.label,
			String(item.duration),
			`第${item.startDay}～${item.endDay}天`,
			item.critical ? "关键线路" : "非关键线路",
			item.basis || DASH
		]))
	];
}
/** C2 附表五：施工总平面设施数据表（图类附表表格化：图件说明 + 设施数据表，图件按表绘制） */
function renderSiteFacilityAppendix(data) {
	const note = "> **图件说明**：本附表为施工总平面布置图，反映现场临时设施布置（含加工车间、现场办公、设备及仓储、供电、供水、卫生、生活、道路、消防等设施）；图件按下列设施数据表绘制，并附相应文字说明。";
	const items = data?.tempLand || [];
	if (items.length === 0) return [note];
	return [
		note,
		"",
		...renderTable(SITE_FACILITY_HEADER, items.map((item) => [
			item.purpose,
			typeof item.area === "number" ? String(item.area) : DASH,
			item.location || DASH,
			item.note || DASH
		]))
	];
}
/** C2 附表六：临时用地表（蓝图 tempLand 直出；表头按招标原文格式，需用时间列取设施时长口径） */
function renderTempLandAppendix(data) {
	const items = data?.tempLand || [];
	if (items.length === 0) return appendixGapSkeleton(TEMP_LAND_HEADER, "临时用地规划");
	return renderTable(TEMP_LAND_HEADER, items.map((item) => [
		item.purpose,
		typeof item.area === "number" ? String(item.area) : DASH,
		item.location || DASH,
		item.duration || DASH
	]));
}
/** 图类附表（进度网络图/总平面图）：图件说明（投标人视角，零内部流程话术） */
function graphAppendixNote(name) {
	if (/进度网络图|施工进度网络图|横道图/u.test(name)) return ["> **图件说明**：本附表以施工进度网络图（或以横道图）形式表达，标明计划开工日期、竣工日期及各关键日期节点，工序逻辑与工期安排与本施工组织设计进度计划一致。"];
	if (/总平面/u.test(name)) return ["> **图件说明**：本附表为施工总平面布置图，反映现场临时设施布置（含加工车间、现场办公、设备及仓储、供电、供水、卫生、生活、道路、消防等设施）并附相应文字说明。"];
	return ["> **图件说明**：本附表为图件类附表，按招标文件规定的格式与内容要求以图件形式呈现。"];
}
/** 单条附表渲染（按数据源与 kind 绑定分发；C2：四附表数据化，图类附表表格化落位；
* 无法识别的表类附表输出按招标格式编制标注，不猜表头） */
function renderAppendixEntry(entry, data) {
	switch (entry.dataSource) {
		case "blueprint.equipment": return renderEquipmentAppendix(data);
		case "blueprint.labor": return renderLaborAppendix(data);
		case "blueprint.testInstruments": return renderInstrumentAppendix(data);
		case "blueprint.schedule": return renderScheduleAppendix(data);
		case "blueprint.tempLand": return entry.kind === "figure" ? renderSiteFacilityAppendix(data) : renderTempLandAppendix(data);
		default:
			if (entry.kind === "figure") return graphAppendixNote(entry.title);
			return ["> 本附表按招标文件规定的格式与内容要求编制。"];
	}
}
/**
* C2 D4：附表区内部推导话术确定性清洗（幂等）——作用于「## 附表…」起的文末附表区。
* ①中性化映射（单元格/文本级）：唯一口径/经验工效区间/清单批注/附加工程量 → 中性表述或移除；
* ②管理流程句移除（行级）：岗位+频次模式不进附表区。
* 清洗后不引入新事实；无附表区或未命中时原样返回（可重入）。
*/
function cleanAppendixInternalPhrases(markdown) {
	const start = markdown.search(/^##\s*附表/mu);
	if (start < 0) return markdown;
	const head = markdown.slice(0, start);
	let zone = markdown.slice(start);
	zone = zone.split(NL).map((line) => /^#{1,6}\s/u.test(line.trim()) ? line : line.replace(CJK_SPACE_RE, "$1")).join(NL);
	for (const rule of APPENDIX_NEUTRALIZE_RULES) zone = zone.replace(rule.pattern, rule.replace);
	for (const rule of APPENDIX_FLOW_SENTENCE_RULES) zone = zone.replace(rule.pattern, rule.replace);
	zone = zone.replace(/^>\s*$/gmu, "");
	zone = zone.replace(/\n{3,}/gu, `${NL}${NL}`);
	return head + zone;
}
/**
* 文末附表区：按招标附表清单（appendixPlan）逐项直出「附表N 名称」+ 数据内容/表头骨架/图件说明。
* 数据源为一体化蓝图；蓝图无数据源的附表按招标表头生成骨架并显性标注缺口（不造数据）。
* C2 D4：出口整体过清洗器（源头净版），链尾另有 delivery-structure-closure 兜底复洗（幂等）。
*/
function composeTenderAppendixMarkdown(plan, blueprintData) {
	const sections = [];
	for (const entry of plan) {
		const body = renderAppendixEntry(entry, blueprintData);
		if (body && body.length > 0) sections.push([
			`## ${entry.title}`,
			"",
			...body
		].join(NL));
	}
	if (sections.length === 0) return "";
	return cleanAppendixInternalPhrases(sections.join(`${NL}${NL}`));
}
/** 幂等追加文末附表区（无附表清单时不改动原文；已存在相同附表标题时跳过） */
function appendTenderAppendixSections(markdown, appendix) {
	if (!appendix || appendix.plan.length === 0) return markdown;
	if (appendix.plan.some((entry) => markdown.includes(`## ${entry.title}`))) return markdown;
	const section = composeTenderAppendixMarkdown(appendix.plan, appendix.blueprintData);
	if (!section) return markdown;
	return `${markdown.replace(/\s+$/u, "")}${NL}${NL}<div class="page-break"></div>${NL}${NL}${section}${NL}`;
}
/** 表格真实数据行计数：表格块首行（表头）与分隔行之外的「有效单元格 ≥2（非空、非 —）」行；
* 全部单元格为空/— 的行不计；多表格块独立识别（如劳动力附表两小节）。 */
function countAppendixDataRows(body) {
	let inTable = false;
	let dataRows = 0;
	for (const line of body.split(NL)) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("|")) {
			inTable = false;
			continue;
		}
		if (!inTable) {
			inTable = true;
			continue;
		}
		const cells = trimmed.replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
		if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell))) continue;
		if (cells.filter((cell) => cell && cell !== DASH && cell !== "-").length >= 2) dataRows += 1;
	}
	return dataRows;
}
/**
* 附表条目承载判定（F-T2 承载率口径，C2 D1 内容级加固）：标题落位 + 内容承载——
* ①骨架说明块（「本表为…按招标文件规定的表头格式编制」+ 空表头）不计承载（缺口话术即未承载）；
* ②表类与图类统一须有 ≥2 条真实数据行（表头行/分隔行之外，有效单元格 ≥2 非空非 —）；
* ③图类纯图件说明块不计承载（C2 图类附表表格化后由数据表承载）。
*/
function appendixEntryCarried(markdown, entry) {
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
var NL, DASH, CJK_SPACE_RE, EQUIPMENT_HEADER, INSTRUMENT_HEADER, TEMP_LAND_HEADER, SCHEDULE_HEADER, SITE_FACILITY_HEADER, APPENDIX_NEUTRALIZE_RULES, APPENDIX_FLOW_SENTENCE_RULES, APPENDIX_GAP_NOTE_RE;
var init_composeAppendices = __esmMin((() => {
	NL = String.fromCharCode(10);
	DASH = "—";
	CJK_SPACE_RE = /([\u3400-\u9fff\u3000-\u303f\uff00-\uffef])[ \u3000]+(?=[\u3400-\u9fff\u3000-\u303f\uff00-\uffef])/gu;
	EQUIPMENT_HEADER = [
		"序号",
		"设备名称",
		"型号规格",
		"数量",
		"国别产地",
		"制造年份",
		"额定功率（kW）",
		"生产能力",
		"用于施工部位",
		"备注"
	];
	INSTRUMENT_HEADER = [
		"序号",
		"仪器设备名称",
		"型号规格",
		"数量",
		"国别产地",
		"制造年份",
		"已使用台时数",
		"用途",
		"备注"
	];
	TEMP_LAND_HEADER = [
		"用途",
		"面积（平方米）",
		"位置",
		"需用时间"
	];
	SCHEDULE_HEADER = [
		"工序",
		"持续天数",
		"起止天序",
		"关键线路",
		"说明"
	];
	SITE_FACILITY_HEADER = [
		"设施",
		"面积（平方米）",
		"位置",
		"说明"
	];
	APPENDIX_NEUTRALIZE_RULES = [
		{
			pattern: /工种构成唯一口径[：:]?按工种工程量区间中值比例收敛[（(][^）)]*[）)]/gu,
			replace: "按工种工程量比例配置"
		},
		{
			pattern: /阶段条目工程量约\s*[\d.]+\s*[^\s×]*\s*×\s*经验工效区间\s*÷\s*阶段\s*\d+\s*天[（(][^）)]*封顶[）)]/gu,
			replace: "按本阶段工程量及劳动力需用量测算"
		},
		{
			pattern: /工种工程量约\s*[\d.]+\s*[^\s×]*\s*×\s*经验工效区间\s*÷\s*工期\s*\d+\s*天[（(][^）)]*[）)]/gu,
			replace: "按工种工程量及劳动力需用量测算"
		},
		{
			pattern: /工种工程量约\s*[\d.]+\s*[^\s×]*\s*×\s*定额工效[^÷]*÷\s*工期\s*\d+\s*天[（(][^）)]*[）)]/gu,
			replace: "按工种工程量及定额工效测算"
		},
		{
			pattern: /[；;]\s*相关条目工程量合计约\s*[\d.]+\s*\S*/gu,
			replace: ""
		},
		{
			pattern: /[（(]清单(?:特征|条目)[）)]/gu,
			replace: ""
		},
		{
			pattern: /各工种人数区间之和\s*[\d.]+~[\d.]+\s*人[（(][^）)]*[）)]/gu,
			replace: "按各工种配置人数合计测算"
		},
		{
			pattern: /[（(]定额工效知识不全[^）)]*[）)]/gu,
			replace: ""
		},
		{
			pattern: /[（(]定额知识库命中[）)]/gu,
			replace: ""
		}
	];
	APPENDIX_FLOW_SENTENCE_RULES = [{
		pattern: /[；，,]?\s*相关内容纳入施工组织设计与作业流程管理[^。\n]*。?/gu,
		replace: ""
	}, {
		pattern: /[；，,]?\s*[^。；\n]{0,40}(?:资料员|测量员|施工员|质检员|安全员|材料员|技术员|试验员|预算员|机械员|监理员)[^。；\n]{0,40}(?:每日|每周|每月|每班|定期)[^。；\n]{0,40}。?/gu,
		replace: ""
	}];
	APPENDIX_GAP_NOTE_RE = /^>\s*本表为[^\n]*(?:表头格式|格式与内容要求)[^\n]*编制/mu;
}));
//#endregion
//#region apps/server/src/services/knowledge/kbService.ts
function getWorkspaceRoot() {
	return process.env.INIT_CWD && !isInternalResidualProject(process.env.INIT_CWD) ? process.env.INIT_CWD : path$1.resolve(process.cwd(), "../..");
}
function getStorageRoot() {
	return path$1.join(os$1.homedir(), ".customize-agent");
}
function isInternalResidualProject(projectRoot) {
	const normalized = path$1.resolve(projectRoot);
	const homeConfig = path$1.resolve(path$1.join(os$1.homedir(), ".customize-agent"));
	if (fs$1.existsSync(path$1.join(normalized, "pnpm-workspace.yaml")) && fs$1.existsSync(path$1.join(normalized, "apps", "server"))) return false;
	return normalized === homeConfig || normalized.includes(`${path$1.sep}.customize-agent${path$1.sep}`) || normalized.endsWith(`${path$1.sep}apps${path$1.sep}server`) || normalized.endsWith(`${path$1.sep}apps${path$1.sep}cli`);
}
function getKnownProjectRoots() {
	const registryPath = path$1.join(getStorageRoot(), "projects", "registry.db");
	if (!fs$1.existsSync(registryPath)) return [];
	const db = new (loadBetterSqlite3())(registryPath, { readonly: true });
	try {
		return db.prepare("SELECT project_root FROM project_registry ORDER BY last_opened_at DESC").all().map((r) => path$1.resolve(r.project_root)).filter((root) => !isInternalResidualProject(root));
	} finally {
		db.close();
	}
}
function getProjectRoot() {
	const envRoot = process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD;
	if (envRoot && fs$1.existsSync(envRoot) && !isInternalResidualProject(envRoot)) return path$1.resolve(envRoot);
	const known = getKnownProjectRoots();
	if (known.length > 0) return known[0];
	return getWorkspaceRoot();
}
var init_kbService = __esmMin((() => {}));
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
var init_constants$1 = __esmMin((() => {
	init_documentRoleConstants();
	init_engineeringTechnicalFactConstants();
	init_rolePipelineConstants();
	init_qualityValidationConstants();
}));
var init_engineeringDocumentConfigService = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-core/documentRoleService.ts
var init_documentRoleService = __esmMin((() => {
	init_constants$1();
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
//#region apps/server/src/services/document-workflow/budget.ts
function documentTextLength(markdown) {
	return markdown.replace(/<[^>]+>/gu, "").replace(/\s+/gu, "").length;
}
function parseChineseNumber(value) {
	const normalized = value.trim();
	if (/^\d+(?:\.\d+)?$/u.test(normalized)) return Number(normalized);
	const digits = {
		零: 0,
		一: 1,
		二: 2,
		两: 2,
		三: 3,
		四: 4,
		五: 5,
		六: 6,
		七: 7,
		八: 8,
		九: 9
	};
	if (normalized === "十") return 10;
	const ten = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(normalized);
	if (ten) return (ten[1] ? digits[ten[1]] : 1) * 10 + (ten[2] ? digits[ten[2]] : 0);
}
function explicitLengthMode(prefix = "", suffix = "") {
	const text = `${prefix}${suffix}`;
	if (/不少于|至少|不低于|以上|起码/u.test(text)) return "minimum";
	if (/约|大概|左右|大约|约为|附近/u.test(text)) return "approximate";
	return "exact";
}
function explicitLengthTargets(text) {
	const normalized = text.replace(/\s+/gu, " ");
	const pageMatches = [...normalized.matchAll(/(不少于|至少|不低于|约为|约|大概|大约|左右|生成|输出|达到|共)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(?:页|頁)\s*(以上|左右|以内|以下)?/gu)];
	const wordMatches = [...normalized.matchAll(/(不少于|至少|不低于|约为|约|大概|大约|左右|生成|输出|达到|共)?\s*(\d+(?:\.\d+)?|[一二两三四五六七八九十]{1,3})\s*(万)?\s*(?:字|字符)\s*(以上|左右|以内|以下)?/gu)];
	const pageTarget = pageMatches.map((match) => {
		const value = parseChineseNumber(match[2] || "");
		return Number.isFinite(value) ? {
			value,
			mode: explicitLengthMode(match[1], match[3])
		} : void 0;
	}).filter((item) => Boolean(item)).at(-1);
	const charTarget = wordMatches.map((match) => {
		const value = parseChineseNumber(match[2] || "");
		return value ? {
			value: Math.round(value * (match[3] ? 1e4 : 1)),
			mode: explicitLengthMode(match[1], match[4])
		} : void 0;
	}).filter((item) => Boolean(item)).at(-1);
	return {
		targetPages: pageTarget?.value,
		pageMode: pageTarget?.mode,
		targetChars: charTarget?.value,
		charMode: charTarget?.mode
	};
}
var init_budget = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/utils.ts
function stableHash(value) {
	return createHash("sha1").update(JSON.stringify(value)).digest("hex");
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
}));
//#endregion
//#region apps/server/src/services/document-workflow/llmClient.ts
/** 文档目标字数与全局并发上限解耦：所有规模统一使用 llmMaxConcurrency（默认无上限，env 可覆盖） */
function concurrencyForDocumentScale(_targetWords) {
	return llmMaxConcurrency;
}
var rawMaxConcurrency, envMaxConcurrency, llmMaxConcurrency;
var init_llmClient = __esmMin((() => {
	init_configService();
	init_tuningProfile();
	rawMaxConcurrency = tuningProfile().llmMaxConcurrency;
	envMaxConcurrency = Number.isFinite(rawMaxConcurrency) ? rawMaxConcurrency === 0 ? Number.POSITIVE_INFINITY : rawMaxConcurrency > 0 ? Math.floor(rawMaxConcurrency) : void 0 : void 0;
	llmMaxConcurrency = envMaxConcurrency ?? Number.POSITIVE_INFINITY;
	(() => {
		const raw = Number(process.env.DOCUMENT_PREFIX_SCHEDULE_WINDOW_MS);
		return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : void 0;
	})();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constants.ts
var CN_NUMERAL_RE;
var init_constants = __esmMin((() => {
	CN_NUMERAL_RE = "[零〇一二三四五六七八九十百千万两]+";
}));
//#endregion
//#region apps/server/src/services/document-workflow/templatingGovernance.ts
var STRUCTURE_LABEL_BAN_LINE, SKELETON_FINGERPRINT_BAN_LINE;
var init_templatingGovernance = __esmMin((() => {
	STRUCTURE_LABEL_BAN_LINE = "正文禁止以“施工概况/施工流程/施工方法/工艺流程/施工步骤”等结构标签充当小节标题或段落开头引导（不得出现“施工概况：本项目……”式标签行），要素内容直接融入连贯段落叙述。";
	SKELETON_FINGERPRINT_BAN_LINE = "句式禁止复读：全篇「由技术负责人组织」「合格后方可」「验收合格后」三类骨架表述各自不得超过 2 次，任何同义替换表达全篇不得超过 8 次；同义表达必须逐句轮换、句式多样（动词与语序随句变化），不得集中复用同一说法，保持事实不变（岗位、数值、频次不得丢失）。";
}));
/** 复选框/对勾/圈符：招标文件选项符号，不属合法中文小节标题字符（评分报告 P5：目录「8.2 ☑电子保函」
* 串章回归根因——投标保证金条款原文连同复选框符号被 LLM 带入小节标题）；
* 大纲提取/显式章节/规划标题三通道统一剥离（单一来源，禁止各文件私造第二份符号表） */
function stripCheckboxSymbols(title) {
	return title.replace(/[☑✓✔☐□☒○●◉◇◆]/gu, "");
}
/** 规划小节标题归一化：剥章节编号前缀、句尾标点、英文括号注释等规划模型残留。
* （原 promptRuleExtraction 迁入：constructionBidStructure 补挂链需同口径判定，
* 而 promptRuleExtraction 依赖 constructionBidStructure，迁移打破循环依赖） */
function normalizePlannedSectionTitle(title) {
	return displayChapterTitle(title.replace(/\*+/gu, "")).replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分、.．\s-]*/u, "").replace(/^\d+(?:\.\d+)*(?:[.．、]|\s)+/u, "").replace(/^[-—–]\s*/u, "").replace(/[<>]/gu, "").replace(/[：:。；;,.，]+$/gu, "").replace(/\s*[（(][^（）()]{0,40}[a-zA-Z]{3,}[^（）()]{0,40}[)）]\s*$/u, "").trim();
}
function displayChapterTitle(title) {
	let cleaned = stripCheckboxSymbols(title.replace(/^#+\s*/u, "").trim());
	let prev = "";
	while (cleaned && cleaned !== prev) {
		prev = cleaned;
		cleaned = cleaned.replace(/^第[一二三四五六七八九十百千万\d]+[章节]\s*/u, "").replace(/^\d+(?:[.．]\d+)+(?![万亿千百十米㎡吨元A-Za-z\d])\s*[、.．]?\s*/u, "").replace(/^\d+(?:[、，,]\s*|\s+|\.\s*(?![0-9])|．\s*(?![0-9]))/u, "").replace(/^[（(]?[一二三四五六七八九十]+[)）、.．\s]+/u, "").trim();
	}
	return cleaned;
}
var OUTLINE_TAG_NAME_RE;
var init_outline = __esmMin((() => {
	init_constants();
	init_templateStore();
	new RegExp(`^(?:第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]|\\d{1,3}[、)）]|\\d{1,3}[.．]\\s|(?:${CN_NUMERAL_RE})[、.．)）])`, "u");
	OUTLINE_TAG_NAME_RE = "(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)";
	new RegExp(`<\\s*${OUTLINE_TAG_NAME_RE}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\s*${OUTLINE_TAG_NAME_RE}\\s*>`, "giu");
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
//#endregion
//#region apps/server/src/services/document-workflow/constructionOrgTablePlan.ts
function normalizeText(text) {
	return text.replace(/\s+/gu, "").toLowerCase();
}
function chineseNumberToArabic(text) {
	if (/^\d+$/u.test(text)) return Number(text);
	let total = 0;
	let current = 0;
	for (const char of text) if (char === "十") {
		total += (current || 1) * 10;
		current = 0;
	} else if (char === "百") {
		total += (current || 1) * 100;
		current = 0;
	} else if (CHINESE_DIGIT_VALUE[char]) current = CHINESE_DIGIT_VALUE[char];
	return total + current;
}
/** 题注行内编号 key 归一（全角连字符/破折号 → 半角，与 scanTableNumberingDefects 同口径） */
function normalizeCaptionKey(raw) {
	return raw.replace(/[—–－]/gu, "-");
}
/** C2 图名归一化（规格汇集与注入双口径统一）：尾词未落「图」的工程图类构成名补「图」
* （「施工进度计划」→「施工进度计划图」「项目管理机构」→「项目管理机构图」）；
* 已带图类尾词或非构成词尾原样返回（不猜不造） */
function normalizeFigureSpecName(rawName) {
	const name = (rawName || "").trim();
	if (!name) return name;
	if (FIGURE_NAME_TAIL_RE.test(name)) return name;
	if (FIGURE_NAME_COMPOSITE_TAIL_RE.test(name)) return `${name}图`;
	return name;
}
/** 图题名合法性（编号分配口径，宁漏不误）：剥括号注释后 2~36 字、图类尾词落定、无句读空白 */
function validFigureCaptionName(name) {
	const bare = name.replace(/[（(][^）)]*[）)]/gu, "").trim();
	if (bare.length < 2 || bare.length > 36) return false;
	if (!FIGURE_NAME_TAIL_RE.test(bare)) return false;
	if (/[。；！？，,.;!?：:]/u.test(name)) return false;
	return /^[\u4e00-\u9fa5A-Za-z0-9（）()、与及\-—－]+$/u.test(name);
}
/** 图题名样判据（防重复注入的宽松扫描口径）：2~36 字无句读、非引用/叙述句开头；
* 与编号分配判据分离——宽松防漏（已有图题不再补位）、严格防误（正文叙述句不被编号） */
function figureCaptionNameLike(name) {
	if (name.length < 2 || name.length > 36) return false;
	if (/[。；！？，,.;!?：:]/u.test(name)) return false;
	return !FIGURE_NAME_LIKE_EXCLUDE_RE.test(name);
}
/** 图名核心词键（同图判定）：「横道图」↔「施工进度横道图」同图——去括号注释与图类尾词后比对 */
function figureNameKey(name) {
	return normalizeText(name).replace(/[（(][^）)]*[）)]/gu, "").replace(/[图表]+$/u, "");
}
/** 同图判定（核心词互相包含）：补位防重复/覆盖对账共用 */
function figureNamesMatch(left, right) {
	const a = figureNameKey(left);
	const b = figureNameKey(right);
	if (a.length < 2 || b.length < 2) return false;
	return a.includes(b) || b.includes(a);
}
/** 正文口径边界行号（文末附表区起点；-1 无）：图题链与题注链共用口径 */
function figureBodyEndIndex(lines) {
	const appendixIndex = lines.findIndex((line) => /^##\s+附表\s*[一二三四五六七八九十\d]{1,3}/u.test(line));
	return appendixIndex >= 0 ? appendixIndex : lines.length;
}
/** 正文区行→章号扫描（与 injectTableCaptions/normalizeTableNumbering 同口径单源）：
* 「第X章」解析优先、无编号标题按出现顺序递增；目录/附表标题不计章 */
function scanFigureChapterNumbers(lines, bodyEnd) {
	const chapterByLine = new Array(lines.length).fill(0);
	let chapterNo = 0;
	for (let index = 0; index < bodyEnd; index += 1) {
		const heading = /^##\s+(.+?)\s*$/u.exec(lines[index]);
		if (heading && !/^(目录|附表)/u.test(heading[1])) {
			const numbered = /^第\s*([一二三四五六七八九十百\d]+)\s*章/u.exec(heading[1]);
			chapterNo = numbered ? chineseNumberToArabic(numbered[1]) : chapterNo + 1;
		}
		chapterByLine[index] = chapterNo;
	}
	return chapterByLine;
}
/** 单行图题探针（严格口径）：返回图名与旧编号 key（无编号=空串）；非规范图题行返 null */
function probeFigureCaptionLine(rawLine) {
	const row = rawLine.trim();
	const numbered = FIGURE_CAPTION_NUMBERED_RE.exec(row);
	if (numbered) {
		const name = numbered[2].trim();
		return validFigureCaptionName(name) ? {
			name,
			oldKey: normalizeCaptionKey(numbered[1])
		} : null;
	}
	const bare = FIGURE_CAPTION_BARE_RE.exec(row);
	if (!bare) return null;
	const name = bare[1].trim();
	return validFigureCaptionName(name) ? {
		name,
		oldKey: ""
	} : null;
}
/** 正文区规范图题提取（严格口径，附表区不计） */
function extractFigureCaptions(markdown) {
	const lines = markdown.replace(/\r/gu, "").split("\n");
	const bodyEnd = figureBodyEndIndex(lines);
	const chapterByLine = scanFigureChapterNumbers(lines, bodyEnd);
	const entities = [];
	for (let index = 0; index < bodyEnd; index += 1) {
		const chapterNo = chapterByLine[index];
		if (chapterNo < 1) continue;
		const probe = probeFigureCaptionLine(lines[index] || "");
		if (probe) entities.push({
			lineIndex: index,
			chapterNo,
			oldKey: probe.oldKey,
			name: probe.name
		});
	}
	return entities;
}
/**
* B-T1 图题编号归一化：正文区（附表区前）全部规范图题按「图{章号}-{章内序号} 图名」重排——
* 章号=所在章（第X章解析与题注链同口径），章内序号=按图题出现顺序连续编号（验收判据「图位编号全局连续」）；
* 无编号图题（补位链产物）补编号；旧编号→新编号唯一映射时同步全文引用（数量词形态跳过、歧义不建映射，
* 宁缺不假，与 normalizeTableNumbering 同范式）；附表区零改动；幂等（重放时旧=新，全静默）。
*/
function normalizeFigureNumbering(markdown) {
	const lines = markdown.replace(/\r/gu, "").split("\n");
	const bodyEnd = figureBodyEndIndex(lines);
	const chapterByLine = scanFigureChapterNumbers(lines, bodyEnd);
	const entities = [];
	const seqByChapter = /* @__PURE__ */ new Map();
	for (let index = 0; index < bodyEnd; index += 1) {
		const chapterNo = chapterByLine[index];
		if (chapterNo < 1) continue;
		const probe = probeFigureCaptionLine(lines[index] || "");
		if (!probe) continue;
		const seq = (seqByChapter.get(chapterNo) || 0) + 1;
		seqByChapter.set(chapterNo, seq);
		entities.push({
			index,
			chapterNo,
			oldKey: probe.oldKey,
			name: probe.name,
			newKey: `${chapterNo}-${seq}`
		});
	}
	if (entities.length === 0) return markdown;
	const oldKeyCount = /* @__PURE__ */ new Map();
	for (const entity of entities) if (entity.oldKey) oldKeyCount.set(entity.oldKey, (oldKeyCount.get(entity.oldKey) || 0) + 1);
	const rewriteByIndex = /* @__PURE__ */ new Map();
	const referenceMap = /* @__PURE__ */ new Map();
	for (const entity of entities) {
		if (entity.oldKey === entity.newKey) continue;
		rewriteByIndex.set(entity.index, `图${entity.newKey} ${entity.name}`);
		if (entity.oldKey && oldKeyCount.get(entity.oldKey) === 1) referenceMap.set(entity.oldKey, entity.newKey);
	}
	if (rewriteByIndex.size === 0 && referenceMap.size === 0) return markdown;
	const output = [];
	for (let index = 0; index < lines.length; index += 1) {
		const rewrite = rewriteByIndex.get(index);
		if (rewrite) {
			output.push(rewrite);
			continue;
		}
		if (index >= bodyEnd || referenceMap.size === 0) {
			output.push(lines[index]);
			continue;
		}
		output.push((lines[index] || "").replace(/图\s*(\d+(?:[-—–－]\d+)?)\s*(?![份个张条页行列项次台套人天年月日])/gu, (full, raw) => {
			const mapped = referenceMap.get(normalizeCaptionKey(raw));
			return mapped ? `图${mapped}` : full;
		}));
	}
	return output.join("\n");
}
/** C2 现地修复：非规范「图 …」行（缺图类尾词/句读粘连）就地修复（正文区限定）。
* ①粘连前缀拆分：「图4-3 网络图相关内容纳入…」→「图4-3 网络图」+ 残余句另起行
*   （取最短「图类尾词落定」前缀，前缀须过严格判据）；
* ②尾词补全：「图 施工进度计划」→「图 施工进度计划图」（仅构成词尾白名单，防正文引用句误修）。
* 修复不改语义（残余句独立成行）、幂等（修复后行通过严格判据，复跑零变化）。 */
function repairMalformedFigureLines(lines) {
	const bodyEnd = figureBodyEndIndex(lines);
	const output = [];
	let repaired = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index] ?? "";
		if (index >= bodyEnd) {
			output.push(raw);
			continue;
		}
		if (probeFigureCaptionLine(raw)) {
			output.push(raw);
			continue;
		}
		const row = raw.trim();
		const match = /^图\s*(\d+(?:[-—–－]\d+)?)?\s+(\S.*)$/u.exec(row);
		if (!match) {
			output.push(raw);
			continue;
		}
		const number = match[1] || "";
		const rawName = match[2].trim();
		const figureLine = (name) => number ? `图${number} ${name}` : `图 ${name}`;
		const prefixMatch = /^(.{1,30}?(?:图|图表))/u.exec(rawName);
		if (prefixMatch && validFigureCaptionName(prefixMatch[1])) {
			const prefix = prefixMatch[1];
			const rest = rawName.slice(prefix.length).replace(/^[。；，、,.;！？!?\s]+/u, "").trim();
			output.push(figureLine(prefix));
			if (rest) output.push(rest);
			repaired += 1;
			continue;
		}
		if (!/[。；！？，,.;!?：:]/u.test(rawName)) {
			const completed = normalizeFigureSpecName(rawName);
			if (completed !== rawName && validFigureCaptionName(completed)) {
				output.push(figureLine(completed));
				repaired += 1;
				continue;
			}
		}
		output.push(raw);
	}
	return {
		lines: output,
		repaired
	};
}
/**
* B-T1 图位补位（终稿确定性兜底）：图类要求规格 ↔ 正文已有图题（宽松扫描 + 图名核心词匹配，
* 「横道图」↔「施工进度横道图」同图）对照，缺失的规格把无编号图题行「图 图名」注入目标章正文末尾
* （下一个一级标题前；目标章标题未定位时注入全文末尾保底）。编号由 normalizeFigureNumbering 统一分配，
* 二函数须串行成对使用；幂等（重放时规格图名已在正文，零注入）。
* C2：注入前先做非规范图题行就地修复（拆分/补尾词），修复行进入既有图题扫描——根治
* 「宽松认『像』不补、严格不认」的补了白补死循环。
*/
function ensureFigurePlaceholders(markdown, specs) {
	if (specs.length === 0) return {
		markdown,
		inserted: []
	};
	const repair = repairMalformedFigureLines(markdown.replace(/\r/gu, "").split("\n"));
	const lines = repair.lines;
	const bodyEnd = figureBodyEndIndex(lines);
	const existingNames = [];
	for (let index = 0; index < bodyEnd; index += 1) {
		const row = (lines[index] || "").trim();
		const numbered = FIGURE_CAPTION_NUMBERED_RE.exec(row);
		const bare = numbered ? null : FIGURE_CAPTION_BARE_RE.exec(row);
		const name = (numbered ? numbered[2] : bare ? bare[1] : "").trim();
		if (name && figureCaptionNameLike(name)) existingNames.push(name);
	}
	const missing = specs.filter((spec) => !existingNames.some((name) => figureNamesMatch(name, normalizeFigureSpecName(spec.name))));
	if (missing.length === 0) return repair.repaired > 0 ? {
		markdown: lines.join("\n"),
		inserted: []
	} : {
		markdown,
		inserted: []
	};
	const headingIndexes = [];
	for (let index = 0; index < bodyEnd; index += 1) {
		const heading = /^##\s+(.+?)\s*$/u.exec(lines[index]);
		if (heading && !/^(目录|附表)/u.test(heading[1])) headingIndexes.push(index);
	}
	const locateChapterEnd = (chapterTitle) => {
		const target = normalizeText(chapterTitle);
		if (!target) return bodyEnd;
		for (let order = 0; order < headingIndexes.length; order += 1) {
			const normalized = normalizeText((lines[headingIndexes[order]] || "").replace(/^##\s+/u, ""));
			if (normalized.includes(target) || target.includes(normalized)) return order + 1 < headingIndexes.length ? headingIndexes[order + 1] : bodyEnd;
		}
		return bodyEnd;
	};
	const insertAt = /* @__PURE__ */ new Map();
	const inserted = [];
	for (const spec of missing) {
		const end = locateChapterEnd(spec.chapterTitle);
		const bucket = insertAt.get(end) || [];
		const injectedName = normalizeFigureSpecName(spec.name);
		bucket.push(`图 ${injectedName}`);
		insertAt.set(end, bucket);
		inserted.push(`${spec.chapterTitle}：「${injectedName}」`);
	}
	const output = [];
	for (let index = 0; index < lines.length; index += 1) {
		const bucket = insertAt.get(index);
		if (bucket) output.push("", ...bucket, "");
		output.push(lines[index]);
	}
	const trailing = insertAt.get(lines.length);
	if (trailing) {
		while (output.length > 0 && !(output[output.length - 1] || "").trim()) output.pop();
		output.push("", ...trailing);
	}
	return {
		markdown: output.join("\n"),
		inserted
	};
}
/** 图位覆盖对账（B-T1 验收：招标明文每项图类要求 → 正文规范图位一一对照；图名核心词匹配）。
* C2：规格图名先归一化（尾词补「图」）——与注入链/严格判据同口径，防「补了不被认」虚缺 */
function figureCoverage(specs, markdown) {
	if (specs.length === 0) return {
		total: 0,
		covered: 0,
		missing: []
	};
	const captionNames = extractFigureCaptions(markdown).map((entity) => entity.name);
	const missing = [];
	let covered = 0;
	for (const spec of specs) if (captionNames.some((name) => figureNamesMatch(name, normalizeFigureSpecName(spec.name)))) covered += 1;
	else missing.push(spec);
	return {
		total: specs.length,
		covered,
		missing
	};
}
var CHINESE_DIGIT_VALUE, FIGURE_CAPTION_NUMBERED_RE, FIGURE_CAPTION_BARE_RE, FIGURE_NAME_TAIL_RE, FIGURE_NAME_COMPOSITE_TAIL_RE, FIGURE_NAME_LIKE_EXCLUDE_RE;
var init_constructionOrgTablePlan = __esmMin((() => {
	new RegExp(`^.{2,36}?表`, "u");
	CHINESE_DIGIT_VALUE = {
		一: 1,
		二: 2,
		三: 3,
		四: 4,
		五: 5,
		六: 6,
		七: 7,
		八: 8,
		九: 9
	};
	FIGURE_CAPTION_NUMBERED_RE = /^图\s*(\d+(?:[-—–－]\d+)?)\s+(\S.*)$/u;
	FIGURE_CAPTION_BARE_RE = /^图\s+(\S.*)$/u;
	FIGURE_NAME_TAIL_RE = /(图|图表)$/u;
	FIGURE_NAME_COMPOSITE_TAIL_RE = /(计划|机构|布置|流程|示意|系统|架构|组织|网络|横道|曲线|关系|框图|简图|大样|剖面|平面|立面|结构|工艺|路线|流向|时序|方案|安排)$/u;
	FIGURE_NAME_LIKE_EXCLUDE_RE = /^(?:所示|如下|见|参见|详见|如|按|为|其中|内|上|下)/u;
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
	init_outline();
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
//#region apps/server/src/services/document-workflow/factMatching.ts
var init_factMatching = __esmMin((() => {
	init_outline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/evidence.ts
var init_evidence = __esmMin((() => {
	init_factMatching();
}));
//#endregion
//#region apps/server/src/services/document-workflow/agentWorkflow.ts
var init_agentWorkflow = __esmMin((() => {
	init_kbService();
	init_markdownComposer();
}));
//#endregion
//#region apps/server/src/services/document-workflow/projectMaterialProfile.ts
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
//#endregion
export { init_configService as A, init_composeAppendices as B, tuningProfile as C, documentTextLength as D, stableHash as E, init_kbService as F, __esmMin as H, appendTenderAppendixSections as I, appendixEntryCarried as L, init_documentRoleService as M, init_constants$1 as N, explicitLengthTargets as O, getProjectRoot as P, cleanAppendixInternalPhrases as R, init_tuningProfile as S, init_utils as T, __exportAll as U, __commonJSMin as V, init_semanticSimilarity as _, init_factMatching as a, concurrencyForDocumentScale as b, init_markdownComposer as c, figureCoverage as d, init_constructionOrgTablePlan as f, init_semanticGate as g, init_workflowRules as h, init_evidence as i, init_projectMaterialService as j, init_budget as k, ensureFigurePlaceholders as l, init_writingSpec as m, init_projectMaterialProfile as n, init_projectGraph as o, normalizeFigureNumbering as p, init_agentWorkflow as r, docSystemPrefix as s, init_templateStore as t, extractFigureCaptions as u, init_outline as v, BID_DISCIPLINE_PHRASES as w, init_llmClient as x, normalizePlannedSectionTitle as y, composeTenderAppendixMarkdown as z };
