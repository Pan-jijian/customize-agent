/**
 * 4.60 I2-c 句尾复读（**开集判据**）——用户实测缺陷的检测端。
 *
 * ## 缺陷（用户实测指出）
 *
 * > 「你一直没有发现我们的正文内容中，一直有类似 "复查确认销项" 这种内容吗？很多，几乎每个小节都有，
 * >  这是严重的问题，不应该有这样的内容的。」
 *
 * ## 为什么既有检测器全部漏判
 *
 * 实测 `doc-1790192978315-5e3bbdd6`：130 处「销项」、832 句中 42 句以「复查销项」收尾，而
 * **所有复读检测器都报"通过"**（套话句占比 0.1%、句级复读逐字比对无重复、模板化链尾无零信息前缀）。
 * 唯一同族的 `skeletonFingerprintIssues` 用**闭集词表**（手工枚举 5 条骨架）——不在表里就照过。
 * 闭集必然漏判：能枚举的复读不是问题，能复读的枚举不完。
 *
 * 本判据按**形状**计数（同一 4 字句尾全篇出现次数），与内容无关，故不需要任何词表。
 *
 * ## 阈值标定（149 份归档语料，未干预样本）
 *
 * ```
 * 句尾 4 字最高复读次数：p50=20 p75=33 p90=50 p95=74 max=117
 * ```
 * 复读最严重的 6 份，头号句尾**全都是**「复查销项」（117/111/108/99/87/86 次）。
 * 容忍线不取语料分位（取 p50 等于承认病态为常态），而取**正常写作期望值 4 次**，
 * 并与写作侧禁令同值（`TENDER_BID_WRITING_RULES`「同一收尾表达全文不得超过 4 次」）——
 * 写作口径与检测口径同源，避免重演历史自锁（写作要求写得越合规、检测判越模板化）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SENTENCE_TAIL_BLOCKER_COUNT,
  SENTENCE_TAIL_CAP,
  sentenceTailRepeatHits,
  sentenceTailRepeatIssues,
  sentenceTailRepairTargets,
} from '@/services/document-workflow/templatingGovernance';

/** 造 n 句以 tail 收尾的正文（每句对象不同——复读判据看的是形状，不是逐字重复） */
function sentencesEndingWith(tail: string, n: number): string {
  return Array.from({ length: n }, (_, index) => `质检员每周不少于1次巡查${index + 1}号作业面的工序质量，发现偏差即登记整改，由项目经理${tail}。`).join('');
}

/** 造 n 句正常收尾：12 种句尾**各一次**（复读判据数形状，故句尾必须各不相同） */
function variedSentences(n: number): string {
  const tails = ['完成了钢筋绑扎', '经监理工程师签认', '报监理单位备案', '进入下道工序', '形成检验批记录', '移交资料员归档', '按方案组织施工', '由技术负责人审定', '纳入质量月报', '完成实测实量', '经复测合格', '由试验室出具报告'];
  return Array.from({ length: Math.min(n, tails.length) }, (_, index) => `施工班组按交底要求完成第${index + 1}项作业内容，${tails[index]!}。`).join('');
}

