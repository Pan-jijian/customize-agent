#!/bin/bash
# 轮询项目理解缓存重建（v10）完成
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
while true; do
  RESP=$(curl -s "http://localhost:17321/api/kb/intelligence?projectRoot=${PROJECT_ROOT}")
  V=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); c=d.get('cache') or {}; print(c.get('version','-'), c.get('createdAt','-'), c.get('factCount','-'), c.get('intentCount','-'), c.get('fileCount','-'))" 2>/dev/null)
  echo "[$(date +%H:%M:%S)] version/createdAt/facts/intent/files: $V"
  case "$V" in
    *v10*) echo "REBUILD_DONE"; break ;;
  esac
  sleep 30
done
