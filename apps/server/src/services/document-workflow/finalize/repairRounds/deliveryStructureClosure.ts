/**
 * repairRounds/deliveryStructureClosure：交付结构收口轮（FINALIZE_REPAIR_ROUNDS: delivery-structure-closure）。
 * D-T6 ①③（r28f 门禁 #1 与 warningIssues 长段归因）：
 * ① 目录↔正文一一对应——fixTocFromBody 原调用点在 postReviewSurface（链中段），其后
 *    length-compression-repair / fact-distribution-round / table-caption-repair /
 *    table-arithmetic-repair / empty-section-sweep / section-alignment-sweep 的 rebuild 均可改变
 *    正文 H3 结构（r28f 实测目录 29 节 vs 正文 28 节直坠门禁），链尾以正文实际结构重建目录
 *    （无改动时零成本静默）；
 * ② 过长段落 0——splitOverlengthBodyParagraphs 对 >380 行的链尾切分（写作期 splitLongParagraphs
 *    仅覆盖写作期，链尾 rebuild 与 LLM 补写句拼接引入的超长行无收口点）。
 * 两操作均为 markdown-only（不改章 drafts、不 rebuild），位于链尾 markdown-only 重放
 * （runSurfaceDeterministicCleans / replayBlueprintCitationNumericFixes / replayRequirementTailClosure）
 * 之后、stageFinalGate 之前——终门禁所检 = 交付所存 = 收口后成稿。
 */
import { cleanAppendixInternalPhrases } from '../../composeAppendices';
import { missingPlannedSections, promotePlannedSectionHeadings } from '../../chapterPostProcessing';
import { fixTocFromBody } from '../../documentIntegrityChecks';
import { splitOverlengthBodyParagraphs } from '../../helpers/markdownCleanup';
import { displayChapterTitle } from '../../outline';
import { renumberSectionHeadings } from '../../structureIntegrityRules';
import { applyOverridesToText } from '../../valueOverride';
import { displayStage, upsertProgressStage } from '../../progress';
import { recordRepairActions } from '../../rolePipeline';
import type { FinalizeSession } from '../finalizeSession';

/**
 * 4.59 A2 空壳规划标题**链尾强制清除**（不变量强制，判据复用不另造）。
 *
 * ## 实测（7/7 份真实归档 100% 复现，`pipelineInvariants.manual.ts` INV-1 跟踪）
 *
 * | 文档 | 草稿级空壳 | 终稿级空节 |
 * |---|---|---|
 * | cfb0 / ea38 / ea52 | 0 | 3 |
 * | 4456 | 0 | 4 |
 *
 * **草稿阶段一个空壳都没有、终稿却有 3~4 个**——即**装配/收口步骤把父标题掏空**，而缺节补写轮
 * 跑在**草稿**阶段，结构上就看不到它们，因此永远补不到、必然残留到终稿。
 * 典型形态（真实终稿）：
 * ```
 * ### 1.2 作业面勘察与条件核实      ← 空
 * ### 1.3 现场踏勘                 ← 有正文（草稿里它本是 1.2 的 H4 子节）
 * ```
 *
 * ## 为什么在这里清除而不去补写
 *
 * 补写轮只能作用于**章草稿**，而问题出现在**终稿 markdown**（草稿里父标题下有 H4 子节、判据认为"有内容"）。
 * 要把补写前移需要把 markdown 结构差异写回草稿——改动面远大于本处所需，且该差异的产生点
 *（装配层把 H3 父 + H4 子展开为同级 H3）尚未定位到可安全修改的单点。
 *
 * 故按本仓**既定口径**处理（4.55.25：*「没有内容就不要出现该标题」*）：
 * **清除空壳标题行**——文档不再出现幻影标题与幻影目录项；终检随后报出的
 * 「规划小节未落位」是**准确**表述（该小节确实没有内容），且属缺节补写轮可消费的类别，
 * 下一轮即可定向补写。**这不是把 blocker 藏起来**：blocker 由「空小节」变为「规划小节未落位」，
 * 数量不变、语义更准确、且**可被修复链消费**（空小节原本消费不了）。
 *
 * ## 判据单源
 *
 * 判空口径与 `structureIntegrityRules.scanEmptySubsections` **逐字同源**（下一非空行为同级/更高级标题
 * 即空），不另造第四套判据——本仓已有三套口径不一致的空节判据（见 `plan-4.59-complete.md` §二 A2），
 * 再造一套只会加深分裂。
 */
