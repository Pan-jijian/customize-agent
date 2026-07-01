import * as http from 'node:http';
import * as path from 'node:path';
import { MultiProjectManager } from '../core/multi-project-manager.js';
import { computeProjectId } from '../core/project-id.js';
import { getProjectKbPath } from '../core/project-config.js';
import type { SearchScope } from '../search/federation-search.js';
import { ExternalExtractorRegistry } from '../extraction/external-extractor.js';
import { resolveDashboardMessages, type DashboardLocale, type DashboardMessages } from './dashboard-i18n.js';
import { renderDashboardHtml } from './dashboard-page.js';

export interface DashboardServerOptions {
  projectRoot: string;
  port?: number;
  host?: string;
  locale?: DashboardLocale;
  storageRoot?: string;
}

export interface DashboardServerHandle {
  url: string;
  close(): Promise<void>;
}

export async function startKnowledgeDashboard(options: DashboardServerOptions): Promise<DashboardServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 17321;
  const manager = new MultiProjectManager(options.storageRoot);
  const projectRoot = path.resolve(options.projectRoot);
  const dashboard = resolveDashboardMessages(options.locale);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, manager, projectRoot, dashboard).catch(error => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    url: `http://${host}:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
      await manager.shutdown();
    },
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: MultiProjectManager,
  projectRoot: string,
  dashboard: { locale: DashboardLocale; messages: DashboardMessages },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    const currentDashboard = resolveDashboardMessages(url.searchParams.get('lang') ?? dashboard.locale);
    sendHtml(res, renderDashboardHtml(currentDashboard));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/stats') {
    const project = await manager.getProject(projectRoot);
    const global = await manager.getGlobalKB();
    sendJson(res, 200, {
      project: {
        projectId: project.projectId,
        projectRoot,
        kbPath: project.kbPath,
        ...project.getStats(),
      },
      global: {
        kbPath: global.kbPath,
        ...global.getStats(),
      },
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/projects') {
    sendJson(res, 200, { projects: await manager.listProjects() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/files') {
    const project = await manager.getProject(projectRoot);
    const diff = await project.incrementalIndex();
    sendJson(res, 200, { files: project.listFiles(), sync: diff });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/search') {
    const query = url.searchParams.get('q') ?? '';
    const scope = normalizeScope(url.searchParams.get('scope'));
    const limit = Number(url.searchParams.get('limit') ?? 10);
    if (!query.trim()) {
      sendJson(res, 400, { error: 'Missing query parameter q' });
      return;
    }
    const results = await manager.search(projectRoot, query, { scope, limit });
    sendJson(res, 200, results);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/kb/reindex') {
    const project = await manager.getProject(projectRoot);
    const diff = await project.incrementalIndex();
    sendJson(res, 200, diff);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/kb/files') {
    const body = await readJsonBody<{ sourcePath: string; targetRelativePath?: string }>(req);
    const project = await manager.getProject(projectRoot);
    const diff = await project.addFile(body.sourcePath, body.targetRelativePath);
    if (diff.skippedFiles.length > 0) {
      const reason = diff.skippedFiles.map(item => `${item.file.relativePath}: ${item.reason}`).join('\n');
      sendJson(res, 422, { error: `文件已复制但解析失败，未入库：\n${reason}`, diff });
      return;
    }
    sendJson(res, 200, diff);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/kb/upload') {
    const body = await readJsonBody<{ fileName: string; targetRelativePath?: string; contentBase64: string }>(req);
    const project = await manager.getProject(projectRoot);
    const diff = await project.uploadFile(body.fileName, Buffer.from(body.contentBase64, 'base64'), body.targetRelativePath);
    const uploadedBaseName = path.basename(body.targetRelativePath ?? body.fileName);
    const relevantSkipped = diff.skippedFiles.filter(item => path.basename(item.file.relativePath) === uploadedBaseName);
    if (relevantSkipped.length > 0) {
      const reason = relevantSkipped.map(item => `${item.file.relativePath}: ${item.reason}`).join('\n');
      sendJson(res, 422, { error: `文件上传成功但解析失败，未入库：\n${reason}`, diff });
      return;
    }
    sendJson(res, 200, diff);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/failed-files') {
    const project = await manager.getProject(projectRoot);
    await project.incrementalIndex();
    sendJson(res, 200, { failedFiles: project.listFailedFiles() });
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/kb/failed-files/')) {
    const project = await manager.getProject(projectRoot);
    const diff = await project.incrementalIndex();
    const relativePath = decodeURIComponent(url.pathname.slice('/api/kb/failed-files/'.length));
    sendJson(res, 200, { ok: true, diff, failed: diff.skippedFiles.find(item => item.file.relativePath === relativePath) });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/kb/files/')) {
    const relativePath = decodeURIComponent(url.pathname.slice('/api/kb/files/'.length));
    const project = await manager.getProject(projectRoot);
    await project.removeFile(relativePath);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/kb/tags') {
    const body = await readJsonBody<{ filePath: string; tags: string[] }>(req);
    const project = await manager.getProject(projectRoot);
    project.tagFile(body.filePath, body.tags);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/tags') {
    const project = await manager.getProject(projectRoot);
    sendJson(res, 200, { tags: project.listTags(url.searchParams.get('file') ?? undefined) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/kb/ignore') {
    const body = await readJsonBody<{ pattern: string }>(req);
    const project = await manager.getProject(projectRoot);
    project.addIgnoreRule(body.pattern);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/ignore') {
    const project = await manager.getProject(projectRoot);
    sendJson(res, 200, { rules: project.listIgnoreRules() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/relationships') {
    const project = await manager.getProject(projectRoot);
    sendJson(res, 200, { relationships: project.listRelationships(url.searchParams.get('file') ?? undefined) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/duplicates') {
    sendJson(res, 200, { duplicates: await manager.findCrossProjectDuplicates() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/config') {
    const project = await manager.getProject(projectRoot);
    sendJson(res, 200, {
      projectId: computeProjectId(projectRoot),
      projectRoot,
      kbPath: getProjectKbPath(projectRoot),
      categoryDirs: project.getProjectConfig()?.categoryDirs ?? {},
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/kb/capabilities') {
    sendJson(res, 200, { capabilities: getCapabilities(), externalExtractors: ExternalExtractorRegistry.fromEnvironment().listCapabilities() });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function getCapabilities(): Array<Record<string, unknown>> {
  return [
    { category: 'cad', format: 'autocad/dxf', vectorizable: true, extraction: 'builtin_dxf_layers_blocks_entities_text', builtInTool: true, note: '内置 DXF 高精度结构解析：图层、块、实体类型、标注文本' },
    { category: 'cad', format: 'step/iges', vectorizable: true, extraction: 'builtin_step_iges_products_materials_entities', builtInTool: true, note: '内置 STEP/IGES 结构解析：产品、零件、材料、实体类型、名称属性' },
    { category: 'cad', format: 'mesh/obj/gltf/stl/3mf', vectorizable: true, extraction: 'builtin_mesh_structure_strings', builtInTool: true, note: '内置 Mesh 解析：对象、节点、分组、STL 头信息、3MF 部件字符串' },
    { category: 'cad', format: 'dwg/solidworks/binary_mesh', vectorizable: true, extraction: 'builtin_cad_binary_strings_optional_native', builtInTool: true, note: '内置二进制字符串/标题块提取，可选 native 引擎增强专有格式精度' },
    { category: 'data', format: 'json/jsonl', vectorizable: true, extraction: 'json_paths_values', builtInTool: true },
    { category: 'data', format: 'yaml/graphql/protobuf', vectorizable: true, extraction: 'structured_text', builtInTool: true },
    { category: 'data', format: 'xml/xsd/wsdl', vectorizable: true, extraction: 'element_text_xpath_like', builtInTool: true },
    { category: 'diagram', format: 'drawio/excalidraw', vectorizable: true, extraction: 'nodes_edges_text', builtInTool: true },
    { category: 'diagram', format: 'plantuml/mermaid', vectorizable: true, extraction: 'diagram_source_text', builtInTool: true },
    { category: 'diagram', format: 'visio', vectorizable: true, extraction: 'builtin_visio_adapter_optional_native', builtInTool: true, note: '已纳入正式解析链路；可选 native 引擎增强' },
    { category: 'document', format: 'pdf', vectorizable: true, extraction: 'builtin_pdf_parse_with_ocr_adapter', builtInTool: true, note: '内置 pdf-parse 与 OCR 适配链路，native 命令仅作为增强' },
    { category: 'document', format: 'office/presentation', vectorizable: true, extraction: 'builtin_mammoth_zip_xml', builtInTool: true, note: '内置 mammoth 与 Office XML 解析，native 命令仅作为增强' },
    { category: 'spreadsheet', format: 'excel/opendoc/csv/tsv', vectorizable: true, extraction: 'builtin_xlsx_structured_cells_formulas_merges', builtInTool: true, note: '内置高精度表格解析：工作表、范围、单元格地址、显示值、公式、合并区域、CSV/TSV' },
    { category: 'image', format: 'raster/raw', vectorizable: true, extraction: 'builtin_tesseract_ocr', builtInTool: true, note: '内置 tesseract.js OCR；视觉模型适配器作为增强' },
  ];
}

function normalizeScope(value: string | null): SearchScope {
  return value === 'project' || value === 'global' || value === 'all' ? value : 'all';
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return (raw ? JSON.parse(raw) : {}) as T;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}
