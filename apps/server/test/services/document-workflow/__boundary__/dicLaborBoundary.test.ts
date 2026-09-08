/**
 * 第十二批边界矩阵（N 组）：laborPeakConflictIssues + resourceConsistencyIssues 七模式深挖。
 * 覆盖：提取池三正则/箭头链/分组口径/阶段判定（N1）、模式1 正文峰值互查（N2）、
 * 模式2 多表峰值（N3）、模式3 正文 vs 表峰值（N4）、模式4 合计行（N5）、
 * 模式5 总工日推算（N6）、模式6 控制上限（N7）、模式7 班组加总（N8）、
 * laborPeakConflictIssues 众数互查（N9）、fixLaborPeakConflict 确定性修复（N10）、
 * 表格峰值导出函数（N11）、历史缺陷回归形态（N12）。
 */
import { describe, expect, it } from 'vitest';
import {
  fixLaborPeakConflict,
  laborPeakConflictIssues,
  resourceConsistencyIssues,
  tablePeakLabor,
  tablePeakLaborWithChainFallback,
} from '@/services/document-workflow/documentIntegrityChecks';

const res = (md: string) => resourceConsistencyIssues(md);

/** 标准分阶段峰值表（hasPeakCol）：header 含「高峰」+人数词 */
function peakTable(rows: Array<[string, string]>): string {
  const lines = ['| 施工阶段 | 阶段高峰人数 |', '| --- | --- |'];
  for (const [stage, count] of rows) lines.push(`| ${stage} | ${count} |`);
  return lines.join('\n');
}

/** 分工种人数表（hasTradeCol） */
function tradeTable(rows: Array<[string, string]>): string {
  const lines = ['| 工种 | 人数 |', '| --- | --- |'];
  for (const [trade, count] of rows) lines.push(`| ${trade} | ${count} |`);
  return lines.join('\n');
}

