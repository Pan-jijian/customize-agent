#!/bin/bash
# 4.12.10 回归轮询：监控 doc-1788169317480-d5da1a72 直到完成
# 重点记录 agent-chapter-task 就绪状态（修复验证点：人材机章节）
DOC_ID="doc-1788169317480-d5da1a72"
BASE="http://127.0.0.1:17321"
OUT="/Users/pan/Desktop/codeing/customize-agent/.dbg/regression-4.12.11-final.json"
LOG="/Users/pan/Desktop/codeing/customize-agent/.dbg/regression-4.12.11-poll.log"
: > "$LOG"
while true; do
  RESP=$(curl -s "$BASE/api/documents/generated/$DOC_ID?lite=1")
  STATUS=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)['document']
print(d.get('status'))
" 2>/dev/null)
  echo "[$(date +%H:%M:%S)] status=$STATUS" >> "$LOG"
  echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)['document']
for s in d.get('executionStages',[]):
    rid=s.get('roleId','')
    if rid.startswith('agent-chapter-task'):
        print('   ', s.get('status'), rid, '|', s.get('message','')[:70], '|', (s.get('details') or [])[:2])
" >> "$LOG" 2>/dev/null
  if [ "$STATUS" != "generating" ]; then
    echo "$RESP" > "$OUT"
    echo "[$(date +%H:%M:%S)] DONE status=$STATUS" >> "$LOG"
    echo "DONE status=$STATUS"
    exit 0
  fi
  sleep 60
done
