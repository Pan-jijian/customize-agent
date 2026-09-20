/**
 * D-T4 ① 选材纪律写作硬约束防回归（r28f #4/#20 归因）：
 * 「禁止转述合同管理程序条款」第 11 条注入 generationWritingConstraintsPrompt（源码级断言）——
 * 该约束是选材纪律的写作端主通道（正文清洗通道只兜底实测锁定形态），防后续重构删改导致源头失守；
 * 与 H3（正文清洗）、S4（检测端豁免）三通道互补：写作端预防 + 检测端零误报 + 交付端确定性清洗。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');
const stagePrepareSource = readFileSync(path.join(SRC_DIR, 'generationStages', 'stagePrepare.ts'), 'utf8');

describe('D-T4 ① stagePrepare 写作硬约束第 11 条（选材纪律）', () => {
  it('第 11 条已作为字符串字面量注入硬约束数组', () => {
    expect(stagePrepareSource).toContain("'11. 禁止转述合同管理程序条款");
  });

  it('第 11 条覆盖资格承诺原文与合同履约程序枚举', () => {
    expect(stagePrepareSource).toContain('拟派项目经理目前无在岗项目');
    expect(stagePrepareSource).toContain('承诺从其他项目变更至本项目');
    expect(stagePrepareSource).toContain('开工令签发程序');
    expect(stagePrepareSource).toContain('项目经理变更批准程序');
    expect(stagePrepareSource).toContain('人员请假/更换/离场批准程序');
    expect(stagePrepareSource).toContain('分包审批程序');
  });

  it('第 11 条位于硬约束数组内（“10. 行文完整性”之后、第 10 条序号之后）', () => {
    const clause10 = stagePrepareSource.indexOf('10. 行文完整性');
    const clause11 = stagePrepareSource.indexOf('11. 禁止转述合同管理程序条款');
    expect(clause10).toBeGreaterThan(-1);
    expect(clause11).toBeGreaterThan(clause10);
  });
});
