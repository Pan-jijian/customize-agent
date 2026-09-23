import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMaterialResidueLine, stripClarificationNarrative, stripDrawingPointerPhrases, stripSentenceLevelResidue } from './materialResidue';
import type {
  DocumentEvidence,
  DocumentGenerationDiagnostics,
  TenderRequirementEntry,
  TenderRequirementExclusion,
  TenderRequirementModel,
  TenderRequirementPolicy,
  TenderStructureForm,
  TenderStructureRequirement,
  ValidationIssue,
} from './types';
import { callDocumentLlmJson, type DocumentJsonSchema } from './llmClient';
import { generatedRoot } from '../document-core/generatedDocumentService';
import { cleanPdfHeadingNoise } from './factsModel';
import { SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';
import type { SemanticSimilarityFn } from './semanticSimilarity';
// 扬尘六个百分百词表/拆迁豁免判定单源（检测器侧定义）：本文件的词面兜底与检测器必须同一口径
import { sixHundredPercentLexicalHitCount } from './integrity/detectors/detectors';
import { isBidDisciplineSentence, isBidEvaluationRuleText, stableHash, systemConstraintLine } from './utils';
import { isBidderQualificationText, isContractProcedureClause } from './evidenceContentSafety';
import { classifyTenderContent, isCreditScoringContent } from './technicalBidAdmission';
import { docSystemPrefix } from './markdownComposer';
import { classifyPoolNoiseText, POOL_CONSTRAINT_WORD_RE, POOL_NOISE_RULE_SOURCES } from './poolNoise';

/**
 * 招标要求层（全量条款穷举范式，取代旧 10 字段「必提清单」归纳式提取）。
 *
 * 提取链：绑定资料 → 条款化（确定性结构切分，不预筛不剔除任何单元）→ 逐条判定（LLM 批量+序号严格对齐，
 * 每条必出判定）→ 三态归宿（entries 要写的 / excluded 不要的（带原因）/ 重复合并）→ 提取对账闭合
 * （条款总数 = entries + excluded + 未判定 0）。对账未闭合时缓存不落盘并显式告警。
 *
 * 消费链：① 蓝图统一分配（每条 entry 有唯一主责章，未分配=0）；② 章级验收（写作收口前逐条核验本章责任
 * 要求，按 policy 分流：respond=语义+锚点落位，comply=数据一致域核验）。商务域条款在判定层排除
 * （技术标正文零商务句），不进入要求池与验收链。
 * 「不能遗漏」由穷举+对账结构性保证，不再依赖事后补丁（窄通道/字段补提/复核通道/条目上限均已删除）。
 *
 * 判定失败/资料为空时返回 extracted=false 的空模型，下游不得据此阻断生成（LLM 不可用不得阻塞）。
 */

/** 空模型（LLM 不可用/无绑定资料时的降级产物） */
export function emptyTenderRequirements(extracted = false): TenderRequirementModel {
  return {
    entries: [],
    excluded: [],
    structureRequirements: [],
    reconciliation: { clauseCount: 0, entryCount: 0, excludedCount: 0, undecidedCount: 0, mergedCount: 0, batchCount: 0, retriedBatches: 0, structureCount: 0 },
    extracted,
  };
}

/** 简单文本哈希（与提示词规则 sourceHash 同族算法，供本模块缓存键内部使用） */
function tenderRequirementsSourceHash(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** 条款「无值」表述（值部分为无/勾选无/指向数据表占位）：不是实质要求，判定后确定性复核丢弃。
 * 真实生成回归：新版招标文件前附表10.9「创优目标 ☑无」、数据表5.1.1「绿色建筑等级要求：无」
 * 被 LLM 忠实提取成字段值，下游把「无」当要求响应写作。 */
const EMPTY_CLAUSE_VALUE_RE = /^(?:☑?\s*无|无)\s*[。；;]?\s*$|：\s*(?:☑)?\s*无\s*[。；;]?\s*$|：\s*见\s*《?[^》]{2,40}》?\s*[。；;]?\s*$/u;

/** 句级无值判定：命中句的值部分为无/勾选无/纯条款名（无值部分）→ 无实质内容可提 */
function clauseSentenceHasNoValue(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (!trimmed) return true;
  // 纯条款名句（编号+条款名，无冒号值部分）：如「10.9创优目标」「5.1.1特殊质量标准和要求」
  if (/^#{0,6}\s*\d+(?:[.-]\d+)*\s*[^\s。；;：:]{1,24}$/u.test(trimmed)) return true;
  // 勾选无（前附表表格句，如「10.9 创优目标 ☑无 □有，具体要求如下： /」）
  if (/☑\s*无/u.test(trimmed)) return true;
  // 「□有，具体要求如下：/」——「有」未勾选（□ 非 ☑）且具体要求为空
  if (/□有[^。；;！？!?]{0,40}具体要求如下[：:]\s*\/?\s*$/u.test(trimmed)) return true;
  // 值部分为无或占位指引：取最后一个「：」后的值部分判定（无冒号时整句判定）
  const valuePart = trimmed.split('：').pop()?.trim() || trimmed;
  if (EMPTY_CLAUSE_VALUE_RE.test(valuePart)) return true;
  return false;
}

/** 纯引导词碎片（「回复：」「答：/」等引导词后无内容的残行）：无实质要求内容，判定后确定性复核丢弃 */
const BARE_REPLY_RE = /^(?:回复|答复|答疑|答|澄清|释义)[：:]\s*[。；;、/]?\s*$/u;

/** 章节标题行归一化：去 markdown 标题前缀与编号前缀，保证与相似度闭包缓存 key 一致（缓存 miss 会静默返回 0） */
export function normalizeChapterTitleLine(line: string): string {
  return line.trim().replace(/^#{2,4}\s+/u, '').replace(/^\d+(?:\.\d+)*[\s、.]+/u, '').trim();
}

// ═══════════════════════════════ L1 条款化（确定性结构切分） ═══════════════════════════════

/** 条款单元（来源定位完整：文件/章节/条款号），穷举切分产物，逐条判定输入 */
export interface TenderClauseUnit {
  file?: string;
  section?: string;
  clauseNo?: string;
  text: string;
}

/** 编号行识别（行首编号形态）：第X条/第X章、（一）/（1）、一、、1、5.1.1、10.9 等。
 * 各模式均要求编号后有分隔符或非数字后继，防「300万元」「2.5米」类参数句被误识别为编号 */
const CLAUSE_NUMBER_PATTERNS: RegExp[] = [
  /^第[零一二三四五六七八九十百千\d]{1,6}[条章节款项]/u,
  /^[（(][一二三四五六七八九十\d]{1,3}[）)]/u,
  /^[一二三四五六七八九十]{1,3}[、．.](?!\d)/u,
  /^\d{1,2}(?:[.．]\d{1,2}){1,3}(?:[、.．]|\s)/u,
  /^\d{1,2}[、.．]\s*(?![\d%])/u,
];

function extractClauseNumber(line: string): string | undefined {
  for (const pattern of CLAUSE_NUMBER_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return match[0].trim().replace(/[、.．\s]$/u, '');
  }
  return undefined;
}

/** 短「名：值」行（≤300 字符且含冒号）：表格行/键值条款独立成单元，避免整表并成巨型单元 */
function isShortKeyValueLine(line: string): boolean {
  return line.length <= 300 && /[：:]/u.test(line) && !/[。；;]/u.test(line.slice(0, line.search(/[：:]/u)));
}

/** 答疑问题行（暂挂等待「回复：」配对）：问题/疑问类前缀行（可带编号），或行尾为问号 */
const QUESTION_SUSPEND_RE = /^(?:问题|疑问|提问|咨询|质疑|问)[一二三四五六七八九十\d]{0,3}[：:]|[？?]\s*$/u;

/** 答疑回复行：并入上文问题单元成为问答配对；缓冲为空（悬空回复）时独立成单元交判定层复核 */
const REPLY_LEAD_RE = /^(?:回复|答复|答疑|答|澄清|释义)[：:]/u;

/** 微碎片（≤8 字、无句末标点、无数字参数，如「续表」「附：」「/」残片）：无独立语义，与相邻单元归并，
 *  资料末尾仍无相邻单元时兜底独立产出（不丢数据） */
function isMicroFragmentText(text: string): boolean {
  return text.length <= 8 && !/[。；;！？!?]/u.test(text) && !/\d/u.test(text);
}

/** 行尾闭合判定（跨空行续行拼接用）：句末标点/闭合引号括号结尾视为行语义完整，空行即真段落边界 */
function lineClosedForJoin(text: string): boolean {
  return /[。！？!?；;）)】」》”]$/u.test(text.trim());
}

/** 断尾字（标题残片结尾）：以虚词/连接词结尾的短行是被竖切/折行裁断的残片，不像标题末字 */
const SECTION_TAIL_BREAK_RE = /[的其不或在和与及等被把将为以对从向就但而则即如若因所该本此录]$/u;
const SECTION_HAN2_RE = /[\p{Script=Han}A-Za-z]{2,}/u;

/**
 * 假标题判定（提取器行级 markdown 化的误标容错）：PDF 提取器对「≤80 字且无句末标点」的行
 * 会加 ### 前缀（折行半句与真标题同形）。假标题进 section 会静默吞字、其裸续行成孤立碎片
 * （丰乐镇门禁链根因）。误吞代价（真标题当内容→判定层排除）≈0；误判代价（内容当 section→丢字）高——
 * 仅高置信结构标题保留 section，其余一律转正文（跨空行续行拼接兜住语义完整、内容零丢失）。
 * 返回 true = 假标题（转正文行）。
 */
function isExtractorFalseHeading(text: string): boolean {
  if (!text) return false;
  if (/(?:\.{3,}|…)/u.test(text)) return false; // 目录项（省略号结尾，保持 section 行为）
  if (/^(?:PDF 第 \d+ 页|PDF 表格区域)/u.test(text)) return false; // 页/表格区标记（位置定位有价值）
  if (/[☑□■☐☒√×]/u.test(text)) return true; // 勾选符号行 = 表格内容
  if (text.length <= 3 && !/^\d/u.test(text)) return true; // 超短残片（「室」「录」）
  // 白名单①：第X章/条/部分/编（无冒号逗号）
  if (/^第[一二三四五六七八九十\d]+[章节部分条编]/u.test(text) && text.length <= 40 && !/[：:，,]/u.test(text)) return false;
  // 白名单②：目录/附录/附件行
  if (/^(?:目录|附录|附件)/u.test(text) && text.length <= 30 && !/[：:，,]/u.test(text)) return false;
  // 白名单③：数字编号标题（「1.5合同文件的优先顺序」），剥编号后≥2 汉字且非断尾
  if (/^\d+(?:[.．]\d+)*[.．、]?\s*\S/u.test(text) && text.length <= 24 && !/[：:，,。；;（）]/u.test(text) && !SECTION_TAIL_BREAK_RE.test(text)
    && SECTION_HAN2_RE.test(text.replace(/^\d+(?:[.．]\d+)*[.．、]?\s*\d*\s*/u, ''))) return false;
  // 白名单④：中文编号标题（「一、总则」「（一）概述」），剥编号后≥2 汉字
  if (/^[一二三四五六七八九十]{1,3}[、．.](?!\d)/u.test(text) && text.length <= 24 && !/[：:，,。；;（）]/u.test(text)
    && SECTION_HAN2_RE.test(text.replace(/^[一二三四五六七八九十]{1,3}[、．.\s]*/u, ''))) return false;
  if (/^[（(][一二三四五六七八九十\d]{1,3}[）)]/u.test(text) && text.length <= 24 && !/[：:，,。；;（）]/u.test(text.replace(/^[（(][一二三四五六七八九十\d]{1,3}[）)]/u, ''))
    && SECTION_HAN2_RE.test(text.replace(/^[（(][一二三四五六七八九十\d]{1,3}[）)]\s*\d*\s*/u, ''))) return false;
  return true; // 其余一律转正文
}

/** 超长单元二次切分：按句末标点打包为 ≤2000 字符的子单元（不丢任何句子） */
const CLAUSE_UNIT_MAX_CHARS = 2000;

function splitOversizedText(text: string): string[] {
  if (text.length <= CLAUSE_UNIT_MAX_CHARS) return [text];
  const sentences = text.split(/(?<=[。；;！？!?])/u);
  const units: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > CLAUSE_UNIT_MAX_CHARS) {
      units.push(current);
      current = '';
    }
    current += sentence;
  }
  if (current) units.push(current);
  return units.length > 0 ? units : [text];
}

/**
 * 条款化：对全部招标绑定资料按结构确定性切分（标题/编号/短键值行/空行段落边界），
 * 不剔除任何单元（旧预筛「切片级剔除无记录」是遗漏源，已删除——聚焦由逐条判定承担，不丢数据）。
 * 每个单元带来源定位（文件/章节/条款号），超长单元按句二次切分。
 */
export function splitTenderClauses(evidence: DocumentEvidence[]): TenderClauseUnit[] {
  const clauses: TenderClauseUnit[] = [];
  for (const item of evidence) {
    const content = item.content || '';
    if (!content.trim()) continue;
    const file = item.filePath || undefined;
    let section = item.sectionTitle?.trim() || undefined;
    let clauseNo: string | undefined;
    let buffer: string[] = [];
    // 微碎片暂挂：无独立语义的残片延迟到有相邻单元时归并；资料末尾仍孤立即兜底独立产出（不丢数据）
    const pending: { fragment: { text: string; clauseNo?: string } | null } = { fragment: null };
    const emit = (text: string, no: string | undefined) => {
      const units = splitOversizedText(text);
      units.forEach((unit, unitIndex) => {
        clauses.push({
          file,
          section,
          clauseNo: no ? (units.length > 1 ? `${no}-${unitIndex + 1}` : no) : undefined,
          text: unit,
        });
      });
    };
    const flush = () => {
      let text = buffer.join('\n').trim();
      const no = clauseNo;
      buffer = [];
      clauseNo = undefined;
      if (!text) return;
      const pendingNo = pending.fragment?.clauseNo || no;
      if (pending.fragment) {
        text = `${pending.fragment.text}\n${text}`;
        pending.fragment = null;
      }
      if (isMicroFragmentText(text)) {
        pending.fragment = { text, clauseNo: pendingNo };
        return;
      }
      emit(text, pendingNo);
    };
    for (const rawLine of content.split(/\r?\n/u)) {
      // markdown 标题行（# 是结构标记而非噪声，清洗前判定）：更新 section 上下文，不作为条款单元
      const rawTrimmed = rawLine.trim();
      if (/^#{1,6}\s/u.test(rawTrimmed)) {
        const heading = cleanPdfHeadingNoise(rawTrimmed).trim();
        if (!heading) continue;
        // 假标题容错（提取器折行半句可能被误标为任意级别 #，见 isExtractorFalseHeading）：
        // 白名单外一律转正文行并入缓冲，与相邻断句续行拼回完整句（内容零丢失）；
        // 真结构标题（页标记/第X章/目录附录等）仍进 section
        if (isExtractorFalseHeading(heading)) {
          if (/^\d{1,3}$/u.test(heading)) continue; // 孤立页码残片（页脚数字）不参与拼接
          if (isShortKeyValueLine(heading)) {
            // 折行续段（上句未闭合）：接续上缓冲而非新开 KV 单元
            if (buffer.length > 0 && !lineClosedForJoin(buffer[buffer.length - 1])) { buffer.push(heading); continue; }
            if (buffer.length > 0) flush();
            buffer.push(heading);
            if (!QUESTION_SUSPEND_RE.test(heading) && lineClosedForJoin(heading)) flush();
            continue;
          }
          buffer.push(heading);
          continue;
        }
        if (buffer.length > 0) flush();
        section = heading;
        continue;
      }
      const line = cleanPdfHeadingNoise(rawTrimmed).trim();
      if (!line) {
        // 空行=段落边界（仅当缓冲尾部语义闭合时才收口）：PDF 折行会跨空行断句
        // （「…并再次确」/空行/「认使用时限。」），无条件 flush 会把续行切成孤立碎片（门禁假阳性源）
        if (buffer.length > 0 && lineClosedForJoin(buffer[buffer.length - 1])) flush();
        continue;
      }
      if (/^\d{1,3}$/u.test(line)) continue; // 孤立页码残片（页脚数字）不参与拼接
      // 答疑回复行：与上文（问题/编号）同缓冲配对；缓冲为空即悬空回复，独立成单元交判定层复核
      if (REPLY_LEAD_RE.test(line)) {
        buffer.push(line);
        if (buffer.length === 1) flush();
        continue;
      }
      const numbered = extractClauseNumber(line);
      if (numbered) {
        if (buffer.length > 0) flush();
        clauseNo = numbered;
        buffer.push(line);
        continue;
      }
      if (isShortKeyValueLine(line)) {
        // 折行续段（上句未闭合）：接续上缓冲而非新开 KV 单元（「2.6建设规模：…配套基础」+「设施工程：…」）
        if (buffer.length > 0 && !lineClosedForJoin(buffer[buffer.length - 1])) { buffer.push(line); continue; }
        if (buffer.length > 0) flush();
        buffer.push(line);
        // 答疑问题行暂挂等待「回复：」配对（配对单元上下文完整，判定更准）；其余键值行独立成单元
        if (!QUESTION_SUSPEND_RE.test(line) && lineClosedForJoin(line)) flush();
        continue;
      }
      buffer.push(line);
    }
    if (buffer.length > 0) flush();
    // 资料末尾兜底：仍暂挂的微碎片独立产出（不丢数据）
    if (pending.fragment) {
      emit(pending.fragment.text, pending.fragment.clauseNo);
      pending.fragment = null;
    }
  }
  return clauses;
}

// ═══════════════════════════════ L1 逐条判定（每条必出判定） ═══════════════════════════════

interface RawClauseJudgment {
  index?: number;
  isRequirement?: boolean;
  inScope?: boolean;
  reason?: string;
  policy?: string;
  coreTerms?: string[];
  category?: string;
  /** A-T1 结构/呈现信号（语义通道）：element 呈现对象 + form 形态 */
  structures?: Array<{ element?: string; form?: string }>;
}

const CLAUSE_JUDGE_JSON_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      required: true,
      minItems: 1,
      items: {
        type: 'object',
        required: true,
        properties: {
          index: { type: 'number', required: true },
          isRequirement: { type: 'boolean', required: true },
          inScope: { type: 'boolean', required: true },
          reason: { type: 'string', maxLength: 32 },
          policy: { type: 'string', maxLength: 16 },
          coreTerms: { type: 'array', items: { type: 'string', maxLength: 24 } },
          category: { type: 'string', maxLength: 16 },
          structures: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                element: { type: 'string', maxLength: 24 },
                form: { type: 'string', maxLength: 16 },
              },
            },
          },
        },
      },
    },
  },
};

