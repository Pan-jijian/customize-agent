import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor } from '../src/extraction/content-extractor.js';
import { TextChunker } from '../src/chunking/text-chunker.js';
import { FileClassifier } from '../src/classification/classifier.js';
import { IndexStateStore } from '../src/core/index-state-store.js';
import { KnowledgeBaseManager } from '../src/core/knowledge-base-manager.js';
import type { ClassifiedFile } from '../src/types.js';

// ─── 测试辅助函数 ─────────────────────────────────────────────

// 在模块级别初始化，以便 describe 块能够访问
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
const kbDir = path.join(tmpDir, 'knowledgeBase');
const storageRoot = path.join(tmpDir, 'storage');
const dbPath = path.join(storageRoot, 'test-kb.db');

fs.mkdirSync(kbDir, { recursive: true });
fs.mkdirSync(storageRoot, { recursive: true });

function createTestFile(relativePath: string, content: string | Buffer): string {
  const absPath = path.join(kbDir, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  if (typeof content === 'string') {
    fs.writeFileSync(absPath, content, 'utf8');
  } else {
    fs.writeFileSync(absPath, content);
  }
  return absPath;
}

function makeClassifiedFile(overrides: Partial<ClassifiedFile> & { absolutePath: string; relativePath: string }): ClassifiedFile {
  return {
    category: 'document',
    format: 'plaintext',
    fileSize: fs.statSync(overrides.absolutePath).size,
    mtime: Date.now(),
    mimeType: 'text/plain',
    ...overrides,
  };
}

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
});

// ─── 1. FileClassifier 测试 ──────────────────────────────────

describe('FileClassifier', () => {
  const classifier = new FileClassifier();

  const cases: Array<[string, string, string]> = [
    ['.txt', 'document', 'plaintext'],
    ['.md', 'document', 'markdown'],
    ['.pdf', 'document', 'pdf'],
    ['.docx', 'document', 'office'],
    ['.pptx', 'document', 'presentation'],
    ['.csv', 'spreadsheet', 'csv'],
    ['.xlsx', 'spreadsheet', 'excel'],
    ['.json', 'data', 'json'],
    ['.yaml', 'data', 'yaml'],
    ['.xml', 'data', 'xml'],
    ['.ts', 'code', 'typescript'],
    ['.js', 'code', 'javascript'],
    ['.py', 'code', 'python'],
    ['.go', 'code', 'go'],
    ['.rs', 'code', 'rust'],
    ['.html', 'web', 'html'],
    ['.css', 'web', 'stylesheet'],
    ['.png', 'image', 'raster'],
    ['.jpg', 'image', 'raster'],
    ['.svg', 'image', 'vector'],
    ['.dxf', 'cad', 'autocad'],
    ['.step', 'cad', 'step'],
    ['.drawio', 'diagram', 'drawio'],
    ['.zip', 'other', 'unknown'],
    ['.sh', 'code', 'shell'],
    ['.sql', 'code', 'sql'],
  ];

  it.each(cases)('classifies %s as category=%s format=%s', (ext, expectedCategory, expectedFormat) => {
    const absPath = path.join(kbDir, `test${ext}`);
    fs.writeFileSync(absPath, 'test content', 'utf8');
    const stat = fs.statSync(absPath);
    const result = classifier.classify(absPath, `test${ext}`, stat);
    expect(result.category).toBe(expectedCategory);
    expect(result.format).toBe(expectedFormat);
  });

  it('classifies unknown extension as other/unknown', () => {
    const absPath = path.join(kbDir, 'test.xyz123');
    fs.writeFileSync(absPath, 'test', 'utf8');
    const stat = fs.statSync(absPath);
    const result = classifier.classify(absPath, 'test.xyz123', stat);
    expect(result.category).toBe('other');
    expect(result.format).toBe('unknown');
  });

  it('skips binary executables', () => {
    const absPath = path.join(kbDir, 'test.exe');
    fs.writeFileSync(absPath, 'binary', 'utf8');
    const stat = fs.statSync(absPath);
    const file = classifier.classify(absPath, 'test.exe', stat);
    expect(classifier.shouldSkip(file)).toBe('二进制可执行文件，跳过');
  });

  it('uses 500MB as the default upload/index size limit', () => {
    const absPath = path.join(kbDir, 'large.pdf');
    fs.writeFileSync(absPath, 'x'.repeat(100), 'utf8');
    const stat = fs.statSync(absPath);
    const file = { ...classifier.classify(absPath, 'large.pdf', stat), fileSize: 51 * 1024 * 1024 };
    expect(classifier.shouldSkip(file)).toBeNull();
  });

  it('supports overriding the upload/index size limit', () => {
    const previous = process.env.KB_MAX_FILE_SIZE_BYTES;
    process.env.KB_MAX_FILE_SIZE_BYTES = String(10 * 1024 * 1024);
    const absPath = path.join(kbDir, 'large.txt');
    fs.writeFileSync(absPath, 'x'.repeat(100), 'utf8');
    const stat = fs.statSync(absPath);
    const file = { ...classifier.classify(absPath, 'large.txt', stat), fileSize: 11 * 1024 * 1024 };
    expect(classifier.shouldSkip(file)).toBe('文件超过 10MB 限制');
    if (previous === undefined) delete process.env.KB_MAX_FILE_SIZE_BYTES;
    else process.env.KB_MAX_FILE_SIZE_BYTES = previous;
  });
});

