/**
 * 文本结构类检测器边界矩阵（P1 第 4 批）
 * 覆盖：bodySentencesForSemantic（句子采样）/ paragraphOpeningRepeatIssues（段首机械重复）/
 * overviewRecapCandidates+overviewRecapIssues+stripOverviewRecapBodyLines（概况复述）/
 * closurePhraseDensityCapIssues（闭环密度）/ repeatedWordIssues+collapseRepeatedWords（叠词）/
 * mergeTableLineResidues（表格残行合并）/ duplicateParagraphIssues+stripDuplicateParagraphs（段落重复）/
 * duplicateTableIssues+stripDuplicateTables+stripDuplicateTablesAcrossChapters（表格重复）
 */
import { describe, expect, it } from 'vitest';
import {
  bodySentencesForSemantic, closurePhraseDensityCapIssues, collapseRepeatedWords,
  duplicateParagraphIssues, duplicateTableIssues, mergeTableLineResidues,
  overviewRecapCandidates, overviewRecapIssues, paragraphOpeningRepeatIssues,
  repeatedWordIssues, stripDuplicateParagraphs, stripDuplicateTables,
  stripDuplicateTablesAcrossChapters, stripOverviewRecapBodyLines,
} from '@/services/document-workflow/documentIntegrityChecks';

// ── A. 语义判定句子提取 ──

describe('A1 bodySentencesForSemantic 句子提取', () => {
  it('A1 句长 6 字不提取、8 字提取', () => {
    expect(bodySentencesForSemantic('六字不足。\n一二三四五六七八。')).toEqual(['一二三四五六七八。']);
  });
  it('A1 句长 120 提取、121 不提取', () => {
    const ok = `${'施'.repeat(119)}。`;
    const over = `${'施'.repeat(120)}。`;
    const result = bodySentencesForSemantic(`${ok}\n${over}`);
    expect(result).toEqual([ok]);
  });
  const terminators = ['。', '！', '？', '!', '?', '；', ';'];
  it.each(terminators)('A1 终止符“%s”拆分提取', (terminator) => {
    const result = bodySentencesForSemantic(`首句内容较短${terminator}第二句内容足够长。`);
    expect(result).toEqual(['第二句内容足够长。']);
  });
  it('A1 标题行/表格行/空行跳过', () => {
    const md = '# 一级标题\n## 二级标题\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n\n正文句子内容提取。';
    expect(bodySentencesForSemantic(md)).toEqual(['正文句子内容提取。']);
  });
  it('A1 重复句去重', () => {
    const md = '同一条句子内容重复。\n同一条句子内容重复。\n不同句子内容第二条。';
    expect(bodySentencesForSemantic(md)).toEqual(['同一条句子内容重复。', '不同句子内容第二条。']);
  });
  it('A1 单行多句按终止符拆多条', () => {
    const md = '第一句内容结束。第二句内容结束。第三句内容结束。';
    expect(bodySentencesForSemantic(md).length).toBe(3);
  });
  it('A1 400 句内全量返回', () => {
    const sentences = Array.from({ length: 400 }, (_, i) => `段落编号${i}的施工内容描述。`);
    expect(bodySentencesForSemantic(sentences.join('\n')).length).toBe(400);
  });
  it('A1 401 句 stride=2 均匀采样 201 条', () => {
    const sentences = Array.from({ length: 401 }, (_, i) => `段落编号${i}的施工内容描述。`);
    const result = bodySentencesForSemantic(sentences.join('\n'));
    expect(result.length).toBe(201);
    expect(result[0]).toBe('段落编号0的施工内容描述。');
    expect(result[1]).toBe('段落编号2的施工内容描述。');
  });
});

// ── B. 段首固定开场机械重复 ──

