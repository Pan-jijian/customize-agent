#!/usr/bin/env python3
# 对比 markdown（生成原文）与 editedMarkdown（用户手动改后），定位生成器真实错误形态
import json, re, difflib

P = '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1787981576533-041f30d2.json'
d = json.load(open(P))
md = d.get('markdown', '')
em = d.get('editedMarkdown', '')
print(f'markdown: {len(md)} 字, editedMarkdown: {len(em)} 字, 是否相同: {md == em}')

if not em:
    print('无 editedMarkdown 字段')
else:
    # 行级 diff
    a = md.split('\n')
    b = em.split('\n')
    sm = difflib.SequenceMatcher(None, a, b)
    print('=== 行级差异（用户手动修改处）===')
    n = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            continue
        n += 1
        if n > 40:
            print('... 差异过多，截断')
            break
        print(f'\n[{tag}] 原文 L{i1+1}-L{i2}:')
        for l in a[i1:i2]:
            print(f'  - {l.strip()[:160]}')
        print(f'[{tag}] 改后 L{j1+1}-L{j2}:')
        for l in b[j1:j2]:
            print(f'  + {l.strip()[:160]}')
    print(f'\n差异块总数: {sum(1 for t in sm.get_opcodes() if t[0] != "equal")}')
