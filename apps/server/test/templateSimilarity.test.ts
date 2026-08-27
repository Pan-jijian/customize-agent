import { describe, expect, it } from 'vitest';
import {
  classifyTemplateSimilarity,
  sampleGeneratedSentences,
  normalizeReferenceSlices,
  buildTemplateSimilarityReport,
  SIMILARITY_ADAPTED_THRESHOLD,
  SIMILARITY_RISKY_THRESHOLD,
} from '../src/services/document-workflow/templateSimilarity';
import { sampleReferenceTextSlices } from '../src/services/document-workflow/templateReferenceService';

// 注入式嵌入：确定性伪随机单位向量（同文本同向量=点积1，无关文本点积趋近0），模拟真实嵌入空间行为
function pseudoRandomEmbedDocuments(texts: string[]): Promise<number[][]> {
  const cache = new Map<string, number[]>();
  let seed = 42;
  const nextRandom = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed % 1000) / 1000 - 0.5;
  };
  const vectorFor = (text: string) => {
    let vector = cache.get(text);
    if (!vector) {
      vector = Array.from({ length: 64 }, () => nextRandom());
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      vector = vector.map(value => value / norm);
      cache.set(text, vector);
    }
    return vector;
  };
  return Promise.resolve(texts.map(vectorFor));
}

describe('classifyTemplateSimilarity（docx 三档阈值）', () => {
  it('<30% 判独立编制', () => {
    expect(classifyTemplateSimilarity(0.29)).toBe('independent');
  });

  it('30%-60% 判参考改编（含 30% 边界）', () => {
    expect(classifyTemplateSimilarity(SIMILARITY_ADAPTED_THRESHOLD)).toBe('adapted');
    expect(classifyTemplateSimilarity(0.45)).toBe('adapted');
    expect(classifyTemplateSimilarity(0.59)).toBe('adapted');
  });

  it('>60% 判抄袭风险（含 60% 边界）', () => {
    expect(classifyTemplateSimilarity(SIMILARITY_RISKY_THRESHOLD)).toBe('risky');
    expect(classifyTemplateSimilarity(0.99)).toBe('risky');
  });
});

describe('sampleGeneratedSentences（核心句抽样）', () => {
  it('过滤标题/表格行与过短句子', () => {
    const markdown = [
      '## 施工部署',
      '| 名称 | 数值 |',
      '|-----|-----|',
      '本工程基坑开挖深度为7.5米，采用灌注桩加内支撑支护体系，基坑周边设置降水井。',
      '短句。',
    ].join('\n');
    const sampled = sampleGeneratedSentences(markdown);
    expect(sampled).toHaveLength(1);
    expect(sampled[0]).toContain('基坑开挖');
  });

  it('句子数超过目标数时等距抽样且去重', () => {
    const markdown = Array.from({ length: 40 }, (_, index) => `第${index}项措施为加强现场安全巡查，每日检查记录并落实整改闭环。`).join('\n');
    const sampled = sampleGeneratedSentences(markdown, 12);
    expect(sampled.length).toBeLessThanOrEqual(12);
    expect(new Set(sampled).size).toBe(sampled.length);
  });
});

describe('normalizeReferenceSlices（参考切片规范化）', () => {
  it('去空白、限长、过滤短切片、数量封顶', () => {
    const slices = [
      '  基坑  支护  方案  ',
      '短',
      `${'长文本'.repeat(200)}`,
      ...[...Array(60)].map((_, index) => `第${index}个参考切片内容`),
    ];
    const normalized = normalizeReferenceSlices(slices);
    expect(normalized.length).toBeLessThanOrEqual(48);
    for (const slice of normalized) {
      expect(slice.length).toBeGreaterThanOrEqual(20);
      expect(slice.length).toBeLessThanOrEqual(300);
      expect(slice).toBe(slice.trim());
    }
  });
});

describe('buildTemplateSimilarityReport（注入嵌入的三档报告）', () => {
  it('生成文本与参考切片高相似时判抄袭风险', async () => {
    // 两侧均不带句号（生成侧抽样句会剥离句号分隔符，参考侧保留会导致字符串不同）
    const text = '本工程基坑开挖深度为7.5米，采用灌注桩加内支撑支护体系，基坑周边设置降水井，分层开挖';
    const report = await buildTemplateSimilarityReport(text, [text], pseudoRandomEmbedDocuments);
    expect(report).toBeDefined();
    expect(report?.maxSimilarity).toBeGreaterThan(SIMILARITY_RISKY_THRESHOLD);
    expect(report?.level).toBe('risky');
  });

  it('语义无关文本判独立编制', async () => {
    const markdown = '施工质量保证体系涵盖事前控制、事中检查与事后验收三个环节，责任落实到人。';
    const reference = ['招标人办公场所位于市中心区域，周边交通便利，用地性质为商业金融用地。'];
    const report = await buildTemplateSimilarityReport(markdown, reference, pseudoRandomEmbedDocuments);
    expect(report?.level).toBe('independent');
  });

  it('无参考切片或生成文本过短返回 undefined', async () => {
    expect(await buildTemplateSimilarityReport('', [], pseudoRandomEmbedDocuments)).toBeUndefined();
    expect(await buildTemplateSimilarityReport('太短', ['本工程基坑开挖深度为7.5米，采用灌注桩加内支撑支护体系，基坑周边设置降水井。'], pseudoRandomEmbedDocuments)).toBeUndefined();
  });

  it('嵌入失败返回 undefined（降级不阻塞）', async () => {
    const markdown = '本工程基坑开挖深度为7.5米，采用灌注桩加内支撑支护体系，基坑周边设置降水井，分层开挖。';
    const report = await buildTemplateSimilarityReport(markdown, ['参考切片内容足够长以通过长度过滤条件'], async () => Promise.reject(new Error('embedding unavailable')));
    expect(report).toBeUndefined();
  });
});

describe('sampleReferenceTextSlices（参考库入库切片）', () => {
  it('按段落抽代表性切片且限长限量', () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => `第${index}段施工工艺内容：本段落详细描述了施工作业的工艺流程与质量控制要点。`).join('\n\n');
    const slices = sampleReferenceTextSlices(paragraphs);
    expect(slices.length).toBeGreaterThan(0);
    expect(slices.length).toBeLessThanOrEqual(8);
    for (const slice of slices) expect(slice.length).toBeLessThanOrEqual(300);
  });

  it('段落不足时按实际数量返回且去重', () => {
    const slices = sampleReferenceTextSlices('唯一段落：本段落详细描述了施工作业的工艺流程与质量控制要点。');
    expect(slices).toHaveLength(1);
  });
});