/** 判定批大小与并发度：批内 40 条保证序号对齐可靠性；并发 3 路控制总时长（判定互为独立，可并行） */
const CLAUSE_BATCH_SIZE = 40;
const CLAUSE_BATCH_CONCURRENCY = 3;

const CLAUSE_JUDGE_PROMPT = [
  docSystemPrefix('你是招标文件条款判定器。'),
  '输入是从招标资料（招标文件/补疑/答疑等）中按原文顺序切分的条款单元（含全局序号与来源）。',
  '对每一条独立完成判定，且必须为每一条给出结果（不得遗漏任何序号）。',
  '',
  '1. isRequirement：该条是否构成对投标人的实质要求（需写入正文响应或必须遵守）？',
  '   - true：明确的目标/等级/标准/参数/义务/禁止性要求（确保、达到、不低于、不得、严禁、必须、应当等约束语义）',
  '   - false：目录、章节导语、说明性/解释性文字、空白表头、格式模板、无约束力的描述',
  '   - 边界判例（格式模板 vs 结构呈现要求）：表格填写/签章格式/装订份数类模板说明 → false；',
  '     「组织机构以框图方式表示」「采用文字并结合图表形式编制」「附网络图、横道图」等呈现形态要求 → true（呈现信息同时进入 structures 通道）',
  '   - 孤立碎片（无问题上下文的「回复：××」「答：××」、表格残片、无法独立理解的半截句）→ false（reason="non_requirement"）',
  '   - 问答对（「问题：×× … 回复：××」）：答复含实质要求（指标/标准/义务/禁止性内容）→ true（按答复内容给出 policy/coreTerms）；纯程序性答复（「按招标文件执行」「详见补遗」）→ false',
  '   - 条款值被明确标注「无」「☑无」「不适用」「/」时 → isRequirement=false（reason="no_value"）',
  '   - 工程量清单条目、项目特征描述、工程量数据不是本通道要求（由清单蓝图通道处理）→ false',
  '2. inScope：该条是否属于施工组织设计正文的职责范围？',
  '   - true：质量/工期/安全/环保目标、创优奖项、绿色建筑/智慧工地/装配式等级、体系基准（六个百分百/四节一环保等）、',
  '     工期与进度约束、人员配置与分包限制、材料工艺与验收标准、禁止性事项、必须遵守的技术约束',
  '   - false：纯投标程序事务（开标时间地点/保证金账户信息/递交解密方式/评标委员会组成）、投标资格条件',
  '     （营业执照/资质证书/业绩要求）、评标否决规则（否决其投标/废标情形）、商务纪律承诺（廉洁承诺）、格式签章要求、',
  '     商务与造价条款（付款/进度款/工程款/结算/保证金/违约金/保函/预付款/税金/税率/报价/综合单价/暂列金额/暂估价/限价/调差等，',
  '     属商务标响应内容，技术标正文不出现）、',
  '     合同履约管理程序条款（施工合同通用/专用条款及合同附件的程序性与责任性约定：资料报送/审批/备案期限、',
  '     违约责任与违约金罚款明细、人员请假/更换/离场批准程序、保险投保办理程序、工程质量保修书程序与保修期限明细、',
  '     试验条件自理、工程照管责任起止、治安保卫程序、分包审批程序、采购与评标程序——属合同管理范畴，技术标正文不逐条抄写；',
  '     但质量/安全/文明/工期目标、人员资格与配置、技术工艺与验收标准类实质要求仍按 true 判定）',
  '3. policy（isRequirement 且 inScope 时必填，其余省略）：',
  '   - "respond"：必须在正文显性写出的要求（创优目标/奖项、质量目标、等级指标、体系基准、技术工艺条款、人员与分包约束、验收标准）',
  '   - "comply"：不逐条抄写但全文必须遵守的约束（以开工令为准的日期约束、工期总日历天数基准、全局禁止性事项）',
  '4. coreTerms：2-4 个用于正文核对的核心词（专有名词/等级名/体系名/关键数字参数，如「××杯」「二星级」「六个百分百」「300万元」）；',
  '   数字参数必须保留数字与单位；不要泛化词（「施工」「工程」类不能作为核心词）；',
  '   必须是正文中可自然逐字出现的完整词/短语（括号/标点保持原文形态），不得使用去标点拼接的短语碎片或合同填空语言（如「承包人自理」）',
  '5. category：按招标语义命名类别（如「质量创优」「工期进度」「安全文明」「绿色施工」「人员管理」「商务支付」「禁止性要求」），',
  '   同类要求使用同一类别名',
  '6. structures：该条是否明文要求内容的呈现形态？命中时输出数组（element 呈现对象名 + form 形态），无呈现要求时省略该字段：',
  '   - form 枚举：“org_chart”（框图/组织机构图/组织结构图）、“diagram”（网络图/横道图/平面布置图/进度计划图）、“table”（表格/组成表）、“chart_text”（文字结合图表/图表形式编制）',
  '   - element：呈现对象的名词短语（如「项目管理机构」「施工总平面布置」「施工进度计划」），不得与原文无关',
  '   - 边界判例：「组织机构以框图方式表示」→ [{element:"项目管理机构",form:"org_chart"}]；「采用文字并结合图表形式编制」→ [{element:"施工组织设计",form:"chart_text"}]；',
  '     纯格式填写说明/签章装订要求（按给定格式填写并盖章/正副本份数）→ 不输出 structures',
  '   - 呈现要求与 isRequirement/inScope 判定相互独立：即使本条因程序/格式原因被判排除，structures 仍须输出',
  '',
  'isRequirement=false 或 inScope=false 时须给出 reason（枚举）：',
  '- "non_requirement"：非约束性内容（目录/导语/说明/描述）',
  '- "out_of_scope"：超出施组职责（投标程序/资格/评标规则/纪律/格式/商务与造价/合同履约管理程序）',
  '- "no_value"：条款值为「无」或不适用',
  '',
  '输出 JSON 结构（覆盖全部序号，每序号必出结果）：',
  '{ "results": [',
  '  { "index": 0, "isRequirement": true, "inScope": true, "policy": "respond", "coreTerms": ["××杯", "300万元"], "category": "质量创优" },',
  '  { "index": 1, "isRequirement": false, "inScope": false, "reason": "out_of_scope" },',
  '  { "index": 2, "isRequirement": false, "inScope": false, "reason": "out_of_scope", "structures": [{ "element": "项目管理机构", "form": "org_chart" }] }',
  '] }',
  '只返回 JSON。',
].join('\n');

function cleanCoreTerms(terms: string[] | undefined): string[] {
  if (!Array.isArray(terms)) return [];
  return terms.map(term => (term || '').trim()).filter(term => term.length >= 2 && term.length <= 24).slice(0, 4);
}

function normalizePolicy(policy: string | undefined): TenderRequirementPolicy {
  if (policy === 'comply') return policy;
  return 'respond';
}

function normalizeExclusionReason(judgment: RawClauseJudgment): TenderRequirementExclusion['reason'] {
  if (judgment.reason === 'no_value' || judgment.reason === 'out_of_scope' || judgment.reason === 'non_requirement') return judgment.reason;
  if (judgment.isRequirement === true && judgment.inScope === false) return 'out_of_scope';
  return 'non_requirement';
}

function cleanCategory(category: string | undefined): string {
  const trimmed = (category || '').trim();
  if (!trimmed || trimmed.length > 16) return '其他要求';
  return trimmed;
}

// ═══════════════════════════════ A-T1 结构/呈现要求（第三态通道） ═══════════════════════════════
// 病根：格式类条款（「组织机构以框图方式表示」等）被判 non_requirement/out_of_scope 后，
// 其中的图表/结构信息永久丢失，下游写作链缺图缺组织。本通道对**每一条**条款（含被排除的）
// 扫描结构/呈现信号，独立于响应域存入要求模型，供写作注入与终稿验收消费。

/** 结构信号规则（通用词表，与项目无关）：形态词 + 要素上下文词；element 未命中时用兜底要素名 */
const STRUCTURE_FORM_RULES: Array<{
  form: TenderStructureForm;
  formRe: RegExp;
  elementRules: Array<{ re: RegExp; element: string }>;
  fallbackElement: string;
}> = [
  {
    form: 'org_chart',
    formRe: /框图|组织机构图|组织结构图|组织架构图/u,
    elementRules: [{ re: /项目管理机构|项目经理部|项目班子|管理机构|组织机构|管理部门/u, element: '项目管理机构' }],
    fallbackElement: '组织机构',
  },
  {
    form: 'diagram',
    formRe: /网络图/u,
    elementRules: [{ re: /进度|工期|计划/u, element: '施工进度计划网络图' }],
    fallbackElement: '网络图',
  },
  {
    form: 'diagram',
    formRe: /横道图|甘特图/u,
    elementRules: [{ re: /进度|工期|计划/u, element: '施工进度计划横道图' }],
    fallbackElement: '横道图',
  },
  {
    form: 'diagram',
    formRe: /总平面布置图|施工总平面图|总平面图|平面布置图|临时设施图|施工总平面布置/u,
    elementRules: [],
    fallbackElement: '施工总平面布置图',
  },
  {
    form: 'table',
    formRe: /组成表|机构设置表|人员配备表|一览表/u,
    elementRules: [
      { re: /机械设备|施工机械|设备/u, element: '施工机械设备表' },
      { re: /劳动力|用工/u, element: '劳动力安排计划表' },
      { re: /项目管理机构|机构|人员/u, element: '项目管理机构人员组成表' },
    ],
    fallbackElement: '要求表格',
  },
  {
    form: 'chart_text',
    formRe: /结合图表|图表形式|图文并茂/u,
    elementRules: [{ re: /施工组织设计/u, element: '施工组织设计' }],
    fallbackElement: '图表呈现',
  },
];

/** 确定性结构信号扫描（词表兑底，不依赖 LLM 波动——A-T2 稳定性加固） */
export function detectStructureRequirements(text: string): TenderStructureRequirement[] {
  const results: TenderStructureRequirement[] = [];
  const trimmed = text.trim();
  if (!trimmed) return results;
  for (const rule of STRUCTURE_FORM_RULES) {
    if (!rule.formRe.test(trimmed)) continue;
    let element = rule.fallbackElement;
    for (const candidate of rule.elementRules) {
      if (candidate.re.test(trimmed)) {
        element = candidate.element;
        break;
      }
    }
    results.push({ element, form: rule.form, sourceText: trimmed });
  }
  return results;
}

/** LLM 语义 form 归一化（仅接受枚举值；中文表述兼容映射） */
function normalizeStructureForm(form: string | undefined): TenderStructureForm | undefined {
  const value = (form || '').trim().toLowerCase();
  if (value === 'org_chart' || value === 'orgchart' || value === '框图' || value === '组织机构图') return 'org_chart';
  if (value === 'diagram' || value === '图' || value === '网络图' || value === '横道图') return 'diagram';
  if (value === 'table' || value === '表格') return 'table';
  if (value === 'chart_text' || value === 'charttext' || value === '图表' || value === '文字结合图表') return 'chart_text';
  return undefined;
}

/** 单条款结构信号采集：确定性词表 + LLM 语义字段合并去重（两者任一命中即产出，信号不随排除丢失） */
function collectClauseStructureRequirements(clause: TenderClauseUnit, judgment: RawClauseJudgment | undefined): TenderStructureRequirement[] {
  const collected = detectStructureRequirements(clause.text);
  for (const item of judgment?.structures || []) {
    const form = normalizeStructureForm(item?.form);
    const element = (item?.element || '').trim().slice(0, 24);
    if (!form || element.length < 2) continue;
    if (collected.some(existing => existing.form === form && existing.element === element)) continue;
    collected.push({ element, form, sourceText: clause.text.trim() });
  }
  return collected;
}

