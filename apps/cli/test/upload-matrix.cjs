const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const packageRoot = path.resolve(process.argv[2] || process.env.PACKAGE_ROOT || '.');
const installRoot = path.resolve(packageRoot, '..', '..');
const node = process.execPath;
const serverPackageJson = require.resolve('@customize-agent/server/package.json', { paths: [packageRoot, installRoot] });
const serverRoot = path.dirname(serverPackageJson);
const nextBin = require.resolve('next/dist/bin/next', { paths: [serverRoot, packageRoot, installRoot] });
const tempRoot = process.env.RUNNER_TEMP || fs.mkdtempSync(path.join(require('os').tmpdir(), 'customize-upload-'));
const home = path.join(tempRoot, 'upload-home');
const projectRoot = path.join(tempRoot, 'upload-project');
const cliProjectRoot = path.join(tempRoot, 'cli-startup-project');
const dashboardLog = path.join(tempRoot, 'upload-dashboard.log');
const cliLog = path.join(tempRoot, 'cli.log');
const basePort = 18000 + Math.floor(Math.random() * 1000);
const port = Number(process.env.CUSTOMIZE_UPLOAD_PORT || basePort);
const cliPort = Number(process.env.CUSTOMIZE_CLI_PORT || (basePort + 2));
const base = `http://127.0.0.1:${port}`;
const cliBase = `http://127.0.0.1:${cliPort}`;
const marker = `uploadmatrix${Date.now()}`;

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(projectRoot, { recursive: true, force: true });
fs.rmSync(cliProjectRoot, { recursive: true, force: true });
fs.rmSync(cliLog, { force: true });
fs.rmSync(dashboardLog, { force: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(path.join(cliProjectRoot, 'knowledgeBase', '文档资料'), { recursive: true });
fs.writeFileSync(path.join(cliProjectRoot, 'knowledgeBase', '文档资料', 'startup-seed.txt'), `${marker} cli-startup-incremental searchable content`);

function b64(content) {
  return Buffer.isBuffer(content) ? content.toString('base64') : Buffer.from(content).toString('base64');
}

function zip(entries) {
  const parts = [];
  let offset = 0;
  const central = [];
  function crc32(buf) {
    let crc = ~0;
    for (const byte of buf) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return ~crc >>> 0;
  }
  function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
  function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), nameBuf, data]);
    parts.push(local);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf]));
    offset += local.length;
  }
  const centralBuf = Buffer.concat(central);
  return Buffer.concat([Buffer.concat(parts), centralBuf, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBuf.length), u32(offset), u16(0)]);
}

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
  { name: 'doc-pdf.pdf', kind: 'document/pdf', content: minimalPdf(text('pdf')) },
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
  { name: 'diagram-drawio.drawio', kind: 'diagram/drawio', content: `<mxfile><diagram>${text('drawio')}</diagram></mxfile>` },
  { name: 'diagram-mermaid.mmd', kind: 'diagram/mermaid', content: `graph TD\nA[${text('mermaid')}] --> B` },
  { name: 'archive-zip.zip', kind: 'archive/zip', content: zip([['inside.txt', text('zip')]]) },
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

async function waitForProcessLog(label, child, logPath, predicate, timeoutMs = 120000) {
  let exit;
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  return waitFor(label, () => {
    if (exit) {
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      throw new Error(`${label} process exited ${JSON.stringify(exit)}\n${log}`);
    }
    if (!fs.existsSync(logPath)) return undefined;
    const log = fs.readFileSync(logPath, 'utf8');
    return predicate(log) ? log : undefined;
  }, timeoutMs);
}

function assert(ok, message) {
  if (!ok) throw new Error(message);
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
    CUSTOMIZE_DASHBOARD_PORT: process.env.CUSTOMIZE_DASHBOARD_PORT,
    packageRoot,
    serverRoot,
    nextBin,
    cliBase,
  });
}

const pages = ['/', '/overview', '/knowledge', '/knowledge/files', '/knowledge/manage', '/knowledge/search', '/models', '/prompt', '/settings', '/context/short-term', '/context/long-term'];
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
  { method: 'GET', path: '/api/context' },
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

