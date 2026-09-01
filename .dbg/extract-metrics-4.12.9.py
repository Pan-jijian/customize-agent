#!/usr/bin/env python3
"""4.12.9 回归六指标提取：从最终 draft 提取基线可比指标 + observe 数据（patchGuard/dedupe/分层统计）"""
import json
import sys

DRAFT = sys.argv[1] if len(sys.argv) > 1 else '/Users/pan/.customize-agent/projects/3c3f04667c69/generatedDocuments/drafts/doc-1788163992191-97f78c22.json'
d = json.load(open(DRAFT))
print('== 记录级 ==')
print('status:', d.get('status'))
print('wordCount:', d.get('wordCount'))
print('elapsedMs:', d.get('elapsedMs'))
print('templateName:', d.get('templateName'))

rm = d.get('reviewMetadata') or {}
diag = rm.get('diagnostics') or {}
llm = diag.get('llm') or {}
print('== 诊断级（reviewMetadata.diagnostics） ==')
print('llm.calls:', llm.get('calls'))
print('llm.failures:', llm.get('failures'), '| retries:', llm.get('retries'), '| schemaFailures:', llm.get('schemaFailures'), '| maxActive:', llm.get('maxActive'))
print('promptCacheHitTokens:', llm.get('promptCacheHitTokens'), '| missTokens:', llm.get('promptCacheMissTokens'))
if (llm.get('promptCacheHitTokens') or 0) + (llm.get('promptCacheMissTokens') or 0) > 0:
    rate = (llm.get('promptCacheHitTokens') or 0) / ((llm.get('promptCacheHitTokens') or 0) + (llm.get('promptCacheMissTokens') or 0))
    print('prefix cache 命中率（token 口径）: {:.2%}'.format(rate))
print('inputTokens:', llm.get('inputTokens'), '| outputTokens:', llm.get('outputTokens'), '| inputChars:', llm.get('inputChars'))
print('patchGuardHits:', llm.get('patchGuardHits'), '| patchGuardRejects:', llm.get('patchGuardRejects'))
print('qingtianDedupeHits:', llm.get('qingtianDedupeHits'), '| qingtianDedupeSkipped:', llm.get('qingtianDedupeSkipped'))
print('layerChars:', json.dumps(llm.get('layerChars'), ensure_ascii=False))
ev = diag.get('evidence') or {}
print('evidence.searchQueries:', ev.get('searchQueries'), '| contextChars:', ev.get('contextChars'), '| filteredNoise:', ev.get('filteredNoise'), '| budgetDropped:', ev.get('budgetDropped'))
q = diag.get('quality') or {}
print('quality: 阻断/重要/轻微 =', q.get('blockingCount'), '/', q.get('importantCount'), '/', q.get('minorCount'))

print('== 终检 stage ==')
for s in (d.get('executionStages') or []):
    role = s.get('roleId') or ''
    if role in ('agent-final-gate', 'document-delivery-score', 'document-professional-score', 'document-diagnostics', 'deterministic-consistency-fix', 'document-templating-report'):
        print(f"  [{s.get('status')}] {role}: {(s.get('message') or '')[:260]}")
print('== professionalScore（系统内） ==')
ps = rm.get('professionalScore') or {}
print(json.dumps({k: v for k, v in ps.items() if k != 'topIssues'}, ensure_ascii=False)[:600])
qr = rm.get('qualityReport') or {}
print('qualityReport.passed:', qr.get('passed'), '| deliveryProbability:', qr.get('deliveryProbability'), '| summary:', (qr.get('summary') or '')[:150])
tl = rm.get('telemetry') or {}
print('telemetry:', json.dumps(tl, ensure_ascii=False)[:300])
