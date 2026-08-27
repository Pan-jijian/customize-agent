const fs = require('fs');
const p = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1787757877258-7b543e82.json';
const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
const md = raw.markdown || '';
const lines = md.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (/新工艺|新技术|新材料|新设备|四新/.test(lines[i])) {
    console.log('L' + i + ':', lines[i].trim().slice(0, 120));
  }
}
