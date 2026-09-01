#!/bin/bash
# 重索引：招标文件.pdf（K2 电子程序句）+ 16 个含 %%U/%%% 控制码的 DWG（CAD 控制码还原）
# 逐个文件提交 reindex 任务并轮询完成
set -u
BASE="http://localhost:17321/api/kb/files/reindex"
PROJECT_ROOT="/Users/pan/Desktop/codeing/customize-agent"

FILES=(
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/招标文件.pdf"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/人防/合肥师范学院人防 施工图2026.08.05/人防建筑/平时说明，工程做法表_t8.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/人防/合肥师范学院人防 施工图2026.08.05/人防建筑/新一代信息技术产教融合实训基地项目20260715_t8.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/人防/合肥师范学院人防 施工图2026.08.05/人防电气/T3/战时配电平面_t3.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/人防/合肥师范学院人防 施工图2026.08.05/人防结构/结构说明 门框墙-合肥师范学院.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/合肥师范-智能化施工图 完整版/智能化平面图_t3.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/合肥师范-智能化施工图 完整版/火灾自动报警及广播平面图_t3.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/基坑支护/基坑支护设计20260710_X7（标注修改内容）.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/建筑/新一代信息技术产 教融合实训基地项目20260805-建筑专业/新一代信息技术产教融合实训基地项目20260803.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/抗震支架/深化图/合肥师范实训基地电气施工图2026.06.04/(3)20260604新一代信息技术产教融合实训基地项目--配电 .dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/暖通/暖通平面图.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/电气/合肥师范实训基地 电气施工图2026.08.04/(1)20260803新一代信息技术产教融合实训基地项目--封面目录说明.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/电气/合肥师范实训基地 电气施工图2026.08.04/(2)20260803新一代信息技术产教融合实训基地项目--系统图.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/电气/合肥师范实训基地 电气施工图2026.08.04/(6)20250803新一代信息技术产教融合实训基地项目--防雷接地.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/电气/合肥师范实训基地 电气施工图2026.08.04/(7)20260722新一代信息技术产教融合实训基地项目--总平.dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/结构/20260806合肥师范 实训基地结构施工图/20260806合肥师范实训基地结构施工图/(结施-0-01~05结构设计总说 明及)钢筋混凝土结构总说明(国家高规版).dwg"
"9.4合肥师范学院新一代信息技术产教融合实训基地项目/图纸/装配式/cad/合肥师范装 配式建筑设计总说明20260519.dwg"
)

FAILED=0
for f in "${FILES[@]}"; do
  resp=$(curl -s -X POST "$BASE" -H 'Content-Type: application/json' \
    -d "{\"projectRoot\":\"$PROJECT_ROOT\",\"relativePath\":\"$f\"}")
  op=$(echo "$resp" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('operationId',''))" 2>/dev/null)
  if [ -z "$op" ]; then
    echo "FAIL submit: $f => $resp"
    FAILED=$((FAILED+1))
    continue
  fi
  # 轮询 operations 完成
  for i in $(seq 1 180); do
    st=$(curl -s "http://localhost:17321/api/kb/operations?projectRoot=$PROJECT_ROOT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
jobs=d.get('jobs') or d.get('operations') or []
for j in jobs:
    if j.get('id')=='$op' or j.get('operationId')=='$op':
        print(j.get('status') or j.get('stage',''))
        break
else:
    print('')
" 2>/dev/null)
    case "$st" in
      completed|done|success) echo "OK   $f"; break;;
      failed|error) echo "FAIL $f ($st)"; FAILED=$((FAILED+1)); break;;
      *) sleep 5;;
    esac
  done
done
echo "=== done, failed=$FAILED ==="