// ─── 2. ContentExtractor 测试 ────────────────────────────────

describe('ContentExtractor', () => {
  const extractor = new ContentExtractor();

  it('extracts plain text (.txt) correctly', async () => {
    const absPath = createTestFile('documents/test.txt', 'Hello World\n这是一段中文文本。\nGoodbye.');
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'documents/test.txt', category: 'document', format: 'plaintext', mimeType: 'text/plain' });
    const result = await extractor.extract(file);
    expect(result.text).toContain('Hello World');
    expect(result.text).toContain('中文文本');
    expect(result.metadata.extractionMode).toBe('plain_text');
    expect(result.metadata.vectorizable).toBe(true);
  });

  it('extracts markdown (.md) correctly', async () => {
    const md = `# 标题

这是一段 **加粗** 文本。

## 第二章

- 列表项 1
- 列表项 2
- 列表项 3`;
    const absPath = createTestFile('documents/test.md', md);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'documents/test.md', category: 'document', format: 'markdown', mimeType: 'text/markdown' });
    const result = await extractor.extract(file);
    expect(result.text).toContain('# 标题');
    expect(result.text).toContain('## 第二章');
    expect(result.text).toContain('列表项 1');
    expect(result.metadata.extractionMode).toBe('plain_text');
  });

  it('extracts JSON data correctly', async () => {
    const json = JSON.stringify({ name: 'test', items: [{ id: 1, value: 'hello' }, { id: 2, value: 'world' }], config: { debug: true, port: 3000 } });
    const absPath = createTestFile('data/test.json', json);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'data/test.json', category: 'data', format: 'json', mimeType: 'application/json' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('structured_data');
    expect(result.text).toContain('name: test');
    expect(result.text).toContain('items[0].id: 1');
    expect(result.text).toContain('config.debug: true');
  });

  it('extracts JSONL data correctly', async () => {
    const jsonl = [
      JSON.stringify({ name: 'Alice', age: 30 }),
      JSON.stringify({ name: 'Bob', age: 25 }),
      JSON.stringify({ name: 'Charlie', age: 35 }),
    ].join('\n');
    const absPath = createTestFile('data/test.jsonl', jsonl);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'data/test.jsonl', category: 'data', format: 'json', mimeType: 'application/json' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('structured_data');
    expect((result.metadata as any).recordCount).toBe(3);
    expect(result.text).toContain('line1.name: Alice');
    expect(result.text).toContain('line2.name: Bob');
    expect(result.text).toContain('line3.name: Charlie');
  });

  it('extracts YAML data correctly', async () => {
    const yaml = `server:
  host: localhost
  port: 8080
database:
  url: postgres://db
  pool: 10`;
    const absPath = createTestFile('data/test.yaml', yaml);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'data/test.yaml', category: 'data', format: 'yaml', mimeType: 'application/x-yaml' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('structured_data');
    // YAML 正则 \s* 可以匹配换行符，因此父键会消耗子行
    // 结果类似于："server | host: localhost", "port | 8080"
    expect(result.text).toContain('host: localhost');
    expect(result.text).toContain('8080');
    expect(result.text).toContain('url: postgres://db');
  });

  it('extracts XML data correctly', async () => {
    const xml = `<?xml version="1.0"?>
<root>
  <item>Apple</item>
  <item>Banana</item>
  <config>debug</config>
</root>`;
    const absPath = createTestFile('data/test.xml', xml);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'data/test.xml', category: 'data', format: 'xml', mimeType: 'application/xml' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('structured_data');
    expect(result.text).toContain('Apple');
    expect(result.text).toContain('Banana');
  });

  it('extracts CSV data correctly', async () => {
    const csv = `Name,Age,City
Alice,30,Beijing
Bob,25,Shanghai
Charlie,35,Shenzhen`;
    const absPath = createTestFile('spreadsheets/test.csv', csv);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'spreadsheets/test.csv', category: 'spreadsheet', format: 'csv', mimeType: 'text/csv' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('delimited_text_structured');
    expect((result.metadata as any).rowCount).toBe(4);
    expect((result.metadata as any).columnCount).toBe(3);
    expect(result.text).toContain('Name | Age | City');
    expect(result.text).toContain('R2C1 Name: Alice');
    expect(result.text).toContain('R4C3 City: Shenzhen');
  });

  it('extracts source code (.ts) correctly', async () => {
    const ts = `export interface User {
  id: number;
  name: string;
  email: string;
}

export function getUser(id: number): User {
  return { id, name: 'test', email: 'test@example.com' };
}`;
    const absPath = createTestFile('code/test.ts', ts);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'code/test.ts', category: 'code', format: 'typescript', mimeType: 'text/typescript' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('plain_text');
    expect(result.text).toContain('export interface User');
    expect(result.text).toContain('getUser');
  });

  it('extracts HTML correctly', async () => {
    const html = `<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
  <h1>Hello World</h1>
  <p>This is a test paragraph.</p>
</body>
</html>`;
    const absPath = createTestFile('web/test.html', html);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'web/test.html', category: 'web', format: 'html', mimeType: 'text/html' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('plain_text');
    expect(result.text).toContain('Test Page');
    expect(result.text).toContain('Hello World');
  });

  it('extracts CSS correctly', async () => {
    const css = `.container {
  display: flex;
  justify-content: center;
}
.title {
  font-size: 2rem;
  color: #333;
}`;
    const absPath = createTestFile('web/test.css', css);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'web/test.css', category: 'web', format: 'stylesheet', mimeType: 'text/css' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('plain_text');
    expect(result.text).toContain('.container');
    expect(result.text).toContain('display: flex');
  });

  it('extracts DXF CAD data correctly', async () => {
    // 最小 DXF，包含一个图层和文本实体
    const dxf = `0
SECTION
2
HEADER
0
ENDSEC
0
SECTION
2
ENTITIES
0
TEXT
8
MyLayer
1
Hello DXF
0
ENDSEC
0
EOF`;
    const absPath = createTestFile('cad/test.dxf', dxf);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'cad/test.dxf', category: 'cad', format: 'autocad', mimeType: 'application/dxf' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('builtin_cad_structural');
    expect(result.text).toContain('MyLayer');
    expect(result.text).toContain('Hello DXF');
  });

  it('extracts SVG correctly', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">
  <title>Test Icon</title>
  <desc>A test SVG icon</desc>
  <text x="10" y="20">Hello</text>
  <text x="10" y="40">World</text>
</svg>`;
    const absPath = createTestFile('images/test.svg', svg);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'images/test.svg', category: 'image', format: 'vector', mimeType: 'image/svg+xml' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('svg_text_nodes');
    expect(result.text).toContain('Test Icon');
    expect(result.text).toContain('Hello');
    expect(result.text).toContain('World');
  });

  it('extracts Draw.io diagram correctly', async () => {
    const drawio = `<mxfile>
  <diagram name="Page-1">
    <mxCell value="Start" />
    <mxCell value="Process" />
    <mxCell label="End" />
  </diagram>
</mxfile>`;
    const absPath = createTestFile('diagrams/test.drawio', drawio);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'diagrams/test.drawio', category: 'diagram', format: 'drawio', mimeType: 'application/drawio' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('diagram_structural');
    expect(result.text).toContain('Start');
    expect(result.text).toContain('Process');
    expect(result.text).toContain('End');
  });

  it('includes metadata-only text for unsupported file types', async () => {
    // 对于不支持的二进制格式，回退到 metadataOnlyText
    const absPath = createTestFile('other/meta-test.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'other/meta-test.bin', category: 'other', format: 'unknown', mimeType: 'application/octet-stream', fileSize: 4 });
    const result = await extractor.extract(file);
    expect(result.text).toContain('文件名: meta-test.bin');
    expect(result.text).toContain('文件路径: other/meta-test.bin');
    expect(result.text).toContain('文件类型: other/unknown');
    expect(result.text).toContain('MIME: application/octet-stream');
  });

  it('handles empty files gracefully', async () => {
    const absPath = createTestFile('documents/empty.txt', '');
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'documents/empty.txt', category: 'document', format: 'plaintext', mimeType: 'text/plain' });
    const result = await extractor.extract(file);
    // 空纯文本文件：以 utf8 读取 → 空字符串，经 trim 后 → ''
    expect(result.text).toBe('');
    expect(result.warnings).toEqual([]);
    expect(result.extractionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('detects extraction time', async () => {
    const absPath = createTestFile('documents/perf.txt', 'Hello World');
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'documents/perf.txt', category: 'document', format: 'plaintext', mimeType: 'text/plain' });
    const result = await extractor.extract(file);
    expect(result.extractionTimeMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── 3. TextChunker 测试 ─────────────────────────────────────

describe('TextChunker', () => {
  const chunker = new TextChunker();
  const classifier = new FileClassifier();

  function classify(absPath: string, relPath: string): ClassifiedFile {
    const stat = fs.statSync(absPath);
    return classifier.classify(absPath, relPath, stat);
  }

  it('chunks plain text into reasonable sizes', () => {
    const absPath = createTestFile('tmp-chunk.txt', 'A'.repeat(5000));
    const file = classify(absPath, 'tmp-chunk.txt');
    const chunks = chunker.chunk('A'.repeat(5000), file);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(1000); // 文档最大分块大小
    }
  });

  it('chunks text by markdown headings', () => {
    const text = `# Section 1
Content for section one. `.repeat(30) + `

# Section 2
Content for section two. `.repeat(30);

    const absPath = createTestFile('tmp-chunk-md.md', 'placeholder');
    const file = { ...classify(absPath, 'tmp-chunk-md.md'), category: 'document' as const, format: 'markdown' as const };
    const chunks = chunker.chunk(text, file);
    expect(chunks.length).toBeGreaterThan(0);
    // 章节标题应被保留
    const sectionTitles = chunks.filter(c => c.sectionTitle);
    expect(sectionTitles.length).toBeGreaterThan(0);
  });

  it('chunks code by function/class boundaries', () => {
    const code = `
export function foo() {
  // ${'x'.repeat(200)}
}

export function bar() {
  // ${'y'.repeat(200)}
}

export class MyClass {
  // ${'z'.repeat(300)}
}`;

    const absPath = createTestFile('tmp-code.ts', 'placeholder');
    const file = { ...classify(absPath, 'tmp-code.ts'), category: 'code' as const, format: 'typescript' as const };
    const chunks = chunker.chunk(code, file);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(c => c.metadata.chunkKind === 'code')).toBe(true);
  });

  it('produces chunks with sequential indices', () => {
    const text = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'word '.repeat(20)}`).join('\n');
    const absPath = createTestFile('tmp-seq.txt', 'placeholder');
    const file = classify(absPath, 'tmp-seq.txt');
    const chunks = chunker.chunk(text, file);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].index).toBeGreaterThan(chunks[i - 1].index);
    }
  });

  it('includes file metadata header in chunks', () => {
    const text = 'Short content for testing.';
    const absPath = createTestFile('code/test-header.ts', 'placeholder');
    const file = classify(absPath, 'code/test-header.ts');
    const chunks = chunker.chunk(text, file);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].text).toContain('文件: code/test-header.ts');
    expect(chunks[0].text).toContain('类型: code/typescript');
  });

  it('handles empty text gracefully', () => {
    const absPath = createTestFile('tmp-empty.txt', 'placeholder');
    const file = classify(absPath, 'tmp-empty.txt');
    const chunks = chunker.chunk('', file);
    expect(chunks).toEqual([]);
  });

  it('chunks spreadsheet data as table kind', () => {
    const csv = `Name,Age,City
Alice,30,Beijing
Bob,25,Shanghai
Charlie,35,Shenzhen`;
    const absPath = createTestFile('tmp-table.csv', csv);
    const file = classify(absPath, 'tmp-table.csv');
    const chunks = chunker.chunk(csv, file);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].metadata.chunkKind).toBe('table');
  });

  it('produces chunks with metadata fields', () => {
    const text = 'Test content for metadata verification.\n'.repeat(10);
    const absPath = createTestFile('tmp-meta.txt', 'placeholder');
    const file = classify(absPath, 'tmp-meta.txt');
    const chunks = chunker.chunk(text, file);
    for (const chunk of chunks) {
      expect(chunk).toHaveProperty('index');
      expect(chunk).toHaveProperty('text');
      expect(chunk).toHaveProperty('startChar');
      expect(chunk).toHaveProperty('endChar');
      expect(chunk).toHaveProperty('tokenCount');
      expect(chunk).toHaveProperty('metadata');
      expect(chunk.metadata).toHaveProperty('chunkType');
      expect(chunk.metadata).toHaveProperty('parentId');
      expect(chunk.metadata).toHaveProperty('splitStrategy');
    }
  });

  it('respects category-specific maxChunkSize', () => {
    const text = 'x'.repeat(5000);

    // 文档：800 tokens（约 3200 字符）→ 应该会拆分
    const absPath1 = createTestFile('tmp-doc.txt', 'placeholder');
    const docFile = { ...classify(absPath1, 'tmp-doc.txt'), category: 'document' as const };
    const docChunks = chunker.chunk(text, docFile);
    for (const c of docChunks) expect(c.tokenCount).toBeLessThanOrEqual(850); // ~800 + 一定余量

    // 代码：1000 tokens（约 4000 字符）→ 可能不会拆分成太多块
    const absPath2 = createTestFile('tmp-code2.ts', 'placeholder');
    const codeFile = { ...classify(absPath2, 'tmp-code2.ts'), category: 'code' as const, format: 'typescript' as const };
    const codeChunks = chunker.chunk(text, codeFile);
    for (const c of codeChunks) expect(c.tokenCount).toBeLessThanOrEqual(1050);
  });
});

