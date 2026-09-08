/**
 * utils 单测：工序顺序表达检测/小节去重/小节提取/标题可比匹配/基础工具函数/自适应并发与信号量。
 */
import { describe, expect, it } from 'vitest';
import {
  BID_DISCIPLINE_PHRASES,
  Semaphore,
  adaptiveConcurrency,
  asObjectArray,
  asStringArray,
  comparableSectionHeadingMatches,
  comparableSectionTitleText,
  dedupeCrossSectionSkeletonH4s,
  dedupeRepeatedSubsections,
  extractSection,
  findDuplicateH4Titles,
  findExtraneousBlockTitles,
  hasProcessSequenceExpression,
  isBidDisciplineSentence,
  normalizeSubsectionTitleForDedup,
  removeExtraneousBlockSections,
  runWithAdaptiveConcurrency,
  safePlanId,
  stableHash,
  stringifyFactValue,
  stripExtraneousBlockHeadings,
  throwIfAborted,
} from '@/services/document-workflow/utils';

describe('hasProcessSequenceExpression', () => {
  it('箭头链（→/->/=>）', () => {
    expect(hasProcessSequenceExpression('基层清理→放线定位→分层摊铺')).toBe(true);
    expect(hasProcessSequenceExpression('开挖->支护->浇筑')).toBe(true);
    expect(hasProcessSequenceExpression('开挖=>支护')).toBe(true);
  });

  it('顺序词引导', () => {
    expect(hasProcessSequenceExpression('按施工程序顺序进行')).toBe(true);
    expect(hasProcessSequenceExpression('先开挖，后浇筑，最后回填')).toBe(true);
    expect(hasProcessSequenceExpression('各工序依次流水施工')).toBe(true);
  });

  it('编号步骤序列（至少 2 步）', () => {
    expect(hasProcessSequenceExpression('1. 开挖\n2. 浇筑')).toBe(true);
    expect(hasProcessSequenceExpression('（1）测量放线\n（2）基坑开挖')).toBe(true);
    expect(hasProcessSequenceExpression('1. 开挖')).toBe(false);
  });

  it('列表序列（至少 2 行）', () => {
    expect(hasProcessSequenceExpression('- 开挖\n- 浇筑')).toBe(true);
    expect(hasProcessSequenceExpression('• 测量\n• 放线')).toBe(true);
    expect(hasProcessSequenceExpression('- 开挖')).toBe(false);
  });

  it('连接线链（至少 3 个环节）', () => {
    expect(hasProcessSequenceExpression('基层清理-放线定位-分层摊铺')).toBe(true);
    expect(hasProcessSequenceExpression('基层清理—放线定位—分层摊铺')).toBe(true);
    expect(hasProcessSequenceExpression('基层清理-放线定位')).toBe(false);
  });

  it('无工序表达 / 空文本', () => {
    expect(hasProcessSequenceExpression('本工程位于市区，交通便利')).toBe(false);
    expect(hasProcessSequenceExpression('')).toBe(false);
  });
});

describe('normalizeSubsectionTitleForDedup', () => {
  it('剥离编号前缀与括号标注与分隔符', () => {
    expect(normalizeSubsectionTitleForDedup('1.3.2 室外雨污分流改造')).toBe('室外雨污分流改造');
    expect(normalizeSubsectionTitleForDedup('室外雨污分流改造（一期）')).toBe('室外雨污分流改造');
    expect(normalizeSubsectionTitleForDedup('室外 雨污：分流 改造')).toBe('室外雨污分流改造');
  });

  it('剥离「工程」尾缀（稳定版：与验收器 duplicateTitles 口径同源，防标题变体误杀）', () => {
    expect(normalizeSubsectionTitleForDedup('主体结构工程')).toBe('主体结构');
    expect(normalizeSubsectionTitleForDedup('1. 主体结构工程')).toBe('主体结构');
    expect(normalizeSubsectionTitleForDedup('土方外运及基坑支护工程')).toBe('土方外运及基坑支护');
  });
});

