const fs = require('fs');
const p = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1787761928153-5a8b669c.json';
const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
// 在 executionStages 全文中找含"分部分项"的 stage details
const stages = raw.executionStages || [];
let found = 0;
for (const s of stages) {
  const blob = JSON.stringify(s);
  if (blob.includes('分部分项') || blob.includes('新工艺') || blob.includes('新技术')) {
    found++;
    console.log('=== STAGE:', s.roleId || s.id || '', '|', (s.message || '').slice(0, 120));
    if (s.details && Array.isArray(s.details)) {
      for (const d of s.details) {
        const str = String(d);
        if (str.includes('分部分项') || str.includes('新工艺') || str.includes('新技术')) console.log('   -', str.slice(0, 160));
      }
    }
  }
}
console.log('found stages:', found);
