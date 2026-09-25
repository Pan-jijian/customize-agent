import { describe, expect, it } from 'vitest';
import { assignChapterFactsToBlocks, buildChapterFactCoverageContext, buildSectionBudgetInstruction, capFactCoverageContext, CHAPTER_OVER_PRODUCE_ACCEPTANCE_MAX_RATIO, CHAPTER_OVER_PRODUCE_ACCEPTANCE_MIN_RATIO, extractEngineeringObjectNames, renderLengthContractLine, salvageChapterByOverProduceAcceptance, sectionTargets } from '@/services/document-workflow/chapterGeneration';
import { buildChapterStructureFromBlueprint } from '@/services/document-workflow/integratedBlueprint';
import type { DocumentEvidence, DocumentTemplateChapter, SpecAuthorityMap } from '@/services/document-workflow/types';

describe('capFactCoverageContext', () => {
  it('短文本不截断，原样返回', () => {
    const text = '【本章事实覆盖与参数落位要求】\n- 事实 A\n- 事实 B';
    expect(capFactCoverageContext(text)).toBe(text);
  });

  it('超长文本按行完整截断到默认预算（6000 字符），并附加截断提示', () => {
    const line = `- 事实条目：${'内容'.repeat(100)}`;
    const lines = Array.from({ length: 1000 }, (_, index) => `${line}${index}`).join('\n');
    expect(lines.length).toBeGreaterThan(6000);
    const capped = capFactCoverageContext(lines);
    // 上限治理：截断提示现在**如实说明 + 列名缺口清单**（原提示「其余事实见绑定材料与证据」是误导——
    // 证据注入本身另有预算截断），故允许少量附加文本
    expect(capped.length).toBeLessThanOrEqual(7000);
    // 按行完整截断：保留行均为完整行，且行号连续
    const kept = capped.split('\n').filter(item => item.startsWith('- 事实条目'));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]?.endsWith('0')).toBe(true);
    const lastKept = kept[kept.length - 1];
    const lastIndex = Number(lastKept?.match(/(\d+)$/u)?.[1]);
    const firstDropped = kept.length;
    expect(lastIndex).toBe(firstDropped - 1);
    // 截断提示存在（尾部一行，非事实行）
    expect(capped).toContain('本章事实索引超出注入预算已截断');
  });

  it('空输入与空字符串原样返回', () => {
    expect(capFactCoverageContext('')).toBe('');
  });

  it('factCoverageCap 自定义预算生效', () => {
    process.env.DOCUMENT_TUNING_PROFILE = JSON.stringify({ factCoverageCap: 500 });
    try {
      const lines = Array.from({ length: 50 }, (_, index) => `- 条目 ${index}：${'长内容'.repeat(50)}`).join('\n');
      const capped = capFactCoverageContext(lines);
      expect(capped.length).toBeLessThanOrEqual(1400);
      expect(capped).toContain('本章事实索引超出注入预算已截断');
    } finally {
      delete process.env.DOCUMENT_TUNING_PROFILE;
    }
  });

  it('factCoverageCap=0 关闭封顶，原样返回', () => {
    process.env.DOCUMENT_TUNING_PROFILE = JSON.stringify({ factCoverageCap: 0 });
    try {
      const lines = Array.from({ length: 1000 }, (_, index) => `- 条目 ${index}：${'长内容'.repeat(100)}`).join('\n');
      expect(lines.length).toBeGreaterThan(26000);
      expect(capFactCoverageContext(lines)).toBe(lines);
    } finally {
      delete process.env.DOCUMENT_TUNING_PROFILE;
    }
  });
});

