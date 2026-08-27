#!/bin/bash
# 轮询自测任务 doc-1787744749903-0f507f47，每 90s 记录进度，完成后输出验收数据
DOC_ID="doc-1787744749903-0f507f47"
BASE="http://localhost:17321/api/documents/generated/$DOC_ID"
OUT="/tmp/selftest-454.log"
: > "$OUT"
log() { echo "[$(date +%H:%M:%S)] $1" >> "$OUT"; }

log "START polling $DOC_ID"
for i in $(seq 1 240); do
  R=$(curl -s -m 30 "$BASE")
  if [ -z "$R" ]; then log "poll $i: EMPTY RESPONSE (server down?)"; sleep 90; continue; fi

  PROG=$(echo "$R" | /Users/pan/.nvm/versions/node/v26.4.0/bin/node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try{
    const j=JSON.parse(d);
    const doc=(j.document||j);
    const stages=(doc.executionStages||[]);
    const recent=stages.slice(-3).map(s=>s.status+':'+String(s.message).slice(0,80));
    console.log(JSON.stringify({status:doc.status,stages:recent,error:doc.error||null}));
  }catch(e){console.log('err:'+e.message)}
})" 2>/dev/null)
  log "poll $i: $PROG"

  STATUS=$(echo "$R" | /Users/pan/.nvm/versions/node/v26.4.0/bin/node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const doc=(j.document||j);console.log(doc.status||'unknown')}catch(e){console.log('parse-error')}})" 2>/dev/null)
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
    log "FINAL status=$STATUS"
    curl -s -m 60 "$BASE" > /tmp/selftest-454-final.json
    log "final json saved to /tmp/selftest-454-final.json"
    # 验收数据
    /Users/pan/.nvm/versions/node/v26.4.0/bin/node -e "
const fs=require('fs');
try{
  const j=JSON.parse(fs.readFileSync('/tmp/selftest-454-final.json','utf8'));
  const doc=(j.document||j);
  const md=doc.markdown||'';
  const count=(re)=>(md.match(re)||[]).length;
  console.log('=== ACCEPTANCE ===');
  console.log('status:',doc.status);
  console.log('4645 occurrences:',count(/4645/g));
  console.log('4646 occurrences:',count(/4646/g));
  console.log('4646m2/平方米 occurrences:',count(/4646\s*(?:m2|㎡|平方米|m²|m\u00b2)/giu));
  console.log('has 项目主要施工内容 heading:',/#{2,4}\s*项目主要施工内容/u.test(md));
  console.log('has 主要施工方法 heading:',/#{2,4}\s*主要施工方法/u.test(md));
  console.log('has 主要分部分项工程施工方案 heading:',/#{2,4}\s*主要分部分项工程施工方案/u.test(md));
  const rm=doc.reviewMetadata||{};
  console.log('overall score:',rm.overallScore||rm.score||'n/a');
  console.log('deliveryProbability:',rm.deliveryProbability||'n/a');
  const errs=(doc.validationIssues||[]).filter(i=>i.level==='error').length;
  console.log('validation error count:',errs);
  const blockers=(doc.exportGate&&doc.exportGate.blockingIssues||[]).length;
  console.log('exportGate blockingIssues:',blockers);
  console.log('markdown chars:',md.length);
}catch(e){console.log('acceptance parse error:',e.message)}
" >> "$OUT"
    tail -40 "$OUT"
    break
  fi
  sleep 90
done
log "DONE polling loop ($i iterations)"
tail -5 "$OUT"
