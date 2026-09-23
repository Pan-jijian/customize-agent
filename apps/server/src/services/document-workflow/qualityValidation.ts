import type { AutoDocumentSpecGateRule, AutoDocumentSpecPackage, GateRuleEvaluator } from '../document-core/autoDocumentSpecTypes';
import { readEngineeringDocumentConfig } from '../document-validation/engineeringDocumentConfigService';
import { CHAPTER_HEADING_RE, EXPORT_BLOCKING_ISSUE_RE, EXPORT_GATE_PRECISION_ISSUE_RE, EXPORT_GATE_PROJECT_CONTAMINATION_RE, FALLBACK_GATE_EVALUATORS, FORMAL_PLACEHOLDER_PATTERNS, LINE_SPLIT_RE, MARKDOWN_IMAGE_RE, MARKDOWN_SECTION_HEADING_RE, MARKDOWN_TABLE_DIVIDER_RE, MARKDOWN_TABLE_ROW_RE, MARKDOWN_TOP_HEADING_RE, NON_BLANK_RE, PRECISE_FACT_MIN_TOKEN_COUNT, PRECISE_FACT_MIN_USAGE_RATE, PRECISE_FACT_SOURCE_RE, PRECISE_FACT_TOKEN_RE, DOCUMENT_BASIC_INFO_BLOCK_RE, DOCUMENT_BASIC_INFO_FIELDS, DOCUMENT_BASIC_INFO_TABLE_RE, PROMPT_EXAMPLE_BLOCK_RE, QUALITY_SEVERITY_RULES, SPEC_GATE_RULE_HANDLERS, SPECIFICATION_CONTENT_RE, STRUCTURED_DATA_CONTENT_RE, TABLE_PLACEHOLDER_APPROX_RE, TABLE_PLACEHOLDER_CELL_FORMS_RE, TOC_BLOCK_RE, TOC_INDENTED_SECTION_LINE_RE, TOC_SECTION_LINE_RE, WHITESPACE_RE } from '../constants';
import type { QualitySeverity, QualitySeveritySummary, SpecGateRuleContext } from '../types';
import { manualDispositionIssues } from './detectorFixerRegistry';
import type { BoqRowTrace, DocumentDraftChapter, DocumentFact, DocumentFactsModel, DocumentTemplate, ExportGateResult, NumericScopeConflict, ProjectBinding, PromptBinding, ValidationIssue } from './types';
import type { FactTokenScopeClassifier } from './factTokenClassifier';
import type { SemanticSimilarityFn } from './semanticSimilarity';
import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';
import type { ContentNeedKey, DepthDimension, ProfessionalDepthAnalysis } from './professionalDepthClassifier';
import { documentTextLength, estimateDocumentPages } from './budget';
import { extractEngineeringMeasureTokens, normalizeEngineeringTextForFactMatch } from './engineeringUnits';
import { missingPlannedSections } from './chapterPostProcessing';
import { buildBoqRowTraces, classifyNumericTraceToken } from './documentFactTrace';
import { displayChapterTitle, isTenderClauseFragmentTitle } from './outline';
import { extractGeneratedSections, mergeTableLineBreaks, sectionHeadingIdentityKey } from './markdownComposer';
import { stripTableCellInvisibleChars } from './helpers/markdownCleanup';
import { PAIRED_PUNCTUATION_SYMBOLS } from './structureIntegrityRules';
import type { BlueprintData } from './integratedBlueprint';
import { drawingFactPlacement, type DrawingFactLock } from './drawingFactLock';
import { assignBillRowChapter, scanBillExplicitDispositions } from './billFactLock';
import type { BillFactLock } from './billFactLock';
import { buildResourceBreakdownAuthority, normalizeEquipmentClaimName, scanEquipmentCountClaims, scanEquipmentNamesIn, scanResourceBreakdownClaims } from './resourceBreakdownNumbers';
import { evidenceSatisfiesSpecField } from './factMatching';
import { readPromptContents } from './templateStore';
import { authorityRewriteVerdict } from './authorityRewriteGuard';
import { extractSection, nearSubsectionTitleMatch, normalizeSubsectionTitleForDedup, stableHash, stringifyFactValue, WORK_PACKAGE_SECTION_RE } from './utils';
import { isStructuralLabelTitle } from './templatingGovernance';
import { DIVISION_SECTION_RE } from './writingSpec';
import { fiveElementBlockStats, scanTemplatePrefixSentences } from './tenderBidChecks';
import { buildSemanticGate } from './semanticGate';
import { classifyValueShape } from './valueOverride';
import { longestCommonHanSubstring } from './numericalConsistency';
import { isUnitPairRatioMatch, scanUncoveredEngineeringHeadings } from './integrity/detectors/detectors';
// 危大判定阈值**单源**（hazardBinding 为写作侧阈值表唯一来源）：本模块只做「引用值是否为规范阈值」的
// 判别，不得再抄一份阈值数字（4.55.29 判据根修：区分「照抄规范阈值」与「本项目控制值实参」）。
import { HAZARD_THRESHOLDS } from './hazardBinding';

export function isExportBlockingIssue(issue: ValidationIssue) {
  return EXPORT_BLOCKING_ISSUE_RE.test(issue.message);
}

export function classifyQualitySeverity(issue: string | ValidationIssue): QualitySeverity {
  const message = typeof issue === 'string' ? issue : issue.message;
  const level = typeof issue === 'string' ? undefined : issue.level;
  if (level === 'error') return 'blocking';
  for (const rule of QUALITY_SEVERITY_RULES) {
    if (rule.pattern.test(message)) return rule.severity;
  }
  return 'minor';
}

export function qualitySeveritySummary(issues: Array<string | ValidationIssue>): QualitySeveritySummary {
  const summary: QualitySeveritySummary = { blocking: 0, important: 0, minor: 0 };
  for (const issue of issues) summary[classifyQualitySeverity(issue)] += 1;
  return summary;
}

function repeatedTokenIssue(text: string, scope: string): ValidationIssue | undefined {
  const normalized = text.replace(/[\][()`*_>#|{}，。、“”‘’：；！？,.!?:;-]+/gu, ' ').replace(WHITESPACE_RE, ' ').trim();
  if (normalized.length < 120) return undefined;
  // r28h M7 相邻性修正（s28h2 终门禁 32/33 号实测）：token 需带匹配位置，连续 run 仅在归一文本中
  // 直接相邻（间隔至多空白）时成立。旧口径仅比较相邻 token 名——规格枚举行（「3×10规格5260.98m、
  // 5×6规格3600m…」「DN32壁厚110mm管、DN50壁厚3.8mm管…」）中的数字/短单位不在 token 表内，
  // 「规格」「壁厚」伪相邻成 run（实测 maxRun=15），全文与章节双报 blocker；真退化输出为紧邻重复，
  // 相邻性判定下仍全额召回（与叠词检测器 REPEATED_WORD_RE 同源口径）。
  const tokenMatches = [...normalized.matchAll(/[A-Za-z][A-Za-z-]{2,}|[\p{Script=Han}]{2,}/gu)];
  if (tokenMatches.length < 30) return undefined;
  let repeatedRun = 1;
  const counts = new Map<string, number>();
  for (let index = 0; index < tokenMatches.length; index += 1) {
    const token = tokenMatches[index][0].toLowerCase();
    counts.set(token, (counts.get(token) || 0) + 1);
    let adjacentSame = false;
    if (index > 0) {
      const previous = tokenMatches[index - 1];
      const gap = normalized.slice((previous.index ?? 0) + previous[0].length, tokenMatches[index].index ?? 0);
      adjacentSame = token === previous[0].toLowerCase() && gap.trim() === '';
    }
    if (adjacentSame) repeatedRun += 1;
    else repeatedRun = 1;
    if (repeatedRun >= 12) return { level: 'error', message: `${scope} 存在重复 token 退化输出`, suggestion: '请重新生成该小节，禁止保留连续重复的英文单词或无意义片段。' };
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] >= 25 && dominant[1] / tokenMatches.length >= 0.42) return { level: 'error', message: `${scope} 存在重复 token 退化输出`, suggestion: `检测到“${dominant[0]}”异常高频重复，请重新生成该小节。` };
  return undefined;
}

export function degenerateContentIssues(markdown: string, chapters: DocumentDraftChapter[] = []): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const whole = repeatedTokenIssue(markdown, '全文');
  if (whole) issues.push(whole);
  for (const chapter of chapters) {
    const chapterIssue = repeatedTokenIssue(chapter.content, `章节“${chapter.title}”`);
    if (chapterIssue) issues.push(chapterIssue);
    for (const section of chapter.sections || []) {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const match = chapter.content.match(new RegExp(`^#{3,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{3,4}\\s+|^##\\s+|$)`, 'mu'));
      if (!match) continue;
      const sectionIssue = repeatedTokenIssue(match[1], `小节“${section}”`);
      if (sectionIssue) issues.push(sectionIssue);
    }
  }
  return issues;
}

function classifyValidationIssue(issue: ValidationIssue): ValidationIssue {
  if (issue.severity && issue.repairability) return issue;
  if (/小节只有标题|空小节|小节内容补写未完成/u.test(issue.message)) return { ...issue, severity: 'blocker', repairability: 'local_deterministic', category: 'structure', owner: 'system' };
  if (/不得出现|提示词要求|疑似提示词指令标题|项目污染|生成未完成/u.test(issue.message)) return { ...issue, severity: 'blocker', repairability: 'llm_repairable', category: 'structure', owner: 'system' };
  if (/事实一致性冲突|projectFactOnly|核心事实/u.test(issue.message)) return { ...issue, severity: issue.level === 'error' ? 'blocker' : 'warning', repairability: 'manual_review', category: 'fact_consistency', owner: 'user' };
  if (/证据使用覆盖率偏低|BOQ|落位|高分模块|专业链|闭环/u.test(issue.message)) {
    // Q1/Q11 修复链：清单落位与关键参数抽查升级为 error 后必须进修复循环（原 not_repair_needed 导致检测到却永不修复）
    if (issue.level === 'error') return { ...issue, severity: 'blocker', repairability: 'llm_repairable', category: 'evidence_coverage', owner: 'llm' };
    return { ...issue, severity: 'warning', repairability: 'not_repair_needed', category: 'evidence_coverage', owner: 'system' };
  }
  if (issue.level === 'error') return { ...issue, severity: 'blocker', repairability: 'llm_repairable', category: 'structure', owner: 'system' };
  if (issue.level === 'warning') return { ...issue, severity: 'warning', repairability: 'not_repair_needed', category: 'style', owner: 'system' };
  return { ...issue, severity: 'suggestion', repairability: 'not_repair_needed', category: 'style', owner: 'system' };
}

/**
 * **阻断口径单源**（G 线 P0-7）：报告与门禁消费同一个出口。
 *
 * 此前有两套同名口径：报告的 `blockingIssues` 数「所有 error 级问题」，
 * 而终门禁 `isHardExportBlockingIssue` 是白名单子集——两者是集合包含关系却同名，
 * 于是「报告说 12 项阻断、门禁说 3 项」这类自相矛盾无法从数据结构上排除。
 *
 * 现口径统一到**门禁侧**（更严、且是真正决定能否交付的那个）：
 * 报告的综合扣分与门禁的放行判定从此不可能分歧。
 * 变更点：report.deliveryProbability 的扣分基数由「所有 error」变为「门禁阻断集」
 * ⇒ 部分历史报告的分数会变（更贴近实际交付判定），按 P3-5 递增口径版本。
 */
export function classifyBlockingIssue(issue: ValidationIssue) {
  const governedIssue = classifyValidationIssue(issue);
  if (governedIssue.severity !== 'blocker') return false;
  if (governedIssue.level === 'error' && governedIssue.severity === 'blocker' && /placeholder|source|style|format|structure/u.test(String(governedIssue.category || ''))) return true;
  // G 线 P0-1 交付资格判定直通：主尺未达标是**最上游的交付判定**，显式直通而非依赖默认
  // category 归类 —— 本函数下方有多条按 message 的放行项（目录与正文 / 生成后事实反查失败 /
  // 规划小节正文过短 / 事实一致性冲突：项目名称 / 证据使用覆盖率偏低 等），显式直通可确保
  // 交付判定不会被后续新增的排除规则顺手豁免。
  if (governedIssue.level === 'error' && governedIssue.severity === 'blocker' && /交付置信度未达目标/u.test(issue.message)) return true;
  // 4.19 危大闭环新检查器直通：危大分级/支护形式/设备进场的确定性判定（category=fact_consistency）
  // 消息锚点为三组新检查器专用前缀，不影响历史 fact_consistency 消息的白名单把关（宁漏报不误报）
  if (governedIssue.level === 'error' && governedIssue.category === 'fact_consistency' && /危大工程判定缺失|超危大工程判定缺失|支护形式与资料矛盾|支护形式未落地|设备进场时间荒谬|设备进场工序倒挂/u.test(issue.message)) return true;
  // P6 闸门直通（V5 数据主权根治，run1 实测）：带完整标注（severity+repairability+category=fact_consistency）
  // 的检测器 issue 此前落到下方消息白名单 isExportBlockingIssue 被静默过滤——run1 实测 87 条真矛盾
  // 全部不阻断导出（与 round-20「白名单把关、宁漏报不误报」的预期相反）。本轮全部检测器误报已逐条
  // 校准（材料拆分单位族/工种桥接校验/蓝图 groups 豁免/规格语境豁免），保留的 blocker 即真矛盾，
  // 一律直通硬阻断，由 llm_repairable 修复链闭环。
  if (governedIssue.level === 'error' && governedIssue.severity === 'blocker' && governedIssue.category === 'fact_consistency' && governedIssue.repairability === 'llm_repairable') return true;
  // 4.55.29 L1-5 标注优先（上一条 P6 直通的同类补全）：检测器**显式声明**「blocker + 修复轮可收敛」时，
  // 阻断资格不得再由下方按消息文本的白名单（isExportBlockingIssue 等）决定——否则会出现
  // 「检测器说自己报了阻断、修复链说该修、门禁却因消息不在白名单里静默放行」的假闭环。
  // 仅收 llm_repairable：manual_review 标注（注册表声明转人工）按既有契约不阻断导出，
  // not_repair_needed / 无标注仍走下方消息与 category 判据，避免把「已声明无需修复」的项拉进阻断集。
  if (governedIssue.level === 'error' && governedIssue.severity === 'blocker' && governedIssue.repairability === 'llm_repairable') return true;
  if (/提示词要求|疑似提示词指令标题|适用性自相矛盾|不得出现/u.test(issue.message)) return true;
  // ── 4.55.29 L1-5 白名单放行修正（逐条依据，撤销「检测到但不阻断」的后门）─────────────
  // ① 目录与正文不一致（tocBodyConsistencyIssues）：正文/目录编号与名称漂移是评标硬扣分点，
  //    且已有确定性修复器（fixTocFromBody / toc-consistency 兜底）——检测到即阻断，交修复轮收敛。
  // ② 生成后事实反查失败：生产者（documentFactTrace.numericTraceabilityIssues）已显式标注
  //    severity=blocker + category=evidence_coverage + repairability=llm_repairable，属修复链
  //    （numericVerification）收敛范围；「未溯源数值不阻断交付」的旧产品口径正是编造数值出闸的通道。
  // ③ 规划小节正文过短（正文 1–179 字）：空洞小节必须补写，由补写轮/内容深度修复轮收敛；
  //    与 G 线 P0-5「正文篇幅明显低于目标即阻断」同向。
  // ④ 证据使用覆盖率偏低：不再由消息文本整体放行，改为**按等级**——error 进阻断集，warning 仅告警
  //    （唯一生产者 documentDeliveryReport 是 warning 级粗判据：整篇是否提及某类事实，误报面大，
  //    且该指标是内容侧（事实落位）目标而非可立即收敛的缺陷，保留告警语义）。
  if (/配置要求缺少必要内容/u.test(issue.message)) return issue.level === 'error';
  if (/小节内容补写未完成|空小节|小节只有标题|生成未完成/u.test(issue.message)) return true;
  if (/工序规格冲突/u.test(issue.message)) return issue.level === 'error';
  if (/项目特点、重点、难点分析 正文不足|项目主要施工内容 正文不足/u.test(issue.message)) return true;
  if (/证据使用覆盖率偏低/u.test(issue.message)) return issue.level === 'error';
  // ⑤ 事实一致性冲突：项目名称 —— 4.55.29 L1-5 未纳入本轮（该族消息由事实模型层 L0 统一升级处置，
  //    属 manual_review 标注：检测器报出即入人工复核清单，不静默）。此处行为保持原状，待 L0 口径落地后一并收紧。
  if (/事实一致性冲突：项目名称/u.test(issue.message)) return false;
  if (/跨章一致性|专业评分不足|专业缺口|泛化套话|缺少关键线路|缺少材料验收|缺少风险识别|缺少进场/u.test(issue.message)) return issue.level === 'error' && !/章节逻辑依赖不足|文档交付评分报告/u.test(issue.message);
  if (!isExportBlockingIssue(issue)) return false;
  // G 线 P0-5：内容充足性信号恢复硬阻断。此前「正文篇幅明显低于目标 / 正文存在空泛占位表达 /
  // 结构化事实读取不足 / 正文可能未显式覆盖 / 仅包含文件类型和占位符」被显式豁免出阻断集，
  // 而它们正是「素材不足却照常交付」的直接表现——按验收基准（素材不足必须明确失败、不产出
  // 降级内容），这五项一律阻断。仅保留流程阶段名与范围声明的放行。
  if (/章节审查|最终质量审查|不在本次招标范围内/u.test(issue.message)) return false;
  return true;
}

/**
 * 同章内同名小节重复检测：主题块/补写链路反复追加同名 H4 小节（真实生成缺陷：1.4 出现 4 个“工程难点分析”、2.14 出现 4 个隐蔽验收主题小节），
 * 归一化去编号/空白后同章重复 ≥2 次给出合并/重命名建议。
 * 4.40 d5d 扩展二级小节（H3）同名：LLM 把同一主题小节写两遍（舒城实测 10.1/10.5「分区落实与临时道路流线」
 * 目录与正文重复堆叠）此前不在检测范围——同一性键与装配层 L5 同名降级/确定性合并修复器
 * （dedupeDuplicateSectionHeadings）单源；确定性命中后本检测器只负责残留兜底。
 * round-20 S6：level warning → error——目录重复堆叠是青天规范硬扣分点（首次徽光阁实测 7 组同名 H4 仅 warning 永不修复），
 * error 化后进入交付阻断修复链（duplicate-subsection 分支）自动合并。
 */
export function headingDuplicateIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const chapterParts = markdown.split(/^##\s+/gmu).slice(1);
  for (const part of chapterParts) {
    const lines = part.split(/\r?\n/u);
    const chapterTitle = (lines.shift() || '').trim();
    const counts = new Map<string, number>();
    const sectionCounts = new Map<string, number>();
    for (const line of lines) {
      // 4.40 d5d：二级小节（###）同名计数（带编号与无编号一律纳入——编号由出现序重排，同名即目录重复堆叠）
      const sectionMatch = /^###\s+(.+)$/u.exec(line.trim());
      if (sectionMatch) {
        const sectionKey = sectionHeadingIdentityKey(sectionMatch[1]);
        if (sectionKey.length >= 2) sectionCounts.set(sectionKey, (sectionCounts.get(sectionKey) || 0) + 1);
      }
      const headingMatch = /^####\s+(.+)$/u.exec(line.trim());
      if (!headingMatch) continue;
      // 带编号 H4（「2.1.1 施工流程」）由编号保证目录唯一性：分项工程小节去编号后同名属正常结构，
      // 不判重复（误报实锤：第二章 26 个分项 61 个编号 H4 被误报「施工流程出现 21 次」，触发无效修复轮）；
      // WS1 例外：编号 H4 名命中结构标签黑名单（「施工概况/施工流程/施工方法」）不再豁免——
      // 标签独立成题即违规（与 templatedLabelIssues 同源判定），按核心名计重复交修复轮合并/重命名；
      // 无编号 H4 去编号后同名仍判重复（历史缺陷：同章 4 个无编号「工程难点分析」）
      const rawName = headingMatch[1];
      const numbered = /^\d+(?:\.\d+)*/u.test(rawName);
      if (numbered && !isStructuralLabelTitle(rawName)) continue;
      const key = numbered ? normalizeSubsectionTitleForDedup(rawName) : rawName.replace(/\s+/gu, '');
      if (key.length < 2) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [name, count] of sectionCounts) {
      if (count < 2) continue;
      issues.push({ level: 'error', message: `${chapterTitle || '某章'} 存在同名小节重复：“${name}”出现 ${count} 次`, suggestion: '同主题内容应合并为一个小节；若确为不同方面，请重命名标题以区分内容，避免目录重复堆叠。' });
      if (issues.length >= 6) return issues;
    }
    for (const [name, count] of counts) {
      if (count < 2) continue;
      issues.push({ level: 'error', message: `${chapterTitle || '某章'} 存在同名小节重复：“${name}”出现 ${count} 次`, suggestion: '同主题内容应合并为一个小节；若确为不同方面，请重命名标题以区分内容，避免目录重复堆叠。' });
      if (issues.length >= 6) return issues;
    }
  }
  return issues;
}

/** 评分条目标题的框架停用词（核心词提取时剔除，精确匹配整词） */
const CRITERIA_CORE_STOP_WORDS = new Set(['如有', '应用', '措施', '体系', '管理', '保障', '要求', '内容', '工程', '项目', '施工']);

/** 招标评分条目标题 → 核心关键词集：去框架前缀/括号/尾缀后按顿号及与切分，供正文命中检查 */
export function evaluationCriteriaCoreKeywords(title: string): string[] {
  const cleaned = title
    .replace(/^拟采用/u, '').replace(/^针对/u, '').replace(/^确保/u, '')
    .replace(/[（(][^）)]*[）)]/gu, '')
    .replace(/的保障体系与措施$|管理体系与措施$|保障体系与措施$/u, '')
    // 剥离残余条款编号（4.12.12：条目「1.1发包人委派的…」被提取清洗为「1发包人…」后，
    // 正文标题与核心词因编号残留「1」词面不匹配误报未承接——核心词口径与标题清洗口径对齐）
    .replace(/^\d{1,3}(?:[.、．]\d{1,3})*\s*/u, '')
    .trim();
  return cleaned.split(/[、，,；;及与和]+/u)
    .map(part => part.replace(/^[的了者]+/u, '').trim())
    .filter(part => part.length >= 2 && !CRITERIA_CORE_STOP_WORDS.has(part));
}

/**
 * 招标评分条目正文承接后置校验：已提取的评审条目若核心关键词在最终正文 0 次出现，报 warning。
 * 前置补小节只能保证大纲覆盖，主题块规划/成稿阶段仍可能把补入小节合并丢失（历史缺陷：
 * “拟采用的新技术、新工艺”整篇 0 次出现），后置命中检查是承接链的最后一道兑底。
 * round-14 零误伤：词面未命中时由 bge 语义相似度兑底（变体表述不误报）；调用方未提供相似度函数时
 * 仅词面命中判定，宁漏报不误报。
 */
export function evaluationCriteriaCoverageIssues(
  markdown: string,
  items: string[],
  options: { semanticSimilarity?: SemanticSimilarityFn } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const normalized = markdown.replace(/\s+/gu, '');
  const chapterLines = options.semanticSimilarity
    ? markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => line.trim().replace(/^#{2,4}\s+/u, '').replace(/^\d+(?:\.\d+)*[\s、.]+/u, '').trim()).filter(Boolean).slice(0, 80)
    : [];
  // 4.55.22 根修盲区：原 `items.slice(0, 8)` **静默截断检测输入**——评分表 15 条时，
  // 第 9 条起永远不被检查（且全条只出 warning，导出与人工复核清单都不收），
  // 「第 9~15 项完全未响应」在整条链上零检出。限幅属展示层职责，检测不得截断。
  for (const item of items) {
    const keywords = evaluationCriteriaCoreKeywords(item);
    if (keywords.length === 0) continue;
    if (keywords.some(keyword => normalized.includes(keyword))) continue;
    // 语义兑底：核心词词面未命中时，条目标题与章节标题的 bge 余弦 ≥0.6 视为已承接（变体表述不误报）
    if (options.semanticSimilarity && chapterLines.length > 0) {
      const best = Math.max(...chapterLines.map(line => options.semanticSimilarity!(item, line)));
      if (best >= 0.6) continue;
    }
    issues.push({ level: 'warning', severity: 'warning', message: `招标文件评分条目“${item}”未在正文中出现（核心词：${keywords.join('/')}）`, suggestion: '评审条目必须逐条承接为正文小节；请补写对应内容并确保核心关键词落位，避免评标失分。' });
  }
  return issues;
}

/**
 * 内部术语泄漏保险丝（词面标记，不做替换）：后台概念流入正式正文属交付级低级错误，
 * 术语改写是语义动作必须由 Repairer 按上下文完成（如“工作包”按语境改写为“拆除工程/专业工程”），
 * 这里只做词面标记触发修复循环；若仍残留则硬阻断，绝不静默放行（真实生成缺陷：“拆除工程工作包”标题进入交付稿未被任何评分发现）。
 */
export function internalTerminologyIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (/工作包/u.test(markdown)) {
    issues.push({ level: 'error', severity: 'blocker', category: 'format', owner: 'system', message: '正式正文仍包含后台内部术语“工作包”，需要按上下文语义改写为正式术语', suggestion: '请结合语境改写：“拆除工程工作包”→“拆除工程”，“按工作包逐项说明”→“按专业工程逐项说明”；禁止出现生成系统后台概念。', provenance: { detectorId: 'internal-terminology-anchor', fingerprint: stableHash(markdown) } });
  }
  return issues;
}

/**
 * 四新技术后置承接检查（小节成稿结构检查，不做关键词语义判断）：施工组织设计大纲通过标准模块挂靠
 * 承诺了四新小节（如“新技术、新工艺、新材料、新设备的应用”），最终正文必须有对应小节标题且正文成稿
 * （承诺小节在主题块合并/降级中丢失的真实缺陷）；大纲未承诺时不制造新义务（避免对未要求的文档类型误报）。
 * 成稿但内容空洞的风险由事实密度/闭环句式/Reviewer 维度覆盖，此处不越界做语义判断。
 */
export function innovationTechCoverageIssues(markdown: string, outlineChapters: Array<{ title?: string; sections?: string[] }>): ValidationIssue[] {
  const committedSections = (outlineChapters || []).flatMap(chapter => (chapter.sections || []).filter(section => /新技术|新工艺|新材料|新设备|四新/u.test(section)));
  if (committedSections.length === 0) return [];
  const issues: ValidationIssue[] = [];
  // 合并成稿兜底：正文常把承诺的多个四新细化小节（新技术/新工艺/新材料/新设备的应用）合并为
  // “四新技术应用管理”等单一成稿小节（主题块合并是合法设计），逐个小节标题 fuzzy 匹配必然失败，
  // 会误报“0 字”（十四度实测：正文 2.14.1 四新技术应用管理已成稿仍被报未成稿）。
  // 承诺仍未兑现的判定不受影响：正文无任何“四新”小节成稿时兜底不生效，照常报 warning。
  const mergedBody = extractSection(markdown, '四新', { fuzzy: true });
  const mergedLength = mergedBody ? documentTextLength(mergedBody) : 0;
  for (const sectionTitle of [...new Set(committedSections)]) {
    const body = extractSection(markdown, sectionTitle, { fuzzy: true });
    if (!body || documentTextLength(body) < 200) {
      if (mergedLength >= 200) continue;
      issues.push({ level: 'warning', severity: 'warning', message: `大纲承诺小节“${sectionTitle}”未在正文成稿（正文 ${body ? documentTextLength(body) : 0} 字，要求不少于 200 字）`, suggestion: '请补写四新技术应用小节成稿，落位本项目适用的创新工艺、新材料与新设备应用计划。' });
    }
  }
  return issues;
}

/**
 * 门禁硬判定项（G 线 P0-2）：checklist 里**不依赖 issues 集合**的确定性判据。
 *
 * 其余项（no_errors / structured_precision / no_project_contamination / numeric_consistency）
 * 的判定本身就走 issues，已由 blockingIssues 覆盖；manual_postprocess 为人工兜底项，按设计不阻断。
 * 本清单只列「checklist 独有、且必须参与 passed 判定」的项 —— 缺了它们，
 * 检索全空 / 事实全空 / 正文含「资料未提供」占位时门禁仍会通过。
 */
const GATING_CHECKLIST_KEYS: readonly string[] = ['basic_facts', 'source_traceability', 'chapter_evidence', 'no_missing_content'];

export function buildExportGate(issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[]): ExportGateResult {
  const governedIssues = issues.map(classifyValidationIssue);
  /**
   * 人工兜底项豁免（F4）：封面/页眉/页脚/附图等**后期人工完善**的内容不作为导出门禁阻断项，
   * 修复循环同样不消费预算处理该类缺陷；仅在 checklist 中展示供人工跟进。
   *
   * 4.55.22 根修：原判据是**消息关键词**正则 `/封面|页眉|页脚|附图|图片引用|CAD图|示意图|插图/`
   * —— 任何 error 的 message 只要**引述**了这些词（如「第 3 章示意图引用无对应图件」）就会被
   * 静默移出硬阻断，即一条以消息文本为键的放行通道。现改为**锚定前缀白名单**：
   * 只有下列"内容本身就属于封面类后期完善项"的消息才豁免，引述型消息不再被误放行。
   */
  const MANUAL_POSTPROCESS_MESSAGE_PREFIXES: readonly string[] = [
    '正文缺少提示词要求的封面',
    '正文残留封面内容',
  ];
  const isManualPostprocessIssue = (message: string): boolean =>
    MANUAL_POSTPROCESS_MESSAGE_PREFIXES.some(prefix => message.startsWith(prefix));
  const hardBlockingIssues = governedIssues.filter(issue => issue.level === 'error' && classifyBlockingIssue(issue) && !isManualPostprocessIssue(issue.message));
  const manualPostprocessIssues = governedIssues.filter(issue => issue.level === 'error' && isManualPostprocessIssue(issue.message));
  // V2 批3 门禁升级（宁缺毋假）：category 白名单 → 黑名单式全量阻断——凡通过 isHardExportBlockingIssue
  // 的 error（含 category 直通与消息白名单校准后的残留）一律硬阻断，不再按旧 category 白名单
  // （structure/style/fact_consistency）二次过滤。旧白名单与 hasBody 开关会静默放行
  // table/format/scope/evidence_coverage/professional_chain/control_loop 类真缺陷（带病交付根因之一）；
  // 显式豁免仅保留人工兜底类（MANUAL_POSTPROCESS_ISSUE_RE：封面/页眉页脚/附图等后期人工完善项）。
  const blockingIssues = hardBlockingIssues;
  const checklist = [
    { key: 'no_errors', label: '无阻断级校验错误', passed: blockingIssues.length === 0 },
    { key: 'basic_facts', label: '基础事实齐全', passed: factsModel.project.length > 0 },
    { key: 'source_traceability', label: '事实具备来源追踪', passed: [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety].every(fact => Boolean(fact.sourceFile)) },
    { key: 'structured_precision', label: '结构化精确参数已使用', passed: factsModel.preciseFacts.length < PRECISE_FACT_MIN_TOKEN_COUNT || issues.every(issue => issue.level !== 'error' || !EXPORT_GATE_PRECISION_ISSUE_RE.test(issue.message)) },
    { key: 'chapter_evidence', label: '章节均具备证据', passed: chapters.every(chapter => chapter.evidence.length > 0) },
    { key: 'no_missing_content', label: '无资料未提供章节', passed: chapters.every(chapter => !chapter.content.includes('资料未提供')) },
    { key: 'no_project_contamination', label: '无项目污染和事实一致性阻断', passed: !issues.some(issue => issue.level === 'error' && EXPORT_GATE_PROJECT_CONTAMINATION_RE.test(issue.message) && classifyBlockingIssue(issue)) },
    // 数字级口径不一致（建设规模/估算价/工期与资料不符）属低级错误，导出门禁必须拦截
    { key: 'numeric_consistency', label: '跨章数值口径与资料一致', passed: !issues.some(issue => issue.level === 'error' && /跨章一致性冲突|跨章一致性缺口|跨章一致性复核/u.test(issue.message) && classifyBlockingIssue(issue)) },
    // 人工兜底项：封面/页眉/页脚/附图由后期人工完善，不阻断导出，仅展示跟进
    { key: 'manual_postprocess', label: `封面/页眉页脚/附图等 ${manualPostprocessIssues.length} 项由后期人工完善（不阻断导出）`, passed: true, message: manualPostprocessIssues.length ? manualPostprocessIssues.slice(0, 5).map(issue => issue.message).join('；') : undefined },
  ];
  // G 线 P0-2 门禁接线：checklist 里不依赖 issues 的确定性判据必须参与 passed 判定，
  // 并把未通过项转成显式阻断项（而非只展示）。此前 `passed` 只看 blockingIssues，于是
  // 「章节均具备证据」「无资料未提供章节」「基础事实齐全」「事实具备来源追踪」四项只展示、
  // 不判定 —— 检索全空、事实全空、正文含「资料未提供」占位时，门禁照常 passed: true。
  const checklistBlockers: ValidationIssue[] = checklist
    .filter(item => GATING_CHECKLIST_KEYS.includes(item.key) && !item.passed)
    .map(item => ({
      level: 'error' as const,
      severity: 'blocker' as const,
      category: 'evidence_coverage' as const,
      repairability: 'manual_review' as const,
      owner: 'user' as const,
      message: `交付门禁未通过：${item.label}`,
      suggestion: '该项由资料完备度决定，非正文改写可解：请补齐知识库对应资料并重新生成。',
    }));
  const allBlockingIssues = [...blockingIssues, ...checklistBlockers];
  // 4.55.22：人工复核项随门禁一并产出（声明 'manual' 的检测器发现），供交付报告「人工复核清单」展示
  const manualReviewIssues = manualDispositionIssues(governedIssues)
    .filter(issue => !allBlockingIssues.includes(issue));
  return { passed: allBlockingIssues.length === 0, blockingIssues: allBlockingIssues, checklist, manualReviewIssues };
}

export function fallbackEvaluatorForRule(rule: AutoDocumentSpecGateRule): GateRuleEvaluator {
  if (rule.evaluator) return rule.evaluator;
  return FALLBACK_GATE_EVALUATORS[rule.type]?.(rule) ?? { subject: 'document', operator: 'contains', value: rule.value || rule.target };
}

export function markdownTables(markdown: string) {
  const tableBlocks: string[] = [];
  const lines = markdown.split(LINE_SPLIT_RE);
  for (let index = 0; index < lines.length; index += 1) {
    if (!MARKDOWN_TABLE_ROW_RE.test(lines[index])) continue;
    const block: string[] = [];
    while (index < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[index])) {
      block.push(lines[index]);
      index += 1;
    }
    index -= 1;
    if (block.some(line => MARKDOWN_TABLE_DIVIDER_RE.test(line))) tableBlocks.push(block.join('\n'));
  }
  return tableBlocks;
}

export function markdownImages(markdown: string) {
  const images = [];
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    images.push({ alt: match[1] || '', url: match[2] || '', index: match.index ?? 0 });
  }
  return images;
}

export function safeRegex(value: string) {
  try { return new RegExp(value, 'iu'); } catch { return undefined; }
}

export function issueMessage(rule: AutoDocumentSpecGateRule, detail: string) {
  return `${rule.name}：${detail}`;
}

export function duplicateBasicInfoIssues(markdown: string): ValidationIssue[] {
  const chapterMatches = [...markdown.matchAll(CHAPTER_HEADING_RE)];
  const issues: ValidationIssue[] = [];
  for (let index = 1; index < chapterMatches.length; index += 1) {
    const start = chapterMatches[index].index || 0;
    const end = chapterMatches[index + 1]?.index ?? markdown.length;
    const content = markdown.slice(start, end);
    if (DOCUMENT_BASIC_INFO_BLOCK_RE.test(content)) {
      issues.push({ level: 'warning', message: `第 ${index + 1} 章可能重复出现基础信息`, suggestion: '如该信息与本章主题无关，建议合并到更合适的概况类章节，避免重复铺陈。' });
    }
  }
  if (chapterMatches.length === 0) return issues;
  const firstStart = chapterMatches[0].index || 0;
  const firstEnd = chapterMatches[1]?.index ?? markdown.length;
  const firstChapter = markdown.slice(firstStart, firstEnd);
  const tableIndex = firstChapter.search(DOCUMENT_BASIC_INFO_TABLE_RE);
  if (tableIndex <= 0) return issues;
  const beforeTable = firstChapter.slice(0, tableIndex).replace(MARKDOWN_SECTION_HEADING_RE, '');
  const repeatedFields: string[] = [];
  for (const field of DOCUMENT_BASIC_INFO_FIELDS) {
    if (new RegExp(`${field}\\s*[：:]`, 'u').test(beforeTable)) repeatedFields.push(field);
  }
  if (repeatedFields.length >= 3) issues.push({ level: 'warning', message: `基础信息表前重复叙述字段：${repeatedFields.join('、')}`, suggestion: '基础信息已表格化时，表格前只保留一句引导语，不要重复逐项叙述名称、编号、范围、周期、质量等字段。' });
  return issues;
}

/**
 * 模板化前缀/导语检测（D-T7 ①，r28f #35 归因）：判定单源 isTemplatePrefixSentence
 * （tenderBidChecks——句首词表确定性：「本节/本章将…」元话语导语即命中）。
 * 4.28 前为 4 条语义原型 0.6 余弦口径——r28f 实测命中样本 3/3 全误报
 * （「1.2 主要施工内容」标题残片与砌筑/铺贴工艺句被 bge 噪声误判为前缀套话，句首并无元话语），
 * 现改为词面前置确定性判定，与修复端 templatePrefixTargets 同源同池（检测定位＝修复定位）。
 * 句池单源 scanTemplatePrefixSentences（tenderBidChecks：零宽剥离 + 排除行过滤 + ≥12 字 + 词首判定），
 * 与修复锚点端 templatePrefixTargets、修复回滚复检三端同口径（检测定位＝修复定位）。
 */
