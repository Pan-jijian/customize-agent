/**
 * dicTailFixersBoundary：documentIntegrityChecks 末尾修复器族与权威提取器边界矩阵（K/L 组）。
 * K 组：fixInternalTerminology / fixAmbiguousEitherOrCandidates / fixForbiddenConfigurationTerms /
 * fixHeaderlessTables / fixTocFromBody / fixHazardIdentificationGaps /
 * fixSelfUnderminingCandidates / stripDuplicateTablesAcrossChapters。
 * L 组：extractScheduleAuthority / extractAssemblyRateAuthority / extractProjectScaleSummary /
 * extractGreeningMaintenanceAuthority / extractStreetLightAuthority / extractSupportSystemAuthority。
 * 全部为确定性短语替换/正则提取判定，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  extractAssemblyRateAuthority, extractGreeningMaintenanceAuthority, extractProjectScaleSummary,
  extractScheduleAuthority, extractStreetLightAuthority, extractSupportSystemAuthority,
  fixAmbiguousEitherOrCandidates, fixForbiddenConfigurationTerms, fixHazardIdentificationGaps,
  fixHeaderlessTables, fixInternalTerminology, fixSelfUnderminingCandidates, fixTocFromBody,
  stripDuplicateTablesAcrossChapters,
} from '@/services/document-workflow/documentIntegrityChecks';
import { factOf, factsOf } from './boundaryKit';

describe('dicTailFixersBoundary · K 组：末尾修复器族', () => {
  describe('K1 fixInternalTerminology 后台术语清洗', () => {
    const terms = [
      { from: '全文统一口径为全文唯一劳动力峰值口径。', to: '全文劳动力峰值基准', detail: '劳动力峰值口径' },
      { from: '全文数值以统一控制口径执行。', to: '统一控制基准', detail: '统一控制口径' },
      { from: '各项数据按以下口径处理。', to: '按以下程序处理', detail: '按以下口径处理' },
      { from: '拆除工程工作包内容如下。', to: '拆除工程内容如下', detail: '拆除工程工作包' },
      { from: '按工作包逐项说明各专业内容。', to: '按专业工程逐项说明', detail: '按工作包逐项说明' },
    ] as const;
    it.each(terms)('K1 短语“$from”归一', (row) => {
      const result = fixInternalTerminology(row.from);
      expect(result.markdown).toContain(row.to);
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain(row.detail);
    });

    it('K1 「管道口径」行业术语不替换（只替换实测锁定短语）', () => {
      const md = '给水管道口径按设计确定，管径DN100。';
      const result = fixInternalTerminology(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K1 多短语多处出现 fixedCount 累计', () => {
      const md = '统一控制口径出现两次。统一控制口径。另按以下口径处理。';
      const result = fixInternalTerminology(md);
      expect(result.fixedCount).toBe(3);
      expect(result.markdown).not.toContain('口径处理');
    });
  });

  describe('K2 fixAmbiguousEitherOrCandidates 两可表述归一', () => {
    const fixes = [
      { from: '支护形式为钢板桩或型钢支撑支护。', to: '钢板桩支护', detail: '钢板桩型钢两可归一' },
      { from: '边坡采用放坡或钢板桩支护。', to: '1:0.5放坡加钢板桩支护', detail: '放坡钢板桩两可归一' },
      { from: '基坑采用放坡或支护。', to: '放坡支护', detail: '放坡支护两可归一' },
    ] as const;
    it.each(fixes)('K2 短语“$from”归一', (row) => {
      const result = fixAmbiguousEitherOrCandidates(row.from);
      expect(result.markdown).toContain(row.to);
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain(row.detail);
    });

    it('K2 无两可短语原样返回', () => {
      const md = '基坑支护采用土钉墙，放坡坡度按设计确定。';
      const result = fixAmbiguousEitherOrCandidates(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K2 多处出现累计替换', () => {
      const md = '甲区放坡或支护，乙区放坡或支护。';
      const result = fixAmbiguousEitherOrCandidates(md);
      expect(result.fixedCount).toBe(2);
      expect(result.markdown).not.toContain('放坡或支护');
    });
  });

  describe('K3 fixForbiddenConfigurationTerms 配置污染清洗', () => {
    it('K3 监管处理短语改写为招标人程序处理', () => {
      const md = '如发现围标串标行为，将报公共资源交易监督管理部门处理。';
      const result = fixForbiddenConfigurationTerms(md);
      expect(result.markdown).toContain('由招标人按招标文件规定程序处理');
      expect(result.fixedCount).toBe(1);
    });

    it('K3 无锁定短语原样返回（无前导「，将」不命中）', () => {
      const md = '本工程材料报验按程序处理。';
      const result = fixForbiddenConfigurationTerms(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });
  });

  describe('K4 fixHeaderlessTables 无表头表格补齐', () => {
    it('K4 正文段后分隔线+数据行 → 补两列表头', () => {
      const md = '材料清单如下：\n| --- | --- |\n| 水泥 | 20吨 |';
      const result = fixHeaderlessTables(md);
      expect(result.markdown).toBe('材料清单如下：\n| 项目 | 内容 |\n| --- | --- |\n| 水泥 | 20吨 |');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('无表头表格补齐表头 1 处');
    });

    it('K4 三列分隔线补「项目 | 内容 | 备注 |」', () => {
      const md = '配置清单：\n| --- | --- | --- |\n| 塔吊 | 2台 | 主体阶段 |';
      const result = fixHeaderlessTables(md);
      expect(result.markdown).toContain('| 项目 | 内容 | 备注 |\n| --- | --- | --- |');
      expect(result.fixedCount).toBe(1);
    });

    it('K4 分隔线上方已有表头行 → 正常表格不补', () => {
      const md = '| 名称 | 数量 |\n| --- | --- |\n| 水泥 | 20吨 |';
      const result = fixHeaderlessTables(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K4 分隔线后无数据行不补', () => {
      const md = '说明文字。\n| --- | --- |\n结束。';
      const result = fixHeaderlessTables(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K4 单列分隔线（列数 <2）不补', () => {
      const md = '单列：\n| --- |\n| 内容 |';
      const result = fixHeaderlessTables(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });
  });

  describe('K5 fixTocFromBody 目录按正文重建', () => {
    it('K5 目录块按正文 H2/H3 实际结构重建（新增小节入目录）', () => {
      const md = '## 目录\n\n第一章 施工总体部署\n  1.1 工程概况\n\n<div class="page-break"></div>\n\n## 第一章 施工总体部署\n\n### 1.1 工程概况\n\n### 1.2 施工准备\n\n## 第二章 施工进度计划\n\n### 2.1 工期安排';
      const result = fixTocFromBody(md);
      expect(result.markdown).toContain('第一章 施工总体部署\n  1.1 工程概况\n  1.2 施工准备\n第二章 施工进度计划\n  2.1 工期安排');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('目录按正文 H2/H3 实际结构重建');
    });

    it('K5 无目录块原样返回', () => {
      const md = '## 第一章 施工总体部署\n\n### 1.1 工程概况';
      const result = fixTocFromBody(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K5 有目录但正文无章标题 → 原样（chapters 空早退）', () => {
      const md = '## 目录\n\n第一章 施工总体部署\n\n<div class="page-break"></div>\n\n正文段落。';
      const result = fixTocFromBody(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K5 正文有章无小节 → 原样（sections 空早退）', () => {
      const md = '## 目录\n\n第一章 施工总体部署\n\n<div class="page-break"></div>\n\n## 第一章 施工总体部署\n\n正文段落。';
      const result = fixTocFromBody(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K5 目录与正文已一致 → fixedCount 0（紧凑形态：目录块末行直紧跟章标题）', () => {
      const md = '## 目录\n\n第一章 施工总体部署\n  1.1 工程概况\n## 第一章 施工总体部署\n\n### 1.1 工程概况';
      const result = fixTocFromBody(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K5 中文章序号（第十一章）不转写阿拉伯数字且小节按章分组', () => {
      const md = '## 目录\n\n第一章 施工总体部署\n  1.1 工程概况\n\n<div class="page-break"></div>\n\n## 第一章 施工总体部署\n\n### 1.1 工程概况\n\n## 第十一章 竣工清理验收移交与保修\n\n### 11.1 保修措施';
      const result = fixTocFromBody(md);
      expect(result.markdown).toContain('第十一章 竣工清理验收移交与保修\n  11.1 保修措施');
      expect(result.fixedCount).toBe(1);
    });
  });

  describe('K6 fixHazardIdentificationGaps 危大遗漏项补写', () => {
    it('K6 适用前提命中且辨识区缺别名 → 在危大标题行后补写', () => {
      const md = '## 危大工程辨识清单\n\n1. 脚手架工程\n2. 起重吊装及安装拆卸工程\n\n基坑开挖深度为5m。';
      const result = fixHazardIdentificationGaps(md);
      expect(result.markdown).toContain('基坑支护与降水工程：基坑开挖深度达到判定线的区段按基坑支护与降水工程辨识');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('基坑支护与降水工程');
    });

    it('K6 无适用前提 → 原样（不制造义务）', () => {
      const md = '## 危大工程辨识清单\n\n1. 脚手架工程\n\n本项目无基坑开挖内容。';
      const result = fixHazardIdentificationGaps(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K6 辨识区别名已覆盖 → 不补写', () => {
      const md = '## 危大工程辨识清单\n\n1. 基坑支护与降水工程\n\n基坑开挖深度为5m。';
      const result = fixHazardIdentificationGaps(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K6 无危大标题 → 回退最后一个含危大正文行后补写', () => {
      const md = '本工程基坑开挖深度为5m，属危大工程管控范围。\n后续段落内容。';
      const result = fixHazardIdentificationGaps(md);
      expect(result.markdown.indexOf('基坑支护与降水工程：')).toBeGreaterThan(0);
      expect(result.markdown.indexOf('基坑支护与降水工程：')).toBeLessThan(result.markdown.indexOf('后续段落内容'));
      expect(result.fixedCount).toBe(1);
    });
  });

  describe('K7 fixSelfUnderminingCandidates 自伤候选改写（18 形态全枚举）', () => {
    const cases = [
      { label: '危大如涉及假设', md: '施工过程中如涉及危险性较大的分部分项工程，未经审批不得实施。', expect: '逐项辨识、分级管控' },
      { label: '踏勘补测负面假设', md: '发现记录存在缺项时在2小时内补测。', expect: '记录经复核确认完整、数据准确后归档保存' },
      { label: '现场条件一致性两可', md: '确保现场条件与施工组织设计的一致性。', expect: '确认现场条件与施工组织设计相符' },
      { label: '不允许分包短板暗示', md: '本工程不允许分包，全部内容自行组织实施。', expect: '严禁违法分包、转包及挂靠行为' },
      { label: '设计图纸不一致负面假设', md: '针对踏勘中发现的与设计图纸不一致或设计未明确的事项，由设计单位书面确认后按以下口径处理。', expect: '项目部对照施工图与现场条件逐项复核' },
      { label: '组价缺失短板暴露', md: '杜绝施工过程中以工程量组价缺失为由提出变更申请。', expect: '开工前完成工程量与清单核对' },
      { label: '危大涉及句式（$1 捕获保留）', md: '涉及危险性较大的分部分项工程，我公司将依据建办质〔2018〕31号，在施工前单独编制专项施工方案并履行审批程序。', expect: '管理执行建办质〔2018〕31号规定' },
      { label: '后续落位延迟承诺', md: '上述参数在后续各分项施工方案中逐项落位执行。', expect: '上述参数作为全文统一控制基准' },
      { label: '补疑修正不再变更（$1 捕获保留）', md: '补疑文件对施工内容作出以下明确修正：基础形式改为筏板基础。上述修正内容已纳入本施工组织设计对应分项方案，施工过程中不再另行变更。', expect: '招标文件补疑明确：基础形式改为筏板基础' },
      { label: '安全人员配备短板暗示', md: '项目部按《建筑施工企业、工程项目安全生产管理机构设置及安全生产管理人员配备办法》（建质规〔2025〕3号）配备专职安全生产管理人员，公司分管安全负责人每月带班检查不得少于两次', expect: '配足配齐' },
      { label: '竣工验收赶工暗示（$1/$2 保留）', md: '项目部在开工令下发后第30日亮化及附属设施安装完成后，随即启动竣工清理与验收移交程序，确保开工令下发后第45日完成全部验收移交工作', expect: '开工令下发后第30日完成，竣工清理与验收移交按计划组织' },
      { label: '隐蔽工程不再重复检验（$1 保留）', md: '隐蔽工程在施工过程中已按24小时提前通知要求完成验收，竣工阶段不再重复检验，但须将全部隐蔽验收影像资料纳入竣工资料归档', expect: '验收合格后方可进入下道工序' },
      { label: '编制边界两可暗示', md: '本施工组织设计的编制边界为：本项目位于合肥市肥西县，以补疑澄清文件对清单及图纸的修正口径为优先执行依据。', expect: '本施工组织设计编制依据包括招标文件、补疑澄清文件' },
      { label: '不包含招标范围以外', md: '施工组织设计覆盖从开工令下发至竣工验收合格后移交保修的全过程管理，不包含招标范围以外的工程内容。', expect: '全过程管理内容与招标范围一致' },
      { label: '不得开放交通负面表述', md: '面层混凝土弯拉强度达到设计强度且填缝完成前不得开放交通，由试验员按每检验批留置试块并送检，强度报告归档闭环。', expect: '达到设计强度且填缝完成后开放交通' },
      { label: '未采用新技术短板自曝', md: '本项目以成熟可靠的常规工艺为主，未采用行业认定的新技术、新材料、新工艺或新设备。', expect: '全部采用经工程实践验证的成熟工艺' },
      { label: '不允许分包否定式自述', md: '本招标项目不允许分包。本工程不进行分包，全部施工内容由我方自行组织完成。', expect: '本招标项目严禁转包和违法分包' },
      { label: '收尾阶段N日历天赶工暗示', md: '收尾阶段安排2个日历天，项目经理组织各分组施工员进行内部预验收，预验收通过后组织竣工验收。', expect: '收尾阶段按总进度计划组织实施' },
    ] as const;
    it.each(cases)('K7 形态“$label”改写', (row) => {
      const result = fixSelfUnderminingCandidates(row.md);
      expect(result.markdown).toContain(row.expect);
      expect(result.fixedCount).toBe(1);
    });

    it('K7 无自伤形态原样返回', () => {
      const md = '施工组织设计内容完整，各项措施均已落实。';
      const result = fixSelfUnderminingCandidates(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('K7 同形态多处出现全替换并累计', () => {
      const md = '施工过程中如涉及危险性较大的分部分项工程，未经审批不得实施。另一章再次说明：施工过程中如涉及危险性较大的分部分项工程，未经审批不得实施。';
      const result = fixSelfUnderminingCandidates(md);
      expect(result.fixedCount).toBe(2);
      expect(result.markdown).not.toContain('施工过程中如涉及');
    });
  });

  describe('K8 stripDuplicateTablesAcrossChapters 跨章重复表删除', () => {
    it('K8 两章同表 → 删后章表、行号映射正确', () => {
      const chapters = [
        { content: '## 一、劳动力计划\n| 阶段 | 人数 |\n| --- | --- |\n| 高峰 | 100人 |\n' },
        { content: '## 二、劳动力计划\n| 阶段 | 人数 |\n| --- | --- |\n| 高峰 | 100人 |\n' },
      ];
      const result = stripDuplicateTablesAcrossChapters(chapters);
      expect(result.removedCount).toBe(3);
      expect(result.chapterFixed).toBe(1);
      expect(chapters[0].content).toContain('| 高峰 | 100人 |');
      expect(chapters[1].content).not.toContain('| 高峰 |');
      expect(chapters[1].content).toContain('## 二、劳动力计划');
    });

    it('K8 无重复表 → removedCount 0', () => {
      const chapters = [
        { content: '## 一、劳动力计划\n| 阶段 | 人数 |\n| --- | --- |\n| 高峰 | 100人 |\n' },
        { content: '## 二、机械计划\n| 设备 | 台数 |\n| --- | --- |\n| 塔吊 | 2台 |\n' },
      ];
      const result = stripDuplicateTablesAcrossChapters(chapters);
      expect(result.removedCount).toBe(0);
      expect(result.chapterFixed).toBe(0);
      expect(chapters[1].content).toContain('| 塔吊 | 2台 |');
    });

    it('K8 首章多行前导内容时行号映射不错位', () => {
      const chapters = [
        { content: '## 一、劳动力计划\n\n本章说明劳动力配置原则，按阶段峰值安排人员进场，高峰期人数与分阶段明细表保持一致。\n\n| 阶段 | 人数 |\n| --- | --- |\n| 高峰 | 100人 |\n' },
        { content: '## 二、劳动力复核\n| 阶段 | 人数 |\n| --- | --- |\n| 高峰 | 100人 |\n' },
      ];
      const result = stripDuplicateTablesAcrossChapters(chapters);
      expect(result.removedCount).toBe(3);
      expect(chapters[0].content).toContain('| 高峰 | 100人 |');
      expect(chapters[1].content).not.toContain('| 高峰 |');
    });
  });
});

describe('dicTailFixersBoundary · L 组：权威提取器', () => {
  describe('L1 extractScheduleAuthority 计划总工期权威', () => {
    it('L1 schedule 事实卡 label 含工期 → 取 N日历天', () => {
      const model = factsOf({ schedule: [factOf({ fieldName: '计划工期', value: '计划工期：2026年3月1日起，210日历天' })] });
      expect(extractScheduleAuthority(model)).toBe(210);
    });

    it('L1 label 不含工期/周期 → 跳过', () => {
      const model = factsOf({ schedule: [factOf({ fieldName: '开工日期', value: '210日历天' })] });
      expect(extractScheduleAuthority(model)).toBeUndefined();
    });

    it('L1 混合口径长句取首个 N日历天', () => {
      const model = factsOf({ schedule: [factOf({ fieldName: '总工期', value: '工期180日历天（主体阶段）与计划工期210日历天' })] });
      expect(extractScheduleAuthority(model)).toBe(180);
    });

    it('L1 canonical.schedule 兜底来源', () => {
      const model = factsOf({ canonical: { schedule: { k1: { label: '总工期', value: '540日历天' } } } as never });
      expect(extractScheduleAuthority(model)).toBe(540);
    });

    it('L1 无工期事实 → undefined', () => {
      expect(extractScheduleAuthority(factsOf({}))).toBeUndefined();
    });
  });

  describe('L2 extractAssemblyRateAuthority 装配率权威', () => {
    it('L2 project 事实卡 fieldId=assembly_rate → 百分比数值', () => {
      const model = factsOf({ project: [factOf({ fieldName: 'assembly_rate', value: '装配率30%' })] });
      expect(extractAssemblyRateAuthority(model)).toBe(30);
    });

    it('L2 tenderRequirements.assemblyRate.text 兜底', () => {
      const model = factsOf({ tenderRequirements: { assemblyRate: { text: '本工程装配率为40%', coreTerms: [] } } as never });
      expect(extractAssemblyRateAuthority(model)).toBe(40);
    });

    it('L2 数值 >100 无效过滤', () => {
      const model = factsOf({ project: [factOf({ key: '装配率', value: '装配率120%' })] });
      expect(extractAssemblyRateAuthority(model)).toBeUndefined();
    });

    it('L2 无装配率事实 → undefined', () => {
      expect(extractAssemblyRateAuthority(factsOf({}))).toBeUndefined();
    });
  });

  describe('L3 extractProjectScaleSummary 工程规模摘要', () => {
    it('L3 面积+地上地下层数完整组合', () => {
      const model = factsOf({
        project: [factOf({ fieldName: '单体建筑面积', value: '建筑面积12000平方米' })],
        drawings: [factOf({ value: '地上18层，地下1层' })],
      });
      expect(extractProjectScaleSummary(model)).toBe('建筑面积12000平方米、地上18层、地下1层');
    });

    it('L3 缺层数只输出面积', () => {
      const model = factsOf({ project: [factOf({ fieldName: '建设规模', value: '总建设规模8000㎡' })] });
      expect(extractProjectScaleSummary(model)).toBe('建筑面积8000平方米');
    });

    it('L3 面积与层数全缺 → undefined', () => {
      expect(extractProjectScaleSummary(factsOf({}))).toBeUndefined();
    });
  });

  describe('L4 extractGreeningMaintenanceAuthority 绿化养护期权威', () => {
    it('L4 bills 清单条目养护两年 → 2', () => {
      const model = factsOf({ bills: [factOf({ value: '喷播植草（灌木）籽：养护期二级养护，养护两年' })] });
      expect(extractGreeningMaintenanceAuthority(model)).toBe(2);
    });

    it('L4 中文数字养护一年 → 1', () => {
      const model = factsOf({ bills: [factOf({ value: '栽植乔木：养护期三级养护，养护一年' })] });
      expect(extractGreeningMaintenanceAuthority(model)).toBe(1);
    });

    it('L4 无养护期事实 → undefined', () => {
      expect(extractGreeningMaintenanceAuthority(factsOf({}))).toBeUndefined();
    });
  });

  describe('L5 extractStreetLightAuthority 路灯数量权威', () => {
    it('L5 billItemFacts 分型号「｜工程量：」段求和（103+15=118）', () => {
      const model = factsOf({
        billItemFacts: [
          factOf({ key: '路灯', value: 'LED路灯｜特征：8m单臂｜工程量：103套' }),
          factOf({ key: '路灯', value: '太阳能路灯｜特征：庭院式｜工程量：15套' }),
        ],
      });
      expect(extractStreetLightAuthority(model)).toBe(118);
    });

    it('L5 特征描述含「套」字不误采（只取工程量段）', () => {
      const model = factsOf({ billItemFacts: [factOf({ key: '路灯', value: '庭院灯｜特征：灯罩套件齐全｜工程量：20套' })] });
      expect(extractStreetLightAuthority(model)).toBe(20);
    });

    it('L5 无路灯事实 → undefined', () => {
      expect(extractStreetLightAuthority(factsOf({}))).toBeUndefined();
    });
  });

  describe('L6 extractSupportSystemAuthority 支护体系权威', () => {
    it('L6 坡喷锚族词 → slope', () => {
      const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护形式为土钉墙+放坡' } } } as never });
      expect(extractSupportSystemAuthority(model)).toBe('slope');
    });

    it('L6 桩族词 → pile', () => {
      const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '基坑支护采用钻孔灌注桩' } } } as never });
      expect(extractSupportSystemAuthority(model)).toBe('pile');
    });

    it('L6 两族词并存（混合体系）→ undefined 不裁决', () => {
      const model = factsOf({ canonical: { byKey: { foundation_support_form: { value: '灌注桩+局部放坡' } } } as never });
      expect(extractSupportSystemAuthority(model)).toBeUndefined();
    });

    it('L6 无支护形式槽位 → undefined', () => {
      expect(extractSupportSystemAuthority(factsOf({}))).toBeUndefined();
    });
  });
});
