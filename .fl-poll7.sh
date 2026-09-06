#!/bin/bash
DOC_ID="doc-1788677277828-8e963b02"
URL="http://localhost:17321/api/documents/generated/${DOC_ID}?lite=1"
OUT="/tmp/fl-final7-full.json"
for i in $(seq 1 300); do
  STATUS=$(curl -s "$URL" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
    doc = d.get('document', d)
    print(doc.get('status','unknown'))
except Exception as e:
    print('parse_error')
")
  echo "[poll $i] status=$STATUS $(date +%H:%M:%S)"
  case "$STATUS" in
    completed|completed_with_issues|failed|cancelled)
      curl -s "$URL" > "$OUT"
      echo "FINAL: $STATUS saved to $OUT"
      python3 -c "
import json
with open('$OUT') as f:
    d = json.load(f)
doc = d.get('document', d)
with open('/tmp/fl7-md.md','w') as f:
    f.write(doc.get('markdown',''))
print('markdown saved, len:', len(doc.get('markdown','')))
"
      exit 0
      ;;
  esac
  sleep 60
done
echo "TIMEOUT after 300 polls"
