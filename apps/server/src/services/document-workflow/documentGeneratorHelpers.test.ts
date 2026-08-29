import { describe, expect, it } from 'vitest';
import { chapterGenerationTargets } from './documentGeneratorHelpers';

describe('chapterGenerationTargets（提示词篇幅目标完整下达）', () => {
  it('长文模式：提示词章预算必须完整下达，不被 upper 硬顶与结构估算压制', () => {
    // 提示词「不少于5万字」→ 三章均分 16667 字/章；历史缺陷：upper 硬顶 7200~9800 把章目标压至 5200~9200
    const plan = chapterGenerationTargets({ budgetTarget: 16667, sectionCount: 20, title: '确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施', longformStrict: true });
    expect(plan.roundTarget).toBe(16667);
    expect(plan.maxWords).toBe(Math.ceil(16667 * 1.12));
  });

  it('长文模式：小节数为 0 的章节同样完整下达预算', () => {
    const plan = chapterGenerationTargets({ budgetTarget: 16667, sectionCount: 0, title: '工程重点难点及危大工程的保障体系', longformStrict: true });
    expect(plan.roundTarget).toBe(16667);
  });

  it('长文模式：预算低于下限时按下限生成（轻量章节不被无限拉长）', () => {
    const plan = chapterGenerationTargets({ budgetTarget: 2000, sectionCount: 4, title: '编制说明与工程概况', longformStrict: true });
    expect(plan.roundTarget).toBe(2600);
  });

  it('普通模式：维持原口径（结构承载量/预算/上限三重 min）', () => {
    const plan = chapterGenerationTargets({ budgetTarget: 16667, sectionCount: 20, title: '确保工期与质量的保障体系与措施', longformStrict: false });
    expect(plan.roundTarget).toBeLessThanOrEqual(16667);
    expect(plan.roundTarget).toBeGreaterThan(0);
  });

  it('三章目标总和与提示词总字数对齐（5 万字场景）', () => {
    const chapters = [
      { budgetTarget: 16667, sectionCount: 20, title: '工程重点难点及危大工程的保障体系' },
      { budgetTarget: 16667, sectionCount: 20, title: '确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施' },
      { budgetTarget: 16666, sectionCount: 20, title: '施工进度计划与资源保障措施' },
    ];
    const total = chapters.reduce((sum, chapter) => sum + chapterGenerationTargets({ ...chapter, longformStrict: true }).roundTarget, 0);
    expect(total).toBe(50000);
  });
});
