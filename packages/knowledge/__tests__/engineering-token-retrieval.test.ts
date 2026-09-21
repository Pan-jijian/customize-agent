/**
 * G 线 P2-10：中文短词与工程符号检索（**有区分度**的召回验证）。
 *
 * 注意本文件的设计要点：每个查询都配一份**干扰文档**（同领域、同高频词、但不含目标规格词），
 * 断言「目标切片排在干扰切片之前」。若只上传单份文档，任何查询都会命中它，断言会恒真而失去意义
 *（这正是本文件初版的缺陷，已修正）。
 *
 * 缺陷背景：`toFtsQuery` 只把长度 >= 3 的词交给 FTS（trigram 分词器要求 >=3 字符），短词靠
 * `shortTerms` 的 LIKE 全表兜底（index-state-store.ts:673）。已知薄弱面：
 * ① 短词上限 6 个——查询里短中文词多于 6 个时后面的被静默丢弃；
 * ② SQLite 内置 `LOWER()` 只处理 ASCII，而查询侧用 JS `toLowerCase()` 归一——
 *    非 ASCII 字符会被单侧小写化（`Ⅱ`U+2161 → `ⅱ`U+2171），`Ⅱ级`/`Ⅲ类` 类工程符号
 *    （钢筋等级、围岩类别）存在匹配不上的风险；
 * ③ 「字母+数字」规格模式（`C30`/`DN200`）本身 >=3 可进 FTS，但需确认不被拆散或淹没。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { KnowledgeBaseManager } from '../src/core/knowledge-base-manager.js';
import path from 'node:path';
import os from 'node:os';

describe('G 线 P2-10 工程检索词召回', () => {
  let manager: KnowledgeBaseManager;

  beforeAll(async () => {
    const kbDir = path.join(os.tmpdir(), 'customize-agent-p210-kb-' + Date.now());
    manager = new KnowledgeBaseManager({ scope: 'project', projectRoot: kbDir, projectId: 'p210-test' });
    manager.initialize();
    // 目标文档：含各类工程规格词
    const target = `
# 第一章 材料与工艺要求
## 1.1 混凝土强度
主体结构混凝土强度等级为 C30，垫层采用 C15 素混凝土。
## 1.2 钢筋等级
受力钢筋采用 Ⅱ级钢筋，箍筋采用 Ⅰ级钢筋，焊接接头须做力学性能检验。
## 1.3 管道规格
给水干管采用 DN200 球墨铸铁管，支管采用 DN100 镀锌钢管。
## 1.4 目标指标
计划工期为 180 日历天，质量目标为合格，安全目标为无重大事故。
`;
    // 干扰文档：同领域、同样出现「混凝土/钢筋/管道/工期」等高频词，但**不含**任何目标规格值
    const distractor = `
# 第二章 现场平面布置
## 2.1 混凝土供应
商品混凝土强度等级为 C50，由搅拌站统一供应，罐车运输至浇筑点。
## 2.2 钢筋加工
受力钢筋采用 Ⅲ级钢筋，在加工棚集中下料，成品分类堆放并挂牌标识。
## 2.3 管道敷设
给水支管采用 DN50 镀锌钢管，沿道路一侧敷设，沟槽开挖后及时回填。
## 2.4 进度安排
各工序按进度计划穿插组织，工期以现场实际进度为准。
`;
    await manager.uploadFiles([
      { fileName: '材料工艺要求.md', content: Buffer.from(target) },
      { fileName: '现场平面布置.md', content: Buffer.from(distractor) },
    ]);
  }, 120000);

  /** 返回检索结果首条的正文——断言它必须来自目标文档而非干扰文档 */
  async function topContent(query: string): Promise<string> {
    const results = await manager.search(query, { limit: 5 });
    return (results[0] as { content?: string } | undefined)?.content ?? '';
  }

  it('「字母+数字」规格模式可召回（C30 / DN200），不被高频词干扰文档淹没', async () => {
    expect(await topContent('混凝土强度等级 C30')).toContain('C30');
    expect(await topContent('给水干管 DN200 规格')).toContain('DN200');
  });

  it('罗马数字工程符号可召回（Ⅱ级钢筋），不被同领域干扰文档淹没', async () => {
    expect(await topContent('受力钢筋采用什么等级 Ⅱ级')).toContain('Ⅱ级钢筋');
  });

  it('2 字符中文词可召回（工期/质量/安全），不被同领域干扰文档淹没', async () => {
    const top = await topContent('计划工期 质量目标 安全目标');
    expect(top).toContain('计划工期');
    expect(top).toContain('质量目标');
  });

  /**
   * A/B 对照：**规格 token 必须成为排序的决定因素**。
   * 同一句式中只换规格值（C30↔C50 / Ⅱ级↔Ⅲ级 / DN200↔DN50），首条命中必须随之翻转。
   * 这条对照同时证明上面的正向断言有失败能力——若检索只按「混凝土/钢筋/管道」这类
   * 通用词排序，两组查询会返回同一条，对照即红。
   */
  it('A/B 对照：句式中仅规格值不同，首条命中随之翻转', async () => {
    const pair = async (query: string) => await topContent(query);
    // 混凝土强度等级
    expect(await pair('混凝土强度等级 C30')).toContain('C30');
    expect(await pair('混凝土强度等级 C50')).toContain('C50');
    // 罗马数字钢筋等级（Ⅱ vs Ⅲ）
    expect(await pair('受力钢筋采用 Ⅱ级钢筋')).toContain('Ⅱ级钢筋');
    expect(await pair('受力钢筋采用 Ⅲ级钢筋')).toContain('Ⅲ级钢筋');
    // 管径规格
    expect(await pair('给水干管 DN200')).toContain('DN200');
    expect(await pair('给水支管 DN50')).toContain('DN50');
  });
});
