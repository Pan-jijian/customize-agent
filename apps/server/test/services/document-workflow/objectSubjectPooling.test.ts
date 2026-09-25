/**
 * 4.61 对象主体分池（`crossSectionNumericConflictIssues` / `locationGroupForMatch`）。
 *
 * ## 为什么加这一条
 *
 * 该检测器的分池键来自 `locationGroupForMatch`，而它的判据是**部位词表**
 * （`LOCATION_WORD_SOURCE`：基础/垫层/屋面…）+ 16 字窗口。**单体名（1#厂房/2#门卫）不在词表里**，
 * 于是同一分项在不同单体下的口径全落进空池互比——实机阻断「垫层混凝土强度等级出现 C15、C25、C20
 * 三套口径」即由此产生（该锚点 `cushion` 的 label 正是「垫层混凝土强度等级」）。
 *
 * 判据用**形态**而非词表：`1#厂房`/`2#门卫`/`A栋` 是「编号 + 建筑单体量词」的通用形态。
 *
 * ## 测试纪律
 *
 * 本文件的用例**必须在改动前失败**（已验证：未加单体分池时两条会判冲突）。
 * 写锚点时必须确认它在 `CROSS_SECTION_ANCHORS` 里——用不存在的锚点写用例会「永远通过」，
 * 那种空过测试比没有测试更糟（本轮实测踩过：首版用例用了 `挖沟槽土方`，而该锚点归
 * `qualityValidation.quantityScopeEntries` 管，不在本检测器覆盖内）。
 */
import { describe, expect, it } from 'vitest';
import { crossSectionNumericConflictIssues } from '@/services/document-workflow/documentIntegrityChecks';
import { locationGroupForMatch } from '@/services/document-workflow/integrity/detectors/detectors';

describe('4.61 跨章数值冲突：对象主体分池（cushion 锚点实测形态）', () => {
  it('不同单体的垫层强度等级不互斥（实机三套口径的成因）', () => {
    const md = [
      '1#厂房基础垫层C15，独立基础C35。',
      '2#门卫基础垫层C25，带型基础C35。',
      '3#门卫基础垫层C20，圈梁C25。',
    ].join('\n');
    const messages = crossSectionNumericConflictIssues(md).map(issue => issue.message).join(' ');
    expect(messages, '不同单体的垫层各有自己的强度等级，不是同一口径').not.toContain('垫层混凝土强度等级');
  });

  it('**同一单体**内垫层多值仍照报（分池不放松真冲突）', () => {
    const md = [
      '1#厂房垫层C15，浇筑后养护。',
      '1#厂房垫层C25，局部加厚处理。',
    ].join('\n');
    const messages = crossSectionNumericConflictIssues(md).map(issue => issue.message).join(' ');
    expect(messages).toContain('垫层混凝土强度等级');
  });

  // 单体名形态的直接单测（走导出的抽池函数，精确且不可能空过）：
  // 首版此处用端到端断言，但**两种情况都通过**（空过）——空过测试比没有测试更糟，故改为直测判据本身。
  it('locationGroupForMatch 单体名形态矩阵（判据直测，非端到端）', () => {
    const caseOf = (text: string, keyword: string) => {
      const index = text.indexOf(keyword);
      return locationGroupForMatch(text, index, text.slice(index, index + keyword.length), 0);
    };
    expect(caseOf('2号门卫垫层C25', '垫层')).toBe('2号门卫');
    expect(caseOf('A栋垫层C20', '垫层')).toBe('A栋');
    expect(caseOf('1#厂房垫层C15', '垫层')).toBe('1#厂房');
    // 无单体名时回退部位词/空串（既有行为不变）
    expect(caseOf('屋面垫层C20', '垫层')).not.toBe('');
  });
});
