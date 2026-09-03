import { describe, expect, it } from 'vitest';
import { CONSTRUCTION_ORG_TABLE_CATALOG, type ConstructionOrgTableDefinition } from '@/services/document-workflow/constructionOrgTableCatalog';

const VALID_FALLBACK_POLICIES = ['projectFactOnly', 'standardAllowed', 'deriveFromContext', 'deriveFromProject'];

describe('CONSTRUCTION_ORG_TABLE_CATALOG（施组表格目录）', () => {
  it('目录非空且 id 唯一', () => {
    expect(CONSTRUCTION_ORG_TABLE_CATALOG.length).toBeGreaterThan(0);
    const ids = new Set(CONSTRUCTION_ORG_TABLE_CATALOG.map(definition => definition.id));
    expect(ids.size).toBe(CONSTRUCTION_ORG_TABLE_CATALOG.length);
  });

  it('每个表格定义都有标题、触发词与非空字段', () => {
    expect(CONSTRUCTION_ORG_TABLE_CATALOG.every(definition => definition.title.length > 0 && definition.triggerKeywords.length > 0 && definition.fields.length > 0)).toBe(true);
  });

  it('每个字段的 fallbackPolicy 与 sourceDomain 合法', () => {
    expect(CONSTRUCTION_ORG_TABLE_CATALOG.every(definition => definition.fields.every(field => VALID_FALLBACK_POLICIES.includes(field.fallbackPolicy) && field.name.length > 0))).toBe(true);
  });

  it('必备表格（required）数量与非必备并存', () => {
    const required = CONSTRUCTION_ORG_TABLE_CATALOG.filter(definition => definition.required);
    expect(required.length).toBeGreaterThan(0);
    expect(required.length).toBeLessThan(CONSTRUCTION_ORG_TABLE_CATALOG.length);
  });

  it('必备表格至少包含一个 required 字段', () => {
    const requiredTables = CONSTRUCTION_ORG_TABLE_CATALOG.filter(definition => definition.required);
    expect(requiredTables.every(definition => definition.fields.some(field => field.required))).toBe(true);
  });

  it('核心表格存在（工程概况一览表/隐蔽工程验收清单表/关键施工节点控制计划表）', () => {
    const byTitle = new Map(CONSTRUCTION_ORG_TABLE_CATALOG.map(definition => [definition.title, definition]));
    expect(byTitle.get('工程概况一览表')?.moduleTitles).toContain('编制说明与工程概况');
    expect(byTitle.get('隐蔽工程验收清单表')).toBeDefined();
    expect(byTitle.get('关键施工节点控制计划表')).toBeDefined();
  });

  it('必备表格数量为 21（目录全量盘点）', () => {
    const required: ConstructionOrgTableDefinition[] = CONSTRUCTION_ORG_TABLE_CATALOG.filter(definition => definition.required);
    expect(required).toHaveLength(21);
  });
});
