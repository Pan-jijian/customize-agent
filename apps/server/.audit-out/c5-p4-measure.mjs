import { Y as __commonJSMin } from "./outline-CDnkJb_C.js";
import { A as parameterConceptConflictIssues, D as buildProfessionalDepthClassifier, M as init_factReconciliation, O as init_professionalDepthClassifier, a as professionalScoreIssues, c as init_detectors, d as resourceConsistencyIssues, f as selfUnderminingCandidateIssues, i as markdownTableQualityIssues, j as factReconciliationIssues, k as init_parameterConceptConflicts, l as laborPeakConflictIssues, m as waterLaborPeakAssociationIssues, n as formalPlaceholderIssues, o as ambiguousEitherOrIssues, p as specLocationMismatchIssues, r as init_qualityValidation, s as crossSectionNumericConflictIssues, t as crossChapterConsistencyIssues, u as nodeScheduleConsistencyIssues } from "./qualityValidation-2vjqUt7B.js";
import { readFileSync, writeFileSync } from "node:fs";
//#region .dbg/c5-p4-measure.ts
/**
* C5-5 P4 收敛核对测量脚本（r28l/s28l 离线复算）：
* ① 生成时快照（validationIssues）中 P4 口径读数（对账冲突/绑定冲突/合规项）；
* ② 当前代码复算（可离线确定性部分）：跨章一致性/跨节数值/节点工期/规格错位/两可表述/
*    参数多口径/材料数量口径/自伤候选/表格占位符/事实对账（权威可得的规则）；
* ③ 专业评分六维复算（professionalScoreIssues + professionalDepthClassifier）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c5-p4-measure.config.mjs
*   node apps/server/.audit-out/c5-p4-measure.mjs
*/
var require_c5_p4_measure = /* @__PURE__ */ __commonJSMin((async () => {
	init_qualityValidation();
	init_detectors();
	init_parameterConceptConflicts();
	init_factReconciliation();
	init_professionalDepthClassifier();
	const DOCS = [{
		name: "r28l 丰乐",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884268681-31f4980c.json"
	}, {
		name: "s28l 舒城",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884273697-ea5fbe91.json"
	}];
	const REGULATION_GAP_RE = /编制依据/u;
	const BINDING_RE = /规格-数值绑定|名称-数值绑定|合计值/u;
	function loadDoc(entry) {
		const wrapper = JSON.parse(readFileSync(entry.file, "utf8"));
		const layer = wrapper.draft ?? wrapper;
		const reviewMetadata = layer.reviewMetadata ?? {};
		return {
			name: entry.name,
			markdown: String(layer.markdown ?? ""),
			chapters: Array.isArray(layer.chapters) ? layer.chapters : [],
			factsModel: layer.factsModel ?? {},
			snapshot: Array.isArray(layer.validationIssues) ? layer.validationIssues : [],
			report: reviewMetadata.qualityReport ?? {},
			warningIssues: Array.isArray(wrapper.warningIssues) ? wrapper.warningIssues : []
		};
	}
	function cut(text, max = 150) {
		const flat = text.replace(/\s+/gu, " ").trim();
		return flat.length > max ? `${flat.slice(0, max)}…` : flat;
	}
	async function measureDoc(doc) {
		const evidence = {};
		console.log(`\n══════════════ ${doc.name} ══════════════`);
		console.log(`markdown ${doc.markdown.length} 字符 / ${doc.chapters.length} 章`);
		console.log("\n① 生成时快照（qualityReport 维度 + validationIssues）");
		const dimensions = doc.report.dimensions ?? [];
		const dimSnapshot = {};
		for (const key of [
			"factIntegrity",
			"compliance",
			"depth"
		]) {
			const dim = dimensions.find((item) => item.key === key);
			if (dim) {
				console.log(`   ${key}: ${dim.score}（${cut(String(dim.detail ?? ""), 120)}）`);
				dimSnapshot[key] = {
					score: dim.score,
					detail: String(dim.detail ?? "")
				};
			}
		}
		const snapshotFactNoReg = doc.snapshot.filter((issue) => issue.level === "error" && issue.category === "fact_consistency").filter((issue) => !REGULATION_GAP_RE.test(issue.message));
		const snapshotBinding = snapshotFactNoReg.filter((issue) => BINDING_RE.test(issue.message));
		console.log(`   对账冲突（fact_consistency error，排除编制依据）: ${snapshotFactNoReg.length} 条（其中绑定类 ${snapshotBinding.length} 条）`);
		const snapshotFaceErrors = doc.snapshot.filter((issue) => issue.level === "error" && [
			"style",
			"format",
			"structure",
			"table"
		].includes(String(issue.category)));
		console.log(`   文风/格式/结构/表 error: ${snapshotFaceErrors.length} 条`);
		evidence.snapshot = {
			dimensions: dimSnapshot,
			factNoReg: snapshotFactNoReg,
			binding: snapshotBinding,
			faceErrors: snapshotFaceErrors
		};
		console.log("\n② 当前代码复算（确定性 ± 本地语义）");
		const factsModel = doc.factsModel;
		const recomputed = [];
		const step = async (label, run) => {
			try {
				recomputed.push({
					label,
					issues: await run()
				});
			} catch (error) {
				console.log(`   ${label}: 复算异常 —— ${cut(error instanceof Error ? error.message : String(error), 160)}`);
			}
		};
		const specAuthorityMap = doc.factsModel.specAuthorityMap;
		await step("跨章一致性（规模/工期/成本/台数互斥）", () => crossChapterConsistencyIssues(doc.markdown, factsModel));
		await step("跨节数值口径互斥", () => crossSectionNumericConflictIssues(doc.markdown));
		await step("节点工期口径互查", () => nodeScheduleConsistencyIssues(doc.markdown));
		await step("规格错位（清单权威映射）", () => specLocationMismatchIssues(doc.markdown, specAuthorityMap));
		await step("关键设计决策两可表述", () => ambiguousEitherOrIssues(doc.markdown));
		await step("参数概念多口径", () => parameterConceptConflictIssues(doc.markdown));
		await step("材料/设备数量口径互斥（资源一致性）", () => resourceConsistencyIssues(doc.markdown));
		await step("劳动力峰值口径", () => laborPeakConflictIssues(doc.markdown));
		await step("用水量-劳动力峰值关联", () => waterLaborPeakAssociationIssues(doc.markdown));
		await step("事实对账 D4（权威可得规则）", () => factReconciliationIssues({
			markdown: doc.markdown,
			factsModel
		}));
		await step("表格占位符（阻断层）", () => markdownTableQualityIssues(doc.markdown));
		await step("占位式表达（警告层）", () => formalPlaceholderIssues(doc.markdown));
		await step("自伤表述候选", () => selfUnderminingCandidateIssues(doc.markdown));
		for (const { label, issues } of recomputed) {
			const errors = issues.filter((issue) => issue.level === "error");
			console.log(`   ${label}: ${issues.length} 条（error ${errors.length}）`);
			for (const issue of issues.slice(0, 8)) console.log(`      [${issue.level}] ${cut(issue.message)}`);
			if (issues.length > 8) console.log(`      …（其余 ${issues.length - 8} 条略）`);
		}
		evidence.recomputed = Object.fromEntries(recomputed.map(({ label, issues }) => [label, issues]));
		console.log("\n③ 专业评分复算（professionalScoreIssues，<8/12 报出）");
		try {
			const classifier = await buildProfessionalDepthClassifier();
			const analyses = /* @__PURE__ */ new Map();
			for (const chapter of doc.chapters) {
				const analysis = await classifier.analyze(chapter.content);
				if (analysis) analyses.set(chapter.title, analysis);
			}
			const scoreIssues = professionalScoreIssues(doc.chapters, analyses);
			for (const issue of scoreIssues) console.log(`   [${issue.level}] ${cut(issue.message, 180)}`);
			if (scoreIssues.length === 0) console.log("   （零报出：全部章 ≥8/12）");
			const sixDim = {};
			for (const chapter of doc.chapters) {
				const analysis = analyses.get(chapter.title);
				if (!analysis) continue;
				const covered = Object.entries(analysis.dimensions).filter(([, value]) => value).map(([key]) => key);
				console.log(`   ${chapter.title}: 六维覆盖 ${covered.length}/6 [${covered.join("、")}] concrete=${analysis.concrete} closedLoop=${analysis.closedLoop}`);
				sixDim[chapter.title] = {
					covered,
					dimensions: analysis.dimensions,
					contentNeeds: analysis.contentNeeds,
					concrete: analysis.concrete,
					closedLoop: analysis.closedLoop
				};
			}
			evidence.professional = {
				scoreIssues,
				sixDim
			};
		} catch (error) {
			console.log(`   专业评分复算异常 —— ${cut(error instanceof Error ? error.message : String(error), 200)}`);
		}
		return {
			name: doc.name,
			evidence
		};
	}
	async function main() {
		const out = {};
		for (const entry of DOCS) {
			const result = await measureDoc(loadDoc(entry));
			out[result.name] = result.evidence;
		}
		const outPath = "/Users/pan/Desktop/codeing/customize-agent/apps/server/.audit-out/c5-p4-evidence.json";
		writeFileSync(outPath, JSON.stringify(out, null, 2));
		console.log(`\n证据已落盘：${outPath}`);
	}
	await main();
}));
//#endregion
export default require_c5_p4_measure();
export {};
