#!/bin/bash
# 第五轮生成任务轮询：task-1787990334925-62281019 / doc-1787990334925-37976a41
# 每 60 秒检查一次 /api/jobs/[taskId]，状态变化与每次进度快照写入日志
LOG="/Users/pan/Desktop/codeing/customize-agent/.round5-poll.log"
DOC="doc-1787990334925-37976a41"
URL="http://localhost:17321/api/documents/generated/$DOC?lite=1"
: > "$LOG"
PREV=""
for i in $(seq 1 240); do
  NOW=$(date '+%Y-%m-%d %H:%M:%S')
  BODY=$(curl -s --max-time 30 "$URL" 2>/dev/null)
  STATUS=$(printf '%s' "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const doc=j.document;const st=doc?doc.status:(j.status||'unknown');const es=doc&&doc.executionStages||[];const lastMsg=es.length?es[es.length-1].message:'';console.log(st+'|stages='+es.length+'|'+(lastMsg||'').slice(0,120))}catch(e){const m=s.match(/\"status\":\"([^\"]+)\"/);console.log(m?m[1]+'|raw-fallback':'parse-error')}})" 2>/dev/null)
  if [ "$STATUS" != "$PREV" ]; then
    echo "[$NOW] $STATUS" >> "$LOG"
    PREV="$STATUS"
  fi
  case "$STATUS" in
    completed*|completed_with_issues*|warning*|failed*|aborted*)
      echo "[$NOW] FINAL: $STATUS" >> "$LOG"
      printf '%s' "$BODY" | head -c 3000 >> "$LOG"
      echo "" >> "$LOG"
      exit 0
      ;;
  esac
  sleep 60
done
echo "[$(date '+%Y-%m-%d %H:%M:%S')] TIMEOUT after 240 polls (4h)" >> "$LOG"
exit 1
