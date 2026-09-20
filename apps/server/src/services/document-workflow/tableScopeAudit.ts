import { callDocumentLlmJson } from './llmClient';
import { docSystemPrefix } from './markdownComposer';
import { normalizePlannedSectionTitle } from './outline';
import { sectionTitleEquivalent } from './promptRuleExtraction';

/**
 * R20 C4 规划污染过滤：LLM 小节规划可能把资料中"非本标段范围"的内容规划成表格
 * （典型来源：图纸设计说明通用条款、其他专业工程的历史资料条款，被放大为他专业知识领域的表，
 * 如市政/园林标段出现房建装饰类实体表）。该类表正文不会写出（写出即超范围内容），
 * 但对账会判"丢失"→ 虚假缺失扣分，且补表轮可能被驱动去补写超范围内容——必须在表格计划构建前剔除。
 *
 * 判定机制（产品级通用，零项目硬编码）：单次 LLM 范围核对，判据 = 招标要求摘要
 * （tenderRequirementsSummary）+ 工程量清单分部分项全景（formatBoqDivisionCoverage）——
 * 均为运行时数据，任何工程项目取自身权威范围表述；确定性校验防幻觉（表名必须匹配现有规划表、
 * 剔除超上限整体放弃、调用失败保留现状不阻断生成）。
 */

/** 范围核对的规划表条目（扁平化：章标题 + 表名 + 表头字段） */
export interface PlannedTableScopeEntry {
  chapterTitle: string;
  title: string;
  fields: string[];
}

/** 超范围剔除项（含理由，供进度消息审计） */
export interface OutOfScopeTablePlan {
  chapterTitle: string;
  title: string;
  reason: string;
}

/** 剔除上限比例（安全阀）：单次核对剔除数超过规划表总数该比例视为异常误判，整体放弃不剔除 */
const MAX_SCOPE_REMOVAL_RATIO = 1 / 3;

/** 恒定 system 前缀（A5a 模式：跨生成共享 prefix cache，可变输入全部在 user 消息） */
const TABLE_SCOPE_AUDIT_SYSTEM = [
  '你是施工组织设计表格规划范围审查专家。输入本标段招标范围判据与各章规划表格清单，逐表判断该表是否超出本标段工程范围。',
  '判定规则：',
  '1. 仅“表名实体未在判据中逐字出现”不得作为剔除依据——先做语义关联检索：表名实体与判据中的具体材料、工艺或部位是否构成上位/下位、同义或配套关系（如「外装饰材料」与判据中「真石漆/涂饰/面砖/彩绘」类具体饰面材料、附属用房的装饰与修缮类工程），存在任一关联即视为在范围内；',
  '2. 剔除需同时满足：①表名实体在招标要求与工程量清单中均无任何对应（含语义关联对应）；②按表名判断该实体明显属于与本标段工程类型不同的其他专业工程领域（如乡村基础设施标段出现高层建筑主体结构、大型工业设备安装类实体；配套附属用房的室内外装饰、局部修缮类工程不得视为不同领域）；③剔除不影响本标段工程内容的完整性；',
  '3. 标书惯例类表格（项目信息、管理措施、机构职责、制度流程、进度节点、检查记录、材料/设备报审与检验记录、汇总统计等不指向特定工程实体的表）一律保留，不得剔除；',
  '4. 判断不确定时保留（本审查宁保留不误剔）。',
  '只返回 JSON，不要返回 markdown。',
].join('\n\n');

/** 理由清洗：去空白截断（进度消息单行展示） */
function cleanReason(reason: unknown) {
  const text = String(reason || '').replace(/\s+/gu, ' ').trim();
  return text.slice(0, 40);
}

/**
 * 规划表范围核对（一次全局轻量 LLM 调用）：输入 = 规划表清单 + 招标要求摘要 + 清单分部全景，
 * 输出 = 确定性校验后的超范围剔除项。无判据/无规划表/调用失败均返回空剔除
 * （skipped 标注原因，调用方保持现状不阻断生成）。
 */
