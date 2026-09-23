/**
 * 4.55.32 根修回归集（B：跨章一致性「挖沟槽土方」**按对象分组比较**收口）。
 *
 * 用例取自服务真实产出 `doc-1790132484476-29b74c88`（巢湖）的实测误报：
 * `跨章一致性冲突：正文挖沟槽土方出现互相矛盾的取值 37.51、879.41、346.88、1900.8`——
 * 实测四条取值的对象标识为 3#门卫（37.51，其句内「**与2#门卫**同属门卫单体」的 2# 距取值更近，
 * 旧「最近标识」把它误归 2# 组）、1#厂房（879.41）、2#门卫（346.88）、12号（1900.8，来自
 * 灯位图例「11号为深照型灯具、12号为广照型」的编号误读）；37.51 与 346.88 因此被归入同一
 * 「2#」组而误报。每例先锁定「误报必须消失」，再锁定「真缺陷仍必须报出」（防判据放宽成不设防）。
 */
import { describe, expect, it } from 'vitest';
import { crossChapterConsistencyIssues } from '@/services/document-workflow/qualityValidation';
import type { DocumentFactsModel } from '@/services/document-workflow/types';

/** 探针：经公开入口触发跨章一致性检测中的「挖沟槽土方」条目（避免测私有实现） */
async function caliberScopeProbe(markdown: string) {
  const factsModel = { project: [], schedule: [], quality: [], safety: [], billItemFacts: [] } as unknown as DocumentFactsModel;
  const embed = async (texts: string[]) => texts.map(() => [0, 0, 0]);
  const issues = await crossChapterConsistencyIssues(markdown, factsModel, undefined, undefined, embed);
  return issues.filter(issue => /挖沟槽土方/.test(issue.message));
}

describe('4.55.32 跨章一致性·按对象分组（未标注组）+ 并列引用标识剔除', () => {
  it('实机形态四条取值（3#门卫 37.51 / 1#厂房 879.41 / 2#门卫 346.88 / 室外安装 1900.8）不判冲突', async () => {
    // 逐字节选真机行（对象标识在标题行 / 前一句 / 句内引用语境）
    const markdown = [
      '#### 1.4.1 2#门卫',
      '2#门卫为框架结构，基础为条形基础，基础混凝土往外挑出，框架柱部分箍筋全高加密。作业对象含土方开挖、条形基础、框架柱梁板、砌体围护及水电安装。',
      '#### 1.4.2 3#门卫',
      '3#门卫为框架结构，框架柱箍筋全高加密，与2#门卫同属门卫单体。作业对象含基槽土方、条形基础、框架柱梁板、屋面及水电安装，工程量包括挖沟槽土方37.51m³、人工清底26.52m²、回填方29.13m³、砖基础2.36m³。',
      '### 1.39 基础工程',
      '1#厂房土建工程土石方作业自场地清表起步，先以推土机配合挖掘机完成平整场地61112.9m²，同步组织场地清杂与排水、降水各1项，沿基坑周边设排水沟并配集水井，保持作业面干燥。随后按挖一般土方12792.8m³、挖沟槽土方879.41m³、挖基坑土方10400.47m³分区开挖，挖土深度按现状自然地面至室内地面垫层底标高控制。',
      '#### 1.39.2 土石方工程',
      '2#门卫基础形式为带型基础，土方作业对象为带型基础及基础梁沟槽。场地平整按30cm以内缺土及多余土方挖运组织，平整场地241.71m²；挖沟槽土方346.88m³，清单量内含工作面；人工清底265.84m²。',
      '1#厂房灯具图例中11号为深照型灯具、12号为广照型，我方按图例参数分别采购与安装。',
      '沟槽挖填按挖沟槽土方1900.8m³、回填组织，管沟底宽按管径每侧加300mm工作面，回填分层厚度不大于300mm、压实系数不小于0.95。',
    ].join('\n');
    expect(await caliberScopeProbe(markdown)).toHaveLength(0);
  });

  it('并列引用标识（「与2#门卫同属门卫单体」）不计入本取值的对象归属：3#门卫 37.51 与 2#门卫 346.88 不同组', async () => {
    const markdown = [
      '#### 1.4.2 3#门卫',
      '3#门卫为框架结构，与2#门卫同属门卫单体。作业对象含基槽土方、条形基础，工程量包括挖沟槽土方37.51m³、回填方29.13m³。',
      '#### 1.4.1 2#门卫',
      '2#门卫基础形式为带型基础，工程量包括挖沟槽土方346.88m³、回填方242.96m³。',
    ].join('\n');
    expect(await caliberScopeProbe(markdown)).toHaveLength(0);
  });

  it('反例：同一对象（同标识 2#）同工程量两个矛盾取值仍必须报出', async () => {
    const markdown = [
      '#### 1.5.2 2#门卫',
      '2#门卫基础土方按分区段平行推进，挖沟槽土方346.88m³。',
      '#### 1.5.3 2#门卫附属',
      '2#门卫基础土方按分区段平行推进，挖沟槽土方512.34m³。',
    ].join('\n');
    const issues = await caliberScopeProbe(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('blocker');
  });

  it('反例：两侧均无标识 + 同源语境（24 字前缀共享 ≥6 连续汉字）多值仍必须报出', async () => {
    const markdown = [
      '本项目室外附属工程挖沟槽土方9926.65m³，按设计标高机械开挖。',
      '本项目室外附属工程挖沟槽土方879.41m³，按设计标高机械开挖。',
    ].join('\n');
    const issues = await caliberScopeProbe(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('blocker');
  });

  it('一方有标识、一方无标识属跨组：不得无条件退回语境判据（不再仅凭同源语境判冲突）', async () => {
    // 未标注取值与有标识取值「同源语境」但对象不可断言 → 不判；同源语境判据只在**双方都未标注**
    // （同属「未标注」组）时使用
    const markdown = [
      '#### 1.5.2 2#门卫',
      '本项目室外附属工程挖沟槽土方346.88m³，按设计标高机械开挖。',
      '',
      '### 1.27 材料设备报审与见证检测',
      '本项目室外附属工程挖沟槽土方512.34m³，按设计标高机械开挖。',
    ].join('\n');
    expect(await caliberScopeProbe(markdown)).toHaveLength(0);
  });
});
