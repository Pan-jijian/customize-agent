import { describe, expect, it } from 'vitest';
import type { DocumentEvidence } from '@/services/document-workflow/types';
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
  majorConstructionSkeletonNames,
  majorContentPollutionIssue,
  mergeDuplicateWorkPackageSubsections,
  missingWorkPackageSkeletonTitles,
  outputTokensForChapter,
  parseMajorConstructionPackages,
  repairMajorContentWorkPackageLabels,
  sectionContentBody,
  sectionStructureIssue,
  scopeEngineeringNames,
  stripEmptyWorkPackageHeadings,
  stripMarkdownTableBlocks,
  stripTablesInSection,
  workPackageCrossSectionIssue,
  workPackageSkeletonPrompt,
  workPackageSkeletonTitles,
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
  it('无三级小节时补壳：只补 H3，不补同名 H4（彻底修复同名结构）', () => {
    expect(ensureTertiarySectionShell('工程概况', '### 工程概况\n本项目位于合肥市。')).toBe('### 工程概况\n\n本项目位于合肥市。');
  });

  it('已有四级小节不补壳', () => {
    const content = '### 工程概况\n#### 工程概况\n内容。';
    expect(ensureTertiarySectionShell('工程概况', content)).toBe(content);
  });

  it('ensureGroupTertiaryShell：H3 与组标题同名时不补同名 H4，跳过项目主要施工内容', () => {
    const content = '### 1.1 工程概况\n概况内容。\n### 2.3 项目主要施工内容\n#### 2.3.1 工作包\n施工概况：范围。';
    const result = ensureGroupTertiaryShell(['工程概况', '项目主要施工内容'], content);
    // 彻底修复：H3「工程概况」与组标题同名 → H3 即承担该小节标题，不再补同名 H4（历史缺陷：H3/H4 同名诱发模型重复展开）
    expect(result).not.toContain('#### 工程概况');
    expect(result).toContain('#### 2.3.1 工作包');
  });

  it('ensureGroupTertiaryShell：组标题与 H3 同名段不再产生同名 H4 外壳', () => {
    const content = '### 施工部署\n部署内容。';
    const result = ensureGroupTertiaryShell(['施工部署'], content);
    expect(result).toBe('### 施工部署\n\n部署内容。\n');
    expect(result).not.toContain('#### 施工部署');
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

describe('工作包骨架锁定（稳定版）', () => {
  const context = [
    '1. 屋面维修工程｜范围：屋面防水卷材翻新｜工程量/材料：防水卷材 800㎡｜流程：清底→找平→铺设→密封｜验收：淋水试验',
    '2. 室外道排工程｜范围：室外雨污水管网改造｜工程量/材料：雨水管 1200m｜流程：放线→开挖→铺设→回填｜验收：闭水试验',
    '3. 室内装修改造工程｜范围：室内装饰面翻新｜工程量/材料：墙面乳胶漆 6000㎡｜流程：基层处理→批腻子→涂刷｜验收：外观检查',
  ].join('\n');

  it('workPackageSkeletonTitles：识别到 ≥3 个工作包返回清单，不足时返回空', () => {
    expect(workPackageSkeletonTitles(context, [])).toEqual(['屋面维修工程', '室外道排工程', '室内装修改造工程']);
    expect(workPackageSkeletonTitles('普通上下文。', [])).toEqual([]);
  });

  it('workPackageSkeletonPrompt：锁定骨架标题 + 三要素 + 否定性约束', () => {
    const prompt = workPackageSkeletonPrompt(context, []);
    expect(prompt).toContain('#### 1 屋面维修工程');
    expect(prompt).toContain('#### 3 室内装修改造工程');
    expect(prompt).toContain('作业对象与工程量');
    expect(prompt).toContain('禁止出现 Markdown 表格');
    expect(prompt).toContain('重难点识别表');
    expect(workPackageSkeletonPrompt('普通上下文。', [])).toBe('');
  });

  it('scopeEngineeringNames：招标范围兑底通道提取专业工程清单（合肥师范形态）', () => {
    const scope = '招标范围 -> "本招标项目招标范围为建设规模内的全部内容，具体内容详见图纸及清单。招标内容包括但不限于土方外运及基坑支护工程、地基与基础工程、人防工程、主体结构工程、装饰装修工程、幕墙工程、屋面工程、电气工程、给排水工程、消防工程、通风与空调、智能化、室外工程（景观、铺装、综合管网、智能化）等图纸及清单范围内所有工程。"';
    const names = scopeEngineeringNames(scope, []);
    expect(names[0]).toBe('土方外运及基坑支护工程');
    expect(names).toContain('主体结构工程');
    expect(names).toContain('通风与空调');
    expect(names).toContain('智能化');
    // 骨架上限 12 个：首尾噪声（图纸清单尾缀/括号注释）必须剥净
    expect(names).not.toContain('智能化）等图纸及清单范围内所有工程');
    expect(names.length).toBe(12);
  });

  it('scopeEngineeringNames：冒号直列形态与不足三项兑底返回空', () => {
    expect(scopeEngineeringNames('招标范围：土方外运及基坑支护工程、地基与基础工程、主体结构工程、装饰装修工程。', [])).toEqual(['土方外运及基坑支护工程', '地基与基础工程', '主体结构工程', '装饰装修工程']);
    expect(scopeEngineeringNames('招标范围：土方外运及基坑支护工程、地基与基础工程。', [])).toEqual([]);
  });

  it('scopeEngineeringNames：约束文本反例过滤（轮4 实测垃圾骨架名根因）', () => {
    // 招标范围窗口混入写作约束文本（工程量/系统约束/不得编造等）时不得提取为工作包名，
    // 否则块质检会要求模型输出「#### 1 工程量」类垃圾标题导致章失败
    const scope = '招标范围：土方外运及基坑支护工程、地基与基础工程、人防工程、主体结构工程。工程量清单详见招标文件。系统约束——仅指导写作，不得编造参数。';
    const names = scopeEngineeringNames(scope, []);
    expect(names).toEqual(['土方外运及基坑支护工程', '地基与基础工程', '人防工程', '主体结构工程']);
    expect(names.some(name => /工程量|约束|不得|参数|数字/u.test(name))).toBe(false);
  });

  it('majorConstructionSkeletonNames：图谱为空时兑底招标范围提取', () => {
    const scope = '招标范围：土方外运及基坑支护工程、地基与基础工程、人防工程、主体结构工程。';
    expect(majorConstructionSkeletonNames(scope, [])).toEqual(['土方外运及基坑支护工程', '地基与基础工程', '人防工程', '主体结构工程']);
  });
});

describe('stripMarkdownTableBlocks（表格确定性剥离）', () => {
  it('删除整张表格与前后空行，保留正文', () => {
    const content = '段落甲。\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n段落乙。';
    const stripped = stripMarkdownTableBlocks(content);
    expect(stripped).not.toContain('|');
    expect(stripped).toContain('段落甲。');
    expect(stripped).toContain('段落乙。');
  });

  it('表格内的 ### 标题行不属于表格，不应被误删', () => {
    const content = '| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n### 其他小节\n正文。';
    const stripped = stripMarkdownTableBlocks(content);
    expect(stripped).toContain('### 其他小节');
    expect(stripped).not.toContain('列A');
  });
});

describe('workPackageCrossSectionIssue（关键小节串位检测）', () => {
  it('重难点表/关键节点表/危险源表头命中', () => {
    expect(workPackageCrossSectionIssue('| 重难点 | 描述 |\n| --- | --- |')).toBe('重难点识别表串入本小节（应属于重点难点分析小节）');
    expect(workPackageCrossSectionIssue('| 关键节点 | 时间 |')).toBe('关键施工节点控制计划表串入本小节（应属于进度计划小节）');
    expect(workPackageCrossSectionIssue('| 危险源 | 措施 |')).toBe('危险源辨识清单表串入本小节（应属于安全管理小节）');
  });

  it('无串位返回空', () => {
    expect(workPackageCrossSectionIssue('#### 2.1.1 屋面维修工程\n施工概况：范围。')).toBe('');
  });
});

describe('stripTablesInSection（小节级表格剥离）', () => {
  it('只剥目标小节内的表格，其他小节合法表格不动', () => {
    const content = '### 2.1 项目主要施工内容\n#### 2.1.1 屋面维修工程\n施工概况：范围。\n\n| 重难点 | 描述 |\n| --- | --- |\n| 甲 | 乙 |\n\n### 2.2 进度计划\n\n| 节点 | 工期 |\n| --- | --- |\n| 开工 | 1天 |';
    const stripped = stripTablesInSection(content, '项目主要施工内容');
    expect(stripped).not.toContain('| 重难点 |');
    expect(stripped).toContain('| 节点 | 工期 |');
  });

  it('小节不存在时原样返回', () => {
    const content = '### 2.2 进度计划\n\n| 节点 | 工期 |\n| --- | --- |';
    expect(stripTablesInSection(content, '项目主要施工内容')).toBe(content);
  });

  it('H4 形态关键小节（模板实测）：骨架清单内工作包表格被剥，兄弟小节表格保留', () => {
    const content = '### 2.1 重点难点与危大工程保障\n#### 2.1.1 项目主要施工内容\n#### 2.1.2 土方外运及基坑支护工程\n施工概况：范围。\n\n| 重难点 | 描述 |\n| --- | --- |\n| 甲 | 乙 |\n\n#### 2.1.3 季节性施工保障\n\n| 节点 | 工期 |\n| --- | --- |\n| 开工 | 1天 |';
    const stripped = stripTablesInSection(content, '项目主要施工内容', ['土方外运及基坑支护工程']);
    expect(stripped).not.toContain('| 重难点 |');
    expect(stripped).toContain('| 节点 | 工期 |');
  });

  it('H4 形态关键小节：无骨架清单时保守截断（不误剥工作包/兄弟小节内表格）', () => {
    const content = '### 2.1 重点难点与危大工程保障\n#### 2.1.1 项目主要施工内容\n\n| 重难点 | 描述 |\n| --- | --- |\n| 甲 | 乙 |\n\n#### 2.1.2 土方外运及基坑支护工程\n\n| 资源 | 数量 |\n| --- | --- |\n| 挖机 | 2台 |';
    const stripped = stripTablesInSection(content, '项目主要施工内容');
    expect(stripped).not.toContain('| 重难点 |');
    expect(stripped).toContain('| 资源 | 数量 |');
  });
});

describe('missingWorkPackageSkeletonTitles（骨架齐全性复核）', () => {
  const skeleton = ['屋面维修工程', '室外道排工程', '室内装修改造工程'];

  it('骨架齐全返回空数组（含编号/微调标题的包含匹配）', () => {
    const content = '### 2.1 项目主要施工内容\n#### 2.1.1 屋面维修工程\n施工概况：范围。\n#### 2.1.2 室外道排工程\n施工概况：范围。\n#### 2.1.3 室内装修改造工程\n施工概况：范围。';
    expect(missingWorkPackageSkeletonTitles(content, '项目主要施工内容', skeleton)).toEqual([]);
  });

  it('缺失工作包返回缺失清单', () => {
    const content = '### 2.1 项目主要施工内容\n#### 2.1.1 屋面维修工程\n施工概况：范围。';
    expect(missingWorkPackageSkeletonTitles(content, '项目主要施工内容', skeleton)).toEqual(['室外道排工程', '室内装修改造工程']);
  });

  it('小节不存在时返回空数组不误报', () => {
    expect(missingWorkPackageSkeletonTitles('### 2.2 进度计划\n正文。', '项目主要施工内容', skeleton)).toEqual([]);
  });

  it('H4 形态关键小节（模板实测）：块延伸到下一个 H3，骨架齐全判定正常', () => {
    const content = '### 2.1 重点难点与危大工程保障\n#### 2.1.1 项目主要施工内容\n#### 2.1.2 屋面维修工程\n施工概况：范围。\n#### 2.1.3 室外道排工程\n施工概况：范围。\n#### 2.1.4 室内装修改造工程\n施工概况：范围。\n#### 2.1.5 季节性施工保障\n正文。';
    expect(missingWorkPackageSkeletonTitles(content, '项目主要施工内容', skeleton)).toEqual([]);
  });

  it('H4 形态关键小节：缺失工作包返回缺失清单', () => {
    const content = '### 2.1 重点难点与危大工程保障\n#### 2.1.1 项目主要施工内容\n#### 2.1.2 屋面维修工程\n施工概况：范围。\n#### 2.1.3 季节性施工保障\n正文。';
    expect(missingWorkPackageSkeletonTitles(content, '项目主要施工内容', skeleton)).toEqual(['室外道排工程', '室内装修改造工程']);
  });
});

describe('stripEmptyWorkPackageHeadings（空正文工作包确定性剥离）', () => {
  const skeleton = ['屋面维修工程', '室外道排工程', '室内装修改造工程'];

  it('骨架包正文不足 80 字：标题与残留正文整块剥离，有正文包保留（轮3 实测 4 空包漏补根因）', () => {
    const content = [
      '### 2.1 项目主要施工内容',
      '本小节按专业工程展开。',
      '#### 2.1.1 屋面维修工程',
      '施工概况：屋面翻修工程作业对象为主楼及裙房屋面部位，施工范围覆盖全部屋面分部。',
      '施工流程：先铲除旧防水层再找平基层，随后铺设保温层与找坡层，最后铺贴防水卷材并蓄水试验验收。',
      '施工方法：热熔法铺贴防水卷材，接缝搭接宽度满足规范要求，天沟与女儿墙泛水部位附加层加强处理。',
      '#### 2.1.2 室外道排工程',
      '#### 2.1.3 室内装修改造工程',
      '施工概况：室内装修工程作业对象为各楼层公共区域与办公区域，施工范围覆盖全部装修分部。',
      '施工流程：先拆除原有面层再基层处理，随后吊顶与隔墙施工，最后墙地面饰面与收尾保洁。',
      '施工方法：干作业为主，墙面采用装配式板材干挂，地面采用自流平基层与块材铺贴，成品保护到位。',
    ].join('\n');
    const result = stripEmptyWorkPackageHeadings(content, '项目主要施工内容', skeleton);
    expect(result).not.toContain('#### 2.1.2 室外道排工程');
    expect(result).toContain('#### 2.1.1 屋面维修工程');
    expect(result).toContain('#### 2.1.3 室内装修改造工程');
    expect(result).toContain('本小节按专业工程展开。');
  });

  it('非骨架清单内的短正文包不剥离（只清理骨架名匹配的空包）', () => {
    const content = [
      '### 2.1 项目主要施工内容',
      '#### 2.1.1 屋面维修工程',
      '施工概况：范围。',
      '#### 2.1.2 配套服务设施',
      '',
    ].join('\n');
    const result = stripEmptyWorkPackageHeadings(content, '项目主要施工内容', skeleton);
    expect(result).toContain('#### 2.1.2 配套服务设施');
  });

  it('小节不存在或全部有正文：原样返回', () => {
    const content = '### 2.2 进度计划\n正文。';
    expect(stripEmptyWorkPackageHeadings(content, '项目主要施工内容', skeleton)).toBe(content);
    const full = '### 2.1 项目主要施工内容\n#### 2.1.1 屋面维修工程\n施工概况：屋面翻修工程作业对象为主楼屋面部位，施工范围覆盖全部屋面分部工程。施工流程：先铲除旧防水层再找平，随后铺设保温与找坡层，最后铺贴卷材并蓄水验收。施工方法：热熔法铺贴，接缝搭接宽度满足规范，泛水部位附加层加强。';
    expect(stripEmptyWorkPackageHeadings(full, '项目主要施工内容', skeleton)).toBe(full);
  });
});

describe('majorConstructionSkeletonNames 清单条目聚合第三来源（F10）', () => {
  /** 表格证据（文件不存在于磁盘 → 走文本回退解析） */
  function billEvidence(): DocumentEvidence[] {
    return [{
      chapterId: 'ch-1',
      filePath: '不存在的清单.xlsx',
      score: 0.9,
      content: [
        '序号|项目编码|项目名称|项目特征描述|计量单位|工程量',
        '1|010101001001|挖一般土方|1.土壤类别:三类土|m3|120',
        '2|010101002001|回填方|1.密实度要求:≥95%|m3|80',
        '3|010502001001|混凝土基础|1.混凝土强度等级:C30|m3|50',
        '4|010101099001|合计|1.汇总本表|m3|250',
      ].join('\n'),
      processingType: 'bill_of_quantities',
    }];
  }

  function graphContext(): string {
    return [
      '1. 土方工程｜范围：场地平整与基坑开挖｜工程量/材料：按证据展开｜流程：开挖→回填｜验收：按规范和资料闭环',
      '2. 混凝土工程｜范围：主体结构浇筑｜工程量/材料：按证据展开｜流程：支模→浇筑→养护｜验收：按规范和资料闭环',
    ].join('\n');
  }

  function scopeContext(): string {
    return '招标范围包括但不限于：土方工程、基础工程、主体结构工程、装饰装修工程。';
  }

  it('图谱缺失 + 招标范围缺失 → 从清单条目聚合兑底（第三来源）', () => {
    const names = majorConstructionSkeletonNames('项目概况仅一段文字，无工作包图谱。', billEvidence());
    expect(names).toEqual(['挖一般土方', '回填方', '混凝土基础']);
  });

  it('计价类噪声条目（合计/暂列/规费）不进骨架候选', () => {
    const evidence = billEvidence();
    (evidence[0] as DocumentEvidence).content = [
      '序号|项目编码|项目名称|项目特征描述|计量单位|工程量',
      '1|010101001001|挖一般土方|1.土壤类别:三类土|m3|120',
      '2|010101099001|暂列金额|1.按项计列|项|1',
      '3|010101099002|规费|1.按规定计取|项|1',
      '4|010101099003|合计|1.汇总本表|m3|120',
    ].join('\n');
    const names = majorConstructionSkeletonNames('无图谱无招标范围。', evidence);
    expect(names).toEqual(['挖一般土方']);
  });

  it('工作包图谱存在但不足 3 个 → 并集兑底清单条目（P2/P4 三通道并集）', () => {
    const names = majorConstructionSkeletonNames(graphContext(), billEvidence());
    expect(names).toEqual(['土方工程', '混凝土工程', '挖一般土方', '回填方', '混凝土基础']);
  });

  it('招标范围提取 ≥3 个名称 → 优先招标范围（第三来源不触发）', () => {
    const names = majorConstructionSkeletonNames(scopeContext(), billEvidence());
    expect(names).toEqual(['土方工程', '基础工程', '主体结构工程', '装饰装修工程']);
  });

  it('招标范围不足 3 个 + 无图谱 → 兑底清单条目聚合', () => {
    const names = majorConstructionSkeletonNames('招标范围包括但不限于：土方工程。', billEvidence());
    expect(names).toEqual(['挖一般土方', '回填方', '混凝土基础']);
  });

  it('无任何来源（无图谱/无招标范围/无表格证据）→ 空清单', () => {
    expect(majorConstructionSkeletonNames('仅一段项目背景文字。', [])).toEqual([]);
  });

  it('表格证据文件存在但无表头列关键词 → 条目名提取空，返回空（不误造骨架）', () => {
    const evidence: DocumentEvidence[] = [{
      chapterId: 'ch-1',
      filePath: '不存在的进度表.xlsx',
      score: 0.9,
      content: ['日期|节点|负责人|状态', '2026-01-01|开工|张三|完成'].join('\n'),
      processingType: 'structured_data',
    }];
    expect(majorConstructionSkeletonNames('无图谱。', evidence)).toEqual([]);
  });
});

describe('majorConstructionSkeletonNames 三通道并集（P2/P4 分项覆盖闭环）', () => {
  /** 乡村/市政人居环境类清单证据：特征分项与通用分项混排 */
  function ruralBillEvidence(): DocumentEvidence[] {
    return [{
      chapterId: 'ch-1',
      filePath: '不存在的清单.xlsx',
      score: 0.9,
      content: [
        '序号|项目编码|项目名称|项目特征描述|计量单位|工程量',
        '1|040501001001|污水管网铺设|1.管材:HDPE双壁波纹管DN300|m|2170',
        '2|040501002001|排水沟砌筑|1.断面尺寸:500×500mm|m|860',
        '3|040501003001|沟塘清淤|1.清淤厚度:0.8m|m3|3200',
        '4|040501004001|公共厕所|1.结构形式:砖混|座|6',
        '5|010101001001|挖一般土方|1.土壤类别:三类土|m3|1200',
        '6|010502001001|C30混凝土垫层|1.混凝土强度等级:C30|m3|60',
      ].join('\n'),
      processingType: 'bill_of_quantities',
    }];
  }

  function graphThree(): string {
    return [
      '1. 道路工程｜范围：路基路面施工｜工程量/材料：按证据展开｜流程：路基→路面→养护｜验收：按规范和资料闭环',
      '2. 铺装工程｜范围：广场砖铺装｜工程量/材料：按证据展开｜流程：基层→铺装→勾缝｜验收：按规范和资料闭环',
      '3. 绿化工程｜范围：苗木栽植养护｜工程量/材料：按证据展开｜流程：整地→栽植→养护｜验收：按规范和资料闭环',
    ].join('\n');
  }

  it('图谱 ≥3 时仅补乡村/市政特征分项，通用清单行不拼入（P2 公厕/P4 污水管网补位）', () => {
    const names = majorConstructionSkeletonNames(graphThree(), ruralBillEvidence());
    expect(names).toEqual(['道路工程', '铺装工程', '绿化工程', '污水管网铺设', '排水沟砌筑', '沟塘清淤', '公共厕所']);
    expect(names).not.toContain('挖一般土方');
    expect(names).not.toContain('C30混凝土垫层');
  });

  it('图谱与招标范围并集兑底，去包含关系重复（P4 不再短路）', () => {
    const context = [
      '1. 土方工程｜范围：场地平整与基坑开挖｜工程量/材料：按证据展开｜流程：开挖→回填｜验收：按规范和资料闭环',
      '2. 混凝土工程｜范围：主体结构浇筑｜工程量/材料：按证据展开｜流程：支模→浇筑→养护｜验收：按规范和资料闭环',
      '招标范围包括但不限于：土方工程、基础工程、主体结构工程、装饰装修工程。',
    ].join('\n');
    const evidence: DocumentEvidence[] = [{
      chapterId: 'ch-1',
      filePath: '不存在的清单.xlsx',
      score: 0.9,
      content: [
        '序号|项目编码|项目名称|项目特征描述|计量单位|工程量',
        '1|010101001001|挖一般土方|1.土壤类别:三类土|m3|120',
        '2|010502001001|混凝土基础|1.混凝土强度等级:C30|m3|50',
      ].join('\n'),
      processingType: 'bill_of_quantities',
    }];
    const names = majorConstructionSkeletonNames(context, evidence);
    expect(names).toEqual(['土方工程', '混凝土工程', '基础工程', '主体结构工程', '装饰装修工程']);
    expect(names).not.toContain('挖一般土方');
    expect(names).not.toContain('混凝土基础');
  });

  it('兑底路径特征分项优先排序（图谱/范围均不足 3）', () => {
    const names = majorConstructionSkeletonNames('无图谱。', ruralBillEvidence());
    expect(names).toEqual(['污水管网铺设', '排水沟砌筑', '沟塘清淤', '公共厕所', '挖一般土方', 'C30混凝土垫层']);
  });

  it('图谱+招标范围合计 ≥12 时截断给特征分项留位（P2/P4 截断修复）', () => {
    const context = [
      '1. 土方工程｜范围：场地平整与基坑开挖｜工程量/材料：按证据展开｜流程：开挖→回填｜验收：按规范和资料闭环',
      '2. 混凝土工程｜范围：主体结构浇筑｜工程量/材料：按证据展开｜流程：支模→浇筑→养护｜验收：按规范和资料闭环',
      '3. 钢筋工程｜范围：钢筋制安｜工程量/材料：按证据展开｜流程：下料→绑扎｜验收：按规范和资料闭环',
      '4. 模板工程｜范围：模板支拆｜工程量/材料：按证据展开｜流程：支设→拆除｜验收：按规范和资料闭环',
      '5. 砌体工程｜范围：墙体砌筑｜工程量/材料：按证据展开｜流程：放线→砌筑｜验收：按规范和资料闭环',
      '6. 防水工程｜范围：屋面防水｜工程量/材料：按证据展开｜流程：基层→卷材｜验收：按规范和资料闭环',
      '7. 屋面工程｜范围：保温找坡｜工程量/材料：按证据展开｜流程：找坡→保温｜验收：按规范和资料闭环',
      '8. 钢结构工程｜范围：钢构件安装｜工程量/材料：按证据展开｜流程：吊装→焊接｜验收：按规范和资料闭环',
      '招标范围包括但不限于：基础工程、主体结构工程、装饰装修工程、电气工程、给排水工程、消防工程、通风工程、智能化工程。',
    ].join('\n');
    const names = majorConstructionSkeletonNames(context, ruralBillEvidence());
    // 图谱 8 + 招标范围前 4 = 12 即截断，后 4 个通用专业工程让位；乡村/市政特征分项 4 项全部保住
    expect(names).toEqual(['土方工程', '混凝土工程', '钢筋工程', '模板工程', '砌体工程', '防水工程', '屋面工程', '钢结构工程', '基础工程', '主体结构工程', '装饰装修工程', '电气工程', '污水管网铺设', '排水沟砌筑', '沟塘清淤', '公共厕所']);
    expect(names).not.toContain('给排水工程');
    expect(names).not.toContain('智能化工程');
  });

  it('「菜地整治」计入乡村/市政特征分项且兑底路径优先排序（丰乐镇第五版 P4 漏检修复）', () => {
    const evidence: DocumentEvidence[] = [{
      chapterId: 'ch-1',
      filePath: '不存在的清单.xlsx',
      score: 0.9,
      content: [
        '序号|项目编码|项目名称|项目特征描述|计量单位|工程量',
        '1|010101001001|挖一般土方|1.土壤类别:三类土|m3|1200',
        '2|040501005001|菜地整治|1.整治面积:1500m2|m2|1500',
      ].join('\n'),
      processingType: 'bill_of_quantities',
    }];
    const names = majorConstructionSkeletonNames('无图谱。', evidence);
    expect(names).toEqual(['菜地整治', '挖一般土方']);
  });
});
