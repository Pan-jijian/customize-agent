import { describe, it } from 'vitest';
import { fixScoringRequirementResponses } from '../../../src/services/document-workflow/tenderRequirements';

const similarity = () => 0;

describe('fl6-diag-2', () => {
  it('总价合同条款是否被补写', async () => {
    const model: any = {
      extracted: true,
      awardObjectives: [],
      specialQualityStandards: [],
      awardClauses: [],
      systematicBenchmarks: [],
      frontScheduleClauses: [
        { text: '合同价格形式：总价合同', coreTerms: ['总价合同'], source: '前附表' },
        { text: '分包：不允许', coreTerms: ['分包'], source: '前附表' },
        { text: '预付款支付比例或金额：合同总价（扣除暂列金额）的30%', coreTerms: ['预付款'], source: '前附表' },
      ],
      greenBuildingGrade: undefined,
      smartSiteGrade: undefined,
      assemblyRate: undefined,
    };
    const chapters = [
      { title: '## 工程概况', content: '项目位于肥西县丰乐镇。' },
      { title: '## 确保工期的技术组织措施', content: '工期措施正文。' },
    ];
    const result = await fixScoringRequirementResponses({ chapters, model, similarity });
    console.log('FIXED:', result.fixedCount);
    console.log('DETAILS:', JSON.stringify(result.details));
    console.log('CH1:', chapters[0].content.replace(/\n/g, '\\n').slice(-400));
    console.log('CH2:', chapters[1].content.replace(/\n/g, '\\n').slice(-400));
  });
});
