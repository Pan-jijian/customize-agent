import { type Capability, type SubagentRole, roleHasCapability, TOOL_CAPABILITY_MAP } from './capability.js';

/** 权限判定结果 */
export type Permission = 'allow' | 'deny' | 'ask';

/** 路径模式规则 */
interface PathRule {
  pattern: string;
  permission: Permission;
}

/** 命令模式规则 */
interface CommandRule {
  pattern: string;
  permission: Permission;
}

/** 权限配置结构 */
export interface PermissionConfig {
  defaults: Record<string, Permission>;
  rules?: Array<{
    toolName: string;
    pathPatterns?: PathRule[];
    commandPatterns?: CommandRule[];
  }>;
  roles?: Partial<Record<SubagentRole, Capability[]>>;
}

/** 内置默认权限配置 */
const DEFAULT_CONFIG: PermissionConfig = {
  defaults: {
    read_file: 'allow',
    list_files: 'allow',
    search: 'allow',
    write_file: 'ask',
    execute_command: 'ask',
    git_commit: 'ask',
    inspect_file: 'allow',
    extract_text: 'allow',
    extract_pdf_text: 'allow',
    extract_docx_text: 'allow',
    extract_xlsx_data: 'allow',
    tree: 'allow',
    glob: 'allow',
    repo_map: 'allow',
    git_status: 'allow',
    git_log: 'allow',
    git_diff: 'allow',
    ocr_image: 'allow',
    transcribe_audio: 'allow',
    video_metadata: 'allow',
  },
  rules: [
    {
      toolName: 'read_file',
      pathPatterns: [
        // 安全敏感文件
        { pattern: '.env', permission: 'deny' },
        { pattern: '*.key', permission: 'deny' },
        { pattern: '**/secrets/**', permission: 'deny' },
        { pattern: '**/*.key', permission: 'deny' },
        { pattern: '**/*secret*', permission: 'deny' },
        { pattern: '**/credentials*', permission: 'deny' },
        // Agent 自身实现代码（不应在执行任务时暴露）
        { pattern: 'packages/tools/src/sandbox/**', permission: 'deny' },
        { pattern: 'packages/engine/src/security/**', permission: 'deny' },
        { pattern: 'packages/llm/src/providers/**', permission: 'deny' },
        { pattern: 'apps/cli/src/engine/executor.ts', permission: 'deny' },
      ],
    },
    {
      toolName: 'execute_command',
      commandPatterns: [
        // ── allow: 安全只读命令 ──
        { pattern: 'ls**', permission: 'allow' },
        { pattern: 'find**', permission: 'allow' },
        { pattern: 'cat**', permission: 'allow' },
        { pattern: 'head**', permission: 'allow' },
        { pattern: 'tail**', permission: 'allow' },
        { pattern: 'wc**', permission: 'allow' },
        { pattern: 'grep**', permission: 'allow' },
        { pattern: 'git status**', permission: 'allow' },
        { pattern: 'git diff**', permission: 'allow' },
        { pattern: 'git log**', permission: 'allow' },
        { pattern: 'git branch**', permission: 'allow' },
        { pattern: 'pwd**', permission: 'allow' },
        { pattern: 'echo**', permission: 'allow' },
        { pattern: 'which**', permission: 'allow' },
        { pattern: 'file**', permission: 'allow' },
        { pattern: 'stat**', permission: 'allow' },
        { pattern: 'du**', permission: 'allow' },
        { pattern: 'df**', permission: 'allow' },
        { pattern: 'env**', permission: 'allow' },
        { pattern: 'printenv**', permission: 'allow' },
        // ── allow: 构建/测试命令 ──
        { pattern: 'pnpm**', permission: 'allow' },
        { pattern: 'npm**', permission: 'allow' },
        { pattern: 'yarn**', permission: 'allow' },
        { pattern: 'tsc**', permission: 'allow' },
        { pattern: 'node**', permission: 'allow' },
        { pattern: 'python**', permission: 'allow' },
        { pattern: 'python3**', permission: 'allow' },
        { pattern: 'cargo**', permission: 'allow' },
        { pattern: 'go**', permission: 'allow' },
        { pattern: 'make**', permission: 'allow' },
        { pattern: 'cmake**', permission: 'allow' },
        // ── deny: 危险命令 ──
        { pattern: 'rm -rf /*', permission: 'deny' },
        { pattern: 'rm -rf ~/**', permission: 'deny' },
        { pattern: 'mkfs.*', permission: 'deny' },
        { pattern: '> /etc/*', permission: 'deny' },
        { pattern: 'dd if=*', permission: 'deny' },
        { pattern: 'curl** | **sh**', permission: 'deny' },
        { pattern: 'wget** | **sh**', permission: 'deny' },
      ],
    },
  ],
};

