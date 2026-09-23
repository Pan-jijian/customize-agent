/**
 * 4.56 L4-1 模板分支**静默交付错误产物**根治锁定。
 *
 * 原实现：`xml.replace(/\{\{content\}\}/gu, contentXml)` 在模板 `document.xml` 无 `{{content}}`
 * 占位符时是**空操作** —— 返回的 docx 是**模板原文**、正文一字不进，且无报错、无响应头、无阶段事件，
 * 交付物与本次生成的文档完全无关却无从察觉。
 * 现口径：无占位符 → **回退标准生成路径**（正文正确、未套模板样式）+ 显式告警（响应头 + 日志）；
 * **绝不以模板原文冒充实交付物**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-core/generatedDocumentService', () => ({
  generatedRoot: '/tmp/export-template-slot/assets',
  getGeneratedDocument: (id: string) => ({
    id,
    title: '测试文档',
    templateId: 'construction-organization-design',
    requirement: '',
    markdown: '# 测试文档\n\n正文。',
    assets: [],
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now(),
    completedAt: Date.now(),
    draft: { chapters: [{ id: 'c1', title: '第一章 工程概况', content: '' }] },
  }),
  updateGeneratedDocument: () => undefined,
}));

const { default: exportHandler } = await import('@/pages/api/documents/export');

interface MockResponse {
  headers: Record<string, string>;
  statusCode: number;
  headersSent: boolean;
  sentBody?: unknown;
  setHeader: (key: string, value: string) => MockResponse;
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
  send: (body: unknown) => MockResponse;
}

function createResponse(): MockResponse {
  const res = { headers: {} as Record<string, string>, statusCode: 0, headersSent: false } as MockResponse;
  res.setHeader = (key, value) => { res.headers[key] = value; return res; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.sentBody = body; return res; };
  res.send = body => { res.sentBody = body; return res; };
  return res;
}

/** 造一个最小 docx 模板（`document.xml` 内含给定正文片段） */
async function writeTemplate(filePath: string, documentXml: string): Promise<void> {
  const zip = new JSZip();
  zip.folder('word')?.file('document.xml', documentXml);
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

const TEMPLATE_BODY = '<w:p><w:r><w:t>模板原文占位段落</w:t></w:r></w:p>';

async function postDocxExport(wordTemplatePath: string) {
  const res = createResponse();
  await exportHandler({
    method: 'POST',
    body: { title: '测试文档', markdown: '# 测试文档\n\n这是本次生成的正文内容。', format: 'docx', projectRoot: '/tmp/export-template-slot', wordTemplatePath },
  } as never, res as never);
  return res;
}

beforeEach(() => {
  process.env.DOCUMENT_EXPORT_PURE_RENDER = 'observe';
});

describe('4.56 L4-1 模板占位符缺失不得静默交付模板原文', () => {
  it('模板无 {{content}} → 回退标准生成路径 + 显式告警；产物**不含**模板原文、**含**正文', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-slot-'));
    const templatePath = path.join(dir, 'no-slot.docx');
    await writeTemplate(templatePath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${TEMPLATE_BODY}</w:body></w:document>`);

    const res = await postDocxExport(templatePath);
    expect(res.statusCode).toBe(200);
    // 告警必须可见（响应头）
    expect(decodeURIComponent(String(res.headers['X-Export-Template-Warning'] || ''))).toContain('{{content}}');
    // 产物正文取自标准路径：含生成正文、不含模板占位原文
    const produced = res.sentBody as Buffer;
    const zip = await JSZip.loadAsync(produced);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('这是本次生成的正文内容');
    expect(xml).not.toContain('模板原文占位段落');
  }, 60_000);

  it('模板含 {{content}} → 正常套模板，不产生告警', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-slot-'));
    const templatePath = path.join(dir, 'with-slot.docx');
    await writeTemplate(templatePath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${TEMPLATE_BODY}{{content}}</w:body></w:document>`);

    const res = await postDocxExport(templatePath);
    expect(res.statusCode).toBe(200);
    expect(res.headers['X-Export-Template-Warning']).toBeUndefined();
    const zip = await JSZip.loadAsync(res.sentBody as Buffer);
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('模板原文占位段落');
    expect(xml).toContain('这是本次生成的正文内容');
  }, 60_000);
});
