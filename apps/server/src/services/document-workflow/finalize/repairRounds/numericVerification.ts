/**
 * repairRounds/numericVerification：正文数值 vs 资料原文确定性核对轮（C2）。
 *
 * 背景（编造数值拦截的最后一道确定性兜底）：写作侧已有温度 0 + 清单事实锁直读 + 证据注入预算放宽，
 * 但 LLM 仍可能在正文中混入材料/清单/蓝图里不存在的数值（幻觉数值、规格拆分错配、单位换算错）。
 * 本轮零 LLM 确定性提取正文数值句，与「资料原文 + 清单事实锁 + 蓝图参数桶 + 事实主表」构建的
 * 数值权威库做归一化包含匹配；未匹配数值句按章分组进入 LLM 定向修复轮（V5 P4.2 收敛修复：
 * 每章最多 2 轮，残留数下降才继续下一轮，不降或回滚即停止，未收敛残留转 warning 兜底不阻断交付）。
 *
 * 匹配策略宁漏勿错：白名单豁免（合规阈值句/相对进度句/过程百分比指标/纯年份）优先于报疑似——
 * 误报代价是修复轮把正确数值改坏，漏报代价是残留数值进交付；修复轮带 patchGuard 与回滚保护，
 * 白名单只豁免确定无疑的通用表述，工艺惯例数值不豁免（交 LLM 结合上下文复核）。
 */
import { repairOutcomeReason, repairOutcomeStatus } from './repairOutcome';
import { displayStage, upsertProgressStage } from '../../progress';
import { repairChapterByQuality, repairPatchGuard } from '../../rolePipeline';
import { withPatchRollback } from '../../patchRollback';
import { cleanEvidenceText } from '../../evidence';
import { extractSpecTokens } from '../../billFactLock';
import { stringifyFactValue } from '../../utils';
import { classifyNumericTraceToken, CELL_NUMBER_RE, CELL_UNIT_RE } from '../../documentFactTrace';
import { auditContextWindow, buildNamedAuthorityValues, TOTAL_CLAIM_WINDOW, type AuthorityAuditReport } from '../../authorityAudit';
import { namedTotalClosure, TOTAL_CLAIM_PREFIX_RE, type NamedAuthorityValue } from '../../factReconciliation';
import type { DocumentFact } from '../../types';
import type { FinalizeSession } from '../finalizeSession';

/** 数值 token：数值+单位 / 管径 / 直径 / 强度等级 / 钢筋等级 / 龄期简写（7d 等）
 * r28m M24d D1（面积盲区根治）：单位组重排（m2/m3/m³/m²/㎡/平方米 在 m 前，防「1436.4m²」被
 * m 分支截断）+ 尾部边界断言由 \b 改为 (?![\w\u00B2\u00B3])（㎡/%/℃ 等非词形单位后接标点时 \b 不成立而漏提）。 */
const NUMERIC_TOKEN_RE = /(?:\d+(?:\.\d+)?\s*(?:mm|cm|m2|m3|m³|m²|㎡|平方米|m|km|kg|g|t|K|L|ml|MPa|kPa|kN|N|℃|%|台|套|座|个|项|批|次|份|人|小时|分钟|日历天|天|周|月|年|万元|元|W|kW|kV|V|A|Hz|米|处|道|根|盏|株|标段|层|樘|孔|眼|间|户|栋|幢|d)(?![\w\u00B2\u00B3])|DN\s*\d+|Φ\s*\d+(?:\.\d+)?|φ\s*\d+(?:\.\d+)?|C\d{2,}|HRB\d+|HPB\d+)/giu;

/** token 归一化：去除全部空白后小写比较（全角/半角空格与大小写差异不构成数值差异） */
function normToken(token: string): string {
  return token.replace(/\s+/gu, '').toLowerCase();
}

