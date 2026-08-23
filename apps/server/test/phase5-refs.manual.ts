import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildReferenceQualityProfile, suggestProjectType } from '../src/services/document-workflow/referenceQualityProfile';
import { buildTypeProfiles, normalizeHeadingTitle, referenceQualityTargetLines, referenceStructureSuggestion, type TemplateReferenceRecord } from '../src/services/document-workflow/templateReferenceService';
import type { ReferenceQualityProfile, ReferenceProjectType } from '../src/services/document-workflow/referenceQualityProfile';

const indexPath = () => path.join(os.homedir(), '.customize-agent', 'template-references', 'references.json');

function makeProfile(wordCount: number, headings: string[], tables: string[], params: Array<{ token: string; count: number }>): ReferenceQualityProfile {
  return {
    wordCount,
    effectiveWordCount: wordCount,
    paramDensity: 12,
    paramCount: Math.round(wordCount * 12 / 1000),
    arrowChainCoverage: 0.6,
    duplicationRate: 0.05,
    tableCount: tables.length * 5,
    sectionCount: headings.length,
    subsectionCount: headings.length * 4,
    subitemCount: headings.length * 6,
    avgSectionWords: Math.round(wordCount / headings.length),
    headingStructure: headings,
    tableTitles: tables,
    paramTokens: params,
    segmentCount: 100,
    arrowChainSegmentCount: 60,
    duplicatedSegmentCount: 5,
  };
}

function makeRecord(id: string, projectType: ReferenceProjectType, profile: ReferenceQualityProfile, isPrimary = false): TemplateReferenceRecord {
  return { id, fileName: `${id}.pdf`, projectType, typeSource: 'manual', uploadedAt: Date.now(), fileSize: 1024, filePath: `files/${id}.pdf`, status: 'ready', qualityProfile: profile, isPrimary };
}

const ORIGINAL_INDEX = (() => { try { return fs.existsSync(indexPath()) ? fs.readFileSync(indexPath(), 'utf-8') : ''; } catch { return ''; } })();

