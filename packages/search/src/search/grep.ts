import { execa } from 'execa';
import * as fs from 'fs/promises';
import * as path from 'path';
import { rgPath } from '@vscode/ripgrep';
import glob from 'fast-glob';
import { formatErrorForModel } from '@customize-agent/types';

/** 搜索结果条目 */
export interface SearchMatch {
  /** 文件路径 */
  file: string;
  /** 行号 */
  line: number;
  /** 匹配行内容 */
  content: string;
  /** 搜索降级或跳过文件等警告 */
  warning?: string;
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
  signal?: AbortSignal;
}

/**
 * 代码文本搜索 — L2 层（ripgrep 优先，不可用时降级为 fast-glob + 行扫描）
 */
export class CodeSearcher {
  private cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
  }

  /** 执行文本搜索：@vscode/ripgrep 内置二进制 */
  async grep(pattern: string, options: SearchOptions = {}): Promise<SearchMatch[]> {
    const maxResults = options.maxResults ?? 50;
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await this._rgSearch(pattern, options, maxResults);
    } catch (err) {
      if (options.signal?.aborted || (err as Error).name === 'AbortError') throw err;
      const fallbackResults = await this._jsSearch(pattern, options, maxResults);
      const warning = formatErrorForModel({
        kind: 'fallback_warning',
        source: 'search.ripgrep',
        message: (err as Error).message,
        modelVisible: true,
        userVisible: true,
        details: { fallback: 'JavaScript search', impact: 'results may be slower or less complete' },
      });
      if (fallbackResults.length > 0) {
        fallbackResults[0]!.warning = warning;
        return fallbackResults;
      }
      return [{ file: '', line: 0, content: '', warning }];
    }
  }

  private async _rgSearch(pattern: string, options: SearchOptions, maxResults: number): Promise<SearchMatch[]> {
    const args: string[] = [
      '--no-heading', '--with-filename', '--line-number',
      '--max-count', String(maxResults),
      '--max-filesize', '1M',
      // 排除大型自动生成目录，避免搜索卡死
      '-g', '!node_modules',
      '-g', '!.git',
      '-g', '!dist',
      '-g', '!.pnpm',
    ];

    if (!options.caseSensitive) {
      args.push('--ignore-case');
    }
    if (options.fileTypes && options.fileTypes.length > 0) {
      for (const ft of options.fileTypes) {
        args.push('--type-add', `custom:*.${ft}`, '--type', 'custom');
      }
    }

    if (options.path) {
      args.push('--', pattern, path.resolve(this.cwd, options.path));
    } else {
      args.push('--', pattern);
    }

    const result = await execa(rgPath, args, {
      cwd: this.cwd,
      reject: false,
      timeout: 30_000,
      cancelSignal: options.signal,
    });

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr || 'ripgrep 搜索异常');
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
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const regex = new RegExp(pattern, options.caseSensitive ? '' : 'i');
    const skipped: string[] = [];

    for (const file of files) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
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
      } catch (err) {
        if (skipped.length < 5) skipped.push(`${path.relative(this.cwd, file)}: ${(err as Error).message}`);
      }
    }

    if (skipped.length > 0) {
      const warning = formatErrorForModel({
        kind: 'tool_warning',
        source: 'search.javascript',
        message: `skipped ${skipped.length} unreadable files`,
        modelVisible: true,
        userVisible: true,
        details: { skipped },
      });
      if (results.length > 0) results[0]!.warning = results[0]!.warning ? `${results[0]!.warning}\n\n${warning}` : warning;
      else results.push({ file: '', line: 0, content: '', warning });
    }

    return results;
  }
}