export async function formalStyleIssues(markdown: string): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const sentences = scanTemplatePrefixSentences(markdown);
  if (sentences.length > 0) issues.push({ level: 'warning', message: `存在模板化前缀或套话：${sentences.slice(0, 3).join('、')}`, suggestion: '请删除“本节/本章将/以下从”等前缀，标题后直接进入对象、动作、措施、检查和闭环。' });
  // 后台话术为专有名词泄漏（OCR/提示词/后台等词字面出现即违规），保留词面精确召回
  const backstage = markdown.match(/OCR|提示词|绑定片段|后台|文件路径|识别错误|知识库证据|知识库已确认事实|通用兜底段落|兜底占位|兜底模板/giu);
  if (backstage?.length) issues.push({ level: 'warning', message: `正文包含后台或资料处理话术：${[...new Set(backstage)].join('、')}`, suggestion: '建议改为正式文档语言，例如“资料文字不清”“资料口径不一致”“项目资料”，不得暴露后台处理过程。' });
  return issues;
}

/** 重复主题小节分桶单源（D-T7 ②）：检测端 minChapterSectionIssues 与修复端
 * mergeDuplicateThematicSections（globalQualityGates，duplicate-theme-merge 轮）共用同一桶键——
 * 检测报出的「重复主题小节」与修复端需要合并的小节集合完全一致，消除两端口径分叉。 */
export function classifyThematicSectionKey(section: string): string {
  return /劳动力|人员|工种/u.test(section) ? '劳动力计划' : /机械|设备|机具/u.test(section) ? '机械设备计划' : /材料|物资/u.test(section) ? '材料物资计划' : /冬季|雨季|高温|台风|大风/u.test(section) ? '特殊气候措施' : '';
}

export function minChapterSectionIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'sections'>>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const sections = (chapter.sections || []).filter(Boolean);
    const duplicates = sections.filter((section, index) => sections.indexOf(section) !== index);
    if (duplicates.length > 0) issues.push({ level: 'warning', message: `${chapter.title} 存在重复小节：${[...new Set(duplicates)].join('、')}`, suggestion: '请保留用户需求、模板或显式大纲中真实需要的小节，删除重复项。' });
    const thematic = new Map<string, string[]>();
    for (const section of sections) {
      const key = classifyThematicSectionKey(section);
      if (key) thematic.set(key, [...(thematic.get(key) || []), section]);
    }
    for (const [key, values] of thematic) {
      if (values.length > 1) issues.push({ level: 'warning', message: `${chapter.title} 存在重复主题小节：${key}（${values.join('、')}）`, suggestion: '请合并同类小节，只保留一个主表或主方案，其他位置采用引用或执行说明。' });
    }
  }
  return issues;
}

export function tocHierarchyIssues(markdown: string): ValidationIssue[] {
  const match = TOC_BLOCK_RE.exec(markdown);
  if (!match) return [{ level: 'error', message: '缺少目录页', suggestion: '请在封面后生成“## 目录”，并按一级章父级、二级小节子级组织。' }];
  let sectionCount = 0;
  let indentedSectionCount = 0;
  for (const line of match[1].split(LINE_SPLIT_RE)) {
    if (!NON_BLANK_RE.test(line) || !TOC_SECTION_LINE_RE.test(line)) continue;
    sectionCount += 1;
    if (TOC_INDENTED_SECTION_LINE_RE.test(line)) indentedSectionCount += 1;
  }
  if (sectionCount > 0 && indentedSectionCount === 0) {
    return [{ level: 'error', message: '目录二级小节未作为子级缩进', suggestion: '目录应为父子级导航：一级章单独成行，二级小节至少缩进两个空格列在所属章下方。' }];
  }
  return [];
}

function normalizeStructureTitle(title: string) {
  return title
    .replace(/^#+\s*/u, '')
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]\s*/u, '')
    .replace(/^\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/[（）]/gu, match => match === '（' ? '(' : ')')
    .replace(/[\s:：.。；;,，、]+$/gu, '')
    .replace(/的(?=保障体系|管理体系|控制体系|措施|方案|计划|要求)/gu, '')
    .replace(/[\s()（）:：.。；;,，、-]/gu, '')
    .trim();
}

function collectTocSectionEntries(markdown: string) {
  const match = TOC_BLOCK_RE.exec(markdown);
  if (!match) return [];
  return match[1].split(LINE_SPLIT_RE)
    .map(line => /^\s*(\d+\.\d+)\s+(.+)$/u.exec(line.trim()))
    .filter((matchItem): matchItem is RegExpExecArray => Boolean(matchItem))
    .map(matchItem => ({ number: matchItem[1] || '', title: normalizeStructureTitle(matchItem[2] || '') }))
    .filter(entry => entry.title);
}

function collectBodySectionEntries(markdown: string) {
  // 只收集 H3 节标题（### X.Y）：finalize 归一后正文二级小节统一为 ###，H4（工作包/三级小节）
  // 一律是 #### X.Y.Z 三位编号，不得计入节集合，否则目录与正文节数守恒校验会被工作包 H4 干扰
  return [...markdown.matchAll(/^###\s+(\d+\.\d+)\s+(.+)$/gmu)]
    .map(match => ({ number: match[1] || '', title: normalizeStructureTitle(match[2] || '') }))
    .filter(entry => entry.title);
}

export function tocBodyConsistencyIssues(markdown: string): ValidationIssue[] {
  const tocEntries = collectTocSectionEntries(markdown);
  const bodyEntries = collectBodySectionEntries(markdown);
  // 4.55.22 根修盲区：原判据「目录条目空 **或** 正文条目空 → 整体 return []」，
  // 于是**只列章名、不列小节**的目录（「## 目录 / 第一章 工程概况 / 第二章 …」）逃过下面
  // 全部守恒与编号对应校验（collectTocSectionEntries 只认 `X.Y` 行 → 0 条 → 早退）。
  // 正文有节而目录无节 = 目录粒度不符，必须报；正文本身无节才真正无可校验。
  if (bodyEntries.length === 0) return [];
  if (tocEntries.length === 0) {
    // 无「## 目录」区段时不在此报（由 formal-content-integrity 的「缺少目录页」负责，避免重复报同一事实）
    if (!/^#{1,6}\s*目录\s*$/mu.test(markdown)) return [];
    return [{
      level: 'error',
      message: `目录未列出正文小节：正文有 ${bodyEntries.length} 个二级小节，而目录未列任何小节条目（只列到章名）`,
      suggestion: '目录必须按正文二级小节逐条列出「编号 + 标题」，不得只列章名；目录小节数量与编号须与正文全集一致。',
    }];
  }
  const tocTitles = tocEntries.map(entry => entry.title);
  const bodyTitles = bodyEntries.map(entry => entry.title);
  const bodySet = new Set(bodyTitles);
  const tocSet = new Set(tocTitles);
  const missingInBody = tocTitles.filter(title => !bodySet.has(title));
  const missingInToc = bodyTitles.filter(title => !tocSet.has(title));
  const issues: ValidationIssue[] = [];
  if (missingInBody.length > 0) issues.push({ level: 'error', message: `目录与正文不一致，目录小节未在正文中找到：${[...new Set(missingInBody)].join('、')}`, suggestion: '建议以最终清洗后的正文二级标题为准重新生成目录。' });
  if (missingInToc.length > 0) issues.push({ level: 'error', message: `目录与正文不一致，正文小节未进入目录：${[...new Set(missingInToc)].join('、')}`, suggestion: '建议重新生成目录，确保正文二级小节完整进入目录。' });
  // 4.19 编号归一根治：此前只比对去编号后的标题名集合，编号错位（正文 4.2 重复、4.6 缺失、
  // 目录 4.4 与正文 4.4 名称不一致）永远抓不到。新增「编号↔名称」对应校验与节数守恒。
  const bodyByNumber = new Map(bodyEntries.map(entry => [entry.number, entry.title]));
  const tocNumberSet = new Set(tocEntries.map(entry => entry.number));
  const mismatched = tocEntries.filter(entry => bodyByNumber.has(entry.number) && bodyByNumber.get(entry.number) !== entry.title);
  const orphanBody = bodyEntries.filter(entry => !tocNumberSet.has(entry.number));
  if (tocEntries.length !== bodyEntries.length) issues.push({ level: 'error', message: `目录与正文小节数量不一致：目录 ${tocEntries.length} 节、正文 ${bodyEntries.length} 节`, suggestion: '正文 H3 编号必须连续单调且与目录一一对应；出现重复编号、跳号或丢节时以正文实际结构重建目录。' });
  if (mismatched.length > 0) issues.push({ level: 'error', message: `目录与正文同一编号对应不同小节：${mismatched.slice(0, 5).map(entry => `${entry.number} 目录「${entry.title}」/正文「${bodyByNumber.get(entry.number)}」`).join('、')}`, suggestion: '目录必须按正文 H3 实际编号与标题生成，同一编号不得对应不同小节名称。' });
  if (orphanBody.length > 0) issues.push({ level: 'error', message: `正文小节编号未出现在目录中：${orphanBody.slice(0, 5).map(entry => `${entry.number} ${entry.title}`).join('、')}`, suggestion: '目录编号与正文编号必须全集一致。' });
  return issues;
}

/**
 * L5 结构完整性门禁（终检注册）：正文 H3 小节编号连续性——每章内 `### X.Y` 的章号 X 必须等于实际章序、
 * 节号 Y 从 1 起连续递增（无跳号、无重复、无章号错位）；缺号=blocker。
 * 历史缺陷：重复块 H3→H4 降级合并占用 H3 编号后成稿出现 2.15/2.17/2.18/2.20/2.21/2.24 跳号；
 * markdownComposer 归一已把「降级不消耗编号」固化（降级 = 同帧重排），本检测器为交付前兜底——
 * 任何新的静默降级/丢节路径都会在此以 blocker 暴露，禁止静默降级。
 * 目录编号由最终正文 H3 提取（ensureFormalToc），正文连续即目录连续；目录↔正文一致性由 tocBodyConsistencyIssues 管辖。
 */
export function sectionNumberingIssues(markdown: string): ValidationIssue[] {
  const chapters: Array<{ ordinal: number; title: string; numbers: number[]; prefixNumbers: number[] }> = [];
  let current: (typeof chapters)[number] | undefined;
  for (const rawLine of markdown.split(LINE_SPLIT_RE)) {
    const line = rawLine.trim();
    const chapter = /^##\s+第[一二三四五六七八九十百千万\d]+章\s+(.+)$/u.exec(line);
    if (chapter) {
      current = { ordinal: chapters.length + 1, title: (chapter[1] || '').trim(), numbers: [], prefixNumbers: [] };
      chapters.push(current);
      continue;
    }
    const section = /^###\s+(\d+)\.(\d+)\s+/u.exec(line);
    if (!section || !current) continue;
    current.prefixNumbers.push(Number(section[1]));
    current.numbers.push(Number(section[2]));
  }
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    if (chapter.numbers.length === 0) continue;
    const prefixCounts = new Map<number, number>();
    for (const number of chapter.prefixNumbers) prefixCounts.set(number, (prefixCounts.get(number) || 0) + 1);
    // 消息显示前缀：多数派实际编号前缀优先（章号错位时正文实际编号比章序更贴合正文事实，
    // 用章序拼接会出现「报告 1.16、正文没有 1.x 编号」的误导消息）
    const labelPrefix = [...prefixCounts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? chapter.ordinal;
    const strayPrefixes = [...new Set(chapter.prefixNumbers.filter(number => number !== chapter.ordinal))].sort((left, right) => left - right);
    if (strayPrefixes.length > 0) {
      issues.push({
        level: 'error', severity: 'blocker', category: 'structure',
        message: `小节编号章号错位：第${chapter.ordinal}章「${chapter.title}」内出现 ${strayPrefixes.slice(0, 8).map(number => `${number}.x`).join('、')} 编号小节（应为 ${chapter.ordinal}.x）`,
        suggestion: `正文二级小节编号必须为「章序.节序」；按章序重排本章 H3 编号（降级 H4 不占 H3 编号）。`,
      });
    }
    const counts = new Map<number, number>();
    for (const number of chapter.numbers) counts.set(number, (counts.get(number) || 0) + 1);
    const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([number]) => number).sort((left, right) => left - right);
    if (duplicates.length > 0) {
      issues.push({
        level: 'error', severity: 'blocker', category: 'structure',
        message: `小节编号重复：第${chapter.ordinal}章「${chapter.title}」${duplicates.slice(0, 8).map(number => `${labelPrefix}.${number}`).join('、')} 重复出现`,
        suggestion: '同章内同一小节编号只允许出现一次；重复编号为降级合并残留，按正文实际小节顺序重排编号。',
      });
    }
    const maxNumber = Math.max(...chapter.numbers);
    const missing = Array.from({ length: maxNumber }, (_, index) => index + 1).filter(number => !counts.has(number));
    if (missing.length > 0) {
      issues.push({
        level: 'error', severity: 'blocker', category: 'structure',
        message: `小节编号缺号：第${chapter.ordinal}章「${chapter.title}」缺 ${missing.slice(0, 8).map(number => `${labelPrefix}.${number}`).join('、')}（实有 ${counts.size} 个小节，最大编号 ${labelPrefix}.${maxNumber}）`,
        suggestion: '小节编号必须从 1 起连续；缺号源自降级合并占用编号或丢节，按正文小节顺序重排编号后同步重建目录。',
      });
    }
  }
  return issues;
}

function isInstructionLikeStructureTitle(value: string) {
  const rawTitle = value
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^\s*\d+(?:\.\d+)*(?:[.．、]|\s)+/u, '')
    .replace(/^第[一二三四五六七八九十百千万\d]+[章节篇部分]\s*/u, '')
    .trim();
  const displayTitle = displayChapterTitle(rawTitle);
  const instructionTitleRe = /^(?:\d+(?:\.\d+)*\s*)?(?:[-—–]\s*)?(?:(?:判断|判定|识别|确认)?是否(?:涉及|涉|需要|适用).*|(?:如|若|如果)(?:涉及|不涉及|适用|不适用).*|.*(?:根据|结合).{0,12}(?:实际情况|项目情况|资料情况).{0,8}(?:判断|确定|编写|生成).*|.*(?:按需(?:生成|编写)|视情况|判断后|生成要求|编写要求|注意事项))\s*$/u;
  // 招标条款碎片/数据值泄漏/截断义务句式（舒城实测：「26元（保留两位小数）」「隐蔽工程验收：所有…必须由承包人按规定」）
  return instructionTitleRe.test(rawTitle) || instructionTitleRe.test(displayTitle)
    || isTenderClauseFragmentTitle(rawTitle) || isTenderClauseFragmentTitle(displayTitle);
}

export function instructionLikeHeadingIssues(markdown: string): ValidationIssue[] {
  const headings = [...markdown.matchAll(/^#{2,6}\s+(.+)$/gmu)]
    .map(match => displayChapterTitle(match[1] || ''))
    .filter(isInstructionLikeStructureTitle);
  return headings.length > 0 ? [{ level: 'error', message: `正文存在疑似提示词指令标题：${[...new Set(headings)].slice(0, 8).join('、')}`, suggestion: '请删除或改写为正式施工组织设计小节标题，目录也不得收录该类标题。' }] : [];
}

export function formalContentIntegrityIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = markdown.split(LINE_SPLIT_RE)
    .map(line => line.trim())
    .filter(line => line && !/^#{1,6}\s+/u.test(line) && !/^\s*\|/u.test(line) && !/^<div\b/iu.test(line));
  const orphan = lines.find(line => normalizeStructureTitle(line).length <= 1);
  if (orphan) issues.push({ level: 'warning', message: `正文存在孤立字或残缺段落：${orphan}`, suggestion: '请删除残缺行或重新生成所在小节。' });
  // 截断句词表（合肥师范实测：复查合格后/设计风/验收三处行尾截断）：
  // 正常成稿不会以这些词收尾且无句号；连接词/动作词/名词三类截断形态全部收口
  // B2 豁免（与确定性修复器 fixTruncatedSentenceArtifacts 同源同口径）：
  // Markdown 列表行（- 行、数字/括号列表行）行尾分号/冒号属列表合法形态，
  // 列表引导句（句尾冒号且含按以下/如下/包括/分为/包含/列出）是列表合法开场，均不得判截断
  const listLineRe = /^(?:[-*+]\s+|[（(]?\d+[）).、]\s*)/u;
  const listLeadInRe = /(?:按以下|如下|包括|分为|包含|列出).*[:：]$/u;
  // 4.32 冒号引导句豁免（丰乐镇 v6 复测 #52/53）：「拆除作业按“先确认、后切断、再拆除”的编号
  // 步骤组织：」「铺装面层施工按…的顺序组织：」+ 编号/项目符号列表是合法列表开场——行尾冒号
  // 且下一行为列表项即引导句；原词表只覆盖「如下/包括/分为…」形态，组织类引导句被误判截断
  const listLeadInColon = (index: number) => /[:：]$/u.test(lines[index]) && index + 1 < lines.length && listLineRe.test(lines[index + 1]);
  // 4.31 软换行豁免（丰乐镇 v6 实测 #67-69）：行尾为句读标点（，、；：）且下一行仍为普通正文
  // （非列表项）时属跨行软换行——LLM 长句在标点处折行续写（「…夯入土中；」+下一行正文），
  // 此前「；」等标点结尾行被一律判截断，段落自带折行被误报为 blocker
  const softWrapped = (index: number) => /[，、；：]$/u.test(lines[index]) && index + 1 < lines.length && !listLineRe.test(lines[index + 1]);
  const unfinished: string[] = [];
  for (let i = 0; i < lines.length && unfinished.length < 3; i += 1) {
    const line = lines[i];
    if (listLineRe.test(line) || listLeadInRe.test(line) || listLeadInColon(i) || softWrapped(i)) continue;
    if (/[，、；：和与在为对将]$/u.test(line) || /(通过|包括|如下|主要包括|验收|合格后|复查合格后|设计风|确认后|具体如下|应符合|不少于|以及|且应|不得少于)$/u.test(line)) unfinished.push(line);
  }
  for (const item of unfinished) {
    issues.push({ level: 'error', severity: 'blocker', category: 'format', owner: 'llm', repairability: 'llm_repairable', message: `正文存在疑似截断句：${item}`, suggestion: '请补完整该段落，避免以连接词、逗号、冒号或无句号的动作词结尾。' });
  }
  const longLine = lines.find(line => line.length > 380);
  if (longLine) issues.push({ level: 'warning', message: `正文存在过长段落：${longLine}`, suggestion: '请拆分为多段或表格，改善导出版式和可读性。' });
  const inlineList = lines.find(line => /\S.+(?:\s|[。；;])(?:\d+[.、](?=\s|\*\*)\s*|[（(]\d+[）)]\s*|[-*+]\s+)\S.+(?:\s|[。；;])(?:\d+[.、](?=\s|\*\*)\s*|[（(]\d+[）)]\s*|[-*+]\s+)\S/u.test(line) && !/\b\d+\.\d+\s*(?:mm|cm|m|㎡|m2|kg|t|MPa|kPa|V|KV|kV|A)\b/iu.test(line));
  if (inlineList) issues.push({ level: 'error', message: `正文存在列表项粘连同一行：${inlineList.slice(0, 120)}`, suggestion: '有序列表和无序列表必须逐项独占一行，确保 Markdown/PDF/DOCX 正确排版。' });
  // 清洗链（normalizeTenderSourcePageRefs/cleanInlineFactValue）已把完整页码引用（PDF 第N页）归一为
  // “相关资料”并删除残缺残片，最终校验文本中任何「PDF 第」形态都属清洗缺口，全部报出
  const sourcePageRef = markdown.match(/PDF\s*第\s*|(?:PDF\s*)?第\s*\d+\s*(?:[-—至到~～]\s*\d+)?\s*页|(?:图纸|清单|资料|文件|[\u4e00-\u9fa5A-Za-z0-9（）()、·-]{2,24}(?:工程)?)\s*(?:[（(]?\s*|(?:共|多达|约|合计)\s*)\d+\s*页|[\u4e00-\u9fa5A-Za-z0-9、及与和]{2,24}\s*(?:共|多达|约|合计)\s*\d+\s*页|\d+\s*页\s*(?:图纸|资料|文件|装饰|土建|加固|给排水|电气|智能化|消防)|\d+\s*页/iu)?.[0];
  if (sourcePageRef) issues.push({ level: 'error', message: `正文残留资料页码元信息：${sourcePageRef}`, suggestion: '正式投标正文应引用招标文件、施工图设计文件、工程量清单和相关专业图纸，不写 PDF 页码或资料页数。' });
  const internalTrace = lines.find(line => /仅作为内部事实提取依据|正式正文不得引用文件名|后台事实|内部事实/u.test(line));
  if (internalTrace) issues.push({ level: 'error', message: `正文残留内部处理说明：${internalTrace.slice(0, 120)}`, suggestion: '正式投标正文不得出现内部事实抽取、后台处理或文件名引用限制说明。' });
  return issues;
}

/**
 * 拼接/删节残留检测（十度实测缺陷：法规长列举句 LLM 输出自吞噬中间段——
 * 「2017年修正）、《中华人民共和国」整段丢失后「2017」与「安全生产法」直接拼接、
 * 「279号」残成「279订」、句子删除残留「。；」标点叠用，全部穿透既有防线带病交付）：
 * - 句读标点叠用（「。；」「；。」「。，」「，。」「。。」等，句号+引号「。”」天然不在字符类）：
 *   确定性修复器修得掉则 stage5 已修；检测残留即 error 阻断，防「修复器漏网形态」带病交付；
 * - 全角括号/书名号成对性：内容丢失拼接必然破坏成对性，零误伤强信号（文档级计数，报告不静默）；
 *   4.36 C1 后写时块级熔断已先拦截（structureIntegrityRules.scanPunctuationBalance，符号对定义单源），
 *   此处为终检安全网——能到达本检测说明写入侧链未收敛，内容已丢失无法确定性恢复，
 *   error 进修复轮由 LLM 重写所在句子/小节。
 */
export function punctuationArtifactIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = markdown.split(LINE_SPLIT_RE);
  const punctStackRe = /。{2,}|[！？；：，、]{2,}|。[！？；：，、]|[！？；：，、]。/u;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s+/u.test(trimmed) || /^\s*\|/u.test(trimmed) || /^<div\b/iu.test(trimmed)) continue;
    const match = punctStackRe.exec(trimmed);
    if (match) {
      const start = Math.max(0, match.index - 24);
      const context = `${trimmed.slice(start, match.index)}【${match[0]}】${trimmed.slice(match.index + match[0].length, match.index + match[0].length + 24)}`;
      issues.push({ level: 'error', severity: 'blocker', category: 'format', owner: 'llm', repairability: 'llm_repairable', message: `正文存在句读标点叠用（拼接/删节残留）：${context}`, suggestion: '相邻句读标点（如「。；」「；。」「。。」）是删节拼接残留或省略号误写，请重写该句。' });
    }
  }
  // 4.36 C1：符号对定义与写时块级扫描（structureIntegrityRules.scanPunctuationBalance）单源共用
  for (const { open, close, label } of PAIRED_PUNCTUATION_SYMBOLS) {
    const openCount = markdown.split(open).length - 1;
    const closeCount = markdown.split(close).length - 1;
    if (openCount === closeCount) continue;
    const locateLine = lines.find(line => (line.split(open).length - 1) !== (line.split(close).length - 1));
    issues.push({ level: 'error', severity: 'blocker', category: 'format', owner: 'llm', repairability: 'llm_repairable', message: `正文存在${label}不闭合（开 ${openCount} 处、闭 ${closeCount} 处，拼接/删节残留）：${locateLine?.trim().slice(0, 120) ?? ''}`, suggestion: `${label}成对性破坏是内容丢失拼接的确定性信号，请重写所在句子/小节，补齐或删除残缺部分。` });
  }
  return issues;
}

export function formalHeadingHierarchyIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  // P5 复选框符号残留检测：☑/✓ 等招标文件选项符号混入小节标题（目录「8.2 ☑电子保函」串章回归），
  // 大纲三通道清洗（outline.ts stripCheckboxSymbols）为前置防线，此处为成稿兑底——穿透时进修复循环
  {
    const pollutedHeadings = [...markdown.matchAll(/^#{2,4}\s+(.+)$/gmu)]
      .map(match => (match[1] || '').trim())
      .filter(title => /[☑✓✔☐□☒○●◉◇◆]/u.test(title))
      .slice(0, 6);
    if (pollutedHeadings.length > 0) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `小节标题残留复选框/选项符号（☑/✓ 等招标文件符号）：“${pollutedHeadings.join('”、“')}”`,
        suggestion: '删除标题中的复选框符号（☑✓✔☐□等）；标题主体若属商务文件内容（如“电子保函”），整个小节删除，技术标不得出现商务条款小节。',
      });
    }
  }
  const firstBodyChapter = markdown.search(/^##\s+第[一二三四五六七八九十百千万\d]+章\s+/mu);
  const bodyMarkdown = firstBodyChapter >= 0 ? markdown.slice(firstBodyChapter) : markdown.replace(/^##\s+目录[\s\S]*?(?=^##\s+第[一二三四五六七八九十百千万\d]+章\s+)/mu, '');
  const illegalH2 = [...bodyMarkdown.matchAll(/^##\s+(.+)$/gmu)]
    .map(match => (match[1] || '').trim())
    // r28h M5 附表管理：附表一~N 为系统直出文末附表区（composeAppendices，rebuildAndRecompute 终稿追加），
    // 与附录区同为非章节结构，不参与非法 H2 判定（此前 21/37 号 blocker 实测为该误报）
    .filter(title => title !== '目录' && !/^第[一二三四五六七八九十百千万\d]+章\s+/u.test(title) && !/^附录/u.test(title) && !/^附表\s*[一二三四五六七八九十\d]{1,3}/u.test(title))
    .map(title => displayChapterTitle(title));
  if (illegalH2.length > 0) issues.push({ level: 'error', message: `正文存在非正式章二级标题：${[...new Set(illegalH2)].slice(0, 8).join('、')}`, suggestion: '正文 ## 只允许用于“第X章”正式章标题；章内小节必须使用 ### X.Y。' });
  const chapterMatches = [...markdown.matchAll(/^##\s+(第[一二三四五六七八九十百千万\d]+章\s+.+)$/gmu)];
  for (let index = 0; index < chapterMatches.length; index += 1) {
    const start = chapterMatches[index].index || 0;
    const end = chapterMatches[index + 1]?.index ?? markdown.length;
    const block = markdown.slice(start, end);
    const sections = [...block.matchAll(/^###\s+\d+\.\d+\s+(.+)$/gmu)].map(match => displayChapterTitle(match[1] || ''));
    const chapterTitle = displayChapterTitle((chapterMatches[index][1] || '').replace(/^第[一二三四五六七八九十百千万\d]+章\s*/u, ''));
    if (sections.length === 1 && normalizeStructureTitle(sections[0]) === normalizeStructureTitle(chapterTitle)) {
      issues.push({ level: 'error', message: `章节只有一个且与章名同名的小节：${chapterMatches[index][1]}`, suggestion: '应拆分为多个业务小节，不能用章标题重复作为唯一二级小节。' });
    }
  }
  return issues;
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
 * C8 S4-③ 扩围（r28m' 维保台账实锤）：业务过程记录列（存在问题/整改措施/复查结果/备注等）的
 * 「无」是合法业务语义（无问题/无需整改/无补充），非内容缺失占位符——「存在问题=无、整改措施=无、
 * 复查结果=正常」3 行 6 处误报实锤；豁免限于「无」形态，其余占位词（若干/约/待定等）任何列不豁免。
 * 其余占位词（若干/约/待定等）在任何行任何列均不豁免；「无」仅在业务过程记录列豁免（C8 S4-③），
 * 破折号形态按上述列口径豁免。
 * r28f #42 归因：警告层此前用裸正则（无豁免口径），豁免列「—」被照报（实测 23 处误报）——统一到本判定。 */
export function isNonExemptTablePlaceholderCell(cell: string, refs: { rowFirstCell?: string; headerCell?: string; cellIndex: number }): boolean {
  if (!TABLE_PLACEHOLDER_CELL_FORMS_RE.test(cell) && !TABLE_PLACEHOLDER_APPROX_RE.test(cell)) return false;
  // C8 S4-③ 业务语义列豁免：「无」在过程记录列是业务判断结论（无问题/无整改），仅破折号形态豁免
  // 会报阻断——豁免列与生成端台账列名保持对齐（仅「无」类占位词豁免，不扩到模糊量词）
  if (refs.headerCell && /存在问题|整改措施|整改情况|复查结果|处理情况|检查情况|落实情况|验收结论|备注|说明/u.test(refs.headerCell) && /^无+$/u.test(cell)) return false;
  if (!/^(?:—+|-+)$/u.test(cell)) return true;
  if (refs.cellIndex > 0 && /^(?:合计|小计|总计|累计)/u.test(refs.rowFirstCell || '')) return false;
  // 4.55.22 用户口径收紧：**取消「规格型号/额定功率/生产能力/国别产地…」列的破折号豁免**。
  // 原豁免理由是「源资料不提供、强填诱导编造」（蛙式打夯机无型号，修复轮曾编造 HW-60），
  // 但实测该豁免正是用户终稿里**唯一**的占位来源（巢湖成稿 4 处「—」全在「规格型号」列）。
  // 现口径：该列必须写具体型号，或写招标/图纸给出的规格，或投标人自定的具体设备型号
  //（机械设备由投标人自行选型时，选型结论本身就是可写且必须写的值）——不得以「—」留空。
  return true;
}

/** 表格占位符非豁免命中扫描（D-T5）：表块解析与 markdownTableQualityIssues 同源（连续表格行且
 * 分隔线位于第二行；无分隔线/碎表由「表格分隔线位置不规范」独立阻断，不在此重复）。
 * 命中含表头/行首/列位/格值定位，供警告层定级与 patchGuard 片段预检消费。 */
export function scanTablePlaceholderCells(markdown: string): Array<{ header: string[]; rowFirstCell: string; cellIndex: number; cell: string }> {
  const hits: Array<{ header: string[]; rowFirstCell: string; cellIndex: number; cell: string }> = [];
  for (const block of markdownTables(markdown)) {
    const rows = block.split(LINE_SPLIT_RE).filter(line => MARKDOWN_TABLE_ROW_RE.test(line));
    if (rows.length < 2 || !MARKDOWN_TABLE_DIVIDER_RE.test(rows[1] || '')) continue;
    const cells = rows.map(line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => stripTableCellInvisibleChars(cell.trim())));
    const header = cells[0] || [];
    for (const row of cells.slice(2)) {
      for (let cellIndex = 0; cellIndex < row.length; cellIndex += 1) {
        const cell = row[cellIndex] || '';
        if (isNonExemptTablePlaceholderCell(cell, { rowFirstCell: row[0] || '', headerCell: header[cellIndex], cellIndex })) hits.push({ header, rowFirstCell: row[0] || '', cellIndex, cell });
      }
    }
  }
  return hits;
}

export function markdownTableQualityIssues(markdown: string): ValidationIssue[] {
  // 断行先合并再检测（E3 检测补盲）：单元格内换行的续行不以 | 开头，原样检测会被漏报；
  // 合并后“表格列数不一致”与“空单元格”检测在真实表格结构上运行
  markdown = mergeTableLineBreaks(markdown);
  const issues: ValidationIssue[] = [];
  // 单竖线残行检测（E3）：表格数据行整列丢失的残片（如“企业施工工艺标准 |”），
  // 合并层无法修复（只有单竖线无法判定续文），报告修复轮补齐或删除
  {
    const lines = markdown.split(LINE_SPLIT_RE);
    for (let index = 1; index < lines.length; index += 1) {
      const line = (lines[index] || '').trim();
      const prev = (lines[index - 1] || '').trim();
      const isLonePipeResidue = Boolean(line)
        && !/^\|/u.test(line)
        && line.endsWith('|')
        && (line.match(/\|/gu) || []).length === 1
        && !/^#{1,6}\s/u.test(line)
        && MARKDOWN_TABLE_ROW_RE.test(prev);
      if (isLonePipeResidue) {
        issues.push({ level: 'error', message: `表格断行残片：${line}`, suggestion: '该行是表格数据行整列丢失的残片：合并回所属表格行并补齐缺失列，或删除该残行。' });
      }
    }
  }
  if (/按审批确认执行/u.test(markdown)) issues.push({ level: 'error', message: '表格存在自动兜底污染内容：按审批确认执行', suggestion: '正式投标表格不得使用通用兜底短语，应保留真实业务内容或删除该行。' });
  // “信息项|内容”表头也被 Writer 用于工程量/设备参数汇总表，只有内容含项目基础信息字段的表才算“基础信息表”；
  // 直接按表头计数会把第三章的工程量汇总表误判为“基础信息重复”。
  const basicInfoTableBlocks: string[] = [];
  for (const match of markdown.matchAll(/\|\s*信息项\s*\|\s*内容\s*\|/gu)) {
    const rest = markdown.slice(match.index || 0);
    // 只收集表格行：表格后紧跟标题/正文时不得并入（否则段落中的“计划工期”等词会误判为基础信息表重复）
    const tableLines: string[] = [];
    for (const line of rest.split(LINE_SPLIT_RE)) {
      if (tableLines.length > 0 && !MARKDOWN_TABLE_ROW_RE.test(line)) break;
      tableLines.push(line);
    }
    basicInfoTableBlocks.push(tableLines.join('\n'));
  }
  const duplicatedBasicInfoTableCount = basicInfoTableBlocks.filter(block => /项目名称|招标人|建设单位|发包人|建设地点|招标范围|计划工期|合同估算价|质量标准/u.test(block)).length;
  if (duplicatedBasicInfoTableCount > 1) issues.push({ level: 'error', message: `项目基础信息类表格重复：${duplicatedBasicInfoTableCount} 处`, suggestion: '项目名称、招标人、建设地点、工期、质量等基础信息只能集中输出一次。' });
  const repeatedDividerRows = markdown.match(/^\|\s*---\s*\|\s*---\s*\|\s*$/gmu) || [];
  if (repeatedDividerRows.length > 60) issues.push({ level: 'error', message: `表格分隔线异常重复：${repeatedDividerRows.length} 行`, suggestion: '请修复表格规范化逻辑，禁止把数据行拆成多个碎表。' });
  for (const block of markdownTables(markdown)) {
    const rows = block.split(LINE_SPLIT_RE).filter(line => MARKDOWN_TABLE_ROW_RE.test(line));
    if (rows.length < 2) continue;
    if (!MARKDOWN_TABLE_DIVIDER_RE.test(rows[1] || '')) {
      issues.push({ level: 'error', message: `表格分隔线位置不规范：${rows[0] || ''}`, suggestion: 'Markdown 表格必须紧跟表头输出分隔线，例如 |---|---|，中间不得插入正文或其他管道行。' });
      continue;
    }
    const cells = rows.map(line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split(/(?<!\\)\|/u).map(cell => stripTableCellInvisibleChars(cell.trim())));
    const header = cells[0] || [];
    const genericHeaders = header.filter(cell => /^(?:列|字段|内容|备注)\d+$/u.test(cell));
    if (genericHeaders.length > 0) issues.push({ level: 'error', message: `表格存在泛化表头：${genericHeaders.join('、')}`, suggestion: '正式投标表格必须使用业务字段表头，不得出现“列5/字段1/内容2”等临时表头。' });
    const expectedColumns = header.length;
    const badRow = cells.find((row, rowIndex) => rowIndex !== 1 && row.length !== expectedColumns);
    if (badRow) issues.push({ level: 'error', message: `表格列数不一致：${header.join('、')}`, suggestion: '请统一表头和数据行列数；不应通过自动填充兜底词修补表格。' });
    // 数据行空单元格/占位符检测（十度实测缺陷：竣工清理计划表末列为空、临时用电表“—/若干/约82kW”占位）：
    // 正式交付表格不得出现数据缺失；占位符判定与豁免口径单源见 isNonExemptTablePlaceholderCell（D-T5）
    const dataRows = cells.slice(2);
    const emptyCellRow = dataRows.find(row => row.some(cell => cell === ''));
    if (emptyCellRow) issues.push({ level: 'error', message: `表格存在空单元格：${header.join('、')}（“${emptyCellRow[0] || ''}”行）`, suggestion: '正式交付表格不得出现空单元格；缺失数据应从资料补齐或按业务口径填写具体值，不得留空。' });
    const placeholderCellRow = dataRows.find(row => row.some((cell, cellIndex) => isNonExemptTablePlaceholderCell(cell, { rowFirstCell: row[0] || '', headerCell: header[cellIndex], cellIndex })));
    if (placeholderCellRow) {
      // 提取真正触发缺陷的单元格（与检测口径同源：豁免形态不进入消息定位）
      const placeholderCell = placeholderCellRow.find((cell, cellIndex) => isNonExemptTablePlaceholderCell(cell, { rowFirstCell: placeholderCellRow[0] || '', headerCell: header[cellIndex], cellIndex })) || '';
      issues.push({ level: 'error', message: `表格存在占位符单元格：${header.join('、')}（“${placeholderCellRow[0] || ''}”行“${placeholderCell}”）`, suggestion: '正式交付表格不得用“—/若干/约/待定”等占位或模糊表达代替具体数据；应从资料补齐具体数值。' });
    }
  }
  return issues;
}

/** 编制依据小节候选行范围（[start, end) 行索引闭开区间；start 指向标题行本身，title 为标题文本）。
 * C5 一致性类 P6 双向对账与文本提取共用同一扫描单源：声明侧取区段文本、引用侧排除区段取正文，
 * 口径不得双轨（检测端/修复端在同一范围判定上成立——检测定位=修复定位）。 */
export interface BasisSectionRange {
  start: number;
  end: number;
  level: number;
  title: string;
}

/** 编制依据小节候选行范围（三路扫描单源；与 extractBasisRegulationSection 文本互逆等价）：
 * 两轮标题扫描（先精确「编制依据」，无再退回「编制说明/编制原则/编制目的」；首个命中即止）；
 * 第三轮词锚扫描（非标题正文行含「编制依据」字样 → 上方最近标题段（≤60 行）并入候选，
 * 目录区词锚排除）；按 start 去重（多路命中同段只记一次）。 */
export function basisRegulationSectionRanges(markdown: string): BasisSectionRange[] {
  const lines = markdown.split(/\r?\n/u);
  const rangeEndFrom = (startIndex: number, level: number): number => {
    for (let j = startIndex + 1; j < lines.length; j += 1) {
      const next = /^(#{1,4})\s+(.+)$/u.exec(lines[j].trim());
      if (next && (level === 0 || next[1].length <= level)) return j;
    }
    return lines.length;
  };
  const ranges: BasisSectionRange[] = [];
  const pushRange = (start: number, level: number, title: string) => {
    if (ranges.some(range => range.start === start)) return;
    ranges.push({ start, end: rangeEndFrom(start, level), level, title });
  };
  for (const titleRe of [/编制依据/u, /编制说明|编制原则|编制目的/u]) {
    let hit = false;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      const hashHeading = /^(#{2,4})\s+(.+)$/u.exec(trimmed);
      const boldHeading = hashHeading ? null : /^\*\*(.+)\*\*$/u.exec(trimmed);
      if (!hashHeading && !boldHeading) continue;
      const title = hashHeading ? hashHeading[2] : (boldHeading?.[1] ?? '');
      if (!titleRe.test(title)) continue;
      pushRange(i, hashHeading ? hashHeading[1].length : 0, title);
      hit = true;
      break;
    }
    if (hit) break;
  }
  // 第三轮词锚扫描（r28j）：正文行含「编制依据」字样 → 上方最近标题段并入候选
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed.includes('编制依据')) continue;
    if (/^#{1,6}\s/u.test(trimmed) || /^\*\*(.+)\*\*$/u.test(trimmed)) continue;
    if (trimmed.includes('\t') || /[.·…]{4,}/u.test(trimmed)) continue;
    for (let j = i - 1; j >= 0; j -= 1) {
      const up = lines[j].trim();
      const hashHeading = /^(#{2,4})\s+(.+)$/u.exec(up);
      const boldHeading = hashHeading ? null : /^\*\*(.+)\*\*$/u.exec(up);
      if (!hashHeading && !boldHeading) continue;
      if (i - j > 60) break;
      const headingTitle = hashHeading ? hashHeading[2] : (boldHeading?.[1] ?? '');
      if (/目录/u.test(headingTitle)) break;
      pushRange(j, hashHeading ? hashHeading[1].length : 0, headingTitle);
      break;
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

/** 提取「编制依据/编制说明」小节文本（H2-H4 或粗体标题，到下一同级/更高级标题止；找不到返回空串）。
 * r16 丰乐镇 B3-B7 归因：单轮「包含匹配」被「编制说明与工程概况」类复合标题抢先命中（首个命中即
 * 返回，真实「编制依据」小节位于其后被整体跳过，法规 5 项检查全落空报缺）——两轮扫描：先精确
 * 「编制依据」候选，无再退回「编制说明/编制原则/编制目的」；均无时静默跳过（模板结构差异不误伤）。
 * r28j 归因（r28i 工程概况实测 3 类缺失误报）：真实清单以「正文行 + 表格」形态落在与关键词无关的
 * 标题段内（「其他分部分项工程施工要点」段内正文行「编制依据涵盖…」「施工组织设计编制依据清单」），
 * 标题两轮均不可见，二轮退回候选误命中「编制说明与工程基本信息」（零书名号）报缺空转修复轮——
 * 第三轮词锚扫描：非标题正文行含「编制依据」字样 → 上方最近标题段（≤60 行）并入候选（与标题段
 * 提取同源、按文本去重）；目录区词锚（点导引/制表符行、上方标题含「目录」）不参与。候选并集参与
 * 五类检查；三路均无痕迹时仍静默跳过（模板结构差异不误伤）。
 * C5 起候选范围由 basisRegulationSectionRanges 单源供出（本函数与范围扫描互逆等价，供双向对账
 * 排除区段复用）。 */
export function extractBasisRegulationSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/u);
  return basisRegulationSectionRanges(markdown)
    .map(range => [range.title, ...lines.slice(range.start + 1, range.end)].join('\n'))
    .join('\n');
}

/** 编制依据小节法规/规范完整性检测（十度实测缺陷：LLM 有时漏写法规清单，
 * 正文只写「国家现行法律、行政法规」类别话术；交付前确定性兑底，漏写即 error 进修复轮）。
 * 法规/条例/规范由写作模型依据行业公共知识自行列写，本检测只校验「具体条目存在」：
 * 国家法律、条例、验收规范三类条目各自 ≥1，建设地点含省/市时须有含该地名的书名号条目；
 * 招标文件提取法规（项目专属事实）须至少出现一条。
 * 无「编制依据/编制说明」小节标题时静默跳过（模板结构差异，不误伤）。 */
export function basisRegulationsCoverageIssues(markdown: string, blueprintData?: BlueprintData, options: { chapterTitles?: string[] } = {}): ValidationIssue[] {
  const sectionText = extractBasisRegulationSection(markdown);
  // 4.55.22 根修盲区：原判据「无编制依据区段 → return []」——**整章缺失**这一最严重的形态
  // 反而无任何检出（五类条目规则全部跳过）。义务来自文档类型：技术标/施组必须有编制依据章节。
  // 判定：文档存在「编制依据/编制说明」**标题**却抽不到区段正文 → 报空章；完全无该标题 →
  // 报缺失（与写作侧 chapterFocusRule 的「编制依据与适用范围逐项列全」义务同源）。
  if (!sectionText) {
    const hasHeading = /^#{1,6}\s*[^\n]{0,12}(?:编制依据|编制说明|编制原则)/mu.test(markdown);
    // 义务来源 = **规划结构**：大纲规划了编制依据类章节才要求（未规划的模板不误伤——
    // 既有用例「无编制依据小节 → 静默跳过（模板结构差异不误伤）」的合理性保留，
    // 只是不再把"规划了却整章丢失"也一并放过）
    const planned = (options.chapterTitles || []).some(title => /编制依据|编制说明|编制原则/u.test(title));
    const mentioned = /编制依据|编制说明/u.test(markdown);
    if (!hasHeading && !mentioned) return planned ? [{
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        provenance: { detectorId: 'basis-regulations-coverage', fingerprint: stableHash(markdown) },
        message: '缺少编制依据章节：正文未见「编制依据/编制说明」章节，五类依据（招标文件及补疑、国家法律法规、现行规范标准、地方法规规章、企业管理体系）无从逐项列全',
      suggestion: '补充「编制依据」章节并按五类逐项列全：招标文件及补疑补遗、国家法律法规、国家/行业现行规范标准、地方法规规章、企业管理体系；地方法规须结合工程所在地属地。',
    }] : [];
    if (hasHeading) {
      return [{
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        provenance: { detectorId: 'basis-regulations-coverage', fingerprint: stableHash(markdown) },
      message: '编制依据章节为空：存在标题但未列出任何依据条目',
      suggestion: '在编制依据章节下逐项列出五类依据的具体条目（法规/条例/规范须含名称与编号）。',
    }];
    }
    // 词锚只出现在目录等非章节处（模板差异）→ 静默，不误报
    return [];
  }
  const issues: ValidationIssue[] = [];
  const bookNames = (sectionText.match(/《[^《》]{2,40}(?:法|条例|办法|规程|规范|标准)》/gu) || []).map(entry => entry.replace(/《|》/gu, ''));
  const bookNameOf = (entry: string) => (entry.match(/《([^》]+)》/u) || [])[1] || '';
  // 1. 国家法律类条目 ≥1（书名号内以「法」结尾，拦截类别话术空写）
  if (!bookNames.some(name => /法$/u.test(name))) {
    issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: '编制依据小节缺少国家法律法规条目', suggestion: '编制依据小节必须列出具体法律名称及文号（如《中华人民共和国建筑法》），不得空写「国家现行法律、行政法规」类别话术。' });
  }
  // 2. 条例/办法类条目 ≥1
  if (!bookNames.some(name => /(?:条例|办法)$/u.test(name))) {
    issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: '编制依据小节缺少条例类条目', suggestion: '编制依据小节必须列出具体条例名称（如《建设工程质量管理条例》），不得以类别话术代替。' });
  }
  // 3. 施工验收规范类条目 ≥1（书名号规范/规程/标准名 或 标准编号形态）
  const hasStandardBook = /《[^《》]{2,40}(?:规范|规程|标准)[^《》]{0,20}》/u.test(sectionText);
  const hasStandardCode = /(?:GB|CJJ|JGJ|JTG|SL|DB|DL|YS|HG)[\s/T]*[A-Z]?[\s/]?\d{2,4}/u.test(sectionText);
  if (!hasStandardBook && !hasStandardCode) {
    issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: '编制依据小节缺少施工验收规范条目', suggestion: '编制依据必须包含与本工程分部对应的现行施工验收规范名称及编号（如《给水排水管道工程施工及验收规范》（GB 50268-2008））。' });
  }
  // 4. 地方性法规：建设地点含省/市地名时须有含该地名的书名号条目
  // 4.31 区域口径校准（丰乐镇 v6 #71）：location「安徽省合肥市肥西县」解析省级+市级两级
  // 地名，任一命中即通过——招标文件实际引用的是《合肥市公共资源交易管理条例》（市级），
  // 原「仅按首个匹配（安徽省）核对」把本项目真实引用的市级条例漏判缺失（LLM 修复轮无
  // 数据可写的死结）；4.41 起确定性回写器已删除，缺失由写作侧编制依据要求覆盖，残留由本检测器阻断
  const location = blueprintData?.project.location || '';
  const regions = [...location.matchAll(/([\u4e00-\u9fa5]{2,10}?[省市])/gu)].map(match => match[1]);
  if (regions.length > 0) {
    const covered = regions.some(region => bookNames.some(name => name.startsWith(region) || name.includes(region)));
    if (!covered) {
      issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `编制依据小节缺少${regions[0]}地方性法规、条例`, suggestion: `编制依据必须列出工程所在地（${regions.join('、')}）现行地方性法规及条例名称。` });
    }
  }
  // 5. 招标文件提取法规（项目专属事实）：全部漏写 → error
  if (blueprintData && blueprintData.basisRegulations.length > 0) {
    const missing = blueprintData.basisRegulations.filter(item => !bookNames.includes(bookNameOf(item)));
    if (missing.length === blueprintData.basisRegulations.length) {
      issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `编制依据小节未列招标文件引用法规：${missing.slice(0, 3).map(item => item.replace(/（.*/u, '')).join('、')}`, suggestion: '招标文件引用的法规必须照抄进编制依据小节。' });
    }
  }
  return issues;
}

