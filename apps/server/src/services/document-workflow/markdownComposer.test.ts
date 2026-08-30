/**
 * h13c normalizeProductionText 清洗单测：平方笔误（「28570.36平方2.8」形态）与
 * 「原则上」原则词清洗；前瞻边界验证不破坏「平方公里」类合法词。
 */
import { describe, expect, it } from 'vitest';
import { mergeTableLineBreaks, normalizeProductionText, normalizeTenderSourcePageRefs, sanitizeFormalMarkdown, sectionDuplicateIssues, sectionHeadingIssues } from './markdownComposer';

describe('normalizeProductionText 平方笔误清洗（h13c）', () => {
  it('「28570.36平方2.8」→ 残留数字一并吸收，仅保留平方米', () => {
    expect(normalizeProductionText('单体建筑面积28570.36平方2.8')).toBe('单体建筑面积28570.36平方米');
  });

  it('「28570.36平方」无残片 → 平方米', () => {
    expect(normalizeProductionText('单体建筑面积28570.36平方，其中地上24783.39平方米。')).toContain('28570.36平方米');
  });

  it('「平方公里」合法词不被破坏', () => {
    expect(normalizeProductionText('项目占地约1.5平方公里。')).toContain('1.5平方公里');
  });
});

describe('normalizeProductionText 原则词清洗（h13c）', () => {
  it('「原则上」被移除', () => {
    expect(normalizeProductionText('模板拆除原则上按先支后拆顺序进行。')).toBe('模板拆除按先支后拆顺序进行。');
  });

  it('无原则词文本原样返回', () => {
    expect(normalizeProductionText('模板拆除按先支后拆顺序进行。')).toBe('模板拆除按先支后拆顺序进行。');
  });
});

describe('sanitizeFormalMarkdown H4 词尾严格重复清洗（4.12.5）', () => {
  it('「现场条件现场条件」尾部等长重复 → 去重', () => {
    expect(sanitizeFormalMarkdown('#### 现场条件现场条件')).toBe('#### 现场条件');
  });

  it('「要点要点」→ 去重', () => {
    expect(sanitizeFormalMarkdown('#### 要点要点')).toBe('#### 要点');
  });

  it('语义级粘连「现场踏勘施工条件现场条件」不做词面硬改（交 Reviewer）', () => {
    expect(sanitizeFormalMarkdown('#### 现场踏勘施工条件现场条件')).toBe('#### 现场踏勘施工条件现场条件');
  });

  it('合法标题「安全文明施工与安全管理」不被误清洗', () => {
    expect(sanitizeFormalMarkdown('#### 安全文明施工与安全管理')).toBe('#### 安全文明施工与安全管理');
  });
});

describe('sectionHeadingIssues H4 标题治理标记（4.12.5）', () => {
  it('词尾粘连标题标记为疑似重复', () => {
    const issues = sectionHeadingIssues('### 现场踏勘\n#### 现场踏勘施工条件现场条件');
    expect(issues.some(issue => issue.message.includes('疑似词尾粘连'))).toBe(true);
  });

  it('H4 与三级小节同名标记', () => {
    const issues = sectionHeadingIssues('### 安全管理\n#### 安全管理');
    expect(issues.some(issue => issue.message.includes('同名'))).toBe(true);
  });

  it('含豁免词的合理标题不误报', () => {
    const issues = sectionHeadingIssues('### 安全文明施工\n#### 安全文明施工与安全管理');
    expect(issues).toHaveLength(0);
  });

  it('超长拼接标题标记', () => {
    const issues = sectionHeadingIssues('#### 地下车库顶板防水与外墙保温一体化施工工艺');
    expect(issues.some(issue => issue.message.includes('过长'))).toBe(true);
  });
});

