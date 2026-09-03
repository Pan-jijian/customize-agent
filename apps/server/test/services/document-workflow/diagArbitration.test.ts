/**
 * 临时诊断：真实资料文本复现 detectNumericScopeConflicts 裁决行为（round-21 S6 反向改错根因排查）
 */
import { describe, expect, it } from 'vitest';
import { detectNumericScopeConflicts } from '@/services/document-workflow/factGovernance';
import type { DocumentFact } from '@/services/document-workflow/types';

const fact = (key: string, fieldId: string, value: string, sourceFile: string): DocumentFact => ({
  key, fieldId, fieldName: key, value, sourceFile, roleId: 'project_basic', confidence: 90,
});

const TENDER_SCALE = '项目总占地面积约10970平方米，单体建筑面积28570.36平方米（其中：地上建筑面积24783.39平方米，地下建筑面积3786.97平方米），地上6层，地下1层，建筑消防高度28.90米、建筑规划高度32.85米。本工程有装配式技术要求，装配率为30%。';

describe('diag real-data arbitration', () => {
  it('复现真实事实集的 area 裁决', () => {
    const conflicts = detectNumericScopeConflicts([
      fact('建设规模', 'project_scale', TENDER_SCALE, '招标文件.pdf'),
      fact('招标范围', 'construction_scope', '本项目分为1个标段，位于合肥市巢湖市黄麓镇，项目总占地面积约10970平方米，单体建筑面积28570.36平方米（其中：地上建筑面积24783.39平方米，地下建筑面积3786.97平方米），地上6层，地下1层，建筑高度28.90米（消防高度）、32.85米（规划高度）。', '补疑(4).docx'),
      fact('建设规模', 'project_scale', '建筑面积 28570.36 m2', '甲类公共建筑节能设计一览表表式.doc'),
    ]);
    console.log(JSON.stringify(conflicts, null, 1));
    const area = conflicts.filter(c => c.kind === 'area');
    for (const c of area) {
      console.log('AREA CONFLICT:', c.scope, 'resolution=', c.resolution, 'confidence=', c.confidence, 'values=', c.values.map(v => `${v.value}${v.unit}@${v.sourceFile}`).join(' | '));
      expect(c.resolution ?? '').not.toContain('10970');
    }
  });

  it('只给招标文件混合口径单条：area 不应产生裁决', () => {
    const conflicts = detectNumericScopeConflicts([fact('建设规模', 'project_scale', TENDER_SCALE, '招标文件.pdf')]);
    console.log(JSON.stringify(conflicts, null, 1));
    for (const c of conflicts.filter(c => c.kind === 'area')) {
      console.log('SINGLE AREA:', c.scope, c.resolution, c.values.map(v => v.value));
    }
  });
});
