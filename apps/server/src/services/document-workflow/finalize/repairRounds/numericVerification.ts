/**
 * repairRounds/numericVerification：正文数值 vs 资料原文确定性核对轮（C2）。
 *
 * 背景（编造数值拦截的最后一道确定性兜底）：写作侧已有温度 0 + 清单事实锁直读 + 证据注入预算放宽，
 * 但 LLM 仍可能在正文中混入材料/清单/蓝图里不存在的数值（幻觉数值、规格拆分错配、单位换算错）。
 * 本轮零 LLM 确定性提取正文数值句，与「资料原文 + 清单事实锁 + 蓝图参数桶 + 事实主表」构建的
 * 数值权威库做归一化包含匹配；未匹配数值句按章分组进入 LLM 定向修复轮（单轮，失败即放弃）。
 *
 * 匹配策略宁漏勿错：白名单豁免（合规阈值句/相对进度句/过程百分比指标/纯年份）优先于报疑似——
 * 误报代价是修复轮把正确数值改坏，漏报代价是残留数值进交付；修复轮带 patchGuard 与回滚保护，
 * 白名单只豁免确定无疑的通用表述，工艺惯例数值不豁免（交 LLM 结合上下文复核）。
 */
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { cleanEvidenceText } from '../../evidence';
import { extractSpecTokens } from '../../billFactLock';
import { stringifyFactValue } from '../../utils';
import type { DocumentFact } from '../../types';
import type { FinalizeSession } from '../finalizeSession';

/** 数值 token：数值+单位 / 管径 / 直径 / 强度等级 / 钢筋等级 / 龄期简写（7d 等） */
const NUMERIC_TOKEN_RE = /(?:\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|g|t|K|L|ml|MPa|kPa|kN|N|℃|%|台|套|座|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年|万元|元|W|kW|kV|V|A|Hz|米|处|道|根|盏|株|标段|层|樘|孔|眼|间|户|栋|幢|d)\b|DN\s*\d+|Φ\s*\d+(?:\.\d+)?|φ\s*\d+(?:\.\d+)?|C\d{2,}|HRB\d+|HPB\d+)/giu;

/** token 归一化：去除全部空白后小写比较（全角/半角空格与大小写差异不构成数值差异） */
function normToken(token: string): string {
  return token.replace(/\s+/gu, '').toLowerCase();
}

/** 提取文本中全部数值 token（归一化去重） */
function extractNumericTokens(text: string): string[] {
  const matches = text.match(NUMERIC_TOKEN_RE) || [];
  return [...new Set(matches.map(normToken))];
}

/** 数值句提取：按句分割后仅保留含数值 token 的句子（排除 Markdown 标题行） */
function extractNumericSentences(content: string): string[] {
  const sentences = content.split(/[。；;！!？?\n]/u).map(sentence => sentence.trim()).filter(Boolean);
  return sentences.filter(sentence => !sentence.startsWith('#') && NUMERIC_TOKEN_RE.test(sentence)).map(sentence => sentence.slice(0, 160));
}

/** 白名单豁免判定：确定无疑的通用表述不报疑似（合规阈值句/相对进度句/过程百分比/纯年份） */
function isExemptSentence(sentence: string): boolean {
  // 合规阈值句：防暑降温温度阈值、危大分级深度阈值由写作硬约束固定给出，不属于项目数据
  if (/高温|防暑|危大|专家论证|超过一定规模|40℃|37℃|35℃/u.test(sentence)) return true;
  // 相对进度/工序序号句：「第 N 天/N 周/N 月/N 层/N 道」是文档自身进度编排口径，不是项目事实
  if (/第\s*\d+\s*(天|周|月|日|层|道|步|轮|批)/u.test(sentence)) return true;
  const tokens = sentence.match(NUMERIC_TOKEN_RE) || [];
  const percentOnly = tokens.length > 0 && tokens.every(token => /%$/u.test(token.trim()));
  // 过程百分比指标句：进度/利用率/合格率等管理指标由施工部署自行编排，非资料事实
  if (percentOnly && /完成|进度|利用率|合格率|优良率|评标|得分|负荷/u.test(sentence)) return true;
  // 纯年份句：标准发布年份/法规修订年份属公共知识口径
  if (tokens.every(token => /^20\d{2}/u.test(token)) && /年/u.test(sentence) && !/月|日/u.test(sentence)) return true;
  return false;
}

