#!/usr/bin/env python3
"""DeepSeek V4 prefix cache 行为实测：并发 vs 串行 vs 预热 三组对照。
每组使用完全独立的随机前缀（避免跨组缓存污染），每组 3 个请求共享前缀 P + 不同尾部。
观测 prompt_cache_hit_tokens / prompt_cache_miss_tokens。
"""
import json, time, urllib.request, concurrent.futures, random, string

cfg = json.load(open('/Users/pan/.customize-agent/config.json'))
prov = cfg['providers']['deepseek-v4-pro']
API_KEY = prov['apiKey']
BASE = prov['baseUrl'].rstrip('/')
MODEL = cfg['models']['reader']['list'][2]['name']

def make_prefix(tag: str) -> str:
    # ~3200 字符的中文工程文本前缀（逐组独立随机盐，确保跨组零复用）
    salt = ''.join(random.choices(string.ascii_letters, k=12))
    seg = (f'【{tag}-{salt}】本工程为框架剪力墙结构综合楼，地上十二层地下两层，总建筑面积约 18600 平方米，'
           f'基础采用筏板基础，主体结构混凝土强度等级 C35，钢筋采用 HRB400 级，'
           f'施工总工期 420 日历天，质量目标合格并确保市级优质工程奖。')
    return seg * 12  # ~3900 字符

def call(prefix: str, tail: str, max_tokens: int = 1):
    body = json.dumps({
        'model': MODEL,
        'messages': [
            {'role': 'system', 'content': '你是施工组织设计文档生成智能体。'},
            {'role': 'user', 'content': prefix + tail},
        ],
        'max_tokens': max_tokens,
        'temperature': 0,
        'stream': False,
    }).encode()
    req = urllib.request.Request(f'{BASE}/chat/completions', data=body,
                                 headers={'Authorization': f'Bearer {API_KEY}', 'Content-Type': 'application/json'})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read())
    u = data.get('usage', {})
    return {'hit': u.get('prompt_cache_hit_tokens'), 'miss': u.get('prompt_cache_miss_tokens'),
            'prompt': u.get('prompt_tokens'), 'ms': int((time.time() - t0) * 1000)}

def run_group(name: str, mode: str):
    p = make_prefix(name)
    tails = [f'\n\n【任务{i}】请针对第{i}号施工段的流水组织写出三条具体措施（200字内）。' for i in (1, 2, 3)]
    print(f'\n=== {name}（{mode}）前缀 {len(p)} 字符 ===', flush=True)
    if mode == 'concurrent':
        with concurrent.futures.ThreadPoolExecutor(3) as ex:
            rs = list(ex.map(lambda t: call(p, t), tails))
    elif mode == 'serial':
        rs = [call(p, t) for t in tails]
    elif mode == 'warmup':
        # 修正：预热输入 = 纯前缀 P（无尾部），落盘单元 [P]；任务请求 P+tail 以其为严格前缀 → 命中 P
        w = call(p, '', max_tokens=1)
        print(f'  预热(纯前缀): hit={w["hit"]} miss={w["miss"]} prompt={w["prompt"]} {w["ms"]}ms', flush=True)
        with concurrent.futures.ThreadPoolExecutor(3) as ex:
            rs = list(ex.map(lambda t: call(p, t), tails))
    for i, r in enumerate(rs):
        total = (r['hit'] or 0) + (r['miss'] or 0)
        rate = f"{(r['hit'] or 0) / total * 100:.1f}%" if total else '-'
        print(f'  请求{i+1}: hit={r["hit"]} miss={r["miss"]} prompt={r["prompt"]} 命中率={rate} {r["ms"]}ms', flush=True)

if __name__ == '__main__':
    run_group('A-并发组', 'concurrent')
    run_group('B-串行组', 'serial')
    run_group('C-预热组', 'warmup')
