/**
 * 4.59 A2 空壳标题链尾清除（`dropEmptyShellHeadings`）。
 *
 * ## 实测依据（7/7 份真实归档 100% 复现）
 *
 * | 文档 | 草稿级空壳 | 终稿级空节 |
 * |---|---|---|
 * | cfb0 / ea38 / ea52 | 0 | 3 |
 * | 4456 | 0 | 4 |
 *
 * 草稿阶段一个空壳都没有、终稿却有 3~4 个 → **装配/收口步骤把父标题掏空**，
 * 而缺节补写轮跑在草稿阶段、结构上就看不到 → 永远补不到。典型真实形态：
 * ```
 * ### 1.2 作业面勘察与条件核实      ← 空（草稿里它下面本是 #### 现场踏勘）
 * ### 1.3 现场踏勘                 ← 有正文
 * ```
 *
 * ## 用例矩阵（四类齐备）
 *
 * 正向 4 / 反向 4 / 边界 3 / 不变 3，共 14 例；文本逐字取自真实终稿。
 */
import { describe, expect, it } from 'vitest';
import { dropEmptyShellHeadings } from '@/services/document-workflow/finalize/repairRounds/deliveryStructureClosure';

/** 与 `structureIntegrityRules.scanEmptySubsections` 同源的独立参照实现（用于交叉验证，非被测代码） */
function emptyHeadingsReference(markdown: string): string[] {
  const lines = markdown.replace(/\r/gu, '').split('\n');
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{3,6})\s+(\S.*)$/u.exec((lines[index] || '').trim());
    if (!heading) continue;
    const level = heading[1]!.length;
    let next = index + 1;
    while (next < lines.length && (lines[next] || '').trim() === '') next += 1;
    const nextHeading = next < lines.length ? /^(#{1,6})\s+\S/u.exec((lines[next] || '').trim()) : null;
    if (next >= lines.length || (nextHeading && nextHeading[1]!.length <= level)) out.push(heading[2]!.trim());
  }
  return out;
}

