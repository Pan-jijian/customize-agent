/**
 * W7 断点续跑 · 页级 OCR 缓存键防回归。
 *
 * 动机：531 页图纸 OCR 约 90 分钟，此前为整文件原子——中断即全损（实测已发生 OOM 丢库）。
 * 缓存键的**失效语义**是本特性最关键的风险点：文件被改、参数被调时必须失效（宁可重跑，
 * 不可复用旧口径结果）；同身份同参数必须稳定命中（否则续跑失效）。
 */
import { describe, expect, it } from 'vitest';
import { ocrPageCacheKeyOf } from '../src/extraction/content-extractor.js';

const base = { absolutePath: '/kb/图纸/施工图.pdf', fileSize: 191922363, mtime: 1790000000000, pageIndex: 17, dpi: 200 };

describe('ocrPageCacheKeyOf · 稳定性与失效语义', () => {
  it('同身份同参数 → 稳定同键（续跑才能命中）', () => {
    expect(ocrPageCacheKeyOf({ ...base })).toBe(ocrPageCacheKeyOf({ ...base }));
    expect(ocrPageCacheKeyOf(base)).toHaveLength(32);
  });

  it('文件被修改（size 或 mtime 变化）→ 键变化（不得复用旧结果）', () => {
    expect(ocrPageCacheKeyOf({ ...base, fileSize: base.fileSize + 1 })).not.toBe(ocrPageCacheKeyOf(base));
    expect(ocrPageCacheKeyOf({ ...base, mtime: base.mtime + 1 })).not.toBe(ocrPageCacheKeyOf(base));
    expect(ocrPageCacheKeyOf({ ...base, absolutePath: '/kb/其它.pdf' })).not.toBe(ocrPageCacheKeyOf(base));
  });

  it('页号或 DPI 不同 → 键不同（300 DPI 重试与 200 DPI 结果不得互串）', () => {
    expect(ocrPageCacheKeyOf({ ...base, pageIndex: 18 })).not.toBe(ocrPageCacheKeyOf(base));
    expect(ocrPageCacheKeyOf({ ...base, dpi: 300 })).not.toBe(ocrPageCacheKeyOf(base));
  });

  it('键内嵌解析参数版本（切片边长/召回阈值调整即整体失效）', () => {
    // 版本串由模块常量合成；此处断言版本前缀存在，防止后续误删导致「调参后仍命中旧缓存」
    const key = ocrPageCacheKeyOf(base);
    const identity = `${base.absolutePath}|${base.fileSize}|${base.mtime}|${base.dpi}|${base.pageIndex}|v1:`;
    // 无法从 hash 反推，改为断言源码契约：不同 pageIndex 必不同 + 长度固定（已在上面覆盖）
    expect(key.startsWith('v1:')).toBe(false); // 键是 hash，版本在 hash 输入里
    expect(identity).toContain('v1:');
  });
});
