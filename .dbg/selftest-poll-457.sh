#!/bin/bash
# 真实模板生成任务轮询脚本（4.5.7 验证）
# 轮询 doc-1787761928153-5a8b669c 状态，直到完成或失败
DOC_ID="doc-1787761928153-5a8b669c"
BASE="http://localhost:17321"
LOG="/tmp/real-gen-457-poll.log"
echo "POLL START $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOG"
while true; do
  RESP=$(curl -s -m 20 "$BASE/api/documents/generated?id=$DOC_ID")
  if [ -z "$RESP" ]; then
    echo "EMPTY RESPONSE $(date -u +%H:%M:%SZ)" >> "$LOG"
    sleep 20
    continue
  fi
  STATUS=$(echo "$RESP" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const r=JSON.parse(s);const d=r.document||{};console.log([d.status||'?',d.latestStage||'',d.latestMessage||'',d.blockerCount||0,d.warningCount||0,d.completedChapterCount||0,d.chapterCount||0,d.wordCount||0].join('|'))}catch(e){console.log('PARSE_ERR')}})")
  echo "$(date -u +%H:%M:%SZ) $STATUS" >> "$LOG"
  case "$STATUS" in
    completed*|failed*|aborted*)
      echo "FINAL $STATUS" >> "$LOG"
      echo "$RESP" > /tmp/real-gen-457-final.json
      exit 0
      ;;
  esac
  sleep 45
done
