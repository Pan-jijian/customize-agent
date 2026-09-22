#!/usr/bin/env node
/**
 * 发布后校验：断言「本地版本」确实落在 npm registry 上。
 *
 * 为什么要这一步：`changeset publish` 在本账号下会把发布**转成 staged**（npm 的发布审批，
 * 需要 2FA 批准后才真正落库），却仍以 0 退出、输出 `success packages published successfully`
 * 并打 git tag —— 连续三次（4.55.2 / 4.55.3 / 4.55.4）都是「以为发成功了，其实 registry 上没有」，
 * 直到手动核对才发现。发布链末尾补这一步，把「假成功」变成明确失败。
 *
 * 用法：node scripts/verify-publish.mjs            # 校验全部非私有 workspace 包
 *      node scripts/verify-publish.mjs <pkg> ...  # 只校验指定包
 * 退出码：0=全部已上架；1=有包未上架（含 staged 待批准）
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');

function collectPackages() {
  const found = [];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(root, group);
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(dir, entry.name, 'package.json');
      let manifest;
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { continue; }
      if (!manifest.name || manifest.private) continue;
      found.push({ name: manifest.name, version: manifest.version });
    }
  }
  return found;
}

function publishedVersion(name) {
  try {
    return execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const requested = process.argv.slice(2);
const packages = collectPackages().filter(pkg => requested.length === 0 || requested.includes(pkg.name));
if (packages.length === 0) {
  console.error('[verify-publish] 未找到可校验的包');
  process.exit(1);
}

const pending = [];
for (const pkg of packages) {
  const live = publishedVersion(pkg.name);
  const ok = live === pkg.version;
  console.log(`${ok ? '✅' : '❌'} ${pkg.name.padEnd(30)} 本地 ${pkg.version.padEnd(8)} registry ${live || '(查询失败)'}`);
  if (!ok) pending.push(pkg);
}

if (pending.length > 0) {
  console.error(`\n[verify-publish] ${pending.length} 个包未在 registry 上出现：`);
  for (const pkg of pending) console.error(`  - ${pkg.name}@${pkg.version}`);
  console.error('\n若刚执行过 changeset publish，多半是发布被 npm 转成了 staged（需要 2FA 批准）：');
  console.error('  网页：https://www.npmjs.com/package/<包名> 的 Staged 页签 → Approve');
  console.error('  或终端：npm stage list  →  npm stage approve <stage-id>');
  process.exit(1);
}
console.log('\n[verify-publish] 全部包已上架 ✅');
