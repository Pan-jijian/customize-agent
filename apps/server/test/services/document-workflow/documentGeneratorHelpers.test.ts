import { afterEach, describe, expect, it } from 'vitest';
import { chapterCompletionStatus, chapterGenerationTargets, cleanChineseWordBreakSpaces, cleanInlineFactValue, callBreakdownTopDetails, callBreakdownTopSummary, dedupeCrossSectionDuplicateSentences, phaseWaterfallDetails, finalizeFinalMarkdownStructure, normalizeWorkPackageLabels, splitGluedTableHeaderLines, stripBidDisciplineSentences, stripBidDisciplineSentencesSemantic, stripDataConsistencyLeakSentences } from '@/services/document-workflow/documentGeneratorHelpers';

describe('chapterGenerationTargets（提示词篇幅目标完整下达）', () => {
  it('长文模式：提示词章预算必须完整下达，不被 upper 硬顶与结构估算压制', () => {
    // 提示词「不少于5万字」→ 三章均分 16667 字/章；历史缺陷：upper 硬顶 7200~9800 把章目标压至 5200~9200
    const plan = chapterGenerationTargets({ budgetTarget: 16667, sectionCount: 20, title: '确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施', longformStrict: true });
    expect(plan.roundTarget).toBe(16667);
    expect(plan.maxWords).toBe(Math.ceil(16667 * 1.12));
  });

  it('长文模式：小节数为 0 的章节同样完整下达预算', () => {
    const plan = chapterGenerationTargets({ budgetTarget: 16667, sectionCount: 0, title: '工程重点难点及危大工程的保障体系', longformStrict: true });
    expect(plan.roundTarget).toBe(16667);
  });

  it('长文模式：预算低于下限时按下限生成（轻量章节不被无限拉长）', () => {
    const plan = chapterGenerationTargets({ budgetTarget: 2000, sectionCount: 4, title: '编制说明与工程概况', longformStrict: true });
    expect(plan.roundTarget).toBe(2600);
  });

  it('普通模式：维持原口径（结构承载量/预算/上限三重 min）', () => {
    const plan = chapterGenerationTargets({ budgetTarget: 16667, sectionCount: 20, title: '确保工期与质量的保障体系与措施', longformStrict: false });
    expect(plan.roundTarget).toBeLessThanOrEqual(16667);
    expect(plan.roundTarget).toBeGreaterThan(0);
  });

  it('三章目标总和与提示词总字数对齐（5 万字场景）', () => {
    const chapters = [
      { budgetTarget: 16667, sectionCount: 20, title: '工程重点难点及危大工程的保障体系' },
      { budgetTarget: 16667, sectionCount: 20, title: '确保工期与质量的保障体系与措施、确保安全生产的管理体系与措施' },
      { budgetTarget: 16666, sectionCount: 20, title: '施工进度计划与资源保障措施' },
    ];
    const total = chapters.reduce((sum, chapter) => sum + chapterGenerationTargets({ ...chapter, longformStrict: true }).roundTarget, 0);
    expect(total).toBe(50000);
  });
});

describe('splitGluedTableHeaderLines（改9a：表头粘连正文拆分）', () => {
  it('正文段尾粘连表头 → 拆成独立表头行（十一度实测形态）', () => {
    const markdown = [
      '### 2.2 进度计划与工期保障',
      '本工程以540个日历天为总控基准。施工总进度计划按下表编制，各阶段持续时间按工程量倒排推导。| 施工阶段/分部分项 | 开始时间 | 结束时间 | 持续时间 | 关键线路工序 |',
      '| --- | --- | --- | --- | --- |',
      '| 施工准备及临设搭设 | 第1日 | 第20日 | 20日 | 是 |',
    ].join('\n');
    const result = splitGluedTableHeaderLines(markdown);
    const lines = result.split('\n');
    expect(lines[1]).toBe('本工程以540个日历天为总控基准。施工总进度计划按下表编制，各阶段持续时间按工程量倒排推导。');
    expect(lines[2]).toBe('| 施工阶段/分部分项 | 开始时间 | 结束时间 | 持续时间 | 关键线路工序 |');
    expect(lines[3]).toBe('| --- | --- | --- | --- | --- |');
  });

  it('数据行粘连同样拆行（不改写任何单元格文字）', () => {
    const markdown = [
      '分部工程验收由总监理工程师组织。| 单位工程 | 工程质量符合合格标准 | 项目经理 | 单位工程预验收 | 竣工前组织不少于2次预验收 |',
      '| --- | --- | --- | --- | --- |',
    ].join('\n');
    const result = splitGluedTableHeaderLines(markdown);
    expect(result.split('\n')[1]).toBe('| 单位工程 | 工程质量符合合格标准 | 项目经理 | 单位工程预验收 | 竣工前组织不少于2次预验收 |');
  });

  it('下一行不是表格行不拆（正文含管道符不误伤）', () => {
    const markdown = '正文提到 A | B | C 的取值情况。\n后续正文继续。';
    expect(splitGluedTableHeaderLines(markdown)).toBe(markdown);
  });

  it('表格块内部行不动（行首 | 的行跳过）', () => {
    const markdown = '| 信息项 | 内容 |\n| --- | --- |\n| 项目名称 | 合肥师范 |';
    expect(splitGluedTableHeaderLines(markdown)).toBe(markdown);
  });
});

