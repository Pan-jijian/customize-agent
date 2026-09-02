#!/bin/bash
# 4.16.0 发布后真实模板自测：doc-1788323464391-e4d73775（合肥师范 tpl-1787950104747）
# 每 45 秒检查一次 draft 状态与关键阶段：计划数据主表 / 章节生成 / prefix cache 命中
DOC="doc-1788323464391-e4d73775"
DRAFT="/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/$DOC.json"
LOG="/Users/pan/Desktop/codeing/customize-agent/.dbg/selftest-4.16.0.log"
: > "$LOG"
PREV=""
for i in $(seq 1 300); do
  NOW=$(date '+%Y-%m-%d %H:%M:%S')
  if [ ! -f "$DRAFT" ]; then
    LINE="[$NOW] draft not ready"
  else
    LINE=$(python3 - "$DRAFT" <<'PYEOF'
import json,sys
j=json.load(open(sys.argv[1]))
d=j.get('document',j)
st=d.get('status')
stages=d.get('executionStages') or []
key=[]
for s in stages:
    rid=s.get('roleId','')
    if rid in ('plan-data-master','chapter_generation','global-consistency','final-quality-review','document-consolidation'):
        m=(s.get('message') or '').replace('\n',' ')[:100]
        key.append(f"{rid}={s.get('status','')}|{m}")
last=stages[-1].get('message','')[:100] if stages else ''
diag=d.get('generationDiagnostics') or d.get('diagnostics') or {}
# prompt cache 诊断（字段名可能不同，打印所有含 cache 的键）
cache={k:v for k,v in diag.items() if 'cache' in k.lower() or 'hit' in k.lower()}
chapters=d.get('checkpointChapters') or d.get('partialChapters') or []
done=sum(1 for c in chapters if c.get('content'))
print(f"[{st}] stages={len(stages)} doneChapters={done}/{len(chapters) if chapters else '?'} last={last} key={' | '.join(key[-4:])} cache={cache}")
PYEOF
)
  fi
  echo "$LINE" >> "$LOG"
  if [ "$LINE" != "$PREV" ]; then
    echo "$LINE"
    PREV="$LINE"
  fi
  case "$LINE" in
    *"[completed"*|*"[completed_with_issues"*|*"[warning"*|*"[failed"*|*"[aborted"*)
      echo "FINAL REACHED" >> "$LOG"
      exit 0
      ;;
  esac
  sleep 45
done
echo "TIMEOUT after 300 polls" >> "$LOG"
exit 1
