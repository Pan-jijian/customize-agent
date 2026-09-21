import { A as init_constants, C as init_tuningProfile, D as init_documentRoleService, E as init_projectMaterialService, F as TABLE_PLACEHOLDER_CELL_FORMS_RE, L as BID_DISCIPLINE_PHRASES, M as MARKDOWN_TABLE_DIVIDER_RE, N as MARKDOWN_TABLE_ROW_RE, O as getProjectRoot, P as TABLE_PLACEHOLDER_APPROX_RE, R as init_utils, S as init_llmClient, T as init_configService, U as __esmMin, V as init_budget, _ as init_outline$1, a as init_factMatching, c as init_markdownComposer, d as init_workflowRules, f as init_semanticGate, i as init_evidence, j as LINE_SPLIT_RE, k as init_kbService, l as init_constructionOrgTablePlan, m as init_semanticSimilarity, n as init_projectMaterialProfile, o as init_projectGraph, p as getLocalSemanticProvider, r as init_agentWorkflow, s as docSystemPrefix, t as init_templateStore, u as init_writingSpec, w as tuningProfile, x as concurrencyForDocumentScale, z as documentTextLength } from "./templateStore-CwGo8aJx.js";
import { a as init_promptRuleExtraction, o as init_sectionNamingGovernance, s as init_sectionFingerprint } from "./promptRuleExtraction-g1n77Nah.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { computeProjectId } from "@customize-agent/knowledge";
import * as path$1 from "path";
import * as os$1 from "os";
import * as fs$1 from "fs";
import "xlsx";
//#region apps/server/src/services/document-workflow/bidComposition.ts
/** 勾选标记双形态：标记在词前（「☑暗标」）与词后（「暗标（√）」——两种排版写法均存在） */
function markPatterns(word) {
	const chars = [...word];
	const inner = `${chars[0]}\\s*${chars[1]}`;
	return [new RegExp(`${CHECK_MARK}${MARK_GAP}${inner}`, "u"), new RegExp(`${inner}${MARK_GAP}${CHECK_MARK}`, "u")];
}
var CHECK_MARK, MARK_GAP;
var init_bidComposition = __esmMin((() => {
	init_promptRuleExtraction();
	CHECK_MARK = "[☑√✔✓■●◼☒⊠▣]";
	MARK_GAP = "[\\uFE0E\\uFE0F\\s（）()【】\\[\\]〔〕]*";
	markPatterns("暗标");
	markPatterns("明标");
}));
var init_documentFactTrace = __esmMin((() => {
	new RegExp(`(?:GB|JGJ|CJJ|CECS|ISO|SL|DL|JTS|JTG|JT|TB|DB\\d{2}|DB)\\s*\\/?\\s*T?\\s*(\\d{3,5})(?:\\s*[-—–]\\s*(\\d{2,4}))?`, "giu");
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/markdownCleanup.ts
/** 表格单元格不可见字符归一（全角空格 \u3000 / 不换行空格 \u00a0 / 零宽与变体空格 \u2000-\u200f\u202f\u205f / BOM \ufeff）。
* 十度实测缺陷：LLM 输出的空表格单元格有时以全角空格等不可见字符填充，cell.trim() 无法识别，
* 检测/修复/审计三层全部漏网；清洗层剥离后三层同口径以 cell === '' 判定空单元格。 */
function stripTableCellInvisibleChars(text) {
	return text.replace(/[\u3000\u00a0\u2000-\u200f\u202f\u205f\ufeff]/gu, "");
}
var init_markdownCleanup = __esmMin((() => {
	init_markdownComposer();
	init_outline$1();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/drawingFactLock.ts
var init_drawingFactLock = __esmMin((() => {
	init_evidence();
})), EQUIPMENT_NAME_SUFFIX_SOURCE;
var init_resourceBreakdownNumbers = __esmMin((() => {
	EQUIPMENT_NAME_SUFFIX_SOURCE = "机|吊|泵|车|夯";
	new RegExp(`([\\p{Script=Han}A-Za-z0-9]{2,8}(?:${EQUIPMENT_NAME_SUFFIX_SOURCE}))$`, "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/tenderBidChecks.ts
var init_tenderBidChecks = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
}));
//#endregion
//#region apps/server/src/services/document-workflow/numericalConsistency.ts
/** longestCommonHanSubstring 的带位置变体：返回最长公共连续汉字子串的长度与其在 left 原文
* 中的下标区间 [start, end)（V5 P4b-2 阶段名拼接歧义判定用——需知道最长命中片段未覆盖的
* 残余前/后片段）。长度口径与 longestCommonHanSubstring 严格一致（同一 DP 与严格改进口径）。 */
function longestCommonHanSubstringSpan(left, right) {
	const aMatches = [...left.matchAll(/[\p{Script=Han}]/gu)];
	const b = right.match(/[\p{Script=Han}]/gu) || [];
	if (aMatches.length === 0 || b.length === 0) return {
		length: 0,
		start: 0,
		end: 0
	};
	let best = 0;
	let bestI = -1;
	const dp = new Array(b.length).fill(0);
	for (let i = 0; i < aMatches.length; i += 1) {
		let prev = 0;
		for (let j = 0; j < b.length; j += 1) {
			const carry = dp[j];
			dp[j] = aMatches[i][0] === b[j] ? prev + 1 : 0;
			prev = carry;
			if (dp[j] > best) {
				best = dp[j];
				bestI = i;
			}
		}
	}
	if (best === 0 || bestI < 0) return {
		length: 0,
		start: 0,
		end: 0
	};
	const startMatch = aMatches[bestI - best + 1];
	const endMatch = aMatches[bestI];
	return {
		length: best,
		start: startMatch.index,
		end: endMatch.index + endMatch[0].length
	};
}
var init_numericalConsistency = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/evidenceContentSafety.ts
var init_evidenceContentSafety = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	init_outline$1();
}));
//#endregion
//#region apps/server/src/services/document-workflow/semanticAdjudication.ts
var init_semanticAdjudication = __esmMin((() => {
	init_llmClient();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integrity/detectors/detectors.ts
function ambiguousEitherOrIssues(markdown) {
	const normalized = markdown.replace(/\s+/gu, "");
	const hits = /* @__PURE__ */ new Set();
	const headerCellTexts = [];
	{
		const headerLines = markdown.split(/\n/u);
		for (let i = 0; i + 1 < headerLines.length; i += 1) {
			const line = headerLines[i] ?? "";
			if (!/^\s*\|/u.test(line)) continue;
			if (!/^\s*\|[\s:|-]+\|\s*$/u.test((headerLines[i + 1] ?? "").trim())) continue;
			for (const cell of line.split("|")) {
				const cellText = cell.replace(/\s+/gu, "");
				if (cellText.length >= 2) headerCellTexts.push(cellText);
			}
		}
	}
	const inTableHeader = (text) => headerCellTexts.some((cell) => cell.includes(text));
	for (const match of normalized.matchAll(/([一-龥]{2,8})\/([一-龥]{2,8})/gu)) {
		const wordFamilyHit = DESIGN_PARAM_WORD_RE.test(match[1]) || DESIGN_PARAM_WORD_RE.test(match[2]);
		const decisionCategory = matchDecisionCategory(match[1], match[2]);
		if (!wordFamilyHit && !decisionCategory) continue;
		if (inTableHeader(match[0])) continue;
		const start = Math.max(0, (match.index || 0) - 12);
		const end = Math.min(normalized.length, (match.index || 0) + match[0].length + 12);
		const window = normalized.slice(start, end);
		if (/管线|管道|电缆|给水|排水/u.test(window)) continue;
		if (!/采用|形式|方式|方案|选用|拟用|拟采用|为/u.test(window)) {
			if (!decisionCategory || /不得|禁止|不应|不宜|避免|严禁|无需/u.test(window)) continue;
		}
		hits.add(`“${match[1]}/${match[2]}”`);
	}
	for (const match of normalized.matchAll(/[（(]\s*或[^）)]{1,48}[）)]/gu)) {
		const inner = match[0].slice(1, -1);
		if (!/按图纸|按实|按图|待定|另行|视[^，。；]{0,8}而定|根据实际/u.test(inner)) continue;
		const start = Math.max(0, (match.index || 0) - 20);
		const window = normalized.slice(start, (match.index || 0) + match[0].length);
		if (!DESIGN_PARAM_WORD_RE.test(window)) continue;
		hits.add(match[0].slice(0, 30));
	}
	for (const match of normalized.matchAll(/([一-龥]{2,8})或([一-龥]{2,8})/gu)) {
		const wordFamilyHit = DESIGN_PARAM_WORD_RE.test(match[1]) || DESIGN_PARAM_WORD_RE.test(match[2]);
		const decisionCategory = matchDecisionCategory(match[1], match[2]);
		if (!wordFamilyHit && !decisionCategory) continue;
		if (/(?:可能)?(?:达到|超过|大于|小于|高于|低于|不少于|不超过)或(?:达到|超过|大于|小于|高于|低于|不少于|不超过)/u.test(match[0])) continue;
		if (inTableHeader(match[1]) || inTableHeader(match[2])) continue;
		const start = Math.max(0, (match.index || 0) - 12);
		const window = normalized.slice(start, (match.index || 0) + match[1].length);
		if (/管线|管道|电缆|给水|排水/u.test(window)) continue;
		if (!/按|采用|选用|拟用|拟采用|方案|为/u.test(window)) {
			if (!decisionCategory || /不得|禁止|不应|不宜|避免|严禁|无需/u.test(window)) continue;
		}
		const preceding = normalized.slice(Math.max(0, (match.index || 0) - 6), match.index || 0);
		if (/临时/u.test(preceding + match[0]) && /支护|围护|放坡|坡率|开挖/u.test(match[0])) continue;
		if (/围挡|警示|防护栏|爬梯|栈桥|便道/u.test(match[0])) continue;
		const facilityWindow = normalized.slice(Math.max(0, (match.index || 0) - 30), (match.index || 0) + match[0].length + 12);
		if (/临时|临建|可拆卸|可周转|撤场/u.test(facilityWindow) && /集装箱|活动房|板房|棚房|岗亭|彩钢/u.test(match[1] + match[2])) continue;
		if (/顺接|衔接|接顺|接入|连通|找坡|找平/u.test(match[2])) continue;
		const afterWindow = normalized.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 6);
		if (/^(?:顺接|衔接|接顺|接入|连通|找坡|找平)/u.test(afterWindow)) continue;
		if (/(?:前|后)$/u.test(match[0])) continue;
		if (/^(?:之前|之后|前|后)/u.test(afterWindow)) continue;
		{
			const chainStart = Math.max(0, (match.index || 0) - 8);
			const chainEnd = Math.min(normalized.length, (match.index || 0) + match[0].length + 8);
			if (normalized.slice(chainStart, chainEnd).includes("→")) continue;
		}
		const defectPair = match[1] + match[2];
		if (/(?:强度不足|固定不牢|松动|变形|开裂|渗漏|破损|脱落|锈蚀|超差|不合格|缺陷|损坏|缺失|偏差|偏移|沉降|位移|错台|起皮|空鼓)/u.test(defectPair)) {
			const disposalWindow = normalized.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 40);
			if (/返工|返修|整改|修复|加固|更换|补强|补做|处理|消除|纠正|复验|复查|销项|验收/u.test(disposalWindow)) continue;
		}
		if (CONNECTION_CRAFT_TAIL_RE.test(match[1]) && CONNECTION_CRAFT_TERM_RE.test(match[2])) continue;
		const left = match[1].replace(/^.*?(地下连续墙|钢板桩|灌注桩|支护桩|土钉墙|基础|支护|围护|结构|开挖|放坡|喷锚|排桩|连续墙|土钉|锚杆|形式|体系)/u, "$1");
		hits.add(`${left}或${match[2]}`);
	}
	if (hits.size === 0) return [];
	return [{
		level: "error",
		severity: "blocker",
		category: "fact_consistency",
		owner: "llm",
		repairability: "llm_repairable",
		message: `关键设计决策两可表述：${[...hits].join("、")} 以并列/悬置形态表述，基础形式、支护形式等关键决策必须在正文中唯一确定`,
		suggestion: "以设计图纸/勘察报告/工程量清单为准锁定唯一决策并删除两可表述：明确写出本项目基础形式与支护形式的具体做法（如「基础形式为筏板基础」「基坑支护采用放坡+喷锚」），禁止「或…按图纸实施」类悬置话术。"
	}];
}
var HAZARD_CATEGORY_TERMS, NL, SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE, DESIGN_PARAM_WORD_RE, CONNECTION_CRAFT_TERM_RE, CONNECTION_CRAFT_TAIL_RE;
var init_detectors = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	init_evidenceContentSafety();
	init_integratedBlueprint();
	init_semanticAdjudication();
	HAZARD_CATEGORY_TERMS = [
		"落地式钢管脚手架",
		"悬挑式脚手架",
		"附着式升降脚手架",
		"脚手架",
		"模板支撑",
		"模板工程",
		"起重吊装",
		"吊装",
		"幕墙",
		"钢结构",
		"人工挖孔",
		"拆除",
		"暗挖",
		"爆破",
		"基坑",
		"降排水",
		"降水"
	];
	new RegExp(HAZARD_CATEGORY_TERMS.join("|"), "gu");
	NL = String.fromCharCode(10);
	new RegExp(`(?:^|${NL})(?:#{1,6}\\s+[^${NL}]*${NL}+)?([^${NL}|#][^。！？!?${NL}]{18,60})[。！？!?]`, "gu");
	SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE = /未落实[^。；;]{0,24}?(?:整改|复查|销项|复验)|未(?:明确|列明|注明)[^。；;]{0,36}?按[^。；;]{0,44}?(?:执行|选取|确定|取用|调整|选用)|(?:发现|对|明确|约定|签订|制定|建立|规定|凡|任何|所有|新增)[^。；;]{0,48}?(?:缺失|损坏|不全|脱岗|未审批|不合格|未完成|未明确|未落实|隐患)[^。；;]{0,72}?(?:整改|复查|销项|约谈|补齐|补拍|重拍|补传|重新上传|补测|复测|补报|归档|复核|确认|登记|通知|上报|通报|更新|处置|修复|更换|纠正|恢复|完善|处理|落实|责任|时限|考核|处罚|扣减|调离|清退|停止作业|恢复施工|补录|追查)|(?:不得|严禁|禁止)[^。；;]{0,40}?(?:避免|防止)[^。；;]{0,20}?(?:返工|窝工|损失|事故)|(?:重难点|难点)(?:源于|在于)[^。；;]{0,80}?(?:若|如)未[^。；;]{0,40}?(?:将|会|可能)|(?:考核|考评|评比|评分)[^。；;]{0,50}?(?:不合格|不达标|不到位|不称职|失职|缺失|超时|违规)[^。；;]{0,36}?(?:绩效扣减|扣减|扣款|调离|清退|退场|问责|处罚|奖惩|奖罚)|(?:如|若)[^。；;]{0,60}?(?:发包人|招标人|建设单位)[^。；;]{0,60}?(?:有权|可要求|可以要求|可提出|可以提出)|[^。；;]{0,24}?时[，,][^。；;]{0,32}?(?:发包人|招标人|建设单位)[^。；;]{0,60}?(?:有权|可要求|可以要求|可提出|可以提出)|未[^。；;]{0,16}?不放过|(?:凡|任何|所有)[^。；;]{0,24}?未[^。；;]{0,40}?(?:人员|工人)[^。；;]{0,20}?(?:不得|严禁|禁止)[^。；;]{0,20}?(?:进入|上岗|进场|作业)|未[^。；;]{0,32}?(?:前|的)[^。；;]{0,32}?(?:不得|严禁|禁止|不予|不办理|不签发|不安排|不组织|不批准|不开放|不下发|不投入使用)|(?:未能|未按|未完成|未明确|未落实|未闭合|未审批|缺失|损坏|缺漏|不合格|隐患)[^。；;]{0,40}?(?:整改|复查|销项|恢复|复核|确认|登记|更新|处置|修复|更换|纠正|完善|落实|补齐|补测|复测|归档|通知|上报|通报|约谈|扣减|停止作业)[^。；;]{0,20}?(?:复查|销项|确认|登记|归档|责任|时限|考核|处罚|扣减|调离|清退|落实|复核|恢复|整改|处置|更新|完成|闭合)|未(?:完成|通过|复审|核验|审查|审核|验收|办理|达标|整改|闭合|接受|取得)[^。；;]{0,32}?(?:不得|严禁|禁止|不予|不办理|不签发|不安排|不组织|不批准|不开放)[^。；;]{0,16}?(?:上岗|作业|进场|进入|担任|从事|投用|使用|操作|开工|复工|施工|回填|浇筑|砌筑|铺筑|摊铺|安装|隐蔽|覆盖|封闭|推进|实施|开放|通行|吊装|拆除|验收)|(?:对|针对)[^。；;]{0,20}?未[^。；;]{0,24}?(?:的|区段|部位|工序|作业面|任务|班组)[^。；;]{0,60}?(?:调整|调拨|调配|增派|增补|加强|优化)[^。；;]{0,60}?(?:确保|保障|保证)[^。；;]{0,24}?(?:不突破|不超|满足|达标|完成|实现)|(?:统计|评估|分析|核算|汇总|排查|监测)[^。；;]{0,30}?(?:未能|未按|未完成|未明确|未落实|缺失|损坏|损失|不合格|隐患|滞后|影响)[^。；;]{0,50}?(?:组织|调整|调拨|调配|增派|增补|补充|加密|加强|优化|纠偏|补位)[^。；;]{0,50}?(?:确保|保障|保证)[^。；;]{0,24}?(?:不[^。；;]{0,6}?(?:突破|超期|滞后|延误|影响|低于|少于|超过)|满足|达标|完成|实现|符合)|(?:缺失|损坏|缺漏|过期|失效)[^。；;]{0,24}?(?:当日|当天|立即|及时|随时|限期|按批|按次|定期)[^。；;]{0,16}?(?:补充|更换|修复|整改|处置|更新|补齐|完善|销项)/u;
	DESIGN_PARAM_WORD_RE = /基础|支护|围护|桩|结构|开挖|放坡|喷锚|排桩|连续墙|土钉|锚杆|标高|深度|形式|体系/u;
	CONNECTION_CRAFT_TERM_RE = /^(?:焊接|螺栓连接|铆接|法兰连接|承插连接|卡箍连接|粘接|卡压连接|卡扣连接|螺纹连接|高强螺栓连接)$/u;
	CONNECTION_CRAFT_TAIL_RE = /(?:焊接|螺栓连接|铆接|法兰连接|承插连接|卡箍连接|粘接|卡压连接|卡扣连接|螺纹连接|高强螺栓连接)$/u;
}));
//#endregion
//#region apps/server/src/services/document-workflow/qualityValidation.ts
function markdownTables(markdown) {
	const tableBlocks = [];
	const lines = markdown.split(LINE_SPLIT_RE);
	for (let index = 0; index < lines.length; index += 1) {
		if (!MARKDOWN_TABLE_ROW_RE.test(lines[index])) continue;
		const block = [];
		while (index < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[index])) {
			block.push(lines[index]);
			index += 1;
		}
		index -= 1;
		if (block.some((line) => MARKDOWN_TABLE_DIVIDER_RE.test(line))) tableBlocks.push(block.join("\n"));
	}
	return tableBlocks;
}
/** 表格占位符单元格判定单源（D-T5）：阻断层 markdownTableQualityIssues、警告层 formalPlaceholderIssues
* 与 patchGuard 预检三处共用。词形见 TABLE_PLACEHOLDER_CELL_FORMS_RE（含「无」扩围）+ 约N 模糊量；
* 豁免口径：①合计/小计/总计/累计行的「—」为不适用语义（cellIndex>0，行首格即合计标签）；
* ②规格型号/规格/型号/额定功率/功率/生产能力/产能列的「—」为「源资料不提供、强填诱导编造」合法形态
* （丰乐镇实测：蛙式打夯机无型号，LLM 修复轮曾编造 HW-60；r28g B7 扩围额定功率/生产能力）。
* C5 扩围（s28l 实机 8 行×3 列 24 处误报）：国别产地/制造年份/用于施工部位/已使用台时数为设备
* 仪器附表生成端硬编码「—」的投产信息列（composeAppendices renderEquipmentAppendix/
* renderInstrumentAppendix 注明「如实留空不编造」），与规格类列同族豁免——生成端故意留空与
* 检测端报阻断的口径冲突在此单源消解（豁免列与附表生成端表头保持对齐）。
* 其余占位词（若干/约/待定/无等）任何行任何列均不豁免，只豁免单个/多个破折号形态。
* r28f #42 归因：警告层此前用裸正则（无豁免口径），豁免列「—」被照报（实测 23 处误报）——统一到本判定。 */
function isNonExemptTablePlaceholderCell(cell, refs) {
	if (!TABLE_PLACEHOLDER_CELL_FORMS_RE.test(cell) && !TABLE_PLACEHOLDER_APPROX_RE.test(cell)) return false;
	if (!/^(?:—+|-+)$/u.test(cell)) return true;
	if (refs.cellIndex > 0 && /^(?:合计|小计|总计|累计)/u.test(refs.rowFirstCell || "")) return false;
	if (refs.headerCell && /规格型号|规格|型号|额定功率|功率|生产能力|产能|国别产地|制造年份|用于施工部位|已使用台时数/u.test(refs.headerCell)) return false;
	return true;
}
/** 表格占位符非豁免命中扫描（D-T5）：表块解析与 markdownTableQualityIssues 同源（连续表格行且
* 分隔线位于第二行；无分隔线/碎表由「表格分隔线位置不规范」独立阻断，不在此重复）。
* 命中含表头/行首/列位/格值定位，供警告层定级与 patchGuard 片段预检消费。 */
function scanTablePlaceholderCells(markdown) {
	const hits = [];
	for (const block of markdownTables(markdown)) {
		const rows = block.split(LINE_SPLIT_RE).filter((line) => MARKDOWN_TABLE_ROW_RE.test(line));
		if (rows.length < 2 || !MARKDOWN_TABLE_DIVIDER_RE.test(rows[1] || "")) continue;
		const cells = rows.map((line) => line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split(/(?<!\\)\|/u).map((cell) => stripTableCellInvisibleChars(cell.trim())));
		const header = cells[0] || [];
		for (const row of cells.slice(2)) for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
			const cell = row[cellIndex] || "";
			if (isNonExemptTablePlaceholderCell(cell, {
				rowFirstCell: row[0] || "",
				headerCell: header[cellIndex],
				cellIndex
			})) hits.push({
				header,
				rowFirstCell: row[0] || "",
				cellIndex,
				cell
			});
		}
	}
	return hits;
}
var init_qualityValidation = __esmMin((() => {
	init_constants();
	init_semanticSimilarity();
	init_documentFactTrace();
	init_outline$1();
	init_markdownComposer();
	init_markdownCleanup();
	init_drawingFactLock();
	init_resourceBreakdownNumbers();
	init_factMatching();
	init_templateStore();
	init_writingSpec();
	init_tenderBidChecks();
	init_semanticGate();
	init_detectors();
}));
//#endregion
//#region apps/server/src/services/document-workflow/agentPlanner.ts
var FORMAL_FORBIDDEN_PHRASES;
var init_agentPlanner = __esmMin((() => {
	init_utils();
	init_semanticSimilarity();
	init_outline$1();
	init_promptRuleExtraction();
	FORMAL_FORBIDDEN_PHRASES = [
		"知识库",
		"系统暂未",
		"项目资料暂未",
		"资料未明确",
		"暂未明确",
		"待确认",
		"待资料复核",
		"待系统",
		"未检索到",
		"资料不足",
		"无法确认",
		"建议补充",
		"不适用",
		"COL",
		"可核验信息",
		"工作包",
		...BID_DISCIPLINE_PHRASES
	];
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentIntegrityChecks.ts
var init_documentIntegrityChecks = __esmMin((() => {
	init_detectors();
	init_fixers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/internalTerminologyAnchors.ts
var INTERNAL_TERM_EXACT_RE;
var init_internalTerminologyAnchors = __esmMin((() => {
	init_semanticSimilarity();
	INTERNAL_TERM_EXACT_RE = /工作包|事实卡|事实主表|后台数据库|落位|峰值口径|控制口径|数据口径/gu;
}));
var init_patchGuard = __esmMin((() => {
	init_agentPlanner();
	init_documentIntegrityChecks();
	init_internalTerminologyAnchors();
	init_markdownComposer();
	init_qualityValidation();
	init_utils();
	[...FORMAL_FORBIDDEN_PHRASES.filter((phrase) => !BID_DISCIPLINE_PHRASES.includes(phrase)), ...INTERNAL_TERM_EXACT_RE.source.split("|")];
}));
//#endregion
//#region apps/server/src/services/document-workflow/rolePipeline.ts
function selectDocumentGenerationStrategy(input) {
	const chapterCount = input.template.chapters.length;
	const avgChapterTarget = chapterCount > 0 ? input.targetWords / chapterCount : input.targetWords;
	const text = `${input.template.name}\n${input.template.category || ""}\n${input.requirement || ""}`;
	const riskKeywords = /专项|安全|质量|验收|审核|合同|合规|审计|风控|风险/u.test(text);
	const veryLong = input.targetWords >= 4e4;
	const sparseMaterials = (input.materialFileCount ?? 0) < 4 && (input.evidenceCount ?? 0) < 6;
	const strict = riskKeywords || veryLong || sparseMaterials;
	const longform = input.targetWords >= 3e4 || chapterCount >= 8 || avgChapterTarget >= 4e3;
	const compact = input.targetWords <= 6e3 && chapterCount <= 4 && !strict;
	const globalReviewEnabled = process.env.DOCUMENT_GLOBAL_CONSISTENCY_REVIEW !== "0" && (strict || compact || process.env.DOCUMENT_GLOBAL_CONSISTENCY_REVIEW === "1");
	return {
		mode: strict ? "strict" : longform ? "longform" : compact ? "fast" : "balanced",
		enableChapterReview: true,
		enableGlobalReview: globalReviewEnabled,
		enableFinalQualityReview: true,
		globalReviewSamplingRate: globalReviewEnabled && compact ? .35 : 1
	};
}
var init_rolePipeline = __esmMin((() => {
	init_constants();
	init_documentRoleService();
	init_templateStore();
	init_evidence();
	init_outline$1();
	init_markdownComposer();
	init_bidComposition();
	init_qualityValidation();
	init_patchGuard();
	init_llmClient();
})), DEFAULT_FACT_FIELDS, COMMON_FORBIDDEN_PATTERNS, COMMON_DIAGNOSTIC_PATTERNS, COMMON_LOW_CONFIDENCE_PATTERNS, DEFAULT_DOCUMENT_DOMAIN_PROFILE;
var init_documentDomainProfileService = __esmMin((() => {
	DEFAULT_FACT_FIELDS = [
		{
			id: "document_identity",
			name: "对象名称",
			aliases: [
				"项目名称",
				"工程名称",
				"文档名称",
				"任务名称",
				"招标项目名称",
				"建设项目名称"
			],
			category: "identity",
			cardinality: "single",
			derivationPolicy: "source_only",
			usagePolicy: "must_use",
			confidencePolicy: {
				minForGeneration: .75,
				minForValidation: .85,
				allowPathOnly: false
			},
			conflictPolicy: "strict"
		},
		{
			id: "schedule_requirement",
			name: "周期要求",
			aliases: [
				"计划工期",
				"工期",
				"周期要求",
				"进度节点要求",
				"开工日期",
				"竣工日期"
			],
			category: "schedule",
			cardinality: "single",
			derivationPolicy: "source_only",
			usagePolicy: "must_use",
			confidencePolicy: {
				minForGeneration: .7,
				minForValidation: .8,
				allowPathOnly: false
			},
			conflictPolicy: "strict"
		},
		{
			id: "quality_requirement",
			name: "质量要求",
			aliases: [
				"质量要求",
				"质量标准",
				"验收要求",
				"评价标准"
			],
			category: "quality",
			cardinality: "multiple",
			derivationPolicy: "source_only",
			usagePolicy: "use_if_relevant",
			confidencePolicy: {
				minForGeneration: .65,
				minForValidation: .75,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		},
		{
			id: "safety_requirement",
			name: "安全合规要求",
			aliases: [
				"安全要求",
				"安全合规要求",
				"风险控制要求",
				"合规要求"
			],
			category: "safety",
			cardinality: "multiple",
			derivationPolicy: "source_only",
			usagePolicy: "use_if_relevant",
			confidencePolicy: {
				minForGeneration: .65,
				minForValidation: .75,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		},
		{
			id: "technical_parameter",
			name: "技术参数",
			aliases: [
				"技术参数",
				"参数规格范围",
				"规格",
				"型号",
				"尺寸",
				"标准编号",
				"材料设备"
			],
			category: "technical",
			cardinality: "multiple",
			derivationPolicy: "source_only",
			usagePolicy: "must_use",
			confidencePolicy: {
				minForGeneration: .7,
				minForValidation: .8,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		},
		{
			id: "resource_plan",
			name: "资源配置",
			aliases: [
				"劳动力",
				"机械",
				"检测设备",
				"应急物资",
				"资源配置",
				"人员配置"
			],
			category: "resource",
			cardinality: "multiple",
			derivationPolicy: "plan_inferable",
			usagePolicy: "use_if_relevant",
			confidencePolicy: {
				minForGeneration: .45,
				minForValidation: .55,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		},
		{
			id: "commercial_data",
			name: "商务数据",
			aliases: [
				"报价",
				"单价",
				"合价",
				"综合单价",
				"预留金",
				"税率",
				"金额",
				"利润"
			],
			category: "commercial",
			cardinality: "multiple",
			derivationPolicy: "forbidden",
			usagePolicy: "do_not_use",
			confidencePolicy: {
				minForGeneration: 1,
				minForValidation: 1,
				allowPathOnly: false
			},
			conflictPolicy: "ignore"
		},
		{
			id: "rule_requirement",
			name: "规则要求",
			aliases: [
				"规则要求",
				"变更说明",
				"实施范围",
				"对象范围",
				"结构化数据范围"
			],
			category: "compliance",
			cardinality: "multiple",
			derivationPolicy: "source_only",
			usagePolicy: "use_if_relevant",
			confidencePolicy: {
				minForGeneration: .6,
				minForValidation: .7,
				allowPathOnly: false
			},
			conflictPolicy: "allow_multiple"
		}
	];
	COMMON_FORBIDDEN_PATTERNS = [/投标报价|报价明细|单价|合价|综合单价|预留金|暂列金额|税率|增值税|利润|结算/u];
	COMMON_DIAGNOSTIC_PATTERNS = [
		/OCR|识别错误|乱码|无法确认|疑似|不确定|绑定片段|兜底|知识库|提示词|后台|文件路径|PDF|DWG|Excel/u,
		/^#+\s*/u,
		/^见(?:招标|投标人|前附|补疑|图纸|清单|文件|资料|公告|须知)/u
	];
	COMMON_LOW_CONFIDENCE_PATTERNS = [/无法确认|疑似|不确定|需复核|文字模糊|语义断裂|识别错误|乱码/u];
	DEFAULT_DOCUMENT_DOMAIN_PROFILE = {
		id: "default_general_document",
		name: "通用文档",
		factFields: DEFAULT_FACT_FIELDS,
		forbiddenValuePatterns: COMMON_FORBIDDEN_PATTERNS,
		diagnosticValuePatterns: COMMON_DIAGNOSTIC_PATTERNS,
		lowConfidenceValuePatterns: COMMON_LOW_CONFIDENCE_PATTERNS
	};
	({ ...DEFAULT_DOCUMENT_DOMAIN_PROFILE });
}));
//#endregion
//#region apps/server/src/services/document-workflow/factsModel.ts
var init_factsModel = __esmMin((() => {
	init_kbService();
	init_documentDomainProfileService();
	init_factMatching();
	init_llmClient();
	init_semanticSimilarity();
	init_evidenceContentSafety();
})), SUPPORT_FORM_LEXICON;
var init_factGovernance = __esmMin((() => {
	init_factsModel();
	init_workflowRules();
	SUPPORT_FORM_LEXICON = [
		{
			pattern: /土钉/u,
			form: "土钉墙"
		},
		{
			pattern: /锚杆|锚索/u,
			form: "锚杆支护"
		},
		{
			pattern: /喷锚/u,
			form: "喷锚支护"
		},
		{
			pattern: /放坡/u,
			form: "放坡开挖"
		},
		{
			pattern: /地下连续墙/u,
			form: "地下连续墙"
		},
		{
			pattern: /支护桩/u,
			form: "支护桩"
		}
	];
	new RegExp(SUPPORT_FORM_LEXICON.map((item) => item.pattern.source).join("|"), "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/projectBasicInfo.ts
var init_projectBasicInfo = __esmMin((() => {
	init_factsModel();
	init_factGovernance();
	init_markdownCleanup();
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/evidenceRetrieval.ts
var init_evidenceRetrieval = __esmMin((() => {
	init_evidence();
	init_factsModel();
	init_projectBasicInfo();
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/factCoverage.ts
var init_factCoverage = __esmMin((() => {
	init_factsModel();
	init_projectBasicInfo();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterPostProcessing.ts
var init_chapterPostProcessing = __esmMin((() => {
	init_evidence();
	init_factsModel();
	init_outline$1();
	init_writingSpec();
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/diagnostics.ts
var init_diagnostics = __esmMin((() => {
	init_templateStore();
	init_chapterPostProcessing();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentGeneratorHelpers.ts
var init_documentGeneratorHelpers = __esmMin((() => {
	init_evidenceRetrieval();
	init_factCoverage();
	init_projectBasicInfo();
	init_markdownCleanup();
	init_diagnostics();
})), DRAWING_SIGNATURE_PATTERN;
var init_poolNoise = __esmMin((() => {
	DRAWING_SIGNATURE_PATTERN = "专用章|出图|设计研究总院|工程设计(?:甲|乙|丙)级|资质证书|证书编号";
	new RegExp(DRAWING_SIGNATURE_PATTERN, "u");
	new RegExp(DRAWING_SIGNATURE_PATTERN, "gu");
}));
var init_tenderRequirements = __esmMin((() => {
	init_llmClient();
	init_generatedDocumentService();
	init_factsModel();
	init_evidenceContentSafety();
	init_markdownComposer();
	init_poolNoise();
	[
		docSystemPrefix("你是招标文件条款判定器。"),
		"输入是从招标资料（招标文件/补疑/答疑等）中按原文顺序切分的条款单元（含全局序号与来源）。",
		"对每一条独立完成判定，且必须为每一条给出结果（不得遗漏任何序号）。",
		"",
		"1. isRequirement：该条是否构成对投标人的实质要求（需写入正文响应或必须遵守）？",
		"   - true：明确的目标/等级/标准/参数/义务/禁止性要求（确保、达到、不低于、不得、严禁、必须、应当等约束语义）",
		"   - false：目录、章节导语、说明性/解释性文字、空白表头、格式模板、无约束力的描述",
		"   - 边界判例（格式模板 vs 结构呈现要求）：表格填写/签章格式/装订份数类模板说明 → false；",
		"     「组织机构以框图方式表示」「采用文字并结合图表形式编制」「附网络图、横道图」等呈现形态要求 → true（呈现信息同时进入 structures 通道）",
		"   - 孤立碎片（无问题上下文的「回复：××」「答：××」、表格残片、无法独立理解的半截句）→ false（reason=\"non_requirement\"）",
		"   - 问答对（「问题：×× … 回复：××」）：答复含实质要求（指标/标准/义务/禁止性内容）→ true（按答复内容给出 policy/coreTerms）；纯程序性答复（「按招标文件执行」「详见补遗」）→ false",
		"   - 条款值被明确标注「无」「☑无」「不适用」「/」时 → isRequirement=false（reason=\"no_value\"）",
		"   - 工程量清单条目、项目特征描述、工程量数据不是本通道要求（由清单蓝图通道处理）→ false",
		"2. inScope：该条是否属于施工组织设计正文的职责范围？",
		"   - true：质量/工期/安全/环保目标、创优奖项、绿色建筑/智慧工地/装配式等级、体系基准（六个百分百/四节一环保等）、",
		"     工期与进度约束、人员配置与分包限制、材料工艺与验收标准、禁止性事项、必须遵守的技术约束",
		"   - false：纯投标程序事务（开标时间地点/保证金账户信息/递交解密方式/评标委员会组成）、投标资格条件",
		"     （营业执照/资质证书/业绩要求）、评标否决规则（否决其投标/废标情形）、商务纪律承诺（廉洁承诺）、格式签章要求、",
		"     商务与造价条款（付款/进度款/工程款/结算/保证金/违约金/保函/预付款/税金/税率/报价/综合单价/暂列金额/暂估价/限价/调差等，",
		"     属商务标响应内容，技术标正文不出现）、",
		"     合同履约管理程序条款（施工合同通用/专用条款及合同附件的程序性与责任性约定：资料报送/审批/备案期限、",
		"     违约责任与违约金罚款明细、人员请假/更换/离场批准程序、保险投保办理程序、工程质量保修书程序与保修期限明细、",
		"     试验条件自理、工程照管责任起止、治安保卫程序、分包审批程序、采购与评标程序——属合同管理范畴，技术标正文不逐条抄写；",
		"     但质量/安全/文明/工期目标、人员资格与配置、技术工艺与验收标准类实质要求仍按 true 判定）",
		"3. policy（isRequirement 且 inScope 时必填，其余省略）：",
		"   - \"respond\"：必须在正文显性写出的要求（创优目标/奖项、质量目标、等级指标、体系基准、技术工艺条款、人员与分包约束、验收标准）",
		"   - \"comply\"：不逐条抄写但全文必须遵守的约束（以开工令为准的日期约束、工期总日历天数基准、全局禁止性事项）",
		"4. coreTerms：2-4 个用于正文核对的核心词（专有名词/等级名/体系名/关键数字参数，如「××杯」「二星级」「六个百分百」「300万元」）；",
		"   数字参数必须保留数字与单位；不要泛化词（「施工」「工程」类不能作为核心词）；",
		"   必须是正文中可自然逐字出现的完整词/短语（括号/标点保持原文形态），不得使用去标点拼接的短语碎片或合同填空语言（如「承包人自理」）",
		"5. category：按招标语义命名类别（如「质量创优」「工期进度」「安全文明」「绿色施工」「人员管理」「商务支付」「禁止性要求」），",
		"   同类要求使用同一类别名",
		"6. structures：该条是否明文要求内容的呈现形态？命中时输出数组（element 呈现对象名 + form 形态），无呈现要求时省略该字段：",
		"   - form 枚举：“org_chart”（框图/组织机构图/组织结构图）、“diagram”（网络图/横道图/平面布置图/进度计划图）、“table”（表格/组成表）、“chart_text”（文字结合图表/图表形式编制）",
		"   - element：呈现对象的名词短语（如「项目管理机构」「施工总平面布置」「施工进度计划」），不得与原文无关",
		"   - 边界判例：「组织机构以框图方式表示」→ [{element:\"项目管理机构\",form:\"org_chart\"}]；「采用文字并结合图表形式编制」→ [{element:\"施工组织设计\",form:\"chart_text\"}]；",
		"     纯格式填写说明/签章装订要求（按给定格式填写并盖章/正副本份数）→ 不输出 structures",
		"   - 呈现要求与 isRequirement/inScope 判定相互独立：即使本条因程序/格式原因被判排除，structures 仍须输出",
		"",
		"isRequirement=false 或 inScope=false 时须给出 reason（枚举）：",
		"- \"non_requirement\"：非约束性内容（目录/导语/说明/描述）",
		"- \"out_of_scope\"：超出施组职责（投标程序/资格/评标规则/纪律/格式/商务与造价/合同履约管理程序）",
		"- \"no_value\"：条款值为「无」或不适用",
		"",
		"输出 JSON 结构（覆盖全部序号，每序号必出结果）：",
		"{ \"results\": [",
		"  { \"index\": 0, \"isRequirement\": true, \"inScope\": true, \"policy\": \"respond\", \"coreTerms\": [\"××杯\", \"300万元\"], \"category\": \"质量创优\" },",
		"  { \"index\": 1, \"isRequirement\": false, \"inScope\": false, \"reason\": \"out_of_scope\" },",
		"  { \"index\": 2, \"isRequirement\": false, \"inScope\": false, \"reason\": \"out_of_scope\", \"structures\": [{ \"element\": \"项目管理机构\", \"form\": \"org_chart\" }] }",
		"] }",
		"只返回 JSON。"
	].join("\n");
	[
		docSystemPrefix("你是招标要求章责分配器。"),
		"输入是语义路由置信度偏低的技术标要求条目与本文档全部章节标题列表。",
		"为每条要求裁决其唯一主责章节（写该章节正文时必须响应此要求），逐条必出结果（不得遗漏序号）。",
		"",
		"- chapter：从章节标题列表中选择内容最匹配的一项，必须与列表原文逐字一致",
		"- chapter 填 \"none\"：该条不是可写入技术标正文的实质要求（无问题上下文的残片/客套答复/程序性说明），或没有任何章节能承载其内容",
		"",
		"输出 JSON：{ \"results\": [ { \"index\": 0, \"chapter\": \"章节标题或none\" } ] }，只返回 JSON。"
	].join("\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/deterministicFixChains.ts
var init_deterministicFixChains = __esmMin((() => {
	init_documentIntegrityChecks();
	init_resourceBreakdownNumbers();
	init_markdownComposer();
	init_internalTerminologyAnchors();
	init_documentGeneratorHelpers();
	init_tenderRequirements();
})), FULL_VALIDATION_DETECTORS, STANDARD_FINAL_DETECTORS, AUXILIARY_DETECTORS, PATCH_GUARD_DETECTOR_IDS;
var init_detectorFixerRegistry = __esmMin((() => {
	init_factGovernance();
	init_documentIntegrityChecks();
	init_deterministicFixChains();
	FULL_VALIDATION_DETECTORS = [
		{
			id: "spec-gate-rules",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "auto-spec-validation",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "fact-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "project-contamination",
			scope: "full-document",
			category: "scope"
		},
		{
			id: "project-basic-placeholder",
			scope: "full-document",
			category: "format"
		},
		{
			id: "standard-final",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "fact-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "page-target",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "document-budget",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "formal-text-gate",
			scope: "full-document",
			category: "format"
		},
		{
			id: "heading-uncovered-engineering-items",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "writer-missing-section",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "critical-section-depth",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "critical-section-fact-density",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "chapter-fact-density",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "construction-org-professional-audit",
			scope: "chapter",
			category: "professional_chain"
		}
	];
	STANDARD_FINAL_DETECTORS = [
		{
			id: "toc-consistency",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "section-numbering",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "section-count-overflow",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "heading-duplicate",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "structure-integrity",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "templated-label",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "title-integrity",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "evaluation-criteria-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "requirements-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "fabricated-start-date",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "field-value-mismatch",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "area-arithmetic",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "resource-consistency",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["laborPeak"]
		},
		{
			id: "node-schedule-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "cross-section-numeric-conflict",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "fact-reconciliation",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "greening-maintenance-mismatch",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["greeningMaintenance"]
		},
		{
			id: "street-light-count-mismatch",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "spec-location-mismatch",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "blueprint-citation-consistency",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "cross-project-value-copy",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "phase-labor-mixing",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "equipment-batch-conflict",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "preliminary-action-timing",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "foundation-form-residue",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "ambiguous-either-or",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["supportSystem"]
		},
		{
			id: "excavation-depth-lock",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "excavation-hazard-classification",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "support-form-fact-consistency",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["supportSystem"]
		},
		{
			id: "equipment-entry-timing",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "fabricated-award",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "bidder-qualification-section",
			scope: "full-document",
			category: "scope"
		},
		{
			id: "cross-chapter-duplicate-section",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "basic-info-schedule-field",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "duplicate-table",
			scope: "full-document",
			category: "table"
		},
		{
			id: "duplicate-paragraph",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "paragraph-tail-repeat",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "collision-numbered-heading",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "inverted-date-range",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "resource-triad-section-hierarchy",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "support-system-conflict",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["supportSystem"]
		},
		{
			id: "dangerous-list-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "hazard-exclusion-contradiction",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "six-hundred-percent-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "self-undermining-candidate",
			scope: "full-document",
			category: "style"
		},
		{
			id: "paragraph-opening-repeat",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "flow-form-repeat",
			scope: "full-document",
			category: "style"
		},
		{
			id: "skeleton-fingerprint",
			scope: "full-document",
			category: "style"
		},
		{
			id: "sentence-pattern-repeat",
			scope: "full-document",
			category: "style"
		},
		{
			id: "repeated-word",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "commercial-data-in-body",
			scope: "full-document",
			category: "scope"
		},
		{
			id: "overview-recap",
			scope: "full-document",
			category: "style"
		},
		{
			id: "closure-phrase-density-cap",
			scope: "full-document",
			category: "style"
		},
		{
			id: "parameter-concept-conflict",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "internal-terminology-anchor",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "construction-system-coverage",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "dangerous-applicability",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "innovation-tech-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "instruction-like-heading",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "formal-heading-hierarchy",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "formal-content-integrity",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "punctuation-artifact",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "table-quality",
			scope: "full-document",
			category: "table",
			deterministicSafe: true
		},
		{
			id: "table-spam",
			scope: "full-document",
			category: "table",
			deterministicSafe: true
		},
		{
			id: "basis-regulations-coverage",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "basis-regulations-cross",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "resource-breakdown-consistency",
			scope: "full-document",
			category: "fact_consistency",
			authorities: ["blueprint"]
		},
		{
			id: "section-content-integrity",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "professional-content",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "professional-score",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "generic-professional-content",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "management-measure-number",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "closed-loop-density",
			scope: "full-document",
			category: "control_loop"
		},
		{
			id: "cross-chapter-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "process-spec-conflict",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "evidence-usage-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "paragraph-generic",
			scope: "full-document",
			category: "style"
		},
		{
			id: "construction-org-generic-language",
			scope: "chapter",
			category: "style"
		},
		{
			id: "construction-org-control-loop",
			scope: "chapter",
			category: "control_loop"
		},
		{
			id: "construction-org-professional-chain",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "construction-org-consistency",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "construction-org-chapter-data-coverage",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "construction-org-major-content",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "construction-org-division-section",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "major-content-governance",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "construction-org-bonus-module",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "chapter-dependency",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "document-delivery-score",
			scope: "full-document",
			category: "professional_chain"
		},
		{
			id: "generated-fact-verification",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "numeric-traceability",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "table-arithmetic-consistency",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "duplicate-basic-info",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "formal-style",
			scope: "full-document",
			category: "style"
		},
		{
			id: "tertiary-heading",
			scope: "full-document",
			category: "structure",
			deterministicSafe: true
		},
		{
			id: "min-chapter-section",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "precise-fact-usage",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "parameter-obligation-usage",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "boq-placement",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "stage-phrasing",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "emergency-section-depth",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "boq-row-trace",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "drawing-reference",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "web-evidence-leakage",
			scope: "full-document",
			category: "scope"
		},
		{
			id: "formal-placeholder",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "prompt-example-leak",
			scope: "full-document",
			category: "format"
		},
		{
			id: "degenerate-content",
			scope: "chapter",
			category: "style"
		},
		{
			id: "planned-auto-spec-gate",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "bid-composition-body-table",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "bid-composition-body-figure",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "identity-marks-forbidden",
			scope: "full-document",
			category: "format"
		},
		{
			id: "planned-structure",
			scope: "full-document",
			category: "structure"
		},
		{
			id: "table-caption",
			scope: "full-document",
			category: "format"
		},
		{
			id: "prompt-document-rule",
			scope: "full-document",
			category: "format"
		},
		{
			id: "local-adaptation-keyword",
			scope: "full-document",
			category: "evidence_coverage"
		},
		{
			id: "boq-division-coverage",
			scope: "full-document",
			category: "evidence_coverage"
		}
	];
	AUXILIARY_DETECTORS = [
		{
			id: "authority-audit-gap",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "important-unplaced-facts",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "table-plan-execution",
			scope: "chapter",
			category: "table"
		},
		{
			id: "templating-filler",
			scope: "full-document",
			category: "style"
		},
		{
			id: "templating-difficulty",
			scope: "full-document",
			category: "professional_chain"
		},
		{
			id: "workpackage-skeleton",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "planned-section-completeness",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "global-consistency-review",
			scope: "full-document",
			category: "fact_consistency"
		},
		{
			id: "source-enumeration",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "meta-discourse-declaration",
			scope: "full-document",
			category: "style",
			deterministicSafe: true
		},
		{
			id: "finish-thickness",
			scope: "full-document",
			category: "fact_consistency",
			deterministicSafe: true
		},
		{
			id: "formula-residue",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "truncated-sentence",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "atlas-reference-phrase",
			scope: "full-document",
			category: "format",
			deterministicSafe: true
		},
		{
			id: "block-structure-contract",
			scope: "chapter",
			category: "structure"
		},
		{
			id: "block-fact-density",
			scope: "chapter",
			category: "evidence_coverage"
		},
		{
			id: "block-templating",
			scope: "chapter",
			category: "style"
		},
		{
			id: "block-attribution-quantification",
			scope: "chapter",
			category: "professional_chain"
		},
		{
			id: "block-numeric-reconciliation",
			scope: "chapter",
			category: "fact_consistency"
		},
		{
			id: "block-format-constraints",
			scope: "chapter",
			category: "format"
		}
	];
	PATCH_GUARD_DETECTOR_IDS = [
		"source-enumeration",
		"internal-terminology-anchor",
		"fabricated-start-date",
		"repeated-word",
		"writer-missing-section",
		"meta-discourse-declaration",
		"formula-residue",
		"finish-thickness",
		"formal-placeholder",
		"truncated-sentence"
	];
	[...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS], [...PATCH_GUARD_DETECTOR_IDS];
	[
		...FULL_VALIDATION_DETECTORS,
		...STANDARD_FINAL_DETECTORS,
		...AUXILIARY_DETECTORS
	];
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/rebuildFacts.ts
var init_rebuildFacts = __esmMin((() => {
	init_evidence();
	init_factsModel();
	init_factGovernance();
	init_documentIntegrityChecks();
	init_integratedBlueprint();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterParameterFacts.ts
var init_chapterParameterFacts = __esmMin((() => {
	init_factsModel();
	init_poolNoise();
}));
//#endregion
//#region apps/server/src/services/document-workflow/keyFactPlacement.ts
var init_keyFactPlacement = __esmMin((() => {
	init_factGovernance();
	init_factsModel();
	init_factCoverage();
}));
//#endregion
//#region apps/server/src/services/document-validation/factConsistencyService.ts
var init_factConsistencyService = __esmMin((() => {
	init_documentDomainProfileService();
}));
//#endregion
//#region apps/server/src/services/document-workflow/authorityAudit.ts
var init_authorityAudit = __esmMin((() => {
	init_documentFactTrace();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/numericVerification.ts
var init_numericVerification = __esmMin((() => {
	init_rolePipeline();
	init_evidence();
	init_documentFactTrace();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constructionOrgProjectTypes.ts
var init_constructionOrgProjectTypes = __esmMin((() => {
	init_outline$1();
})), CONSTRUCTION_ORG_GENERIC_PHRASES;
var init_constructionOrgQualityRules = __esmMin((() => {
	init_constructionOrgProjectTypes();
	init_writingSpec();
	init_semanticGate();
	CONSTRUCTION_ORG_GENERIC_PHRASES = [
		"精心组织",
		"科学管理",
		"精益求精",
		"全力保障",
		"高效推进",
		"力争一流",
		"最大限度",
		"显著提升",
		"大力落实",
		"充分确保",
		"严格把控"
	];
	new RegExp(CONSTRUCTION_ORG_GENERIC_PHRASES.join("|"), "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentDeliveryReport.ts
var init_documentDeliveryReport = __esmMin((() => {
	init_qualityValidation();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constructionOrgConsistency.ts
var init_constructionOrgConsistency = __esmMin((() => {
	init_resourceBreakdownNumbers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/parameterConceptConflicts.ts
/** 概念归一化：去除单位词与标点后仅保留概念词面 */
function normalizeConcept(concept) {
	return concept.replace(/(?:mm|cm|m|MPa|kN|kV|kW|℃|元|万元|人|天|日|个|层|樘|处|套|台|t|吨)/gu, "").replace(/[\s,，、；;：:（）()]/gu, "");
}
function dot(left, right) {
	const length = Math.min(left.length, right.length);
	let sum = 0;
	for (let index = 0; index < length; index += 1) sum += left[index] * right[index];
	return sum;
}
/** 出现位所在句文本（r18 B2 总量分解句豁免）：向前/后扩至句界（。；; 换行），无边界时取到文首/文尾 */
function sentenceTextAt(markdown, index) {
	const marks = [
		"。",
		"；",
		";",
		"\n"
	];
	let start = 0;
	for (const mark of marks) {
		const at = markdown.lastIndexOf(mark, index - 1);
		if (at + 1 > start) start = at + 1;
	}
	let end = markdown.length;
	for (const mark of marks) {
		const at = markdown.indexOf(mark, index);
		if (at >= 0 && at < end) end = at;
	}
	return markdown.slice(start, end);
}
/** 值文本在完整匹配内的偏移定位（prefix 字符类可含数字，「3号塑料管3m」类 indexOf 会误中前缀数字）：
* 优先从单位反向回溯（数字与单位紧邻、允许空白），失败回退首个同文本命中 */
function locateValueOffset(matchText, valueText, unitText) {
	if (!unitText) return matchText.indexOf(valueText);
	const unitAt = matchText.lastIndexOf(unitText);
	if (unitAt >= 0) {
		const direct = unitAt - valueText.length;
		if (direct >= 0 && matchText.slice(direct, unitAt) === valueText) return direct;
		const loose = new RegExp(`(${valueText.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")})\\s*$`, "u").exec(matchText.slice(0, unitAt));
		if (loose && loose.index !== void 0) return loose.index;
	}
	return matchText.indexOf(valueText);
}
function extractParamTokens(markdown) {
	const tokenByRaw = /* @__PURE__ */ new Map();
	let lineStart = 0;
	for (const line of markdown.split("\n")) {
		const trimmed = line.trim();
		const currentLineStart = lineStart;
		lineStart += line.length + 1;
		if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) continue;
		for (const match of line.matchAll(new RegExp(PARAM_TOKEN_RE.source, "gu"))) {
			let prefix = (match[1] || "").trim();
			let valueText = match[2];
			const trailingDigits = /\d+$/u.exec(prefix);
			if (trailingDigits) {
				prefix = prefix.slice(0, trailingDigits.index).trim();
				valueText = `${trailingDigits[0]}${valueText}`;
			}
			const value = Number(valueText);
			const unit = match[3] || "";
			const suffixRaw = (match[4] || "").trim();
			const embeddedItem = /[与和及][^与和及]{0,12}?\d/u.exec(suffixRaw);
			const suffix = embeddedItem ? suffixRaw.slice(0, embeddedItem.index) : suffixRaw;
			const rawConcept = `${prefix}${suffix}`.replace(/[\s,，、；;：:]/gu, "");
			const strippedConcept = rawConcept.replace(CONCEPT_LEAD_IN_RE, "").replace(CONCEPT_TASK_DEADLINE_RE, "");
			const concept = strippedConcept.length >= 2 ? strippedConcept : rawConcept;
			if (concept.length < 2 || !/[\u4e00-\u9fa5A-Za-z]{2,}/u.test(concept) || !Number.isFinite(value) || value <= 0) continue;
			if (GENERIC_MEASURE_WORDS.some((word) => normalizeConcept(concept) === word)) continue;
			if (BARE_RELATION_WORDS.some((word) => normalizeConcept(concept) === word)) continue;
			if (CONCEPT_BLACKLIST_RE.test(concept)) continue;
			if (VARIANT_QUALIFIER_RE.test(concept)) continue;
			const occurrence = {
				matchIndex: currentLineStart + (match.index || 0),
				valueOffset: locateValueOffset(match[0], valueText, match[3] || ""),
				valueText
			};
			const existing = tokenByRaw.get(match[0]);
			if (existing) {
				existing.occurrences.push(occurrence);
				continue;
			}
			tokenByRaw.set(match[0], {
				concept,
				value,
				unit,
				raw: match[0],
				occurrences: [occurrence]
			});
		}
	}
	return [...tokenByRaw.values()].slice(0, 60);
}
/** 并查集：两两语义相似 ≥0.6 的概念合并为同簇（自组织聚类） */
function clusterConcepts(concepts, similarity) {
	const parent = new Map(concepts.map((concept) => [concept, concept]));
	const find = (node) => {
		const root = parent.get(node) || node;
		return root === node ? node : (parent.set(node, find(root)), parent.get(node) || node);
	};
	const union = (left, right) => {
		parent.set(find(left), find(right));
	};
	for (let left = 0; left < concepts.length; left += 1) for (let right = left + 1; right < concepts.length; right += 1) if (similarity(concepts[left], concepts[right]) >= .6) union(concepts[left], concepts[right]);
	return parent;
}
/**
* 冲突组扫描（4.27.0 从 parameterConceptConflictIssues 抽出，行为保持）：
* L1 正则提取 → bge 概念自组织聚类 → 同簇同单位显著差异判定，返回结构化冲突组。
* 检测端（message 生成）与 A1 裁决器（三分支替换/降级）共用同一扫描口径（检测定位=修复定位）。
*/
async function conceptConflictGroups(markdown) {
	const tokens = extractParamTokens(markdown);
	if (tokens.length < 3) return { groups: [] };
	const concepts = [...new Set(tokens.map((token) => token.concept))];
	if (concepts.length < 2) return { groups: [] };
	const vectors = await getLocalSemanticProvider().embedDocuments(concepts);
	if (vectors.length !== concepts.length) {
		const detail = `本地语义模型嵌入数量不一致：期望 ${concepts.length} 条，实际 ${vectors.length} 条`;
		console.warn(`[gen] parameter-concept-conflict degraded: ${detail}`);
		return {
			groups: [],
			degraded: {
				level: "warning",
				severity: "warning",
				category: "format",
				owner: "system",
				repairability: "manual_review",
				message: `参数概念口径冲突检测已降级跳过：${detail}`,
				suggestion: "语义模型输出异常，本轮未执行该检测维度；可稍后重新生成复核。"
			}
		};
	}
	const vectorOf = new Map(concepts.map((concept, index) => [concept, vectors[index]]));
	const similarity = (left, right) => {
		const leftVector = vectorOf.get(left);
		const rightVector = vectorOf.get(right);
		if (!leftVector || !rightVector || leftVector.length === 0 || rightVector.length === 0) return 0;
		return dot(leftVector, rightVector);
	};
	const parent = clusterConcepts(concepts, similarity);
	const find = (node) => {
		let current = node;
		while ((parent.get(current) || current) !== current) current = parent.get(current) || current;
		return current;
	};
	const clusters = /* @__PURE__ */ new Map();
	for (const token of tokens) {
		const root = find(token.concept);
		const group = clusters.get(root) || [];
		group.push(token);
		clusters.set(root, group);
	}
	const groups = [];
	for (const group of clusters.values()) {
		if (group.length < 2) continue;
		if (Math.max(...group.map((token) => token.value)) > Math.min(...group.map((token) => token.value)) * 4) continue;
		const byUnit = /* @__PURE__ */ new Map();
		for (const token of group) {
			const unitGroup = byUnit.get(token.unit) || [];
			unitGroup.push(token);
			byUnit.set(token.unit, unitGroup);
		}
		for (const unitGroupAll of byUnit.values()) {
			if (unitGroupAll.length < 2) continue;
			const byDimension = /* @__PURE__ */ new Map();
			for (const token of unitGroupAll) {
				const dimension = CONCEPT_DIMENSION_WORDS.find((word) => token.raw.includes(word)) || "";
				const bucket = byDimension.get(dimension) || [];
				bucket.push(token);
				byDimension.set(dimension, bucket);
			}
			const unitGroups = [...byDimension.keys()].filter((key) => key !== "").length >= 2 && !byDimension.has("") ? [...byDimension.values()] : [unitGroupAll];
			for (const unitGroup of unitGroups) {
				if (unitGroup.length < 2) continue;
				const actions = unitGroup.map((token) => CONCEPT_ACTION_WORDS.find((word) => token.raw.includes(word)) || "");
				if (actions.length >= 2 && actions.every((action) => action !== "") && new Set(actions).size === actions.length) continue;
				const instanceMatches = unitGroup.map((token) => /^([\u4e00-\u9fa5]{2,})([一二三四五六七八九十]|\d+)$/u.exec(token.concept)).filter((match) => match !== null);
				if (instanceMatches.length === unitGroup.length && instanceMatches.length >= 2 && new Set(instanceMatches.map((match) => match[1])).size === 1 && new Set(instanceMatches.map((match) => match[2])).size === instanceMatches.length) continue;
				const perEveryBases = unitGroup.map((token) => {
					const at = token.raw.indexOf("按每");
					return at >= 0 ? token.raw.slice(0, at) : null;
				});
				if (perEveryBases.every((basis) => basis !== null)) {
					if (!perEveryBases.some((left, leftIndex) => Boolean(left) && perEveryBases.some((right, rightIndex) => leftIndex !== rightIndex && Boolean(right) && (left === right || left.includes(right) || right.includes(left))))) continue;
				}
				if (unitGroup.every((token) => token.occurrences.some((occurrence) => /违约金|解除合同|提高至|自第|逾期超过/u.test(markdown.slice(Math.max(0, occurrence.matchIndex - 30), occurrence.matchIndex + token.raw.length + 40))))) continue;
				const values = [...new Set(unitGroup.map((token) => token.value))];
				if (values.length < 2) continue;
				const maxValue = Math.max(...values);
				if (maxValue - Math.min(...values) <= maxValue * .02) continue;
				const valuesSum = values.reduce((sum, value) => sum + value, 0);
				if ([...new Set(unitGroup.flatMap((token) => token.occurrences.map((occurrence) => sentenceTextAt(markdown, occurrence.matchIndex))))].some((sentence) => /(?:总量|合计|总计|共计)/u.test(sentence) && /(?:其中|分别为|分为)/u.test(sentence) && unitGroup.every((token) => token.occurrences.some((occurrence) => sentenceTextAt(markdown, occurrence.matchIndex) === sentence)) && [...sentence.matchAll(/\d+(?:\.\d+)?/gu)].some((match) => Math.abs(Number(match[0]) - valuesSum) <= Math.max(.5, valuesSum * .01)))) continue;
				if (unitGroup.filter((token) => token.occurrences.some((occurrence) => {
					const after = markdown.slice(occurrence.matchIndex, occurrence.matchIndex + token.raw.length + 12);
					const before = markdown.slice(Math.max(0, occurrence.matchIndex - 12), occurrence.matchIndex);
					return /[、/](?:与)?[A-Za-z]?\d/u.test(after) || /[、/](?:与)?[A-Za-z]?\d/u.test(before);
				})).length >= 2) continue;
				if (unitGroup.length >= 2 && unitGroup.every((left, leftIndex) => unitGroup.every((right, rightIndex) => {
					if (leftIndex >= rightIndex) return true;
					if (left.value === right.value) return true;
					const shorterConcept = left.concept.length <= right.concept.length ? left.concept : right.concept;
					const longerConcept = left.concept.length <= right.concept.length ? right.concept : left.concept;
					if (shorterConcept.length >= 4 && shorterConcept.length < longerConcept.length && longerConcept.endsWith(shorterConcept) && /^[板梁柱墙底顶]/u.test(shorterConcept)) return true;
					const span = longestCommonHanSubstringSpan(left.concept, right.concept);
					if (span.length < 2) return false;
					const common = left.concept.slice(span.start, span.end);
					const leftRest = left.concept.replace(common, "");
					const rightRest = right.concept.replace(common, "");
					return leftRest.length > 0 && rightRest.length > 0 && !leftRest.includes(rightRest) && !rightRest.includes(leftRest);
				}))) continue;
				groups.push({
					concept: unitGroup[0].concept,
					values: unitGroup
				});
				if (groups.length >= 4) break;
			}
			if (groups.length >= 4) break;
		}
		if (groups.length >= 4) break;
	}
	return { groups };
}
/** 清单单位文本归一（参数 token 单位捕获对 m²/m³ 截尾，须从 raw 原文回取后归一） */
function normalizeUnitToken(unit) {
	return unit.replace(/㎡/gu, "m2").replace(/m²/giu, "m2").replace(/m³/giu, "m3").replace(/\s+/gu, "").toLowerCase();
}
/** token 的原文单位文本（值文本之后紧邻）：如 raw="马圩组46.7m²" → "m²" */
function rawUnitOf(value) {
	const first = value.occurrences[0];
	if (!first) return value.unit;
	const at = value.raw.indexOf(first.valueText);
	if (at < 0) return value.unit;
	return value.raw.slice(at + first.valueText.length) || value.unit;
}
function normalizeLockName(text) {
	return text.replace(/[（(][^）)]*[）)]/gu, "").replace(/[\s,，、；;：:]/gu, "");
}
/** 条目名与概念相关：完全相等，或较长者包含较短者（较短 ≥3 字防两字短名误配） */
function lockNameRelated(entryName, concept) {
	const name = normalizeLockName(entryName);
	const target = normalizeLockName(concept);
	if (name.length < 2 || target.length < 2) return false;
	if (name === target) return true;
	const shorter = name.length <= target.length ? name : target;
	const longer = name.length <= target.length ? target : name;
	return shorter.length >= 3 && longer.includes(shorter);
}
/** 值 → 清单条目命中（数额精确相等[相对容差 0.1%] + 单位兼容 + 语境相关[条目名/村组出现在值邻近窗口]）。
* r9：ctx.entries 可显式覆盖枚举池（蓝图伪条目与清单锁条目并池，裁决源扩展用） */
function lockEntriesForConceptValue(value, ctx) {
	const entries = ctx.entries ?? ctx.billFactLock?.entries ?? [];
	if (entries.length === 0) return [];
	const tolerance = Math.max(.01, value.value * .001);
	const unitText = normalizeUnitToken(rawUnitOf(value));
	const windows = value.occurrences.map((occurrence) => ctx.markdown.slice(Math.max(0, occurrence.matchIndex - 48), occurrence.matchIndex + occurrence.valueOffset + occurrence.valueText.length + 48)).join("\n");
	const matched = [];
	for (const entry of entries) {
		if (!Number.isFinite(entry.quantity) || entry.quantity <= 0) continue;
		if (Math.abs(entry.quantity - value.value) > tolerance) continue;
		const entryUnit = normalizeUnitToken(entry.unit);
		if (unitText && entryUnit && unitText !== entryUnit) continue;
		const nameRelated = lockNameRelated(entry.name, value.concept);
		const villageRelated = entry.villageGroup.trim().length >= 2 && windows.includes(entry.villageGroup.trim());
		if (!nameRelated && !villageRelated) continue;
		matched.push({
			entry,
			nameRelated
		});
		if (matched.length >= 8) break;
	}
	return matched;
}
/** 蓝图参数桶 → 伪清单条目（r9 扩围：第二裁决源）。仅参与分支①（各值分属不同口径=误报降级）
* 的命中判定，不作分支②单锚锁值来源——蓝图聚合/分组值硬替换正文风险高于收益（宁交 LLM）。
* 伪条目 seq 在蓝图池内自增（少量重叠无影响——互斥检查为同源语义，非全局唯一性保证）。 */
function blueprintPseudoEntries(quantities) {
	if (!quantities) return [];
	const entries = [];
	let seq = 1;
	const pushEntry = (name, quantity, unit, sourceFile, villageGroup) => {
		entries.push({
			seq,
			name,
			description: "",
			quantity,
			unit,
			section: "",
			subsection: villageGroup,
			villageGroup,
			sourceFile,
			specQuantityPairs: []
		});
		seq += 1;
	};
	for (const [name, item] of Object.entries(quantities)) {
		const unit = item.unit || "";
		const sourceFile = item.sourceFile || "";
		if (Number.isFinite(item.value) && item.value > 0) pushEntry(name, item.value, unit, sourceFile, "");
		for (const group of item.groups || []) {
			if (!Number.isFinite(group.value) || group.value <= 0) continue;
			pushEntry(`${name}（${group.group}）`, group.value, unit, sourceFile, group.group);
		}
	}
	return entries;
}
/** 单组三分支裁决（纯函数；两裁决源均缺失时恒无锚→分支③，与历史行为一致）。
* r9 扩围（r9 实机 #9 归因：正文两合法口径被概念聚类误报冲突）：裁决池 = 清单锁条目（唯一
* 锁值来源）+ 蓝图参数桶伪条目（仅分支①命中依据）——「塑料管铺设 8205.53m/7525.01m」两值
* 各自命中蓝图 DN200/DN110 口径 → 分支①降级，不再裸坠 LLM 修复轮。 */
function arbitrateConceptGroup(group, ctx) {
	if (group.values.length < 2) return { verdict: "no-anchor" };
	const billEntries = ctx.billFactLock?.entries ?? [];
	const pseudoEntries = blueprintPseudoEntries(ctx.blueprintQuantities);
	if (billEntries.length === 0 && pseudoEntries.length === 0) return { verdict: "no-anchor" };
	const hits = group.values.map((value) => ({
		value,
		matches: lockEntriesForConceptValue(value, {
			markdown: ctx.markdown,
			entries: [...billEntries, ...pseudoEntries]
		}),
		billMatches: lockEntriesForConceptValue(value, {
			markdown: ctx.markdown,
			entries: billEntries
		})
	}));
	if (hits.every((hit) => hit.matches.length > 0)) {
		if (hits.every((left, leftIndex) => hits.every((right, rightIndex) => leftIndex === rightIndex || !left.matches.some((leftMatch) => right.matches.some((rightMatch) => rightMatch.entry.seq === leftMatch.entry.seq))))) return {
			verdict: "distinct-lock-entries",
			entries: hits.map((hit) => `「${hit.matches[0].entry.name}」（${hit.value.value}${hit.value.unit}）`).join("、")
		};
	}
	const anchored = hits.filter((hit) => hit.billMatches.length > 0);
	const unanchored = hits.filter((hit) => hit.matches.length === 0);
	if (anchored.length === 1 && unanchored.length > 0 && anchored.length + unanchored.length === hits.length) {
		const best = anchored[0].billMatches.find((match) => match.nameRelated);
		if (best) return {
			verdict: "single-lock-entry",
			lockValue: best.entry.quantity,
			lockUnit: best.entry.unit,
			entryName: best.entry.name,
			nonLock: unanchored.map((hit) => hit.value)
		};
	}
	return { verdict: "no-anchor" };
}
async function parameterConceptConflictIssues(markdown, opts) {
	const scan = await conceptConflictGroups(markdown);
	if (scan.degraded) return [scan.degraded];
	if (scan.groups.length === 0) return [];
	const blocking = [];
	const acquitted = [];
	for (const group of scan.groups) {
		const arbitration = arbitrateConceptGroup(group, {
			markdown,
			billFactLock: opts?.billFactLock,
			blueprintQuantities: opts?.blueprintQuantities
		});
		if (arbitration.verdict === "distinct-lock-entries") acquitted.push({
			group,
			entries: arbitration.entries
		});
		else blocking.push(group);
	}
	const issues = [];
	if (blocking.length > 0) {
		const conflicts = blocking.map((group) => `“${group.concept}”出现多个口径：${[...new Set(group.values.map((value) => value.raw))].slice(0, 3).join("、")}`);
		issues.push({
			level: "error",
			severity: "blocker",
			category: "fact_consistency",
			owner: "llm",
			repairability: "llm_repairable",
			message: `同一参数概念出现多口径数值冲突：${conflicts.join("；")}`,
			suggestion: "以绑定资料（图纸/清单/规范）裁决口径为准统一数值表述：每个参数概念全文只保留一个口径数值，删除矛盾表述。"
		});
	}
	if (acquitted.length > 0) issues.push({
		level: "info",
		severity: "suggestion",
		category: "fact_consistency",
		owner: "system",
		repairability: "not_repair_needed",
		message: `参数概念多口径已裁决为不同清单条目口径（不构成冲突）：${acquitted.map(({ group, entries }) => `“${group.concept}”对应${entries}`).join("；")}`,
		suggestion: "各数值分别对应不同的工程量清单条目，正文已带条目名区分，无需处理。"
	});
	return issues;
}
var PARAM_TOKEN_RE, GENERIC_MEASURE_WORDS, BARE_RELATION_WORDS, CONCEPT_LEAD_IN_RE, CONCEPT_TASK_DEADLINE_RE, CONCEPT_BLACKLIST_RE, VARIANT_QUALIFIER_RE, CONCEPT_ACTION_WORDS, CONCEPT_DIMENSION_WORDS;
var init_parameterConceptConflicts = __esmMin((() => {
	init_semanticSimilarity();
	init_numericalConsistency();
	PARAM_TOKEN_RE = /([\u4e00-\u9fa5A-Za-z0-9（）()]{1,12}?)(\d+(?:\.\d+)?)\s*(m²|m³|㎡|mm|cm|m|米|MPa|kN|kV|kW|℃|°C|万元|元|人|天|日|个|层|樘|处|套|台|t|吨)([\u4e00-\u9fa5A-Za-z0-9（）()]{0,8})/gu;
	GENERIC_MEASURE_WORDS = [
		"直径",
		"厚度",
		"宽度",
		"长度",
		"高度",
		"深度",
		"间距",
		"距离",
		"标高",
		"偏差",
		"数量",
		"面积",
		"体积",
		"重量",
		"压力",
		"温度",
		"强度",
		"等级",
		"坡度",
		"规格",
		"尺寸",
		"层数",
		"次数",
		"跨度",
		"半径",
		"总长",
		"全长"
	];
	BARE_RELATION_WORDS = [
		"以内",
		"以外",
		"以上",
		"以下",
		"之间",
		"左右",
		"以前",
		"以后",
		"之前",
		"之后"
	];
	CONCEPT_LEAD_IN_RE = /^(?:主要|本工程|本项目|全项目)?(?:作业对象|作业内容|施工内容|工作内容|工程内容|施工对象|施工范围|工程规模|建设内容|建设规模)为/u;
	CONCEPT_TASK_DEADLINE_RE = /^(?:由)?责任[\u4e00-\u9fa5]{0,4}在(?:内)?完成/u;
	CONCEPT_BLACKLIST_RE = /自然村|村组|标段|区域|点位|养护|地上|地下|建筑高度|[\u4e00-\u9fa5]{1,4}组$/u;
	VARIANT_QUALIFIER_RE = /^(?:局部|个别|少数|多数|大部分)/u;
	CONCEPT_ACTION_WORDS = [
		"开挖",
		"封闭",
		"回填",
		"浇筑",
		"铺筑",
		"摊铺",
		"供应",
		"编制",
		"提交",
		"签订",
		"安装",
		"养护",
		"试验",
		"拆除",
		"砌筑"
	];
	CONCEPT_DIMENSION_WORDS = [
		"直径",
		"半径",
		"穴径",
		"胸径",
		"地径",
		"冠幅",
		"厚度",
		"宽度",
		"长度",
		"高度",
		"深度",
		"穴深",
		"间距",
		"距离",
		"标高",
		"坡度",
		"跨度",
		"株距",
		"行距"
	];
}));
//#endregion
//#region apps/server/src/services/document-workflow/stagePhrasing.ts
var init_stagePhrasing = __esmMin((() => {
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/emergencySectionDepth.ts
var init_emergencySectionDepth = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
}));
//#endregion
//#region apps/server/src/services/document-workflow/basisRegulationsCross.ts
var init_basisRegulationsCross = __esmMin((() => {
	init_qualityValidation();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentFinalValidation.ts
var init_documentFinalValidation = __esmMin((() => {
	init_qualityValidation();
	init_constructionOrgQualityRules();
	init_documentFactTrace();
	init_documentDeliveryReport();
	init_markdownComposer();
	init_constructionOrgConsistency();
	init_documentIntegrityChecks();
	init_semanticSimilarity();
	init_tenderRequirements();
	init_internalTerminologyAnchors();
	init_parameterConceptConflicts();
	init_chapterParameterFacts();
	init_stagePhrasing();
	init_emergencySectionDepth();
	init_outline$1();
	init_integratedBlueprint();
	init_detectorFixerRegistry();
	init_basisRegulationsCross();
}));
//#endregion
//#region apps/server/src/services/document-workflow/narrativeContext.ts
var init_narrativeContext = __esmMin((() => {
	init_tenderBidChecks();
})), FORBIDDEN_EMPTY_PHRASES;
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
//#region apps/server/src/services/document-workflow/evaluationCriteriaMapping.ts
var init_evaluationCriteriaMapping = __esmMin((() => {
	init_semanticSimilarity();
	init_qualityValidation();
	init_narrativeContext();
	init_tenderBidScoring();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentQualityReport.ts
var init_documentQualityReport = __esmMin((() => {
	init_tenderBidScoring();
	init_constructionOrgTablePlan();
	init_drawingFactLock();
	init_markdownComposer();
	init_tenderRequirements();
	init_qualityValidation();
	init_detectors();
	init_evaluationCriteriaMapping();
	init_basisRegulationsCross();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentRepairStrategies.ts
var init_documentRepairStrategies = __esmMin((() => {
	init_documentFactTrace();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentEvidenceRetrieval.ts
var init_documentEvidenceRetrieval = __esmMin((() => {
	init_evidence();
	init_factMatching();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constructionProcessKnowledge.ts
var PROCESS_KNOWLEDGE_CARDS, CARD_BY_ALIAS, CARD_BY_ID;
var init_constructionProcessKnowledge = __esmMin((() => {
	PROCESS_KNOWLEDGE_CARDS = [
		{
			id: "earthwork-excavation",
			name: "土方开挖",
			aliases: [
				"土方",
				"基坑开挖",
				"土方开挖",
				"挖土"
			],
			process: [
				"测量放线",
				"标高复核",
				"分层开挖",
				"边坡修整",
				"基底验槽"
			],
			params: [
				"分层开挖厚度≤2m",
				"基底标高偏差0~-50mm",
				"边坡坡度按土质取1:0.5~1:1",
				"预留200~300mm人工清底"
			],
			acceptance: [
				"基底验槽",
				"钎探记录",
				"标高与轴线复核",
				"隐蔽验收记录"
			],
			standards: ["GB 50202-2018 建筑地基基础工程施工质量验收标准"]
		},
		{
			id: "earthwork-backfill",
			name: "土方回填",
			aliases: [
				"素土回填",
				"填土碾压",
				"回填",
				"余方弃置",
				"人工清底"
			],
			process: [
				"基底隐蔽验收",
				"分层摊铺",
				"分层碾压",
				"压实度检测",
				"边角补夯",
				"表面整平"
			],
			params: [
				"每层虚铺厚度≤300mm",
				"填土含水率控制在最优含水率±2%",
				"压实系数≥0.94",
				"边角部位采用小型夯实机补夯",
				"压实度每层每100m²不少于1组检测"
			],
			acceptance: [
				"压实度检测报告",
				"回填土施工记录",
				"隐蔽验收记录"
			],
			standards: ["GB 50202-2018 建筑地基基础工程施工质量验收标准", "GB 50268-2008 给水排水管道工程施工及验收规范"]
		},
		{
			id: "foundation-pit-support",
			name: "基坑支护",
			aliases: [
				"基坑支护",
				"钢板桩",
				"土钉墙",
				"支护桩",
				"冠梁"
			],
			process: [
				"测量定位",
				"支护桩成孔",
				"钢筋笼制安",
				"混凝土浇筑",
				"冠梁施工",
				"分层开挖",
				"位移监测"
			],
			params: [
				"桩位偏差≤50mm",
				"垂直度≤1%",
				"冠梁顶标高偏差±10mm",
				"监测频率：开挖期每天1次",
				"报警值按设计位移速率3mm/d"
			],
			acceptance: [
				"桩身完整性检测",
				"锚杆拉拔试验",
				"基坑监测日报",
				"专项方案审批记录"
			],
			standards: ["JGJ 120-2012 建筑基坑支护技术规程", "GB 50497-2019 建筑基坑工程监测技术标准"]
		},
		{
			id: "pile-foundation",
			name: "桩基工程",
			aliases: [
				"桩基",
				"钻孔灌注桩",
				"预制桩",
				"静压桩",
				"PHC管桩"
			],
			process: [
				"测量定位",
				"成孔（压桩）",
				"清孔验收",
				"钢筋笼制安",
				"混凝土灌注",
				"桩身检测"
			],
			params: [
				"桩径偏差±5mm",
				"沉渣厚度≤50mm（端承桩）",
				"充盈系数≥1.0",
				"桩顶标高偏差±10mm",
				"静载试验不少于总桩数1%且≥3根"
			],
			acceptance: [
				"桩基静载试验",
				"低应变/声波透射检测",
				"成孔记录",
				"钢筋隐蔽验收"
			],
			standards: ["JGJ 94-2008 建筑桩基技术规范", "GB 50202-2018"]
		},
		{
			id: "rebar-works",
			name: "钢筋工程",
			aliases: [
				"钢筋",
				"钢筋绑扎",
				"钢筋加工",
				"钢筋连接"
			],
			process: [
				"翻样下料",
				"加工成型",
				"运输堆放",
				"绑扎安装",
				"隐蔽验收"
			],
			params: [
				"直螺纹接头拧紧力矩值按规格控制",
				"接头错开≥35d且≥500mm",
				"保护层垫块间距≤1m",
				"绑扎搭接长度按图集16G101"
			],
			acceptance: [
				"钢筋原材复试",
				"接头工艺检验",
				"隐蔽工程验收记录",
				"保护层实测"
			],
			standards: ["GB 50204-2015 混凝土结构工程施工质量验收规范", "JGJ 18-2012 钢筋焊接及验收规程"]
		},
		{
			id: "formwork-works",
			name: "模板工程",
			aliases: [
				"模板",
				"模板支撑",
				"高支模",
				"脚手架模板"
			],
			process: [
				"方案编制",
				"立杆搭设",
				"主次龙骨铺设",
				"面板安装",
				"验收挂牌",
				"拆模申请"
			],
			params: [
				"立杆间距≤900×900mm（危大）",
				"扫地杆距地≤200mm",
				"水平杆步距≤1500mm",
				"剪刀撑连续设置",
				"拆模强度：板≥75%设计强度"
			],
			acceptance: [
				"高支模专项方案论证",
				"架体验收挂牌",
				"沉降变形监测",
				"拆模令"
			],
			standards: ["JGJ 162-2008 建筑施工模板安全技术规范", "JGJ 130-2011 建筑施工扣件式钢管脚手架安全技术规范"]
		},
		{
			id: "concrete-works",
			name: "混凝土工程",
			aliases: [
				"混凝土",
				"砼浇筑",
				"混凝土浇筑",
				"振捣"
			],
			process: [
				"浇筑申请",
				"坍落度检测",
				"分层浇筑",
				"振捣密实",
				"收面养护",
				"试块留置"
			],
			params: [
				"坍落度按配比±30mm",
				"分层浇筑厚度≤500mm",
				"振动棒快插慢拔",
				"养护≥7d（掺外加剂≥14d）",
				"标养试块每100m³≥1组"
			],
			acceptance: [
				"坍落度检测记录",
				"试块标养与同条件报告",
				"混凝土外观检查",
				"强度评定"
			],
			standards: ["GB 50204-2015", "GB/T 50107-2010 混凝土强度检验评定标准"]
		},
		{
			id: "steel-structure",
			name: "钢结构工程",
			aliases: [
				"钢结构",
				"钢构件",
				"焊接",
				"高强螺栓"
			],
			process: [
				"深化设计",
				"构件加工",
				"进场验收",
				"吊装就位",
				"校正固定",
				"焊接/螺栓连接",
				"涂装"
			],
			params: [
				"高强螺栓初拧终拧扭矩比1.1",
				"焊缝等级按设计一级/二级",
				"挠度允许值L/400",
				"防火涂料厚度按耐火极限"
			],
			acceptance: [
				"焊缝探伤检测",
				"高强螺栓扭矩检查",
				"构件尺寸偏差实测",
				"防火涂料厚度检测"
			],
			standards: ["GB 50205-2020 钢结构工程施工质量验收标准", "JGJ 82-2011 钢结构高强度螺栓连接技术规程"]
		},
		{
			id: "masonry-works",
			name: "砌体工程",
			aliases: [
				"砌体",
				"砌筑",
				"加气块",
				"二次结构"
			],
			process: [
				"弹线定位",
				"排砖撂底",
				"砌筑",
				"构造柱植筋",
				"圈梁浇筑",
				"顶砖处理"
			],
			params: [
				"灰缝厚度8~12mm",
				"垂直度偏差≤5mm（每层）",
				"拉结筋间距≤500mm",
				"顶砖间隔7d斜砌"
			],
			acceptance: [
				"砌筑砂浆试块",
				"构造柱钢筋隐蔽验收",
				"垂直度平整度实测",
				"拉结筋检测"
			],
			standards: ["GB 50203-2011 砌体结构工程施工质量验收规范"]
		},
		{
			id: "waterproofing",
			name: "防水工程",
			aliases: [
				"防水",
				"屋面防水",
				"卫生间防水",
				"地下防水",
				"卷材"
			],
			process: [
				"基层处理",
				"阴阳角附加层",
				"防水层铺贴",
				"搭接密封",
				"闭水/淋水试验",
				"保护层"
			],
			params: [
				"卷材搭接宽度≥100mm",
				"附加层宽度≥500mm",
				"卫生间闭水试验48h",
				"屋面蓄水试验24h",
				"涂膜厚度按设计≥1.5mm"
			],
			acceptance: [
				"闭水/蓄水试验记录",
				"隐蔽验收记录",
				"防水材料复试",
				"淋水试验"
			],
			standards: ["GB 50207-2012 屋面工程质量验收规范", "GB 50208-2011 地下防水工程质量验收规范"]
		},
		{
			id: "plastering",
			name: "抹灰工程",
			aliases: [
				"抹灰",
				"粉刷",
				"墙面抹灰",
				"挂网"
			],
			process: [
				"基层处理",
				"浇水湿润",
				"打点冲筋",
				"分层抹灰",
				"压光",
				"养护"
			],
			params: [
				"不同基体交接处挂网宽≥200mm",
				"每遍抹灰厚度≤7mm",
				"平整度偏差≤4mm",
				"空鼓面积≤400cm²且不连续"
			],
			acceptance: [
				"空鼓敲击检查",
				"平整度垂直度实测",
				"养护记录"
			],
			standards: ["GB 50210-2018 建筑装饰装修工程质量验收标准"]
		},
		{
			id: "tile-paving",
			name: "墙地砖铺贴",
			aliases: [
				"墙地砖",
				"瓷砖",
				"铺贴",
				"石材"
			],
			process: [
				"基层检查",
				"排砖放线",
				"选砖泡水",
				"铺贴",
				"勾缝",
				"成品保护"
			],
			params: [
				"粘结层厚度≤10mm",
				"接缝宽度按设计要求",
				"空鼓率单块≤15%且整面≤5%",
				"平整度偏差≤2mm"
			],
			acceptance: [
				"空鼓锤击检查",
				"平整度实测",
				"坡度泼水检查",
				"成品保护验收"
			],
			standards: ["GB 50210-2018"]
		},
		{
			id: "ceil-partition",
			name: "吊顶与轻质隔墙",
			aliases: [
				"吊顶",
				"轻钢龙骨",
				"隔墙",
				"石膏板"
			],
			process: [
				"弹线定位",
				"龙骨安装",
				"面板安装",
				"接缝处理",
				"面层施工"
			],
			params: [
				"主龙骨间距≤1200mm",
				"吊杆间距≤1000mm",
				"罩面板接缝错开",
				"石膏板接缝处粘贴网格布"
			],
			acceptance: [
				"龙骨隐蔽验收",
				"面板平整度实测",
				"吊顶起拱检查"
			],
			standards: ["GB 50210-2018"]
		},
		{
			id: "painting",
			name: "涂饰工程",
			aliases: [
				"涂料",
				"油漆",
				"乳胶漆",
				"腻子"
			],
			process: [
				"基层清理",
				"刮腻子",
				"打磨",
				"底漆",
				"面漆",
				"修整"
			],
			params: [
				"腻子每遍厚度≤2mm",
				"底漆1遍面漆2遍",
				"施工温度5~35℃",
				"平整度偏差≤2mm"
			],
			acceptance: [
				"涂层色泽均匀检查",
				"无流坠起皮检查",
				"平整度实测"
			],
			standards: ["GB 50210-2018"]
		},
		{
			id: "door-window",
			name: "门窗工程",
			aliases: [
				"门窗",
				"铝合金窗",
				"幕墙",
				"玻璃"
			],
			process: [
				"洞口复核",
				"安装固定",
				"缝隙填塞",
				"打胶密封",
				"开启调试",
				"淋水试验"
			],
			params: [
				"框与墙间隙≤5mm",
				"密封胶连续饱满",
				"窗扇开关力≤50N",
				"气密水密性能按设计等级"
			],
			acceptance: [
				"淋水试验",
				"开启灵活检查",
				"垂直度偏差实测",
				"性能检测报告"
			],
			standards: ["GB 50210-2018", "GB/T 7106-2019 建筑外门窗气密水密抗风压性能检测方法"]
		},
		{
			id: "plumbing",
			name: "给排水工程",
			aliases: [
				"给排水",
				"给水管道",
				"排水管道",
				"管道安装"
			],
			process: [
				"预留预埋",
				"支架安装",
				"管道安装",
				"压力试验",
				"冲洗消毒",
				"通水试验"
			],
			params: [
				"给水管试验压力为工作压力1.5倍且≥0.6MPa",
				"排水管坡度按管径DN50~DN200取2.5%~0.8%",
				"支架间距按管径设置",
				"PPR热熔温度260℃"
			],
			acceptance: [
				"管道水压试验",
				"通球试验",
				"灌水试验",
				"冲洗消毒记录"
			],
			standards: ["GB 50242-2002 建筑给水排水及采暖工程施工质量验收规范"]
		},
		{
			id: "electrical",
			name: "电气工程",
			aliases: [
				"电气",
				"配管",
				"穿线",
				"桥架",
				"配电箱",
				"防雷接地"
			],
			process: [
				"预留预埋",
				"配管桥架",
				"穿线放缆",
				"设备安装",
				"绝缘测试",
				"通电调试"
			],
			params: [
				"管路弯曲半径≥6D（埋地≥10D）",
				"导线绝缘电阻≥0.5MΩ",
				"桥架支架间距≤1.5m",
				"防雷接地电阻≤1Ω"
			],
			acceptance: [
				"绝缘电阻测试",
				"接地电阻测试",
				"通电试运行",
				"隐蔽验收记录"
			],
			standards: ["GB 50303-2015 建筑电气工程施工质量验收规范"]
		},
		{
			id: "hvac",
			name: "通风空调工程",
			aliases: [
				"通风空调",
				"风管",
				"空调",
				"新风",
				"保温"
			],
			process: [
				"风管制作",
				"吊架安装",
				"风管安装",
				"设备安装",
				"严密性试验",
				"系统调试"
			],
			params: [
				"风管支吊架间距≤3m",
				"中压风管漏光法检测",
				"保温层厚度按设计",
				"风口风速按设计值±10%"
			],
			acceptance: [
				"风管严密性试验",
				"风量平衡调试",
				"设备单机试运行",
				"系统联动调试"
			],
			standards: ["GB 50243-2016 通风与空调工程施工质量验收规范"]
		},
		{
			id: "fire-protection",
			name: "消防工程",
			aliases: [
				"消防",
				"消火栓",
				"喷淋",
				"火灾报警",
				"防排烟"
			],
			process: [
				"预留预埋",
				"管道安装",
				"喷头/探测器安装",
				"系统试压",
				"联动调试",
				"检测验收"
			],
			params: [
				"喷淋试验压力≥1.4MPa",
				"消火栓充实水柱≥10m",
				"探测器保护半径按类别",
				"防排烟风管严密性"
			],
			acceptance: [
				"消防水压试验",
				"联动调试记录",
				"消防检测报告",
				"竣工验收备案"
			],
			standards: ["GB 50261-2017 自动喷水灭火系统施工及验收规范", "GB 50166-2019 火灾自动报警系统施工及验收标准"]
		},
		{
			id: "weak-current",
			name: "弱电智能化工程",
			aliases: [
				"弱电",
				"智能化",
				"综合布线",
				"监控",
				"门禁"
			],
			process: [
				"管线预埋",
				"桥架敷设",
				"线缆敷设",
				"设备安装",
				"单机调试",
				"系统联调"
			],
			params: [
				"双绞线弯曲半径≥4D",
				"光缆弯曲半径≥15D",
				"面板安装高度距地300mm",
				"链路测试按TIA-568"
			],
			acceptance: [
				"链路测试报告",
				"单机调试记录",
				"系统联调记录",
				"隐蔽验收"
			],
			standards: ["GB 50311-2016 综合布线系统工程设计规范", "GB 50339-2013 智能建筑工程质量验收规范"]
		},
		{
			id: "municipal-road",
			name: "道路工程",
			aliases: [
				"道路",
				"路基",
				"路面",
				"水稳",
				"沥青"
			],
			process: [
				"测量放线",
				"路基处理",
				"分层碾压",
				"水稳摊铺",
				"沥青摊铺",
				"标线设施"
			],
			params: [
				"路基压实度≥93%（路床）",
				"水稳层7d无侧限抗压强度按设计",
				"沥青压实度≥96%",
				"面层平整度≤5mm（3m直尺）"
			],
			acceptance: [
				"压实度检测",
				"弯沉检测",
				"取芯厚度检测",
				"平整度实测"
			],
			standards: ["CJJ 1-2008 城镇道路工程施工与质量验收规范"]
		},
		{
			id: "municipal-pipe",
			name: "市政管道工程",
			aliases: [
				"管道",
				"雨污水",
				"沟槽",
				"检查井",
				"承插管"
			],
			process: [
				"测量放线",
				"沟槽开挖支护",
				"基础垫层",
				"管道安装",
				"接口处理",
				"闭水试验",
				"回填"
			],
			params: [
				"沟槽开挖放坡按土质1:0.33~1:0.5",
				"垫层厚度按设计≥100mm",
				"管道安装轴线偏差≤15mm",
				"闭水试验渗水量按GB 50268",
				"回填分层厚度≤250mm"
			],
			acceptance: [
				"闭水试验记录",
				"管内底高程检测",
				"管道CCTV检测",
				"回填压实度检测"
			],
			standards: ["GB 50268-2008 给水排水管道工程施工及验收规范"]
		},
		{
			id: "demolition",
			name: "拆除工程",
			aliases: [
				"拆除",
				"墙体拆除",
				"结构拆除",
				"垃圾外运"
			],
			process: [
				"方案编制",
				"围挡隔离",
				"管线切断",
				"分层拆除",
				"垃圾清运",
				"验收交接"
			],
			params: [
				"拆除顺序自上而下",
				"垃圾清运日产日清",
				"湿法作业降尘",
				"既有保留部位防护到位"
			],
			acceptance: [
				"拆除专项方案",
				"既有设施保护检查",
				"垃圾清运记录"
			],
			standards: ["JGJ 147-2016 建筑拆除工程安全技术规范"]
		},
		{
			id: "structural-strengthen",
			name: "结构加固",
			aliases: [
				"结构加固",
				"粘钢",
				"碳纤维",
				"植筋",
				"加大截面"
			],
			process: [
				"设计交底",
				"基层处理",
				"植筋",
				"粘贴加固",
				"养护",
				"检测验收"
			],
			params: [
				"植筋锚固深度按设计≥15d",
				"碳纤维布粘结强度≥2.5MPa",
				"胶粘剂固化时间按产品说明",
				"加大截面混凝土强度等级≥C25"
			],
			acceptance: [
				"拉拔试验",
				"粘结密实度检测",
				"隐蔽验收记录"
			],
			standards: ["GB 50367-2013 混凝土结构加固设计规范", "GB 50550-2010 建筑结构加固工程施工质量验收规范"]
		},
		{
			id: "facade-renovation",
			name: "外立面整治",
			aliases: [
				"外立面",
				"立面修补",
				"真石漆",
				"外保温"
			],
			process: [
				"脚手架搭设",
				"空鼓铲除",
				"界面处理",
				"保温层施工",
				"面层施工",
				"验收落架"
			],
			params: [
				"保温板粘贴面积≥40%",
				"锚栓数量每平米≥6个",
				"抗裂砂浆厚度3~5mm",
				"面层垂直度偏差≤4mm"
			],
			acceptance: [
				"粘结强度现场拉拔",
				"锚栓拉拔试验",
				"平整度实测"
			],
			standards: ["GB 50411-2019 建筑节能工程施工质量验收标准", "JGJ 144-2019 外墙外保温工程技术标准"]
		},
		{
			id: "scaffold",
			name: "脚手架工程",
			aliases: [
				"脚手架",
				"外架",
				"落地架",
				"悬挑架"
			],
			process: [
				"方案编制",
				"基础处理",
				"立杆搭设",
				"连墙件设置",
				"安全网封闭",
				"验收挂牌",
				"拆除"
			],
			params: [
				"立杆纵距≤1.5m",
				"连墙件两步三跨",
				"剪刀撑与地面夹角45°~60°",
				"悬挑架工字钢锚固长度≥1.25倍悬挑长度",
				"架体高于作业层1.5m"
			],
			acceptance: [
				"架体分段验收",
				"连墙件检查",
				"安全网封闭检查"
			],
			standards: ["JGJ 130-2011 建筑施工扣件式钢管脚手架安全技术规范"]
		},
		{
			id: "tower-crane",
			name: "起重吊装",
			aliases: [
				"起重吊装",
				"塔吊",
				"吊装",
				"汽车吊"
			],
			process: [
				"方案编制",
				"设备报验",
				"基础验收",
				"安装调试",
				"检测备案",
				"日常检查",
				"拆除"
			],
			params: [
				"吊装作业半径内警戒",
				"吊索具安全系数≥6",
				"塔吊垂直度≤4‰",
				"风速≥6级停止吊装"
			],
			acceptance: [
				"特种设备检测",
				"安装验收记录",
				"司机指挥持证检查"
			],
			standards: ["JGJ 196-2010 建筑施工塔式起重机安装使用拆卸安全技术规程"]
		},
		{
			id: "electrical-hookup",
			name: "临时用电",
			aliases: [
				"临电",
				"临时用电",
				"三级配电"
			],
			process: [
				"方案编制",
				"线路敷设",
				"配电箱设置",
				"接地保护",
				"验收送电",
				"日常巡检"
			],
			params: [
				"三级配电两级漏保",
				"漏电动作电流≤30mA/0.1s",
				"PE线截面按相线1/2",
				"电缆埋深≥0.7m",
				"配电箱距地1.4~1.6m"
			],
			acceptance: [
				"绝缘电阻测试",
				"接地电阻测试",
				"验收送电记录"
			],
			standards: ["JGJ 46-2005 施工现场临时用电安全技术规范"]
		}
	];
	CARD_BY_ALIAS = /* @__PURE__ */ new Map();
	CARD_BY_ID = /* @__PURE__ */ new Map();
	for (const card of PROCESS_KNOWLEDGE_CARDS) {
		CARD_BY_ID.set(card.id, card);
		CARD_BY_ALIAS.set(card.name, card);
		for (const alias of card.aliases) CARD_BY_ALIAS.set(alias, card);
	}
}));
//#endregion
//#region apps/server/src/services/document-workflow/tableRepairHelpers.ts
var init_tableRepairHelpers = __esmMin((() => {
	init_markdownCleanup();
}));
//#endregion
//#region apps/server/src/services/document-workflow/blockQualityExecutors.ts
var init_blockQualityExecutors = __esmMin((() => {
	init_markdownComposer();
	init_tenderBidChecks();
})), ENGINEERING_OBJECT_SUFFIXES;
var init_chapterGeneration = __esmMin((() => {
	init_evidence();
	init_markdownComposer();
	init_llmClient();
	init_rolePipeline();
	init_promptRuleExtraction();
	init_constructionOrgTablePlan();
	init_bidComposition();
	init_constructionOrgQualityRules();
	init_constructionProcessKnowledge();
	init_integratedBlueprint();
	init_chapterPostProcessing();
	init_tableRepairHelpers();
	init_detectorFixerRegistry();
	init_blockQualityExecutors();
	init_semanticGate();
	init_documentFactTrace();
	init_writingSpec();
	init_chapterPostProcessing();
	ENGINEERING_OBJECT_SUFFIXES = [
		"村",
		"社区",
		"小区",
		"家园",
		"片区",
		"工区",
		"标段"
	];
	ENGINEERING_OBJECT_SUFFIXES.map((suffix) => new RegExp(`[\\u4e00-\\u9fa5A-Za-z0-9]{1,6}${suffix}`, "gu"));
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterReview.ts
var init_chapterReview = __esmMin((() => {
	init_llmClient();
	init_chapterGeneration();
	init_markdownComposer();
})), FILLER_PARAGRAPH_PATTERNS;
var init_constructionOrgAudit = __esmMin((() => {
	init_markdownCleanup();
	init_semanticGate();
	init_tenderBidChecks();
	FILLER_PARAGRAPH_PATTERNS = [
		{
			pattern: /本小节围绕.+展开，结合绑定项目资料/u,
			label: "模板化开篇套话"
		},
		{
			pattern: /明确适用范围、控制目标、责任岗位与过程要求/u,
			label: "泛化目标罗列"
		},
		{
			pattern: /实施前应完成资料核对、技术交底和作业条件确认/u,
			label: "泛化前置条件"
		},
		{
			pattern: /交底覆盖率按\s*100%?\s*控制/u,
			label: "空泛交底承诺"
		},
		{
			pattern: /关键问题在\s*24\s*小时内形成整改责任/u,
			label: "空泛整改时限"
		},
		{
			pattern: /按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织/u,
			label: "通用闭环套话"
		},
		{
			pattern: /按作业条件确认→技术交底→过程实施→自检互检→整改复查/u,
			label: "通用流程套话"
		},
		{
			pattern: /依据本项目已确认资料中的项目边界/u,
			label: "资料依据套话"
		},
		{
			pattern: /执行日巡查、周复核和节点验收制度/u,
			label: "泛化巡查制度"
		},
		{
			pattern: /一般问题\s*7\s*日内闭环/u,
			label: "泛化整改时限"
		},
		{
			pattern: /由项目经理、技术负责人和专职安全员联合复核/u,
			label: "岗位名单堆砌"
		},
		{
			pattern: /确保与总体施工部署、工期计划和验收要求保持一致/u,
			label: "原则性呼应"
		},
		{
			pattern: /结合现场实际情况(?:，|,)?合理(?:组织|安排|布置|配置)/u,
			label: "结合实际套话"
		},
		{
			pattern: /严格(?:执行|落实|按照)国家(?:现行)?(?:有关)?(?:规范|标准|规程)/u,
			label: "规范泛引用"
		},
		{
			pattern: /做到(?:文明施工|安全生产|质量第一|安全第一)/u,
			label: "口号式承诺"
		},
		{
			pattern: /(?:确保|保证)工程(?:质量|安全|进度|文明施工)/u,
			label: "目标口号"
		},
		{
			pattern: /建立(?:健全)?(?:完善)?(?:的)?(?:管理)?体系(?:和|，)?(?:落实|确保|保证)/u,
			label: "体系空话"
		}
	];
	new RegExp(FILLER_PARAGRAPH_PATTERNS.map((item) => `(?:${item.pattern.source})`).join("|"), "u");
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/rebuildAndRecompute.ts
var init_rebuildAndRecompute = __esmMin((() => {
	init_chapterParameterFacts();
	init_keyFactPlacement();
	init_factConsistencyService();
	init_markdownComposer();
	init_bidComposition();
	init_qualityValidation();
	init_documentIntegrityChecks();
	init_internalTerminologyAnchors();
	init_authorityAudit();
	init_numericVerification();
	init_documentFinalValidation();
	init_documentFactTrace();
	init_documentQualityReport();
	init_documentRepairStrategies();
	init_documentEvidenceRetrieval();
	init_factGovernance();
	init_agentWorkflow();
	init_chapterGeneration();
	init_chapterReview();
	init_documentGeneratorHelpers();
	init_constructionOrgTablePlan();
	init_tenderRequirements();
	init_constructionOrgAudit();
	init_blockQualityExecutors();
	init_detectorFixerRegistry();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/factLanding.ts
var init_factLanding = __esmMin((() => {
	init_rolePipeline();
	init_documentGeneratorHelpers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/numericConflictArbiter.ts
var init_numericConflictArbiter = __esmMin((() => {
	init_documentIntegrityChecks();
	init_parameterConceptConflicts();
}));
//#endregion
//#region apps/server/src/services/document-workflow/dataConsistencyReview.ts
var init_dataConsistencyReview = __esmMin((() => {
	init_llmClient();
	init_markdownComposer();
	init_integratedBlueprint();
}));
//#endregion
//#region apps/server/src/services/document-workflow/globalQualityGates.ts
var init_globalQualityGates = __esmMin((() => {
	init_semanticSimilarity();
	init_documentIntegrityChecks();
	init_numericConflictArbiter();
	init_integratedBlueprint();
	init_qualityValidation();
	init_promptRuleExtraction();
	init_chapterReview();
	init_dataConsistencyReview();
	init_constructionOrgTablePlan();
	init_rolePipeline();
	init_constructionOrgAudit();
	init_tenderBidChecks();
	init_chapterPostProcessing();
	init_writingSpec();
	init_constructionOrgQualityRules();
	init_bidComposition();
	init_markdownComposer();
	init_outline$1();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/tableRepair.ts
var init_tableRepair = __esmMin((() => {
	init_rolePipeline();
	init_qualityValidation();
	init_documentGeneratorHelpers();
	init_tableRepairHelpers();
	init_bidComposition();
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/semanticChoice.ts
var init_semanticChoice = __esmMin((() => {
	init_dataConsistencyReview();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/deterministicStage5.ts
var init_deterministicStage5 = __esmMin((() => {
	init_qualityValidation();
	init_documentIntegrityChecks();
	init_integratedBlueprint();
	init_markdownComposer();
	init_deterministicFixChains();
	init_resourceBreakdownNumbers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/autoSpecGateRepair.ts
var init_autoSpecGateRepair = __esmMin((() => {
	init_qualityValidation();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/basisRegulationsRepair.ts
var init_basisRegulationsRepair = __esmMin((() => {
	init_qualityValidation();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/basisRegulationsCrossRepair.ts
var init_basisRegulationsCrossRepair = __esmMin((() => {
	init_qualityValidation();
	init_basisRegulationsCross();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/dangerousApplicabilityRepair.ts
var init_dangerousApplicabilityRepair = __esmMin((() => {
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/quotationBalanceRepair.ts
var init_quotationBalanceRepair = __esmMin((() => {
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/fiveElementClosureBoost.ts
var init_fiveElementClosureBoost = __esmMin((() => {
	init_tenderBidChecks();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/requirementResponseRepair.ts
var init_requirementResponseRepair = __esmMin((() => {
	init_rolePipeline();
	init_tenderRequirements();
	init_documentIntegrityChecks();
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/postReviewSurface.ts
var init_postReviewSurface = __esmMin((() => {
	init_documentIntegrityChecks();
	init_qualityValidation();
	init_documentFactTrace();
	init_integratedBlueprint();
	init_tableRepairHelpers();
	init_internalTerminologyAnchors();
	init_detectors();
	init_constructionOrgQualityRules();
	init_constructionOrgTablePlan();
	init_markdownComposer();
	init_bidComposition();
	init_globalQualityGates();
	init_deterministicFixChains();
	init_autoSpecGateRepair();
	init_basisRegulationsRepair();
	init_basisRegulationsCrossRepair();
	init_dangerousApplicabilityRepair();
	init_quotationBalanceRepair();
	init_fiveElementClosureBoost();
	init_fixers();
	init_requirementResponseRepair();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/factDistribution.ts
var init_factDistribution = __esmMin((() => {
	init_documentFactTrace();
	init_factsModel();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/requirementVerification.ts
var init_requirementVerification = __esmMin((() => {
	init_rolePipeline();
	init_llmClient();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/contentDepthRepair.ts
var init_contentDepthRepair = __esmMin((() => {
	init_rolePipeline();
	init_constructionOrgQualityRules();
	init_emergencySectionDepth();
	init_qualityValidation();
	init_chapterParameterFacts();
	init_drawingFactLock();
	init_documentFactTrace();
	init_detectors();
	init_rebuildAndRecompute();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/controlLoopRepair.ts
var init_controlLoopRepair = __esmMin((() => {
	init_rolePipeline();
	init_constructionOrgQualityRules();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/professionalChainRepair.ts
var init_professionalChainRepair = __esmMin((() => {
	init_rolePipeline();
	init_constructionOrgQualityRules();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/lengthCompressionRepair.ts
var init_lengthCompressionRepair = __esmMin((() => {
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/tableCaptionRepair.ts
var init_tableCaptionRepair = __esmMin((() => {
	init_rolePipeline();
	init_bidComposition();
	init_documentGeneratorHelpers();
	init_constructionOrgTablePlan();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/tableArithmeticRepair.ts
var init_tableArithmeticRepair = __esmMin((() => {
	init_rolePipeline();
	init_detectors();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/emptySectionSweep.ts
var init_emptySectionSweep = __esmMin((() => {
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/sectionAlignmentSweep.ts
var init_sectionAlignmentSweep = __esmMin((() => {
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/templatingSweep.ts
var init_templatingSweep = __esmMin((() => {
	init_documentIntegrityChecks();
	init_constructionOrgAudit();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/duplicateThemeMerge.ts
var init_duplicateThemeMerge = __esmMin((() => {
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/repairRounds/deliveryStructureClosure.ts
var init_deliveryStructureClosure = __esmMin((() => {
	init_documentIntegrityChecks();
	init_markdownCleanup();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentProfessionalScore.ts
var init_documentProfessionalScore = __esmMin((() => {
	init_constructionOrgAudit();
	init_markdownCleanup();
	init_tenderBidChecks();
	init_narrativeContext();
}));
var init_templatingReview = __esmMin((() => {
	init_llmClient();
	init_tenderBidChecks();
	init_markdownComposer();
	[
		"你是招标技术标评审专家。对施工组织设计做语义级复核，只报告确定性规则覆盖不到的语义问题。",
		"复核维度（按《施工组织设计全维度校验提示词》判定标尺）：",
		"1. 重难点三级判定：识别精准性（是否点明本项目真实难点而非泛泛而谈）→ 归因合理性（是否说明难点成因/风险来源）→ 对策匹配度（对策是否针对该难点的成因，而非通用措施堆砌）；",
		"2. 术语等效性：同一对象是否前后术语一致（如\"砼\"与\"混凝土\"混用需统一），是否出现词面不同但概念等效的双重标准表述；",
		"3. 四新技术升级价值：若正文声称采用四新技术，其价值表述是否停留在\"提升效率\"式套话，缺少可对标官方推广目录或替代落后工艺的实质说明。",
		"每条问题必须包含：问题所在内容简述+判定依据（对应上面哪条维度）+一句话改进建议。",
		"只报告真实存在的问题，正文无问题时返回空数组；不得编造问题。只返回 JSON。"
	].join("\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/finalGate.ts
var init_finalGate = __esmMin((() => {
	init_qualityValidation();
	init_documentProfessionalScore();
	init_templatingReview();
	init_documentGeneratorHelpers();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentPipeline.ts
var init_documentPipeline = __esmMin((() => {
	init_evidence();
	init_documentGeneratorHelpers();
	init_detectorFixerRegistry();
	init_rebuildFacts();
	init_rebuildAndRecompute();
	init_factLanding();
	init_tableRepair();
	init_semanticChoice();
	init_deterministicStage5();
	init_postReviewSurface();
	init_factDistribution();
	init_numericVerification();
	init_requirementResponseRepair();
	init_requirementVerification();
	init_contentDepthRepair();
	init_controlLoopRepair();
	init_professionalChainRepair();
	init_lengthCompressionRepair();
	init_tableCaptionRepair();
	init_tableArithmeticRepair();
	init_emptySectionSweep();
	init_sectionAlignmentSweep();
	init_templatingSweep();
	init_duplicateThemeMerge();
	init_deliveryStructureClosure();
	init_finalGate();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constructionBidStructure.ts
var init_constructionBidStructure = __esmMin((() => {
	init_outline$1();
	init_evidenceContentSafety();
	init_constructionOrgProjectTypes();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterDutyDeclaration.ts
var init_chapterDutyDeclaration = __esmMin((() => {
	init_outline$1();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentWritingTaskBrief.ts
var init_documentWritingTaskBrief = __esmMin((() => {
	init_constructionOrgProjectTypes();
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stageChapterLoop.ts
var init_stageChapterLoop = __esmMin((() => {
	init_outline$1();
	init_factMatching();
	init_qualityValidation();
	init_constructionBidStructure();
	init_semanticSimilarity();
	init_evidenceContentSafety();
	init_tenderRequirements();
	init_factsModel();
	init_chapterReview();
	init_chapterDutyDeclaration();
	init_documentWritingTaskBrief();
	init_agentPlanner();
	init_agentWorkflow();
	init_factGovernance();
	init_rolePipeline();
	init_documentEvidenceRetrieval();
	init_drawingFactLock();
	init_chapterParameterFacts();
	init_documentFactTrace();
	init_projectMaterialProfile();
	init_chapterGeneration();
	init_bidComposition();
	init_documentGeneratorHelpers();
	init_integratedBlueprint();
	init_documentIntegrityChecks();
	init_sectionNamingGovernance();
	init_sectionFingerprint();
	init_markdownComposer();
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stageBlueprint.ts
var init_stageBlueprint = __esmMin((() => {
	init_integratedBlueprint();
	init_drawingFactLock();
	init_tenderRequirements();
	init_documentGeneratorHelpers();
}));
var init_requirementCalibration = __esmMin((() => {
	init_llmClient();
	init_outline$1();
	init_promptRuleExtraction();
	init_evidenceContentSafety();
	init_markdownComposer();
	[
		"你是施工组织设计大纲校准专家。输入各章已有小节与招标评分项要求，只输出需要新增的小节。",
		"新增小节必须显性承接评分项要求（如\"创优目标与奖惩承诺\"\"绿色建筑等级达标专项\"\"智慧工地实施\"\"装配式专项施工方案\"），只允许新增，不得修改或删除任何已有小节。",
		"只有当前章节结构确实缺少对应承接小节时才新增；已有小节已覆盖该要求时不要重复新增。",
		"新增小节标题必须具体、可直接成稿，控制在 16 个汉字以内；不得新增与评分项要求无关的小节，不得输出条款碎片（如\"1委员会确定中\"）。",
		"只返回 JSON，不要返回 markdown。"
	].join("\n\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/reviewModuleSections.ts
var init_reviewModuleSections = __esmMin((() => {
	init_outline$1();
	init_tenderRequirements();
	init_promptRuleExtraction();
}));
//#endregion
//#region apps/server/src/services/document-workflow/factTokenClassifier.ts
var init_factTokenClassifier = __esmMin((() => {
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterIntentClassifier.ts
var init_chapterIntentClassifier = __esmMin((() => {
	init_semanticSimilarity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/professionalDepthClassifier.ts
var init_professionalDepthClassifier = __esmMin((() => {
	init_semanticSimilarity();
}));
var init_tableScopeAudit = __esmMin((() => {
	init_llmClient();
	init_markdownComposer();
	init_outline$1();
	init_promptRuleExtraction();
	[
		"你是施工组织设计表格规划范围审查专家。输入本标段招标范围判据与各章规划表格清单，逐表判断该表是否超出本标段工程范围。",
		"判定规则：",
		"1. 仅“表名实体未在判据中逐字出现”不得作为剔除依据——先做语义关联检索：表名实体与判据中的具体材料、工艺或部位是否构成上位/下位、同义或配套关系（如「外装饰材料」与判据中「真石漆/涂饰/面砖/彩绘」类具体饰面材料、附属用房的装饰与修缮类工程），存在任一关联即视为在范围内；",
		"2. 剔除需同时满足：①表名实体在招标要求与工程量清单中均无任何对应（含语义关联对应）；②按表名判断该实体明显属于与本标段工程类型不同的其他专业工程领域（如乡村基础设施标段出现高层建筑主体结构、大型工业设备安装类实体；配套附属用房的室内外装饰、局部修缮类工程不得视为不同领域）；③剔除不影响本标段工程内容的完整性；",
		"3. 标书惯例类表格（项目信息、管理措施、机构职责、制度流程、进度节点、检查记录、材料/设备报审与检验记录、汇总统计等不指向特定工程实体的表）一律保留，不得剔除；",
		"4. 判断不确定时保留（本审查宁保留不误剔）。",
		"只返回 JSON，不要返回 markdown。"
	].join("\n\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationBudget.ts
/** 按平均章节目标字数确定每章证据预算区间 */
function evidenceBudgetRange(avgChapterTarget) {
	if (avgChapterTarget >= 6e3) return {
		floorChars: 14e3,
		ceilingChars: 4e4
	};
	if (avgChapterTarget >= 3e3) return {
		floorChars: 11e3,
		ceilingChars: 28e3
	};
	return {
		floorChars: 8e3,
		ceilingChars: 18e3
	};
}
function buildGenerationBudget(input) {
	const chapterCount = Math.max(1, input.chapters.length);
	const avgChapterTargetSafe = input.targetWords > 0 ? Math.round(input.targetWords / chapterCount) : 1200;
	const strategy = input.strategy;
	const triggers = [];
	const sparse = input.materialFileCount < 4 && input.evidenceCount < 6;
	const autoChapterConcurrency = chapterCount;
	const configured = Number.isFinite(input.configuredChapterConcurrency) && input.configuredChapterConcurrency > 0 ? Math.floor(input.configuredChapterConcurrency) : void 0;
	const chapterConcurrency = Math.max(1, Math.min(chapterCount, configured ?? autoChapterConcurrency));
	const llmConcurrency = concurrencyForDocumentScale(input.targetWords);
	const reviewConcurrency = (() => {
		if (strategy.mode === "fast") return 1;
		return Math.max(1, chapterCount);
	})();
	const { floorChars, ceilingChars } = evidenceBudgetRange(avgChapterTargetSafe);
	const repairRoundBudget = (() => {
		if (strategy.repairRoundBudget) return strategy.repairRoundBudget;
		const base = 2;
		const scaleBoost = input.targetWords >= 2e4 ? 1 : 0;
		const sparseBoost = sparse ? 1 : 0;
		return Math.max(2, Math.min(4, base + scaleBoost + sparseBoost));
	})();
	const repairPoolBudget = Math.min(repairRoundBudget * chapterCount, Math.max(12, chapterCount * 2));
	if (strategy.mode === "strict") triggers.push("strict：风险领域关键词命中（专项/安全/质量/验收/合同/合规等）");
	if (input.targetWords >= 4e4) triggers.push("strict：目标篇幅超长（≥4 万字）");
	if (sparse) triggers.push("strict：资料稀疏（资料包文件 <4 且可用证据 <6 条）");
	if (strategy.mode === "fast") triggers.push("fast：小文档（≤6000 字且 ≤4 章）全局审查降级为 35% 抽检");
	if (strategy.mode === "longform") triggers.push("longform：长文档（≥3 万字或 ≥8 章）");
	if (strategy.mode === "balanced") triggers.push("balanced：常规篇幅文档，标准审查深度");
	triggers.push(`全章节并行生成（${chapterConcurrency}/${chapterCount} 章同批），审查流水线 ${reviewConcurrency} 路，全局 LLM 并发不设上限，每章证据预算 ${Math.round(floorChars / 1e3)}k-${Math.round(ceilingChars / 1e3)}k 字符，修复轮次预算每章 ${repairRoundBudget} 轮（文档级总池 ${repairPoolBudget} 轮，收敛判定优先）`);
	return {
		strategy,
		chapterConcurrency,
		reviewConcurrency,
		llmConcurrency,
		evidenceFloorChars: floorChars,
		evidenceCeilingChars: ceilingChars,
		repairRoundBudget,
		repairPoolBudget,
		triggers
	};
}
/**
* U1 生成前体检：运行前校验阶段预估生成策略与预算（目标字数为近似估算）。
* 供 validateDocumentTemplateRun 调用，注意该模块与 rolePipeline 存在依赖链，
* 引用方（templateStore）需动态 import 以避免模块环。
*/
function previewGenerationBudgetForTemplate(input) {
	const chapterCount = Math.max(1, input.chapters.length);
	const targetWords = Math.max(0, Math.round(input.targetWords ?? 0));
	const strategy = selectDocumentGenerationStrategy({
		template: input.template,
		targetWords,
		requirement: input.requirement,
		materialFileCount: input.materialFileCount,
		evidenceCount: input.evidenceCount
	});
	const budget = buildGenerationBudget({
		template: input.template,
		chapters: input.chapters,
		targetWords,
		requirement: input.requirement,
		materialFileCount: input.materialFileCount,
		evidenceCount: input.evidenceCount,
		hasVeryLargeExplicitChapter: input.hasVeryLargeExplicitChapter ?? false,
		configuredChapterConcurrency: input.configuredChapterConcurrency ?? 0,
		strategy
	});
	return {
		mode: strategy.mode,
		enableGlobalReview: strategy.enableGlobalReview,
		globalReviewSamplingRate: strategy.globalReviewSamplingRate ?? 1,
		repairRoundBudget: budget.repairRoundBudget,
		chapterConcurrency: budget.chapterConcurrency,
		reviewConcurrency: budget.reviewConcurrency,
		evidenceFloorChars: budget.evidenceFloorChars,
		evidenceCeilingChars: budget.evidenceCeilingChars,
		targetWords,
		chapterCount,
		triggers: budget.triggers
	};
}
var init_generationBudget = __esmMin((() => {
	init_rolePipeline();
	init_llmClient();
}));
//#endregion
//#region apps/server/src/services/knowledge/kbOperationLog.ts
function logPath(projectRoot) {
	return path$1.join(os$1.homedir(), ".customize-agent", "projects", computeProjectId(projectRoot), "kb-operations.jsonl");
}
function readAll(projectRoot) {
	const file = logPath(projectRoot);
	if (!fs$1.existsSync(file)) return [];
	return fs$1.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
}
function trimToRecentEntries(records) {
	if (records.length <= OPERATION_LOG_LIMIT) return records;
	const keepIds = new Set([...records].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, OPERATION_LOG_LIMIT).map((record) => record.id));
	return records.filter((record) => keepIds.has(record.id));
}
function writeAll(projectRoot, records) {
	const file = logPath(projectRoot);
	fs$1.mkdirSync(path$1.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs$1.writeFileSync(tmp, `${trimToRecentEntries(records).map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
	fs$1.renameSync(tmp, file);
	const cached = logCache.get(projectRoot);
	if (cached) cached.mtimeMs = logFileMtimeMs(file);
}
function logFileMtimeMs(file) {
	try {
		return fs$1.statSync(file).mtimeMs;
	} catch {
		return 0;
	}
}
/** 读取项目日志（含启动恢复）。文件 mtime 未变时命中内存缓存；
* 外部直接改写日志文件（如 clearKbOperations 删除文件）后 mtime 归零，同样触发重读。 */
function cachedRecords(projectRoot) {
	const file = logPath(projectRoot);
	const mtimeMs = logFileMtimeMs(file);
	const cached = logCache.get(projectRoot);
	if (cached && cached.mtimeMs === mtimeMs) return cached.records;
	const records = readAllRecovered(projectRoot);
	logCache.set(projectRoot, {
		mtimeMs: logFileMtimeMs(file),
		records
	});
	return records;
}
/**
* 读取任务日志并把“重启遗留”的 processing 记录标记为中断。
* 任务实际运行在当前进程内，日志仅持久化到磁盘；进程退出（重启/被杀）后
* 遗留的 processing 记录永远不会再被更新，前端会持续显示“有任务在跑”。
* 仅标记 updatedAt 早于本进程启动时刻的记录：本进程刚提交、正在运行的新任务
* 必须跳过，否则 worker 首条 IPC 日志触发其他 bundle 实例的首次读取时，
* 会把新任务误标为“服务重启导致任务中断”，前端轮询到 error 后弹报错。
*/
function readAllRecovered(projectRoot) {
	const records = readAll(projectRoot);
	const interrupted = records.filter((record) => record.status === "processing" && record.updatedAt < PROCESS_START_AT);
	if (interrupted.length > 0) {
		const now = Date.now();
		for (const record of interrupted) {
			record.status = "error";
			record.stage = "error";
			record.error = "服务重启导致任务中断，未完成";
			record.message = record.error;
			record.updatedAt = now;
		}
		writeAll(projectRoot, records);
	}
	return records;
}
function upsertKbOperation(projectRoot, patch) {
	const now = Date.now();
	const records = cachedRecords(projectRoot);
	const index = records.findIndex((record) => record.id === patch.id);
	const current = index >= 0 ? records[index] : void 0;
	const next = {
		id: patch.id,
		type: patch.type,
		title: patch.title,
		stage: patch.stage ?? current?.stage ?? "uploading",
		status: patch.status ?? current?.status ?? "processing",
		message: patch.message ?? current?.message ?? "",
		percent: patch.percent ?? current?.percent ?? 0,
		fileName: patch.fileName ?? current?.fileName,
		filePath: patch.filePath ?? current?.filePath,
		chunkCount: patch.chunkCount ?? current?.chunkCount,
		textLength: patch.textLength ?? current?.textLength,
		extractionMode: patch.extractionMode ?? current?.extractionMode,
		error: patch.status && patch.status !== "error" ? void 0 : patch.error ?? current?.error,
		details: patch.details ?? current?.details,
		createdAt: current?.createdAt ?? now,
		updatedAt: now
	};
	if (index >= 0) records[index] = next;
	else records.push(next);
	writeAll(projectRoot, records);
	return next;
}
var OPERATION_LOG_LIMIT, PROCESS_START_AT, logCache;
var init_kbOperationLog = __esmMin((() => {
	OPERATION_LOG_LIMIT = 200;
	PROCESS_START_AT = Math.round(Date.now() - process.uptime() * 1e3);
	logCache = /* @__PURE__ */ new Map();
}));
//#endregion
//#region apps/server/src/services/document-workflow/projectIntelligence.ts
var init_projectIntelligence = __esmMin((() => {
	init_kbService();
	init_kbOperationLog();
	init_agentWorkflow();
	init_projectGraph();
	init_chapterGeneration();
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stageOutlinePlanning.ts
var init_stageOutlinePlanning = __esmMin((() => {
	init_outline$1();
	init_factMatching();
	init_evidence();
	init_constructionBidStructure();
	init_semanticSimilarity();
	init_evidenceContentSafety();
	init_tenderRequirements();
	init_requirementCalibration();
	init_reviewModuleSections();
	init_factTokenClassifier();
	init_chapterIntentClassifier();
	init_professionalDepthClassifier();
	init_documentWritingTaskBrief();
	init_constructionOrgTablePlan();
	init_tableScopeAudit();
	init_bidComposition();
	init_llmClient();
	init_rolePipeline();
	init_generationBudget();
	init_promptRuleExtraction();
	init_documentFactTrace();
	init_documentGeneratorHelpers();
	init_projectIntelligence();
	init_sectionFingerprint();
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stageUnderstanding.ts
var init_stageUnderstanding = __esmMin((() => {
	init_outline$1();
	init_evidence();
	init_semanticSimilarity();
	init_constructionBidStructure();
	init_projectMaterialProfile();
	init_projectGraph();
	init_projectIntelligence();
	init_agentWorkflow();
	init_agentPlanner();
	init_documentGeneratorHelpers();
	init_documentEvidenceRetrieval();
	init_evidenceContentSafety();
	init_factsModel();
	init_factGovernance();
	init_tenderRequirements();
	init_bidComposition();
}));
var init_requirementSemantics = __esmMin((() => {
	init_llmClient();
	init_markdownComposer();
	[
		docSystemPrefix("你是用户生成要求的语义解析专家。"),
		"把用户的生成提示词完整解析为可逐条核验的结构化要求清单，不得遗漏用户的任何实质要求；不得把通用客套话（如\"请帮我生成\"\"谢谢\"）当作要求。",
		"要求必须逐条短句（每条 ≤60 字）、可核验（生成后能判断是否满足）；一条要求只写一件事，复合要求必须拆分。",
		"globalRequirements：全文级强制要求——写作内容、深度、覆盖面、表格、量化要求等不限定具体章节的要求；若要求明确指向某个章节，必须放入 chapterRequirements 而不是 globalRequirements。",
		"chapterRequirements：章节级要求——chapterTitle 必须原样取自给定的章节列表，不得编造不存在的章节名；同一章节的多条要求合并为一条记录。",
		"factClues：用户提示词中显式给出的项目专属事实线索——含数值、单位、规格、型号、标准编号、日期、地点、规模、金额、目标的短句（如\"一般路灯 100W 109套、120W 9套\"\"计划工期 365 日历天\"\"开挖深度 5.2m\"）；要求类语句（\"必须写X\"）不算事实线索；线索必须原样保留数值与表述，不得改写或换算。",
		"styleRequirements：写作风格与格式要求（语气、详略、表格偏好、禁止风格等），最多 8 条。",
		"只返回 JSON。"
	].join("\n");
}));
//#endregion
//#region apps/server/src/services/document-workflow/generationStages/stagePrepare.ts
var init_stagePrepare = __esmMin((() => {
	init_kbService();
	init_configService();
	init_documentRoleService();
	init_projectMaterialService();
	init_documentDomainProfileService();
	init_templateStore();
	init_outline$1();
	init_markdownComposer();
	init_promptRuleExtraction();
	init_requirementSemantics();
	init_agentWorkflow();
	init_projectMaterialProfile();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/documentGenerator.ts
var init_documentGenerator = __esmMin((() => {
	init_rolePipeline();
	init_documentPipeline();
	init_stageChapterLoop();
	init_stageBlueprint();
	init_stageOutlinePlanning();
	init_stageUnderstanding();
	init_stagePrepare();
	init_globalQualityGates();
}));
//#endregion
//#region apps/server/src/services/document-workflow/chapterExpansion.ts
var init_chapterExpansion = __esmMin((() => {
	init_evidence();
	init_markdownComposer();
}));
//#endregion
//#region apps/server/src/services/document-workflow/index.ts
var init_document_workflow = __esmMin((() => {
	init_templateStore();
	init_documentGenerator();
	init_evidence();
	init_outline$1();
	init_factMatching();
	init_markdownComposer();
	init_factsModel();
	init_qualityValidation();
	init_llmClient();
	init_rolePipeline();
	init_chapterGeneration();
	init_chapterPostProcessing();
	init_chapterReview();
	init_chapterExpansion();
	init_promptRuleExtraction();
	init_evidenceRetrieval();
	init_factCoverage();
	init_projectBasicInfo();
	init_markdownCleanup();
	init_diagnostics();
	init_documentPipeline();
	init_tableRepairHelpers();
	init_projectMaterialProfile();
	init_agentWorkflow();
	init_agentPlanner();
	init_sectionFingerprint();
}));
//#endregion
//#region apps/server/src/services/document-core/generatedDocumentService.ts
function failRunningStages(stages, message) {
	return stages?.map((stage) => stage.status === "running" ? {
		...stage,
		status: "failed",
		message
	} : stage);
}
function fallbackFailedTitle(record) {
	return record.title && record.title !== "生成中" && record.title !== "排队中" ? record.title : `${record.templateName || "文档"}生成失败`;
}
function summarizeCheckpointChapters(chapters) {
	return (chapters || []).map((chapter) => ({
		id: chapter.id,
		title: chapter.title,
		chars: documentTextLength(chapter.content),
		status: chapter.inProgress ? "in_progress" : chapter.content.trim().length > 0 ? "completed" : "failed",
		updatedAt: Date.now(),
		timedOut: chapter.timedOut,
		elapsedMs: chapter.elapsedMs
	}));
}
/** 心跳写盘保底间隔（阶段签名未变时的最小写盘间隔）：默认 30s，与中断宽限联动（宽限 clamp ≥3×心跳） */
function resolveHeartbeatSaveIntervalMs() {
	return Math.max(3e4, Math.min(3e5, Number(process.env.DOCUMENT_PROGRESS_HEARTBEAT_SAVE_INTERVAL_MS ?? 3e4)));
}
function defaultProcessAliveProbe(pid) {
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}
/** 中断判定单源（markStaleGeneratingRecord 与轮询短路 generatingRecordRequiresFullPoll 共用，杜绝口径漂移）：
* 1) 宽限期内不判；2) 有归属进程：存活→不判（跨实例保护，超 24h 兜底防 PID 复用悬挂）；已退出→立即判（process-exited）；
* 3) 无归属（升级前存量记录）：早于本进程启动→判；否则超 24h→判。 */
function evaluateStaleInterruption(input) {
	if (input.status !== "generating" && input.status !== "queued") return { stale: false };
	const now = Date.now();
	if (now - input.updatedAt < RECENT_UPDATE_GRACE_MS) return { stale: false };
	if (input.ownerPid) {
		if (processAliveProbe(input.ownerPid)) {
			if (now - input.updatedAt < ABANDONED_RECORD_STALE_MS) return { stale: false };
			return {
				stale: true,
				reason: "heartbeat-lost"
			};
		}
		return {
			stale: true,
			reason: "process-exited"
		};
	}
	if (input.updatedAt < PROCESS_STARTED_AT) return {
		stale: true,
		reason: "owner-unknown"
	};
	if (now - input.updatedAt >= ABANDONED_RECORD_STALE_MS) return {
		stale: true,
		reason: "owner-unknown"
	};
	return { stale: false };
}
function generatedProjectId(projectRoot = getProjectRoot()) {
	return computeProjectId(path.resolve(projectRoot));
}
function generatedRoot(projectRoot = getProjectRoot()) {
	const root = path.join(os.homedir(), ".customize-agent", "projects", generatedProjectId(projectRoot), "generatedDocuments");
	fs.mkdirSync(path.join(root, "drafts"), { recursive: true });
	fs.mkdirSync(path.join(root, "assets"), { recursive: true });
	return root;
}
function indexPath(projectRoot = getProjectRoot()) {
	return path.join(generatedRoot(projectRoot), "index.json");
}
function assetsPath(projectRoot = getProjectRoot()) {
	return path.join(generatedRoot(projectRoot), "assets.json");
}
function draftPath(id, projectRoot = getProjectRoot()) {
	return path.join(generatedRoot(projectRoot), "drafts", `${id}.json`);
}
function draftMetaPath(id, projectRoot = getProjectRoot()) {
	return path.join(generatedRoot(projectRoot), "drafts", `${id}.meta.json`);
}
function writeGeneratedDocumentMeta(record, projectRoot) {
	writeJson(draftMetaPath(record.id, projectRoot), {
		updatedAt: record.updatedAt,
		status: record.status,
		completedAt: record.completedAt,
		ownerPid: record.ownerPid,
		ownerStartedAt: record.ownerStartedAt
	});
}
function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}
/** 原子写 JSON：先写临时文件再 rename，避免进程崩溃时写坏一半的 draft/index 文件 */
function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
	fs.renameSync(tmp, file);
}
function getActiveTaskByDocumentId(documentId) {
	for (const task of tasks.values()) if (task.documentId === documentId) return task;
	return null;
}
function markStaleGeneratingRecord(record, projectRoot = getProjectRoot()) {
	if (record.status !== "generating" && record.status !== "queued" || getActiveTaskByDocumentId(record.id)) return record;
	if (record.status === "queued" && generationQueue.some((job) => job.documentId === record.id)) return record;
	const verdict = evaluateStaleInterruption(record);
	if (!verdict.stale) return record;
	const message = record.status === "queued" ? "排队任务未执行（生成进程已退出或服务重启），请重新发起生成" : "生成任务已中断，请点击继续生成或重新生成";
	const status = record.checkpointChapters?.length ? "warning" : "failed";
	console.warn(`[gen] interrupted: doc=${record.id} reason=${verdict.reason} ownerPid=${record.ownerPid ?? "none"} lastHeartbeat=${new Date(record.updatedAt).toISOString()}`);
	const next = {
		...record,
		title: fallbackFailedTitle(record),
		status,
		error: record.error || message,
		executionStages: failRunningStages(record.executionStages, message),
		completedAt: Date.now(),
		interruptedAt: Date.now(),
		interruptionReason: verdict.reason,
		warningIssues: record.checkpointChapters?.length ? [...record.warningIssues || [], message] : record.warningIssues
	};
	if (record.taskId) upsertDocumentOperation(projectRoot, {
		taskId: record.taskId,
		title: `生成 ${next.title}`,
		status: status === "warning" ? "warning" : "error",
		percent: 100,
		message,
		stages: next.executionStages,
		error: message
	});
	return next;
}
function listGeneratedDocuments(projectRoot = getProjectRoot()) {
	return readJson(indexPath(projectRoot), []).map((item) => {
		if (item.status !== "generating" && item.status !== "queued") return item;
		const fullRecord = readJson(draftPath(item.id, projectRoot), null);
		if (!fullRecord) return item;
		const next = markStaleGeneratingRecord(fullRecord, projectRoot);
		const saved = next !== fullRecord ? saveGeneratedDocument(next, projectRoot, { preserveUpdatedAt: true }) : next;
		return {
			...toGeneratedDocumentListItem(saved),
			queuePosition: saved.status === "queued" ? getQueuedDocumentPosition(saved.id) : void 0
		};
	}).sort((a, b) => (b.createdAt || b.updatedAt) - (a.createdAt || a.updatedAt));
}
function getGeneratedDocument(id, projectRoot = getProjectRoot()) {
	const record = readJson(draftPath(id, projectRoot), null);
	if (!record) return null;
	const next = markStaleGeneratingRecord(record, projectRoot);
	return ensureGeneratedDocumentAsset(next !== record ? saveGeneratedDocument(next, projectRoot, { preserveUpdatedAt: true }) : next, projectRoot);
}
function saveGeneratedDocument(record, projectRoot = getProjectRoot(), options) {
	const now = Date.now();
	const next = trimEvidenceContent({
		...record,
		updatedAt: options?.preserveUpdatedAt ? record.updatedAt : now
	});
	writeJson(draftPath(next.id, projectRoot), next);
	writeGeneratedDocumentMeta(next, projectRoot);
	const list = readJson(indexPath(projectRoot), []).filter((item) => item.id !== next.id);
	list.unshift(toGeneratedDocumentListItem(next));
	writeJson(indexPath(projectRoot), list);
	return next;
}
function listGeneratedAssets(projectRoot = getProjectRoot()) {
	return readJson(assetsPath(projectRoot), []).sort((a, b) => b.updatedAt - a.updatedAt);
}
function upsertGeneratedAssets(assets, documentId, projectRoot = getProjectRoot()) {
	const now = Date.now();
	const next = [...listGeneratedAssets(projectRoot)];
	for (const asset of assets) {
		const index = next.findIndex((item) => item.id === asset.id);
		const source = asset.path?.startsWith("generatedDocuments/assets/") || asset.status === "generated" || asset.status === "prompt_ready" ? "generated" : "knowledge_base";
		const record = {
			...asset,
			name: path.basename(asset.path || asset.url || asset.id),
			source,
			indexed: index >= 0 ? next[index].indexed : false,
			usedByDocumentIds: index >= 0 ? [...new Set([...next[index].usedByDocumentIds, documentId])] : [documentId],
			createdAt: index >= 0 ? next[index].createdAt : now,
			updatedAt: now
		};
		if (index >= 0) next[index] = {
			...next[index],
			...record
		};
		else next.push(record);
	}
	writeJson(assetsPath(projectRoot), next);
	return next;
}
function generatedDocumentAssetPath(record) {
	return `generatedDocuments/assets/${safeKnowledgeFileName(record.title)}-${record.id}.md`;
}
function upsertGeneratedDocumentAsset(record, projectRoot = getProjectRoot()) {
	const markdown = record.editedMarkdown || record.markdown;
	if (!markdown?.trim()) return null;
	const relativePath = generatedDocumentAssetPath(record);
	const absolutePath = path.join(generatedRoot(projectRoot), relativePath.replace(/^generatedDocuments\//u, ""));
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(absolutePath, markdown, "utf8");
	const asset = {
		id: `document-${record.id}`,
		type: "file",
		role: "generated",
		path: relativePath,
		status: "generated",
		message: "模板运行生成的 Markdown 文档，仅登记到生成资源，不进入知识库"
	};
	return upsertGeneratedAssets([asset], record.id, projectRoot).find((item) => item.id === asset.id) || null;
}
function ensureGeneratedDocumentAsset(record, projectRoot = getProjectRoot()) {
	if (record.status === "generating" || !(record.editedMarkdown || record.markdown)?.trim()) return record;
	const assetId = `document-${record.id}`;
	if (record.assets?.some((asset) => asset.id === assetId && asset.path)) return record;
	const asset = upsertGeneratedDocumentAsset(record, projectRoot);
	if (!asset) return record;
	return saveGeneratedDocument({
		...record,
		assets: [asset, ...(record.assets || []).filter((item) => item.id !== asset.id)]
	}, projectRoot);
}
function safeKnowledgeFileName(name) {
	return name.replace(/[\\/:*?"<>|]/gu, "_").slice(0, 120) || "generated-document";
}
function trimChapterEvidence(chapter) {
	const maxItems = Math.max(4, Math.floor(tuningProfile().persistEvidenceMaxItems ?? 10));
	const maxChars = Math.max(300, Math.floor(tuningProfile().persistEvidenceItemChars ?? 900));
	return {
		...chapter,
		evidence: (chapter.evidence || []).slice(0, maxItems).map((item) => ({
			...item,
			content: typeof item.content === "string" ? item.content.replace(/\s+/gu, " ").slice(0, maxChars) : ""
		}))
	};
}
function toGeneratedDocumentListItem(record) {
	const latestStage = [...record.executionStages || record.draft?.executionStages || []].reverse().find((stage) => stage.message || stage.subtitle || stage.roleId);
	const chapters = record.partialChapters || summarizeCheckpointChapters(record.checkpointChapters || record.draft?.checkpointChapters || record.draft?.chapters);
	const validationIssues = record.draft?.validationIssues || [];
	const blockerCount = record.draft?.exportGate ? record.draft.exportGate.blockingIssues?.length ?? 0 : validationIssues.filter((issue) => issue.severity === "blocker" || issue.level === "error").length;
	const warningCount = validationIssues.filter((issue) => issue.severity === "warning" || issue.level === "warning").length || record.warningIssues?.length || 0;
	const suggestionCount = validationIssues.filter((issue) => issue.severity === "suggestion" || issue.level === "info").length;
	return {
		id: record.id,
		taskId: record.taskId,
		templateId: record.templateId,
		templateName: record.templateName,
		templateVersion: record.templateVersion,
		title: record.title,
		requirement: record.requirement,
		projectRoot: record.projectRoot,
		projectId: record.projectId,
		knowledgeBasePath: record.knowledgeBasePath,
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		completedAt: record.completedAt,
		elapsedMs: record.completedAt ? record.completedAt - record.createdAt : record.updatedAt - record.createdAt,
		error: record.error,
		warningIssues: (record.warningIssues || []).slice(0, 12),
		warningCount,
		blockerCount,
		suggestionCount,
		wordCount: documentTextLength(record.editedMarkdown || record.markdown || record.draft?.markdown || ""),
		chapterCount: chapters?.length || record.draft?.chapters?.length || 0,
		completedChapterCount: (chapters || []).filter((chapter) => chapter.status === "completed").length,
		latestStage: latestStage?.subtitle || latestStage?.roleName || latestStage?.roleId,
		latestMessage: latestStage?.message,
		assets: (record.assets || []).slice(0, 8),
		partialChapters: chapters
	};
}
function trimEvidenceContent(record) {
	const draft = record.draft ? {
		...record.draft,
		chapters: record.draft.chapters?.map(trimChapterEvidence),
		checkpointChapters: record.draft.checkpointChapters?.map(trimChapterEvidence)
	} : record.draft;
	return {
		...record,
		draft,
		checkpointChapters: record.checkpointChapters?.map(trimChapterEvidence)
	};
}
function documentOperationDetails(stages) {
	return (stages || []).filter((stage) => stage.type === "role_binding" || stage.roleId === "runtime-prompt-rules" || stage.roleId === "document-readiness" || stage.status === "failed").flatMap((stage) => [`${stage.subtitle || stage.roleName || stage.roleId}：${stage.message || stage.status}`, ...(stage.details || []).slice(0, 8).map((detail) => `  - ${detail}`)]).slice(0, 80);
}
function upsertDocumentOperation(projectRoot, input) {
	upsertKbOperation(projectRoot, {
		id: input.taskId,
		type: "document",
		title: input.title,
		stage: input.status === "processing" ? "generating" : input.status === "error" ? "error" : "done",
		status: input.status,
		percent: input.percent,
		message: input.message,
		error: input.error,
		details: documentOperationDetails(input.stages)
	});
}
/** 排队位次（1 起）：不在队列中返回 undefined */
function getQueuedDocumentPosition(documentId) {
	const index = generationQueue.findIndex((job) => job.documentId === documentId);
	return index >= 0 ? index + 1 : void 0;
}
var globalDocumentTaskStore, tasks, generationQueue, ABANDONED_RECORD_STALE_MS, PROCESS_STARTED_AT, RECENT_UPDATE_GRACE_MS, processAliveProbe;
var init_generatedDocumentService = __esmMin((() => {
	init_document_workflow();
	init_semanticSimilarity();
	init_qualityValidation();
	init_kbService();
	init_budget();
	init_tuningProfile();
	init_kbOperationLog();
	globalDocumentTaskStore = globalThis;
	tasks = globalDocumentTaskStore.__generatedDocumentTasks ??= /* @__PURE__ */ new Map();
	generationQueue = globalDocumentTaskStore.__generatedDocumentQueue ??= [];
	ABANDONED_RECORD_STALE_MS = Math.max(60 * 6e4, Number(process.env.DOCUMENT_ABANDONED_RECORD_STALE_MS ?? 1440 * 6e4));
	PROCESS_STARTED_AT = globalDocumentTaskStore.__generatedDocumentProcessStartedAt ??= Date.now();
	RECENT_UPDATE_GRACE_MS = Math.max(Math.max(3e4, Number(process.env.DOCUMENT_RECENT_UPDATE_GRACE_MS ?? 18e4)), resolveHeartbeatSaveIntervalMs() * 3);
	processAliveProbe = defaultProcessAliveProbe;
}));
//#endregion
//#region apps/server/src/services/document-workflow/blueprintDerivationStrategies.ts
/** 条目归类 → L2 推导分组（名称关键词 → 分组；与丰乐镇多轮实测口径一致） */
function villageGroupOfEntry(entry) {
	const text = `${entry.name} ${entry.description}`;
	if (/塑料管|管道|检查井|雨水口|化粪池|涵管/u.test(text)) return "管道铺设";
	if (/挖一般土方|挖沟槽|挖基坑|回填|清淤|余方|弃置|土方/u.test(text) && entry.unit === "m3") return "土方工程";
	if (/混凝土|垫层|涵头|压顶/u.test(text) && entry.unit === "m3") return "混凝土工程";
	if (/水泥混凝土|路床|铺装|道路|青砖|散水|块料/u.test(text) && entry.unit === "m2") return "道路铺装";
	if (/砌筑|砌体|砖/u.test(text)) return "砌筑工程";
	if (/绿化|栽植|种植|苗木|草籽|喷播|灌木|乔木|色带|草坪/u.test(text)) return "绿化工程";
	return "安装工程";
}
var villageMunicipalStrategy;
var init_blueprintDerivationStrategies = __esmMin((() => {
	villageMunicipalStrategy = {
		id: "village-municipal",
		projectTypes: ["市政", "园林绿化"],
		milestoneGroups: [
			{
				key: "prep",
				label: "施工准备与清杂拆除",
				pattern: /清杂|拆除|场地平整|临时/u
			},
			{
				key: "pipe",
				label: "污水管网工程",
				pattern: /塑料管|检查井|管网|排水|化粪池|雨水口/u
			},
			{
				key: "road",
				label: "道路铺装工程",
				pattern: /道路|路床|水泥混凝土|级配碎石|路缘石|青砖|散水|过路涵/u
			},
			{
				key: "landscape",
				label: "景观与绿化工程",
				pattern: /景观|绿化|栽植|种植|苗木|喷播|小菜园|沟塘|清淤/u
			},
			{
				key: "lighting",
				label: "亮化与收尾工程",
				pattern: /路灯|亮化|配电|电缆|防雷/u
			}
		],
		groupOfEntry: villageGroupOfEntry,
		tradeMapping: [
			{
				trade: "管道工",
				pattern: /塑料管|管道|检查井|雨水口|化粪池|闭水|涵管|排水/u
			},
			{
				trade: "混凝土工",
				pattern: /混凝土|水泥砂浆|垫层|涵头|压顶/u
			},
			{
				trade: "瓦工",
				pattern: /砌筑|砌体|砖|路缘石|铺装|侧石|平石|块料|踏步|台阶/u
			},
			{
				trade: "绿化工",
				pattern: /绿化|栽植|种植|苗木|草籽|喷播|养护|灌木|乔木|色带|草坪/u
			},
			{
				trade: "电工",
				pattern: /路灯|配电|电缆|强电|防雷|接地|灯具|亮化/u
			},
			{
				trade: "普工",
				pattern: /土方|清杂|拆除|平整|回填|清淤|开挖/u
			}
		],
		laborUnitRange: {
			管道铺设: {
				unit: "m",
				min: .15,
				max: .3
			},
			土方工程: {
				unit: "m3",
				min: .08,
				max: .15
			},
			混凝土工程: {
				unit: "m3",
				min: .8,
				max: 1.5
			},
			道路铺装: {
				unit: "m2",
				min: .3,
				max: .6
			},
			砌筑工程: {
				unit: "m3",
				min: 1.2,
				max: 2
			},
			绿化工程: {
				unit: "m2",
				min: .08,
				max: .15
			},
			安装工程: {
				unit: "项",
				min: 0,
				max: 0
			}
		},
		equipmentMapping: [
			{
				name: "挖掘机",
				spec: "0.6~1.0m³",
				pattern: /人机配合|开挖|挖土|沟槽/u,
				unit: "m3",
				basis: "人机配合开挖（清单特征）"
			},
			{
				name: "自卸汽车",
				spec: "8t",
				pattern: /余方弃置|弃方|外运|回填/u,
				unit: "m3",
				basis: "土方运输与回填（清单条目）"
			},
			{
				name: "压路机",
				spec: "8~12t",
				pattern: /碾压|压实度/u,
				unit: "m2",
				basis: "路床碾压与压实度要求（清单特征）"
			},
			{
				name: "蛙式打夯机",
				spec: "",
				pattern: /回填|夯实/u,
				unit: "m3",
				basis: "沟槽回填夯实（清单条目）"
			},
			{
				name: "混凝土搅拌运输车",
				spec: "",
				pattern: /商品混凝土|C\d{2}混凝土/u,
				unit: "m3",
				basis: "商品混凝土运输（清单特征）"
			},
			{
				name: "插入式振捣器",
				spec: "",
				pattern: /混凝土浇筑|振捣/u,
				unit: "m3",
				basis: "混凝土浇筑（清单条目）"
			},
			{
				name: "洒水车",
				spec: "",
				pattern: /养护|绿化|喷播|栽植/u,
				unit: "m2",
				basis: "绿化养护与洒水（清单条目）"
			},
			{
				name: "高空作业车",
				spec: "",
				pattern: /路灯|灯具安装/u,
				unit: "套",
				basis: "路灯安装（清单条目）"
			}
		],
		machinePowerTable: [
			{
				name: "挖掘机",
				kw: 90
			},
			{
				name: "自卸汽车",
				kw: 120
			},
			{
				name: "压路机",
				kw: 75
			},
			{
				name: "蛙式打夯机",
				kw: 3
			},
			{
				name: "混凝土搅拌运输车",
				kw: 110
			},
			{
				name: "插入式振捣器",
				kw: 1.5
			},
			{
				name: "洒水车",
				kw: 90
			},
			{
				name: "高空作业车",
				kw: 60
			}
		],
		inspectionBatchRules: [
			{
				scope: "污水管网管道",
				namePattern: /塑料管|管道/u,
				unit: "m",
				divisor: 200,
				descTemplate: "管道闭水试验分段检验，按每 200m 一段划分约 {count} 段（总长 {total}m）"
			},
			{
				scope: "道路工程",
				namePattern: /水泥混凝土|级配碎石|路床/u,
				unit: "m2",
				divisor: 200,
				descTemplate: "路床压实度按每层每 200m² 不少于 1 点检验，约 {count} 点（总面积 {total}m²）"
			},
			{
				scope: "检查井",
				namePattern: /检查井/u,
				unit: "",
				divisor: 1,
				descTemplate: "检查井逐座验收，共 {total} 座"
			}
		],
		difficultyTemplates: [
			{
				name: (boq) => `${boq.villages.length} 个自然村分散施工组织协调`,
				measure: "按自然村分组划分施工段，多村平行施工 + 村内流水作业，配置专职协调员",
				basis: "清单按自然村分组",
				test: (boq) => boq.villages.length >= 2
			},
			{
				name: "雨季管网沟槽施工",
				measure: "雨季排水与边坡防护，分段开挖、快速回填（联动季节施工措施板块）",
				basis: "清单含沟槽开挖与管道铺设条目",
				test: (boq) => boq.entries.some((entry) => /挖沟槽|沟槽开挖|塑料管铺设/u.test(`${entry.name} ${entry.description}`))
			},
			{
				name: "村庄内道路施工交通疏导",
				measure: "分段封闭施工，设置临时道路保障居民出行（补疑条款：居民出行临时道路）",
				basis: "清单含道路工程条目且村内施工",
				test: (boq) => boq.villages.length > 0 && boq.entries.some((entry) => /道路|路床|路面/u.test(entry.name))
			},
			{
				name: "既有杆管线保护",
				measure: "开挖前探测交底，杆线保护措施费含在清单单价内",
				basis: "清单特征原文含杆线保护条款",
				test: (boq) => boq.entries.some((entry) => /杆线|管线保护|既有管线/u.test(entry.description))
			}
		],
		deploymentFlowFallback: "分区段流水作业",
		multiVillageFlow: (count) => `多村平行施工 + 村内流水作业（${count} 个自然村分组）`,
		sequenceFallback: "清杂拆除 → 管网道路 → 景观绿化 → 亮化收尾",
		climateZone: "east",
		powerFallbackText: "临时用电以村庄既有电源分散接入为主，各施工组单独设置配电箱与计量表（柴油机械不计入用电负荷，电动机具零星分散）",
		waterNoteText: "施工用水以洒水车供水为主，总用水量按管网分段配置"
	};
	villageMunicipalStrategy.tradeMapping, villageMunicipalStrategy.laborUnitRange;
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/decisionLock.ts
/** 决策项语法模式判定（4.36 D3）：两侧选项词任一命中类目选项 aliases 即返回该类目。
* 两可表述检测器（ambiguous-either-or）与修复链归一（fixAmbiguousEitherOrCandidates）共用——
* 「减振吊架或减振基础」「同步或分段浇筑」「柔性或半刚性」类形态从此走决策注册表，
* 不再逐条扩充硬编码句式表（句式追不上形态的无穷性）。 */
function matchDecisionCategory(sideA, sideB) {
	return DECISION_CATEGORIES.find((category) => {
		const covered = (text) => category.options.some((option) => option.aliases.test(text) || option.weakAliases?.test(text));
		return category.options.some((option) => option.aliases.test(sideA) || option.aliases.test(sideB)) && covered(sideA) && covered(sideB);
	});
}
var DECISION_CATEGORIES;
var init_decisionLock = __esmMin((() => {
	init_factsModel();
	DECISION_CATEGORIES = [
		{
			id: "vertical_transport",
			label: "垂直运输方式",
			relevance: /塔吊|塔式起重机|施工电梯|施工升降机|物料提升机|垂直运输/u,
			options: [
				{
					value: "塔式起重机",
					aliases: /塔吊|塔式起重机/
				},
				{
					value: "施工升降机",
					aliases: /施工电梯|施工升降机/
				},
				{
					value: "物料提升机",
					aliases: /物料提升机/
				},
				{
					value: "汽车式起重机",
					aliases: /汽车吊|汽车式起重机/
				}
			]
		},
		{
			id: "formwork",
			label: "模板体系",
			relevance: /模板/u,
			exclusive: true,
			options: [
				{
					value: "木胶合板模板",
					aliases: /木胶合板|覆膜胶合板|胶合板模板|木模板/
				},
				{
					value: "钢模板",
					aliases: /钢模板|定型钢模/
				},
				{
					value: "铝合金模板",
					aliases: /铝合金模板|铝模/
				},
				{
					value: "大模板",
					aliases: /大模板/
				},
				{
					value: "爬升模板",
					aliases: /爬升模板|爬模/
				}
			]
		},
		{
			id: "concrete_supply",
			label: "混凝土供应",
			relevance: /混凝土/u,
			exclusive: true,
			options: [{
				value: "商品混凝土（预拌）",
				aliases: /商品混凝土|预拌混凝土/
			}, {
				value: "自拌混凝土",
				aliases: /自拌混凝土|现场拌制混凝土|现场搅拌混凝土/
			}]
		},
		{
			id: "scaffold",
			label: "脚手架体系",
			relevance: /脚手架|爬架/u,
			options: [
				{
					value: "落地式钢管脚手架",
					aliases: /落地式[^，。；;]{0,6}脚手架|落地脚手架/
				},
				{
					value: "悬挑式脚手架",
					aliases: /悬挑[^，。；;]{0,6}脚手架|悬挑脚手架/
				},
				{
					value: "附着式升降脚手架",
					aliases: /附着式升降脚手架|爬架/
				},
				{
					value: "门式脚手架",
					aliases: /门式脚手架/
				},
				{
					value: "盘扣式脚手架",
					aliases: /盘扣/
				},
				{
					value: "碗扣式脚手架",
					aliases: /碗扣/
				}
			]
		},
		{
			id: "foundation_support",
			label: "基坑支护形式",
			relevance: /基坑|支护/u,
			exclusive: true,
			options: [
				{
					value: "放坡开挖",
					aliases: /放坡/
				},
				{
					value: "土钉墙支护",
					aliases: /土钉墙|土钉支护/
				},
				{
					value: "灌注桩支护",
					aliases: /灌注桩|钻孔灌注桩|排桩支护/
				},
				{
					value: "钢板桩支护",
					aliases: /钢板桩|拉森桩/
				},
				{
					value: "地下连续墙",
					aliases: /地下连续墙|地连墙/
				},
				{
					value: "锚杆（索）支护",
					aliases: /锚杆|锚索/
				},
				{
					value: "喷锚支护",
					aliases: /喷锚/
				}
			]
		},
		{
			id: "earthwork_haul",
			label: "土方外运方式",
			relevance: /土方|渣土|弃土/u,
			options: [
				{
					value: "自卸汽车外运",
					aliases: /自卸汽车|自卸车/
				},
				{
					value: "密闭渣土车外运",
					aliases: /密闭式?[^，。；;]{0,4}车|渣土车/
				},
				{
					value: "场内平衡利用",
					aliases: /场内平衡|就地平衡|场内调配|回填利用/
				}
			]
		},
		{
			id: "foundation_form",
			label: "基础形式",
			relevance: /基础/u,
			options: [
				{
					value: "独立基础",
					aliases: /独立基础/
				},
				{
					value: "条形基础",
					aliases: /条形基础|带形基础/
				},
				{
					value: "筏板基础",
					aliases: /筏板基础|筏形基础|满堂基础/
				},
				{
					value: "桩基础",
					aliases: /桩基础|桩基/u
				},
				{
					value: "箱形基础",
					aliases: /箱形基础|箱型基础/
				}
			]
		},
		{
			id: "vibration_isolation",
			label: "设备减振方式",
			relevance: /减振|隔振|减震|振动/u,
			options: [
				{
					value: "减振吊架",
					aliases: /减振吊架|隔振吊架|减震吊架|弹性吊架/
				},
				{
					value: "减振基础",
					aliases: /减振基础|隔振基础|减震基础|惯性基础/
				},
				{
					value: "橡胶隔振垫",
					aliases: /橡胶隔振垫|橡胶减振垫|隔振垫/
				},
				{
					value: "弹簧减振器",
					aliases: /弹簧减振器|弹簧隔振器|阻尼弹簧减振器/
				}
			]
		},
		{
			id: "concrete_pouring",
			label: "混凝土浇筑连续组织",
			relevance: /浇筑/u,
			options: [{
				value: "连续浇筑",
				aliases: /连续浇筑|一次浇筑|整体浇筑/,
				weakAliases: /同步浇筑|同步施工|同步/u
			}, {
				value: "分段浇筑",
				aliases: /分段浇筑|分仓浇筑|跳仓浇筑|分区浇筑/
			}]
		},
		{
			id: "pavement_structure",
			label: "路面结构类型",
			relevance: /路面|基层|面层|沥青|水泥稳定/u,
			options: [
				{
					value: "柔性路面",
					aliases: /沥青混凝土路面|沥青混凝土面层|沥青路面|沥青面层/,
					weakAliases: /柔性/u
				},
				{
					value: "半刚性路面",
					aliases: /半刚性/u
				},
				{
					value: "刚性路面",
					aliases: /刚性路面|水泥混凝土路面|水泥混凝土面层/
				}
			]
		}
	];
}));
/** 从基本事实文本提取合同口径（工期/质量标准/计价文件；提取不到降级为空串，不编造）。
* P3.6 源头根治：总工期不再裸匹配第一个「N日历天」（质保期/阶段工期 90 天曾被误采为总工期，
* 真实 210 天被漏采）；只从工期类锚点词邻接收值，lookbehind 排除「节点/阶段/分项/关键」工期
* 子项形态（阶段工期 90 天不可顶替总工期），与 scheduleDays 一致性锚点同口径。 */
//#endregion
//#region apps/server/src/services/document-workflow/billOfQuantitiesParser.ts
var init_billOfQuantitiesParser = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/parse.ts
var init_parse = __esmMin((() => {
	init_billOfQuantitiesParser();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/types.ts
var init_types = __esmMin((() => {}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/derive.ts
var init_derive = __esmMin((() => {
	init_blueprintDerivationStrategies();
	init_decisionLock();
	init_parse();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/capacity.ts
var init_capacity = __esmMin((() => {
	init_sectionNamingGovernance();
	init_writingSpec();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/outline.ts
var init_outline = __esmMin((() => {
	init_chapterPostProcessing();
	init_constructionProcessKnowledge();
	init_sectionNamingGovernance();
	init_writingSpec();
	init_capacity();
	init_parse();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/validate.ts
var init_validate = __esmMin((() => {
	init_blueprintDerivationStrategies();
	init_llmClient();
	init_parse();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/render.ts
var init_render = __esmMin((() => {
	init_writingSpec();
	init_capacity();
}));
//#endregion
//#region apps/server/src/services/document-workflow/integratedBlueprint/citation.ts
var init_citation = __esmMin((() => {
	init_semanticAdjudication();
	init_render();
}));
var init_integratedBlueprint = __esmMin((() => {
	init_generatedDocumentService();
	init_blueprintDerivationStrategies();
	init_constructionProcessKnowledge();
	init_derive();
	init_outline();
	init_parse();
	init_validate();
	init_types();
	init_decisionLock();
	init_render();
	init_citation();
	PROCESS_KNOWLEDGE_CARDS.length;
}));
//#endregion
//#region apps/server/src/services/document-workflow/integrity/fixers/fixers.ts
/** 自伤表述确定性改写（A6/A12）：实测形态正向化改写。
* 只改写实测锁定句式（首轮/二轮生成逐字命中），新句式变体由检测器+LLM 修复轮处理；
* 改写方向统一为正向确认表述，不再暴露「待补测/可能不一致/如涉及」类投标短板暗示。 */
function fixSelfUnderminingCandidates(markdown) {
	const replacements = [
		{
			from: /施工过程中如涉及危险性较大的分部分项工程[^。；;\n]*?(?:未经审批不得实施|后方可实施|方可实施)/gu,
			to: "危险性较大的分部分项工程按住房和城乡建设部令第37号与建办质〔2018〕31号规定逐项辨识、分级管控：凡达到危大工程判定线的分项，施工前编制专项施工方案，由技术负责人审核签字后报监理审批；超过一定规模的危大工程专项方案组织专家论证，未经审批不得实施",
			detail: "危大「如涉及」假设表述改写为逐项辨识分级管控"
		},
		{
			from: /发现[^。；;\n]{0,18}?(?:缺项|矛盾|缺失|遗漏)[^。；;\n]{0,24}?(?:时|后)在?\d+小时(?:内)?[^。；;\n]{0,10}?(?:补测|补正|补救|补录|补记)/gu,
			to: "记录经复核确认完整、数据准确后归档保存",
			detail: "踏勘补测类负面假设改写为复核确认归档"
		},
		{
			from: /确保[^。；;\n]{0,20}?与(?:本)?施工组织设计的?一致性/gu,
			to: "确认现场条件与施工组织设计相符",
			detail: "现场条件一致性两可暗示改写为确认相符"
		},
		{
			from: /本工程不允许分包[^。；;\n]{0,40}?组织实施/gu,
			to: "本工程全部施工任务由我公司项目部自行组织实施，严禁违法分包、转包及挂靠行为",
			detail: "「不允许分包」短板暗示改写为自主组织正向表述"
		},
		{
			from: /针对踏勘中发现的与设计图纸不一致或设计未明确的事项[^。；;\n]{0,60}?按以下[口经]径处理/gu,
			to: "项目部对照施工图与现场条件逐项复核，按以下程序处理",
			detail: "「设计图纸不一致」负面假设改写为对照复核程序"
		},
		{
			from: /杜绝施工过程中以工程量组价缺失为由提出变更申请/gu,
			to: "开工前完成工程量与清单核对，施工过程中严格按合同约定计量计价",
			detail: "「组价缺失」短板暴露改写为开工前核对闭环"
		},
		{
			from: /涉及危险性较大的分部分项工程，我公司将依据([^。；;\n]{0,80}?)，在施工前单独编制专项施工方案并履行审批程序。/gu,
			to: "本工程危险性较大的分部分项工程管理执行$1规定：施工前编制专项施工方案，履行审批程序后实施。",
			detail: "危大「涉及」假设句式改写为管理执行闭环"
		},
		{
			from: /上述参数在后续各分项施工方案中逐项落位执行。?/gu,
			to: "上述参数作为全文统一控制基准，各分项施工方案均按此执行。",
			detail: "「后续落位」延迟承诺改写为统一控制基准"
		},
		{
			from: /补疑文件对施工内容作出以下明确修正：([^。\n]{0,200}?)。上述修正内容已纳入本施工组织设计对应分项方案，施工过程中不再另行变更。?/gu,
			to: "招标文件补疑明确：$1。上述内容已纳入本施工组织设计对应分项方案并统一执行。",
			detail: "「补疑修正不再变更」负面暗示改写为统一执行"
		},
		{
			from: /项目部按《建筑施工企业、工程项目安全生产管理机构设置及安全生产管理人员配备办法》（建质规〔2025〕3号）配备专职安全生产管理人员，公司分管安全负责人每月带班检查不得少于两次/gu,
			to: "项目部严格执行《建筑施工企业、工程项目安全生产管理机构设置及安全生产管理人员配备办法》（建质规〔2025〕3号），专职安全生产管理人员按标准配足配齐，公司分管安全负责人每月带班检查不少于两次并留存检查记录",
			detail: "安全人员配备与带班检查短板暗示改写为配足配齐正向表述"
		},
		{
			from: /项目部在开工令下发后第(\d+)日亮化及附属设施安装完成后，随即启动竣工清理与验收移交程序，确保开工令下发后第(\d+)日完成全部验收移交工作/gu,
			to: "亮化及附属设施安装于开工令下发后第$1日完成，竣工清理与验收移交按计划组织，开工令下发后第$2日全部验收移交工作完成",
			detail: "竣工验收赶工暗示改写为按计划组织正向表述"
		},
		{
			from: /隐蔽工程在施工过程中已按(\d+)小时提前通知要求完成验收，竣工阶段不再重复检验，但须将全部隐蔽验收影像资料纳入竣工资料归档/gu,
			to: "隐蔽工程按$1小时提前通知要求组织验收，验收合格后方可进入下道工序，全部隐蔽验收影像资料纳入竣工资料归档",
			detail: "「竣工阶段不再重复检验」自伤暗示改写为验收闭环正向表述"
		},
		{
			from: /本施工组织设计的编制边界为：本项目位于[^，。；;\n]{2,40}，以补疑澄清文件对清单及图纸的修正口径为优先执行依据。?/gu,
			to: "本施工组织设计编制依据包括招标文件、补疑澄清文件、施工图及工程量清单，正文数据口径与补疑澄清文件修正口径保持一致。",
			detail: "编制边界两可暗示改写为编制依据一致性正向表述"
		},
		{
			from: /施工组织设计覆盖从开工令下发至竣工验收合格后移交保修的全过程管理，不包含招标范围以外的工程内容。?/gu,
			to: "施工组织设计覆盖开工令下发至竣工验收移交保修的全过程管理，全过程管理内容与招标范围一致。",
			detail: "「不包含招标范围以外」短板暗示改写为覆盖范围一致性表述"
		},
		{
			from: /面层混凝土弯拉强度达到设计强度且填缝完成前不得开放交通，由试验员按每检验批留置试块并送检，强度报告归档闭环。?/gu,
			to: "面层混凝土达到设计强度且填缝完成后开放交通，试验员按每检验批留置试块送检，强度报告归档形成质量闭环。",
			detail: "「不得开放交通」负面表述改写为达到条件后开放交通正向表述"
		},
		{
			from: /本(项目|工程)以成熟可靠的常规工艺为主，未采用(?:行业认定的)?新(?:技术|材料|工艺|设备)(?:、新(?:技术|材料|工艺|设备)){1,3}(?:或新(?:技术|材料|工艺|设备))?[^。；;\n]{0,20}?。?/gu,
			to: "本$1工艺选择以成熟可靠为原则，全部采用经工程实践验证的成熟工艺、常规材料和标准化设备，确保各分项施工质量稳定可控。",
			detail: "「未采用新技术」短板自曝改写为成熟工艺正向表述"
		},
		{
			from: /本工程不进行分包，全部施工内容由我方自行组织完成/gu,
			to: "本工程全部施工任务由我公司项目部自行组织实施，严禁违法分包、转包及挂靠行为",
			detail: "「本工程不进行分包」否定式自述改写为自主组织正向表述"
		},
		{
			from: /(?:亮化与)?收尾阶段安排\s*\d+\s*个日历天[^。\n]{0,60}?项目经理组织各分组施工员进行内部预验收[^。\n]{0,80}?竣工验收。?/gu,
			to: "收尾阶段按总进度计划组织实施，项目经理组织内部预验收，预验收问题清单当日下发、限时整改、复查销项后申请正式竣工验收",
			detail: "「收尾阶段安排N个日历天」赶工暗示改写为按计划组织正向表述"
		}
	];
	let result = markdown;
	let fixedCount = 0;
	const details = [];
	for (const item of replacements) {
		const matches = [...result.matchAll(item.from)];
		if (matches.length === 0) continue;
		result = result.replace(item.from, item.to);
		fixedCount += matches.length;
		details.push(`${item.detail} ${matches.length} 处`);
	}
	return {
		markdown: result,
		fixedCount,
		details
	};
}
var init_fixers = __esmMin((() => {
	init_constants();
	init_integratedBlueprint();
	init_detectors();
}));
//#endregion
export { init_detectors as S, parameterConceptConflictIssues as _, getQueuedDocumentPosition as a, SELF_UNDERMINING_PROCEDURAL_EXEMPT_RE as b, listGeneratedDocuments as c, upsertGeneratedDocumentAsset as d, buildGenerationBudget as f, init_parameterConceptConflicts as g, conceptConflictGroups as h, getGeneratedDocument as i, saveGeneratedDocument as l, previewGenerationBudgetForTemplate as m, init_fixers as n, init_generatedDocumentService as o, init_generationBudget as p, generatedRoot as r, listGeneratedAssets as s, fixSelfUnderminingCandidates as t, upsertGeneratedAssets as u, init_qualityValidation as v, ambiguousEitherOrIssues as x, scanTablePlaceholderCells as y };
