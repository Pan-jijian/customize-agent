/**
 * 文本编码自动检测与符号字体私用区（PUA）规范化。
 *
 * 背景：
 * - 知识库常混入 GBK 编码文本（中文 CAD 日志、导出 DXF、旧 CSV 等），按 UTF-8 读取会产生大
 *   量 U+FFFD 替换符乱码；Node 的 TextDecoder 内置 gbk 解码器，无需额外依赖。
 * - CAD SHX 字体与 PDF 符号字体（Wingdings 等）的字符在提取时会被映射到 Unicode 私用区
 *   码位（U+E000-U+F8FF），直接入库后检索/阅读均为不可见乱码，需映射回标准符号。
 */

/**
 * 符号字体私用区 → 标准 Unicode 符号映射（已用实际 PDF/DXF 字形渲染验证）。
 * 映射目标为空字符串表示该码位是符号字体的空白字形，直接剔除。
 */
const SYMBOLIC_PUA_MAP: Record<number, string> = {
  0xE000: 'Φ', // AutoCAD SHX 字体直径符号 %%c 经 DXF 转换的私用区码位
  0xE002: 'Φ', // AutoCAD SHX 字体直径符号 %%c 的另一私用区码位（不同 SHX 字体）
  0xF052: '●', // Wingdings 2 码位 0x52 实心圆（招标文件选项标记/绿建星级标记）
  0xF0A3: '□', // Wingdings 2 码位 0xA3 空心方框（招标文件选项框）
  0xF0D8: '◆', // Wingdings 码位 0xBE 半填充菱形（CAD 图纸说明列表项项目符号，字形渲染验证）
  0xF020: '', // Wingdings 码位 0x03 空白字形（表格单元格末尾填充，无语义直接剔除）
};

/** 私用区范围：符号字体（Wingdings/SHX 等）提取产物集中于此区间 */
const PUA_START = 0xE000;
const PUA_END = 0xF8FF;

/**
 * 将符号字体私用区字符映射回标准 Unicode 符号；未收录的 PUA 字符直接剔除。
 * 正常文本中不出现 PUA，替换是安全的；未知码位保留入库即为不可见乱码，
 * 剔除优于保留（宁缺毋滥），新增符号字体可通过扩展 SYMBOLIC_PUA_MAP 恢复语义。
 */
export function normalizeSymbolicPua(value: string): string {
  let result = '';
  let dirty = false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    const mapped = SYMBOLIC_PUA_MAP[code];
    if (mapped !== undefined) {
      result += mapped;
      dirty = true;
    } else if (code >= PUA_START && code <= PUA_END) {
      dirty = true; // 未知私用区字符：剔除而非保留乱码
    } else {
      result += char;
    }
  }
  return dirty ? result : value;
}

/**
 * 外来文字区块（中文工程文档中不会合法出现的字母区）：CAD 导出的 PDF 中缺 ToUnicode CMap
 * 的 CID 字体（如标题使用的华文隶书 STLiti，内嵌子集被剥离 cmap 表）在提取时会把汉字按
 * 字形 ID 直接输出，落进西里尔/南亚/泰/藏/埃塞俄比亚等文字区块，构成“合法 Unicode 字母”
 * 乱码——基于字符可读性的过滤（isLikelyGarbledCadText/hasUsablePdfText）完全无法识别。
 * 注意：希腊字母 Φ/μ/φ 在 U+0370-U+03FF，CJK 扩展 A 生僻字在 U+3400-U+4DBF，均不在范围内，
 * 正常工程文档中的这些合法字符不会被误判。
 */
