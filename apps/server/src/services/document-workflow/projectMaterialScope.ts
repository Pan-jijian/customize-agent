import * as path from 'node:path';
import type { DocumentEvidence, DocumentFact, StructuredTableFact } from './types';

export interface ProjectMaterialScope {
  projectId: string;
  allowedFilePaths: string[];
}

function normalizeScopePath(filePath: string) {
  return path.resolve(filePath).replace(/\\/gu, '/').toLowerCase();
}

export function createProjectMaterialScope(projectId: string, filePaths: string[] = []): ProjectMaterialScope {
  return {
    projectId,
    allowedFilePaths: [...new Set(filePaths.filter(Boolean).map(normalizeScopePath))],
  };
}

export function isScopeEnforced(scope?: ProjectMaterialScope) {
  return Boolean(scope?.allowedFilePaths.length);
}

export function sourceInProjectScope(sourcePath: string | undefined, scope?: ProjectMaterialScope) {
  if (!isScopeEnforced(scope)) return true;
  if (!sourcePath) return false;
  const normalized = normalizeScopePath(sourcePath);
  return scope!.allowedFilePaths.includes(normalized);
}

export function filterEvidenceByProjectScope(items: DocumentEvidence[], scope?: ProjectMaterialScope) {
  return items.filter(item => sourceInProjectScope(item.filePath, scope));
}

export function filterFactsByProjectScope<T extends DocumentFact | StructuredTableFact>(items: T[], scope?: ProjectMaterialScope) {
  return items.filter(item => sourceInProjectScope(item.sourceFile, scope));
}

export function projectScopeAudit(items: Array<Pick<DocumentEvidence, 'filePath' | 'chapterId' | 'roleId' | 'sectionTitle'>>, scope?: ProjectMaterialScope) {
  return items.map(item => ({
    chapterId: item.chapterId,
    roleId: item.roleId,
    sectionTitle: item.sectionTitle,
    sourcePath: item.filePath,
    allowed: sourceInProjectScope(item.filePath, scope),
  }));
}

export function assertEvidenceInProjectScope(items: DocumentEvidence[], scope: ProjectMaterialScope, context: string) {
  if (!isScopeEnforced(scope)) return;
  const outOfScope = items.filter(item => !sourceInProjectScope(item.filePath, scope));
  if (outOfScope.length > 0) {
    const sample = outOfScope.slice(0, 5).map(item => item.filePath).join('；');
    throw new Error(`EVIDENCE_SCOPE_VIOLATION:${context}:${sample}`);
  }
}
