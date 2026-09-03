import { describe, expect, it, vi } from 'vitest';

// @customize-agent/runtime 是 workspace 外部包，os 级 mock 无法穿透（被 externalize），
// 直接 mock 包导出，验证 configService 的单例语义。
let constructCount = 0;
vi.mock('@customize-agent/runtime', () => ({
  ConfigStore: class FakeConfigStore {
    constructor() {
      constructCount += 1;
    }
    load() {
      return { language: 'zh' };
    }
  },
}));

import { getConfigStore } from '@/services/common/configService';

describe('getConfigStore', () => {
  it('返回单例实例（仅构造一次）', () => {
    const first = getConfigStore();
    const second = getConfigStore();
    expect(second).toBe(first);
    expect(constructCount).toBe(1);
    expect(first.load()).toEqual({ language: 'zh' });
  });
});
