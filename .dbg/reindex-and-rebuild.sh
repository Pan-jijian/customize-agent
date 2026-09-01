#!/bin/bash
# 4.13.0 重索引 → 缓存重建 → gap 过滤验证 组合流程
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
OP_ID="reindex-1788268105366"
BASE="http://localhost:17321"

echo "[$(date +%H:%M:%S)] 轮询重索引任务 $OP_ID"
while true; do
  STATUS=$(curl -s "$BASE/api/kb/operations?projectRoot=$PROJECT_ROOT&limit=20" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for op in d.get('operations', []):
    if op.get('id')=='$OP_ID' or op.get('operationId')=='$OP_ID':
        print(op.get('status','?'), op.get('percent','?'))
        break
" 2>/dev/null)
  echo "[$(date +%H:%M:%S)] reindex status: $STATUS"
  case "$STATUS" in
    success*|completed*|failed*|error*) echo "REINDEX_FINISHED"; break ;;
  esac
  sleep 60
done

echo "[$(date +%H:%M:%S)] 删除旧项目理解缓存，强制全量重建"
rm -rf "$HOME/.customize-agent/projects/3c3f04667c69/project-intelligence/cache.json" \
       "$HOME/.customize-agent/projects/3c3f04667c69/project-intelligence/project-intelligence.json" \
       "$HOME/.customize-agent/projects/3c3f04667c69/project-intelligence/scopes" 2>/dev/null

echo "[$(date +%H:%M:%S)] 触发项目理解缓存重建（同步）"
RESP=$(curl -s -X POST "$BASE/api/kb/intelligence" -H "Content-Type: application/json" -d "{\"projectRoot\":\"$PROJECT_ROOT\"}")
echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
c=d.get('cache') or {}
print('cache version:', c.get('version'), 'createdAt:', c.get('createdAt'), 'facts:', c.get('factCount'), 'intents:', c.get('intentCount'), 'graph:', c.get('graph'))
" 2>/dev/null

echo "[$(date +%H:%M:%S)] 验证 gaps 过滤（评标办法/地质勘察应已移除）"
python3 -c "
import json
d=json.load(open('$HOME/.customize-agent/projects/3c3f04667c69/project-intelligence/project-intelligence.json'))
gaps=d.get('projectGraph',{}).get('gaps',[])
print('total gaps:', len(gaps))
for g in gaps: print(' -', g)
bad=[g for g in gaps if ('评标办法' in g or '地质勘察' in g or '地勘' in g or '土壤氡' in g)]
print('IRRELEVANT_RESIDUAL:', len(bad))
"
echo "ALL_DONE"
