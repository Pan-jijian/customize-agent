#!/bin/bash
# 自测轮询：每 60s 查询生成状态，completed/failed 时保存最终结果并退出
DOC_ID="doc-1787733861208-636d1236"
OUT="/tmp/selftest-final-v3.json"
LOG="/tmp/selftest-poll-v3.log"
i=0
while true; do
  i=$((i+1))
  TS=$(date '+%H:%M:%S')
  RESP=$(curl -s "http://localhost:17321/api/documents/generated/${DOC_ID}" 2>/dev/null)
  if [ -z "$RESP" ]; then echo "[$TS] poll#$i 无响应" >> "$LOG"; sleep 60; continue; fi
  STATUS=$(node -e "const j=JSON.parse(process.argv[1]);const d=(j.document||j);console.log(d.status||'?')" "$RESP" 2>/dev/null)
  WORD=$(node -e "const j=JSON.parse(process.argv[1]);const d=(j.document||j);console.log(d.wordCount||0)" "$RESP" 2>/dev/null)
  STAGES=$(node -e "const j=JSON.parse(process.argv[1]);const d=(j.document||j);const s=d.executionStages||[];const tail=s.slice(-2).map(x=>x.roleId+':'+x.status).join(',');console.log(tail)" "$RESP" 2>/dev/null)
  echo "[$TS] poll#$i status=$STATUS wordCount=$WORD stages=$STAGES" >> "$LOG"
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "$RESP" > "$OUT"
    echo "[$TS] DONE status=$STATUS" >> "$LOG"
    exit 0
  fi
  sleep 60
done