/** 资源章数值拆分一致性检测（A3 · 4.27.0）：扫描源收敛到 resourceBreakdownNumbers 单源
 *（检测定位=修复定位；确定性修复器 fixResourceBreakdownNumbers 按同一 claims 定点硬替换）。
 * 三类模式口径与十度/十一度既有实现一致（工种构成：桥接词白名单+群体语境豁免+阶段部署段落豁免；
 * 机械台数：单条目锚定名称语境、同名多条目按规格语境；材料拆分：多规格+同族单位+合计行豁免）；
 * issue 按条目 label 去重（每条目最多一条阻断，全部偏离由修复器一轮收敛）。 */
export function resourceBreakdownConsistencyIssues(markdown: string, blueprintData?: BlueprintData, lock?: BillFactLock): ValidationIssue[] {
  // 4.55.30 口径分层：逐条口径（清单行级）作为第二源，单体语句按逐条口径裁决（蓝图汇总为跨单体总量）
  const authority = buildResourceBreakdownAuthority(blueprintData, lock);
  if (!authority) return [];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const claim of scanResourceBreakdownClaims(markdown, authority)) {
    if (seen.has(claim.label)) continue;
    seen.add(claim.label);
    issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: claim.message, suggestion: claim.suggestion });
  }
  return issues;
}

/** 表格凑数治理：同主题重复堆叠 + 连续堆表（无正文分隔），是生成侧用表格凑字数的典型形态。
 * 与 markdownTableQualityIssues 的结构缺陷检测互补，本函数只针对“凑数”形态，warning 不阻断门禁。 */
export function tableSpamIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = markdown.split(LINE_SPLIT_RE);
  const blocks: Array<{ headerKey: string; headerText: string; start: number; end: number; dividerCount: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!MARKDOWN_TABLE_ROW_RE.test(lines[index])) continue;
    const start = index;
    const block: string[] = [];
    while (index < lines.length && MARKDOWN_TABLE_ROW_RE.test(lines[index])) {
      block.push(lines[index]);
      index += 1;
    }
    index -= 1;
    const dividerCount = block.filter(line => MARKDOWN_TABLE_DIVIDER_RE.test(line)).length;
    if (dividerCount === 0) continue;
    const rawHeader = (block[0] || '').trim();
    const body = rawHeader.startsWith('|') ? rawHeader.slice(1) : rawHeader;
    const core = body.endsWith('|') ? body.slice(0, -1) : body;
    const headerCells = core.split('|').map(cell => cell.split('**').join('').trim()).filter(cell => cell.length > 0);
    blocks.push({ headerKey: headerCells.join('|'), headerText: headerCells.join('、'), start, end: index, dividerCount });
  }
  const byHeader = new Map<string, number>();
  for (const block of blocks) byHeader.set(block.headerKey, (byHeader.get(block.headerKey) || 0) + 1);
  const duplicated = [...byHeader.entries()].filter(([, count]) => count >= 3);
  if (duplicated.length > 0) {
    const sample = blocks.find(block => byHeader.get(block.headerKey) === duplicated[0]?.[1])?.headerText || '';
    // 第十六版升级：相同表头 3 次及以上从 warning 升为 error（MARKDOWN_TABLE_FORMAT_RULES
    // 「全文 3 处及以上完全相同表头属模板化凑数」硬约束）——warning 不进修复链，三处相同
    // 「关键节点」表头跨版本残留；升 error 后进 LLM 修复轮改表头措辞（加进度/质量/安全主题限定）
    issues.push({ level: 'error', severity: 'blocker', category: 'table', owner: 'llm', repairability: 'llm_repairable', message: `同主题表格重复堆叠：${duplicated.length} 组相同表头出现 3 次及以上（如：${sample}）`, suggestion: '同一主题表格全文只出现一次，禁止拆成多张碎表重复堆叠凑数；请合并同类表格或删除重复内容。相同表头分别用于不同主题时，必须在表头列名中加主题限定词（如「进度关键节点/质量关键节点/安全关键节点」）以区分口径。' });
  }
  // 连续堆叠两类形态：表格块之间只有空行无正文分隔；单块内多条分隔线（多张表连写不换行）
  let stacked = 0;
  for (let blockIndex = 1; blockIndex < blocks.length; blockIndex += 1) {
    const previous = blocks[blockIndex - 1];
    const current = blocks[blockIndex];
    if (!previous || !current) continue;
    const between = lines.slice(previous.end + 1, current.start);
    if (between.every(line => line.trim() === '')) stacked += 1;
  }
  for (const block of blocks) if (block.dividerCount >= 2) stacked += block.dividerCount - 1;
  if (stacked >= 2) issues.push({ level: 'warning', category: 'table', message: `表格连续堆叠：${stacked} 处相邻表格无正文分隔`, suggestion: '表格之间应有正文引导叙述，禁止连续堆叠多张表格凑数。' });
  return issues;
}

