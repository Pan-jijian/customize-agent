/**
 * dicNumericFixes2：applyNumericConsistencyDeterministicFixes 聚合器与内部修复器家族边界矩阵（J 组）。
 * 覆盖：fixLaborPeakConflicts（J1-J8/J33-J35）、fixNodeScheduleConflicts（J9-J13/J36-J37）、
 * fixCrossSectionNumericConflicts（J14-J18/J39-J40）、fixSupportSystemConflicts（J19-J21）、
 * fixQuantityAuthorityConflicts（J22-J29）、聚合器组合与截断（J30-J31）。
 * 所有用例均为确定性数值提取/替换判定，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import { applyNumericConsistencyDeterministicFixes, fixSupportSystemConflicts } from '@/services/document-workflow/documentIntegrityChecks';

const fixes = applyNumericConsistencyDeterministicFixes;

describe('dicNumericFixes2 · J 组：数值一致性确定性修复聚合器', () => {
  describe('fixLaborPeakConflicts（经聚合器）', () => {
    it('J1 laborPeakAuthority 替换正文总口径峰值（差异 50% > 30%）', () => {
      const result = fixes('施工高峰期投入总人数100人。', { laborPeakAuthority: 200 });
      expect(result.markdown).toBe('施工高峰期投入总人数200人。');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('100人→200人');
    });

    it('J2 D2 零豁免：差异 20%（160 vs 200）替换', () => {
      const result = fixes('高峰期投入总人数160人。', { laborPeakAuthority: 200 });
      expect(result.markdown).toBe('高峰期投入总人数200人。');
      expect(result.fixedCount).toBe(1);
    });

    it('J3 阶段限定峰值不参与总口径替换（主体结构阶段）', () => {
      const result = fixes('主体结构阶段高峰期投入约100人。', { laborPeakAuthority: 200 });
      expect(result.markdown).toBe('主体结构阶段高峰期投入约100人。');
      expect(result.fixedCount).toBe(0);
    });

    it('J4 工种口径数值不与表峰值比较替换（钢筋工/木工）', () => {
      const result = fixes('高峰期钢筋工60人、木工80人投入施工。', { laborPeakAuthority: 200 });
      expect(result.markdown).toBe('高峰期钢筋工60人、木工80人投入施工。');
      expect(result.fixedCount).toBe(0);
    });

    it('J5 数字后谓语不串染管理组：总人数照常替换、安全员配置数不动', () => {
      const result = fixes('按高峰期总人数100人配置专职安全员2名。', { laborPeakAuthority: 200 });
      expect(result.markdown).toContain('总人数200人');
      expect(result.markdown).toContain('配置专职安全员2名');
      expect(result.fixedCount).toBe(1);
    });

    it('J6 控制上限低于表峰值即不自洽 → 上限改为表峰值（PEAK 阈值 25% 跳过后补替换）', () => {
      const result = fixes('高峰期投入劳动力控制在150人以内。', { laborPeakAuthority: 200 });
      expect(result.markdown).toBe('高峰期投入劳动力控制在200人以内。');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('劳动力控制上限 150人→200人');
    });

    it('J7 表格行内阶段劳动力数值不替换（分阶段明细表合法数据）', () => {
      const result = fixes('| 主体结构阶段 | 高峰期投入约100人 |', { laborPeakAuthority: 200 });
      expect(result.markdown).toBe('| 主体结构阶段 | 高峰期投入约100人 |');
      expect(result.fixedCount).toBe(0);
    });

    it('J8 laborPeakAuthority=0 不作为权威 → 回落 tablePeakLabor 无表即原样', () => {
      const result = fixes('高峰期投入总人数100人。', { laborPeakAuthority: 0 });
      expect(result.markdown).toBe('高峰期投入总人数100人。');
      expect(result.fixedCount).toBe(0);
    });
  });

  describe('fixNodeScheduleConflicts（经聚合器）', () => {
    it('J9 权威表提取：总进度计划表行锁定 230 日，正文 300 日对齐替换', () => {
      const md = '## 总进度计划\n\n| 阶段 | 完成时间 |\n| --- | --- |\n| 主体结构封顶 | 开工后第230日 |\n\n第300日完成主体结构封顶。';
      const result = fixes(md);
      expect(result.markdown).toContain('第230日完成主体结构封顶');
      expect(result.markdown).toContain('开工后第230日 |');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('主体结构封顶');
    });

    it('J10 nodeAuthorities 注入覆盖文档权威表：冲突 ≥5 天时权威表行也纳入对齐', () => {
      const md = '## 总进度计划\n\n| 阶段 | 完成时间 |\n| --- | --- |\n| 主体结构封顶 | 开工后第230日 |\n\n第250日完成主体结构封顶。';
      const result = fixes(md, { nodeAuthorities: [{ node: '主体结构封顶', offset: '开工后第200日' }] });
      expect(result.markdown).toContain('开工后第200日 |');
      expect(result.markdown).toContain('第200日完成主体结构封顶');
      expect(result.markdown).not.toContain('第230日');
      expect(result.markdown).not.toContain('第250日');
      expect(result.fixedCount).toBe(2);
    });

    it('J11 scheduleAuthority 体系缩放：开工后第N日与竣工验收括号形态同步缩放', () => {
      const md = '开工后第365日组织现场验收检查，竣工验收合格（第365日）。';
      const result = fixes(md, { scheduleAuthority: 540 });
      expect(result.markdown).toBe('开工后第540日组织现场验收检查，竣工验收合格（第540日）。');
      // 无权威表时缩放路径早退：fixedCount 恒为 1（缩放是否发生以 markdown 变化为准）
      expect(result.fixedCount).toBe(1);
      expect(result.details.length).toBe(2);
    });

    it('J12 三列进度表链式重算：缩放后开始/持续列与结束列自洽', () => {
      const md = '| 工序 | 开始 | 结束 | 持续 |\n| --- | --- | --- | --- |\n| 土方 | 开工令下发后第1日 | 开工令下发后第30日 | 30日 |\n| 主体 | 开工令下发后第31日 | 开工令下发后第100日 | 70日 |\n开工后第100日竣工验收。';
      const result = fixes(md, { scheduleAuthority: 200 });
      expect(result.markdown).toContain('| 土方 | 开工令下发后第2日 | 开工令下发后第60日 | 59日 |');
      expect(result.markdown).toContain('| 主体 | 开工令下发后第61日 | 开工令下发后第200日 | 140日 |');
      expect(result.markdown).toContain('开工后第200日竣工验收。');
      // 链式重算 detail 追加在缩放 details 之后（allDetails = 缩放 slice(0,8) + 链式重算）
      expect(result.details.join('')).toContain('三列进度表链式重算 2 行');
      expect(result.fixedCount).toBe(1);
    });

    it('J13 systemMax 达 scheduleAuthority×0.9 时不缩放', () => {
      const md = '开工后第90日完成主体结构封顶。';
      const result = fixes(md, { scheduleAuthority: 100 });
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });
  });

  describe('fixCrossSectionNumericConflicts（经聚合器）', () => {
    it('J14 codeAuthorities 标号替换：通用垫层 C20→C25，基础垫层部位语境豁免', () => {
      const md = '垫层混凝土强度等级为C20，基础垫层混凝土强度等级为C15。';
      const result = fixes(md, { codeAuthorities: { cushion: 'C25' } });
      expect(result.markdown).toContain('垫层混凝土强度等级为C25');
      expect(result.markdown).toContain('基础垫层混凝土强度等级为C15');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('C20→C25');
    });

    it('J15 scheduleDays 外部权威：正文两处 210 日历天统一为 540', () => {
      // 「主体结构工期目标」的 210 窗口含部位词「主体结构」会被部位组豁免（与 J39 同机制），
      // 此处用无部位词形态验证两处均归一
      const md = '本项目计划总工期为210日历天，其中里程碑工期目标为210日历天。';
      const result = fixes(md, { scheduleAuthority: 540 });
      expect(result.markdown).toBe('本项目计划总工期为540日历天，其中里程碑工期目标为540日历天。');
      expect(result.fixedCount).toBe(2);
      expect(result.details[0]).toContain('以绑定资料计划工期为准');
    });

    it('J16 prefabRatio 外部权威：装配率 38.4%→30%，独立指标 54.0% 不采不修', () => {
      const md = '本项目装配率为38.4%，内隔墙非砌筑比例达到54.0%。';
      const result = fixes(md, { assemblyRateAuthority: 30 });
      expect(result.markdown).toContain('装配率为30%');
      expect(result.markdown).toContain('比例达到54.0%');
      expect(result.fixedCount).toBe(1);
    });

    it('J17 塔吊多表冲突兜底：取保守台数 min(2,1)=1 统一表格行', () => {
      const md = '| 设备 | 备注 |\n| --- | --- |\n| 塔吊2台 | 主体施工 |\n| 塔吊1台 | 装饰施工 |';
      const result = fixes(md);
      expect(result.markdown).toContain('| 塔吊1台 | 主体施工 |');
      expect(result.markdown).toContain('| 塔吊1台 | 装饰施工 |');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('以表格口径为准');
    });

    it('J18 machineAuthorities 外部权威展开：塔吊 2 台→3 台', () => {
      const result = fixes('施工现场配置塔吊2台。', { machineAuthorities: { towerCrane: 3 } });
      expect(result.markdown).toBe('施工现场配置塔吊3台。');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('以绑定资料锁定口径为准');
    });

    it('J39 xps 部位组正文值豁免：外墙 130mm 与表格 50mm 不比对不修', () => {
      const md = '| 保温材料 | 挤塑聚苯板（XPS）50mm |\n外墙挤塑聚苯板厚度为130mm。';
      const result = fixes(md);
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('J40 xps 表格唯一值权威：无部位语境的正文 130mm→50mm', () => {
      const md = '| 保温材料 | 挤塑聚苯板（XPS）50mm |\n挤塑聚苯板厚度为130mm。';
      const result = fixes(md);
      expect(result.markdown).toContain('挤塑聚苯板厚度为50mm');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('130mm→50mm');
    });
  });

  describe('fixSupportSystemConflicts（直测导出函数）', () => {
    it('J19 authority=slope：删除纯桩族句，坡族句保留', () => {
      const result = fixSupportSystemConflicts('基坑支护采用钻孔灌注桩，桩径800mm。\n边坡采用土钉墙支护。', 'slope');
      expect(result.markdown).not.toContain('钻孔灌注桩');
      expect(result.markdown).toContain('土钉墙');
      expect(result.fixedCount).toBe(1);
    });

    it('J20 authority=slope：混句词级替换桩词为土钉墙（先删机械项后词替换）', () => {
      const result = fixSupportSystemConflicts('边坡支护采用钻孔灌注桩与土钉墙结合体系。', 'slope');
      expect(result.markdown).toContain('土钉墙与土钉墙结合体系');
      expect(result.fixedCount).toBe(1);
    });

    it('J21 authority=pile：混合体系合法，桩族句不动', () => {
      const md = '基坑支护采用钻孔灌注桩，桩径800mm。';
      const result = fixSupportSystemConflicts(md, 'pile');
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });
  });

  describe('fixQuantityAuthorityConflicts（经聚合器）', () => {
    it('J22 基本替换：正文工程量漂移 >2% → 清单汇总值', () => {
      const md = '级配碎石铺设18949.52m²，压实度符合要求。';
      const result = fixes(md, { quantityAuthorities: [{ name: '级配碎石', value: 18000, unit: 'm²' }] });
      expect(result.markdown).toBe('级配碎石铺设18000m²，压实度符合要求。');
      expect(result.fixedCount).toBe(1);
      expect(result.details[0]).toContain('以工程量清单汇总值为准');
    });

    it('J23 D2 零豁免：差异 0.27% 四舍五入口径差同样替换', () => {
      const md = '级配碎石铺设18949.52m²。';
      const result = fixes(md, { quantityAuthorities: [{ name: '级配碎石', value: 19000, unit: 'm²' }] });
      expect(result.markdown).toBe('级配碎石铺设19000m²。');
      expect(result.fixedCount).toBe(1);
    });

    it('J24 名称前 12 字内含村名特征词 → 分村分表合法量不归一', () => {
      const md = '殷郢组段级配碎石铺设18949.52m²。';
      const result = fixes(md, { quantityAuthorities: [{ name: '级配碎石', value: 18000, unit: 'm²' }] });
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('J25 规格限定词后置（DN200）→ 分规格量不归一', () => {
      const md = '钢带PE增强螺旋波纹管DN200铺设2170m。';
      const result = fixes(md, { quantityAuthorities: [{ name: '螺旋波纹管', value: 2000, unit: 'm' }] });
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('J26 句级豁免：同句候选差异全部 >50% 判分部分表量列举句，整句不归一', () => {
      const md = '挖一般土方146.93m³，级配碎石480.5m³，水泥混凝土572.3m³。';
      const result = fixes(md, {
        quantityAuthorities: [
          { name: '挖一般土方', value: 300, unit: 'm³' },
          { name: '级配碎石', value: 1000, unit: 'm³' },
          { name: '水泥混凝土', value: 1200, unit: 'm³' },
        ],
      });
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('J27 句级豁免不触发（大差异 1 条 + 小差异 1 条）→ 两条都按清单归一', () => {
      const md = '拆除路面633m²，级配碎石铺设18949.52m²，压实度符合要求。';
      const result = fixes(md, {
        quantityAuthorities: [
          { name: '拆除路面', value: 2134, unit: 'm²' },
          { name: '级配碎石', value: 18000, unit: 'm²' },
        ],
      });
      expect(result.markdown).toContain('拆除路面2134m²');
      expect(result.markdown).toContain('级配碎石铺设18000m²');
      expect(result.fixedCount).toBe(2);
    });

    it('J28 最长条目名优先：长条目值一致时不改，短条目被 occupied 拦截', () => {
      const md = '塑料管铺设8205.53m。';
      const result = fixes(md, {
        quantityAuthorities: [
          { name: '塑料管铺设', value: 8205.53, unit: 'm' },
          { name: '塑料管', value: 7525.01, unit: 'm' },
        ],
      });
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('J29 表格行内工程量不修（分村分表数据交修复轮）', () => {
      const md = '| 级配碎石 | 18949.52m² |';
      const result = fixes(md, { quantityAuthorities: [{ name: '级配碎石', value: 18000, unit: 'm²' }] });
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });
  });

  describe('聚合器组合与截断', () => {
    it('J30 多修复器顺序执行：劳动力替换 + 支护裁决 fixedCount 加总', () => {
      const md = '施工高峰期投入总人数100人。\n基坑支护采用钻孔灌注桩，桩径800mm。';
      const result = fixes(md, { laborPeakAuthority: 200, supportAuthority: 'slope' });
      expect(result.markdown).toContain('总人数200人');
      expect(result.markdown).not.toContain('钻孔灌注桩');
      expect(result.fixedCount).toBe(2);
      expect(result.details.length).toBe(2);
    });

    it('J31 details 上限截断：13 处替换 fixedCount 全记、details slice(0,12)', () => {
      const entries = Array.from({ length: 13 }, (_, i) => ({ name: `清单条目${String(i + 1).padStart(2, '0')}`, value: 90, unit: 'm²' }));
      const md = Array.from({ length: 13 }, (_, i) => `清单条目${String(i + 1).padStart(2, '0')}铺设100m²。`).join('\n');
      const result = fixes(md, { quantityAuthorities: entries });
      expect(result.markdown).not.toContain('100m²');
      expect(result.markdown).toContain('清单条目01铺设90m²');
      // fixedCount 全记 13，但每个内部修复器的 applySpanReplacements 自身 details 去重后 slice(0,8)，
      // 聚合器外层 slice(0,12) 为再保险 → 实际保留 8 条（实现行为锁定）
      expect(result.fixedCount).toBe(13);
      expect(result.details.length).toBe(8);
    });
  });

  describe('劳动力修复边界补充', () => {
    it('J33 峰值前缀词与数值间超过 20 字窗口 → 不命中不替换', () => {
      const md = '高峰期（考虑赶工叠加与多作业面同时展开的极端情况）投入总人数100人。';
      const result = fixes(md, { laborPeakAuthority: 200 });
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('J34 反向口径 LABOR_COUNT_RE 命中且简称阶段词（主体阶段）不豁免', () => {
      const result = fixes('主体阶段投入劳动力约100人。', { laborPeakAuthority: 200 });
      expect(result.markdown).toBe('主体阶段投入劳动力约200人。');
      expect(result.fixedCount).toBe(1);
    });

    it('J35 控制上限 ≥ 表峰值不动（250 vs 200）', () => {
      const md = '高峰期投入劳动力控制在250人以内。';
      const result = fixes(md, { laborPeakAuthority: 200 });
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });
  });

  describe('节点工期边界补充', () => {
    it('J36 无「开工后」前缀的裸第N日不进体系缩放（systemMax=0）', () => {
      const md = '第300日完成主体结构封顶。';
      const result = fixes(md, { scheduleAuthority: 400, nodeAuthorities: [{ node: '主体结构封顶', offset: '开工后第300日' }] });
      expect(result.markdown).toBe(md);
      expect(result.fixedCount).toBe(0);
    });

    it('J37 nodeAuthorities offset 取首个「第N日」：相对量形态被原样采为权威（锁定实现行为）', () => {
      const md = '第300日完成主体结构封顶。';
      const result = fixes(md, { nodeAuthorities: [{ node: '主体结构封顶', offset: '主体结构封顶后第10日' }] });
      expect(result.markdown).toBe('第10日完成主体结构封顶。');
      expect(result.fixedCount).toBe(1);
    });
  });
});
