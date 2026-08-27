// 一次性修复：qualityValidation.ts 追加 headingDuplicateIssues（同章同名三级小节重复检测）
// 用 node 脚本而非 SearchReplace：新函数含 \d、\s、\r?\n 等反斜杠转义，避免工具破坏正则
const fs = require('fs');
const file = '/Users/pan/Desktop/codeing/customize-agent/apps/server/src/services/document-workflow/qualityValidation.ts';
const src = fs.readFileSync(file, 'utf8');

// 追加锚点：放在 buildExportGate 之前（该函数是门禁核心，保持文件中部偏前位置）
const anchor = `export function buildExportGate(issues: ValidationIssue[], factsModel: DocumentFactsModel, chapters: DocumentDraftChapter[]): ExportGateResult {`;

const newFunction = `/**
 * 同章内同名三级小节重复检测：主题块/补写链路反复追加同名 H4 小节（真实生成缺陷：1.4 出现 4 个“工程难点分析”、2.14 出现 4 个隐蔽验收主题小节），
 * 归一化去编号/空白后同章重复 ≥2 次给出合并/重命名建议（warning 不阻断，由质量报告引导后续优化）
 */
export function headingDuplicateIssues(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const chapterParts = markdown.split(/^##\\s+/gmu).slice(1);
  for (const part of chapterParts) {
    const lines = part.split(/\\r?\\n/u);
    const chapterTitle = (lines.shift() || '').trim();
    const counts = new Map<string, number>();
    for (const line of lines) {
      const headingMatch = /^####\\s+(.+)$/u.exec(line.trim());
      if (!headingMatch) continue;
      const key = headingMatch[1].replace(/^\\d+(?:\\.\\d+)*\\s*/u, '').replace(/\\s+/gu, '');
      if (key.length < 2) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const [name, count] of counts) {
      if (count < 2) continue;
      issues.push({ level: 'warning', message: \`\${chapterTitle || '某章'} 存在同名小节重复：“\${name}”出现 \${count} 次\`, suggestion: '同主题内容应合并为一个小节；若确为不同方面，请重命名标题以区分内容，避免目录重复堆叠。' });
      if (issues.length >= 6) return issues;
    }
  }
  return issues;
}

`;

const hits = src.split(anchor).length - 1;
if (hits !== 1) { console.error(`锚点命中 ${hits} 处，期望 1`); process.exit(1); }
const out = src.replace(anchor, newFunction + anchor);
// 校验：原文件关键转义完好
for (const probe of ['split(/^##\\s+/gmu)', 'split(/\\r?\\n/u)', 'replace(/^\\d+(?:\\.\\d+)*\\s*/u']) {
  if (!out.includes(probe)) { console.error(`转义校验失败，缺失：${probe}`); process.exit(1); }
}
fs.writeFileSync(file, out);
console.log('完成：headingDuplicateIssues 已追加，转义校验通过');