/** 提取文本中全部数值 token（归一化去重） */
function extractNumericTokens(text: string): string[] {
  const matches = text.match(NUMERIC_TOKEN_RE) || [];
  return [...new Set(matches.map(normToken))];
}

/** 数值句提取：按句分割后仅保留含数值 token 的句子（排除 Markdown 标题行）。
 * 注意：全局正则的 .test() 带 lastIndex 状态（句间泄漏会导致连续调用漏判句子），必须用无状态全量 match。 */
function extractNumericSentences(content: string): string[] {
  const sentences = content.split(/[。；;！!？?\n]/u).map(sentence => sentence.trim()).filter(Boolean);
  return sentences.filter(sentence => !sentence.startsWith('#') && (sentence.match(NUMERIC_TOKEN_RE) ?? []).length > 0).map(sentence => sentence.slice(0, 160));
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

/** 数值权威库构建（与无主数值审计 authorityAudit 全源补充核单源）：资料原文 + 清单事实锁 +
 * 蓝图参数桶 + 事实主表，全部归一化 token 集合。导出供 rebuildAndRecompute.recordAuthorityAudit
 * 消费——audit 报「缺口」前先与本库复核，两链判据不漂移。 */
export function buildNumericAuthority(session: FinalizeSession): Set<string> {
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
      // R20 规格拆分值入池（防反向误报）：名称聚合仅含合计（如「一般路灯 118套」），
      // 正确规格小计（100W 109套 / 120W 9套）不入池会被本核对轮误报「无来源」并被修复轮改写——
      // 与 specQuantityBinding 轮同源（规格-数量拆分＝合法值）
      for (const split of quantity.specBreakdown ?? []) {
        if (typeof split.value === 'number' && Number.isFinite(split.value)) {
          authority.add(normToken(`${split.value}${quantity.unit || ''}`));
        }
      }
      for (const token of extractNumericTokens(name)) authority.add(token);
    }
  }
  // 4. 事实主表：结构化事实与精确事实值
  const factValues: DocumentFact[] = [...(session.structuredFacts || []), ...(session.factsModel?.preciseFacts || [])];
  for (const fact of factValues) {
    for (const token of extractNumericTokens(stringifyFactValue(fact.value))) authority.add(token);
  }
  // 5. 事实主表表格（r28m M24d D2，与 numericTraceCorpus 同法）：行文本拼接提取覆盖已连写形态；
  // 数字格×单位格跨格组合覆盖分列形态（清单分列表「| 1436.400 | m2 |」）——仅数字格不携单位
  // 入核会放行裸数编造，必须与单位格配对（CELL_NUMBER_RE/CELL_UNIT_RE 单源口径）
  for (const table of session.factsModel?.tables || []) {
    for (const row of table.rows || []) {
      if (!Array.isArray(row) || row.length === 0) continue;
      const cells = row.map(cell => String(cell ?? '').trim());
      for (const token of extractNumericTokens(cells.join(' '))) authority.add(token);
      const numbers = [...new Set(cells.filter(cell => CELL_NUMBER_RE.test(cell)))];
      if (numbers.length === 0) continue;
      const units = [...new Set(cells.filter(cell => CELL_UNIT_RE.test(cell)))];
      for (const number of numbers) {
        for (const unit of units) {
          for (const token of extractNumericTokens(`${number}${unit}`)) authority.add(token);
        }
      }
    }
  }
  return authority;
}

/** V5 P4.2 收敛修复：每章定向修复轮上限（残留数下降才继续下一轮；不降/回滚/达上限即停止，转 warning 兜底） */
const MAX_NUMERIC_REPAIR_ROUNDS = 2;

