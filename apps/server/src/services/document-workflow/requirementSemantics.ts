/**
 * requirementSemantics：用户提示词语义解析——「提示词 → 结构化执行计划」第二通道。
 *
 * 背景（提示词作用小的根因治理）：buildRuntimePromptRules 纯正则抽取只能捕获表格/关键词/禁词/
 * 封面目录/字数/固定章节等表层硬规则，用户的语义性要求（"每条重难点必须给出归因"、"清单规格
 * 拆分必须逐项照抄"、"正文要求表格化"）没有解析通道；requirement 全文虽注入写作 prompt，
 * 但被几十倍系统指令稀释，且蓝图构建/Planner/检索三条链路完全不消费 requirement。
 *
 * 本模块用一次 LLM 语义解析（temperature 0）把用户提示词翻译为三张结构化清单：
 * - globalRequirements / chapterRequirements：可逐条核验的强制要求（供写作注入 + 生成后核验闭环）
 * - factClues：用户显式给出的项目专属事实线索（供检索查询构造 + 事实核对）
 * - styleRequirements：风格与格式要求（供写作注入）
 * 解析失败静默降级为空计划（不阻断生成主链路）。
 */
import type { DocumentGenerationDiagnostics } from './types';
import { callDocumentLlmJson } from './llmClient';
import { docSystemPrefix } from './markdownComposer';

export interface RequirementSemanticPlan {
  parsed: boolean;
  /** 全文级强制要求（不归属特定章节），逐条短句 */
  globalRequirements: string[];
  /** 章节级强制要求（归属到模板章节，章节名必须与模板一致） */
  chapterRequirements: Array<{ chapterTitle: string; requirements: string[] }>;
  /** 事实线索：用户提示词中显式给出的含数值/规格/标准/日期/地点/规模的项目专属事实短句 */
  factClues: string[];
  /** 风格与格式要求 */
  styleRequirements: string[];
  /** 最高优先级注入块：写作时必须逐条满足的强制要求（含优先级语义） */
  mandatoryBlockText: string;
  /** 解析摘要（进度展示用） */
  summary: string;
}

export function emptyRequirementSemanticPlan(): RequirementSemanticPlan {
  return { parsed: false, globalRequirements: [], chapterRequirements: [], factClues: [], styleRequirements: [], mandatoryBlockText: '', summary: '' };
}

const REQUIREMENT_SEMANTICS_SYSTEM = [
  docSystemPrefix('你是用户生成要求的语义解析专家。'),
  '把用户的生成提示词完整解析为可逐条核验的结构化要求清单，不得遗漏用户的任何实质要求；不得把通用客套话（如"请帮我生成""谢谢"）当作要求。',
  '要求必须逐条短句（每条 ≤60 字）、可核验（生成后能判断是否满足）；一条要求只写一件事，复合要求必须拆分。',
  'globalRequirements：全文级强制要求——写作内容、深度、覆盖面、表格、量化要求等不限定具体章节的要求；若要求明确指向某个章节，必须放入 chapterRequirements 而不是 globalRequirements。',
  'chapterRequirements：章节级要求——chapterTitle 必须原样取自给定的章节列表，不得编造不存在的章节名；同一章节的多条要求合并为一条记录。',
  'factClues：用户提示词中显式给出的项目专属事实线索——含数值、单位、规格、型号、标准编号、日期、地点、规模、金额、目标的短句（如"一般路灯 100W 109套、120W 9套""计划工期 365 日历天""开挖深度 5.2m"）；要求类语句（"必须写X"）不算事实线索；线索必须原样保留数值与表述，不得改写或换算。',
  'styleRequirements：写作风格与格式要求（语气、详略、表格偏好、禁止风格等），最多 8 条。',
  '只返回 JSON。',
].join('\n');

function cleanItem(value: unknown, maxLength: number): string {
  const text = String(value || '').trim().replace(/^\d+[.、)）]\s*/u, '');
  if (!text || text.length > maxLength) return '';
  return text;
}

