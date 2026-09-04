import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import { TextChunker } from '../src/chunking/text-chunker.js';
import { FileClassifier } from '../src/classification/classifier.js';
import { resolvePackage, resolveAndImport } from '../src/extraction/module-resolver.js';
import type { ClassifiedFile } from '../src/types.js';

// ─── 设置 ────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-formats-'));
const classifier = new FileClassifier();
const extractor = new ContentExtractor();
const chunker = new TextChunker();

function makeFile(relPath: string, content: string | Buffer): ClassifiedFile {
  const abs = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (typeof content === 'string') fs.writeFileSync(abs, content, 'utf8');
  else fs.writeFileSync(abs, content);
  const stat = fs.statSync(abs);
  return classifier.classify(abs, relPath, stat);
}

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理 */ }
});

// ─── 辅助函数：验证提取是否健康 ─────────────────────

async function assertExtractionOk(file: ClassifiedFile, desc: string) {
  const result = await extractor.extract(file);
  // 每次提取都应返回结果
  expect(result, `${desc}: result should exist`).toBeDefined();
  expect(result.metadata, `${desc}: metadata should exist`).toBeDefined();

  const mode = result.metadata.extractionMode as string;
  const coverage = result.metadata.contentCoverage as string;

  console.log(`  ${desc}: mode=${mode}, coverage=${coverage}, textLen=${result.text.length}, warnings=${result.warnings.length}`);

  // 记录提取模式以便分析
  return { mode, coverage, textLen: result.text.length, warnings: result.warnings, text: result.text };
}

// ─── 1. 模块解析 ─────────────────────────────────────

describe('Module resolution (resolveAndImport)', () => {
  it('resolves pdfjs-dist', () => {
    const p = resolvePackage('pdfjs-dist/legacy/build/pdf.mjs');
    expect(p).toContain('pdfjs-dist');
  });

  it('resolves pdf-parse', () => {
    const p = resolvePackage('pdf-parse');
    expect(p).toContain('pdf-parse');
  });

  it('resolves mammoth', () => {
    const p = resolvePackage('mammoth');
    expect(p).toContain('mammoth');
  });

  it('resolves xlsx', () => {
    const p = resolvePackage('xlsx');
    expect(p).toContain('xlsx');
  });

  it('resolves jszip', () => {
    const p = resolvePackage('jszip');
    expect(p).toContain('jszip');
  });

  it('resolves @napi-rs/canvas', () => {
    const p = resolvePackage('@napi-rs/canvas');
    expect(p).toContain('canvas');
  });

  it('resolves tesseract.js', () => {
    const p = resolvePackage('tesseract.js');
    expect(p).toContain('tesseract.js');
  });

  it('can dynamically import mammoth', async () => {
    const mod = await resolveAndImport('mammoth');
    expect(mod).toBeDefined();
  });

  it('can dynamically import xlsx', async () => {
    const mod = await resolveAndImport('xlsx');
    expect(mod).toBeDefined();
  });

  it('can dynamically import jszip', async () => {
    const mod = await resolveAndImport('jszip');
    expect(mod).toBeDefined();
  });
});

// ─── 2. 文档格式 ──────────────────────────────────────

describe('Document extraction', () => {
  it('plain text (.txt)', async () => {
    const file = makeFile('docs/test.txt', 'Hello World\n中文字符测试\nGoodbye.');
    const r = await assertExtractionOk(file, '.txt');
    expect(r.mode).toBe('plain_text');
  });

  it('markdown (.md)', async () => {
    const file = makeFile('docs/test.md', '# 标题\n\n内容段落\n\n## 第二章\n\n- 列表');
    const r = await assertExtractionOk(file, '.md');
    expect(r.mode).toBe('plain_text');
  });

  it('restructured text (.rst)', async () => {
    const file = makeFile('docs/test.rst', '=====\nTitle\n=====\n\nSection\n-------\n\nContent here.');
    const r = await assertExtractionOk(file, '.rst');
    expect(r.mode).toBe('plain_text');
  });

  it('asciidoc (.asciidoc)', async () => {
    const file = makeFile('docs/test.asciidoc', '= Title\n\n== Section\n\nContent.');
    const r = await assertExtractionOk(file, '.asciidoc');
    expect(r.mode).toBe('plain_text');
  });

  it('latex (.tex)', async () => {
    const file = makeFile('docs/test.tex', '\\documentclass{article}\n\\begin{document}\nHello World\n\\end{document}');
    const r = await assertExtractionOk(file, '.tex');
    expect(r.mode).toBe('plain_text');
  });
});