describe('normalizeWorkPackageLabels（改9b：冒号在 ** 内的伪标签形态）', () => {
  it('「施工概况：**施工概况：**」→「施工概况：」（十一度实测缺陷形态）', () => {
    expect(normalizeWorkPackageLabels('施工概况：**施工概况：** 本专业工程涵盖地下室底板。')).toBe('施工概况： 本专业工程涵盖地下室底板。');
  });

  it('「**施工流程：**」粗体伪标签 →「施工流程：」', () => {
    expect(normalizeWorkPackageLabels('**施工流程：** 先垫层、后底板。')).toBe('施工流程： 先垫层、后底板。');
  });

  it('「**施工方法：**」粗体伪标签 →「施工方法：」', () => {
    expect(normalizeWorkPackageLabels('**施工方法：** 分层分段开挖。')).toBe('施工方法： 分层分段开挖。');
  });

  it('历史形态「**施工概况**：」「施工概况：**施工概况**：」保持归一', () => {
    expect(normalizeWorkPackageLabels('**施工概况**： 本工程…')).toBe('施工概况： 本工程…');
    expect(normalizeWorkPackageLabels('施工概况：**施工概况**： 本工程…')).toBe('施工概况： 本工程…');
  });

  it('行中伪标签归一（正文句尾接“**施工流程：**”，十一度实测形态）', () => {
    expect(normalizeWorkPackageLabels('穿墙螺栓费用按合同约定执行。**施工流程：** 垫层浇筑→砖胎膜砌筑。')).toBe('穿墙螺栓费用按合同约定执行。施工流程： 垫层浇筑→砖胎膜砌筑。');
    expect(normalizeWorkPackageLabels('外墙防水→土方回填。**施工方法：** 垫层采用C20混凝土。')).toBe('外墙防水→土方回填。施工方法： 垫层采用C20混凝土。');
  });

  it('交叉形态不删标签词（“施工方法：**施工流程：**”保留流程标签）', () => {
    const result = normalizeWorkPackageLabels('施工方法：**施工流程：** 垫层浇筑。');
    expect(result).toBe('施工方法：施工流程： 垫层浇筑。');
  });

  it('无冒号纯加粗强调不动', () => {
    const markdown = '本工程**施工方法**经专家论证后实施。';
    expect(normalizeWorkPackageLabels(markdown)).toBe(markdown);
  });

  it('正文中其他加粗内容不受影响', () => {
    const markdown = '本工程**重点**是基坑支护与土方外运。';
    expect(normalizeWorkPackageLabels(markdown)).toBe(markdown);
  });
});

describe('cleanChineseWordBreakSpaces（改9c：中文词中断空格）', () => {
  it('同行词中断空格移除（“形成资 料”→“形成资料”）', () => {
    expect(cleanChineseWordBreakSpaces('| 进场登记 | 核验身份证 | 劳资员 | 形成资 料 | 当日完成登记 |')).toBe('| 进场登记 | 核验身份证 | 劳资员 | 形成资料 | 当日完成登记 |');
  });

  it('英文数字间空格与标题编号空格保留', () => {
    const markdown = '### 2.1 项目管理组织机构与职责\nC30 混凝土强度等级按补疑修正口径执行。';
    expect(cleanChineseWordBreakSpaces(markdown)).toBe(markdown);
  });

  it('目录行「第一章 工程…」与编号行「1.1 项目…」的合法空格保留', () => {
    const markdown = '第一章 工程重点难点及危大工程的保障体系\n1.1 项目主要施工内容\n## 第二章 确保工期与质量的保障体系与措施';
    expect(cleanChineseWordBreakSpaces(markdown)).toBe(markdown);
  });

  it('正文行真实断词移除（“专业工程 施工”→“专业工程施工”）', () => {
    expect(cleanChineseWordBreakSpaces('本专业工程 施工概况如下。')).toBe('本专业工程施工概况如下。');
  });

  it('全角空格同样移除', () => {
    expect(cleanChineseWordBreakSpaces('明确\u3000回访频次')).toBe('明确回访频次');
  });
});

