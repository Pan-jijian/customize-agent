import { describe, expect, it } from 'vitest';
import { detectNumericScopeConflicts, numericScopeResolutions, renderScopeOverrideAnchors } from '../src/services/document-workflow/factGovernance';
import type { DocumentFact } from '../src/services/document-workflow/types';

function fact(key: string, value: string, sourceFile: string, roleId = 'local'): DocumentFact {
  return { key, value, sourceFile, roleId, confidence: 1 };
}

describe('数值语境四分类：门槛型剔除（19000 事故回归）', () => {
  it('补疑资格条款“业绩要求：建筑面积不低于19000㎡”不得覆盖招标正文建设规模20000㎡（不判冲突）', () => {
    const facts = [
      fact('project_scale_1', '2.6建设规模：总建筑面积20000㎡', '招标文件正文.pdf'),
      fact('project_scale_2', '项目经理业绩要求：承担过单项建筑面积不低于19000㎡的房屋建筑工程', '徽光阁项目施工补疑1.docx'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    expect(conflicts.find(item => item.kind === 'area')).toBeUndefined();
  });

  it('补疑“不少于15000㎡”资格条款不污染正文4645㎡（既不改写也不判冲突）', () => {
    const facts = [
      fact('project_scale_1', '2.6建设规模：建筑面积约为4645㎡', '招标文件正文.pdf'),
      fact('project_scale_2', '投标人业绩要求：单项合同建筑面积不少于15000㎡', '补疑1.docx'),
    ];
    expect(detectNumericScopeConflicts(facts)).toEqual([]);
  });

  it('门槛型与本体同文件混写时只取本体口径（不误判阈值数值）', () => {
    const facts = [
      fact('project_scale_1', '建设规模：总建筑面积4645㎡；业绩门槛：建筑面积不低于3000㎡', '招标文件.pdf'),
    ];
    expect(detectNumericScopeConflicts(facts).find(item => item.kind === 'area')).toBeUndefined();
  });
});

describe('数值语境四分类：修正型裁决（amendment → high 置信度）', () => {
  it('补疑“总建筑面积调整为19000㎡”是正式修正，裁决修正值且置信度 high', () => {
    const facts = [
      fact('project_scale_1', '总建筑面积20000㎡', '招标文件正文.pdf'),
      fact('project_scale_2', '总建筑面积调整为19000㎡', '补疑1.docx'),
    ];
    const conflict = detectNumericScopeConflicts(facts).find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('19000㎡');
    expect(conflict!.confidence).toBe('high');
  });
});

describe('置信度分级与确定性改写门槛', () => {
  it('本体口径胜出（锚定强）→ medium，参与确定性改写', () => {
    const facts = [
      fact('project_scale_1', '建设规模：建筑面积约为4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：建筑面积约为4646㎡', '补疑1.docx'),
    ];
    const conflict = detectNumericScopeConflicts(facts).find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.confidence).toBe('medium');
  });

  it('本体口径胜出但锚定弱（口径词与数值间隔超阈值）→ low，不参与确定性改写', () => {
    const facts = [
      fact('project_scale_1', '总建筑面积（含连廊及设备用房）为4646㎡', '招标文件.pdf'),
      fact('project_scale_2', '总建筑面积约4645㎡', '图纸.pdf'),
    ];
    const conflicts = detectNumericScopeConflicts(facts);
    const conflict = conflicts.find(item => item.kind === 'area');
    expect(conflict).toBeDefined();
    expect(conflict!.confidence).toBe('low');
    // low 置信度裁决不进入确定性改写池
    expect(numericScopeResolutions(conflicts).size).toBe(0);
  });
});

describe('裁决锚点分级措辞', () => {
  it('high：强制统一措辞（正文禁止出现败选值）', () => {
    const facts = [
      fact('project_scale_1', '总建筑面积20000㎡', '招标文件.pdf'),
      fact('project_scale_2', '总建筑面积调整为19000㎡', '补疑1.docx'),
    ];
    const lines = renderScopeOverrideAnchors(detectNumericScopeConflicts(facts));
    expect(lines.some(line => line.includes('必须统一为') && line.includes('正文禁止出现'))).toBe(true);
  });

  it('medium：应统一措辞（避免使用败选值）', () => {
    const facts = [
      fact('project_scale_1', '建设规模：建筑面积约为4645㎡', '招标文件.pdf'),
      fact('project_scale_2', '建设规模：建筑面积约为4646㎡', '补疑1.docx'),
    ];
    const lines = renderScopeOverrideAnchors(detectNumericScopeConflicts(facts));
    expect(lines.some(line => line.includes('应统一为') && line.includes('避免使用'))).toBe(true);
  });

  it('low：参考口径措辞（请人工复核，不强制改写）', () => {
    const facts = [
      fact('project_scale_1', '总建筑面积（含连廊及设备用房）为4646㎡', '招标文件.pdf'),
      fact('project_scale_2', '总建筑面积约4645㎡', '图纸.pdf'),
    ];
    const lines = renderScopeOverrideAnchors(detectNumericScopeConflicts(facts));
    expect(lines.some(line => line.includes('参考口径为') && line.includes('请人工复核') && line.includes('不参与自动改写'))).toBe(true);
  });
});

describe('新口径：层数与车位数（个位数数值支持）', () => {
  it('层数跨文件冲突：补疑优先，裁决“8层”', () => {
    const facts = [
      fact('floors_1', '总层数6层', '招标文件.pdf'),
      fact('floors_2', '总层数8层', '补疑1.docx'),
    ];
    const conflict = detectNumericScopeConflicts(facts).find(item => item.kind === 'floors');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('8层');
  });

  it('车位数跨文件冲突：补疑优先，裁决“200个”', () => {
    const facts = [
      fact('parking_1', '总车位120个', '招标文件.pdf'),
      fact('parking_2', '总车位200个', '补疑1.docx'),
    ];
    const conflict = detectNumericScopeConflicts(facts).find(item => item.kind === 'parkingSpaces');
    expect(conflict).toBeDefined();
    expect(conflict!.resolution).toBe('200个');
  });

  it('层数同文件一致值不判冲突', () => {
    const facts = [
      fact('floors_1', '总层数6层，地上层数6层', '招标文件.pdf'),
    ];
    expect(detectNumericScopeConflicts(facts).find(item => item.kind === 'floors')).toBeUndefined();
  });
});
