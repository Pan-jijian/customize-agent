const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const packageRoot = path.resolve(process.argv[2] || process.env.PACKAGE_ROOT || '.');
const installRoot = path.resolve(packageRoot, '..', '..');
const node = process.execPath;
const packageJsonPath = path.join(packageRoot, 'package.json');
const packageJson = fs.existsSync(packageJsonPath) ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) : null;
const serverRoot = packageJson?.name === '@customize-agent/server'
  ? packageRoot
  : path.dirname(require.resolve('@customize-agent/server/package.json', { paths: [packageRoot, installRoot] }));
const nextBin = require.resolve('next/dist/bin/next', { paths: [serverRoot, packageRoot, installRoot] });
const tempRoot = process.env.RUNNER_TEMP || fs.mkdtempSync(path.join(require('os').tmpdir(), 'customize-upload-'));
const home = path.join(tempRoot, 'upload-home');
const projectRoot = path.join(tempRoot, 'upload-project');
const dashboardLog = path.join(tempRoot, 'upload-dashboard.log');
const basePort = 18000 + Math.floor(Math.random() * 1000);
const port = Number(process.env.CUSTOMIZE_UPLOAD_PORT || basePort);
const base = `http://127.0.0.1:${port}`;
const marker = `uploadmatrix${Date.now()}`;

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(projectRoot, { recursive: true, force: true });
fs.rmSync(dashboardLog, { force: true });
fs.mkdirSync(projectRoot, { recursive: true });

function minimalPng() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
}

function minimalPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, ' ')}) Tj ET`;
  const objs = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}\nendstream endobj`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objs) { offsets.push(Buffer.byteLength(out)); out += obj + '\n'; }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer << /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

const text = kind => `${marker} ${kind} searchable content`;
const samples = [
  { name: 'doc-plain.txt', kind: 'document/plaintext', content: text('txt') },
  { name: 'doc-markdown.md', kind: 'document/markdown', content: `# ${text('markdown')}\n` },
  { name: 'doc-pdf.pdf', kind: 'document/pdf', content: minimalPdf(text('pdf')), searchable: false },
  { name: 'sheet-csv.csv', kind: 'spreadsheet/csv', content: `name,value\n${marker},csv\n` },
  { name: 'sheet-tsv.tsv', kind: 'spreadsheet/tsv', content: `name\tvalue\n${marker}\ttsv\n` },
  { name: 'image-svg.svg', kind: 'image/vector', content: `<svg xmlns="http://www.w3.org/2000/svg"><text>${text('svg')}</text></svg>` },
  { name: 'image-png.png', kind: 'image/raster', content: minimalPng(), allowZeroChunks: true },
  { name: 'cad-dxf.dxf', kind: 'cad/autocad', content: `0\nSECTION\n2\nENTITIES\n0\nTEXT\n1\n${text('dxf')}\n0\nENDSEC\n0\nEOF\n` },
  { name: 'cad-step.step', kind: 'cad/step', content: `ISO-10303-21; HEADER; FILE_DESCRIPTION(('${text('step')}'),'2;1'); ENDSEC; DATA; ENDSEC; END-ISO-10303-21;` },
  { name: 'code-js.js', kind: 'code/javascript', content: `export const marker = '${text('javascript')}';\n` },
  { name: 'code-py.py', kind: 'code/python', content: `marker = '${text('python')}'\n` },
  { name: 'data-json.json', kind: 'data/json', content: JSON.stringify({ marker, type: 'json', text: text('json') }) },
  { name: 'data-yaml.yaml', kind: 'data/yaml', content: `marker: ${marker}\ntext: ${text('yaml')}\n` },
  { name: 'web-html.html', kind: 'web/html', content: `<html><body>${text('html')}</body></html>` },
  { name: 'web-css.css', kind: 'web/stylesheet', content: `/* ${text('css')} */\nbody{color:#111}` },
  { name: 'diagram-drawio.drawio', kind: 'diagram/drawio', content: `<mxfile><diagram>${text('drawio')}</diagram></mxfile>`, searchable: false },
  { name: 'diagram-mermaid.mmd', kind: 'diagram/mermaid', content: `graph TD\nA[${text('mermaid')}] --> B` },
];

async function request(method, url, body, timeoutMs = 30000) {
  const init = { method, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = raw; }
  return { status: res.status, json, raw };
}