// ─── 3. 代码格式 ──────────────────────────────────────────

describe('Code extraction', () => {
  const codeCases: Array<[string, string, string]> = [
    ['.ts', 'typescript', 'export interface Foo { bar: string }\nexport function baz(): Foo { return { bar: "x" } }'],
    ['.tsx', 'typescript', 'import React from "react";\nexport const App = () => <div>Hello</div>;'],
    ['.js', 'javascript', 'const x = 1;\nfunction foo() { return x + 1; }\nmodule.exports = { foo };'],
    ['.jsx', 'javascript', 'const el = <div className="test">Hello</div>;\nexport default el;'],
    ['.py', 'python', 'def hello():\n    print("Hello World")\n\nclass MyClass:\n    def method(self):\n        pass'],
    ['.java', 'java_kotlin', 'public class Hello {\n    public static void main(String[] args) {\n        System.out.println("Hello");\n    }\n}'],
    ['.go', 'go', 'package main\n\nimport "fmt"\n\nfunc main() {\n    fmt.Println("Hello")\n}'],
    ['.rs', 'rust', 'fn main() {\n    println!("Hello, world!");\n}'],
    ['.rb', 'ruby', 'def hello\n  puts "Hello World"\nend'],
    ['.php', 'php', '<?php\nfunction hello() {\n    echo "Hello";\n}'],
    ['.sh', 'shell', '#!/bin/bash\necho "Hello World"\nif [ -f test ]; then\n  echo "exists"\nfi'],
    ['.sql', 'sql', 'SELECT * FROM users WHERE active = 1;\nINSERT INTO logs (msg) VALUES ("test");'],
    ['.toml', 'config', '[server]\nhost = "0.0.0.0"\nport = 8080'],
    ['.ini', 'config', '[database]\nhost=localhost\nport=5432'],
    ['.env', 'config', 'DB_HOST=localhost\nDB_PORT=5432\nDEBUG=true'],
  ];

  it.each(codeCases)('%s (format=%s) extracts as plain_text', async (ext, _fmt, content) => {
    const file = makeFile(`code/test${ext}`, content);
    const r = await assertExtractionOk(file, ext);
    expect(r.mode).toBe('plain_text');
    expect(r.textLen).toBeGreaterThan(0);
  });
});

// ─── 4. 数据格式 ──────────────────────────────────────────

describe('Data extraction', () => {
  it('json5 (.json5)', async () => {
    const file = makeFile('data/test.json5', '{ name: "test", // comment\n  value: 42 }');
    const r = await assertExtractionOk(file, '.json5');
    // 回退为纯结构化文本，因为 json5 可能无法按 JSON 解析
    expect(r.mode).toBeTruthy();
  });

  it('protobuf (.proto)', async () => {
    const file = makeFile('data/test.proto', 'syntax = "proto3";\nmessage User {\n  string name = 1;\n  int32 age = 2;\n}');
    const r = await assertExtractionOk(file, '.proto');
    expect(r.textLen).toBeGreaterThan(0);
  });

  it('graphql (.graphql)', async () => {
    const file = makeFile('data/test.graphql', 'type User {\n  id: ID!\n  name: String!\n  email: String\n}\n\ntype Query {\n  users: [User]\n}');
    const r = await assertExtractionOk(file, '.graphql');
    expect(r.textLen).toBeGreaterThan(0);
  });

  it('TSV (.tsv)', async () => {
    const tsv = `Name\tAge\tCity
Alice\t30\tBeijing
Bob\t25\tShanghai`;
    const file = makeFile('spreadsheets/test.tsv', tsv);
    const r = await assertExtractionOk(file, '.tsv');
    expect(r.mode).toBe('delimited_text_structured');
  });
});

