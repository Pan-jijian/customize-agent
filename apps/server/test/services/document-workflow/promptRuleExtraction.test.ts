/**
 * LLM 小节规划单测（Step 3：LLM 规划常态化）：
 * - planChapterSectionsWithLlm：项目专业图谱摘要显式注入断言。
 * - 多样性治理接入：directive/avoidSections 注入、指纹撞名核验-反馈重规划、二次核验不阻断。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planChapterSectionsWithLlm } from '@/services/document-workflow/promptRuleExtraction';
import { DIVERSITY_PLANNING_TEMPERATURE } from '@/services/document-workflow/diversityProfile';
import type { DocumentEvidence, DocumentTemplate, DocumentTemplateChapter } from '@/services/document-workflow/types';

const llmState = vi.hoisted(() => {
  let result: unknown;
  let error: unknown;
  const results: unknown[] = [];
  const calls: string[] = [];
  const systems: string[] = [];
  const options: unknown[] = [];
  const clear = () => { calls.length = 0; systems.length = 0; options.length = 0; results.length = 0; result = undefined; error = undefined; };
  return {
    setResult: (value: unknown) => { result = value; error = undefined; },
    setError: (value: unknown) => { error = value; result = undefined; },
    /** 多轮调用结果序列：按调用顺序消耗（核验-反馈重规划场景） */
    pushResult: (value: unknown) => { results.push(value); },
    calls,
    systems,
    options,
    clear,
    get result() { return result; },
    get error() { return error; },
    get results() { return results; },
  };
});

vi.mock('@/services/document-workflow/llmClient', () => ({
  callDocumentLlmJson: async (system: string, userPrompt: string, options: unknown) => {
    llmState.calls.push(String(userPrompt));
    llmState.systems.push(String(system));
    llmState.options.push(options);
    if (llmState.error) throw llmState.error;
    if (llmState.results.length > 0) return llmState.results.shift();
    return llmState.result;
  },
}));

const template = { id: 'tpl-1', name: '房建工程施工组织设计', chapters: [] } as unknown as DocumentTemplate;

function chapter(overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'c1', title: '主要分部分项工程施工方案', purpose: '', queries: [], requiredFacts: [], sections: ['总体施工部署'], ...overrides };
}

afterEach(() => { llmState.clear(); });

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

/** 基础输入：非首章、无锁定小节（多样性核验场景） */
function baseInput(overrides: Partial<Parameters<typeof planChapterSectionsWithLlm>[0]> = {}): Parameters<typeof planChapterSectionsWithLlm>[0] {
  return {
    template,
    chapter: chapter({ sections: [] }),
    evidence: [] as DocumentEvidence[],
    promptTexts: '',
    projectContext: '',
    roleContext: '',
    targetWords: 3000,
    ...overrides,
  };
}

describe('planChapterSectionsWithLlm 多样性治理接入', () => {
  it('directive/avoidSections 注入提示词，规划温度使用多样性规划常量', async () => {
    llmState.setResult({ sections: ['劳动力班组梯队配置'] });
    await planChapterSectionsWithLlm(baseInput({
      diversity: { directive: '本章按“总承包管理视角”组织小节。', avoidSections: ['施工劳动力动态调配', '材料进场计划'] },
    }));
    expect(llmState.systems[0]).toContain('总承包管理视角');
    expect(llmState.calls[0]).toContain('施工劳动力动态调配');
    expect(llmState.calls[0]).toContain('材料进场计划');
    expect((llmState.options[0] as { temperature?: number }).temperature).toBe(DIVERSITY_PLANNING_TEMPERATURE);
  });

  it('指纹撞名触发一轮核验反馈重规划，重命名后清零', async () => {
    llmState.pushResult({ sections: ['施工劳动力动态调配'] });
    llmState.pushResult({ sections: ['劳动力班组梯队配置'] });
    const result = await planChapterSectionsWithLlm(baseInput({
      diversity: {
        directive: '本章按“总承包管理视角”组织小节。',
        overlapCheck: titles => titles.includes('施工劳动力动态调配') ? ['「施工劳动力动态调配」↔历史「劳动力动态调配」'] : [],
      },
    }));
    expect(llmState.calls.length).toBe(2);
    expect(llmState.calls[1]).toContain('上一轮规划存在以下必须修正的问题');
    expect(llmState.calls[1]).toContain('施工劳动力动态调配');
    expect(result.sections).toContain('劳动力班组梯队配置');
    expect(result.diversity).toEqual({ retried: true, remainingCollisions: 0 });
  });

  it('二次核验仍撞名时接受结果不阻断（remainingCollisions 上报）', async () => {
    llmState.pushResult({ sections: ['施工劳动力动态调配'] });
    llmState.pushResult({ sections: ['施工劳动力动态调配'] });
    const result = await planChapterSectionsWithLlm(baseInput({
      diversity: { directive: '本章按“总承包管理视角”组织小节。', overlapCheck: () => ['「施工劳动力动态调配」↔历史「劳动力动态调配」'] },
    }));
    expect(llmState.calls.length).toBe(2);
    expect(result.sections).toContain('施工劳动力动态调配');
    expect(result.diversity).toEqual({ retried: true, remainingCollisions: 1 });
  });

  it('首章概况小节“存在但未置首”触发重规划；完全未规划则不触发', async () => {
    llmState.pushResult({ sections: ['施工总体部署', '工程概况与编制说明'] });
    llmState.pushResult({ sections: ['工程概况与编制说明', '施工总体部署'] });
    const first = await planChapterSectionsWithLlm(baseInput({ chapter: chapter({ title: '编制说明', sections: [] }), chapterIndex: 0 }));
    expect(llmState.calls.length).toBe(2);
    expect(llmState.calls[1]).toContain('必须置于小节清单第一位');
    expect(first.sections[0]).toBe('工程概况与编制说明');

    llmState.clear();
    llmState.pushResult({ sections: ['施工总体部署', '资源配置计划'] });
    await planChapterSectionsWithLlm(baseInput({ chapter: chapter({ title: '编制说明', sections: [] }), chapterIndex: 0 }));
    expect(llmState.calls.length).toBe(1);
  });
});
