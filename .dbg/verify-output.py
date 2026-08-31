#!/usr/bin/env python3
"""产物验证：基坑参数 / 脏标题 / 泄漏文本 / H4 结构 / 跨节重复 / 表格密度 / 首节顺序
/ PDF 第残片 / 表格断行残行 / 六个百分百 / 评标纪律承诺。

与 apps/server 侧检测口径对齐：
- sanitizeFormalMarkdown 的 H4 词尾严格重复清洗（markdownComposer.ts L371）
- sectionHeadingIssues 的 H4 滑窗重复/同名/超长检测（markdownComposer.ts L252）
- sectionDuplicateIssues 的章内跨节重复句检测（markdownComposer.ts L312，24 字句、重合>=3 且 >=30%）
- tablePlanExecutionGaps 的 markdown 表格分隔行计数（constructionOrgTablePlan.ts）
- normalizeTenderSourcePageRefs/cleanInlineFactValue 的「PDF 第」残片清洗（模块B）
- mergeTableLineBreaks/qualityValidation 的表格断行检测（模块E）
- sixHundredPercentCoverageIssues 的六个百分百六项/拆迁豁免口径（模块D）
- stripBidDisciplineSentences 的评标纪律承诺禁写（模块C）

用法: python3 verify-output.py <markdown文件或draft.json>
环境变量: VERIFY_MIN_TABLES 覆盖表格块下限（默认大文档 40 / 小文档 15）
"""
import json
import os
import re
import sys

H4_COMMON_WORDS = ('安全', '管理', '施工', '质量', '工期', '进度', '保障', '体系', '措施', '控制',
                   '工程', '项目', '技术', '方案', '计划', '组织', '标准', '规范', '验收', '方法', '工艺', '文明', '绿色')
# 专业工程方案标准命名：主体为单一专业工程名，「施工方案」为固定后缀，不属多主题拼接
PROFESSIONAL_PLAN_SUFFIX_RE = re.compile(r'(?:工程施工方案|安装工程施工方案|专业工程施工方案|专项施工方案)$')
DEDUPE_MIN_SENTENCE_CHARS = 24
DEDUPE_REPEAT_RATIO = 0.3


def load_markdown(path_or_json):
    if path_or_json.endswith('.json'):
        data = json.load(open(path_or_json))
        doc = data.get('document', data)
        md = doc.get('markdown') or doc.get('content') or ''
        if md:
            return md, doc
    with open(path_or_json, encoding='utf-8') as f:
        return f.read(), {}


def sentence_fingerprint(sentence):
    return re.sub(r'[^\w\u4e00-\u9fff]', '', sentence).lower()


