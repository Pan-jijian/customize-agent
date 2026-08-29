#!/usr/bin/env python3
# 检查最终 markdown 中规模/面积相关表述
import json, re

P = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1787981576533-041f30d2.json'
d = json.load(open(P))
md = d.get('markdown', '')
lines = md.split('\n')

print('=== 总占地面积 出现处 ===')
for i, l in enumerate(lines, 1):
    if '总占地面积' in l or '占地面积' in l:
        print(f'L{i}: {l.strip()[:250]}')

print()
print('=== 建设规模 出现处 ===')
for i, l in enumerate(lines, 1):
    if '建设规模' in l:
        print(f'L{i}: {l.strip()[:250]}')

print()
print('=== 3786.97 出现处 ===')
for i, l in enumerate(lines, 1):
    if '3786.97' in l:
        print(f'L{i}: {l.strip()[:250]}')

print()
print('=== 28570.36 出现处（前 15 处） ===')
n = 0
for i, l in enumerate(lines, 1):
    if '28570.36' in l:
        n += 1
        if n <= 15:
            print(f'L{i}: {l.strip()[:250]}')
print(f'共 {n} 处')

print()
print('=== 地下.*3786|地下建筑面积 出现处 ===')
for i, l in enumerate(lines, 1):
    if re.search(r'地下.{0,20}(3786\.97|28570)', l):
        print(f'L{i}: {l.strip()[:250]}')
