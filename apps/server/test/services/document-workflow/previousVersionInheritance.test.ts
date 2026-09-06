import { describe, expect, it } from 'vitest';
import { buildPreviousVersionInheritancePrompt, extractPreviousVersionSignals, isSameProjectPreviousVersion } from '@/services/document-workflow/previousVersionInheritance';

describe('extractPreviousVersionSignals（上一版本三层信号提取）', () => {
  const markdown = [
    '## 1 编制说明',
    '### 1.1 编制依据',
    '#### 1.1.1 施工规范',
    '## 目录',
    '## ☑ 2 工程概况',
    '## 2 工程概况',
    '高峰期总人数20人，配置专职安全员2名。',
    '计划工期540日历天。',
    '总建筑面积12345.6㎡。',
  ].join('\n');

  it('结构信号：H2~H4 标题提取、复选框符号剥离、目录排除、重复去重', () => {
    const signals = extractPreviousVersionSignals({ title: '丰乐镇施组', markdown, completedAt: 1757000000000 });
    expect(signals).not.toBeNull();
    expect(signals!.structureLines).toEqual(['1 编制说明', '1.1 编制依据', '1.1.1 施工规范', '2 工程概况']);
  });

  it('结构信号：商务条款串章标题（异常低价/电子保函）不进结构信号，正常带编号标题保留', () => {
    const signals = extractPreviousVersionSignals({
      title: '丰乐镇施组',
      markdown: ['## 1 编制说明', '## 3.1 异常低价计算方式', '## 8.2 电子保函', '## 2 工程概况', '高峰期总人数20人。'].join('\n'),
      completedAt: 1757000000000,
    });
    // 编号剥离后正常标题放行（「1编制说明」不得被条款编号碎片规则误杀），商务串章标题仍被拦截
    expect(signals!.structureLines).toEqual(['1 编制说明', '2 工程概况']);
  });

  it('事实信号：劳动力峰值/工期/建筑面积三口径句与检测器同口径提取', () => {
    const signals = extractPreviousVersionSignals({ title: '丰乐镇施组', markdown, completedAt: 1757000000000 });
    expect(signals!.factLines).toEqual([
      '高峰期总人数20人，配置专职安全员2名。',
      '计划工期540日历天。',
      '总建筑面积12345.6㎡。',
    ]);
  });

  it('一致性信号：上一版已知问题清单透传（上限 12 条）', () => {
    const issues = ['异常低价计算方式小节不应存在', '施工方法章分项结构与清单不一致'];
    const signals = extractPreviousVersionSignals({ title: '丰乐镇施组', markdown, warningIssues: issues, completedAt: 0 });
    expect(signals!.issueLines).toEqual(issues);
  });

  it('成稿正文为空 → 返回 null（不注入）', () => {
    expect(extractPreviousVersionSignals({ title: '丰乐镇施组', markdown: '', warningIssues: ['x'], completedAt: 1 })).toBeNull();
    expect(extractPreviousVersionSignals({ title: '丰乐镇施组', markdown: '   ', completedAt: 1 })).toBeNull();
  });

  it('三层信号全空（无标题/无数值/无问题）→ 返回 null', () => {
    expect(extractPreviousVersionSignals({ title: '丰乐镇施组', markdown: '正文无标题无数值口径。', completedAt: 1 })).toBeNull();
  });
});

describe('buildPreviousVersionInheritancePrompt（继承提示词块）', () => {
  it('三层信号齐全时输出结构/事实/问题三块约束', () => {
    const signals = extractPreviousVersionSignals({
      title: '丰乐镇施组',
      markdown: '## 1 编制说明\n高峰期总人数20人。\n计划工期540日历天。',
      warningIssues: ['施工方法分项结构不全'],
      completedAt: 1757000000000,
    });
    const prompt = buildPreviousVersionInheritancePrompt(signals!);
    expect(prompt).toContain('上一版本继承参考');
    expect(prompt).toContain('丰乐镇施组');
    expect(prompt).toContain('一、上一版本章节与小节结构');
    expect(prompt).toContain('- 1 编制说明');
    expect(prompt).toContain('二、上一版本关键数值口径');
    expect(prompt).toContain('计划工期540日历天。');
    expect(prompt).toContain('三、上一版已知问题');
    expect(prompt).toContain('- 施工方法分项结构不全');
  });

  it('无信号（null 等价）→ 返回空串', () => {
    expect(buildPreviousVersionInheritancePrompt(null as never)).toBe('');
  });

  it('结构信号缺失时跳过结构块（不输出空清单）', () => {
    const prompt = buildPreviousVersionInheritancePrompt({
      versionTitle: '丰乐镇施组',
      completedAt: 0,
      structureLines: [],
      factLines: ['高峰期总人数20人。'],
      issueLines: [],
    });
    expect(prompt).not.toContain('一、上一版本章节与小节结构');
    expect(prompt).toContain('二、上一版本关键数值口径');
  });
});

describe('isSameProjectPreviousVersion（上一版本同项目校验）', () => {
  it('模板与需求一致 → 允许继承', () => {
    expect(isSameProjectPreviousVersion(
      { templateId: 'tpl-a', requirement: '丰乐镇污水处理设施提标改造' },
      { templateId: 'tpl-a', requirement: '丰乐镇污水处理设施提标改造' },
    )).toBe(true);
  });

  it('模板不同 → 拒绝继承（防同一知识库目录下其他项目串染）', () => {
    expect(isSameProjectPreviousVersion(
      { templateId: 'tpl-b', requirement: '丰乐镇污水处理设施提标改造' },
      { templateId: 'tpl-a', requirement: '丰乐镇污水处理设施提标改造' },
    )).toBe(false);
  });

  it('需求不同（同模板复用于其他招标文件）→ 拒绝继承', () => {
    expect(isSameProjectPreviousVersion(
      { templateId: 'tpl-a', requirement: '某中学扩建工程施工总承包' },
      { templateId: 'tpl-a', requirement: '丰乐镇污水处理设施提标改造' },
    )).toBe(false);
  });

  it('历史记录缺 requirement（旧数据）→ 与空需求输入一致才放行', () => {
    expect(isSameProjectPreviousVersion({ templateId: 'tpl-a' }, { templateId: 'tpl-a', requirement: '' })).toBe(true);
    expect(isSameProjectPreviousVersion({ templateId: 'tpl-a' }, { templateId: 'tpl-a', requirement: '丰乐镇污水处理设施提标改造' })).toBe(false);
  });
});
