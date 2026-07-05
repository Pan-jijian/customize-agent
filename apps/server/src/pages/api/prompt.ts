import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

type RegistryRow = Record<string, unknown>;

const agentHome = path.join(os.homedir(), '.customize-agent');
const registryPath = path.join(agentHome, 'projects', 'registry.db');
const promptConfigPath = path.join(agentHome, 'prompts.json');

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

function allowedProjectRoots(): Set<string> {
  const roots = new Set<string>();
  const currentRoot = normalizePath(process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd());
  if (!isInternalResidualProject(currentRoot)) roots.add(currentRoot);
  const db = openRegistry(true);
  if (!db) return roots;
  try {
    const rows = db.prepare('SELECT project_root FROM project_registry').all() as RegistryRow[];
    for (const row of rows) {
      const root = normalizePath(String(row.project_root));
      if (!isInternalResidualProject(root)) roots.add(root);
    }
  } finally {
    db.close();
  }
  return roots;
}

function isAllowedPromptFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (path.basename(normalized) !== 'CUSTOMIZE.md') return false;
  return allowedProjectRoots().has(normalizePath(path.dirname(normalized)));
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
  id: string;
  projectId: string;
  projectRoot?: string;
  projectName: string;
  customizePath: string;
  content: string;
  mtime: string;
  hasFile: boolean;
  isCurrent: boolean;
  selected: boolean;
  source: 'current' | 'project' | 'custom';
}

interface PromptConfig {
  selectedIds: string[];
  customPrompts: Array<{ id: string; name: string; content: string; createdAt: string; updatedAt: string }>;
}

function promptIdFromPath(filePath: string): string {
  return `file:${normalizePath(filePath)}`;
}

function loadPromptConfig(): PromptConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(promptConfigPath, 'utf-8')) as Partial<PromptConfig>;
    return { selectedIds: Array.isArray(parsed.selectedIds) ? parsed.selectedIds : [], customPrompts: Array.isArray(parsed.customPrompts) ? parsed.customPrompts as PromptConfig['customPrompts'] : [] };
  } catch {
    return { selectedIds: [], customPrompts: [] };
  }
}

