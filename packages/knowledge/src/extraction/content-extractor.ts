import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAndImport, resolvePackage } from './module-resolver.js';
import { createOcrProvider, type OcrProvider, type OcrRecognizeOptions, type OcrResult } from './ocr-providers.js';
import { PADDLE_DETECTION_MAX_SIDE_PX, buildPaddleRecognizeOptions } from './paddle-model-select.js';
import { planTiles, recognizeWithTiling, shouldTilePage, type RgbPixels } from './ocr-tiling.js';
import { applyOcrMisreadCorrections, decodeTextBuffer, filterOcrGraphicNoiseLines, hasForeignScriptGarbledText, normalizeSymbolicPua, restoreLatin1MojibakeAsGbk } from './text-encoding.js';
import { extractEmbeddedOfficeImages } from './office-embedded-images.js';
import { detectSmartTableHeader } from './table-header-detect.js';
import type { ClassifiedFile } from '../types.js';

/** 文件内容提取结果 */
export interface ExtractionResult {
  text: string;
  metadata: Record<string, unknown>;
  warnings: string[];
  extractionTimeMs: number;
}

type SpreadsheetCell = { v?: unknown; w?: string; f?: string; t?: string };
type SpreadsheetRange = { s: { r: number; c: number }; e: { r: number; c: number } };
type SpreadsheetSheet = Record<string, SpreadsheetCell | unknown> & { '!ref'?: string; '!merges'?: SpreadsheetRange[] };
type PdfTextItem = { str: string; x: number; y: number; width: number; height: number; fontName?: string };
/** CAD 标注实体（DXF TEXT/MTEXT/DIMENSION/LEADER/ATTRIB 提取产物，含 10/20 组码坐标） */
export type CadAnnotation = { text: string; x?: number; y?: number; layer?: string; block?: string; entityType?: string };

/**
 * CAD 标注布局重建（与 PDF layoutPdfTextItems 同构）：DXF 中总说明等长文本
 * 常被拆成多个 TEXT 实体（每行一个实体、行内拆多个实体），仅按实体序输出
 * 会导致分块入库全是碎片切片（「建筑设计总说明」仅 3 切片问题）。按实体坐标
 * 重建「行 → 段落」结构：
 * 1. 按 y 降序、x 升序排序；y 差在行容差内的实体归同一行，行内按 x 拼接（大间距加空格）；
 * 2. 相邻行 y 间距超过段落阈值（2.5× 行距中位数）视为段落断裂；
 * 3. 无坐标实体（ATTRIB 等）保持原有顺序独立输出。
 * 容差自适应：以相邻实体 y 差中位数为基准，图纸单位未知（mm/m）时仍稳健。
 */
export function layoutCadAnnotations(annotations: CadAnnotation[]): string[] {
  const positioned = annotations.filter(item => item.x !== undefined && item.y !== undefined);
  const unpositioned = annotations.filter(item => item.x === undefined || item.y === undefined);
  if (positioned.length === 0) return annotations.map(item => item.text);

  const sorted = [...positioned].sort((a, b) => (b.y! - a.y!) || (a.x! - b.x!));
  // 行距估计：相邻实体 y 差的非零中位数（同行实体 y 差≈0 不计入）
  const yGaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = Math.abs(sorted[i - 1]!.y! - sorted[i]!.y!);
    if (gap > 0) yGaps.push(gap);
  }
  yGaps.sort((a, b) => a - b);
  const medianGap = yGaps.length > 0 ? yGaps[Math.floor(yGaps.length / 2)]! : 0;
  const rowTolerance = Math.max(medianGap > 0 ? medianGap * 0.3 : 0, 0.01);
  const paragraphGap = Math.max(medianGap * 2.5, 0.05);
  const wordGap = Math.max(medianGap * 0.5, 1);

  // 行聚类：y 差在容差内的实体归同一行
  const rows: CadAnnotation[][] = [];
  for (const item of sorted) {
    const last = rows[rows.length - 1];
    const lastItem = last?.[last.length - 1];
    if (last && lastItem && Math.abs(lastItem.y! - item.y!) <= rowTolerance) last.push(item);
    else rows.push([item]);
  }

  // 行内按 x 排序 + 大间距加空格拼接
  const joinRow = (row: CadAnnotation[]): string => {
    const byX = [...row].sort((a, b) => a.x! - b.x!);
    let output = '';
    let prevX: number | undefined;
    for (const item of byX) {
      if (prevX !== undefined && item.x! - prevX > wordGap) output += ' ';
      output += item.text;
      prevX = item.x!;
    }
    return output.trim();
  };

  // 段落：行距紧凑的连续行合并为一段（多行说明文字重建为段落）
  const paragraphs: string[] = [];
  let current: string[] = [];
  let lastRowY: number | undefined;
  for (const row of rows) {
    const line = joinRow(row);
    if (!line) continue;
    const rowY = row[0]!.y!;
    if (lastRowY !== undefined && lastRowY - rowY > paragraphGap) {
      paragraphs.push(current.join('\n'));
      current = [];
    }
    current.push(line);
    lastRowY = rowY;
  }
  if (current.length > 0) paragraphs.push(current.join('\n'));

  // 注意：paragraphs 的每个元素是**多行字符串**（段落内已 join('\n')），故须逐段内按行合并，
  // 只对顶层数组做合并会漏掉段落内部的碎片（这正是本修复第一版的缺陷）。
  return [
    ...paragraphs.map(paragraph => mergeSingleCharRuns(paragraph.split('\n')).join('\n')),
    ...mergeSingleCharRuns(unpositioned.map(item => item.text)),
  ];
}

/**
 * 连续单字符行合并（G 线 P2-11）。
 *
 * **实测依据**（巢湖终态库 1730 个 cad chunk / 49,426 行）：单字符行 3,978 = 8.0%，
 * 其中「连续 ≥3 的整串」1,894 行（3.8%），是**被逐字符拆成独立实体**的真实文本 ——
 * `NINGBO` 拆成 `N|I|N|G|B|O`、`有限公司` 拆成 `有|限|公|司`；这些实体因 y 坐标略有差异
 * 未能落进同一行聚类，于是每个字各占一行。
 *
 * **为什么是合并而不是删除**：本仓刚走完「解析丢数据」专项，检索语料里一律不做删除式治理
 * ——`NINGBO` 合并回一个词后至少可被检索到，删掉就永久失去。至于剩余 4.2% 的**孤立**单字符行
 * （以孤立大写字母 `A` 为主，实测上下文是电气图例表的列值/解析残渣），删除它们虽能进一步降噪，
 * 但属删除式治理且有丢真数据风险，**本函数不处理**，留待产品侧决定。
 *
 * 阈值取 3：两字以内的小串可能是合法的短标注（如 `1`、`2` 这类行号/编号），
 * 三字及以上才基本可判定为被拆碎的词。
 */
function mergeSingleCharRuns(lines: string[]): string[] {
  const output: string[] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 3) output.push(run.join(''));
    else output.push(...run);
    run = [];
  };
  for (const line of lines) {
    if ([...line].length === 1) {
      run.push(line);
      continue;
    }
    flush();
    output.push(line);
  }
  flush();
  return output;
}

/** 单条标注类 DXF 实体的成对解析结果：(组码, 值) 按文档顺序保留 */
export interface DxfEntityPairs {
  type: string;
  pairs: Array<[string, string]>;
}

/** 标注类实体：TEXT/MTEXT 是图纸文字主体，DIMENSION/LEADER 携带尺寸与引线文字，ATTRIB 是块属性（门窗表/材料表） */
const DXF_TEXT_ENTITY_RE = /^(?:TEXT|MTEXT|DIMENSION|LEADER|ATTRIB)/u;

/**
 * 按 (组码, 值) 成对推进解析 DXF，只保留标注类实体。
 *
 * 为什么不能沿用正则切分实体：`raw.split(/(?:^|\r?\n)\s*0\s*\r?\n/u)` 无法区分「组码 0 行」
 * 与「值为 0 的组码值行」——` 72` 组码后面跟一行 `     0`（水平对齐参数，DXF 中极常见）
 * 同样命中该正则，实体被从中间劈开；后半段以子类标记 `100` 开头，通不过
 * `^(?:TEXT|MTEXT|DIMENSION|LEADER|ATTRIB)` 过滤而被整条丢弃。实测因此丢失
 * 2#3#门卫结构图 4,241 个中文字、1#厂房结构基础 10,905 个中文字（两份图纸入库均仅剩 30 余字）。
 *
 * DXF 只有严格「两行一组」才是 (组码, 值)，任何逐行扫描的匹配都可能把值当成组码，
 * 因此这里必须按索引成对推进，并把配对结果交给调用方复用于图层/块名/坐标等组码查询。
 */
export function parseDxfTextEntities(raw: string): DxfEntityPairs[] {
  const lines = String(raw ?? '').split(/\r?\n/u);
  const entities: DxfEntityPairs[] = [];
  let current: DxfEntityPairs | undefined;
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = lines[index]!.trim();
    const value = lines[index + 1] ?? '';
    if (code === '0') {
      const type = value.trim().split(/\s+/u)[0] ?? '';
      current = DXF_TEXT_ENTITY_RE.test(type) ? { type, pairs: [] } : undefined;
      if (current) entities.push(current);
      continue;
    }
    // 非标注实体不收集组码，避免为整份图纸（可达 15 万个实体）无谓分配
    if (current) current.pairs.push([code, value]);
  }
  return entities;
}

const CAD_INTERNAL_TOKEN_RE = /\b(?:TDbPipe|TDbPipeValve|TDbPipeFitting|TDbWellh|AcDb[\w:]+|Dwg\w+|ObjectId|Handle|ByLayer|Continuous|Model|Layout\d*|MLEADERSTYLE|AppInfoHistory|AppInfoDataList|ObjectDBX|Classes|DICTIONARYVARP|ObjFreeSpaceP|AuxHeaderT|\$AUDIT_BAD_\w+)\b/giu;
// 注意：不再整行排除纯数字（\d+）——真实图纸的尺寸标注/标高/门窗表数值常为纯数字行
// （如「100」「2.900」），整行排除会误杀图纸数据；图层/块名等内部纯数字标识在提取处
// 单独排除（extractDxf 的 layers/blocks 过滤），不受此正则影响
const CAD_INTERNAL_LINE_RE = /^(?:TDb\w+|AcDb[\w:]+|\$AUDIT_BAD_\w+|[A-F0-9]{8,}|Model|Layout\d*|ByLayer|Continuous|MLEADERSTYLE|ObjectDBX)$/iu;
/** DWG 二进制误读产生的 C1 控制字符（U+0080-U+009F，如 GBK 半字节），正常图纸标注不会出现 */
const CAD_C1_CONTROL_RE = /[\u0080-\u009F]/gu;
/** AutoCAD 控制码：%%c=Φ、%%d=°、%%p=±、%%132 等数字码=Φ，统一解码为可读符号 */
const CAD_CONTROL_CODE_RE = /%%(?:c|d|p|\d{2,3})/giu;
/**
 * AutoCAD MTEXT 行内格式码（G 线 P2-7）：统一形态为「反斜杠 + 码字母 + 参数 + 分号」——
 * `\A1;` 对齐 / `\pxqc;` 段落 / `\H2.5x;` 字高 / `\W1.2;` 宽度因子 / `\C256;` 颜色 /
 * `\fSimSun|b0|i0|c134|p2;` 字体组（通常裹在 `{}` 内）。
 *
 * 实测（巢湖 21 张图纸终态库）1730 个 cad chunk 中 738 个残留此类转义码，样本形如
 * `{\fSimSun|b0|i0|c134|p2;建设单位}`。危害是双重的：既污染检索词面（「建设单位」被拼成
 * `{\fSimSun|b0…;建设单位}`，关键词命中率下降），又会被 `isLikelyGarbledCadText` 的
 * 「符号占比 > 0.35」规则判为乱码而**整行丢弃**——真标注被吞，用户看到的是图纸内容缺失。
 *
 * 码字母限定为 MTEXT 规范定义集（A/C/F/H/Q/S/T/W/p），比宽泛的 `[A-Za-z]` 安全得多：
 * 后者会把 `\path\to;` 这类反斜杠路径段整段吃掉。**残留风险已知**：形如 `C:\temp\a;`
 * 的路径仍可能被 `\a;` 段命中——但图纸语料里反斜杠路径与「反斜杠+单字母+分号」共现
 * 极罕见，而格式码残留是实测 738/1730 的普遍问题，取舍明确。
 */
const CAD_MTEXT_CODE_RE = /\\(?:[ACFHQSTW]|p)[^;\\{}]*;/giu;
/** MTEXT 段落分隔符 \P（等价换行）：**必须在行切分之前**消费，否则段落边界被抹成空格粘连 */
const CAD_MTEXT_PARAGRAPH_RE = /\\P/gu;
/** MTEXT 无参开关码：\L 下划线开/关、\O 上划线开/关、\K 倾斜开/关、\~ 不换行空格 */
const CAD_MTEXT_TOGGLE_RE = /\\[LlOoKk~]/gu;
/** MTEXT 分组花括号：格式组剥离后残留的外壳（成对出现，直接去壳即可） */
const CAD_MTEXT_BRACE_RE = /[{}]/gu;
const CAD_DOMAIN_SIGNAL_RE = /工程|项目|施工|建筑|结构|装饰|电气|给排水|消防|暖通|平面|立面|剖面|节点|详图|材料|尺寸|标高|轴线|图层|门窗|墙|地面|顶面|照明|配电|弱电|空调|卫生间|楼梯|屋面|基础|柱|梁|板|图号|设计|说明|轴|电|井|土|夯/u;
/** 图纸兜底解析可读字符（汉字/字母/数字）的最低总量，低于该值视为无字符数据，不入库 */
/**
 * DXF 标注实体提取上限（G 线 P0-8）。超出即**显式记账 + 告警**，不再静默截断。
 * 历史值 5000 从未带截断标记，而 contentCoverage 仍报正常覆盖 —— 实测 21 个 CAD 文件中
 * 7 个恰好等于 5000（确定性截断），用户看不到内容被砍。
 * 取值依据：全语料 22 个 DWG 实测最大实体数 21,452，30,000 留出余量使当前语料零截断；
 * 上限本身保留（防超大图纸撑爆内存），触顶时按下方逻辑记账并告警。
 */
const CAD_TEXT_ENTITY_LIMIT = 30_000;

/**
 * 图纸「有字符数据」的绝对下限。**注意：绝对字符数不是「图纸解析是否有效」的判据** ——
 * 实测的残破图纸形态是「648 字符 / 1 个切片 / 源文件 9.4MB」，远高于任何合理绝对门槛。
 * 识别有效解析需要**产出比**（入库字符 / 源文件字节），属记账与产出比门禁范畴（见 U 线），
 * 此处不引入无效阈值以免制造「看起来有门禁其实拦不住」的假保护。
 */
const MIN_CAD_CHARACTER_DATA = 32;
const OCR_NATIVE_NOISE_PATTERNS = [/^Image too small to scale!!/u, /^Line cannot be recognized!!$/u];
/** 渲染目录里的页面几何 sidecar（pt/mm），用于大幅面切片判定 */
const PAGE_GEOMETRY_FILE = 'pages.json';

// ─── 大幅面切片参数（固定值，不提供环境变量开关）─────────────────────
// 图纸解析的目标是数据精准与不丢失：任何「调低召回/关掉切片换速度」的开关，
// 都可能让图纸标注静默变少且无人察觉，因此这些参数不作为可配置项暴露。
/** 切片边长。必须 ≤ 检测输入上限，块内才不会发生任何缩放（等价于原生分辨率检测） */
const TILE_PX = 900;
/** 切片重叠。应大于图纸上最高的一行文字，避免文字被切缝截断成两半 */
const TILE_OVERLAP_PX = 120;
/** 单页切片数上限，超出时放大切片降低分辨率（宁可略降分辨率也不跳过切片） */
const TILE_MAX_PER_PAGE = 64;
/** 触发切片的页面长边物理尺寸：400mm 即 A3 及以上 */
const TILE_TRIGGER_MM = 400;
/** 切片页的检测框最小面积（检测坐标系像素²），默认 20 会漏掉小号尺寸标注 */
const TILE_RECALL_MIN_AREA = 8;
/** 切片页的检测框置信度阈值，默认 0.6 会漏掉浅淡的单线矢量字 */
const TILE_RECALL_BOX_SCORE = 0.4;
/** 切片页的识别行置信度阈值，默认 0.5；与上面两项必须同时放宽才有效 */
const TILE_RECALL_REC_SCORE = 0.35;


/**
 * 页级 OCR 缓存键（W7 断点续跑，导出供单测）：文件身份（路径+大小+mtime，与变更检测同源）
 * + 页号 + 渲染 DPI + **解析参数版本**。参数版本变化（切片边长/召回阈值调整）即整体失效——
 * 宁可重跑，不可复用旧口径的结果。文件被修改（size/mtime 变化）同样失效。
 */
export function ocrPageCacheKeyOf(input: { absolutePath: string; fileSize: number; mtime: number; pageIndex: number; dpi: number }): string {
  const identity = `${input.absolutePath}|${input.fileSize}|${input.mtime}|${input.dpi}|${input.pageIndex}`
    + `|v1:${TILE_PX}:${TILE_OVERLAP_PX}:${TILE_RECALL_BOX_SCORE}:${TILE_RECALL_REC_SCORE}:${TILE_RECALL_MIN_AREA}`;
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

/**
 * 大幅面图纸页的「文本层稀疏」上限（可见字符数）。
 *
 * 用途：识别「文本层只有图签栏、正文在矢量图形里」的图纸页。CAD 导出 PDF 的图签栏
 * （项目名/设计院/签名栏/著作权声明）约 200~350 可见字符，而真实文字页数百到数千。
 *
 * 为什么单靠页均密度不够：`hasUsablePdfText` 的页均密度保护只对 `pageCount > 1` 生效，
 * 而**单张出图**（一张 A2/A3 一个文件）是最常见的图纸形态 —— 实测舒城 14/14 图纸 PDF
 * 全是单页，全部绕过保护，判「文本层足够」后 OCR 永不启动，入库只有图签栏。
 * 实测同一份 A2 图纸：文本层 345 字符 → 强制 OCR 后 1,452 字符（4.2×），
 * 且拿到的是真内容（划线规格、石材做法、材料编号、房间名、标高）而非图签栏。
 */
const SHEET_PAGE_MAX_VISIBLE_CHARS = 500;

/**
 * RTF `\ansicpg<nnn>` 代码页 → TextDecoder 编码标签。
 * 只列本领域实际会遇到的代码页；未收录者回落到通用编码探测（UTF-8 → GBK）。
 * 中文环境以 936（GBK）为主，繁体 950（Big5）、日文 932、韩文 949 一并覆盖，
 * 避免「换一个语种就整类丢正文」。
 */
const RTF_CODE_PAGE_ENCODING: Record<number, string> = {
  936: 'gbk',
  950: 'big5',
  932: 'shift_jis',
  949: 'euc-kr',
  1252: 'windows-1252',
  65001: 'utf-8',
};

/**
 * 按标签深度配平提取 OOXML 中 `w:p` / `w:tbl` 的**完整**元素。
 *
 * 为什么不能用非贪婪正则 `<(w:p|w:tbl)[\s>][\s\S]*?<\/\1>`：段落内若嵌有文本框
 * （`w:txbxContent` 里是一个完整的内层 `w:p`），匹配会在**内层** `</w:p>` 处收尾 ——
 * 外层段落被截断，且 `matchAll` 的扫描指针跳过其后半段，**该段后半的正文永久丢失**；
 * 文本框内的文字本身也不会被单独提取。实测形态：
 * `<w:p>前文甲…<w:txbxContent><w:p>框内乙</w:p></w:txbxContent>…后文丙</w:p>`
 * 旧实现只得到「前文甲框内乙」，「后文丙」消失且无任何告警。
 *
 * 深度配平后外层元素完整取出，其内部 `w:t` 按文档顺序自然拼出「前文甲框内乙后文丙」。
 */
export function extractTopLevelOoxmlElements(xml: string, tags: readonly string[] = ['w:p', 'w:tbl']): Array<{ tag: string; xml: string }> {
  const result: Array<{ tag: string; xml: string }> = [];
  const opener = new RegExp(`<(${tags.join('|')})(?:\\s[^>]*)?/?>`, 'gu');
  let cursor = 0;
  while (cursor < xml.length) {
    opener.lastIndex = cursor;
    const open = opener.exec(xml);
    if (!open) break;
    const tag = open[1]!;
    const start = open.index;
    // 自闭合元素自身即完整元素
    if (open[0].endsWith('/>')) {
      result.push({ tag, xml: open[0] });
      cursor = opener.lastIndex;
      continue;
    }
    // 从该标签起做同名标签的深度配平
    const scanner = new RegExp(`<${tag}(?:\\s[^>]*)?/?>|</${tag}>`, 'gu');
    scanner.lastIndex = opener.lastIndex;
    let depth = 1;
    let end = -1;
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(xml))) {
      if (match[0].startsWith('</')) {
        depth -= 1;
        if (depth === 0) { end = scanner.lastIndex; break; }
      } else if (!match[0].endsWith('/>')) {
        depth += 1;
      }
    }
    if (end < 0) break;   // 标签未闭合：文档损坏，停止提取
    result.push({ tag, xml: xml.slice(start, end) });
    cursor = end;
  }
  return result;
}

/** KV 声明行（R#C# 列名: 值）的值折叠：单元格内换行折叠为单空格（Excel Alt+Enter 换行
 *  会把「R3C5 项目特征描述: 第一段\n第二段」拆成两行，行级 KV 结构破坏、
 *  向量检索无法按行召回完整参数）。与 markdown 表格 escape 的换行处理一致。 */
const foldKvCellText = (value: unknown): string => String(value ?? '').replace(/\s*\n\s*/gu, ' ');

/**
 * PDF 折行半句检测（行级 markdown 化护栏）：排版折行把正文句断成「半句（无句末标点）+ 续行」，
 * 行级标题化规则（字号/首行/长度 + 无句末标点）会把半句误标为 # 标题行：① chunk 被误判小节边界；
 * ② 下游招标要求切分器把假标题当章节上下文（该行内容静默丢失）而其裸续行成孤立碎片——
 * 丰乐镇门禁 45 项挂起根因链的第一张骨牌。命中即不标题化（保持正文行，下游跨行拼接兜住语义）。
 */