function sectionBodyTextLength(body: string) {
  const text = body.split(LINE_SPLIT_RE)
    .filter(line => !/^#{1,6}\s+/u.test(line.trim()))
    .filter(line => !/^\s*\|/u.test(line))
    .filter(line => !/^\s*:?-{3,}:?/u.test(line))
    .filter(line => !/^<\/?div\b/iu.test(line.trim()))
    .join('\n');
  return text.replace(/[|*_`<>-]/gu, '').replace(WHITESPACE_RE, '').length;
}

type MarkdownSectionGapReason = 'missing_planned_section' | 'empty' | 'too_short';

export interface MarkdownSectionContentGap {
  chapterTitle: string;
  sectionTitle: string;
  level: 3 | 4;
  bodyLength: number;
  reason: MarkdownSectionGapReason;
  planned: boolean;
  message: string;
}

/** 小节标题归一化：sectionCountOverflowIssues 的规划外判定与 globalQualityGates.reconcileUnplannedSectionHeadings
 * 的修复定位共用本函数，保证「检测定位=修复定位」零漂移（D-T6 ②） */
export function normalizeSectionTitleForGap(title: string) {
  return normalizeStructureTitle(title);
}

export function sameSectionTitle(left: string, right: string) {
  const leftKey = normalizeSectionTitleForGap(left);
  const rightKey = normalizeSectionTitleForGap(right);
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey)) return true;
  // r28g B2/B8/B1 归因（r28f 实测）：规划小节「安全责任体系与目标落位」与成稿「…目标落实」
  // 单字微调时精确口径零命中 → 误判缺规划小节 → 补写轮章末追加规划名小节与成稿节并存
  //（章内 H3 超规划数 + 空 H4 锚点切片 + 目录漂移三连 blocker）。复用近名同源口径
  //（编辑距离预算 + 数字/季节敏感字防线）：一字级差异视为同一小节已覆盖，不触发补写；
  // ≥2 字差异仍判缺失（真缺节照报）。
  if (nearSubsectionTitleMatch(leftKey, rightKey)) return true;
  const tokenRe = /项目概况|主要施工方案|新技术新材料|工程重点难点|重点难点|危大工程|保障体系|安全保障|工期|质量|安全生产|应急预案|资源|人材机|材料|机械|劳动力|进度|关键线路|交通疏导|成品保护|深化设计|验收/gu;
  const leftTokens = new Set(leftKey.match(tokenRe) || []);
  const rightTokens = new Set(rightKey.match(tokenRe) || []);
  const overlap = [...leftTokens].filter(token => rightTokens.has(token)).length;
  return overlap >= 2 || (Math.min(leftTokens.size, rightTokens.size) === 1 && overlap === 1 && Math.max(leftKey.length, rightKey.length) <= 16);
}

function collectActualSections(source: string) {
  const matches = [...source.matchAll(/^(#{3,4})\s+(.+)$/gmu)];
  return matches.map((match, index) => {
    const level = match[1].length as 3 | 4;
    const start = (match.index || 0) + match[0].length;
    const nextMatch = matches.slice(index + 1).find(item => item[1].length <= level);
    const end = nextMatch?.index ?? source.length;
    const rawTitle = (match[2] || '').trim();
    return { rawTitle, title: normalizeSectionTitleForGap(rawTitle), level, body: source.slice(start, end) };
  }).filter(item => item.title && (item.level === 3 || item.level === 4));
}

function sectionBodyForTitle(markdown: string, section: string) {
  const matches = collectActualSections(markdown).filter(item => sameSectionTitle(item.rawTitle, section));
  if (matches.length <= 1) return matches[0];
  return matches
    .map(item => ({ item, gap: gapForSection('', section, item.level, item.body, true), textLength: sectionBodyTextLength(item.body) }))
    .sort((left, right) => {
      const leftBad = left.gap && left.gap.reason === 'empty' ? 1 : 0;
      const rightBad = right.gap && right.gap.reason === 'empty' ? 1 : 0;
      if (leftBad !== rightBad) return leftBad - rightBad;
      return right.textLength - left.textLength;
    })[0]?.item;
}

function tableDataRowCount(body: string) {
  const rows = body.split(LINE_SPLIT_RE).filter(line => MARKDOWN_TABLE_ROW_RE.test(line) && !MARKDOWN_TABLE_DIVIDER_RE.test(line));
  return Math.max(0, rows.length - 1);
}

function gapForSection(chapterTitle: string, sectionTitle: string, level: 3 | 4, body: string, planned: boolean): MarkdownSectionContentGap | undefined {
  const bodyLength = sectionBodyTextLength(body);
  const hasTable = MARKDOWN_TABLE_ROW_RE.test(body) && body.split(LINE_SPLIT_RE).some(line => MARKDOWN_TABLE_DIVIDER_RE.test(line));
  const bodyWithoutTables = body.split('\n').filter(line => !MARKDOWN_TABLE_ROW_RE.test(line) && !MARKDOWN_TABLE_DIVIDER_RE.test(line)).join('\n');
  const nonTableBody = bodyWithoutTables.replace(/^#{1,6}\s+.+$/gmu, '');
  const nonTableLength = sectionBodyTextLength(nonTableBody);
  if (/\[WRITER_MISSING_SECTION\]|Writer 未完成/u.test(body)) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'empty', planned, message: `${chapterTitle} 小节内容补写未完成：${sectionTitle}` };
  if (/【本小节生成未达标，需重新生成】/u.test(body)) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'empty', planned, message: `${chapterTitle} 小节生成未达标：${sectionTitle}` };
  if (/项目基本信息|基本信息|工程概况|项目概况|工程概述|项目概述/u.test(sectionTitle) && (hasTable || bodyLength >= 40)) return undefined;
  // 附录A/B 由导出层按正文自动归集注入，不属于 Writer 成稿范围；只要带表格即视为有效，不参与正文完整度校验
  if (/^附录[一二三四五六七八九十A-Z\d]/u.test(sectionTitle) && hasTable) return undefined;
  // 表格载体小节：清单/配置/汇总/一览/明细类本体即表格清单，计划/进度/节点/安排类核心交付物即计划编排表格
  // （如危大工程控制清单、主要周转材料配置、关键节点计划与责任分解、关键施工节点控制计划），
  // 表格数据行≥2 即视为有效交付，与“只有标题无正文”区分，避免表格治理要求输出表格后反被“无正文”门禁阻断
  const tableCarrierSection = /清单|配置|汇总|一览|明细|计划|进度|节点|安排/u.test(sectionTitle) || /表[^，。；：\s]{0,6}$/u.test(sectionTitle);
  if (hasTable && tableCarrierSection && tableDataRowCount(body) >= 2) return undefined;
  if (hasTable && nonTableLength < 20) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'empty', planned, message: planned ? `${chapterTitle} 只有标题或表格无正文：${sectionTitle}` : `${chapterTitle} 小节只有标题或表格无正文：${sectionTitle}` };
  if (bodyLength >= 80 && nonTableLength >= 20) return undefined;
  if (bodyLength === 0) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'empty', planned, message: `${chapterTitle} 空小节：${sectionTitle}` };
  if (bodyLength < 180) return { chapterTitle, sectionTitle, level, bodyLength, reason: 'too_short', planned, message: `${chapterTitle} ${planned ? '规划小节' : '正文小节'}正文过短：${sectionTitle}` };
  return undefined;
}

export function collectSectionContentGaps(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content' | 'sections'>>): MarkdownSectionContentGap[] {
  const gaps: MarkdownSectionContentGap[] = [];
  const seen = new Set<string>();
  for (const chapter of chapters) {
    const source = chapter.content?.trim() ? chapter.content : markdown;
    // 附录小节由导出层自动归集注入 markdown 尾部，不进入章节草稿 content，也不应由 Writer 成稿，跳过规划小节校验；
    // 4.19.3：分部章（「主要施工方法」等）的工作包型容器小节（「主要分部分项工程施工方案」）内容由各分部块承担，
    // 容器块空壳被确定性删除后不报 missing_planned_section（与三要素小节同口径豁免）
    const plannedSections = (chapter.sections || []).filter(section => !isStructuralLabelTitle(section)
      && !(DIVISION_SECTION_RE.test(chapter.title) && WORK_PACKAGE_SECTION_RE.test(section.trim()))
      && !/^附录/u.test(section.trim()));
    for (const section of plannedSections) {
      const normalized = normalizeSectionTitleForGap(section);
      const found = sectionBodyForTitle(source, section);
      const key = `${chapter.title}|${normalized}|planned`;
      if (!found) {
        gaps.push({ chapterTitle: chapter.title, sectionTitle: section, level: 3, bodyLength: 0, reason: 'missing_planned_section', planned: true, message: `${chapter.title} 缺少规划小节：${section}` });
        seen.add(key);
        continue;
      }
      const gap = gapForSection(chapter.title, section, found.level, found.body, true);
      if (gap) gaps.push(gap);
      seen.add(key);
    }
    for (const section of collectActualSections(source)) {
      const key = `${chapter.title}|${section.title}|actual`;
      const plannedKey = `${chapter.title}|${section.title}|planned`;
      if (seen.has(key) || seen.has(plannedKey)) continue;
      const gap = gapForSection(chapter.title, section.title, section.level, section.body, false);
      if (gap && gap.reason === 'empty') gaps.push(gap);
      seen.add(key);
    }
  }
  return gaps;
}

export function sectionContentIntegrityIssues(markdown: string, chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content' | 'sections'>>): ValidationIssue[] {
  return collectSectionContentGaps(markdown, chapters)
    // 4.55.22：`too_short` 一并浮出（原为**死值**——生产者有、三个消费点全都过滤掉）。
    // 保持既有定级意图：classifyBlockingIssue 对「规划小节正文过短」是**非阻断**（不拦导出），
    // 但必须进问题流——否则"内容不足"在报告与修复链里彻底不可见，即盲区。
    .filter(gap => gap.reason === 'empty' || gap.reason === 'missing_planned_section' || gap.reason === 'too_short')
    .map(gap => ({
      level: 'error' as const,
      // 结构完整性检查器产出显式标注 structure：评分层按 category 白名单归属编制规范性，
      // 不再依赖消息关键词猜测（「图纸目录」「图集编号」等事实/规范类消息词面误中问题）
      category: 'structure' as const,
      message: gap.message,
      suggestion: gap.reason === 'missing_planned_section' ? '必须补充该规划小节正式正文，不得缺节导出。' : '必须补充与该小节相关的材料事实和必要内容，达到正文完整度要求。',
    }));
}

/** D-T3 空节清扫·同源定位：章草稿内严格空壳（正文切片 trim 后为空）且无规划归属的 H3/H4 标题行。
 * 判定链与 collectSectionContentGaps 完全同源：plannedSections 同过滤（结构性标签/分部容器/附录剔除）、
 * sameSectionTitle 近名归属（命中规划 = 补写辖区不删——空壳归 r28g 补写轮）、体边界 = 下一同级或更高级标题。
 * 仅清扫「无依据空壳」（r28f 实证：补写轮把原 H4 正文搬往规划名小节后遗留的模板标签空壳直坠终门禁）；
 * 「有表格无正文」不在清扫范围（表格有信息价值，由表格链管辖）。line 为 0 基行号（清理端直接按索引删行）；
 * 仅作用于章草稿 content（source 为空不猜全局 markdown），与终检「source=chapter.content 优先」同读源。 */
export function emptyUnplannedSectionSpans(chapter: Pick<DocumentDraftChapter, 'title' | 'content' | 'sections'>): Array<{ line: number; rawTitle: string; level: 3 | 4 }> {
  const source = chapter.content?.trim() ? chapter.content : '';
  if (!source) return [];
  const plannedSections = (chapter.sections || []).filter(section => !isStructuralLabelTitle(section)
    && !(DIVISION_SECTION_RE.test(chapter.title) && WORK_PACKAGE_SECTION_RE.test(section.trim()))
    && !/^附录/u.test(section.trim()));
  const matches = [...source.matchAll(/^(#{3,4})\s+(.+)$/gmu)];
  const spans: Array<{ line: number; rawTitle: string; level: 3 | 4 }> = [];
  matches.forEach((match, index) => {
    const level = match[1].length as 3 | 4;
    const rawTitle = (match[2] || '').trim();
    if (!rawTitle) return;
    const start = (match.index || 0) + match[0].length;
    const nextMatch = matches.slice(index + 1).find(item => item[1].length <= level);
    const end = nextMatch?.index ?? source.length;
    // 严格空壳：切片内零可见字符（含空白行）；表格承载/带内容小节不删（保守，零删信息风险）
    if (source.slice(start, end).trim() !== '') return;
    if (plannedSections.some(section => sameSectionTitle(section, rawTitle))) return;
    const line = source.slice(0, match.index || 0).split('\n').length - 1;
    spans.push({ line, rawTitle, level });
  });
  return spans;
}

/**
 * 全部空壳小节跨度（4.55.25 用户口径：**没有内容就不要出现该标题**）。
 *
 * 与 `emptyUnplannedSectionSpans` 的差别：**不再排除规划归属的空壳**——实测 7 处空小节全部是
 * 「规划标题被模型近义标题顶替」的产物（规划标题空壳 + 紧随自拟标题承载内容）；
 * 规划归属的空壳若在链尾仍为空，说明补写轮与归位器都未能落位，此时**保留空标题**只会同时
 * 制造「空小节」blocker 与读者的空洞观感——按同一口径移除标题，改为由 `planned-section-placement`
 * 以「规划小节未落位」**单一**报出（一个真实原因只报一次）。
 * 判据与既有函数同为「切片内零可见字符」（表格承载/带内容小节不删，保守零删信息风险）。
 */
export function emptySectionSpans(chapter: Pick<DocumentDraftChapter, 'title' | 'content' | 'sections'>): Array<{ line: number; rawTitle: string; level: 3 | 4; planned: boolean }> {
  const source = chapter.content?.trim() ? chapter.content : '';
  if (!source) return [];
  const plannedSections = (chapter.sections || []).filter(section => !isStructuralLabelTitle(section)
    && !(DIVISION_SECTION_RE.test(chapter.title) && WORK_PACKAGE_SECTION_RE.test(section.trim()))
    && !/^附录/u.test(section.trim()));
  const matches = [...source.matchAll(/^(#{3,4})\s+(.+)$/gmu)];
  const spans: Array<{ line: number; rawTitle: string; level: 3 | 4; planned: boolean }> = [];
  matches.forEach((match, index) => {
    const level = match[1]!.length as 3 | 4;
    const rawTitle = (match[2] || '').trim();
    if (!rawTitle) return;
    const start = (match.index || 0) + match[0].length;
    const nextMatch = matches.slice(index + 1).find(item => item[1]!.length <= level);
    const end = nextMatch?.index ?? source.length;
    if (source.slice(start, end).trim() !== '') return;
    const line = source.slice(0, match.index || 0).split('\n').length - 1;
    spans.push({ line, rawTitle, level, planned: plannedSections.some(section => sameSectionTitle(section, rawTitle)) });
  });
  return spans;
}

/**
 * L5 结构完整性门禁·「主题块数 = 成稿 H3 数」守恒（终检注册，多节方向）：
 * 每章成稿 H3 唯一标题数不得超出规划小节数——超出 = LLM 擅加分节/规划外小节穿透到交付
 *（缺节方向由 sectionContentIntegrityIssues 的 missing_planned_section 覆盖，两者互补构成守恒闭环）；
 * finalChapterDrafts.sections 保持规划大纲源（拆半对相邻同名已去重），正文侧 extractGeneratedSections 亦唯一化。
 * 豁免口径与 collectSectionContentGaps 对齐（结构标签/分部容器/附录两侧同口径剔除），
 * 防 wrapper 提升（容器小节 → 多个分部块 H3）等合法结构变换误报；无规划基准的章跳过。
 */
export function sectionCountOverflowIssues(chapters: DocumentDraftChapter[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    if (!chapter.content?.trim()) continue;
    const exempt = (section: string) => {
      const trimmed = String(section || '').trim();
      return !trimmed || isStructuralLabelTitle(trimmed) || /^附录/u.test(trimmed)
        || (DIVISION_SECTION_RE.test(chapter.title) && WORK_PACKAGE_SECTION_RE.test(trimmed));
    };
    const plannedSections = (chapter.sections || []).filter(section => !exempt(section));
    if (plannedSections.length === 0) continue;
    const actualSections = extractGeneratedSections(chapter.content).filter(section => !exempt(section));
    if (actualSections.length <= plannedSections.length) continue;
    const plannedKeys = new Set(plannedSections.map(section => normalizeSectionTitleForGap(section)));
    const extraTitles = actualSections.filter(section => !plannedKeys.has(normalizeSectionTitleForGap(section)));
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'llm',
      repairability: 'llm_repairable',
      chapterId: chapter.id,
      message: `成稿小节超出主题块数：「${chapter.title}」成稿 ${actualSections.length} 个小节、规划主题块 ${plannedSections.length} 个${extraTitles.length ? `；规划外小节：${extraTitles.slice(0, 5).join('、')}` : ''}`,
      suggestion: '成稿 H3 小节必须与规划主题块一一对应（拆半块合并为一个小节）：规划外小节属相邻主题块内容时并入归属小节并降为 H4，无归属时整节删除；修复后小节编号按正文顺序自动重排。',
    });
  }
  return issues;
}

function normalizedFactValue(fact: DocumentFact) {
  return `${fact.fieldName || fact.key} ${stringifyFactValue(fact.value)}`.replace(/\s+/gu, ' ').trim();
}

function durationValues(text: string) {
  const values = new Set<string>();
  const patterns = [
    // 排除"XX日历天内"的时限表达（如"中标公示期结束后7日历天内编制施组计划"是计划编制时限，不是工期口径）
    /\d+\s*日历天(?!内)/gu,
    /(?:计划工期|合同工期|总工期|工期|施工周期)[^\n。；;]{0,12}\d+\s*天/gu,
    /(?:计划工期|合同工期|总工期|工期|施工周期)[^\n。；;]{0,12}\d+\s*(?:个月|月)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0].match(/\d+\s*(?:日历天|天|个月|月)/u)?.[0]?.replace(/\s+/gu, '');
      if (value) values.add(value);
    }
  }
  return [...values];
}

// 同口径数值扫描：按“总量口径词 + 数值（可含万/千分位）+ 单位”模式提取取值，
// 供跨章一致性检测比对正文与资料口径是否一致（非 LLM 的确定性检查，零额外成本）。
// 子项/专项口径词防护（q1a）：口径词与数值之间（gap）或口径词紧前上下文（prefix）出现
// 子项/专项口径词时，该数值属专项口径（地下/办公区/占地面积等），不得与建筑总量混比、
// 不得确定性替换（历史缺陷：确定性修复器把正文正确的“地下建筑面积3786.97”“办公区240”
// “总占地面积10970”全部盲替换成建筑总量 28570.36）；此类数值不进确定性冲突列表，
// 由 LLM 规模口径复核（语义层）依据事实卡核对口径归属
const SCALE_GAP_WORDS_RE = /占地|用地|地下|地上|办公|生活|附属|辅助|绿化|道路|广场|门卫|配电|泵房|锅炉房|车库|车棚|岗亭|传达|警卫|样板房|售楼|门房|单栋|各栋|楼层|每层|单层|架空|雨棚|堆场/u;
// 口径词紧前上下文防护：只挡“XX区/XX室/XX房”式专项范围词（gap 防护已覆盖占地/地下等语义词），
// 避免“地上6层、总建筑面积28570.36”这类正确表述被误 skip（防错改优先于漏检）
const SCALE_PREFIX_WORDS_RE = /办公区|生活区|加工区|施工区|堆场|门卫|配电|泵房|锅炉房|车库|车棚|岗亭|传达|警卫|样板房|售楼|门房|地下室|楼层|单层|每层|架空|雨棚/u;
// C8 S2② 长窗实体隔离门（48 字符）：子项实体词出现在口径词更远的前文时，16 字符紧前窗、空 gap
// 与 24 字符语义窗均无法拦截（s28m' stage 145 实证：「综合配套用房节能设计按甲类…（表A.0.3-1）
// 执行，建筑面积774.11m2」「门卫节能设计按乙类…（表A.0.3-2）执行，建筑面积13.85m2」中实体词距
// 口径词约 33~35 字符，774.11/13.85 被确定性替换为项目总量 937.72，同段出现 937.72 与 774.11
// 并排矛盾）。口径词前 48 字符（不跨空行段落边界）内出现实体词 → 视为子项实体归属语境：检测侧
// 不列冲突、确定性修复不替换（防错改优先），被跳过项经 scaleSkipped 以「规模口径复核」warning
// 显性交 LLM 依事实卡核对口径（零静默降级）。「栋/座/处」须带数字前缀（「3栋」），防「处理」类
// 误命中；「单体」不入列——资料「单体建筑面积28570.36」是建筑总量合法表述（scaleConsistency
// 检测/修复双侧回归锁定），入列会使期望口径解析与败选值替换同时失效。
const SCALE_ENTITY_WORDS_RE = /门卫|门房|岗亭|值班室|传达室|警卫室|公厕|车棚|雨棚|配电房|配电室|泵房|水泵房|锅炉房|样板房|售楼处|构筑物|用房|配套设施|\d{1,3}[栋座处]/u;
const SCALE_ENTITY_WINDOW_CHARS = 48;

/** 实体隔离门：取口径词前 48 字符窗口（空行段落边界外不取，单换行表格行/折行同段保留）、
 * 去除空白后做实体词判定（防「配套 设施」折行形态漏判）。命中 → 该候选属子项实体语境。 */
function entityAttributionHit(text: string, index: number): boolean {
  const windowText = text.slice(Math.max(0, index - SCALE_ENTITY_WINDOW_CHARS), index);
  const boundary = windowText.lastIndexOf('\n\n');
  const segment = boundary >= 0 ? windowText.slice(boundary + 2) : windowText;
  return SCALE_ENTITY_WORDS_RE.test(segment.replace(/\s+/gu, ''));
}
const COST_GAP_WORDS_RE = /暂列|暂估|费率|税率|利润|规费|安全文明|措施费|人工费|材料费|机械费|管理费|暂定/u;

// 阶段五语义升级：范围词/费用词 gap 语义扩围——词面未命中但语义属"子项/专项口径"的上下文
// 由语义 gate 承接（semanticGate 统一入口），检测与确定性修复双侧同口径，杜绝"检测排除修复改写"的口径分裂。
const SCALE_GAP_SEMANTIC_PROTOTYPES = [
  '地下建筑面积与地上建筑面积的分项指标',
  '配套用房与附属用房的建筑面积',
  '占地面积与绿化面积的用地指标',
] as const;
const SCALE_GAP_LEGAL_PROTOTYPES = [
  '总建筑面积的总体规模指标',
  '建设规模的总量数值',
] as const;
const COST_GAP_SEMANTIC_PROTOTYPES = [
  '暂列金额与暂估价的子项费用',
  '人工费与材料费的分项费用',
] as const;
const COST_GAP_LEGAL_PROTOTYPES = [
  '合同估算价的总金额口径',
  '投资估算的总体金额',
] as const;

async function buildScaleGapGate(embedDocuments?: (texts: string[]) => Promise<number[][]>) {
  return buildSemanticGate({
    prototypes: [...SCALE_GAP_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...SCALE_GAP_LEGAL_PROTOTYPES],
    embedDocuments,
  });
}

async function buildCostGapGate(embedDocuments?: (texts: string[]) => Promise<number[][]>) {
  return buildSemanticGate({
    prototypes: [...COST_GAP_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...COST_GAP_LEGAL_PROTOTYPES],
    embedDocuments,
  });
}

async function scopedNumericEntries(text: string, scopeRe: RegExp, unitRe: RegExp, gapWords?: RegExp, prefixWords?: RegExp, gapGate?: (texts: string[]) => Promise<boolean[]>, entityWords?: RegExp) {
  const entries: Array<{ value: string; unit: string; scope: string }> = [];
  const skipped: Array<{ value: string; unit: string; scope: string; context: string }> = [];
  const seen = new Set<string>();
  const pattern = new RegExp(`(?:${scopeRe.source})(?:[^\\n。；;，,]{0,14}?)(\\d{2,}(?:[.,]\\d+)?\\s*万?)\\s*(${unitRe.source})`, 'giu');
  const matches = [...text.matchAll(pattern)];
  // 语义扩围：词面 gap/prefix 均未命中的候选做语义复核，语义属范围词/费用词 → 同样跳过比对；
  // 长窗实体词命中（C8 S2②）属确定性词面判定，不进语义复核队列（已确定跳过，省一次 LLM 调用）
  const uncertain = gapGate
    ? matches
      .filter(match => {
        const gap = match[0].slice(0, match[0].indexOf(match[1]));
        const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
        return !((gapWords && gapWords.test(gap)) || (prefixWords && prefixWords.test(prefix)) || (entityWords && entityAttributionHit(text, match.index ?? 0)));
      })
      .map(match => {
        const gap = match[0].slice(0, match[0].indexOf(match[1]));
        const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
        return { index: match.index ?? 0, context: `${prefix}${gap}`.replace(/\s+/gu, '').slice(-24) };
      })
    : [];
  const uncertainFlags = uncertain.length > 0 ? await gapGate!(uncertain.map(item => item.context)) : [];
  const semanticSkip = new Set(uncertain.filter((_, index) => uncertainFlags[index]).map(item => item.index));
  for (const match of matches) {
    const value = match[1].replace(/[,，]/gu, '').replace(/\s+/gu, '');
    const unit = match[2];
    const gap = match[0].slice(0, match[0].indexOf(match[1]));
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
    if ((gapWords && gapWords.test(gap)) || (prefixWords && prefixWords.test(prefix)) || (entityWords && entityAttributionHit(text, match.index ?? 0)) || semanticSkip.has(match.index ?? 0)) {
      skipped.push({ value, unit, scope: match[0].slice(0, gap.length).replace(/\s+/gu, ''), context: `${prefix}${gap}`.replace(/\s+/gu, '').slice(-24) });
      continue;
    }
    const scope = match[0].match(scopeRe)?.[0] || '';
    const key = `${value}|${unit}`;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    entries.push({ value, unit, scope });
  }
  return { entries, skipped };
}

// 建设规模期望口径解析：资料中“建设规模”字段值常混写占地与建筑两个口径
// （如“建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米”），
// 首个匹配数值（10970）实为占地面积，不是建筑总量；若直接取第一个匹配作期望口径，
// 修复器会把正文正确的“单体建筑面积 28570.36㎡”反向改成占地面积值（round-21 S6 实测：
// 跨章一致性修复 18 处 28570.36→10970，正文 9 处“总建筑面积 10970㎡”均为反向改错产物）。
// 混合口径时必须取“建筑面积”口径词引导的数值；无“占地/用地”字样时保持原“首个匹配”语义。
function resolveScaleExpectation(text: string, scaleGapGate?: (texts: string[]) => Promise<boolean[]>) {
  return scopedNumericEntries(text, SCALE_SCOPE_RE, SCALE_UNIT_RE, SCALE_GAP_WORDS_RE, SCALE_PREFIX_WORDS_RE, scaleGapGate).then(({ entries }) => {
    // “总”字归一：scope 可能是“建筑面积”或“总建筑面积”，同口径
    const areaEntry = entries.find(entry => entry.scope.replace(/^总/u, '') === '建筑面积');
    // 占地/用地语境只认“建筑面积”词引导的数值：混合口径中占地数值是独立口径，不得作为建筑总量期望值；
    // 找不到建筑口径条目时返回 undefined（调用方跳过修复/比对），禁止回退首个数值（round-21 S6 实测：
    // 截断事实“建设规模：项目总占地面积约10970平方米”单条目被当作建筑总量期望，
    // 修复器把正文正确的 28570.36 反向改成 10970，共 16 处）
    if (/占地|用地/u.test(text)) return areaEntry;
    return entries[0];
  });
}

// 数值归一化到统一基准（元 / ㎡），使“35000㎡”与“3.5万㎡”、“35000万元”与“3.5亿元”可等价比较
function scaledNumericValue(entry: { value: string; unit: string }) {
  const normalized = entry.value.replace(/[,，]/gu, '').trim();
  const wan = /^([\d.]+)万/u.exec(normalized);
  const base = wan ? Number(wan[1]) * 10000 : Number(normalized);
  if (!Number.isFinite(base)) return Number.NaN;
  if (/亿元/u.test(entry.unit)) return base * 100000000;
  if (/万元/u.test(entry.unit)) return base * 10000;
  return base;
}

// 总量口径词：只比对建筑总量口径（总建筑面积/建设规模），“总”字可选（基础口径词与 factGovernance.scopeReForKind('area') 同源单点，
// 此处是其带子项口径黑名单的增强版）；子项口径（地上/地下/单栋/门卫室等具体建筑物）数值不同属正常分层，不视为冲突；
// 用地面积/占地面积是独立字段（与建设规模不同口径），不得与建筑总量混比（历史缺陷：
// 正文正确转述资料“总用地面积 X㎡”被判为与建设规模冲突，导出门禁误阻断）
const SCALE_SCOPE_RE = /(?<![地上地下门卫室值班室配电室配电房泵房水泵房锅炉房公厕车库车棚岗亭传达室警卫室样板房售楼处门房])总?建筑面积|总?建设规模/u;
// 面积单位归一化：扫描文本先行归一，m2（ASCII 数字）与 ㎡/m²/平方米 同口径（历史漏报根因：正文混写 m2 与 ㎡）
const SCALE_UNIT_RE = /㎡|m²|m2|平方米/u;
const COST_SCOPE_RE = /合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价|工程总投资|总投资|工程造价/u;
const COST_UNIT_RE = /万元|亿元/u;

/** 设备分组/调度显式声明词（C8 S4-①b）：与分组词（组/村）同权——「本组配置8台，按全项目总表
 * 调度」类声明是对分组口径与全项目总量分层关系的显式注明，声明语境下的多值属合法分层提示；
 * 未声明语境的多值维持 blocker（真冲突照报）。 */
const SCHEDULE_DECLARATION_RE = /本组配置|分组配置|按全项目总表调度|按总表调度|总表调度|按全项目机械配置总表|按机械配置总表|按设备配置总表/u;

export async function crossChapterConsistencyIssues(markdown: string, factsModel: DocumentFactsModel, scopeConflicts?: NumericScopeConflict[], analyses?: Map<string, ProfessionalDepthAnalysis>, embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const scaleGapGate = await buildScaleGapGate(embedDocuments);
  const costGapGate = await buildCostGapGate(embedDocuments);
  // 校验基准与生成裁决同源：源级同口径冲突的裁决值（补疑修正后的胜出数值）优先作为期望口径，
  // 避免事实主表候选排序差异导致检查基准与裁决基准不一致（历史缺陷：正文全用胜出值时因主表取出败选值而误报）；
  // low 置信度裁决锚定弱，不作校验基准（与生成侧“不参与确定性改写”同口径）
  const scopeWinner = (kind: NumericScopeConflict['kind']) => scopeConflicts?.find(conflict => conflict.kind === kind && conflict.resolution && conflict.confidence !== 'low')?.resolution;
  // 裁决值是“数值+单位”短串（如“4646m2”），不带口径词前缀，直接从裁决值提取数值条目用于同口径比对
  const numericEntryFromResolution = (resolution: string) => {
    const match = /(\d+(?:\.\d+)?)\s*(㎡|m²|m2|平方米|万元|亿元)/u.exec(resolution);
    return match ? { value: match[1], unit: match[2] } : undefined;
  };
  const expectedSchedule = scopeWinner('duration') ?? factsModel.schedule.map(normalizedFactValue).find(value => /\d+\s*(?:日历天|天|个月|月)|计划工期|合同工期/u.test(value));
  const expectedQuality = factsModel.quality.map(normalizedFactValue).find(value => /质量|合格|优良/u.test(value));
  if (expectedSchedule) {
    const expectedDuration = durationValues(expectedSchedule)[0];
    // 剥离表格行：进度计划表中的分项持续时间（"第1日~第7日 7日历天"）是计划分解数据，
    // 不是总工期口径表述，不得与资料工期比对
    const nonTableMarkdown = markdown.split('\n').filter(line => !/^\s*\|/u.test(line.trim())).join('\n');
    // 4.19 工期冲突升 error（与面积/估算价口径同构：数字级不一致是低级错误，不得以表述误差放过）：
    // 带上下文窗口匹配，排除合法口径——顺延/延长条款（「不超过」「顺延」）、进度分解区间（「第N日~」）、
    // 子项分层工期（基坑/主体/装饰等阶段工期与总工期天然分层，不互斥）；
    // 窗口排除数字防贪婪回溯（「计划工期210日历天」窗口吞 210 后捕获组拿到 0 造成假冲突）；
    // 子项豁免需含锚点前 8 字符（「基础施工工期45日历天」的子项词在锚点前，match[0] 只有「工期45日历天」）
    const durationConflictRe = /(?:计划工期|合同工期|总工期|工期|施工周期)[^\d。；;\n|]{0,18}(\d{1,4})\s*日历天/gu;
    const conflicting: string[] = [];
    for (const match of nonTableMarkdown.matchAll(durationConflictRe)) {
      const beforeAnchor = nonTableMarkdown.slice(Math.max(0, (match.index || 0) - 8), match.index || 0);
      const context = beforeAnchor + match[0];
      if (/顺延|延长|展期|不超过|不大于|最多|累计|第\d+日/u.test(context)) continue;
      if (/基坑|支护|桩基|土方|基础|主体|装饰|装修|安装|室外|分项|分阶段|阶段|关键线路|单层|每层|地下室|砌体|二次结构|收尾|调试/u.test(context)) continue;
      const value = `${match[1]}日历天`;
      if (value !== expectedDuration && !conflicting.includes(value)) conflicting.push(value);
    }
    if (expectedDuration && conflicting.length >= 1) issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `跨章一致性冲突：正文出现与资料工期不一致的表述 ${conflicting.slice(0, 6).join('、')}`, suggestion: `请统一使用资料中的工期口径：${expectedSchedule}` });
  }
  // round-14 零误伤：质量目标词面未命中时由 bge 语义兑底（质量章节覆盖验收闭环语义即视为质量体系已体现），
  // 调用方未提供语义分析时保留词面判定（质量目标章节为模板固定结构，四词词表命中率极高，残余风险由 warning 级事实值反查兑底）
  if (expectedQuality && !/质量标准|质量目标|合格|优良/u.test(markdown)) {
    const semanticQualityCovered = analyses && [...analyses.values()].some(analysis => analysis.contentNeeds.quality);
    if (!semanticQualityCovered) issues.push({ level: 'error', message: '跨章一致性缺口：正文未稳定体现资料中的质量目标', suggestion: `请在工程概况、质量保证和验收相关章节统一体现：${expectedQuality}` });
  }
  // 建设规模口径冲突：资料中的建筑总量面积与正文同口径数值比对；
  // 期望口径只取建筑总量口径（建设规模/建筑面积）——用地面积/占地面积是独立字段，不得作为期望值；
  // 与裁决口径不符的取值出现 1 次即判定冲突（数字级不一致是低级错误，不得以“表述误差”放过），error 级进入修复链
  const areaResolution = scopeWinner('area');
  // 期望口径事实须能解析出建筑总量数值才可作基准：截断/占地口径事实（“建设规模：项目总占地面积约10970平方米”）
  // 解析不出建筑总量（resolveScaleExpectation 返回 undefined），跳过继续找下一条（round-21 S6 反向改错兜底）
  const scaleFactCandidates = factsModel.project.map(normalizedFactValue).filter(value => /建设规模|建筑面积/u.test(value));
  const scaleResolutions = await Promise.all(scaleFactCandidates.map(value => resolveScaleExpectation(value, scaleGapGate)));
  const expectedScale = areaResolution ?? scaleFactCandidates.find((_, index) => scaleResolutions[index] !== undefined);
  if (expectedScale) {
    const scaleMain = areaResolution ? numericEntryFromResolution(areaResolution) : await resolveScaleExpectation(expectedScale, scaleGapGate);
    const { entries: scaleMatches, skipped: scaleSkipped } = await scopedNumericEntries(markdown, SCALE_SCOPE_RE, SCALE_UNIT_RE, SCALE_GAP_WORDS_RE, SCALE_PREFIX_WORDS_RE, scaleGapGate, SCALE_ENTITY_WORDS_RE);
    if (scaleMain) {
      const scaleConflicts = scaleMatches.filter(entry => scaledNumericValue(entry) !== scaledNumericValue(scaleMain));
      if (scaleConflicts.length >= 1) issues.push({ level: 'error', message: `跨章一致性冲突：正文出现与资料建设规模不一致的表述 ${scaleConflicts.slice(0, 6).map(entry => `${entry.value}${entry.unit}`).join('、')}`, suggestion: `请统一使用资料中的建设规模口径：${expectedScale.slice(0, 80)}` });
    }
    // 规模口径复核（语义层）：正文存在“口径词与数值之间混入子项/专项口径词”的形态
    // （如“建设规模：地下建筑面积3786.97㎡”“办公区总建筑面积240㎡”），确定性层不做替换
    // （防错改优先），交由 LLM 依据项目规模事实卡核对该数值口径归属：与事实卡对应口径一致则保留，
    // 口径错位或数值不一致则改正（历史缺陷：确定性修复器盲替换把正确的 3786.97/240/10970 改错）
    if (scaleSkipped.length > 0) {
      const cardParts = [
        areaResolution ? `建筑总量裁决值：${areaResolution}` : '',
        ...factsModel.project.map(normalizedFactValue).filter(value => /建设规模|建筑面积|占地/u.test(value)).slice(0, 3),
      ].filter(Boolean);
      issues.push({
        level: 'warning',
        severity: 'warning',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `规模口径复核：正文 ${scaleSkipped.slice(0, 3).map(item => `“${item.context.slice(-14)}${item.value}${item.unit}”`).join('、')} 等 ${scaleSkipped.length} 处数值的口径词与数值之间或口径词前文出现子项/专项/实体口径词，需核对口径归属`,
        suggestion: `依据项目规模事实卡逐处核对该数值的口径归属（${cardParts.join('；') || '无可用事实卡，以绑定资料原文为准'}）：与事实卡对应口径一致的数值保留原样，口径错位或数值不一致的数值改正为事实卡对应口径值，不得把子项/专项口径数值改成建筑总量数值。`,
      });
    }
  }
  // 合同估算价口径冲突：估算价/最高限价等金额口径在正文中不得出现多个互相矛盾的取值
  const costResolution = scopeWinner('cost');
  const expectedCost = costResolution ?? factsModel.project.map(normalizedFactValue).find(value => /合同估算|投资估算|最高投标限价|招标控制价|总投资|工程造价/u.test(value));
  if (expectedCost) {
    const costMain = costResolution ? numericEntryFromResolution(costResolution) : (await scopedNumericEntries(expectedCost, COST_SCOPE_RE, COST_UNIT_RE, COST_GAP_WORDS_RE, undefined, costGapGate)).entries[0];
    const costMatches = (await scopedNumericEntries(markdown, COST_SCOPE_RE, COST_UNIT_RE, COST_GAP_WORDS_RE, undefined, costGapGate)).entries;
    if (costMain) {
      const costConflicts = costMatches.filter(entry => scaledNumericValue(entry) !== scaledNumericValue(costMain));
      if (costConflicts.length >= 1) issues.push({ level: 'error', message: `跨章一致性冲突：正文出现与资料估算价不一致的表述 ${costConflicts.slice(0, 6).map(entry => `${entry.value}${entry.unit}`).join('、')}`, suggestion: `请统一使用资料中的估算价口径：${expectedCost.slice(0, 80)}` });
    }
  }
  // ===== 工程量类目口径冲突（第十六版评审 A 类体系性矛盾根治：机械配置四套口径/隔油池 523vs68/挖沟槽双口径） =====
  // 检测范围从总量口径（工期/规模/估算价）扩展到工程量与设备数量类目：同对象同单位多值即报冲突；
  // 分组口径豁免：数字前 20 字符含「组/本组/每组/村」的分组配置值与总量值属合法分层（分组表注明调度关系即可），
  // 只报 warning 提示补充口径说明；无分组词的直接多值互斥 → error 进修复链
  // C-T4 机械矩阵泛化：检测词表从固定 7 词（挖掘机|压路机|自卸车|蛙夯|搅拌车|洒水车|高空车）
  // 扩展为通用机械名抽取（scanEquipmentCountClaims 单源：机/吊/泵/车/夯 结尾 + 虚词截断归一 +
  // 量词残留/片段拦截 + 备用租赁辅助配置丢弃 + 否定分句豁免；与 constructionOrgConsistency
  // 机械数量型号规则共用同一名称归一，避免检测口径漂移）
  // C8-7 声明句归因（s28m' 组2 复算实锤）：「本组配置8台，按全项目总表调度」的设备名在上一
  // 分句、与计数不邻接（桥接超 12 字且含逗号/数字，claim 扫描不捕获该计数）——S4①b 的
  // claim 窗口归因对「间隔声明」形态失效，存量数值 claim 语境均无声明致误报 blocker。
  // 补充 pass：声明词逐处定位取所在整句（。；;\n 边界），句内全部设备名（同一后缀模式 +
  // 同一归一函数单源）整体标归因——名称与声明同句（不论邻接与先后）即成立。
  const declaredEquipment = new Set<string>();
  for (const declaration of markdown.matchAll(new RegExp(SCHEDULE_DECLARATION_RE.source, 'gu'))) {
    const position = declaration.index ?? 0;
    const leftBoundary = Math.max(
      markdown.lastIndexOf('\n', position - 1),
      markdown.lastIndexOf('。', position - 1),
      markdown.lastIndexOf('；', position - 1),
      markdown.lastIndexOf(';', position - 1),
    );
    const rightBoundaries = ['\n', '。', '；', ';']
      .map(char => markdown.indexOf(char, position))
      .filter(index => index >= 0);
    const rightBoundary = rightBoundaries.length > 0 ? Math.min(...rightBoundaries) : markdown.length;
    for (const name of scanEquipmentNamesIn(markdown.slice(leftBoundary + 1, rightBoundary))) declaredEquipment.add(name);
  }
  const equipmentMatches = new Map<string, { values: string[]; grouped: boolean }>();
  // gap 排除顿号/逗号（4.27.0 A3 校准）：「5台挖掘机，其中3台用于…」的分配语境不得采为「挖掘机3台」口径——
  // 与修复器 CROSS_SECTION_ANCHORS excavator 模式（排除 、，）检测/修复口径对齐，防检测报冲突而修复看不到的拉扯
  for (const claim of scanEquipmentCountClaims(markdown)) {
    // r15 丰乐镇 B3 归因：配套比结构（「每台挖掘机配1台自卸汽车」）的 1台 是单位配套数非口径值，
    // 不得采为前设备台数（5 vs 1 假冲突）——与 CROSS_SECTION_ANCHORS 修复器/检测器同源豁免
    //（isUnitPairRatioMatch 单源，r11 配套比豁免通用化）
    if (isUnitPairRatioMatch(markdown, claim.start, claim.text)) continue;
    const equipment = claim.name;
    const value = String(claim.count);
    // 分组语境窗口覆盖捕获文本本身（贪婪捕获起点前移：分组词可能落在 raw 内，如「每组挖掘机2台」），
    // 并覆盖数值后置声明（C8 S4-①b：「本组配置8台，按全项目总表调度」的声明词在数值之后）
    const context = markdown.slice(Math.max(0, claim.start - 20), claim.start + claim.text.length + 24);
    // C8 S4-①b 归因（s28m'「高清网络球形摄像机」33/8/22 与「数字硬盘录像机」8/33 误报阻断实锤）：
    // 调度声明词（本组配置/分组配置/按全项目总表调度）与分组词（组/村）同权识别——此前仅按「组」
    // 字窗口分类，「按全项目总表调度」类声明不含「组」字不亮，声明取值与未声明取值分池后普通池
    // 仍多值 → 误报 blocker。同设备**任一**取值带分组/调度语境 → 该设备整体按分组口径提示降级
    // warning（全项目总量与分组配置并存属合法分层，删除与总表矛盾的硬阻断）；无任何声明语境时
    // 维持 blocker（真冲突照报，零放松）。
    const grouped = /组|村/u.test(context) || SCHEDULE_DECLARATION_RE.test(context);
    const entry = equipmentMatches.get(equipment) || { values: [], grouped: false };
    if (!entry.values.includes(value)) entry.values.push(value);
    entry.grouped = entry.grouped || grouped;
    equipmentMatches.set(equipment, entry);
  }
  // C8-7 清单多条目分层感知（s28m' 组2 复算实锤）：「高清网络球形摄像机」清单 2 条（8+3）、
  // 「数字硬盘录像机」清单 3 条（8+3+10）——正文按「部位明细 + 汇总求和」复述属清单原生分层
  // （与 extractStreetLightAuthority 路灯多条目求和同源模式）。判据数据源驱动：同设备清单条目
  // ≥2 且各行工程量可解析、正文取值均不超条目总和 → 合法分层降级 warning；超总和 / 单条目 /
  // 无清单数据维持 blocker（零放松：正文值大于清单总量必为错误，照报）。
  const billEntryCounts = new Map<string, number>();
  const billEntryTotals = new Map<string, number>();
  for (const fact of factsModel.billItemFacts ?? []) {
    const raw = stringifyFactValue(fact.value);
    const nameText = /名称[：:]\s*([^\n｜]+)/u.exec(raw)?.[1] ?? '';
    const equipmentName = normalizeEquipmentClaimName(nameText.replace(/[（(][^）)]*[）)]/gu, '').trim());
    if (!equipmentName) continue;
    const quantityText = raw.split('｜工程量：')[1] ?? '';
    const quantityMatch = /(\d+(?:\.\d+)?)\s*(?:台|套|辆)/u.exec(quantityText);
    const quantity = quantityMatch ? Number(quantityMatch[1]) : Number.NaN;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    billEntryCounts.set(equipmentName, (billEntryCounts.get(equipmentName) || 0) + 1);
    billEntryTotals.set(equipmentName, (billEntryTotals.get(equipmentName) || 0) + quantity);
  }
  for (const [equipment, entry] of equipmentMatches) {
    if (entry.values.length < 2) continue;
    const conflictText = entry.values.join('、');
    // C8-7 声明句归因（设备级，declaredEquipment）与清单多条目分层（billLayered）：
    // 与 claim 级窗口归因（entry.grouped）同权，任一成立即整体降级 warning（合法分层不硬阻断）
    const maxClaimed = Math.max(...entry.values.map(value => Number(value)));
    const billLayered = (billEntryCounts.get(equipment) ?? 0) >= 2
      && Number.isFinite(maxClaimed)
      && maxClaimed <= (billEntryTotals.get(equipment) ?? 0);
    if (entry.grouped || declaredEquipment.has(equipment) || billLayered) {
      issues.push({ level: 'warning', severity: 'warning', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `设备分组口径提示：正文「${equipment}」存在分组配置台数 ${conflictText} 多值并存，需注明分组与全项目总量的调度关系`, suggestion: `分组配置（组/村级）与全项目总量并存时，必须在正文注明「本组配置、按总表调度」或明确分组数量与总量数量之间的对应关系，避免评标误读为口径矛盾。` });
    } else {
      issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `跨章一致性冲突：正文「${equipment}」配置台数出现互相矛盾的取值 ${conflictText}`, suggestion: `全项目「${equipment}」配置总量必须全文唯一：以全项目机械配置总表为准统一全部表述；分组配置必须显式注明「本组配置、按总表调度」并删除与总表矛盾的全项目口径数字。` });
    }
  }
  // 隔油池/挖沟槽土方：同对象多值互斥（工程量清单类目，出现多值即冲突）
  // P6 误报校准（run1 实测 1 条误报）：挖沟槽土方在多单体项目按部位独立成量（全项目 20420.39m³
  // 与排水 838.81/5106.97、门卫 3.15 等分部位真值合法并存），非口径矛盾——contextAware 条目
  // 仅当任意两条取值的 24 字前置语境共享 ≥6 字连续汉字成分（同句同语境）时判冲突；全部分异即
  // 合法分部位列举。阈值 6：单条锚点前缀「挖沟槽土方」仅 5 字，不至把纯锚点共享误判为同语境。
  // 4.31 gap 收窄+标点阻断（丰乐镇 v6 #76 实测）：原 gap {0,15} 允许跨「：」等标点远距离取数，
  // 把「4. 检查井、隔油池与终端设施安装：塑料检查井共555座」中相邻检查井数量 555
  // 误算成隔油池第二个口径（523 vs 555 假冲突）；限 {0,6} 并排除冒号/逗号类分隔符
  const quantityScopeEntries: Array<{ label: string; re: RegExp; contextAware?: boolean }> = [
    { label: '隔油池数量', re: /隔油池[^\d。；;\n|：:，,、]{0,6}(\d+)\s*座/gu },
    { label: '挖沟槽土方', re: /挖沟槽[^\d。；;\n|]{0,15}([\d,]+(?:\.\d+)?)\s*m[³3]/gu, contextAware: true },
  ];
  /**
   * 对象区分标识（编号/分区/单体）：`2#门卫`、`3号厂房`、`一区`、`B栋`。
   * 只取**区分性**标识形态（数字+#/号、序数+区/栋/座/幢、字母+栋/座/幢/区），
   * 不取通用名词——「门卫」「厂房」这类类别词不构成对象区分。
   */
  const OBJECT_MARKER_RE = /(?:\d+\s*[#＃号]|[一二三四五六七八九十]\s*[区栋座幢]|[A-Za-z]\s*[栋座幢区])/gu;
  /**
   * 对象作用域：命中所在的**小节标题行 + 取值所在句 + 前一句**。
   * 24 字前置语境不够——4.55.31 巢湖实测（doc-1790125123717-ce5cc107）：三处挖沟槽土方取值
   * ①「#### 1.5.2 2#门卫」标题 + 前一句「2#门卫为单层框架结构…C25商品混凝土。」+ 本句
   *   「作业对象含场地平整241.71m²、挖沟槽土方346.88m³」——标识既在**标题行**也在**前一句**，
   *   距取值 60+ 字，24 字窗口取不到 → 旧判据退化成「共享 ≥6 连续汉字」，与 3#门卫 的 37.51
   *   共享「门卫按平整场地」7 字而误报；②「#### 1.27.2 土石方工程」段落中
   *   「2#门卫基础土方按…场地平整241.71m²，挖沟槽土方346.88m³」——标识在本句但距取值 30+ 字。
   * 标题行必须取：小节即对象的文档里标识只出现于标题（对象标识标在章节名上）。
   */
  const hitScopeStart = (index: number) => {
    const boundaryBefore = (position: number) => Math.max(
      markdown.lastIndexOf('\n', position - 1),
      markdown.lastIndexOf('。', position - 1),
      markdown.lastIndexOf('；', position - 1),
      markdown.lastIndexOf(';', position - 1),
      markdown.lastIndexOf('！', position - 1),
      markdown.lastIndexOf('？', position - 1),
    );
    const sentenceStart = boundaryBefore(index) + 1;
    const previousSentenceStart = boundaryBefore(sentenceStart - 1) + 1;
    const heading = [...markdown.slice(0, index).matchAll(/^#{1,6}[^\n]*/gmu)].pop();
    // 有标题时取「本句前一句 + 所属标题行」的更早者（标识可能落在标题行或前一句）；**无标题时只回退到前一句**，
    // 不得回退到全文句首——否则未标注取值会继承前文无标题段落中的对象标识（4.55.29 L0-8 实测：第三行
    // 「室外附属工程挖沟槽土方9926.65m³」在无标题文本里会把前两行的 2#/3# 一并收入，误判与 346.88 同对象）。
    return heading ? Math.max(0, Math.min(previousSentenceStart, heading.index)) : Math.max(0, previousSentenceStart);
  };
  /**
   * 对象签名：作用域内**距取值最近**的对象标识（取值前/后皆可，同距并列全取）。
   * 「同一句里既提到 2#门卫又提到 3#门卫」（如「2#门卫挖沟槽土方346.88m³、3#门卫挖沟槽土方37.51m³」）
   * 时近者胜：取值与其所属对象的标识通常相邻，更远的那个标识属另一个对象的从句；
   * 若两标识与取值等距（如「2#、3#门卫合计…」）则两个都取，该取值同时归属两个对象组。
   * 目录/章节编号（`1.22`、`3.8`）不构成本正则的任何形态（无 #/号/区/栋/座/幢 后缀），
   * 因此「1.22 周」这类编号+标题首字不会被读成对象标识。
   */
  const objectSignature = (scope: string, scopeStart: number, index: number): string[] => {
    const markers = [...scope.matchAll(OBJECT_MARKER_RE)]
      .filter(match => !/[与同和及跟]\s*$/u.test(scope.slice(Math.max(0, (match.index || 0) - 3), match.index || 0)))
      // 并列引用语境里的标识指向**被引用的另一个对象**，不是本取值所属对象——「3#门卫为框架结构…**与2#门卫**
      // 同属门卫单体。作业对象含…挖沟槽土方37.51m³」中 37.51 属 3#门卫，而「与2#门卫」的 2# 距取值更近，
      // 使 37.51 被归入 2# 组、与 2#门卫的 346.88 同组误报（4.55.32 巢湖实测 doc-1790132484476-29b74c88）。
      // 故：标识紧接「与/同/和/及/跟」引导时剔除（「2#门卫与3#门卫」的 3# 同属被引用对象，同样剔除）。
      .map(match => ({ marker: match[0].replace(/\s+/gu, ''), at: scopeStart + (match.index || 0) }));
    if (markers.length === 0) return [];
    const distances = markers.map(item => Math.abs(item.at - index));
    const nearest = Math.min(...distances);
    return [...new Set(markers.filter((_, position) => distances[position] === nearest).map(item => item.marker))].sort();
  };
  for (const { label, re, contextAware } of quantityScopeEntries) {
    const entries: Array<{ value: string; context: string; markers: string[] }> = [];
    for (const match of markdown.matchAll(re)) {
      const value = match[1].replace(/,/gu, '');
      if (entries.some(entry => entry.value === value)) continue;
      const index = match.index || 0;
      const scopeStart = hitScopeStart(index);
      entries.push({
        value,
        context: markdown.slice(Math.max(0, index - 24), index),
        markers: objectSignature(markdown.slice(scopeStart, index + match[0].length), scopeStart, index),
      });
    }
    if (entries.length >= 2) {
      // 4.55.31 对象分组口径（4.55.29 判据的完整版）：同对象同属性多值才是缺陷——按「语境中的对象
      // 标识」把命中分组，**只在同组内比较取值，跨组不判**；无标识的归入「未标注」组。
      // 分组判据（任取两条命中）：
      //   ① 两条各取到对象标识（`2#`/`三区`/`B栋`…）：交集非空 = 同组（同一对象）→ 多值即冲突；
      //      交集为空 = 跨组（不同对象）→ **不判**（巢湖实测 2#门卫 346.88 / 3#门卫 37.51 /
      //      室外 9926.65 / 室外安装 1900.8 四条即四组，各单体工程量天然不同）。
      //   ② 两侧都取不到标识 = 同属**「未标注」组**——「未标注」不等于「同一对象」（4.55.31 巢湖
      //      实测：未标注的 9926.65 属室外附属土方、1900.8 属室外安装管道沟槽，分属不同部位），
      //      不能因组内多值即判冲突，须再有**同源语境证据**：24 字前置语境共享 ≥6 字连续汉字
      //      成分（同句/同列表并列）才算同一对象的同一工程量。阈值 6：单条锚点前缀「挖沟槽土方」
      //      仅 5 字，不至把纯锚点共享误判为同语境。
      //   ③ 一方有标识、一方无标识 = **跨组**（未标注取值与有标识取值不能断言同一对象）→ 不判；
      //      4.55.31 的「任一侧无标识即退回语境判据」即此残留误报来源，4.55.32 收口。
      // contextAware 条目（部位/单体分列成量是常态）用上述证据判据；其余条目（隔油池数量，
      // 窗口已阻断标点）维持原判据——多值即冲突，零放松（仅跨对象标识互斥时豁免）。
      const unmarkedGroup = '\u0000未标注';
      const groupsOf = (entry: { markers: string[] }) => (entry.markers.length > 0 ? entry.markers : [unmarkedGroup]);
      const sameObjectGroups = (left: typeof entries[number], right: typeof entries[number]) => {
        const rightGroups = groupsOf(right);
        const shared = groupsOf(left).filter(group => rightGroups.includes(group));
        if (shared.length === 0) return false;
        // 两侧都无标识 = 同属「未标注」组，须再有同源语境证据才算同一对象；一方有标识一方无标识
        // 属**跨组**（未标注 ≠ 同一对象），不判——③ 的旧行为（任一侧无标识即退回语境判据）正是
        // 4.55.31 残留误报的来源。
        return shared.every(group => group === unmarkedGroup)
          ? !contextAware || longestCommonHanSubstring(left.context, right.context) >= 6
          : true;
      };
      if (!entries.some((left, index) => entries.slice(index + 1).some(right => sameObjectGroups(left, right)))) continue;
      const values = entries.map(entry => entry.value).join('、');
      issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `跨章一致性冲突：正文${label}出现互相矛盾的取值 ${values}`, suggestion: `${label}必须全文唯一：以工程量清单为最高优先级裁定正确值，将正文全部相关表述统一为该值，并删除其余矛盾口径。` });
    }
  }
  // 阶段工期文字表述加总校验（第十六版 L308/L375：各阶段 7/63/10/7/2 天合计 89 ≠ 90）
  if (expectedSchedule) {
    const expectedDurationForStage = durationValues(expectedSchedule)[0];
    const expectedDays = Number(/(\d+)\s*(?:日历天|天)/u.exec(expectedDurationForStage || '')?.[1]);
    const stageSumRe = /各阶段工期(?:分别)?为?\s*[：:]?\s*([\d]+(?:\s*[、,，]?\s*\d+)*)\s*(?:天|日历天)/gu;
    for (const match of markdown.matchAll(stageSumRe)) {
      const numbers = match[1].split(/[、,，]/u).map(part => Number(part.trim())).filter(value => Number.isFinite(value));
      const sum = numbers.reduce((total, value) => total + value, 0);
      if (Number.isFinite(expectedDays) && sum > 0 && sum !== expectedDays) {
        issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `跨章一致性冲突：正文各阶段工期文字表述（${match[1]}天）合计 ${sum} 天，与总工期 ${expectedDays} 天不符`, suggestion: `各阶段工期加总必须等于总工期 ${expectedDays} 天：核对各阶段天数并修正文字表述，或与阶段计划表保持一致。` });
      }
    }
  }
  // 宿舍容纳人数逻辑校验（第十六版 L993：每间容纳 216 人 = 高峰总人数，逻辑错误）
  for (const match of markdown.matchAll(/每间(?:可)?容纳\s*(\d+)\s*人/gu)) {
    const capacity = Number(match[1]);
    if (capacity >= 100) {
      issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `逻辑校验失败：正文出现「每间容纳 ${capacity} 人」的宿舍配置表述，单间宿舍不可能容纳 100 人以上`, suggestion: `宿舍容纳人数按单间 4~8 人配置计算间数（如高峰 216 人按每间 8 人需 27 间），修正配置表述为「每间 X 人、共 Y 间，满足高峰在场人数」的完整口径。` });
    }
  }
  // 同日起止区间校验（第十六版 L393：第 90 日～第 90 日）
  for (const match of markdown.matchAll(/第(\d+)\s*日\s*[~～—至到]\s*第(\d+)\s*日/gu)) {
    if (match[1] === match[2]) {
      issues.push({ level: 'error', severity: 'blocker', category: 'fact_consistency', owner: 'llm', repairability: 'llm_repairable', message: `逻辑校验失败：正文出现「第 ${match[1]} 日～第 ${match[2]} 日」的零长度区间表述`, suggestion: `起止日相同的区间属笔误：按该事项所属施工阶段的实际起止日修正（如进场时间应为阶段开始前）。` });
    }
  }
  return issues;
}

// ===== 工序规格冲突扫描 =====
// 资料中明确的结构层规格（找平层/防水层等配比与厚度）被正文改写为其他数值时，属低级错误，
// 必须确定性拦截（历史缺陷：屋面找平层资料 1:2.5+20mm 被正文写成 1:3+15mm）

const SPEC_LAYER_RE = /找平层|抹灰层|防水层|保温层|结合层|垫层|面层|粘结层|隔热层|隔离层/gu;
// 数值与层名之间出现施工动作动词，说明该数值描述的是施工过程/其他层（如“保温层施工完成后铺设
// 20mm 厚找平层”，20mm 属找平层不属保温层），当前层不得占用。注意“采用”不是排除词：
// 层名后“采用 1:3 水泥砂浆厚 20mm”是标准规格句式，数值仍属当前层
const SPEC_ACTION_RE = /铺设|施工|浇筑|粘贴|铺贴|涂抹|完成|进行|待|设置|铺装|挂网|喷涂|灌注/u;

/**
 * 非厚度语义闸（4.55.24 实测根治）：窗口内出现这些语义时，其中的 `数值+mm` **不是层厚度**。
 *
 * **实测根因**（巢湖 真实自测，用户实测提问复现）：源资料原文
 * `塘渣层计算弯沉值为3.41mm,压实标准见垫层压实度要求。`——`3.41mm` 是**弯沉值**，
 * 而层名「垫层」出现在同句。原判据按「层名后 90 字内首个 mm 数值」取值，且 CAD 文字层双写
 * （见 4.55.24 knowledge 侧修复）让「塘渣层计算弯沉值为3.41mm」在「垫层」之后再次出现 →
 * 归属成立。于是「资料中垫层唯一厚度 = 3.41mm」→ 定点修复器把**正文里所有垫层厚度
 * （含图纸原件正确的 100mm）全局改写成 3.41mm**，再由下一环节改写为 1.5mm
 *（上一版交付物 `垫层厚度 1.5mm` 的真正来源，非模型移植）。
 *
 * 位置：层名与数值之间（direction='first'）或数值之后（direction='last'）的 gap。
 * 误伤方向安全：判为"非厚度"只会**少改**（不登记目标 → 不替换正文），不会改错。
 */
const NON_THICKNESS_SEMANTIC_RE = /(?:弯沉|压实|回弹模量|强度|模量|偏差|误差|抗渗|抗冻|标高|覆土|净空|坡度|坡率|直径|管径|宽度|长度|高度|间距|面\s*积|体积|荷载|含水率|孔隙率|比例|图号|编号|桩号|坐标)/u;

/** 句读截断：厚度归属不得跨句取值（原窗口为「下一个层名或 +90 字」，会把下一句的数值算进来） */
function sameSentenceAfter(text: string): string {
  const cut = text.search(/[。；\n]/u);
  return cut >= 0 ? text.slice(0, cut) : text;
}

function sameSentenceBefore(text: string): string {
  const parts = text.split(/[。；\n]/u);
  return parts[parts.length - 1] ?? text;
}

/** 层配比物理合理域（4.55.24）：分母 >100 不是砂浆/混凝土配比。
 * 实测污染源：CAD 双写使比例尺 `1:100` 变为 `1:1001:100`，抽取到配比 `1:1001` 并把正文
 * 砂浆配比 `1:2` 全局改写为 `1:1001`。 */
const SPEC_RATIO_MAX_DENOMINATOR = 100;

/** 厚度定点替换的量级上限（4.55.24）：比值 >5 视为"不是同一对象的口径"，不做机器改写。
 * 实测：正文防水层 250mm/30mm/100mm 因「资料里防水层唯一厚度 3mm」被批量改成 3mm（最大 83 倍）。 */
const SPEC_THICKNESS_REPLACE_MAX_RATIO = 5;

// 阶段五语义升级：动作词语义扩围——词面未命中但语义属“施工过程/工序动作”的 gap 由语义 gate 承接，
// 检测与确定性修复共用同一归属规则（collectLayerNumbers），语义扩围同口径生效。
const SPEC_ACTION_SEMANTIC_PROTOTYPES = [
  '施工过程与工序动作的先后描述',
  '铺设浇筑完成后再进行的工序',
] as const;
const SPEC_ACTION_LEGAL_PROTOTYPES = [
  '结构层的厚度与配比参数',
  '找平层厚20毫米的规格',
] as const;

async function buildSpecActionGate(embedDocuments?: (texts: string[]) => Promise<number[][]>) {
  return buildSemanticGate({
    prototypes: [...SPEC_ACTION_SEMANTIC_PROTOTYPES],
    negativePrototypes: [...SPEC_ACTION_LEGAL_PROTOTYPES],
    embedDocuments,
  });
}

/** 层名→归属数值（含位置）的收集：检测与确定性定点修复共用同一套归属规则，保证“检测定位=修复定位” */
async function collectLayerNumbers(text: string, actionGate?: (texts: string[]) => Promise<boolean[]>): Promise<Array<{ layer: string; span: [number, number]; raw: string; kind: 'thickness' | 'ratio' }>> {
  const claims: Array<{ layer: string; span: [number, number]; raw: string; kind: 'thickness' | 'ratio' }> = [];
  const matches = [...text.matchAll(SPEC_LAYER_RE)];
  const usedRanges: Array<[number, number]> = [];
  const isUsed = (start: number, end: number) => usedRanges.some(([s, e]) => start < e && end > s);
  // 语义扩围候选：gap 非空且词面动作词未命中的归属登记，语义确认“工序动作”后撤销该归属
  const uncertainGaps: Array<{ key: string; gap: string }> = [];
  // 在窗口内按方向取第一个/最后一个“未被占用且与层名之间无施工动作”的数值，命中即登记占用，
  // 保证一个数值只归属一个层（多层连续描述“找平层 20mm、防水层 2mm、保温层 130mm”各取各值）
  const claim = (window: string, offset: number, re: RegExp, direction: 'first' | 'last', layer: string, kind: 'thickness' | 'ratio') => {
    const found = [...window.matchAll(re)];
    const ordered = direction === 'first' ? found : [...found].reverse();
    for (const m of ordered) {
      const absStart = offset + (m.index ?? 0);
      const absEnd = absStart + m[0].length;
      if (isUsed(absStart, absEnd)) continue;
      const gap = direction === 'first' ? window.slice(0, m.index ?? 0) : window.slice((m.index ?? 0) + m[0].length);
      if (SPEC_ACTION_RE.test(gap)) continue;
      // 4.55.24 非厚度语义闸：弯沉值/压实度/强度/偏差… 不是层厚度（实测：垫层←塘渣层弯沉值 3.41mm）
      if (kind === 'thickness' && NON_THICKNESS_SEMANTIC_RE.test(gap)) continue;
      // 层厚度物理合理边界：构造层（找平/面层/防水/保温/结合/垫层等）厚度物理区间 (0,1000)mm。
      // 窗口内首个 mm 数值可能是平整度偏差/瓷砖规格等非厚度语义（4.19.5 真实回归：
      // 「面层…2000mm」被误当厚度权威，确定性修复把正文 20mm/9mm 批量替换为 2000mm，
      // 制造「每层厚度7～2000mm」错误参数被青天评审报高风险）——超界值跳过继续找下一个候选
      if (kind === 'thickness') {
        const rawValue = Number(m[1] ?? '');
        if (!Number.isFinite(rawValue) || rawValue <= 0 || rawValue >= 1000) continue;
      }
      // 4.55.24 配比合理域：分母 >100 不是砂浆/混凝土配比（实测：CAD 双写把比例尺 1:100 变成
      // 1:1001:100 → 抽到配比 1:1001 → 正文砂浆配比 1:2 被全局改写成 1:1001）
      if (kind === 'ratio') {
        const denominator = Number(m[1]?.split(':')[1] ?? '');
        if (!Number.isFinite(denominator) || denominator <= 0 || denominator > SPEC_RATIO_MAX_DENOMINATOR) continue;
      }
      if (actionGate && gap.trim()) uncertainGaps.push({ key: `${layer}|${absStart}|${absEnd}`, gap });
      usedRanges.push([absStart, absEnd]);
      claims.push({ layer, span: [absStart, absEnd], raw: m[0], kind });
      return;
    }
  };
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const layer = match[0];
    // 规格数值关联：优先取当前层名之后、下一个层名之前的区间（“保温层厚130mm”“保温层（XPS）130mm”），
    // 该区间无数值时兜底取上一个层名之后、当前层名之前的区间（“130mm厚保温层”）。
    // 历史缺陷：旧实现用“层名前 60 字符”宽窗口取第一个数值，多层连续描述（如“找平层 20mm、防水层 2mm、
    // 结合层 30mm、保温层 130mm”）时把前层数值误归当前层——正文写对也会误报冲突（用户环境误报
    // 保温层 20/30/2mm），且修复器在正文找不到“保温层 20mm”无法定位，残留冲突被导出校验硬阻断形成死循环
    const layerStart = match.index ?? 0;
    const layerEnd = layerStart + layer.length;
    const nextLayerStart = matches[i + 1]?.index;
    const afterEnd = nextLayerStart === undefined ? Math.min(text.length, layerEnd + 90) : nextLayerStart;
    // 4.55.24 句读截断：厚度/配比归属**不得跨句**（原窗口取到「下一个层名或 +90 字」，
    // 会把下一句的数值算进来——实测「…见垫层压实度要求。塘渣层计算弯沉值为3.41mm」）
    const after = sameSentenceAfter(text.slice(layerEnd, afterEnd));
    const prevLayerEnd = i > 0 ? (matches[i - 1].index ?? 0) + matches[i - 1][0].length : Math.max(0, layerStart - 40);
    const before = sameSentenceBefore(text.slice(prevLayerEnd, layerStart));
    // before 是「到层名为止的末句」，故其绝对偏移 = layerStart - before.length
    const beforeOffset = layerStart - before.length;
    claim(after, layerEnd, /(\d+:\d+(?:\.\d+)?)/gu, 'first', layer, 'ratio');
    claim(before, beforeOffset, /(\d+:\d+(?:\.\d+)?)/gu, 'last', layer, 'ratio');
    claim(after, layerEnd, /(\d+(?:\.\d+)?)\s*mm/gu, 'first', layer, 'thickness');
    claim(before, beforeOffset, /(\d+(?:\.\d+)?)\s*mm/gu, 'last', layer, 'thickness');
  }
  // 语义复核：gap 语义属施工动作的归属撤销（该数值属其他层/施工过程，当前层不得占用）
  if (actionGate && uncertainGaps.length > 0) {
    const flags = await actionGate(uncertainGaps.map(item => item.gap));
    const actionKeys = new Set(uncertainGaps.filter((_, index) => flags[index]).map(item => item.key));
    return claims.filter(claim => !actionKeys.has(`${claim.layer}|${claim.span[0]}|${claim.span[1]}`));
  }
  return claims;
}

