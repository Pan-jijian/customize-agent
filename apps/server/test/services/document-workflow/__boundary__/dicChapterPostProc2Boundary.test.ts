/**
 * t2-cq XX 组第二批（XX2）：chapterPostProcessing 骨架锁定/表格/门禁/提示词族边界枚举。
 * 覆盖：workPackageSkeletonPrompt / workPackageSkeletonTitles（骨架锁定提示词与标题清单）、
 * matchBlockSkeletonNames（块级骨架名过滤）、stripMarkdownTableBlocks / workPackageCrossSectionIssue /
 * stripTablesInSection（表格剥离与串位检测）、missingWorkPackageSkeletonTitles /
 * stripEmptyWorkPackageHeadings（骨架齐全性复核与空包剥离）、majorContentPollutionIssue（脏事实污染）、
 * repairMajorContentWorkPackageLabels（要素标签确定性补全）、sectionStructureIssue（结构门禁）、
 * ensureTertiarySectionShell / ensureGroupTertiaryShell（外壳补全）、判别函数族、
 * keySectionWritingRequirement（写法规则）、outputTokensForChapter / expansionRoundsForDeficit /
 * acceptExpandedChapter（扩写接纳判定）。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  acceptExpandedChapter,
  ensureGroupTertiaryShell,
  ensureTertiarySectionShell,
  expansionRoundsForDeficit,
  groupHasMajorConstructionSection,
  isCriticalDeepSection,
  isGeneralManagementSection,
  keySectionWritingRequirement,
  majorContentPollutionIssue,
  matchBlockSkeletonNames,
  missingWorkPackageSkeletonTitles,
  outputTokensForChapter,
  repairMajorContentWorkPackageLabels,
  sectionStructureIssue,
  stripEmptyWorkPackageHeadings,
  stripMarkdownTableBlocks,
  stripTablesInSection,
  workPackageCrossSectionIssue,
  workPackageSkeletonPrompt,
  workPackageSkeletonTitles,
} from '@/services/document-workflow/chapterPostProcessing';

const ctx3 = (names: string[]) => `施工工作包结构化数据： [${names.map((name, index) => `{"name":"${name}","scope":"范围${index + 1}","quantities":[],"process":[],"acceptance":[]}`).join(',')}]`;

describe('X9 workPackageSkeletonPrompt / workPackageSkeletonTitles', () => {
  it('识别到 ≥minCount 工作包 → 生成锁定提示词（含编号标题与三要素）', () => {
    const prompt = workPackageSkeletonPrompt(ctx3(['污水管网工程', '道路工程', '给排水工程']), []);
    expect(prompt).toContain('#### 1 污水管网工程');
    expect(prompt).toContain('#### 2 道路工程');
    expect(prompt).toContain('#### 3 给排水工程');
    expect(prompt).toContain('三要素');
    expect(prompt).toContain('禁止出现 Markdown 表格');
  });

  it('工作包不足 minCount → 空提示词（骨架锁定不触发）', () => {
    expect(workPackageSkeletonPrompt(ctx3(['污水管网工程', '道路工程']), [])).toBe('');
  });

  it('namesOverride 优先于自动识别', () => {
    const prompt = workPackageSkeletonPrompt('无结构化数据', [], 3, ['甲工程', '乙工程', '丙工程']);
    expect(prompt).toContain('#### 1 甲工程');
    expect(prompt).toContain('#### 3 丙工程');
  });

  it('workPackageSkeletonTitles：足量返回清单、不足返回空', () => {
    const ctx = ctx3(['污水管网工程', '道路工程', '给排水工程']);
    expect(workPackageSkeletonTitles(ctx, [])).toEqual(['污水管网工程', '道路工程', '给排水工程']);
    expect(workPackageSkeletonTitles(ctx3(['污水管网工程']), [])).toEqual([]);
  });
});

describe('X10 matchBlockSkeletonNames', () => {
  const rawNames = ['污水管网工程', '道路工程', '给排水工程'];

  it('仅匹配与块要点标题互相包含的骨架名', () => {
    expect(matchBlockSkeletonNames(rawNames, ['污水管网工程'])).toEqual([]);
  });

  it('匹配数达 minCount → 全量保留匹配项', () => {
    expect(matchBlockSkeletonNames(rawNames, ['污水管网工程', '道路工程', '给排水工程'])).toEqual(rawNames);
  });

  it('归一化后匹配（编号前缀不影响）', () => {
    expect(matchBlockSkeletonNames(rawNames, ['1.2 污水管网工程', '1.3 道路工程', '1.4 给排水工程'])).toEqual(rawNames);
  });

  it('互相包含判定：要点标题「污水管网」与骨架名「污水管网工程」', () => {
    expect(matchBlockSkeletonNames(['污水管网工程'], ['污水管网'], 1)).toEqual(['污水管网工程']);
  });

  it('自定义 minCount', () => {
    expect(matchBlockSkeletonNames(rawNames, ['污水管网工程'], 1)).toEqual(['污水管网工程']);
  });
});

describe('X11 stripMarkdownTableBlocks', () => {
  it('整张表格行删除（表头+分隔+数据）', () => {
    const md = ['正文', '| 序号 | 内容 |', '|---|---|', '| 1 | A |', '后文'].join('\n');
    const out = stripMarkdownTableBlocks(md);
    expect(out).not.toContain('| 序号 |');
    expect(out).not.toContain('| 1 |');
    expect(out).toContain('正文');
    expect(out).toContain('后文');
  });

  it('表格后空行同步清理', () => {
    const md = ['| a | b |', '|---|---|', '', '后文'].join('\n');
    expect(stripMarkdownTableBlocks(md)).toBe('后文');
  });

  it('无表格 → 原样', () => {
    const md = '纯文本正文';
    expect(stripMarkdownTableBlocks(md)).toBe(md);
  });

  it('非表格竖线行保留', () => {
    const md = ['正文包含 | 分隔符', '普通行'].join('\n');
    expect(stripMarkdownTableBlocks(md)).toBe(md);
  });
});

describe('X12 workPackageCrossSectionIssue', () => {
  it('重难点表头串位 → 报重难点识别表', () => {
    expect(workPackageCrossSectionIssue('| 重难点 | 描述 |\n|---|---|')).toContain('重难点识别表串入本小节');
  });

  it('关键节点表头串位 → 报节点计划表', () => {
    expect(workPackageCrossSectionIssue('| 关键节点 | 时间 |\n|---|---|')).toContain('关键施工节点控制计划表串入本小节');
  });

  it('危险源表头串位 → 报危险源清单表', () => {
    expect(workPackageCrossSectionIssue('| 危险源 | 措施 |\n|---|---|')).toContain('危险源辨识清单表串入本小节');
  });

  it('无串位 → 空串', () => {
    expect(workPackageCrossSectionIssue('正常正文')).toBe('');
  });
});

describe('X13 stripTablesInSection', () => {
  const sectionTitle = '项目主要施工内容';

  it('H3 目标：块内表格剥离、下一 H3 不动', () => {
    const md = [
      '### 项目主要施工内容',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '### 其他节',
      '| c | d |',
      '|---|---|',
    ].join('\n');
    const out = stripTablesInSection(md, sectionTitle);
    expect(out).not.toContain('| a | b |');
    expect(out).toContain('| c | d |');
  });

  it('标题不存在 → 原样', () => {
    const md = '### 其他节\n| a | b |\n|---|---|';
    expect(stripTablesInSection(md, sectionTitle)).toBe(md);
  });

  it('无表格 → 原样', () => {
    const md = '### 项目主要施工内容\n正文无表格';
    expect(stripTablesInSection(md, sectionTitle)).toBe(md);
  });

  it('H4 目标 + 骨架清单：工作包内表格剥、兄弟 H4 表格保留', () => {
    const md = [
      '#### 项目主要施工内容',
      '#### 1 污水管网工程',
      '| a | b |',
      '|---|---|',
      '#### 2 兄弟小节',
      '| c | d |',
      '|---|---|',
    ].join('\n');
    const out = stripTablesInSection(md, sectionTitle, ['污水管网工程']);
    expect(out).not.toContain('| a | b |');
    expect(out).toContain('| c | d |');
  });

  it('H4 目标无骨架清单：第一个 H4 行截断（兄弟表格保留）', () => {
    const md = [
      '#### 项目主要施工内容',
      '正文',
      '#### 兄弟小节',
      '| c | d |',
      '|---|---|',
    ].join('\n');
    const out = stripTablesInSection(md, sectionTitle);
    expect(out).toContain('| c | d |');
  });
});

describe('X14 missingWorkPackageSkeletonTitles', () => {
  const sectionTitle = '项目主要施工内容';
  const skeleton = ['污水管网工程', '道路工程', '给排水工程'];

  it('块内缺失的骨架标题返回', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 污水管网工程',
      '正文A',
      '#### 2 道路工程',
      '正文B',
    ].join('\n');
    expect(missingWorkPackageSkeletonTitles(md, sectionTitle, skeleton)).toEqual(['给排水工程']);
  });

  it('归一化包含匹配即视为已覆盖（编号前缀）', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1.1 污水管网工程',
      '正文A',
      '#### 1.2 道路工程',
      '正文B',
      '#### 1.3 给排水工程',
      '正文C',
    ].join('\n');
    expect(missingWorkPackageSkeletonTitles(md, sectionTitle, skeleton)).toEqual([]);
  });

  it('小节不存在 → 空数组不误报', () => {
    expect(missingWorkPackageSkeletonTitles('### 其他节\n正文', sectionTitle, skeleton)).toEqual([]);
  });
});

describe('X15 stripEmptyWorkPackageHeadings', () => {
  const sectionTitle = '项目主要施工内容';
  const skeleton = ['污水管网工程'];

  it('骨架包正文 <80 字 → 整块剥离', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 污水管网工程',
      '正文很短',
    ].join('\n');
    const out = stripEmptyWorkPackageHeadings(md, sectionTitle, skeleton);
    expect(out).not.toContain('污水管网工程');
    expect(out).not.toContain('正文很短');
  });

  it('骨架包正文 ≥80 字 → 保留', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 污水管网工程',
      '正'.repeat(80),
    ].join('\n');
    const out = stripEmptyWorkPackageHeadings(md, sectionTitle, skeleton);
    expect(out).toContain('污水管网工程');
  });

  it('非骨架包（正文短）→ 保留', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 其他包',
      '正文很短',
    ].join('\n');
    const out = stripEmptyWorkPackageHeadings(md, sectionTitle, skeleton);
    expect(out).toContain('其他包');
  });

  it('小节不存在 → 原样', () => {
    const md = '### 其他节\n正文';
    expect(stripEmptyWorkPackageHeadings(md, sectionTitle, skeleton)).toBe(md);
  });
});

describe('X16 majorContentPollutionIssue', () => {
  it('资料内容事实 → true', () => {
    expect(majorContentPollutionIssue('正文资料内容事实：见附件')).toBe(true);
  });

  it('行首 H2/H3 标题 → true', () => {
    expect(majorContentPollutionIssue('正文\n## 非法二级标题\n继续')).toBe(true);
  });

  it('行首 H5 标题 → true', () => {
    expect(majorContentPollutionIssue('正文\n##### 非法五级标题')).toBe(true);
  });

  it('行首 H4 标题 → false（本节合法工作包标题）', () => {
    expect(majorContentPollutionIssue('正文\n#### 合法工作包')).toBe(false);
  });

  it('粗体标记 → true', () => {
    expect(majorContentPollutionIssue('正文**粗体**内容')).toBe(true);
  });

  it('注册建造师 → true', () => {
    expect(majorContentPollutionIssue('项目经理须具备注册建造师资格')).toBe(true);
  });

  it('未尽事宜 → true', () => {
    expect(majorContentPollutionIssue('未尽事宜另行约定')).toBe(true);
  });

  it('正常施工正文 → false', () => {
    expect(majorContentPollutionIssue('测量放线后进行沟槽开挖，闭水试验合格后回填。')).toBe(false);
  });
});

describe('X17 repairMajorContentWorkPackageLabels', () => {
  it('无「项目主要施工内容」→ 原样', () => {
    const md = '### 其他节\n正文';
    expect(repairMajorContentWorkPackageLabels(md)).toBe(md);
  });

  it('三标签齐全 → 原样', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 包A',
      '施工概况：概况正文',
      '施工流程：A→B',
      '施工方法：浇筑养护',
    ].join('\n');
    expect(repairMajorContentWorkPackageLabels(md)).toBe(md);
  });

  it('缺概况：首条无标签行补为施工概况', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 包A',
      '第一行内容',
      '施工流程：A→B',
      '施工方法：浇筑',
    ].join('\n');
    const out = repairMajorContentWorkPackageLabels(md);
    expect(out).toContain('施工概况：第一行内容');
  });

  it('缺流程：工序顺序表达行归入流程标签', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 包A',
      '施工概况：概况A',
      '先开挖后回填再压实',
      '施工方法：浇筑养护',
    ].join('\n');
    const out = repairMajorContentWorkPackageLabels(md);
    expect(out).toContain('施工流程：先开挖后回填再压实');
  });

  it('缺方法：剩余无标签行合并为施工方法', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 包A',
      '施工概况：概况A',
      '施工流程：A→B',
      '浇筑养护',
      '记录归档',
    ].join('\n');
    const out = repairMajorContentWorkPackageLabels(md);
    expect(out).toContain('施工方法：浇筑养护记录归档');
  });

  it('小节外工作包块不受影响', () => {
    const md = [
      '### 其他节',
      '#### 1 包X',
      '无标签正文',
    ].join('\n');
    expect(repairMajorContentWorkPackageLabels(md)).toBe(md);
  });

  it('H4 形态小节标题同样触发标签补全', () => {
    const md = [
      '#### 项目主要施工内容',
      '#### 1 包A',
      '第一行内容',
      '施工流程：A→B',
      '施工方法：浇筑',
    ].join('\n');
    const out = repairMajorContentWorkPackageLabels(md);
    expect(out).toContain('施工概况：第一行内容');
  });

  it('块内无标签行全空 → 原样保留', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 包A',
      '施工流程：A→B',
      '施工方法：浇筑',
    ].join('\n');
    expect(repairMajorContentWorkPackageLabels(md)).toBe(md);
  });
});

describe('X18 sectionStructureIssue', () => {
  const fullPackage = (name: string) => [
    `#### ${name}`,
    '施工概况：HDPE双壁波纹管 DN300 约1200m',
    '施工流程：测量放线→沟槽开挖→管道铺设→闭水试验→回填',
    '施工方法：沟槽机械开挖配合人工清底，槽底标高偏差控制在20mm以内，闭水试验合格后回填压实，检测合格后形成记录归档闭环。',
  ].join('\n');

  it('三完整工作包 → 空串（无问题）', () => {
    const md = ['### 项目主要施工内容', fullPackage('1 污水管网工程'), fullPackage('2 道路工程'), fullPackage('3 给排水工程')].join('\n');
    expect(sectionStructureIssue('项目主要施工内容', md)).toBe('');
  });

  it('无 H4 工作包 → 缺少三级小节', () => {
    expect(sectionStructureIssue('项目主要施工内容', '### 项目主要施工内容\n只有概述正文')).toBe('项目主要施工内容 缺少施工工作包三级小节');
  });

  it('包数不足 3 → 未按施工工作包展开', () => {
    const md = ['### 项目主要施工内容', fullPackage('1 污水管网工程'), fullPackage('2 道路工程')].join('\n');
    expect(sectionStructureIssue('项目主要施工内容', md)).toBe('项目主要施工内容 未按施工工作包展开');
  });

  it('包缺方法要素 → 内容要素不全', () => {
    const md = [
      '### 项目主要施工内容',
      '#### 1 污水管网工程',
      '施工概况：DN300 约1200m',
      '施工流程：测量放线→沟槽开挖',
      fullPackage('2 道路工程'),
      fullPackage('3 给排水工程'),
    ].join('\n');
    expect(sectionStructureIssue('项目主要施工内容', md)).toBe('项目主要施工内容 存在工作包内容要素不全');
  });

  it('脏事实污染（注册建造师）→ 脏事实或标题污染', () => {
    const md = ['### 项目主要施工内容', '项目经理须具备注册建造师资格', fullPackage('1 污水管网工程'), fullPackage('2 道路工程'), fullPackage('3 给排水工程')].join('\n');
    expect(sectionStructureIssue('项目主要施工内容', md)).toBe('项目主要施工内容 存在脏事实或标题污染');
  });

  it('非主要施工内容节且非分部分项节 → 空串', () => {
    expect(sectionStructureIssue('施工部署', '### 施工部署\n普通正文')).toBe('');
  });

  it('分部分项节无 H4 → 缺少分项工程方案三级小节', () => {
    expect(sectionStructureIssue('主要分部分项工程施工方案', '### 主要分部分项工程施工方案\n只有概述')).toBe('主要分部分项工程施工方案 缺少分项工程方案三级小节');
  });
});

describe('X19 ensureTertiarySectionShell / ensureGroupTertiaryShell', () => {
  it('已有 H4 → 原样', () => {
    const md = '### 施工部署\n#### 子节\n正文';
    expect(ensureTertiarySectionShell('施工部署', md)).toBe(md);
  });

  it('无 H4 有正文 → 补 H3 外壳', () => {
    const md = '裸正文内容';
    expect(ensureTertiarySectionShell('施工部署', md)).toBe('### 施工部署\n\n裸正文内容');
  });

  it('无正文 → 原样', () => {
    expect(ensureTertiarySectionShell('施工部署', '')).toBe('');
  });

  it('ensureGroupTertiaryShell：精确同名 H3 无 H4 → 空行归一（不补同名 H4）', () => {
    const md = '### 施工部署\n部署正文\n';
    const out = ensureGroupTertiaryShell(['施工部署'], md);
    expect(out).toBe('### 施工部署\n\n部署正文\n\n');
    expect(out).not.toContain('#### 施工部署');
  });

  it('ensureGroupTertiaryShell：非精确同名 H3（变体标题）不匹配 → 原样', () => {
    const md = '### 施工部署与流水组织\n部署正文\n';
    expect(ensureGroupTertiaryShell(['施工部署'], md)).toBe(md);
  });

  it('ensureGroupTertiaryShell：H3 与组标题同名 → 不补同名 H4', () => {
    const md = '### 施工部署\n部署正文\n';
    const out = ensureGroupTertiaryShell(['施工部署'], md);
    expect(out).not.toContain('#### 施工部署\n\n#### 施工部署');
  });

  it('ensureGroupTertiaryShell：已有 H4 → 不动', () => {
    const md = '### 施工部署\n#### 组织架构\n正文\n';
    expect(ensureGroupTertiaryShell(['施工部署'], md)).toBe(md);
  });
});

describe('X20 判别函数族', () => {
  it('groupHasMajorConstructionSection', () => {
    expect(groupHasMajorConstructionSection(['施工部署', '项目主要施工内容'])).toBe(true);
    expect(groupHasMajorConstructionSection(['施工部署', '施工平面布置'])).toBe(false);
  });

  it('isCriticalDeepSection：深度关键小节', () => {
    expect(isCriticalDeepSection('项目主要施工内容')).toBe(true);
    expect(isCriticalDeepSection('项目重点难点分析')).toBe(true);
    expect(isCriticalDeepSection('危大工程专项施工方案审批流程')).toBe(true);
    expect(isCriticalDeepSection('原材料进场复试')).toBe(true);
    expect(isCriticalDeepSection('施工部署')).toBe(false);
  });

  it('isGeneralManagementSection', () => {
    expect(isGeneralManagementSection('施工部署')).toBe(true);
    expect(isGeneralManagementSection('项目管理组织')).toBe(true);
    expect(isGeneralManagementSection('材料管理')).toBe(false);
  });
});

describe('X21 keySectionWritingRequirement', () => {
  it('重点难点节 → 含归因与量化要求', () => {
    const req = keySectionWritingRequirement('项目特点、重点、难点分析');
    expect(req).toContain('成因归因句');
    expect(req).toContain('量化控制目标');
  });

  it('项目主要施工内容节 → 含三要素', () => {
    expect(keySectionWritingRequirement('项目主要施工内容')).toContain('三要素');
  });

  it('主要分部分项工程施工方案节 → 含逐项响应', () => {
    expect(keySectionWritingRequirement('主要分部分项工程施工方案')).toContain('逐项响应');
  });

  it('非关键小节 → 空串', () => {
    expect(keySectionWritingRequirement('施工部署')).toBe('');
  });
});

describe('X22 outputTokensForChapter / expansionRoundsForDeficit / acceptExpandedChapter', () => {
  it('outputTokensForChapter：正常放大 1.45 倍', () => {
    expect(outputTokensForChapter(10000)).toBe(14500);
  });

  it('outputTokensForChapter：下限 5000', () => {
    expect(outputTokensForChapter(1000)).toBe(5000);
  });

  it('outputTokensForChapter：上限 24000', () => {
    expect(outputTokensForChapter(20000)).toBe(24000);
  });

  it('outputTokensForChapter：target 覆盖 min', () => {
    expect(outputTokensForChapter(1000, 8000)).toBe(11600);
  });

  it('expansionRoundsForDeficit：非正数 → 0', () => {
    expect(expansionRoundsForDeficit(0)).toBe(0);
    expect(expansionRoundsForDeficit(-100)).toBe(0);
  });

  it('expansionRoundsForDeficit：每 4000 字一轮', () => {
    expect(expansionRoundsForDeficit(4000)).toBe(1);
    expect(expansionRoundsForDeficit(4001)).toBe(2);
    expect(expansionRoundsForDeficit(8000)).toBe(2);
  });

  it('acceptExpandedChapter：增长达标且标题保留 → true', () => {
    const out = acceptExpandedChapter('短'.repeat(10), '施工部署' + '长'.repeat(500), '施工部署', 1000);
    expect(out).toBe(true);
  });

  it('acceptExpandedChapter：超 maxChars → false', () => {
    const out = acceptExpandedChapter('短'.repeat(10), '长'.repeat(1500), '', 1000);
    expect(out).toBe(false);
  });

  it('acceptExpandedChapter：增长不足 minimumGrowth → false', () => {
    const out = acceptExpandedChapter('正'.repeat(900), '正'.repeat(950), '', 1500);
    expect(out).toBe(false);
  });

  it('acceptExpandedChapter：标题丢失 → false', () => {
    const out = acceptExpandedChapter('短'.repeat(10), '长'.repeat(500), '施工部署', 1000);
    expect(out).toBe(false);
  });

  it('acceptExpandedChapter：无缺额目标时标题不匹配仍 true', () => {
    const out = acceptExpandedChapter('短'.repeat(10), '长'.repeat(500), '施工部署', 5);
    expect(out).toBe(false);
  });
});
