// 提取参考库房建样本的"分部分项/施工方案"章节写法，与生成文档对比
const fs = require('fs');
const { PDFParse } = require('/Users/pan/Desktop/codeing/customize-agent/apps/server/node_modules/pdf-parse');
const HOME = process.env.HOME;
const REFS = `${HOME}/.customize-agent/template-references`;

async function extractText(file) {
  const data = fs.readFileSync(`${REFS}/${file}`);
  const result = await new PDFParse({ data }).getText();
  return result.text;
}

(async () => {
  const targets = [
    ['卫生院', 'files/ref-mt5yj632-2mamzw.pdf'],
    ['产业园', 'files/ref-mt5yj6k6-xv1gnx.pdf'],
  ];
  for (const [label, file] of targets) {
    console.log(`\n########## ${label} (${file}) ##########`);
    const text = await extractText(file);
    // 定位"分部分项/施工方案/主要施工方法"相关标题行
    const lines = text.split(/\n+/u);
    const hits = [];
    lines.forEach((line, i) => {
      if (/分部分项|主要施工方法|施工方案/.test(line) && line.trim().length <= 40) hits.push([i, line.trim()]);
    });
    console.log('章节标题命中:');
    for (const [i, t] of hits.slice(0, 20)) console.log(`  L${i}: ${t}`);
    // 输出第一个"分部分项"章节后的 5000 字
    const first = hits.find(([, t]) => /分部分项/.test(t)) || hits[0];
    if (!first) { console.log('  (无命中)'); continue; }
    const startLine = first[0];
    const excerpt = lines.slice(startLine, startLine + 120).join('\n');
    console.log('\n--- 章节摘录（前 ~6000 字符）---\n');
    console.log(excerpt.slice(0, 6000));
    fs.writeFileSync(`/Users/pan/Desktop/codeing/customize-agent/.dbg/ref-${label}-division.txt`, lines.slice(startLine, startLine + 400).join('\n'));
  }
})().catch(err => { console.error(err); process.exit(1); });
