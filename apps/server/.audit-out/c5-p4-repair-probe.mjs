import { L as __commonJSMin } from "./templateStore-DlqMBWhl.js";
import { _ as init_qualityValidation, g as applyDeterministicConsistencyFixes, n as fixSelfUnderminingCandidates, r as init_fixers, t as fixAmbiguousEitherOrCandidates } from "./fixers-sOfeD6E2.js";
import { readFileSync } from "node:fs";
//#region .dbg/c5-p4-repair-probe.ts
/**
* C5-5 P4 修复链消费实证探针：
* ① global-consistency-repair 六种章节定位手段对 s28l 残留消息的命中测试（台数冲突死链验证）；
* ② fixSelfUnderminingCandidates 对 r28l 自伤残留的修复能力；
* ③ fixAmbiguousEitherOrCandidates 对 s28l 两可残留的修复能力；
* ④ applyDeterministicConsistencyFixes 对 s28l「3210.15㎡」规模残留的修复能力；
* ⑤ 自卸汽车/保护层/近似数值/设备表占位符的原文上下文提取。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c5-p4-repair-probe.config.mjs
*   node apps/server/.audit-out/c5-p4-repair-probe.mjs
*/
var require_c5_p4_repair_probe = /* @__PURE__ */ __commonJSMin((async () => {
	init_fixers();
	init_qualityValidation();
	const DOCS = {
		r28l: { file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884268681-31f4980c.json" },
		s28l: { file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884273697-ea5fbe91.json" }
	};
	function loadDoc(name) {
		const wrapper = JSON.parse(readFileSync(DOCS[name].file, "utf8"));
		const layer = wrapper.draft ?? wrapper;
		return {
			name,
			markdown: String(layer.markdown ?? ""),
			chapters: Array.isArray(layer.chapters) ? layer.chapters : [],
			factsModel: layer.factsModel ?? {}
		};
	}
	function locateChapters(issue, chapters) {
		const matched = [];
		for (const chapter of chapters) {
			const normalizedChapterContent = chapter.content.replace(/\s+/gu, "").replace(/平方米|m²|m2/giu, "㎡");
			if (issue.includes(chapter.title)) {
				matched.push(chapter.title);
				continue;
			}
			if (/基坑深度数值未锁定/u.test(issue)) {
				if (/基坑|支护|开挖|土方|降水/u.test(chapter.title) || chapter.content.includes("基坑")) matched.push(chapter.title);
				continue;
			}
			if ((issue.match(/不一致的表述\s*([^；;。\n]+)/u)?.[1] || "").split(/[、，,]/u).some((value) => {
				const normalized = value.trim().replace(/\s+/gu, "").replace(/平方米|m²|m2/giu, "㎡");
				return normalized.length >= 3 && normalizedChapterContent.includes(normalized);
			})) {
				matched.push(chapter.title);
				continue;
			}
			const layer = issue.match(/正文([^配比厚度\s]{1,6}?)(?:配比|厚度)/u)?.[1];
			if (layer && chapter.content.includes(layer)) {
				matched.push(chapter.title);
				continue;
			}
			if ([...issue.matchAll(/“([^”]{6,80})”/gu)].some((match) => normalizedChapterContent.includes(match[1].replace(/\s+/gu, "")))) {
				matched.push(chapter.title);
				continue;
			}
			if ([...issue.matchAll(/(\d[\d,，.]*)\s*(?:人|台|日|个|次|天|月|套|具|处|项|条)/gu)].some((match) => normalizedChapterContent.includes(match[0].replace(/\s+/gu, "")))) {
				matched.push(chapter.title);
				continue;
			}
		}
		return matched;
	}
	function contextLines(markdown, needle, window = 50, limit = 6) {
		const out = [];
		let index = markdown.indexOf(needle);
		while (index !== -1 && out.length < limit) {
			out.push(markdown.slice(Math.max(0, index - window), index + needle.length + window).replace(/\n/gu, "⏎"));
			index = markdown.indexOf(needle, index + needle.length);
		}
		return out;
	}
	function main(doc, other) {
		console.log(`\n══════════════ ${doc.name}（chapters ${doc.chapters.length}） ══════════════`);
		for (const issue of [
			"跨章一致性冲突：正文「高清网络球形摄像机」配置台数出现互相矛盾的取值 8、33；全项目「高清网络球形摄像机」配置总量必须全文唯一：以全项目机械配置总表为准统一全部表述；分组配置必须显式注明「本组配置、按总表调度」并删除与总表矛盾的全项目口径数字。",
			"跨章一致性冲突：正文「道闸机」配置台数出现互相矛盾的取值 6、1；全项目「道闸机」配置总量必须全文唯一：以全项目机械配置总表为准统一全部表述。",
			"跨章一致性冲突：正文出现与资料建设规模不一致的表述 961.42平方米、3210.15㎡；请统一使用资料中的建设规模口径：建设规模 总建筑面积为961.42平方米",
			"同一参数概念出现多口径数值冲突：“基础底板钢筋保护层厚度”出现多个口径：基础底板钢筋保护层厚度40mm、柱梁钢筋保护层厚度25mm、板钢筋保护层厚度15mm；以绑定资料（图纸/清单/规范）裁决口径为准统一数值表述。",
			"规格错位：“成品坐椅”使用的规格 1000mm 与工程量清单权威（700mm）不一致；按工程量清单将“成品坐椅”的规格统一为 700mm。",
			"关键设计决策两可表述：基础预埋件焊接或螺栓连接 以并列/悬置形态表述，基础形式、支护形式等关键决策必须在正文中唯一确定。",
			"近似数值不可推导：正文「约 28792m2」的 28792m2 在清单/蓝图/事实主表中无同值或近似来源，违反无据不写。"
		]) {
			const hits = locateChapters(issue, doc.chapters);
			console.log(`\n[定位] ${issue.slice(0, 60)}…\n  → 命中章: ${hits.length > 0 ? hits.join(" / ") : "【零命中 —— 修复任务不派发】"}`);
		}
		console.log("\n[上下文] 自卸汽车:");
		for (const line of contextLines(doc.markdown, "自卸汽车", 40, 4)) console.log("  · " + line);
		console.log("\n[上下文] 保护层厚度:");
		for (const line of contextLines(doc.markdown, "保护层厚度", 40, 4)) console.log("  · " + line);
		console.log("\n[上下文] 37112 / 28792:");
		for (const line of [...contextLines(doc.markdown, "37112", 40, 2), ...contextLines(doc.markdown, "28792", 40, 2)]) console.log("  · " + line);
		console.log("\n[上下文] 国别产地（设备表头）:");
		const tableIndex = doc.markdown.indexOf("国别产地");
		if (tableIndex !== -1) console.log("  · " + doc.markdown.slice(Math.max(0, tableIndex - 260), tableIndex + 420).replace(/\n/gu, "⏎"));
		const selfFix = fixSelfUnderminingCandidates(doc.markdown);
		console.log(`\n[fixSelfUnderminingCandidates] fixedCount=${selfFix.fixedCount}`);
		for (const detail of selfFix.details.slice(0, 6)) console.log("  · " + detail);
		const ambFix = fixAmbiguousEitherOrCandidates(doc.markdown);
		console.log(`[fixAmbiguousEitherOrCandidates] fixedCount=${ambFix.fixedCount}`);
		for (const detail of ambFix.details.slice(0, 6)) console.log("  · " + detail);
	}
	async function mainAsync() {
		const r28l = loadDoc("r28l");
		const s28l = loadDoc("s28l");
		main(r28l, s28l);
		main(s28l, r28l);
		const scaleFix = await applyDeterministicConsistencyFixes(s28l.chapters, s28l.factsModel);
		console.log(`\n[applyDeterministicConsistencyFixes(s28l)] fixedCount=${scaleFix.fixedCount}`);
		for (const detail of scaleFix.details.slice(0, 10)) console.log("  · " + detail);
		const scaleFixR = await applyDeterministicConsistencyFixes(r28l.chapters, r28l.factsModel);
		console.log(`[applyDeterministicConsistencyFixes(r28l)] fixedCount=${scaleFixR.fixedCount}`);
		for (const detail of scaleFixR.details.slice(0, 10)) console.log("  · " + detail);
	}
	await mainAsync();
}));
//#endregion
export default require_c5_p4_repair_probe();
export {};