def main():
    path = sys.argv[1]
    md, doc = load_markdown(path)
    print(f'文档长度: {len(md)} 字')

    # 1. 基坑关键参数（真实数据资料：基坑支护图标注）
    pit_params = ['15.65', '基坑底标高', '换填底标高', '整平标高', '22.00', '±0.000', '±0.00', '坡率', '开挖深度', '放坡系数', '支护形式']
    print('\n=== 基坑关键参数 ===')
    pit_total = 0
    for kw in pit_params:
        count = md.count(kw)
        pit_total += count
        print(f'  {kw}: {count} 次')

    # 2. 脏标题（历史模式，应全 0；含改8 清单层粘连串——补挂 bug 历史产物）
    dirty_titles = ['3项规定', '委员会确定中', '56m15', '4对与评标活动', '如我方中标', '现场踏勘施工条件现场条件']
    print('\n=== 脏标题（应全 0）===')
    dirty_total = 0
    for kw in dirty_titles:
        count = md.count(kw)
        dirty_total += count
        print(f'  {kw}: {count} 次')

    # 3. 泄漏文本（LLM 内部话术泄漏）
    leak_texts = ['不一致，故', '修正为', '据此修正', '内部自查', '数据一致性', '已修正', '纠偏为', '统一为：']
    print('\n=== 泄漏文本（应全 0）===')
    leak_total = 0
    for kw in leak_texts:
        count = md.count(kw)
        leak_total += count
        print(f'  {kw}: {count} 次')

    lines = md.splitlines()

    # 4. H4 结构治理（对齐 sectionHeadingIssues + sanitize 清洗）
    print('\n=== H4 结构（应全 0）===')
    h4_strict_tail_dup = []   # 词尾严格等长重复（sanitize 应已清洗）
    h4_sliding_dup = []       # 非豁免 2 字滑窗重复
    h4_same_as_h3 = []        # 与三级小节同名
    h4_overlong = []          # 超长多主题拼接
    tertiary_titles = set()
    for line in lines:
        m = re.match(r'^###\s+(.+)$', line.strip())
        if m:
            tertiary_titles.add(re.sub(r'^\d+(?:\.\d+)*\s*', '', m.group(1).strip()))
    for index, line in enumerate(lines):
        m = re.match(r'^####\s+(.+)$', line.strip())
        if not m:
            continue
        title = m.group(1).strip()
        plain = re.sub(r'^\d+(?:\.\d+)*\s*', '', title).strip()
        if not plain:
            continue
        # 词尾严格等长重复：尾部 2-4 字符组相邻重复（如「现场条件现场条件」）
        m2 = re.search(r'(.*?)(.{2,4})\2$', plain)
        if m2:
            h4_strict_tail_dup.append(f'第{index + 1}行: {title}')
            continue
        # 与三级小节同名
        if plain in tertiary_titles or title in tertiary_titles:
            h4_same_as_h3.append(f'第{index + 1}行: {title}')
            continue
        # 非豁免 2 字滑窗重复
        counts = {}
        for i in range(len(plain) - 1):
            pair = plain[i:i + 2]
            if pair in H4_COMMON_WORDS:
                continue
            counts[pair] = counts.get(pair, 0) + 1
        dups = [w for w, c in counts.items() if c >= 2]
        if dups:
            h4_sliding_dup.append(f'第{index + 1}行: {title}（重复词：{"、".join(dups)}）')
            continue
        if len(plain) > 14 and not PROFESSIONAL_PLAN_SUFFIX_RE.search(plain):
            h4_overlong.append(f'第{index + 1}行: {title}（{len(plain)} 字）')
    for label, items in [('词尾粘连', h4_strict_tail_dup), ('滑窗重复', h4_sliding_dup), ('与###同名', h4_same_as_h3), ('超长拼接', h4_overlong)]:
        print(f'  {label}: {len(items)}')
        for item in items[:5]:
            print(f'    - {item}')

    # 4.5 ### 层标题粘连（改8：对齐清单层 cleanSectionTitleArtifacts 口径，应全 0）
    print('\n=== ### 标题粘连（应全 0）===')
    tertiary_tail_dup = []
    for index, line in enumerate(lines):
        m = re.match(r'^###\s+(.+)$', line.strip())
        if not m:
            continue
        plain = re.sub(r'^\d+(?:\.\d+)*\s*', '', m.group(1).strip())
        if re.search(r'(.*?)(.{2,4})\2$', plain):
            tertiary_tail_dup.append(f'第{index + 1}行: {m.group(1).strip()}')
    print(f'  ### 词尾粘连: {len(tertiary_tail_dup)}')
    for item in tertiary_tail_dup[:5]:
        print(f'    - {item}')

    # 5. 跨节重复句（对齐 sectionDuplicateIssues）
    print('\n=== 跨节重复（应全 0）===')
    chapters = []
    chapter = None
    section = None
    for line in lines:
        h2 = re.match(r'^##\s+(.+)$', line.strip())
        if h2:
            if chapter:
                chapters.append(chapter)
            chapter = {'title': h2.group(1).strip(), 'sections': []}
            section = None
            continue
        h3 = re.match(r'^###\s+(.+)$', line.strip())
        if h3 and chapter:
            section = {'title': h3.group(1).strip(), 'sentences': []}
            chapter['sections'].append(section)
            continue
        if re.match(r'^####\s+', line.strip()):
            continue
        if not section:
            continue
        cleaned = re.sub(r'^#{1,6}\s+', '', line).strip()
        if re.match(r'^\|.*\|$', cleaned):
            continue
        for sentence in re.split(r'[。；;]', cleaned):
            trimmed = sentence.strip()
            if len(trimmed) >= DEDUPE_MIN_SENTENCE_CHARS:
                section['sentences'].append(sentence_fingerprint(trimmed))
    if chapter:
        chapters.append(chapter)
    dup_pairs = []
    for item in chapters:
        for i in range(len(item['sections'])):
            for j in range(i + 1, len(item['sections'])):
                left = set(item['sections'][i]['sentences'])
                right = set(item['sections'][j]['sentences'])
                if not left or not right:
                    continue
                overlap = sum(1 for s in left if s in right)
                ratio = overlap / min(len(left), len(right))
                if ratio >= DEDUPE_REPEAT_RATIO and overlap >= 3:
                    dup_pairs.append(f"{item['title']}：{item['sections'][i]['title']} ↔ {item['sections'][j]['title']}（{overlap} 句重合 {int(ratio * 100)}%）")
    print(f'  重复节对: {len(dup_pairs)}')
    for item in dup_pairs[:8]:
        print(f'    - {item}')

    # 6. 表格块密度（分隔行计数，对齐 markdownTableCount）
    table_blocks = sum(1 for line in lines if re.match(r'^\s*\|?\s*:?-{3,}:?', line) and '|' in line)
    # 表格下限按文档规模分档：6 万+ → 40（旧大规模口径）、3~6 万 → 20、3 万以下 → 15
    min_tables = int(os.environ.get('VERIFY_MIN_TABLES', 40 if len(md) > 60000 else (20 if len(md) > 30000 else 15)))
    print(f'\n=== 表格密度 ===')
    print(f'  表格块: {table_blocks}（下限 {min_tables}）')

    # 6.5 表格结构（改9：应全 0）——表头粘连/无表头表格/重复标签/粗体伪标签/词中断空格
    print('\n=== 表格与标签结构（应全 0）===')
    glued_headers = []
    headerless_tables = []
    for index, line in enumerate(lines):
        s = line.strip()
        if not s or s.startswith('|') or s.startswith('#'):
            continue
        nxt = lines[index + 1].strip() if index + 1 < len(lines) else ''
        if not nxt.startswith('|'):
            continue
        if re.search(r'(\|\s*[^|\n]{1,40}\s*){2,}\|\s*$', s):
            glued_headers.append(f'第{index + 1}行: ...{s[-50:]}')
        if re.match(r'^\|[\s:|-]+\|\s*$', nxt):
            headerless_tables.append(f'第{index + 2}行: 分隔行前无表头')
    dup_labels = [f'第{i + 1}行' for i, l in enumerate(lines) if re.search(r'(施工概况|施工流程|施工方法)[:：]\s*\*\*\s*(施工概况|施工流程|施工方法)', l)]
    bold_labels = [f'第{i + 1}行' for i, l in enumerate(lines) if re.search(r'\*\*(施工概况|施工流程|施工方法)[:：]?\*\*', l)]
    word_breaks = []
    for index, line in enumerate(lines):
        # 与 TS 端 cleanChineseWordBreakSpaces 同口径：排除「第X章 标题」章序号合法空格
        if re.match(r'^(?:#{1,6}\s+)?第[一二三四五六七八九十百千\d]+章\s+', line.strip()):
            continue
        if re.search(r'[\u4e00-\u9fa5][ \t\u00a0\u3000]+[\u4e00-\u9fa5]', line):
            word_breaks.append(f'第{index + 1}行: ...{line.strip()[:60]}')
    for label, items in [('表头粘连正文', glued_headers), ('无表头表格', headerless_tables), ('重复标签', dup_labels), ('粗体伪标签', bold_labels), ('词中断空格', word_breaks)]:
        print(f'  {label}: {len(items)}')
        for item in items[:4]:
            print(f'    - {item}')

    # 6.6 目录三级残留（本轮修复：目录只收章标题+二级小节，4 空格缩进行属三级残留，应全 0）
    print('\n=== 目录三级残留（应全 0）===')
    toc_tertiary_rows = []
    in_toc = False
    for index, line in enumerate(lines):
        s = line.strip()
        if s == '## 目录':
            in_toc = True
            continue
        if in_toc:
            if s.startswith('<div') or s.startswith('## '):
                break
            if line.startswith('    ') and s and not s.startswith('#'):
                toc_tertiary_rows.append(f'第{index + 1}行: {s[:50]}')
    print(f'  目录三级残留行: {len(toc_tertiary_rows)}')
    for item in toc_tertiary_rows[:5]:
        print(f'    - {item}')

    # 6.8 PDF 第残片（模块B：对齐 normalizeTenderSourcePageRefs/cleanInlineFactValue 清洗链，应全 0）
    # 清洗链已把完整页码引用（PDF 第N页）归一为“相关资料”并删除残缺残片，
    # 最终产物任何「PDF 第」形态都属清洗缺口，全部报出
    print('\n=== PDF 第残片（应全 0）===')
    pdf_residues = []
    for index, line in enumerate(lines):
        if re.search(r'PDF\s*第', line):
            pdf_residues.append(f'第{index + 1}行: ...{line.strip()[:60]}')
    print(f'  残缺「PDF 第」残片: {len(pdf_residues)}')
    for item in pdf_residues[:5]:
        print(f'    - {item}')

    # 6.9 表格断行残行（模块E：对齐 mergeTableLineBreaks/qualityValidation 检测口径，应全 0）
    print('\n=== 表格断行残行（应全 0）===')
    broken_rows = []
    for index, line in enumerate(lines):
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        prev = lines[index - 1].strip() if index > 0 else ''
        prev_is_row = prev.startswith('|') and '|' in prev
        if not prev_is_row:
            continue
        # 单竖线残行：行尾 |、行内仅 1 个 |（断裂在上一表格行的续行，渲染即空单元格）
        if s.endswith('|') and s.count('|') == 1:
            broken_rows.append(f'第{index + 1}行: ...{s[:60]}')
            continue
        # 断行溢出：非 | 开头但含 ≥2 个 | 的单元格内换行续行
        if not s.startswith('|') and s.count('|') >= 2:
            broken_rows.append(f'第{index + 1}行: ...{s[:60]}')
    print(f'  断行残行: {len(broken_rows)}')
    for item in broken_rows[:5]:
        print(f'    - {item}')

    # 6.10 六个百分百（模块D：六项标准名全命中，或拆迁项显式豁免；对齐 sixHundredPercentCoverageIssues）
    print('\n=== 六个百分百 ===')
    six_items = ['工地周边100%围挡', '物料堆放100%覆盖', '出入车辆100%冲洗', '施工现场地面100%硬化', '拆迁工地100%湿法作业', '渣土车辆100%密闭运输']
    six_hits = [item for item in six_items if item in md]
    six_missing = [item for item in six_items if item not in six_hits]
    # 豁免句必须带工程主语 + 短距否定词（与 sixHundredPercentCoverageIssues 同口径）：
    # 任意语境「不涉及拆迁」类短语（如“临时设施不涉及拆迁补偿”）不代表项目整体无拆迁工程
    demolition_exempt = bool(re.search(r'(?:本项目|本工程|该工程|该项目|本标段|本施工项目)[^。；;\n]{0,30}(?:无拆迁|不涉及拆迁|无房屋拆除|无拆除)', md))
    print(f'  命中: {len(six_hits)}/6（{"、".join(six_hits) if six_hits else "无"}）')
    if six_missing:
        print(f'  缺失: {"、".join(six_missing)}')
    print(f'  拆迁豁免说明: {"有" if demolition_exempt else "无"}')
    six_ok = len(six_missing) == 0 or (six_missing == ['拆迁工地100%湿法作业'] and demolition_exempt)

    # 6.11 评标纪律承诺（模块C：商务投标函内容不得进技术标，应全 0）
    print('\n=== 评标纪律承诺（应全 0）===')
    bid_hits = []
    for index, line in enumerate(lines):
        if re.search(r'评标纪律|行贿|打招呼|递条子|廉洁承诺|干扰评标', line):
            bid_hits.append(f'第{index + 1}行: ...{line.strip()[:60]}')
    print(f'  命中: {len(bid_hits)}')
    for item in bid_hits[:5]:
        print(f'    - {item}')

    # 7. 首节顺序：编制说明与工程概况应为第一章第一节
    print('\n=== 首节顺序 ===')
    first_h3 = ''
    for line in lines:
        m = re.match(r'^###\s+(.+)$', line.strip())
        if m:
            first_h3 = re.sub(r'^\d+(?:\.\d+)*\s*', '', m.group(1).strip())
            break
    order_ok = bool(re.search(r'编制说明|工程概况', first_h3)) if first_h3 else False
    print(f'  第一个 ### 小节: {first_h3 or "（无）"} → {"符合" if order_ok else "不符合（应含编制说明/工程概况）"}')

    # 汇总
    h4_total = len(h4_strict_tail_dup) + len(h4_sliding_dup) + len(h4_same_as_h3) + len(h4_overlong)
    print('\n=== 汇总 ===')
    print(f'基坑参数总命中: {pit_total}（{len([kw for kw in pit_params if kw in md])}/{len(pit_params)} 类参数出现）')
    print(f'脏标题总数: {dirty_total}')
    print(f'泄漏文本总数: {leak_total}')
    print(f'H4 结构问题: {h4_total}')
    print(f'跨节重复节对: {len(dup_pairs)}')
    print(f'表格块: {table_blocks}/{min_tables}')
    print(f'PDF 第残片: {len(pdf_residues)}')
    print(f'表格断行残行: {len(broken_rows)}')
    print(f'六个百分百: {len(six_hits)}/6{"（拆迁项豁免）" if demolition_exempt else ""}')
    print(f'评标纪律承诺: {len(bid_hits)}')
    print(f'首节顺序: {"PASS" if order_ok else "FAIL"}')
    checks = [
        pit_total >= 3,
        dirty_total == 0,
        leak_total == 0,
        h4_total == 0,
        len(tertiary_tail_dup) == 0,
        len(dup_pairs) == 0,
        table_blocks >= min_tables,
        order_ok,
        len(glued_headers) == 0,
        len(headerless_tables) == 0,
        len(dup_labels) == 0,
        len(bold_labels) == 0,
        len(word_breaks) == 0,
        len(toc_tertiary_rows) == 0,
        len(pdf_residues) == 0,
        len(broken_rows) == 0,
        six_ok,
        len(bid_hits) == 0,
    ]
    verdict = 'PASS' if all(checks) else 'FAIL'
    print(f'结论: {verdict}')
    return 0 if verdict == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