describe('finalizeFinalMarkdownStructure（改9：最终组装路径覆盖清洗）', () => {
  it('最终 md 的粘连表头与伪标签一并清洗', () => {
    const markdown = [
      '### 2.1 组织机构',
      '管理人员按岗位分工。| 岗位 | 职责 | 人数 |',
      '| --- | --- | --- |',
      '| 项目经理 | 全面负责 | 1 |',
    ].join('\n');
    const result = finalizeFinalMarkdownStructure(markdown);
    const lines = result.split('\n');
    expect(lines[1]).toBe('管理人员按岗位分工。');
    expect(lines[2]).toBe('| 岗位 | 职责 | 人数 |');
  });
});

describe('cleanInlineFactValue 事实值页码清洗（空格数字形态保护）', () => {
  it('完整页码引用「PDF 第3页」归一为「相关资料」而非删成「 3 页」', () => {
    expect(cleanInlineFactValue('招标文件PDF 第 3 页')).toBe('招标文件相关资料');
    expect(cleanInlineFactValue('招标文件PDF第5页')).toBe('招标文件相关资料');
  });

  it('多空格与换行分隔的完整引用同样归一（\\s* 跨空白匹配）', () => {
    expect(cleanInlineFactValue('招标文件PDF  第   5  页')).toBe('招标文件相关资料');
    expect(cleanInlineFactValue('招标文件PDF\t第\t5\t页')).toBe('招标文件相关资料');
    expect(cleanInlineFactValue('招标文件PDF 第\n5 页')).toBe('招标文件相关资料');
  });

  it('全角数字完整引用保留原样（lookahead 含全角数字，不破坏内容）', () => {
    expect(cleanInlineFactValue('招标文件PDF 第３页')).toBe('招标文件PDF 第３页');
  });

  it('页码范围「PDF 第 5-8 页」同样归一（与 normalizeTenderSourcePageRefs L60 范围兜底同口径）', () => {
    expect(cleanInlineFactValue('招标文件PDF 第 5-8 页')).toBe('招标文件相关资料');
    expect(cleanInlineFactValue('招标文件PDF 第5至8页')).toBe('招标文件相关资料');
  });

  it('无 PDF 前缀的纯「第N页」不属于本清洗对象，原样保留', () => {
    expect(cleanInlineFactValue('详见工程量清单第 5 页')).toBe('详见工程量清单第 5 页');
  });

  it('残缺「PDF 第」残片仍删除且保留其前文本', () => {
    expect(cleanInlineFactValue('招标文件封面PDF 第')).toBe('招标文件封面');
  });

  it('残片后跟非数字文本仍删除残片（不误判为完整引用）', () => {
    expect(cleanInlineFactValue('合肥师范学院PDF 第')).toBe('合肥师范学院');
  });

  it('日期空格仍归一，行尾句号仍清理', () => {
    expect(cleanInlineFactValue('开标日期：2026年8月19 日。')).toBe('开标日期：2026年8月19日');
  });

  it('空串与纯空白输入安全返回空串', () => {
    expect(cleanInlineFactValue('')).toBe('');
    expect(cleanInlineFactValue('   ')).toBe('');
  });

  it('无任何页码特征的普通事实值原样保留', () => {
    expect(cleanInlineFactValue('合肥市瑶海区龙岗路与大众路交口')).toBe('合肥市瑶海区龙岗路与大众路交口');
  });
});

