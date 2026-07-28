/** 文档角色的资源类型：文件角色负责资料理解，提示词角色负责编排执行。 */
export type DocumentRoleType = 'file' | 'prompt';

/** 提示词角色参与文档生成流水线时的执行阶段。 */
export type PromptExecutionType = 'fact_extraction' | 'chapter_generation' | 'llm_review' | 'validation' | 'formatting' | 'reference';

/** 文件角色在资料理解阶段的处理策略。 */
export type FileProcessingType = 'rule' | 'table' | 'drawing' | 'specification' | 'reference';

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
  processingType?: FileProcessingType;
}

/** 项目角色配置中的有序角色引用。 */
export interface ProjectRoleItem {
  roleId: string;
  order: number;
}

/** 一组用于文档生成的文件角色和提示词角色编排。 */
export interface ProjectRoleConfig {
  id: string;
  name: string;
  description: string;
  fileRoles: ProjectRoleItem[];
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
