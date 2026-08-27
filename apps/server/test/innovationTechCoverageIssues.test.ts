import { describe, expect, it } from 'vitest';
import { innovationTechCoverageIssues } from '../src/services/document-workflow/qualityValidation';

/**
 * 四新技术小节成稿结构检查（不做关键词语义判断）大规模测试：
 * 大纲通过标准模块挂靠承诺四新小节后，最终正文必须有对应小节标题且正文成稿（≥200 字）。
 * 覆盖：承诺识别口径、成稿判定边界（字数临界）、fuzzy 标题匹配、多章多承诺、去重、大纲未承诺、非四新小节不触发。
 */
const COMMITTED_OUTLINE = [{ title: '确保工期与质量的保障体系与措施', sections: ['新技术、新工艺、新材料、新设备的应用'] }];
const LONG_BODY = '本项目针对既有建筑改造场景采用激光扫描逆向建模技术建立现状模型，全面应用预制装配式隔墙与管线分离新工艺，主要结构改造采用碳纤维布加固与无收缩灌浆料新材料，配置智能施工升降平台与降噪除尘一体化拆除设备等新设备，并同步建立数字化交付模型支撑运维阶段管理。';

describe('innovationTechCoverageIssues 承诺识别', () => {
  it('大纲章节 sections 含四新小节时视为承诺', () => {
    const issues = innovationTechCoverageIssues('### 施工方案\n\n传统做法。', COMMITTED_OUTLINE);
    expect(issues).toHaveLength(1);
  });

  it('四新标题出现在章节 title 而非 sections 时不视为承诺（承诺载体是小节）', () => {
    const issues = innovationTechCoverageIssues('### 施工方案\n\n传统做法。', [{ title: '新技术、新工艺、新材料、新设备的应用', sections: [] }]);
    expect(issues).toHaveLength(0);
  });

  it('空大纲不制造新义务', () => {
    expect(innovationTechCoverageIssues('### 施工方案\n\n传统做法。', [])).toHaveLength(0);
  });

  it('大纲章节无 sections 字段时不报错且不制造新义务', () => {
    expect(innovationTechCoverageIssues('### 施工方案\n\n传统做法。', [{}])).toHaveLength(0);
  });

  it('非四新小节（普通施工方案小节）不触发', () => {
    const issues = innovationTechCoverageIssues('### 施工方案\n\n传统做法。', [{ title: '工程概况', sections: ['项目基本信息', '编制依据'] }]);
    expect(issues).toHaveLength(0);
  });

  it('四新变体标题（新技术应用/四新应用）同样识别为承诺', () => {
    const issues = innovationTechCoverageIssues('### 施工方案\n\n传统做法。', [{ title: '某章', sections: ['新技术应用'] }]);
    expect(issues).toHaveLength(1);
  });
});

