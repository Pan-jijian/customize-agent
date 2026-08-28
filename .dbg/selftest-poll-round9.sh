#!/bin/bash
# 九度实测轮询（4.8.3：Final Gate 补写三段式修复验收）
# 验收重点：任务成败、最终文档重复 H4 标题数、空壳小节数、三段式标签覆盖、三组指标
DOC_ID="${1:?usage: poll.sh DOC_ID}"
BASE="http://localhost:17321"
LOG="/tmp/round9-poll.log"
echo "POLL START $(date +%H:%M:%S) $DOC_ID" > "$LOG"
i=0
while true; do
  i=$((i+1))
  RESP=$(curl -s -m 40 "$BASE/api/documents/generated/$DOC_ID" 2>/dev/null)
  if [ -z "$RESP" ]; then echo "$(date +%H:%M:%S) #$i empty" >> "$LOG"; sleep 90; continue; fi
  SUMMARY=$(node -e "
try{
  const j=JSON.parse(process.argv[1]);
  const d=j.document||j;
  const stages=(d.executionStages||[]).slice(-2).map(x=>(x.roleId||'')+':'+(x.status||'')+':'+String(x.message||'').slice(0,60));
  console.log(JSON.stringify({status:d.status,stages,error:d.error||null}));
}catch(e){console.log('parse_err:'+e.message)}
" "$RESP" 2>/dev/null)
  echo "$(date +%H:%M:%S) #$i $SUMMARY" >> "$LOG"
  STATUS=$(node -e "try{const j=JSON.parse(process.argv[1]);const d=j.document||j;console.log(d.status||'?')}catch(e){console.log('parse_err')}" "$RESP" 2>/dev/null)
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    echo "$RESP" > /tmp/round9-final.json
    echo "$(date +%H:%M:%S) DONE $STATUS" >> "$LOG"
    exit 0
  fi
  sleep 90
done
