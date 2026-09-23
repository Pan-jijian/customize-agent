/**
 * 4.58 R1 缺节补写锚点分流（源码防回归）。
 *
 * ## 实测缺陷
 *
 * `enforcePlannedSectionCompleteness` 把 `empty` / `too_short` / `missing` 三类缺口合成一批，
 * **统一用「章末追加」锚点**（`append: true, appendAt: 'chapter-end'`）。但 `empty` 缺口的提示词
 * 写的是「必须在**既有小节标题下**补写正文」——**指令与插入方式互相矛盾**：补写内容被追加到章末，
 * 原空标题仍然空着，于是终检「空小节」blocker 反复不清零。
 *
 * 实测 `doc-1790168542563-ea526b1b` 3 条（`机电管线预埋与系统调试` 等：标题行紧邻下一个标题行、无正文）。
 *
 * 现按缺口性质分流：`empty`/`too_short` → 锚点取该小节标题行原文、**就地补写**；
 * `missing` → 章末追加（保持原行为，新增小节落章末）。
 *
 * 为何就地补写对 `empty` 安全：r28j B8 那条「在位插入把标题行切成空壳」的风险，
 * 成立前提是**锚点行后已有正文**；空小节锚点行下本无正文，不构成该风险。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../../src/services/document-workflow/globalQualityGates.ts');

describe('4.58 R1 缺节补写锚点分流', () => {
  const source = readFileSync(SRC, 'utf8');

  it('empty/too_short 与 missing 分流为两个补写目标', () => {
    // 就地补写分支：按小节逐个建目标
    expect(source).toContain('就地补写：逐个空/过短小节，锚点取其标题行原文');
    // 章末追加分支：整节缺失合并为一批
    expect(source).toContain('章末追加：整节缺失者合并为一批');
    expect(source).toContain("appendAt: undefined");
    expect(source).toContain("appendAt: 'chapter-end'");
  });

  it('锚点取 target.anchorLine（不再硬取 lastHeadingLine）', () => {
    expect(source).toContain('anchorTexts: [{ text: target.anchorLine, append: true, appendAt: target.appendAt }]');
    expect(source).not.toContain('anchorTexts: [{ text: target.lastHeadingLine');
  });

  it('就地补写提示词要求保留标题行原文（防 LLM 改写标题）', () => {
    expect(source).toContain('**保留该小节标题行原文不动**，在其后补写正式正文段落');
  });

  it('锚点行定位与判据单源（复用 sameSectionTitle，不自造第二套标题比对）', () => {
    expect(source).toContain('sameSectionTitle(line.replace(/^#{3,4}\\s+/u, \'\'), gap.sectionTitle)');
    expect(source).toContain("import { applyDeterministicConsistencyFixes");
    expect(source).toMatch(/from '\.\/qualityValidation'/u);
  });
});
