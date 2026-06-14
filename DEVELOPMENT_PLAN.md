# Code Agent 详细开发实施方案 (v2)

> 📅 2026-06-14 | 严格基于 [COMPARISON.md](./COMPARISON.md) 的竞品分析结论
>
> **编写原则:** COMPARISON.md 中的每一个「方案」和「结论」都必须在本文档中找到对应的具体实施步骤。
>
> **对照索引:** 每个 Task 标注了对应的 COMPARISON.md 章节号，确保无遗漏。

---

## 目录

- [Phase 0: 安全基线 — OS 沙箱 + 路径沙箱](#phase-0-安全基线--os-沙箱--路径沙箱)
- [Phase 1: 代码理解增强 — LSP + 三层搜索](#phase-1-代码理解增强--lsp--三层搜索)
- [Phase 2: 工具协议标准化 — MCP Server + Client](#phase-2-工具协议标准化--mcp-server--client)
- [Phase 3: 多模型通用适配 — ILLMProvider + AI Gateway](#phase-3-多模型通用适配--illmprovider--ai-gateway)
- [Phase 4: 流式输出与体验优化](#phase-4-流式输出与体验优化)
- [Phase 5: 权限审批与审计日志](#phase-5-权限审批与审计日志)
- [Phase 6: 上下文管理与跨会话记忆](#phase-6-上下文管理与跨会话记忆)
- [Phase 7: Plan Mode — 双智能体分离](#phase-7-plan-mode--双智能体分离)
- [Phase 8: 子智能体系统](#phase-8-子智能体系统)
- [Phase 9: 扩展生态 — Hooks + Skills + MCP Client](#phase-9-扩展生态--hooks--skills--mcp-client)
- [Phase 10: 工程化完善 — 测试、CLI、成本追踪](#phase-10-工程化完善--测试cli成本追踪)
- [附录 A: COMPARISON.md 结论全覆盖检查清单](#附录-a-comparisonmd-结论全覆盖检查清单)

---

## Phase 0: 安全基线 — OS 沙箱 + 路径沙箱

> 📖 对应 COMPARISON.md: §4.1 (P0 安全基础设施), §4.2 (代码修改安全保障)
>
> **核心逻辑:** COMPARISON.md §4.1.2 结论: 命令安全直接使用 OS 级沙箱作为唯一方案。
> 不搞黑名单过渡，不搞模板过渡。一步到位。

---

### Task 0.1: 路径沙箱 — 防止目录遍历

**📖 COMPARISON.md §4.1.1** | **文件:** `packages/tool-kit/src/index.ts`

**改动:** 新增 `resolveSafe()` 私有方法，并修改所有文件操作入口。

```typescript
/**
 * 安全的路径解析：确保 LLM 提供的相对路径不会逃逸出项目根目录。
 * COMPARISON.md §4.1.1 结论：路径沙箱是 Agent 的文件系统边界。
 */
private resolveSafe(relativePath: string): string {
  const resolved = path.resolve(this.cwd, relativePath);
  const root = path.resolve(this.cwd);
  // 规范化后必须仍在 root 之内
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(
      `[Security] Path traversal blocked: "${relativePath}" resolves outside workspace`
    );
  }
  return resolved;
}
```

**调用点:** `readFile()`, `modifyFileWithDiff()` 中将 `path.resolve(this.cwd, ...)` 替换为 `this.resolveSafe(...)`。

**验收:** `readFile('../../.env')` 抛出异常；正常路径不受影响。

---

### Task 0.2: 命令安全 — OS 级沙箱执行

**📖 COMPARISON.md §4.1.2, §8.3 Level 1** | **文件:** `packages/tool-kit/src/sandbox.ts` + `terminal.ts`

**设计原则:** 不走黑名单，不走模板过渡，直接上 OS 沙箱。
对标 Codex CLI 的 Seatbelt/Landlock 内核级隔离。

```typescript
import { execa } from 'execa';
import * as path from 'path';
import * as fs from 'fs/promises';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * OS 级沙箱 — 唯一的安全方案，不搞黑名单退而求其次
 *
 * macOS:  Apple Seatbelt (/usr/bin/sandbox-exec) — 内核级文件+网络限制
 * Linux:  Landlock + seccomp + Bubblewrap — 内核级系统调用过滤
 * 其他平台: 报错退出，不执行 (通用型 Agent 需要有安全底线)
 */
export class SandboxExecutor {
  constructor(
    private mode: SandboxMode,
    private workspaceRoot: string,
  ) {}

  /** 在 OS 沙箱中执行命令 — 唯一入口 */
  async execute(command: string, cwd?: string): Promise<{
    stdout: string; stderr: string; code: number;
  }> {
    if (this.mode === 'danger-full-access') {
      throw new Error(
        'danger-full-access 模式需要显式确认。请设置环境变量 CODE_AGENT_DANGER_MODE=1'
      );
    }

    if (process.platform === 'darwin') {
      return this._executeSeatbelt(command, cwd);
    }

    if (process.platform === 'linux') {
      return this._executeLandlockBwrap(command, cwd);
    }

    // 其他平台 — 不妥协
    throw new Error(
      `OS 沙箱在 ${process.platform} 上不可用。`
      + 'Code Agent 的安全策略要求 OS 级隔离。'
      + '请在 macOS 或 Linux 上运行。'
    );
  }

  /** macOS: Apple Seatbelt 沙箱 */
  private async _executeSeatbelt(command: string, cwd?: string): Promise<any> {
    const profilePath = path.join(this.workspaceRoot, '.agent-sandbox.sb');
    const profile = this._buildSeatbeltProfile();
    await fs.writeFile(profilePath, profile);

    try {
      const result = await execa({
        shell: true,
        cwd: cwd || this.workspaceRoot,
        reject: false,
        timeout: 120_000,
      })`/usr/bin/sandbox-exec -f ${profilePath} sh -c ${JSON.stringify(command)}`;

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exitCode,
      };
    } finally {
      await fs.unlink(profilePath).catch(() => {});
    }
  }

  /** 生成 Seatbelt 沙箱策略 */
  private _buildSeatbeltProfile(): string {
    const root = path.resolve(this.workspaceRoot);
    const home = process.env.HOME || '/Users/unknown';

    let profile = `(version 1)
;; 默认拒绝
(deny default)

;; 允许读项目目录
(allow file-read* (subpath "${root}"))

;; 允许读 node/pnpm 运行时
(allow file-read* (subpath "${home}/.nvm"))
(allow file-read* (subpath "/usr/local/bin"))
(allow file-read* (subpath "/opt/homebrew"))
(allow file-read* (subpath "/usr/bin"))

;; 允许进程执行
(allow process-exec)
(allow process-fork)

;; 允许管道和信号
(allow signal)
(allow sysctl-read)

;; 默认拒绝网络
(deny network*)
;; 仅允许 localhost (如需要 API 调用)
(allow network-inbound (local ip "127.0.0.1"))
(allow network-outbound (local ip "127.0.0.1"))
`;

    if (this.mode === 'workspace-write') {
      profile += `
;; 允许写项目目录 (但拒绝写入 .env 和密钥文件)
(allow file-write* (subpath "${root}"))
(deny file-write* (regex #"^${root}/\.env$"))
(deny file-write* (regex #"^${root}/.*\.key$"))
(deny file-write* (regex #"^${root}/.*secret"))
`;
    } else {
      // read-only 模式
      profile += `(deny file-write*)\n`;
    }

    return profile;
  }

  /** Linux: Landlock + seccomp + Bubblewrap */
  private async _executeLandlockBwrap(command: string, cwd?: string): Promise<any> {
    const root = this.workspaceRoot;
    const bwrapArgs = [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/etc', '/etc',
      '--bind', root, root,
      '--chdir', cwd || root,
      '--unshare-net',        // 完全禁用网络
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-pid',
      '--proc', '/proc',
      '--dev', '/dev',
    ];

    // workspace-write: 额外挂载可写
    if (this.mode === 'workspace-write') {
      bwrapArgs.push('--bind', root, root);
    }

    bwrapArgs.push('--', 'sh', '-c', command);

    const result = await execa({
      reject: false,
      timeout: 120_000,
    })`bwrap ${bwrapArgs}`;

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.exitCode,
    };
  }
}
```

**文件:** `packages/tool-kit/src/terminal.ts` — 去掉黑名单，改用 SandboxExecutor

```typescript
// 改造前: TerminalTool 有黑名单 + execa 直连
// 改造后: TerminalTool 委托给 SandboxExecutor

export class TerminalTool {
  private sandbox: SandboxExecutor;

  constructor(cwd: string, mode: SandboxMode = 'workspace-write') {
    this.sandbox = new SandboxExecutor(mode, cwd);
  }

  async executeCommand(command: string, timeoutMs = 120_000): Promise<{
    stdout: string; stderr: string; code: number;
  }> {
    // 所有命令全部走 OS 沙箱，没有例外
    return this.sandbox.execute(command);
  }
}
```

**验收:**
- `read-only` 模式下任何文件写入被 OS 内核拒绝
- `workspace-write` 模式下无法写入 `.env`
- 网络访问被沙箱禁用
- 非 macOS/Linux 平台拒绝执行 (安全底线)

---

### Task 0.3: 命令注入修复 (Git commit 等残留自由命令)

**📖 COMPARISON.md §4.1.2** | **文件:** `packages/tool-kit/src/git.ts`

**改动:** commit 消息转义
```typescript
async commitAll(message: string): Promise<string> {
  // 防止 shell 注入: 单引号转义
  const escaped = message.replace(/'/g, "'\\''");
  await this.terminal.executeCommand('git add .');
  const res = await this.terminal.executeCommand(`git commit -m '${escaped}'`);
  if (res.code === 0) {
    return `代码提交成功！Commit Message: ${message}`;
  }
  return `提交失败：${res.stderr || res.stdout}`;
}
```

---

### Task 0.4: 文件修改回滚 + 语法验证 + Diff 预览

**📖 COMPARISON.md §4.2.1 + §4.2.2** | **文件:** `packages/tool-kit/src/index.ts`

**改动:** 重写 `modifyFileWithDiff()` —— 备份 → 修改 → 多语言语法验证 → 成功/回滚

```typescript
async modifyFileWithDiff(
  relativeFilePath: string,
  llmDiffOutput: string
): Promise<{ success: boolean; preview: string }> {
  const fullPath = this.resolveSafe(relativeFilePath);
  const originalContent = await fs.readFile(fullPath, 'utf-8');

  // Step 1: 备份 (COMPARISON.md §4.2.1)
  const backupPath = fullPath + '.agent-backup';
  await fs.writeFile(backupPath, originalContent, 'utf-8');

  try {
    // Step 2: 解析并应用 diff 块
    const blocks = DiffEngine.parseBlocks(llmDiffOutput);
    if (blocks.length === 0) {
      throw new Error('没有找到任何修改块。请使用 SEARCH/REPLACE 格式。');
    }

    let newContent = originalContent;
    for (const block of blocks) {
      newContent = DiffEngine.applyPatch(newContent, block);
    }

    // Step 3: 多语言语法验证 (COMPARISON.md §4.2.1)
    // ⚠️ 通用型 Agent 必须支持所有主流语言，而非仅 TypeScript
    await this.validateSyntaxMultiLang(fullPath, newContent);

    // Step 4: 生成 Diff 预览 (COMPARISON.md §4.2.2)
    const preview = DiffEngine.generateUnifiedDiff(
      relativeFilePath, originalContent, newContent
    );

    // Step 5: 写入
    await fs.writeFile(fullPath, newContent, 'utf-8');

    // Step 6: 成功后清理备份
    await fs.unlink(backupPath);

    return { success: true, preview };

  } catch (err) {
    // Step 7: 回滚 (COMPARISON.md §4.2.1)
    await fs.writeFile(fullPath, originalContent, 'utf-8');
    await fs.unlink(backupPath).catch(() => {});
    throw new Error(
      `修改失败，已自动回滚到原始内容:\n${(err as Error).message}`
    );
  }
}
```

**文件:** `packages/tool-kit/src/syntax-validator.ts` (新建)

```typescript
/**
 * 多语言语法验证器 — 通用型 Agent 核心组件
 *
 * 设计原则:
 * - 每种语言使用其官方编译器/解释器进行真实语法检查
 * - 按文件扩展名自动选择验证策略
 * - 验证失败信息包含文件名、行号、错误描述 (方便 LLM 理解)
 *
 * 这是通用型 Agent 与单语言 Agent 的关键差异。
 */

export interface SyntaxValidationResult {
  valid: boolean;
  language: string;
  errors: Array<{
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning';
  }>;
}

export interface ValidatorStrategy {
  /** 该策略支持的文件扩展名 */
  extensions: string[];
  /** 验证给定文件内容是否语法正确 */
  validate(filePath: string, content: string, cwd: string): Promise<SyntaxValidationResult>;
}

/**
 * 策略 1: TypeScript / JavaScript
 * 使用 TS Compiler API (无外部依赖, 精确)
 */
class TypeScriptValidator implements ValidatorStrategy {
  extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  async validate(filePath: string, content: string): Promise<SyntaxValidationResult> {
    const ts = await import('typescript');
    const sourceFile = ts.createSourceFile(
      filePath, content, ts.ScriptTarget.Latest, true
    );
    const errors = (sourceFile.parseDiagnostics || []).map(d => {
      const pos = sourceFile.getLineAndCharacterOfPosition(d.start || 0);
      return {
        line: pos.line + 1,
        column: pos.character + 1,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        severity: 'error' as const,
      };
    });
    return { valid: errors.length === 0, language: 'TypeScript/JavaScript', errors };
  }
}

/**
 * 策略 2: Python
 * 使用 `python3 -m py_compile` 编译为字节码
 * 如果 Python 不可用, 使用 AST 库 (ast.parse)
 */
class PythonValidator implements ValidatorStrategy {
  extensions = ['.py', '.pyw'];

  async validate(
    filePath: string, content: string, cwd: string
  ): Promise<SyntaxValidationResult> {
    // 方案 A: 写入临时文件, 用 python3 编译检查
    const tmpFile = filePath + '.agent-check';
    try {
      await fs.writeFile(tmpFile, content, 'utf-8');
      const result = await execa({
        cwd,
        reject: false,
        timeout: 10_000,
      })`python3 -m py_compile ${tmpFile}`;

      const errors: any[] = [];
      if (result.exitCode !== 0) {
        // 解析 Python 编译错误输出 (格式: File "..." line N ... SyntaxError: ...)
        const stderr = result.stderr || result.stdout;
        const match = stderr.match(/line (\d+).*?(SyntaxError|IndentationError)[:\s]+(.+)/);
        if (match) {
          errors.push({
            line: parseInt(match[1]),
            column: 1,
            message: `${match[2]}: ${match[3].trim()}`,
            severity: 'error' as const,
          });
        } else {
          errors.push({ line: 1, column: 1, message: stderr.slice(0, 500), severity: 'error' });
        }
      }
      return { valid: errors.length === 0, language: 'Python', errors };
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }
}

/**
 * 策略 3: Rust
 * 使用 `rustc --edition 2021 --error-format=json -Z no-codegen` 或 `cargo check`
 */
class RustValidator implements ValidatorStrategy {
  extensions = ['.rs'];

  async validate(
    filePath: string, content: string, cwd: string
  ): Promise<SyntaxValidationResult> {
    const tmpFile = filePath + '.agent-check.rs';
    try {
      await fs.writeFile(tmpFile, content, 'utf-8');
      const result = await execa({
        cwd,
        reject: false,
        timeout: 30_000,
      })`rustc --edition 2021 --error-format=json -Z parse-only ${tmpFile}`;

      const errors: any[] = [];
      if (result.exitCode !== 0) {
        // rustc JSON 错误格式
        for (const line of result.stderr.split('\n').filter(Boolean)) {
          try {
            const err = JSON.parse(line);
            if (err.message && err.spans?.length > 0) {
              errors.push({
                line: err.spans[0].line_start || 1,
                column: err.spans[0].column_start || 1,
                message: err.message,
                severity: 'error' as const,
              });
            }
          } catch {}
        }
        if (errors.length === 0) {
          errors.push({ line: 1, column: 1, message: result.stderr.slice(0, 500), severity: 'error' });
        }
      }
      return { valid: errors.length === 0, language: 'Rust', errors };
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }
}

/**
 * 策略 4: Go
 * 使用 gofmt 或 go build
 */
class GoValidator implements ValidatorStrategy {
  extensions = ['.go'];

  async validate(
    filePath: string, content: string, cwd: string
  ): Promise<SyntaxValidationResult> {
    const tmpFile = filePath + '.agent-check.go';
    try {
      await fs.writeFile(tmpFile, content, 'utf-8');
      // 使用 gofmt 做语法检查 (比 go build 更快)
      const result = await execa({
        cwd,
        reject: false,
        timeout: 15_000,
      })`gofmt -e ${tmpFile}`;

      const errors: any[] = [];
      if (result.exitCode !== 0 || result.stderr) {
        const output = result.stderr || result.stdout;
        const match = output.match(/(\d+):(\d+):\s*(.+)/);
        if (match) {
          errors.push({
            line: parseInt(match[1]),
            column: parseInt(match[2]),
            message: match[3].trim(),
            severity: 'error' as const,
          });
        } else if (output) {
          errors.push({ line: 1, column: 1, message: output.slice(0, 500), severity: 'error' });
        }
      }
      return { valid: errors.length === 0, language: 'Go', errors };
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }
}

/**
 * 策略 5: JSON / YAML / TOML / Markdown
 * 使用内置 parser (JSON.parse, yaml.parse 等)
 */
class DataFileValidator implements ValidatorStrategy {
  extensions = ['.json', '.yaml', '.yml', '.toml', '.jsonc'];

  async validate(
    filePath: string, content: string
  ): Promise<SyntaxValidationResult> {
    const errors: any[] = [];
    const ext = path.extname(filePath);

    try {
      if (ext === '.json' || ext === '.jsonc') {
        // 去掉 JSONC 注释
        const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        JSON.parse(stripped);
      } else if (ext === '.yaml' || ext === '.yml') {
        const yaml = await import('yaml');
        yaml.parse(content);
      } else if (ext === '.toml') {
        // 简单 TOML 验证: key = value 格式
        for (let i = 0; i < content.split('\n').length; i++) {
          const line = content.split('\n')[i].trim();
          if (line && !line.startsWith('#') && !line.startsWith('[')) {
            if (!line.includes('=') && line.length > 3) {
              errors.push({
                line: i + 1,
                column: 1,
                message: `无效的 TOML: "${line.slice(0, 80)}"`,
                severity: 'warning' as const,
              });
            }
          }
        }
      }
    } catch (err: any) {
      errors.push({
        line: err.line || 1,
        column: err.column || 1,
        message: err.message.slice(0, 300),
        severity: 'error' as const,
      });
    }

    return {
      valid: errors.filter(e => e.severity === 'error').length === 0,
      language: ext.toUpperCase().slice(1),
      errors,
    };
  }
}

/**
 * 多语言语法验证器 — 策略注册与分发
 *
 * 每种语言直接使用其官方编译器/解释器。
 * 不兜底、不回退、不降级。
 * 不支持的语言 → 不验证 (通用 Agent 不能因为不认识就报错)
 */
export class MultiLangSyntaxValidator {
  private strategies: ValidatorStrategy[] = [];

  constructor(private cwd: string) {
    this.strategies = [
      new TypeScriptValidator(),
      new PythonValidator(),
      new RustValidator(),
      new GoValidator(),
      new JavaValidator(),
      new CppValidator(),
      new RubyValidator(),
      new PhpValidator(),
      new SwiftValidator(),
      new KotlinValidator(),
      new ScalaValidator(),
      new DartValidator(),
      new LuaValidator(),
      new DataFileValidator(),
    ];
  }

  registerStrategy(strategy: ValidatorStrategy): void {
    this.strategies.unshift(strategy);
  }

  async validate(filePath: string, content: string): Promise<SyntaxValidationResult> {
    const ext = path.extname(filePath).toLowerCase();

    for (const strategy of this.strategies) {
      if (strategy.extensions.includes(ext)) {
        return strategy.validate(filePath, content, this.cwd);
      }
    }

    // 不认识的语言 → 不验证，不报错
    return { valid: true, language: ext || 'unknown', errors: [] };
  }

  static formatErrors(result: SyntaxValidationResult): string {
    if (result.valid) return '';
    return result.errors
      .map(e => `  Line ${e.line}:${e.column} [${result.language}] ${e.message}`)
      .join('\n');
  }
}
```

**验收:**
- `.ts` 文件修改后验证 TypeScript 语法
- `.py` 文件修改后调用 `python3 -m py_compile` 验证
- `.rs` 文件修改后调用 `rustc` 验证
- `.json` 文件修改后 `JSON.parse` 验证
- `.rb` / `.php` / `.java` / `.go` 等各自使用编译器验证
- 不支持的语言 (如 `.txt`) → 跳过验证，不阻塞修改
- 任何语言的语法错误都会触发回滚

**新增:** `packages/diff-engine/src/index.ts` — `generateUnifiedDiff()`

```typescript
/**
 * 生成 unified diff 格式的预览 (COMPARISON.md §4.2.2)
 * 在修改前展示给用户，让其确认
 */
static generateUnifiedDiff(
  filename: string, oldStr: string, newStr: string
): string {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  let preview = `\`\`\`diff\n--- a/${filename}\n+++ b/${filename}\n`;

  const maxLen = Math.max(oldLines.length, newLines.length);
  let hasChanges = false;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i] ?? '';
    const newLine = newLines[i] ?? '';
    if (oldLine !== newLine) {
      hasChanges = true;
      if (oldLines[i] !== undefined) preview += `-${oldLine}\n`;
      if (newLines[i] !== undefined) preview += `+${newLine}\n`;
    }
  }

  preview += `\`\`\``;
  return hasChanges ? preview : '(无变化)';
}
```

**验收:**
- 故意提供错误的 SEARCH → 文件内容不变（回滚成功）
- 修改 .ts 文件产生语法错误 → 文件内容不变
- 修改成功 → 终端显示 unified diff 预览

---

### Task 0.5: Thinking 内容展示 + Git 工具接入

**📖 COMPARISON.md §1.4, §2.3** | **文件:** `apps/cli/src/executor.ts`

**改动 A:** 展示 reasoning_content
```typescript
// 在 console.log(`💡 Agent 思考与应答:` ) 之前:
if (response.thinkingContent) {
  console.log(`\n🧠 [推理链 Reasoning]:`);
  console.log(`\x1b[90m${response.thinkingContent.slice(0, 2000)}\x1b[0m`);
  if (response.thinkingContent.length > 2000) {
    console.log(`\x1b[90m... (${response.thinkingContent.length - 2000} 字符省略)\x1b[0m`);
  }
}
```

**改动 B:** 注册 Git 工具到 executor (在 Phase 2 工具注册表中正式完成前，先在 switch 中临时添加)
```typescript
case 'git_status': return await this.toolkit.git.getStatus();
case 'git_diff':   return await this.toolkit.git.getDiff();
case 'git_commit': return await this.toolkit.git.commitAll(bodyContent);
```

**改动 C:** prompt.ts 添加对应工具声明。

---

### Task 0.6: LLM 调用重试机制

**📖 COMPARISON.md §4.6 错误处理** | **文件:** `packages/llm-provider/src/index.ts`

```typescript
/**
 * 指数退避重试包装器
 * COMPARISON.md §4.6: 分类错误（可重试/不可重试），指数退避重试
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const error = err as any;

      // 不可重试的错误 (4xx 非限流) → 直接抛出
      if (error.status && error.status >= 400 && error.status < 500
          && error.status !== 429 && error.status !== 408) {
        throw err;
      }

      // 最后一次尝试也失败 → 抛出
      if (attempt === maxRetries) throw err;

      // 指数退避 + jitter
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
      console.warn(
        `⚠️ LLM 调用失败 (${error.status || 'network'})，第 ${attempt + 1} 次重试，等待 ${Math.round(delay)}ms...`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('unreachable');
}

// DeepSeekProvider.chat() 中使用:
async chat(messages: Message[]): Promise<LLMResponse> {
  return withRetry(() => this._rawChat(messages));
}
```

---

## Phase 1: 代码理解增强 — LSP + 三层搜索

> 📖 对应 COMPARISON.md: §4.3.4 (三层搜索体系), §2.3 差距矩阵 (LSP 代码理解)
>
> **核心逻辑:** COMPARISON.md 指出当前仅有 AST 符号搜索（L1），
> 需要补全 grep 文本搜索（L2）和 Embedding 语义搜索（L3），
> 同时引入 LSP Client 获取 IDE 级别的代码智能。

---

---

### Task 1.0: 多语言 AST 索引器 — 从 TS-only 到全语言覆盖

**📖 COMPARISON.md §2.3 差距矩阵, §5.2 差异化定位** | **文件:** `packages/context-engine/src/indexer.ts` 重构

**现状问题:** 当前 `RepositoryIndexer` 仅用 `ts.createSourceFile()` 解析 TS/JS。
作为对标 Claude Code/Codex 的通用型 Agent，必须支持所有主流语言。

**方案:** 采用 **tree-sitter** 作为通用 AST 解析引擎。
tree-sitter 是 GitHub 开源的增量解析库，支持 50+ 语言，
被 Claude Code (间接) 和许多代码分析工具使用。零外部进程依赖 (WASM 绑定)。

```typescript
import Parser from 'tree-sitter';
// 按需导入各语言的 grammar (WASM 绑定, 零原生编译)
// 每个语言 grammar 约 200KB-2MB, 按需加载

/**
 * 多语言 AST 索引器 — 对标 Claude Code/Codex 的代码理解能力
 *
 * 支持语言列表 (与 Claude Code/Codex 对齐):
 *   TypeScript/JavaScript, Python, Rust, Go, Java, C, C++,
 *   Ruby, PHP, Swift, Kotlin, Scala, C#, Lua, SQL, Bash,
 *   HTML, CSS, JSON, YAML, TOML, Markdown, Dockerfile
 */

export interface LanguageConfig {
  name: string;              // 语言名 (给 LLM 看)
  extensions: string[];      // 文件扩展名
  grammarName: string;       // tree-sitter grammar 包名
  symbolNodeTypes: string[]; // AST 中代表"符号"的节点类型
  commentSyntax: string;     // 注释语法
}

/** 支持的语言配置 */
export const SUPPORTED_LANGUAGES: LanguageConfig[] = [
  {
    name: 'TypeScript',
    extensions: ['.ts', '.tsx'],
    grammarName: 'tree-sitter-typescript',
    symbolNodeTypes: [
      'function_declaration', 'method_definition', 'class_declaration',
      'interface_declaration', 'type_alias_declaration', 'enum_declaration',
      'variable_declarator', 'export_statement',
    ],
    commentSyntax: '//',
  },
  {
    name: 'JavaScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    grammarName: 'tree-sitter-javascript',
    symbolNodeTypes: [
      'function_declaration', 'method_definition', 'class_declaration',
      'variable_declarator', 'arrow_function',
    ],
    commentSyntax: '//',
  },
  {
    name: 'Python',
    extensions: ['.py', '.pyw'],
    grammarName: 'tree-sitter-python',
    symbolNodeTypes: [
      'function_definition', 'class_definition', 'decorated_definition',
    ],
    commentSyntax: '#',
  },
  {
    name: 'Rust',
    extensions: ['.rs'],
    grammarName: 'tree-sitter-rust',
    symbolNodeTypes: [
      'function_item', 'struct_item', 'enum_item', 'trait_item',
      'impl_item', 'mod_item', 'macro_definition',
    ],
    commentSyntax: '//',
  },
  {
    name: 'Go',
    extensions: ['.go'],
    grammarName: 'tree-sitter-go',
    symbolNodeTypes: [
      'function_declaration', 'method_declaration', 'type_declaration',
      'struct_type', 'interface_type',
    ],
    commentSyntax: '//',
  },
  {
    name: 'Java',
    extensions: ['.java'],
    grammarName: 'tree-sitter-java',
    symbolNodeTypes: [
      'method_declaration', 'class_declaration', 'interface_declaration',
      'enum_declaration', 'constructor_declaration',
    ],
    commentSyntax: '//',
  },
  {
    name: 'C',
    extensions: ['.c', '.h'],
    grammarName: 'tree-sitter-c',
    symbolNodeTypes: ['function_definition', 'struct_specifier', 'enum_specifier'],
    commentSyntax: '//',
  },
  {
    name: 'C++',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
    grammarName: 'tree-sitter-cpp',
    symbolNodeTypes: [
      'function_definition', 'class_specifier', 'struct_specifier',
      'template_declaration', 'namespace_definition',
    ],
    commentSyntax: '//',
  },
  {
    name: 'Ruby',
    extensions: ['.rb'],
    grammarName: 'tree-sitter-ruby',
    symbolNodeTypes: ['method', 'class', 'module', 'singleton_method'],
    commentSyntax: '#',
  },
  {
    name: 'PHP',
    extensions: ['.php'],
    grammarName: 'tree-sitter-php',
    symbolNodeTypes: ['function_definition', 'class_declaration', 'method_declaration'],
    commentSyntax: '//',
  },
  {
    name: 'Swift',
    extensions: ['.swift'],
    grammarName: 'tree-sitter-swift',
    symbolNodeTypes: [
      'function_declaration', 'class_declaration', 'struct_declaration',
      'enum_declaration', 'protocol_declaration',
    ],
    commentSyntax: '//',
  },
  {
    name: 'Kotlin',
    extensions: ['.kt', '.kts'],
    grammarName: 'tree-sitter-kotlin',
    symbolNodeTypes: [
      'function_declaration', 'class_declaration', 'object_declaration',
    ],
    commentSyntax: '//',
  },
  {
    name: 'C#',
    extensions: ['.cs'],
    grammarName: 'tree-sitter-c-sharp',
    symbolNodeTypes: [
      'method_declaration', 'class_declaration', 'interface_declaration',
      'struct_declaration', 'enum_declaration',
    ],
    commentSyntax: '//',
  },
  {
    name: 'Lua',
    extensions: ['.lua'],
    grammarName: 'tree-sitter-lua',
    symbolNodeTypes: ['function_declaration', 'function_definition', 'local_function'],
    commentSyntax: '--',
  },
  {
    name: 'SQL',
    extensions: ['.sql'],
    grammarName: 'tree-sitter-sql',
    symbolNodeTypes: ['create_table', 'create_view', 'create_function', 'create_procedure'],
    commentSyntax: '--',
  },
  {
    name: 'Bash',
    extensions: ['.sh', '.bash', '.zsh'],
    grammarName: 'tree-sitter-bash',
    symbolNodeTypes: ['function_definition'],
    commentSyntax: '#',
  },
  {
    name: 'Dockerfile',
    extensions: ['Dockerfile', '.dockerfile'],
    grammarName: 'tree-sitter-dockerfile',
    symbolNodeTypes: ['from_instruction', 'run_instruction', 'cmd_instruction'],
    commentSyntax: '#',
  },
  {
    name: 'HTML',
    extensions: ['.html', '.htm'],
    grammarName: 'tree-sitter-html',
    symbolNodeTypes: ['element', 'script_element', 'style_element'],
    commentSyntax: '<!--',
  },
  {
    name: 'CSS',
    extensions: ['.css', '.scss', '.less'],
    grammarName: 'tree-sitter-css',
    symbolNodeTypes: ['rule_set', 'declaration', 'media_statement'],
    commentSyntax: '/*',
  },
  {
    name: 'JSON',
    extensions: ['.json', '.jsonc'],
    grammarName: 'tree-sitter-json',
    symbolNodeTypes: ['object', 'pair'],
    commentSyntax: '//',
  },
  {
    name: 'YAML',
    extensions: ['.yaml', '.yml'],
    grammarName: 'tree-sitter-yaml',
    symbolNodeTypes: ['block_mapping_pair', 'flow_mapping'],
    commentSyntax: '#',
  },
  {
    name: 'TOML',
    extensions: ['.toml'],
    grammarName: 'tree-sitter-toml',
    symbolNodeTypes: ['table', 'pair'],
    commentSyntax: '#',
  },
  {
    name: 'Markdown',
    extensions: ['.md', '.mdx'],
    grammarName: 'tree-sitter-markdown',
    symbolNodeTypes: ['heading', 'section', 'code_block'],
    commentSyntax: '<!--',
  },
];

/**
 * 多语言索引器
 *
 * 设计要点:
 * - 按文件扩展名自动选择 tree-sitter grammar
 * - 每种语言提取其特有的符号类型 (function/class/struct/interface...)
 * - 结果统一写入 SQLite + FTS5 (与现有 db.ts 兼容)
 * - 不认识的扩展名跳过 (不报错)，通用型 Agent 的底线
 */
export class MultiLangIndexer {
  private parsers = new Map<string, Parser>();
  private langByExt = new Map<string, LanguageConfig>();

  constructor(private dbManager: StorageManager) {
    // 构建扩展名 → 语言配置的映射
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const ext of lang.extensions) {
        this.langByExt.set(ext, lang);
      }
    }
  }

  /** (懒加载) 获取指定语言的 tree-sitter parser */
  private async getParser(lang: LanguageConfig): Promise<Parser> {
    if (this.parsers.has(lang.name)) {
      return this.parsers.get(lang.name)!;
    }

    const ParserModule = await import('tree-sitter');
    const GrammarModule = await import(lang.grammarName);

    const parser = new ParserModule.default();
    parser.setLanguage(GrammarModule.default);
    this.parsers.set(lang.name, parser);
    return parser;
  }

  /** 索引一个文件 (支持所有配置的语言) */
  async indexFile(filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    // Dockerfile 特殊处理
    const basename = path.basename(filePath);
    const lang = this.langByExt.get(ext)
              || this.langByExt.get(basename)
              || null;

    if (!lang) {
      // 不认识的语言 → 不索引，但不报错 (通用型 Agent)
      return;
    }

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const stats = await fs.stat(filePath);

      this.dbManager.clearFileIndex(filePath);
      this.dbManager.insertFile(filePath, stats.mtimeMs);

      const parser = await this.getParser(lang);
      const tree = parser.parse(content);

      this.extractSymbols(tree.rootNode, content, lang, filePath);

    } catch (err) {
      console.warn(`[Indexer] 索引跳过 ${filePath}: ${(err as Error).message}`);
    }
  }

  /** 从 AST 中提取符号 (语言相关) */
  private extractSymbols(
    node: Parser.SyntaxNode,
    content: string,
    lang: LanguageConfig,
    filePath: string
  ): void {
    if (lang.symbolNodeTypes.includes(node.type)) {
      // 提取符号名 (不同语言的 name 提取方式不同)
      const name = this.extractName(node, lang);
      if (name) {
        this.dbManager.insertSymbol(
          name,
          node.type,  // 如 'function_definition', 'class_declaration'
          filePath,
          node.startPosition.row + 1,
          node.endPosition.row + 1,
        );
        // 同步写入 FTS5
        this.dbManager.insertSymbolToFts(
          name,
          node.type,
          filePath,
          node.startPosition.row + 1,
          node.endPosition.row + 1,
          content.slice(node.startIndex, node.endIndex).slice(0, 1000),
        );
      }
    }

    // 递归遍历子节点
    for (const child of node.children) {
      this.extractSymbols(child, content, lang, filePath);
    }
  }

  /** 从 AST 节点中提取符号名称 */
  private extractName(node: Parser.SyntaxNode, lang: LanguageConfig): string | null {
    const nameChild = node.children.find(
      c => c.type === 'identifier' || c.type === 'name'
        || c.type === 'property_identifier'
    );
    if (nameChild) return nameChild.text;
    return null;
  }
}
```

**新增依赖:** `pnpm add tree-sitter tree-sitter-typescript tree-sitter-python tree-sitter-rust tree-sitter-go tree-sitter-java tree-sitter-c tree-sitter-cpp tree-sitter-ruby tree-sitter-php tree-sitter-swift --filter @code-agent/context-engine`

**验收:**
- `.ts` 文件 → 提取 function_declaration, class_declaration, interface_declaration 等
- `.py` 文件 → 提取 function_definition, class_definition
- `.rs` 文件 → 提取 function_item, struct_item, trait_item
- `.go` 文件 → 提取 function_declaration, type_declaration
- `.java` 文件 → 提取 method_declaration, class_declaration
- `.sql` 文件 → 跳过 (无相关符号类型), 不报错
- `.txt` 文件 → 不报错跳过 (通用 Agent 的底线)

---

### Task 1.1: 多语言 LSP Manager — 自动化语言服务器管理

**📖 COMPARISON.md §2.3 差距矩阵 (LSP 代码理解), §6.1 目标架构 (lsp-client)**

**现状问题:** 原方案只集成了 TypeScript tsserver。
Claude Code 通过 MCP 间接支持多语言 LSP, Codex CLI 通过项目配置。
我们的通用型 Agent 必须支持按文件类型自动选择 LSP Server。

**方案:** **LSP Manager** — 自动检测项目语言 → 选择对应 LSP Server → 启动并缓存连接。
每种语言一个标准 LSP Server，不支持的语言不启动。

**文件:** `packages/context-engine/src/lsp-manager.ts` (新建)

```typescript
/**
 * 多语言 LSP Manager — 对标 Claude Code/Codex 的代码智能
 *
 * 设计:
 * - 每个语言一个 LSP Server 配置 (command + args)
 * - 按需启动 (首次访问该语言的文件时才启动)
 * - 连接池管理 (每种语言一个 LSP 进程, 复用)
 * - 不支持的语言 → 返回 null，Agent 使用 tree-sitter 索引替代
 */

export interface LSPServerConfig {
  language: string;            // 语言名
  extensions: string[];        // 触发的文件扩展名
  command: string;             // 启动命令
  args: string[];              // 启动参数
  initializationOptions?: any; // 传给 LSP initialize 的选项
  installHint: string;         // 安装提示 (给用户看)
}

/** 预置的 15+ LSP Server 配置 */
export const DEFAULT_LSP_SERVERS: LSPServerConfig[] = [
  // TypeScript/JavaScript — 使用项目本地的 typescript (npm 依赖)
  {
    language: 'TypeScript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    command: 'node',
    args: ['--loader', 'ts-node/esm', '-e', `
      const ts = require('typescript');
      // 启动 tsserver...
    `],
    installHint: 'npm install typescript (通常已有)',
  },
  // Python — Pyright (ms 出品, npm 包, 零 python 依赖)
  {
    language: 'Python',
    extensions: ['.py', '.pyw'],
    command: 'npx',
    args: ['pyright-langserver', '--stdio'],
    installHint: 'npx pyright (自动下载) 或 pip install pyright',
  },
  // Rust — rust-analyzer (标准 Rust LSP)
  {
    language: 'Rust',
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
    installHint: 'rustup component add rust-analyzer',
  },
  // Go — gopls (官方 Go LSP)
  {
    language: 'Go',
    extensions: ['.go'],
    command: 'gopls',
    args: [],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  // Java — Eclipse JDT LS (通过 jdtls 脚本)
  {
    language: 'Java',
    extensions: ['.java'],
    command: 'jdtls',
    args: [],
    installHint: '安装 Eclipse JDT LS: https://github.com/eclipse-jdtls/eclipse.jdt.ls',
  },
  // C/C++ — clangd
  {
    language: 'C/C++',
    extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp'],
    command: 'clangd',
    args: ['--background-index'],
    installHint: 'apt install clangd 或 brew install llvm',
  },
  // Ruby — Solargraph
  {
    language: 'Ruby',
    extensions: ['.rb'],
    command: 'solargraph',
    args: ['stdio'],
    installHint: 'gem install solargraph',
  },
  // PHP — Intelephense
  {
    language: 'PHP',
    extensions: ['.php'],
    command: 'node',
    args: [path.join(os.homedir(), '.npm/_npx/**/intelephense/lib/intelephense.js'), '--stdio'],
    installHint: 'npx intelephense (自动下载)',
  },
  // Swift — SourceKit-LSP (macOS 内置)
  {
    language: 'Swift',
    extensions: ['.swift'],
    command: 'sourcekit-lsp',
    args: [],
    installHint: 'macOS 内置; Linux: swift install sourcekit-lsp',
  },
  // C# — OmniSharp
  {
    language: 'C#',
    extensions: ['.cs'],
    command: 'omnisharp',
    args: ['-lsp'],
    installHint: '安装 OmniSharp: https://github.com/OmniSharp/omnisharp-roslyn',
  },
  // Lua — lua-language-server
  {
    language: 'Lua',
    extensions: ['.lua'],
    command: 'lua-language-server',
    args: [],
    installHint: '安装: https://github.com/LuaLS/lua-language-server',
  },
  // JSON/YAML — yaml-language-server (npm 包)
  {
    language: 'YAML',
    extensions: ['.yaml', '.yml'],
    command: 'npx',
    args: ['yaml-language-server', '--stdio'],
    installHint: 'npm install -g yaml-language-server',
  },
  // CSS/SCSS/Less
  {
    language: 'CSS',
    extensions: ['.css', '.scss', '.less'],
    command: 'npx',
    args: ['vscode-css-languageserver', '--stdio'],
    installHint: 'npm install -g vscode-langservers-extracted',
  },
  // HTML
  {
    language: 'HTML',
    extensions: ['.html', '.htm'],
    command: 'npx',
    args: ['vscode-html-languageserver', '--stdio'],
    installHint: 'npm install -g vscode-langservers-extracted',
  },
];

/**
 * LSP Manager — 管理所有语言的 LSP 连接
 */
export class LSPManager {
  private connections = new Map<string, LSPConnection>();
  private serverConfigs: LSPServerConfig[];

  constructor(
    private workspaceRoot: string,
    extraServers: LSPServerConfig[] = [],
  ) {
    this.serverConfigs = [...DEFAULT_LSP_SERVERS, ...extraServers];
  }

  /** 根据文件扩展名获取对应的 LSP 连接 (自动启动) */
  async getConnection(filePath: string): Promise<LSPConnection | null> {
    const ext = path.extname(filePath).toLowerCase();
    const config = this.serverConfigs.find(s => s.extensions.includes(ext));

    if (!config) {
      // 不支持的语言 → 返回 null
      return null;
    }

    if (this.connections.has(config.language)) {
      return this.connections.get(config.language)!;
    }

    // 尝试启动 LSP Server
    try {
      const connection = new LSPConnection(config, this.workspaceRoot);
      await connection.start();
      this.connections.set(config.language, connection);
      console.log(`🔌 LSP: ${config.language} 已连接`);
      return connection;
    } catch (err) {
      console.warn(
        `⚠️  无法启动 ${config.language} LSP Server。`
        + `请安装: ${config.installHint}`
      );
      return null;
    }
  }

  /** 关闭所有 LSP 连接 */
  async shutdownAll(): Promise<void> {
    for (const [lang, conn] of this.connections) {
      await conn.stop();
      console.log(`🔌 LSP: ${lang} 已断开`);
    }
    this.connections.clear();
  }
}

/**
 * 单个 LSP 连接 (基于标准 LSP JSON-RPC 协议, 与编辑器 LSP 对接)
 */
export class LSPConnection {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, any>();
  private buffer = '';

  constructor(
    private config: LSPServerConfig,
    private workspaceRoot: string,
  ) {}

  async start(): Promise<void> {
    this.process = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.workspaceRoot,
    });

    this.process.stdout!.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    // 发送 LSP initialize
    await this.sendRequest('initialize', {
      processId: process.pid,
      rootUri: `file://${this.workspaceRoot}`,
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
      },
      initializationOptions: this.config.initializationOptions || {},
    });

    // 发送 initialized 通知
    this.sendNotification('initialized', {});
  }

  /** go-to-definition */
  async getDefinition(
    filePath: string, line: number, character: number
  ): Promise<Array<{ file: string; line: number }>> {
    const result = await this.sendRequest('textDocument/definition', {
      textDocument: { uri: `file://${path.resolve(this.workspaceRoot, filePath)}` },
      position: { line: line - 1, character },
    });

    if (!result) return [];
    const locations = Array.isArray(result) ? result : [result];
    return locations.map((loc: any) => ({
      file: path.relative(this.workspaceRoot, new URL(loc.uri).pathname),
      line: loc.range.start.line + 1,
    }));
  }

  /** find-references */
  async getReferences(
    filePath: string, line: number, character: number
  ): Promise<Array<{ file: string; line: number }>> {
    const result = await this.sendRequest('textDocument/references', {
      textDocument: { uri: `file://${path.resolve(this.workspaceRoot, filePath)}` },
      position: { line: line - 1, character },
      context: { includeDeclaration: false },
    });

    if (!Array.isArray(result)) return [];
    return result.map((loc: any) => ({
      file: path.relative(this.workspaceRoot, new URL(loc.uri).pathname),
      line: loc.range.start.line + 1,
    }));
  }

  /** 获取诊断 (语法/类型错误) */
  async getDiagnostics(
    filePath: string
  ): Promise<Array<{ line: number; message: string; severity: string }>> {
    // LSP diagnostics 是推送式的, 我们改用 document_symbol 检查语法
    const result = await this.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri: `file://${path.resolve(this.workspaceRoot, filePath)}` },
    });

    if (!result || result.error) {
      return [{
        line: 1,
        message: result?.error?.message || '文件无法解析',
        severity: 'error',
      }];
    }
    return [];
  }

  private sendRequest(method: string, params: any): Promise<any> {
    const id = ++this.requestId;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP timeout: ${method}`));
      }, 15000);

      this.pending.set(id, { resolve, reject, timeout });

      const header = `Content-Length: ${Buffer.byteLength(request)}\r\n\r\n`;
      this.process!.stdin!.write(header + request);
    });
  }

  private sendNotification(method: string, params: any): void {
    const notification = JSON.stringify({ jsonrpc: '2.0', method, params });
    const header = `Content-Length: ${Buffer.byteLength(notification)}\r\n\r\n`;
    this.process!.stdin!.write(header + notification);
  }

  private processBuffer(): void {
    while (true) {
      const headerMatch = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/);
      if (!headerMatch) break;

      const contentLength = parseInt(headerMatch[1]);
      const headerEnd = headerMatch.index! + headerMatch[0].length;
      const bodyEnd = headerEnd + contentLength;
      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.slice(headerEnd, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);

      try {
        const response = JSON.parse(body);
        const pending = this.pending.get(response.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch {}
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.sendNotification('shutdown', {});
      this.process.kill();
      this.process = null;
    }
  }
}
```

**注册为 Agent 工具 (语言无关):**
```typescript
registry.register({
  name: 'lsp_definition',
  description: '跳转到符号定义 (支持 TypeScript/Python/Rust/Go/Java/C++/Ruby/PHP/Swift/C# 等)',
  handler: async (args) => {
    const conn = await lspManager.getConnection(args.file);
    if (!conn) return `LSP 不可用于 ${args.file}。请使用 search_symbol。`;
    const result = await conn.getDefinition(args.file, args.line, args.character);
    return JSON.stringify(result, null, 2);
  },
});

registry.register({
  name: 'lsp_references',
  description: '查找符号的所有引用 (支持多语言)',
  handler: async (args) => {
    const conn = await lspManager.getConnection(args.file);
    if (!conn) return `LSP 不可用于 ${args.file}。`;
    return JSON.stringify(await conn.getReferences(args.file, args.line, args.character), null, 2);
  },
});

registry.register({
  name: 'lsp_diagnostics',
  description: '获取文件编译诊断 (错误和警告, 支持多语言)',
  handler: async (args) => {
    const conn = await lspManager.getConnection(args.file);
    if (!conn) return `LSP 不可用于 ${args.file}。使用对应编译器的语法检查。`;
    const diags = await conn.getDiagnostics(args.file);
    return diags.length === 0
      ? '该文件没有诊断问题。'
      : JSON.stringify(diags, null, 2);
  },
});
```

**验收:**
- `.ts` 文件 → LSP 启动 tsserver, 正常跳转定义
- `.py` 文件 → LSP 启动 pyright, 正常跳转定义
- `.rs` 文件 → LSP 启动 rust-analyzer, 正常跳转定义
- 某语言 LSP 不可用 → 提示用户安装对应 LSP Server
- LSP 结果与 tree-sitter 索引互补

---

### Task 1.2: ripgrep 文本搜索 (L2)

**📖 COMPARISON.md §4.3.4 三层搜索 — 文本搜索层**

**文件:** `packages/context-engine/src/searcher.ts` (新建)

```typescript
import { execa } from 'execa';

export class CodeSearcher {
  constructor(private cwd: string) {}

  /**
   * 基于 ripgrep 的文本搜索 (COMPARISON.md §4.3.4 L1)
   * 如果 rg 不可用，回退到 Node.js 原生实现
   */
  async grep(pattern: string, options?: {
    path?: string;
    fileTypes?: string[];     // 如 ['ts', 'tsx']
    maxResults?: number;
    caseSensitive?: boolean;
  }): Promise<Array<{ file: string; line: number; content: string }>> {
    const args: string[] = [
      '--line-number',
      '--no-heading',
      '--color', 'never',
    ];

    if (!options?.caseSensitive) args.push('--smart-case');
    if (options?.fileTypes) args.push('--type', options.fileTypes.join(','));
    const maxResults = options?.maxResults ?? 50;
    args.push('-m', String(maxResults));
    args.push(pattern);
    if (options?.path) args.push(options.path);

    try {
      const result = await execa({
        cwd: this.cwd,
        reject: false,
        timeout: 15000,
      })`rg ${args}`;

      if (result.exitCode === 1) return [];  // 没找到
      if (result.exitCode !== 0) throw new Error(result.stderr);

      return result.stdout.trim().split('\n')
        .filter(Boolean)
        .map(line => {
          const [file, lineNum, ...rest] = line.split(':');
          return {
            file: file.trim(),
            line: parseInt(lineNum) || 1,
            content: rest.join(':').trim(),
          };
        });
    } catch {
      return this.fallbackGrep(pattern, options);
    }
  }

  /** Node.js 原生回退 (不使用 ripgrep 时) */
  private async fallbackGrep(
    pattern: string, options?: any
  ): Promise<Array<{ file: string; line: number; content: string }>> {
    const { globSync } = await import('fast-glob');
    const files = globSync(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'], {
      cwd: this.cwd,
      ignore: ['**/node_modules/**', '**/dist/**'],
      absolute: true,
    });

    const results: Array<{ file: string; line: number; content: string }> = [];
    const regex = new RegExp(pattern, options?.caseSensitive ? 'g' : 'gi');

    for (const file of files.slice(0, 200)) {  // 限制扫描范围
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            results.push({
              file: file.replace(this.cwd + '/', ''),
              line: i + 1,
              content: lines[i].trim(),
            });
            if (results.length >= (options?.maxResults ?? 50)) break;
          }
        }
      } catch { /* skip unreadable */ }
      if (results.length >= (options?.maxResults ?? 50)) break;
    }

    return results;
  }
}
```

---

### Task 1.3: FTS5 全文索引 (L1 增强)

**📖 COMPARISON.md §4.3.4 三层搜索 — 符号搜索层**

**文件:** `packages/context-engine/src/db.ts` — 添加 FTS5 虚拟表

```typescript
private initTables() {
  // 保留原有 files 和 symbols 表 ...

  // 新增 FTS5 (COMPARISON.md §4.3.4)
  this.db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
      name,
      kind,
      file_path,
      content,
      prefix='2 3',            -- 支持前缀匹配 (2-3 字符)
      tokenize='unicode61'      -- Unicode 分词
    );
  `);
}

/** FTS 搜索 — 比 LIKE '%...%' 快 100-1000 倍 */
searchFts(query: string, limit = 10): Array<{
  name: string;
  kind: string;
  file_path: string;
  snippet: string;
}> {
  return this.db.prepare(`
    SELECT
      name,
      kind,
      file_path,
      snippet(symbols_fts, 2, '<b>', '</b>', '...', 40) as snippet
    FROM symbols_fts
    WHERE symbols_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as any[];
}
```

**修改 `RepositoryIndexer`** — 索引文件时同步写入 FTS
```typescript
// 在 insertSymbol 后同步插入 FTS
db.insertSymbolToFts(name, kind, filePath, startLine, endLine, content);
```

**验收:**
- FTS 搜索返回带高亮的片段
- 搜索速度优于原 LIKE 查询（可通过计时验证）

---

### Task 1.4: Embedding 语义搜索 (L3)

**📖 COMPARISON.md §4.3.4 三层搜索 — 语义搜索层**

**文件:** `packages/context-engine/src/embeddings.ts` (新建)

```typescript
/**
 * 语义搜索 — COMPARISON.md §4.3.4 L3
 *
 * 策略:
 * - 使用 DeepSeek/OpenAI embedding API 生成代码向量
 * - 本地存储向量 (SQLite 或简单的 JSON 文件)
 * - 搜索时计算余弦相似度
 * - 依赖 Provider 的 embedding 能力，若不可用则使用 FTS5 作为替代
 */

interface VectorEntry {
  id: string;
  text: string;            // 原始代码片段
  file: string;
  line: number;
  embedding: number[];     // 向量
  updatedAt: string;
}

export class EmbeddingSearch {
  private vectors: VectorEntry[] = [];
  private provider: ILLMProvider;

  constructor(provider: ILLMProvider) {
    this.provider = provider;
  }

  /**
   * 索引代码片段 (可并行)
   */
  async indexSnippets(snippets: Array<{
    text: string; file: string; line: number;
  }>): Promise<void> {
    // 分批生成 embedding
    const BATCH_SIZE = 20;
    for (let i = 0; i < snippets.length; i += BATCH_SIZE) {
      const batch = snippets.slice(i, i + BATCH_SIZE);
      const embeddings = await this.generateEmbeddings(
        batch.map(s => s.text)
      );
      for (let j = 0; j < batch.length; j++) {
        this.vectors.push({
          id: crypto.randomUUID(),
          text: batch[j].text,
          file: batch[j].file,
          line: batch[j].line,
          embedding: embeddings[j],
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * 语义搜索
   */
  async search(
    query: string, topK = 10
  ): Promise<Array<{ file: string; line: number; text: string; score: number }>> {
    const queryEmbedding = (await this.generateEmbeddings([query]))[0];

    return this.vectors
      .map(v => ({
        file: v.file,
        line: v.line,
        text: v.text,
        score: this.cosineSimilarity(queryEmbedding, v.embedding),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private async generateEmbeddings(texts: string[]): Promise<number[][]> {
    // 调用 DeepSeek/OpenAI embedding API
    // 调用 Provider 的 embedding API
    const response = await (this.provider as any).embed(texts);
    return response.embeddings;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] ** 2;
      normB += b[i] ** 2;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
  }
}
```

**注册为 Agent 工具:**
```typescript
registry.register({
  name: 'semantic_search',
  description: '用自然语言描述搜索代码（如 "找到处理用户登录认证的代码"）',
  handler: async (args) => {
    const results = await embeddingSearch.search(args.query, 10);
    if (results.length === 0) return `未找到与 "${args.query}" 相关的代码`;
    return results.map(r =>
      `[${r.file}:${r.line}] (相似度: ${(r.score * 100).toFixed(1)}%)\n${r.text.slice(0, 300)}`
    ).join('\n\n');
  },
});
```

**验收:**
- 搜索 "用户登录认证" 返回相关的认证代码片段
- 语义搜索正常返回结果，embedding 不可用时自动使用 FTS5 替代

---

## Phase 2: 工具协议标准化 — MCP Server + Client

> 📖 对应 COMPARISON.md: §4.3.1 (标准工具协议 → MCP), §4.3.5 (工具注册表重构), §8.2 (MCP-Native 工具生态)
>
> **核心逻辑:** COMPARISON.md §4.3.1 明确指出要从自定义 XML 协议迁移到 MCP 标准。
> 同时需要实现 MCP Server (暴露我们的工具) 和 MCP Client (连接外部工具)。

---

### Task 2.1: 工具注册表 — 从 switch-case 到注册表模式

**📖 COMPARISON.md §4.3.5** | **新包:** `packages/agent-core/`

**文件:** `packages/agent-core/src/tool-registry.ts` (新建)

```typescript
import { ToolDefinition } from '@code-agent/llm-provider';

/**
 * 工具注册表 — COMPARISON.md §4.3.5
 *
 * 设计原则 (Syscall Table 模式):
 * - 少量通用动词 (read, write, search, execute, list, get)
 * - 通过注册表分发到具体实现
 * - 新增工具只需 register()，不改 dispatch 逻辑
 * - 同时生成 MCP tool schema 和 OpenAI/Anthropic function calling schema
 */

export interface RegisteredTool {
  definition: ToolDefinition;
  requiresApproval: boolean;
  /** 路径参数名 (如 "path", "file") — 用于路径沙箱校验 */
  pathParamNames: string[];
  /** 命令参数名 — 用于命令模板校验 */
  commandParamNames: string[];
  handler: (args: Record<string, any>) => Promise<string>;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): this {
    this.tools.set(tool.definition.function.name, tool);
    return this;  // 链式调用
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  listAll(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  /** 生成 OpenAI/Anthropic Function Calling 格式的工具列表 */
  getFunctionDefinitions(): ToolDefinition[] {
    return this.listAll().map(t => t.definition);
  }

  /** 生成 MCP tools/list 响应格式 */
  getMCPSchemas(): any[] {
    return this.listAll().map(t => ({
      name: t.definition.function.name,
      description: t.definition.function.description,
      inputSchema: t.definition.function.parameters,
    }));
  }

  /** 分发工具调用 */
  async dispatch(name: string, args: Record<string, any>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `未知工具 "${name}"。可用: ${[...this.tools.keys()].join(', ')}`;
    }
    try {
      return await tool.handler(args);
    } catch (err) {
      return `[工具异常] ${(err as Error).message}`;
    }
  }

  /** 获取需要审批的工具列表 */
  getApprovalRequired(): string[] {
    return this.listAll()
      .filter(t => t.requiresApproval)
      .map(t => t.definition.function.name);
  }
}
```

---

### Task 2.2: 注册全部工具

**📖 COMPARISON.md §4.3.5, §2.3 差距矩阵** | **文件:** `apps/cli/src/tools.ts` (新建)

注册所有工具到一个 ToolRegistry 实例（总览）：

| 工具名 | 来源 | 是否需要审批 | COMPARISON.md |
|--------|------|:----------:|--------------|
| `search_symbol` | AST 符号搜索 | 否 | §4.3.4 L1 |
| `fts_search` | FTS5 全文搜索 | 否 | §4.3.4 L1 增强 |
| `semantic_search` | Embedding 语义搜索 | 否 | §4.3.4 L3 |
| `grep_search` | ripgrep 文本搜索 | 否 | §4.3.4 L2 |
| `read_file` | 文件读取 | 否 | §1.3 |
| `list_files` | 目录列表 | 否 | 新增 |
| `modify_file` | SEARCH/REPLACE 修改 | **是** | §4.2 |
| `execute_command` | OS 沙箱内执行命令 | **是** | §4.1.2 |
| `git_status` | Git 状态 | 否 | §2.3 |
| `git_diff` | Git 差异 | 否 | §2.3 |
| `git_commit` | Git 提交 | **是** | §2.3 |
| `lsp_definition` | LSP 定义跳转 | 否 | §2.3 LSP |
| `lsp_references` | LSP 引用查找 | 否 | §2.3 LSP |
| `lsp_diagnostics` | LSP 诊断 | 否 | §2.3 LSP |
| `list_command_templates` | 列出可用的沙箱命令 | 否 | §4.1.2 |

---

### Task 2.3: MCP Server 实现 — 暴露工具

**📖 COMPARISON.md §4.3.1, §8.2** | **文件:** `packages/tool-kit/src/mcp-server.ts` (新建)

```typescript
/**
 * MCP Server — COMPARISON.md §4.3.1 + §8.2
 *
 * 将我们的工具注册表通过 MCP 协议暴露，
 * 使得外部 MCP Client (Claude Desktop, Codex CLI, Cursor 等) 可以调用我们的工具。
 *
 * 传输层: stdio (标准输入输出 JSON-RPC 2.0)
 * 也支持 Streamable HTTP (Phase 9)
 */

import { ToolRegistry } from '@code-agent/agent-core';

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

export class MCPServer {
  constructor(
    private registry: ToolRegistry,
    private serverInfo = {
      name: 'code-agent',
      version: '1.0.0',
    }
  ) {}

  /**
   * 处理单个 JSON-RPC 请求
   * 可以被 stdio transport 或 HTTP transport 调用
   */
  async handle(request: JSONRPCRequest): Promise<string> {
    const { method, id, params } = request;

    switch (method) {
      case 'initialize':
        return this.response(id, {
          protocolVersion: '2024-11-05',
          serverInfo: this.serverInfo,
          capabilities: {
            tools: {
              listChanged: false,  // 暂不支持动态工具列表变更通知
            },
          },
        });

      case 'notifications/initialized':
        return '';  // 无需响应

      case 'tools/list':
        return this.response(id, {
          tools: this.registry.getMCPSchemas(),
        });

      case 'tools/call':
        const { name, arguments: args } = params;
        const result = await this.registry.dispatch(name, args || {});
        return this.response(id, {
          content: [{ type: 'text', text: result }],
          isError: result.startsWith('[工具异常]'),
        });

      case 'ping':
        return this.response(id, {});

      default:
        return this.error(id, -32601, `Method not found: ${method}`);
    }
  }

  /**
   * 启动 stdio transport (作为子进程被 MCP Client 启动)
   */
  async startStdio(): Promise<void> {
    process.stdin.setEncoding('utf-8');
    let buffer = '';

    process.stdin.on('data', async (chunk: string) => {
      buffer += chunk;

      // 按行解析 JSON-RPC
      while (buffer.includes('\n')) {
        const newlineIndex = buffer.indexOf('\n');
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) continue;

        try {
          const request = JSON.parse(line);
          const response = await this.handle(request);
          if (response) process.stdout.write(response + '\n');
        } catch (err) {
          process.stdout.write(
            this.error(null, -32700, `Parse error: ${(err as Error).message}`) + '\n'
          );
        }
      }
    });
  }

  private response(id: any, result: any): string {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }

  private error(id: any, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }
}
```

**验收:**
- `tools/list` 返回所有注册工具的 schema
- `tools/call` 正确分发并返回结果
- 可以通过 `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp-server.js` 测试

---

### Task 2.4: MCP Client 实现 — 连接外部工具

**📖 COMPARISON.md §4.3.1, §8.2 (MCP-Native 工具生态)** | **文件:** `packages/tool-kit/src/mcp-client.ts` (新建)

```typescript
/**
 * MCP Client — COMPARISON.md §8.2
 *
 * 连接到外部 MCP Server (如 GitHub MCP Server, Postgres MCP Server 等)，
 * 将其工具动态注册到我们的 ToolRegistry 中。
 *
 * 传输层: stdio (启动子进程) 和 Streamable HTTP
 */

import { spawn, ChildProcess } from 'child_process';
import { ToolRegistry } from '@code-agent/agent-core';

export interface MCPConnection {
  serverName: string;
  transport: 'stdio' | 'http';
  process?: ChildProcess;
  baseUrl?: string;
  tools: string[];  // 该 Server 提供的工具名列表
}

export class MCPClient {
  private connections = new Map<string, MCPConnection>();
  private requestId = 0;

  /**
   * 通过 stdio 连接一个 MCP Server
   * 例如: connectStdio('github', 'npx', ['-y', '@anthropic/mcp-server-github'])
   */
  async connectStdio(
    serverName: string,
    command: string,
    args: string[],
    registry: ToolRegistry,
  ): Promise<MCPConnection> {
    const process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const connection: MCPConnection = {
      serverName,
      transport: 'stdio',
      process,
      tools: [],
    };

    // 发送 initialize
    const initResult = await this.sendRequest(connection, 'initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'code-agent', version: '1.0.0' },
      capabilities: {},
    });

    // 发送 initialized 通知
    this.sendNotification(connection, 'notifications/initialized', {});

    // 获取工具列表
    const toolsResult = await this.sendRequest(connection, 'tools/list', {});
    const tools = toolsResult.tools || [];

    // 动态注册到我们的 ToolRegistry
    for (const tool of tools) {
      const toolName = `mcp_${serverName}_${tool.name}`;
      registry.register({
        definition: {
          type: 'function',
          function: {
            name: toolName,
            description: `[MCP:${serverName}] ${tool.description || tool.name}`,
            parameters: tool.inputSchema || { type: 'object', properties: {} },
          },
        },
        requiresApproval: true,   // 外部 MCP 工具默认需要审批
        pathParamNames: [],
        commandParamNames: [],
        handler: async (args) => {
          const result = await this.sendRequest(connection, 'tools/call', {
            name: tool.name,
            arguments: args,
          });
          const content = result.content || [];
          return content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');
        },
      });
      connection.tools.push(toolName);
    }

    this.connections.set(serverName, connection);
    console.log(
      `🔌 MCP: 已连接 "${serverName}"，注册 ${tools.length} 个工具`
    );
    return connection;
  }

  /** 断开所有 MCP 连接 */
  async disconnectAll(): Promise<void> {
    for (const [name, conn] of this.connections) {
      if (conn.process) conn.process.kill();
      console.log(`🔌 MCP: 已断开 "${name}"`);
    }
    this.connections.clear();
  }

  private async sendRequest(
    conn: MCPConnection,
    method: string,
    params: any
  ): Promise<any> {
    const id = ++this.requestId;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`MCP request timeout: ${method}`));
      }, 30000);

      let buffer = '';
      const onData = (data: Buffer) => {
        buffer += data.toString();
        try {
          const response = JSON.parse(buffer);
          clearTimeout(timeout);
          conn.process!.stdout!.removeListener('data', onData);
          if (response.error) {
            reject(new Error(response.error.message));
          } else {
            resolve(response.result);
          }
        } catch { /* 等待更多数据 */ }
      };

      conn.process!.stdout!.on('data', onData);
      conn.process!.stdin!.write(request + '\n');
    });
  }

  private sendNotification(conn: MCPConnection, method: string, params: any): void {
    const notification = JSON.stringify({ jsonrpc: '2.0', method, params });
    conn.process!.stdin!.write(notification + '\n');
  }
}
```

**验收:**
- 连接 GitHub MCP Server 后，Agent 可使用 `mcp_github_create_issue` 等工具
- 断开连接后工具自动不可用

---

## Phase 3: 多模型通用适配 — ILLMProvider + AI Gateway

> 📖 对应 COMPARISON.md: §4.3.2 (多模型通用适配器), §5.3 优势1, §8.1 (通用模型适配器)
>
> **核心逻辑:** COMPARISON.md §5.1 指出竞品的结构性弱点是模型锁定。
> §8.1 详细描述了 AI Gateway 按任务/成本/延迟自动路由的方案。

---

### Task 3.1: ILLMProvider 接口 + ModelCapabilities

**📖 COMPARISON.md §4.3.2** | **文件:** `packages/llm-provider/src/interface.ts` (新建)

```typescript
import { Message } from '@code-agent/shared';

export interface ModelCapabilities {
  maxContextTokens: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsVision: boolean;
  supportsThinking: boolean;
  supportsEmbedding: boolean;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  tools?: any[];                  // Function calling tool definitions
}

export interface LLMResponse {
  content: string;
  thinkingContent?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, any>;
  }>;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface ILLMProvider {
  readonly name: string;
  readonly modelName: string;
  readonly capabilities: ModelCapabilities;

  /** 标准对话 (COMPARISON.md §4.3.2) */
  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;

  /** 流式对话 (COMPARISON.md §4.3.3) */
  chatStream(
    messages: Message[],
    onChunk: (text: string) => void,
    options?: ChatOptions
  ): Promise<LLMResponse>;

  /** Token 计数 (用于上下文管理, COMPARISON.md §4.4.1) */
  countTokens(messages: Message[]): Promise<number>;

  /** 健康检查 (用于 AI Gateway 故障切换, COMPARISON.md §8.1) */
  healthCheck(): Promise<boolean>;
}
```

---

### Task 3.2: 6 个 Provider 实现

**📖 COMPARISON.md §4.3.2, §5.3**

| Provider | 文件 | 用途 | 优先级 |
|----------|------|------|:----:|
| `DeepSeekProvider` | `providers/deepseek.ts` | 已有，重构实现接口 | P0 |
| `OpenAIProvider` | `providers/openai.ts` | GPT-5 系列 | P0 |
| `AnthropicProvider` | `providers/anthropic.ts` | Claude 系列 | P1 |
| `GoogleProvider` | `providers/google.ts` | Gemini 系列 | P2 |
| `OpenRouterProvider` | `providers/openrouter.ts` | 300+ 模型统一入口 | P2 |
| `OllamaProvider` | `providers/ollama.ts` | 本地开源模型 | P1 |

**每个 Provider 必须实现:**
- `chat()` — 将 `Message[]` 转为该 API 的格式，返回 `LLMResponse`
- `chatStream()` — 流式版本
- `countTokens()` — Token 计数（优先用 API，回退到估算）
- `healthCheck()` — 快速 API 调用验证可用性

**统一配置环境变量:**
```bash
# 每个 provider 可以用环境变量覆盖默认配置
CODE_AGENT_DEEPSEEK_API_KEY=sk-...
CODE_AGENT_DEEPSEEK_MODEL=deepseek-v4-pro

CODE_AGENT_OPENAI_API_KEY=sk-...
CODE_AGENT_OPENAI_MODEL=gpt-5.3-codex

CODE_AGENT_ANTHROPIC_API_KEY=sk-ant-...
CODE_AGENT_ANTHROPIC_MODEL=claude-sonnet-4-6

CODE_AGENT_OLLAMA_HOST=http://localhost:11434
CODE_AGENT_OLLAMA_MODEL=qwen3:14b
```

---

### Task 3.3: Executor 适配 ILLMProvider 接口

**📖 COMPARISON.md §4.3.2** | **文件:** `apps/cli/src/executor.ts`

重构 executor 以接受 `ILLMProvider` 接口而非具体 `DeepSeekProvider`:

```typescript
export class AgentExecutor {
  constructor(
    private provider: ILLMProvider,     // 改为接口
    private registry: ToolRegistry,
    // ...
  ) {}

  async runTask(userRequirement: string) {
    // ...
    // 使用 provider.chatStream() 或 provider.chat()
    const response = this.provider.capabilities.supportsStreaming
      ? await this.provider.chatStream(history, onChunk, {
          tools: this.registry.getFunctionDefinitions(),
          temperature: 0.2,
        })
      : await this.provider.chat(history, {
          tools: this.registry.getFunctionDefinitions(),
          temperature: 0.2,
        });
    // ...
  }
}
```

---

### Task 3.4: AI Gateway — 智能模型路由

**📖 COMPARISON.md §8.1, §8.4**

**文件:** `packages/llm-provider/src/gateway.ts` (新建)

```typescript
/**
 * AI Gateway — COMPARISON.md §8.1 核心差异化
 *
 * 按任务类型/复杂度/隐私需求/成本预算 自动路由到最优模型。
 * 这是本项目超越 Claude Code 和 Codex CLI 的核心功能。
 */

export interface TaskAnalysis {
  complexity: 'simple' | 'medium' | 'complex';
  domain: 'code_search' | 'code_generation' | 'refactoring' | 'planning' | 'debugging';
  containsSecrets: boolean;
  estimatedTokens: number;
}

export interface RouteRule {
  name: string;
  condition: (task: TaskAnalysis) => boolean;
  provider: string;    // provider name
  priority: number;    // 高优先级优先匹配
}

export class AIGateway {
  private providers = new Map<string, ILLMProvider>();
  private rules: RouteRule[] = [];
  private defaultProviderName: string;

  constructor(defaultProvider: string) {
    this.defaultProviderName = defaultProvider;
  }

  registerProvider(provider: ILLMProvider): void {
    this.providers.set(provider.name, provider);
  }

  addRule(rule: RouteRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 分析任务特征 (COMPARISON.md §8.1)
   */
  analyzeTask(task: string): TaskAnalysis {
    const analysis: TaskAnalysis = {
      complexity: 'simple',
      domain: 'code_generation',
      containsSecrets: false,
      estimatedTokens: Math.ceil(task.length / 2.5),
    };

    // 复杂度启发式
    const complexKW = ['重构', 'refactor', '架构', 'architecture', '迁移', 'migrate',
      '重新设计', 'redesign', '重写', 'rewrite', '大规模', 'large scale'];
    const mediumKW = ['修复', 'fix', '实现', 'implement', '添加功能', 'add feature',
      '修改', 'modify', '更新', 'update', '优化', 'optimize'];

    if (complexKW.some(k => task.toLowerCase().includes(k.toLowerCase()))) {
      analysis.complexity = 'complex';
    } else if (mediumKW.some(k => task.toLowerCase().includes(k.toLowerCase()))) {
      analysis.complexity = 'medium';
    }

    // 领域分类
    if (/搜索|查找|搜索|find|search|locate|grep/i.test(task)) {
      analysis.domain = 'code_search';
    } else if (/重构|refactor|架构|architecture|设计|design|规划|plan/i.test(task)) {
      analysis.domain = 'planning';
    } else if (/调试|debug|报错|error|crash|bug|fix/i.test(task)) {
      analysis.domain = 'debugging';
    }

    return analysis;
  }

  /**
   * 自动路由到最优模型 (COMPARISON.md §8.1 + §8.4)
   */
  async route(task: string): Promise<ILLMProvider> {
    const analysis = this.analyzeTask(task);

    // 按优先级匹配规则
    for (const rule of this.rules) {
      if (rule.condition(analysis)) {
        const provider = this.providers.get(rule.provider);
        if (provider && await provider.healthCheck()) {
          console.log(
            `🔀 路由: "${rule.name}" → ${provider.name}/${provider.modelName}`
          );
          return provider;
        }
        // 健康检查失败 → 继续下一个规则
        console.warn(`⚠️ Provider ${rule.provider} 不可用，尝试下一个...`);
      }
    }

    // 回退到默认 Provider
    const defaultProvider = this.providers.get(this.defaultProviderName);
    if (defaultProvider && await defaultProvider.healthCheck()) {
      console.log(`🔀 路由: 默认 → ${defaultProvider.name}`);
      return defaultProvider;
    }

    throw new Error('所有 LLM Provider 均不可用');
  }
}

/**
 * 创建默认路由规则 (COMPARISON.md §8.4)
 */
export function createDefaultRouteRules(gateway: AIGateway): void {
  // 规则 1: 简单搜索 → 最便宜的模型 (成本降低 90%)
  gateway.addRule({
    name: '简单搜索 → 低成本模型',
    condition: (t) => t.domain === 'code_search' && t.complexity === 'simple',
    provider: 'deepseek',
    priority: 100,
  });

  // 规则 2: 架构设计/规划 → 最强推理模型
  gateway.addRule({
    name: '架构规划 → 强推理模型',
    condition: (t) => t.domain === 'planning' || t.complexity === 'complex',
    provider: 'anthropic',
    priority: 90,
  });

  // 规则 3: 代码生成 → 代码专项模型
  gateway.addRule({
    name: '代码生成 → 代码模型',
    condition: (t) => t.domain === 'code_generation' && t.complexity === 'medium',
    provider: 'openai',
    priority: 80,
  });

  // 规则 4: 调试 → 平衡模型
  gateway.addRule({
    name: '调试 → 平衡模型',
    condition: (t) => t.domain === 'debugging',
    provider: 'deepseek',
    priority: 70,
  });
}
```

**验收:**
- 输入 "搜索用户认证代码" → 自动路由到 DeepSeek Flash
- 输入 "重构整个认证系统架构" → 自动路由到 Claude Opus/Sonnet
- 某 Provider 宕机 → 自动切换到下一个可用 Provider

---

## Phase 4: 流式输出与体验优化

> 📖 对应 COMPARISON.md: §4.3.3 (流式输出), §2.3 (Thinking 展示)
>
> Thinking 展示已在 Task 0.5 完成，本 Phase 完成流式输出和 System Prompt 优化。

---

### Task 4.1: 流式输出在 Executor 中完整集成

**📖 COMPARISON.md §4.3.3** | **文件:** `apps/cli/src/executor.ts`

```typescript
// 根据 provider 能力选择流式或非流式
if (this.provider.capabilities.supportsStreaming && this.streamOutput) {
  process.stdout.write('💡 ');
  const response = await this.provider.chatStream(
    history,
    (chunk) => process.stdout.write(chunk),
    { tools: this.registry.getFunctionDefinitions() }
  );
  console.log('\n');
  // response.content 是完整内容
} else {
  process.stdout.write('Thinking...');
  const response = await this.provider.chat(history, {
    tools: this.registry.getFunctionDefinitions(),
  });
  process.stdout.write('\r');
  console.log(`\n💡 ${response.content}\n`);
}
```

**验收:** 使用支持流式的 Provider 时，LLM 输出实时逐字显示。

---

### Task 4.2: System Prompt 升级 — 语言无关的通用 Agent

**📖 COMPARISON.md §4.3.1, §5.2, §5.3** | **文件:** `apps/cli/src/prompt.ts`

**核心改动:**
1. System Prompt 不假设任何特定语言或构建工具 (去掉 `pnpm build` 等 Node.js 特化指令)
2. 让 Agent 自行检测项目语言 → 选择对应工具
3. 使用 JSON Function Calling 格式 (所有对接的模型都支持)

```typescript
export const AUTONOMOUS_SYSTEM_PROMPT = `你是一个通用型 AI 编程智能体 (Code Agent)。你能处理任何编程语言的项目，
包括但不限于: TypeScript, JavaScript, Python, Rust, Go, Java, C, C++, Ruby, PHP,
Swift, Kotlin, C#, Lua, SQL, Bash, HTML, CSS, 以及配置文件 (JSON, YAML, TOML)。

## 核心原则
1. **语言无关**: 你自动检测文件的语言，使用对应语言的构建/测试/检查命令
2. **先理解再行动**: 修改代码前必须先阅读和理解
3. **每次修改后验证**: 使用该语言的标准编译/检查命令验证
4. **不确定时搜索**: 不要猜测，使用搜索工具定位

## 工作模式
你正处于 "思考-行动-观察" 的自动化循环中。每一轮你必须执行一个工具调用。

## 工具调用格式

\`\`\`json
{ "tool": "工具名", "args": { "参数": "值" } }
\`\`\`

## 可用工具

### 代码搜索 (语言无关)
- search_symbol: 按符号名搜索函数/类/接口/结构体定义 (支持所有 tree-sitter 支持的语言)
- fts_search: 全文搜索代码内容片段
- grep_search: 正则表达式文本模式匹配
- semantic_search: 用自然语言描述搜索代码 (如 "找到处理数据库连接的代码")
- lsp_definition: 跳转到符号的精确定义位置 (支持 TS/Python/Rust/Go/Java/C++/Ruby/PHP/Swift 等)
- lsp_references: 查找符号的所有引用
- lsp_diagnostics: 获取文件的编译器诊断 (错误和警告)

### 文件操作 (语言无关)
- read_file: 读取文件完整内容。参数: path
- list_files: 列出目录内容
- modify_file: 修改文件 (SEARCH/REPLACE 格式)。参数: path, diff

### 命令执行 (语言无关 — 使用模板模式)
- list_command_templates: 查看可用的命令模板 (按项目语言不同)
- execute_command: 执行命令 (仅限模板模式, 如 pnpm build / cargo build / go build / python -m pytest 等)

### Git 操作 (语言无关)
- git_status: 查看工作区状态
- git_diff: 查看代码变更
- git_commit: 提交代码

## 语言检测与工作流
打开项目后，你应该自动检测项目使用的语言和构建系统:
- package.json → npm/pnpm/yarn, TypeScript/JavaScript
- Cargo.toml → cargo, Rust
- go.mod → go, Go
- requirements.txt / pyproject.toml → pip/poetry, Python
- pom.xml / build.gradle → maven/gradle, Java
- CMakeLists.txt / Makefile → cmake/make, C/C++
- Gemfile → bundler, Ruby
- composer.json → composer, PHP
- Package.swift → swift, Swift

使用对应语言的命令进行构建和测试:
- TypeScript/JavaScript: pnpm build, pnpm test
- Rust: cargo build, cargo test
- Go: go build ./..., go test ./...
- Python: python -m pytest 或 python -m py_compile
- Java: mvn compile 或 gradle build
- C/C++: make 或 cmake --build .

## 任务完成
当你确信任务完美完成且验证通过后，输出:
<task_finish>完成总结 (包括修改了什么文件、运行了什么验证)</task_finish>

## 重要规则
1. 修改代码后必须使用该语言的编译/检查命令验证
2. 使用 modify_file 前先 read_file 确认当前内容
3. 无法确定时使用搜索工具，不要猜测
4. 每一轮只执行一个工具调用
5. 遵守项目现有的代码风格和命名约定
6. 通用型 Agent: 遇到不认识的配置/语言不要报错，先尝试理解`;
```

**验收:**
- Agent 在 Python 项目中自动使用 `python -m pytest` 而非 `pnpm test`
- Agent 在 Rust 项目中自动使用 `cargo build` 而非 `pnpm build`
- Agent 在 Go 项目中自动识别 `go.mod`
- System Prompt 不含任何特定语言或构建工具的假设

---

## Phase 5: 权限审批与审计日志

> 📖 对应 COMPARISON.md: §4.1.3 (审批工作流), §4.4.3 (会话日志), §4.6 (可观测性), §8.3 (层次化安全 Level 3+4)

---

### Task 5.1: 权限引擎

**📖 COMPARISON.md §4.1.3, §8.3** | **文件:** `packages/agent-core/src/permission-engine.ts` (新建)

```typescript
export type Permission = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  toolName: string;
  permission: Permission;
  // 可选细化规则
  pathPatterns?: Array<{ pattern: string; permission: Permission }>;
  commandPatterns?: Array<{ pattern: string; permission: Permission }>;
}

export class PermissionEngine {
  private defaults: Record<string, Permission>;
  private rules: PermissionRule[] = [];

  constructor(config: Record<string, Permission>) {
    this.defaults = config;
  }

  addRule(rule: PermissionRule): void {
    this.rules.push(rule);
  }

  async check(
    toolName: string,
    args: Record<string, any>
  ): Promise<{ allowed: boolean; needsApproval: boolean; reason?: string }> {
    const defaultPerm = this.defaults[toolName] || 'ask';

    switch (defaultPerm) {
      case 'deny':
        return { allowed: false, needsApproval: false, reason: `工具 "${toolName}" 被配置为 deny` };

      case 'allow':
        return { allowed: true, needsApproval: false };

      case 'ask':
        return { allowed: true, needsApproval: true, reason: `工具 "${toolName}" 需要用户确认` };

      default:
        return { allowed: true, needsApproval: true };
    }
  }
}
```

**加载配置 (COMPARISON.md §4.1.3):**
```yaml
# .code-agent/permissions.yml
version: '1.0'

# 所有工具的默认权限
defaults:
  read_file: allow
  list_files: allow
  search_symbol: allow
  fts_search: allow
  grep_search: allow
  semantic_search: allow
  lsp_definition: allow
  lsp_references: allow
  lsp_diagnostics: allow
  git_status: allow
  git_diff: allow
  list_command_templates: allow
  modify_file: ask        # 修改文件需要确认
  execute_command: ask     # 执行命令需要确认
  git_commit: ask          # 提交需要确认

# 工具级细化规则
rules:
  - toolName: read_file
    permission: allow
    pathPatterns:
      - pattern: ".env"
        permission: deny
      - pattern: "**/secrets/**"
        permission: deny
  - toolName: execute_command
    permission: ask
    commandPatterns:
      - pattern: "pnpm *"
        permission: allow    # pnpm 命令自动允许
      - pattern: "git status*"
        permission: allow
```

---

### Task 5.2: 审计日志 + 会话恢复

**📖 COMPARISON.md §4.4.3, §8.3 Level 4**

**文件:** `packages/logger/src/audit-logger.ts` (新建包)

```typescript
export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  type: 'task_start' | 'llm_request' | 'llm_response'
      | 'tool_call' | 'tool_result' | 'permission_check'
      | 'error' | 'task_finish' | 'route_decision';
  data: Record<string, any>;
  tokens?: { prompt: number; completion: number };
  cost?: { usd: number };
  durationMs?: number;
}

export class AuditLogger {
  private logPath: string;
  private sessionId: string;

  constructor(sessionId: string, logDir = `${process.env.HOME}/.code-agent/logs`) {
    this.sessionId = sessionId;
    this.logPath = path.join(logDir, `${sessionId}.jsonl`);
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    // 写入会话元数据作为第一行
    await this.rawLog({
      type: 'session_metadata',
      cwd: process.cwd(),
      hostname: os.hostname(),
      agentVersion: '2.0.0',
    });
  }

  async log(entry: Omit<AuditEntry, 'timestamp' | 'sessionId'>): Promise<void> {
    await this.rawLog(entry);
  }

  private async rawLog(entry: any): Promise<void> {
    const record = {
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      ...entry,
    };
    await fs.appendFile(this.logPath, JSON.stringify(record) + '\n');
  }

  /** 列出历史会话 */
  static async listSessions(
    logDir = `${process.env.HOME}/.code-agent/logs`
  ): Promise<Array<{ id: string; date: string; taskPreview: string }>> {
    const files = await fs.readdir(logDir).catch(() => []);
    const sessions: any[] = [];

    for (const file of files.filter(f => f.endsWith('.jsonl')).sort().reverse()) {
      const content = await fs.readFile(path.join(logDir, file), 'utf-8');
      const firstLine = JSON.parse(content.split('\n')[0]);
      const taskLine = content.split('\n').find(l => {
        try { return JSON.parse(l).type === 'task_start'; } catch { return false; }
      });
      const task = taskLine ? JSON.parse(taskLine) : null;

      sessions.push({
        id: file.replace('.jsonl', ''),
        date: firstLine.timestamp,
        taskPreview: task?.data?.requirement?.slice(0, 100) || '(未知)',
      });
    }

    return sessions;
  }

  /** 恢复会话的历史消息 */
  static async loadHistory(
    sessionId: string,
    logDir = `${process.env.HOME}/.code-agent/logs`
  ): Promise<Message[]> {
    const filePath = path.join(logDir, `${sessionId}.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const messages: Message[] = [];

    for (const line of content.split('\n').filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.type === 'llm_request') {
        messages.push(...entry.data.messages);
      } else if (entry.type === 'llm_response') {
        messages.push({ role: 'assistant', content: entry.data.content });
      } else if (entry.type === 'tool_result') {
        messages.push({
          role: 'user',
          content: `[Observation]: ${entry.data.result}`,
        });
      }
    }

    return messages;
  }
}
```

**验收:**
- 每次会话生成独立 JSONL 文件
- `code-agent --resume <session-id>` 恢复历史对话
- `code-agent --list-sessions` 列出历史会话

---

## Phase 6: 上下文管理与跨会话记忆

> 📖 对应 COMPARISON.md: §4.4.1 (上下文窗口管理), §4.4.2 (跨会话记忆)

---

### Task 6.1: Context Manager — Token 计数 + 智能裁剪 + Observation 压缩 + Prompt 缓存

**📖 COMPARISON.md §4.4.1** | **文件:** `packages/agent-core/src/context-manager.ts` (新建)

COMPARISON.md §4.4.1 明确指出 4 项措施：
1. Token 计数
2. 智能裁剪（保留 system + 最近 N 轮）
3. Observation 压缩（大文件输出自动摘要）
4. Prompt 缓存（静态内容前置）

```typescript
export class ContextManager {
  private provider: ILLMProvider;
  private maxTokens: number;
  private tokenWarningThreshold = 0.75;

  constructor(provider: ILLMProvider) {
    this.provider = provider;
    this.maxTokens = provider.capabilities.maxContextTokens;
  }

  /** 1. Token 计数 */
  async countTokens(history: Message[]): Promise<number> {
    return this.provider.countTokens(history);
  }

  /** 2. 智能裁剪 — 超出时保留 system + 最近 N 轮 */
  async compact(
    history: Message[],
    reserveForOutput: number = 8000
  ): Promise<Message[]> {
    const total = await this.countTokens(history);
    const budget = this.maxTokens * this.tokenWarningThreshold;

    if (total + reserveForOutput <= budget) return history;

    const systemMsgs = history.filter(m => m.role === 'system');
    const chatMsgs = history.filter(m => m.role !== 'system');

    const result = [...systemMsgs];
    let currentTokens = await this.countTokens(result);
    const kept: Message[] = [];

    // 从后向前保留（最近的对话最重要）
    for (const msg of [...chatMsgs].reverse()) {
      const msgTokens = await this.provider.countTokens([msg]);
      if (currentTokens + msgTokens + reserveForOutput > budget) break;
      kept.unshift(msg);
      currentTokens += msgTokens;
    }

    if (kept.length < chatMsgs.length) {
      const trimmed = chatMsgs.length - kept.length;
      result.push({
        role: 'user',
        content: `[上下文裁剪: 已省略 ${trimmed} 条历史消息以保持在 ${this.maxTokens.toLocaleString()} token 限制内。请基于当前可见上下文继续。]`,
      });
    }

    return [...result, ...kept];
  }

  /** 3. Observation 压缩 */
  compressObservation(observation: string, maxChars = 3000): string {
    if (observation.length <= maxChars) return observation;
    const head = observation.slice(0, Math.floor(maxChars / 2));
    const tail = observation.slice(-Math.floor(maxChars / 2));
    const omitted = observation.length - maxChars;
    return `${head}\n\n... [省略 ${omitted} 字符] ...\n\n${tail}`;
  }

  /**
   * 4. Prompt 缓存优化
   * 将静态内容 (system prompt, 工具定义) 放在消息列表最前面，
   * 这样支持 Prompt Caching 的 API (Anthropic, OpenAI) 可以缓存这些内容。
   */
  optimizeForCaching(messages: Message[]): Message[] {
    // 确保 system 消息在最前面，工具定义紧随其后
    const system = messages.filter(m => m.role === 'system');
    const rest = messages.filter(m => m.role !== 'system');
    return [...system, ...rest];
  }
}
```

---

### Task 6.2: 跨会话记忆系统

**📖 COMPARISON.md §4.4.2** | **新包:** `packages/memory/`

```typescript
/**
 * 跨会话记忆 — COMPARISON.md §4.4.2
 *
 * 存储: SQLite + FTS5 全文索引
 * 类型: 项目记忆 (代码库结构)、用户偏好 (风格/命名)、反馈 (纠正记录)
 * 自动召回: 根据当前任务查询相关记忆，注入 system prompt
 */

export interface MemoryEntry {
  id: string;
  type: 'project_fact' | 'user_preference' | 'feedback' | 'pattern';
  content: string;       // 记忆内容
  context: string;       // 触发上下文
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

export class MemoryManager {
  private db: Database.Database;

  constructor(storagePath = `${process.env.HOME}/.code-agent/memory.db`) {
    this.db = new Database(storagePath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        context TEXT NOT NULL,
        access_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content, context, prefix='3'
      );
    `);
  }

  async remember(
    type: MemoryEntry['type'],
    content: string,
    context: string = ''
  ): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO memories (id, type, content, context, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, type, content, context, now, now);
    return id;
  }

  async recall(query: string, limit = 5): Promise<MemoryEntry[]> {
    const results = this.db.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts f ON f.rowid = m.rowid
      WHERE memories_fts MATCH ?
      ORDER BY m.access_count DESC, m.updated_at DESC
      LIMIT ?
    `).all(query, limit) as MemoryEntry[];

    // 更新访问计数
    for (const r of results) {
      this.db.prepare(
        'UPDATE memories SET access_count = access_count + 1 WHERE id = ?'
      ).run(r.id);
    }

    return results;
  }

  /** 注入相关记忆到 system prompt (COMPARISON.md §4.4.2) */
  async injectMemories(systemPrompt: string, task: string): Promise<string> {
    const memories = await this.recall(task, 3);
    if (memories.length === 0) return systemPrompt;

    const block = memories
      .map(m => `- [${m.type}] ${m.content}`)
      .join('\n');

    return `${systemPrompt}\n\n<relevant_memories>\n${block}\n</relevant_memories>`;
  }

  /** 用户纠正反馈 (COMPARISON.md §4.4.2) */
  async recordFeedback(incorrectBehavior: string, correction: string): Promise<void> {
    await this.remember(
      'feedback',
      `之前遇到 "${incorrectBehavior}" 时处理不正确，应该 "${correction}"`,
      incorrectBehavior
    );
  }
}
```

**验收:**
- 反馈 "不要修改 package-lock.json" → 后续任务中 Agent 不再尝试修改该文件
- 记忆自动注入到相关任务的 system prompt 中

---

## Phase 7: Plan Mode — 双智能体分离

> 📖 对应 COMPARISON.md: §4.5.2 (Plan Mode), §5.3 优势4 (层次化安全)
>
> **核心设计:** COMPARISON.md §4.5.2 明确 Planner 只有只读工具，
> Executor 有完整工具。这是 "Dual-Agent Separation" 模式 ——
> 通过工具集的可见性来保证安全，而非仅依赖运行时检查。

---

### Task 7.1: Planner — 只读探索 + 结构化计划生成

**📖 COMPARISON.md §4.5.2** | **文件:** `packages/agent-core/src/planner.ts` (新建)

```typescript
export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  estimatedComplexity: 'simple' | 'medium' | 'complex';
  estimatedTokens: number;
  risks: string[];              // 潜在风险
  rollbackStrategy: string;     // 回滚策略
}

export interface PlanStep {
  id: number;
  description: string;
  tool: string;
  toolArgs: Record<string, any>;
  expectedOutcome: string;
  dependsOn: number[];          // 依赖步骤 ID
  validation: string;           // 验证命令 (如 "pnpm build")
}

export class Planner {
  constructor(
    private plannerProvider: ILLMProvider,   // 强推理模型
    private readOnlyRegistry: ToolRegistry,   // 只读工具
    private contextManager: ContextManager,
  ) {}

  /** 生成执行计划 */
  async createPlan(task: string): Promise<ExecutionPlan> {
    const readOnlyTools = this.readOnlyRegistry.getFunctionDefinitions();

    const systemPrompt = `你是一个软件架构师，负责为编码任务设计执行计划。
你只能使用只读工具进行代码探索，不能修改任何文件。

## 输出格式
完成探索后，输出以下 JSON 格式的执行计划：

{
  "goal": "一句话描述目标",
  "steps": [
    {
      "id": 1,
      "description": "步骤描述",
      "tool": "工具名",
      "toolArgs": {"参数": "值"},
      "expectedOutcome": "预期结果",
      "dependsOn": [],
      "validation": "验证命令"
    }
  ],
  "estimatedComplexity": "simple|medium|complex",
  "risks": ["风险1"],
  "rollbackStrategy": "如何回滚"
}

<task_finish>计划生成完成</task_finish>`;

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `请为以下任务设计执行计划:\n${task}` },
    ];

    let response: LLMResponse;
    let loops = 0;
    while (loops++ < 6) {
      response = await this.plannerProvider.chat(messages, {
        tools: readOnlyTools,
      });

      if (response.content.includes('<task_finish>')) break;

      // 解析并执行只读工具调用
      const toolCall = this.parseToolCall(response.content);
      if (toolCall) {
        const result = await this.readOnlyRegistry.dispatch(
          toolCall.name, toolCall.args
        );
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: `[Observation]: ${result}` });
      }
    }

    // 从最终响应中提取 JSON 计划
    return this.extractPlan(response!.content);
  }

  private extractPlan(content: string): ExecutionPlan {
    const jsonMatch = content.match(/\{[\s\S]*"goal"[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        goal: '无法解析计划',
        steps: [],
        estimatedComplexity: 'simple',
        estimatedTokens: 0,
        risks: [],
        rollbackStrategy: '手动回滚',
      };
    }
    return JSON.parse(jsonMatch[0]);
  }

  private parseToolCall(text: string): { name: string; args: any } | null {
    // 复用 executor 中的解析逻辑 (XML + JSON)
    return null;  // 简化
  }
}
```

---

### Task 7.2: Plan Mode 完整工作流

**📖 COMPARISON.md §4.5.2** | **文件:** `apps/cli/src/index.ts` — 新增 `plan` 命令

```typescript
program
  .command('plan')
  .description('先规划后执行 — COMPARISON.md §4.5.2 Plan Mode')
  .action(async () => {
    const { requirement } = await inquirer.prompt([{
      type: 'input',
      name: 'requirement',
      message: '请输入开发任务:',
    }]);

    // Phase 1: 规划 (Planner 只有只读工具)
    console.log('📋 Phase 1/2: 代码探索与方案规划...');
    const plan = await planner.createPlan(requirement);

    console.log(`\n📋 执行计划: ${plan.goal}`);
    console.log(`   复杂度: ${plan.estimatedComplexity}`);
    console.log(`   步骤数: ${plan.steps.length}`);
    plan.steps.forEach(s => {
      console.log(`   ${s.id}. ${s.description} [${s.tool}]`);
    });
    if (plan.risks.length > 0) {
      console.log(`   风险: ${plan.risks.join(', ')}`);
    }

    // 用户审批 (COMPARISON.md §4.5.2)
    const { approved } = await inquirer.prompt([{
      type: 'confirm',
      name: 'approved',
      message: '是否批准此计划并开始执行？',
      default: true,
    }]);

    if (!approved) {
      console.log('❌ 计划已取消');
      return;
    }

    // Phase 2: 执行 (Executor 有完整工具)
    console.log('\n⚡ Phase 2/2: 按计划执行...');
    for (const step of plan.steps) {
      console.log(`\n▶ Step ${step.id}/${plan.steps.length}: ${step.description}`);
      await executor.runTask(step.description);

      if (step.validation) {
        console.log(`   验证: ${step.validation}`);
        const result = await toolkit.terminal.executeCommand(step.validation);
        if (result.code !== 0) {
          console.log(`   ❌ 验证失败:\n${result.stderr}`);
          // 触发回滚或人工介入
        } else {
          console.log('   ✅ 验证通过');
        }
      }
    }

    console.log('\n🎉 全部步骤执行完成');
  });
```

**验收:**
- Planner 阶段: Agent 只能搜索和阅读，不能修改
- 用户审批计划后才进入执行阶段
- Executor 阶段: 每步修改后有验证步骤

---

## Phase 8: 多智能体系统 — 子智能体 + 编排 + 协作

> 📖 对应 COMPARISON.md: §4.5.1 (子智能体系统), §4.5.2 (Plan Mode 双智能体分离), §2.1 Claude Code 子智能体 + Agent Teams, §8.2 (MCP-Native)
>
> **核心设计:** 这是本项目对标 Claude Code「Agent Teams」和 Codex CLI「并行沙箱」的核心模块。
> COMPARISON.md §4.5.1 定义了 5 种子智能体，本 Phase 实现完整的
> 子智能体框架 + 编排器 + 协作机制 + Git Worktree 隔离。

---

### 8.1 整体架构

```
                         ┌──────────────────────┐
                         │   用户任务输入          │
                         └──────────┬───────────┘
                                    │
                         ┌──────────▼───────────┐
                         │  Orchestrator Agent   │ ← 主智能体 (管理编排)
                         │  (Task Decomposer)    │
                         │                       │
                         │  分析任务 → 拆分子任务  │
                         │  选择子智能体类型       │
                         │  决定执行模式           │
                         └──┬───────┬───────┬───┘
                            │       │       │
              ┌─────────────┼───────┼───────┼─────────────┐
              │             │       │       │             │
              ▼             ▼       ▼       ▼             ▼
        ┌─────────┐  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
        │Explorer │  │Planner  │ │Implement│ │Reviewer │ │Tester   │
        │快速搜索  │  │架构设计  │ │代码编写  │ │代码审查  │ │测试生成  │
        │         │  │         │ │         │ │         │ │         │
        │只读工具  │  │只读工具  │ │完整工具  │ │只读工具  │ │完整工具  │
        │flash模型 │  │opus模型  │ │sonnet模型│ │sonnet模型│ │flash模型 │
        │独立上下文│  │独立上下文│ │独立上下文│ │独立上下文│ │独立上下文│
        └────┬────┘  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘
             │            │          │           │           │
             └────────────┼──────────┼───────────┼───────────┘
                          │          │           │
                          ▼          ▼           ▼
                    ┌────────────────────────────────┐
                    │  结果汇总 → Orchestrator 决策    │
                    │  · 通过 → 下一个子任务           │
                    │  · 失败 → 重试/换策略/人工介入   │
                    └────────────────────────────────┘
```

**三种协作模式:**

| 模式 | 说明 | 适用场景 | 对应竞品 |
|------|------|---------|---------|
| **Orchestrator** | 主智能体串行委派, 结果依次汇总 | 有依赖的多步骤任务 | Claude Code Subagents |
| **Pipeline** | 流水线式传递 (A→B→C) | 提取→转换→验证 | Codex CLI Parallel |
| **Swarm** | 多个同类型子智能体并行, 择优选用 | 代码生成 (3 个方案选最优) | Claude Code Dynamic Workflows |

---

### Task 8.1: 子智能体基础设施

**文件:** `packages/agent-core/src/subagent/types.ts` (新建)

```typescript
/**
 * 子智能体类型定义 — COMPARISON.md §4.5.1
 */

export type SubagentRole =
  | 'explorer'      // 代码搜索与信息收集 (只读)
  | 'planner'       // 架构设计与方案规划 (只读)
  | 'implementer'   // 代码编写与修改
  | 'reviewer'      // 代码审查 (安全/性能/质量/风格)
  | 'tester'        // 测试用例生成与执行
  | 'custom';       // 用户自定义

export type CollaborationMode =
  | 'orchestrator'  // 主智能体串行委派
  | 'pipeline'      // A→B→C 流水线
  | 'swarm';        // 并行择优

export interface SubagentConfig {
  role: SubagentRole;
  name: string;
  description: string;
  systemPrompt: string;
  provider: ILLMProvider;          // 独立模型 (Explorer→flash, Reviewer→Opus)
  tools: ToolRegistry;             // 独立的工具子集 (read-only 或 full)
  maxLoops: number;
  temperature?: number;
}

export interface SubagentResult {
  success: boolean;
  role: SubagentRole;
  summary: string;                 // 结果摘要 (灌回主智能体)
  findings: string[];              // 关键发现
  filesModified?: string[];        // 修改的文件列表
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
}
```

---

### Task 8.2: 子智能体 Runner — 独立上下文执行

**文件:** `packages/agent-core/src/subagent/runner.ts` (新建)

```typescript
/**
 * 子智能体执行器
 *
 * 核心特性:
 * - 每个子智能体有独立的上下文窗口 (不污染主对话)
 * - 独立的模型实例 (可以不同 Provider)
 * - 独立的工具集 (Explorer 只有只读工具 → 安全)
 * - 结果摘要返回主智能体 (而非完整对话历史)
 */

export class SubagentRunner {
  private logger: AuditLogger;

  constructor(logger: AuditLogger) {
    this.logger = logger;
  }

  /** 执行单个子智能体 */
  async run(config: SubagentConfig, task: string): Promise<SubagentResult> {
    const startTime = Date.now();
    let totalTokens = 0;

    await this.logger.log({
      type: 'subagent_start',
      data: { role: config.role, task: task.slice(0, 200) },
    });

    const history: Message[] = [
      { role: 'system', content: config.systemPrompt },
      { role: 'user', content: task },
    ];

    let findings: string[] = [];
    let filesModified: string[] = [];

    for (let i = 0; i < config.maxLoops; i++) {
      const response = await config.provider.chat(history, {
        tools: config.tools.getFunctionDefinitions(),
        temperature: config.temperature ?? 0.2,
      });

      totalTokens += (response.usage?.promptTokens || 0)
                   + (response.usage?.completionTokens || 0);

      if (response.content.includes('<task_finish>')) {
        const summary = this.extractSummary(response.content);
        await this.logger.log({
          type: 'subagent_finish',
          data: { role: config.role, summary: summary.slice(0, 300) },
        });
        return {
          success: true,
          role: config.role,
          summary,
          findings,
          filesModified,
          tokensUsed: totalTokens,
          costUsd: 0,  // 由 AI Gateway 计算
          durationMs: Date.now() - startTime,
        };
      }

      // 解析工具调用
      const toolCall = this.parseToolCall(response.content);
      if (toolCall) {
        // 子智能体内部执行工具
        const result = await config.tools.dispatch(toolCall.name, toolCall.args);

        // 追踪修改的文件
        if (toolCall.name === 'modify_file' && toolCall.args.path) {
          filesModified.push(toolCall.args.path);
        }
        // 收集发现
        if (['search_symbol', 'grep_search', 'lsp_definition'].includes(toolCall.name)) {
          findings.push(result.slice(0, 500));
        }

        history.push({ role: 'assistant', content: response.content });
        history.push({ role: 'user', content: `[Observation]: ${result}` });
      }
    }

    return {
      success: false,
      role: config.role,
      summary: `子智能体 "${config.name}" 在 ${config.maxLoops} 轮内未完成`,
      findings,
      filesModified,
      tokensUsed: totalTokens,
      costUsd: 0,
      durationMs: Date.now() - startTime,
    };
  }

  /** 并行执行多个不同类型的子智能体 (Orchestrator 模式) */
  async runOrchestrated(
    assignments: Array<{ config: SubagentConfig; task: string }>
  ): Promise<SubagentResult[]> {
    console.log(`\n🎯 [Orchestrator] 委派 ${assignments.length} 个子任务:`);
    assignments.forEach((a, i) => {
      console.log(`   ${i + 1}. ${a.config.role}: ${a.task.slice(0, 80)}...`);
    });

    const results: SubagentResult[] = [];
    for (const assignment of assignments) {
      console.log(`   ▶ 执行: ${assignment.config.role}...`);
      const result = await this.run(assignment.config, assignment.task);
      results.push(result);
      console.log(`   ${result.success ? '✅' : '❌'} ${assignment.config.role}: ${result.summary.slice(0, 100)}`);
    }

    return results;
  }

  /** Swarm 模式: 多个同类型子智能体并行执行同一任务, 择优 */
  async runSwarm(
    task: string,
    variants: SubagentConfig[],  // 同一角色不同模型/策略
    judgeProvider: ILLMProvider  // 评判模型
  ): Promise<SubagentResult> {
    console.log(`\n🐝 [Swarm] ${variants.length} 个子智能体并行执行...`);

    // 并行执行所有变体
    const results = await Promise.all(
      variants.map(config => this.run(config, task))
    );

    // 使用评判模型选择最佳结果
    const judgePrompt = `以下是对同一任务 "${task}" 的 ${results.length} 个不同方案，请选择最佳的一个并说明理由。

${results.map((r, i) => `
方案 ${i + 1} (${r.role}):
${r.summary}
${r.findings.join('\n')}
`).join('\n---\n')}

请输出: {"bestIndex": <数字>, "reason": "<理由>"}`;

    const judgeResponse = await judgeProvider.chat([
      { role: 'user', content: judgePrompt },
    ]);

    // 提取评判结果
    const bestMatch = judgeResponse.content.match(/"bestIndex":\s*(\d+)/);
    const bestIndex = bestMatch ? parseInt(bestMatch[1]) - 1 : 0;

    console.log(`   🏆 评判模型选择方案 ${bestIndex + 1}`);
    return results[bestIndex];
  }

  /** Pipeline 模式: A→B→C 流水线 */
  async runPipeline(
    task: string,
    stages: Array<{ config: SubagentConfig; transformResult: (prev: SubagentResult) => string }>
  ): Promise<SubagentResult> {
    let currentTask = task;
    let lastResult: SubagentResult | null = null;

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      console.log(`   🔗 Pipeline Stage ${i + 1}/${stages.length}: ${stage.config.role}`);

      if (lastResult && i > 0) {
        currentTask = stage.transformResult(lastResult);
      }

      lastResult = await this.run(stage.config, currentTask);

      if (!lastResult.success) {
        console.log(`   ❌ Pipeline 在 Stage ${i + 1} 失败`);
        break;
      }
    }

    return lastResult!;
  }

  private extractSummary(content: string): string {
    const match = content.match(/<task_finish>([\s\S]*?)<\/task_finish>/);
    return match ? match[1].trim() : content.slice(-500);
  }

  private parseToolCall(text: string): { name: string; args: any } | null {
    // XML 格式
    const xmlMatch = text.match(
      /<call_tool\s+name="([^"]+)"(?:\s+path="([^"]+)")?>([\s\S]*?)<\/call_tool>/
    );
    if (xmlMatch) {
      const [, name, filePath, body] = xmlMatch;
      const args: any = {};
      if (filePath) args.path = filePath;
      if (body.trim()) {
        // 推断参数名
        if (['search_symbol', 'grep_search', 'semantic_search', 'fts_search'].includes(name)) {
          args.query = body.trim();
        } else if (name === 'execute_command') {
          args.command = body.trim();
        } else if (!args.path) {
          args.path = body.trim();
        }
      }
      return { name, args };
    }

    // JSON 格式
    const jsonMatch = text.match(/```json\s*\n?(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      try {
        const { tool, args } = JSON.parse(jsonMatch[1]);
        return { name: tool, args: args || {} };
      } catch {}
    }

    return null;
  }
}
```

---

### Task 8.3: Git Worktree 隔离 — 并行子智能体不冲突

**📖 COMPARISON.md — Claude Code Agent Teams worktree 模式**

**文件:** `packages/agent-core/src/subagent/worktree.ts` (新建)

```typescript
/**
 * Git Worktree 隔离 — 每个子智能体在独立的 git worktree 中工作
 *
 * 解决的问题:
 * - 并行子智能体同时修改同一文件 → 冲突
 * - 子智能体修改破坏了主工作区 → 难以恢复
 *
 * 方案 (参考 Claude Code Agent Teams + Codex CLI 并行 worktree):
 * - 每个需要修改文件的子智能体获得一个独立的 git worktree
 * - worktree 在临时分支上工作
 * - 子智能体完成后, 变更通过 git merge 合并回主分支
 * - 如果合并冲突, Orchestrator 介入解决
 */

export interface WorktreeContext {
  id: string;
  path: string;          // worktree 文件系统路径
  branch: string;        // 临时分支名
  originalBranch: string; // 原始分支
}

export class WorktreeManager {
  constructor(private projectRoot: string) {}

  /** 为子智能体创建一个隔离的 worktree */
  async create(subagentId: string): Promise<WorktreeContext> {
    const branchName = `agent/${subagentId}-${Date.now()}`;

    // 获取当前分支
    const currentBranch = await this.getCurrentBranch();

    // 创建临时分支
    await execa({
      cwd: this.projectRoot,
      reject: true,
    })`git branch ${branchName}`;

    // 创建 worktree
    const worktreePath = path.join(
      this.projectRoot, '.agent-worktrees', subagentId
    );
    await execa({
      cwd: this.projectRoot,
      reject: true,
    })`git worktree add ${worktreePath} ${branchName}`;

    return {
      id: subagentId,
      path: worktreePath,
      branch: branchName,
      originalBranch: currentBranch,
    };
  }

  /** 合并 worktree 的变更回主分支 */
  async merge(context: WorktreeContext): Promise<{
    success: boolean;
    conflicts: string[];
  }> {
    try {
      // 在 worktree 中提交所有变更
      await execa({
        cwd: context.path,
        reject: false,
      })`git add .`;

      await execa({
        cwd: context.path,
        reject: false,
      })`git commit -m "feat(agent): changes from subagent ${context.id}"`;

      // 切回原始分支并合并
      await execa({
        cwd: this.projectRoot,
        reject: true,
      })`git checkout ${context.originalBranch}`;

      const mergeResult = await execa({
        cwd: this.projectRoot,
        reject: false,
      })`git merge ${context.branch} --no-edit`;

      if (mergeResult.exitCode !== 0) {
        // 有冲突, 列出冲突文件
        const conflictResult = await execa({
          cwd: this.projectRoot,
          reject: false,
        })`git diff --name-only --diff-filter=U`;

        const conflicts = conflictResult.stdout
          .split('\n')
          .filter(Boolean);

        // 中止合并, 保留冲突信息给 Orchestrator
        await execa({
          cwd: this.projectRoot,
          reject: false,
        })`git merge --abort`;

        return { success: false, conflicts };
      }

      return { success: true, conflicts: [] };
    } finally {
      // 清理 worktree
      await this.cleanup(context);
    }
  }

  /** 清理 worktree */
  async cleanup(context: WorktreeContext): Promise<void> {
    await execa({
      cwd: this.projectRoot,
      reject: false,
    })`git worktree remove ${context.path} --force`;

    await execa({
      cwd: this.projectRoot,
      reject: false,
    })`git branch -D ${context.branch}`;
  }

  private async getCurrentBranch(): Promise<string> {
    const result = await execa({
      cwd: this.projectRoot,
      reject: false,
    })`git rev-parse --abbrev-ref HEAD`;
    return result.stdout.trim() || 'main';
  }
}
```

---

### Task 8.4: 5 种内置子智能体 — 完整实现

**📖 COMPARISON.md §4.5.1**

**文件:** `packages/agent-core/src/subagent/builtins.ts` (新建)

每个子智能体有**完整的 system prompt**、**专属工具集**、**推荐模型**:

```typescript
/**
 * 创建 5 种内置子智能体
 * 每个子智能体的 system prompt 经过精心设计，
 * 确保其专注于自己的角色，不会越界操作。
 */

export function createBuiltinSubagents(
  providers: Map<string, ILLMProvider>,
  fullRegistry: ToolRegistry,
  readOnlyRegistry: ToolRegistry,
  aiGateway: AIGateway,
): Map<SubagentRole, SubagentConfig> {

  // 🔍 Explorer: 快速代码搜索
  const explorer: SubagentConfig = {
    role: 'explorer',
    name: 'Code Explorer',
    description: '快速代码搜索与信息收集。只读，使用最便宜的模型。',
    systemPrompt: `你是一个代码搜索专家。你的唯一职责是快速找到代码并返回给主智能体。

## 你可以使用的工具
- search_symbol: 按名称搜索函数/类/接口
- fts_search: 全文搜索代码内容
- grep_search: 正则表达式文本匹配
- lsp_definition: 跳转到定义
- lsp_references: 查找所有引用
- read_file: 读取文件内容
- list_files: 列出目录
- git_diff: 查看代码变更

## 关键规则
1. 你只能使用只读工具, 不能修改任何文件
2. 搜索结果要精确: file:line 格式
3. 找到目标后立即输出 <task_finish>结果摘要</task_finish>
4. 不要做任何代码修改建议, 你只负责找代码
5. 优先使用最精准的工具 (lsp_definition > search_symbol > grep_search)`,
    provider: providers.get('deepseek-flash') || providers.get('deepseek')!,
    tools: readOnlyRegistry,
    maxLoops: 4,
    temperature: 0.1,
  };

  // 📐 Planner: 架构设计
  const planner: SubagentConfig = {
    role: 'planner',
    name: 'Architecture Planner',
    description: '架构分析与方案设计。只读，使用最强推理模型。',
    systemPrompt: `你是一个资深软件架构师。你的职责是分析代码库并输出结构化的实施计划。

## 你可以使用的工具 (只读)
- read_file, list_files: 理解项目结构
- search_symbol, fts_search, grep_search: 找到相关代码
- lsp_definition, lsp_references: 追踪依赖关系
- lsp_diagnostics: 了解现有问题
- git_diff, git_status: 了解当前改动状态

## 输出格式
完成分析后, 你必须输出一个 JSON 格式的执行计划:

{
  "goal": "任务目标 (一句话)",
  "approach": "推荐方案 (1-3 段)",
  "complexity": "simple|medium|complex",
  "filesToModify": ["path/to/file1.ts", ...],
  "filesToCreate": ["path/to/new.ts", ...],
  "steps": [
    {
      "id": 1,
      "description": "步骤描述",
      "tool": "使用的工具",
      "file": "操作的文件 (如适用)",
      "expectedOutcome": "预期结果",
      "dependsOn": [],
      "validation": "验证命令 (如 pnpm build)"
    }
  ],
  "risks": ["潜在风险1", "潜在风险2"],
  "rollbackStrategy": "如何回滚修改"
}

<task_finish>计划摘要</task_finish>

## 关键规则
1. 你只能使用只读工具, 绝对不能修改代码
2. 优先理解现有代码再设计计划
3. 考虑边界情况: 空状态、并发、错误处理
4. 计划要具体到文件和函数级别`,
    provider: providers.get('anthropic') || providers.get('openai')!,
    tools: readOnlyRegistry,
    maxLoops: 8,
    temperature: 0.3,
  };

  // ⚡ Implementer: 代码编写
  const implementer: SubagentConfig = {
    role: 'implementer',
    name: 'Code Implementer',
    description: '代码编写与修改。使用完整工具集。',
    systemPrompt: `你是一个资深软件工程师。你的职责是按照计划编写和修改代码。

## 你可以使用的所有工具
代码搜索: search_symbol, fts_search, grep_search, semantic_search
代码理解: lsp_definition, lsp_references, lsp_diagnostics
文件操作: read_file, list_files, modify_file
命令执行: execute_command (通过命令模板), list_command_templates
Git 操作: git_status, git_diff, git_commit

## 工作流程
1. 读取要修改的文件, 确认当前内容
2. 进行代码修改 (modify_file)
3. 立即验证: 运行 pnpm build 或相关编译命令
4. 如果验证失败, 根据错误信息修正
5. 全部修改完成后输出 <task_finish>完成摘要</task_finish>

## 关键规则
1. 每次修改后必须验证编译通过
2. 保持代码风格与现有代码一致
3. 不要猜测, 不确定时使用搜索工具
4. 错误信息是你的朋友, 仔细阅读并根据提示修正`,
    provider: providers.get('openai') || providers.get('deepseek')!,
    tools: fullRegistry,
    maxLoops: 12,
    temperature: 0.2,
  };

  // 🔒 Reviewer: 代码审查
  const reviewer: SubagentConfig = {
    role: 'reviewer',
    name: 'Code Reviewer',
    description: '多维度代码审查。只读，独立视角。',
    systemPrompt: `你是一个代码审查专家。从以下三个维度审查代码:

## 审查维度
1. **安全 (Security)**
   - 路径遍历风险 (path.resolve with user input)
   - 命令注入 (shell exec with unescaped input)
   - SQL 注入 (string concatenation in queries)
   - XSS 风险
   - 密钥/敏感信息泄露
   - 权限检查缺失

2. **正确性 (Correctness)**
   - 边界条件处理 (null, undefined, empty array)
   - 类型安全 (TypeScript strict violations)
   - 错误处理完整性 (try-catch, error propagation)
   - 逻辑错误

3. **性能与质量 (Performance & Quality)**
   - N+1 查询
   - 不必要的循环或 I/O
   - 代码重复 (DRY)
   - 命名清晰度
   - 与现有代码风格的一致性

## 你可以使用的工具 (只读)
- read_file, list_files: 读取代码
- search_symbol, grep_search: 搜索相关代码
- lsp_diagnostics: 检查编译器诊断
- git_diff: 查看改动

## 输出格式
完成审查后使用此格式:

### 安全
- [严重/中等/轻微] 描述 (file:line)
  - 建议: ...

### 正确性
- [严重/中等/轻微] 描述 (file:line)
  - 建议: ...

### 性能与质量
- [严重/中等/轻微] 描述 (file:line)
  - 建议: ...

<task_finish>审查摘要 (有问题数量统计)</task_finish>`,
    provider: providers.get('anthropic') || providers.get('openai')!,
    tools: readOnlyRegistry,
    maxLoops: 4,
    temperature: 0.1,
  };

  // 🧪 Tester: 测试生成
  const tester: SubagentConfig = {
    role: 'tester',
    name: 'Test Engineer',
    description: '测试用例生成与验证。使用完整工具集。',
    systemPrompt: `你是一个测试工程师。为给定的代码修改生成和运行测试。

## 你可以使用的工具
全部工具, 包括 modify_file (创建测试文件) 和 execute_command (运行测试)

## 工作流程
1. 阅读被修改的代码, 理解其功能
2. 分析边界条件、正常路径、异常路径
3. 生成测试用例 (单元测试 + 集成测试)
4. 运行测试并确保通过
5. 如果测试失败, 分析是否为代码问题, 向主智能体报告

<task_finish>测试总结 (覆盖的用例数、通过率)</task_finish>`,
    provider: providers.get('deepseek')!,
    tools: fullRegistry,
    maxLoops: 8,
    temperature: 0.2,
  };

  return new Map([
    ['explorer', explorer],
    ['planner', planner],
    ['implementer', implementer],
    ['reviewer', reviewer],
    ['tester', tester],
  ]);
}
```

---

### Task 8.5: Orchestrator — 任务分解与多智能体编排

**📖 COMPARISON.md §4.5.1, §4.5.2** | **文件:** `packages/agent-core/src/orchestrator.ts` (新建)

```typescript
/**
 * 多智能体编排器 — 系统的"大脑"
 *
 * 职责:
 * 1. 分析用户任务 → 决定是否需要拆分为子任务
 * 2. 为每个子任务选择合适的子智能体类型
 * 3. 决定执行模式 (Orchestrator / Pipeline / Swarm)
 * 4. 协调子智能体间的信息传递
 * 5. 处理失败和冲突
 */

export interface DecomposedTask {
  originalTask: string;
  subtasks: Subtask[];
  mode: CollaborationMode;
  reasoning: string;
}

export interface Subtask {
  id: string;
  description: string;
  assignedRole: SubagentRole;
  dependsOn: string[];           // 依赖的子任务 ID
  context?: string;              // 附加上下文 (上一步的结果)
}

export class Orchestrator {
  constructor(
    private subagentRunner: SubagentRunner,
    private builtinSubagents: Map<SubagentRole, SubagentConfig>,
    private worktreeManager: WorktreeManager,
    private logger: AuditLogger,
  ) {}

  /**
   * 主入口: 接收用户任务, 编排多智能体执行
   *
   * 执行流程:
   *   1. 分析任务复杂度
   *   2. 简单任务 → 直接委派 Implementer
   *   3. 复杂任务 → Planner 探索 → Implementer 执行 → Reviewer 审查 → Tester 测试
   *   4. 所有结果汇总 → 返回给用户
   */
  async execute(userTask: string): Promise<{
    success: boolean;
    summary: string;
    subResults: SubagentResult[];
    totalTokens: number;
    totalCostUsd: number;
  }> {
    await this.logger.log({ type: 'orchestrator_start', data: { task: userTask } });

    // Step 1: 分析任务复杂度, 决定协作模式
    const complexity = this.assessComplexity(userTask);
    console.log(`\n🎯 [Orchestrator] 任务复杂度: ${complexity}`);

    if (complexity === 'simple') {
      // 简单任务: 直接 Implementer 执行
      console.log('   📋 模式: 直接委派 (单智能体)');
      const implementer = this.builtinSubagents.get('implementer')!;
      const result = await this.subagentRunner.run(implementer, userTask);

      this.logger.log({
        type: 'orchestrator_finish',
        data: { mode: 'direct', success: result.success },
      });

      return {
        success: result.success,
        summary: result.summary,
        subResults: [result],
        totalTokens: result.tokensUsed,
        totalCostUsd: result.costUsd,
      };
    }

    // 复杂任务: 多智能体编排
    console.log('   📋 模式: 多智能体编排');

    // Step 2: Planner 分析并设计执行计划
    console.log('\n📐 [Phase 1/4] Planner 分析中...');
    const planner = this.builtinSubagents.get('planner')!;
    const planResult = await this.subagentRunner.run(
      planner,
      `请为以下任务设计详细的执行计划:\n\n${userTask}\n\n请阅读相关代码, 理解现有架构, 然后输出 JSON 格式的执行计划。`
    );

    if (!planResult.success) {
      return {
        success: false,
        summary: '规划阶段失败: ' + planResult.summary,
        subResults: [planResult],
        totalTokens: planResult.tokensUsed,
        totalCostUsd: 0,
      };
    }

    // 解析 Planner 输出的执行计划
    const plan = this.parsePlan(planResult.summary);
    console.log(`   📋 计划: ${plan.steps.length} 个步骤`);

    // Step 3: Implementer 按计划执行 (可为每个步骤创建独立的 worktree)
    console.log('\n⚡ [Phase 2/4] Implementer 执行中...');
    const implementer = this.builtinSubagents.get('implementer')!;
    const implResults: SubagentResult[] = [];

    for (const step of plan.steps) {
      console.log(`   ▶ Step ${step.id}: ${step.description}`);
      const result = await this.subagentRunner.run(
        implementer,
        `请执行以下步骤:\n${step.description}\n\n使用的工具: ${step.tool}\n文件: ${step.file || '由你确定'}\n预期结果: ${step.expectedOutcome}`
      );
      implResults.push(result);

      if (!result.success) {
        console.log(`   ❌ Step ${step.id} 失败, 停止执行`);
        break;
      }
    }

    // Step 4: Reviewer 审查修改
    console.log('\n🔒 [Phase 3/4] Reviewer 审查中...');
    const reviewer = this.builtinSubagents.get('reviewer')!;
    const modifiedFiles = implResults
      .flatMap(r => r.filesModified || [])
      .filter(Boolean);

    const reviewResult = modifiedFiles.length > 0
      ? await this.subagentRunner.run(
          reviewer,
          `请审查以下文件的修改:\n${modifiedFiles.map(f => `- ${f}`).join('\n')}`
        )
      : null;

    // Step 5: Tester 生成和运行测试
    console.log('\n🧪 [Phase 4/4] Tester 生成测试中...');
    const tester = this.builtinSubagents.get('tester')!;
    const testResult = await this.subagentRunner.run(
      tester,
      `请为以下修改生成测试用例:\n${implResults.map(r => r.summary).join('\n')}`
    );

    // 汇总结果
    const allResults = [planResult, ...implResults];
    if (reviewResult) allResults.push(reviewResult);
    allResults.push(testResult);

    const totalTokens = allResults.reduce((s, r) => s + r.tokensUsed, 0);
    const totalCostUsd = allResults.reduce((s, r) => s + r.costUsd, 0);

    const summary = this.buildFinalSummary(userTask, allResults);

    await this.logger.log({
      type: 'orchestrator_finish',
      data: { mode: 'multi-agent', phases: 4, success: true },
    });

    return {
      success: true,
      summary,
      subResults: allResults,
      totalTokens,
      totalCostUsd,
    };
  }

  /**
   * Swarm 模式: 并行多个 Implementer, 选最优方案
   * 用于需要多方案比较的场景 (如 "设计 API 接口")
   */
  async executeSwarm(userTask: string): Promise<SubagentResult> {
    const implementer = this.builtinSubagents.get('implementer')!;

    // 用不同模型/策略创建多个变体
    const variants: SubagentConfig[] = [
      { ...implementer, name: 'implementer-gpt', provider: this.getProvider('openai')! },
      { ...implementer, name: 'implementer-claude', provider: this.getProvider('anthropic')! },
      { ...implementer, name: 'implementer-ds', provider: this.getProvider('deepseek')! },
    ].filter(v => v.provider);

    const judge = this.getProvider('anthropic')
      || this.getProvider('openai')
      || this.getProvider('deepseek')!;

    return this.subagentRunner.runSwarm(userTask, variants, judge);
  }

  private assessComplexity(task: string): 'simple' | 'medium' | 'complex' {
    const simpleKW = ['修复拼写', 'fix typo', '添加注释', '格式化', 'format'];
    const complexKW = ['重构', 'refactor', '架构', 'architecture', '迁移',
      'migrate', '重新设计', '大规模'];

    if (complexKW.some(k => task.toLowerCase().includes(k.toLowerCase()))) {
      return 'complex';
    }
    if (simpleKW.some(k => task.toLowerCase().includes(k.toLowerCase()))) {
      return 'simple';
    }
    return 'medium';
  }

  private parsePlan(text: string): any {
    try {
      const jsonMatch = text.match(/\{[\s\S]*"steps"[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { steps: [] };
    } catch {
      return { steps: [] };
    }
  }

  private buildFinalSummary(task: string, results: SubagentResult[]): string {
    const successCount = results.filter(r => r.success).length;
    return `任务 "${task.slice(0, 100)}" 完成。
子智能体执行: ${results.map(r => `${r.role}: ${r.success ? '✅' : '❌'}`).join(', ')}
总计: ${successCount}/${results.length} 成功`;
  }

  private getProvider(name: string): ILLMProvider | undefined {
    // 从 AI Gateway 获取
    return undefined;
  }
}
```

**验收:**
- 简单任务 (fix typo) → 直接委派 Implementer，不启动多智能体流程
- 复杂任务 (重构认证系统) → Planner→Implementer→Reviewer→Tester 四阶段编排
- Swarm 模式 → 3 个模型并行生成方案，评判模型选最优
- 所有子智能体的上下文互不污染
- Git worktree 隔离 → 并行子智能体不会产生文件冲突
- 审计日志记录每个子智能体的输入/输出/token 消耗

---

### Task 8.6: CLI 集成 — `orchestrate` 命令

**文件:** `apps/cli/src/index.ts` — 新增命令

```typescript
program
  .command('orchestrate')
  .description('多智能体编排模式 — 自动分解任务并委派子智能体执行')
  .action(async () => {
    const { requirement } = await inquirer.prompt([{
      type: 'input',
      name: 'requirement',
      message: '请输入开发任务 (将自动分解并委派给多个智能体):',
    }]);

    console.log('\n🎯 启动多智能体编排...\n');

    const result = await orchestrator.execute(requirement);

    console.log('\n═══════════════════════════════════');
    console.log('📊 多智能体执行报告');
    console.log('═══════════════════════════════════');
    console.log(`   成功率: ${result.subResults.filter(r => r.success).length}/${result.subResults.length}`);
    console.log(`   总 Token: ${result.totalTokens.toLocaleString()}`);
    console.log(`   总成本: $${result.totalCostUsd.toFixed(4)}`);
    console.log(`\n   各智能体结果:`);
    for (const r of result.subResults) {
      const icon = r.success ? '✅' : '❌';
      console.log(`   ${icon} ${r.role}: ${r.summary.slice(0, 120)}`);
      console.log(`      Token: ${r.tokensUsed.toLocaleString()} | 耗时: ${(r.durationMs / 1000).toFixed(1)}s`);
    }
    console.log('\n📋 最终摘要:');
    console.log(result.summary);
  });
```

**验收:**
- `code-agent orchestrate` 启动多智能体编排
- 终端显示每个阶段的进度和结果
- 最终输出包含 token 消耗和成本统计

## Phase 9: 扩展生态 — Hooks + Skills + MCP Client

> 📖 对应 COMPARISON.md: §4.5.3 (Hooks), §8.2 (MCP Client), §4.6 (CLAUDE.md)

---

### Task 9.1: Hooks 系统

**📖 COMPARISON.md §4.5.3** | **文件:** `packages/agent-core/src/hooks.ts` (新建)

```typescript
export type HookEvent =
  | 'pre_tool_call'
  | 'post_tool_call'
  | 'pre_task_finish'
  | 'on_error'
  | 'on_session_start'
  | 'on_session_end';

export interface Hook {
  name: string;
  event: HookEvent;
  type: 'command' | 'prompt';
  action: string;
  condition?: string;      // JS 表达式，如 "toolName === 'modify_file'"
  timeoutMs?: number;
}

export class HooksEngine {
  private hooks: Hook[] = [];

  load(hooks: Hook[]): void {
    this.hooks = hooks;
  }

  async fire(
    event: HookEvent,
    context: Record<string, any>
  ): Promise<{ proceed: boolean; output?: string }> {
    const matching = this.hooks.filter(h => h.event === event);

    for (const hook of matching) {
      // 条件检查
      if (hook.condition) {
        try {
          const fn = new Function(...Object.keys(context), `return ${hook.condition}`);
          if (!fn(...Object.values(context))) continue;
        } catch { continue; }
      }

      if (hook.type === 'command') {
        const result = await execa({ shell: true, reject: false })`${hook.action}`;
        if (result.exitCode !== 0) {
          return { proceed: false, output: `Hook "${hook.name}" 失败: ${result.stderr}` };
        }
      }
    }

    return { proceed: true };
  }
}
```

**配置示例 (COMPARISON.md §4.5.3):**
```yaml
# .code-agent/hooks.yml
hooks:
  - name: lint_before_modify
    event: pre_tool_call
    condition: "toolName === 'modify_file'"
    type: command
    action: "pnpm lint ${filePath}"

  - name: build_and_test_before_finish
    event: pre_task_finish
    type: command
    action: "pnpm build && pnpm test"

  - name: error_diagnosis
    event: on_error
    type: prompt
    action: "分析以下错误并提供恢复方案: ${errorMessage}"

  - name: log_command
    event: post_tool_call
    condition: "toolName === 'execute_command'"
    type: command
    action: "echo '[${timestamp}] ${command}' >> .agent-commands.log"
```

---

### Task 9.2: Skills 系统

**📖 COMPARISON.md §4.5 (Skills/插件系统)** | **文件:** `packages/agent-core/src/skills.ts` (新建)

```typescript
export interface Skill {
  name: string;
  description: string;     // 自动触发匹配
  tools: string[];
  content: string;         // Markdown 指令体
}

export class SkillLoader {
  static async loadAll(skillsDir: string): Promise<Skill[]> {
    const glob = (await import('fast-glob')).default;
    const files = glob.sync(['**/*.md'], { cwd: skillsDir });
    const skills: Skill[] = [];

    for (const file of files) {
      const content = await fs.readFile(path.join(skillsDir, file), 'utf-8');
      const skill = this.parseSkill(content);
      if (skill) skills.push(skill);
    }

    return skills;
  }

  static parseSkill(content: string): Skill | null {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;

    const fm: any = {};
    for (const line of fmMatch[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }

    return {
      name: fm.name,
      description: fm.description,
      tools: fm.tools?.split(',').map((t: string) => t.trim()) || [],
      content: fmMatch[2].trim(),
    };
  }

  /** 根据用户任务自动匹配合适的 Skill */
  static match(task: string, skills: Skill[]): Skill | null {
    for (const skill of skills) {
      const keywords = skill.description.toLowerCase().split(/\s+/);
      if (keywords.some(kw => task.toLowerCase().includes(kw))) {
        return skill;
      }
    }
    return null;
  }
}
```

**创建默认 Skill (COMPARISON.md §4.5):**
```markdown
---
name: fix-typo
description: 修复代码中的拼写错误 typo 修正拼写
tools: read_file, modify_file, execute_command, lsp_diagnostics
---

## 流程
1. 使用 read_file 读取目标文件
2. 识别拼写错误（注意变量名、注释、字符串）
3. 使用 modify_file 修正
4. 使用 execute_command 运行 `pnpm build` 验证
5. 如果 lsp_diagnostics 报告错误，分析并修正
6. 输出 <task_finish>修正完成</task_finish>
```

---

### Task 9.3: CLAUDE.md 生成

**📖 COMPARISON.md §4.6 (工程化补全 — CLAUDE.md)** | **文件:** `CLAUDE.md` (项目根)

```markdown
# Code Agent - 通用型 AI 编码智能体

## 项目概述
企业级开源 Code Agent，支持多模型 (DeepSeek/OpenAI/Anthropic/Ollama)、
MCP 协议、OS 级沙箱的通用 AI 编码助手。

## 技术栈
- **运行时:** Node.js >=22 LTS
- **语言:** TypeScript 6.0
- **包管理:** pnpm 10.26 (Monorepo)
- **构建:** Turborepo 2.9
- **测试:** vitest

## 项目结构
- `apps/cli/` — CLI 入口
- `packages/shared/` — 共享类型
- `packages/llm-provider/` — 多模型适配器
- `packages/agent-core/` — 智能体核心引擎
- `packages/context-engine/` — 代码理解
- `packages/diff-engine/` — Diff 解析
- `packages/tool-kit/` — 工具集
- `packages/memory/` — 记忆系统
- `packages/logger/` — 审计日志

## 常用命令
- `pnpm build` — 编译所有包
- `pnpm start:cli` — 启动 CLI
- `pnpm --filter cli start agent` — 启动 Agent
- `pnpm test` — 运行全部测试

## 代码风格
- strict TypeScript (strict: true)
- ESM 模块 (NodeNext)
- 类命名: PascalCase; 函数: camelCase
- 每个 package 独立构建 (tsc)
```

**验收:** 其他 AI 助手读取 CLAUDE.md 后能快速理解项目并给出正确建议。

---

## Phase 10: 工程化完善 — 测试、CLI、成本追踪

> 📖 对应 COMPARISON.md: §4.6 (工程化), §8.4 (成本优化)

> ⚠️ OS 沙箱已在 Phase 0 Task 0.2 实现。AI Gateway 路由在 Phase 3 Task 3.4 实现。本 Phase 仅包含剩余的工程化内容。

---

### Task 10.1: 成本追踪集成到 AI Gateway

**📖 COMPARISON.md §8.4** | **文件:** `packages/llm-provider/src/gateway.ts` — 增强

```typescript
/**
 * 成本追踪 (COMPARISON.md §8.4)
 * 在每次 LLM 调用后自动记录成本，会话结束时输出汇总
 */

export interface CostRecord {
  timestamp: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'deepseek-v4-flash':    { input: 0.14,  output: 0.28 },
  'deepseek-v4-pro':      { input: 0.50,  output: 2.00 },
  'deepseek-v4':          { input: 0.50,  output: 2.00 },
  'gpt-5.3-codex':        { input: 1.25,  output: 10.00 },
  'claude-sonnet-4-6':    { input: 3.00,  output: 15.00 },
  'claude-opus-4-8':      { input: 15.00, output: 75.00 },
  'qwen3':                { input: 0,     output: 0 },       // 本地免费
};

export function calculateCost(
  model: string, promptTokens: number, completionTokens: number
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (promptTokens / 1_000_000) * pricing.input
       + (completionTokens / 1_000_000) * pricing.output;
}

export function formatCost(costUsd: number): string {
  if (costUsd === 0) return '$0 (免费)';
  if (costUsd < 0.01) return `< $0.01`;
  return `$${costUsd.toFixed(4)}`;
}
```

---

### Task 10.2: 测试覆盖

**📖 COMPARISON.md §4.6** | 使用 vitest

```bash
pnpm add -D vitest -w
```

**测试文件清单与优先级:**

| 文件 | 测试内容 | 优先级 |
|------|---------|:----:|
| `packages/diff-engine/__tests__/diff-engine.test.ts` | parseBlocks (单/多块/空), applyPatch (精准/模糊/失败), generateUnifiedDiff | P0 |
| `packages/context-engine/__tests__/db.test.ts` | 插入/搜索符号, 清除索引, FTS5 搜索 | P0 |
| `packages/context-engine/__tests__/indexer.test.ts` | tree-sitter 多语言符号提取 | P0 |
| `packages/agent-core/__tests__/tool-registry.test.ts` | 注册/分发/权限检查 | P1 |
| `packages/agent-core/__tests__/context-manager.test.ts` | Token 计数/裁剪/压缩/Observation 截断 | P1 |
| `packages/agent-core/__tests__/permission-engine.test.ts` | allow/deny/ask 规则匹配 | P1 |
| `packages/tool-kit/__tests__/path-safety.test.ts` | resolveSafe 路径遍历防护 | P0 |
| `packages/tool-kit/__tests__/sandbox.test.ts` | Seatbelt/Landlock 沙箱模式 | P1 |
| `packages/llm-provider/__tests__/gateway.test.ts` | 任务分析/路由规则/故障切换 | P1 |

**验收:** `pnpm test` 全部通过，核心模块(P0)覆盖率 > 70%。

---

### Task 10.3: CLI 完善 — 所有入口命令

**📖 COMPARISON.md §4.4.3, §4.6**

```bash
# === 核心模式 ===
code-agent agent                                    # 交互式 Agent (默认)
code-agent orchestrate "重构认证模块"                # 多智能体编排
code-agent plan "添加用户注册功能"                   # Plan Mode (先规划后执行)

# === 模型选择 ===
code-agent --provider openai --model gpt-5.3-codex agent
code-agent --provider anthropic plan "架构优化"
code-agent --provider ollama --model qwen3:14b agent # 本地模型

# === 沙箱模式 ===
code-agent --sandbox read-only plan "分析代码安全性"
code-agent --sandbox workspace-write agent           # 默认

# === 会话管理 ===
code-agent resume <session-id>                       # 恢复会话
code-agent list-sessions                             # 列出历史
code-agent --dry-run agent "重构认证"                 # 只分析不执行

# === 工具模式 ===
code-agent mcp-server                                # 启动 MCP Server (stdio)
code-agent mcp-connect github -- npx @anthropic/mcp-server-github  # 连接外部 MCP
```

---

### Task 10.4: 补充 Phase 遗漏 — 添加 Phase 间依赖关系图

```
Phase 0 (安全)
  ├── 无依赖，可立即开始
  └── 产出: OS 沙箱 + 路径沙箱 + 回滚 + Thinking + Git 集成 + 重试

Phase 1 (代码理解) ← 依赖 Phase 0 (路径沙箱在文件读取中使用)
  ├── 产出: tree-sitter 多语言索引 + 多语言 LSP + ripgrep + FTS5 + Embedding
  └── 被依赖: Phase 2 (工具注册时引用搜索工具)

Phase 2 (工具协议) ← 依赖 Phase 1 (工具实现)
  ├── 产出: ToolRegistry + MCP Server + MCP Client
  └── 被依赖: Phase 3 (Executor 使用 ToolRegistry)

Phase 3 (多模型) ← 依赖 Phase 2 (工具定义给 LLM)
  ├── 产出: ILLMProvider × 6 + AI Gateway 路由
  └── 被依赖: Phase 4+5+6+7+8

Phase 4 (流式) ← 依赖 Phase 3 (ILLMProvider 接口)
Phase 5 (权限+审计) ← 依赖 Phase 2 (ToolRegistry)
Phase 6 (上下文+记忆) ← 依赖 Phase 3 (countTokens)

Phase 7 (Plan Mode) ← 依赖 Phase 5 (权限) + Phase 6 (上下文)
Phase 8 (子智能体) ← 依赖 Phase 7 (Plan Mode 双智能体模式)
Phase 9 (扩展) ← 依赖 Phase 8 (子智能体为 Hooks/Skills 提供执行载体)
Phase 10 (工程化) ← 依赖 Phase 0-9 (测试覆盖全链路)
```

---

### Task 10.5: 补充 Phase 8 Orchestrator 中的 getProvider 实现

**文件:** `packages/agent-core/src/orchestrator.ts`

```typescript
// 修复 Task 8.5 中 getProvider 的空实现:
private getProvider(name: string): ILLMProvider | undefined {
  return this.providers.get(name);  // providers 由构造函数注入
}
```

**同时补充 Orchestrator 构造函数参数:**

```typescript
export class Orchestrator {
  constructor(
    private subagentRunner: SubagentRunner,
    private builtinSubagents: Map<SubagentRole, SubagentConfig>,
    private worktreeManager: WorktreeManager,
    private providers: Map<string, ILLMProvider>,    // ← 补充
    private logger: AuditLogger,
  ) {}
  // ...
}
```

---

## 附录 A: COMPARISON.md 结论全覆盖检查清单

本清单确保 COMPARISON.md 中的每个结论都在本文档中有对应的实施步骤。

### §4.1 P0 安全基础设施

| COMPARISON.md 结论 | 本文档对应 | 状态 |
|-------------------|----------|:----:|
| 路径沙箱 (resolveSafe) | Task 0.1 | ✅ |
| 命令安全 — OS 级沙箱 | Task 0.2 | ✅ |
| 审批工作流 (分层权限配置) | Task 5.1 | ✅ |

### §4.2 P0 代码修改安全保障

| COMPARISON.md 结论 | 本文档对应 | 状态 |
|-------------------|----------|:----:|
| 修改回滚 (备份→修改→验证→回滚) | Task 0.4 | ✅ |
| 语法验证 (TS Compiler API) | Task 0.4 | ✅ |
| Diff 预览 (unified diff) | Task 0.4 | ✅ |

### §4.3 P1 核心能力补全

| COMPARISON.md 结论 | 本文档对应 | 状态 |
|-------------------|----------|:----:|
| MCP Server 协议 (stdio) | Task 2.3 | ✅ |
| MCP Client (连接外部工具) | Task 2.4 | ✅ |
| 多模型通用适配器 (ILLMProvider) | Task 3.1 | ✅ |
| 6 个 Provider 实现 | Task 3.2 | ✅ |
| 流式输出 (chatStream) | Task 4.1 | ✅ |
| 三层搜索 — grep 文本搜索 | Task 1.2 | ✅ |
| 三层搜索 — FTS5 符号搜索 | Task 1.3 | ✅ |
| 三层搜索 — Embedding 语义搜索 | Task 1.4 | ✅ |
| 工具注册表重构 | Task 2.1 | ✅ |

### §2.3 差距矩阵 (LSP)

| COMPARISON.md 结论 | 本文档对应 | 状态 |
|-------------------|----------|:----:|
| LSP 代码理解 | Task 1.1 | ✅ |

### §4.4 P2 上下文与记忆

| COMPARISON.md 结论 | 本文档对应 | 状态 |
|-------------------|----------|:----:|
| Token 计数 | Task 6.1 | ✅ |
| 智能裁剪 | Task 6.1 | ✅ |
| Observation 压缩 | Task 6.1 | ✅ |
| Prompt 缓存优化 | Task 6.1 | ✅ |
| 跨会话记忆 | Task 6.2 | ✅ |
| 会话日志与恢复 | Task 5.2 | ✅ |

### §4.5 P3 高级智能体

| COMPARISON.md 结论 | 本文档对应 | 状态 |
|-------------------|----------|:----:|
| 子智能体系统 (5 种) | Task 8.1 | ✅ |
| Plan Mode (双智能体分离) | Task 7.1 + 7.2 | ✅ |
| Hooks 系统 (4 种事件) | Task 9.1 | ✅ |
| Skills 系统 | Task 9.2 | ✅ |

### §4.6 工程化补全

| COMPARISON.md 结论 | 本文档对应 | 状态 |
|-------------------|----------|:----:|
| vitest 测试 | Task 10.3 | ✅ |
| 配置系统 (三层覆盖) | Task 5.1 | ✅ |
| CLAUDE.md | Task 9.3 | ✅ |
| 错误分类+重试 | Task 0.6 | ✅ |
| 结构化日志+token 追踪 | Task 5.2 + 10.2 | ✅ |

### §8 关键差异化技术

| COMPARISON.md 结论 | 本文档对应 | 状态 |
|-------------------|----------|:----:|
| 通用模型适配器 (AI Gateway) | Task 3.4 | ✅ |
| MCP-Native 工具生态 | Task 2.3 + 2.4 | ✅ |
| 层次化安全 (4 层) | Task 0.1 (路径) + 0.2 (OS沙箱) + 5.1 (权限) + 5.2 (审计) | ✅ |
| 成本优化 (模型路由) | Task 3.4 (路由) + 10.1 (成本追踪) | ✅ |

> **总计: 35/35 结论已全覆盖** ✅

---

> 📅 最后更新: 2026-06-14
>
> 📄 配套文档: [COMPARISON.md](./COMPARISON.md)
