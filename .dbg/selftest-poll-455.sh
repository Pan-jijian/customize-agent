#!/bin/bash
# 轮询自测任务 doc-1787747583111-da758001（4.5.5 跨章一致性修复验收）
DOC_ID="doc-1787747583111-da758001"
BASE="http://localhost:17321/api/documents/generated/$DOC_ID"
OUT="/tmp/selftest-455.log"
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
    curl -s -m 60 "$BASE" > /tmp/selftest-455-final.json
    /Users/pan/.nvm/versions/node/v26.4.0/bin/node -e "
const fs=require('fs');
try{
  const j=JSON.parse(fs.readFileSync('/tmp/selftest-455-final.json','utf8'));
  const doc=(j.document||j);
  const md=doc.markdown||'';
  const count=(re)=>(md.match(re)||[]).length;
  console.log('=== ACCEPTANCE 455 ===');
  console.log('status:',doc.status);
  console.log('error:',doc.error||'none');
  const rm=doc.reviewMetadata||{};
  console.log('overallScore:',rm.overallScore||rm.score||'n/a');
  console.log('deliveryProbability:',rm.deliveryProbability||'n/a');
  console.log('markdown chars:',md.length);
  console.log('chapters:',(doc.draft&&doc.draft.chapters||doc.chapters||[]).length);
  const errs=(doc.validationIssues||[]).filter(i=>i.level==='error');
  console.log('validation error count:',errs.length);
  const cc=errs.filter(i=>/跨章一致性|工序规格冲突/u.test(i.message));
  console.log('cross-chapter/spec errors:',cc.length, cc.slice(0,5).map(i=>i.message.slice(0,80)));
  const gate=doc.exportGate||(doc.draft&&doc.draft.exportGate)||{};
  console.log('exportGate.passed:',gate.passed);
  console.log('exportGate.blockingIssues:',(gate.blockingIssues||[]).length, (gate.blockingIssues||[]).slice(0,5).map(i=>i.message.slice(0,100)));
  console.log('gate checklist numeric_consistency:',JSON.stringify((gate.checklist||[]).find(c=>c.key==='numeric_consistency')||null));
  console.log('4645 occurrences:',count(/4645/g));
  console.log('4646 occurrences:',count(/4646/g));
  console.log('4646 area-unit occurrences:',count(/4646\s*(?:m2|㎡|平方米|m²|m\u00b2)/giu));
  console.log('has 项目主要施工内容 heading:',/#{2,4}\s*项目主要施工内容/u.test(md));
  console.log('has 主要施工方法 heading:',/#{2,4}\s*主要施工方法/u.test(md));
  const warnings=(doc.warningIssues||[]);
  console.log('warningIssues:',warnings.length, warnings.slice(0,5));
  fs.writeFileSync('/tmp/selftest-455-markdown.md',md);
  fs.writeFileSync('/tmp/selftest-455-draft.json',JSON.stringify(doc.draft||doc,null,2));
}catch(e){console.log('acceptance parse error:',e.message)}
" >> "$OUT"
    tail -45 "$OUT"
    break
  fi
  sleep 90
done
log "DONE polling loop ($i iterations)"
