/**
 * professionalDepthClassifier 单测：专业深度语义分类器（六维覆盖/五类内容要求/具体性/闭环判定）。
 * 本地语义模型 mock 为「语义桶 one-hot 向量」：每个桶对应一个锚点原型前缀（正文复述原型即命中该桶），
 * dot = 共同桶数（≥1 即相似度 ≥0.6 阈值），判定结果确定可控。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedMock = vi.hoisted(() => vi.fn<(texts: string[]) => Promise<number[][]>>());

vi.mock('./semanticSimilarity', () => ({
  SEMANTIC_COVERAGE_THRESHOLD: 0.6,
  getLocalSemanticProvider: () => ({ embedDocuments: embedMock }),
}));

import { buildProfessionalDepthClassifier } from './professionalDepthClassifier';

/** 语义桶：桶前缀（锚点原型 6 字符）→ 桶下标 */
const BUCKETS: Array<[string, number]> = [
  ['本章关键数据以招', 0], // factuality
  ['内容按施工准备、', 1], // structure
  ['包含关键工序控制', 2], // depth
  ['明确责任主体、检', 3], // executable
  ['结合本项目建设', 4], // specificity
  ['章节间工期、质量', 5], // consistency
  ['采用关键线路法编', 6], // schedule
  ['材料进场验收与复', 7], // quality
  ['风险源辨识、临电', 8], // safety
  ['劳动力、材料、设', 9], // resource
  ['施工准备、工艺流', 10], // construction
  ['检验批划分、技术', 11], // concrete
  ['自检互检交接检、', 12], // closedLoop
];

function bucketVector(text: string): number[] {
  const vector = new Array(BUCKETS.length).fill(0);
  for (const [prefix, bucket] of BUCKETS) {
    if (text.includes(prefix)) vector[bucket] = 1;
  }
  return vector;
}

beforeEach(() => {
  embedMock.mockReset();
  embedMock.mockImplementation(async texts => texts.map(bucketVector));
});

describe('buildProfessionalDepthClassifier 构建', () => {
  it('预嵌入全部锚点组（6 维 + 5 类 + concrete + closedLoop 共 13 组）', async () => {
    await buildProfessionalDepthClassifier();
    expect(embedMock).toHaveBeenCalledTimes(13);
    // 每组锚点向量数量与锚点文本数量一致
    for (const call of embedMock.mock.calls) {
      expect(call[0].length).toBeGreaterThan(0);
    }
  });

  it('锚点嵌入数量不一致时抛出缺陷（不静默降级）', async () => {
    embedMock.mockImplementation(async texts => texts.slice(0, -1).map(bucketVector));
    await expect(buildProfessionalDepthClassifier()).rejects.toThrow('锚点嵌入数量不一致');
  });
});

describe('analyze 输入边界', () => {
  it('空文本返回 undefined（调用方跳过，不用全 false 替身）', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    expect(await classifier.analyze('')).toBeUndefined();
  });

  it('纯空白文本返回 undefined', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    expect(await classifier.analyze('  \n\t  ')).toBeUndefined();
  });

  it('无可判定语义的普通文本 → 全维度 false 且结构完整', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    const analysis = await classifier.analyze('这是一段完全没有专业内容的普通文字段落。');
    expect(analysis).toBeDefined();
    expect(Object.values(analysis!.dimensions).every(value => value === false)).toBe(true);
    expect(Object.values(analysis!.contentNeeds).every(value => value === false)).toBe(true);
    expect(analysis!.concrete).toBe(false);
    expect(analysis!.closedLoop).toBe(false);
  });
});

describe('analyze 语义判定', () => {
  it('复述事实性锚点原型 → factuality 覆盖且其他维度不受影响', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    const analysis = await classifier.analyze('本章关键数据以招标文件、工程量清单与施工图纸为依据。');
    expect(analysis!.dimensions.factuality).toBe(true);
    expect(analysis!.dimensions.structure).toBe(false);
    expect(analysis!.dimensions.depth).toBe(false);
  });

  it('复述进度类内容要求原型 → contentNeeds.schedule 覆盖', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    const analysis = await classifier.analyze('采用关键线路法编制进度计划，明确关键节点与动态纠偏措施。');
    expect(analysis!.contentNeeds.schedule).toBe(true);
    expect(analysis!.contentNeeds.quality).toBe(false);
  });

  it('复述闭环锚点原型 → closedLoop 覆盖', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    const analysis = await classifier.analyze('自检互检交接检、整改复查、资料归档。');
    expect(analysis!.closedLoop).toBe(true);
    expect(analysis!.concrete).toBe(false);
  });

  it('复述具体性锚点原型 → concrete 覆盖', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    const analysis = await classifier.analyze('检验批划分、技术交底、整改复查闭环。');
    expect(analysis!.concrete).toBe(true);
  });

  it('混合正文同时覆盖多桶 → 多维度同时命中', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    const analysis = await classifier.analyze('采用关键线路法编制进度计划；自检互检交接检、整改复查、资料归档。');
    expect(analysis!.contentNeeds.schedule).toBe(true);
    expect(analysis!.closedLoop).toBe(true);
  });
});

describe('analyze 分块与缓存', () => {
  it('相同文本重复分析复用块向量缓存（不重复嵌入）', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    const text = '本章关键数据以招标文件、工程量清单与施工图纸为依据。';
    const anchorCalls = embedMock.mock.calls.length;
    await classifier.analyze(text);
    const afterFirst = embedMock.mock.calls.length;
    expect(afterFirst).toBe(anchorCalls + 1);
    await classifier.analyze(text);
    expect(embedMock.mock.calls.length).toBe(afterFirst); // 缓存命中不新增嵌入
  });

  it('超长正文分块均匀采样至 20 块上限（首中尾覆盖）', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    // 100 段 × ~90 字 → 每块聚合约 4 段（≤400 字）→ 25 块 → 采样 20 块
    const unit = '第N段施工准备与工艺流程控制要点描述，本段内容用于验证长正文分块均匀采样逻辑。';
    const paragraphs = Array.from({ length: 100 }, (_, index) => unit.repeat(2).replace('第N段', `第${index}段`));
    const analysis = await classifier.analyze(paragraphs.join('\n'));
    expect(analysis).toBeDefined();
    const lastCall = embedMock.mock.calls.at(-1)!;
    expect(lastCall[0].length).toBe(20);
  });

  it('块数不超过 20 时不采样（全量嵌入）', async () => {
    const classifier = await buildProfessionalDepthClassifier();
    const paragraphs = Array.from({ length: 10 }, (_, index) => `第${index}段施工准备与工艺流程控制要点描述，本段内容用于验证正常分块。`);
    const analysis = await classifier.analyze(paragraphs.join('\n'));
    expect(analysis).toBeDefined();
    const lastCall = embedMock.mock.calls.at(-1)!;
    expect(lastCall[0].length).toBe(1); // 10 段 × <40 字 → 单块
  });
});
