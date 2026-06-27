/**
 * 按需文件索引 — 首次 @ 触发时 git ls-files 扫描，子串匹配 + 评分排序。
 * 优先 git ls-files（毫秒级），回退 fast-glob。会话期间缓存。
 */
import { execSync } from 'child_process';
import glob from 'fast-glob';

export class FileIndex {
  private files: string[] | null = null;
  private root: string;

  constructor(root: string) { this.root = root; }

  /** 子串匹配 + 按匹配位置/路径长度评分排序，最多 max 条 */
  search(partial: string, max = 12): string[] {
    if (!this.files) this._build();
    const lower = partial.toLowerCase();
    const scored: Array<{ f: string; s: number }> = [];
    for (const f of this.files!) {
      const idx = f.toLowerCase().indexOf(lower);
      if (idx >= 0) {
        scored.push({ f, s: idx * 10000 + f.length });
      }
    }
    scored.sort((a, b) => a.s - b.s);
    return scored.slice(0, max).map(x => x.f);
  }

  invalidate(): void { this.files = null; }

  private _build(): void {
    this.files = this._scan();
  }

  private _scan(): string[] {
    try {
      const out = execSync('git ls-files --cached --others --exclude-standard', {
        cwd: this.root, encoding: 'utf-8', timeout: 5000, maxBuffer: 10 * 1024 * 1024,
      });
      return out.trim().split('\n').filter(Boolean);
    } catch {
      return glob.globSync(['**/*'], {
        cwd: this.root,
        ignore: ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/*.db', '**/*.lock', '**/*.log'],
        dot: false,
      });
    }
  }
}
