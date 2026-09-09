/**
 * types：document-workflow 领域类型 barrel（P5 切割后保留为纯 re-export 重组，零逻辑改动）。
 * - types/core.ts：Draft/Fact/Evidence（模板/证据/事实/草稿/图谱/任务书）
 * - types/validation.ts：Issue/Gate/Report（校验问题/门禁/报告/复核清单/telemetry）
 * - types/progress.ts：Stage/Diagnostics（执行阶段/诊断/资产生成策略）
 */
export * from './types/core';
export * from './types/validation';
export * from './types/progress';