async function layeredSpecEntries(text: string, actionGate?: (texts: string[]) => Promise<boolean[]>) {
  const entries: Array<{ layer: string; ratio?: string; thickness?: number }> = [];
  const seen = new Set<string>();
  for (const claim of await collectLayerNumbers(text, actionGate)) {
    const ratio = claim.kind === 'ratio' ? claim.raw.match(/(\d+:\d+(?:\.\d+)?)/u)?.[1] : undefined;
    const thicknessMatch = claim.kind === 'thickness' ? claim.raw.match(/(\d+(?:\.\d+)?)/u)?.[1] : undefined;
    const thickness = thicknessMatch ? Number(thicknessMatch) : undefined;
    const key = `${claim.layer}|${ratio || ''}|${thickness ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ layer: claim.layer, ratio, thickness });
  }
  return entries;
}

export async function processSpecConflictIssues(markdown: string, factsModel: DocumentFactsModel, embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const actionGate = await buildSpecActionGate(embedDocuments);
  const sourceText = [
    ...factsModel.specifications,
    ...factsModel.quality,
    ...factsModel.preciseFacts,
    ...factsModel.bills,
  ].map(normalizedFactValue).join('\n');
  const sourceEntries = await layeredSpecEntries(sourceText, actionGate);
  if (sourceEntries.length === 0) return issues;
  // 资料侧同一结构层出现多个不同规格时口径不唯一，跳过该层（无法确定性裁决）
  const sourceByLayer = new Map<string, typeof sourceEntries>();
  for (const entry of sourceEntries) {
    const list = sourceByLayer.get(entry.layer) || [];
    list.push(entry);
    sourceByLayer.set(entry.layer, list);
  }
  const bodyEntries = await layeredSpecEntries(markdown, actionGate);
  const reported = new Set<string>();
  for (const [layer, sources] of sourceByLayer) {
    const sourceRatios = [...new Set(sources.map(entry => entry.ratio).filter(Boolean))];
    const sourceThicknesses = [...new Set(sources.map(entry => entry.thickness).filter((value): value is number => Number.isFinite(value)))];
    const layerBodyEntries = bodyEntries.filter(entry => entry.layer === layer);
    /**
     * 4.56.4 口径唯一性判据的**对称补全**（实测 8 条 blocker 的根因）。
     *
     * 原判据只保证**资料侧**口径唯一（`sourceThicknesses.length === 1`，见上方注释「资料侧同一结构层
     * 出现多个不同规格时口径不唯一，跳过该层」），却对**正文侧**不作任何唯一性要求——于是
     * 「资料里垫层只有一个厚度 120mm」被用来要求**正文里每一处「垫层」都等于 120mm**。
     * 而 `垫层` 在道路/管沟/地坪/基础下本就是**不同对象、不同厚度**：实测正文出现
     * 50/100/200/10/30/300/150/5mm 八种取值 → 8 条「工序规格冲突」error，
     * 而 `factIntegrity` 统计的是本类别**全部** error（`factErrors.length`），
     * 8 条即把 60% 分量压到 0（事实维度 40 分、综合 87 的直接成因）。
     *
     * 判据：**正文侧同一层名出现 >1 个不同厚度/配比时，该层名不再唯一指代某一对象**，
     * 与资料侧同源规则一致——无法确定性裁决，跳过比对。**且显性记录不静默**（零静默降级口径）：
     * 逐层输出 warning 说明跳过原因与取值清单，供人工复核，绝不假装「已核对通过」。
     *
     * 召回损失是**真实且已权衡**的：正文写对一处、写错一处（2 种取值）时也不再报。
     * 该场景在层名不含对象限定时本就不可裁决（无法判定哪一处对应资料口径），
     * 与其用同一份资料值去批量改写正确内容（历史事故：正文防水层 250/30/100mm 被批量改成 3mm），
     * 不如如实标注"无法裁决"并交给人工。
     */
    const bodyThicknesses = [...new Set(layerBodyEntries.map(entry => entry.thickness).filter((value): value is number => Number.isFinite(value)))];
    const bodyRatios = [...new Set(layerBodyEntries.map(entry => entry.ratio).filter(Boolean))];
    if (bodyThicknesses.length > 1 || bodyRatios.length > 1) {
      issues.push({
        level: 'warning',
        message: `工序规格口径不唯一，已跳过确定性比对：正文「${layer}」出现 ${bodyThicknesses.length} 种厚度（${bodyThicknesses.join('、')}mm）${bodyRatios.length > 1 ? `、${bodyRatios.length} 种配比（${bodyRatios.join('、')}）` : ''}——该层名在正文中指代多个对象（如道路/管沟/地坪垫层厚度本就不同），资料侧单一口径无法裁决`,
        suggestion: `如需确定性核对，请在正文为层名补充对象限定（如「管沟垫层 120mm」「道路垫层 200mm」），或在资料/参数桶中分别登记各对象的规格。`,
      });
      continue;
    }
    for (const body of layerBodyEntries) {
      if (sourceRatios.length === 1 && body.ratio && body.ratio !== sourceRatios[0]) {
        const key = `ratio|${layer}|${body.ratio}`;
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({ level: 'error', message: `工序规格冲突：正文${layer}配比 ${body.ratio} 与资料口径 ${sourceRatios[0]} 不一致`, suggestion: `请将${layer}配比统一为资料口径 ${sourceRatios[0]}，禁止改写资料规格。` });
        }
      }
      if (sourceThicknesses.length === 1 && Number.isFinite(body.thickness) && (body.thickness as number) !== sourceThicknesses[0]) {
        const key = `thickness|${layer}|${body.thickness}`;
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({ level: 'error', message: `工序规格冲突：正文${layer}厚度 ${body.thickness}mm 与资料口径 ${sourceThicknesses[0]}mm 不一致`, suggestion: `请将${layer}厚度统一为资料口径 ${sourceThicknesses[0]}mm。` });
        }
      }
    }
  }
  return issues;
}

// ===== 确定性定点修复 =====
// LLM 定向修复（fact_conflict）受“无法安全定位的问题不要生成 patch”约束，数值冲突经 2 轮修复仍可能
// 残留，残留会被导出门禁硬阻断形成“继续生成”死循环（历史缺陷：用户环境保温层 20/30/2mm、10970㎡
// 冲突修复器在正文无法定位 → 不产出 patch → 残留 → 阻断）。此处按检测同源归属规则
// （collectLayerNumbers / scopedNumericEntries）定位错误数值并确定性替换为资料口径，
// 保证“检测定位=修复定位”，不依赖 LLM 定位能力。

/** 与 processSpecConflictIssues / crossChapterConsistencyIssues 完全同源的修复目标口径；
 * 语义 gates 随 targets 携带，供 fixChapterDeterministic 复用——修复侧与检测侧同口径语义扩围（防"检测排除修复改写"） */
async function deterministicFixTargets(factsModel: DocumentFactsModel, scopeConflicts?: NumericScopeConflict[], embedDocuments?: (texts: string[]) => Promise<number[][]>) {
  const scaleGapGate = await buildScaleGapGate(embedDocuments);
  const costGapGate = await buildCostGapGate(embedDocuments);
  const actionGate = await buildSpecActionGate(embedDocuments);
  const sourceText = [
    ...factsModel.specifications,
    ...factsModel.quality,
    ...factsModel.preciseFacts,
    ...factsModel.bills,
  ].map(normalizedFactValue).join('\n');
  const sourceByLayer = new Map<string, { ratios: string[]; thicknesses: number[] }>();
  for (const entry of await layeredSpecEntries(sourceText, actionGate)) {
    const list = sourceByLayer.get(entry.layer) || { ratios: [], thicknesses: [] };
    if (entry.ratio && !list.ratios.includes(entry.ratio)) list.ratios.push(entry.ratio);
    if (Number.isFinite(entry.thickness) && !list.thicknesses.includes(entry.thickness as number)) list.thicknesses.push(entry.thickness as number);
    sourceByLayer.set(entry.layer, list);
  }
  // 资料同层多口径时无法确定性裁决，跳过该层（与检测侧“口径不唯一跳过”一致）
  const specTargets = new Map<string, { ratio?: string; thickness?: number }>();
  for (const [layer, list] of sourceByLayer) {
    if (list.ratios.length !== 1 && list.thicknesses.length !== 1) continue;
    specTargets.set(layer, { ratio: list.ratios.length === 1 ? list.ratios[0] : undefined, thickness: list.thicknesses.length === 1 ? list.thicknesses[0] : undefined });
  }
  const scopeWinner = (kind: NumericScopeConflict['kind']) => scopeConflicts?.find(conflict => conflict.kind === kind && conflict.resolution && conflict.confidence !== 'low')?.resolution;
  const numericEntryFromResolution = (resolution: string) => {
    const match = /(\d+(?:\.\d+)?)\s*(㎡|m²|m2|平方米|万元|亿元)/u.exec(resolution);
    return match ? { value: match[1], unit: match[2] } : undefined;
  };
  const areaResolution = scopeWinner('area');
  // 与检测侧同源校验：期望口径事实须可解析出建筑总量数值（截断占地事实跳过），保证“检测定位=修复定位”
  const scaleFactCandidates = factsModel.project.map(normalizedFactValue).filter(value => /建设规模|建筑面积/u.test(value));
  const scaleResolutions = await Promise.all(scaleFactCandidates.map(value => resolveScaleExpectation(value, scaleGapGate)));
  const expectedScale = areaResolution ?? scaleFactCandidates.find((_, index) => scaleResolutions[index] !== undefined);
  const costResolution = scopeWinner('cost');
  const expectedCost = costResolution ?? factsModel.project.map(normalizedFactValue).find(value => /合同估算|投资估算|最高投标限价|招标控制价|总投资|工程造价/u.test(value));
  return {
    specTargets,
    scaleTarget: expectedScale ? (areaResolution ? numericEntryFromResolution(areaResolution) : await resolveScaleExpectation(expectedScale, scaleGapGate)) : undefined,
    costTarget: expectedCost ? (costResolution ? numericEntryFromResolution(costResolution) : (await scopedNumericEntries(expectedCost, COST_SCOPE_RE, COST_UNIT_RE, COST_GAP_WORDS_RE, undefined, costGapGate)).entries[0]) : undefined,
    scaleGapGate,
    costGapGate,
    actionGate,
  };
}

/** 单章定点修复：span 基于原始 text 收集，替换从后往前执行避免偏移 */
async function fixChapterDeterministic(text: string, targets: Awaited<ReturnType<typeof deterministicFixTargets>>): Promise<{ content: string; fixedCount: number; details: string[] }> {
  const replacements: Array<{ start: number; end: number; replacement: string; detail: string }> = [];
  for (const claim of await collectLayerNumbers(text, targets.actionGate)) {
    const target = targets.specTargets.get(claim.layer);
    if (!target) continue;
    // 4.55.26 统一闸门：层名多为通用部位词（垫层/防水层/结合层…）→ 不作权威（保留检测）
    const layerVerdict = authorityRewriteVerdict({
      authorityOwner: claim.layer,
      bodyLocation: claim.layer,
      bodyWindow: text.slice(Math.max(0, claim.span[0] - 24), claim.span[1] + 16),
      found: claim.raw,
      authority: target.thickness !== undefined ? String(target.thickness) : (target.ratio || ''),
    });
    if (!layerVerdict.allowed) continue;
    if (claim.kind === 'ratio' && target.ratio) {
      const ratio = claim.raw.match(/(\d+:\d+(?:\.\d+)?)/u)?.[1];
      if (ratio && ratio !== target.ratio) replacements.push({ start: claim.span[0], end: claim.span[1], replacement: claim.raw.replace(/(\d+:\d+(?:\.\d+)?)/u, target.ratio), detail: `${claim.layer}配比 ${ratio}→${target.ratio}` });
    }
    if (claim.kind === 'thickness' && Number.isFinite(target.thickness)) {
      const thickness = Number(claim.raw.match(/(\d+(?:\.\d+)?)/u)?.[1]);
      // 4.55.24 量级守卫：仅同量级（比值 ≤5）的差异属"同一量口径不统一"，才做定点替换。
      // 跨量级差异说明两者**不是同一个对象的口径**（实测：正文防水层 250mm/30mm/100mm 被
      // 「资料里防水层唯一厚度 3mm」改写成 3mm，最大 83 倍——机器改写在此必错），
      // 交检测器（processSpecConflictIssues 同层判据）报出后由 LLM/人工裁决。
      const magnitudeRatio = thickness > 0 && Number.isFinite(thickness) ? Math.max(thickness, target.thickness as number) / Math.min(thickness, target.thickness as number) : Number.POSITIVE_INFINITY;
      if (Number.isFinite(thickness) && thickness !== (target.thickness as number) && magnitudeRatio <= SPEC_THICKNESS_REPLACE_MAX_RATIO) replacements.push({ start: claim.span[0], end: claim.span[1], replacement: claim.raw.replace(/(\d+(?:\.\d+)?)/u, String(target.thickness)), detail: `${claim.layer}厚度 ${thickness}mm→${target.thickness}mm` });
    }
  }
  // 建设规模/估算价：与检测同源模式带 span 重新匹配，败选数值替换为期望口径（单位保留原样）。
  // 同源口径词防护（q1a）：口径词与数值之间（gap）或紧前上下文（prefix）混入子项/专项口径词时
  // 跳过替换——确定性只碰同词形紧邻数值，跨口径形态交 LLM 规模口径复核（防错改优先于盲修复）；
  // 语义扩围与 scopedNumericEntries 同口径（gapGate 语义属子项/费用词 → 同样跳过）；
  // 长窗实体门（C8 S2②）：口径词前 48 字符内出现子项实体词同样跳过，与检测侧 entityAttributionHit 单源同门
  const collectScopeSpans = async (target: { value: string; unit: string } | undefined, scopeRe: RegExp, unitRe: RegExp, kindLabel: string, gapWords?: RegExp, prefixWords?: RegExp, gapGate?: (texts: string[]) => Promise<boolean[]>, entityWords?: RegExp) => {
    if (!target) return;
    const pattern = new RegExp(`(?:${scopeRe.source})(?:[^\\n。；;，,]{0,14}?)(\\d{2,}(?:[.,]\\d+)?\\s*万?)\\s*(${unitRe.source})`, 'giu');
    const matches = [...text.matchAll(pattern)];
    const uncertain = gapGate
      ? matches
        .filter(match => {
          const gap = match[0].slice(0, match[0].indexOf(match[1]));
          const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
          return !((gapWords && gapWords.test(gap)) || (prefixWords && prefixWords.test(prefix)) || (entityWords && entityAttributionHit(text, match.index ?? 0)));
        })
        .map(match => {
          const gap = match[0].slice(0, match[0].indexOf(match[1]));
          const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
          return { index: match.index ?? 0, context: `${prefix}${gap}`.replace(/\s+/gu, '').slice(-24) };
        })
      : [];
    const uncertainFlags = uncertain.length > 0 ? await gapGate!(uncertain.map(item => item.context)) : [];
    const semanticSkip = new Set(uncertain.filter((_, index) => uncertainFlags[index]).map(item => item.index));
    for (const match of matches) {
      const gap = match[0].slice(0, match[0].indexOf(match[1]));
      const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
      if ((gapWords && gapWords.test(gap)) || (prefixWords && prefixWords.test(prefix)) || (entityWords && entityAttributionHit(text, match.index ?? 0)) || semanticSkip.has(match.index ?? 0)) continue;
      const entry = { value: match[1].replace(/[,，]/gu, '').replace(/\s+/gu, ''), unit: match[2] };
      if (scaledNumericValue(entry) === scaledNumericValue(target)) continue;
      const start = (match.index ?? 0) + match[0].indexOf(match[1]);
      const end = start + match[1].length;
      if (replacements.some(item => item.start < end && item.end > start)) continue;
      replacements.push({ start, end, replacement: target.value, detail: `${kindLabel} ${entry.value}${entry.unit}→${target.value}${entry.unit}` });
    }
  };
  await collectScopeSpans(targets.scaleTarget, SCALE_SCOPE_RE, SCALE_UNIT_RE, '建设规模', SCALE_GAP_WORDS_RE, SCALE_PREFIX_WORDS_RE, targets.scaleGapGate, SCALE_ENTITY_WORDS_RE);
  await collectScopeSpans(targets.costTarget, COST_SCOPE_RE, COST_UNIT_RE, '估算价', COST_GAP_WORDS_RE, undefined, targets.costGapGate);
  if (replacements.length === 0) return { content: text, fixedCount: 0, details: [] };
  replacements.sort((a, b) => b.start - a.start);
  let content = text;
  for (const item of replacements) content = content.slice(0, item.start) + item.replacement + content.slice(item.end);
  return { content, fixedCount: replacements.length, details: replacements.map(item => item.detail) };
}

/** 确定性定点修复兜底：LLM 定向修复未消除的数值口径冲突，按检测同源归属规则直接替换为资料口径（原地修改 chapters 内容） */
export async function applyDeterministicConsistencyFixes(chapters: Array<Pick<DocumentDraftChapter, 'id' | 'title' | 'content'>>, factsModel: DocumentFactsModel, scopeConflicts?: NumericScopeConflict[], embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<{ fixedCount: number; details: string[] }> {
  const targets = await deterministicFixTargets(factsModel, scopeConflicts, embedDocuments);
  if (targets.specTargets.size === 0 && !targets.scaleTarget && !targets.costTarget) return { fixedCount: 0, details: [] };
  let fixedCount = 0;
  const details: string[] = [];
  for (const chapter of chapters) {
    const fix = await fixChapterDeterministic(chapter.content, targets);
    if (fix.fixedCount > 0) {
      chapter.content = fix.content;
      fixedCount += fix.fixedCount;
      details.push(...fix.details);
    }
  }
  return { fixedCount, details };
}

/** 全文级确定性定点修复：覆盖章节正文之外的合成区（封面信息块/基本信息表/附录）中的败选数值。
 * 章节级修复只改章节正文，合成区由 facts 生成，败选值残留时修复器在章节正文找不到目标、fixedCount=0，
 * 检测重跑仍报错，导出门禁永久阻断（历史缺陷：用户环境建设规模败选值 10970㎡ 进入封面合成区形成死循环） */
export async function applyDeterministicConsistencyFixesToMarkdown(markdown: string, factsModel: DocumentFactsModel, scopeConflicts?: NumericScopeConflict[], embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<{ markdown: string; fixedCount: number; details: string[] }> {
  const targets = await deterministicFixTargets(factsModel, scopeConflicts, embedDocuments);
  if (targets.specTargets.size === 0 && !targets.scaleTarget && !targets.costTarget) return { markdown, fixedCount: 0, details: [] };
  const fix = await fixChapterDeterministic(markdown, targets);
  return { markdown: fix.content, fixedCount: fix.fixedCount, details: fix.details };
}

/** 全文级闭环句式密度检测：与可落地性评分同口径（每 1500 字至少 1 段三要素齐全的闭环句式），
 * 密度不足时给 warning 指导修订（不阻断门禁，与评分口径同源避免双重标准） */
export async function closedLoopDensityIssues(markdown: string): Promise<ValidationIssue[]> {
  const { closedLoopBlocks } = await fiveElementBlockStats(markdown);
  const target = Math.max(6, Math.ceil(documentTextLength(markdown) / 1500));
  if (closedLoopBlocks >= target) return [];
  return [{ level: 'warning', message: `可落地性闭环句式密度不足：全文 ${closedLoopBlocks} 段完整闭环句式，未达每 1500 字 1 段（目标 ${target} 段）`, suggestion: '在措施类段落中补齐“责任岗位 + 检查频次 + 整改闭环”三要素齐全的闭环表述：同一自然段内同时出现岗位（如项目经理/质检员/安全员）、频次（每日/每周/不少于X次）与闭环（整改/复查/销项）；三要素分散融入叙述，不得以固定句模复读。' }];
}

export function managementMeasureNumberIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const managementNumberPattern = /(?:三检制|三级教育|三级管理|5S|24\s*小时|每日|每周|每月|一次|两次)/gu;
  for (const chapter of chapters) {
    const matches = [...new Set(chapter.content.match(managementNumberPattern) || [])];
    if (matches.length < 3) continue;
    const analysis = analyses?.get(chapter.title);
    // 调用方未提供语义分析时跳过（生成中间阶段无章节内容可分析；最终校验恒提供）：
    // 执行闭环必须由 bge 嵌入判定，关键词闭环正则必然误伤（闭环词命中的模板段漏检、变体闭环表述误报）
    if (!analysis) continue;
    if (!analysis.closedLoop) {
      issues.push({ level: 'warning', message: `${chapter.title} 管理措施数字较多但缺少执行闭环：${matches.slice(0, 8).join('、')}`, suggestion: '这些管理数字可以保留，但需要补充责任主体、检查频次、记录台账、整改复查和闭环要求。' });
    }
  }
  return issues;
}

export function genericProfessionalContentIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'> & Partial<Pick<DocumentDraftChapter, 'id'>>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const generic = /(?:加强组织领导|严格执行规范|落实责任制度|确保工程质量|强化过程管理|提高思想认识|完善管理体系|形成闭环管理)/gu;
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const matches = chapter.content.match(generic) || [];
    if (matches.length < 6) continue;
    const analysis = analyses?.get(chapter.title);
    // 调用方未提供语义分析时跳过（生成中间阶段无章节内容可分析；最终校验恒提供）：
    // 是否绑定项目事实必须由 bge 嵌入判定，具体词正则必然误伤（“材料”等词零命中但实质具体的章节被误判泛化）
    if (!analysis) continue;
    if (!analysis.concrete) issues.push({ level: 'error', message: `${chapter.title} 存在较多未绑定项目事实和工序控制点的泛化套话`, suggestion: '请替换为结合资料事实、施工对象、工序控制、验收资料和整改闭环的专业内容。', chapterId: chapter.id });
  }
  return issues;
}

function trustedFactCorpus(factsModel: DocumentFactsModel) {
  const facts = [
    ...factsModel.project,
    ...factsModel.schedule,
    ...factsModel.quality,
    ...factsModel.safety,
    ...factsModel.resources,
    ...factsModel.preciseFacts,
    ...factsModel.bills,
    ...factsModel.drawings,
    ...factsModel.rules,
    ...factsModel.specifications,
  ].map(normalizedFactValue).join('\n');
  // P6 语料扩容（V5 数据主权根治）：结构化表格（工程量清单/机械配置表/进度表等 tables）的全部
  // 单元格此前不在反查语料内，正文忠实引用清单明细（分村土方/分部位回填量等）被判「资料事实
  // 主表中未找到」误伤。表头与全部数据行并入语料，与事实主表同等受信。
  const tableCells = factsModel.tables.flatMap(table => [...table.headers, ...table.rows.flat()]);
  return [facts, ...tableCells].join('\n');
}

/** 工期总量口径升级锚（4.44 #43 根因根治）：就近前缀工期词 + 排布分解排除门。
 * 4.43 实测：「本项目计划工期为90日历天…施工准备与清杂拆除7天，污水管网工程63天，道路铺装工程10天…」
 * 阶段排布值「7天」被 ±36 字全窗口的「日历天」误升级为总量口径编造（error 阻断且修复轮无收敛路径）；
 * 判定改为：① 工期口径词必须出现在 token 就近前缀（16 字）内（拒绝远距离词锚）；
 * ② 上下文含阶段分解/流程节点特征词不升；③ 上下文并列 ≥2 个「数字+（日历）天」即排布分解不升。 */
function hasDurationScopeAnchor(prefix: string, context: string): boolean {
  if (!/总工期|计划工期|合同工期|日历天|施工周期/u.test(prefix)) return false;
  if (/阶段|历时|用时|合计|总计|共计|累计|预留|机动|余量|剩余|养护|编制|提交|签订|划分|闭合|控制基准|持续时间|关键|节点/u.test(`${prefix}${context}`)) return false;
  // 并列分解：上下文出现 ≥2 个「数字+天」→ 排布分解值（token 自身计 1 个）。「日历天」不计入——
  // 它是总量权威口径的典型单位形态（「总工期180日历天」），不是排布分解证据；若计入，
  // K1 对照「总工期180日历天，围墙修复29天」会因 180 日历天凑成 2 而漏报 29 天（升级门失效）
  return (context.match(/\d+(?:\.\d+)?\s*(?:工作天|天)/gu) || []).length < 2;
}

/** 日历日期 token（「12月」←「9月下旬至12月下旬」）：日期表述不是总量口径编造对象（编造日期由 Writer
 * 规则与跨章检查处理）。r17 丰乐镇实测：同步正则豁免后 bge 语义分类器仍会把工期语境中的日期 token
 * 升级为总量口径（「12月」被报编造）——同步降级与语义升级门必须共用同一判据封印升级路径。 */
function isCalendarDateToken(token: string, context: string): boolean {
  return /^\d+(?:\.\d+)?(?:月|年)$/u.test(token) && /开工|竣工|日期|计划|年|月/u.test(context);
}

function generatedFactTokenClass(token: string, context: string, prefix?: string): 'scope' | 'spec' | 'soft' {
  const normalized = `${token} ${context}`;
  // 单位门控（十一度实测误伤）：token 自身单位决定口径类别，上下文关键词不得跨口径升级——
  // “4次”是专项应急演练频次计数，不能因 ±36 字上下文出现“日历天”而被判为工期总量口径编造
  if (/(?:工日|人日|次|台|套|个|人|层|间|批|项|处|座|栋|根|只|组|件|块|片|面|条|道|樘|扇|盏|节|段)$/u.test(token)) return 'soft';
  if (/三检制|三级|5S|24\s*小时|每日|每周|每月|一次|两次|责任制|制度/u.test(normalized)) return 'soft';
  // 商务金额类（暂列金额/暂估价/报价/单价/税率）：招标人给定或商务条款数字，事实提取侧本就不纳入主表，
  // 反查侧不得据此判为“编造总量口径”硬阻断——正文忠实引用暂列金额（如“暂列金额60万元”）是合规写法
  if (/暂列金额|暂估价|报价|单价|合价|综合单价|税率|增值税|预留金/u.test(normalized)) return 'soft';
  // 具体日期 token（“2026年8月8日”中的“2026年”“8月”）属于日期表述，不是总量口径数字；
  // 编造日期由 Writer 规则约束与跨章检查处理，此处降级 soft 避免把日期误判为工期口径阻断导出
  if (isCalendarDateToken(token, context)) return 'soft';
  // 项目总量口径（工期/金额/建设规模）：正文偏离资料口径属低级错误，升级为 error 走修复链。
  // token 必须携带对应口径单位才能升级，防止上下文关键词跨口径误伤（见上方单位门控说明）。
  // 上下文关键词只在 token 前导近邻窗口（prefix）内匹配：±36 字全窗口会把
  // “养护期30天，满足总工期要求”误判为工期总量口径编造（error 硬阻断误伤）；
  // 远距离口径由异步语义链路补升级（generatedFactVerificationIssuesAsync 的 bge 语义分类器），漏检由语义补足。
  const scopeContext = prefix ?? context;
  // P6 语料校准（run1 实测）：进度排布类汇总表述（「各阶段…合计344天，预留16天机动工期」）
  // 此前被「总工期/日历天」近邻窗口误升级为工期总量口径编造。合计/预留/机动/余量语境属
  // 排布分解数字（各阶段用时+机动工期推导），不是资料口径事实，不进总量口径反查池。
  // 4.32.0 扩围（丰乐镇复测 #99 五个时间数字全拦截）：excl 词表并入阶段分解/流程节点类
  // 特征词（阶段/历时/用时/养护/编制/提交/签订/划分/闭合/控制基准/持续时间/关键/节点），
  // 检查窗口由近邻 prefix 扩至 `${scopeContext}${context}`（覆盖 token 后置语境）
  if (/(?:天|工作天|月|年)$/u.test(token) && hasDurationScopeAnchor(scopeContext, context)) return 'scope';
  // 金额类不能裸匹配单字“元”：正文常见“结构单元/元件/元素/元器件”等词含“元”字，
  // 会把方法段工艺参数（如“拆除段单元划分”语境下的 200m2）误判为金额口径编造（十度实测误伤）
  if (/(?:万元|亿元|元)$/u.test(token) && /最高投标限价|招标控制价|合同估算价|投资估算|报价|金额|人民币/u.test(scopeContext)) return 'scope';
  if (/(?:m2|hm2|亩|㎡|m²|平方米)$/u.test(token) && /建设规模|总建筑面积|总用地面积|总占地面积/u.test(scopeContext)) return 'scope';
  // 工程量/材料/设备规格明细：与资料口径不符时提示复核（规格细节较多，warning 级避免误伤）
  if (/(?:工程量|清单|建设规模|建筑面积|长度|材料|设备|规格|型号).{0,24}(?:m²|㎡|m3|m³|米|吨|套|台|个|项|%)/u.test(normalized)) return 'spec';
  // 国家标准/行业标准/地方标准编号是通用引用，不是项目特有事实，降级为 soft
  if (/GB\s*\d|JGJ\s*\d|CJJ\s*\d|ISO\s*\d|GB\/T|CECS\s*\d|DL\s*\d|YB\s*\d|SH\s*\d|SJ\/T\s*\d|CJJ\/T\s*\d|DB\s*\d/u.test(normalized)) return 'soft';
  if (/标准|规范|编号/u.test(normalized)) return 'spec';
  return 'soft';
}

interface FactVerificationCandidate {
  token: string;
  normalizedToken: string;
  context: string;
  /** token 前导近邻窗口（16 字）：scope 升级的关键词封闭匹配限定在近邻，杜绝远距离上下文误升级 */
  prefix: string;
}

/** 归一化单位 → 原文可能形态（mirror engineeringUnits 归一化替换表；长单位在后防截尾、多字面形态并列） */
const MEASURE_UNIT_VARIANTS: Array<[string, string]> = [
  ['hm2', 'hm2|hm²|公顷'],
  ['m2', 'm2|m²|㎡|平方米|平方|平米'],
  ['m3', 'm3|m³|立方米|立方'],
  ['工作天', '工作天|工作日'],
  ['万元', '万元|人民币万元|万元人民币'],
  ['天', '天|日历天|自然日|个日历天'],
  ['月', '月|个月'],
  ['km', 'km|千米|公里'],
  ['mm', 'mm|毫米'],
  ['cm', 'cm|厘米'],
  ['kg', 'kg|千克|公斤'],
  ['min', 'min|分钟'],
  ['t', 't|吨'],
  ['m', 'm|米'],
  ['元', '元|人民币元|元人民币'],
  ['h', 'h|小时'],
];

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** 归一化 token 在原文中的定位（fix03e）：归一化 token 与原文形态常不一致（「2月」←「连续2个月」、
 * 「30天」←「30日历天」、㎡→m2），裸 indexOf 会错位命中子串（「2月」命中「12月下旬」的「12月」——
 * context/口径分类随之失真，工期段落被误升级为总量口径编造 blocker）。定位策略：① 数字左边界守卫的
 * 精确搜索（防数字子串错位：2 不得命中 12）；② 单位变体还原搜索（补归一化丢失的插入字/符号形态）；
 * 均未命中即跳过（返回 -1），绝不用裸数字回退（裸「2」会命中「2026年」）。 */
function locateMeasureToken(markdown: string, token: string): number {
  const numeric = /^(\d+(?:\.\d+)?)/u.exec(token)?.[1];
  if (!numeric) return markdown.indexOf(token);
  const guarded = new RegExp(`(?<![\\d.])${escapeRegExpLiteral(token)}(?![\\d.])`, 'u').exec(markdown);
  if (guarded) return guarded.index;
  const unit = token.slice(numeric.length);
  if (!unit) return -1;
  const variant = MEASURE_UNIT_VARIANTS.find(([normalized]) => normalized === unit);
  const unitPattern = variant ? variant[1] : escapeRegExpLiteral(unit);
  const match = new RegExp(`(?<![\\d.])${escapeRegExpLiteral(numeric)}\\s*(?:${unitPattern})(?![a-z0-9])`, 'iu').exec(markdown);
  return match ? match.index : -1;
}

/** 收集待反查的工程度量 token（表格行排除、章节编号排除、上下文切片），与口径分类解耦 */
function collectFactVerificationCandidates(markdown: string): FactVerificationCandidate[] {
  const candidates: FactVerificationCandidate[] = [];
  for (const token of extractEngineeringMeasureTokens(markdown)) {
    // 章节编号（1.2、2.3 等无单位纯小数）是目录/标题编号，不是工程数字，不进反查池
    if (/^\d+\.\d+$/u.test(token)) continue;
    const normalizedToken = normalizeEngineeringTextForFactMatch(token);
    const tokenIndex = locateMeasureToken(markdown, token);
    if (tokenIndex < 0) continue;
    // 表格行中的数值（进度计划表分项持续时间"第24～34天"、机械配置表"第X天"等）
    // 属于计划排期分解数据，不属于总量口径，不做资料事实反查
    const lineStart = markdown.lastIndexOf('\n', tokenIndex - 1) + 1;
    const lineEnd = markdown.indexOf('\n', tokenIndex);
    const tokenLine = markdown.slice(lineStart, lineEnd < 0 ? markdown.length : lineEnd);
    if (/^\s*\|/u.test(tokenLine.trim())) continue;
    const context = markdown.slice(Math.max(0, tokenIndex - 36), Math.min(markdown.length, tokenIndex + token.length + 36));
    // B7 合同条款引用豁免（丰乐镇第七轮实测）：违约金阶梯（「延期超过28天…超过56天解除合同」）、
    // 缺陷责任期（「缺陷责任期24个月」）等合同条款引用数字是招标/合同原文的忠实落位，
    // 不属编造数字，不进资料事实反查池（提取侧合同条款本就未入事实主表，反查必失败）
    if (/违约金|延期竣工|解除合同|缺陷责任期|质量保证金|质保金|履约保证金|保修期/u.test(context)) continue;
    // token 前导近邻窗口（16 字）：scope 升级的关键词封闭匹配限定在近邻，杜绝远距离上下文误升级（round-14 零误伤）
    const prefix = markdown.slice(Math.max(0, tokenIndex - 16), tokenIndex);
    // 阶段分解豁免（舒城第二轮实测）：总工期倒推的阶段划分（「施工准备与三通一平阶段29天」
    // 「各阶段累计345天」「竣工验收缓冲15天」）是投标编制的进度排布，不属资料口径事实，
    // 不进总量口径反查池——否则「总工期/日历天」近邻窗口命中导致整批阶段天数被误判为编造总量口径
    if (/(?:阶段|缓冲|累计)\s*\d*$/u.test(prefix)) continue;
    candidates.push({ token, normalizedToken, context, prefix });
  }
  return candidates;
}

/** 由三类可疑桶生成反查 issues（同步/异步分类链路共用，保证消息与阈值一致） */
function buildFactVerificationIssuesFromBuckets(input: {
  markdown: string;
  factsModel: DocumentFactsModel;
  scopeSuspicious: string[];
  specSuspicious: string[];
  softSuspicious: string[];
}): ValidationIssue[] {
  const { markdown, factsModel, scopeSuspicious, specSuspicious, softSuspicious } = input;
  const issues: ValidationIssue[] = [];
  const uniqueScopeSuspicious = [...new Set(scopeSuspicious)];
  const uniqueSpecSuspicious = [...new Set(specSuspicious)];
  const uniqueSoftSuspicious = [...new Set(softSuspicious)];
  // 总量口径类硬数字反查失败：error 级进入修复链（消息前缀匹配 REPAIRABLE_QUALITY_ISSUE_RE 的“生成后事实反查失败”）
  if (uniqueScopeSuspicious.length >= 1) issues.push({ level: 'error', message: `生成后事实反查失败：正文出现资料事实主表中未找到的总量口径数字 ${uniqueScopeSuspicious.slice(0, 8).join('、')}`, suggestion: '总量口径数字（工期/金额/建设规模）必须与资料一致；请删除或改写为资料确认的口径，禁止编造。' });
  if (uniqueSpecSuspicious.length >= 2) issues.push({ level: 'warning', message: `生成后事实反查提示：正文出现资料事实主表中未找到的规格明细数字 ${uniqueSpecSuspicious.slice(0, 8).join('、')}`, suggestion: '建议复核这些规格是否来自管理制度、规范要求或资料事实；如无依据，改为定性管理要求。' });
  if (uniqueSoftSuspicious.length >= 6) issues.push({ level: 'warning', message: `生成后事实反查提示：正文出现较多未在资料事实主表中反查到的管理数字 ${uniqueSoftSuspicious.slice(0, 10).join('、')}`, suggestion: '请确认这些管理数字属于通用制度、规范要求或项目资料事实；如无依据，建议改为定性管理要求。' });
  if (/质量目标|质量标准/u.test(markdown) && factsModel.quality.length > 0 && !factsModel.quality.some(fact => markdown.includes(stringifyFactValue(fact.value).slice(0, 18)))) issues.push({ level: 'warning', message: '生成后事实反查提示：正文质量目标表述未明显匹配质量事实主表', suggestion: '请使用资料中的质量目标原文或等价表述。' });
  return issues;
}

/** 模糊口径单位后缀：可被总量口径或明细口径解释的单位，其口径归属需语义分类复核 */
const AMBIGUOUS_SCOPE_UNIT_RE = /(?:天|工作天|日历天|月|年|万元|亿元|元|m2|hm2|亩|㎡|m²|平方米)$/u;

/** 同步反查校验（L2 正则门控分类口径：交付评分快评与中间校验使用；语义口径分类走 generatedFactVerificationIssuesAsync） */
export function generatedFactVerificationIssues(markdown: string, factsModel: DocumentFactsModel): ValidationIssue[] {
  const corpus = trustedFactCorpus(factsModel);
  if (documentTextLength(corpus) < 80) return [];
  const compactCorpus = normalizeEngineeringTextForFactMatch(corpus);
  const scopeSuspicious: string[] = [];
  const specSuspicious: string[] = [];
  const softSuspicious: string[] = [];
  for (const candidate of collectFactVerificationCandidates(markdown)) {
    const { token, normalizedToken, context, prefix } = candidate;
    // C-T2 三分类豁免（实测归因）：规范常数（标准编号/养护龄期/试块留置/检测频次/温度阈值/
    // 质量指标/工艺公差）与管理数字（管理频次/组织编排/配置/合同条款/过程指标/日期表述/
    // 商务金额）为合法数字，不进资料事实反查——否则合法数字误报将淹没真未溯源
    if (classifyNumericTraceToken({ token, context }).kind !== 'unsourced') continue;
    const tokenClass = generatedFactTokenClass(token, context, prefix);
    if (tokenClass === 'scope' && !compactCorpus.includes(normalizedToken)) scopeSuspicious.push(token);
    if (tokenClass === 'spec' && !compactCorpus.includes(normalizedToken)) specSuspicious.push(token);
    if (tokenClass === 'soft' && !compactCorpus.includes(normalizedToken)) softSuspicious.push(token);
  }
  return buildFactVerificationIssuesFromBuckets({ markdown, factsModel, scopeSuspicious, specSuspicious, softSuspicious });
}

/**
 * 反查校验（语义口径分类链路，round-13）：模糊单位 token 的 scope 升级/降级由总量口径语义分类器复核——
 * 正则升级 scope 需语义确认（根治跨口径误伤），正则漏判时语义可升级（补足变体表述漏检）。
 * 本地语义模型恒可用，scopeClassifier 由生成前预构建后必传。
 */
export async function generatedFactVerificationIssuesAsync(
  markdown: string,
  factsModel: DocumentFactsModel,
  options: { scopeClassifier: FactTokenScopeClassifier },
): Promise<ValidationIssue[]> {
  const corpus = trustedFactCorpus(factsModel);
  if (documentTextLength(corpus) < 80) return [];
  const compactCorpus = normalizeEngineeringTextForFactMatch(corpus);
  const candidates = collectFactVerificationCandidates(markdown);
  // 批量语义预分类：一次批量嵌入所有模糊单位候选查询，避免逐条 pipeline 调用开销
  let semanticMap: Map<string, 'scope' | 'other'> | undefined;
  const ambiguousCandidates = candidates.filter(candidate => AMBIGUOUS_SCOPE_UNIT_RE.test(candidate.token));
  if (ambiguousCandidates.length > 0) {
    const results = await options.scopeClassifier.batchClassify(ambiguousCandidates.map(candidate => `${candidate.token} ${candidate.context}`.slice(0, 160)));
    semanticMap = new Map();
    ambiguousCandidates.forEach((candidate, index) => semanticMap!.set(candidate.token, results[index] || 'other'));
  }
  const scopeSuspicious: string[] = [];
  const specSuspicious: string[] = [];
  const softSuspicious: string[] = [];
  for (const candidate of candidates) {
    const { token, normalizedToken, context, prefix } = candidate;
    // C-T2 三分类豁免：与同步链路同源（规范常数/管理数字为合法数字，不进语义升级与三桶判定）
    if (classifyNumericTraceToken({ token, context }).kind !== 'unsourced') continue;
    let tokenClass = generatedFactTokenClass(token, context, prefix);
    if (semanticMap && AMBIGUOUS_SCOPE_UNIT_RE.test(token)) {
      const semantic = semanticMap.get(token) || 'other';
      if (tokenClass === 'scope') tokenClass = semantic === 'scope' ? 'scope' : 'soft';
      // 语义升级门（丰乐镇复测 #99 + 4.44 #43 就近词锚）：语义分类器泛化会把工期排布/流程节点
      // 数字升级为总量口径编造——仅当 token 就近前缀含明确工期口径关键词且无阶段分解/并列
      // 排布特征时才允许正则→scope 的语义升级（宁缺勿假：无关键词的漏判由 soft 计数提示兑底）；
      // 日历日期 token 不得升级（r17 丰乐镇归因：bge 会把「12月」按工期语境升级为编造总量口径，
      // 同步降级判据在此必须同样生效）
      else if (semantic === 'scope' && hasDurationScopeAnchor(prefix ?? context, context) && !isCalendarDateToken(token, context)) tokenClass = 'scope';
    }
    if (tokenClass === 'scope' && !compactCorpus.includes(normalizedToken)) scopeSuspicious.push(token);
    if (tokenClass === 'spec' && !compactCorpus.includes(normalizedToken)) specSuspicious.push(token);
    if (tokenClass === 'soft' && !compactCorpus.includes(normalizedToken)) softSuspicious.push(token);
  }
  return buildFactVerificationIssuesFromBuckets({ markdown, factsModel, scopeSuspicious, specSuspicious, softSuspicious });
}

/**
 * D-T1 专业评分补写线（12 分制）：低于该线的章节强制进入内容深度补写链（content-depth-repair
 * 按 provenance 消费、补写预算单列）；终稿验收目标——无章节低于该线（机械设备/劳动力两章 ≥10/12
 * 为评分机制附加口径）。4.31 保留 warning 级（六维语义评分不作 blocker 阻断交付），但报出线由
 * 原类型线（4~6）统一提升至该线：7/12 的章此前不报出、无任何补写消费压力，是 r28f
 * 「机械设备计划 2/12、劳动力安排计划 4/12」终稿残留的根因。
 */
export const PROFESSIONAL_SCORE_LINE = 8;

/** D-T1 章级补写靶线：资源类章（机械设备/劳动力计划）对齐验收判据 ≥10/12（r28f 实机 2/12、
 * 4/12 根治标靶），其余章统一 PROFESSIONAL_SCORE_LINE；检测报出与修复复检同源消费 */
export function professionalScoreTargetLine(title: string): number {
  if (/资源|材料|设备|劳动力/u.test(title)) return 10;
  return PROFESSIONAL_SCORE_LINE;
}

/** 六维评分序（professionalScoreIssues 与 content-depth-repair 复检端单源共用口径） */
export const DEPTH_DIMENSION_ORDER: readonly DepthDimension[] = ['factuality', 'structure', 'depth', 'executable', 'specificity', 'consistency'];

/** 六维评分单源（覆盖维度数 ×2 = 12 分制总分；检测报出/修复复检共用，禁止第二份打分口径） */
export function professionalDepthTotal(dimensions: Record<DepthDimension, boolean>): number {
  return DEPTH_DIMENSION_ORDER.filter(dimension => dimensions[dimension]).length * 2;
}

/** 薄弱维度单源（未覆盖维度按序提取；空数组表示六维全覆盖） */
export function professionalWeakDimensions(dimensions: Record<DepthDimension, boolean>): DepthDimension[] {
  return DEPTH_DIMENSION_ORDER.filter(dimension => !dimensions[dimension]);
}

/** 任务卡焦点表（按章类型给出补写方向；低于补写线的章随 issue suggestion 注入修复指令） */
function professionalScoreFocus(title: string) {
  if (/概况|工程|项目/u.test(title)) return '事实依据、项目特异性';
  if (/部署|总体|组织/u.test(title)) return '组织结构、可执行闭环、跨章一致性';
  if (/进度|工期/u.test(title)) return '进度结构、工期一致性、纠偏机制';
  if (/质量/u.test(title)) return '质量深度、验收复验、资料闭环';
  if (/安全|文明|危大|风险/u.test(title)) return '风险覆盖、应急响应、检查整改';
  if (/资源|材料|设备|劳动力/u.test(title)) return '资源依据、进场调配、进度支撑';
  return '事实依据、专业深度、可执行性';
}

export function professionalScoreIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'> & Partial<Pick<DocumentDraftChapter, 'id'>>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    const text = chapter.content;
    if (documentTextLength(text) < 800) continue;
    const focus = professionalScoreFocus(chapter.title);
    const analysis = analyses?.get(chapter.title);
    // 调用方未提供语义分析时跳过（生成中间阶段无章节内容可分析；最终校验恒提供）：
    // 六维覆盖必须由 bge 嵌入判定，关键词正则模拟语义打分必然误伤（变体表述零命中/仅罗列关键词的模板段拿满分）
    if (!analysis) continue;
    const total = professionalDepthTotal(analysis.dimensions);
    if (total < professionalScoreTargetLine(chapter.title)) {
      const weak = professionalWeakDimensions(analysis.dimensions).join('、') || focus;
      // 4.31 保留 warning 级（丰乐镇 v6 #74/#75：六维语义评分不作为 blocker 阻断交付）+ D-T1 升级消费：
      // <8/12 的章由 content-depth-repair 强制消费定向补写；provenance 是该轮的定位锚点（检测定位=修复定位）
      issues.push({ level: 'warning', message: `${chapter.title} 专业评分不足：${total}/12，薄弱维度：${weak}`, suggestion: `请按章节任务卡补齐${focus}，并写出资料依据、实施流程、专业控制点和检查整改闭环。`, chapterId: chapter.id, provenance: { detectorId: 'professional-score', fingerprint: stableHash(`${chapter.title}\u0000${total}`) } });
    }
  }
  return issues;
}

/** 进度章内容要求字面要素对兜底（4.44 #38 根治）：bge 块语义对表格化/变体表述会漏判到 0.6
 * 阈值以下误伤缺项——4.43「确保工期的技术组织措施」实测要素齐全（「三条关键线路」「滞后纠偏
 * 措施」表列/「工序穿插」「平行施工」「流水节拍」）仍被判缺。语义判定为主，强要素对
 * （关键线路类 AND 纠偏类）字面同时命中即判覆盖兜底；单词命中不兜底（防关键词罗列段）。 */
function contentNeedLiteralFallback(needKey: ContentNeedKey, content: string): boolean {
  if (needKey === 'schedule') return /关键线路|关键路径/u.test(content) && /纠偏|穿插|平行施工|流水施工|赶工/u.test(content);
  // r28f B3 归因（r28e 实测）：「机械进场时间按施工准备阶段第1日至第7日分批组织」「设备调度由
  // 项目部机械员统一负责…按'先满足开挖面、再保障碾压面'的原则调配机具」类资源章要素齐全仍被
  // bge 块语义漏判（表格式配置章同 schedule 兜底场景）——语义为主，强要素对兜底：资源对象
  // （材料/设备/机械/机具/物资/构件/苗木/管材）进场或退场证据 × 现场管理机制（调度/保管/台账/
  // 供应/仓储/保养）字面同现即判覆盖；单侧命中或泛主体「人员进场+单句调配」薄内容不兜底
  //（防关键词罗列段，laborBody 边界锁定）
  if (needKey === 'resource') {
    return /(?:材料|设备|机械|机具|物资|构件|苗木|管材)[^。；;\n|]{0,16}?(?:进场|入场|退场)/u.test(content)
      && /调度|保管|台账|供应|仓储|保养/u.test(content);
  }
  return false;
}

export function professionalContentIssues(chapters: Array<Pick<DocumentDraftChapter, 'title' | 'content'> & Partial<Pick<DocumentDraftChapter, 'id'>>>, analyses?: Map<string, ProfessionalDepthAnalysis>): ValidationIssue[] {
  const rules = [
    { re: /进度|工期/u, needKey: 'schedule' as const, need: /关键线路|穿插|纠偏|资源保障|节点|动态调整/u, message: '进度工期章节缺少关键线路、穿插施工或纠偏保障内容' },
    { re: /质量/u, needKey: 'quality' as const, need: /材料.*验收|复验|隐蔽验收|整改.*复验|质量.*资料|检验批/u, message: '质量章节缺少材料验收复验、隐蔽验收或整改复验闭环' },
    { re: /安全|文明|危大|风险/u, needKey: 'safety' as const, need: /风险|临电|消防|应急|检查.*整改|文明施工|人员|设备/u, message: '安全文明章节缺少风险识别、现场控制或应急检查闭环' },
    { re: /资源|材料|设备|劳动力/u, needKey: 'resource' as const, need: /进场|验收|调配|保管|供应|投入计划/u, message: '资源章节缺少进场、验收、调配或保管计划' },
    { re: /施工|工艺|技术|方案/u, needKey: 'construction' as const, need: /准备|流程|工艺|控制点|验收|交底/u, message: '施工技术章节缺少施工准备、工艺流程、控制点或验收要求' },
  ];
  const issues: ValidationIssue[] = [];
  for (const chapter of chapters) {
    if (documentTextLength(chapter.content) < 600) continue;
    const analysis = analyses?.get(chapter.title);
    // 调用方未提供语义分析时跳过（生成中间阶段无章节内容可分析；最终校验恒提供）：
    // 缺项判定必须由 bge 嵌入完成，关键词 need 正则必然误伤（“关键线路法（CPM）”等变体表述零命中即判缺项）
    if (!analysis) continue;
    for (const rule of rules) {
      if (!rule.re.test(chapter.title)) continue;
      // 4.31 泛类规则优先级豁免（丰乐镇 v6 #73）：「施工|工艺|技术|方案」泛类正则会误命中
      // 质量/安全/进度等专类章节标题（「确保安全生产的技术组织措施」含「技术」），
      // 当其他专类规则也命中同一标题时以专类规则判定为准，跳过 construction 泛类条目
      if (rule.needKey === 'construction' && rules.some(other => other.needKey !== 'construction' && other.re.test(chapter.title))) continue;
      // 4.32 布置类章节豁免（丰乐镇 v6 #58）：「施工总平面布置图」被「施工|工艺|技术|方案」泛类
      // 误命中，但布置类章节职责是场地分区与线路定位，不承担施工准备/工艺流程/控制点/验收标准
      // （construction 语义锚点），泛类规则不适用——布置章不被 construction 规则审理
      if (rule.needKey === 'construction' && /总平面|平面布置|布置图/u.test(chapter.title)) continue;
      // 4.32 劳动力专章证据豁免（丰乐镇 v6 #57）：「劳动力安排计划」被「资源|材料|设备|劳动力」
      // 泛类命中，但该章职责是劳动力组织（不承担材料设备保管），resource 泛类锚点（含材料设备）
      // 不适用；章内存在进场/退场/调配/轮转证据时不按泛类锚点判缺（真无进场计划的章仍保留 error）
      if (rule.needKey === 'resource' && /劳动力/u.test(chapter.title) && !/资源|材料|设备/u.test(chapter.title) && /进场|入场|退场|调配|轮转/u.test(chapter.content)) continue;
      if (!analysis.contentNeeds[rule.needKey] && !contentNeedLiteralFallback(rule.needKey, chapter.content)) issues.push({ level: 'error', message: `${chapter.title}：${rule.message}`, suggestion: '请按专业任务卡定向补写该章节，补齐可实施的控制措施、资料依据和闭环要求。', chapterId: chapter.id });
    }
  }
  return issues;
}

function shouldIgnorePreciseToken(token: string, context: string) {
  if (/万元|元|报价|单价|合价|综合单价|预留金|税率|增值税|利润|结算/u.test(`${token} ${context}`)) return true;
  if (/OCR|识别错误|乱码|无法确认|疑似|不确定|语义断裂|页码|目录/u.test(context)) return true;
  if (/^\d+$/.test(token) && Number(token) < 10) return true;
  // 4.49 r9 #12 根治（关键参数抽查 4/10 缺失如 cm3）：PRECISE_FACT_TOKEN_RE 首分支带 i 标志，
  // [A-Z]{1,8}[\w.-]*\d[\w.-]* 会把「2.6g/cm3」的裸单位碎片 cm3（单位词根+平方/立方后缀，
  // 无数值主体）误提为 token——既非可逐字补齐的工程参数，又因含 m3 子串挤占体积类目关键参数
  // 抽查名额。纯单位片段（单位词根+可选 2/3 平方立方后缀）一律不进抽查池。
  if (/^(?:mm|cm|dm|hm|km|kg|mg|ml|kwh|kj|kpa|mpa|kw|pa|kn|n|t|l|h|g|m|㎡|m²|m³)[23²³]?$/iu.test(token)) return true;
  // 4.31 抽查池噪声过滤（丰乐镇 v6 #83）：「1.1项」为小节编号+量词误切、「184 页」为页码、
  // 「COL/R2C3」为表格坐标，均非工程参数；「N天/日」且语境含期限时属条款期限非施工工期
  if (/^\d+(?:\.\d+)+\s*(?:项|个|份|页|批|次|条|款)$/u.test(token)) return true;
  if (/^\d+\s*页$/u.test(token) || /^(?:COL|R\d+C)\d*$/iu.test(token)) return true;
  if (/^[A-Za-z]\.\d+$/u.test(token)) return true;
  if (/^[\d.]+\s*(?:天|日)$/u.test(token) && /期限/u.test(context)) return true;
  // 合同条款义务类参数（如通用条款“之日起X天内发出开工通知”、“承包人应在X天内提交”）是法律条款表述，
  // 不是项目专属工程参数，不要求写入正文，也不进入抽查池；项目计划工期参数不受影响。
  // 违约金/保证金阶梯数字（“延期28天及以上”“竣工验收通过后28天”）：证据分块常截断“违约金”语境，
  // 必须按“天以上/‰/暂扣/履约保证金”等强信号独立识别，否则条款数字会被误当成工期参数强制写入正文
  if (/之日起.{0,8}天内|天内.{0,10}(?:发出|提交|通知|回复|答复|完成|开工|竣工|报送|支付|更换)|天以上|天及以上|‰|暂扣|履约保证金|通过后.{0,6}天|因发包人原因|因承包人原因|未能按时|逾期|违约金/u.test(context)) return true;
  return false;
}

function collectPreciseFactTokens(factsModel: DocumentFactsModel) {
  const tokens = new Set<string>();
  for (const fact of factsModel.preciseFacts) {
    // BOQ 清单参数（清单计价表中的设备技术参数、数量等）由“清单项落位”检查单独负责，
    // 不进入精确参数抽查池：清单随机参数（如智能化设备 15.50kPa）会挤占项目核心参数的抽查名额
    if (fact.roleId === 'bill_of_quantities') continue;
    const source = `${fact.processingType || ''} ${fact.roleId} ${fact.sourceFile}`;
    if (!PRECISE_FACT_SOURCE_RE.test(source) && fact.roleId !== 'precise_fact') continue;
    const context = `${fact.key} ${fact.fieldName || ''} ${fact.value}`;
    for (const match of context.matchAll(PRECISE_FACT_TOKEN_RE)) {
      const token = match[0].trim();
      if (!shouldIgnorePreciseToken(token, context)) tokens.add(token);
    }
  }
  return [...tokens];
}

/** 日历日期噪声：年份（2024年）与月份（12月）不是工程参数，不计入抽查池 */
function isCalendarNoiseToken(token: string) {
  return /^\d{4}\s*年$/u.test(token) || /^\d{1,2}\s*月$/u.test(token);
}

/** 章节证据窗口内的精确参数 token 集合：抽查口径与 LLM 实际可见证据对齐 */
function collectEvidencePreciseTokens(chapters: DocumentDraftChapter[]) {
  const tokens = new Set<string>();
  for (const chapter of chapters) {
    for (const item of chapter.evidence || []) {
      // BOQ 清单表格证据（计价表/暂估单价表等）有独立的“清单项落位”检查，
      // 其行级参数（设备技术参数、数量、金额）不进入精确参数抽查池，避免清单随机参数挤占项目核心参数
      if (/bill_of_quantities|boq/u.test(`${item.roleId || ''}`)) continue;
      const content = typeof item.content === "string" ? item.content : "";
      for (const match of content.matchAll(PRECISE_FACT_TOKEN_RE)) {
        const token = match[0].trim();
        if (!token || isCalendarNoiseToken(token)) continue;
        const index = match.index || 0;
        const context = content.slice(Math.max(0, index - 40), index + token.length + 40);
        if (!shouldIgnorePreciseToken(token, context)) tokens.add(token);
      }
    }
  }
  return [...tokens];
}

function countUsedPreciseTokens(tokens: string[], markdown: string) {
  // 4.49 r9 #12 根治（使用判定归一化）：双端走 normalizeEngineeringTextForFactMatch（单位/全角/
  // 破折号归一）——正文「28570.36平方米」与池 token「28570.36㎡」、「30 日历天」与「30天」、
  // 「GB 51192—2016」与「GB51192-2016」等价命中，消除「已写入但形态不同」的结构性假缺口
  const normalized = normalizeEngineeringTextForFactMatch(markdown);
  let used = 0;
  for (const token of tokens) {
    if (normalized.includes(normalizeEngineeringTextForFactMatch(token))) used += 1;
  }
  return used;
}

// 关键精确参数抽查：高价值单位（工期/面积/强度/规范编号等）优先进入抽查池，
// 这类参数是施组评审最关注的核心工程参数，比一般规格数字更需要保证写入正文
const PRECISE_FACT_CRITICAL_SPOT_COUNT = 6;
const PRECISE_FACT_CRITICAL_MIN_RATE = 0.5;
const CRITICAL_PRECISE_UNIT_RE = /日历天|个月|㎡|m²|m3|m³|MPa|kPa|kN|GB\/T|GB|JGJ|ISO|DN|φ|Φ|米\/秒|天$/u;
/** 抽查池类目（4.44 #44 根治）：类内数值降序 + 跨类轮转抽样，避免字面序靠前的单类小值霸榜 */
const CRITICAL_PRECISE_CATEGORY_RES: readonly RegExp[] = [
  /GB|JGJ|ISO|CJJ|DB/u,
  /DN|φ|Φ/u,
  /MPa|kPa|kN|米\/秒/u,
  /日历天|个月|天$/u,
  /㎡|m²/u,
  /m3|m³/u,
];

/** token 内首个数值（类内排序键）；无数值返回 -Infinity 排在数值 token 之后 */
function tokenFirstNumericValue(token: string): number {
  const numeric = /\d+(?:\.\d+)?/u.exec(token)?.[0];
  return numeric === undefined ? Number.NEGATIVE_INFINITY : Number.parseFloat(numeric);
}

/** 关键参数抽查池（导出供测试直接断言池组成，见 qualityValidation.test.ts #44 组） */
export function criticalPreciseTokens(tokens: string[]) {
  // 先确定性排序（字典序）再分层抽样：消除上游 LLM 提取顺序对抽查池的随机影响，
  // 保证同一项目重跑时抽查池与判定结果可复现
  const sorted = [...tokens].sort((a, b) => a.localeCompare(b, "zh"));
  const critical = sorted.filter(token => CRITICAL_PRECISE_UNIT_RE.test(token));
  const rest = sorted.filter(token => !CRITICAL_PRECISE_UNIT_RE.test(token));
  // 4.44 #44 根因根治（丰乐镇 4.43 实测「关键参数抽查 0/10（缺失如 103㎡、106㎡、1072㎡）」）：
  // 旧实现 critical.slice(0,8) 按字典序盲选——「1」开头小值、「D」开头 DN 管径、「G」开头 GB
  // 编号跨轮霸榜同类名额，核心大参数（总建筑面积 28570.36㎡、主给水管 DN1000）反被挤出抽查池，
  // 使用率被结构性拉低。修复：类目分组（规范编号/管径/强度压力流速/工期/面积/体积）→
  // 类内数值降序（大值核心参数优先）→ 跨类轮转抽样（类目均衡）→ 补 2 个常规 token 保持可复现性
  const groups: string[][] = CRITICAL_PRECISE_CATEGORY_RES.map(() => []);
  const other: string[] = [];
  for (const token of critical) {
    const index = CRITICAL_PRECISE_CATEGORY_RES.findIndex(pattern => pattern.test(token));
    (index >= 0 ? groups[index] : other).push(token);
  }
  const queues = [...groups, other].map(group => group.sort((a, b) => {
    const left = tokenFirstNumericValue(a);
    const right = tokenFirstNumericValue(b);
    if (Number.isFinite(left) && Number.isFinite(right)) return right - left || a.localeCompare(b, "zh");
    if (Number.isFinite(left)) return -1;
    if (Number.isFinite(right)) return 1;
    return a.localeCompare(b, "zh");
  }));
  const picked: string[] = [];
  let cursor = 0;
  let emptyRounds = 0;
  while (picked.length < 8 && emptyRounds < queues.length) {
    const queue = queues[cursor % queues.length]!;
    if (queue.length > 0) {
      picked.push(queue.shift()!);
      emptyRounds = 0;
    } else {
      emptyRounds += 1;
    }
    cursor += 1;
  }
  // 分层抽样：关键单位优先进入抽查池，但保留少量常规规格 token，
  // 避免关键 token 过多时抽查池被单一单位类型（如大量面积值）占满而失去代表性
  return [...picked, ...rest.slice(0, 2)].slice(0, 10);
}

export async function preciseFactUsageIssues(markdown: string, factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[] = []): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  // 抽查口径对齐：优先使用章节证据窗口内的精确参数（LLM 实际收到的证据），
  // 消除"全项目精确事实中从未进入证据窗口"参数的结构性假阳性；
  // 证据池过小（章节 evidence 缺失或参数过少）时回退全项目精确事实池，保持门禁兜底能力
  const evidenceTokens = collectEvidencePreciseTokens(chapters);
  const tokens = evidenceTokens.length >= PRECISE_FACT_MIN_TOKEN_COUNT ? evidenceTokens : collectPreciseFactTokens(factsModel);
  const used = countUsedPreciseTokens(tokens, markdown);
  if (tokens.length >= PRECISE_FACT_MIN_TOKEN_COUNT && used / tokens.length < PRECISE_FACT_MIN_USAGE_RATE) issues.push({ level: 'warning', message: `可靠精确参数使用不足：${used}/${tokens.length}`, suggestion: '请将资料中可靠的规格、参数、数量、时间、比例和标准编号写入对应章节；商务金额、单价、税率、预留金不得写入正文。' });
  // 关键参数抽查：对高价值精确参数单独抽查使用率，过低时升级为 error，
  // 使导出门禁的"结构化精确参数已使用"检查项显式失败（有正文时不硬阻断导出，避免卡死交付）
  const criticalTokens = criticalPreciseTokens(tokens);
  if (criticalTokens.length >= PRECISE_FACT_CRITICAL_SPOT_COUNT) {
    const normalizedForMatch = normalizeEngineeringTextForFactMatch(markdown);
    let criticalUsed = countUsedPreciseTokens(criticalTokens, markdown);
    let missingCritical = criticalTokens.filter(token => !normalizedForMatch.includes(normalizeEngineeringTextForFactMatch(token)));
    // Q11 语义兜底：字面未命中的关键参数用本地 bge 对正文句语义判定（"建设规模4646㎡"≈"总建筑面积4646平方米"）
    if (missingCritical.length > 0 && criticalUsed / criticalTokens.length < PRECISE_FACT_CRITICAL_MIN_RATE) {
      const sentences = markdown
        .split(/[。；;|]/u)
        .map(sentence => sentence.trim())
        .filter(sentence => sentence.length >= 6 && sentence.length <= 160)
        .slice(0, 300);
      if (sentences.length > 0) {
        const similarity = await buildSemanticSimilarity(missingCritical.slice(0, 10), sentences);
        missingCritical = missingCritical.filter(token => !sentences.some(sentence => similarity(token, sentence) >= SEMANTIC_COVERAGE_THRESHOLD));
        criticalUsed = criticalTokens.length - missingCritical.length;
      }
    }
    if (criticalUsed / criticalTokens.length < PRECISE_FACT_CRITICAL_MIN_RATE) {
      const shownMissing = missingCritical.slice(0, 3);
      // 内容深度补写轮（content-depth-repair）定位锚点：关键参数抽查 error 打 provenance
      // （detectorId 单源，修复轮按 provenance 精确过滤消费；r8 实机 #16 归因：该类 error
      // 此前无任何修复轮消费，直坠终门禁）
      issues.push({ level: 'error', message: `可靠精确参数使用不足：关键参数抽查 ${criticalUsed}/${criticalTokens.length}${shownMissing.length ? `（缺失如 ${shownMissing.join('、')}）` : ''}`, suggestion: '请将资料中的关键工程参数（工期、面积、强度等级、材料规格、规范编号等）写入正文对应章节，不得因参数总量达标而遗漏核心参数。', provenance: { detectorId: 'precise-fact-usage', fingerprint: stableHash(markdown) } });
    }
  }
  if (factsModel.bills.length > 0 && !STRUCTURED_DATA_CONTENT_RE.test(markdown)) issues.push({ level: 'error', message: '正文未体现结构化数据资料', suggestion: '请从表格、列表或明细中提取对象、单位、数量、规格和关键参数补入对应章节。', provenance: { detectorId: 'precise-fact-usage', fingerprint: stableHash(markdown) } });
  if (factsModel.drawings.length > 0 && !SPECIFICATION_CONTENT_RE.test(markdown)) issues.push({ level: 'error', message: '正文未体现设计/方案/说明类资料', suggestion: '请从设计、方案或说明资料中提取对象、流程、节点、做法、配置、规则和标准要求。', provenance: { detectorId: 'precise-fact-usage', fingerprint: stableHash(markdown) } });
  return issues;
}

/**
 * 关键参数缺失池（修复轮 content-depth-repair 消费口径，与 preciseFactUsageIssues 关键参数抽查严格同源）：
 * 返回当前正文未命中的关键参数 token 列表（字面口径，确定性零嵌入成本）。检测端在此之上还有
 * Q11 bge 语义兜底（语义已覆盖不算缺失）；修复轮用字面口径稍宽——假缺口由「每章 2 轮上限 +
 * 残留不降即停 + 外层 recompute 复核（含语义兜底）」三层收敛机制吸收，不产生死循环。
 */
export function missingCriticalPreciseTokens(markdown: string, factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[] = []): string[] {
  // 4.49 r9 #12 根治：与 preciseFactUsageIssues 同源归一化字面口径（单位/全角/破折号双端归一）
  const normalized = normalizeEngineeringTextForFactMatch(markdown);
  const evidenceTokens = collectEvidencePreciseTokens(chapters);
  const tokens = evidenceTokens.length >= PRECISE_FACT_MIN_TOKEN_COUNT ? evidenceTokens : collectPreciseFactTokens(factsModel);
  const criticalTokens = criticalPreciseTokens(tokens);
  if (criticalTokens.length < PRECISE_FACT_CRITICAL_SPOT_COUNT) return [];
  return criticalTokens.filter(token => !normalized.includes(normalizeEngineeringTextForFactMatch(token)));
}

/** 语义兜底分批大小（C3-5）：每批一次批量嵌入，短句跨批走全局嵌入 LRU 缓存不重复推理 */
const SEMANTIC_BOQ_NAME_BATCH = 60;

/** 清单落位校验（Q1 修复链；C-T5 有效行口径 / C3-5 单源化）：行识别/豁免/落位判定全链消费
 * buildBoqRowTraces（documentFactTrace 单源——与报告出口 boq-row-trace、分项覆盖 boqDivisionCoverageIssues
 * 同源同口径；修历史双轨缺陷：门禁 16 字符整名前缀 vs 报告 12 字符首段前缀，s28l 实测 1118 vs 822 行
 * 未落位差 296 行，且短名行计分母不入明细造成隐形分母）；有效行（豁免汇总口径行后）处置率 <90% 升级
 * error（provenance 由修复轮 boq-placement 锚定消费）；语义兜底（bge ≥0.6）对全量 unique 名称分批覆盖
 * （历史缺陷：slice(0,30) 截断致 s28l 171 unique 中 141 个无兜底机会）；豁免/显性说明登记进审计出口 */
export async function boqPlacementIssues(markdown: string, chapters: DocumentDraftChapter[], factsModel: DocumentFactsModel): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  if ((factsModel.tables || []).length === 0) return issues;

  const traces = buildBoqRowTraces(markdown, factsModel);
  // C-T5 豁免口径单源（billFactLock.classifyBillPlacementExemption，traces.exempt）：汇总口径行（分部小计/
  // 合计/规费/税金）、版式噪声行（清单表页眉/表标题）、费用组成行（…费/税/暂估价，长度限幅）、分部标题行
  // （XX工程，无码无量）均不是清单明细项，无法落位也无须落位，不计入分母（豁免行清单进审计出口）
  const considered = traces.filter(trace => !trace.exempt);
  if (considered.length === 0) return issues;
  const exemptRows = traces.length - considered.length;
  const placedTraces = considered.filter(trace => trace.placed);
  const unplacedTraces = considered.filter(trace => !trace.placed);
  const totalRows = considered.length;
  const placedRows = placedTraces.length;

  // C-T5 显性说明出口（方案 C-T5③）：修复链对未落位行的两种合法处置——补写落位或显性说明；
  // 说明句含条目名称即自然成为字面落位证据（正文写入“XX利旧/不涉及/由厂家配套”即完成处置）；
  // 此处对已落位行做说明式处置识别（利旧/甲供/不涉及等语气），审计区分「施工内容落位」与「说明式处置」
  const explicitDisposed = scanBillExplicitDispositions(markdown, placedTraces.map(trace => trace.itemName));

  // Q1 语义兜底：字面未命中的清单项名 vs 正文句 bge 余弦 ≥0.6 视为落位（"立面块料拆除"与"拆除外立面幕墙"同义落位）
  // C3-5 扩面：全量 unique 名称分批（每批 60 条批量嵌入）——历史 slice(0,30) 对 s28l 171 unique 名称仅覆盖
  // 前 30 个，其余 141 个无兜底机会（语义已承接仍被判未落位），落位率被系统性低估
  const semanticPlacedNames = new Set<string>();
  if (unplacedTraces.length > 0 && placedRows / totalRows < 0.9) {
    const sentences = markdown
      .split(/[。；;|]/u)
      .map(sentence => sentence.trim())
      .filter(sentence => sentence.length >= 6 && sentence.length <= 160)
      .slice(0, 300);
    const uniqueNames = [...new Set(unplacedTraces.map(trace => trace.itemName))];
    if (sentences.length > 0 && uniqueNames.length > 0) {
      for (let offset = 0; offset < uniqueNames.length; offset += SEMANTIC_BOQ_NAME_BATCH) {
        const batch = uniqueNames.slice(offset, offset + SEMANTIC_BOQ_NAME_BATCH);
        const similarity = await buildSemanticSimilarity(batch, sentences);
        for (const name of batch) {
          if (sentences.some(sentence => similarity(name, sentence) >= SEMANTIC_COVERAGE_THRESHOLD)) semanticPlacedNames.add(name);
        }
      }
    }
  }
  const placedTotal = placedRows + unplacedTraces.filter(trace => semanticPlacedNames.has(trace.itemName)).length;
  // 剩余未落位 = 字面/语义未命中的行；按 unique 名称归并（s28l 实测 1118 行仅 171 unique、重复率 5.99×——
  // 行级明细会在 message 前 30 项截断窗口内被同类重复项占满，修复轮拿不到完整补写义务清单）；
  // 责任章标注（C-T5② 每行→责任章）为修复链给出补写归属章
  const remainingUnplaced = unplacedTraces.filter(trace => !semanticPlacedNames.has(trace.itemName));
  const responsibleChapterOf = (trace: BoqRowTrace): string => {
    if (chapters.length === 0) return '';
    const assignment = assignBillRowChapter({ name: trace.itemName, description: trace.description || '' }, chapters);
    return assignment ? `，建议落位「${assignment.chapterTitle.slice(0, 24)}」` : '';
  };
  const unplacedGroups = new Map<string, { name: string; rows: number; sample: BoqRowTrace }>();
  for (const trace of remainingUnplaced) {
    const key = trace.itemName.slice(0, 40);
    const group = unplacedGroups.get(key);
    if (group) group.rows += 1;
    else unplacedGroups.set(key, { name: trace.itemName, rows: 1, sample: trace });
  }
  const groupList = [...unplacedGroups.values()].sort((a, b) => b.rows - a.rows);
  const rate = placedTotal / totalRows;
  const auditNote = [
    exemptRows > 0 ? `口径行 ${exemptRows} 行（汇总/噪声/费用/标题等非清单明细）已豁免不计入分母` : '',
    explicitDisposed.size > 0 ? `显性说明 ${explicitDisposed.size} 行（利旧/甲供/不涉及等说明式处置）` : '',
  ].filter(Boolean).join('；');
  const unplacedSummary = groupList.length > 0
    ? `未落位项（共${remainingUnplaced.length}行/${groupList.length}类）：${groupList.slice(0, 30).map(group => `${group.name.slice(0, 40)}${group.rows > 1 ? `×${group.rows}` : ''}${group.sample.quantity ? ` ${group.sample.quantity}` : ''}（未落位${responsibleChapterOf(group.sample)}）`).join('；')}${groupList.length > 30 ? ` 及其他${groupList.length - 30}类（同类项按已列名称分组归并补写）` : ''}`
    : '';
  // C-T5 落位率阈值 90%（有效行口径：豁免行不计分母，显性说明行计入已处置）；<90% 升 error 进修复循环
  // （补写未落位项或显性说明处置）；provenance.detectorId='boq-placement' 供修复轮锚定消费（C3-5 挂靠
  // 缺口根治：历史 error 无 provenance、LLM_PATCH_REPAIR_ROUNDS 17 轮无一消费直坠终门禁）；不命中
  // CRITICAL_BLOCK_RE 硬阻断清单，修复轮补写后仍不足时由导出门禁按软性项处理，不卡死交付
  if (rate < 0.9) {
    // 未落位明细必须并入 message：交付阻断修复链的 rechecker 只转发 message，明细留在 suggestion
    // 会丢失（真实生成缺陷：修复指令声称“缺陷描述中已列明细”但明细从未送达，LLM 无据可补写）
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'evidence_coverage',
      owner: 'llm',
      repairability: 'llm_repairable',
      provenance: { detectorId: 'boq-placement', fingerprint: stableHash(markdown) },
      message: `清单项落位不足：${placedTotal}/${totalRows} 项（${Math.round(rate * 100)}%）${unplacedSummary ? `。${unplacedSummary}` : ''}`,
      suggestion: `请将未落位清单项按专业工程分组补写进对应章节"主要施工内容"小节（融入各专业工程的作业对象与工程量、工序顺序、施工方法叙述），优先落位主要分部分项、关键规格与大额工程量；对确实不涉及/利旧/甲供/由厂家配套的条目，在正文对应章节显性说明处置方式（说明句须含条目名称）。${unplacedSummary}${auditNote ? `〔落位审计：${auditNote}〕` : ''}`,
    });
    return issues;
  }
  // 4.55.12 缺口清单制（口径决定，plan §3.1 原则 4）：阈值线以上不再静默——未落位行**逐条可查**。
  // 原口径只在 <90% 时说话，阈值以上的残留缺口（巢湖实测 107 行/62 类，其中语义仅承接约 72 行）
  // 既不进报告也不进人工清单，交付报告只给一个 87% 的比率，无法回答「未落位的那批有没有正当理由」。
  // 现口径：残留缺口产出**清单型 warning**（不阻断、不额外触发修复轮——语义/说明已承接的部分补写
  // 收益低，成本在修复轮），按「语义已承接 / 未承接」二分列明，供人工复核与下一轮生成定位。
  if (remainingUnplaced.length === 0) return issues;
  // 语义兜底只在落位率 <90% 时运行（成本闸）：未运行时不得把残留缺口表述为「未承接」——
  // 那是把「没检查」说成「检查了不通过」（诊断说真话口径）
  const semanticRan = unplacedTraces.length > 0 && placedTotal / totalRows < 0.9;
  const semanticRescued = semanticRan ? unplacedTraces.filter(trace => semanticPlacedNames.has(trace.itemName)) : [];
  const semanticOnlyGroups = new Set(semanticRescued.map(trace => trace.itemName.slice(0, 40)));
  const notCarried = groupList.filter(group => !semanticOnlyGroups.has(group.name.slice(0, 40)));
  const gapSummary = notCarried.slice(0, 20).map(group => `${group.name.slice(0, 40)}${group.rows > 1 ? `×${group.rows}` : ''}${group.sample.quantity ? ` ${group.sample.quantity}` : ''}（未落位${responsibleChapterOf(group.sample)}）`).join('；');
  const splitNote = semanticRan
    ? `其中语义已承接 ${semanticRescued.length} 行（${semanticOnlyGroups.size} 类），未承接 ${notCarried.reduce((sum, group) => sum + group.rows, 0)} 行（${notCarried.length} 类）`
    : `（落位率已达线，语义兜底通道未触发——下列缺口均为字面未落位，是否已被同义表述承接需人工判断）`;
  issues.push({
    level: 'warning',
    category: 'evidence_coverage',
    owner: 'user',
    repairability: 'manual_review',
    provenance: { detectorId: 'boq-placement', fingerprint: stableHash(markdown) },
    message: `清单落位缺口清单（已达落位率线，残留缺口供复核）：${placedTotal}/${totalRows} 项（${Math.round(rate * 100)}%），字面未落位 ${remainingUnplaced.length} 行 / ${groupList.length} 类；${splitNote}${gapSummary ? `。缺口项：${gapSummary}` : ''}`,
    suggestion: `以下未落位项须逐条给出处置：补写进对应章节、或显性说明（不涉及/利旧/甲供/由厂家配套）。${gapSummary}${auditNote ? `〔落位审计：${auditNote}〕` : ''}`,
  });
  return issues;
}

/**
 * 图纸引用率目标线（C3-6-5，plan v3 §10 第 10 条：图纸全引用目标 ≥90%）：目标线以下的未完全落位
 * 产出「可修复 warning」（owner=llm + provenance 打点），由 content-depth-repair 的图纸通道定向补写；
 * 目标线以上不再报出（无缺口）。<50% 保持 blocker 硬阻断（C3-6 原有口径，未改动）。
 */
const DRAWING_REFERENCE_TARGET_RATE = 0.9;

/**
 * B-T3 图纸事实引用率验收：可用图纸（含可判定 token 的图纸）↔ 正文图纸事实 token 落位（≥1 处/份）。
 * 历史口径缺陷（B4 根因之一）：原实现以「文件全路径去扩展名去斜杠」前 12 字符匹配正文——匹配的是
 * 目录路径前缀（正文永远不含），且正文规则禁止引用文件名（FILE_NAME_RE 清洗）——口径本身错位，
 * 真实数据恒判 0%；现口径改为消费图纸事实锁（drawingFactLock）的确定性 token，与写作直读通道同源。
 * C3-6-5：三条产出档位——全落位静默；<目标线 warning（可修复，provenance 单源）；<50% blocker。
 */
export function drawingReferenceIssues(markdown: string, drawingFactLock?: DrawingFactLock): ValidationIssue[] {
  if (!drawingFactLock || drawingFactLock.groups.length === 0) return [];
  const placement = drawingFactPlacement(drawingFactLock, markdown);
  if (placement.unreferenced.length === 0) return [];
  // 目标线（90%）以上视为达标：残留少量未引用不再报出（无修复动作的永久 warning 属噪音）
  if (placement.rate >= DRAWING_REFERENCE_TARGET_RATE) return [];
  const total = drawingFactLock.groups.length;
  const details = placement.unreferenced.slice(0, 6).map(group => {
    const sample = group.factLines[0]?.slice(0, 60) || '';
    return `${group.sourceFile.split('/').pop() || group.sourceFile}${sample ? `（如：${sample}）` : ''}`;
  });
  const rate = Math.round(placement.rate * 100);
  const suggestion = `请将未落位图纸的设计说明、构造做法、材料规格与设备参数写入对应专业章节（按专业归属：结构/道路/排水/照明等），与清单规格一致的照抄清单权威值，不得编造；未落位图纸：${details.join('、')}`;
  // 单份图纸（分母 <2）不升 error：不足以判定系统性缺失，仅告警（防误伤小体量项目）
  if (placement.rate < 0.5 && total >= 2) {
    return [{
      level: 'error',
      severity: 'blocker',
      owner: 'llm',
      repairability: 'llm_repairable',
      provenance: { detectorId: 'drawing-reference', fingerprint: stableHash(markdown) },
      message: `图纸事实落位不足：${placement.referenced.length}/${total} 份图纸的规格/做法事实在正文落位（${rate}%）`,
      suggestion,
    }];
  }
  // 目标线以下（未达 90%）为可修复 warning：打 provenance 与可修复标注——修复轮据此定向补写未落位图纸
  return [{
    level: 'warning',
    severity: 'warning',
    owner: 'llm',
    repairability: 'llm_repairable',
    provenance: { detectorId: 'drawing-reference', fingerprint: stableHash(markdown) },
    message: `图纸事实未完全落位：${placement.referenced.length}/${total} 份图纸被正文引用（${rate}%，目标 ≥${Math.round(DRAWING_REFERENCE_TARGET_RATE * 100)}%）`,
    suggestion,
  }];
}

/**
 * 指向型表述判定（4.55.24 用户口径 D2：「不存在资料没给参数的情形」）。
 *
 * **实测依据**（巢湖 4.55.23 终稿）：`按设计图纸` 58 处、`参见《…》20S515/29` 4 处、
 * `详见……大样图` 3 处、OCR 错字变体 `烷2015S209` 1 处。评标人拿不到具体做法，等同没写。
 *
 * **与 drawing-reference 的分工**（两者不同轴，不可互替）：`drawing-reference` 测「图纸事实引用率」
 * （引用得够不够），本条测「以指向替代具体做法」（用指向搪塞）——故本条独立成判据。
 *
 * 判据形态：
 * - 指向型短语：按设计图纸＋控制/计量/要求…、按图纸…、以图纸为准/详见图纸、详见××大样图/详图；
 * - 图集/标准图引用替代做法：`参见《…》<图集号>` 或裸图集号（20S515、12J201、皖2015S209 等），
 *   **编制依据语境除外**（依据/规范/编制依据句中的规范罗列是正当引用）；
 * - 缺资料搪塞：资料/图纸未提供…参数、待补充/待确认/待核实。
 */
const DRAWING_POINTER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /按设计图纸(?:控制|计量|要求|施工|确定|执行|进行|处理|设置|选用|计算|调整)/gu, label: '按设计图纸…' },
  { pattern: /按(?:施工)?图纸(?:控制|计量|要求|施工|确定|执行)/gu, label: '按图纸…' },
  { pattern: /以(?:设计)?图纸为准|详见(?:施工)?图纸/gu, label: '以图纸为准/详见图纸' },
  { pattern: /详见[^。；\n]{0,16}(?:大样图|详图|节点图|工艺图|做法表)/gu, label: '详见××大样图' },
  { pattern: /(?:资料|图纸|清单|设计文件)(?:中)?未(?:提供|明确|给出|注明)[^。；\n]{0,12}(?:参数|数据|做法|要求|规格)?/gu, label: '缺资料搪塞' },
  { pattern: /(?:具体(?:参数|做法|数值))?待(?:补充|确认|核实|明确)/gu, label: '待补充/待确认' },
];
/** 图集/标准图编号形态（含地方图集前缀字与 OCR 错字变体「烷」） */
const ATLAS_CODE_IN_SENTENCE_RE = /(?:参见《[^》]{2,40}》\s*)?(?:[皖烷京沪苏浙粤鲁豫鄂湘川渝陕冀晋蒙辽吉黑闽赣桂黔滇甘青宁新藏]\s?\d{4}|\d{2})\s?[A-Z]{1,2}\s?\d{2,4}(?:[/／]\d{1,3})?/u;
/** 编制依据语境（正当规范罗列，不判指向型） */
const BASIS_SENTENCE_RE = /依据|编制|规范标准|标准规范|执行本|遵照/u;

export function drawingPointerPhraseIssues(markdown: string): ValidationIssue[] {
  const text = String(markdown || '');
  if (!text) return [];
  const hits: Array<{ label: string; sample: string }> = [];
  for (const { pattern, label } of DRAWING_POINTER_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const sentence = enclosingSentence(text, match.index ?? 0);
      if (label === '缺资料搪塞' && BASIS_SENTENCE_RE.test(sentence)) continue;
      hits.push({ label, sample: sentence.slice(0, 60) });
    }
  }
  // 图集引用替代做法：仅当句内出现图集号且**不是**编制依据语境（依据句中的规范罗列正当）
  for (const match of text.matchAll(/参见《[^》]{2,40}》[^。；\n]{0,20}/gu)) {
    const sentence = enclosingSentence(text, match.index ?? 0);
    if (BASIS_SENTENCE_RE.test(sentence)) continue;
    if (!ATLAS_CODE_IN_SENTENCE_RE.test(match[0])) continue;
    hits.push({ label: '参见《…》图集替代做法', sample: match[0].replace(/\s+/gu, ' ').slice(0, 60) });
  }
  // 裸图集号指向（实测「雨水口按皖2015S209/93~相关专业图纸」）：图集号必须与指向动词同句，
  // 且非编制依据语境——编制依据里的规范/图集罗列是正当引用，不判。
  for (const match of text.matchAll(/(?:参见|详见|参照|见|按|依照)[^。；\n]{0,10}?((?:[皖烷京沪苏浙粤鲁豫鄂湘川渝陕冀晋蒙辽吉黑闽赣桂黔滇甘青宁新藏]\s?\d{4}|\d{2})\s?[A-Z]{1,2}\s?\d{2,4}(?:[/／]\d{1,3})?)/gu)) {
    const sentence = enclosingSentence(text, match.index ?? 0);
    if (BASIS_SENTENCE_RE.test(sentence)) continue;
    hits.push({ label: '图集号指向替代做法', sample: match[0].replace(/\s+/gu, ' ').slice(0, 60) });
  }
  if (hits.length === 0) return [];
  const byLabel = new Map<string, number>();
  for (const hit of hits) byLabel.set(hit.label, (byLabel.get(hit.label) || 0) + 1);
  return [{
    level: 'error',
    severity: 'blocker',
    owner: 'llm',
    repairability: 'llm_repairable',
    provenance: { detectorId: 'drawing-pointer-phrase', fingerprint: stableHash(markdown) },
    message: `指向型表述替代具体做法：${hits.length} 处（${[...byLabel.entries()].map(([label, count]) => `${label} ${count} 处`).join('、')}）`,
    suggestion: `请把每处指向改写为本项目已确认的具体做法与参数实值（取蓝图／工程量清单／图纸标注／规范的确定值）；缺该条目权威值时按同专业已确认的等效做法＋已有资料写实，不得指向图纸/图集、不得写「未提供」类搪塞。示例：${hits.slice(0, 4).map(hit => hit.sample).join(' / ')}`,
  }];
}

/** 取命中位置所在的句子（以句读切分，用于语境豁免判定） */
function enclosingSentence(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('。', index) + 1, text.lastIndexOf('；', index) + 1, text.lastIndexOf('\n', index) + 1);
  const ends = [text.indexOf('。', index), text.indexOf('；', index), text.indexOf('\n', index)].filter(cursor => cursor >= 0);
  const end = ends.length > 0 ? Math.min(...ends) : text.length;
  return text.slice(start, end);
}

export function formalPlaceholderIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (/【本小节生成未达标，需重新生成】/u.test(markdown)) issues.push({ level: 'error', message: '生成未完成：存在未达标小节，需要重新生成或补写后才能导出', suggestion: '请重新生成未达标小节，禁止将占位内容作为正式正文。' });
  for (const pattern of FORMAL_PLACEHOLDER_PATTERNS) {
    if (pattern.test(markdown)) issues.push({ level: 'warning', message: `存在占位式表达：${pattern.source}`, suggestion: '请改写为来自资料的准确事实；资料确实未提供时，改写为正式管理措施，不留空值或“见资料/按文件”。' });
  }
  // D-T5 表格数据格占位符（r28f #42 口径统一）：判定与豁免口径单源同阻断层
  // （isNonExemptTablePlaceholderCell：合计行/规格类列「—」合法不报）；非豁免命中同表已被
  // table-quality 阻断并由 table-repair-round 修复轮消费，本警告层只补定位信息不重复定义词表
  const tablePlaceholderHits = scanTablePlaceholderCells(markdown);
  if (tablePlaceholderHits.length > 0) {
    const first = tablePlaceholderHits[0]!;
    issues.push({ level: 'warning', message: `存在占位式表达：表格数据格占位符（${first.header.join('、')}“${first.rowFirstCell}”行“${first.cell}”）共 ${tablePlaceholderHits.length} 处`, suggestion: '请改写为来自资料的准确事实；资料确实未提供时，改写为正式管理措施，不留空值或“见资料/按文件”。' });
  }
  return issues;
}

/** 小节标题工程类别存在性检测（丰乐镇第 3 轮实测）：工程量清单章节汇总行名称
 * （如「墙、柱面装饰与隔断、幕墙工程」）被 LLM 照抄为小节标题，但小节正文实际只施工
 * 墙面装饰（无幕墙/隔断/柱面装饰分项）——标题列出的工程类别必须在小节正文有对应
 * 施工内容。4.31 起扫描口径收敛到 detectors 单源 scanUncoveredEngineeringHeadings
 *（检测定位=修复定位：fixHeadingUncoveredItems 同源消费；归一化核对与词段守卫见该函数注释）。 */
export function headingUncoveredEngineeringItems(markdown: string): ValidationIssue[] {
  return scanUncoveredEngineeringHeadings(markdown).map((hit): ValidationIssue => ({
    level: 'error',
    message: `小节标题「${hit.title}」含本小节正文未覆盖的工程类别：${hit.uncovered.join('、')}`,
    suggestion: '标题中的工程类别必须在小节正文有对应施工内容；请将标题改为与实际施工内容一致的名称，不得照抄工程量清单章节汇总行名称。',
  }));
}

function templateMatchesAutoSpecGate(text: string, matchers: string[]) {
  for (const pattern of matchers) {
    try {
      if (new RegExp(pattern, 'iu').test(text)) return true;
    } catch {
      if (text.includes(pattern)) return true;
    }
  }
  return false;
}

/** 判断禁用词是否真正命中：允许“见图纸/按图纸”后接“目录/清单/索引/汇总”表示引用正文中的正式目录章节，属于合法交叉引用。 */
function containsForbiddenText(markdown: string, item: string): boolean {
  const legitimateSuffixes = item === '见图纸' || item === '按图纸' ? ['目录', '清单', '索引', '汇总'] : [];
  let from = 0;
  for (;;) {
    const index = markdown.indexOf(item, from);
    if (index < 0) return false;
    const after = markdown.slice(index + item.length);
    if (legitimateSuffixes.some(suffix => after.startsWith(suffix))) {
      from = index + item.length;
      continue;
    }
    return true;
  }
}

export function plannedAutoSpecGateIssues(markdown: string, template: DocumentTemplate): ValidationIssue[] {
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  const gates = [];
  for (const gate of readEngineeringDocumentConfig().autoSpecGates) {
    if (templateMatchesAutoSpecGate(text, gate.templateMatchers)) gates.push(gate);
  }
  if (gates.length === 0) return [];
  const issues: ValidationIssue[] = [];
  const tableCount = markdownTables(markdown).length;
  let minTables = 0;
  for (const gate of gates) {
    minTables = Math.max(minTables, gate.minTables || 0);
    // G 线 P1-15：配置必需要素（requiredTexts）是**用户刚性要求**，此前只判 warning ⇒
    // 进不了硬门禁，用户配了「必须出现 XX」却拿不到任何阻断反馈。升级为 error 后：
    // ① 进入阻断集；② 由锚定本检测器的 auto-spec-gate-repair 轮定向补写
    //（补不进的残留即硬门禁失败——这正是「刚性要求」应有的语义）。
    for (const item of gate.requiredTexts) if (!markdown.includes(item)) issues.push({ level: 'error', message: `配置要求缺少必要内容：${item}`, suggestion: '请按当前模板匹配的专业规则补齐必要内容。' });
    for (const item of gate.forbiddenTexts) if (containsForbiddenText(markdown, item)) issues.push({ level: 'error', message: `配置要求不得出现：${item}`, suggestion: '请根据当前模板匹配的专业规则清理正文污染内容。' });
  }
  if (MARKDOWN_TOP_HEADING_RE.test(markdown)) issues.push({ level: 'error', message: '正式正文存在 Markdown 标题符号 #', suggestion: '导出正文应去除 Markdown 标题符号，保留正式标题文字。' });
  // G 线 P1-15：同理升级为 error —— minTables 是用户在配置里写死的表格数量下限
  if (minTables && tableCount < minTables) issues.push({ level: 'error', message: `配置要求正式表格不足：${tableCount}/${minTables}`, suggestion: '如用户提示词或章节内容要求表格，应按项目资料补充对应表格本体。' });
  return issues;
}

/** 模板命中的 autoSpecGates 必要术语列表：Final Gate 确定性补写用，保证施组标准术语（编制依据/主要施工材料等）一定出现在正文 */
export function autoSpecGateRequiredTexts(template: DocumentTemplate): string[] {
  const text = `${template.name} ${template.category} ${template.outputTitle} ${template.description}`;
  const required = new Set<string>();
  for (const gate of readEngineeringDocumentConfig().autoSpecGates) {
    if (templateMatchesAutoSpecGate(text, gate.templateMatchers)) {
      for (const item of gate.requiredTexts) if (item) required.add(item);
    }
  }
  return [...required];
}

function collectAllFacts(factsModel: DocumentFactsModel) {
  const allFacts = [...factsModel.project, ...factsModel.schedule, ...factsModel.quality, ...factsModel.safety, ...factsModel.resources];
  for (const facts of Object.values(factsModel.schemaFacts)) allFacts.push(...facts);
  return allFacts;
}

function collectFactNames(factsModel: DocumentFactsModel, allFacts: DocumentFact[]) {
  const factNames = new Set<string>();
  for (const fact of allFacts) {
    factNames.add(fact.key);
    if (fact.fieldName) factNames.add(fact.fieldName);
  }
  for (const table of factsModel.tables) {
    for (const header of table.headers) factNames.add(header);
    for (const row of table.rows) for (const cell of row) factNames.add(cell);
  }
  return factNames;
}

// 以下事实字段不属于“项目专属事实”，而是公共法规规范或通用施工组织推导内容，
// 应由 LLM 依据现行法规、行业规范与企业施工经验自行撰写，不要求从项目知识库逐条确认。
// 项目资料通常不包含法规原文、资源配置计划或通用工艺控制点，强校验会产生误导性告警。
function isLlmAuthoredFactName(name: string) {
  return /国家法律法规|地方法规|规章|规范标准|标准规范|行业标准|现行规范|法律法规|合规|施工方法|工艺流程|质量控制|安全文明|应急|劳动力|材料投入|机械设备|检测仪器|关键节点/u.test(name);
}

function validateRequiredSpecFields(spec: AutoDocumentSpecPackage, chapters: DocumentDraftChapter[], factNames: Set<string>, factsModel: DocumentFactsModel, next: ValidationIssue[]) {
  for (const field of spec.factFields) {
    if (!field.required || isLlmAuthoredFactName(field.name)) continue;
    const schemaFacts = factsModel.schemaFacts[field.id] || [];
    let satisfiedByChapterEvidence = false;
    let satisfiedBySourceRole = !field.sourceRoleIds?.length || schemaFacts.some(fact => field.sourceRoleIds?.includes(fact.roleId));
    for (const chapter of chapters) {
      if (satisfiedByChapterEvidence && satisfiedBySourceRole) break;
      for (const item of chapter.evidence) {
        if (!satisfiedByChapterEvidence && !chapter.missingFacts.includes(field.name) && evidenceSatisfiesSpecField(item, field)) satisfiedByChapterEvidence = true;
        if (!satisfiedBySourceRole && evidenceSatisfiesSpecField(item, field)) satisfiedBySourceRole = true;
      }
    }
    if (schemaFacts.length === 0 && !factNames.has(field.name) && !satisfiedByChapterEvidence) next.push({ level: 'warning', message: `系统暂未从知识库确认必需事实：${field.name}`, suggestion: field.extractionHint || '请扩大本地知识库检索、执行事实补抽，或调整事实字段配置。' });
    if (!satisfiedBySourceRole) next.push({ level: 'warning', message: `必需事实来源角色不匹配：${field.name}`, suggestion: `请确认该事实来自角色：${field.sourceRoleIds?.join('、')}` });
  }
}

function applySpecGateRule(context: SpecGateRuleContext): ValidationIssue | undefined {
  for (const handler of SPEC_GATE_RULE_HANDLERS) {
    const detail = handler(context);
    if (detail) return { level: context.rule.level, message: issueMessage(context.rule, detail) };
  }
  return undefined;
}

export function applySpecGateRules(spec: AutoDocumentSpecPackage | undefined, issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[], markdown: string, projectBindings: ProjectBinding[], promptBindings: PromptBinding[]) {
  if (!spec) return issues;
  const next = [...issues];
  const allFacts = collectAllFacts(factsModel);
  const factNames = collectFactNames(factsModel, allFacts);
  const chapterTitles = new Set(chapters.map(chapter => chapter.title));
  validateRequiredSpecFields(spec, chapters, factNames, factsModel, next);
  for (const chapter of spec.chapterRules) {
    const draft = chapters.find(item => item.title === chapter.title);
    if (draft && chapter.minWords && draft.content.length < chapter.minWords) next.push({ level: 'warning', message: `章节内容深度建议：${chapter.title}`, suggestion: `可扩展到约 ${chapter.minWords} 字，但不要改变模板章节结构。` });
  }
  const tableBlocks = markdownTables(markdown);
  const imageRefs = markdownImages(markdown);
  const estimatedPages = estimateDocumentPages(markdown);
  for (const rule of spec.gateRules) {
    const evaluator = fallbackEvaluatorForRule(rule);
    const target = evaluator.target || rule.target || '';
    const value = evaluator.value || rule.value || target;
    const chapter = chapters.find(item => item.title === target);
    const issue = applySpecGateRule({
      rule,
      evaluator,
      target,
      value,
      min: evaluator.min || Number(rule.value) || 1,
      markdown,
      textScope: evaluator.subject === 'chapter' && chapter ? chapter.content : markdown,
      regex: value ? safeRegex(value) : undefined,
      chapter,
      factNames,
      chapterTitles,
      tableBlocks,
      imageRefs,
      estimatedPages,
      allFacts,
      factsModel,
      projectBindings,
      promptBindings,
    });
    if (issue) next.push(issue);
  }
  return next;
}

function promptBindingContents(promptBindings: PromptBinding[]) {
  let content = '';
  for (const prompt of readPromptContents(promptBindings)) {
    if (prompt.content) content += `${prompt.content}\n\n`;
  }
  return content;
}

export function promptExampleLeakIssues(markdown: string, promptBindings: PromptBinding[]): ValidationIssue[] {
  const promptText = promptBindingContents(promptBindings);
  if (!promptText.trim()) return [];
  const normalizedMarkdown = markdown.replace(WHITESPACE_RE, ' ');
  for (const match of promptText.matchAll(PROMPT_EXAMPLE_BLOCK_RE)) {
    const block = (match[1] || '').replace(WHITESPACE_RE, ' ').trim();
    if (!block) continue;
    if (normalizedMarkdown.includes(block)) return [{ level: 'error', message: '正文疑似包含提示词示例内容', suggestion: '请删除提示词样例数据，仅保留基于当前绑定材料生成的正文。' }];
  }
  return [];
}

/**
 * 规划小节未落位检测（4.55.14，章级结构硬项；巢湖实测根因）：
 * 章级规划小节（含用户提示词/OUTLINE 声明的固定小节）必须作为三级标题落地。链尾已有确定性
 * 提升收口（promotePlannedSectionHeadings：把同名 H4 提升为 H3），本检测针对**提升后仍整节缺失**
 * 的形态——写作模型整节漏写（实测「编制依据与说明」章草稿 0 次）却无任何检测器覆盖，
 * qualityRules 里「章节必须覆盖规划小节」此前只是一句声明。缺失即 blocker（进修复轮与人工复核清单）。
 */
export function plannedSectionPlacementIssues(markdown: string, chapters: Array<{ title: string; sections?: string[] }> = []): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!markdown || chapters.length === 0) return issues;
  const lines = markdown.split(/\r?\n/u);
  const h2Indexes: Array<{ index: number; title: string }> = [];
  lines.forEach((line, index) => {
    const heading = /^##\s+(.+?)\s*$/u.exec(line.trim());
    if (heading && !/^(目录|附表)/u.test(heading[1])) h2Indexes.push({ index, title: heading[1].replace(/\s+/gu, '') });
  });
  for (const chapter of chapters) {
    const planned = (chapter.sections || []).filter(Boolean);
    if (planned.length === 0) continue;
    const normalizedTitle = chapter.title.replace(/\s+/gu, '');
    const start = h2Indexes.find(item => item.title.includes(normalizedTitle) || normalizedTitle.includes(item.title));
    if (!start) continue;
    const next = h2Indexes.find(item => item.index > start.index);
    const block = lines.slice(start.index + 1, next ? next.index : lines.length).join('\n');
    const missing = missingPlannedSections(planned, block);
    if (missing.length === 0) continue;
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'llm',
      repairability: 'llm_repairable',
      provenance: { detectorId: 'planned-section-placement', fingerprint: stableHash(markdown) },
      message: `规划小节未落位：「${displayChapterTitle(chapter.title)}」缺少 ${missing.length} 个规划小节（${missing.slice(0, 6).join('、')}${missing.length > 6 ? ' 等' : ''}）——章级规划小节必须以三级标题逐节落地，不得漏写或降级为四级标题`,
      suggestion: `请补齐以下小节并各自成节（三级标题「### X.X 小节名」，小节名与规划逐字一致，每节下写实质内容）：${missing.join('、')}。`,
    });
  }
  return issues;
}

