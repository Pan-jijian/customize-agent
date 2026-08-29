#!/usr/bin/env python3
# 检查第四轮 draft 的 10970 出现处 + 生成诊断 + 修复 error
import json, re, sys

P = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1787981576533-041f30d2.json'
d = json.load(open(P))
md = d.get('markdown', '')
lines = md.split('\n')

print('=== 正文中所有 10970 出现处 ===')
hits = 0
for i, l in enumerate(lines, 1):
    if '10970' in l:
        hits += 1
        print(f'L{i}: {l.strip()[:300]}')
        print('---')
print(f'共 {hits} 处')

print()
print('=== executionStages ===')
for s in d.get('executionStages', []):
    print(json.dumps(s, ensure_ascii=False)[:300])

print()
print('=== agentWorkflow 关键字段 ===')
aw = d.get('agentWorkflow') or {}
print('keys:', list(aw.keys())[:40])
for k in ('stages', 'rounds', 'repairRounds', 'errors', 'diagnostics', 'steps'):
    v = aw.get(k)
    if v is not None:
        print(f'{k}: 类型={type(v).__name__}, 长度={len(v) if hasattr(v, "__len__") else "-"}')

print()
print('=== reviewMetadata 关键字段 ===')
rm = d.get('reviewMetadata') or {}
print('keys:', list(rm.keys())[:40])

print()
print('=== warningIssues 数 ===')
w = d.get('warningIssues') or []
print(len(w))
