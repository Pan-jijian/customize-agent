#!/bin/bash
# 4.13.1 项目理解缓存重建 → gap 收敛验证（评标办法/评审/地质勘察 + 泛化声称清理）
BASE="http://localhost:17321"
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
CACHE_DIR="$HOME/.customize-agent/projects/3c3f04667c69/project-intelligence"

echo "[$(date +%H:%M:%S)] 删除旧项目理解缓存"
rm -rf "$CACHE_DIR/cache.json" "$CACHE_DIR/project-intelligence.json" "$CACHE_DIR/scopes" 2>/dev/null

echo "[$(date +%H:%M:%S)] 触发项目理解缓存重建（同步，可能较久）"
curl -s -X POST "$BASE/api/kb/intelligence" -H "Content-Type: application/json" \
  -d "{\"projectRoot\":\"$PROJECT_ROOT\"}" --max-time 900 -o /tmp/intelligence-resp.json
python3 -c "
import json
d=json.load(open('/tmp/intelligence-resp.json'))
c=d.get('cache') or {}
print('cache version:', c.get('version'), 'createdAt:', c.get('createdAt'), 'facts:', c.get('factCount'), 'intents:', c.get('intentCount'))
" 2>/dev/null

echo "[$(date +%H:%M:%S)] 验证 gaps 收敛"
python3 -c "
import json
d=json.load(open('$CACHE_DIR/project-intelligence.json'))
g=d.get('projectGraph',{})
gaps=g.get('gaps',[])
print('total gaps:', len(gaps))
for i,x in enumerate(gaps): print(f' {i+1}.', x)
bad=[x for x in gaps if ('评标办法' in x or '评审' in x or '地质勘察' in x or '地勘' in x or '土壤氡' in x)]
print('IRRELEVANT_RESIDUAL:', len(bad))
reqs=g.get('requirements',[])
badreq=[r for r in reqs if r.get('category')=='评标办法']
print('requirements category=评标办法 残留:', len(badreq))
print('works:', len(g.get('works',[])), 'methods:', len(g.get('methods',[])), 'resources:', len(g.get('resources',[])),
      'schedule:', len(g.get('schedule',[])), 'standards:', len(g.get('standards',[])), 'risks:', len(g.get('risks',[])),
      'requirements:', len(reqs), 'addendumChanges:', len(g.get('addendumChanges',[])))
"
echo "ALL_DONE"
