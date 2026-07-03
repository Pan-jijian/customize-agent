const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const packageRoot = path.resolve(process.argv[2] || process.env.PACKAGE_ROOT || '.');
const installRoot = path.resolve(packageRoot, '..', '..');
const runner = path.join(packageRoot, 'dist', 'bin', process.platform === 'win32' ? 'dashboard-runner.exe' : 'dashboard-runner');
const bundle = path.join(packageRoot, 'dist', 'server-bundle');
const node = process.execPath;
const tempRoot = process.env.RUNNER_TEMP || fs.mkdtempSync(path.join(require('os').tmpdir(), 'customize-upload-'));
const home = path.join(tempRoot, 'upload-home');
const projectRoot = path.join(tempRoot, 'upload-project');
const cliProjectRoot = path.join(tempRoot, 'cli-startup-project');
const chromaDir = path.join(tempRoot, 'chroma');
const dashboardLog = path.join(tempRoot, 'upload-dashboard.log');
const cliLog = path.join(tempRoot, 'cli.log');
const chromaLog = path.join(tempRoot, 'upload-chroma.log');
const basePort = 18000 + Math.floor(Math.random() * 1000);
const port = Number(process.env.CUSTOMIZE_UPLOAD_PORT || basePort);
const cliPort = Number(process.env.CUSTOMIZE_CLI_PORT || (basePort + 2));
const chromaPort = Number(process.env.CUSTOMIZE_CHROMA_PORT || (basePort + 1));
const base = `http://127.0.0.1:${port}`;
const cliBase = `http://127.0.0.1:${cliPort}`;
const chromaBase = `http://127.0.0.1:${chromaPort}`;
const marker = `uploadmatrix${Date.now()}`;

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(projectRoot, { recursive: true, force: true });
fs.rmSync(cliProjectRoot, { recursive: true, force: true });
fs.rmSync(chromaDir, { recursive: true, force: true });
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(path.join(cliProjectRoot, 'knowledgeBase', '文档资料'), { recursive: true });
fs.writeFileSync(path.join(cliProjectRoot, 'knowledgeBase', '文档资料', 'startup-seed.txt'), `${marker} cli-startup-incremental searchable content`);
fs.mkdirSync(chromaDir, { recursive: true });

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

function findChromaCli() {
  const candidates = [
    path.join(packageRoot, 'node_modules', 'chromadb', 'dist', 'cli.mjs'),
    path.join(installRoot, 'node_modules', 'chromadb', 'dist', 'cli.mjs'),
    path.join(process.cwd(), 'node_modules', 'chromadb', 'dist', 'cli.mjs'),
  ];
  return candidates.find(file => fs.existsSync(file));
}

