import { buildSemanticSimilarity, SEMANTIC_COVERAGE_THRESHOLD } from './semanticSimilarity';
import { evaluationCriteriaCoreKeywords } from './qualityValidation';
import { narrativeSentences } from './narrativeContext';
import { splitScoringBlocks, splitScoringSections } from './tenderBidScoring';

/**
 * 评分细则映射层（C0-3）：招标评分表逐条 → 检测目标映射，输出专家视角模拟分。
 * 三态判定（与 C0-1 内容级口径同源）：
 * - met：正文内容级响应——评分项与「实质正文窗口」判定单元语义 ≥0.6（标题词不参与命中文本），
 *   或核心关键词落位叙述句；
 * - partial：仅标题承接——评分项与小节标题（含空壳小节）语义 ≥0.6 但无内容级响应；
 * - missing：标题与正文均无匹配。
 * simulatedScore=(met+0.5×partial)/total×100——把「评审人会怎么给分」显性化，
 * 与六维主尺并列展示（从属口径，scoringCalibration 标注关系），供专家复核与交付沟通。
 * 通用性：判定完全由招标评分条目文本驱动，无项目专属词表；条目为空时审计为 null 不输出。
 */

export interface EvaluationCriteriaAttainment {
  index: number;
  title: string;
  status: 'met' | 'partial' | 'missing';
  /** 最高语义相似度（met/partial 的命中证据；missing 为全局最高观测值） */
  similarity: number;
  /** 命中锚点（met=命中正文窗口首行；partial=承接标题；missing 缺省） */
  anchor?: string;
}

export interface EvaluationCriteriaAttainmentAudit {
  total: number;
  met: number;
  partial: number;
  missing: number;
  /** 专家视角模拟分（0..100） */
  simulatedScore: number;
  criteria: EvaluationCriteriaAttainment[];
}

export async function buildEvaluationCriteriaAttainmentAudit(input: {
  items: string[];
  markdown: string;
  /** 单测注入的嵌入实现（替代本地模型），生产环境不传 */
  embedDocuments?: (texts: string[]) => Promise<number[][]>;
}): Promise<EvaluationCriteriaAttainmentAudit> {
  const items = input.items.map(item => item.trim()).filter(Boolean);
  if (items.length === 0) {
    return { total: 0, met: 0, partial: 0, missing: 0, simulatedScore: 0, criteria: [] };
  }
  const units = splitScoringBlocks(input.markdown);
  const sections = splitScoringSections(input.markdown);
  // 承接面池 = 全部小节标题行（含空壳小节——标题承接 partial 的判定基准，与评审人按标题查阅一致）
  const headings = sections.map(section => section.heading).filter(Boolean);
  const narrativeText = narrativeSentences(input.markdown).join('');
  const similarity = await buildSemanticSimilarity([...units, ...headings], items, input.embedDocuments);

  const criteria: EvaluationCriteriaAttainment[] = items.map((item, index) => {
    const keywords = evaluationCriteriaCoreKeywords(item);
    const keywordHit = keywords.length > 0 && keywords.some(keyword => narrativeText.includes(keyword));
    let bestUnit = '';
    let bestUnitSimilarity = 0;
    for (const unit of units) {
      const value = similarity(unit, item);
      if (value > bestUnitSimilarity) {
        bestUnitSimilarity = value;
        bestUnit = unit;
      }
    }
    if (keywordHit || bestUnitSimilarity >= SEMANTIC_COVERAGE_THRESHOLD) {
      return {
        index,
        title: item,
        status: 'met',
        similarity: bestUnitSimilarity,
        anchor: bestUnit ? bestUnit.split('\n')[0].replace(/^#{1,6}\s+/u, '').slice(0, 80) : undefined,
      };
    }
    let bestHeading = '';
    let bestHeadingSimilarity = 0;
    for (const heading of headings) {
      const value = similarity(heading, item);
      if (value > bestHeadingSimilarity) {
        bestHeadingSimilarity = value;
        bestHeading = heading;
      }
    }
    if (bestHeadingSimilarity >= SEMANTIC_COVERAGE_THRESHOLD) {
      return {
        index,
        title: item,
        status: 'partial',
        similarity: bestHeadingSimilarity,
        anchor: bestHeading.replace(/^#{1,6}\s+/u, '').slice(0, 80),
      };
    }
    return { index, title: item, status: 'missing', similarity: bestHeadingSimilarity };
  });

  const met = criteria.filter(entry => entry.status === 'met').length;
  const partial = criteria.filter(entry => entry.status === 'partial').length;
  const missing = criteria.filter(entry => entry.status === 'missing').length;
  const simulatedScore = Math.round(((met + 0.5 * partial) / criteria.length) * 100);
  return { total: criteria.length, met, partial, missing, simulatedScore, criteria };
}
