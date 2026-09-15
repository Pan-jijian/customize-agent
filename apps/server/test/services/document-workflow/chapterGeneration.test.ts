import { describe, expect, it } from 'vitest';
import { assignChapterFactsToBlocks, BLOCK_LENGTH_DISPLAY_SCALE, buildChapterFactCoverageContext, buildSectionBudgetInstruction, capFactCoverageContext, displayWordCap, extractEngineeringObjectNames, renderLengthContractLine, sectionTargets } from '@/services/document-workflow/chapterGeneration';
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
    expect(capped.length).toBeLessThanOrEqual(6100);
    // 按行完整截断：保留行均为完整行，且行号连续
    const kept = capped.split('\n').filter(item => item.startsWith('- 事实条目'));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]?.endsWith('0')).toBe(true);
    const lastKept = kept[kept.length - 1];
    const lastIndex = Number(lastKept?.match(/(\d+)$/u)?.[1]);
    const firstDropped = kept.length;
    expect(lastIndex).toBe(firstDropped - 1);
    // 截断提示存在（尾部一行，非事实行）
    expect(capped).toContain('本章事实索引过长已截断');
  });

  it('空输入与空字符串原样返回', () => {
    expect(capFactCoverageContext('')).toBe('');
  });

  it('factCoverageCap 自定义预算生效', () => {
    process.env.DOCUMENT_TUNING_PROFILE = JSON.stringify({ factCoverageCap: 500 });
    try {
      const lines = Array.from({ length: 50 }, (_, index) => `- 条目 ${index}：${'长内容'.repeat(50)}`).join('\n');
      const capped = capFactCoverageContext(lines);
      expect(capped.length).toBeLessThanOrEqual(600);
      expect(capped).toContain('本章事实索引过长已截断');
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

  it('篇幅指令渲染（4.43 上限语义 + 显示校准）：逐点「不超过 N 字」，N=配额×0.75；无下限强化', () => {
    const text = buildSectionBudgetInstruction(chapterOf(TITLES_4), 1800, [
      { title: '到货节奏安排', words: 620 },
      { title: '动态调整机制', words: 480 },
      { title: '分区堆放组织', words: 420 },
      { title: '现场存量控制', words: 280 },
    ]);
    expect(text).toContain('本节小节篇幅上限');
    expect(text).toContain('- 到货节奏安排：不超过 465 字'); // 620 × 0.75 显示校准
    expect(text).not.toContain('至少达到');
    expect(text).not.toContain('520');
    expect(text).not.toContain('尽量一次达成');
    expect(text).not.toContain('篇幅计划');
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
    const rendered = [...text.matchAll(/不超过 (\d+) 字/gu)].map(match => Number(match[1]));
    // 4.43 显示校准：渲染值 = 配额 × 系数（写作指令用校准值，质检用真实值）
    const expectedQuotas = block.subPoints.filter(point => point.title !== block.title).map(point => displayWordCap(point.quotaWords || 0));
    expect(rendered).toEqual(expectedQuotas);
    // 合计不超块预算（旧固定 520 地板下 4 要点必超上限 2070）
    expect(rendered.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(block.targetWords);
    expect(text).not.toContain('至少达到');
    expect(text).not.toContain('520');
  });
});

describe('4.43 篇幅上限语义 + 显示校准（根治字数控不住）', () => {
  it('合同行渲染：上限语义（不超过）、显示值=真实目标×0.75、不得超限；旧目标语义措辞已删', () => {
    expect(BLOCK_LENGTH_DISPLAY_SCALE).toBe(0.75);
    expect(displayWordCap(1500)).toBe(1125);
    expect(displayWordCap(1800)).toBe(1350);
    expect(displayWordCap(1)).toBe(1);
    const line = renderLengthContractLine(1500);
    expect(line).toContain('本节正文总字数不超过 1125 字');
    expect(line).toContain('（控制在 956~1125 字之间）');
    expect(line).toContain('超出即不合格');
    expect(line).not.toContain('篇幅目标');
    expect(line).not.toContain('1500');
  });
});
