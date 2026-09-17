/**
 * division-section 残差细分口径与消息明细化（r9 实机 #10/#11 机制归因）：
 * 聚合口径（blocker 条数）下「N 个分项要素不全 / M 个分项参数不足」类阻断在部分修复后条数不变——
 * 修复轮恒判「未下降」回滚丢弃全部进度（r9 实证：主要施工方法章补写被整体回滚，终门禁照常报
 * 两条原阻断）。本测试锁定：
 * 1. 消息明细化：要素不全/参数不足 blocker 逐个点名异常分项（新修复指令可见「哪几个分项缺什么」）；
 * 2. 残差细分：divisionSectionDeficitCount 逐分项缺陷项数——修复一个分项（聚合 blocker 条数不变）
 *    即残差下降（回滚保护恢复灵敏度）；
 * 3. 全分项达标：细分残差 0 且无 blocker（与检测器同源判定）。
 * 阈值单源 writingSpec：blockerMinPackages=3 / minParamsPerPackage=4 / minPackageChars=150。
 */
import { describe, expect, it } from 'vitest';

import { constructionOrgDivisionSectionIssues, divisionSectionDeficitCount } from '@/services/document-workflow/constructionOrgQualityRules';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

/** 达标分项：三要素齐全 + 参数 ≥4 + 篇幅 ≥150 字（与检测器判定同口径构造） */
const PKG_DEMOLITION_OK = [
  '拆除工程作业对象为原有旧路面及附属构筑物破除，总量2783㎡，采用机械拆除配合人工清理。',
  '施工按先切割分块，再分段破碎，随后装车外运，最后场地平整的顺序组织实施。',
  '每段拆除完成即检查基层残留与边线顺直，发现问题立即整改复查并记录销项。',
  '工艺参数：破碎锤冲击能量1800J，分块尺寸不大于500mm，密闭运输率100%，验收合格率98%，分段长度不超过2m。',
].join('\n');

/** 缺陷分项：三要素不全（缺作业对象与工程量/工序顺序）+ 无参数 + 篇幅过短 */
const PKG_EARTHWORK_WEAK = [
  '土方工程采用机械开挖，沟槽分层施工。',
  '施工方法：分层开挖，人工配合清底。',
].join('\n');

/** 缺陷分项：缺作业对象与工程量/工序顺序 + 参数不足（2 个）+ 篇幅过短 */
const PKG_PIPELINE_WEAK = [
  '管道工程敷设DN200塑料管，材料为PE管。',
  '工艺参数：管顶覆土厚度700mm，基础垫层砂厚100mm。',
].join('\n');

/** 修复后的土方分项：三要素齐全 + 参数 ≥4 + 篇幅达标 */
const PKG_EARTHWORK_OK = [
  '土方工程作业对象为管沟及路基土方开挖，总量1200m3，采用机械分层开挖配合人工清底。',
  '施工按先测量放线，再分层开挖，随后边坡修整，最后基底验收的顺序组织实施。',
  '开挖过程每班检查边坡稳定与基底标高，偏差超标立即整改复查并记录销项。',
  '工艺参数：分层厚度不大于300mm，边坡坡度1:1.5，基底标高偏差不超过20mm，压实度不低于93%，分段开挖长度不超过30m。',
].join('\n');

/** 达标管道分项：三要素齐全 + 参数 ≥4 + 篇幅达标 */
const PKG_PIPELINE_OK = [
  '管道工程作业对象为DN200塑料管敷设，总量8205.53m，材料为PE管，沟槽验收后铺管热熔连接。',
  '施工按先沟槽验收，再垫层铺设，随后管道安装，最后闭水试验的顺序组织实施。',
  '每段安装完成即检查接口熔接质量与管顶覆土，发现问题立即整改复查并记录销项。',
  '工艺参数：覆土厚度不小于700mm，垫层砂厚100mm，接口搭接长度不小于50mm，闭水试验压力0.1MPa，分段敷设长度不超过30m。',
].join('\n');

function divisionChapter(...packages: string[]): DocumentDraftChapter {
  return { id: 'ch-division', title: '主要施工方法', content: packages.map(pkg => `### ${pkg}`).join('\n'), evidence: [], missingFacts: [], sections: [] };
}

const blockerCountOf = (issues: Array<{ severity?: string }>) => issues.filter(issue => issue.severity === 'blocker').length;

describe('division-section 残差细分口径（r9 #10/#11 回滚根因根治）', () => {
  it('部分修复一个分项：细分残差下降，而聚合 blocker 条数不变（机制复现）', () => {
    const before = divisionChapter(PKG_DEMOLITION_OK, PKG_EARTHWORK_WEAK, PKG_PIPELINE_WEAK);
    const after = divisionChapter(PKG_DEMOLITION_OK, PKG_EARTHWORK_OK, PKG_PIPELINE_WEAK);
    const beforeDeficit = divisionSectionDeficitCount([before]);
    const afterDeficit = divisionSectionDeficitCount([after]);
    // 细分口径：修复一个分项即残差严格下降（聚合口径不可见 → r9 恒判「未下降」回滚）
    expect(beforeDeficit).toBeGreaterThan(afterDeficit);
    expect(afterDeficit).toBeGreaterThan(0);
    // 聚合口径不变：两类阻断（要素不全/参数不足）分别仍有残留分项 → blocker 条数相同
    const beforeBlockers = blockerCountOf(constructionOrgDivisionSectionIssues([before]));
    const afterBlockers = blockerCountOf(constructionOrgDivisionSectionIssues([after]));
    expect(beforeBlockers).toBe(afterBlockers);
    expect(beforeBlockers).toBeGreaterThan(0);
  });

  it('消息明细化：异常分项逐个点名（修复轮指令可定向补写）', () => {
    const chapter = divisionChapter(PKG_DEMOLITION_OK, PKG_EARTHWORK_WEAK, PKG_PIPELINE_WEAK);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    const incomplete = issues.find(issue => issue.message.includes('内容要素不全'));
    const weakParam = issues.find(issue => issue.message.includes('工艺参数不足'));
    expect(incomplete).toBeDefined();
    expect(weakParam).toBeDefined();
    // 点名缺陷分项（达标分项不出现）
    expect(incomplete!.message).toContain('土方工程');
    expect(incomplete!.message).toContain('管道工程');
    expect(incomplete!.message).not.toContain('拆除工程');
    expect(weakParam!.message).toContain('土方工程');
    expect(weakParam!.message).toContain('管道工程');
    expect(weakParam!.message).toContain('工艺参数不足');
  });

  it('全分项达标：细分残差 0 且无 blocker（与检测器同源判定）', () => {
    const chapter = divisionChapter(PKG_DEMOLITION_OK, PKG_EARTHWORK_OK, PKG_PIPELINE_OK);
    expect(divisionSectionDeficitCount([chapter])).toBe(0);
    expect(blockerCountOf(constructionOrgDivisionSectionIssues([chapter]))).toBe(0);
  });

  it('非分部分项章：无候选章且无分项结构时残差 0（与检测器不报同构）', () => {
    const chapter: DocumentDraftChapter = { id: 'ch-other', title: '工程概况', content: '本工程位于工业园区。', evidence: [], missingFacts: [], sections: [] };
    expect(divisionSectionDeficitCount([chapter])).toBe(0);
  });
});
