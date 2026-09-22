/**
 * repairRounds/basisRegulationsRepair：编制依据小节法规/规范漏列链尾收口轮（丰乐镇实机终门禁归因：门禁 #8）。
 *
 * 背景：编制依据小节 LLM 有时漏写具体法规/规范清单——丰乐镇实测编制依据段法律法规/地方性法规
 * 齐全、零施工验收规范编号，终检 basisRegulationsCoverageIssues 报「编制依据小节缺少施工验收
 * 规范条目」blocker 后，修复链无任何轮消费该类 blocker（检测器自 4.31 落地以来无修复轮锚定），
 * 同根因直坠终门禁。本轮链尾收口：全文检测零成本通过 → 章级计数定位漏列章 → LLM 定向补列
 * 缺失类目条目（照抄招标文件引用法规 + 按本工程分部分项选列现行施工验收规范名称及编号）→
 * 复检缺失类目数恢复 + 汉字数不明显减少（防删除式修复），变差即回滚。
 * 位置在 quotation-balance-repair 之后（同一编制依据段族系的链尾收口点：引文成对性 → 法规覆盖）、
 * toc-consistency 之前。章级均通过而全文报出（编制依据标题位于章外结构）时显性记录交终门禁，
 * 不得猜测改写。
 */
import { repairOutcomeReason, repairOutcomeStatus } from './repairOutcome';
import { basisRegulationsCoverageIssues, extractBasisRegulationSection } from '../../qualityValidation';
import { REGULATION_CODE_RE } from '../../basisRegulationsCross';
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import type { FinalizeSession } from '../finalizeSession';

/** 每章定向修复轮上限（缺失类目可能多类：每轮补列全部缺口，复检清零即停） */
const MAX_BASIS_REPAIR_ROUNDS = 2;

// 上限治理：原 `MAX_BLUEPRINT_REGULATION_ITEMS = 12`（且**每轮都重取前 12 条**同一批）已删除——
// 第 13 条起的招标文件引用法规**永不出现在修复指令**中，而检测端只在「全漏」时报出、部分漏列不逐条报
// ⇒ 部分法规漏列永远无人补。法规名+文号本身极短，全量列入对 prompt 的影响可忽略。

