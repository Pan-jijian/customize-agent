import { H as __esmMin, O as explicitLengthTargets, U as __exportAll, c as init_markdownComposer, i as init_evidence, k as init_budget, v as init_outline, x as init_llmClient, y as normalizePlannedSectionTitle } from "./templateStore-JhiKFW4a.js";
//#region apps/server/src/services/document-workflow/sectionFingerprint.ts
var init_sectionFingerprint = __esmMin((() => {
	init_outline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/sectionNamingGovernance.ts
var init_sectionNamingGovernance = __esmMin((() => {
	init_llmClient();
	init_outline();
	init_markdownComposer();
	init_sectionFingerprint();
}));
//#endregion
//#region apps/server/src/services/document-workflow/promptRuleExtraction.ts
var promptRuleExtraction_exports = /* @__PURE__ */ __exportAll({
	MAX_CHAPTER_SECTIONS: () => 12,
	buildRuntimePromptRules: () => buildRuntimePromptRules,
	detectPromptRuleConflicts: () => detectPromptRuleConflicts,
	extractAppendixTables: () => extractAppendixTables,
	extractPromptDocumentRules: () => extractPromptDocumentRules
});
function isInstructionLikeSectionTitle(title) {
	const normalized = normalizePlannedSectionTitle(title).replace(/\s+/gu, "");
	if (!normalized) return true;
	if (/^(?:目录|章节|大纲|要求|说明|注意|输出|格式|示例|例如|写法|占位|提示)$/u.test(normalized)) return true;
	return /^(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用)|^(?:如|若|如果)(?:涉及|不涉及|适用|不适用)/u.test(normalized);
}
function simpleHashText(text) {
	let hash = 2166136261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}
function extractOutlineHeadings(text) {
	const headings = [];
	const outline = /<OUTLINE>([\s\S]*?)<\/OUTLINE>/u.exec(text)?.[1] || "";
	for (const line of outline.split(/\r?\n/u)) {
		const title = line.replace(/^\s*(?:\d+[.、．]|[-*])\s*/u, "").trim();
		if (title.length >= 2 && title.length <= 80 && !isInstructionLikeSectionTitle(title)) headings.push(title);
	}
	return [...new Set(headings)];
}
function extractMinWords(text) {
	const wide = explicitLengthTargets(text);
	if (wide.targetChars && wide.targetChars > 0) return wide.targetChars;
	const match = /(?:不少于|至少|最低|必须生成不少于)\s*(\d+(?:\.\d+)?)\s*(万)?\s*字/u.exec(text);
	if (!match) return void 0;
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) return void 0;
	return Math.floor(value * (match[2] ? 1e4 : 1));
}
/**
* 4.33 招标文件附表清单提取（「除文字表述外可附下列图表，图表及格式要求附后。附表一 …」场景）：
* 触发句 + 附表编号条目双条件，避免「投标人须知前附表/评标办法前附表」误报；
* 附表四（进度网络图）/附表五（总平面图）为图类，由编制人人工补充，不参与系统生成。
*/
function extractAppendixTables(text) {
	const normalized = text.replace(/\\n/gu, "\n").replace(/\r/gu, "");
	if (!/(?:除文字表述外)?可附下列图表|图表及格式要求附后|附下列图表|附表.{0,12}附后/u.test(normalized)) return {
		titles: [],
		attachedAtEnd: false
	};
	const titles = [];
	const seenNumbers = /* @__PURE__ */ new Set();
	for (const match of normalized.matchAll(/附表\s*([一二三四五六七八九十\d]{1,3})\s*[:：]?\s*([^\n。；;：:]{2,40}(?:表|图))/gu)) {
		const number = (match[1] || "").trim();
		const name = (match[2] || "").replace(/\s+/gu, " ").replace(/([\u3400-\u9fff\u3000-\u303f\uff00-\uffef])[ \u3000]+(?=[\u3400-\u9fff\u3000-\u303f\uff00-\uffef])/gu, "$1").trim();
		if (!number || !name || name.length < 3) continue;
		if (seenNumbers.has(number)) continue;
		seenNumbers.add(number);
		titles.push(`附表${number} ${name}`);
	}
	return {
		titles,
		attachedAtEnd: titles.length >= 2
	};
}
function splitExplicitRuleList(value) {
	return value.split(/[、,，/／]/u).map((item) => item.trim().replace(/["“”'‘’《》<>]/gu, "")).filter((item) => item.length >= 2 && item.length <= 24 && !/[。；;：:]/u.test(item));
}
function extractRequiredKeywordRules(text) {
	const keywords = /* @__PURE__ */ new Set();
	for (const pattern of [/(?:关键词|核心要点|必含关键词|必须包含的关键词)[：:]\s*([^。；;\n]+)/gu, /(?:必须|应当|需要|全文必须)包含(?:以下|如下)?(?:关键词|核心词|术语)[：:]\s*([^。；;\n]+)/gu]) for (const match of text.matchAll(pattern)) for (const keyword of splitExplicitRuleList(match[1] || "")) if (!/表格|章节|小节|正文|目录|封面/u.test(keyword)) keywords.add(keyword);
	return [...keywords].slice(0, 24);
}
function extractForbiddenPatternRules(text) {
	const patterns = /* @__PURE__ */ new Set();
	for (const pattern of [/(?:禁用词|禁止词|不得使用词|禁用表达|禁止表达)[：:]\s*([^。；;\n]+)/gu, /(?:禁止|不得|严禁|杜绝)出现(?:以下|如下)?(?:词语|用词|表达|话术)[：:]\s*([^。；;\n]+)/gu]) for (const match of text.matchAll(pattern)) for (const value of splitExplicitRuleList(match[1] || "")) patterns.add(value);
	return [...patterns].slice(0, 40);
}
function extractRequiredTableTitles(text) {
	const titles = /* @__PURE__ */ new Set();
	for (const pattern of [
		/(?:必须|应当|需要|全文必须|至少)输出(?:的)?表格[：:]\s*([^。；;\n]+)/gu,
		/(?:必须|应当|需要|全文必须|至少)包含(?:的)?表格[：:]\s*([^。；;\n]+)/gu,
		/(?:表格清单|表格要求)[：:]\s*([^。；;\n]+)/gu
	]) for (const match of text.matchAll(pattern)) for (const part of (match[1] || "").split(/[、,，/／及和与]/u)) {
		const title = /([\p{Script=Han}A-Za-z0-9（）()《》<>]{2,40}表)/u.exec(part.trim())?.[1];
		if (title) titles.add(title.replace(/[<>《》]/gu, ""));
	}
	for (const match of text.matchAll(/([\p{Script=Han}A-Za-z0-9（）()]{2,40}表)(?:必须|应当|需要|不得缺失|不可缺失)/gu)) titles.add(match[1]);
	if (/项目基本信息表/u.test(text)) titles.add("项目基本信息表");
	return [...titles];
}
function sentencesMatching(text, pattern) {
	return text.split(/[。；;\n]/u).map((item) => item.trim()).filter((item) => item.length >= 4 && pattern.test(item)).slice(0, 24);
}
/** 在属性化提示词列表中搜索 matchedText，确定规则来源归属 */
function attributedMatch(attributedPrompts, matchedText, patternSource) {
	for (const p of attributedPrompts) if (p.content.includes(matchedText)) return {
		promptId: p.promptId,
		roleId: p.roleId,
		pattern: patternSource
	};
	return {
		promptId: "system:generation-control",
		roleId: "generation-control",
		pattern: patternSource
	};
}
function buildRuntimePromptRules(input) {
	const attributed = input.attributedPrompts || [];
	const normalizedText = [input.promptTexts, input.requirement || ""].filter(Boolean).join("\n\n").replace(/\\n/gu, "\n");
	const base = extractPromptDocumentRules(normalizedText);
	const requiredTables = [...new Set([...base.requiredTables, ...extractRequiredTableTitles(normalizedText)])];
	const appendixTables = extractAppendixTables(normalizedText);
	const requiredKeywords = extractRequiredKeywordRules(normalizedText);
	const forbiddenPatterns = extractForbiddenPatternRules(normalizedText);
	const exactHeadings = extractOutlineHeadings(normalizedText);
	const backendTerms = [
		"知识库",
		"提示词",
		"建议补充",
		"资料库",
		"OCR",
		"后台话术",
		"后台流程",
		"后台数据",
		"后台资料",
		"后台溯源",
		"绑定片段"
	];
	const commercialTerms = /技术标(?:正文)?(?:不得|禁止|严禁).*(?:商务|报价|单价|税率|利润|造价)/u.test(normalizedText) ? ["报价明细表"] : [];
	const forbiddenSubjects = [];
	const minWords = extractMinWords(normalizedText);
	const chapterRules = (input.template?.chapters || []).map((chapter) => ({
		chapterTitle: chapter.title,
		mustInclude: sentencesMatching(normalizedText, new RegExp(`${chapter.title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}|${chapter.title.slice(0, 6).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u")).slice(0, 8),
		mustNotInclude: sentencesMatching(normalizedText, /禁止|不得|严禁|杜绝/u).filter((item) => item.includes(chapter.title)).slice(0, 8)
	})).filter((item) => item.mustInclude.length > 0 || item.mustNotInclude.length > 0);
	const roleRules = (input.rolePrompts || []).map((prompt) => ({
		roleId: prompt.roleId,
		focusAreas: sentencesMatching(prompt.content, /重点|关注|围绕|响应|体系|措施|质量|安全|工期|资源/u).slice(0, 8),
		mustDo: sentencesMatching(prompt.content, /必须|应当|需要|确保|严格/u).slice(0, 10),
		mustNotDo: sentencesMatching(prompt.content, /禁止|不得|严禁|杜绝/u).slice(0, 10)
	})).filter((item) => item.focusAreas.length > 0 || item.mustDo.length > 0 || item.mustNotDo.length > 0);
	const executionSummary = [
		base.coverPolicy && base.coverPolicy !== "unspecified" ? `已识别封面规则：${base.coverPolicy === "required" ? "要求生成" : "禁止生成"}` : "",
		base.tocPolicy && base.tocPolicy !== "unspecified" ? `已识别目录规则：${base.tocPolicy === "required" ? "要求生成" : "禁止生成"}` : "",
		exactHeadings.length ? `已识别一级章节固定规则 ${exactHeadings.length} 条` : "",
		forbiddenSubjects.length ? `已识别禁用主体表达：${forbiddenSubjects.join("、")}` : "",
		base.forbiddenTerms.length ? `已识别禁用词 ${base.forbiddenTerms.length} 个` : "",
		requiredTables.length ? `已识别必需表格：${requiredTables.join("、")}` : "",
		appendixTables.titles.length ? `已识别招标附表清单（文末附列）：${appendixTables.titles.join("、")}` : "",
		requiredKeywords.length ? `已识别必含关键词：${requiredKeywords.join("、")}` : "",
		forbiddenPatterns.length ? `已识别禁止出现内容：${forbiddenPatterns.join("、")}` : "",
		minWords ? `已识别目标字数要求：${minWords} 字` : "",
		roleRules.length ? `已抽取角色执行规则 ${roleRules.length} 组` : ""
	].filter(Boolean);
	const extractionTrace = [];
	const ruleSources = {};
	const addTrace = (key, rule, matchedText, pattern) => {
		const source = attributedMatch(attributed, matchedText, pattern);
		if (!ruleSources[key]) ruleSources[key] = [];
		if (ruleSources[key].length < 24) ruleSources[key].push({
			...source,
			matchedText
		});
		if (extractionTrace.length < 60) extractionTrace.push({
			rule,
			source,
			matchedText
		});
	};
	if (base.coverPolicy && base.coverPolicy !== "unspecified") addTrace("coverPolicy", `已识别封面规则：${base.coverPolicy}`, "封面", /封面|cover/u.source);
	if (base.tocPolicy && base.tocPolicy !== "unspecified") addTrace("tocPolicy", `已识别目录规则：${base.tocPolicy}`, "目录", /目录|toc/u.source);
	for (const t of requiredTables) addTrace("requiredTables", `必需表格：${t}`, t, /全文必须输出|必须输出表格|项目基本信息表/u.source);
	for (const kw of requiredKeywords) addTrace("requiredKeywords", `必含关键词：${kw}`, kw, /必须包含|必须含|应包含|需要包含/u.source);
	for (const fp of forbiddenPatterns) addTrace("forbiddenPatterns", `禁止内容：${fp}`, fp, /禁止|不得|严禁|杜绝/u.source);
	for (const h of exactHeadings) addTrace("exactHeadings", `固定章节：${h}`, h, /第[一二三四五六七八九十百千\d]+章/u.source);
	if (minWords) addTrace("minWords", `最低字数：${minWords}`, String(minWords), /\d{3,}\s*字/u.source);
	return {
		...base,
		requiredTables,
		requiredKeywords,
		forbiddenPatterns,
		appendixTableTitles: appendixTables.titles.length > 0 ? appendixTables.titles : void 0,
		appendixAttachedAtEnd: appendixTables.attachedAtEnd || void 0,
		sourceHash: simpleHashText(normalizedText),
		exactHeadings,
		forbidExtraHeadings: /不得合并|不得删除|不得改名|不得新增|严格按.*章节名称|一级章节.*不得/u.test(normalizedText) || exactHeadings.length > 0,
		requiredSubjects: /我公司/u.test(normalizedText) ? ["我公司", "项目部"] : [],
		forbiddenSubjects,
		backendTerms,
		commercialTerms,
		forbiddenTerms: [...new Set([
			...base.forbiddenTerms,
			...backendTerms,
			...commercialTerms,
			...forbiddenSubjects
		])],
		forbidFabrication: /不得编造|严禁编造|不得擅自|资料未明确|系统暂未|事实真实性/u.test(normalizedText),
		requireEvidenceForQuantities: /量化|参数|数值|具体数据|具体参数|工程实体参数|资料中明确|不得空泛|不能空泛|泛泛而谈/u.test(normalizedText),
		preferProjectFacts: /事实优先|项目事实|真实性高于/u.test(normalizedText),
		minWords,
		minChars: minWords,
		chapterRules,
		roleRules,
		executionSummary,
		ruleSources: Object.keys(ruleSources).length > 0 ? ruleSources : void 0,
		extractionTrace: extractionTrace.length > 0 ? extractionTrace : void 0
	};
}
function promptPolicy(text, subject) {
	const required = new RegExp(`(?:生成|包含|输出|需要|保留|设置|编制|制作)[^。；;\\n]{0,12}${subject}|${subject}[^。；;\\n]{0,12}(?:必须|应当|需要|保留|生成|输出|包含)`, "u").test(text);
	if (new RegExp(`(?:不要|不需要|不允许|不得|禁止|严禁|不输出|不生成|无需)[^。；;\\n]{0,12}${subject}|${subject}[^。；;\\n]{0,12}(?:不要|不需要|不允许|不得|禁止|严禁|不输出|不生成|无需)`, "u").test(text)) return "forbidden";
	if (required) return "required";
	return "unspecified";
}
function extractPromptDocumentRules(promptTexts) {
	const normalizedText = promptTexts.replace(/\\n/gu, "\n");
	const requiredTables = /* @__PURE__ */ new Set();
	const tableLine = /全文必须输出[：:]\s*([^。；;\n]+)/u.exec(normalizedText)?.[1] || /必须输出(?:的)?表格[：:]\s*([^。；;\n]+)/u.exec(normalizedText)?.[1] || "";
	for (const part of tableLine.split(/[、,，]/u)) {
		const title = /([\p{Script=Han}A-Za-z0-9（）()]{2,30}表)$/u.exec(part.trim())?.[1];
		if (title && title.length >= 4 && title.length <= 30) requiredTables.add(title);
	}
	if (/项目基本信息表/u.test(normalizedText)) requiredTables.add("项目基本信息表");
	const forbiddenTerms = [
		"知识库",
		"提示词",
		"建议补充",
		"资料库",
		"OCR",
		"后台话术",
		"后台流程",
		"后台数据",
		"后台资料",
		"后台溯源",
		"绑定片段"
	];
	if (/杜绝(?:套话|空话)|禁止(?:套话|空话)|不得(?:套话|空话)|严禁(?:套话|空话)/u.test(normalizedText)) forbiddenTerms.push("高度重视", "重中之重");
	if (/技术标(?:正文)?(?:不得|禁止|严禁).*(?:商务|报价|单价|税率|利润|造价)/u.test(normalizedText)) forbiddenTerms.push("报价明细表");
	const coverPolicy = promptPolicy(normalizedText, "封面");
	const tocPolicy = promptPolicy(normalizedText, "目录");
	return {
		coverPolicy,
		tocPolicy,
		forbidCover: coverPolicy === "forbidden",
		forbidToc: tocPolicy === "forbidden",
		forbiddenTerms: [...new Set(forbiddenTerms)],
		preferredTerms: [{
			from: "高度重视",
			to: "严格落实"
		}, {
			from: "重中之重",
			to: "关键控制事项"
		}],
		requiredTables: [...requiredTables],
		requiredKeywords: extractRequiredKeywordRules(normalizedText),
		forbiddenPatterns: extractForbiddenPatternRules(normalizedText)
	};
}
/** 多提示词规则冲突检测：对比各提示词运行时抽取的硬性规则，识别相互矛盾的要求（模板校验时调用） */
function detectPromptRuleConflicts(prompts) {
	const conflicts = [];
	const extracted = prompts.map((prompt) => ({
		prompt,
		rules: buildRuntimePromptRules({ promptTexts: prompt.content })
	})).filter((item) => item.rules.executionSummary.length > 0);
	if (extracted.length < 2) return conflicts;
	for (let i = 0; i < extracted.length; i++) for (let j = i + 1; j < extracted.length; j++) {
		const a = extracted[i];
		const b = extracted[j];
		const aName = `${a.prompt.name}(${a.prompt.roleId})`;
		const bName = `${b.prompt.name}(${b.prompt.roleId})`;
		const crossHits = [];
		for (const kw of a.rules.requiredKeywords || []) for (const fb of [...b.rules.forbiddenTerms || [], ...b.rules.forbiddenPatterns || []]) if (kw.includes(fb) || fb.includes(kw)) crossHits.push(`「${kw}」被要求必含（${aName}）但被禁止（${bName}：${fb}）`);
		for (const kw of b.rules.requiredKeywords || []) for (const fa of [...a.rules.forbiddenTerms || [], ...a.rules.forbiddenPatterns || []]) if (kw.includes(fa) || fa.includes(kw)) crossHits.push(`「${kw}」被要求必含（${bName}）但被禁止（${aName}：${fa}）`);
		for (const hit of [...new Set(crossHits)].slice(0, 4)) conflicts.push({
			level: "warning",
			message: hit
		});
		const aHeadings = a.rules.exactHeadings || [];
		const bHeadings = b.rules.exactHeadings || [];
		if (aHeadings.length > 0 && bHeadings.length > 0) {
			const bSet = new Set(bHeadings);
			const aSet = new Set(aHeadings);
			const diff = [...new Set([...aHeadings.filter((h) => !bSet.has(h)), ...bHeadings.filter((h) => !aSet.has(h))])];
			if (diff.length > 0) conflicts.push({
				level: "warning",
				message: `固定一级章节列表不一致：${aName} 要求 ${aHeadings.length} 章，${bName} 要求 ${bHeadings.length} 章（差异：${diff.slice(0, 3).join("、")}）。生成时将合并去重。`
			});
		}
		for (const policy of ["coverPolicy", "tocPolicy"]) {
			const av = a.rules[policy];
			const bv = b.rules[policy];
			if (av && bv && av !== "unspecified" && bv !== "unspecified" && av !== bv) conflicts.push({
				level: "warning",
				message: `${policy === "coverPolicy" ? "封面" : "目录"}策略冲突：${aName} 要求「${av === "required" ? "生成" : "禁止"}」，${bName} 要求「${bv === "required" ? "生成" : "禁止"}」。生成时以禁止优先。`
			});
		}
		if (a.rules.minWords && b.rules.minWords && a.rules.minWords !== b.rules.minWords) conflicts.push({
			level: "warning",
			message: `最低字数要求不一致：${aName} ${a.rules.minWords} 字 vs ${bName} ${b.rules.minWords} 字。生成时将取最大值 ${Math.max(a.rules.minWords, b.rules.minWords)} 字。`
		});
	}
	return conflicts;
}
var init_promptRuleExtraction = __esmMin((() => {
	init_budget();
	init_evidence();
	init_llmClient();
	init_outline();
	init_markdownComposer();
	init_sectionNamingGovernance();
	init_sectionFingerprint();
}));
//#endregion
export { init_sectionFingerprint as i, promptRuleExtraction_exports as n, init_sectionNamingGovernance as r, init_promptRuleExtraction as t };
