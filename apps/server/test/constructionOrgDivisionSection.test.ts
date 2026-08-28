import { describe, expect, it } from 'vitest';
import { constructionOrgDivisionSectionIssues } from '../src/services/document-workflow/constructionOrgQualityRules';
import { finalizeChapterContentQuality } from '../src/services/document-workflow/documentGeneratorHelpers';
import type { DocumentDraftChapter } from '../src/services/document-workflow/types';

function draft(title: string, content: string, sections: string[] = []): DocumentDraftChapter {
  return { id: title, title, content, sections, evidence: [], missingFacts: [] };
}

const DIVISION_SECTION_TITLE = '### 主要分部分项工程施工方案';

/** 完整分项：施工概况/工艺流程/施工方法三段 + 方法段箭头链 + ≥4 工艺参数（正文 ≥150 字，避开深度下限） */
function packageBlock(name: string, options: { withoutMethod?: boolean; withoutChain?: boolean; dirty?: boolean } = {}): string {
  // 链回退口径（十度修复）：方法段无链但流程段有链达标（施工组织设计规范中工序链写在工艺流程是标准写法）；
  // withoutChain 语义为两段均无链，才能触发缺链 blocker
  const flow = options.withoutChain ? '工艺流程：按图施工分区分层组织，先深后浅。' : '工艺流程：定位放线→开挖→回填→压实→检测';
  const method = options.withoutMethod
    ? ''
    : `施工方法：采用1m³挖掘机分层开挖，每层厚度300mm，分层厚度200mm，养护28天，压实度95%${options.withoutChain ? '' : '；基层清理→放线定位→分层摊铺→碾压→压实度检测→验收'}。施工过程由施工员全程旁站，每层压实完成后由质检员检测压实度，合格后报监理复核并形成隐蔽验收记录。`;
  const dirty = options.dirty ? '未尽事宜以招标文件为准。' : '';
  return `#### ${name}\n施工概况：本工程${name}作业部位为基础施工范围，工程量为2000㎡，基坑开挖深度3.5m，土方全部场内倒运，回填采用级配碎石分层压实，作业面按流水段划分组织施工，主要机具包括挖掘机、压路机与蛙式打夯机。\n${flow}\n${method}${dirty}`;
}

/** 九度实测形态分项：粗体伪标签三段式 + 链只在施工流程行 + 方法段叙述体无链 */
function malformedLabelPackage(name: string): string {
  return `#### ${name}\n施工概况：**施工概况**：本工程${name}作业部位为基础施工范围，工程量为2000㎡，基坑开挖深度3.5m。\n**施工流程**：定位放线→开挖→回填→压实→检测\n**施工方法**：采用1m³挖掘机分层开挖，每层厚度300mm，分层厚度200mm，养护28天，压实度95%。施工过程由施工员全程旁站，合格后报监理复核并形成隐蔽验收记录。`;
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

  it('施工方法段与施工流程段均无箭头工序链判 blocker', () => {
    const chapter = chapterWithPackages([
      packageBlock('土方工程', { withoutChain: true }),
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
    ]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('缺少箭头工序链'))).toBe(true);
  });

  it('方法段无链但流程段有链不判 blocker（链回退流程段，九度实测形态）', () => {
    // 流程段链是施工组织设计标准写法：链检查方法段优先、流程段回退
    const flowOnlyChainPackage = `#### 装饰装修工程\n施工概况：本工程装饰装修工程作业部位为闲置空间约4368㎡，吊顶、墙面、地面全部重新施工，作业面按楼层划分为三个流水段，主要机具包括龙骨切割机、射钉枪与电动螺丝刀。\n施工流程：基层清理→放线定位→分层施工→养护→验收\n施工方法：采用轻钢龙骨石膏板体系，龙骨间距400mm，螺钉间距200mm，板缝3mm，养护7天，表面平整度偏差不大于2mm。施工过程由施工员全程旁站，每层完成后由质检员检测并报监理复核，形成隐蔽验收记录。`;
    const chapter = chapterWithPackages([
      flowOnlyChainPackage,
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
    ]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.filter(issue => issue.severity === 'blocker')).toEqual([]);
  });

  it('粗体伪标签形态分项（九度实测）：标签归一化后不再判脏事实/缺链/参数不足', () => {
    // 真实路径：修复写回先过 finalizeChapterContentQuality（含标签归一化），验收器再读归一化后正文
    const rawChapter = chapterWithPackages([
      malformedLabelPackage('结构加固改造工程'),
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
    ]);
    const normalizedChapter = {
      ...rawChapter,
      content: finalizeChapterContentQuality(rawChapter.content, { title: rawChapter.title, sections: rawChapter.sections }),
    };
    const issues = constructionOrgDivisionSectionIssues([normalizedChapter]);
    const blockers = issues.filter(issue => issue.severity === 'blocker');
    expect(blockers).toEqual([]);
  });

  it('参数口径含 N/颗/樘/扇 单位（门窗维修类工艺参数不误报）', () => {
    const doorWindowPackage = `#### 门窗维修工程\n施工概况：本工程门窗维修针对既有建筑门窗五金件松动、密封胶条老化进行维修更换，范围覆盖闲置空间约4368㎡内全部门窗。\n施工流程：逐樘检查→缺陷登记→五金件更换→启闭调试→淋水检查→验收\n施工方法：门窗检查由施工员逐樘编号登记，形成缺陷清单报技术负责人确认；五金件更换采用与原规格一致的产品，螺钉固定不少于2颗，启闭力不大于50N，密封胶条采用三元乙丙胶条，胶缝宽度5mm，框扇安装垂直度偏差不大于2mm。`;
    const chapter = chapterWithPackages([
      doorWindowPackage,
      packageBlock('基础工程'),
      packageBlock('主体结构工程'),
    ]);
    const issues = constructionOrgDivisionSectionIssues([chapter]);
    expect(issues.filter(issue => issue.severity === 'blocker')).toEqual([]);
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
