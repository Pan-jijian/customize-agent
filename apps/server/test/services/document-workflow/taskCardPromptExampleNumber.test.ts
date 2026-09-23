/**
 * 4.59 R-B7 删除任务卡示例数字 + R-B3/R-B5 写作期约束下发 —— 用例矩阵。
 *
 * 被判缺陷（原 ① 项）：「写出具体部位/单体并引用清单数量（如「塑料管铺设8205.53m」）」——
 * 给模型一个**真实格式的数字**属不必要的风险：提示词里的具体数值会被当作"可抄用的资料事实"
 *（对本地模型的复读倾向而言，示例比抽象指令强得多），一旦抄进正文，该数值没有资料出处，
 * 直接触发 factReconciliation「无据不写」族。本轮实测未泄漏，但"未泄漏"是结果不是保证——
 * 故替换为不含数字的口径说明：**保留"必须引用清单数量"的硬要求，只撤掉可抄的示例数字**。
 *
 * 同时锁住卡上 7）项（题注机械生成 + 条款体复述两条写作期约束）的接线，以及卡的既有骨架不变。
 */
import { describe, expect, it } from 'vitest';
import { buildSectionFactCard, sectionFactUsageIssue } from '@/services/document-workflow/chapterGeneration';
import { CLAUSE_RECITATION_CONSTRAINT_RULE } from '@/services/document-workflow/tenderBidChecks';
import { TABLE_CAPTION_MECHANICAL_RULE } from '@/services/document-workflow/constructionOrgTablePlan';
import type { DocumentEvidence } from '@/services/document-workflow/types';

const embedDocuments = async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 0]);

function evidenceItem(overrides: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'ch-1', filePath: '/data/工程量清单.xlsx', score: 0.9, content: '计划工期540日历天。\n塑料管铺设8205.53m。', ...overrides };
}

/** 剔除"资料事实行"与"量化参数清单段"后的说明段（示例数字只可能出现在这里） */
function instructionSections(prompt: string): string {
  const [cardPart] = prompt.split('【量化参数落位清单】');
  return cardPart.split('\n').filter(line => !/^-\s/u.test(line)).join('\n');
}

describe('R-B7 删除任务卡示例数字', () => {
  it('正向：① 项为无示例数字的口径说明，不再是「（如「塑料管铺设8205.53m」）」', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem()], embedDocuments);
    expect(card.prompt).toContain('① 作业对象与工程量——写出具体部位/单体并引用清单数量（数量照抄资料/清单原文，不得改写或换算）');
    expect(card.prompt).not.toContain('（如「塑料管铺设8205.53m」）');
    // 提示词里的「如「…」」示例（题注规则用表名举例）不含数字：示例数字是唯一的"可抄清单外数值"入口
    expect(card.prompt).not.toMatch(/如「[^」]*\d/u);
  });

  it('反向（反证：只撤示例、不撤硬要求）：① 项仍要求引用清单数量，且说明段内没有任何 3 位以上数字', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem()], embedDocuments);
    const instruction = instructionSections(card.prompt);
    expect(instruction).toContain('引用清单数量');
    expect(instruction).toContain('不得改写或换算');
    // 说明段零长数字：模型无从"抄"到清单外的数值
    expect(instruction.match(/\d{3,}/gu)).toBeNull();
  });

  it('反向（不连带删除有据数字）：资料事实行与量化参数清单里的原始数字仍完整保留', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem()], embedDocuments);
    expect(card.prompt).toContain('- 计划工期540日历天。（来源：工程量清单.xlsx）');
    expect(card.prompt).toContain('- 塑料管铺设8205.53m。（来源：工程量清单.xlsx）');
    expect(card.prompt).toContain('【量化参数落位清单】');
    expect(card.prompt).toContain('540日历天、8205.53m');
    expect(card.items).toHaveLength(2);
  });

  it('正向：7）项下发题注机械生成约束（B3 写作期一半，单一出处引用）', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem()], embedDocuments);
    expect(card.prompt).toContain(`7）${TABLE_CAPTION_MECHANICAL_RULE}`);
    expect(card.prompt).toContain('不要写「表X-Y」编号前缀');
  });

  it('正向：7）项下发条款体复述约束（B5 ② 写作期一半，语体描述不含可抄示例句）', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem()], embedDocuments);
    expect(card.prompt).toContain(CLAUSE_RECITATION_CONSTRAINT_RULE);
    expect(card.prompt).toContain('谁执行、何时执行、在哪个部位、频次多少、留什么记录');
  });

  it('边界（空输入）：无证据 → 不生成任务卡（空卡不产生空指令）', async () => {
    expect((await buildSectionFactCard('工程概况', [], embedDocuments)).prompt).toBe('');
  });

  it('边界（无可用事实行）：证据行不含量化/详细/小节相关词 → 同样不生成任务卡', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem({ content: '说明：详见附件。' })], embedDocuments);
    expect(card.items).toEqual([]);
    expect(card.prompt).toBe('');
  });

  it('边界（最小输入）：仅 1 条事实行时卡仍完整生成，7）项与 6）项连接符不变', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem({ content: '计划工期540日历天。' })], embedDocuments);
    expect(card.items).toHaveLength(1);
    expect(card.prompt).toContain('；7）表格题注（表名行）不要写');
    expect(card.prompt).toContain('禁止只抄规范阈值');
  });
});

describe('R-B7 不变：任务卡既有骨架与落位判据未受影响', () => {
  it('不变：卡的骨架句逐字保留（标题/事实清单/三要素 ①②③④/无据不写）', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem()], embedDocuments);
    for (const anchor of [
      '【当前小节写作任务卡】',
      '成稿要求：1）至少自然写入其中 2 条资料事实',
      '② 工序顺序——编号步骤、箭头链、表格均可',
      '③ 施工方法——含不少于 4 个工艺参数',
      '④ 检查验收与闭环——责任岗位 + 检查频次 + 整改销项',
      '6）**本节出现的每一个数值都必须来自上方资料事实、量化参数清单或蓝图锁定值**',
    ]) {
      expect(card.prompt).toContain(anchor);
    }
  });

  it('不变：sectionFactUsageIssue 判据不变（事实达标不报；事实未落位仍报并给出建议）', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem()], embedDocuments);
    expect(sectionFactUsageIssue('工程概况', '本工程计划工期540日历天，塑料管铺设8205.53m，已据此编制进度计划与劳动力需求计划并逐月核对。'.repeat(5), card)).toBeUndefined();
    const issue = sectionFactUsageIssue('工程概况', '本工程按计划组织施工，具体内容见后续章节安排与相关附表说明。'.repeat(10), card);
    expect(issue).toContain('知识库事实落位不足');
    expect(issue).toContain('计划工期540日历天');
  });

  it('不变：量化参数清单段仍为卡的第二段（B7 只改 ① 项措辞，不动参数清单）', async () => {
    const card = await buildSectionFactCard('工程概况', [evidenceItem()], embedDocuments);
    expect(card.preciseTokens).toEqual(['540日历天', '8205.53m']);
    expect(card.prompt).toContain('这些参数来自绑定资料，不属于编造');
    expect(card.quantifiedCount).toBe(2);
  });
});
