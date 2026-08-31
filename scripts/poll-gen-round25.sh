#!/bin/bash
# 轮询生成任务状态直到完成
DOC_ID="$1"
ROOT="http://127.0.0.1:17321"
PR="$(python3 -c "import urllib.parse;print(urllib.parse.quote('/Users/pan/Desktop/codeing/customize-agent'))")"
prev_ts=""
while true; do
  resp=$(curl -s -m 30 "${ROOT}/api/documents/generated/${DOC_ID}?projectRoot=${PR}")
  status=$(echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status','unknown'))" 2>/dev/null)
  updated=$(echo "$resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('updatedAt',''))" 2>/dev/null)
  stages=$(echo "$resp" | python3 -c "
import json,sys
d=json.load(sys.stdin)
stages=d.get('executionStages') or []
running=[s for s in stages if s.get('status')=='running']
last=stages[-1] if stages else {}
print(f\"stages={len(stages)} running={len(running)} last={last.get('message','')[:80]}\")
" 2>/dev/null)
  now=$(date +%H:%M:%S)
  if [ "$updated" != "$prev_ts" ]; then
    echo "[$now] status=$status updated=$updated $stages"
    prev_ts="$updated"
  fi
  case "$status" in
    completed|completed_with_issues|failed)
      echo "[$now] FINAL: $status"
      echo "$resp" > /tmp/gen-final-${DOC_ID}.json
      exit 0
      ;;
  esac
  sleep 60
done
