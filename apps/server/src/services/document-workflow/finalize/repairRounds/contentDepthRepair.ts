/**
 * repairRounds/contentDepthRepair：内容深度补写轮（检测→修复链缺口补齐，第二类系统性缺陷根治）。
 *
 * 背景（r8 实机终门禁 18 项阻断归因）：终检修复链覆盖的检测器集合 < 终检检测器集合——
 * 六类「内容欠产」检测器（critical-section-depth / emergency-section-depth /
 * construction-org-major-content / construction-org-division-section / precise-fact-usage /
 * overview-recap）产出 blocker 后无任何修复轮消费，裸奔直坠终门禁（复核清单）。
 * 本轮补齐该链路缺口（与 requirementResponseRepair 同模式的统一收口）：
 * 按 provenance.detectorId 精确过滤 + chapterId/sectionTitle/内容反查章级分组 → 定向补写。
 *
 * 定位通道（与检测端 F2 锚点同源，不依赖 message 文案解析）：
 * - critical-section-depth / construction-org-*：issue.chapterId 直连（检测端已打锚点）；
 * - emergency-section-depth：issue.sectionTitle 反查（小节标题在章正文逐字出现）；
 * - precise-fact-usage / parameter-obligation-usage（参数落位类）：缺失池重算（关键参数缺失池 +
 *   相关遗漏参数池并集，与检测端同源），按参数类别（规范编号/工期/面积/强度/管径）映射目标章
 *   （factLanding 映射表同族口径），同章 token 聚合单条 todo；
 * - overview-recap：overviewRecapCandidates + overviewRecapHit 反查复述句所在章（排除概况章本体）；
 * - boq-placement（清单落位类，C3-5）：未落位项惰性重算（buildBoqRowTraces 行识别/豁免/落位判定
 *   单源）→ unique 名称聚合 → 责任章映射（assignBillRowChapter 单源，与检测端消息标注/写作任务
 *   清单同源），同章聚合待补清单项载荷（名称+工程量+建议小节）单条 todo。
 *
 * 复检（同源零嵌入，回滚保护）：修复后对章内容重跑对应检测器（critical/construction-org/emergency
 * 确定性 + 语义同源；precise-fact-usage / parameter-obligation-usage 用字面 token 口径；
 * boq-placement 用字面三通道口径（boqItemCarriedInText 单源）；overview-recap 用复述判定）。
 * 收敛修复（蓝本同构）：每章最多 2 轮，残留数下降才继续下一轮；外层最多 2 周期（补写后 recompute
 * 语义重算新滑移出的残留再消费一轮）；修复落地后 rebuildFinalMarkdown + recomputeFinalValidationBundle。
 *
 * D-T1 扩展（第七类消费：专业评分不足强制补写链）：professional-score 报出线统一 8/12 后，
 * <8/12 的章（warning 级）按 provenance 精确过滤同轮消费——chapterId 直连定位 + 六维分数实时
 * 重算（professionalDepthTotal 单源口径）复检，薄弱维度随任务卡要求注入补写指令；补写预算单列
 *（每章轮上限 + 单周期章数上限，防超预算），独立于六类 blocker 的每章 2 轮收敛框架。
 *
 * C3-5 扩展（第八类消费：清单落位不足补写链）：boq-placement error（severity blocker，C3-5-2 已打
 * provenance）按 provenance 精确过滤同轮消费——未落位项重算 → 责任章映射 → 逐章载荷定向补写
 *（逐项在正文最相关专业小节写入条目名称与工程量），修历史挂靠缺口：17 轮修复无一消费直坠终门禁。
 */
