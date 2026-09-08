/**
 * t3-mf FG4 组：factsModel 后半 + 事实池裁决尾族矩阵。
 * 覆盖：sanitizeExtractedFacts（污染截断/叙述段拒收/编号回源补全）/ extractPreciseFactsFromEvidence /
 * projectPlaceName/containsForeignProject/sanitizeFactPool（乱码/表格引用噪声/跨项目隔离）/
 * detectFactConflicts / buildFactsModel（混合口径拆分/分组）/ buildSchemaFacts /
 * arbitrateFactPool（数值冲突改写/单值分组保留高优先级/多值保留）/ buildCanonicalFactModel。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildFactsModel,
  buildSchemaFacts,
  containsForeignProject,
  detectFactConflicts,
  extractPreciseFactsFromEvidence,
  projectPlaceName,
  sanitizeExtractedFacts,
  sanitizeFactPool,
  type FactSanitizeStats,
} from '@/services/document-workflow/factsModel';
import { arbitrateFactPool, buildCanonicalFactModel } from '@/services/document-workflow/factGovernance';
import type { AutoDocumentSpecPackage } from '@/services/document-workflow/../document-core/autoDocumentSpecTypes';
import type { DocumentEvidence, DocumentFact, DocumentFactsModel, FactSourceRef, ProjectGraph, StructuredTableFact } from '@/services/document-workflow/types';

const fact = (value: string, extra: Partial<DocumentFact> = {}): DocumentFact => ({
  key: 'k', value, sourceFile: '招标文件正文', roleId: 'r', confidence: 0.9, ...extra,
});
const ev = (content: string, extra: Partial<DocumentEvidence> = {}): DocumentEvidence => ({
  chapterId: 'c1', filePath: extra.filePath ?? '招标文件.txt', score: extra.score ?? 0.9, content, roleId: extra.roleId, processingType: extra.processingType ?? 'text', sectionTitle: extra.sectionTitle,
});
const stats = (): FactSanitizeStats => ({ truncated: 0, dropped: 0, repaired: 0 });

// ═══════ B1 sanitizeExtractedFacts ═══════
describe('B1 sanitizeExtractedFacts', () => {
  it('表格碎片截断保留前缀', () => {
    const s = stats();
    const result = sanitizeExtractedFacts([fact('土建与装饰工程|||||标段：|||||')], [], s);
    expect(result[0].value).toBe('土建与装饰工程');
    expect(s.truncated).toBe(1);
    expect(s.dropped).toBe(0);
  });

  it('页码污染截断', () => {
    const result = sanitizeExtractedFacts([fact('某工程第46页共47页')], [], stats());
    expect(result[0].value).toBe('某工程');
  });

  it('标题标记在句首 → 截断后空 → 丢弃', () => {
    const s = stats();
    const result = sanitizeExtractedFacts([fact('### 1.1项目概况')], [], s);
    expect(result).toHaveLength(0);
    expect(s.dropped).toBe(1);
  });

  it('截断后 <2 字符 → 丢弃', () => {
    const s = stats();
    expect(sanitizeExtractedFacts([fact('|A')], [], s)).toHaveLength(0);
    expect(s.dropped).toBe(1);
  });

  it('编号类字段非法字符 → 丢弃', () => {
    const s = stats();
    expect(sanitizeExtractedFacts([fact('编号 123', { fieldId: 'project_code' })], [], s)).toHaveLength(0);
    expect(s.dropped).toBe(1);
  });

  it('叙述段（>120 非白名单字段）→ 丢弃', () => {
    const s = stats();
    expect(sanitizeExtractedFacts([fact('长'.repeat(121), { fieldId: 'project_name' })], [], s)).toHaveLength(0);
    expect(s.dropped).toBe(1);
  });

  it('长文本白名单字段（规模）保留', () => {
    const s = stats();
    const result = sanitizeExtractedFacts([fact('长'.repeat(121), { fieldId: 'project_scale' })], [], s);
    expect(result).toHaveLength(1);
    expect(s.dropped).toBe(0);
  });

  it('编号回源补全：截断前缀匹配证据标签完整 token', () => {
    const s = stats();
    const result = sanitizeExtractedFacts(
      [fact('2026AF', { fieldId: 'project_code' })],
      [ev('招标项目编号：2026AFAGZ50906')],
      s,
    );
    expect(result[0].value).toBe('2026AFAGZ50906');
    expect(s.repaired).toBe(1);
  });

  it('编号无候选不补全', () => {
    const s = stats();
    const result = sanitizeExtractedFacts([fact('2026AF', { fieldId: 'project_code' })], [ev('其他内容')], s);
    expect(result[0].value).toBe('2026AF');
    expect(s.repaired).toBe(0);
  });

  it('编号短于 4 字符不触发补全', () => {
    const s = stats();
    const result = sanitizeExtractedFacts([fact('ABC', { fieldId: 'project_code' })], [ev('招标项目编号：ABC123456')], s);
    expect(result[0].value).toBe('ABC');
  });

  it('补全候选频次优先、同频次短优先', () => {
    const s = stats();
    const result = sanitizeExtractedFacts(
      [fact('2026AF', { fieldId: 'project_code' })],
      [ev('招标项目编号：2026AFAGZ50906\n工程编号：2026AFAGZ50906\n编号：2026AFXX')],
      s,
    );
    expect(result[0].value).toBe('2026AFAGZ50906');
  });

  it('无污染无变更 → 原引用', () => {
    const f = fact('某工程');
    const result = sanitizeExtractedFacts([f], [], stats());
    expect(result[0]).toBe(f);
  });

  it('空值跳过', () => {
    const s = stats();
    expect(sanitizeExtractedFacts([fact('  ')], [], s)).toHaveLength(0);
  });
});

// ═══════ B2 extractPreciseFactsFromEvidence ═══════
describe('B2 extractPreciseFactsFromEvidence', () => {
  it('参数 token 提取（C30/120mm/DN100）', () => {
    const facts = extractPreciseFactsFromEvidence([ev('C30混凝土，120mm厚，DN100管道')]);
    expect(facts.map(item => item.value)).toContain('C30');
    expect(facts.map(item => item.value)).toContain('120mm');
    expect(facts.map(item => item.value)).toContain('DN100');
    expect(facts[0].fieldId).toBe('technical_parameter');
    expect(facts[0].key).toBe('精确参数');
  });

  it('低分且来源无关键词 → 跳过', () => {
    const facts = extractPreciseFactsFromEvidence([ev('C30混凝土', { score: 0.5, roleId: 'x', processingType: 'text', filePath: 'a.txt' })]);
    expect(facts).toHaveLength(0);
  });

  it('低分但来源含表格关键词 → 不跳过', () => {
    const facts = extractPreciseFactsFromEvidence([ev('C30混凝土', { score: 0.5, roleId: 'x', processingType: 'table' })]);
    expect(facts).toHaveLength(1);
  });

  it('同文件同 token 去重', () => {
    const facts = extractPreciseFactsFromEvidence([ev('C30混凝土 C30砂浆')]);
    expect(facts.filter(item => item.value === 'C30')).toHaveLength(1);
  });

  it('无参数文本 → 空', () => {
    expect(extractPreciseFactsFromEvidence([ev('普通说明文字')])).toHaveLength(0);
  });

  it('置信度保底 0.7', () => {
    const facts = extractPreciseFactsFromEvidence([ev('C30混凝土', { score: 0.5, processingType: 'table' })]);
    expect(facts[0].confidence).toBe(0.7);
  });
});

// ═══════ B3 projectPlaceName/containsForeignProject/sanitizeFactPool ═══════
describe('B3 项目范围隔离族', () => {
  it('projectPlaceName 提取地名核心', () => {
    expect(projectPlaceName('合肥市某大学宿舍楼工程')).toBe('合肥市');
    expect(projectPlaceName('肥西县某工程')).toBe('肥西县');
    expect(projectPlaceName('某大学宿舍楼工程')).toBeUndefined();
  });

  it('containsForeignProject 判别外域项目短语', () => {
    expect(containsForeignProject('舒城县某教学楼工程', '合肥市')).toBe(true);
    expect(containsForeignProject('合肥市某教学楼工程', '合肥市')).toBe(false);
    expect(containsForeignProject('无地名描述', '合肥市')).toBe(false);
  });

  it('sanitizeFactPool 乱码事实丢弃（CJK 扩展区短值）', () => {
    const result = sanitizeFactPool([fact('𠀀𠀀𠀀', { key: '项目名称' })]);
    expect(result).toHaveLength(0);
  });

  it('表格单元格引用噪声丢弃', () => {
    const result = sanitizeFactPool([fact('R6C3COL3：上海开艺设计集团有限公司', { key: '招标人' })]);
    expect(result).toHaveLength(0);
  });

  it('表格引用噪声但残留正文长 → 保留', () => {
    const result = sanitizeFactPool([fact(`R6C3：${'上海开艺设计集团有限公司详细地址信息'.repeat(3)}`, { key: '招标人' })]);
    expect(result).toHaveLength(1);
  });

  it('项目名称候选含外域项目 → 置空丢弃', () => {
    const result = sanitizeFactPool([
      fact('合肥市某大学宿舍楼工程', { key: '项目名称', fieldId: 'project_name' }),
      fact('舒城县某教学楼工程', { key: '项目名称候选' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('合肥市某大学宿舍楼工程');
  });

  it('招标范围按句切分保留当前项目段', () => {
    const result = sanitizeFactPool([
      fact('合肥市某大学宿舍楼工程', { key: '项目名称', fieldId: 'project_name' }),
      fact('合肥市某大学宿舍楼施工；舒城县某教学楼工程施工', { key: '招标范围' }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[1].value).toBe('合肥市某大学宿舍楼施工');
  });

  it('招标范围单句全外域 → 置空丢弃', () => {
    const result = sanitizeFactPool([
      fact('合肥市某大学宿舍楼工程', { key: '项目名称', fieldId: 'project_name' }),
      fact('舒城县某教学楼工程施工', { key: '招标范围' }),
    ]);
    expect(result).toHaveLength(1);
  });

  it('无项目名事实 → 仅乱码过滤', () => {
    const result = sanitizeFactPool([fact('舒城县某教学楼工程施工', { key: '招标范围' })]);
    expect(result).toHaveLength(1);
  });

  it('项目名短于 6 字符不启用隔离', () => {
    const result = sanitizeFactPool([
      fact('某工程', { key: '项目名称', fieldId: 'project_name' }),
      fact('舒城县某工程', { key: '项目名称候选' }),
    ]);
    expect(result).toHaveLength(2);
  });
});

// ═══════ B4 detectFactConflicts ═══════
describe('B4 detectFactConflicts', () => {
  it('空事实 → 无冲突', async () => {
    expect(await detectFactConflicts([])).toEqual([]);
  });

  it('同字段不同值 → 冲突消息（量化特征值）', async () => {
    const conflicts = await detectFactConflicts([
      fact('框架结构', { key: '结构形式' }),
      fact('装配式结构', { key: '结构形式', sourceFile: '清单文件' }),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain('事实冲突：结构形式 存在多个来源值');
  });

  it('无量化特征文本值被比较器过滤 → 无冲突', async () => {
    const conflicts = await detectFactConflicts([
      fact('合肥某工程', { key: '项目名称' }),
      fact('合肥另一工程', { key: '项目名称', sourceFile: '清单文件' }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('同字段同值 → 无冲突', async () => {
    const conflicts = await detectFactConflicts([fact('合肥某工程', { key: '项目名称' }), fact('合肥某工程', { key: '项目名称', sourceFile: '清单文件' })]);
    expect(conflicts).toEqual([]);
  });

  it('非可比较字段 → 无冲突', async () => {
    const conflicts = await detectFactConflicts([fact('A', { key: '备注' }), fact('B', { key: '备注', sourceFile: 'x' })]);
    expect(conflicts).toEqual([]);
  });

  it('引用型弱值过滤（详见招标文件）', async () => {
    const conflicts = await detectFactConflicts([
      fact('合肥某工程', { key: '项目名称' }),
      fact('详见招标文件', { key: '项目名称', sourceFile: '清单文件' }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('无量化特征文本值过滤', async () => {
    const conflicts = await detectFactConflicts([
      fact('合肥某工程', { key: '项目名称' }),
      fact('普通描述内容', { key: '项目名称', sourceFile: '清单文件' }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it('多字段冲突上限 8 条', async () => {
    const facts: DocumentFact[] = [];
    for (let index = 0; index < 12; index += 1) {
      facts.push(fact(`结构形式${index}A`, { key: '结构形式', sourceFile: `文件${index}` }));
      facts.push(fact(`结构形式${index}B`, { key: '结构形式', sourceFile: `文件${index}b` }));
    }
    const conflicts = await detectFactConflicts(facts);
    expect(conflicts.length).toBeLessThanOrEqual(8);
  });
});

// ═══════ B5 buildFactsModel ═══════
describe('B5 buildFactsModel', () => {
  it('混合口径建设规模拆分（计划工期也匹配 project 过滤正则）', async () => {
    const model = await buildFactsModel([
      fact('建设规模：项目总占地面积约10970平方米，单体建筑面积28570.36平方米', { key: '建设规模', fieldId: 'project_scale' }),
      fact('180日历天', { key: '计划工期' }),
    ]);
    expect(model.project.map(item => item.key)).toEqual(['总占地面积', '单体建筑面积', '计划工期']);
    expect(model.project[0].fieldId).toBeUndefined();
    expect(model.project[1].fieldId).toBe('project_scale');
    expect(model.schedule).toHaveLength(1);
  });

  it('单一口径不拆分', async () => {
    const model = await buildFactsModel([fact('总建筑面积28570.36平方米', { key: '建设规模', fieldId: 'project_scale' })]);
    expect(model.project).toHaveLength(1);
    expect(model.project[0].key).toBe('建设规模');
  });

  it('分组：质量/安全/资源', async () => {
    const model = await buildFactsModel([
      fact('合格', { key: '质量标准' }),
      fact('风险源A', { key: '安全风险' }),
      fact('劳动力120人', { key: '劳动力' }),
    ]);
    expect(model.quality).toHaveLength(1);
    expect(model.safety).toHaveLength(1);
    expect(model.resources).toHaveLength(1);
  });

  it('missing 去重', async () => {
    const model = await buildFactsModel([], [], ['项目名称', '项目名称', '质量标准']);
    expect(model.missing).toEqual(['项目名称', '质量标准']);
  });

  it('空输入 → 空模型', async () => {
    const model = await buildFactsModel([]);
    expect(model.project).toEqual([]);
    expect(model.conflicts).toEqual([]);
  });
});

// ═══════ B6 buildSchemaFacts ═══════
describe('B6 buildSchemaFacts', () => {
  const spec = { factFields: [{ id: 'project_name', name: '项目名称', required: true }] } as AutoDocumentSpecPackage;

  it('按 spec 字段分组', () => {
    const result = buildSchemaFacts([fact('某工程', { fieldId: 'project_name' })], spec);
    expect(result['project_name']).toHaveLength(1);
  });

  it('key/fieldName 命中也可分组', () => {
    const result = buildSchemaFacts([fact('某工程', { key: '项目名称' })], spec);
    expect(result['project_name']).toHaveLength(1);
  });

  it('无 spec → 空对象', () => {
    expect(buildSchemaFacts([fact('某工程')])).toEqual({});
  });
});

// ═══════ B7 arbitrateFactPool ═══════
describe('B7 arbitrateFactPool', () => {
  it('单条以下 → 原引用', () => {
    const facts = [fact('a')];
    expect(arbitrateFactPool(facts)).toBe(facts);
    expect(arbitrateFactPool([])).toEqual([]);
  });

  it('数值冲突改写：败选值改写为补疑胜选值', () => {
    const result = arbitrateFactPool([
      fact('总建筑面积4645㎡', { key: 'project_scale' }),
      fact('总建筑面积4646㎡', { key: 'project_scale', sourceFile: '补疑文件' }),
    ]);
    const values = result.map(item => item.value).sort();
    expect(values).toEqual(['总建筑面积4646㎡', '总建筑面积4646㎡']);
  });

  it('单值字段分组：补疑优先级保留', () => {
    const result = arbitrateFactPool([
      fact('项目名称值A', { key: '项目名称', fieldId: 'project_name' }),
      fact('项目名称值B', { key: '项目名称', fieldId: 'project_name', sourceFile: '补疑文件' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('项目名称值B');
  });

  it('同优先级保留更短值', () => {
    const result = arbitrateFactPool([
      fact('项目名称值较长文本', { key: '项目名称', fieldId: 'project_name' }),
      fact('短值', { key: '项目名称', fieldId: 'project_name', sourceFile: '招标文件正文' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('短值');
  });

  it('多值事实（清单条目）保留多值', () => {
    const result = arbitrateFactPool([
      fact('C15｜工程量：100m3', { key: '清单条目：垫层', fieldId: 'bill_item' }),
      fact('C30｜工程量：200m3', { key: '清单条目：主体', fieldId: 'bill_item' }),
    ]);
    expect(result).toHaveLength(2);
  });

  it('混合：单值分组+多值保留', () => {
    const result = arbitrateFactPool([
      fact('A', { key: '项目名称', fieldId: 'project_name' }),
      fact('B', { key: '项目名称', fieldId: 'project_name', sourceFile: '补疑文件' }),
      fact('C15', { key: '清单条目：垫层', fieldId: 'bill_item' }),
      fact('C30', { key: '清单条目：主体', fieldId: 'bill_item' }),
    ]);
    expect(result).toHaveLength(3);
  });

  it('fieldId 缺失按 key 分组', () => {
    const result = arbitrateFactPool([
      fact('A', { key: '质量标准' }),
      fact('B', { key: '质量标准', sourceFile: '补疑文件' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe('B');
  });
});

// ═══════ B8 buildCanonicalFactModel ═══════
describe('B8 buildCanonicalFactModel', () => {
  const root = `/tmp/boundary-fg4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  it('结构化事实直配 projectIdentity', () => {
    const model = buildCanonicalFactModel({
      facts: [fact('某大学宿舍楼工程', { fieldId: 'project_name' })],
      projectRoot: `${root}-1`,
    });
    expect(model.projectIdentity.projectName?.value).toBe('某大学宿舍楼工程');
    expect(model.byKey.project_name.value).toBe('某大学宿舍楼工程');
  });

  it('scopeConflicts 输出+败选值源头改写', () => {
    const model = buildCanonicalFactModel({
      facts: [
        fact('总建筑面积4645㎡', { key: 'project_scale' }),
        fact('总建筑面积4646㎡', { key: 'project_scale', sourceFile: '补疑文件' }),
      ],
      projectRoot: `${root}-2`,
    });
    expect(model.scopeConflicts).toHaveLength(1);
    expect(model.scopeConflicts[0].resolution).toBe('4646㎡');
  });

  it('requiredKeys 缺口 → gaps', () => {
    const model = buildCanonicalFactModel({
      facts: [fact('某工程', { fieldId: 'project_name' })],
      requiredKeys: ['project_name', 'award_clause'],
      projectRoot: `${root}-3`,
    });
    expect(model.gaps).toHaveLength(1);
    expect(model.gaps[0].key).toBe('award_clause');
    expect(model.gaps[0].label).toBe('创优奖惩条款');
  });

  it('projectGraph 资源/风险入池', () => {
    const graph = {
      resources: [{ type: 'equipment', name: '塔吊', spec: 'QTZ80', quantity: '2', unit: '台', sourceFiles: ['a.txt'] }],
      risks: [{ risk: '深基坑', level: 'high', mitigation: '专项方案', sourceFiles: ['b.txt'] }],
    } as unknown as ProjectGraph;
    const model = buildCanonicalFactModel({ facts: [], projectGraph: graph, projectRoot: `${root}-4` });
    expect(model.resources.resources).toHaveLength(1);
    expect(model.safety.risks).toHaveLength(1);
  });

  it('建设规模混合口径净化（canonical 只留建筑面积段）', () => {
    const model = buildCanonicalFactModel({
      facts: [fact('项目总占地面积约10970平方米，单体建筑面积28570.36平方米', { key: '建设规模', fieldId: 'project_scale' })],
      projectRoot: `${root}-5`,
    });
    expect(model.byKey.project_scale.value).toBe('单体建筑面积28570.36平方米');
  });

  it('字段冲突（跨来源 project_name）→ conflicts', () => {
    const model = buildCanonicalFactModel({
      facts: [
        fact('工程A', { fieldId: 'project_name' }),
        fact('工程B', { fieldId: 'project_name', sourceFile: '清单文件' }),
      ],
      projectRoot: `${root}-6`,
    });
    expect(model.conflicts.length).toBeGreaterThan(0);
  });

  it('缓存命中：同 projectRoot 同输入第二次返回缓存', () => {
    const input = { facts: [fact('缓存工程', { fieldId: 'project_name' })], projectRoot: `${root}-7` };
    const first = buildCanonicalFactModel(input);
    const second = buildCanonicalFactModel(input);
    expect(second.projectIdentity.projectName?.value).toBe('缓存工程');
    expect(second).toEqual(first);
  });

  it('空输入 → 空模型', () => {
    const model = buildCanonicalFactModel({ facts: [], projectRoot: `${root}-8` });
    expect(model.byKey).toEqual({});
    expect(model.scopeConflicts).toEqual([]);
  });
});
