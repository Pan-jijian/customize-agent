import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import { TextChunker } from '../src/chunking/text-chunker.js';
import { FileClassifier } from '../src/classification/classifier.js';
import { resolvePackage, resolveAndImport } from '../src/extraction/module-resolver.js';
import type { ClassifiedFile } from '../src/types.js';

// ─── Setup ────────────────────────────────────────────────────

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
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ─── Helper: verify extraction is healthy ─────────────────────

async function assertExtractionOk(file: ClassifiedFile, desc: string) {
  const result = await extractor.extract(file);
  // Every extraction should return something
  expect(result, `${desc}: result should exist`).toBeDefined();
  expect(result.metadata, `${desc}: metadata should exist`).toBeDefined();

  const mode = result.metadata.extractionMode as string;
  const coverage = result.metadata.contentCoverage as string;

  console.log(`  ${desc}: mode=${mode}, coverage=${coverage}, textLen=${result.text.length}, warnings=${result.warnings.length}`);

  // Record extraction mode for analysis
  return { mode, coverage, textLen: result.text.length, warnings: result.warnings, text: result.text };
}

// ─── 1. Module resolution ─────────────────────────────────────

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

// ─── 2. Document formats ──────────────────────────────────────

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

// ─── 3. Code formats ──────────────────────────────────────────

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

// ─── 4. Data formats ──────────────────────────────────────────

describe('Data extraction', () => {
  it('json5 (.json5)', async () => {
    const file = makeFile('data/test.json5', '{ name: "test", // comment\n  value: 42 }');
    const r = await assertExtractionOk(file, '.json5');
    // Falls back to plain structured text since json5 may not parse as JSON
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

// ─── 5. Web formats ───────────────────────────────────────────

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

// ─── 6. Diagram formats ───────────────────────────────────────

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
    // Falls into diagram structural path (raw text)
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

// ─── 7. Archive formats ───────────────────────────────────────

describe('Archive extraction', () => {
  it('ZIP (.zip) — manifest listing', async () => {
    // Create a minimal zip file in-memory
    const zipBuf = await createMinimalZip();
    const file = makeFile('archives/test.zip', zipBuf);
    const r = await assertExtractionOk(file, '.zip');
    expect(r.mode).toBe('archive_manifest');
    expect(r.text).toContain('test.txt');
  });
});

// ─── 8. CAD formats ───────────────────────────────────────────

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
    // Binary STL header: 80 bytes + 4 byte count
    const header = Buffer.alloc(84);
    header.write('solid TestModel', 0, 'ascii');
    header.writeUInt32LE(1, 80); // 1 triangle
    // Minimal triangle data (50 bytes)
    const tri = Buffer.alloc(50);
    const stl = Buffer.concat([header, tri]);
    const file = makeFile('cad/test.stl', stl);
    const r = await assertExtractionOk(file, '.stl');
    expect(r.text).toContain('TestModel');
  });
});

// ─── 9. Full pipeline for each category ───────────────────────

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

    // Verify contentCoverage is not metadata-only (unless it's truly unparseable)
    const coverage = String(result.metadata.contentCoverage ?? '');
    const mode = String(result.metadata.extractionMode ?? '');
    // These are the "good" indicators
    const hasRealContent = mode !== 'metadata_only' && coverage !== 'metadata_filename' && coverage !== 'metadata';
    if (content.length > 20) {
      expect(hasRealContent, `${_name}: should extract real content, got mode=${mode}, coverage=${coverage}`).toBe(true);
    }

    // Chunk and verify
    const chunks = chunker.chunk(result.text, file);
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach(c => {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.index).toBeGreaterThanOrEqual(0);
    });
  });
});

// ─── 10. Classification coverage ──────────────────────────────

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
    ['.jar', 'archive', 'zip'],
    ['.war', 'archive', 'zip'],
    ['.apk', 'archive', 'zip'],
    ['.tar', 'archive', 'tar'],
    ['.gz', 'archive', 'other'],
    ['.tgz', 'archive', 'tar'],
    ['.bz2', 'archive', 'other'],
    ['.rar', 'archive', 'other'],
    ['.7z', 'archive', 'other'],
  ];

  it.each(extCases)('%s → %s/%s', (ext, expectedCategory, expectedFormat) => {
    const f = makeFile(`misc/test${ext}`, 'test content');
    expect(f.category, `${ext} category`).toBe(expectedCategory);
    expect(f.format, `${ext} format`).toBe(expectedFormat);
  });
});

// ─── Helper: create minimal zip ────────────────────────────────

async function createMinimalZip(): Promise<Buffer> {
  // Create a minimal ZIP file manually
  // ZIP format: Local File Header + File Data + Central Directory + EOCD
  const fileName = Buffer.from('test.txt', 'ascii');
  const fileContent = Buffer.from('hello', 'ascii');

  // Local file header
  const lfh = Buffer.alloc(30 + fileName.length);
  lfh.writeUInt32LE(0x04034b50, 0); // signature
  lfh.writeUInt16LE(20, 4);          // version needed
  lfh.writeUInt16LE(0, 6);           // flags
  lfh.writeUInt16LE(0, 8);           // compression (stored)
  lfh.writeUInt16LE(0, 10);          // mod time
  lfh.writeUInt16LE(0, 12);          // mod date
  // CRC32 placeholder
  lfh.writeUInt32LE(0, 14);
  lfh.writeUInt32LE(fileContent.length, 18); // compressed size
  lfh.writeUInt32LE(fileContent.length, 22); // uncompressed size
  lfh.writeUInt16LE(fileName.length, 26);    // filename length
  lfh.writeUInt16LE(0, 28);                  // extra field length
  fileName.copy(lfh, 30);

  // Central directory
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
  cd.writeUInt16LE(0, 30);            // extra
  cd.writeUInt16LE(0, 32);            // comment
  cd.writeUInt16LE(0, 34);            // disk
  cd.writeUInt16LE(0, 36);            // internal attrs
  cd.writeUInt32LE(0, 38);            // external attrs
  cd.writeUInt32LE(0, 42);            // offset
  fileName.copy(cd, 46);

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);           // 1 entry
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(lfh.length + fileContent.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lfh, fileContent, cd, eocd]);
}
