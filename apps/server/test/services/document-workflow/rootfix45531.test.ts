/**
 * 4.55.31 根修回归集（本轮 A：跨章一致性「挖沟槽土方」对象分组口径）。
 *
 * 用例取自**服务真实产出** `doc-1790125123717-ce5cc107`（巢湖）的实测误报：
 * `跨章一致性冲突：正文挖沟槽土方出现互相矛盾的取值 346.88、37.51、9926.65、1900.8`——
 * 四条取值分属 2#门卫 / 3#门卫 / 室外附属 / 室外安装四个对象，各对象工程量天然不同，
 * 属**合法分对象列举**；旧判据（24 字前置语境）取不到对象标识（标识在标题行与前一句）而误报。
 * 每一条先锁定「误报必须消失」，再锁定「真缺陷仍必须报出」（防判据放宽成不设防）。
 */
import { describe, expect, it } from 'vitest';
import { crossChapterConsistencyIssues } from '@/services/document-workflow/qualityValidation';
import type { DocumentFactsModel } from '@/services/document-workflow/types';
import { RealLocalEmbeddingProvider } from '../../helpers/real-embedding';

const embedder = new RealLocalEmbeddingProvider();

/** 探针：经公开入口触发跨章一致性检测中的「挖沟槽土方」条目（避免测私有实现） */
async function caliberScopeProbe(markdown: string) {
  const factsModel = { project: [], schedule: [], quality: [], safety: [], billItemFacts: [] } as unknown as DocumentFactsModel;
  const issues = await crossChapterConsistencyIssues(markdown, factsModel, undefined, undefined, embedder.embedDocuments.bind(embedder));
  return issues.filter(issue => /挖沟槽土方/.test(issue.message));
}

describe('4.55.31 跨章一致性·对象分组口径', () => {
  // 真机文档 `doc-1790125123717-ce5cc107` 四条命中的逐字节选（对象标识：标题行 / 前一句）
  const REAL_OBJECT_MARKED = [
    '#### 1.5.2 2#门卫',
    '2#门卫为单层框架结构，建筑面积241.7平方米，耐火等级二级，基础条形基础往外挑出，框架柱部分箍筋全高加密。',
    '作业对象含场地平整241.71m²、挖沟槽土方346.88m³、槽底人工清底265.84m²、回填方242.96m³、余方外运103.92m³。',
    '#### 1.5.3 3#门卫',
    '3#门卫为单层框架结构，建筑面积13.5平方米，耐火等级二级，框架柱箍筋全高加密，直形墙100mm厚C25商品混凝土。',
    '作业对象含场地平整16.07m²、挖沟槽土方37.51m³、槽底人工清底26.52m²、回填方29.13m³、余方外运8.38m³。',
    '### 1.27 材料设备报审与见证检测',
    '材料设备报审按下列工序顺序实施：编制报审计划→材料员报监理审批→进场核对质量证明文件→监理见证取样。',
    '1. 土方开挖：挖一般土方22048.7m³，挖沟槽土方9926.65m³，挖基坑土方15177.04m³，机械开挖至垫层底标高以上200mm。',
    '#### 1.40.2 其他分部分项工程施工要点',
    '沟槽挖填按室外安装工程1900.8m³挖沟槽土方、1900.8m³回填方组织，管道两侧对称分层回填，每层虚铺厚度不大于300mm。',
  ];

  it('实机形态：对象标识在标题行/前一句（2#门卫 346.88 / 3#门卫 37.51 / 本工程 9926.65 / 室外安装 1900.8）不判冲突', async () => {
    const issues = await caliberScopeProbe(REAL_OBJECT_MARKED.join('\n'));
    expect(issues).toHaveLength(0);
  });

  it('同文本剥离对象标识（标题行与前一句）后，同一「未标注」组多值必须报出——证明上例不是「命中没找到」的空过', async () => {
    const stripped = REAL_OBJECT_MARKED.filter(line => !/^(?:#{2,6} |\d+[#＃])/u.test(line) && !/为单层框架结构/u.test(line));
    const issues = await caliberScopeProbe(stripped.join('\n'));
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues[0]!.severity).toBe('blocker');
    expect(issues[0]!.message).toMatch(/346\.88/);
    expect(issues[0]!.message).toMatch(/37\.51/);
  });

  it('无标题文档：未标注取值不得继承前文（上文段落）的对象标识（4.55.29 L0-8 正例同步守护）', async () => {
    const issues = await caliberScopeProbe([
      '2#门卫按平整场地241.71m²、挖沟槽土方346.88m³、回填方242.96m³组织流水。',
      '3#门卫按平整场地16.07m²、挖沟槽土方37.51m³、回填方29.13m³组织流水。',
      '室外附属工程挖沟槽土方9926.65m³，按分区段平行推进。',
    ].join('\n'));
    expect(issues).toHaveLength(0);
  });

  it('同一句既提 2#门卫又提 3#门卫：取值按**就近**标识归属，两条分属不同对象不判冲突', async () => {
    const issues = await caliberScopeProbe([
      '2#门卫挖沟槽土方346.88m³、3#门卫挖沟槽土方37.51m³，按分区段平行推进。',
    ].join('\n'));
    expect(issues).toHaveLength(0);
  });

  it('同一对象（2#门卫）同一工程量出现矛盾取值仍必须报出', async () => {
    const issues = await caliberScopeProbe([
      '2#门卫基础土方按分区段平行推进，挖沟槽土方346.88m³。',
      '2#门卫基础土方按分区段平行推进，挖沟槽土方512.34m³。',
    ].join('\n'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('blocker');
  });

  it('无对象标识：同源语境（同句/同列表）多值仍必须报出（4.55.29 L0-8 反向守护）', async () => {
    const issues = await caliberScopeProbe([
      '本项目室外附属工程挖沟槽土方9926.65m³，按分区段平行推进。',
      '本项目室外附属工程挖沟槽土方879.41m³，按分区段平行推进。',
    ].join('\n'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('blocker');
  });

  it('章节编号（1.22/1.23）不构成对象标识：不会把同对象真冲突「分组豁免」掉', async () => {
    // 编号只出现在标题行、两条取值句完全相同（同源语境）→ 仍判冲突
    const issues = await caliberScopeProbe([
      '### 1.22 挖沟槽土方施工',
      '本项目室外附属工程挖沟槽土方9926.65m³，按设计标高机械开挖。',
      '### 1.23 沟槽回填施工',
      '本项目室外附属工程挖沟槽土方879.41m³，按设计标高机械开挖。',
    ].join('\n'));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe('blocker');
  });
});
