import { describe, expect, it } from 'vitest';
import {
  acceptExpandedChapter,
  currentSectionBlock,
  dedupeQuantityFacts,
  ensureGroupTertiaryShell,
  ensureTertiarySectionShell,
  expansionRoundsForDeficit,
  filterConstructionSteps,
  groupHasMajorConstructionSection,
  isGeneralManagementSection,
  keySectionWritingRequirement,
  majorContentPollutionIssue,
  mergeDuplicateWorkPackageSubsections,
  outputTokensForChapter,
  parseMajorConstructionPackages,
  repairMajorContentWorkPackageLabels,
  sectionContentBody,
  sectionStructureIssue,
} from '@/services/document-workflow/chapterPostProcessing';

describe('sectionContentBody / currentSectionBlock（节块定位）', () => {
  it('sectionContentBody 剥离三级/四级标题行', () => {
    expect(sectionContentBody('### 1.1 工程概况\n本项目位于合肥市。')).toBe('本项目位于合肥市。');
    expect(sectionContentBody('#### 工作包A\n施工概况：范围说明。')).toBe('施工概况：范围说明。');
  });

  it('currentSectionBlock 提取目标节块（到下一 ### 为止）', () => {
    const content = '### 1.1 工程概况\n内容甲。\n### 1.2 施工部署\n内容乙。';
    const block = currentSectionBlock('1.2 施工部署', content);
    expect(block).toContain('内容乙');
    expect(block).not.toContain('内容甲');
  });

  it('currentSectionBlock 支持带编号前缀的标题匹配', () => {
    const content = '### 2.3 项目主要施工内容\n#### 2.3.1 室外道排工程\n施工概况：范围。';
    const block = currentSectionBlock('项目主要施工内容', content);
    expect(block).toContain('#### 2.3.1 室外道排工程');
  });
});

describe('dedupeQuantityFacts（清单条目式去重）', () => {
  it('子串包含关系合并（保留更全条目）', () => {
    expect(dedupeQuantityFacts(['配电箱 2台', '配电箱 非标箱 挂墙安装 2台'])).toEqual(['配电箱 非标箱 挂墙安装 2台']);
  });

  it('共享型号标识且词集合包含时合并', () => {
    expect(dedupeQuantityFacts(['XX总箱1APEza 2台', 'XX总箱1APEza'])).toEqual(['XX总箱1APEza 2台']);
  });

  it('不同对象不合并', () => {
    expect(dedupeQuantityFacts(['配电箱 2台', '水泵 3台'])).toEqual(['配电箱 2台', '水泵 3台']);
  });
});

describe('filterConstructionSteps（流程步骤中清单条目剔除）', () => {
  it('数字+量词条目式步骤剔除', () => {
    expect(filterConstructionSteps(['配电箱 非标箱 挂墙安装 2台', '桥架安装'], ['配电箱 非标箱 挂墙安装 2台'])).toEqual(['桥架安装']);
  });

  it('设备型号串步骤剔除（字母+数字+设备词形态）', () => {
    expect(filterConstructionSteps(['配电箱APE11', '穿线放线'], [])).toEqual(['穿线放线']);
  });

  it('短工序词（≤6 字含动作词）保留', () => {
    expect(filterConstructionSteps(['砌筑', '抹灰'], ['砌筑 2m³'])).toEqual(['砌筑', '抹灰']);
  });

  it('短残尾是清单子串则剔除', () => {
    expect(filterConstructionSteps(['配电箱'], ['配电箱 2台'])).toEqual([]);
  });
});

