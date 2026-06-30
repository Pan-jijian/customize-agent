// @customize-agent/tools — 搜索 & 项目分析工具
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { SKIP_DIRS } from '../core/constants.js';
import { formatErrorForModel } from '@customize-agent/types';
import { resolveSafe, walk } from '../core/path-utils.js';

export class SearchTools {
  constructor(private cwd: string) {}

  async tree(dir = '.', depth = 3): Promise<string> {
    const root = resolveSafe(dir, this.cwd);
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
    const files = (await walk(this.cwd, SKIP_DIRS)).filter(f => /\.(ts|tsx|js|jsx|py|go|rs|java|cpp|c|h)$/.test(f));
    const results: string[] = [];
    const re = new RegExp(`(function|class|interface|type|const|let|var|def|struct|enum)\\s+[^\\n]*${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*`, 'i');
    const skipped: string[] = [];
    for (const rel of files.slice(0, 1000)) {
      let content: string;
      try {
        content = await fs.readFile(resolveSafe(rel, this.cwd), 'utf-8');
      } catch (err) {
        if (skipped.length < 5) skipped.push(`${rel}: ${(err as Error).message}`);
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) results.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
        if (results.length >= 100) return this.formatSymbolSearchResult(results, skipped);
      }
    }
    return this.formatSymbolSearchResult(results, skipped);
  }

  private formatSymbolSearchResult(results: string[], skipped: string[]): string {
    const body = results.join('\n') || 'No symbols found.';
    if (skipped.length === 0) return body;
    const warning = formatErrorForModel({
      kind: 'tool_warning',
      source: 'symbol_search',
      message: `skipped ${skipped.length} unreadable files`,
      modelVisible: true,
      userVisible: true,
      details: { skipped },
    });
    return `${warning}\n\n${body}`;
  }

  async glob(pattern: string): Promise<string> {
    const files = await walk(this.cwd, SKIP_DIRS);
    const needle = pattern.replace(/\*/g, '').toLowerCase();
    return files.filter(f => pattern === '*' || f.toLowerCase().includes(needle)).slice(0, 200).join('\n') || 'No files matched.';
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
}
