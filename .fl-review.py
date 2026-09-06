#!/usr/bin/env python3
"""丰乐镇生成结果评审脚本：内部评分器数据 + 招标文件十项评审红线核查"""
import json, re, sys

FINAL = '/tmp/fl-final.json'
with open(FINAL) as f:
    raw = json.load(f)
doc = raw.get('document') or {}
md = doc.get('markdown') or ''
rm = doc.get('reviewMetadata') or {}
stages = doc.get('executionStages') or []

print(f"=== 生成状态：{doc.get('status')} | 标题：{doc.get('title')} ===")
print(f"文档长度：{len(md)} 字符")

# ── 1. 内部评分器数据 ──
print("\n────── 1. 内部评分器数据 ──────")
ps = rm.get('professionalScore') or {}
print(f"[professionalScore] grade={ps.get('grade')} summary={ps.get('summary','')[:120]}")
for dim in (ps.get('dimensions') or []):
    print(f"  维度 {dim.get('label')}: {dim.get('score')} 分 ({str(dim.get('detail'))[:100]})")
for issue in (ps.get('topIssues') or [])[:10]:
    print(f"  待修复: {issue}")

qb = rm.get('qualityBenchmark') or {}
print(f"[qualityBenchmark]")
for item in (qb.get('items') or []):
    print(f"  {item.get('label')}: {item.get('generated')} vs 参考 {item.get('reference')} → {item.get('score')} 分 {'✅' if item.get('passed') else '❌'}")

qr = rm.get('qualityReport') or {}
print(f"[qualityReport] passed={qr.get('passed')} deliveryProbability={qr.get('deliveryProbability')}")
print(f"  summary: {(qr.get('summary') or '')[:200]}")

kc = rm.get('knowledgeCoverage') or {}
print(f"[knowledgeCoverage] score={kc.get('score')} evidence={kc.get('evidenceCount')} files={kc.get('confirmedFiles')}")

tr = qr.get('templating') or {}
if tr:
    print(f"[templating] level={tr.get('level')} fillerRatio={tr.get('fillerRatio')} vagueHitCount={tr.get('vagueHitCount')}")

# ── 2. 评审轮 stages 摘要 ──
print("\n────── 2. 关键评审 stages ──────")
for s in stages:
    msg = (s.get('message') or '')[:140]
    if any(k in msg for k in ['全维度评审', '阻断', '修复', '专业度', '交付评分', '模板化', '覆盖', '养护', '红线']):
        print(f"  [{s.get('status')}] {msg}")

# ── 3. 招标文件十项评审红线核查 ──
print("\n────── 3. 十项评审红线核查 ──────")
def count(pat, text=md):
    return len(re.findall(pat, text))

checks = [
    ('养护期两年（清单红线）', r'养护期?[^。；\n]{0,30}两年', r'养护期?[^。；\n]{0,30}一年'),
    ('荷兰菊/紫花地丁/白三叶（绿化材料对齐清单）', r'荷兰菊|紫花地丁|白三叶', None),
    ('公厕施工方法', r'公厕|厕所', None),
    ('路灯', r'路灯', None),
    ('过路涵', r'过路涵', None),
    ('小菜园', r'小菜园|菜地整治', None),
    ('沟塘清淤', r'清淤', None),
    ('管网施工', r'管网', None),
    ('六个百分百', r'六个百分百', None),
    ('施工总平面布置图', r'施工总平面布置图|总平面布置图', None),
    ('劳动力高峰', r'劳动力(?:高峰|峰值)?[^。；\n]{0,20}\d+\s*人', None),
    ('暂列金额10万元', r'暂列(?:金额|金)|10\s*万元', None),
    ('清淤深度0.5m', r'0\.5\s*m', None),
    ('过路涵涵头C25', r'C25', None),
]
for label, pos, neg in checks:
    c_pos = count(pos)
    c_neg = count(neg) if neg else 0
    status = f"命中 {c_pos}"
    if neg and c_neg > 0:
        status += f" ⚠️ 反向命中 {c_neg}"
    print(f"  [{status:>30}] {label}")

# ── 4. 页数估计（200 页上限）──
chars_per_page = 700  # 中文文档每页约 700 字
est_pages = len(md) / chars_per_page
print(f"\n────── 4. 篇幅估计 ──────")
print(f"  正文 {len(md)} 字符 ≈ {est_pages:.0f} 页（200 页上限，超出扣 1.0 分）")
