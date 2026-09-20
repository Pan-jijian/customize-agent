/**
 * F-T3 暗标合规边界：正文禁图反向门禁（markdownComposer.bodyCompositionFigureIssues）与
 * 身份禁语零容忍终检（detectors.identityLeakageIssues）判定矩阵。
 * 禁图：正文 markdown 图片/HTML img/图件占位残留 → blocker；文末附表区与封面块不属正文口径不触发；
 * 明标口径（bodyFigureForbidden 未启用）恒不触发。
 * 身份禁语：获奖过去式/业绩承揽/量化完成式/证书编号四组判据 → blocker；裸「我公司」自称、
 * 工序语（完成过工程验收）、第三方单位名不触发（防误伤）。全部断言按源码实现逐条推导，真实行为锁定。
 */
import { describe, expect, it } from 'vitest';
import { bodyCompositionFigureIssues } from '@/services/document-workflow/markdownComposer';
import { identityLeakageIssues } from '@/services/document-workflow/documentIntegrityChecks';

describe('F-T3 bodyCompositionFigureIssues 暗标正文禁图门禁', () => {
  it('bodyFigureForbidden=false/undefined → 不触发（明标口径）', () => {
    expect(bodyCompositionFigureIssues('![图](a.png)', false)).toEqual([]);
    expect(bodyCompositionFigureIssues('![图](a.png)')).toEqual([]);
  });

  it('正文 markdown 图片 → blocker', () => {
    const issues = bodyCompositionFigureIssues('## 第一章\n\n正文\n![总平面图](p.png)\n后续', true);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].category).toBe('structure');
    expect(issues[0].message).toContain('1 处');
  });

  it('正文行内图片与 HTML img → blocker', () => {
    expect(bodyCompositionFigureIssues('正文![图](a.png)后续', true)).toHaveLength(1);
    expect(bodyCompositionFigureIssues('正文<img src="a.png">后续', true)).toHaveLength(1);
  });

  it('正文图件占位括号语（全/半角）→ blocker', () => {
    expect(bodyCompositionFigureIssues('正文（图位：管线综合布置图）后续', true)).toHaveLength(1);
    expect(bodyCompositionFigureIssues('正文(此处插入施工平面布置图)后续', true)).toHaveLength(1);
  });

  it('图片与占位混合 → 合并计数', () => {
    const issues = bodyCompositionFigureIssues('![图](a.png)\n（图位：B）\n<img src="c.png">', true);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('3 处');
  });

  it('文末附表区图片 → 不触发（附表口径外）', () => {
    expect(bodyCompositionFigureIssues('正文无图\n\n## 附表一 主要设备表\n\n![设备表](t.png)\n', true)).toEqual([]);
  });

  it('封面块内图片 → 不触发（封面口径外）', () => {
    expect(bodyCompositionFigureIssues('<div class="document-cover">\n![封面图](c.png)\n</div>\n\n正文无图', true)).toEqual([]);
  });

  it('正文无图无占位 → 不触发', () => {
    expect(bodyCompositionFigureIssues('## 第一章\n\n纯文字正文。', true)).toEqual([]);
  });
});

describe('F-T3 identityLeakageIssues 身份禁语零容忍终检', () => {
  it('identityForbidden=false/undefined → 不触发（明标口径）', () => {
    expect(identityLeakageIssues('我公司曾荣获优质工程奖', false)).toEqual([]);
    expect(identityLeakageIssues('我公司曾荣获优质工程奖')).toEqual([]);
  });

  it('获奖过去式（荣获/曾获/获得过/被评为 + 奖项域）→ blocker', () => {
    for (const text of ['曾荣获省级优质工程奖', '曾获得过市级文明工地称号', '被评为优秀施工单位', '本项目荣获先进单位荣誉']) {
      const issues = identityLeakageIssues(text, true);
      expect(issues).toHaveLength(1);
      expect(issues[0].severity).toBe('blocker');
      expect(issues[0].category).toBe('format');
    }
  });

  it('业绩承揽（承接过/承建过 + 工程域）→ blocker', () => {
    const issues = identityLeakageIssues('我公司承接过同类市政工程项目', true);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
  });

  it('量化完成式（完成过 + 数量词 + 工程/项目）→ blocker', () => {
    const issues = identityLeakageIssues('近三年完成过 3 个类似项目', true);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
  });

  it('证书编号类自我标识 → blocker', () => {
    const issues = identityLeakageIssues('资质证书编号：D123456789', true);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
  });

  it('M29 第三方单位证书编号语境 → 不触发（设计/勘察/监理单位资质编号属工程概况真实披露，非投标人身份标记）', () => {
    expect(identityLeakageIssues('本工程设计单位为某市城建设计研究总院有限公司，工程设计甲级证书编号：A123400302。', true)).toEqual([]);
    expect(identityLeakageIssues('勘察单位资质证书编号：B234567。', true)).toEqual([]);
    expect(identityLeakageIssues('监理单位资质证书编号：C345678。', true)).toEqual([]);
  });

  it('M29 反向守护：投标人自证证书编号仍拦截；句级窗口隔离（第三方句豁免不连带投标人句）', () => {
    const selfClaim = identityLeakageIssues('我公司安全生产许可证编号：D456789，有效期至2027年。', true);
    expect(selfClaim).toHaveLength(1);
    const mixed = identityLeakageIssues('设计单位资质证书编号：A123400302。我公司资质证书编号：D123456789。', true);
    expect(mixed).toHaveLength(1);
    expect(mixed[0].message).toContain('1 处');
  });

  it('裸「我公司」自称 → 不触发（暗标允许匿名自称）', () => {
    expect(identityLeakageIssues('我公司将在本工程中投入充足资源。', true)).toEqual([]);
  });

  it('工序语「完成过工程验收」→ 不触发（无数量词不命中量化式）', () => {
    expect(identityLeakageIssues('该分项完成过工程验收后方可进入下道工序。', true)).toEqual([]);
  });

  it('第三方单位名 → 不触发（不泛检企业名）', () => {
    expect(identityLeakageIssues('施工图由第三方设计单位负责设计。', true)).toEqual([]);
  });

  it('一条文本多命中 → 去重合并为单条 blocker', () => {
    const issues = identityLeakageIssues('我公司曾荣获优质工程奖，近三年完成过 2 个类似项目。', true);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('2 处');
  });
});
