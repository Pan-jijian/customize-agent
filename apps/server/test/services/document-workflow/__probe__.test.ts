import fs from 'node:fs';
import { describe, it } from 'vitest';
import { atlasReferencePhraseHits } from '@/services/document-workflow/helpers/markdownCleanup';
import { sourcePhraseIssues } from '@/services/document-workflow/markdownComposer';
import { finishThicknessIssues, formulaResidueIssues, metaDiscourseDeclarationIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { scanStructureDefects } from '@/services/document-workflow/structureIntegrityRules';

const DRAFT = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1790144107028-aaba7ba3.json';

describe('probe', () => {
  it('runs detectors on real draft', () => {
    const raw = JSON.parse(fs.readFileSync(DRAFT, 'utf8')) as { markdown?: string };
    const markdown = raw.markdown || '';
    fs.writeFileSync('/tmp/probe.md', markdown);
    console.log('=== ATLAS ===');
    const atlas = atlasReferencePhraseHits(markdown);
    console.log('atlas hits:', atlas.length);
    console.log(JSON.stringify(atlas.slice(0, 20), null, 1));

    console.log('=== SOURCE ===');
    const src = sourcePhraseIssues(markdown);
    console.log('source hits:', src.length);
    src.forEach(issue => console.log('  -', issue.message));
    // 逐行重扫取样本
    const lines = markdown.split(/\r?\n/u);
    const re = /(?<=^|[。；;\n])(?:本方案|本施工组织设计|本工程|本项目|项目部|我方|我公司|投标人)?(?:根据|依据|结合|按照)?(?:本项目|项目)?(?:招标文件|补疑澄清文件|补遗澄清文件|补疑补遗|答疑(?:回复)?文件|答疑修正口径|补充答疑修正口径|澄清文件|工程量清单|设计图纸|施工图纸|图纸资料|设计修改通知单)(?:[、,，及和与\s]*(?:招标文件|补疑澄清文件|补遗澄清文件|补疑补遗|答疑(?:回复)?文件|答疑修正口径|补充答疑修正口径|澄清文件|工程量清单|设计图纸|施工图纸|图纸资料|设计修改通知单|现行规范|规范)){1,}(?:[^。；;\n]{0,40})?[，,]/gmu;
    lines.forEach((line, i) => { const m = line.match(re); if (m) console.log(`  L${i + 1}: ${JSON.stringify(m.slice(0, 3))} | ${line.trim().slice(0, 100)}`); });

    console.log('=== META ===');
    const meta = metaDiscourseDeclarationIssues(markdown);
    console.log('meta issues:', meta.length);
    meta.forEach(issue => console.log('  -', issue.message));
    const metaRe = /不再另行(?:出现|统计|编制|设置|单列|重复)[^。；;\u000A]{0,40}|以[^。；;\u000A]{0,16}为唯一[^。；;\u000A]{0,24}不再[^。；;\u000A]{0,20}|不再另行[^。；;\u000A]{0,24}/gu;
    for (const m of markdown.matchAll(metaRe)) console.log('  meta:', JSON.stringify(m[0]));

    console.log('=== FINISH ===');
    const fin = finishThicknessIssues(markdown);
    console.log('finish issues:', fin.length);
    fin.forEach(issue => console.log('  -', issue.message));

    console.log('=== FORMULA ===');
    const fml = formulaResidueIssues(markdown);
    console.log('formula issues:', fml.length);
    fml.forEach(issue => console.log('  -', issue.message));
    const fmlRe = /(?:[Pp]\s*=\s*[^。；;\n]{0,60}(?:Σ|cosφ|[Kk][12])|[qQ]\s*=\s*[^。；;\n]{0,40}|Σ\s*P|cos\s*φ|[Kk][12]\s*[×*]\s*Σ|[Kk][12]\s*Σ\s*P)/gu;
    for (const m of markdown.matchAll(fmlRe)) console.log('  formula:', JSON.stringify(m[0]));

    console.log('=== STRUCTURE (truncated) ===');
    const scan = scanStructureDefects(markdown);
    console.log('cleanable:', scan.cleanable.length, 'blocking:', scan.blocking.length);
    const trunc = scan.blocking.filter(d => d.kind === 'truncated-line');
    console.log('truncated-line:', trunc.length);
    trunc.forEach(d => console.log(`  L${d.line}: ${JSON.stringify(d.excerpt)}`));
    console.log('--- other blocking kinds ---');
    const byKind = new Map<string, number>();
    for (const d of scan.blocking) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);
    console.log([...byKind.entries()].map(([k, v]) => `${k}=${v}`).join(', '));
    const byKindC = new Map<string, number>();
    for (const d of scan.cleanable) byKindC.set(d.kind, (byKindC.get(d.kind) ?? 0) + 1);
    console.log([...byKindC.entries()].map(([k, v]) => `${k}=${v}`).join(', '));
  });
});
