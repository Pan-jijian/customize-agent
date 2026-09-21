import { readFileSync } from "node:fs";
import "@customize-agent/knowledge";
//#region \0rolldown/runtime.js
var __esmMin = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
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
//#region .dbg/c8-s5-probe4.ts
/**
* C8 S5 probe4（判据定稿验证，c8-2-s5d/e）：
* A. 泛句帧 v2（^(上述|相关|有关)+(泛对象词)前缀，+可选归口谓词）在 s28m'/r28m'/s28m旧 的计数与明细对比；
* B. s28m' 同章复读 17 句的行级定位（上下文 ±2 行）——判「保首次删后续」可行性；
* C. 「泛句帧 ∩ 同句复读」矩阵：s28m'（应 20 种）/r28m'（应 0 种）——修复轮触发判据验证。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c8-s5-probe4.config.mjs
*   && node apps/server/.audit-out/c8-s5-probe4.mjs
*/
var require_c8_s5_probe4 = /* @__PURE__ */ __commonJSMin((() => {
	init_tenderBidChecks();
	init_narrativeContext();
	const DOCS = {
		"s28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949006905-e791c53e.json",
		"r28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949001562-48a0cce5.json"
	};
	/** 泛句帧 v2 简版：句首（上述|相关|有关）+ 泛对象词 */
	const V2_SIMPLE = /^(?:上述|相关|有关)(?:要求|做法|措施|内容|安排|控制要点|控制项|控制内容|作业要求)/u;
	/** 泛句帧 v2 全版：简版 + 归口谓词/载体共现 */
	const V2_FULL = /^(?:上述|相关|有关)(?:要求|做法|措施|内容|安排|控制要点|控制项|控制内容|作业要求)[^。！？\n]{0,30}?(?:纳入|编入|写入|贯通|归入|按|以|通过|同步|落实)/u;
	function stripPunct(sentence) {
		return sentence.replace(/[\s，,、:：（）()【】[\]《》“”"'`]/gu, "");
	}
	function main() {
		for (const [name, file] of Object.entries(DOCS)) {
			const wrapper = JSON.parse(readFileSync(file, "utf8"));
			const pool = buildFillerSentencePool(String(wrapper.markdown ?? ""));
			const simple = pool.filter((sentence) => V2_SIMPLE.test(sentence));
			const full = pool.filter((sentence) => V2_FULL.test(sentence));
			console.log(`\n===== ${name} =====`);
			console.log(`v2 简版：${simple.length} 实例 / ${new Set(simple).size} 种；v2 全版：${full.length} 实例 / ${new Set(full).size} 种`);
			console.log("—— v2 简版命中明细（去重）——");
			for (const sentence of new Set(simple)) console.log(`   · ${sentence.slice(0, 66)}`);
			console.log("—— v2 全版排除了哪些简版句（前 15）——");
			for (const sentence of [...new Set(simple)].filter((item) => !V2_FULL.test(item)).slice(0, 15)) console.log(`   · ${sentence.slice(0, 66)}`);
		}
		const wrapper = JSON.parse(readFileSync(DOCS["s28m'"], "utf8"));
		const markdown = String(wrapper.markdown ?? "");
		const targets = [
			"对不能按用人单位参加工伤保险的建筑工人",
			"对未按规定配备足够数量和资格专职安全员",
			"排水工程回填方合计17258.99",
			"本项目无拆迁工程",
			"白鸥观澜公厕现浇构件钢筋坡屋面板",
			"现场部分存在苗木树根"
		];
		console.log("\n===== B. 同章复读句行级定位（s28m', 前 6 例）=====");
		const lines = markdown.split("\n");
		const hitByTarget = /* @__PURE__ */ new Map();
		lines.forEach((line, index) => {
			if (isFillerPoolExcludedLine(line) || isTocClusterLine(line)) return;
			const joined = line.split(/[。；;]/u).map((item) => stripPunct(item)).join("|");
			for (const target of targets) if (joined.includes(stripPunct(target))) {
				const list = hitByTarget.get(target) || [];
				list.push(index);
				hitByTarget.set(target, list);
			}
		});
		for (const target of targets) {
			const hits = hitByTarget.get(target) || [];
			console.log(`\n■ ${target}——出现行：[${hits.join(", ")}]`);
			for (const index of hits) {
				const context = lines.slice(Math.max(0, index - 2), index + 3).map((item, offset) => `      ${offset === 2 ? "»" : " "} ${item.slice(0, 86)}`).join("\n");
				console.log(context);
			}
		}
		console.log("\n===== C. 泛句帧 ∩ 同句复读 矩阵 =====");
		for (const [name, file] of Object.entries(DOCS)) {
			const wrapper2 = JSON.parse(readFileSync(file, "utf8"));
			const pool2 = buildFillerSentencePool(String(wrapper2.markdown ?? ""));
			const counts = /* @__PURE__ */ new Map();
			for (const sentence of pool2) counts.set(sentence, (counts.get(sentence) || 0) + 1);
			const repeats = [...counts.entries()].filter(([, count]) => count >= 2);
			const closureRepeats = repeats.filter(([sentence]) => V2_SIMPLE.test(sentence));
			const businessRepeats = repeats.filter(([sentence]) => !V2_SIMPLE.test(sentence));
			const closureExcess = closureRepeats.reduce((sum, [, count]) => sum + count - 1, 0);
			const businessExcess = businessRepeats.reduce((sum, [, count]) => sum + count - 1, 0);
			console.log(`${name}：泛句复读 ${closureRepeats.length} 种（excess ${closureExcess}）；业务复读 ${businessRepeats.length} 种（excess ${businessExcess}）`);
		}
	}
	main();
}));
//#endregion
export default require_c8_s5_probe4();
export {};
