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
/** 共享句池构建：过滤非正文行后按。；; 切句，仅保留 ≥12 字正文句（检测/修复锚点/生成期质检三端同源） */
function buildFillerSentencePool(markdown) {
	return markdown.split("\n").filter((line) => !isFillerPoolExcludedLine(line)).flatMap((line) => line.split(/[。；;]/u)).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 12);
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
//#region .dbg/c8-s5-probe3.ts
/**
* C8 S5 probe3（修复选型校准，c8-2-s5d/e）：
* A. 「泛化归口式」新族 test 草案在 s28m' 的覆盖验证（20 句泛句式须全命中）；
* B. 同 test 在 r28m'/s28m 旧任务的计数（防误伤校准：自然语式项目应显著低于命中线）；
* C. s28m' 同章复读 17 句的上下文（±120 字）——形态抽查（判「确定性去重」可行性）；
* D. r28m'/s28m 旧任务 duplicateSentenceStats 全景（对照基线）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c8-s5-probe3.config.mjs
*   && node apps/server/.audit-out/c8-s5-probe3.mjs
*/
var require_c8_s5_probe3 = /* @__PURE__ */ __commonJSMin((() => {
	init_tenderBidScoring();
	init_budget();
	init_tenderBidChecks();
	const DOCS = {
		"s28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949006905-e791c53e.json",
		"r28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949001562-48a0cce5.json",
		"s28m旧": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789924922703-51312917.json"
	};
	/** 新族草案 v1：归口动词支路（上述/相关/有关…纳入/编入/写入/贯通/归入） */
	const DRAFT_A = /^(?:上述|相关|有关)[^。！？\n]{0,30}?(?:纳入|编入|写入|贯通|归入)/u;
	/** 新族草案 v1：载体+频次支路（^上述/相关 + 归口载体 + 频次/核验动作） */
	const DRAFT_B = (sentence) => /^(?:上述|相关|有关)/u.test(sentence) && /施工方案|工艺流程|作业流程|管理制度|作业指导书|操作规程|施工工序卡|技术交底|施工组织设计/u.test(sentence) && /每日|每周|每月|每批|逐班|逐项|逐道|逐处|随做随记|随时|定期|可追溯|可核验|可查/u.test(sentence);
	function sentencesOf(markdown) {
		return buildFillerSentencePool(markdown);
	}
	function main() {
		for (const [name, file] of Object.entries(DOCS)) {
			const wrapper = JSON.parse(readFileSync(file, "utf8"));
			const markdown = String(wrapper.markdown ?? "");
			const textLength = documentTextLength(markdown);
			const pool = sentencesOf(markdown);
			const hitsA = pool.filter((sentence) => DRAFT_A.test(sentence));
			const hitsB = pool.filter((sentence) => !DRAFT_A.test(sentence) && DRAFT_B(sentence));
			const total = new Set([...hitsA, ...hitsB]);
			const dup = duplicateSentenceStats(markdown);
			const threshold = Math.max(6, Math.ceil(textLength / 5e3));
			console.log(`\n===== ${name}（${file.split("/").pop()}）=====`);
			console.log(`有效字数 ${textLength}；句池 ${pool.length}；句模命中线 ${threshold}`);
			console.log(`新族草案：A 支路 ${hitsA.length} 处（${new Set(hitsA).size} 种）；B 支路 ${hitsB.length} 处（${new Set(hitsB).size} 种）；合计实例 ${hitsA.length + hitsB.length}，种类 ${total.size}`);
			console.log(`duplicateSentenceStats：total=${dup.totalSentences} dupInstances=${dup.duplicateInstances} rate=${dup.duplicateRate.toFixed(4)} budget=${Math.max(10, Math.ceil(textLength / 1e4))} penalty=${Math.max(dup.duplicateRate * 60, Math.max(0, dup.duplicateInstances - Math.max(10, Math.ceil(textLength / 1e4)))).toFixed(2)}`);
			if (name === "s28m'") {
				console.log("—— 新族 A/B 支路命中句（去重明细）——");
				for (const sentence of total) console.log(`   · ${sentence.slice(0, 70)}`);
			} else {
				console.log("—— 命中句抽查（前 12）——");
				for (const sentence of [...total].slice(0, 12)) console.log(`   · ${sentence.slice(0, 70)}`);
			}
		}
		const wrapper = JSON.parse(readFileSync(DOCS["s28m'"], "utf8"));
		const markdown = String(wrapper.markdown ?? "");
		const sameChapter = [
			"对不能按用人单位参加工伤保险的建筑工人由施工总承包企业负责按项目参加工伤保险",
			"排水工程回填方合计17258.99m³管基以上至路床以下采用级配碎石回填",
			"管道基础按设计断面浇筑混凝土强度等级C20",
			"白鸥观澜公厕现浇构件钢筋坡屋面板",
			"本项目无拆迁工程不涉及拆迁工地湿法作业"
		];
		console.log("\n===== C. 同章复读句上下文抽查（s28m'）=====");
		for (const fragment of sameChapter) {
			console.log(`\n■ ${fragment}`);
			let at = markdown.indexOf(fragment);
			while (at >= 0) {
				console.log(`   @${at}: …${markdown.slice(Math.max(0, at - 100), at + fragment.length + 100).replace(/\n/gu, "⏎")}…`);
				at = markdown.indexOf(fragment, at + fragment.length);
			}
		}
	}
	main();
}));
//#endregion
export default require_c8_s5_probe3();
export {};
