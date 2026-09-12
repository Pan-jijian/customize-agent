/**
 * 小节命名治理器单测（L1 确定性层 + L2 章级定名轮）：
 * 1. composeBlockTitle——拼接命名最长公共前后缀消除（「装饰装饰装修工程」类粘连怪名根因）；
 * 2. disambiguateBlockTitles——章内重名消解（owner 注入 / 序号兜底）；
 * 3. isDegenerateSectionTitle——退化标题检测单源；
 * 4. governChapterBlockNames——信号门控零调用 / 校验后应用 / 拆半对组内统一改名 / 失败静默回退（LLM mock）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SectionFingerprintPool } from '@/services/document-workflow/sectionFingerprint';
import type * as LlmClientModule from '@/services/document-workflow/llmClient';

vi.mock('@/services/document-workflow/llmClient', async () => {
  const actual = await vi.importActual<typeof LlmClientModule>('@/services/document-workflow/llmClient');
  return { ...actual, callDocumentLlmJson: vi.fn() };
});

import { callDocumentLlmJson } from '@/services/document-workflow/llmClient';
import { composeBlockTitle, disambiguateBlockTitles, governChapterBlockNames, isDegenerateSectionTitle, sectionTitleKey } from '@/services/document-workflow/sectionNamingGovernance';

const llmMock = vi.mocked(callDocumentLlmJson);

describe('composeBlockTitle（拼接命名规范化）', () => {
  it('base 尾与 label 首公共串消除（「装饰」+「装饰装修工程」不再产生「装饰装饰装修工程」）', () => {
    expect(composeBlockTitle('装饰', '装饰装修工程')).toBe('装饰装修工程');
    expect(composeBlockTitle('零星装饰', '装饰装修工程')).toBe('零星装饰装修工程');
  });

  it('无公共串时原样拼接', () => {
    expect(composeBlockTitle('公厕', '结构与基础工程')).toBe('公厕结构与基础工程');
    expect(composeBlockTitle('道路', '室外市政工程')).toBe('道路室外市政工程');
  });

  it('空 base / 空 label 回退另一侧', () => {
    expect(composeBlockTitle('', '装饰装修工程')).toBe('装饰装修工程');
    expect(composeBlockTitle('公厕', '')).toBe('公厕');
    expect(composeBlockTitle('', '')).toBe('');
  });
});

describe('disambiguateBlockTitles（章内重名消解）', () => {
  it('重名组成员统一注入 owner 前缀', () => {
    const result = disambiguateBlockTitles([
      { title: '零星装饰工程', owner: '装饰' },
      { title: '零星装饰工程', owner: '公厕' },
      { title: '零星装饰工程', owner: '泵房' },
      { title: '零星装饰工程', owner: '配电房' },
    ]);
    expect(result).toEqual(['装饰零星装饰工程', '公厕零星装饰工程', '泵房零星装饰工程', '配电房零星装饰工程']);
  });

  it('不重名的标题原样保留（owner 不注入）', () => {
    const result = disambiguateBlockTitles([
      { title: '公厕结构与基础工程', owner: '公厕' },
      { title: '道路室外市政工程', owner: '道路' },
    ]);
    expect(result).toEqual(['公厕结构与基础工程', '道路室外市政工程']);
  });

  it('标题已以 owner 开头时不重复注入', () => {
    const result = disambiguateBlockTitles([
      { title: '装饰零星装饰工程', owner: '装饰' },
      { title: '装饰零星装饰工程', owner: '公厕' },
    ]);
    // 第一项已以 owner「装饰」开头不注入；第二项与第一项撞 → 注入「公厕」
    expect(result).toEqual(['装饰零星装饰工程', '公厕装饰零星装饰工程']);
  });

  it('owner 注入后仍撞（同归属同名工作包）追加中文序号兜底', () => {
    const result = disambiguateBlockTitles([
      { title: '零星装饰工程', owner: '装饰' },
      { title: '零星装饰工程', owner: '装饰' },
    ]);
    expect(result[0]).toBe('装饰零星装饰工程');
    expect(result[1]).toBe('装饰零星装饰工程（二）');
  });

  it('归一化等价（编号/空白差异）也判定为重名，注入前先剥编号', () => {
    const result = disambiguateBlockTitles([
      { title: '2.1 零星装饰工程', owner: '装饰' },
      { title: '零星装饰工程', owner: '公厕' },
    ]);
    expect(result).toEqual(['装饰零星装饰工程', '公厕零星装饰工程']);
  });

  it('owner 缺失时重名组仅序号兜底', () => {
    const result = disambiguateBlockTitles([
      { title: '零星装饰工程' },
      { title: '零星装饰工程' },
    ]);
    expect(result[0]).toBe('零星装饰工程');
    expect(result[1]).toBe('零星装饰工程（二）');
  });
});

describe('isDegenerateSectionTitle（退化标题检测单源）', () => {
  it('整体短单元重复（「装饰装饰」）判退化', () => {
    expect(isDegenerateSectionTitle('装饰装饰')).toBe(true);
    expect(isDegenerateSectionTitle('测量放线测量放线')).toBe(true);
  });

  it('相邻字符重复判退化', () => {
    expect(isDegenerateSectionTitle('护栏栏板安装')).toBe(true);
  });

  it('过短标题判退化', () => {
    expect(isDegenerateSectionTitle('测量')).toBe(true);
    expect(isDegenerateSectionTitle('')).toBe(true);
  });

  it('合法标题不判退化', () => {
    expect(isDegenerateSectionTitle('公厕结构与基础工程')).toBe(false);
    expect(isDegenerateSectionTitle('零星装饰工程')).toBe(false);
    expect(isDegenerateSectionTitle('装饰装修工程')).toBe(false);
  });
});

describe('sectionTitleKey（归一化比对键）', () => {
  it('剥编号/标点/空白', () => {
    expect(sectionTitleKey('2.1 零星装饰工程')).toBe(sectionTitleKey('零星装饰工程'));
    expect(sectionTitleKey('第3章测量放线')).toBe('测量放线');
  });
});

describe('governChapterBlockNames（L2 章级定名轮）', () => {
  const poolWith = (h3: string[]): SectionFingerprintPool => ({
    version: 1,
    entries: [{ documentId: 'doc-old', templateId: 'tpl-1', h3, h4: [], createdAt: '2026-01-01T00:00:00.000Z' }],
  });

  beforeEach(() => {
    llmMock.mockReset();
  });

  it('无信号（无池/无退化）零 LLM 调用且标题原样返回', async () => {
    const result = await governChapterBlockNames({
      chapterTitle: '主体结构工程',
      blocks: [
        { title: '钢筋绑扎施工', pointTitles: ['柱钢筋'] },
        { title: '模板支设施工', pointTitles: ['梁模板'] },
      ],
    });
    expect(result).toEqual({ titles: ['钢筋绑扎施工', '模板支设施工'], renamed: 0, summary: null });
    expect(llmMock).not.toHaveBeenCalled();
  });

  it('池撞名触发改名：经确定性校验（非退化/不撞章内/不撞池）后应用', async () => {
    llmMock.mockResolvedValueOnce({ renames: { 钢筋绑扎施工: '钢筋骨架成型与验收' } });
    const result = await governChapterBlockNames({
      chapterTitle: '主体结构工程',
      blocks: [
        { title: '钢筋绑扎施工', pointTitles: ['柱钢筋'] },
        { title: '模板支设施工', pointTitles: ['梁模板'] },
      ],
      fingerprintPool: poolWith(['钢筋绑扎施工']),
    });
    expect(result.titles).toEqual(['钢筋骨架成型与验收', '模板支设施工']);
    expect(result.renamed).toBe(1);
    expect(result.summary).toContain('改名 1 个');
  });

  it('拆半对共享父标题组内统一改名（只改第一个会破坏写作层相邻同标题合并语义）', async () => {
    llmMock.mockResolvedValueOnce({ renames: { 零星装饰工程: '公共区域饰面修补' } });
    const result = await governChapterBlockNames({
      chapterTitle: '装饰装修工程',
      blocks: [
        { title: '零星装饰工程', pointTitles: [] },
        { title: '零星装饰工程', pointTitles: [] },
        { title: '吊顶饰面安装', pointTitles: [] },
      ],
      fingerprintPool: poolWith(['零星装饰工程']),
    });
    expect(result.titles).toEqual(['公共区域饰面修补', '公共区域饰面修补', '吊顶饰面安装']);
    expect(result.renamed).toBe(1);
  });

  it('新名撞章内其它标题 → 改名整组丢弃（组外标题参与碰撞校验）', async () => {
    llmMock.mockResolvedValueOnce({ renames: { 测量放线测量放线: '室内装饰工程' } });
    const result = await governChapterBlockNames({
      chapterTitle: '装饰装修工程',
      blocks: [
        { title: '测量放线测量放线', pointTitles: [] },
        { title: '室内装饰工程', pointTitles: [] },
      ],
    });
    expect(result.titles).toEqual(['测量放线测量放线', '室内装饰工程']);
    expect(result.renamed).toBe(0);
  });

  it('LLM 越权改未点名标题 → 忽略', async () => {
    llmMock.mockResolvedValueOnce({ renames: { 室内装饰工程: '房间饰面工程' } });
    const result = await governChapterBlockNames({
      chapterTitle: '装饰装修工程',
      blocks: [
        { title: '测量放线测量放线', pointTitles: [] },
        { title: '室内装饰工程', pointTitles: [] },
      ],
    });
    expect(result.titles).toEqual(['测量放线测量放线', '室内装饰工程']);
    expect(result.renamed).toBe(0);
  });

  it('新名带编号前缀 → 归一化剥离后应用', async () => {
    llmMock.mockResolvedValueOnce({ renames: { 钢筋绑扎施工: '2.1 钢筋骨架成型' } });
    const result = await governChapterBlockNames({
      chapterTitle: '主体结构工程',
      blocks: [{ title: '钢筋绑扎施工', pointTitles: [] }],
      fingerprintPool: poolWith(['钢筋绑扎施工']),
    });
    expect(result.titles).toEqual(['钢筋骨架成型']);
    expect(result.renamed).toBe(1);
  });

  it('LLM 调用失败 → 静默回退原命名（不阻断生成）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    llmMock.mockRejectedValueOnce(new Error('LLM 调用超时'));
    const result = await governChapterBlockNames({
      chapterTitle: '测量放线章',
      blocks: [{ title: '测量放线测量放线', pointTitles: [] }],
    });
    expect(result.titles).toEqual(['测量放线测量放线']);
    expect(result.renamed).toBe(0);
    expect(result.summary).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
