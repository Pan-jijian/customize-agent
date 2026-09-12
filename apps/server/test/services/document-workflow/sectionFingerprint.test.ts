/**
 * 小节标题指纹池单测（跨文档防雷同 L3）：
 * 1. titlesCollide——逐字/归一化/最长公共连续子串三档撞名判定；
 * 2. findFingerprintCollisions——池检测与 excludeDocumentId；
 * 3. 落盘/读取（CUSTOMIZE_AGENT_HOME 隔离）与滚动裁剪；
 * 4. extractHeadingTitles——成稿 H3/H4 提取。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFingerprintEntry, extractHeadingTitles, findFingerprintCollisions, loadFingerprintPool, titlesCollide } from '@/services/document-workflow/sectionFingerprint';

describe('titlesCollide（撞名判定）', () => {
  it('逐字相等 → 撞', () => {
    expect(titlesCollide('零星装饰工程', '零星装饰工程')).toBe(true);
  });

  it('归一化相等（编号/空白差异）→ 撞', () => {
    expect(titlesCollide('2.1 零星装饰工程', '零星装饰工程')).toBe(true);
  });

  it('最长公共连续子串 ≥3 字且占较短标题 ≥40% → 撞', () => {
    expect(titlesCollide('施工准备与资源调配', '施工准备与资源安排')).toBe(true);
    expect(titlesCollide('基坑开挖与支护方案', '基坑开挖及支护措施')).toBe(true);
  });

  it('公共子串不足 3 字或比率不足 → 不撞', () => {
    expect(titlesCollide('安全管理措施', '质量验收标准')).toBe(false);
    expect(titlesCollide('道路室外市政工程', '绿化养护方案编制')).toBe(false);
  });

  it('空值不撞', () => {
    expect(titlesCollide('', '零星装饰工程')).toBe(false);
    expect(titlesCollide('零星装饰工程', '   ')).toBe(false);
  });
});

describe('findFingerprintCollisions（池撞名检测）', () => {
  const pool = {
    version: 1 as const,
    entries: [
      { documentId: 'doc-old-1', templateId: 'tpl-1', h3: ['零星装饰工程', '基坑开挖与支护方案'], h4: ['测量放线'], createdAt: '2026-09-01T00:00:00.000Z' },
      { documentId: 'doc-old-2', templateId: 'tpl-1', h3: ['绿化养护施工方案'], h4: [], createdAt: '2026-09-02T00:00:00.000Z' },
    ],
  };

  it('命中池中历史标题（含 H4）', () => {
    const collisions = findFingerprintCollisions(['零星装饰工程', '测量放线', '全新的施工组织设计小节'], pool);
    expect(collisions.map(item => item.title)).toEqual(['零星装饰工程', '测量放线']);
    expect(collisions[0]!.collidedWith).toBe('零星装饰工程');
    expect(collisions[0]!.documentId).toBe('doc-old-1');
  });

  it('excludeDocumentId 排除自身（同文档重检不算撞）', () => {
    const collisions = findFingerprintCollisions(['零星装饰工程'], pool, { excludeDocumentId: 'doc-old-1' });
    expect(collisions).toEqual([]);
  });

  it('空池/空标题清单 → 空结果', () => {
    expect(findFingerprintCollisions(['零星装饰工程'], { version: 1, entries: [] })).toEqual([]);
    expect(findFingerprintCollisions([], pool)).toEqual([]);
  });
});

describe('落盘/读取（CUSTOMIZE_AGENT_HOME 隔离）', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fingerprint-test-'));
  const previousHome = process.env.CUSTOMIZE_AGENT_HOME;

  beforeAll(() => {
    process.env.CUSTOMIZE_AGENT_HOME = tempHome;
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.CUSTOMIZE_AGENT_HOME;
    else process.env.CUSTOMIZE_AGENT_HOME = previousHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('追加后可读取；同 documentId 重写覆盖', () => {
    expect(loadFingerprintPool().entries).toEqual([]);
    appendFingerprintEntry({ documentId: 'doc-1', templateId: 'tpl-1', h3: ['a小节', 'b小节'], h4: ['c要点'], createdAt: '2026-09-10T00:00:00.000Z' });
    appendFingerprintEntry({ documentId: 'doc-1', templateId: 'tpl-1', h3: ['a小节改'], h4: [], createdAt: '2026-09-10T01:00:00.000Z' });
    const pool = loadFingerprintPool();
    expect(pool.entries.length).toBe(1);
    expect(pool.entries[0]!.h3).toEqual(['a小节改']);
  });

  it('滚动裁剪（池上限 200 条）', () => {
    for (let index = 0; index < 210; index += 1) {
      appendFingerprintEntry({ documentId: `bulk-${index}`, templateId: 'tpl-1', h3: [`小节${index}`], h4: [], createdAt: '2026-09-10T00:00:00.000Z' });
    }
    const pool = loadFingerprintPool();
    expect(pool.entries.length).toBe(200);
    // 前序测试遗留 1 条 + 本轮 210 条 = 211 → 裁 11 条（doc-1 与 bulk-0..9）
    expect(pool.entries[0]!.documentId).toBe('bulk-10');
    expect(pool.entries[pool.entries.length - 1]!.documentId).toBe('bulk-209');
  });

  it('文件损坏容错（回退空池）', () => {
    fs.writeFileSync(path.join(tempHome, '.customize-agent', 'section-fingerprints.json'), '{broken json', 'utf8');
    expect(loadFingerprintPool().entries).toEqual([]);
  });
});

describe('extractHeadingTitles（成稿标题提取）', () => {
  it('提取 H3 与 H4 标题', () => {
    const markdown = ['# 文档标题', '', '## 章标题', '### 2.1 零星装饰工程', '正文……', '#### 测量放线', '##### 更深层不进池'].join('\n');
    expect(extractHeadingTitles(markdown)).toEqual({ h3: ['2.1 零星装饰工程'], h4: ['测量放线'] });
  });

  it('空文档 → 空结果', () => {
    expect(extractHeadingTitles('')).toEqual({ h3: [], h4: [] });
  });
});
