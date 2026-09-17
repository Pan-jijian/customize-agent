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
 * - precise-fact-usage：missingCriticalPreciseTokens 重算缺失池（与关键参数抽查同源），
 *   按参数类别（规范编号/工期/面积/强度/管径）映射目标章（factLanding 映射表同族口径）；
 * - overview-recap：overviewRecapCandidates + overviewRecapHit 反查复述句所在章（排除概况章本体）。
 *
 * 复检（同源零嵌入，回滚保护）：修复后对章内容重跑对应检测器（critical/construction-org/emergency
 * 确定性 + 语义同源；precise-fact-usage 用字面 token 口径；overview-recap 用复述判定）。
 * 收敛修复（蓝本同构）：每章最多 2 轮，残留数下降才继续下一轮；外层最多 2 周期（补写后 recompute
 * 语义重算新滑移出的残留再消费一轮）；修复落地后 rebuildFinalMarkdown + recomputeFinalValidationBundle。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { divisionSectionDeficitCount, majorContentDeficitCount } from '../../constructionOrgQualityRules';
import { normalizeEngineeringTextForFactMatch } from '../../engineeringUnits';
import { emergencySectionDepthIssues } from '../../emergencySectionDepth';
import { missingCriticalPreciseTokens } from '../../qualityValidation';
import { overviewRecapCandidates, overviewRecapHit } from '../../integrity/detectors/detectors';
import { criticalSectionDeficitTotal } from '../rebuildAndRecompute';
import type { DocumentDraftChapter, ValidationIssue } from '../../types';
import type { FinalizeSession } from '../finalizeSession';

/** 本轮的消费集合（修复链覆盖缺口的六类内容深度检测器，与检测端 provenance.detectorId 严格同名） */
const CONTENT_DEPTH_DETECTOR_IDS: ReadonlySet<string> = new Set([
  'critical-section-depth',
  'emergency-section-depth',
  'construction-org-major-content',
  'construction-org-division-section',
  'precise-fact-usage',
  'overview-recap',
]);

/** 收敛修复：每章定向补写轮上限（残留数下降才继续下一轮；不降/回滚/达上限即停止） */
const MAX_CONTENT_DEPTH_REPAIR_ROUNDS = 2;

/** 外层收敛周期上限（补写改写后 recompute 语义重算新报的残留需要再消费；首周期处理初检 blocker） */
const MAX_CONTENT_DEPTH_REPAIR_CYCLES = 2;

/** 章级待办项：一条深度类 blocker 的修复素材（按检测器类别承载不同定位载荷） */
interface ChapterTodo {
  detectorId: string;
  issue: ValidationIssue;
  /** precise-fact-usage：本章负责补齐的关键参数 token 列表 */
  pendingTokens?: string[];
  /** overview-recap：本章须删除/改写的复述句 */
  pendingSentences?: string[];
}

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
async function chapterClassResidual(session: FinalizeSession, chapterIndex: number, detectorId: string, content: string, overview: OverviewContext, pendingTokens: string[]): Promise<number> {
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
    case 'precise-fact-usage': {
      // 归一化字面口径（与检测端同源）：单位/全角/破折号双端归一，残留判定与修复落地同尺度
      return pendingTokens.filter(token => tokenMissingFrom(content, token)).length;
    }
    case 'overview-recap':
      return countRecapSentences(content, overview);
    default:
      return 0;
  }
}

/** 章级总残差（todos 涉及的检测器类去重后逐类计数求和） */
async function chapterResidual(session: FinalizeSession, chapterIndex: number, todos: ChapterTodo[], content: string, overview: OverviewContext): Promise<number> {
  const resolved = new Map<string, number>();
  for (const todo of todos) {
    if (resolved.has(todo.detectorId)) continue;
    const pendingTokens = todos.filter(item => item.detectorId === 'precise-fact-usage').flatMap(item => item.pendingTokens ?? []);
    resolved.set(todo.detectorId, await chapterClassResidual(session, chapterIndex, todo.detectorId, content, overview, pendingTokens));
  }
  let total = 0;
  for (const value of resolved.values()) total += value;
  return total;
}

