#!/usr/bin/env python3
"""缓存优化 P0/P1 真实生成 A/B 对账：六指标 vs 基线 doc-1788241775362。

基线（优化前，doc-1788241775362 聚合数据）：
  calls=134  inputTokens=42.2M  hit=11,296,128  miss=30,898,867（26.8%）
  schemaFailures=32  maxActive=19  layerChars.l3=64,104,426（95.7%）

用法：python3 .dbg/verify-cache-optimization.py <draft.json> [基线json]
输出：六指标 + 命中率 + 分层占比 + 与基线的 delta，便于逐项验收。

P0/P1 验收目标：
  - calls 下降（P1-1 评审复检瘦身、P1-4 截断免重试）
  - inputTokens / inputChars 下降 30~40%（P0-1 规划预算、P0-3 第二步瘦身、P0-4 预算收紧）
  - schemaFailures 32 → 个位数（P1-4 截断确定性修复）
  - hit/(hit+miss) 命中率上升（P0-2 L0 公共前缀、P1-3 同前缀相邻调度）
  - layerChars.l3 占比下降（P0-3/P0-4 证据瘦身）
"""
import json
import sys

DRAFT = sys.argv[1] if len(sys.argv) > 1 else None
BASELINE = sys.argv[2] if len(sys.argv) > 2 else None

if not DRAFT:
    print('用法: python3 .dbg/verify-cache-optimization.py <draft.json> [基线draft.json]')
    sys.exit(1)

BASELINE_METRICS = {
    'calls': 134,
    'inputTokens': 42_200_000,
    'hit': 11_296_128,
    'miss': 30_898_867,
    'schemaFailures': 32,
    'maxActive': 19,
    'l3': 64_104_426,
}


def metrics_of(path):
    d = json.load(open(path))
    rm = d.get('reviewMetadata') or {}
    llm = (rm.get('diagnostics') or {}).get('llm') or {}
    layers = llm.get('layerChars') or {}
    layer_total = layers.get('l0', 0) + layers.get('l1', 0) + layers.get('l2', 0) + layers.get('l3', 0)
    hit = llm.get('promptCacheHitTokens') or 0
    miss = llm.get('promptCacheMissTokens') or 0
    total = hit + miss
    return {
        'status': d.get('status'),
        'wordCount': d.get('wordCount'),
        'elapsedMs': d.get('elapsedMs'),
        'calls': llm.get('calls'),
        'failures': llm.get('failures'),
        'retries': llm.get('retries'),
        'schemaFailures': llm.get('schemaFailures'),
        'maxActive': llm.get('maxActive'),
        'inputTokens': llm.get('inputTokens'),
        'outputTokens': llm.get('outputTokens'),
        'inputChars': llm.get('inputChars'),
        'hit': hit,
        'miss': miss,
        'hitRate': round(hit * 10000 / total) / 100 if total > 0 else None,
        'layerTotal': layer_total,
        'l0': layers.get('l0', 0), 'l1': layers.get('l1', 0), 'l2': layers.get('l2', 0), 'l3': layers.get('l3', 0),
    }


def delta_row(label, cur, base, unit=''):
    if base is None:
        return f'{label}: {cur}{unit}'
    d = cur - base
    return f'{label}: {cur}{unit}（基线 {base}{unit}，Δ {d:+}{unit} / {d / base * 100:+.1f}%）'


m = metrics_of(DRAFT)
base = metrics_of(BASELINE) if BASELINE else None
bl = {**BASELINE_METRICS, **(base or {})}

print('=' * 76)
print(f"docId={DRAFT.split('/')[-1]}  status={m['status']}  wordCount={m['wordCount']}  elapsed={m['elapsedMs']}ms")
print('=' * 76)
print(delta_row('LLM calls', m['calls'], bl.get('calls')))
print(delta_row('inputTokens', m['inputTokens'], bl.get('inputTokens')))
print(delta_row('inputChars', m['inputChars'], bl.get('inputChars')))
print(delta_row('schemaFailures', m['schemaFailures'], bl.get('schemaFailures')))
print(f"maxActive: {m['maxActive']}（基线 {bl.get('maxActive')}）")
print(f"命中率: {m['hitRate']}%（基线 {bl.get('hitRate')}% 或聚合口径 26.8%）；hit={m['hit']} miss={m['miss']}")
if m['hit'] and bl.get('hit'):
    print(f"  hit Δ {m['hit'] - bl['hit']:+} / miss Δ {m['miss'] - bl['miss']:+}")
if m['layerTotal']:
    l0r = m['l0'] / m['layerTotal'] * 100
    l3r = m['l3'] / m['layerTotal'] * 100
    print(f"分层: L0={m['l0']}({l0r:.1f}%) L1={m['l1']} L2={m['l2']} L3={m['l3']}({l3r:.1f}%)")
    print(f"  L3 占比 {l3r:.1f}%（基线 95.7%，目标下降）；L0 占比 {l0r:.1f}%")
print('=' * 76)
print('验收判定：')
checks = []
if m['calls'] is not None and bl.get('calls') and m['calls'] < bl['calls']:
    checks.append(('P1-1/P1-4 调用次数下降', 'PASS'))
elif m['calls'] is not None and bl.get('calls'):
    checks.append(('P1-1/P1-4 调用次数下降', f"FAIL（{m['calls']} vs 基线 {bl['calls']}）"))
if m['inputTokens'] is not None and bl.get('inputTokens'):
    ratio = m['inputTokens'] / bl['inputTokens']
    checks.append(('P0 输入总量下降 30~40%', 'PASS' if ratio <= 0.7 else f"PARTIAL（{ratio * 100:.0f}%，目标 ≤70%）"))
if m['schemaFailures'] is not None:
    checks.append(('P1-4 schema 失败个位数', 'PASS' if m['schemaFailures'] <= 9 else f"FAIL（{m['schemaFailures']} 次）"))
if m['hitRate'] is not None and bl.get('hitRate') is not None:
    checks.append(('P0-2/P1-3 命中率上升', 'PASS' if m['hitRate'] > bl['hitRate'] else f"FAIL（{m['hitRate']}% vs {bl['hitRate']}%）"))
elif m['hitRate'] is not None:
    checks.append(('命中率 > 26.8% 聚合基线', 'PASS' if m['hitRate'] > 26.8 else f"FAIL（{m['hitRate']}%）"))
for name, verdict in checks:
    print(f'  [{verdict.split()[0] if verdict.startswith("PASS") or verdict.startswith("FAIL") or verdict.startswith("PARTIAL") else "?"}] {name}: {verdict}')