/** 自称合计闭包豁免（4.55.34 A）：句内「自称合计」且可由具名权威分项闭合的数值 token。
 *
 * **两链判据漂移根治**：无主数值审计（authorityAudit.totalClaimClosure，4.55.31 B2）已把
 * 「自称合计 + 具名分项恰为其和」收编为合法观测（totalClaimClosed，不进三桶、不进硬门禁），
 * 但本修复轮此前只做「权威 token 匹配 + C-T2 分类」，**没有**这道豁免——于是同一个 6403.78m²
 * 在审计侧是合法自算合计、在本轮却是「疑似无来源」，而本轮的收敛动作只有「删除该数值/改定性」
 * （指令第 3 条）⇒ 修复轮把审计已判定合法的自算合计当成编造删掉，审计缺口不但不收敛，
 * 正文还丢了信息（与 G 线 P2-2《不得以删除通过门禁》正面冲突）。
 * 判据与审计**完全单源**：TOTAL_CLAIM_PREFIX_RE（自称合计）+ namedTotalClosure（名称锚定/单位同族/
 * 恰为其和）+ buildNamedAuthorityValues（同一份具名权威池）+ auditContextWindow（同一窗口构造，
 * 含边界吸附；窗口口径 ±TOTAL_CLAIM_WINDOW 字）。
 * 与审计的偏差只允许一个方向：本判据**不得**比对审计更宽（否则审计仍报缺口而本轮不再修 → 门禁残留）。 */
export function selfDeclaredClosedTotalTokens(
  sentence: string,
  tokens: readonly string[],
  values: readonly NamedAuthorityValue[],
): Set<string> {
  const closed = new Set<string>();
  if (values.length === 0) return closed;
  for (const token of tokens) {
    const at = sentence.indexOf(token);
    if (at < 0) continue;
    const prefix = sentence.slice(Math.max(0, at - 24), at).replace(/\s+/gu, ' ');
    if (!TOTAL_CLAIM_PREFIX_RE.test(prefix)) continue;
    const core = /\d+(?:\.\d+)?/u.exec(token);
    if (!core) continue;
    const unit = /^[\d,，.]+(.*)$/u.exec(token)?.[1]?.trim() ?? '';
    // 窗口算法与审计单源（auditContextWindow：左右边界吸附，数字不被切半）——两链同窗同判据
    const context = auditContextWindow(sentence, at, token.length, TOTAL_CLAIM_WINDOW).replace(/\s+/gu, ' ');
    if (namedTotalClosure({ total: Number(core[0]), unit, context, values })) closed.add(token);
  }
  return closed;
}

/** 具名分项和候选提示（4.55.34 A）：审计报告（derivation-gap / process-gap 的 closureCandidates）
 * → token → 提示文案（「＝ 分项 + 分项」）。审计所检 = 修复轮所见：候选只把**非破坏性**收敛动作
 * （按 D4.5 还原为具名分项 + 合计分解）交到 LLM 手上——此前该值在指令里只是一个「疑似无来源」裸
 * token，可选动作只剩删除。**不改变判据**：值仍是缺口、仍进硬门禁，还原分解后由审计的合计闭包收编。 */
export function auditGapClosureHints(report: AuthorityAuditReport | undefined): Map<string, string> {
  const hints = new Map<string, string>();
  if (!report) return hints;
  for (const finding of [...report.derivationGaps, ...report.processGaps]) {
    const candidates = finding.closureCandidates ?? [];
    if (candidates.length === 0) continue;
    const key = normToken(finding.token);
    if (!hints.has(key)) hints.set(key, `${candidates.join(' + ')} ＝ ${finding.token.replace(/\s+/gu, '')}`);
  }
  return hints;
}

