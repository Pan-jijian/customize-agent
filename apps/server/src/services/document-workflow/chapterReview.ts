import type { ChapterReviewSummary, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from './types';
import { callDocumentLlm, callDocumentLlmJson, contextLayerChars } from './llmClient';
import { displayStage } from './progress';
import { throwIfAborted } from './utils';
import { buildSectionFactCard, evidenceForSection, sectionFactUsageIssue } from './chapterGeneration';
import { extractGeneratedSections, docSystemPrefix } from './markdownComposer';

export async function chapterSectionFactUsageIssues(input: { chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[] }, embedDocuments?: (texts: string[]) => Promise<number[][]>): Promise<string[]> {
  // 结构口径：按最终 markdown 中实际存在的 ### 小节标题检查，模板细目只作为写作清单。
  // 主题块规划会把模板细目语义合并成更少的主题块，被合并的细目不会以独立 ### 小节
  // 出现在最终目录中；若仍按模板细目逐条正则匹配，只会反复报“小节正文过短”触发
  // 永不收敛的修复循环。正文块截止到下一个 ##/### 标题，#### 三级小节计入所属 ### 正文。
  const headings = extractGeneratedSections(input.content);
  if (headings.length === 0) return [];
  const issues: string[] = [];
  for (const title of headings) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = input.content.match(new RegExp(`^###\\s+(?:\\d+(?:\\.\\d+)*[、.．\\s]*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{2,3}\\s+|$)`, 'mu'));
    const body = match?.[1] || '';
    const factCard = await buildSectionFactCard(title, evidenceForSection(title, input.chapter, input.evidence), embedDocuments);
    const issue = sectionFactUsageIssue(title, body, factCard);
    if (issue) issues.push(`${title}：${issue}`);
  }
  return issues;
}





/** 对生成的 Markdown 进行非重写式审查，只产出质量状态，不接管正文。 */


function splitTextForReview(text: string, chunkChars: number) {
  const normalized = text.trim(); if (!normalized) return [];
  const size = Math.max(1000, Math.ceil(chunkChars)); const chunks: string[] = []; let start = 0;
  while (start < normalized.length) { const end = Math.min(start + size, normalized.length); let cut = normalized.lastIndexOf('\n\n', end); if (cut <= start || end - cut > size * 0.25) { cut = normalized.lastIndexOf('\n', end); } if (cut <= start || end - cut > size * 0.2) { cut = end; } chunks.push(normalized.slice(start, cut).trim()); start = cut; }
  return chunks.filter(Boolean);
}
export function chunkTextForReview(text: string, chunkChars: number) { return splitTextForReview(text, chunkChars).map((chunk, index) => `**第 ${index + 1}/${splitTextForReview(text, chunkChars).length} 部分**\n\n${chunk}`); }
function reviewItemToString(item: unknown) { return typeof item === 'string' ? item : (item && typeof item === 'object' && 'message' in (item as Record<string,unknown>) ? String((item as Record<string,unknown>).message) : JSON.stringify(item)); }
function mergeUniqueStrings(items: unknown[]) { return [...new Set(items.map(reviewItemToString).filter(Boolean))]; }
function envPositiveInt(name: string) { const v = Number(process.env[name]); return Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0; }
function adaptiveReviewPlan(input: { totalChars: number; chapterCount: number; chunkChars: number; phase: string }) {
  const baseChunks = Math.ceil(input.totalChars / Math.max(1000, input.chunkChars));
  const chunks = input.phase === 'chapter' ? envPositiveInt('DOCUMENT_CHAPTER_REVIEW_MAX_CHUNKS') || Math.min(Math.max(2, Math.floor(input.totalChars / input.chapterCount / 4000)), baseChunks) : input.phase === 'global' ? envPositiveInt('DOCUMENT_GLOBAL_REVIEW_MAX_CHUNKS') || Math.min(4, baseChunks) : envPositiveInt('DOCUMENT_FINAL_REVIEW_MAX_CHUNKS') || Math.min(6, baseChunks);
  return { chunks, budgetPerChunk: Math.ceil(input.totalChars / Math.max(1, chunks)), maxIssues: Math.max(4, Math.min(28, Math.ceil(chunks * 2.5))) };
}

// 从章节正文确定性提取总量口径数字清单，作为全局一致性审查的比对输入：
// LLM 摘要式阅读会漏掉 1600 字符之后的关键数字（历史缺陷），清单化可保证跨章数值全部进入审查视野
function numericDigestForChapter(content: string) {
  const patterns = [
    /(?:总建筑面积|建设规模|总用地面积|总占地面积)[^\n。；;]{0,18}\d+(?:[.,]\d+)?\s*万?\s*(?:㎡|m²|m2|平方米)/gu,
    /(?:合同估算价|合同估算价格|投资估算|最高投标限价|招标控制价|工程总投资|总投资|工程造价)[^\n。；;]{0,18}\d+(?:[.,]\d+)?\s*万?\s*(?:万元|亿元|元)/gu,
    /(?:计划工期|合同工期|总工期|施工周期)[^\n。；;]{0,18}\d+\s*(?:日历天|天|个月|月)/gu,
    /(?:质量标准|质量目标)[^\n。；;]{0,26}/gu,
    /(?:找平层|抹灰层|防水层|保温层|结合层|垫层|面层|粘结层)[^\n。；;]{0,24}\d+:\d+(?:\.\d+)?/gu,
  ];
  const digest: string[] = [];
  for (const pattern of patterns) {
    const matches = [...new Set(content.match(pattern) || [])].slice(0, 4);
    digest.push(...matches);
  }
  return [...new Set(digest.map(item => item.replace(/\s+/gu, ' ').trim()).filter(Boolean))].join('；');
}

