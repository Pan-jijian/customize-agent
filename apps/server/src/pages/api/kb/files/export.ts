import type { NextApiRequest, NextApiResponse } from 'next';
import { getMultiProjectManager, getProjectRoot, listKnowledgeFiles } from '@/services/knowledge/kbService';
import { buildExportZip, exportZipFileName, mergeChunksToReadableText, txtFileNameFor, EXPORT_LIMITS } from '@/services/knowledge/kbExportService';
import { withApiErrorBoundary } from '@/services/common/apiErrorBoundary';

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' }, responseLimit: false },
};

/**
 * 导出已解析内容 API：把选中文件/文件夹在知识库中已解析、分块后的文本导出为 txt。
 * - 单个文件：直接返回一个 .txt
 * - 多个文件/文件夹：打包为 zip，内部保留相对目录结构，每个源文件一个 .txt
 * - 未解析（无分块）的文件跳过，数量通过 X-Export-Skipped 响应头返回
 */
async function kbFilesExportHandler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body as { relativePaths?: unknown; folderPaths?: unknown; projectRoot?: unknown } | undefined;
  const projectRoot = typeof body?.projectRoot === 'string' && body.projectRoot ? body.projectRoot : getProjectRoot();
  if (!projectRoot) return res.status(400).json({ error: 'projectRoot is required' });

  const fileTargets = Array.isArray(body?.relativePaths) ? body.relativePaths.map(String) : [];
  const folderTargets = Array.isArray(body?.folderPaths) ? body.folderPaths.map(String) : [];
  if (fileTargets.length === 0 && folderTargets.length === 0) {
    return res.status(400).json({ error: 'relativePaths or folderPaths is required' });
  }

  // 文件夹展开：前缀匹配其下所有已入库文件（与删除 API 的展开逻辑一致）
  // 注意：prefix 为空（选中根目录）时匹配全部文件
  const listedFiles = listKnowledgeFiles(projectRoot);
  const folderFiles = folderTargets.flatMap(folder => {
    const prefix = folder.replace(/^\/+|\/+$/gu, '');
    return listedFiles
      .filter(file => prefix === '' || file.relativePath === prefix || file.relativePath.startsWith(`${prefix}/`))
      .map(file => file.relativePath);
  });
  // Office 锁文件（~$ 前缀）是 Word 打开文档时的临时文件，内容为乱码，不入导出
  const targets = Array.from(new Set([...fileTargets, ...folderFiles]))
    .filter(relativePath => !/(^|\/)~\$/u.test(relativePath))
    .sort((a, b) => a.localeCompare(b));
  if (targets.length === 0) return res.status(400).json({ error: 'no files matched' });
  if (targets.length > EXPORT_LIMITS.maxFiles) {
    return res.status(400).json({ error: `导出文件数 ${targets.length} 超过上限 ${EXPORT_LIMITS.maxFiles}，请缩小选择范围` });
  }

  const project = await getMultiProjectManager().getProject(projectRoot);
  const entries: Array<{ relativePath: string; text: string }> = [];
  let skipped = 0;
  let totalChars = 0;
  for (const relativePath of targets) {
    const chunks = project.listChunks({ relativePath });
    const text = mergeChunksToReadableText(chunks);
    if (!text) {
      skipped++;
      continue;
    }
    totalChars += text.length;
    if (totalChars > EXPORT_LIMITS.maxTotalChars) {
      return res.status(400).json({ error: '导出文本总量超过上限，请缩小选择范围' });
    }
    entries.push({ relativePath, text });
  }
  if (entries.length === 0) {
    return res.status(400).json({ error: '所选文件没有可导出的解析内容（可能尚未解析完成）' });
  }

  res.setHeader('X-Export-Count', String(entries.length));
  res.setHeader('X-Export-Skipped', String(skipped));

  if (entries.length === 1) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(txtFileNameFor(entries[0]!.relativePath))}`);
    return res.status(200).send(entries[0]!.text);
  }

  const zipBuffer = await buildExportZip(entries);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exportZipFileName())}`);
  return res.status(200).send(zipBuffer);
}

export default withApiErrorBoundary('api/kb/files/export', kbFilesExportHandler);