/** 跨条款结构要求合并：同「形态+要素」只保留一条（首见原文；不参与响应域对账等式） */
function mergeStructureRequirements(items: TenderStructureRequirement[]): TenderStructureRequirement[] {
  const byKey = new Map<string, TenderStructureRequirement>();
  for (const item of items) {
    const key = `${item.form}|${item.element}`;
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

/** 表格声明套话（A-T3 池纯度）：格式表格“我公司对该表内容均属真实”类声明句——
 * 非实质要求，确定性剔除出要求池（防假条目参与评分）。 */
const TABLE_DECLARATION_BOILERPLATE_RE = /(?:我(?:公司|方|单位|们)[^。；;]{0,24}(?:对|就)(?:该|本|上述|所填)?(?:表|清单|资料)[^。；;]{0,32}(?:均属|均为|真实|属实|可靠|有效|无误))|(?:(?:以上|上述|该表|所填报?)[^。；;]{0,20}(?:内容|资料)[^。；;]{0,20}(?:均属|均为|真实|属实|可靠|有效|无误))/u;

function isTableDeclarationBoilerplate(text: string): boolean {
  return TABLE_DECLARATION_BOILERPLATE_RE.test(text);
}

/** 全文档性遵守约束（禁编日期/全局禁止事项）：同时进入全局写作口径区的标记口径 */
const GLOBAL_COMPLY_RE = /开工令|开工日期|竣工日期|不得.{0,12}(?:自定|自行确定|编造|设定)/u;

function formatClauseSource(clause: TenderClauseUnit): string | undefined {
  const location = [clause.section, clause.clauseNo ? `条款${clause.clauseNo}` : ''].filter(Boolean).join('·');
  const source = [clause.file, location].filter(Boolean).join('｜');
  return source || undefined;
}

function clauseSourceObject(clause: TenderClauseUnit): { file?: string; location?: string } {
  const location = [clause.section, clause.clauseNo ? `条款${clause.clauseNo}` : ''].filter(Boolean).join('·');
  return { file: clause.file || undefined, location: location || undefined };
}

/** 并发池：按 limit 并发执行 worker（判定批互为独立任务，结果按序返回） */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = next;
      next += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  }));
  return results;
}

interface ClauseBatchOutcome {
  judgments: Map<number, RawClauseJudgment>;
  retried: boolean;
}

/** 单批判定：序号严格对齐（缺号重试一次），返回该批已判定集合（仍缺的序号由调用侧记入未判定） */
async function judgeClauseBatch(
  batch: TenderClauseUnit[],
  offset: number,
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<ClauseBatchOutcome> {
  const sourceTexts = batch.map((clause, index) => {
    const source = formatClauseSource(clause);
    return `【条款 ${offset + index}】${source ? `来源：${source}` : ''}\n${clause.text}`;
  }).join('\n\n');
  const expected = new Set(batch.map((_, index) => offset + index));
  let judgments = new Map<number, RawClauseJudgment>();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await callDocumentLlmJson<{ results?: RawClauseJudgment[] }>(
      CLAUSE_JUDGE_PROMPT,
      sourceTexts,
      {
        maxTokens: 8000,
        temperature: 0,
        signal: options.signal,
        diagnostics: options.diagnostics,
        schema: CLAUSE_JUDGE_JSON_SCHEMA,
        taskKind: 'structuredGeneration',
      },
    );
    judgments = new Map<number, RawClauseJudgment>();
    for (const item of raw?.results || []) {
      if (typeof item.index === 'number' && expected.has(item.index)) judgments.set(item.index, item);
    }
    if (judgments.size === expected.size) return { judgments, retried: attempt > 0 };
  }
  return { judgments, retried: true };
}

export interface TenderClauseJudgmentResult {
  entries: TenderRequirementEntry[];
  excluded: TenderRequirementExclusion[];
  undecided: TenderClauseUnit[];
  /** A-T1 结构/呈现要求（与响应域独立：被排除条款同样扫描产出，已合并去重） */
  structureRequirements: TenderStructureRequirement[];
  batchCount: number;
  retriedBatches: number;
}

/** 条款实现约束词（碎片形态复核用）：含任一即视为有实质语义的短句，保留交判定层处理；与池噪声判定的
 * 「无约束词」守卫同源（poolNoise.POOL_CONSTRAINT_WORD_RE，单源防口径分裂） */
const CLAUSE_CONSTRAINT_WORD_RE = POOL_CONSTRAINT_WORD_RE;

/** 碎片形态判定（判定层兼底闸）：≤10 字、无数字、无约束谓词的残片（折行半句/表格残片/跨页断句，
 *  如「认使用时限。」「币）。」）不构成独立要求（宁缺毋假）；含数字（参数）或约束词的短句保留 */
function clauseFragmentLike(text: string): boolean {
  const compact = text.replace(/\s+/gu, '');
  return compact.length <= 10 && !/\d/u.test(compact) && !CLAUSE_CONSTRAINT_WORD_RE.test(compact);
}

/**
 * 要求池纯度复核（r28h M10 实机归因，单项目未响应条目分型统计后提取的形态判据）：
 * 以下形态属投标/合同/考核程序与澄清信息，不是施组应逐条响应的施工义务——LLM 判定层漏判时本地确定性纠正
 * （与 isContractProcedureClause 同层接线，reason=non_requirement）：
 * ① 答疑澄清（「回复：/答复：」标记）——招标答疑文件的答复条目（含做法/量价澄清），信息经事实/参数池承接，
 *    响应义务不成立（s28h2 实测约 1/4 未响应条目）；
 * ② 履约考核惩奖细则（扣N分/百分制/考核评分·结果·得分·扣分·奖惩）——养护/履约考核办法条款
 *    （s28h2 实测约 1/3；「安全技术考核」「考核合格证书」类施工语境不命中）；
 * ③ 质量保修条款（保修范围/派人保修/保修通知）——竣工后合同义务，非施组响应域；
 * ④ 投标程序与表单（本表填报说明/投标文件响应程序/拟派承诺/拟分包情况表）——投标文件格式要求；
 * ⑤ 勾选表单行（条款首部带编号前缀的「☑」填报项，如「☑本工程采用商品砼」「1.2 ☑本工程采用商品砼」）
 *    ——工程信息填报非义务条款；行首 8 字符内限编号/括号/顿点类前缀，正文中间出现的 ☑ 不命中。
 *
 * D6 池净化扩围（s28l/r28l 实机归因）：图纸图签栏/清单行列坐标/PDF 目录点串行/OCR 表格残片/编号粘连
 * ——解析产物结构噪声混入要求池后永久无法锚定正文（锚点命中率被人为拉低且误导修复方向），
 * 与参数池同源判定（poolNoise.classifyPoolNoiseText）。命中条目在判定层以 reason='noise' 出池（只出池
 * 不删档：保留在 excluded 审计数组），上层据类别对账。
 */
export function isRequirementPoolNoiseClause(text: string): boolean {
  const normalized = text.trim().replace(/\s+/gu, '');
  if (!normalized) return false;
  if (/(?:回复|答复)[:：]/u.test(normalized)) return true;
  // 4.55.12 巢湖实测：答疑对答残片（「答：三级钢，见图纸说明7.4.1。门卫同。」）此前不在拒绝表内
  //（仅「回复/答复」入表）→ 入池后由条款尾收口（applyRequirementTailClosure）整段搬入正文，
  // 交付物出现 7 处对话残片段。答疑残片是问答对的回答侧，没有招标要求语义，不入池。
  if (/(?:^|[。；;\n])\s*(?:答|答复|回复|答疑|提问|问)\s*[:：]/u.test(normalized)) return true;
  if (/扣\d+(?:\.\d+)?分|总分\d+分|百分制|考核(?:办法|评分|结果|得分|扣分|奖惩)/u.test(normalized)) return true;
  if (/质量保修|保修范围|派人保修|保修通知|保修期如下/u.test(normalized)) return true;
  if (/本表(?:应|须|不|需|作)/u.test(normalized)) return true;
  if (/投标文件(?:应|须|应当)[^。；]{0,40}(?:响应|作出响应|包含|包括)/u.test(normalized)) return true;
  if (/我方拟派|无在岗项目|拟分包项目情况表/u.test(normalized)) return true;
  if (/^[（(、.．\d]{0,8}☑/u.test(normalized)) return true;
  // D6 表格噪声（图签/坐标/目录行/残片/粘连，与参数池同源单源判定）
  if (classifyPoolNoiseText(normalized)) return true;
  return false;
}

/**
 * M26 合同附件来源域判定（要求锚点 27/72 实机归因之根因 A）：来源小节命中合同附件域特征词时，
 * 该条款属合同履约管理范畴（判定 prompt 已声明 out_of_scope，LLM 漏判时本地兜底）。
 * 词表为招标文件固定条款名（GF 通用条款条款名/质量保修书/安全生产合同/管养协议/终身责任承诺书/投标文件格式），
 * 非项目特化——r28k 45 条未满足中 21 条来自该域（质量保修期/保修责任、项目经理质量终身责任制承诺、
 * 安全生产合同·承包人职责、GF 通用条款 1.1.3/1.4/1.6.4/3.1/3.3/4.1/5.4/7.3.1/8.6.1/21.1 等）。
 * section 信号在条款文本被 PDF 切碎时仍可用，与 isContractProcedureClause（文本信号）互补。
 * 「承诺」裸词不入表（「工期/质量承诺」类实质要求会误伤），用「终身责任制承诺」精确形态。
 */
const CONTRACT_ATTACHMENT_SECTION_RE = /(保修|安全生产合同|承包人职责|承包人的一般义务|承包人人员|监理人的一般规定|不合格工程的处理|样品的报送|开工准备|承包人文件|人员及职责|终身责任制承诺|投标文件格式|考核表|督查|管养|养护管理|景观设施维护|地被养护)/u;

export function isContractAttachmentSectionClause(section?: string): boolean {
  const normalized = (section || '').replace(/\s+/gu, '');
  return normalized.length > 0 && CONTRACT_ATTACHMENT_SECTION_RE.test(normalized);
}

/**
 * M26 文件引用型核心词判定（要求锚点实机归因之根因 B2）：文号（〔20XX〕N号）或行政文件名
 * （办法/通知/规定/条例/细则结尾）是「依据引用」——正文按 M20 方向写制度应用，不逐字复现文号/全称；
 * 条款 coreTerms 全为该类词时无正文可锚定内容 → 出池（引用性条款）。词尾限行政文件类，
 * 「规范/标准/制度」为技术/管理词不入（防「工程质量标准」「技术规范」类实质要求误出池）。
 */
function isDocumentReferenceTerm(term: string): boolean {
  const clean = term.replace(/\s+/gu, '');
  if (clean.length < 4) return false;
  return /〔\d{4}〕/u.test(clean) || /(?:办法|通知|规定|条例|细则)$/u.test(clean);
}

/**
 * 标准/图集代号判据（4.58 R4，实测 `doc-1790168542563-ea526b1b`）。
 *
 * ## 缺陷
 *
 * `collectRequirementAnchors` 对 coreTerms 做「含数字复合词分解」
 *（`一次性成活率95%` → `一次性成活率` + `95%`），本意是让正文自然写作时数量词被分隔也能命中。
 * 但该分解作用在**标准/图集代号**上会产出无意义碎片：实测 coreTerm `23S516`
 * 被切成 `23S` + `516` 两个锚点，而正文里写的是完整的 `23S516`——
 * **两个碎片都命中不了**，于是报「招标要求部分响应：…已命中『密闭性试验』，但缺少『23S、516』」。
 *
 * ## 口径
 *
 * 标准/图集代号属**引用型**内容：正文按该标准/图集的做法写、不逐字复现编号是合规的，
 * 故既不作为锚点、也不做复合词分解（见 {@link collectRequirementAnchors} 的调用点）。
 *
 * 与 `isDocumentReferenceTerm` 分开成独立判据（而非并入后者）：后者还承担
 * 「条款 coreTerms 全为引用词时该条款出池」的职责，把代号并进去会连带把
 * 「依据 GB50242 验收」这类实质条款一并出池——波及面远大于本处所需。
 *
 * 形态（两类，标准写法）：
 * - 字母前缀 + 数字：`GB50242`、`JGJ94`、`DB34/T4289`、`CECS`、`ISO9001`；
 * - 图集号：`23S516`、`20S515`、`12J201`、`皖2015S209`（数字年份 + 字母 + 序号）。
 */
function isStandardOrAtlasCode(term: string): boolean {
  const clean = term.replace(/\s+/gu, '').toUpperCase();
  if (clean.length < 4 || clean.length > 24) return false;
  if (!/^[A-Z0-9./-]+$/u.test(clean)) {
    // 带省份简称前缀的图集号（皖2015S209）
    return /^[一-龥]\d{4}[A-Z]{1,2}\d{1,4}$/u.test(clean);
  }
  if (!/[A-Z]/u.test(clean) || !/\d/u.test(clean)) return false;
  // ① 字母段 ≥2 位：GB50242、JGJ94、DB34/T4289、GB/T50378、ISO9001、CECS
  if (/^[A-Z]{2,}/u.test(clean)) return true;
  // ② 尾部数字段 ≥3 位：20S515、23S516、12J201（图集号）
  if (/\d{3,}$/u.test(clean)) return true;
  // ③ 含 / 或 - 分隔：GB/T、JGJ/T 类
  if (/[/-]/u.test(clean)) return true;
  // 单字母 + 短数字（C30、MU10 这类材料强度等级）**不判**——它们是正文该写的实质规格，
  // 排除会白白丢掉一个真锚点；上面前三条已覆盖全部标准/图集代号形态。
  return false;
}

export function isDocumentReferenceOnlyClause(coreTerms: string[] | undefined): boolean {
  const terms = (coreTerms || []).map(term => (term || '').trim()).filter(term => term.length >= 2);
  return terms.length > 0 && terms.every(isDocumentReferenceTerm);
}

/**
 * 逐条判定：分批（40 条/批，并发 3 路）LLM 判定全部条款单元，序号严格对齐（缺号重试一次，
 * 仍缺记入 undecided 显式告警——未判定 >0 即对账未闭合）。
 * 判定后确定性复核：碎片形态（无数字/无约束词的超短残片）→ non_requirement；
 * 无值条款（☑无/值为无）→ no_value；商务纪律/资格条件/评标规则 → out_of_scope；
 * 商务与造价条款（付款/保证金/结算/报价/税金等）→ commercial_scope（词表判定，LLM 漏判时本地纠正，
 * 技术标正文零商务句——商务响应由商务标承接）。
 */
export async function judgeTenderClauses(
  clauses: TenderClauseUnit[],
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<TenderClauseJudgmentResult> {
  const entries: TenderRequirementEntry[] = [];
  const excluded: TenderRequirementExclusion[] = [];
  const undecided: TenderClauseUnit[] = [];
  const structureCollected: TenderStructureRequirement[] = [];
  if (clauses.length === 0) return { entries, excluded, undecided, structureRequirements: [], batchCount: 0, retriedBatches: 0 };
  const batches: TenderClauseUnit[][] = [];
  for (let index = 0; index < clauses.length; index += CLAUSE_BATCH_SIZE) {
    batches.push(clauses.slice(index, index + CLAUSE_BATCH_SIZE));
  }
  const outcomes = await mapWithConcurrency(batches, CLAUSE_BATCH_CONCURRENCY, (batch, batchIndex) => (
    judgeClauseBatch(batch, batchIndex * CLAUSE_BATCH_SIZE, options)
  ));
  let retriedBatches = 0;
  outcomes.forEach((outcome, batchIndex) => {
    if (outcome.retried) retriedBatches += 1;
    batches[batchIndex].forEach((clause, indexInBatch) => {
      const index = batchIndex * CLAUSE_BATCH_SIZE + indexInBatch;
      const judgment = outcome.judgments.get(index);
      // A-T1：结构信号扫描先于一切归宿分支——被排除/未判定条款同样扫描，信号不随排除丢失
      structureCollected.push(...collectClauseStructureRequirements(clause, judgment));
      if (!judgment) {
        undecided.push(clause);
        return;
      }
      if (!judgment.isRequirement || !judgment.inScope) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: normalizeExclusionReason(judgment) });
        return;
      }
      // 确定性复核：碎片形态/无值条款/纯引导词碎片/商务纪律/资格条件/评标规则不进 entries（判定 LLM 漏判时本地纠正）
      if (clauseFragmentLike(clause.text)) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: 'non_requirement' });
        return;
      }
      if (EMPTY_CLAUSE_VALUE_RE.test(clause.text) || clauseSentenceHasNoValue(clause.text)) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: 'no_value' });
        return;
      }
      if (BARE_REPLY_RE.test(clause.text)) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: 'non_requirement' });
        return;
      }
      // A-T3 池纯度：表格声明套话（“我公司对该表内容均属真实”类）不进池参与评分
      if (isTableDeclarationBoilerplate(clause.text)) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: 'non_requirement' });
        return;
      }
      if (isBidDisciplineSentence(clause.text) || isBidderQualificationText(clause.text) || isBidEvaluationRuleText(clause.text) || isContractProcedureClause(clause.text)) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: 'out_of_scope' });
        return;
      }
      // 4.55.14 技术标准入闸（四类非技术内容出池，单源 technicalBidAdmission）：
      // 资格与资信（含评分表资信加分项）/ 招标程序与评标纪律 / 商务与计价 / 合同条件——
      // 都不是技术标（施工组织设计）的响应义务。巢湖实况：旧判据缺锚定词被「业绩证明**材料**」
      // 的「材料」子串骗过，该类条款入池后路由成施工小节（「业绩证明材料中要求提供：（2）中标
      // 查询网址及查询」）并把整章拖到规划块全失败。资信加分项按「限定形态」另册（见
      // isCreditScoringContent：需以承诺/材料清单形态响应，不得编成施工小节）。
      // 商务与计价类不走本闸：交下方 isCommercialScopeClause（其带「技术工艺语义救回」，不得抢道）
      const admissionClass = classifyTenderContent(clause.text);
      if (admissionClass !== 'technical' && admissionClass !== 'commercial') {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: isCreditScoringContent(clause.text) ? 'credit_scoring' : 'out_of_scope' });
        return;
      }
      // M26 合同附件来源域兜底（section 信号；r28k 45 条未满足中 21 条来自该域，文本被 PDF 切碎时 section 仍可识别）：
      // 合同/通用条款/保修/安全生产合同/管养协议域条款属合同履约管理范畴，LLM 漏判时本地纠正
      if (isContractAttachmentSectionClause(clause.section)) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: 'out_of_scope' });
        return;
      }
      // M26 引用性条款兜底：coreTerms 全为文号/行政文件名（依据引用不可锚定），无正文可逐字响应内容 → 出池
      if (isDocumentReferenceOnlyClause(judgment.coreTerms)) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: 'out_of_scope' });
        return;
      }
      // r28h M10 池纯度扩围：答疑澄清/履约考核惩奖/质量保修/投标程序表单/勾选表单行属程序与澄清信息，
      // 非施组响应义务（单项目未响应条目分型实测：该四类形态占未响应 2/3 以上），LLM 漏判时本地纠正
      if (isRequirementPoolNoiseClause(clause.text)) {
        // D6 表格噪声（图签/坐标/目录行/残片）单独记 reason='noise' 供净化审计；其余程序类沿用 non_requirement
        const noiseCategory = classifyPoolNoiseText(clause.text);
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: noiseCategory ? 'noise' : 'non_requirement' });
        return;
      }
      if (isCommercialScopeClause(clause.text)) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: 'commercial_scope' });
        return;
      }
      const policy = normalizePolicy(judgment.policy);
      entries.push({
        text: clause.text,
        coreTerms: cleanCoreTerms(judgment.coreTerms),
        sources: [clauseSourceObject(clause)],
        category: cleanCategory(judgment.category),
        policy,
        global: policy === 'comply' && GLOBAL_COMPLY_RE.test(clause.text) ? true : undefined,
      });
    });
  });
  return { entries, excluded, undecided, structureRequirements: mergeStructureRequirements(structureCollected), batchCount: batches.length, retriedBatches };
}

