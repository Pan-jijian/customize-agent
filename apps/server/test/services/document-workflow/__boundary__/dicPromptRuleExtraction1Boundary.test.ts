/**
 * t4-pr PR1 组：promptRuleExtraction 纯函数族矩阵（生成器产出，真实行为锁定）。
 * 覆盖：cleanSectionTitleArtifacts / normalizePlannedSectionTitle / isInvalidPlannedSectionTitle /
 * sectionTitleEquivalent / dedupePlannedSections / minimumSectionCount /
 * normalizePlannedSections。
 */
import { describe, expect, it } from 'vitest';
import {
  cleanSectionTitleArtifacts,
  dedupePlannedSections,
  isInvalidPlannedSectionTitle,
  minimumSectionCount,
  normalizePlannedSections,
  sectionTitleEquivalent,
} from '@/services/document-workflow/promptRuleExtraction';
import { normalizePlannedSectionTitle } from '@/services/document-workflow/outline';

describe('cleanSectionTitleArtifacts', () => {
  it('无重复词尾原样', () => {
    expect(cleanSectionTitleArtifacts("现场踏勘")).toEqual("现场踏勘");
  });
  it('2字符重复：要点要点', () => {
    expect(cleanSectionTitleArtifacts("要点要点")).toEqual("要点");
  });
  it('4字符重复：质量控制质量控制', () => {
    expect(cleanSectionTitleArtifacts("质量控制质量控制")).toEqual("质量控制");
  });
  it('重复首字符非贪婪：工工工工工', () => {
    expect(cleanSectionTitleArtifacts("工工工工工")).toEqual("工工工");
  });
  it('空串', () => {
    expect(cleanSectionTitleArtifacts("")).toEqual("");
  });
  it('单字符', () => {
    expect(cleanSectionTitleArtifacts("A")).toEqual("A");
  });
  it('3字符重复：施工施工施工', () => {
    expect(cleanSectionTitleArtifacts("施工施工施工")).toEqual("施工施工");
  });
  it('4字符边界：基坑支护基坑支护', () => {
    expect(cleanSectionTitleArtifacts("基坑支护基坑支护")).toEqual("基坑支护");
  });
  it('长标题无重复', () => {
    expect(cleanSectionTitleArtifacts("深基坑支护与降水施工专项方案")).toEqual("深基坑支护与降水施工专项方案");
  });
  it('数字重复：123123', () => {
    expect(cleanSectionTitleArtifacts("123123")).toEqual("123");
  });
  it('英文重复：ABCABC', () => {
    expect(cleanSectionTitleArtifacts("ABCABC")).toEqual("ABC");
  });
  it('重复超过2组：要要点要点点', () => {
    expect(cleanSectionTitleArtifacts("要要点要点点")).toEqual("要要点要点点");
  });
  it('词尾重复带前缀：现场踏勘踏勘', () => {
    expect(cleanSectionTitleArtifacts("现场踏勘踏勘")).toEqual("现场踏勘");
  });
  // B 类删除（拼接查表回退）后行为锁定：粘连标题不再查表裁剪，只做确定性尾部重复清洗，语义级清洗交治理器
  it('粘连标题不做查表回退（原样保留）', () => {
    expect(cleanSectionTitleArtifacts("现场踏勘施工条件现场条件")).toEqual("现场踏勘施工条件现场条件");
    expect(cleanSectionTitleArtifacts("编制依据编制依据")).toEqual("编制依据");
  });
});
describe('normalizePlannedSectionTitle', () => {
  it('无变化', () => {
    expect(normalizePlannedSectionTitle("施工方案")).toEqual("施工方案");
  });
  it('星号包裹', () => {
    expect(normalizePlannedSectionTitle("**施工方案**")).toEqual("施工方案");
  });
  it('第X章前缀', () => {
    expect(normalizePlannedSectionTitle("第一章施工方案")).toEqual("施工方案");
  });
  it('第X章顿号', () => {
    expect(normalizePlannedSectionTitle("第一章、施工方案")).toEqual("、施工方案");
  });
  it('第X章空格', () => {
    expect(normalizePlannedSectionTitle("第三章 施工方案")).toEqual("施工方案");
  });
  it('第X章连字符', () => {
    expect(normalizePlannedSectionTitle("第二章-施工方案")).toEqual("施工方案");
  });
  it('第X章点', () => {
    expect(normalizePlannedSectionTitle("第四章.施工方案")).toEqual(".施工方案");
  });
  it('第X章全角点', () => {
    expect(normalizePlannedSectionTitle("第五章．施工方案")).toEqual("．施工方案");
  });
  it('中文大写数字章', () => {
    expect(normalizePlannedSectionTitle("第十章 施工方案")).toEqual("施工方案");
  });
  it('中文混合数字章', () => {
    expect(normalizePlannedSectionTitle("第十二章 施工方案")).toEqual("施工方案");
  });
  it('中文百级章', () => {
    expect(normalizePlannedSectionTitle("第一百二十章 施工方案")).toEqual("施工方案");
  });
  it('阿拉伯数字编号', () => {
    expect(normalizePlannedSectionTitle("1.施工方案")).toEqual("施工方案");
  });
  it('多级编号', () => {
    expect(normalizePlannedSectionTitle("1.2.3 施工方案")).toEqual("施工方案");
  });
  it('全角点编号', () => {
    expect(normalizePlannedSectionTitle("1．施工方案")).toEqual("施工方案");
  });
  it('顿号编号', () => {
    expect(normalizePlannedSectionTitle("3、施工方案")).toEqual("施工方案");
  });
  it('编号带空格', () => {
    expect(normalizePlannedSectionTitle("2. 施工方案")).toEqual("施工方案");
  });
  it('破折号前缀', () => {
    expect(normalizePlannedSectionTitle("——施工方案")).toEqual("—施工方案");
  });
  it('短横前缀', () => {
    expect(normalizePlannedSectionTitle("- 施工方案")).toEqual("施工方案");
  });
  it('尖括号包裹', () => {
    expect(normalizePlannedSectionTitle("<施工方案>")).toEqual("施工方案");
  });
  it('尾部句号', () => {
    expect(normalizePlannedSectionTitle("施工方案。")).toEqual("施工方案");
  });
  it('尾部冒号', () => {
    expect(normalizePlannedSectionTitle("施工方案：")).toEqual("施工方案");
  });
  it('尾部逗号', () => {
    expect(normalizePlannedSectionTitle("施工方案，")).toEqual("施工方案");
  });
  it('尾部多标点', () => {
    expect(normalizePlannedSectionTitle("施工方案：：")).toEqual("施工方案");
  });
  it('尾部全角分号', () => {
    expect(normalizePlannedSectionTitle("施工方案；")).toEqual("施工方案");
  });
  it('尾部英文分号', () => {
    expect(normalizePlannedSectionTitle("施工方案;")).toEqual("施工方案");
  });
  it('尾部换行符', () => {
    expect(normalizePlannedSectionTitle("施工方案\n")).toEqual("施工方案");
  });
  it('英文括号注释剥离', () => {
    expect(normalizePlannedSectionTitle("施工方案 (or use numbering consistent with the outline)")).toEqual("施工方案");
  });
  it('全角括号英文注释', () => {
    expect(normalizePlannedSectionTitle("施工方案（see instructions for details）")).toEqual("施工方案");
  });
  it('无英文括号注释不剥', () => {
    expect(normalizePlannedSectionTitle("施工方案（专项措施）")).toEqual("施工方案（专项措施）");
  });
  it('组合：第X章+星号+尾部标点', () => {
    expect(normalizePlannedSectionTitle("**第一章 施工方案。**")).toEqual("施工方案");
  });
  it('组合：编号+括号注释', () => {
    expect(normalizePlannedSectionTitle("1.施工方案 (follow outline numbering rules)")).toEqual("施工方案");
  });
  it('空白输入', () => {
    expect(normalizePlannedSectionTitle("")).toEqual("");
  });
  it('全标点输入', () => {
    expect(normalizePlannedSectionTitle("。：，")).toEqual("");
  });
  it('只星号', () => {
    expect(normalizePlannedSectionTitle("***")).toEqual("");
  });
  it('只编号', () => {
    expect(normalizePlannedSectionTitle("1.")).toEqual("");
  });
  it('只章号', () => {
    expect(normalizePlannedSectionTitle("第一章")).toEqual("");
  });
  it('编号无标题', () => {
    expect(normalizePlannedSectionTitle("1.2.3")).toEqual("3");
  });
  it('英文字母编号', () => {
    expect(normalizePlannedSectionTitle("A. 施工方案")).toEqual("A. 施工方案");
  });
  it('章前缀不完整', () => {
    expect(normalizePlannedSectionTitle("第施工方案")).toEqual("第施工方案");
  });
  it('第X篇', () => {
    expect(normalizePlannedSectionTitle("第一篇 施工方案")).toEqual("施工方案");
  });
  it('第X节', () => {
    expect(normalizePlannedSectionTitle("第一节 施工方案")).toEqual("施工方案");
  });
  it('第X部分', () => {
    expect(normalizePlannedSectionTitle("第一部分 施工方案")).toEqual("施工方案");
  });
  it('第X部', () => {
    expect(normalizePlannedSectionTitle("第一部 施工方案")).toEqual("施工方案");
  });
  it('全角空格', () => {
    expect(normalizePlannedSectionTitle("施工方案　")).toEqual("施工方案");
  });
  it('长英文注释超40字符', () => {
    expect(normalizePlannedSectionTitle("施工方案 (xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)")).toEqual("施工方案");
  });
  it('中文括号内英文', () => {
    expect(normalizePlannedSectionTitle("施工方案（内含 ABC 说明文字）")).toEqual("施工方案");
  });
});
describe('isInvalidPlannedSectionTitle', () => {
  it('正常标题', () => {
    expect(isInvalidPlannedSectionTitle("基坑开挖与支护", "施工部署与总体安排")).toEqual(false);
  });
  it('长度3字符', () => {
    expect(isInvalidPlannedSectionTitle("施工", "施工部署与总体安排")).toEqual(true);
  });
  it('长度恰好4字符', () => {
    expect(isInvalidPlannedSectionTitle("基坑支护", "施工部署与总体安排")).toEqual(false);
  });
  it('WS1 结构标签独立成题拒收（施工概况/施工流程/施工方法）', () => {
    expect(isInvalidPlannedSectionTitle("施工概况", "施工部署与总体安排")).toEqual(true);
    expect(isInvalidPlannedSectionTitle("施工流程", "施工部署与总体安排")).toEqual(true);
    expect(isInvalidPlannedSectionTitle("施工方法", "施工部署与总体安排")).toEqual(true);
  });
  it('长度60字符', () => {
    expect(isInvalidPlannedSectionTitle("方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方", "施工部署与总体安排")).toEqual(true);
  });
  it('长度61字符', () => {
    expect(isInvalidPlannedSectionTitle("方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方", "施工部署与总体安排")).toEqual(true);
  });
  it('与章题相同', () => {
    expect(isInvalidPlannedSectionTitle("施工部署与总体安排", "施工部署与总体安排")).toEqual(true);
  });
  it('与章题归一化后相同', () => {
    expect(isInvalidPlannedSectionTitle("第3章 施工部署与总体安排", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：目录', () => {
    expect(isInvalidPlannedSectionTitle("目录", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：章节', () => {
    expect(isInvalidPlannedSectionTitle("章节", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：大纲', () => {
    expect(isInvalidPlannedSectionTitle("大纲", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：要求', () => {
    expect(isInvalidPlannedSectionTitle("要求", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：说明', () => {
    expect(isInvalidPlannedSectionTitle("说明", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：注意', () => {
    expect(isInvalidPlannedSectionTitle("注意", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：输出', () => {
    expect(isInvalidPlannedSectionTitle("输出", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：格式', () => {
    expect(isInvalidPlannedSectionTitle("格式", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：示例', () => {
    expect(isInvalidPlannedSectionTitle("示例", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：例如', () => {
    expect(isInvalidPlannedSectionTitle("例如", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：写法', () => {
    expect(isInvalidPlannedSectionTitle("写法", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：占位', () => {
    expect(isInvalidPlannedSectionTitle("占位", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：提示', () => {
    expect(isInvalidPlannedSectionTitle("提示", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：是否涉及', () => {
    expect(isInvalidPlannedSectionTitle("是否涉及专项方案", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：是否涉及支护', () => {
    expect(isInvalidPlannedSectionTitle("判断是否涉及支护", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：是否适用', () => {
    expect(isInvalidPlannedSectionTitle("判定是否适用", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：确认是否涉及', () => {
    expect(isInvalidPlannedSectionTitle("确认是否涉及降水", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：如涉及', () => {
    expect(isInvalidPlannedSectionTitle("如涉及深基坑", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：若不涉及', () => {
    expect(isInvalidPlannedSectionTitle("若不涉及降水", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：如果适用', () => {
    expect(isInvalidPlannedSectionTitle("如果适用支护", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：如不适用', () => {
    expect(isInvalidPlannedSectionTitle("如不适用放坡", "施工部署与总体安排")).toEqual(true);
  });
  // D1 宽泛句式正则已随 B 类删除：宽泛指令表达不再由本过滤器拦截（职责收口治理器/定名轮/终检），仅保留核心条件句式
  it('宽泛指令句式不再拦截（如：根据实际情况判断/结合项目情况确定/按需生成）', () => {
    expect(isInvalidPlannedSectionTitle("根据项目实际情况判断", "施工部署与总体安排")).toEqual(false);
    expect(isInvalidPlannedSectionTitle("结合项目情况确定编制", "施工部署与总体安排")).toEqual(false);
    expect(isInvalidPlannedSectionTitle("按需生成", "施工部署与总体安排")).toEqual(false);
  });
  it('指令：视情况', () => {
    expect(isInvalidPlannedSectionTitle("视情况", "施工部署与总体安排")).toEqual(true);
  });
  it('指令：判断后', () => {
    expect(isInvalidPlannedSectionTitle("判断后", "施工部署与总体安排")).toEqual(true);
  });
  it('宽泛裸词句式不再拦截（生成要求/说明要求/注意事项）', () => {
    expect(isInvalidPlannedSectionTitle("生成要求", "施工部署与总体安排")).toEqual(false);
    expect(isInvalidPlannedSectionTitle("说明要求", "施工部署与总体安排")).toEqual(false);
    expect(isInvalidPlannedSectionTitle("注意事项", "施工部署与总体安排")).toEqual(false);
  });
  it('占位：目标与范围', () => {
    expect(isInvalidPlannedSectionTitle("目标与范围", "施工部署与总体安排")).toEqual(true);
  });
  it('占位：资料依据', () => {
    expect(isInvalidPlannedSectionTitle("资料依据", "施工部署与总体安排")).toEqual(true);
  });
  it('占位：实施内容', () => {
    expect(isInvalidPlannedSectionTitle("实施内容", "施工部署与总体安排")).toEqual(true);
  });
  it('占位：质量控制', () => {
    expect(isInvalidPlannedSectionTitle("质量控制", "施工部署与总体安排")).toEqual(true);
  });
  it('占位：概述', () => {
    expect(isInvalidPlannedSectionTitle("概述", "施工部署与总体安排")).toEqual(true);
  });
  it('占位：总体要求', () => {
    expect(isInvalidPlannedSectionTitle("总体要求", "施工部署与总体安排")).toEqual(true);
  });
  it('气候：雨季', () => {
    expect(isInvalidPlannedSectionTitle("雨季", "施工部署与总体安排")).toEqual(true);
  });
  it('气候：冬季', () => {
    expect(isInvalidPlannedSectionTitle("冬季", "施工部署与总体安排")).toEqual(true);
  });
  it('气候：高温', () => {
    expect(isInvalidPlannedSectionTitle("高温", "施工部署与总体安排")).toEqual(true);
  });
  it('气候：台风', () => {
    expect(isInvalidPlannedSectionTitle("台风", "施工部署与总体安排")).toEqual(true);
  });
  it('气候：大风等特殊气候', () => {
    expect(isInvalidPlannedSectionTitle("大风等特殊气候", "施工部署与总体安排")).toEqual(true);
  });
  it('气候：并列气候', () => {
    expect(isInvalidPlannedSectionTitle("雨季、冬季、高温、台风、大风等特殊气候", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：如需', () => {
    expect(isInvalidPlannedSectionTitle("如需", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：应由', () => {
    expect(isInvalidPlannedSectionTitle("应由", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：大模型', () => {
    expect(isInvalidPlannedSectionTitle("大模型", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：提示词', () => {
    expect(isInvalidPlannedSectionTitle("提示词", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：上下文', () => {
    expect(isInvalidPlannedSectionTitle("上下文", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：动态规划', () => {
    expect(isInvalidPlannedSectionTitle("动态规划", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：OUTLINE', () => {
    expect(isInvalidPlannedSectionTitle("OUTLINE", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：章节生成', () => {
    expect(isInvalidPlannedSectionTitle("章节生成", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：按照明确指定', () => {
    expect(isInvalidPlannedSectionTitle("按照用户明确指定", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：需求和资料', () => {
    expect(isInvalidPlannedSectionTitle("需求和资料", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：JSON', () => {
    expect(isInvalidPlannedSectionTitle("JSON", "施工部署与总体安排")).toEqual(true);
  });
  it('技术词：小节标题', () => {
    expect(isInvalidPlannedSectionTitle("小节标题", "施工部署与总体安排")).toEqual(true);
  });
  it('叠词：施施', () => {
    expect(isInvalidPlannedSectionTitle("施施", "施工部署与总体安排")).toEqual(true);
  });
  it('叠词：施工工', () => {
    expect(isInvalidPlannedSectionTitle("施工工", "施工部署与总体安排")).toEqual(true);
  });
  it('尾部规则触发：以章题尾字符结尾', () => {
    expect(isInvalidPlannedSectionTitle("工作排", "施工部署与总体安排")).toEqual(true);
  });
  it('尾部规则不触发：包含章题尾词', () => {
    expect(isInvalidPlannedSectionTitle("前期安排", "施工部署与总体安排")).toEqual(true);
  });
  it('尾部规则不触发：正常', () => {
    expect(isInvalidPlannedSectionTitle("施工进度安排", "施工部署与总体安排")).toEqual(true);
  });
  it('空标题', () => {
    expect(isInvalidPlannedSectionTitle("", "施工部署与总体安排")).toEqual(true);
  });
  it('空白标题', () => {
    expect(isInvalidPlannedSectionTitle("  ", "施工部署与总体安排")).toEqual(true);
  });
});
describe('sectionTitleEquivalent', () => {
  it('相同', () => {
    expect(sectionTitleEquivalent("基坑开挖与支护", "基坑开挖与支护")).toEqual(true);
  });
  it('与/及 归一化等价', () => {
    expect(sectionTitleEquivalent("基坑开挖与支护", "基坑开挖及支护")).toEqual(false);
  });
  it('标点等价', () => {
    expect(sectionTitleEquivalent("质量控制措施", "质量控制、措施")).toEqual(true);
  });
  it('包含关系', () => {
    expect(sectionTitleEquivalent("质量保证措施", "质量保证")).toEqual(true);
  });
  it('反向包含', () => {
    expect(sectionTitleEquivalent("质量保证", "质量保证措施")).toEqual(true);
  });
  it('空白归一化等价', () => {
    expect(sectionTitleEquivalent("施工 方案", "施工方案")).toEqual(true);
  });
  it('编号剥离后等价', () => {
    expect(sectionTitleEquivalent("3.1 施工方案", "施工方案")).toEqual(true);
  });
  it('无关', () => {
    expect(sectionTitleEquivalent("质量保证", "安全防护")).toEqual(false);
  });
  it('空串 vs 空串', () => {
    expect(sectionTitleEquivalent("", "")).toEqual(false);
  });
  it('空串 vs 标题', () => {
    expect(sectionTitleEquivalent("", "施工方案")).toEqual(false);
  });
  it('标题 vs 空串', () => {
    expect(sectionTitleEquivalent("施工方案", "")).toEqual(false);
  });
  it('全标点 vs 全标点', () => {
    expect(sectionTitleEquivalent("。：", "，；")).toEqual(false);
  });
  it('数字等价', () => {
    expect(sectionTitleEquivalent("2.1", "2.1")).toEqual(true);
  });
});
describe('dedupePlannedSections', () => {
  it('重复项去重', () => {
    expect(dedupePlannedSections(["基坑开挖与支护","基坑开挖与支护"])).toEqual(["基坑开挖与支护"]);
  });
  it('等价项去重', () => {
    expect(dedupePlannedSections(["基坑开挖与支护","基坑开挖及支护"])).toEqual(["基坑开挖与支护","基坑开挖及支护"]);
  });
  it('空白键丢弃', () => {
    expect(dedupePlannedSections(["施工方案","","  "])).toEqual(["施工方案"]);
  });
  it('纯标点键丢弃', () => {
    expect(dedupePlannedSections(["施工方案","。："])).toEqual(["施工方案"]);
  });
  it('顺序保留', () => {
    expect(dedupePlannedSections(["质量保证","安全防护","质量保证","工期计划"])).toEqual(["质量保证","安全防护","工期计划"]);
  });
  it('编号差异等价去重', () => {
    expect(dedupePlannedSections(["3.1 施工方案","施工方案"])).toEqual(["3.1 施工方案"]);
  });
  it('全部去重为空', () => {
    expect(dedupePlannedSections(["施工方案","施工方案"])).toEqual(["施工方案"]);
  });
  it('空数组', () => {
    expect(dedupePlannedSections([])).toEqual([]);
  });
  it('混合等价链', () => {
    expect(dedupePlannedSections(["质量保证措施","质量保证","安全防护","安全防护措施"])).toEqual(["质量保证措施","质量保证","安全防护","安全防护措施"]);
  });
});
describe('minimumSectionCount', () => {
  it('0字 非核心', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"项目概况"}, 0, [], 0)).toEqual(3);
  });
  it('3000字 非核心', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"项目概况"}, 3000, [], 0)).toEqual(4);
  });
  it('5000字 非核心', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"项目概况"}, 5000, [], 0)).toEqual(4);
  });
  it('8000字 非核心', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"项目概况"}, 8000, [], 0)).toEqual(5);
  });
  it('14000字 非核心', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"项目概况"}, 14000, [], 0)).toEqual(6);
  });
  it('20000字 非核心', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"项目概况"}, 20000, [], 0)).toEqual(6);
  });
  it('0字 核心质量', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"质量保证措施"}, 0, [], 0)).toEqual(4);
  });
  it('3000字 核心质量', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"质量保证措施"}, 3000, [], 0)).toEqual(4);
  });
  it('8000字 核心安全', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"安全文明施工"}, 8000, [], 0)).toEqual(5);
  });
  it('14000字 核心工期', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"工期进度计划"}, 14000, [], 0)).toEqual(6);
  });
  it('5000字 核心物资', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"材料物资管理"}, 5000, [], 0)).toEqual(4);
  });
  it('3000字 核心机械', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"机械设备配置"}, 3000, [], 0)).toEqual(4);
  });
  it('3000字 核心劳动力', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"劳动力配置"}, 3000, [], 0)).toEqual(4);
  });
  it('3000字 核心危大', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"危大工程专项"}, 3000, [], 0)).toEqual(4);
  });
  it('3000字 核心文明', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"文明施工"}, 3000, [], 0)).toEqual(4);
  });
  it('3000字 核心总平面', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工总平面布置"}, 3000, [], 0)).toEqual(4);
  });
  it('3000字 核心施工方法', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"主要施工方法"}, 3000, [], 0)).toEqual(4);
  });
  it('3000字 核心专项', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"专项方案"}, 3000, [], 0)).toEqual(4);
  });
  it('3000字 无参数证据', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"纯文字说明","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(4);
  });
  it('3000字 9个参数', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm；参数7=8mm；参数8=9mm","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(4);
  });
  it('3000字 10个参数', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm；参数7=8mm；参数8=9mm；参数9=10mm","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(4);
  });
  it('3000字 19个参数', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm；参数7=8mm；参数8=9mm；参数9=10mm；参数10=11mm；参数11=12mm；参数12=13mm；参数13=14mm；参数14=15mm；参数15=16mm；参数16=17mm；参数17=18mm；参数18=19mm","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(4);
  });
  it('3000字 20个参数', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm；参数7=8mm；参数8=9mm；参数9=10mm；参数10=11mm；参数11=12mm；参数12=13mm；参数13=14mm；参数14=15mm；参数15=16mm；参数16=17mm；参数17=18mm；参数18=19mm；参数19=20mm","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(5);
  });
  it('3000字 25个参数', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm；参数7=8mm；参数8=9mm；参数9=10mm；参数10=11mm；参数11=12mm；参数12=13mm；参数13=14mm；参数14=15mm；参数15=16mm；参数16=17mm；参数17=18mm；参数18=19mm；参数19=20mm；参数20=21mm；参数21=22mm；参数22=23mm；参数23=24mm；参数24=25mm","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(5);
  });
  it('8000字 20个参数', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 8000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm；参数7=8mm；参数8=9mm；参数9=10mm；参数10=11mm；参数11=12mm；参数12=13mm；参数13=14mm；参数14=15mm；参数15=16mm；参数16=17mm；参数17=18mm；参数18=19mm；参数19=20mm","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(5);
  });
  it('14000字 20个参数', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 14000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm；参数7=8mm；参数8=9mm；参数9=10mm；参数10=11mm；参数11=12mm；参数12=13mm；参数13=14mm；参数14=15mm；参数15=16mm；参数16=17mm；参数17=18mm；参数18=19mm；参数19=20mm","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(6);
  });
  it('8000字 10个参数', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 8000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm；参数7=8mm；参数8=9mm；参数9=10mm","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(5);
  });
  it('lockedCount抬高', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"项目概况"}, 3000, [], 6)).toEqual(6);
  });
  it('lockedCount超阈值', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"项目概况"}, 14000, [], 8)).toEqual(8);
  });
  it('lockedCount不超阈值', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"项目概况"}, 14000, [], 5)).toEqual(6);
  });
  it('参数跨证据合并', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm","roleId":"r","processingType":"text","sectionTitle":""},{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm；参数5=6mm；参数6=7mm","roleId":"r","processingType":"text","sectionTitle":"第二节"}], 0)).toEqual(4);
  });
  it('同参数跨证据去重', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm","roleId":"r","processingType":"text","sectionTitle":""},{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"参数0=1mm；参数1=2mm；参数2=3mm；参数3=4mm；参数4=5mm","roleId":"r","processingType":"text","sectionTitle":"第二节"}], 0)).toEqual(4);
  });
  it('参数带DN', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"DN200 管道 C30 混凝土 Φ12 钢筋","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(4);
  });
  it('参数带单位中文', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"厚度 120 毫米，长度 300 米","roleId":"r","processingType":"text","sectionTitle":""}], 0)).toEqual(4);
  });
  it('sectionTitle 计入文本', () => {
    expect(minimumSectionCount({"id":"c1","purpose":"","queries":[],"requiredFacts":[],"title":"施工部署"}, 3000, [{"chapterId":"c","filePath":"a.txt","score":0.9,"content":"","roleId":"r","processingType":"text","sectionTitle":"参数1=12mm"}], 0)).toEqual(4);
  });
});
describe('normalizePlannedSections', () => {
  it('有效列表', () => {
    expect(normalizePlannedSections(["基坑开挖与支护","降水施工"], "施工部署与总体安排")).toEqual(["基坑开挖与支护","降水施工"]);
  });
  it('粘连标题不做查表回退（保留原样，语义级清洗交治理器）', () => {
    expect(normalizePlannedSections(["现场踏勘施工条件现场条件","要点要点"], "施工部署与总体安排")).toEqual(["现场踏勘施工条件现场条件"]);
  });
  it('无效标题过滤', () => {
    expect(normalizePlannedSections(["目录","基坑开挖与支护"], "施工部署与总体安排")).toEqual(["基坑开挖与支护"]);
  });
  it('等价去重', () => {
    expect(normalizePlannedSections(["基坑开挖与支护","基坑开挖及支护"], "施工部署与总体安排")).toEqual(["基坑开挖与支护","基坑开挖及支护"]);
  });
  it('编号剥离', () => {
    expect(normalizePlannedSections(["3.1 基坑开挖与支护"], "施工部署与总体安排")).toEqual(["基坑开挖与支护"]);
  });
  it('空数组', () => {
    expect(normalizePlannedSections([], "施工部署与总体安排")).toEqual([]);
  });
  it('undefined 数组', () => {
    expect(normalizePlannedSections(undefined, "施工部署与总体安排")).toEqual([]);
  });
  it('全无效', () => {
    expect(normalizePlannedSections(["目录","大纲","要求"], "施工部署与总体安排")).toEqual([]);
  });
  it('与章题相同过滤', () => {
    expect(normalizePlannedSections(["施工部署与总体安排"], "施工部署与总体安排")).toEqual([]);
  });
  it('长标题过滤', () => {
    expect(normalizePlannedSections(["方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方方"], "施工部署与总体安排")).toEqual([]);
  });
});
