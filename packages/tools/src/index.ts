// @customize-agent/tools — Agent 工具集

// 核心基础设施
export { WorkspaceFs } from './core/workspace-fs.js';
export { WorkspaceSnapshotService, type WorkspaceSnapshot, type SerializedWorkspaceSnapshot } from './core/workspace-snapshot.js';
export { resolveSafe, walk } from './core/path-utils.js';
export { SKIP_DIRS } from './core/constants.js';

// 沙箱
export { SandboxExecutor, type SandboxMode, type SandboxResult } from './sandbox/sandbox-executor.js';

// 编辑工具
export { DiffEngine, type DiffBlock } from './editing/diff.js';
export { UnifiedSyntaxValidator, type SyntaxValidationResult, type ValidationError } from './editing/syntax-validator.js';

// 内置工具（按领域拆分）
export {
  FileTools,
  SearchTools,
  ShellTools,
  WebTools,
  ExportTools,
  MediaTools,
  McpTools,
  CheckpointTools,
} from './builtins/index.js';

// BuiltinTools 外观类（向后兼容 CLI tool-registry）
export { BuiltinTools } from './builtins-facade.js';

// ToolKit 高质量文件操作（.gitignore 感知 + 备份/回滚 + 语法验证）
export { ToolKit } from './toolkit.js';

// 声明式工具定义
export type { ToolDef, ToolParamDef } from './tool-def.js';

// 平台抽象层（跨平台 Shell、进程管理、二进制解析）
export { executeCommand, spawnBackground, translateCommand, getShellConfig } from './core/platform/shell.js';
export { killProcess, onCleanup } from './core/platform/process.js';
export { resolveBinary } from './core/platform/binary.js';
export type { Platform, ShellConfig, ShellResult, ProcessReference } from './core/platform/types.js';
export { isWindows, isMacOS } from './core/platform/utils.js';