describe('4.59 A2 dropEmptyShellHeadings', () => {
  // ───────────────── ① 正向 ─────────────────

  it('正向-1：真实形态（空 H3 紧跟同级 H3）→ 清除空壳，保留有正文者', () => {
    const markdown = [
      '## 第一章 主要施工方法与技术措施',
      '',
      '### 1.2 作业面勘察与条件核实',
      '### 1.3 现场踏勘',
      '项目经理、技术负责人及安全员已对施工区域完成实地踏勘，核实作业面边界与场地现状。',
    ].join('\n');
    const result = dropEmptyShellHeadings(markdown);
    expect(result.dropped).toEqual(['1.2 作业面勘察与条件核实']);
    expect(result.markdown).not.toContain('### 1.2 作业面勘察与条件核实');
    expect(result.markdown).toContain('### 1.3 现场踏勘');
    expect(result.markdown).toContain('完成实地踏勘');
  });

  it('正向-2：多处空壳一次清除（真实文档实测 3~4 处）', () => {
    const markdown = [
      '## 第二章 确保工期与质量的保障体系与措施',
      '',
      '### 2.13 绿色施工与四节一环保措施',
      '### 2.14 绿色建筑等级达标专项',
      '本项目绿色建筑按《绿色建筑评价标准》GB/T 50378-2019 二星级目标组织施工。',
      '### 2.15 绿色施工与节能降耗措施',
    ].join('\n');
    const result = dropEmptyShellHeadings(markdown);
    // 2.13 后跟同级标题 = 空；2.15 文末直落 = 空（**两条都是空壳，实现正确**）
    expect(result.dropped).toEqual(['2.13 绿色施工与四节一环保措施', '2.15 绿色施工与节能降耗措施']);
    expect(result.markdown).toContain('### 2.14 绿色建筑等级达标专项');
    expect(result.markdown).toContain('二星级目标组织施工');
  });

  it('正向-3：H4 空壳同样清除（H4 后跟同级或更高标题）', () => {
    const markdown = ['### 1.1 概况', '#### 1.1.1 子项', '#### 1.1.2 另一子项', '内容正文在此。'].join('\n');
    const result = dropEmptyShellHeadings(markdown);
    expect(result.dropped).toEqual(['1.1.1 子项']);
    expect(result.markdown).toContain('#### 1.1.2 另一子项');
  });

  it('正向-4：文末直落的空标题也清除（下一行不存在 = 空）', () => {
    const markdown = ['### 1.1 概况', '正文。', '### 1.2 空尾节'].join('\n');
    const result = dropEmptyShellHeadings(markdown);
    expect(result.dropped).toEqual(['1.2 空尾节']);
  });

  // ───────────────── ② 反向（防过度） ─────────────────

  it('反向-1：**H3 后跟 H4 子节属合法容器结构，不判空、不删除**', () => {
    const markdown = [
      '### 1.2 作业面勘察与条件核实',
      '#### 现场踏勘',
      '项目经理已对施工区域完成实地踏勘。',
    ].join('\n');
    const result = dropEmptyShellHeadings(markdown);
    expect(result.dropped).toEqual([]);
    expect(result.markdown).toBe(markdown);
  });

  it('反向-2：有直接正文的标题不得删除（哪怕只有一句话）', () => {
    const markdown = ['### 1.1 概况', '本节说明工程概况。', '### 1.2 编制依据', '依据招标文件编制。'].join('\n');
    expect(dropEmptyShellHeadings(markdown).dropped).toEqual([]);
  });

  it('反向-3：标题与正文之间隔多个空行仍算有正文', () => {
    const markdown = ['### 1.1 概况', '', '', '', '正文在多个空行之后。'].join('\n');
    expect(dropEmptyShellHeadings(markdown).dropped).toEqual([]);
  });

  it('反向-4：表格承载的小节不算空（表格行即正文）', () => {
    const markdown = [
      '### 1.1 项目基本信息表',
      '| 信息项 | 内容 |',
      '| --- | --- |',
      '| 项目名称 | 巢湖市光电新能源产业园项目 |',
    ].join('\n');
    expect(dropEmptyShellHeadings(markdown).dropped).toEqual([]);
  });

  // ───────────────── ③ 边界 ─────────────────

  it('边界-1：连续两个空壳 → 都清除，且不留下连续空行', () => {
    const markdown = ['## 第一章 工程概况', '', '### 1.1 空甲', '### 1.2 空乙', '### 1.3 有正文', '正文。'].join('\n');
    const result = dropEmptyShellHeadings(markdown);
    expect(result.dropped).toEqual(['1.1 空甲', '1.2 空乙']);
    expect(result.markdown).not.toMatch(/\n{3,}/u);
    expect(result.markdown).toContain('### 1.3 有正文');
  });

  it('边界-2：H2 与 H5/H6 边界——H2 不在本判据范围（只处理 H3~H6）', () => {
    const markdown = ['## 第一章 概况', '## 第二章 措施', ''].join('\n');
    expect(dropEmptyShellHeadings(markdown).dropped).toEqual([]);
  });

  it('边界-3：空标题紧邻另一个更高级标题（H4 空、下一个是 H3）→ 清除', () => {
    const markdown = ['### 1.1 概况', '#### 1.1.1 空子项', '### 1.2 下一节', '正文。'].join('\n');
    const result = dropEmptyShellHeadings(markdown);
    expect(result.dropped).toEqual(['1.1.1 空子项']);
  });

  // ───────────────── ④ 不变（幂等与既有行为） ─────────────────

  it('不变-1：无空壳时**逐字节不变**', () => {
    const markdown = ['## 第一章 概况', '', '### 1.1 概况', '正文。', '', '### 1.2 依据', '正文。'].join('\n');
    const result = dropEmptyShellHeadings(markdown);
    expect(result.markdown).toBe(markdown);
    expect(result.dropped).toEqual([]);
  });

  it('不变-2：**幂等**——对已处理结果再跑一次零改动', () => {
    const markdown = ['### 1.1 空甲', '### 1.2 有正文', '正文。'].join('\n');
    const once = dropEmptyShellHeadings(markdown);
    const twice = dropEmptyShellHeadings(once.markdown);
    expect(twice.markdown).toBe(once.markdown);
    expect(twice.dropped).toEqual([]);
  });

  it('不变-3：判空口径与参照实现**逐项一致**（交叉验证，防第四套判据）', () => {
    const markdown = [
      '## 第一章 主要施工方法与技术措施',
      '',
      '### 1.2 作业面勘察与条件核实',
      '### 1.3 现场踏勘',
      '踏勘正文。',
      '',
      '#### 1.3.1 空子项',
      '#### 1.3.2 有正文',
      '子项正文。',
      '',
      '### 1.4 主要施工内容',
    ].join('\n');
    const reference = emptyHeadingsReference(markdown);
    const result = dropEmptyShellHeadings(markdown);
    expect(result.dropped.sort()).toEqual(reference.sort());
  });
});
