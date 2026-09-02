/* reranker worker 线程冒烟：验证 LocalReranker.rerank 走 worker 路径的协议往返与失败回退 */
import { LocalReranker } from '../packages/knowledge/dist/embedding/local-reranker.js';

const t0 = Date.now();
try {
  const scores = await LocalReranker.rerank('施工进度计划关键节点', [
    '施工进度计划应包含关键线路与里程碑节点安排',
    '今天天气晴朗适合出游',
  ]);
  console.log('[smoke] scores:', JSON.stringify(scores), 'elapsed_ms:', Date.now() - t0);
  console.log('[smoke] order_ok:', scores.length === 2 && scores[0] > scores[1]);
} catch (error) {
  console.log('[smoke] rerank failed:', error instanceof Error ? error.message : String(error), 'elapsed_ms:', Date.now() - t0);
}
// worker unref 后进程应能自然退出；兜底强制退出
setTimeout(() => process.exit(0), 2000).unref();
