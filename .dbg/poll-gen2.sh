#!/bin/bash
DOC_ID="${1:-doc-1788139147198-730cd288}"
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
LAST_MSG=""
while true; do
  RESP=$(curl -s "http://localhost:17321/api/documents/generated/${DOC_ID}?projectRoot=${PROJECT_ROOT}&lite=1")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('document',{}).get('status','?'))" 2>/dev/null || echo '?')
  MSG=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('document',{})
stages=d.get('executionStages') or []
lines=[]
for s in stages[-4:]:
    st=s.get('status') or '?'
    msg=(s.get('message') or '')[:100]
    lines.append(f'{st}|{msg}')
print(' || '.join(lines))
" 2>/dev/null || echo '?')
  if [ "$MSG" != "$LAST_MSG" ]; then
    echo "[$(date +%H:%M:%S)] status=$STATUS"
    echo "  $MSG"
    LAST_MSG="$MSG"
  fi
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "FINAL_STATUS=$STATUS"
    break
  fi
  sleep 40
done
