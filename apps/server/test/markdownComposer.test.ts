import { describe, expect, it } from 'vitest';
import { composeDocumentMarkdown, ensureFormalToc, inferChapterSectionsFromMarkdown, normalizeTertiaryHeadings, sanitizeFormalMarkdown } from '../src/services/document-workflow/markdownComposer';
import { collectSectionContentGaps, sectionContentIntegrityIssues, tocBodyConsistencyIssues } from '../src/services/document-workflow/qualityValidation';

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

  it('removes orphan and unfinished lines during sanitization', () => {
    const markdown = sanitizeFormalMarkdown(['完整段落。', '在', '本段内容包括', '| 列 |', '| --- |', '| 在 |'].join('\n'));

    expect(markdown).toContain('完整段落。');
    expect(markdown).not.toMatch(/^在$/mu);
    expect(markdown).not.toContain('本段内容包括');
    expect(markdown).toContain('| 在 |');
  });
});
