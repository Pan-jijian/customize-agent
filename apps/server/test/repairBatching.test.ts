import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callDocumentLlmJson } from '../src/services/document-workflow/llmClient';

// repairChapterByQuality 是 documentGenerator agent repair 循环的批量化落地：
// 同章多个阻断问题一次 Repairer 调用传入全部 issues，LLM 一次返回多个 patch，依次应用。
// 测试只 mock llmClient 一层（rolePipeline 仅从 llmClient 导入 callDocumentLlmJson）
vi.mock('../src/services/document-workflow/llmClient', () => ({
  callDocumentLlmJson: vi.fn(),
}));

import { repairChapterByQuality } from '../src/services/document-workflow/rolePipeline';
import type { DocumentDraftChapter, DocumentTemplate } from '../src/services/document-workflow/types';

function makeChapter(): DocumentDraftChapter {
  return {
    id: 'ch-1',
    title: '第三章 施工方案',
    content: [
      '## 第三章 施工方案',
      '',
      '### 3.1 施工工艺',
      '',
      '本工程采用整体施工方案。',
      '',
      '### 3.2 质量控制',
      '',
      '质量目标为一次性验收合格。',
      '',
      '### 3.3 安全管理',
      '',
      '建立安全生产责任制。',
    ].join('\n'),
    evidence: [],
    missingFacts: [],
    sections: ['3.1 施工工艺', '3.2 质量控制', '3.3 安全管理'],
  };
}

function makeTemplate(): DocumentTemplate {
  return { id: 'tpl-1', name: '测试模板', description: '', category: 'test', outputTitle: '测试文档', chapters: [] };
}

const ISSUES = ['施工工艺段缺关键参数', '质量目标缺量化指标', '安全管理缺责任人落实'];
const PATCHES = [
  { originalText: '本工程采用整体施工方案。', replacement: '本工程采用分层流水施工方案，计划工期 300 天。', reason: '补参数' },
  { originalText: '质量目标为一次性验收合格。', replacement: '质量目标为一次验收合格率 100%，实施三检制度。', reason: '量化' },
  { originalText: '建立安全生产责任制。', replacement: '建立安全生产责任制，项目经理为第一责任人。', reason: '责任落实' },
];

beforeEach(() => {
  vi.mocked(callDocumentLlmJson).mockReset();
});

afterEach(() => {
  vi.mocked(callDocumentLlmJson).mockReset();
});

describe('repairChapterByQuality 修复批量化（p3-s3）', () => {
  it('同章 3 个阻断问题一次 Repairer 调用传入全部 issues，3 个 patch 依次应用', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({ patches: PATCHES });
    const result = await repairChapterByQuality({ template: makeTemplate(), chapter: makeChapter(), issues: ISSUES, promptTexts: '测试提示词', forbidDrawingImages: false });
    // 批量化核心口径：调用次数 = 1（而非逐 issue 调用 3 次），全部 issues 文本进入同一 prompt
    expect(callDocumentLlmJson).toHaveBeenCalledTimes(1);
    const [, prompt] = vi.mocked(callDocumentLlmJson).mock.calls[0];
    for (const issue of ISSUES) expect(prompt).toContain(issue);
    expect(result.appliedCount).toBe(3);
    expect(result.content).toContain('计划工期 300 天');
    expect(result.content).toContain('一次验收合格率 100%');
    expect(result.content).toContain('项目经理为第一责任人');
  });

  it('部分 patch 定位失败（originalText 不存在）时局部失败隔离，其余 patch 正常应用', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      patches: [PATCHES[0], { originalText: '正文中不存在的片段', replacement: '不应被应用的替换内容', reason: '无定位' }, PATCHES[2]],
    });
    const result = await repairChapterByQuality({ template: makeTemplate(), chapter: makeChapter(), issues: ISSUES, promptTexts: '测试提示词', forbidDrawingImages: false });
    expect(result.appliedCount).toBe(2);
    expect(result.content).toContain('计划工期 300 天');
    expect(result.content).toContain('项目经理为第一责任人');
    expect(result.content).not.toContain('不应被应用的替换内容');
    expect(result.content).toContain('质量目标为一次性验收合格');
  });

  it('replacement 为空或超预算的 patch 被拒绝，不破坏原内容', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({
      patches: [{ originalText: '本工程采用整体施工方案。', replacement: '', reason: '空替换' }, PATCHES[1]],
    });
    const result = await repairChapterByQuality({ template: makeTemplate(), chapter: makeChapter(), issues: ISSUES, promptTexts: '测试提示词', forbidDrawingImages: false });
    expect(result.appliedCount).toBe(1);
    expect(result.content).toContain('一次验收合格率 100%');
    expect(result.content).toContain('本工程采用整体施工方案');
  });

  it('LLM 返回空 patches：零应用返回原内容（批量化空转安全）', async () => {
    vi.mocked(callDocumentLlmJson).mockResolvedValue({ patches: [] });
    const chapter = makeChapter();
    const result = await repairChapterByQuality({ template: makeTemplate(), chapter, issues: ISSUES, promptTexts: '测试提示词', forbidDrawingImages: false });
    expect(result.appliedCount).toBe(0);
    expect(result.content).toBe(chapter.content);
  });
});
