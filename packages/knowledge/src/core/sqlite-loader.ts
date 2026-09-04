import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

const require = createRequire(import.meta.url);

/**
 * better-sqlite3 加载适配器：远端环境原生绑定可能缺失——
 * ① npm≥11.6 的 allow-scripts 策略阻止 install 脚本；
 * ② prebuild-install 从 GitHub Releases 下载预编译绑定失败（网络受限）；
 * ③ 回退 node-gyp 编译但本机无 Visual Studio Build Tools。
 * 绑定缺失时上传/检索直接报 "Could not locate the bindings file"（实测复现）。
 * 本适配器在首次调用时探测绑定可用性，不可用则从分平台预编译绑定包
 * （@customize-agent/bsqlite3-<platform>-<arch>，随 optionalDependencies 从 npm registry 安装）
 * 补位到 better-sqlite3 构建目录后重试，用户零操作恢复。
 */
let cachedConstructor: typeof BetterSqlite3 | null = null;
let cachedError: Error | null = null;

/** 构造内存库验证绑定可用（better-sqlite3 的 binding 为惰性加载，构造时才解析） */
function probeOk(ctor: typeof BetterSqlite3): boolean {
  try {
    const db = new ctor(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** 平台绑定包名：os/cpu 字段限定，npm 只安装与当前平台匹配的 optionalDependencies */
function platformBindingPackageName(): string {
  return `@customize-agent/bsqlite3-${process.platform}-${process.arch}`;
}

/** 调用平台包的 ensureBinding() 补位绑定；失败（包未安装/ABI 不支持）返回 false */
function tryPlatformBinding(): boolean {
  try {
    const pkg = require(platformBindingPackageName()) as { ensureBinding?: () => string | null } | undefined;
    const restored = pkg?.ensureBinding?.();
    return Boolean(restored);
  } catch {
    return false;
  }
}

/** 加载可用的 better-sqlite3 构造器（模块级缓存；探测与补位仅执行一次） */
export function loadBetterSqlite3(): typeof BetterSqlite3 {
  if (cachedConstructor) return cachedConstructor;
  if (cachedError) throw cachedError;

  try {
    const ctor = require('better-sqlite3') as typeof BetterSqlite3;
    if (probeOk(ctor)) {
      cachedConstructor = ctor;
      return cachedConstructor;
    }
    // 绑定缺失：尝试平台预编译包补位后重试（bindings 包无失败缓存，补位后构造即可命中新绑定）
    if (tryPlatformBinding() && probeOk(ctor)) {
      console.warn('[sqlite] better-sqlite3 原生绑定缺失，已从预编译平台包补位恢复');
      cachedConstructor = ctor;
      return cachedConstructor;
    }
    cachedError = new Error(
      'better-sqlite3 原生绑定不可用且预编译平台包补位失败（当前 Node ABI 无对应预编译产物或包未安装）。' +
        '可尝试执行 npm rebuild better-sqlite3（需要能访问 GitHub 下载预编译，或本机安装编译工具链后从源码编译）。'
    );
  } catch (error) {
    cachedError = error instanceof Error ? error : new Error(String(error));
  }
  throw cachedError;
}

export type SqliteDatabase = InstanceType<typeof BetterSqlite3>;
