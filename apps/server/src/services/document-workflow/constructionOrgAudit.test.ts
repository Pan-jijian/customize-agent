import { describe, expect, it, vi } from 'vitest';

vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {}
  return { LocalTransformersEmbeddingProvider };
});

import { constructionOrgProfessionalAuditIssues, duplicateParagraphIssues, fillerParagraphIssues, processParameterDensityIssues, sectionCardStructureIssues, tableCompletenessIssues } from './constructionOrgAudit';
import type { DocumentDraftChapter } from './types';

const chapter = (title: string, content: string): DocumentDraftChapter => ({ id: title, title, content, evidence: [], missingFacts: [] });

/** 废话段语义 gate 注入的确定性嵌入：套话词面 [1,0]（与套话原型点积 1）、具体措施词面 [0,1]、其余 [0,0] */
const embedDocuments = async (texts: string[]) => texts.map(text => {
  const filler = /围绕|覆盖率按|实施前应完成资料核对|确保与总体施工部署|明确适用范围|做到文明施工|确保工程质量|严格执行国家|日巡查|问题.*日内闭环|结合实际/u.test(text);
  const concrete = /防护栏杆|实测实量|洒水养护|验收合格后|定型防护|每周组织不少于一次|不合格.*返工/u.test(text);
  return [filler && !concrete ? 1 : 0, concrete ? 1 : 0];
});

describe('duplicateParagraphIssues（跨小节重复段落检测）', () => {
  const longParagraph = '本小节针对施工现场临边防护提出管理要求，防护栏杆设置高度不低于1.2m并采用标准化定型防护，作业层下方设置安全平网，各类防护设施验收合格后方可投入使用。';

  it('同段出现在 ≥2 个不同小节报重复', () => {
    const chapters = [
      chapter('安全措施', `#### 临边防护\n${longParagraph}`),
      chapter('安全措施', `#### 洞口防护\n${longParagraph}`),
    ];
    const issues = duplicateParagraphIssues(chapters);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('2 个不同小节');
    expect(issues[0].severity).toBe('warning');
  });

  it('同段出现在 ≥3 个小节升级为 blocker', () => {
    const chapters = [
      chapter('安全措施', `#### 临边防护\n${longParagraph}`),
      chapter('安全措施', `#### 洞口防护\n${longParagraph}`),
      chapter('安全措施', `#### 脚手架防护\n${longParagraph}`),
    ];
    const issues = duplicateParagraphIssues(chapters);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].level).toBe('error');
  });

  it('同一小节内重复不报（仅跨小节才算）', () => {
    const chapters = [chapter('安全措施', `#### 临边防护\n${longParagraph}\n${longParagraph}`)];
    expect(duplicateParagraphIssues(chapters)).toHaveLength(0);
  });

  it('短段落（<60 字）不参与重复检测', () => {
    const chapters = [
      chapter('安全措施', '#### 临边防护\n防护设施验收合格后投入使用。'),
      chapter('安全措施', '#### 洞口防护\n防护设施验收合格后投入使用。'),
    ];
    expect(duplicateParagraphIssues(chapters)).toHaveLength(0);
  });
});

describe('fillerParagraphIssues（废话段落模式检测，正则召回+语义复核）', () => {
  it('≥3 种套话模式报 blocker', async () => {
    const content = '#### 管理措施\n本小节围绕现场管理展开，结合绑定项目资料。\n实施前应完成资料核对、技术交底和作业条件确认。\n交底覆盖率按100%控制。\n做到文明施工安全生产。';
    const issues = await fillerParagraphIssues([chapter('管理措施', content)], embedDocuments);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
  });

  it('少量套话报 warning', async () => {
    const content = '#### 管理措施\n本小节围绕现场管理展开，结合绑定项目资料。\n具体做法：每日巡查并记录。';
    const issues = await fillerParagraphIssues([chapter('管理措施', content)], embedDocuments);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
  });

  it('无套话不报', async () => {
    const content = '#### 临边防护\n防护栏杆高度1.2m，标准化定型防护，验收合格后使用。';
    expect(await fillerParagraphIssues([chapter('安全措施', content)], embedDocuments)).toHaveLength(0);
  });

  it('词面命中但语义属具体量化措施不计套话（负例零误杀）', async () => {
    const content = '#### 质量控制\n施工过程中严格执行国家的验收规范，每道工序完成后由质检员实测实量并记录数据。';
    expect(await fillerParagraphIssues([chapter('质量控制', content)], embedDocuments)).toHaveLength(0);
  });

  it('词面未命中直接短路（合法正文不触发语义判定）', async () => {
    const content = '#### 进度管理\n每周组织不少于一次的进度计划核对并形成记录。';
    expect(await fillerParagraphIssues([chapter('进度管理', content)], embedDocuments)).toHaveLength(0);
  });
});

