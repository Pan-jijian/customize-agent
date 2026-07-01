import * as crypto from 'node:crypto';
import * as path from 'node:path';

export function computeProjectId(projectRoot: string): string {
  return crypto.createHash('sha256')
    .update(path.resolve(projectRoot))
    .digest('hex')
    .slice(0, 12);
}
