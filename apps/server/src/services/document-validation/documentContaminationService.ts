import type { ValidationIssue } from '../document-workflow/types';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';

function normalizedIncludes(text: string, term: string) {
  return text.replace(/\s+/gu, '').includes(term.replace(/\s+/gu, ''));
}

export function validateProjectContamination(markdown: string, summary: ProjectMaterialSummary): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const currentNames = new Set([summary.projectName, ...summary.fingerprint.projectNames].filter(Boolean));
  for (const candidate of summary.contaminationCandidates) {
    if (candidate.length >= 6 && !currentNames.has(candidate) && normalizedIncludes(markdown, candidate)) {
      issues.push({ level: 'error', message: `正文疑似混入其他对象名称：${candidate}`, suggestion: '请检查绑定材料选择、模板绑定文件和知识库证据范围。' });
    }
  }
  const documentNos = summary.fingerprint.documentNos;
  const foreignDocumentNo = markdown.match(/\b\d{4}[A-Z]{2,}\d{4,}\b/gu)?.find(no => !documentNos.includes(no));
  if (foreignDocumentNo && documentNos.length > 0) issues.push({ level: 'error', message: `正文疑似混入其他文档编号：${foreignDocumentNo}`, suggestion: '请重新生成并检查是否召回了其他绑定材料。' });
  return issues;
}
