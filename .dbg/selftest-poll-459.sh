#!/bin/bash
# 真实模板自测轮询（4.5.9）：轮询生成状态，completed/failed 时保存结果并退出
DOC_ID="doc-1787799803603-efb05e1d"
BASE="http://127.0.0.1:17321"
OUT="/Users/pan/Desktop/codeing/customize-agent/.dbg/selftest-459-result.json"
LOG="/Users/pan/Desktop/codeing/customize-agent/.dbg/selftest-459-poll.log"
: > "$LOG"
POLL=0
while true; do
  POLL=$((POLL+1))
  BODY=$(curl -s -m 25 "$BASE/api/documents/generated/$DOC_ID?lite=1")
  if [ -z "$BODY" ]; then
    echo "poll#$POLL empty response" >> "$LOG"
    sleep 60
    continue
  fi
  STATUS=$(node -e "try{const j=JSON.parse(process.argv[1]);const d=j.document||j;console.log(d.status||'')}catch(e){console.log('')}" "$BODY" 2>/dev/null)
  echo "poll#$POLL status=[$STATUS]" >> "$LOG"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "$BODY" > "$OUT"
    echo "FINAL status=$STATUS" >> "$LOG"
    exit 0
  fi
  sleep 60
done
