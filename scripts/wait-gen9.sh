#!/bin/bash
# 轮询第四轮生成 doc-1787981576533-041f30d2 的 meta.json（90 秒间隔）
DOC=doc-1787981576533-041f30d2
META=/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/$DOC.meta.json
for i in $(seq 1 80); do
  if [ -f "$META" ]; then
    STATUS=$(python3 -c "import json;print(json.load(open('$META')).get('status',''))" 2>/dev/null)
    UPD=$(python3 -c "import json;print(json.load(open('$META')).get('updatedAt',''))" 2>/dev/null)
    echo "[$(date '+%H:%M:%S')] status=$STATUS updatedAt=$UPD"
    if [ "$STATUS" = "completed" ] || [ "$STATUS" = "completed_with_issues" ] || [ "$STATUS" = "failed" ]; then
      echo "FINAL: $STATUS"
      break
    fi
  else
    echo "[$(date '+%H:%M:%S')] meta not ready yet"
  fi
  sleep 90
done
