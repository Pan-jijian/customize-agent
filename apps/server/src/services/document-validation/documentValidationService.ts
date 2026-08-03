import type { ValidationIssue } from '../document-workflow/types';
import type { ProjectMaterialSummary } from '../document-core/projectMaterialService';
import type { AutoDocumentSpecPackage } from '../document-core/autoDocumentSpecTypes';

function looksLikePathBundleName(value: string) {
  return /--|延期到|资料|附件|扫描|目录|汇总|打包|备份|\d{1,2}\.\d{1,2}/u.test(value);
}

function normalizeText(value: string) {
  return value.replace(/[（(]\d+[）)]/gu, '').replace(/副本|最终版|扫描件|定稿/gu, '').replace(/[\s，。,.;；：:《》“”‘’()（）_-]+/gu, '').toLowerCase();
}

function textContainsNormalized(markdown: string, value: string) {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length < 4) return true;
  const normalizedMarkdown = normalizeText(markdown);
  if (normalizedMarkdown.includes(normalized)) return true;
  return normalized.length >= 12 && normalizedMarkdown.includes(normalized.slice(0, Math.max(8, Math.floor(normalized.length * 0.72))));
}

function shouldWarnMissingFactField(name: string) {
  if (name.length < 4 || looksLikePathBundleName(name)) return false;
  return /\d|GB|JGJ|C\d|HRB|DN|mm|MPa|kPa|工期|质量|安全|项目名称|工程名称|招标人|建设地点|建筑面积|结构形式|层数/u.test(name);
}

export function validateDraftWithAutoSpec(input: {
  markdown: string;
  spec: AutoDocumentSpecPackage;
  summary: ProjectMaterialSummary;
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const markdown = input.markdown || '';
  for (const field of input.spec.factFields.filter(field => field.required)) {
    if (shouldWarnMissingFactField(field.name) && !textContainsNormalized(markdown, field.name)) {
      issues.push({ level: 'info', message: `正文可能未显式覆盖“${field.name}”`, suggestion: '建议检查对应章节是否已自然表达该事实。' });
    }
  }
  const projectName = input.summary.facts.projectName;
  if (projectName && projectName !== '当前知识库项目' && !looksLikePathBundleName(projectName) && !textContainsNormalized(markdown, projectName)) {
    issues.push({ level: 'warning', message: '正文未明显体现关键对象名称', suggestion: '建议在概况、背景或首页标题中体现当前文档的关键对象名称。' });
  }
  const documentNo = input.summary.facts.documentNo;
  if (documentNo && !markdown.includes(documentNo)) {
    issues.push({ level: 'info', message: '正文未体现文档/任务编号', suggestion: '如文档需要编号，请在概况、背景或首页信息中补充。' });
  }
  const forbidden = ['知识库证据', '文件角色', '提示词角色', '文档规范包', '规范包', '后台自动规范', '后台优化建议', '基础事实候选', '材料未提供', '未检索到'];
  for (const text of forbidden) {
    if (markdown.includes(text)) issues.push({ level: 'error', message: `正文包含后台流程话术：${text}`, suggestion: '请重新生成或在审查阶段删除后台流程描述。' });
  }
  return issues;
}