function dropEmptyShellHeadingsOnce(markdown: string): { markdown: string; dropped: string[] } {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const dropped: string[] = [];
  const keep: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{3,6})\s+(\S.*)$/u.exec((lines[index] || '').trim());
    if (!heading) { keep.push(lines[index] ?? ''); continue; }
    const level = heading[1]!.length;
    let next = index + 1;
    while (next < lines.length && (lines[next] || '').trim() === '') next += 1;
    const nextHeading = next < lines.length ? /^(#{1,6})\s+\S/u.exec((lines[next] || '').trim()) : null;
    const isEmpty = next >= lines.length || Boolean(nextHeading && nextHeading[1]!.length <= level);
    if (!isEmpty) { keep.push(lines[index] ?? ''); continue; }
    dropped.push(heading[2]!.trim());
    // 连同该标题行之后的空行一并吞掉，避免留下连续空行
    while (index + 1 < lines.length && (lines[index + 1] || '').trim() === '') index += 1;
  }
  if (dropped.length === 0) return { markdown, dropped };
  return { markdown: keep.join('\n').replace(/\n{3,}/gu, '\n\n'), dropped };
}

/**
 * 空壳标题清除的**不动点包装**（4.60 A2 修正）。
 *
 * ## 为什么必须迭代
 *
 * 删除一个空壳可能会**把它的父标题也变成空壳**。实测（`doc-1788729700062-ec006981` 施工总平面布置图章）：
 * ```
 * ### 竣工清理、验收移交与保修      ← 靠下面的 H4 子节撑住，本不算空
 * #### 保修责任与回访安排           ← 空壳（无正文）
 * ### 施工总平面布置原则与分区管理
 * ```
 * 删掉 `#### 保修责任与回访安排` 后，父 H3 与下一个 H3 之间再无内容 → **父标题变成新的空壳**。
 * 单趟实现因此留下残留（真实语料批量回放抓到：清除后仍有 1 处空壳）。
 *
 * 故迭代至不动点：每趟至少删除一个标题，故必然收敛（上限 8 趟；极端不收敛时保留现状，
 * 由「清除后不得有空壳」的验收断言暴露，不静默）。
 */
export function dropEmptyShellHeadings(markdown: string): { markdown: string; dropped: string[] } {
  let current = markdown;
  const dropped: string[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const result = dropEmptyShellHeadingsOnce(current);
    if (result.dropped.length === 0) break;
    dropped.push(...result.dropped);
    current = result.markdown;
  }
  return { markdown: current, dropped };
}

