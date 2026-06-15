import { spawn, type ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import type {
  Location,
  Diagnostic,
  Position,
} from 'vscode-languageserver-protocol';
import type { LifecycleAware } from '@code-agent/types';

interface LspServerConfig {
  id: string;
  languageIds: string[];
  extensions: string[];
  command: string;
  args: string[];
  installHint: string;
}

/** 内置 10+ 语言 LSP Server 配置 */
const BUILTIN_SERVERS: LspServerConfig[] = [
  {
    id: 'typescript',
    languageIds: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    command: 'npx',
    args: ['typescript-language-server', '--stdio'],
    installHint: 'npm install -g typescript-language-server typescript',
  },
  {
    id: 'python',
    languageIds: ['python'],
    extensions: ['.py', '.pyw'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    installHint: 'pip install pyright',
  },
  {
    id: 'rust',
    languageIds: ['rust'],
    extensions: ['.rs'],
    command: 'rust-analyzer',
    args: [],
    installHint: 'rustup component add rust-analyzer',
  },
  {
    id: 'go',
    languageIds: ['go'],
    extensions: ['.go'],
    command: 'gopls',
    args: [],
    installHint: 'go install golang.org/x/tools/gopls@latest',
  },
  {
    id: 'clangd',
    languageIds: ['c', 'cpp'],
    extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    command: 'clangd',
    args: [],
    installHint: 'Install clangd from https://clangd.llvm.org/installation.html',
  },
  {
    id: 'java',
    languageIds: ['java'],
    extensions: ['.java'],
    command: 'java',
    args: ['-jar', 'jdtls/plugins/org.eclipse.equinox.launcher_*.jar'],
    installHint: 'Install Eclipse JDT LS from https://download.eclipse.org/jdtls/',
  },
  {
    id: 'ruby',
    languageIds: ['ruby'],
    extensions: ['.rb'],
    command: 'solargraph',
    args: ['stdio'],
    installHint: 'gem install solargraph',
  },
  {
    id: 'php',
    languageIds: ['php'],
    extensions: ['.php'],
    command: 'php',
    args: ['vendor/bin/intelephense', '--stdio'],
    installHint: 'composer require intelephense/intelphense',
  },
  {
    id: 'json',
    languageIds: ['json', 'jsonc'],
    extensions: ['.json', '.jsonc'],
    command: 'vscode-json-languageserver',
    args: ['--stdio'],
    installHint: 'npm install -g vscode-json-languageserver',
  },
];

const TTL_IDLE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_RECONNECT = 3;
const INITIALIZE_PARAMS = {
  processId: process.pid,
  capabilities: {
    textDocument: {
      definition: { linkSupport: true },
      references: {},
      publishDiagnostics: {},
    },
    workspace: {
      workspaceFolders: true,
    },
  },
};

interface LspConnection {
  config: LspServerConfig;
  process: ChildProcess | null;
  initialized: boolean;
  lastUsed: number;
  reconnectAttempts: number;
  available: boolean;
  requestId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** Accumulated buffer for stdout */
  stdoutBuffer: string;
  /** Content-Length header value being parsed */
  contentLength: number;
  /** Whether we're reading headers */
  readingHeaders: boolean;
  headerBuffer: string;
  /** Diagnostics cache: uri → Diagnostic[] */
  diagnostics: Map<string, Diagnostic[]>;
  timeoutId?: ReturnType<typeof setTimeout>;
}

/**
 * LSP 管理器 — 按语言路由、连接池复用、工作区单例、TTL 空闲回收。
 * 实现 LifecycleAware 以参与 Agent Runtime 生命周期管理。
 */
export class LSPManager implements LifecycleAware {
  readonly name = 'LSPManager';
  readonly dependencies = [];

  private connections = new Map<string, LspConnection>();
  private serverConfigs: LspServerConfig[];
  private workspaceRoot: string;
  private destroyed = false;

  constructor(workspaceRoot: string, extraServers: LspServerConfig[] = []) {
    this.workspaceRoot = workspaceRoot;
    this.serverConfigs = [...BUILTIN_SERVERS, ...extraServers];

    // 退出时清理所有 LSP 进程
    for (const signal of ['SIGINT', 'SIGTERM', 'exit'] as const) {
      process.on(signal, () => { void this.shutdownAll(); });
    }
  }

  // === LifecycleAware ===

  async init(): Promise<void> {
    // 按需启动，不在 init 中预连接
  }

  async shutdown(): Promise<void> {
    await this.shutdownAll();
  }

  async healthCheck(): Promise<boolean> {
    return !this.destroyed;
  }

  async restart(): Promise<void> {
    await this.shutdownAll();
    this.destroyed = false;
  }

  // === 核心 API ===

  /** 按文件扩展名查找对应语言配置 */
  getConfigForFile(filePath: string): LspServerConfig | undefined {
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    return this.serverConfigs.find(c => c.extensions.includes(ext));
  }

  /** 获取或创建连接（单例路由：同语言共享一个 Server 进程） */
  private async getConnection(config: LspServerConfig): Promise<LspConnection | null> {
    if (this.destroyed) return null;

    const existing = this.connections.get(config.id);
    if (existing && existing.available) {
      existing.lastUsed = Date.now();
      this.resetTTL(existing);
      return existing;
    }

    return this.createConnection(config);
  }

  private async createConnection(config: LspServerConfig): Promise<LspConnection | null> {
    try {
      const proc = spawn(config.command, config.args, {
        cwd: this.workspaceRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false, // 绑定父进程生命周期 (ADR-8)
      });

      const conn: LspConnection = {
        config,
        process: proc,
        initialized: false,
        lastUsed: Date.now(),
        reconnectAttempts: 0,
        available: true,
        requestId: 0,
        pending: new Map(),
        stdoutBuffer: '',
        contentLength: -1,
        readingHeaders: true,
        headerBuffer: '',
        diagnostics: new Map(),
      };

      // 处理 stdout — JSON-RPC 消息帧解析
      proc.stdout?.on('data', (chunk: Buffer) => {
        this.handleData(conn, chunk.toString());
      });

      proc.stderr?.on('data', (_chunk: Buffer) => {
        // LSP Server stderr 通常为日志，忽略
      });

      proc.on('exit', (_code) => {
        conn.available = false;
        if (!this.destroyed && conn.reconnectAttempts < MAX_RECONNECT) {
          conn.reconnectAttempts++;
          void this.createConnection(config); // 自动重连（fire-and-forget）
        }
      });

      proc.on('error', () => {
        conn.available = false;
      });

      this.connections.set(config.id, conn);
      this.resetTTL(conn);

      // 初始化握手
      await this.sendRequest(conn, 'initialize', {
        ...INITIALIZE_PARAMS,
        rootUri: `file://${this.workspaceRoot}`,
        workspaceFolders: [{ uri: `file://${this.workspaceRoot}`, name: 'root' }],
      });

      await this.sendNotification(conn, 'initialized', {});
      conn.initialized = true;

      return conn;
    } catch {
      return null;
    }
  }

  /** Content-Length + CRLF header 消息帧解析 */
  private handleData(conn: LspConnection, data: string): void {
    conn.stdoutBuffer += data;

    while (conn.stdoutBuffer.length > 0) {
      if (conn.readingHeaders) {
        const headerEnd = conn.stdoutBuffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;

        const header = conn.stdoutBuffer.slice(0, headerEnd);
        conn.stdoutBuffer = conn.stdoutBuffer.slice(headerEnd + 4);

        const match = header.match(/Content-Length: (\d+)/i);
        if (!match) {
          // 无效 header，跳过
          conn.readingHeaders = true;
          continue;
        }

        conn.contentLength = parseInt(match[1]!, 10);
        conn.readingHeaders = false;
      }

      if (!conn.readingHeaders && conn.contentLength >= 0) {
        if (conn.stdoutBuffer.length < conn.contentLength) return;

        const body = conn.stdoutBuffer.slice(0, conn.contentLength);
        conn.stdoutBuffer = conn.stdoutBuffer.slice(conn.contentLength);
        conn.contentLength = -1;
        conn.readingHeaders = true;

        try {
          const msg = JSON.parse(body);
          if (msg.id !== undefined && msg.id !== null) {
            const pending = conn.pending.get(msg.id);
            if (pending) {
              conn.pending.delete(msg.id);
              if (msg.error) {
                pending.reject(new Error(`LSP error: ${JSON.stringify(msg.error)}`));
              } else {
                pending.resolve(msg.result);
              }
            }
          } else if (msg.method === 'textDocument/publishDiagnostics') {
            const params = msg.params as { uri: string; diagnostics: Diagnostic[] };
            conn.diagnostics.set(params.uri, params.diagnostics);
          }
        } catch {
          // JSON 解析失败，跳过
        }
      }
    }
  }

  private async sendRequest(conn: LspConnection, method: string, params: unknown): Promise<unknown> {
    const id = ++conn.requestId;
    const content = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      conn.pending.set(id, { resolve, reject });
      conn.process?.stdin?.write(header + content);
    });
  }

  private async sendNotification(conn: LspConnection, method: string, params: unknown): Promise<void> {
    const content = JSON.stringify({ jsonrpc: '2.0', method, params });
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    conn.process?.stdin?.write(header + content);
  }

  // === 工具方法 ===

  /** 跳转定义 */
  async getDefinition(filePath: string, line: number, column: number): Promise<Location[]> {
    const config = this.getConfigForFile(filePath);
    if (!config) return [];

    const conn = await this.getConnection(config);
    if (!conn) return [];

    try {
      const uri = `file://${filePath}`;
      const result = await this.sendRequest(conn, 'textDocument/definition', {
        textDocument: { uri },
        position: { line: line - 1, character: column - 1 },
      });

      if (!result) return [];

      // 结果可能是 Location 或 Location[]
      const locations = result as Location | Location[] | { uri: string; range: { start: Position; end: Position } }[];
      if (Array.isArray(locations)) return locations;
      if ('uri' in locations) return [locations as Location];
      return [];
    } catch {
      return [];
    }
  }

  /** 查找引用 */
  async getReferences(filePath: string, line: number, column: number): Promise<Location[]> {
    const config = this.getConfigForFile(filePath);
    if (!config) return [];

    const conn = await this.getConnection(config);
    if (!conn) return [];

    try {
      const uri = `file://${filePath}`;
      const result = await this.sendRequest(conn, 'textDocument/references', {
        textDocument: { uri },
        position: { line: line - 1, character: column - 1 },
        context: { includeDeclaration: false },
      });

      return (result as Location[]) ?? [];
    } catch {
      return [];
    }
  }

  /** 获取文件诊断 */
  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const config = this.getConfigForFile(filePath);
    if (!config) return [];

    const conn = await this.getConnection(config);
    if (!conn) return [];

    // 通知 LSP 打开文件以触发诊断
    const uri = `file://${filePath}`;
    try {
      const content = readFileSync(filePath, 'utf-8');
      await this.sendNotification(conn, 'textDocument/didOpen', {
        textDocument: { uri, languageId: config.languageIds[0] ?? 'plaintext', version: 1, text: content },
      });
      // 等待诊断结果返回
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch {
      // 忽略
    }

    return conn.diagnostics.get(uri) ?? [];
  }

  // === 连接管理 ===

  private resetTTL(conn: LspConnection): void {
    if (conn.timeoutId) clearTimeout(conn.timeoutId);
    conn.timeoutId = setTimeout(() => {
      this.closeConnection(conn);
    }, TTL_IDLE_MS);
  }

  private closeConnection(conn: LspConnection): void {
    try {
      void this.sendNotification(conn, 'shutdown', {});
      conn.process?.stdin?.end();
      conn.process?.kill();
    } catch {
      conn.process?.kill('SIGKILL');
    }
    conn.available = false;
    this.connections.delete(conn.config.id);
  }

  async shutdownAll(): Promise<void> {
    this.destroyed = true;
    for (const [, conn] of this.connections) {
      try {
        await this.sendNotification(conn, 'shutdown', {});
        conn.process?.kill();
      } catch {
        conn.process?.kill('SIGKILL');
      }
    }
    this.connections.clear();
  }

  /** 添加多根工作区文件夹（Git Worktree 场景） */
  async addWorkspaceFolder(uri: string, name: string): Promise<void> {
    for (const [, conn] of this.connections) {
      if (conn.available && conn.initialized) {
        try {
          await this.sendNotification(conn, 'workspace/didChangeWorkspaceFolders', {
            event: { added: [{ uri, name }], removed: [] },
          });
        } catch { /* 部分 Server 不支持 */ }
      }
    }
  }

  /** 移除多根工作区文件夹 */
  async removeWorkspaceFolder(uri: string): Promise<void> {
    for (const [, conn] of this.connections) {
      if (conn.available && conn.initialized) {
        try {
          await this.sendNotification(conn, 'workspace/didChangeWorkspaceFolders', {
            event: { added: [], removed: [{ uri }] },
          });
        } catch { /* 部分 Server 不支持 */ }
      }
    }
  }
}
