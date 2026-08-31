#!/bin/bash
# 轮询生成任务 doc-1788050105554-2cfb5b51（4.12.4 发布后重生成验证）
DOC_ID="doc-1788050105554-2cfb5b51"
URL="http://127.0.0.1:17321/api/documents/generated/$DOC_ID"
for i in $(seq 1 200); do
  RESP=$(curl -s -m 150 "$URL")
  STATUS=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('document',{}).get('status','unknown'))" 2>/dev/null)
  WORD=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('document',{}).get('wordCount','-'))" 2>/dev/null)
  KEY=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)['document']
stages=d.get('executionStages',[])
keys=[s.get('message','') for s in stages if '评分项要求' in s.get('message','') or '评标办法' in s.get('message','') or '全维度评审' in s.get('message','') or '章节' in s.get('message','')]
print(' | '.join(keys[-2:]))" 2>/dev/null | head -c 300)
  echo "[$i] $(date +%H:%M:%S) status=$STATUS words=$WORD"
  if [ -n "$KEY" ]; then echo "    阶段: $KEY"; fi
  if [ "$STATUS" != "generating" ] && [ "$STATUS" != "unknown" ] && [ -n "$STATUS" ]; then
    echo "=== DONE: $STATUS ==="
    echo "$RESP" > /tmp/gen-4.12.4-final.json
    exit 0
  fi
  sleep 50
done
