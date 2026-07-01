import * as fs from 'node:fs';
import * as path from 'node:path';
import fg from 'fast-glob';

export interface DiskFileStat {
  size: number;
  mtime: number;
}

export class KnowledgeFileScanner {
  async scan(kbPath: string, ignorePatterns: string[] = []): Promise<Map<string, DiskFileStat>> {
    if (!fs.existsSync(kbPath)) return new Map();

    const entries = await fg('**/*', {
      cwd: kbPath,
      onlyFiles: true,
      dot: true,
      ignore: ['.kbignore', ...ignorePatterns],
      unique: true,
    });

    const files = new Map<string, DiskFileStat>();
    for (const relativePath of entries) {
      const absolutePath = path.join(kbPath, relativePath);
      const stat = fs.statSync(absolutePath);
      files.set(relativePath, { size: stat.size, mtime: stat.mtimeMs });
    }
    return files;
  }

  loadKbIgnore(kbPath: string): string[] {
    const ignorePath = path.join(kbPath, '.kbignore');
    if (!fs.existsSync(ignorePath)) return [];

    return fs.readFileSync(ignorePath, 'utf8')
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  }
}