/**
 * 表格空话单元格检测（4.55.16 巢湖实测）：表格单元格写「按清单工程量」「按设计标高控制」类搪塞语
 * ——字段名承诺的是数据，此类写法等价于留空，且**同段正文往往已有真实数值**（实测：表「工程量」列
 * 6 格全写「按清单工程量」，而同分项正文写着「机械运土方12792.800m3」）。按「表 × 列」聚合报出
 * （逐格报会刷屏），带 provenance 供修复轮按列定向补写真实值（清单/图纸/蓝图数据）。
 * 判据保守：仅纯空话短语（无数字、无具体来源编号）命中；「按施工图结施-03 基础平面图」含具体编号
 * 不判（那是可追溯的来源表述）。
 */
const HOLLOW_TABLE_CELL_RE = /^(?:按(?:清单|设计|图纸|规范|方案|要求|合同|实际|甲方|业主)[^，。；]{0,14}|符合(?:设计|规范|标准|要求)[^，。；]{0,8}|根据(?:实际|现场)情况[^，。；]{0,10}|视(?:现场)?情况[^，。；]{0,10}|详见(?:图纸|设计|招标文件|清单)|相关(?:人员|部门|岗位)(?:及时)?[^，。；]{0,10}|及时(?:处理|整改|跟进|上报)|加强管理|严格控制|按需(?:配置|投入)|按实(?:计算|结算)|综合考虑|按有关规定)$/u;