// ─── 5. 网页格式 ───────────────────────────────────────────

describe('Web extraction', () => {
  it('SCSS (.scss)', async () => {
    const file = makeFile('web/test.scss', '$primary: #333;\n.container {\n  color: $primary;\n  .nested { margin: 0; }\n}');
    const r = await assertExtractionOk(file, '.scss');
    expect(r.mode).toBe('plain_text');
  });

  it('handlebars (.hbs)', async () => {
    const file = makeFile('web/test.hbs', '<div class="user">\n  <h1>{{name}}</h1>\n  {{#if active}}\n    <span>Active</span>\n  {{/if}}\n</div>');
    const r = await assertExtractionOk(file, '.hbs');
    expect(r.mode).toBe('plain_text');
  });

  it('EJS (.ejs)', async () => {
    const file = makeFile('web/test.ejs', '<% if (user) { %>\n  <h1><%= user.name %></h1>\n<% } %>');
    const r = await assertExtractionOk(file, '.ejs');
    expect(r.mode).toBe('plain_text');
  });
});

// ─── 6. 图表格式 ───────────────────────────────────────

describe('Diagram extraction', () => {
  it('PlantUML (.puml)', async () => {
    const puml = `@startuml
actor User
database DB
User -> DB: Query
DB --> User: Result
@enduml`;
    const file = makeFile('diagrams/test.puml', puml);
    const r = await assertExtractionOk(file, '.puml');
    // 落入图表结构提取路径（原始文本）
    expect(r.mode).toBe('diagram_structural');
  });

  it('Mermaid (.mmd)', async () => {
    const mmd = `graph TD
    A[Start] --> B{Decision}
    B -->|Yes| C[OK]
    B -->|No| D[Fail]`;
    const file = makeFile('diagrams/test.mmd', mmd);
    const r = await assertExtractionOk(file, '.mmd');
    expect(r.mode).toBe('diagram_structural');
  });

  it('Excalidraw (.excalidraw)', async () => {
    const exc = JSON.stringify({
      type: 'excalidraw',
      elements: [
        { type: 'rectangle', text: 'Box 1' },
        { type: 'text', text: 'Hello' },
      ],
    });
    const file = makeFile('diagrams/test.excalidraw', exc);
    const r = await assertExtractionOk(file, '.excalidraw');
    expect(r.mode).toBe('diagram_structural');
    expect(r.text).toContain('Hello');
  });
});

// ─── 7. 归档格式 ───────────────────────────────────────

describe('Archive extraction', () => {
  it('ZIP (.zip) — no longer parsed as archive manifest', async () => {
    const zipBuf = await createMinimalZip();
    const file = makeFile('archives/test.zip', zipBuf);
    const r = await assertExtractionOk(file, '.zip');
    expect(file.category).toBe('other');
    expect(r.mode).toBe('metadata_only');
  });
});

// ─── 8. CAD 格式 ───────────────────────────────────────────

