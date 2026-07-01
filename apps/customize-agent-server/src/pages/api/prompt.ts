import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

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
    // GET: 扫描所有项目的 CUSTOMIZE.md
    if (req.method === 'GET') {
      const projects: PromptProject[] = [];
      const registryPath = path.join(os.homedir(), '.customize-agent', 'projects', 'registry.db');

      // 从 registry.db 读取所有已知项目
      if (fs.existsSync(registryPath)) {
        const db = new Database(registryPath, { readonly: true });
        try {
          const rows = db.prepare('SELECT project_id, project_root, project_name FROM project_registry ORDER BY last_opened_at DESC').all() as Array<Record<string, unknown>>;
          for (const row of rows) {
            const root = String(row.project_root);
            const mdPath = path.join(root, 'CUSTOMIZE.md');
            const hasFile = fs.existsSync(mdPath);
            projects.push({
              projectId: String(row.project_id),
              projectRoot: root,
              projectName: String(row.project_name || root.split('/').pop() || root),
              customizePath: mdPath,
              content: hasFile ? fs.readFileSync(mdPath, 'utf-8') : '',
              mtime: hasFile ? fs.statSync(mdPath).mtime.toISOString() : '',
              hasFile,
            });
          }
        } finally { db.close(); }
      }

      // 同时检查当前工作目录
      const cwd = process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd();
      const cwdMdPath = path.join(cwd, 'CUSTOMIZE.md');
      const alreadyInList = projects.some(p => p.projectRoot === cwd);
      if (!alreadyInList && fs.existsSync(cwdMdPath)) {
        projects.push({
          projectId: 'current',
          projectRoot: cwd,
          projectName: cwd.split('/').pop() || cwd,
          customizePath: cwdMdPath,
          content: fs.readFileSync(cwdMdPath, 'utf-8'),
          mtime: fs.statSync(cwdMdPath).mtime.toISOString(),
          hasFile: true,
        });
      }

      return res.status(200).json(projects);
    }

    // PUT: 保存单个 CUSTOMIZE.md
    if (req.method === 'PUT') {
      const { filePath, content } = req.body;
      if (!filePath || typeof content !== 'string') return res.status(400).json({ error: 'filePath and content required' });
      if (!fs.existsSync(path.dirname(filePath))) return res.status(404).json({ error: 'Project directory not found' });
      fs.writeFileSync(filePath, content, 'utf-8');
      return res.status(200).json({ success: true, mtime: fs.statSync(filePath).mtime.toISOString() });
    }

    // DELETE: 删除 CUSTOMIZE.md 文件（内容替换为默认模板）
    if (req.method === 'DELETE') {
      const { filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'filePath required' });
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
      fs.unlinkSync(filePath);
      return res.status(200).json({ success: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
}
