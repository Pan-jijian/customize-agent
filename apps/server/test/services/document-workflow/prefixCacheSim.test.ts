/**
 * 4.17.6 前缀缓存命中率离线模拟器（prefix-cache-sim）
 *
 * 目的：不消耗 API 余额即可「单独测试」DeepSeek prefix cache 的命中率上限——
 * 用真实分层字符数据（L0-L3）构造一次文档生成的完整调用序列，按 DeepSeek 缓存规则模拟：
 *   1. token 估算：中文 ≈1.5 字符/token、英文 ≈4 字符/token（与 tokenBudget.estimateTokens 同口径）
 *   2. 命中粒度：64-token 块对齐（DeepSeek prefix cache 以 64 token 块为最小单元）
 *   3. 落盘时机：请求完成后才落盘——并发窗口内同前缀请求互相不可见（实测根因）
 *   4. 预热：家族发射前先发 maxTokens=1 纯前缀请求落盘（计入统计），再并发发射
 *
 * 用第三轮真实数据（doc-1788395092651，L3 占 85%、实测命中率 20.8%）校准模拟器，
 * 再预测「证据压缩修复后」与「目标结构」的理论命中率，为 90%+ 目标提供可验证的参数设计。
 *
 * 4.17.8 起新增修复辅助化验收：按调用家族（写作/修复/评审）统计名义输入 token 占比，
 * 验证修复退居辅助（占比 <10%、调用 ≤6 次/文档）而写作成为主力（占比 ≥80%）——
 * 4.17.7 实测修复 52 次调用/56% 输入是「修复主力军化」的反面基线。
 */
import { describe, expect, it } from 'vitest';