async function uploadSample(baseUrl, root, sample, uploadId) {
  const form = new FormData();
  form.append('uploadId', uploadId);
  form.append('projectRoot', root);
  form.append('relativePaths', sample.name);
  form.append('batchIndex', '0');
  form.append('totalBatches', '1');
  form.append('startIndex', '1');
  form.append('uploadComplete', '1');
  form.append('fileOffset', '0');
  form.append('files', new Blob([sample.content]), sample.name);
  const res = await fetch(`${baseUrl}/api/kb/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = raw; }
  return { status: res.status, json, raw };
}

async function waitFor(label, fn, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} timeout${last ? `: ${last.message || last}` : ''}`);
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

function indexedDetail(detail, allowZeroChunks = false) {
  const file = detail.json?.file;
  return file && file.status !== 'pending' && Number(file.indexedAt) > 0 && (allowZeroChunks || Number(file.chunkCount) > 0);
}

function searchHasHit(search, relativePath, expectedText) {
  return Array.isArray(search.json?.results) && search.json.results.some(result => {
    const filePath = result.filePath || result.relativePath;
    return filePath === relativePath && (!expectedText || String(result.content || '').includes(expectedText));
  });
}

async function startServer(serverPort, root, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, 'a');
  const child = spawn(node, [nextBin, 'start', '-p', String(serverPort), '-H', '127.0.0.1'], {
    cwd: serverRoot,
    stdio: ['ignore', out, out],
    env: { ...process.env, HOME: home, CUSTOMIZE_AGENT_HOME: home, NODE_ENV: 'production', CUSTOMIZE_PROJECT_ROOT: root, CUSTOMIZE_AGENT_DISABLE_OCR: '1', LOG_LEVEL: 'debug' },
  });
  fs.closeSync(out);
  await waitFor(`dashboard ${serverPort}`, async () => {
    const health = await request('GET', `http://127.0.0.1:${serverPort}/api/health`);
    return health.status < 500 ? true : undefined;
  }, 120000);
  return child;
}

function dumpEnv() {
  console.error('ENV:', {
    NODE_VERSION: process.version,
    packageRoot,
    serverRoot,
    nextBin,
  });
}

const pages = ['/', '/overview', '/knowledge', '/knowledge/files', '/knowledge/manage', '/knowledge/search', '/models', '/prompt', '/settings'];
const apiChecks = [
  { method: 'GET', path: '/api/health' },
  { method: 'GET', path: '/api/config/models' },
  { method: 'GET', path: '/api/config/providers' },
  { method: 'GET', path: '/api/kb/features' },
  { method: 'GET', path: '/api/kb/categories' },
  { method: 'GET', path: '/api/kb/tags' },
  { method: 'GET', path: '/api/kb/files', query: root => `projectRoot=${encodeURIComponent(root)}&limit=10` },
  { method: 'GET', path: '/api/kb/stats', query: root => `projectRoot=${encodeURIComponent(root)}` },
  { method: 'GET', path: '/api/kb/search', query: root => `projectRoot=${encodeURIComponent(root)}&q=${encodeURIComponent(marker)}&limit=5` },
  { method: 'GET', path: '/api/kb/duplicates', query: root => `projectRoot=${encodeURIComponent(root)}` },
  { method: 'GET', path: '/api/kb/operations', query: root => `projectRoot=${encodeURIComponent(root)}` },
  { method: 'GET', path: '/api/prompt' },
  { method: 'GET', path: '/api/system/stats' },
];

async function verifyWebSurface(baseUrl, root, label) {
  for (const page of pages) {
    const res = await request('GET', `${baseUrl}${page}`);
    assert(res.status >= 200 && res.status < 400, `${label} page ${page} failed: ${res.status} ${res.raw.slice(0, 300)}`);
  }
  for (const api of apiChecks) {
    const query = api.query ? `?${api.query(root)}` : '';
    const res = await request(api.method, `${baseUrl}${api.path}${query}`);
    assert(res.status >= 200 && res.status < 300, `${label} api ${api.path} failed: ${res.status} ${res.raw.slice(0, 500)}`);
  }
}

