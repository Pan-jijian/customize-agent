#!/bin/bash
# 轮询合肥师范学院项目重新索引进度（reindex-1788262433833）
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
LAST_MSG=""
while true; do
  RESP=$(curl -s "http://localhost:17321/api/kb/reindex?projectRoot=${PROJECT_ROOT}")
  STAGE=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); j=d.get('job') or {}; print(j.get('stage','?'))")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); j=d.get('job') or {}; print(j.get('status','?'))")
  PCT=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); j=d.get('job') or {}; print(j.get('percent','?'))")
  MSG=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); j=d.get('job') or {}; m=j.get('message') or ''; print(m[:120])")
  FP=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); j=d.get('job') or {}; f=j.get('filePath') or ''; print(f[:100])")
  if [ "$MSG" != "$LAST_MSG" ]; then
    echo "[$(date +%H:%M:%S)] stage=$STAGE status=$STATUS pct=$PCT"
    echo "  msg: $MSG"
    [ -n "$FP" ] && echo "  file: $FP"
    LAST_MSG="$MSG"
  fi
  if [ "$STATUS" = "success" ] || [ "$STATUS" = "error" ]; then
    echo "FINAL_STATUS=$STATUS"
    break
  fi
  sleep 20
done