describe('cleanInlineFactValue 完整引用批量矩阵（前缀 × 分隔 × 范围分隔符）', () => {
  it.each([
    // [输入, 期望]
    ['招标文件PDF 第 3 页', '招标文件相关资料'],
    ['招标文件PDF第3页', '招标文件相关资料'],
    ['招标文件PDF  第  3  页', '招标文件相关资料'],
    ['招标文件PDF\t第\t3\t页', '招标文件相关资料'],
    ['招标文件PDF 第\n3 页', '招标文件相关资料'],
    ['招标文件PDF 第 12 页', '招标文件相关资料'],
    ['招标文件PDF 第 120 页', '招标文件相关资料'],
    ['招标文件PDF 第 5-8 页', '招标文件相关资料'],
    ['招标文件PDF 第 5 - 8 页', '招标文件相关资料'],
    ['招标文件PDF 第 5—8 页', '招标文件相关资料'],
    ['招标文件PDF 第 5至8 页', '招标文件相关资料'],
    ['招标文件PDF 第 5到8 页', '招标文件相关资料'],
    ['招标文件PDF 第 5~8 页', '招标文件相关资料'],
    ['招标文件PDF 第 5～8 页', '招标文件相关资料'],
    ['招标文件PDF 第 5 页。', '招标文件相关资料'],
    ['招标文件PDF 第 5 页，详见附件。', '招标文件相关资料，详见附件'],
    ['合肥师范学院PDF 第 3 页', '合肥师范学院相关资料'],
    ['PDF 第 3 页', '相关资料'],
    ['PDF第3页', '相关资料'],
    ['pdf 第 3 页', '相关资料'],
    ['pdf第3页', '相关资料'],
    ['招标文件 PDF 第 3 页', '招标文件 相关资料'],
    ['招标文件（PDF 第 3 页）', '招标文件（相关资料）'],
    ['招标文件；PDF 第 3 页', '招标文件；相关资料'],
    ['日期：2026年8月19日PDF 第 3 页', '日期：2026年8月19日相关资料'],
    ['招标文件PDF 第 3 页招标文件PDF 第 5 页', '招标文件相关资料招标文件相关资料'],
  ])('「%s」→「%s」', (input, expected) => {
    expect(cleanInlineFactValue(input)).toBe(expected);
  });
});

describe('cleanInlineFactValue 残片删除批量矩阵（大小写 × 空白形态 × 后跟文本）', () => {
  it.each([
    ['招标文件封面PDF 第', '招标文件封面'],
    ['招标文件封面PDF第', '招标文件封面'],
    ['招标文件封面PDF  第', '招标文件封面'],
    ['招标文件封面PDF\t第', '招标文件封面'],
    ['招标文件封面pdf 第', '招标文件封面'],
    ['招标文件封面PDF 第。', '招标文件封面'],
    ['招标文件封面PDF 第，', '招标文件封面，'],
    ['招标文件封面PDF 第，2026年8月19日', '招标文件封面，2026年8月19日'],
    ['合肥师范学院PDF 第', '合肥师范学院'],
    ['招标代理：安徽省招标集团股份有限公司PDF 第', '招标代理：安徽省招标集团股份有限公司'],
    ['PDF 第', ''],
    ['PDF第', ''],
    ['PDF 第（封面色）', '（封面色）'],
    ['招标文件PDF 第PDF 第', '招标文件'],
    ['招标文件PDF 第 三页', '招标文件三页'],
  ])('「%s」→「%s」', (input, expected) => {
    expect(cleanInlineFactValue(input)).toBe(expected);
  });
});

describe('cleanInlineFactValue 不破坏批量矩阵（非清洗对象原样保留）', () => {
  it.each([
    ['详见工程量清单第 5 页'],
    ['详见施工图设计文件第 5-8 页'],
    ['招标文件PDF 第３页'],
    ['招标文件PDF 第５页'],
    ['合肥市瑶海区龙岗路与大众路交口'],
    ['2026年8月19日'],
    ['共 10 页'],
    ['附件2：施工图纸清单'],
    ['PDF 文件'],
    ['第 5 层'],
    [''],
  ])('「%s」原样保留', (input) => {
    expect(cleanInlineFactValue(input)).toBe(input);
  });
});

describe('cleanInlineFactValue 日期与行尾清理批量矩阵', () => {
  it.each([
    ['开标日期：2026年8月19 日。', '开标日期：2026年8月19日'],
    ['2026年8月19 日。', '2026年8月19日'],
    ['2026年8月19日。', '2026年8月19日'],
    ['2026年8月19日', '2026年8月19日'],
    ['2026年8月19 日，', '2026年8月19日，'],
    ['计划工期：540 日历天。', '计划工期：540日历天'],
    ['合同估算价：1.2 万元', '合同估算价：1.2万元'],
    ['单体建筑面积 28570.36 ㎡。', '单体建筑面积 28570.36㎡'],
  ])('「%s」→「%s」', (input, expected) => {
    expect(cleanInlineFactValue(input)).toBe(expected);
  });
});

