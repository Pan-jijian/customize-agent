import type { ValidationIssue } from './documentWorkflowService';
import type { ProjectMaterialSummary } from './projectMaterialService';
import type { AutoDocumentSpecPackage } from './autoDocumentSpecTypes';

export function validateDraftWithAutoSpec(input: {
  markdown: string;
  spec: AutoDocumentSpecPackage;
  summary: ProjectMaterialSummary;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const markdown = input.markdown || '';
  for (const field of input.spec.factFields.filter(field => field.required)) {
    if (!markdown.includes(field.name) && field.name.length >= 3) {
      issues.push({ level: 'warning', message: `后台自动规范提示：正文可能未显式覆盖“${field.name}”`, suggestion: '建议检查对应章节是否已自然表达该事实。' });
    }
  }
  const projectName = input.summary.facts.projectName;
  if (projectName && projectName !== '当前知识库项目' && !markdown.includes(projectName)) {
    issues.push({ level: 'warning', message: '正文未明显体现项目名称', suggestion: '建议在工程概况或首页标题中体现当前项目名称。' });
  }
  const tenderNo = input.summary.facts.tenderNo;
  if (tenderNo && !markdown.includes(tenderNo)) {
    issues.push({ level: 'info', message: '正文未体现招标/项目编号', suggestion: '如正式文件需要编号，请在工程概况中补充。' });
  }
  const forbidden = ['知识库证据', '文件角色', '提示词角色', '文档规范包', '规范包', '后台自动规范', '资料未提供', '未检索到'];
  for (const text of forbidden) {
    if (markdown.includes(text)) issues.push({ level: 'error', message: `正文包含后台流程话术：${text}`, suggestion: '请重新生成或在审查阶段删除后台流程描述。' });
  }
  return issues;
}
