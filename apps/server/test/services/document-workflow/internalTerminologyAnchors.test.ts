import { beforeEach, describe, expect, it, vi } from 'vitest';
import { internalTerminologyAnchorIssues, stripInternalTerminologySentences } from '@/services/document-workflow/internalTerminologyAnchors';

// 语义嵌入可控模拟：文本含「已确认资料」（锚点「本项目已确认资料」「根据已确认资料」的原型词）
// 或「应急物资」时返回 [2,0]，其余返回 [0,0]。
// 锚点中只有「本项目已确认资料」「根据已确认资料」含原型词 → [2,0]，命中句与之点积为 4 ≥ 0.62；
// 「应急物资」向量相近但无锚定词，用于验证锚定词前置过滤。
const embedDocumentsMock = vi.hoisted(() => vi.fn<(texts: string[]) => Promise<number[][]>>());

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({
  getLocalSemanticProvider: () => ({ embedDocuments: embedDocumentsMock }),
}));

const HIT_SENTENCE = '依据本项目已确认资料编写章节内容。';

beforeEach(() => {
  embedDocumentsMock.mockReset();
  embedDocumentsMock.mockImplementation(async (texts: string[]) => texts.map(text => ((text.includes('已确认资料') || text.includes('应急物资')) ? [2, 0] : [0, 0])));
});

describe('internalTerminologyAnchorIssues', () => {
  it('L1 精确词命中时输出 blocker 级内部术语问题', async () => {
    const issues = await internalTerminologyAnchorIssues('本工程按工作包组织施工内容。');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      level: 'error',
      severity: 'blocker',
      category: 'format',
      owner: 'system',
      repairability: 'llm_repairable',
    });
    expect(issues[0]!.message).toContain('工作包');
    expect(issues[0]!.suggestion).toContain('按专业工程逐项说明');
  });

  it('L1 多个精确词全部上报（去重后）供一次性定向修复', async () => {
    const issues = await internalTerminologyAnchorIssues('先出现事实卡，再出现工作包与后台数据库，事实卡再次出现。');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('事实卡');
    expect(issues[0]!.message).toContain('工作包');
    expect(issues[0]!.message).toContain('后台数据库');
  });

  it('L1 精确词命中「落位」（真实生成回归：清单项落位元话语泄漏进正文）', async () => {
    const issues = await internalTerminologyAnchorIssues('本专业工程主要清单项落位如下：土方外运及基坑支护工程。');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('落位');
  });

  it('L1 精确词命中「峰值口径」（真实生成回归：数据一致性修复要求写入正文）', async () => {
    const issues = await internalTerminologyAnchorIssues('各阶段劳动力配置与分阶段投入明细表保持一致，不得出现其他峰值口径。');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('峰值口径');
  });

  it('L3 语义锚点命中句子时报内部话术问题', async () => {
    const issues = await internalTerminologyAnchorIssues(HIT_SENTENCE);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('error');
    expect(issues[0]!.message).toContain('语义锚点命中 1 处');
    expect(issues[0]!.message).toContain(HIT_SENTENCE.slice(0, 24));
    expect(issues[0]!.suggestion).toContain('正式表述');
  });

  it('锚定词前置过滤：无锚定词的句子即使向量相近也不参与匹配', async () => {
    // 「应急物资」向量为 [2,0] 与命中句同源，但句中不含任何锚点的锚定词 → 被前置过滤
    const issues = await internalTerminologyAnchorIssues('项目部根据本项目安全风险特点储备应急物资。');
    expect(issues).toHaveLength(0);
  });

  it('含锚定词但语义相似度低于阈值的句子不命中', async () => {
    const issues = await internalTerminologyAnchorIssues('相关要求已确认无误后开始施工。');
    expect(issues).toHaveLength(0);
  });

  it('目录裸标题行不参与语义匹配', async () => {
    // 含「已确认资料」向量为 [2,0]，若未排除目录行会被误报
    const issues = await internalTerminologyAnchorIssues('2.12 已确认资料整理汇总表');
    expect(issues).toHaveLength(0);
  });

  it('标题行与表格行不参与语义匹配', async () => {
    const markdown = '## 依据本项目已确认资料编制说明\n\n| 依据本项目已确认资料编写内容 |\n|------|\n| 是 |';
    const issues = await internalTerminologyAnchorIssues(markdown);
    expect(issues).toHaveLength(0);
  });

  it('命中句子达到 6 处后截断上报', async () => {
    const markdown = Array.from({ length: 7 }, () => '本条依据本项目已确认资料编写。').join('\n');
    const issues = await internalTerminologyAnchorIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('语义锚点命中 6 处');
  });

  it('过短与过长句子不参与匹配', async () => {
    const longSentence = '这是用于验证长度过滤的较长句子，本段内容依据本项目已确认资料进行了编写与校验说明，后续继续补充大量说明文字以满足超过八十个字符的长度限制，从而验证长句被正确跳过不参与语义锚点匹配的逻辑正确性。';
    expect(longSentence.length).toBeGreaterThan(80);
    const issues = await internalTerminologyAnchorIssues(`已确认资料。\n${longSentence}`);
    expect(issues).toHaveLength(0);
  });

  it('空 markdown 返回空数组且不调用嵌入', async () => {
    embedDocumentsMock.mockClear();
    const issues = await internalTerminologyAnchorIssues('');
    expect(issues).toHaveLength(0);
    expect(embedDocumentsMock).not.toHaveBeenCalled();
  });
});

describe('stripInternalTerminologySentences', () => {
  it('删除命中句并保留标题/表格/目录行', async () => {
    const markdown = `# 第一章 总体说明\n\n${HIT_SENTENCE}\n本节正常施工内容继续。\n\n| 参数 | 数值 |\n|------|------|\n| 已确认资料来源 | 招标文件 |\n\n1.1 已确认资料汇总表`;
    const result = await stripInternalTerminologySentences(markdown);
    expect(result).not.toContain(HIT_SENTENCE);
    expect(result).toContain('# 第一章 总体说明');
    expect(result).toContain('本节正常施工内容继续。');
    expect(result).toContain('| 参数 | 数值 |');
    expect(result).toContain('| 已确认资料来源 | 招标文件 |');
    expect(result).toContain('1.1 已确认资料汇总表');
  });

  it('无候选句时原样返回', async () => {
    const markdown = '本节内容正常编写完成。';
    expect(await stripInternalTerminologySentences(markdown)).toBe(markdown);
  });

  it('候选句相似度不足时不删除', async () => {
    const markdown = '相关要求已确认无误后开始施工。';
    expect(await stripInternalTerminologySentences(markdown)).toBe(markdown);
  });

  it('同一行内仅删除命中句保留其他句', async () => {
    const result = await stripInternalTerminologySentences(`${HIT_SENTENCE}正常施工内容继续说明。`);
    expect(result).toBe('正常施工内容继续说明。');
  });

  it('标题/表格/目录行即使包含命中短语也保持不动', async () => {
    const markdown = '## 依据本项目已确认资料编写说明\n\n| 依据本项目已确认资料编写说明 | 保留 |\n|------|------|\n\n1.2 依据本项目已确认资料';
    const result = await stripInternalTerminologySentences(markdown);
    expect(result).toBe(markdown);
  });
});
