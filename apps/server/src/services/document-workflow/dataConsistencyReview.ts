import type { DocumentGenerationDiagnostics, ValidationIssue } from './types';
import { callDocumentLlmJson, type DocumentJsonSchema } from './llmClient';
import { stableHash } from './utils';
import { docSystemPrefix } from './markdownComposer';
import type { DecisionLockEntry } from './decisionLock';
import { decisionLockCategoryMeta, decisionMentionNegated } from './decisionLock';

/**
 * L3.5 数据一致性 LLM 审查层（h7）：
 * 劳动力/面积/工期/节点日期等数值矛盾仅靠零散正则盲区大（用户反馈重灾区：
 * 「正文多处高峰期 X 人互相矛盾、总数 vs 工种之和不等、人数×工期与总工日不自洽」）。
 * 分工遵循四层分离架构：L1 确定性提取全文数值句（正则仅结构提取），
 * 矛盾判定属开放语义空间，归 LLM 一次批量审查输出矛盾清单 JSON，
 * 调用方转 blocker 进修复轮；LLM 瞬态失败返回空清单（确定性检测层仍兜底，不阻断）。
 */

/** 数据一致性矛盾条目（LLM 审查输出） */
export interface DataConsistencyConflict {
  /** 矛盾类型：labor 劳动力 / area 面积 / duration 工期 / date 节点日期 / other */
  kind: string;
  /** 矛盾原文 A（含数值） */
  itemA: string;
  /** 矛盾原文 B（含数值） */
  itemB: string;
  /** 矛盾描述（同一口径应一致而实际不同） */
  description: string;
  /** 判定置信度 0-1（低于 0.7 的丢弃，宁缺勿误报） */
  confidence: number;
}

const CONFLICTS_JSON_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['conflicts'],
  properties: {
    conflicts: {
      type: 'array',
      required: true,
      maxItems: 8,
      items: {
        type: 'object',
        required: true,
        properties: {
          kind: { type: 'string', required: true },
          itemA: { type: 'string', required: true },
          itemB: { type: 'string', required: true },
          description: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
        },
      },
    },
  },
};

/** 2.5 数值审查采样上限（200 → 120，全文 LLM 审查输入减半）：
 * 默认 120；DOCUMENT_CONSISTENCY_SAMPLE_LIMIT 可调，=0 回退旧值 200 */
function consistencySampleLimit(): number {
  const raw = process.env.DOCUMENT_CONSISTENCY_SAMPLE_LIMIT;
  if (raw === undefined || raw === '') return 120;
  if (raw === '0') return 200;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120;
}

/** 全文数值句提取（L1 确定性结构提取）：含数值的正文句与表格行，按数值密度优先采样（默认上限 120 条） */
export function numericSentencesForReview(markdown: string): string[] {
  const sentences: string[] = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // 表格行保留数值单元格上下文（不拆句）
    if (/^\|/u.test(trimmed) && /[\d]/u.test(trimmed)) {
      sentences.push(trimmed.slice(0, 160));
      continue;
    }
    if (/^#{1,6}\s/u.test(trimmed)) continue;
    for (const part of trimmed.split(/(?<=[。；;])/u)) {
      const sentence = part.trim();
      if (sentence.length >= 6 && sentence.length <= 160 && /[\d]/u.test(sentence)) sentences.push(sentence);
    }
  }
  const unique = [...new Set(sentences)];
  const limit = consistencySampleLimit();
  if (unique.length <= limit) return unique;
  // 2.5 数值密度优先采样：句中数值 token 多者优先保留（数值矛盾多发于多数值句）；
  // 截取后恢复原文顺序输出，保证 prompt 输入顺序自然且逐字节确定
  return unique
    .map((sentence, index) => ({ sentence, index, density: (sentence.match(/[\d,]+(?:\.\d+)?/gu) || []).length }))
    .sort((left, right) => right.density - left.density || left.index - right.index)
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map(entry => entry.sentence);
}

