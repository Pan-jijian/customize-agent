/**
 * 4.61 被取消项的残留清除。
 *
 * 实机缺陷：答疑把「氯化橡胶面漆两道」改为「不需要」，正文仍写
 * 「面漆施工：防火涂料表面喷涂氯化橡胶面漆两道，漆膜厚度80μm…」——把已取消的做法当现行工艺陈述。
 *
 * 为什么是删除而不是替换：通用替换器处理的是**值替换**（365→330 日历天），
 * 而取消项的生效值是「不需要」，替换进句子会产出「…喷涂不需要…」病句。
 */
import { describe, expect, it } from 'vitest';
import { fixCancelledPracticeResidue } from '@/services/document-workflow/documentIntegrityChecks';

describe('fixCancelledPracticeResidue 形态矩阵', () => {
  it('实机形态：编号列表项承载取消项 → 整项删除并**重排后续编号**（不得引入编号不连续）', () => {
    const md = [
      '施工工序如下：',
      '1. 基层处理：清除浮灰并涂刷界面剂。',
      '2. 防火涂料喷涂：分遍喷涂至设计厚度。',
      '3. 面漆施工：防火涂料表面喷涂氯化橡胶面漆两道，漆膜厚度80μm。',
      '4. 验收：涂层外观均匀无流坠。',
    ].join('\n');
    const result = fixCancelledPracticeResidue(md, ['氯化橡胶面漆两道']);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).not.toContain('氯化橡胶面漆');
    // 删除后编号必须连续（否则触发「有序列表编号不连续」缺陷）
    expect(result.markdown).toContain('1. 基层处理');
    expect(result.markdown).toContain('2. 防火涂料喷涂');
    expect(result.markdown).toContain('3. 验收');
    expect(result.markdown).not.toContain('4. 验收');
  });

  it('普通段落：只删承载句，同段其余句子保留', () => {
    const md = '本工程外墙做法为真石漆。室内顶棚喷涂氯化橡胶面漆两道。灯具采用LED光源。';
    const result = fixCancelledPracticeResidue(md, ['氯化橡胶面漆两道']);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('本工程外墙做法为真石漆');
    expect(result.markdown).toContain('灯具采用LED光源');
    expect(result.markdown).not.toContain('氯化橡胶面漆');
  });

  it('变更叙述句**保留**（把取消过程说清楚是合法的）', () => {
    const md = '面漆做法原为氯化橡胶面漆两道，经答疑澄清变更为取消该项，不再实施。';
    expect(fixCancelledPracticeResidue(md, ['氯化橡胶面漆两道'])).toEqual({ markdown: md, fixedCount: 0, details: [] });
  });

  it('不误伤：无目标项时零变更；标题行/表格行不参与删除', () => {
    const md = '#### 1.2 面漆工程\n| 工序 | 做法 |\n| --- | --- |\n| 面漆 | 氯化橡胶面漆两道 |';
    expect(fixCancelledPracticeResidue(md, [])).toEqual({ markdown: md, fixedCount: 0, details: [] });
    expect(fixCancelledPracticeResidue(md, ['氯化橡胶面漆两道']).markdown).toBe(md);
  });
});

describe('4.61 变更叙述判定必须逐句（实测缺陷：长行被整行豁免）', () => {
  it('长段落中**其它句**含「取消」不得豁免本句的取消项残留', () => {
    const md = '本工程对拉杆取消原设计做法，改为后置埋件。钢构件在加工厂完成制作，除锈后喷涂无机富锌底漆一道；最后在防火涂料表面喷涂氯化橡胶面漆两道，漆膜厚度80μm。现场安装按钢柱吊装顺序推进。';
    const result = fixCancelledPracticeResidue(md, ['氯化橡胶面漆两道']);
    expect(result.fixedCount, '其它句的变更叙述不得豁免本句').toBe(1);
    expect(result.markdown).not.toContain('氯化橡胶面漆');
    expect(result.markdown, '同段其它句必须保留').toContain('本工程对拉杆取消原设计做法');
    expect(result.markdown).toContain('现场安装按钢柱吊装顺序推进');
  });

  it('本句自身含变更叙述 → 仍保留（把取消过程说清楚是合法的）', () => {
    const md = '面漆做法原为氯化橡胶面漆两道，经答疑澄清变更为取消该项。';
    expect(fixCancelledPracticeResidue(md, ['氯化橡胶面漆两道']).fixedCount).toBe(0);
  });
});
