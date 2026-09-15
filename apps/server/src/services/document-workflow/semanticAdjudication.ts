/**
 * S5 语义判定层（豁免拆除收口）：确定性检测器只做「结构定位」（候选 = 正文引用数值 + 上下文），
 * 一致性裁决交语义模型三态判定——词表/用字表/句法豁免全部废除：
 * - consistent：该句不以该数据的项目级口径陈述该数值（规格参数/检测频次/分区声明/分部分项或单体量/
 *   分村分工程明细/计划或阶段工期/工期管理阈值/施工组织分配/其他概念同形数字等）；
 * - conflict：确以该数据口径陈述且与权威值不一致；
 * - uncertain：判定不可用（模型未配置/调用失败/输出不可解析）或语境不足——显式暴露，不回退词表猜测。
 *
 * 无预置规则库/原型库/人工标注集：判定上下文全部来自候选自带正文与结构化数据投影（分工程明细等）。
 * 失败语义（不兜底）：调用失败不降级为 consistent——整批记 uncertain 并携带 unavailable 原因；
 * 判定成功的记录进进程级缓存（同内容候选跨检测点复用，零重复 LLM 调用）。
 */
import { stableHash } from './utils';
import { callDocumentLlmJson } from './llmClient';
import type { DocumentGenerationDiagnostics } from './types';
import type { DocumentJsonSchema } from './llmClient';

export type CitationCandidateKind = 'labor-peak' | 'total-days' | 'village-count' | 'quantity';

/** 判定候选：检测器结构定位产物（值 == 权威的引用不入候选） */
export interface CitationAdjudicationCandidate {
  id: string;
  kind: CitationCandidateKind;
  /** 数据主体（事实名/清单条目名） */
  subject: string;
  /** 正文中出现的数值 */
  value: number;
  unit: string;
  /** 该数据的项目级权威值 */
  authority: number;
  /** 数值所在上下文（含前一句与段首边界约束） */
  sentence: string;
  /** 判定辅助事实（分工程明细值等结构化数据投影） */
  facts?: string[];
}

export type AdjudicationConclusion = 'consistent' | 'conflict' | 'uncertain';

export interface AdjudicationRecord {
  id: string;
  conclusion: AdjudicationConclusion;
  rationale: string;
}

export interface AdjudicationOutcome {
  /** 全部输入候选的判定记录（含缓存命中与失败填 uncertain） */
  records: Map<string, AdjudicationRecord>;
  /** 判定不可用原因（调用失败/输出不可解析）：整批记 uncertain 并显式暴露，不回退词表 */
  unavailable?: string;
}

export interface AdjudicationOptions {
  diagnostics?: DocumentGenerationDiagnostics;
  signal?: AbortSignal;
  /** 单测注入（生产绑定 callDocumentLlmJson；模块内词法绑定无法被 vi.mock 拦截） */
  invokeJson?: (system: string, prompt: string) => Promise<unknown>;
}

export type CitationAdjudicator = (
  candidates: CitationAdjudicationCandidate[],
  options?: AdjudicationOptions,
) => Promise<AdjudicationOutcome>;

/** 单次判定调用候选上限（超限分批，防单次输出截断丢判定） */
export const CITATION_ADJUDICATION_BATCH_SIZE = 40;

/** 判定缓存容量上限（超限清空重建；判定记录为纯函数产物，清空只损失跨调用复用） */
const ADJUDICATION_CACHE_LIMIT = 4000;

const adjudicationCache = new Map<string, AdjudicationRecord>();

/** 单测专用：清空判定缓存（跨用例隔离） */
export function resetCitationAdjudicationCache(): void {
  adjudicationCache.clear();
}

const KIND_LABELS: Record<CitationCandidateKind, string> = {
  'labor-peak': '项目劳动力峰值（人）',
  'total-days': '项目总工期（日历天）',
  'village-count': '项目自然村数量（个）',
  quantity: '工程量清单条目汇总工程量',
};

const ADJUDICATION_SYSTEM_PROMPT = `你是施工组织设计文档的数值引用裁决器。任务：判断正文句中的数值是否「以该项目级数据的口径」陈述（项目级 = 全项目汇总/锁定口径）。
判定结论三选一：
- consistent：该句并非以该数据的项目级口径陈述该数值。典型非冲突形态：规格参数（间距/直径/厚度/强度等级）、检测频次或测点密度、分区/分段/分等级声明、分部分项或单体（单座/单栋/每座）工程量、分村/分工程/分标段明细值、计划或阶段工期、工期管理阈值（延误/预留/机动/占用天数）、施工组织分配（每X覆盖N个）、型号编号、其他概念的同形数字；或该句确以项目级口径陈述且数值与权威值一致。
- conflict：该句确以该项目级数据的口径陈述该数值，且数值与权威值不一致。
- uncertain：仅凭给定上下文无法判断该句是否在陈述该数据（不得猜测）。
注意：①权威值是该数据的项目级唯一锁定值（工程量清单汇总/蓝图推导）；②句中工程对象（村名/分项/单体/部位）限定了数值作用范围时，该数值不是项目级口径，判 consistent。
只返回 JSON，不要返回 markdown。`;

const ADJUDICATION_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['judgments'],
  properties: {
    judgments: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, required: true },
          conclusion: { type: 'string', minLength: 1, required: true },
          rationale: { type: 'string', minLength: 1, maxLength: 300, required: true },
        },
      },
    },
  },
};

/** 引用句上下文（判定输入）：数值所在句 + 前一句（跨句语境如「作业对象为单座公厕…主要工程量为…」），
 * 约束在段首边界内且回溯长度封顶（长段落只取近邻上下文，防 token 膨胀） */
export const CITATION_CONTEXT_MAX_BACK = 220;

