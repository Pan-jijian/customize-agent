import { readFileSync } from "node:fs";
import "@customize-agent/knowledge";
//#region \0rolldown/runtime.js
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
//#endregion
//#region apps/server/src/services/document-workflow/budget.ts
function documentTextLength(markdown) {
	return markdown.replace(/<[^>]+>/gu, "").replace(/\s+/gu, "").length;
}
var init_budget = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/templatingGovernance.ts
var GENERALIZED_CLOSURE_SENTENCE_RE;
var init_templatingGovernance = __esmMin((() => {
	GENERALIZED_CLOSURE_SENTENCE_RE = /^(?:上述|相关|有关)(?:要求|做法|措施|内容|安排|控制要点|控制项|控制内容|作业要求)/u;
}));
var init_documentFactTrace = __esmMin((() => {
	new RegExp(`(?:GB|JGJ|CJJ|CECS|ISO|SL|DL|JTS|JTG|JT|TB|DB\\d{2}|DB)\\s*\\/?\\s*T?\\s*(\\d{3,5})(?:\\s*[-—–]\\s*(\\d{2,4}))?`, "giu");
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
var init_narrativeContext = __esmMin((() => {
	init_tenderBidChecks();
}));
//#endregion
//#region apps/server/src/services/document-workflow/tenderBidScoring.ts
/** 完全重复句分组（按出现序；含唯一句组——修复端过滤 length≥2）：
* 比较键 = 去标点归一化文本，与 duplicateSentenceStats 原口径逐字一致。 */
function duplicateSentenceOccurrences(markdown) {
	const groups = /* @__PURE__ */ new Map();
	markdown.split("\n").forEach((line, lineIndex) => {
		if (isFillerPoolExcludedLine(line) || isTocClusterLine(line)) return;
		for (const match of line.matchAll(/[^。；;]+/gu)) {
			const text = match[0] || "";
			const raw = text.trim();
			const key = raw.replace(/[\s，,、:：（）()【】[\]《》“”"'`]/gu, "");
			if (key.length < 12) continue;
			const start = (match.index || 0) + (text.length - text.trimStart().length);
			const list = groups.get(key) || [];
			list.push({
				lineIndex,
				start,
				end: start + raw.length,
				raw
			});
			groups.set(key, list);
		}
	});
	return [...groups.entries()].map(([key, occurrences]) => ({
		key,
		occurrences
	}));
}
function duplicateSentenceStats(markdown) {
	const groups = duplicateSentenceOccurrences(markdown);
	const totalSentences = groups.reduce((sum, group) => sum + group.occurrences.length, 0);
	const uniqueSentences = groups.length;
	const duplicateInstances = totalSentences - uniqueSentences;
	return {
		totalSentences,
		uniqueSentences,
		duplicateInstances,
		duplicateRate: totalSentences > 0 ? duplicateInstances / totalSentences : 0
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
//#region apps/server/src/services/document-workflow/finalize/repairRounds/duplicateSentenceCollapse.ts
function collapseDuplicateSentences(markdown) {
	const lines = markdown.split("\n");
	const chapterOf = [];
	let chapterKey = "(文首)";
	lines.forEach((rawLine, lineIndex) => {
		const line = rawLine.trim();
		if (/^##\s+/u.test(line)) chapterKey = line;
		chapterOf[lineIndex] = chapterKey;
	});
	const removedSentences = [];
	const keptSentences = [];
	const deleteByLine = /* @__PURE__ */ new Map();
	let sameChapterRemoved = 0;
	let generalizedRemoved = 0;
	for (const group of duplicateSentenceOccurrences(markdown)) {
		const occurrences = group.occurrences;
		if (occurrences.length < 2) continue;
		const sameChapter = new Set(occurrences.map((item) => chapterOf[item.lineIndex])).size === 1;
		const generalized = GENERALIZED_CLOSURE_SENTENCE_RE.test(occurrences[0].raw);
		if (!sameChapter && !generalized) {
			keptSentences.push(occurrences[0].raw);
			continue;
		}
		for (const occurrence of occurrences.slice(1)) {
			const ranges = deleteByLine.get(occurrence.lineIndex) || [];
			ranges.push({
				start: occurrence.start,
				end: occurrence.end
			});
			deleteByLine.set(occurrence.lineIndex, ranges);
			removedSentences.push(occurrence.raw);
			if (sameChapter) sameChapterRemoved += 1;
			else generalizedRemoved += 1;
		}
	}
	if (removedSentences.length === 0) return {
		markdown,
		removedCount: 0,
		removedSentences,
		keptSentences,
		sameChapterRemoved,
		generalizedRemoved
	};
	for (const [lineIndex, ranges] of deleteByLine) {
		let line = lines[lineIndex];
		for (const range of ranges.sort((left, right) => right.start - left.start)) {
			let start = range.start;
			while (start > 0 && /\s/u.test(line[start - 1])) start -= 1;
			let end = range.end;
			while (end < line.length && /\s/u.test(line[end])) end += 1;
			if (/[。；;]/u.test(line[end] || "")) end += 1;
			line = line.slice(0, start) + line.slice(end);
		}
		lines[lineIndex] = line.trim() === "" ? "" : line.replace(/^[ \t]+/u, "").replace(/[ \t]+$/u, "");
	}
	return {
		markdown: lines.join("\n").replace(/\n{4,}/gu, "\n\n\n"),
		removedCount: removedSentences.length,
		removedSentences,
		keptSentences,
		sameChapterRemoved,
		generalizedRemoved
	};
}
var init_duplicateSentenceCollapse = __esmMin((() => {
	init_templatingGovernance();
	init_tenderBidScoring();
}));
//#endregion
//#region .dbg/c8-s5e-replay.ts
/**
* C8 S5e-5 实机复验（正式实现重放，对照 probe5 dry-run 蓝本）：
* 直接 import 正式落码的 collapseDuplicateSentences（finalize/repairRounds/duplicateSentenceCollapse.ts，
* 消费 duplicateSentenceOccurrences 单源 + GENERALIZED_CLOSURE_SENTENCE_RE），对 s28m'/r28m' 终稿重放：
* 期望 s28m' 删 54 处（同章 17 + 泛句 37）、保留跨章业务 2 种 → uniqueness 53→88（因子 0.978）；
* 期望 r28m' 删 11 处、保留 1 种 → 98→100（因子 1.000）。零误伤（跨章业务句不坍塌）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c8-s5e-replay.config.mjs
*   && node apps/server/.audit-out/c8-s5e-replay.mjs
*/
var require_c8_s5e_replay = /* @__PURE__ */ __commonJSMin((() => {
	init_duplicateSentenceCollapse();
	init_tenderBidScoring();
	init_budget();
	for (const [name, file] of Object.entries({
		"s28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949006905-e791c53e.json",
		"r28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949001562-48a0cce5.json"
	})) {
		const wrapper = JSON.parse(readFileSync(file, "utf8"));
		const markdown = String(wrapper.markdown ?? "");
		const before = duplicateSentenceStats(markdown);
		const result = collapseDuplicateSentences(markdown);
		const after = duplicateSentenceStats(result.markdown);
		const textLength = documentTextLength(result.markdown);
		const budget = Math.max(10, Math.ceil(textLength / 1e4));
		const excess = Math.max(0, after.duplicateInstances - budget);
		const penalty = Math.max(after.duplicateRate * 60, excess);
		const forbiddenHits = FORBIDDEN_EMPTY_PHRASES.filter((phrase) => result.markdown.includes(phrase));
		const uniqueness = Math.max(0, Math.round(100 - forbiddenHits.length * 4 - 0 - 0 - penalty));
		const beforeBudget = Math.max(10, Math.ceil(documentTextLength(markdown) / 1e4));
		const beforeExcess = Math.max(0, before.duplicateInstances - beforeBudget);
		const beforePenalty = Math.max(before.duplicateRate * 60, beforeExcess);
		const beforeForbidden = FORBIDDEN_EMPTY_PHRASES.filter((phrase) => markdown.includes(phrase));
		const beforeUniqueness = Math.max(0, Math.round(100 - beforeForbidden.length * 4 - beforePenalty));
		console.log(`\n===== ${name}（正式实现重放）=====`);
		console.log(`修复前：dupInstances=${before.duplicateInstances} rate=${before.duplicateRate.toFixed(4)} budget=${beforeBudget} excess=${beforeExcess} penalty=${beforePenalty.toFixed(2)}`);
		console.log(`修复前唯一性：100 - ${beforeForbidden.length * 4}（空话 ${beforeForbidden.length}） - ${beforePenalty.toFixed(2)} = ${beforeUniqueness}（因子 ${Math.min(1, beforeUniqueness / 90).toFixed(3)}）`);
		console.log(`删除 ${result.removedCount} 处（同章复读 ${result.sameChapterRemoved} + 跨章泛化归口复读 ${result.generalizedRemoved}）；保留跨章业务句 ${result.keptSentences.length} 种`);
		for (const sentence of result.keptSentences) console.log(`   保留：${sentence.slice(0, 70)}`);
		console.log(`   删除前 5 处：`);
		for (const sentence of result.removedSentences.slice(0, 5)) console.log(`     「${sentence.slice(0, 60)}」`);
		console.log(`修复后：dupInstances=${after.duplicateInstances} rate=${after.duplicateRate.toFixed(4)} budget=${budget} excess=${excess} penalty=${penalty.toFixed(2)}`);
		console.log(`修复后唯一性：100 - ${forbiddenHits.length * 4}（空话 ${forbiddenHits.length}） - 0 - 0 - ${penalty.toFixed(2)} = ${uniqueness}（因子 ${Math.min(1, uniqueness / 90).toFixed(3)}）`);
		console.log(`保真核对：字符长度 ${markdown.length} → ${result.markdown.length}（删减 ${markdown.length - result.markdown.length}）；有效字数 ${documentTextLength(markdown)} → ${textLength}`);
		console.log(`幂等核对：二次重放删除 ${collapseDuplicateSentences(result.markdown).removedCount} 处（期望 0）`);
	}
}));
//#endregion
export default require_c8_s5e_replay();
export {};
