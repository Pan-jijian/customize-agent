#!/bin/bash
# 全局评审修复后验收轮询
ID="doc-1788704851993-9bfa7d76"
URL="http://localhost:17321/api/documents/generated/$ID"
for i in $(seq 1 400); do
  BODY=$(curl -s --max-time 120 "$URL")
  STATUS=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); doc=d.get('document',d); print(doc.get('status','?'))" 2>/dev/null)
  STAGE=$(echo "$BODY" | python3 -c "
import json,sys
d=json.load(sys.stdin)
doc=d.get('document',d)
stages=doc.get('executionStages') or []
running=[s for s in stages if s.get('status')=='running']
print((running[-1].get('message','') if running else 'idle')[:130])
" 2>/dev/null)
  LEN=$(echo "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); doc=d.get('document',d); print(len(doc.get('markdown') or ''))" 2>/dev/null)
  echo "[$(date +%H:%M:%S)] status=$STATUS stage=$STAGE mdLen=$LEN"
  case "$STATUS" in
    completed|completed_with_issues|warning|failed|aborted)
      echo "TERMINAL: $STATUS"
      echo "$BODY" > /tmp/audit-final.json
      exit 0;;
  esac
  sleep 60
done
echo "TIMEOUT"
echo "$BODY" > /tmp/audit-final.json