function hanCount(text: string): number {
  return (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
}

/** 缺口类别：与 `qualityValidation.basisRegulationsCoverageIssues` 的检出类型一一对应（五类 + 空章） */
type BasisGapKind = 'all' | 'tender' | 'law' | 'regulation' | 'standard' | 'local';

/**
 * 缺口分类（**类别词**判据：无任何具体法规名/地名；与检测器消息口径的耦合由单测锁定，
 * 检测器新增类目时用例即失败，不会静默漂移）。
 */
function classifyBasisGap(issue: { message: string; suggestion?: string }): BasisGapKind {
  const text = `${issue.message}${issue.suggestion || ''}`;
  // 顺序即优先级：『全漏』建议里同时点到国家法律法规/地方法规规章，先判；地方类消息含「条例」故先于条例类
  if (/五类依据|五类逐项|无从逐项列全/u.test(text)) return 'all';
  if (/招标文件引用法规/u.test(text)) return 'tender';
  if (/地方性法规|地方性条例/u.test(text)) return 'local';
  if (/国家法律法规|具体法律名称/u.test(text)) return 'law';
  if (/施工验收规范|规范标准|名称及编号/u.test(text)) return 'standard';
  if (/条例/u.test(text)) return 'regulation';
  return 'all';
}

/** 各类缺口的补列口径（类目、形态、来源均为机制化表述：属地=工程所在地，编号=项目资料可查） */
const GAP_GUIDANCE: Record<BasisGapKind, string> = {
  all: '按五类依据逐项列全（招标文件及补疑补遗、国家法律法规、国家/行业现行规范标准、地方法规规章、企业管理体系），每类至少 1 条具体名称，不得以类别话术代替；',
  tender: '招标文件引用法规条目：按招标文件原文照抄名称与文号（含答疑澄清文件）；',
  law: '国家法律法规条目：逐条写出具体法律名称（《…法》形态），不得以「国家现行法律、行政法规」类别话术代替；',
  regulation: '条例/办法条目：逐条写出具体条例名称与发布令号；',
  standard: '施工验收规范条目：按本工程分部分项列出**现行**规范名称与编号（名称＋编号—年号）；编号必须能在项目资料（招标文件/清单/图纸/设计说明）中找到，查不到的编号视为编造；',
  local: '地方性法规与政府规章条目：按工程所在地属地（省/直辖市/设区的市）写出**现行**地方性法规及政府规章名称，名称须含工程所在地地名，不得以「地方法规规章」类别话术代替；',
};

/**
 * 补写锚点（append 模式）：编制依据区段内**最后一条**「含书名号、非标题、非表格行」的条目行原文；
 * 该行须在整章内唯一（锚点替换按全文等价匹配执行，非唯一会把补写内容插到别处）。
 * 找不到合格锚点时返回 undefined（退回无锚点模式，行为与修复前一致）。
 */
function basisAppendAnchor(chapterContent: string): string | undefined {
  const section = extractBasisRegulationSection(chapterContent);
  if (!section) return undefined;
  const compacted = chapterContent.replace(/\s+/gu, '');
  const candidates = section.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !/^#{1,6}\s/u.test(line) && !line.includes('|'))
    .filter(line => {
      const compact = line.replace(/\s+/gu, '');
      return compact.length >= 8 && compacted.split(compact).length - 1 === 1;
    });
  const bookLines = candidates.filter(line => /《[^《》]{2,40}》/u.test(line));
  return bookLines.at(-1) ?? candidates.at(-1);
}

export async function stageBasisRegulationsRepair(session: FinalizeSession): Promise<void> {
  // 全文覆盖完好：零成本通过（链尾静默，不写进度事件）
  if (basisRegulationsCoverageIssues(session.finalMarkdown, session.blueprintData).length === 0) return;
  // 章级计数定位漏列章；章级均通过而全文报出=编制依据标题位于章外结构（无定向目标，显性记录交终门禁）
  const defectiveChapters = session.finalChapterDrafts
    .map((chapter, index) => ({ chapter, index }))
    .filter(item => basisRegulationsCoverageIssues(item.chapter.content, session.blueprintData).length > 0);
  if (defectiveChapters.length === 0) {
    const unlocatableStage = displayStage({ type: 'validation', roleId: 'basis-regulations-repair', status: 'failed', message: '编制依据法规漏列收口：全文报缺失但各章检测均通过（编制依据区段位于章外结构），无定向修复目标，由终门禁照常复核' }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, unlocatableStage);
    upsertProgressStage(session.finalGateRepairStages, unlocatableStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  // 招标文件引用法规清单（照抄输入；检测器第 5 类仅在全漏时报出，缺失即应全量纳入编制依据小节）
  // 上限治理：全量列出（原 slice(0,12) 且每轮重取同一批 ⇒ 第 13 条起永不进指令）
  const blueprintRegulationItems = session.blueprintData?.basisRegulations ?? [];
  let repairedChapters = 0;
  for (const { chapter, index } of defectiveChapters) {
    let chapterContent = chapter.content;
    let rounds = 0;
    let chapterRepaired = false;
    let anyRollback = false;
    const roleId = `agent-basis-regulations-repair-${chapter.id}`;
    /**
     * 4.55.22 根修「无来源规范编号」：本轮的指令要求模型「按本工程分部分项选择现行版本并列全名称与编号」，
     * 而唯一传给它的事实来源只有招标文件引用法规——**标准名称与编号全靠模型记忆产出**；
     * 原 recheck 只看「类目覆盖数 + 汉字未减少」，编造或已废止的编号照样通过。
     * 现增加第三指标：本轮**新引入**的规范编号必须能在**项目资料**中找到（allEvidence 原文 + 蓝图法规条目），
     * 否则计为「无来源新增」并回滚该次 patch（与 patchGuard 的'不得编造'同口径）。
     */
    const normalizeRegCode = (code: string): string => code.replace(/[^0-9A-Za-z]/gu, '').toUpperCase();
    const materialText = [
      ...(session.allEvidence || []).map(item => String(item.content || '')),
      ...(session.blueprintData?.basisRegulations || []),
    ].join('\n');
    const materialCodes = new Set([...materialText.matchAll(REGULATION_CODE_RE)].map(match => normalizeRegCode(match[0])));
    const codesOf = (text: string): Set<string> => new Set([...text.matchAll(REGULATION_CODE_RE)].map(match => normalizeRegCode(match[0])));

    while (rounds < MAX_BASIS_REPAIR_ROUNDS && basisRegulationsCoverageIssues(chapterContent, session.blueprintData).length > 0) {
      rounds += 1;
      // 当前残留的缺失类目（每轮以最新文本重新定位，检测定位=修复定位）
      const pendingIssues = basisRegulationsCoverageIssues(chapterContent, session.blueprintData);
      if (pendingIssues.length === 0) break;
      const gapKinds = [...new Set(pendingIssues.map(classifyBasisGap))];
      const needsStandard = gapKinds.includes('standard') || gapKinds.includes('all');
      // 4.55.29 指令根修（实机回滚归因）：原指令第 2 条**无条件**要求"按本工程分部分项选列施工验收规范
      // 名称与编号"，而规范类目并不在缺口内时（实机残留 4 类 = 法律法规/条例/地方性法规/招标文件引用），
      // 该指令逼模型从记忆里产出自带编号的规范条目 ⇒ 撞上本轮"无来源新增编号"守卫（recheck 指标 3）
      // ⇒ 整轮回滚，三类真缺口一个字也没补上。现为**纯缺口驱动**：只发缺口类目的补列口径，
      // 未缺规范类目时改为显性禁令（含后果），把守卫规则前移到指令层，不再制造自相矛盾的任务。
      const instruction = [
        '【编制依据法规漏列定向修复】',
        '本章编制依据小节存在法规/规范条目漏写（必须按下列缺口逐条补列具体名称，不得以类别话术代替）：',
        ...pendingIssues.map(issue => `- ${issue.message}${issue.suggestion ? `：${issue.suggestion}` : ''}`),
        ...(blueprintRegulationItems.length > 0 ? [`- 招标文件引用法规（必须照抄进编制依据小节，名称与文号保持一致）：${blueprintRegulationItems.join('、')}`] : []),
        '修复要求：',
        '1. 仅修改编制依据小节，**只补列下列缺口类目**的条目（缺口以外的类目一律不动）：',
        ...gapKinds.map(kind => `   - ${GAP_GUIDANCE[kind]}`),
        needsStandard
          ? '2. 补列的规范编号必须能在项目资料（招标文件/清单/图纸/设计说明）中查到；查不到的编号判为编造、本轮成稿整体回滚。补列条目与既有条目并列成行或成表，不替换、不删除既有条目。'
          : '2. **本轮不得新增任何规范编号**（本项目规范条目已满足检测要求）：新增编号在项目资料中查不到即判为编造、本轮成稿整体回滚；',
        '3. 其余内容一字不动：不改写、不删除无关内容，不新增或删除小节，表格行不变。',
      ].join('\n');
      // 补写锚点（append 模式）：系统定位到编制依据区段末条条目行，replacement 以该行开头逐字保留并追加
      // 补列条目——补列**按构造是增补的**，不再依赖模型自行在全章里定位重写（无锚点模式实测会被复检判为
      // 变差而回滚）。段内无合格锚点时不传锚点（退回原模式）。
      const appendAnchor = basisAppendAnchor(chapterContent);
      const runningStage = displayStage({ type: 'llm_review', roleId, status: 'running', message: `编制依据法规漏列修复中（第 ${rounds}/${MAX_BASIS_REPAIR_ROUNDS} 轮）：${chapter.title}（缺失 ${pendingIssues.length} 类）` }, { subtitle: '评审后兜底' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      const outcome = await withPatchRollback({
        originalContent: chapterContent,
        repairRound: 'basis-regulations-repair',
        diagnostics: session.generationDiagnostics,
        apply: async () => {
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: chapter.id, title: chapter.title, content: chapterContent, evidence: chapter.evidence, missingFacts: chapter.missingFacts, sections: chapter.sections },
            issues: pendingIssues.map(issue => issue.message),
            promptTexts: instruction,
            // 补写锚点（append）：定位句逐字保留 + 追加补列条目（rolePipeline 的补写模式会自动补锚点前缀）
            anchorTexts: appendAnchor ? [{ text: appendAnchor, append: true }] : undefined,
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（正文表格口径）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('basis-regulations-repair', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
        },
        // 指标 1：缺失类目数（越大越差）；指标 2：负汉字数（汉字数减少=删除式修复，越大越差）；
        // 指标 3（4.55.22）：本轮新引入且**项目资料中查无**的规范编号数（编造/废止版本，越大越差）
        recheck: (content) => {
          const existing = codesOf(chapterContent);
          const unsourcedNew = [...codesOf(content)].filter(code => !existing.has(code) && !materialCodes.has(code));
          return [basisRegulationsCoverageIssues(content, session.blueprintData).length, -hanCount(content), unsourcedNew.length];
        },
        shouldRollback: (before, after) => after[0] > before[0] || after[1] > before[1] + Math.max(40, Math.abs(before[1]) * 0.05) || (after[2] ?? 0) > (before[2] ?? 0),
      });
      if (outcome.rolledBack) anyRollback = true;
      if (outcome.rolledBack || outcome.content === chapterContent) break;
      chapterContent = outcome.content;
      session.finalChapterDrafts[index] = { ...chapter, content: chapterContent };
      chapterRepaired = true;
      if (basisRegulationsCoverageIssues(chapterContent, session.blueprintData).length === 0) break;
    }
    if (chapterRepaired) repairedChapters += 1;
    const residualIssues = basisRegulationsCoverageIssues(chapterContent, session.blueprintData);
    let message: string;
    if (residualIssues.length === 0) message = `编制依据法规漏列修复完成：${chapter.title}（${rounds} 轮补列，法规/规范覆盖检测通过）`;
    else if (chapterRepaired) message = `编制依据法规漏列修复部分生效：${chapter.title}（已执行 ${rounds} 轮，残留 ${residualIssues.length} 类缺口，由终门禁照常复核）`;
    else if (anyRollback) message = `编制依据法规漏列修复已回滚：${chapter.title}（修复复检未通过，保留修复前正文；残留 ${residualIssues.length} 类缺口，由终门禁照常复核）`;
    else message = `编制依据法规漏列修复未生效：${chapter.title}（模型未产生有效修改；残留 ${residualIssues.length} 类缺口，由终门禁照常复核）`;
    const completedStage = displayStage({ type: 'llm_review', roleId, status: repairOutcomeStatus({ after: residualIssues.length, repaired: chapterRepaired }), message, details: residualIssues.length > 0 ? residualIssues.map(issue => issue.message) : ['复检：编制依据小节法规/规范覆盖检测通过'] }, { subtitle: '评审后兜底' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  const residualCount = basisRegulationsCoverageIssues(session.finalMarkdown, session.blueprintData).length;
  session.generationDiagnostics.llm.lastInfo = `编制依据法规漏列收口：${defectiveChapters.length} 章缺口定位，${repairedChapters} 章落地修复，终态残留 ${residualCount} 类缺口（残留由终门禁照常复核）`;
}
