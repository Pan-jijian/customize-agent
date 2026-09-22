/**
 * 4.55.30 真实复算：块失守 → 整章丢弃 的实机事故（doc-1790115927170-f00280f9）。
 *
 * 事故事实（本脚本从服务落盘的 draft 与服务端评审报告读取，不写死）：
 * - 巢湖模板 3 章；第 1 章「主要施工方法与技术措施」规划 **34 个主题块**（评审报告 line「18/18 条细目
 *   任务就绪（已规划为 34 个主题块）」），仅 1 块（「主要施工内容」，密度失守）失败；
 * - 原判定链：C3 隔离重写仍失守 → C7 不适用（非篇幅类）→ 整章 throw →
 *   `draft.chapters` 只剩 2 章、`exportGate.blockingIssues` / `reviewMetadata.suspensionChecklist`
 *   出现「部分章节生成失败：1 章」，正文 33570 字（服务自述）/ 文稿 35552 字符（raw），目标 5.0 万字。
 *
 * 复算口径（诚实声明）：第 1 章**自身 33 个成功块的正文已随该次整章丢弃而不可恢复**（正是本缺陷
 * 造成的损失）——本脚本用**同一份文档里真实存在的块正文**（第 2/3 章的真实 H3 块，共 N 个不同正文）
 * 循环填充 33 个成稿槽位，并以真实失守形态（1 块密度失守 + 其真实失败原因）驱动**真实链路函数**：
 * assessChapterBlockDegradation / salvageChapterByOverProduceAcceptance / blockDeliveryOutcomeStatus /
 * chapterDegradationStageText / buildValidationIssues / buildExportGate / buildSuspensionChecklist。
 * 结论对「判定链是否保住该章、屏幕状态是否 partial、blocker 是否进终门禁与复核清单」有效；
 * 对字数增幅只具下界意义（真实 33 块正文只会更长）。
 *
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/acceptance-45530-block-degradation.manual.ts
 * 输出：.dbg/acceptance-45530-block-degradation.txt
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessChapterBlockDegradation,
  attachChapterBlockDegradation,
  buildValidationIssues,
  chapterDegradationStageText,
  readChapterBlockDegradation,
  salvageChapterByOverProduceAcceptance,
} from '@/services/document-workflow/chapterGeneration';
import { blockDeliveryOutcomeStatus } from '@/services/document-workflow/finalize/repairRounds/repairOutcome';
import { buildSuspensionChecklist } from '@/services/document-workflow/suspensionChecklist';
import { buildExportGate, classifyBlockingIssue } from '@/services/document-workflow/qualityValidation';
import { documentTextLength } from '@/services/document-workflow/budget';
import type { DocumentDraftChapter, DocumentEvidence, DocumentFactsModel } from '@/services/document-workflow/types';

const OUT: string[] = [];
const log = (line = '') => { OUT.push(line); };

const PROJECT_ID = process.env.PROJECT_ID ?? '3c3f04667c69';
const DOC_ID = process.env.DOC_ID ?? 'doc-1790115927170-f00280f9';
const LOST_CHAPTER_TITLE = '主要施工方法与技术措施';
const BASE = path.join(os.homedir(), '.customize-agent', 'projects', PROJECT_ID, 'generatedDocuments');
const DRAFT_PATH = path.join(BASE, 'drafts', `${DOC_ID}.json`);
const REPORT_PATH = path.join(BASE, 'reports', `${DOC_ID}-review.md`);

interface DraftChapterLike { id: string; title: string; content: string; sections?: string[]; evidence?: DocumentEvidence[] }
interface DraftLike {
  draft?: { chapters?: DraftChapterLike[]; markdown?: string; validationIssues?: Array<{ level?: string; message: string }> };
  chapters?: DraftChapterLike[];
  markdown?: string;
  executionStages?: Array<{ roleId?: string; status?: string; message?: string; details?: string[]; subtitle?: string }>;
  agentWorkflow?: { chapterTasks?: Array<{ title: string; sections: Array<{ title: string }> }> };
}

/** 章节 Markdown → H3 块正文（真实成稿块：`### 标题\n\n正文...`） */
function h3Blocks(content: string): Array<{ title: string; body: string }> {
  const marks = [...content.matchAll(/^###\s+(.+)$/gmu)];
  return marks.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < marks.length ? marks[index + 1]!.index! : content.length;
    return { title: match[1]!.trim(), body: content.slice(start, end).trim() };
  });
}

