import { describe, expect, it } from 'vitest';
import { constructionOrgDivisionSectionIssues } from '../src/services/document-workflow/constructionOrgQualityRules';
import type { DocumentDraftChapter } from '../src/services/document-workflow/types';

function draft(title: string, content: string, sections: string[] = []): DocumentDraftChapter {
  return { id: title, title, content, sections, evidence: [], missingFacts: [] };
}

const DIVISION_SECTION_TITLE = '### 主要分部分项工程施工方案';

/** 完整分项：施工概况/工艺流程/施工方法三段 + 方法段箭头链 + ≥4 工艺参数（正文 ≥150 字，避开深度下限） */
function packageBlock(name: string, options: { withoutMethod?: boolean; withoutChain?: boolean; dirty?: boolean } = {}): string {
  const method = options.withoutMethod
    ? ''
    : `施工方法：采用1m³挖掘机分层开挖，每层厚度300mm，分层厚度200mm，养护28天，压实度95%${options.withoutChain ? '' : '；基层清理→放线定位→分层摊铺→碾压→压实度检测→验收'}。施工过程由施工员全程旁站，每层压实完成后由质检员检测压实度，合格后报监理复核并形成隐蔽验收记录。`;
  const dirty = options.dirty ? '未尽事宜以招标文件为准。' : '';
  return `#### ${name}\n施工概况：本工程${name}作业部位为基础施工范围，工程量为2000㎡，基坑开挖深度3.5m，土方全部场内倒运，回填采用级配碎石分层压实，作业面按流水段划分组织施工，主要机具包括挖掘机、压路机与蛙式打夯机。\n工艺流程：定位放线→开挖→回填→压实→检测\n${method}${dirty}`;
}

function chapterWithPackages(packages: string[]): DocumentDraftChapter {
  return draft('施工方案', `${DIVISION_SECTION_TITLE}\n${packages.join('\n\n')}`, ['主要分部分项工程施工方案']);
}

describe('分部分项专项验收器（constructionOrgDivisionSectionIssues）', () => {
  it('三个完整分项（三段式+箭头链+参数）不产生阻断问题', () => {
    const chapter = chapterWithPackages([
      packageBlock('土方工程'),
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
    ]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.filter(issue => issue.severity === 'blocker' || issue.level === 'error')).toEqual([]);
  });

  it('分项数量不足 3 个判结构不足（blocker）', () => {
    const chapter = chapterWithPackages([packageBlock('土方工程'), packageBlock('基础工程')]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('分项不足'))).toBe(true);
  });

  it('分项缺少施工方法段判 blocker', () => {
    const chapter = chapterWithPackages([
      packageBlock('土方工程', { withoutMethod: true }),
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
    ]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('缺少施工概况/工艺流程/施工方法'))).toBe(true);
  });

  it('施工方法段无箭头工序链判 blocker', () => {
    const chapter = chapterWithPackages([
      packageBlock('土方工程', { withoutChain: true }),
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
    ]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('缺少箭头工序链'))).toBe(true);
  });

  it('脏事实污染（未尽事宜）判 blocker', () => {
    const chapter = chapterWithPackages([
      packageBlock('土方工程', { dirty: true }),
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
    ]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('脏事实或空话污染'))).toBe(true);
  });

  it('分部分项小节整体缺失判 blocker（小节缺失或标题结构异常）', () => {
    const chapter = draft('施工方案', '### 施工部署\n本工程部署如下。', ['主要分部分项工程施工方案']);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('小节缺失或标题结构异常'))).toBe(true);
  });

  it('无候选章节（标题不含分部分项关键词）不产生问题', () => {
    const chapter = draft('质量保证措施', '### 质量保证体系\n内容。', ['质量保证体系']);
    expect(constructionOrgDivisionSectionIssues([chapter])).toEqual([]);
  });

  it('粗体伪标题一段式（无 #### 小节）也能识别分项并报结构缺陷（真实生成缺陷：徽光阁式写法穿透门禁）', () => {
    const boldStyle = `**拆除工程**施工对象为室内砖砌体，拆除工艺流程为：现场围护→分间隔离→分层拆除→垃圾归堆。施工方法采用小型电动破碎机配合人工拆除，先上后下顺序作业。\n**门窗维修**按设计图纸对原门窗进行维修更换，工艺为：拆除旧门窗→基面修补→新门窗安装→五金调试→密封胶收边。`;
    const chapter = chapterWithPackages([]);
    chapter.content = `${DIVISION_SECTION_TITLE}\n${boldStyle}`;
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('缺少施工概况/工艺流程/施工方法'))).toBe(true);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('脏事实或空话污染'))).toBe(true);
  });

  it('分项正文过短（少于 150 字）判深度不足 blocker', () => {
    const shallow = '#### 门窗维修\n施工概况：对原门窗维修。\n工艺流程：拆除旧门窗→安装新门窗→调试。\n施工方法：按设计图纸维修更换。';
    const chapter = chapterWithPackages([
      packageBlock('土方工程'),
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
      shallow,
    ]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('正文过短'))).toBe(true);
  });

  it('分项深度失衡（最短不足最长三分之一）给 warning 建议', () => {
    const thin = '#### 门窗维修\n施工概况：对原门窗维修更换。\n工艺流程：拆除旧门窗→安装新门窗→调试。\n施工方法：按设计图纸维修更换，完成后检查开启灵活。';
    const chapter = chapterWithPackages([
      packageBlock('土方工程'),
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
      thin,
    ]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.some(issue => issue.level === 'warning' && issue.message.includes('深度失衡'))).toBe(true);
  });
});