describe('buildChapterFactCoverageContext 部位绑定式注入（F12）', () => {
  function chapterOf(): DocumentTemplateChapter {
    return { id: 'ch-1', title: '地基与基础工程', purpose: '', queries: [], requiredFacts: [] } as unknown as DocumentTemplateChapter;
  }

  function placement(location: string, spec: string): SpecAuthorityMap['x'][number] {
    return { location, spec, quantity: '100m3', sourceFile: '清单.xls' };
  }

  function coverageContext(map?: SpecAuthorityMap): string {
    return buildChapterFactCoverageContext({
      chapter: chapterOf(),
      roleFacts: [],
      evidence: [] as DocumentEvidence[],
      missingFacts: [],
      specAuthorityMap: map,
    });
  }

  it('多规格维度渲染为「部位:规格」对照表段，并附硬规则（禁止归一/写错部位视同数据错误）', () => {
    const context = coverageContext({
      混凝土强度等级: [placement('垫层', 'C15'), placement('基础', 'C30'), placement('梁板柱', 'C35')],
    });
    expect(context).toContain('本章材料规格-部位对照表');
    expect(context).toContain('- 混凝土强度等级：垫层:C15｜基础:C30｜梁板柱:C35');
    expect(context).toContain('禁止全文统一为一种规格');
    expect(context).toContain('写错部位视同数据错误');
  });

  it('无 specAuthorityMap → 不注入对照表段（历史行为不变）', () => {
    const context = coverageContext();
    expect(context).not.toContain('材料规格-部位对照表');
  });

  it('单 placement 维度（无多规格混淆风险）→ 不注入', () => {
    const context = coverageContext({
      混凝土强度等级: [placement('垫层', 'C15')],
    });
    expect(context).not.toContain('材料规格-部位对照表');
  });

  it('同部位同规格去重后不足 2 个 → 不注入', () => {
    const context = coverageContext({
      混凝土强度等级: [placement('垫层', 'C15'), placement('垫层', 'C15')],
    });
    expect(context).not.toContain('材料规格-部位对照表');
  });

  it('单维度超过 8 个部位 → 截断到 8 个（防 token 爆炸）', () => {
    const placements = Array.from({ length: 10 }, (_, index) => placement(`部位${index}`, `C${20 + index}`));
    const context = coverageContext({ 混凝土强度等级: placements });
    expect(context).toContain('部位0:C20');
    expect(context).toContain('部位7:C27');
    expect(context).not.toContain('部位8:C28');
  });

  it('多维度各自渲染（混凝土强度等级 + 砂浆强度等级）', () => {
    const context = coverageContext({
      混凝土强度等级: [placement('垫层', 'C15'), placement('基础', 'C30')],
      砂浆强度等级: [placement('砌体', 'M5'), placement('抹灰', 'M10')],
    });
    expect(context).toContain('- 混凝土强度等级：垫层:C15｜基础:C30');
    expect(context).toContain('- 砂浆强度等级：砌体:M5｜抹灰:M10');
  });
});

describe('M4 事实分配工程归属隔离（extractEngineeringObjectNames / assignChapterFactsToBlocks）', () => {
  function blocksOf(...titles: string[]) {
    return titles.map(title => ({ title, subPoints: [{ title }] }));
  }

  it('工程对象提取：村/社区取最短合法词，泛称噪声词过滤', () => {
    expect([...extractEngineeringObjectNames('小菜园村挖方 20420.39m³')]).toEqual(['小菜园村']);
    expect([...extractEngineeringObjectNames('李庄村改造项目测量放线')]).toEqual(['李庄村']);
    expect([...extractEngineeringObjectNames('义井乡红桥村道路工程')]).toEqual(['义井乡红桥村']);
    expect([...extractEngineeringObjectNames('小菜园村、白水塘村各新建公厕一处')].sort()).toEqual(['白水塘村', '小菜园村'].sort());
    expect([...extractEngineeringObjectNames('农村人居环境整治全村推进')]).toEqual([]);
  });

  it('跨工程隔离：A 村事实只落 A 村块，不落 B 村块（数值串位防线）', () => {
    const blocks = blocksOf('小菜园村土方工程', '白水塘村土方工程');
    const assignments = assignChapterFactsToBlocks(blocks, ['小菜园村挖方 20420.39m³']);
    expect(assignments[0]).toEqual(['小菜园村挖方 20420.39m³']);
    expect(assignments[1]).toEqual([]);
  });

  it('同对象归位加分：明确工程对象的行优先归本工程块', () => {
    const blocks = blocksOf('泵站工程', '小菜园村土方工程');
    const assignments = assignChapterFactsToBlocks(blocks, ['小菜园村泵站设备 2 台']);
    expect(assignments[1]).toEqual(['小菜园村泵站设备 2 台']);
    expect(assignments[0]).toEqual([]);
  });

  it('同对象互含容错：行政前缀全称与简称视为同一对象', () => {
    const blocks = blocksOf('小菜园村土方工程');
    const assignments = assignChapterFactsToBlocks(blocks, ['义井乡小菜园村挖方 5m³']);
    expect(assignments[0]).toEqual(['义井乡小菜园村挖方 5m³']);
  });

  it('无对象事实行不触发隔离：按 token 分配；全块零命中不强制分配', () => {
    const blocks = blocksOf('土方工程', '白水塘村土方工程');
    const assignments = assignChapterFactsToBlocks(blocks, ['土方工程 回填压实度 93%', '完全无关的内容片段']);
    expect(assignments[0]).toContain('土方工程 回填压实度 93%');
    expect(assignments[0]).not.toContain('完全无关的内容片段');
    expect(assignments[1]).toEqual([]);
  });
});

