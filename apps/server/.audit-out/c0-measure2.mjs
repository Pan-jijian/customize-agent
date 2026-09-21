import { readFileSync } from "node:fs";
//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
//#endregion
//#region .dbg/c0-measure2.ts
/**
* C0 补充测量：重复句明细（长度归一校准样本）与「叙述语境参数占比」预估。
*/
var require_c0_measure2 = /* @__PURE__ */ __commonJSMin((() => {
	const DOCS = [{
		name: "r28l 丰乐",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884268681-31f4980c.json"
	}, {
		name: "s28l 舒城",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884273697-ea5fbe91.json"
	}];
	const PARAM_RE = /\d+(?:\.\d+)?\s*(?:m²|㎡|m3|m³|mm|cm|m|km|kg|t|MPa|kPa|℃|%|日历天|天|层|台|套|个|项|次|份|人|小时)/giu;
	function sentences(markdown) {
		return markdown.split(/\n+/u).filter((line) => line.trim() && !/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(line)).flatMap((line) => line.split(/[。；;]/u)).map((sentence) => sentence.replace(/[\s，,、:：（）()【】[\]《》“”"'`]/gu, "")).filter((sentence) => sentence.length >= 12);
	}
	for (const doc of DOCS) {
		const markdown = JSON.parse(readFileSync(doc.file, "utf8")).markdown || "";
		console.log(`\n================ ${doc.name} ================`);
		const list = sentences(markdown);
		const seen = /* @__PURE__ */ new Map();
		for (const sentence of list) seen.set(sentence, (seen.get(sentence) || 0) + 1);
		const dups = [...seen.entries()].filter(([, count]) => count > 1).sort((a, b) => b[1] - a[1]);
		console.log(`重复句类型数=${dups.length}，重复句实例数=${list.length - seen.size}`);
		for (const [sentence, count] of dups.slice(0, 14)) console.log(`  ×${count} 「${sentence.slice(0, 56)}」`);
		const all = new Set(markdown.match(PARAM_RE) || []);
		const inNarrative = /* @__PURE__ */ new Set();
		const lines = markdown.split("\n");
		for (const line of lines) {
			const trimmed = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim();
			if (!trimmed || /^[#|>*+-]/u.test(trimmed)) continue;
			for (const seg of trimmed.split(/[。！？；;]/u)) {
				const piece = seg.trim();
				if (piece.length < 12) continue;
				if (piece.replace(PARAM_RE, "").replace(/[\s\d，,、:：.．+×xX\-—/()（）【】\[\]"'“”‘’]+/g, "").length < 8) continue;
				for (const token of piece.match(PARAM_RE) || []) inNarrative.add(token);
			}
		}
		console.log(`参数 token：全量 ${all.size}，叙述语境内 ${inNarrative.size}（保留率 ${(inNarrative.size / Math.max(1, all.size) * 100).toFixed(1)}%）`);
		const missing = [...all].filter((token) => !inNarrative.has(token)).slice(0, 12);
		console.log(`  仅出现在表格/罗列/短句的参数样例：${missing.join("、")}`);
	}
}));
//#endregion
export default require_c0_measure2();
export {};
