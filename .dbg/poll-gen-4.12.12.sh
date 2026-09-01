#!/bin/bash
# 轮询 4.12.12 真实生成验证任务 doc-1788178078389-ee5bdde5（合肥师范模板）
DOC_ID="doc-1788178078389-ee5bdde5"
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
URL="http://127.0.0.1:17321/api/documents/generated/${DOC_ID}?projectRoot=${PROJECT_ROOT}"
for i in $(seq 1 240); do
  RESP=$(curl -s -m 150 "$URL")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('document',{}).get('status','unknown'))" 2>/dev/null)
  WORD=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('document',{}).get('wordCount','-'))" 2>/dev/null)
  MSG=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('document',{}).get('latestMessage',''))" 2>/dev/null | head -c 160)
  echo "[$i] $(date +%H:%M:%S) status=$STATUS words=$WORD | $MSG"
  if [ "$STATUS" != "generating" ] && [ "$STATUS" != "unknown" ] && [ -n "$STATUS" ]; then
    echo "=== DONE: $STATUS ==="
    echo "$RESP" > .dbg/gen-4.12.12-final.json
    exit 0
  fi
  sleep 60
done
echo "=== TIMEOUT ==="