describe('parseMajorConstructionPackages（结构化 JSON / 图谱行两通道）', () => {
  it('结构化 JSON 通道：解析工作包并清洗脏数据', () => {
    const context = '施工工作包结构化数据： [{"name":"室外道排工程","scope":"室外雨污水管网改造","quantities":["雨水管 1200m","雨水管 1200m","挖沟槽 500m³"],"process":["放线→开挖→铺设→回填","配电箱 2台"],"acceptance":["闭水试验验收"]}]';
    const packages = parseMajorConstructionPackages(context, []);
    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe('室外道排工程');
    // 数量去重 + 流程剔除清单条目；箭头链按 → 拆为单步
    expect(packages[0].quantities).toEqual(['雨水管 1200m', '挖沟槽 500m³']);
    expect(packages[0].process).toEqual(['放线', '开挖', '铺设', '回填']);
    expect(packages[0].acceptance).toEqual(['闭水试验验收']);
  });

  it('图谱行通道：按「｜范围：…｜工程量/材料：…｜流程：…｜验收：…」解析', () => {
    const context = '1. 屋面维修工程｜范围：屋面防水卷材翻新｜工程量/材料：防水卷材 800㎡｜流程：清底→找平→铺设→密封｜验收：淋水试验';
    const packages = parseMajorConstructionPackages(context, []);
    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe('屋面维修工程');
    expect(packages[0].quantities).toEqual(['防水卷材 800㎡']);
    expect(packages[0].process).toEqual(['清底', '找平', '铺设', '密封']);
    expect(packages[0].acceptance).toEqual(['淋水试验']);
  });

  it('名称以「项目施工」结尾/scope 缺失的工作包跳过', () => {
    const context = '施工工作包结构化数据： [{"name":"本项目施工","scope":"全项目","quantities":[],"process":[]},{"name":"室外道排工程","scope":"","quantities":[]}]';
    expect(parseMajorConstructionPackages(context, [])).toHaveLength(0);
  });

  it('无结构化数据且无图谱行返回空', () => {
    expect(parseMajorConstructionPackages('普通上下文。', [])).toHaveLength(0);
  });
});

describe('majorContentPollutionIssue（脏事实/标题污染检查）', () => {
  it('脏话术命中', () => {
    expect(majorContentPollutionIssue('本项目资料内容事实：未检索到。')).toBe(true);
    expect(majorContentPollutionIssue('未尽事宜详见招标文件。')).toBe(true);
  });

  it('非法标题层级（## / #####）命中，#### 合法不命中', () => {
    expect(majorContentPollutionIssue('## 错误二级标题\n正文。')).toBe(true);
    expect(majorContentPollutionIssue('##### 错误五级标题\n正文。')).toBe(true);
    expect(majorContentPollutionIssue('#### 2.3.1 室外道排工程\n施工概况：范围。')).toBe(false);
  });

  it('投标程序话术命中（联合体投标/投标保证金等）', () => {
    expect(majorContentPollutionIssue('投标保证金为50万元。')).toBe(true);
  });

  it('正常正文不命中', () => {
    expect(majorContentPollutionIssue('#### 2.3.1 室外道排工程\n施工概况：室外雨污水管网改造，工程量1200m。\n施工流程：放线→开挖→铺设→回填。\n施工方法：采用机械开挖，分层回填压实并检测压实度。')).toBe(false);
  });
});

describe('repairMajorContentWorkPackageLabels（三段标签确定性补全）', () => {
  const content = '### 2.3 项目主要施工内容\n#### 2.3.1 室外道排工程\n室外雨污水管网改造，工程量1200m。\n放线→开挖→铺设→回填。\n采用机械开挖，分层回填压实。';

  it('缺标签时按顺序补全（概况/流程/方法）', () => {
    const result = repairMajorContentWorkPackageLabels(content);
    expect(result).toContain('施工概况：室外雨污水管网改造，工程量1200m。');
    expect(result).toContain('施工流程：放线→开挖→铺设→回填。');
    expect(result).toContain('施工方法：采用机械开挖，分层回填压实。');
  });

  it('标签齐全的块原样保留', () => {
    const complete = '### 2.3 项目主要施工内容\n#### 2.3.1 室外道排工程\n施工概况：范围。\n施工流程：放线→开挖。\n施工方法：机械开挖。';
    expect(repairMajorContentWorkPackageLabels(complete)).toBe(complete);
  });

  it('不含项目主要施工内容节时原样返回', () => {
    const other = '### 1.1 工程概况\n内容。';
    expect(repairMajorContentWorkPackageLabels(other)).toBe(other);
  });
});

