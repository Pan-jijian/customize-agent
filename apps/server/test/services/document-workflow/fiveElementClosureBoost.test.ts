import { describe, expect, it } from 'vitest';
import { enforceFiveElementClosureBoost } from '@/services/document-workflow/finalize/repairRounds/fiveElementClosureBoost';

/** 块级五要素命中数（与 tenderBidChecks.FIVE_ELEMENT_WORD_RES 同源的探针副本） */
const ELEMENT_RES = [
  /专项施工方案|专项方案|施工方案|施工组织设计|技术措施|管理制度|技术交底|作业指导书|操作规程/u,
  /施工工序|工艺流程|施工流程|作业流程|施工顺序|施工步骤|工艺步骤|流水段|流水作业|依次施工|工序/u,
  /项目经理|技术负责人|施工员|质检员|安全员|材料员|资料员|测量员|劳资员|班组长|监理工程师|试验员/u,
  /每日|每天|每周|每月|每季度|每批|不少于\s*\d+\s*次|至少\s*\d+\s*次|每周\s*\d+\s*次|每日\s*\d+\s*次|每\s*\d+\s*日/u,
  /整改|复查|销项|复验|闭环|返工/u,
];
function hitsOf(text: string): number {
  return ELEMENT_RES.filter(re => re.test(text)).length;
}

/** 3 项块（role+frequency+acceptance 命中，缺 plan/process） */
const THREE_HIT_BLOCK = '公厕装饰装修按先门窗、再屋面及防水、后楼地面的顺序组织作业，施工员每日检查饰面平整度，质检员每批抽检材料色差，不合格部位整改后复验。';
/** 零要素块 */
const ZERO_HIT_BLOCK = '本项目施工区域分布于村内道路与房前屋后，作业面狭长分散，材料堆放与机械转场均受村道通行条件限制。';