describe('stripBidDisciplineSentences 商务评标纪律承诺句清洗（4.12.6）', () => {
  it('评标纪律承诺句整句删除，同段技术内容保留', () => {
    const content = '本节针对施工现场管理提出以下要求。我公司严格遵守评标活动纪律，不向评标委员会成员或其他与评标活动有关的工作人员行贿、打招呼、递条子，不以任何方式干扰评标活动。施工现场按分区管理、责任到人执行。';
    const result = stripBidDisciplineSentences(content);
    expect(result).not.toContain('行贿');
    expect(result).not.toContain('评标纪律');
    expect(result).toContain('本节针对施工现场管理提出以下要求');
    expect(result).toContain('施工现场按分区管理、责任到人执行');
  });

  it('无商务承诺词的内容原样返回', () => {
    const content = '施工现场按分区管理、责任到人执行，安全防护设施验收合格后方可投入使用。';
    expect(stripBidDisciplineSentences(content)).toBe(content);
  });

  it('标题行不再豁免：纪律标题整行删除，表格行保留豁免', () => {
    // 评分报告 P1 实测：6 个纪律小节标题曾因标题豁免整行放行
    const content = '#### 评标纪律\n| 项目 | 内容 |\n| 廉洁承诺 | 见商务文件 |';
    const result = stripBidDisciplineSentences(content);
    expect(result).not.toContain('评标纪律');
    expect(result).toContain('| 项目 | 内容 |');
    expect(result).toContain('| 廉洁承诺 | 见商务文件 |');
  });

  it('无禁词词面变体（评分报告问题2原文）整句删除', () => {
    // 评分报告（21）实测原文：无任何禁写词词面，旧 6 词表清洗漏网
    const content = '我公司对参与本项目投标及施工组织设计编制的工作人员实行严格的纪律管理，确保投标活动合法合规；与评标活动相关工作的全体人员，不得违反评标纪律。\n本工程创优目标为确保“黄山杯”，质量目标为合格。';
    const result = stripBidDisciplineSentences(content);
    expect(result).not.toContain('纪律管理');
    expect(result).not.toContain('投标活动合法合规');
    expect(result).toContain('确保“黄山杯”');
  });

  it('技术标合法纪律表述（劳动纪律）不误删', () => {
    const content = '项目部严格执行劳动纪律与考勤管理制度，各班组按时参加班前安全交底。';
    expect(stripBidDisciplineSentences(content)).toBe(content);
  });
});

// ============ 阶段三 3.3：清洗管道补盲 ============

describe('stripBidDisciplineSentencesSemantic 语义增强清洗（3.3）', () => {
  it('无禁词词面变体（评审争议/澄清配合类）靠语义命中删除', async () => {
    const content = '### 评审争议处理与澄清配合\n本项目评审过程中如有争议按招标文件规定程序处理。施工现场按分区管理执行。';
    // "评审争议处理与澄清配合"标题与"评审过程中如有争议"句命中语义 → 删除；施工句保留
    const result = await stripBidDisciplineSentencesSemantic(content, async texts => texts.map(text => /评审|评标/u.test(text)));
    expect(result).not.toContain('评审争议处理');
    expect(result).not.toContain('按招标文件规定程序处理');
    expect(result).toContain('施工现场按分区管理执行');
  });

  it('确定性兜底：禁写词句子即使语义判 false 也删除', async () => {
    const content = '我公司不向评标委员会成员行贿。施工现场按分区管理执行。';
    const result = await stripBidDisciplineSentencesSemantic(content, async () => [false, false]);
    expect(result).not.toContain('行贿');
    expect(result).toContain('施工现场按分区管理执行');
  });

  it('施工合法纪律句（劳动纪律）语义与确定性均放行', async () => {
    const content = '项目部严格执行劳动纪律与考勤管理制度，各班组按时参加班前安全交底。';
    const result = await stripBidDisciplineSentencesSemantic(content, async () => [false]);
    expect(result).toBe(content);
  });
});