/** 重复文本合并：归一化（去空白/标点）完全一致的条目合并 sources/coreTerms 不丢来源 */
function mergeDuplicateEntries(entries: TenderRequirementEntry[]): { entries: TenderRequirementEntry[]; mergedCount: number } {
  const byKey = new Map<string, TenderRequirementEntry>();
  let mergedCount = 0;
  for (const entry of entries) {
    const key = entry.text.replace(/[\s，。；、：:．.（）()「」“”"'`·]/gu, '');
    const previous = byKey.get(key);
    if (previous) {
      for (const source of entry.sources) {
        if (!previous.sources.some(existing => existing.file === source.file && existing.location === source.location)) {
          previous.sources.push(source);
        }
      }
      previous.coreTerms = [...new Set([...previous.coreTerms, ...entry.coreTerms])].slice(0, 4);
      mergedCount += 1;
      continue;
    }
    byKey.set(key, entry);
  }
  return { entries: [...byKey.values()], mergedCount };
}

/**
 * 提取编排：条款化 → 逐条判定 → 重复合并 → 对账闭合。条款总数 = entries 覆盖 + excluded + 未判定（必须 0）。
 * 对账未闭合（undecided>0）时 extracted 仍可为 true（部分产出可用），但缓存不落盘并显式告警。
 */
export async function extractTenderRequirements(
  evidence: DocumentEvidence[],
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics; onPhase?: (message: string, details: string[]) => void } = {},
): Promise<TenderRequirementModel> {
  const empty = emptyTenderRequirements(false);
  if (!evidence || evidence.length === 0) return empty;
  const clauses = splitTenderClauses(evidence);
  if (clauses.length === 0) return empty;
  options.onPhase?.(
    `条款化完成：${clauses.length} 条单元（全文穷举切分，不预筛不剔除）`,
    [`来源文件：${[...new Set(clauses.map(clause => clause.file).filter(Boolean))].join('、') || '—'}`, '逐条判定进行中（每批 40 条，序号严格对齐）'],
  );
  const judged = await judgeTenderClauses(clauses, { signal: options.signal, diagnostics: options.diagnostics });
  const merged = mergeDuplicateEntries(judged.entries);
  options.onPhase?.(
    `逐条判定完成：要求 ${merged.entries.length} + 排除 ${judged.excluded.length}${merged.mergedCount > 0 ? ` + 合并 ${merged.mergedCount}` : ''} + 未判定 ${judged.undecided.length}${judged.structureRequirements.length > 0 ? `；结构/呈现要求 ${judged.structureRequirements.length}` : ''}`,
    judged.undecided.length === 0
      ? ['对账闭合：全部条款已判定']
      : [`未判定 ${judged.undecided.length} 条（LLM 输出缺号且重试后仍缺），对账未闭合，缓存不落盘`],
  );
  const extracted = judged.entries.length > 0 || judged.excluded.length > 0;
  return {
    entries: merged.entries,
    excluded: judged.excluded,
    structureRequirements: judged.structureRequirements,
    reconciliation: {
      clauseCount: clauses.length,
      entryCount: merged.entries.length,
      excludedCount: judged.excluded.length,
      undecidedCount: judged.undecided.length,
      mergedCount: merged.mergedCount,
      batchCount: judged.batchCount,
      retriedBatches: judged.retriedBatches,
      structureCount: judged.structureRequirements.length,
    },
    extracted,
    sourceHash: tenderRequirementsSourceHash(evidence.map(item => `${item.filePath || ''}|${item.sectionTitle || ''}|${item.content || ''}`).join('\n')),
  };
}

// ═══════════════════════════════ L1 提取缓存（v4：对账闭合门禁） ═══════════════════════════════

/**
 * 提取结果磁盘缓存：同一项目资料未变化时跳过判定 LLM。门禁=对账闭合（非旧「必提字段齐全」）——
 * 无要求项目（entries=0 但全部条款 excluded）同样对账闭合，缓存可命中（旧门禁在此场景永不命中）。
 * 哈希失效：key = 提取器版本 + 招标文件直读集合全量指纹；判定 prompt / 复核口径变更时递增版本。
 * v7：合同履约管理程序条款口径（报送审批/违约罚则/请假离场/投保程序/保修书明细/照管起止/治安保卫/
 * 分包审批/采购评标 → out_of_scope，r3 实机大量该类条目被误判 respond 致验收零命中）+ coreTerms 可命中性口径。
 * v8（A-T1/A-T2/A-T3）：结构/呈现要求第三态通道（structures 字段 + 词表扫描，含被排除条款）+
 * 表格声明套话不进池 + 商务域技术工艺语义救回——判定口径变更，旧池全部失效重算。
 * v9（M14 根因修复）：池纯度复核扩围（答疑澄清/考核惩奖/质量保修/投标表单/勾选行 + 合同程序
 * 条款格式扩围）——M10 落码时漏递增本版本号，r28i/s28i 命中 v8 旧缓存「复用上次提取结果……
 * 跳过判定 LLM」（executionStages 实锤），出池判据从未执行致「M10 折算未兑现」。本版起缓存 key
 * 追加密判据指纹（CACHE_JUDGE_FINGERPRINT_SOURCES）：判据函数/正则源码变更自动失效缓存，
 * 新增判据须同步入表（守护测试扫描 judgeTenderClauses 调用清单比对，漏加即红）。
 */
const TENDER_REQUIREMENTS_CACHE_VERSION = 'tender-requirements-extraction-v9';

// 商务域条款排除词表（4.40.0 零商务句根治，取代旧「定性响应句」通道）：丰乐镇与舒城实测均出现
// 商务条款原文/商务声明句被写入技术标正文——商务与造价条款（金额/利率/时限/计价规则）在判定层
// 即排除出要求池，技术标正文既不定性声明也不落商务参数，响应由商务标承接。
// M26 增补：市场询价/报价计入/中标价/赔偿（价格水平与费用责任语汇，s28k 实机漏网；「移交/扣除」
// 类宽词不入表——「工程竣工移交期间」「工期扣除法定节假日」可属技术内容，防误伤）。
// 词表与救回词表必须定义于 CACHE_JUDGE_FINGERPRINT_SOURCES 之前：指纹表在模块加载时对源序列化。
const COMMERCIAL_SCOPE_RE = /履约保证金|质量保证金|保证金账户|中标金额|中标价|进度款|工程款|付款|结清|结算|违约金|贷款市场报价利率|LPR|最高投标限价|工程结算价款|预付款|支付担保|保函|暂列金额|暂估价|结算核减|造价咨询费|工程量.*异议|增值税|异地纳税人|报价明细|综合单价|清单合价|预留金|投标报价|异常低价|评标基准价|总价包干|总价合同|调差|可调整价差|市场询价|报价计入|赔偿/u;

/** 技术工艺语义救回词表（A-T3 边缘误排复核）：命中商务词但同时含技术工艺/现场处置语义的条款
 * 不判商务域（技术动词优先）——现场工艺试验、临时占地恢复类条款属技术响应内容，历史缺陷：
 * 因命中「费用/占地」词被整条判 commercial_scope，技术内容随排除丢失。 */
const COMMERCIAL_TECHNICAL_RESCUE_RE = /工艺试验|工艺评定|试验段|复垦|土地复垦|表土剥离|耕作层|占地恢复|场地恢复|植被恢复|绿化恢复|清表|清杂|移植|取土场|弃土场|临时占地|临时用地/u;

/** M14a 判定口径指纹源（v9 起入缓存 key）：judgeTenderClauses 中参与「进池/排除/结构收集」的
 * 本地确定性判据（函数序列化为源码文本、正则序列化为 pattern/flags）——口径任何变更自动失效缓存，
 * 不再依赖人工递增版本纪律（M10 漏递增实锤）。
 * M26 增补：合同附件来源域判据（isContractAttachmentSectionClause）+ 引用性条款判据
 * （isDocumentReferenceTerm/isDocumentReferenceOnlyClause）+ 商务域两个词表常量
 * （外部 const 词表不影响函数源码序列化，必须直接入表方能触发缓存失效）。
 * v10 补漏：入表判据**函数体内引用**的词表/规则表同样必须直接入表——函数只序列化自身源码，
 * 表内容变更不进指纹（本类漏网实证：isTableDeclarationBoilerplate 的
 * TABLE_DECLARATION_BOILERPLATE_RE、isContractAttachmentSectionClause 的
 * CONTRACT_ATTACHMENT_SECTION_RE、collectClauseStructureRequirements → detectStructureRequirements
 * 的 STRUCTURE_FORM_RULES 三张表编辑后缓存不失效）。源序列化同步收紧：对象/表常量不再退化为
 * '[object Object]'（见 tenderRequirementsFingerprintSourceText）。 */
const CACHE_JUDGE_FINGERPRINT_SOURCES: ReadonlyArray<unknown> = [
  clauseFragmentLike,
  // 4.55.14 技术标准入闸（池纯度判据）：分类器函数入表，口径变更自动失效缓存
  classifyTenderContent,
  isCreditScoringContent,
  EMPTY_CLAUSE_VALUE_RE,
  clauseSentenceHasNoValue,
  BARE_REPLY_RE,
  isTableDeclarationBoilerplate,
  isBidDisciplineSentence,
  isBidderQualificationText,
  isBidEvaluationRuleText,
  isContractProcedureClause,
  isContractAttachmentSectionClause,
  isDocumentReferenceOnlyClause,
  isDocumentReferenceTerm,
  isRequirementPoolNoiseClause,
  // D6 池噪声（表格噪声形态：图签/坐标/目录行/残片/粘连）——判据函数 + 形态正则表 + 约束词守卫
  classifyPoolNoiseText,
  POOL_NOISE_RULE_SOURCES,
  POOL_CONSTRAINT_WORD_RE,
  isCommercialScopeClause,
  COMMERCIAL_SCOPE_RE,
  COMMERCIAL_TECHNICAL_RESCUE_RE,
  normalizeExclusionReason,
  GLOBAL_COMPLY_RE,
  collectClauseStructureRequirements,
  // v10：入表判据函数体内引用的外部词表/规则表（函数源码序列化不含外部 const 内容）
  STRUCTURE_FORM_RULES,
  TABLE_DECLARATION_BOILERPLATE_RE,
  CONTRACT_ATTACHMENT_SECTION_RE,
];

/** 判据源序列化（单点）：函数取源码文本、正则取 pattern/flags、表/常量对象递归序列化（函数项取
 * 源码、正则项取字面量）——直接 String() 对对象表恒得 '[object Object]'，词表内容变更不进指纹，
 * 入表等于没入（v10 前的结构性盲区）。 */
function tenderRequirementsFingerprintSourceText(source: unknown): string {
  if (typeof source === 'function' || source instanceof RegExp) return String(source);
  if (source && typeof source === 'object') {
    return JSON.stringify(source, (_key, value: unknown) => (typeof value === 'function' || value instanceof RegExp ? String(value) : value)) ?? String(source);
  }
  return String(source);
}

/** 判定口径指纹（导出供测试）：判据源序列化文本的稳定哈希——判据代码任何变更 → 缓存 key 变化 */
export function tenderRequirementsJudgeFingerprint(sources: ReadonlyArray<unknown> = CACHE_JUDGE_FINGERPRINT_SOURCES): string {
  return stableHash(sources.map(tenderRequirementsFingerprintSourceText).join('\n'));
}

function tenderRequirementsCacheRoot(projectRoot?: string) {
  const root = path.join(process.env.HOME || process.cwd(), '.customize-agent', 'cache', 'document-workflow', stableHash(projectRoot || 'default'));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 证据集合指纹：全内容哈希（非 head/tail 抽样）——专业文档条件/证据/数据必须精准，抽样哈希存在漏判变更风险 */
function evidenceContentFingerprint(evidence: DocumentEvidence[]) {
  return evidence
    .map(item => ({ filePath: item.filePath || '', sectionTitle: item.sectionTitle || '', contentHash: stableHash(item.content || '') }))
    .sort((a, b) => `${a.filePath}|${a.sectionTitle}`.localeCompare(`${b.filePath}|${b.sectionTitle}`));
}

/** 提取缓存 key：提取器版本 + 判定口径指纹（M14a 自动防线）+ 招标文件直读集合指纹 */
export function tenderRequirementsCacheKey(input: { collectionEvidence: DocumentEvidence[] }) {
  return stableHash({
    version: TENDER_REQUIREMENTS_CACHE_VERSION,
    judgeFingerprint: tenderRequirementsJudgeFingerprint(),
    collection: evidenceContentFingerprint(input.collectionEvidence),
  });
}

/** 对账闭合判定：条款总数 = entries + excluded + 重复合并 + 未判定 0（结构校验 + 计数校验双保险） */
function reconciliationClosed(model: TenderRequirementModel | undefined): boolean {
  if (!model || !Array.isArray(model.entries) || !Array.isArray(model.excluded) || !model.reconciliation) return false;
  const r = model.reconciliation;
  if (typeof r.clauseCount !== 'number' || typeof r.entryCount !== 'number' || typeof r.excludedCount !== 'number'
    || typeof r.mergedCount !== 'number' || typeof r.undecidedCount !== 'number') return false;
  if (r.undecidedCount !== 0) return false;
  return r.clauseCount === r.entryCount + r.excludedCount + r.mergedCount;
}

/** 读缓存（门禁：对账闭合 + 非空产出；结构损坏/未闭合缓存一律不采用） */
export function readCachedTenderRequirements(projectRoot: string | undefined, key: string): TenderRequirementModel | undefined {
  try {
    const file = path.join(tenderRequirementsCacheRoot(projectRoot), `tender-requirements-${key}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TenderRequirementModel;
    if (!parsed?.extracted || !reconciliationClosed(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 写缓存（门禁：对账闭合；未闭合结果不落盘——坏数据永不固化；写失败静默降级为无缓存路径） */
export function writeCachedTenderRequirements(projectRoot: string | undefined, key: string, model: TenderRequirementModel | undefined) {
  if (!model?.extracted || !reconciliationClosed(model)) return;
  try {
    fs.writeFileSync(path.join(tenderRequirementsCacheRoot(projectRoot), `tender-requirements-${key}.json`), JSON.stringify(model, null, 2));
  } catch {
    // 缓存写失败不影响生成
  }
}

// ═══════════════════════════════ 消费侧：摘要 / 展平 / 查询 / 写作口径 ═══════════════════════════════

/** 要求模型摘要（进度展示/诊断用，全量不截断）：对账行 + 类别分组全量条目 + 未判定告警 */
export function tenderRequirementsSummary(model: TenderRequirementModel | undefined): string[] {
  if (!model) return [];
  const summary: string[] = [];
  const r = model.reconciliation;
  if (model.extracted) {
    const terms = [`要求 ${r.entryCount}`, `排除 ${r.excludedCount}`];
    if (r.mergedCount > 0) terms.push(`合并 ${r.mergedCount}（来源已聚合）`);
    terms.push(`未判定 ${r.undecidedCount}`);
    summary.push(`条款对账：切分 ${r.clauseCount} = ${terms.join(' + ')}${r.undecidedCount === 0 ? '（闭合）' : '（未闭合）'}`);
  }
  const grouped = new Map<string, string[]>();
  for (const entry of model.entries) {
    const list = grouped.get(entry.category) || [];
    list.push(entry.text);
    grouped.set(entry.category, list);
  }
  for (const [category, texts] of grouped) {
    summary.push(`${category} ${texts.length} 条：${texts.join('、')}`);
  }
  // 商务域排除可见性（实机验收指标：技术标正文零商务句，响应由商务标承接）
  const commercialScopeCount = model.excluded.filter(item => item.reason === 'commercial_scope').length;
  if (commercialScopeCount > 0) {
    summary.push(`商务域排除 ${commercialScopeCount} 条（付款/保证金/结算/报价/税金等，技术标正文零商务句）`);
  }
  // 4.55.14 技术标准入闸可见性：四类非技术内容（资格与资信/招标程序与评标纪律/商务与计价/合同条件）
  // 单列可见——用户口径「招标文件里不是我们都要写」需要可审计：资信加分项（业绩/获奖/认证）单独
  // 提示须按招标要求以**承诺句/证明材料清单**形态另行处理，不得编成施工小节，暗标一律剔除。
  const creditScoringCount = model.excluded.filter(item => item.reason === 'credit_scoring').length;
  const outOfScopeCount = model.excluded.filter(item => item.reason === 'out_of_scope').length;
  if (outOfScopeCount > 0 || creditScoringCount > 0) {
    summary.push(`技术标准入闸排除 ${outOfScopeCount + creditScoringCount} 条（投标人资格与资信/招标程序与评标纪律/合同条件——非施工组织设计响应义务，响应由资格文件或商务标承接）`);
  }
  if (creditScoringCount > 0) {
    summary.push(`其中资信加分项 ${creditScoringCount} 条（业绩/获奖/认证类）：按招标要求以承诺句或证明材料清单形态另行处理，不得编成施工小节${'；暗标项目一律剔除'}`);
  }
  // A-T1 结构/呈现要求可见性（第三态通道：含被排除格式类条款的呈现信号）
  const structureRequirements = model.structureRequirements || [];
  if (structureRequirements.length > 0) {
    const formLabels: Record<TenderStructureForm, string> = { diagram: '图', org_chart: '框图', table: '表格', chart_text: '结合图表' };
    summary.push(`结构/呈现要求 ${structureRequirements.length} 项：${structureRequirements.map(item => `${item.element}（以${formLabels[item.form]}呈现）`).join('、')}`);
  }
  if (r.undecidedCount > 0) {
    summary.push(`未判定条款 ${r.undecidedCount} 条：对账未闭合（LLM 输出缺号且重试后仍缺），请检查 LLM 可用性`);
  }
  if (!model.extracted) {
    summary.push('招标要求未提取（无绑定资料或模型不可用），验收自动跳过');
  }
  return summary;
}

/** 有要求条目（大纲校准等消费侧开关）：extracted 且 entries 非空 */
export function hasTenderRequirements(model: TenderRequirementModel | undefined): boolean {
  return Boolean(model?.extracted && model.entries.length > 0);
}

/** 验收/修复展平：全部实质要求条目（kind 取类别名） */
export function tenderRequirementCheckItems(model: TenderRequirementModel | undefined): Array<{ kind: string; item: TenderRequirementEntry }> {
  if (!model) return [];
  return model.entries.map(entry => ({ kind: entry.category, item: entry }));
}

/**
 * 语义比对查询文本（单一来源）：核心词拼接优先，无核心词退回条款原文。
 * 语义相似度闭包缓存以文本字符串为 key，口径不一致会静默 cache miss 恒 0，导致「正文已响应仍报零命中」。
 */
export function tenderRequirementSemanticQuery(item: { text: string; coreTerms: string[] }): string {
  return item.coreTerms.length > 0 ? item.coreTerms.join(' ') : item.text;
}

/**
 * 全局写作口径红线：注入 projectContext 的轻量规则（零具体条目——条目由蓝图分配后按章分片注入）。
 * 内容 = ① 全文档性遵守条目原文（global，如「以开工令为准」）；② 写作行为红线（原文一致性/禁止替换降级）。
 */
export function tenderRequirementsWritingRules(model: TenderRequirementModel | undefined): string {
  if (!model?.extracted) return '';
  const lines: string[] = [];
  for (const entry of model.entries) {
    if (!entry.global) continue;
    lines.push(`全局遵守：${entry.text}（全文任何章节不得违反，禁止自行设定该类数据）`);
  }
  lines.push('本章分配到的招标要求（见「本章必须处理的招标要求」清单）必须逐条处理：显性响应类须写入正文并配套保证措施；遵守类须全文一致遵守。奖项名称、等级指标、数字参数必须与招标文件原文逐字一致，禁止替换、降级或省略。商务域条款（付款/保证金/结算等）不在技术标响应范围——正文不得出现任何商务内容。');
  return `【招标要求全局口径红线（全文档适用）】\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}\n${systemConstraintLine('以上为系统提取的招标要求全局口径：本段提示词文字本身（编号、括号说明等元话语）禁止复述进正文')}`;
}

/** 本章要求分片渲染（写作注入用）：蓝图分配的本章责任要求全量（不截断），按 policy 标注处理方式。
 * 显性响应类附锚点全清单（collectRequirementAnchors 单源，与验收/修复缺口反馈同口径）：
 * 写作时即按锚点逐字落位（生成侧治本），消除「写作漏锚点 → 检测报缺口 → 修复轮补写」的多数回路。 */
export function renderChapterRequirementSlice(entries: TenderRequirementEntry[]): string {
  if (entries.length === 0) return '';
  const policyLabel: Record<TenderRequirementPolicy, string> = {
    respond: '显性响应',
    comply: '全文遵守',
  };
  const lines = entries.map(entry => {
    const source = entry.sources.find(item => item.file)?.file;
    // 锚点全清单仅对显性响应类附（遵守类不做文本落位验收）；行首缩进标注「必须逐字落位」受系统约束元话语红线保护
    const anchors = entry.policy === 'respond' ? collectRequirementAnchors(entry) : [];
    const anchorLine = anchors.length > 0 ? `\n  └ 必须逐字落位：${anchors.join('、')}` : '';
    return `- [${policyLabel[entry.policy]}] ${entry.text}${source ? `（来源：${source}）` : ''}${anchorLine}`;
  });
  return [
    '【本章必须处理的招标要求（蓝图分配全量，逐条响应/遵守；零处理即评标失分）】',
    ...lines,
    systemConstraintLine('以上为系统提取的招标要求原文：实质内容（奖项名称/等级指标/数字参数）必须显性落位；「必须逐字落位」为系统验收锚点清单，其文字禁止复述进正文；本段提示词文字本身（编号、括号说明等元话语）禁止复述进正文'),
  ].join('\n');
}

/** A-T1 结构/呈现要求分片渲染（章级写作指令）：明标=以图/表形态呈现 ××；
 * 正文禁表口径（bodyTableForbidden，显式禁表句）=正文不得出表格/图片实体，以完整文字承载并指向文末附表区；
 * 禁图允许表口径（bodyFigureForbidden，暗标常态 C1）=表格/框图照常落实，图类以文字框图/表格式时间轴承载+图题行，禁止图片。
 * B-T1：图/框图（diagram）补齐形态声明——内容以文字框图/时间轴承载，结束处输出规范图题行「图 X-X 图名」；
 * B-T2：org_chart 补「项目管理机构与岗位职责」专项指令（组织架构说明 + 框图承载 + 岗位责任矩阵，零实名数据）。 */
export function renderChapterStructureSlice(items: TenderStructureRequirement[], options: { bodyTableForbidden?: boolean; bodyFigureForbidden?: boolean } = {}): string {
  if (items.length === 0) return '';
  const formLabels: Record<TenderStructureForm, string> = {
    diagram: '图（网络图/横道图/平面布置图类）',
    org_chart: '框图',
    table: '表格',
    chart_text: '文字结合图表',
  };
  const orgChartPlainHint = '：正文须含「项目管理机构与岗位职责」专项内容——组织架构说明（层级设置、隶属关系、部门与岗位构成）+ 文字框图承载（列出全部岗位与层级关系）+ 岗位责任矩阵（各岗位职责、分工与协作关系）；严禁出现人员姓名、证书编号、身份证号等实名数据（人员实名信息属商务册职责，正文仅写岗位与职责体系）';
  const orgChartTextOnlyHint = '：正文须含「项目管理机构与岗位职责」专项内容——组织架构说明（层级设置、隶属关系、部门与岗位构成）及分岗位的职责分工与协作关系；严禁出现人员姓名、证书编号、身份证号等实名数据（人员实名信息属商务册职责，正文仅写岗位与职责体系）';
  const plainHint = (form: TenderStructureForm): string => {
    if (form === 'diagram') return '：必须以 Markdown 数据表（表头字段 + 数据行，数据取自资料，禁止编造）或等价的结构化文字框图/表格式时间轴承载全部内容要点（≥3 行要点），内容结束处另起一行输出规范图题行（格式「图 X-X 图名」，X-X 为章序号与本章图序号，图名即要素名），图题行独立成行、不附加任何说明文字；**只输出图题行而无数据表/框图内容视为该项未落实**';
    if (form === 'org_chart') return orgChartPlainHint;
    if (form === 'table') return '：以 Markdown 表格输出，表头字段按要素构成设置并覆盖全部构成项';
    return '';
  };
  if (options.bodyTableForbidden) {
    return [
      '【本章必须落实的呈现要求（招标明文规定呈现形态，正文禁表口径）】',
      ...items.map(item => `- 招标要求以「${formLabels[item.form]}」呈现「${item.element}」：招标正文禁表（显式禁表句），不得出现任何表格/图片，须以完整文字描述${item.element}的组成与运作（图文形态由文末附表区承载，正文可自然指向附表）${item.form === 'org_chart' ? orgChartTextOnlyHint : ''}`),
      systemConstraintLine('以上为招标明文的呈现形态要求：正文以文字完整承载内容，禁止任何图表实体与内部话术（如“由编制人绘制”）'),
    ].join('\n');
  }
  return [
    '【本章必须落实的呈现要求（招标明文规定呈现形态，缺失即评标失分）】',
    ...items.map(item => `- 须以「${formLabels[item.form]}」呈现「${item.element}」（呈现形态与要素均来自招标明文，不得省略）${plainHint(item.form)}`),
    options.bodyFigureForbidden
      ? systemConstraintLine('以上为招标明文的呈现形态要求：对应表格/框图必须在本章正文落实（内容使用资料事实，禁止编造）；招标要求正文不得出现图片，图类以文字框图/表格式时间轴与图题行承载，禁止插入图片或图件占位')
      : systemConstraintLine('以上为招标明文的呈现形态要求：对应图/表/框图必须在本章正文落实，内容使用资料事实，禁止编造'),
  ].join('\n');
}

// ═══════════════════════════════ L2 蓝图分配（每条要求唯一主责章） ═══════════════════════════════

/** 要求↔章节分配：每条 entry 有唯一主责章（低置信分配仍交主责章处理，标记供审计） */
export interface TenderRequirementAssignment {
  entry: TenderRequirementEntry;
  /** 目标章节标题（normalizeChapterTitleLine 归一化口径） */
  chapterTitle: string;
  score: number;
  /** 低于 ROUTE_SCORE_MIN 的低置信分配（语义不贴近任何章节，仍分配主责章——未分配恒为 0） */
  lowConfidence: boolean;
}

/** 路由相似度下限：低于该值标记低置信（仍分配主责章；argmax 兜底保证未分配=0）。
 * **与 `STRUCTURE_ROUTE_SCORE_MIN`（0.35）语义不同，数值不得统一**：本线 0.45 是「标记」
 * （flag）——低置信要求照常挂主责章、照常注入写作、照常参与验收，仅多一个 lowConfidence 标记供审计；
 * 结构线 0.35 是「丢弃」（drop）——低于线即不挂章、不注入写作、不参与验收（宁缺不误挂）。
 * 后果一个是标记一个是丢弃，故两条线各自取值（源文件里数值相近纯属巧合，不是同一概念的副本）。 */
const ROUTE_SCORE_MIN = 0.45;

/**
 * 蓝图要求分配：每条要求语义路由到最相似章节（argmax 兜底——相似度全零退回第一章）。
 * 未分配恒为 0（结构性保证）：所有条目必须有唯一主责章，章级验收才有核验对象。
 * 程序性/资格/评标规则条款已被判定层排除（excluded），不进入分配。
 */
export function assignTenderRequirementsToChapters(
  entries: TenderRequirementEntry[],
  chapters: Array<{ title: string }>,
  similarity: SemanticSimilarityFn,
): { assignments: TenderRequirementAssignment[]; lowConfidenceCount: number } {
  const assignments: TenderRequirementAssignment[] = [];
  if (entries.length === 0 || chapters.length === 0) return { assignments, lowConfidenceCount: 0 };
  const chapterTitles = chapters.map(chapter => normalizeChapterTitleLine(chapter.title)).filter(Boolean);
  if (chapterTitles.length === 0) return { assignments, lowConfidenceCount: 0 };
  let lowConfidenceCount = 0;
  for (const entry of entries) {
    const query = tenderRequirementSemanticQuery(entry);
    let bestTitle = '';
    let bestScore = 0;
    for (const title of chapterTitles) {
      const score = similarity(query, title);
      if (score > bestScore) {
        bestScore = score;
        bestTitle = title;
      }
    }
    if (!bestTitle) bestTitle = chapterTitles[0];
    const lowConfidence = bestScore < ROUTE_SCORE_MIN;
    if (lowConfidence) lowConfidenceCount += 1;
    assignments.push({ entry, chapterTitle: bestTitle, score: bestScore, lowConfidence });
  }
  return { assignments, lowConfidenceCount };
}

/** 低置信路由裁决批大小（与判定批同规格：批内序号对齐可靠） */
const ROUTE_DECISION_BATCH_SIZE = 40;

const ROUTE_DECISION_JSON_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      required: true,
      minItems: 1,
      items: {
        type: 'object',
        required: true,
        properties: {
          index: { type: 'number', required: true },
          chapter: { type: 'string', required: true, maxLength: 60 },
        },
      },
    },
  },
};

const ROUTE_DECISION_PROMPT = [
  docSystemPrefix('你是招标要求章责分配器。'),
  '输入是语义路由置信度偏低的技术标要求条目与本文档全部章节标题列表。',
  '为每条要求裁决其唯一主责章节（写该章节正文时必须响应此要求），逐条必出结果（不得遗漏序号）。',
  '',
  '- chapter：从章节标题列表中选择内容最匹配的一项，必须与列表原文逐字一致',
  '- chapter 填 "none"：该条不是可写入技术标正文的实质要求（无问题上下文的残片/客套答复/程序性说明），或没有任何章节能承载其内容',
  '',
  '输出 JSON：{ "results": [ { "index": 0, "chapter": "章节标题或none" } ] }，只返回 JSON。',
].join('\n');

export interface TenderRequirementRoutingResult {
  assignments: TenderRequirementAssignment[];
  /** LLM 明确拒选（none）的条目：任何章节均无法承载 → 移出要求池（excluded 审计） */
  dropped: TenderRequirementEntry[];
  /** 精化后仍为低置信的分配数（LLM 不可用/缺号/无效章节名时保留 argmax 分配） */
  lowConfidenceCount: number;
}

/** 单批低置信路由裁决：返回「批内序号 → 章节标题/none」映射（序号对齐，缺号由调用侧保留原分配） */
async function decideRouteBatch(
  batch: TenderRequirementAssignment[],
  chapterTitles: string[],
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<Map<number, string>> {
  const prompt = [
    `章节标题列表：\n${chapterTitles.map((title, index) => `${index + 1}. ${title}`).join('\n')}`,
    '',
    batch.map((assignment, index) => `【要求 ${index}】${assignment.entry.text}`).join('\n\n'),
  ].join('\n');
  const raw = await callDocumentLlmJson<{ results?: Array<{ index?: number; chapter?: string }> }>(
    ROUTE_DECISION_PROMPT,
    prompt,
    {
      maxTokens: 4000,
      temperature: 0,
      signal: options.signal,
      diagnostics: options.diagnostics,
      schema: ROUTE_DECISION_JSON_SCHEMA,
      taskKind: 'structuredGeneration',
    },
  );
  const decided = new Map<number, string>();
  for (const item of raw?.results || []) {
    if (typeof item.index !== 'number' || !Number.isInteger(item.index) || item.index < 0 || item.index >= batch.length) continue;
    if (typeof item.chapter !== 'string') continue;
    const chapter = item.chapter.trim();
    if (chapter) decided.set(item.index, chapter);
  }
  return decided;
}

/**
 * 低置信路由精化（4.40.0 碎片/答疑治理根治）：语义 argmax 相似度低于 ROUTE_SCORE_MIN 的条目
 * 批量交 LLM 按实际章节列表裁决唯一主责章——语义相似度对碎片/问答类条目不可靠，LLM 依据章节语义裁决；
 * LLM 明确拒选（none）即任何章节均无法承载，条目移出要求池（excluded，reason="non_requirement"）。
 * LLM 不可用/输出缺号/章节名无效时保留原 argmax 低置信分配（宁保留不丢数据，不阻断生成）。
 */
export async function routeTenderRequirementsToChapters(
  entries: TenderRequirementEntry[],
  chapters: Array<{ title: string }>,
  similarity: SemanticSimilarityFn,
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<TenderRequirementRoutingResult> {
  const rough = assignTenderRequirementsToChapters(entries, chapters, similarity);
  const chapterTitles = chapters.map(chapter => normalizeChapterTitleLine(chapter.title)).filter(Boolean);
  const lowIndexes = rough.assignments.map((assignment, index) => (assignment.lowConfidence ? index : -1)).filter(index => index >= 0);
  if (lowIndexes.length === 0 || chapterTitles.length === 0 || options.signal?.aborted) {
    return { assignments: rough.assignments, dropped: [], lowConfidenceCount: rough.lowConfidenceCount };
  }
  const batches: number[][] = [];
  for (let index = 0; index < lowIndexes.length; index += ROUTE_DECISION_BATCH_SIZE) {
    batches.push(lowIndexes.slice(index, index + ROUTE_DECISION_BATCH_SIZE));
  }
  const outcomes = await mapWithConcurrency(batches, CLAUSE_BATCH_CONCURRENCY, batch => (
    decideRouteBatch(batch.map(index => rough.assignments[index]), chapterTitles, options)
  ));
  const decisions = new Map<number, string>();
  outcomes.forEach((outcome, batchIndex) => {
    for (const [indexInBatch, chapter] of outcome) {
      const assignmentIndex = batches[batchIndex][indexInBatch];
      if (assignmentIndex !== undefined) decisions.set(assignmentIndex, chapter);
    }
  });
  const titleSet = new Set(chapterTitles);
  const assignments: TenderRequirementAssignment[] = [];
  const dropped: TenderRequirementEntry[] = [];
  let lowConfidenceCount = 0;
  rough.assignments.forEach((assignment, index) => {
    if (!assignment.lowConfidence) {
      assignments.push(assignment);
      return;
    }
    const decision = decisions.get(index);
    if (!decision) {
      // LLM 缺号/未裁决：保留 argmax 低置信分配（不丢条目）
      assignments.push(assignment);
      lowConfidenceCount += 1;
      return;
    }
    if (/^(?:none|无)$/iu.test(decision)) {
      dropped.push(assignment.entry);
      return;
    }
    if (titleSet.has(decision)) {
      assignments.push({ ...assignment, chapterTitle: decision, lowConfidence: false });
      return;
    }
    // 章节名不在候选列表（幻觉输出）：保留 argmax 低置信分配
    assignments.push(assignment);
    lowConfidenceCount += 1;
  });
  return { assignments, dropped, lowConfidenceCount };
}

/** 分配落盘（审计资产 generatedDocuments/assets/requirement-assignments.json，与 blueprint.json 同目录） */
export function saveRequirementAssignmentsAsset(projectRoot: string, assignments: TenderRequirementAssignment[]): string {
  const assetDir = path.join(generatedRoot(projectRoot), 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const assetPath = path.join(assetDir, 'requirement-assignments.json');
  fs.writeFileSync(assetPath, JSON.stringify({ createdAt: new Date().toISOString(), total: assignments.length, assignments }, null, 2), 'utf8');
  return assetPath;
}

// ── A-T1 结构/呈现要求章归属（存疑不挂、显性展示） ──

/** 结构要求↔章节归属条目 */
export interface TenderStructureAssignment {
  requirement: TenderStructureRequirement;
  /** 目标章节标题（normalizeChapterTitleLine 归一化口径） */
  chapterTitle: string;
  score: number;
  /** 低于 STRUCTURE_ROUTE_SCORE_MIN 的存疑项：不挂章、仅显性展示（不注入写作，不参与验收） */
  lowConfidence: boolean;
}

/** 结构路由相似度下限：低于该值的要素不挂章（语义不贴近任何章节，宁缺不误挂）。
 * **与 `ROUTE_SCORE_MIN`（0.45）语义不同，数值不得统一**：本线是「丢弃」（drop，存疑不挂章——
 * 不注入写作、不参与验收），要求线是「标记」（flag，低置信仍挂主责章并照常注入/验收）。
 * 判定后果不同故取值不同；详见同文件 `ROUTE_SCORE_MIN` 处的对照说明。 */
export const STRUCTURE_ROUTE_SCORE_MIN = 0.35;

/**
 * 结构要求语义查询文本（单一来源）：相似度闭包对未预嵌入文本静默返回 0，构建 requirementsSimilarity
 * 预嵌入池与路由查询必须共用本函数同文本（口径不一致将导致全部结构要求判定 0 分、路由空转）。
 */
export function structureRequirementSemanticQuery(requirement: TenderStructureRequirement): string {
  return `${requirement.element} ${requirement.sourceText}`.slice(0, 120);
}

/**
 * 结构/呈现要求章归属：element+形态语义路由到最相似章节（存疑不挂——低于下限不注入，
 * 显性进入 unattached 展示；宁可不挂也不挂错）。归入章后由写作注入与终稿验收消费。
 */
export function assignStructureRequirementsToChapters(
  requirements: TenderStructureRequirement[],
  chapters: Array<{ title: string }>,
  similarity: SemanticSimilarityFn,
): { assignments: TenderStructureAssignment[]; unattached: TenderStructureAssignment[] } {
  const assignments: TenderStructureAssignment[] = [];
  const unattached: TenderStructureAssignment[] = [];
  const chapterTitles = chapters.map(chapter => normalizeChapterTitleLine(chapter.title)).filter(Boolean);
  for (const requirement of requirements) {
    // 查询文本以要素名为语义主键（形态词辅助：图/框图/表格语义弱，不喧宾夺主）
    const query = structureRequirementSemanticQuery(requirement);
    let bestTitle = '';
    let bestScore = 0;
    for (const title of chapterTitles) {
      const score = similarity(query, title);
      if (score > bestScore) {
        bestScore = score;
        bestTitle = title;
      }
    }
    const entry: TenderStructureAssignment = { requirement, chapterTitle: bestTitle, score: bestScore, lowConfidence: bestScore < STRUCTURE_ROUTE_SCORE_MIN };
    if (!bestTitle || entry.lowConfidence) {
      unattached.push(entry);
      continue;
    }
    assignments.push(entry);
  }
  return { assignments, unattached };
}

/** 结构分配落盘（审计资产：generatedDocuments/assets/structure-assignments.json） */
export function saveStructureAssignmentsAsset(projectRoot: string, assignments: TenderStructureAssignment[], unattached: TenderStructureAssignment[]): string {
  const assetDir = path.join(generatedRoot(projectRoot), 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const assetPath = path.join(assetDir, 'structure-assignments.json');
  fs.writeFileSync(assetPath, JSON.stringify({ createdAt: new Date().toISOString(), attached: assignments.length, unattached: unattached.length, assignments, unattachedItems: unattached }, null, 2), 'utf8');
  return assetPath;
}

// ═══════════════════════════════ 章级验收内核（判定/补写共享单源） ═══════════════════════════════

/** 锚点或选型判定 schema（一次批量调用判定部分响应条款的锚点是否为"任一即可"关系） */
const ANCHOR_ALTERNATIVE_JSON_SCHEMA: DocumentJsonSchema = {
  type: 'object',
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      required: true,
      minItems: 1,
      items: {
        type: 'object',
        required: true,
        properties: {
          index: { type: 'number', required: true },
          alternative: { type: 'boolean', required: true },
        },
      },
    },
  },
};

/**
 * 锚点或选型批量判定（300万根治防误报）：条款锚点为"或/及/任选其一"关系
 * （如"省级或国家级奖项""A、B、C任选一项"）时，部分锚点命中不算部分响应；
 * 并列承诺/金额+奖项共存条款（"确保黄山杯，支付300万元"）必须全部锚点命中。
 * 分类调用失败时保守判定非或选型（宁报部分响应不漏检——评标失分风险大于多余修复成本）。
 * 分批执行（D6 消费面扩容后部分响应候选可达 100+ 条，单批超 maxTokens 会静默缺号）：
 * 40 条/批并发 3 路，按全局下标合并；批失败保守判非或选型。
 */
const ALTERNATIVE_BATCH_SIZE = 40;

async function classifyAnchorAlternativeClauses(
  items: Array<{ text: string; missingAnchors: string[] }>,
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<Map<number, boolean>> {
  const trimmed = items.filter(item => item.text.trim());
  if (trimmed.length === 0) return new Map();
  const batches: Array<Array<{ text: string; missingAnchors: string[] }>> = [];
  for (let index = 0; index < trimmed.length; index += ALTERNATIVE_BATCH_SIZE) {
    batches.push(trimmed.slice(index, index + ALTERNATIVE_BATCH_SIZE));
  }
  const outcomes = await mapWithConcurrency(batches, 3, batch => classifyAnchorAlternativeBatch(batch, options));
  const judged = new Map<number, boolean>();
  outcomes.forEach((batchResult, batchIndex) => {
    batchResult.forEach((alternative, indexInBatch) => {
      judged.set(batchIndex * ALTERNATIVE_BATCH_SIZE + indexInBatch, alternative);
    });
  });
  return new Map(trimmed.map((_, index) => [index, judged.get(index) ?? false]));
}

/** 单批判定（批内下标返回，合并由 classifyAnchorAlternativeClauses 负责） */
async function classifyAnchorAlternativeBatch(
  items: Array<{ text: string; missingAnchors: string[] }>,
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<boolean[]> {
  const raw = await callDocumentLlmJson<{ results?: Array<{ index?: number; alternative?: boolean }> }>(
    [
      docSystemPrefix('你是招标要求条款锚点关系判定器。'),
      '对每条条款判定其锚点之间的关系：',
      '- alternative=true：条款锚点为"或/及/任选其一"关系（如"省级或国家级奖项""A、B、C任选"），满足任一锚点即算完整响应',
      '- alternative=false：条款锚点必须全部满足（并列承诺、金额与奖项共存条款），缺任一锚点即部分响应',
      '只输出 JSON，不得输出其他内容。',
    ].join('\n'),
    items.map((item, index) => `${index + 1}. 条款：${item.text}\n   未命中锚点：${item.missingAnchors.join('、') || '（无）'}`).join('\n'),
    {
      maxTokens: 1000,
      temperature: 0,
      signal: options.signal,
      diagnostics: options.diagnostics,
      schema: ANCHOR_ALTERNATIVE_JSON_SCHEMA,
      taskKind: 'structuredGeneration',
    },
  );
  if (!raw?.results?.length) return items.map(() => false);
  const judged = new Map<number, boolean>();
  for (const entry of raw.results) {
    if (typeof entry.index === 'number') judged.set(entry.index, entry.alternative === true);
  }
  return items.map((_, index) => judged.get(index) ?? false);
}

/**
 * 剥离奖项名前导动词/承诺词（"为争创黄山杯"→"黄山杯"），循环剥离直至稳定。
 * requirementAnchorCoverage 与奖项杜撰检测共用，保证锚点提取口径一致
 * （具名奖项正则贪婪会吞入前导动词，如"确保黄山杯"整体成锚，与 coreTerms"黄山杯"口径分裂导致误报）。
 */
function stripAwardLeadVerb(award: string): string {
  let result = award;
  for (;;) {
    const stripped = result.replace(/^(?:争创|争取|力争|争获|确保|获得|创建|力创|评为|荣获|标为|目标为|承诺|为)/u, '');
    if (stripped === result || !stripped) break;
    result = stripped;
  }
  return result;
}

/** 全角百分号归一（M26：s28k 正文写作半角「95%/10%」，锚点提取全角「95％/10％」→ 全半角形态差假 miss）：
 * 锚点侧与正文侧同源归一——requirementAnchorCoverage（锚）、clauseSegmentCoverage（分句）、
 * tenderRequirementResponseGaps 与 requirementAcceptanceIssues（正文入口）四处统一，防口径分裂。 */
function normalizePercent(text: string): string {
  return text.replace(/％/gu, '%');
}

/** 锚点比较变体归一（C8 S4-⑤）：招标条款锚点（coreTerms LLM 概括）与正文写作存在四类合法
 * 变体差异，字面 includes 遇变体即假 miss（s28m' 六条部分响应实锤：质量保修「施工场地的
 * 清理」、人员管理「"钉钉"系统」/「考勤、考核」、绿化「"五一"前」、考核「90分以下为不合格」、
 * 保修（养护）期括号注释——条款锚点与正文互为变体时锚点率与响应判定双失真）：
 * ①引号类包裹（「钉钉」系统 vs 钉钉系统；《监理月报》vs 监理月报）；
 * ②顿号/逗号插入（考勤、考核 vs 考勤考核）；
 * ③结构助词/系词「的、为」省略（施工场地的清理 vs 施工场地清理；90分以下为不合格 vs 90分以下不合格）；
 * ④括号注释省略（对竣工保修（养护）期内 vs 对竣工保修期内）。
 * 两侧同源归一（锚点/分句侧与正文 haystack 侧同函数）后比较，防口径分裂；判定入口
 * normalizedMarkdown 保持不变（原文命中优先），变体 haystack 由调用方一次归一传入（性能单源）。 */
function normalizeAnchorCompareText(text: string): string {
  return text
    // 全角→半角**必须最先**（数字/字母/斜杠/破折号/星号）：否则 `＊`/`ｘ` 折不出，
    // 后面的分隔符族归一对它们无效。编号与型号（`20S515／326`、`1．3．2`）折半角后可比。
    .replace(/[！-～]/gu, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    // 4.56.3 尺寸分隔符族归一（实测真缺陷）：条款原文用 `*`、正文写作习惯用 `×`——
    // 「600*600mm方形钢筋混凝土户线检查井」与正文「600×600mm方形钢筋混凝土户线检查井」
    // 因分隔符字形不同被判未落位（`600*600mm` 全文 0 次、`600×600mm` 有；该条是
    // 「招标要求部分响应」11 条 blocker 的主要成分）。两侧同折为 `×` 后逐字可比，不产生假命中。
    .replace(/[*✕╳xX×]/gu, '×')
    // 破折号/连接号族归一（与 normalizeRegulationCode 同口径）
    .replace(/[—–―─－〜～]/gu, '-')
    .replace(/[「」『』“”"'`《》]/gu, '')
    .replace(/[、，,]/gu, '')
    .replace(/[的为]/gu, '')
    .replace(/（[^）]*）|\([^)]*\)/gu, '');
}