/**
 * 权限引擎 — Capability 级别的权限检查。
 *
 * 三层模型：
 *   - allow: 直接执行，不打扰用户
 *   - deny:  拒绝执行，返回原因
 *   - ask:   展示预览，等待用户确认
 *
 * 匹配优先级：命令/路径规则 > 角色 Capability 绑定 > 默认配置
 */
export class PermissionEngine {
  private config: PermissionConfig;

  constructor(config?: PermissionConfig) {
    this.config = config ?? DEFAULT_CONFIG;
  }

  /** 合并外部配置（项目级覆盖默认值） */
  mergeConfig(external: Partial<PermissionConfig>): void {
    if (external.defaults) {
      this.config.defaults = { ...this.config.defaults, ...external.defaults };
    }
    if (external.rules) {
      this.config.rules = [...(this.config.rules ?? []), ...external.rules];
    }
    if (external.roles) {
      this.config.roles = { ...this.config.roles, ...external.roles };
    }
  }

  /**
   * 检查工具是否被允许执行。
   * @param toolName 工具名称
   * @param args 工具参数（用于路径/命令模式匹配）
   * @param role 可选：子智能体角色（角色限制优先）
   */
  check(toolName: string, args: Record<string, unknown> = {}, role?: SubagentRole): Permission {
    // 1. 角色 Capability 绑定优先 — 角色没有对应 Capability → deny
    if (role) {
      const toolCapabilities = this._getToolCapability(toolName);
      if (toolCapabilities.length > 0) {
        const hasAll = toolCapabilities.every(c => roleHasCapability(role, c));
        if (!hasAll) {
          return 'deny';
        }
      }
    }

    // 2. 检查文件路径模式规则（支持多个常见路径参数名）
    const filePath = (args.path ?? args.input ?? args.file ?? args.source) as string | undefined;
    if (filePath) {
      const pathResult = this._matchPathRule(toolName, filePath);
      if (pathResult) return pathResult;
    }

    // 3. 检查命令模式规则
    const command = args.input as string | undefined;
    if (command) {
      const cmdResult = this._matchCommandRule(toolName, command);
      if (cmdResult) return cmdResult;
    }

    // 4. 回退到默认配置
    return this.config.defaults[toolName] ?? 'ask';
  }

  /** 获取工具对应的 Capability */
  private _getToolCapability(toolName: string): Capability[] {
    return TOOL_CAPABILITY_MAP[toolName] ?? [];
  }

  /** 文件路径模式匹配（glob 风格，支持 ** 和 *） */
  private _matchPathRule(toolName: string, filePath: string): Permission | null {
    const rules = this.config.rules?.find(r => r.toolName === toolName);
    if (!rules?.pathPatterns) return null;

    for (const rule of rules.pathPatterns) {
      if (this._matchGlob(filePath, rule.pattern)) {
        return rule.permission;
      }
    }
    return null;
  }

  /** 命令模式匹配（contains 语义：命令字符串中任一位置包含危险模式即命中） */
  private _matchCommandRule(toolName: string, command: string): Permission | null {
    const rules = this.config.rules?.find(r => r.toolName === toolName);
    if (!rules?.commandPatterns) return null;

    for (const rule of rules.commandPatterns) {
      if (this._matchCommandPattern(command, rule.pattern)) {
        return rule.permission;
      }
    }
    return null;
  }

  /** 命令危险模式匹配 — 使用 contains 而非 exact，例如 "mkfs.ext4 /dev/sda" 应匹配 "mkfs.*" */
  private _matchCommandPattern(command: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/[.+^${}()|[\\]/g, '\\$&')
      .replace(/\*\*/g, '<<<GLOBSTAR>>>')
      .replace(/\*/g, '[^\\s]*')
      .replace(/<<<GLOBSTAR>>>/g, '.*');
    return new RegExp(regexStr, 'i').test(command);
  }

  /** glob 匹配（exact 语义，用于路径匹配，支持 ** 和 * 通配符） */
  private _matchGlob(input: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/[.+^${}()|[\\]/g, '\\$&')
      .replace(/\*\*/g, '<<<GLOBSTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<GLOBSTAR>>>/g, '.*');

    return new RegExp(`^${regexStr}$`, 'i').test(input);
  }

  /** 获取默认权限配置 */
  static defaultConfig(): PermissionConfig {
    return structuredClone(DEFAULT_CONFIG);
  }
}