describe('sectionDuplicateIssues 跨节重复检测（4.12.5）', () => {
  it('两节 3 句以上长句重合判定重复', () => {
    const s1 = '混凝土浇筑完成后应及时覆盖养护并做好测温记录，养护时间不得少于十四天。';
    const s2 = '模板支撑体系必须经过验算合格后方可进行混凝土浇筑施工。';
    const s3 = '每批次进场原材料必须按规定见证取样送检合格后方可使用。';
    const md = `## 第一章\n### 1.1 施工准备\n${s1}\n${s2}\n${s3}\n### 1.2 现场管理\n${s1}\n${s2}\n${s3}`;
    const issues = sectionDuplicateIssues(md);
    expect(issues.some(issue => issue.message.includes('正文重复'))).toBe(true);
  });

  it('内容不同不误报', () => {
    const md = '## 第一章\n### 1.1 施工准备\n混凝土浇筑完成后应及时覆盖养护并做好测温记录，养护时间不得少于十四天。\n### 1.2 现场管理\n现场材料按规格分类堆放并设置标识牌，易燃易爆材料单独存放并配备消防器材。';
    expect(sectionDuplicateIssues(md)).toHaveLength(0);
  });
});

describe('mergeTableLineBreaks 表格断行合并（4.12.6）', () => {
  it('危大工程表单元格换行断行合并回上一行（专项方案审批列现场）', () => {
    const md = `| 危大工程名称 | 工程参数 | 危大类别 | 专项方案审批 |
| --- | --- | --- | --- |
| 基坑土方开挖与支护 | 地下1层，开挖深度超过5m，采用放坡喷锚支护 | 超过一定规模危大工程 | 施工单位技术负责人审核签字并加盖单位公章， |
总监理工程师审查签字并加盖执业印章 | 组织不少于5名专家论证 |`;
    const result = mergeTableLineBreaks(md);
    expect(result).toContain('施工单位技术负责人审核签字并加盖单位公章，总监理工程师审查签字并加盖执业印章；组织不少于5名专家论证 |');
    expect((result.match(/\n/gu) || []).length).toBe(2);
  });

  it('正文中单竖线非表格行不误合并', () => {
    const md = '## 第一章\n\n本工程采用流水施工。\n\n| 项目 | 内容 |\n| --- | --- |\n| 名称 | 徽光阁 |';
    const result = mergeTableLineBreaks(md);
    expect(result).toContain('本工程采用流水施工。');
    expect(result).toContain('| 名称 | 徽光阁 |');
  });

  it('分隔行后断行转为表格行而非合并进分隔行（保护表格结构）', () => {
    const md = '| 危大工程名称 | 工程参数 | 危大类别 | 专项方案审批 |\n| --- | --- | --- | --- |\n总监理工程师审查签字并加盖执业印章 | 组织不少于5名专家论证 |';
    const result = mergeTableLineBreaks(md);
    // 分隔行必须原样保留，不得被断行污染成畸形数据行
    expect(result).toContain('| --- | --- | --- | --- |');
    // 断行转为以 | 开头的表格行，内容零丢失
    expect(result).toContain('| 总监理工程师审查签字并加盖执业印章 | 组织不少于5名专家论证 |');
  });
});

describe('normalizeTenderSourcePageRefs 残缺页码残片清洗（4.12.6）', () => {
  it('残缺「PDF 第」残片删除，保留前文本', () => {
    expect(normalizeTenderSourcePageRefs('日期：2026年8月19 日PDF 第')).toBe('日期：2026年8月19 日');
    expect(normalizeTenderSourcePageRefs('合肥师范学院招标代理：安徽省招标集团股份有限公司日期：2026年8月19日PDF 第')).toBe('合肥师范学院招标代理：安徽省招标集团股份有限公司日期：2026年8月19日');
  });

  it('完整「PDF 第X页」仍归一为相关资料', () => {
    expect(normalizeTenderSourcePageRefs('详见招标文件 PDF 第 5 页')).toContain('相关资料');
  });

  it('空格数字完整引用「PDF 第 3 页」归一（不落入残片删除误删成「 3 页」）', () => {
    expect(normalizeTenderSourcePageRefs('详见招标文件PDF 第 3 页')).toBe('详见招标文件相关资料');
    expect(normalizeTenderSourcePageRefs('详见招标文件PDF  第   8  页')).toBe('详见招标文件相关资料');
  });

  it('全角数字保留原样、页码范围经 L60 兜底归一（与 cleanInlineFactValue 同口径）', () => {
    expect(normalizeTenderSourcePageRefs('详见招标文件PDF 第３页')).toBe('详见招标文件PDF 第３页');
    expect(normalizeTenderSourcePageRefs('详见招标文件PDF 第 5-8 页')).toBe('详见招标文件相关资料');
  });
});