describe('B1 paragraphOpeningRepeatIssues 段首机械重复', () => {
  // PARAGRAPH_START_RE 捕获组 = [^\n|#] 1 字 + {18,60} → 段首句体长度门实为 19~61（不含句号）
  const open = (n: number) => '施'.repeat(n);
  const repeatMd = (body: string, times: number) => Array.from({ length: times }, () => `${body}。`).join('\n\n');

  it.each([
    ['18 字段首句不参与', open(18), 3, 0],
    ['19 字段首句参与', open(19), 3, 1],
    ['20 字段首句参与', open(20), 3, 1],
    ['61 字段首句参与', open(61), 3, 1],
    ['62 字段首句不参与', open(62), 3, 0],
  ] as const)('B1 句长门 %s', (_label, body, times, expected) => {
    expect(paragraphOpeningRepeatIssues(repeatMd(body, times)).length).toBe(expected);
  });
  it.each([
    ['2 次不报', 2, 0],
    ['3 次报', 3, 1],
    ['4 次报', 4, 1],
    ['5 次报', 5, 1],
  ] as const)('B1 次数门 %s', (_label, times, expected) => {
    expect(paragraphOpeningRepeatIssues(repeatMd(open(19), times)).length).toBe(expected);
  });
  it('B1 同构句不同数字同指纹仍报', () => {
    const md = '本工程总占地面积的数值约为12026㎡。\n\n本工程总占地面积的数值约为22027㎡。\n\n本工程总占地面积的数值约为33028㎡。';
    const issues = paragraphOpeningRepeatIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('3 次');
  });
  it('B1 指纹不足 10 字不计数', () => {
    const md = '2026年1月1日至2026年1月2日施工。\n\n2026年1月1日至2026年1月2日施工。\n\n2026年1月1日至2026年1月2日施工。';
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('B1 前 16 字相同后文不同仍同指纹', () => {
    const head = '本工程位于合肥市包河区境内具体位置';
    const md = `${head}为甲。\n\n${head}为乙丙丁。\n\n${head}为戊己庚辛。`;
    const issues = paragraphOpeningRepeatIssues(md);
    expect(issues.length).toBe(1);
  });
  it('B1 标题行后段首句参与', () => {
    const md = `### 编制说明\n${open(19)}。\n\n## 施工方案\n${open(19)}。\n\n## 质量目标\n${open(19)}。`;
    expect(paragraphOpeningRepeatIssues(md).length).toBe(1);
  });
  it('B1 标题行自身不参与', () => {
    const md = `# ${open(19)}。\n\n# ${open(19)}。\n\n# ${open(19)}。`;
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('B1 表格行不参与', () => {
    const md = `| ${open(19)}。|\n\n| ${open(19)}。|\n\n| ${open(19)}。|`;
    expect(paragraphOpeningRepeatIssues(md)).toEqual([]);
  });
  it('B1 句尾标点全半角混用仍同指纹', () => {
    const md = `${open(19)}。\n\n${open(19)}!\n\n${open(19)}？`;
    expect(paragraphOpeningRepeatIssues(md).length).toBe(1);
  });
  it('B1 4 组同指纹最多报 3 条', () => {
    const mk = (body: string) => `${body}。\n\n${body}。\n\n${body}。`;
    const md = `${mk(`甲${open(18)}`)}` +
      `\n\n${mk(`乙${open(18)}`)}` +
      `\n\n${mk(`丙${open(18)}`)}` +
      `\n\n${mk(`丁${open(18)}`)}`;
    expect(paragraphOpeningRepeatIssues(md).length).toBe(3);
  });
});

// ── C. 概况段跨章复述 ──

const RECAP_OPENERS = ['本项目为', '本工程为', '该项目为', '该工程为'] as const;
const S12 = `${'合肥市包河区'}`;

describe('C1 overviewRecapCandidates 结构召回', () => {
  it.each([
    '## 工程概况',
    '## 项目概况',
    '### 基本信息',
  ])('C1 锚点标题“%s”', (heading) => {
    const md = `${heading}\n概况正文内容。\n## 施工方案\n本项目为合肥市包河区境内施工项目。`;
    const result = overviewRecapCandidates(md);
    expect(result.overviewBody).toContain('概况正文内容');
    expect(result.sentences).toEqual(['本项目为合肥市包河区境内施工项目']);
  });
  it.each(RECAP_OPENERS)('C1 开头谱系“%s”', (opener) => {
    const md = `## 工程概况\n概况正文内容。\n## 施工方案\n${opener}合肥市包河区境内施工项目。`;
    const result = overviewRecapCandidates(md);
    expect(result.sentences.length).toBe(1);
  });
  it('C1 无概况标题 overviewBody 为空', () => {
    const md = '## 施工方案\n本项目为合肥市包河区境内施工项目。';
    const result = overviewRecapCandidates(md);
    expect(result.overviewBody).toBe('');
    expect(result.sentences).toEqual(['本项目为合肥市包河区境内施工项目']);
  });
  it('C1 同层级标题闭合区间', () => {
    const md = '## 工程概况\n本项目为概况内容。\n## 施工方案\n本项目为复述内容施工组织安排。';
    const result = overviewRecapCandidates(md);
    expect(result.overviewBody).toContain('概况内容');
    expect(result.sentences).toEqual(['本项目为复述内容施工组织安排']);
  });
  it('C1 更高级标题（H2）闭合 H3 概况区间', () => {
    const md = '### 工程概况\n本项目为概况内容。\n## 施工组织设计\n本项目为复述内容施工组织安排。';
    const result = overviewRecapCandidates(md);
    expect(result.sentences).toEqual(['本项目为复述内容施工组织安排']);
  });
  it('C1 更低级标题（H4）不闭合 H3 概况区间', () => {
    const md = '### 工程概况\n本项目为概况内容。\n#### 1.1 小节\n本项目为区间内句子。';
    const result = overviewRecapCandidates(md);
    expect(result.sentences).toEqual([]);
  });
  it('C1 句长 11 字不收、12 字收、13 字收', () => {
    const md = '## 工程概况\n概况正文。\n## 施工方案\n本项目为施施施施施施施。\n本项目为施施施施施施施施。\n本项目为施施施施施施施施施。';
    const result = overviewRecapCandidates(md);
    expect(result.sentences.length).toBe(2);
    expect(result.sentences[0]).toBe('本项目为施施施施施施施施');
  });
  it('C1 行内多句只取命中起第一句', () => {
    const md = '## 工程概况\n概况正文。\n## 施工方案\n前文铺垫，本项目为合肥市包河区境内施工。第二句不被收集。';
    const result = overviewRecapCandidates(md);
    expect(result.sentences).toEqual(['本项目为合肥市包河区境内施工']);
  });
  it('C1 表格行与标题行开头谱系不入池', () => {
    const md = '## 工程概况\n概况正文。\n## 施工方案\n| 本项目为表格行内容 |\n| --- |\n# 本项目为标题行内容\n本项目为合肥市包河区境内施工。';
    const result = overviewRecapCandidates(md);
    expect(result.sentences).toEqual(['本项目为合肥市包河区境内施工']);
  });
});

describe('C2 overviewRecapIssues 语义判定', () => {
  const base = '## 工程概况\n本项目总建筑面积为两万六千平方米，计划工期五百四十天。\n## 施工方案\n本项目为合肥市包河区境内施工项目。';
  const simAt = (threshold: number) => (_left: string, _right: string) => threshold;
  it('C2 相似度 0.59 不报', () => {
    expect(overviewRecapIssues(base, { semanticSimilarity: simAt(0.59) })).toEqual([]);
  });
  it('C2 相似度 0.6 报', () => {
    expect(overviewRecapIssues(base, { semanticSimilarity: simAt(0.6) }).length).toBe(1);
  });
  it('C2 相似度 0.61 报', () => {
    expect(overviewRecapIssues(base, { semanticSimilarity: simAt(0.61) }).length).toBe(1);
  });
  it('C2 未注入相似度函数不报', () => {
    expect(overviewRecapIssues(base)).toEqual([]);
  });
  it('C2 无概况区不报', () => {
    const md = '## 施工方案\n本项目为合肥市包河区境内施工项目。';
    expect(overviewRecapIssues(md, { semanticSimilarity: simAt(0.9) })).toEqual([]);
  });
  it('C2 复述句 4 处只收 3 处', () => {
    const md = '## 工程概况\n概况正文内容。\n## 施工方案\n本项目为复述甲内容施工安排。\n本项目为复述乙内容施工安排。\n本项目为复述丙内容施工安排。\n本项目为复述丁内容施工安排。';
    const issues = overviewRecapIssues(md, { semanticSimilarity: simAt(0.9) });
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('3 处');
  });
  it('C2 概况区间内开头谱系句不报', () => {
    const md = '## 工程概况\n本项目为概况区内合法句。\n## 施工方案\n本段无复述句。';
    expect(overviewRecapIssues(md, { semanticSimilarity: simAt(0.9) })).toEqual([]);
  });
});

describe('C3 stripOverviewRecapBodyLines 行级清洗', () => {
  const simHigh = (_left: string, _right: string) => 0.8;
  const simLow = (_left: string, _right: string) => 0.4;
  it('C3 达标复述句整行删除', () => {
    const md = '## 工程概况\n概况正文内容。\n## 施工方案\n本项目为合肥市包河区境内施工。\n保留内容行。';
    const result = stripOverviewRecapBodyLines(md, simHigh);
    expect(result).not.toContain('本项目为');
    expect(result).toContain('保留内容行。');
  });
  it('C3 低相似度句保留', () => {
    const md = '## 工程概况\n概况正文内容。\n## 施工方案\n本项目为合肥市包河区境内施工。';
    expect(stripOverviewRecapBodyLines(md, simLow)).toBe(md);
  });
  it('C3 句长不足 12 字保留', () => {
    const md = '## 工程概况\n概况正文内容。\n## 施工方案\n本项目为改建工程。';
    expect(stripOverviewRecapBodyLines(md, simHigh)).toBe(md);
  });
  it('C3 多句行只删达标句', () => {
    const md = '## 工程概况\n概况正文内容。\n## 施工方案\n本项目为合肥市包河区境内施工。本段正常内容保留。';
    const result = stripOverviewRecapBodyLines(md, simHigh);
    expect(result).not.toContain('本项目为合肥市包河区境内施工。');
    expect(result).toContain('本段正常内容保留。');
  });
  it('C3 概况区间行/标题行/表格行不碰', () => {
    const md = '## 工程概况\n本项目为概况区内合法句。\n## 施工方案\n# 本项目为标题行\n| 本项目为表格行 |\n本项目为合肥市包河区境内施工。';
    const result = stripOverviewRecapBodyLines(md, simHigh);
    expect(result).toContain('本项目为概况区内合法句。');
    expect(result).toContain('# 本项目为标题行');
    expect(result).toContain('| 本项目为表格行 |');
    expect(result).not.toContain('本项目为合肥市包河区境内施工。');
  });
  it('C3 无概况区不改动', () => {
    const md = '## 施工方案\n本项目为合肥市包河区境内施工。';
    expect(stripOverviewRecapBodyLines(md, simHigh)).toBe(md);
  });
});

// ── D. 闭环句式密度上限 ──

describe('D1 closurePhraseDensityCapIssues 闭环密度', () => {
  const words = ['销项', '复查', '整改', '闭环'] as const;
  const fill = (n: number) => '施'.repeat(n);
  it('D1 总字数 2999 不检测', () => {
    expect(closurePhraseDensityCapIssues(fill(2999))).toEqual([]);
  });
  it('D1 总字数 3000 无闭环词不报', () => {
    expect(closurePhraseDensityCapIssues(fill(3000))).toEqual([]);
  });
  it('D1 3000 字 8 词密度 2.67 不报', () => {
    const md = '整改'.repeat(8) + fill(3000 - 16);
    expect(closurePhraseDensityCapIssues(md)).toEqual([]);
  });
  it('D1 3000 字 9 词密度 3.0 报（阈值含等于）', () => {
    const md = '整改'.repeat(9) + fill(3000 - 18);
    const issues = closurePhraseDensityCapIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('整改');
  });
  it('D1 3001 字 9 词密度 2.998 不报', () => {
    const md = '整改'.repeat(9) + fill(3001 - 18);
    expect(closurePhraseDensityCapIssues(md)).toEqual([]);
  });
  it('D1 3001 字 10 词密度 3.33 报', () => {
    const md = '整改'.repeat(10) + fill(3001 - 20);
    expect(closurePhraseDensityCapIssues(md).length).toBe(1);
  });
  it.each(words)('D1 四词谱系“%s”各触发', (word) => {
    const md = word.repeat(9) + fill(3000 - 18);
    const issues = closurePhraseDensityCapIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain(word);
  });
  it('D1 多词并存取密度最大词', () => {
    const md = '整改'.repeat(8) + '闭环'.repeat(10) + fill(3000 - 36);
    const issues = closurePhraseDensityCapIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('“闭环”达');
  });
  it('D1 密度相等取词表第一个', () => {
    const md = '整改'.repeat(10) + '销项'.repeat(10) + fill(3000 - 40);
    const issues = closurePhraseDensityCapIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('销项');
  });
  it('D1 HTML 标签内词计入分子、标签不计入分母', () => {
    const md = '<b>整改</b>'.repeat(10) + fill(2980);
    expect(closurePhraseDensityCapIssues(md).length).toBe(1);
  });
  it('D1 断行拆词不计入', () => {
    const md = '整\n改'.repeat(10) + fill(3000 - 30);
    expect(closurePhraseDensityCapIssues(md)).toEqual([]);
  });
  it('D1 报警等级 warning', () => {
    const md = '整改'.repeat(9) + fill(2982);
    const issues = closurePhraseDensityCapIssues(md);
    expect(issues[0].severity).toBe('warning');
  });
});

// ── E. 叠词重复检测与收敛 ──

describe('E1 repeatedWordIssues 叠词检测', () => {
  const words = ['执行执行', '进行进行', '严格严格', '检查检查', '验收验收', '落实落实'];
  it.each(words)('E1 叠词“%s”报', (word) => {
    const issues = repeatedWordIssues(`工程${word}开工。`);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain(word);
  });
  it.each([
    ['串首', (w: string) => `${w}后文内容`],
    ['串中', (w: string) => `前文内容${w}后文内容`],
    ['串尾', (w: string) => `前文内容${w}`],
  ] as const)('E1 位置%s报', (_label, wrap) => {
    expect(repeatedWordIssues(wrap('执行执行')).length).toBe(1);
  });
  it('E1 三叠只报 1 处（Set 去重）', () => {
    const issues = repeatedWordIssues('工程执行执行执行开工。');
    expect(issues.length).toBe(1);
  });
  it('E1 分部分项术语豁免', () => {
    expect(repeatedWordIssues('本工程分部分项划分如下。')).toEqual([]);
  });
  it('E1 前「分」豁免', () => {
    expect(repeatedWordIssues('分执行执行')).toEqual([]);
  });
  it('E1 后「项」豁免', () => {
    expect(repeatedWordIssues('执行执行项')).toEqual([]);
  });
  it('E1 前「分」即豁免（后非项亦豁免）', () => {
    expect(repeatedWordIssues('分执行执行开工')).toEqual([]);
  });
  it('E1 后「项」即豁免（前非分亦豁免）', () => {
    expect(repeatedWordIssues('工程执行执行项')).toEqual([]);
  });
  it('E1 单字三连不报（需双字词重复）', () => {
    expect(repeatedWordIssues('人人人')).toEqual([]);
  });
  it('E1 单字四连报', () => {
    expect(repeatedWordIssues('人人人人').length).toBe(1);
  });
  it('E1 数字叠词不报', () => {
    expect(repeatedWordIssues('2020')).toEqual([]);
  });
  it('E1 跨换行不报（必须紧邻）', () => {
    expect(repeatedWordIssues('执行\n执行')).toEqual([]);
  });
  it('E1 4 种叠词最多报 3 种', () => {
    const md = '执行执行。进行进行。严格严格。检查检查。';
    const issues = repeatedWordIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message.split('、').length).toBe(3);
  });
  it('E1 同词多处去重', () => {
    const issues = repeatedWordIssues('执行执行。执行执行。执行执行。');
    expect(issues.length).toBe(1);
  });
});

describe('E2 collapseRepeatedWords 叠词收敛', () => {
  it('E2 单处收敛', () => {
    expect(collapseRepeatedWords('工程执行执行开工。')).toBe('工程执行开工。');
  });
  it('E2 多处收敛', () => {
    expect(collapseRepeatedWords('执行执行。进行进行。')).toBe('执行。进行。');
  });
  it('E2 三叠收敛一次剩双叠', () => {
    expect(collapseRepeatedWords('执行执行执行')).toBe('执行执行');
  });
  it('E2 分部分项不收敛', () => {
    expect(collapseRepeatedWords('本工程分部分项划分如下。')).toBe('本工程分部分项划分如下。');
  });
  it('E2 后「项」豁免句不收敛', () => {
    expect(collapseRepeatedWords('执行执行项')).toBe('执行执行项');
  });
  it('E2 非重复文本不变', () => {
    expect(collapseRepeatedWords('正常文本内容。')).toBe('正常文本内容。');
  });
});

// ── F. 表格断行残片确定性合并 ──

describe('F1 mergeTableLineResidues 表格残行合并', () => {
  it('F1 标准残行拼回上一行末单元格', () => {
    const result = mergeTableLineResidues('| 分部 | 名称 |\n残行内容 |');
    expect(result.markdown).toBe('| 分部 | 名称 残行内容 |');
    expect(result.fixedCount).toBe(1);
  });
  const puncts = ['，', '。', '；', '、', '：'];
  it.each(puncts)('F1 上单元格以“%s”结尾不加空格', (punct) => {
    const result = mergeTableLineResidues(`| 分部 | 名称${punct}|\n残行内容 |`);
    expect(result.markdown).toBe(`| 分部 | 名称${punct}残行内容 |`);
  });
  it('F1 上一行非表格行不拼', () => {
    const md = '普通正文段落\n残行内容 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('F1 残行以竖线开头不拼', () => {
    const md = '| 表格 | 行 |\n| 残行 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('F1 残行含两个竖线不拼', () => {
    const md = '| 表格 | 行 |\n残行 | 内容 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('F1 残行为标题行不拼', () => {
    const md = '| 表格 | 行 |\n# 残行 |';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('F1 空行不拼', () => {
    const md = '| 表格 | 行 |\n\n';
    expect(mergeTableLineResidues(md).fixedCount).toBe(0);
  });
  it('F1 连续两条残行依次拼回', () => {
    const result = mergeTableLineResidues('| 表格 | 行 |\n残行甲 |\n残行乙 |');
    expect(result.markdown).toBe('| 表格 | 行 残行甲 残行乙 |');
    expect(result.fixedCount).toBe(2);
  });
  it('F1 表格分隔行作上一行时仍拼接（行为锁定）', () => {
    const result = mergeTableLineResidues('| 表格 | 行 |\n| --- | --- |\n残行内容 |');
    expect(result.fixedCount).toBe(1);
    expect(result.markdown).toContain('残行内容');
  });
  it('F1 无残行不改动', () => {
    const md = '| 表格 | 行 |\n| 数据 | 内容 |';
    const result = mergeTableLineResidues(md);
    expect(result.markdown).toBe(md);
    expect(result.fixedCount).toBe(0);
  });
});

// ── G. 段落完全重复 ──

describe('G1 duplicateParagraphIssues 段落重复检测', () => {
  const p = (n: number) => '施'.repeat(n);
  it('G1 段落 39 字不报', () => {
    const md = `${p(39)}\n\n${p(39)}`;
    expect(duplicateParagraphIssues(md)).toEqual([]);
  });
  it('G1 段落 40 字报', () => {
    const md = `${p(40)}\n\n${p(40)}`;
    const issues = duplicateParagraphIssues(md);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('2 次');
  });
  it('G1 段落 41 字报', () => {
    const md = `${p(41)}\n\n${p(41)}`;
    expect(duplicateParagraphIssues(md).length).toBe(1);
  });
  it('G1 仅 1 次不报', () => {
    expect(duplicateParagraphIssues(p(40))).toEqual([]);
  });
  it('G1 3 次报 3 次', () => {
    const md = `${p(40)}\n\n${p(40)}\n\n${p(40)}`;
    expect(duplicateParagraphIssues(md)[0].message).toContain('3 次');
  });
  it('G1 跨行段落与单行同文归一化同指纹', () => {
    const md = `${'施'.repeat(20)}\n${'工'.repeat(20)}\n\n${'施'.repeat(20)}${'工'.repeat(20)}`;
    expect(duplicateParagraphIssues(md).length).toBe(1);
  });
  it('G1 段内空白差异归一化同指纹', () => {
    const md = `${'施'.repeat(20)} ${'工'.repeat(20)}\n\n${'施'.repeat(20)}${'工'.repeat(20)}`;
    expect(duplicateParagraphIssues(md).length).toBe(1);
  });
  it('G1 标题行与表格行不入池', () => {
    const md = `# 标题\n${p(40)}\n| 表 | 行 |\n${p(40)}`;
    expect(duplicateParagraphIssues(md).length).toBe(1);
  });
  it('G1 列表行独立成段', () => {
    const md = `- ${p(40)}\n\n- ${p(40)}`;
    expect(duplicateParagraphIssues(md).length).toBe(1);
  });
  it('G1 列表行与普通段落不同指纹', () => {
    const md = `- ${p(40)}\n\n${p(40)}`;
    expect(duplicateParagraphIssues(md)).toEqual([]);
  });
  it('G1 4 组重复最多报 3 组', () => {
    const md = `${p(40)}\n\n${p(40)}\n\n${'工'.repeat(40)}\n\n${'工'.repeat(40)}\n\n${'甲'.repeat(40)}\n\n${'甲'.repeat(40)}\n\n${'乙'.repeat(40)}\n\n${'乙'.repeat(40)}`;
    expect(duplicateParagraphIssues(md).length).toBe(3);
  });
});

describe('G2 stripDuplicateParagraphs 段落重复删除', () => {
  const p = (n: number) => '施'.repeat(n);
  it('G2 保留首次删除后续', () => {
    const md = `${p(40)}\n\n${p(40)}\n\n${p(40)}`;
    const result = stripDuplicateParagraphs(md);
    expect(result.removedCount).toBe(2);
    expect(result.markdown.split('\n').filter(line => line === p(40)).length).toBe(1);
  });
  it('G2 标题行与表格行不删', () => {
    const md = `# 标题\n${p(40)}\n| 表 | 行 |\n${p(40)}`;
    const result = stripDuplicateParagraphs(md);
    expect(result.removedCount).toBe(1);
    expect(result.markdown).toContain('# 标题');
    expect(result.markdown).toContain('| 表 | 行 |');
  });
  it('G2 列表行重复删除', () => {
    const md = `- ${p(40)}\n\n- ${p(40)}`;
    const result = stripDuplicateParagraphs(md);
    expect(result.removedCount).toBe(1);
  });
  it('G2 无重复不改动', () => {
    const md = `${p(40)}\n\n${'工'.repeat(40)}`;
    const result = stripDuplicateParagraphs(md);
    expect(result.markdown).toBe(md);
    expect(result.removedCount).toBe(0);
  });
});

// ── H. 表格重复 ──

describe('H1 duplicateTableIssues 表格重复检测', () => {
  const table = (rows: string[]) => ['| 序号 | 阶段 | 人数 |', '| --- | --- | --- |', ...rows].join('\n');
  const tA = table(['| 1 | 准备 | 20 |', '| 2 | 主体 | 30 |']);
  it('H1 完全一致表报（表头同+数据重合）', () => {
    const issues = duplicateTableIssues(`${tA}\n\n${tA}`);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('表格重复');
  });
  it('H1 表头同数据大半重合报（数据重合 0.71）', () => {
    const tB = table(['| 1 | 准备 | 20 |', '| 2 | 主体 | 35 |']);
    expect(duplicateTableIssues(`${tA}\n\n${tB}`).length).toBe(1);
  });
  it('H1 表头同结构不同内容不报（首列零重合）', () => {
    const tB = table(['| 甲 | 装修 | 20 |', '| 乙 | 收尾 | 30 |']);
    expect(duplicateTableIssues(`${tA}\n\n${tB}`)).toEqual([]);
  });
  it('H1 表头相似 0.71+首列全同报（路径②）', () => {
    const tB = ['| 序号 | 阶段 | 投入人数 | 备注 | 负责人 | 周期 |', '| --- | --- | --- | --- | --- | --- |', '| 1 | 准备 | 20 | 甲 | 乙 | 3 |', '| 2 | 主体 | 30 | 丙 | 丁 | 5 |'].join('\n');
    expect(duplicateTableIssues(`${tA}\n\n${tB}`).length).toBe(1);
  });
  it('H1 同主题不同表头报（路径③：首列+文本覆盖）', () => {
    const tB = ['| 编号 | 施工阶段 | 劳动力 |', '| --- | --- | --- |', '| 1 | 准备 | 22 |', '| 2 | 主体 | 33 |'].join('\n');
    expect(duplicateTableIssues(`${tA}\n\n${tB}`).length).toBe(1);
  });
  it('H1 互补表不报（数字共享+文本独有）', () => {
    const tB = ['| 阶段 | 工序 | 劳动力 |', '| --- | --- | --- |', '| 准备 | 养护 | 35 |', '| 主体 | 验收 | 55 |'].join('\n');
    const tC = ['| 阶段 | 工序 | 人数 |', '| --- | --- | --- |', '| 准备 | 清表 | 20 |', '| 主体 | 砌筑 | 30 |'].join('\n');
    expect(duplicateTableIssues(`${tC}\n\n${tB}`)).toEqual([]);
  });
  it('H1 单表不报', () => {
    expect(duplicateTableIssues(tA)).toEqual([]);
  });
  it('H1 连排两表（无空行）切分后报', () => {
    expect(duplicateTableIssues(`${tA}\n${tA}`).length).toBe(1);
  });
  it('H1 无分隔行残留粘贴表头切分后报', () => {
    const md = '| 序号 | 阶段 | 人数 |\n| --- | --- | --- |\n| 1 | 准备 | 20 |\n| 序号 | 阶段 | 人数 |\n| 1 | 准备 | 20 |';
    expect(duplicateTableIssues(md).length).toBe(1);
  });
});

describe('H2 stripDuplicateTables 表格重复删除', () => {
  const table = (rows: string[]) => ['| 序号 | 阶段 | 人数 |', '| --- | --- | --- |', ...rows].join('\n');
  it('H2 两张相同表删后者', () => {
    const t = table(['| 1 | 准备 | 20 |']);
    const result = stripDuplicateTables(`${t}\n\n${t}`);
    expect(result.removedCount).toBe(3);
    expect(result.removedLineNumbers?.length).toBe(3);
    expect(result.markdown.split('\n').filter(line => line.includes('准备')).length).toBe(1);
  });
  it('H2 保留信息量大者（数据行多）', () => {
    const big = table(['| 1 | 准备 | 20 |', '| 2 | 主体 | 30 |', '| 3 | 收尾 | 40 |']);
    const small = table(['| 1 | 准备 | 20 |', '| 2 | 主体 | 30 |']);
    const result = stripDuplicateTables(`${small}\n\n${big}`);
    expect(result.removedCount).toBe(4);
    expect(result.removedLineNumbers).toEqual([0, 1, 2, 3]);
    expect(result.markdown).toContain('收尾');
  });
  it('H2 无重复不改动', () => {
    const t = table(['| 1 | 准备 | 20 |']);
    const u = ['| 序号 | 分项 |', '| --- | --- |', '| 1 | 装修 |'].join('\n');
    const result = stripDuplicateTables(`${t}\n\n${u}`);
    expect(result.removedCount).toBe(0);
    expect(result.markdown).toBe(`${t}\n\n${u}`);
  });
});

describe('H3 stripDuplicateTablesAcrossChapters 跨章表格去重', () => {
  it('H3 四章复制表删三处', () => {
    const t = '| 序号 | 阶段 | 人数 |\n| --- | --- | --- |\n| 1 | 准备 | 20 |';
    const chapters = [{ content: t }, { content: t }, { content: t }, { content: t }];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(9);
    expect(result.chapterFixed).toBe(3);
    expect(chapters[0].content).toBe(t);
    expect(chapters[1].content).not.toContain('准备');
  });
  it('H3 无重复跨章不改动', () => {
    const a = '| 序号 | 阶段 |\n| --- | --- |\n| 1 | 准备 |';
    const b = '| 编号 | 阶段 |\n| --- | --- |\n| 1 | 装修 |';
    const chapters = [{ content: a }, { content: b }];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(0);
    expect(result.chapterFixed).toBe(0);
  });
  it('H3 章节内容带尾换行时映射仍正确', () => {
    const t = '| 序号 | 阶段 | 人数 |\n| --- | --- | --- |\n| 1 | 准备 | 20 |';
    const chapters = [{ content: `${t}\n` }, { content: `${t}\n` }, { content: `${t}\n` }];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(6);
    expect(result.chapterFixed).toBe(2);
    expect(chapters[0].content).toBe(`${t}\n`);
    expect(chapters[1].content).toBe('');
  });
});
