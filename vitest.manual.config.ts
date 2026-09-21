/**
 * .manual.ts 真实验证脚本专用配置（不进常规门禁：include 只匹配 *.manual.ts）。
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/xxx.manual.ts
 *      npx vitest run --config vitest.manual.config.ts packages/knowledge/__tests__/xxx.manual.ts
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // knowledge 包内的真实文件验证脚本（如 OCR 图纸切片）此前不在 include 内、无法被 --config 选中
      include: ['apps/*/test/**/*.manual.ts', 'packages/*/__tests__/**/*.manual.ts'],
    },
  }),
);
