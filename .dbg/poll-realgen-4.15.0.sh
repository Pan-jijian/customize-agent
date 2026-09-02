#!/bin/bash
# 轮询真实生成 doc-1788284005259-25f84953（4.15.0 验证：字段级闭环 + 必提字段无缺失）
DOC="doc-1788284005259-25f84953"
PROJ="/Users/pan/Desktop/codeing/customize-agent"
URL="http://127.0.0.1:17321/api/documents/generated/${DOC}?projectRoot=${PROJ}&lite=1"
for i in $(seq 1 120); do
  TS=$(date "+%H:%M:%S")
  R=$(curl -s "$URL" 2>/dev/null)
  STATUS=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);doc=d.get('document',{});print(doc.get('status','?'))" 2>/dev/null)
  WORD=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);doc=d.get('document',{});print(doc.get('wordCount') or 0)" 2>/dev/null)
  echo "[$TS] status=$STATUS words=$WORD"
  echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin).get('document', {})
stages = d.get('executionStages') or []
for s in stages[-5:]:
    print('   stage:', s.get('type'), '|', s.get('roleId'), '|', s.get('status'), '|', (s.get('message') or '')[:100])
" 2>/dev/null
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "aborted" ]; then
    echo "=== FINAL: $STATUS ==="
    echo "$R" | python3 -m json.tool 2>/dev/null | head -60
    exit 0
  fi
  sleep 60
done
echo "=== TIMEOUT after 120 min ==="
