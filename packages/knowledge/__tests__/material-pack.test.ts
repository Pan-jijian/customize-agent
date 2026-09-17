/**
 * material-pack 资料包 ID 派生单测：包 ID = 知识库顶层目录名（与 material_root 列 / selectedRoots 同口径）。
 * 覆盖路径归一化（反斜杠、首尾斜杠、空串）、顶层散文件剔除与 SQL 回填表达式口径。
 */
import { describe, expect, it } from 'vitest';
import {
  MATERIAL_ROOT_NONE,
  materialRootFromScopeRoot,
  materialRootOf,
  materialRootsOfFiles,
  materialRootsOfScopeRoots,
  materialRootSqlExpression,
} from '../src/core/material-pack.js';

describe('material-pack 资料包 ID 派生', () => {
  it('materialRootOf 取首段目录；顶层散文件与空串返回空', () => {
    expect(materialRootOf('舒城(2)/招标文件.pdf')).toBe('舒城(2)');
    expect(materialRootOf('9.4合肥师范学院项目/资料/图纸/总图.dwg')).toBe('9.4合肥师范学院项目');
    expect(materialRootOf('顶层散文件.pdf')).toBe(MATERIAL_ROOT_NONE);
    expect(materialRootOf('')).toBe(MATERIAL_ROOT_NONE);
  });

  it('materialRootOf 归一化反斜杠与首尾斜杠', () => {
    expect(materialRootOf('\\舒城\\a.pdf')).toBe('舒城');
    expect(materialRootOf('/舒城/a.pdf/')).toBe('舒城');
    expect(materialRootOf('//')).toBe(MATERIAL_ROOT_NONE);
  });

  it('materialRootsOfFiles 去重并剔除顶层散文件', () => {
    expect(materialRootsOfFiles(['舒城/a.pdf', '舒城/b.pdf', '丰乐镇/c.pdf', '顶层.pdf']).sort()).toEqual(['丰乐镇', '舒城']);
  });

  it('materialRootFromScopeRoot 支持目录名与「目录/文件」绑定路径归一化', () => {
    expect(materialRootFromScopeRoot('舒城')).toBe('舒城');
    expect(materialRootFromScopeRoot('舒城/招标文件.pdf')).toBe('舒城');
    expect(materialRootFromScopeRoot('\\丰乐镇\\清单.xlsx')).toBe('丰乐镇');
    expect(materialRootFromScopeRoot('')).toBe('');
  });

  it('materialRootsOfScopeRoots 归一化去重剔除空', () => {
    expect(materialRootsOfScopeRoots(['舒城', '舒城/招标文件.pdf', '', '丰乐镇']).sort()).toEqual(['丰乐镇', '舒城']);
  });

  it('materialRootSqlExpression 与 materialRootOf 同口径（首段目录，无斜杠取空串）', () => {
    expect(materialRootSqlExpression()).toBe(`CASE WHEN instr(relative_path, '/') > 0 THEN substr(relative_path, 1, instr(relative_path, '/') - 1) ELSE '' END`);
  });
});
