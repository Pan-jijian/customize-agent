import "node:fs";
import { readFileSync } from "node:fs";
import { LocalTransformersEmbeddingProvider } from "@customize-agent/knowledge";
import "node:path";
import "node:os";
import * as path$1 from "path";
import * as os$1 from "os";
import * as fs$1 from "fs";
import "@customize-agent/llm";
import "@customize-agent/runtime";
import "xlsx";
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
//#endregion
//#region apps/server/src/services/document-workflow/budget.ts
function documentTextLength(markdown) {
	return markdown.replace(/<[^>]+>/gu, "").replace(/\s+/gu, "").length;
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
//#region apps/server/src/services/document-workflow/documentFactTrace.ts
/** 值级可执行性判断：指向值（见XXX）、标题行、标题+正文混合残留、纯文档引用名等不具备落位意义的事实值，与 isActionableTraceFact 共用同一口径 */
function isActionableFactValue(value) {
	if (/^(?:见|详见|按|执行|参见|依据).{0,16}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料)$/u.test(value)) return false;
	if (/(?:^|[:：]\s*)(?:见|详见|按|执行|参见|依据)[^。；;]{0,18}(?:前附表|招标公告|招标文件|合同|协议书|通用条款|专用条款|图纸|清单|附件|资料|补疑|答疑)[^。；;]{0,6}$/u.test(value)) return false;
	if (/^见.{0,24}(?:招标范围|招标补疑|补疑|前附表|答疑)/u.test(value)) return false;
	if (/^(?:合同协议书|通用条款|专用条款|招标文件|招标公告|投标人须知前附表|附件|资料)$/u.test(value.replace(/[（）()\d一二三四五六七八九十、.．\s]/gu, ""))) return false;
	if (/^(?:工程名称|项目名称|建设地点|建设规模|计划工期|质量标准|招标范围|合同估算价|工程概况|项目概况|项目内容)$/u.test(value)) return false;
	if (/\|/u.test(value)) return false;
	if (/^#+\s*/u.test(value)) return false;
	if (/^[一二三四五六七八九十]+[、.．]\s*\S{2,}[：:]/u.test(value)) return false;
	if (/^[（(]\s*\d+[)）]/u.test(value) && /具备|证书|考核|资格|人员/u.test(value)) return false;
	if (/^\d{1,2}(?:[.．]\d{1,2}){1,2}$/u.test(value)) return false;
	if (/^\d{1,2}(?:[.．]\d{1,2}){1,2}\s*(?:招标|计划|其他|特殊|内容|范围|说明|要求|概况|工期|质量|标段|项目|工程|名称|地点|规模|信息)(?:[:：].{0,6})?$/u.test(value)) return false;
	if (/^[0-9A-Za-z]{8,}[.．]\d+$/u.test(value)) return false;
	if (/^[0-9A-Za-z]{8,}\s*[）)]$/u.test(value)) return false;
	if (/\d{1,2}[.．]\d{1,2}[.．]?\d{0,2}\s*(?:计划工期|招标|其他|特殊|质量要求|建设规模)/u.test(value)) return false;
	if ((value.match(/《/gu) || []).length !== (value.match(/》/gu) || []).length) return false;
	if ((value.match(/[（(]/gu) || []).length !== (value.match(/[）)]/gu) || []).length) return false;
	if (/[：:]\s*$/u.test(value)) return false;
	if (/[/／]\s*$/u.test(value)) return false;
	if (/[一二三四五]是\s*\S{2,}/u.test(value)) return false;
	if (value.length >= 20 && /未编制|未组织|未按|未及时|未落实|未经验收/u.test(value)) return false;
	if (value.length < 4 && !/\d/u.test(value)) return false;
	return true;
}
function isActionableTraceFact(trace) {
	const value = String(trace.value || "").trim();
	const labelValue = `${trace.label}${value}`;
	if (!/项目|工程|编号|地点|规模|范围|工期|质量|安全|资源|材料|设备|验收|招标人|建设单位|发包人|业主|\d/u.test(labelValue)) return false;
	if (!isActionableFactValue(value)) return false;
	if (/^(?:技术参数|精确参数)$/u.test(trace.label)) return false;
	if (/^(?:项目名称|工程名称|项目名)$/u.test(trace.label) && !/(?:建设|新建|改建|扩建|改造|整治|提升|治理)/u.test(value) && !/[\u4e00-\u9fa5]{1,8}(?:镇|乡|县|区|村|街道|社区|片区)/u.test(value)) return false;
	if (!value.replace(/《[^》]{2,60}》/gu, "").replace(/[、，,；;．.／/\s（）()]/gu, "") && /《[^》]{2,60}》/u.test(value)) return false;
	const hasConcreteData = /\d/u.test(value);
	if (!hasConcreteData && /^(?:承包人|发包人|招标人|投标人|我方|施工单位|建设单位|总承包单位|分包人|中标人)(?:应|须|必须|应当)/u.test(value)) return false;
	if (!hasConcreteData && /^本(?:招标|采购)项目[^。；]{0,80}?(?:须|应|必须)/u.test(value)) return false;
	if (/^[（(]\s*[一二三四五六七八九十\d]{1,3}\s*[)）]/u.test(value)) return false;
	return true;
}
var init_documentFactTrace = __esmMin((() => {
	new RegExp(`(?:GB|JGJ|CJJ|CECS|ISO|SL|DL|JTS|JTG|JT|TB|DB\\d{2}|DB)\\s*\\/?\\s*T?\\s*(\\d{3,5})(?:\\s*[-—–]\\s*(\\d{2,4}))?`, "giu");
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
//#region apps/server/src/services/document-workflow/tenderBidChecks.ts
/** 构建模糊应答语义 gate：词面召回 + 语义复核（semanticGate 统一入口，禁止自行实现嵌入逻辑） */
async function buildVagueResponseGate(embedDocuments) {
	return buildSemanticGate({
		prototypes: [...VAGUE_RESPONSE_SEMANTIC_PROTOTYPES],
		negativePrototypes: [...VAGUE_LEGAL_CONTEXT_PROTOTYPES],
		lexicalHints: VAGUE_RESPONSE_LEXICAL_HINTS_RE,
		embedDocuments
	});
}
/** 句池排除行判定（检测端与修复锚点端同源口径）：空行/标题/表格/列表/引用/目录条目行不进句池 */
function isFillerPoolExcludedLine(line) {
	const trimmed = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim();
	if (!trimmed) return true;
	if (/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(trimmed)) return true;
	return FILLER_TOC_LINE_RE.test(trimmed);
}
/** 共享句池构建：过滤非正文行后按。；; 切句，仅保留 ≥12 字正文句（检测/修复锚点/生成期质检三端同源） */
function buildFillerSentencePool(markdown) {
	return markdown.split("\n").filter((line) => !isFillerPoolExcludedLine(line)).flatMap((line) => line.split(/[。；;]/u)).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 12);
}
/**
* 共享句级套话判定器（检测端 fillerDensityReport / 修复锚点端 fillerSentenceTargets /
* 生成期 block-qc 扫描同源）：套话语义原型最高余弦 ≥ FILLER_SENTENCE_THRESHOLD，
* 或模糊应答语义 gate 复核命中，即判套话句。
*/
async function judgeFillerSentences(sentences, embedDocuments) {
	if (sentences.length === 0) return [];
	const fillerSimilarity = await buildSemanticSimilarity(sentences, [...FILLER_SEMANTIC_QUERIES], embedDocuments);
	const vagueFlags = await (await buildVagueResponseGate(embedDocuments))(sentences);
	return sentences.map((sentence, index) => {
		const similarity = Math.max(...FILLER_SEMANTIC_QUERIES.map((query) => fillerSimilarity(sentence, query)));
		const semantic = similarity >= FILLER_SENTENCE_THRESHOLD;
		const vague = vagueFlags[index];
		return {
			sentence,
			semantic,
			vague,
			filler: semantic || vague,
			similarity
		};
	});
}
/** 套话密度统计：核心章节（全文口径，评分器可传核心段落子集）套话句占比。
* 模糊应答词面命中仅召回（「力争上游」「左右对称」等合法句不得误计）；套话语义原型判定走
* FILLER_SENTENCE_THRESHOLD（0.80 校准值），句池与修复锚点/生成期质检共享（含目录行过滤）。 */
async function fillerDensityReport(markdown, embedDocuments) {
	const sentences = buildFillerSentencePool(markdown);
	const judgements = await judgeFillerSentences(sentences, embedDocuments);
	const vagueCandidateSentences = sentences.filter((sentence) => VAGUE_RESPONSE_LEXICAL_HINTS_RE.test(sentence)).length;
	const vagueSemanticSentences = judgements.filter((item) => item.vague).length;
	const fillerSentenceFlags = judgements.map((item) => item.filler);
	const fillerSentences = fillerSentenceFlags.filter(Boolean).length;
	const fillerSentenceDetails = [...new Set(sentences.filter((_, index) => fillerSentenceFlags[index]))].slice(0, 40);
	const ratio = sentences.length ? fillerSentences / sentences.length : 0;
	const level = ratio >= .4 ? "heavy" : ratio >= .2 ? "medium" : "light";
	return {
		totalSentences: sentences.length,
		fillerSentences,
		ratio,
		level,
		vagueCandidateSentences,
		vagueSemanticSentences,
		fillerSentenceDetails
	};
}
/** 措施五要素闭合统计：按空行分块（≥30 字），五要素 bge 命中 ≥4 项为闭合块 */
async function fiveElementBlockStats(markdown, embedDocuments) {
	const blocks = markdown.split(/\n{2,}/u).filter((block) => block.trim().length >= 30);
	const elementQueries = Object.values(FIVE_ELEMENT_SEMANTIC_QUERIES);
	const elementSimilarity = await buildSemanticSimilarity(blocks, elementQueries, embedDocuments);
	const hasElement = (block, query) => elementSimilarity(block, query) >= SEMANTIC_COVERAGE_THRESHOLD;
	const ROLE_WORD_RE = FIVE_ELEMENT_WORD_RES.role;
	const FREQUENCY_WORD_RE = FIVE_ELEMENT_WORD_RES.frequency;
	const CLOSURE_WORD_RE = FIVE_ELEMENT_WORD_RES.acceptance;
	const PLAN_WORD_RE = FIVE_ELEMENT_WORD_RES.plan;
	const PROCESS_WORD_RE = FIVE_ELEMENT_WORD_RES.process;
	const hasDeterministicElement = (block, query) => {
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.plan && !PLAN_WORD_RE.test(block)) return false;
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.plan && PLAN_WORD_RE.test(block)) return true;
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.process && !PROCESS_WORD_RE.test(block)) return false;
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.process && PROCESS_WORD_RE.test(block)) return true;
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.role && !ROLE_WORD_RE.test(block)) return false;
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.role && ROLE_WORD_RE.test(block)) return true;
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.frequency && !FREQUENCY_WORD_RE.test(block)) return false;
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.frequency && FREQUENCY_WORD_RE.test(block)) return true;
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.acceptance && !CLOSURE_WORD_RE.test(block)) return false;
		if (query === FIVE_ELEMENT_SEMANTIC_QUERIES.acceptance && CLOSURE_WORD_RE.test(block)) return true;
	};
	const judgeElement = (block, query) => {
		const deterministic = hasDeterministicElement(block, query);
		return deterministic !== void 0 ? deterministic : hasElement(block, query);
	};
	let completeBlocks = 0;
	let incompleteBlocks = 0;
	let closedLoopBlocks = 0;
	for (const block of blocks) {
		if (elementQueries.filter((query) => judgeElement(block, query)).length >= 4) completeBlocks += 1;
		else if (!judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.role) || !judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.frequency)) incompleteBlocks += 1;
		if (judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.role) && judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.frequency) && judgeElement(block, FIVE_ELEMENT_SEMANTIC_QUERIES.acceptance)) closedLoopBlocks += 1;
	}
	return {
		blocks: blocks.length,
		completeBlocks,
		incompleteBlocks,
		closedLoopBlocks
	};
}
function dangerousTwoStepCheck(markdown) {
	const categories = DANGEROUS_CATEGORY_RES.filter((pattern) => pattern.test(markdown)).map((pattern) => pattern.source.replace(/\\u\w*|\\|\(|\||\)/gu, ""));
	const graded = DANGEROUS_GRADE_RE.test(markdown);
	const paramMatched = DANGEROUS_PARAM_RE.test(markdown);
	return {
		categories,
		graded,
		paramMatched,
		twoStepComplete: categories.length > 0 && graded && paramMatched
	};
}
function emergencyStructureCheck(markdown) {
	const coveredParts = EMERGENCY_EIGHT_PARTS.filter((part) => part.pattern.test(markdown)).map((part) => part.name);
	const missingParts = EMERGENCY_EIGHT_PARTS.filter((part) => !part.pattern.test(markdown)).map((part) => part.name);
	const planHits = EMERGENCY_COMMON_PLANS.filter((plan) => markdown.includes(plan));
	return {
		coveredParts: [...coveredParts],
		missingParts: [...missingParts],
		coverage: coveredParts.length / EMERGENCY_EIGHT_PARTS.length,
		planHits: [...planHits]
	};
}
var VAGUE_RESPONSE_LEXICAL_HINTS_RE, VAGUE_RESPONSE_SEMANTIC_PROTOTYPES, VAGUE_LEGAL_CONTEXT_PROTOTYPES, FILLER_SEMANTIC_QUERIES, FILLER_SENTENCE_THRESHOLD, FILLER_TOC_LINE_RE, FIVE_ELEMENT_SEMANTIC_QUERIES, FIVE_ELEMENT_WORD_RES, DANGEROUS_CATEGORY_RES, DANGEROUS_GRADE_RE, DANGEROUS_PARAM_RE, EMERGENCY_EIGHT_PARTS, EMERGENCY_COMMON_PLANS;
var init_tenderBidChecks = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	VAGUE_RESPONSE_LEXICAL_HINTS_RE = /基本|大致|力争|原则上|大概|左右|尽可能|尽量/u;
	VAGUE_RESPONSE_SEMANTIC_PROTOTYPES = [
		"基本满足招标文件要求",
		"大致符合相关规范标准",
		"力争达到优良质量标准",
		"原则上按照规范执行",
		"尽可能保证工程质量",
		"尽量满足工期要求"
	];
	VAGUE_LEGAL_CONTEXT_PROTOTYPES = [
		"结构构件左右对称布置",
		"平面布置左右对称合理",
		"力争上游的企业精神"
	];
	FILLER_SEMANTIC_QUERIES = [
		"精心组织、科学管理，确保工程质量",
		"严格执行相关规范和设计要求",
		"根据实际情况适当调整施工安排",
		"建立健全管理体系，加强过程管理",
		"全力保障项目顺利推进",
		"加强管理、严格控制，确保工程质量达到优良标准",
		"精心策划、周密部署，全力以赴完成任务目标",
		"高度重视、狠抓落实，层层压实责任",
		"统筹兼顾、合理安排，确保各项工作有序推进",
		"严格管理、严格要求，确保一次成优",
		"认真贯彻落实各项管理制度，不断提升管理水平",
		"加强安全管理，杜绝各类安全事故发生",
		"合理安排施工工序，确保工程按期完工",
		"坚持质量第一、安全至上，认真做好各项工作"
	];
	FILLER_SENTENCE_THRESHOLD = .8;
	FILLER_TOC_LINE_RE = /^\s*(?:第[一二三四五六七八九十百\d]+[章节篇]|\d+(?:\.\d+){0,3})\s+[^。；;，,]*$/u;
	FIVE_ELEMENT_SEMANTIC_QUERIES = {
		plan: "制定专项施工方案与管理制度，明确技术措施",
		process: "施工工序流程与工艺步骤顺序",
		role: "由项目经理、技术负责人等岗位人员分工负责",
		frequency: "每日、每周等检查频次与时间节点安排",
		acceptance: "经检查验收合格后整改销项闭环"
	};
	FIVE_ELEMENT_WORD_RES = {
		plan: /专项施工方案|专项方案|施工方案|施工组织设计|技术措施|管理制度|技术交底|作业指导书|操作规程/u,
		process: /施工工序|工艺流程|施工流程|作业流程|施工顺序|施工步骤|工艺步骤|流水段|流水作业|依次施工|工序/u,
		role: /项目经理|技术负责人|施工员|质检员|安全员|材料员|资料员|测量员|劳资员|班组长|监理工程师|试验员/u,
		frequency: /每日|每天|每周|每月|每季度|每批|不少于\s*\d+\s*次|至少\s*\d+\s*次|每周\s*\d+\s*次|每日\s*\d+\s*次|每\s*\d+\s*日/u,
		acceptance: /整改|复查|销项|复验|闭环|返工/u
	};
	DANGEROUS_CATEGORY_RES = [
		/基坑|沟槽/u,
		/模板支撑|高支模/u,
		/脚手架|悬挑|附着式/u,
		/起重吊装|吊装/u,
		/幕墙/u,
		/人工挖孔桩/u,
		/装配式|钢结构安装/u,
		/拆除工程/u,
		/顶管|盾构|暗挖/u,
		/有限空间|水下作业/u,
		/吊篮/u,
		/塔吊|施工电梯|升降机/u,
		/沉井/u
	];
	DANGEROUS_GRADE_RE = /超危大|超规模|专家论证|一般危大/u;
	DANGEROUS_PARAM_RE = /(?:深度|高度|跨度|开挖).{0,8}\d+(?:\.\d+)?\s*(?:m|米)|(?:重量|吊装).{0,8}\d+(?:\.\d+)?\s*(?:kN|千牛)/u;
	EMERGENCY_EIGHT_PARTS = [
		{
			name: "总则",
			pattern: /总则/u
		},
		{
			name: "组织机构及职责",
			pattern: /应急(?:组织|领导)|组织机构|应急指挥部|应急小组/u
		},
		{
			name: "风险分析与危险源辨识",
			pattern: /风险分析|危险源辨识|风险辨识/u
		},
		{
			name: "应急物资设备通讯保障",
			pattern: /应急物资|物资.{0,8}(?:保障|储备)|通讯保障|通信保障/u
		},
		{
			name: "专项应急预案",
			pattern: /专项应急预案|专项预案/u
		},
		{
			name: "应急响应流程",
			pattern: /应急响应|响应流程|响应程序/u
		},
		{
			name: "后期处置",
			pattern: /后期处置|善后|事故调查/u
		},
		{
			name: "培训演练",
			pattern: /(?:应急)?演练|培训.{0,6}演练/u
		}
	];
	EMERGENCY_COMMON_PLANS = [
		"高处坠落",
		"物体打击",
		"坍塌",
		"触电",
		"火灾",
		"起重",
		"防汛",
		"防台风",
		"中暑",
		"中毒窒息",
		"管线破坏"
	];
}));
//#endregion
//#region apps/server/src/services/document-workflow/narrativeContext.ts
/**
* 叙述语境共享单源（C0 评分机制校准）：标题/表格/列表/引用/目录行不是叙述语境——
* 密度型分量（事实落位/工艺参数）的 token 提取与词面型分量（评标响应）的响应判定
* 必须建立在叙述句之上，罗列段（词表/参数堆叠）不构成专业内容证据。
* 校准依据（r28l/s28l 离线复算）：参数叙述语境保留率 93.3%/96.5%——语境约束对真实成稿
* 影响可控；无完整句的堆词文档（词表+参数串堆叠）在旧口径下专业分 87 分（事实落位/工艺参数/
* 评标响应 100），语境约束后 token 池与响应判定归零。
* 本模块为唯一权威：评分三端（tenderBidScoring 命中单元、documentProfessionalScore 四维、
* 对抗套件）禁止各自内联叙述判定。
*/
/** 目录聚簇行（C0-1 标题党通道之二）：多章节/多编号条目堆叠且无句读——真实目录条目行特征。
* r28l 实测「第一章 工程概况 1.1 编制说明与工程概况 1.2 …」类目录行曾作为独立判定位
* 命中「编制专项施工方案」类查询（假阳性）。章节标记与编号条目合计 ≥3 即判目录聚簇行。 */
function isTocClusterLine(line) {
	const trimmed = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim();
	if (!trimmed || /[。！？]/u.test(trimmed)) return false;
	return (trimmed.match(/第[一二三四五六七八九十百千\d]+[章节篇]/gu) || []).length + (trimmed.match(/\d+(?:\.\d+)+/gu) || []).length >= 3;
}
/** 罗列串判定（C0-2 堆词通道）：逗号/顿号/空白分隔的子段数 ≥8 且平均子段长度 <8 字，
* 属词表/参数堆叠（「C30，C25，C35，…」「工程概况 主要施工内容 重难点分析 …」），不构成叙述句。
* 门槛校准（C0 实测）：6 段/10 字口径误伤「总则明确，应急组织机构…，应急演练按计划开展」类
* 多短句叙述行（8 段均 9.1 字）；8 段/8 字口径下该类行保留、词表（10 段均 3.5 字）与参数串
* （17 段均 4.7 字）仍稳定排除。 */
function isListingText(text) {
	const parts = text.split(/[，,、\s]+/u).map((part) => part.trim()).filter(Boolean);
	if (parts.length < 8) return false;
	return parts.reduce((sum, part) => sum + part.length, 0) / parts.length < 8;
}
/** 叙述行判定（单元级，与句池行级过滤同源）：非标题/表格/列表/引用/目录条目行/目录聚簇行、
* 非罗列串（词表/参数堆叠行不构成实质正文）且 ≥12 字——评分判定单元的「实质正文」存在性条件 */
function isNarrativeLine(line) {
	const trimmed = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim();
	if (trimmed.length < 12) return false;
	if (isFillerPoolExcludedLine(trimmed)) return false;
	if (isTocClusterLine(trimmed)) return false;
	return !isListingText(trimmed);
}
/** 结构证据文本（complianceScore 危大两步/应急八部分词面型分量专用）：剥离 markdown 标题行、
* 目录聚簇行与目录条目行（章节号/编号 + 标题、无句读）——空壳标题与目录行不得构成结构证据
* （C0 基线：纯标题文档在旧口径下骗得应急覆盖率分数）；表格/列表/正文行保留（危大清单表、
* 应急组织列表、专家论证记录是合法结构化载体），且不设切句长度门槛——短句是合法证据
* （「基坑工程施工方案已编制。」类别词是全篇危大类别命中的唯一证据，切句 ≥12 字门槛会丢失）。 */
function stripHeadingLines(text) {
	return text.split("\n").map((line) => line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim()).filter((line) => {
		if (!line) return false;
		if (/^#{1,6}\s+/u.test(line)) return false;
		if (isTocClusterLine(line)) return false;
		return !/^(?:第[一二三四五六七八九十百\d]+[章节篇]|\d+(?:\.\d+){0,3})\s+[^。；;，,]*$/u.test(line);
	}).join("\n");
}
/** 叙述句提取（C0-2 共享单源）：行级排除 + 句级「≥12 字、汉字 ≥8 且汉字占比 ≥0.15、非罗列串」 */
function narrativeSentences(text) {
	return text.split("\n").filter((line) => !isFillerPoolExcludedLine(line) && !isTocClusterLine(line)).flatMap((line) => line.split(/[。；;]/u)).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 12).filter((sentence) => {
		const hanCount = (sentence.match(/[\u4e00-\u9fff]/gu) || []).length;
		const compactLength = sentence.replace(/\s+/gu, "").length;
		return hanCount >= 8 && hanCount / Math.max(1, compactLength) >= .15;
	}).filter((sentence) => !isListingText(sentence));
}
/** 叙述字数（章级 gate / 篇幅归一用）：叙述句长度合计 */
function narrativeCharCount(text) {
	return narrativeSentences(text).reduce((sum, sentence) => sum + sentence.length, 0);
}
/** 叙述语境 token 提取（密度型分量专用）：仅从叙述句提取 pattern 命中的 token；
* pattern 需带 g flag（QUANTIFIED_BODY_PARAM_RE 等权威口径常量直接传入）。 */
function extractContextualTokens(text, pattern) {
	const tokens = /* @__PURE__ */ new Set();
	for (const sentence of narrativeSentences(text)) for (const token of sentence.match(pattern) || []) tokens.add(token);
	return tokens;
}
function sentenceHasCommitmentContext(sentence) {
	return COMMITMENT_CONTEXT_RE.test(sentence);
}
var COMMITMENT_CONTEXT_RE;
var init_narrativeContext = __esmMin((() => {
	init_tenderBidChecks();
	COMMITMENT_CONTEXT_RE = /\d|确保|保证|杜绝|实行|采用|落实|建立|执行|达到|不低于|不少于|控制在|符合|按照|承诺/u;
}));
//#endregion
//#region apps/server/src/services/document-workflow/tenderBidScoring.ts
/** 编制规范性匹配正则定义在 normalizationScore 上方（B7 口径修正） */
function normalizeHeadingTitle(title) {
	return title.replace(/^第[一二三四五六七八九十百千万\d]+[章节]\s*/u, "").replace(/^\d+(?:\.\d+)*[、.．\s]+/u, "").replace(/^[（(]?[一二三四五六七八九十]+[)）、.．\s]+/u, "").replace(/\s+/gu, "").trim();
}
function headingTitles(markdown) {
	return [...markdown.matchAll(/^#{1,3}\s+(.+)$/gmu)].map((match) => normalizeHeadingTitle(match[1] || "")).filter((title) => title.length >= 2);
}
/** 资料完整性：章节齐全度（模板章节标题命中率）+ 强制模块覆盖（块级 bge 语义判定）。
* 模块覆盖率由 buildTenderBidScores 单源计算（v2 要件完整性同源消费），本函数不再重复判定。 */
function completenessScore(markdown, chapters, template, moduleCoverageRate) {
	const titles = headingTitles(markdown);
	let chapterHitRate = 1;
	const templateChapters = template?.chapters || [];
	if (templateChapters.length > 0) {
		const normalizedTemplateTitles = templateChapters.map((chapter) => normalizeHeadingTitle(chapter.title)).filter(Boolean);
		chapterHitRate = normalizedTemplateTitles.filter((title) => titles.some((actual) => actual.includes(title) || title.includes(actual))).length / normalizedTemplateTitles.length;
	} else if (chapters.length > 0) chapterHitRate = chapters.filter((chapter) => titles.some((actual) => actual.includes(normalizeHeadingTitle(chapter.title)) || normalizeHeadingTitle(chapter.title).includes(actual))).length / chapters.length;
	return Math.round((chapterHitRate * .55 + moduleCoverageRate * .45) * 100);
}
/** 方案针对性：项目专属事实落位率 + 专属事实跨章节分布率 */
function specificityScore(chapters, factTraces) {
	const scoredTraces = factTraces.filter(isActionableTraceFact);
	const usedTraces = scoredTraces.filter((trace) => trace.status === "used");
	const usedRate = scoredTraces.length ? usedTraces.length / scoredTraces.length : 1;
	const usedValues = usedTraces.map((trace) => String(trace.value || "").replace(/\s+/gu, " ").trim()).filter((value) => value.length >= 4 && value.length <= 60);
	const normalizedBodies = chapters.map((chapter) => (chapter.content || "").replace(/\s+/gu, " "));
	const distributedCount = usedValues.filter((value) => normalizedBodies.filter((body) => body.includes(value)).length >= 2).length;
	const distribution = usedValues.length ? distributedCount / usedValues.length : 1;
	return Math.round((usedRate * .55 + distribution * .45) * 100);
}
/**
* 合规性：危大闭环链（辨识→方案→审批论证→交底→监测→验收）+ 三级配电两级保护 + 实名制/工资专户/应急/绿色施工；
* 按 docx 判定标尺叠加：危大两步确认法（类别匹配+参数分级，10%）与应急预案八部分结构（10%）。
* C0-2 语境约束：危大两步与应急八部分为词面型分量，消费结构证据文本（stripHeadingLines）——
* 标题行/目录行剥离：空壳标题（如标题行「生产安全事故应急预案与应急演练」）不得单独构成结构
* 证据（C0 基线：纯标题文档在旧口径下骗得应急覆盖率分数）；表格/列表/正文行保留且不设切句
* 长度门槛（危大清单表等结构化载体与短句是合法证据）。
*/
function complianceScore(markdown, anyBlockMatches) {
	const base = COMPLIANCE_ITEM_QUERIES.filter(anyBlockMatches).length / COMPLIANCE_ITEM_QUERIES.length;
	const evidenceText = stripHeadingLines(markdown);
	const dangerous = dangerousTwoStepCheck(evidenceText);
	const dangerousRate = dangerous.twoStepComplete ? 1 : dangerous.categories.length > 0 && dangerous.graded ? .6 : dangerous.categories.length > 0 ? .3 : 0;
	const emergency = emergencyStructureCheck(evidenceText);
	return Math.round((base * .8 + dangerousRate * .1 + emergency.coverage * .1) * 100);
}
/** 可落地性：措施五要素闭合块密度（方案＋流程＋责任人＋时间节点＋验收标准，docx L93）
* 目标基准（4.26.0 起固化字数口径，参考库锚点已随模板参考库移除下线）：
* target = max(6, ceil(有效字数 / 1500))，单一逻辑无分支 */
async function executabilityScore(markdown) {
	const { blocks, completeBlocks } = await fiveElementBlockStats(markdown);
	const target = Math.max(6, Math.ceil(documentTextLength(markdown) / 1500));
	const density = Math.min(1, completeBlocks / target);
	const fiveElementRate = blocks ? completeBlocks / blocks : 0;
	return Math.round((density * .7 + fiveElementRate * .3) * 100);
}
function normalizationScore(issues) {
	const isNormalizationIssue = (issue) => {
		if (issue.category === "table" || issue.category === "format") return true;
		if (issue.category === "structure") return STRUCTURE_ISSUE_RE.test(issue.message);
		if (issue.category) return false;
		return !NORMALIZATION_EXCLUDE_RE.test(issue.message) && NORMALIZATION_ISSUE_RE.test(issue.message);
	};
	const normErrors = issues.filter((issue) => issue.level === "error" && isNormalizationIssue(issue)).length;
	const normWarnings = issues.filter((issue) => issue.level === "warning" && isNormalizationIssue(issue)).length;
	return Math.max(0, 100 - normErrors * 8 - Math.min(normWarnings * 3, 30));
}
function duplicateSentenceStats(markdown) {
	const sentences = markdown.split("\n").filter((line) => !isFillerPoolExcludedLine(line) && !isTocClusterLine(line)).flatMap((line) => line.split(/[。；;]/u)).map((sentence) => sentence.replace(/[\s，,、:：（）()【】[\]《》“”"'`]/gu, "")).filter((sentence) => sentence.length >= 12);
	const uniqueSentences = new Set(sentences).size;
	const duplicateInstances = sentences.length - uniqueSentences;
	return {
		totalSentences: sentences.length,
		uniqueSentences,
		duplicateInstances,
		duplicateRate: sentences.length > 0 ? duplicateInstances / sentences.length : 0
	};
}
/**
* 低雷同性：空话禁用词命中率 + 模糊应答词（附录一第 3 类，零出现要求）+ 套话密度超标扣分
* （docx L156：核心章节套话占比≤10%）+ 重复句式率（≥12 字符正文句去标点后重复比例）。
* 模糊应答扣分走语义复核口径（vagueSemanticSentences）：「力争上游/左右对称」等合法句词面命中不扣分。
* C0-4 长度归一校准：重复句预算 = 每万字 1 条（最少 10 条）——短文档不因个别合理复述被重罚、
* 长文档按篇幅摊薄（r28l 6 万字 17 条重复在旧口径扣 ~1 分，校准后扣 7 分；s28l 14.5 万字 25 条
* 校准后扣 10 分）；超出预算部分每条扣 1 分，与原比例扣分取较大值（短文档保持原口径）。
*/
function uniquenessScore(markdown, filler) {
	const forbiddenHits = FORBIDDEN_EMPTY_PHRASES.filter((phrase) => markdown.includes(phrase)).length;
	const vagueHitCount = filler.vagueSemanticSentences;
	const fillerPenalty = Math.max(0, filler.ratio - .1) * 100;
	const dup = duplicateSentenceStats(markdown);
	const dupBudget = Math.max(10, Math.ceil(documentTextLength(markdown) / 1e4));
	const dupExcess = Math.max(0, dup.duplicateInstances - dupBudget);
	const duplicatePenalty = Math.max(dup.duplicateRate * 60, dupExcess);
	return Math.max(0, Math.round(100 - forbiddenHits * 4 - vagueHitCount * 6 - fillerPenalty * .5 - duplicatePenalty));
}
/** 小节切分（C0-1 单源）：按标题行切分 markdown，聚合空行分界的实质段落。
* 空壳标题（无实质正文）保留在 sections 中（供评分细则映射层的「标题承接」partial 判定），
* 但不进入评分判定单元（splitScoringBlocks 消费）。 */
function splitScoringSections(markdown) {
	const rawSections = markdown.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").split(/(?=^#{1,6}\s)/mu);
	const sections = [];
	for (const raw of rawSections) {
		if (!raw.trim()) continue;
		const lines = raw.split("\n");
		const hasHeading = /^#{1,6}\s/u.test(lines[0] || "");
		const heading = hasHeading ? (lines[0] || "").trim() : "";
		const headingText = hasHeading ? normalizeHeadingTitle(heading.replace(/^#{1,6}\s+/u, "")) : "";
		const bodyLines = hasHeading ? lines.slice(1) : lines;
		const paragraphs = [];
		let current = [];
		for (const line of bodyLines) {
			if (!line.trim()) {
				if (current.length > 0) {
					paragraphs.push(current);
					current = [];
				}
				continue;
			}
			current.push(line);
		}
		if (current.length > 0) paragraphs.push(current);
		const substantiveParagraphs = [];
		for (const paragraph of paragraphs) {
			const kept = paragraph.filter((line) => !isTocClusterLine(line));
			if (kept.some((line) => isNarrativeLine(line))) substantiveParagraphs.push(kept.map((line) => line.trim()).join("\n"));
		}
		sections.push({
			heading,
			headingText,
			hasSubstantiveBody: substantiveParagraphs.length > 0,
			substantiveParagraphs
		});
	}
	return sections;
}
/** 段落切窗：命中文本=正文本体（C0 探针实测：去标题词后 r28l/s28l 真实成稿命中零损失
* 19/19，堆词样本模块命中 2/6→0——标题词不得构成语义证据「须同节正文含实体响应」），
* 超长段落按行累积切为 ≤600 字多窗（分段末内容不再沉入块中部被截断） */
function windowParagraph(paragraph) {
	const units = [];
	let buffer = [];
	let length = 0;
	for (const line of paragraph.split("\n")) {
		if (length > 0 && length + line.length > SCORING_UNIT_MAX_CHARS) {
			units.push(buffer.join("\n"));
			buffer = [];
			length = 0;
		}
		buffer.push(line);
		length += line.length + 1;
	}
	if (buffer.length > 0) units.push(buffer.join("\n"));
	return units;
}
/** 评分判定单元（C0-1 内容级判定）：标题不单独构成判定单元且不参与命中文本——单元=实质正文窗口。
* 空壳标题（无实质正文）不产出单元（r28l 实测：仅标题块命中 14/19、6 强制模块全部靠标题单独命中，
* 「### 1.1 编制说明与工程概况」类空壳标题误命中「编制专项施工方案」）；标题词的语义诱饵不计
* （标题承接由评分细则映射层 partial 独立判定）；目录聚簇行剔除、超长段落切窗。
* 导出供单测与对抗套件验证切分粒度。 */
function splitScoringBlocks(markdown) {
	const units = [];
	for (const section of splitScoringSections(markdown)) {
		if (!section.hasSubstantiveBody) continue;
		for (const paragraph of section.substantiveParagraphs) units.push(...windowParagraph(paragraph));
	}
	return units;
}
async function buildTenderBidScores(input) {
	const blocks = splitScoringBlocks(input.markdown);
	const querySimilarity = await buildSemanticSimilarity(blocks, [...MANDATORY_MODULE_QUERIES, ...COMPLIANCE_ITEM_QUERIES], input.embedDocuments);
	const anyBlockMatches = (query) => blocks.some((block) => querySimilarity(block, query) >= SEMANTIC_COVERAGE_THRESHOLD);
	const moduleCoverageRate = MANDATORY_MODULE_QUERIES.filter(anyBlockMatches).length / MANDATORY_MODULE_QUERIES.length;
	const filler = await fillerDensityReport(input.markdown, input.embedDocuments);
	return {
		completeness: completenessScore(input.markdown, input.chapters, input.template, moduleCoverageRate),
		specificity: specificityScore(input.chapters, input.factTraces),
		compliance: complianceScore(input.markdown, anyBlockMatches),
		executability: await executabilityScore(input.markdown),
		normalization: normalizationScore(input.issues),
		uniqueness: uniquenessScore(input.markdown, filler),
		moduleCoverageRate
	};
}
var FORBIDDEN_EMPTY_PHRASES, MANDATORY_MODULE_QUERIES, COMPLIANCE_ITEM_QUERIES, NORMALIZATION_ISSUE_RE, NORMALIZATION_EXCLUDE_RE, STRUCTURE_ISSUE_RE, SCORING_UNIT_MAX_CHARS;
var init_tenderBidScoring = __esmMin((() => {
	init_documentFactTrace();
	init_budget();
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
	MANDATORY_MODULE_QUERIES = [
		"危险性较大的分部分项工程安全管理",
		"扬尘污染防治措施",
		"建筑工人实名制管理",
		"农民工工资专用账户与工资支付保障",
		"生产安全事故应急预案与应急演练",
		"绿色施工与四节一环保措施"
	];
	COMPLIANCE_ITEM_QUERIES = [
		"危险源辨识与风险识别评估",
		"编制专项施工方案",
		"组织专家论证并履行审批程序",
		"对作业人员进行安全技术交底",
		"施工过程监测与监控量测",
		"分部分项工程验收",
		"三级配电系统",
		"两级漏电保护装置",
		"漏电保护器与接地保护",
		"实名制考勤与人员管理",
		"农民工工资专用账户银行代发",
		"应急预案编制与响应",
		"绿色施工措施与评价"
	];
	NORMALIZATION_ISSUE_RE = /目录|层级|编号|表格|表头|分隔线|页码|空小节|缺少规划小节|小节只有标题|缺节/u;
	NORMALIZATION_EXCLUDE_RE = /跨章一致性复核|事实一致性冲突|事实冲突|评分项要求|可靠精确参数|应急预案|属地创优|工伤保险|专业评分|深度不足|事实反查|存在多个值|已确认事实未在正文中落位|事实未在正文中落位/u;
	STRUCTURE_ISSUE_RE = /缺少规划小节|小节只有标题|空小节|只有标题或表格无正文|小节内容补写未完成|小节生成未达标|同名小节|H4 标题|正文缺少章节标题|小节正文过短/u;
	SCORING_UNIT_MAX_CHARS = 600;
}));
//#endregion
//#region apps/server/src/services/document-workflow/constants.ts
var CN_NUMERAL_RE;
var init_constants$1 = __esmMin((() => {
	CN_NUMERAL_RE = "[零〇一二三四五六七八九十百千万两]+";
}));
//#endregion
//#region apps/server/src/services/document-workflow/templatingGovernance.ts
var STRUCTURE_LABEL_BAN_LINE, SKELETON_FINGERPRINT_BAN_LINE;
var init_templatingGovernance = __esmMin((() => {
	STRUCTURE_LABEL_BAN_LINE = "正文禁止以“施工概况/施工流程/施工方法/工艺流程/施工步骤”等结构标签充当小节标题或段落开头引导（不得出现“施工概况：本项目……”式标签行），要素内容直接融入连贯段落叙述。";
	SKELETON_FINGERPRINT_BAN_LINE = "句式禁止复读：全篇「由技术负责人组织」「合格后方可」「验收合格后」三类骨架表述各自不得超过 2 次，任何同义替换表达全篇不得超过 8 次；同义表达必须逐句轮换、句式多样（动词与语序随句变化），不得集中复用同一说法，保持事实不变（岗位、数值、频次不得丢失）。";
}));
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
	init_outline$1();
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
var OUTLINE_TAG_NAME_RE;
var init_outline$1 = __esmMin((() => {
	init_constants$1();
	init_templateStore();
	new RegExp(`^(?:第(?:\\d{1,3}|${CN_NUMERAL_RE})[章节]|\\d{1,3}[、)）]|\\d{1,3}[.．]\\s|(?:${CN_NUMERAL_RE})[、.．)）])`, "u");
	OUTLINE_TAG_NAME_RE = "(?:OUTLINE|CHAPTERS?|章节(?:大纲)?|大纲|目录)";
	new RegExp(`<\\s*${OUTLINE_TAG_NAME_RE}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\s*${OUTLINE_TAG_NAME_RE}\\s*>`, "giu");
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
}));
//#endregion
//#region apps/server/src/services/document-workflow/drawingFactLock.ts
var init_drawingFactLock = __esmMin((() => {
	init_evidence();
})), EQUIPMENT_NAME_SUFFIX_SOURCE;
var init_resourceBreakdownNumbers = __esmMin((() => {
	EQUIPMENT_NAME_SUFFIX_SOURCE = "机|吊|泵|车|夯";
	new RegExp(`([\\p{Script=Han}A-Za-z0-9]{2,8}(?:${EQUIPMENT_NAME_SUFFIX_SOURCE}))$`, "u");
}));
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
var init_tenderRequirements = __esmMin((() => {
	init_llmClient();
	init_generatedDocumentService();
	init_factsModel();
	init_evidenceContentSafety();
	init_markdownComposer();
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
var init_chapterParameterFacts = __esmMin((() => {
	init_factsModel();
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
	init_stagePhrasing();
	init_emergencySectionDepth();
	init_outline$1();
	init_integratedBlueprint();
	init_detectorFixerRegistry();
}));
//#endregion
//#region apps/server/src/services/document-workflow/evaluationCriteriaMapping.ts
async function buildEvaluationCriteriaAttainmentAudit(input) {
	const items = input.items.map((item) => item.trim()).filter(Boolean);
	if (items.length === 0) return {
		total: 0,
		met: 0,
		partial: 0,
		missing: 0,
		simulatedScore: 0,
		criteria: []
	};
	const units = splitScoringBlocks(input.markdown);
	const headings = splitScoringSections(input.markdown).map((section) => section.heading).filter(Boolean);
	const narrativeText = narrativeSentences(input.markdown).join("");
	const similarity = await buildSemanticSimilarity([...units, ...headings], items, input.embedDocuments);
	const criteria = items.map((item, index) => {
		const keywords = evaluationCriteriaCoreKeywords(item);
		const keywordHit = keywords.length > 0 && keywords.some((keyword) => narrativeText.includes(keyword));
		let bestUnit = "";
		let bestUnitSimilarity = 0;
		for (const unit of units) {
			const value = similarity(unit, item);
			if (value > bestUnitSimilarity) {
				bestUnitSimilarity = value;
				bestUnit = unit;
			}
		}
		if (keywordHit || bestUnitSimilarity >= .6) return {
			index,
			title: item,
			status: "met",
			similarity: bestUnitSimilarity,
			anchor: bestUnit ? bestUnit.split("\n")[0].replace(/^#{1,6}\s+/u, "").slice(0, 80) : void 0
		};
		let bestHeading = "";
		let bestHeadingSimilarity = 0;
		for (const heading of headings) {
			const value = similarity(heading, item);
			if (value > bestHeadingSimilarity) {
				bestHeadingSimilarity = value;
				bestHeading = heading;
			}
		}
		if (bestHeadingSimilarity >= .6) return {
			index,
			title: item,
			status: "partial",
			similarity: bestHeadingSimilarity,
			anchor: bestHeading.replace(/^#{1,6}\s+/u, "").slice(0, 80)
		};
		return {
			index,
			title: item,
			status: "missing",
			similarity: bestHeadingSimilarity
		};
	});
	const met = criteria.filter((entry) => entry.status === "met").length;
	const partial = criteria.filter((entry) => entry.status === "partial").length;
	const missing = criteria.filter((entry) => entry.status === "missing").length;
	const simulatedScore = Math.round((met + .5 * partial) / criteria.length * 100);
	return {
		total: criteria.length,
		met,
		partial,
		missing,
		simulatedScore,
		criteria
	};
}
var init_evaluationCriteriaMapping = __esmMin((() => {
	init_semanticSimilarity();
	init_qualityValidation();
	init_narrativeContext();
	init_tenderBidScoring();
}));
//#endregion
//#region apps/server/src/services/document-workflow/scoringCalibration.ts
var SCORING_CALIBRATION_VERSION, PROFESSIONAL_SCORE_CALIBER;
var init_scoringCalibration = __esmMin((() => {
	SCORING_CALIBRATION_VERSION = "quality-caliber-c0.1";
	PROFESSIONAL_SCORE_CALIBER = {
		version: SCORING_CALIBRATION_VERSION,
		role: "secondary",
		relatedTo: "quality-report"
	};
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
/** 招标评分条目标题 → 核心关键词集：去框架前缀/括号/尾缀后按顿号及与切分，供正文命中检查 */
function evaluationCriteriaCoreKeywords(title) {
	return title.replace(/^拟采用/u, "").replace(/^针对/u, "").replace(/^确保/u, "").replace(/[（(][^）)]*[）)]/gu, "").replace(/的保障体系与措施$|管理体系与措施$|保障体系与措施$/u, "").replace(/^\d{1,3}(?:[.、．]\d{1,3})*\s*/u, "").trim().split(/[、，,；;及与和]+/u).map((part) => part.replace(/^[的了者]+/u, "").trim()).filter((part) => part.length >= 2 && !CRITERIA_CORE_STOP_WORDS.has(part));
}
var CRITERIA_CORE_STOP_WORDS;
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
	CRITERIA_CORE_STOP_WORDS = new Set([
		"如有",
		"应用",
		"措施",
		"体系",
		"管理",
		"保障",
		"要求",
		"内容",
		"工程",
		"项目",
		"施工"
	]);
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
//#region apps/server/src/services/document-workflow/constructionOrgAudit.ts
/** 构建废话段语义 gate：正则召回 + 语义复核（semanticGate 统一入口） */
async function buildFillerParagraphGate(embedDocuments) {
	return buildSemanticGate({
		prototypes: [...FILLER_PARAGRAPH_SEMANTIC_PROTOTYPES],
		negativePrototypes: [...FILLER_LEGAL_PROTOTYPES],
		lexicalHints: FILLER_PARAGRAPH_LEXICAL_RE,
		embedDocuments
	});
}
function extractSectionBlocks(content) {
	const lines = content.split("\n");
	const blocks = [];
	let currentHeading = "";
	let currentBody = [];
	for (const line of lines) {
		const heading = /^#{3,4}\s+(.+)$/u.exec(line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim());
		if (heading) {
			if (currentHeading || currentBody.length > 0) blocks.push({
				heading: currentHeading,
				body: currentBody.join("\n")
			});
			currentHeading = heading[1].trim();
			currentBody = [];
		} else currentBody.push(line);
	}
	if (currentHeading || currentBody.length > 0) blocks.push({
		heading: currentHeading,
		body: currentBody.join("\n")
	});
	return blocks;
}
function normalizeParagraph(text) {
	return text.replace(/[，。,.;；:：、（）()【】[\]《》“”"'`\s]/gu, "");
}
/** 从正文中提取段落（按句号分段的完整句组，长度≥60 字的才算可重复段落） */
function extractParagraphs(body) {
	return body.replace(/^#{1,6}\s+.*$/gmu, "").replace(/^\s*\|.*\|\s*$/gmu, "").replace(/^\s*[-|]\s*$/gmu, "").replace(/^\s*\[.*?\]\(.*?\)\s*$/gmu, "").split(/\n{1,}/u).map((item) => item.trim()).filter((item) => item.length >= 60 && item.length <= 400 && !/^\s*[-*]\s+/u.test(item));
}
/** 1. 跨小节重复段落检测：同一段落出现在 ≥2 个不同小节即为重复 */
function duplicateParagraphIssues(chapters) {
	const issues = [];
	const paragraphLocations = /* @__PURE__ */ new Map();
	for (const chapter of chapters) {
		const blocks = extractSectionBlocks(chapter.content);
		for (const block of blocks) {
			const section = block.heading || chapter.title;
			for (const paragraph of extractParagraphs(block.body)) {
				const key = normalizeParagraph(paragraph);
				if (key.length < 60) continue;
				const locations = paragraphLocations.get(key) || [];
				if (!locations.some((item) => item.chapter === chapter.title && item.section === section)) locations.push({
					chapter: chapter.title,
					section
				});
				paragraphLocations.set(key, locations);
			}
		}
	}
	const reported = /* @__PURE__ */ new Set();
	for (const [key, locations] of paragraphLocations) {
		const uniqueLocations = locations.filter((item, index, array) => array.findIndex((other) => other.chapter === item.chapter && other.section === item.section) === index);
		if (uniqueLocations.length < 2) continue;
		const fingerprint = uniqueLocations.map((item) => `${item.chapter}::${item.section}`).sort().join("|");
		if (reported.has(fingerprint)) continue;
		reported.add(fingerprint);
		const sample = locations[0];
		const preview = sample ? `（如：${sample.section} 中「${key.slice(0, 30)}…」）` : "";
		issues.push({
			level: uniqueLocations.length >= 3 ? "error" : "warning",
			severity: uniqueLocations.length >= 3 ? "blocker" : "warning",
			message: `发现相同段落出现在 ${uniqueLocations.length} 个不同小节：${uniqueLocations.map((item) => item.section).slice(0, 6).join("、")}${preview}`,
			suggestion: "每个小节必须针对其标题写专属内容，不得复制粘贴相同段落；重复小节应合并或删除后重写。"
		});
		if (issues.length >= 8) break;
	}
	return issues;
}
/** 2. 废话段落模式检测：正则召回 → 句级语义复核（bge 余弦 ≥ 阈值才计命中），具体量化措施负例放行 */
async function fillerParagraphIssues(chapters, embedDocuments) {
	const issues = [];
	const judge = await buildFillerParagraphGate(embedDocuments);
	for (const chapter of chapters) {
		const blocks = extractSectionBlocks(chapter.content);
		const chapterHits = [];
		for (const block of blocks) {
			const sentences = block.body.split(/\n/u).filter((line) => !isFillerPoolExcludedLine(line)).flatMap((line) => line.split(/[。；;]/u)).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 12);
			if (sentences.length === 0) continue;
			const flags = await judge(sentences);
			sentences.forEach((sentence, index) => {
				if (!flags[index]) return;
				for (const { pattern, label } of FILLER_PARAGRAPH_PATTERNS) if (pattern.test(sentence) && !chapterHits.includes(label)) chapterHits.push(label);
			});
		}
		if (chapterHits.length >= 3) issues.push({
			level: "error",
			severity: "blocker",
			message: `${chapter.title} 存在大量模板化空话（${chapterHits.slice(0, 6).join("、")}）`,
			suggestion: "删除\"本小节围绕…展开\"\"按100%控制\"式套话，按\"责任岗位+执行动作+量化标准+检查频次+整改时限\"重写。"
		});
		else if (chapterHits.length > 0) issues.push({
			level: "warning",
			severity: "warning",
			message: `${chapter.title} 存在模板化空话：${chapterHits.join("、")}`,
			suggestion: "替换为具体量化做法；同一小节不得重复出现套话段落。"
		});
	}
	return issues;
}
function processParameterDensityIssues(chapters) {
	const issues = [];
	for (const chapter of chapters) {
		const blocks = extractSectionBlocks(chapter.content);
		for (const block of blocks) {
			if (!WORK_PACKAGE_SECTION_PATTERNS.some((pattern) => pattern.test(block.heading) || pattern.test(chapter.title))) continue;
			if (/(?:方案管理|管理程序|管理流程|管理制度|审批流程)/u.test(block.heading)) continue;
			const processParams = new Set(block.body.match(PROCESS_PARAMETER_RE) || []);
			const basicFacts = new Set(block.body.match(BASIC_FACT_RE) || []);
			const deviceSpecs = new Set(block.body.match(DEVICE_SPEC_RE) || []);
			const bodyChars = block.body.length;
			if (bodyChars < 400) continue;
			const density = processParams.size / (bodyChars / 1e3);
			const isDemolitionSection = /拆除|清理|清底|清运|弃置|运输|搬运/u.test(block.heading);
			if (processParams.size === 0) {
				if (deviceSpecs.size >= 6) {
					issues.push({
						level: "warning",
						severity: "warning",
						message: `${chapter.title} / ${block.heading} 以设备配置参数为主：设备型号/容量参数 ${deviceSpecs.size} 项，工艺参数待补充`,
						suggestion: "设备清单型小节保留型号规格参数即可；如补充安装工艺（试验压力、坡度、间距、偏差），应同步写入工艺参数与验收节点。"
					});
					continue;
				}
				if (isDemolitionSection) {
					issues.push({
						level: "warning",
						severity: "warning",
						message: `${chapter.title} / ${block.heading} 以工程量与保护措施为主，建议补充拆除深度偏差、保护挑网宽度、警戒距离等参数`,
						suggestion: "拆除类作业补充拆除厚度偏差（mm）、防护挑网/安全网宽度（m）、警戒区距离（m）等安全与技术参数即可，不强制 mm/MPa 级工艺参数。"
					});
					continue;
				}
				issues.push({
					level: "error",
					severity: "blocker",
					message: `${chapter.title} / ${block.heading} 无工艺参数：全文只有概况性数字，缺乏 mm/MPa/间距/偏差/试验压力等工艺级参数`,
					suggestion: "必须写入工艺参数（如桩位偏差≤50mm、搭接宽度≥100mm、闭水试验48h），参数来自绑定资料或行业规范值。"
				});
			} else if (density < (isDemolitionSection ? .3 : 1.5)) issues.push({
				level: "warning",
				severity: "warning",
				message: `${chapter.title} / ${block.heading} 工艺参数密度偏低：每千字 ${processParams.size} 个工艺参数（概况数字 ${basicFacts.size} 个）`,
				suggestion: "增加工艺级参数落位；概况数字（面积、工期、层数）不能替代工艺参数。"
			});
		}
	}
	return issues;
}
/** 4. 工作包内容要素完整性（作业对象与工程量/工序顺序/施工方法；呈现形式不限，标签不强制） */
function sectionCardStructureIssues(chapters) {
	const issues = [];
	for (const chapter of chapters) {
		const lines = chapter.content.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index].trim();
			if (!/^#{3}\s+[^\n]*(?:主要分部分项工程施工方案|主要施工方法)/u.test(line)) continue;
			let end = lines.length;
			for (let cursor = index + 1; cursor < lines.length; cursor += 1) if (/^#{2,3}\s+/u.test(lines[cursor].trim())) {
				end = cursor;
				break;
			}
			const subPackages = lines.slice(index + 1, end).join("\n").split(/^####\s+/gmu).slice(1).map((item) => item.trim()).filter(Boolean);
			if (subPackages.length === 0) continue;
			const incomplete = subPackages.filter((pkg) => !workPackageContentElementsComplete(pkg));
			if (incomplete.length > 0) issues.push({
				level: "error",
				severity: "blocker",
				message: `${chapter.title} / ${line.replace(/^#{3}\s+(?:\d+(?:\.\d+)*\s+)?/u, "")} 有 ${incomplete.length}/${subPackages.length} 个分部分项内容要素不全（作业对象与工程量/工序顺序/施工方法至少缺一）`,
				suggestion: "每个分项方案需覆盖作业对象与工程量、工序安排、施工方法三方面要素，融入连贯段落叙述（禁止以“施工概况/工艺流程/施工方法”等结构标签充当标题或段落开头引导）；工序顺序表达形式按分项序号轮换使用（顺序词叙述、编号步骤、有序列表、箭头链），禁止相邻分项同一形式。"
			});
		}
	}
	return issues;
}
var FILLER_PARAGRAPH_PATTERNS, FILLER_PARAGRAPH_LEXICAL_RE, FILLER_PARAGRAPH_SEMANTIC_PROTOTYPES, FILLER_LEGAL_PROTOTYPES, WORK_PACKAGE_SECTION_PATTERNS, BASIC_FACT_RE;
var init_constructionOrgAudit = __esmMin((() => {
	init_markdownCleanup();
	init_parameterPatterns();
	init_semanticGate();
	init_tenderBidChecks();
	init_utils();
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
	FILLER_PARAGRAPH_LEXICAL_RE = new RegExp(FILLER_PARAGRAPH_PATTERNS.map((item) => `(?:${item.pattern.source})`).join("|"), "u");
	FILLER_PARAGRAPH_SEMANTIC_PROTOTYPES = [
		"本小节围绕以下内容展开并结合绑定项目资料",
		"明确适用范围控制目标责任岗位与过程要求",
		"实施前应完成资料核对技术交底和作业条件确认",
		"交底覆盖率按100%控制",
		"关键问题在24小时内形成整改责任",
		"按施工准备过程实施检查验收问题整改资料归档的闭环组织",
		"依据本项目已确认资料中的项目边界",
		"执行日巡查周复核和节点验收制度",
		"一般问题7日内闭环",
		"由项目经理技术负责人和专职安全员联合复核",
		"确保与总体施工部署工期计划和验收要求保持一致",
		"结合现场实际情况合理组织安排",
		"严格执行国家现行有关规范标准",
		"做到文明施工安全生产质量第一",
		"确保工程质量和安全进度",
		"建立健全管理体系并落实相关制度"
	];
	FILLER_LEGAL_PROTOTYPES = [
		"每道工序完成后由质检员实测实量并记录数据",
		"混凝土浇筑完成后每天洒水养护不少于两次",
		"每周组织不少于一次的现场安全专项检查"
	];
	WORK_PACKAGE_SECTION_PATTERNS = [
		/主要分部分项工程施工方案/u,
		/主要施工方法/u,
		/主要施工内容/u,
		/施工方案/u
	];
	BASIC_FACT_RE = /(?:建筑面积|面积|总建筑面积)[约]?\s*\d+(?:\.\d+)?\s*(?:㎡|m²)|计划工期\s*\d+|日历天|地上\s*\d+\s*层|框架结构|质量标准[:：]?\s*合格/giu;
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentProfessionalScore.ts
function clamp(value) {
	return Math.max(0, Math.min(100, Math.round(value)));
}
/** 1. 结构完整度：核心结构组是否齐备（章级叙述字数门禁：叙述正文不足的章不计命中） */
function structureScore(chapters) {
	const wholeText = chapters.map((chapter) => `${chapter.title} ${(chapter.sections || []).join(" ")} ${chapter.content}`).filter((text) => narrativeCharCount(text) >= STRUCTURE_NARRATIVE_GATE_CHARS).join("\n");
	const groups = [
		{
			label: "工程概况",
			pattern: /工程概况|项目概况|基本概况/u
		},
		{
			label: "主要施工内容",
			pattern: /主要施工内容/u
		},
		{
			label: "重难点分析",
			pattern: /重点.{0,4}难点/u
		},
		{
			label: "施工部署",
			pattern: /施工部署|总体部署|流水/u
		},
		{
			label: "进度计划",
			pattern: /进度计划|工期保障|工期计划/u
		},
		{
			label: "质量保证",
			pattern: /质量保证|质量管理|质量控制/u
		},
		{
			label: "安全文明",
			pattern: /安全.{0,8}(?:管理|措施|文明)|文明施工/u
		},
		{
			label: "资源配置",
			pattern: /劳动力|机械设备|材料.{0,4}计划|资源配置/u
		},
		{
			label: "绿色环保",
			pattern: /绿色施工|扬尘|噪声|环保/u
		},
		{
			label: "应急管理",
			pattern: /应急/u
		}
	];
	const hit = groups.filter((group) => group.pattern.test(wholeText));
	const score = clamp(hit.length / groups.length * 100);
	const missing = groups.filter((group) => !group.pattern.test(wholeText)).map((group) => group.label);
	return {
		score,
		detail: `覆盖 ${hit.length}/${groups.length} 个核心结构组${missing.length ? `；缺失：${missing.join("、")}` : ""}`
	};
}
/** 2. 事实落位率：量化数字与项目事实覆盖（C0-2：token 仅从叙述句提取，罗列段不计）。
* 标尺校准：量化密度系数 18→22；事实词按 18 类覆盖率计分（类数/18×15），消除长文档字数稀释。 */
function factLandingScore(chapters) {
	const wholeText = chapters.map((chapter) => chapter.content).join("\n");
	const quantified = extractContextualTokens(wholeText, QUANTIFIED_BODY_PARAM_RE);
	const factTokens = extractContextualTokens(wholeText, /工程量|材料|设备|范围|流程|验收|检测|复试|调试|隐蔽|检验批|资料|记录|系统|部位|接口|规格|标准/gu);
	const totalChars = Math.max(1, wholeText.length);
	const quantifiedDensity = quantified.size / (totalChars / 1e3);
	return {
		score: clamp(Math.min(100, quantifiedDensity * 22 + factTokens.size / 18 * 15)),
		detail: `量化参数 ${quantified.size} 项（每千字 ${quantifiedDensity.toFixed(1)}），专业事实词 ${factTokens.size}/18 类`
	};
}
/** 3. 工艺参数密度（C0-2：token 仅从叙述句提取，参数堆叠串不计）。
* 标尺校准：口径扩展为参数库统一口径（强度等级 M5.0/C25、体积面积 m³/m²、绝缘电阻 MΩ、养护时间等）；
* 公式由 密度×12+20 调整为 密度×20+40，与参考库优秀样本锚定。 */
function processParameterScore(chapters) {
	const wholeText = chapters.map((chapter) => chapter.content).join("\n");
	const processParams = extractContextualTokens(wholeText, PROCESS_PARAMETER_RE);
	const totalChars = Math.max(1, wholeText.length);
	const density = processParams.size / (totalChars / 1e3);
	return {
		score: clamp(Math.min(100, density * 20 + 40)),
		detail: `工艺参数 ${processParams.size} 项（每千字 ${density.toFixed(1)}）`
	};
}
/** 4. 表格完整度 */
function tableScore(chapters, markdown = "") {
	const lines = (markdown || chapters.map((chapter) => chapter.content).join("\n\n")).split("\n");
	let tableCount = 0;
	let completeTables = 0;
	let index = 0;
	while (index < lines.length) {
		const line = lines[index].trim();
		if (!/^\|.+\|$/u.test(line)) {
			index += 1;
			continue;
		}
		const tableLines = [];
		while (index < lines.length && /^\|.+\|$/u.test(lines[index].trim())) {
			tableLines.push(lines[index].trim());
			index += 1;
		}
		if (tableLines.length < 3) continue;
		tableCount += 1;
		if (tableLines.slice(1).filter((row) => row.replace(/\|/gu, "").replace(/[\s\-:]/gu, "").length > 0).reduce((total, row) => {
			return total + row.split("|").slice(1, -1).map((cell) => stripTableCellInvisibleChars(cell.trim())).filter((cell) => cell === "" || cell === "-" || cell === "—" || cell === "/").length;
		}, 0) === 0) completeTables += 1;
	}
	return {
		score: tableCount === 0 ? 40 : clamp(completeTables / tableCount * 100),
		detail: `表格 ${tableCount} 个，其中字段完整 ${completeTables} 个`
	};
}
/** 5. 废话率（反比）：叠加 docx 套话密度口径（核心章节套话占比 ≤10%，超标线性扣分） */
async function fillerScore(chapters) {
	const fillerIssues = await fillerParagraphIssues(chapters);
	const fillerHits = chapters.reduce((total, chapter) => {
		return total + (chapter.content.match(/本小节围绕|交底覆盖率按100%|24小时内形成整改责任|按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织|按作业条件确认→技术交底→过程实施|依据本项目已确认资料中的项目边界/gu) || []).length;
	}, 0);
	const filler = await fillerDensityReport(chapters.map((chapter) => chapter.content).join("\n"));
	const ratioPenalty = Math.max(0, filler.ratio - .1) * 400;
	return {
		score: clamp(100 - fillerHits * 15 - fillerIssues.filter((issue) => issue.level === "error").length * 25 - ratioPenalty),
		detail: `模板化空话命中 ${fillerHits} 处，套话句占比 ${(filler.ratio * 100).toFixed(1)}%（docx 达标线 ≤10%），废话段问题 ${fillerIssues.length} 项`
	};
}
/** 6. 重复率（反比） */
function duplicationScore(chapters) {
	const duplicateIssues = duplicateParagraphIssues(chapters);
	return {
		score: clamp(100 - duplicateIssues.length * 20 - duplicateIssues.filter((issue) => issue.level === "error").length * 20),
		detail: `重复段落问题 ${duplicateIssues.length} 项`
	};
}
/** 7. 评标响应度：招标硬性要求响应检测统一由 tenderRequirements.ts 锚点级语义通道
* （requirementAcceptanceIssues）承担，本维度仅保留评分用的词面响应率快照，
* 不再复用已删除的 constructionOrgAudit.reviewResponseIssues（阶段五 5.3 口径分裂治理）。
* C0-2 语境约束：响应词必须与承诺语境同句出现（叙述句内）——词表行/标题行内出现响应词
* 不构成响应（历史实测：无完整句的响应词表文档评标响应 100 分）。 */
function reviewResponseScore(chapters, markdown = "") {
	const sentences = narrativeSentences(markdown || chapters.map((chapter) => chapter.content).join("\n\n"));
	const responseItems = [
		{
			label: "质量标准",
			pattern: /质量标准|质量要求|合格率/u
		},
		{
			label: "计划工期",
			pattern: /计划工期|工期要求|日历天/u
		},
		{
			label: "保修",
			pattern: /缺陷责任期|保修|质保/u
		},
		{
			label: "安全目标",
			pattern: /安全.{0,8}目标|文明.{0,8}目标/u
		},
		{
			label: "项目经理",
			pattern: /项目经理|项目负责人/u
		}
	];
	const hit = responseItems.filter((item) => sentences.some((sentence) => item.pattern.test(sentence) && sentenceHasCommitmentContext(sentence)));
	const missed = responseItems.filter((item) => !hit.includes(item));
	return {
		score: clamp(hit.length / responseItems.length * 100),
		detail: `招标硬性要求响应 ${hit.length}/${responseItems.length} 项${missed.length ? `（未响应：${missed.map((item) => item.label).join("、")}）` : ""}`
	};
}
async function buildProfessionalScoreReport(chapters, markdown = "", options = {}) {
	const structure = structureScore(chapters);
	const factLanding = factLandingScore(chapters);
	const processParameter = processParameterScore(chapters);
	const table = tableScore(chapters, markdown);
	const filler = await fillerScore(chapters);
	const duplication = duplicationScore(chapters);
	const reviewResponse = reviewResponseScore(chapters, markdown);
	const dimensions = [
		{
			key: "structure",
			label: "结构完整度",
			score: structure.score,
			detail: structure.detail,
			weight: .18
		},
		{
			key: "factLanding",
			label: "事实落位率",
			score: factLanding.score,
			detail: factLanding.detail,
			weight: .18
		},
		{
			key: "processParameter",
			label: "工艺参数密度",
			score: processParameter.score,
			detail: processParameter.detail,
			weight: .16
		},
		{
			key: "table",
			label: "表格完整度",
			score: table.score,
			detail: table.detail,
			weight: .12
		},
		{
			key: "filler",
			label: "废话控制",
			score: filler.score,
			detail: filler.detail,
			weight: .14
		},
		{
			key: "duplication",
			label: "重复控制",
			score: duplication.score,
			detail: duplication.detail,
			weight: .12
		},
		{
			key: "reviewResponse",
			label: "评标响应度",
			score: reviewResponse.score,
			detail: reviewResponse.detail,
			weight: .1
		}
	];
	const total = clamp(dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0));
	const cappedTotal = options.templating?.level === "heavy" ? Math.min(total, 54) : options.templating?.level === "medium" ? Math.min(total, 69) : total;
	const grade = cappedTotal >= 85 ? "专业" : cappedTotal >= 70 ? "良好" : cappedTotal >= 55 ? "合格" : "待提升";
	const topIssues = [
		...duplicateParagraphIssues(chapters),
		...await fillerParagraphIssues(chapters),
		...processParameterDensityIssues(chapters),
		...sectionCardStructureIssues(chapters)
	].slice(0, 5).map((issue) => issue.message);
	const weakDimensions = dimensions.filter((dimension) => dimension.score < 70).map((dimension) => `${dimension.label}（${dimension.score}分）`);
	return {
		total: cappedTotal,
		grade,
		dimensions,
		summary: `施工组织设计专业度评分 ${cappedTotal} 分（${grade}；从属口径，交付主尺见六维质量报告）${options.templating && options.templating.level !== "light" ? `；模板化等级：${options.templating.level === "heavy" ? "重度" : "中度"}（降档已生效）` : ""}${weakDimensions.length ? `；待提升：${weakDimensions.join("、")}` : ""}`,
		topIssues,
		caliber: PROFESSIONAL_SCORE_CALIBER
	};
}
var STRUCTURE_NARRATIVE_GATE_CHARS;
var init_documentProfessionalScore = __esmMin((() => {
	init_constructionOrgAudit();
	init_markdownCleanup();
	init_parameterPatterns();
	init_tenderBidChecks();
	init_narrativeContext();
	init_scoringCalibration();
	STRUCTURE_NARRATIVE_GATE_CHARS = 200;
}));
//#endregion
//#region .dbg/meta-audit.ts
/**
* 评分机制元审计・对抗套件正式化（C0-6，repair-master-plan-v3 C0 闭合动作⑥）：
* 四类历史骗分样本在真实 bge 语义下逐项断言（标题党/堆词/空壳/词面垃圾）+ 正面守护 + r28l 真实成稿回归。
* 与 vitest scoringAdversarial.test.ts（mock 语义，日常回归）互为表里；本脚本为轮次级真模型验证，
* 评分机制任何变更（权重/公式/判定口径）必跑——断言失败即 exit 1（red）。
* 运行（bge 在 vitest 不可用，rolldown 打包 + 真 Node 执行）：
*   node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-meta-audit.config.mjs
*   node apps/server/.audit-out/meta-audit.mjs
*/
var require_meta_audit = /* @__PURE__ */ __commonJSMin((() => {
	init_tenderBidScoring();
	init_semanticSimilarity();
	init_documentProfessionalScore();
	init_evaluationCriteriaMapping();
	const DRAFT = "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884268681-31f4980c.json";
	const QUERIES = [...MANDATORY_MODULE_QUERIES, ...COMPLIANCE_ITEM_QUERIES];
	const failures = [];
	function assert(label, condition, detail) {
		console.log(`${condition ? "PASS" : "FAIL"} | ${label} —— ${detail}`);
		if (!condition) failures.push(label);
	}
	const dimensionOf = (report, key) => report.dimensions.find((item) => item.key === key)?.score ?? -1;
	async function main() {
		console.log("=== 样本①：标题党（纯标题无正文）===");
		const titleOnly = [
			"# 扬尘污染防治措施",
			"## 建筑工人实名制管理",
			"### 农民工工资专用账户与工资支付保障",
			"#### 生产安全事故应急预案与应急演练",
			"##### 绿色施工与四节一环保措施",
			"###### 危险性较大的分部分项工程安全管理",
			"## 编制专项施工方案"
		].join("\n");
		assert("①-1 纯标题不产出判定单元", splitScoringBlocks(titleOnly).length === 0, `块数=${splitScoringBlocks(titleOnly).length}`);
		const titleScores = await buildTenderBidScores({
			markdown: titleOnly,
			chapters: [],
			template: null,
			factTraces: [],
			issues: []
		});
		assert("①-2 模块覆盖率归零（旧口径 6/6 靠标题）", titleScores.moduleCoverageRate === 0, `moduleRate=${titleScores.moduleCoverageRate}`);
		assert("①-3 合规归零（旧口径应急覆盖率骗分）", titleScores.compliance === 0, `compliance=${titleScores.compliance}`);
		const titleAttainment = await buildEvaluationCriteriaAttainmentAudit({
			items: ["扬尘污染防治措施", "建筑工人实名制管理"],
			markdown: titleOnly
		});
		assert("①-4 评分细则映射不判 met（至多 partial）", titleAttainment.met === 0 && titleAttainment.criteria.every((entry) => entry.status !== "met"), `met=${titleAttainment.met}`);
		console.log("\n=== 样本②：堆词（结构词+响应词+参数串，无完整句）===");
		const stuffed = [
			"# 第一章 工程概况 主要施工内容 重难点分析 施工部署 进度计划 质量保证 安全文明施工 资源配置 绿色环保 应急管理",
			"",
			"质量标准 计划工期 日历天 缺陷责任期 保修 安全目标 文明施工目标 项目经理 项目负责人",
			"",
			"C30，C25，C35，M5.0，M7.5，HRB400，HRB335，Q235，Q345，QTZ80，SC200，12000m²，420日历天，24个月，1500mm，900mm，200mm",
			"",
			"本小节围绕按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织"
		].join("\n");
		const stuffedReport = await buildProfessionalScoreReport([{
			id: "meta-ch1",
			title: "第一章 工程概况",
			content: stuffed,
			sections: []
		}], stuffed);
		assert("②-1 结构分归零（旧口径 100）", dimensionOf(stuffedReport, "structure") === 0, `structure=${dimensionOf(stuffedReport, "structure")}`);
		assert("②-2 事实落位 ≤5（旧口径 100）", dimensionOf(stuffedReport, "factLanding") <= 5, `factLanding=${dimensionOf(stuffedReport, "factLanding")}`);
		assert("②-3 评标响应归零（旧口径 100）", dimensionOf(stuffedReport, "reviewResponse") === 0, `reviewResponse=${dimensionOf(stuffedReport, "reviewResponse")}`);
		assert("②-4 专业总分 ≤45（旧口径 87）", stuffedReport.total <= 45, `total=${stuffedReport.total}（${stuffedReport.grade}）`);
		const stuffedScores = await buildTenderBidScores({
			markdown: stuffed,
			chapters: [],
			template: null,
			factTraces: [],
			issues: []
		});
		assert("②-5 模块覆盖归零（合规 ≤10 边际残留）", stuffedScores.moduleCoverageRate === 0 && stuffedScores.compliance <= 10, `moduleRate=${stuffedScores.moduleCoverageRate} compliance=${stuffedScores.compliance}`);
		console.log("\n=== 样本③：空壳（标题+目录聚簇行+表头骨架）===");
		const shell = [
			"## 施工部署",
			"第一章 工程概况 1.1 编制说明与工程概况 1.2 编制依据 1.3 工程范围",
			"",
			"## 扬尘污染防治措施",
			"| 序号 | 措施 | 标准 |",
			"| --- | --- | --- |"
		].join("\n");
		assert("③-1 目录/表头骨架不产出判定单元", splitScoringBlocks(shell).length === 0, `块数=${splitScoringBlocks(shell).length}`);
		const shellScores = await buildTenderBidScores({
			markdown: shell,
			chapters: [],
			template: null,
			factTraces: [],
			issues: []
		});
		assert("③-2 模块覆盖率归零（旧口径目录行命中「编制专项施工方案」）", shellScores.moduleCoverageRate === 0, `moduleRate=${shellScores.moduleCoverageRate}`);
		console.log("\n=== 样本④：词面垃圾（响应词表行，无承诺语境）===");
		const wordSurface = "质量标准 计划工期 日历天 缺陷责任期 保修 安全目标 文明施工目标 项目经理 项目负责人";
		const surfaceReport = await buildProfessionalScoreReport([{
			id: "meta-ch2",
			title: "质量目标",
			content: wordSurface,
			sections: []
		}], `## 质量目标\n${wordSurface}`);
		assert("④-1 词表行不判响应（旧口径词面命中即 100）", dimensionOf(surfaceReport, "reviewResponse") === 0, `reviewResponse=${dimensionOf(surfaceReport, "reviewResponse")}`);
		const positive = ["## 质量目标", "本工程质量标准为合格，计划工期420日历天，缺陷责任期24个月，安全目标零事故，项目经理常驻现场负责履约。"].join("\n");
		const positiveReport = await buildProfessionalScoreReport([{
			id: "meta-ch3",
			title: "质量目标",
			content: positive.split("\n").slice(1).join("\n"),
			sections: []
		}], positive);
		assert("④-2 正面守护：响应词+承诺语境同句仍判响应（防误伤）", dimensionOf(positiveReport, "reviewResponse") === 100, `reviewResponse=${dimensionOf(positiveReport, "reviewResponse")}`);
		console.log("\n=== r28l 真实成稿：标题剥离对照 + 回归守护 ===");
		const md = JSON.parse(readFileSync(DRAFT, "utf8")).markdown || "";
		const fullBlocks = splitScoringBlocks(md);
		const headBlocks = splitScoringBlocks(md.split("\n").filter((line) => /^#{1,6}\s/u.test(line)).join("\n\n"));
		console.log(`全量块数=${fullBlocks.length}；仅标题块数=${headBlocks.length}（旧口径 96）`);
		assert("R-1 仅标题文档在内容级判定下不产出单元", headBlocks.length === 0, `headBlocks=${headBlocks.length}`);
		const simFull = await buildSemanticSimilarity(fullBlocks, QUERIES);
		const simHead = await buildSemanticSimilarity(headBlocks, QUERIES);
		let fullHits = 0;
		let headHits = 0;
		for (const query of QUERIES) {
			if (fullBlocks.find((block) => simFull(block, query) >= .6)) fullHits += 1;
			if (headBlocks.find((block) => simHead(block, query) >= .6)) headHits += 1;
		}
		assert("R-2 仅标题命中归零（旧口径 14/19）", headHits === 0, `仅标题命中=${headHits}/${QUERIES.length}`);
		assert("R-3 真实成稿全量命中不误伤", fullHits === QUERIES.length, `全量命中=${fullHits}/${QUERIES.length}`);
		console.log(`\n${failures.length === 0 ? "对抗套件全部通过" : `对抗套件失败 ${failures.length} 项：${failures.join("、")}`}`);
		if (failures.length > 0) process.exit(1);
	}
	main().catch((error) => {
		console.error("审计失败:", error);
		process.exit(1);
	});
}));
//#endregion
export default require_meta_audit();
export {};
