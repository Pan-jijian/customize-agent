/**
 * dicFieldAreaBoundary：字段-数值错配/面积算术/基本信息工期字段/闭环密度/编造日期检测器边界矩阵（M 组）。
 * 覆盖：fieldValueMismatchIssues / areaArithmeticIssues / basicInfoScheduleFieldIssues /
 * closurePhraseDensityCapIssues / fabricatedStartDateIssues 补充深挖 / CALENDAR_DATE_RE 格式谱系。
 * 全部为确定性正则提取与数值比较判定，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  areaArithmeticIssues, basicInfoScheduleFieldIssues, CALENDAR_DATE_RE,
  closurePhraseDensityCapIssues, fabricatedStartDateIssues, fieldValueMismatchIssues,
} from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

/** 占地+建筑面积双事实模型构造（fieldName 槽位） */
function scopeModel(site: string, building: string) {
  return factsOf({
    project: [
      factOf({ fieldName: '总占地面积', value: `${site}平方米` }),
      factOf({ fieldName: '单体建筑面积', value: `${building}㎡` }),
    ],
  });
}

describe('dicFieldAreaBoundary · M 组：字段/面积/工期字段检测器', () => {
  describe('M1 fieldValueMismatchIssues 字段-数值错配', () => {
    it('M1 正文单体建筑面积 = 占地面积值且 ≠ 建筑面积值 → 报槽位混淆', () => {
      const model = scopeModel('20000', '15000');
      const issues = fieldValueMismatchIssues('本项目单体建筑面积20000㎡。', model);
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('总占地面积误作');
      expect(issues[0].message).toContain('15000');
    });

    it('M1 正文值同时是建筑面积值（同值双命中）→ 不报', () => {
      const model = scopeModel('20000', '20000');
      expect(fieldValueMismatchIssues('本项目单体建筑面积20000㎡。', model)).toEqual([]);
    });

    it('M1 正文值非占地面积值 → 不报', () => {
      const model = scopeModel('20000', '15000');
      expect(fieldValueMismatchIssues('本项目单体建筑面积15000㎡。', model)).toEqual([]);
    });

    it('M1 无占地面积事实 → 早退', () => {
      const model = factsOf({ project: [factOf({ fieldName: '单体建筑面积', value: '15000㎡' })] });
      expect(fieldValueMismatchIssues('本项目单体建筑面积15000㎡。', model)).toEqual([]);
    });

    it('M1 无建筑面积事实 → 早退', () => {
      const model = factsOf({ project: [factOf({ fieldName: '总占地面积', value: '20000㎡' })] });
      expect(fieldValueMismatchIssues('本项目单体建筑面积20000㎡。', model)).toEqual([]);
    });

    it('M1 「地上建筑面积」label 不入建筑面积口径池（带部位限定词排除）→ 早退', () => {
      const model = factsOf({
        project: [
          factOf({ fieldName: '总占地面积', value: '20000㎡' }),
          factOf({ fieldName: '地上建筑面积', value: '15000㎡' }),
        ],
      });
      expect(fieldValueMismatchIssues('本项目单体建筑面积20000㎡。', model)).toEqual([]);
    });

    it('M1 「总用地面积」label 提取但不入占地筛选口径（/占地面积/ 不含）→ 不报', () => {
      const model = factsOf({
        project: [
          factOf({ fieldName: '总用地面积', value: '20000㎡' }),
          factOf({ fieldName: '单体建筑面积', value: '15000㎡' }),
        ],
      });
      expect(fieldValueMismatchIssues('本项目单体建筑面积20000㎡。', model)).toEqual([]);
    });

    it('M1 千分位数值参与比较', () => {
      const model = scopeModel('20,000', '15,000');
      const issues = fieldValueMismatchIssues('本项目总建筑面积20,000㎡。', model);
      expect(issues.length).toBe(1);
    });

    it('M1 小数数值参与比较', () => {
      const model = scopeModel('20000.5', '15000');
      const issues = fieldValueMismatchIssues('本项目建筑面积20000.5㎡。', model);
      expect(issues.length).toBe(1);
    });

    it('M1 正文「建筑面积」label（无总/单体前缀）同样命中', () => {
      const model = scopeModel('20000', '15000');
      const issues = fieldValueMismatchIssues('本项目建筑面积20000㎡。', model);
      expect(issues.length).toBe(1);
    });

    it('M1 多处错配 slice(0,3) 上限', () => {
      const model = scopeModel('20000', '15000');
      const md = '本项目单体建筑面积20000㎡。本项目总建筑面积20000㎡。本项目建筑面积20000㎡。本项目单体建筑面积20000㎡。';
      expect(fieldValueMismatchIssues(md, model).length).toBe(3);
    });
  });

  describe('M2 areaArithmeticIssues 面积算术一致性', () => {
    it('M2 地上+地下=总 → 自洽不报', () => {
      expect(areaArithmeticIssues('地上建筑面积10000㎡，地下建筑面积5000㎡，单体建筑面积15000㎡。')).toEqual([]);
    });

    it('M2 地上+地下≠总 → 报（差 1000.00㎡）', () => {
      const issues = areaArithmeticIssues('地上建筑面积10000㎡，地下建筑面积5000㎡，单体建筑面积14000㎡。');
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('差 1000.00㎡');
    });

    it('M2 无容差：差 1 即报（999 vs 1000）', () => {
      expect(areaArithmeticIssues('地上600㎡，地下399㎡，总建筑面积1000㎡。').length).toBe(1);
    });

    it('M2 超出容差报：差 2 > 1', () => {
      const issues = areaArithmeticIssues('地上600㎡，地下398㎡，总建筑面积1000㎡。');
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('差 2.00㎡');
    });

    it('M2 大数无容差：总 100000 时差 50 即报', () => {
      expect(areaArithmeticIssues('地上50000㎡，地下49950㎡，总建筑面积100000㎡。').length).toBe(1);
    });

    it('M2 大数容差：差 150 > 100 → 报', () => {
      expect(areaArithmeticIssues('地上50000㎡，地下49850㎡，总建筑面积100000㎡。').length).toBe(1);
    });

    it('M2 反向形态（地下在前）不命中正则 → 不报', () => {
      expect(areaArithmeticIssues('地下建筑面积5000㎡，地上建筑面积10000㎡，单体建筑面积14000㎡。')).toEqual([]);
    });

    it('M2 千分位数值解析后比较', () => {
      const issues = areaArithmeticIssues('地上10,000㎡，地下5,000㎡，单体建筑面积14,000㎡。');
      expect(issues.length).toBe(1);
    });

    it('M2 无总/单体建筑面积锚词 → 不命中不报', () => {
      expect(areaArithmeticIssues('地上10000㎡，地下5000㎡。')).toEqual([]);
    });

    it('M2 同段多组矛盾各自报告', () => {
      const md = '地上10000㎡，地下5000㎡，单体建筑面积14000㎡。另一栋地上2000㎡，地下1000㎡，总建筑面积4000㎡。';
      expect(areaArithmeticIssues(md).length).toBe(2);
    });

    it('M2 小数面积精确求和', () => {
      const issues = areaArithmeticIssues('地上1000.5㎡，地下500.25㎡，总建筑面积1500.75㎡。');
      expect(issues.length).toBe(0);
    });
  });

  describe('M3 basicInfoScheduleFieldIssues 计划工期字段违约词', () => {
    const violationWords = ['工期延误', '延误', '违约', '切除', '赔偿', '罚款', '解除', '扣减'] as const;
    it.each(violationWords)('M3 违约词“$0”入计划工期字段 → 报', (word) => {
      const issues = basicInfoScheduleFieldIssues(`| 计划工期 | 含${word}处理条款 |`);
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('错填违约条款文字');
    });

    it('M3 合法日历天数值不报', () => {
      expect(basicInfoScheduleFieldIssues('| 计划工期 | 210日历天 |')).toEqual([]);
    });

    it('M3 非计划工期字段（同表其他行）不报', () => {
      expect(basicInfoScheduleFieldIssues('| 质量标准 | 工期延误赔偿条款 |')).toEqual([]);
    });

    it('M3 计划工期字段空值不报', () => {
      expect(basicInfoScheduleFieldIssues('| 计划工期 |  |')).toEqual([]);
    });

    it('M3 多处违约行 slice(0,2) 上限', () => {
      const md = '| 计划工期 | 延误处理 |\n| 计划工期 | 违约条款 |\n| 计划工期 | 罚款条款 |';
      expect(basicInfoScheduleFieldIssues(md).length).toBe(2);
    });

    it('M3 行首空白容忍（^\\s*\\|）', () => {
      expect(basicInfoScheduleFieldIssues('   | 计划工期 | 延误处理 |').length).toBe(1);
    });
  });

  describe('M4 closurePhraseDensityCapIssues 闭环句式密度', () => {
    const pad = (md: string) => md + 'x'.repeat(Math.max(0, 3000 - md.length));
    it('M4 文档 <3000 字早退（高密度短文档不报）', () => {
      expect(closurePhraseDensityCapIssues('销项'.repeat(50))).toEqual([]);
    });

    it('M4 密度 8 次 = 2.67 次/千字 <3 → 不报', () => {
      expect(closurePhraseDensityCapIssues(pad('销项'.repeat(8)))).toEqual([]);
    });

    it('M4 密度 9 次 = 3.0 次/千字 → 报', () => {
      const issues = closurePhraseDensityCapIssues(pad('销项'.repeat(9)));
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('销项');
    });

    const closureWords = ['销项', '复查', '整改', '闭环'] as const;
    it.each(closureWords)('M4 词“$0”单独达阈值时 maxWord 判为该词', (word) => {
      const issues = closurePhraseDensityCapIssues(pad(word.repeat(9)));
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain(`“${word}”`);
    });

    it('M4 HTML 标签不计入正文长度（长属性标签整体去除）', () => {
      const md = `<div data-a="${'x'.repeat(2000)}">` + '销项'.repeat(9) + 'x'.repeat(2982);
      expect(closurePhraseDensityCapIssues(md).length).toBe(1);
    });

    it('M4 空白字符不计入正文长度', () => {
      const md = ' '.repeat(2000) + pad('销项'.repeat(9)).replace(/x+$/u, 'x'.repeat(2982));
      expect(closurePhraseDensityCapIssues(md).length).toBe(1);
    });
  });

  describe('M5 fabricatedStartDateIssues 编造日期补充深挖', () => {
    const anchors = ['进度计划', '里程碑', '节点安排', '验收时间', '完成日期', '竣工日期', '移交日期', '合同签订'] as const;
    it.each(anchors)('M5 锚点词“$0”上下文 → 节点日期豁免不报', (anchor) => {
      const model = factsOf({ schedule: [factOf({ value: '竣工日期2026年12月31日' })] });
      const md = `本项目开工日期2026年3月1日，详见${anchor}表。`;
      expect(fabricatedStartDateIssues(md, model)).toEqual([]);
    });

    it('M5 无锚点词的资料外日期 → 报', () => {
      const model = factsOf({ schedule: [factOf({ value: '竣工日期2026年12月31日' })] });
      const issues = fabricatedStartDateIssues('本项目2026年3月1日开工。', model);
      expect(issues.length).toBe(1);
      expect(issues[0].message).toContain('2026年3月1日');
    });

    it('M5 资料无任何日期（hasMaterialDates=false）时锚点词不豁免 → 报', () => {
      const model = factsOf({});
      const md = '本项目开工日期2026年3月1日，详见进度计划表。';
      expect(fabricatedStartDateIssues(md, model).length).toBe(1);
    });

    it('M5 正文日期在资料日期集合内 → 不报', () => {
      const model = factsOf({ project: [factOf({ value: '开工日期2026年3月1日' })] });
      expect(fabricatedStartDateIssues('本项目2026年3月1日开工。', model)).toEqual([]);
    });

    it('M5 资料带空格日期格式与正文同源 → 不报', () => {
      const model = factsOf({ project: [factOf({ value: '开工2026 年 3 月 1 日' })] });
      expect(fabricatedStartDateIssues('本项目2026 年 3 月 1 日开工。', model)).toEqual([]);
    });

    it('M5 多处编造日期 slice(0,3) 上限', () => {
      const md = '2026年3月1日开工。2026年4月2日进场。2026年5月3日封顶。2026年6月4日竣工。';
      expect(fabricatedStartDateIssues(md, factsOf({})).length).toBe(3);
    });
  });

  describe('M6 CALENDAR_DATE_RE 日期格式谱系', () => {
    const datesOf = (md: string): string[] => [...md.matchAll(CALENDAR_DATE_RE)].map(m => `${m[1]}年${m[2]}月${m[3]}日`);

    it('M6 标准格式提取三组', () => {
      expect(datesOf('开工日期2026年3月1日。')).toEqual(['2026年3月1日']);
    });

    it('M6 全空格分隔格式', () => {
      expect(datesOf('开工2026 年 3 月 1 日。')).toEqual(['2026年3月1日']);
    });

    it('M6 单位数月日', () => {
      expect(datesOf('2026年5月9日')).toEqual(['2026年5月9日']);
    });

    it('M6 补零月日', () => {
      expect(datesOf('2026年05月09日')).toEqual(['2026年05月09日']);
    });

    it('M6 两位年份不命中（\\d{4} 要求四位）', () => {
      expect(datesOf('26年3月1日')).toEqual([]);
    });

    it('M6 范围不校验锁定（13月45日仍按格式命中）', () => {
      expect(datesOf('2026年13月45日')).toEqual(['2026年13月45日']);
    });

    it('M6 局部空格混合形态', () => {
      expect(datesOf('2026年3 月1 日')).toEqual(['2026年3月1日']);
    });

    it('M6 多日期全量提取', () => {
      const md = '2026年3月1日开工，2026年12月31日竣工。';
      expect(datesOf(md)).toEqual(['2026年3月1日', '2026年12月31日']);
    });
  });
});