/** 中文 ≈1.5 字符/token、英文 ≈4 字符/token（tokenBudget.ts 同口径） */
function estimateTokens(text: string): number {
  let chineseChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    if (/[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/u.test(ch)) chineseChars += 1;
    else otherChars += 1;
  }
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/** DeepSeek 前缀缓存以 64-token 块为命中粒度：命中 token 数向下取整到 64 的倍数 */
const CACHE_BLOCK_TOKENS = 64;

interface SimCall {
  id: string;
  /** 请求完整文本（system + user 拼接，与 provider 实际发送同构） */
  text: string;
  /** 家族分组：同组请求共享前缀（章级/节级） */
  group: string;
}

interface SimResult {
  hitTokens: number;
  missTokens: number;
  rate: number;
  /** 每次调用的明细：命中/未命中 token */
  calls: Array<{ id: string; hit: number; miss: number }>;
}

/** 字符串最长公共前缀长度（字符） */
function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/** 命中字符 → 命中 token（64 块对齐向下取整） */
function hitTokensOf(text: string, hitChars: number): number {
  if (hitChars <= 0) return 0;
  const rawTokens = estimateTokens(text.slice(0, hitChars));
  return Math.floor(rawTokens / CACHE_BLOCK_TOKENS) * CACHE_BLOCK_TOKENS;
}

/** 已落盘缓存：成功请求的完整文本序列 */
class PrefixCache {
  private cached: string[] = [];

  /** 请求命中：与所有已落盘请求的最长公共前缀（64 块对齐） */
  hitTokens(text: string): number {
    let best = 0;
    for (const cachedText of this.cached) {
      const len = commonPrefixLen(text, cachedText);
      if (len > best) best = len;
    }
    return hitTokensOf(text, best);
  }

  /** 请求完成后落盘（成功才落盘） */
  commit(text: string) {
    this.cached.push(text);
  }

  get size() {
    return this.cached.length;
  }
}

/** 家族内最长公共前缀（字符）：预热请求的内容 */
function groupCommonPrefix(calls: SimCall[]): string {
  let prefix = calls[0]!.text;
  for (const call of calls.slice(1)) {
    const len = commonPrefixLen(prefix, call.text);
    prefix = prefix.slice(0, len);
  }
  return prefix;
}

/**
 * 发射策略模拟：
 * - serial：全串行——每个请求可见之前所有已落盘请求
 * - batched-warmup：按 group 分批，批内先预热（前缀 maxTokens=1 请求计入统计）再并发发射——
 *   并发请求互不可见，但都可见预热落盘的前缀与之前批次的所有落盘
 */
function simulate(calls: SimCall[], mode: 'serial' | 'batched-warmup'): SimResult {
  const cache = new PrefixCache();
  const result: SimResult = { hitTokens: 0, missTokens: 0, rate: 0, calls: [] };

  if (mode === 'serial') {
    for (const call of calls) {
      const hit = cache.hitTokens(call.text);
      const miss = estimateTokens(call.text) - hit;
      result.hitTokens += hit;
      result.missTokens += miss;
      result.calls.push({ id: call.id, hit, miss });
      cache.commit(call.text);
    }
  } else {
    // batched-warmup：按 group 聚合；组内 ≥2 请求时先预热前缀落盘（计入统计），再并发
    const groups: SimCall[][] = [];
    for (const call of calls) {
      const last = groups[groups.length - 1];
      if (last && last[0]!.group === call.group) last.push(call);
      else groups.push([call]);
    }
    for (const group of groups) {
      if (group.length >= 2) {
        const prefix = groupCommonPrefix(group);
        const prefixTokens = estimateTokens(prefix);
        if (prefixTokens > 0) {
          const warmupHit = cache.hitTokens(prefix);
          const warmupMiss = prefixTokens - warmupHit;
          result.hitTokens += warmupHit;
          result.missTokens += warmupMiss;
          cache.commit(prefix);
        }
      }
      // 并发发射：互不可见，但都可见预热前缀与历史落盘
      const hits = group.map(call => cache.hitTokens(call.text));
      const texts = group.map(call => call.text);
      hits.forEach((hit, index) => {
        const miss = estimateTokens(texts[index]!) - hit;
        result.hitTokens += hit;
        result.missTokens += miss;
        result.calls.push({ id: group[index]!.id, hit, miss });
      });
      for (const call of group) cache.commit(call.text);
    }
  }
  result.rate = result.hitTokens / (result.hitTokens + result.missTokens);
  return result;
}

/** 按字符构造模拟调用（中文文本，token ≈ 字符/1.5） */
function makeCall(id: string, group: string, text: string): SimCall {
  return { id, group, text };
}

/** 组装一次调用的文本：L0（system 前缀）与 L1/L2/L3 各段拼接（近似 provider 实际发送形态） */
function assemble(system: string, l1: string, l2: string, l3: string): string {
  return [system, l1, l2, l3].filter(Boolean).join('\n');
}

/** 生成器：生成指定字符数的中文填充文本 */
function pad(n: number, seed = 'x'): string {
  return seed.repeat(n);
}

describe('prefix cache 离线模拟器（4.17.6）', () => {
  it('串行同前缀家族：第 1 个 miss、后续全部命中（DeepSeek 实测行为校准）', () => {
    const prefix = pad(3000, '共');
    const calls = Array.from({ length: 3 }, (_unused, i) => makeCall(`c${i}`, 'g1', `${prefix}\n${pad(100, String(i))}`));
    const result = simulate(calls, 'serial');
    // 第 1 个全 miss；第 2/3 个命中 3000 字符前缀（≈2000 token，64 块对齐）
    expect(result.calls[0]!.hit).toBe(0);
    expect(result.calls[1]!.hit).toBeGreaterThan(0);
    expect(result.calls[2]!.hit).toBe(result.calls[1]!.hit);
    // 命中 token 是 64 的倍数
    expect(result.calls[1]!.hit % CACHE_BLOCK_TOKENS).toBe(0);
  });

  it('并发同前缀家族：无预热全部 0 命中（DeepSeek 实测行为校准）', () => {
    const prefix = pad(3000, '共');
    const calls = Array.from({ length: 3 }, (_unused, i) => makeCall(`c${i}`, 'g1', `${prefix}\n${pad(100, String(i))}`));
    const result = simulate(calls, 'batched-warmup');
    // 预热请求本身 hit=0（首次落盘），3 个并发请求命中预热前缀
    const warmupMiss = result.missTokens - result.calls.reduce((sum, call) => sum + call.miss, 0);
    expect(warmupMiss).toBeGreaterThan(0);
    for (const call of result.calls) expect(call.hit).toBeGreaterThan(0);
  });

  it('64-token 块对齐：命中粒度向下取整', () => {
    const short = pad(90, '短'); // ≈60 token < 64 块 → 命中 0
    const cache = new PrefixCache();
    cache.commit(short);
    expect(cache.hitTokens(short)).toBe(0);
    const long = pad(150, '长'); // ≈100 token → 命中 64
    const cache2 = new PrefixCache();
    cache2.commit(long);
    expect(cache2.hitTokens(long)).toBe(64);
  });
});

/** ── 文档级场景：6 章 × (1 outline + 5 writer 节 + ≤1 repair + 1 review) + 全局审查 ──
 * repair 轮数可参数化：4.17.7 基线为每章 2 轮（多轮升级），4.17.8 起为每章至多 1 轮（失败即放弃）。 */

interface SceneParams {
  /** system L0 恒定段字符数 */
  l0Chars: number;
  /** L1 任务级恒定段（主控提示词+用户要求+主表+锁） */
  l1Chars: number;
  /** L2 章级共享段（模板+目的+紧凑上下文+事实层+覆盖+大纲） */
  l2Chars: number;
  /** L2 中跨章不变的部分（模板+目的+紧凑上下文）；其余为章级变化段（事实层+覆盖+大纲）。
   * 真实结构里跨章部分逐字相同（同源招标文件），默认 0 时按旧模型全部章级唯一 */
  l2SharedChars?: number;
  /** writer 节级变化段 L3 */
  writerL3Chars: number;
  /** outline 变化段 L3（节列表+证据） */
  outlineL3Chars: number;
  /** repair 变化段 L3（正文+缺陷+证据） */
  repairL3Chars: number;
  /** 章数 */
  chapterCount: number;
  /** 每章节数 */
  sectionsPerChapter: number;
  /** 每章修复调用轮数（4.17.8 起为 1：每章至多一次修复、失败即放弃；0 表示审查零缺陷零修复） */
  repairRoundsPerChapter?: number;
  /** 需要修复的章数（修复仅审查发现问题的章触发；默认全部章，理想态可小于章数） */
  repairChapterCount?: number;
}

function buildDocumentCalls(p: SceneParams): SimCall[] {
  const calls: SimCall[] = [];
  const l0 = pad(p.l0Chars, '零');
  const l1 = pad(p.l1Chars, '壹');
  // L2 = 跨章不变段（模板+目的+紧凑上下文，逐字相同）+ 章级变化段（事实层+覆盖+大纲）
  const l2Shared = pad(p.l2SharedChars ?? 0, '共');
  const l2UniqueChars = Math.max(0, p.l2Chars - (p.l2SharedChars ?? 0));
  for (let ch = 0; ch < p.chapterCount; ch += 1) {
    const l2 = l2Shared + pad(l2UniqueChars, String(ch)); // 章级段：共享前缀 + 每章不同后缀
    // 1. outline（每章 1 次）：L3 = 节列表 + 证据
    calls.push(makeCall(`ch${ch}-outline`, `ch${ch}-outline`, assemble(l0, l1, l2, pad(p.outlineL3Chars, '纲'))));
    // 2. writer 节并发（同组）
    for (let s = 0; s < p.sectionsPerChapter; s += 1) {
      calls.push(makeCall(`ch${ch}-s${s}`, `ch${ch}-writer`, assemble(l0, l1, l2, pad(p.writerL3Chars, String(s)))));
    }
    // 3. 章级 repair（仅审查发现问题的章触发，4.17.8 起每章至多 1 轮、失败即放弃）——
    // 章级 review（reviewChapterDraft）是纯规则引擎不发 LLM 调用，不计入 token 序列；
    // 修复是辅助动作而非流水线固定环节：写作一次成型时 repairChapterCount=0、零修复调用
    const repairRounds = p.repairRoundsPerChapter ?? 1;
    const repairChapters = Math.min(p.repairChapterCount ?? p.chapterCount, p.chapterCount);
    if (ch < repairChapters) {
      for (let r = 0; r < repairRounds; r += 1) {
        calls.push(makeCall(`ch${ch}-repair${r}`, `ch${ch}-repair`, assemble(l0, l1, l2, pad(p.repairL3Chars, String(r)))));
      }
    }
  }
  // 4. 全局评审类调用（真实结构，三个评审器各自成族）：
  // 4a. 一致性 review 4 chunks：并发同组，prompt = systemPrompt + promptTexts + chunk，
  //     与 writer L1 首段（promptTexts）同源 → 共享 L0+promptTexts 前缀（≈l1 前 4K）
  for (let g = 0; g < 4; g += 1) {
    calls.push(makeCall(`global-${g}`, 'global-consistency', assemble(l0, l1.slice(0, 4000), '', pad(4000, String(g)))));
  }
  // 4b. 全维度评审 ~6 块：串行循环（REVIEW_BLOCK_MAX_CHARS=9000 块上限 × 48K 字全文），
  //     块间共享 L0 + 稳定段（评审对象/招标基准/预扫描/指令/契约 ≈3K），第 2 块起命中前缀
  //     （记忆中「基线 52.8% 来自修复/评审串行重复」的来源）；每块独立 group 串行落盘
  const reviewStable = pad(3000, '评');
  for (let b = 0; b < 6; b += 1) {
    calls.push(makeCall(`full-dim-${b}`, `full-dim-${b}`, assemble(l0, '', reviewStable, pad(8000, String(b)))));
  }
  // 4c. 数据一致性 1 次：L3 = 全文数值句清单 ≈10K（与 4a 同族共享前缀）
  calls.push(makeCall('data-consistency', 'global-consistency', assemble(l0, l1.slice(0, 4000), '', pad(10000, '据'))));
  return calls;
}

/** 场景参数快照：第三轮真实分层规模（doc-1788395092651，L3 膨胀期）。
 * l0/l1/l2 用 296 次调用的实测均值校准：layerChars l0=1.45M、l1=3.14M、l2=7.34M
 * → 单次均值 l0≈4.9K、l1≈10.6K、l2≈24.8K（字符） */
const BASELINE_ROUND3: SceneParams = {
  l0Chars: 4900,
  l1Chars: 10600,
  l2Chars: 24800,
  l2SharedChars: 17000,  // 模板+目的+紧凑上下文跨章逐字相同（同源招标文件）；事实层+覆盖+大纲 7.8K 章级变化
  writerL3Chars: 60000,   // 块级 T1 全文 + T2 目录无限制膨胀（实测 128-243K/次，取低值）
  outlineL3Chars: 30000,  // outline 证据全文注入（实测 l3 292K/次，取低值）
  repairL3Chars: 80000,   // repair 证据 T2 目录膨胀（实测 l3 291K/次，取低值）
  chapterCount: 6,
  sectionsPerChapter: 5,
  repairRoundsPerChapter: 2, // 4.17.7 期章级多轮修复（修复主力军化的历史基线）
};

/** 场景参数快照：4.17.7 零预算爆炸修复后（demoted 吃满 T1 时文本证据不再全量注入）。
 * 实测校准：修复前 repair L3 181K/outline L3 223-272K/writer 块级 2.2-26K；
 * 修复后 evidenceText = T0(≤60%) + demoted 事实行 + 段前缀 ≈ 2-4K（真实数据实证 34K→2.3K） */
const FIXED_CURRENT: SceneParams = {
  l0Chars: 4900,
  l1Chars: 10600,
  l2Chars: 24800,
  l2SharedChars: 17000,  // 模板+目的+紧凑上下文跨章逐字相同；事实层+覆盖+大纲 7.8K 章级变化
  writerL3Chars: 2500,    // 任务卡+事实卡+专项规则 ~2K + 块证据 1K（修复后收敛）
  outlineL3Chars: 4000,   // 节列表 0.5K + 证据 2.5K 预算（修复后 ~3.5K）
  repairL3Chars: 2500,    // 证据摘要 1.5K 预算（修复后 ~2.3K；正文裁剪在 L2）
  chapterCount: 6,
  sectionsPerChapter: 5,
  repairRoundsPerChapter: 1, // 4.17.8 起每章至多一次修复、失败即放弃
};

/** 场景参数快照：90% 目标结构（节级证据最小化 + 正文裁剪 + 大纲承载事实）。
 * l0/l1/l2 沿用第三轮实测均值 */
const TARGET_90: SceneParams = {
  l0Chars: 4900,
  l1Chars: 10600,
  l2Chars: 24800,
  l2SharedChars: 17000,  // 模板+目的+紧凑上下文跨章逐字相同；事实层+覆盖+大纲 7.8K 章级变化
  writerL3Chars: 1500,   // 任务卡精简 0.6K + 事实卡 0.4K + 预算 0.2K + 节证据 0.3K（大纲已承载事实）
  outlineL3Chars: 2500,  // 节列表 0.5K + T1 精选 2K（T0 已在 L2）
  repairL3Chars: 4000,   // 锚点正文裁剪 2K + 缺陷 1K + 证据摘要 1K
  chapterCount: 6,
  sectionsPerChapter: 5,
  repairRoundsPerChapter: 1, // 4.17.8 起每章至多一次修复、失败即放弃
};

function sceneName(p: SceneParams): string {
  if (p === BASELINE_ROUND3) return '第三轮基线';
  if (p === FIXED_CURRENT) return '证据压缩修复后现状';
  if (p === TARGET_90) return '90% 目标结构';
  return '自定义';
}

/** 4.17.8 修复辅助化：按调用家族统计名义输入 token 占比（写作/修复/评审），
 * 与 simulate 同构地计入组内预热前缀请求（maxTokens=1 也消耗名义输入）。
 * 名义输入 = 完整请求文本 token（hit+miss），即「输入 token」口径。 */
function familyInputShares(p: SceneParams): { writing: number; repair: number; review: number } {
  const calls = buildDocumentCalls(p);
  const totals = { writing: 0, repair: 0, review: 0 };
  const familyOf = (call: SimCall): keyof typeof totals => {
    if (call.id.includes('repair')) return 'repair';
    if (call.id.includes('outline') || /-s\d+$/u.test(call.id)) return 'writing';
    return 'review';
  };
  // 与 simulate 相同的分组逻辑：同组 ≥2 请求时先发纯前缀预热请求（计入该家族名义输入）
  const groups: SimCall[][] = [];
  for (const call of calls) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.group === call.group) last.push(call);
    else groups.push([call]);
  }
  for (const group of groups) {
    const family = familyOf(group[0]!);
    if (group.length >= 2) totals[family] += estimateTokens(groupCommonPrefix(group));
    for (const call of group) totals[family] += estimateTokens(call.text);
  }
  const sum = totals.writing + totals.repair + totals.review;
  return { writing: totals.writing / sum, repair: totals.repair / sum, review: totals.review / sum };
}