describe('enforceFiveElementClosureBoost（五要素闭合链尾补强）', () => {
  it('3 项块（缺 plan）补句后达到 4 项闭合', () => {
    expect(hitsOf(THREE_HIT_BLOCK)).toBe(3);
    const result = enforceFiveElementClosureBoost(THREE_HIT_BLOCK);
    expect(result).not.toBeNull();
    expect(result?.fixedCount).toBe(1);
    expect(hitsOf(result?.markdown || '')).toBeGreaterThanOrEqual(4);
  });

  it('零要素块补四要素句后达到 4 项闭合', () => {
    expect(hitsOf(ZERO_HIT_BLOCK)).toBe(0);
    const result = enforceFiveElementClosureBoost(ZERO_HIT_BLOCK);
    expect(result).not.toBeNull();
    expect(hitsOf(result?.markdown || '')).toBeGreaterThanOrEqual(4);
  });

  it('达标块（≥4 项）零触碰返回 null', () => {
    const done = `${ZERO_HIT_BLOCK}相关要求纳入施工方案与工艺流程，项目经理每日巡查、质检员每周抽查记录。`;
    expect(hitsOf(done)).toBeGreaterThanOrEqual(4);
    expect(enforceFiveElementClosureBoost(done)).toBeNull();
  });

  it('表格块与目录块整体跳过', () => {
    const table = '| 检查部位 | 检查频次 | 责任岗位 |\n| --- | --- | --- |\n| 面层 | 每日 | 施工员 |\n| 基层 | 每批 | 质检员 |';
    expect(enforceFiveElementClosureBoost(table)).toBeNull();
    const toc = '## 目录\n\n第一章 工程概况\n  1.1 编制依据\n  1.2 主要施工内容\n  1.3 路污交接部位协同施工';
    expect(enforceFiveElementClosureBoost(toc)).toBeNull();
  });

  it('段末行为标题时不污染标题（补句落到上方正文行末）', () => {
    const markdown = '全部隐蔽工序由施工员填写隐蔽验收记录，质检员复核签认，资料员当日归档。\n#### 6.2.3 苗木栽植成活与养护';
    const result = enforceFiveElementClosureBoost(markdown);
    expect(result).not.toBeNull();
    const lines = (result?.markdown || '').split('\n');
    expect(lines[lines.length - 1]).toBe('#### 6.2.3 苗木栽植成活与养护');
    expect(lines[0]).not.toBe('全部隐蔽工序由施工员填写隐蔽验收记录，质检员复核签认，资料员当日归档。');
  });

  it('幂等：补强后复跑零变更', () => {
    const first = enforceFiveElementClosureBoost(`${ZERO_HIT_BLOCK}\n\n${THREE_HIT_BLOCK}`);
    expect(first?.fixedCount).toBe(2);
    expect(enforceFiveElementClosureBoost(first?.markdown || '')).toBeNull();
  });

  it('补句不新增骨架指纹三族（由技术负责人组织/合格后方可/验收合格后）', () => {
    const input = `${ZERO_HIT_BLOCK}\n\n${THREE_HIT_BLOCK}`;
    const result = enforceFiveElementClosureBoost(input);
    const output = result?.markdown || '';
    for (const skeleton of ['由技术负责人组织', '合格后方可', '验收合格后']) {
      const before = (input.match(new RegExp(skeleton, 'gu')) || []).length;
      const after = (output.match(new RegExp(skeleton, 'gu')) || []).length;
      expect(after).toBe(before);
    }
  });

  it('段末行紧邻表格（表题行形态）时补句落上方正文行末，表题行不被污染', () => {
    const body = '公厕装饰按先基础、再主体、后饰面的顺序组织作业。';
    const markdown = [
      body,
      '表4-1 主要机械投入计划',
      '',
      '| 机械名称 | 数量 | 用途 |',
      '| --- | --- | --- |',
      '| 挖掘机 | 2台 | 土方开挖 |',
    ].join('\n');
    const result = enforceFiveElementClosureBoost(markdown);
    expect(result).not.toBeNull();
    expect(result?.fixedCount).toBe(1);
    const lines = (result?.markdown || '').split('\n');
    const captionIdx = lines.findIndex(line => line.trim() === '表4-1 主要机械投入计划');
    expect(captionIdx).toBe(1);
    // 补句拼在表题行上方正文行末（表格块零触碰），表题行保持原样
    expect(lines[0]!.startsWith(body)).toBe(true);
    expect(lines[0]!.length).toBeGreaterThan(body.length);
    expect(lines[captionIdx + 2]).toBe('| 机械名称 | 数量 | 用途 |');
    expect(lines[captionIdx + 4]).toBe('| 挖掘机 | 2台 | 土方开挖 |');
  });

  it('段内全为标题/表题行时跳过本段不补（结构行零风险）', () => {
    expect(enforceFiveElementClosureBoost('#### 6.2.3 苗木栽植成活与养护及成品保护措施落实情况')).toBeNull();
  });

  it('C2 防护①：引用块（图件说明）整块跳过——补句不拼入「>」说明块', () => {
    const note = '> **图件说明**：本附表以施工进度网络图（或以横道图）形式表达，标明计划开工日期、竣工日期及各关键日期节点。';
    expect(enforceFiveElementClosureBoost(note)).toBeNull();
    const markdown = `${ZERO_HIT_BLOCK}\n\n${note}`;
    const result = enforceFiveElementClosureBoost(markdown);
    expect(result?.fixedCount).toBe(1);
    expect(result?.markdown).toContain(note);
  });

  it('C2 防护②：附表区整区跳过——数据表/图件说明/骨架说明不被补句污染', () => {
    const note = '> **图件说明**：本附表以施工进度网络图形式表达，工序逻辑与工期安排与本施工组织设计进度计划一致。';
    const markdown = [
      ZERO_HIT_BLOCK,
      '',
      '## 附表四 计划开、竣工日期和施工进度网络图',
      '',
      note,
      '',
      '| 工序 | 持续天数 |',
      '| --- | --- |',
      '| 主体施工 | 180 |',
      '',
      '## 附表六 临时用地表',
      '',
      '| 用途 | 面积（平方米） |',
      '| --- | --- |',
      '| 材料堆放场 | 800 |',
    ].join('\n');
    const result = enforceFiveElementClosureBoost(markdown);
    // 仅附表区外的零要素块被补；附表区零变化
    expect(result?.fixedCount).toBe(1);
    expect(result?.markdown).toContain(note);
    expect(result?.markdown).toContain('| 主体施工 | 180 |');
    expect(result?.markdown).toContain('| 材料堆放场 | 800 |');
  });

  it('C2 防护③：段末行是图题行时补句上移正文行（图题行零污染；r28l「图4-3 网络图+补强句」形态根治）', () => {
    const body = '网络计划按关键线路组织流水作业，各工序按节点时间衔接推进，确保总工期满足合同要求。';
    const markdown = [body, '图4-3 网络图'].join('\n');
    const result = enforceFiveElementClosureBoost(markdown);
    expect(result).not.toBeNull();
    const lines = (result?.markdown || '').split('\n');
    expect(lines[0]!.startsWith(body)).toBe(true);
    expect(lines[0]!.length).toBeGreaterThan(body.length);
    expect(lines[1]).toBe('图4-3 网络图');
    // 段内全为图题行（含已污染粘连行）时跳过本段不补（防追加污染）
    expect(enforceFiveElementClosureBoost('图4-3 网络图相关内容纳入施工组织设计与作业流程管理')).toBeNull();
  });
});

describe('enforceFiveElementClosureBoost D-T6 ③ 长段防护（拼接后超 370 字符放弃补写）', () => {
  /** 同三要素构成（role+frequency+acceptance，缺 plan/process）：短版正常补写、长版触发防护 */
  const composeBlock = (padTimes: number) => {
    let block = THREE_HIT_BLOCK;
    for (let i = 0; i < padTimes; i += 1) block += ZERO_HIT_BLOCK;
    return block;
  };

  it('拼接后超 370 的长块跳过补写（保持原样零变更）', () => {
    // THREE(66) + 6×ZERO(48) = 354 字符：拼接后必超 370（任一候选句 ≥ 29 字）且 ≤ 380（不触发链尾切分）
    const longBlock = composeBlock(6);
    expect(hitsOf(longBlock)).toBe(3);
    expect(longBlock.length).toBe(354);
    expect(enforceFiveElementClosureBoost(longBlock)).toBeNull();
    // 幂等：同条件复跑仍零变更
    expect(enforceFiveElementClosureBoost(longBlock)).toBeNull();
  });

  it('防护边界对照：同要素构成的短块正常补写（拼接后行长 ≤ 370）', () => {
    const shortBlock = composeBlock(1);
    expect(hitsOf(shortBlock)).toBe(3);
    const result = enforceFiveElementClosureBoost(shortBlock);
    expect(result).not.toBeNull();
    expect(result?.fixedCount).toBe(1);
    const lines = (result?.markdown || '').split('\n');
    expect(lines[0]!.length).toBeLessThanOrEqual(370);
    expect(hitsOf(result?.markdown || '')).toBeGreaterThanOrEqual(4);
  });
});