export function hollowTableCellIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!markdown) return issues;
  const lines = markdown.split(/\r?\n/u);
  const findings = new Map<string, { tableIndex: number; column: string; count: number; samples: string[] }>();
  let tableIndex = 0;
  let header: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s*\|/.test(line)) { header = []; continue; }
    if (/^\s*\|[\s:|-]+\|\s*$/u.test(line)) { tableIndex += 1; continue; }
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
    if (header.length === 0) { header = cells; continue; }
    cells.forEach((cell, columnIndex) => {
      const column = header[columnIndex] || `第${columnIndex + 1}列`;
      // 4.55.22 用户口径：**空单元格同样不可接受**——原实现 `if (!cell ...) return` 直接跳过空值，
      // 于是「表格有空格」这类缺陷在门禁里完全不可见（实测：成稿虽为 0 处，但检测盲区是真实的）。
      if (!cell) {
        const key = `${tableIndex}\u0000${column}`;
        const entry = findings.get(key) || { tableIndex, column, count: 0, samples: [] };
        entry.count += 1;
        if (entry.samples.length < 3) entry.samples.push('（空单元格）');
        findings.set(key, entry);
        return;
      }
      if (/\d/u.test(cell)) return;
      if (!HOLLOW_TABLE_CELL_RE.test(cell)) return;
      const key = `${tableIndex}\u0000${column}`;
      const entry = findings.get(key) || { tableIndex, column, count: 0, samples: [] };
      entry.count += 1;
      if (entry.samples.length < 3) entry.samples.push(cell);
      findings.set(key, entry);
    });
  }
  for (const [key, finding] of findings) {
    void key;
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'table',
      owner: 'llm',
      repairability: 'llm_repairable',
      provenance: { detectorId: 'hollow-table-cell', fingerprint: stableHash(markdown) },
      message: `表格空话/空单元格：第 ${finding.tableIndex} 张表的「${finding.column}」列有 ${finding.count} 格无具体数据（如「${finding.samples.join('」「')}」）——每格必须有内容且有值，空单元格与「按…」式表述等价于留空`,
      suggestion: `请把该列的「按…」式表述替换为具体值：工程量列写清单原值（数值+单位，如 12792.800m3）；规格/尺寸/净距列写图纸或清单给出的具体数值；确实无该字段数据时写可追溯来源（如「按施工图结施-03」），不得用“按清单工程量/按设计标高”类表述搪塞。同类数据在同章正文中通常已存在，请直接引用同一口径。`,
    });
  }
  return issues;
}

