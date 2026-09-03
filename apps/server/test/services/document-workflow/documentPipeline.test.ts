import { afterEach, describe, expect, it, vi } from 'vitest';
import { finalizeEntryConsistencyFixEnabled } from '@/services/document-workflow/documentPipeline';

vi.mock('@customize-agent/knowledge', () => {
  class LocalTransformersEmbeddingProvider {}
  return { LocalTransformersEmbeddingProvider };
});

const KEY = 'DOCUMENT_FINALIZE_ENTRY_FIX';

afterEach(() => {
  delete process.env[KEY];
});

describe('finalizeEntryConsistencyFixEnabled（4.2 确定性一致性修复收敛）', () => {
  it('默认关闭：finalize 入口不再执行章节级确定性修复', () => {
    expect(finalizeEntryConsistencyFixEnabled()).toBe(false);
  });

  it('DOCUMENT_FINALIZE_ENTRY_FIX=0 显式关闭', () => {
    process.env[KEY] = '0';
    expect(finalizeEntryConsistencyFixEnabled()).toBe(false);
  });

  it('DOCUMENT_FINALIZE_ENTRY_FIX=1 恢复入口章节级修复（回退开关）', () => {
    process.env[KEY] = '1';
    expect(finalizeEntryConsistencyFixEnabled()).toBe(true);
  });
});
