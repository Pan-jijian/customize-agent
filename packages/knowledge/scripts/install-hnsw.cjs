#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function packageDir(name) {
  return path.dirname(require.resolve(`${name}/package.json`, { paths: [process.cwd(), __dirname] }));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.status !== 0) process.exit(result.status || 1);
}

function verify(hnswDir) {
  const hnsw = require(path.join(hnswDir, 'lib/index.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hnsw-doctor-'));
  try {
    const indexPath = path.join(dir, 'index.bin');
    const index = new hnsw.HierarchicalNSW('cosine', 2);
    index.initIndex(10, 16, 200, 100, true);
    index.addPoint([1, 0], 1);
    index.addPoint([0, 1], 2);
    const result = index.searchKnn([1, 0], 1);
    index.writeIndexSync(indexPath);
    const loaded = new hnsw.HierarchicalNSW('cosine', 2);
    loaded.readIndexSync(indexPath, true);
    const loadedResult = loaded.searchKnn([1, 0], 1);
    if (result.neighbors[0] !== 1 || loadedResult.neighbors[0] !== 1) throw new Error('HNSW 检索验证失败');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const hnswDir = packageDir('hnswlib-node');
  const nodeGypBin = require.resolve('node-gyp/bin/node-gyp.js', { paths: [process.cwd(), __dirname] });
  console.log(`[hnsw] 构建 hnswlib-node native binding: ${hnswDir}`);
  run(process.execPath, [nodeGypBin, 'rebuild'], hnswDir);
  verify(hnswDir);
  console.log('[hnsw] hnswlib-node 安装和运行验证通过');
} catch (error) {
  console.error('[hnsw] hnswlib-node 安装或运行验证失败。请确认当前平台已安装 native 编译工具链。');
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
