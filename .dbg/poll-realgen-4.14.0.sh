#!/bin/bash
# 4.14.0 真实生成 A/B 验证：轮询生成状态（P0/P1 缓存优化验收，基线 4.12.22 hit=26.8%）
DOC_ID="doc-1788280100063-4a34ee78"
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
START_MS=$(python3 -c "import time; print(int(time.time()*1000))")
LAST_SIG=""
while true; do
  RESP=$(curl -s -m 20 "http://localhost:17321/api/documents/generated/${DOC_ID}?projectRoot=${PROJECT_ROOT}&lite=1")
  if [ -z "$RESP" ]; then sleep 30; continue; fi
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
words=d.get('wordCount') or 0
budget=[]
for s in stages:
    rid=s.get('roleId') or ''
    if 'budget' in rid:
        budget = [s.get('message') or ''] + (s.get('details') or [])
lines=[]
for s in stages[-3:]:
    name=(s.get('name') or '')[:14]
    state=s.get('state') or ''
    msg=(s.get('message') or '')[:60]
    lines.append(f'{name}:{state}|{msg}')
print(f'{st}[ck{ck}][{words}字] || '+' || '.join(lines))
if budget:
    print('BUDGET-REPORT:')
    for b in budget: print('  ', b)
" 2>/dev/null)
  SIG="${INFO}"
  if [ "$SIG" != "$LAST_SIG" ]; then
    echo "[$(date +%H:%M:%S)] elapsed=${ELAPSED}"
    echo "$INFO"
    LAST_SIG="$SIG"
  fi
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('document',{}).get('status','?'))" 2>/dev/null)
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "completed_with_issues" ] || [ "$STATUS" = "failed" ]; then
    echo "FINAL_STATUS=$STATUS elapsed=${ELAPSED}"
    echo "$RESP" > /Users/pan/Desktop/codeing/customize-agent/.dbg/realgen-4.14.0-final.json
    break
  fi
  sleep 60
done
