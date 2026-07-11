import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

type RegistryRow = Record<string, unknown>;

const agentHome = path.join(os.homedir(), '.customize-agent');
const registryPath = path.join(agentHome, 'projects', 'registry.db');
const promptConfigPath = path.join(agentHome, 'prompts.json');

/** 规范化路径为绝对路径 */
function normalizePath(value: string): string {
  return path.resolve(value);
}

/** 判断项目根目录是否为内部残留项目（非用户项目，应隐藏） */
function isInternalResidualProject(projectRoot: string): boolean {
  const normalized = normalizePath(projectRoot);
  const homeConfig = normalizePath(path.join(os.homedir(), '.customize-agent'));
  const parts = normalized.split(path.sep);
  if (normalized === path.resolve(path.join(os.homedir(), '.customize-agent', 'demo-project'))) return false;
  return normalized === homeConfig
    || normalized.endsWith(`${path.sep}apps${path.sep}server`)
    || normalized.endsWith(`${path.sep}apps${path.sep}cli`)
    || parts.includes('.customize-agent');
}

/** 打开项目注册表数据库 */
function openRegistry(readonly: boolean) {
  return fs.existsSync(registryPath) ? new Database(registryPath, { readonly }) : null;
}

/** 获取所有允许访问的项目根目录集合（排除内部残留项目） */
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

/** 判断文件路径是否为允许访问的 CUSTOMIZE.md 提示词文件 */
function isAllowedPromptFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (path.basename(normalized) !== 'CUSTOMIZE.md') return false;
  return allowedProjectRoots().has(normalizePath(path.dirname(normalized)));
}

/** 从注册表中清理已不再存在的内部残留项目记录 */
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

interface PromptImportItem {
  name?: string;
  content?: string;
  selected?: boolean;
}

interface PromptExportFile {
  version: 1;
  exportedAt: string;
  prompts: Array<{ name: string; content: string; selected: boolean }>;
}

const BUILT_IN_PROMPT_IDS = new Set<string>();

interface PromptConfig {
  selectedIds: string[];
  customPrompts: Array<{ id: string; name: string; content: string; createdAt: string; updatedAt: string }>;
}

function promptIdFromPath(filePath: string): string {
  return `file:${normalizePath(filePath)}`;
}

/** 从磁盘加载提示词配置文件 */
function loadPromptConfig(): PromptConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(promptConfigPath, 'utf-8')) as Partial<PromptConfig>;
    return {
      selectedIds: Array.isArray(parsed.selectedIds) ? parsed.selectedIds.map(String) : [],
      customPrompts: Array.isArray(parsed.customPrompts) ? parsed.customPrompts as PromptConfig['customPrompts'] : [],
    };
  } catch {
    return { selectedIds: [], customPrompts: [] };
  }
}

/** 将提示词配置保存到磁盘 */
function savePromptConfig(config: PromptConfig): void {
  fs.mkdirSync(path.dirname(promptConfigPath), { recursive: true });
  fs.writeFileSync(promptConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

/** 获取所有有效的提示词 ID 集合（内置 + 自定义） */
function validPromptIds(config: PromptConfig): Set<string> {
  return new Set([...BUILT_IN_PROMPT_IDS, ...config.customPrompts.map(prompt => prompt.id)]);
}

function sanitizePromptName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.slice(0, 120) || '导入提示词';
}

function sanitizePromptContent(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeImportPrompts(value: unknown): PromptImportItem[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { prompts?: unknown }).prompts)
      ? (value as { prompts: unknown[] }).prompts
      : [];
  return raw
    .filter((item): item is PromptImportItem => Boolean(item) && typeof item === 'object')
    .filter(item => Boolean(sanitizePromptContent(item.content).trim()));
}

/** 提示词管理 API：支持内置/项目/自定义提示词的增删改查和选择配置 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const projects: PromptProject[] = [];
      const residualProjectIds: string[] = [];
      const currentRoot = normalizePath(process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd());
      const config = loadPromptConfig();
      const currentPromptId = promptIdFromPath(path.join(currentRoot, 'CUSTOMIZE.md'));
      const selectedIds = fs.existsSync(promptConfigPath) && config.selectedIds.length > 0 ? config.selectedIds : [currentPromptId];
      if (req.query.mode === 'export') {
        const selectedSet = new Set(selectedIds);
        const payload: PromptExportFile = {
          version: 1,
          exportedAt: new Date().toISOString(),
          prompts: config.customPrompts.map(prompt => ({ name: prompt.name, content: prompt.content, selected: selectedSet.has(prompt.id) })),
        };
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="customize-prompts-${new Date().toISOString().slice(0, 10)}.json"`);
        return res.status(200).json(payload);
      }
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
      const { action, projectRoot, content, name, selectedIds, prompts, mode } = req.body;
      const config = loadPromptConfig();
      if (action === 'import' || mode === 'import') {
        const items = normalizeImportPrompts(prompts ?? req.body);
        if (items.length === 0) return res.status(400).json({ error: '没有可导入的提示词' });
        const now = new Date().toISOString();
        const importedIds: string[] = [];
        for (const item of items) {
          const id = `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          config.customPrompts.push({ id, name: sanitizePromptName(item.name), content: sanitizePromptContent(item.content), createdAt: now, updatedAt: now });
          importedIds.push(id);
        }
        const selectedImportedIds = items.map((item, index) => item.selected ? importedIds[index] : undefined).filter(Boolean) as string[];
        if (selectedImportedIds.length > 0) config.selectedIds = Array.from(new Set([...config.selectedIds, ...selectedImportedIds]));
        savePromptConfig(config);
        return res.status(200).json({ success: true, imported: importedIds.length, ids: importedIds });
      }
      if (action === 'createCustom') {
        const now = new Date().toISOString();
        const id = `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        config.customPrompts.push({ id, name: String(name || '自定义提示词').trim() || '自定义提示词', content: typeof content === 'string' ? content : '', createdAt: now, updatedAt: now });
        savePromptConfig(config);
        return res.status(200).json({ success: true, id });
      }
      if (action === 'select') {
        const validIds = validPromptIds(config);
        config.selectedIds = Array.isArray(selectedIds) ? selectedIds.map(String).filter(id => validIds.has(id) || id.startsWith('file:')) : [];
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
      if (BUILT_IN_PROMPT_IDS.has(idOrPath)) return res.status(403).json({ error: 'Built-in prompt cannot be edited' });
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
      if (BUILT_IN_PROMPT_IDS.has(idOrPath)) return res.status(403).json({ error: 'Built-in prompt cannot be deleted' });
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