describe('sectionStructureIssue（项目主要施工内容节结构门禁）', () => {
  const goodPackage = (index: number, name: string, method = '采用机械开挖并组织专业班组浇筑施工，分层回填压实后逐层检测压实度，验收合格形成记录报告后闭环。') => `#### 2.3.${index} ${name}\n施工概况：${name}范围明确，工程量1200m，材料HDPE管。\n施工流程：放线定位→沟槽开挖→管道铺设→分层回填。\n施工方法：${method}`;

  it('完整结构（≥3 工作包+三段标签+工序顺序）通过', () => {
    const content = `### 2.3 项目主要施工内容\n${goodPackage(1, '室外道排工程')}\n${goodPackage(2, '屋面维修工程')}\n${goodPackage(3, '外墙装饰工程')}`;
    expect(sectionStructureIssue('项目主要施工内容', content)).toBe('');
  });

  it('缺工作包三级小节报结构缺失', () => {
    expect(sectionStructureIssue('项目主要施工内容', '### 2.3 项目主要施工内容\n只有概述没有工作包。')).toContain('缺少施工工作包三级小节');
  });

  it('工作包缺工序要素报内容要素不全（4.17.9 标签不再是硬性要求）', () => {
    const content = `### 2.3 项目主要施工内容\n${goodPackage(1, '室外道排工程')}\n${goodPackage(2, '屋面维修工程')}\n#### 2.3.3 外墙装饰工程\n施工概况：范围。\n施工方法：机械作业。`;
    const issue = sectionStructureIssue('项目主要施工内容', content);
    expect(issue).toContain('内容要素不全');
  });

  it('无标签但三要素齐全的块通过（呈现形式不限）', () => {
    const content = `### 2.3 项目主要施工内容\n${goodPackage(1, '室外道排工程')}\n${goodPackage(2, '屋面维修工程')}\n#### 2.3.3 外墙装饰工程\n外墙装饰改造范围明确，作业对象为全部外立面，工程量约3200㎡。施工顺序为先基层清理，再放线定位，随后分层刮涂，最后养护并逐层验收记录。采用电动吊篮配合人工分层作业，胶缝宽度控制在8mm内，垂直度偏差不超过3mm，验收合格后形成检测记录归档闭环。`;
    expect(sectionStructureIssue('项目主要施工内容', content)).toBe('');
  });

  it('脏话术进入工作包报污染', () => {
    const content = `### 2.3 项目主要施工内容\n${goodPackage(1, '室外道排工程')}\n${goodPackage(2, '屋面维修工程')}\n#### 2.3.3 外墙装饰工程\n施工概况：资料内容事实：未检索到。\n施工流程：放线→作业。\n施工方法：机械作业验收。`;
    expect(sectionStructureIssue('项目主要施工内容', content)).toContain('污染');
  });

  it('非项目主要施工内容节不检查（返回空）', () => {
    expect(sectionStructureIssue('工程概况', '内容。')).toBe('');
  });
});

describe('ensureTertiarySectionShell / ensureGroupTertiaryShell', () => {
  it('无三级小节时补壳（标题=小节名）', () => {
    expect(ensureTertiarySectionShell('工程概况', '### 工程概况\n本项目位于合肥市。')).toBe('### 工程概况\n\n#### 工程概况\n\n本项目位于合肥市。');
  });

  it('已有三级小节不补壳', () => {
    const content = '### 工程概况\n#### 工程概况\n内容。';
    expect(ensureTertiarySectionShell('工程概况', content)).toBe(content);
  });

  it('ensureGroupTertiaryShell 逐节补壳，跳过项目主要施工内容', () => {
    const content = '### 1.1 工程概况\n概况内容。\n### 2.3 项目主要施工内容\n#### 2.3.1 工作包\n施工概况：范围。';
    const result = ensureGroupTertiaryShell(['工程概况', '项目主要施工内容'], content);
    expect(result).toContain('#### 工程概况');
    expect(result).toContain('#### 2.3.1 工作包');
  });

  it('groupHasMajorConstructionSection 判定', () => {
    expect(groupHasMajorConstructionSection(['工程概况', '项目主要施工内容'])).toBe(true);
    expect(groupHasMajorConstructionSection(['工程概况', '施工部署'])).toBe(false);
  });
});

