import type { DocumentGenerationDiagnostics, ValidationIssue } from './types';
import { callDocumentLlmJson, type DocumentJsonSchema } from './llmClient';
import { stableHash } from './utils';

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

/** 全文数值句提取（L1 确定性结构提取）：含数值的正文句与表格行，采样上限 200 条 */
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
  return [...new Set(sentences)].slice(0, 200);
}

/** 全文数据一致性批量审查：数值句清单 → LLM 输出矛盾清单 JSON（置信度 <0.7 丢弃，最多 6 条） */
export async function reviewDataConsistency(markdown: string, options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {}): Promise<DataConsistencyConflict[]> {
  const numericLines = numericSentencesForReview(markdown);
  if (numericLines.length < 2) return [];
  const raw = await callDocumentLlmJson<{ conflicts?: DataConsistencyConflict[] }>(
    [
      '你是施工组织设计数据一致性审查器。',
      '给定全文含数值的句子/表格行清单（编号与内容），找出互相矛盾的数值对：',
      '- 同一口径必须一致而实际数值不同：劳动力峰值多处不一致、同一面积两处数字不同、总工期与分项工期冲突、同一节点日期两处不一致、表格合计与明细之和不等、人数×工期与总工日不自洽；',
      '- 只报确定的矛盾（itemA 与 itemB 明确矛盾且置信度 ≥0.8），不得臆造；',
      '- 不同口径的数值不算矛盾：建筑面积 vs 占地面积、不同施工阶段的各期人数、不同单位的表述；',
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
    suggestion: '全文数据口径必须唯一：以绑定资料（图纸/清单/招标文件）为准选定唯一值，统一矛盾数值对，删除或修正其余矛盾表述。',
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
