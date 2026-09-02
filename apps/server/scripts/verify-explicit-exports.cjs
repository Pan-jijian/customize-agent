#!/usr/bin/env node
/** 校验：对比 git HEAD 版（export *）与当前版（显式清单）index.ts 的模块导出符号集合是否一致 */
const ts = require('typescript');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const dir = '/Users/pan/Desktop/codeing/customize-agent/apps/server/src/services/document-workflow';
const indexPath = path.join(dir, 'index.ts');
const headContent = execSync('git show HEAD:apps/server/src/services/document-workflow/index.ts', { cwd: '/Users/pan/Desktop/codeing/customize-agent' }).toString();
const headPath = path.join(dir, '.index.head.snapshot.ts');
fs.writeFileSync(headPath, headContent);

function exportsOf(file) {
  const program = ts.createProgram([file], {
    allowJs: true, skipLibCheck: true, noEmit: true, strict: false,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(file);
  const sym = checker.getSymbolAtLocation(sf);
  if (!sym) return [];
  return checker.getExportsOfModule(sym).map(s => s.name).sort();
}

try {
  const before = exportsOf(headPath);
  const after = exportsOf(indexPath);
  const missing = before.filter(name => !after.includes(name));
  const added = after.filter(name => !before.includes(name));
  console.log(`HEAD(export *) 导出 ${before.length} 个符号；当前(显式) 导出 ${after.length} 个符号`);
  console.log(`缺失: ${missing.length}`, missing);
  console.log(`新增: ${added.length}`, added);
  process.exit(missing.length === 0 ? 0 : 1);
} finally {
  fs.rmSync(headPath, { force: true });
}
