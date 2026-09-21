import { readFileSync } from "node:fs";
import { LocalTransformersEmbeddingProvider } from "@customize-agent/knowledge";
//#region \0rolldown/runtime.js
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
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
function dot(left, right) {
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
		return dot(leftVector, rightVector);
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
var init_semanticGate = __esmMin((() => {
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/tenderBidChecks.ts
/** 句池排除行判定（检测端与修复锚点端同源口径）：空行/标题/表格/列表/引用/目录条目行不进句池 */
function isFillerPoolExcludedLine(line) {
	const trimmed = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim();
	if (!trimmed) return true;
	if (/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(trimmed)) return true;
	return FILLER_TOC_LINE_RE.test(trimmed);
}
var FILLER_TOC_LINE_RE;
var init_tenderBidChecks = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
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
var init_narrativeContext = __esmMin((() => {
	init_tenderBidChecks();
}));
//#endregion
//#region apps/server/src/services/document-workflow/tenderBidScoring.ts
/** 编制规范性匹配正则定义在 normalizationScore 上方（B7 口径修正） */
function normalizeHeadingTitle(title) {
	return title.replace(/^第[一二三四五六七八九十百千万\d]+[章节]\s*/u, "").replace(/^\d+(?:\.\d+)*[、.．\s]+/u, "").replace(/^[（(]?[一二三四五六七八九十]+[)）、.．\s]+/u, "").replace(/\s+/gu, "").trim();
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
/** 段落切窗：同节段落共享标题前缀（标题是模块查询的天然对准面，保持召回对齐），
* 超长段落按行累积切为 ≤600 字多窗（分段末内容不再沉入块中部被截断） */
function windowParagraph(heading, paragraph) {
	const prefix = heading ? `${heading}\n` : "";
	const units = [];
	let buffer = [];
	let length = 0;
	for (const line of paragraph.split("\n")) {
		if (length > 0 && length + line.length > SCORING_UNIT_MAX_CHARS) {
			units.push(`${prefix}${buffer.join("\n")}`);
			buffer = [];
			length = 0;
		}
		buffer.push(line);
		length += line.length + 1;
	}
	if (buffer.length > 0) units.push(`${prefix}${buffer.join("\n")}`);
	return units;
}
/** 评分判定单元（C0-1 内容级判定）：标题不单独构成判定单元——空壳标题（无实质正文）
* 不得单独命中模块/合规查询（r28l 实测：仅标题块命中 14/19、6 强制模块全部靠标题单独命中，
* 「### 1.1 编制说明与工程概况」类空壳标题误命中「编制专项施工方案」）。现口径：单元 =
* 「小节标题 + 实质正文段落」（标题与正文合并嵌入，正文存在是判定前提），或独立实质段落
* （前言/无标题区）；目录聚簇行剔除、超长段落切窗。导出供单测与对抗套件验证切分粒度。 */
function splitScoringBlocks(markdown) {
	const units = [];
	for (const section of splitScoringSections(markdown)) {
		if (!section.hasSubstantiveBody) continue;
		for (const paragraph of section.substantiveParagraphs) units.push(...windowParagraph(section.heading, paragraph));
	}
	return units;
}
var FORBIDDEN_EMPTY_PHRASES, MANDATORY_MODULE_QUERIES, COMPLIANCE_ITEM_QUERIES, SCORING_UNIT_MAX_CHARS;
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
	SCORING_UNIT_MAX_CHARS = 600;
}));
//#endregion
//#region .dbg/c0-probe.ts
/**
* C0 命中文本口径探针（一次性校准脚本）：正文级判定的「命中文本」选项实测——
* A) 现口径：单元=标题+正文窗口（标题作对准面）；B) 严格口径：命中文本=正文窗口（去标题）。
* 对 r28l/s28l 真 bge 复算模块/合规命中差集，并用堆词样本输出逐查询 sim（含命中块）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c0-probe.config.mjs
*   node apps/server/.audit-out/c0-probe.mjs
*/
var require_c0_probe = /* @__PURE__ */ __commonJSMin((() => {
	init_tenderBidScoring();
	init_semanticSimilarity();
	const DOCS = [{
		name: "r28l 丰乐",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884268681-31f4980c.json"
	}, {
		name: "s28l 舒城",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884273697-ea5fbe91.json"
	}];
	const QUERIES = [...MANDATORY_MODULE_QUERIES, ...COMPLIANCE_ITEM_QUERIES];
	const bodyOnly = (unit) => {
		const index = unit.indexOf("\n");
		return index === -1 ? unit : unit.slice(index + 1);
	};
	async function main() {
		for (const doc of DOCS) {
			const units = splitScoringBlocks(JSON.parse(readFileSync(doc.file, "utf8")).markdown || "");
			const bodies = units.map(bodyOnly);
			const simUnits = await buildSemanticSimilarity(units, QUERIES);
			const simBodies = await buildSemanticSimilarity(bodies, QUERIES);
			let hitsA = 0;
			let hitsB = 0;
			const missA = [];
			const missB = [];
			for (const query of QUERIES) {
				const unitHit = units.find((unit) => simUnits(unit, query) >= SEMANTIC_COVERAGE_THRESHOLD);
				let bodyHit;
				let bodyBest = 0;
				for (const body of bodies) {
					const score = simBodies(body, query);
					if (score > bodyBest) bodyBest = score;
					if (!bodyHit && score >= .6) bodyHit = body;
				}
				if (unitHit) hitsA += 1;
				else missA.push(query);
				if (bodyHit) hitsB += 1;
				else missB.push(query);
				if (!!unitHit !== !!bodyHit) {
					console.log(`[差异] A=${unitHit ? "HIT" : "miss"} B=${bodyHit ? "HIT" : "miss"} bestBodySim=${bodyBest.toFixed(3)} | ${query}`);
					console.log(`  A 命中块=「${(unitHit || "").slice(0, 70).replace(/\n/gu, " ⏎ ")}」`);
					console.log(`  B 命中块=「${(bodyHit || "").slice(0, 70).replace(/\n/gu, " ⏎ ")}」`);
				}
			}
			console.log(`${doc.name}：单元数=${units.length}；A(标题+正文) 命中 ${hitsA}/${QUERIES.length}；B(仅正文) 命中 ${hitsB}/${QUERIES.length}`);
			console.log(`  A 未命中：${missA.join("、") || "无"}`);
			console.log(`  B 未命中：${missB.join("、") || "无"}`);
		}
		console.log("\n=== 堆词样本逐查询诊断 ===");
		const units = splitScoringBlocks([
			"# 第一章 工程概况 主要施工内容 重难点分析 施工部署 进度计划 质量保证 安全文明施工 资源配置 绿色环保 应急管理",
			"",
			"质量标准 计划工期 日历天 缺陷责任期 保修 安全目标 文明施工目标 项目经理 项目负责人",
			"",
			"C30，C25，C35，M5.0，M7.5，HRB400，HRB335，Q235，Q345，QTZ80，SC200，12000m²，420日历天，24个月，1500mm，900mm，200mm",
			"",
			"本小节围绕按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织"
		].join("\n"));
		const bodies = units.map(bodyOnly);
		const simUnits = await buildSemanticSimilarity(units, QUERIES);
		const simBodies = await buildSemanticSimilarity(bodies, QUERIES);
		console.log(`单元数=${units.length}；单元文本=「${units.join(" ⏎ ").slice(0, 120)}」`);
		for (const query of QUERIES) {
			const unitScore = Math.max(...units.map((unit) => simUnits(unit, query)), 0);
			const bodyScore = Math.max(...bodies.map((body) => simBodies(body, query)), 0);
			const mark = unitScore >= .6 ? " ← A命中" : "";
			console.log(`  A=${unitScore.toFixed(3)} B=${bodyScore.toFixed(3)}${mark} | ${query}`);
		}
	}
	main().catch((error) => {
		console.error("探针失败:", error);
		process.exit(1);
	});
}));
//#endregion
export default require_c0_probe();
export {};
