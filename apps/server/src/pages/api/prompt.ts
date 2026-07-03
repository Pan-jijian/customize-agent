import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

type RegistryRow = Record<string, unknown>;

const registryPath = path.join(os.homedir(), '.customize-agent', 'projects', 'registry.db');

function normalizePath(value: string): string {
  return path.resolve(value);
}

function isInternalResidualProject(projectRoot: string): boolean {
  const normalized = normalizePath(projectRoot);
  const homeConfig = normalizePath(path.join(os.homedir(), '.customize-agent'));
  const parts = normalized.split(path.sep);
  return normalized === homeConfig
    || normalized.endsWith(`${path.sep}apps${path.sep}server`)
    || normalized.endsWith(`${path.sep}apps${path.sep}cli`)
    || parts.includes('.customize-agent');
}

function openRegistry(readonly: boolean) {
  return fs.existsSync(registryPath) ? new Database(registryPath, { readonly }) : null;
}

function cleanupResidualProjects(projectIds: string[]): void {
  if (projectIds.length === 0) return;
  const db = openRegistry(false);
  if (!db) return;
  try {
    const deleteStmt = db.prepare('DELETE FROM project_registry WHERE project_id = ?');
    for (const projectId of projectIds) deleteStmt.run(projectId);
  } catch (error) {
    void error;
  } finally {
    db.close();
  }
}

interface PromptProject {
  projectId: string;
  projectRoot: string;
  projectName: string;
  customizePath: string;
  content: string;
  mtime: string;
  hasFile: boolean;
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const projects: PromptProject[] = [];
      const residualProjectIds: string[] = [];
      const db = openRegistry(true);
      if (db) {
        try {
          const rows = db.prepare('SELECT project_id, project_root, project_name FROM project_registry ORDER BY last_opened_at DESC').all() as RegistryRow[];
          for (const row of rows) {
            const root = normalizePath(String(row.project_root));
            if (isInternalResidualProject(root)) {
              residualProjectIds.push(String(row.project_id));
              continue;
            }
            const mdPath = path.join(root, 'CUSTOMIZE.md');
            const hasFile = fs.existsSync(mdPath);
            projects.push({
              projectId: String(row.project_id),
              projectRoot: root,
              projectName: String(row.project_name || path.basename(root) || root),
              customizePath: mdPath,
              content: hasFile ? fs.readFileSync(mdPath, 'utf-8') : '',
              mtime: hasFile ? fs.statSync(mdPath).mtime.toISOString() : '',
              hasFile,
            });
          }
        } finally {
          db.close();
        }
      }
      cleanupResidualProjects(residualProjectIds);
      return res.status(200).json(projects);
    }

    if (req.method === 'PUT') {
      const { filePath, content } = req.body;
      if (!filePath || typeof content !== 'string') return res.status(400).json({ error: 'filePath and content required' });
      const root = normalizePath(path.dirname(String(filePath)));
      if (isInternalResidualProject(root) || path.basename(String(filePath)) !== 'CUSTOMIZE.md') return res.status(403).json({ error: 'Invalid prompt file' });
      if (!fs.existsSync(root)) return res.status(404).json({ error: 'Project directory not found' });
      fs.writeFileSync(path.join(root, 'CUSTOMIZE.md'), content, 'utf-8');
      return res.status(200).json({ success: true, mtime: fs.statSync(path.join(root, 'CUSTOMIZE.md')).mtime.toISOString() });
    }

    if (req.method === 'DELETE') {
      const { filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'filePath required' });
      const root = normalizePath(path.dirname(String(filePath)));
      if (isInternalResidualProject(root) || path.basename(String(filePath)) !== 'CUSTOMIZE.md') return res.status(403).json({ error: 'Invalid prompt file' });
      const target = path.join(root, 'CUSTOMIZE.md');
      if (!fs.existsSync(target)) return res.status(404).json({ error: 'File not found' });
      fs.unlinkSync(target);
      return res.status(200).json({ success: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) { console.error('[api] prompt', e); res.status(500).json({ error: 'Internal server error' }); }
}
