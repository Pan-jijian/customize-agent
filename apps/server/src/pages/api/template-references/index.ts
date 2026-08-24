import type { NextApiRequest, NextApiResponse } from 'next';
import formidable, { type File as FormidableFile } from 'formidable';
import { addTemplateReference, buildTypeProfiles, deleteTemplateReference, listTemplateReferences, recomputeStaleProfiles, referenceParadigmText, updateTemplateReferenceType, type TemplateReferenceRecord } from '@/services/document-workflow/templateReferenceService';
import { REFERENCE_PROJECT_TYPES, type ReferenceProjectType } from '@/services/document-workflow/referenceQualityProfile';

export const config = {
  api: { bodyParser: false, responseLimit: false },
};

function firstField(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseUpload(req: NextApiRequest): Promise<{ file: FormidableFile; projectType?: string }> {
  const form = formidable({ multiples: false, maxFileSize: 512 * 1024 * 1024, keepExtensions: true, allowEmptyFiles: false });
  return new Promise((resolve, reject) => {
    form.parse(req, (error, fields, files) => {
      if (error) { reject(error); return; }
      const file = Object.values(files).flat().filter(Boolean)[0] as FormidableFile | undefined;
      if (!file) { reject(new Error('未收到文件')); return; }
      resolve({ file, projectType: firstField(fields.projectType) });
    });
  });
}

function asProjectType(value: unknown): ReferenceProjectType | undefined {
  return typeof value === 'string' && (REFERENCE_PROJECT_TYPES as readonly string[]).includes(value) ? value as ReferenceProjectType : undefined;
}

/** 手动读取 JSON 请求体：本接口为上传设置了 bodyParser: false，PATCH 等方法的 JSON body 需自行解析 */
function readJsonBody(req: NextApiRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('无效的 JSON 请求体')); }
    });
    req.on('error', reject);
  });
}

function sanitizeRecord(record: TemplateReferenceRecord): TemplateReferenceRecord {
  return { ...record, filePath: '' };
}

/** 模板参考库 API：GET 列表 / POST 上传（multipart） / DELETE 删除 / PATCH 类型标注 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // 画像口径升级后旧画像自动重算（幂等），保证列表与聚合返回的数据始终是当前口径
    if (req.method === 'GET') await recomputeStaleProfiles();
    if (req.method === 'GET') {
      const { action, projectType } = req.query as { action?: string; projectType?: string };
      if (action === 'paradigms') {
        const type = asProjectType(projectType);
        if (!type) return res.status(400).json({ error: 'Invalid projectType' });
        const paradigm = referenceParadigmText(type);
        return res.status(200).json({ paradigm: paradigm || null });
      }
      if (action === 'typeProfiles') {
        const profiles = buildTypeProfiles();
        return res.status(200).json({ profiles });
      }
      const records = listTemplateReferences();
      return res.status(200).json({ references: records.map(sanitizeRecord) });
    }
    if (req.method === 'POST') {
      const { file, projectType } = await parseUpload(req);
      const extension = file.originalFilename ? `.${file.originalFilename.split('.').pop()?.toLowerCase()}` : '.pdf';
      if (!['.pdf', '.docx', '.doc'].includes(extension)) return res.status(400).json({ error: '仅支持 PDF 与 Word 文档' });
      const record = await addTemplateReference({
        tempFilePath: file.filepath,
        fileName: file.originalFilename || '未命名参考文件',
        projectType: asProjectType(projectType),
      });
      return res.status(200).json({ success: true, reference: sanitizeRecord(record) });
    }
    if (req.method === 'PATCH') {
      const body = (await readJsonBody(req)) as { id?: string; projectType?: unknown } | undefined;
      const id = body?.id;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (typeof body.projectType === 'string') {
        const type = asProjectType(body.projectType);
        if (!type) return res.status(400).json({ error: 'Invalid projectType' });
        const updated = updateTemplateReferenceType(id, type);
        return updated ? res.status(200).json({ success: true, reference: sanitizeRecord(updated) }) : res.status(404).json({ error: 'Reference not found' });
      }
      return res.status(400).json({ error: 'projectType required' });
    }
    if (req.method === 'DELETE') {
      // DELETE 请求体在各运行环境支持不一致，id 走查询参数
      const id = firstField(req.query.id as string | string[] | undefined);
      if (!id) return res.status(400).json({ error: 'id required' });
      return deleteTemplateReference(id) ? res.status(200).json({ success: true }) : res.status(404).json({ error: 'Reference not found' });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[api] template-references', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
}
