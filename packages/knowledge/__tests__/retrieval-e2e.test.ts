import { describe, it, expect, beforeAll } from 'vitest';
import { KnowledgeBaseManager } from '../src/core/knowledge-base-manager.js';
import path from 'node:path';
import os from 'node:os';

describe('End-to-End Retrieval Benchmark', () => {
  let manager: KnowledgeBaseManager;

  beforeAll(async () => {
    const kbDir = path.join(os.tmpdir(), 'customize-agent-e2e-kb-' + Date.now());
    manager = new KnowledgeBaseManager({
      scope: 'project',
      projectRoot: kbDir,
      projectId: 'e2e-test-project'
    });
    
    manager.initialize();
    
    const mockMarkdownDoc = `
# 第一章 项目概况
## 1.1 基本信息
本项目为新建高级住宅区，总建筑面积约 50000 ㎡。
建设单位：中建一局。
监理单位：华南监理咨询公司。

## 1.2 施工要求与材料标准
针对主体结构，要求如下：
| 材料类型 | 强度等级 | 使用部位 |
| --- | --- | --- |
| 混凝土 | C40 | 地下室侧墙 |
| 混凝土 | C30 | 地上主体结构 |
| 钢筋 | HRB400E | 梁柱主筋 |
`;

    await manager.uploadFiles([
      { fileName: '施工方案.md', content: Buffer.from(mockMarkdownDoc) }
    ]);
  }, 120000);

  it('应该在带有 Markdown Table 的复杂层级文档中保持 100% 准确率', async () => {
    const queries = [
      { q: '地上主体结构的混凝土强度是多少？', expect: 'C30' },
      { q: '梁柱主筋应该用什么材料？', expect: 'HRB400E' },
      { q: '建设单位是哪家？', expect: '中建一局' },
    ];

    let hits = 0;
    for (const { q, expect: expectedText } of queries) {
      const result = await manager.hybridSearch(q, { limit: 3 });
      const matched = result.results.some(r => r.content.includes(expectedText));
      if (matched) hits++;
    }

    const accuracy = hits / queries.length;
    console.log(`\n=== 真实 E2E 召回准确率: ${(accuracy * 100).toFixed(2)}% ===\n`);
    
    // 强制门禁
    expect(accuracy).toBeGreaterThanOrEqual(0.9);
  }, 120000); // <--- 设置 120秒超时，等待模型下载完成
});
