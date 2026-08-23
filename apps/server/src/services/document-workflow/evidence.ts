import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { DocumentEvidence, DocumentGenerationDiagnostics, DocumentTemplateChapter, EvidenceBundle, ResourceEvidence } from './types';
import { CAD_ENTITY_TOKEN_RE, FILE_NAME_RE } from './constants';
import { EVIDENCE_PARAMETER_RE } from './parameterPatterns';
import { evidenceMatchesFact } from './factMatching';
import { selectByScore, textImportanceScore } from './selection';

export function readableSourceLabel(item: Pick<DocumentEvidence, 'roleId' | 'processingType' | 'sectionTitle'>, index = 0) {
  const role = item.processingType === 'drawing' || item.roleId?.includes('drawing') ? '视觉资料'
    : item.processingType === 'table' || item.roleId?.includes('bill') ? '表格资料'
      : item.processingType === 'rule' || item.roleId?.includes('tender') ? '规则资料'
        : '文本资料';
  return `${role}片段${index + 1}${item.sectionTitle ? `（${item.sectionTitle.replace(FILE_NAME_RE, '')}）` : ''}`;
}

export function cleanEvidenceText(content: string) {
  return [...content]
    .filter(char => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join('')
    .replace(CAD_ENTITY_TOKEN_RE, '')
    .replace(FILE_NAME_RE, '')
    .replace(/\b(?:Model|Layout\d*|Entity|Handle|ObjectId|ByLayer|Continuous)\b/giu, '')
    .replace(/[\t ]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function evidenceQualityScore(content: string) {
  const text = cleanEvidenceText(content);
  const chars = Math.max(1, text.length);
  const chinese = (text.match(/[\u4e00-\u9fa5]/gu) || []).length;
  const digits = (text.match(/\d/gu) || []).length;
  const semanticTerms = (text.match(/项目|任务|质量|安全|周期|验收|材料|设备|表格|数据|参数|规范|标准|流程|资源|风险/gu) || []).length;
  const noiseHits = (text.match(/CAD|AcDb|Polyline|ByLayer|ObjectId|Handle|Model|Layout|图层|页码|第\s*\d+\s*页|打印|版权所有|^[\s\W\d_]+$/gimu) || []).length;
  const repeatedHeaders = (text.match(/(?:序号|项目名称|事项|单位|数量|单价|金额|备注)/gu) || []).length;
  const factDensity = Math.min(1, (chinese / chars) * 0.7 + Math.min(0.3, (digits + semanticTerms * 3) / 120));
  const noiseScore = Math.min(1, noiseHits * 0.18 + Math.max(0, repeatedHeaders - 8) * 0.04 + (chinese / chars < 0.25 ? 0.35 : 0));
  return { noiseScore, factDensity, shouldUse: text.length >= 30 && noiseScore < 0.72 && factDensity > 0.08 };
}

function extractParameterLines(content: string) {
  const lines = cleanEvidenceText(content).split('\n').map(line => line.trim()).filter(Boolean);
  const parameterLines = lines.filter(line => {
    const isProjectBasicValue = /计划工期|合同工期|工期|合同估算价|合同估算价格|投资估算|估算价格|工程估算价|最高投标限价|招标控制价|建设地点|建设规模|质量标准/u.test(line);
    if (!isProjectBasicValue && /综合单价|合价|报价明细|投标报价|税率|增值税|利润|预留金|暂列金额|结算/u.test(line)) return false;
    const hasParameter = EVIDENCE_PARAMETER_RE.test(line);
    const hasContext = /项目|工程|工期|合同|估算|价格|地点|规模|清单|图纸|设计|规格|型号|数量|单位|材料|设备|管|线|电缆|混凝土|钢筋|砌体|门窗|防水|标准|规范|验收|做法|参数|尺寸|标高|厚度|强度|等级|系统|安装/u.test(line);
    return isProjectBasicValue || hasParameter || (hasContext && /\d/u.test(line) && line.length <= 260);
  });
  // 用评分选择最重要的参数行（而非硬截断前 80 行）
  const uniqueLines = [...new Set(parameterLines)];
  const selected = selectByScore(uniqueLines, l => textImportanceScore(l), { maxItems: 100, maxChars: 12000 }, 'parameter-lines');
  return selected.selected.join('\n');
}

export function sanitizeEvidenceContent(filePath: string, content: string) {
  const ext = path.extname(filePath).toLowerCase();
  const cleaned = cleanEvidenceText(content)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^第\s*\d+\s*页\s*(?:共\s*\d+\s*页)?$/u.test(line))
    .join('\n');
  const quality = evidenceQualityScore(cleaned);
  if (cleaned.length > 20 && quality.shouldUse) return cleaned;
  const parameterSummary = extractParameterLines(cleaned);
  if (parameterSummary.length > 20) return `资料参数行摘要：\n${parameterSummary}`;
  if (cleaned.length > 80 && quality.noiseScore < 0.9) return cleaned;
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.png', '.jpg', '.jpeg', '.webp', '.dwg'].includes(ext)) {
    return `该资料为${ext.replace('.', '').toUpperCase()}格式附件，仅作为内部事实提取依据；正式正文不得引用文件名。`;
  }
  return cleaned;
}

function evidenceDedupeKey(item: DocumentEvidence): string {
  const normalized = item.content.replace(/\s+/gu, ' ').trim();
  return `${item.filePath}:${item.sectionTitle || ''}:${createHash('sha1').update(normalized).digest('hex')}`;
}

export function uniqueEvidence(items: DocumentEvidence[], limit?: number, diagnostics?: DocumentGenerationDiagnostics): DocumentEvidence[] {
  const seen = new Set<string>();
  const scored = items.map(item => {
    const content = sanitizeEvidenceContent(item.filePath, item.content);
    const quality = evidenceQualityScore(content);
    return { item: { ...item, content, score: item.score * (1 + quality.factDensity) * (1 - quality.noiseScore * 0.45) }, quality };
  });
  const usable = scored.filter(entry => entry.quality.shouldUse || /附件，仅作为内部事实提取依据/u.test(entry.item.content));
  const resolvedLimit = Number.isFinite(limit) && limit! > 0 ? Math.ceil(limit!) : undefined;
  const deduped = (usable.length >= Math.min(3, items.length) ? usable : scored)
    .sort((a, b) => b.item.score - a.item.score)
    .filter(entry => {
      const key = evidenceDedupeKey(entry.item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const selected = resolvedLimit ? deduped.slice(0, resolvedLimit) : deduped;
  if (diagnostics) {
    const totalNoise = scored.reduce((sum, entry) => sum + entry.quality.noiseScore, 0);
    const totalDensity = scored.reduce((sum, entry) => sum + entry.quality.factDensity, 0);
    diagnostics.evidence.raw += items.length;
    diagnostics.evidence.used += selected.length;
    diagnostics.evidence.filteredNoise += Math.max(0, scored.length - usable.length);
    diagnostics.evidence.avgNoiseScore = scored.length ? Number((totalNoise / scored.length).toFixed(3)) : 0;
    diagnostics.evidence.avgFactDensity = scored.length ? Number((totalDensity / scored.length).toFixed(3)) : 0;
  }
  return selected.map(entry => entry.item);
}

// evidenceDedupeKey 仅在模块内部使用，不对外导出

/** 证据声明结果 */
export type EvidenceClaimResult = 'new' | 'claimed-by-other-chapter' | 'duplicate-in-chapter';

/** 排除源（固定/绑定/需求事实/多模态证据）在跨章节去重中保持豁免 */
export function isExemptEvidenceSource(item: DocumentEvidence): boolean {
  return item.source === 'pinned-evidence' || item.source === 'bound-file' || item.source === 'required-fact-evidence' || item.source === 'multimodal';
}

/** 跨章节证据声明注册表，用于去重和复用追踪 */
export class EvidenceClaimRegistry {
  private claims = new Map<string, { chapterIds: Set<string>; item: DocumentEvidence }>();

  claim(item: DocumentEvidence, chapterId: string): EvidenceClaimResult {
    const key = evidenceDedupeKey(item);
    const existing = this.claims.get(key);
    if (!existing) {
      this.claims.set(key, { chapterIds: new Set([chapterId]), item });
      return 'new';
    }
    existing.chapterIds.add(chapterId);
    if (existing.chapterIds.has(chapterId) && existing.chapterIds.size === 1) return 'duplicate-in-chapter';
    return isExemptEvidenceSource(item) ? 'new' : 'claimed-by-other-chapter';
  }

  /** 返回被多个章节复用的证据条目 */
  duplicateItems(): Array<{ key: string; filePath: string; chapterIds: string[]; count: number }> {
    return [...this.claims.entries()]
      .filter(([, entry]) => entry.chapterIds.size > 1)
      .map(([key, entry]) => ({ key, filePath: entry.item.filePath, chapterIds: [...entry.chapterIds], count: entry.chapterIds.size }))
      .sort((a, b) => b.count - a.count);
  }
}

/** 在章节证据中加入跨章节去重过滤，安全底限 minRemaining 防止证据不足 */
export function dedupeChapterEvidence(
  evidence: DocumentEvidence[],
  chapterId: string,
  registry: EvidenceClaimRegistry,
  opts?: { minRemaining?: number },
): DocumentEvidence[] {
  const minRemaining = opts?.minRemaining ?? 8;
  const sorted = [...evidence].sort((a, b) => b.score - a.score);
  const kept: DocumentEvidence[] = [];
  const dropped: DocumentEvidence[] = [];
  for (const item of sorted) {
    const result = registry.claim(item, chapterId);
    if (result === 'claimed-by-other-chapter') {
      dropped.push(item);
    } else {
      kept.push(item);
    }
  }
  // 安全底限：如果去重后证据太少，从被丢弃的高分条目中补齐
  if (kept.length < minRemaining && dropped.length > 0) {
    const needed = minRemaining - kept.length;
    kept.push(...dropped.slice(0, needed));
  }
  return kept;
}

/** 全局证据去重：对全量证据按内容 key 保留最高分 */
export function dedupeGlobalEvidence(evidence: DocumentEvidence[]): DocumentEvidence[] {
  const best = new Map<string, DocumentEvidence>();
  for (const item of evidence) {
    if (isExemptEvidenceSource(item)) {
      best.set(`${evidenceDedupeKey(item)}:${item.chapterId}`, item);
      continue;
    }
    const key = evidenceDedupeKey(item);
    const existing = best.get(key);
    if (!existing || item.score > existing.score) best.set(key, item);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export function selectEvidenceByBudget(items: DocumentEvidence[], options: { maxItems?: number; maxChars?: number; preservePinned?: boolean } = {}, diagnostics?: DocumentGenerationDiagnostics): DocumentEvidence[] {
  const maxItems = Number.isFinite(options.maxItems) && options.maxItems! > 0 ? Math.floor(options.maxItems!) : undefined;
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars! > 0 ? Math.floor(options.maxChars!) : undefined;
  const ranked = uniqueEvidence(items, undefined, diagnostics);
  const pinned = options.preservePinned ? ranked.filter(item => item.source === 'pinned-evidence' || item.source === 'bound-file' || item.source === 'required-fact-evidence') : [];
  const normal = ranked.filter(item => !pinned.includes(item));
  const selected: DocumentEvidence[] = [];
  const perFileCounts = new Map<string, number>();
  let chars = 0;
  const tryPush = (item: DocumentEvidence, priority = false) => {
    if (maxItems && selected.length >= maxItems) return;
    const fileCount = perFileCounts.get(item.filePath) || 0;
    if (!priority && fileCount >= 4) return;
    const content = cleanEvidenceText(item.content);
    const nextChars = chars + content.length;
    if (maxChars && selected.length > 0 && nextChars > maxChars) return;
    selected.push({ ...item, content });
    perFileCounts.set(item.filePath, fileCount + 1);
    chars = nextChars;
  };
  for (const item of pinned) tryPush(item, true);
  for (const item of normal) tryPush(item);
  return selected;
}


export function evidenceLine(item: DocumentEvidence, index = 0): string {
  return `- ${readableSourceLabel(item, index)}：${cleanEvidenceText(item.content).replace(/\s+/gu, ' ').slice(0, 260)}`;
}

function resourceKind(filePath: string, processingType?: string): ResourceEvidence['kind'] {
  const ext = path.extname(filePath).toLowerCase();
  if (processingType === 'drawing' || /地图|map|drawing|design/iu.test(filePath)) return 'map';
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'image';
  if (processingType === 'table') return 'table';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'spreadsheet';
  if (['.pdf', '.doc', '.docx'].includes(ext)) return 'document';
  if (ext && !['.md', '.txt'].includes(ext)) return 'attachment';
  return 'text';
}

function semanticResourceTitle(filePath: string, kind: ResourceEvidence['kind']) {
  const name = path.basename(filePath).replace(/\.[^.]+$/u, '');
  if (kind === 'map') return name.replace(/^地图-/u, '').replace(/-完整地图$/u, '完整地图');
  if (kind === 'image') return name.replace(/-/gu, ' ');
  if (kind === 'spreadsheet') return `${name}（结构化表格）`;
  if (kind === 'document') return `${name}（文档附件）`;
  return name;
}

function relatedFactsForResource(item: DocumentEvidence, chapter?: DocumentTemplateChapter) {
  const haystack = `${item.filePath}\n${item.content}`;
  const candidates = [...(chapter?.requiredFacts || []), '表格数据', '规范要求', '基础事实', '附件资料', '视觉资料', '图片资料'];
  return [...new Set(candidates.filter(fact => evidenceMatchesFact(item, fact) || haystack.includes(fact)))];
}

function resourceContentUse(kind: ResourceEvidence['kind']) {
  if (kind === 'map') return '作为视觉/地图证据，用于说明空间关系、区域划分、点位、路线或布局。';
  if (kind === 'image') return '作为图片证据，用于视觉说明、参考图或章节配图。';
  if (kind === 'spreadsheet' || kind === 'table') return '作为表格/数据证据，用于字段对比、明细、数量和结构化结论。';
  if (kind === 'document') return '作为 PDF/Word 文档证据，用于提取规范、事实、说明、约束和附件来源。';
  if (kind === 'attachment') return '作为附件证据，用于提供补充来源、文件级约束或可追溯引用。';
  return '作为文本证据，用于事实抽取、章节论据和来源引用。';
}

function emptyEvidenceByKind(): Record<ResourceEvidence['kind'], ResourceEvidence[]> {
  return { map: [], image: [], table: [], document: [], spreadsheet: [], text: [], attachment: [] };
}

/** 构建章节证据包，将原始证据分类为文本片段和结构化资源（图片、表格、文档、地图等） */
export function buildEvidenceBundle(chapter: DocumentTemplateChapter, evidence: DocumentEvidence[]): EvidenceBundle {
  const textEvidence = evidence;
  const resourceMap = new Map<string, ResourceEvidence>();
  for (const item of evidence) {
    const kind = resourceKind(item.filePath, item.processingType);
    const existing = resourceMap.get(item.filePath);
    const resource: ResourceEvidence = existing || {
      filePath: item.filePath,
      kind,
      roleId: item.roleId,
      processingType: item.processingType,
      score: item.score,
      semanticTitle: semanticResourceTitle(item.filePath, kind),
      contentUse: resourceContentUse(kind),
      relatedFacts: [],
      relatedChapters: [],
      snippets: [],
    };
    resource.score = Math.max(resource.score, item.score);
    resource.relatedFacts = [...new Set([...resource.relatedFacts, ...relatedFactsForResource(item, chapter)])];
    resource.relatedChapters = [...new Set([...resource.relatedChapters, chapter.title])];
    const snippet = item.content.replace(/\s+/gu, ' ').slice(0, 320);
    if (snippet && resource.snippets.length < 3 && !resource.snippets.includes(snippet)) resource.snippets.push(snippet);
    resourceMap.set(item.filePath, resource);
  }
  const resources = [...resourceMap.values()].sort((a, b) => b.score - a.score);
  const byKind = emptyEvidenceByKind();
  for (const resource of resources) byKind[resource.kind].push(resource);
  const summary = [
    `绑定材料包：文本片段 ${textEvidence.length} 条、结构化材料 ${resources.length} 个。`,
    `材料类型分布：文本 ${byKind.text.length}、文档 ${byKind.document.length}、表格/数据 ${byKind.spreadsheet.length + byKind.table.length}、图片 ${byKind.image.length}、视觉/地图 ${byKind.map.length}、其他 ${byKind.attachment.length}。`,
    '正文必须只写材料中的事实、参数、数量、做法和要求，不得出现文件名、来源清单或后台证据描述。',
  ].filter(Boolean).join('\n');
  return { chapterId: chapter.id, textEvidence, resources, byKind, summary };
}

export interface EvidencePromptOptions {
  maxChars?: number;
}

export function evidencePromptBudgetForTarget(targetWords?: number, floorChars = 6000, ceilingChars = 18000) {
  const words = Number.isFinite(targetWords) && targetWords! > 0 ? Math.ceil(targetWords!) : 1200;
  const dynamic = Math.ceil(words * 5.5);
  return Math.max(floorChars, Math.min(ceilingChars, dynamic));
}

function appendWithinBudget(parts: string[], next: string, state: { chars: number; omitted: number }, maxChars?: number) {
  const normalized = next.trim();
  if (!normalized) return;
  if (!Number.isFinite(maxChars) || !maxChars || state.chars + normalized.length <= maxChars) {
    parts.push(normalized);
    state.chars += normalized.length;
    return;
  }
  state.omitted += 1;
}

function selectEvidenceForPrompt<T extends { filePath: string; score: number }>(items: T[], maxChars: number | undefined, render: (item: T, index: number) => string) {
  const state = { chars: 0, omitted: 0 };
  const selected: string[] = [];
  const selectedItems = new Set<T>();
  const byFile = new Set<string>();
  const ranked = [...items].sort((a, b) => b.score - a.score);
  for (const item of ranked) {
    if (byFile.has(item.filePath)) continue;
    const before = selected.length;
    appendWithinBudget(selected, render(item, selected.length), state, maxChars);
    if (selected.length > before) {
      byFile.add(item.filePath);
      selectedItems.add(item);
    }
  }
  for (const item of ranked) {
    if (selectedItems.has(item)) continue;
    appendWithinBudget(selected, render(item, selected.length), state, maxChars);
  }
  return { lines: selected, omitted: state.omitted };
}

export function evidenceBundlePrompt(bundle: EvidenceBundle, options: EvidencePromptOptions = {}) {
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars! > 0 ? Math.ceil(options.maxChars!) : undefined;
  const resourcePrompt = selectEvidenceForPrompt(bundle.resources, maxChars ? Math.floor(maxChars * 0.35) : undefined, (item, index) => [
    `- 资料：${readableSourceLabel(item, index)}`,
    `  资料类型：${item.kind}`,
    `  正文用途：${item.contentUse}`,
    item.relatedFacts.length ? `  可用事实方向：${item.relatedFacts.join('、')}` : '',
    item.snippets.length ? `  可用内容：${item.snippets.map(cleanEvidenceText).filter(Boolean).join(' / ')}` : '',
  ].filter(Boolean).join('\n'));
  const textPrompt = selectEvidenceForPrompt(bundle.textEvidence, maxChars ? Math.floor(maxChars * 0.65) : undefined, (item, index) => `${readableSourceLabel(item, index)}\n类型：${item.processingType || 'reference'}\n章节/片段：${item.sectionTitle?.replace(FILE_NAME_RE, '') || '资料片段'}\n内容：${cleanEvidenceText(item.content).replace(/\s+/gu, ' ')}`);
  const omittedNote = resourcePrompt.omitted + textPrompt.omitted > 0
    ? `提示：完整证据池仍保留 ${bundle.textEvidence.length} 条文本片段、${bundle.resources.length} 个结构化材料；为控制单次模型输入，本次只发送预算内高相关且覆盖多来源的证据，未发送片段将在章节/小节相关检索和质量校验中继续参与。`
    : '';
  return [bundle.summary, omittedNote, resourcePrompt.lines.length ? `结构化资料：\n${resourcePrompt.lines.join('\n')}` : '', textPrompt.lines.length ? `文本/附件片段：\n${textPrompt.lines.join('\n\n---\n\n')}` : ''].filter(Boolean).join('\n\n');
}
