#!/usr/bin/env python3
"""轮9 生成结果分析：多规格按部位落位验证 + 质量画像 vs 参考库对比"""
import json, re, sys

FINAL = '/tmp/round9-final.json'
with open(FINAL) as f:
    raw = json.load(f)
doc = raw.get('document', raw)
md = doc.get('markdown') or ''
status = doc.get('status')

print(f"=== 轮9 生成状态：{status} ===")
print(f"文档长度：{len(md)} 字符")

# 1. 多规格落位验证：混凝土标号/砌块标号与部位词同句共现
SPEC_PATTERNS = {
    '混凝土标号': re.compile(r'(C\d{2,3})(?:\s*(?:细石|商品|泵送)?混凝土)?'),
    '砌块标号': re.compile(r'(A\d+(?:\.\d+)?)'),
}
LOC_WORDS = ['垫层', '基础', '主体', '梁板柱', '楼板', '顶板', '承台', '筏板', '构造柱', '圈梁', '过梁', '女儿墙', '外墙', '内墙']
for label, pat in SPEC_PATTERNS.items():
    hits = {}
    for m in pat.finditer(md):
        spec = m.group(1)
        seg = md[max(0, m.start() - 20):m.start()]
        loc = next((w for w in LOC_WORDS if w in seg), '（无部位词）')
        hits.setdefault(spec, {}).setdefault(loc, 0)
        hits[spec][loc] += 1
    print(f"\n--- {label} 规格×部位分布 ---")
    for spec, locs in sorted(hits.items()):
        total = sum(locs.values())
        print(f"  {spec}（{total} 处）：{dict(sorted(locs.items(), key=lambda x: -x[1]))}")

# 2. 冲突残留检查：全局一致性阶段
stages = doc.get('executionStages') or []
consist = [s for s in stages if '一致性' in (s.get('message') or '') or 'consistency' in (s.get('roleId') or '')]
print(f"\n--- 全局一致性阶段（{len(consist)} 个）---")
for s in consist:
    print(f"  [{s.get('status')}] {s.get('message', '')[:100]}")

# 3. 质量画像
words = len(re.sub(r'\s', '', md))
params = len(re.findall(r'\d+(?:\.\d+)?\s*(?:mm|m|㎡|m²|m2|平方米|kW|kVA|MPa|kN|t|天|日历天|层|%|台|套|具|m3|m³)', md))
print(f"\n--- 质量画像 ---")
print(f"  总字符（去空白）：{words}")
print(f"  参数量（粗略）：{params}")
print(f"  参数密度（每千字）：{params / (words / 1000):.2f}" if words else "  N/A")