describe('findDuplicateH4Titles', () => {
  it('同 H3 内归一化重复标题被检出（返回原样标题文本）', () => {
    const markdown = ['### 施工准备', '#### 1.1 场地平整', '正文一', '#### 1.2 场地平整', '正文二'].join('\n');
    expect(findDuplicateH4Titles(markdown)).toEqual(['1.2 场地平整']);
  });

  it('跨 H3 的同名 H4 不判重复', () => {
    const markdown = [
      '### 施工准备',
      '#### 场地平整',
      '### 主体结构',
      '#### 场地平整',
    ].join('\n');
    expect(findDuplicateH4Titles(markdown)).toEqual([]);
  });

  it('H2 重置 H3 作用域', () => {
    const markdown = ['### 施工准备', '#### 场地平整', '## 下一章', '#### 场地平整'].join('\n');
    expect(findDuplicateH4Titles(markdown)).toEqual([]);
  });
});

describe('dedupeRepeatedSubsections', () => {
  it('同 H3 内重复小节删除标题与整块正文，跨 H3 保留', () => {
    const content = [
      '### 施工准备',
      '#### 场地平整',
      '正文一',
      '#### 场地平整',
      '正文二',
      '### 主体结构',
      '#### 场地平整',
      '正文三',
    ].join('\n');
    const result = dedupeRepeatedSubsections(content);
    expect(result).toContain('正文一');
    expect(result).not.toContain('正文二');
    expect(result).toContain('正文三');
    // 同 H3 内标题只保留一次
    const occurrences = result.split('\n').filter(line => line.includes('#### 场地平整')).length;
    expect(occurrences).toBe(2);
  });

  it('无重复时原样保留', () => {
    const content = '### 施工准备\n#### 场地平整\n正文';
    expect(dedupeRepeatedSubsections(content)).toBe(content);
  });
});

describe('findExtraneousBlockTitles（块成稿清单外标题检测）', () => {
  it('串章骨架 H4 与自由发挥 H4 均判清单外，本块要点与块标题合法', () => {
    const markdown = [
      '### 周边环境与管线保护管控',
      '#### 周边环境、管线与既有建构筑物保护',
      '正文一',
      '#### 施工部署与施工流水组织',
      '串章正文',
      '#### 安全防护设施与高处作业管控',
      '自由发挥正文',
    ].join('\n');
    const extra = findExtraneousBlockTitles(markdown, '周边环境与管线保护管控', ['周边环境、管线与既有建构筑物保护'], ['施工部署与施工流水组织', '文明施工与扬尘噪声管控']);
    expect(extra).toEqual(['施工部署与施工流水组织', '安全防护设施与高处作业管控']);
  });

  it('串章 H3（非块标题）判清单外', () => {
    const markdown = ['### 文明施工与绿色施工管控', '正文', '### 周边环境与管线保护管控', '正文二'].join('\n');
    const extra = findExtraneousBlockTitles(markdown, '周边环境与管线保护管控', [], []);
    expect(extra).toEqual(['文明施工与绿色施工管控']);
  });

  it('本块要点全部输出时清单外为空', () => {
    const markdown = ['### 围挡冲洗与渣土运输管控', '#### 围挡冲洗台与渣土管控', '正文'].join('\n');
    expect(findExtraneousBlockTitles(markdown, '围挡冲洗与渣土运输管控', ['围挡冲洗台与渣土管控'], ['安全文明生产管理体系与措施'])).toEqual([]);
  });

  it('评分细目原标题 H4（sources 白名单）不算清单外——第七次回归：单要点块写细目标题属内容归位', () => {
    const markdown = ['### 项目理解与编制边界', '#### 编制说明与工程概况', '细目正文'].join('\n');
    // 要点标题=块标题（H3 直接承担），模型按证据写出细目原标题「编制说明与工程概况」→ 白名单命中，不判清单外
    expect(findExtraneousBlockTitles(markdown, '项目理解与编制边界', ['项目理解与编制边界'], ['工程特点与施工条件分析'], ['编制说明与工程概况'])).toEqual([]);
    // 未命中白名单时仍判清单外（自由发挥不放宽）
    expect(findExtraneousBlockTitles(markdown, '项目理解与编制边界', ['项目理解与编制边界'], ['工程特点与施工条件分析'], ['其他细目'])).toEqual(['编制说明与工程概况']);
    // 命中本章其他块标题时仍拦截（串章防线不因白名单放宽）
    expect(findExtraneousBlockTitles('### 项目理解与编制边界\n#### 工程特点与施工条件分析\n串章', '项目理解与编制边界', ['项目理解与编制边界'], ['工程特点与施工条件分析'], ['工程特点与施工条件分析'])).toEqual(['工程特点与施工条件分析']);
  });

  it('H3 块标题“工程”变体不算清单外（稳定版：轮4 实测“主要分部分项施工方案”块输出变体标题被误杀）', () => {
    const markdown = ['### 主要分部分项工程施工方案', '#### 模板工程施工方法', '正文'].join('\n');
    expect(findExtraneousBlockTitles(markdown, '主要分部分项施工方案', ['模板工程施工方法'], [])).toEqual([]);
    // 尾缀变体同样容忍（归一化尾缀剥离 + 同源宽松比较双保险）
    const markdown2 = ['### 施工部署工程', '正文'].join('\n');
    expect(findExtraneousBlockTitles(markdown2, '施工部署', [], [])).toEqual([]);
    // 真串章 H3 仍拦截（宽松比较不放宽串章防线）
    expect(findExtraneousBlockTitles(markdown, '施工部署', ['模板工程施工方法'], [])).toEqual(['主要分部分项工程施工方案']);
  });
});