const FOREIGN_SCRIPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0400, 0x0DFF], // 西里尔文、希伯来文、阿拉伯文、南亚诸文字（天城文/孟加拉文等）
  [0x0E00, 0x0E7F], // 泰文
  [0x0F00, 0x0FFF], // 藏文
  [0x10A0, 0x10FF], // 格鲁吉亚文
  [0x1200, 0x137F], // 埃塞俄比亚文
  [0x1400, 0x167F], // 加拿大原住民音节文字
  [0x1800, 0x18AF], // 蒙古文
  [0x1A00, 0x1A1F], // 布吉文
  [0x1C00, 0x1C4F], // 列普查文
  [0x1D00, 0x1D7F], // 音标扩展
  [0x2300, 0x23FF], // 杂项技术符号（CAD 乱码常见落点 ⍱ 等）
  [0x2D00, 0x2D2F], // 格鲁吉亚文补充
];

/**
 * 判定文本是否含外来文字区块字母乱码（CID 字体缺 ToUnicode 映射的提取产物）。
 * 规则：外来字母数 >= 3 且占比 >= 0.5%——避免单字符符号误判，也避免长页内偶然字符误伤。
 */
export function hasForeignScriptGarbledText(value: string): boolean {
  let total = 0;
  let foreign = 0;
  for (const char of value) {
    if (char === ' ' || char === '\n' || char === '\t' || char === '\r') continue;
    total++;
    const code = char.charCodeAt(0);
    if (FOREIGN_SCRIPT_RANGES.some(([lo, hi]) => code >= lo && code <= hi)) foreign++;
  }
  return foreign >= 3 && foreign / Math.max(total, 1) >= 0.005;
}

/**
 * OCR 图形误识别噪声行符号集：竖线/斜线/方括号等装饰性符号（LOGO、边框、图框线被 OCR
 * 误读的产物）。注意不包含工程常用符号（@、±、×、°、Φ 等），避免误杀正常标注行。
 */
const OCR_GRAPHIC_NOISE_SYMBOL_RE = /[|\\<>[\]{}~^`_*"]/u;

/**
 * 过滤 OCR 图形误识别噪声行：LOGO、图框线等纯图形区域被 OCR 读成“< ] 人人 AL 已忌 | |”
 * 这类符号混排文本。判据：行内装饰性符号占比过高（>=25%，或 >=2 个且 >=12%）且无领域
 * 信号词/中文句读 → 剔除；正常工程标注行（“(1) 系统组成”、“φ25 钢筋 @200”）不受影响。
 */
export function filterOcrGraphicNoiseLines(value: string): string {
  const lines = String(value ?? '').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push(line);
      continue;
    }
    let total = 0;
    let symbols = 0;
    for (const char of trimmed) {
      if (char === ' ') continue;
      total++;
      if (OCR_GRAPHIC_NOISE_SYMBOL_RE.test(char)) symbols++;
    }
    const hasDomainSignal = /工程|项目|施工|设计|说明|材料|图纸|要求|标注|单位|数量|序号|名称|详见/u.test(trimmed);
    const hasHan = /[\p{Script=Han}]/u.test(trimmed);
    const hanCount = (trimmed.match(/[\p{Script=Han}]/gu) ?? []).length;
    // 编号前缀（“(1) ”、“1、”、“(1)~(5)”等）是正常图例/清单行的特征，不视为噪声
    const hasNumberedPrefix = /^[（(]?\d{1,3}[）)]?[~\-—、.]?/u.test(trimmed) && hasHan;
    const symbolRatio = total > 0 ? symbols / total : 0;
    // 装饰性符号密度过高 → 必然是图形噪声；密度中等且无领域信号 → 同样视为噪声（
    // OCR 误读的标点“。 ，”等不应豁免）；短行含装饰符号且无领域信号 → 视为噪声
    if (symbolRatio >= 0.25) continue;
    if (symbols >= 2 && symbolRatio >= 0.12 && !hasDomainSignal) continue;
    if (total <= 8 && symbols >= 1 && symbolRatio >= 0.15 && !hasHan && !hasDomainSignal) continue;
    if (total <= 20 && symbols >= 1 && symbolRatio >= 0.05 && hanCount <= 15 && !hasDomainSignal && !hasNumberedPrefix) continue;
    kept.push(line);
  }
  return kept.join('\n');
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