describe('小节分类与写作要求', () => {
  it('isGeneralManagementSection 命中管理类小节', () => {
    expect(isGeneralManagementSection('项目管理组织')).toBe(true);
    expect(isGeneralManagementSection('工程概况')).toBe(false);
  });

  it('keySectionWritingRequirement 按小节类型下发', () => {
    expect(keySectionWritingRequirement('项目特点、重点、难点分析')).toContain('项目特点分析');
    expect(keySectionWritingRequirement('项目主要施工内容')).toContain('三方面要素');
    expect(keySectionWritingRequirement('主要分部分项工程施工方案')).toContain('专业工程');
    expect(keySectionWritingRequirement('普通小节')).toBe('');
  });
});

describe('篇幅/轮次/接受判定', () => {
  it('outputTokensForChapter：下限 5000 上限 24000', () => {
    expect(outputTokensForChapter(1000)).toBe(5000);
    expect(outputTokensForChapter(10000)).toBe(14500);
    expect(outputTokensForChapter(30000)).toBe(24000);
  });

  it('expansionRoundsForDeficit：每 4000 字符一轮', () => {
    expect(expansionRoundsForDeficit(0)).toBe(0);
    expect(expansionRoundsForDeficit(1)).toBe(1);
    expect(expansionRoundsForDeficit(4000)).toBe(1);
    expect(expansionRoundsForDeficit(4001)).toBe(2);
  });

  it('acceptExpandedChapter：增长不足/超上限/丢标题拒绝，正常接受', () => {
    const previous = '### 1.2 施工部署\n' + '正文。'.repeat(100);
    // 超上限拒绝
    expect(acceptExpandedChapter(previous, previous + '补充'.repeat(5000), '施工部署', 300)).toBe(false);
    // 无增长拒绝
    expect(acceptExpandedChapter(previous, previous, '施工部署', 400)).toBe(false);
    // 丢标题拒绝
    expect(acceptExpandedChapter(previous, '### 其他\n' + '正文。'.repeat(200), '施工部署', 500)).toBe(false);
    // 正常增长接受（增长量远超 minimumGrowth）
    const grown = `### 施工部署\n${previous.replace('### 1.2 施工部署\n', '')}${'补充措施。'.repeat(300)}`;
    expect(acceptExpandedChapter(previous, grown, '施工部署', 4000)).toBe(true);
  });
});

describe('mergeDuplicateWorkPackageSubsections（X工程/X工作包重复小节合并）', () => {
  it('工作包小节并入同名工程小节并删除', () => {
    // 两小节三段语义高度重合（满足段重合判定），工作包独有量化句「雨水管 1200m 埋深1.5m」并入保留小节
    const content = '### 2.3 项目主要施工内容\n#### 2.3.1 室外道排工程\n施工概况：室外雨污水管网改造，工程量1200m。\n施工流程：放线定位→沟槽开挖→管道铺设。\n施工方法：采用机械开挖，分层回填压实。\n#### 2.3.2 室外道排工程工作包\n施工概况：室外雨污水管网改造范围明确，工程量1200m。\n施工流程：定位放线→开挖沟槽→铺设管道。\n施工方法：采用机械开挖分层回填压实，雨水管 1200m 埋深1.5m。';
    const result = mergeDuplicateWorkPackageSubsections(content);
    expect(result).not.toContain('工作包');
    expect(result).toContain('雨水管 1200m 埋深1.5m');
    // 编号重排：只剩一个 #### 工作包
    expect((result.match(/^####\s+/gmu) || [])).toHaveLength(1);
    expect(result).toContain('2.3.1 室外道排工程');
  });

  it('无工作包小节时原样返回', () => {
    const content = '### 2.3 项目主要施工内容\n#### 2.3.1 室外道排工程\n施工概况：范围。\n施工流程：放线→开挖。\n施工方法：机械开挖。';
    expect(mergeDuplicateWorkPackageSubsections(content)).toBe(content);
  });
});