/** 变体通道命中（锚点/分句共用）：归一后 ≥2 字且未坍缩过半（|变体|×2 ≥ |原文|）才比对——
 * 防「钢筋（HRB400）」类含括号锚点剥成「钢筋」后在任意语境误命中（假阴性防线）；范围数字
 * 锚点（0.25-0.5m 类）不依赖变体通道，仍走 anchorHit 内的两端数字判定。 */
function anchorVariantHit(text: string, variantMarkdown: string): boolean {
  const variant = normalizeAnchorCompareText(text);
  if (variant.length < 2 || variant.length * 2 < text.length) return false;
  return variantMarkdown.includes(variant);
}

/**
 * 锚点等价命中判定（r8 实机 #4 复核）：「0.25-0.5m宽」类范围复合锚点，正文写作
 * 「0.25～0.5m」「0.25~0.5m」或省后缀「预留0.25-0.5m」时字面 includes 因连接符/
 * 后缀差异失配 → 假部分响应。范围锚点降级为「两端数字均出现即命中」（范围数字组合
 * 巧合概率极低）；非范围锚点维持字面包含 + C8 S4-⑤ 变体通道（见 normalizeAnchorCompareText）。
 */
function anchorHit(anchor: string, normalizedMarkdown: string, variantMarkdown: string): boolean {
  if (normalizedMarkdown.includes(anchor)) return true;
  if (anchorVariantHit(anchor, variantMarkdown)) return true;
  const range = anchor.match(/(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)/u);
  if (!range) return false;
  return normalizedMarkdown.includes(range[1]) && normalizedMarkdown.includes(range[2]);
}