/** 定向补写指令：逐条缺陷原文 + 类别定制补写要求 + 局部修改约束（反条幅、禁编造） */
function instructionFor(draftChapter: DocumentDraftChapter, todos: ChapterTodo[], round: number): string {
  const lines: string[] = [
    '【内容深度定向补写修复】',
    ...(round > 1 ? [`本轮为第 ${round} 轮（最多 ${MAX_CONTENT_DEPTH_REPAIR_ROUNDS} 轮）：上一轮补写后复检仍有残留，请针对下列缺口严格补足。`] : []),
    `下列内容深度类验收缺陷是《${draftChapter.title}》导出前的阻断项，请逐条定向修复：`,
    '1. 补写内容必须落到绑定资料/清单/图纸中的具体数值与工程事实，保持原始数值与单位，不得编造参数、不得空泛套话；',
    '2. 只做局部修改：优先在对应小节内扩写补实，或在最合适的位置并入补写段落；不得新增、删除或合并小节，不得改动无关内容；',
    '3. 禁止「按招标文件要求：」类条幅前缀与任何元话语，必须是正式施组正文行文。',
  ];
  for (const todo of todos) {
    const head = `- [${todo.detectorId}] ${todo.issue.message}`;
    const advice = todo.issue.suggestion ? `（补充要求：${todo.issue.suggestion}）` : '';
    lines.push(`${head}${advice}`);
    if (todo.pendingTokens && todo.pendingTokens.length > 0) {
      lines.push(`  本章负责补齐的关键工程参数：${todo.pendingTokens.join('、')}。请自然写入本章对应位置，必须逐字保留原文形态（数字、单位、编号中的连字符与年份不得改写、拆写或省略）；规范编号无法确认规范名称时只写编号并表述为现行国家（行业）标准，不得编造规范名称。`);
    }
    if (todo.pendingSentences && todo.pendingSentences.length > 0) {
      lines.push(`  下列句段属概况复述，须删除或改写为本章内容（可保留必要的具体数字引用，不得整段复述概况）：${todo.pendingSentences.map(sentence => `“${sentence.slice(0, 60)}”`).join('；')}`);
    }
  }
  return lines.join('\n');
}

/**
 * 章级分组：blocker → ChapterTodo（按定位通道分配目标章）。
 * 返回 [章索引, todos] 映射与未定位计数（未定位项由终门禁照常复核）。
 */
