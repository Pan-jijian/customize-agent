import * as fs from 'node:fs';
import * as path from 'node:path';
import fg from 'fast-glob';

/** 磁盘文件信息 */
export interface DiskFileStat {
  size: number;
  mtime: number;
}

/** 知识库文件扫描器，用于扫描和加载知识库目录中的文件 */
export class KnowledgeFileScanner {
  /**
   * 扫描知识库目录中的所有文件
   * @param kbPath 知识库路径
   * @param ignorePatterns 忽略模式列表
   * @returns 文件相对路径到文件信息的映射
   */
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

  /**
   * 加载 .kbignore 忽略规则文件
   * @param kbPath 知识库路径
   * @returns 忽略规则列表
   */
  loadKbIgnore(kbPath: string): string[] {
    const ignorePath = path.join(kbPath, '.kbignore');
    if (!fs.existsSync(ignorePath)) return [];

    return fs.readFileSync(ignorePath, 'utf8')
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  }
}