/**
 * 条款锚点全清单（写作卡下发 / 覆盖判定 / 修复缺口反馈单源）：条款内全部关键锚点——
 * ① coreTerms 专有名词（≥2 字；引用性词过滤——文号/行政文件名不作锚点，正文按制度应用写不逐字复现；
 *    含数字复合词分解——「一次性成活率95%」→「一次性成活率」+「95%」，正文自然写作常被数量词分隔，
 *    整串字面匹配假 miss）；
 * ② 「数字+单位」组合（纯数字不作锚点；「N.N项」编号切片守卫）；
 * ③ 具名奖项/等级（stripAwardLeadVerb 剥离前导动词）。
 */
export function collectRequirementAnchors(
  item: { text: string; coreTerms: string[] },
  options?: { skipNumericAnchors?: boolean },
): string[] {
  const text = normalizePercent(item.text.replace(/\s+/gu, ''));
  const anchors = new Set<string>();
  // 专有名词：coreTerms 全部作为锚点（长度≥2；引用性词过滤；含数字复合词分解）
  for (const term of item.coreTerms) {
    const clean = normalizePercent(term.replace(/\s+/gu, ''));
    if (clean.length < 2) continue;
    if (isDocumentReferenceTerm(clean)) continue;
    // 4.58 R4：标准/图集代号不进锚点——它们的数字是**代号的一部分**，
    // 走下面的复合词分解会切成无意义碎片（`23S516` → `23S` + `516`，正文写全编号也命不中）
    if (isStandardOrAtlasCode(clean)) continue;
    const compound = clean.match(/^(.*?)(\d+(?:\.\d+)?(?:%|％)?)$/u);
    if (compound && compound[1].length >= 2) {
      anchors.add(compound[1]);
      anchors.add(compound[2]);
      continue;
    }
    anchors.add(clean);
  }
  // 数字参数：每个"数字+单位"组合都是独立锚点（纯数字不作锚点；单位词表限工程条款常用单位）。
  // 商务条款（保证金金额/付款时限/违约金利率）的数字参数不强制落位技术标正文，skipNumericAnchors 跳过
  if (!options?.skipNumericAnchors) {
    /**
     * 单位交替串**必须多字符在前**（4.56.3 修复 truncation）：原顺序 `…|米|m|M|mm|毫米|…`
     * 把单字符 `m` 排在 `mm` 之前，`700mm` 被截成 `700m`（留下孤立 `m`）——锚点即残片，
     * 正文写出完整的 `700×700mm` 也永远命不中，是「招标要求部分响应」假 blocker 的第二个来源。
     * 与 `unitAliases.ts` 的 `MEASURE_UNIT_SOURCE` 同一条纪律（注释里已写明「多字符在前」）。
     */
    for (const match of text.matchAll(/(?:\d+(?:\.\d+)?\s*(?:%|％|万元|亿元|小时|分钟|毫米|MPa|kPa|mm|天|日|元|米|m|M|层|年|个|月|周|项|处|台|套|辆|人|家|次|遍|道|吨))/giu)) {
      const anchorText = normalizePercent(match[0].replace(/\s+/gu, ''));
      // M26 编号切片守卫：「N.N项」为「N.N项目/N.N项次」编号前缀被截断的产物（r28k「1.1项」←「1.1项目名称」、
      // 「2.10项」←「2.10项目类别」、「3.3项」←「第1.3.3项」实机），非真实数量参数——整数+项（3项）保留，小数+项丢弃
      if (/^\d+\.\d+项$/u.test(anchorText)) continue;
      anchors.add(anchorText);
    }
  }
  // 具名奖项/等级：条款原文里的「XX杯/XX奖/XX星」锚点（「级」后缀过宽不取，靠 coreTerms/数字锚点覆盖）；
  // 正则贪婪会吞入前导动词（"确保黄山杯"），stripAwardLeadVerb 循环剥离保证与 coreTerms 口径一致
  for (const match of text.matchAll(/[\u4e00-\u9fa5]{2,6}[杯奖星]/gu)) {
    const award = stripAwardLeadVerb(match[0]);
    if (/^[\u4e00-\u9fa5]{2,7}$/u.test(award)) anchors.add(award);
  }
  return [...anchors];
}