describe('removeExtraneousBlockSections（块成稿清单外标题块删除）', () => {
  it('串章 H4 块连同正文删除，本块要点与块标题保留', () => {
    const markdown = [
      '### 周边环境与管线保护管控',
      '#### 周边环境、管线与既有建构筑物保护',
      '正文一',
      '#### 施工部署与施工流水组织',
      '串章正文',
      '| 表头 | 列 |',
      '| --- | --- |',
      '| 行 | 1 |',
    ].join('\n');
    const result = removeExtraneousBlockSections(markdown, '周边环境与管线保护管控', ['周边环境、管线与既有建构筑物保护']);
    expect(result).toContain('正文一');
    expect(result).not.toContain('串章正文');
    expect(result).not.toContain('表头');
    expect(result).not.toContain('施工部署与施工流水组织');
  });

  it('串章 H3 整块删除', () => {
    const markdown = ['### 文明施工与绿色施工管控', '串章正文', '### 周边环境与管线保护管控', '正文二'].join('\n');
    const result = removeExtraneousBlockSections(markdown, '周边环境与管线保护管控', []);
    expect(result).not.toContain('串章正文');
    expect(result).toContain('正文二');
  });

  it('评分细目原标题 H4 块（sources 白名单）保留，其余清单外仍删除', () => {
    const markdown = [
      '### 项目理解与编制边界',
      '#### 编制说明与工程概况',
      '细目正文',
      '#### 自由发挥小节',
      '自由发挥正文',
    ].join('\n');
    const result = removeExtraneousBlockSections(markdown, '项目理解与编制边界', ['项目理解与编制边界'], ['编制说明与工程概况']);
    expect(result).toContain('细目正文');
    expect(result).toContain('编制说明与工程概况');
    expect(result).not.toContain('自由发挥正文');
    expect(result).not.toContain('自由发挥小节');
  });
});

describe('stripExtraneousBlockHeadings（标题层确定性修复：删标题留正文，正文零丢失）', () => {
  it('清单外 H4 删标题行、正文保留；白名单细目标题与块标题 H3 保留', () => {
    const markdown = [
      '### 项目理解与编制边界',
      '#### 编制说明与工程概况',
      '细目正文',
      '#### 自由发挥小节',
      '自由发挥正文',
    ].join('\n');
    const result = stripExtraneousBlockHeadings(markdown, '项目理解与编制边界', ['项目理解与编制边界'], ['编制说明与工程概况']);
    expect(result).toContain('细目正文');
    expect(result).toContain('自由发挥正文');
    expect(result).not.toContain('#### 自由发挥小节');
    expect(result).toContain('#### 编制说明与工程概况');
    expect(result).toContain('### 项目理解与编制边界');
  });

  it('清单外 H3（写错块标题）删标题行、正文并入并补回块标题外壳', () => {
    const markdown = ['### 编制说明与工程概况', '正文一', '正文二'].join('\n');
    const result = stripExtraneousBlockHeadings(markdown, '项目理解与编制边界', ['项目理解与编制边界'], []);
    expect(result).toContain('### 项目理解与编制边界');
    expect(result).not.toContain('### 编制说明与工程概况');
    expect(result).toContain('正文一');
    expect(result).toContain('正文二');
  });
});

