#!/usr/bin/env python3
"""4.12.15 真实生成对账：事实零丢失（基线参数集 ⊆ 新文档）+ 耗时对比。

用法: python3 verify-realgen-4.12.15.py <基线json> <新json>
"""
import json
import re
import sys

PARAM_RE = re.compile(r'\d+(?:\.\d+)?\s*(?:mm|cm|m|km|㎡|m²|m3|m³|kg|t|MPa|kPa|℃|%|台|套|个|日历天|天|周|个月|月|万元|亿元|元)\b')
STD_RE = re.compile(r'(?:GB\s*/?\s*T?|JGJ|CJJ|DB\s*/?\s*T?|CECS|ISO|IEC)\s*[\w./-]*\d[\w./-]*')
KEYWORDS = ['基坑底标高', '换填底标高', '整平标高', '±0.000', '坡率', '开挖深度', '放坡系数', '支护形式',
            '计划工期', '合同工期', '质量标准', '总建筑面积', '建设规模', '混凝土强度', '钢筋',
            '抗渗等级', '垫层', '防水等级', '绿色建筑', '创优目标', '履约保证金', '缺陷责任期']

def load(path):
    d = json.load(open(path)).get('document', {})
    return d, d.get('markdown') or ''

def extract_params(md):
    return set(PARAM_RE.findall(md))

def extract_stds(md):
    return set(STD_RE.findall(md))

def main():
    base_doc, base_md = load(sys.argv[1])
    new_doc, new_md = load(sys.argv[2])
    print(f'基线文档: {len(base_md)} 字 | 新文档: {len(new_md)} 字')
    dur = (new_doc.get('completedAt') or 0) - (new_doc.get('createdAt') or 0)
    base_dur = (base_doc.get('completedAt') or 0) - (base_doc.get('createdAt') or 0)
    print(f'基线耗时: {base_dur/60000:.1f} min | 新文档耗时: {dur/60000:.1f} min')

    base_params = extract_params(base_md)
    new_params = extract_params(new_md)
    missing = sorted(base_params - new_params)
    print(f'\n=== 参数对账（基线 {len(base_params)} 个 → 新文档缺失 {len(missing)} 个）===')
    for p in missing[:40]:
        print(f'  缺失: {p}')

    base_stds = extract_stds(base_md)
    new_stds = extract_stds(new_md)
    missing_stds = sorted(base_stds - new_stds)
    print(f'\n=== 规范编号对账（基线 {len(base_stds)} 个 → 缺失 {len(missing_stds)} 个）===')
    for s in missing_stds[:20]:
        print(f'  缺失: {s}')

    print('\n=== 关键事实关键词 ===')
    for kw in KEYWORDS:
        b = base_md.count(kw)
        n = new_md.count(kw)
        flag = 'OK' if n > 0 or b == 0 else 'MISSING'
        print(f'  {kw}: 基线 {b} 次 / 新 {n} 次 {flag}')

    print('\n=== 泄漏/脏文本（应为 0）===')
    for bad in ['WRITER_MISSING_SECTION', '工作包', '已确认资料', '上表合计行', '后台', '系统证据清单', 'PDF 第']:
        c = new_md.count(bad)
        print(f'  {bad}: {c} 次', 'FAIL' if c > 0 else '')

if __name__ == '__main__':
    main()
