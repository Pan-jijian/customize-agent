import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash } from 'crypto';
import { execa, execaCommand } from 'execa';
import sharp from 'sharp';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { createWorker } from 'tesseract.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.turbo', '.cache']);
const SNAPSHOT_MAX_FILE_SIZE = 25_000_000;

type Snapshot = Map<string, Buffer>;

type PackageInfo = { version?: string };
type BackgroundProcess = { command: string; child: any; output: string[]; startedAt: string };
type McpConfig = Record<string, { command: string; args: string[] }>;
type PluginConfig = { installed: string[] };

export class BuiltinTools {
  private static background = new Map<string, BackgroundProcess>();

  constructor(private cwd: string = process.cwd()) {}

  private resolveSafe(relativePath: string): string {
    const resolved = path.resolve(this.cwd, relativePath || '.');
    const root = path.resolve(this.cwd);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) throw new Error(`Path escapes project root: ${relativePath}`);
    return resolved;
  }

  private snapshotDir(): string {
    return path.join(os.homedir(), '.customize-agent', 'snapshots');
  }

  private snapshotFile(name: string): string {
    return path.join(this.snapshotDir(), `${name}.json`);
  }

  private configDir(): string {
    return path.join(os.homedir(), '.customize-agent');
  }

  private mcpConfigFile(): string {
    return path.join(this.configDir(), 'mcp.json');
  }

  private pluginConfigFile(): string {
    return path.join(this.configDir(), 'plugins.json');
  }

  private async walk(dir: string, files: string[] = []): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(this.cwd, full);
      if (entry.isDirectory()) await this.walk(full, files);
      else if (entry.isFile()) files.push(rel);
    }
    return files;
  }

  async editFile(filePath: string, search: string, replace: string): Promise<string> {
    const full = this.resolveSafe(filePath);
    const original = await fs.readFile(full, 'utf-8');
    if (!original.includes(search)) throw new Error(`Search text not found in ${filePath}`);
    const updated = original.replace(search, replace);
    await fs.writeFile(full, updated, 'utf-8');
    return `Edited ${filePath}: ${original.length} -> ${updated.length} chars`;
  }

  async multiEdit(filePath: string, edits: Array<{ search: string; replace: string }>): Promise<string> {
    const full = this.resolveSafe(filePath);
    let content = await fs.readFile(full, 'utf-8');
    let count = 0;
    for (const edit of edits) {
      if (!content.includes(edit.search)) throw new Error(`Search text not found for edit ${count + 1}`);
      content = content.replace(edit.search, edit.replace);
      count++;
    }
    await fs.writeFile(full, content, 'utf-8');
    return `Applied ${count} edits to ${filePath}`;
  }

  async deleteFile(filePath: string): Promise<string> {
    await fs.rm(this.resolveSafe(filePath), { recursive: true, force: true });
    return `Deleted ${filePath}`;
  }

  async moveFile(from: string, to: string): Promise<string> {
    const src = this.resolveSafe(from);
    const dst = this.resolveSafe(to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    return `Moved ${from} -> ${to}`;
  }

  async copyFile(from: string, to: string): Promise<string> {
    const src = this.resolveSafe(from);
    const dst = this.resolveSafe(to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.cp(src, dst, { recursive: true });
    return `Copied ${from} -> ${to}`;
  }

  async mkdir(dir: string): Promise<string> {
    await fs.mkdir(this.resolveSafe(dir), { recursive: true });
    return `Created directory ${dir}`;
  }

  async statFile(filePath: string): Promise<string> {
    const full = this.resolveSafe(filePath);
    const stat = await fs.stat(full);
    return JSON.stringify({ path: filePath, size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), modified: stat.mtime.toISOString() }, null, 2);
  }

  async tree(dir = '.', depth = 3): Promise<string> {
    const root = this.resolveSafe(dir);
    const lines: string[] = [];
    const visit = async (current: string, prefix: string, level: number) => {
      if (level > depth) return;
      const entries = (await fs.readdir(current, { withFileTypes: true }))
        .filter(e => !e.name.startsWith('.') && !(e.isDirectory() && SKIP_DIRS.has(e.name)))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const [index, entry] of entries.entries()) {
        const last = index === entries.length - 1;
        lines.push(`${prefix}${last ? '└──' : '├──'} ${entry.name}${entry.isDirectory() ? '/' : ''}`);
        if (entry.isDirectory()) await visit(path.join(current, entry.name), prefix + (last ? '    ' : '│   '), level + 1);
      }
    };
    lines.push(`${dir}/`);
    await visit(root, '', 1);
    return lines.join('\n');
  }

  async repoMap(): Promise<string> {
    return this.tree('.', 4);
  }

  async symbolSearch(query: string): Promise<string> {
    const files = (await this.walk(this.cwd)).filter(f => /\.(ts|tsx|js|jsx|py|go|rs|java|cpp|c|h)$/.test(f));
    const results: string[] = [];
    const re = new RegExp(`(function|class|interface|type|const|let|var|def|struct|enum)\\s+[^\\n]*${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*`, 'i');
    for (const rel of files.slice(0, 1000)) {
      const content = await fs.readFile(this.resolveSafe(rel), 'utf-8').catch(() => '');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) results.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
        if (results.length >= 100) return results.join('\n');
      }
    }
    return results.join('\n') || 'No symbols found.';
  }

  async dependencyGraph(): Promise<string> {
    const pkgPath = path.join(this.cwd, 'package.json');
    if (!existsSync(pkgPath)) return 'No package.json found.';
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return JSON.stringify({ dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {} }, null, 2);
  }

  async detectPackageManager(): Promise<string> {
    if (existsSync(path.join(this.cwd, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(path.join(this.cwd, 'yarn.lock'))) return 'yarn';
    if (existsSync(path.join(this.cwd, 'bun.lockb')) || existsSync(path.join(this.cwd, 'bun.lock'))) return 'bun';
    if (existsSync(path.join(this.cwd, 'package-lock.json'))) return 'npm';
    return 'unknown';
  }

  async glob(pattern: string): Promise<string> {
    const files = await this.walk(this.cwd);
    const needle = pattern.replace(/\*/g, '').toLowerCase();
    return files.filter(f => pattern === '*' || f.toLowerCase().includes(needle)).slice(0, 200).join('\n') || 'No files matched.';
  }

  async webSearch(query: string, signal?: AbortSignal): Promise<string> {
    const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal, headers: { 'user-agent': 'customize-agent/1.0' } });
    const html = await res.text();
    const matches = [...html.matchAll(/<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.*?)<\/a>/g)].slice(0, 8);
    if (!matches.length) return `No web results for ${query}`;
    return matches.map((m, i) => `${i + 1}. ${this.decodeHtml(m[2] ?? '')}\n${this.decodeHtml(m[1] ?? '')}`).join('\n\n');
  }

  async webFetch(url: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(url, { signal, headers: { 'user-agent': 'customize-agent/1.0' } });
    const text = await res.text();
    return text.slice(0, 60_000);
  }

  async downloadFile(url: string, output: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(url, { signal, headers: { 'user-agent': 'customize-agent/1.0' } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const full = this.resolveSafe(output);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return `Downloaded ${url} -> ${output} (${buffer.length} bytes)`;
  }

  async exportMarkdown(output: string, content: string): Promise<string> {
    const full = this.resolveSafe(output);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf-8');
    return `Exported markdown: ${output}`;
  }

  async exportJson(output: string, data: unknown): Promise<string> {
    const full = this.resolveSafe(output);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, JSON.stringify(data, null, 2), 'utf-8');
    return `Exported JSON: ${output}`;
  }

  async exportHtml(output: string, title: string, body: string): Promise<string> {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${this.escapeHtml(title)}</title></head><body><pre>${this.escapeHtml(body)}</pre></body></html>`;
    const full = this.resolveSafe(output);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, html, 'utf-8');
    return `Exported HTML: ${output}`;
  }

  async exportPdf(output: string, title: string, body: string): Promise<string> {
    const pdf = this.simplePdf(`${title}\n\n${body}`);
    const full = this.resolveSafe(output);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, pdf);
    return `Exported PDF: ${output}`;
  }

  async exportSession(output: string, messages: unknown): Promise<string> {
    return this.exportJson(output, messages);
  }

  async zipFiles(output: string, files: string[]): Promise<string> {
    const out = this.resolveSafe(output.endsWith('.tar') ? output : `${output}.tar`);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const args = ['-cf', out, ...files.map(f => this.resolveSafe(f))];
    const res = await execa('tar', args, { cwd: this.cwd, reject: false });
    if (res.exitCode !== 0) throw new Error(res.stderr || res.stdout || 'tar failed');
    return `Created archive ${path.relative(this.cwd, out)}`;
  }

  async git(args: string[]): Promise<string> {
    const res = await execa('git', args, { cwd: this.cwd, reject: false });
    return [res.stdout, res.stderr].filter(Boolean).join('\n') || `[Exit ${res.exitCode}]`;
  }

  async runBackground(command: string): Promise<string> {
    const id = `cmd-${Date.now()}`;
    const child = execaCommand(command, { cwd: this.cwd, shell: true, reject: false });
    const proc: BackgroundProcess = { command, child, output: [], startedAt: new Date().toISOString() };
    child.stdout?.on('data', (chunk: Buffer) => proc.output.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => proc.output.push(chunk.toString()));
    child.catch((err: Error) => proc.output.push(err.message));
    BuiltinTools.background.set(id, proc);
    return `Started ${id}: ${command}`;
  }

  async checkCommand(id: string): Promise<string> {
    const proc = BuiltinTools.background.get(id);
    if (!proc) return `Unknown command: ${id}`;
    const done = proc.child.exitCode !== undefined && proc.child.exitCode !== null;
    return JSON.stringify({ id, command: proc.command, startedAt: proc.startedAt, running: !done, exitCode: proc.child.exitCode, output: proc.output.join('').slice(-20_000) }, null, 2);
  }

  async stopCommand(id: string): Promise<string> {
    const proc = BuiltinTools.background.get(id);
    if (!proc) return `Unknown command: ${id}`;
    proc.child.kill('SIGTERM');
    return `Stopped ${id}`;
  }

  async openPreview(url: string): Promise<string> {
    return `Preview URL: ${url}`;
  }

  async browserOpen(url: string): Promise<string> {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', url] : [url];
    const res = await execa(opener, args, { reject: false });
    return res.exitCode === 0 ? `Opened ${url}` : `Failed to open ${url}: ${res.stderr}`;
  }

  async runScript(kind: 'test' | 'build' | 'lint'): Promise<string> {
    const pkgPath = path.join(this.cwd, 'package.json');
    if (!existsSync(pkgPath)) return 'No package.json found.';
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    if (!pkg.scripts?.[kind]) return `No ${kind} script found.`;
    const manager = existsSync(path.join(this.cwd, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(this.cwd, 'yarn.lock')) ? 'yarn' : 'npm';
    const res = await execa(manager, ['run', kind], { cwd: this.cwd, reject: false });
    return [res.stdout, res.stderr, `[Exit ${res.exitCode}]`].filter(Boolean).join('\n');
  }

  async doctor(): Promise<string> {
    const checks = await Promise.all([
      this.versionOf('node', ['--version']),
      this.versionOf('pnpm', ['--version']),
      this.versionOf('git', ['--version']),
      this.versionOf('rg', ['--version']),
    ]);
    return checks.join('\n');
  }

  async checkUpdate(packageName = 'customize-agent', currentVersion = '0.0.3'): Promise<string> {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`);
    if (!res.ok) return `Unable to check updates for ${packageName}.`;
    const info = await res.json() as PackageInfo;
    return `Current: ${currentVersion}\nLatest: ${info.version ?? 'unknown'}`;
  }

  async update(packageName = 'customize-agent'): Promise<string> {
    const manager = existsSync(path.join(this.cwd, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
    const res = await execa(manager, ['add', '-g', packageName], { reject: false });
    return [res.stdout, res.stderr, `[Exit ${res.exitCode}]`].filter(Boolean).join('\n');
  }

  async inspectFile(filePath: string): Promise<string> {
    const full = this.resolveSafe(filePath);
    const stat = await fs.stat(full);
    const buffer = stat.isFile() ? await fs.readFile(full) : Buffer.alloc(0);
    const hash = stat.isFile() ? createHash('sha256').update(buffer).digest('hex') : undefined;
    return JSON.stringify({ path: filePath, size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), sha256: hash, modified: stat.mtime.toISOString() }, null, 2);
  }

  async extractText(filePath: string): Promise<string> {
    const full = this.resolveSafe(filePath);
    const buffer = await fs.readFile(full);
    const text = [...buffer.toString('utf-8')].filter(ch => {
      const code = ch.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    }).join('');
    return text.slice(0, 60_000) || 'No extractable text found.';
  }

  async extractPdfText(filePath: string): Promise<string> {
    const full = this.resolveSafe(filePath);
    const mod = await import('pdf-parse');
    const pdfParse = (mod as unknown as { default?: (data: Buffer) => Promise<{ text: string }> }).default ?? (mod as unknown as (data: Buffer) => Promise<{ text: string }>);
    const result = await pdfParse(await fs.readFile(full));
    return result.text.slice(0, 60_000) || 'No text found in PDF.';
  }

  async extractDocxText(filePath: string): Promise<string> {
    const result = await mammoth.extractRawText({ path: this.resolveSafe(filePath) });
    return result.value.slice(0, 60_000) || 'No text found in DOCX.';
  }

  async extractXlsxData(filePath: string): Promise<string> {
    const workbook = XLSX.readFile(this.resolveSafe(filePath));
    const sheets: Record<string, unknown[]> = {};
    for (const name of workbook.SheetNames) sheets[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name]!);
    return JSON.stringify(sheets, null, 2).slice(0, 60_000);
  }

  async ocrImage(filePath: string): Promise<string> {
    const worker = await createWorker('eng+chi_sim');
    try {
      const result = await worker.recognize(this.resolveSafe(filePath));
      return result.data.text.trim() || 'No text recognized.';
    } finally {
      await worker.terminate();
    }
  }

  async transcribeAudio(filePath: string): Promise<string> {
    const info = await this.mediaProbe(filePath);
    return `Audio transcription model is not bundled. Media metadata:\n${info}`;
  }

  async videoMetadata(filePath: string): Promise<string> { return this.mediaProbe(filePath); }

  async convertFile(input: string, output: string): Promise<string> {
    const res = await execa('ffmpeg', ['-y', '-i', this.resolveSafe(input), this.resolveSafe(output)], { reject: false });
    if (res.exitCode !== 0) throw new Error(res.stderr || 'ffmpeg conversion failed');
    return `Converted ${input} -> ${output}`;
  }

  async compressImage(input: string, output: string): Promise<string> {
    await sharp(this.resolveSafe(input)).jpeg({ quality: 80 }).toFile(this.resolveSafe(output));
    return `Compressed image ${input} -> ${output}`;
  }

  async generateThumbnail(input: string, output: string): Promise<string> {
    await sharp(this.resolveSafe(input)).resize(320, 320, { fit: 'inside' }).toFile(this.resolveSafe(output));
    return `Generated thumbnail ${input} -> ${output}`;
  }

  async version(): Promise<string> {
    const pkgPath = path.join(this.cwd, 'package.json');
    if (!existsSync(pkgPath)) return 'No package.json found.';
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { name?: string; version?: string };
    return `${pkg.name ?? 'project'} ${pkg.version ?? '0.0.0'}`;
  }

  async toolHealth(): Promise<string> { return this.doctor(); }

  async todoWrite(items: string[]): Promise<string> {
    return items.map((item, i) => `${i + 1}. [ ] ${item}`).join('\n');
  }

  async mcpList(): Promise<string> {
    const config = await this.loadMcpConfig();
    const entries = Object.entries(config);
    return entries.length ? entries.map(([name, server]) => `${name}: ${server.command} ${server.args.join(' ')}`.trim()).join('\n') : 'No MCP servers configured.';
  }

  async mcpAdd(name: string, command: string): Promise<string> {
    const [cmd, ...args] = command.split(/\s+/).filter(Boolean);
    if (!cmd) throw new Error('MCP command is required');
    const config = await this.loadMcpConfig();
    config[name] = { command: cmd, args };
    await this.saveMcpConfig(config);
    return `MCP server added: ${name}`;
  }

  async mcpRemove(name: string): Promise<string> {
    const config = await this.loadMcpConfig();
    delete config[name];
    await this.saveMcpConfig(config);
    return `MCP server removed: ${name}`;
  }

  async mcpTools(name?: string): Promise<string> {
    const config = await this.loadMcpConfig();
    const names = name ? [name] : Object.keys(config);
    if (!names.length) return 'No MCP servers configured.';
    const output: string[] = [];
    for (const serverName of names) {
      const server = config[serverName];
      if (!server) { output.push(`${serverName}: not configured`); continue; }
      const transport = new StdioClientTransport({ command: server.command, args: server.args, cwd: this.cwd, stderr: 'pipe' });
      const client = new Client({ name: 'customize-agent', version: '1.0.0' }, { capabilities: {} });
      try {
        await client.connect(transport);
        const tools = await client.listTools();
        output.push(`${serverName}:\n${tools.tools.map(tool => `- ${tool.name}: ${tool.description ?? ''}`).join('\n') || 'No tools.'}`);
      } finally {
        await client.close().catch(() => undefined);
      }
    }
    return output.join('\n\n');
  }

  async pluginList(): Promise<string> {
    const config = await this.loadPluginConfig();
    return config.installed.length ? config.installed.join('\n') : 'No plugins installed.';
  }

  async pluginInstall(name: string): Promise<string> {
    const config = await this.loadPluginConfig();
    if (!config.installed.includes(name)) config.installed.push(name);
    await this.savePluginConfig(config);
    return `Plugin installed: ${name}`;
  }

  async checkpointCreate(name: string): Promise<string> {
    const snapshot = await this.takeSnapshot();
    await fs.mkdir(this.snapshotDir(), { recursive: true });
    await fs.writeFile(this.snapshotFile(name), JSON.stringify([...snapshot.entries()].map(([k, v]) => [k, v.toString('base64')])), 'utf-8');
    return `Checkpoint created: ${name}`;
  }

  async checkpointList(): Promise<string> {
    await fs.mkdir(this.snapshotDir(), { recursive: true });
    const files = (await fs.readdir(this.snapshotDir())).filter(f => f.endsWith('.json'));
    return files.map(f => f.replace(/\.json$/, '')).join('\n') || 'No checkpoints.';
  }

  async checkpointRestore(name: string): Promise<string> {
    const raw = await fs.readFile(this.snapshotFile(name), 'utf-8');
    const snapshot = new Map((JSON.parse(raw) as Array<[string, string]>).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
    await this.restoreSnapshot(snapshot);
    return `Checkpoint restored: ${name}`;
  }

  async checkpointDelete(name: string): Promise<string> {
    await fs.rm(this.snapshotFile(name), { force: true });
    return `Checkpoint deleted: ${name}`;
  }

  private async takeSnapshot(): Promise<Snapshot> {
    const snapshot: Snapshot = new Map();
    for (const rel of await this.walk(this.cwd)) {
      const full = this.resolveSafe(rel);
      const stat = await fs.stat(full);
      if (stat.size <= SNAPSHOT_MAX_FILE_SIZE) snapshot.set(rel, await fs.readFile(full));
    }
    return snapshot;
  }

  private async mediaProbe(filePath: string): Promise<string> {
    const res = await execa('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', this.resolveSafe(filePath)], { reject: false });
    if (res.exitCode !== 0) return this.inspectFile(filePath);
    return res.stdout || await this.inspectFile(filePath);
  }

  private async loadMcpConfig(): Promise<McpConfig> {
    try { return JSON.parse(await fs.readFile(this.mcpConfigFile(), 'utf-8')) as McpConfig; }
    catch { return {}; }
  }

  private async saveMcpConfig(config: McpConfig): Promise<void> {
    await fs.mkdir(this.configDir(), { recursive: true });
    await fs.writeFile(this.mcpConfigFile(), JSON.stringify(config, null, 2), 'utf-8');
  }

  private async loadPluginConfig(): Promise<PluginConfig> {
    try { return JSON.parse(await fs.readFile(this.pluginConfigFile(), 'utf-8')) as PluginConfig; }
    catch { return { installed: [] }; }
  }

  private async savePluginConfig(config: PluginConfig): Promise<void> {
    await fs.mkdir(this.configDir(), { recursive: true });
    await fs.writeFile(this.pluginConfigFile(), JSON.stringify(config, null, 2), 'utf-8');
  }

  private async restoreSnapshot(snapshot: Snapshot): Promise<void> {
    const current = await this.takeSnapshot();
    for (const [rel] of current) if (!snapshot.has(rel)) await fs.rm(this.resolveSafe(rel), { force: true });
    for (const [rel, content] of snapshot) {
      const full = this.resolveSafe(rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
  }

  private async versionOf(bin: string, args: string[]): Promise<string> {
    const res = await execa(bin, args, { reject: false });
    return `${bin}: ${res.exitCode === 0 ? res.stdout.split('\n')[0] : 'not found'}`;
  }

  private decodeHtml(input: string): string {
    return input.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  private escapeHtml(input: string): string {
    return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private simplePdf(text: string): Buffer {
    const safe = text.replace(/[()\\]/g, '\\$&').split('\n').slice(0, 80);
    const content = `BT /F1 12 Tf 50 780 Td ${safe.map((line, i) => `${i ? '0 -16 Td ' : ''}(${line}) Tj`).join(' ')} ET`;
    const objects = [
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
      '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
      `5 0 obj << /Length ${Buffer.byteLength(content)} >> stream\n${content}\nendstream endobj`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const obj of objects) { offsets.push(Buffer.byteLength(pdf)); pdf += obj + '\n'; }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n ').join('\n')}\n`;
    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf);
  }
}
