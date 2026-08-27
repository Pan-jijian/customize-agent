#!/bin/bash
# 轮询自测任务 doc-1787725337617-ee10428c，每 90s 记录进度，完成后输出验收数据
DOC_ID="doc-1787725337617-ee10428c"
BASE="http://localhost:17321/api/documents/generated/$DOC_ID"
OUT="/tmp/selftest-progress.log"
: > "$OUT"
log() { echo "[$(date +%H:%M:%S)] $1" >> "$OUT"; }

log "START polling $DOC_ID (v2 document wrapper)"
for i in $(seq 1 240); do
  R=$(curl -s -m 30 "$BASE")
  if [ -z "$R" ]; then log "poll $i: EMPTY RESPONSE (server down?)"; sleep 90; continue; fi

  PROG=$(echo "$R" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{
    const j=JSON.parse(d);
    const doc=(j.document||j);
    const stages=(doc.executionStages||[]);
    const recent=stages.slice(-3).map(s=>s.status+':'+String(s.message).slice(0,90));
    console.log(JSON.stringify({status:doc.status,stages:recent,error:doc.error||null,reviewMeta:doc.reviewMetadata?Object.keys(doc.reviewMetadata):null,updatedAt:doc.updatedAt}));
  }catch(e){console.log('err:'+e.message)}
})" 2>/dev/null)
  log "poll $i: $PROG"

  STATUS=$(echo "$R" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const doc=(j.document||j);console.log(doc.status||'unknown')}catch(e){console.log('parse-error')}})" 2>/dev/null)
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    log "FINAL status=$STATUS"
    curl -s -m 60 "$BASE" > /tmp/selftest-final.json
    log "final json saved to /tmp/selftest-final.json"
    break
  fi
  sleep 90
done
log "DONE polling loop ($i iterations)"
