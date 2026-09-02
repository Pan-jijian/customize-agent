#!/usr/bin/env node
/**
 * 一次性工具：把 document-workflow/index.ts 的 export * 展开为显式导出清单。
 * 规则与 export * 对齐：不转发 default；同名冲突保留先出现者（打印冲突供人工确认）。
 * 类型（interface/type）单独走 export type，兼容 isolatedModules。
 */
const fs = require('fs');
const path = require('path');

const dir = '/Users/pan/Desktop/codeing/customize-agent/apps/server/src/services/document-workflow';
const indexPath = path.join(dir, 'index.ts');
const lines = fs.readFileSync(indexPath, 'utf-8').split('\n');
const modules = lines
  .map(line => line.match(/^export \* from '(\.\/[^']+)';?/)?.[1])
  .filter(Boolean);

/** 合并多行 export { ... } 块后逐条解析 */
function extractExports(source) {
  const values = []; // { name, viaFrom? }
  const types = [];
  // 先把多行花括号块压成单行，便于逐条匹配
  const flat = source.replace(/export\s*\{[^}]*\}\s*(?:from\s*'[^']*')?;?/gs, m => m.replace(/\s+/g, ' '));
  const stmts = flat.split('\n');
  for (const stmt of stmts) {
    const trimmed = stmt.trim();
    let m = trimmed.match(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var|enum)\s+([A-Za-z0-9_$]+)/);
    if (m) { values.push({ name: m[1] }); continue; }
    m = trimmed.match(/^export\s+(?:abstract\s+class)\s+([A-Za-z0-9_$]+)/);
    if (m) { values.push({ name: m[1] }); continue; }
    m = trimmed.match(/^export\s+(interface|type)\s+([A-Za-z0-9_$]+)/);
    if (m) { types.push({ name: m[2] }); continue; }
    m = trimmed.match(/^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*'([^']*)')?/);
    if (m) {
      const from = m[2];
      const wholeIsType = /^export\s+type/.test(trimmed);
      for (const part of m[1].split(',')) {
        const item = part.trim();
        if (!item) continue;
        const typeMatch = item.match(/^type\s+(.+)$/);
        const target = typeMatch ? typeMatch[1] : item;
        const name = target.split(/\s+as\s+/).pop().trim();
        (wholeIsType || typeMatch ? types : values).push({ name, viaFrom: from });
      }
    }
  }
  return { values, types };
}

const seen = new Map(); // name -> module
const conflicts = [];
const out = ['// 显式导出清单（替代 export *）：依赖关系可见，同名冲突按 export * 语义保留先出现者。', '// 由 scripts/gen-explicit-exports.cjs 生成并经人工确认；新增导出需同步维护本清单。', ''];

for (const mod of modules) {
  const file = path.join(dir, `${mod.slice(2)}.ts`);
  const source = fs.readFileSync(file, 'utf-8');
  const { values, types } = extractExports(source);
  const keptValues = [];
  const keptTypes = [];
  for (const entry of [...values.map(v => ({ ...v, kind: 'value' })), ...types.map(t => ({ ...t, kind: 'type' }))]) {
    if (seen.has(entry.name)) {
      conflicts.push(`${entry.name}: ${seen.get(entry.name)} (先) vs ${mod} (丢弃)`);
      continue;
    }
    seen.set(entry.name, mod);
    (entry.kind === 'type' ? keptTypes : keptValues).push(entry);
  }
  // viaFrom 的符号保持 re-export 形式（穿透到真实来源）
  const directValues = keptValues.filter(v => !v.viaFrom).map(v => v.name);
  const directTypes = keptTypes.filter(t => !t.viaFrom).map(t => t.name);
  const reExports = new Map(); // from -> names
  for (const entry of [...keptValues, ...keptTypes].filter(e => e.viaFrom)) {
    const list = reExports.get(entry.viaFrom) || [];
    list.push(entry.name);
    reExports.set(entry.viaFrom, list);
  }
  if (directValues.length) out.push(`export { ${directValues.join(', ')} } from '${mod}';`);
  if (directTypes.length) out.push(`export type { ${directTypes.join(', ')} } from '${mod}';`);
  for (const [from, names] of reExports) out.push(`export { ${names.join(', ')} } from '${from}'; // 经 ${mod} 透传`);
  out.push('');
}

console.log(out.join('\n'));
console.error('=== 冲突（同名丢弃，与 export * 语义一致） ===');
for (const c of conflicts) console.error(c);
