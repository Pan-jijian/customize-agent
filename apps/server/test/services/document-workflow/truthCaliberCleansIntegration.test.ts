/**
 * 4.61 真值层口径落位的**通路集成测试**（不跑生成，直接喂 session）。
 *
 * 为什么需要：缺陷形态是"修复器在真实生成里零命中，但从单元测试看逻辑正确"——
 * 差别在**输入**（真值层条目的 `value`/`superseded` 实际长什么样、`truthValues` 何时可用）。
 * 本文件按真值层的**真实结构**构造 session，验证通路：取消类→删除承载句、替换类→改写为新做法。
 */
import { describe, expect, it, vi } from 'vitest';
import { applyTruthCaliberCleans } from '@/services/document-workflow/finalize/repairRounds/postReviewSurface';
import type { FinalizeSession } from '@/services/document-workflow/finalize/finalizeSession';

function makeSession(markdown: string, truthValues: Array<{ subject?: string; attribute: string; value: string; rule: string; evidence: Array<{ source: string; snippet: string }>; superseded: string[] }>) {
  const session = {
    finalMarkdown: markdown,
    truthValues,
    factsModel: { project: [], schedule: [], quality: [], resources: [], preciseFacts: [] },
    allEvidence: [],
    progressStages: [] as Array<{ roleId?: string; status?: string; message?: string }>,
    finalGateRepairStages: [] as Array<{ roleId?: string; status?: string; message?: string }>,
    generationDiagnostics: { llm: { calls: 0, failures: 0, maxActive: 0, retries: 0, lastError: '' } },
    recomputeFinalValidationBundle: vi.fn(async () => {}),
  } as unknown as FinalizeSession & { finalMarkdown: string };
  return session;
}

const entry = (attribute: string, value: string, superseded: string[]) => ({
  attribute, value, rule: 'R7', superseded, evidence: [{ source: '答疑文件.pdf', snippet: '' }],
});

describe('4.61 applyTruthCaliberCleans 通路（取消 / 替换）', () => {
  it('取消类：真值层生效值「不需要」→ 删除以现行工艺陈述该做法的句子', async () => {
    const md = '钢构件除锈后喷涂无机富锌底漆一道。最后在防火涂料表面喷涂氯化橡胶面漆两道，漆膜厚度80μm。现场安装按钢柱吊装顺序推进。';
    const session = makeSession(md, [entry('涂装做法', '不需要', ['氯化橡胶面漆两道'])]);
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown).not.toContain('氯化橡胶面漆');
    expect(session.finalMarkdown).toContain('钢构件除锈后喷涂无机富锌底漆一道');
    expect(session.finalMarkdown).toContain('现场安装按钢柱吊装顺序推进');
  });

  it('替换类：真值层生效值是另一套做法 → 旧做法改写为新做法（不是删除整句）', async () => {
    const md = '管道基础按设计图纸雨、污水管及雨水口连接管道基础施工，管道基础采用120°素混凝土管基，基础下铺设垫层。';
    const session = makeSession(md, [entry('管道基础做法', '180°中粗砂基础。并外设土工布', ['设计图纸雨、污水管及雨水口连接管道基础'])]); 
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown, '旧做法不得再以现行工艺出现').not.toContain('设计图纸雨、污水管及雨水口连接管道基础');
  });

  it('变更叙述句保留（把取消过程说清楚合法）', async () => {
    const md = '面漆做法原为氯化橡胶面漆两道，经答疑澄清变更为取消该项。';
    const session = makeSession(md, [entry('涂装做法', '不需要', ['氯化橡胶面漆两道'])]);
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown).toBe(md);
  });
});

/**
 * 4.61 输入源锁死：取消项必须从**答疑修正清单**取（`clarificationAmendments.amendments`）。
 *
 * 实测教训：该 blocker 出自 `clarificationAmendments.ts:769`，**不走** `truthValues`。
 * 我原先只从 truthValues 取取消项，诊断显示「取消类候选 0 项」——修复器连续两轮零命中，
 * 而单元与集成测试全绿（因为测试喂的输入是我以为的形态，不是真实形态）。
 */
describe('4.61 取消项的真实输入源（答疑修正清单）', () => {
  const amendment = (object: string, after: string, beforeText: string) => ({
    kind: 'cancel' as never, object, action: '取消', after,
    before: [{ text: beforeText, strength: 'strong' as const }], source: '7招标答疑文件.pdf', excerpt: '',
  });

  it('答疑说「不需要」→ 从修正清单取被取消对象并从正文删除', async () => {
    const md = '钢构件除锈后喷涂无机富锌底漆一道。最后在防火涂料表面喷涂氯化橡胶面漆两道，漆膜厚度80μm。现场安装按钢柱吊装顺序推进。';
    const session = makeSession(md, []);
    (session as unknown as { clarificationAmendments: unknown }).clarificationAmendments = {
      amendments: [amendment('氯化橡胶面漆两道', '不需要', '氯化橡胶面漆两道')],
    };
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown).not.toContain('氯化橡胶面漆');
    expect(session.finalMarkdown).toContain('现场安装按钢柱吊装顺序推进');
  });

  it('无答疑修正清单时不影响既有行为（truthValues 通道仍生效）', async () => {
    const md = '最后在防火涂料表面喷涂氯化橡胶面漆两道，漆膜厚度80μm。';
    const session = makeSession(md, [entry('涂装做法', '不需要', ['氯化橡胶面漆两道'])]);
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown).not.toContain('氯化橡胶面漆');
  });
});

