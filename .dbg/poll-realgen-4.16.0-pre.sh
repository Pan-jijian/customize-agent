#!/bin/bash
# 4.16.0 发布前真实模板生成轮询（合肥师范 tpl-1787950104747）
# 重点观测：命中率（prompt_cache）、推理 token、error/failed 节点
DOC="doc-1788319685188-96d4bd87"
PROJ="/Users/pan/Desktop/codeing/customize-agent"
URL="http://127.0.0.1:17321/api/documents/generated/${DOC}?projectRoot=${PROJ}&lite=1"
for i in $(seq 1 180); do
  TS=$(date "+%H:%M:%S")
  R=$(curl -s "$URL" 2>/dev/null)
  STATUS=$(echo "$R" | python3 -c "import sys,json;d=json.load(sys.stdin);doc=d.get('document',{});print(doc.get('status','?'))" 2>/dev/null)
  echo "[$TS] status=$STATUS"
  echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin).get('document', {})
stages = d.get('executionStages') or []
err = failed = 0
for s in stages:
    if s.get('status') == 'error': err += 1
    if s.get('status') == 'failed': failed += 1
print(f'   stages={len(stages)} error={err} failed={failed}')
for s in stages[-4:]:
    print('   stage:', s.get('type'), '|', s.get('roleId'), '|', s.get('status'), '|', (s.get('message') or '')[:90])
" 2>/dev/null
  if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ] || [ "$STATUS" = "aborted" ]; then
    echo "=== FINAL: $STATUS ==="
    echo "$R" | python3 -c "
import sys, json
d = json.load(sys.stdin).get('document', {})
print('wordCount:', d.get('wordCount'))
stages = d.get('executionStages') or []
err = [s for s in stages if s.get('status') == 'error']
failed = [s for s in stages if s.get('status') == 'failed']
print('error nodes:', len(err), '| failed nodes:', len(failed))
for s in stages:
    if s.get('roleId') == 'budget-trim-report' and s.get('status') == 'success':
        for det in (s.get('details') or []):
            if any(k in det for k in ('命中','推理 token','缓存','分层','LLM 上下文')):
                print('   ', det[:200])
" 2>/dev/null
    exit 0
  fi
  sleep 60
done
echo "=== TIMEOUT after 180 min ==="
