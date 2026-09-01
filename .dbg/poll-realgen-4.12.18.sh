#!/bin/bash
# 真实生成轮询：doc-1788209117041-ad29ebdd（合肥师范 tpl-1787950104747，4.12.18 LLM 硬超时修复验证）
DOC_ID="doc-1788209117041-ad29ebdd"
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
START_MS=$(python3 -c "import time; print(int(time.time()*1000))")
LAST_SIG=""
while true; do
  RESP=$(curl -s "http://localhost:17321/api/documents/generated/${DOC_ID}?projectRoot=${PROJECT_ROOT}&lite=1")
  ELAPSED=$(python3 -c "
import time
start=${START_MS}
elapsed=(time.time()*1000-start)/60000
print(f'{elapsed:.1f}min')
")
  INFO=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('document',{})
stages=d.get('executionStages') or []
st=d.get('status') or '?'
ck=d.get('checkpoint') or 0
lines=[]
for s in stages[-4:]:
    name=(s.get('name') or '')[:16]
    state=s.get('state') or ''
    msg=(s.get('message') or '')[:70]
    lines.append(f'{name}:{state}|{msg}')
print(f'{st}[ck{ck}] || '+' || '.join(lines))
")
  SIG="${INFO}"
  if [ "$SIG" != "$LAST_SIG" ]; then
    echo "[+${ELAPSED}] ${SIG}"
    LAST_SIG="$SIG"
  fi
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('document',{}).get('status','?'))")
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "completed_with_issues" ] || [ "$STATUS" = "failed" ]; then
    echo "[+${ELAPSED}] FINAL_STATUS=$STATUS"
    echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('document',{})
print('wordCount:', d.get('wordCount'))
print('error:', (d.get('error') or '')[:500])
stages=d.get('executionStages') or []
for s in stages:
    if s.get('state') in ('failed','error'):
        print('FAILED STAGE:', s.get('name'), '|', (s.get('message') or '')[:150])
"
    break
  fi
  sleep 30
done
