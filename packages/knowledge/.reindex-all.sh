#!/bin/zsh
# 一次性驱动：对知识库中所有 CAD/表格文件逐个独立进程重索引
# 用法: zsh .reindex-all.sh
export PATH="/Users/pan/.nvm/versions/node/v26.4.0/bin:$PATH"
cd /Users/pan/Desktop/codeing/customize-agent/packages/knowledge

# 从数据库导出待重索引文件列表
node -e "
const db = require('better-sqlite3')('/Users/pan/.customize-agent/projects/3c3f04667c69/kb.db', { readonly: true });
const rows = db.prepare(\"SELECT relative_path FROM kb_index_state WHERE category IN ('cad','spreadsheet') ORDER BY relative_path\").all();
for (const r of rows) console.log(r.relative_path);
db.close();
" > /tmp/reindex-list.txt

TOTAL=$(wc -l < /tmp/reindex-list.txt | tr -d ' ')
echo "待处理: $TOTAL 个文件"
IDX=0
while IFS= read -r rel; do
  [ -z "$rel" ] && continue
  IDX=$((IDX+1))
  node .reindex-one.mjs "$rel" >> /tmp/reindex-one.log 2>&1
done < /tmp/reindex-list.txt

echo "=== 完成 ==="
grep -c "^OK" /tmp/reindex-one.log
grep -c "garbled=[1-9]" /tmp/reindex-one.log
grep "^FAIL" /tmp/reindex-one.log | head -5
