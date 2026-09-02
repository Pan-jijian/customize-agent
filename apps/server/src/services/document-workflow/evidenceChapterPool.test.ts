import { describe, expect, it } from 'vitest';
import type { DocumentEvidence, DocumentTemplateChapter } from './types';
import { buildChapterEvidencePool, buildEvidenceBundle, evidenceBundlePrompt } from './evidence';

function evidenceItem(overrides: Partial<DocumentEvidence> = {}): DocumentEvidence {
  return { chapterId: 'ch-1', filePath: '招标文件.pdf', score: 0.9, content: '项目名称：合肥市某区安置房项目。', ...overrides };
}

function chapterOf(overrides: Partial<DocumentTemplateChapter> = {}): DocumentTemplateChapter {
  return { id: 'ch-1', title: '施工组织', purpose: '', queries: [], requiredFacts: [], ...overrides };
}

function bundleOf(evidence: DocumentEvidence[]) {
  return buildEvidenceBundle(chapterOf(), evidence);
}

const poolEvidence: DocumentEvidence[] = [
  evidenceItem({ content: '计划工期：总工期 540 日历天，质量标准：合格。' }),
  evidenceItem({ filePath: '工程量清单.pdf', score: 0.8, content: '混凝土 C30 总量 8200 立方米，钢筋 HRB400 总量 960 吨。' }),
  evidenceItem({ filePath: '施工方案.pdf', score: 0.7, content: '塔吊基础采用桩基承台，塔吊 QTZ80 布置于主楼北侧。' }),
];

describe('buildChapterEvidencePool（A1 章级证据池）', () => {
  it('包含 T0 关键事实层（数值参数全量零丢失）', () => {
    const text = buildChapterEvidencePool(bundleOf(poolEvidence), [], 8000);
    expect(text).toContain('关键事实层');
    expect(text).toContain('540');
    expect(text).toContain('8200');
    expect(text).toContain('QTZ80');
  });

  it('包含章级证据摘要池与目录索引', () => {
    const text = buildChapterEvidencePool(bundleOf(poolEvidence), [], 8000);
    expect(text).toContain('章级证据摘要池');
  });

  it('总输出不超过池预算（含少量结构化头开销）', () => {
    const text = buildChapterEvidencePool(bundleOf(poolEvidence), [], 4000);
    expect(text.length).toBeLessThanOrEqual(4200);
  });

  it('空证据池返回空串', () => {
    expect(buildChapterEvidencePool(bundleOf([]), [], 8000)).toBe('');
  });
});

describe('evidenceBundlePrompt onlyRankBoosted（A2 块级增量压缩）', () => {
  const blockEvidence: DocumentEvidence[] = [
    evidenceItem({ content: '塔吊 QTZ80 共 2 台，臂长 55 米。' }),
    evidenceItem({ filePath: '质量要求.pdf', content: '墙体砌筑砂浆饱满度不得低于 80%。' }),
  ];

  it('只选取块相关命中（rankBoost>0）的片段', () => {
    const prompt = evidenceBundlePrompt(bundleOf(blockEvidence), {
      maxChars: 3000,
      requiredFacts: [],
      skipT0: true,
      rankBoost: (item: DocumentEvidence) => (item.content.includes('塔吊') ? 6 : 0),
      onlyRankBoosted: true,
    });
    expect(prompt).toContain('塔吊');
    expect(prompt).not.toContain('砂浆饱满度');
  });

  it('块相关命中为空时回退全量选取（不牺牲事实安全）', () => {
    const prompt = evidenceBundlePrompt(bundleOf(blockEvidence), {
      maxChars: 3000,
      requiredFacts: [],
      skipT0: true,
      rankBoost: () => 0,
      onlyRankBoosted: true,
    });
    expect(prompt).toContain('塔吊');
    expect(prompt).toContain('砂浆饱满度');
  });

  it('未开启 onlyRankBoosted 时行为与全量选取一致', () => {
    const prompt = evidenceBundlePrompt(bundleOf(blockEvidence), {
      maxChars: 3000,
      requiredFacts: [],
      skipT0: true,
      rankBoost: (item: DocumentEvidence) => (item.content.includes('塔吊') ? 6 : 0),
    });
    expect(prompt).toContain('塔吊');
    expect(prompt).toContain('砂浆饱满度');
  });
});