export function isPdfWrappedClauseLike(text: string): boolean {
  if (/[。！？.!?]$/u.test(text)) return true; // 以句末标点整句收尾（标题不会如此）
  if (/[。！？!?]/u.test(text.slice(0, -1))) return true; // 中段含句末标点 = 段落中段
  if (/[，、；：,;:—…～]$/u.test(text)) return true; // 行尾句内标点 = 句子被折行裁断
  if (/^(?:目录|附录|附件)/u.test(text)) return false; // 目录/附录/附件题（结构标题，保持标题化）
  if (/[，、,]/u.test(text) && text.length >= 16) return true; // 长行含逗号/顿号 = 连句
  if (/[（）()]/u.test(text) && text.length >= 16) return true; // 长行含括号 = 括注句
  if (/[：:]/u.test(text) && text.length >= 24) return true; // 长名值行
  return text.length >= 28; // 超长行不像标题
}

/** 文件内容提取器，支持文档、表格、图片、CAD 等多种文件格式的内容抽取 */
export class ContentExtractor {
  async extract(file: ClassifiedFile): Promise<ExtractionResult> {
    const start = Date.now();
    const warnings: string[] = [];
    let text: string;
    const metadata: Record<string, unknown> = {
      mimeType: file.mimeType,
      category: file.category,
      format: file.format,
    };

    if (file.category === 'cad') {
      const result = await this.extractCad(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'data') {
      const result = this.extractData(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'diagram') {
      const result = this.extractDiagram(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'document' && file.format === 'pdf') {
      const result = await this.extractPdf(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'document' && ['office', 'presentation'].includes(file.format)) {
      const result = await this.extractOfficeDocument(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'spreadsheet' && ['csv', 'tsv'].includes(file.format)) {
      const result = this.extractDelimitedText(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'spreadsheet') {
      const result = await this.extractSpreadsheet(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);

    } else if (file.category === 'image' && file.format !== 'vector') {
      const result = await this.extractRasterImage(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.category === 'image' && file.format === 'vector') {
      const result = this.extractSvg(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (file.format === 'text_clipping') {
      const result = this.extractTextClipping(file);
      text = result.text;
      Object.assign(metadata, result.metadata);
      warnings.push(...result.warnings);
    } else if (this.isTextReadable(file)) {
      const decoded = decodeTextBuffer(fs.readFileSync(file.absolutePath));
      text = decoded.text;
      metadata.extractionMode = 'plain_text';
      metadata.encoding = decoded.encoding;
      metadata.vectorizable = true;

    } else {
      text = this.metadataOnlyText(file);
      metadata.extractionMode = 'metadata_only';
      metadata.vectorizable = true;
      metadata.contentCoverage = 'metadata';
      warnings.push(`暂不支持 ${file.category}/${file.format} 内容提取，未解析出正文，未入库`);
    }

    return {
      text: this.cleanExtractedText(text, file).trim(),
      metadata,
      warnings,
      extractionTimeMs: Date.now() - start,
    };
  }


  private extractTextClipping(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const buffer = fs.readFileSync(file.absolutePath);
    const candidates = [
      buffer.toString('utf16le'),
      this.swapUtf16Bytes(buffer).toString('utf16le'),
      buffer.toString('utf8'),
      ...this.extractBinaryStrings(file.absolutePath),
    ];
    const fragments = candidates.flatMap(candidate => this.extractReadableFragments(candidate));
    const unique = Array.from(new Set(fragments))
      .filter(fragment => fragment.length >= 2 && !/^bplist\d+/u.test(fragment))
      .sort((a, b) => this.textScore(b) - this.textScore(a))
      .slice(0, 50);
    const text = unique.join('\n');
    return {
      text: text ?? this.metadataOnlyText(file),
      metadata: {
        extractionMode: 'builtin_text_clipping',
        vectorizable: true,
        contentCoverage: text ? 'text_clipping_payload' : 'metadata',
        fragmentCount: unique.length,
      },
      warnings: text ? [] : ['未从 textClipping 中提取到剪贴文本，仅入库元数据'],
    };
  }

  private swapUtf16Bytes(buffer: Buffer): Buffer {
    const swapped = Buffer.from(buffer);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const first = swapped[i] ?? 0;
      swapped[i] = swapped[i + 1] ?? 0;
      swapped[i + 1] = first;
    }
    return swapped;
  }

  private extractReadableFragments(value: string): string[] {
    return value
      // G 线 P2-7：MTEXT 段落符先于行切分转真换行，保住段落边界（否则被拆成空格粘连成一行）
      .replace(CAD_MTEXT_PARAGRAPH_RE, '\n')
      .replace(/[^\p{L}\p{N}\p{P}\p{S}\s]/gu, '\n')
      .split(/[\r\n]+/u)
      .map(line => this.cleanCadReadableText(line))
      .filter(line => line.length >= 2 && /[\p{L}\p{N}]/u.test(line));
  }

  private cleanCadReadableText(value: string): string {
    return value
      .replace(CAD_C1_CONTROL_RE, ' ')
      // G 线 P2-7：先剥 MTEXT 带参格式码，再剥无参开关码与分组花括号
      //（带参码要求以 `;` 收尾，故 `\L` 这类无参码不会被它误吃，两步无顺序耦合；
      //  段落符 \P 已由调用方在行切分前消费，此处不再处理）
      .replace(CAD_MTEXT_CODE_RE, '')
      .replace(CAD_MTEXT_TOGGLE_RE, '')
      .replace(CAD_MTEXT_BRACE_RE, '')
      .replace(CAD_CONTROL_CODE_RE, code => (code.toLowerCase() === '%%d' ? '°' : code.toLowerCase() === '%%p' ? '±' : 'Φ'))
      .replace(CAD_INTERNAL_TOKEN_RE, '')
      .replace(/\b(?:LINE|LWPOLYLINE|POLYLINE|INSERT|HATCH|CIRCLE|ARC|DIMENSION|TEXT|MTEXT)\b/giu, '')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  private isLikelyGarbledCadText(value: string): boolean {
    const compact = value.replace(/\s+/gu, '');
    if (!compact) return true;
    const chars = [...compact];
    const readable = chars.filter(char => /[\p{Script=Han}\p{Script=Latin}\d（）()【】《》、，。；;：:,.\-/㎡%]/u.test(char)).length;
    const cjk = chars.filter(char => /[\p{Script=Han}]/u.test(char)).length;
    const latin = chars.filter(char => /[\p{Script=Latin}]/u.test(char)).length;
    const digits = chars.filter(char => /\d/u.test(char)).length;
    const symbols = chars.length - readable;
    const readableRatio = readable / chars.length;
    const symbolRatio = symbols / chars.length;
    const hasDomainSignal = CAD_DOMAIN_SIGNAL_RE.test(compact);
    const latinVowelCount = chars.filter(char => /[aAeEiIoOuU]/u.test(char)).length;
    // 替换符（U+FFFD）：解码失败的标志，正常标注不会出现
    if (chars.includes('\uFFFD')) return true;
    // 罕见符号（箭头补充、CJK 部首、杂项数学/圈符/地图符号）：二进制误读产物，
    // 正常图纸标注只用常用标点与工程符号
    if (/[\u2046-\u205F\u2070-\u209F\u2100-\u2102\u2104-\u214F\u21B0-\u21FF\u2270-\u22FF\u2400-\u243F\u249C-\u24FF\u2640-\u26FF\u27C0-\u27EF\u2900-\u297F\u2A00-\u2AFF\u2B00-\u2BFF\u2E00-\u2FFF\u3200-\u33FF]/u.test(compact)) return true;
    if (readableRatio < 0.6) return true;
    if (symbolRatio > 0.35 && !hasDomainSignal) return true;
    if (latin >= 12 && latinVowelCount === 0 && !hasDomainSignal) return true;
    // 已移除「cjk >= 8 && digits === 0 && !hasDomainSignal && !hasCommonTextShape → 乱码」规则：
    // 它把「无数字、无句读、不含工程关键词」的整句中文一律判为二进制误读，但图纸里这类
    // 纯汉字短句极为常见（「双门热风循环消毒柜」「檐口支撑收边固定用自攻螺钉」
    // 「防火吊顶耐火极限不小于」「一层防火分区示意图」「本图未盖出图章无效」）。
    // 巢湖 21 张图纸实测：该规则命中 888 处（去重 201 条），逐条人工核对**全部是正常中文标注、
    // 无一条真乱码**，而其中 841 处属于「只被它拦下」——即纯粹的误杀。其余规则（符号占比、
    // Latin-1 扩展字符密度、短片段周期重复、汉字高频重复等）实测仍独立拦下 3,019 处真噪声，
    // 移除本规则不削弱对真乱码的防护（同批语料误杀从 873 处降至 32 处）。
    // 短行内汉字-Latin-汉字交叉混排（考堂f肀、渱潑喲W晀耀）：二进制误读的典型形态；
    // 正常标注的字母编号在汉字前或后（JD 电井、AB轴），不会夹在汉字中间
    if (chars.length <= 8 && cjk >= 2 && latin >= 1 && digits === 0 && !hasDomainSignal && /[\p{Script=Han}][\p{Script=Latin}][\p{Script=Han}]/u.test(compact)) return true;
    // 纯 Latin 行含 Latin-1 扩展字符（VdA«UdA«UdANÒg、dAç dA+ dA«）：正常英文标注不用扩展字符
    if (cjk === 0 && digits === 0 && latin >= 8 && /[\u00A0-\u02AF\u1E00-\u1EFF]/u.test(compact)) return true;
    // 超长无句读行：二进制误读产生的长连续乱码（常混入个别汉字/数字触发域信号豁免，
    // 因此只认中文句读，数字/单位不再豁免）
    if (chars.length > 400 && !/[\u3002\uFF0C\uFF1B\uFF1A\u3001、，。；：]/.test(compact)) return true;
    // 行内短片段周期性重复（Ml+Ml+Ml、AM~AM~BM~BM、2dA+2dA+2dA）：二进制误读产生的循环模式。
    // 收窄为两个必要条件，否则会大量误杀真实图纸数据：
    // ① 仅限**无汉字**行——真循环模式是 Latin/符号串；含汉字行里的条款编号（4.4.2、12.2.2、2.3.3）
    //    会让重复的数字在「短片段自身长度」这个极小分母上触发判据（实测 8 条正常中文条款被误杀）。
    // ② 重复片段不能是**纯数字**——800*800*800、1000*1000*800/450、700*800*800/450 这类尺寸标注
    //    本就是循环数字，是图纸真实数据；二进制误读吐的是高熵混合串，不会只产生纯数字循环。
    const shortTokens = compact.split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 1 && token.length <= 4);
    if (shortTokens.length >= 3 && chars.length >= 8 && !hasDomainSignal && cjk === 0) {
      const tokenFreq = new Map<string, number>();
      for (const token of shortTokens) tokenFreq.set(token, (tokenFreq.get(token) ?? 0) + 1);
      const repeatedTokens = [...tokenFreq].filter(([, count]) => count >= 2);
      const repeatedChars = repeatedTokens.reduce((sum, [token, count]) => sum + token.length * count, 0);
      const onlyNumericRepeats = repeatedTokens.length > 0 && repeatedTokens.every(([token]) => /^\d+$/u.test(token));
      if (!onlyNumericRepeats && repeatedChars / Math.max(1, shortTokens.join('').length) >= 0.4) return true;
    }
    // 短行内字符表塌缩（摁䭚摁譚摁譚摁：7 字只有 3 个不同字）：二进制误读的循环产物。
    // 判据是「不同字符数 / 行长度」而非「重复汉字占比」——中文自然重复用字很多
    // （「电动伸缩门或电动移门」8/9、「阀门(带阀门井)」6/8、「规定性指标性能性指标」7/10），
    // 但字符表不会塌缩到六成以下；旧判据用重复占比，把上述正常标注全部误杀（实测 22 处
    // 去重 11 条全部是正常中文）。此行与上面的「汉字-Latin-汉字交叉混排」互补：
    // 后者管交叉混排，前者管同表循环，故不能依赖后者兜底（摁䭚摁譚摁譚摁 无 Latin，
    // 且生僻字占比 1/7 低于「CJK 扩展区生僻字」的 0.2 门槛）。
    const distinctCharRatio = new Set(chars).size / chars.length;
    // 数字占比高的行豁免：800*800*800、1000*1000*800/450 的字符表同样「塌缩」，
    // 但那是重复的尺寸数字，属图纸真实数据而非二进制误读
    const digitShare = digits / chars.length;
    if (cjk >= 1 && chars.length >= 6 && chars.length <= 14 && digitShare < 0.3 && distinctCharRatio < 0.6) return true;
    // Latin-1 扩展字符（¡-ÿ 区）密集行：中文图纸标注几乎不用这些字符，
    // 二进制误读（GBK/CP1252 混读）会批量产生
    const latinExtended = chars.filter(char => /[\u00A0-\u02AF\u1E00-\u1EFF]/u.test(char)).length;
    if (latinExtended >= 3 && (latinExtended / chars.length >= 0.3 || latin / Math.max(1, chars.length) >= 0.6)) return true;
    // 纯 Latin-1 扩展字母短行（无 ASCII 字母/数字）：GBK 中文标注被 Latin-1 误读的
    // 典型产物（"上"→ÉÏ、"柜"→¹ñ），正常标注的英文是 ASCII、中文是汉字，
    // 不会出现整行全由扩展拉丁字母构成的短行
    if (cjk === 0 && digits === 0 && latin >= 2 && latinExtended === latin && chars.length <= 12) return true;
    // GBK 误读标点/字母混入 ASCII 标注（"1APz:P4~P6"→1APz£ºP4~P6、"消防控制"→Ïû·À¿ØÖÆ）：
    // 正常工程标注只使用 °±×÷·µ²³Ø 等少数 Latin-1 字符，
    // 无汉字行中出现 2 个以上其他 Latin-1 字符即判定为 GBK 编码误读
    const gbkMisreadChars = chars.filter(char => /[\u00A0-\u00FF]/u.test(char) && !'°±×÷·µ²³Ø'.includes(char)).length;
    if (gbkMisreadChars >= 2 && cjk === 0) return true;
    // 分数符号/上标数字（¼½¾¹）：中文工程图纸标注几乎不用（仅 ²³ 常见保留），
    // 出现在标注中基本是 GBK 误读（门宽 FM×1524 误读为 FM¼×1524）
    if (/[¹¼½¾]/u.test(compact) && cjk === 0) return true;
    // 无空格的超长 Latin 字母串（≥16 字符）：正常标注是词/编号，不会出现连续长字母串
    if (/[\p{Script=Latin}\u00C0-\u024F]{16,}/u.test(compact)) return true;
    // GUID：DWG 内部结构标识，不是图纸字符数据
    if (/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/u.test(compact)) return true;
    // 单汉字高频重复：正常标注/文本不会让同一汉字占比超过 20%（如乱码行中
    // 生僻字“罍”重复 400+ 次仍被 readableRatio 计为可读字符而漏网）
    const charCounts = new Map<string, number>();
    for (const char of chars) charCounts.set(char, (charCounts.get(char) ?? 0) + 1);
    let mostCommon = '';
    let mostCommonCount = 0;
    for (const [char, count] of charCounts) {
      if (count > mostCommonCount) {
        mostCommon = char;
        mostCommonCount = count;
      }
    }
    if (mostCommonCount >= 5 && mostCommonCount / chars.length > 0.2 && /[\p{Script=Han}]/u.test(mostCommon)) return true;
    // CJK 扩展区生僻字（Ext A/B 等）混排：正常图纸标注几乎只用常用字（基本区
    // U+4E00-U+9FFF），二进制误读会批量产生 U+3400-U+4DBF 等扩展区字符
    const rareCjk = chars.filter(char => /[\u3400-\u4DBF\u{20000}-\u{2FA1F}]/u.test(char)).length;
    if (rareCjk >= 2 && rareCjk / chars.length >= 0.1) return true;
    if (rareCjk >= 1 && rareCjk / chars.length >= 0.2) return true;
    // 非中/英/希字母脚本混排（韩文、藏文、彝文、泰文等）：中文标注行内混入
    // 其他文字系统字母是二进制误读的典型产物（希腊字母 ΦφΩ 在图纸中常见，豁免）
    const foreignLetter = chars.filter(char => /\p{Letter}/u.test(char) && !/[\p{Script=Han}\p{Script=Latin}\p{Script=Greek}]/u.test(char)).length;
    if (foreignLetter >= 1 && cjk > 0) return true;
    return false;
  }

  private isReadableCadValue(value: string): boolean {
    const cleaned = this.cleanCadReadableText(value);
    return cleaned.length >= 2 && !CAD_INTERNAL_LINE_RE.test(cleaned) && /[\p{Script=Han}\p{Letter}\d]/u.test(cleaned) && !this.isLikelyGarbledCadText(cleaned);
  }

  /** 图层/块名可读性：在通用可读性过滤外，排除纯数字名称（默认图层「0」等 CAD 内部标识） */
  private isUsableCadName(value: string): boolean {
    return this.isReadableCadValue(value) && !/^-?\d+(?:\.\d+)?$/u.test(value.trim());
  }

  private cleanExtractedText(value: string, file: ClassifiedFile): string {
    // 符号字体私用区字符（CAD SHX 直径符号、PDF Wingdings 选项框等）统一映射回标准符号
    const normalized = [...normalizeSymbolicPua(value)]
      .filter(char => {
        const code = char.charCodeAt(0);
        // U+FFFF 非字符：PDF 表单空白下划线/占位符的提取产物，无检索意义，统一剔除
        return code !== 0xFFFF && (code === 9 || code === 10 || code === 13 || code >= 32);
      })
      .join('');
    if (file.category !== 'cad') return normalized.replace(/\n{3,}/gu, '\n\n');
    return normalized
      // G 线 P2-7：同上，MTEXT 段落符先转真换行再逐行清洗
      .replace(CAD_MTEXT_PARAGRAPH_RE, '\n')
      .split(/\r?\n/u)
      .map(line => this.cleanCadReadableText(line))
      .filter(line => line && !CAD_INTERNAL_LINE_RE.test(line) && !this.isLikelyGarbledCadText(line))
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n');
  }

  private textScore(value: string): number {
    const cjk = (value.match(/[\p{Script=Han}]/gu) ?? []).length;
    const alnum = (value.match(/[\p{L}\p{N}]/gu) ?? []).length;
    return cjk * 4 + alnum + Math.min(value.length, 200) / 20;
  }

  /** 统计图纸提取片段中的实际字符数据量（汉字/字母/数字），用于判断"无字符数据不入库" */
  private countCadCharacterData(fragments: string[]): number {
    return (fragments.join('').match(/[\p{Script=Han}\p{L}\p{N}]/gu) ?? []).length;
  }

  private async extractCad(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'builtin_cad_structural', vectorizable: true, preferredExtractionMode: 'dwg_to_dxf_semantic' };
    const warnings: string[] = [];
    const ext = path.extname(file.absolutePath).toLowerCase();

    if (ext === '.dxf') return await this.extractDxf(file, decodeTextBuffer(fs.readFileSync(file.absolutePath)).text, metadata);
    if (ext === '.dwg') {
      const converted = await this.tryConvertDwgToDxf(file.absolutePath);
      if (converted?.dxfText) {
        const parsed = await this.extractDxf(file, converted.dxfText, { ...metadata, extractionMode: converted.tool, convertedFrom: 'dwg', professionalConversionUsed: true });
        // DXF 路径确实拿到字符数据才收工。转换器「成功」但输出无可读字符时（残缺/加密 DWG、
        // 转换器只吐结构不吐标注、代理对象图元），继续走下面的内置二进制兜底 —— 兜底路径带
        // GBK 还原，往往还能救回图纸标注。旧实现只要 dxfText 非空就 return，**兜底永不触发**：
        // 实测一份含 GBK 中文标注的 DWG 被判「无字符数据不入库」，而兜底本可完整还原出标注。
        if (parsed.metadata.contentCoverage !== 'cad_no_extractable_text') {
          parsed.warnings.push(...converted.warnings);
          return parsed;
        }
        warnings.push(...converted.warnings, 'DWG→DXF 转换成功但未提取到字符数据，继续尝试内置二进制兜底抽取');
      } else {
        warnings.push(...(converted?.warnings ?? ['未检测到可用 DWG→DXF 转换器，使用内置图纸可读文本抽取']));
      }
    }

    if (file.format === 'autocad' && ext === '.dxf') {
      const raw = decodeTextBuffer(fs.readFileSync(file.absolutePath)).text;
      const layers = this.matchAll(raw, /\n\s*8\s*\n([^\n]+)/gu).filter(value => this.isUsableCadName(value)).slice(0, 300);
      const textEntities = this.extractDxfTextAnnotations(raw).slice(0, 500);
      const blocks = this.matchAll(raw, /\n\s*2\s*\n([^\n]+)/gu).filter(value => this.isUsableCadName(value)).slice(0, 300);
      const entityTypes = this.matchAll(raw, /\n\s*0\s*\n([A-Z][A-Z0-9_]+)/gu).slice(0, 1000);
      const uniqueLayers = Array.from(new Set(layers));
      const uniqueBlocks = Array.from(new Set(blocks));
      const uniqueEntityTypes = Array.from(new Set(entityTypes));
      metadata.layerCount = uniqueLayers.length;
      metadata.layerNames = uniqueLayers.slice(0, 80);
      metadata.textEntityCount = textEntities.length;
      metadata.blockCount = uniqueBlocks.length;
      metadata.blockNames = uniqueBlocks.slice(0, 80);
      metadata.entityTypeCount = uniqueEntityTypes.length;
      metadata.entityTypes = uniqueEntityTypes.slice(0, 80);
      // 判空口径只统计标注文本：图层/块名是 CAD 内部结构信息，图纸「空数据」= 无文字标注。
      // 把图层/块名计入字符数会让空图纸（仅图层结构、无任何标注）错误入库
      const characterDataCount = this.countCadCharacterData(textEntities.map(annotation => annotation.text));
      if (characterDataCount < MIN_CAD_CHARACTER_DATA) {
        // 图纸无字符数据（无文字标注），不入库——空数据图纸直接过滤，仅元数据可查
        metadata.contentCoverage = 'cad_no_extractable_text';
        metadata.characterDataCount = characterDataCount;
        warnings.push(`${file.format} DXF 未提取到字符数据（仅 ${characterDataCount} 个可读字符），图纸内容未入库`);
        return { text: this.metadataOnlyText(file), metadata, warnings };
      }
      metadata.contentCoverage = 'dxf_semantic_layer_block_annotations';
      metadata.characterDataCount = characterDataCount;
      const semanticNodes = this.buildCadSemanticNodes(file, textEntities);
      return {
        text: [
          `CAD DXF 图层: ${uniqueLayers.join(', ')}`,
          `CAD DXF 块/符号: ${uniqueBlocks.join(', ')}`,
          `CAD DXF 实体类型: ${uniqueEntityTypes.join(', ')}`,
          'CAD 语义标注文本:',
          ...semanticNodes,
        ].join('\n'),
        metadata,
        warnings,
      };
    }

    if (file.format === 'step') {
      const raw = decodeTextBuffer(fs.readFileSync(file.absolutePath)).text;
      const products = this.matchAll(raw, /PRODUCT\s*\(\s*'([^']*)'\s*,\s*'([^']*)'/giu).slice(0, 300);
      const materials = this.matchAll(raw, /MATERIAL[^']*'([^']+)'/giu).slice(0, 120);
      const entities = this.matchAll(raw, /#\d+\s*=\s*([A-Z0-9_]+)/gu).slice(0, 1000);
      const names = this.matchAll(raw, /'([^']{2,120})'/gu).slice(0, 500);
      const uniqueStepEntities = Array.from(new Set(entities));
      metadata.productCount = products.length;
      metadata.productNames = products.slice(0, 80);
      metadata.materialCount = materials.length;
      metadata.materialNames = materials.slice(0, 80);
      metadata.entityTypeCount = uniqueStepEntities.length;
      metadata.entityTypes = uniqueStepEntities.slice(0, 80);
      metadata.contentCoverage = 'step_products_materials_entities_names';
      return {
        text: [
          `STEP 产品/零件:\n${products.join('\n')}`,
          `STEP 材料: ${materials.join(', ')}`,
          `STEP 实体类型: ${uniqueStepEntities.join(', ')}`,
          `STEP 名称/属性:\n${names.join('\n')}`,
        ].join('\n'),
        metadata,
        warnings,
      };
    }

    if (file.format === 'iges') {
      const raw = decodeTextBuffer(fs.readFileSync(file.absolutePath)).text;
      const names = this.matchAll(raw, /'([^']{2,120})'/gu).slice(0, 500);
      const entityTypes = this.matchAll(raw, /^\s*(\d{3,4})\s*,/gmu).slice(0, 1000);
      const uniqueIgesTypes = Array.from(new Set(entityTypes));
      metadata.entityNameCount = names.length;
      metadata.entityNames = names.slice(0, 80);
      metadata.entityTypeCount = uniqueIgesTypes.length;
      metadata.entityTypes = uniqueIgesTypes.slice(0, 80);
      metadata.contentCoverage = 'iges_entity_names_types';
      return {
        text: [`IGES 实体类型: ${uniqueIgesTypes.join(', ')}`, `IGES 实体/名称:\n${names.join('\n')}`].join('\n'),
        metadata,
        warnings,
      };
    }

    if (file.format === 'mesh') {
      const result = this.extractCadMesh(file, ext, metadata);
      if (result.text.trim()) return result;
    }

    const binaryFragments = this.extractBinaryReadableFragments(file.absolutePath);
    // OLE 属性集（<prop_set ...>）是 DWG 文件内部的二进制属性结构，不含图纸标注字符，
    // 属于解析噪声而非字符数据，直接排除（不锚定行首：误读字符可能混在片段开头）
    const withoutPropSets = binaryFragments.filter(value => !/<prop_set\b/u.test(value));
    let readable = withoutPropSets.filter(value => this.isUsableCadName(value)).slice(0, 5000);
    // 文档级字符词频过滤：真实标注文字在图纸中会重复出现（标题/图层/图名等），
    // 随机二进制噪声片段中每个字符几乎只出现一次（孤立字符）；短片段若全部由
    // 孤立字符构成即为随机噪声，丢弃
    const charFreq = new Map<string, number>();
    for (const value of readable) {
      for (const char of value) charFreq.set(char, (charFreq.get(char) ?? 0) + 1);
    }
    const isolatedNoise = (value: string): boolean => {
      if (CAD_DOMAIN_SIGNAL_RE.test(value)) return false;
      const letters = [...value].filter(char => /[\p{L}\p{N}]/u.test(char));
      if (letters.length > 8) return false;
      const freqs = letters.map(char => charFreq.get(char) ?? 1);
      // 短片段中 60% 以上字符在全文只出现一次 → 随机噪声（真实标注文字会重复出现）
      const isolatedCount = freqs.filter(freq => freq <= 1).length;
      return isolatedCount / Math.max(1, letters.length) >= 0.6;
    };
    readable = readable.filter(value => !isolatedNoise(value));
    // 可信片段过滤：真实图纸标注至少含 3 个汉字（图名/说明/材料文字）或含域信号词，
    // 且全部字符落在图纸常用字符白名单内（汉字/ASCII 字母数字/常用标点/工程符号）；
    // 二进制误读碎片常含 Latin 扩展字母、罕见符号或纯字母数字串，白名单直接排除
    const trustedCadFragment = (value: string): boolean => {
      const hanCount = (value.match(/\p{Script=Han}/gu) ?? []).length;
      if (hanCount < 3 && !CAD_DOMAIN_SIGNAL_RE.test(value)) return false;
      return !/[^\p{Script=Han}A-Za-z0-9\s\u3000-\u303F\uFF01-\uFF5E\u2460-\u2473\u2160-\u2179°Φφ×±≤≥∠√℃‰※′″〇●○◆■□▲△★☆◇→←↑↓ΩΔαβγθλμω]/u.test(value);
    };
    readable = readable.filter(trustedCadFragment);
    const filteredCount = Math.max(0, binaryFragments.length - readable.length);
    // 图纸"字符数据"= 提取到的标注/标题块中实际可读的文字（汉字/字母/数字）总量；
    // 低于最低阈值视为无字符数据，不入库
    const characterDataCount = this.countCadCharacterData(readable);
    const hasCharacterData = characterDataCount >= MIN_CAD_CHARACTER_DATA;
    metadata.extractionMode = 'builtin_cad_readable_fragments';
    metadata.professionalConversionUsed = false;
    metadata.contentCoverage = hasCharacterData ? 'cad_readable_text_fragments_filtered' : 'cad_no_extractable_text';
    metadata.contentConfidence = hasCharacterData ? 'low_fallback_filtered' : 'metadata_only';
    metadata.stringCandidateCount = binaryFragments.length;
    metadata.stringCount = readable.length;
    metadata.characterDataCount = characterDataCount;
    metadata.filteredGarbledStringCount = filteredCount;
    if (!hasCharacterData) warnings.push(`${file.format} 内置 CAD 解析器未提取到字符数据（仅 ${characterDataCount} 个可读字符），图纸内容未入库`);
    else warnings.push(`${file.format} 内置 DWG→DXF 转换未成功，已使用低置信度可读标注/标题块兜底抽取并过滤疑似乱码 ${filteredCount} 条；该结果仅作为兜底证据，不应等同于完整图层、块、标注和尺寸语义解析`);
    return {
      text: hasCharacterData ? `CAD 图纸可读标注/标题块/属性:\n${readable.join('\n')}` : this.metadataOnlyText(file),
      metadata,
      warnings,
    };
  }

  private async extractDxf(file: ClassifiedFile, raw: string, metadata: Record<string, unknown>): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const warnings: string[] = [];
    let parsed: unknown;
    // dxf-parser 对缺少坐标组码的残缺实体（无 10/20 的 LINE/CIRCLE/POLYLINE）存在解析
    // 死循环缺陷，无限循环不抛异常、try-catch 无法兜住；其解析结果仅用于 metadata 标记，
    // 不参与文本提取。无任何标注实体的图纸（空图纸）必然判空不入库，跳过 parseSync
    // 避免触发库死循环；含标注实体的图纸按正常路径解析
    if (/(?:^|\r?\n)\s*0\s*\r?\n(?:TEXT|MTEXT|DIMENSION|LEADER|ATTRIB)\b/u.test(raw)) {
      try {
        const mod = await resolveAndImport('dxf-parser') as { default?: new () => { parseSync: (text: string) => unknown } } & (new () => { parseSync: (text: string) => unknown });
        const Parser = mod.default ?? mod;
        parsed = new Parser().parseSync(raw);
      } catch {
        warnings.push('dxf-parser 解析失败，已使用 DXF 文本结构抽取回退');
      }
    }

    // 图层/块名同样走 GBK 还原：中文图层名（「轴线」「标注」）在 DWG→DXF 后与标注文本
    // 是同一类码位直出乱码，不还原会被 isUsableCadName 整批判为乱码而丢失
    const layers = this.matchAll(raw, /(?:^|\r?\n)\s*8\s*\r?\n([^\r\n]+)/gu).map(restoreLatin1MojibakeAsGbk).filter(value => this.isUsableCadName(value)).slice(0, 300);
    // G 线 P0-8：取消 5000 实体硬顶的**静默**截断。历史值 5000 是「总量保护」，但没有任何截断
    // 标记，而 contentCoverage 仍报正常覆盖 —— 实测 21 个 CAD 文件中 7 个恰好等于 5000
    // （确定性截断），用户看不到内容被砍。现口径：上限显著提高，且一旦触顶必须显式记账 + 告警。
    const allTextEntities = this.extractDxfTextAnnotations(raw);
    const textEntities = allTextEntities.slice(0, CAD_TEXT_ENTITY_LIMIT);
    const truncatedEntities = allTextEntities.length - textEntities.length;
    const blocks = this.matchAll(raw, /(?:^|\r?\n)\s*2\s*\r?\n([^\r\n]+)/gu).map(restoreLatin1MojibakeAsGbk).filter(value => this.isUsableCadName(value)).slice(0, 300);
    const entityTypes = this.matchAll(raw, /(?:^|\r?\n)\s*0\s*\r?\n([A-Z][A-Z0-9_]+)/gu).slice(0, 1200);
    const uniqueLayers = Array.from(new Set(layers));
    const uniqueBlocks = Array.from(new Set(blocks));
    const uniqueEntityTypes = Array.from(new Set(entityTypes));
    metadata.layerCount = uniqueLayers.length;
    metadata.layerNames = uniqueLayers.slice(0, 80);
    metadata.textEntityCount = textEntities.length;
    // G 线 P0-8：触顶必须显式记账 —— 此前 5000 上限静默截断且 contentCoverage 仍报正常覆盖
    if (truncatedEntities > 0) {
      metadata.truncatedAt = CAD_TEXT_ENTITY_LIMIT;
      metadata.annotationTotal = allTextEntities.length;
      warnings.push(`图纸标注实体 ${allTextEntities.length} 条超过单文件上限 ${CAD_TEXT_ENTITY_LIMIT}，已截断 ${truncatedEntities} 条，入库内容不完整`);
    }
    metadata.blockCount = uniqueBlocks.length;
    metadata.blockNames = uniqueBlocks.slice(0, 80);
    metadata.entityTypeCount = uniqueEntityTypes.length;
    metadata.entityTypes = uniqueEntityTypes.slice(0, 80);
    metadata.parsedByDxfParser = Boolean(parsed);
    // 判空口径只统计标注文本：图层/块名是 CAD 内部结构信息，图纸「空数据」= 无文字标注。
    // 把图层/块名计入字符数会让空图纸（仅图层结构、无任何标注）错误入库
    const characterDataCount = this.countCadCharacterData(textEntities.map(annotation => annotation.text));
    if (characterDataCount < MIN_CAD_CHARACTER_DATA) {
      // 图纸无字符数据（无文字标注、图层/块名均为内部默认值），不入库
      metadata.contentCoverage = 'cad_no_extractable_text';
      metadata.characterDataCount = characterDataCount;
      warnings.push(`${file.format} DXF 未提取到字符数据（仅 ${characterDataCount} 个可读字符），图纸内容未入库`);
      return { text: this.metadataOnlyText(file), metadata, warnings };
    }
    metadata.contentCoverage = 'dxf_semantic_layer_block_annotations';
    metadata.characterDataCount = characterDataCount;
    const semanticNodes = this.buildCadSemanticNodes(file, textEntities);
    return {
      text: [
        `CAD DXF 图层: ${uniqueLayers.join(', ')}`,
        `CAD DXF 块/符号: ${uniqueBlocks.join(', ')}`,
        `CAD DXF 实体类型: ${uniqueEntityTypes.join(', ')}`,
        'CAD 语义标注文本:',
        ...semanticNodes,
      ].join('\n'),
      metadata,
      warnings,
    };
  }

  private buildCadSemanticNodes(file: ClassifiedFile, texts: CadAnnotation[]): string[] {
    // 图纸语义节点 = 文件名锚定 + 布局重建后的标注文本。逐实体枚举的图元属性包装
    // （图层/块/实体类型/坐标/关联对象/状态）是重复结构模板噪音，会稀释检索语义
    // （如「混凝土强度 C35」被「实体类型:|坐标:(…)」图元罗列干扰）；图层/块/实体
    // 类型汇总已在 CAD DXF 汇总行体现，此处只保留图纸真实文字（图名/说明/尺寸标注值），
    // 并按坐标重建行/段落结构（总说明类多实体文本恢复为连续段落，防碎片化入库）
    const fileName = path.basename(file.relativePath);
    // G 线 P2-7：MTEXT 段落符 \P 在此转真换行——两条 CAD 出口（DXF 语义层 / 兜底解析）都经由
    // 本函数，故这是段落边界唯一的共同消费点。转成换行而非留到逐行清洗处理，是因为
    // cleanCadReadableText 末尾的 `\s+`→空格 会把换行折叠掉、段落被无分隔粘连成一行。
    // 实测三种形态：原样残留 `\P`（转义码污染检索词面）→ 拆成独立标注（被 layoutCadAnnotations
    // 按坐标重建成连续段落，仍粘连）→ **保留换行**（段落如实分行，总说明类多段文本结构得以保持）。
    const annotations = texts
      .filter(item => item.text && item.text.trim().length > 0)
      .map(item => ({ ...item, text: item.text.replace(CAD_MTEXT_PARAGRAPH_RE, '\n') }));
    if (annotations.length === 0) return [`图纸节点: ${fileName} | 未提取到文字标注`];
    return [`图纸节点: ${fileName}`, ...layoutCadAnnotations(annotations)];
  }

  private extractDxfTextAnnotations(raw: string): CadAnnotation[] {
    // ATTRIB（块属性）是门窗表/材料表/标题栏数据的载体（块插入时的属性值实体），
    // 此前遗漏导致整表数据丢失（真实图纸回归：门窗表仅剩零散标注）
    return parseDxfTextEntities(raw).flatMap(entity => {
      const entityType = entity.type;
      // 组码查询一律走成对解析结果：值行与组码行外观相同，按行匹配会把值当组码
      const first = (code: string): string | undefined => entity.pairs.find(pair => pair[0] === code)?.[1];
      const numeric = (code: string): number | undefined => {
        const value = first(code);
        if (value === undefined) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      let rawText: string;
      if (entityType === 'ATTRIB') {
        // 属性实体：组码 2 是属性标签名（门窗表/材料表的列名），组码 1 是属性值，
        // 标签与值是独立语义字段（「型号 M1021」「高度 2100」），空格连接而非续段拼接
        rawText = `${first('2')?.trim() ?? ''} ${first('1')?.trim() ?? ''}`;
      } else {
        // MTEXT 多段文本：组码 1 是首段（≤255 字符），组码 3 是后续续段（每段 ≤250 字符），
        // 必须按序拼接才是完整文字（此前只取首个组码 1/3，多段标注丢失大半内容）；
        // DIMENSION 组码 1/3 是显式尺寸文字与后缀，TEXT/LEADER 组码 3 罕见但同按序收集。
        // 按 pairs 的文档顺序取，保持 1 与 3 的交错次序
        rawText = entity.pairs.filter(pair => pair[0] === '1' || pair[0] === '3').map(pair => pair[1]).join('');
      }
      // DWG→DXF 转换把 DWG 内部的 GBK 标注按码位直出（0xBF 0xF2 → "¿ò"），必须先还原编码：
      // cleanCadReadableText 会把 C1 半字节（U+0080-U+009F）直接替换成空格，一旦先清洗，
      // 中文标注就永久还原不回来，只能被 isLikelyGarbledCadText 当乱码整条丢弃
      const text = this.cleanCadReadableText(restoreLatin1MojibakeAsGbk(rawText));
      if (!text || !this.isReadableCadValue(text)) return [];
      // 图层/块名同样要过可读性过滤：DXF 里 GBK 误读（Ïä¹ñ）或纯数字/内部
      // 标识（11、AcDb...）会直接混进节点文本，不合格时置空由语义节点回退
      const layer = restoreLatin1MojibakeAsGbk(first('8')?.trim() ?? '');
      // ATTRIB 的组码 2 是属性标签名而非块名，不可当块名使用
      const block = entityType === 'ATTRIB' ? '' : restoreLatin1MojibakeAsGbk(first('2')?.trim() ?? '');
      return [{
        text,
        layer: layer && this.isReadableCadValue(layer) ? layer : undefined,
        block: block && this.isReadableCadValue(block) ? block : undefined,
        entityType,
        x: numeric('10'),
        y: numeric('20'),
      }];
    });
  }

  private async tryConvertDwgWithBundledWasm(filePath: string): Promise<{ dxfText?: string; tool: string; warnings: string[] }> {
    try {
      const mod = await resolveAndImport('dwgdxf') as { convertDwgToDxf?: (dwg: Uint8Array | ArrayBuffer, options?: { wasmBase?: string }) => Promise<Uint8Array> };
      if (!mod.convertDwgToDxf) return { tool: 'dwgdxf_wasm', warnings: ['内置 dwgdxf WASM 转换器未导出 convertDwgToDxf'] };
      const dwgBytes = fs.readFileSync(filePath);
      // 注意：dwgdxf 内部对 WASM 基础 URL 有模块级缓存，只有首次调用传入的
      // wasmBase 才会生效。若首次调用不带 wasmBase，会走到包内硬编码的构建机
      // 路径（file:///home/runner/work/...）并永久缓存失败结果，后续重试全部
      // 复用同一失败 Promise。因此第一次调用就必须传本地包内 wasm 目录的
      // 正确 file:// URL，不允许再回退重试（重试无效且会污染缓存）。
      let wasmBase: string | undefined;
      try {
        const localWasmDir = path.join(path.dirname(resolvePackage('dwgdxf')), 'wasm');
        if (fs.existsSync(path.join(localWasmDir, 'dwgdxf_bg.wasm'))) {
          wasmBase = pathToFileURL(localWasmDir).href;
        }
      } catch { /* 包解析失败时回退到包内默认路径（大概率也会失败，但由下方 catch 统一记录） */ }
      try {
        const dxfBytes = await mod.convertDwgToDxf(dwgBytes, wasmBase ? { wasmBase } : undefined);
        const dxfText = Buffer.from(dxfBytes).toString('utf8');
        if (dxfText.trim()) return { dxfText, tool: wasmBase ? 'dwgdxf_wasm:local_wasm' : 'dwgdxf_wasm:package_default', warnings: [] };
        return { tool: 'dwgdxf_wasm', warnings: ['内置 dwgdxf WASM 未输出 DXF 文本'] };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // unreachable 多为 WASM 内存压力下的瞬时失败（批量索引时主进程同时持有
        // 大型 SQLite 缓存会挤压可用内存），换一个内存状态重试一次；格式类错误
        // （Invalid file format 等）重试无意义，直接失败降级。
        if (detail.includes('unreachable')) {
          try {
            const retryBytes = await mod.convertDwgToDxf(dwgBytes, wasmBase ? { wasmBase } : undefined);
            const retryText = Buffer.from(retryBytes).toString('utf8');
            if (retryText.trim()) return { dxfText: retryText, tool: wasmBase ? 'dwgdxf_wasm:local_wasm' : 'dwgdxf_wasm:package_default', warnings: ['内置 dwgdxf WASM 首次转换失败（unreachable），重试成功'] };
          } catch { /* 重试仍失败，按原错误降级 */ }
        }
        return { tool: 'dwgdxf_wasm', warnings: [`内置 dwgdxf WASM 转换失败${wasmBase ? '' : '（未找到本地 WASM 文件，使用了包内默认路径）'}: ${detail}`] };
      }
    } catch (error) {
      return { tool: 'dwgdxf_wasm', warnings: [`内置 dwgdxf WASM 加载失败: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  private async tryConvertDwgToDxf(filePath: string): Promise<{ dxfText?: string; tool: string; warnings: string[] } | undefined> {
    const tmpDir = fs.mkdtempSync(path.join(this.getTempRoot(), 'customize-dwg-'));
    const outputPath = path.join(tmpDir, `${path.basename(filePath, path.extname(filePath))}.dxf`);
    try {
      const failures: string[] = [];
      const bundled = await this.tryConvertDwgWithBundledWasm(filePath);
      if (bundled.dxfText) return bundled;
      failures.push(...bundled.warnings);

      const customCmd = process.env.CUSTOMIZE_DWG_TO_DXF_CMD;
      if (customCmd) {
        if (/\s/u.test(customCmd)) return { tool: 'external_dwg_to_dxf', warnings: ['CUSTOMIZE_DWG_TO_DXF_CMD 只支持可执行文件路径；参数请使用 CUSTOMIZE_DWG_TO_DXF_ARGS JSON 数组配置'] };
        let argTemplate: unknown = ['{input}', '{output}'];
        try { if (process.env.CUSTOMIZE_DWG_TO_DXF_ARGS) argTemplate = JSON.parse(process.env.CUSTOMIZE_DWG_TO_DXF_ARGS) as unknown; }
        catch { return { tool: 'external_dwg_to_dxf', warnings: ['CUSTOMIZE_DWG_TO_DXF_ARGS 必须是字符串数组 JSON'] }; }
        if (!Array.isArray(argTemplate) || !argTemplate.every(arg => typeof arg === 'string')) return { tool: 'external_dwg_to_dxf', warnings: ['CUSTOMIZE_DWG_TO_DXF_ARGS 必须是字符串数组 JSON'] };
        const args = argTemplate.map(arg => arg.replace(/\{input\}/gu, filePath).replace(/\{output\}/gu, outputPath));
        const result = spawnSync(customCmd, args, { shell: false, encoding: 'utf8', timeout: 120_000 });
        if (result.status === 0 && fs.existsSync(outputPath)) return { dxfText: fs.readFileSync(outputPath, 'utf8'), tool: 'external_dwg_to_dxf', warnings: [] };
        return { tool: 'external_dwg_to_dxf', warnings: [`CUSTOMIZE_DWG_TO_DXF_CMD 转换失败: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`] };
      }

      for (const bin of ['dwgread', 'dwg2dxf']) {
        const result = spawnSync(bin, bin === 'dwgread' ? ['-O', 'DXF', '-o', outputPath, filePath] : [filePath, outputPath], { encoding: 'utf8', timeout: 120_000 });
        if (result.status === 0 && fs.existsSync(outputPath)) return { dxfText: fs.readFileSync(outputPath, 'utf8'), tool: bin, warnings: [] };
        if (result.error && 'code' in result.error && result.error.code === 'ENOENT') continue;
        failures.push(`${bin} 转换失败: ${result.stderr || result.stdout || result.error?.message || `exit ${result.status ?? 'unknown'}`}`);
      }
      return { tool: 'builtin_fallback', warnings: [...failures, failures.length ? 'DWG→DXF 转换失败，使用内置图纸可读文本抽取' : '未检测到可用 DWG→DXF 转换器（dwgread/dwg2dxf/CUSTOMIZE_DWG_TO_DXF_CMD），使用内置图纸可读文本抽取'] };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private extractCadMesh(file: ClassifiedFile, ext: string, metadata: Record<string, unknown>): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const warnings: string[] = [];
    if (['.obj', '.gltf'].includes(ext)) {
      const raw = fs.readFileSync(file.absolutePath, 'utf8');
      const objectNames = this.matchAll(raw, /^(?:o|g)\s+(.+)$/gmu).slice(0, 300);
      const nodeNames = this.matchAll(raw, /"name"\s*:\s*"([^"]+)"/gu).slice(0, 300);
      metadata.objectCount = objectNames.length + nodeNames.length;
      metadata.contentCoverage = 'mesh_object_node_names';
      return {
        text: [this.metadataOnlyText(file), `Mesh 对象/节点/分组:\n${[...objectNames, ...nodeNames].join('\n')}`].join('\n'),
        metadata,
        warnings,
      };
    }

    if (ext === '.stl') {
      const buffer = fs.readFileSync(file.absolutePath);
      const header = buffer.subarray(0, 80).toString('utf8').replace(/\0/gu, ' ').trim();
      const rawStart = buffer.subarray(0, Math.min(buffer.length, 20_000)).toString('utf8');
      const solids = this.matchAll(rawStart, /solid\s+([^\r\n]+)/giu).slice(0, 100);
      metadata.contentCoverage = 'stl_header_solids';
      metadata.solidCount = solids.length;
      return { text: [this.metadataOnlyText(file), `STL 头信息: ${header}`, `STL solid 名称:\n${solids.join('\n')}`].join('\n'), metadata, warnings };
    }

    if (ext === '.3mf') {
      const strings = this.extractBinaryStrings(file.absolutePath).slice(0, 500);
      metadata.contentCoverage = strings.length > 0 ? '3mf_model_strings' : 'metadata';
      metadata.stringCount = strings.length;
      return { text: strings.length > 0 ? [this.metadataOnlyText(file), `3MF 模型字符串/部件信息:\n${strings.join('\n')}`].join('\n') : '', metadata, warnings };
    }

    const binaryStrings = this.extractBinaryStrings(file.absolutePath).slice(0, 300);
    metadata.contentCoverage = binaryStrings.length > 0 ? 'mesh_binary_strings' : 'metadata';
    return { text: binaryStrings.length > 0 ? [this.metadataOnlyText(file), `Mesh 二进制字符串:\n${binaryStrings.join('\n')}`].join('\n') : '', metadata, warnings };
  }

  private getTempRoot(): string {
    return process.env.CUSTOMIZE_TMPDIR || process.env.TMPDIR || tmpdir();
  }

  /**
   * 页级 OCR 结果缓存的目录（W7 断点续跑）。
   * 默认落在系统临时目录下的固定子目录（跨进程重启存活，OS 清理临时目录时一并失效——可接受）；
   * `CUSTOMIZE_KB_OCR_CACHE_DIR` 可重定向；设为 `off` 关闭缓存。
   */
  private ocrPageCacheDir(): string | undefined {
    const configured = process.env.CUSTOMIZE_KB_OCR_CACHE_DIR;
    if (configured === 'off') return undefined;
    return configured && configured.trim() ? configured.trim() : path.join(this.getTempRoot(), 'ca-ocr-page-cache');
  }

  /**
   * 页级缓存键：文件身份（路径+大小+mtime，与变更检测同源）+ 页号 + 渲染 DPI + **解析参数版本**。
   * 参数版本变化（切片边长/召回阈值/清洗口径调整）即整体失效——宁可重跑，不可复用旧口径的结果。
   */
  private ocrPageCacheKey(file: ClassifiedFile, pageIndex: number, dpi: number): string {
    return ocrPageCacheKeyOf({ absolutePath: file.absolutePath, fileSize: file.fileSize, mtime: file.mtime, pageIndex, dpi });
  }

  /**
   * 读页级 OCR 缓存。命中即跳过该页的全部 OCR（含 300 DPI 重试）——**结果与未命中路径逐字节一致**
   * （缓存写入的是最终 ocrText；同文件身份 + 同参数版本下重跑不可能得到不同结果）。
   */
  private readCachedPageOcr(file: ClassifiedFile, pageIndex: number, dpi: number): { text: string; score: number; strategy: string; tiled: boolean; tiles: number } | undefined {
    const dir = this.ocrPageCacheDir();
    if (!dir) return undefined;
    const cachePath = path.join(dir, `${this.ocrPageCacheKey(file, pageIndex, dpi)}.json`);
    try {
      if (!fs.existsSync(cachePath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { text?: string; score?: number; strategy?: string; tiled?: boolean; tiles?: number };
      if (typeof parsed.text !== 'string') return undefined;
      return { text: parsed.text, score: Number(parsed.score || 0), strategy: String(parsed.strategy || 'cached'), tiled: Boolean(parsed.tiled), tiles: Number(parsed.tiles || 0) };
    } catch {
      return undefined; // 缓存损坏按未命中处理（不得影响主流程）
    }
  }

  /** 写页级 OCR 缓存（失败静默——缓存是优化，不得因写盘失败影响解析） */
  private writeCachedPageOcr(file: ClassifiedFile, pageIndex: number, dpi: number, payload: { text: string; score: number; strategy: string; tiled: boolean; tiles: number }): void {
    const dir = this.ocrPageCacheDir();
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${this.ocrPageCacheKey(file, pageIndex, dpi)}.json`), JSON.stringify(payload));
    } catch {
      // 静默：缓存写失败不影响解析
    }
  }

  private extractBinaryReadableFragments(filePath: string): string[] {
    const buffer = fs.readFileSync(filePath);
    // 编码候选必须覆盖 GBK：DWG 内部的图纸标注常为 GBK 编码，而 utf8 候选会把它们读成
    // U+FFFD、latin1 候选读成 "¿ò" 形态 —— 两条都会被乱码判定（替换符规则 / gbkMisreadChars
    // 规则）整条丢弃，结果是**中文标注 0 字入库、只剩 ASCII 碎片**。
    // 本条与 DXF 实体路径的 restoreLatin1MojibakeAsGbk 是同根因的两条入口，此前只修了后者：
    // 转换器失败或输出乱码而走内置兜底时，中文仍然全丢。
    const latin1Text = buffer.toString('latin1');
    const candidates = [
      buffer.toString('utf8'),
      buffer.toString('utf16le'),
      this.swapUtf16Bytes(buffer).toString('utf16le'),
      latin1Text,
      // latin1 形态的 GBK 还原（0xBF 0xF2 → "¿ò" → 框架）
      restoreLatin1MojibakeAsGbk(latin1Text),
      // 原生 GBK 字节流（utf8 解读出现大量替换符时才是真 GBK，此处直接解一遍由打分排序竞争）
      new TextDecoder('gbk', { fatal: false }).decode(buffer),
    ];
    return Array.from(new Set(candidates.flatMap(candidate => this.extractReadableFragments(candidate))))
      .filter(value => value.length >= 3 && !/^\d+$/u.test(value))
      .sort((a, b) => this.textScore(b) - this.textScore(a))
      .slice(0, 2_000);
  }

  private extractBinaryStrings(filePath: string): string[] {
    return this.extractBinaryReadableFragments(filePath);
  }

  private extractData(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const metadata: Record<string, unknown> = { extractionMode: 'structured_data', semanticExtractionMode: 'structured_data_semantic_paths', vectorizable: true };
    try {
      if (file.format === 'json') {
        const isJsonl = path.extname(file.absolutePath).toLowerCase() === '.jsonl';
        const records = isJsonl
          ? raw.split(/\r?\n/u).filter(Boolean).map((line, index) => ({ path: `line${index + 1}`, value: JSON.parse(line) }))
          : [{ path: '$', value: JSON.parse(raw) }];
        const lines = records.flatMap(record => this.flattenJson(record.value, record.path));
        const objects = records.flatMap(record => this.atomicJsonObjects(record.value, record.path));
        metadata.fieldCount = lines.length;
        metadata.recordCount = records.length;
        metadata.objectCount = objects.length;
        metadata.dataPaths = lines.map(line => line.split(':')[0]).slice(0, 200);
        metadata.contentCoverage = isJsonl ? 'jsonl_atomic_objects_paths_values' : 'json_atomic_objects_paths_values';
        return { text: [this.metadataOnlyText(file), '## 路径声明', ...lines, '## 原子对象', ...objects].join('\n'), metadata, warnings: [] };
      }
    } catch {
      metadata.parseError = true;
    }

    if (file.format === 'yaml') {
      const lines = this.flattenYamlByIndent(raw).slice(0, 3000);
      metadata.fieldCount = lines.length;
      metadata.dataPaths = lines.map(line => (line.split(':')[0] ?? '').trim()).slice(0, 200);
      metadata.contentCoverage = 'yaml_indented_paths_values';
      return { text: [this.metadataOnlyText(file), '## YAML 路径声明', ...lines].join('\n'), metadata, warnings: [] };
    }

    if (file.format === 'xml') {
      const elements = this.flattenXmlPaths(raw).slice(0, 3000);
      metadata.elementTextCount = elements.length;
      metadata.dataPaths = elements.map(line => (line.split(':')[0] ?? '').trim()).slice(0, 200);
      metadata.contentCoverage = 'xml_paths_values';
      return { text: [this.metadataOnlyText(file), '## XML 路径声明', ...elements].join('\n'), metadata, warnings: [] };
    }

    metadata.contentCoverage = 'plain_structured_text';
    return { text: [this.metadataOnlyText(file), raw].join('\n'), metadata, warnings: [] };
  }

  private extractDiagram(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const metadata: Record<string, unknown> = { extractionMode: 'diagram_structural', vectorizable: true };

    if (file.format === 'drawio') {
      const graph = this.extractDrawioGraph(raw);
      metadata.nodeTextCount = graph.nodes.length;
      metadata.edgeCount = graph.edges.length;
      metadata.contentCoverage = 'drawio_graph_links';
      return { text: [this.metadataOnlyText(file), 'Draw.io 图链路:', ...graph.links, 'Draw.io 节点:', ...graph.nodes.map(node => `[${node.id}] ${node.label}`)].join('\n'), metadata, warnings: [] };
    }

    if (file.format === 'excalidraw') {
      try {
        const graph = this.extractExcalidrawGraph(raw);
        metadata.elementTextCount = graph.nodes.length;
        metadata.edgeCount = graph.links.length;
        metadata.contentCoverage = 'excalidraw_graph_links';
        return { text: [this.metadataOnlyText(file), 'Excalidraw 图链路:', ...graph.links, 'Excalidraw 节点:', ...graph.nodes].join('\n'), metadata, warnings: [] };
      } catch {
        metadata.parseError = true;
      }
    }

    metadata.contentCoverage = 'diagram_source_text';
    return { text: [this.metadataOnlyText(file), raw].join('\n'), metadata, warnings: [] };
  }

  private extractDrawioGraph(raw: string): { nodes: Array<{ id: string; label: string }>; edges: string[]; links: string[] } {
    const cells = Array.from(raw.matchAll(/<mxCell\b([^>]*)>/gu), match => this.parseXmlAttributes(match[1] ?? ''));
    const nodes = cells
      .filter(cell => cell.value || cell.label || cell.id)
      .map((cell, index) => ({ id: String(cell.id ?? `node-${index + 1}`), label: this.stripXml(String(cell.value || cell.label || cell.id)) }))
      .filter(node => node.label);
    const nodeById = new Map(nodes.map(node => [node.id, node.label]));
    const edges = cells.filter(cell => cell.edge === '1' && cell.source && cell.target);
    const links = edges.map(edge => {
      const source = nodeById.get(String(edge.source)) ?? String(edge.source);
      const target = nodeById.get(String(edge.target)) ?? String(edge.target);
      const label = this.stripXml(String(edge.value || edge.label || '关系'));
      return `[${source}] ──> (${label}) ──> [${target}]`;
    });
    return { nodes, edges: edges.map(edge => String(edge.id ?? 'edge')), links };
  }

  private extractExcalidrawGraph(raw: string): { nodes: string[]; links: string[] } {
    type ExcalidrawElement = { id?: string; type?: string; text?: string; x?: number; y?: number; width?: number; height?: number; startBinding?: { elementId?: string }; endBinding?: { elementId?: string } };
    const parsed = JSON.parse(raw) as { elements?: ExcalidrawElement[] };
    const elements = parsed.elements ?? [];
    const textById = new Map(elements.filter(element => element.text).map(element => [String(element.id), String(element.text)]));
    const shapeLabels = elements
      .filter(element => element.type !== 'arrow' && element.type !== 'line')
      .map((element, index) => {
        const id = String(element.id ?? `node-${index + 1}`);
        const own = element.text ?? textById.get(id);
        const nested = elements.find(candidate => candidate.text && this.isPointInside(candidate, element));
        return { id, label: own ?? nested?.text ?? element.type ?? '节点' };
      });
    const labelById = new Map(shapeLabels.map(node => [node.id, node.label]));
    const links = elements
      .filter(element => element.type === 'arrow' && element.startBinding?.elementId && element.endBinding?.elementId)
      .map(element => `[${labelById.get(element.startBinding!.elementId!) ?? element.startBinding!.elementId}] ──> (箭头) ──> [${labelById.get(element.endBinding!.elementId!) ?? element.endBinding!.elementId}]`);
    const nodes = shapeLabels.map(node => `[${node.id}] ${node.label}`);
    return { nodes, links };
  }

  private isPointInside(point: { x?: number; y?: number }, box: { x?: number; y?: number; width?: number; height?: number }): boolean {
    if (point.x == null || point.y == null || box.x == null || box.y == null || box.width == null || box.height == null) return false;
    return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
  }

  private parseXmlAttributes(input: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const match of input.matchAll(/([\w:-]+)="([^"]*)"/gu)) attrs[match[1]!] = this.stripXml(match[2] ?? '');
    return attrs;
  }

  private parseDelimitedLine(line: string, delimiter: string): string[] {
    const values: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          quoted = !quoted;
        }
      } else if (char === delimiter && !quoted) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  }

  private toMarkdownTable(header: string[], rows: string[][]): string {
    const width = Math.max(header.length, ...rows.map(row => row.length), 1);
    const normalizedHeader = Array.from({ length: width }, (_, index) => header[index] || `COL${index + 1}`);
    const escape = (value: unknown) => String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ').trim();
    return [
      `| ${normalizedHeader.map(escape).join(' | ')} |`,
      `| ${normalizedHeader.map(() => '---').join(' | ')} |`,
      ...rows.map(row => `| ${Array.from({ length: width }, (_, index) => escape(row[index] ?? '')).join(' | ')} |`),
    ].join('\n');
  }

  private extractDelimitedText(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const decoded = decodeTextBuffer(fs.readFileSync(file.absolutePath));
    const raw = decoded.text;
    const delimiter = file.format === 'tsv' ? '\t' : ',';
    const rows = raw.split(/\r?\n/u).filter(line => line.trim().length > 0);
    // F1 智能表头行检测（与 xlsx 路径同源）：标题行不再被当表头，表头列名保留真实语义
    const matrix = rows.map(line => this.parseDelimitedLine(line, delimiter));
    const smart = detectSmartTableHeader(matrix);
    const header = smart.headers;
    const tableRows = matrix.slice(smart.headerIndex + 1);
    const markdown = this.toMarkdownTable(header, tableRows);
    const legacyKv = tableRows.flatMap((values, rowIndex) => values.map((value, colIndex) => {
      const column = header[colIndex] || `COL${colIndex + 1}`;
      return `R${rowIndex + 2}C${colIndex + 1} ${column}: ${foldKvCellText(value)}`;
    }));
    const titleNote = smart.titleLines.length ? `｜表标题：${smart.titleLines.join(' ')}` : '';
    return {
      text: [this.metadataOnlyText(file), `工作表：默认${titleNote}`, markdown, '表格路径声明', ...legacyKv].join('\n\n'),
      metadata: {
        extractionMode: 'delimited_text_structured',
        semanticExtractionMode: 'delimited_markdown_table',
        vectorizable: true,
        encoding: decoded.encoding,
        delimiter: file.format === 'tsv' ? 'tab' : 'comma',
        rowCount: rows.length,
        columnCount: header.length,
        columnNames: header.slice(0, 120),
        contentCoverage: 'markdown_table',
      },
      warnings: [],
    };
  }

  /**
   * Office 文档解析入口：正文抽取 + 内嵌图片 OCR。
   * 图片内容与正文分节（`## 内嵌图片 N（OCR）`），可被检索、可被证据召回、导出可见。
   */
  private async extractOfficeDocument(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const base = await this.extractOfficeDocumentText(file);
    return this.appendEmbeddedImageOcr(file, base);
  }

  /**
   * OCR Office 文档的内嵌图片并追加到正文之后。
   * 这些图片常承载关键内容（实测有整页施工图、成套技术说明），此前被整体丢弃。
   */
  private async appendEmbeddedImageOcr(
    file: ClassifiedFile,
    base: { text: string; metadata: Record<string, unknown>; warnings: string[] },
  ): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const warnings = [...base.warnings];
    const images = await extractEmbeddedOfficeImages(file.absolutePath);
    if (images.length === 0) return base;
    warnings.push(`文档含 ${images.length} 张内嵌图片，已提交 OCR 解析`);
    base.metadata.officeEmbeddedImageCount = images.length;

    let provider: OcrProvider | undefined;
    const tmpDir = fs.mkdtempSync(path.join(this.getTempRoot(), 'kb-office-img-'));
    try {
      provider = await createOcrProvider();
      warnings.push(...this.ocrProviderWarnings(provider));
      const sections: string[] = [];
      let recognized = 0;
      let characters = 0;
      for (const [index, image] of images.entries()) {
        try {
          // 交给 provider 按 filePath 解码，与其在 PDF/栅格路径上的预处理保持一致
          const imgPath = path.join(tmpDir, `img-${index}${image.data.subarray(0, 2).toString('hex') === 'ffd8' ? '.jpg' : '.png'}`);
          fs.writeFileSync(imgPath, image.data);
          // 与栅格图同路处理：docx/xlsx 内嵌的施工图长边常超检测上限，整图识别会把小号
          // 标注压没（切片后可恢复）；此前切片只接在 PDF 页路径上，内嵌图一律整图识别。
          // 用 loadImagePixels 取实际像素尺寸而非文档元数据声明的尺寸，避免两者不一致时切错网格
          const embeddedPixels = await this.loadImagePixels(imgPath);
          const result = await this.recognizeRasterImage(provider, embeddedPixels, {}, warnings);
          const text = this.cleanOcrText(result.text);
          if (!text || this.normalizedTextLength(text) < 8) continue;
          sections.push(`## 内嵌图片 ${index + 1}（OCR）\n\n${text}`);
          recognized += 1;
          characters += this.normalizedTextLength(text);
        } catch (error) {
          warnings.push(`内嵌图片 ${index + 1} OCR 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (sections.length === 0) {
        warnings.push(`文档含 ${images.length} 张内嵌图片，但未识别出可用文字`);
        return { text: base.text, metadata: base.metadata, warnings };
      }
      base.metadata.officeEmbeddedImagesOcr = recognized;
      base.metadata.officeEmbeddedImageChars = characters;
      warnings.push(`内嵌图片 OCR 完成：${recognized}/${images.length} 张识别出文字，共 ${characters} 字`);
      return {
        text: [base.text, ...sections].join('\n\n'),
        metadata: base.metadata,
        warnings,
      };
    } catch (error) {
      warnings.push(`内嵌图片 OCR 不可用（${error instanceof Error ? error.message : String(error)}），已跳过图片内容`);
      return { text: base.text, metadata: base.metadata, warnings };
    } finally {
      if (provider) await provider.dispose();
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
    }
  }

  private async extractOfficeDocumentText(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const ext = path.extname(file.absolutePath).toLowerCase();
    const isZip = this.isZipOpenXmlFile(file.absolutePath);
    const isOle = this.isOleCompoundFile(file.absolutePath);
    if (isOle) return this.extractOleOfficeDocument(file, ext === '.docx' ? ['文件扩展名为 .docx，但真实格式为旧版 OLE/CFB Office 复合文档，已按旧版 Office 解析'] : []);
    if (ext === '.rtf') return this.extractRtf(file);
    if (ext === '.doc') return this.extractLegacyWordDocument(file);
    if (ext === '.ppt') return this.extractLegacyOfficeBinary(file);
    if (ext === '.docx') {
      if (!isZip) return this.extractLegacyOfficeBinaryWithWarnings(file, ['文件扩展名为 .docx，但未检测到 OpenXML ZIP 文件头，已降级为二进制可读文本抽取']);
      try {
        const styledMarkdown = await this.extractDocxStyleTreeMarkdown(file.absolutePath);
        if (styledMarkdown.trim()) {
          return {
            text: styledMarkdown,
            metadata: { extractionMode: 'docx_xml_style_tree_markdown', vectorizable: true, contentCoverage: 'office_style_tree_markdown' },
            warnings: [],
          };
        }
        const mammoth = await resolveAndImport('mammoth') as any;
        const result = await mammoth.convertToMarkdown({ path: file.absolutePath });
        const text = String(result.value ?? '').trim();
        if (text) {
          return {
            text: this.normalizeMarkdownHeadings(text),
            metadata: { extractionMode: 'builtin_mammoth_markdown', vectorizable: true, contentCoverage: 'office_markdown_structure' },
            warnings: (result.messages as Array<{ message: string }>).map(m => m.message),
          };
        }
      } catch {
        // 降级到下方 Office ZIP 解析
      }
    }
    return this.extractOfficeZip(file);
  }

  private extractRtf(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    // RTF 的代码页声明（\ansicpg936 = GBK）。中文 Word/写字板写出的 RTF 以 \ansicpg936 +
    // \'hh 转义表示全部非 ASCII 字符。旧实现把 \'hh 直接替换成空格 —— **中文正文 100%
    // 丢失**，且因结果仍含字体表等 ASCII 内容（实测只剩 "SimSun;"）而不触发「未提取到
    // 正文」告警，整类格式静默失效。
    const codePage = Number(/\\ansicpg(\d+)/u.exec(raw)?.[1] ?? 0);
    const encoding = RTF_CODE_PAGE_ENCODING[codePage];
    // 连续 \'hh 必须整段还原：单字节分别解码会把 GBK 双字节字拆成两个替换符
    const decodedEscapes = raw.replace(/(?:\\'[0-9a-fA-F]{2})+/gu, run => {
      const bytes = run.match(/[0-9a-fA-F]{2}/gu) ?? [];
      const buffer = Buffer.from(bytes.map(hex => Number.parseInt(hex, 16)));
      // 未声明或未知代码页时交给通用编码探测（UTF-8 → GBK），与本仓其他文本入口同口径
      if (!encoding) return decodeTextBuffer(buffer).text;
      try {
        return new TextDecoder(encoding, { fatal: false }).decode(buffer);
      } catch {
        return decodeTextBuffer(buffer).text;
      }
    });
    const text = decodedEscapes
      // \uNNNN 是 RTF 的 Unicode 转义（现代 Word 优先写这种形态），形如「\u20013?」：
      // 把主字符与紧随其后用于占位的 ASCII 字符一并消费，避免留下孤立字符污染正文
      .replace(/\\u(-?\d+)\s?\??/gu, (_match, code: string) => {
        const value = Number(code);
        return Number.isFinite(value) && value > 0 ? String.fromCharCode(value) : '';
      })
      .replace(/\\[a-zA-Z]+-?\d* ?/gu, ' ')
      .replace(/[{}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
    return {
      text,
      metadata: { extractionMode: 'builtin_rtf_text', vectorizable: true, contentCoverage: 'rtf_text', rtfCodePage: codePage || undefined },
      warnings: text ? [] : ['RTF 解析未提取到正文，未入库'],
    };
  }

  private async extractLegacyWordDocument(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const warnings: string[] = [];
    try {
      const mod = await resolveAndImport('word-extractor') as { default?: new () => { extract: (path: string) => Promise<{ getBody: () => string }> } } & (new () => { extract: (path: string) => Promise<{ getBody: () => string }> });
      const WordExtractor = mod.default ?? mod;
      const document = await new WordExtractor().extract(file.absolutePath);
      const text = document.getBody().trim();
      if (text) {
        return {
          text,
          metadata: { extractionMode: 'builtin_word_extractor', vectorizable: true, contentCoverage: 'legacy_word_full_text', textLength: text.length },
          warnings: [],
        };
      }
      warnings.push('word-extractor 未提取到正文，已降级为二进制可读文本抽取');
    } catch (error) {
      warnings.push(`word-extractor 解析失败，已降级为二进制可读文本抽取: ${error instanceof Error ? error.message : String(error)}`);
    }
    const fallback = this.extractLegacyOfficeBinary(file);
    fallback.warnings.unshift(...warnings);
    return fallback;
  }

  private extractLegacyOfficeBinary(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const candidates = this.extractBinaryStrings(file.absolutePath).slice(0, 1_000);
    // 二进制兜底提取出的字符串中混有大量误读乱码（如 OLE 复合文档中 UTF-16LE
    // 中文被 latin1/utf8 误读产生的长串生僻字），复用 CAD 乱码判定规则过滤，
    // 避免乱码直接入库污染检索与预览。
    const strings = candidates.filter(value => !this.isLikelyGarbledCadText(value));
    const filteredCount = candidates.length - strings.length;
    const text = strings.join('\n').trim();
    return {
      text,
      metadata: { extractionMode: 'builtin_legacy_office_binary_strings', vectorizable: true, contentCoverage: 'legacy_office_binary_strings_filtered', stringCandidateCount: candidates.length, stringCount: strings.length, filteredGarbledStringCount: filteredCount },
      warnings: [
        ...(filteredCount > 0 ? [`已过滤疑似乱码字符串 ${filteredCount} 条`] : []),
        ...(text ? [] : ['旧版 Office 二进制文件未提取到正文，未入库']),
      ],
    };
  }

  private extractLegacyOfficeBinaryWithWarnings(file: ClassifiedFile, warnings: string[]): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const result = this.extractLegacyOfficeBinary(file);
    return { ...result, warnings: [...warnings, ...result.warnings] };
  }

  private isZipOpenXmlFile(filePath: string): boolean {
    const header = fs.readFileSync(filePath).subarray(0, 4);
    return header.length >= 4 && header[0] === 0x50 && header[1] === 0x4b && [0x03, 0x05, 0x07].includes(header[2] ?? -1);
  }

  private isOleCompoundFile(filePath: string): boolean {
    const signature = fs.readFileSync(filePath).subarray(0, 8);
    return signature.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  }

  private async extractOleOfficeDocument(file: ClassifiedFile, warnings: string[] = []): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const word = await this.extractLegacyWordDocument(file);
    if (word.text.trim() && word.metadata.extractionMode === 'builtin_word_extractor') {
      return {
        text: word.text,
        metadata: { ...word.metadata, realOfficeContainer: 'ole_cfb' },
        warnings: [...warnings, ...word.warnings],
      };
    }

    const spreadsheet = await this.extractSpreadsheet(file);
    if (spreadsheet.text.trim() && spreadsheet.metadata.extractionMode !== 'office_zip_failed') {
      return {
        text: spreadsheet.text,
        metadata: { ...spreadsheet.metadata, realOfficeContainer: 'ole_cfb' },
        warnings: [...warnings, ...spreadsheet.warnings],
      };
    }

    return this.extractLegacyOfficeBinaryWithWarnings(file, warnings);
  }

  private findMergedCellValue(sheet: SpreadsheetSheet, merges: SpreadsheetRange[], row: number, col: number, XLSX: any): string | undefined {
    const merge = merges.find(item => row >= item.s.r && row <= item.e.r && col >= item.s.c && col <= item.e.c);
    if (!merge) return undefined;
    const originAddress = XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c });
    const origin = sheet[originAddress] as SpreadsheetCell | undefined;
    return origin?.w ?? (origin?.v == null ? undefined : String(origin.v));
  }

  private async extractSpreadsheet(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const ext = path.extname(file.absolutePath).toLowerCase();
    try {
      const XLSX = await resolveAndImport('xlsx') as any;
      const workbook = XLSX.readFile(file.absolutePath, { cellDates: true, cellFormula: true, cellNF: true, cellStyles: true });
      const sheetTexts: string[] = [];
      let cellCount = 0;
      let formulaCount = 0;
      let mergeCount = 0;

      for (const name of workbook.SheetNames) {
        const sheet = workbook.Sheets[name] as SpreadsheetSheet | undefined;
        if (!sheet || !sheet['!ref']) continue;
        const range = XLSX.utils.decode_range(sheet['!ref']);
        const merges = sheet['!merges'] ?? [];
        mergeCount += merges.length;
        const matrix: string[][] = [];
        for (let row = range.s.r; row <= range.e.r; row++) {
          const values: string[] = [];
          for (let col = range.s.c; col <= range.e.c; col++) {
            const address = XLSX.utils.encode_cell({ r: row, c: col });
            const cell = sheet[address] as SpreadsheetCell | undefined;
            const mergedValue = cell ? undefined : this.findMergedCellValue(sheet, merges, row, col, XLSX);
            if (cell) {
              cellCount++;
              if (cell.f) formulaCount++;
            }
            const display = cell?.w ?? String(cell?.v ?? mergedValue ?? '');
            const formula = cell?.f ? ` 公式=${cell.f}` : '';
            values.push(`${display}${formula}`.trim());
          }
          if (values.some(Boolean)) matrix.push(values);
        }
        if (matrix.length > 0) {
          // F1 智能表头行检测：标题行（E.1 分部分项工程量清单计价表）不再被当表头，
          // 真实列名保留（序号/项目编码/项目名称/项目特征描述/计量单位/工程量），多级表头拼接
          const smart = detectSmartTableHeader(matrix);
          const header = smart.headers;
          const titleNote = smart.titleLines.length ? `表标题：${smart.titleLines.join(' ')}` : '';
          // 表格分页：为了防止超大 Excel 导致单块过大，将其每 500 行分为一个独立的 Markdown Table。
          const chunkSize = 500;
          for (let i = smart.headerIndex + 1; i < matrix.length; i += chunkSize) {
            const rows = matrix.slice(i, i + chunkSize);
            const sheetSuffix = matrix.length > chunkSize ? ` (第 ${Math.floor(i/chunkSize) + 1} 部分)` : '';
            const titlePrefix = i === smart.headerIndex + 1 && titleNote ? `｜${titleNote}` : '';
            sheetTexts.push([`工作表：${name}${sheetSuffix}${titlePrefix}`, this.toMarkdownTable(header, rows)].join('\n\n'));
          }
          // F3 KV 展开（对齐 CSV 路径 legacyKv）：数据行「R#C# 列名: 值」全文展开，
          // 保障向量检索可按真实列名召回行级参数；前 400 数据行封顶防超大清单块爆炸
          const kvLimit = 400;
          const dataRows = matrix.slice(smart.headerIndex + 1);
          const kvLines = dataRows.slice(0, kvLimit).flatMap((values, rowIndex) => values.map((value, colIndex) => {
            const column = header[colIndex] || `COL${colIndex + 1}`;
            return `R${rowIndex + 2}C${colIndex + 1} ${column}: ${foldKvCellText(value)}`;
          }));
          if (kvLines.length > 0) {
            sheetTexts.push([`工作表：${name}｜表格路径声明`, ...kvLines, ...(dataRows.length > kvLimit ? [`（KV 展开已截断至前 ${kvLimit} 行，完整数据见上方 Markdown 表格）`] : [])].join('\n'));
          }
        }
      }

      if (sheetTexts.length > 0) {
        return {
          text: sheetTexts.join('\n\n'),
          metadata: { extractionMode: 'builtin_xlsx_structured_cells', vectorizable: true, sheetCount: sheetTexts.length, sheetNames: workbook.SheetNames.slice(0, 120), cellCount, formulaCount, mergeCount, contentCoverage: 'spreadsheet_cells_formulas_merges' },
          warnings: [],
        };
      }
    } catch {
      // xlsx 解析失败：降级到下方统一兜底（按真实文件头判定路径）
    }
    // 扩展名为 .xls 但真实内容是 OpenXML ZIP（常见 Word 文档伪装表格扩展名）：
    // 二进制字符串抽取会把 ZIP 流误读成 GBK 乱码汉字（每个字都不同，可读性过滤无法识别），
    // 必须先按 ZIP 内 XML 解析。
    if (ext === '.xls') {
      if (this.isZipOpenXmlFile(file.absolutePath)) return this.extractZipDisguisedSpreadsheet(file);
      return this.extractLegacyOfficeBinary(file);
    }
    return this.extractOfficeZip(file);
  }

  /**
   * 表格扩展名（.xls/.xlsx）但真实内容为 OpenXML ZIP 的文件：优先按 Word 文档（word/document.xml）
   * 解析，否则退化为 ZIP 内 XML 通用提取。避免把 ZIP 二进制流当字符串抽取产生 GBK 误读乱码。
   */
  private async extractZipDisguisedSpreadsheet(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const warning = `文件扩展名为 ${path.extname(file.absolutePath) || '未知'}，但真实格式为 OpenXML ZIP，已按 ZIP 内 XML 解析`;
    try {
      const docxMarkdown = await this.extractDocxStyleTreeMarkdown(file.absolutePath);
      if (docxMarkdown.trim()) {
        return {
          text: docxMarkdown,
          metadata: { extractionMode: 'docx_xml_style_tree_markdown', vectorizable: true, realOfficeContainer: 'openxml_zip_disguised_spreadsheet' },
          warnings: [warning],
        };
      }
    } catch {
      // 无 word/document.xml 或解析失败：降级为通用 ZIP XML 提取
    }
    const zip = await this.extractOfficeZip(file);
    return { ...zip, warnings: [warning, ...zip.warnings] };
  }

  private async extractDocxStyleTreeMarkdown(filePath: string): Promise<string> {
    const jszipMod = await resolveAndImport('jszip');
    const JSZip = (jszipMod as Record<string, unknown>).default ?? jszipMod;
    const zip = await (JSZip as { loadAsync: (data: Buffer) => Promise<{ files: Record<string, { async: (type: string) => Promise<string> }> }> }).loadAsync(fs.readFileSync(filePath));
    const docXml = await zip.files['word/document.xml']?.async('string');
    if (!docXml) return '';
    
    // 按出现顺序提取 paragraph 和 table（深度配平，见 extractTopLevelOoxmlElements 注释：
    // 非贪婪正则会在段内文本框的内层 </w:p> 处提前收尾，吞掉该段后半正文）
    const elements = extractTopLevelOoxmlElements(docXml);
    const lines: string[] = [];
    let tableIndex = 0;
    
    for (const { tag, xml } of elements) {
      if (tag === 'w:p') {
        const texts = Array.from(xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gu), match => this.stripXml(match[1] ?? '')).join('');
        if (!texts.trim()) continue;
        const style = /<w:pStyle\s+w:val="([^"]+)"/u.exec(xml)?.[1] ?? '';
        const bold = /<w:b\b/u.test(xml);
        const size = Number(/<w:sz\s+w:val="(\d+)"/u.exec(xml)?.[1] ?? 0);
        const level = this.docxHeadingLevel(style, bold, size, texts);
        lines.push(`${level > 0 ? `${'#'.repeat(level)} ` : ''}${texts.trim()}`);
      } else if (tag === 'w:tbl') {
        tableIndex += 1;
        const rows = this.extractDocxTableRows(xml);
        if (rows.length > 0) {
          const maxCols = Math.max(...rows.map(row => row.length), 1);
          rows.forEach(row => { while (row.length < maxCols) row.push(''); });
          // F1 智能表头行检测（与 xlsx/CSV 路径同源）：历史实现取 rows[0] 当表头，
          // 首行非表头（标题行/数据行）时列名沦为上一行数据内容（「表2.R2C2 4.1.9安全耐久…」超长错误列名实锤），
          // 真实列名丢失；检测后标题行降级注释、多级表头拼接，无列关键词表格仍回退 rows[0] 保持历史行为
          const smart = detectSmartTableHeader(rows);
          const header = smart.headers;
          const titleNote = smart.titleLines.length ? `｜表标题：${smart.titleLines.join(' ')}` : '';
          const mdTable = this.toMarkdownTable(header, rows.slice(smart.headerIndex + 1));
          const declarations = rows.slice(smart.headerIndex + 1).flatMap((row, rowIndex) => row.map((value, colIndex) => {
            const column = header[colIndex] || `COL${colIndex + 1}`;
            return `表${tableIndex}.R${rowIndex + 2}C${colIndex + 1} ${column}: ${foldKvCellText(value)}`;
          })).filter(line => !line.endsWith(': '));
          lines.push([`DOCX 表格 ${tableIndex}${titleNote}`, mdTable, '表格路径声明', ...declarations].join('\n'));
        }
      }
    }
    
    return lines.join('\n\n');
  }

  private extractDocxTableRows(tableXml: string): string[][] {
    const activeVMerges = new Map<number, string>();
    return Array.from(tableXml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/gu), match => match[0]).map(tr => {
      const row: string[] = [];
      for (const tc of Array.from(tr.matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/gu), match => match[0])) {
        const gridSpan = Math.max(1, Number(/<w:gridSpan\s+w:val="(\d+)"/u.exec(tc)?.[1] ?? 1));
        const vMerge = /<w:vMerge(?:\s+w:val="([^"]+)")?\s*\/?/u.exec(tc)?.[1] ?? (/<w:vMerge\b/u.test(tc) ? 'continue' : undefined);
        const cellText = this.extractDocxCellText(tc);
        const colIndex = row.length;
        const value = vMerge === 'continue' ? (activeVMerges.get(colIndex) ?? cellText) : cellText;
        if (vMerge === 'restart' || (vMerge && cellText)) activeVMerges.set(colIndex, cellText);
        if (!vMerge) activeVMerges.delete(colIndex);
        for (let index = 0; index < gridSpan; index++) row.push(index === 0 ? value : '');
      }
      return row;
    }).filter(row => row.some(Boolean));
  }

  private extractDocxCellText(cellXml: string): string {
    return Array.from(cellXml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/gu), match => match[0])
      .map(paragraph => Array.from(paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/gu), match => {
        if (match[1] != null) return this.stripXml(match[1]);
        if (match[0].startsWith('<w:tab')) return ' ';
        return '\n';
      }).join('').trim())
      .filter(Boolean)
      .join(' / ')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  private docxHeadingLevel(style: string, bold: boolean, size: number, text: string): number {
    const normalized = style.toLowerCase();
    const heading = /heading(\d)|标题(\d)|h(\d)/iu.exec(normalized);
    const styleLevel = Number(heading?.[1] ?? heading?.[2] ?? heading?.[3] ?? 0);
    if (styleLevel >= 1 && styleLevel <= 6) return styleLevel;
    if (text.length <= 100 && size >= 32) return 1;
    if (text.length <= 100 && size >= 28) return 2;
    if (text.length <= 100 && (size >= 24 || bold)) return 3;
    return 0;
  }

  private async extractOfficeZip(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'office_zip_text', vectorizable: true };
    try {
      const jszipMod = await resolveAndImport('jszip');
      const JSZip = (jszipMod as Record<string, unknown>).default ?? jszipMod;
      const zip = await (JSZip as { loadAsync: (data: Buffer) => Promise<{ files: Record<string, { dir: boolean; name: string; async: (type: string) => Promise<string> }> }> }).loadAsync(fs.readFileSync(file.absolutePath));
      const texts: string[] = [];
      const xmlEntries = Object.values(zip.files).filter(entry => !entry.dir && /\.(xml|rels)$/iu.test(entry.name)).slice(0, 80);
      for (const entry of xmlEntries) {
        const xml = await entry.async('text');
        const stripped = this.stripXml(xml).replace(/\s+/gu, ' ').trim();
        if (stripped) texts.push(`${entry.name}: ${stripped.slice(0, 8_000)}`);
      }
      metadata.entryCount = Object.keys(zip.files).length;
      metadata.contentCoverage = texts.length > 0 ? 'office_zip_xml_text' : 'office_zip_empty_text';
      return { text: texts.join('\n'), metadata, warnings: texts.length ? [] : ['Office/表格/演示文件未提取到正文，未入库'] };
    } catch (error) {
      metadata.extractionMode = 'office_zip_failed';
      metadata.parseError = error instanceof Error ? error.message : String(error);
      metadata.contentCoverage = 'office_zip_failed';
      return { text: '', metadata, warnings: [`Office/表格/演示文件解析失败: ${metadata.parseError}，未入库`] };
    }
  }


  private async extractRasterImage(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'ocr_provider', vectorizable: true };
    const warnings: string[] = [];

    if (process.env.CUSTOMIZE_AGENT_DISABLE_OCR === '1') {
      metadata.extractionMode = 'raster_image_metadata';
      metadata.contentCoverage = 'metadata_filename';
      return { text: this.metadataOnlyText(file), metadata, warnings: ['OCR disabled; indexed image metadata only'] };
    }

    const validationError = this.validateRasterImage(file.absolutePath);
    if (validationError) {
      metadata.contentCoverage = 'invalid_image';
      metadata.parseError = validationError;
      return { text: '', metadata, warnings: [`图片文件无效或不完整：${validationError}，未入库`] };
    }

    const dimensions = await this.readImageDimensions(file.absolutePath);
    if (dimensions) {
      metadata.imageWidth = dimensions.width;
      metadata.imageHeight = dimensions.height;
      if (this.isTooSmallForOcr(dimensions.width, dimensions.height)) {
        metadata.contentCoverage = 'image_too_small_for_ocr';
        return { text: this.metadataOnlyText(file), metadata, warnings: [`图片尺寸过小（${dimensions.width}x${dimensions.height}），已跳过 OCR 并仅索引元数据`] };
      }
    }

    // 1. 尝试外部 PaddleOCR 命令（CUSTOMIZE_PADDLE_OCR_CMD）
    const paddleExternal = await this.tryPaddleOcrLayout(file.absolutePath);
    if (paddleExternal) {
      metadata.contentCoverage = 'paddleocr_layout_regions';
      metadata.ocrProvider = 'paddleocr-external';
      metadata.ocrRegionCount = paddleExternal.regionCount;
      return { text: [this.metadataOnlyText(file), paddleExternal.text].join('\n'), metadata, warnings };
    }

    // 2. 加载图片像素数据
    let imageData: { data: Uint8Array; width: number; height: number; channels: number };
    try {
      imageData = await this.loadImagePixels(file.absolutePath);
      metadata.imageWidth = imageData.width;
      metadata.imageHeight = imageData.height;
      if (this.isTooSmallForOcr(imageData.width, imageData.height)) {
        metadata.contentCoverage = 'image_too_small_for_ocr';
        return { text: this.metadataOnlyText(file), metadata, warnings: [`图片尺寸过小（${imageData.width}x${imageData.height}），已跳过 OCR 并仅索引元数据`] };
      }
    } catch (e) {
      metadata.contentCoverage = 'image_decode_failed';
      metadata.parseError = (e as Error).message;
      return { text: '', metadata, warnings: [`图片解码失败：${(e as Error).message}，未入库`] };
    }

    // 3. OCR Provider（PaddleOCR ONNX → Tesseract CLI → Tesseract.js）
    let provider: OcrProvider | null = null;
    try {
      provider = await createOcrProvider();
      metadata.ocrProvider = provider.id;
      warnings.push(...this.ocrProviderWarnings(provider));

      const ocrResult = await this.recognizeRasterImage(provider, imageData, metadata, warnings);
      const text = ocrResult.text.trim();

      if (text) {
        metadata.contentCoverage = 'ocr_provider_text';
        metadata.ocrTextLength = text.length;
        metadata.ocrConfidence = ocrResult.confidence;
        metadata.ocrRegionCount = ocrResult.regions.length;

        const regionLines = ocrResult.regions.map((r, i) =>
          `区域 ${i + 1} [置信度 ${r.confidence.toFixed(2)}] [bbox x0=${r.box.x}, y0=${r.box.y}, x1=${r.box.x + r.box.width}, y1=${r.box.y + r.box.height}]: ${r.text}`,
        );

        return {
          text: [this.metadataOnlyText(file), 'OCR 区域文本:', ...regionLines, `OCR 完整文本:\n${text}`].join('\n'),
          metadata,
          warnings,
        };
      }

      metadata.contentCoverage = 'ocr_no_text';
      warnings.push(`${metadata.ocrProvider} 未识别到文字，未生成可检索文本切片`);
      return { text: '', metadata, warnings };
    } catch (e) {
      metadata.contentCoverage = 'ocr_failed';
      metadata.parseError = (e as Error).message;
      warnings.push(`OCR 识别失败（${metadata.ocrProvider ?? 'unknown'}）：${(e as Error).message}，未入库`);
      return { text: '', metadata, warnings };
    } finally {
      await provider?.dispose();
    }
  }

  private async tryPaddleOcrLayout(filePath: string): Promise<{ text: string; regionCount: number } | undefined> {
    const command = process.env.CUSTOMIZE_PADDLE_OCR_CMD || process.env.PADDLE_OCR_CMD;
    if (!command) return undefined;
    const result = spawnSync(command, [filePath], { encoding: 'utf8', timeout: 0, maxBuffer: 50 * 1024 * 1024, shell: true });
    const stdout = this.filterOcrNativeNoise(result.stdout || '');
    if (result.status !== 0 || !stdout.trim()) return undefined;
    try {
      const parsed = JSON.parse(stdout) as Array<{ type?: string; text?: string; bbox?: unknown }>;
      const lines = parsed.map((region, index) => `区域 ${index + 1} [${region.type ?? 'text'}] ${this.formatBoundingBox(region.bbox)}: ${region.text ?? ''}`);
      return { text: ['OCR 版面分析区域:', ...lines].join('\n'), regionCount: lines.length };
    } catch {
      const lines = stdout.split(/\r?\n/u).filter(Boolean);
      return { text: ['OCR 版面分析区域:', ...lines].join('\n'), regionCount: lines.length };
    }
  }

  /** PDF 页渲染图的外部引擎识别（仅取纯文本行，不带版面前缀）；未配置或失败返回 undefined */
  private async tryPaddleOcrPageText(imgPath: string): Promise<string | undefined> {
    const command = process.env.CUSTOMIZE_PADDLE_OCR_CMD || process.env.PADDLE_OCR_CMD;
    if (!command) return undefined;
    const result = spawnSync(command, [imgPath], { encoding: 'utf8', timeout: 0, maxBuffer: 50 * 1024 * 1024, shell: true });
    const stdout = this.filterOcrNativeNoise(result.stdout || '');
    if (result.status !== 0 || !stdout.trim()) return undefined;
    try {
      const parsed = JSON.parse(stdout) as Array<{ text?: string }>;
      const text = parsed.map(item => item.text ?? '').filter(Boolean).join('\n');
      return text.trim() || undefined;
    } catch {
      return stdout.trim() || undefined;
    }
  }

  private filterOcrNativeNoise(value: string): string {
    return value.split(/\r?\n/u).map(line => line.trim()).filter(line => line && !OCR_NATIVE_NOISE_PATTERNS.some(pattern => pattern.test(line))).join('\n');
  }

  private formatBoundingBox(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    const x0 = record.x0 ?? record.left ?? record.x;
    const y0 = record.y0 ?? record.top ?? record.y;
    const x1 = record.x1 ?? record.right;
    const y1 = record.y1 ?? record.bottom;
    return [x0, y0, x1, y1].some(item => item != null) ? `[bbox x0=${x0 ?? ''}, y0=${y0 ?? ''}, x1=${x1 ?? ''}, y1=${y1 ?? ''}]` : '';
  }

  private validateRasterImage(filePath: string): string | undefined {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 12) return '文件过小，无法识别图片头';

    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return buffer.includes(Buffer.from([0x49, 0x45, 0x4e, 0x44])) ? undefined : 'PNG 缺少 IEND 结束块';
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      return buffer.length > 4 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9 ? undefined : 'JPEG 缺少 EOI 结束标记';
    }

    const header = buffer.subarray(0, 12).toString('ascii');
    if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
      return buffer[buffer.length - 1] === 0x3b ? undefined : 'GIF 缺少 trailer 结束标记';
    }

    if (header.startsWith('RIFF') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      const expectedSize = buffer.readUInt32LE(4) + 8;
      return buffer.length >= expectedSize ? undefined : 'WebP 文件长度小于 RIFF 声明长度';
    }

    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      const expectedSize = buffer.readUInt32LE(2);
      return buffer.length >= expectedSize ? undefined : 'BMP 文件长度小于头部声明长度';
    }

    return undefined;
  }

  private async extractPdf(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = { extractionMode: 'pdf_text_first', vectorizable: true };
    const warnings: string[] = [];

    try {
      const raw = fs.readFileSync(file.absolutePath);
      const { text: pdfLayerText, garbledPages, emptyGraphicPages, sheetPages, pageCount } = await this.extractPdfText(raw);
      let text = pdfLayerText;
      // 图纸页与乱码页/空图形页同等对待：三者都是「文本层不可信但正文可取」的形态。
      // 并入后：文本层整体不足时走全页 OCR；整体尚可时走选择性 OCR 只补这些页
      const ocrCandidatePages = [...new Set([...garbledPages, ...emptyGraphicPages, ...sheetPages])].sort((a, b) => a - b);
      // 先判定文本层是否可用（页均密度门槛会把“只有图框文字的图纸 PDF”判为不足）；
      // 文本层不足时直接走全页 hybrid OCR，跳过乱码页单独 OCR：
      // 既避免重复 OCR，也避免“garbled provider A dispose 后 hybrid provider B 再建”的双 provider 序列
      // 触发 onnxruntime GC 析构竞态（实测导致 SIGABRT）。
      if (this.hasUsablePdfText(text, pageCount) && ocrCandidatePages.length > 0) {
        metadata.garbledTextLayerPages = garbledPages;
        if (emptyGraphicPages.length > 0) metadata.emptyTextLayerPages = emptyGraphicPages;
        const ocr = await this.extractPdfGarbledPagesOcr(file, ocrCandidatePages);
        if (ocr.pageTexts.length > 0) {
          text = this.mergePdfOcrPages(text, ocr.pageTexts);
          metadata.ocrAugmentedPages = ocr.pageTexts.map(page => page.page);
          metadata.contentCoverage = 'pdf_text_streams_layout_markdown_with_page_ocr';
        }
        warnings.push(`PDF 第 ${garbledPages.join('、')} 页文本层为 CID 字体乱码（缺 ToUnicode 映射），已剔除${ocr.pageTexts.length > 0 ? '并改用 OCR' : '，OCR 替换未成功'}`);
        if (emptyGraphicPages.length > 0) warnings.push(`PDF 第 ${emptyGraphicPages.join('、')} 页文本层为空但页面含图形内容，已尝试 OCR 补提`);
        warnings.push(...ocr.warnings);
      } else if (ocrCandidatePages.length > 0 && !this.hasUsablePdfText(text, pageCount)) {
        metadata.garbledTextLayerPages = garbledPages;
        if (emptyGraphicPages.length > 0) metadata.emptyTextLayerPages = emptyGraphicPages;
        warnings.push(`PDF 第 ${ocrCandidatePages.join('、')} 页文本层不可用（乱码或空白图形页），文本层整体不足，改由全页 OCR 覆盖`);
      }
      if (this.hasUsablePdfText(text, pageCount)) {
        metadata.contentCoverage = metadata.contentCoverage ?? 'pdf_text_streams_layout_markdown';
        metadata.pdfExtractor = 'pdfjs-dist';
        metadata.ocrSkippedReason = 'pdf_text_stream_quality_sufficient';
        return { text: [this.metadataOnlyText(file), this.toMarkdownDocument(text)].join('\n\n'), metadata, warnings };
      }
      if (text.trim()) warnings.push('PDF 文本层质量不足，已尝试选择性 OCR 增强');
    } catch (error) {
      warnings.push(`PDF 文本提取失败: ${error instanceof Error ? error.message : String(error)}`);
      metadata.parseError = error instanceof Error ? error.message : String(error);
    }

    const hybrid = await this.extractPdfHybridPages(file);
    if (hybrid.text.trim()) return { text: hybrid.text, metadata: { ...metadata, ...hybrid.metadata }, warnings: [...warnings, ...hybrid.warnings] };

    metadata.extractionMode = 'pdf_metadata_only';
    metadata.contentCoverage = 'metadata_filename';
    metadata.ocrRecommended = true;
    metadata.ocrReason = hybrid.metadata.ocrReason ?? 'pdf_text_stream_empty_or_unavailable';
    metadata.pdfPageOcrSupported = true;
    return {
      text: this.metadataOnlyText(file),
      metadata,
      warnings: [...warnings, ...hybrid.warnings, 'PDF 正文暂未提取到文本，已索引文件名、路径和类型元数据'],
    };
  }

  /**
   * 对文本层乱码页做选择性 OCR（CID 字体缺 ToUnicode 映射时 pdfjs 输出外来文字乱码）。
   * 只渲染并识别指定页码，避免对整本 PDF 做全量 OCR。
   */
  private async extractPdfGarbledPagesOcr(file: ClassifiedFile, pageNumbers: number[]): Promise<{ pageTexts: Array<{ page: number; text: string }>; warnings: string[] }> {
    const warnings: string[] = [];
    const pageTexts: Array<{ page: number; text: string }> = [];
    const tmpDir = fs.mkdtempSync(path.join(this.getTempRoot(), 'kb-pdf-garbled-'));
    try {
      const dpi = this.getPdfOcrDpi();
      let images = this.tryRenderWithPyMuPDF(file.absolutePath, tmpDir, dpi, pageNumbers);
      if (!images) images = await this.tryRenderWithPdfJs(file, tmpDir);
      if (!images || images.length === 0) {
        warnings.push('PDF 乱码页 OCR 渲染失败（PyMuPDF 与 pdfjs 均不可用），乱码页文本已剔除');
        return { pageTexts, warnings };
      }
      let provider: OcrProvider | null = null;
      const pageGeometry = this.readPdfPageGeometry(tmpDir);
      const tiledPages = new Set<number>();
      try {
        for (const pageNo of pageNumbers) {
          const imgPath = images[pageNo - 1];
          if (!imgPath) continue;
          try {
            const dimensions = await this.readImageDimensions(imgPath);
            if (!dimensions || this.isTooSmallForOcr(dimensions.width, dimensions.height)) {
              warnings.push(`PDF 第 ${pageNo} 页渲染图尺寸过小，OCR 已跳过`);
              continue;
            }
            // 外部引擎优先（CUSTOMIZE_PADDLE_OCR_CMD 配置时），失败回退内置 provider（PP-OCRv6 ONNX → tesseract）
            const externalText = await this.tryPaddleOcrPageText(imgPath);
            let ocrText: string;
            if (externalText) {
              ocrText = this.cleanOcrText(externalText);
            } else {
              if (!provider) {
                provider = await createOcrProvider();
                warnings.push(...this.ocrProviderWarnings(provider));
              }
              const tiled = await this.recognizePdfPageOcr({
                provider, imgPath, dimensions,
                pageSizeMm: pageGeometry?.get(pageNo),
                warnings,
              });
              // 切片页的有效行占比天然低于正文页（离散标注多），把整页门槛放宽到 0.4，
              // 否则切片提召回反而会让图纸页在质量门槛上被整页丢弃
              tiledPages.add(pageNo);
              ocrText = this.cleanOcrText(tiled.result.text);
              if (tiled.result.warnings?.length) warnings.push(...tiled.result.warnings.map(item => `OCR 警告: ${item}`));
            }
            if (ocrText) {
              // 页级最低质量门槛：纯图形页（图纸图框、LOGO 页）OCR 产物为零散噪声碎片，
              // 汉字过少、文本过短或有效行占比过低时整页丢弃，避免“伪文本”噪声入库
              const hanCount = (ocrText.match(/[\p{Script=Han}]/gu) ?? []).length;
              const minLineRatio = tiledPages.has(pageNo) ? 0.4 : 0.5;
              if (hanCount >= 4 && this.normalizedTextLength(ocrText) >= 12 && this.ocrMeaningfulLineRatio(ocrText) >= minLineRatio) pageTexts.push({ page: pageNo, text: ocrText });
              else warnings.push(`PDF 第 ${pageNo} 页 OCR 结果均为图形噪声或无有效文字，已丢弃`);
            } else {
              warnings.push(`PDF 第 ${pageNo} 页 OCR 未识别到文字`);
            }
          } catch (error) {
            warnings.push(`PDF 第 ${pageNo} 页 OCR 失败: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } finally {
        if (provider) await provider.dispose();
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
    }
    return { pageTexts, warnings };
  }

  /** 将 OCR 页文本按页码合并回文本层输出（乱码页已在 extractPdfText 中被剔除，OCR 页补齐缺口） */
  private mergePdfOcrPages(text: string, ocrPages: Array<{ page: number; text: string }>): string {
    const ocrByPage = new Map(ocrPages.map(page => [page.page, page.text]));
    const sections: Array<{ page: number; text: string }> = [];
    let currentPage = 0;
    let buffer: string[] = [];
    const flush = (): void => {
      const body = buffer.join('\n').trim();
      if (currentPage > 0 && body) sections.push({ page: currentPage, text: body });
      buffer = [];
    };
    for (const line of text.split('\n')) {
      const match = line.match(/^## PDF 第 (\d+) 页/);
      if (match) {
        flush();
        currentPage = Number(match[1]);
      } else {
        buffer.push(line);
      }
    }
    flush();
    for (const [page, ocrText] of ocrByPage) sections.push({ page, text: ocrText });
    sections.sort((a, b) => a.page - b.page);
    return sections
      .map(section => `## PDF 第 ${section.page} 页${ocrByPage.has(section.page) ? '（OCR）' : ''}\n\n${section.text}`)
      .join('\n\n');
  }

  private hasUsablePdfText(text: string, pageCount?: number): boolean {
    const normalized = text.replace(/\s+/gu, ' ').trim();
    if (normalized.length < Number(process.env.CUSTOMIZE_KB_PDF_TEXT_MIN_CHARS || 80)) return false;
    // G 线 P0-11（修正上一轮修复的副作用）：图纸页判定**不得**在文档级否定整份文本层。
    // 此前此处为 `sheetPageCount * 2 >= pageCount → return false`，后果是：招标文件常附大量
    // 图纸页，一旦图纸页过半，**整本**被判无可用文本层 → 走全页 OCR，已带文本层的页也要重 OCR
    // 一遍，丢字、丢表结构、丢数字精度（工程量与标高最怕 OCR 错字）。
    // 现口径改为**页级**：图纸页由 isSparseTextSheetPage 逐页识别并进入 ocrCandidatePages，
    // 在文本层整体可用的分支里做**选择性 OCR**（有文本层的页直接用，只 OCR 图纸页/乱码页/空图形页）。
    // CAD 导出图纸 PDF 的文本层只有图框/标题栏零星文字（正文为矢量线），多页文档页均密度极低；
    // 这种情况不能算“文本层足够”，否则整本图纸只有几百字符入库、正文全部丢失。
    // 阈值：多页（>1 页）且页均 < 100 可见字符时判不足，转入 hybrid OCR 路径（正常文档页均数百到上千字符不受影响）。
    if (pageCount && pageCount > 1) {
      const perPageChars = normalized.replace(/\s+/gu, '').length / pageCount;
      if (perPageChars < 100) return false;
    }
    const replacementRatio = (normalized.match(/[\uFFFD�]/gu)?.length ?? 0) / normalized.length;
    const visibleRatio = (normalized.match(/[\p{L}\p{N}\p{Script=Han}]/gu)?.length ?? 0) / normalized.length;
    return replacementRatio < 0.02 && visibleRatio > 0.35;
  }


  private async extractPdfHybridPages(file: ClassifiedFile): Promise<{ text: string; metadata: Record<string, unknown>; warnings: string[] }> {
    const metadata: Record<string, unknown> = {
      extractionMode: 'pdf_hybrid_pages',
      vectorizable: true,
      contentCoverage: 'pdf_page_text_plus_selective_ocr',
    };
    const warnings: string[] = [];

    // OCR Provider
    let ocrProvider: OcrProvider | null | undefined = null;
    const getOcrProvider = async (): Promise<OcrProvider> => {
      if (!ocrProvider) {
        ocrProvider = await createOcrProvider();
        warnings.push(...this.ocrProviderWarnings(ocrProvider));
      }
      return ocrProvider;
    };

    const failedPages: Array<{ page: number; reason: string }> = [];
    const ocrPages: number[] = [];
    const ocrRetryPages: number[] = [];
    const ocrStrategies: Array<{ page: number; strategy: string; score: number }> = [];

    // 尝试 PyMuPDF 渲染（默认 200 DPI），低质量页自动升到 300 DPI 重试
    let pageImages: string[] | null;
    let highDpiImages: string[] | null = null;
    let pageCount = 0;
    let renderer = 'unknown';
    const initialDpi = this.getPdfOcrDpi();
    const retryDpi = this.getPdfOcrRetryDpi(initialDpi);
    const tmpDir = fs.mkdtempSync(path.join(this.getTempRoot(), 'kb-pdf-'));
    metadata.pdfOcrInitialDpi = initialDpi;
    if (retryDpi > initialDpi) metadata.pdfOcrRetryDpi = retryDpi;

    const getHighDpiImage = (pageIndex: number): { imagePath: string; strategy: string } | undefined => {
      if (retryDpi <= initialDpi) return undefined;
      if (!highDpiImages) {
        const retryDir = path.join(tmpDir, `retry-${retryDpi}dpi`);
        fs.mkdirSync(retryDir, { recursive: true });
        highDpiImages = this.tryRenderWithPyMuPDF(file.absolutePath, retryDir, retryDpi);
        if (!highDpiImages?.length) warnings.push(`PDF 高质量 OCR 重试渲染失败（${retryDpi} DPI）`);
      }
      const imagePath = highDpiImages?.[pageIndex];
      return imagePath ? { imagePath, strategy: `PyMuPDF-${retryDpi}dpi` } : undefined;
    };

    try {
      // ── 方法1: PyMuPDF（默认 200 DPI，低质量页再自适应升到 300 DPI） ──
      pageImages = this.tryRenderWithPyMuPDF(file.absolutePath, tmpDir, initialDpi);
      if (pageImages && pageImages.length > 0) {
        renderer = `PyMuPDF-${initialDpi}dpi`;
        pageCount = pageImages.length;
      } else {
        // ── 方法2: pdfjs-dist + canvas ──
        const jsImages = await this.tryRenderWithPdfJs(file, tmpDir);
        if (jsImages && jsImages.length > 0) {
          renderer = 'pdfjs-dist';
          pageCount = jsImages.length;
          pageImages = jsImages;
        }
      }
    } catch (e) {
      metadata.ocrRecommended = true;
      metadata.ocrReason = `PDF 渲染失败: ${(e as Error).message}`;
      return { text: '', metadata, warnings: [`PDF 渲染失败：${metadata.ocrReason}`] };
    }

    metadata.pdfPageCount = pageCount;
    metadata.pdfRenderer = renderer;

    if (!pageImages || pageImages.length === 0) {
      metadata.ocrRecommended = true;
      metadata.ocrReason = '无法渲染PDF页面';
      return { text: '', metadata, warnings: ['无法渲染PDF页面'] };
    }

    // 逐页 OCR
    const pageTexts: string[] = [];
    // 页面几何取自渲染 sidecar（pt/mm）；缺失时切片判定退回按 DPI 折算像素尺寸
    const pageGeometry = this.readPdfPageGeometry(tmpDir);
    const tiledPages: number[] = [];
    const tileCounts: number[] = [];
    let cachedPageHits = 0; // W7 页级缓存命中数（元数据可观测）
    for (let i = 0; i < pageImages.length; i++) {
      const imgPath = pageImages[i]!;
      try {
        const dimensions = await this.readImageDimensions(imgPath);
        if (!dimensions) {
          failedPages.push({ page: i + 1, reason: 'image_dimensions_unavailable' });
          warnings.push(`PDF 第 ${i + 1} 页渲染图片无法读取尺寸，已跳过 OCR`);
          continue;
        }
        if (this.isTooSmallForOcr(dimensions.width, dimensions.height)) {
          failedPages.push({ page: i + 1, reason: `image_too_small_for_ocr_${dimensions.width}x${dimensions.height}` });
          warnings.push(`PDF 第 ${i + 1} 页渲染图片尺寸过小（${dimensions.width}x${dimensions.height}），已跳过 OCR`);
          continue;
        }
        // W7 断点续跑：页级缓存命中即跳过本页全部 OCR（含 300 DPI 重试），结果与未命中路径一致。
        // 动机：531 页图纸 OCR 约 90 分钟且此前为整文件原子——中断即全损（实测已发生过 OOM 丢库）；
        // 命中路径同时让「解析器版本升级后的重解析」只重跑真正变化的页。
        const cachedPage = this.readCachedPageOcr(file, i + 1, initialDpi);
        if (cachedPage) {
          cachedPageHits += 1;
          if (cachedPage.tiled) { tiledPages.push(i + 1); tileCounts.push(cachedPage.tiles); }
          if (cachedPage.text) {
            ocrPages.push(i + 1);
            ocrStrategies.push({ page: i + 1, strategy: cachedPage.strategy, score: cachedPage.score });
            pageTexts.push(`## PDF 第 ${i + 1} 页（OCR）\n\n${cachedPage.text}`);
            if (cachedPage.tiled && this.normalizedTextLength(cachedPage.text) < 12) {
              warnings.push(`PDF 第 ${i + 1} 页为大版面条图，分块 OCR 后仅 ${this.normalizedTextLength(cachedPage.text)} 个有效字符，建议确认该图纸是否本身无文字标注`);
            }
          } else {
            failedPages.push({ page: i + 1, reason: 'empty_ocr' });
          }
          continue;
        }
        // 外部引擎优先（CUSTOMIZE_PADDLE_OCR_CMD 配置时），失败回退内置 provider（PP-OCRv6 ONNX → tesseract）
        const externalText = await this.tryPaddleOcrPageText(imgPath);
        let ocrText: string;
        let ocrScore: number;
        let strategy = renderer;
        if (externalText) {
          ocrText = this.cleanOcrText(externalText);
          ocrScore = this.scoreOcrText(ocrText);
          strategy = 'paddleocr-external';
        } else {
          const provider = await getOcrProvider();
          // 大幅面页切片识别（块内不缩放，小字标注不再被检测网络压缩掉）
          const tiled = await this.recognizePdfPageOcr({
            provider, imgPath, dimensions,
            pageSizeMm: pageGeometry?.get(i + 1),
            warnings,
          });
          const ocrResult = tiled.result;
          if (tiled.tiled) {
            tiledPages.push(i + 1);
            tileCounts.push(tiled.tiles);
            strategy = `paddleocr-tiled(${tiled.tiles})`;
          }
          ocrText = this.cleanOcrText(ocrResult.text);
          ocrScore = this.scoreOcrText(ocrText);
          if (ocrResult.warnings?.length) warnings.push(...ocrResult.warnings.map(item => `OCR 警告: ${item}`));
          // 切片页跳过高 DPI 重试：切片已在原生分辨率上检测，再升 DPI 只会让切片数翻倍
          if (tiled.tiled && tiled.tilesFailed === tiled.tiles) {
            failedPages.push({ page: i + 1, reason: 'all_tiles_failed' });
            warnings.push(`PDF 第 ${i + 1} 页切片 OCR 全部失败，该页无文本产出`);
          }
          if (!tiled.tiled && this.shouldRetryPdfOcrAtHigherDpi(ocrText, ocrScore)) {
            const retry = getHighDpiImage(i);
            if (retry) {
              const retryDimensions = await this.readImageDimensions(retry.imagePath);
              if (retryDimensions && !this.isTooSmallForOcr(retryDimensions.width, retryDimensions.height)) {
                const retryResult = await provider.recognize({
                  data: new Uint8Array(0),
                  width: retryDimensions.width, height: retryDimensions.height, channels: 0,
                  filePath: retry.imagePath,
                });
                const retryText = this.cleanOcrText(retryResult.text);
                const retryScore = this.scoreOcrText(retryText);
                if (retryResult.warnings?.length) warnings.push(...retryResult.warnings.map(item => `OCR 重试警告: ${item}`));
                if (retryScore > ocrScore || (!ocrText && retryText)) {
                  ocrText = retryText;
                  ocrScore = retryScore;
                  strategy = retry.strategy;
                  ocrRetryPages.push(i + 1);
                }
              }
            }
          }
        }

        // W7：本页最终结果写缓存（含空结果——空也是确定结论，避免重跑再判空）
        this.writeCachedPageOcr(file, i + 1, initialDpi, { text: ocrText, score: ocrScore, strategy, tiled: tiledPages.includes(i + 1), tiles: tileCounts[tiledPages.indexOf(i + 1)] || 0 });
        if (ocrText) {
          ocrPages.push(i + 1);
          ocrStrategies.push({ page: i + 1, strategy, score: ocrScore });
          pageTexts.push(`## PDF 第 ${i + 1} 页（OCR）\n\n${ocrText}`);
          // 大幅面页切片后仍近乎无产出 —— 显式告警，避免用户只拿到一个空壳结果
          if (tiledPages.includes(i + 1) && this.normalizedTextLength(ocrText) < 12) {
            warnings.push(`PDF 第 ${i + 1} 页为大版面条图，分块 OCR 后仅 ${this.normalizedTextLength(ocrText)} 个有效字符，建议确认该图纸是否本身无文字标注`);
          }
        } else {
          failedPages.push({ page: i + 1, reason: 'empty_ocr' });
        }
      } catch (error) {
        failedPages.push({ page: i + 1, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    if (ocrProvider) await (ocrProvider as OcrProvider).dispose();

    // 清理临时文件
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { warnings.push('PDF OCR 临时文件清理失败'); }

    metadata.ocrAugmented = ocrPages.length > 0;
    metadata.ocrPages = ocrPages;
    metadata.ocrRetryPages = ocrRetryPages;
    metadata.ocrStrategies = ocrStrategies;
    metadata.failedPages = failedPages;
    if (tiledPages.length > 0) {
      metadata.pdfOcrTiledPages = tiledPages;
      metadata.pdfOcrTileCounts = tileCounts;
    }
    const usedStrategies = ocrStrategies.map(item => item.strategy);
    const builtinId = (ocrProvider as OcrProvider | null)?.id ?? 'unknown';
    metadata.ocrProvider = usedStrategies.includes('paddleocr-external')
      ? (usedStrategies.every(strategy => strategy === 'paddleocr-external') ? 'paddleocr-external' : `paddleocr-external + ${builtinId}`)
      : builtinId;

    if (failedPages.length > 0) {
      warnings.push(`PDF 部分页解析失败: ${failedPages.map((p) => `${p.page}:${p.reason}`).join('; ')}`);
    }

    // W7 断点续跑可观测：命中数 = 本次跳过 OCR 的页数（重启续跑时等于已完成页数）
    if (cachedPageHits > 0) metadata.pdfOcrCachedPages = cachedPageHits;
    const combined = pageTexts.join('\n\n').trim();
    return {
      text: combined ? [this.metadataOnlyText(file), combined].join('\n\n') : '',
      metadata,
      warnings,
    };
  }

  /**
   * 查找可用的 python 解释器（必须能 import fitz，即 PyMuPDF）。
   * 服务器 PATH 中的 python3 可能未安装 PyMuPDF，导致渲染静默降级到 pdfjs（低质量图 → OCR 碎片），
   * 因此按候选列表逐个探测，返回第一个可用的解释器路径。
   */
  private findPyMuPDFInterpreter(): string | null {
    const candidates = [
      process.env.CUSTOMIZE_KB_PYMUPDF_PYTHON,
      '/usr/bin/python3',
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      'python3',
    ].filter((candidate): candidate is string => !!candidate);
    for (const candidate of candidates) {
      try {
        const probe = spawnSync(candidate, ['-c', 'import fitz'], { encoding: 'utf-8', timeout: 15_000 });
        if (probe.status === 0) return candidate;
      } catch {
        // 继续探测下一个候选
      }
    }
    return null;
  }

  /** PyMuPDF 渲染（默认 200 DPI，低质量页可自适应提高）；pages 指定时只渲染这些页码 */
  private tryRenderWithPyMuPDF(pdfPath: string, outputDir: string, dpi = this.getPdfOcrDpi(), pages?: number[]): string[] | null {
    try {
      const python = this.findPyMuPDFInterpreter();
      if (!python) return null;
      const workerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'render_pdf_pages.py');
      const args = [workerScript, pdfPath, outputDir, String(dpi)];
      if (pages?.length) args.push(pages.join(','));
      // 上限治理 · 内存：渲染超时**按文件规模自适应**，不再是写死的 60 秒。
      // 实测缺陷：531 页 / 183MB 的施工图 PDF，PyMuPDF 渲染需 135 秒 —— 60 秒超时把成功路径掐断，
      // 于是降级到进程内的 pdfjs（逐页 4× 渲染），在 Node 堆里直接 OOM/SIGABRT，**整个索引任务失败**。
      // 一个写死的超时不该把「本可完成」变成「硬崩溃」。
      const sizeMb = Math.max(1, Math.floor(fs.statSync(pdfPath).size / 1024 / 1024));
      const renderTimeoutMs = Math.min(30 * 60_000, Math.max(60_000, sizeMb * 3000));
      spawnSync(python, args, {
        encoding: 'utf-8', timeout: renderTimeoutMs, maxBuffer: 1024 * 1024,
      });
      // 检查输出文件（即使 Python 非零退出码也可能已渲染部分页面）
      const images: string[] = [];
      if (pages?.length) {
        // 指定页码模式：按页码位置收集（稀疏数组），调用方用 images[page-1] 取值
        for (const pageNo of pages) {
          const p = path.join(outputDir, `page-${pageNo}.png`);
          if (fs.existsSync(p) && fs.statSync(p).size > 100) images[pageNo - 1] = p;
        }
        return images.some(Boolean) ? images : null;
      }
      for (let i = 1; i <= 999; i++) {
        const p = path.join(outputDir, `page-${i}.png`);
        if (fs.existsSync(p) && fs.statSync(p).size > 100) images.push(p);
        else break;
      }
      return images.length > 0 ? images : null;
    } catch {
      return null;
    }
  }

  /** pdfjs-dist + canvas 渲染（降级方案） */
  private async tryRenderWithPdfJs(file: ClassifiedFile, outputDir: string): Promise<string[] | null> {
    try {
      const canvasMod: any = await resolveAndImport('@napi-rs/canvas');
      const pdfjsLib: any = await resolveAndImport('pdfjs-dist/legacy/build/pdf.mjs');
      const sharpMod = await resolveAndImport('sharp');
      const createCanvas = (canvasMod as any).createCanvas ?? (canvasMod as any).default?.createCanvas;
      const sharpFn = (sharpMod as any).default ?? sharpMod;
      if (!createCanvas || !sharpFn) return null;

      const raw = fs.readFileSync(file.absolutePath);
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(raw), verbosity: 0 }).promise;
      const pageCount = doc.numPages;
      // 上限治理 · 内存：**拒绝而非崩溃**。进程内渲染的页数×像素成本会线性吃满堆
      //（实测 531 页图纸在 6GB 堆下仍 SIGABRT）。超过阈值时显式返回 null 并告警，
      // 让上层按「渲染不可用」处理——比让整个索引任务崩掉、库被删到一半好得多。
      const MAX_IN_PROCESS_RENDER_PAGES = 120;
      if (pageCount > MAX_IN_PROCESS_RENDER_PAGES) {
        console.warn(`[extract] PDF 页数 ${pageCount} 超过进程内渲染上限 ${MAX_IN_PROCESS_RENDER_PAGES}，跳过 pdfjs 降级渲染（请确保 PyMuPDF 可用，否则该文件未 OCR）`);
        await doc.destroy();
        return null;
      }
      const images: string[] = [];
      const geometry: Array<{ page: number; widthMm: number; heightMm: number }> = [];
      /**
       * 渲染倍率**按像素上限自适应**（上限治理 · 内存）。
       *
       * 实测缺陷：固定 `renderScale = 4` 在大幅面工程图纸上会把 A1 页渲染成约 9500×6700 px
       * ⇒ 单页 canvas ≈257MB（+PNG 缓冲 + sharp 中间态），叠加整份 PDF（183MB 读入后再复制一份
       * 给 pdfjs）与 pdfjs 文档结构，**解析单份图纸 PDF 峰值 >9GB 后 SIGABRT**
       *（实测 RSS 3.0 → 7.45 → 8.92GB）。大图纸是工程项目的常态输入，不是异常。
       *
       * 现口径：倍率取「默认 4×」与「单页像素不超 MAX_RENDER_PIXELS」两者的较小值，
       * 且不低于 1×（再低 OCR 会失去可读性）。大幅面页自动降到能容纳的倍率，
       * 小页面仍享受 4× 清晰度——**不是一刀切降精度**。
       */
      const MAX_RENDER_PIXELS = 40_000_000; // ≈ 40MP/页（约 160MB/页 canvas），与 OCR 可读性折中
      const defaultRenderScale = 4;

      for (let i = 1; i <= pageCount; i++) {
        const page = await doc.getPage(i);
        const unit = page.getViewport({ scale: 1 });
        const pixelsAtDefault = unit.width * unit.height * defaultRenderScale * defaultRenderScale;
        const renderScale = pixelsAtDefault > MAX_RENDER_PIXELS
          ? Math.max(1, defaultRenderScale * Math.sqrt(MAX_RENDER_PIXELS / pixelsAtDefault))
          : defaultRenderScale;
        const viewport = page.getViewport({ scale: renderScale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        const pngPath = path.join(outputDir, `page-${i}.png`);
        await sharpFn(canvas.toBuffer('image/png'))
          .removeAlpha().normalize().linear(3.0, -150)
          .withMetadata({ density: 288 }).png().toFile(pngPath);
        images.push(pngPath);
        // 内存治理：每页显式释放（canvas 的像素缓冲与 pdfjs 页资源都不等 GC —— 大页面上
        // 一次 GC 延迟就足以把峰值推过堆上限；实测崩溃点正是「逐页渲染、不释放」）
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
        // scale=1 的 viewport 是页面 pt 尺寸（1pt = 1/72 inch），与 PyMuPDF 侧口径一致
        // （用上面已取的 unit，避免重复调用 getViewport）
        geometry.push({
          page: i,
          widthMm: (unit.width * 25.4) / 72,
          heightMm: (unit.height * 25.4) / 72,
        });
      }
      // 名义渲染 DPI 记录为默认倍率：逐页 mm 尺寸由 scale=1 精确给出（与倍率无关），
      // 大幅面页按像素上限降倍率后几何仍精确，故此处只作缺失时的折算兜底值。
      this.writePageGeometry(outputDir, 'pdfjs-dist', defaultRenderScale * 72, geometry);
      await doc.destroy();
      return images.length > 0 ? images : null;
    } catch { return null; }
  }

  /** 写出页面几何 sidecar，供大幅面切片判定使用（写入失败不影响渲染主流程） */
  private writePageGeometry(outputDir: string, renderer: string, dpi: number, pages: Array<{ page: number; widthMm: number; heightMm: number }>): void {
    if (pages.length === 0) return;
    try {
      fs.writeFileSync(
        path.join(outputDir, PAGE_GEOMETRY_FILE),
        JSON.stringify({ renderer, dpi, pages: pages.map(page => ({
          page: page.page,
          widthMm: Math.round(page.widthMm * 100) / 100,
          heightMm: Math.round(page.heightMm * 100) / 100,
        })) }),
        'utf8',
      );
    } catch {
      // 几何缺失时上层退回按 DPI 折算，不影响渲染
    }
  }

  /**
   * 切片页的召回档识别参数。**固定值，不提供开关** —— 图纸解析的目标是数据精准与不丢失，
   * 留一个「调低召回换速度」的开关就意味着有人能把图纸标注悄悄调没。
   * `process.recognitionScoreThreshold` 必须与检测阈值一起放宽：行置信度过滤发生在行分组之前，
   * 只放宽检测阈值的话低置信度标注仍会被整体丢弃。
   */
  private getOcrRecallOptions(): OcrRecognizeOptions {
    const built = buildPaddleRecognizeOptions({
      minimumAreaThreshold: TILE_RECALL_MIN_AREA,
      boxScoreThreshold: TILE_RECALL_BOX_SCORE,
      recognitionScoreThreshold: TILE_RECALL_REC_SCORE,
    });
    const options: OcrRecognizeOptions = {};
    if (built.recognizeOptions) options.detection = built.recognizeOptions.detection as Record<string, unknown>;
    if (built.processOptions) options.process = built.processOptions;
    return options;
  }

  /**
   * 单页 OCR：按页面物理尺寸决定是否切片。切片时逐块识别（块内不做缩放，
   * 等价于检测在原生分辨率上进行），并启用召回档阈值。
   */
  /**
   * 栅格图片 OCR：长边超过检测上限（或按 200DPI 折算达到大幅面）时切片识别。
   *
   * 为什么必须切片：检测网络会把整图缩放到 `maxSideLength` 以内再送检测，A2 图 200DPI
   * 即 4678×3309，图上 2.5mm 标注缩完只剩约 4px、检测模型直接看不见（实测整页仅 450 字符、
   * 切片后可达数千）。切片边长 ≤ 检测上限时块内不发生任何缩放，等价于原生分辨率检测。
   *
   * 此前切片只接在 **PDF 页**路径上（`recognizePdfPageOcr`），栅格图片（扫描件、拍照图纸、
   * Office 内嵌图）一律整图识别 —— 长边 >4000px 的图片小字标注整类丢失，且**零告警**
   * （`metadata.imageWidth/imageHeight` 有值，但没有任何地方拿它跟切片阈值比较）。
   */
  private async recognizeRasterImage(
    provider: OcrProvider,
    image: RgbPixels,
    metadata: Record<string, unknown>,
    warnings: string[],
  ): Promise<OcrResult> {
    const decision = shouldTilePage({
      widthPx: image.width,
      heightPx: image.height,
      maxSidePx: PADDLE_DETECTION_MAX_SIDE_PX,
      tilePx: TILE_PX,
      thresholdMm: TILE_TRIGGER_MM,
    });
    if (!decision.tile) return provider.recognize(image);

    const plan = planTiles(image.width, image.height, {
      tilePx: TILE_PX, overlapPx: TILE_OVERLAP_PX, maxTiles: TILE_MAX_PER_PAGE,
    });
    const result = await recognizeWithTiling({
      source: image,
      tiles: plan.tiles,
      recognize: (pixels, recognizeOptions) => provider.recognize(pixels, recognizeOptions),
      options: this.getOcrRecallOptions(),
    });
    metadata.ocrTiled = true;
    metadata.ocrTileCount = plan.tiles.length;
    if (result.tilesFailed > 0) {
      warnings.push(`图片切片 OCR 有 ${result.tilesFailed}/${plan.tiles.length} 块识别失败，该区域内容可能缺失`);
    }
    return result;
  }

  private async recognizePdfPageOcr(options: {
    provider: OcrProvider;
    imgPath: string;
    dimensions: { width: number; height: number };
    pageSizeMm?: { widthMm: number; heightMm: number };
    warnings: string[];
  }): Promise<{ result: OcrResult; tiled: boolean; tiles: number; tilesFailed: number }> {
    const decision = shouldTilePage({
      widthPx: options.dimensions.width,
      heightPx: options.dimensions.height,
      widthMm: options.pageSizeMm?.widthMm,
      heightMm: options.pageSizeMm?.heightMm,
      dpi: this.getPdfOcrDpi(),
      thresholdMm: TILE_TRIGGER_MM,
      maxSidePx: PADDLE_DETECTION_MAX_SIDE_PX,
      tilePx: TILE_PX,
    });
    if (!decision.tile) {
      const result = await options.provider.recognize({
        data: new Uint8Array(0), width: options.dimensions.width, height: options.dimensions.height,
        channels: 0, filePath: options.imgPath,
      });
      return { result, tiled: false, tiles: 1, tilesFailed: 0 };
    }

    const plan = planTiles(options.dimensions.width, options.dimensions.height, {
      tilePx: TILE_PX, overlapPx: TILE_OVERLAP_PX, maxTiles: TILE_MAX_PER_PAGE,
    });
    const result = await recognizeWithTiling({
      source: { filePath: options.imgPath },
      tiles: plan.tiles,
      recognize: (pixels, recognizeOptions) => options.provider.recognize(pixels, recognizeOptions),
      options: this.getOcrRecallOptions(),
    });
    // warnings 由调用方统一并入（避免同一批告警既在这里加前缀、又在调用方再加一次前缀）
    return { result, tiled: true, tiles: plan.tiles.length, tilesFailed: result.tilesFailed };
  }

  /**
   * 引擎降级告警：PaddleOCR 不可用而降级 tesseract 时，图纸/表格识别质量会明显下降。
   * provider 的 availabilityNote 会带上具体原因（模型缺失/依赖缺失），写进解析告警里，
   * 避免「模型目录放错代次 → 静默降级 → 图纸解析变差」这种无人察觉的退化。
   */
  private ocrProviderWarnings(provider: OcrProvider): string[] {
    if (provider.id === 'paddleocr.js') return [];
    const note = provider.availabilityNote;
    return [note ? `OCR 引擎降级为 ${provider.id}（${note}），图纸/表格识别质量下降` : `OCR 引擎降级为 ${provider.id}，图纸/表格识别质量下降`];
  }

  /** 读取渲染目录里的页面几何；缺失或格式异常时返回 undefined */
  private readPdfPageGeometry(outputDir: string): Map<number, { widthMm: number; heightMm: number }> | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(outputDir, PAGE_GEOMETRY_FILE), 'utf8')) as {
        pages?: Array<{ page?: unknown; widthMm?: unknown; heightMm?: unknown }>;
      };
      const geometry = new Map<number, { widthMm: number; heightMm: number }>();
      for (const page of raw.pages ?? []) {
        const pageNo = Number(page?.page);
        const widthMm = Number(page?.widthMm);
        const heightMm = Number(page?.heightMm);
        if (Number.isFinite(pageNo) && widthMm > 0 && heightMm > 0) geometry.set(pageNo, { widthMm, heightMm });
      }
      return geometry.size > 0 ? geometry : undefined;
    } catch {
      return undefined;
    }
  }

  private getPdfOcrDpi(): number {
    return Math.max(120, Math.min(300, Number(process.env.CUSTOMIZE_KB_PDF_OCR_DPI || 200)));
  }

  private getPdfOcrRetryDpi(initialDpi: number): number {
    const configured = Number(process.env.CUSTOMIZE_KB_PDF_OCR_RETRY_DPI || 300);
    return Math.max(initialDpi, Math.min(300, Math.max(120, configured)));
  }

  private shouldRetryPdfOcrAtHigherDpi(text: string, score: number): boolean {
    const normalizedLength = this.normalizedTextLength(text);
    if (normalizedLength === 0) return true;
    const threshold = Number(process.env.CUSTOMIZE_KB_PDF_OCR_RETRY_MIN_SCORE || 120);
    const replacementRatio = (text.match(/[�□]/gu)?.length ?? 0) / Math.max(1, text.length);
    return score < threshold || replacementRatio > 0.02;
  }

  private scoreOcrText(value: string): number {
    const text = String(value ?? '').trim();
    const normalizedLength = this.normalizedTextLength(text);
    const cjkCount = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
    const latinCount = (text.match(/[A-Za-z]/g) ?? []).length;
    const replacementCount = (text.match(/[�□]/gu) ?? []).length;
    // 噪声碎片识别：汉字密度极低且存在长连续拉丁字母串（CAD 单线矢量字被 tesseract 误读的典型形态），
    // 强制低分触发 300DPI 重试或外部引擎路径，避免噪声文本被误判为高质量结果
    const hanDensity = normalizedLength > 0 ? cjkCount / normalizedLength : 0;
    const longLatinRun = (text.match(/[A-Za-z]{8,}/g) ?? []).join('').length;
    if (hanDensity < 0.08 && longLatinRun > 100) return -1;
    return cjkCount * 8 + normalizedLength - latinCount * 0.8 - replacementCount * 10;
  }

  /**
   * OCR 页有效行占比：行内汉字 >= 2 且（行足够长 / 含中文句读 / 含领域信号词）才计为有效行。
   * 用于剔除纯图形页（图框、LOGO）OCR 出的零散噪声碎片。
   */
  private ocrMeaningfulLineRatio(text: string): number {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) return 0;
    const meaningful = lines.filter(line => {
      const han = (line.match(/[\p{Script=Han}]/gu) ?? []).length;
      if (han < 2) return false;
      return line.length >= 8 || /[，。；：、（）]/u.test(line) || /工程|项目|施工|设计|说明|材料|图纸|要求|标注|单位|数量|序号|名称|详见/u.test(line);
    }).length;
    return meaningful / lines.length;
  }

  private cleanOcrText(value: string): string {
    // 误读纠正放在噪声行过滤之后：纠正不会把已被判为噪声的行重新救回来，
    // 也避免替换产生的文本影响噪声行的字符占比判定
    return applyOcrMisreadCorrections(filterOcrGraphicNoiseLines(String(value ?? '')
      .replace(/[ \t]+/gu, ' ')
      .replace(/([\p{Script=Han}])\s+([\p{Script=Han}])/gu, '$1$2')
      .replace(/([\p{Script=Han}])\s+([，。；：！？、）】》])/gu, '$1$2')
      .replace(/([（【《])\s+([\p{Script=Han}])/gu, '$1$2')
      .replace(/\n{3,}/gu, '\n\n')
      .trim()));
  }

  /**
   * 加载图片像素数据（依赖 sharp）。
   * 必须 removeAlpha + 固定 RGB：paddleocr 的 ImageInput 没有通道字段，恒定按 3 通道解释
   * data，带 alpha 的 PNG（4 通道）会被当成 RGB 读入而整体错位；灰度图（1 通道）同理。
   * 通道数一并回传，供 tesseract 兜底路径按真实通道数建图。
   */
  private async loadImagePixels(filePath: string): Promise<{ data: Uint8Array; width: number; height: number; channels: number }> {
    const sharpMod: any = await resolveAndImport('sharp');
    const sharpFn = sharpMod.default ?? sharpMod;
    const { data, info } = await sharpFn(filePath).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data as Buffer), width: info.width as number, height: info.height as number, channels: info.channels as number };
  }

  private async readImageDimensions(filePath: string): Promise<{ width: number; height: number } | undefined> {
    try {
      const sharpMod: any = await resolveAndImport('sharp');
      const sharpFn = sharpMod.default ?? sharpMod;
      const metadata = await sharpFn(filePath).metadata();
      const width = Number(metadata.width ?? 0);
      const height = Number(metadata.height ?? 0);
      return width > 0 && height > 0 ? { width, height } : undefined;
    } catch {
      return undefined;
    }
  }

  private isTooSmallForOcr(width: number, height: number): boolean {
    return width < 8 || height < 8 || width * height < 128;
  }

  private async extractPdfText(buffer: Buffer): Promise<{ text: string; garbledPages: number[]; emptyGraphicPages: number[]; sheetPages: number[]; pageCount: number }> {
    let pdfjsText = '';
    const garbledPages: number[] = [];
    // 文本层为空但页面存在绘制内容（扫描图页 / CAD 矢量图页）的页码：正文是图形而非文本层，
    // 同样需要选择性 OCR 兜底，否则整页信息完全丢失
    const emptyGraphicPages: number[] = [];
    // 有文本层但只是图签栏的大幅面图纸页：文本层「非空」掩盖了正文在矢量图形里的事实，
    // 是单张出图（一个文件一张 A2/A3）时的典型形态，须与 emptyGraphicPages 同等对待
    const sheetPages: number[] = [];
    let pageCount = 0;
    // 第一层：pdfjs-dist 文本提取（处理压缩内容流、CJK 字体、现代 PDF）
    try {
      const mod = await resolveAndImport('pdfjs-dist/legacy/build/pdf.mjs') as any;
      const loadingTask = mod.getDocument({ data: new Uint8Array(buffer), verbosity: 0 as number });
      const doc = await loadingTask.promise;
      const pages: string[] = [];
      const pageLimit = doc.numPages;
      pageCount = doc.numPages;
      for (let i = 1; i <= pageLimit; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: true });
        const items = content.items
          .map((item: unknown) => this.toPdfTextItem(item))
          .filter((item: PdfTextItem | undefined): item is PdfTextItem => !!item && item.str.trim().length > 0);
        const pageText = this.layoutPdfTextItems(items, i);
        if (!pageText.trim()) {
          // 空文本层页不可直接跳过：扫描图页/CAD 矢量图页的文本层为空但页面有真实内容。
          // 仅当页面存在绘制内容（图片/矢量描边）时才记入 OCR 候选，纯空白页不触发 OCR
          if (await this.pdfPageHasDrawableContent(page)) emptyGraphicPages.push(i);
          continue;
        }
        // CAD 导出的 PDF 缺 ToUnicode CMap 的 CID 字体输出外来文字乱码页：剔除并记录，
        // 由 extractPdf 对这些页做选择性 OCR 兜底（乱码字符均为“合法字母”，可读性过滤无法识别）
        if (hasForeignScriptGarbledText(pageText)) {
          garbledPages.push(i);
          continue;
        }
        // 大幅面 + 文本层稀疏 + 页面有绘制内容 → 正文在矢量图形里、文本层只剩图签栏。
        // 文本仍保留（图签栏含项目名/设计院等信息），同时记入 OCR 候选补回正文
        if (await this.isSparseTextSheetPage(page, pageText)) sheetPages.push(i);
        pages.push(pageText.trim());
        // 上限治理 · 内存：**每页显式释放**。`pdfPageHasDrawableContent` 会读 `page.getOperatorList()`，
        // 而 CAD 导出的矢量图纸单页算子表可达数十万条 —— 531 页图纸 PDF 下，pdfjs 缓存全部算子表
        // 直接把堆吃穿（实测进程启动后 2 秒内 OOM/SIGABRT，RSS 冲到 8GB+）。`cleanup()` 释放该页的
        // 算子表与渲染资源，使内存占用回到「单页量级」而非「全文档累计」。
        try { page.cleanup(); } catch { /* 释放失败不影响提取结果 */ }
      }
      await doc.destroy();
      pdfjsText = pages.join('\n\n').trim();

    } catch (e) {
      // pdfjs-dist 提取失败不致命，继续下一层解析
    }

    // 第二层：pdf-parse（兼容旧版 PDF），适配 v1.x 函数导出 和 v2.x 类导出
    try {
      const mod = await resolveAndImport('pdf-parse');
      let pdfParse: ((data: Buffer) => Promise<{ text: string }>) | undefined;

      // v1.x: module.exports = function(buffer) { ... }
      if (typeof mod === 'function') {
        pdfParse = mod as (data: Buffer) => Promise<{ text: string }>;
      }
      // v1.x ESM: { default: function(buffer) { ... } }
      else if (mod && typeof (mod as Record<string, unknown>).default === 'function') {
        pdfParse = (mod as Record<string, unknown>).default as (data: Buffer) => Promise<{ text: string }>;
      }
      // v2.x: { PDFParse: class { parse(buffer) { ... } } }
      else if (mod && typeof (mod as Record<string, unknown>).PDFParse === 'function') {
        const PDFParse = (mod as Record<string, unknown>).PDFParse as new () => { parse: (data: Buffer) => Promise<{ text: string }> };
        pdfParse = (buf: Buffer) => new PDFParse().parse(buf);
      }

      if (pdfParse) {
        const result = await pdfParse(buffer);
        const parseText = (result?.text ?? '').trim();
        // pdfjs 已检出乱码页时跳过 pdf-parse 长文本合并：pdf-parse 无法按页过滤同一乱码，
        // 其“更长”的文本往往正是乱码来源；pdfjs 全部页面均为乱码页时返回空文本走 OCR 路径
        if (garbledPages.length === 0) {
          if (pdfjsText && parseText && this.normalizedTextLength(parseText) > this.normalizedTextLength(pdfjsText) * 1.08) return { text: [pdfjsText, '## PDF 备用解析文本', parseText].join('\n\n'), garbledPages, emptyGraphicPages, sheetPages, pageCount };
          if (parseText && !pdfjsText) return { text: parseText, garbledPages, emptyGraphicPages, sheetPages, pageCount };
        } else if (parseText && !pdfjsText) {
          return { text: '', garbledPages, emptyGraphicPages, sheetPages, pageCount };
        }
      }
    } catch {
      // pdfjs 结果已可用时忽略备用解析器失败
    }

    if (pdfjsText) return { text: pdfjsText, garbledPages, emptyGraphicPages, sheetPages, pageCount };

    // 第三层：raw regex 回退（未压缩的古老 PDF）
    const raw = buffer.toString('latin1');
    const matches = Array.from(raw.matchAll(/\(([^()]{2,500})\)\s*T[jJ]/gu), match => match[1] ?? '')
      .concat(Array.from(raw.matchAll(/\[([^\]]{2,2000})\]\s*TJ/gu), match => match[1] ?? ''));
    const rawText = matches
      .map(value => value.replace(/\\([()\\])/gu, '$1').replace(/\\n|\\r/gu, ' '))
      .join('\n')
      .split('')
      .map(char => {
        const code = char.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10 && code !== 13) ? ' ' : char;
      })
      .join('')
      .trim();
    return { text: rawText, garbledPages, emptyGraphicPages, sheetPages, pageCount };
  }

  /**
   * 判断空文本层页是否存在绘制内容（图片或矢量描边）。
   * 纯空白页（无绘制操作或仅 setGState 等状态操作）返回 false，不触发 OCR；
   * 扫描图页（paintImageXObject）与 CAD 矢量图页（constructPath/stroke/fill）返回 true。
   * 操作编号为 pdfjs OPS 常量（跨版本稳定）：
   * fill=9 eoFill=10 stroke=11 constructPath=22 paintImageMaskXObject=83
   * paintImageMaskXObjectRepeat=84 paintImageXObject=85 paintInlineImageXObject=86 paintSolidColorImageMask=91
   */
  /**
   * 判断是否为「文本层只剩图签栏」的大幅面图纸页。
   *
   * 三个条件同时成立才判定，缺一不可：
   * ① 页面长边 ≥ 400mm（A3 及以上，复用切片阈值）—— 文档页是 A4，不会命中；
   * ② 可见字符数 < SHEET_PAGE_MAX_VISIBLE_CHARS —— 纯文字的大幅面页（长文本海报等）不会命中；
   * ③ 页面存在绘制内容（矢量描边/图片）—— 印证「正文在图形里」。
   *
   * 与 `emptyGraphicPages` 的分工：后者管「文本层为空 + 有图形」，本判据管
   * 「文本层非空但只有图签栏 + 有图形」。两者共同覆盖图纸 PDF 的全部形态，
   * 单张出图（一个文件一张 A2/A3）由本判据兜住。
   */
  private async isSparseTextSheetPage(page: unknown, pageText: string): Promise<boolean> {
    const visible = (pageText.match(/[\p{L}\p{N}\p{Script=Han}]/gu) ?? []).length;
    if (visible >= SHEET_PAGE_MAX_VISIBLE_CHARS) return false;
    let longSideMm: number;
    try {
      const viewport = (page as { getViewport: (options: { scale: number }) => { width: number; height: number } }).getViewport({ scale: 1 });
      longSideMm = (Math.max(viewport.width, viewport.height) * 25.4) / 72;
    } catch {
      // 取不到页面尺寸时保守判否，避免把尺寸未知的页面误判为图纸页
      return false;
    }
    if (longSideMm < TILE_TRIGGER_MM) return false;
    return this.pdfPageHasDrawableContent(page);
  }

  private async pdfPageHasDrawableContent(page: unknown): Promise<boolean> {
    try {
      const record = page as { getOperatorList?: () => Promise<{ fnArray?: number[] }> };
      const ops = await record.getOperatorList?.();
      const fnArray = ops?.fnArray;
      if (!fnArray || fnArray.length === 0) return false;
      const drawOps = new Set([9, 10, 11, 22, 83, 84, 85, 86, 91]);
      return fnArray.some(fn => drawOps.has(fn));
    } catch {
      return false;
    }
  }

  private normalizedTextLength(value: string): number {
    return value.replace(/\s+/gu, '').length;
  }

  private toPdfTextItem(item: unknown): PdfTextItem | undefined {
    if (!item || typeof item !== 'object' || !('str' in item)) return undefined;
    const record = item as Record<string, unknown>;
    const transform = Array.isArray(record.transform) ? record.transform as number[] : [];
    return {
      str: String(record.str ?? ''),
      x: Number(transform[4] ?? 0),
      y: Number(transform[5] ?? 0),
      width: Number(record.width ?? 0),
      height: Number(record.height ?? Math.abs(Number(transform[3] ?? 0))),
      fontName: typeof record.fontName === 'string' ? record.fontName : undefined,
    };
  }

  private layoutPdfTextItems(items: PdfTextItem[], pageNumber: number): string {
    if (items.length === 0) return '';
    const rows = this.groupPdfItemsIntoRows(items);
    const columnSplit = this.detectPdfColumnSplit(rows);
    const orderedRows = columnSplit == null
      ? rows.sort((a, b) => b.y - a.y || a.x - b.x)
      : [
          ...rows.filter(row => row.x < columnSplit).sort((a, b) => b.y - a.y || a.x - b.x),
          ...rows.filter(row => row.x >= columnSplit).sort((a, b) => b.y - a.y || a.x - b.x),
        ];
    const markdown = this.rowsToPdfMarkdownWithTables(orderedRows);
    return [`## PDF 第 ${pageNumber} 页`, markdown].join('\n\n');
  }

  private joinPdfRowText(items: PdfTextItem[]): string {
    let output = '';
    let previous: PdfTextItem | undefined;
    for (const item of items) {
      const text = item.str.trim();
      if (!text) continue;
      if (!previous) {
        output += text;
      } else {
        const gap = item.x - (previous.x + previous.width);
        const cjkJoin = /[\p{Script=Han}（(《“‘]$/u.test(output) || /^[\p{Script=Han}）)》”’、，。；：！？]/u.test(text);
        output += gap > Math.max(3, previous.height * 0.35) && !cjkJoin ? ` ${text}` : text;
      }
      previous = item;
    }
    return output.replace(/\s+/gu, ' ').trim();
  }

  private groupPdfItemsIntoRows(items: PdfTextItem[]): Array<{ text: string; x: number; y: number; height: number }> {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Array<{ items: PdfTextItem[]; y: number }> = [];
    for (const item of sorted) {
      const row = rows.find(candidate => Math.abs(candidate.y - item.y) <= Math.max(2, item.height * 0.55));
      if (row) row.items.push(item);
      else rows.push({ y: item.y, items: [item] });
    }
    return rows.map(row => {
      const rowItems = row.items.sort((a, b) => a.x - b.x);
      return {
        text: this.joinPdfRowText(rowItems),
        x: Math.min(...rowItems.map(item => item.x)),
        y: row.y,
        height: Math.max(...rowItems.map(item => item.height || 0)),
      };
    }).filter(row => row.text);
  }

  private detectPdfColumnSplit(rows: Array<{ x: number; text: string }>): number | undefined {
    if (rows.length < 8) return undefined;
    const xs = rows.map(row => row.x).sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, index) => ({ gap: x - xs[index]!, left: xs[index]!, right: x })).sort((a, b) => b.gap - a.gap);
    const largest = gaps[0];
    if (!largest || largest.gap < 80) return undefined;
    const leftCount = rows.filter(row => row.x <= largest.left).length;
    const rightCount = rows.filter(row => row.x >= largest.right).length;
    return leftCount >= 3 && rightCount >= 3 ? (largest.left + largest.right) / 2 : undefined;
  }

