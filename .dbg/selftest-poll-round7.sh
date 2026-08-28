#!/bin/bash
# 七度实测轮询（4.8.1：思考策略 L1-L4 + 评分对齐 A1-A4 + 降级 B）
# 验收三组指标：规划失败率 / Review 修复轮次 / 最终评分（含 A4 可落地性、A1 templating、A3 相似度）
DOC_ID="doc-1787852542986-2ae3fe88"
BASE="http://localhost:17321"
LOG="/tmp/round7-poll.log"
echo "POLL START $(date +%H:%M:%S) $DOC_ID" > "$LOG"
i=0
while true; do
  i=$((i+1))
  RESP=$(curl -s -m 30 "$BASE/api/documents/generated/$DOC_ID" 2>/dev/null)
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
    echo "$RESP" > /tmp/round7-final.json
    echo "$(date +%H:%M:%S) DONE $STATUS" >> "$LOG"
    exit 0
  fi
  sleep 90
done
