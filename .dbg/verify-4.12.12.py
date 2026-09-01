#!/usr/bin/env python3
"""4.12.12 真实生成对账：六指标 / 青天评分 / 评分报告 P1-P4 销项"""
import json
import re
import sys
from collections import Counter

path = sys.argv[1] if len(sys.argv) > 1 else ".dbg/gen-4.12.12-final.json"
raw = json.load(open(path))
doc = raw.get("document", raw)
md = doc.get("markdown") or ""
print("=" * 70)
print(f"docId={doc.get('id')}  status={doc.get('status')}  wordCount={doc.get('wordCount')}")
print(f"title={doc.get('title')}  updatedAt={doc.get('updatedAt')}")

# ---- 1. 导出门禁 ----
gate = doc.get("exportGate") or {}
print("\n[导出门禁] passed=%s blocking=%d" % (gate.get("passed"), len(gate.get("blockingIssues") or [])))
for i in (gate.get("blockingIssues") or [])[:10]:
    print("   BLOCK:", (i.get("message") or "")[:110])

# ---- 2. validationIssues 分级 ----
issues = doc.get("validationIssues") or []
levels = Counter(i.get("severity") or i.get("level") for i in issues)
cats = Counter(i.get("category") for i in issues)
print("\n[validationIssues] total=%d levels=%s" % (len(issues), dict(levels)))
print("   categories=%s" % dict(cats))
for i in issues:
    if (i.get("severity") or i.get("level")) in ("blocker", "error"):
        print("   ERR:", (i.get("message") or "")[:110])

# ---- 3. telemetry / reviewMetadata 质量口径 ----
tele = doc.get("telemetry") or {}
qi = tele.get("qualityIssues") or {}
print("\n[telemetry.qualityIssues] %s" % qi)
rm = doc.get("reviewMetadata") or {}
diag = rm.get("diagnostics") or {}
print("[reviewMetadata.diagnostics.quality] %s" % diag.get("quality"))
llm = diag.get("llm") or {}
print("[llm] calls=%s failures=%s retries=%s schemaFailures=%s" % (
    llm.get("calls"), llm.get("failures"), llm.get("retries"), llm.get("schemaFailures")))
print("[embedCache] %s" % (tele.get("embedCache") or tele.get("semanticCache") or "n/a"))
print("[qualityBenchmark] %s" % (diag.get("qualityBenchmark") or "n/a"))

# ---- 4. 青天评分 ----
qt = doc.get("qingtianReview") or doc.get("qingtian") or {}
print("\n[青天评分] %s" % (qt if qt else "n/a"))

# ---- 5. P1-P4 销项 ----
print("\n[P1 基坑支护两可/截桩/深度数值]")
pat_amb = re.findall(r"[^。\n]{0,24}(?:按图纸实施|按实实施|或另[^。\n]{0,12}|（?或[^）\n]{0,18}）?)", md)
amb = [m for m in pat_amb if "基础" in m or "支护" in m or "桩" in m or "围护" in m or "形式" in m][:8]
print("   两可表述命中:", amb if amb else "无")
print("   截桩/截断桩基:", len(re.findall(r"截[断截]?(?:桩|灌注桩)", md)))
print("   深度数值 5.85/五点八五:", len(re.findall(r"5\.85|五点八五|5.85m", md)))
print("   基坑出现次数:", len(re.findall(r"基坑", md)))

print("\n[P2 劳动力口径]")
labor = re.findall(r"[^。\n]{0,10}(?:劳动力|作业人员)[^。\n]{0,20}?(?:约)?\s*([\d,]{2,4})\s*人", md)
print("   劳动力+人数:", [m for m in labor[:12]])
print("   高峰口径:", re.findall(r"[^。\n]{0,8}高峰[^。\n]{0,16}\d{2,4}人?", md)[:6])

print("\n[P3 施工流程重复]")
paras = [p.strip() for p in re.split(r"\n\s*\n", md) if len(p.strip()) >= 24]
fp = [re.sub(r"[\s\u3000-\u303f\uff00-\uffef，。；：、！？（）【】《》“”‘’…—·]+", "", p) for p in paras]
dups = [f for f, c in Counter(fp).items() if c >= 2]
print("   全文重复段落数:", len(dups), dups[:3] if dups else "")

print("\n[P4 基础形式两可]")
print("   桩基（或.*按图纸:", len(re.findall(r"桩基（?或[^）\n]{0,20}按图纸", md)))
print("   基础形式两可:", re.findall(r"[^。\n]{0,16}基础形式[^。\n]{0,20}", md)[:4])

print("\n[P 补充：表格占位符残留]")
print("   待定/若干/约\\d 单元格:", len(re.findall(r"\|\s*(?:待定|待补充|待确认|若干)\s*\|", md)))

print("\n[章节结构]")
h2 = re.findall(r"^## (.+)$", md, re.M)
print("   H2 数量:", len(h2), "| 重复 H2:", [k for k, c in Counter(h2).items() if c > 1])
h3 = re.findall(r"^### (.+)$", md, re.M)
print("   H3 数量:", len(h3), "| 重复 H3:", [k for k, c in Counter(h3).items() if c > 1][:6])
print("=" * 70)