describe('4.42 小节篇幅计划守恒配额（520 固定地板移除回归）', () => {
  function chapterOf(sections: string[]): DocumentTemplateChapter {
    return { id: 'c1', title: '拟投入的主要物资计划', purpose: '物资计划', queries: [], requiredFacts: [], sections };
  }

  const TITLES_4 = ['到货节奏安排', '动态调整机制', '分区堆放组织', '现场存量控制'];

  it('核心回归：4 要点 × 目标 1800 → Σ=1800（旧实现固定 520 地板 Σ=2080 必然突破块上限 2070）', () => {
    const targets = sectionTargets(chapterOf(TITLES_4), 1800);
    expect(targets.map(item => item.targetWords)).toEqual([450, 450, 450, 450]);
    expect(targets.reduce((sum, item) => sum + item.targetWords, 0)).toBe(1800);
  });

  it('容量规划配额优先采用（逐项精确匹配，Σ=块预算，与覆盖清单同源）', () => {
    const targets = sectionTargets(chapterOf(TITLES_4), 1800, [
      { title: '到货节奏安排', words: 620 },
      { title: '动态调整机制', words: 480 },
      { title: '分区堆放组织', words: 420 },
      { title: '现场存量控制', words: 280 },
    ]);
    expect(targets.map(item => item.targetWords)).toEqual([620, 480, 420, 280]);
    expect(targets.reduce((sum, item) => sum + item.targetWords, 0)).toBe(1800);
  });

  it('宽松标题匹配：配额标题带后缀注释时仍命中（sectionTitleEquivalent 同口径）', () => {
    const targets = sectionTargets(chapterOf(['到货节奏安排']), 900, [{ title: '到货节奏安排与堆放管理', words: 700 }]);
    expect(targets.map(item => item.targetWords)).toEqual([700]);
  });

  it('配额不齐或全零 → 回退均分，Σ 仍精确 = 目标字数（余数补首项）', () => {
    const partial = sectionTargets(chapterOf(TITLES_4), 1800, [{ title: '到货节奏安排', words: 600 }]);
    expect(partial.reduce((sum, item) => sum + item.targetWords, 0)).toBe(1800);
    const seven = sectionTargets(chapterOf(['到货节奏管理', '动态调整机制', '分区堆放组织', '现场存量控制', '台账追溯办法', '堆放安全防护', '装卸机具配置']), 1800);
    expect(seven.reduce((sum, item) => sum + item.targetWords, 0)).toBe(1800);
  });

  it('无小节规划 → 空数组，篇幅计划指令不发（不注入伪配额）', () => {
    expect(sectionTargets(chapterOf([]), 1800)).toEqual([]);
    expect(buildSectionBudgetInstruction(chapterOf([]), 1800)).toBe('');
  });

  it('篇幅指令渲染（4.60 I2-b 目标语义）：逐点「约 N 字」，N=配额真实值；无下限强化', () => {
    const text = buildSectionBudgetInstruction(chapterOf(TITLES_4), 1800, [
      { title: '到货节奏安排', words: 620 },
      { title: '动态调整机制', words: 480 },
      { title: '分区堆放组织', words: 420 },
      { title: '现场存量控制', words: 280 },
    ]);
    expect(text).toContain('本节小节篇幅计划');
    // 4.60 I2-b：**真实配额直接下达**（目标语义），不再经显示校准系数折算——系数已整体废除
    expect(text).toContain('- 到货节奏安排：约 620 字');
    expect(text).not.toContain('至少达到');
    expect(text).not.toContain('520');
    expect(text).not.toContain('尽量一次达成');
    // 逐点行不得再出现上限语义（「不超过 N 字」）——旧上限语义系统性欠产（A/B 实测 0.53~0.59×）
    expect(text).not.toMatch(/：不超过\s*\d+\s*字/u);
  });

  it('组合链：规划层守恒配额直连写作层篇幅计划（Σ=块预算；无 520 固定地板残留）', () => {
    const structure = buildChapterStructureFromBlueprint({
      blueprintChapter: undefined,
      inputSections: TITLES_4,
      chapterTitle: '拟投入的主要物资计划',
      targetWords: 1800,
    });
    expect(structure.blocks.length).toBe(1);
    const block = structure.blocks[0]!;
    // capacity 层守恒：Σ点配额 = 块预算
    const quotaSum = block.subPoints.reduce((sum, point) => sum + (point.quotaWords || 0), 0);
    expect(quotaSum).toBe(block.targetWords);
    // 写作层篇幅计划：非同名点逐项采用容量规划配额（同名点由 H3 外壳承担，不渲染 H4 行）
    const chapter: DocumentTemplateChapter = { id: 'c1', title: block.title, purpose: '', queries: [], requiredFacts: [], sections: block.subPoints.map(point => point.title) };
    const quotas = block.subPoints.map(point => ({ title: point.title, words: point.quotaWords || 0 }));
    const text = buildSectionBudgetInstruction(chapter, block.targetWords, quotas);
    const rendered = [...text.matchAll(/约 (\d+) 字/gu)].map(match => Number(match[1]));
    // 4.60 I2-b 目标语义：渲染值 = 配额**真实值**（写作指令值与质检口径同一数字，双口径已废除）
    const expectedQuotas = block.subPoints.filter(point => point.title !== block.title).map(point => point.quotaWords || 0);
    expect(rendered).toEqual(expectedQuotas);
    // 渲染行合计不超块预算（同名点由 H3 外壳承担、不渲染 H4 行，故渲染合计 ≤ 块预算；
    // 旧固定 520 地板下 4 要点必超上限 2070）
    expect(rendered.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(block.targetWords);
    expect(text).not.toContain('至少达到');
    expect(text).not.toContain('520');
  });
});

describe('4.60 I2-b 篇幅合同（目标语义、零系数）', () => {
  it('合同行渲染：目标语义（约 N 字 ±10%）为主、1.4× 上限仅作极端保护；上限语义与校准系数已废除', () => {
    /**
     * 4.60 I2-b：**系数整体废除**（`BLOCK_LENGTH_DISPLAY_SCALE` / `displayWordCap` 已从导出面删除）。
     *
     * 为什么废除：系数补偿的是"模型没按指令写"，而不是"指令没说清"——它是**模型特定**的魔数，
     * 换模型即失效（用户实测质疑）。A/B 实测（n=12 × 两个量级）给出了正解：目标语义即准
     *（目标 1200 时窗内 12/12），上限语义必然欠产（0.57~0.59×）。
     */
    const line = renderLengthContractLine(1500);
    expect(line, '目标语义必须下达真实目标（不折算）').toContain('约 1500 字');
    expect(line).toMatch(/±\s*10%/u);
    // 不写上限：宽松上限给出漂移空间（实测块产出比被推高到 1.27×），只声明真实目标与合格区间
    expect(line).not.toMatch(/不超过\s*\d+/u);
    expect(line, '旧窄窗措辞（下限即上限）已删').not.toMatch(/控制在\s*\d+\s*~\s*\d+\s*字之间/u);
    expect(line).toContain('保留章节标题');
  });
});

describe('C7 章级超产对冲接纳（salvageChapterByOverProduceAcceptance）：正/反样本 + 防误伤守护', () => {
  /** documentTextLength 去空白口径下恰为 chars 的正文段（'施' 重复 chars-1 + 全角句号计 1 字） */
  const exactLen = (chars: number): string => `${'施'.repeat(Math.max(0, chars - 1))}。`;
  type AcceptanceInput = Parameters<typeof salvageChapterByOverProduceAcceptance>[0];
  const baseInput = (overrides: Partial<AcceptanceInput> = {}): AcceptanceInput => ({
    sections: [undefined, exactLen(1303)],
    exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(2473), failureKinds: ['over-produce'] }],
    blockTargetWords: [1903, 1800],
    ...overrides,
  });

  it('口径常数守护：接纳线 1.2× 与块末轮容差线同口径；下限 0.85× 与块达标区下限同源', () => {
    expect(CHAPTER_OVER_PRODUCE_ACCEPTANCE_MAX_RATIO).toBe(1.2);
    expect(CHAPTER_OVER_PRODUCE_ACCEPTANCE_MIN_RATIO).toBe(0.85);
  });

  it('r28m 实机复刻：块1 末轮仅篇幅超产（2473 字）+ 块2 放行（1303 字）→ 章总量 3776 ∈ [3147,4444] 接纳成章', () => {
    // r28m 实机形态：章预算 3703 拆 2 块（1903/1800）；块1 四轮 LLM 成功但篇幅超产（末轮 1.30×）判块死
    // → 整章阻断 → 文档缺章；而章总量 3776 ≈ 章预算 3703 本守恒——对冲接纳消除不对称毁灭
    const result = salvageChapterByOverProduceAcceptance(baseInput());
    expect(result).toBeDefined();
    expect(result?.sections[0]).toContain('施');
    expect(result?.detail).toContain('章级超产对冲接纳 1 块');
    expect(result?.detail).toContain('章总量 3776 字 vs 块预算合计 3703 字');
    expect(result?.detail).toContain('块序号 0');
  });

  it('多块失守均仅篇幅超产 → 一并接纳（块序保持）', () => {
    const result = salvageChapterByOverProduceAcceptance({
      sections: [undefined, undefined],
      exhaustedBlocks: [
        { index: 0, lastAttempt: exactLen(2200), failureKinds: ['over-produce'] },
        { index: 1, lastAttempt: exactLen(2100), failureKinds: ['over-produce'] },
      ],
      blockTargetWords: [1800, 1800],
    });
    expect(result).toBeDefined();
    expect(result?.detail).toContain('章级超产对冲接纳 2 块');
    expect(result?.detail).toContain('块序号 0、1');
  });

  it('边界上限：章总量恰等于 ceil(1.2×Σ)=4444 → 接纳；再超 1 字 → 拒绝', () => {
    const atLimit = salvageChapterByOverProduceAcceptance({
      sections: [undefined, exactLen(2000)],
      exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(2444), failureKinds: ['over-produce'] }],
      blockTargetWords: [1903, 1800],
    });
    expect(atLimit).toBeDefined();
    const overLimit = salvageChapterByOverProduceAcceptance({
      sections: [undefined, exactLen(2000)],
      exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(2445), failureKinds: ['over-produce'] }],
      blockTargetWords: [1903, 1800],
    });
    expect(overLimit).toBeUndefined();
  });

  it('边界下限：章总量恰等于 floor(0.85×Σ)=3147 → 接纳；再少 1 字 → 拒绝', () => {
    const atFloor = salvageChapterByOverProduceAcceptance({
      sections: [undefined, exactLen(1147)],
      exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(2000), failureKinds: ['over-produce'] }],
      blockTargetWords: [1903, 1800],
    });
    expect(atFloor).toBeDefined();
    const belowFloor = salvageChapterByOverProduceAcceptance({
      sections: [undefined, exactLen(1146)],
      exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(2000), failureKinds: ['over-produce'] }],
      blockTargetWords: [1903, 1800],
    });
    expect(belowFloor).toBeUndefined();
  });

  it('反样本：失败类别混入结构标题缺陷 → 拒绝（仅篇幅可接纳）', () => {
    const result = salvageChapterByOverProduceAcceptance(baseInput({
      exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(2473), failureKinds: ['over-produce', 'structure-titles'] }],
    }));
    expect(result).toBeUndefined();
  });

  it('反样本：失败类别为欠产/结构完整性/数值/工序形式/套话/密度/归因/格式任一 → 一律拒绝', () => {
    for (const kind of ['under-produce', 'structure-integrity', 'numeric', 'flow-form', 'templating', 'density', 'attribution', 'format']) {
      const result = salvageChapterByOverProduceAcceptance(baseInput({
        exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(2473), failureKinds: [kind] }],
      }));
      expect(result, `failureKind=${kind}`).toBeUndefined();
    }
  });

  it('反样本：无末轮内容（未记录尝试）或空白内容 → 拒绝', () => {
    expect(salvageChapterByOverProduceAcceptance(baseInput({
      exhaustedBlocks: [{ index: 0, failureKinds: ['over-produce'] }],
    }))).toBeUndefined();
    expect(salvageChapterByOverProduceAcceptance(baseInput({
      exhaustedBlocks: [{ index: 0, lastAttempt: '   ', failureKinds: ['over-produce'] }],
    }))).toBeUndefined();
  });

  it('反样本：严重超产（章总量 5600 > 1.2×Σ=4444）→ 拒绝（块容差不放大为章级膨胀）', () => {
    const result = salvageChapterByOverProduceAcceptance({
      sections: [undefined, exactLen(2600)],
      exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(3000), failureKinds: ['over-produce'] }],
      blockTargetWords: [1903, 1800],
    });
    expect(result).toBeUndefined();
  });

  it('反样本：填回后仍有缺口块（非失守块缺失）→ 拒绝（不允许带缺成章）', () => {
    const result = salvageChapterByOverProduceAcceptance({
      sections: [undefined, undefined],
      exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(2473), failureKinds: ['over-produce'] }],
      blockTargetWords: [1903, 1800],
    });
    expect(result).toBeUndefined();
  });

  it('反样本：无失守块 / 长度不匹配 / index 越界 / 位置已有内容 → 拒绝（防御性）', () => {
    expect(salvageChapterByOverProduceAcceptance(baseInput({ exhaustedBlocks: [] }))).toBeUndefined();
    expect(salvageChapterByOverProduceAcceptance(baseInput({ blockTargetWords: [1903] }))).toBeUndefined();
    expect(salvageChapterByOverProduceAcceptance(baseInput({
      exhaustedBlocks: [{ index: 5, lastAttempt: exactLen(2473), failureKinds: ['over-produce'] }],
    }))).toBeUndefined();
    expect(salvageChapterByOverProduceAcceptance({
      sections: [exactLen(2400), exactLen(1303)],
      exhaustedBlocks: [{ index: 0, lastAttempt: exactLen(2473), failureKinds: ['over-produce'] }],
      blockTargetWords: [1903, 1800],
    })).toBeUndefined();
  });

  it('防误伤守护：混合失守（块1 仅超额、块2 结构缺陷）→ 整体拒绝（不做部分接纳）', () => {
    const result = salvageChapterByOverProduceAcceptance({
      sections: [undefined, undefined],
      exhaustedBlocks: [
        { index: 0, lastAttempt: exactLen(2200), failureKinds: ['over-produce'] },
        { index: 1, lastAttempt: exactLen(2100), failureKinds: ['structure-titles'] },
      ],
      blockTargetWords: [1800, 1800],
    });
    expect(result).toBeUndefined();
  });

  it('防误伤守护：多块失守仅部分带末轮内容 → 拒绝（任一失守块不满足即不接纳）', () => {
    const result = salvageChapterByOverProduceAcceptance({
      sections: [undefined, undefined],
      exhaustedBlocks: [
        { index: 0, lastAttempt: exactLen(2200), failureKinds: ['over-produce'] },
        { index: 1, failureKinds: ['over-produce'] },
      ],
      blockTargetWords: [1800, 1800],
    });
    expect(result).toBeUndefined();
  });
});