  private rowsToPdfMarkdownWithTables(rows: Array<{ text: string; height: number }>): string {
    const output: string[] = [];
    let index = 0;
    while (index < rows.length) {
      const tableRows: string[][] = [];
      let cursor = index;
      while (cursor < rows.length) {
        const cells = this.splitLikelyTableRow(rows[cursor]!.text);
        if (cells.length < 2) break;
        tableRows.push(cells);
        cursor += 1;
      }
      if (tableRows.length >= 2) {
        // G 线 P2-9：PDF 表格接入智能表头检测（与 xlsx / CSV / DOCX 三条路径同源）。
        // 历史实现无条件把 `tableRows[0]` 当表头——PDF 表格前常有标题行（「表3-1 主要材料表」）
        // 或被折行规则并入的引导句，把非表头行当表头后真实列名全部丢失，下游按列位的
        // 行级提取与「R#C# 列名: 值」KV 全部错位（与 xlsx 路径当初的实锤同形）。
        // 无列关键词的表格由 detectSmartTableHeader 回退 matrix[0]，历史行为不变。
        const smart = detectSmartTableHeader(tableRows);
        const titleNote = smart.titleLines.length ? `｜表标题：${smart.titleLines.join(' ')}` : '';
        output.push(`### PDF 表格区域${titleNote}`);
        output.push(this.toMarkdownTable(smart.headers, tableRows.slice(smart.headerIndex + 1)));
        index = cursor;
        continue;
      }
      output.push(this.pdfRowToMarkdown(rows[index]!.text, rows[index]!.height, index));
      index += 1;
    }
    return output.join('\n');
  }

