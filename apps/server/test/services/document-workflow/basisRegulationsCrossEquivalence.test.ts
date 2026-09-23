/**
 * 编制依据对账：等价引用形态 + 声明侧区段分层（4.55.31 巢湖终稿 22 处缺口归因回归）。
 *
 * 归因分两类：
 * A. 判据缺口（等价形态被漏认）：① 编号全角（ＧＢ５０２０４－２０１５）与半角混写；
 *    ② 标准名写在表格单元格/独立条目内**不带书名号**（等价引用形态）；
 * B. 声明侧区段分层：词锚段（与「编制依据」无关的标题段内正文行含「编制依据」字样）
 *    被并入声明源后，其条目既算「已声明」又被排除出正文 → 凭空产生「声明未用」；
 *    分层后回归正文语境（r28j 零条目兜底不回归）。
 *
 * 正例：等价形态引用不得报缺口；负例：真未使用必须仍报。
 */
import { describe, expect, it } from 'vitest';
import { auditBasisRegulationsCross, renderGapLabel } from '@/services/document-workflow/basisRegulationsCross';

describe('编制依据对账：等价引用形态（正反例）', () => {
  it('全角编号 + 名称编号分离书写：正文引用半角编号 → 不报缺口', () => {
    const markdown = [
      '## 第1章 编制依据',
      '《混凝土结构工程施工质量验收规范》 ＧＢ ５０２０４－２０１５',
      '',
      '## 第2章 施工方案',
      '钢筋进场验收按 GB 50204-2015 的检验批规定执行，试件由监理见证取样。',
    ].join('\n');
    const audit = auditBasisRegulationsCross(markdown);
    expect(audit.declaredNotUsed.map(renderGapLabel)).toEqual([]);
    expect(audit.usedNotDeclared.map(renderGapLabel)).toEqual([]);
  });

  it('正文以无书名号独立条目（表格单元格）书写标准全名 → 视为等价引用，不报缺口', () => {
    const markdown = [
      '## 第1章 编制依据',
      '《建筑机电工程抗震设计规范》（GB 50981-2014）',
      '',
      '## 第2章 抗震支吊架安装',
      '| 分项 | 执行标准 |',
      '| --- | --- |',
      '| 抗震支吊架 | 建筑机电工程抗震设计规范 |',
    ].join('\n');
    const audit = auditBasisRegulationsCross(markdown);
    expect(audit.declaredNotUsed.map(renderGapLabel)).toEqual([]);
  });

  it('负例：真未使用的声明条目必须仍报（等价形态不放松对账）', () => {
    const markdown = [
      '## 第1章 编制依据',
      '《混凝土结构工程施工质量验收规范》（GB 50204-2015）',
      '《砌体结构工程施工质量验收规范》（GB 50203-2011）',
      '',
      '## 第2章 施工方案',
      '钢筋进场验收按 GB 50204-2015 的检验批规定执行。',
    ].join('\n');
    const audit = auditBasisRegulationsCross(markdown);
    expect(audit.declaredNotUsed).toHaveLength(1);
    expect(renderGapLabel(audit.declaredNotUsed[0])).toContain('GB 50203-2011');
  });

  it('负例：正文引用的未声明条目必须仍报（等价形态不产生虚假命中）', () => {
    const markdown = [
      '## 第1章 编制依据',
      '《混凝土结构工程施工质量验收规范》（GB 50204-2015）',
      '',
      '## 第2章 施工方案',
      '钢筋验收按 GB 50204-2015 执行，砌体验收按 GB 50203-2011 执行。',
    ].join('\n');
    const audit = auditBasisRegulationsCross(markdown);
    expect(audit.usedNotDeclared.map(renderGapLabel).join('|')).toContain('GB 50203-2011');
  });
});

describe('编制依据对账：声明侧区段分层（词锚段回归正文语境）', () => {
  it('标题段有声明条目 → 词锚段（危大依据清单）不再算声明源，条目回归正文语境', () => {
    const markdown = [
      '## 第1章 编制依据',
      '《混凝土结构工程施工质量验收规范》（GB 50204-2015）',
      '',
      '## 第2章 施工方案',
      '钢筋进场验收按 GB 50204-2015 的检验批规定执行。',
      '',
      '## 第3章 危大工程安全管理',
      '危险性较大的分部分项工程编制依据清单：《建筑施工模板安全技术规范》（JGJ 162-2008）',
    ].join('\n');
    const audit = auditBasisRegulationsCross(markdown);
    // 分层前：词锚段被并入声明源 → JGJ 162-2008 记「声明未用」（凭空缺口）
    expect(audit.declaredNotUsed.map(renderGapLabel)).toEqual([]);
    // 分层后：该条回归正文语境 → 正文引用未声明（修复端据此补入编制依据，语义正确）
    expect(audit.usedNotDeclared.map(renderGapLabel).join('|')).toContain('JGJ 162-2008');
  });

  it('r28j 兜底不回归：标题段零声明条目 → 退回全量候选（含词锚段）', () => {
    const markdown = [
      '## 第1章 编制依据',
      '本工程执行国家现行法律、行政法规与工程建设标准。',
      '',
      '## 第2章 施工部署',
      '施工组织设计编制依据清单：《建筑施工模板安全技术规范》（JGJ 162-2008）',
      '',
      '## 第3章 工程概况',
      '本工程新建DN200给水管道。',
    ].join('\n');
    const audit = auditBasisRegulationsCross(markdown);
    // 兜底生效：词锚段（第2章）重新作为声明源 → 未被正文引用时照旧报「声明未用」
    expect(audit.declaredNotUsed.map(renderGapLabel).join('|')).toContain('JGJ 162-2008');
  });
});
