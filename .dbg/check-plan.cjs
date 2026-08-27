const fs = require('fs');
const p = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1787761928153-5a8b669c.json';
const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
// 1. 检查 executionStages 中目录规划/主题块相关 stage
const stages = raw.executionStages || [];
for (const s of stages) {
  const msg = (s.message || '');
  if (/规划|主题块|目录|Outline|block/i.test(msg) || /分部分项|新工艺|新技/.test(msg)) {
    console.log('STAGE:', s.status, '|', msg.slice(0, 200));
    if (s.details && s.details.length) {
      for (const d of s.details.slice(0, 12)) console.log('   -', String(d).slice(0, 140));
    }
  }
}
