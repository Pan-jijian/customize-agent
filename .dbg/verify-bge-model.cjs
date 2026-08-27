// 验证本地 bge-small-zh-v1.5 语义模型在 node 生产环境下的可用性（临时脚本，不入库）
const { LocalTransformersEmbeddingProvider } = require('/Users/pan/Desktop/codeing/customize-agent/apps/server/node_modules/@customize-agent/knowledge');

(async () => {
  const started = Date.now();
  const provider = new LocalTransformersEmbeddingProvider({});
  const texts = ['工期保证措施', '进度保障措施', '安全生产管理体系', '危大工程管控', '模板工程专项方案'];
  const vectors = await provider.embedDocuments(texts);
  console.log('加载+嵌入耗时:', Date.now() - started, 'ms');
  console.log('向量维度:', vectors.map(v => v.length));
  const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
  console.log('相似(工期保证措施, 进度保障措施) =', dot(vectors[0], vectors[1]).toFixed(4));
  console.log('相似(工期保证措施, 安全生产管理体系) =', dot(vectors[0], vectors[2]).toFixed(4));
  console.log('相似(危大工程管控, 安全生产管理体系) =', dot(vectors[3], vectors[2]).toFixed(4));
  console.log('相似(工期保证措施, 模板工程专项方案) =', dot(vectors[0], vectors[4]).toFixed(4));
  console.log('BGE-SMALL-OK');
})().catch(err => {
  console.error('BGE-SMALL-FAILED:', err.message);
  process.exit(1);
});
