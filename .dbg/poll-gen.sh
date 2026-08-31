#!/bin/bash
DOC_ID="doc-1788134651149-9854005a"
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
LAST_MSG=""
while true; do
  RESP=$(curl -s "http://localhost:17321/api/documents/generated/${DOC_ID}?projectRoot=${PROJECT_ROOT}&lite=1")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('document',{}).get('status','?'))")
  MSG=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('document',{})
stages=d.get('executionStages') or []
lines=[]
for s in stages[-3:]:
    name=s.get('name') or ''
    st=s.get('state') or ''
    msg=(s.get('message') or '')[:80]
    lines.append(f'{name}:{st}|{msg}')
print(' || '.join(lines))
")
  if [ "$MSG" != "$LAST_MSG" ]; then
    echo "[$(date +%H:%M:%S)] status=$STATUS"
    echo "  $MSG"
    LAST_MSG="$MSG"
  fi
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "FINAL_STATUS=$STATUS"
    break
  fi
  sleep 45
done
