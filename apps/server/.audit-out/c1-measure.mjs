import { A as init_kbService, M as __commonJSMin, N as __esmMin, j as readProjectKbChunkTextsByHints } from "./evidence-Do7rMaSU.js";
import { n as init_promptRuleExtraction, t as extractAppendixTables } from "./promptRuleExtraction-DUs0jotb.js";
import { readFileSync } from "node:fs";
//#region apps/server/src/services/document-workflow/bidComposition.ts
/** 勾选标记双形态：标记在词前（「☑暗标」）与词后（「暗标（√）」——两种排版写法均存在） */
function markPatterns(word) {
	const chars = [...word];
	const inner = `${chars[0]}\\s*${chars[1]}`;
	return [new RegExp(`${CHECK_MARK}${MARK_GAP}${inner}`, "u"), new RegExp(`${inner}${MARK_GAP}${CHECK_MARK}`, "u")];
}
/** 依序取首个命中（返回匹配原文，供证据链显性展示） */
function firstPatternHit(scope, patterns) {
	for (const pattern of patterns) {
		const match = pattern.exec(scope);
		if (match) return (match[0] || "").trim();
	}
}
/** 附表标题 → 分类与数据源绑定（附表一/二/三/六 表类绑蓝图数据；四/五 图类人工补图） */
function appendixKindAndSource(name) {
	if (/施工设备表|机械设备表|施工机械.*设备/u.test(name)) return {
		kind: "table",
		dataSource: "blueprint.equipment"
	};
	if (/试验.*仪器|检测仪器|试验仪器|仪器设备表/u.test(name)) return {
		kind: "table",
		dataSource: "blueprint.testInstruments"
	};
	if (/劳动力/u.test(name)) return {
		kind: "table",
		dataSource: "blueprint.labor"
	};
	if (/临时用地/u.test(name)) return {
		kind: "table",
		dataSource: "blueprint.tempLand"
	};
	if (/网络图|进度图|横道图|开.*竣工/u.test(name)) return {
		kind: "figure",
		dataSource: "manual"
	};
	if (/总平面/u.test(name)) return {
		kind: "figure",
		dataSource: "manual"
	};
	return {
		kind: "table",
		dataSource: "manual"
	};
}
/** 文本内取「施工组织设计采用」标记窗口（±尾随 320 字符，覆盖「□明标。☑暗标。」段） */
function adoptionWindows(text) {
	const windows = [];
	for (const match of text.matchAll(/施工组织设计\s*采用\s*[:：]?/gu)) {
		const start = match.index || 0;
		windows.push(text.slice(start, start + 320));
	}
	return windows;
}
function firstMatch(text, pattern) {
	const match = pattern.exec(text);
	return match ? (match[0] || "").trim() : void 0;
}
/**
* 标书编制规格提取（确定性，无 LLM）：标书类型 + 正文口径 + 附表清单 + 格式要求 + 身份禁语。
* 输入为招标/补疑/答疑/评标文件全量切片文本（直读通道，与评分项要求提取链同源）。
*/
function extractBidCompositionSpec(input) {
	const normalized = [...input.tenderTexts, input.requirement || ""].filter(Boolean).join("\n").replace(/\\n/gu, "\n").replace(/\r/gu, "");
	const evidence = [];
	const windows = adoptionWindows(normalized);
	const adoptScope = windows.length > 0 ? windows.join("\n") : normalized;
	const blindMarked = firstPatternHit(adoptScope, BLIND_MARK_PATTERNS);
	const openMarked = firstPatternHit(adoptScope, OPEN_MARK_PATTERNS);
	const blindSemantic = firstPatternHit(normalized, BLIND_SEMANTIC_SIGNALS);
	const openSemantic = firstPatternHit(normalized, OPEN_SEMANTIC_SIGNALS);
	let bidType = "unknown";
	if (blindMarked) {
		bidType = "blind";
		evidence.push(`标书类型勾选证据：${blindMarked}`);
	} else if (openMarked) {
		bidType = "open";
		evidence.push(`标书类型勾选证据：${openMarked}`);
	} else if (blindSemantic) {
		bidType = "blind";
		evidence.push(`结构证据：识别到「${blindSemantic}」条款（语义判定通道——勾选标记不可见或未被提取时的兜底，招标文件为该标段设定暗标编制条款）`);
	} else if (openSemantic) {
		bidType = "open";
		evidence.push(`结构证据：识别到「${openSemantic}」条款（语义判定通道——按明标口径编制）`);
	}
	const bodySymbolOnlySentence = firstMatch(normalized, /正文内不允许[\s\S]{0,24}?出现非文字需要的其他任何符号和标志/u);
	const noFigureSentence = firstMatch(normalized, /不得有图片和扉页|不得有图片/u);
	const tableForbidHit = firstPatternHit(normalized, TABLE_FORBID_PATTERNS);
	const tableAllowHit = firstPatternHit(normalized, TABLE_ALLOW_PATTERNS);
	const tableForbidEvidence = tableForbidHit && !TABLE_FORBID_EXEMPT.test(tableForbidHit) ? tableForbidHit : void 0;
	const bodyTablePolicy = tableForbidEvidence ? "forbidden" : "allowed";
	if (tableForbidEvidence) evidence.push(`正文禁表证据：${tableForbidEvidence}`);
	else {
		if (tableAllowHit) evidence.push(`正文表格允许证据：${tableAllowHit}`);
		if (bodySymbolOnlySentence) evidence.push(`排版格式证据：${bodySymbolOnlySentence}（禁与投标内容无关符号标记的排版条款，不构成正文禁表）`);
	}
	const bodyFigurePolicy = bidType === "blind" || noFigureSentence ? "forbidden" : "allowed";
	if (noFigureSentence) evidence.push(`图片口径证据：${noFigureSentence}`);
	const appendixPlan = extractAppendixTables(normalized).titles.map((title) => {
		return {
			no: title.replace(/^附表\s*/u, "").split(/\s+/u)[0] || "",
			title,
			...appendixKindAndSource(title.replace(/^附表\s*[一二三四五六七八九十\d]{1,3}\s*/u, "").trim())
		};
	});
	if (appendixPlan.length > 0) evidence.push(`文末附表清单 ${appendixPlan.length} 项：${appendixPlan.map((item) => item.title).join("、")}`);
	const bodyType = /正文(?:部分)?(?:一律|均)?采用\s*(小?[一二三四五六七八九十]号)?\s*([\u4e00-\u9fffA-Za-z_]{2,10})/u.exec(normalized);
	const headingType = /大标题用\s*([小]?[一二三四五六七八九十]号)\s*([\u4e00-\u9fffA-Za-z_]{2,10})/u.exec(normalized);
	const gutterMatch = /装订线\s*([\d.]+\s*[-~－—]\s*[\d.]+\s*cm|[\d.]+\s*cm)/u.exec(normalized);
	const lineHeightMatch = /行间距为固定值\s*(\d+)\s*磅/u.exec(normalized);
	const pageLimitMatch = /(?:总页数上限|页数上限)\s*[:：]?\s*(\d+)|不得超过\s*(\d+)\s*页/u.exec(normalized);
	const formatRules = {
		monoColor: /一律单黑色|全部单黑色|均单黑色/u.test(normalized) ? true : void 0,
		cover: /不设内封(?:面)?/u.test(normalized) ? "forbidden" : void 0,
		headersFooters: /不需编制页眉、页脚|不编制页眉|不需要页眉|不需编制页眉/u.test(normalized) ? "forbidden" : void 0,
		bodyFont: bodyType?.[2] ? `${bodyType[2]}${/GB2312/iu.test(normalized) ? "（GB2312）" : ""}` : void 0,
		bodySize: bodyType?.[1] || void 0,
		headingSize: headingType?.[1] || void 0,
		headingFont: headingType?.[2] || void 0,
		gutter: gutterMatch?.[1]?.replace(/\s+/gu, "") || void 0,
		lineHeight: lineHeightMatch?.[1] ? `固定值${lineHeightMatch[1]}磅` : void 0,
		pageLimit: pageLimitMatch ? Number(pageLimitMatch[1] || pageLimitMatch[2]) || void 0 : void 0
	};
	const identityMarksForbidden = /明示或暗示具体投标人|以往的施工业绩/u.test(normalized);
	if (identityMarksForbidden) evidence.push("投标人身份禁语证据：任何部位、任何条文出现明示或暗示具体投标人的说明及标记（包括以往的施工业绩等）");
	const conflicts = [];
	if (bodyTablePolicy === "forbidden" && (input.requiredTables || []).length > 0) for (const rawTitle of input.requiredTables || []) {
		const table = rawTitle.trim();
		if (!table) continue;
		const mapped = appendixPlan.find((entry) => appendixNameMatchesTable(entry.title, table));
		conflicts.push({
			rule: `提示词必需表格《${table}》`,
			source: "用户提示词",
			resolution: mapped ? `招标正文禁表（显式禁表句）：该表已收敛入文末《${mapped.title}》，正文不再输出表格` : "招标正文禁表（显式禁表句）：该表取消表格形式，数据以对应章节文字表述呈现"
		});
	}
	return {
		bidType,
		bodyTablePolicy,
		bodyFigurePolicy,
		appendixPlan,
		formatRules,
		identityMarksForbidden,
		conflicts,
		evidence
	};
}
/** 提示词表名与附表标题匹配（去「附表N」前缀后双向包含，容忍「设备表」↔「主要施工设备表」缩略） */
function appendixNameMatchesTable(appendixTitle, tableTitle) {
	const appendixName = appendixTitle.replace(/^附表\s*[一二三四五六七八九十\d]{1,3}\s*/u, "").replace(/\s+/gu, "").replace(/表$/u, "");
	const table = tableTitle.replace(/\s+/gu, "").replace(/表$/u, "");
	if (!appendixName || !table) return false;
	return appendixName.includes(table) || table.includes(appendixName);
}
/** 正文禁表（bodyTablePolicy=forbidden：招标显式禁表句；允许/无证据时 allowed） */
function isBodyTableForbidden(spec) {
	return spec?.bodyTablePolicy === "forbidden";
}
/** 正文禁图（bodyFigurePolicy=forbidden：暗标或招标禁图片证据；与正文表格口径并列） */
function isBodyFigureForbidden(spec) {
	return spec?.bodyFigurePolicy === "forbidden";
}
/**
* 写作约束文本（招标编制口径注入写作/修复提示词）。
* 双分支（C1）：正文允许表格时注入「表格按系统表格计划输出 + 图类数据表格化 + 禁图片」口径；
* 正文禁表（显式禁表句）时注入纯文字口径；无口径差异（明标无特殊要求）返回空串不注入。
*/
function bidCompositionWritingRules(spec) {
	if (!spec) return "";
	const tableForbidden = spec.bodyTablePolicy === "forbidden";
	const figureForbidden = spec.bodyFigurePolicy === "forbidden";
	if (!tableForbidden && !figureForbidden && !spec.formatRules.monoColor && !spec.identityMarksForbidden) return "";
	const lines = ["【正文编制口径（招标文件要求，硬性验收项）】"];
	if (tableForbidden) {
		lines.push("1. 正文一律纯文字表述：不得输出任何 Markdown 表格或管道符表格结构；数据性内容以段落文字表述（人数、台数、工艺参数、计划节点等数值一律原样引用蓝图权威锚点，不得编造或自设）。");
		lines.push("2. 结构化数据表由系统在文末附表区按招标附表清单统一生成，正文不重复列出表格。");
	} else {
		lines.push("1. 正文表格按系统表格计划输出：只输出任务中明确列出的表格（表格计划），不得自行新增、改名或改变列结构；数据一律原样引用蓝图权威锚点，不得编造或自设。");
		lines.push("2. 图类数据（进度/网络/横道/平面布置等）以表格化数据表达，不绘制图片；表格与图类数据位置服从任务中给定的表格计划。");
	}
	if (figureForbidden) lines.push(`${lines.length}. 不得插入图片、Markdown 图片语法或图件占位；图类内容由系统统一数据化处理。`);
	if (spec.formatRules.monoColor) lines.push(`${lines.length}. 表格与文字一律单黑色（黑白）表述，不得出现彩色标注、高亮或颜色说明。`);
	if (spec.identityMarksForbidden) lines.push(`${lines.length}. 不得出现任何明示或暗示具体投标人的说明及标记（投标人名称、以往施工业绩、获奖情况等一律不得写入正文）。`);
	return lines.join("\n");
}
/** 标书编制规格进度摘要（显性展示判定与裁决，可审计） */
function bidCompositionSummary(spec) {
	const parts = [
		`标书类型：${spec.bidType === "blind" ? "暗标" : spec.bidType === "open" ? "明标" : "未识别（按常规口径）"}`,
		`正文表格：${spec.bodyTablePolicy === "forbidden" ? "禁表格（招标显式禁表句）" : "允许（表格按系统表格计划输出）"}`,
		`正文图片：${spec.bodyFigurePolicy === "forbidden" ? "禁图片（图类数据化输出）" : "允许"}`,
		spec.appendixPlan.length > 0 ? `文末附表 ${spec.appendixPlan.length} 项（表类 ${spec.appendixPlan.filter((item) => item.kind === "table").length} / 图类 ${spec.appendixPlan.filter((item) => item.kind === "figure").length}）` : "未识别文末附表清单",
		spec.formatRules.pageLimit ? `总页数上限 ${spec.formatRules.pageLimit} 页` : ""
	].filter(Boolean);
	const details = [
		...spec.evidence.map((item) => `证据：${item}`),
		...spec.bidType === "unknown" ? ["核查指引：检索招标文件「施工组织设计采用」勾选项（标记字符变体 ☑/√/■/▣ 与「按暗标/采用暗标评审」语义条款均已覆盖）或「暗标编制要求」条款，确认标书类型后重跑以切换编制口径"] : [],
		...spec.appendixPlan.map((item) => `附表${item.no}：${item.title}（${item.kind === "figure" ? "图类·编制人补图" : `数据源 ${item.dataSource}`}）`),
		spec.formatRules.gutter ? `格式：装订线 ${spec.formatRules.gutter}${spec.formatRules.lineHeight ? `、行距${spec.formatRules.lineHeight}` : ""}` : "",
		spec.formatRules.bodyFont ? `格式：正文 ${[spec.formatRules.bodySize, spec.formatRules.bodyFont].filter(Boolean).join(" ")}${spec.formatRules.headingSize ? `、大标题 ${spec.formatRules.headingSize}` : ""}` : "",
		spec.formatRules.cover === "forbidden" ? "格式：不设内封面（终稿移除封面块）" : "",
		spec.formatRules.monoColor ? "格式：图表一律单黑色" : "",
		spec.identityMarksForbidden ? "身份禁语：正文不得出现投标人名称/以往业绩等标记" : "",
		...spec.conflicts.map((item) => `冲突裁决：${item.rule}——${item.resolution}`)
	].filter(Boolean);
	return {
		status: spec.bidType === "unknown" ? "skipped" : "success",
		message: spec.bidType === "unknown" ? "⚠ 标书类型未判定（告警）：未识别到「本项目施工组织设计采用：□明标/☑暗标」勾选标记与暗标编制要求语义证据，本次按常规口径生成（正文表格策略按招标证据判定、正文图片允许）——若本项目实为暗标，正文图片与投标人标记可能未被禁止（暗标通常不得出现），请核对招标文件后重跑" : `标书编制规格：${parts.join("；")}`,
		details
	};
}
var CHECK_MARK, MARK_GAP, BLIND_MARK_PATTERNS, OPEN_MARK_PATTERNS, BLIND_SEMANTIC_SIGNALS, OPEN_SEMANTIC_SIGNALS, TABLE_FORBID_PATTERNS, TABLE_FORBID_EXEMPT, TABLE_ALLOW_PATTERNS;
var init_bidComposition = __esmMin((() => {
	init_promptRuleExtraction();
	CHECK_MARK = "[☑√✔✓■●◼☒⊠▣]";
	MARK_GAP = "[\\uFE0E\\uFE0F\\s（）()【】\\[\\]〔〕]*";
	BLIND_MARK_PATTERNS = markPatterns("暗标");
	OPEN_MARK_PATTERNS = markPatterns("明标");
	BLIND_SEMANTIC_SIGNALS = [
		/暗标(?:评审项目)?的?编制要求/u,
		/(?<!不)按暗标/u,
		/(?<!不)(?:采用|执行|实行)暗标(?:评审|方式|编制|形式)/u,
		/暗标(?:评审|编制)(?:方式|办法|程序)/u
	];
	OPEN_SEMANTIC_SIGNALS = [
		/明标(?:评审项目)?的?编制要求/u,
		/(?<!不)按明标/u,
		/(?<!不)(?:采用|执行|实行)明标(?:评审|方式|编制|形式)/u,
		/明标(?:评审|编制)(?:方式|办法|程序)/u
	];
	TABLE_FORBID_PATTERNS = [
		/正文(?:部分)?[\s\S]{0,16}?(?:不得|不允许|禁止|严禁)[\s\S]{0,16}?(?:使用|出现|插入|包含|采用|列入|设置|添加|附带|有|存在)[\s\S]{0,8}?(?:任何|所有|全部|其它|其他)?(?:表格|图表|框图)/u,
		/(?:不得|不允许|禁止|严禁)[\s\S]{0,10}?(?:在)?正文(?:部分|中|内|里)?[\s\S]{0,10}?(?:使用|出现|插入|包含|采用|列入|设置|添加|附带|有|存在)[\s\S]{0,8}?(?:任何|所有|全部|其它|其他)?(?:表格|图表|框图)/u,
		/(?:任何|所有|全部|其它|其他)?(?:表格|图表|框图)[\s\S]{0,16}?(?:一律|均|全部|都)?(?:不得|不允许|禁止|严禁)[\s\S]{0,12}?(?:出现|写入|进入|列入|使用|用于|插入)[\s\S]{0,12}?正文/u,
		/正文(?:部分)?[\s\S]{0,12}?(?:一律|均|只能|仅)[\s\S]{0,8}?(?:纯文字|文字表述|文字叙述|文字描述)(?![\s\S]{0,2}?(?:结合|及|与|和))/u
	];
	TABLE_FORBID_EXEMPT = /颜色|彩色|单色|黑白|无关|不相干|非文字需要/u;
	TABLE_ALLOW_PATTERNS = [
		/文字(?:表述|叙述|说明|描述)?[\s\S]{0,4}?(?:结合|相结合)[\s\S]{0,4}?(?:图表|表格|框图)/u,
		/除(?:采用)?文字(?:表述|叙述)?外[\s\S]{0,4}?(?:可|可以)?附[\s\S]{0,4}?(?:下列|如下|相关|相应)?(?:图表|表格|框图)/u,
		/(?:横道图|网络图|进度(?:表|图)|平面布置图|框图|表格|图表)[\s\S]{0,26}?(?:自行确定|由投标人自定|不作规定|不作限制|不做要求)/u,
		/(?:表格|图表|框图)[\s\S]{0,16}?(?:可采用|可用|可以使用|应采用)[\s\S]{0,6}?A3/u,
		/(?:施工进度(?:表|图)?|总进度(?:表|图|计划)?|进度计划)[\s\S]{0,8}?(?:可|应)?采用[\s\S]{0,6}?(?:网络图|横道图)/u,
		/(?:图表|框图|表格)[\s\S]{0,10}?(?:一律|均|全部)[\s\S]{0,6}?单(?:黑色|色)/u,
		/图表及格式要求附后/u
	];
}));
//#endregion
//#region .dbg/c1-measure.ts
/**
* C1 测量脚本：编制口径类（D2 暗标「正文禁表」误判）归零验证——对历史轮（r28l 丰乐 / s28l 舒城）离线复算：
* ① s28l 判定复算：舒城 kb 直读重跑 extractBidCompositionSpec（修复后）vs 存档 draft.bidComposition（修复前
*    「暗标→禁表」硬推 forbidden）→ 期望翻转 allowed，且允许证据/排版证据双留存、无禁表证据；
* ② 消费链复算：isBodyTableForbidden/isBodyFigureForbidden（表计划/写作指令/拆表/门禁输入全链放开演示）
*    + 写作规则/摘要新口径渲染；
* ③ 产物侧复算：s28l 成稿正文区零表（修复前产物事实）+ 附表清单数据源绑定完整性；
* ④ 通用性抽查：r28l 丰乐存档判定不回归 + 明标/显式禁表/无证据三态合成样本（防误伤/防漏判）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c1-measure.config.mjs
*   node apps/server/.audit-out/c1-measure.mjs
*/
var require_c1_measure = /* @__PURE__ */ __commonJSMin((() => {
	init_kbService();
	init_bidComposition();
	const ROOT = "/Users/pan/Desktop/codeing/customize-agent";
	const DOCS = [{
		name: "r28l 丰乐",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884268681-31f4980c.json"
	}, {
		name: "s28l 舒城",
		file: "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789884273697-ea5fbe91.json"
	}];
	const KB_HINTS = [
		"暗标",
		"明标",
		"装订线",
		"可附下列图表",
		"不得有图片",
		"总页数上限",
		"单黑色"
	];
	let failures = 0;
	function check(label, pass, detail = "") {
		console.log(`${pass ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`);
		if (!pass) failures += 1;
	}
	function main() {
		console.log("================ ① s28l 判定复算（D2 归零核心） ================");
		const shuchengTexts = readProjectKbChunkTextsByHints(ROOT, KB_HINTS, { limit: 200 });
		console.log(`舒城 kb 定向切片：${shuchengTexts.length} 条 / ${shuchengTexts.join("\n").length} 字符`);
		const s28lDraft = JSON.parse(readFileSync(DOCS[1].file, "utf8"));
		const specBefore = s28lDraft.draft?.bidComposition;
		const specNow = extractBidCompositionSpec({
			tenderTexts: shuchengTexts,
			requiredTables: [
				"项目基本信息表",
				"劳动力计划表",
				"质量关键节点控制表"
			]
		});
		console.log("修复前（存档 draft.bidComposition）：");
		console.log(`  bodyTablePolicy=${specBefore?.bodyTablePolicy} / bodyFigurePolicy=${specBefore?.bodyFigurePolicy} / tablePlans=${(s28lDraft.draft?.chapters || []).reduce((sum, c) => sum + (c.tablePlans?.length || 0), 0)} 项`);
		console.log(`  证据：${(specBefore?.evidence || []).filter((e) => e.includes("口径")).join("；")}`);
		console.log("修复后（kb 直读复算）：");
		console.log(`  bidType=${specNow.bidType} / bodyTablePolicy=${specNow.bodyTablePolicy} / bodyFigurePolicy=${specNow.bodyFigurePolicy} / 附表 ${specNow.appendixPlan.length} 项`);
		console.log(`  证据：${specNow.evidence.filter((e) => e.includes("证据")).join("；")}`);
		check("s28l 判定翻转：forbidden → allowed", specBefore?.bodyTablePolicy === "forbidden" && specNow.bodyTablePolicy === "allowed");
		check("允许证据留存（除文字表述外可附下列图表）", specNow.evidence.some((item) => item.includes("正文表格允许证据")));
		check("排版格式证据留存（禁符号句不构成禁表）", specNow.evidence.some((item) => item.includes("排版格式证据")));
		check("无显式禁表证据（D2 误判消除）", !specNow.evidence.some((item) => item.includes("正文禁表证据")));
		check("标书类型仍为暗标（判定不受影响）", specNow.bidType === "blind");
		check("附表清单 6 项完整（表类 4 / 图类 2）", specNow.appendixPlan.length === 6 && specNow.appendixPlan.filter((i) => i.kind === "figure").length === 2);
		check("冲突清零（允许口径下不再裁决表格形式）", specNow.conflicts.length === 0);
		check("图片口径保持禁图片（bodyFigurePolicy 不受 C1 影响）", specNow.bodyFigurePolicy === "forbidden");
		console.log("\n================ ② 消费链复算（判定→全链出口） ================");
		check("isBodyTableForbidden=false（表计划/写作指令/拆表/门禁全链放开）", isBodyTableForbidden(specNow) === false);
		check("isBodyFigureForbidden=true（禁图保留，C1-4 双口径）", isBodyFigureForbidden(specNow) === true);
		const rules = bidCompositionWritingRules(specNow);
		check("写作规则=允许口径（表格按计划输出 + 禁图片 + 单黑色 + 身份禁语）", rules.includes("正文表格按系统表格计划输出") && rules.includes("不得插入图片") && rules.includes("单黑色") && rules.includes("投标人"));
		check("写作规则不含纯文字禁表口径（「正文一律纯文字表述」未注入）", !rules.includes("正文一律纯文字表述"));
		const summary = bidCompositionSummary(specNow);
		check("摘要显性展示：正文表格：允许（表格按系统表格计划输出）", summary.message.includes("正文表格：允许（表格按系统表格计划输出）"));
		check("摘要显性展示：正文图片：禁图片（图类数据化输出）", summary.message.includes("正文图片：禁图片（图类数据化输出）"));
		console.log("  写作规则（修复后注入口径）：");
		console.log(rules.split("\n").map((line) => `    ${line}`).join("\n"));
		console.log("\n================ ③ 产物侧复算（s28l 成稿事实） ================");
		const markdown = s28lDraft.markdown || "";
		const appendixIndex = markdown.search(/^## 附表\s*[一二三四五六七八九十\d]{1,3}/mu);
		const bodyTableRows = ((appendixIndex >= 0 ? markdown.slice(0, appendixIndex) : markdown).match(/^\|/gm) || []).length;
		check("正文区零表（修复前产物事实，D2 后果链实证）", bodyTableRows === 0, `正文区表格行=${bodyTableRows}`);
		check("文末附表区存在（附表清单已获承载位置）", appendixIndex >= 0, `起始位置=${appendixIndex}`);
		const blueprintBound = specNow.appendixPlan.filter((item) => item.dataSource !== "manual").length;
		check("附表数据源绑定完整（蓝图数据源 4 项）", blueprintBound === 4, `非 manual 数据源=${blueprintBound}`);
		console.log("\n================ ④ 通用性抽查（防误伤/防漏判） ================");
		const r28lBefore = JSON.parse(readFileSync(DOCS[0].file, "utf8")).draft?.bidComposition;
		console.log(`r28l 丰乐存档判定：bidType=${r28lBefore?.bidType} / bodyTablePolicy=${r28lBefore?.bodyTablePolicy}`);
		check("r28l 存档判定与修复后默认口径一致（unknown→allowed 不回归）", r28lBefore?.bidType === "unknown" && r28lBefore?.bodyTablePolicy === "allowed");
		check("合成抽查-明标：allowed（不受影响）", extractBidCompositionSpec({ tenderTexts: ["本项目施工组织设计采用：☑明标。"] }).bodyTablePolicy === "allowed");
		const forbidSpec = extractBidCompositionSpec({ tenderTexts: [
			"本项目施工组织设计采用：☑暗标。",
			"正文不得出现表格。",
			"本项目需提交下列附表，图表及格式要求附后。",
			"附表一 拟投入本标段的主要施工设备表",
			"附表二 拟配备本标段的试验和检测仪器设备表"
		] });
		check("合成抽查-显式禁表句：forbidden（禁表场景保留）", forbidSpec.bodyTablePolicy === "forbidden" && isBodyTableForbidden(forbidSpec));
		check("合成抽查-无证据：allowed（默认不硬推）", extractBidCompositionSpec({ tenderTexts: ["本项目施工组织设计内容应完整、方案合理可行。"] }).bodyTablePolicy === "allowed");
		console.log(`\n================ C1 归零验证结论：${failures === 0 ? "PASS（全项通过）" : `FAIL（${failures} 项未通过）`} ================`);
		if (failures > 0) process.exit(1);
	}
	main();
}));
//#endregion
export default require_c1_measure();
export { init_bidComposition as t };