describe('模板参考库类型画像（T2/T5/T6）冒烟', () => {
  beforeAll(() => {
    // 备份真实参考库索引，写入合成样本（房建 2 份 + 市政 1 份单样本）
    const recordA = makeRecord('ref-smoke-a', '房建', makeProfile(20000, ['编制依据', '工程概况', '施工部署', '施工进度计划', '主要施工方案', '质量保证措施', '安全文明施工', '竣工验收'], ['主要施工机械设备表', '劳动力计划表'], [{ token: '养护', count: 5 }, { token: '数值参数（数字+单位）', count: 40 }]), true);
    const recordB = makeRecord('ref-smoke-b', '房建', makeProfile(30000, ['编制依据', '工程概况', '施工部署', '施工总平面布置', '主要施工方案', '质量保证措施', '安全文明施工', '绿色施工', '应急预案'], ['主要施工机械设备表', '施工进度计划表'], [{ token: '养护', count: 8 }, { token: '数值参数（数字+单位）', count: 60 }]));
    const recordC = makeRecord('ref-smoke-c', '市政', makeProfile(15000, ['工程概况', '施工方案', '质量措施'], ['进度计划表'], [{ token: '数值参数（数字+单位）', count: 30 }]), true);
    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify([recordA, recordB, recordC]), 'utf-8');
  });
  afterAll(() => {
    if (ORIGINAL_INDEX) fs.writeFileSync(indexPath(), ORIGINAL_INDEX, 'utf-8');
    else { try { fs.unlinkSync(indexPath()); } catch { /* 无原文件 */ } }
  });

  it('画像提取：表格标题清单与参数词条（含数值归并）', () => {
    const profile = buildReferenceQualityProfile('第一章 工程概况\n主要施工机械设备表\n劳动力计划表\n混凝土养护 7 天，强度等级 C30，搭接长度 35d，厚度 200mm。\n施工工艺如下：钢筋绑扎→模板安装→混凝土浇筑→养护。');
    expect(profile.tableTitles).toContain('主要施工机械设备表');
    expect(profile.paramTokens.some(item => item.token === '养护' && item.count >= 1)).toBe(true);
    expect(profile.paramTokens.some(item => item.token === '数值参数（数字+单位）' && item.count >= 1)).toBe(true);
    expect(profile.headingStructure).toContain('工程概况');
  });

  it('T2 类型画像聚合：房建 2 样本合并频次与指标区间', () => {
    const profiles = buildTypeProfiles();
    const house = profiles.find(item => item.projectType === '房建');
    expect(house).toBeTruthy();
    expect(house!.sourceCount).toBe(2);
    expect(house!.totalWords).toBe(50000);
    const heading = house!.typicalHeadings.find(item => item.title === '质量保证措施');
    expect(heading).toBeTruthy();
    expect(heading!.count).toBe(2);
    expect(heading!.ratio).toBe(1);
    const table = house!.commonTables.find(item => item.title === '主要施工机械设备表');
    expect(table?.count).toBe(2);
    const param = house!.frequentParams.find(item => item.token === '数值参数（数字+单位）');
    expect(param?.count).toBe(100);
    expect(house!.metrics.paramDensity.avg).toBe(12);
  });

  it('T5 蓝图注入：≥2 样本含量化目标与典型章节，1 样本只给结构参考', () => {
    const lines = referenceQualityTargetLines({ templateName: '某安置房小区住宅楼建设项目施工组织设计', chapterTitles: ['编制依据', '工程概况', '施工部署', '主要施工方案'], targetWords: 25000 });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some(line => line.includes('工艺参数密度参考'))).toBe(true);
    expect(lines.some(line => line.includes('典型章节结构参考'))).toBe(true);
    expect(lines.some(line => line.includes('质量保证措施'))).toBe(true);
    const single = referenceQualityTargetLines({ templateName: '某市政道路改造工程', chapterTitles: ['工程概况'], targetWords: 15000 });
    expect(single.length).toBeGreaterThan(0);
    expect(single.some(line => line.includes('工艺参数密度参考'))).toBe(false);
    expect(single.some(line => line.includes('典型章节结构参考'))).toBe(true);
    // 无同类型样本：不注入
    const none = referenceQualityTargetLines({ templateName: '某矿山工程', chapterTitles: ['工程概况'], targetWords: 10000 });
    expect(none).toEqual([]);
  });

  it('T6 大纲建议：缺失高频章节识别 + 标题归一化（第X章前缀）', () => {
    expect(normalizeHeadingTitle('第一章 编制依据')).toBe('编制依据');
    expect(normalizeHeadingTitle('3.1 工程概况')).toBe('工程概况');
    const suggestion = referenceStructureSuggestion({ templateName: '某安置房小区住宅楼建设项目', chapterTitles: ['第一章 编制依据', '第二章 工程概况', '第三章 施工部署', '第四章 主要施工方案'] });
    expect(suggestion).toBeTruthy();
    expect(suggestion!.projectType).toBe('房建');
    expect(suggestion!.sourceCount).toBe(2);
    expect(suggestion!.missingHeadings.length).toBeGreaterThan(0);
    const quality = suggestion!.missingHeadings.find(item => item.title === '质量保证措施');
    expect(quality?.ratio).toBe(1);
    expect(suggestion!.missingHeadings.some(item => item.title === '施工进度计划' && item.ratio === 0.5)).toBe(true);
    // 已存在的章节不进入建议
    expect(suggestion!.missingHeadings.some(item => item.title === '编制依据')).toBe(false);
  });

  it('13 类类型识别：模板名+章节组合可判房建', () => {
    expect(suggestProjectType('某安置房小区建设项目施工组织设计 主体结构施工方案 建筑概况 基坑支护')).toBe('房建');
  });
});