import { repairOutcomeReason, repairOutcomeStatus } from './repairOutcome';
import { buildChapterBudgetLedger, chapterOverflowAfterRound, recordChapterBudgetMetric, renderChapterBudgetInstruction, renderChapterOverflowNote, renderDocumentBudgetSummary } from './chapterBudgetLedger';
import { displayStage, upsertProgressStage } from '../../progress';
import { recordRepairActions, repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { divisionSectionDeficitCount, majorContentDeficitCount } from '../../constructionOrgQualityRules';
import { normalizeEngineeringTextForFactMatch } from '../../engineeringUnits';
import { emergencySectionDepthIssues } from '../../emergencySectionDepth';
import { missingCriticalPreciseTokens, professionalDepthTotal, professionalScoreTargetLine, professionalWeakDimensions, PROFESSIONAL_SCORE_LINE } from '../../qualityValidation';
import type { DepthDimension } from '../../professionalDepthClassifier';
import { assignMissingParameterChapters } from '../../chapterParameterFacts';
import { assignBillRowChapter, chapterRelevanceTokens } from '../../billFactLock';
import { drawingFactPlacement, normalizeDrawingMatchText } from '../../drawingFactLock';
import { boqItemCarriedInText, buildBoqRowTraces, normalizeBoqMatchText } from '../../documentFactTrace';
import { overviewRecapCandidates, overviewRecapHit } from '../../integrity/detectors/detectors';
import { criticalSectionDeficitTotal } from '../rebuildAndRecompute';
import type { BoqRowTrace, DocumentDraftChapter, ValidationIssue } from '../../types';
import type { ChapterBudgetEntry } from './chapterBudgetLedger';
import type { FinalizeSession } from '../finalizeSession';

/** 本轮的消费集合（修复链覆盖缺口的六类内容深度检测器 + C3-4 参数义务独立门禁 + C3-5 清单落位门禁，
 * 与检测端 provenance.detectorId 严格同名） */
const CONTENT_DEPTH_DETECTOR_IDS: ReadonlySet<string> = new Set([
  'critical-section-depth',
  'emergency-section-depth',
  'construction-org-major-content',
  'construction-org-division-section',
  'precise-fact-usage',
  'parameter-obligation-usage',
  'boq-placement',
  'overview-recap',
]);

/** 参数落位类检测器（C3-4 解挂靠）：关键参数抽查（precise-fact-usage）与可靠参数义务
 * （parameter-obligation-usage）同池同指令载荷（pendingTokens 残差口径一致）——首个命中者承载
 * 全量分配（缺口并集 = 关键参数缺失池 + 相关遗漏参数池去重），义务缺口不再挂靠关键参数 blocker */
const PARAMETER_TOKEN_DETECTOR_IDS: ReadonlySet<string> = new Set(['precise-fact-usage', 'parameter-obligation-usage']);

/**
 * 收敛修复轮：**停机条件是「达标线」，不是「轮次上限」**（G 线 P2-5）。
 *
 * 原值 2 是**质量上限**语义：只要还有下降空间、每章补到第 2 轮就被硬砍，残留直接甩给终门禁。
 * 现改为**预算上限**语义——停止由收敛判定决定（残留清零即达标停止；不再下降/回滚即无进展停止），
 * 本常量只兜住「一直下降但迟迟不达标」的最坏情况，防单章无限烧 LLM。
 * 注意：每轮 = 每章一次 LLM 调用，故本值直接乘算修复链的 LLM 成本（2→4 即最坏翻倍）；
 * 之所以仍以「严格下降才继续」为闸，是因为修复链补不进新材料（无知识库通道），
 * 只靠改写/删除收敛——无下降就继续，只会烧钱并把正文越改越薄。
 */
const MAX_CONTENT_DEPTH_REPAIR_ROUNDS = 4;

/**
 * 外层收敛周期的**安全上限**（G 线 上限治理）——不是质量上限。
 *
 * 原值 2 是**质量上限**语义：`scored.slice(0, 4)` 每周期只补最薄弱的 4 章、
 * 图纸落位每周期 8 章，而周期只有 2 ⇒ 20 章的文档里**只有 8 章**拿得到专业分补写机会，
 * 其余章无论多差都永不修复。把上限从 2 调大只是挪动悬崖（与参数分配的 6/24→16/96 同型错误），
 * 故改为**达标驱动**：循环持续到目标集清空或不再下降（与 P2-5 同口径），
 * 本常量仅兜住「一直下降但迟迟不收敛」的最坏情况，防单次生成无限烧 LLM。
 *
 * 每次循环 = 每目标章一次 LLM 调用，故本值直接乘算成本；之所以仍以「严格下降才继续」为闸，
 * 是因为修复链补不进新材料，无下降就继续只会烧钱并把正文越改越薄。
 */
const MAX_CONTENT_DEPTH_REPAIR_CYCLES = 8;

/** D-T1 专业评分补写预算（单列，防超预算——独立于六类内容深度补写的每章 2 轮收敛框架）：
 * 单周期最多补写章数（按实时评分升序取最薄弱章优先）与每章专业补写轮上限 */
const MAX_PROFESSIONAL_SCORE_REPAIR_CHAPTERS = 4;
const MAX_PROFESSIONAL_SCORE_REPAIR_ROUNDS = 1;

/** C3-5 未落位清单项待补载荷：条目名 + 同族行数 + 工程量（含单位）+ 建议落位小节 */
interface BoqPendingItem {
  name: string;
  code: string;
  rows: number;
  quantity: string;
  section?: string;
}

/** C3-5 补写指令逐项渲染上限（超出仅列名：s28l 实测单章最多 130 项 unique，全量逐项渲染会挤压
 * 其余类别指令与模型注意力；列名仍保留补写义务，与 renderBillChapterTaskLines 溢出口径同族） */
const MAX_BOQ_PENDING_ITEMS_IN_INSTRUCTION = 120;

/** C3-6-4 图纸未落位补写预算（单列，防超预算——与专业评分同模式）：
 * 单周期最多补写章数（按未落位图纸数降序取最缺口章优先）与每章图纸补写轮上限 */
const MAX_DRAWING_REFERENCE_REPAIR_CHAPTERS = 8;
const MAX_DRAWING_REFERENCE_REPAIR_ROUNDS = 1;

/** C3-6-4 每章指令随载荷携带的图纸份数上限（超出仅列名：防指令膨胀挤压其余类别缺口） */
const MAX_DRAWING_PENDING_ITEMS_IN_INSTRUCTION = 12;

/** C3-6-4 单份图纸随指令携带的参考事实行条数（本章相关性素材；过多挤压指令预算） */
const DRAWING_PENDING_LINES_PER_ITEM = 3;

/** C3-6-4 未落位图纸定向补写载荷：图纸名 + 判定 token 全集（复检用，与检测端同源）+ 参考事实行 */
interface DrawingPendingItem {
  name: string;
  tokens: string[];
  lines: string[];
}

/** 章级待办项：一条深度类 blocker 的修复素材（按检测器类别承载不同定位载荷） */
interface ChapterTodo {
  detectorId: string;
  issue: ValidationIssue;
  /** precise-fact-usage：本章负责补齐的关键参数 token 列表 */
  pendingTokens?: string[];
  /** overview-recap：本章须删除/改写的复述句 */
  pendingSentences?: string[];
  /** professional-score：本章须定向补写的六维薄弱维度（D-T1，任务卡要求随指令注入） */
  weakDimensions?: DepthDimension[];
  /** boq-placement：本章负责补齐的未落位清单项（C3-5，名称+工程量写入正文的定向补写载荷） */
  pendingBoqItems?: BoqPendingItem[];
  /** drawing-reference：本章负责补齐的未落位图纸（C3-6-4，图纸名+参考事实行写入正文的定向补写载荷） */
  pendingDrawings?: DrawingPendingItem[];
}

/** D-T1 六维薄弱维度 → 任务卡驱动补写要求（与 professionalDepthClassifier 六维锚点语义同族；
 * 方案任务卡要素：资料依据/实施流程/专业控制点/检查整改闭环/资源进场调配/项目特异性） */
const DEPTH_DIMENSION_REQUIREMENTS: Record<DepthDimension, string> = {
  factuality: '资料依据：引用绑定资料、清单与图纸中的具体数值和工程事实，数据口径与绑定资料一致',
  structure: '实施流程：按施工准备、工艺流程、施工方法、验收标准的顺序组织，写出工序步骤与衔接关系',
  depth: '专业控制点：写出关键工序控制点、工艺参数、隐蔽工程验收与检验批划分',
  executable: '可执行性：明确责任主体、检查频次、记录台账与资源进场调配安排',
  specificity: '项目特异性：结合本项目建设地点、工程规模与计划工期展开，引用本项目工程量数据',
  consistency: '跨章一致性：工期、质量、安全数据口径与总进度计划和质量目标相互呼应',
};

/** 参数 token → 目标章匹配表（factLanding 同族口径：类别关键词映射章标题关键词） */
const PRECISE_TOKEN_CHAPTER_MATCHERS: Array<[RegExp, RegExp]> = [
  [/GB|JGJ|CJJ|DB|ISO/u, /依据|规范|标准|编制/u],
  [/日历天|个月|天$/u, /工期|进度|部署|流水/u],
  [/㎡|m²/u, /概况|施工方法|主要施工|方案|内容/u],
  [/m3|m³/u, /概况|施工方法|主要施工|方案|内容/u],
  [/MPa|kPa|kN/u, /质量|材料|施工方法|主要施工|方案/u],
  [/DN|φ|Φ/u, /管网|给排水|安装|施工方法|主要施工/u],
];

/** 参数落位回退章（逐 token 无匹配章时的默认承载章；r9 #12 实机归因：章集无「依据/规范/标准」
 * 类标题时规范编号类 token 无章归属 → 修复轮零消费，GB 编号永远补不进正文直坠终门禁）：
 * 编制依据/规范类章优先（规范编号的自然落点）→ 概况/总述类 → 首章兜底，保证逐 token 有归属 */
function promptChapterFallbackIndex(chapters: DocumentDraftChapter[]): number {
  if (chapters.length === 0) return -1;
  const preferred = chapters.findIndex(chapter => /编制依据|依据|规范|标准|编制/u.test(chapter.title));
  if (preferred >= 0) return preferred;
  const overview = chapters.findIndex(chapter => /概况|概述|总述|总体|部署|工程/u.test(chapter.title));
  return overview >= 0 ? overview : 0;
}

/** token 使用判定（与检测端 preciseFactUsageIssues / missingCriticalPreciseTokens 同源归一化口径） */
function tokenMissingFrom(content: string, token: string): boolean {
  return !normalizeEngineeringTextForFactMatch(content).includes(normalizeEngineeringTextForFactMatch(token));
}

/** 复述句起点封闭集（与 overviewRecapCandidates 同源词面） */
const RECAP_OPENING_RE = /本项目为|本工程为|该项目为|该工程为/u;

const normalizedFor = (text: string) => text.replace(/\s+/gu, '');

/** blocker 过滤单源（周期循环每轮以最新 validationIssues 为准） */
function contentDepthBlockers(session: FinalizeSession): ValidationIssue[] {
  return session.validationIssues.filter(issue => issue.severity === 'blocker' && issue.provenance && CONTENT_DEPTH_DETECTOR_IDS.has(issue.provenance.detectorId));
}

/**
 * 4.56 2-b 章预算账查表：本轮补写的额度约束 + 落地后超额观测的同一分母来源。
 *
 * `content` 传「本章实时正文」——修复轮内上一轮已改写过章正文，账本必须按实时字数结算，
 * 否则剩余额度是过期分母（额度虚高 → 指令失效）。预算表缺失时由账本内
 * `resolveChapterBudgetTarget` 显式折算（不静默落硬编码），兜底说明不在此上屏（写作侧已上屏一次）。
 */
function chapterBudgetEntryFor(session: FinalizeSession, chapterIndex: number, content: string): ChapterBudgetEntry | undefined {
  const chapters = session.finalChapterDrafts;
  if (!chapters[chapterIndex]) return undefined;
  const ledger = buildChapterBudgetLedger({
    chapterTargets: session.documentBudget?.chapterTargets,
    chapters: chapters.map((chapter, index) => (index === chapterIndex ? { ...chapter, content } : chapter)),
    documentTargetChars: session.documentBudget?.targetChars,
  });
  return ledger.chapters[chapterIndex];
}

/**
 * D-T1 专业评分不足（<8/12）目标章收集：provenance 精确过滤（warning 级，非 blocker）→ 逐章
 * analyze 实时重算六维分数（与检测端单源口径）→ 快照过期已达线章剔除 → 分数升序取最薄弱章 →
 * 预算截断（单周期章数上限）。返回 issue + 章 id + 薄弱维度（任务卡指令载荷）。
 */
async function professionalScoreTargets(session: FinalizeSession, attempted: Set<string> = new Set()): Promise<Array<{ issue: ValidationIssue; chapterId: string; weakDimensions: DepthDimension[] }>> {
  const warnings = session.validationIssues.filter(issue => issue.provenance?.detectorId === 'professional-score' && issue.chapterId);
  if (warnings.length === 0) return [];
  const scored: Array<{ issue: ValidationIssue; chapterId: string; total: number; weakDimensions: DepthDimension[] }> = [];
  const seen = new Set<string>();
  for (const issue of warnings) {
    const chapterId = issue.chapterId;
    if (!chapterId || seen.has(chapterId)) continue;
    seen.add(chapterId);
    const draft = session.finalChapterDrafts.find(chapter => chapter.id === chapterId);
    if (!draft) continue;
    const analysis = await session.professionalDepthClassifier.analyze(draft.content);
    if (!analysis) continue;
    const total = professionalDepthTotal(analysis.dimensions);
    // 靶线按章判定（资源类章 ≥10/12，其余 ≥8/12；与检测端 professionalScoreTargetLine 单源）
    if (total >= professionalScoreTargetLine(draft.title)) continue;
    scored.push({ issue, chapterId, total, weakDimensions: professionalWeakDimensions(analysis.dimensions) });
  }
  scored.sort((left, right) => left.total - right.total);
  // 饥饿防护（上限治理）：原实现每周期重新 `slice(0,4)` 取最薄弱 4 章 —— 若这 4 章补写回滚/未生效
  //（分数不升），下周期仍按同样排序取到**同样 4 章**，第 5 章起**永远拿不到补写机会**。
  // 现口径：优先取「本批次尚未尝试过」的章（比分切片更公平），全部尝试过后再回落到从头重试
  //（避免已尝试但未改善的章被永久放弃）。
  const fresh = scored.filter(item => !attempted.has(item.chapterId));
  const ordered = fresh.length > 0 ? fresh : scored;
  const picked = ordered.slice(0, MAX_PROFESSIONAL_SCORE_REPAIR_CHAPTERS);
  for (const item of picked) attempted.add(item.chapterId);
  return picked;
}

const blockerCount = (issues: ValidationIssue[]) => issues.filter(issue => issue.severity === 'blocker').length;

/** 概况判定上下文（overview-recap 复检基准；概况区不在本轮改写范围内，循环外计算一次）：
 * han = 概况区正文汉字串（overviewRecapHit 判定基准）；bodySentences = 概况区句子归一化集合
 * ——r11 定位放开后（复述句反查不再排除「工程概况」章），章内概况本体句不得计入复述残差，
 * 否则「复述句已删、本体句残留」造成残差恒 >0 的假未收敛与反复修复 */
interface OverviewContext {
  han: string;
  bodySentences: Set<string>;
}

function overviewContextOf(session: FinalizeSession): OverviewContext {
  const { overviewBody } = overviewRecapCandidates(session.finalMarkdown);
  const han = (overviewBody.match(/[\p{Script=Han}]/gu) || []).join('');
  const bodySentences = new Set<string>();
  for (const line of overviewBody.split('\n')) {
    for (const part of line.split(/[。！？!?]/u)) {
      const sentence = part.trim().replace(/\s+/gu, '');
      if (sentence.length >= 12) bodySentences.add(sentence);
    }
  }
  return { han, bodySentences };
}

/** 章内复述句计数（与 overviewRecapIssues 判定同源：起点词面 + overviewRecapHit 字符级判定；
 * 概况区本体句集合显式豁免——本体句与复述句同源词面时残差计数不得计入） */
function countRecapSentences(content: string, overview: OverviewContext): number {
  if (!overview.han) return 0;
  let count = 0;
  for (const line of content.split('\n')) {
    const hit = RECAP_OPENING_RE.exec(line);
    if (!hit) continue;
    const sentence = line.slice(hit.index).split(/[。！？!?]/u)[0];
    if (!sentence || sentence.length < 12) continue;
    if (overview.bodySentences.has(sentence.replace(/\s+/gu, ''))) continue;
    if (overviewRecapHit(sentence, overview.han)) count += 1;
  }
  return count;
}

/** 单检测器类残差（章内容口径，与检测端同源函数/同源判定；
 *  critical/construction-org/emergency 直接重跑检测器，precise-fact-usage 用字面 token 口径，
 *  overview-recap 用复述判定——均为本章内容可隔离量） */
async function chapterClassResidual(session: FinalizeSession, chapterIndex: number, detectorId: string, content: string, overview: OverviewContext, pendingTokens: string[], pendingBoqItems: BoqPendingItem[] = [], pendingDrawings: DrawingPendingItem[] = []): Promise<number> {
  const probe: DocumentDraftChapter = { ...session.finalChapterDrafts[chapterIndex], content };
  switch (detectorId) {
    case 'critical-section-depth':
      // 残差细分为字数缺口量化（r16c 丰乐镇实机归因）：聚合条数口径下 1191→1749 字的实质补写
      //（仍差 11 字未过 blocker 线）被判「未下降」→ 修复轮提前停止；字数缺口口径下每补 1 字残差即降
      return criticalSectionDeficitTotal([probe]);
    case 'construction-org-major-content':
      // 残差细分为缺陷项数求和（同轮归因：3 块要素不全→2 块修复真实发生但聚合条数不变）；
      // 与检测器同源扫描（majorContentDeficitCount 单源），任一实项修复即残差下降
      return majorContentDeficitCount([probe]);
    case 'construction-org-division-section':
      // 残差细分口径（r9 实机 #10/#11 机制归因）：聚合 blockerCount 下「3 个要素不全 + 9 个参数不足」恒为 2——
      // LLM 部分修复（如 9→8）残差不变 → 恒判「未下降」回滚丢弃全部进度 → 阻断直坠终门禁；
      // 改逐分项缺陷项数求和（与检测器同源扫描，divisionSectionDeficitCount 单源），任一实项修复即残差下降
      return divisionSectionDeficitCount([probe]);
    case 'emergency-section-depth':
      return blockerCount(await emergencySectionDepthIssues(probe.content));
    case 'precise-fact-usage':
    case 'parameter-obligation-usage': {
      // 归一化字面口径（与检测端同源）：单位/全角/破折号双端归一，残留判定与修复落地同尺度；
      // 义务门禁与关键参数抽查同池同载荷（pendingTokens 并集），残差口径一致
      return pendingTokens.filter(token => tokenMissingFrom(content, token)).length;
    }
    case 'boq-placement': {
      // C3-5 复检：本章负责的清单项仍未在本章正文显性出现（三通道字面口径与检测端单源同判）者计数；
      // 章内口径比检测端全文档口径更严（要求落在责任章），补写落点即残差下降
      const normalizedContent = normalizeBoqMatchText(content);
      return pendingBoqItems.filter(item => !boqItemCarriedInText(normalizedContent, item.name, item.code)).length;
    }
    case 'drawing-reference': {
      // C3-6-4 复检：本章负责的未落位图纸仍未在本章正文出现（任一判定 token 命中即已引用，
      // 归一化与检测端 drawingFactPlacement 共源 normalizeDrawingMatchText）者计数；
      // 章内口径要求落在分配章（分配=事实行相关性 argmax 章），补写落点即残差下降
      const normalizedContent = normalizeDrawingMatchText(content);
      return pendingDrawings.filter(item => !item.tokens.some(token => normalizedContent.includes(token))).length;
    }
    case 'overview-recap':
      return countRecapSentences(content, overview);
    case 'professional-score': {
      // D-T1 复检：重算六维语义评分（professionalDepthTotal 单源口径），残差=章级靶线缺口
      //（分数上升即残差下降，与其余类同一收敛框架；无内容可分析=零残差跳过）
      const analysis = await session.professionalDepthClassifier.analyze(content);
      if (!analysis) return 0;
      const line = professionalScoreTargetLine(session.finalChapterDrafts[chapterIndex].title);
      return Math.max(0, line - professionalDepthTotal(analysis.dimensions));
    }
    default:
      return 0;
  }
}

/** 章级总残差（todos 涉及的检测器类去重后逐类计数求和） */
async function chapterResidual(session: FinalizeSession, chapterIndex: number, todos: ChapterTodo[], content: string, overview: OverviewContext): Promise<number> {
  const resolved = new Map<string, number>();
  for (const todo of todos) {
    if (resolved.has(todo.detectorId)) continue;
    const pendingTokens = todos.filter(item => PARAMETER_TOKEN_DETECTOR_IDS.has(item.detectorId)).flatMap(item => item.pendingTokens ?? []);
    const pendingBoqItems = todos.filter(item => item.detectorId === 'boq-placement').flatMap(item => item.pendingBoqItems ?? []);
    const pendingDrawings = todos.filter(item => item.detectorId === 'drawing-reference').flatMap(item => item.pendingDrawings ?? []);
    resolved.set(todo.detectorId, await chapterClassResidual(session, chapterIndex, todo.detectorId, content, overview, pendingTokens, pendingBoqItems, pendingDrawings));
  }
  let total = 0;
  for (const value of resolved.values()) total += value;
  return total;
}

/** 定向补写指令：逐条缺陷原文 + 类别定制补写要求 + 局部修改约束（反条幅、禁编造） */
function instructionFor(draftChapter: DocumentDraftChapter, todos: ChapterTodo[], round: number, roundCap: number, budgetEntry?: ChapterBudgetEntry): string {
  const lines: string[] = [
    '【内容深度定向补写修复】',
    ...(round > 1 ? [`本轮为第 ${round} 轮（最多 ${roundCap} 轮）：上一轮补写后复检仍有残留，请针对下列缺口严格补足。`] : []),
    `下列内容深度类验收缺陷是《${draftChapter.title}》导出前的阻断项，请逐条定向修复：`,
    '1. 补写内容必须落到绑定资料/清单/图纸中的具体数值与工程事实，保持原始数值与单位，不得编造参数、不得空泛套话；',
    '2. 只做局部修改：优先在对应小节内扩写补实，或在最合适的位置并入补写段落；不得新增、删除或合并小节，不得改动无关内容；',
    '3. 禁止「按招标文件要求：」类条幅前缀与任何元话语，必须是正式施组正文行文。',
    // 4.56 2-b：补写轮的章预算上下文（本轮新增内容的额度约束）。缺失预算条目时不渲染该段
    //（宁可无约束，也不假造分母——resolveChapterBudgetTarget 已在账本内显式兜底并回传说明）。
    ...(budgetEntry ? [renderChapterBudgetInstruction(budgetEntry)] : []),
  ];
  for (const todo of todos) {
    const head = `- [${todo.detectorId}] ${todo.issue.message}`;
    const advice = todo.issue.suggestion ? `（补充要求：${todo.issue.suggestion}）` : '';
    lines.push(`${head}${advice}`);
    if (todo.weakDimensions && todo.weakDimensions.length > 0) {
      lines.push(`  本章专业深度评分薄弱维度定向补写（按序落实）：${todo.weakDimensions.map(dimension => DEPTH_DIMENSION_REQUIREMENTS[dimension]).join('；')}。`);
    }
    if (todo.pendingTokens && todo.pendingTokens.length > 0) {
      lines.push(`  本章负责补齐的关键工程参数：${todo.pendingTokens.join('、')}。请自然写入本章对应位置，必须逐字保留原文形态（数字、单位、编号中的连字符与年份不得改写、拆写或省略）；规范编号无法确认规范名称时只写编号并表述为现行国家（行业）标准，不得编造规范名称。`);
    }
    if (todo.pendingBoqItems && todo.pendingBoqItems.length > 0) {
      const shown = todo.pendingBoqItems.slice(0, MAX_BOQ_PENDING_ITEMS_IN_INSTRUCTION);
      lines.push(`  本章负责补齐的未落位清单项（逐项在正文最相关的专业小节写入条目名称与工程量，保持清单原文数值与单位）：${shown.map(item => `${item.name}${item.quantity ? ` ${item.quantity}` : ''}${item.rows > 1 ? `（同族${item.rows}行）` : ''}${item.section ? `［建议小节：${item.section}］` : ''}`).join('；')}。`);
      const overflow = todo.pendingBoqItems.slice(MAX_BOQ_PENDING_ITEMS_IN_INSTRUCTION);
      if (overflow.length > 0) {
        // 上限治理：**全量列名**（原 `overflow.slice(0, 40)` 让第 161 项起连名字都不出现，
        // 补写义务彻底消失）。名字是补写义务的最小载体，压缩它可以，丢弃它不行——
        // 详细渲染（名称+工程量+建议小节）仍受 `MAX_BOQ_PENDING_ITEMS_IN_INSTRUCTION` 的预算约束。
        lines.push(`  另需覆盖（仅列名，共${overflow.length}项，按上述同一口径逐项补齐）：${overflow.map(item => item.name).join('、')}。`);
      }
    }
    if (todo.pendingSentences && todo.pendingSentences.length > 0) {
      lines.push(`  下列句段属概况复述，须删除或改写为本章内容（可保留必要的具体数字引用，不得整段复述概况）：${todo.pendingSentences.map(sentence => `“${sentence.slice(0, 60)}”`).join('；')}`);
    }
    if (todo.pendingDrawings && todo.pendingDrawings.length > 0) {
      // C3-6-4 图纸未落位补写：逐份在正文写入图纸名称 + 规格/做法事实（逐字照抄参考事实行关键值），
      // 落位判定以事实 token 命中为准（检测端 drawingFactPlacement 单源口径）
      const shown = todo.pendingDrawings.slice(0, MAX_DRAWING_PENDING_ITEMS_IN_INSTRUCTION);
      lines.push(`  本章负责补齐的未落位图纸事实（逐份在正文最相关的专业小节写入图纸名称及其规格/构造做法，数值、材料代号与规格逐字照抄原文，不得改写或省略）：${shown.map(item => `${item.name}${item.lines.length > 0 ? `［参考事实行：${item.lines.join('；')}］` : ''}`).join('；')}。`);
      const overflow = todo.pendingDrawings.slice(MAX_DRAWING_PENDING_ITEMS_IN_INSTRUCTION);
      if (overflow.length > 0) {
        // 同上：图纸名全量列出（原 slice(0,40) 让第 53 份起完全不出现在指令中）
        lines.push(`  另需覆盖（仅列名，共${overflow.length}份，按上述同一口径逐份在相关小节补齐）：${overflow.map(item => item.name).join('、')}。`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * C3-5 未落位清单项分配（惰性：仅当确有 boq-placement blocker 时重算一次）：与检测端单源——
 * buildBoqRowTraces（行识别/豁免/落位判定唯一实现）过滤有效未落位行 → unique 名称聚合行数与样本
 * → assignBillRowChapter 映射责任章（与检测端消息标注、写作任务清单同源）→ 章索引（标题精确相等；
 * 映射失败回退方法章，与 BILL_METHOD_CHAPTER_RE 同族）。返回 [章索引, 待补载荷]。
 */
function boqPlacementAssignments(session: FinalizeSession): Map<number, BoqPendingItem[]> {
  const result = new Map<number, BoqPendingItem[]>();
  const chapters = session.finalChapterDrafts;
  if (chapters.length === 0) return result;
  const remaining = buildBoqRowTraces(session.finalMarkdown, session.factsModel)
    .filter(trace => !trace.exempt && !trace.placed && trace.itemName.trim());
  if (remaining.length === 0) return result;
  const groups = new Map<string, { name: string; code: string; rows: number; sample: BoqRowTrace }>();
  for (const trace of remaining) {
    const key = trace.itemName.slice(0, 40);
    const group = groups.get(key);
    if (group) group.rows += 1;
    else groups.set(key, { name: trace.itemName, code: trace.itemCode, rows: 1, sample: trace });
  }
  for (const group of [...groups.values()].sort((left, right) => right.rows - left.rows)) {
    const assignment = assignBillRowChapter({ name: group.name, description: group.sample.description || '' }, chapters);
    const mapped = assignment ? chapters.findIndex(chapter => chapter.title === assignment.chapterTitle) : -1;
    const index = mapped >= 0 ? mapped : chapters.findIndex(chapter => /主要施工|分部分项|施工方法/u.test(chapter.title));
    if (index < 0) continue;
    const list = result.get(index) ?? [];
    list.push({
      name: group.name,
      code: group.code,
      rows: group.rows,
      quantity: `${group.sample.quantity || ''}${group.sample.unit || ''}`.trim(),
      section: assignment?.section,
    });
    result.set(index, list);
  }
  return result;
}

/**
 * C3-6-4 未落位图纸分配（惰性：仅当检测端确有 drawing-reference issue 时重算一次）：与检测端单源——
 * drawingFactPlacement（token 命中判定唯一实现）过滤未引用份 → 逐份按「事实行 vs 章 token 相关性」
 * argmax 映射责任章（chapterRelevanceTokens 单源；图纸为设计本体、无清单责任章可借，相关性即落点）
 * → 无相关性章回退设计/说明/构造/做法类章 → 主要施工/分部分项章（与 BILL_METHOD_CHAPTER_RE 同族）
 * → 章数预算截断（按未落位份数降序取缺口最大章，截断份由后续轮检测继续报）。返回原 issue（章级
 * todo 携带）+ 未落位份数（首周期诊断）+ [章索引, 待补载荷]。
 */
function drawingPlacementAssignments(session: FinalizeSession): { issue?: ValidationIssue; unrefCount: number; byChapter: Map<number, DrawingPendingItem[]> } {
  const result = new Map<number, DrawingPendingItem[]>();
  const chapters = session.finalChapterDrafts;
  const lock = session.drawingFactLock;
  const issue = session.validationIssues.find(item => item.provenance?.detectorId === 'drawing-reference');
  if (!issue || !lock || lock.groups.length === 0 || chapters.length === 0) return { issue: undefined, unrefCount: 0, byChapter: result };
  const { unreferenced } = drawingFactPlacement(lock, session.finalMarkdown);
  if (unreferenced.length === 0) return { issue: undefined, unrefCount: 0, byChapter: result };
  const chapterTokens = chapters.map(chapter => chapterRelevanceTokens(chapter.title, chapter.sections || []).map(token => token.toLowerCase()));
  for (const group of unreferenced) {
    // 事实行（前 8 行）与各章 token 相关性 argmax：图纸设计事实的自然落点在专业对应章
    const factText = group.factLines.slice(0, 8).join(' ').toLowerCase();
    let bestIndex = -1;
    let bestScore = 0;
    chapterTokens.forEach((tokens, index) => {
      const score = tokens.reduce((sum, token) => sum + (factText.includes(token) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex < 0) bestIndex = chapters.findIndex(chapter => /设计|说明|构造|做法|施工方法|施工工艺/u.test(chapter.title));
    if (bestIndex < 0) bestIndex = chapters.findIndex(chapter => /主要施工|分部分项/u.test(chapter.title));
    if (bestIndex < 0) continue;
    const name = group.sourceFile.split('/').pop() || group.sourceFile;
    const list = result.get(bestIndex) ?? [];
    list.push({ name, tokens: group.tokens, lines: group.factLines.slice(0, DRAWING_PENDING_LINES_PER_ITEM) });
    result.set(bestIndex, list);
  }
  if (result.size > MAX_DRAWING_REFERENCE_REPAIR_CHAPTERS) {
    const kept = [...result.entries()].sort((left, right) => right[1].length - left[1].length).slice(0, MAX_DRAWING_REFERENCE_REPAIR_CHAPTERS);
    return { issue, unrefCount: unreferenced.length, byChapter: new Map(kept) };
  }
  return { issue, unrefCount: unreferenced.length, byChapter: result };
}

/**
 * 章级分组：blocker + 专业评分不足（D-T1，warning 级）→ ChapterTodo（按定位通道分配目标章）。
 * 返回 [章索引, todos] 映射与未定位计数（未定位项由终门禁照常复核）。
 */
function groupBlockersByChapter(session: FinalizeSession, blockers: ValidationIssue[], scoreWeakDimensions: Map<string, DepthDimension[]>, drawingAssignments?: { issue?: ValidationIssue; byChapter: Map<number, DrawingPendingItem[]> }): { byChapter: Map<number, ChapterTodo[]>; unlocated: number } {
  const byChapter = new Map<number, ChapterTodo[]>();
  let unlocated = 0;
  const chapters = session.finalChapterDrafts;
  // 参数落位类缺失池重算一次（惰性：仅当确有该类 blocker 时）：关键参数缺失池 + 相关遗漏参数池
  const hasParameterTokens = blockers.some(issue => issue.provenance?.detectorId && PARAMETER_TOKEN_DETECTOR_IDS.has(issue.provenance.detectorId));
  const missingTokens = hasParameterTokens ? missingCriticalPreciseTokens(session.finalMarkdown, session.factsModel, chapters) : [];
  // C-T6 可靠参数义务补写：相关而遗漏的可靠参数（有责任章但正文未使用）按最相关章分配目标章，
  // 与关键参数缺失池同轮消费（参数池已在构建时排除商务金额/单价/税率/预留金类事实）
  const missingParameterTasks = hasParameterTokens ? assignMissingParameterChapters(session.finalMarkdown, session.factsModel, chapters) : new Map<number, string[]>();
  // overview-recap 复述句重算一次（惰性：定位通道依赖现行文本的复述命中）
  const hasRecap = blockers.some(issue => issue.provenance?.detectorId === 'overview-recap');
  const recapSentences = hasRecap ? overviewRecapCandidates(session.finalMarkdown).sentences : [];
  const overview = hasRecap ? overviewContextOf(session) : { han: '', bodySentences: new Set<string>() };
  // C3-5 清单落位类未落位项重算一次（惰性：仅当确有 boq-placement blocker 时）
  const hasBoqPlacement = blockers.some(issue => issue.provenance?.detectorId === 'boq-placement');
  const boqAssignments = hasBoqPlacement ? boqPlacementAssignments(session) : new Map<number, BoqPendingItem[]>();
  const push = (index: number, todo: ChapterTodo) => {
    const list = byChapter.get(index) ?? [];
    list.push(todo);
    byChapter.set(index, list);
  };
  // C3-6-4 图纸未落位类（warning 级独立通道，同专业评分模式）：未引用份按事实行相关性分配的目标章
  // 逐章注入待补载荷（单条 todo 聚合本章全部图纸，同 boq 模式；issue 原样携带供指令展示与展痕）
  if (drawingAssignments?.issue && drawingAssignments.byChapter.size > 0) {
    for (const [index, items] of drawingAssignments.byChapter) {
      push(index, { detectorId: 'drawing-reference', issue: drawingAssignments.issue, pendingDrawings: items });
    }
  }
  let tokensAssigned = false;
  let sentencesAssigned = false;
  let boqAssigned = false;
  for (const issue of blockers) {
    const detectorId = issue.provenance?.detectorId;
    if (!detectorId) {
      unlocated += 1;
      continue;
    }
    // 通道 1：chapterId 直连（critical-section-depth / construction-org-* / professional-score）
    if (issue.chapterId) {
      const index = chapters.findIndex(chapter => chapter.id === issue.chapterId);
      if (index >= 0) {
        // D-T1：专业评分不足的章随 todo 注入薄弱维度（任务卡定向补写要求），其余类缺省
        push(index, { detectorId, issue, weakDimensions: scoreWeakDimensions.get(issue.chapterId) });
        continue;
      }
    }
    // 通道 2：sectionTitle 反查（emergency-section-depth：小节标题在章正文逐字出现）
    if (issue.sectionTitle) {
      const index = chapters.findIndex(chapter => chapter.content.includes(issue.sectionTitle!));
      if (index >= 0) {
        push(index, { detectorId, issue });
        continue;
      }
    }
    // 通道 3：参数落位类（C3-4 解挂靠）缺失池映射（缺失池首次命中时分配；与关键参数抽查/
    // 可靠参数义务审计同源重算）。同章 token 聚合为单条 todo——此前逐 token 一条 todo 输出
    // 重复话术，指令膨胀且章级缺口计数失真
    if (PARAMETER_TOKEN_DETECTOR_IDS.has(detectorId)) {
      // 同轮多类参数 blocker（关键参数抽查 + 可靠参数义务）的缺口并集由首个命中者统一分配；
      // 后续同类 blocker 的缺口已并入并集，不重复定位
      if (tokensAssigned) continue;
      tokensAssigned = true;
      let assignedAny = false;
      const assignedTokenText = new Set<string>();
      const tokensByChapter = new Map<number, string[]>();
      const appendToken = (index: number, token: string) => {
        const list = tokensByChapter.get(index) ?? [];
        list.push(token);
        tokensByChapter.set(index, list);
      };
      for (const token of missingTokens) {
        const matcher = PRECISE_TOKEN_CHAPTER_MATCHERS.find(([tokenRe]) => tokenRe.test(token));
        const matchedIndex = matcher ? chapters.findIndex(chapter => matcher[1].test(chapter.title)) : -1;
        // 无匹配章回退默认承载章（r9 #12 根治）：此前 index<0 直接 continue 丢弃，
        // 规范编号类 token（章集无「依据/规范/标准」标题）零归属、修复轮零消费
        const index = matchedIndex >= 0 ? matchedIndex : promptChapterFallbackIndex(chapters);
        if (index < 0) continue;
        appendToken(index, token);
        assignedTokenText.add(token);
        assignedAny = true;
      }
      // C-T6 相关而遗漏的可靠参数：按章相关性直接定位目标章（与关键参数缺失池去重后同轮消费）
      for (const [index, values] of missingParameterTasks) {
        for (const value of values) {
          if (assignedTokenText.has(value)) continue;
          appendToken(index, value);
          assignedTokenText.add(value);
          assignedAny = true;
        }
      }
      for (const [index, tokens] of tokensByChapter) push(index, { detectorId, issue, pendingTokens: tokens });
      if (assignedAny) continue;
      // 参数池不可用（bills/drawings 类 error 或池过小/全部净化）：按正文承载章关键词分配
      const fallbackRe = /正文未体现结构化数据资料/u.test(issue.message) ? /主要施工|分部分项|施工方法/u : /依据|概况|施工方案|主要施工/u;
      const index = chapters.findIndex(chapter => fallbackRe.test(chapter.title));
      if (index >= 0) {
        push(index, { detectorId, issue });
        continue;
      }
      unlocated += 1;
      continue;
    }
    // 通道 4：overview-recap 复述句反查所在章。r11 定位放开（丰乐镇实测 #6 死结归因）：
    // 检测端概况区是「标题含概况/基本信息的 H2~H4 小节锚点区间」，区间通常短于同名章——
    // 「第一章 工程概况」章内区间外部分（如「1.1 编制依据」小节）的复述句被报 blocker，
    // 旧实现按章标题排除「工程概况」章 → 定位恒失败 → 零修复直坠终门禁。放开后定位基准与
    // 检测端同源（recapSentences 已只含概况区间外句子，概况本体句不入池；残差计数按
    // overview.bodySentences 显式豁免本体句）
    if (detectorId === 'overview-recap' && !sentencesAssigned) {
      sentencesAssigned = true;
      let assignedAny = false;
      for (const sentence of recapSentences) {
        if (!overview.han || !overviewRecapHit(sentence, overview.han)) continue;
        const needle = normalizedFor(sentence);
        const index = chapters.findIndex(chapter => normalizedFor(chapter.content).includes(needle));
        if (index < 0) continue;
        push(index, { detectorId, issue, pendingSentences: [sentence] });
        assignedAny = true;
      }
      if (assignedAny) continue;
      unlocated += 1;
      continue;
    }
    // 通道 5：boq-placement 清单落位（C3-5）未落位项按责任章分配待补载荷（名称+工程量+建议小节）。
    // 同轮重复 blocker 仅首个命中者承载全量分配（tokensAssigned 同模式）；载荷空表（无未落位行/
    // 无章可映射）时按未定位计数交终门禁复核
    if (detectorId === 'boq-placement' && !boqAssigned) {
      boqAssigned = true;
      let assignedAny = false;
      for (const [index, items] of boqAssignments) {
        push(index, { detectorId, issue, pendingBoqItems: items });
        assignedAny = true;
      }
      if (assignedAny) continue;
      unlocated += 1;
      continue;
    }
    unlocated += 1;
  }
  return { byChapter, unlocated };
}

export async function stageContentDepthRepair(session: FinalizeSession): Promise<void> {
  let firstCycleBlockerCount = 0;
  let firstCycleScoreCount = 0;
  let firstCycleDrawingCount = 0;
  let unlocatedTotal = 0;
  let repairedChaptersTotal = 0;
  let resolvedTotal = 0;
  let repairedInAnyCycle = false;
  // 达标驱动：目标集（blocker + 评分不足 + 图纸未落位）清零即停；不再固定 2 周期。
  // 每周期取最薄弱的 N 章（批量，防单周期成本失控），已修好的章下周期自然退出目标集，
  // 故批量必然轮转到后面的章——这正是原实现缺失的性质（固定 2 周期时后面的章永无机会）。
  /** 饥饿防护：本批次已尝试过专业评分补写的章（跨周期轮转，避免弱章恒占名额、后段章永无机会） */
  const attemptedScoreChapters = new Set<string>();
  for (let cycle = 1; cycle <= MAX_CONTENT_DEPTH_REPAIR_CYCLES; cycle += 1) {
    // 输入=检测链最新 blocker（六类内容深度 detectorId 精确过滤，不依赖 message 文案）
    const blockerIssues = contentDepthBlockers(session);
    // D-T1：专业评分不足（<8/12，warning 级）目标章同轮消费（预算单列，与 blocker 合并章级定位）
    const scoreTargetList = await professionalScoreTargets(session, attemptedScoreChapters);
    // C3-6-4：图纸事实未落位（<90%，warning 级独立通道）未引用份重算 + 相关性分章（预算单列）
    const drawingAssignment = drawingPlacementAssignments(session);
    const drawingGap = drawingAssignment.issue ? 1 : 0;
    if (blockerIssues.length === 0 && scoreTargetList.length === 0 && drawingGap === 0) {
      if (cycle === 1) {
        const passStage = displayStage({ type: 'validation', roleId: 'content-depth-repair', status: 'success', message: '内容深度验收通过：内容深度检测器与专业评分均未报阻断' }, { subtitle: '内容深度补写核验' });
        upsertProgressStage(session.progressStages, passStage);
        upsertProgressStage(session.finalGateRepairStages, passStage);
        session.emitProgress(session.finalChapterDrafts, session.progressStages);
        return;
      }
      // 收敛周期后清零：终态无残留，循环收口
      break;
    }
    if (cycle === 1) {
      firstCycleBlockerCount = blockerIssues.length;
      firstCycleScoreCount = scoreTargetList.length;
      firstCycleDrawingCount = drawingAssignment.unrefCount;
    }
    const cycleLabel = cycle > 1 ? `（收敛周期 ${cycle}/${MAX_CONTENT_DEPTH_REPAIR_CYCLES}：处理上轮补写后重算新报残留）` : '';
    const scoreWeakDimensions = new Map(scoreTargetList.map(target => [target.chapterId, target.weakDimensions]));
    const { byChapter, unlocated } = groupBlockersByChapter(session, [...blockerIssues, ...scoreTargetList.map(target => target.issue)], scoreWeakDimensions, drawingAssignment);
    unlocatedTotal += unlocated;
    if (byChapter.size === 0) {
      if (cycle === 1) {
        const failedStage = displayStage({ type: 'validation', roleId: 'content-depth-repair', status: 'failed', message: `内容深度补写无法定位目标章：${blockerIssues.length + scoreTargetList.length + drawingGap} 条缺口均未匹配到章节锚点（由终门禁照常复核）` }, { subtitle: '内容深度补写核验' });
        upsertProgressStage(session.progressStages, failedStage);
        upsertProgressStage(session.finalGateRepairStages, failedStage);
        session.emitProgress(session.finalChapterDrafts, session.progressStages);
        return;
      }
      break;
    }
    const overview = overviewContextOf(session);
    let repairedChapters = 0;
    for (const [chapterIndex, todos] of byChapter) {
      const draftChapter = session.finalChapterDrafts[chapterIndex];
      let chapterContent = draftChapter.content;
      let beforeResidual = await chapterResidual(session, chapterIndex, todos, chapterContent, overview);
      // 防御：blocker 快照与当前正文不同源（正文已改但未重算）时跳过，交由重算链兜底
      if (beforeResidual === 0) continue;
      let rounds = 0;
      let chapterRepaired = false;
      let anyRollback = false;
      // D-T1 专业评分 / C3-6-4 图纸落位补写预算单列：仅独立通道 todo 的章每章 1 轮；
      // 含 blocker 类时仍 2 轮（独立通道类超出各自轮上限后退出）
      const hasBlockerTodos = todos.some(todo => todo.detectorId !== 'professional-score' && todo.detectorId !== 'drawing-reference');
      const roundCap = hasBlockerTodos ? MAX_CONTENT_DEPTH_REPAIR_ROUNDS : Math.max(MAX_PROFESSIONAL_SCORE_REPAIR_ROUNDS, MAX_DRAWING_REFERENCE_REPAIR_ROUNDS);
      const residualTrajectory = [beforeResidual];
      const roleId = `agent-content-depth-repair-${draftChapter.id}`;
      /** 4.56 2-b：本轮章级超额注记（累积进阶段 message/details，与 metrics 同源） */
      const overflowNotes: string[] = [];
      while (rounds < roundCap) {
        rounds += 1;
        // 活动待办刷新：逐类以实时残差过滤（已清零的类不再注入修复指令；参数类同步收缩待补列表）
        const activeTodos: ChapterTodo[] = [];
        for (const todo of todos) {
          // D-T1 专业评分补写预算单列：超过每章轮上限后不再注入（其余类不受影响）
          if (todo.detectorId === 'professional-score' && rounds > MAX_PROFESSIONAL_SCORE_REPAIR_ROUNDS) continue;
          if (PARAMETER_TOKEN_DETECTOR_IDS.has(todo.detectorId)) {
            const still = (todo.pendingTokens ?? []).filter(token => tokenMissingFrom(chapterContent, token));
            if (still.length > 0) activeTodos.push({ ...todo, pendingTokens: still });
            continue;
          }
          // C3-5 清单落位类同步收缩待补列表（与复检同源归一化口径 normalizeBoqMatchText +
          // boqItemCarriedInText 三通道判定）
          if (todo.detectorId === 'boq-placement') {
            const normalizedContent = normalizeBoqMatchText(chapterContent);
            const still = (todo.pendingBoqItems ?? []).filter(item => !boqItemCarriedInText(normalizedContent, item.name, item.code));
            if (still.length > 0) activeTodos.push({ ...todo, pendingBoqItems: still });
            continue;
          }
          // C3-6-4 图纸落位类同步收缩待补列表（与复检同源归一化口径 normalizeDrawingMatchText +
          // token 命中判定，检测端 drawingFactPlacement 单源）；超出每章轮上限后不再注入
          if (todo.detectorId === 'drawing-reference') {
            if (rounds > MAX_DRAWING_REFERENCE_REPAIR_ROUNDS) continue;
            const normalizedContent = normalizeDrawingMatchText(chapterContent);
            const still = (todo.pendingDrawings ?? []).filter(item => !item.tokens.some(token => normalizedContent.includes(token)));
            if (still.length > 0) activeTodos.push({ ...todo, pendingDrawings: still });
            continue;
          }
          const residual = await chapterClassResidual(session, chapterIndex, todo.detectorId, chapterContent, overview, todo.pendingTokens ?? []);
          if (residual > 0) activeTodos.push(todo);
        }
        if (activeTodos.length === 0) break;
        const roundStartedAt = Date.now();
        const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `内容深度补写中${cycleLabel}（第 ${rounds}/${roundCap} 轮）：${draftChapter.title}（${activeTodos.length} 类缺口）`, details: activeTodos.map(todo => `缺口：${todo.issue.message.slice(0, 80)}`), }, { subtitle: '内容深度补写核验' });
        upsertProgressStage(session.progressStages, runningStage);
        upsertProgressStage(session.finalGateRepairStages, runningStage);
        session.emitProgress(session.finalChapterDrafts, session.progressStages);
        const outcome = await withPatchRollback({
          originalContent: chapterContent,
          repairRound: 'content-depth-repair',
          diagnostics: session.generationDiagnostics,
          beforeMetrics: [beforeResidual],
          apply: async () => {
            // 4.56 2-b：预算账按实时正文结算后注入指令（本轮额度约束）。缺预算条目时不渲染该段
            const budgetEntry = chapterBudgetEntryFor(session, chapterIndex, chapterContent);
            const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
              template: session.template,
              chapter: { id: draftChapter.id, title: draftChapter.title, content: chapterContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
              issues: activeTodos.map(todo => `${todo.issue.message}｜${todo.issue.suggestion || ''}`),
              promptTexts: instructionFor(draftChapter, activeTodos, rounds, roundCap, budgetEntry),
              requirement: session.requirement,
              forbidDrawingImages: false,
              // 标书编制规格（正文表格口径）：修复链 system 口径同步
              bidComposition: session.bidComposition,
              diagnostics: session.generationDiagnostics,
              signal: session.signal,
              patchGuard: repairPatchGuard('content-depth-repair', session.generationDiagnostics),
            }));
            return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
          },
          recheck: async (content) => [await chapterResidual(session, chapterIndex, todos, content, overview)],
        });
        if (outcome.rolledBack) anyRollback = true;
        if (outcome.rolledBack || outcome.content === chapterContent) break;
        const contentBeforeRound = chapterContent;
        chapterContent = outcome.content;
        session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: chapterContent };
        chapterRepaired = true;
        // 4.56 2-b 落地后章级超额检查（只观测不改写：本轮新增多少字 + 超出多少 → 阶段 message/
        // details + diagnostics.metrics。强制截断需改造 2-a 的单一写入通道，属后续批次）
        const roundBudgetEntry = chapterBudgetEntryFor(session, chapterIndex, contentBeforeRound);
        const overflowReport = roundBudgetEntry
          ? chapterOverflowAfterRound({ chapterId: draftChapter.id, title: draftChapter.title, target: roundBudgetEntry.target, beforeContent: contentBeforeRound, afterContent: chapterContent })
          : undefined;
        if (overflowReport) {
          overflowNotes.push(renderChapterOverflowNote(overflowReport));
          recordChapterBudgetMetric({ diagnostics: session.generationDiagnostics, round: 'content-depth-repair', startedAt: roundStartedAt, report: overflowReport });
        }
        const afterResidual = outcome.afterMetrics[0] ?? await chapterResidual(session, chapterIndex, todos, chapterContent, overview);
        residualTrajectory.push(afterResidual);
        // 收敛判定：清零即通过；未下降（含回滚/空修复）即停止；下降且未达上限 → 再修一轮
        if (afterResidual === 0 || afterResidual >= beforeResidual || rounds >= roundCap) break;
        beforeResidual = afterResidual;
      }
      if (chapterRepaired) repairedChapters += 1;
      const finalResidual = chapterRepaired ? residualTrajectory[residualTrajectory.length - 1] : beforeResidual;
      resolvedTotal += Math.max(0, beforeResidual - finalResidual);
      const residualNote = `残留深度缺口量 ${finalResidual}（各类残差累计：字数缺口/缺陷项数/参数与清单项缺项数），由终门禁照常复核`;
      let message: string;
      if (finalResidual === 0 && chapterRepaired) message = `内容深度补写完成${cycleLabel}：${draftChapter.title}（${rounds} 轮补写后缺口清零）`;
      else if (chapterRepaired) message = `内容深度补写部分生效${cycleLabel}：${draftChapter.title}（残留轨迹 ${residualTrajectory.join('→')}，已执行 ${rounds} 轮；${residualNote}）`;
      else if (anyRollback) message = `内容深度补写已回滚${cycleLabel}：${draftChapter.title}（修复后缺口数未下降，保留修复前正文；${residualNote}）`;
      else message = `内容深度补写未生效${cycleLabel}：${draftChapter.title}（模型未产生有效修改；${residualNote}）`;
      // 4.56 2-b：章级超额观测上屏（message 摘要 + details 逐条；超产不经观测不落账）
      if (overflowNotes.length > 0) message = `${message}；${overflowNotes[overflowNotes.length - 1]}`;
      const completedStage = displayStage({ type: 'llm_review', roleId, status: repairOutcomeStatus({ before: residualTrajectory[0], after: finalResidual, repaired: chapterRepaired }), message, details: [...todos.map(todo => `缺陷：${todo.issue.message.slice(0, 90)}`), ...(finalResidual > 0 ? [`残留深度缺口量 ${finalResidual}`] : []), ...overflowNotes] }, { subtitle: '内容深度补写核验' });
      upsertProgressStage(session.progressStages, completedStage);
      upsertProgressStage(session.finalGateRepairStages, completedStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
    }
    if (repairedChapters > 0) {
      repairedChaptersTotal += repairedChapters;
      repairedInAnyCycle = true;
      session.finalMarkdown = session.rebuildFinalMarkdown();
      await session.recomputeFinalValidationBundle();
    } else {
      // 本周期无修复落地（全部回滚/未生效/防御跳过）：同样内容再补写无意义，停止外层循环
      break;
    }
    // 外层收敛判定：recompute 后的最新残留（含语义通道复验）与专业评分缺口（预算截断后）
    // 合计清零或未下降即停止，下降则再跑一个收敛周期
    const residualIssues = contentDepthBlockers(session);
    const residualScoreCount = (await professionalScoreTargets(session)).length;
    if (residualIssues.length + residualScoreCount === 0 || residualIssues.length + residualScoreCount >= blockerIssues.length + scoreTargetList.length) break;
  }
  // 终态残留=重算后检测链最新 blocker 数（含语义通道复验，口径比确定性复检更宽松）
  const residualBlockers = contentDepthBlockers(session);
  if (repairedInAnyCycle || firstCycleBlockerCount > 0 || firstCycleScoreCount > 0 || firstCycleDrawingCount > 0) {
    // 4.56 2-b：本轮终态章预算账（补写轮「知道额度」的可复盘出口：各章 current 与超额明细）
    const ledger = buildChapterBudgetLedger({
      chapterTargets: session.documentBudget?.chapterTargets,
      chapters: session.finalChapterDrafts,
      documentTargetChars: session.documentBudget?.targetChars,
    });
    const budgetNote = `；${renderDocumentBudgetSummary(ledger)}${ledger.overBudget.length > 0 ? `（超额章：${ledger.overBudget.map(chapter => `${chapter.title.slice(0, 16)} 超 ${Math.abs(chapter.remaining)} 字`).join('、')}）` : ''}`;
    session.generationDiagnostics.llm.lastInfo = `内容深度定向补写：初检 ${firstCycleBlockerCount} 项深度类阻断${firstCycleScoreCount > 0 ? `、${firstCycleScoreCount} 章专业评分不足（补写线 ${PROFESSIONAL_SCORE_LINE}/12，资源类章 10/12）` : ''}${firstCycleDrawingCount > 0 ? `、${firstCycleDrawingCount} 份图纸事实未落位（引用率目标 90%）` : ''}（定位 ${firstCycleBlockerCount - Math.min(unlocatedTotal, firstCycleBlockerCount)} 项${unlocatedTotal > 0 ? `，未定位 ${unlocatedTotal} 项` : ''}），章级定向补写（六类每章最多 ${MAX_CONTENT_DEPTH_REPAIR_ROUNDS} 轮 + 专业评分每章最多 ${MAX_PROFESSIONAL_SCORE_REPAIR_ROUNDS} 轮/单周期最多 ${MAX_PROFESSIONAL_SCORE_REPAIR_CHAPTERS} 章 + 图纸落位每章最多 ${MAX_DRAWING_REFERENCE_REPAIR_ROUNDS} 轮/单周期最多 ${MAX_DRAWING_REFERENCE_REPAIR_CHAPTERS} 章，收敛周期上限 ${MAX_CONTENT_DEPTH_REPAIR_CYCLES}），${repairedChaptersTotal} 章次落地，本次消解 ${resolvedTotal} 项缺口，终态残留 ${residualBlockers.length} 项（由终门禁照常复核）${budgetNote}`;
  }
  // G 线 P2-4：LLM 补写轮消解缺口项数计量（与确定性修复器「处数」同口径——两者计的都是被消解的问题数）
  recordRepairActions(session.generationDiagnostics, resolvedTotal);
}
