#!/usr/bin/env python3
# 对比导出资产（生成时 14:42）与 draft markdown（用户 15:01 保存后），定位用户改动
import json, difflib

ASSET = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/assets/合肥师范施工组织设计-doc-1787981576533-041f30d2.md'
DRAFT = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1787981576533-041f30d2.json'

asset_md = open(ASSET, encoding='utf-8').read()
d = json.load(open(DRAFT))
draft_md = d.get('markdown', '')

print(f'asset: {len(asset_md)} 字, draft: {len(draft_md)} 字, 相同: {asset_md == draft_md}')
print()
print('=== asset（生成时）中所有 10970/28570.36 错误相关 ===')
a_lines = asset_md.split('\n')
for i, l in enumerate(a_lines, 1):
    if '10970' in l:
        print(f'asset L{i}: {l.strip()[:200]}')
        print('---')

print()
a2 = asset_md.split('\n')
b2 = draft_md.split('\n')
sm = difflib.SequenceMatcher(None, a2, b2)
print('=== 差异块（asset → draft，即你的改动）===')
n = 0
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == 'equal':
        continue
    n += 1
    if n > 50:
        print('... 截断')
        break
    print(f'\n[{tag}] asset L{i1+1}-L{i2}:')
    for l in a2[i1:i2]:
        print(f'  - {l.strip()[:180]}')
    print(f'[{tag}] draft L{j1+1}-L{j2}:')
    for l in b2[j1:j2]:
        print(f'  + {l.strip()[:180]}')
print(f'\n差异块总数: {sum(1 for t in sm.get_opcodes() if t[0] != "equal")}')
