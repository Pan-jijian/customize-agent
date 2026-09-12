/**
 * .manual.ts 真实验证脚本专用配置（不进常规门禁：include 只匹配 *.manual.ts）。
 * 运行：npx vitest run --config vitest.manual.config.ts apps/server/test/xxx.manual.ts
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['apps/*/test/**/*.manual.ts'],
    },
  }),
);