/** 一次 LLM 调用解析用户提示词 → 结构化执行计划；失败/空要求静默降级为空计划 */
export async function parseRequirementSemantics(input: {
  requirement?: string;
  chapterTitles: string[];
  signal?: AbortSignal;
  diagnostics?: DocumentGenerationDiagnostics;
}): Promise<RequirementSemanticPlan> {
  const requirement = (input.requirement || '').trim();
  const chapterTitles = (input.chapterTitles || []).filter(Boolean);
  const empty = emptyRequirementSemanticPlan();
  if (!requirement || requirement.length < 4) return empty;
  // 纯简短指令（如"生成一份施工组织设计"）无可解析的实质要求，跳过 LLM 调用
  if (requirement.length <= 40 && !/[：:]|\n/u.test(requirement)) return empty;
  try {
    const result = await callDocumentLlmJson<{
      globalRequirements?: Array<string | { text?: string }>;
      chapterRequirements?: Array<{ chapterTitle?: string; requirements?: Array<string | { text?: string }> }>;
      factClues?: Array<string | { text?: string }>;
      styleRequirements?: Array<string | { text?: string }>;
    }>(REQUIREMENT_SEMANTICS_SYSTEM, [
      `章节列表（chapterRequirements 的 chapterTitle 必须原样取自以下列表）：${chapterTitles.join('、') || '（无）'}`,
      `用户要求全文：\n${requirement}`,
      '返回 JSON：{"globalRequirements":["要求1"],"chapterRequirements":[{"chapterTitle":"章标题","requirements":["要求1"]}],"factClues":["事实线索1"],"styleRequirements":["风格要求1"]}',
    ].join('\n\n'), { maxTokens: 3000, temperature: 0, signal: input.signal, diagnostics: input.diagnostics, prefixKey: 'requirement-semantics' });
    const globalRequirements = [...new Set((result?.globalRequirements || []).map(item => cleanItem(typeof item === 'string' ? item : item?.text, 60)).filter(Boolean))].slice(0, 24);
    const factClues = [...new Set((result?.factClues || []).map(item => cleanItem(typeof item === 'string' ? item : item?.text, 120)).filter(Boolean))].slice(0, 24);
    const styleRequirements = [...new Set((result?.styleRequirements || []).map(item => cleanItem(typeof item === 'string' ? item : item?.text, 60)).filter(Boolean))].slice(0, 8);
    const chapterRequirements = (result?.chapterRequirements || [])
      .map(item => ({
        chapterTitle: cleanItem(item?.chapterTitle, 60),
        requirements: [...new Set((item?.requirements || []).map(entry => cleanItem(typeof entry === 'string' ? entry : entry?.text, 60)).filter(Boolean))].slice(0, 12),
      }))
      .filter(item => chapterTitles.length === 0 || chapterTitles.some(title => title === item.chapterTitle || item.chapterTitle.includes(title) || title.includes(item.chapterTitle)))
      .filter(item => item.chapterTitle && item.requirements.length > 0)
      .slice(0, 16);
    const hasContent = globalRequirements.length > 0 || chapterRequirements.length > 0 || factClues.length > 0;
    if (!hasContent) return empty;
    // 强制块预算封顶（global > 章节 > 风格）：防止超长提示词解析出巨量要求撑爆注入段与运行时规则文本
    const MANDATORY_BLOCK_CAP = 3000;
    const allRequirements = [...globalRequirements, ...chapterRequirements.flatMap(item => item.requirements), ...styleRequirements];
    const cappedRequirements: string[] = [];
    let blockChars = 0;
    for (const item of allRequirements) {
      if (blockChars + item.length + 8 > MANDATORY_BLOCK_CAP) break;
      cappedRequirements.push(item);
      blockChars += item.length + 8;
    }
    const mandatoryBlockText = cappedRequirements.length > 0
      ? [
        '【用户强制要求——最高优先级，必须逐条满足；用户要求与系统默认规则冲突时，以用户要求为准】',
        ...cappedRequirements.map((item, index) => `${index + 1}. ${item}`),
        '以上要求来自用户提示词语义解析，生成、检查和修复必须共同遵守。',
      ].join('\n')
      : '';
    return {
      parsed: true,
      globalRequirements,
      chapterRequirements,
      factClues,
      styleRequirements,
      mandatoryBlockText,
      summary: `用户要求解析：全文级 ${globalRequirements.length} 条、章节级 ${chapterRequirements.length} 组、事实线索 ${factClues.length} 条、风格 ${styleRequirements.length} 条`,
    };
  } catch (error) {
    console.error(`[requirementSemantics] 用户提示词语义解析失败（降级为无结构化要求）：${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }
}
