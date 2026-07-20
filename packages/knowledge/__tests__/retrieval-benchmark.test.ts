import { describe, it, expect, beforeAll } from 'vitest';
import { KnowledgeBaseManager } from '../src/core/knowledge-base-manager.js';
import path from 'node:path';
import os from 'node:os';

// 这里是一个黄金测试集：Query -> Expected Substring
// 以后加的边界 case 全部写进这里，保证召回率不退化
const GOLDEN_DATASET = [
  {
    query: '混凝土抗压强度要求是多少？',
    expected: '抗压强度 C30',
  },
  {
    query: '项目的建设单位是谁？',
    expected: '建设单位：中建一局',
  }
];

describe('Retrieval Benchmark', () => {
  let manager: KnowledgeBaseManager;

  beforeAll(async () => {
    // 初始化一个专门测试用的知识库
    const kbDir = path.join(os.tmpdir(), 'kb-benchmark-test');
    manager = new KnowledgeBaseManager({
      scope: 'project',
      projectRoot: kbDir,
      projectId: 'benchmark-1'
    });
    
    manager.initialize();
    
    // 注入一些干扰项和正确的测试文档
    await manager.uploadFiles([
      { fileName: '施工方案.md', content: Buffer.from('# 第一章 工程概况\n\n建设单位：中建一局。\n\n## 1.1 材料要求\n\n主体结构混凝土抗压强度 C30，抗渗等级 P6。') },
      { fileName: '干扰文档.md', content: Buffer.from('# 第一章 概况\n\n监理单位：未知。\n主体结构钢筋 HRB400。') },
    ]);
  });

  it('应该保证高精度 Recall@5 大于 90%', async () => {
    let hits = 0;
    
    for (const data of GOLDEN_DATASET) {
      const result = await manager.hybridSearch(data.query, { limit: 5 });
      
      // 只要 top 5 结果中有一个内容包含了 expected，就认为命中
      const matched = result.results.some(item => item.content.includes(data.expected));
      if (matched) {
        hits++;
      } else {
        console.warn(`[Miss] Query: ${data.query}\nExpected: ${data.expected}\nTop1: ${result.results[0]?.content}`);
      }
    }
    
    const recall = hits / GOLDEN_DATASET.length;
    console.log(`\n=== Benchmark Recall@5: ${(recall * 100).toFixed(2)}% ===\n`);
    
    // 强制门禁，如果召回率低于预期则 CI 报错
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });
});
