#!/bin/bash
# 轮询自测任务 doc-1787753895458-f24989ee（4.5.5 跨章一致性修复第三层：确定性定点修复兜底验收）
DOC_ID="doc-1787753895458-f24989ee"
BASE="http://localhost:17321/api/documents/generated/$DOC_ID"
OUT="/tmp/selftest-456.log"
NODE=/Users/pan/.nvm/versions/node/v26.4.0/bin/node
: > "$OUT"
log() { echo "[$(date +%H:%M:%S)] $1" >> "$OUT"; }

log "START polling $DOC_ID"
for i in $(seq 1 240); do
  R=$(curl -s -m 30 "$BASE")
  if [ -z "$R" ]; then log "poll $i: EMPTY RESPONSE (server down?)"; sleep 90; continue; fi
  PROG=$($NODE -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{
    const j=JSON.parse(d);
    const doc=(j.document||j);
    const stages=(doc.executionStages||[]);
    const recent=stages.slice(-3).map(s=>s.status+':'+String(s.message).slice(0,90));
    console.log(JSON.stringify({status:doc.status,stages:recent,error:doc.error||null}));
  }catch(e){console.log('err:'+e.message)}
})" 2>/dev/null <<< "$R")
  log "poll $i: $PROG"

  STATUS=$($NODE -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const doc=(j.document||j);console.log(doc.status||'unknown')}catch(e){console.log('parse-error')}})" 2>/dev/null <<< "$R")
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    log "FINAL status=$STATUS"
    curl -s -m 60 "$BASE" > /tmp/selftest-456-final.json
    $NODE -e "
const fs=require('fs');
try{
  const j=JSON.parse(fs.readFileSync('/tmp/selftest-456-final.json','utf8'));
  const doc=(j.document||j);
  const md=doc.markdown||'';
  const count=(re)=>(md.match(re)||[]).length;
  console.log('=== ACCEPTANCE 456 ===');
  console.log('status:',doc.status);
  console.log('error:',doc.error||'none');
  const stages=doc.executionStages||[];
  const fixStages=stages.filter(s=>/deterministic|跨章一致性|global-consistency/u.test(String(s.roleId||'')+String(s.message||'')));
  console.log('consistency stages:');
  for(const s of fixStages) console.log(' -',s.status,s.roleId,':',String(s.message).slice(0,100));
  const issues=(doc.validationIssues||[]).filter(i=>/跨章一致性|工序规格冲突/u.test(i.message));
  console.log('cross-chapter residual issues:',issues.length);
  for(const i of issues.slice(0,8)) console.log('   [',i.level,']',i.message.slice(0,110));
  const gate=(doc.exportGate||{});
  const blocking=(gate.blockingIssues||[]).filter(i=>/跨章一致性|工序规格冲突/u.test(i.message));
  console.log('exportGate.passed:',gate.passed,'cross-chapter blocking:',blocking.length);
  for(const b of blocking.slice(0,8)) console.log('   BLOCK:',b.message.slice(0,110));
  console.log('保温层 mentions:',count(/保温层/g),'| 10970 mentions:',count(/10970/g));
  console.log('markdown chars:',md.length);
}catch(e){console.log('ACCEPT ERR:',e.message)}
" >> "$OUT"
    cat "$OUT" | tail -30
    break
  fi
  sleep 90
done
log "DONE polling loop ($i iterations)"
