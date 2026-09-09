/**
 * documentGeneratorHelpers barrel（P3 拆分后保留为纯 re-export 重组，零逻辑改动）。
 * 5 域子模块（只移不改，函数体逐字一致）：
 * - helpers/evidenceRetrieval.ts：证据检索/评分/优化/查询
 * - helpers/factCoverage.ts：事实覆盖检测
 * - helpers/projectBasicInfo.ts：项目基本信息事实/表格
 * - helpers/markdownCleanup.ts：正文清理/表格工具/章节质量线
 * - helpers/diagnostics.ts：诊断/健康/生成状态判定
 * index.ts 显式清单随拆分更新（P26 盘点：补齐孤儿导出 stripAtlasReferencePhrases）。
 */
export * from './helpers/evidenceRetrieval';
export * from './helpers/factCoverage';
export * from './helpers/projectBasicInfo';
export * from './helpers/markdownCleanup';
export * from './helpers/diagnostics';