export function buildCitationSentenceContext(markdown: string, at: number, matchLength = 0): string {
  const sentenceStart = Math.max(markdown.lastIndexOf('。', Math.max(0, at - 1)), markdown.lastIndexOf('\n', Math.max(0, at - 1))) + 1;
  const prevStart = Math.max(markdown.lastIndexOf('。', Math.max(0, sentenceStart - 1)), markdown.lastIndexOf('\n', Math.max(0, sentenceStart - 1))) + 1;
  const paraStart = markdown.lastIndexOf('\n\n', at);
  const paraFrom = paraStart === -1 ? 0 : paraStart + 2;
  let forwardDot = markdown.indexOf('。', at);
  if (forwardDot === -1) forwardDot = markdown.length;
  let forwardLine = markdown.indexOf('\n', at);
  if (forwardLine === -1) forwardLine = markdown.length;
  const from = Math.max(paraFrom, prevStart, at - CITATION_CONTEXT_MAX_BACK);
  const to = Math.max(Math.min(forwardDot, forwardLine) + 1, at + matchLength);
  return markdown.slice(from, to).trim();
}

function candidateCacheKey(candidate: CitationAdjudicationCandidate): string {
  return [candidate.kind, candidate.subject, candidate.value, candidate.unit, candidate.authority, candidate.facts?.join('|') ?? '', stableHash(candidate.sentence)].join('§');
}

function buildAdjudicationPrompt(candidates: CitationAdjudicationCandidate[]): string {
  const rows = candidates.map(candidate => JSON.stringify({
    id: candidate.id,
    数据类型: KIND_LABELS[candidate.kind],
    数据主体: candidate.subject,
    权威值: `${candidate.authority}${candidate.unit}`,
    正文引用值: `${candidate.value}${candidate.unit}`,
    所在句: candidate.sentence,
    ...(candidate.facts && candidate.facts.length > 0 ? { 判定辅助事实: candidate.facts } : {}),
  }));
  return `逐条裁决以下 ${candidates.length} 条正文引用候选是否以该项目级数据口径陈述该数值：\n${rows.join('\n')}\n只输出 JSON：{"judgments":[{"id":"...","conclusion":"consistent|conflict|uncertain","rationale":"不超过 60 字的依据"}]}；每条候选必须给出结论，不得遗漏。`;
}

/** 判定入口：缓存命中的候选零调用；未命中按批调用语义模型；失败整批记 uncertain（显式暴露原因）。
 * invokeJson 缺省绑定 callDocumentLlmJson（重试/截断修复/诊断归因由 llmClient 承担）。 */
export async function adjudicateCitationCandidates(
  candidates: CitationAdjudicationCandidate[],
  options: AdjudicationOptions = {},
): Promise<AdjudicationOutcome> {
  const records = new Map<string, AdjudicationRecord>();
  const pending: CitationAdjudicationCandidate[] = [];
  for (const candidate of candidates) {
    const cached = adjudicationCache.get(candidateCacheKey(candidate));
    if (cached) records.set(candidate.id, { ...cached, id: candidate.id });
    else pending.push(candidate);
  }
  if (pending.length === 0) return { records };
  const invoke = options.invokeJson ?? ((system: string, prompt: string) => callDocumentLlmJson<unknown>(system, prompt, {
    temperature: 0,
    diagnostics: options.diagnostics,
    signal: options.signal,
    schema: ADJUDICATION_SCHEMA,
    prefixKey: 'citation-adjudication',
  }));
  let unavailable: string | undefined;
  for (let offset = 0; offset < pending.length; offset += CITATION_ADJUDICATION_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + CITATION_ADJUDICATION_BATCH_SIZE);
    let parsed: { judgments?: Array<{ id?: unknown; conclusion?: unknown; rationale?: unknown }> } | undefined;
    try {
      parsed = await invoke(ADJUDICATION_SYSTEM_PROMPT, buildAdjudicationPrompt(batch)) as typeof parsed;
    } catch (error) {
      unavailable = `语义判定调用异常：${error instanceof Error ? error.message : String(error)}`;
      parsed = undefined;
    }
    if (!parsed || !Array.isArray(parsed.judgments)) {
      unavailable = unavailable ?? '语义判定调用失败（模型未返回有效 JSON）';
      for (const candidate of batch) {
        records.set(candidate.id, { id: candidate.id, conclusion: 'uncertain', rationale: unavailable });
      }
      continue;
    }
    const rawById = new Map<string, { conclusion?: unknown; rationale?: unknown }>();
    for (const entry of parsed.judgments) {
      if (entry && typeof entry.id === 'string') rawById.set(entry.id, entry);
    }
    for (const candidate of batch) {
      const raw = rawById.get(candidate.id);
      const conclusion: AdjudicationConclusion = raw?.conclusion === 'consistent' || raw?.conclusion === 'conflict' || raw?.conclusion === 'uncertain'
        ? raw.conclusion
        : 'uncertain';
      const rationale = typeof raw?.rationale === 'string' && raw.rationale.trim()
        ? raw.rationale.trim().slice(0, 120)
        : (raw ? '模型未给出判定依据' : '模型输出缺少该候选的判定');
      const record: AdjudicationRecord = { id: candidate.id, conclusion, rationale };
      records.set(candidate.id, record);
      // 仅缓存模型有效输出（失败/缺记录不缓存，下轮重试）
      if (raw) {
        if (adjudicationCache.size >= ADJUDICATION_CACHE_LIMIT) adjudicationCache.clear();
        adjudicationCache.set(candidateCacheKey(candidate), record);
      }
    }
  }
  return { records, unavailable };
}

export const defaultCitationAdjudicator: CitationAdjudicator = (candidates, options) => adjudicateCitationCandidates(candidates, options);