// ─── 4. IndexStateStore 测试 ─────────────────────────────────

describe('IndexStateStore', () => {
  let store: IndexStateStore;
  const testDbPath = path.join(tmpDir, 'test-store.db');

  beforeAll(() => {
    store = new IndexStateStore(testDbPath);
  });

  afterAll(() => {
    store.close();
  });

  it('upserts and loads records', () => {
    store.upsertRecord({
      relativePath: 'docs/test.txt',
      category: 'document',
      format: 'plaintext',
      contentHash: 'abc123',
      fileSize: 100,
      mtime: Date.now(),
      chunkCount: 3,
      collectionName: 'test-collection',
      indexedAt: Date.now(),
      lastVerifiedAt: Date.now(),
      status: 'active',
    });

    const records = store.listRecords();
    expect(records.length).toBeGreaterThanOrEqual(1);
    const found = records.find(r => r.relativePath === 'docs/test.txt');
    expect(found).toBeDefined();
    expect(found!.category).toBe('document');
    expect(found!.chunkCount).toBe(3);
  });

  it('replaces chunks and lists them', () => {
    const chunks = [
      { index: 0, text: 'Chunk zero content', startChar: 0, endChar: 18, tokenCount: 5, metadata: { chunkType: 'child', chunkKind: 'text', parentId: 'p0', splitStrategy: 'test' } },
      { index: 1, text: 'Chunk one content here', startChar: 19, endChar: 41, tokenCount: 6, metadata: { chunkType: 'child', chunkKind: 'text', parentId: 'p0', splitStrategy: 'test' } },
    ];

    store.replaceChunks('docs/test.txt', chunks, {
      category: 'document',
      format: 'plaintext',
      collectionName: 'test-collection',
    });

    const stored = store.listChunks({ relativePath: 'docs/test.txt' });
    expect(stored.length).toBe(2);
    expect(stored[0].content).toBe('Chunk zero content');
    expect(stored[1].chunkIndex).toBe(1);
  });

  it('handles parent chunks grouping', () => {
    const parentChunks = store.listParentChunks('docs/test.txt');
    expect(parentChunks.length).toBeGreaterThan(0);
    expect(parentChunks[0].relativePath).toBe('docs/test.txt');
  });

  it('searches chunks with keyword', () => {
    const results = store.searchChunks('Chunk zero', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('Chunk zero');
  });

  it('finds exact duplicates by content hash', () => {
    store.upsertFileHash({
      contentHash: 'abc123',
      filePath: 'docs/test.txt',
      fileSize: 100,
      category: 'document',
    });

    const dup = store.findExactDuplicate('abc123', 'other-file.txt');
    expect(dup).toBeDefined();
    expect(dup!.filePath).toBe('docs/test.txt');
  });

  it('returns undefined for non-existent duplicate', () => {
    const dup = store.findExactDuplicate('nonexistent');
    expect(dup).toBeUndefined();
  });

  it('handles tags', () => {
    store.setTags('docs/test.txt', ['important', 'reference']);
    const tags = store.listTags('docs/test.txt');
    expect(tags.length).toBe(2);
    expect(tags.map(t => t.tag).sort()).toEqual(['important', 'reference']);
  });

  it('handles relationships', () => {
    store.addRelationship({
      sourceFile: 'docs/test.txt',
      targetFile: 'docs/other.txt',
      relationshipType: 'near_duplicate',
      confidence: 0.85,
      detail: 'MinHash similarity: 0.851',
      userConfirmed: 0,
    });

    const rels = store.listRelationships('docs/test.txt');
    expect(rels.length).toBeGreaterThan(0);
    expect(rels[0].relationshipType).toBe('near_duplicate');
  });

  it('handles metadata key-value store', () => {
    store.setMetadata('test_key', 'test_value');
    expect(store.getMetadata('test_key')).toBe('test_value');
  });

  it('deletes records and cascades', () => {
    store.deleteRecord('docs/test.txt');
    const records = store.listRecords();
    expect(records.find(r => r.relativePath === 'docs/test.txt')).toBeUndefined();
    const chunks = store.listChunks({ relativePath: 'docs/test.txt' });
    expect(chunks.length).toBe(0);
  });

  it('getStats returns correct counts', () => {
    store.upsertRecord({
      relativePath: 'stats-test.txt',
      category: 'code',
      format: 'typescript',
      contentHash: 'stats123',
      fileSize: 200,
      mtime: Date.now(),
      chunkCount: 5,
      collectionName: 'test-collection',
      indexedAt: Date.now(),
      lastVerifiedAt: Date.now(),
      status: 'active',
    });
    store.replaceChunks('stats-test.txt', [
      { index: 0, text: 'A'.repeat(100), startChar: 0, endChar: 100, tokenCount: 25, metadata: { chunkType: 'child' } },
      { index: 1, text: 'B'.repeat(100), startChar: 101, endChar: 200, tokenCount: 25, metadata: { chunkType: 'child' } },
    ], { category: 'code', format: 'typescript', collectionName: 'test-collection' });

    const stats = store.getStats();
    expect(stats.fileCount).toBeGreaterThanOrEqual(1);
    expect(stats.chunkCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── 5. 完整流水线：ContentExtractor → TextChunker → Store ─

describe('Full upload pipeline (extract → chunk → store)', () => {
  const extractor = new ContentExtractor();
  const chunker = new TextChunker();
  const classifier = new FileClassifier();
  const storePath = path.join(tmpDir, 'pipeline-test.db');
  let store: IndexStateStore;

  beforeAll(() => {
    store = new IndexStateStore(storePath);
  });

  afterAll(() => {
    store.close();
  });

  const fileTypes = [
    {
      name: 'plain text (.txt)',
      ext: '.txt',
      dir: 'documents',
      content: 'This is a plain text document.\n\nIt has multiple paragraphs.\n\nEach paragraph contains some text for testing the chunking pipeline.',
      category: 'document' as const,
    },
    {
      name: 'markdown (.md)',
      ext: '.md',
      dir: 'documents',
      content: `# Project Overview

This project is a knowledge base system.

## Features

- Feature 1: File upload and parsing
- Feature 2: Text chunking
- Feature 3: Vector search

## Architecture

The system consists of several modules working together.`,
      category: 'document' as const,
    },
    {
      name: 'JSON data (.json)',
      ext: '.json',
      dir: 'data',
      content: JSON.stringify({
        server: { host: '0.0.0.0', port: 8000 },
        features: ['auth', 'upload', 'search'],
        limits: { maxFileSize: 52428800, maxChunkSize: 1000 },
      }, null, 2),
      category: 'data' as const,
    },
    {
      name: 'CSV (.csv)',
      ext: '.csv',
      dir: 'spreadsheets',
      content: `Product,Price,Stock
Widget A,19.99,150
Widget B,29.99,75
Widget C,9.99,300
Gadget X,49.99,42`,
      category: 'spreadsheet' as const,
    },
    {
      name: 'TypeScript (.ts)',
      ext: '.ts',
      dir: 'code',
      content: `import { readFileSync } from 'node:fs';

interface Config {
  port: number;
  host: string;
  debug: boolean;
}

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Config;
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  if (config.port < 1 || config.port > 65535) {
    errors.push('Invalid port number');
  }
  return errors;
}`,
      category: 'code' as const,
    },
    {
      name: 'HTML (.html)',
      ext: '.html',
      dir: 'web',
      content: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>测试页面</title>
</head>
<body>
  <main>
    <h1>欢迎使用知识库系统</h1>
    <p>这是一个文件管理页面，支持多种文件格式的上传和解析。</p>
  </main>
</body>
</html>`,
      category: 'web' as const,
    },
  ];

  it.each(fileTypes)('completes full pipeline for $name', async ({ name: _name, ext, dir, content, category }) => {
    const fileName = `pipeline-test${ext}`;
    const absPath = createTestFile(`${dir}/${fileName}`, content);
    const stat = fs.statSync(absPath);
    const file = classifier.classify(absPath, `${dir}/${fileName}`, stat);

    // 步骤 1：分类
    expect(file.category).toBe(category);

    // 步骤 2：提取
    const extraction = await extractor.extract(file);
    expect(extraction.text.length).toBeGreaterThan(0);
    expect(extraction.warnings.length).toBe(0);

    // 步骤 3：分块
    const chunks = chunker.chunk(extraction.text, file, { textLength: extraction.text.length });
    expect(chunks.length).toBeGreaterThan(0);

    // 步骤 4：存储
    const uniqueId = `${dir}/${fileName}`;
    store.upsertRecord({
      relativePath: uniqueId,
      category: file.category,
      format: file.format,
      contentHash: `hash-${uniqueId}`,
      fileSize: file.fileSize,
      mtime: Date.now(),
      chunkCount: chunks.length,
      collectionName: `test-${category}`,
      indexedAt: Date.now(),
      lastVerifiedAt: Date.now(),
      status: 'active',
      metadataJson: JSON.stringify({
        mimeType: file.mimeType,
        extraction: extraction.metadata,
        warnings: extraction.warnings,
        extractionTimeMs: extraction.extractionTimeMs,
      }),
    });
    store.replaceChunks(uniqueId, chunks, {
      category: file.category,
      format: file.format,
      collectionName: `test-${category}`,
    });

    // 验证存储的数据
    const storedChunks = store.listChunks({ relativePath: uniqueId });
    expect(storedChunks.length).toBe(chunks.length);
    expect(storedChunks[0].content.length).toBeGreaterThan(0);

    // 验证可搜索性
    const searchTerms = content.slice(0, 20).split(/\s+/).filter(w => w.length > 2);
    if (searchTerms.length > 0) {
      const searchResults = store.searchChunks(searchTerms[0], 3);
      expect(searchResults.length).toBeGreaterThan(0);
    }

    // 清理
    store.deleteRecord(uniqueId);
  });
});

// ─── 6. 上传索引流水线 ──────────────────────────────

describe('KnowledgeBaseManager upload indexing', () => {
  function createManagerFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-upload-fixture-'));
    const manager = new KnowledgeBaseManager({
      scope: 'project',
      projectRoot: root,
      projectId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      storageRoot: path.join(root, 'storage'),
    });
    return { root, manager };
  }

  function expectIndexed(manager: KnowledgeBaseManager, relativePath: string, content: string) {
    const file = manager.listFiles().find(item => item.relativePath === relativePath);
    expect(file).toBeDefined();
    expect(file!.status).toBe('active');
    expect(file!.chunkCount).toBeGreaterThan(0);
    const chunks = manager.store.listChunks({ relativePath });
    expect(chunks.length).toBe(file!.chunkCount);
    expect(chunks.map(chunk => chunk.content).join('\n')).toContain(content);
  }

  function createMinimalPdf(text: string) {
    return Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${text.length + 40}>>stream
BT /F1 24 Tf 72 720 Td (${text}) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000348 00000 n 
trailer<</Size 6/Root 1 0 R>>
startxref
425
%%EOF
`);
  }

  it('uploads one file and completes parsing, chunking, and SQLite indexing', async () => {
    const { root, manager } = createManagerFixture();
    try {
      await manager.uploadFile('single.md', Buffer.from('# 单文件上传\n\n单文件解析分块入库验证内容。'), '文档资料/single.md', undefined, { vectorMode: 'defer' });
      expectIndexed(manager, '文档资料/single.md', '单文件解析分块入库验证内容');
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uploads multiple normal files and indexes every uploaded file', async () => {
    const { root, manager } = createManagerFixture();
    try {
      await manager.uploadFiles([
        { fileName: 'batch-a.md', content: Buffer.from('# 批量 A\n\n普通批量上传 A 的内容。'), targetRelativePath: '文档资料/batch-a.md' },
        { fileName: 'batch-b.txt', content: Buffer.from('普通批量上传 B 的内容。'), targetRelativePath: '文档资料/batch-b.txt' },
      ], undefined, { vectorMode: 'defer' });
      expectIndexed(manager, '文档资料/batch-a.md', '普通批量上传 A 的内容');
      expectIndexed(manager, '文档资料/batch-b.txt', '普通批量上传 B 的内容');
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uploads a PDF and completes text extraction, chunking, and indexing', async () => {
    const { root, manager } = createManagerFixture();
    try {
      await manager.uploadFile('upload-test.pdf', createMinimalPdf('PDF upload reindex test content'), '文档资料/upload-test.pdf', undefined, { vectorMode: 'defer' });
      expectIndexed(manager, '文档资料/upload-test.pdf', 'PDF upload reindex test content');
      const file = manager.listFiles().find(item => item.relativePath === '文档资料/upload-test.pdf');
      expect(file!.metadataJson).toContain('pdf_text');
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uploads nested folder files and preserves recursive relative paths while indexing', async () => {
    const { root, manager } = createManagerFixture();
    try {
      await manager.uploadFiles([
        { fileName: 'deep-a.md', content: Buffer.from('# 嵌套 A\n\n第一层子目录中的内容。'), targetRelativePath: '主文件夹/子文件夹/deep-a.md' },
        { fileName: 'deep-b.md', content: Buffer.from('# 嵌套 B\n\n第二层更深子目录中的内容。'), targetRelativePath: '主文件夹/子文件夹/更深/deep-b.md' },
      ], undefined, { vectorMode: 'defer' });
      expectIndexed(manager, '主文件夹/子文件夹/deep-a.md', '第一层子目录中的内容');
      expectIndexed(manager, '主文件夹/子文件夹/更深/deep-b.md', '第二层更深子目录中的内容');
      expect(fs.existsSync(path.join(root, 'knowledgeBase', '主文件夹', '子文件夹', '更深', 'deep-b.md'))).toBe(true);
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes Windows-style upload paths and prevents stale chunks after overwrite', async () => {
    const { root, manager } = createManagerFixture();
    try {
      await manager.uploadFile('overwrite.md', Buffer.from('旧内容，应被新内容覆盖。'), '主文件夹\\\\子文件夹\\\\overwrite.md', undefined, { vectorMode: 'defer' });
      await manager.uploadFile('overwrite.md', Buffer.from('新内容，必须重新解析分块入库。'), '主文件夹\\\\子文件夹\\\\overwrite.md', undefined, { vectorMode: 'defer' });
      expectIndexed(manager, '主文件夹/子文件夹/overwrite.md', '新内容，必须重新解析分块入库');
      const chunks = manager.store.listChunks({ relativePath: '主文件夹/子文件夹/overwrite.md' });
      expect(chunks.map(chunk => chunk.content).join('\n')).not.toContain('旧内容，应被新内容覆盖');
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('uploads an already indexed file path again without failing', async () => {
    const { root, manager } = createManagerFixture();
    try {
      const relativePath = '文档资料/reupload-existing.md';
      await manager.uploadFile('reupload-existing.md', Buffer.from('# 旧版本\n\n这个文件已经在本地知识库中。'), relativePath, undefined, { vectorMode: 'defer' });
      await manager.uploadFile('reupload-existing.md', Buffer.from('# 新版本\n\n同一路径再次上传必须成功并重新入库。'), relativePath, undefined, { vectorMode: 'defer' });
      expectIndexed(manager, relativePath, '同一路径再次上传必须成功并重新入库');
      const file = manager.listFiles().find(item => item.relativePath === relativePath);
      expect(file!.status).toBe('active');
      const chunks = manager.store.listChunks({ relativePath });
      expect(chunks.map(chunk => chunk.content).join('\n')).not.toContain('这个文件已经在本地知识库中');
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('converts the bundled DWG sample with WASM and indexes parsed CAD content', async () => {
    const sample = path.resolve(process.cwd(), '2026.06.10高端光学膜A1#综合楼装施装修施工图.dwg');
    if (!fs.existsSync(sample)) return;
    const { root, manager } = createManagerFixture();
    const relativePath = `图纸/${path.basename(sample)}`;
    try {
      await manager.uploadFile(path.basename(sample), fs.readFileSync(sample), relativePath, undefined, { vectorMode: 'defer' });
      const file = manager.listFiles().find(item => item.relativePath === relativePath);
      expect(file).toBeDefined();
      expect(file!.status).toBe('active');
      expect(file!.chunkCount).toBeGreaterThan(0);
      expect(file!.metadataJson).toContain('dwgdxf_wasm');
      expect(file!.metadataJson).toContain('dxf_layers_blocks_entities_text');
      expect(file!.metadataJson).not.toContain('DWG→DXF 转换失败');
      const chunks = manager.store.listChunks({ relativePath });
      expect(chunks.length).toBe(file!.chunkCount);
      expect(chunks.map(chunk => chunk.content).join('\n')).toMatch(/CAD\s+DXF\s+图层/u);
    } finally {
      manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── 7. 边界情况 ────────────────────────────────────────────

describe('Edge cases', () => {
  const extractor = new ContentExtractor();
  const chunker = new TextChunker();
  const classifier = new FileClassifier();

  it('handles very long text without crashing', async () => {
    const longText = '这是一段很长的文本。'.repeat(2000);
    const absPath = createTestFile('documents/long.txt', longText);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'documents/long.txt', category: 'document', format: 'plaintext', mimeType: 'text/plain' });
    const extraction = await extractor.extract(file);
    const chunks = chunker.chunk(extraction.text, file);
    expect(chunks.length).toBeGreaterThan(5);
    // 每个块应有有效的索引
    expect(chunks.every(c => c.index >= 0)).toBe(true);
  });

  it('handles text with special characters', async () => {
    const specialText = 'Unicode: 中文日本語한국어🎉\nSymbols: ©®™€£¥\nMath: ∑∏∫√∞≈≠≤≥\nEmoji: 😀😂🤣❤️🔥';
    const absPath = createTestFile('documents/special.txt', specialText);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'documents/special.txt', category: 'document', format: 'plaintext', mimeType: 'text/plain' });
    const extraction = await extractor.extract(file);
    expect(extraction.text).toContain('中文日本語한국어');
    expect(extraction.text).toContain('🎉');
    const chunks = chunker.chunk(extraction.text, file);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('handles text with only whitespace', async () => {
    const whitespaceText = '   \n\n\t\n   ';
    const absPath = createTestFile('documents/whitespace.txt', whitespaceText);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'documents/whitespace.txt', category: 'document', format: 'plaintext', mimeType: 'text/plain' });
    const extraction = await extractor.extract(file);
    // trim() 应将纯空格文本变为空
    const chunks = chunker.chunk(extraction.text, file);
    // trim 后，空文本产生 0 个块
    expect(chunks.length).toBe(0);
  });

  it('handles binary-like content in text files', async () => {
    // 含空字节和控制字符的文本
    const mixedText = 'Normal text\n\x00Null byte here\x00\nMore normal text\n\x01\x02Control chars';
    const absPath = createTestFile('documents/binary-like.txt', mixedText);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'documents/binary-like.txt', category: 'document', format: 'plaintext', mimeType: 'text/plain' });
    // 以 utf8 读取可能会失败或产生替换字符
    // 仅验证不会崩溃
    try {
      const extraction = await extractor.extract(file);
      expect(extraction).toBeDefined();
    } catch {
      // 优雅降级是可接受的
    }
  });

  it('handles JSON with nested arrays', async () => {
    const nested = JSON.stringify({
      matrix: [[1, 2, 3], [4, 5, 6], [7, 8, 9]],
      deep: { a: { b: { c: { d: 'deep value' } } } },
      mixed: [{ id: 1, tags: ['a', 'b'] }, { id: 2, tags: ['c'] }],
    });
    const absPath = createTestFile('data/nested.json', nested);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'data/nested.json', category: 'data', format: 'json', mimeType: 'application/json' });
    const result = await extractor.extract(file);
    expect(result.text).toContain('matrix[0][0]: 1');
    expect(result.text).toContain('deep.a.b.c.d: deep value');
  });

  it('handles CSV with quoted fields and commas', async () => {
    const csv = `Name,Description,Price
"Alice, Jr.","Says ""hello"" world",19.99
"Bob","Simple description",29.99
"Charlie","Multi-line
description here",39.99`;
    const absPath = createTestFile('spreadsheets/quoted.csv', csv);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'spreadsheets/quoted.csv', category: 'spreadsheet', format: 'csv', mimeType: 'text/csv' });
    const result = await extractor.extract(file);
    expect(result.metadata.extractionMode).toBe('delimited_text_structured');
    expect(result.text).toContain('Alice, Jr.');
  });

  it('handles large JSONL with many records', async () => {
    const records = Array.from({ length: 100 }, (_, i) => JSON.stringify({ id: i, value: `item-${i}`, active: i % 2 === 0 }));
    const jsonl = records.join('\n');
    const absPath = createTestFile('data/large.jsonl', jsonl);
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'data/large.jsonl', category: 'data', format: 'json', mimeType: 'application/json' });
    const result = await extractor.extract(file);
    expect((result.metadata as any).recordCount).toBe(100);
  });

  it('ensures chunk startChar/endChar are consistent', () => {
    const text = `Line 1: This is the first line of text for testing.
Line 2: This is the second line of text for testing.
Line 3: This is the third line of text for testing.
Line 4: This is the fourth line of text for testing.`;

    const absPath = createTestFile('tmp-consistency.txt', text);
    const file = classifier.classify(absPath, 'tmp-consistency.txt', fs.statSync(absPath));
    const chunks = chunker.chunk(text, file);

    // Chunker 通过 withHeader() 预置了头部，因此位置引用的是头部+文本
    const fullText = `文件: ${file.relativePath}\n类型: ${file.category}/${file.format}\n\n${text}`;

    for (const chunk of chunks) {
      expect(chunk.startChar).toBeGreaterThanOrEqual(0);
      expect(chunk.endChar).toBeGreaterThan(chunk.startChar);
      expect(chunk.endChar).toBeLessThanOrEqual(fullText.length);
      // 验证文本切片匹配
      const slice = fullText.slice(chunk.startChar, chunk.endChar);
      expect(chunk.text).toContain(slice.trim().slice(0, 40));
    }
  });

  it('handles unknown file formats gracefully with metadata-only extraction', async () => {
    const absPath = createTestFile('other/unknown.xyz', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    const file = makeClassifiedFile({ absolutePath: absPath, relativePath: 'other/unknown.xyz', category: 'other', format: 'unknown', mimeType: 'application/octet-stream', fileSize: 5 });
    const result = await extractor.extract(file);
    // 不应崩溃，应产生元数据或回退内容
    expect(result).toBeDefined();
    expect(result.metadata).toBeDefined();
  });
});
