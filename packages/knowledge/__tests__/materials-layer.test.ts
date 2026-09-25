/**
 * 4.61 资料知识层：结构保真 / 归一分流 / 权威分域 的行为矩阵。
 *
 * 本层是全链重构的地基，四条被锁定的行为各自对应一个实测缺陷：
 * - 结构保真：旧路径把已抽出的 layer/x/y/entityType 在返回类型上丢掉（`layoutCadAnnotations(): string[]`）
 * - 尺寸绑定：DXF 的 DIMENSION 自带被标注两点与测量值（组码 42/13/23/14/24），旧路径**未读**
 * - 载体分流：图纸设计说明（收件人=施工方）混入要求池 → 1076 条里 262 条永不可响应
 * - 权威分域：全局梯导致跨域互比（清单工程量 55 vs 图纸规格 18）
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_LATTICE,
  annotationFacts,
  authorityRank,
  compareAuthority,
  dimensionFacts,
  factKey,
  matchClauseNumber,
  parseClauseFacts,
  parseDxfPairEntities,
  buildCadEntities,
  assignCadSheets,
  cadBindingQuality,
  resolveCarrier,
  splitClauseBlocks,
  clauseToObjects,
  detectHeaderRows,
  expandColumnSpans,
  flattenHeaderPath,
  parseFeatureCell,
  resolveTableColumnRoles,
  tableToFacts,
  type CadEntity,
  type SourceAnchor,
  type TableBlock,
} from '../src/index.js';

const anchorOf = (entity: CadEntity): SourceAnchor => ({
  filePath: 'p/图纸/结构.dwg',
  carrier: entity.entityType === 'DIMENSION' ? 'drawing-annotation' : 'drawing-annotation',
  sheet: entity.sheet,
  layer: entity.layer,
  entityType: entity.entityType,
  position: entity.position,
});

// ─────────────────────────── DXF 组码 → 实体图 ───────────────────────────

describe('parseDxfPairEntities / buildCadEntities 结构保真', () => {
  const dxf = [
    '0', 'TEXT', '8', '轴线编号', '10', '100.0', '20', '200.0', '40', '3.5', '1', 'KZ1',
    '0', 'DIMENSION', '8', '尺寸标注', '10', '150.0', '20', '220.0',
    '42', '62900', '13', '0.0', '23', '0.0', '14', '62900.0', '24', '0.0', '1', '%%c100', '3', 'ISO-25',
    '0', 'ATTRIB', '8', '门窗表', '2', '型号', '1', 'M1021',
    '0', 'LEADER', '8', '引线', '10', '10.0', '20', '10.0', '10', '90.0', '20', '40.0', '1', '防水层做法',
    '0', 'LINE', '8', 'XDATA',
  ].join('\n');

  it('只收标注类实体（LINE 等图形实体不入图）', () => {
    const entities = buildCadEntities(parseDxfPairEntities(dxf));
    expect(entities.map(entity => entity.entityType)).toEqual(['TEXT', 'DIMENSION', 'ATTRIB', 'LEADER']);
  });

  it('图层/坐标/字高**逐条保留**（不再在返回类型上丢弃）', () => {
    const [text] = buildCadEntities(parseDxfPairEntities(dxf));
    expect(text!.layer).toBe('轴线编号');
    expect(text!.position).toEqual({ x: 100, y: 200 });
    expect(text!.height).toBe(3.5);
  });

  it('DIMENSION 读出**测量值与被标注两点**（旧路径完全未读；且组码 3 是样式名不是文字）', () => {
    const dimension = buildCadEntities(parseDxfPairEntities(dxf)).find(entity => entity.entityType === 'DIMENSION')!;
    expect(dimension.dimension?.measurement).toBe(62900);
    expect(dimension.dimension?.origin1).toEqual({ x: 0, y: 0 });
    expect(dimension.dimension?.origin2).toEqual({ x: 62900, y: 0 });
    expect(dimension.dimension?.textOverride).toBe('%%c100');
    expect(dimension.text, '组码 3（标注样式名）不得混进尺寸文字').toBe('%%c100');
  });

  it('ATTRIB 的列名与值分开保留（旧路径空格拼成「型号 M1021」）', () => {
    const attrib = buildCadEntities(parseDxfPairEntities(dxf)).find(entity => entity.entityType === 'ATTRIB')!;
    expect(attrib.attribTag).toBe('型号');
    expect(attrib.text).toBe('M1021');
  });

  it('LEADER 保留顶点序列（文字 ↔ 被注释图形的天然绑定）', () => {
    const leader = buildCadEntities(parseDxfPairEntities(dxf)).find(entity => entity.entityType === 'LEADER')!;
    expect(leader.leaderVertices).toEqual([{ x: 10, y: 10 }, { x: 90, y: 40 }]);
  });

  it('绑定质量指标可观测（不变式 6：失败必须记账，不得静默）', () => {
    const quality = cadBindingQuality(buildCadEntities(parseDxfPairEntities(dxf)));
    expect(quality.totalEntities).toBe(4);
    expect(quality.withLayer).toBe(4);
    expect(quality.dimensionEntities).toBe(1);
    expect(quality.dimensionWithOrigins).toBe(1);
  });

  it('图框归属：无图框块时按 y 坐标带聚类，且**不丢弃**未归属实体', () => {
    const entities = buildCadEntities(parseDxfPairEntities(dxf));
    const result = assignCadSheets(entities);
    expect(result.sheets.length).toBeGreaterThan(0);
    expect(result.unassigned).toBe(entities.filter(entity => !Number.isFinite(entity.position.y)).length);
  });
});

// ─────────────────────────── 尺寸绑定（「绑不上」证伪） ───────────────────────────

describe('dimensionFacts 尺寸 → 对象绑定', () => {
  const entity = (over: Partial<CadEntity>): CadEntity => ({
    text: '', entityType: 'TEXT', position: {}, ...over,
  });

  it('尺寸值绑定到**最近文字实体**（不需要猜，五路线索都在）', () => {
    const entities: CadEntity[] = [
      entity({ entityType: 'DIMENSION', position: { x: 100, y: 100 }, dimension: { measurement: 3600, origin1: { x: 0, y: 0 }, origin2: { x: 3600, y: 0 } }, layer: '尺寸标注' }),
      entity({ text: 'KZ1', position: { x: 105, y: 102 }, layer: '柱编号' }),
      entity({ text: '远处标注', position: { x: 9000, y: 9000 }, layer: '说明' }),
    ];
    const { facts, failures } = dimensionFacts({ entities, anchorOf });
    expect(failures).toEqual([]);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.subject).toBe('KZ1');
    expect(facts[0]!.value).toBe('3600');
    expect(facts[0]!.domain).toBe('geometry');
    expect(facts[0]!.carrier).toBe('drawing-annotation');
  });

  it('无任何可绑定文字时**记账**而不是静默丢弃（绑定失败＝解析器缺陷，必须可观测）', () => {
    const entities: CadEntity[] = [
      entity({ entityType: 'DIMENSION', position: { x: 100, y: 100 }, dimension: { measurement: 3600, origin1: { x: 0, y: 0 }, origin2: { x: 3600, y: 0 } }, layer: '尺寸标注' }),
    ];
    const { facts, failures } = dimensionFacts({ entities, anchorOf });
    expect(facts).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.kind).toBe('dimension-without-subject');
    expect(failures[0]!.detail).toContain('3600');
  });
});

// ─────────────────────────── 值与属性解析 ───────────────────────────

describe('parseClauseFacts 约束句 → (属性, 关系, 值, 单位)', () => {
  it('模态词决定关系：不小于→>=，不超过→<=，为→=', () => {
    const [ge] = parseClauseFacts('防水层保护层不小于30mm。');
    expect(ge).toMatchObject({ value: '30', unit: 'mm', relation: '>=' });
    const [le] = parseClauseFacts('接地电阻不大于4Ω。');
    expect(le).toMatchObject({ value: '4', unit: 'Ω', relation: '<=' });
    const [eq] = parseClauseFacts('外墙保温层厚度为80mm。');
    expect(eq).toMatchObject({ value: '80', unit: 'mm', relation: '=' });
  });

  it('材料牌号整体成值（C30 / DN100），不拆数字', () => {
    const [grade] = parseClauseFacts('基础垫层采用C15素混凝土。');
    expect(grade!.value).toBe('C15');
    const [pipe] = parseClauseFacts('雨水管采用DN200双壁波纹管。');
    expect(pipe!.value).toBe('DN200');
  });

  it('区间形态 → range', () => {
    const [range] = parseClauseFacts('回填分层厚度控制在200~300mm。');
    expect(range).toMatchObject({ value: '200~300', unit: 'mm', relation: 'range' });
  });

  it('无模态词的裸数字**不**成事实（年份/序号/统计数不得变成规格）', () => {
    expect(parseClauseFacts('本工程共3个单体，2026年开工。')).toEqual([]);
  });

  it('多句各自解析，不跨句串值', () => {
    const parsed = parseClauseFacts('垫层厚度不小于100mm；面层厚度为50mm。');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.value).toBe('100');
    expect(parsed[1]!.value).toBe('50');
  });
});

// ─────────────────────────── 条款编号与载体分流 ───────────────────────────

describe('matchClauseNumber / splitClauseBlocks', () => {
  it('编号体系识别：第X条 / 8.13 / (4) / 一、 / 4、', () => {
    expect(matchClauseNumber('第4.2.3条 消防联动控制')?.kind).toBe('statute');
    expect(matchClauseNumber('8.13 消防设备配电箱应有明显标志')?.kind).toBe('dotted');
    expect(matchClauseNumber('（4）投标人应提交施工组织设计')?.kind).toBe('parenthesized');
    expect(matchClauseNumber('一、工程概况')?.kind).toBe('han');
    expect(matchClauseNumber('4、本工程消防设备电源监控系统')?.kind).toBe('ordinal');
  });

  it('数值不得被误判为编号（2026年 / 3.5m / 100%）', () => {
    expect(matchClauseNumber('2026年9月1日发布')).toBeUndefined();
    expect(matchClauseNumber('3.5m厚覆土层')).toBeUndefined();
    expect(matchClauseNumber('100%压实度')).toBeUndefined();
  });

  it('无编号的行流**不产生条款**（不变式 5 的前置：图纸标注没有编号体系）', () => {
    expect(splitClauseBlocks({ lines: ['62900', '550', '3750', 'ACAD_DSTYLE_DIMJAG'], anchor: { filePath: 'x.dwg', carrier: 'drawing-annotation' } })).toEqual([]);
  });

  it('折行归入当前条款（PDF 折行的正解——旧实现按行穷举正是把折行切碎的原因）', () => {
    const blocks = splitClauseBlocks({
      lines: ['17、本设计集中电源至应急照明灯具', '采用二总线系统，保护层不小于30mm；', '18、配电房应设置备用照明。'],
      anchor: { filePath: 'd.dwg', carrier: 'drawing-note' },
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.body).toContain('保护层不小于30mm');
    expect(blocks[1]!.clauseNo).toBe('18');
  });
});

describe('clauseToObjects 收件人分流', () => {
  const clauses = splitClauseBlocks({
    lines: ['17、本设计集中电源至应急照明灯具采用二总线系统，保护层不小于30mm。'],
    anchor: { filePath: 'd.dwg', carrier: 'drawing-note' },
  });

  it('图纸设计说明（收件人=施工方）→ DesignFact，**不进要求池**', () => {
    const result = clauseToObjects({ clauses, carrier: 'drawing-note' });
    expect(result.obligations).toEqual([]);
    expect(result.facts.some(fact => fact.value === '30' && fact.relation === '>=')).toBe(true);
  });

  it('招标正文/答疑/评标办法（收件人=投标人）→ BidObligation，且必带条款编号', () => {
    const tenderClauses = splitClauseBlocks({
      lines: ['8.13 投标人应在施工组织设计中明确消防联动控制逻辑。'],
      anchor: { filePath: '招标文件.pdf', carrier: 'tender-clause' },
    });
    const result = clauseToObjects({ clauses: tenderClauses, carrier: 'tender-clause', category: '技术工艺' });
    expect(result.facts).toEqual([]);
    expect(result.obligations).toHaveLength(1);
    expect(result.obligations[0]!.clauseNo).toBe('8.13');
    expect(result.obligations[0]!.carrier).toBe('tender-clause');
  });
});

// ─────────────────────────── 表格模型 ───────────────────────────

describe('table-model 表格还原', () => {
  const rows = [
    { rowNumber: 1, cells: ['E.1 分部分项工程量清单计价表'] },
    { rowNumber: 2, cells: ['序号', '项目编码', '项目名称', '项目特征描述', '计量单位', '工程量'] },
    { rowNumber: 3, cells: ['1', '010101001001', '平整场地', '1．土壤类别：现场现状土 2．其他要求：推平碾压 3．未尽事宜：详见施工图纸', 'm2', '61112.900'] },
  ];

  it('表头行识别：标题行不算表头（不含数值判据不误伤标题）', () => {
    expect(detectHeaderRows(rows.map(row => ({ ...row, cells: expandColumnSpans(row) })))).toBe(2);
  });

  it('多级表头合成叶子列名（金额（元）·综合单价）', () => {
    expect(flattenHeaderPath([['金额（元）', '', ''], ['综合单价', '合价', '其中']]))
      .toEqual(['金额（元）·综合单价', '金额（元）·合价', '金额（元）·其中']);
  });

  it('合并单元格按跨度展开', () => {
    expect(expandColumnSpans({ rowNumber: 1, cells: ['合计', '', ''], spans: [3, 1, 1] })).toEqual(['合计', '', '']);
  });

  it('列角色由**表头语义**决定（不写死列序）', () => {
    const roles = resolveTableColumnRoles(['序号', '项目编码', '项目名称', '项目特征描述', '计量单位', '工程量']);
    expect(roles).toMatchObject({ code: 1, name: 2, feature: 3, unit: 4, quantity: 5 });
  });

  it('项目特征按「1．… 2．…」拆成键值对（清单里唯一的结构化事实来源）', () => {
    expect(parseFeatureCell('1．土壤类别：现场现状土 2．其他要求：推平碾压 3．未尽事宜：详见施工图纸'))
      .toEqual([
        { key: '土壤类别', value: '现场现状土' },
        { key: '其他要求', value: '推平碾压' },
        { key: '未尽事宜', value: '详见施工图纸' },
      ]);
  });

  it('表行 → 事实：特征逐条成事实 + 工程量成数量事实', () => {
    const table: TableBlock = {
      caption: '分部分项工程量清单',
      header: ['序号', '项目编码', '项目名称', '项目特征描述', '计量单位', '工程量'],
      headerPath: [],
      rows: rows.slice(2),
      anchor: { filePath: '清单.xls', carrier: 'boq-quantity', sheet: '1#厂房土建工程' },
    };
    const { facts } = tableToFacts({ table, carrier: 'boq-quantity' });
    const feature = facts.find(fact => fact.attribute === '土壤类别');
    expect(feature).toMatchObject({ subject: '平整场地', value: '现场现状土', domain: 'material' });
    const quantity = facts.find(fact => fact.attribute === '工程量');
    expect(quantity).toMatchObject({ value: '61112.900', unit: 'm2', domain: 'quantity' });
  });
});

// ─────────────────────────── 权威分域 ───────────────────────────

describe('权威分域（无全局梯；企业经验已移除）', () => {
  it('权威表按域给出，且**不含企业经验**（业务要求整体移除）', () => {
    for (const carriers of Object.values(AUTHORITY_LATTICE)) {
      expect(carriers.join(' ')).not.toContain('experience');
      expect(carriers.join(' ')).not.toContain('企业');
    }
    expect(Object.keys(AUTHORITY_LATTICE).sort()).toEqual(['caliber', 'equipment', 'geometry', 'material', 'performance', 'quantity']);
  });

  it('设计参数域：图纸设计说明 > 清单项目特征 > 招标正文', () => {
    expect(authorityRank('material', 'drawing-note')).toBeLessThan(authorityRank('material', 'boq-feature'));
    expect(authorityRank('material', 'boq-feature')).toBeLessThan(authorityRank('material', 'tender-clause'));
  });

  it('工程量域：清单 > 图纸（清单是法定计价口径）——**同一对载体在不同域结论相反**', () => {
    expect(authorityRank('quantity', 'boq-quantity')).toBeLessThan(authorityRank('quantity', 'drawing-note'));
    expect(authorityRank('material', 'drawing-note')).toBeLessThan(authorityRank('material', 'boq-quantity'));
  });

  it('契约口径域：答疑 > 招标正文', () => {
    expect(authorityRank('caliber', 'clarification')).toBeLessThan(authorityRank('caliber', 'tender-clause'));
  });

  it('**跨域禁止互比**（「套管 DN100 正文 55 个 vs 蓝图 18 个」＝清单工程量与图纸规格互比）', () => {
    const verdict = compareAuthority(
      { domain: 'quantity', carrier: 'boq-quantity' },
      { domain: 'material', carrier: 'drawing-note' },
    );
    expect(verdict.comparable).toBe(false);
    expect(verdict.winner).toBeUndefined();
  });

  it('同域可比且给出胜者;同域同档为 tie', () => {
    const materialVerdict = compareAuthority(
      { domain: 'material', carrier: 'drawing-note' },
      { domain: 'material', carrier: 'boq-feature' },
    );
    expect(materialVerdict).toMatchObject({ comparable: true, winner: 'left' });
    expect(compareAuthority({ domain: 'material', carrier: 'drawing-note' }, { domain: 'material', carrier: 'drawing-note' }).winner).toBe('tie');
  });
});

// ─────────────────────────── 载体判定（收件人判据的第一道闸） ───────────────────────────

describe('resolveCarrier 资料类型 → 载体', () => {
  it('图纸目录名带「答疑」不改其载体（实测病灶：路径子串把图纸当答疑条款）', () => {
    expect(resolveCarrier({ kind: 'drawing', section: '消火栓起泵按钮' })).toBe('drawing-annotation');
    expect(resolveCarrier({ kind: 'drawing', section: '结构设计总说明' })).toBe('drawing-note');
    expect(resolveCarrier({ kind: 'addendum' })).toBe('clarification');
    expect(resolveCarrier({ kind: 'tender_document' })).toBe('tender-clause');
  });

  it('清单内部按表头再分：有工程量列 → 工程量载体', () => {
    expect(resolveCarrier({ kind: 'bill_of_quantities', header: ['项目名称', '工程量'] })).toBe('boq-quantity');
    expect(resolveCarrier({ kind: 'bill_of_quantities', header: ['项目名称', '项目特征描述'] })).toBe('boq-feature');
  });

  it('未识别类型保守判为条款（宁可多判为义务，不把义务静默降级为事实）', () => {
    expect(resolveCarrier({ kind: 'unknown_kind' })).toBe('tender-clause');
  });
});

// ─────────────────────────── 不变式 ───────────────────────────

describe('不变式：裁决键与出处坐标', () => {
  it('裁决键含域（跨域不同键，结构上不可能互比）', () => {
    expect(factKey('material', '防水层', '厚度')).not.toBe(factKey('quantity', '防水层', '厚度'));
    expect(factKey('material', '防水层', '厚度')).toBe(factKey('material', '防水层 ', '厚 度'));
  });

  it('标注事实带完整出处坐标（可回指源结构：图层/坐标/图框）', () => {
    const entities: CadEntity[] = [{ text: '保护层不小于30mm', entityType: 'TEXT', layer: '设计说明', position: { x: 1, y: 2 } }];
    const { facts } = annotationFacts({ entities, anchorOf });
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]!.anchor.layer).toBe('设计说明');
    expect(facts[0]!.anchor.position).toEqual({ x: 1, y: 2 });
  });
});

describe('4.61 尺寸值导出（组码 42 缺失时由被标注两点算）', () => {
  const entity = (over: Partial<CadEntity>): CadEntity => ({ text: '', entityType: 'TEXT', position: {}, ...over });
  const anchorOfLocal = (e: CadEntity): SourceAnchor => ({ filePath: 'd.dwg', carrier: 'drawing-annotation', entityType: e.entityType, position: e.position });

  it('无显式测量值时由两点距离导出（实测全库 60,676 个尺寸均无组码 42）', () => {
    const entities: CadEntity[] = [
      entity({ text: 'KZ1', position: { x: 10, y: 0 } }),
      entity({ entityType: 'DIMENSION', position: { x: 5, y: 0 }, dimension: { origin1: { x: 0, y: 0 }, origin2: { x: 3600, y: 0 } } }),
    ];
    const { facts } = dimensionFacts({ entities, anchorOf: anchorOfLocal });
    expect(facts[0]!.value).toBe('3600');
  });

  it('显式测量值优先于导出值；两点重合视为无值（不产生 0 尺寸）', () => {
    const explicit: CadEntity[] = [
      entity({ text: 'KL1', position: { x: 1, y: 0 } }),
      entity({ entityType: 'DIMENSION', position: { x: 0, y: 0 }, dimension: { measurement: 5000, origin1: { x: 0, y: 0 }, origin2: { x: 3600, y: 0 } } }),
    ];
    expect(dimensionFacts({ entities: explicit, anchorOf: anchorOfLocal }).facts[0]!.value).toBe('5000');
    const degenerate: CadEntity[] = [
      entity({ text: 'KL1', position: { x: 1, y: 0 } }),
      entity({ entityType: 'DIMENSION', position: { x: 0, y: 0 }, dimension: { origin1: { x: 7, y: 7 }, origin2: { x: 7, y: 7 } } }),
    ];
    expect(dimensionFacts({ entities: degenerate, anchorOf: anchorOfLocal }).facts).toEqual([]);
  });

  it('显式文字覆盖时以文字为准（如「%%c3600」）', () => {
    const entities: CadEntity[] = [
      entity({ text: 'GZ1', position: { x: 1, y: 0 } }),
      entity({ entityType: 'DIMENSION', position: { x: 0, y: 0 }, dimension: { textOverride: '%%c3600', origin1: { x: 0, y: 0 }, origin2: { x: 9999, y: 0 } } }),
    ];
    expect(dimensionFacts({ entities, anchorOf: anchorOfLocal }).facts[0]!.value).toBe('%%c3600');
  });
});
