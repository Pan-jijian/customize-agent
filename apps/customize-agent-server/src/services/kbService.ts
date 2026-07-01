import { MultiProjectManager } from '@customize-agent/knowledge';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let manager: MultiProjectManager | null = null;

export function getMultiProjectManager(): MultiProjectManager {
  if (!manager) manager = new MultiProjectManager();
  return manager;
}

/** 从 registry.db 读取所有已知项目的 project_root */
export function getKnownProjectRoots(): string[] {
  const registryPath = path.join(os.homedir(), '.customize-agent', 'projects', 'registry.db');
  if (!fs.existsSync(registryPath)) return [];
  const db = new Database(registryPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT project_root FROM project_registry').all() as Array<{ project_root: string }>;
    return rows.map(r => r.project_root);
  } finally { db.close(); }
}

/** 安全获取 projectRoot: 仅在 registry 中已注册或通过环境变量指定，拒绝自动初始化服务端目录 */
export function getProjectRoot(fallbackToCwd = false): string {
  const envRoot = process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD;
  if (envRoot && fs.existsSync(envRoot)) {
    const resolved = path.resolve(envRoot);
    // 检查是否在 registry 中或有 CUSTOMIZE.md，避免使用服务端目录
    const known = getKnownProjectRoots();
    if (known.includes(resolved) || fs.existsSync(path.join(resolved, 'CUSTOMIZE.md'))) {
      return resolved;
    }
  }
  const known = getKnownProjectRoots();
  if (known.length > 0) return known[0]!;
  if (fallbackToCwd) return process.cwd();
  // 没有已知项目时返回空串，调用方应自行处理空目录
  return '';
}

/** 获取安全的 projectRoot: 必须在 registry 中已注册，拒绝自动初始化服务端目录 */
export function resolveProjectRoot(queryRoot?: string): string | null {
  if (queryRoot) {
    const resolved = path.resolve(queryRoot);
    return fs.existsSync(resolved) ? resolved : null;
  }
  // 用 CUSTOMIZE_PROJECT_ROOT 环境变量
  const envRoot = process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD;
  if (envRoot && fs.existsSync(envRoot)) return path.resolve(envRoot);
  // 从 registry 取最近一个项目
  const known = getKnownProjectRoots();
  return known.length > 0 ? known[0]! : null;
}

export async function shutdownKbService(): Promise<void> {
  if (manager) { await manager.shutdown(); manager = null; }
}