  private splitLikelyTableRow(text: string): string[] {
    const byLargeSpaces = text.split(/\s{2,}/u).map(cell => cell.trim()).filter(Boolean);
    if (byLargeSpaces.length >= 2) return byLargeSpaces;
    const byPipes = text.split('|').map(cell => cell.trim()).filter(Boolean);
    return byPipes.length >= 2 ? byPipes : [];
  }

  private pdfRowToMarkdown(text: string, height: number, index: number): string {
    // 折行半句/整句收尾的正文行不标题化（字号与首行规则只对结构标题生效，详见 isPdfWrappedClauseLike）
    if (isPdfWrappedClauseLike(text)) return text;
    if (index === 0 && text.length <= 100) return `# ${text}`;
    if (height >= 14 && text.length <= 120) return `## ${text}`;
    if (/^(第[一二三四五六七八九十\d]+[章节]|\d+(?:\.\d+)*\s+)/u.test(text) && text.length <= 120) return `### ${text}`;
    return text;
  }

  private toMarkdownDocument(text: string): string {
    const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    // OCR 页节（## PDF 第 N 页（OCR））内的行是 OCR 原始识别行（碎片行/表格行/分栏重排产物），
    // 不是文档结构标题，一律原样保留不标题化：数字开头短行若加 ## 会产出
    // 「## 2 起重机械安装拆卸工程三、保证…」这类假二级标题，在切分器中触发二级标题
    // 硬边界独占一级节、页标记 section_title 被抢占（舒城信号灯 p80 实锤）。
    let inOcrSection = false;
    return lines.map((line, index) => {
      if (/^## PDF 第 \d+ 页/u.test(line)) {
        inOcrSection = /（OCR）$/u.test(line);
        return line;
      }
      if (inOcrSection) return line;
      if (/^#{1,6}\s/u.test(line) || /^\|/u.test(line)) return line;
      if (line.length <= 80 && !/[。！？.!?]$/u.test(line)) {
        if (index === 0) return `# ${line}`;
        if (isPdfWrappedClauseLike(line)) return line; // 折行半句不标题化（门禁链根因第一张骨牌）
        if (/^(第[一二三四五六七八九十\d]+[章节]|\d+(?:\.\d+)*\s+)/u.test(line)) return `## ${line}`;
        return `### ${line}`;
      }
      return line;
    }).join('\n\n');
  }

  private normalizeMarkdownHeadings(text: string): string {
    return text
      .split(/\r?\n/u)
      .map(line => {
        const trimmed = line.trim();
        if (!trimmed) return '';
        if (/^#{1,6}\s/u.test(trimmed) || /^\|/u.test(trimmed)) return trimmed;
        if (trimmed.length <= 80 && /^(第[一二三四五六七八九十\d]+[章节]|\d+(?:\.\d+)*\s+)/u.test(trimmed)) return `## ${trimmed}`;
        return trimmed;
      })
      .join('\n');
  }

  private extractSvg(file: ClassifiedFile): { text: string; metadata: Record<string, unknown>; warnings: string[] } {
    const raw = fs.readFileSync(file.absolutePath, 'utf8');
    const nodes = this.extractSvgSemanticNodes(raw);
    return {
      text: [this.metadataOnlyText(file), 'SVG 层级语义节点:', ...nodes].join('\n'),
      metadata: { extractionMode: 'svg_text_nodes', semanticExtractionMode: 'svg_semantic_tree_nodes', vectorizable: true, textNodeCount: nodes.length, contentCoverage: 'svg_hierarchical_text_title_desc' },
      warnings: [],
    };
  }

  private extractSvgSemanticNodes(raw: string): string[] {
    const nodes: string[] = [];
    const stack: string[] = [];
    const tokenPattern = /<\/?([A-Za-z_][\w:.-]*)\b([^>]*)>|([^<>]+)/gu;
    for (const match of raw.matchAll(tokenPattern)) {
      const tag = match[1];
      const attrs = match[2] ?? '';
      const text = match[3]?.replace(/\s+/gu, ' ').trim();
      const token = match[0];
      if (tag && token.startsWith('</')) stack.pop();
      else if (tag && !token.endsWith('/>')) {
        const id = /\bid="([^"]+)"/u.exec(attrs)?.[1];
        stack.push(id ? `${tag}#${id}` : tag);
      } else if (text && ['text', 'title', 'desc'].includes(stack.at(-1)?.split('#')[0] ?? '')) {
        nodes.push(`${stack.join(' > ')}: ${this.stripXml(text)}`);
      }
    }
    return nodes;
  }

