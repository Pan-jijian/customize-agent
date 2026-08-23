import type { DocumentEvidence, DocumentTemplateChapter } from './types';
import { cleanEvidenceText } from './evidence';
import { removeUnwantedDrawingImages, sanitizeFormalMarkdown } from './markdownComposer';

function isGenericFillerSentence(sentence: string) {
  return /^(?:本节围绕|本小节依据|项目实施时应|实施过程中应|当前绑定资料|当前项目绑定资料)/u.test(sentence)
    || /确保各项措施与本工程实施条件相匹配/u.test(sentence)
    || /形成责任明确、过程可控、资料完整的管理闭环/u.test(sentence)
    || /确保现场管理要求与施工进度、资源组织和验收节点同步推进/u.test(sentence)
    || /^管理闭环[。；;]?$/u.test(sentence);
}

function isNonConstructionEvidenceSentence(sentence: string) {
  return /资料参数行摘要|房建市政施工评定分离招标示范文本|我方已仔细研究|中标通知书|签订合同|履约保证金|投标函|投标人须知|招标公告|开标|评标|保证金|电子交易系统|公共资源交易|监管部门|专用账户监管协议书|资金托管专用账号/u.test(sentence)
    || /^#+\s*/u.test(sentence)
    || /^（?\d+）/u.test(sentence);
}

function evidenceSentencesForSection(sectionTitle: string, chapter: DocumentTemplateChapter, evidence: DocumentEvidence[]) {
  const sectionTokens = [sectionTitle, chapter.title, ...sectionTitle.split(/[、，,；;\s]+/u)].filter(token => token.length >= 2);
  const scored = evidence.map(item => {
    const content = cleanEvidenceText(item.content || '').replace(/\s+/gu, ' ').trim();
    const score = sectionTokens.reduce((sum, token) => sum + (content.includes(token) || (item.sectionTitle || '').includes(token) ? 1 : 0), 0) + item.score;
    return { content, score };
  }).filter(item => item.content.length >= 30).sort((a, b) => b.score - a.score);
  const sentences: string[] = [];
  for (const entry of scored.slice(0, 8)) {
    for (const sentence of entry.content.split(/[。；;\n]/u).map(part => part.trim()).filter(Boolean)) {
      if (sentence.length < 18 || sentence.length > 180) continue;
      if (/报价|单价|税率|利润|后台|知识库|提示词|OCR|文件路径/u.test(sentence)) continue;
      if (isGenericFillerSentence(sentence) || isNonConstructionEvidenceSentence(sentence)) continue;
      if (!sentences.some(existing => existing.includes(sentence) || sentence.includes(existing))) sentences.push(sentence);
      if (sentences.length >= 10) break;
    }
    if (sentences.length >= 10) break;
  }
  return sentences;
}

// P1-6 死代码清理后仅保留此导出：P0-2 确定性兜底改造的骨架生成器，
// 由 documentGenerator 在 LLM 全故障时调用（输出带 [EVIDENCE_SKELETON] 标记并被 Review 门禁阻断）。
// 旧扩写链路（expandChapterContent/expandChapterToTarget/supplementShortSections/replaceSectionContent/mergeSectionSupplementBody）已废弃删除。
export function buildEvidenceOnlyChapterContent(input: { chapter: DocumentTemplateChapter; evidence: DocumentEvidence[]; targetWords: number; forbidDrawingImages: boolean }) {
  const sections = input.chapter.sections?.length ? input.chapter.sections : ['资料依据与施工对象', '主要控制措施', '检查验收与闭环管理'];
  const parts = sections.flatMap(sectionTitle => {
    const facts = evidenceSentencesForSection(sectionTitle, input.chapter, input.evidence).slice(0, 8);
    if (facts.length === 0) return [];
    return [[`### ${sectionTitle}`, '', ...facts.map(fact => `- ${fact}。`)].join('\n')];
  });
  if (parts.length === 0) return '';
  return sanitizeFormalMarkdown(removeUnwantedDrawingImages(`## ${input.chapter.title}\n\n${parts.join('\n\n')}`, input.forbidDrawingImages));
}
