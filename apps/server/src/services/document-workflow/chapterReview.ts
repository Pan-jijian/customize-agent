import * as fs from 'node:fs';
import * as path from 'node:path';
import { createProvider } from '@customize-agent/llm';
import type { ChapterReviewSummary, DocumentDraftChapter, DocumentEvidence, DocumentExecutionStage, DocumentGenerationDiagnostics, DocumentTemplate, DocumentTemplateChapter } from './types';
import { documentTextLength } from './budget';
import { callDocumentLlm, callDocumentLlmJson, getActiveModelWithProvider } from './llmClient';
import { displayStage } from './progress';
import { throwIfAborted } from './utils';
import { buildSectionFactCard, evidenceForSection, sectionFactUsageIssue, sectionTargets } from './chapterGeneration';

export function chapterSectionFactUsageIssues(input: { chapter: DocumentTemplateChapter; content: string; evidence: DocumentEvidence[] }) {
  return sectionTargets(input.chapter, Math.max(1000, documentTextLength(input.content))).flatMap(target => {
    const escaped = target.title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = input.content.match(new RegExp(`^#{2,4}\\s+(?:\\d+(?:\\.\\d+)*\\s+)?${escaped}\\s*\\n([\\s\\S]*?)(?=^#{2,4}\\s+|$)`, 'mu'));
    const body = match?.[1] || '';
    const factCard = buildSectionFactCard(target.title, evidenceForSection(target.title, input.chapter, input.evidence));
    const issue = sectionFactUsageIssue(target.title, body, factCard);
    return issue ? [`${target.title}：${issue}`] : [];
  });
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

export async function understandReferenceFiles(projectRoot: string, evidence: DocumentEvidence[], signal?: AbortSignal): Promise<{ notes: string[]; stage: DocumentExecutionStage }> {
  const active = getActiveModelWithProvider(); if (!active) return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '当前模型不可用' }, { subtitle: '多模态参考文件' }) };
  let provider: ReturnType<typeof createProvider>;
  try {
    provider = createProvider(active.model.provider, { apiKey: active.provider.apiKey, baseUrl: active.provider.baseUrl, modelName: active.model.name, directEndpoint: active.provider.directEndpoint });
  } catch {
    return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: `当前模型服务 ${active.model.provider} 不支持多模态文件理解，已跳过` }, { subtitle: '多模态参考文件' }) };
  }
  const maxFiles = 4; const maxBytes = 8 * 1024 * 1024;
  const candidates = [...new Set(evidence.map(item => item.filePath).filter(file => /\.(png|jpe?g|webp|pdf|docx|xlsx)$/iu.test(file)))].slice(0, maxFiles);
  if (candidates.length === 0) return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '未找到多模态参考文件' }, { subtitle: '多模态参考文件' }) };
  const files: Array<{ name: string; buffer: Buffer; mimeType: string }> = [];
  for (const filePath of candidates) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath); if (!fs.existsSync(absPath)) continue;
    const stat = fs.statSync(absPath); if (stat.size > maxBytes) continue;
    files.push({ name: path.basename(filePath), buffer: fs.readFileSync(absPath), mimeType: /\.png$/iu.test(filePath) ? 'image/png' : /\.jpe?g$/iu.test(filePath) ? 'image/jpeg' : /\.webp$/iu.test(filePath) ? 'image/webp' : 'application/pdf' });
    if (files.length >= maxFiles) break;
  }
  if (files.length === 0) return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'skipped', message: '未找到可读取的多模态文件' }, { subtitle: '多模态参考文件' }) };
  try { if (signal?.aborted) throw new Error('aborted'); const result = await (provider as any).understandFiles?.({ files }); if (!result?.length) return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'failed', message: '多模态模型未返回文件理解结果' }, { subtitle: '多模态参考文件' }) }; return { notes: result, stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'success', message: `已完成 ${result.length} 个多模态文件理解` }, { subtitle: '多模态参考文件' }) }; }
  catch (err) { console.error('[multimodal] failed:', err); return { notes: [], stage: displayStage({ type: 'file_understanding', roleId: 'multimodal-files', status: 'failed', message: '多模态文件理解失败' }, { subtitle: '多模态参考文件' }) }; }
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

export async function reviewGlobalConsistency(input: { template: DocumentTemplate; chapters: DocumentDraftChapter[]; chapterReviews: ChapterReviewSummary[]; promptTexts: string; requirement?: string; projectContext?: string; diagnostics: DocumentGenerationDiagnostics; signal?: AbortSignal }) {
  throwIfAborted(input.signal); const summaries = input.chapters.map(ch => { const p = ch.content.replace(/#{1,6}\s+/gu,'').replace(/\*\*/gu,'').replace(/\|/gu,' ').replace(/[\n\r]+/gu,' ').trim(); const digest = numericDigestForChapter(ch.content); return `章节：${ch.title}\n数值口径清单：${digest || '（未提取到总量口径数字）'}\n正文摘要：${p.slice(0,600)}`; });
  const text = summaries.join('\n\n---\n\n'); const plan = adaptiveReviewPlan({ totalChars: text.length, chapterCount: input.chapters.length, chunkChars: 16000, phase: 'global' });
  const chunks = chunkTextForReview(text, 16000).slice(0, plan.chunks);
  const reviewPrompt = '你是专业文档审查专家。检查跨章节数值一致性。每个章节都附带“数值口径清单”（从正文确定性提取的总量口径数字）。只报告确定性矛盾，两类：(1) 两章之间同一口径的数值互相矛盾；(2) 正文数值与项目上下文中的资料口径或裁决口径明确不符。每条冲突必须包含：章节名+冲突数值+正确口径（正确口径必须取自项目上下文中的资料或裁决，不得自行编造）。资料未提供某口径不构成冲突，不得报告；各章表述一致但资料未明确的字段不得报告；各章一致的表述不得报告。只返回 JSON。';
  const chunkReviews = await Promise.all(chunks.map(chunk => callDocumentLlmJson<{ issues?: string[] }>(reviewPrompt, `${input.promptTexts}\n\n${input.projectContext || ''}\n\n${chunk}\n\n返回 JSON：{"issues":[]}`, { maxTokens: 1000, temperature: 0.1, signal: input.signal, diagnostics: input.diagnostics })));
  const issues = mergeUniqueStrings(chunkReviews.flatMap(r => Array.isArray(r?.issues) ? r.issues : []));
  return { issues, stage: displayStage({ type: 'llm_review', roleId: 'global-consistency-review', status: issues.length > 0 ? 'failed' : 'success', message: issues.length > 0 ? `全局一致性审查完成：发现 ${issues.length} 个跨章问题` : '全局一致性审查通过' }, { subtitle: '全局一致性审查' }) };
}