describe('innovationTechCoverageIssues 成稿判定（结构口径：小节标题 + ≥200 字）', () => {
  it('承诺小节在正文成稿（标题精确匹配 + 正文 ≥200 字）时不报', () => {
    const markdown = `### 新技术、新工艺、新材料、新设备的应用\n\n${LONG_BODY}${LONG_BODY}`;
    expect(innovationTechCoverageIssues(markdown, COMMITTED_OUTLINE)).toHaveLength(0);
  });

  it('成稿标题被语义重写（顿号改写为“与”）时按 fuzzy 命中不误报', () => {
    const markdown = `### 新技术新工艺新材料与新设备的应用\n\n${LONG_BODY}${LONG_BODY}`;
    expect(innovationTechCoverageIssues(markdown, COMMITTED_OUTLINE)).toHaveLength(0);
  });

  it('承诺小节仅标题无正文时报 warning', () => {
    const issues = innovationTechCoverageIssues('### 新技术、新工艺、新材料、新设备的应用\n\n', COMMITTED_OUTLINE);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('未在正文成稿');
  });

  it('正文不足 200 字（临界线以下）仍报 warning', () => {
    // 17 × 9 = 153 字 < 200
    const markdown = `### 新技术、新工艺、新材料、新设备的应用\n\n${'新技术应用计划。'.repeat(17)}`;
    const issues = innovationTechCoverageIssues(markdown, COMMITTED_OUTLINE);
    expect(issues).toHaveLength(1);
  });

  it('正文超过 200 字（临界线以上）不报', () => {
    // 12 × 22 = 264 字 ≥ 200
    const markdown = `### 新技术、新工艺、新材料、新设备的应用\n\n${'采用装配式新工艺与数字化新技术提升施工效率。'.repeat(12)}`;
    expect(innovationTechCoverageIssues(markdown, COMMITTED_OUTLINE)).toHaveLength(0);
  });

  it('正文出现“新技术”关键词但承诺小节未成稿仍报 warning——结构检查不看关键词', () => {
    const markdown = '### 施工方案\n\n本项目采用新技术组织施工，全面推广新材料与新设备应用。';
    const issues = innovationTechCoverageIssues(markdown, COMMITTED_OUTLINE);
    expect(issues).toHaveLength(1);
  });

  it('H4 级成稿标题（主题块内的 H4 要点）同样被 fuzzy 提取命中', () => {
    const markdown = `### 保障体系\n#### 新技术、新工艺、新材料、新设备的应用\n\n${LONG_BODY}${LONG_BODY}`;
    expect(innovationTechCoverageIssues(markdown, COMMITTED_OUTLINE)).toHaveLength(0);
  });

  it('成稿标题带编号前缀同样命中', () => {
    const markdown = `### 2.3.1 新技术、新工艺、新材料、新设备的应用\n\n${LONG_BODY}${LONG_BODY}`;
    expect(innovationTechCoverageIssues(markdown, COMMITTED_OUTLINE)).toHaveLength(0);
  });
});

describe('innovationTechCoverageIssues 多章多承诺覆盖', () => {
  it('两章各承诺一个四新小节，正文只成稿一个时只报缺失的一个', () => {
    const outline = [
      { title: '章一', sections: ['新技术、新工艺、新材料、新设备的应用'] },
      { title: '章二', sections: ['科技创新与四新技术应用'] },
    ];
    const markdown = `### 新技术、新工艺、新材料、新设备的应用\n\n${LONG_BODY}${LONG_BODY}`;
    const issues = innovationTechCoverageIssues(markdown, outline);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('科技创新与四新技术应用');
  });

  it('同一承诺小节在多章重复出现时去重（只查一次）', () => {
    const outline = [
      { title: '章一', sections: ['新技术、新工艺、新材料、新设备的应用'] },
      { title: '章二', sections: ['新技术、新工艺、新材料、新设备的应用'] },
    ];
    const markdown = `### 施工方案\n\n传统做法。`;
    const issues = innovationTechCoverageIssues(markdown, outline);
    expect(issues).toHaveLength(1);
  });

  it('多承诺小节全部成稿时零 issue', () => {
    const outline = [
      { title: '章一', sections: ['新技术、新工艺、新材料、新设备的应用'] },
      { title: '章二', sections: ['科技创新与四新技术应用'] },
    ];
    const markdown = `### 新技术、新工艺、新材料、新设备的应用\n\n${LONG_BODY}${LONG_BODY}\n\n### 科技创新与四新技术应用\n\n${LONG_BODY}${LONG_BODY}`;
    expect(innovationTechCoverageIssues(markdown, outline)).toHaveLength(0);
  });
});

describe('innovationTechCoverageIssues issue 契约', () => {
  it('未成稿报 warning 级（不阻断导出，计质量分）', () => {
    const issues = innovationTechCoverageIssues('### 施工方案\n\n传统做法。', COMMITTED_OUTLINE);
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.severity).toBe('warning');
  });

  it('message 含承诺小节标题与字数口径', () => {
    const issues = innovationTechCoverageIssues('### 施工方案\n\n传统做法。', COMMITTED_OUTLINE);
    expect(issues[0]!.message).toContain('新技术、新工艺、新材料、新设备的应用');
    expect(issues[0]!.message).toContain('200 字');
  });

  it('suggestion 要求补写四新技术应用小节', () => {
    const issues = innovationTechCoverageIssues('### 施工方案\n\n传统做法。', COMMITTED_OUTLINE);
    expect(issues[0]!.suggestion).toContain('四新');
  });
});