describe('dedupeCrossSectionSkeletonH4s（跨 H3 同名 H4 串章骨架删除）', () => {
  it('跨 H3 同名 H4 保留首次、删除串章副本（真实回归 6.4 串章形态）', () => {
    const markdown = [
      '## 第六章 安全文明生产',
      '### 安全文明施工部署与流水组织',
      '#### 施工部署与施工流水组织',
      '正文一',
      '### 文明施工与绿色施工管控',
      '#### 文明施工与扬尘噪声管控',
      '正文二',
      '#### 红线外土方覆盖扬尘防治',
      '正文三',
      '### 周边环境与管线保护管控',
      '#### 周边环境、管线与既有建构筑物保护',
      '正文四',
      '#### 施工部署与施工流水组织',
      '串章一',
      '#### 文明施工与扬尘噪声管控',
      '串章二',
      '#### 红线外土方覆盖扬尘防治',
      '串章三',
    ].join('\n');
    const result = dedupeCrossSectionSkeletonH4s(markdown);
    expect(result).toContain('正文一');
    expect(result).toContain('正文二');
    expect(result).toContain('正文三');
    expect(result).toContain('正文四');
    expect(result).not.toContain('串章一');
    expect(result).not.toContain('串章二');
    expect(result).not.toContain('串章三');
  });

  it('H4 与章内任一 H3 同名即删除该 H4 块', () => {
    const markdown = [
      '## 第三章 新技术',
      '### 智慧工地基本级实施',
      '#### 智慧工地基本级实施',
      '与 H3 同名正文',
      '### BIM管线综合与机房深化排布',
      '#### BIM管线综合与机房深化排布技术应用',
      '正文二',
    ].join('\n');
    const result = dedupeCrossSectionSkeletonH4s(markdown);
    expect(result).not.toContain('与 H3 同名正文');
    expect(result).toContain('正文二');
  });

  it('泛化词白名单（施工准备）跨 H3 重复合法保留', () => {
    const markdown = [
      '## 第二章 重点难点',
      '### 土方开挖工程',
      '#### 施工准备',
      '土方准备正文',
      '### 钢筋工程',
      '#### 施工准备',
      '钢筋准备正文',
    ].join('\n');
    const result = dedupeCrossSectionSkeletonH4s(markdown);
    expect(result).toContain('土方准备正文');
    expect(result).toContain('钢筋准备正文');
  });

  it('三要素骨架 H4（施工概况/施工流程/施工方法）跨 H3 重复合法保留（4.19.3 回归：分部块被掏空）', () => {
    const markdown = [
      '## 第二章 主要施工方法',
      '### 道路工程',
      '#### 施工概况',
      '道路概况正文',
      '#### 施工流程',
      '道路流程正文',
      '#### 施工方法',
      '道路方法正文',
      '### 排水工程',
      '#### 施工概况',
      '排水概况正文',
      '#### 施工流程',
      '排水流程正文',
      '#### 施工方法',
      '排水方法正文',
    ].join('\n');
    const result = dedupeCrossSectionSkeletonH4s(markdown);
    expect(result).toContain('道路概况正文');
    expect(result).toContain('道路流程正文');
    expect(result).toContain('道路方法正文');
    expect(result).toContain('排水概况正文');
    expect(result).toContain('排水流程正文');
    expect(result).toContain('排水方法正文');
  });

  it('跨章同名小节不受影响（章级作用域）', () => {
    const markdown = [
      '## 第一章 整体理解',
      '### 周边环境与既有设施保护',
      '#### 周边环境与管线保护',
      '第一章正文',
      '## 第六章 安全文明',
      '### 周边环境与管线保护管控',
      '#### 周边环境与管线保护',
      '第六章正文',
    ].join('\n');
    const result = dedupeCrossSectionSkeletonH4s(markdown);
    expect(result).toContain('第一章正文');
    expect(result).toContain('第六章正文');
  });

  it('编号形态 H4 与章内 H3 同名不删除（4.19.6 回归：容器块总述「3 绿化工程」连坐删除 3447 字）', () => {
    // 容器块总述用「#### 3 绿化工程」分组组织，与分部 H3「### 绿化工程」同名但属结构性引用；
    // 修复前 H4 块删除范围延伸至下一标题，H4 后全部总述正文一并丢失 → 容器块空壳 → 标题也被清掉
    const markdown = [
      '## 第二章 主要施工方法',
      '### 绿化工程',
      '#### 施工概况',
      '绿化概况正文',
      '### 主要分部分项工程施工方案',
      '#### 3 绿化工程',
      '第四组为建筑配套专业组正文段一',
      '成后方能为排水专业组的沟槽开挖正文段二',
      '各专业组之间的工序衔接正文段三',
      '### 生态池及连接路施工方法',
      '#### 施工概况',
      '生态池概况正文',
    ].join('\n');
    const result = dedupeCrossSectionSkeletonH4s(markdown);
    // 总述正文与标题完整保留，不误伤容器块与后续小节
    expect(result).toContain('#### 3 绿化工程');
    expect(result).toContain('第四组为建筑配套专业组正文段一');
    expect(result).toContain('成后方能为排水专业组的沟槽开挖正文段二');
    expect(result).toContain('各专业组之间的工序衔接正文段三');
    expect(result).toContain('### 主要分部分项工程施工方案');
    expect(result).toContain('生态池概况正文');
  });

  it('容器总述小节内无编号 H4 引用分部名也不删除（容器块天然引用全章分部名）', () => {
    const markdown = [
      '## 第二章 主要施工方法',
      '### 道路工程',
      '#### 施工概况',
      '道路概况正文',
      '### 主要分部分项工程施工方案',
      '#### 道路工程',
      '总述引用道路分部正文',
      '### 排水工程',
      '#### 施工概况',
      '排水概况正文',
    ].join('\n');
    const result = dedupeCrossSectionSkeletonH4s(markdown);
    expect(result).toContain('#### 道路工程');
    expect(result).toContain('总述引用道路分部正文');
  });

  it('裸标题 H4 与章内 H3 同名且不在容器小节内仍整块删除（既有契约不变）', () => {
    const markdown = [
      '## 第三章 新技术',
      '### 智慧工地基本级实施',
      '#### 智慧工地基本级实施',
      '与 H3 同名正文',
    ].join('\n');
    const result = dedupeCrossSectionSkeletonH4s(markdown);
    expect(result).not.toContain('与 H3 同名正文');
  });

  it('无重复时原样保留', () => {
    const markdown = '## 第一章\n### 编制说明与工程概况\n#### 项目基本信息表\n正文';
    expect(dedupeCrossSectionSkeletonH4s(markdown)).toBe(markdown);
  });
});

