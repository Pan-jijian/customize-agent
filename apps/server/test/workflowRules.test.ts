import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_WORKFLOW_RULES, loadWorkflowRules, workflowRulesHash, type WorkflowRulesConfig } from '../src/services/document-workflow/workflowRules';
import { detectNumericScopeConflicts } from '../src/services/document-workflow/factGovernance';
import type { DocumentFact } from '../src/services/document-workflow/types';

function fact(key: string, value: string, sourceFile: string): DocumentFact {
  return { key, value, sourceFile, roleId: 'local', confidence: 1 };
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-rules-test-'));

function projectRoot(name: string) {
  const root = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(root, '.customize-agent'), { recursive: true });
  return root;
}

function writeRules(root: string, rules: DeepPartial<WorkflowRulesConfig>) {
  fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), JSON.stringify(rules), 'utf-8');
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('workflowRules 配置收口', () => {
  it('无项目覆盖时返回默认配置（含锚定清单与四分类词表）', () => {
    const rules = loadWorkflowRules();
    expect(rules.writingSpec.criticalSectionAnchors).toHaveLength(10);
    expect(rules.writingSpec.criticalSectionAnchors).toContain('主要分部分项工程施工方案');
    expect(rules.factGovernance.thresholdComparison).toContain('不低于');
    expect(rules.factGovernance.weakAnchorGapThreshold).toBe(9);
  });

  it('项目级覆盖浅合并：只覆盖给出的键，缺失键回退默认', () => {
    const root = projectRoot('partial-override');
    writeRules(root, { writingSpec: { divisionQuality: { minParamsPerPackage: 6 } } });
    const rules = loadWorkflowRules(root);
    expect(rules.writingSpec.divisionQuality.minParamsPerPackage).toBe(6);
    // 未覆盖的兄弟键与父级键回退默认
    expect(rules.writingSpec.divisionQuality.blockerMinPackages).toBe(DEFAULT_WORKFLOW_RULES.writingSpec.divisionQuality.blockerMinPackages);
    expect(rules.writingSpec.criticalSectionAnchors).toHaveLength(10);
    expect(rules.factGovernance.weakAnchorGapThreshold).toBe(9);
  });

  it('覆盖文件损坏时静默回退默认配置', () => {
    const root = projectRoot('broken-json');
    fs.writeFileSync(path.join(root, '.customize-agent', 'workflow-rules.json'), '{ not valid json', 'utf-8');
    expect(loadWorkflowRules(root)).toEqual(DEFAULT_WORKFLOW_RULES);
  });

  it('配置哈希随覆盖变化（不同配置哈希不同，同配置哈希一致）', () => {
    const rootA = projectRoot('hash-a');
    const rootB = projectRoot('hash-b');
    writeRules(rootA, { factGovernance: { weakAnchorGapThreshold: 5 } });
    writeRules(rootB, { factGovernance: { weakAnchorGapThreshold: 20 } });
    expect(workflowRulesHash(rootA)).not.toBe(workflowRulesHash(rootB));
    expect(workflowRulesHash(rootA)).toBe(workflowRulesHash(rootA));
    expect(workflowRulesHash()).toBe(workflowRulesHash());
  });
});

describe('项目级规则覆盖进入裁决链路', () => {
  it('覆盖 weakAnchorGapThreshold：默认判 low 的弱锚定在放宽阈值后升为 medium', () => {
    const facts = [
      fact('project_scale_1', '总建筑面积（含连廊及设备用房）为4646㎡', '招标文件.pdf'),
      fact('project_scale_2', '总建筑面积约4645㎡', '图纸.pdf'),
    ];
    const defaultRules = loadWorkflowRules();
    const conflictWithDefault = detectNumericScopeConflicts(facts, defaultRules).find(item => item.kind === 'area');
    expect(conflictWithDefault!.confidence).toBe('low');
    const customRules: WorkflowRulesConfig = { ...defaultRules, factGovernance: { ...defaultRules.factGovernance, weakAnchorGapThreshold: 20 } };
    const conflictWithCustom = detectNumericScopeConflicts(facts, customRules).find(item => item.kind === 'area');
    expect(conflictWithCustom!.confidence).toBe('medium');
  });

  it('覆盖 thresholdComparison 词表：新增“不得低于”后同类门槛句式被剔除', () => {
    const facts = [
      fact('project_scale_1', '总建筑面积20000㎡', '招标文件.pdf'),
      fact('project_scale_2', '业绩要求：建筑面积不得低于19000㎡', '补疑1.docx'),
    ];
    // 默认词表不含“不得低于”→ 19000 作为本体候选进入裁决池，与 20000 冲突（未覆盖时可见冲突）
    const before = detectNumericScopeConflicts(facts).find(item => item.kind === 'area');
    expect(before).toBeDefined();
    // 项目级覆盖词表后 → threshold 剔除，不判冲突（19000 不再污染 20000）
    const defaultRules = loadWorkflowRules();
    const customRules: WorkflowRulesConfig = {
      ...defaultRules,
      factGovernance: { ...defaultRules.factGovernance, thresholdComparison: `${defaultRules.factGovernance.thresholdComparison}|不得低于` },
    };
    expect(detectNumericScopeConflicts(facts, customRules).find(item => item.kind === 'area')).toBeUndefined();
  });
});
