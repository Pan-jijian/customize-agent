#!/bin/bash
# 六度实测轮询（4.5.17：语义分层治理——术语语义改写/四新成稿结构检查/评分口径）
DOC_ID="$1"
if [ -z "$DOC_ID" ]; then echo "usage: $0 <doc-id>"; exit 1; fi
BASE="http://localhost:17321"
LOG="/tmp/round6-poll.log"
echo "POLL START $(date -u +%Y-%m-%dT%H:%M:%SZ) $DOC_ID" > "$LOG"
i=0
while true; do
  i=$((i+1))
  RESP=$(curl -s -m 20 "$BASE/api/documents/generated/$DOC_ID" 2>/dev/null)
  if [ -z "$RESP" ]; then echo "$(date -u +%H:%M:%SZ) #$i empty" >> "$LOG"; sleep 60; continue; fi
  STATUS=$(node -e "try{const j=JSON.parse(process.argv[1]);const d=j.document||j;console.log(d.status||'?')}catch(e){console.log('parse_err')}" "$RESP" 2>/dev/null)
  TAIL=$(node -e "try{const j=JSON.parse(process.argv[1]);const d=j.document||j;const s=d.executionStages||[];console.log(s.slice(-2).map(x=>(x.roleId||'')+':'+(x.status||'')).join(' | '))}catch(e){console.log('')}" "$RESP" 2>/dev/null)
  echo "$(date -u +%H:%M:%SZ) #$i status=$STATUS $TAIL" >> "$LOG"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "$RESP" > /tmp/round6-final.json
    echo "$(date -u +%H:%M:%SZ) DONE $STATUS" >> "$LOG"
    exit 0
  fi
  sleep 60
done
