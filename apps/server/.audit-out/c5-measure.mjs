import { H as __commonJSMin } from "./templateStore-CwGo8aJx.js";
import { C as ambiguousEitherOrIssues, S as SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE, _ as init_basisRegulationsCross, b as init_qualityValidation, g as basisRegulationsCrossIssues, h as auditBasisRegulationsCross, n as init_fixers, t as fixSelfUnderminingCandidates, v as conceptConflictGroups, w as init_detectors, x as scanTablePlaceholderCells, y as init_parameterConceptConflicts } from "./fixers-B0rWLI5W.js";
import { readFileSync } from "node:fs";
//#region .dbg/c5-measure.ts
/**
* C5 一致性类归零验证套件（c5-7）：
* A. P6 编制依据↔正文双向对账——r28l/s28l 存档基线复算 + mini 正/反样本
*    （双向缺口/声明未用/年号缺省同族容忍/无编制依据区段静默）；
* B. P4 冲突收敛五环节——①台数死链补链（4 条消息定位全命中 + 指令特化落码存在性 + 分项
*    保守护栏）；②占位符豁免列（s28l 24 处归零 + mini 正/反）；③参数构件细分后缀豁免
*    （复算 0 组 + mini 正/反）；④两可连接工艺豁免（复算 0 条 + mini 正/反 + 右组尾缀容忍）；
*    ⑤自伤豁免+修复（r28l「本工程」主语泛化 1 处、s28l 零残余）；
* C. 通用性抽查——合成设备名定位（防项目专名依赖）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c5-measure.config.mjs
*   && node apps/server/.audit-out/c5-measure.mjs
* 失败即 exit 1（防复发：任何断言回退视为 C5 封版失败）。
*/
var require_c5_measure = /* @__PURE__ */ __commonJSMin((async () => {
	init_fixers();
	init_detectors();
	init_qualityValidation();
	init_parameterConceptConflicts();
	init_basisRegulationsCross();
	let passCount = 0;
	const failures = [];
	function check(label, ok, detail = "") {
		if (ok) {
			passCount += 1;
			console.log(`  ✓ ${label}${detail ? ` :: ${detail}` : ""}`);
		} else {
			failures.push(label);
			console.error(`  ✗ ${label}${detail ? ` :: ${detail}` : ""}`);
		}
	}
	const ROOT = "/Users/pan/Desktop/codeing/customize-agent";
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
			chapters: Array.isArray(layer.chapters) ? layer.chapters : []
		};
	}
	/** 复制自落码后的 globalQualityGates 定位链（含 C5 手段⑦「X」配置台数），行为复算用 */
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
	const P6_MINI = [
		{
			label: "双向对账（引用未声明 1：GB 50205 未列入；法类不报）",
			expectedIssues: 1,
			text: [
				"## 第1章 编制依据",
				"- 《混凝土结构工程施工质量验收规范》（GB 50204-2015）",
				"- 《建筑地基基础工程施工质量验收标准》（GB 50202-2018）",
				"- 《中华人民共和国招标投标法》",
				"",
				"## 第2章 施工方案",
				"钢筋工程验收执行《混凝土结构工程施工质量验收规范》（GB 50204-2015）。",
				"桩基验收执行《建筑地基基础工程施工质量验收标准》（GB 50202-2018）。",
				"钢结构验收执行《钢结构工程施工质量验收标准》（GB 50205-2020）。"
			].join("\n")
		},
		{
			label: "声明未用（1：砌体规范正文零引用）",
			expectedIssues: 1,
			text: [
				"## 第1章 编制依据",
				"- 《砌体结构工程施工质量验收规范》（GB 50203-2011）",
				"- 《混凝土结构工程施工质量验收规范》（GB 50204-2015）",
				"",
				"## 第2章 施工方案",
				"钢筋工程验收执行《混凝土结构工程施工质量验收规范》（GB 50204-2015）。"
			].join("\n")
		},
		{
			label: "年号缺省同族容忍（GB 50205 ↔ GB 50205-2020 → 双向零缺口）",
			expectedIssues: 0,
			text: [
				"## 第1章 编制依据",
				"- 《钢结构工程施工质量验收标准》（GB 50205）",
				"",
				"## 第2章 施工方案",
				"钢结构验收执行《钢结构工程施工质量验收标准》（GB 50205-2020）。"
			].join("\n")
		},
		{
			label: "无编制依据区段静默（模板差异不误伤）",
			expectedIssues: 0,
			text: ["## 第2章 施工方案", "钢筋验收执行《混凝土结构工程施工质量验收规范》（GB 50204-2015）。"].join("\n")
		}
	];
	async function main() {
		const r28l = loadDoc("r28l");
		const s28l = loadDoc("s28l");
		console.log(`chapters: r28l=${r28l.chapters.length} s28l=${s28l.chapters.length}`);
		console.log("\n═══ A. P6 编制依据↔正文双向对账 ═══");
		const audits = /* @__PURE__ */ new Map();
		for (const doc of [r28l, s28l]) {
			const audit = auditBasisRegulationsCross(doc.markdown);
			audits.set(doc.name, audit);
			const issues = basisRegulationsCrossIssues(doc.markdown);
			console.log(`[${doc.name}] declared=${audit.stats.declaredCodes}C+${audit.stats.declaredNames}N used=${audit.stats.usedCodes}C+${audit.stats.usedNames}N → 声明未用=${audit.declaredNotUsed.length} 引用未声明=${audit.usedNotDeclared.length} issues=${issues.length}`);
			for (const gap of audit.usedNotDeclared.slice(0, 8)) console.log(`    · 引用未声明[${gap.kind}] ${gap.value}${gap.code ? ` <${gap.code}>` : ""}`);
			for (const gap of audit.declaredNotUsed.slice(0, 8)) console.log(`    · 声明未用[${gap.kind}] ${gap.value}${gap.code ? ` <${gap.code}>` : ""}`);
		}
		const rAudit = audits.get("r28l");
		const sAudit = audits.get("s28l");
		check("P6 r28l 基线复算（声明未用 8 / 引用未声明 7）", rAudit.declaredNotUsed.length === 8 && rAudit.usedNotDeclared.length === 7, `declared=${rAudit.declaredNotUsed.length} used=${rAudit.usedNotDeclared.length}`);
		check("P6 s28l 基线复算（声明未用 4 / 引用未声明 15）", sAudit.declaredNotUsed.length === 4 && sAudit.usedNotDeclared.length === 15, `declared=${sAudit.declaredNotUsed.length} used=${sAudit.usedNotDeclared.length}`);
		for (const item of P6_MINI) {
			const issues = basisRegulationsCrossIssues(item.text);
			check(`P6 mini ${item.label}`, issues.length === item.expectedIssues, `${issues.length} 条（期望 ${item.expectedIssues}）`);
		}
		console.log("\n═══ B. P4 冲突收敛五环节 ═══");
		console.log("── ① 台数冲突定位（s28l 4 条消息） ──");
		for (const issue of TABLE_COUNT_ISSUES) {
			const hits = locateChapters(issue, s28l.chapters);
			check(`台数定位「${issue.slice(9, 25)}…」`, hits.length > 0, `命中 ${hits.length} 章: ${hits.join(" / ") || "【零命中】"}`);
		}
		check("台数指令特化判据命中全部消息", TABLE_COUNT_ISSUES.every((issue) => /配置台数出现互相矛盾的取值/u.test(issue)));
		const gatesSource = readFileSync(`${ROOT}/apps/server/src/services/document-workflow/globalQualityGates.ts`, "utf8");
		check("落码存在性：定位手段⑦（配置台数直角引号正则）", gatesSource.includes("[“「]([^”」]{2,24})[”」]\\s*配置台数") || gatesSource.includes("配置台数") && gatesSource.includes("equipmentCountHit"));
		check("落码存在性：台数指令特化（首现口径锁定+分项保守护栏）", gatesSource.includes("保留冲突描述中列出的第一个取值（全文首现口径）作为该设备的全项目总量") && gatesSource.includes("分项序列或清单独立条目台数可保留"));
		console.log("── ② 占位符（s28l 24 处归零） ──");
		const sHits = scanTablePlaceholderCells(s28l.markdown);
		check("占位符 s28l 归零（豁免列与生成端对齐）", sHits.length === 0, `${sHits.length} 处${sHits.length ? "：" + sHits.slice(0, 3).map((hit) => `「${hit.cell}」@${hit.header.join("/")}`).join(" | ") : ""}`);
		const rHits = scanTablePlaceholderCells(r28l.markdown);
		check("占位符 r28l 归零", rHits.length === 0, `${rHits.length} 处`);
		check("占位符 mini 正（投产信息列全「—」→ 0 处）", scanTablePlaceholderCells([
			"| 序号 | 设备名称 | 型号规格 | 数量 | 国别产地 | 制造年份 | 额定功率（kW） | 生产能力 | 用于施工部位 | 备注 |",
			"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
			"| 1 | 挖掘机 | 0.6~1.0m³ | 4-6 | — | — | — | — | — | 人机配合开挖 |"
		].join("\n")).length === 0);
		check("占位符 mini 反（非豁免列「待定」→ 照报）", scanTablePlaceholderCells([
			"| 序号 | 设备名称 | 型号规格 | 数量 | 国别产地 | 备注 |",
			"| --- | --- | --- | --- | --- | --- |",
			"| 1 | 挖掘机 | — | 5台 | 国产 | 待定 |"
		].join("\n")).some((hit) => hit.cell === "待定"));
		console.log("── ③ 参数多口径（s28l/r28l 复算） ──");
		for (const doc of [s28l, r28l]) {
			const scan = await conceptConflictGroups(doc.markdown);
			check(`参数多口径 ${doc.name} 归零`, scan.groups.length === 0, `groups=${scan.groups.length} degraded=${scan.degraded ? "YES" : "no"}`);
		}
		const suffixPositive = await conceptConflictGroups("基础底板钢筋保护层厚度40mm，柱梁钢筋保护层厚度25mm，板钢筋保护层厚度15mm。垫层厚度100mm，底板厚度300mm。");
		check("参数 mini 正（分构件保护层 → 0 组）", suffixPositive.groups.length === 0, `groups=${suffixPositive.groups.length}`);
		const suffixNegative = await conceptConflictGroups("垫层厚度100mm，另一处垫层厚度150mm。底板厚度300mm，顶板厚度120mm，柱截面500mm。");
		check("参数 mini 反（同概念异值 → ≥1 组照报）", suffixNegative.groups.length >= 1, `groups=${suffixNegative.groups.length}`);
		const implyNegative = await conceptConflictGroups("管道闭水试验按每100m一段，闭水试验按每200m一段。垫层厚度100mm，底板厚度300mm。");
		check("参数 mini 反（同对象蕴含 → ≥1 组照报）", implyNegative.groups.length >= 1, `groups=${implyNegative.groups.length}`);
		console.log("── ④ 两可表述（s28l/r28l 复算） ──");
		for (const doc of [s28l, r28l]) {
			const issues = ambiguousEitherOrIssues(doc.markdown);
			check(`两可 ${doc.name} 归零`, issues.length === 0, `${issues.length} 条${issues.length ? "：" + issues.map((issue) => issue.message.slice(0, 90)).join(" | ") : ""}`);
		}
		check("两可 mini 正（基础预埋件焊接或螺栓连接 → 豁免）", ambiguousEitherOrIssues("落地安装的AL1、AL3箱体，先施工C20混凝土基础，基础顶面标高按设计确定，箱体与基础预埋件焊接或螺栓连接，柜体垂直度偏差不大于1.5mm/m。").length === 0);
		check("两可 mini 正（右组尾缀容忍：焊接或铆接固定 → 豁免）", ambiguousEitherOrIssues("落地安装的AL1、AL3箱体，先施工C20混凝土基础，基础顶面标高按设计确定，箱体与基础预埋件焊接或铆接固定，柜体垂直度偏差不大于1.5mm/m。").length === 0);
		check("两可 mini 反（桩基或独立基础 → 照报）", ambiguousEitherOrIssues("基础采用桩基或独立基础，按图纸施工。").length === 1);
		check("两可 mini 反（放坡或钢板桩 → 照报）", ambiguousEitherOrIssues("沟槽开挖采用放坡或钢板桩支护。").length === 1);
		console.log("── ⑤ 自伤（豁免 + 修复） ──");
		check("自伤豁免正样本（影像补拍三段链）", SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test("质检员每周对影像资料完整性进行核查，发现缺失或影像无法辨识的，责成施工员在24小时内补拍并重新上传。"));
		check("自伤豁免反样本（真伤现状断言不豁免）", !SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test("本工程部分专项设计文件尚未完成，待后续补充"));
		const fixR = fixSelfUnderminingCandidates(r28l.markdown);
		check("自伤修复 r28l（本工程主语泛化 1 处）", fixR.fixedCount === 1 && fixR.markdown.includes("本工程工艺选择以成熟可靠为原则") && !fixR.markdown.includes("以成熟可靠的常规工艺为主，未采用"), `fixedCount=${fixR.fixedCount}`);
		const fixS = fixSelfUnderminingCandidates(s28l.markdown);
		check("自伤修复 s28l 零残余", fixS.fixedCount === 0, `fixedCount=${fixS.fixedCount}`);
		console.log("\n═══ C. 通用性抽查（合成样本，防项目专名依赖） ═══");
		const syntheticChapters = [{
			id: "c1",
			title: "第十章 电气工程",
			content: "低压配电柜共12台，其中一级配电柜4台，二级配电柜8台，均落地安装。"
		}, {
			id: "c2",
			title: "第十一章 附属设施",
			content: "成品岗亭2座安装就位，岗亭基础采用C25混凝土浇筑。"
		}];
		check("台数定位通用性（合成「低压配电柜」）", locateChapters("跨章一致性冲突：正文「低压配电柜」配置台数出现互相矛盾的取值 12、8；全项目「低压配电柜」配置总量必须全文唯一。", syntheticChapters).length > 0);
		check("台数定位通用性（合成「成品岗亭」）", locateChapters("跨章一致性冲突：正文「成品岗亭」配置台数出现互相矛盾的取值 2、3；全项目「成品岗亭」配置总量必须全文唯一。", syntheticChapters).length > 0);
		check("台数定位反例（不存在的设备名 → 零命中）", locateChapters("跨章一致性冲突：正文「光伏逆变器」配置台数出现互相矛盾的取值 5、8；全项目「光伏逆变器」配置总量必须全文唯一。", syntheticChapters).length === 0);
		const suffixGeneral = await conceptConflictGroups("剪力墙钢筋保护层厚度20mm，楼板钢筋保护层厚度15mm，框架柱钢筋保护层厚度25mm。垫层厚度100mm，底板厚度300mm。");
		check("参数后缀豁免通用性（剪力墙/楼板/框架柱 → 0 组）", suffixGeneral.groups.length === 0, `groups=${suffixGeneral.groups.length}`);
		console.log(`\n═══ 汇总：${passCount} PASS / ${failures.length} FAIL ═══`);
		if (failures.length > 0) {
			for (const failure of failures) console.error(`  ✗ ${failure}`);
			process.exit(1);
		}
	}
	await main();
}));
//#endregion
export default require_c5_measure();
export {};
