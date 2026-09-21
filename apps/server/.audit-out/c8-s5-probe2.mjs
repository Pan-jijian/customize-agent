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
//#region apps/server/src/services/document-workflow/templatingGovernance.ts
/**
* 句模复读命中线（C8 S3② 密度归一，P3 口径校准）：绝对计数 6 于长文误伤自然语式
* （r28m' 6.5 万字 form-announcement 8 处判误报 vs s28m' 21 万字 46 处判真复读）——
* 命中线按正文字数密度上浮：max(6, ceil(documentTextLength/5000))（=2.0 处/万字）。
* 校准锚点：r28m'（1.23/万，自然语式）应通过、s28m' 修复前（2.20/万，真复读）应命中、
* S3① 引导句确定性剥离后残留（1.82/万）应通过。检测/修复目标/评分/复检四端单源消费。
*/
function sentencePatternThreshold(markdown) {
	return Math.max(6, Math.ceil(documentTextLength(markdown) / 5e3));
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
/**
* 句模复读检测（终检注册）：任一结构帧全篇命中数 ≥ 密度阈值即 error/blocker——同模式句重复即模板
* 化观感（句内事实可核查，但与 filler 语义概念正交，属独立治理维度；阈值口径见 sentencePatternThreshold）。
*/
function sentencePatternRepeatIssues(markdown) {
	const issues = [];
	const pool = sentencePoolOf(markdown);
	const threshold = sentencePatternThreshold(markdown);
	for (const family of SENTENCE_PATTERN_FAMILIES) {
		const count = pool.filter(family.test).length;
		if (count < threshold) continue;
		issues.push({
			level: "error",
			severity: "blocker",
			category: "style",
			owner: "llm",
			repairability: "llm_repairable",
			message: `句式模版复读：「${family.label}」全篇出现 ${count} 处（复读命中线 ${threshold} 处）——同模式句重复，模板化观感`,
			suggestion: `保留全文前 ${threshold - 1} 处，其余处逐句改写为自然多样表达（变换句式结构与连接方式，或拆分为多句；各句改写方向须彼此不同，不得集中复用同一替换句式）；改写保留原句全部工序顺序、数值与验收事实，不得删减工艺参数。`
		});
	}
	return issues;
}
var SEQUENCE_CONNECTIVES, SENTENCE_PATTERN_FAMILIES;
var init_templatingGovernance = __esmMin((() => {
	init_budget();
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
//#region .dbg/c8-s5-probe2.ts
/**
* C8 S5 probe2（定性定位，c8-2-s5d）：
* A. 56 个重复实例逐句定位（章 + 同章/跨章分类）——定性「真实复读 vs 合理重申」；
* B. 39 种重复句逐句跑 SENTENCE_PATTERN_FAMILIES 族判定（验证是否落入 S3 治理范围）；
* C. sentencePatternRepeatIssues 全文级输出（S3 视角交叉——族级命中与句级复读的交集）；
* D. FORBIDDEN_EMPTY_PHRASES 命中语境 ±80 字（防误伤核对）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c8-s5-probe2.config.mjs
*   && node apps/server/.audit-out/c8-s5-probe2.mjs
*/
var require_c8_s5_probe2 = /* @__PURE__ */ __commonJSMin((() => {
	init_tenderBidScoring();
	init_budget();
	init_templatingGovernance();
	init_tenderBidChecks();
	init_narrativeContext();
	const DOC = "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949006905-e791c53e.json";
	function main() {
		const wrapper = JSON.parse(readFileSync(DOC, "utf8"));
		const markdown = String(wrapper.markdown ?? "");
		console.log("=== C8-S5 probe2 定性定位（s28m' e791c53e）===");
		console.log(`有效字数 ${documentTextLength(markdown)}；句模复读命中线 ${sentencePatternThreshold(markdown)}`);
		const occurrencesBySentence = /* @__PURE__ */ new Map();
		let currentChapter = "(文首无章)";
		let lineIndex = 0;
		for (const line of markdown.split("\n")) {
			lineIndex += 1;
			if (/^##\s+/u.test(line.trim())) currentChapter = line.trim().replace(/^#+\s*/u, "").slice(0, 30);
			if (isFillerPoolExcludedLine(line) || isTocClusterLine(line)) continue;
			for (const raw of line.split(/[。；;]/u)) {
				const sentence = raw.replace(/[\s，,、:：（）()【】[\]《》“”"'`]/gu, "");
				if (sentence.length < 12) continue;
				const list = occurrencesBySentence.get(sentence) || [];
				list.push({
					chapter: currentChapter,
					lineIndex
				});
				occurrencesBySentence.set(sentence, list);
			}
		}
		const repeats = [...occurrencesBySentence.entries()].filter(([, list]) => list.length >= 2).sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]));
		let sameChapterInstances = 0;
		let crossChapterInstances = 0;
		console.log(`\n── A. 重复句定位：${repeats.length} 种 / ${repeats.reduce((sum, [, list]) => sum + list.length - 1, 0)} excess 实例 ──`);
		for (const [sentence, list] of repeats) {
			const chapters = [...new Set(list.map((item) => item.chapter))];
			const sameChapter = chapters.length === 1;
			if (sameChapter) sameChapterInstances += list.length - 1;
			else crossChapterInstances += list.length - 1;
			console.log(`\n×${list.length} [${sameChapter ? "同章" : "跨章"}] ${sentence.slice(0, 70)}`);
			for (const chapter of chapters) {
				const count = list.filter((item) => item.chapter === chapter).length;
				console.log(`   - ${chapter} ×${count}`);
			}
		}
		console.log(`\n汇总：同章复读 excess=${sameChapterInstances}；跨章复读 excess=${crossChapterInstances}`);
		console.log("\n── B. 重复句族判定（SENTENCE_PATTERN_FAMILIES）──");
		let familyHitCount = 0;
		for (const [sentence, list] of repeats) {
			const hits = SENTENCE_PATTERN_FAMILIES.filter((family) => family.test(sentence)).map((family) => family.id);
			if (hits.length > 0) {
				familyHitCount += 1;
				console.log(`×${list.length} → [${hits.join(",")}] ${sentence.slice(0, 60)}`);
			}
		}
		console.log(`族命中：${familyHitCount}/${repeats.length} 种重复句落入 S3 族治理范围`);
		console.log("\n── C. sentencePatternRepeatIssues 全文（S3 视角）──");
		const patternIssues = sentencePatternRepeatIssues(markdown);
		if (patternIssues.length === 0) console.log("   （无族级复读）");
		for (const issue of patternIssues) console.log(`   · ${issue.message}`);
		console.log("\n── D. FORBIDDEN_EMPTY_PHRASES 命中语境核对 ──");
		for (const phrase of FORBIDDEN_EMPTY_PHRASES) {
			let at = markdown.indexOf(phrase);
			while (at >= 0) {
				console.log(`「${phrase}」@${at}: …${markdown.slice(Math.max(0, at - 60), at + phrase.length + 60).replace(/\n/gu, "⏎")}…`);
				at = markdown.indexOf(phrase, at + phrase.length);
			}
		}
	}
	main();
}));
//#endregion
export default require_c8_s5_probe2();
export {};