describe('N1 提取池：三正则/箭头链/分组口径/阶段判定', () => {
  it('N1-1 管理口径与总峰值互不干扰：管理人员18 vs 高峰期286 不互斥', () => {
    expect(res('高峰期管理人员18人，高峰期286人')).toHaveLength(0);
  });
  it('N1-2 工种口径隔离：钢筋工60 vs 木工80 不同工种不互斥', () => {
    expect(res('高峰期钢筋工60人，高峰期木工80人')).toHaveLength(0);
  });
  it('N1-3 同工种互查：钢筋工60 vs 钢筋工150 报互斥', () => {
    const issues = res('高峰期钢筋工60人，高峰期钢筋工150人');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('钢筋工');
  });
  it('N1-4 工种口径不与总峰值互查：钢筋工60 vs 高峰期286 不互斥', () => {
    expect(res('高峰期钢筋工60人，高峰期286人')).toHaveLength(0);
  });
  it('N1-5 分组只判数字前窗口：总人数20人后接「安全员」不误划管理组，与86互查报出', () => {
    const issues = res('按高峰期总人数20人配置专职安全员2名。高峰期86人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('20');
  });
  it('N1-6 分隔符截断分组窗口：工种列举不串染后续总峰值', () => {
    expect(res('主体结构阶段投入钢筋工60人、木工80人，高峰人数约220人')).toHaveLength(0);
  });
  it('N1-7 箭头链峰值入池：链上最大值86与独立总峰值20互查报出', () => {
    const issues = res('劳动力按32人→86人→48人分阶段投入。高峰期20人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('86');
  });
  it('N1-8 链内低峰阶段值不独立入池：单链多值自身不互斥', () => {
    expect(res('劳动力按32人→86人→48人分阶段投入')).toHaveLength(0);
  });
  it('N1-9 多链同行：两条无阶段链峰值86与50互查报出（链起点去重不吞链）', () => {
    const issues = res('劳动力按32人→86人→48人，劳动力按20人→50人→30人');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('86');
    expect(issues[0].message).toContain('50');
  });
  it('N1-10 多链同行阶段链隔离：阶段限定链峰值不与总口径链互斥', () => {
    expect(res('劳动力按32人→86人→48人分阶段投入，装饰装修阶段20人→50人→30人')).toHaveLength(0);
  });
  it('N1-11 STAGE 模式自带阶段限定：同自造阶段短语互查报出', () => {
    const issues = res('管网及附属设施施工阶段35人。管网及附属设施施工阶段65人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('65');
  });
  it('N1-12 STAGE 模式不同自造阶段不互斥（词表外阶段词独立隔离）', () => {
    expect(res('道路基层施工阶段35人。绿化栽植施工阶段65人。')).toHaveLength(0);
  });
  it('N1-13 跨列举分隔符继承阶段词：汇总峰值180与同阶段90互查报出', () => {
    const issues = res('地下结构阶段投入钢筋工60人、木工80人、混凝土工40人、架子工20人，高峰人数约180人。地下结构阶段高峰90人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('180');
  });
  it('N1-13b 词表阶段与STAGE后缀形态字符串不等：180(词表)与90(STAGE)互查跳过', () => {
    const issues = res('地下结构阶段投入钢筋工60人、木工80人、混凝土工40人、架子工20人，高峰人数约180人。地下结构阶段90人。');
    expect(issues).toHaveLength(0);
  });
  it('N1-14 前段已绑定峰值口径则不继承阶段：86以总口径与150互查报出', () => {
    const issues = res('管网阶段高峰35人，高峰人数86人。室外工程阶段150人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('86');
  });
  it('N1-15 词表缩写不算阶段限定：「主体阶段」不产生词表stage，与地下结构150互查报出', () => {
    const issues = res('主体阶段高峰86人。地下结构阶段150人。');
    expect(issues).toHaveLength(1);
  });
  it('N1-16 词表长词优先：「基坑与基础阶段220人」不误标为「基础」与基础阶段90互斥', () => {
    expect(res('基坑与基础阶段220人。基础阶段90人。')).toHaveLength(0);
  });
  it('N1-17 表格行豁免：工种表人数不入正文互查池', () => {
    const md = `${tradeTable([['普工', '90']])}\n\n高峰期200人。`;
    expect(res(md)).toHaveLength(0);
  });
  it('N1-18 反向劳动力口径同池提取：两处LABOR_COUNT形态互查报出', () => {
    const issues = res('主体阶段投入劳动力约110人。施工劳动力170人。');
    expect(issues).toHaveLength(1);
  });
});

describe('N2 模式1：正文峰值全量互查（30%阈值/阶段门/中断）', () => {
  it('N2-1 同口径双峰值相差59%报互斥', () => {
    const issues = res('高峰期220人。高峰期90人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('59');
  });
  it('N2-2 30%阈值内不报：100 vs 142（29.6%）', () => {
    expect(res('高峰期100人。高峰期142人。')).toHaveLength(0);
  });
  it('N2-3 30%阈值外报：100 vs 143（30.1%）', () => {
    const issues = res('高峰期100人。高峰期143人。');
    expect(issues).toHaveLength(1);
  });
  it('N2-4 不同阶段限定不互斥：地下结构220 vs 室外工程90', () => {
    expect(res('地下结构阶段220人。室外工程阶段90人。')).toHaveLength(0);
  });
  it('N2-5 同阶段限定互查：地下结构220 vs 地下结构90报出', () => {
    const issues = res('地下结构阶段220人。地下结构阶段90人。');
    expect(issues).toHaveLength(1);
  });
  it('N2-6 总口径≥阶段×0.9跳过：180 vs 室外工程90不互斥', () => {
    expect(res('高峰期总人数约180人。室外工程阶段90人。')).toHaveLength(0);
  });
  it('N2-7 总口径低于阶段×0.9参与互查：40 vs 室外工程90报出', () => {
    const issues = res('高峰期总人数约40人。室外工程阶段90人。');
    expect(issues).toHaveLength(1);
  });
  it('N2-8 互斥报出后中断：三处矛盾只报一条', () => {
    expect(res('高峰期100人。高峰期200人。高峰期400人。')).toHaveLength(1);
  });
  it('N2-9 同值不报：100 vs 100', () => {
    expect(res('高峰期100人。高峰期100人。')).toHaveLength(0);
  });
  it('N2-10 管理组内互查：管理人员18 vs 管理人员40报出', () => {
    const issues = res('高峰期管理人员18人。高峰期管理人员40人。');
    expect(issues).toHaveLength(1);
  });
  it('N2-11 同一句阶段值双形态入池（STAGE+词表PEAK）：STAGE形态与STAGE同阶段互查报出', () => {
    const issues = res('装饰装修阶段投入20人。装饰装修阶段高峰35人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('35');
  });
  it('N2-12 跨句边界互查：两句各一峰值报出', () => {
    const issues = res('高峰期220人，作业人员集中投入。\n高峰期90人，错峰施工。');
    expect(issues).toHaveLength(1);
  });
  it('N2-13 千分位数字解析：1,000 vs 600报出（600/1000=40%）', () => {
    const issues = res('高峰期1,000人。高峰期600人。');
    expect(issues).toHaveLength(1);
  });
  it('N2-14 数值0不入池：高峰期0人与90人不互斥', () => {
    expect(res('高峰期0人。高峰期90人。')).toHaveLength(0);
  });
});

describe('N3 模式2：多表峰值互查（hasPeakCol口径表）', () => {
  it('N3-1 两高峰列表相差59%报互斥', () => {
    const md = `${peakTable([['基础阶段', '90'], ['主体阶段', '100']])}\n\n${peakTable([['基础阶段', '200'], ['主体阶段', '220']])}`;
    const issues = res(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('劳动力表峰值');
  });
  it('N3-2 两高峰列表相差29.6%不报', () => {
    const md = `${peakTable([['基础阶段', '100']])}\n\n${peakTable([['主体阶段', '142']])}`;
    expect(res(md)).toHaveLength(0);
  });
  it('N3-3 单表不报（需≥2张口径表）', () => {
    expect(res(peakTable([['基础阶段', '90'], ['主体阶段', '100']]))).toHaveLength(0);
  });
  it('N3-4 高峰列优先：平均列100/120 vs 高峰列190/230，峰值取230', () => {
    const a = '| 施工阶段 | 阶段平均人数 | 阶段高峰人数 |\n| --- | --- | --- |\n| 基础 | 100 | 190 |\n| 主体 | 120 | 230 |';
    const md = `${a}\n\n${peakTable([['基础阶段', '100']])}`;
    const issues = res(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('230');
  });
  it('N3-5 合计行不计入表峰值：模式2不报（90 vs 100），仅模式4报合计行矛盾', () => {
    const a = '| 施工阶段 | 阶段高峰人数 |\n| --- | --- |\n| 基础 | 90 |\n| 主体 | 60 |\n| 合计 | 220 |';
    const md = `${a}\n\n${peakTable([['主体阶段', '100']])}`;
    const issues = res(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('合计行');
  });
});

describe('N4 模式3：正文峰值 vs 表峰值（1.3阈值）', () => {
  it('N4-1 正文200超出表峰值100的30%报出', () => {
    const md = `${peakTable([['基础阶段', '100']])}\n\n高峰期200人。`;
    const issues = res(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('分阶段投入明细表');
  });
  it('N4-2 阈值边界不报：正文130 vs 表100（恰好1.3倍）', () => {
    expect(res(`${peakTable([['基础阶段', '100']])}\n\n高峰期130人。`)).toHaveLength(0);
  });
  it('N4-3 阈值边界报：正文131 vs 表100', () => {
    expect(res(`${peakTable([['基础阶段', '100']])}\n\n高峰期131人。`)).toHaveLength(1);
  });
  it('N4-4 工种口径正文值不参与表峰值互比', () => {
    expect(res(`${peakTable([['基础阶段', '100']])}\n\n高峰期钢筋工200人。`)).toHaveLength(0);
  });
  it('N4-5 分工种表峰值不入全员峰值池：正文86不与普工34互比', () => {
    expect(res(`${tradeTable([['普工', '34']])}\n\n高峰期86人。`)).toHaveLength(0);
  });
  it('N4-6 无表不报', () => {
    expect(res('高峰期200人。')).toHaveLength(0);
  });
});

describe('N5 模式4：合计行 vs 明细行之和（10%阈值）', () => {
  it('N5-1 合计100 vs 明细40+30不符报出', () => {
    const md = '| 施工阶段 | 人数 |\n| --- | --- |\n| 基础阶段 | 40 |\n| 主体阶段 | 30 |\n| 合计 | 100 |';
    const issues = res(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('合计行');
  });
  it('N5-2 合计100 vs 明细45+50差5%不报', () => {
    const md = '| 施工阶段 | 人数 |\n| --- | --- |\n| 基础阶段 | 45 |\n| 主体阶段 | 50 |\n| 合计 | 100 |';
    expect(res(md)).toHaveLength(0);
  });
  it('N5-3 10%阈值外报：合计100 vs 明细44+45差11%', () => {
    const md = '| 施工阶段 | 人数 |\n| --- | --- |\n| 基础阶段 | 44 |\n| 主体阶段 | 45 |\n| 合计 | 100 |';
    expect(res(md)).toHaveLength(1);
  });
  it('N5-4 10%阈值内不报：合计100 vs 明细45+46差9%', () => {
    const md = '| 施工阶段 | 人数 |\n| --- | --- |\n| 基础阶段 | 45 |\n| 主体阶段 | 46 |\n| 合计 | 100 |';
    expect(res(md)).toHaveLength(0);
  });
  it('N5-5 无合计行不检', () => {
    const md = '| 施工阶段 | 人数 |\n| --- | --- |\n| 基础阶段 | 40 |\n| 主体阶段 | 30 |';
    expect(res(md)).toHaveLength(0);
  });
  it('N5-6 明细行不足2行不检（单明细+合计）', () => {
    const md = '| 施工阶段 | 人数 |\n| --- | --- |\n| 基础阶段 | 40 |\n| 合计 | 100 |';
    expect(res(md)).toHaveLength(0);
  });
  it('N5-7 「小计」行同样识别为合计行', () => {
    const md = '| 施工阶段 | 人数 |\n| --- | --- |\n| 基础阶段 | 40 |\n| 主体阶段 | 30 |\n| 小计 | 100 |';
    expect(res(md)).toHaveLength(1);
  });
  it('N5-8 单元格「人」后缀合法解析：40人+60人=合计100不误报', () => {
    const md = '| 施工阶段 | 人数 |\n| --- | --- |\n| 基础阶段 | 40人 |\n| 主体阶段 | 60人 |\n| 合计 | 100 |';
    expect(res(md)).toHaveLength(0);
  });
});

describe('N6 模式5：总工日推算（峰值×工期×[0.1,1.3]区间）', () => {
  it('N6-1 区间内不报：8000工日 vs 峰值100×工期90', () => {
    expect(res('高峰期100人。总工期90日历天。总计8000个工日。')).toHaveLength(0);
  });
  it('N6-2 超上界报：20000 > 100×90×1.3', () => {
    const issues = res('高峰期100人。总工期90日历天。总计20000个工日。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('总工日');
  });
  it('N6-3 低于下界报：500 < 100×90×0.1', () => {
    expect(res('高峰期100人。总工期90日历天。总计500个工日。')).toHaveLength(1);
  });
  it('N6-4 上界边界不报：11700恰好等于1.3倍', () => {
    expect(res('高峰期100人。总工期90日历天。总计11700个工日。')).toHaveLength(0);
  });
  it('N6-5 上界边界报：11701超出1.3倍', () => {
    expect(res('高峰期100人。总工期90日历天。总计11701个工日。')).toHaveLength(1);
  });
  it('N6-6 下界附近：901不报、899报', () => {
    expect(res('高峰期100人。总工期90日历天。总计901个工日。')).toHaveLength(0);
    expect(res('高峰期100人。总工期90日历天。总计899个工日。')).toHaveLength(1);
  });
  it('N6-7 总量语境词枚举：总/合计/总计/共四形态均采样', () => {
    for (const prefix of ['总工日合计', '合计', '总计', '共']) {
      expect(res(`高峰期100人。总工期90日历天。${prefix}20000个工日。`)).toHaveLength(1);
    }
  });
  it('N6-8 无总量语境词不采样：「偏差超过5个工日」不误报', () => {
    expect(res('高峰期100人。总工期90日历天。各阶段偏差超过5个工日的即调整。')).toHaveLength(0);
  });
  it('N6-9 工期低于30天不入池：20日历天不参与推算', () => {
    expect(res('高峰期100人。总工期20日历天。总计20000个工日。')).toHaveLength(0);
  });
  it('N6-10 无峰值不推算', () => {
    expect(res('总工期90日历天。总计20000个工日。')).toHaveLength(0);
  });
  it('N6-11 千分位总工日解析：20,000报出', () => {
    expect(res('高峰期100人。总工期90日历天。总计20,000个工日。')).toHaveLength(1);
  });
  it('N6-12 「个日历天」形态工期解析', () => {
    expect(res('高峰期100人。总工期90个日历天。总计20000个工日。')).toHaveLength(1);
  });
});

describe('N7 模式6：总量控制上限 vs 峰值（无百分比阈值）', () => {
  it('N7-1 上限260 vs 阶段峰值350报出（不设30%阈值）', () => {
    const issues = res('高峰期总人数控制在260人以内。主体阶段高峰投入约350人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('控制');
  });
  it('N7-2 表峰值超上限报出', () => {
    const md = `${peakTable([['主体阶段', '300']])}\n\n高峰期总人数控制在260人以内。`;
    expect(res(md)).toHaveLength(1);
  });
  it('N7-3 上限高于峰值不报', () => {
    expect(res('高峰期总人数控制在300人以内。高峰期260人。')).toHaveLength(0);
  });
  it('N7-4 上限等于峰值不报（严格大于才报）', () => {
    expect(res('高峰期总人数控制在260人以内。高峰期260人。')).toHaveLength(0);
  });
  it('N7-5 控制形态枚举：以内/以下/为/到', () => {
    for (const form of ['控制在260人以内', '控制在260人以下', '控制为260人', '控制到260人']) {
      expect(res(`高峰期总人数${form}。主体阶段高峰投入约350人。`)).toHaveLength(1);
    }
  });
  it('N7-6 多上限取最大值：cap260下峰值220不报（取200会误报）', () => {
    expect(res('高峰期总人数控制在200人以内。高峰期总人数控制在260人以内。高峰期220人。')).toHaveLength(0);
  });
  it('N7-7 管理口径值也参与上限比较', () => {
    const issues = res('高峰期管理人员40人。高峰期总人数控制在30人以内。');
    expect(issues).toHaveLength(1);
  });
});

describe('N8 模式7：班组加总算式一致性', () => {
  it('N8-1 算式左侧求和≠结果报出：8+6+5+2×4=27 vs =20', () => {
    const issues = res('道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4=20人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('27');
    expect(issues[0].message).toContain('20');
  });
  it('N8-2 宣称总人数与算式结果矛盾报出：投入20 vs =27（差26%）', () => {
    const issues = res('本工程投入20人，道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4=27人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('20');
  });
  it('N8-3 「8人」末位数字放宽形态参与求和：sum27自洽不报（旧正则漏采会误报）', () => {
    expect(res('道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动8人=27人。')).toHaveLength(0);
  });
  it('N8-4 5%阈值内不报：sum27 vs =26（差3.7%）', () => {
    expect(res('道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4=26人。')).toHaveLength(0);
  });
  it('N8-5 5%阈值外报：sum27 vs =25（差7.4%）', () => {
    expect(res('道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4=25人。')).toHaveLength(1);
  });
  it('N8-6 15%阈值内不报：宣称23 vs =27（差14.8%）', () => {
    expect(res('本工程投入23人，道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4=27人。')).toHaveLength(0);
  });
  it('N8-7 15%阈值外报：宣称22 vs =27（差18.5%）', () => {
    expect(res('本工程投入22人，道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4=27人。')).toHaveLength(1);
  });
  it('N8-8 近似措辞豁免宣称通道：「约」投入20人不与27互比', () => {
    expect(res('本工程约投入20人，道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4=27人。')).toHaveLength(0);
  });
  it('N8-9 近似措辞豁免宣称通道：「近」投入20人不与27互比', () => {
    expect(res('本工程投入近20人，道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4=27人。')).toHaveLength(0);
  });
  it('N8-10 算式自洽且无宣称词不报：sum27 = =27', () => {
    expect(res('道路浇筑8人＋铺装6人＋排水沟砌筑5人＋机动2×4=27人。')).toHaveLength(0);
  });
  it('N8-11 无等号结果形态不检', () => {
    expect(res('本工程投入20人，班组合计27人。')).toHaveLength(0);
  });
  it('N8-12 表格行豁免', () => {
    const md = '| 班组 | 人数 |\n| --- | --- |\n| 道路浇筑8人＋铺装6人 | =20人 |';
    expect(res(md)).toHaveLength(0);
  });
  it('N8-13 标题行豁免', () => {
    expect(res('## 班组配置：道路浇筑8人＋铺装6人=20人')).toHaveLength(0);
  });
});

describe('N9 laborPeakConflictIssues：总人数 vs 高峰人数众数互查', () => {
  it('N9-1 总人数100 vs 高峰人数150（差50%>20%）报出', () => {
    const issues = laborPeakConflictIssues('高峰期总人数100人。高峰人数150人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('峰值口径');
  });
  it('N9-2 20%阈值边界：100 vs 121报、100 vs 120不报', () => {
    expect(laborPeakConflictIssues('高峰期总人数100人。高峰人数121人。')).toHaveLength(1);
    expect(laborPeakConflictIssues('高峰期总人数100人。高峰人数120人。')).toHaveLength(0);
  });
  it('N9-3 同值不报：100 vs 100', () => {
    expect(laborPeakConflictIssues('高峰期总人数100人。高峰人数100人。')).toHaveLength(0);
  });
  it('N9-4 totalSet去重后仍报且仅一条：两处同值总人数', () => {
    const issues = laborPeakConflictIssues('高峰期总人数100人，劳动力总人数100人。高峰人数121人。');
    expect(issues).toHaveLength(1);
  });
  it('N9-5 任一总人数冲突即报：100冲突、200不冲突', () => {
    const issues = laborPeakConflictIssues('高峰期总人数100人，劳动力总人数200人。高峰人数150人。');
    expect(issues).toHaveLength(1);
  });
  it('N9-6 无总人数形态不报', () => {
    expect(laborPeakConflictIssues('高峰人数150人。')).toHaveLength(0);
  });
  it('N9-7 无高峰人数形态不报', () => {
    expect(laborPeakConflictIssues('高峰期总人数100人。')).toHaveLength(0);
  });
  it('N9-8 峰值变体形态枚举：约/需求/为/高峰期人数', () => {
    for (const peakForm of ['峰值约150人', '峰值需求150人', '峰值为150人', '高峰期人数150人']) {
      expect(laborPeakConflictIssues(`高峰期总人数100人。${peakForm}。`)).toHaveLength(1);
    }
  });
  it('N9-9 总人数变体形态枚举：劳动力总人数/裸总人数', () => {
    expect(laborPeakConflictIssues('劳动力总人数100人。高峰人数150人。')).toHaveLength(1);
    expect(laborPeakConflictIssues('总人数100人。高峰人数150人。')).toHaveLength(1);
  });
});

describe('N10 fixLaborPeakConflict：峰值口径确定性修复', () => {
  it('N10-1 高峰口径频次胜出：total 100→150', () => {
    const result = fixLaborPeakConflict('高峰期总人数100人。高峰人数150人，高峰人数150人。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('高峰期总人数150人');
    expect(result.markdown).not.toContain('高峰期总人数100人');
  });
  it('N10-2 总人数口径频次胜出：peak 150→100', () => {
    const result = fixLaborPeakConflict('高峰期总人数100人，劳动力总人数100人。高峰人数150人。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('高峰人数100人');
  });
  it('N10-3 频次平手时高峰口径胜出：total 100→150', () => {
    const result = fixLaborPeakConflict('高峰期总人数100人。高峰人数150人。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('高峰期总人数150人');
  });
  it('N10-4 只替换loser值：total 100换150、120保持不动', () => {
    const result = fixLaborPeakConflict('高峰期总人数100人，劳动力总人数120人。高峰人数150人，高峰期人数150人。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('高峰期总人数150人');
    expect(result.markdown).toContain('劳动力总人数120人');
  });
  it('N10-5 同值不修：100 vs 100', () => {
    const result = fixLaborPeakConflict('高峰期总人数100人。高峰人数100人。');
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('高峰期总人数100人');
  });
  it('N10-6 空Map防崩溃：总人数0人不产生候选', () => {
    const result = fixLaborPeakConflict('高峰期总人数0人。高峰人数150人。');
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('高峰期总人数0人');
  });
  it('N10-7 无总人数形态不修', () => {
    const result = fixLaborPeakConflict('高峰人数150人。');
    expect(result.fixedCount).toBe(0);
  });
  it('N10-8 无高峰形态不修', () => {
    const result = fixLaborPeakConflict('高峰期总人数100人。');
    expect(result.fixedCount).toBe(0);
  });
  it('N10-9 总人数胜出但loser仅在「峰值」形态：不替换（锁定loserPeakRe仅高峰人数形态）', () => {
    const result = fixLaborPeakConflict('高峰期总人数100人，劳动力总人数100人。峰值约150人。');
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('峰值约150人');
  });
  it('N10-10 高峰胜出时total形态前缀保留', () => {
    const result = fixLaborPeakConflict('劳动力总人数100人。高峰人数150人，高峰人数150人。');
    expect(result.markdown).toContain('劳动力总人数150人');
  });
  it('N10-11 总人数胜出时「高峰期人数」形态可替换', () => {
    const result = fixLaborPeakConflict('高峰期总人数100人，劳动力总人数100人。高峰期人数150人。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('高峰期人数100人');
  });
  it('N10-12 details记录修复方向', () => {
    const result = fixLaborPeakConflict('高峰期总人数100人。高峰人数150人。');
    expect(result.details).toHaveLength(1);
    expect(result.details[0]).toContain('100人→150人');
  });
});

describe('N11 表格峰值导出函数', () => {
  it('N11-1 tablePeakLabor单表取值', () => {
    expect(tablePeakLabor(peakTable([['基础阶段', '90'], ['主体阶段', '100']]))).toBe(100);
  });
  it('N11-2 tablePeakLabor多表取最大', () => {
    const md = `${peakTable([['基础阶段', '90']])}\n\n${peakTable([['主体阶段', '220']])}`;
    expect(tablePeakLabor(md)).toBe(220);
  });
  it('N11-3 tablePeakLabor分工种表排除', () => {
    expect(tablePeakLabor(tradeTable([['普工', '34']]))).toBeUndefined();
  });
  it('N11-4 tablePeakLabor无表undefined', () => {
    expect(tablePeakLabor('纯文本无表格')).toBeUndefined();
  });
  it('N11-5 fallback无表时取正文总口径峰值最大值', () => {
    expect(tablePeakLaborWithChainFallback('高峰期86人。高峰期约220人。')).toBe(220);
  });
  it('N11-6 fallback阶段限定值不入池', () => {
    expect(tablePeakLaborWithChainFallback('室外工程阶段90人。高峰期86人。')).toBe(86);
  });
  it('N11-7 fallback表优先于正文', () => {
    const md = `${peakTable([['主体阶段', '220']])}\n\n高峰期300人。`;
    expect(tablePeakLaborWithChainFallback(md)).toBe(220);
  });
});

describe('N12 历史缺陷回归形态', () => {
  it('N12-1 表格行阶段劳动力值不入正文互查池：施工准备阶段劳动力62 vs 高峰186不误报', () => {
    const md = '| 施工阶段 | 投入 |\n| --- | --- |\n| 施工准备阶段 | 62人 |\n\n高峰期186人。';
    expect(res(md)).toHaveLength(0);
  });
  it('N12-2 岗位配置表排除：项目经理1人/施工员3人不与峰值95互斥', () => {
    const md = '| 岗位 | 职责 | 人数 |\n| --- | --- | --- |\n| 项目经理 | 全面负责 | 1 |\n| 施工员 | 现场管理 | 3 |\n\n高峰期95人。';
    expect(res(md)).toHaveLength(0);
  });
  it('N12-3 阶段平均人数列与高峰列并存：峰值取高峰列不误报', () => {
    const md = '| 施工阶段 | 阶段平均人数 | 阶段高峰人数 |\n| --- | --- | --- |\n| 基础 | 100 | 190 |\n\n高峰期200人。';
    const issues = res(md);
    expect(issues).toHaveLength(0);
  });
  it('N12-4 「按高峰期总人数20人配置专职安全员2名」总人数口径不误划管理组', () => {
    const issues = res('按高峰期总人数20人配置专职安全员2名。高峰期86人。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('20');
  });
  it('N12-5 「主体阶段投入劳动力约110人」反向口径入池与明细互查', () => {
    const issues = res('主体阶段投入劳动力约110人。主体阶段投入劳动力约40人。');
    expect(issues).toHaveLength(1);
  });
  it('N12-6 三口径并存谱系：链峰值180与劳动力口径110互查报出，加总120自洽不报', () => {
    const md = '劳动力高峰150～180人。主体阶段投入劳动力约110人。木工40＋钢筋35＋混凝土20＋吊装25=120人。';
    const issues = res(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('180');
    expect(issues[0].message).toContain('110');
  });
});

describe('N10-B fixLaborPeakConflict：蓝图权威零漂移豁免（D2）', () => {
  it('N10-B1 微漂移 11.6%（199 vs 176）在旧 30% 豁免内也确定性替换', () => {
    const result = fixLaborPeakConflict('施工高峰期投入199人。', 176);
    expect(result.fixedCount).toBeGreaterThan(0);
    expect(result.markdown).not.toContain('199');
    expect(result.markdown).toContain('176');
  });
  it('N10-B2 峰值语境句内连带值全修：「峰值统一按199人控制，各阶段同时在场人数均不得超过199人」', () => {
    const result = fixLaborPeakConflict('全项目劳动力峰值统一按199人控制，各阶段同时在场人数均不得超过199人。', 176);
    expect(result.markdown).not.toContain('199');
    expect(result.markdown).toContain('176');
  });
  it('N10-B3 阶段语境值 > 权威时收口（阶段人数不得超过总峰值）', () => {
    const result = fixLaborPeakConflict('景观与绿化阶段投入199人，其中绿化工102人。', 176);
    expect(result.markdown).toContain('投入176人');
    expect(result.markdown).toContain('绿化工102人'); // 工种口径不动
  });
  it('N10-B4 阶段语境值 < 权威为合法阶段明细，不动', () => {
    const result = fixLaborPeakConflict('施工准备阶段投入22人。', 176);
    expect(result.fixedCount).toBe(0);
    expect(result.markdown).toContain('22人');
  });
  it('N10-B5 表格峰值行（行内含峰值语境词）数值修复', () => {
    const markdown = '| 主体施工阶段 | 开工后第16日至第75日 | 199人 | 12个班组 | 达到劳动力峰值，各专业班组全部进场 |';
    const result = fixLaborPeakConflict(markdown, 176);
    expect(result.markdown).toContain('176人');
    expect(result.markdown).not.toContain('199人');
  });
  it('N10-B6 管理口径不动、峰值口径修复同句并存', () => {
    const result = fixLaborPeakConflict('管理人员18人，施工高峰期199人。', 176);
    expect(result.markdown).toContain('管理人员18人');
    expect(result.markdown).toContain('高峰期176人');
  });
  it('N10-B7 与权威同值不动', () => {
    const result = fixLaborPeakConflict('施工高峰期176人。', 176);
    expect(result.fixedCount).toBe(0);
  });
});
