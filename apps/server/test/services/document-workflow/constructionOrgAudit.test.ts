import { describe, expect, it, vi } from 'vitest';

vi.mock('@customize-agent/knowledge', async (importOriginal) => {
  // 4.61：本包新增了权威模型导出（carrierStrength/sourcePriorityOf 等），
  // 全量替换式 mock 会让这些导出变 undefined 并炸在消费端。改为**透传真实实现**、
  // 只覆盖需要替身的嵌入 provider —— 后续包内新增导出不再需要逐个补 mock。
  const actual = await importOriginal<typeof import('@customize-agent/knowledge')>();
  class LocalTransformersEmbeddingProvider {}
  return { ...actual, LocalTransformersEmbeddingProvider };
});

import { constructionOrgProfessionalAuditIssues, duplicateParagraphIssues, fillerParagraphIssues, fillerSentenceTargets, processParameterDensityIssues, sectionCardStructureIssues, stripZeroInfoSloganSentences, tableCompletenessIssues } from '@/services/document-workflow/constructionOrgAudit';
import type { FillerSentenceTarget } from '@/services/document-workflow/constructionOrgAudit';
import type { DocumentDraftChapter } from '@/services/document-workflow/types';

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

describe('fillerSentenceTargets（套话句修复锚点提取：检测定位=修复定位）', () => {
  it('套话句定位：输出命中句原文与小节归属（模板化修复闭环锚点源）', async () => {
    const content = '#### 管理措施\n本小节围绕现场管理展开，结合绑定项目资料。\n具体做法：由施工员逐项检查并形成记录台账。';
    const targets = await fillerSentenceTargets([chapter('管理措施', content)], embedDocuments);
    expect(targets).toHaveLength(1);
    expect(targets[0].sentence).toContain('本小节围绕现场管理展开');
    expect(targets[0].section).toBe('管理措施');
    expect(targets[0].chapterId).toBe('管理措施');
    expect(targets[0].channel).toBe('semantic');
  });

  it('目录条目行不进目标句池（与检测端同源过滤）', async () => {
    const content = '第六章 确保工程质量的技术组织措施\n本小节围绕现场管理展开，结合绑定项目资料。';
    const targets = await fillerSentenceTargets([chapter('管理措施', content)], embedDocuments);
    expect(targets).toHaveLength(1);
    expect(targets[0].sentence).toContain('本小节围绕');
  });

  it('具体量化措施句不进入锚点清单（负例零误杀）', async () => {
    const content = '#### 质量控制\n每道工序完成后由质检员实测实量并记录数据，验收合格后进入下道工序。';
    expect(await fillerSentenceTargets([chapter('质量控制', content)], embedDocuments)).toHaveLength(0);
  });

  it('每章锚点限幅 12 句（修复输入有界）', async () => {
    const fillerSentences = [
      '本小节围绕现场管理展开，结合绑定项目资料。',
      '实施前应完成资料核对、技术交底和作业条件确认。',
      '交底覆盖率按100%控制。',
      '关键问题在24小时内形成整改责任。',
      '按施工准备→过程实施→检查验收→问题整改→资料归档的闭环组织。',
      '执行日巡查、周复核和节点验收制度。',
      '一般问题7日内闭环。',
      '确保与总体施工部署、工期计划和验收要求保持一致。',
      '结合现场实际情况合理组织安排。',
      '严格执行国家现行有关规范标准。',
      '做到文明施工安全生产。',
      '确保工程质量安全。',
      '建立健全管理体系并落实制度。',
    ];
    const content = `#### 管理措施\n${fillerSentences.join('\n')}`;
    const targets = await fillerSentenceTargets([chapter('管理措施', content)], embedDocuments);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.length).toBeLessThanOrEqual(12);
    expect(new Set(targets.map(target => target.sentence)).size).toBe(targets.length);
  });
});