/**
 * 进度计划超总工期检测（4.55.17 巢湖实测）：正文声明的计划工期与进度计划/节点的天序必须同口径。
 * 实测形态：招标 365 日历天、答疑澄清变更为 330 日历天，基本信息表与正文均写 330，而进度计划表按
 * 365 编排（起止天序排到第 348 天）——同文档两套工期，评标人一眼可见的重大失分。源头已修
 * （resolveEffectiveTotalDays 取变更后口径）；本检测为兜底：从正文提取声明工期（「N日历天」多数口径）
 * 与最大天序（「第X～Y天」「第N天」）比对，超出声明工期即报 blocker。
 * 阈值：允 2% 或 3 天的收尾余量（工序跨日取整），超出即判失配。
 */
export function scheduleDurationOverrunIssues(markdown: string, options: { toleranceDays?: number } = {}): ValidationIssue[] {
  if (!markdown) return [];
  // 4.55.22 根修盲区：原判据只认「N 日历天」。正文写「总工期330天」「计划工期 330 日」时
  // `declared` 为空 → 函数直接 `return []`（**无输入被读成"无问题"**），本门禁整体失效——
  // 而「两套工期」正是本函数存在的理由（巢湖实测）。单位族改为 日历天|天|日，
  // 且单位必须**紧随数值**（防「工期紧，30天完成」类无关句被误当声明工期）。
  const declared = [...markdown.matchAll(/(?:总工期|计划工期|合同工期|工期)[^。；;\n]{0,12}?(\d{2,4})\s*个?\s*(?:日历天|天|日)/gu)].map(match => Number(match[1])).filter(Number.isFinite);
  if (declared.length === 0) return [];
  // 声明工期取众数（正文多处声明同一口径）：众数缺失时取最小值（保守方）
  const counts = new Map<number, number>();
  for (const value of declared) counts.set(value, (counts.get(value) || 0) + 1);
  const effective = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]![0];
  if (!Number.isFinite(effective) || effective <= 0) return [];
  const spans: number[] = [];
  for (const match of markdown.matchAll(/第\s*(\d{1,4})\s*[～~—–-]\s*(\d{1,4})\s*天/gu)) spans.push(Number(match[2]));
  // 天序侧同样放宽：原需 3–4 位数字，「第45天」这类两位天序漏检（进度计划表按周排时常见）
  for (const match of markdown.matchAll(/(?:第|不迟于第|至第)\s*(\d{2,4})\s*天/gu)) spans.push(Number(match[1]));
  if (spans.length === 0) return [];
  const maxSpan = Math.max(...spans);
  const tolerance = Math.max(options.toleranceDays ?? 3, Math.round(effective * 0.02));
  if (maxSpan <= effective + tolerance) return [];
  return [{
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    provenance: { detectorId: 'schedule-duration-overrun', fingerprint: stableHash(markdown) },
    message: `进度计划超出声明工期：正文声明总工期 ${effective} 日历天，而进度计划/节点的天序排到第 ${maxSpan} 天（超出 ${maxSpan - effective} 天）——工期口径必须单一（招标工期经答疑澄清变更时以变更后为准）`,
    suggestion: `请统一工期口径：以答疑/澄清后的生效工期（${effective} 日历天）为唯一基准，重排进度计划表与各阶段节点的起止天序，使最大天序不超过 ${effective} 天（可留 ${tolerance} 天收尾余量）；正文任何位置的工期表述必须与此一致。`,
  }];
}

/**
 * 阶段用时内部自洽检测（4.55.25 实测新增）。
 *
 * **实测缺陷**（巢湖 4.55.24 自测终稿）：同一段文字里三个数字互相矛盾——
 * ①「施工准备…用时50天，基础工程阶段用时120天，主体结构…71天，装饰装修…123天，安装与收尾…26天」
 *   → 合计 **390 天**；② 同句自称「各阶段合计用时 **315 天**」；③ 全文声明总工期 **330 日历天**。
 * 390 ≠ 315 ≠ 330，且 390 > 330。**54 项阻断里没有任何一条提到它**——现有
 * `schedule-duration-overrun` 只看「第N天」天序，看不到「用时N天」的合计，故整类缺陷不可见。
 *
 * 判据（**同一文档内部即可证伪，无需外部权威**）：
 * ① 阶段用时合计 > 声明总工期 + 余量 → blocker；
 * ② 正文自称的「合计用时W天」与实际合计不等 → blocker；
 * ③ 同一表的「第N天」列（按行序）出现递减 → 时间倒挂 blocker（实测：装饰装修 第123天 早于
 *    主体结构 第166天）。
 */
export function stageScheduleConsistencyIssues(markdown: string): ValidationIssue[] {
  if (!markdown) return [];
  const issues: ValidationIssue[] = [];
  const declared = [...markdown.matchAll(/(?:总工期|计划工期|合同工期|工期)[^。；;\n]{0,12}?(\d{2,4})\s*个?\s*(?:日历天|天|日)/gu)].map(match => Number(match[1])).filter(Number.isFinite);
  const totalDays = declared.length > 0 ? Math.max(...declared) : undefined;
  // ① 阶段用时（表格「阶段用时」列优先；否则取正文「XX阶段用时N天」句式）
  const stageDurations: number[] = [];
  for (const match of markdown.matchAll(/[^|。；;\n]{0,16}?阶段用时\s*[:：]?\s*(\d{1,4})\s*天/gu)) stageDurations.push(Number(match[1]));
  // 表格路径：只统计**表头含「阶段用时」**的表块（防把「养护14天」等其它 N天 单元格误计入合计）
  {
    const rows = markdown.split('\n').map(line => line.trim());
    for (let index = 0; index < rows.length; index += 1) {
      const header = rows[index]!;
      if (!/^\|/.test(header) || !/阶段用时/u.test(header)) continue;
      const columnIndex = header.slice(1, -1).split('|').findIndex(cell => /阶段用时/u.test(cell));
      for (let cursor = index + 1; cursor < rows.length && /^\|/.test(rows[cursor]!); cursor += 1) {
        if (/^\|[\s:\-|]+\|$/u.test(rows[cursor]!)) continue;
        const cell = rows[cursor]!.slice(1, -1).split('|')[columnIndex] ?? '';
        const value = Number(/(\d{1,4})/u.exec(cell)?.[1]);
        if (Number.isFinite(value) && value > 0) stageDurations.push(value);
      }
      break;
    }
  }
  const sum = stageDurations.reduce((acc, value) => acc + value, 0);
  const tolerance = totalDays ? Math.max(3, Math.round(totalDays * 0.02)) : 3;
  if (totalDays && stageDurations.length >= 2 && sum > totalDays + tolerance) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      provenance: { detectorId: 'stage-schedule-consistency', fingerprint: stableHash(markdown) },
      message: `阶段用时合计超出总工期：各阶段用时 ${stageDurations.join('+')} = ${sum} 天，而声明总工期 ${totalDays} 日历天（超出 ${sum - totalDays} 天）——同文档内工期口径自相矛盾`,
      suggestion: `请以声明的总工期 ${totalDays} 日历天为唯一基准重排各阶段用时（含机动工期的分配），使各阶段用时合计不超过 ${totalDays} 天，并与进度计划表的起止天序逐项对应；不得在正文同时保留两套合计口径。`,
    });
  }
  // ② 自称合计 vs 实际合计
  const claimed = [...markdown.matchAll(/(?:各阶段)?合计用时\s*[:：]?\s*(\d{1,4})\s*天/gu)].map(match => Number(match[1])).filter(Number.isFinite);
  for (const value of claimed) {
    if (stageDurations.length >= 2 && value !== sum) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        provenance: { detectorId: 'stage-schedule-consistency', fingerprint: stableHash(markdown) },
        message: `阶段用时自相矛盾：正文自称「合计用时 ${value} 天」，而各阶段用时逐项相加为 ${sum} 天`,
        suggestion: `请统一为同一口径：按各阶段实际用时重算合计（或修正阶段用时），使「合计用时」与逐项相加一致，并与总工期对照。`,
      });
      break;
    }
  }
  // ③ 里程碑倒挂：同一表内「计划完成时间 / 第N天」列按行序须非递减
  const milestones: number[] = [];
  for (const match of markdown.matchAll(/\|\s*[^|\n]{1,24}?\s*\|\s*第\s*(\d{1,4})\s*天\s*\|/gu)) milestones.push(Number(match[1]));
  const firstDrop = milestones.findIndex((value, index) => index > 0 && value < milestones[index - 1]!);
  if (firstDrop > 0) {
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'fact_consistency',
      owner: 'llm',
      repairability: 'llm_repairable',
      provenance: { detectorId: 'stage-schedule-consistency', fingerprint: stableHash(markdown) },
      message: `阶段完成时间倒挂：表格中第 ${firstDrop + 1} 行的完成时间「第 ${milestones[firstDrop]} 天」早于上一行「第 ${milestones[firstDrop - 1]} 天」——按阶段推进顺序必须单调不减`,
      suggestion: '请按施工阶段推进顺序重排完成时间，后一阶段不得早于前一阶段结束；同一表的里程碑应单调递增并与进度计划表起止天序对应。',
    });
  }
  return issues;
}

/**
 * 单位族（形态驱动）：被取代值的**同族残留**检测用——正文写「365天」时，
 * 精确串「365日历天」比对不到，但同族单位（日历天/天）暴露它仍是工期口径。
 *
 * **每个族内必须长单位在前**（`endsWith` 与正则择一都取首个命中）：`mm` 在 `m` 前，
 * 否则「150mm」会被切成数值 150 + 单位 m，残留判据随之失真。
 * 覆盖面从「工期/金额」两族扩到「长度/重量」——原先 `5.85m→1.75m` 这类被取代值
 * 根本生成不出残留模式（`supersededResidueRe` 返回 undefined），等于不检查。
 */
const UNIT_FAMILIES: string[][] = [
  ['日历天', '天'],
  ['万元', '亿元', '元'],
  ['mm', 'cm', '米', 'm'],
  ['吨', 'kg', 'kN', 't'],
];

/** 被取代值的同族残留模式（数值边界 + 同族单位；用于「全文不应再有 365」类硬要求） */
function supersededResidueRe(superseded: string): RegExp | undefined {
  const text = String(superseded || '').replace(/\s+/gu, '');
  const family = UNIT_FAMILIES.find(units => units.some(unit => text.endsWith(unit)));
  if (!family) return undefined;
  const unit = family.find(candidate => text.endsWith(candidate))!;
  const core = text.slice(0, text.length - unit.length).replace(/,/gu, '');
  if (!/^\d+(?:\.\d+)?$/u.test(core)) return undefined;
  const units = family.map(candidate => escapeRegExpLiteral(candidate)).join('|');
  return new RegExp(`(?<![\\d.])${escapeRegExpLiteral(core)}\\s*(?:${units})`, 'u');
}

/**
 * 口径一致性终检（4.55.19 方案 §4）：真值层生效值 vs 正文声明口径。
 * 与写作硬约束（renderTruthConstraintBlock）同源——约束未被遵循时在此暴露，直进修复轮与人工清单。
 * 4.55.22 增加**被取代值残留**判据：只判「生效值是否落位」时，正文同时出现生效值与旧值
 * （如「总工期330日历天」+ 别处「365天」）会被判通过，而旧值仍是最显眼的口径冲突。
 *
 * **4.55.29 口径落位判据加形态闸**（巢湖实测 25 条 blocker 中 22 条的直接来源）：
 * 「落位」的判据是**正文逐字含该值**——这只有在值是**可逐字复现的规格型 token**
 * （measure/money/date/standard/spec）时才成立。真值层里同时存在大量**章节内容型属性**
 * （材料投入计划/质量控制点/施工方法工艺流程/机械设备计划…），它们的值是一段资料文字，
 * 是**写作素材**而非项目口径：要求正文逐字复现「机械设备计划 = 某清单行特征串」在语义上
 * 不可能成立，写手写不出、修复轮改不掉，产出永久消不掉的 blocker。
 * 判据用值形态单源判定（不预设属性白名单、不含任何项目数值）：
 * 只有规格型值参与逐字落位判定；段落型值（`text` 形态）不是口径，不入本判据。
 * 同源实现见 `authoritativeValues.caliberConsistencyIssues`（该处一直带此形态闸，本处此前缺失）。
 */
const CALIBER_VERBATIM_SHAPES: ReadonlySet<string> = new Set(['measure', 'money', 'date', 'standard', 'spec']);

export function caliberConsistencyIssues(markdown: string, ledger: Array<{ attribute: string; value: string; rule: string; evidence: Array<{ source: string }>; superseded?: string[]; caliber?: boolean }> = []): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!markdown || ledger.length === 0) return issues;
  const normalized = markdown.replace(/\s+/gu, '');
  for (const item of ledger) {
    // 4.55.29 只判**项目级口径**（`caliber !== false`）：本判据要求正文逐字复现该值，这只有在
    // 写手**被告知过**这个口径时才是正当的。真值层里绝大多数属性是**章节内容型**（底坑垫层做法/
    // 钢筋连接/主要材料包括/机械设备计划…），其值是写作素材而非口径；对它们要求逐字落位，
    // 等于用一个写手从未收到、也永不消解的约束产 blocker（巢湖最新实测 9 条中的 5 条）。
    // 口径集由原文口径标签抽取单源划定（`buildAuthoritativeValues` 的 labeledValues），读写同源。
    // 注意：本闸**只覆盖落位分支**——残留分支（下方 `item.superseded`）不得被它连带跳过：
    // 被取代值残留是「正文写了旧口径」，与写手有没有被告知过该属性无关，写手一律不得写旧值。
    const token = String(item.value || '').replace(/\s+/gu, '');
    if (item.caliber !== false
      && token.length >= 3 && CALIBER_VERBATIM_SHAPES.has(classifyValueShape(String(item.value || ''))) && !normalized.includes(token)) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        provenance: { detectorId: 'caliber-consistency', fingerprint: stableHash(markdown) },
        message: `口径不一致：「${item.attribute}」真值层生效值为「${item.value}」（裁决 ${item.rule}），正文未按该口径落位`,
        suggestion: `请将「${item.attribute}」统一为现行口径「${item.value}」（裁决依据：${item.evidence[0]?.source || '资料'}）；不得使用被取代的旧口径，也不得改用其他数值。`,
      });
    }
    // 被取代值残留：同族单位下的旧值（含去单位后的裸数字形态，如「365天」）不得作为现行口径出现
    const residues = (item.superseded || [])
      .map(superseded => ({ superseded, re: supersededResidueRe(superseded) }))
      .filter((entry): entry is { superseded: string; re: RegExp } => Boolean(entry.re));
    // 变更过程陈述豁免（与链尾确定性替换同口径）：「原为365日历天，经答疑澄清变更为330日历天」
    // 里出现旧值是**合法的**，不判残留——否则每次如实说明变更过程都会被判 blocker。
    // **豁免必须收敛到"明确把该值当旧值引用"**：原实现含裸「由」这个极常见字，
    // 「工期由发包人确定，总工期365日历天」会把旧值 365 豁免掉——正是本检测要拦的形态。
    // 现与 `applyOverridesToText` 的豁免同口径：`由` 必须与「变更/调整」共现才算变更叙述。
    const hasResidue = (re: RegExp) => {
      for (const match of normalized.matchAll(new RegExp(re.source, 'gu'))) {
        const offset = match.index ?? 0;
        const context = normalized.slice(Math.max(0, offset - 16), offset + match[0].length + 16);
        if (/原(?:为|值|内容|计划|合同|招标)|此前|变更过程/u.test(context)) continue;
        if (/由[^，。；]{0,12}(?:变更|调整)/u.test(context)) continue;
        return true;
      }
      return false;
    };
    const found = residues.filter(entry => hasResidue(entry.re));
    if (found.length > 0) {
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'fact_consistency',
        owner: 'llm',
        repairability: 'llm_repairable',
        provenance: { detectorId: 'caliber-consistency', fingerprint: stableHash(markdown) },
        message: `被取代口径残留：「${item.attribute}」现行值为「${item.value}」，正文仍出现被取代值 ${found.map(entry => `「${entry.superseded}」`).join('、')}（被取代值仅可在陈述变更过程时引用）`,
        suggestion: `请将正文中所有被取代值（${found.map(entry => entry.superseded).join('、')}）改为现行口径「${item.value}」；确需说明变更过程的，写成「原为 X，经答疑澄清变更为 Y」的形式，不得单独陈述旧值。`,
      });
    }
  }
  return issues;
}

/**
 * 危大工程「参数—判定绑定」检测（4.55.19 方案 §5）：危大分级结论必须挂**本项目实际参数**，
 * 不得只写规范阈值。实测缺陷：正文写「开挖深度超过 3m 的室外排水管道沟槽土方开挖工程」——
 * 3m 是判定阈值，而真值层里本项目基坑开挖深度 = 1.75m，正文 0 次。
 * 判据：含危大判定阈值（3m/5m/24m 等规范阈值表述）的句子，须同时出现**工程测量值**
 *（measure 形态、挂靠工程测量字段、且量值非被引阈值本身），否则判为"只抄规范、未落项目实参"。
 * 4.55.29 判据根修：
 * - 豁免不再只认真值层 token（真值层生效值与正文合理表述不同形时会把**合法写法判缺**，实测：
 *   「最大单跨跨度35.86m｜搭设跨度18m及以上属超过一定规模」被报"只写规范阈值"）；
 * - 「被引量值不在危大阈值表（单源 `HAZARD_THRESHOLDS`）里」⇒ 该量值本就是本项目控制值
 *   （实测「每层开挖深度不大于1.5m」），不属"照抄规范阈值"，不判；
 * - 值正确性（真值层生效值是否落位）由 caliber-consistency 负责，本条只判"有没有挂本项目实参"。
 * 反例守卫（不得放宽成不设防）：只引阈值、不挂本项目实参的句子照旧判缺——
 * 「开挖深度超过3m的…工程」（3 是 2.1.1 阈值）与「搭设高度超过24m区段」（24 是 2.4.1 阈值）。
 */
export function hazardParameterBindingIssues(markdown: string, truthValues: Array<{ attribute: string; value: string }> = []): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!markdown) return issues;
  const measureValues = truthValues
    .map(item => ({ attribute: item.attribute, token: String(item.value || '').replace(/\s+/gu, '') }))
    .filter(item => /\d/u.test(item.token) && item.token.length >= 3);
  // 只绑定**工程测量类**参数（深度/高度/跨度/重量/支护/层高）：无此类参数时不判（不误伤无参数项目）
  // 4.55.22：token 长度门槛放宽——原 `length >= 3` 会把「3m」这类**短但合法**的工程实参
  //（本项目唯一测量属性恰为短值时）整体丢掉，该项目的绑定门禁因此永不生效。
  // 现改为「含数字且（长度≥3 或 数字+单位形态）」。
  const relatedAttributes = measureValues
    .filter(item => /深度|高度|跨度|重量|支护|层高/u.test(item.attribute))
    .filter(item => item.token.length >= 3 || /\d\s*(?:m|米|mm|cm|t|吨|kg|kN|%)/u.test(item.token));
  // 4.55.22 根修盲区：真值层无工程测量类实参时，原实现 `return issues`（空）→ 整条门禁静默失效，
  // 只抄规范阈值、不落本项目实参的正文**完全不受检**。此时无法"判定"（没有可比对的实参），
  // 但可以也必须"报告"：正文出现危大阈值断言而无可绑定实参 = 该维度**未经核对**，显性告警不阻断。
  if (relatedAttributes.length === 0) {
    const thresholdProbe = /(?:开挖深度|搭设高度|支撑高度|吊装重量|跨度|基坑深度)[^。；]{0,14}?(?:超过|达到|不小于|大于)\s*\d+(?:\.\d+)?\s*(?:m|米|t|吨|kg)/u;
    if (thresholdProbe.test(markdown)) {
      return [{
        level: 'warning',
        severity: 'warning',
        category: 'fact_consistency',
        owner: 'system',
        repairability: 'manual_review',
        provenance: { detectorId: 'hazard-parameter-binding', fingerprint: stableHash(markdown) },
        message: '危大参数绑定未能核对：正文出现危大判定阈值表述，但真值层无「深度/高度/跨度/重量/支护/层高」类工程测量实参可比对——本项目是否以规范阈值充作项目实参，本次无法判定',
        suggestion: '请在资料中确认本项目实际测量参数（开挖深度/支撑高度/搭设高度/起吊重量等）并使其进入真值层，再重跑；本次该维度按未核对处理。',
      }];
    }
    return issues;
  }
  // ═══ 4.55.29 判据根修（巢湖实机成稿归因：**正确写法被判缺**）═══
  // 实测缺陷（`doc-1790104980418-d47a002e`）：正文写了
  // ①「最大单跨跨度35.86m｜搭设跨度18m及以上属超过一定规模」（本项目实参 35.86m + 阈值 18m + 结论，正是
  // 本条要求的**三要素**形态）、②「每层开挖深度不大于1.5m」（本项目控制实参）——两者都被判缺。
  // 两个判据缺陷：
  // (1) 豁免只认真值层 token（`relatedAttributes` 的 1.7m），与函数文档口径「同句须出现工程测量值
  //     （measure 形态、且非阈值本身）」不符：真值层生效值与正文合理表述不同形时，**合法写法被判缺**。
  //     值正确性另有其主（caliber-consistency 负责"真值层生效值未落位"），本条只判「有没有挂本项目实参」。
  // (2) 「大于」在「不大于/不超过」里命中 ⇒ 本项目控制值被读成规范阈值断言。
  // 现判据（**阈值单源，不硬编码任何数值**）：句子须出现「挂靠工程测量字段（深度/高度/跨度/重量）的
  // measure 实参且量值≠被引阈值」；若被引量值**根本不是危大阈值表里的量值**（如 1.5m），说明它本就是
  // 本项目控制值而非"规范阈值"，不判。
  const measureTokenRe = /(\d+(?:\.\d+)?)\s*(mm|cm|m|米|t|吨|kg|kN)/gu;
  const fieldBindingRe = /深度|高度|跨度|重量|起吊|吊装|开挖|搭设|支撑|基坑/u;
  const normalizeMeasure = (amount: number, unit: string): number => {
    if (unit === 'mm') return amount / 1000;
    if (unit === 'cm') return amount / 100;
    if (unit === 't' || unit === '吨') return amount * 9.8; // 重量与阈值表同口径（kN）
    if (unit === 'kg') return amount * 0.0098;
    return amount;
  };
  /** 危大阈值表的量值集合（单源：hazardBinding.HAZARD_THRESHOLDS；键 = 量纲:数值） */
  const specThresholds = new Set<string>();
  for (const group of Object.values(HAZARD_THRESHOLDS)) {
    for (const rule of [...group.hazardous, ...group.superHazardous]) {
      if (rule.value === undefined || !rule.dimension) continue;
      specThresholds.add(`${rule.dimension}:${rule.value}`);
    }
  }
  const dimensionOfField = (text: string): string | undefined => {
    const field = /(开挖深度|基坑深度|搭设高度|支撑高度|吊装重量|起吊重量|跨度)/u.exec(text)?.[1];
    if (!field) return undefined;
    if (/深度/u.test(field)) return '深度';
    if (/高度/u.test(field)) return '高度';
    if (/跨度/u.test(field)) return '跨度';
    return '重量';
  };
  /** 被引用的量值是否为**规范阈值表**里的量值（不是 → 本项目控制值，不属"照抄规范阈值"） */
  const isSpecificationThreshold = (fragment: string): boolean => {
    const dimension = dimensionOfField(fragment);
    const tail = /(\d+(?:\.\d+)?)\s*(mm|cm|m|米|t|吨|kg|kN)\s*$/u.exec(fragment);
    if (!dimension || !tail) return false;
    const normalized = normalizeMeasure(Number(tail[1]), tail[2]!);
    for (const key of specThresholds) {
      const [dim, raw] = key.split(':');
      if (dim !== dimension) continue;
      const target = Number(raw);
      if (Math.abs(normalized - target) <= Math.max(0.05, target * 0.03)) return true;
    }
    return false;
  };
  /** 句中的项目实参：measure 形态 + 挂靠危大工程测量字段 + 量值≠被引阈值本身 */
  const projectMeasureIn = (text: string, compared: string | undefined): string | undefined => {
    for (const match of text.matchAll(measureTokenRe)) {
      const start = match.index ?? 0;
      if (!fieldBindingRe.test(text.slice(Math.max(0, start - 8), start))) continue;
      const token = match[0].replace(/\s+/gu, '');
      if (compared && token === compared.replace(/\s+/gu, '')) continue;
      if (compared) {
        const comparedTail = /(\d+(?:\.\d+)?)\s*(mm|cm|m|米|t|吨|kg|kN)\s*$/u.exec(compared);
        if (comparedTail && Math.abs(normalizeMeasure(Number(match[1]), match[2]!) - normalizeMeasure(Number(comparedTail[1]), comparedTail[2]!)) <= 0.001) continue;
      }
      return token;
    }
    return undefined;
  };
  const samples: string[] = [];
  // 危大判定阈值句式（规范阈值，非项目实参）
  const thresholdRe = /(?:开挖深度|搭设高度|支撑高度|吊装重量|跨度|基坑深度)[^。；]{0,14}?(?:超过|达到|不小于|大于)\s*\d+(?:\.\d+)?\s*(?:mm|cm|m|米|t|吨|kg|kN)/gu;
  for (const match of markdown.matchAll(thresholdRe)) {
    const sentenceStart = Math.max(0, markdown.lastIndexOf('。', match.index ?? 0) + 1);
    const sentenceEnd = markdown.indexOf('。', (match.index ?? 0) + match[0].length);
    const sentence = markdown.slice(sentenceStart, sentenceEnd === -1 ? markdown.length : sentenceEnd + 1);
    // 同句须出现任一真值层工程实参（除被引用的阈值本身）
    const hasActual = relatedAttributes.some(item => sentence.replace(/\s+/gu, '').includes(item.token));
    if (hasActual) continue;
    // 同句/同片段已挂本项目实参（measure 形态、挂靠测量字段、量值非被引阈值）→ 已按三要素表述
    if (projectMeasureIn(sentence, match[0])) continue;
    // 被引量值不是危大阈值表里的量值（如「开挖深度不大于1.5m」的本项目控制值）→ 非规范阈值断言
    if (!isSpecificationThreshold(match[0])) continue;
    const threshold = match[0].replace(/\s+/gu, '');
    samples.push(threshold);
  }
  if (samples.length === 0) return issues;
  // 全文层面兜底：正文若从未落位任何"危大相关实参"（开挖深度/支护/高度类属性），同样判缺口。
  // 4.55.29：真值层 token 之外，**measure 形态且挂靠测量字段**的项目实参同样算已落位
  //（实测正文有「每层开挖深度不大于1.5m」却仍报「全文亦未出现…实参」）。
  const markdownCompact = markdown.replace(/\s+/gu, '');
  const hasBoundMeasure = (() => {
    for (const match of markdown.matchAll(measureTokenRe)) {
      const start = match.index ?? 0;
      if (fieldBindingRe.test(markdown.slice(Math.max(0, start - 8), start))) return true;
    }
    return false;
  })();
  const relatedPresent = relatedAttributes.some(item => markdownCompact.includes(item.token)) || hasBoundMeasure;
  issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    provenance: { detectorId: 'hazard-parameter-binding', fingerprint: stableHash(markdown) },
    message: `危大工程只写规范阈值、未落本项目实参：${samples.slice(0, 3).join('、')}${relatedPresent ? '' : '（全文亦未出现本项目开挖深度/支护/高度类实参）'}——危大分级必须写「本项目实际参数 + 判定阈值对照 + 结论」，不得只抄规范阈值`,
    suggestion: `请在危大工程判定处写明本项目实际参数并给出对照结论（如「本项目基坑开挖深度 ${relatedAttributes[0]?.token || '1.75m'}，对照《危险性较大的分部分项工程安全管理规定》3m 阈值判定为/不属于危大工程」）；参数取自资料原文，不得编造。`,
  });
  return issues;
}

/**
 * 蓝图权威值落位检测（4.55.20 巢湖终稿实测）：一体化蓝图裁决的项目参数（劳动力峰值、机械设备台数、
 * 里程碑节点天数）必须在正文写出**具体数值**——实测缺陷：正文 4 处「劳动力峰值按…控制/为口径锁定」
 * 全是免责式表述，蓝图裁决的峰值人数一次未落位（清洗器只统一了表述口径，没有落数值）。
 * 判据：蓝图有值 + 正文通篇未出现该数值 → blocker（与"参数义务"同族，但数据源是蓝图而非事实池）。
 */
export function blueprintValuePlacementIssues(markdown: string, blueprintData?: {
  resources?: { labor?: { peakValue?: number }; equipment?: Array<{ name: string; count?: number }> };
  milestones?: Array<{ label?: string; duration?: number }>;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!markdown || !blueprintData) return issues;
  const normalized = markdown.replace(/\s+/gu, '');
  const missing: string[] = [];
  // 4.55.22 根修盲区：原判据用 `normalized.includes(String(peak))` —— **裸数字子串**匹配，
  // 于是「劳动力峰值 45 人」会被 `45日历天`/`DN45`/`1450m³` 判为"已落位"（设备台数同理被
  // `11台`/`21台` 命中），本阻断器对最该拦的形态整体失效。改为**数值边界 + 量词**判据：
  // 数字前后不得紧邻数字/小数点，且（峰值）须带「人」或处于「峰值…N」语境。
  const hasNumberToken = (value: number, unit: string, requireUnit: boolean): boolean => {
    const token = String(value);
    const escaped = escapeRegExpLiteral(token);
    const unitAlt = unit ? escapeRegExpLiteral(unit) : '';
    const withUnit = unitAlt ? new RegExp(`(?<![\\d.])${escaped}\\s*${unitAlt}`, 'u') : undefined;
    if (withUnit?.test(normalized)) return true;
    if (requireUnit) return false;
    return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`, 'u').test(normalized);
  };
  const peak = blueprintData.resources?.labor?.peakValue;
  if (typeof peak === 'number' && peak > 0) {
    const token = String(peak);
    // 峰值必须落在「N 人」或「峰值…N」语境里，裸数字不算
    const hasPeak = hasNumberToken(peak, '人', true) || new RegExp(`峰值[^。；]{0,20}(?<![\\d.])${escapeRegExpLiteral(token)}(?![\\d.])`, 'u').test(normalized);
    if (!hasPeak) missing.push(`劳动力峰值 ${peak} 人`);
  }
  for (const item of (blueprintData.resources?.equipment || []).slice(0, 12)) {
    if (typeof item.count !== 'number' || item.count <= 0) continue;
    if (!hasNumberToken(item.count, '台', true)) missing.push(`${item.name} ${item.count} 台`);
  }
  if (missing.length === 0) return issues;
  issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'professional_chain',
    owner: 'llm',
    repairability: 'llm_repairable',
    provenance: { detectorId: 'blueprint-value-placement', fingerprint: stableHash(markdown) },
    message: `蓝图权威值未落位：${missing.slice(0, 6).join('、')}——资源配置类数值由系统蓝图统一裁决，正文必须以具体数值写出，不得以「按…控制/按部署确定」类表述代替`,
    suggestion: `请在对应章节（劳动力配置/机械设备配置）写明蓝图权威值：${missing.slice(0, 6).join('、')}；这些数值为系统裁决的唯一口径，不得自行推算另设、也不得只写控制原则。`,
  });
  return issues;
}

/**
 * 悬空连接词截断检测（4.55.20 巢湖终稿实测）：「…探明既有管线的平面位置和。」——句子以
 * 连接词/结构助词收尾且后无内容，属**语义截断**（衬砌丢了宾语），评标硬伤。
 * 与既有标点叠用类残片（fixTruncatedSentenceArtifacts）互补：那类改标点，本类缺成分。
 */
// 注意：不用「的/了」收尾（「…是必要的。」合法），只判并列连接词收尾；
// 窗口按**小句**计（允许逗号，从句末标点算起 18 字以上）
const DANGLING_CONJUNCTION_RE = /[^。；！？\n]{18,}?(?:以及|和|与|及|或|并)\s*[。；]/gu;

export function danglingConjunctionIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!markdown) return issues;
  const hits: string[] = [];
  for (const match of markdown.matchAll(DANGLING_CONJUNCTION_RE)) hits.push(match[0].trim());
  if (hits.length === 0) return issues;
  issues.push({
    level: 'error',
    severity: 'blocker',
    category: 'structure',
    owner: 'llm',
    repairability: 'llm_repairable',
    provenance: { detectorId: 'dangling-conjunction', fingerprint: stableHash(markdown) },
    message: `截断句（悬空连接词）：${hits.length} 处句子以连接词/助词收尾且无后续成分——如「${hits[0].slice(-30)}」`,
    suggestion: '请补全被截断的句子成分（宾语/并列项），或删除悬空连接词使句子完整；不得出现半截句。',
  });
  return issues;
}