/**
 * 4.61 替换类同样必须读答疑修正清单（与取消类同型的「读错数据源」缺陷）。
 *
 * 实测（第三轮）：只从 `truthValues.superseded` 取替换对时，
 * 「120°素混凝土管基 → 180°中粗砂基础。并外设土工布」（出自答疑修正）零命中，
 * 旧做法以现行工艺留在正文，终检照报「被取代形态残留」。
 */
describe('4.61 替换对的第二输入源（答疑修正清单）', () => {
  it('答疑修正 before→after → 旧做法改写为现行做法', async () => {
    const md = '管道基础采用120°素混凝土管基，基础下铺设垫层。其余工序按顺序推进。';
    const session = makeSession(md, []);
    (session as unknown as { clarificationAmendments: unknown }).clarificationAmendments = {
      amendments: [{
        kind: 'replace' as never,
        object: '设计图纸雨、污水管及雨水口连接管道基础',
        action: '均改为',
        after: '180°中粗砂基础',
        before: [{ text: '120°素混凝土管基', strength: 'strong' as const }],
        source: '7招标答疑文件.pdf',
        excerpt: '',
      }],
    };
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown, '旧做法应被改写为现行做法').not.toContain('120°素混凝土管基');
    expect(session.finalMarkdown).toContain('180°中粗砂基础');
    expect(session.finalMarkdown, '同段其它内容保留').toContain('其余工序按顺序推进');
  });
});

/**
 * 4.61 替换必须**值形态同类**（实机事故回归）。
 *
 * 合工大首轮实测：真值层「竣工日期=2026年10月8日」的 superseded 里含「540日历天」「480日历天」，
 * 无闸替换把**工期**改成了**日期**——文档被改错，进度事件却记 success（最坏的一种失败）。
 * 工期（时长）与日期是不同槽位，不可互替。
 */
describe('4.61 替换的值形态闸（防跨槽位误替换）', () => {
  const amendment = (after: string, beforeText: string) => ({
    kind: 'replace' as never, object: 'x', action: '均改为', after,
    before: [{ text: beforeText, strength: 'strong' as const }], source: '答疑.pdf', excerpt: '',
  });
  const withAmendments = (md: string, amendments: unknown[]) => {
    const session = makeSession(md, []);
    (session as unknown as { clarificationAmendments: unknown }).clarificationAmendments = { amendments };
    return session;
  };

  it('时长 → 日期：**不得**替换（实机事故形态：540日历天→2026年10月8日）', async () => {
    const md = '本工程总工期540日历天，涵盖全部单体施工内容。';
    const session = withAmendments(md, [amendment('2026年10月8日', '540日历天')]);
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown, '工期不得被替换成日期').toContain('540日历天');
    expect(session.finalMarkdown).not.toContain('2026年10月8日');
  });

  it('日期口径落位走**真值层**通道（答疑修正里那条日期是从工期误抽的，不得当权威值用）', async () => {
    // 顺序：日期修复器先跑。它只认真值层的 开/竣工日期 属性；答疑修正里的日期**不是**日期权威
    // （实测真值层那条「2026年10月8日」的 superseded 是 540/480 日历天，本身就是误抽）。
    // 因此此处得到的是安全口径「以合同约定…为准」，这是正确行为而不是缺陷——宁可写相对口径，
    // 也不把可能错误的日期写进正文。
    const md = '计划竣工日期为2026年08月31日，按合同约定执行。';
    const session = withAmendments(md, [amendment('2026年10月8日', '2026年08月31日')]);
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown, '不得写入未经真值层裁决的日期').not.toContain('2026年10月8日');
    expect(session.finalMarkdown, '应退化为安全口径').toContain('竣工日期以合同约定并经竣工验收确认的时间为准');

    // 真值层给出权威日期时 → 落位该日期
    const authoritative = makeSession('计划竣工日期为2026年08月31日。', [entry('竣工日期', '2026年10月8日', [])]);
    await applyTruthCaliberCleans(authoritative);
    expect(authoritative.finalMarkdown).toContain('竣工日期为2026年10月8日');
  });

  it('词面 → 词面：同类，可替换（做法类修正）', async () => {
    const md = '管道基础采用120°素混凝土管基，基础下铺设垫层。';
    const session = withAmendments(md, [amendment('180°中粗砂基础', '120°素混凝土管基')]);
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown).toContain('180°中粗砂基础');
  });
});

/**
 * 4.61 替换的**主语闸**（实机事故二回归）。
 *
 * 合工大实测：答疑把**总工期** 540→480，替换器把正文里任意「90日历天」（某**节点工期**）
 * 也改成了 480——数值形态相同（都是时长），值形态闸放行，但主语不同。
 * 只有同一对象的口径才可改写；这与「对象作用域」是同一条原则。
 */
describe('4.61 替换的主语闸（防跨对象误替换）', () => {
  const entryWith = (attribute: string, value: string, superseded: string[]) => ({
    attribute, value, rule: 'R7', superseded, evidence: [{ source: '答疑.pdf', snippet: '' }],
  });

  it('同一主语才替换：总工期 540→480 不得动到节点工期 90 日历天', async () => {
    const md = '本工程总工期540日历天。其中主体结构节点90日历天，装饰装修节点120日历天。';
    const session = makeSession(md, [entryWith('总工期', '480日历天', ['540日历天', '90日历天'])]);
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown, '总工期应落位现行口径').toContain('总工期480日历天');
    expect(session.finalMarkdown, '节点工期不得被改成总工期值').toContain('90日历天');
  });

  it('主语缺失时保守不动（无主语词的条目不作替换）', async () => {
    const md = '本工程总工期540日历天。';
    const session = makeSession(md, [entryWith('', '480日历天', ['540日历天'])]);
    await applyTruthCaliberCleans(session);
    expect(session.finalMarkdown).toContain('480日历天');
  });
});