describe('extractSection（精确模式）', () => {
  const content = [
    '### 1.2 施工部署',
    '部署正文',
    '#### 1.2.1 部署要点',
    '要点正文',
    '### 1.3 施工进度',
    '进度正文',
  ].join('\n');

  it('H3 定界向下包含 H4 子节', () => {
    const section = extractSection(content, '施工部署');
    expect(section).toContain('### 1.2 施工部署');
    expect(section).toContain('部署正文');
    expect(section).toContain('要点正文');
    expect(section).not.toContain('进度正文');
  });

  it('未找到目标返回空串', () => {
    expect(extractSection(content, '不存在的小节')).toBe('');
  });

  it('工作包型关键小节包含同级 H4 工作包正文', () => {
    const workPackageContent = [
      '#### 主要分部分项工程施工方案',
      '概述正文',
      '#### 施工概况',
      '工作包一',
      '#### 施工流程',
      '工作包二',
      '### 下一节',
    ].join('\n');
    const section = extractSection(workPackageContent, '主要分部分项工程施工方案');
    expect(section).toContain('概述正文');
    expect(section).toContain('工作包一');
    expect(section).toContain('工作包二');
    expect(section).not.toContain('下一节');
  });
});

describe('extractSection（模糊模式）', () => {
  it('归一化标题匹配返回最长命中正文（不含标题行）', () => {
    const content = [
      '### 工程特点与重点难点分析',
      '本工程位于市区，特点如下。难点在于工期紧张。',
      '### 施工部署',
      '部署正文内容较长较长较长。',
    ].join('\n');
    const section = extractSection(content, '项目特点、重点、难点分析', { fuzzy: true });
    expect(section).toContain('本工程位于市区');
    expect(section).not.toContain('工程特点与重点难点分析');
  });

  it('未命中返回空串', () => {
    expect(extractSection('### 施工部署\n正文', '完全无关标题', { fuzzy: true })).toBe('');
  });
});