describe('4.60 I2-c 句尾复读（开集判据）', () => {
  // ───────────────── ① 正向：真实缺陷形态必须命中 ─────────────────

  it('正向-1：42 句以「复查销项」收尾 → 命中且计数为 42（实测生产文档同形）', () => {
    const hits = sentenceTailRepeatHits(sentencesEndingWith('复查销项', 42));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.tail).toBe('复查销项');
    expect(hits[0]!.count).toBe(42);
    expect(hits[0]!.sentences).toHaveLength(42);
  });

  it('正向-2：超阻断线判 error/blocker，阻断线之内判 warning（分级不误伤长文）', () => {
    const blockerIssue = sentenceTailRepeatIssues(sentencesEndingWith('复查销项', SENTENCE_TAIL_BLOCKER_COUNT + 1))[0];
    expect(blockerIssue?.level).toBe('error');
    expect(blockerIssue?.severity).toBe('blocker');
    const warnIssue = sentenceTailRepeatIssues(sentencesEndingWith('复查销项', SENTENCE_TAIL_CAP + 1))[0];
    expect(warnIssue?.level).toBe('warning');
    expect(warnIssue?.severity).toBe('warning');
  });

  it('正向-3：issue 文案须给出可核验的数量与容忍线（供修复轮与人工复核判读）', () => {
    const issue = sentenceTailRepeatIssues(sentencesEndingWith('复验销项', 18))[0];
    expect(issue?.message).toContain('复验销项');
    expect(issue?.message).toContain('18');
    expect(issue?.message).toContain(String(SENTENCE_TAIL_CAP));
    // 修复建议必须指向"换成具体动作"，且**不得**给出替换用的固定句式（示例即模板化源头）
    expect(issue?.suggestion).toContain('具体动作');
    expect(issue?.suggestion).not.toMatch(/例如[：:]\s*「/u);
  });

  it('正向-4：修复目标每章每族至多 4 句、保留额度全篇 4 处（与 sentencePatternRepairTargets 同设计）', () => {
    const chapterBody = sentencesEndingWith('复查销项', 40);
    const targets = sentenceTailRepairTargets(`## 质量保证措施\n\n${chapterBody}`);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets[0]!.patternId).toBe('tail-repeat:复查销项');
    expect(targets[0]!.cap).toBe(SENTENCE_TAIL_CAP);
    // 每轮每章至多 4 句（LLM 锚点改写的既有设计：锚点过多会把定向改写退化成整章重写，
    // 多轮收敛优于一次倾泻；与 sentencePatternRepairTargets 的 `slice(0, 4)` 同源）
    expect(targets.reduce((sum, target) => sum + target.sentences.length, 0)).toBe(4);
    // 入锚点的句子必须确实以该尾收尾（锚点可逐句定位 = 检测定位）
    for (const sentence of targets.flatMap(target => target.sentences)) expect(sentence.endsWith('复查销项。')).toBe(true);
  });

  // ───────────────── ② 反向：正常写作不得误伤 ─────────────────

  it('反向-1：句尾各不相同（12 种尾、各 1 次）→ 零命中', () => {
    expect(sentenceTailRepeatHits(variedSentences(12))).toEqual([]);
    expect(sentenceTailRepeatIssues(variedSentences(12))).toEqual([]);
  });

  it('反向-2：容忍线以内（恰好 4 次）不报——自然写作允许的重复不被判缺陷', () => {
    expect(sentenceTailRepeatHits(sentencesEndingWith('复查销项', SENTENCE_TAIL_CAP))).toEqual([]);
  });

  it('反向-3：以数值/单位/英文收尾的句子不计入（参数句的"尾"不是套语尾巴）', () => {
    // 若不做这条排除，「压实度不低于95%」会被算成"不低于"×N 的伪复读
    const body = Array.from({ length: 20 }, (_, index) => `第${index + 1}层回填压实度不低于95%，每层虚铺厚度不超过300mm，环刚度SN8。`).join('');
    expect(sentenceTailRepeatHits(body)).toEqual([]);
  });

  it('反向-4：标题行与表格行不入句池（标题复读由 titleIntegrity 通道治理，不在此重复计）', () => {
    const body = Array.from({ length: 20 }, (_, index) => `| 质检员巡查${index + 1} | 每周不少于1次 | 由项目经理复查销项 |`).join('\n');
    expect(sentenceTailRepeatHits(body)).toEqual([]);
  });

  // ───────────────── ③ 不变：判据为纯函数 ─────────────────

  it('不变-1：纯函数（同入同出）、命中按次数降序', () => {
    const body = `${sentencesEndingWith('复查销项', 20)}${sentencesEndingWith('不予调整', 8)}`;
    expect(sentenceTailRepeatHits(body)).toEqual(sentenceTailRepeatHits(body));
    const hits = sentenceTailRepeatHits(body);
    expect(hits.map(hit => hit.count)).toEqual([...hits.map(hit => hit.count)].sort((a, b) => b - a));
  });

  // ───────────────── ④ 实测锚点：真实语料上复现缺陷 ─────────────────

  it('实测锚点：真实产出文档上命中「复查销项」（语料不在则跳过）', () => {
    const corpus = join(homedir(), '.customize-agent/projects/3c3f04667c69/generatedDocuments/assets/巢湖施工组织设计-doc-1790192978315-5e3bbdd6.md');
    if (!existsSync(corpus)) return;
    const hits = sentenceTailRepeatHits(readFileSync(corpus, 'utf8'));
    const top = hits[0];
    expect(top, '语料复读最严重的收尾应为「复查销项」（实测 42 处）').toBeDefined();
    expect(top!.tail).toBe('复查销项');
    expect(top!.count).toBeGreaterThan(SENTENCE_TAIL_BLOCKER_COUNT);
  });
});
