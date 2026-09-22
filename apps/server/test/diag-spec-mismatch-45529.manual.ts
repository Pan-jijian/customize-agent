/**
 * 4.55.29 规格错位误报诊断（离线复算，不生成）：用真实 draft 的 markdown + specAuthorityMap
 * 跑 scanSpecLocationMismatchHits，逐条打印命中上下文与权威 placement，定位「真错位 / 对象错绑」。
 * hit 无 replacement 时无偏移量，故另做一次原始正则转储（与检测同构 locationRe）供人工比对真实对象。
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/diag-spec-mismatch-45529.manual.ts
 * 输出：.dbg/diag-spec-mismatch-out.txt
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { scanSpecLocationMismatchHits } from '@/services/document-workflow/documentIntegrityChecks';
import type { SpecAuthorityMap } from '@/services/document-workflow/types';

const PROJECT_ID = process.env.PROJECT_ID ?? '3c3f04667c69';
const DRAFT_DIR = path.join(os.homedir(), '.customize-agent', 'projects', PROJECT_ID, 'generatedDocuments', 'drafts');
const OUT: string[] = [];
const log = (line = '') => OUT.push(line);

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function specTokenPattern(spec: string): RegExp | null {
  if (/^C\d{2,3}$/.test(spec)) return /(?<![A-Za-z0-9])C\d{2,3}(?!\d)/u;
  if (/^M\d/.test(spec)) return /M\d+(?:\.\d+)?/u;
  if (/^P\d{1,2}$/.test(spec)) return /(?<![A-Za-z])P\d{1,2}/u;
  if (/^A\d+(?:\.\d+)?$/.test(spec)) return /A\d+(?:\.\d+)?/u;
  if (/^B\d+(?:\.\d+)?$/.test(spec)) return /B\d+(?:\.\d+)?/u;
  if (/^HRB/.test(spec) || /^HPB/.test(spec)) return /HRB\d{3,4}|HPB\d{3}/u;
  if (/mm$/.test(spec)) return /\d+(?:\.\d+)?\s*mm/u;
  return null;
}

describe('45529 规格错位诊断', () => {
  it('真实 draft 逐条命中上下文', () => {
    const docId = process.env.DOC_ID ?? 'doc-1790104980418-d47a002e';
    const raw = JSON.parse(fs.readFileSync(path.join(DRAFT_DIR, `${docId}.json`), 'utf8')) as {
      markdown?: string;
      draft?: { factsModel?: { specAuthorityMap?: SpecAuthorityMap } };
    };
    const markdown = raw.markdown || '';
    const map = raw.draft?.factsModel?.specAuthorityMap;
    const hits = scanSpecLocationMismatchHits(markdown, map, 999);
    log(`命中数=${hits.length}`);
    for (const hit of hits) {
      log(`\n── ${hit.issue.message}  [severity=${hit.issue.severity}]`);
      log(`   location=${hit.location} replacement=${hit.replacement ? `${hit.replacement.replacement} [${hit.replacement.start},${hit.replacement.end})` : 'none'}`);
    }
    // 反向验证（真实权威映射，非 fixture）：同一对象同一属性写成清单外规格 → 必须仍是 blocker
    const injected = `${markdown}\n承台垫层厚度为200mm，分层浇筑振捣密实。\n砂垫层厚度为200mm，铺设平整。\n`;
    const injectedHits = scanSpecLocationMismatchHits(injected, map, 999);
    log('\n===== 反向验证（真实权威映射 + 注入句）=====');
    for (const hit of injectedHits) {
      log(`  [${hit.issue.severity}] ${hit.issue.message}`);
    }
    log(`  注入后 blocker 数=${injectedHits.filter(hit => hit.issue.severity === 'blocker').length}（期望 1：承台垫层同对象；砂垫层为材质限定 → 不报）`);
    // 原始转储：与检测同构的 locationRe，逐匹配打印真实偏移与上下文（识别命中处真实对象）
    log('\n\n===== 原始 locationRe 转储（含被豁免项，人工识别对象） =====');
    const seen = new Set<string>();
    for (const placements of Object.values(map || {})) {
      if (placements.length < 2) continue;
      for (const placement of placements) {
        const { location, spec } = placement;
        if (!location || !spec || location.length < 2) continue;
        const pattern = specTokenPattern(spec);
        if (!pattern) continue;
        const key = `${location}|${pattern.source}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const authoritySpecs = [...new Set(placements.filter(item => item.location === location).map(item => item.spec))];
        log(`\n### ${location}｜权威 ${authoritySpecs.join('/')}`);
        const locationRe = new RegExp(`${escapeRegexLiteral(location)}[^。；;\n|]{0,40}?(${pattern.source})`, 'gu');
        for (const match of markdown.matchAll(locationRe)) {
          const at = match.index || 0;
          const found = match[1] || '';
          log(`  @${at} found=${found}｜…${markdown.slice(Math.max(0, at - 40), at + match[0].length + 30).replace(/\n/gu, '⏎')}…`);
        }
      }
    }
    const outPath = path.resolve(process.cwd(), '.dbg', 'diag-spec-mismatch-out.txt');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, OUT.join('\n'), 'utf8');
  }, 120_000);
});
