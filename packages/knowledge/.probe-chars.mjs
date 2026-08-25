import Database from 'better-sqlite3';
const db = new Database('/Users/pan/.customize-agent/projects/3c3f04667c69/kb.db', { readonly: true });
// 1. XLS foreign 字符
const xls = db.prepare(`SELECT content FROM kb_chunks WHERE relative_path LIKE '%安装工程.xls' AND chunk_index = 68`).get();
if (xls) {
  const foreign = new Set();
  for (const ch of xls.content) {
    if (/\p{Letter}/u.test(ch) && !/[\p{Script=Han}\p{Script=Latin}\p{Script=Greek}]/u.test(ch)) foreign.add(`${ch} U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
  }
  console.log('XLS seq=68 foreign 字符:', [...foreign].join(' '));
}
// 2. PDF latinExt 字符
const pdf = db.prepare(`SELECT content FROM kb_chunks WHERE relative_path LIKE '%招标文件正文.pdf' AND chunk_index = 22`).get();
if (pdf) {
  const ext = new Set();
  for (const ch of pdf.content) {
    if (/[\u00C0-\u00FF]/u.test(ch)) ext.add(`${ch} U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
  }
  console.log('PDF seq=22 Latin-1 扩展字符:', [...ext].join(' '));
}
// 3. 电施_07 中 ¼ 上下文
const cad = db.prepare(`SELECT content FROM kb_chunks WHERE relative_path LIKE '%电施_07%' AND content LIKE '%¼%' LIMIT 3`).all();
for (const row of cad) {
  const idx = row.content.indexOf('¼');
  console.log('电施_07 ¼ 上下文:', row.content.slice(Math.max(0, idx - 30), idx + 30).replace(/\n/g, ' '));
}
db.close();