/** 全文数据一致性批量审查：数值句清单 → LLM 输出矛盾清单 JSON（置信度 <0.7 丢弃，最多 6 条） */
export async function reviewDataConsistency(markdown: string, options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {}): Promise<DataConsistencyConflict[]> {
  const numericLines = numericSentencesForReview(markdown);
  if (numericLines.length < 2) return [];
  const raw = await callDocumentLlmJson<{ conflicts?: DataConsistencyConflict[] }>(
    [
      docSystemPrefix('你是施工组织设计数据一致性审查器。'),
      '给定全文含数值的句子/表格行清单（编号与内容），找出互相矛盾的数值对：',
      '- 同一口径必须一致而实际数值不同：劳动力峰值多处不一致、同一面积两处数字不同、总工期与分项工期冲突、同一节点日期两处不一致、表格合计与明细之和不等、人数×工期与总工日不自洽；',
      '- 只报确定的矛盾（itemA 与 itemB 明确矛盾且置信度 ≥0.8），不得臆造；',
      '- 不同口径的数值不算矛盾：建筑面积 vs 占地面积、不同单位的表述；分阶段各期人数互比不算矛盾（各阶段人数不同是正常配置）；',
      '- 但总量控制上限与分阶段峰值必须自洽：“高峰期总人数控制在X人/高峰总人数X人以内/控制在X人以下”与任何“高峰投入Y人/阶段高峰Y人/峰值Y人”（Y>X）构成矛盾，必须上报；',
      'itemA/itemB 必须是清单中真实出现的原文片段（逐字引用编号对应句子或表格行的关键片段，含数值）。',
      '只输出 JSON，不得输出其他内容。',
    ].join('\n'),
    numericLines.map((line, index) => `${index + 1}. ${line}`).join('\n'),
    {
      maxTokens: 2500,
      temperature: 0,
      signal: options.signal,
      diagnostics: options.diagnostics,
      schema: CONFLICTS_JSON_SCHEMA,
      taskKind: 'structuredGeneration',
    },
  );
  if (!raw?.conflicts?.length) return [];
  return raw.conflicts
    .filter(conflict => typeof conflict.itemA === 'string' && typeof conflict.itemB === 'string' && conflict.itemA.trim() && conflict.itemB.trim())
    .filter(conflict => (conflict.confidence ?? 0) >= 0.7)
    .slice(0, 6);
}

/** 矛盾条目转交付阻断 ValidationIssue（消息携带矛盾数值对原文，供修复指令精确定位） */
export function dataConsistencyConflictIssue(conflict: DataConsistencyConflict): ValidationIssue {
  return {
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `数据一致性矛盾（${conflict.kind}）：${conflict.description}（原文 A：“${conflict.itemA.slice(0, 60)}” ↔ 原文 B：“${conflict.itemB.slice(0, 60)}”）`,
    suggestion: '全文数据必须一致：以绑定资料（图纸/清单/招标文件）为准选定唯一值，统一矛盾数值对，删除或修正其余矛盾表述。禁止将本缺陷描述与修复要求本身写入正文，输出仅限正文内容。',
  };
}

/** 矛盾消息数值对签名（复检同源判定用）：提取全部数字 token 去重排序拼接（出现次数不影响签名） */
export function conflictNumericKey(message: string): string {
  return [...new Set([...message.matchAll(/[\d,]+(?:\.\d+)?/gu)]
    .map(match => match[0].replace(/[,，]/gu, ''))
    .filter(token => token.length >= 2))]
    .sort((a, b) => Number(a) - Number(b))
    .join('|');
}

/** 批量化复检（数据一致性修复轮末统一重审用）：一次全文审查后按数值对签名判定各 issue 消息是否仍残留。
 * 与 per-issue 复检的逐字比对口径不同：修复会改写矛盾句原文，逐字比对在批量化下必然误判；
 * 改用冲突数值对签名比对——签名仍在即矛盾未消除（宁多勿漏，残留由后续防线兜底）。 */
export async function reviewDataConsistencyBatched(markdown: string, issueMessages: string[], options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {}): Promise<string[]> {
  const conflicts = await reviewDataConsistency(markdown, options);
  if (conflicts.length === 0) return [];
  const conflictKeys = new Set(conflicts.map(conflict => conflictNumericKey(dataConsistencyConflictIssue(conflict).message)).filter(Boolean));
  return issueMessages.filter(message => conflictKeys.has(conflictNumericKey(message)));
}

/**
 * 1.3 语义矛盾检测（确定性闭集比对，零 LLM 成本）：工艺路线/机械选型/材料供应这类
 * "实体-选择"矛盾不含数值差异，数值审查层（reviewDataConsistency）完全盲区
 * （实锤：决策应锁塔吊但后章写施工电梯）。检测与 1.2 决策锁同源——类目 relevance/选项别名/否定口径
 * 全部复用 decisionLock 单一事实源：句子命中类目且出现锁外选项别名（非否定语境）即冲突。
 * 闭集空间可枚举，不引入 bge 语义召回——锁构建侧同样按别名计分，双源口径漂移比边际召回更要命。
 * env DOCUMENT_SEMANTIC_CHOICE_CHECK=0 回退（返回空清单）。
 */
