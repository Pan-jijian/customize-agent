import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import type { ConstructionOrganizationGraph } from './projectIntelligence';
import { constructionOrganizationPrompt, readProjectIntelligence } from './projectIntelligence';

function graphOf(): ConstructionOrganizationGraph {
  return {
    workPackages: [{
      name: '结构加固工程',
      scope: '主体结构加固施工',
      quantities: ['混凝土C30：120m³'],
      materials: ['钢筋｜HRB400'],
      process: ['定位放线', '剔凿清理', '植筋施工'],
      methods: ['粘贴碳纤维布'],
      acceptance: ['植筋拉拔试验合格'],
      sourceFiles: ['结构加固.xls'],
    }],
    controlMatrix: [{
      feature: '高支模区域',
      difficulty: '支撑体系风险',
      relatedWorkPackages: ['结构加固工程'],
      methods: ['专项方案'],
      qualityControls: ['验收合格'],
      safetyControls: ['旁站监督'],
    }],
    qualityControls: ['验收合格'],
    safetyControls: ['旁站监督'],
    resourcePlans: ['钢筋｜HRB400｜50t'],
    acceptanceRecords: ['检验批验收记录'],
    evidenceRankingHints: ['优先使用工程量清单、图纸设计说明、技术规范'],
  };
}

describe('constructionOrganizationPrompt', () => {
  it('无图谱或无工作包返回空串', () => {
    expect(constructionOrganizationPrompt(undefined)).toBe('');
    expect(constructionOrganizationPrompt({ ...graphOf(), workPackages: [] })).toBe('');
  });

  it('渲染工作包列表（范围/工程量/流程/验收）', () => {
    const prompt = constructionOrganizationPrompt(graphOf());
    expect(prompt).toContain('## 施工组织设计专项图谱');
    expect(prompt).toContain('主要施工工作包：');
    expect(prompt).toContain('1. 结构加固工程｜范围：主体结构加固施工');
    expect(prompt).toContain('工程量/材料：混凝土C30：120m³；钢筋｜HRB400；粘贴碳纤维布');
    expect(prompt).toContain('流程：定位放线→剔凿清理→植筋施工');
    expect(prompt).toContain('验收：植筋拉拔试验合格');
  });

  it('输出结构化 JSON 数据与重点难点矩阵', () => {
    const prompt = constructionOrganizationPrompt(graphOf());
    expect(prompt).toContain('施工工作包结构化数据：');
    expect(prompt).toContain('"name":"结构加固工程"');
    expect(prompt).toContain('重点难点—施工内容—措施矩阵：');
    expect(prompt).toContain('- 高支模区域 → 结构加固工程 → 专项方案；验收合格；旁站监督');
  });

  it('证据优先级提示作为尾行注入', () => {
    const prompt = constructionOrganizationPrompt(graphOf());
    expect(prompt).toContain('优先使用工程量清单、图纸设计说明、技术规范');
  });
});

describe('readProjectIntelligence', () => {
  it('缓存文件不存在返回 undefined', () => {
    const missingRoot = path.join(os.tmpdir(), `project-intelligence-missing-${Date.now()}-${Math.random()}`);
    expect(readProjectIntelligence(missingRoot)).toBeUndefined();
  });
});
