/**
 * LLM 小节规划单测（Step 3：LLM 规划常态化）：
 * - planAdditionalSectionsWithLlm（additions-only 补规划）：basis 支撑自检、结构守恒去重、≤3 上限、空响应/失败回退；
 * - planChapterSectionsWithLlm：项目专业图谱摘要显式注入断言。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planAdditionalSectionsWithLlm, planChapterSectionsWithLlm } from '@/services/document-workflow/promptRuleExtraction';
import type { DocumentEvidence, DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';

const llmState = vi.hoisted(() => {
  let result: unknown;
  let error: unknown;
  const calls: string[] = [];
  return {
    setResult: (value: unknown) => { result = value; error = undefined; },
    setError: (value: unknown) => { error = value; result = undefined; },
    calls,
    clear: () => { calls.length = 0; result = undefined; error = undefined; },
    get result() { return result; },
    get error() { return error; },
  };
});

vi.mock('@/services/document-workflow/llmClient', () => ({
  callDocumentLlmJson: async (_system: string, userPrompt: string, _options: unknown) => {
    llmState.calls.push(String(userPrompt));
    if (llmState.error) throw llmState.error;
    return llmState.result;
  },
}));

const template = { id: 'tpl-1', name: '房建工程施工组织设计', chapters: [] } as unknown as DocumentTemplate;

function chapter(overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'c1', title: '主要分部分项工程施工方案', purpose: '', queries: [], requiredFacts: [], sections: ['总体施工部署'], ...overrides };
}

function additionsInput(overrides: Partial<Parameters<typeof planAdditionalSectionsWithLlm>[0]> = {}): Parameters<typeof planAdditionalSectionsWithLlm>[0] {
  return {
    template,
    chapter: chapter(),
    evidence: [] as DocumentEvidence[],
    promptTexts: '',
    projectContext: '项目上下文',
    roleContext: '写作目标',
    maxTotalSections: 12,
    ...overrides,
  };
}

afterEach(() => { llmState.clear(); });

describe('planAdditionalSectionsWithLlm（additions-only 补规划）', () => {
  it('返回带支撑依据的新增专业小节', async () => {
    llmState.setResult({ sections: [{ title: '基坑支护施工', basis: '来自绑定资料基坑支护专项方案' }] });
    const additions = await planAdditionalSectionsWithLlm(additionsInput());
    expect(additions).toEqual(['基坑支护施工']);
  });

  it('basis 为空/过短的小节被丢弃（无素材来源即空壳）', async () => {
    llmState.setResult({ sections: [{ title: '基坑支护施工', basis: '   ' }, { title: '防水工程施工', basis: '来自通用施工工艺做法' }] });
    const additions = await planAdditionalSectionsWithLlm(additionsInput());
    expect(additions).toEqual(['防水工程施工']);
  });

  it('与已有小节语义包含关系的小节被丢弃（结构守恒去重）', async () => {
    llmState.setResult({ sections: [{ title: '总体施工部署', basis: '来自绑定资料总体部署说明' }, { title: '基坑支护施工', basis: '来自绑定资料基坑支护专项方案' }] });
    const additions = await planAdditionalSectionsWithLlm(additionsInput({ chapter: chapter({ sections: ['总体施工部署'] }) }));
    expect(additions).toEqual(['基坑支护施工']);
  });

  it('最多返回 3 个新增小节', async () => {
    llmState.setResult({
      sections: [
        { title: '基坑支护施工', basis: '来自绑定资料基坑支护专项方案' },
        { title: '主体结构施工', basis: '来自通用施工工艺' },
        { title: '防水工程施工', basis: '来自通用施工工艺' },
        { title: '装饰装修施工', basis: '来自通用施工工艺' },
      ],
    });
    const additions = await planAdditionalSectionsWithLlm(additionsInput());
    expect(additions).toHaveLength(3);
  });

  it('已有小节数已达上限时不调用 LLM 直接返回空', async () => {
    const additions = await planAdditionalSectionsWithLlm(additionsInput({ chapter: chapter({ sections: Array.from({ length: 12 }, (_, index) => `小节${index + 1}`) }), maxTotalSections: 12 }));
    expect(additions).toEqual([]);
    expect(llmState.calls).toHaveLength(0);
  });

  it('LLM 调用失败回退空数组（保留模板锁定结构）', async () => {
    llmState.setError(new Error('llm boom'));
    const additions = await planAdditionalSectionsWithLlm(additionsInput());
    expect(additions).toEqual([]);
  });

  it('LLM 空响应回退空数组', async () => {
    llmState.setResult({ sections: [] });
    const additions = await planAdditionalSectionsWithLlm(additionsInput());
    expect(additions).toEqual([]);
  });
});

describe('planChapterSectionsWithLlm 图谱显式注入', () => {
  it('项目专业图谱摘要注入规划提示词', async () => {
    llmState.setResult({ sections: ['基坑支护施工', '主体结构施工', '防水工程施工'] });
    await planChapterSectionsWithLlm({
      template,
      chapter: chapter({ sections: [] }),
      evidence: [] as DocumentEvidence[],
      promptTexts: '',
      projectContext: '',
      roleContext: '',
      targetWords: 3000,
      projectGraphSummary: '专业工程：基坑支护、地下室结构；主要工法/工艺：灌注桩',
    });
    const userText = llmState.calls[0];
    expect(userText).toContain('本项目专业工程与资源图谱');
    expect(userText).toContain('专业工程：基坑支护、地下室结构');
  });
});
