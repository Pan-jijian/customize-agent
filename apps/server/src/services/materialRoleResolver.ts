import type { DocumentTemplate } from './documentWorkflowService';
import type { ProjectMaterialSummary, MaterialRole } from './projectMaterialService';
import { applyKeywordRules, MATERIAL_ROLE_RULES } from './documentSemanticRules';

export interface ResolvedMaterialRole {
  role: MaterialRole;
  required: boolean;
  satisfied: boolean;
  weak: boolean;
  evidenceCount: number;
  filePaths: string[];
  reason: string;
}

function rolesFromTemplate(template: DocumentTemplate): MaterialRole[] {
  const text = [template.name, template.description, template.outputTitle, ...template.chapters.flatMap(chapter => [chapter.title, chapter.purpose, ...(chapter.requiredFacts || []), ...(chapter.queries || [])])].join('\n');
  const roles = new Set<MaterialRole>(applyKeywordRules(text, MATERIAL_ROLE_RULES));
  roles.add('project_overview');
  roles.add('construction_scope');
  return [...roles];
}

function requiredRoleSet(template: DocumentTemplate) {
  const text = [template.name, template.category, template.description, template.outputTitle].join('\n');
  const required = new Set<MaterialRole>(['project_overview', 'construction_scope']);
  if (/投标|招标|施工|工程|建设|改造/iu.test(text)) ['tender_document', 'bill_of_quantities', 'schedule_quality_safety'].forEach(role => required.add(role as MaterialRole));
  if (/图纸|施工|工程|建设|改造/iu.test(text)) required.add('drawings');
  return required;
}

export function resolveTemplateMaterialRoles(template: DocumentTemplate, summary: ProjectMaterialSummary): ResolvedMaterialRole[] {
  const requiredRoles = requiredRoleSet(template);
  return rolesFromTemplate(template).map(role => {
    const files = summary.materialInventory[role] || [];
    const required = requiredRoles.has(role);
    const satisfied = files.length > 0;
    const weak = satisfied && files.length < (required ? 2 : 1);
    return {
      role,
      required,
      satisfied,
      weak,
      evidenceCount: files.length,
      filePaths: files.slice(0, 20).map(file => file.filePath),
      reason: satisfied ? `已匹配 ${files.length} 个资料文件` : required ? '必需资料角色缺失' : '可选资料角色缺失',
    };
  });
}

export function materialRoleSatisfactionRate(resolved: ResolvedMaterialRole[]) {
  return resolved.length ? resolved.filter(item => item.satisfied).length / resolved.length : 1;
}
