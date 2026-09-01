#!/bin/bash
# 合肥师范学院项目召回验证：真实检索查询集
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"
BASE="http://localhost:17321/api/kb/search?projectRoot=${PROJECT_ROOT}&limit=5"

run_query() {
  local NAME="$1"; local Q="$2"
  echo "=== $NAME ==="
  echo "Q: $Q"
  curl -s "${BASE}&q=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$Q")" | python3 -c "
import json,sys
d=json.load(sys.stdin)
rs=d.get('results') or []
print(f'  命中 {len(rs)} 条, 用时 {d.get(\"queryTimeMs\",\"?\")}ms')
for r in rs[:5]:
    t=(r.get('title') or r.get('sectionTitle') or '')[:60]
    c=((r.get('content') or '')[:90]).replace(chr(10),' ')
    s=r.get('score')
    f=(r.get('filePath') or '')[:70]
    print(f'  [{s:.0f}] {t} | {c}')
    print(f'        file: {f}')
"
  echo
}

# 1. 招标文件事实
run_query "招标-工期" "本工程计划工期是多少日历天"
run_query "招标-质量目标" "工程质量目标要求"
run_query "招标-工程概况" "本项目总建筑面积和结构形式"

# 2. 清单数据
run_query "清单-土建分部分项" "平整场地 挖土方 工程量"
run_query "清单-安装" "智能化工程 工程量清单"

# 3. 补疑内容
run_query "补疑-实质回复" "开工日期是否调整 计划开工"

# 4. 图纸信息
run_query "图纸-混凝土强度" "混凝土强度等级 结构设计总说明"

# 5. 清洗反验证（K2 应已删除，命中应少或无）
run_query "反验证-公告程序段" "招标文件获取时间 投标截止时间 开标地点"
run_query "反验证-通用条款" "通用合同条款 违约 索赔"

# 6. 清洗反验证（K3 报价表应已删除）
run_query "反验证-清单报价" "综合单价 合价 暂估价"