describe('stripDataConsistencyLeakSentences 约束文字泄漏扩展（3.3）', () => {
  it('「全文不再出现 180 人」类约束复述段整段删除', () => {
    const content = '质量保证措施完善。\n\n全文不再出现 180 人峰值表述，统一按 130 人口径执行。\n\n安全措施到位。';
    const result = stripDataConsistencyLeakSentences(content);
    expect(result).not.toContain('不再出现');
    expect(result).toContain('质量保证措施完善');
    expect(result).toContain('安全措施到位');
  });

  it('「不得出现跨章冲突」约束复述段整段删除', () => {
    const content = '本方案施工部署合理。\n\n正文不得出现跨章冲突，各章节数据必须保持一致。\n\n进度计划详见附图。';
    const result = stripDataConsistencyLeakSentences(content);
    expect(result).not.toContain('跨章冲突');
    expect(result).toContain('施工部署合理');
    expect(result).toContain('进度计划详见附图');
  });

  it('上表/本表口径自查段（原有规则）仍删除', () => {
    const content = '上表合计行 130 人与 180 人不一致，故将合计行修正为 130 人。';
    expect(stripDataConsistencyLeakSentences(content)).not.toContain('修正为');
  });
});

describe('dedupeCrossSectionDuplicateSentences 跨小节整句重复合并（3.3）', () => {
  const longSentence = '本工程总建筑面积 28570.36 平方米，其中地上建筑面积 24783.39 平方米，地下建筑面积 3786.97 平方米，结构形式为框架剪力墙结构。';

  it('同长句跨小节重复：保留首次出现小节，删除后续小节重复句', () => {
    const content = `### 5.1 项目概况\n${longSentence}\n### 5.6 结构设计\n${longSentence}\n本节说明结构选型。`;
    const result = dedupeCrossSectionDuplicateSentences(content);
    const occurrences = result.split(longSentence).length - 1;
    expect(occurrences).toBe(1);
    expect(result).toContain('### 5.1 项目概况');
    expect(result).toContain('本节说明结构选型');
  });

  it('同一小节内重复句保留（可能为有意强调）', () => {
    const content = `### 5.1 项目概况\n${longSentence}${longSentence}`;
    const result = dedupeCrossSectionDuplicateSentences(content);
    expect(result.split(longSentence).length - 1).toBe(2);
  });

  it('短句（<30 字）不参与跨小节去重', () => {
    const content = '### 5.1 项目概况\n质量目标为合格。\n### 5.6 结构设计\n质量目标为合格。';
    expect(dedupeCrossSectionDuplicateSentences(content)).toBe(content);
  });

  it('标题行与表格行不参与判定', () => {
    const content = `### 5.1 项目概况\n${longSentence}\n| 项目 | 内容 |\n| 说明 | ${longSentence} |`;
    const result = dedupeCrossSectionDuplicateSentences(content);
    // 正文句与表格单元格不算跨小节重复
    expect(result).toContain(`| 说明 | ${longSentence} |`);
  });
});

describe('dedupeCrossSectionDuplicateSentences 跨章同名小节序号化（1.5 双补盲之句子级）', () => {
  afterEach(() => {
    delete process.env.DOCUMENT_CROSS_CHAPTER_DEDUP;
  });

  // 实锤漏网句（方案 1.5：9 种句子各出现 2 次之一）
  const crossChapterSentence = '混凝土浇筑采用分层连续浇筑，每层厚度不超过500mm，振捣棒插入间距不大于400mm，养护不少于14天。';

  it('同名小节跨章再现：序号化为不同小节，完全重复句跨章删除（保留首现）', () => {
    const content = `### 施工方法\n${crossChapterSentence}\n### 施工方法\n${crossChapterSentence}`;
    const result = dedupeCrossSectionDuplicateSentences(content);
    expect(result.split(crossChapterSentence).length - 1).toBe(1);
    // 标题行本身不动
    expect(result.split('### 施工方法').length - 1).toBe(2);
  });

  it('env DOCUMENT_CROSS_CHAPTER_DEDUP=0 回退：同名小节按同小节判定，重复句保留', () => {
    process.env.DOCUMENT_CROSS_CHAPTER_DEDUP = '0';
    const content = `### 施工方法\n${crossChapterSentence}\n### 施工方法\n${crossChapterSentence}`;
    const result = dedupeCrossSectionDuplicateSentences(content);
    expect(result.split(crossChapterSentence).length - 1).toBe(2);
  });

  it('不同名小节行为不变：跨小节重复句仍删除', () => {
    const content = `### 5.1 施工准备\n${crossChapterSentence}\n### 5.2 施工方法\n${crossChapterSentence}`;
    const result = dedupeCrossSectionDuplicateSentences(content);
    expect(result.split(crossChapterSentence).length - 1).toBe(1);
  });
});

