import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { LocalTransformersEmbeddingProvider } from "@customize-agent/knowledge";
//#region \0rolldown/runtime.js
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
//#endregion
//#region apps/server/src/services/document-workflow/templatingGovernance.ts
/** 章节切片（与 headingDuplicateIssues / 句架检测同口径：## 分章） */
function chapterSlices(markdown) {
	return markdown.split(/^##\s+/gmu).slice(1).map((part) => {
		const newline = part.indexOf("\n");
		return newline < 0 ? {
			title: part.trim(),
			body: ""
		} : {
			title: part.slice(0, newline).trim(),
			body: part.slice(newline + 1)
		};
	});
}
/** 句池（markdown 级单源）：剔除标题行/表格行，按 。！？ 切句（保分号链完整——顺序词链常跨分号），
* 剥条目编号/列表符前缀，≥8 字。检测/修复目标/复检三端同源引用（防口径漂移）。 */
function sentencePoolOf(markdown) {
	const sentences = [];
	for (const rawLine of markdown.split(/\r?\n/u)) {
		const line = rawLine.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim();
		if (!line || /^#{1,6}\s/u.test(line) || line.startsWith("|")) continue;
		const body = line.replace(/^(?:\d+(?:\.\d+)*[.、)）]|[-*•])\s*/u, "");
		for (const part of body.split(/(?<=[。！？])/u)) {
			const sentence = part.trim();
			if (sentence.length >= 8) sentences.push(sentence);
		}
	}
	return sentences;
}
/** 单族全文命中计数（检测/复检/报告同源口径） */
function countSentencePatternHits(markdown, family) {
	return sentencePoolOf(markdown).filter(family.test).length;
}
/**
* 句模复读检测（终检注册）：任一结构帧全篇 ≥6 句即 error/blocker——同模式句重复即模板化观感
* （句内事实可核查，但与 filler 语义概念正交，属独立治理维度）。
*/
function sentencePatternRepeatIssues(markdown) {
	const issues = [];
	const pool = sentencePoolOf(markdown);
	for (const family of SENTENCE_PATTERN_FAMILIES) {
		const count = pool.filter(family.test).length;
		if (count < 6) continue;
		issues.push({
			level: "error",
			severity: "blocker",
			category: "style",
			owner: "llm",
			repairability: "llm_repairable",
			message: `句式模版复读：「${family.label}」全篇出现 ${count} 处（复读命中线 6 处）——同模式句重复，模板化观感`,
			suggestion: `保留全文前 5 处，其余处逐句改写为自然多样表达（变换句式结构与连接方式，或拆分为多句；各句改写方向须彼此不同，不得集中复用同一替换句式）；改写保留原句全部工序顺序、数值与验收事实，不得删减工艺参数。`
		});
	}
	return issues;
}
function sentencePatternRepairTargets(markdown) {
	const targets = [];
	const chapters = chapterSlices(markdown);
	const pool = sentencePoolOf(markdown);
	const assigned = /* @__PURE__ */ new Set();
	for (const family of SENTENCE_PATTERN_FAMILIES) {
		const total = pool.filter(family.test).length;
		if (total < 6) continue;
		const cap = 5;
		const byChapter = /* @__PURE__ */ new Map();
		for (const chapter of chapters) {
			if (!chapter.body) continue;
			const list = [];
			for (const sentence of sentencePoolOf(chapter.body)) {
				if (assigned.has(sentence) || !family.test(sentence) || list.includes(sentence)) continue;
				list.push(sentence);
			}
			if (list.length > 0) byChapter.set(chapter.title, list);
		}
		let keepQuota = cap;
		for (const [chapterTitle, sentences] of byChapter) {
			const overflow = sentences.slice(keepQuota).slice(0, 4);
			keepQuota = Math.max(0, keepQuota - sentences.length);
			if (overflow.length > 0) {
				overflow.forEach((sentence) => assigned.add(sentence));
				targets.push({
					chapterTitle,
					patternId: family.id,
					patternLabel: family.label,
					totalCount: total,
					cap,
					sentences: overflow
				});
			}
		}
	}
	return targets.slice(0, 16);
}
var SEQUENCE_CONNECTIVES, SENTENCE_PATTERN_FAMILIES;
var init_templatingGovernance = __esmMin((() => {
	SEQUENCE_CONNECTIVES = [
		"再",
		"接着",
		"随后",
		"然后",
		"继而",
		"最后",
		"而后"
	];
	SENTENCE_PATTERN_FAMILIES = [
		{
			id: "sequence-chain",
			label: "多段顺序词链（先…再…随后/然后…最后）",
			test: (sentence) => /先|首先/u.test(sentence) && SEQUENCE_CONNECTIVES.filter((word) => sentence.includes(word)).length >= 3
		},
		{
			id: "after-completion-action",
			label: "完成即转入式（完成/结束…后，进行/开展…）",
			test: (sentence) => /(?:完成|完毕|结束|完工)[^。！？\n]{0,40}?后\s*[，,、]?\s*(?:进行|开展|实施|开始|转入|安排|及时|组织)/u.test(sentence)
		},
		{
			id: "acceptance-next-step",
			label: "验收衔接式（…合格后，方可/进入下道工序）",
			test: (sentence) => /(?:合格|通过验收|验收通过|签认)[^。！？\n]{0,16}?后\s*[，,、]?\s*(?:方可|才能|进入|转入|进行|开始|实施|组织)/u.test(sentence)
		},
		{
			id: "closed-loop-record",
			label: "资料闭环式（…并形成记录/资料闭环）",
			test: (sentence) => /(?:并)?形成[^。！？\n]{0,24}?(?:记录|资料|台账|档案|影像)(?:闭环|闭合|归档|备查)/u.test(sentence)
		},
		{
			id: "form-announcement",
			label: "形式宣告式（施工/工序按顺序/编号步骤…组织：）",
			test: (sentence) => /(?:施工|工序|流程|作业|操作)[^。！？\n]{0,14}?(?:按|依)(?:以下|下列)?[^。！？\n]{0,40}?(?:顺序|步骤|编号|次序)[^。！？\n]{0,12}?(?:组织|展开|安排|排列)/u.test(sentence)
		}
	];
}));
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
/** 模糊应答词命中明细（含出现次数），供评分报告定位（词面口径，评分扣分走语义复核口径） */
function vagueResponseHits(markdown) {
	return VAGUE_RESPONSE_PHRASES.filter((phrase) => markdown.includes(phrase)).map((phrase) => ({
		phrase,
		count: markdown.split(phrase).length - 1
	}));
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
/** 重难点章节提取：定位"重难点/重点难点"标题段落后到下一同级标题前的内容；
* 无独立标题小节时回退定位「重难点识别表」表格段（丰乐镇第五轮实测：重难点以表格形式
* 承载于工程特点小节，标题正则永远匹配不到 → 检测恒 0 条目、双达标 0% 假阴性） */
function extractKeyDifficultySection(markdown) {
	const match = markdown.match(/^#{2,4}\s*[^\n]*(?:重难点|重点难点|工程难点|难点分析)[^\n]*\n/mu);
	if (match && match.index !== void 0) {
		const start = match.index + match[0].length;
		const rest = markdown.slice(start);
		const level = match[0].match(/^#+/u)?.[0].length ?? 3;
		const boundary = new RegExp(`^#{2,${Math.max(2, level)}}\\s+`, "mu");
		const nextHeading = rest.search(boundary);
		return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
	}
	const tableHead = markdown.match(/^\|?\s*[^\n]*(?:重难点|重点难点|工程难点|难点分析)[^\n]*\|\s*$/mu);
	if (!tableHead || tableHead.index === void 0) return "";
	const lines = markdown.slice(tableHead.index).split(/\n/u);
	const tableLines = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			if (tableLines.length > 0) break;
			continue;
		}
		if (!trimmed.startsWith("|")) {
			if (tableLines.length > 0) break;
			continue;
		}
		tableLines.push(line);
	}
	return tableLines.join("\n");
}
/** 重难点条目切分（单源）：表格载体（重难点识别表，每数据行一条）与段落载体（空行分段 ≥20 字）
* 两种形式——写作时执行器（blockQualityExecutors 归因量化）与终检报告共用，条目口径一致 */
function splitDifficultyEntries(section) {
	return section.trim().startsWith("|") ? section.split(/\n/u).filter((line) => {
		const trimmed = line.trim();
		return trimmed.startsWith("|") && !/^\|\s*-+\s*\|/u.test(trimmed) && !/重难点/u.test(trimmed.split("|")[1] || "");
	}).filter((line) => line.trim().length >= 20) : section.split(/\n{2,}/u).filter((block) => block.trim().length >= 20);
}
async function assessDifficultyEntries(entries, embedDocuments) {
	const attributionSimilarity = await buildSemanticSimilarity(entries, [ATTRIBUTION_SEMANTIC_QUERY], embedDocuments);
	let attributed = 0;
	let quantified = 0;
	let bothCount = 0;
	const details = [];
	for (const entry of entries) {
		const hasAttribution = attributionSimilarity(entry, ATTRIBUTION_SEMANTIC_QUERY) >= SEMANTIC_COVERAGE_THRESHOLD;
		const hasTarget = QUANTIFIED_TARGET_RE.test(entry);
		if (hasAttribution) attributed += 1;
		if (hasTarget) quantified += 1;
		if (hasAttribution && hasTarget) bothCount += 1;
		details.push({
			text: entry,
			attributed: hasAttribution,
			quantified: hasTarget
		});
	}
	return {
		entries,
		attributed,
		quantified,
		bothCount,
		ratio: entries.length ? bothCount / entries.length : 0,
		details
	};
}
/** 重难点对策模板化检测：按条目（空行分段）统计"归因＋量化目标"双达标占比 */
async function difficultyCountermeasureReport(markdown, embedDocuments) {
	const entries = splitDifficultyEntries(extractKeyDifficultySection(markdown));
	const assessment = await assessDifficultyEntries(entries, embedDocuments);
	return {
		countermeasures: entries.length,
		attributed: assessment.attributed,
		quantified: assessment.quantified,
		bothCount: assessment.bothCount,
		ratio: assessment.ratio,
		heavyTemplated: entries.length > 0 && assessment.ratio < .5,
		entries: assessment.details.slice(0, 24)
	};
}
function crossProjectResidueHits(markdown) {
	const cleaned = markdown.replace(/及其他项目/gu, "及〔清单列举项〕");
	return CROSS_PROJECT_RES.filter((pattern) => pattern.test(cleaned)).map((pattern) => pattern.source.replace(/\\u/gu, ""));
}
var VAGUE_RESPONSE_PHRASES, VAGUE_RESPONSE_LEXICAL_HINTS_RE, VAGUE_RESPONSE_SEMANTIC_PROTOTYPES, VAGUE_LEGAL_CONTEXT_PROTOTYPES, FILLER_SEMANTIC_QUERIES, FILLER_SENTENCE_THRESHOLD, FILLER_TOC_LINE_RE, ATTRIBUTION_SEMANTIC_QUERY, QUANTIFIED_TARGET_RE, CROSS_PROJECT_RES;
var init_tenderBidChecks = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	VAGUE_RESPONSE_PHRASES = [
		"基本满足",
		"大致符合",
		"力争",
		"原则上",
		"大概",
		"左右",
		"尽可能",
		"尽量满足"
	];
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
	ATTRIBUTION_SEMANTIC_QUERY = "分析该工程难点的成因与风险来源";
	QUANTIFIED_TARGET_RE = /\d+(?:\.\d+)?\s*(?:mm|cm|m|米|℃|%|kN|MPa|次|天|日历天|小时|h|Hz|m³|㎡|m²|t|吨|座|套|个)/u;
	CROSS_PROJECT_RES = [
		/其他项目/u,
		/其他标段/u,
		/其他城市/u,
		/本公司(?:其他|承建)/u,
		/某(?:市|县|区|项目)(?:的)?/u,
		/他项目/u,
		/兄弟项目/u
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
async function buildTenderBidTemplatingReport(markdown, embedDocuments) {
	const filler = await fillerDensityReport(markdown, embedDocuments);
	const vagueHits = vagueResponseHits(markdown);
	const duplicateRate = duplicateSentenceStats(markdown).duplicateRate;
	const difficulty = await difficultyCountermeasureReport(markdown, embedDocuments);
	const residue = crossProjectResidueHits(markdown);
	const sentencePatternHits = SENTENCE_PATTERN_FAMILIES.map((family) => ({
		patternId: family.id,
		patternLabel: family.label,
		count: countSentencePatternHits(markdown, family)
	})).filter((hit) => hit.count >= 6);
	const sentencePatternSevere = sentencePatternHits.length >= 2 || sentencePatternHits.some((hit) => hit.count >= 12);
	return {
		level: difficulty.heavyTemplated || filler.level === "heavy" || sentencePatternSevere ? "heavy" : filler.level === "medium" || sentencePatternHits.length > 0 ? "medium" : "light",
		fillerRatio: filler.ratio,
		fillerSentences: filler.fillerSentences,
		totalSentences: filler.totalSentences,
		vagueHitCount: vagueHits.reduce((sum, hit) => sum + hit.count, 0),
		vaguePhrases: vagueHits.map((hit) => hit.phrase),
		duplicateSentenceRate: duplicateRate,
		crossProjectResidue: residue,
		difficultyCountermeasureRatio: difficulty.ratio,
		difficultyBothCount: difficulty.bothCount,
		difficultyCountermeasures: difficulty.countermeasures,
		difficultyHeavyTemplated: difficulty.heavyTemplated,
		sentencePatternHits
	};
}
var FORBIDDEN_EMPTY_PHRASES;
var init_tenderBidScoring = __esmMin((() => {
	init_documentFactTrace();
	init_semanticSimilarity();
	init_tenderBidChecks();
	init_narrativeContext();
	init_templatingGovernance();
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
//#region .dbg/c4-measure.ts
/**
* C4 测量脚本：写作质量类（D3 句模复读检测器 / 检测→修复同源 / D7 规则源删模板 / 评分接入）归零验证。
* DoD（repair-master-plan-v3 §7.2 C4-7）：r28l/s28l 离线复算 + 通用性抽查。离线不跑 LLM，归零口径：
* ① 检测端零漏检：五族句模在 r28l/s28l 全量复算，逐族 ≥ C4-1 探针基线（.dbg/c4-probe-baseline.log）；
* ② 检测定位=修复定位：sentencePatternRepeatIssues（终检注册 sentence-pattern-repeat，error/blocker）
*    与 sentencePatternRepairTargets 同源计数；目标合法性不变量（族判定复验/cap=5/每章每族≤4/全篇≤16/跨族去重）；
* ③ 修复轮仿真（改写等价，非删除）：逐轮消费全部目标句 → 目标数单调下降、属族计数单调下降、有限轮收敛为 0；
* ④ 评分接入复算：buildTenderBidTemplatingReport.sentencePatternHits 与检测端一致 + level 三档降档
*    （≥2 族或单族 ≥12 → heavy；≥1 族 → medium 下限）；
* ⑤ D7 规则源零残留：apps/server/src 全量扫描「轮换池/句式参照」——白名单仅 scoringCalibration.ts
*    变更记录注释（描述删除动作，非指令文本）；
* ⑥ 通用性抽查（零专名合成样本）：五族正样本（变化数值）命中 + 2 连接词短链/常规叙述反样本零误伤 + 阈值 5/6 边界 + 跨族去重。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c4-measure.config.mjs
*   node apps/server/.audit-out/c4-measure.mjs
*/
var require_c4_measure = /* @__PURE__ */ __commonJSMin((() => {
	init_templatingGovernance();
	init_tenderBidScoring();
	const ROOT = "/Users/pan/Desktop/codeing/customize-agent";
	const DOCS = [{
		name: "r28l 丰乐",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884268681-31f4980c.json"
	}, {
		name: "s28l 舒城",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884273697-ea5fbe91.json"
	}];
	const PROBE_BASELINE = {
		"r28l 丰乐": {
			"sequence-chain": 13,
			"after-completion-action": 6,
			"acceptance-next-step": 6,
			"closed-loop-record": 11,
			"form-announcement": 10
		},
		"s28l 舒城": {
			"sequence-chain": 47,
			"after-completion-action": 16,
			"acceptance-next-step": 19,
			"closed-loop-record": 28,
			"form-announcement": 7
		}
	};
	/** 探针族复刻（c4-probe.mjs 冻结证据：F1e/F2/F3/F4b 四族正则原样；form-announcement 探针为聚类无 regex，走聚类基线） */
	const PROBE_ANCHOR_FAMILIES = {
		"sequence-chain": (sentence) => /先|首先/u.test(sentence) && [
			"再",
			"接着",
			"随后",
			"然后",
			"继而",
			"最后",
			"而后"
		].filter((word) => sentence.includes(word)).length >= 3,
		"after-completion-action": (sentence) => /(?:完成|完毕|结束|完工)[^。；\n]{0,40}?后\s*[，,、]?\s*(?:进行|开展|实施|开始|转入|安排|及时|组织)/u.test(sentence),
		"acceptance-next-step": (sentence) => /(?:合格|通过验收|验收通过|签认)[^。；\n]{0,16}?后\s*[，,、]?\s*(?:方可|才能|进入|转入|进行|开始|安排|实施|组织)/u.test(sentence),
		"closed-loop-record": (sentence) => /(?:并)?形成[^。；\n]{0,20}?(?:记录|资料|台账|档案)(?:闭环|闭合|归档|备查)/u.test(sentence)
	};
	/** 探针片段池复刻（c4-probe.mjs splitSentences：。！？； 切句、不剥列表前缀、≥8 字——片段粒度比产线句细） */
	function probeSentencePool(markdown) {
		const sentences = [];
		for (const rawLine of markdown.split(/\r?\n/u)) {
			const trimmed = rawLine.trim();
			if (!trimmed || /^#{1,6}\s/u.test(trimmed) || trimmed.startsWith("|")) continue;
			for (const part of rawLine.split(/(?<=[。！？；])/u)) {
				const sentence = part.trim();
				if (sentence.length >= 8) sentences.push(sentence);
			}
		}
		return sentences;
	}
	/** 片段归一化（探针不剥列表前缀/不剥零宽字符，产线句剥——锚定比对前对齐文本口径） */
	function normalizeProbeFragment(fragment) {
		return fragment.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim().replace(/^(?:\d+(?:\.\d+)*[.、)）]|[-*•])\s*/u, "").trim();
	}
	let failures = 0;
	function check(label, pass, detail) {
		console.log(`${pass ? "PASS" : "FAIL"} | ${label} —— ${detail}`);
		if (!pass) failures += 1;
	}
	function info(label, detail) {
		console.log(`     · ${label} —— ${detail}`);
	}
	function loadMarkdown(file) {
		const wrapper = JSON.parse(readFileSync(file, "utf8"));
		const layer = wrapper.draft ?? wrapper;
		return String(layer.markdown ?? wrapper.markdown ?? "");
	}
	function familyOf(id) {
		return SENTENCE_PATTERN_FAMILIES.find((family) => family.id === id);
	}
	/** 改写等价仿真：目标句替换为中性多样表述（不命中任何族、不删除句子——与 LLM 就地改写等价；长句先替换防子串误伤） */
	function rewriteSentence(index) {
		return `相关内容按项目实际另行表述（改写第 ${index} 处）。`;
	}
	function applyRewrites(markdown, sentences, startIndex) {
		const ordered = [...sentences].sort((left, right) => right.length - left.length);
		let next = markdown;
		ordered.forEach((sentence, offset) => {
			next = next.split(sentence).join(rewriteSentence(startIndex + offset));
		});
		return next;
	}
	async function measureDoc(name, file) {
		const markdown = loadMarkdown(file);
		console.log(`\n═══ ${name}（markdown ${markdown.length} 字符）═══`);
		console.log("① 检测端五族复算（产线单源 countSentencePatternHits）");
		const counts = /* @__PURE__ */ new Map();
		const replicaPool = sentencePoolReplica(markdown);
		const probePool = probeSentencePool(markdown);
		for (const family of SENTENCE_PATTERN_FAMILIES) {
			const count = countSentencePatternHits(markdown, family);
			counts.set(family.id, count);
			const hit = count >= 6 ? "★命中" : "·低";
			const baseline = PROBE_BASELINE[name]?.[family.id];
			const probeTest = PROBE_ANCHOR_FAMILIES[family.id];
			if (probeTest && baseline !== void 0) {
				const fragments = probePool.filter(probeTest);
				check(`${name} 探针复刻自检 ${family.id}`, fragments.length === baseline, `复刻片段 ${fragments.length} = 基线 ${baseline}`);
				const anchored = fragments.every((fragment) => {
					const needle = normalizeProbeFragment(fragment);
					return needle.length >= 8 && replicaPool.some((sentence) => (sentence.includes(fragment) || sentence.includes(needle)) && family.test(sentence));
				});
				check(`${name} 零漏检（探针锚定覆盖）${family.id}`, fragments.length >= 6 && anchored, `探针片段 ${fragments.length} 全部锚定于命中产线句（产线句级计数 ${count}）`);
				info(`${hit} [${family.id}]`, `${family.label}：产线句 ${count} / 探针片段 ${fragments.length}（基线 ${baseline}）`);
			} else if (baseline !== void 0) {
				check(`${name} 零漏检 ${family.id}`, count >= baseline, `产线 ${count} ≥ 聚类基线 ${baseline}`);
				info(`${hit} [${family.id}]`, `${family.label}：产线 ${count} 句（聚类基线 ${baseline}）`);
			} else info(`${hit} [${family.id}]`, `${family.label}：产线 ${count} 句`);
		}
		const hitIds = [...counts.entries()].filter(([, count]) => count >= 6).map(([id]) => id);
		check(`${name} 命中族非空`, hitIds.length >= 1, `命中族：${hitIds.join("、")}`);
		console.log("② 检测/修复目标同源核对");
		const issues = sentencePatternRepeatIssues(markdown);
		check(`${name} issue 数与命中族数一致`, issues.length === hitIds.length, `issues=${issues.length} hits=${hitIds.length}`);
		check(`${name} issue 均为 blocker/error/style`, issues.every((issue) => issue.level === "error" && issue.severity === "blocker" && issue.category === "style"), `levels=${[...new Set(issues.map((issue) => `${issue.level}/${issue.severity}/${issue.category}`))].join(",")}`);
		const messageCounts = /* @__PURE__ */ new Map();
		for (const issue of issues) {
			const found = SENTENCE_PATTERN_FAMILIES.find((family) => String(issue.message).includes(family.label));
			if (found) {
				const match = /出现 (\d+) 处/u.exec(String(issue.message));
				if (match) messageCounts.set(found.id, Number(match[1]));
			}
		}
		check(`${name} message 计数=检测计数`, hitIds.every((id) => messageCounts.get(id) === counts.get(id)), hitIds.map((id) => `${id}:${messageCounts.get(id) ?? "-"}/${counts.get(id)}`).join(" "));
		const targets = sentencePatternRepairTargets(markdown);
		const targetSentences = targets.flatMap((target) => target.sentences);
		check(`${name} 目标数 ≤16`, targets.length <= 16, `targets=${targets.length}`);
		check(`${name} cap 恒为 5`, targets.every((target) => target.cap === 5), `caps=${[...new Set(targets.map((target) => target.cap))].join(",")}`);
		check(`${name} 目标 patternId ⊆ 命中族`, targets.every((target) => hitIds.includes(target.patternId)), `ids=${[...new Set(targets.map((target) => target.patternId))].join("、")}`);
		check(`${name} totalCount=族检测计数`, targets.every((target) => target.totalCount === counts.get(target.patternId)), `mismatch=${targets.filter((target) => target.totalCount !== counts.get(target.patternId)).length}`);
		check(`${name} 目标句复验命中本族判定`, targets.every((target) => target.sentences.every((sentence) => familyOf(target.patternId).test(sentence))), `句数=${targetSentences.length}`);
		check(`${name} 目标句跨族/跨章去重`, new Set(targetSentences).size === targetSentences.length, `unique=${new Set(targetSentences).size}/${targetSentences.length}`);
		check(`${name} 单目标句数 1..4`, targets.every((target) => target.sentences.length >= 1 && target.sentences.length <= 4), `max=${Math.max(0, ...targets.map((target) => target.sentences.length))}`);
		const chapterPatternPairs = targets.map((target) => `${target.chapterTitle}‖${target.patternId}`);
		check(`${name} 每章每族单目标（≤4 句额度）`, new Set(chapterPatternPairs).size === chapterPatternPairs.length, `targets=${targets.length}`);
		const topFamily = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
		check(`${name} 最大命中族有修复目标`, targets.some((target) => target.patternId === topFamily), `top=${topFamily} targets=${targets.filter((target) => target.patternId === topFamily).length}`);
		const targetSentenceSet = new Set(targetSentences);
		const coverage = [...counts.entries()].filter(([, count]) => count >= 6).map(([id, count]) => {
			const pool = replicaPool.filter((sentence) => familyOf(id).test(sentence));
			const own = targets.filter((target) => target.patternId === id).reduce((sum, target) => sum + target.sentences.length, 0);
			const covered = pool.filter((sentence) => targetSentenceSet.has(sentence)).length;
			const crossBy = targets.filter((target) => target.patternId !== id && target.sentences.some((sentence) => pool.includes(sentence))).map((target) => target.patternId);
			return {
				id,
				count,
				own,
				covered,
				uncovered: count - covered,
				crossBy: [...new Set(crossBy)]
			};
		});
		for (const item of coverage) info(`覆盖 [${item.id}]`, `命中 ${item.count}、本族目标句 ${item.own}、全目标覆盖 ${item.covered}、未覆盖 ${item.uncovered}${item.crossBy.length ? `（跨族覆盖：${item.crossBy.join("、")}）` : ""}`);
		check(`${name} 未覆盖不超保留额度+跨族（guard）`, coverage.every((item) => item.own > 0 || item.crossBy.length > 0 || item.uncovered <= 5), coverage.map((item) => `${item.id}:${item.uncovered}`).join(" "));
		console.log("③ 修复轮仿真（就地改写等价，轮上限 20）");
		const familySum = (md) => SENTENCE_PATTERN_FAMILIES.reduce((sum, family) => sum + countSentencePatternHits(md, family), 0);
		let current = markdown;
		let rewriteCounter = 0;
		let simulatedRounds = 0;
		let previousSum = familySum(current);
		for (let round = 1; round <= 20; round += 1) {
			const currentTargets = sentencePatternRepairTargets(current);
			if (currentTargets.length === 0) break;
			const sentences = currentTargets.flatMap((target) => target.sentences);
			const next = applyRewrites(current, sentences, rewriteCounter);
			rewriteCounter += sentences.length;
			const nextTargets = sentencePatternRepairTargets(next);
			const nextSum = familySum(next);
			check(`${name} 仿真轮 ${round} 目标数不上升`, nextTargets.length <= currentTargets.length, `${currentTargets.length} → ${nextTargets.length}`);
			check(`${name} 仿真轮 ${round} 属族计数和下降`, nextSum < previousSum, `${previousSum} → ${nextSum}`);
			current = next;
			previousSum = nextSum;
			simulatedRounds = round;
		}
		const finalTargets = sentencePatternRepairTargets(current);
		check(`${name} 有限轮（≤20）收敛归零`, finalTargets.length === 0, `残留=${finalTargets.length} 迭代=${simulatedRounds} 消费句=${rewriteCounter}`);
		console.log("④ 评分接入（buildTenderBidTemplatingReport 真机复算）");
		const report = await buildTenderBidTemplatingReport(markdown);
		const expectedHits = SENTENCE_PATTERN_FAMILIES.map((family) => ({
			patternId: family.id,
			patternLabel: family.label,
			count: counts.get(family.id) ?? 0
		})).filter((hit) => hit.count >= 6);
		check(`${name} sentencePatternHits 与检测端一致`, JSON.stringify(report.sentencePatternHits) === JSON.stringify(expectedHits), `report=${report.sentencePatternHits.map((hit) => `${hit.patternId}:${hit.count}`).join(" ")}`);
		const severe = expectedHits.length >= 2 || expectedHits.some((hit) => hit.count >= 12);
		severe || expectedHits.length;
		check(`${name} level 降档口径`, severe ? report.level === "heavy" : report.level !== "light", `level=${report.level}（severe=${severe} filler=${report.level}）`);
		return {
			name,
			counts,
			hitIds,
			targetCount: targets.length,
			coverage
		};
	}
	/** 产线句池复刻（与 templatingGovernance.sentencePoolOf 同口径：剔标题/表格行、剥列表前缀、。！？切句、≥8 字；仅用于覆盖率/锚定核算，非门禁） */
	function sentencePoolReplica(markdown) {
		const sentences = [];
		for (const rawLine of markdown.split(/\r?\n/u)) {
			const line = rawLine.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim();
			if (!line || /^#{1,6}\s/u.test(line) || line.startsWith("|")) continue;
			const body = line.replace(/^(?:\d+(?:\.\d+)*[.、)）]|[-*•])\s*/u, "");
			for (const part of body.split(/(?<=[。！？])/u)) {
				const sentence = part.trim();
				if (sentence.length >= 8) sentences.push(sentence);
			}
		}
		return sentences;
	}
	function synthDoc(...sentences) {
		return [
			"## 合成样本章",
			"",
			...sentences
		].join("\n");
	}
	const CHAIN_VARIANTS = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 段作业班组按先测量放线、再沟槽开挖、随后管道安装、最后回填夯实的次序分段推进施工。`);
	const COMPLETION_VARIANTS = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 区段沟槽开挖完成后进行基底验槽。`);
	const ACCEPTANCE_VARIANTS = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 道工序验收合格后进入下道工序施工。`);
	const CLOSED_LOOP_VARIANTS = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 批检测结果当日整理并形成记录闭环。`);
	const ANNOUNCE_VARIANTS = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 项工序按编号步骤组织实施作业。`);
	const SHORT_CHAIN_VARIANTS = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 段先复核标高，再吊装就位，最后安装固定。`);
	const NORMAL_VARIANTS = [
		"土方开挖采用机械配合人工，边坡按 1:0.5 控制。",
		"混凝土浇筑连续进行，振捣时间以表面泛浆为准。",
		"管道接口采用承插式橡胶圈连接，安装后检查密封性。",
		"钢筋进场按批次复检，力学性能结论逐批登记。",
		"模板拆除时间依据同条件养护试块强度确定。",
		"脚手架搭设完成后挂牌使用，荷载不得超过设计值。"
	];
	const DUAL_VARIANTS = Array.from({ length: 6 }, (_, index) => `第 ${index + 1} 段基础施工先放线定位，再基槽开挖，随后完成垫层浇筑后进行隐蔽验收，最后回填并做压实度检测。`);
	async function syntheticChecks() {
		console.log("\n═══ ⑥ 通用性抽查（零专名合成样本；全部样本不含项目专名，机制通用性红线）═══");
		const positives = [
			{
				id: "sequence-chain",
				label: "多段顺序词链",
				sentences: CHAIN_VARIANTS
			},
			{
				id: "after-completion-action",
				label: "完成即转入式",
				sentences: COMPLETION_VARIANTS
			},
			{
				id: "acceptance-next-step",
				label: "验收衔接式",
				sentences: ACCEPTANCE_VARIANTS
			},
			{
				id: "closed-loop-record",
				label: "资料闭环式",
				sentences: CLOSED_LOOP_VARIANTS
			},
			{
				id: "form-announcement",
				label: "形式宣告式",
				sentences: ANNOUNCE_VARIANTS
			}
		];
		for (const sample of positives) {
			const markdown = synthDoc(...sample.sentences);
			const family = familyOf(sample.id);
			const counts = SENTENCE_PATTERN_FAMILIES.map((item) => ({
				id: item.id,
				count: countSentencePatternHits(markdown, item)
			})).filter((item) => item.count > 0);
			check(`合成① ${sample.id} 族命中=6`, countSentencePatternHits(markdown, family) === 6, `count=${countSentencePatternHits(markdown, family)}${counts.length > 1 ? `（并含 ${counts.filter((item) => item.id !== sample.id).map((item) => `${item.id}:${item.count}`).join(" ")}）` : ""}`);
			const issues = sentencePatternRepeatIssues(markdown);
			check(`合成① ${sample.id} 产出 blocker issue`, issues.some((issue) => String(issue.message).includes(family.label)) && issues.every((issue) => issue.severity === "blocker"), `issues=${issues.length}`);
			const targets = sentencePatternRepairTargets(markdown);
			check(`合成① ${sample.id} 产出修复目标`, targets.some((target) => target.patternId === sample.id), `targets=${targets.length}`);
		}
		const shortChain = synthDoc(...SHORT_CHAIN_VARIANTS);
		check("合成② 2 连接词短链防误伤（sequence-chain=0）", countSentencePatternHits(shortChain, familyOf("sequence-chain")) === 0 && sentencePatternRepeatIssues(shortChain).length === 0, `count=${countSentencePatternHits(shortChain, familyOf("sequence-chain"))} issues=${sentencePatternRepeatIssues(shortChain).length}`);
		const normal = synthDoc(...NORMAL_VARIANTS);
		check("合成② 常规叙述零误伤", SENTENCE_PATTERN_FAMILIES.every((family) => countSentencePatternHits(normal, family) === 0) && sentencePatternRepeatIssues(normal).length === 0, `issues=${sentencePatternRepeatIssues(normal).length}`);
		const boundaryFive = synthDoc(...CHAIN_VARIANTS.slice(0, 5));
		check("合成③ 阈值边界 5 句不命中", sentencePatternRepeatIssues(boundaryFive).length === 0, `issues=${sentencePatternRepeatIssues(boundaryFive).length}`);
		const boundarySix = synthDoc(...CHAIN_VARIANTS.slice(0, 6));
		check("合成③ 阈值边界 6 句命中", sentencePatternRepeatIssues(boundarySix).length === 1 && sentencePatternRepairTargets(boundarySix).length >= 1, `issues=${sentencePatternRepeatIssues(boundarySix).length} targets=${sentencePatternRepairTargets(boundarySix).length}`);
		const dual = synthDoc(...DUAL_VARIANTS);
		const dualTargets = sentencePatternRepairTargets(dual);
		const dualSentences = dualTargets.flatMap((target) => target.sentences);
		check("合成④ 跨族样本双命中且目标去重", sentencePatternRepeatIssues(dual).length === 2 && new Set(dualSentences).size === dualSentences.length && dualTargets.every((target) => target.patternId === "sequence-chain" || target.patternId === "after-completion-action"), `issues=${sentencePatternRepeatIssues(dual).length} targets=${dualTargets.map((target) => `${target.patternId}:${target.sentences.length}`).join(" ")}`);
	}
	function d7Scan() {
		console.log("\n═══ ⑤ D7 规则源零残留扫描（apps/server/src 全量，白名单：scoringCalibration.ts 变更记录注释）═══");
		const srcDir = path.join(ROOT, "apps/server/src");
		const files = readdirSync(srcDir, { recursive: true });
		const pattern = /轮换池|句式参照/u;
		const hits = [];
		for (const relative of files) {
			const absolute = path.join(srcDir, relative);
			if (!/\.(ts|tsx|json|md)$/u.test(relative)) continue;
			let content = "";
			try {
				content = readFileSync(absolute, "utf8");
			} catch {
				continue;
			}
			if (content.length > 1e6) continue;
			content.split(/\r?\n/u).forEach((line, index) => {
				if (pattern.test(line)) hits.push({
					file: relative,
					line: index + 1,
					text: line.trim().slice(0, 120)
				});
			});
		}
		const disallowed = hits.filter((hit) => !hit.file.endsWith("scoringCalibration.ts"));
		for (const hit of hits) info("命中", `${hit.file}:${hit.line} —— ${hit.text}`);
		check("扫描面（文件数）", files.length > 300, `files=${files.length}`);
		check("规则源零残留（轮换池/句式参照）", disallowed.length === 0, `非白名单命中 ${disallowed.length} 处`);
		const whitelist = hits.filter((hit) => hit.file.endsWith("scoringCalibration.ts"));
		check("白名单注释为删除动作描述", whitelist.every((hit) => /删/u.test(hit.text)), `whitelist=${whitelist.length}`);
	}
	async function main() {
		console.log("════ C4 归零验证（写作质量类：D3 句模复读 / 检测→修复同源 / D7 规则源 / 评分接入）════");
		for (const doc of DOCS) await measureDoc(doc.name, doc.file);
		await syntheticChecks();
		d7Scan();
		console.log(`\n════ 汇总：${failures === 0 ? "全部 PASS（C4 归零）" : `FAIL ${failures} 项`} ════`);
		if (failures > 0) process.exit(1);
	}
	main().catch((error) => {
		console.error("测量脚本异常：", error);
		process.exit(1);
	});
}));
//#endregion
export default require_c4_measure();
export {};
