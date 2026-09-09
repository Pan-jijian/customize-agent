/**
 * repairRounds/tableRepair：表格数据完整性修复轮（FINALIZE_REPAIR_ROUNDS: table-repair-round）。
 * P2 拆分（方案 5.2）：由 finalizeGeneration 代码块机械搬迁而来，业务语义逐字一致（行为保持）。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { markdownTableQualityIssues } from '../../qualityValidation';
import { tuningProfile } from '../../tuningProfile';
import { finalizeChapterContentQuality } from '../../documentGeneratorHelpers';
import { extractTableBlockByAnchor, repairTableBlockDeterministically } from '../../tableRepairHelpers';
import type { FinalizeSession } from '../finalizeSession';

export async function stageTableRepair(session: FinalizeSession): Promise<void> {
  // 表格数据完整性修复轮（T1-2）：空单元格/占位符/列数不一致等表格 error 硬阻断导出（十度实测缺陷：
  // 竣工清理计划表末列为空、临时用电表“—/若干/约82kW”占位）。修复链路：定位章节 → 注入缺陷表格原文 patch 修复
  // → 确定性兜底（4.17.8 删除升级指令二修：每缺陷单次尝试，失败即放弃）。
  const tableDefectIssues = markdownTableQualityIssues(session.finalMarkdown).filter(issue => issue.level === 'error' && /空单元格|占位符单元格|列数不一致|分隔线位置不规范/u.test(issue.message));
  if (tableDefectIssues.length > 0) {
    let tableFixPatches = 0;
    // D2：按章分组 + 跨章并行——同章表格组内串行（每表独立修复闭环，组内后表以最新章内容为输入），
    // 跨章组批量并行（指令生成并行，限幅 DOCUMENT_TABLE_FIX_CONCURRENCY，默认 2）；每章单写者零覆盖
    const tableGroups: Array<Array<{ chapterIndex: number; issueIndex: number; message: string; suggestion: string; tableAnchor: string; rowAnchor: string }>> = [];
    const tableGroupIndexByChapter = new Map<number, number>();
    for (let issueIndex = 0; issueIndex < tableDefectIssues.length; issueIndex += 1) {
      const issue = tableDefectIssues[issueIndex];
      // 双锚点定位章节：表头第一列（表名或首个业务列）+ 缺陷行首列。
      // 单锚点历史缺陷：“竣工清理与移交计划表”作为表头首格时按首列锚点定位，在聚合章（人材机保障章）中
      // 命中错误目标或无法与表格所在章节对应；补行首列锚点后两者必须同现于同一章节草稿才进入修复
      const tableAnchor = (issue.message.split('：')[1] || '').split('（')[0]?.split('、')[0] || '';
      const rowAnchor = /（[“"']?([^”"'）)]{2,30})[”"']?行/u.exec(issue.message)?.[1] || '';
      const chapterIndex = tableAnchor
        ? session.finalChapterDrafts.findIndex(chapter => {
            const content = chapter.content || '';
            return content.includes(tableAnchor) && (!rowAnchor || content.includes(rowAnchor));
          })
        : -1;
      if (chapterIndex < 0) continue;
      const entry = { chapterIndex, issueIndex, message: issue.message, suggestion: issue.suggestion || '', tableAnchor, rowAnchor };
      const existingIndex = tableGroupIndexByChapter.get(chapterIndex);
      if (existingIndex === undefined) {
        tableGroupIndexByChapter.set(chapterIndex, tableGroups.length);
        tableGroups.push([entry]);
      } else {
        tableGroups[existingIndex].push(entry);
      }
    }
    const tableFixConcurrency = Math.max(1, Math.min(4, tuningProfile().tableFixConcurrency || 2));
    for (let groupOffset = 0; groupOffset < tableGroups.length; groupOffset += tableFixConcurrency) {
      const batch = tableGroups.slice(groupOffset, groupOffset + tableFixConcurrency);
      await Promise.all(batch.map(async entries => {
        for (const { chapterIndex, issueIndex, message, suggestion, tableAnchor, rowAnchor } of entries) {
          // 组内后表以最新章内容为输入（含此前已落位的同章表格 patch），与改造前 per-table 串行语义一致
          const draftChapter = session.finalChapterDrafts[chapterIndex];
          const templateChapter = session.effectiveChapters.find(chapter => chapter.id === draftChapter.id || chapter.title === draftChapter.title);
          const runningStage = displayStage({ type: 'llm_review', roleId: `agent-table-fix-${draftChapter.id}-${issueIndex}`, status: 'running', message: `正在修复表格数据缺失：${draftChapter.title}`, details: [message] }, { subtitle: '表格数据修复' });
          upsertProgressStage(session.progressStages, runningStage);
          upsertProgressStage(session.finalGateRepairStages, runningStage);
          session.emitProgress(session.finalChapterDrafts, session.progressStages);
          // 缺陷表格原文必须注入指令：从章节草稿提取（优先），章节草稿缺失时退回最终产物提取。
          // 历史失效根因：指令只有“表头+行名”，LLM 在 2 万字聚合章中无法定位表格 → patch 全部落空
          const defectTableBlock = extractTableBlockByAnchor(draftChapter.content, tableAnchor) || extractTableBlockByAnchor(session.finalMarkdown, tableAnchor) || '';
          const tableFixInstruction = [
            '【表格数据完整性定向修复】',
            '下列表格存在数据缺失缺陷：正式交付文档的表格不得出现空单元格，也不得用“—/若干/约/待定”等占位或模糊表达代替具体数据。',
            `缺陷表格原文（只允许修改这一张表，逐格修复；不得改动其他表格与小节）：\n${defectTableBlock.slice(0, 2000)}`,
            '请以局部 patch 方式修复该表格：每一列都必须有具体数据值。数据优先取自本章正文与证据摘要；正文与证据未直接给出时，按施工组织设计专业惯例给出具体数值或明确口径（如按班组工具配置估算台数），并保持数值单位一致、行列表头对齐。',
            '若表格首行就是分隔线（缺表头行），必须依据表格数据内容补写一行业务表头（每列一个业务字段名），再紧跟分隔线；表头不得使用泛化字段名。',
            '合计/小计/总计/累计行的空单元格一律填“—”（不适用语义）；规格型号列中无规格型号的小型机具（蛙式打夯机等）可填“—”（机具无型号，合法）；其余单元格一律不得为空、不得用占位符，不得凭空编造型号。',
            '若表头第一列是表名（如“竣工清理与移交计划表”），把表名移到表格上方正文叙述中，表头从业务列名开始，并同步校正数据行列对齐。',
            '保持表头结构与列数不变，不得新增、删除或合并小节；只修改缺陷表格相关局部文本。',
          ].join('\n');
          // P12 回滚保护：修复后同源复检该表锚点下的缺陷行残留数（与既有行级判定同口径），
          // 缺陷不降反升（LLM 修坏同表其他行）即回滚保留修复前正文
          const tableFixOutcome = await withPatchRollback({
            originalContent: draftChapter.content,
            repairRound: 'table-repair',
            diagnostics: session.generationDiagnostics,
            apply: async () => {
              const repairedTable = await session.withProgressHeartbeat(() => repairChapterByQuality({
                template: session.template,
                chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
                issues: [message, suggestion],
                promptTexts: tableFixInstruction,
                requirement: session.requirement,
                forbidDrawingImages: false,
                diagnostics: session.generationDiagnostics,
                signal: session.signal,
                patchGuard: repairPatchGuard('table-repair', session.generationDiagnostics),
              }));
              const nextContent = repairedTable.content || draftChapter.content;
              // 4.17.8 升级指令二修删除：每缺陷单次尝试（失败即放弃）——二修轮是修复 token 主力军的组成部分，
              // 首次失败后直接确定性兜底，残留缺陷转导出门禁阻断
              // 确定性兜底（LLM 单修失败的最后防线）：合计行空填“—”、表名占格归一、全空列删列、零星空单元格删行，
              // 只做不引入新错误的确定性操作（检测器豁免合计行“—”），无缺陷表格原样返回
              const deterministic = repairTableBlockDeterministically(nextContent, tableAnchor);
              return deterministic.content;
            },
            // 行级同源复检：仅统计该表头锚点下的同类缺陷（其他表的残留缺陷由导出门禁阻断，不在此重复判定）
            recheck: (content) => [markdownTableQualityIssues(content).filter(item => item.level === 'error' && /空单元格|占位符单元格|列数不一致/u.test(item.message) && item.message.includes(tableAnchor) && (!rowAnchor || item.message.includes(rowAnchor))).length],
          });
          const nextContent = tableFixOutcome.content;
          if (!tableFixOutcome.rolledBack && nextContent !== draftChapter.content) {
            session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: templateChapter ? finalizeChapterContentQuality(nextContent, templateChapter) : nextContent };
            tableFixPatches += 1;
          }
          // 修复结果判定：同源复检该表头锚点下的原缺陷行是否仍存在表格数据缺陷。
          // 行级判定（4.19 真实回归）：此前按「表头锚点表内任一占位符残留」判整表失败——LLM 按指令只修
          // 原缺陷行（钢筋行 420t/批），同表其他行的同类缺陷（砌体行约650m³/批）导致已修复节点误判
          // 「未生效」（5-2/6-3/6-4 三节点 failed，前两版全成功）。原缺陷行不再检出同类缺陷即视为修复
          // 成功；同表其他行的残留缺陷由导出门禁阻断，不在此重复判定（回滚同样视为未生效）
          const stillDefective = tableFixOutcome.rolledBack || tableFixOutcome.afterMetrics[0] > 0;
          const completedTableStage = displayStage({ type: 'llm_review', roleId: `agent-table-fix-${draftChapter.id}-${issueIndex}`, status: stillDefective ? 'failed' : 'success', message: tableFixOutcome.rolledBack ? `表格数据修复已回滚：${draftChapter.title}（修复后缺陷增多，保留修复前正文）` : stillDefective ? `表格数据修复未生效：${draftChapter.title}` : `表格数据修复完成：${draftChapter.title}`, details: [message] }, { subtitle: '表格数据修复' });
          upsertProgressStage(session.progressStages, completedTableStage);
          upsertProgressStage(session.finalGateRepairStages, completedTableStage);
          session.emitProgress(session.finalChapterDrafts, session.progressStages);
        }
      }));
    }
    if (tableFixPatches > 0) {
      session.finalMarkdown = session.rebuildFinalMarkdown();
      await session.recomputeFinalValidationBundle();
    }
  }}
