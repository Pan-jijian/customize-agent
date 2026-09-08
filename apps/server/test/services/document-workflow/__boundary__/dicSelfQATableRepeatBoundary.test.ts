/**
 * dicSelfQATableRepeatBoundary：第二十六批（CC 组）覆盖增量（与既有基线互补、不重复）：
 *  - CC1 fixSelfUnderminingCandidates：捕获组回填产物/窗口精确边界/规则互作/多处计数/幂等
 *    （基线 B 段只测各规则单命中与变体）；
 *  - CC2 fixQualityAssuranceCoverage：六词门槛矩阵（hitCount 0/1/2/3/6）/6.2 与六七章截断/块尾插入位置
 *    （基线 I1/I2/Jc 只测单形态）；
 *  - CC3 stripDuplicateTablesAcrossChapters：三章同表/无尾换行/单章内重复/首末章同表
 *    （基线 K8 只测两章同表与无重复）；
 *  - CC4 repeatedWordIssues/collapseRepeatedWords：三连叠词单次 replace 不收敛/分项双重豁免/多词聚合/截断
 *    （基线 P1 只测常规收敛与共享正则 lastIndex）；
 *  - CC5 stripDuplicateTables 判定三分支：headerSame+dataSim/headerSim+firstColSim/firstColSim+dataCoverage
 *    与 keep 规则（bodyChars 大者保留）、行号排序（基线只测跨章调用）。
 * 全部为确定性正则提取与词面判定，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  collapseRepeatedWords, fixQualityAssuranceCoverage, fixSelfUnderminingCandidates,
  repeatedWordIssues, stripDuplicateTables, stripDuplicateTablesAcrossChapters,
} from '@/services/document-workflow/documentIntegrityChecks';

// ── CC1. fixSelfUnderminingCandidates：捕获组回填与窗口边界 ──

describe('CC1 fixSelfUndermining 捕获组回填产物', () => {
  it('CC1 规则7 $1 回填（依据文本保留 + to 固定尾词）', () => {
    const result = fixSelfUnderminingCandidates('涉及危险性较大的分部分项工程，我公司将依据住房和城乡建设部令第37号规定，在施工前单独编制专项施工方案并履行审批程序。');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toBe('本工程危险性较大的分部分项工程管理执行住房和城乡建设部令第37号规定规定：施工前编制专项施工方案，履行审批程序后实施。');
  });
  it('CC1 规则11 双捕获 $1/$2 回填（第270日/第300日）', () => {
    const result = fixSelfUnderminingCandidates('项目部在开工令下发后第270日亮化及附属设施安装完成后，随即启动竣工清理与验收移交程序，确保开工令下发后第300日完成全部验收移交工作');
    expect(result.markdown).toContain('亮化及附属设施安装于开工令下发后第270日完成');
    expect(result.markdown).toContain('开工令下发后第300日全部验收移交工作完成');
  });
  it('CC1 规则12 $1 回填（24小时提前通知）', () => {
    const result = fixSelfUnderminingCandidates('隐蔽工程在施工过程中已按24小时提前通知要求完成验收，竣工阶段不再重复检验，但须将全部隐蔽验收影像资料纳入竣工资料归档');
    expect(result.markdown).toContain('隐蔽工程按24小时提前通知要求组织验收');
  });
  it('CC1 规则9 $1 回填（修正内容保留）', () => {
    const result = fixSelfUnderminingCandidates('补疑文件对施工内容作出以下明确修正：调整土方开挖分层方案。上述修正内容已纳入本施工组织设计对应分项方案，施工过程中不再另行变更。');
    expect(result.markdown).toBe('招标文件补疑明确：调整土方开挖分层方案。上述内容已纳入本施工组织设计对应分项方案并统一执行。');
  });
});

describe('CC1 fixSelfUndermining 窗口精确边界', () => {
  it('CC1 规则2 前窗 18 字内命中', () => {
    expect(fixSelfUnderminingCandidates(`发现${'甲'.repeat(18)}缺项时在2小时内补测。`).fixedCount).toBe(1);
  });
  it('CC1 规则2 前窗 19 字超界不命中', () => {
    expect(fixSelfUnderminingCandidates(`发现${'甲'.repeat(19)}缺项时在2小时内补测。`).fixedCount).toBe(0);
  });
  it('CC1 规则2 中窗 24 字内命中', () => {
    expect(fixSelfUnderminingCandidates(`发现缺项${'乙'.repeat(24)}时在2小时内补测。`).fixedCount).toBe(1);
  });
  it('CC1 规则2 中窗 25 字超界不命中', () => {
    expect(fixSelfUnderminingCandidates(`发现缺项${'乙'.repeat(25)}时在2小时内补测。`).fixedCount).toBe(0);
  });
  it('CC1 规则2 后窗 10 字内命中', () => {
    expect(fixSelfUnderminingCandidates(`发现缺项时在2小时内${'丙'.repeat(10)}补测。`).fixedCount).toBe(1);
  });
  it('CC1 规则2 后窗 11 字超界不命中', () => {
    expect(fixSelfUnderminingCandidates(`发现缺项时在2小时内${'丙'.repeat(11)}补测。`).fixedCount).toBe(0);
  });
  it('CC1 规则3 20 字窗口内命中', () => {
    expect(fixSelfUnderminingCandidates(`确保${'丁'.repeat(20)}与施工组织设计的一致性。`).fixedCount).toBe(1);
  });
  it('CC1 规则3 21 字超界不命中', () => {
    expect(fixSelfUnderminingCandidates(`确保${'丁'.repeat(21)}与施工组织设计的一致性。`).fixedCount).toBe(0);
  });
  it('CC1 规则13 地点最短 2 字命中', () => {
    expect(fixSelfUnderminingCandidates('本施工组织设计的编制边界为：本项目位于皖县，以补疑澄清文件对清单及图纸的修正口径为优先执行依据。').fixedCount).toBe(1);
  });
  it('CC1 规则17 无句尾句号变体仍命中（。? 可空）', () => {
    expect(fixSelfUnderminingCandidates('收尾阶段安排10个日历天，项目经理组织各分组施工员进行内部预验收，预验收通过后组织竣工验收').fixedCount).toBe(1);
  });
});

describe('CC1 fixSelfUndermining 规则互作与计数', () => {
  it('CC1 规则1+4 同文 → details 按规则表顺序两条', () => {
    const result = fixSelfUnderminingCandidates('施工过程中如涉及危险性较大的分部分项工程，未经审批不得实施。本工程不允许分包，由我公司项目部组织实施。');
    expect(result.fixedCount).toBe(2);
    expect(result.details).toHaveLength(2);
    expect(result.details[0]).toContain('危大「如涉及」假设表述');
    expect(result.details[1]).toContain('不允许分包');
  });
  it('CC1 规则6 同句两处 → 计数 2 处', () => {
    const result = fixSelfUnderminingCandidates('杜绝施工过程中以工程量组价缺失为由提出变更申请；杜绝施工过程中以工程量组价缺失为由提出变更申请');
    expect(result.fixedCount).toBe(2);
    expect(result.details).toEqual(['「组价缺失」短板暴露改写为开工前核对闭环 2 处']);
  });
  it('CC1 规则1 产物幂等（二次运行零命中）', () => {
    const once = fixSelfUnderminingCandidates('施工过程中如涉及危险性较大的分部分项工程，未经审批不得实施。');
    const twice = fixSelfUnderminingCandidates(once.markdown);
    expect(twice.fixedCount).toBe(0);
    expect(twice.markdown).toBe(once.markdown);
  });
  it('CC1 规则7 产物不重匹配（含「我公司将依据」前置句不再命中）', () => {
    const once = fixSelfUnderminingCandidates('涉及危险性较大的分部分项工程，我公司将依据第37号令，在施工前单独编制专项施工方案并履行审批程序。');
    expect(fixSelfUnderminingCandidates(once.markdown).fixedCount).toBe(0);
  });
});

// ── CC2. fixQualityAssuranceCoverage：六词门槛矩阵 ──

describe('CC2 fixQualityAssurance 六词门槛矩阵', () => {
  const BLOCK = (terms: string) => `### 6.1 施工部署与施工流水组织\n\n${terms}\n`;
  it('CC2 hitCount=0 → 补写 details 6/6 缺失', () => {
    const result = fixQualityAssuranceCoverage(BLOCK('本工程按流水段组织施工。'));
    expect(result.fixedCount).toBe(1);
    expect(result.details).toEqual(['6.1 施工部署块补全质量保障协同段（核心术语 6/6 缺失）']);
  });
  it('CC2 hitCount=1 → 5/6 缺失', () => {
    const result = fixQualityAssuranceCoverage(BLOCK('本项目实行三检制。'));
    expect(result.details[0]).toContain('核心术语 5/6 缺失');
  });
  it('CC2 hitCount=2 → 4/6 缺失', () => {
    const result = fixQualityAssuranceCoverage(BLOCK('本项目实行三检制，推行样板引路制度。'));
    expect(result.fixedCount).toBe(1);
    expect(result.details[0]).toContain('核心术语 4/6 缺失');
  });
  it('CC2 hitCount=3 恰门槛 → 不补写', () => {
    const result = fixQualityAssuranceCoverage(BLOCK('本项目实行三检制，推行样板引路制度，隐蔽工程执行隐蔽验收。'));
    expect(result.fixedCount).toBe(0);
    expect(result.details).toEqual([]);
  });
  const coreTerms = ['三检', '样板引路', '隐蔽验收', '见证取样', '试块养护', '分部分项报验'];
  it.each(coreTerms)('CC2 单词「%s」命中 → hitCount=1 补写', (term) => {
    const result = fixQualityAssuranceCoverage(BLOCK(`本项目落实${term}要求。`));
    expect(result.fixedCount).toBe(1);
  });
  it('CC2 六词全命中 → 不补写', () => {
    const result = fixQualityAssuranceCoverage(BLOCK('本项目实行三检制，推行样板引路制度，隐蔽工程执行隐蔽验收，原材料按见证取样送检，混凝土试块落实试块养护，严格执行分部分项报验程序。'));
    expect(result.fixedCount).toBe(0);
  });
});

describe('CC2 fixQualityAssurance 块边界与插入位置', () => {
  it('CC2 6.1 块止于 6.2 标题前，插入在 6.2 之前', () => {
    const md = '### 6.1 施工部署与施工流水组织\n\n本工程按流水段组织施工。\n\n### 6.2 施工进度计划\n\n进度内容。';
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
    const injectedAt = result.markdown.indexOf('质量保障体系与安全文明管理同频运行');
    expect(injectedAt).toBeGreaterThan(-1);
    expect(injectedAt).toBeLessThan(result.markdown.indexOf('### 6.2'));
  });
  it('CC2 6.1 块止于第七章标题', () => {
    const md = '### 6.1 施工部署与施工流水组织\n\n本工程按流水段组织施工。\n\n## 第七章 确保工程质量的措施\n\n质量内容。';
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.indexOf('质量保障体系与安全文明管理同频运行')).toBeLessThan(result.markdown.indexOf('## 第七章'));
  });
  it('CC2 6.1 块止于第六章标题', () => {
    const md = '### 6.1 施工部署与施工流水组织\n\n本工程按流水段组织施工。\n\n## 第六章 劳动力计划\n\n计划内容。';
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.indexOf('质量保障体系与安全文明管理同频运行')).toBeLessThan(result.markdown.indexOf('## 第六章'));
  });
  it('CC2 标题近似但不精确（施工部署与流水组织）→ 零命中', () => {
    expect(fixQualityAssuranceCoverage('### 6.1 施工部署与流水组织\n\n本工程按流水段组织施工。').fixedCount).toBe(0);
  });
  it('CC2 文档尾截断（无 6.2 无第七章）→ 补写', () => {
    const md = '### 6.1 施工部署与施工流水组织\n\n本工程按流水段组织施工。';
    const result = fixQualityAssuranceCoverage(md);
    expect(result.fixedCount).toBe(1);
    expect(result.markdown.endsWith('逐级落实。')).toBe(true);
  });
});

// ── CC3. stripDuplicateTablesAcrossChapters：行号映射深挖 ──

describe('CC3 stripDuplicateTablesAcrossChapters 行号映射', () => {
  const TABLE = '| 阶段 | 人数 |\n| --- | --- |\n| 高峰 | 100人 |';
  it('CC3 三章同表 → 删后两章 removedCount=6 chapterFixed=2', () => {
    const chapters = [
      { content: `## 一、劳动力计划\n${TABLE}\n` },
      { content: `## 二、劳动力复核\n${TABLE}\n` },
      { content: `## 三、劳动力对照\n${TABLE}\n` },
    ];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(6);
    expect(result.chapterFixed).toBe(2);
    expect(chapters[0].content).toContain('| 高峰 | 100人 |');
    expect(chapters[1].content).not.toContain('| 高峰 |');
    expect(chapters[2].content).not.toContain('| 高峰 |');
    expect(chapters[1].content).toContain('## 二、劳动力复核');
    expect(chapters[2].content).toContain('## 三、劳动力对照');
  });
  it('CC3 章节无尾换行 → 行号映射不错位', () => {
    const chapters = [
      { content: `## 一、劳动力计划\n${TABLE}` },
      { content: `## 二、劳动力复核\n${TABLE}` },
    ];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(3);
    expect(result.chapterFixed).toBe(1);
    expect(chapters[0].content).toContain('| 高峰 | 100人 |');
    expect(chapters[1].content).not.toContain('| 高峰 |');
  });
  it('CC3 首末章同表、中间章不同 → 删末章', () => {
    const chapters = [
      { content: `## 一、劳动力计划\n${TABLE}\n` },
      { content: '## 二、机械计划\n| 设备 | 台数 |\n| --- | --- |\n| 塔吊 | 2台 |\n' },
      { content: `## 三、劳动力对照\n${TABLE}\n` },
    ];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(3);
    expect(result.chapterFixed).toBe(1);
    expect(chapters[0].content).toContain('| 高峰 | 100人 |');
    expect(chapters[2].content).not.toContain('| 高峰 |');
    expect(chapters[1].content).toContain('| 塔吊 | 2台 |');
  });
  it('CC3 单章内两重复表 → 章内删除 chapterFixed=1', () => {
    const chapters = [
      { content: `## 一、劳动力计划\n${TABLE}\n\n${TABLE}\n` },
    ];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(3);
    expect(result.chapterFixed).toBe(1);
    expect(chapters[0].content.split('| 高峰 | 100人 |').length).toBe(2);
  });
  it('CC3 同表头同首列不同数据（100人 vs 85人）→ 分支2 命中删后章表', () => {
    const chapters = [
      { content: '## 一、劳动力计划\n| 阶段 | 人数 |\n| --- | --- |\n| 高峰 | 100人 |\n' },
      { content: '## 二、劳动力计划\n| 阶段 | 人数 |\n| --- | --- |\n| 高峰 | 85人 |\n' },
    ];
    // 真实行为：headerSim=1（表头同）+firstColSim=1（首列「高峰」同）→ 分支2 命中删除后章表，
    // 人数差异（100/85）不参与判定（dataSim 仅在分支1 参与），属实现判定宽松的设计语义
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(3);
    expect(result.chapterFixed).toBe(1);
    expect(chapters[0].content).toContain('| 高峰 | 100人 |');
    expect(chapters[1].content).not.toContain('| 高峰 |');
    expect(chapters[1].content).toContain('## 二、劳动力计划');
  });
  it('CC3 空章 content 正常跳过', () => {
    const chapters = [
      { content: '' },
      { content: `## 一、劳动力计划\n${TABLE}\n` },
      { content: `## 二、劳动力复核\n${TABLE}\n` },
    ];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(3);
    expect(result.chapterFixed).toBe(1);
    expect(chapters[2].content).not.toContain('| 高峰 |');
  });
});

// ── CC4. 叠词检测与收敛边界 ──

describe('CC4 collapseRepeatedWords 三连与豁免', () => {
  it('CC4 三连叠词单次 replace 不收敛（执行执行执行 → 执行执行）', () => {
    expect(collapseRepeatedWords('执行执行执行')).toBe('执行执行');
  });
  it('CC4 常规双叠词收敛', () => {
    expect(collapseRepeatedWords('进行进行')).toBe('进行');
  });
  it('CC4 无前后分项环绕的「部分部分」收敛', () => {
    expect(collapseRepeatedWords('部分部分')).toBe('部分');
  });
  it('CC4 「分部分部分项」前段「分部分部」先匹配收敛（尾部「部分项」豁免）', () => {
    // 真实行为：位置0「分部」前无「分」lookbehind 通过，「分部」+「分部」先匹配
    // （其后的「分」非「项」不触发 (?!项) 豁免）→ 收敛为「分部分项」
    expect(collapseRepeatedWords('分部分部分项')).toBe('分部分项');
  });
  it('CC4 「部分部分项」尾随「项」豁免原样保留', () => {
    expect(collapseRepeatedWords('部分部分项')).toBe('部分部分项');
  });
  it('CC4 多处叠词全部收敛', () => {
    expect(collapseRepeatedWords('执行执行，进行进行。')).toBe('执行，进行。');
  });
  it('CC4 空串 → 空串', () => {
    expect(collapseRepeatedWords('')).toBe('');
  });
});

describe('CC4 repeatedWordIssues 聚合与截断', () => {
  it('CC4 多词聚合为 1 条 message', () => {
    const issues = repeatedWordIssues('执行执行。进行进行。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('“执行执行”');
    expect(issues[0].message).toContain('“进行进行”');
  });
  it('CC4 同词多处 Set 去重只报一次', () => {
    const issues = repeatedWordIssues('执行执行。执行执行。执行执行。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).not.toMatch(/执行执行.*执行执行/);
  });
  it('CC4 4 词只报前 3（slice 上限）', () => {
    // REPEATED_WORD_RE 匹配两字词四连（单字两连如「甲甲」不命中），用真实四连词构造
    const issues = repeatedWordIssues('执行执行。进行进行。落实落实。检查检查。');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('“执行执行”');
    expect(issues[0].message).toContain('“落实落实”');
    expect(issues[0].message).not.toContain('“检查检查”');
  });
  it('CC4 无叠词 → 空', () => {
    expect(repeatedWordIssues('正常文本没有叠词。')).toEqual([]);
  });
  it('CC4 「分部分项」术语不报', () => {
    expect(repeatedWordIssues('全部分部分项内容。')).toEqual([]);
  });
});

// ── CC5. stripDuplicateTables 判定三分支与 keep 规则 ──

describe('CC5 stripDuplicateTables 判定三分支', () => {
  it('CC5 分支1 同表头同数据 → 删后表行、前导标题行保留', () => {
    const md = '## 一\n| A | B |\n| - | - |\n| 1 | 2 |\n\n## 二\n| A | B |\n| - | - |\n| 1 | 2 |\n';
    const result = stripDuplicateTables(md);
    expect(result.removedCount).toBe(3);
    // 真实行为：删除范围只含表行（表头+分隔+数据），前导标题「## 二」保留
    expect(result.markdown).toContain('## 二');
    expect(result.markdown.split('| 1 | 2 |').length).toBe(2);
  });
  it('CC5 分支2 表头相似+首列同（数据异）→ 删 bodyChars 小的表1', () => {
    const md = '## 一\n| A | B | C | D | E | F | G |\n| - | - | - | - | - | - | - |\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 |\n\n## 二\n| A | B | C | D | E | F | X |\n| - | - | - | - | - | - | - |\n| 1 | 12 | 13 | 14 | 15 | 16 | 17 |\n';
    const result = stripDuplicateTables(md);
    expect(result.removedCount).toBe(3);
    // 真实行为：表2 数据双位数 bodyChars 更大 → 保留表2 删表1
    expect(result.markdown).toContain('| 1 | 12 | 13 |');
    expect(result.markdown).not.toContain('| 1 | 2 | 3 | 4 | 5 | 6 | 7 |');
  });
  it('CC5 分支3 首列同+数据覆盖（表头异）→ 删', () => {
    const md = '## 一\n| 部位 | 规格 |\n| --- | --- |\n| 垫层 | C15 |\n| 主体 | C30 |\n| 屋面 | C25 |\n\n## 二\n| 位置 | 标号 |\n| --- | --- |\n| 垫层 | C15 |\n| 主体 | C30 |\n| 屋面 | C25 |\n';
    const result = stripDuplicateTables(md);
    // 真实行为：表2 共 5 行（表头+分隔+3 数据行）全部删除
    expect(result.removedCount).toBe(5);
    expect(result.markdown).toContain('| 部位 | 规格 |');
    expect(result.markdown).not.toContain('| 位置 | 标号 |');
  });
  it('CC5 三分支均不满足（同结构不同内容）→ 不删', () => {
    const md = '## 一\n| A | B |\n| - | - |\n| 1 | 2 |\n\n## 二\n| A | B |\n| - | - |\n| 3 | 4 |\n';
    const result = stripDuplicateTables(md);
    expect(result.removedCount).toBe(0);
    expect(result.markdown).toContain('| 3 | 4 |');
  });
  it('CC5 keep 规则：bodyChars 大者保留（3 行 vs 4 行数据删小表）', () => {
    const md = '## 一\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n\n## 二\n| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n| 7 | 8 |\n';
    const result = stripDuplicateTables(md);
    // 分支1 命中（headerSame 且 dataSim=3/4=0.75≥0.6），bodyChars 大的表2 保留、表1 删除（表1 共 5 行）
    expect(result.removedCount).toBe(5);
    expect(result.markdown).toContain('## 一');
    expect(result.markdown).toContain('| 7 | 8 |');
    expect(result.markdown.split('| 1 | 2 |').length).toBe(2);
  });
  it('CC5 removedLineNumbers 升序排列', () => {
    const md = '## 一\n| A | B |\n| - | - |\n| 1 | 2 |\n\n## 二\n| A | B |\n| - | - |\n| 1 | 2 |\n';
    const result = stripDuplicateTables(md);
    // 真实行为：行号为 0-based，表2 三行（表头/分隔/数据）位于 6/7/8
    expect(result.removedLineNumbers).toEqual([6, 7, 8]);
  });
  it('CC5 单表 → removedCount 0 无行号', () => {
    const result = stripDuplicateTables('| A | B |\n| - | - |\n| 1 | 2 |\n');
    expect(result.removedCount).toBe(0);
    expect(result.removedLineNumbers).toBeUndefined();
  });
});
