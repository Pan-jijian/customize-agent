import { A as init_budget, C as init_constants, D as init_utils, E as BID_DISCIPLINE_PHRASES, M as __esmMin, N as __exportAll, S as init_documentRoleService, T as init_kbService, _ as init_llmClient, a as init_workflowRules, b as init_configService, c as init_outline$1, d as init_projectMaterialProfile, f as init_agentWorkflow, g as concurrencyForDocumentScale, h as init_projectGraph, i as init_writingSpec, j as __commonJSMin, m as init_factMatching, n as init_markdownComposer, o as init_semanticGate, p as init_evidence, r as init_constructionOrgTablePlan, s as init_semanticSimilarity, t as docSystemPrefix, u as init_templateStore, v as init_tuningProfile, x as init_projectMaterialService } from "./markdownComposer-DcQW_obC.js";
import { i as init_sectionFingerprint, r as init_sectionNamingGovernance, t as init_promptRuleExtraction } from "./promptRuleExtraction-CfJrLooE.js";
import "node:fs";
import { readFileSync } from "node:fs";
import "node:path";
import "node:os";
import "@customize-agent/knowledge";
import "path";
import "os";
import "fs";
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
/** 句池排除行判定（检测端与修复锚点端同源口径）：空行/标题/表格/列表/引用/目录条目行不进句池 */
function isFillerPoolExcludedLine(line) {
	const trimmed = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim();
	if (!trimmed) return true;
	if (/^\s*(#{1,6}\s+|\||[-*+]\s|>)/u.test(trimmed)) return true;
	return FILLER_TOC_LINE_RE.test(trimmed);
}
/**
* 零信息口号句判定（确定性删除安全前置）：通过语义套话门且无任何数字/岗位/频次/合规锚点的
* 短句（≤60 字）方为零信息纯口号——删除零信息句是无损净化（不损失可核查信息）；
* 携带任何信息（数字/岗位/频次/合规承诺）的命中句一律保留，交 LLM 具体化重写（防误删承诺实质）。
*/
function isZeroInfoSloganSentence(sentence) {
	const compact = sentence.replace(/\s+/gu, "");
	if (compact.length === 0 || compact.length > 60) return false;
	if (/[0-9０-９]/u.test(compact)) return false;
	if (/项目经理|技术负责人|施工员|质检员|专职安全员|安全员|材料员|资料员|监理|班组|责任人|岗位/u.test(compact)) return false;
	if (/每日|每周|每月|每季|每年|每\d+|定期|不定期|不少于|不低于|至少/u.test(compact)) return false;
	if (/合同|约定|承诺|保证金|履约|招标|投标|中标|资质|奖项|证书|备案|报审|报验|审批|签证|变更/u.test(compact)) return false;
	return true;
}
/** 模板化前缀句判定（检测端与修复锚点端同源单入口）：先剥零宽字符（r28f 实测正文穿插
* U+200B 类字符致行首过滤失配）与条目编号，再测词首——不命中词表的句子零判定成本放行。 */
function isTemplatePrefixSentence(sentence) {
	const compact = sentence.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim();
	if (!compact) return false;
	return TEMPLATE_PREFIX_HEAD_RE.test(compact.replace(TEMPLATE_PREFIX_STRIP_RE, ""));
}
var FILLER_TOC_LINE_RE, TEMPLATE_PREFIX_STRIP_RE, TEMPLATE_PREFIX_HEAD_RE;
var init_tenderBidChecks = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	FILLER_TOC_LINE_RE = /^\s*(?:第[一二三四五六七八九十百\d]+[章节篇]|\d+(?:\.\d+){0,3})\s+[^。；;，,]*$/u;
	TEMPLATE_PREFIX_STRIP_RE = /^(?:#{1,6}\s*)?(?:(?:\d+(?:\.\d+)*)(?:[.、)）]|\s)+|（\d+）|[（(][一二三四五六七八九十]+[）)]|[-*•]\s+)?\s*/u;
	TEMPLATE_PREFIX_HEAD_RE = /^(?:(?:本节|本章|本小节|本部分|本(?:文|篇章))(?:将|拟|主要|重点|首先|从|围绕|按|结合|针对|以|通过|对|就|分|共|内容|的|内)|(?:以下|下述|下面)(?:从|将|为|是|内容|主要|就|围绕|介绍|说明)|综上所述|通过以上|由此可见|总的来说|总体而言)/u;
}));
//#endregion
//#region apps/server/src/services/document-workflow/evidenceContentSafety.ts
var init_evidenceContentSafety = __esmMin((() => {
	init_semanticSimilarity();
	init_semanticGate();
	init_outline$1();
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
}));
//#endregion
//#region apps/server/src/services/document-workflow/integrity/fixers/fixers.ts
function stripDuplicateParagraphs(markdown) {
	const lines = markdown.split(/\r?\n/u);
	const seen = /* @__PURE__ */ new Set();
	const drop = /* @__PURE__ */ new Set();
	let buffer = [];
	let bufferLines = [];
	const flush = () => {
		const fingerprint = paragraphFingerprint(buffer.join(""));
		if (fingerprint) if (seen.has(fingerprint)) bufferLines.forEach((index) => drop.add(index));
		else seen.add(fingerprint);
		buffer = [];
		bufferLines = [];
	};
	lines.forEach((line, index) => {
		const trimmed = line.trim();
		if (!trimmed) {
			flush();
			return;
		}
		if (/^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(trimmed)) {
			flush();
			return;
		}
		if (/^[-*•]\s/u.test(trimmed)) {
			flush();
			buffer = [trimmed];
			bufferLines = [index];
			flush();
			return;
		}
		buffer.push(trimmed);
		bufferLines.push(index);
	});
	flush();
	if (drop.size === 0) return {
		markdown,
		removedCount: 0
	};
	return {
		markdown: lines.filter((_, index) => !drop.has(index)).join("\n"),
		removedCount: drop.size
	};
}
var init_fixers = __esmMin((() => {
	init_constants();
	init_integratedBlueprint();
	init_detectors();
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
var init_parameterConceptConflicts = __esmMin((() => {
	init_semanticSimilarity();
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
//#region apps/server/src/services/document-workflow/finalize/repairRounds/duplicateSentenceCollapse.ts
var init_duplicateSentenceCollapse = __esmMin((() => {
	init_tenderBidScoring();
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
//#region apps/server/src/services/document-workflow/deliveryReviewReport.ts
var init_deliveryReviewReport = __esmMin((() => {
	init_generatedDocumentService();
	init_detectorFixerRegistry();
}));
//#endregion
//#region apps/server/src/services/document-workflow/finalize/finalGate.ts
var init_finalGate = __esmMin((() => {
	init_qualityValidation();
	init_documentProfessionalScore();
	init_templatingReview();
	init_documentGeneratorHelpers();
	init_deliveryReviewReport();
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
	init_duplicateSentenceCollapse();
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
var generationBudget_exports = /* @__PURE__ */ __exportAll({
	buildGenerationBudget: () => buildGenerationBudget,
	previewGenerationBudgetForTemplate: () => previewGenerationBudgetForTemplate
});
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
var init_kbOperationLog = __esmMin((() => {
	Math.round(Date.now() - process.uptime() * 1e3);
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
/** 心跳写盘保底间隔（阶段签名未变时的最小写盘间隔）：默认 30s，与中断宽限联动（宽限 clamp ≥3×心跳） */
function resolveHeartbeatSaveIntervalMs() {
	return Math.max(3e4, Math.min(3e5, Number(process.env.DOCUMENT_PROGRESS_HEARTBEAT_SAVE_INTERVAL_MS ?? 3e4)));
}
var globalDocumentTaskStore;
var init_generatedDocumentService = __esmMin((() => {
	init_document_workflow();
	init_semanticSimilarity();
	init_qualityValidation();
	init_kbService();
	init_budget();
	init_tuningProfile();
	init_kbOperationLog();
	globalDocumentTaskStore = globalThis;
	globalDocumentTaskStore.__generatedDocumentTasks ??= /* @__PURE__ */ new Map();
	globalDocumentTaskStore.__generatedDocumentQueue ??= [];
	Math.max(60 * 6e4, Number(process.env.DOCUMENT_ABANDONED_RECORD_STALE_MS ?? 1440 * 6e4));
	globalDocumentTaskStore.__generatedDocumentProcessStartedAt ??= Date.now();
	Math.max(Math.max(3e4, Number(process.env.DOCUMENT_RECENT_UPDATE_GRACE_MS ?? 18e4)), resolveHeartbeatSaveIntervalMs() * 3);
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
var init_decisionLock = __esmMin((() => {
	init_factsModel();
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
//#region apps/server/src/services/document-workflow/semanticAdjudication.ts
var init_semanticAdjudication = __esmMin((() => {
	init_llmClient();
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
//#region apps/server/src/services/document-workflow/integrity/detectors/detectors.ts
function paragraphFingerprint(paragraph) {
	const normalized = paragraph.replace(/\s+/gu, "");
	return normalized.length >= DUPLICATE_PARAGRAPH_MIN_CHARS ? normalized : void 0;
}
var HAZARD_CATEGORY_TERMS, NL, DUPLICATE_PARAGRAPH_MIN_CHARS;
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
	DUPLICATE_PARAGRAPH_MIN_CHARS = 40;
}));
//#endregion
//#region apps/server/src/services/document-workflow/qualityValidation.ts
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
}));
//#endregion
//#region apps/server/src/services/document-workflow/helpers/markdownCleanup.ts
var init_markdownCleanup = __esmMin((() => {
	init_markdownComposer();
	init_outline$1();
	init_rolePipeline();
}));
//#endregion
//#region apps/server/src/services/document-workflow/constructionOrgAudit.ts
/**
* 模板化前缀句修复锚点提取（D-T7 ①，r28f #35 归因）：与 fillerSentenceTargets 同池范式
* （逐行过滤 + H3/H4 小节定位 + ≥12 字句池），判定走 isTemplatePrefixSentence 词首确定性
* 单源（检测端 formalStyleIssues 同源引用，检测定位 = 修复定位）。标题行跳过含零宽前缀形态
* （行首剥零宽后仍以 # 开头即标题；防「1.2 主要施工内容」类标题残片被判前缀句误删）。
* 限幅同 filler：每章 12 句、全文 60 条。
*/
function templatePrefixTargets(chapters) {
	const targets = [];
	for (const chapter of chapters) {
		let currentSection = chapter.title;
		let chapterCount = 0;
		for (const line of chapter.content.split("\n")) {
			const heading = /^#{3,4}\s+(.+)$/u.exec(line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "").trim());
			if (heading) {
				currentSection = heading[1].trim();
				continue;
			}
			const compactLine = line.replace(/[\u200b-\u200f\u2060\ufeff]/gu, "");
			if (/^\s*#{1,6}\s/u.test(compactLine)) continue;
			if (isFillerPoolExcludedLine(line)) continue;
			for (const raw of line.split(/[。；;]/u)) {
				const sentence = raw.trim();
				if (sentence.length < 12 || !isTemplatePrefixSentence(sentence)) continue;
				if (chapterCount >= 12 || targets.length >= 60) break;
				chapterCount += 1;
				targets.push({
					chapterId: chapter.id,
					chapterTitle: chapter.title,
					section: currentSection,
					sentence,
					channel: "prefix"
				});
			}
			if (chapterCount >= 12 || targets.length >= 60) break;
		}
		if (targets.length >= 60) break;
	}
	return targets;
}
/** 确定性删除句在正文中的全部出现处：去尾标点 → 行内「前导空白+句+尾标点」全局替换，
* 行尾无标点句按行尾匹配；仅处理非排除行（标题/表格行原样保留）；返回删除处数 */
function removeSentenceOccurrences(lines, sentence) {
	const core = sentence.replace(/[。；;]\s*$/u, "").trim();
	if (core.length < 12) return 0;
	const escaped = core.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const inlineRe = new RegExp(`[\\s\\u3000]*${escaped}[\\s\\u3000]*[。；;]`, "gu");
	const tailRe = new RegExp(`[\\s\\u3000]*${escaped}[\\s\\u3000]*$`, "u");
	let removed = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (isFillerPoolExcludedLine(line) || !line.includes(core)) continue;
		const matches = line.match(inlineRe);
		const replaced = matches && matches.length > 0 ? line.replace(inlineRe, "") : line.replace(tailRe, "");
		if (replaced === line) continue;
		removed += matches && matches.length > 0 ? matches.length : 1;
		if (replaced.trim() === "") lines.splice(index, 1);
		else lines[index] = replaced;
	}
	return removed;
}
/**
* 零信息口号句确定性删除（C2 句级定点治理）：仅删除 semantic 通道且通过零信息硬闸
* （isZeroInfoSloganSentence：无数字/岗位/频次/合规锚点）的命中句——删除零信息句是
* 无损净化，不经过 LLM（历史负效果：LLM 批量改写误报句引入同义新空话）；
* 其余命中句（vague 通道 / 含信息或合规承诺的 semantic 句）原样保留在 remaining，交 LLM 锚点具体化。
* 幂等安全：句已不存在时删除数为 0，target 回填 remaining（不丢修复锚点）。
* D-T7 通道扩展：semantic（套话原型）/prefix（模板化前缀句）/paragraph（废话段模式）
* 三确定性通道 + 零信息硬闸即删；vague（模糊应答，语境依赖型）一律交 LLM 具体化。
*/
function stripZeroInfoSloganSentences(chapters, targets) {
	const deletedSentences = [];
	const remaining = [];
	let deletedCount = 0;
	for (const target of targets) {
		const key = target.chapterId || target.chapterTitle;
		const chapter = chapters.find((item) => (item.id || item.title) === key);
		const deletableChannel = target.channel === "semantic" || target.channel === "prefix" || target.channel === "paragraph";
		if (!chapter || !deletableChannel || !isZeroInfoSloganSentence(target.sentence)) {
			remaining.push(target);
			continue;
		}
		const lines = chapter.content.split("\n");
		const removed = removeSentenceOccurrences(lines, target.sentence);
		if (removed > 0) {
			chapter.content = lines.join("\n").replace(/\n{3,}/gu, "\n\n");
			deletedCount += removed;
			if (!deletedSentences.includes(target.sentence)) deletedSentences.push(target.sentence);
		} else remaining.push(target);
	}
	return {
		deletedCount,
		deletedSentences,
		remaining
	};
}
var FILLER_PARAGRAPH_PATTERNS;
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
//#region .dbg/c8-s6-probe.ts
/**
* C8 S6 probe（A' 对象错位修复方案验证）：
* 链尾 markdown 版 templating 重放（templatingTailReplay 蓝本）——对 session.finalMarkdown 切章
* （`## ` 行级章界，头区不参与）构造伪 chapters，复用与 templatingSweep 完全相同的三函数：
* ① templatePrefixTargets → stripZeroInfoSloganSentences（前缀句确定性删除，channel=prefix 硬闸）
* ② 逐章 stripDuplicateParagraphs（章内段落完全重复去重）
* 验证：s28m'/r28m' 终稿重放的删除明细（安全性观察）+ 幂等（二次重放零变更）。
* 运行：node node_modules/.pnpm/rolldown@1.0.3/node_modules/rolldown/bin/cli.mjs -c .dbg/rolldown-c8-s6-probe.config.mjs
*   && node apps/server/.audit-out/c8-s6-probe.mjs
*/
var require_c8_s6_probe = /* @__PURE__ */ __commonJSMin((() => {
	init_constructionOrgAudit();
	init_documentIntegrityChecks();
	const DOCS = {
		"s28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949006905-e791c53e.json",
		"r28m'": "/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1789949001562-48a0cce5.json"
	};
	/** 章区间切分（`## ` 行级章界；首个章界前的头区不参与） */
	function chapterRangesOf(markdown) {
		const lines = markdown.split("\n");
		const ranges = [];
		let current;
		lines.forEach((rawLine, index) => {
			const line = rawLine.trim();
			if (/^##\s+/u.test(line)) {
				if (current) {
					current.endLine = index;
					ranges.push(current);
				}
				current = {
					startLine: index,
					endLine: lines.length,
					title: line.replace(/^#+\s*/u, "")
				};
			}
		});
		if (current) ranges.push(current);
		return {
			lines,
			ranges
		};
	}
	/** 顺序双指针差集：处理前独有（即被删的段/句）行明细 */
	function diffRemovedLines(before, after) {
		const removed = [];
		let i = 0;
		let j = 0;
		while (i < before.length && j < after.length) if (before[i] === after[j]) {
			i += 1;
			j += 1;
		} else {
			removed.push(before[i]);
			i += 1;
		}
		while (i < before.length) {
			removed.push(before[i]);
			i += 1;
		}
		return removed;
	}
	function tailReplay(markdown) {
		const { lines, ranges } = chapterRangesOf(markdown);
		if (ranges.length === 0) return {
			markdown,
			prefixRemoved: 0,
			prefixSentences: [],
			paragraphRemoved: 0,
			paragraphDetails: [],
			targetCount: 0
		};
		const pseudo = ranges.map((range, index) => ({
			id: `md-chapter-${index}`,
			title: range.title,
			content: lines.slice(range.startLine, range.endLine).join("\n"),
			evidence: [],
			missingFacts: []
		}));
		const targets = templatePrefixTargets(pseudo);
		const stripped = targets.length > 0 ? stripZeroInfoSloganSentences(pseudo, targets) : {
			deletedCount: 0,
			deletedSentences: [],
			remaining: targets
		};
		let paragraphRemoved = 0;
		const paragraphDetails = [];
		for (const chapter of pseudo) {
			const before = chapter.content.split("\n");
			const deduped = stripDuplicateParagraphs(chapter.content);
			if (deduped.removedCount > 0) {
				chapter.content = deduped.markdown;
				paragraphRemoved += deduped.removedCount;
				const removed = diffRemovedLines(before, deduped.markdown.split("\n"));
				for (const line of removed.slice(0, 8)) paragraphDetails.push(`[${chapter.title.slice(0, 16)}] ${line.slice(0, 70)}`);
			}
		}
		if (stripped.deletedCount === 0 && paragraphRemoved === 0) return {
			markdown,
			prefixRemoved: 0,
			prefixSentences: [],
			paragraphRemoved: 0,
			paragraphDetails: [],
			targetCount: targets.length
		};
		const out = [...lines];
		for (let index = ranges.length - 1; index >= 0; index -= 1) {
			const range = ranges[index];
			out.splice(range.startLine, range.endLine - range.startLine, ...pseudo[index].content.split("\n"));
		}
		return {
			markdown: out.join("\n"),
			prefixRemoved: stripped.deletedCount,
			prefixSentences: stripped.deletedSentences,
			paragraphRemoved,
			paragraphDetails,
			targetCount: targets.length
		};
	}
	for (const [name, file] of Object.entries(DOCS)) {
		const wrapper = JSON.parse(readFileSync(file, "utf8"));
		const markdown = String(wrapper.markdown ?? "");
		const result = tailReplay(markdown);
		console.log(`\n===== ${name}（链尾 templating 重放）=====`);
		console.log(`前缀句 targets=${result.targetCount}；删除 ${result.prefixRemoved} 处`);
		for (const sentence of result.prefixSentences.slice(0, 6)) console.log(`   前缀句删除：「${sentence.slice(0, 60)}」`);
		console.log(`段落去重删除 ${result.paragraphRemoved} 行`);
		for (const line of result.paragraphDetails) console.log(`   ${line}`);
		console.log(`长度：${markdown.length} → ${result.markdown.length}（变化 ${markdown.length - result.markdown.length}）`);
		const second = tailReplay(result.markdown);
		console.log(`幂等核对：二次重放 前缀 ${second.prefixRemoved} 处 / 段落 ${second.paragraphRemoved} 行（期望 0/0）`);
	}
	const SYNTHETIC = [
		"# 合成样本（触发能力验证）",
		"",
		"## 第一章 施工总体部署",
		"本节将重点阐述施工总体部署与资源配置方案。",
		"",
		"施工总体部署依据招标文件与施工图纸要求编制，覆盖机构设置、区段划分与时序安排等全部核心内容，用于指导全过程施工组织与资源调配。",
		"",
		"施工总体部署依据招标文件与施工图纸要求编制，覆盖机构设置、区段划分与时序安排等全部核心内容，用于指导全过程施工组织与资源调配。",
		"",
		"## 第二章 质量保证措施",
		"综上所述，本项目施工组织设计覆盖全部施工内容与工序环节。",
		"",
		"质量管理体系覆盖策划、实施、检查与改进四个环节，依托三级检验制度与过程记录实现质量目标的可追溯与闭环管理。",
		"",
		"## 第三章 安全管理体系",
		"本章将投入项目经理1名专职负责安全生产总体协调。",
		"",
		"质量管理体系覆盖策划、实施、检查与改进四个环节，依托三级检验制度与过程记录实现质量目标的可追溯与闭环管理。"
	].join("\n");
	{
		console.log("\n===== 合成样本（触发能力验证）=====");
		const before = SYNTHETIC.split("\n");
		const result = tailReplay(SYNTHETIC);
		const after = result.markdown.split("\n");
		const removed = diffRemovedLines(before, after);
		console.log(`前缀句 targets=${result.targetCount}（期望 3：本节将/综上所述/含数字岗位句）`);
		console.log(`前缀句删除 ${result.prefixRemoved} 处（期望 2：含数字岗位句被零信息硬闸拒删）`);
		for (const sentence of result.prefixSentences) console.log(`   删：「${sentence}」`);
		console.log(`段落去重 ${result.paragraphRemoved} 处（期望 1：第一章内重复段；跨章复用段期望保留）`);
		for (const line of result.paragraphDetails) console.log(`   ${line}`);
		console.log(`实际删行 ${removed.length}：`);
		for (const line of removed) console.log(`   - ${line.slice(0, 82)}`);
		const keptAnchor = after.some((line) => line.includes("项目经理1名"));
		const keptCross = after.filter((line) => line.includes("质量管理体系覆盖策划")).length;
		console.log(`反样本核对：含数字岗位句保留=${keptAnchor}（期望 true）；跨章复用段保留 ${keptCross} 处（期望 2）`);
		const second = tailReplay(result.markdown);
		console.log(`幂等核对：二次重放 前缀 ${second.prefixRemoved} 处 / 段落 ${second.paragraphRemoved} 处（期望 0/0）`);
	}
}));
//#endregion
export default require_c8_s6_probe();
export { init_generationBudget as n, generationBudget_exports as t };