describe('callBreakdownTopSummary / callBreakdownTopDetails（4.1 per-调用分量 Top5 展示）', () => {
  const bucket = (calls: number, inputChars: number, l3Chars = 0, cacheHitTokens = 0, cacheMissTokens = 0) => ({ calls, inputChars, l3Chars, cacheHitTokens, cacheMissTokens });

  it('按输入字符降序取 Top5，message 摘要为「key 次数/万字」', () => {
    const breakdown = {
      'repair:c1': bucket(2, 120000, 80000),
      'draft:c2': bucket(1, 50000),
      '(none)': bucket(6, 30000),
      small1: bucket(1, 100),
      small2: bucket(1, 50),
      small3: bucket(1, 10),
    };
    const summary = callBreakdownTopSummary(breakdown);
    expect(summary).toBe('repair:c1 2次/12.0万字，draft:c2 1次/5.0万字，(none) 6次/3.0万字，small1 1次/0.0万字，small2 1次/0.0万字');
    expect(summary).not.toContain('small3');
  });

  it('details 五维度完整行：L3 字符与缓存命中率（无缓存数据省略缓存段）', () => {
    const details = callBreakdownTopDetails({
      'repair:c1': bucket(2, 120000, 80000, 700, 300),
      'draft:c2': bucket(1, 50000, 0, 0, 0),
    });
    expect(details).toEqual([
      'repair:c1：2 次，输入 12.0 万字（L3 8.0 万字），缓存命中 70%（700/1000 token）',
      'draft:c2：1 次，输入 5.0 万字（L3 0.0 万字）',
    ]);
  });

  it('空/undefined breakdown 回退空串与空数组', () => {
    expect(callBreakdownTopSummary(undefined)).toBe('');
    expect(callBreakdownTopDetails(undefined)).toEqual([]);
  });
});

describe('phaseWaterfallDetails（4.2 阶段耗时瀑布完整展示）', () => {
  it('仅保留 phase:* 条目并按开始时间排序，格式为「name：秒 秒」', () => {
    const details = phaseWaterfallDetails([
      { name: 'chapter-draft:c2', startedAt: 500, endedAt: 900, durationMs: 400 },
      { name: 'phase:draft', startedAt: 200, endedAt: 61200, durationMs: 61000 },
      { name: 'phase:plan', startedAt: 100, endedAt: 1600, durationMs: 1500 },
      { name: 'phase:finalize', startedAt: 70000, endedAt: 80500, durationMs: 10500 },
    ]);
    expect(details).toEqual(['phase:plan：1.5 秒', 'phase:draft：61.0 秒', 'phase:finalize：10.5 秒']);
  });

  it('无 phase:* 条目返回空数组', () => {
    expect(phaseWaterfallDetails([{ name: 'chapter-draft:c1', startedAt: 1, endedAt: 2, durationMs: 1 }])).toEqual([]);
    expect(phaseWaterfallDetails([])).toEqual([]);
  });
});

describe('chapterCompletionStatus 写作结构门禁收紧（4.17.8 章节成稿验收线）', () => {
  it('正文非空且无结构缺陷 → success（正常成稿不受影响）', () => {
    expect(chapterCompletionStatus(2400, 2200, ['小节事实密度需优化：技术管理组织'])).toBe('success');
  });
  it('空小节/缺少规划小节结构缺陷 → failed（写作侧结构不达标即如实失败，不再标 success 甩给修复链）', () => {
    expect(chapterCompletionStatus(2400, 2200, ['工程概况 空小节：项目特点、重点、难点分析'])).toBe('failed');
    expect(chapterCompletionStatus(2400, 2200, ['进度计划 缺少规划小节：施工总进度计划表'])).toBe('failed');
  });
  it('空正文或生成失败 → failed（原有口径不变）', () => {
    expect(chapterCompletionStatus(0, 2200, [])).toBe('failed');
    expect(chapterCompletionStatus(2400, 2200, ['未返回有效章节正文'])).toBe('failed');
  });
});
