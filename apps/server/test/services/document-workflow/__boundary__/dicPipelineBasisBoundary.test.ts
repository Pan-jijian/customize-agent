/**
 * supplementRequiredTexts 编制依据类别段落兜底（丰乐镇第十二轮实测）
 *
 * 背景：总控提示词总纲要求「编制依据应按类别列出：招标文件及补疑补遗、国家法律法规、
 * 国家/行业/地方现行规范标准、地方法规规章和企业管理体系」五类；实测 LLM 只写一句
 * 笼统话（「包括国家法律法规、地方法规及现行规范」）→ missingRequiredTexts 已为空，
 * 原逻辑静默漏注入，五类清单全丢。修复：类别词 ≥3 命中才认定类别已列出，否则注入
 * 确定性类别段落（资料未明确法规编号时只写类别不编造法规名）。
 *
 * 原则：每条用例独立断言意义；真实实现行为一律锁定，不迎合用例改实现。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentTemplate } from '@/services/document-workflow/types';

vi.mock('@/services/document-workflow/qualityValidation', async importOriginal => {
  const actual = await importOriginal<typeof import('@/services/document-workflow/qualityValidation')>();
  return { ...actual, autoSpecGateRequiredTexts: vi.fn() };
});

import { supplementRequiredTexts } from '@/services/document-workflow/finalize/rebuildAndRecompute';
import { autoSpecGateRequiredTexts } from '@/services/document-workflow/qualityValidation';

const mockedRequiredTexts = vi.mocked(autoSpecGateRequiredTexts);
const TEMPLATE = { name: '施工组织设计', category: '房建', outputTitle: '', description: '' } as unknown as DocumentTemplate;

const FIVE_CATEGORIES = ['招标文件及补疑补遗', '国家法律法规', '现行规范标准', '地方法规规章', '企业管理体系'];

beforeEach(() => {
  mockedRequiredTexts.mockReset();
  mockedRequiredTexts.mockReturnValue([]);
});

describe('supplementRequiredTexts 编制依据类别段落兜底', () => {
  it('术语缺失+类别全缺：注入五类段落且不注入「编制依据补充说明」单句', () => {
    mockedRequiredTexts.mockReturnValue(['编制依据', '国家法律法规', '地方法规']);
    const result = supplementRequiredTexts('正文内容。', TEMPLATE);
    expect(result).toContain('**编制依据**：本施工组织设计的编制依据按以下类别列出：');
    for (const term of FIVE_CATEGORIES) expect(result).toContain(term);
    expect(result).not.toContain('编制依据补充说明');
  });

  it('仅笼统句（词已命中）：仍注入类别段落到「编制依据」标题下', () => {
    const markdown = '### 1.1 编制依据\n本施工组织设计的编制依据包括国家法律法规、地方法规及现行工程建设标准、规范。';
    const result = supplementRequiredTexts(markdown, TEMPLATE);
    expect(result).toContain('**编制依据**：本施工组织设计的编制依据按以下类别列出：');
    expect(result).toContain('地方法规规章');
    // 注入位置在标题之后、原文笼统句之前
    expect(result.indexOf('**编制依据**')).toBeGreaterThan(result.indexOf('### 1.1 编制依据'));
    expect(result.indexOf('**编制依据**')).toBeLessThan(result.indexOf('本施工组织设计的编制依据包括'));
  });

  it('类别已列出（≥3 类命中）：不重复注入', () => {
    const markdown = '本方案的编制依据类别：招标文件及补疑补遗、国家法律法规、地方法规规章。';
    expect(supplementRequiredTexts(markdown, TEMPLATE)).toBe(markdown);
  });

  it('无关术语缺失（无编制依据字样）：注入正式条目且不带补充说明标题与元话语', () => {
    mockedRequiredTexts.mockReturnValue(['劳动力计划']);
    const result = supplementRequiredTexts('正文内容。', TEMPLATE);
    expect(result).toContain('施工组织设计文件：本工程劳动力计划、主要施工材料与主要施工机械配置计划');
    expect(result).not.toContain('编制依据补充说明');
    expect(result).not.toContain('详见本方案各保障章节');
    expect(result).not.toContain('本施工组织设计的编制依据按以下类别列出');
  });

  it('无「编制依据」标题：回退注入到「编制说明与工程概况」标题下', () => {
    const markdown = '### 1.2 编制说明与工程概况\n本方案的编制依据包括国家法律法规、地方法规及现行规范。';
    const result = supplementRequiredTexts(markdown, TEMPLATE);
    expect(result).toContain('**编制依据**：本施工组织设计的编制依据按以下类别列出：');
    expect(result.indexOf('**编制依据**')).toBeGreaterThan(result.indexOf('### 1.2 编制说明与工程概况'));
  });

  it('无任何锚点标题：五类段落追加到文末', () => {
    mockedRequiredTexts.mockReturnValue(['编制依据']);
    const result = supplementRequiredTexts('正文内容。', TEMPLATE);
    expect(result.trimEnd().endsWith('企业施工工艺标准。')).toBe(true);
    expect(result).toContain('**编制依据**：本施工组织设计的编制依据按以下类别列出：');
  });
});
