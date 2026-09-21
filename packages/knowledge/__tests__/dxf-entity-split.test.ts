import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContentExtractor, parseDxfTextEntities } from '../src/extraction/content-extractor.js';
import { FileClassifier } from '../src/classification/classifier.js';
import type { ClassifiedFile } from '../src/types.js';

const CRLF = '\r\n';

/** 用 (组码, 值) 序列拼一份 DXF 文本 */
function dxf(...pairs: Array<[string | number, string]>): string {
  return pairs.map(([code, value]) => `${String(code).padStart(3, ' ')}${CRLF}${value}`).join(CRLF) + CRLF;
}

/** 复现 dwgdxf WASM 的 GBK 码位直出：字节按码位映射为 Latin-1 字符（0xBF 0xF2 → "¿ò"） */
function mojibake(bytes: number[]): string {
  return bytes.map(byte => String.fromCharCode(byte)).join('');
}

const GBK = {
  框架柱配筋平面图: [0xBF, 0xF2, 0xBC, 0xDC, 0xD6, 0xF9, 0xC5, 0xE4, 0xBD, 0xEE, 0xC6, 0xBD, 0xC3, 0xE6, 0xCD, 0xBC],
  基础平面布置图: [0xBB, 0xF9, 0xB4, 0xA1, 0xC6, 0xBD, 0xC3, 0xE6, 0xB2, 0xBC, 0xD6, 0xC3, 0xCD, 0xBC],
  结构设计总说明: [0xBD, 0xE1, 0xB9, 0xB9, 0xC9, 0xE8, 0xBC, 0xC6, 0xD7, 0xDC, 0xCB, 0xB5, 0xC3, 0xF7],
  最内侧钢筋需在柱范围内: [0xD7, 0xEE, 0xC4, 0xDA, 0xB2, 0xE0, 0xB8, 0xD6, 0xBD, 0xEE, 0xD0, 0xE8, 0xD4, 0xDA, 0xD6, 0xF9, 0xB7, 0xB6, 0xCE, 0xA7, 0xC4, 0xDA],
};

describe('parseDxfTextEntities', () => {
  it('组码 72 的值恰好为 0 时不切断实体（原正则切分会把文字整条丢掉）', () => {
    // 这是最致命的场景：` 72` 组码后跟一行 `     0`，与「组码 0 实体边界」外观相同
    const raw = dxf(
      [0, 'TEXT'],
      [8, 'PUB_TEXT'],
      [72, '     0'],
      [100, 'AcDbText'],
      [1, mojibake(GBK.框架柱配筋平面图)],
      [0, 'TEXT'],
      [1, mojibake(GBK.基础平面布置图)],
    );
    const entities = parseDxfTextEntities(raw);
    expect(entities).toHaveLength(2);
    expect(entities[0]!.type).toBe('TEXT');
    // 第一个实体的组码 1 必须还在——正则切分时这里只剩到 ` 72` 为止
    expect(entities[0]!.pairs.find(pair => pair[0] === '1')?.[1]).toBe(mojibake(GBK.框架柱配筋平面图));
    expect(entities[1]!.pairs.find(pair => pair[0] === '1')?.[1]).toBe(mojibake(GBK.基础平面布置图));
  });

  it('值等于组码数字的行不会被误当组码（坐标 8 / 0 / 10）', () => {
    const raw = dxf(
      [0, 'TEXT'],
      [8, 'AXIS'],           // 图层
      [10, '8'],             // x 坐标值恰好是 8
      [20, '0'],             // y 坐标值恰好是 0
      [1, '标高-0.750'],
    );
    const entities = parseDxfTextEntities(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.pairs.find(pair => pair[0] === '1')?.[1]).toBe('标高-0.750');
    expect(entities[0]!.pairs.find(pair => pair[0] === '8')?.[1]).toBe('AXIS');
  });

  it('MTEXT 组码 1/3 多段按文档顺序保留', () => {
    const raw = dxf(
      [0, 'MTEXT'],
      [1, '首段'],
      [3, '续段一'],
      [3, '续段二'],
    );
    const entity = parseDxfTextEntities(raw)[0]!;
    const text = entity.pairs.filter(pair => pair[0] === '1' || pair[0] === '3').map(pair => pair[1]).join('');
    expect(text).toBe('首段续段一续段二');
  });

  it('只保留标注类实体，其余不收集组码', () => {
    const raw = dxf(
      [0, 'LINE'],
      [8, 'AXIS'],
      [10, '100'],
      [0, 'TEXT'],
      [1, '保留我'],
      [0, 'LWPOLYLINE'],
      [8, 'WALL'],
    );
    const entities = parseDxfTextEntities(raw);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.type).toBe('TEXT');
  });

  it('ATTRIB 标签与值都被解析', () => {
    const raw = dxf(
      [0, 'ATTRIB'],
      [8, 'WINDOW'],
      [2, '型号'],
      [72, '     0'],
      [1, 'M1021'],
    );
    const entity = parseDxfTextEntities(raw)[0]!;
    expect(entity.type).toBe('ATTRIB');
    expect(entity.pairs.find(pair => pair[0] === '2')?.[1]).toBe('型号');
    expect(entity.pairs.find(pair => pair[0] === '1')?.[1]).toBe('M1021');
  });
});

describe('CAD 组码值为 0 时的端到端提取', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-dxf-split-'));
  const classifier = new FileClassifier();
  const extractor = new ContentExtractor();

  function makeDxfFile(relPath: string, content: string): ClassifiedFile {
    const abs = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const stat = fs.statSync(abs);
    return classifier.classify(abs, relPath, stat);
  }

  afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('受 72/0 影响的 TEXT 实体，其中文标注仍进入提取结果（GBK 还原 + 成对解析）', async () => {
    // 每个实体都带 ` 72` = 0：原实现在此处切断实体，中文全部丢失
    const raw = dxf(
      [0, 'TEXT'], [8, 'PUB_TEXT'], [72, '     0'], [100, 'AcDbText'], [1, mojibake(GBK.框架柱配筋平面图)],
      [0, 'TEXT'], [8, 'PUB_TEXT'], [72, '     0'], [100, 'AcDbText'], [1, mojibake(GBK.基础平面布置图)],
      [0, 'TEXT'], [8, 'PUB_TEXT'], [72, '     0'], [100, 'AcDbText'], [1, mojibake(GBK.结构设计总说明)],
      [0, 'TEXT'], [8, 'PUB_TEXT'], [72, '     0'], [100, 'AcDbText'], [1, mojibake(GBK.最内侧钢筋需在柱范围内)],
    );
    const file = makeDxfFile('drawing/结构图.dxf', raw);
    const result = await extractor.extract(file);
    const text = String(result.text ?? '');

    expect(text).toContain('框架柱配筋平面图');
    expect(text).toContain('基础平面布置图');
    expect(text).toContain('结构设计总说明');
    expect(text).toContain('最内侧钢筋需在柱范围内');
    // 修复前这四条全丢，字符数据为 0，图纸按「无字符数据」不入库
    expect(result.metadata?.characterDataCount).toBeGreaterThanOrEqual(32);
  });
});
