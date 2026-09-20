/**
 * repairRounds/autoSpecGateRepair：配置必要内容缺失链尾收口轮（D-T8 配置完整性补齐，根治 #5-13/#43-49）。
 *
 * 背景：模板命中的 autoSpecGates 配置（engineeringDocumentConfigService）声明本合同类别必须出现的
 * 专业术语清单（国家法律法规/地方法规/项目特征/图纸设计说明/劳动力计划/主要施工材料/安全文明等，
 * 词表来自配置不硬编码）——r28f 实测 7 项术语缺失时，终检 planned-auto-spec-gate 报出「配置要求
 * 缺少必要内容」warning 后修复链无轮消费该类缺口直坠终门禁（autoSpecGateRequiredTexts 自落地以来
 * 零消费=哑火通道）。本轮链尾收口：全文检测零成本通过 → 缺失术语按 bigram 关联度归属到章
 *（内容驱动零硬编码：术语连续二字片段在各章正文出现总频次最高者承接，全零归首个非空章）→
 * LLM 定向补写（术语自然融入既有句或紧邻新增具体句，禁止孤立口号句；无资料依据按通用合规表述，
 * 不造数据）→ 复检该章归属术语缺失数 + 汉字数不明显减少（防删除式修复），变差即回滚。
 * 位置在 basis-regulations-repair 之后（同一编制依据段族系的链尾收口点）、toc-consistency 之前。
 */
import { plannedAutoSpecGateIssues } from '../../qualityValidation';
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import type { DocumentTemplate } from '../../types';
import type { FinalizeSession } from '../finalizeSession';

/** 每章定向修复轮上限（缺失术语可能多项：每轮补写全部缺口，复检清零即停） */
const MAX_AUTO_SPEC_REPAIR_ROUNDS = 2;

/** 检测端缺失术语 message 前缀（与 plannedAutoSpecGateIssues 报出文案单源） */
const MISSING_REQUIRED_TEXT_PREFIX = '配置要求缺少必要内容：';

function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
}

/** 缺失术语重定位（检测端同源口径：同一检测函数 + 同一 message 前缀过滤） */
function missingRequiredTerms(content: string, template: DocumentTemplate): string[] {
  return plannedAutoSpecGateIssues(content, template)
    .filter(issue => issue.message.startsWith(MISSING_REQUIRED_TEXT_PREFIX))
    .map(issue => issue.message.slice(MISSING_REQUIRED_TEXT_PREFIX.length));
}

/** 术语 → 章归属（内容驱动零硬编码）：术语连续二字片段在章内出现的总频次为关联度，最高者承接；
 * 全部零关联（全新话题术语）归首个非空章。返回按章索引分组的缺失术语（Map 保持插入序）。 */
