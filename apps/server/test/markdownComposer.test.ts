import { describe, expect, it } from 'vitest';
import { chapterSectionFactUsageIssues } from '../src/services/document-workflow/chapterReview';
import { normalizePlannedSections } from '../src/services/document-workflow/promptRuleExtraction';
import { composeDocumentMarkdown, ensureFormalToc, finalizeDocumentMarkdown, inferChapterSectionsFromMarkdown, normalizeInlineListBreaks, normalizeTertiaryHeadings, promptDocumentRuleIssues, sanitizeFormalMarkdown, TENDER_BID_WRITING_RULES } from '../src/services/document-workflow/markdownComposer';
import { collectSectionContentGaps, instructionLikeHeadingIssues, sectionContentIntegrityIssues, tocBodyConsistencyIssues } from '../src/services/document-workflow/qualityValidation';

describe('normalizeTertiaryHeadings', () => {
  it('renumbers existing tertiary headings by current secondary section', () => {
    const markdown = [
      '## 第一章 文档概览',
      '',
      '### 1.1 内容说明',
      '',
      '#### 1.1.1 内容说明',
      '正文',
      '#### 1.1.1 基本信息',
      '正文',
      '',
      '### 1.2 范围说明',
      '',
      '#### 1.1.1 总体目标',
    ].join('\n');

    expect(normalizeTertiaryHeadings(markdown)).toContain('#### 1.1.1 内容说明');
    expect(normalizeTertiaryHeadings(markdown)).toContain('#### 1.1.2 基本信息');
    expect(normalizeTertiaryHeadings(markdown)).toContain('#### 1.2.1 总体目标');
  });

  it('downgrades fifth-level tertiary headings under a secondary section', () => {
    const markdown = [
      '## 第二章 内容安排',
      '',
      '### 2.1 结构说明',
      '',
      '##### 1.1.1 详细事项',
    ].join('\n');

    expect(normalizeTertiaryHeadings(markdown)).toContain('#### 2.1.1 详细事项');
    expect(normalizeTertiaryHeadings(markdown)).not.toContain('#####');
  });
});

