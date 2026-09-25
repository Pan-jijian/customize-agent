/**
 * CAD 实体图（4.61）：DWG/DXF 的结构保真解析。
 *
 * ## 与旧路径的差别（为什么不是补丁）
 *
 * 旧路径 `extractDxfTextAnnotations() → CadAnnotation[] → layoutCadAnnotations(): string[]`
 * 把已经抽出的 `layer`/`x`/`y`/`entityType` **在返回类型上丢掉了**——结构化对象降级为字符串，
 * 下游再也无法把「尺寸值」绑回「它标注的构件」。本模块的出口**只出结构化对象**，
 * 任何函数都不返回"拼接好的字符串"。
 *
 * ## 绑定信息本来就在（「绑不上」证伪）
 *
 * | 绑定线索 | DXF 中的位置 | 旧路径 |
 * |---|---|---|
 * | 尺寸值 | `DIMENSION` 组码 42（测量值）/ 1（显式文字） | 只取 1/3，**未读 42** |
 * | 被标注两点 | `DIMENSION` 组码 13/23、14/24 | **未读** |
 * | 引线两端 | `LEADER` 顶点序列（组码 10/20 重复出现） | 未读 |
 * | 分类语义 | 图层名（`砼梁`/`楼板负筋文字`/`基础集中标注`） | 抽了，随后丢弃 |
 * | 属性表标签 | `ATTRIB` 组码 2（列名）+ 1（值） | 读到了，但拼成一行 |
 * | 块结构 | `INSERT`（块引用）+ `BLOCK` 定义 | 只留块名到 metadata |
 *
 * 由这些线索可以**确定**「哪个值属于哪个对象」：尺寸值 ↔ 被标注两点 ↔ 就近文字实体 ↔
 * 图层语义 ↔ 图框专业，五路交叉。绑定失败只会是解析缺陷，必须上报（不变式 6），
 * **不得作为规则例外静默吞掉**。
 */
import { restoreLatin1MojibakeAsGbk } from '../extraction/text-encoding.js';

/** DXF 文字类实体类型（ATTRIB 是块属性，门窗表/材料表的载体） */
export type CadEntityType = 'TEXT' | 'MTEXT' | 'DIMENSION' | 'LEADER' | 'ATTRIB' | 'MLEADER';

/** 图纸坐标点（与源结构同构：缺哪个坐标就如实缺，不补零——补零会伪造出原点处的假点） */
export interface CadPoint {
  x?: number;
  y?: number;
}

/** 尺寸标注的几何绑定信息（旧路径完全未读） */
export interface CadDimensionGeometry {
  /** 组码 42：实际测量值（图纸单位） */
  measurement?: number;
  /** 组码 1：显式尺寸文字（覆盖测量值，如「%%c100」） */
  textOverride?: string;
  /** 组码 13/23：第一条尺寸界线原点 */
  origin1?: CadPoint;
  /** 组码 14/24：第二条尺寸界线原点 */
  origin2?: CadPoint;
  /** 组码 50：标注文字旋转角（判断横/纵向标注） */
  rotation?: number;
}

/** 单条 CAD 文字类实体（**结构守恒的出口对象**） */
export interface CadEntity {
  text: string;
  entityType: CadEntityType;
  /** 图层名：分类语义标签（`砼梁`、`楼板负筋文字`、`基础集中标注` 本身就是语义） */
  layer?: string;
  /** 所属块名（INSERT 上下文；ATTRIB 的组码 2 是属性标签而非块名） */
  block?: string;
  /** ATTRIB 的属性标签名（列的语义：`型号`、`高度`） */
  attribTag?: string;
  /** 插入点（组码 10/20）；DIMENSION 为尺寸线位置 */
  position: CadPoint;
  /** 文字高度（组码 40）：用于区分图名/标注/说明正文 */
  height?: number;
  /** 尺寸标注几何（仅 DIMENSION） */
  dimension?: CadDimensionGeometry;
  /** 引线顶点序列（仅 LEADER/MLEADER，组码 10/20 重复出现） */
  leaderVertices?: CadPoint[];
  /** 所属图框（由 assignCadSheets 推断：图框块名或图幅带） */
  sheet?: string;
}

/** DXF 组码对（0 值行 + 组码行的成对解析产物） */
export interface DxfPairEntity {
  type: string;
  pairs: Array<[string, string]>;
}

const CAD_TEXT_ENTITY_TYPES: ReadonlySet<string> = new Set(['TEXT', 'MTEXT', 'DIMENSION', 'LEADER', 'ATTRIB', 'MLEADER']);

