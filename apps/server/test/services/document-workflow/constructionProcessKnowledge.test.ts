import { describe, expect, it } from 'vitest';
import { buildProcessKnowledgePrompt, matchProcessKnowledgeCards, PROCESS_KNOWLEDGE_CARDS } from '@/services/document-workflow/constructionProcessKnowledge';

describe('PROCESS_KNOWLEDGE_CARDS（工艺知识卡库）', () => {
  it('知识卡非空且 id 唯一', () => {
    expect(PROCESS_KNOWLEDGE_CARDS.length).toBeGreaterThan(0);
    const ids = new Set(PROCESS_KNOWLEDGE_CARDS.map(card => card.id));
    expect(ids.size).toBe(PROCESS_KNOWLEDGE_CARDS.length);
  });

  it('每张卡都有工序链、参数、验收与规范依据', () => {
    expect(PROCESS_KNOWLEDGE_CARDS.every(card => card.process.length > 0 && card.params.length > 0 && card.acceptance.length > 0 && card.standards.length > 0)).toBe(true);
  });
});

describe('matchProcessKnowledgeCards（工作包工艺卡匹配）', () => {
  it('精确别名命中（土方开挖）', () => {
    const cards = matchProcessKnowledgeCards(['土方开挖']);
    expect(cards.some(card => card.id === 'earthwork-excavation')).toBe(true);
  });

  it('泛化工作包名命中卡片组（安装工程 → 机电卡组）', () => {
    const cards = matchProcessKnowledgeCards(['安装工程']);
    expect(cards.some(card => card.id === 'electrical')).toBe(true);
    expect(cards.some(card => card.id === 'plumbing')).toBe(true);
  });

  it('室外道排工程命中市政道排卡组', () => {
    const cards = matchProcessKnowledgeCards(['室外道排工程']);
    expect(cards.some(card => card.id === 'municipal-pipe')).toBe(true);
  });

  it('返回数量不超过 16', () => {
    expect(matchProcessKnowledgeCards(['土方开挖', '安装工程', '装饰工程']).length).toBeLessThanOrEqual(16);
  });

  it('补充逻辑按目录顺序补足通用卡并在 16 张截断（锁定现状）', () => {
    // 当前所有卡均未声明 projectTypes（空=通用），补充循环按目录顺序取前 16 张即截断，
    // 目录靠后的卡片（如 municipal-road）在单名匹配时不会被补充进来
    const cards = matchProcessKnowledgeCards(['土方开挖'], ['municipal']);
    expect(cards).toHaveLength(16);
    expect(cards.some(card => card.id === 'earthwork-backfill')).toBe(true);
    expect(cards.some(card => card.id === 'municipal-road')).toBe(false);
  });
});

describe('buildProcessKnowledgePrompt（工艺知识卡提示词）', () => {
  it('无卡返回空', () => {
    expect(buildProcessKnowledgePrompt([], [])).toBe('');
  });

  it('生成知识卡提示词含四要素', () => {
    const cards = matchProcessKnowledgeCards(['土方开挖']).filter(card => card.id === 'earthwork-excavation');
    const prompt = buildProcessKnowledgePrompt(cards, ['土方开挖']);
    expect(prompt).toContain('【施工工艺知识卡】');
    expect(prompt).toContain('工序链');
    expect(prompt).toContain('工艺参数（参考）');
    expect(prompt).toContain('检测验收');
    expect(prompt).toContain('规范依据');
    expect(prompt).toContain('测量放线→标高复核');
  });

  it('精确匹配卡标注【直接匹配】，通用补充卡标注【项目类型通用】', () => {
    const direct = matchProcessKnowledgeCards(['土方开挖']).filter(card => card.id === 'earthwork-excavation');
    const prompt = buildProcessKnowledgePrompt(direct, ['土方开挖']);
    expect(prompt).toContain('【直接匹配】土方开挖');

    const generic = matchProcessKnowledgeCards(['土方开挖']).filter(card => card.id === 'earthwork-backfill');
    const genericPrompt = buildProcessKnowledgePrompt(generic, ['土方开挖']);
    expect(genericPrompt).toContain('【项目类型通用】土方回填');
  });
});
