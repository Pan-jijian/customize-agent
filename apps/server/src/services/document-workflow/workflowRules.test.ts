/**
 * workflowRules 单测：默认工作流规则结构完整性、项目级覆盖加载（.customize-agent/workflow-rules.json
 * 逐层浅合并）、损坏 JSON 静默回退、规则哈希稳定性（裁决缓存键随配置变化）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKFLOW_RULES, loadWorkflowRules, workflowRulesHash } from './workflowRules';

/** 每个用例创建唯一临时项目根目录，规避 loadWorkflowRules 进程级缓存串扰 */
const tempDirs: string[] = [];
function createProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-rules-test-'));
  tempDirs.push(dir);
  return dir;
}

function writeOverride(projectRoot: string, override: unknown) {
  const configDir = path.join(projectRoot, '.customize-agent');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'workflow-rules.json'), JSON.stringify(override), 'utf8');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('DEFAULT_WORKFLOW_RULES', () => {
  it('factGovernance 五键齐全且非空', () => {
    const keys = Object.keys(DEFAULT_WORKFLOW_RULES.factGovernance) as Array<keyof typeof DEFAULT_WORKFLOW_RULES.factGovernance>;
    expect(keys).toHaveLength(5);
    for (const key of ['thresholdComparison', 'amendmentContext', 'aspirationalPrefix', 'addendumSource'] as const) {
      expect(DEFAULT_WORKFLOW_RULES.factGovernance[key].length).toBeGreaterThan(0);
    }
    expect(DEFAULT_WORKFLOW_RULES.factGovernance.weakAnchorGapThreshold).toBe(9);
  });

  it('writingSpec 结构完整且正则源非空', () => {
    const spec = DEFAULT_WORKFLOW_RULES.writingSpec;
    expect(Object.keys(spec)).toEqual(['criticalSectionAnchors', 'majorContentSection', 'divisionSection', 'divisionProcessLabel', 'criticalDeepSections', 'blockerMinChars', 'divisionQuality', 'writeRules']);
    expect(spec.criticalSectionAnchors.length).toBeGreaterThan(0);
    expect(spec.majorContentSection).toBe('项目主要施工内容');
    expect(spec.divisionSection.length).toBeGreaterThan(0);
    expect(spec.divisionProcessLabel.length).toBeGreaterThan(0);
    expect(spec.criticalDeepSections.length).toBeGreaterThan(0);
    expect(spec.writeRules.majorContent.length).toBeGreaterThan(0);
    expect(spec.writeRules.division.length).toBeGreaterThan(0);
  });

  it('divisionQuality 阈值与生成侧判定常量一致', () => {
    const quality = DEFAULT_WORKFLOW_RULES.writingSpec.divisionQuality;
    expect(quality).toEqual({ blockerMinPackages: 3, minPackages: 5, minParamsPerPackage: 4, minArrowChainLength: 4, minPackageChars: 150, balanceRatio: 1 / 3 });
  });

  it('blockerMinChars 四档门槛齐备', () => {
    expect(DEFAULT_WORKFLOW_RULES.writingSpec.blockerMinChars).toEqual({ emergency: 650, majorContent: 1800, division: 1200, focus: 1500 });
  });
});

describe('loadWorkflowRules', () => {
  it('无 projectRoot 返回默认规则', () => {
    expect(loadWorkflowRules()).toEqual(DEFAULT_WORKFLOW_RULES);
  });

  it('无覆盖文件时返回默认规则', () => {
    const root = createProjectRoot();
    expect(loadWorkflowRules(root)).toEqual(DEFAULT_WORKFLOW_RULES);
  });

  it('逐层浅合并：只覆盖给出的键，缺失键回退默认', () => {
    const root = createProjectRoot();
    writeOverride(root, {
      factGovernance: { weakAnchorGapThreshold: 15 },
      writingSpec: { blockerMinChars: { emergency: 800 } },
    });
    const rules = loadWorkflowRules(root);
    // 覆盖生效
    expect(rules.factGovernance.weakAnchorGapThreshold).toBe(15);
    expect(rules.writingSpec.blockerMinChars.emergency).toBe(800);
    // 未覆盖的兄弟键回退默认（blockerMinChars 逐键合并而非整体替换）
    expect(rules.writingSpec.blockerMinChars.majorContent).toBe(1800);
    expect(rules.writingSpec.blockerMinChars.division).toBe(1200);
    // 未覆盖的顶层键整体回退默认
    expect(rules.factGovernance.thresholdComparison).toBe(DEFAULT_WORKFLOW_RULES.factGovernance.thresholdComparison);
    expect(rules.writingSpec.divisionQuality.minPackages).toBe(5);
    expect(rules.writingSpec.writeRules.division).toBe(DEFAULT_WORKFLOW_RULES.writingSpec.writeRules.division);
  });

  it('数组型键整体替换：criticalSectionAnchors 覆盖', () => {
    const root = createProjectRoot();
    writeOverride(root, { writingSpec: { criticalSectionAnchors: ['危大工程'] } });
    const rules = loadWorkflowRules(root);
    expect(rules.writingSpec.criticalSectionAnchors).toEqual(['危大工程']);
    expect(rules.writingSpec.majorContentSection).toBe('项目主要施工内容');
  });

  it('覆盖文件 JSON 损坏时静默回退默认配置，不阻断', () => {
    const root = createProjectRoot();
    const configDir = path.join(root, '.customize-agent');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'workflow-rules.json'), '{ not-valid json', 'utf8');
    expect(loadWorkflowRules(root)).toEqual(DEFAULT_WORKFLOW_RULES);
  });

  it('覆盖文件根节点非对象时回退默认配置', () => {
    const root = createProjectRoot();
    writeOverride(root, [1, 2, 3]);
    expect(loadWorkflowRules(root)).toEqual(DEFAULT_WORKFLOW_RULES);
  });

  it('同一 projectRoot 进程内缓存复用（锁定现状：覆盖文件不热更新）', () => {
    const root = createProjectRoot();
    writeOverride(root, { factGovernance: { weakAnchorGapThreshold: 15 } });
    const first = loadWorkflowRules(root);
    // 磁盘上改写覆盖文件后再次加载仍返回缓存对象——模块注释声明的进程生命周期缓存行为
    writeOverride(root, { factGovernance: { weakAnchorGapThreshold: 99 } });
    const second = loadWorkflowRules(root);
    expect(second).toBe(first);
    expect(second.factGovernance.weakAnchorGapThreshold).toBe(15);
  });
});

describe('workflowRulesHash', () => {
  it('相同配置哈希稳定', () => {
    expect(workflowRulesHash()).toBe(workflowRulesHash());
  });

  it('不同项目覆盖产生不同哈希（裁决缓存键随配置变化失效）', () => {
    const rootA = createProjectRoot();
    writeOverride(rootA, { factGovernance: { weakAnchorGapThreshold: 15 } });
    const rootB = createProjectRoot();
    expect(workflowRulesHash(rootA)).not.toBe(workflowRulesHash(rootB));
  });

  it('相同覆盖内容哈希一致', () => {
    const rootA = createProjectRoot();
    const rootB = createProjectRoot();
    writeOverride(rootA, { factGovernance: { weakAnchorGapThreshold: 15 } });
    writeOverride(rootB, { factGovernance: { weakAnchorGapThreshold: 15 } });
    expect(workflowRulesHash(rootA)).toBe(workflowRulesHash(rootB));
  });
});
