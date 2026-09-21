import { B as __commonJSMin, R as cleanAppendixInternalPhrases, z as init_composeAppendices } from "./outline-BsozXaRa.js";
import { _ as arbitrateNumericConflicts, b as init_factReconciliation, i as selfUnderminingCandidateIssues, n as init_detectors, r as scanSpecLocationMismatchHits, t as SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE, v as init_numericConflictArbiter, y as factReconciliationIssues } from "./detectors-ResfT8pB.js";
import { readFileSync } from "node:fs";
//#region .dbg/c5-5e-residual.ts
/**
* C5-5e 残留处置证据探针（P4 三项收尾）：
* ① 附表区话术清洗器（C2-5 cleanAppendixInternalPhrases）对 s28l 实测：
*    37112/28792（附表一「相关条目工程量合计约」形态）清洗前后 factReconciliationIssues 对比——
*    验证「D4 近似数值 error 由 C2-5 清洗器确定性消费」闭环 + 幂等复洗；
* ② A2 规格错位裁决实测（坐椅/坐凳 1000→700）：scanSpecLocationMismatchHits 的 replacement
*    与 arbitrateNumericConflicts 的确定性替换输出（giveUpOnFailure 复检语义）；
* ③ 自伤句豁免判定：现豁免正则对目标句/护栏样本 + 候选新分支（⑱ 未…的＋由/经/责成＋主体＋
*    组织类＋动作＋直至/确保闭环）预演——改源码前先验证命中/护栏双面；
*    当前代码 selfUnderminingCandidateIssues(s28l) 候选列表（目标句应在内）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c5-5e-residual.config.mjs
*   node apps/server/.audit-out/c5-5e-residual.mjs
*/
var require_c5_5e_residual = /* @__PURE__ */ __commonJSMin((async () => {
	init_composeAppendices();
	init_factReconciliation();
	init_detectors();
	init_numericConflictArbiter();
	const S28L = "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884273697-ea5fbe91.json";
	function load(path) {
		const wrapper = JSON.parse(readFileSync(path, "utf8"));
		const layer = wrapper.draft ?? wrapper;
		return {
			markdown: String(layer.markdown ?? ""),
			factsModel: layer.factsModel ?? {}
		};
	}
	function cut(text, max = 150) {
		const flat = text.replace(/\s+/gu, " ").trim();
		return flat.length > max ? `${flat.slice(0, max)}…` : flat;
	}
	function countPhrase(markdown) {
		return [...markdown.matchAll(/相关条目工程量合计约/gu)].length;
	}
	const TARGET_SENTENCE = "未完成清运的责任段由施工员组织加班清运，直至现场无遗留堆体";
	const CANDIDATE_FULL = new RegExp(`(?:${SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.source})|(?:${/未[^。；;]{0,20}?(?:的|区段|部位|工序|作业面|任务|班组|段落)[^。；;]{0,48}?(?:由|经|责成|交|指定)[^。；;]{0,16}?(?:组织|安排|负责|落实|实施|调配|增派|督办)[^。；;]{0,40}?(?:清运|清理|处置|处理|整改|完善|补充|调整|加固|返工|修复|恢复|回填|浇筑|作业|施工|外运|归集)[^。；;]{0,40}?(?:直至|确保|保证|实现|不留|无遗留|达标|闭合|清零|完成|销项)/u.source})`, "u");
	async function main() {
		const doc = load(S28L);
		console.log(`s28l markdown ${doc.markdown.length} 字符`);
		console.log("\n══════ ① 附表区话术清洗（C2-5）→ D4 近似数值闭环 ══════");
		const before = countPhrase(doc.markdown);
		const cleaned = cleanAppendixInternalPhrases(doc.markdown);
		const afterCount = countPhrase(cleaned);
		console.log(`「相关条目工程量合计约」出现次数: 清洗前 ${before} → 清洗后 ${afterCount}（位移差 ${doc.markdown.length - cleaned.length} 字符）`);
		const issuesBefore = factReconciliationIssues({
			markdown: doc.markdown,
			factsModel: doc.factsModel
		});
		const issuesAfter = factReconciliationIssues({
			markdown: cleaned,
			factsModel: doc.factsModel
		});
		const approxBefore = issuesBefore.filter((issue) => issue.message.includes("近似数值"));
		const approxAfter = issuesAfter.filter((issue) => issue.message.includes("近似数值"));
		console.log(`D4 近似数值 error: 清洗前 ${approxBefore.length} 条 → 清洗后 ${approxAfter.length} 条`);
		for (const issue of approxBefore) console.log(`  [前] ${cut(issue.message, 130)}`);
		for (const issue of approxAfter) console.log(`  [后] ${cut(issue.message, 130)}`);
		const twice = cleanAppendixInternalPhrases(cleaned);
		console.log(`幂等复洗：二次清洗再位移 ${cleaned.length - twice.length} 字符（期望 0）`);
		console.log("\n══════ ② A2 规格错位裁决（s28l 坐椅/坐凳） ══════");
		const specAuthorityMap = doc.factsModel.specAuthorityMap;
		const hits = scanSpecLocationMismatchHits(doc.markdown, specAuthorityMap);
		console.log(`scanSpecLocationMismatchHits: ${hits.length} 条`);
		for (const hit of hits) {
			console.log(`  · [${hit.location}] ${cut(hit.issue.message, 120)}`);
			console.log(`    replacement: ${hit.replacement ? `${hit.replacement.replacement} @${hit.replacement.start}（${hit.replacement.detail}）` : "（无——多义权威留 LLM）"}`);
		}
		const arbiter = await arbitrateNumericConflicts(doc.markdown, { specAuthorityMap });
		console.log(`arbiter: 替换 ${arbiter.replacements.length} 处 / 误报 ${arbiter.falsePositiveGroups.length} 组 / 无锚 ${arbiter.noAnchorGroups.length} 组`);
		for (const item of arbiter.replacements) console.log(`  · 替换@${item.start}: ${item.detail}`);
		for (const group of arbiter.noAnchorGroups) console.log(`  · 无锚: ${group}`);
		console.log("\n══════ ③ 自伤句豁免判定 ══════");
		const samples = [
			{
				label: "⑤号目标句（s28l 清运责任段）",
				text: TARGET_SENTENCE,
				expect: "豁免"
			},
			{
				label: "真伤1（尚未完成+将导致）",
				text: "本工程部分专项设计文件尚未完成，将可能导致后续施工组织调整",
				expect: "召回"
			},
			{
				label: "真伤2（BIM 不完善）",
				text: "BIM技术应用尚不完善，专业协同存在较大风险",
				expect: "召回"
			},
			{
				label: "真伤3（R9 分包否定式）",
				text: "本工程不进行分包",
				expect: "召回"
			},
			{
				label: "护栏4（未完成+由+负责完善·无闭环词）",
				text: "尚未完成的施工组织设计由项目部负责完善",
				expect: "召回"
			},
			{
				label: "护栏5（未完成+组织论证+调整方案）",
				text: "尚未完成的部分组织论证后将调整方案",
				expect: "召回"
			},
			{
				label: "历史豁免1（影像补拍·C5扩围）",
				text: "质检员每周对影像资料完整性进行核查，发现缺失或影像无法辨识的，责成施工员在24小时内补拍并重新上传",
				expect: "豁免"
			}
		];
		for (const sample of samples) {
			const current = SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE.test(sample.text);
			const verdict = CANDIDATE_FULL.test(sample.text) ? "豁免" : "召回";
			console.log(`  [${sample.expect === verdict ? "PASS" : "FAIL"}] 期望${sample.expect} 现${current ? "豁免" : "召回"} 候选${verdict} :: ${sample.label}`);
		}
		console.log("  ── 当前代码 selfUnderminingCandidateIssues(s28l) 候选（目标句应在内）──");
		const candidates = await selfUnderminingCandidateIssues(doc.markdown);
		for (const issue of candidates) console.log(`  [${issue.level}] ${cut(issue.message, 170)}`);
		const targetIn = candidates.some((issue) => issue.message.includes(TARGET_SENTENCE));
		console.log(`  目标句在当前候选中: ${targetIn ? "YES（检测侧残余确认）" : "NO"}`);
	}
	await main();
}));
//#endregion
export default require_c5_5e_residual();
export {};
