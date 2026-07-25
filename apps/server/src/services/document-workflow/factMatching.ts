import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';
import type { DocumentEvidence, DocumentTemplate } from './types';
import { effectiveTemplateChapters } from './outline';

function factSearchTerms(fact: string) {
  const normalized = fact.replace(/要求|计划|目标|标准|内容|信息|事实|依据|参数|范围|要点/gu, '');
  return [fact, normalized].filter(Boolean);
}

export function evidenceMatchesFact(item: DocumentEvidence, fact: string) {
  const haystack = `${item.filePath}\n${item.content}`;
  return factSearchTerms(fact).some(term => haystack.includes(term));
}

export function specFactTargets(template: DocumentTemplate, spec?: AutoDocumentSpecPackage) {
  const chapters = effectiveTemplateChapters(template, spec);
  const chapterFacts = chapters.flatMap(chapter => chapter.requiredFacts).map(name => ({ id: name, name, required: true, sourceRoleIds: [] as string[], extractionHint: '' }));
  const specFacts = spec?.factFields.map(field => ({ id: field.id, name: field.name, required: field.required, sourceRoleIds: field.sourceRoleIds || [], extractionHint: field.extractionHint || '' })) || [];
  const map = new Map<string, { id: string; name: string; required: boolean; sourceRoleIds: string[]; extractionHint: string }>();
  for (const item of [...chapterFacts, ...specFacts]) map.set(item.id, { ...(map.get(item.id) || item), ...item, required: item.required || map.get(item.id)?.required || false });
  return [...map.values()];
}

export function evidenceSatisfiesSpecField(item: DocumentEvidence, field: { name: string; sourceRoleIds?: string[] }) {
  const roleMatched = !field.sourceRoleIds?.length || Boolean(item.roleId && field.sourceRoleIds.includes(item.roleId));
  return roleMatched && evidenceMatchesFact(item, field.name);
}