describe('formal markdown structure', () => {
  const chapters = [{
    title: '文档概览',
    sections: ['内容说明', '范围说明'],
    content: [
      '### 内容说明',
      '',
      '##### 依据说明',
      '正文内容完整。',
      '##### 基本信息',
      '正文内容完整。',
      '',
      '### 范围说明',
      '正文内容完整。',
    ].join('\n'),
  }];

  it('keeps tertiary headings out of the formal table of contents', () => {
    const markdown = composeDocumentMarkdown({ title: '测试文档', chapters });

    const tocBlock = markdown.slice(markdown.indexOf('## 目录'), markdown.lastIndexOf('<div class="page-break"></div>'));
    expect(tocBlock).toContain('  1.1 内容说明');
    expect(tocBlock).toContain('  1.2 范围说明');
    expect(tocBlock).not.toContain('1.1.1 依据说明');
    expect(markdown).toContain('#### 1.1.1 依据说明');
    expect(tocBodyConsistencyIssues(markdown)).toHaveLength(0);
  });

  it('normalizes malformed secondary and tertiary numbering', () => {
    const markdown = ensureFormalToc([
      '## 第一章 文档概览',
      '#### 1.1 内容说明',
      '#### 1.1.1 依据说明',
      '### 范围说明',
    ].join('\n'), chapters);

    expect(markdown).toContain('### 1.1 内容说明');
    expect(markdown).toContain('#### 1.1.1 依据说明');
    expect(markdown).toContain('### 1.2 范围说明');
    expect(tocBodyConsistencyIssues(markdown)).toHaveLength(0);
  });

  it('removes duplicate body chapter headings and keeps inferred sections in toc', () => {
    const markdown = composeDocumentMarkdown({
      title: '测试文档',
      chapters: [{
        title: '物资计划',
        sections: [],
        content: [
          '第一章 物资计划',
          '',
          '## 物资计划',
          '',
          '#### 3.1 编制原则',
          '正文内容完整。',
          '#### 3.2 管理措施',
          '正文内容完整。',
        ].join('\n'),
      }],
    });
    const finalSections = inferChapterSectionsFromMarkdown(markdown, [{ title: '物资计划', sections: [] }]);
    const finalMarkdown = ensureFormalToc(markdown, [{ title: '物资计划', sections: finalSections[0] || [] }]);

    expect(finalMarkdown).toContain('  1.1 编制原则');
    expect(finalMarkdown).toContain('  1.2 管理措施');
    expect(finalMarkdown).toContain('### 1.1 编制原则');
    const bodyMarkdown = finalMarkdown.slice(finalMarkdown.lastIndexOf('<div class="page-break"></div>'));
    expect(bodyMarkdown).not.toContain('\n第一章 物资计划\n');
    expect(finalMarkdown.match(/^##\s+/gmu)).toHaveLength(2);
    expect(tocBodyConsistencyIssues(finalMarkdown)).toHaveLength(0);
  });

  it('promotes grouped tertiary headings to missing secondary sections', () => {
    const markdown = composeDocumentMarkdown({
      title: '测试文档',
      chapters: [{
        title: '进度控制',
        sections: [],
        content: [
          '## 进度控制',
          '',
          '#### 8.1.1 目标与依据',
          '正文内容完整。',
          '#### 8.1.2 区段划分',
          '正文内容完整。',
          '#### 8.2.1 组织机构',
          '正文内容完整。',
          '#### 8.2.2 考勤管理',
          '正文内容完整。',
        ].join('\n'),
      }],
    });

    expect(markdown).toContain('  1.1 目标与依据');
    expect(markdown).toContain('  1.2 组织机构');
    expect(markdown).toContain('### 1.1 目标与依据');
    expect(markdown).toContain('#### 1.1.1 区段划分');
    expect(markdown).toContain('### 1.2 组织机构');
    expect(markdown).toContain('#### 1.2.1 考勤管理');
    expect(tocBodyConsistencyIssues(markdown)).toHaveLength(0);
  });

  it('reports empty or hollow configured sections as blocking content gaps', () => {
    const markdown = composeDocumentMarkdown({
      title: '测试文档',
      chapters: [{
        title: '质量计划',
        sections: ['目标分解', '检查闭环'],
        content: [
          '### 目标分解',
          '',
          '#### 目标表',
          '| 项 | 值 |',
          '| --- | --- |',
          '| 质量 | 合格 |',
          '',
          '### 检查闭环',
          '检查闭环应覆盖责任、频次、记录、整改和复核，形成可追踪的质量管理链条，确保问题发现后能够落实到责任人、完成时限和复验结论。对检查发现的问题应建立台账，明确整改措施、责任岗位、完成日期、复查人员和关闭依据，并在后续巡检中复核同类问题是否重复发生。相关记录应与验收、移交和考核结果关联，作为后续管理改进的依据。现场管理人员还应定期汇总检查数据，分析问题集中部位、重复原因和资源保障情况，形成持续改进措施。',
        ].join('\n'),
      }],
    });

    const issues = sectionContentIntegrityIssues(markdown, [{ title: '质量计划', sections: ['目标分解', '检查闭环'], content: markdown }]);
    expect(issues.map(issue => issue.message).join('\n')).toContain('只有标题或表格无正文：目标分解');
    expect(issues.map(issue => issue.message).join('\n')).not.toContain('检查闭环');
  });

  it('collects actual non-configured secondary and tertiary section gaps', () => {
    const content = [
      '### 进度控制',
      '',
      '#### 进度表',
      '| 项 | 值 |',
      '| --- | --- |',
      '| 节点 | 完成 |',
      '',
      '### 资源保障',
      '资源保障应覆盖人员、设备、材料、资金和信息传递要求，明确投入条件、调配机制、检查频次和异常处置方式。责任岗位应根据任务分工建立跟踪台账，按计划节点核对资源到位情况，发现偏差后及时协调补充并形成记录。各类资源安排还应结合现场约束、作业面变化和验收要求动态调整，确保执行过程可追踪、结果可复核。管理人员需要定期汇总资源偏差、处理结果和后续影响，形成可用于复盘、考核和持续改进的管理依据，并在关键节点前完成再次核查。',
    ].join('\n');
    const gaps = collectSectionContentGaps(content, [{ title: '计划管理', sections: [], content }]);

    expect(gaps.map(gap => gap.message).join('\n')).toContain('小节只有标题或表格无正文：进度控制');
    expect(gaps.map(gap => gap.message).join('\n')).toContain('小节只有标题或表格无正文：进度表');
    expect(gaps.map(gap => gap.message).join('\n')).not.toContain('资源保障');
  });

  it('exempts table-only sections whose title ends with 表 (data rows >= 2)', () => {
    const content = [
      '### 危大工程全流程闭环管控表',
      '',
      '| 类别 | 内容 |',
      '| --- | --- |',
      '| 深基坑 | 支护方案、监测要求 |',
      '| 高支模 | 专项方案、验收记录 |',
    ].join('\n');
    const gaps = collectSectionContentGaps(content, [{ title: '危大工程', sections: [], content }]);
    expect(gaps).toHaveLength(0);
  });

  it('exempts table-carrier sections (计划/节点类) with complete data tables', () => {
    const LF_CHAR = String.fromCharCode(10);
    const content = [
      '### 关键节点计划与责任分解',
      '',
      '| 关键节点 | 计划完成时间 | 责任岗位 |',
      '| --- | --- | --- |',
      '| 施工准备 | 第1～3日 | 技术负责人 |',
      '| 拆除清运 | 第4～10日 | 施工员 |',
    ].join(LF_CHAR);
    const gaps = collectSectionContentGaps(content, [{ title: '工程重点难点及危大工程的保障体系', sections: ['关键节点计划与责任分解'], content }]);
    expect(gaps).toHaveLength(0);
  });

  it('still blocks table-carrier sections when data rows are below 2', () => {
    const LF_CHAR = String.fromCharCode(10);
    const content = [
      '### 施工进度计划',
      '',
      '| 项 | 值 |',
      '| --- | --- |',
      '| 开工 | 第1日 |',
    ].join(LF_CHAR);
    const gaps = collectSectionContentGaps(content, [{ title: '工期计划', sections: [], content }]);
    expect(gaps.map(gap => gap.message).join('、')).toContain('小节只有标题或表格无正文：施工进度计划');
  });

  it('removes orphan and unfinished lines during sanitization', () => {
    const markdown = sanitizeFormalMarkdown(['完整段落。', '在', '本段内容包括', '| 列 |', '| --- |', '| 在 |'].join('\n'));

    expect(markdown).toContain('完整段落。');
    expect(markdown).not.toMatch(/^在$/mu);
    expect(markdown).not.toContain('本段内容包括');
    expect(markdown).toContain('| 在 |');
  });

  it('checks prompt hard rules for formal tables, required keywords and forbidden content', () => {
    const markdown = [
      '## 第一章 施工部署',
      '',
      '**资源计划表**',
      '',
      '当前章节只写了表名，没有正式表格，并且出现禁止出现内容。',
    ].join('\n');
    const issues = promptDocumentRuleIssues(markdown, {
      forbiddenTerms: [],
      preferredTerms: [],
      requiredTables: ['资源计划表'],
      requiredKeywords: ['闭环管理'],
      forbiddenPatterns: ['禁止出现内容'],
    });
    const messages = issues.map(issue => issue.message).join('\n');

    expect(messages).toContain('正文缺少总控提示词要求的正式表格：资源计划表');
    expect(messages).toContain('正文缺少提示词要求覆盖的关键词：闭环管理');
    expect(messages).toContain('正文出现提示词禁止内容：禁止出现内容');
  });

  it('respects prompt cover and toc policy instead of always generating them', () => {
    const chapters = [{ title: '工程概况', sections: ['项目概况'], content: '### 项目概况\n正文内容完整。' }];
    const source = [
      '<div class="document-cover">',
      '# 测试文档',
      '</div>',
      '',
      '<div class="page-break"></div>',
      '',
      '## 目录',
      '',
      '第一章 工程概况',
      '',
      '<div class="page-break"></div>',
      '',
      '## 第一章 工程概况',
      '### 项目概况',
      '正文内容完整。',
    ].join('\n');
    const withoutFrontMatter = finalizeDocumentMarkdown(source, chapters, {
      promptRules: { coverPolicy: 'unspecified', tocPolicy: 'unspecified', forbiddenTerms: [], preferredTerms: [], requiredTables: [] },
    }).markdown;
    const withFrontMatter = finalizeDocumentMarkdown(source, chapters, {
      promptRules: { coverPolicy: 'required', tocPolicy: 'required', forbiddenTerms: [], preferredTerms: [], requiredTables: [] },
    }).markdown;

    expect(withoutFrontMatter).not.toContain('document-cover');
    expect(withoutFrontMatter).not.toMatch(/^##\s+目录/mu);
    expect(withFrontMatter).toContain('document-cover');
    expect(withFrontMatter).toMatch(/^##\s+目录/mu);
  });

  it('removes instruction-like headings from generated toc and body', () => {
    const markdown = composeDocumentMarkdown({
      title: '测试文档',
      chapters: [{
        title: '特殊气候措施',
        sections: ['判断是否涉及冬季施工', '雨季施工措施'],
        content: ['### 判断是否涉及冬季施工', '本项目应结合气象资料执行。', '', '### 雨季施工措施', '雨季施工应覆盖排水、材料防潮、设备巡检、临电保护和应急响应要求。'].join('\n'),
      }],
    });

    expect(markdown).not.toContain('判断是否涉及冬季施工');
    expect(markdown).toContain('  1.1 雨季施工措施');
    expect(markdown).toContain('### 1.1 雨季施工措施');
    expect(tocBodyConsistencyIssues(markdown)).toHaveLength(0);
    expect(instructionLikeHeadingIssues(markdown)).toHaveLength(0);
  });

  it('reports instruction-like headings and toc/body mismatches as blocking issues', () => {
    const markdown = ['## 目录', '', '第一章 特殊气候措施', '  1.1 判断是否涉及冬季施工', '', '<div class="page-break"></div>', '', '## 第一章 特殊气候措施', '', '### 1.1 雨季施工措施', '雨季施工应覆盖排水、材料防潮、设备巡检、临电保护和应急响应要求。', '', '### 1.2 判断是否涉及冬季施工', '本项目按实际情况判断。'].join('\n');

    expect(tocBodyConsistencyIssues(markdown).every(issue => issue.level === 'error')).toBe(true);
    expect(instructionLikeHeadingIssues(markdown).map(issue => issue.message).join('\n')).toContain('疑似提示词指令标题');
  });

  it('filters polluted planned sections before generation', () => {
    expect(normalizePlannedSections(['**应急预案**', '- 判断是否涉', '雨季', '冬季', '高温', '台风', '大风等特殊气候', '雨季、冬季、高温、台风、大风等特殊气候', '确保工期的保障体系与措施'], '确保工期与质量的保障体系与措施')).toEqual(['应急预案', '确保工期的保障体系与措施']);
  });

  it('removes prompt-fragment and fragmented weather headings from toc/body', () => {
    const markdown = composeDocumentMarkdown({
      title: '测试文档',
      chapters: [{
        title: '确保工期与质量的保障体系与措施',
        sections: ['**应急预案**', '- 判断是否涉', '雨季', '冬季', '高温', '台风', '大风等特殊气候', '雨季、冬季、高温、台风、大风等特殊气候', '确保工期的保障体系与措施'],
        content: ['### **应急预案**', '建立应急组织。', '', '### - 判断是否涉', '雨季', '', '### 雨季', '雨季施工应做好排水。', '', '### 雨季、冬季、高温、台风、大风等特殊气候', '特殊天气控制。', '', '### 确保工期的保障体系与措施', '项目应围绕45日历天工期目标组织资源。'].join('\n'),
      }],
    });

    expect(markdown).not.toContain('**应急预案**');
    expect(markdown).toContain('应急预案');
    expect(markdown).not.toContain('判断是否涉');
    expect(markdown).not.toContain('  1.2 雨季');
    expect(markdown).not.toContain('### 1.2 雨季');
    expect(markdown).not.toContain('雨季、冬季、高温、台风、大风等特殊气候');
    expect(markdown).toContain('确保工期的保障体系与措施');
  });

  it('removes repeated generic supplement placeholders', () => {
    const markdown = composeDocumentMarkdown({
      title: '测试文档',
      chapters: [{ title: '施工方案', sections: ['主要施工方案'], content: '### 主要施工方案\n该小节围绕“主要施工方案”进行补充说明，执行时应结合本章已列明的资料事实、施工对象、控制边界和质量安全要求组织实施。\n针对本项目建筑面积约4645㎡的特点组织施工。' }],
    });

    expect(markdown).not.toContain('该小节围绕');
    expect(markdown).toContain('建筑面积约4645㎡');
  });

  it('detects section-level fact density gaps when evidence facts are not used', () => {
    const chapter = { id: 'c1', title: '施工部署', purpose: '', queries: [], requiredFacts: [], sections: ['工程概况'] };
    const evidence = [{ filePath: '/tmp/招标文件.md', content: '建设地点：黄山市屯溪区。\n计划工期：180日历天。\n质量标准：一次性验收合格。', score: 1 }];
    const looseContent = '## 施工部署\n\n### 工程概况\n\n本工程应结合现场情况组织施工，强化质量、安全和进度管理。';
    const factualContent = '## 施工部署\n\n### 工程概况\n\n本工程建设地点为黄山市屯溪区，计划工期为180日历天，质量标准为一次性验收合格。项目组织应围绕该地点条件、工期节点和质量目标配置资源。工程总建筑面积约4645平方米，包括综合楼、厂房及配套设施。施工内容涵盖地基基础、主体结构、装饰装修、机电安装等分部工程，需编制详细的施工组织设计和专项施工方案。同时做好现场临时设施的搭设和施工机具的调配工作，合理安排施工顺序和劳动力计划，确保各工序衔接顺畅。';

    expect(chapterSectionFactUsageIssues({ chapter, content: looseContent, evidence }).join('\n')).toContain('小节正文过短，需补写专业做法和证据依据');
    expect(chapterSectionFactUsageIssues({ chapter, content: factualContent, evidence })).toHaveLength(0);
  });

  it('removes instruction-like headings during sanitization and reports them before cleanup', () => {
    const markdown = ['## 第二章 特殊气候措施', '', '### 2.2 - 判断是否涉', '', '本项目不涉及冬季施工。'].join('\n');

    expect(promptDocumentRuleIssues(markdown, { forbiddenTerms: [], preferredTerms: [], requiredTables: [] }).map(issue => issue.message).join('\n')).toContain('疑似提示词指令标题');
    expect(sanitizeFormalMarkdown(markdown)).not.toContain('判断是否涉');
  });

  it('keeps work-package H4 headings under their H3 instead of promoting them', () => {
    const markdown = composeDocumentMarkdown({
      title: '测试文档',
      chapters: [{
        title: '主要施工方案',
        sections: ['文明施工与环境保护', '主要分部分项工程施工方案'],
        content: [
          '### 文明施工与环境保护',
          '正文内容完整。',
          '#### 9.0 文明施工',
          '正文内容完整。',
          '#### 9.0 扬尘噪声废水达标管控',
          '正文内容完整。',
          '### 主要分部分项工程施工方案',
          '正文内容完整。',
          '#### 4.1 室内拆除与垃圾外运',
          '正文内容完整。',
        ].join('\n'),
      }],
    });

    expect(markdown).toContain('### 1.1 文明施工与环境保护');
    expect(markdown).toContain('### 1.2 主要分部分项工程施工方案');
    expect(markdown).toContain('#### 1.1.1 文明施工');
    expect(markdown).toContain('#### 1.1.2 扬尘噪声废水达标管控');
    expect(markdown).toContain('#### 1.2.1 室内拆除与垃圾外运');
    expect(markdown).not.toContain('### 1.3 文明施工');
    expect(markdown).not.toContain('### 1.3 室内拆除与垃圾外运');
    expect(tocBodyConsistencyIssues(markdown)).toHaveLength(0);
  });
});

describe('normalizeInlineListBreaks regression', () => {
  it('splits CRLF and LF lines and collapses 3+ newline runs to double', () => {
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const input = `第一行${CR}${LF}第二行${LF}${LF}${LF}第三行`;
    const result = normalizeInlineListBreaks(input);
    expect(result.split(LF)).toEqual(['第一行', '第二行', '', '第三行']);
  });

  it('keeps normal single-LF separators unchanged', () => {
    const LF = String.fromCharCode(10);
    const result = normalizeInlineListBreaks(`甲${LF}乙${LF}丙`);
    expect(result.split(LF)).toEqual(['甲', '乙', '丙']);
  });
});

describe('TENDER_BID_WRITING_RULES 质量硬约束防回归', () => {
  it('包含闭环句式密度硬约束（每 1500 字 1 段三要素齐全）', () => {
    expect(TENDER_BID_WRITING_RULES).toContain('每 1500 字至少 1 段完整闭环句式');
  });

  it('包含工艺参数密度硬约束（每 1000 字 6 处量化参数）', () => {
    expect(TENDER_BID_WRITING_RULES).toContain('每 1000 字至少落位 6 处带单位的量化工艺参数');
  });

  it('包含工序链箭头硬约束（段落占比不低于 8%）', () => {
    expect(TENDER_BID_WRITING_RULES).toContain('全文含箭头工序链的段落占比不低于 8%');
  });
});

describe('sanitizeFormalMarkdown 内部术语净化（工作包）', () => {
  it('标题尾缀“工作包”整体剥除（拆除工程工作包→拆除工程）', () => {
    const markdown = sanitizeFormalMarkdown('### 1.3 项目主要施工内容\n\n#### 1.3.1 拆除工程工作包\n\n正文内容。');
    expect(markdown).toContain('#### 1.3.1 拆除工程');
    expect(markdown).not.toContain('工作包');
  });

  it('正文叙述中的“工作包”替换为正式术语“专业工程”', () => {
    const markdown = sanitizeFormalMarkdown('以下按工作包逐项说明施工概况、施工流程、施工方法。');
    expect(markdown).toContain('以下按专业工程逐项说明');
    expect(markdown).not.toContain('工作包');
  });

  it('表格行中的“工作包”同样净化', () => {
    const markdown = sanitizeFormalMarkdown('| 拆除作业与保留商铺并存 | 拆除工作包、相邻商铺安全 |');
    expect(markdown).toContain('拆除专业工程');
    expect(markdown).not.toContain('工作包');
  });
});
