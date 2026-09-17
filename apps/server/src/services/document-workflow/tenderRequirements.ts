import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DocumentEvidence,
  DocumentGenerationDiagnostics,
  TenderRequirementEntry,
  TenderRequirementExclusion,
  TenderRequirementModel,
  TenderRequirementPolicy,
  ValidationIssue,
} from './types';
import { callDocumentLlmJson, type DocumentJsonSchema } from './llmClient';
import { generatedRoot } from '../document-core/generatedDocumentService';
import { cleanPdfHeadingNoise } from './factsModel';
import type { SemanticSimilarityFn } from './semanticSimilarity';
import { isBidDisciplineSentence, isBidEvaluationRuleText, stableHash, systemConstraintLine } from './utils';
import { isBidderQualificationText, isContractProcedureClause } from './evidenceContentSafety';
import { docSystemPrefix } from './markdownComposer';

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
    reconciliation: { clauseCount: 0, entryCount: 0, excludedCount: 0, undecidedCount: 0, mergedCount: 0, batchCount: 0, retriedBatches: 0 },
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
  '4. coreTerms：2-4 个用于正文核对的核心词（专有名词/等级名/体系名/关键数字参数，如「黄山杯」「二星级」「六个百分百」「300万元」）；',
  '   数字参数必须保留数字与单位；不要泛化词（「施工」「工程」类不能作为核心词）；',
  '   必须是正文中可自然逐字出现的完整词/短语（括号/标点保持原文形态），不得使用去标点拼接的短语碎片或合同填空语言（如「承包人自理」）',
  '5. category：按招标语义命名类别（如「质量创优」「工期进度」「安全文明」「绿色施工」「人员管理」「商务支付」「禁止性要求」），',
  '   同类要求使用同一类别名',
  '',
  'isRequirement=false 或 inScope=false 时须给出 reason（枚举）：',
  '- "non_requirement"：非约束性内容（目录/导语/说明/描述）',
  '- "out_of_scope"：超出施组职责（投标程序/资格/评标规则/纪律/格式/商务与造价/合同履约管理程序）',
  '- "no_value"：条款值为「无」或不适用',
  '',
  '输出 JSON 结构（覆盖全部序号，每序号必出结果）：',
  '{ "results": [',
  '  { "index": 0, "isRequirement": true, "inScope": true, "policy": "respond", "coreTerms": ["黄山杯", "300万元"], "category": "质量创优" },',
  '  { "index": 1, "isRequirement": false, "inScope": false, "reason": "out_of_scope" }',
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
  batchCount: number;
  retriedBatches: number;
}

/** 条款实现约束词（碎片形态复核用）：含任一即视为有实质语义的短句，保留交判定层处理 */
const CLAUSE_CONSTRAINT_WORD_RE = /(?:确保|保证|达到|满足|符合|不低于|不超过|不得|禁止|严禁|必须|应当|须|应按|执行|遵守|落实|实施|采用|提供|提交|出具|配备|设置|建立|安装|配置|负责|完成|参加|组织|验收|检测|检验|控制|管理|保护|防止|杜绝|承诺|响应|要求|规定|标准|等级|目标|措施|方案|制度|计划|工期|质量|安全)/u;

/** 碎片形态判定（判定层兼底闸）：≤10 字、无数字、无约束谓词的残片（折行半句/表格残片/跨页断句，
 *  如「认使用时限。」「币）。」）不构成独立要求（宁缺毋假）；含数字（参数）或约束词的短句保留 */
