/**
 * dicParagraphTriadResidueBoundary：第二十一批增量深挖（X 组）。
 * 覆盖增量维度（与既有批次基线互补，不重复）：
 *  - X1 duplicateParagraphIssues/stripDuplicateParagraphs 增量：标题/表格/列表行切断 buffer、
 *    标点计入指纹、跨行段落删除行数、空白归一阈值、message 截断；
 *  - X2 resourceTriadSectionHierarchyIssues 增量：章标题分隔符负例、H3 缺「与措施」后缀、
 *    H4 退化形态挂错、H4 无主语、错位+不完整同时报、多章独立判定、主语重复；
 *  - X3 foundationFormResidueIssues 增量：slice(0,5)/slice(0,48)、H4 块匹配、H2 不匹配、
 *    多块豁免、同行两处去重、块边界与标题行不计；
 *  - X4 basicInfoScheduleFieldIssues（全新）：合法值/8 违约词谱系/表格行格式/空值/截断/slice(0,2)；
 *  - X5 stripDuplicateTables/stripDuplicateTablesAcrossChapters（全新）：删除行数与行号、
 *    bodyChars 保留方、判定三分支、三表链、连排表切分、跨章行号映射。
 * 全部为确定性正则/数值比较，无语义依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  basicInfoScheduleFieldIssues,
  duplicateParagraphIssues,
  foundationFormResidueIssues,
  resourceTriadSectionHierarchyIssues,
  stripDuplicateParagraphs,
  stripDuplicateTables,
  stripDuplicateTablesAcrossChapters,
} from '@/services/document-workflow/documentIntegrityChecks';

// ── X1. duplicateParagraphIssues / stripDuplicateParagraphs 增量 ──

const p = (n: number) => '施'.repeat(n);

describe('X1 段落重复：buffer 切断语义', () => {
  it('X1-1 标题行切断跨行段落：两小段各 20 字无指纹 → 不报', () => {
    const md = `${p(20)}\n## 中间标题\n${'工'.repeat(20)}\n\n${p(20)}\n## 中间标题\n${'工'.repeat(20)}`;
    expect(duplicateParagraphIssues(md)).toEqual([]);
  });
  it('X1-2 无标题行切割的同文 40 字两段 → 报（对照）', () => {
    const md = `${p(20)}${'工'.repeat(20)}\n\n${p(20)}${'工'.repeat(20)}`;
    expect(duplicateParagraphIssues(md)).toHaveLength(1);
  });
  it('X1-3 表格行切断跨行段落 → 两小段无指纹不报', () => {
    const md = `${p(20)}\n| 表格 | 行 |\n${'工'.repeat(20)}\n\n${p(20)}\n| 表格 | 行 |\n${'工'.repeat(20)}`;
    expect(duplicateParagraphIssues(md)).toEqual([]);
  });
  it('X1-4 列表行前普通段落独立 flush：前段与后段不同指纹 → 不报', () => {
    const md = `${p(40)}\n- 列表项文字\n${p(40)}`;
    expect(duplicateParagraphIssues(md)).toHaveLength(1);
  });
  it('X1-5 列表行与普通段落指纹不同（列表前缀计入指纹）→ 不报', () => {
    const md = `- ${p(40)}\n\n${p(40)}`;
    expect(duplicateParagraphIssues(md)).toEqual([]);
  });
  it('X1-6 4 行各 10 字聚合成 40 字段落 → 报', () => {
    const md = `${p(10)}\n${p(10)}\n${p(10)}\n${p(10)}\n\n${p(10)}\n${p(10)}\n${p(10)}\n${p(10)}`;
    expect(duplicateParagraphIssues(md)).toHaveLength(1);
  });
  it('X1-7 段落内标点计入指纹：句号与逗号不同指纹 → 不报', () => {
    const md = `${p(20)}，${p(20)}。\n\n${p(20)}。${p(20)}。`;
    expect(duplicateParagraphIssues(md)).toEqual([]);
  });
  it('X1-8 空白归一后 <40 字无指纹 → 不报', () => {
    const md = `${p(20)} ${p(19)}\n\n${p(20)} ${p(19)}`;
    expect(duplicateParagraphIssues(md)).toEqual([]);
  });
  it('X1-9 空白归一后恰 40 字 → 报', () => {
    const md = `${p(20)} ${p(20)}\n\n${p(20)}${p(20)}`;
    expect(duplicateParagraphIssues(md)).toHaveLength(1);
  });
  it('X1-10 60 字段落 message 指纹截断 slice(0,40)+…', () => {
    const md = `${p(60)}\n\n${p(60)}`;
    const issues = duplicateParagraphIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(`${p(40)}…`);
    expect(issues[0].message).toContain('段落完全重复 2 次');
  });
  it('X1-11 连续两列表行各自成段：同文 → 报', () => {
    const md = `- ${p(40)}\n- ${p(40)}`;
    expect(duplicateParagraphIssues(md)).toHaveLength(1);
  });
  it('X1-12 三段重复中间夹不同段落 → 重复段计数 3 次', () => {
    const md = `${p(40)}\n\n${'工'.repeat(40)}\n\n${p(40)}\n\n${p(40)}`;
    const issues = duplicateParagraphIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3 次');
  });
});

describe('X1 段落重复：strip 删除行为', () => {
  it('X1-13 跨行段落删除按行数计（3 行段 → removedCount=3）', () => {
    const seg = `${p(10)}\n${p(10)}\n${p(30)}`;
    const md = `${seg}\n\n${'工'.repeat(40)}\n\n${seg}`;
    const result = stripDuplicateParagraphs(md);
    expect(result.removedCount).toBe(3);
    expect(result.markdown).toContain('工'.repeat(40));
  });
  it('X1-14 保留首次出现段、删除后续段（首段位置不变）', () => {
    const md = `开头句。\n\n${p(40)}\n\n中间句。\n\n${p(40)}\n\n结尾句。`;
    const result = stripDuplicateParagraphs(md);
    expect(result.markdown.split(p(40)).length - 1).toBe(1);
    expect(result.markdown).toContain('中间句。');
    expect(result.markdown).toContain('结尾句。');
  });
  it('X1-15 标题行/表格行不被删除', () => {
    const md = `# 标题\n${p(40)}\n| 表 | 行 |\n${p(40)}`;
    const result = stripDuplicateParagraphs(md);
    expect(result.removedCount).toBe(1);
    expect(result.markdown).toContain('# 标题');
    expect(result.markdown).toContain('| 表 | 行 |');
  });
  it('X1-16 无重复返回原引用且 removedCount=0', () => {
    const md = `${p(40)}\n\n${'工'.repeat(40)}`;
    const result = stripDuplicateParagraphs(md);
    expect(result.markdown).toBe(md);
    expect(result.removedCount).toBe(0);
  });
  it('X1-17 跨行段落与单行段落同指纹 → 删后段整段', () => {
    const md = `${p(20)}\n${'工'.repeat(20)}\n\n${p(20)}${'工'.repeat(20)}`;
    const result = stripDuplicateParagraphs(md);
    expect(result.removedCount).toBe(1);
    expect(result.markdown.split(p(20)).length - 1).toBe(1);
  });
});

// ── X2. resourceTriadSectionHierarchyIssues 增量 ──

describe('X2 人材机：章标题分隔符负例', () => {
  const NEGATIVES = ['人材机保障体系', '人 材 机保障体系', '人·材·机保障体系', '人才机保障体系'] as const;
  it.each(NEGATIVES)('X2-1 章标题“%s”无合法分隔符 → 不检不报', (title) => {
    const md = `## ${title}\n### 确保人的保障体系与措施\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施`;
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
  it('X2-2 章标题带编号「第六章 人、材、机保障体系」→ 检', () => {
    const md = '## 第六章 人、材、机保障体系\n### 确保人的保障体系与措施';
    expect(resourceTriadSectionHierarchyIssues(md)).toHaveLength(1);
  });
});

describe('X2 人材机：H3 主语提取边界', () => {
  it('X2-3 H3 缺「与措施」后缀（确保人的保障体系）→ 主语不识别 → 三节不全报', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系\n### 确保材的保障体系\n### 确保机的保障体系';
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('结构不完整');
  });
  it('X2-4 H3 主语重复（人、人、材）→ subjects 缺机 → 报不完整', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n### 人员的保障体系与措施\n### 确保材的保障体系与措施';
    expect(resourceTriadSectionHierarchyIssues(md)).toHaveLength(1);
  });
  it('X2-5 H3 全退化形态三主齐全 → 不报', () => {
    const md = '## 人、材、机保障\n### 劳动力组织\n### 物资供应\n### 设备选型';
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
  it('X2-6 混合形态三主齐全（标准+退化）→ 不报', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n### 物资供应\n### 机械设备管理';
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
});

describe('X2 人材机：H4 层级错位增量', () => {
  const triadBody = '### 确保人的保障体系与措施\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施';
  it('X2-7 H4 退化形态挂错（材料管理挂人下）→ 报', () => {
    const md = `## 人、材、机保障\n### 确保人的保障体系与措施\n#### 材料管理\n${triadBody.replace('### 确保人的保障体系与措施\n', '')}`;
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues.some(issue => issue.message.includes('层级错位'))).toBe(true);
  });
  it('X2-8 H4 标准形态人挂材下 → 报', () => {
    const md = `## 人、材、机保障\n### 确保人的保障体系与措施\n### 确保材的保障体系与措施\n#### 人的保障体系与措施\n### 确保机的保障体系与措施`;
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues.some(issue => issue.message.includes('层级错位'))).toBe(true);
  });
  it('X2-9 H4 标准形态机挂人下 → 报且 message 指明不得并入人的保障体系', () => {
    const md = `## 人、材、机保障\n### 确保人的保障体系与措施\n#### 机的保障体系与措施\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施`;
    const issues = resourceTriadSectionHierarchyIssues(md);
    const wrong = issues.find(issue => issue.message.includes('层级错位'));
    expect(wrong).toBeDefined();
    expect(wrong?.message).toContain('不得并入人的保障体系');
  });
  it('X2-10 H4 无主语（细化措施）→ 不报', () => {
    const md = `## 人、材、机保障\n### 确保人的保障体系与措施\n#### 细化措施\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施`;
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
  it('X2-11 H4 同主退化形态（人员配置挂人下）→ 不报', () => {
    const md = `## 人、材、机保障\n### 确保人的保障体系与措施\n#### 人员配置\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施`;
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
  it('X2-12 错位+结构不完整同时报 2 条', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n#### 材料管理';
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues).toHaveLength(2);
    expect(issues.some(issue => issue.message.includes('层级错位'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('结构不完整'))).toBe(true);
  });
  it('X2-13 多章独立判定：两章各报 1 条 → 2 条', () => {
    const md = '## 人、材、机保障\n### 确保人的保障体系与措施\n## 人、材、机保障\n### 确保人的保障体系与措施';
    const issues = resourceTriadSectionHierarchyIssues(md);
    expect(issues).toHaveLength(2);
  });
  it('X2-14 章外 H4 无 currentH3 → 不报', () => {
    const md = '## 人、材、机保障\n#### 材料保障\n### 确保人的保障体系与措施\n### 确保材的保障体系与措施\n### 确保机的保障体系与措施';
    expect(resourceTriadSectionHierarchyIssues(md)).toEqual([]);
  });
});

// ── X3. foundationFormResidueIssues 增量 ──

describe('X3 桩基残留：截断与块匹配', () => {
  it('X3-1 6 行不同桩词 → slice(0,5) message 5 处', () => {
    const rows = ['桩基施工', '灌注桩检测', '钻孔桩成孔', '打桩作业', '成桩验收', '桩机进场'].map(text => `${text}。`).join('\n');
    const md = `### 地基与基础\n筏板基础施工。\n## 进度计划\n${rows}`;
    const issues = foundationFormResidueIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('5 处');
  });
  it('X3-2 长行命中 slice(0,48)', () => {
    const long = `桩基施工${'，工序详细说明'.repeat(10)}`;
    const md = `### 地基与基础\n筏板基础施工。\n## 进度计划\n${long}。\n桩基检测。`;
    const issues = foundationFormResidueIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(long.slice(0, 48));
  });
  it('X3-3 H4 标题「#### 地基与基础」匹配块 → 块内无桩词可报', () => {
    const md = '#### 地基与基础\n筏板基础施工。\n## 进度计划\n桩基检测。\n桩基验收。';
    const issues = foundationFormResidueIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('2 处');
  });
  it('X3-4 H2 标题「## 地基与基础」不匹配（仅 #{3,4}）→ 无块不报', () => {
    const md = '## 地基与基础\n筏板基础施工。\n## 进度计划\n桩基检测。\n桩基验收。';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it('X3-5 两个地基块其一含桩词 → 全豁免不报', () => {
    const md = '### 地基与基础\n筏板基础施工。\n## 下章\n### 地基与基础\n灌注桩施工。\n## 后文\n桩基检测。\n桩基验收。';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it('X3-6 同一行两处桩词 → Set 去重 1 处 → 不报', () => {
    const md = '### 地基与基础\n筏板基础施工。\n## 进度计划\n桩基施工。桩基检测。';
    expect(foundationFormResidueIssues(md)).toEqual([]);
  });
  it('X3-7 块边界：块内桩词行在 H4 标题后（块截断到 H4）→ 块内无桩词 → 报', () => {
    const md = '### 地基与基础\n筏板基础施工。\n#### 桩基施工方案\n正文桩基施工。\n桩基检测。';
    const issues = foundationFormResidueIssues(md);
    expect(issues).toHaveLength(1);
  });
  it('X3-8 5 处不同桩词 → message 5 处', () => {
    const rows = ['桩基施工', '灌注桩检测', '钻孔桩成孔', '打桩作业', '成桩验收'].map(text => `${text}。`).join('\n');
    const md = `### 地基与基础\n筏板基础施工。\n## 进度计划\n${rows}`;
    const issues = foundationFormResidueIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('5 处');
  });
  it('X3-9 message 含具体桩词行文本', () => {
    const md = '### 地基与基础\n筏板基础施工。\n## 进度计划\n桩基检测。\n桩基验收。';
    const issues = foundationFormResidueIssues(md);
    expect(issues[0].message).toContain('桩基检测。');
    expect(issues[0].message).toContain('桩基验收。');
  });
});

// ── X4. basicInfoScheduleFieldIssues（全新深挖） ──

describe('X4 计划工期字段：合法值不报', () => {
  it('X4-1 「540个日历天」不报', () => {
    expect(basicInfoScheduleFieldIssues('| 计划工期 | 540个日历天 |')).toEqual([]);
  });
  it('X4-2 「540 日历天（以开工令为准）」不报', () => {
    expect(basicInfoScheduleFieldIssues('| 计划工期 | 540日历天（以开工令为准） |')).toEqual([]);
  });
  it('X4-3 正文行（非表格行）含计划工期违约词 → 不报', () => {
    expect(basicInfoScheduleFieldIssues('计划工期：工期延误56天以上可切除剩余工程量。')).toEqual([]);
  });
  it('X4-4 「| 合同工期 | 工期延误 |」其它字段行 → 不报', () => {
    expect(basicInfoScheduleFieldIssues('| 合同工期 | 工期延误 |')).toEqual([]);
  });
  it('X4-5 value 为空 → 不报', () => {
    expect(basicInfoScheduleFieldIssues('| 计划工期 | |')).toEqual([]);
  });
});

describe('X4 计划工期字段：违约词谱系', () => {
  const VIOLATIONS = ['工期延误56天以上可切除剩余工程量', '工期延误', '违约处理', '切除合同', '赔偿损失', '罚款处理', '解除合同', '扣减工程款'] as const;
  it.each(VIOLATIONS)('X4-6 value“%s”→ 报', (value) => {
    const issues = basicInfoScheduleFieldIssues(`| 计划工期 | ${value} |`);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('计划工期');
  });
  it('X4-7 「延误」子串命中（超期延误情形）→ 报', () => {
    expect(basicInfoScheduleFieldIssues('| 计划工期 | 超期延误情形处理 |')).toHaveLength(1);
  });
});

describe('X4 计划工期字段：格式与聚合', () => {
  it('X4-8 行首缩进表格行 → 报', () => {
    expect(basicInfoScheduleFieldIssues('  | 计划工期 | 工期延误 |')).toHaveLength(1);
  });
  it('X4-9 无空格「|计划工期|违约|」→ 报', () => {
    expect(basicInfoScheduleFieldIssues('|计划工期| 违约 |')).toHaveLength(1);
  });
  it('X4-10 「| 计划工期 |」尾空格 → 报', () => {
    expect(basicInfoScheduleFieldIssues('| 计划工期  | 工期延误 |')).toHaveLength(1);
  });
  it('X4-11 合法值+违约词混合 → 报', () => {
    const issues = basicInfoScheduleFieldIssues('| 计划工期 | 540个日历天，工期延误按合同处理 |');
    expect(issues).toHaveLength(1);
  });
  it('X4-12 value 41 字 → message slice(0,40)', () => {
    const value = `工期延误${'，'.repeat(40)}`;
    const issues = basicInfoScheduleFieldIssues(`| 计划工期 | ${value} |`);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain(value.slice(0, 40));
  });
  it('X4-13 2 行违约 → 2 条', () => {
    const md = '| 计划工期 | 工期延误 |\n| 计划工期 | 罚款处理 |';
    expect(basicInfoScheduleFieldIssues(md)).toHaveLength(2);
  });
  it('X4-14 3 行违约 → slice(0,2) 截断 2 条', () => {
    const md = '| 计划工期 | 工期延误 |\n| 计划工期 | 罚款处理 |\n| 计划工期 | 解除合同 |';
    expect(basicInfoScheduleFieldIssues(md)).toHaveLength(2);
  });
  it('X4-15 一行两违约词 → 1 条', () => {
    const issues = basicInfoScheduleFieldIssues('| 计划工期 | 工期延误且罚款处理 |');
    expect(issues).toHaveLength(1);
  });
});

// ── X5. stripDuplicateTables / stripDuplicateTablesAcrossChapters（全新深挖） ──

const TABLE_A = ['| 序号 | 设备名称 | 数量 |', '| --- | --- | --- |', '| 1 | 塔式起重机 | 2 |', '| 2 | 施工升降机 | 3 |'].join('\n');
const TABLE_B_SUB = ['| 序号 | 设备名称 | 数量 |', '| --- | --- | --- |', '| 1 | 塔式起重机 | 2 |'].join('\n');

describe('X5 表格去重：删除行为', () => {
  it('X5-1 完全一致表 → 删一张（removedCount=4：表头+分隔+2 数据行）', () => {
    const result = stripDuplicateTables(`${TABLE_A}\n\n${TABLE_A}`);
    expect(result.removedCount).toBe(4);
    expect(result.markdown.split('| 1 | 塔式起重机 | 2 |').length - 1).toBe(1);
  });
  it('X5-2 removedLineNumbers 升序且含表头行号（正文占行 0、表 1 占 1-4、空行 5、表 2 从 6 起）', () => {
    const result = stripDuplicateTables(`正文。\n${TABLE_A}\n\n${TABLE_A}`);
    expect(result.removedLineNumbers).toEqual([6, 7, 8, 9]);
  });
  it('X5-3 删列子表（bodyChars 小者被删）→ 保留信息量大的原表', () => {
    const result = stripDuplicateTables(`${TABLE_A}\n\n${TABLE_B_SUB}`);
    expect(result.removedCount).toBe(3);
    expect(result.markdown).toContain('| 2 | 施工升降机 | 3 |');
  });
  it('X5-4 bodyChars 相同 → 保留左表删右表', () => {
    const result = stripDuplicateTables(`${TABLE_A}\n\n${TABLE_A}`);
    expect(result.markdown).toContain('| 1 | 塔式起重机 | 2 |');
    expect(result.removedLineNumbers?.[0]).toBe(5);
  });
  it('X5-5 同表头不同内容 → 不删原样返回', () => {
    const other = ['| 序号 | 设备名称 | 数量 |', '| --- | --- | --- |', '| 1 | 混凝土泵车 | 1 |'].join('\n');
    const result = stripDuplicateTables(`${TABLE_A}\n\n${other}`);
    expect(result.removedCount).toBe(0);
    expect(result.markdown).toBe(`${TABLE_A}\n\n${other}`);
  });
  it('X5-6 表格不足 2 张 → 原样返回', () => {
    const result = stripDuplicateTables(TABLE_A);
    expect(result.removedCount).toBe(0);
    expect(result.markdown).toBe(TABLE_A);
  });
  it('X5-7 删除后正文段落保留', () => {
    const result = stripDuplicateTables(`正文段落。\n${TABLE_A}\n\n${TABLE_A}`);
    expect(result.markdown).toContain('正文段落。');
  });
  it('X5-8 连排表（无空行）→ 块内切分两张 → 删一张', () => {
    const result = stripDuplicateTables(`${TABLE_A}\n${TABLE_A}`);
    expect(result.removedCount).toBe(4);
  });
});

describe('X5 表格去重：判定三分支', () => {
  it('X5-9 ②路径 headerSim≥0.7+firstColSim≥0.6 → 删', () => {
    const hA = ['序号', '设备名称', '数量', '使用阶段', '用途', '备注'].join(' | ');
    const hB = ['序号', '设备名称', '数量', '使用阶段', '用途', '说明'].join(' | ');
    const rows = '| 1 | 塔式起重机 | 2 | 主体 | 吊装 | — |';
    const tableA = [`| ${hA} |`, '| --- | --- | --- | --- | --- | --- |', rows].join('\n');
    const tableB = [`| ${hB} |`, '| --- | --- | --- | --- | --- | --- |', rows].join('\n');
    const result = stripDuplicateTables(`${tableA}\n\n${tableB}`);
    expect(result.removedCount).toBeGreaterThan(0);
  });
  it('X5-10 ②路径 headerSim<0.7 且首列/数据无关 → 不删', () => {
    const hA = ['序号', '设备名称', '数量', '使用阶段', '用途', '备注'].join(' | ');
    const hB = ['序号', '设备名称', '数量', '使用阶段', '说明一', '说明二'].join(' | ');
    const rowsA = '| 1 | 塔式起重机 | 2 | 主体 | 吊装 | — |';
    const rowsB = '| 甲 | 混凝土泵车 | 1 | 装饰 | 输送 | — |';
    const tableA = [`| ${hA} |`, '| --- | --- | --- | --- | --- | --- |', rowsA].join('\n');
    const tableB = [`| ${hB} |`, '| --- | --- | --- | --- | --- | --- |', rowsB].join('\n');
    const result = stripDuplicateTables(`${tableA}\n\n${tableB}`);
    expect(result.removedCount).toBe(0);
  });
  it('X5-11 ③路径 firstColSim≥0.6+文本覆盖≥0.6 → 删', () => {
    const hA = ['施工阶段', '工种', '人数', '主要工作内容', '调配原则'].join(' | ');
    const hB = ['施工阶段', '主要工种', '平均人数', '高峰人数', '主要工作内容'].join(' | ');
    const rowsA = '| 基坑与基础 | 土方工、钢筋工 | 85 | 土方开挖、钢筋绑扎 | 按工序流水调配 |';
    const rowsB = '| 基坑与基础 | 土方工、钢筋工 | 85 | 120 | 土方开挖、钢筋绑扎 |';
    const tableA = [`| ${hA} |`, '| --- | --- | --- | --- | --- |', rowsA].join('\n');
    const tableB = [`| ${hB} |`, '| --- | --- | --- | --- | --- |', rowsB].join('\n');
    const result = stripDuplicateTables(`${tableA}\n\n${tableB}`);
    expect(result.removedCount).toBeGreaterThan(0);
  });
  it('X5-12 三表链：C 数据无关 → 仅删 B；B~C 因 B 已删跳过', () => {
    const TABLE_C_UNRELATED = ['| 序号 | 设备名称 | 数量 |', '| --- | --- | --- |', '| 甲 | 混凝土泵车 | 1 |'].join('\n');
    const md = `${TABLE_A}\n\n${TABLE_A}\n\n${TABLE_C_UNRELATED}`;
    const result = stripDuplicateTables(md);
    expect(result.removedCount).toBe(4);
    expect(result.removedLineNumbers).toEqual([5, 6, 7, 8]);
    expect(result.markdown.split('| 1 | 塔式起重机 | 2 |').length - 1).toBe(1);
    expect(result.markdown).toContain('| 甲 | 混凝土泵车 | 1 |');
  });
  it('X5-12b 三表链：C 为 A 子集（dataSim 恰 0.6）→ B、C 连删 removedCount=7', () => {
    const md = `${TABLE_A}\n\n${TABLE_A}\n\n${TABLE_B_SUB}`;
    const result = stripDuplicateTables(md);
    expect(result.removedCount).toBe(7);
    expect(result.removedLineNumbers).toEqual([5, 6, 7, 8, 10, 11, 12]);
    expect(result.markdown.split('| 1 | 塔式起重机 | 2 |').length - 1).toBe(1);
  });
});

describe('X5 表格去重：跨章映射', () => {
  it('X5-13 4 章各 1 张重复表 → removedCount=12、chapterFixed=3（首章保留）', () => {
    const chapters = Array.from({ length: 4 }, () => ({ content: TABLE_A }));
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(12);
    expect(result.chapterFixed).toBe(3);
    expect(chapters[0].content).toBe(TABLE_A);
    expect(chapters[1].content).toBe('');
  });
  it('X5-14 跨章行号映射：第一章带正文行，第二章表删除', () => {
    const chapters = [{ content: `正文段落。\n${TABLE_A}` }, { content: TABLE_A }];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.chapterFixed).toBe(1);
    expect(chapters[0].content).toBe(`正文段落。\n${TABLE_A}`);
    expect(chapters[1].content).toBe('');
    expect(result.removedCount).toBe(4);
  });
  it('X5-15 无重复（数据完全无关）→ 0/0 且章节不变', () => {
    const TABLE_C_UNRELATED = ['| 序号 | 设备名称 | 数量 |', '| --- | --- | --- |', '| 甲 | 混凝土泵车 | 1 |'].join('\n');
    const chapters = [{ content: TABLE_A }, { content: TABLE_C_UNRELATED }];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result).toEqual({ removedCount: 0, chapterFixed: 0 });
    expect(chapters[0].content).toBe(TABLE_A);
    expect(chapters[1].content).toBe(TABLE_C_UNRELATED);
  });
  it('X5-16 空章列表 → 0/0', () => {
    expect(stripDuplicateTablesAcrossChapters([])).toEqual({ removedCount: 0, chapterFixed: 0 });
  });
  it('X5-17 尾换行章节（行号映射 +1 光标历史缺陷回归）→ 删除定位正确', () => {
    const chapters = [{ content: `${TABLE_A}\n` }, { content: TABLE_A }];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.chapterFixed).toBe(1);
    expect(chapters[1].content).toBe('');
  });
  it('X5-18 三章重复：中章保留、首尾删除（bodyChars 相同保留最左）', () => {
    const chapters = [{ content: TABLE_A }, { content: TABLE_A }, { content: TABLE_A }];
    const result = stripDuplicateTablesAcrossChapters(chapters);
    expect(result.removedCount).toBe(8);
    expect(result.chapterFixed).toBe(2);
    expect(chapters[0].content).toBe(TABLE_A);
    expect(chapters[1].content).toBe('');
    expect(chapters[2].content).toBe('');
  });
});
