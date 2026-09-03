/**
 * documentRoleService 单测（homedir mock 到临时目录）：
 * 角色 CRUD 与 sanitize（id 清洗/默认名/executionType 回退/resourceId 回填）、
 * 配置角色墓碑（deletedRoleIds/deletedConfigIds）、导出过滤与导入改名映射。
 * 绝不触碰真实 ~/.customize-agent。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentRole, ProjectRoleConfig } from '@/services/types';
import { writeEngineeringDocumentConfig, type EngineeringDocumentConfig } from '@/services/document-validation/engineeringDocumentConfigService';
import {
  deleteDocumentRole,
  deleteProjectRoleConfig,
  exportDocumentRolesPayload,
  getProjectRoleConfig,
  importDocumentRolesPayload,
  listDocumentRoles,
  listProjectRoleConfigs,
  saveDocumentRole,
  saveProjectRoleConfig,
} from '@/services/document-core/documentRoleService';

let tempDir = '';

// Node ESM 命名空间不可配置，无法 spyOn；以模块级 mock 重定向 homedir 到临时目录
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempDir };
});

function makeRole(partial: Partial<DocumentRole> = {}): DocumentRole {
  return { id: 'role-a', name: '角色A', description: '描述', type: 'prompt', ...partial };
}

function makeConfig(partial: Partial<ProjectRoleConfig> = {}): ProjectRoleConfig {
  return { id: 'config-a', name: '配置A', description: '', promptRoles: [{ roleId: 'role-a', order: 0 }], ...partial };
}

function emptyConfig(): EngineeringDocumentConfig {
  return {
    reviewStandardQueries: [],
    reviewChapterTemplateMatchers: [],
    reviewChapterSectionDefaults: { firstChapterSections: [], chapterSections: [], firstChapterTableSections: [], firstChapterTableRequirements: [] },
    templates: [],
    roles: [],
    roleConfigs: [],
    qualityBenchmarks: [],
    autoSpecGates: [],
    chapterTitleFilters: [],
  };
}

function writeBuiltinRoles() {
  writeEngineeringDocumentConfig({
    ...emptyConfig(),
    roles: [makeRole({ id: 'builtin-role', name: '内置角色' })],
    roleConfigs: [makeConfig({ id: 'builtin-config', name: '内置配置', promptRoles: [{ roleId: 'builtin-role', order: 0 }] })],
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-role-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('saveDocumentRole sanitize', () => {
  it('保存自定义角色并可在列表读取', () => {
    saveDocumentRole(makeRole({ id: 'role-a' }));
    const roles = listDocumentRoles();
    expect(roles.map(role => role.id)).toContain('role-a');
  });

  it('id 清洗为安全字符', () => {
    // '角色 A' → 角/色/空格 3 个连字符，A 合法保留
    const saved = saveDocumentRole(makeRole({ id: '角色 A' }));
    expect(saved.id).toBe('---A');
  });

  it('缺省名回退为未命名角色', () => {
    const saved = saveDocumentRole(makeRole({ name: '' }));
    expect(saved.name).toBe('未命名角色');
  });

  it('executionType 非法值回退 reference，合法值透传', () => {
    expect(saveDocumentRole(makeRole({ executionType: 'bogus' as never })).executionType).toBe('reference');
    expect(saveDocumentRole(makeRole({ id: 'role-b', executionType: 'fact_extraction' })).executionType).toBe('fact_extraction');
  });

  it('resourceId 缺失时从 resourceIds 首位回填', () => {
    const saved = saveDocumentRole(makeRole({ id: 'role-c', resourceId: undefined, resourceIds: ['r1', 'r2'] }));
    expect(saved.resourceId).toBe('r1');
    expect(saved.resourceIds).toEqual(['r1', 'r2']);
  });

  it('resourceIds 缺失时由 resourceId 回填', () => {
    const saved = saveDocumentRole(makeRole({ id: 'role-d', resourceId: 'r0', resourceIds: undefined }));
    expect(saved.resourceIds).toEqual(['r0']);
  });
});

describe('listDocumentRoles 类型与配置合并', () => {
  it('空存储返回空列表', () => {
    expect(listDocumentRoles()).toEqual([]);
  });

  it('配置角色与自定义角色合并，配置角色 builtIn', () => {
    writeBuiltinRoles();
    saveDocumentRole(makeRole({ id: 'role-a' }));
    const roles = listDocumentRoles();
    expect(roles.map(role => role.id).sort()).toEqual(['builtin-role', 'role-a']);
    expect(roles.find(role => role.id === 'builtin-role')?.builtIn).toBe(true);
  });

  it('type 过滤返回 prompt 角色', () => {
    saveDocumentRole(makeRole({ id: 'role-a' }));
    expect(listDocumentRoles('prompt').map(role => role.id)).toContain('role-a');
  });
});

describe('deleteDocumentRole 与墓碑', () => {
  it('删除自定义角色后列表不含', () => {
    saveDocumentRole(makeRole({ id: 'role-a' }));
    deleteDocumentRole('prompt', 'role-a');
    expect(listDocumentRoles().map(role => role.id)).not.toContain('role-a');
  });

  it('删除配置角色 → 墓碑生效列表不含', () => {
    writeBuiltinRoles();
    deleteDocumentRole('prompt', 'builtin-role');
    expect(listDocumentRoles().map(role => role.id)).not.toContain('builtin-role');
  });

  it('墓碑后同名保存可恢复', () => {
    writeBuiltinRoles();
    deleteDocumentRole('prompt', 'builtin-role');
    saveDocumentRole(makeRole({ id: 'builtin-role', name: '恢复后的角色' }));
    const roles = listDocumentRoles();
    expect(roles.map(role => role.id)).toContain('builtin-role');
  });

  it('删除角色时清理配置中的引用', () => {
    writeBuiltinRoles();
    deleteDocumentRole('prompt', 'builtin-role');
    const configs = listProjectRoleConfigs();
    const builtin = configs.find(config => config.id === 'builtin-config');
    expect(builtin?.promptRoles.some(item => item.roleId === 'builtin-role')).toBe(false);
  });
});

describe('项目角色配置 CRUD', () => {
  it('保存配置后可读取', () => {
    saveProjectRoleConfig(makeConfig({ id: 'config-a' }));
    expect(getProjectRoleConfig('config-a')?.name).toBe('配置A');
    expect(listProjectRoleConfigs().map(config => config.id)).toContain('config-a');
  });

  it('配置 promptRoles 去重且 order 缺失按索引补', () => {
    const saved = saveProjectRoleConfig(makeConfig({
      id: 'config-a',
      promptRoles: [
        { roleId: 'role-a', order: 5 },
        { roleId: 'role-a', order: 9 },
        { roleId: 'role-b', order: Number.NaN },
      ],
    }));
    expect(saved.promptRoles).toHaveLength(2);
    expect(saved.promptRoles[0]!.order).toBe(5);
    expect(saved.promptRoles[1]!.order).toBe(2);
  });

  it('删除自定义配置后列表不含', () => {
    saveProjectRoleConfig(makeConfig({ id: 'config-a' }));
    deleteProjectRoleConfig('config-a');
    expect(listProjectRoleConfigs().map(config => config.id)).not.toContain('config-a');
  });

  it('删除配置角色定义 → 墓碑生效，同名保存恢复', () => {
    writeBuiltinRoles();
    deleteProjectRoleConfig('builtin-config');
    expect(listProjectRoleConfigs().map(config => config.id)).not.toContain('builtin-config');
    saveProjectRoleConfig(makeConfig({ id: 'builtin-config', name: '恢复' }));
    expect(listProjectRoleConfigs().map(config => config.id)).toContain('builtin-config');
  });

  it('不存在的配置读取返回 undefined', () => {
    expect(getProjectRoleConfig('missing')).toBeUndefined();
  });
});

describe('exportDocumentRolesPayload', () => {
  it('不传过滤返回全部自定义角色与配置', () => {
    saveDocumentRole(makeRole({ id: 'role-a' }));
    saveProjectRoleConfig(makeConfig({ id: 'config-a' }));
    const payload = exportDocumentRolesPayload();
    expect(payload.type).toBe('customize-agent.documentRoles');
    expect(payload.version).toBe(1);
    expect(payload.roles.map(role => role.id)).toContain('role-a');
    expect(payload.configs.map(config => config.id)).toContain('config-a');
  });

  it('roleIds 过滤只导出指定角色', () => {
    saveDocumentRole(makeRole({ id: 'role-a' }));
    saveDocumentRole(makeRole({ id: 'role-b', name: '角色B' }));
    const payload = exportDocumentRolesPayload({ roleIds: ['role-a'] });
    expect(payload.roles.map(role => role.id)).toEqual(['role-a']);
  });

  it('configIds 过滤只导出指定配置', () => {
    saveProjectRoleConfig(makeConfig({ id: 'config-a' }));
    saveProjectRoleConfig(makeConfig({ id: 'config-b', name: '配置B' }));
    const payload = exportDocumentRolesPayload({ configIds: ['config-b'] });
    expect(payload.configs.map(config => config.id)).toEqual(['config-b']);
  });
});

describe('importDocumentRolesPayload', () => {
  it('空 payload → 抛错', () => {
    expect(() => importDocumentRolesPayload({})).toThrow('没有可导入的角色配置');
    expect(() => importDocumentRolesPayload({ roles: [], configs: [] })).toThrow('没有可导入的角色配置');
  });

  it('无冲突导入返回计数且列表可见', () => {
    const result = importDocumentRolesPayload({
      type: 'customize-agent.documentRoles',
      version: 1,
      exportedAt: new Date().toISOString(),
      roles: [makeRole({ id: 'imported-a', name: '导入A' }), makeRole({ id: 'imported-b', name: '导入B' })],
      configs: [makeConfig({ id: 'imported-config', promptRoles: [{ roleId: 'imported-a', order: 0 }] })],
    });
    expect(result).toEqual({ importedRoles: 2, importedConfigs: 1 });
    expect(listDocumentRoles().map(role => role.id).sort()).toEqual(['imported-a', 'imported-b']);
  });

  it('id 与既有角色冲突时自动改名', () => {
    saveDocumentRole(makeRole({ id: 'role-a' }));
    const result = importDocumentRolesPayload({
      type: 'customize-agent.documentRoles',
      version: 1,
      exportedAt: '',
      roles: [makeRole({ id: 'role-a', name: '冲突导入' })],
      configs: [],
    });
    expect(result.importedRoles).toBe(1);
    const ids = listDocumentRoles().map(role => role.id);
    expect(ids.filter(id => id === 'role-a')).toHaveLength(1);
    expect(ids).toHaveLength(2);
  });

  it('配置引用经 id 映射指向新角色', () => {
    saveDocumentRole(makeRole({ id: 'role-a' }));
    importDocumentRolesPayload({
      type: 'customize-agent.documentRoles',
      version: 1,
      exportedAt: '',
      roles: [makeRole({ id: 'role-a', name: '冲突导入' })],
      configs: [makeConfig({ id: 'mapped-config', promptRoles: [{ roleId: 'role-a', order: 0 }] })],
    });
    const configs = listProjectRoleConfigs();
    const mapped = configs.find(config => config.id === 'mapped-config');
    expect(mapped?.promptRoles).toHaveLength(1);
    expect(mapped!.promptRoles[0]!.roleId).not.toBe('role-a');
    expect(listDocumentRoles().some(role => role.id === mapped!.promptRoles[0]!.roleId)).toBe(true);
  });

  it('配置引用不存在的角色被过滤', () => {
    importDocumentRolesPayload({
      type: 'customize-agent.documentRoles',
      version: 1,
      exportedAt: '',
      roles: [makeRole({ id: 'imported-a', name: '导入A' })],
      configs: [makeConfig({ id: 'orphan-config', promptRoles: [{ roleId: 'ghost-role', order: 0 }] })],
    });
    const configs = listProjectRoleConfigs();
    const orphan = configs.find(config => config.id === 'orphan-config');
    expect(orphan?.promptRoles).toEqual([]);
  });
});