/**
 * 条款锚点覆盖判定（300万缺失根治）：条款内全部关键锚点（每个 coreTerms 专有名词、每个"数字+单位"、
 * 每个具名奖项/等级）必须各自字面命中正文。字面兜底保留（黄山杯实测 bge 0.50 < 0.6 被误报零响应），
 * 升级为锚点全覆盖：全部命中才算完全响应，部分命中报"部分响应"定向补写缺失锚点。
 * 锚点集合构建单源（collectRequirementAnchors，与写作卡下发同源）。
 */
function requirementAnchorCoverage(
  item: { text: string; coreTerms: string[] },
  normalizedMarkdown: string,
  variantMarkdown: string,
  options?: { skipNumericAnchors?: boolean },
): { total: number; hit: string[]; missing: string[] } {
  const anchors = collectRequirementAnchors(item, options);
  const hit: string[] = [];
  const missing: string[] = [];
  for (const anchor of anchors) {
    (anchorHit(anchor, normalizedMarkdown, variantMarkdown) ? hit : missing).push(anchor);
  }
  return { total: anchors.length, hit, missing };
}

/**
 * 条款原文分句兜底（B 闭环终收尾 4.27.1）：锚点判定用 coreTerms（LLM 概括短语）与正文抄写句
 * （「按招标文件要求：<条款原文>」）存在词面错位——分句兜底：条款去括号举例后按标点切分为实质分句
 * （≥6 字符），全部分句字面落位正文 = 原文抄写 = 完全响应。防误放行：全部分句命中才放行。
 * C8 S1 死锁兜底：去括号后全部分句均 <6 字符被下限滤除时（短条款「（9）发现脏、差，有缺损。」
 * → [发现脏/差/有缺损] 全滤）此前 total=0 → clauseSatisfied 三通道恒假 → 链尾收口每轮判残留
 * 每轮重插（r28m' 三连重复根因）——以去引号整体文本为唯一分句（仍要求连续字面落位，零放水；
 * 整体仍 <6 字符时维持 total=0，插入侧由形态闸拒插短素材显性记录）。
 */
