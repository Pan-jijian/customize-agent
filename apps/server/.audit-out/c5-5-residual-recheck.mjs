import { H as __commonJSMin } from "./templateStore-CwGo8aJx.js";
import { S as init_detectors, _ as parameterConceptConflictIssues, b as SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE, g as init_parameterConceptConflicts, h as conceptConflictGroups, n as init_fixers, t as fixSelfUnderminingCandidates, v as init_qualityValidation, x as ambiguousEitherOrIssues, y as scanTablePlaceholderCells } from "./fixers-57amMb7K.js";
import { readFileSync } from "node:fs";
//#region .dbg/c5-5-residual-recheck.ts
/**
* C5-5 落码后残留复算探针（c5-5d 验证）：
* ① 台数冲突定位新手段（「X」配置台数）对 4 条消息的命中测试；
* ② 保护层参数多口径豁免（构件细分后缀判据）——s28l 应消失、真冲突保留；
* ③ 两可连接工艺豁免——s28l「基础预埋件焊接或螺栓连接」应消失；
* ④ 占位符豁免列扩围——s28l 附表一 24 处应清零、其他占位形态保留；
* ⑤ 自伤：豁免动作表（补拍句）与修复器主语泛化（本工程未采用新技术）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c5-5-recheck.config.mjs
*   node apps/server/.audit-out/c5-5-residual-recheck.mjs
*/
var require_c5_5_residual_recheck = /* @__PURE__ */ __commonJSMin((async () => {
	init_fixers();
	init_detectors();
	init_qualityValidation();
	init_parameterConceptConflicts();
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
	/** 复制自落码后的 globalQualityGates 定位链（含 C5 新手段） */
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
			const equipmentCountHit = issue.match(/[“「]([^”」]{2,24})[”」]\s*配置台数/u)?.[1];
			if (equipmentCountHit && normalizedChapterContent.includes(equipmentCountHit.replace(/\s+/gu, ""))) {
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
	const TABLE_COUNT_ISSUES = [
		"跨章一致性冲突：正文「高清网络球形摄像机」配置台数出现互相矛盾的取值 8、33；全项目「高清网络球形摄像机」配置总量必须全文唯一。",
		"跨章一致性冲突：正文「道闸机」配置台数出现互相矛盾的取值 6、1；全项目「道闸机」配置总量必须全文唯一。",
		"跨章一致性冲突：正文「数字硬盘录像机」配置台数出现互相矛盾的取值 33、8；全项目「数字硬盘录像机」配置总量必须全文唯一。",
		"跨章一致性冲突：正文「违停监控球机」配置台数出现互相矛盾的取值 10、5；全项目「违停监控球机」配置总量必须全文唯一。"
	];
	const SELF_UNDERMINING_SENTENCES = [
		"质检员每周对影像资料完整性进行核查，发现缺失或影像无法辨识的，责成施工员在24小时内补拍并重新上传",
		"本工程部分专项设计文件尚未完成，将可能导致后续施工组织调整",
		"BIM技术应用尚不完善，专业协同存在较大风险"
	];
	async function main() {
		const r28l = loadDoc("r28l");
		const s28l = loadDoc("s28l");
		console.log(`chapters: r28l=${r28l.chapters.length} s28l=${s28l.chapters.length}\n`);
		console.log("══════ ① 台数冲突定位（s28l 4 条） ══════");
		for (const issue of TABLE_COUNT_ISSUES) {
			const hits = locateChapters(issue, s28l.chapters);
			console.log(`[定位] ${issue.slice(9, 40)}…\n  → 命中 ${hits.length} 章: ${hits.length > 0 ? hits.join(" / ") : "【零命中】"}`);
		}
		console.log("\n══════ ② 参数多口径（s28l 全量复算） ══════");
		for (const item of [
			{
				label: "分构件保护层（应 0 组）",
				text: "基础底板钢筋保护层厚度40mm，柱梁钢筋保护层厚度25mm，板钢筋保护层厚度15mm。垫层厚度100mm，底板厚度300mm。"
			},
			{
				label: "同概念异值真冲突（应 ≥1 组）",
				text: "垫层厚度100mm，另一处垫层厚度150mm。底板厚度300mm，顶板厚度120mm，柱截面500mm。"
			},
			{
				label: "同对象蕴含关系（应 ≥1 组）",
				text: "管道闭水试验按每100m一段，闭水试验按每200m一段。垫层厚度100mm，底板厚度300mm。"
			}
		]) {
			const scan = await conceptConflictGroups(item.text);
			console.log(`[mini] ${item.label} → groups=${scan.groups.length}${scan.groups.length ? " :: " + scan.groups.map((g) => `${g.concept}(${g.values.map((v) => v.raw).join("/")})`).join(" | ") : ""}`);
		}
		for (const doc of [s28l, r28l]) {
			const scan = await conceptConflictGroups(doc.markdown);
			console.log(`[conceptConflictGroups(${doc.name})] rawGroups=${scan.groups.length} degraded=${scan.degraded ? "YES" : "no"}`);
			for (const group of scan.groups) console.log(`  · group「${group.concept}」值: ${group.values.map((v) => v.raw).join(" / ")}`);
			const issues = await parameterConceptConflictIssues(doc.markdown);
			console.log(`[${doc.name}] ${issues.length} 条：`);
			for (const issue of issues) console.log(`  · ${issue.message.slice(0, 190)}`);
		}
		console.log("\n══════ ③ 两可表述（s28l / r28l 全量复算） ══════");
		for (const doc of [s28l, r28l]) {
			const issues = ambiguousEitherOrIssues(doc.markdown);
			console.log(`[${doc.name}] ${issues.length} 条${issues.length > 0 ? "：" + issues.map((i) => i.message.slice(0, 120)).join(" | ") : ""}`);
		}
		console.log("\n══════ ④ 表格占位符（s28l 全量复算） ══════");
		for (const doc of [s28l, r28l]) {
			const hits = scanTablePlaceholderCells(doc.markdown);
			console.log(`[${doc.name}] 非豁免命中 ${hits.length} 处`);
			for (const hit of hits.slice(0, 12)) console.log(`  · 表头[${hit.header.slice(0, 6).join("/")}…] 行首「${hit.rowFirstCell}」列${hit.cellIndex} 格「${hit.cell}」`);
		}
		console.log("\n══════ ⑤ 自伤豁免/修复（r28l 实句） ══════");
		for (const sentence of SELF_UNDERMINING_SENTENCES) console.log(`[豁免正则] ${SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test(sentence) ? "豁免 ✓" : "不豁免"} :: ${sentence.slice(0, 48)}…`);
		for (const doc of [r28l, s28l]) {
			const fix = fixSelfUnderminingCandidates(doc.markdown);
			console.log(`[fixSelfUndermining(${doc.name})] fixedCount=${fix.fixedCount} ${fix.details.join(" | ")}`);
			if (fix.fixedCount > 0) for (const needle of [
				"未采用",
				"本工程工艺选择",
				"本项目工艺选择"
			]) {
				const at = fix.markdown.indexOf(needle);
				if (at !== -1) console.log(`  · 修复后「${needle}」上下文: ${fix.markdown.slice(Math.max(0, at - 40), at + 90).replace(/\n/gu, "⏎")}`);
			}
		}
	}
	await main();
}));
//#endregion
export default require_c5_5_residual_recheck();
export {};
