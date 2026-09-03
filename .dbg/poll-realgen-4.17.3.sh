#!/bin/bash
# 4.17.3 真实模板自测轮询：合肥师范 tpl-1787950104747
# 重点观测：error/failed 节点数、prompt_cache 命中率、修复轮行为
DOC="doc-1788387957953-5c48c136"
DRAFT="/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/$DOC.json"
URL="http://127.0.0.1:17321/api/documents/generated/${DOC}?projectRoot=/Users/pan/Desktop/codeing/customize-agent&lite=1"
for i in $(seq 1 300); do
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
repair=[s for s in stages if s.get('status') in ('repairing','error','failed')]
print(f"[{st}] words={d.get('wordCount')} stages={len(stages)} error={len(err)} failed={len(failed)}")
for s in stages[-3:]:
    print('   stage:', s.get('type'), '|', s.get('roleId'), '|', s.get('status'), '|', (s.get('message') or '')[:80])
# 缓存命中诊断（budget-trim-report / telemetry）
diag=d.get('generationDiagnostics') or d.get('diagnostics') or {}
for k,v in diag.items():
    if 'cache' in k.lower() or 'hit' in k.lower() or 'token' in k.lower():
        print('   diag:', k, '=', str(v)[:120])
for s in stages:
    if s.get('roleId')=='budget-trim-report' and s.get('status')=='success':
        for det in (s.get('details') or []):
            if any(k in det for k in ('命中','缓存','token','Token','分层')):
                print('   budget:', det[:160])
PYEOF
  else
    R=$(curl -s -m 20 "$URL" 2>/dev/null)
    ST=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin).get('document',{}).get('status','?'))" 2>/dev/null)
    echo "[$TS] draft not ready, api status=$ST"
  fi
  ST2=$(python3 -c "import json;print(json.load(open('$DRAFT')).get('document',json.load(open('$DRAFT'))).get('status',''))" 2>/dev/null)
  if [ "$ST2" = "completed" ] || [ "$ST2" = "failed" ] || [ "$ST2" = "aborted" ]; then
    echo "=== FINAL: $ST2 ==="
    exit 0
  fi
  sleep 90
done
echo "=== TIMEOUT ==="
