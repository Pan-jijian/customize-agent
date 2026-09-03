#!/bin/bash
# 4.17.6 真实生成监控：缓存命中率 90% 验收 + 分层统计 + 状态/错误
DOC="doc-1788412402917-156d58b7"
DRAFT="/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/$DOC.json"
for i in $(seq 1 240); do
  TS=$(date "+%H:%M:%S")
  if [ -f "$DRAFT" ]; then
    python3 - "$DRAFT" <<'PYEOF'
import json,sys
j=json.load(open(sys.argv[1]))
d=j.get('document',j)
st=d.get('status')
stages=d.get('executionStages') or []
err=[s for s in stages if s.get('status')=='error']
failed=[s for s in stages if s.get('status')=='failed']
repairing=[s for s in stages if s.get('status')=='repairing']
# 缓存/分层诊断：第三轮实测结构为 reviewMetadata.diagnostics
diag = d.get('reviewMetadata',{}).get('diagnostics') or d.get('generationDiagnostics') or d.get('diagnostics') or {}
llm=diag.get('llm') or {}
hits=llm.get('promptCacheHitTokens') or llm.get('cacheHitTokens') or 0
miss=llm.get('promptCacheMissTokens') or llm.get('cacheMissTokens') or 0
total=hits+miss
rate=f"{hits/total*100:.1f}%" if total>0 else "n/a"
layers=diag.get('contextLayers') or {}
lc=layers.get('layerChars') or {}
print(f"[{st}] stages={len(stages)} error={len(err)} failed={len(failed)} repairing={len(repairing)} | cache hit={hits} miss={miss} rate={rate} | calls={llm.get('calls')} llmFail={llm.get('failures')}")
if lc:
    print(f"   layers l0={lc.get('l0',0)} l1={lc.get('l1',0)} l2={lc.get('l2',0)} l3={lc.get('l3',0)}")
for s in stages[-2:]:
    print('   stage:', s.get('type'), '|', s.get('roleId'), '|', s.get('status'), '|', (s.get('message') or '')[:70])
PYEOF
  fi
  ST2=$(python3 -c "import json;print(json.load(open('$DRAFT')).get('document',json.load(open('$DRAFT'))).get('status',''))" 2>/dev/null)
  if [ "$ST2" = "completed" ] || [ "$ST2" = "completed_with_issues" ] || [ "$ST2" = "failed" ] || [ "$ST2" = "aborted" ]; then
    echo "=== FINAL: $ST2 ==="
    break
  fi
  sleep 60
done