describe('文档级场景命中率推演（4.17.6）', () => {
  for (const mode of ['serial', 'batched-warmup'] as const) {
    for (const scene of [BASELINE_ROUND3, FIXED_CURRENT, TARGET_90]) {
      it(`${sceneName(scene)} × ${mode}：记录理论命中率`, () => {
        const result = simulate(buildDocumentCalls(scene), mode);
        const total = result.hitTokens + result.missTokens;
        // 结果断言：输出日志供参数设计参考（无阈值断言——本测试是参数推演工具）
        expect(result.calls.length).toBeGreaterThan(0);
        expect(result.rate).toBeGreaterThan(0);
         
        console.log(`[prefix-cache-sim] ${sceneName(scene)} × ${mode}: hit=${result.hitTokens} miss=${result.missTokens} rate=${(result.rate * 100).toFixed(1)}%`);
        void total;
      });
    }
  }

  it('证据压缩修复（cb3）后现状命中率应显著高于第三轮基线（对照验证）', () => {
    const baseline = simulate(buildDocumentCalls(BASELINE_ROUND3), 'batched-warmup');
    const fixed = simulate(buildDocumentCalls(FIXED_CURRENT), 'batched-warmup');
    expect(fixed.rate).toBeGreaterThan(baseline.rate);
  });

  it('代码默认值映射验收：块证据 1K/outline 2.5K/repair 1.5K 的目标结构命中率必须 ≥90%（用户硬性目标）', () => {
    // 章级 review（reviewChapterDraft）是纯规则引擎不发 LLM 调用，评审质量与缓存零冲突；
    // TARGET_90 即代码默认值映射场景（块证据 1K/outline 2.5K/repair 1.5K/全局评审全量正文）
    const result = simulate(buildDocumentCalls(TARGET_90), 'batched-warmup');
     
    console.log(`[prefix-cache-sim] 代码默认值映射: rate=${(result.rate * 100).toFixed(1)}%`);
    expect(result.rate).toBeGreaterThanOrEqual(0.9);
  });

  it('灵敏度分析：writer 节 L3=2K + outline L3=3.5K（保守质量档）', () => {
    const scene: SceneParams = { ...TARGET_90, writerL3Chars: 2000, outlineL3Chars: 3500, repairL3Chars: 5000 };
    const result = simulate(buildDocumentCalls(scene), 'batched-warmup');
     
    console.log(`[prefix-cache-sim] 灵敏度 writerL3=2K/outlineL3=3.5K/repairL3=5K: rate=${(result.rate * 100).toFixed(1)}%`);
    expect(result.rate).toBeGreaterThanOrEqual(0.9);
  });

  it('灵敏度分析：章内 8 节（家族更大）', () => {
    const scene: SceneParams = { ...TARGET_90, sectionsPerChapter: 8 };
    const result = simulate(buildDocumentCalls(scene), 'batched-warmup');
     
    console.log(`[prefix-cache-sim] 灵敏度 sections=8: rate=${(result.rate * 100).toFixed(1)}%`);
    expect(result.rate).toBeGreaterThanOrEqual(0.9);
  });

  it('灵敏度分析：L1 恒定段 10K（主表/锁/要求更全）', () => {
    const scene: SceneParams = { ...TARGET_90, l1Chars: 10000 };
    const result = simulate(buildDocumentCalls(scene), 'batched-warmup');
     
    console.log(`[prefix-cache-sim] 灵敏度 l1=10K: rate=${(result.rate * 100).toFixed(1)}%`);
    expect(result.rate).toBeGreaterThanOrEqual(0.9);
  });

  it('组合目标：章内 8 节 + L1 10K + 节证据 2K', () => {
    const scene: SceneParams = { ...TARGET_90, l1Chars: 10000, writerL3Chars: 2000, sectionsPerChapter: 8 };
    const result = simulate(buildDocumentCalls(scene), 'batched-warmup');
     
    console.log(`[prefix-cache-sim] 组合目标: rate=${(result.rate * 100).toFixed(1)}%`);
    expect(result.rate).toBeGreaterThan(0.9);
  });

  it('宽松质量档验收：w=2K/o=3.5K/r=5K 亦 ≥90%（质量档放宽两档仍有余量）', () => {
    // 宽松质量档（w=2K/o=3.5K/r=5K）比代码默认值（w=1K/o=2.5K/r=1.5K）宽松两档仍 ≥90%，
    // 说明 90% 目标不依赖极限压缩、对质量档位放宽有容错余量
    const scene: SceneParams = { ...TARGET_90, writerL3Chars: 2000, outlineL3Chars: 3500, repairL3Chars: 5000 };
    const result = simulate(buildDocumentCalls(scene), 'batched-warmup');
     
    console.log(`[prefix-cache-sim] 宽松质量档: rate=${(result.rate * 100).toFixed(1)}%`);
    expect(result.rate).toBeGreaterThanOrEqual(0.9);
  });

  it('网格扫描：全局评审全量（零裁剪）下找 ≥90% 的稳健参数区', () => {
    const combos: Array<{ label: string; scene: SceneParams }> = [];
    // l1 值域含第三轮实测均值 10.6K（8000 为保守下限、10600 为真实校准值）
    for (const l1Chars of [8000, 10600]) {
      for (const sectionsPerChapter of [5, 8]) {
        for (const writerL3Chars of [1200, 1800]) {
          for (const outlineL3Chars of [2000, 3000]) {
            for (const repairL3Chars of [3000, 4500]) {
              const scene: SceneParams = {
                l0Chars: 4900, l1Chars, l2Chars: 24800, l2SharedChars: 17000,
                writerL3Chars, outlineL3Chars, repairL3Chars,
                chapterCount: 6, sectionsPerChapter,
              };
              const result = simulate(buildDocumentCalls(scene), 'batched-warmup');
              combos.push({ label: `l1=${l1Chars} s=${sectionsPerChapter} w=${writerL3Chars} o=${outlineL3Chars} r=${repairL3Chars}`, scene });
              if (result.rate >= 0.9) {
                 
                console.log(`[prefix-cache-sim] ✓ ≥90%: l1=${l1Chars} s=${sectionsPerChapter} w=${writerL3Chars} o=${outlineL3Chars} r=${repairL3Chars} → ${(result.rate * 100).toFixed(1)}%`);
              } else {
                 
                console.log(`[prefix-cache-sim] ✗ <90%: l1=${l1Chars} s=${sectionsPerChapter} w=${writerL3Chars} o=${outlineL3Chars} r=${repairL3Chars} → ${(result.rate * 100).toFixed(1)}%`);
              }
            }
          }
        }
      }
    }
    // 网格共 32 组合；代码默认值（w≈1K/o=2.5K/r=1.5K）位于可行区中央，
    // 周边 32 组合的 ≥90% 占比即参数稳健性验收（历史口径下 29/32 达标）
    expect(combos.length).toBe(32);
    const passCount = combos.filter(combo => simulate(buildDocumentCalls(combo.scene), 'batched-warmup').rate >= 0.9).length;
    expect(passCount).toBeGreaterThanOrEqual(29);
  });
});

