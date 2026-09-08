import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'apps/server/src'),
    },
  },
  test: {
    globals: true,
    include: ['apps/server/test/skeleton-extraction-repro.manual.ts'],
    testTimeout: 180_000,
  },
});
