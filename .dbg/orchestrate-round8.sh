#!/bin/bash
# 八度实测编排（4.8.2：重复/散落四项修复验收）：
# 杀旧进程 → 重启 dev server 加载 4.8.2 → 提交任务 → 挂轮询
set -u
LOG="/tmp/round8-orchestrate.log"
echo "ORCHESTRATE START $(date +%H:%M:%S)" > "$LOG"

PID=$(lsof -ti :17321 2>/dev/null | head -1)
if [ -n "$PID" ]; then kill "$PID"; echo "killed old server pid=$PID" >> "$LOG"; sleep 5; fi

cd /Users/pan/Desktop/codeing/customize-agent
export PATH="/Users/pan/.nvm/versions/node/v26.4.0/bin:$PATH"
nohup pnpm dev > /tmp/round8-server.log 2>&1 &
echo "server restarted pid=$!" >> "$LOG"

# 等健康检查
for t in $(seq 1 60); do
  if curl -s -m 5 "http://localhost:17321/api/health" 2>/dev/null | grep -q ok; then
    echo "health ok after ${t}x5s $(date +%H:%M:%S)" >> "$LOG"
    break
  fi
  sleep 5
done

# 触发八度实测（与七度同模板同要求）
RESP=$(curl -s -m 60 -X POST "http://localhost:17321/api/documents/generate" \
  -H 'Content-Type: application/json' \
  -d '{"templateId":"tpl-1785511985203","requirement":"徽光阁项目施工组织设计","projectRoot":"/Users/pan/Desktop/codeing/customize-agent"}')
echo "trigger resp: ${RESP:0:300}" >> "$LOG"
DOC_ID=$(node -e "try{const j=JSON.parse(process.argv[1]);console.log(j.document?.id||j.id||j.documentId||'')}catch(e){console.log('')}" "$RESP" 2>/dev/null)
if [ -z "$DOC_ID" ]; then echo "FAILED to extract doc id $(date +%H:%M:%S)" >> "$LOG"; exit 1; fi
echo "round8 doc=$DOC_ID $(date +%H:%M:%S)" >> "$LOG"
chmod +x /Users/pan/Desktop/codeing/customize-agent/.dbg/selftest-poll-round8.sh
nohup /Users/pan/Desktop/codeing/customize-agent/.dbg/selftest-poll-round8.sh "$DOC_ID" > /dev/null 2>&1 &
echo "poll mounted for $DOC_ID" >> "$LOG"
