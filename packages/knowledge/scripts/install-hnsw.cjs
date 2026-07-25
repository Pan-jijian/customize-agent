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
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status || 1}`);
}

function markerPath(hnswDir) {
  return path.join(hnswDir, 'build', '.customize-agent-hnsw-ok');
}

function findNativeBinding(hnswDir) {
  const candidates = [
    path.join(hnswDir, 'build', 'Release', 'addon.node'),
    path.join(hnswDir, 'prebuilds', `${process.platform}-${process.arch}`, 'node.napi.node'),
  ];
  return candidates.find(candidate => fs.existsSync(candidate));
}

function isMarkerFresh(hnswDir) {
  const marker = markerPath(hnswDir);
  const binding = findNativeBinding(hnswDir);
  if (!fs.existsSync(marker) || !binding) return false;
  const markerStat = fs.statSync(marker);
  const bindingStat = fs.statSync(binding);
  return markerStat.mtimeMs >= bindingStat.mtimeMs;
}

function writeMarker(hnswDir) {
  const marker = markerPath(hnswDir);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, updatedAt: Date.now() }));
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
  let hnswDir;
  try {
    hnswDir = packageDir('hnswlib-node');
  } catch {
    console.log('[hnsw] 未安装可选依赖 hnswlib-node，跳过 native 初始化。');
    process.exit(0);
  }

  if (isMarkerFresh(hnswDir)) {
    try {
      verify(hnswDir);
      console.log('[hnsw] hnswlib-node 已可用，跳过 native rebuild');
      process.exit(0);
    } catch {
      // 标记存在但运行验证失败，继续 rebuild。
    }
  }
  const nodeGypBin = require.resolve('node-gyp/bin/node-gyp.js', { paths: [process.cwd(), __dirname] });
  console.log(`[hnsw] 构建 hnswlib-node native binding: ${hnswDir}`);
  run(process.execPath, [nodeGypBin, 'rebuild'], hnswDir);
  verify(hnswDir);
  writeMarker(hnswDir);
  console.log('[hnsw] hnswlib-node 安装和运行验证通过');
} catch (error) {
  console.warn('[hnsw] hnswlib-node 当前不可用，已跳过可选向量索引 native 初始化，不影响主包安装。');
  console.warn('[hnsw] 如需启用本地向量索引，请安装 native 编译工具链后运行 npm rebuild hnswlib-node 或在源码仓库执行 pnpm doctor:hnsw。');
  if (process.env.CUSTOMIZE_AGENT_HNSW_STRICT === '1') {
    console.warn(error && error.stack ? error.stack : error);
    process.exit(1);
  }
  process.exit(0);
}