describe('processParameterDensityIssues（工艺参数密度）', () => {
  const workPackageChapter = (heading: string, body: string) => chapter('主要分部分项工程施工方案', `### ${heading}\n${body}`);

  it('工作包小节无工艺参数报 blocker', () => {
    const body = '本小节内容。'.repeat(80); // 400+ 字符
    const issues = processParameterDensityIssues([workPackageChapter('土方开挖工程', body)]);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].message).toContain('无工艺参数');
  });

  it('设备清单型小节（≥6 设备型号）报设备配置警告而非 blocker', () => {
    const body = '配电箱配置：1APE1 1APE2 2APE3 3APE4 4APE5 5APE6 等设备按图安装。'.repeat(30);
    const issues = processParameterDensityIssues([workPackageChapter('安装工程施工方案', body)]);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('设备配置参数');
  });

  it('拆除类小节无工艺参数报工程量警告而非 blocker', () => {
    const body = '拆除作业按区域组织，拆除物分类弃置并清运。'.repeat(40);
    const issues = processParameterDensityIssues([workPackageChapter('拆除工程', body)]);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('工程量与保护措施');
  });

  it('工艺参数充足不报', () => {
    const body = '桩位偏差≤50mm，搭接宽度≥100mm，闭水试验48h，压实度≥93%，坡度1:1.5，防护栏杆高度1.2m。'.repeat(30);
    expect(processParameterDensityIssues([workPackageChapter('管道工程', body)])).toHaveLength(0);
  });

  it('非工作包小节不检查', () => {
    const body = '概况。'.repeat(100);
    expect(processParameterDensityIssues([chapter('工程概况', `### 工程概况\n${body}`)])).toHaveLength(0);
  });
});

describe('sectionCardStructureIssues（分部分项三段式结构）', () => {
  it('方案节无 #### 子包时跳过检查（锁定现状）', () => {
    const content = '### 主要分部分项工程施工方案\n本方案总述。';
    expect(sectionCardStructureIssues([chapter('主要分部分项工程施工方案', content)])).toHaveLength(0);
  });

  it('非方案小节不检查', () => {
    expect(sectionCardStructureIssues([chapter('工程概况', '### 工程概况\n内容。')])).toHaveLength(0);
  });
  // 已知盲区缺陷（补测发现，待修复）：extractSectionBlocks 把 #### 子包行拆为独立块，
  // 方案节 block.body 恒为空，subPackages 恒为 []——缺三段标签的子包实际不会报警。
  // 预期行为：### 主要分部分项工程施工方案 下 #### 子包缺「施工方法」应报 warning。
});

describe('tableCompletenessIssues（表格空字段检测）', () => {
  it('空单元格比例 ≥40% 报警告', () => {
    const content = '| 项目 | 数量 | 单位 |\n| --- | --- | --- |\n| 配电箱 | 2 | |\n| 水泵 | | |';
    const issues = tableCompletenessIssues([], content);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('空单元格');
  });

  it('表格完整不报', () => {
    const content = '| 项目 | 数量 | 单位 |\n| --- | --- | --- |\n| 配电箱 | 2 | 台 |\n| 水泵 | 3 | 台 |';
    expect(tableCompletenessIssues([], content)).toHaveLength(0);
  });

  it('无表格不报', () => {
    expect(tableCompletenessIssues([], '纯正文。')).toHaveLength(0);
  });
});

describe('constructionOrgProfessionalAuditIssues（聚合入口）', () => {
  it('聚合全部校验器输出（reviewResponseIssues 已删除，响应检测由 tenderRequirements 语义通道承担）', async () => {
    const chapters = [chapter('管理措施', '#### 管理措施\n本小节围绕现场管理展开，结合绑定项目资料。\n实施前应完成资料核对、技术交底和作业条件确认。\n交底覆盖率按100%控制。\n做到文明施工安全生产。')];
    const issues = await constructionOrgProfessionalAuditIssues(chapters, '', embedDocuments);
    // filler blocker 保留；不再输出"未检测到对招标硬性要求的响应"类消息
    expect(issues.some(issue => issue.severity === 'blocker')).toBe(true);
    expect(issues.some(issue => /未检测到对招标硬性要求/u.test(issue.message))).toBe(false);
  });
});
