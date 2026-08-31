/**
 * semanticGate 单测（阶段五统一入口）：语义判定 gate 的构建、阈值、负例保护、
 * 词面召回短路与批量顺序保持。本地模型实例经 vi.mock 替换（避免加载 Transformers.js 重依赖），
 * embedDocuments 注入确定性二维向量：正例语境 [1,0] / 负例语境 [0,1]，点积即余弦。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {}
  return { LocalTransformersEmbeddingProvider };
});

import { buildSemanticGate } from './semanticGate';

const POSITIVE_RE = /评标|报价|套话|模糊/u;
const NEGATIVE_RE = /施工|劳动|对称/u;
const embedDocuments = async (texts: string[]) => texts.map(text => {
  const positive = POSITIVE_RE.test(text);
  const negative = NEGATIVE_RE.test(text);
  return [positive && !negative ? 1 : 0, negative ? 1 : (positive ? 0.5 : 0)];
});

const POSITIVE_PROTOTYPES = ['评标纪律与廉洁承诺', '模糊应答表述'];
const NEGATIVE_PROTOTYPES = ['施工质量保证措施', '劳动纪律管理制度'];

async function gate(overrides: Partial<Parameters<typeof buildSemanticGate>[0]> = {}) {
  return buildSemanticGate({ prototypes: POSITIVE_PROTOTYPES, negativePrototypes: NEGATIVE_PROTOTYPES, embedDocuments, ...overrides });
}

describe('buildSemanticGate 语义判定统一入口', () => {
  it('空原型返回恒 false gate（空候选恒零承接，无降级分支）', async () => {
    const judge = await buildSemanticGate({ prototypes: [], embedDocuments });
    await expect(judge(['任意文本'])).resolves.toEqual([false]);
  });

  it('正例语义命中判定 true（与原型点积 ≥ 阈值）', async () => {
    const judge = await gate();
    await expect(judge(['评标委员会成员纪律要求严格'])).resolves.toEqual([true]);
  });

  it('负例保护：施工语境文本判定 false（正例分严格大于负例分才命中）', async () => {
    const judge = await gate();
    await expect(judge(['劳动纪律与班组作业管理制度'])).resolves.toEqual([false]);
  });

  it('阈值边界：相似度低于阈值判定 false', async () => {
    const judge = await buildSemanticGate({ prototypes: POSITIVE_PROTOTYPES, negativePrototypes: NEGATIVE_PROTOTYPES, threshold: 0.9, embedDocuments });
    // 文本不含正例/负例语境词 → 嵌入 [0,0]，与任一原型点积 0（< 0.9 阈值）
    await expect(judge(['关于纪律的表述'])).resolves.toEqual([false]);
  });

  it('lexicalHints 召回短路：未命中词面的文本不进入语义判定', async () => {
    const judge = await buildSemanticGate({
      prototypes: POSITIVE_PROTOTYPES,
      negativePrototypes: NEGATIVE_PROTOTYPES,
      lexicalHints: /评标/u,
      embedDocuments,
    });
    // 语义上属正例（嵌入为 [1,0]）但不含"评标"词面 → 短路 false
    await expect(judge(['报价口径与清单计量'])).resolves.toEqual([false]);
  });

  it('lexicalHints 命中后语义判定生效', async () => {
    const judge = await buildSemanticGate({
      prototypes: POSITIVE_PROTOTYPES,
      negativePrototypes: NEGATIVE_PROTOTYPES,
      lexicalHints: /评标/u,
      embedDocuments,
    });
    await expect(judge(['评标委员会成员纪律要求严格', '普通正文'])).resolves.toEqual([true, false]);
  });

  it('批量判定顺序与输入一致', async () => {
    const judge = await gate();
    const texts = ['评标纪律要求', '施工质量措施', '评标办法分值构成', '班组管理制度'];
    await expect(judge(texts)).resolves.toEqual([true, false, true, false]);
  });

  it('空输入返回空数组', async () => {
    const judge = await gate();
    await expect(judge([])).resolves.toEqual([]);
  });

  it('无负例原型时仅按阈值判定', async () => {
    const judge = await buildSemanticGate({ prototypes: POSITIVE_PROTOTYPES, embedDocuments });
    await expect(judge(['评标纪律要求', '普通文本'])).resolves.toEqual([true, false]);
  });
});
