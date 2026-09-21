import "node:fs";
import "node:path";
import "node:os";
import { LocalTransformersEmbeddingProvider, loadBetterSqlite3 } from "@customize-agent/knowledge";
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
//#region apps/server/src/services/document-workflow/constants.ts
var CN_NUMERAL_RE;
var init_constants$1 = __esmMin((() => {
	CN_NUMERAL_RE = "[零〇一二三四五六七八九十百千万两]+";
}));
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
/**
* 工序顺序表达检测：施工流程/施工方法的工序顺序表达形式不限——箭头链、编号步骤、
* 有序/无序列表、顺序词引导、连接线链任一即可，不再强制“→”箭头。
* 本检测只判“有无工序顺序表达”，不判形式；相邻块形式重复由 flowFormRepeatIssues（WS3）单独判定。
*/
function hasProcessSequenceExpression(text) {
	if (!text) return false;
	if (/→|->|=>/u.test(text)) return true;
	if (/按.{0,60}?顺序|依次|先后|先.{0,40}?(?:后|再|随后|然后|最后)|顺序施工|流水顺序/u.test(text)) return true;
	if (/([\u4e00-\u9fa5]{2,6})前[^。；;!?\n]{0,80}?\1后/u.test(text)) return true;
	if ((text.match(/(?:^|\n)\s*(?:\d+[.、]|[（(]\d+[）)]|[一二三四五六七八九十]+[、.]|第[一二三四五六七八九十]+步)/gmu) || []).length >= 2) return true;
	if ((text.match(/(?:^|\n)\s*(?:[-*•]|\d+\.)\s+\S/gmu) || []).length >= 2) return true;
	if (/[\u4e00-\u9fa5]+(?:-|—|～|~)[\u4e00-\u9fa5]+(?:-|—|～|~)[\u4e00-\u9fa5]+/u.test(text)) return true;
	return false;
}
/**
* 工作包三要素完整性判定（4.17.9 内容要素检查，呈现形式不限）：
* 作业对象与工程量 / 工序顺序 / 施工方法三方面要素至少各有一处实质内容，
* 不再按“施工概况/施工流程/施工方法”标签字面判定——无标签但写法正确的块不应被拒。
* 三处验收器（chapterPostProcessing 结构门禁 / constructionOrgQualityRules 专项验收 /
* constructionOrgAudit 分部分项审计）共用本判定，避免三要素正则复制粘贴漂移
* （历史缺陷：audit 侧漏“作业对象|部位”“验收标准|检测”等词导致口径不一致、自然成文块误报缺失）。
*/
/** 工作包三要素逐维判定：作业对象与工程量 / 工序顺序 / 施工方法三要素分别判定，
* 供检测器逐块给出「缺哪一维」的精确诊断（丰乐镇实测：楼地面装饰工程只有流程/方法两个 H4、
* 缺作业对象与工程量，整块布尔判定只能报「不完整」，修复轮无从定向补齐）。 */
function workPackageContentElementFlags(block) {
	return {
		scope: /(?:施工)?(?:概况|范围)[:：]\s*\S|工程量|作业对象|部位|总量|共\s*\d|\d+(?:\.\d+)?\s*(?:km|㎡|m²|m2|m3|m³|座|套|处|盏|株|棵|延米|吨)(?![\dA-Za-z])|\d+(?:\.\d+)?\s*m(?![\dA-Za-z])/u.test(block),
		process: /工艺流程|施工流程/u.test(block) || /(?:施工)?(?:流程|工序|顺序)[:：]\s*\S/u.test(block) || hasProcessSequenceExpression(block),
		method: /(?:施工)?方法(?:[:：]\s*\S|(?:采用|为|按|以|包括|如下))|工艺参数|验收标准|检测|试验|记录|检查(?!井)|巡查|检验|整改|复查|销项|养护|台账|核对|复核|计量|MU\s*\d+|C\d+|抗压强度|抗折强度|强度等级|配合比|坍落度|工序卡|操作规程|作业指导书|技术交底/u.test(block)
	};
}
function workPackageContentElementsComplete(block) {
	const flags = workPackageContentElementFlags(block);
	return flags.scope && flags.process && flags.method;
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
//#region apps/server/src/services/document-workflow/templatingGovernance.ts
var STRUCTURE_LABEL_BAN_LINE, SKELETON_FINGERPRINT_BAN_LINE;
var init_templatingGovernance = __esmMin((() => {
	STRUCTURE_LABEL_BAN_LINE = "正文禁止以“施工概况/施工流程/施工方法/工艺流程/施工步骤”等结构标签充当小节标题或段落开头引导（不得出现“施工概况：本项目……”式标签行），要素内容直接融入连贯段落叙述。";
	SKELETON_FINGERPRINT_BAN_LINE = "句式禁止复读：全篇「由技术负责人组织」「合格后方可」「验收合格后」三类骨架表述各自不得超过 2 次，任何同义替换表达全篇不得超过 8 次；同义表达必须逐句轮换、句式多样（动词与语序随句变化），不得集中复用同一说法，保持事实不变（岗位、数值、频次不得丢失）。";
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
//#region apps/server/src/services/document-workflow/parameterPatterns.ts
var PROCESS_PARAMETER_RE, DEVICE_SPEC_RE, QUANTIFIED_BODY_PARAM_RE;
var init_parameterPatterns = __esmMin((() => {
	PROCESS_PARAMETER_RE = /\d+(?:\.\d+)?\s*(?:m³|m3|m²|㎡|mm|cm|m\/s|m|km|MPa|kN|kN\/m²|kPa|℃|%|d|h|min|MΩ|t|次\/天)|[MC]\d{1,3}(?:\.\d+)?|[<>≤≥]\s*\d+(?:\.\d+)?\s*(?:mm|MPa|%|d)|间距[≤<]?\s*\d+|偏差[≤<]?\s*\d+|坡度\s*\d+(?:\.\d+)?(?::\d+|%)|压实度\s*[≥>]?\s*\d+|坍落度|闭水试验|静载试验|拉拔试验|拉拔检测|探伤|试验压力|锚固长度|搭接长度|保护层厚度|养护时间|饱满度|垂直度|平整度|含水率|(?:地径|胸径|苗高|蓬径|冠丛高|株高|株距|行距|种植深度|覆土厚度|土球直径)\s*[≥≤<>=]?\s*[DΦφd]?\s*\d+(?:\.\d+)?|(?:养护期|养护周期)\s*(?:为|不少于|不低于)?\s*[一二三四五六七八九十两\d]+(?:个)?(?:月|年)|(?:成活率|保存率|苗木覆盖率)\s*[≥≤<>=]?\s*\d+(?:\.\d+)?\s*%|(?:防护挑网|安全网|防护网|围挡|警戒(?:区|线|距离)|防护栏杆).{0,12}(?:宽度|高度|距离|范围)[^，。；;]{0,8}\d+(?:\.\d+)?\s*m|(?:宽度|高度|距离|范围)[^，。；;]{0,8}\d+(?:\.\d+)?\s*m.{0,12}(?:防护挑网|安全网|防护网|围挡|警戒|防护栏杆)/giu;
	DEVICE_SPEC_RE = /\d[A-Z][A-Z0-9a-z]*\b|[A-Z]{1,2}\d{2,3}\b|\d+(?:\.\d+)?\s*(?:kW|kVA|KVA|KW)\b|IP\d{2}/gu;
	QUANTIFIED_BODY_PARAM_RE = /\d+(?:\.\d+)?\s*(?:m²|㎡|m3|m³|mm|cm|m|km|kg|t|MPa|kPa|℃|%|日历天|天|层|台|套|个|项|次|份|人|小时)/giu;
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
	init_constants$1();
	init_templateStore();
	new RegExp(`^(?:第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]|\\d{1,3}[、)）]|\\d{1,3}[.．]\\s|(?:${CN_NUMERAL_RE})[、.．)）])`, "u");
	OUTLINE_TAG_NAME_RE = "(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)";
	new RegExp(`<\\s*${OUTLINE_TAG_NAME_RE}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\s*${OUTLINE_TAG_NAME_RE}\\s*>`, "giu");
}));
//#endregion
//#region apps/server/src/services/document-workflow/semanticSimilarity.ts
/** 进程内共享本地语义模型实例（懒加载，复用 Transformers.js pipeline） */
function getLocalSemanticProvider() {
	if (!sharedProvider) sharedProvider = new LocalTransformersEmbeddingProvider({});
	return sharedProvider;
}
function embedCacheEnabled() {
	return process.env.DOCUMENT_EMBED_CACHE !== "0";
}
function embedCacheMaxSize() {
	const size = Number(process.env.DOCUMENT_EMBED_CACHE_SIZE || 4e4);
	return Number.isFinite(size) && size > 0 ? size : 4e4;
}
async function embedBatch(texts, embedDocuments) {
	const embedded = embedDocuments ? await embedDocuments(texts) : await getLocalSemanticProvider().embedDocuments(texts);
	if (embedded.length !== texts.length) throw new Error(`本地语义模型嵌入数量不一致：期望 ${texts.length} 条，实际 ${embedded.length} 条`);
	return embedded;
}
/** 批量嵌入（带全局 LRU 缓存）：命中直接复用向量，miss 文本去重后一次批量嵌入并回填缓存 */
async function embedWithGlobalCache(texts, embedDocuments) {
	if (!embedCacheEnabled()) return embedBatch(texts, embedDocuments);
	const vectors = new Array(texts.length);
	const missTexts = [];
	const missIndicesByText = /* @__PURE__ */ new Map();
	for (let index = 0; index < texts.length; index += 1) {
		const text = texts[index];
		if (text.length <= EMBED_CACHE_MAX_TEXT_CHARS) {
			const cached = embedCache.get(text);
			if (cached) {
				vectors[index] = cached;
				embedCacheHits += 1;
				embedCache.delete(text);
				embedCache.set(text, cached);
				continue;
			}
		}
		const indices = missIndicesByText.get(text);
		if (indices) indices.push(index);
		else {
			missIndicesByText.set(text, [index]);
			missTexts.push(text);
		}
	}
	if (missTexts.length === 0) return vectors;
	const embedded = await embedBatch(missTexts, embedDocuments);
	const maxSize = embedCacheMaxSize();
	for (let missIndex = 0; missIndex < missTexts.length; missIndex += 1) {
		const text = missTexts[missIndex];
		const vector = embedded[missIndex];
		const indexes = missIndicesByText.get(text);
		for (const index of indexes) vectors[index] = vector;
		if (text.length <= EMBED_CACHE_MAX_TEXT_CHARS) {
			embedCacheMisses += indexes.length;
			embedCache.set(text, vector);
			if (embedCache.size > maxSize) {
				const oldest = embedCache.keys().next().value;
				if (oldest !== void 0) embedCache.delete(oldest);
			}
		}
	}
	return vectors;
}
function dot$1(left, right) {
	const length = Math.min(left.length, right.length);
	let sum = 0;
	for (let i = 0; i < length; i++) sum += left[i] * right[i];
	return sum;
}
/**
* 构建语义相似度函数：批量嵌入 leftTexts 与 rightTexts（miss 子集一次 pipeline 批量调用，
* 命中走全局 LRU 缓存），返回闭包内带向量缓存的余弦相似度函数。
* @param embedDocuments 单测注入的嵌入实现（替代本地模型），生产环境不传
*/
async function buildSemanticSimilarity(leftTexts, rightTexts, embedDocuments) {
	if (leftTexts.length === 0 || rightTexts.length === 0) return () => 0;
	const texts = [...leftTexts, ...rightTexts];
	const vectors = await embedWithGlobalCache(texts, embedDocuments);
	const cache = /* @__PURE__ */ new Map();
	for (let i = 0; i < texts.length; i++) if (!cache.has(texts[i])) cache.set(texts[i], vectors[i]);
	return (leftText, rightText) => {
		const leftVector = cache.get(leftText);
		const rightVector = cache.get(rightText);
		if (!leftVector || !rightVector) return 0;
		return dot$1(leftVector, rightVector);
	};
}
var sharedProvider, SEMANTIC_COVERAGE_THRESHOLD, embedCache, embedCacheHits, embedCacheMisses, EMBED_CACHE_MAX_TEXT_CHARS;
var init_semanticSimilarity = __esmMin((() => {
	sharedProvider = null;
	SEMANTIC_COVERAGE_THRESHOLD = .6;
	embedCache = /* @__PURE__ */ new Map();
	embedCacheHits = 0;
	embedCacheMisses = 0;
	EMBED_CACHE_MAX_TEXT_CHARS = 2e3;
}));
//#endregion
//#region apps/server/src/services/document-workflow/semanticGate.ts
function dot(left, right) {
	const length = Math.min(left.length, right.length);
	let sum = 0;
	for (let i = 0; i < length; i++) sum += left[i] * right[i];
	return sum;
}
/**
* 构建语义判定 gate：构建时一次性嵌入全部原型（正例+负例），判定时对输入批量嵌入后计算余弦。
* 每个升级点配置一个 gate 实例（章节/文档循环复用），避免每句一次 pipeline 调用。
*/
async function buildSemanticGate(options) {
	if (options.prototypes.length === 0) return async (texts) => texts.map(() => false);
	const threshold = options.threshold ?? .6;
	const negatives = options.negativePrototypes ?? [];
	const prototypes = [...options.prototypes, ...negatives];
	const positiveCount = options.prototypes.length;
	const provider = options.embedDocuments ? null : getLocalSemanticProvider();
	const prototypeVectors = options.embedDocuments ? await options.embedDocuments(prototypes) : await provider.embedDocuments(prototypes);
	if (prototypeVectors.length !== prototypes.length) throw new Error(`本地语义模型嵌入数量不一致：期望 ${prototypes.length} 条，实际 ${prototypeVectors.length} 条`);
	return async (texts) => {
		if (texts.length === 0) return [];
		const result = texts.map(() => false);
		const indices = texts.map((text, index) => options.lexicalHints && !options.lexicalHints.test(text) ? -1 : index).filter((index) => index >= 0);
		if (indices.length === 0) return result;
		const candidates = indices.map((index) => texts[index]);
		const vectors = options.embedDocuments ? await options.embedDocuments(candidates) : await provider.embedDocuments(candidates);
		indices.forEach((textIndex, vectorIndex) => {
			const vector = vectors[vectorIndex];
			if (!vector) return;
			const positiveScore = Math.max(...prototypeVectors.slice(0, positiveCount).map((prototype) => dot(vector, prototype)));
			const negativeScore = negatives.length ? Math.max(...prototypeVectors.slice(positiveCount).map((prototype) => dot(vector, prototype))) : 0;
			if (positiveScore >= threshold && (negatives.length === 0 || positiveScore > negativeScore)) result[textIndex] = true;
		});
		return result;
	};
}
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
//#endregion
export { init_constants as A, __esmMin as B, concurrencyForDocumentScale as C, init_configService as D, tuningProfile as E, workPackageContentElementsComplete as F, documentTextLength as I, explicitLengthTargets as L, init_kbService as M, BID_DISCIPLINE_PHRASES as N, init_projectMaterialService as O, init_utils as P, init_budget as R, init_projectGraph as S, init_tuningProfile as T, __exportAll as V, init_factMatching as _, init_workflowRules as a, QUANTIFIED_BODY_PARAM_RE as b, SEMANTIC_COVERAGE_THRESHOLD as c, init_outline as d, normalizePlannedSectionTitle as f, init_evidence as g, init_agentWorkflow as h, init_writingSpec as i, getProjectRoot as j, init_documentRoleService as k, buildSemanticSimilarity as l, init_projectMaterialProfile as m, init_markdownComposer as n, buildSemanticGate as o, init_templateStore as p, init_constructionOrgTablePlan as r, init_semanticGate as s, docSystemPrefix as t, init_semanticSimilarity as u, DEVICE_SPEC_RE as v, init_llmClient as w, init_parameterPatterns as x, PROCESS_PARAMETER_RE as y, __commonJSMin as z };
