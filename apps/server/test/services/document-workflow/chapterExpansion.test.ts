/**
 * chapterExpansion 单测（P0-2 确定性兜底骨架生成器）：buildEvidenceOnlyChapterContent
 * 的章节/证据句子筛选、泛化填充句与投标程序句过滤、图片禁用与空事实降级。
 */
import { describe, expect, it } from 'vitest';
import { buildEvidenceOnlyChapterContent } from '@/services/document-workflow/chapterExpansion';
import type { DocumentEvidence, DocumentTemplateChapter } from '@/services/document-workflow/types';

const CHAPTER: DocumentTemplateChapter = {
  id: 'c1',
  title: '土方开挖工程',
  purpose: '展开土方开挖施工方法',
  queries: ['基坑开挖'],
  requiredFacts: [],
};

function makeEvidence(content: string, extra: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'c1', filePath: '/proj/a.pdf', score: 0, content, ...extra };
}

/** 一段有效正文（>=18 字、无过滤词），切开可验证句子边界 */
const VALID_SENTENCE = '基坑开挖深度约十二米，支护采用钻孔灌注桩加一道钢筋混凝土支撑体系，土方开挖分层分段进行随挖随撑。';

describe('buildEvidenceOnlyChapterContent', () => {
  it('按章节自带 sections 展开为三级标题骨架', () => {
    const content = buildEvidenceOnlyChapterContent({
      chapter: { ...CHAPTER, sections: ['施工准备', '开挖方法'] },
      evidence: [
        makeEvidence(`施工准备阶段应完成测量放线与基坑支护验收，开挖方法采用分层分段开挖并随挖随撑。${VALID_SENTENCE}`),
        makeEvidence(`开挖方法明确土方分层厚度不超过二米，严禁超挖并及时进行边坡喷锚支护。${VALID_SENTENCE}`),
      ],
      targetWords: 2000,
      forbidDrawingImages: false,
    });
    expect(content.startsWith('## 土方开挖工程')).toBe(true);
    expect(content).toContain('### 施工准备');
    expect(content).toContain('### 开挖方法');
    expect(content).toContain('- ');
  });

  it('无 sections 时使用默认三节', () => {
    const content = buildEvidenceOnlyChapterContent({
      chapter: CHAPTER,
      evidence: [makeEvidence(`${VALID_SENTENCE}`)],
      targetWords: 2000,
      forbidDrawingImages: false,
    });
    expect(content).toContain('### 资料依据与施工对象');
    expect(content).toContain('### 主要控制措施');
    expect(content).toContain('### 检查验收与闭环管理');
  });

  it('过短（<18 字）与过长（>180 字）句子被过滤', () => {
    const short = '开挖。';
    const long = `${'基坑开挖分层分段进行随挖随撑严禁超挖。'.repeat(13)}`;
    const content = buildEvidenceOnlyChapterContent({
      chapter: { ...CHAPTER, sections: ['开挖方法'] },
      evidence: [makeEvidence(`${VALID_SENTENCE}${short}${long}`)],
      targetWords: 2000,
      forbidDrawingImages: false,
    });
    expect(content).not.toContain('- 开挖。');
    expect(content).toContain('- 基坑开挖深度约十二米');
  });

  it('报价/单价/后台类句子被过滤', () => {
    const content = buildEvidenceOnlyChapterContent({
      chapter: { ...CHAPTER, sections: ['开挖方法'] },
      evidence: [makeEvidence(`${VALID_SENTENCE}本工程投标报价策略需严格保密，报价测算过程不对外公开。`)],
      targetWords: 2000,
      forbidDrawingImages: false,
    });
    expect(content).not.toContain('报价');
  });

  it('泛化填充句被过滤', () => {
    const filler = '本节围绕土方开挖展开阐述，确保各项措施与本工程实施条件相匹配。';
    const content = buildEvidenceOnlyChapterContent({
      chapter: { ...CHAPTER, sections: ['开挖方法'] },
      evidence: [makeEvidence(`${VALID_SENTENCE}${filler}`)],
      targetWords: 2000,
      forbidDrawingImages: false,
    });
    expect(content).not.toContain('本节围绕');
  });

  it('投标程序句（保证金/开标/评标/编号行）被过滤', () => {
    const content = buildEvidenceOnlyChapterContent({
      chapter: { ...CHAPTER, sections: ['开挖方法'] },
      evidence: [makeEvidence(`${VALID_SENTENCE}投标保证金金额为五十万元整。开标时间另行通知。2.1 评标办法详见招标文件。`)],
      targetWords: 2000,
      forbidDrawingImages: false,
    });
    expect(content).not.toContain('保证金');
    expect(content).not.toContain('开标时间');
  });

  it('短证据（清洗后 <30 字）不参与筛选，全部无效时返回空串', () => {
    expect(buildEvidenceOnlyChapterContent({
      chapter: { ...CHAPTER, sections: ['开挖方法'] },
      evidence: [makeEvidence('只有十几个字。')],
      targetWords: 2000,
      forbidDrawingImages: false,
    })).toBe('');
  });

  it('证据句中的图片行：文件名被证据清洗剥离，行首列表前缀使整行图片正则不命中', () => {
    // 实现事实：cleanEvidenceText 先剥离文件名（drawing.png 被移除），句子以 "- " 前缀输出，
    // removeUnwantedDrawingImages 的 ^!\[ 整行匹配不命中，forbid 与不 forbid 输出一致。
    const evidence = makeEvidence(`${VALID_SENTENCE}![基坑支护设计图](/proj/drawing.png)`);
    const forbidden = buildEvidenceOnlyChapterContent({
      chapter: { ...CHAPTER, sections: ['开挖方法'] },
      evidence: [evidence],
      targetWords: 2000,
      forbidDrawingImages: true,
    });
    const allowed = buildEvidenceOnlyChapterContent({
      chapter: { ...CHAPTER, sections: ['开挖方法'] },
      evidence: [evidence],
      targetWords: 2000,
      forbidDrawingImages: false,
    });
    expect(forbidden).toBe(allowed);
    expect(forbidden).not.toContain('drawing.png');
  });

  it('句子包含关系去重，重复句只保留一次', () => {
    const content = buildEvidenceOnlyChapterContent({
      chapter: { ...CHAPTER, sections: ['开挖方法'] },
      evidence: [makeEvidence(`${VALID_SENTENCE}${VALID_SENTENCE}`)],
      targetWords: 2000,
      forbidDrawingImages: false,
    });
    const occurrences = content.split(VALID_SENTENCE).length - 1;
    expect(occurrences).toBe(1);
  });
});