describe('comparableSectionTitleText / comparableSectionHeadingMatches', () => {
  it('标题可比归一化（去编号/空白/泛化词/连接词）', () => {
    expect(comparableSectionTitleText('1.3 项目特点、重点、难点分析')).toBe('特点难点分析');
  });

  it('归一化相等 → 匹配', () => {
    expect(comparableSectionHeadingMatches('工程特点与重点难点分析', '项目特点、重点、难点分析')).toBe(true);
  });

  it('归一化后 <4 字不参与匹配（防误匹配保护）', () => {
    expect(comparableSectionHeadingMatches('主要施工方法', '施工方法')).toBe(false);
    expect(comparableSectionHeadingMatches('施工流程', '主要施工流程')).toBe(false);
  });

  it('空标题不匹配', () => {
    expect(comparableSectionHeadingMatches('', '施工部署')).toBe(false);
  });
});

describe('stableHash', () => {
  it('同结构同哈希、顺序敏感、十六进制 40 位', () => {
    const hash = stableHash({ a: 1, b: [1, 2] });
    expect(hash).toBe(stableHash({ a: 1, b: [1, 2] }));
    expect(hash).not.toBe(stableHash({ a: 1, b: [2, 1] }));
    expect(hash).toMatch(/^[0-9a-f]{40}$/u);
  });
});

describe('asStringArray', () => {
  it('数组去空/单字符串/非法类型', () => {
    expect(asStringArray(['a', ' b ', ''])).toEqual(['a', 'b']);
    expect(asStringArray(' x ')).toEqual(['x']);
    expect(asStringArray('')).toEqual([]);
    expect(asStringArray(123)).toEqual([]);
    expect(asStringArray([null, 'a'])).toEqual(['a']);
  });
});

describe('asObjectArray', () => {
  it('数组过滤非对象/单对象包装', () => {
    expect(asObjectArray([{ a: 1 }, null, 'x'])).toEqual([{ a: 1 }]);
    expect(asObjectArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asObjectArray('x')).toEqual([]);
    expect(asObjectArray(null)).toEqual([]);
  });
});

describe('safePlanId', () => {
  it('归一化并限长 48 字符，空值回退', () => {
    expect(safePlanId('ABC 中文!#$', 'fallback')).toBe('abc-中文');
    expect(safePlanId('', 'fallback')).toBe('fallback');
    expect(safePlanId('!!!', 'fallback')).toBe('fallback');
    expect(safePlanId('a'.repeat(60), 'fallback')).toHaveLength(48);
  });
});

