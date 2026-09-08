#!/bin/bash
# P0 验收轮询：doc-1788721126138-a00d8396（续修轮：补主要施工方法章）
ID="doc-1788721126138-a00d8396"
URL="http://localhost:17321/api/documents/generated/$ID"
for i in $(seq 1 120); do
  BODY=$(curl -s "$URL")
  STATUS=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); doc=d.get('document',d); print(doc.get('status','?'))" 2>/dev/null)
  STAGE=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
doc=d.get('document',d)
stages=doc.get('executionStages') or []
running=[s for s in stages if s.get('status')=='running']
print((running[-1].get('message','') if running else 'idle')[:120])
" 2>/dev/null)
  LEN=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); doc=d.get('document',d); print(len(doc.get('markdown') or ''))" 2>/dev/null)
  echo "[$(date +%H:%M:%S)] status=$STATUS stage=$STAGE mdLen=$LEN"
  case "$STATUS" in
    completed|completed_with_issues|failed|aborted)
      echo "TERMINAL: $STATUS"
      echo "$BODY" > /tmp/p0-final.json
      exit 0;;
  esac
  sleep 45
done
echo "TIMEOUT"
echo "$BODY" > /tmp/p0-final.json
