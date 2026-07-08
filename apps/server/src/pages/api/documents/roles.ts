import type { NextApiRequest, NextApiResponse } from 'next';
import { deleteDocumentRole, deleteProjectRoleConfig, listDocumentRoles, listProjectRoleConfigs, saveDocumentRole, saveProjectRoleConfig, type DocumentRole, type DocumentRoleType, type ProjectRoleConfig } from '@/services/documentRoleService';

/** 验证并解析角色类型参数 */
function parseType(value: unknown): DocumentRoleType | undefined {
  return value === 'file' || value === 'prompt' ? value : undefined;
}

/**
 * 文档角色 API 处理器
 * GET: 获取所有角色和配置列表
 * POST/PUT: 创建/更新角色或配置
 * DELETE: 删除角色或配置
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') return res.status(200).json({ roles: listDocumentRoles(parseType(req.query.type)), configs: listProjectRoleConfigs() });
    if (req.method === 'POST' || req.method === 'PUT') {
      const mode = req.query.mode === 'config' ? 'config' : 'role';
      if (mode === 'config') {
        const config = req.body as ProjectRoleConfig;
        if (!config?.id || !config.name) return res.status(400).json({ error: 'config id and name required' });
        return res.status(200).json({ config: saveProjectRoleConfig(config), roles: listDocumentRoles(), configs: listProjectRoleConfigs() });
      }
      const role = req.body as DocumentRole;
      if (!role?.id || !role.name || !parseType(role.type)) return res.status(400).json({ error: 'role id, name and type required' });
      return res.status(200).json({ role: saveDocumentRole(role), roles: listDocumentRoles(), configs: listProjectRoleConfigs() });
    }
    if (req.method === 'DELETE') {
      const mode = req.query.mode === 'config' ? 'config' : 'role';
      const id = String(req.query.id || '');
      if (!id) return res.status(400).json({ error: 'id required' });
      if (mode === 'config') {
        deleteProjectRoleConfig(id);
        return res.status(200).json({ success: true, roles: listDocumentRoles(), configs: listProjectRoleConfigs() });
      }
      const type = parseType(req.query.type);
      if (!type) return res.status(400).json({ error: 'type required' });
      deleteDocumentRole(type, id);
      return res.status(200).json({ success: true, roles: listDocumentRoles(), configs: listProjectRoleConfigs() });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) {
    console.error('[api] documents/roles', e);
    res.status(500).json({ error: e instanceof Error ? e.message : 'Internal server error' });
  }
}