describe('CAD extraction', () => {
  it('STEP (.step) — product/material/entity extraction', async () => {
    const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
ENDSEC;
DATA;
#1=PRODUCT('PART001','Test Part','',(#2));
#2=MATERIAL('STEEL');
#3=CARTESIAN_POINT('',(0.0,0.0,0.0));
ENDSEC;
END-ISO-10303-21;`;
    const file = makeFile('cad/test.step', step);
    const r = await assertExtractionOk(file, '.step');
    expect(r.mode).toBe('builtin_cad_structural');
    expect(r.text).toContain('STEEL');
  });

  it('IGES (.iges) — entity/name extraction', async () => {
    const iges = `TEST PART                                                            S      1
1H,,1H;,12HTEST PART,31HTest Company,7H20260101,32HTest File,         G      1
     314,1,2,1,0,0,0,0,000000000D0001
     314,0,0,0,0,0,0,0,000000000D0002
S      1G      1D0002P0000001
S      1G      2D0001P0000002`;
    const file = makeFile('cad/test.iges', iges);
    const r = await assertExtractionOk(file, '.iges');
    expect(r.mode).toBe('builtin_cad_structural');
  });

  it('OBJ (.obj) — mesh object extraction', async () => {
    const obj = `# Test OBJ file
o Cube
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
g FrontFace
f 1 2 3 4`;
    const file = makeFile('cad/test.obj', obj);
    const r = await assertExtractionOk(file, '.obj');
    expect(r.mode).toBe('builtin_cad_structural');
    expect(r.text).toContain('Cube');
  });

  it('STL (.stl) — header extraction', async () => {
    // 二进制 STL 头部：80 字节 + 4 字节计数
    const header = Buffer.alloc(84);
    header.write('solid TestModel', 0, 'ascii');
    header.writeUInt32LE(1, 80); // 1 triangle
    // 最小三角形数据（50 字节）
    const tri = Buffer.alloc(50);
    const stl = Buffer.concat([header, tri]);
    const file = makeFile('cad/test.stl', stl);
    const r = await assertExtractionOk(file, '.stl');
    expect(r.text).toContain('TestModel');
  });
});

// ─── 8.5 乱码过滤（CAD 二进制兜底 + 旧版 Office 兜底） ─────────

describe('Garbled text filtering', () => {
  const garbledFilter = (extractor as unknown as { isLikelyGarbledCadText: (value: string) => boolean }).isLikelyGarbledCadText.bind(extractor);

  it('rejects long garbled binary-misread lines (mixed domain char exempt pattern)', () => {
    // 真实故障样本：DWG 二进制误读产生的超长乱码行，罍重复 406 次且混入单字
    // “板”触发域信号豁免，旧规则 readableRatio/symbolRatio 全部失效
    const garbledLongLine = `${'罍'.repeat(406)}板${'眄'.repeat(300)}`;
    expect(garbledFilter(garbledLongLine)).toBe(true);
  });

  it('rejects lines where a single Han char dominates (>20%)', () => {
    const dominated = `${'罍'.repeat(60)}板墙柱梁基础`;
    expect(garbledFilter(dominated)).toBe(true);
  });

  it('rejects CJK extension-A rare char mixing (binary misread)', () => {
    // 真实故障样本：DWG 二进制误读批量产生 U+3400-U+4DBF 扩展区生僻字
    expect(garbledFilter('䱠䑿䵳、M䵀倀M䵠瀀陸㽍䵠怿㽍䵠怿㽍䵠怿㽌怀㽍䵠怿㽍䵠怿㽍䵠怿㽌怀')).toBe(true);
    expect(garbledFilter('䱠朅唪脘a')).toBe(true);
  });

  it('rejects non-CJK script letters mixed into Chinese lines', () => {
    // 韩文/藏文/彝文等非中英希字母混入中文行是二进制误读典型产物
    expect(garbledFilter('␏琀밠⸠<༠ļᄠ¼మ簃球吁籂퐿异㜘⼁佤柜՜传')).toBe(true);
    expect(garbledFilter('鈉婋殃⮓䬋憑ꀂ呻')).toBe(true);
  });

  it('accepts Greek letters common in CAD annotations', () => {
    expect(garbledFilter('Φ14@200 双层双向钢筋')).toBe(false);
    expect(garbledFilter('Ω 电阻值 10k')).toBe(false);
  });

  it('accepts normal CAD annotation text', () => {
    expect(garbledFilter('徽光阁项目施工总平面图')).toBe(false);
    expect(garbledFilter('本图纸版权归本院所有，未经允许不得复制。')).toBe(false);
    expect(garbledFilter('R1500 半径 12mm 墙体')).toBe(false);
  });

  it('filters garbled strings from DWG binary fallback extraction', async () => {
    // 伪 DWG：含正常中文标注与乱码行；dwgdxf 转换失败后走内置兜底路径
    // （正常标注需 ≥32 个字符数据，否则按"无字符数据不入库"处理）
    const buffer = Buffer.concat([
      Buffer.from('徽光阁项目施工总平面图及结构加固施工图纸设计说明与材料清单编制依据及适用范围', 'utf8'),
      Buffer.from([0x00, 0x01, 0x02]),
      Buffer.from(`${'罍'.repeat(406)}板`, 'utf8'),
    ]);
    const file = makeFile('cad/fake-garbled.dwg', buffer);
    const result = await extractor.extract(file);
    expect(result.text).not.toContain('罍');
    expect(result.text).toContain('徽光阁');
  });

  it('filters garbled strings from legacy .xls fallback extraction', async () => {
    // 伪 .xls（无效 CFB）：xlsx 解析失败后走旧版 Office 二进制兜底，
    // UTF-16LE 中文正常解码、乱码行应被过滤
    const buffer = Buffer.concat([
      Buffer.from('拆除工程量清单', 'utf16le'),
      Buffer.from([0x00, 0x00]),
      Buffer.from(`${'罍'.repeat(406)}板`, 'utf8'),
    ]);
    const file = makeFile('sheets/fake-garbled.xls', buffer);
    const result = await extractor.extract(file);
    expect(result.text).not.toContain('罍');
    expect(result.text).toContain('拆除工程量清单');
  });

  it('parses OpenXML ZIP disguised as .xls by XML content instead of binary strings', async () => {
    // 真实故障样本：Word 文档（docx/ZIP）被改名 .xls 上传，二进制字符串抽取把 ZIP 流
    // 误读为 GBK 乱码汉字（每个字都不同，可读性过滤无法识别），必须按 ZIP 内 XML 解析
    const jszipMod = await resolveAndImport('jszip');
    const JSZip = ((jszipMod as Record<string, unknown>).default ?? jszipMod) as { new (): { file: (name: string, data: string) => void; generateAsync: (opts: { type: string }) => Promise<Buffer> } };
    const zip = new JSZip();
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>门卫土建工程施工做法说明</w:t></w:r></w:p><w:p><w:r><w:t>砌体工程砂浆强度等级符合设计要求</w:t></w:r></w:p></w:body></w:document>');
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
    const file = makeFile('sheets/disguised-docx.xls', zipBuf);
    const result = await extractor.extract(file);
    expect(result.text).toContain('门卫土建工程施工做法说明');
    expect(result.text).toContain('砌体工程砂浆强度等级符合设计要求');
    expect(result.text).not.toMatch(/[灢漏撿爛]/u); // 无 GBK 误读乱码
    expect(String(result.warnings.join(' '))).toContain('真实格式为 OpenXML ZIP');
  });
});

// ─── 8.6 图纸无字符数据不入库 ─────────────────────────

describe('CAD no-extractable-text (no character data)', () => {
  it('DWG fallback: OLE property-set fragments only → cad_no_extractable_text', async () => {
    // 伪 DWG：仅含 OLE 属性集 XML 片段（DWG 内部结构噪声，无图纸标注字符）
    const buffer = Buffer.concat([
      Buffer.from('<prop_set label="Standard" description="ACAD standard property set" type="dict">', 'utf8'),
      Buffer.from([0x00, 0x01]),
      Buffer.from('<prop_set label="AUDIT_INFO" description="" type="dict">', 'utf8'),
    ]);
    const file = makeFile('cad/fake-notext.dwg', buffer);
    const result = await extractor.extract(file);
    expect(String(result.metadata.contentCoverage)).toBe('cad_no_extractable_text');
    expect(result.text).not.toContain('prop_set');
    expect(result.warnings.join(' ')).toContain('未提取到字符数据');
  });

  it('DWG fallback: sparse numeric fragments only → cad_no_extractable_text', async () => {
    // 零星短碎片（不足最低字符数据阈值）不算"有字符数据"
    const buffer = Buffer.concat([
      Buffer.from('A1 M24', 'utf8'),
      Buffer.from([0x00, 0x01]),
      Buffer.from('0.5', 'utf8'),
    ]);
    const file = makeFile('cad/fake-sparse.dwg', buffer);
    const result = await extractor.extract(file);
    expect(String(result.metadata.contentCoverage)).toBe('cad_no_extractable_text');
  });

  it('DWG fallback: enough annotation text keeps content', async () => {
    // 伪 DWG：含足够多可读中文标注（≥ 最低字符数据阈值），仍正常入库
    const buffer = Buffer.concat([
      Buffer.from('徽光阁项目施工总平面图：建筑定位轴线、标高尺寸及各单体平面布置说明，未经设计院许可不得复制。', 'utf8'),
      Buffer.from([0x00, 0x01, 0x02]),
    ]);
    const file = makeFile('cad/fake-annotated.dwg', buffer);
    const result = await extractor.extract(file);
    expect(String(result.metadata.contentCoverage)).toBe('cad_readable_text_fragments_filtered');
    expect(result.text).toContain('徽光阁');
    expect(Number(result.metadata.characterDataCount)).toBeGreaterThanOrEqual(32);
  });

  it('DXF without text entities → cad_no_extractable_text', async () => {
    // 合法 DXF：只有 LINE 实体、图层为内部默认值 "0"，无任何文字标注
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '8', '0',
      '10', '0.0', '20', '0.0', '30', '0.0',
      '11', '10.0', '21', '10.0', '31', '0.0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const file = makeFile('cad/no-text.dxf', dxf);
    const result = await extractor.extract(file);
    expect(String(result.metadata.contentCoverage)).toBe('cad_no_extractable_text');
    expect(result.text).not.toContain('未提取到文字标注');
  });

  it('DXF with text annotations keeps content', async () => {
    const annotation = '本图纸为徽光阁项目施工总平面图，包含建筑定位轴线、标高尺寸及各单体平面布置说明';
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'TEXT', '8', '建筑标注层',
      '10', '0.0', '20', '0.0', '30', '0.0', '40', '2.5',
      '1', annotation,
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const file = makeFile('cad/annotated.dxf', dxf);
    const result = await extractor.extract(file);
    expect(String(result.metadata.contentCoverage)).toBe('dxf_semantic_layer_block_annotations');
    expect(result.text).toContain('徽光阁');
    expect(Number(result.metadata.characterDataCount)).toBeGreaterThanOrEqual(32);
  });
});

// ─── 9. 各类别的完整流水线 ───────────────────────

describe('Full extraction → chunk → verify', () => {
  const cases: Array<[string, string, string, string]> = [
    ['Python', 'code/test.py', 'def factorial(n):\n    if n <= 1: return 1\n    return n * factorial(n-1)\n\nprint(factorial(5))', 'code'],
    ['Shell', 'code/test.sh', '#!/bin/bash\n# Database backup script\nDB_HOST="${1:-localhost}"\npg_dump -h "$DB_HOST" > backup.sql', 'code'],
    ['TOML', 'code/test.toml', '[package]\nname = "my-app"\nversion = "1.0.0"\n\n[dependencies]\nreact = "^18.0.0"', 'code'],
    ['JSON5', 'data/test.json5', '{ name: "config", debug: true, port: 3000 }', 'data'],
    ['PlantUML', 'diagrams/test.puml', '@startuml\nAlice -> Bob: Authentication Request\nBob --> Alice: Authentication Response\n@enduml', 'diagram'],
    ['SCSS', 'web/test.scss', '.btn {\n  &--primary { background: blue; }\n  &--danger { background: red; }\n}', 'web'],
    ['RST', 'docs/test.rst', 'Title\n=====\n\nSection 1\n---------\n\nContent of section 1.\n\nSection 2\n---------\n\nContent of section 2.', 'document'],
  ];

  it.each(cases)('%s — extract → chunk → valid', async (_name, relPath, content, expectedCategory) => {
    const file = makeFile(relPath, content);
    expect(file.category).toBe(expectedCategory);

    const result = await extractor.extract(file);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.metadata.extractionMode).toBeTruthy();

    // 验证 contentCoverage 不是 metadata_only（除非确实无法解析）
    const coverage = String(result.metadata.contentCoverage ?? '');
    const mode = String(result.metadata.extractionMode ?? '');
    // 这些是"良好"的指示器
    const hasRealContent = mode !== 'metadata_only' && coverage !== 'metadata_filename' && coverage !== 'metadata';
    if (content.length > 20) {
      expect(hasRealContent, `${_name}: should extract real content, got mode=${mode}, coverage=${coverage}`).toBe(true);
    }

    // 分块并验证
    const chunks = chunker.chunk(result.text, file);
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach(c => {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.index).toBeGreaterThanOrEqual(0);
    });
  });
});

// ─── 10. 分类覆盖 ──────────────────────────────

describe('Classifier extension coverage', () => {
  const extCases: Array<[string, string, string]> = [
    ['.mjs', 'code', 'javascript'],
    ['.cjs', 'code', 'javascript'],
    ['.mts', 'code', 'typescript'],
    ['.cts', 'code', 'typescript'],
    ['.pyi', 'code', 'python'],
    ['.ipynb', 'code', 'python'],
    ['.kt', 'code', 'java_kotlin'],
    ['.scala', 'code', 'java_kotlin'],
    ['.cc', 'code', 'c_family'],
    ['.cxx', 'code', 'c_family'],
    ['.h', 'code', 'c_family'],
    ['.hpp', 'code', 'c_family'],
    ['.fish', 'code', 'shell'],
    ['.cfg', 'code', 'config'],
    ['.conf', 'code', 'config'],
    ['.markdown', 'document', 'markdown'],
    ['.mdx', 'document', 'markdown'],
    ['.rtf', 'document', 'office'],
    ['.odt', 'document', 'office'],
    ['.odp', 'document', 'presentation'],
    ['.epub', 'document', 'ebook'],
    ['.mobi', 'document', 'ebook'],
    ['.xls', 'spreadsheet', 'excel'],
    ['.xlsm', 'spreadsheet', 'excel'],
    ['.ods', 'spreadsheet', 'opendoc'],
    ['.tab', 'spreadsheet', 'tsv'],
    ['.yml', 'data', 'yaml'],
    ['.geojson', 'data', 'json'],
    ['.xsd', 'data', 'xml'],
    ['.wsdl', 'data', 'xml'],
    ['.gql', 'data', 'graphql'],
    ['.htm', 'web', 'html'],
    ['.xhtml', 'web', 'html'],
    ['.sass', 'web', 'stylesheet'],
    ['.less', 'web', 'stylesheet'],
    ['.j2', 'web', 'template'],
    ['.jinja2', 'web', 'template'],
    ['.jpeg', 'image', 'raster'],
    ['.gif', 'image', 'raster'],
    ['.bmp', 'image', 'raster'],
    ['.webp', 'image', 'raster'],
    ['.tiff', 'image', 'raster'],
    ['.tif', 'image', 'raster'],
    ['.eps', 'image', 'vector'],
    ['.raw', 'image', 'raw'],
    ['.cr2', 'image', 'raw'],
    ['.dwg', 'cad', 'autocad'],
    ['.dwt', 'cad', 'autocad'],
    ['.stp', 'cad', 'step'],
    ['.p21', 'cad', 'step'],
    ['.igs', 'cad', 'iges'],
    ['.fbx', 'cad', 'mesh'],
    ['.glb', 'cad', 'mesh'],
    ['.gltf', 'cad', 'mesh'],
    ['.sldprt', 'cad', 'solidworks'],
    ['.sldasm', 'cad', 'solidworks'],
    ['.slddrw', 'cad', 'solidworks'],
    ['.3mf', 'cad', 'mesh'],
    ['.dio', 'diagram', 'drawio'],
    ['.vsdx', 'diagram', 'visio'],
    ['.vdx', 'diagram', 'visio'],
    ['.plantuml', 'diagram', 'plantuml'],
    ['.mermaid', 'diagram', 'mermaid'],
    ['.jar', 'other', 'unknown'],
    ['.war', 'other', 'unknown'],
    ['.apk', 'other', 'unknown'],
    ['.tar', 'other', 'unknown'],
    ['.gz', 'other', 'unknown'],
    ['.tgz', 'other', 'unknown'],
    ['.bz2', 'other', 'unknown'],
    ['.rar', 'other', 'unknown'],
    ['.7z', 'other', 'unknown'],
  ];

  it.each(extCases)('%s → %s/%s', (ext, expectedCategory, expectedFormat) => {
    const f = makeFile(`misc/test${ext}`, 'test content');
    expect(f.category, `${ext} category`).toBe(expectedCategory);
    expect(f.format, `${ext} format`).toBe(expectedFormat);
  });
});

// ─── 辅助函数：创建最小 ZIP ────────────────────────────────

async function createMinimalZip(): Promise<Buffer> {
  // 手动创建一个最小的 ZIP 文件
  // ZIP 格式：本地文件头 + 文件数据 + 中央目录 + EOCD
  const fileName = Buffer.from('test.txt', 'ascii');
  const fileContent = Buffer.from('hello', 'ascii');

  // 本地文件头
  const lfh = Buffer.alloc(30 + fileName.length);
  lfh.writeUInt32LE(0x04034b50, 0); // 签名
  lfh.writeUInt16LE(20, 4);          // 所需版本
  lfh.writeUInt16LE(0, 6);           // 标志位
  lfh.writeUInt16LE(0, 8);           // 压缩方式（存储）
  lfh.writeUInt16LE(0, 10);          // 修改时间
  lfh.writeUInt16LE(0, 12);          // 修改日期
  // CRC32 占位符
  lfh.writeUInt32LE(0, 14);
  lfh.writeUInt32LE(fileContent.length, 18); // 压缩后大小
  lfh.writeUInt32LE(fileContent.length, 22); // 未压缩大小
  lfh.writeUInt16LE(fileName.length, 26);    // 文件名长度
  lfh.writeUInt16LE(0, 28);                  // 扩展字段长度
  fileName.copy(lfh, 30);

  // 中央目录
  const cd = Buffer.alloc(46 + fileName.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt32LE(0, 16);
  cd.writeUInt32LE(fileContent.length, 20);
  cd.writeUInt32LE(fileContent.length, 24);
  cd.writeUInt16LE(fileName.length, 28);
  cd.writeUInt16LE(0, 30);            // 扩展
  cd.writeUInt16LE(0, 32);            // 注释
  cd.writeUInt16LE(0, 34);            // 磁盘
  cd.writeUInt16LE(0, 36);            // 内部属性
  cd.writeUInt32LE(0, 38);            // 外部属性
  cd.writeUInt32LE(0, 42);            // 偏移量
  fileName.copy(cd, 46);

  // EOCD（中央目录结尾记录）
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);           // 1 个条目
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(lfh.length + fileContent.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lfh, fileContent, cd, eocd]);
}
