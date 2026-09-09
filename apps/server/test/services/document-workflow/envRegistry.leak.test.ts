/**
 * envRegistry 泄漏单测（治理收敛 · 第 1 期）：
 * 扫描 src 源码中全部 process.env.DOCUMENT_* 引用，断言：
 * 1. 每个引用都已登记进 DOCUMENT_ENV_REGISTRY（removed/merged/managed 任一状态）；
 * 2. 白名单仅含 DOCUMENT_TUNING_PROFILE（C 类收敛后的单入口机制本身）。
 * 防新开关未登记逃逸、防已删开关读取点复活。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_ENV_REGISTRY } from '../../../src/services/document-workflow/envRegistry';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...collectTsFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

/** 从文件内容中提取全部 process.env.DOCUMENT_XXX 名称（含动态索引形态 process.env[name] 的手工登记除外） */
function extractDocumentEnvNames(content: string): string[] {
  const names = new Set<string>();
  const re = /process\.env\.(DOCUMENT_[A-Z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) names.add(match[1]);
  return [...names];
}

describe('envRegistry 泄漏防护', () => {
  it('源码中全部 process.env.DOCUMENT_* 均已登记（无逃逸开关）', () => {
    const registered = new Set(DOCUMENT_ENV_REGISTRY.map(entry => entry.name));
    // DOCUMENT_TUNING_PROFILE 是 C 类收敛后的单入口机制本身，非开关，属白名单
    const whitelist = new Set(['DOCUMENT_TUNING_PROFILE']);
    const unregistered = new Map<string, string[]>();

    for (const file of collectTsFiles(SRC_ROOT)) {
      for (const name of extractDocumentEnvNames(readFileSync(file, 'utf8'))) {
        if (registered.has(name) || whitelist.has(name)) continue;
        if (!unregistered.has(name)) unregistered.set(name, []);
        unregistered.get(name)!.push(file.replace(SRC_ROOT, 'src'));
      }
    }

    expect(unregistered.size).toBe(0);
    if (unregistered.size > 0) {
      const lines = [...unregistered.entries()].map(([name, files]) => `${name}: ${files.join(', ')}`);
      throw new Error(`以下 DOCUMENT_* 未登记到 DOCUMENT_ENV_REGISTRY：\n${lines.join('\n')}`);
    }
  });

  it('removed 开关的读取点未复活（源码不再引用）', () => {
    const removedNames = DOCUMENT_ENV_REGISTRY.filter(entry => entry.status === 'removed').map(entry => entry.name);
    const revived = new Map<string, string[]>();

    for (const file of collectTsFiles(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      for (const name of removedNames) {
        if (content.includes(`process.env.${name}`)) {
          if (!revived.has(name)) revived.set(name, []);
          revived.get(name)!.push(file.replace(SRC_ROOT, 'src'));
        }
      }
    }

    expect(revived.size).toBe(0);
    if (revived.size > 0) {
      const lines = [...revived.entries()].map(([name, files]) => `${name}: ${files.join(', ')}`);
      throw new Error(`以下 removed 开关读取点复活：\n${lines.join('\n')}`);
    }
  });

  it('merged 开关的读取点未复活（源码不再引用独立 env）', () => {
    const mergedNames = DOCUMENT_ENV_REGISTRY.filter(entry => entry.status === 'merged').map(entry => entry.name);
    const revived = new Map<string, string[]>();

    for (const file of collectTsFiles(SRC_ROOT)) {
      const content = readFileSync(file, 'utf8');
      for (const name of mergedNames) {
        if (content.includes(`process.env.${name}`)) {
          if (!revived.has(name)) revived.set(name, []);
          revived.get(name)!.push(file.replace(SRC_ROOT, 'src'));
        }
      }
    }

    expect(revived.size).toBe(0);
    if (revived.size > 0) {
      const lines = [...revived.entries()].map(([name, files]) => `${name}: ${files.join(', ')}`);
      throw new Error(`以下 merged 开关的独立 env 读取点复活：\n${lines.join('\n')}`);
    }
  });

  it('注册表覆盖 63 项且无重名（19 removed + 23 merged + 21 managed）', () => {
    const names = DOCUMENT_ENV_REGISTRY.map(entry => entry.name);
    expect(new Set(names).size).toBe(names.length);
    expect(DOCUMENT_ENV_REGISTRY).toHaveLength(63);
    expect(DOCUMENT_ENV_REGISTRY.filter(entry => entry.status === 'removed')).toHaveLength(19);
    expect(DOCUMENT_ENV_REGISTRY.filter(entry => entry.status === 'merged')).toHaveLength(23);
    expect(DOCUMENT_ENV_REGISTRY.filter(entry => entry.status === 'managed')).toHaveLength(21);
  });
});
