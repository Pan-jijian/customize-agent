/**
 * 技术标准入判据单测（4.55.14）：招标文件内容并非技术标都要写。
 * 两个实锤样本取自巢湖真实自测终稿第二章大纲（该章因这两条「规划块全部失败」）：
 *   · 「业绩证明材料中要求提供：（2）中标查询网址及查询路径披露」
 *   · 「我单位获得中国施工企业管理协会颁发的2022年度…」
 */
import { describe, expect, it } from 'vitest';
import { classifyTenderContent, isCreditScoringContent } from '@/services/document-workflow/technicalBidAdmission';
import { isHardBannedSectionTitle, isQualificationSectionTitle } from '@/services/document-workflow/evidenceContentSafety';

describe('classifyTenderContent（四类非技术内容）', () => {
  it('实锤①：业绩证明材料 + 中标查询网址 → 招标程序类（旧判据被「材料」子串放行）', () => {
    const title = '业绩证明材料中要求提供：（2）中标查询网址及查询路径披露';
    expect(classifyTenderContent(title)).toBe('tender_procedure');
  });

  it('实锤②：我单位获得…协会颁发的获奖情况 → 资信类', () => {
    expect(classifyTenderContent('我单位获得中国施工企业管理协会颁发的2022年度优质工程奖')).toBe('bidder_qualification');
  });

  it('招标程序类（开标/评标/公示/投标递交/电子交易）', () => {
    for (const text of ['开标记录与开标一览表', '评标办法与评标委员会组成', '中标候选人公示渠道', '投标文件递交与解密', '质疑投诉受理渠道', '投标有效期要求']) {
      expect(classifyTenderContent(text)).toBe('tender_procedure');
    }
  });

  it('商务与计价类（报价/单价/暂列/规费税金/保证金保函）', () => {
    for (const text of ['投标报价与报价明细', '综合单价分析', '暂列金额使用说明', '规费税金计取', '履约保证金缴纳']) {
      expect(classifyTenderContent(text)).toBe('commercial');
    }
  });

  it('合同条件类（违约责任/索赔/争议解决/约定格式）', () => {
    for (const text of ['违约责任与违约金', '索赔程序与期限', '争议解决方式', '关于工期的特别约定：', '通用合同条款约定']) {
      expect(classifyTenderContent(text)).toBe('contract_terms');
    }
  });
});

describe('技术评审要点不受影响（零误伤守卫）', () => {
  it('施工技术类内容一律判技术（可入正文）', () => {
    const technical = [
      '主要施工方法与技术措施',
      '深基坑开挖与支护施工工艺',
      '混凝土浇筑与养护措施',
      '材料进场验收与见证取样',
      '施工现场临时用电三级配电两级保护',
      '危险性较大的分部分项工程安全管理',
      '扬尘污染防治与绿色施工措施',
      '劳动力配置计划与高峰期人数安排',
      '施工总平面布置与临时设施',
    ];
    for (const text of technical) {
      expect(classifyTenderContent(text)).toBe('technical');
      expect(isHardBannedSectionTitle(text)).toBe(false);
    }
  });

  it('创优目标（确保/争创杯奖）是技术响应项，非资信加分项', () => {
    expect(classifyTenderContent('确保黄山杯创建目标实现')).toBe('technical');
    expect(classifyTenderContent('争创省优工程与质量目标承诺')).toBe('technical');
    expect(isCreditScoringContent('确保黄山杯')).toBe(false);
  });

  it('证照作为管理对象（技术语境）不误伤——由 isQualificationSectionTitle 宽词表承接', () => {
    for (const text of ['资质证书技术复核', '安全生产许可证管理制度', '营业执照管理措施', '审计报告编制流程']) {
      expect(classifyTenderContent(text)).toBe('technical');
      expect(isQualificationSectionTitle(text)).toBe(false);
    }
  });
});

describe('小节标题黑名单接线（两个实锤必须被拦）', () => {
  it('实锤①②作为小节标题 → 硬黑名单命中', () => {
    expect(isQualificationSectionTitle('业绩证明材料中要求提供：（2）中标查询网址及查询路径披露')).toBe(true);
    expect(isHardBannedSectionTitle('我单位获得中国施工企业管理协会颁发的2022年度优质工程奖')).toBe(true);
  });
});

describe('资信加分项另册（按招标要求响应但限定形态）', () => {
  it('业绩/获奖/认证 → 资信加分项（不得编成施工小节）', () => {
    for (const text of ['类似工程业绩与证明材料', '荣获省优质工程奖情况', '管理体系认证证书', '注册资本与财务状况']) {
      expect(isCreditScoringContent(text)).toBe(true);
      expect(classifyTenderContent(text)).not.toBe('technical');
    }
  });
});
