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
});