export async function auditPlannedTableScope(input: {
  /** 各章规划表（扁平） */
  tables: PlannedTableScopeEntry[];
  /** 招标要求摘要（tenderRequirementsSummary；范围条款判据） */
  requirementSummary: string[];
  /** 工程量清单分部分项全景（formatBoqDivisionCoverage；工程实体枚举判据） */
  boqCoverageSummary?: string;
  /** 文档模板名（上下文，可选） */
  templateName?: string;
  signal?: AbortSignal;
}): Promise<{ removed: OutOfScopeTablePlan[]; skipped?: string }> {
  const tables = input.tables.filter(entry => entry.title.trim());
  if (tables.length === 0) return { removed: [], skipped: '无规划表' };
  const hasCriteria = input.requirementSummary.length > 0 || Boolean(input.boqCoverageSummary?.trim());
  if (!hasCriteria) return { removed: [], skipped: '无范围判据（招标要求摘要与清单全景均为空）' };
  const tableLines = (() => {
    const byChapter = new Map<string, PlannedTableScopeEntry[]>();
    for (const entry of tables) {
      const list = byChapter.get(entry.chapterTitle) || [];
      list.push(entry);
      byChapter.set(entry.chapterTitle, list);
    }
    return [...byChapter.entries()]
      .map(([chapterTitle, entries]) => `【${chapterTitle}】\n${entries.map(entry => `- ${entry.title}${entry.fields.length ? `（字段：${entry.fields.join('、')}）` : ''}`).join('\n')}`)
      .join('\n\n');
  })();
  const result = await callDocumentLlmJson<{ outOfScope?: Array<{ chapterTitle?: string; title?: string; reason?: string }> }>(
    docSystemPrefix(TABLE_SCOPE_AUDIT_SYSTEM),
    [
      input.templateName ? `文档模板：${input.templateName}` : '',
      input.requirementSummary.length ? `本标段招标范围判据（招标要求摘要）：\n${input.requirementSummary.map(item => `- ${item}`).join('\n')}` : '',
      input.boqCoverageSummary?.trim() ? `本标段工程量清单分部分项全景：\n${input.boqCoverageSummary.trim()}` : '',
      `各章规划表格清单：\n${tableLines}`,
      '请将“专业领域明显不符本标段工程类型”的表格列入 outOfScope（title 必须与上方表名逐字一致）；剔除前先逐一做语义关联检索（上下位/同义/配套的材料与工艺），能关联到判据中任一条目的表不得剔除；全部属于本标段范围时输出空数组。',
      'JSON 格式：{"outOfScope":[{"chapterTitle":"所属章标题","title":"表名","reason":"不超过30字理由"}]}',
    ].filter(Boolean).join('\n\n'),
    { maxTokens: 1000, temperature: 0, signal: input.signal },
  );
  if (!result) return { removed: [], skipped: 'LLM 调用失败（保留原规划）' };
  // 确定性校验（防幻觉）：表名必须匹配现有规划表（归一相等优先，标题等价兜底）——匹配不到忽略
  const removed: OutOfScopeTablePlan[] = [];
  for (const raw of result.outOfScope || []) {
    const rawTitle = normalizePlannedSectionTitle(String(raw?.title || ''));
    if (!rawTitle) continue;
    const hit = tables.find(entry => normalizePlannedSectionTitle(entry.title) === rawTitle)
      || tables.find(entry => sectionTitleEquivalent(entry.title, rawTitle));
    if (!hit) continue;
    if (removed.some(item => item.chapterTitle === hit.chapterTitle && item.title === hit.title)) continue;
    removed.push({ chapterTitle: hit.chapterTitle, title: hit.title, reason: cleanReason(raw?.reason) || '判为超范围' });
  }
  // 安全阀：剔除数超过总数 1/3 视为异常误判，整体放弃（宁可保留不可批量误剔）
  const removalCap = Math.max(1, Math.floor(tables.length * MAX_SCOPE_REMOVAL_RATIO));
  if (removed.length > removalCap) {
    return { removed: [], skipped: `超范围剔除 ${removed.length}/${tables.length} 项超过 1/3 上限（疑似误判），整体放弃以保安全` };
  }
  return { removed };
}
