#!/usr/bin/env python3
"""第六轮生成节点级把关 watcher（临时脚本，验收后删除）：
轮询 executionStages，任一节点出现根本性问题立即 abort 生成，等待人工排查修复。
判定标准：
  1. chapter_generation / fact_extraction 节点 status=failed（章节产出坏）
  2. 节点消息含兜底/空正文/占位符/LLM 余额类特征
  3. templating-repair failed 且套话占比 >10%（套话治理未达标）
  4. 消息含「缺少规划小节」类结构性缺失
记录全部节点进度到日志，abort 后退出码 2。
"""
import json, re, subprocess, sys, time

DOC_ID = 'doc-1788762127169-cbf441aa'
PROJECT_ROOT = '/Users/pan/Desktop/codeing/customize-agent'
BASE = 'http://localhost:17321'

BAILOUT_RE = re.compile(
    r'空正文|返回空|占位符|未抽取到结构化事实|结构化事实读取不足|'
    r'余额不足|Insufficient|402|缺少规划小节|小节内容补写未完成|'
    r'章节生成存在兜底|未返回有效章节正文')
TEMPLATE_RE = re.compile(r'套话句占比\s*([\d.]+)%')


def fetch_doc():
    try:
        r = subprocess.run(
            ['curl', '-s', '--max-time', '120',
             f'{BASE}/api/documents/generated/{DOC_ID}?projectRoot={PROJECT_ROOT}&lite=1'],
            capture_output=True, text=True, timeout=130)
        return json.loads(r.stdout).get('document')
    except Exception as e:
        print(f'[WATCHER] fetch error: {e}', flush=True)
        return None


def abort_generation(reason):
    print(f'[WATCHER] >>> BAILOUT: {reason}', flush=True)
    try:
        r = subprocess.run(
            ['curl', '-s', '--max-time', '20', '-X', 'POST',
             f'{BASE}/api/documents/generated', '-H', 'Content-Type: application/json',
             '-d', json.dumps({'action': 'abort', 'documentId': DOC_ID,
                               'projectRoot': PROJECT_ROOT})],
            capture_output=True, text=True, timeout=30)
        print(f'[WATCHER] abort response: {r.stdout[:150]}', flush=True)
    except Exception as e:
        print(f'[WATCHER] abort call error: {e}', flush=True)
    sys.exit(2)


def main():
    seen = set()
    print(f'[WATCHER] start watching {DOC_ID}', flush=True)
    while True:
        doc = fetch_doc()
        if doc is None:
            time.sleep(20)
            continue
        status = doc.get('status')
        stages = doc.get('executionStages') or []
        for s in stages:
            st = s.get('status', '')
            typ = s.get('type', '')
            msg = str(s.get('message', ''))
            key = (typ, s.get('roleId'), msg[:60])
            if key not in seen:
                seen.add(key)
                print(f'[NODE] {st:9s} | {typ:28s} | {msg[:100]}', flush=True)
            # 根本性问题判定
            if typ in ('chapter_generation', 'fact_extraction') and st == 'failed':
                abort_generation(f'产出节点 failed: {msg[:100]}')
            if BAILOUT_RE.search(msg):
                # templating 占比未达标 → 根本性（套话治理目标 ≤10%）
                m = TEMPLATE_RE.search(msg)
                if m and typ == 'llm_review' and float(m.group(1)) > 10:
                    abort_generation(f'套话占比 {m.group(1)}% 超达标线: {msg[:100]}')
                elif not m:
                    abort_generation(f'节点消息含根本性信号: {msg[:100]}')
        if status in ('completed', 'completed_with_issues', 'failed', 'aborted'):
            print(f'[WATCHER] FINAL status={status}', flush=True)
            if doc.get('error'):
                print(f'[WATCHER] error: {str(doc.get("error"))[:300]}', flush=True)
            print(f'[WATCHER] warningIssues count: {len(doc.get("warningIssues") or [])}', flush=True)
            sys.exit(0)
        time.sleep(15)


if __name__ == '__main__':
    main()
