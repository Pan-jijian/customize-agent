import { execa } from 'execa';
import * as fs from 'fs/promises';
import * as path from 'path';
import glob from 'fast-glob';

/** 搜索结果条目 */
export interface SearchMatch {
  /** 文件路径 */
  file: string;
  /** 行号 */
  line: number;
  /** 匹配行内容 */
  content: string;
}

/** 搜索选项 */
export interface SearchOptions {
  /** 限定搜索目录 */
  path?: string;
  /** 按扩展名过滤 */
  fileTypes?: string[];
  /** 最大返回结果数（默认 50） */
  maxResults?: number;
  /** 大小写敏感（默认 false） */
  caseSensitive?: boolean;
}

/**
 * 代码文本搜索 — L2 层（ripgrep 优先，不可用时降级为 fast-glob + 行扫描）
 */
export class CodeSearcher {
  private cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /** 执行文本搜索：ripgrep 优先，不可用时降级 fast-glob + 行扫描 */
  async grep(pattern: string, options: SearchOptions = {}): Promise<SearchMatch[]> {
    const maxResults = options.maxResults ?? 50;

    // 优先使用 ripgrep
    try {
      return await this._rgSearch(pattern, options, maxResults);
    } catch {
      // rg 不可用 → 降级为纯 JS 实现
      console.warn('[CodeSearcher] ripgrep unavailable, falling back to JS search');
      return this._jsSearch(pattern, options, maxResults);
    }
  }

  private async _rgSearch(pattern: string, options: SearchOptions, maxResults: number): Promise<SearchMatch[]> {
    const args: string[] = ['--no-heading', '--with-filename', '--line-number', '--max-count', String(maxResults)];

    if (!options.caseSensitive) {
      args.push('--ignore-case');
    }
    if (options.fileTypes && options.fileTypes.length > 0) {
      for (const ft of options.fileTypes) {
        args.push('--type-add', `custom:*.${ft}`, '--type', 'custom');
      }
    }

    args.push('--', pattern);
    if (options.path) {
      args[args.length - 1] = path.resolve(this.cwd, options.path);
    }

    const result = await execa({
      cwd: this.cwd,
      reject: false,
      timeout: 30_000,
    })`rg ${args}`;

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr || 'rg failed');
    }

    return this._parseRgOutput(result.stdout);
  }

  private _parseRgOutput(stdout: string): SearchMatch[] {
    const results: SearchMatch[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      // 格式: file:line:content
      const colon1 = line.indexOf(':');
      const colon2 = line.indexOf(':', colon1 + 1);
      if (colon1 < 0 || colon2 < 0) continue;

      const file = line.slice(0, colon1);
      const lineNum = parseInt(line.slice(colon1 + 1, colon2), 10);
      const content = line.slice(colon2 + 1);

      if (!isNaN(lineNum)) {
        results.push({ file, line: lineNum, content: content.trim() });
      }
    }
    return results;
  }

  private async _jsSearch(pattern: string, options: SearchOptions, maxResults: number): Promise<SearchMatch[]> {
    const results: SearchMatch[] = [];
    const searchBase = options.path ? path.resolve(this.cwd, options.path) : this.cwd;

    const pattern_files = options.fileTypes && options.fileTypes.length > 0
      ? options.fileTypes.map(ft => `**/*.${ft}`)
      : ['**/*'];

    const files = await glob(pattern_files, {
      cwd: searchBase,
      absolute: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/target/**'],
    });

    const regex = new RegExp(pattern, options.caseSensitive ? 'g' : 'gi');

    for (const file of files) {
      if (results.length >= maxResults) break;
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
          const line = lines[i];
          if (line !== undefined && regex.test(line)) {
            results.push({ file: path.relative(this.cwd, file), line: i + 1, content: line.trim() });
          }
        }
      } catch {
        // 跳过无法读取的文件
      }
    }

    return results;
  }
}
