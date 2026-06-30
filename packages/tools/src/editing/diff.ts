/** SEARCH/REPLACE 补丁块 — LLM 输出的单个修改单元 */
export interface DiffBlock {
  /** 原始代码片段（用于定位） */
  search: string;
  /** 替换后的代码片段 */
  replace: string;
}

/**
 * Diff 引擎 — 解析 LLM 的 SEARCH/REPLACE 补丁块并应用到文件。
 * 这是代码修改的工具层，提供精准替换 + 模糊容错 + Unified Diff 预览。
 */
export class DiffEngine {
  /**
   * 从 LLM 文本输出中提取所有 <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE 补丁块。
   * 支持多块修改（一次输出可修改多处）。
   */
  static parseBlocks(text: string): DiffBlock[] {
    const blocks: DiffBlock[] = [];
    const regex = /<<<<<<< SEARCH\n([\S\s]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const search = match[1];
      const replace = match[2];
      if (search !== undefined && replace !== undefined) {
        blocks.push({ search, replace });
      }
    }
    return blocks;
  }

  /**
   * 将单个补丁块应用到文件内容中。
   * 策略：先精准匹配 → 不行则去尾部空白符模糊匹配 → 彻底失败则抛异常触发回滚。
   */
  static applyPatch(fileContent: string, block: DiffBlock): string {
    const { search, replace } = block;
    if (fileContent.includes(search)) {
      return fileContent.replace(search, replace);
    }
    // 模糊容错：去除尾部空白符再尝试（防止 LLM 缩进多写空格或换行）
    const cleanSearch = search.trim();
    if (cleanSearch && fileContent.includes(cleanSearch)) {
      return fileContent.replace(cleanSearch, replace.trim());
    }
    throw new Error(`Search text not found: ${search}`);
  }

  /**
   * 生成 Unified Diff 格式的预览 —— 在修改前展示给用户确认用。
   * 使用 LCS（最长公共子序列）算法进行行级内容匹配。
   */
  static generateUnifiedDiff(
    filename: string, oldStr: string, newStr: string,
  ): string {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');

    // 计算 LCS 表
    const lcs = DiffEngine._lcsMatrix(oldLines, newLines);
    // 回溯生成 diff hunks
    const hunks = DiffEngine._backtrackHunks(oldLines, newLines, lcs);

    if (hunks.length === 0) return '(无变化)';

    let preview = `\`\`\`diff\n--- a/${filename}\n+++ b/${filename}\n`;
    for (const hunk of hunks) {
      preview += `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@\n`;
      for (const line of hunk.lines) {
        preview += line + '\n';
      }
    }
    preview += `\`\`\``;
    return preview;
  }

  /** 计算行级 LCS 长度矩阵 */
  private static _lcsMatrix(a: string[], b: string[]): number[][] {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i]![j] = dp[i - 1]![j - 1]! + 1;
        } else {
          dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
        }
      }
    }
    return dp;
  }

  /** 回溯 LCS 矩阵生成 diff hunks */
  private static _backtrackHunks(
    oldLines: string[], newLines: string[], dp: number[][],
  ): Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> {
    // 1. 回溯生成编辑序列
    const edits: Array<{ type: '+' | '-' | ' '; line: string }> = [];
    let i = oldLines.length;
    let j = newLines.length;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        edits.unshift({ type: ' ', line: oldLines[i - 1]! });
        i--; j--;
      } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
        edits.unshift({ type: '+', line: newLines[j - 1]! });
        j--;
      } else {
        edits.unshift({ type: '-', line: oldLines[i - 1]! });
        i--;
      }
    }

    // 2. 将编辑序列分组为 hunks（前后各扩展 3 行上下文）
    const CTX = 3;
    const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> = [];
    let idx = 0;
    while (idx < edits.length) {
      // 跳过连续的上下文行，找到第一个变更
      while (idx < edits.length && edits[idx]!.type === ' ') idx++;
      if (idx >= edits.length) break;

      const changeStart = idx;
      // 找到变更块的结束
      while (idx < edits.length && (edits[idx]!.type !== ' ' || (idx < edits.length - 1 && edits[idx + 1]!.type !== ' '))) idx++;

      // 扩展上下文
      const hunkStart = Math.max(0, changeStart - CTX);
      const hunkEnd = Math.min(edits.length, idx + CTX);
      const slice = edits.slice(hunkStart, hunkEnd);

      // 计算行号范围
      let oldLineCount = 0, newLineCount = 0;
      for (const e of slice) {
        if (e.type !== '+') oldLineCount++;
        if (e.type !== '-') newLineCount++;
      }

      // 找到 slice 在原始数组中的起止行号
      const oldStart = hunkStart > 0 ? edits.slice(0, hunkStart).filter(e => e.type !== '+').length : 0;
      const newStart = hunkStart > 0 ? edits.slice(0, hunkStart).filter(e => e.type !== '-').length : 0;

      hunks.push({
        oldStart,
        oldCount: oldLineCount,
        newStart,
        newCount: newLineCount,
        lines: slice.map(e => `${e.type}${e.line}`),
      });
    }

    return hunks;
  }
}