describe('stringifyFactValue', () => {
  it('各类值序列化', () => {
    expect(stringifyFactValue(null)).toBe('');
    expect(stringifyFactValue(undefined)).toBe('');
    expect(stringifyFactValue('文本')).toBe('文本');
    expect(stringifyFactValue(123)).toBe('123');
    expect(stringifyFactValue(true)).toBe('true');
    expect(stringifyFactValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('throwIfAborted', () => {
  it('无信号或未中止不抛错', () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });

  it('已中止抛出用户中止错误', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow('用户中止');
  });
});

describe('adaptiveConcurrency', () => {
  it('全量同批启动（不设档位上限）', () => {
    expect(adaptiveConcurrency({ total: 5, kind: 'chapter' })).toBe(5);
    expect(adaptiveConcurrency({ total: 0, kind: 'search' })).toBe(1);
  });
});

describe('runWithAdaptiveConcurrency', () => {
  it('空数组直接返回空结果', async () => {
    await expect(runWithAdaptiveConcurrency([], async item => item, { kind: 'chapter' })).resolves.toEqual([]);
  });

  it('结果按原顺序落位（异步乱序完成不影响顺序）', async () => {
    const results = await runWithAdaptiveConcurrency([1, 2, 3, 4], async (item, index) => {
      await new Promise(resolve => setTimeout(resolve, index === 3 ? 1 : 10));
      return item * 2;
    }, { kind: 'chapter', concurrency: 4 });
    expect(results).toEqual([2, 4, 6, 8]);
  });

  it('concurrency 限制在有效区间', async () => {
    const worker = async (item: number) => item;
    await expect(runWithAdaptiveConcurrency([1, 2, 3], worker, { kind: 'search', concurrency: 99 })).resolves.toEqual([1, 2, 3]);
  });
});

describe('Semaphore', () => {
  it('限流 2：同时最多 2 个任务在飞', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const jobs = Array.from({ length: 5 }, (_, index) => semaphore.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active -= 1;
      return index;
    }));
    const results = await Promise.all(jobs);
    expect(maxActive).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('limit 非法值回退为 1 且 run 透传工作结果', async () => {
    const semaphore = new Semaphore(0);
    expect(await semaphore.run(async () => 'done')).toBe('done');
  });
});

describe('isBidDisciplineSentence（评分报告问题2：商务纪律句判定）', () => {
  it('词表词面命中：全部禁写词逐一命中', () => {
    for (const phrase of BID_DISCIPLINE_PHRASES) {
      expect(isBidDisciplineSentence(`我公司严格遵守${phrase}相关规定。`)).toBe(true);
    }
  });

  it('无禁词词面变体（评分报告原文）按语境判定命中', () => {
    // 评分报告（21）原文：无任何禁写词词面，旧 6 词表清洗/检测双漏
    const reportOriginal = '我公司对参与本项目投标及施工组织设计编制的工作人员实行严格的纪律管理，确保投标活动合法合规。';
    expect(isBidDisciplineSentence(reportOriginal)).toBe(true);
  });

  it('廉洁语境 + 评标相关表述命中', () => {
    expect(isBidDisciplineSentence('项目全体人员签订廉洁从业承诺书。')).toBe(true);
    expect(isBidDisciplineSentence('参与评标活动的工作人员签订廉洁自律承诺。')).toBe(true);
  });

  it('技术标合法用法不误伤：劳动纪律/施工纪律/作息纪律不含商务语境词', () => {
    expect(isBidDisciplineSentence('项目部严格执行劳动纪律与考勤管理制度。')).toBe(false);
    expect(isBidDisciplineSentence('施工纪律要求各班组按时参加班前安全交底。')).toBe(false);
    expect(isBidDisciplineSentence('高温季节调整作息时间，保障作业人员休息纪律。')).toBe(false);
    expect(isBidDisciplineSentence('本工程创优目标为确保黄山杯。')).toBe(false);
    expect(isBidDisciplineSentence('项目部组织全员开展安全生产教育培训。')).toBe(false);
  });
});

describe('isBidDisciplineSentence（评分报告 P3 异常低价串章回归）', () => {
  it('「异常低价计算方式」小节句命中禁写词表', () => {
    expect(isBidDisciplineSentence('异常低价计算方式见招标文件评标办法。')).toBe(true);
    expect(isBidDisciplineSentence('本节介绍异常低价的评审认定标准。')).toBe(true);
    expect(isBidDisciplineSentence('评标基准价计算规则详见评标办法。')).toBe(true);
  });

  it('施工语境合法表述不误伤（低价不等于异常低价评审条款）', () => {
    expect(isBidDisciplineSentence('采用低价环保材料降低施工成本。')).toBe(false);
    expect(isBidDisciplineSentence('优化施工方案以降低材料损耗与机械台班费用。')).toBe(false);
  });
});