(async () => {
  assert(fs.existsSync(path.join(serverRoot, '.next', 'BUILD_ID')), `dashboard build not found: ${serverRoot}`);

  let dashboardPid;
  try {
    const dashboard = await startServer(port, projectRoot, dashboardLog);
    dashboardPid = dashboard.pid;
    await verifyWebSurface(base, projectRoot, 'direct dashboard');

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const uploadId = `upload-matrix-${i}-${Date.now()}`;
      const res = await uploadSample(base, projectRoot, sample, uploadId);
      assert(res.status === 202 && res.json.success, `${sample.name} upload failed: ${res.status} ${res.raw}`);
      const relativePath = res.json.relativePath;
      assert(relativePath, `${sample.name} missing relativePath`);
      const progress = await request('GET', `${base}/api/kb/upload/progress?id=${encodeURIComponent(uploadId)}`);
      assert(progress.status === 200, `${sample.name} progress failed: ${progress.status} ${progress.raw}`);
      const files = await request('GET', `${base}/api/kb/files?projectRoot=${encodeURIComponent(projectRoot)}&limit=500`);
      assert(files.status === 200, `${sample.name} files failed: ${files.status} ${files.raw}`);
      assert(files.json.files?.some(f => f.relativePath === relativePath), `${sample.name} not listed`);
      const reindex = await request('POST', `${base}/api/kb/files/reindex`, { projectRoot, relativePath });
      assert(reindex.status === 200 || reindex.status === 202, `${sample.name} reindex failed: ${reindex.status} ${reindex.raw}`);
      const detail = await waitFor(`${sample.name} indexed detail`, async () => {
        const current = await request('GET', `${base}/api/kb/files/detail?projectRoot=${encodeURIComponent(projectRoot)}&relativePath=${encodeURIComponent(relativePath)}`);
        if (current.status !== 200) throw new Error(`${sample.name} detail failed: ${current.status} ${current.raw}`);
        if (current.json.file?.relativePath !== relativePath) throw new Error(`${sample.name} detail mismatch`);
        return indexedDetail(current, sample.allowZeroChunks) ? current : undefined;
      }, 120000);
      if (!sample.allowZeroChunks && sample.searchable !== false) {
        const search = await waitFor(`${sample.name} searchable marker`, async () => {
          const current = await request('GET', `${base}/api/kb/search?projectRoot=${encodeURIComponent(projectRoot)}&q=${encodeURIComponent(marker)}&limit=50&vectorWeight=1&rewriteWeight=0&keywordWeight=1`);
          if (current.status !== 200) throw new Error(`${sample.name} search failed: ${current.status} ${current.raw}`);
          return searchHasHit(current, relativePath, marker) ? current : undefined;
        }, 120000);
        assert(searchHasHit(search, relativePath, marker), `${sample.name} search did not include marker hit`);
      }
      console.log('UPLOAD', sample.kind, sample.name, JSON.stringify({ relativePath, chunks: detail.json.file?.chunkCount, vector: res.json.vectorStatus?.status }));
    }

    const incrementalPath = path.join(projectRoot, 'knowledgeBase', '文档资料', 'incremental-local.txt');
    fs.mkdirSync(path.dirname(incrementalPath), { recursive: true });
    fs.writeFileSync(incrementalPath, text('incremental-local'));
    const reindexAll = await request('POST', `${base}/api/kb/reindex`, { projectRoot });
    assert((reindexAll.status === 200 || reindexAll.status === 202) && reindexAll.json.success, `incremental reindex failed: ${reindexAll.status} ${reindexAll.raw}`);
    if (reindexAll.status === 200) assert(Number(reindexAll.json.diff?.newFiles) >= 1, `incremental reindex did not detect new file: ${reindexAll.raw}`);
    const incrementalDetail = await waitFor('incremental indexed detail', async () => {
      const current = await request('GET', `${base}/api/kb/files/detail?projectRoot=${encodeURIComponent(projectRoot)}&relativePath=${encodeURIComponent('文档资料/incremental-local.txt')}`);
      if (current.status !== 200) throw new Error(`incremental detail failed: ${current.status} ${current.raw}`);
      return indexedDetail(current) ? current : undefined;
    }, 120000);
    assert(Number(incrementalDetail.json.file?.chunkCount) > 0, 'incremental file was not parsed/chunked');

    const readyStats = await waitFor('HNSWLib vector index', async () => {
      const stats = await request('GET', `${base}/api/kb/stats?projectRoot=${encodeURIComponent(projectRoot)}`);
      if (stats.status !== 200) throw new Error(`stats ${stats.status} ${stats.raw}`);
      const vector = stats.json.vectorStatus;
      if (vector?.status === 'ready' && Number(vector.indexedChunks) >= Number(stats.json.chunkCount) && Number(stats.json.chunkCount) > 0) return stats.json;
      return undefined;
    }, 180000);
    console.log('UPLOAD_VECTOR_MATRIX_OK', JSON.stringify({ files: samples.length, marker, projectRoot, chunkCount: readyStats.chunkCount, indexedChunks: readyStats.vectorStatus.indexedChunks }));
    process.exitCode = 0;
  } finally {
    if (dashboardPid) { try { process.kill(dashboardPid); } catch {} }
  }
})().catch(error => {
  process.exitCode = 1;
  console.error(error.stack || String(error));
  dumpEnv();
  if (fs.existsSync(dashboardLog)) console.error(fs.readFileSync(dashboardLog, 'utf8'));
}).finally(() => process.exit(process.exitCode ?? 0));
