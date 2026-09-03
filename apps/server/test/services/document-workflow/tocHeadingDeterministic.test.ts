import { describe, expect, it } from 'vitest';
import { finalizeDocumentMarkdown } from '@/services/document-workflow/markdownComposer';
import { alignSectionHeadingsToPlan } from '@/services/document-workflow/utils';
import type { PromptDocumentRuleSet } from '@/services/document-workflow/types';

function rulesOf(overrides: Partial<PromptDocumentRuleSet> = {}): PromptDocumentRuleSet {
  return { forbiddenTerms: [], preferredTerms: [], requiredTables: [], ...overrides };
}

describe('finalizeDocumentMarkdown 目录确定性（4.17.2：目录=成稿正文，不从规划大纲提取）', () => {
  it('目录跟随成稿正文：正文 H3 与规划不一致时目录同步正文（消除目录-正文漂移）', () => {
    const { markdown } = finalizeDocumentMarkdown(
      '## 第一章 工程概况\n\n### 1.1 施工准备（细化后）\n正文甲。\n\n### 1.2 部署方案\n正文乙。',
      [{ title: '工程概况', sections: ['施工准备', '施工部署'], content: '## 第一章 工程概况\n\n### 1.1 施工准备（细化后）\n正文甲。\n\n### 1.2 部署方案\n正文乙。' }],
      { promptRules: rulesOf({ tocPolicy: 'required' }) },
    );
    // 目录区块只收录成稿正文标题：正文改写什么目录显示什么，规划中未写出的「施工部署」不产生幽灵条目
    const tocBlock = markdown.split('## 目录')[1]?.split('<div class="page-break">')[0] || '';
    expect(tocBlock).toContain('施工准备（细化后）');
    expect(tocBlock).toContain('部署方案');
    expect(tocBlock).not.toContain('施工部署');
  });

  it('正文无 H3 时回退规划小节兜底（未展开成 H3 的章节目录不能为空）', () => {
    const { markdown } = finalizeDocumentMarkdown(
      '## 第一章 工程概况\n\n正文无小节标题直接成段。',
      [{ title: '工程概况', sections: ['施工准备'], content: '## 第一章 工程概况\n\n正文无小节标题直接成段。' }],
      { promptRules: rulesOf({ tocPolicy: 'required' }) },
    );
    const tocBlock = markdown.split('## 目录')[1]?.split('<div class="page-break">')[0] || '';
    expect(tocBlock).toContain('施工准备');
  });

  it('tocPolicy 未指定时，LLM 写的脏目录同样被确定性目录替换', () => {
    const { markdown } = finalizeDocumentMarkdown(
      '## 目录\n\n第一章 工程概况\n  1.1 错误的小节名\n\n<div class="page-break"></div>\n\n## 第一章 工程概况\n\n### 1.1 施工准备\n正文。',
      [{ title: '工程概况', sections: ['施工准备'], content: '## 第一章 工程概况\n\n### 1.1 施工准备\n正文。' }],
      {},
    );
    expect(markdown).toContain('施工准备');
    expect(markdown).not.toContain('错误的小节名');
  });

  it('章节无规划 sections 时保留正文提取兜底（目录不为空）', () => {
    const { markdown } = finalizeDocumentMarkdown(
      '## 第一章 工程概况\n\n### 1.1 施工准备\n正文。',
      [{ title: '工程概况', sections: undefined, content: '## 第一章 工程概况\n\n### 1.1 施工准备\n正文。' }],
      { promptRules: rulesOf({ tocPolicy: 'required' }) },
    );
    expect(markdown).toContain('施工准备');
  });

  it('forbidToc 时删除目录页', () => {
    const { markdown } = finalizeDocumentMarkdown(
      '## 目录\n\n第一章 工程概况\n  1.1 施工准备\n\n<div class="page-break"></div>\n\n## 第一章 工程概况\n\n### 1.1 施工准备\n正文。',
      [{ title: '工程概况', sections: ['施工准备'], content: '## 第一章 工程概况\n\n### 1.1 施工准备\n正文。' }],
      { promptRules: rulesOf({ tocPolicy: 'forbidden' }) },
    );
    expect(markdown).not.toContain('## 目录');
  });
});

describe('alignSectionHeadingsToPlan 分层对齐（C2：H3/H4 分开对齐）', () => {
  it('headingLevel=3 只对齐 H3，H4 标题不受影响', () => {
    // H4「质量控制」与规划「质量控制要点」是包含关系——若未分层混排会被改写，分层后必须保持原样
    const markdown = '### 施工部署与流水\n\n#### 质量控制\n正文。';
    const result = alignSectionHeadingsToPlan(markdown, ['施工部署与流水组织', '质量控制要点'], 3);
    expect(result).toBe('### 施工部署与流水组织\n\n#### 质量控制\n正文。');
  });

  it('headingLevel=4 只对齐 H4，H3 标题不受影响', () => {
    const markdown = '### 施工部署\n\n#### 部署与流水\n正文。';
    const result = alignSectionHeadingsToPlan(markdown, ['施工部署'], 4);
    expect(result).toBe(markdown);
  });

  it('分层对齐把近似标题替换为规划标题原文', () => {
    const h3 = alignSectionHeadingsToPlan('### 施工部署细化\n正文。', ['施工部署'], 3);
    expect(h3).toBe('### 施工部署\n正文。');
    const h4 = alignSectionHeadingsToPlan('#### 施工部署与流水\n正文。', ['施工部署与流水组织'], 4);
    expect(h4).toBe('#### 施工部署与流水组织\n正文。');
  });

  it('混排对齐（不指定层级）保持原兼容行为', () => {
    const result = alignSectionHeadingsToPlan('### 施工部署\n正文。', ['施工部署']);
    expect(result).toBe('### 施工部署\n正文。');
  });
});
