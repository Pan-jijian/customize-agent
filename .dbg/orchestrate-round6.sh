#!/bin/bash
# 五度实测完成后：重启服务加载 4.5.17 → 触发六度实测 → 挂轮询
set -u
LOG="/tmp/round6-orchestrate.log"
echo "ORCHESTRATE START $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOG"
while true; do
  if [ -f /tmp/round5-final.json ]; then
    R5_STATUS=$(node -e "try{const j=require('/tmp/round5-final.json');const d=j.document||j;console.log(d.status||'?')}catch(e){console.log('?')}" 2>/dev/null)
    echo "round5 done: $R5_STATUS $(date -u +%H:%M:%SZ)" >> "$LOG"
    break
  fi
  sleep 20
done

# 重启服务加载 4.5.17
PID=$(lsof -ti :17321 2>/dev/null | head -1)
if [ -n "$PID" ]; then kill "$PID"; echo "killed old server pid=$PID" >> "$LOG"; sleep 5; fi

cd /Users/pan/Desktop/codeing/customize-agent
export PATH="/Users/pan/.nvm/versions/node/v26.4.0/bin:$PATH"
nohup pnpm dev > /tmp/round6-server.log 2>&1 &
echo "server restarted pid=$!" >> "$LOG"

# 等健康检查
for t in $(seq 1 60); do
  if curl -s -m 5 "http://localhost:17321/api/health" 2>/dev/null | grep -q ok; then
    echo "health ok after ${t}x5s $(date -u +%H:%M:%SZ)" >> "$LOG"
    break
  fi
  sleep 5
done

# 触发六度实测
RESP=$(curl -s -m 60 -X POST "http://localhost:17321/api/documents/generate" \
  -H 'Content-Type: application/json' \
  -d '{"templateId":"doc-1787827688830-4a44b7e4","requirement":"8.4徽光阁项目施工","projectRoot":"/Users/pan/Desktop/codeing/customize-agent"}')
echo "trigger resp: ${RESP:0:300}" >> "$LOG"
DOC_ID=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.document?.id||j.id||j.documentId||'')}catch(e){console.log('')}" "$RESP" 2>/dev/null)
if [ -z "$DOC_ID" ]; then echo "FAILED to extract doc id $(date -u +%H:%M:%SZ)" >> "$LOG"; exit 1; fi
echo "round6 doc=$DOC_ID $(date -u +%H:%M:%SZ)" >> "$LOG"
chmod +x /Users/pan/Desktop/codeing/customize-agent/.dbg/selftest-poll-round6.sh
nohup /Users/pan/Desktop/codeing/customize-agent/.dbg/selftest-poll-round6.sh "$DOC_ID" > /dev/null 2>&1 &
echo "poll mounted for $DOC_ID" >> "$LOG"
