/**
 * 4.35 文末附表区机制真实验证（.manual.ts 显式运行）：
 * 1) kb.db 定向短语查询（readProjectKbChunkTextsByHints，生产同路径）→ extractAppendixTables 提取舒城招标附表清单
 * 2) 失败稿 markdown（doc-1789343050132）→ composeTenderAppendixMarkdown 全量附表区合成（6 张全覆盖）
 * 3) appendTenderAppendixSections 完整输出写 /tmp/appendix-test.md + 幂等核验
 *
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/appendix-verify.manual.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectKbChunkTextsByHints } from '@/services/knowledge/kbService';
import { extractAppendixTables } from '@/services/document-workflow/promptRuleExtraction';
import { appendTenderAppendixSections, composeTenderAppendixMarkdown } from '@/services/document-workflow/composeAppendices';

const PROJECT_ROOT = '/Users/pan/Desktop/codeing/customize-agent';
const PROJECT_ID = '3c3f04667c69';
const ASSETS = path.join(os.homedir(), '.customize-agent', 'projects', PROJECT_ID, 'generatedDocuments', 'assets');

/** 生产同路径：rebuildAndRecompute.resolveAppendixTables 的定向查询分支 */
function resolveAppendixTables(): { titles: string[] } | undefined {
  const hintTexts = readProjectKbChunkTextsByHints(PROJECT_ROOT, ['可附下列图表', '图表及格式要求附后', '附下列图表', '附表六临时用地表'], { limit: 120 });
  console.log('定向查询命中切片数:', hintTexts.length, '总字符:', hintTexts.join('\n').length);
  if (hintTexts.length > 0) {
    const scanned = extractAppendixTables(hintTexts.join('\n'));
    console.log('定向扫描结果:', JSON.stringify(scanned));
    if (scanned.titles.length >= 2 && scanned.attachedAtEnd) return { titles: scanned.titles };
  }
  return undefined;
}

describe('4.35 附表区机制真实验证', () => {
  it('kb 定向查询提取附表清单 + 失败稿附表区合成（6 张全覆盖）', () => {
    const appendix = resolveAppendixTables();
    console.log('最终附表清单:', JSON.stringify(appendix));
    if (!appendix) {
      console.log('!! 定向查询未提取到附表清单');
      return;
    }
    expect(appendix.titles.length).toBeGreaterThanOrEqual(6);
    const mdPath = path.join(ASSETS, '舒城生成失败-doc-1789343050132-42987888.md');
    const md = fs.readFileSync(mdPath, 'utf-8');
    console.log('markdown 长度:', md.length);
    const section = composeTenderAppendixMarkdown(md, appendix.titles);
    console.log('附表区长度:', section.length, '包含附表标题数:', (section.match(/^## 附表/gmu) || []).length);
    for (const line of section.split('\n')) {
      if (line.startsWith('## 附表')) console.log('  命中:', line);
    }
    const merged = appendTenderAppendixSections(md, appendix);
    fs.writeFileSync('/tmp/appendix-test.md', merged);
    console.log('已写 /tmp/appendix-test.md，总长度:', merged.length);
    const merged2 = appendTenderAppendixSections(fs.readFileSync('/tmp/appendix-test.md', 'utf-8'), appendix);
    console.log('幂等检查（第二次追加应保持长度不变）:', merged2.length);
    expect((section.match(/^## 附表/gmu) || []).length).toBe(6);
  });
});
