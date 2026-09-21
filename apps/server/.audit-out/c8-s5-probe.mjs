import { readFileSync } from "node:fs";
import { LocalTransformersEmbeddingProvider } from "@customize-agent/knowledge";
//#region \0rolldown/runtime.js
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
//#endregion
//#region apps/server/src/services/document-workflow/budget.ts
function documentTextLength(markdown) {
	return markdown.replace(/<[^>]+>/gu, "").replace(/\s+/gu, "").length;
}
var init_budget = __esmMin((() => {}));
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
var sharedProvider, embedCache, embedCacheHits, embedCacheMisses, EMBED_CACHE_MAX_TEXT_CHARS;
var init_semanticSimilarity = __esmMin((() => {
	sharedProvider = null;
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
var VAGUE_RESPONSE_LEXICAL_HINTS_RE, VAGUE_RESPONSE_SEMANTIC_PROTOTYPES, VAGUE_LEGAL_CONTEXT_PROTOTYPES, FILLER_SEMANTIC_QUERIES, FILLER_SENTENCE_THRESHOLD, FILLER_TOC_LINE_RE;
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
var init_narrativeContext = __esmMin((() => {
	init_tenderBidChecks();
}));
//#endregion
//#region apps/server/src/services/document-workflow/tenderBidScoring.ts
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
var FORBIDDEN_EMPTY_PHRASES;
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
//#region .dbg/c8-s5-probe.ts
/**
* C8 S5（U）uniqueness 四分量离线复算探针（c8-2-s5b/s5c）：
* 目标：分解 s28m'（doc-1789949006905-e791c53e）uniquenessScore=53 的 47 分扣分构成。
* 口径：与 tenderBidScoring.uniquenessScore 完全同源（FORBIDDEN_EMPTY_PHRASES /
*   fillerDensityReport / duplicateSentenceStats / documentTextLength），零复刻；
*   重复句明细按同口径复刻并断言与导出 stats 一致（防漂移）。
* 嵌入：fillerDensityReport 不注入 embedDocuments → 走本地 bge provider（生产同路径）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c8-s5-probe.config.mjs
*   && node apps/server/.audit-out/c8-s5-probe.mjs
*/
var require_c8_s5_probe = /* @__PURE__ */ __commonJSMin((() => {
	init_tenderBidScoring();
	init_budget();
	init_tenderBidChecks();
	init_narrativeContext();
	const DOC = "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949006905-e791c53e.json";
	const EXPECTED = 53;
	function duplicateSentenceDetails(markdown) {
		const counts = /* @__PURE__ */ new Map();
		for (const line of markdown.split("\n")) {
			if (isFillerPoolExcludedLine(line) || isTocClusterLine(line)) continue;
			for (const raw of line.split(/[。；;]/u)) {
				const sentence = raw.replace(/[\s，,、:：（）()【】[\]《》“”"'`]/gu, "");
				if (sentence.length < 12) continue;
				counts.set(sentence, (counts.get(sentence) || 0) + 1);
			}
		}
		return [...counts.entries()].filter(([, count]) => count >= 2).sort((left, right) => right[1] - left[1]).map(([sentence, count]) => ({
			sentence,
			count
		}));
	}
	async function main() {
		const wrapper = JSON.parse(readFileSync(DOC, "utf8"));
		const markdown = String(wrapper.markdown ?? "");
		const textLength = documentTextLength(markdown);
		console.log("=== C8-S5 uniqueness 四分量离线复算（s28m' doc-1789949006905-e791c53e）===");
		console.log(`markdown 字符数 ${markdown.length}；有效字数（去空白/标签）${textLength}`);
		const forbiddenHits = FORBIDDEN_EMPTY_PHRASES.filter((phrase) => markdown.includes(phrase));
		const forbiddenPenalty = forbiddenHits.length * 4;
		console.log(`\n① 空话短语 FORBIDDEN_EMPTY_PHRASES：命中 ${forbiddenHits.length} 个 × 4 = ${forbiddenPenalty} 分扣分`);
		for (const phrase of forbiddenHits) {
			const count = markdown.split(phrase).length - 1;
			console.log(`   - 「${phrase}」出现 ${count} 次`);
		}
		const dup = duplicateSentenceStats(markdown);
		const details = duplicateSentenceDetails(markdown);
		const detailInstances = details.reduce((sum, item) => sum + (item.count - 1), 0);
		console.log(`\n② 重复句 duplicateSentenceStats：total=${dup.totalSentences} unique=${dup.uniqueSentences} duplicateInstances=${dup.duplicateInstances} rate=${dup.duplicateRate.toFixed(4)}`);
		console.log(`   明细复刻互证：重复句种数=${details.length}，duplicateInstances=${detailInstances}（与导出 ${dup.duplicateInstances} ${detailInstances === dup.duplicateInstances ? "一致" : "不一致!"}）`);
		const dupBudget = Math.max(10, Math.ceil(textLength / 1e4));
		const dupExcess = Math.max(0, dup.duplicateInstances - dupBudget);
		const duplicatePenalty = Math.max(dup.duplicateRate * 60, dupExcess);
		console.log(`   budget=${dupBudget} excess=${dupExcess} → duplicatePenalty = max(${(dup.duplicateRate * 60).toFixed(2)}, ${dupExcess}) = ${duplicatePenalty.toFixed(2)}`);
		for (const item of details.slice(0, 30)) console.log(`   ×${item.count} ${item.sentence.slice(0, 60)}`);
		console.log("\n③ 语义分量（本地 bge 嵌入，可能耗时）...");
		const filler = await fillerDensityReport(markdown);
		const fillerPenalty = Math.max(0, filler.ratio - .1) * 100;
		console.log(`   fillerDensityReport：total=${filler.totalSentences} filler=${filler.fillerSentences} ratio=${filler.ratio.toFixed(4)} level=${filler.level}`);
		console.log(`   vagueCandidate=${filler.vagueCandidateSentences} vagueSemantic=${filler.vagueSemanticSentences} → vaguePenalty = ${filler.vagueSemanticSentences} × 6 = ${filler.vagueSemanticSentences * 6}`);
		console.log(`   fillerPenalty = max(0, ${filler.ratio.toFixed(4)} - 0.1) × 100 = ${fillerPenalty.toFixed(2)} → × 0.5 = ${(fillerPenalty * .5).toFixed(2)} 分扣分`);
		if (filler.fillerSentenceDetails.length > 0) {
			console.log("   套话命中句明细：");
			for (const sentence of filler.fillerSentenceDetails) console.log(`   · ${sentence.slice(0, 80)}`);
		}
		const vagueSentences = (await judgeFillerSentences(buildFillerSentencePool(markdown))).filter((item) => item.vague);
		console.log(`   模糊应答语义命中 ${vagueSentences.length} 句：`);
		for (const item of vagueSentences) console.log(`   · [${item.similarity.toFixed(3)}] ${item.sentence.slice(0, 80)}`);
		const composed = Math.max(0, Math.round(100 - forbiddenPenalty - filler.vagueSemanticSentences * 6 - fillerPenalty * .5 - duplicatePenalty));
		console.log(`\n④ 合成：100 - ${forbiddenPenalty}（空话） - ${filler.vagueSemanticSentences * 6}（模糊） - ${(fillerPenalty * .5).toFixed(2)}（套话） - ${duplicatePenalty.toFixed(2)}（重复） = ${composed}`);
		console.log(`   报告值 ${EXPECTED}；复算值 ${composed}；${composed === EXPECTED ? "=== 一致 ===" : "!!! 不一致，需查最终时点差异 !!!"}`);
		if (composed !== EXPECTED) process.exitCode = 1;
	}
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}));
//#endregion
export default require_c8_s5_probe();
export {};
