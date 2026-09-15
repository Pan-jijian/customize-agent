/**
 * 标书编制规格（BidCompositionSpec）真实数据验证（.manual.ts 显式运行）：
 * 1) 舒城招标文件 kb 全量直读（readProjectKbChunkTextsByHints 定向短语，生产同源通道）
 * 2) extractBidCompositionSpec 判定：暗标/正文禁表/6 附表/格式要求/身份禁语
 * 3) 冲突裁决与写作约束渲染核验
 *
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/bid-composition.manual.ts
 */
import { describe, expect, it } from 'vitest';
import { readProjectKbChunkTextsByHints } from '@/services/knowledge/kbService';
import { bidCompositionSummary, bidCompositionWritingRules, extractBidCompositionSpec } from '@/services/document-workflow/bidComposition';

const PROJECT_ROOT = '/Users/pan/Desktop/codeing/customize-agent';

describe('标书编制规格识别（舒城暗标真实数据）', () => {
  it('识别暗标/正文禁表/6 附表/格式要求，冲突裁决正确', () => {
    const texts = readProjectKbChunkTextsByHints(
      PROJECT_ROOT,
      ['暗标', '明标', '装订线', '可附下列图表', '不得有图片', '总页数上限', '单黑色'],
      { limit: 200 },
    );
    console.log('定向命中切片数:', texts.length, '总字符:', texts.join('\n').length);
    const spec = extractBidCompositionSpec({
      tenderTexts: texts,
      requiredTables: ['项目基本信息表', '劳动力计划表', '质量关键节点控制表'],
    });
    console.log('bidType =', spec.bidType);
    console.log('bodyTablePolicy =', spec.bodyTablePolicy);
    console.log('bodyFigurePolicy =', spec.bodyFigurePolicy);
    console.log('appendixPlan =');
    for (const item of spec.appendixPlan) console.log('  ', item.no, '|', item.title, '|', item.kind, '|', item.dataSource);
    console.log('formatRules =', JSON.stringify(spec.formatRules));
    console.log('identityMarksForbidden =', spec.identityMarksForbidden);
    console.log('conflicts =');
    for (const conflict of spec.conflicts) console.log('  ', conflict.rule, '→', conflict.resolution);
    const summary = bidCompositionSummary(spec);
    console.log('\n=== summary:', summary.status, '===\n', summary.message, '\n', summary.details.join('\n'));
    console.log('\n=== writing rules ===\n', bidCompositionWritingRules(spec));

    expect(spec.bidType).toBe('blind');
    expect(spec.bodyTablePolicy).toBe('forbidden');
    expect(spec.bodyFigurePolicy).toBe('forbidden');
    expect(spec.appendixPlan.length).toBe(6);
    expect(spec.appendixPlan.filter(item => item.kind === 'figure').length).toBe(2);
    expect(spec.appendixPlan.find(item => item.dataSource === 'blueprint.equipment')).toBeTruthy();
    expect(spec.appendixPlan.find(item => item.dataSource === 'blueprint.labor')).toBeTruthy();
    expect(spec.formatRules.pageLimit).toBe(200);
    expect(spec.formatRules.cover).toBe('forbidden');
    expect(spec.identityMarksForbidden).toBe(true);
    expect(spec.conflicts.length).toBe(3);
    expect(spec.conflicts.find(item => item.resolution.includes('收敛入文末'))).toBeTruthy();
  });
});