async function request(method, url, body) {
  const init = { method };
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

function assert(ok, message) {
  if (!ok) throw new Error(message);
}

async function chromaCount() {
  const collections = await request('GET', `${chromaBase}/api/v2/tenants/default_tenant/databases/default_database/collections`);
  assert(collections.status === 200, `Chroma collections failed: ${collections.status} ${collections.raw}`);
  let total = 0;
  for (const collection of collections.json) {
    const id = collection.id || collection.name;
    const count = await request('GET', `${chromaBase}/api/v2/tenants/default_tenant/databases/default_database/collections/${encodeURIComponent(id)}/count`);
    if (count.status === 200) total += Number(count.json ?? 0);
  }
  return total;
}

(async () => {
  const chromaCli = findChromaCli();
  assert(chromaCli, 'chromadb CLI not found');
  assert(fs.existsSync(runner), `dashboard runner not found: ${runner}`);
  assert(fs.existsSync(bundle), `server bundle not found: ${bundle}`);

  const chromaOut = fs.openSync(chromaLog, 'a');
  const chroma = spawn(node, [chromaCli, 'run', '--host', '127.0.0.1', '--port', String(chromaPort), '--path', chromaDir], {
    stdio: ['ignore', chromaOut, chromaOut],
    env: { ...process.env, CHROMA_URL: chromaBase },
  });

  let dashboardPid;
  let cliProcess;
  try {
    await waitFor('Chroma heartbeat', async () => {
      const res = await request('GET', `${chromaBase}/api/v2/heartbeat`);
      return res.status === 200;
    });

    const cliBin = path.join(packageRoot, 'dist', 'index.js');
    const cliOut = fs.openSync(cliLog, 'a');
    cliProcess = spawn(node, [cliBin], {
      cwd: cliProjectRoot,
      stdio: ['ignore', cliOut, cliOut],
      env: { ...process.env, HOME: home, CHROMA_URL: chromaBase, CUSTOMIZE_DASHBOARD_PORT: String(cliPort), CUSTOMIZE_AGENT_E2E_DASHBOARD: '1' },
    });
    await waitFor('CLI startup knowledge initialization', () => {
      if (!fs.existsSync(cliLog)) return undefined;
      const log = fs.readFileSync(cliLog, 'utf8');
      return log.includes('Dashboard ready:') ? true : undefined;
    }, 240000);
    const startupVectorCount = await waitFor('CLI startup Chroma vectors', async () => {
      const total = await chromaCount();
      return total > 0 ? total : undefined;
    }, 60000);
    try { fs.closeSync(cliOut); } catch {}
    try { cliProcess.kill(); } catch {}
    await new Promise(resolve => cliProcess.once('exit', resolve));
    cliProcess = undefined;

    const start = spawnSync(runner, [
      'start', '--bundle', bundle, '--target', path.join(home, '.customize-agent', 'server'), '--port', String(port), '--project-root', projectRoot, '--chroma-url', chromaBase, '--node', node, '--log', dashboardLog, '--timeout-ms', '120000'
    ], { encoding: 'utf8', env: { ...process.env, HOME: home, CHROMA_URL: chromaBase } });
    if (start.status !== 0) {
      console.error(start.stdout);
      console.error(start.stderr);
      if (fs.existsSync(dashboardLog)) console.error(fs.readFileSync(dashboardLog, 'utf8'));
      process.exit(start.status || 1);
    }
    dashboardPid = Number(start.stdout.match(/pid=(\d+)/)?.[1]);

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

    const readyStats = await waitFor('Chroma vector index', async () => {
      const stats = await request('GET', `${base}/api/kb/stats?projectRoot=${encodeURIComponent(projectRoot)}`);
      if (stats.status !== 200) throw new Error(`stats ${stats.status} ${stats.raw}`);
      const vector = stats.json.vectorStatus;
      if (vector?.status === 'ready' && Number(vector.indexedChunks) >= Number(stats.json.chunkCount) && Number(stats.json.chunkCount) > 0) return stats.json;
      return undefined;
    }, 180000);
    const count = await waitFor('Chroma collection count', async () => {
      const total = await chromaCount();
      return total >= readyStats.chunkCount ? total : undefined;
    }, 60000);
    console.log('UPLOAD_VECTOR_MATRIX_OK', JSON.stringify({ files: samples.length, marker, projectRoot, startupVectors: startupVectorCount, chunkCount: readyStats.chunkCount, indexedChunks: readyStats.vectorStatus.indexedChunks, chromaCount: count }));
    process.exitCode = 0;
  } finally {
    if (cliProcess) { try { cliProcess.kill(); } catch {} }
    if (dashboardPid) { try { process.kill(dashboardPid); } catch {} }
    try { chroma.kill(); } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000);
      chroma.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    try { fs.closeSync(chromaOut); } catch {}
  }
})().catch(error => {
  console.error(error.stack || String(error));
  if (fs.existsSync(chromaLog)) console.error(fs.readFileSync(chromaLog, 'utf8'));
  if (fs.existsSync(cliLog)) console.error(fs.readFileSync(cliLog, 'utf8'));
  if (fs.existsSync(dashboardLog)) console.error(fs.readFileSync(dashboardLog, 'utf8'));
  process.exit(1);
}).finally(() => process.exit(process.exitCode ?? 0));
