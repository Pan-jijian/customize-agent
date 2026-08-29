#!/usr/bin/env python3
# 提取第四轮生成诊断：修复轮次、耗时、error 分布
import json

P = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1787981576533-041f30d2.json'
d = json.load(open(P))

rm = d.get('reviewMetadata') or {}
diag = rm.get('diagnostics') or {}
print('=== diagnostics keys ===')
print(list(diag.keys())[:40] if isinstance(diag, dict) else type(diag))

tele = rm.get('telemetry') or {}
print()
print('=== telemetry keys ===')
print(list(tele.keys())[:40] if isinstance(tele, dict) else type(tele))

# 找耗时相关的字段
def find_time_fields(obj, path='', depth=0):
    if depth > 3: return
    if isinstance(obj, dict):
        for k, v in obj.items():
            if any(w in k.lower() for w in ('dur', 'time', 'ms', 'sec', 'elapsed', 'cost')):
                print(f'{path}.{k} = {str(v)[:120]}')
            find_time_fields(v, f'{path}.{k}', depth + 1)
    elif isinstance(obj, list):
        for i, v in enumerate(obj[:5]):
            find_time_fields(v, f'{path}[{i}]', depth + 1)

print()
print('=== 耗时字段 ===')
find_time_fields(rm)
find_time_fields(d.get('agentWorkflow') or {})