describe('4.55.30 真实复算：块失守不再整章丢弃（事故文档同形输入）', () => {
  it('同形输入下第 1 章不再丢失：章照常成稿 + partial + blocker 进终门禁/复核清单', () => {
    expect(fs.existsSync(DRAFT_PATH), `事故 draft 不存在：${DRAFT_PATH}`).toBe(true);
    const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8')) as DraftLike;
    const chapters = draft.draft?.chapters ?? draft.chapters ?? [];
    const stages = draft.executionStages ?? draft.draft?.chapters ? (draft.executionStages ?? []) : [];

    // ── 事故侧实测数据 ─────────────────────────────────────────────
    const failedStage = stages.find(stage => stage.status === 'failed' && (stage.message || '').includes(LOST_CHAPTER_TITLE));
    const survivingBlocks = chapters.flatMap(chapter => h3Blocks(chapter.content));
    const chapterOneTask = draft.agentWorkflow?.chapterTasks?.find(task => task.title === LOST_CHAPTER_TITLE);
    const detailTitles = (chapterOneTask?.sections || []).map(section => section.title);
    const reportText = fs.existsSync(REPORT_PATH) ? fs.readFileSync(REPORT_PATH, 'utf8') : '';
    // 事故侧篇幅 blocker（服务自述的「当前 N 字 / 目标 M 字」口径，与 wordCount 口径分开呈现）
    const lengthIssue = (draft.draft?.validationIssues ?? [])
      .find(issue => /正文长度低于字数目标|正文篇幅低于目标字数/u.test(issue.message));
    // 「N/N 条细目任务就绪（已规划为 M 个主题块）」按**本章细目数**定位（报告同页列多章，直接取首个会串章）
    const planMatch = [...reportText.matchAll(/(\d+)\/\d+\s*条细目任务就绪（已规划为\s*(\d+)\s*个主题块）/gu)]
      .find(match => Number(match[1]) === detailTitles.length);
    const plannedBlocks = planMatch ? Number(planMatch[2]) : 34;
    const plannedSource = planMatch ? `评审报告「${planMatch[0]}」` : '报告缺失按 34 回退';
    const preChars = documentTextLength(draft.draft?.markdown ?? draft.markdown ?? '');

    log('── 事故输入（服务真实落盘） ──');
    log(`文档：${DOC_ID}（模板 ${PROJECT_ID}）`);
    log(`失守章：${LOST_CHAPTER_TITLE}（规划 ${plannedBlocks} 个主题块，取自${plannedSource}；真实细目 ${detailTitles.length} 条）`);
    log(`失守块：${detailTitles.includes('主要施工内容') ? '主要施工内容（真实细目，密度失守）' : '未在细目中定位'}`);
    log(`事故成稿章数：${chapters.length}（${chapters.map(chapter => chapter.title).join(' / ')}），全文 ${preChars} 字`);
    log(`事故阻断消息：${failedStage?.message ?? '(未记录)'}`);
    log(`事故终门禁 blocker：${(draft.draft as { exportGate?: { blockingIssues?: Array<{ message: string }> } } | undefined)?.exportGate?.blockingIssues?.map(issue => issue.message).find(message => message.includes('部分章节生成失败')) ?? '(未记录)'}`);
    expect(failedStage).toBeDefined();
    expect(survivingBlocks.length).toBeGreaterThan(0);

    // ── 同形输入：33 个成稿槽位（真实块正文循环填充）+ 1 个真实失守块 ──
    const droppedIndex = Math.max(0, detailTitles.indexOf('主要施工内容'));
    const blockTitles = Array.from({ length: plannedBlocks }, (_, index) => (index === droppedIndex ? '主要施工内容' : (detailTitles[index] ?? `主题块 ${index + 1}`)));
    const sections: Array<string | undefined> = [];
    for (let index = 0; index < plannedBlocks; index += 1) {
      if (index === droppedIndex) { sections.push(undefined); continue; }
      const real = survivingBlocks[(index < droppedIndex ? index : index - 1) % survivingBlocks.length]!;
      sections.push(`### ${blockTitles[index]}\n\n${real.body}`);
    }
    const exhaustedBlocks = [{
      index: droppedIndex,
      title: '主要施工内容',
      failureKinds: ['density'],
      lastAttempt: `### 主要施工内容\n\n${survivingBlocks[0]!.body}`, // 末轮尝试（C7 才允许填回；降级路径绝不允许）
      retryFeedback: '小节事实密度需优化：量化参数落位不足（材料参数 3/5，密度 1.5 个/千字门槛未达）',
    }];
    const blockTargetWords = blockTitles.map(() => Math.round(50000 / plannedBlocks));

    // ── 判定链复算（C7 优先 → 降级接管） ────────────────────────────
    const acceptance = salvageChapterByOverProduceAcceptance({ sections, exhaustedBlocks, blockTargetWords });
    const degradation = assessChapterBlockDegradation({ sections, blockTitles, exhaustedBlocks });
    const delivered = degradation ? degradation.plannedBlocks - degradation.droppedBlocks.length : 0;
    const assembled = degradation
      ? `## ${LOST_CHAPTER_TITLE}\n\n${sections.filter((section): section is string => Boolean(section && section.trim())).join('\n\n')}`
      : undefined;

    log('');
    log('── 新判定链复算 ──');
    log(`C7 章级超产对冲接纳：${acceptance ? `接纳（${acceptance.detail}）` : '拒收（失守类别非篇幅类 over-produce）'}`);
    log(`4.55.30 显式降级：${degradation ? '成立' : '不成立'}`);
    expect(acceptance).toBeUndefined();
    expect(degradation).toBeDefined();
    expect(assembled).toBeDefined();
    expect(delivered).toBe(33);

    const stageText = chapterDegradationStageText(degradation!);
    const stageStatus = blockDeliveryOutcomeStatus({ plannedBlocks: degradation!.plannedBlocks, droppedBlocks: degradation!.droppedBlocks.length });
    log(`章成稿：${delivered}/${plannedBlocks} 块，本章 ${documentTextLength(assembled!)} 字（事故前该章 0 字）`);
    log(`阶段状态：${stageStatus}（黄灯=有净损失但章已产出）`);
    log(`阶段消息：${LOST_CHAPTER_TITLE} 已由大模型成稿：当前 ${documentTextLength(assembled!)} 字；${stageText.head}`);
    log('阶段明细：');
    for (const line of stageText.details) log(`  · ${line}`);
    log(`失守块末轮尝试是否混入正文：${assembled!.includes(exhaustedBlocks[0]!.lastAttempt) ? '是（缺陷）' : '否（正确）'}`);
    log(`失守块标题是否出现在正文小节：${h3Blocks(assembled!).some(block => block.title === '主要施工内容') ? '是（缺陷）' : '否（正确）'}`);
    expect(stageStatus).toBe('partial');
    expect(assembled!).not.toContain(exhaustedBlocks[0]!.lastAttempt);
    expect(h3Blocks(assembled!).map(block => block.title)).not.toContain('主要施工内容');

    // ── 终门禁 + 复核清单 ─────────────────────────────────────────
    const draftChapter: DocumentDraftChapter = attachChapterBlockDegradation(
      { id: 'explicit-提示词角色-1', title: LOST_CHAPTER_TITLE, content: assembled!, evidence: [], missingFacts: [], sections: blockTitles },
      degradation!,
    );
    // 事故文档真实成稿章（证据取自落盘文档，使门禁 checklist 的确定性判据按真实情况成立）+ 复算降级章
    const incidentDraftChapters: DocumentDraftChapter[] = chapters.map(chapter => ({ id: chapter.id, title: chapter.title, content: chapter.content, evidence: chapter.evidence || [], missingFacts: [], sections: chapter.sections || [] }));
    draftChapter.evidence = incidentDraftChapters[0]?.evidence || [];
    const stubFactsModel = {
      project: [{ key: '项目名称', value: '（复算桩）', sourceFile: '（复算桩）' }],
      schedule: [], quality: [], safety: [], preciseFacts: [], conflicts: [],
    } as unknown as DocumentFactsModel;
    const issues = buildValidationIssues({ warnings: [], errors: [] }, stubFactsModel, [...incidentDraftChapters, draftChapter]);
    const degradationIssues = issues.filter(issue => issue.provenance?.detectorId === 'chapter-block-degradation');
    log('');
    log('── 交付侧 ──');
    log(`buildValidationIssues 产出降级 blocker：${degradationIssues.length} 条`);
    for (const issue of degradationIssues) {
      log(`  message：${issue.message}`);
      log(`  suggestion：${issue.suggestion}`);
      log(`  分类：level=${issue.level} severity=${issue.severity} category=${issue.category} repairability=${issue.repairability} chapterId=${issue.chapterId} sectionTitle=${issue.sectionTitle}`);
      expect(issue.severity).toBe('blocker');
      expect(issue.category).toBe('structure');
      expect(issue.repairability).toBe('manual_review');
      expect(issue.message).toContain('主要施工内容');
      expect(issue.message).toContain('密度');
    }
    // 真导出门禁（buildExportGate 实函数）：降级 blocker 必须被判为阻断项并进终门禁清单
    const gate = buildExportGate(issues, stubFactsModel, [...incidentDraftChapters, draftChapter]);
    const gateHit = gate.blockingIssues.filter(issue => issue.provenance?.detectorId === 'chapter-block-degradation');
    log(`导出门禁：passed=${gate.passed}，blockingIssues=${gate.blockingIssues.length}，其中降级 blocker ${gateHit.length} 条（分类器判定：${degradationIssues.every(issue => classifyBlockingIssue(issue)) ? '阻断' : '未阻断（缺陷）'}）`);
    expect(gateHit.length).toBe(1);
    expect(degradationIssues.every(issue => classifyBlockingIssue(issue))).toBe(true);
    const checklist = buildSuspensionChecklist(draftChapter ? degradationIssues : [], [...chapters, draftChapter].map(chapter => ({ id: chapter.id, title: chapter.title })));
    log(`交付复核清单条目：${checklist.items.length} 条`);
    for (const item of checklist.items) log(`  [${item.index}] ${item.category}｜${item.location}｜${item.problem.slice(0, 120)}｜修复路径：${item.repairPath}`);
    expect(checklist.items.length).toBe(1);
    expect(readChapterBlockDegradation(draftChapter)).toBeDefined();

    // ── 前后对比（结构性收益 + 字数区间） ──────────────────────────
    const postChars = preChars + documentTextLength(assembled!);
    const gapCharMatch = (lengthIssue?.message || '').match(/当前\s*(\d+)\s*字，目标不少于\s*(\d+)\s*字/u);
    const gapFrom = gapCharMatch ? Number(gapCharMatch[1]) : preChars;
    const gapTo = gapCharMatch ? Number(gapCharMatch[2]) : 50000;
    log('');
    log('── 事故前 / 复算后（同形输入） ──');
    log(`章节数：${chapters.length} → ${chapters.length + 1}（${LOST_CHAPTER_TITLE} 回归）`);
    log(`章状态：failed（整章丢弃） → partial（${delivered}/${plannedBlocks} 块成稿、丢弃 1 块）`);
    log(`阻断口径：全章丢弃（«部分章节生成失败：1 章»，修复轮无从下手） → 单块缺口 blocker（含标题+原因+缺陷反馈，可定向补写）`);
    log(`字数（区间口径，真值不可考——33 块正文已随该次丢弃不可恢复，这正是被修复的损失本身）：`);
    log(`  · 上界（真实块正文循环填充，${survivingBlocks.length} 个真实块循环）：全文 ${preChars} → ${postChars} 字`);
    log(`  · 按文档篇幅缺口等分块预算（(${gapTo}−${gapFrom})/${plannedBlocks} ≈ ${Math.ceil((gapTo - gapFrom) / plannedBlocks)} 字/块）：全文 ${gapFrom} → ≈${gapFrom + (gapTo - gapFrom)} 字，回到目标线 ${gapTo} 字`);
    log(`  · 事故篇幅 blocker：${lengthIssue ? lengthIssue.message : '(未记录)'}`);

    // ── 负向边界：全失败仍整章阻断（零放松） ────────────────────────
    const allFailedSections: Array<string | undefined> = blockTitles.map(() => undefined);
    const allFailedExhausted = blockTitles.map((title, index) => ({ index, title, failureKinds: ['density'] }));
    const allFailedAcceptance = salvageChapterByOverProduceAcceptance({ sections: allFailedSections, exhaustedBlocks: allFailedExhausted, blockTargetWords });
    const allFailedDegradation = assessChapterBlockDegradation({ sections: allFailedSections, blockTitles, exhaustedBlocks: allFailedExhausted });
    log('');
    log('── 负向边界（同一文档同形输入，全 34 块失守） ──');
    log(`C7：${allFailedAcceptance ? '接纳（缺陷）' : '拒收'}；降级：${allFailedDegradation ? '成立（缺陷）' : '不成立（照旧整章阻断）'}；组装正文：${allFailedDegradation ? '有（缺陷）' : '无'}`);
    expect(allFailedDegradation).toBeUndefined();

    const outPath = path.resolve(process.cwd(), '.dbg', 'acceptance-45530-block-degradation.txt');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, OUT.join('\n'), 'utf8');
  }, 300_000);
});
