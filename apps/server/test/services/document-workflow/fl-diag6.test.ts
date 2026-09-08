import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fiveElementBlockStats, FIVE_ELEMENT_SEMANTIC_QUERIES } from '../../../src/services/document-workflow/tenderBidChecks';
import { suggestProjectType } from '../../../src/services/document-workflow/referenceQualityProfile';
import { referenceBenchmarkForType } from '../../../src/services/document-workflow/templateReferenceService';
import { documentTextLength } from '../../../src/services/document-workflow/budget';

// plan/process 词面模拟 bge（生产 bge 对方案/流程类表述余弦更高，词面近似下界）
const embedDocuments = async (texts: string[]) => texts.map(text => {
  const plan = /方案|措施|管理制度|技术措施|专项/u.test(text) ? 1 : 0;
  const process = /工序|流程|步骤|顺序|工艺|先.*后/u.test(text) ? 1 : 0;
  return [plan, process];
});

describe('fl6-diag', () => {
  // 诊断推演测试依赖 /tmp/fl5-md.md 与 /tmp/fl3-md.md 手工放置的诊断文件（零断言、纯 console 推演），
  // 沙箱/CI 环境无此文件，转 skip 防误报（诊断结论已归档于丰乐镇第八轮）
  it.skip('executability root cause', async () => {
    const md = readFileSync('/tmp/fl5-md.md', 'utf8');
    const stats = await fiveElementBlockStats(md, embedDocuments);
    console.log('BLOCKS:', stats.blocks, 'COMPLETE:', stats.completeBlocks, 'CLOSED:', stats.closedLoopBlocks);
    console.log('TEXTLEN:', documentTextLength(md));
    const type = suggestProjectType(md);
    console.log('TYPE:', type);
    const bench = referenceBenchmarkForType(type);
    console.log('BENCHMARK:', bench ? JSON.stringify({ fiveElementCompleteBlocks: bench.profile.fiveElementCompleteBlocks, sourceCount: bench.sourceCount }) : 'undefined');
    const ref = bench?.profile.fiveElementCompleteBlocks;
    const target = Math.max(6, Math.ceil(ref ?? documentTextLength(md) / 1500));
    const density = Math.min(1, stats.completeBlocks / target);
    const rate = stats.blocks ? stats.completeBlocks / stats.blocks : 0;
    console.log('TARGET:', target, 'DENSITY:', density.toFixed(4), 'RATE:', rate.toFixed(4), 'SCORE:', Math.round((density * 0.7 + rate * 0.3) * 100));
    // 对照第三轮
    const md3 = readFileSync('/tmp/fl3-md.md', 'utf8');
    const stats3 = await fiveElementBlockStats(md3, embedDocuments);
    const type3 = suggestProjectType(md3);
    const bench3 = referenceBenchmarkForType(type3);
    const ref3 = bench3?.profile.fiveElementCompleteBlocks;
    const effectiveRef3 = ref3 && ref3 > 0 ? ref3 : undefined;
    const target3 = Math.max(6, Math.ceil(effectiveRef3 ?? documentTextLength(md3) / 1500));
    const density3 = Math.min(1, stats3.completeBlocks / target3);
    const rate3 = stats3.blocks ? stats3.completeBlocks / stats3.blocks : 0;
    console.log('R3 BLOCKS:', stats3.blocks, 'COMPLETE:', stats3.completeBlocks, 'TYPE3:', type3, 'REF3:', ref3, 'TARGET3:', target3, 'SCORE3:', Math.round((density3 * 0.7 + rate3 * 0.3) * 100));
    console.log('QUERIES:', Object.values(FIVE_ELEMENT_SEMANTIC_QUERIES).join(' | '));
  });
});