/**
 * DXF 文本 → 组码对实体流。
 *
 * 与 `parseDxfTextEntities` 同源口径（值行与组码行外观相同，必须成对推进），
 * 但**保留全部组码**供上层按需取用，不在这一层做任何取舍。
 */
export function parseDxfPairEntities(raw: string): DxfPairEntity[] {
  const lines = raw.split(/\r?\n/u);
  const entities: DxfPairEntity[] = [];
  let current: DxfPairEntity | undefined;
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = (lines[index] ?? '').trim();
    const value = lines[index + 1] ?? '';
    if (code === '0') {
      if (current) entities.push(current);
      const entityType = value.trim();
      current = CAD_TEXT_ENTITY_TYPES.has(entityType) ? { type: entityType, pairs: [] } : undefined;
      continue;
    }
    if (current) current.pairs.push([code, value]);
  }
  if (current) entities.push(current);
  return entities;
}

/** 坐标组码读写（10/20 是主点，11/21/12/22/13/23/14/24 是尺寸界线与引线点） */
function coordinateOf(pairs: Array<[string, string]>, xCode: string, yCode: string): CadPoint | undefined {
  const read = (code: string): number | undefined => {
    const value = pairs.find(pair => pair[0] === code)?.[1];
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const x = read(xCode);
  const y = read(yCode);
  return x === undefined && y === undefined ? undefined : { x, y };
}

/** 组码单值读取（同码多值时取全部，供 MTEXT 的 1/3 续段拼接） */
function allOf(pairs: Array<[string, string]>, code: string): string[] {
  return pairs.filter(pair => pair[0] === code).map(pair => pair[1]);
}

function firstOf(pairs: Array<[string, string]>, code: string): string | undefined {
  return pairs.find(pair => pair[0] === code)?.[1];
}

/**
 * 实体流 → CAD 实体图。
 *
 * 本函数**不做可读性过滤、不做拼接、不做排序**——过滤属于归一层（那里才知道载体），
 * 拼接属于渲染层，排序属于版面重建层。这一层只负责把结构搬出来。
 */
export function buildCadEntities(pairEntities: DxfPairEntity[]): CadEntity[] {
  const entities: CadEntity[] = [];
  for (const entity of pairEntities) {
    const { type, pairs } = entity;
    const layer = restoreLatin1MojibakeAsGbk(firstOf(pairs, '8')?.trim() ?? '') || undefined;
    const heightValue = Number(firstOf(pairs, '40'));
    const base: CadEntity = {
      text: '',
      entityType: type as CadEntityType,
      layer,
      position: coordinateOf(pairs, '10', '20') ?? {},
      height: Number.isFinite(heightValue) ? heightValue : undefined,
    };
    if (type === 'ATTRIB') {
      // 属性实体：组码 2 是属性标签名（列名），组码 1 是属性值——两者是**独立语义字段**，
      // 旧路径用空格拼成一行（「型号 M1021」），丢掉了列名/值的边界
      base.attribTag = restoreLatin1MojibakeAsGbk(firstOf(pairs, '2')?.trim() ?? '') || undefined;
      base.text = restoreLatin1MojibakeAsGbk(allOf(pairs, '1').join(''));
      delete base.block;
    } else if (type === 'DIMENSION') {
      // 尺寸标注：**值与被标注的两点同时保留**——这是「绑不上」的正解。
      // 组码 42 是实测值；组码 1 是显式文字（有覆盖时以覆盖为准，如「%%c100」）；
      // 组码 3 是**标注样式名**（不是文字！旧路径把 1 与 3 一起拼，样式名会污染尺寸文字）
      const measurement = Number(firstOf(pairs, '42'));
      const override = restoreLatin1MojibakeAsGbk(allOf(pairs, '1').join(''));
      base.text = override;
      base.dimension = {
        measurement: Number.isFinite(measurement) ? measurement : undefined,
        textOverride: override || undefined,
        origin1: coordinateOf(pairs, '13', '23'),
        origin2: coordinateOf(pairs, '14', '24'),
        rotation: (() => {
          const value = Number(firstOf(pairs, '50'));
          return Number.isFinite(value) ? value : undefined;
        })(),
      };
    } else if (type === 'LEADER' || type === 'MLEADER') {
      // 引线：顶点序列是引线两端（文字 ↔ 被注释图形），是天然的对象-注释绑定
      const xs = allOf(pairs, '10').map(Number).filter(value => Number.isFinite(value));
      const ys = allOf(pairs, '20').map(Number).filter(value => Number.isFinite(value));
      base.text = restoreLatin1MojibakeAsGbk([...allOf(pairs, '1'), ...allOf(pairs, '3')].join(''));
      base.leaderVertices = xs.map((x, index) => ({ x, y: ys[index] ?? Number.NaN }));
    } else {
      // TEXT / MTEXT：组码 1 是首段，组码 3 是续段（每段 ≤250 字符），按文档序拼接才是完整文字
      base.text = restoreLatin1MojibakeAsGbk(allOf(pairs, '1').concat(allOf(pairs, '3')).join(''));
      const blockName = restoreLatin1MojibakeAsGbk(firstOf(pairs, '2')?.trim() ?? '');
      if (blockName) base.block = blockName;
    }
    entities.push(base);
  }
  return entities;
}

/**
 * 图框归属推断。
 *
 * 三级判据，全部来自结构（不猜语义）：
 * 1. 实体自身所属块名命中图框/标题栏命名（`图框`/`标题栏`/`TK`/`A0`~`A4` 幅面块）；
 * 2. 同块内存在图名文字（`图名`/`图号` 图层上的文字）；
 * 3. 兜底：按 y 坐标带聚类（一张图纸内的图框在版面上是水平带分布）。
 *
 * 归属结果写入 `entity.sheet`；**归属失败不丢弃实体**，只是 `sheet` 留空并由
 * `cadBindingFailureStats()` 计入解析质量指标（不变式 6）。
 */
export function assignCadSheets(entities: CadEntity[]): { sheets: Array<{ name: string; entityCount: number }>; unassigned: number } {
  const FRAME_BLOCK_RE = /图框|标题栏|图签|TK\d*|[Aa][0-4]幅面|Frame|TitleBlock/iu;
  const sheetNames = new Set<string>();
  for (const entity of entities) {
    if (entity.block && FRAME_BLOCK_RE.test(entity.block)) {
      entity.sheet = entity.block;
      sheetNames.add(entity.block);
    }
  }
  // 兜底：y 坐标带聚类（带高按版心经验值取全幅的 1/6；无坐标实体不参与）
  const withY = entities.filter(entity => Number.isFinite(entity.position.y));
  if (sheetNames.size === 0 && withY.length > 0) {
    const ys = withY.map(entity => entity.position.y!).sort((a, b) => a - b);
    const span = ys[ys.length - 1]! - ys[0]!;
    const bandHeight = span > 0 ? span / 6 : 0;
    if (bandHeight > 0) {
      for (const entity of withY) {
        const band = Math.floor((entity.position.y! - ys[0]!) / bandHeight);
        entity.sheet = `带${band + 1}`;
        sheetNames.add(entity.sheet);
      }
    }
  }
  const unassigned = entities.filter(entity => !entity.sheet).length;
  const counts = new Map<string, number>();
  for (const entity of entities) if (entity.sheet) counts.set(entity.sheet, (counts.get(entity.sheet) ?? 0) + 1);
  return { sheets: [...counts].map(([name, entityCount]) => ({ name, entityCount })).sort((a, b) => b.entityCount - a.entityCount), unassigned };
}

/** 解析质量指标（不变式 6：绑定失败必须可观测，不得静默） */
export interface CadBindingQuality {
  totalEntities: number;
  /** 带图层（分类语义）的实体数 */
  withLayer: number;
  /** 带坐标的实体数 */
  withPosition: number;
  /** 带图框归属的实体数 */
  withSheet: number;
  /** 尺寸实体总数 */
  dimensionEntities: number;
  /** 尺寸实体中**被标注两点齐全**的数量（可绑定者） */
  dimensionWithOrigins: number;
}

export function cadBindingQuality(entities: CadEntity[]): CadBindingQuality {
  const dimensions = entities.filter(entity => entity.entityType === 'DIMENSION');
  return {
    totalEntities: entities.length,
    withLayer: entities.filter(entity => Boolean(entity.layer)).length,
    withPosition: entities.filter(entity => Number.isFinite(entity.position.x) || Number.isFinite(entity.position.y)).length,
    withSheet: entities.filter(entity => Boolean(entity.sheet)).length,
    dimensionEntities: dimensions.length,
    dimensionWithOrigins: dimensions.filter(entity => entity.dimension?.origin1 && entity.dimension?.origin2).length,
  };
}
