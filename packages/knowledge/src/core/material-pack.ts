/**
 * 资料包（Material Pack）身份派生。
 *
 * 定义：知识库（projectRoot）下的顶层资料目录（如「舒城(2)」「9.24寿春路…」）= 一个资料包；
 * 包 ID = 顶层目录名本身——知识库内唯一、可读、与模板 projectBindings.materialRootPath 及
 * resolveAgentMaterialScope 的 selectedRoots 完全同口径（同一集合、同一字符串）。
 *
 * 存在的意义：切片/父块/文件全链路携带 material_root 后，检索可按资料包 ID 直接取数，
 * 取代「把资料组展开为千级文件白名单、再对全库结果做 file_path IN (...) 过滤」的间接取数方式
 * （用户诉求：按 ID 拿到准确且心智负担低的数据）。
 */

/** 顶层散文件（无目录层级）不归属任何资料包 */
export const MATERIAL_ROOT_NONE = '';

/** 从相对路径派生资料包 ID（首段目录）；顶层散文件返回空串。与 topLevelGroup/selectByRoots 同口径 */
export function materialRootOf(relativePath: string): string {
  const normalized = String(relativePath ?? '').replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0) return MATERIAL_ROOT_NONE;
  return normalized.slice(0, slashIndex);
}

/** 派生一组文件的资料包 ID 集合（去重、剔除空） */
export function materialRootsOfFiles(relativePaths: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const filePath of relativePaths) {
    const root = materialRootOf(filePath);
    if (root) roots.add(root);
  }
  return [...roots];
}

/** 把资料范围 root（目录名，或「目录/文件」路径）归一化为资料包 ID 口径（首段；单段整体视为包名） */
export function materialRootFromScopeRoot(scopeRoot: string): string {
  const normalized = String(scopeRoot ?? '').replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
  const slashIndex = normalized.indexOf('/');
  return slashIndex > 0 ? normalized.slice(0, slashIndex) : normalized;
}

/** 归一化一组范围 root 的资料包 ID 集合（去重、剔除空） */
export function materialRootsOfScopeRoots(scopeRoots: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const scopeRoot of scopeRoots) {
    const root = materialRootFromScopeRoot(scopeRoot);
    if (root) roots.add(root);
  }
  return [...roots];
}

/** 老库回填用的 SQL 表达式：与 materialRootOf 完全同口径（首段目录，无斜杠取空串） */
export function materialRootSqlExpression(column = 'relative_path'): string {
  return `CASE WHEN instr(${column}, '/') > 0 THEN substr(${column}, 1, instr(${column}, '/') - 1) ELSE '' END`;
}