function groupBlockersByChapter(session: FinalizeSession, blockers: ValidationIssue[]): { byChapter: Map<number, ChapterTodo[]>; unlocated: number } {
  const byChapter = new Map<number, ChapterTodo[]>();
  let unlocated = 0;
  const chapters = session.finalChapterDrafts;
  // precise-fact-usage 缺失池重算一次（惰性：仅当确有该类 blocker 时）
  const hasPreciseUsage = blockers.some(issue => issue.provenance?.detectorId === 'precise-fact-usage');
  const missingTokens = hasPreciseUsage ? missingCriticalPreciseTokens(session.finalMarkdown, session.factsModel, chapters) : [];
  // overview-recap 复述句重算一次（惰性：定位通道依赖现行文本的复述命中）
  const hasRecap = blockers.some(issue => issue.provenance?.detectorId === 'overview-recap');
  const recapSentences = hasRecap ? overviewRecapCandidates(session.finalMarkdown).sentences : [];
  const overview = hasRecap ? overviewContextOf(session) : { han: '', bodySentences: new Set<string>() };
  const push = (index: number, todo: ChapterTodo) => {
    const list = byChapter.get(index) ?? [];
    list.push(todo);
    byChapter.set(index, list);
  };
  let tokensAssigned = false;
  let sentencesAssigned = false;
  for (const issue of blockers) {
    const detectorId = issue.provenance?.detectorId;
    if (!detectorId) {
      unlocated += 1;
      continue;
    }
    // 通道 1：chapterId 直连（critical-section-depth / construction-org-*）
    if (issue.chapterId) {
      const index = chapters.findIndex(chapter => chapter.id === issue.chapterId);
      if (index >= 0) {
        push(index, { detectorId, issue });
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
    // 通道 3：precise-fact-usage 参数类别映射（缺失池首次命中时分配；与关键参数抽查同源重算）
    if (detectorId === 'precise-fact-usage' && !tokensAssigned) {
      tokensAssigned = true;
      if (missingTokens.length > 0) {
        let assignedAny = false;
        for (const token of missingTokens) {
          const matcher = PRECISE_TOKEN_CHAPTER_MATCHERS.find(([tokenRe]) => tokenRe.test(token));
          const matchedIndex = matcher ? chapters.findIndex(chapter => matcher[1].test(chapter.title)) : -1;
          // 无匹配章回退默认承载章（r9 #12 根治）：此前 index<0 直接 continue 丢弃，
          // 规范编号类 token（章集无「依据/规范/标准」标题）零归属、修复轮零消费
          const index = matchedIndex >= 0 ? matchedIndex : promptChapterFallbackIndex(chapters);
          if (index < 0) continue;
          push(index, { detectorId, issue, pendingTokens: [token] });
          assignedAny = true;
        }
        if (assignedAny) continue;
      }
      // 关键参数池不可用（bills/drawings 类 error 或池过小）：按正文承载章关键词分配
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
    unlocated += 1;
  }
  return { byChapter, unlocated };
}

export async function stageContentDepthRepair(session: FinalizeSession): Promise<void> {
  let firstCycleBlockerCount = 0;
  let unlocatedTotal = 0;
  let repairedChaptersTotal = 0;
  let resolvedTotal = 0;
  let repairedInAnyCycle = false;
  for (let cycle = 1; cycle <= MAX_CONTENT_DEPTH_REPAIR_CYCLES; cycle += 1) {
    // 输入=检测链最新 blocker（六类内容深度 detectorId 精确过滤，不依赖 message 文案）
    const blockerIssues = contentDepthBlockers(session);
    if (blockerIssues.length === 0) {
      if (cycle === 1) {
        const passStage = displayStage({ type: 'validation', roleId: 'content-depth-repair', status: 'success', message: '内容深度验收通过：六类内容深度检测器均未报阻断' }, { subtitle: '内容深度补写核验' });
        upsertProgressStage(session.progressStages, passStage);
        upsertProgressStage(session.finalGateRepairStages, passStage);
        session.emitProgress(session.finalChapterDrafts, session.progressStages);
        return;
      }
      // 收敛周期后清零：终态无残留，循环收口
      break;
    }
    if (cycle === 1) firstCycleBlockerCount = blockerIssues.length;
    const cycleLabel = cycle > 1 ? `（收敛周期 ${cycle}/${MAX_CONTENT_DEPTH_REPAIR_CYCLES}：处理上轮补写后重算新报残留）` : '';
    const { byChapter, unlocated } = groupBlockersByChapter(session, blockerIssues);
    unlocatedTotal += unlocated;
    if (byChapter.size === 0) {
      if (cycle === 1) {
        const failedStage = displayStage({ type: 'validation', roleId: 'content-depth-repair', status: 'failed', message: `内容深度补写无法定位目标章：${blockerIssues.length} 条阻断均未匹配到章节锚点（由终门禁照常复核）` }, { subtitle: '内容深度补写核验' });
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
      const residualTrajectory = [beforeResidual];
      const roleId = `agent-content-depth-repair-${draftChapter.id}`;
      while (rounds < MAX_CONTENT_DEPTH_REPAIR_ROUNDS) {
        rounds += 1;
        // 活动待办刷新：逐类以实时残差过滤（已清零的类不再注入修复指令；参数类同步收缩待补列表）
        const activeTodos: ChapterTodo[] = [];
        for (const todo of todos) {
          if (todo.detectorId === 'precise-fact-usage') {
            const still = (todo.pendingTokens ?? []).filter(token => tokenMissingFrom(chapterContent, token));
            if (still.length > 0) activeTodos.push({ ...todo, pendingTokens: still });
            continue;
          }
          const residual = await chapterClassResidual(session, chapterIndex, todo.detectorId, chapterContent, overview, todo.pendingTokens ?? []);
          if (residual > 0) activeTodos.push(todo);
        }
        if (activeTodos.length === 0) break;
        const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `内容深度补写中${cycleLabel}（第 ${rounds}/${MAX_CONTENT_DEPTH_REPAIR_ROUNDS} 轮）：${draftChapter.title}（${activeTodos.length} 类缺口）`, details: activeTodos.map(todo => `缺口：${todo.issue.message.slice(0, 80)}`), }, { subtitle: '内容深度补写核验' });
        upsertProgressStage(session.progressStages, runningStage);
        upsertProgressStage(session.finalGateRepairStages, runningStage);
        session.emitProgress(session.finalChapterDrafts, session.progressStages);
        const outcome = await withPatchRollback({
          originalContent: chapterContent,
          repairRound: 'content-depth-repair',
          diagnostics: session.generationDiagnostics,
          beforeMetrics: [beforeResidual],
          apply: async () => {
            const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
              template: session.template,
              chapter: { id: draftChapter.id, title: draftChapter.title, content: chapterContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
              issues: activeTodos.map(todo => `${todo.issue.message}｜${todo.issue.suggestion || ''}`),
              promptTexts: instructionFor(draftChapter, activeTodos, rounds),
              requirement: session.requirement,
              forbidDrawingImages: false,
              // 标书编制规格（暗标禁表）：修复链 system 口径同步
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
        chapterContent = outcome.content;
        session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: chapterContent };
        chapterRepaired = true;
        const afterResidual = outcome.afterMetrics[0] ?? await chapterResidual(session, chapterIndex, todos, chapterContent, overview);
        residualTrajectory.push(afterResidual);
        // 收敛判定：清零即通过；未下降（含回滚/空修复）即停止；下降且未达上限 → 再修一轮
        if (afterResidual === 0 || afterResidual >= beforeResidual || rounds >= MAX_CONTENT_DEPTH_REPAIR_ROUNDS) break;
        beforeResidual = afterResidual;
      }
      if (chapterRepaired) repairedChapters += 1;
      const finalResidual = chapterRepaired ? residualTrajectory[residualTrajectory.length - 1] : beforeResidual;
      resolvedTotal += Math.max(0, beforeResidual - finalResidual);
      const residualNote = `残留深度缺口量 ${finalResidual}（字数缺口与缺陷项数累计），由终门禁照常复核`;
      let message: string;
      if (finalResidual === 0 && chapterRepaired) message = `内容深度补写完成${cycleLabel}：${draftChapter.title}（${rounds} 轮补写后缺口清零）`;
      else if (chapterRepaired) message = `内容深度补写部分生效${cycleLabel}：${draftChapter.title}（残留轨迹 ${residualTrajectory.join('→')}，已执行 ${rounds} 轮；${residualNote}）`;
      else if (anyRollback) message = `内容深度补写已回滚${cycleLabel}：${draftChapter.title}（修复后缺口数未下降，保留修复前正文；${residualNote}）`;
      else message = `内容深度补写未生效${cycleLabel}：${draftChapter.title}（模型未产生有效修改；${residualNote}）`;
      const completedStage = displayStage({ type: 'llm_review', roleId, status: finalResidual === 0 && chapterRepaired ? 'success' : 'failed', message, details: [...todos.map(todo => `缺陷：${todo.issue.message.slice(0, 90)}`), ...(finalResidual > 0 ? [`残留深度缺口量 ${finalResidual}`] : [])] }, { subtitle: '内容深度补写核验' });
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
    // 外层收敛判定：recompute 后的最新残留（含语义通道复验）；清零或未下降即停止，下降则再跑一个收敛周期
    const residualIssues = contentDepthBlockers(session);
    if (residualIssues.length === 0 || residualIssues.length >= blockerIssues.length) break;
  }
  // 终态残留=重算后检测链最新 blocker 数（含语义通道复验，口径比确定性复检更宽松）
  const residualBlockers = contentDepthBlockers(session);
  if (repairedInAnyCycle || firstCycleBlockerCount > 0) {
    session.generationDiagnostics.llm.lastInfo = `内容深度定向补写：初检 ${firstCycleBlockerCount} 项深度类阻断（定位 ${firstCycleBlockerCount - Math.min(unlocatedTotal, firstCycleBlockerCount)} 项${unlocatedTotal > 0 ? `，未定位 ${unlocatedTotal} 项` : ''}），章级定向补写（每章最多 ${MAX_CONTENT_DEPTH_REPAIR_ROUNDS} 轮收敛修复，收敛周期上限 ${MAX_CONTENT_DEPTH_REPAIR_CYCLES}），${repairedChaptersTotal} 章次落地，本次消解 ${resolvedTotal} 项缺口，终态残留 ${residualBlockers.length} 项（由终门禁照常复核）`;
  }
}
