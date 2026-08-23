#!/usr/bin/env python3
"""施组文档质量对比分析：我方生成 vs 参考入围文件"""
import re, sys, json

def load(path):
    return open(path, encoding='utf-8').read()

def count(text, pat):
    return len(re.findall(pat, text, re.M))

def stats(name, text):
    s = {}
    s['name'] = name
    s['chars'] = len(text)
    s['chapters'] = count(text, r'^##\s+')
    s['sections'] = count(text, r'^###\s+')
    s['blocks'] = count(text, r'^####\s+')
    s['param_mentions'] = count(text, r'\d+(?:\.\d+)?\s*(?:mm|cm|m2|m³|㎡|MPa|kN|kV|kW|℃|日历天|台|套|座|m|t|kg|%|级|层|h|天)')
    s['param_per_1k'] = round(s['param_mentions'] / max(1, len(text)) * 1000, 1)
    actions = '|'.join(['采用', '浇筑', '铺设', '焊接', '绑扎', '砌筑', '抹灰', '涂刷', '敷设', '压实', '养护', '试验', '调试', '测量', '放线', '验收', '检测', '复试', '吊装', '灌注', '埋设', '开挖', '回填', '安装', '拆除', '固定', '连接', '施工'])
    s['action_mentions'] = count(text, actions)
    s['action_per_1k'] = round(s['action_mentions'] / max(1, len(text)) * 1000, 1)
    s['accept_mentions'] = count(text, r'验收|检测|试验|复试|实测|闭水|探伤|试块|测试|检查|记录')
    s['empty_phrases'] = count(text, r'按规范施工|结合实际执行|严格按照.*执行|具体情况具体分析|按相关规定|参照相关标准')
    s['boilerplate'] = count(text, r'确保工程质量|确保施工安全|精心组织|科学管理|高标准|严要求')
    s['listing'] = count(text, r'[：:]\s*\d+(?:\.\d+)?\s*(?:台|套|个|座|m|m2|㎡|m³|kg|t|组|根|扇|樘|块|件)')
    s['process_arrows'] = count(text, r'→')
    s['tables'] = count(text, r'^\|.*\|\s*$')
    return s

def method_blocks(text):
    methods = []
    for m in re.finditer(r'施工方法[:：]?([^\n]*(?:\n(?![#\s]*(?:施工|####))[^\n]*)*)', text):
        methods.append(m.group(1).strip())
    return methods

def analyze_methods(name, text):
    ms = method_blocks(text)
    if not ms:
        return {'name': name, 'method_blocks': 0, 'samples': []}
    samples = []
    weak = 0
    strong = 0
    for mm in ms:
        if len(mm) < 20: continue
        has_action = bool(re.search(r'采用|浇筑|铺设|焊接|绑扎|砌筑|抹灰|涂刷|敷设|压实|养护|试验|调试|测量|放线|验收|检测|复试|吊装|灌注|埋设|开挖|回填|固定|连接|安装|拆除', mm))
        has_param = bool(re.search(r'\d+(?:\.\d+)?\s*(?:mm|cm|m2|㎡|m³|MPa|kN|kV|kW|℃|台|套|座|m|t|kg|%|级|层|h|天|毫米|厘米|米|立方米|平方米|吨|公斤)', mm))
        has_accept = bool(re.search(r'验收|检测|试验|复试|实测|闭水|探伤|试块|测试|检查|记录|报告', mm))
        listing = len(re.findall(r'[：:]\s*\d+(?:\.\d+)?\s*(?:台|套|个|座|m|m2|㎡|m³|kg|t|组|根|扇|樘|块|件)', mm))
        if has_action and has_param: strong += 1
        elif listing >= 3 or (len(mm) > 30 and not has_action): weak += 1
        samples.append({'len': len(mm), 'action': has_action, 'param': has_param, 'accept': has_accept, 'listing': listing, 'head': mm[:90]})
    return {'name': name, 'method_blocks': len(ms), 'strong': strong, 'weak': weak,
            'strong_ratio': round(strong / max(1, len(ms)), 2), 'samples': samples}

if __name__ == '__main__':
    mine_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/real-gen-18-output.md'
    ref_path = sys.argv[2] if len(sys.argv) > 2 else '/tmp/reference-pdf-text.txt'
    mine = load(mine_path)
    ref = load(ref_path)
    report = {'mine': stats('我方生成', mine), 'ref': stats('参考入围文件', ref),
              'mine_methods': analyze_methods('我方生成', mine), 'ref_methods': analyze_methods('参考入围文件', ref)}
    print(json.dumps(report, ensure_ascii=False, indent=1))