function clauseSegmentCoverage(text: string, normalizedMarkdown: string, variantMarkdown: string): { total: number; missing: string[] } {
  const withoutParenthetical = normalizePercent(text).replace(/（[^）]*）|\([^)]*\)/gu, '');
  const segments = withoutParenthetical
    .split(/[，。；、,;\n]/u)
    .map(segment => segment.replace(/[「」“”"'`\s]/gu, '').trim())
    .filter(segment => segment.length >= 6);
  if (segments.length === 0) {
    const whole = withoutParenthetical.replace(/[「」“”"'`\s]/gu, '').trim();
    if (whole.length >= 6) {
      // C8 S4-⑤：分句整体比较同样接入变体通道（正文括号注释省略/引号顿号差异）
      const wholeHit = normalizedMarkdown.includes(whole) || anchorVariantHit(whole, variantMarkdown);
      return { total: 1, missing: wholeHit ? [] : [whole] };
    }
  }
  // C8 S4-⑤：分句比较接入变体通道——条款侧已剥括号，正文侧保留括号时（「对竣工保修（养护）
  // 期内…」vs 分句「对竣工保修期内…」）此前必假 miss（s28m' 全通道失败实锤）；变体通道
  // 同源归一覆盖括号/引号/顿号/「的为」四类差异，未命中原文时再比对变体
  const missing = segments.filter(segment => !normalizedMarkdown.includes(segment) && !anchorVariantHit(segment, variantMarkdown));
  return { total: segments.length, missing };
}

/**
 * 投标人口吻转换（4.27.2 语气泄漏治理 · P0）：条款抄写句中的第三人称指代改为投标人口吻——
 * 「承包人/投标人/施工单位/承包方/中标人」→「我方」；「投标人本单位」→「本公司」；
 * 「本招标项目」→「本项目」；「发包人认为视同」→「视为」；招标文件表格勾选标记（☑√■等，
 * r11：前附表资格条款「☑具备…」随提取进入条款原文，不做清洗则补写插入句把模板符号带进正文）。
 * 转换三端同源：补写句生成、检测端 voice 分句兜底、交付前元语言清理器（fixTenderMetaLanguage）。
 * 导出供要求响应补写轮（requirementResponseRepair）生成定向补写素材。
 */
export function bidderVoiceClauseText(text: string): string {
  return text
    .replace(/[☑☐☒√✓✔■●◼⊠]\s*/gu, '')
    // C8 S1：「×」仅剥离独立符号位（勾选/叉选标记），保留数字间乘法形态（「4000×3200」）——
    // 全量剥离曾使 voice 素材与正文「×/*」变体互相失配、查重漏网重复插入（r28m' 放大器之一）
    .replace(/(?<![\d])\s*[×✗]\s*(?![\d])/gu, '')
    // C8 S1 行首枚举前缀剥离：「（9）」「2.」「6.5.35.」「14、」「一、」——条款号随提取进入素材，
    // 不剥离则补写句把条款号带进正文（r28m' L1616 等实录）。检测端 voice 分句通道与补写素材
    // 同用本函数（同源剥离），插入物与判定侧形态严格一致；「2.5米」类小数前缀由数字前瞻保护不剥离
    .replace(/^\s*(?:[（(]\s*\d{1,3}\s*[)）]|(?:\d{1,3}(?:\.\d{1,3}){0,3})[.、,，](?=[\u4e00-\u9fff（(])|(?:[一二三四五六七八九十]{1,3})[、.，,](?=[\u4e00-\u9fff（(]))/u, '')
    .replace(/投标人本单位|承包人本单位/gu, '本公司')
    .replace(/本招标项目/gu, '本项目')
    .replace(/(?:承包人|发包人)认为视同/gu, '视为')
    .replace(/承包人|投标人|施工单位|承包方|中标人|承包单位|投标单位/gu, '我方');
}

/**
 * 条款响应满足判定（检测/补写共享单源）：
 * ①锚点全覆盖（coreTerms/数字/奖项字面命中）或 ②条款原文分句全落位（原样抄写句）或
 * ③投标人口吻转换后分句全落位（voice 改造后的补写句形态）→ 已满足。
 * 历史缺陷（重复补写根因）：各补写器判定口径不一致——stage5 写入的 voice 补写句
 * 在终检「锚点全覆盖」口径下不可见 → 重复补写。各端共用本谓词：检测放行、补写幂等严格同源。
 */
function clauseSatisfied(item: { text: string; coreTerms: string[] }, normalizedMarkdown: string, variantMarkdown: string): boolean {
  const coverage = requirementAnchorCoverage(item, normalizedMarkdown, variantMarkdown);
  if (coverage.total > 0 && coverage.missing.length === 0) return true;
  const segmentCoverage = clauseSegmentCoverage(item.text, normalizedMarkdown, variantMarkdown);
  if (segmentCoverage.total > 0 && segmentCoverage.missing.length === 0) return true;
  const voiceCoverage = clauseSegmentCoverage(bidderVoiceClauseText(item.text), normalizedMarkdown, variantMarkdown);
  if (voiceCoverage.total > 0 && voiceCoverage.missing.length === 0) return true;
  return false;
}

/**
 * 要求响应复检（确定性三通道，修复轮专用包装）：对给定条目逐条判定当前 markdown 中的响应状态
 * （命中/缺失锚点 + 是否已满足），与 clauseSatisfied 严格同源——要求响应补写轮
 * （requirementResponseRepair）的修复前定位与修复后收敛复检共用本口径。
 */
export function tenderRequirementResponseGaps(
  entries: TenderRequirementEntry[],
  markdown: string,
): Array<{ entry: TenderRequirementEntry; hit: string[]; missing: string[]; satisfied: boolean }> {
  const normalized = normalizePercent(markdown.replace(/\s+/gu, ''));
  // C8 S4-⑤ 变体 haystack 一次归一（与判定侧同源，防口径分裂；修复轮复检与检测端共用本口径）
  const variant = normalizeAnchorCompareText(normalized);
  return entries.map(entry => {
    const coverage = requirementAnchorCoverage(entry, normalized, variant);
    return { entry, hit: coverage.hit, missing: coverage.missing, satisfied: clauseSatisfied(entry, normalized, variant) };
  });
}

// 商务域条款排除词表已上移至 CACHE_JUDGE_FINGERPRINT_SOURCES 之前（M26：词表需入指纹源）
export function isCommercialScopeClause(text: string) {
  if (COMMERCIAL_TECHNICAL_RESCUE_RE.test(text)) return false;
  return COMMERCIAL_SCOPE_RE.test(text);
}


/**
 * 章级要求验收（写作收口前对本章责任要求的逐条核验；也用于修复轮后回归重验）。
 * 按 policy 分流：
 * - comply（遵守类）：不做落位验收（其核验属数据一致性域：工期基准/禁编日期等→蓝图权威值核对）；
 * - respond（显性响应）：语义（bge ≥0.6）+ 金额锚点 + 锚点全覆盖/分句/voice 三通道；部分响应经
 *   「或/及」批量判定后定向补写缺失锚点；零响应报 blocker（章内定向修复输入）。
 * 商务域条款已在判定层排除（commercial_scope），不在验收范围。
 * 返回全量 issues（不截断）。
 */
export async function requirementAcceptanceIssues(input: {
  markdown: string;
  entries: TenderRequirementEntry[];
  /** 正文句（语义判定的右侧文本，与章节标题同口径 join 后判定） */
  bodyTexts?: string[];
  semanticSimilarity: SemanticSimilarityFn;
  signal?: AbortSignal;
  diagnostics?: DocumentGenerationDiagnostics;
}): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  if (input.entries.length === 0) return issues;
  const markdown = input.markdown;
  const normalized = normalizePercent(markdown.replace(/\s+/gu, ''));
  // C8 S4-⑤ 变体 haystack 一次归一（全文 20 万字级，逐锚点归一开销不可接受；与修复轮复检同源）
  const variant = normalizeAnchorCompareText(normalized);
  // 六项词面兜底：「扬尘治理六个百分百」体系基准条款语义稀释误报——正文已逐项落位六项措施词面
  // （100%围挡/覆盖/冲洗/硬化/密闭运输）时判响应。词表与拆迁项豁免判定**同源引用检测器**
  // （SIX_HUNDRED_PERCENT_LEXICAL_ITEMS + sixHundredPercentLexicalHitCount），不再自持一份副本：
  // 原副本的拆迁项额外收了裸「无拆迁|不涉及拆迁」，裸短语在任意语境（如「临时设施布置不涉及拆迁补偿」）
  // 即把该项记为已落实、硬凑够 ≥4 项放行本条款；现只认工程主语＋短距否定的豁免句（检测侧口径）。
  const dustSixLexicalHitCount = () => sixHundredPercentLexicalHitCount(markdown);
  const chapterLines = markdown.split(/\n/u).filter(line => /^#{2,4}\s/u.test(line.trim())).map(line => normalizeChapterTitleLine(line)).filter(Boolean);
  const targets = input.bodyTexts && input.bodyTexts.length > 0 ? [...chapterLines, ...input.bodyTexts] : (chapterLines.length > 0 ? chapterLines : [markdown.slice(0, 2000)]);
  const partialResponseCandidates: Array<{ item: TenderRequirementEntry; kind: string; bestSimilarity: number; hit: string[]; missing: string[] }> = [];
  for (const entry of input.entries) {
    const kind = entry.category;
    // 遵守类不落位验收（数据一致性域负责）
    if (entry.policy === 'comply') continue;
    // 六项词面兜底：总称条款（六个百分百）语义判定前先做词面命中判定，命中 ≥4 项即已响应
    if (/六个百分百|扬尘治理/u.test(entry.text) && dustSixLexicalHitCount() >= 4) continue;
    const query = tenderRequirementSemanticQuery(entry);
    let bestSimilarity = 0;
    for (const target of targets) {
      const score = input.semanticSimilarity(query, target);
      if (score > bestSimilarity) bestSimilarity = score;
    }
    if (bestSimilarity >= SEMANTIC_COVERAGE_THRESHOLD) {
      // 语义命中仅证明主题已响应：条款内锚点仍须逐条落位（dangling 修复——语义放行但锚点缺失此前静默，
      // 报告锚点率与修复链消费面分裂：s28l 138 条 unsatisfied 中多数即此类）；或/及条款由 LLM 判定兜底放行
      if (clauseSatisfied(entry, normalized, variant)) continue;
      const coverage = requirementAnchorCoverage(entry, normalized, variant);
      if (coverage.total > 0) {
        partialResponseCandidates.push({ item: entry, kind, bestSimilarity, hit: coverage.hit, missing: coverage.missing });
      }
      continue;
    }
    // 字面锚点兜底升级 + 分句兜底 + voice 通道：共享谓词 clauseSatisfied——三通道任一完全命中即已响应
    if (clauseSatisfied(entry, normalized, variant)) continue;
    const coverage = requirementAnchorCoverage(entry, normalized, variant);
    if (coverage.hit.length > 0) {
      // 部分响应候选：锚点部分命中，「或/及」条款由 LLM 批量判定兜底防误报
      partialResponseCandidates.push({ item: entry, kind, bestSimilarity, hit: coverage.hit, missing: coverage.missing });
      continue;
    }
    issues.push({
      level: 'error',
      severity: 'blocker',
      category: 'structure',
      owner: 'llm',
      repairability: 'llm_repairable',
      message: `招标要求未响应：${kind}“${entry.text}”在正文中零命中（最佳语义相似度 ${bestSimilarity.toFixed(2)}）`,
      suggestion: `招标文件明确要求的${kind}必须显性响应：在对应章节以投标人口吻补写“${entry.text}”对应内容及配套保证措施（不得使用“按招标文件要求：”条幅前缀）。`,
      provenance: { detectorId: 'requirements-coverage', fingerprint: stableHash(entry.text) },
    });
  }
  // 部分响应：LLM 批量判定锚点是否"或/及"关系（任一即可），非或选型报部分响应定向补写缺失锚点
  if (partialResponseCandidates.length > 0) {
    const alternatives = await classifyAnchorAlternativeClauses(
      partialResponseCandidates.map(candidate => ({ text: candidate.item.text, missingAnchors: candidate.missing })),
      { signal: input.signal, diagnostics: input.diagnostics },
    );
    for (const [candidateIndex, candidate] of partialResponseCandidates.entries()) {
      if (alternatives.get(candidateIndex)) continue;
      // C8 S4-⑤：hit 为空时不得输出「已命中“”」空名单（s28m' 考核条款实录）——如实只报缺失项
      const hitText = candidate.hit.length > 0 ? `已命中“${candidate.hit.join('、')}”，` : '';
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `招标要求部分响应：${candidate.kind}“${candidate.item.text}”${hitText}但缺少“${candidate.missing.join('、')}”（最佳语义相似度 ${candidate.bestSimilarity.toFixed(2)}）`,
        suggestion: `条款内全部关键数据与奖项必须逐项显性响应：在对应章节补写“${candidate.missing.join('、')}”对应内容（缺一即部分响应）。`,
        provenance: { detectorId: 'requirements-coverage', fingerprint: stableHash(candidate.item.text) },
      });
    }
  }
  return issues;
}

// ═══════════════════════════════ 交付前确定性清理器（保留） ═══════════════════════════════

/**
 * 招标元语言确定性清理：正文不得出现「按招标文件要求：」「按招标文件约定：」条幅前缀与
 * 「按上述条款执行」类调用式元语言（评标人视角即编制模板痕迹）。
 * 清理规则（行级、标题行/表格行豁免）：
 * ①条幅前缀剥离：条款正文保留并经 bidderVoiceClauseText 转投标人口吻；
 * ②句内元语言替换；③空响应句整行删除；④「招标文件」文件名称引用（编制依据小节等）保留。
 */
export function fixTenderMetaLanguage(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const out: string[] = [];
  let fixedCount = 0;
  const details: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    // 标题行/表格行/空行豁免（标题由标题治理链负责，表格为数据行）
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(line)) {
      out.push(line);
      continue;
    }
    let next = line;
    // ①条幅前缀剥离（行首）：条款正文保留并转投标人口吻
    const banner = /^(\s*)按招标文件(?:要求|约定)：\s*(.+)$/u.exec(next);
    if (banner) next = `${banner[1]}${bidderVoiceClauseText(banner[2])}`;
    // ③空响应句删除（先于②，避免「按上述条款要求」被②拆改后检测串失配）
    next = next.replace(/本施工组织设计已按上述条款要求逐项落实执行。?/gu, '');
    // ②句内元语言替换（按上述条款要求优先于被截短形态，交替顺序即优先级）；
    // 替换目标用中性「按招标要求」——不得改写为「按合同约定」式商务声明句（技术标正文零商务句）
    next = next
      .replace(/按招标文件约定/gu, '按招标要求')
      .replace(/按招标文件要求/gu, '按招标要求')
      .replace(/按招标文件规定/gu, '按招标要求')
      .replace(/按上述条款要求|按上述条款|按上述要求/gu, '按招标要求')
      .replace(/按上述时限/gu, '按约定时限')
      .replace(/本招标项目/gu, '本项目');
    if (next !== line) {
      fixedCount += 1;
      if (details.length < 6) details.push(trimmed.slice(0, 24));
    }
    if (!next.trim()) {
      // 整行仅含空响应句：行删除（前后均空行时吞掉尾随空行，防双空行残留）
      if (index + 1 < lines.length && !lines[index + 1].trim() && out.length > 0 && !out[out.length - 1].trim()) index += 1;
      continue;
    }
    out.push(next);
  }
  return { markdown: out.join('\n'), fixedCount, details };
}

/**
 * 资料载体残片确定性清理（4.55.12 巢湖实测：答疑对答段 + 图纸 OCR 残片段 + 数值堆砌残句）：
 * 三类都不是可交付正文，而是**资料载体的原文残片**——
 * ① 答疑残片段：以「答：/答复：/回复：」开头的答案行（要求池未过滤时由条款尾收口整段搬入正文，
 *    巢湖终稿实测 7 处：答疑文件逐条答案以「答：三级钢，见图纸说明7.4.1。门卫同。」形态成段出现）；
 * ② 图纸 OCR 残片段：图签/钢筋表/盖板规格表类「数字符号密集串」（序号规格数量粘连、@200 箍筋间距、
 *    ①②③ 引线编号），OCR 文本被当正文资料引用；
 * ③ 数值堆砌残句：无成句语义的纯参数罗列（同为字符占比超限形态，与 ② 同判据收口；巢湖实测该行是
 *    「无主数值审计：疑似编造 JC-07/JC-08/JC-09」的唯一来源）。
 * 判据：矩形字符（数字+符号）占比 ≥0.45——正常数据句实测占比 ≤0.21（「配电箱70台、桥架2811m、
 * 配管21034.6m…」类合规数据罗列最高 0.21），阈值留一倍余量；行级整行删除并登记，标题行/表格行豁免。
 */
export function fixFormalSourceResidue(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  // 4.55.19 句中形态残片先行（行级判据看不见句内澄清表残片；两链共用本函数）
  const sentenceLevel = stripSentenceLevelResidue(markdown);
  // 4.55.20 变更过程叙述清理（正文只陈述现行值，不得描述澄清过程）
  const narrative = stripClarificationNarrative(sentenceLevel.text);
  // 4.55.25：指向型表述（「参见《…》20S515/29」「按设计图纸控制」「待补充」）链尾确定性清除——
  // 只报不删等于没修（实测交付物仍带病）；指向处应写的具体做法由写作侧按绑定参数写出
  const pointer = stripDrawingPointerPhrases(narrative.text);
  markdown = pointer.text;
  const lines = markdown.split(/\r?\n/u);
  const out: string[] = [];
  let fixedCount = 0;
  const details: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isMaterialResidueLine(line)) {
      out.push(line);
      continue;
    }
    fixedCount += 1;
    if (details.length < 6) details.push(line.trim().slice(0, 24));
    // 整行删除：前后均空行时吞掉尾随空行，防双空行残留（与 fixTenderMetaLanguage 同形态）
    if (index + 1 < lines.length && !lines[index + 1].trim() && out.length > 0 && !out[out.length - 1].trim()) index += 1;
  }
  const sentenceLevelCount = sentenceLevel.removed + narrative.removed + pointer.removed;
  return {
    markdown: out.join('\n'),
    fixedCount: fixedCount + sentenceLevelCount,
    details: sentenceLevelCount > 0 ? [...details, `句中资料残片 ${sentenceLevelCount} 处`].slice(0, 6) : details,
  };
}

/**
 * 条款响应重复行确定性去重（交付链兜底）：补写句（条款抄写句）残缺双写产生完全重复行时，
 * 识别「条款响应特征行」（规范化长度 ≥40 且含 我方/本工程），同规范化文本出现 ≥2 次时
 * 仅保留首次，后续整行（含尾随空行）删除。零误伤防线：仅完全一致的整行参与判定。
 */
export function stripDuplicateResponseLines(markdown: string): { markdown: string; fixedCount: number; details: string[] } {
  const lines = markdown.split(/\r?\n/u);
  const seen = new Set<string>();
  const out: string[] = [];
  let fixedCount = 0;
  const details: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^\s*\|/u.test(line)) {
      out.push(line);
      continue;
    }
    const normalized = trimmed.replace(/\s+/gu, '');
    const isResponseLine = normalized.length >= 40 && (/我方/u.test(normalized) || /本工程/u.test(normalized));
    if (!isResponseLine) {
      out.push(line);
      continue;
    }
    if (seen.has(normalized)) {
      // 重复行删除：连带吞掉尾随空行（保留前文块间隔空行，避免遗留双空行）
      while (index + 1 < lines.length && !lines[index + 1].trim()) index += 1;
      fixedCount += 1;
      if (details.length < 6) details.push(trimmed.slice(0, 24));
      continue;
    }
    seen.add(normalized);
    out.push(line);
  }
  return { markdown: out.join('\n'), fixedCount, details };
}