// 项目上下文的数值口径清单提取：全局一致性审查的冲突判定只依赖资料/裁决中的总量数值口径，
// 蓝图叙事与图谱映射对判定无用且体积大（全量可达数万字）——确定性提取含数值的行/短语，
// 控制注入体积，并作为跨 chunk 恒定前缀放入 system（prefix cache 全命中，公共上下文只付一次 token 成本）
function numericContextDigest(context: string) {
  if (!context) return '';
  const lines = context.split('\n').map(line => line.trim()).filter(Boolean);
  const numericLines = lines.filter(line => /\d/u.test(line) && line.length <= 500);
  const compact = numericLines.slice(0, 120).map(line => (line.length > 240 ? `${line.slice(0, 240)}…` : line));
  return [...new Set(compact)].join('\n').slice(0, 8000);
}

export async function reviewGlobalConsistency(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; chapterReviews: ChapterReviewSummary[]; promptTexts: string; requirement?: string; projectContext?: string; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  throwIfAborted(input.signal); const summaries = input.chapters.map(ch => { const p = ch.content.replace(/#{1,6}\s+/gu,'').replace(/\*\*/gu,'').replace(/\|/gu,' ').replace(/[\n\r]+/gu,' ').trim(); const digest = numericDigestForChapter(ch.content); return `章节：${ch.title}\n数值口径清单：${digest || '（未提取到总量口径数字）'}\n正文摘要：${p.slice(0,600)}`; });
  const text = summaries.join('\n\n---\n\n'); const plan = adaptiveReviewPlan({ totalChars: text.length, chapterCount: input.chapters.length, chunkChars: 16000, phase: 'global' });
  const chunks = chunkTextForReview(text, 16000).slice(0, plan.chunks);
  const reviewPrompt = docSystemPrefix('你是专业文档审查专家。检查跨章节数值一致性。每个章节都附带“数值口径清单”（从正文确定性提取的总量口径数字）。只报告确定性矛盾，两类：(1) 两章之间同一口径的数值互相矛盾；(2) 正文数值与项目上下文中的资料口径或裁决口径明确不符。每条冲突必须包含：章节名+冲突数值+正确口径（正确口径必须取自项目上下文中的资料或裁决，不得自行编造）。资料未提供某口径不构成冲突，不得报告；各章表述一致但资料未明确的字段不得报告；各章一致的表述不得报告。只返回 JSON。');
  // P3 耗时优化：projectContext 移出 per-chunk user 注入——历史每个 chunk 的 user 都重复拼入全量
  // 项目上下文（可达数万字，4 chunks 即 4 倍），且 user 首部随 chunk 变化导致 prefix cache 无法命中；
  // 改为提取数值口径清单注入 system：跨 chunk 前缀恒定（A5a prefix cache 全命中），公共上下文只付一次成本
  const contextDigest = numericContextDigest(input.projectContext || '');
  const systemPrompt = [reviewPrompt, contextDigest ? `【资料口径基准（冲突判定基准：正确口径必须取自此处，不得自行编造）】\n${contextDigest}` : ''].join('\n\n');
  // F8 分层统计：system 恒定段（l0，跨 chunk 恒定 prefix cache）/ promptTexts（l1，任务级恒定）/
  // 块级变化段（l3：chunk 摘要与 JSON 指令）。与 prompt 组装同源表达式，供占比验收
  const chunkReviews = await Promise.all(chunks.map(chunk => callDocumentLlmJson<{ issues?: string[] }>(systemPrompt, `${input.promptTexts}\n\n${chunk}\n\n返回 JSON：{"issues":[]}`, { maxTokens: 1000, temperature: 0.1, signal: input.signal, diagnostics: input.diagnostics, contextLayers: { l0: systemPrompt.length, l1: contextLayerChars([input.promptTexts]), l3: contextLayerChars([chunk, '\n\n返回 JSON：{"issues":[]}']) } })));
  const issues = mergeUniqueStrings(chunkReviews.flatMap(r => Array.isArray(r?.issues) ? r.issues : []));
  return { issues, stage: displayStage({ type: 'llm_review', roleId: 'global-consistency-review', status: issues.length > 0 ? 'failed' : 'success', message: issues.length > 0 ? `全局一致性审查完成：发现 ${issues.length} 个跨章问题` : '全局一致性审查通过' }, { subtitle: '全局一致性审查' }) };
}
