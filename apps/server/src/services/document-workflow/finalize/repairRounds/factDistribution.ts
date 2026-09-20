/**
 * repairRounds/factDistribution：关键事实跨章扩散轮（FINALIZE_REPAIR_ROUNDS: fact-distribution-round）。
 * 方案针对性（specificity distribution）丰乐镇实测归因（R12）：usedRate≈0.78 但 distribution≈0.09——
 * 落位事实值绝大多数只出现在单一章节。根因两层：① 章头项目基本信息表值（合同估算价/项目编号/
 * 标段划分）不进 chapter.content（表格不在章节正文域），章节口径分布恒 0；② 总述数据（建设地点/
 * 质量标准）仅在概况/质量章落位，其余章节零引用。施工组织设计惯例：总述数据在概况章集中交代、
 * 其他章节按需引用具体值——本轮确定性动作：对落位 0-1 章的高价值事实值（标签语义映射）在语义相关章
 * 的首个正文块尾追加自然引用句（不新增小节/不新增段落/不改原句/不触概况复述禁用句式「本项目为/
 * 本工程为/该项目为/该工程为」，与 overviewRecapCandidates 同口径规避）。
 * 值级口径与 specificityScore 完全同源（buildDocumentFactTraces + isActionableTraceFact + 4-60 字 +
 * 空白归一化），扩散生效即在评分口径可见。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { buildDocumentFactTraces, isActionableTraceFact } from '../../documentFactTrace';
import { stripFactLabelPrefix } from '../../factsModel';
import type { FinalizeSession } from '../finalizeSession';

/** 单轮扩散值上限（防大文档全量霸屏；按 trace 遍历序取前 N，基础字段天然靠前）。
 * R14 丰乐镇实测 10 不够：actionable 值 13 个，遍历序靠后的「周期要求」「资源配置要求」
 * 被上限截断后分布缺口恒存（distribution 0.583）——提升到 16 覆盖全部基础域值 */
const MAX_DISTRIBUTION_VALUES = 16;
/** 单章最多追加引用句数（防堆砌痕迹） */
const MAX_SENTENCES_PER_CHAPTER = 3;

/** 高价值事实标签 → 目标章语义匹配 + 引用句式变体（变体按「值+章 id」稳定择一，防多章同句式痕迹） */
const DISTRIBUTION_RULES: Array<{ label: RegExp; chapterPattern: RegExp; variants: Array<(value: string) => string> }> = [
  {
    label: /建设地点|工程地点|项目地点/u,
    chapterPattern: /施工部署|总体部署|总平面|施工平面|施工准备|组织设计/u,
    variants: [
      value => `工程地处${value}，场内外运输通道与作业面布置按现场实际条件组织实施。`,
      value => `施工组织结合${value}的地域条件展开，材料运输与作业面安排按现场道路实际情况确定。`,
    ],
  },
  {
    label: /质量标准|质量目标|质量要求/u,
    chapterPattern: /施工方法|主要施工|分部|分项|工期/u,
    variants: [
      value => `各分项施工质量验收统一以“${value}”为总控目标，检验批验收逐级对照核验。`,
      value => `全过程质量验收以“${value}”为准绳，实测实量与观感验收同步对标。`,
    ],
  },
  {
    label: /合同估算价|投资估算|估算价|项目投资|造价/u,
    chapterPattern: /施工部署|总体部署|资源|投入|物资/u,
    variants: [
      value => `工程投入控制以${value}为基准，资源投入与进度安排与之匹配。`,
      value => `资源配置与成本计划按${value}的总量口径编制，分阶段投入量以此控制。`,
    ],
  },
  {
    label: /标段/u,
    chapterPattern: /施工部署|总体部署|施工方法|总体/u,
    variants: [
      value => `施工部署围绕${value}的建设内容统筹组织，作业面划分与资源投入与之对应。`,
    ],
  },
  {
    label: /项目编号|招标编号/u,
    chapterPattern: /编制依据|工程概况|说明|总平面|施工部署|总体|组织设计|方法|进度/u,
    variants: [
      value => `本工程招标项目编号为${value}，合同与结算文件均以此编号为准。`,
    ],
  },
  {
    label: /招标范围|施工范围|建设规模|项目内容/u,
    chapterPattern: /施工部署|总体部署|施工方法|概况/u,
    variants: [
      value => `施工范围以${value}为界，各分项作业内容逐项组织实施。`,
    ],
  },
  {
    // C-T7（#50）：招标人事实仅存在于章头信息表/概况章（正文零引用致未落位告警）——项目管理/
    // 组织机构类章是招标人（发包方）的常规引用场景，确定性扩散补齐跨章分布
    label: /^(?:招标人|建设单位|发包人|项目业主)$/u,
    chapterPattern: /概况|编制依据|施工部署|总体|组织设计|项目管理|机构/u,
    variants: [
      value => `本工程招标人为${value}，施工组织与合同履约管理对招标人负责。`,
      value => `项目建设单位为${value}，各项报审报验按建设单位管理要求执行。`,
    ],
  },
  {
    // R14 丰乐镇：项目名称仅落工程概况章（distribution=0）——总平面标识牌/文明施工公示是名称的
    // 常规落位场景；label 精确锚定防误抓「分部工程名称」类清单噪声（同口径已在 isActionableTraceFact 过滤）
    label: /^(?:项目名称|工程名称|项目名)$/u,
    chapterPattern: /施工部署|总体部署|总平面|施工平面|文明|组织设计|概况/u,
    variants: [
      value => `工程标识牌与报验资料统一采用“${value}”的正式名称，现场公示内容同步标注。`,
      value => `施工全过程以“${value}”为准统一称谓，各类记录与归档文件同步标注。`,
    ],
  },
  {
    // R14 丰乐镇：周期要求（开工日期/节点安排）仅落章头表不进章正文——工期进度类章是其必要锚点
    label: /^(?:周期要求|开工时间|计划开工日期|合同工期)$/u,
    chapterPattern: /工期|进度|总平面|施工部署/u,
    variants: [
      value => `${value}，总进度计划据此编排各阶段节点与资源投入。`,
      value => `进度安排以“${value}”为控制基准，各阶段计划与之衔接。`,
    ],
  },
  {
    // R14 丰乐镇：资源配置要求（开工准备义务句）仅落章头表（chapter.content 零命中）——资源/准备类章扩散
    // （值本身为句子型时由 isSentenceValue 直引，短语型走模板兜底）
    label: /资源配置|资源投入|资源配备|开工准备/u,
    chapterPattern: /资源|投入|物资|机械|劳动力|总平面|施工部署|总体部署|方法|准备/u,
    variants: [
      value => `施工资源配置按${value}统筹安排，各阶段投入计划与之匹配。`,
    ],
  },
];