export async function stageNumericVerification(session: FinalizeSession): Promise<void> {
  const authority = buildNumericAuthority(session);
  // 权威库为空（无证据/无清单/无蓝图）时跳过本轮：没有权威可对，修复轮只会引入新的编造风险
  if (authority.size === 0) return;
  // 具名权威池（与审计合计闭包/分项和候选同源单源）与分项和候选提示（审计报告 → token → 提示）
  const namedValues = session.blueprintData ? buildNamedAuthorityValues(session.blueprintData) : [];
  const closureHints = auditGapClosureHints(session.authorityAuditReport);
  // 章级疑似数值句提取（全量计数口径：与收敛判定/recheck 同源，每轮修复后重算残留）
  const collectSuspects = (content: string): Array<{ sentence: string; tokens: string[] }> => {
    const suspects: Array<{ sentence: string; tokens: string[] }> = [];
    for (const sentence of extractNumericSentences(content)) {
      if (isExemptSentence(sentence)) continue;
      const tokens = extractNumericTokens(sentence);
      if (tokens.length === 0) continue;
      if (tokens.every(token => authority.has(token))) continue;
      // C-T2 三分类豁免（实测归因）：规范常数（标准编号/养护龄期/试块留置/检测频次/温度阈值/
      // 质量指标/工艺公差）与管理数字（管理频次/组织编排/配置/合同条款/过程指标/日期表述）
      // 不进修复轮——修复轮只处理真未溯源数字，避免「规范数字保留后 recheck 仍检出」的不收敛空转
      const unsourced = tokens.filter(token => !authority.has(token) && classifyNumericTraceToken({ token, context: sentence }).kind === 'unsourced');
      // 自称合计闭包同源豁免（4.55.34 A）：审计侧已收编的合法自算合计（自称合计 + 具名分项恰为其和）
      // 不再进修复轮——否则本轮会把审计判定为合法的值当编造删除（两链判据漂移 + 丢信息），
      // 而审计缺口照旧残留。判据与审计单源（见 selfDeclaredClosedTotalTokens）。
      const closedTotals = selfDeclaredClosedTotalTokens(sentence, unsourced, namedValues);
      const missingTokens = unsourced.filter(token => !closedTotals.has(token));
      if (missingTokens.length > 0) suspects.push({ sentence, tokens: missingTokens });
    }
    return suspects;
  };
  const chapterSuspects = new Map<string, Array<{ sentence: string; tokens: string[] }>>();
  for (const chapter of session.finalChapterDrafts) {
    const suspects = collectSuspects(chapter.content);
    // 上限治理：**不截断**（原 slice(0,12)：单章第 13 处起的疑似无来源数值永不进修复指令，
    // 且每轮重新取前 12 处 ⇒ 头部不下降则尾部永无机会）。指令规模由渲染层按 token 预算控制。
    if (suspects.length > 0) chapterSuspects.set(chapter.id, suspects);
  }
  const totalSuspects = [...chapterSuspects.values()].reduce((sum, items) => sum + items.length, 0);
  if (totalSuspects === 0) {
    const numericVerificationPassStage = displayStage({ type: 'validation', roleId: 'numeric-verification', status: 'success', message: '正文数值确定性核对通过：全部正文数值均在资料原文/清单事实锁/蓝图参数桶中找到同值来源', details: [`数值权威库规模：${authority.size} 个归一化 token`] }, { subtitle: '数值确定性核对' });
    // 4.36.2 复查修正：修复轮事件必须双写（finalStages=executionStages 快照+finalGateRepairStages）
    upsertProgressStage(session.progressStages, numericVerificationPassStage);
    upsertProgressStage(session.finalGateRepairStages, numericVerificationPassStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
    return;
  }
  let repairedChapters = 0;
  let residualSuspects = 0;
  for (const [chapterId, suspects] of chapterSuspects) {
    const chapterIndex = session.finalChapterDrafts.findIndex(chapter => chapter.id === chapterId);
    if (chapterIndex < 0) continue;
    const draftChapter = session.finalChapterDrafts[chapterIndex];
    let chapterContent = draftChapter.content;
    let pending = suspects;
    let beforeCount = collectSuspects(chapterContent).length;
    let rounds = 0;
    let chapterRepaired = false;
    let anyRollback = false;
    // 残留轨迹（首计数 + 每轮修复后计数）：stage 明细与诊断展示收敛过程
    const residualTrajectory = [beforeCount];
    // V5 P4.2 收敛修复：残留数下降才继续下一轮（上限 2 轮）；清零/不降/回滚即停止，残留转 warning 兜底
    while (pending.length > 0 && rounds < MAX_NUMERIC_REPAIR_ROUNDS) {
      rounds += 1;
      const runningStage = displayStage({ type: 'llm_review', roleId: `agent-numeric-verification-${chapterId}`, status: 'running', message: `正文数值核对发现 ${pending.length} 处疑似无来源数值，第 ${rounds} 轮定向修复中：${draftChapter.title}`, details: pending.map(item => `疑似：${item.sentence}（缺来源 token：${item.tokens.join('、')}）`) }, { subtitle: '数值确定性核对' });
      upsertProgressStage(session.progressStages, runningStage);
      upsertProgressStage(session.finalGateRepairStages, runningStage);
      session.emitProgress(session.finalChapterDrafts, session.progressStages);
      // 分项和候选提示（4.55.34 A）：仅当本章存在带候选的缺口 token 时追加第 3 条与候选行——
      // 无候选时指令与历史逐字一致（避免给 LLM 新的改写自由度）
      const hintLines = pending
        .flatMap(item => item.tokens.map(token => ({ token, hint: closureHints.get(normToken(token)) })))
        .filter((entry): entry is { token: string; hint: string } => Boolean(entry.hint));
      const numericInstruction = [
        '【正文数值定向核对修复】',
        ...(rounds > 1 ? [`本轮为第 ${rounds} 轮（最多 ${MAX_NUMERIC_REPAIR_ROUNDS} 轮）：上一轮修复后仍有残留，无法确认来源的数值必须直接删除，禁止保留或替换为其他无来源数值。`] : []),
        '下列句子中的数值（标注「缺来源 token」）在项目绑定材料、工程量清单与蓝图中均找不到同值来源，属于疑似编造数值。请逐句核对并修复：',
        '1. 若该数值在本章绑定证据中确实存在（仅表述口径不同），保持数值原样，只修正单位或表述；',
        '2. 若该数值确属规范/标准常数（如试块留置、养护龄期、检测频次），保留数值并显性标注规范名称与编号（如「按《混凝土结构工程施工质量验收规范》GB 50204 规定，每100m³留置一组试块」）——显性标注后即视为已溯源；',
        ...(hintLines.length > 0
          ? ['3. 若该数值已给出「具名分项和候选」（该值恰为若干具名权威分项之和），说明它是写手对权威分项的自算合计，**不得删除**：按分项显式还原为「分项名 数值+单位、…，合计 数值+单位」的分解表述（分项值必须取候选值原样，禁止改动候选数值），还原后即为可溯源的合法合计；']
          : []),
        `${hintLines.length > 0 ? '4' : '3'}. 其余情况必须删除该数值，改写为不带具体数值的过程控制表述（如「按设计要求」「分层碾压至压实度满足设计及规范要求」）；`,
        '禁止把疑似数值替换为另一个同样无来源的数值；禁止改动句子的非数值部分；只做局部修改，不得新增、删除或合并小节。',
        pending.map(item => `- 疑似句：${item.sentence}（缺来源 token：${item.tokens.join('、')}）`).join('\n'),
        ...(hintLines.length > 0
          ? ['具名分项和候选（按第 3 条还原分解，不得删除）：', ...hintLines.map(entry => `- ${entry.token.replace(/\s+/gu, '')}：${entry.hint}`)]
          : []),
      ].join('\n');
      const numericOutcome = await withPatchRollback({
        originalContent: chapterContent,
        repairRound: 'numeric-verification',
        diagnostics: session.generationDiagnostics,
        apply: async () => {
          const repaired = await session.withProgressHeartbeat(() => repairChapterByQuality({
            template: session.template,
            chapter: { id: draftChapter.id, title: draftChapter.title, content: chapterContent, evidence: draftChapter.evidence, missingFacts: draftChapter.missingFacts, sections: draftChapter.sections },
            issues: pending.map(item => `疑似无来源数值：${item.sentence}（token：${item.tokens.join('、')}）`),
            promptTexts: numericInstruction,
            requirement: session.requirement,
            forbidDrawingImages: false,
            // 标书编制规格（正文表格口径）：修复链 system 口径同步
            bidComposition: session.bidComposition,
            diagnostics: session.generationDiagnostics,
            signal: session.signal,
            patchGuard: repairPatchGuard('numeric-verification', session.generationDiagnostics),
          }));
          return repaired.content && repaired.content !== chapterContent ? repaired.content : chapterContent;
        },
        recheck: (content) => [collectSuspects(content).length],
      });
      if (!numericOutcome.rolledBack && numericOutcome.content !== chapterContent) {
        chapterContent = numericOutcome.content;
        session.finalChapterDrafts[chapterIndex] = { ...draftChapter, content: chapterContent };
        chapterRepaired = true;
      }
      if (numericOutcome.rolledBack) anyRollback = true;
      const afterCount = collectSuspects(chapterContent).length;
      residualTrajectory.push(afterCount);
      // 收敛判定：清零即通过；未下降（含回滚/空修复）即停止；下降且未达上限 → 再修一轮（残留数下降才继续）
      if (afterCount === 0 || afterCount >= beforeCount || rounds >= MAX_NUMERIC_REPAIR_ROUNDS) break;
      beforeCount = afterCount;
      pending = collectSuspects(chapterContent).slice(0, 12);
    }
    if (chapterRepaired) repairedChapters += 1;
    const afterSuspects = collectSuspects(chapterContent).length;
    residualSuspects += afterSuspects;
    const completedStage = displayStage({ type: 'llm_review', roleId: `agent-numeric-verification-${chapterId}`, status: repairOutcomeStatus({ before: suspects.length, after: afterSuspects, repaired: chapterRepaired, rolledBack: anyRollback }), message: afterSuspects === 0 ? `数值核对修复完成：${draftChapter.title}（${suspects.length} 处疑似数值已处理，残留轨迹 ${residualTrajectory.join('→')}）` : chapterRepaired ? `数值核对修复部分生效：${draftChapter.title}（疑似数值残留轨迹 ${residualTrajectory.join('→')}，已执行 ${rounds} 轮定向修复（每章最多 ${MAX_NUMERIC_REPAIR_ROUNDS} 轮）；残留项以 warning 记录，不阻断交付）` : anyRollback ? `数值核对修复已回滚：${draftChapter.title}（修复后疑似数值增多，保留修复前正文；残留 ${afterSuspects} 处以 warning 记录，不阻断交付）` : `数值核对修复未生效：${draftChapter.title}（模型未产生有效修改；残留 ${afterSuspects} 处以 warning 记录，不阻断交付）`, details: [...suspects.map(item => `疑似：${item.sentence}`), afterSuspects > 0 ? `已执行 ${rounds} 轮定向修复，残留项以 warning 记录，不阻断交付` : ''] }, { subtitle: '数值确定性核对' });
    upsertProgressStage(session.progressStages, completedStage);
    upsertProgressStage(session.finalGateRepairStages, completedStage);
    session.emitProgress(session.finalChapterDrafts, session.progressStages);
  }
  if (repairedChapters > 0) {
    session.finalMarkdown = session.rebuildFinalMarkdown();
    await session.recomputeFinalValidationBundle();
  }
  session.generationDiagnostics.llm.lastInfo = `正文数值确定性核对：权威库 ${authority.size} token，${totalSuspects} 处疑似无来源数值，${repairedChapters} 章完成定向修复，残留 ${residualSuspects} 处（每章最多 ${MAX_NUMERIC_REPAIR_ROUNDS} 轮收敛修复，未收敛残留以 warning 记录，不阻断交付）`;
}
