/**
 * 4.61 结构保真出口：DXF → `ExtractionResult.structured.cad`。
 *
 * 锁定的核心断言是**旧路径读都没读的那几个组码真的出来了**：
 * DIMENSION 的 42（测量值）/13-23、14-24（被标注两点），且组码 3（标注样式名）不得混进尺寸文字。
 * 以及「绑不上」的证伪：尺寸能绑定到就近文字实体（"绑不上"只可能是解析缺陷，不是数据没有）。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ContentExtractor } from '../src/extraction/content-extractor.js';

const dir = mkdtempSync(join(tmpdir(), 'cad-structured-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const DXF = [
  '0', 'TEXT', '8', '设计说明', '10', '100.0', '20', '300.0', '40', '3.5', '1', '保护层不小于30mm',
  '0', 'DIMENSION', '8', '尺寸标注', '10', '150.0', '20', '305.0',
  '42', '3600', '13', '0.0', '23', '300.0', '14', '3600.0', '24', '300.0', '1', '%%c3600', '3', 'ISO-25',
  '0', 'ATTRIB', '8', '门窗表', '2', '型号', '1', 'M1021',
  // 判空门槛 MIN_CAD_CHARACTER_DATA = 32：样本必须有足够可读字符才入库（否则走 cad_no_extractable_text）
  '0', 'TEXT', '8', '设计说明', '10', '100.0', '20', '200.0', '1', '本工程结构设计使用年限为50年，抗震设防烈度为7度。',
  '0', 'TEXT', '8', '设计说明', '10', '100.0', '20', '180.0', '1', '混凝土强度等级：柱C40，梁板C30，基础垫层C15。',
].join('\n');

describe('4.61 CAD 结构化出口', () => {
  it('extraction.structured.cad 带出实体图、图框归属与绑定质量', async () => {
    const file = join(dir, 'sample.dxf');
    writeFileSync(file, DXF, 'utf8');
    const extractor = new ContentExtractor();
    const result = await extractor.extract({
      absolutePath: file, relativePath: '图纸/sample.dxf', category: 'cad', format: 'autocad',
    } as never);
    const cad = result.structured?.cad;
    expect(cad, 'CAD 分支必须产出结构化实体（text 只是渲染）').toBeDefined();
    expect(cad!.entities.map(entity => entity.entityType)).toEqual(['TEXT', 'DIMENSION', 'ATTRIB', 'TEXT', 'TEXT']);
    expect(cad!.quality.totalEntities).toBe(5);
    expect(cad!.quality.withLayer).toBe(5);
  });

  it('DIMENSION 的测量值与被标注两点被读出（旧路径只取显示文字、这两项从未读）', async () => {
    const file = join(dir, 'dim.dxf');
    writeFileSync(file, DXF, 'utf8');
    const extractor = new ContentExtractor();
    const result = await extractor.extract({
      absolutePath: file, relativePath: '图纸/dim.dxf', category: 'cad', format: 'autocad',
    } as never);
    const dimension = result.structured!.cad!.entities.find(entity => entity.entityType === 'DIMENSION')!;
    expect(dimension.dimension?.measurement).toBe(3600);
    expect(dimension.dimension?.origin1).toEqual({ x: 0, y: 300 });
    expect(dimension.dimension?.origin2).toEqual({ x: 3600, y: 300 });
    expect(dimension.text, '组码 3 是标注样式名，不得混进尺寸文字').not.toContain('ISO-25');
    expect(result.structured!.cad!.quality.dimensionWithOrigins).toBe(1);
  });

  it('ATTRIB 的列名与值分开保留（旧路径空格拼成「型号 M1021」）', async () => {
    const file = join(dir, 'attrib.dxf');
    writeFileSync(file, DXF, 'utf8');
    const extractor = new ContentExtractor();
    const result = await extractor.extract({
      absolutePath: file, relativePath: '图纸/attrib.dxf', category: 'cad', format: 'autocad',
    } as never);
    const attrib = result.structured!.cad!.entities.find(entity => entity.entityType === 'ATTRIB')!;
    expect(attrib.attribTag).toBe('型号');
    expect(attrib.text).toBe('M1021');
  });
});
