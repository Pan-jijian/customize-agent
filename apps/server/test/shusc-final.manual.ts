/**
 * 舒城压缩稿终稿组装：压缩稿 → 附表区归集 → /tmp/shusc-final.md + 字数统计。
 *
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/shusc-final.manual.ts
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readProjectKbChunkTextsByHints } from '@/services/knowledge/kbService';
import { extractAppendixTables } from '@/services/document-workflow/promptRuleExtraction';
import { appendTenderAppendixSections } from '@/services/document-workflow/composeAppendices';

const PROJECT_ROOT = '/Users/pan/Desktop/codeing/customize-agent';
const SRC = '/tmp/shusc-compressed2.md';
const OUT = '/tmp/shusc-final.md';

/** documentTextLength 生产同口径：去标签后去所有空白字符数 */
function documentTextLength(markdown: string): number {
  return markdown.replace(/<[^>]+>/gu, '').replace(/\s+/gu, '').length;
}

/** 生产同路径：rebuildAndRecompute.resolveAppendixTables 的定向查询分支 */
function resolveAppendixTables(): { titles: string[] } | undefined {
  const hintTexts = readProjectKbChunkTextsByHints(PROJECT_ROOT, ['可附下列图表', '图表及格式要求附后', '附下列图表', '附表六临时用地表'], { limit: 120 });
  if (hintTexts.length > 0) {
    const scanned = extractAppendixTables(hintTexts.join('\n'));
    if (scanned.titles.length >= 2 && scanned.attachedAtEnd) return { titles: scanned.titles };
  }
  return undefined;
}

describe('舒城压缩稿终稿组装', () => {
  it('附表区归集 + 终稿写出', () => {
    if (!fs.existsSync(SRC)) {
      console.log('!! 压缩稿尚未生成:', SRC);
      return;
    }
    const md = fs.readFileSync(SRC, 'utf-8');
    console.log('压缩稿长度(documentTextLength):', documentTextLength(md));
    const appendix = resolveAppendixTables();
    console.log('附表清单:', JSON.stringify(appendix));
    const merged = appendix ? appendTenderAppendixSections(md, appendix) : md;
    fs.writeFileSync(OUT, merged);
    const chars = documentTextLength(merged);
    console.log('=== 终稿 ===');
    console.log('文件:', OUT, 'documentTextLength:', chars);
    const appendixCount = (merged.match(/^## 附表/gmu) || []).length;
    console.log('附表标题数:', appendixCount);
    const h1 = (merged.match(/^# /gmu) || []).length;
    const h3 = (merged.match(/^### /gmu) || []).length;
    const h4 = (merged.match(/^#### /gmu) || []).length;
    console.log('H1:', h1, 'H3:', h3, 'H4:', h4);
    expect(chars).toBeGreaterThan(0);
  });
});
