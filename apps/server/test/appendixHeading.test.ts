import { describe, expect, it } from 'vitest';
import { finalizeDocumentMarkdown, promptDocumentRuleIssues } from '../src/services/document-workflow/markdownComposer';
import { formalHeadingHierarchyIssues } from '../src/services/document-workflow/qualityValidation';

describe('appendix heading exemption', () => {
  it('keeps ## appendix headings at document end after double finalize', () => {
    const chapters = [
      { title: '第一章 工程概况', sections: ['1.1 项目概述', '1.2 工程特点'] },
      { title: '第二章 主要施工方法', sections: ['2.1 拆除工程', '2.2 砌体工程'] },
    ];
    const md = [
      '## 第一章 工程概况', '', '### 1.1 项目概述', '', '本项目为框架结构。', '',
      '## 第二章 主要施工方法', '', '### 2.1 拆除工程', '', '拆除顺序自上而下。', '',
      '## 附录B：关键工艺参数汇总', '', '> 本表由正文工艺参数自动归集。', '',
      '| 所属章节 | 工艺参数要点 |', '| --- | --- |', '| 第二章 | 平整度偏差不大于5mm。 |',
    ].join('\n');
    const once = finalizeDocumentMarkdown(md, chapters, { promptRules: { tocPolicy: 'required' as const, forbiddenTerms: [], preferredTerms: [], requiredTables: [] } });
    const twice = finalizeDocumentMarkdown(once.markdown, chapters, { promptRules: { tocPolicy: 'required' as const, forbiddenTerms: [], preferredTerms: [], requiredTables: [] } });
    expect(twice.markdown).toContain('## 附录B：关键工艺参数汇总');
    expect(twice.markdown).not.toContain('### 1.3 附录B');
    expect(twice.markdown).not.toContain('### 2.3 附录B');
    // 附录必须在文档末尾
    expect(twice.markdown.trimEnd().endsWith('| 第二章 | 平整度偏差不大于5mm。 |')).toBe(true);
  });

  it('does not exempt non-appendix plain ## headings', () => {
    const chapters = [
      { title: '第一章 工程概况', sections: ['1.1 项目概述'] },
      { title: '第二章 主要施工方法', sections: ['2.1 拆除工程'] },
    ];
    const md = [
      '## 第一章 工程概况', '', '### 1.1 项目概述', '', '内容。', '',
      '## 第二章 主要施工方法', '', '### 2.1 拆除工程', '', '内容。', '',
      '## 附则', '', '内容。',
    ].join('\n');
    const once = finalizeDocumentMarkdown(md, chapters, { promptRules: { tocPolicy: 'required' as const, forbiddenTerms: [], preferredTerms: [], requiredTables: [] } });
    expect(once.markdown).not.toContain('## 附则');
  });

  it('exempts appendix from formal heading hierarchy issues', () => {
    const md = [
      '## 第一章 工程概况', '', '### 1.1 项目概述', '', '内容。', '',
      '## 附录B：关键工艺参数汇总', '', '| 所属章节 | 工艺参数要点 |', '| --- | --- |', '| 第一章 | 平整度偏差不大于5mm。 |',
    ].join('\n');
    const issues = formalHeadingHierarchyIssues(md);
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
  });

  it('exempts appendix from prompt rule extra heading issues', () => {
    const md = [
      '## 第一章 工程概况', '', '### 1.1 项目概述', '', '内容。', '',
      '## 附录B：关键工艺参数汇总', '', '| 所属章节 | 工艺参数要点 |', '| --- | --- |', '| 第一章 | 平整度偏差不大于5mm。 |',
    ].join('\n');
    const rules = {
      coverPolicy: 'unspecified' as const,
      tocPolicy: 'unspecified' as const,
      forbiddenTerms: [] as string[],
      preferredTerms: [] as Array<{ from: string; to: string }>,
      requiredTables: [] as string[],
      exactHeadings: ['第一章 工程概况'],
      forbidExtraHeadings: true,
    };
    const issues = promptDocumentRuleIssues(md, rules);
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
  });
});
