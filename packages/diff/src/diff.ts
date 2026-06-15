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
    throw new Error(`无法找到匹配项：${search}`);
  }

  /**
   * 生成 Unified Diff 格式的预览 —— 在修改前展示给用户确认用。
   */
  static generateUnifiedDiff(
    filename: string, oldStr: string, newStr: string,
  ): string {
    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');
    let preview = `\`\`\`diff\n--- a/${filename}\n+++ b/${filename}\n`;

    const maxLen = Math.max(oldLines.length, newLines.length);
    let hasChanges = false;

    for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i] ?? '';
      const newLine = newLines[i] ?? '';
      if (oldLine !== newLine) {
        hasChanges = true;
        if (oldLines[i] !== undefined) preview += `-${oldLine}\n`;
        if (newLines[i] !== undefined) preview += `+${newLine}\n`;
      }
    }

    preview += `\`\`\``;
    return hasChanges ? preview : '(无变化)';
  }
}
