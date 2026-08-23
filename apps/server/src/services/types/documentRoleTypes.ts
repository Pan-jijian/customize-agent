/** 文档角色资源类型：仅保留提示词角色；项目资料由项目资料包自动识别。 */
export type DocumentRoleType = 'prompt';

/** 提示词角色参与文档生成流水线时的执行阶段。 */
export type PromptExecutionType = 'fact_extraction' | 'chapter_generation' | 'llm_review' | 'validation' | 'formatting' | 'reference';

/** 可被模板或项目配置引用的文档角色。 */
export interface DocumentRole {
  id: string;
  name: string;
  description: string;
  type: DocumentRoleType;
  resourceId?: string;
  resourceIds?: string[];
  builtIn?: boolean;
  executionType?: PromptExecutionType;
}

/** 项目角色配置中的有序角色引用。 */
export interface ProjectRoleItem {
  roleId: string;
  order: number;
}

/** 一组用于文档生成的提示词角色编排。 */
export interface ProjectRoleConfig {
  id: string;
  name: string;
  description: string;
  promptRoles: ProjectRoleItem[];
  builtIn?: boolean;
}

/** 文档角色导入/导出文件格式。 */
export interface DocumentRolesExportFile {
  type: 'customize-agent.documentRoles';
  version: 1;
  exportedAt: string;
  roles: DocumentRole[];
  configs: ProjectRoleConfig[];
}

/** 文档角色持久化存储结构。 */
export interface RoleStore {
  roles: DocumentRole[];
  configs: ProjectRoleConfig[];
}
