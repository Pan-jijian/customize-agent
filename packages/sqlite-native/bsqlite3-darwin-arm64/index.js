// better-sqlite3 官方预编译绑定再分发包（源：WiseLibs/better-sqlite3 v12.10.0 GitHub Releases，MIT 许可）
// 用途：npm>=11.6 阻止安装脚本 / prebuild-install 从 GitHub 下载失败 / 无编译工具链时，
// 由 @customize-agent/knowledge 的 sqlite-loader 调用 ensureBinding()，
// 把本包内与当前 Node ABI 匹配的 binding 复制到 better-sqlite3 构建目录，
// 使 better-sqlite3 无需访问 GitHub 或本地编译即可使用（从 npm registry 随依赖安装）。
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '12.10.0';
const SUPPORTED_ABIS = ['127', '137', '141', '147'];

function resolveBetterSqlite3Dir() {
  try {
    return path.dirname(require.resolve('better-sqlite3/package.json'));
  } catch {
    return null;
  }
}

function prebuiltBindingPath() {
  const abi = String(process.versions.modules);
  const candidate = path.join(__dirname, 'prebuilds', 'node-v' + abi, 'better_sqlite3.node');
  return fs.existsSync(candidate) ? candidate : null;
}

function installedBindingPath(sqliteDir) {
  for (const sub of ['Release', 'Debug']) {
    const candidate = path.join(sqliteDir, 'build', sub, 'better_sqlite3.node');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 将匹配当前 Node ABI 的预编译绑定补位到 better-sqlite3 构建目录；返回补位后的绑定路径，失败返回 null */
function ensureBinding() {
  const sqliteDir = resolveBetterSqlite3Dir();
  if (!sqliteDir) return null;
  const existing = installedBindingPath(sqliteDir);
  if (existing) return existing;
  const source = prebuiltBindingPath();
  if (!source) return null;
  const dest = path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    return dest;
  } catch {
    return null;
  }
}

module.exports = { VERSION, SUPPORTED_ABIS, ensureBinding, prebuiltBindingPath };