/** 数值权威库构建：资料原文 + 清单事实锁 + 蓝图参数桶 + 事实主表，全部归一化 token 集合 */
function buildNumericAuthority(session: FinalizeSession): Set<string> {
  const authority = new Set<string>();
  // 1. 资料原文（全部绑定证据内容）
  for (const item of session.allEvidence) {
    if (!item.content) continue;
    for (const token of extractNumericTokens(cleanEvidenceText(item.content))) authority.add(token);
  }
  // 2. 清单事实锁：条目工程量+单位、特征描述规格 token、规格-数量拆分对
  const billLock = session.input.billFactLock;
  if (billLock) {
    for (const entry of billLock.entries) {
      for (const token of extractNumericTokens(`${entry.name} ${entry.description} ${entry.quantity}${entry.unit}`)) authority.add(token);
      for (const spec of extractSpecTokens(entry.description)) authority.add(normToken(spec));
      for (const pair of entry.specQuantityPairs) {
        authority.add(normToken(pair.spec));
        for (const token of extractNumericTokens(pair.quantity)) authority.add(token);
      }
    }
  }
  // 3. 蓝图参数桶：清单条目聚合数量口径
  const quantities = session.input.blueprintData?.quantities;
  if (quantities) {
    for (const [name, quantity] of Object.entries(quantities)) {
      if (typeof quantity.value === 'number' && Number.isFinite(quantity.value)) {
        authority.add(normToken(`${quantity.value}${quantity.unit || ''}`));
      }
      for (const token of extractNumericTokens(name)) authority.add(token);
    }
  }
  // 4. 事实主表：结构化事实与精确事实值
  const factValues: DocumentFact[] = [...(session.structuredFacts || []), ...(session.factsModel?.preciseFacts || [])];
  for (const fact of factValues) {
    for (const token of extractNumericTokens(stringifyFactValue(fact.value))) authority.add(token);
  }
  return authority;
}

