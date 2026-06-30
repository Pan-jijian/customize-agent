// @customize-agent/tools — Shell & Git 工具
import * as fs from 'fs/promises';
import { existsSync, createWriteStream } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execa, execaCommand } from 'execa';
import { resolveSafe } from '../core/path-utils.js';
import { killProcess } from '../core/platform/process.js';
import { translateCommand } from '../core/platform/shell.js';

type BackgroundProcess = { command: string; child: any; output: string[]; startedAt: string };

export class ShellTools {
  private static background = new Map<string, BackgroundProcess>();

  constructor(private cwd: string) {}

  async git(args: string[]): Promise<string> {
    const res = await execa('git', args, { cwd: this.cwd, reject: false });
    return [res.stdout, res.stderr].filter(Boolean).join('\n') || `[Exit ${res.exitCode}]`;
  }

  async runBackground(command: string): Promise<string> {
    const id = `cmd-${Date.now()}`;
    const translated = await translateCommand(command);
    // execaCommand returns ResultPromise which supports .stdout.on('data') at runtime
    // even though TypeScript types in execa v9 don't perfectly capture this
    const child: any = execaCommand(translated, { cwd: this.cwd, shell: true, reject: false });
    const proc: BackgroundProcess = { command, child, output: [], startedAt: new Date().toISOString() };
    child.stdout?.on('data', (chunk: Buffer) => proc.output.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => proc.output.push(chunk.toString()));
    child.catch((err: Error) => proc.output.push(err.message));
    ShellTools.background.set(id, proc);
    return `Started ${id}: ${command}`;
  }

  async checkCommand(id: string): Promise<string> {
    const proc = ShellTools.background.get(id);
    if (!proc) return `Unknown command: ${id}`;
    const done = proc.child.exitCode !== undefined && proc.child.exitCode !== null;
    return JSON.stringify({ id, command: proc.command, startedAt: proc.startedAt, running: !done, exitCode: proc.child.exitCode, output: proc.output.join('').slice(-20_000) }, null, 2);
  }

  async stopCommand(id: string): Promise<string> {
    const proc = ShellTools.background.get(id);
    if (!proc) return `Unknown command: ${id}`;
    await killProcess(proc.child);
    return `Stopped ${id}`;
  }

  async runScript(kind: 'test' | 'build' | 'lint', signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const pkgPath = path.join(this.cwd, 'package.json');
    if (!existsSync(pkgPath)) return 'No package.json found.';
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    if (!pkg.scripts?.[kind]) return `No ${kind} script found.`;
    const manager = existsSync(path.join(this.cwd, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(path.join(this.cwd, 'yarn.lock')) ? 'yarn' : 'npm';
    const res = await execa(manager, ['run', kind], { cwd: this.cwd, reject: false, cancelSignal: signal });
    return [res.stdout, res.stderr, `[Exit ${res.exitCode}]`].filter(Boolean).join('\n');
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

  async zipFiles(output: string, files: string[]): Promise<string> {
    const out = resolveSafe(output.endsWith('.tar') ? output : `${output}.tar`, this.cwd);
    await fs.mkdir(path.dirname(out), { recursive: true });

    // Dynamic import: archiver v8 is ESM-only with named exports
    const { Archiver } = await import('archiver');

    return new Promise((resolve, reject) => {
      const stream = createWriteStream(out);
      const archive = new Archiver({ format: 'tar', gzip: false });
      archive.on('error', (err: Error) => reject(err));
      stream.on('error', (err: Error) => reject(err));
      stream.on('close', () => {
        resolve(`Created archive ${path.relative(this.cwd, out)}`);
      });
      archive.pipe(stream);

      for (const f of files) {
        const fullPath = resolveSafe(f, this.cwd);
        archive.file(fullPath, { name: f });
      }
      void archive.finalize();
    });
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

  async checkUpdate(packageName = 'customize-agent', currentVersion = '0.0.3'): Promise<string> {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`);
    if (!res.ok) return `Unable to check updates for ${packageName}.`;
    const info = await res.json() as { version?: string };
    return `Current: ${currentVersion}\nLatest: ${info.version ?? 'unknown'}`;
  }

  async update(packageName = 'customize-agent'): Promise<string> {
    const manager = existsSync(path.join(this.cwd, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
    const res = await execa(manager, ['add', '-g', packageName], { reject: false });
    return [res.stdout, res.stderr, `[Exit ${res.exitCode}]`].filter(Boolean).join('\n');
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

  private pluginConfigFile(): string {
    return path.join(os.homedir(), '.customize-agent', 'plugins.json');
  }

  private async loadPluginConfig(): Promise<{ installed: string[] }> {
    try { return JSON.parse(await fs.readFile(this.pluginConfigFile(), 'utf-8')) as { installed: string[] }; }
    catch { return { installed: [] }; }
  }

  private async savePluginConfig(config: { installed: string[] }): Promise<void> {
    const dir = path.join(os.homedir(), '.customize-agent');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.pluginConfigFile(), JSON.stringify(config, null, 2), 'utf-8');
  }

  private async versionOf(bin: string, args: string[]): Promise<string> {
    const res = await execa(bin, args, { reject: false });
    return `${bin}: ${res.exitCode === 0 ? res.stdout.split('\n')[0] : 'not found'}`;
  }
}