describe('stripZeroInfoSloganSentences（零信息口号句确定性删除：semantic 通道 + 零信息硬闸才删）', () => {
  const target = (sentence: string, channel: 'semantic' | 'vague' = 'semantic'): FillerSentenceTarget => ({ chapterId: '管理措施', chapterTitle: '管理措施', section: '管理措施', sentence, channel });

  it('semantic 零信息口号句整句删除：行内移除、前后句保留', () => {
    const chapters = [chapter('管理措施', '本工程为办公楼项目。精心组织科学管理确保工程质量。基坑开挖深度5m。')];
    const result = stripZeroInfoSloganSentences(chapters, [target('精心组织科学管理确保工程质量')]);
    expect(result.deletedCount).toBe(1);
    expect(result.deletedSentences).toEqual(['精心组织科学管理确保工程质量']);
    expect(result.remaining).toHaveLength(0);
    expect(chapters[0].content).toBe('本工程为办公楼项目。基坑开挖深度5m。');
  });

  it('独立成行的口号句删除后空行丢弃（段落结构保留）', () => {
    const chapters = [chapter('管理措施', '本工程为办公楼项目。\n精心组织科学管理确保工程质量。\n基坑开挖深度5m。')];
    const result = stripZeroInfoSloganSentences(chapters, [target('精心组织科学管理确保工程质量')]);
    expect(result.deletedCount).toBe(1);
    expect(chapters[0].content).toBe('本工程为办公楼项目。\n基坑开挖深度5m。');
  });

  it('携带数字/岗位/频次/合规锚点的命中句不删除（保留交 LLM 具体化）', () => {
    const sentences = ['严格执行规范确保压实度达到95%', '由项目经理加强管理确保工程质量', '每周组织检查确保工程质量', '承诺确保工程质量达到优良标准'];
    const chapters = [chapter('管理措施', sentences.map(item => `${item}。`).join(''))];
    const result = stripZeroInfoSloganSentences(chapters, sentences.map(item => target(item)));
    expect(result.deletedCount).toBe(0);
    expect(result.remaining).toHaveLength(4);
  });

  it('vague 通道即使零信息也不删除（通道硬闸）', () => {
    const chapters = [chapter('管理措施', '本工程将加强管理确保一次成优，随即进入主体施工。')];
    const result = stripZeroInfoSloganSentences(chapters, [target('加强管理确保一次成优', 'vague')]);
    expect(result.deletedCount).toBe(0);
    expect(result.remaining).toHaveLength(1);
    expect(chapters[0].content).toContain('加强管理确保一次成优');
  });

  it('幂等安全：句已不存在时删除数为 0，target 回填 remaining（不丢锚点）', () => {
    const chapters = [chapter('管理措施', '本工程为办公楼项目。')];
    const result = stripZeroInfoSloganSentences(chapters, [target('精心组织科学管理确保工程质量')]);
    expect(result.deletedCount).toBe(0);
    expect(result.remaining).toHaveLength(1);
    expect(chapters[0].content).toBe('本工程为办公楼项目。');
  });

  it('目标章节不存在时 target 保留（不静默丢失修复锚点）', () => {
    const chapters = [chapter('管理措施', '正文内容。')];
    const result = stripZeroInfoSloganSentences(chapters, [{ chapterId: 'missing', chapterTitle: '不存在', section: 'x', sentence: '精心组织科学管理确保工程质量', channel: 'semantic' }]);
    expect(result.deletedCount).toBe(0);
    expect(result.remaining).toHaveLength(1);
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

  it('r28 扩围：绿化苗木类形态（地径D10/养护期为二年）计入工艺参数 → 不报（r27b 实况复刻）', () => {
    // r27b 实机阻断：2.2 绿化工程块只有苗木形态描述（红枫B地径D10、养护期为二年），旧词表无
    // 绿化/苗木形态分支 → 工艺参数 0 命中误报 blocker；绿化工程无 mm/MPa 级参数不等于无工艺参数
    const seed = '苗木品种以红枫B、腊梅及林下栀子花为主，其中红枫B地径D10，冠丛高、蓬径按设计规格控制。全部苗木按二级养护标准执行，养护期为二年。';
    const body = seed.repeat(7);
    expect(processParameterDensityIssues([workPackageChapter('绿化工程', body)])).toHaveLength(0);
  });

  it('r28 反例：绿化块纯描述（无苗木形态参数）→ 仍报无工艺参数 blocker', () => {
    const body = '绿化苗木按设计规格选型，进场后及时栽植并浇足定根水，养护管理到位确保景观效果。'.repeat(12);
    const issues = processParameterDensityIssues([workPackageChapter('绿化工程', body)]);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
  });

  it('非工作包小节不检查', () => {
    const body = '概况。'.repeat(100);
    expect(processParameterDensityIssues([chapter('工程概况', `### 工程概况\n${body}`)])).toHaveLength(0);
  });

  // r17 丰乐镇门禁 #B5：管理程序型小节（编制/报审/交底/修订流程，载体是管理动作）被「施工方案」
  // 泛类模式误纳——按工作包要求 mm/MPa 工艺参数属语义错位；真作业方案小节不受影响
  it('管理程序型小节（专项施工方案管理）豁免不检查', () => {
    const body = '专项施工方案由项目技术负责人牽头编制，经项目经理审核签字后报总监理工程师审查。交底双方签字确认，交底记录由安全员归档保存，发现擅自改变施工顺序的立即下达整改通知并复查销项。'.repeat(6);
    expect(processParameterDensityIssues([chapter('确保安全生产的技术组织措施', `### 专项施工方案管理\n${body}`)])).toHaveLength(0);
  });

  it('真作业方案小节（沟槽开挖专项施工方案）仍检查（豁免不过宽）', () => {
    const body = '沟槽开挖作业按设计断面分层下挖，严禁超挖，开挖土方随挖随运。'.repeat(30);
    const issues = processParameterDensityIssues([chapter('确保安全生产的技术组织措施', `### 沟槽开挖专项施工方案\n${body}`)]);
    expect(issues.length).toBe(1);
    expect(issues[0].severity).toBe('blocker');
  });
});

describe('sectionCardStructureIssues（分部分项内容要素完整性）', () => {
  it('方案节无 #### 子包时跳过检查（锁定现状）', () => {
    const content = '### 主要分部分项工程施工方案\n本方案总述。';
    expect(sectionCardStructureIssues([chapter('主要分部分项工程施工方案', content)])).toHaveLength(0);
  });

  it('非方案小节不检查', () => {
    expect(sectionCardStructureIssues([chapter('工程概况', '### 工程概况\n内容。')])).toHaveLength(0);
  });

  it('盲区根治：### 方案节下 #### 子包缺内容要素应报 blocker（历史盲区：extractSectionBlocks 把 #### 行切为新块导致 subPackages 恒空）', () => {
    const content = [
      '### 主要分部分项工程施工方案',
      '#### 屋面防水施工',
      '施工概况：本项目屋面面积约 3000㎡。',
      '施工流程：基层清理→找平→铺贴卷材。',
      '#### 外窗更换',
      '施工概况：外窗约 600 樘。',
    ].join('\n');
    const issues = sectionCardStructureIssues([chapter('主要分部分项工程施工方案', content)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe('blocker');
    expect(issues[0]?.message).toContain('内容要素不全');
  });

  it('子包三要素齐全不报警（自然成文形态：无标签但要素齐）', () => {
    const content = [
      '### 主要分部分项工程施工方案',
      '#### 屋面防水施工',
      '本项目屋面部位面积约 3000㎡，采用 SBS 卷材施工。',
      '工序顺序：先基层清理，再涂刷基层处理剂，随后铺贴卷材，然后做闭水试验。',
      '验收标准：搭接宽度不小于 100mm，闭水试验 24h 无渗漏。',
    ].join('\n');
    expect(sectionCardStructureIssues([chapter('主要分部分项工程施工方案', content)])).toHaveLength(0);
  });
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