function attributeTermsToChapters(terms: string[], chapters: Array<{ content: string }>): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  if (terms.length === 0) return groups;
  const normalizedContents = chapters.map(chapter => chapter.content.replace(/\s+/gu, ''));
  const firstNonEmpty = chapters.findIndex(chapter => chapter.content.trim().length > 0);
  for (const term of terms) {
    const normalizedTerm = term.replace(/\s+/gu, '');
    const grams: string[] = [];
    for (let index = 0; index + 1 < normalizedTerm.length; index += 1) grams.push(normalizedTerm.slice(index, index + 2));
    if (grams.length === 0) grams.push(normalizedTerm);
    let bestIndex = -1;
    let bestScore = 0;
    normalizedContents.forEach((content, index) => {
      let score = 0;
      for (const gram of grams) {
        let from = 0;
        for (;;) {
          const at = content.indexOf(gram, from);
          if (at < 0) break;
          score += 1;
          from = at + 1;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    const targetIndex = bestScore > 0 ? bestIndex : firstNonEmpty;
    if (targetIndex < 0) continue;
    const bucket = groups.get(targetIndex) ?? [];
    bucket.push(term);
    groups.set(targetIndex, bucket);
  }
  return groups;
}

export async function stageAutoSpecGateRepair(session: FinalizeSession): Promise<void> {
  // 全文术语覆盖完好：零成本通过（链尾静默，不写进度事件）
  const missingTerms = [...new Set(missingRequiredTerms(session.finalMarkdown, session.template))];
  if (missingTerms.length === 0) return;
  // 术语 → 章归属（内容驱动）：全零关联归首个非空章；无可用章（空稿异常）显性记录交终门禁
  const groups = attributeTermsToChapters(missingTerms, session.finalChapterDrafts);
  if (groups.size === 0) {
    const unlocatableStage = displayStage({ type: 'validation', roleId: 'auto-spec-gate-repair', status: 'failed', message: `配置必要内容缺失收口：全文报缺失 ${missingTerms.length} 项但无可用目标章，无定向修复目标，由终门禁照常复核`, details: missingTerms }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, unlocatableStage);
    upsertProgressStage(session.finalGateRepairStages, unlocatableStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  let repairedChapters = 0;
  for (const [index, assignedTerms] of groups) {
    const chapter = session.finalChapterDrafts[index];
    if (!chapter) continue;
    let chapterContent = chapter.content;
    let rounds = 0;
    let chapterRepaired = false;
    let anyRollback = false;
    const roleId = `agent-auto-spec-gate-repair-${chapter.id}`;
    // 轮内复检口径：本章归属术语在正文中的缺失数（检测端同源：plannedAutoSpecGateIssues 前缀过滤）
    const chapterPendingTerms = (content: string) => [...new Set(missingRequiredTerms(content, session.template))].filter(term => assignedTerms.includes(term));
    while (rounds < MAX_AUTO_SPEC_REPAIR_ROUNDS && chapterPendingTerms(chapterContent).length > 0) {
      rounds += 1;
      // 当前残留的缺失术语（每轮以最新文本重新定位，检测定位=修复定位）
      const pendingTerms = chapterPendingTerms(chapterContent);
      if (pendingTerms.length === 0) break;
      const instruction = [
        '【配置必要内容缺失定向补写】',
        '本章正文缺少合同类别配置要求必须出现的下列专业术语（正文必须逐字包含）：',
        ...pendingTerms.map(term => `- ${term}`),
        '修复要求：',
        '1. 将上述术语自然融入本章正文：结合本工程实际施工内容改写相关既有句子，或在其后紧邻新增具体句，使术语逐字出现于完整表述中；',
        '2. 禁止孤立口号句（如独立一行「本工程包含劳动力计划。」）；补写句必须有具体施工信息量并与本章主题一致；',
        '3. 不引入新的数值、日期与结论；术语涉及的具体条目按通用合规表述撰写，无资料依据不得编造具体名称或数据；',
        '4. 其余内容一字不动：不改写、不删除无关内容，不新增或删除小节标题，表格行不变。',
      ].join('\n');
      const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `配置必要内容缺失补写中（第 ${rounds}/${MAX_AUTO_SPEC_REPAIR_ROUNDS} 轮）：${chapter.title}（缺失 ${pendingTerms.length} 项）` }, { subtitle: '评审后兜底' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const outcome = await withPatchRollback({
        originalContent: chapterContent,
        repairRound: 'auto-spec-gate-repair',
        diagnostics: session.generationDiagnostics,
        apply: async () => {
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: chapter.id, title: chapter.title, content: chapterContent, evidence: chapter.evidence, missingFacts: chapter.missingFacts, sections: chapter.sections },
            issues: pendingTerms.map(term => `${MISSING_REQUIRED_TEXT_PREFIX}${term}`),
            promptTexts: instruction,
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（暗标禁表）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('auto-spec-gate-repair', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
        },
        // 指标 1：本章归属术语缺失数（越大越差）；指标 2：负汉字数（汉字数减少=删除式修复，越大越差）
        recheck: (content) => [chapterPendingTerms(content).length, -hanCount(content)],
        shouldRollback: (before, after) => after[0] > before[0] || after[1] > before[1] + Math.max(40, Math.abs(before[1]) * 0.05),
      });
      if (outcome.rolledBack) anyRollback = true;
      if (outcome.rolledBack || outcome.content === chapterContent) break;
      chapterContent = outcome.content;
      session.finalChapterDrafts[index] = { ...chapter, content: chapterContent };
      chapterRepaired = true;
      if (chapterPendingTerms(chapterContent).length === 0) break;
    }
    if (chapterRepaired) repairedChapters += 1;
    const residualTerms = chapterPendingTerms(chapterContent);
    let message: string;
    if (residualTerms.length === 0) message = `配置必要内容缺失补写完成：${chapter.title}（${rounds} 轮补写，术语覆盖检测通过）`;
    else if (chapterRepaired) message = `配置必要内容缺失补写部分生效：${chapter.title}（已执行 ${rounds} 轮，残留 ${residualTerms.length} 项缺口，由终门禁照常复核）`;
    else if (anyRollback) message = `配置必要内容缺失补写已回滚：${chapter.title}（修复复检未通过，保留修复前正文；残留 ${residualTerms.length} 项缺口，由终门禁照常复核）`;
    else message = `配置必要内容缺失补写未生效：${chapter.title}（模型未产生有效修改；残留 ${residualTerms.length} 项缺口，由终门禁照常复核）`;
    const completedStage = displayStage({ type: 'llm_review', roleId, status: residualTerms.length === 0 ? 'success' : 'failed', message, details: residualTerms.length > 0 ? residualTerms.map(term => `${MISSING_REQUIRED_TEXT_PREFIX}${term}`) : ['复检：本章配置必要术语覆盖检测通过'] }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  const residualCount = missingRequiredTerms(session.finalMarkdown, session.template).length;
  session.generationDiagnostics.llm.lastInfo = `配置必要内容缺失收口：${missingTerms.length} 项缺口定位，${repairedChapters} 章落地补写，终态残留 ${residualCount} 项（残留由终门禁照常复核）`;
}
