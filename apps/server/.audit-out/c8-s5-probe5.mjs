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
//#region .dbg/c8-s5-probe5.ts
/**
* C8 S5 probe5（修复轮 dry-run，c8-2-s5e 落码蓝本验证）：
* 算法蓝本 collapseDuplicateSentences(markdown)：
*   ① 行序扫描（与 duplicateSentenceStats 同源过滤/切句/去标点）收集完全重复句的全部出现（行号+行内偏移+原句+所属章）；
*   ② 决策：同章复读 → 保首次删后续；跨章复读且首现句命中泛句帧 → 保首次删后续；跨章业务句 → 保留；
*   ③ 删除：行内精确删除（含句末标点），空行行回收。
* 验证：s28m'（期望删 54 处、剩 excess ≤2）/ r28m'（期望删 8 处泛句、剩 excess ≤4），修复后 uniqueness 全量复算。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c8-s5-probe5.config.mjs
*   && node apps/server/.audit-out/c8-s5-probe5.mjs
*/
var require_c8_s5_probe5 = /* @__PURE__ */ __commonJSMin((() => {
	init_tenderBidScoring();
	init_budget();
	init_tenderBidChecks();
	init_narrativeContext();
	const DOCS = {
		"s28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949006905-e791c53e.json",
		"r28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949001562-48a0cce5.json"
	};
	/** 泛句帧（v2 简版，probe4 校准：21/21 覆盖 s28m' 泛句且排除 4 业务误伤句） */
	const GENERALIZED_CLOSURE_RE = /^(?:上述|相关|有关)(?:要求|做法|措施|内容|安排|控制要点|控制项|控制内容|作业要求)/u;
	function stripPunct(sentence) {
		return sentence.replace(/[\s，,、:：（）()【】[\]《》“”"'`]/gu, "");
	}
	function collapseDuplicateSentences(markdown) {
		const lines = markdown.split("\n");
		const occurrences = /* @__PURE__ */ new Map();
		let chapter = "(文首)";
		lines.forEach((line, lineIndex) => {
			if (/^##\s+/u.test(line.trim())) chapter = line.trim().replace(/^#+\s*/u, "").slice(0, 24);
			if (isFillerPoolExcludedLine(line) || isTocClusterLine(line)) return;
			for (const match of line.matchAll(/[^。；;]+/gu)) {
				const raw = (match[0] || "").trim();
				const stripped = stripPunct(raw);
				if (stripped.length < 12) continue;
				const list = occurrences.get(stripped) || [];
				list.push({
					lineIndex,
					start: match.index || 0,
					end: (match.index || 0) + (match[0] || "").length,
					raw,
					chapter
				});
				occurrences.set(stripped, list);
			}
		});
		const removed = [];
		const kept = [];
		const deleteByLine = /* @__PURE__ */ new Map();
		for (const [, list] of occurrences) {
			if (list.length < 2) continue;
			const sameChapter = new Set(list.map((item) => item.chapter)).size === 1;
			const generalized = GENERALIZED_CLOSURE_RE.test(list[0].raw);
			if (!sameChapter && !generalized) {
				kept.push(list[0].raw);
				continue;
			}
			for (const occurrence of list.slice(1)) {
				const target = deleteByLine.get(occurrence.lineIndex) || [];
				target.push({
					start: occurrence.start,
					end: occurrence.end
				});
				deleteByLine.set(occurrence.lineIndex, target);
				removed.push(occurrence.raw);
			}
		}
		const outLines = [...lines];
		let emptied = 0;
		for (const [lineIndex, ranges] of deleteByLine) {
			let line = outLines[lineIndex];
			ranges.sort((left, right) => right.start - left.start);
			for (const range of ranges) {
				const tail = /[。；;]/u.test(line[range.end] || "") ? range.end + 1 : range.end;
				line = line.slice(0, range.start) + line.slice(tail);
			}
			outLines[lineIndex] = line.replace(/^[ \t]+/u, "").replace(/[ \t]+$/u, "");
			if (!outLines[lineIndex].trim()) {
				emptied += 1;
				outLines[lineIndex] = "";
			}
		}
		return {
			markdown: outLines.join("\n").replace(/\n{4,}/gu, "\n\n\n"),
			removed,
			kept
		};
	}
	function main() {
		for (const [name, file] of Object.entries(DOCS)) {
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
			console.log(`\n===== ${name} =====`);
			console.log(`修复前：dupInstances=${before.duplicateInstances} rate=${before.duplicateRate.toFixed(4)} budget=${Math.max(10, Math.ceil(documentTextLength(markdown) / 1e4))} penalty=${Math.max(before.duplicateRate * 60, Math.max(0, before.duplicateInstances - Math.max(10, Math.ceil(documentTextLength(markdown) / 1e4)))).toFixed(2)}`);
			console.log(`删除 ${result.removed.length} 处；保留跨章业务句 ${result.kept.length} 种`);
			for (const sentence of result.kept) console.log(`   保留：${sentence.slice(0, 70)}`);
			console.log(`修复后：dupInstances=${after.duplicateInstances} rate=${after.duplicateRate.toFixed(4)} budget=${budget} excess=${excess} penalty=${penalty.toFixed(2)}`);
			console.log(`修复后唯一性复算：100 - ${forbiddenHits.length * 4}（空话 ${forbiddenHits.length}） - 0 - 0 - ${penalty.toFixed(2)} = ${uniqueness}（因子 ${Math.min(1, uniqueness / 90).toFixed(3)}）`);
			const removedGeneral = result.removed.filter((item) => GENERALIZED_CLOSURE_RE.test(item)).length;
			console.log(`删除构成：泛句 ${removedGeneral} 处；业务句 ${result.removed.length - removedGeneral} 处`);
		}
	}
	main();
}));
//#endregion
export default require_c8_s5_probe5();
export {};