export async function stageDeliveryStructureClosure(session: FinalizeSession): Promise<void> {
  const details: string[] = [];
  // C2 D4 兜底复洗：附表区内部推导话术确定性中性化（幂等；源头已在 composeTenderAppendixMarkdown 出口净版，
  // 此处收口链中段 rebuild/LLM 补写句再引入的附表区话术）
  const cleaned = cleanAppendixInternalPhrases(session.finalMarkdown);
  let repairActions = 0;
  if (cleaned !== session.finalMarkdown) {
    session.finalMarkdown = cleaned;
    repairActions += 1;
    details.push('附表区内部话术清洗：内部推导口径已中性化（唯一口径/经验工效区间/清单批注等）');
  }
  // 4.55.14 章级规划小节落位收口（巢湖实测：用户 OUTLINE 固定小节被降级写成块内 H4 或整节漏写）：
  // 按章定位正文区间，把与规划小节逐字同名的 H4/H5 就地提升为 H3；真正缺失的登记进 details 供复核。
  {
    const chapterPlans = (session.effectiveChapters || []).map(chapter => ({ title: displayChapterTitle(chapter.title), sections: (chapter.sections || []).filter(Boolean) }));
    if (chapterPlans.length > 0) {
      const lines = session.finalMarkdown.split(/\r?\n/u);
      const h2Indexes: Array<{ index: number; title: string }> = [];
      lines.forEach((line, index) => {
        const heading = /^##\s+(.+?)\s*$/u.exec(line.trim());
        if (heading && !/^(目录|附表)/u.test(heading[1])) h2Indexes.push({ index, title: heading[1].replace(/\s+/gu, '') });
      });
      let promotedTotal = 0;
      const missingAll: string[] = [];
      for (let order = chapterPlans.length - 1; order >= 0; order -= 1) {
        const plan = chapterPlans[order];
        const normalizedTitle = plan.title.replace(/\s+/gu, '');
        const start = h2Indexes.find(item => item.title.includes(normalizedTitle) || normalizedTitle.includes(item.title));
        if (!start) continue;
        const next = h2Indexes.find(item => item.index > start.index);
        const end = next ? next.index : lines.length;
        const block = lines.slice(start.index + 1, end).join('\n');
        const result = promotePlannedSectionHeadings(plan.sections, block);
        if (result.promoted.length === 0 && result.missing.length === 0) continue;
        if (result.promoted.length > 0) {
          lines.splice(start.index + 1, end - start.index - 1, ...result.markdown.split(/\r?\n/u));
          promotedTotal += result.promoted.length;
          details.push(`规划小节层级提升：${plan.title}（${result.promoted.join('、')}）`);
        }
        if (result.missing.length > 0) missingAll.push(`${plan.title}：${result.missing.join('、')}`);
      }
      if (promotedTotal > 0) {
        session.finalMarkdown = lines.join('\n');
        repairActions += promotedTotal;
      }
      if (missingAll.length > 0) details.push(`规划小节未落位（交终门禁复核）：${missingAll.join('；')}`);
    }
  }
  // 4.59 A2 空壳规划标题链尾清除（**必须在层级提升之后**：提升正是掏空父标题的动作之一；
  // **必须在目录重建之前**：否则幻影标题会被写进目录，目录与正文再度不一致）
  {
    const shellResult = dropEmptyShellHeadings(session.finalMarkdown);
    if (shellResult.dropped.length > 0) {
      session.finalMarkdown = shellResult.markdown;
      repairActions += shellResult.dropped.length;
      details.push(`空壳标题清除（无直接正文且下一行为同级/更高级标题）：${shellResult.dropped.slice(0, 8).join('、')}${shellResult.dropped.length > 8 ? ` 等 ${shellResult.dropped.length} 处` : ''}——按 4.55.25 口径「没有内容就不要出现该标题」，规划小节缺节由终检「规划小节未落位」如实报出并交缺节补写轮`);
    }
  }

  // ③ 超长段落切分先于目录重建：切分不改标题行，目录重建基于切分后正文（同一次 recompute 收口）
  const split = splitOverlengthBodyParagraphs(session.finalMarkdown);
  if (split.markdown !== session.finalMarkdown) {
    session.finalMarkdown = split.markdown;
    repairActions += split.splitCount;
    details.push(`超长段落切分：消除 >380 字符段落 ${split.splitCount} 处`);
  }
  // 4.55.20 现行口径链尾确定性落地（真值层 superseded → effective）：实测缺陷——真值层诊断出
  // 「正文 4 处仍以被取代值 365日历天 作为现行口径」，但该检测器为 manual（不自动修复）→ 只进人工清单、
  // 正文照旧。链尾按覆盖表**确定性替换**（引用变更过程形态豁免：如「原为365日历天，现澄清为330日历天」保留）
  {
    const overrides = (session.truthValues || []).flatMap(item => (item.superseded || []).map(superseded => ({
      superseded,
      effective: item.value,
      scope: [item.attribute],
      evidence: item.evidence,
      kind: 'override' as const,
    })));
    if (overrides.length > 0) {
      const applied = applyOverridesToText(session.finalMarkdown, overrides);
      if (applied.applied.length > 0) {
        session.finalMarkdown = applied.text;
        repairActions += applied.applied.length;
        details.push(`现行口径落地：${applied.applied.length} 处（${[...new Set(applied.applied.map(item => `${item.from}→${item.to}`))].slice(0, 3).join('、')}）`);
      }
    }
  }
  // 4.55.19 小节编号重放（链尾）：小节被合并/删除后编号出现空档（实测「1.1 → 1.2 → 1.4」缺 1.3），
  // 评标人一眼可见。此前 section-renumber 只在确定性清洗链内执行，其后的修复轮（主题小节合并等）
  // 删除小节后无人重放 → 链尾补一次原子重放（幂等：无空档零改动）
  {
    const renumbered = renumberSectionHeadings(session.finalMarkdown);
    if (renumbered.fixedCount > 0) {
      session.finalMarkdown = renumbered.markdown;
      repairActions += renumbered.fixedCount;
      details.push(`小节编号重放：${renumbered.fixedCount} 处（删除/合并小节后的编号空档收口）`);
    }
  }
  // ① 目录按正文实际 H2/H3 结构重建（与 tocBodyConsistencyIssues 检测口径同源）
  const toc = fixTocFromBody(session.finalMarkdown);
  if (toc.fixedCount > 0) {
    session.finalMarkdown = toc.markdown;
    repairActions += toc.fixedCount;
    details.push(...toc.details);
  }
  // G 线 P2-4：交付结构收口动作计量（此前只进进度文案）
  recordRepairActions(session.generationDiagnostics, repairActions);
  const changed = details.length > 0;
  const stage = displayStage({
    type: 'validation',
    roleId: 'delivery-structure-closure',
    status: 'success',
    message: changed
      ? `交付结构收口：${details.join('；')}`
      : '交付结构收口核对通过：目录与正文一致、无超长段落',
    details: changed ? details : undefined,
  }, { subtitle: '交付结构收口' });
  upsertProgressStage(session.progressStages, stage);
  upsertProgressStage(session.finalGateRepairStages, stage);
  if (changed) await session.recomputeFinalValidationBundle();
  session.emitProgress(session.finalChapterDrafts, session.progressStages);
}