async function postWithRetry(label, url, body, retries = 6, delayMs = 2000) {
  let last;
  for (let i = 0; i < retries; i++) {
    const res = await request('POST', url, body);
    if (res.status === 200 && res.json?.success) return res;
    last = res;
    console.warn(`${label} attempt ${i + 1} failed: ${res.status} ${res.raw}`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return last ?? request('POST', url, body);
}

(async () => {
  assert(fs.existsSync(path.join(serverRoot, '.next', 'BUILD_ID')), `dashboard build not found: ${serverRoot}`);

  let dashboardPid;
  let cliProcess;
  try {
    const cliBin = path.join(packageRoot, 'dist', 'index.js');
    const cliOut = fs.openSync(cliLog, 'a');
    cliProcess = spawn(node, [cliBin], {
      cwd: cliProjectRoot,
      stdio: ['ignore', cliOut, cliOut],
      env: { ...process.env, HOME: home, CUSTOMIZE_AGENT_HOME: home, CUSTOMIZE_DASHBOARD_PORT: String(cliPort), CUSTOMIZE_AGENT_E2E_DASHBOARD: '1', CUSTOMIZE_AGENT_DISABLE_OCR: '1', CUSTOMIZE_DASHBOARD_START_TIMEOUT_MS: '180000', LOG_LEVEL: 'debug' },
    });
    console.log('CLI startup logs:', { cliLog });
    await waitForProcessLog('CLI startup dashboard', cliProcess, cliLog, log => log.includes(`Dashboard ready: http://localhost:${cliPort}/overview`), 240000);
    await verifyWebSurface(cliBase, cliProjectRoot, 'CLI startup dashboard');
    const startupReindex = await postWithRetry('CLI startup reindex', `${cliBase}/api/kb/reindex`, { projectRoot: cliProjectRoot });
    if (!(startupReindex.status === 200 && startupReindex.json?.success)) {
      console.error('startupReindex failed after retries:', { status: startupReindex.status, json: startupReindex.json, raw: startupReindex.raw });
      dumpEnv();
      throw new Error(`CLI startup reindex failed: ${startupReindex.status} ${startupReindex.raw}`);
    }
    const startupStats = await waitFor('CLI startup knowledge vectors', async () => {
      const stats = await request('GET', `${cliBase}/api/kb/stats?projectRoot=${encodeURIComponent(cliProjectRoot)}`);
      if (stats.status !== 200) return undefined;
      const vector = stats.json.vectorStatus;
      if (Number(stats.json.chunkCount) > 0 && vector?.status === 'ready' && Number(vector.indexedChunks) >= Number(stats.json.chunkCount)) return stats.json;
      return undefined;
    }, 120000);
    const startupVectorCount = startupStats.vectorStatus.indexedChunks;
    try { fs.closeSync(cliOut); } catch {}
    try { cliProcess.kill(); } catch {}
    await new Promise(resolve => cliProcess.once('exit', resolve));
    cliProcess = undefined;

    const dashboard = await startServer(port, projectRoot, dashboardLog);
    dashboardPid = dashboard.pid;
    await verifyWebSurface(base, projectRoot, 'direct dashboard');

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      const uploadId = `upload-matrix-${i}-${Date.now()}`;
      const res = await request('POST', `${base}/api/kb/upload`, { projectRoot, fileName: sample.name, fileData: b64(sample.content), uploadId });
      assert(res.status === 200 && res.json.success, `${sample.name} upload failed: ${res.status} ${res.raw}`);
      const relativePath = res.json.relativePath;
      assert(relativePath, `${sample.name} missing relativePath`);
      const progress = await request('GET', `${base}/api/kb/upload/progress?id=${encodeURIComponent(uploadId)}`);
      assert(progress.status === 200, `${sample.name} progress failed: ${progress.status} ${progress.raw}`);
      const files = await request('GET', `${base}/api/kb/files?projectRoot=${encodeURIComponent(projectRoot)}&limit=500`);
      assert(files.status === 200, `${sample.name} files failed: ${files.status} ${files.raw}`);
      assert(files.json.files?.some(f => f.relativePath === relativePath), `${sample.name} not listed`);
      const detail = await request('GET', `${base}/api/kb/files/detail?projectRoot=${encodeURIComponent(projectRoot)}&relativePath=${encodeURIComponent(relativePath)}`);
      assert(detail.status === 200, `${sample.name} detail failed: ${detail.status} ${detail.raw}`);
      assert(detail.json.file?.relativePath === relativePath, `${sample.name} detail mismatch`);
      if (!sample.allowZeroChunks) assert(detail.json.file?.chunkCount > 0, `${sample.name} was not parsed/chunked`);
      const reindex = await request('POST', `${base}/api/kb/files/reindex`, { projectRoot, relativePath });
      assert(reindex.status === 200, `${sample.name} reindex failed: ${reindex.status} ${reindex.raw}`);
      const search = await request('GET', `${base}/api/kb/search?projectRoot=${encodeURIComponent(projectRoot)}&q=${encodeURIComponent(marker)}&limit=50&vectorWeight=1&rewriteWeight=0&keywordWeight=1`);
      assert(search.status === 200, `${sample.name} search failed: ${search.status} ${search.raw}`);
      console.log('UPLOAD', sample.kind, sample.name, JSON.stringify({ relativePath, chunks: detail.json.file?.chunkCount, vector: res.json.vectorStatus?.status }));
    }

    const incrementalPath = path.join(projectRoot, 'knowledgeBase', '文档资料', 'incremental-local.txt');
    fs.mkdirSync(path.dirname(incrementalPath), { recursive: true });
    fs.writeFileSync(incrementalPath, text('incremental-local'));
    const reindexAll = await request('POST', `${base}/api/kb/reindex`, { projectRoot });
    assert(reindexAll.status === 200 && reindexAll.json.success, `incremental reindex failed: ${reindexAll.status} ${reindexAll.raw}`);
    assert(Number(reindexAll.json.diff?.newFiles) >= 1, `incremental reindex did not detect new file: ${reindexAll.raw}`);
    const incrementalDetail = await request('GET', `${base}/api/kb/files/detail?projectRoot=${encodeURIComponent(projectRoot)}&relativePath=${encodeURIComponent('文档资料/incremental-local.txt')}`);
    assert(incrementalDetail.status === 200, `incremental detail failed: ${incrementalDetail.status} ${incrementalDetail.raw}`);
    assert(Number(incrementalDetail.json.file?.chunkCount) > 0, 'incremental file was not parsed/chunked');

    const readyStats = await waitFor('HNSWLib vector index', async () => {
      const stats = await request('GET', `${base}/api/kb/stats?projectRoot=${encodeURIComponent(projectRoot)}`);
      if (stats.status !== 200) throw new Error(`stats ${stats.status} ${stats.raw}`);
      const vector = stats.json.vectorStatus;
      if (vector?.status === 'ready' && Number(vector.indexedChunks) >= Number(stats.json.chunkCount) && Number(stats.json.chunkCount) > 0) return stats.json;
      return undefined;
    }, 180000);
    console.log('UPLOAD_VECTOR_MATRIX_OK', JSON.stringify({ files: samples.length, marker, projectRoot, startupVectors: startupVectorCount, chunkCount: readyStats.chunkCount, indexedChunks: readyStats.vectorStatus.indexedChunks }));
    process.exitCode = 0;
  } finally {
    if (cliProcess) { try { cliProcess.kill(); } catch {} }
    if (dashboardPid) { try { process.kill(dashboardPid); } catch {} }
  }
})().catch(error => {
  process.exitCode = 1;
  console.error(error.stack || String(error));
  dumpEnv();
  if (fs.existsSync(cliLog)) console.error(fs.readFileSync(cliLog, 'utf8'));
  if (fs.existsSync(dashboardLog)) console.error(fs.readFileSync(dashboardLog, 'utf8'));
}).finally(() => process.exit(process.exitCode ?? 0));
