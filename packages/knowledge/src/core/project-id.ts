import * as crypto from 'node:crypto';
import * as path from 'node:path';

/**
 * 使用项目根目录计算项目唯一标识
 * @param projectRoot 项目根目录路径
 * @returns 项目 ID（SHA-256 前 12 位）
 */
export function computeProjectId(projectRoot: string): string {
  return crypto.createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 12);
}
