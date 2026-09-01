import { callDocumentLlmJson } from './llmClient';
import type { DocumentGenerationDiagnostics } from './types';
import type { TenderBidTemplatingReport } from './tenderBidScoring';
import { fourNewTechCheck } from './tenderBidChecks';
import { docSystemPrefix } from './markdownComposer';

/**
 * A2 Reviewer 语义级复核（对标 docx 判定标尺中确定性正则无法覆盖的语义级判定）：
 * 重难点三级判定（识别精准性→归因合理性→对策匹配度）、四新升级价值语义判断、
 * 术语等效性（完全匹配/等效匹配/不匹配，禁双重标准）。
 *
 * 设计边界：
 * - 只在 A1 确定性检测命中风险信号时触发（重度模板化/模糊应答词/四新无效），避免无风险文档的额外 LLM 成本；
 * - 只产出改进建议（info 级），不阻断交付：语义判断存在模型方差，阻断权留给确定性门禁；
 * - LLM 失败静默降级返回空列表，不得阻塞生成。
 */

export interface TemplatingReviewResult {
  /** 语义级复核发现的改进建议（含定位信息） */
  issues: string[];
  /** 是否实际执行了 LLM 复核（未触发或失败时为 false） */
  reviewed: boolean;
}

/** A1 报告是否命中需要 LLM 语义复核的风险信号 */
export function templatingNeedsSemanticReview(report: TenderBidTemplatingReport): boolean {
  return report.level === 'heavy'
    || report.vagueHitCount > 0
    || report.difficultyHeavyTemplated;
}

const TEMPLATING_REVIEW_SYSTEM = [
  '你是招标技术标评审专家。对施工组织设计做语义级复核，只报告确定性规则覆盖不到的语义问题。',
  '复核维度（按《施工组织设计全维度校验提示词》判定标尺）：',
  '1. 重难点三级判定：识别精准性（是否点明本项目真实难点而非泛泛而谈）→ 归因合理性（是否说明难点成因/风险来源）→ 对策匹配度（对策是否针对该难点的成因，而非通用措施堆砌）；',
  '2. 术语等效性：同一对象是否前后术语一致（如"砼"与"混凝土"混用需统一），是否出现词面不同但概念等效的双重标准表述；',
  '3. 四新技术升级价值：若正文声称采用四新技术，其价值表述是否停留在"提升效率"式套话，缺少可对标官方推广目录或替代落后工艺的实质说明。',
  '每条问题必须包含：问题所在内容简述+判定依据（对应上面哪条维度）+一句话改进建议。',
  '只报告真实存在的问题，正文无问题时返回空数组；不得编造问题。只返回 JSON。',
].join('\n');

/** 重难点章节 + 代表性正文摘要（控制 LLM 上下文成本，只送信号命中的部分） */
function reviewExcerpt(markdown: string, maxChars = 6000): string {
  const difficultySection = markdown.match(/#{2,3}\s*[^\n]*(?:重难点|重点难点|工程难点|难点分析)[^\n]*\n[\s\S]{0,3500}/u)?.[0] || '';
  const body = markdown.replace(/#{1,6}\s+[^\n]*\n/gu, '').replace(/\s+/gu, ' ').slice(0, maxChars);
  return [difficultySection, body].filter(Boolean).join('\n\n').slice(0, maxChars + 4000);
}

/** 语义级模板化复核：仅在风险信号命中时调用 LLM，产出改进建议（不阻断） */
export async function reviewTemplatingSemantics(input: {
  templating: TenderBidTemplatingReport;
  markdown: string;
  diagnostics: DocumentGenerationDiagnostics;
  signal?: AbortSignal;
}): Promise<TemplatingReviewResult> {
  if (!templatingNeedsSemanticReview(input.templating)) return { issues: [], reviewed: false };
  const fourNew = fourNewTechCheck(input.markdown);
  const contextLines = [
    `确定性检测信号：模板化等级=${input.templating.level}，套话句占比=${(input.templating.fillerRatio * 100).toFixed(1)}%，模糊应答词命中=${input.templating.vagueHitCount}（${input.templating.vaguePhrases.join('、') || '无'}），重难点归因＋量化双达标占比=${(input.templating.difficultyCountermeasureRatio * 100).toFixed(0)}%，跨项目残留=${input.templating.crossProjectResidue.join('、') || '无'}${fourNew.found.length ? `，四新技术命中=${fourNew.found.join('、')}` : ''}`,
    `待复核正文（节选）：\n${reviewExcerpt(input.markdown)}`,
    '返回 JSON：{"issues":["问题1","问题2"]}',
  ];
  try {
    const result = await callDocumentLlmJson<{ issues?: string[] }>(docSystemPrefix(TEMPLATING_REVIEW_SYSTEM), contextLines.join('\n\n'), {
      maxTokens: 1200,
      temperature: 0.1,
      signal: input.signal,
      diagnostics: input.diagnostics,
      taskKind: 'structuredGeneration',
    });
    const issues = Array.isArray(result?.issues) ? result.issues.filter(issue => typeof issue === 'string' && issue.length > 0).slice(0, 6) : [];
    return { issues, reviewed: true };
  } catch {
    return { issues: [], reviewed: false };
  }
}