function clauseFragmentLike(text: string): boolean {
  const compact = text.replace(/\s+/gu, '');
  return compact.length <= 10 && !/\d/u.test(compact) && !CLAUSE_CONSTRAINT_WORD_RE.test(compact);
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
  if (clauses.length === 0) return { entries, excluded, undecided, batchCount: 0, retriedBatches: 0 };
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
      if (isBidDisciplineSentence(clause.text) || isBidderQualificationText(clause.text) || isBidEvaluationRuleText(clause.text) || isContractProcedureClause(clause.text)) {
        excluded.push({ text: clause.text, source: formatClauseSource(clause), reason: 'out_of_scope' });
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
  return { entries, excluded, undecided, batchCount: batches.length, retriedBatches };
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
    `逐条判定完成：要求 ${merged.entries.length} + 排除 ${judged.excluded.length}${merged.mergedCount > 0 ? ` + 合并 ${merged.mergedCount}` : ''} + 未判定 ${judged.undecided.length}`,
    judged.undecided.length === 0
      ? ['对账闭合：全部条款已判定']
      : [`未判定 ${judged.undecided.length} 条（LLM 输出缺号且重试后仍缺），对账未闭合，缓存不落盘`],
  );
  const extracted = judged.entries.length > 0 || judged.excluded.length > 0;
  return {
    entries: merged.entries,
    excluded: judged.excluded,
    reconciliation: {
      clauseCount: clauses.length,
      entryCount: merged.entries.length,
      excludedCount: judged.excluded.length,
      undecidedCount: judged.undecided.length,
      mergedCount: merged.mergedCount,
      batchCount: judged.batchCount,
      retriedBatches: judged.retriedBatches,
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
 */
const TENDER_REQUIREMENTS_CACHE_VERSION = 'tender-requirements-extraction-v7';

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

/** 提取缓存 key：提取器版本 + 招标文件直读集合指纹 */
export function tenderRequirementsCacheKey(input: { collectionEvidence: DocumentEvidence[] }) {
  return stableHash({
    version: TENDER_REQUIREMENTS_CACHE_VERSION,
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

/** 本章要求分片渲染（写作注入用）：蓝图分配的本章责任要求全量（不截断），按 policy 标注处理方式 */
export function renderChapterRequirementSlice(entries: TenderRequirementEntry[]): string {
  if (entries.length === 0) return '';
  const policyLabel: Record<TenderRequirementPolicy, string> = {
    respond: '显性响应',
    comply: '全文遵守',
  };
  const lines = entries.map(entry => {
    const source = entry.sources.find(item => item.file)?.file;
    return `- [${policyLabel[entry.policy]}] ${entry.text}${source ? `（来源：${source}）` : ''}`;
  });
  return [
    '【本章必须处理的招标要求（蓝图分配全量，逐条响应/遵守；零处理即评标失分）】',
    ...lines,
    systemConstraintLine('以上为系统提取的招标要求原文：实质内容（奖项名称/等级指标/数字参数）必须显性落位；本段提示词文字本身（编号、括号说明等元话语）禁止复述进正文'),
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

/** 路由相似度下限：低于该值标记低置信（仍分配主责章；argmax 兜底保证未分配=0） */
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
 */
async function classifyAnchorAlternativeClauses(
  items: Array<{ text: string; missingAnchors: string[] }>,
  options: { signal?: AbortSignal; diagnostics?: DocumentGenerationDiagnostics } = {},
): Promise<Map<number, boolean>> {
  const trimmed = items.filter(item => item.text.trim());
  if (trimmed.length === 0) return new Map();
  const raw = await callDocumentLlmJson<{ results?: Array<{ index?: number; alternative?: boolean }> }>(
    [
      docSystemPrefix('你是招标要求条款锚点关系判定器。'),
      '对每条条款判定其锚点之间的关系：',
      '- alternative=true：条款锚点为"或/及/任选其一"关系（如"省级或国家级奖项""A、B、C任选"），满足任一锚点即算完整响应',
      '- alternative=false：条款锚点必须全部满足（并列承诺、金额与奖项共存条款），缺任一锚点即部分响应',
      '只输出 JSON，不得输出其他内容。',
    ].join('\n'),
    trimmed.map((item, index) => `${index + 1}. 条款：${item.text}\n   未命中锚点：${item.missingAnchors.join('、') || '（无）'}`).join('\n'),
    {
      maxTokens: 1000,
      temperature: 0,
      signal: options.signal,
      diagnostics: options.diagnostics,
      schema: ANCHOR_ALTERNATIVE_JSON_SCHEMA,
      taskKind: 'structuredGeneration',
    },
  );
  if (!raw?.results?.length) return new Map(trimmed.map((_, index) => [index, false]));
  const judged = new Map<number, boolean>();
  for (const entry of raw.results) {
    if (typeof entry.index === 'number') judged.set(entry.index, entry.alternative === true);
  }
  return new Map(trimmed.map((_, index) => [index, judged.get(index) ?? false]));
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

/**
 * 锚点等价命中判定（r8 实机 #4 复核）：「0.25-0.5m宽」类范围复合锚点，正文写作
 * 「0.25～0.5m」「0.25~0.5m」或省后缀「预留0.25-0.5m」时字面 includes 因连接符/
 * 后缀差异失配 → 假部分响应。范围锚点降级为「两端数字均出现即命中」（范围数字组合
 * 巧合概率极低）；非范围锚点维持字面包含（不放宽）。
 */
function anchorHit(anchor: string, normalizedMarkdown: string): boolean {
  if (normalizedMarkdown.includes(anchor)) return true;
  const range = anchor.match(/(\d+(?:\.\d+)?)\s*[-–—~～至]\s*(\d+(?:\.\d+)?)/u);
  if (!range) return false;
  return normalizedMarkdown.includes(range[1]) && normalizedMarkdown.includes(range[2]);
}

/**
 * 条款锚点覆盖判定（300万缺失根治）：条款内全部关键锚点（每个 coreTerms 专有名词、每个"数字+单位"、
 * 每个具名奖项/等级）必须各自字面命中正文。字面兜底保留（黄山杯实测 bge 0.50 < 0.6 被误报零响应），
 * 升级为锚点全覆盖：全部命中才算完全响应，部分命中报"部分响应"定向补写缺失锚点。
 */
function requirementAnchorCoverage(
  item: { text: string; coreTerms: string[] },
  normalizedMarkdown: string,
  options?: { skipNumericAnchors?: boolean },
): { total: number; hit: string[]; missing: string[] } {
  const text = item.text.replace(/\s+/gu, '');
  const anchors = new Set<string>();
  // 专有名词：coreTerms 全部作为锚点（长度≥2；「或/及」条款的锚点必要性由 LLM 或选型判定兜底）
  for (const term of item.coreTerms) {
    const clean = term.replace(/\s+/gu, '');
    if (clean.length >= 2) anchors.add(clean);
  }
  // 数字参数：每个"数字+单位"组合都是独立锚点（纯数字不作锚点；单位词表限工程条款常用单位）。
  // 商务条款（保证金金额/付款时限/违约金利率）的数字参数不强制落位技术标正文，skipNumericAnchors 跳过
  if (!options?.skipNumericAnchors) {
    for (const match of text.matchAll(/(?:\d+(?:\.\d+)?\s*(?:%|％|天|日|万元|亿元|元|米|m|M|mm|毫米|层|年|个|月|周|小时|分钟|项|处|台|套|辆|人|家|次|遍|道|吨|kPa|MPa))/giu)) {
      anchors.add(match[0].replace(/\s+/gu, ''));
    }
  }
  // 具名奖项/等级：条款原文里的「XX杯/XX奖/XX星」锚点（「级」后缀过宽不取，靠 coreTerms/数字锚点覆盖）；
  // 正则贪婪会吞入前导动词（"确保黄山杯"），stripAwardLeadVerb 循环剥离保证与 coreTerms 口径一致
  for (const match of text.matchAll(/[\u4e00-\u9fa5]{2,6}[杯奖星]/gu)) {
    const award = stripAwardLeadVerb(match[0]);
    if (/^[\u4e00-\u9fa5]{2,7}$/u.test(award)) anchors.add(award);
  }
  const hit: string[] = [];
  const missing: string[] = [];
  for (const anchor of anchors) {
    (anchorHit(anchor, normalizedMarkdown) ? hit : missing).push(anchor);
  }
  return { total: anchors.size, hit, missing };
}

/**
 * 条款原文分句兜底（B 闭环终收尾 4.27.1）：锚点判定用 coreTerms（LLM 概括短语）与正文抄写句
 * （「按招标文件要求：<条款原文>」）存在词面错位——分句兜底：条款去括号举例后按标点切分为实质分句
 * （≥6 字符），全部分句字面落位正文 = 原文抄写 = 完全响应。防误放行：全部分句命中才放行。
 */
function clauseSegmentCoverage(text: string, normalizedMarkdown: string): { total: number; missing: string[] } {
  const withoutParenthetical = text.replace(/（[^）]*）|\([^)]*\)/gu, '');
  const segments = withoutParenthetical
    .split(/[，。；、,;\n]/u)
    .map(segment => segment.replace(/[「」“”"'`\s]/gu, '').trim())
    .filter(segment => segment.length >= 6);
  const missing = segments.filter(segment => !normalizedMarkdown.includes(segment));
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
    .replace(/[☑☐☒√✓✔×✗■●◼⊠]\s*/gu, '')
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
function clauseSatisfied(item: { text: string; coreTerms: string[] }, normalizedMarkdown: string): boolean {
  const coverage = requirementAnchorCoverage(item, normalizedMarkdown);
  if (coverage.total > 0 && coverage.missing.length === 0) return true;
  const segmentCoverage = clauseSegmentCoverage(item.text, normalizedMarkdown);
  if (segmentCoverage.total > 0 && segmentCoverage.missing.length === 0) return true;
  const voiceCoverage = clauseSegmentCoverage(bidderVoiceClauseText(item.text), normalizedMarkdown);
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
  const normalized = markdown.replace(/\s+/gu, '');
  return entries.map(entry => {
    const coverage = requirementAnchorCoverage(entry, normalized);
    return { entry, hit: coverage.hit, missing: coverage.missing, satisfied: clauseSatisfied(entry, normalized) };
  });
}

// 商务域条款排除词表（4.40.0 零商务句根治，取代旧「定性响应句」通道）：丰乐镇与舒城实测均出现
// 商务条款原文/商务声明句被写入技术标正文——商务与造价条款（金额/利率/时限/计价规则）在判定层
// 即排除出要求池，技术标正文既不定性声明也不落商务参数，响应由商务标承接。
const COMMERCIAL_SCOPE_RE = /履约保证金|质量保证金|保证金账户|中标金额|进度款|工程款|付款|结清|结算|违约金|贷款市场报价利率|LPR|最高投标限价|工程结算价款|预付款|支付担保|保函|暂列金额|暂估价|结算核减|造价咨询费|工程量.*异议|增值税|异地纳税人|报价明细|综合单价|清单合价|预留金|投标报价|异常低价|评标基准价|总价包干|总价合同|调差|可调整价差/u;

function isCommercialScopeClause(text: string) {
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
  const normalized = markdown.replace(/\s+/gu, '');
  // 六项词面兜底：「扬尘治理六个百分百」体系基准条款语义稀释误报——正文已逐项落位六项措施词面
  // （100%围挡/覆盖/冲洗/硬化/密闭运输）时判响应，与 sixHundredPercentCoverageIssues 词面兜底同源。
  const DUST_SIX_LEXICAL: Array<RegExp> = [
    /100%围挡|周边100%围挡/u,
    /物料堆放100%覆盖|物料堆放.{0,8}覆盖|密目网.*覆盖|覆盖.{0,4}密目网/u,
    /出入车辆100%冲洗|车辆.{0,10}冲洗|冲洗.{0,10}车辆|冲洗点/u,
    /施工现场地面100%硬化|地面100%硬化/u,
    /拆迁工地100%湿法作业|拆迁.{0,10}湿法作业|湿法作业.{0,10}拆迁|无拆迁|不涉及拆迁/u,
    /渣土车辆100%密闭运输|密闭运输|密闭式/u,
  ];
  const dustSixLexicalHitCount = () => DUST_SIX_LEXICAL.filter(re => re.test(markdown)).length;
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
    if (bestSimilarity >= 0.6) {
      // 语义命中仅证明主题已响应；条款内金额参数仍须逐锚点字面落位（「支付300万元」零落位静默漏检）
      const moneyAnchors = new Set<string>();
      for (const moneyMatch of entry.text.matchAll(/(?:\d+(?:\.\d+)?\s*(?:万元|亿元|元))/giu)) moneyAnchors.add(moneyMatch[0].replace(/\s+/gu, ''));
      if (moneyAnchors.size > 0) {
        const missingMoney = [...moneyAnchors].filter(anchor => !normalized.includes(anchor));
        if (missingMoney.length > 0) {
          const coverage = requirementAnchorCoverage(entry, normalized);
          partialResponseCandidates.push({ item: entry, kind, bestSimilarity, hit: coverage.hit, missing: coverage.missing });
          continue;
        }
      }
      continue;
    }
    // 字面锚点兜底升级 + 分句兜底 + voice 通道：共享谓词 clauseSatisfied——三通道任一完全命中即已响应
    if (clauseSatisfied(entry, normalized)) continue;
    const coverage = requirementAnchorCoverage(entry, normalized);
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
      issues.push({
        level: 'error',
        severity: 'blocker',
        category: 'structure',
        owner: 'llm',
        repairability: 'llm_repairable',
        message: `招标要求部分响应：${candidate.kind}“${candidate.item.text}”已命中“${candidate.hit.join('、')}”，但缺少“${candidate.missing.join('、')}”（最佳语义相似度 ${candidate.bestSimilarity.toFixed(2)}）`,
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