export interface SemanticChoiceConflict {
  /** 决策锁类目 id（vertical_transport/formwork/concrete_supply/scaffold/foundation_support/earthwork_haul） */
  categoryId: string;
  /** 类目中文名（消息展示用） */
  label: string;
  /** 锁定取值集 */
  lockedValues: string[];
  /** 正文出现的锁外取值 */
  offValue: string;
  /** 冲突原句（修复锚点） */
  sentence: string;
}

export function semanticChoiceConflicts(markdown: string, decisionLock: DecisionLockEntry[]): SemanticChoiceConflict[] {
  if (process.env.DOCUMENT_SEMANTIC_CHOICE_CHECK === '0') return [];
  if (decisionLock.length === 0) return [];
  const conflicts: SemanticChoiceConflict[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/u)) {
    const trimmed = line.trim();
    // 标题行/表格行跳过：标题由 1.4 专轮治理，表格单元格语义碎片化不参与整句判定
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^\|/u.test(trimmed)) continue;
    for (const part of trimmed.split(/(?<=[。；;])/u)) {
      const sentence = part.trim();
      if (sentence.length < 6 || sentence.length > 200) continue;
      for (const entry of decisionLock) {
        const meta = decisionLockCategoryMeta(entry.id);
        if (!meta || !meta.relevance.test(sentence)) continue;
        const lockedSet = new Set(entry.values);
        for (const option of meta.options) {
          // 锁内取值合法（同目多值共存时提任一个都不算冲突）；锁外取值出现即冲突（锁契约：只能采用锁定值）
          if (lockedSet.has(option.value) || !option.aliases.test(sentence)) continue;
          // 否定语境不算冲突："不采用自拌混凝土"与锁定商品混凝土一致
          if (decisionMentionNegated(sentence, option.aliases)) continue;
          const key = `${entry.id} ${option.value} ${sentence}`;
          if (seen.has(key)) continue;
          seen.add(key);
          conflicts.push({ categoryId: entry.id, label: entry.label, lockedValues: entry.values, offValue: option.value, sentence });
        }
      }
    }
  }
  return conflicts;
}

/** 语义矛盾条目转交付阻断 ValidationIssue（消息携带锁定值/冲突值与引号原句——修复指令锚点与章节定位同源） */
export function semanticChoiceConflictIssue(conflict: SemanticChoiceConflict): ValidationIssue {
  return {
    level: 'error',
    severity: 'blocker',
    category: 'fact_consistency',
    owner: 'llm',
    repairability: 'llm_repairable',
    message: `语义矛盾（${conflict.label}）：项目关键决策已锁定为「${conflict.lockedValues.join('、')}」，正文出现「${conflict.offValue}」冲突表述：“${conflict.sentence.slice(0, 60)}”`,
    suggestion: '与已锁定决策冲突的表述必须统一为锁定值（或整句删除）；禁止保留两套并存的技术路线/机械选型/供应方式。禁止将本缺陷描述与修复要求本身写入正文，输出仅限正文内容。',
  };
}

/**
 * D3 快照复用工厂：同一正文的重复审查（blocker 复检 / 交付前轮 / 交付前复检）只跑一次 LLM。
 * 三防线防脏设计：
 * ① 正文哈希门禁——markdown 任一字节变化（修复 patch 落位后）即作废重跑，杜绝复用陈旧矛盾清单；
 * ② 快照写入门禁——仅当本次调用未产生 LLM 错误（diagnostics.llm.lastError 未变化）才写快照，
 *    LLM 瞬态失败返回空清单与「确实无矛盾」不可区分，失败场景不写快照、后续调用重跑，宁可少复用不可脏复用；
 * ③ 内存级生命周期——快照是工厂闭包局部变量，不跨生成任务共享。
 */
export function buildDataConsistencyReviewCached(input: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics }) {
  let snapshot: { markdownHash: string; conflicts: DataConsistencyConflict[] } | undefined;
  return async (markdown: string): Promise<DataConsistencyConflict[]> => {
    const markdownHash = stableHash(markdown);
    if (snapshot?.markdownHash === markdownHash) return snapshot.conflicts;
    // 调用前清空 lastError 哨兵：reviewDataConsistency 内部仅失败路径写 lastError（llmClient 契约），
    // 调用后仍为空即本次审查成功（含数值句不足 2 条不调 LLM 的确定性短路）
    if (input.diagnostics) input.diagnostics.llm.lastError = undefined;
    const conflicts = await reviewDataConsistency(markdown, { signal: input.signal, diagnostics: input.diagnostics });
    if (input.diagnostics?.llm.lastError === undefined) snapshot = { markdownHash, conflicts };
    return conflicts;
  };
}
