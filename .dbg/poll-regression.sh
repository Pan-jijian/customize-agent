#!/bin/bash
# 一期验收真实模板回归轮询：并行化改造后首次完整生成
DOC_ID="${1:-doc-1788159804906-f6619609}"
URL="http://localhost:17321/api/documents/generated/${DOC_ID}?projectRoot=/Users/pan/Desktop/codeing/customize-agent&lite=1"
LAST=""
for i in $(seq 1 200); do
  RESP=$(curl -s -m 150 "$URL")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin).get('document',{}); print(d.get('status','?'))" 2>/dev/null || echo '?')
  MSG=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('document',{})
stages=d.get('executionStages') or []
lines=[]
for s in stages[-4:]:
    st=s.get('status') or '?'
    msg=(s.get('message') or '')[:90]
    lines.append(f'{st}|{msg}')
print(' || '.join(lines))
" 2>/dev/null || echo '?')
  CUR="$STATUS|$MSG"
  if [ "$CUR" != "$LAST" ]; then
    echo "[$(date +%H:%M:%S)] status=$STATUS"
    echo "  $MSG"
    LAST="$CUR"
  fi
  if [ "$STATUS" != "generating" ] && [ -n "$STATUS" ] && [ "$STATUS" != "?" ]; then
    echo "FINAL_STATUS=$STATUS"
    echo "$RESP" > .dbg/regression-final.json
    break
  fi
  sleep 45
done
