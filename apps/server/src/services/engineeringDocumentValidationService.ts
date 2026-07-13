import type { ValidationIssue, DocumentDraftChapter } from './documentWorkflowService';
import type { ProjectMaterialSummary } from './projectMaterialService';
import type { ResolvedMaterialRole } from './materialRoleResolver';

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
  const tenderNos = summary.fingerprint.tenderNos;
  const foreignTenderNo = markdown.match(/\b\d{4}[A-Z]{2,}\d{4,}\b/gu)?.find(no => !tenderNos.includes(no));
  if (foreignTenderNo && tenderNos.length > 0) issues.push({ level: 'error', message: `正文疑似混入其他项目编号：${foreignTenderNo}`, suggestion: '请重新生成并检查是否召回了其他项目资料。' });
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
    if (!role.satisfied) issues.push({ level: 'error', message: `工程专项资料角色缺失：${role.role}`, suggestion: '请补充对应项目资料或调整模板角色绑定。' });
    else if (role.weak) issues.push({ level: 'warning', message: `工程专项资料角色证据较弱：${role.role}`, suggestion: '建议补充更多同类资料以提高正式文件可靠性。' });
  }
  const specialtyNames = input.summary.facts.professionalScopes || [];
  for (const name of specialtyNames.slice(0, 10)) {
    if (name.length >= 4 && !normalizedIncludes(text, name)) {
      issues.push({ level: 'warning', message: `正文可能未覆盖资料中的专业/范围：${name}`, suggestion: '建议检查施工范围、施工方法或资源配置章节。' });
    }
  }
  const chapterTitles = input.chapters.map(chapter => chapter.title).join('、');
  if (/施工组织|施工方案|技术标|施工/iu.test(text + chapterTitles)) {
    const requiredConcepts = ['质量', '安全', '进度'];
    for (const concept of requiredConcepts) {
      if (!text.includes(concept) && !chapterTitles.includes(concept)) issues.push({ level: 'warning', message: `施工类正式文件缺少“${concept}”控制内容`, suggestion: `建议补充${concept}管理目标、措施和责任体系。` });
    }
  }
  return issues;
}