  private isTextReadable(file: ClassifiedFile): boolean {
    if (file.category === 'code' || file.category === 'web') return true;
    if (file.category === 'document') return ['markdown', 'plaintext'].includes(file.format);
    if (file.category === 'spreadsheet') return file.format === 'csv';
    if (file.category === 'image') return file.format === 'vector';
    return file.category === 'other' && this.looksTextFile(file.absolutePath);
  }

  private looksTextFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ['.log', '.text'].includes(ext);
  }

  private matchAll(input: string, pattern: RegExp): string[] {
    return Array.from(input.matchAll(pattern), match => match.slice(1).filter(Boolean).join(' | ').trim()).filter(Boolean);
  }

  private stripXml(value: string): string {
    return value
      .replace(/<[^>]+>/gu, ' ')
      .replace(/&quot;/gu, '"')
      .replace(/&apos;/gu, "'")
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      .replace(/&amp;/gu, '&')
      .replace(/\s+/gu, ' ')
      .trim();
  }

  private flattenJson(value: unknown, prefix = ''): string[] {
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [`${prefix || 'value'}: ${String(value)}`];
    }
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => this.flattenJson(item, `${prefix}[${index}]`));
    }
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => this.flattenJson(item, prefix ? `${prefix}.${key}` : key));
    }
    return [];
  }

  private atomicJsonObjects(value: unknown, prefix = '$'): string[] {
    if (value == null || typeof value !== 'object') return [];
    if (Array.isArray(value)) return value.flatMap((item, index) => this.atomicJsonObjects(item, `${prefix}[${index}]`));
    const entries = Object.entries(value as Record<string, unknown>);
    const current = `${prefix}: ${JSON.stringify(value)}`;
    const children = entries.flatMap(([key, item]) => this.atomicJsonObjects(item, `${prefix}.${key}`));
    return [current, ...children];
  }

  private flattenYamlByIndent(raw: string): string[] {
    const stack: Array<{ indent: number; key: string }> = [];
    const lines: string[] = [];
    for (const line of raw.split(/\r?\n/u)) {
      if (!line.trim() || /^\s*#/u.test(line)) continue;
      const match = /^(\s*)([-\w.]+)\s*:\s*(.*)$/u.exec(line);
      if (!match) continue;
      const indent = match[1]!.length;
      const key = match[2]!;
      const value = match[3]!.trim();
      while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
      const pathName = [...stack.map(item => item.key), key].join('.');
      if (value) lines.push(`${pathName}: ${value}`);
      stack.push({ indent, key });
    }
    return lines;
  }

  private flattenXmlPaths(raw: string): string[] {
    const lines: string[] = [];
    const stack: string[] = [];
    const tokenPattern = /<\/?([A-Za-z_][\w:.-]*)\b[^>]*>|([^<>]+)/gu;
    for (const match of raw.matchAll(tokenPattern)) {
      const tag = match[1];
      const text = match[2]?.replace(/\s+/gu, ' ').trim();
      const token = match[0];
      if (tag && token.startsWith('</')) stack.pop();
      else if (tag && !token.endsWith('/>')) stack.push(tag);
      else if (text && stack.length > 0) lines.push(`${stack.join('.')}: ${this.stripXml(text)}`);
    }
    return lines.filter(line => !line.endsWith(':'));
  }

  private metadataOnlyText(file: ClassifiedFile): string {
    return [
      `资料类型: ${file.category}/${file.format}`,
      `MIME: ${file.mimeType}`,
      `文件大小: ${file.fileSize} bytes`,
    ].join('\n');
  }
}
