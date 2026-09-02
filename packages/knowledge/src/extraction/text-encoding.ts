/**
 * 文本编码自动检测与符号字体私用区（PUA）规范化。
 *
 * 背景：
 * - 知识库常混入 GBK 编码文本（中文 CAD 日志、导出 DXF、旧 CSV 等），按 UTF-8 读取会产生大
 *   量 U+FFFD 替换符乱码；Node 的 TextDecoder 内置 gbk 解码器，无需额外依赖。
 * - CAD SHX 字体与 PDF 符号字体（Wingdings 等）的字符在提取时会被映射到 Unicode 私用区
 *   码位（U+E000-U+F8FF），直接入库后检索/阅读均为不可见乱码，需映射回标准符号。
 */

/** 符号字体私用区 → 标准 Unicode 符号映射（已用实际 PDF/DXF 字形渲染验证） */
const SYMBOLIC_PUA_MAP: Record<number, string> = {
  0xE000: 'Φ', // AutoCAD SHX 字体直径符号 %%c 经 DXF 转换的私用区码位
  0xE002: 'Φ', // AutoCAD SHX 字体直径符号 %%c 的另一私用区码位（不同 SHX 字体）
  0xF052: '●', // Wingdings 2 码位 0x52 实心圆（招标文件选项标记/绿建星级标记）
  0xF0A3: '□', // Wingdings 2 码位 0xA3 空心方框（招标文件选项框）
};

/** 将符号字体私用区字符映射回标准 Unicode 符号，正常文本中不出现 PUA，替换是安全的 */
export function normalizeSymbolicPua(value: string): string {
  let result = '';
  let dirty = false;
  for (const char of value) {
    const mapped = SYMBOLIC_PUA_MAP[char.charCodeAt(0)];
    if (mapped) {
      result += mapped;
      dirty = true;
    } else {
      result += char;
    }
  }
  return dirty ? result : value;
}

/**
 * 文本编码自动检测解码：BOM（UTF-16LE/BE）→ UTF-8 → GBK。
 * UTF-8 解码替换符率高于 2% 时判定为 GBK 等非 UTF-8 编码；
 * GBK 对绝大多数字节序列都能成功解码，因此再比较两种解码结果的中文占比，
 * 只有 GBK 中文语义明显更强时才采用 GBK，避免把含个别非法字节的 UTF-8 文本误转。
 */
export function decodeTextBuffer(buffer: Buffer): { text: string; encoding: string } {
  // UTF-16 BOM 检测（部分 Windows 工具导出的 DXF/CSV 为 UTF-16）
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le').decode(buffer).replace(/^\uFEFF/u, ''), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return { text: new TextDecoder('utf-16be').decode(buffer).replace(/^\uFEFF/u, ''), encoding: 'utf-16be' };
  }

  const utf8Text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const replacementRatio = (utf8Text.match(/\uFFFD/gu) ?? []).length / Math.max(1, utf8Text.length);
  if (replacementRatio <= 0.02) return { text: utf8Text, encoding: 'utf-8' };

  try {
    const gbkText = new TextDecoder('gbk', { fatal: true }).decode(buffer);
    const cjkRatio = (value: string) => (value.match(/[\u4E00-\u9FFF]/gu) ?? []).length / Math.max(1, value.length);
    if (replacementRatio > 0.3 || cjkRatio(gbkText) > cjkRatio(utf8Text)) {
      return { text: gbkText, encoding: 'gbk' };
    }
    return { text: utf8Text, encoding: 'utf-8' };
  } catch {
    return { text: utf8Text, encoding: 'utf-8' };
  }
}
