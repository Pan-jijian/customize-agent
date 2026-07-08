import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DEFAULT_CATEGORY_DIRS, KNOWLEDGE_BASE_DIR, USER_DATA_DIR } from '../constants.js';
import type { ProjectConfig } from '../types.js';
import { computeProjectId } from './project-id.js';

/** 获取项目配置文件路径 */
export function getProjectConfigPath(projectRoot: string, storageRoot = path.join(os.homedir(), USER_DATA_DIR)): string {
  const projectId = computeProjectId(projectRoot);
  return path.join(storageRoot, 'projects', projectId, 'project.json');
}

/** 获取项目知识库目录路径 */
export function getProjectKbPath(projectRoot: string): string {
  return path.join(projectRoot, KNOWLEDGE_BASE_DIR);
}

const DEFAULT_CUSTOMIZE_MD = `# Customize Agent 配置示例

你可以在这个文件里描述本项目希望 Agent 遵守的角色、规则和工作方式。

## Agent 角色
你是本项目的工程助手，请优先理解现有代码结构，再进行修改。

## 工作规则
- 修改代码前先阅读相关文件。
- 保持改动简单、直接、可验证。
- 不要覆盖用户已有文件或未确认的业务逻辑。
- 涉及知识库资料时，通过知识库检索使用解析后的内容，不直接读取 knowledgeBase 原始文件。

## 项目偏好
- 使用中文回复。
- 重要改动完成后运行必要的类型检查或构建检查。
`;

/** 确保项目存在 CUSTOMIZE.md 文件（如不存在则创建默认模板） */
export function ensureProjectCustomizeFile(projectRoot: string): void {
  const filePath = path.join(projectRoot, 'CUSTOMIZE.md');
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(filePath, DEFAULT_CUSTOMIZE_MD, 'utf8');
  }
}

/** 项目配置管理器，负责加载和保存项目配置 */
export class ProjectConfigManager {
  constructor(private readonly storageRoot = path.join(os.homedir(), USER_DATA_DIR)) {}

  loadOrCreate(projectRoot: string): ProjectConfig {
    ensureProjectCustomizeFile(projectRoot);
    const configPath = getProjectConfigPath(projectRoot, this.storageRoot);
    const now = Date.now();

    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<ProjectConfig>;
      return this.withDefaults(projectRoot, raw, now);
    }

    const config = this.withDefaults(projectRoot, {}, now);
    this.save(projectRoot, config);
    return config;
  }

  save(projectRoot: string, config: ProjectConfig): void {
    const configPath = getProjectConfigPath(projectRoot, this.storageRoot);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  private withDefaults(projectRoot: string, raw: Partial<ProjectConfig>, now: number): ProjectConfig {
    return {
      projectId: raw.projectId ?? computeProjectId(projectRoot),
      projectName: raw.projectName ?? path.basename(path.resolve(projectRoot)),
      enabled: raw.enabled ?? true,
      includeGlobal: raw.includeGlobal ?? true,
      priorityOverGlobal: raw.priorityOverGlobal ?? true,
      watch: raw.watch ?? true,
      autoIndex: raw.autoIndex ?? true,
      kbignore: raw.kbignore ?? [],
      projectTags: raw.projectTags ?? [],
      categoryDirs: { ...DEFAULT_CATEGORY_DIRS, ...(raw.categoryDirs ?? {}) },
      createdAt: raw.createdAt ?? now,
      lastOpenedAt: raw.lastOpenedAt ?? now,
    };
  }
}
