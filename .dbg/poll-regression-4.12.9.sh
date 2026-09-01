#!/bin/bash
# 4.12.9 发布后真实模板生成轮询（合肥师范 tpl-1787950104747）
DOC_ID="${1:-doc-1788163992191-97f78c22}"
URL="http://localhost:17321/api/documents/generated/${DOC_ID}?projectRoot=/Users/pan/Desktop/codeing/customize-agent&lite=1"
LAST=""
for i in $(seq 1 240); do
  RESP=$(curl -s -m 150 "$URL")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin).get('document',{}); print(d.get('status','?'))" 2>/dev/null || echo '?')
  WORD=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin).get('document',{}); print(d.get('wordCount','-'))" 2>/dev/null || echo '-')
  MSG=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('document',{})
stages=d.get('executionStages') or []
lines=[]
for s in stages[-3:]:
    st=s.get('status') or '?'
    msg=(s.get('message') or '')[:80]
    lines.append(f'{st}|{msg}')
print(' || '.join(lines))
" 2>/dev/null || echo '?')
  CUR="$STATUS|$WORD|$MSG"
  if [ "$CUR" != "$LAST" ]; then
    echo "[$(date +%H:%M:%S)] status=$STATUS words=$WORD"
    echo "  $MSG"
    LAST="$CUR"
  fi
  if [ "$STATUS" != "generating" ] && [ -n "$STATUS" ] && [ "$STATUS" != "?" ]; then
    echo "FINAL_STATUS=$STATUS"
    echo "$RESP" > .dbg/regression-4.12.9-final.json
    break
  fi
  sleep 60
done
