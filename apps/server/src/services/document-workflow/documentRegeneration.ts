import * as path from 'node:path';
import { getMultiProjectManager, getProjectRoot } from '../knowledge/kbService';
import type { KbSearchResult } from '@/lib/api';
import type { DocumentDraftChapter, DocumentEvidence } from './types';
import { getDocumentTemplate } from './templateStore';
import { evidenceLine } from './evidence';
import { displayChapterTitle } from './outline';
import { evidenceMatchesFact } from './factMatching';
import { evidenceInScope } from './rolePipeline';
import { buildProjectMaterialProfile, expandProjectMaterialBindings, materialKindMaps, materialRoleId } from './projectMaterialProfile';
import { assertEvidenceInProjectScope, createProjectMaterialScope, filterEvidenceByProjectScope } from './projectMaterialScope';
import { compactChapterQueries, optimizeChapterEvidence, qualityFirstEvidenceItemLimit, qualityFirstSearchQueryLimit, resolveDocumentGenerationEvidenceLimit } from './documentGeneratorHelpers';

export async function regenerateDocumentChapter(input: { templateId: string; chapterId: string; requirement?: string; maxEvidencePerChapter?: number; projectRoot?: string; documentId?: string; currentMarkdown?: string; existingFacts?: string[] }): Promise<DocumentDraftChapter> {
  const template = getDocumentTemplate(input.templateId);
  if (!template) throw new Error('Document template not found');
  const chapter = template.chapters.find(item => item.id === input.chapterId);
  if (!chapter) throw new Error('Document chapter not found');
  const projectRoot = path.resolve(input.projectRoot || getProjectRoot());
  if (!projectRoot) throw new Error('No knowledge base project found');
  const manager = getMultiProjectManager();
  const materialFilePaths = expandProjectMaterialBindings(projectRoot, template, { requirement: input.requirement });
  const projectMaterialProfile = buildProjectMaterialProfile(projectRoot, template, { requirement: input.requirement });
  const { kindByPath, processingByPath } = materialKindMaps(projectMaterialProfile);
  const boundFilePaths = new Set(materialFilePaths);
  const projectMaterialScope = createProjectMaterialScope(projectRoot, materialFilePaths);
  const fileRoleByPath = new Map([...kindByPath.entries()].map(([filePath, kind]) => [filePath, materialRoleId(kind)] as const));
  const fileProcessingByPath = new Map([...processingByPath.entries()].map(([filePath, processing]) => [filePath, processing] as const));
  const project = await manager.getProject(projectRoot);
  const requestedEvidencePerChapter = resolveDocumentGenerationEvidenceLimit(project, [...boundFilePaths], input.maxEvidencePerChapter);
  const rawEvidence: DocumentEvidence[] = [];
  const scopedFilePaths = [...boundFilePaths].filter(Boolean).sort();
  const queries = compactChapterQueries(chapter, chapter.queries, []);
  const maxSearchQueries = qualityFirstSearchQueryLimit(chapter, []);
  for (const query of queries.slice(0, maxSearchQueries)) {
    const result = await manager.search(projectRoot, query, {
      scope: 'project',
      filters: { filePaths: scopedFilePaths },
      limit: Math.min(requestedEvidencePerChapter, 12),
      weights: { keyword: 0.4, vector: 0.45, rewrite: 0.75, hybridBonus: 0.15 },
      generationMode: true,
    });
    rawEvidence.push(...result.results
      .filter((item: KbSearchResult) => evidenceInScope(projectRoot, item.filePath, boundFilePaths))
      .map((item: KbSearchResult) => ({
        chapterId: chapter.id,
        filePath: item.filePath,
        score: item.score,
        content: item.content,
        roleId: fileRoleByPath.get(item.filePath),
        processingType: fileProcessingByPath.get(item.filePath),
        sectionTitle: item.sectionTitle,
        source: item.source,
      })));
  }
  const scopedEvidence = filterEvidenceByProjectScope(rawEvidence.filter(item => evidenceInScope(projectRoot, item.filePath, boundFilePaths)), projectMaterialScope);
  const evidence = optimizeChapterEvidence(chapter, scopedEvidence, { maxItems: qualityFirstEvidenceItemLimit(requestedEvidencePerChapter, chapter), maxChars: 16000, preservePinned: true });
  assertEvidenceInProjectScope(evidence, projectMaterialScope, `regenerate:${chapter.id}`);
  const existingContext = input.currentMarkdown || '';
  const existingFactSet = new Set(input.existingFacts ?? []);
  const missingFacts = chapter.requiredFacts.filter(fact => !existingFactSet.has(fact) && !evidence.some(item => evidenceMatchesFact(item, fact)));
  if (evidence.length === 0) throw new Error(`${displayChapterTitle(chapter.title)} 缺少可支撑正文的项目资料证据`);
  const content = [
    `## ${chapter.title}`,
    '',
    input.requirement ? `> 生成要求：${input.requirement}` : '',
    existingContext ? `> 当前文档上下文摘要：${existingContext.replace(/\s+/gu, ' ')}` : '',
    `本章依据已锁定项目资料围绕“${chapter.purpose}”重新整理，并与当前文档上下文保持一致。`,
    '',
    '### 资料依据',
    ...evidence.map(evidenceLine),
  ].filter(Boolean).join('\n');
  return { id: chapter.id, title: chapter.title, content, evidence, missingFacts };
}