function savePromptConfig(config: PromptConfig): void {
  fs.mkdirSync(path.dirname(promptConfigPath), { recursive: true });
  fs.writeFileSync(promptConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const projects: PromptProject[] = [];
      const residualProjectIds: string[] = [];
      const currentRoot = normalizePath(process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd());
      const config = loadPromptConfig();
      const currentPromptId = promptIdFromPath(path.join(currentRoot, 'CUSTOMIZE.md'));
      const selectedIds = fs.existsSync(promptConfigPath) ? config.selectedIds : [currentPromptId];
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
            const id = promptIdFromPath(mdPath);
            projects.push({
              id,
              projectId: String(row.project_id),
              projectRoot: root,
              projectName: String(row.project_name || path.basename(root) || root),
              customizePath: mdPath,
              content: hasFile ? fs.readFileSync(mdPath, 'utf-8') : '',
              mtime: hasFile ? fs.statSync(mdPath).mtime.toISOString() : '',
              hasFile,
              isCurrent: root === currentRoot,
              selected: selectedIds.includes(id),
              source: root === currentRoot ? 'current' : 'project',
            });
          }
        } finally {
          db.close();
        }
      }
      const cwd = currentRoot;
      const cwdMdPath = path.join(cwd, 'CUSTOMIZE.md');
      if (!isInternalResidualProject(cwd) && !projects.some(p => p.projectRoot === cwd)) {
        const hasFile = fs.existsSync(cwdMdPath);
        projects.unshift({
          id: currentPromptId,
          projectId: 'current',
          projectRoot: cwd,
          projectName: path.basename(cwd) || cwd,
          customizePath: cwdMdPath,
          content: hasFile ? fs.readFileSync(cwdMdPath, 'utf-8') : '',
          mtime: hasFile ? fs.statSync(cwdMdPath).mtime.toISOString() : '',
          hasFile,
          isCurrent: true,
          selected: selectedIds.includes(currentPromptId),
          source: 'current',
        });
      }
      for (const custom of config.customPrompts) {
        projects.push({
          id: custom.id,
          projectId: custom.id,
          projectName: custom.name,
          customizePath: custom.id,
          content: custom.content,
          mtime: custom.updatedAt,
          hasFile: true,
          isCurrent: false,
          selected: selectedIds.includes(custom.id),
          source: 'custom',
        });
      }
      cleanupResidualProjects(residualProjectIds);
      return res.status(200).json(projects);
    }

    if (req.method === 'POST') {
      const { action, projectRoot, content, name, selectedIds } = req.body;
      const config = loadPromptConfig();
      if (action === 'createCustom') {
        const now = new Date().toISOString();
        const id = `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        config.customPrompts.push({ id, name: String(name || '自定义提示词'), content: typeof content === 'string' ? content : '', createdAt: now, updatedAt: now });
        config.selectedIds = Array.from(new Set([...config.selectedIds, id]));
        savePromptConfig(config);
        return res.status(200).json({ success: true, id });
      }
      if (action === 'select') {
        config.selectedIds = Array.isArray(selectedIds) ? selectedIds.map(String) : [];
        savePromptConfig(config);
        return res.status(200).json({ success: true });
      }
      const root = normalizePath(String(projectRoot || ''));
      if (!root || isInternalResidualProject(root) || !fs.existsSync(root)) return res.status(403).json({ error: 'Invalid project root' });
      const target = path.join(root, 'CUSTOMIZE.md');
      if (action === 'create') {
        if (!fs.existsSync(target)) fs.writeFileSync(target, typeof content === 'string' ? content : '', 'utf-8');
        config.selectedIds = Array.from(new Set([...config.selectedIds, promptIdFromPath(target)]));
        savePromptConfig(config);
        return res.status(200).json({ success: true, customizePath: target, mtime: fs.statSync(target).mtime.toISOString() });
      }
      return res.status(400).json({ error: 'Invalid action' });
    }

    if (req.method === 'PUT') {
      const { filePath, content, name } = req.body;
      if (!filePath || typeof content !== 'string') return res.status(400).json({ error: 'filePath and content required' });
      const idOrPath = String(filePath);
      if (idOrPath.startsWith('custom:')) {
        const config = loadPromptConfig();
        const custom = config.customPrompts.find(item => item.id === idOrPath);
        if (!custom) return res.status(404).json({ error: 'Prompt not found' });
        custom.content = content;
        if (typeof name === 'string' && name.trim()) custom.name = name.trim();
        custom.updatedAt = new Date().toISOString();
        savePromptConfig(config);
        return res.status(200).json({ success: true, mtime: custom.updatedAt });
      }
      const target = normalizePath(idOrPath);
      if (!isAllowedPromptFile(target)) return res.status(403).json({ error: 'Invalid prompt file' });
      const root = path.dirname(target);
      if (!fs.existsSync(root)) return res.status(404).json({ error: 'Project directory not found' });
      fs.writeFileSync(target, content, 'utf-8');
      return res.status(200).json({ success: true, mtime: fs.statSync(target).mtime.toISOString() });
    }

    if (req.method === 'DELETE') {
      const { projectId, filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'filePath required' });
      const idOrPath = String(filePath);
      const config = loadPromptConfig();
      if (idOrPath.startsWith('custom:')) {
        config.customPrompts = config.customPrompts.filter(item => item.id !== idOrPath);
        config.selectedIds = config.selectedIds.filter(id => id !== idOrPath);
        savePromptConfig(config);
        return res.status(200).json({ success: true });
      }
      const target = normalizePath(idOrPath);
      if (!isAllowedPromptFile(target)) return res.status(403).json({ error: 'Invalid prompt file' });
      if (fs.existsSync(target)) fs.unlinkSync(target);
      config.selectedIds = config.selectedIds.filter(id => id !== promptIdFromPath(target));
      savePromptConfig(config);
      if (projectId && projectId !== 'current') {
        const db = openRegistry(false);
        try { db?.prepare('DELETE FROM project_registry WHERE project_id = ?').run(String(projectId)); }
        finally { db?.close(); }
      }
      return res.status(200).json({ success: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) { console.error('[api] prompt', e); res.status(500).json({ error: 'Internal server error' }); }
}
