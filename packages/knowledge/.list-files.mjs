import Database from 'better-sqlite3';
const DB = '/Users/pan/.customize-agent/projects/3c3f04667c69/kb.db';
const db = new Database(DB, { readonly: true });
// kb_index_state 表结构
const cols = db.prepare(`PRAGMA table_info(kb_index_state)`).all();
console.log('kb_index_state 列:', cols.map(c => c.name).join(', '));
const files = db.prepare(`SELECT * FROM kb_index_state ORDER BY indexed_at DESC LIMIT 150`).all();
for (const f of files) {
  const m = JSON.parse(f.metadata_json ?? '{}');
  const mode = m.extractionMode ?? '';
  const cov = m.contentCoverage ?? '';
  console.log(`${f.status ?? '?'} | chunks=${f.chunk_count ?? '?'} | ${String(f.indexed_at ?? '').slice(5, 19)} | ${mode} | ${cov} | ${f.relative_path?.slice(0, 90)}`);
}
db.close();
