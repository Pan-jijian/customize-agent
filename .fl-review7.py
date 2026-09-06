#!/usr/bin/env python3
"""丰乐镇第七轮评审脚本：内部评分器数据 + 第六轮25条阻断项逐项回查"""
import json, re, sys

FINAL = '/tmp/fl-final7-full.json'
with open(FINAL) as f:
    raw = json.load(f)
doc = raw.get('document') or {}
md = doc.get('markdown') or ''
rm = doc.get('reviewMetadata') or {}

print(f"=== 生成状态：{doc.get('status')} | 标题：{doc.get('title')} ===")
print(f"文档长度：{len(md)} 字符")

# ── 1. 内部评分器数据 ──
print("\n────── 1. 内部评分器数据 ──────")
qr = rm.get('qualityReport') or {}
print(f"[qualityReport] overall={qr.get('overall')} deliveryProbability={qr.get('deliveryProbability')} passed={qr.get('passed')} target={qr.get('target')}")
scores = qr.get('scores') or {}
print(f"  scores: {json.dumps(scores, ensure_ascii=False)}")
kc = rm.get('knowledgeCoverage') or {}
print(f"[knowledgeCoverage] score={kc.get('score')} evidence={kc.get('evidenceCount')} files={kc.get('confirmedFiles')}")

# ── 2. blockingIssues ──
print("\n────── 2. blockingIssues ──────")
eg = doc.get('draft', {}).get('exportGate') or {}
blocking = eg.get('blockingIssues') or []
print(f"阻断数：{len(blocking)}（第六轮 25）")
for i, b in enumerate(blocking):
    m = b.get('message', '') if isinstance(b, dict) else str(b)
    print(f"  {i:2d}. {m[:180]}")

# ── 3. 第六轮问题逐项回查 ──
print("\n────── 3. 第六轮问题逐项回查 ──────")
def hit(label, pattern):
    n = len(re.findall(pattern, md))
    print(f"  {'✅' if n > 0 else '❌'} {label}: {n} 处")
    return n

def hit_no(label, pattern, ctx=''):
    m = re.findall(pattern, md)
    print(f"  {'✅' if not m else '❌'} {label}: {len(m)} 处 {ctx}")
    return m

hit('总价合同', r'总价合同')
hit('预付款响应', r'预付款')
hit('工期总日历天数条款', r'工期总日历天数|总日历天数')
hit('缺陷责任期', r'缺陷责任期')
hit('农民工工资账户', r'农民工工资.{0,10}账户|工资专户|专用账户')
hit('工程支付担保', r'支付担保|履约担保')
hit('安全生产专项', r'安全生产')
hit('工程报表', r'工程报表|报表')
hit('竣工资料', r'竣工资料')
# 灭火器口径
m = re.findall(r'灭火器.{0,60}?(\d+)\s*具', md)
print(f"  灭火器数值：{m}")
hit_no('空响应句', r'本施工组织设计已按上述条款要求逐项落实执行')
# 断行残片
for frag in ['优先保障关键村', '延长有效作业时间']:
    m = re.findall(r'\n' + frag + r'[^\n]*\|\n', md)
    print(f"  {'✅' if not m else '❌'} 断行残片「{frag}」独立残行：{len(m)} 处")
# 自伤句
hit_no('编制边界自伤', r'本施工组织设计.{0,15}编制边界|不属于本施工组织设计.{0,10}编制|超出.{0,6}编制边界')
hit_no('招标范围外自伤', r'不包含.{0,10}招标范围外|招标范围外的.{0,10}不包含|不属于.{0,6}招标范围')
hit_no('开放交通自伤', r'不得.{0,10}开放交通|禁止.{0,10}开放交通')
# 劳动力
print(f"  劳动力分阶段人数段：")
for seg in re.findall(r'[^。\n]{0,40}(?:准备阶段|高峰期|竣工阶段)[^。\n]{0,60}?(?:\d+人)', md)[:6]:
    print(f"    {seg.strip()[:100]}")
# 表格
tables = [m.start() for m in re.finditer(r'\|\s*工程名称\s*\|\s*建设地点\s*\|\s*建设规模', md)]
print(f"  {'✅' if len(tables) == 1 else '❌'} 工程名称表唯一：{len(tables)} 处")
bad = re.findall(r'(?<!分)([\u4e00-\u9fa5]{2})\1(?!项)', md)
print(f"  {'✅' if not bad else '❌'} 真叠词残留：{bad[:5]}")

# ── 4. 评分公式复算 ──
print("\n────── 4. 评分公式复算 ──────")
if scores:
    s = scores
    uniqueness = s.get('uniqueness', 100)
    weighted = round(s.get('completeness', 0) * 0.30 + s.get('specificity', 0) * 0.25 + s.get('compliance', 0) * 0.20 + s.get('executability', 0) * 0.15 + s.get('normalization', 0) * 0.10, 1)
    overall = round(weighted * min(1, uniqueness / 90), 1)
    dp = max(0, min(99, round(overall - len(blocking) * 8)))
    print(f"  复算 weighted={weighted} overall={overall} deliveryProbability={dp}")
    print(f"  实际 overall={qr.get('overall')} dp={qr.get('deliveryProbability')}")

# ── 5. warningIssues 统计 ──
print("\n────── 5. warningIssues ──────")
warn = doc.get('warningIssues') or []
print(f"警告数：{len(warn)}")
for w in warn[:15]:
    print(f"  - {str(w)[:130]}")

# ── 6. diagnostics ──
print("\n────── 6. diagnostics ──────")
diag = (rm.get('diagnostics') or {}).get('quality') or {}
if diag:
    print(f"  {json.dumps(diag, ensure_ascii=False)[:300]}")