/** 值本身即完整陈述句（含谓语、无句内冒号枚举）→ 直接作为独立句引用；短语值 → 走规则模板 */
function isSentenceValue(value: string) {
  return value.length >= 10
    && !/[：:]/u.test(value)
    && /(?:为|位于|覆盖|划分为|共划分|应|须|符合|执行|遵守|包括|涵盖|不低于|不少于)/u.test(value);
}

/** 扩散值前置校验：长度口径与 specificityScore 同源（4-60 字）；已达分布阈值/日期型/长值枚举残片不扩散。
 * label 感知（R14 丰乐镇）：日期型值默认不扩散，但「项目名称/工程名称」的年份是名称合法成分
 * （「2026年度…建设项目」被无差别拦下致 distribution 缺口）、「周期/工期/开工」类日期是工期章
 * 必要锚点——两类 label 放行年份守卫。 */
function isDistributableValue(value: string, chapterCount: number, label = '') {
  if (value.length < 4 || value.length > 60) return false;
  if (chapterCount >= 2) return false;
  if (/\d{4}年/u.test(value) && !/项目名称|工程名称|周期|工期|开工|竣工|进度/u.test(label)) return false;
  if (value.length > 24 && /[：:]\s| [一二三四五（(]/u.test(value)) return false;
  return true;
}

/** 在章内容的首个「≥30 字、非标题、非表格、非列表、且不含目标值」正文块尾追加引用句。
 * startBlockIndex 起按块序寻找（同章多值防堆叠同块，环绕回卷）；返回新内容与插入块序号。 */
function appendReferenceSentence(
  content: string,
  sentence: string,
  normalizedValue: string,
  startBlockIndex: number,
): { content: string; blockIndex: number } | undefined {
  const parts = content.split(/(\n{2,})/u);
  const totalBlocks = Math.ceil(parts.length / 2);
  for (let offset = 0; offset < totalBlocks; offset += 1) {
    const blockIndex = (startBlockIndex + offset) % totalBlocks;
    const partIndex = blockIndex * 2;
    const block = parts[partIndex] ?? '';
    const trimmed = block.trim();
    if (trimmed.length < 30) continue;
    if (/^#{1,6}\s/u.test(trimmed)) continue;
    if (trimmed.includes('|')) continue;
    if (/^(?:[-*+]|\d+[.、])\s/mu.test(trimmed)) continue;
    if (trimmed.replace(/\s+/gu, ' ').includes(normalizedValue)) continue;
    const separator = /[。！？；」”]$/u.test(trimmed) ? '' : '。';
    parts[partIndex] = `${block.replace(/\s+$/u, '')}${separator}${sentence}`;
    return { content: parts.join(''), blockIndex };
  }
  return undefined;
}

export async function stageFactDistribution(session: FinalizeSession): Promise<void> {
  const traces = buildDocumentFactTraces(session.finalMarkdown, session.factsModel).filter(isActionableTraceFact);
  if (traces.length === 0) return;
  const chapterBodies = () => session.finalChapterDrafts.map(chapter => ({
    chapter,
    body: (chapter.content || '').replace(/\s+/gu, ' '),
  }));

  const seenValues = new Set<string>();
  const sentenceCountByChapter = new Map<string, number>();
  const pendingByChapter = new Map<string, Array<{ value: string; sentence: string }>>();
  let distributedValues = 0;
  for (const trace of traces) {
    if (distributedValues >= MAX_DISTRIBUTION_VALUES) break;
    // C-T7（#50）：trace 值剥标签前缀后按纯值口径扩散（「招标人：XX」与正文纯值同口径匹配）
    const value = stripFactLabelPrefix(String(trace.value || '').replace(/\s+/gu, ' ').trim());
    if (!value) continue;
    if (seenValues.has(value)) continue;
    const rule = DISTRIBUTION_RULES.find(item => item.label.test(trace.label || ''));
    if (!rule) continue;
    seenValues.add(value);
    const existing = chapterBodies().filter(item => item.body.includes(value));
    if (!isDistributableValue(value, existing.length, trace.label || '')) continue;
    // 目标章：语义相关 + 不含值 + 章内句数未超限；补齐分布到 2 章
    const existingIds = new Set(existing.map(item => item.chapter.id));
    const shortfall = 2 - existing.length;
    const targets = session.finalChapterDrafts.filter(chapter =>
      rule.chapterPattern.test(chapter.title || '')
      && !existingIds.has(chapter.id)
      && (sentenceCountByChapter.get(chapter.id) ?? 0) < MAX_SENTENCES_PER_CHAPTER);
    let planned = 0;
    for (const chapter of targets) {
      if (planned >= shortfall) break;
      const hash = [...`${value}:${chapter.id}`].reduce((sum, ch) => sum + (ch.codePointAt(0) ?? 0), 0);
      const sentence = isSentenceValue(value)
        ? `${value}${/[。！？]$/u.test(value) ? '' : '。'}`
        : rule.variants[hash % rule.variants.length]!(value);
      planned += 1;
      sentenceCountByChapter.set(chapter.id, (sentenceCountByChapter.get(chapter.id) ?? 0) + 1);
      const list = pendingByChapter.get(chapter.id) ?? [];
      list.push({ value, sentence });
      pendingByChapter.set(chapter.id, list);
    }
    if (planned > 0) distributedValues += 1;
  }
  if (pendingByChapter.size === 0) return;

  const applied: string[] = [];
  const diagnostics: string[] = [];
  for (const [chapterId, list] of pendingByChapter) {
    const index = session.finalChapterDrafts.findIndex(chapter => chapter.id === chapterId);
    if (index < 0) continue;
    const draft = session.finalChapterDrafts[index]!;
    let content = draft.content || '';
    let cursor = 0;
    const insertedValues: string[] = [];
    for (const entry of list) {
      const outcome = appendReferenceSentence(content, entry.sentence, entry.value, cursor);
      if (!outcome) {
        diagnostics.push(`跳过：${draft.title}无可用正文块承载「${entry.value}」`);
        continue;
      }
      content = outcome.content;
      cursor = outcome.blockIndex + 1;
      insertedValues.push(entry.value);
    }
    if (insertedValues.length > 0) {
      session.finalChapterDrafts[index] = { ...draft, content };
      applied.push(`${draft.title}：${insertedValues.map(value => `「${value}」`).join('、')}`);
    }
  }
  if (applied.length === 0) return;

  session.finalMarkdown = session.rebuildFinalMarkdown();
  await session.recomputeFinalValidationBundle();
  const stage = displayStage({
    type: 'validation',
    roleId: 'fact-distribution',
    status: 'success',
    message: `关键事实跨章扩散：${applied.length} 个章节追加高价值事实引用，${distributedValues} 项事实补足跨章分布`,
    details: [...applied.slice(0, 12), ...diagnostics.slice(0, 4)],
  }, { subtitle: '事实跨章扩散' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
