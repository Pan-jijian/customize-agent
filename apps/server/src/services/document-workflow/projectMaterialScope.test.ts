/**
 * projectMaterialScope 单测：项目资料范围圈定（路径归一/去重/过滤/审计/越界断言）。
 */
import { describe, expect, it } from 'vitest';
import {
  assertEvidenceInProjectScope,
  createProjectMaterialScope,
  filterEvidenceByProjectScope,
  filterFactsByProjectScope,
  isScopeEnforced,
  projectScopeAudit,
  sourceInProjectScope,
} from './projectMaterialScope';
import type { DocumentEvidence } from './types';

function makeEvidence(filePath: string): DocumentEvidence {
  return { chapterId: 'c1', filePath, score: 1, content: '' };
}

describe('createProjectMaterialScope / isScopeEnforced', () => {
  it('路径归一（大小写）并去重去空', () => {
    const scope = createProjectMaterialScope('p1', ['/Proj/A.pdf', '/proj/a.pdf', '/Proj/B.pdf', '', '/Proj/B.pdf']);
    expect(scope.projectId).toBe('p1');
    expect(scope.allowedFilePaths).toEqual(['/proj/a.pdf', '/proj/b.pdf']);
  });

  it('默认无文件 → 不强制执行', () => {
    expect(isScopeEnforced(createProjectMaterialScope('p1'))).toBe(false);
    expect(isScopeEnforced(undefined)).toBe(false);
    expect(isScopeEnforced(createProjectMaterialScope('p1', ['/a.pdf']))).toBe(true);
  });
});

describe('sourceInProjectScope', () => {
  const scope = createProjectMaterialScope('p1', ['/Proj/A.pdf']);

  it('未强制时一律放行', () => {
    expect(sourceInProjectScope('/other.pdf', undefined)).toBe(true);
    expect(sourceInProjectScope('/other.pdf', createProjectMaterialScope('p1'))).toBe(true);
  });

  it('强制时仅白名单路径放行（大小写不敏感）', () => {
    expect(sourceInProjectScope('/proj/a.pdf', scope)).toBe(true);
    expect(sourceInProjectScope('/other.pdf', scope)).toBe(false);
    expect(sourceInProjectScope(undefined, scope)).toBe(false);
  });
});

describe('filterEvidenceByProjectScope / filterFactsByProjectScope', () => {
  const scope = createProjectMaterialScope('p1', ['/Proj/A.pdf']);

  it('证据过滤', () => {
    const items = [makeEvidence('/Proj/A.pdf'), makeEvidence('/other.pdf')];
    expect(filterEvidenceByProjectScope(items, scope)).toHaveLength(1);
  });

  it('事实按 sourceFile 过滤', () => {
    const facts = [
      { key: '工期', fieldName: '工期', fieldId: '', value: '300天', sourceFile: '/Proj/A.pdf', roleId: 'r1', confidence: 1 },
      { key: '金额', fieldName: '金额', fieldId: '', value: '1亿', sourceFile: '/other.pdf', roleId: 'r1', confidence: 1 },
    ];
    expect(filterFactsByProjectScope(facts, scope)).toEqual([facts[0]]);
  });

  it('未强制时不过滤', () => {
    const items = [makeEvidence('/a.pdf'), makeEvidence('/b.pdf')];
    expect(filterEvidenceByProjectScope(items)).toEqual(items);
  });
});

describe('projectScopeAudit', () => {
  it('逐条审计放行状态', () => {
    const scope = createProjectMaterialScope('p1', ['/Proj/A.pdf']);
    const audit = projectScopeAudit([makeEvidence('/Proj/A.pdf'), makeEvidence('/other.pdf')], scope);
    expect(audit.map(item => item.allowed)).toEqual([true, false]);
    expect(audit[0].chapterId).toBe('c1');
  });
});

describe('assertEvidenceInProjectScope', () => {
  const scope = createProjectMaterialScope('p1', ['/Proj/A.pdf']);

  it('未强制或全在范围 → 不抛错', () => {
    expect(() => assertEvidenceInProjectScope([makeEvidence('/a.pdf')], createProjectMaterialScope('p1'), 'ctx')).not.toThrow();
    expect(() => assertEvidenceInProjectScope([makeEvidence('/Proj/A.pdf')], scope, 'ctx')).not.toThrow();
  });

  it('越界证据抛 EVIDENCE_SCOPE_VIOLATION（含上下文与样例）', () => {
    expect(() => assertEvidenceInProjectScope([makeEvidence('/Proj/A.pdf'), makeEvidence('/out1.pdf'), makeEvidence('/out2.pdf')], scope, '生成门禁'))
      .toThrow('EVIDENCE_SCOPE_VIOLATION:生成门禁:/out1.pdf；/out2.pdf');
  });
});
