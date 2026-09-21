/**
 * G 线 P2-7：AutoCAD MTEXT 行内格式码剥离回归。
 *
 * 缺陷背景：图纸标注里的 MTEXT 常带内嵌格式码，形如
 * `{\fSimSun|b0|i0|c134|p2;建设单位}`、`\A1;图纸设计总说明`、`\W1.2;宽度因子`。
 * 这些转义码此前未被清洗，危害是双重的：
 * ① 污染检索词面——「建设单位」被拼成 `{\fSimSun|b0…;建设单位}`，关键词命中率下降；
 * ② 更严重的是被 isLikelyGarbledCadText 的「符号占比 > 0.35」规则判为乱码而**整行丢弃**，
 *    真标注被吞，用户看到的是图纸内容缺失。
 * 巢湖 21 张图纸终态库实测：1730 个 cad chunk 中 738 个残留此类转义码（42.7%）。
 *
 * 本文件锁定：格式码剥离后真标注必须可检索，且转义码不得以任何形态残留。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import type { ClassifiedFile } from '../src/types.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mtext-'));
const kbDir = path.join(tmpDir, 'knowledgeBase');
fs.mkdirSync(kbDir, { recursive: true });

function createTestFile(relativePath: string, content: string): string {
  const absPath = path.join(kbDir, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
  return absPath;
}

function dxfWithMtexts(texts: string[]): string {
  const entities = texts.map(text => ['0', 'MTEXT', '8', 'TextLayer', '10', '100', '20', '200', '1', text].join('\n'));
  return ['0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF'].join('\n');
}

function classify(relativePath: string, absolutePath: string): ClassifiedFile {
  return {
    absolutePath,
    relativePath,
    category: 'cad',
    format: 'autocad',
    fileSize: fs.statSync(absolutePath).size,
    mtime: Date.now(),
    mimeType: 'application/dxf',
  };
}

let extractor: ContentExtractor;
beforeAll(() => { extractor = new ContentExtractor(); });
afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

describe('G 线 P2-7 MTEXT 格式码剥离', () => {
  it('字体组格式码 `{\\f…;文本}` 剥离后正文可检索，且无转义残渣', async () => {
    const absPath = createTestFile('cad/mtext-font.dxf', dxfWithMtexts(['{\\fSimSun|b0|i0|c134|p2;本工程图纸设计总说明：混凝土强度等级 C35，砌体采用 MU10 砖 M5 砂浆。}']));
    const result = await extractor.extract(classify('cad/mtext-font.dxf', absPath));
    // 真标注可检索（剥离的价值所在）
    expect(result.text).toContain('本工程图纸设计总说明');
    expect(result.text).toContain('混凝土强度等级 C35');
    // 转义码与分组花括号不得以任何形态残留
    expect(result.text).not.toContain('fSimSun');
    expect(result.text).not.toContain('|b0');
    expect(result.text).not.toContain('c134');
    expect(result.text).not.toContain('{');
    expect(result.text).not.toContain('}');
  });

  it('对齐码 `\\A1;` 剥离、段落符 `\\P` 转为独立行（段落边界不被抹成粘连）', async () => {
    const absPath = createTestFile('cad/mtext-align.dxf', dxfWithMtexts(['\\A1;图纸设计总说明：本工程为巢湖市执珩建设项目\\P混凝土强度等级 C35，砌体采用 MU10 砖 M5 砂浆。']));
    const result = await extractor.extract(classify('cad/mtext-align.dxf', absPath));
    expect(result.text).toContain('图纸设计总说明');
    expect(result.text).toContain('混凝土强度等级 C35');
    // 段落符与对齐码均不得残留
    expect(result.text).not.toContain('\\A1');
    expect(result.text).not.toContain('\\P');
    expect(result.text).not.toContain(';图纸设计总说明');
    // \P 是段落边界：两段必须分处不同行（否则说明段落被无分隔粘连成一行，
    // 正是「原样残留 \P」与「拆成独立标注后被 layoutCadAnnotations 重建」两种形态的实测缺陷）
    const lines = result.text.split('\n').map(line => line.trim());
    const firstParagraphLine = lines.findIndex(line => line.includes('图纸设计总说明'));
    const secondParagraphLine = lines.findIndex(line => line.includes('混凝土强度等级 C35'));
    expect(firstParagraphLine).toBeGreaterThanOrEqual(0);
    expect(secondParagraphLine).toBeGreaterThanOrEqual(0);
    expect(secondParagraphLine).not.toBe(firstParagraphLine);
  });

  it('无参开关码 `\\L\\l\\O\\K\\~` 与带参码 `\\W1.2;` 一并剥离', async () => {
    const absPath = createTestFile('cad/mtext-toggle.dxf', dxfWithMtexts(['\\L下划线标注\\l 与 \\W1.2;宽度因子文本\\K倾斜\\k：本工程给水管沿墙敷设，管道中心标高详见给水平面图，施工前须复核现场实际尺寸。']));
    const result = await extractor.extract(classify('cad/mtext-toggle.dxf', absPath));
    expect(result.text).toContain('下划线标注');
    expect(result.text).toContain('宽度因子文本');
    for (const code of ['\\L', '\\l', '\\W', '\\K', '\\k', '\\~']) {
      expect(result.text).not.toContain(code);
    }
    expect(result.text).not.toContain('1.2;');
  });

  it('剥离后不误伤常规工程标注（控制码 %%c 仍解码为 Φ，数值标注保留）', async () => {
    const absPath = createTestFile('cad/mtext-control.dxf', dxfWithMtexts(['\\A1;本工程给水管采用 %%c110 管材沿墙敷设，管道中心标高 2.900 米，施工前须复核现场实际尺寸并报监理验收。']));
    const result = await extractor.extract(classify('cad/mtext-control.dxf', absPath));
    expect(result.text).toContain('给水管');
    expect(result.text).toContain('110');
    // %%c 控制码解码为直径符号（原有行为不得因格式码剥离而回归失效）
    expect(result.text).toContain('Φ');
    // 数值标注是真实数据，必须保留（不因格式码剥离而丢数字）
    expect(result.text).toContain('2.900');
  });
});
