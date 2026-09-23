/**
 * M19 planned-section-repair 章末追加落位单测（r28j B8 根因专项）：
 * 历史缺陷：补写锚点 = 章末标题行，applyAnchorPatch(append) 把补写插在「锚点行文本之后、
 * 其正文之前」——锚点行后仍有其正文时被切成空壳（emptyHeadingCount +1）→ P12 回滚（任一指标
 * 严格上升即回滚）误杀「修复 patch 未落地」（s28i 第五章实测 19→20，服务器日志 planned section
 * repair rolled back ×2）。
 * 修复：AnchorSpec.appendAt = 'chapter-end'——锚点仅作存在性校验，replacement 追加到章末，
 * 锚点原文与其后正文原位不动；LLM 复述锚点前缀由 stripAnchorEcho 剥离去重。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/services/document-workflow/llmClient', () => ({
  callDocumentLlmJson: vi.fn(),
  isContextOverflowLlmError: vi.fn(() => false),
  contextLayerChars: (parts: Array<string | undefined | false>) => parts.filter((part): part is string => Boolean(part)).reduce((sum, part) => sum + part.length, 0),
}));

import { applyChapterEndAppend } from '@/services/document-workflow/rolePipeline';

const SRC_DIR = path.resolve(__dirname, '../../../src/services/document-workflow');

/** 空壳计数（与 globalQualityGates.enforcePlannedSectionCompleteness 的 emptyHeadingCount 同口径）：
 * H2-H4 标题行后（跳过空行）无正文或直接接另一标题行即计一个 */
function emptyHeadingCount(content: string): number {
  const lines = content.split('\n');
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^#{2,4}\s+\S/u.test(lines[index].trim())) continue;
    let next = index + 1;
    while (next < lines.length && lines[next].trim() === '') next += 1;
    if (next >= lines.length || /^#{1,6}\s+\S/u.test(lines[next].trim())) count += 1;
  }
  return count;
}

// 章末标题行后仍接有正文（r28j B8 现场形态）：锚点 = 章末 H4，其后是 H4 自己的正文
const CHAPTER = [
  '## 主要施工方法',
  '',
  '### 1.1 土建施工',
  '',
  '土建施工正文。',
  '',
  '#### 公厕及配套用房土建施工',
  '',
  '公厕土建正文，与门卫安装工程穿插配合。',
].join('\n');

describe('applyChapterEndAppend（章末追加落位）', () => {
  it('锚点行后有正文：补写落章末，锚点区原位不动不切空壳', () => {
    const result = applyChapterEndAppend({
      content: CHAPTER,
      anchor: '#### 公厕及配套用房土建施工',
      replacement: '### 1.2 装饰装修工程\n\n装饰装修正文。',
      title: '主要施工方法',
      forbidDrawingImages: false,
    });
    expect(result.applied).toBe(true);
    // 锚点行后仍紧接其正文（原位保留）
    const lines = result.content.split('\n').map(line => line.trim());
    const anchorIndex = lines.indexOf('#### 公厕及配套用房土建施工');
    expect(anchorIndex).toBeGreaterThan(-1);
    expect(lines.slice(anchorIndex + 1).find(line => line !== '')).toBe('公厕土建正文，与门卫安装工程穿插配合。');
    // 空壳总数不变（历史回滚触发点：空壳上升即被 P12 回滚误杀）
    expect(emptyHeadingCount(result.content)).toBe(emptyHeadingCount(CHAPTER));
    // 补写小节落在章末
    expect(result.content.trimEnd().endsWith('装饰装修正文。')).toBe(true);
    expect(result.content.indexOf('### 1.2 装饰装修工程')).toBeGreaterThan(result.content.indexOf('公厕土建正文'));
  });

  it('LLM 复述锚点前缀：剥离后追加，锚点标题不重复出现', () => {
    const result = applyChapterEndAppend({
      content: CHAPTER,
      anchor: '#### 公厕及配套用房土建施工',
      replacement: '#### 公厕及配套用房土建施工\n\n### 1.2 装饰装修工程\n\n装饰装修正文。',
      title: '主要施工方法',
      forbidDrawingImages: false,
    });
    expect(result.applied).toBe(true);
    expect((result.content.match(/#### 公厕及配套用房土建施工/gu) || []).length).toBe(1);
    expect(result.content.trimEnd().endsWith('装饰装修正文。')).toBe(true);
  });

  it('锚点不存在（LLM 改坏/补错章）：拒绝，内容不变', () => {
    const result = applyChapterEndAppend({
      content: CHAPTER,
      anchor: '#### 不存在的标题行',
      replacement: '### 1.2 装饰装修工程\n\n正文。',
      title: '主要施工方法',
      forbidDrawingImages: false,
    });
    expect(result.applied).toBe(false);
    expect(result.content).toBe(CHAPTER);
  });

  it('空 replacement：拒绝，内容不变', () => {
    const result = applyChapterEndAppend({
      content: CHAPTER,
      anchor: '#### 公厕及配套用房土建施工',
      replacement: '   ',
      title: '主要施工方法',
      forbidDrawingImages: false,
    });
    expect(result.applied).toBe(false);
    expect(result.content).toBe(CHAPTER);
  });

  it('暗标禁图：补写含图片语法 → 拒绝', () => {
    const result = applyChapterEndAppend({
      content: CHAPTER,
      anchor: '#### 公厕及配套用房土建施工',
      replacement: '### 1.2 装饰装修工程\n\n![示意图](x.png)',
      title: '主要施工方法',
      forbidDrawingImages: true,
    });
    expect(result.applied).toBe(false);
    expect(result.content).toBe(CHAPTER);
  });
});

describe('M19 接线守护（章末追加链路）', () => {
  it('rolePipeline.ts：chapter-end 分支接线到 applyChapterEndAppend，【补写定位】不误发给章末追加锚点', () => {
    const source = readFileSync(path.join(SRC_DIR, 'rolePipeline.ts'), 'utf8');
    expect(source).toContain('export function applyChapterEndAppend');
    expect(source).toContain("spec.appendAt === 'chapter-end'");
    expect(source).toContain('applyChapterEndAppend({ content, anchor: spec.text');
    expect(source).toContain("spec.append === true && spec.appendAt !== 'chapter-end'");
  });

  it('globalQualityGates.ts：planned-section-repair 调用点锚点按缺口性质分流（4.58 R1-b）', () => {
    const source = readFileSync(path.join(SRC_DIR, 'globalQualityGates.ts'), 'utf8');
    /**
     * 4.58 R1-b 口径变更：锚点不再一律取章末标题行，而由 `target.appendAt` 决定——
     * - `missing`（整节缺失）→ `'chapter-end'`（新增小节落章末，锚点仅作存在性校验）
     * - `empty`/`too_short` → `undefined`（rolePipeline 的「补写定位」语义：就地补写在**该小节标题行后**）
     *
     * 旧实现把三类缺口合并、统一章末追加，导致 empty/too_short 的补写落在章末、
     * 原小节标题下依旧无正文 → 终检「空小节」「小节只有标题或表格无正文」反复不清零。
     */
    expect(source).toContain('anchorTexts: [{ text: target.anchorLine, append: true, appendAt: target.appendAt }]');
    expect(source).not.toContain('anchorTexts: [{ text: target.lastHeadingLine');
    // 就地补写的锚点定位必须用严格归一化相等（用同义宽容口径会把多个相似兄弟标题全锚到同一个）
    expect(source).toContain('normalizeSectionTitleForGap(line.replace(/^#{3,4}\\s+/u, \'\')) === normalizeSectionTitleForGap(gap.sectionTitle)');
  });
});
