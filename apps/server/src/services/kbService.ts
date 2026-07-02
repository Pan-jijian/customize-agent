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

function isInternalResidualProject(projectRoot: string): boolean {
  const normalized = path.resolve(projectRoot);
  const homeConfig = path.resolve(path.join(os.homedir(), '.customize-agent'));
  return normalized === homeConfig
    || normalized.includes(`${path.sep}.customize-agent${path.sep}`)
    || normalized.endsWith(`${path.sep}apps${path.sep}server`)
    || normalized.endsWith(`${path.sep}apps${path.sep}cli`);
}

export function getKnownProjectRoots(): string[] {
  const registryPath = path.join(os.homedir(), '.customize-agent', 'projects', 'registry.db');
  if (!fs.existsSync(registryPath)) return [];
  const db = new Database(registryPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT project_root FROM project_registry ORDER BY last_opened_at DESC').all() as Array<{ project_root: string }>;
    return rows.map(r => path.resolve(r.project_root)).filter(root => !isInternalResidualProject(root));
  } finally { db.close(); }
}

export function getProjectRoot(fallbackToCwd = false): string {
  const envRoot = process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD;
  if (envRoot && fs.existsSync(envRoot) && !isInternalResidualProject(envRoot)) {
    return path.resolve(envRoot);
  }
  const known = getKnownProjectRoots();
  if (known.length > 0) return known[0]!;
  if (fallbackToCwd && !isInternalResidualProject(process.cwd())) return process.cwd();
  return '';
}

export function resolveProjectRoot(queryRoot?: string): string | null {
  if (queryRoot) {
    const resolved = path.resolve(queryRoot);
    return fs.existsSync(resolved) && !isInternalResidualProject(resolved) ? resolved : null;
  }
  const envRoot = process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD;
  if (envRoot && fs.existsSync(envRoot) && !isInternalResidualProject(envRoot)) return path.resolve(envRoot);
  const known = getKnownProjectRoots();
  return known.length > 0 ? known[0]! : null;
}

export async function shutdownKbService(): Promise<void> {
  if (manager) { await manager.shutdown(); manager = null; }
}