export async function stageNumericVerification(session: FinalizeSession): Promise<void> {
  const authority = buildNumericAuthority(session);
  // 权威库为空（无证据/无清单/无蓝图）时跳过本轮：没有权威可对，修复轮只会引入新的编造风险
  if (authority.size === 0) return;
  // 章级疑似数值句提取：token 全部不在权威库且句级不豁免 → 疑似编造数值
  const chapterSuspects = new Map<string, Array<{ sentence: string; tokens: string[] }>>();
  for (const chapter of session.finalChapterDrafts) {
    const suspects: Array<{ sentence: string; tokens: string[] }> = [];
    for (const sentence of extractNumericSentences(chapter.content)) {
      if (isExemptSentence(sentence)) continue;
      const tokens = extractNumericTokens(sentence);
      if (tokens.length === 0) continue;
      if (tokens.every(token => authority.has(token))) continue;
      const missingTokens = tokens.filter(token => !authority.has(token));
      if (missingTokens.length > 0) suspects.push({ sentence, tokens: missingTokens });
    }
    if (suspects.length > 0) chapterSuspects.set(chapter.id, suspects.slice(0, 12));
  }
  const totalSuspects = [...chapterSuspects.values()].reduce((sum, items) => sum + items.length, 0);
  if (totalSuspects === 0) {
    upsertProgressStage(session.progressStages, displayStage({ type: 'validation', roleId: 'numeric-verification', status: 'success', message: '正文数值确定性核对通过：全部正文数值均在资料原文/清单事实锁/蓝图参数桶中找到同值来源', details: [`数值权威库规模：${authority.size} 个归一化 token`] }, { subtitle: '数值确定性核对' }));
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  let repairedChapters = 0;
  let residualSuspects = 0;
  for (const [chapterId, suspects] of chapterSuspects) {
    const chapterIndex = session.finalChapterDrafts.findIndex(chapter => chapter.id === chapterId);
    if (chapterIndex < 0) continue;
    const draftChapter = session.finalChapterDrafts[chapterIndex];
    const runningStage = displayStage({ type: 'llm_review', roleId: `agent-numeric-verification-${chapterId}`, status: 'running', message: `正文数值核对发现 ${suspects.length} 处疑似无来源数值，定向修复中：${draftChapter.title}`, details: suspects.map(item => `疑似：${item.sentence}（缺来源 token：${item.tokens.join('、')}）`) }, { subtitle: '数值确定性核对' });
    upsertProgressStage(session.progressStages, runningStage);
    upsertProgressStage(session.finalGateRepairStages, runningStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    const numericInstruction = [
      '【正文数值定向核对修复】',
      '下列句子中的数值（标注「缺来源 token」）在项目绑定材料、工程量清单与蓝图中均找不到同值来源，属于疑似编造数值。请逐句核对并修复：',
      '1. 若该数值在本章绑定证据中确实存在（仅表述口径不同），保持数值原样，只修正单位或表述；',
      '2. 若该数值是行业通用工艺参数（如养护龄期、分层厚度），可按规范惯例保留并改为规范原文表述；',
      '3. 其余情况必须删除该数值，改写为不带具体数值的过程控制表述（如「按设计要求」「分层碾压至压实度满足设计及规范要求」）；',
      '禁止把疑似数值替换为另一个同样无来源的数值；禁止改动句子的非数值部分；只做局部修改，不得新增、删除或合并小节。',
      suspects.map(item => `- 疑似句：${item.sentence}（缺来源 token：${item.tokens.join('、')}）`).join('\n'),
    ].join('\n');
    const numericOutcome = await withPatchRollback({
      originalContent: draftChapter.content,
      repairRound: 'numeric-verification',
      diagnostics: session.generationDiagnostics,
      apply: async () => {
        const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
          template: session.template,
          chapter: { id: draftChapter.id, title: draftChapter.title, content: draftChapter.content, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
          issues: suspects.map(item => `疑似无来源数值：${item.sentence}（token：${item.tokens.join('、')}）`),
          promptTexts: numericInstruction,
          requirement: session.requirement,
          forbidDrawingImages: false,
          diagnostics: session.generationDiagnostics,
          signal: session.signal,
          patchGuard: repairPatchGuard('numeric-verification', session.generationDiagnostics),
        }));
        return repaired.content && repaired.content !== draftChapter.content ? repaired.content : draftChapter.content;
      },
      recheck: (content) => {
        const remaining = extractNumericSentences(content).filter(sentence => !isExemptSentence(sentence) && extractNumericTokens(sentence).some(token => !authority.has(token))).length;
        return [remaining];
      },
    });
    if (!numericOutcome.rolledBack && numericOutcome.content !== draftChapter.content) {
      session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: numericOutcome.content };
      repairedChapters += 1;
    }
    const afterSuspects = extractNumericSentences((session.finalChapterDrafts[chapterIndex] || draftChapter).content).filter(sentence => !isExemptSentence(sentence) && extractNumericTokens(sentence).some(token => !authority.has(token))).length;
    residualSuspects += afterSuspects;
    const completedStage = displayStage({ type: 'llm_review', roleId: `agent-numeric-verification-${chapterId}`, status: numericOutcome.rolledBack ? 'failed' : afterSuspects === 0 ? 'success' : 'failed', message: numericOutcome.rolledBack ? `数值核对修复已回滚：${draftChapter.title}（修复后疑似数值增多，保留修复前正文）` : afterSuspects === 0 ? `数值核对修复完成：${draftChapter.title}（${suspects.length} 处疑似数值已处理）` : `数值核对修复部分生效：${draftChapter.title}（残留 ${afterSuspects} 处疑似数值，单轮失败即放弃）`, details: [...suspects.map(item => `疑似：${item.sentence}`), afterSuspects > 0 ? '残留项以 warning 记录，不阻断交付' : ''] }, { subtitle: '数值确定性核对' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  session.generationDiagnostics.llm.lastInfo = `正文数值确定性核对：权威库 ${authority.size} token，${totalSuspects} 处疑似无来源数值，${repairedChapters} 章完成定向修复，残留 ${residualSuspects} 处（单轮失败即放弃）`;
}
