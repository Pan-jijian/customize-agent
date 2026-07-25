import type { ValidationIssue, DocumentDraftChapter } from '../document-workflow/types';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';
import type { ResolvedMaterialRole } from '../document-core/materialRoleResolver';

function normalizedIncludes(text: string, term: string) {
  return text.replace(/\s+/gu, '').includes(term.replace(/\s+/gu, ''));
}

export function validateProjectContamination(markdown: string, summary: ProjectMaterialSummary): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const currentNames = new Set([summary.projectName, ...summary.fingerprint.projectNames].filter(Boolean));
  for (const candidate of summary.contaminationCandidates) {
    if (candidate.length >= 6 && !currentNames.has(candidate) && normalizedIncludes(markdown, candidate)) {
      issues.push({ level: 'error', message: `正文疑似混入其他项目名称：${candidate}`, suggestion: '请检查项目资料组选择、模板绑定文件和知识库证据范围。' });
    }
  }
  const documentNos = summary.fingerprint.documentNos;
  const foreignDocumentNo = markdown.match(/\b\d{4}[A-Z]{2,}\d{4,}\b/gu)?.find(no => !documentNos.includes(no));
  if (foreignDocumentNo && documentNos.length > 0) issues.push({ level: 'error', message: `正文疑似混入其他项目编号：${foreignDocumentNo}`, suggestion: '请重新生成并检查是否召回了其他项目资料。' });
  return issues;
}

export function validateEngineeringSpecialty(input: {
  markdown: string;
  chapters: DocumentDraftChapter[];
  summary: ProjectMaterialSummary;
  roles: ResolvedMaterialRole[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const text = input.markdown;
  const requiredRoles = input.roles.filter(role => role.required);
  for (const role of requiredRoles) {
    if (!role.satisfied) issues.push({ level: 'error', message: `必需资料角色缺失：${role.role}`, suggestion: '请补充对应项目资料或调整模板角色绑定。' });
    else if (role.weak) issues.push({ level: 'warning', message: `必需资料角色证据较弱：${role.role}`, suggestion: '建议补充更多同类资料以提高正式文件可靠性。' });
  }
  const specialtyNames = input.summary.facts.professionalScopes || [];
  for (const name of specialtyNames.slice(0, 10)) {
    if (name.length >= 4 && !normalizedIncludes(text, name)) {
      issues.push({ level: 'warning', message: `正文可能未覆盖资料中的专业/范围：${name}`, suggestion: '建议检查范围、方法、流程或资源配置章节。' });
    }
  }
  const chapterTitles = input.chapters.map(chapter => chapter.title).join('、');
  if (/专项|安全|质量|进度|合规|审计|风控|风险/iu.test(text + chapterTitles)) {
    const requiredConcepts = ['质量', '安全', '进度'];
    for (const concept of requiredConcepts) {
      if (!text.includes(concept) && !chapterTitles.includes(concept)) issues.push({ level: 'warning', message: `正式文件缺少“${concept}”控制内容`, suggestion: `建议补充${concept}目标、措施和责任体系。` });
    }
  }
  return issues;
}