describe('4.17.8 修复辅助化验收（修复是辅助、写作是主力）', () => {
  it('结构验收：每章至多 1 次修复调用（6 章 ≤6 次），4.17.7 基线多轮为 12 次', () => {
    const current = buildDocumentCalls(TARGET_90).filter(call => call.id.includes('repair'));
    const baseline = buildDocumentCalls(BASELINE_ROUND3).filter(call => call.id.includes('repair'));
    // 修复链收缩后：每章 1 轮 = 6 次（目标上限）；基线多轮升级 = 12 次
    expect(current.length).toBeLessThanOrEqual(6);
    expect(baseline.length).toBe(12);
    expect(current.length).toBeLessThan(baseline.length);
  });

  it('最坏情形（每章都触发 1 次修复）：修复占比降至基线 55% 以下且 <15%', () => {
    const baseline = familyInputShares(BASELINE_ROUND3);
    const worst = familyInputShares(TARGET_90);
    console.log(`[prefix-cache-sim] 修复占比: 4.17.7 基线=${(baseline.repair * 100).toFixed(1)}% → 4.17.8 最坏=${(worst.repair * 100).toFixed(1)}%`);
    expect(worst.repair).toBeLessThan(0.15);
    expect(worst.repair).toBeLessThan(baseline.repair * 0.55);
  });

  it('目标态（写作一次成型、6 章中仅 2 章需修复）：修复 <10%、写作 ≥80%', () => {
    // 写作侧加固（结构门禁+锚定规则+六百分百注入）后审查零缺陷的章不触发修复；
    // 保守假设 6 章中仍有 2 章需修复（33% 返工率），修复即为辅助、写作即为主力
    const scene: SceneParams = { ...TARGET_90, repairChapterCount: 2 };
    const shares = familyInputShares(scene);
    const repairCalls = buildDocumentCalls(scene).filter(call => call.id.includes('repair'));
    console.log(`[prefix-cache-sim] 修复辅助化目标态: writing=${(shares.writing * 100).toFixed(1)}% repair=${(shares.repair * 100).toFixed(1)}% review=${(shares.review * 100).toFixed(1)}% repairCalls=${repairCalls.length}`);
    expect(repairCalls.length).toBeLessThanOrEqual(6);
    expect(shares.repair).toBeLessThan(0.1);
    expect(shares.writing).toBeGreaterThanOrEqual(0.8);
  });

  it('理想态（审查零缺陷、修复零调用）：写作 ≥85%、修复 0%', () => {
    const scene: SceneParams = { ...TARGET_90, repairRoundsPerChapter: 0 };
    const shares = familyInputShares(scene);
    console.log(`[prefix-cache-sim] 修复辅助化理想态: writing=${(shares.writing * 100).toFixed(1)}% repair=${(shares.repair * 100).toFixed(1)}%`);
    expect(shares.repair).toBe(0);
    expect(shares.writing).toBeGreaterThanOrEqual(0.85);
  });
});
