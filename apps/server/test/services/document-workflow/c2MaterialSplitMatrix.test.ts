/**
 * C2「材料规格拆分数量与蓝图权威不一致」用例矩阵（4.59 R-C2，真实文档逐字用例）。
 *
 * 背景：ea380252 终稿报 3 条材料类 blocker（cfb0a0da 0 条）：
 *   ① 普通灯具（18W）正文 104套，蓝图权威 161套
 *   ② 套管制作与安装（DN100）正文 21个，蓝图权威 18个
 *   ③ 套管制作与安装（DN50）正文 18个，蓝图权威 4个
 * 逐条归因（见 `rc-class-diag.manual.ts` 的 [C2] 表与 `resourceBreakdownNumbers.ts` 内注解）证明三条全是**归属误绑**：
 *   ① 104 是「单管荧光灯1×18W」的规格数量（蓝图 荧光灯（18W）104套 真值），规格 token 18W 前最近的
 *      材料名是「单管荧光灯」——旧实现只把**同名多规格**材料放进归属名册，单规格的「荧光灯」不在名册里 →
 *      查不到归属即放行 → 归到同句更早的「双管荧光灯」/「普通灯具」名下；
 *   ②③ 21/18 是「止水节安装 DN100/DN50」的清单逐条真值（蓝图 止水节安装 DN100 21个、DN50 18个），
 *      正文形态「…套管制作与安装55个，止水节安装39个，DN100 21个、DN50 18个。」中规格紧随逗号——旧实现
 *      的分句窗口恰为空串 → owner=undefined 被当作「允许」→ 记到同句更早的「套管制作与安装」名下。
 *
 * 用例文本全部逐字取自两份真实终稿（只对「构造真漂移」的正向用例做单点数字扰动，逐条注明）；权威数据取自
 *   蓝图：assets/blueprint.json → data.materialsPlan（普通灯具 18W 161/14W 35、套管制作与安装 DN100 18/
 *   DN50 4、止水节安装 DN100 21/DN50 18、塑料管 DN20 40/DN15 171/DN40 11.6、预留孔洞 DN100 53/DN50 42…）；
 *   清单锁逐条口径：buildBillFactLock 实跑（普通灯具|14W = 1#厂房 8+12+4、2#门卫 8+1、3#门卫 2；
 *   塑料管|DN20 = 1#厂房 32、2#门卫 3、3#门卫 5；塑料管|DN15 = 145/25/1；塑料管|DN40 = 11/0.6）。
 *
 * 四类覆盖：正向（真漂移照报）/ 反向（三条误报各自的防线）/ 边界（归属、窗口、名册边界）/
 * 不变（既有口径与回退层不得改变）。
 */
import { describe, expect, it } from 'vitest';
import { buildResourceBreakdownAuthority, fixResourceBreakdownNumbers, scanResourceBreakdownClaims } from '@/services/document-workflow/resourceBreakdownNumbers';
import type { ResourceBreakdownAuthority } from '@/services/document-workflow/resourceBreakdownNumbers';
import type { BlueprintData } from '@/services/document-workflow/integratedBlueprint';

// ═══════════════════ 真实文档逐字段（来源：assets/巢湖施工组织设计-doc-*） ═══════════════════

/** ea380252 第 270 行（室内给排水章 支管接驳与预留；三条误报中②③的原文行） */
const EA_270 = `4. 支管接驳与预留：预留孔洞112个，其中DN100 53个、DN50 42个、DN150 13个、DN65 2个、DN80 2个；套管制作与安装55个，止水节安装39个，DN100 21个、DN50 18个。`;

/** ea380252 第 406 行（3#门卫安装工程零星工程；误报①的原文行，逐字，含真值 104 套） */
const EA_406 = `3#门卫安装工程零星工程作业对象涵盖配电箱、配管配线、照明灯具、防雷接地及给排水管道等作业内容。配电箱AL-MW3共1台，明装距地1.5m，箱内电器元件及接线端子随箱配套；电气配管采用SC20焊接钢管70m暗敷，配线BV-2.5mm²穿管敷设80m、BVR-2.5mm²敷设40m；电缆保护管DN40焊接钢管3.3m；电力电缆YJV-3×2.5铜芯40.33m沿桥架穿管敷设，电缆终端头1KV干包式6个。照明系统含双管荧光灯LED 2×18W链吊安装距地3.5m、单管荧光灯1×18W 104套、普通灯具14W 2套、照明开关220V/10A 50套、插座250V/10A 57套及16A 1套；悬挂灯按实11 LED 200W杆吊，距顶板底1.0米（距地2.6米以上），悬挂灯按实12 LED 200W杆吊，距顶板底1.0米（距地2.6米以上）。`;

/** ea380252 第 407 行（3#门卫段给排水与接地；口径分层的原文行） */
const EA_407 = `防雷接地利用柱外侧二根大于Φ16主筋引下与基础钢筋焊接，接地母线40×4镀锌扁钢17m、避雷网φ12镀锌圆钢30m、避雷引下线φ16 22m，接地电阻测试值不大于1Ω。给排水管道DN40塑料管0.6m、DN20 5m、DN15 1m，配套减压器DN20 1组，管道消毒冲洗后交付。工序按配管预埋→穿线接线→配电箱安装→灯具开关插座安装→接地焊接→给排水管道敷设→消毒冲洗→系统调试的顺序推进。施工员每日巡查管线预埋位置与标高，质检员每周不少于2次核验接线端子紧固度与接地电阻，不合格处限期整改并复验销项。`;

/** ea380252 第 249 行（表格行：桥接词「共」形态，既有存量口径的零命中形态） */
const EA_249_TABLE_ROW = `| 室外给水与消防管网 | 复合管DN150共1140m、DN80共430m、DN100共87m、DN200共6m；消火栓钢管DN40共157m、DN25共211m | 沟槽底宽按管外径两侧各留200mm工作面，铺10cm中粗砂垫层 | 水压试验压力按工作压力1.5倍且不低于0.6MPa，稳压10min无渗漏 | 施工员每日巡查，质检员每周不少于2次抽检 |`;

// ═══════════════════ 权威数据（逐字取自 assets/blueprint.json → materialsPlan，variantCount=同名条目数） ═══════════════════

const MATERIAL_ROWS: ResourceBreakdownAuthority['materials'] = [
  { name: '普通灯具', spec: '18W', quantity: 161, unit: '套', family: 'count', variantCount: 2 },
  { name: '普通灯具', spec: '14W', quantity: 35, unit: '套', family: 'count', variantCount: 2 },
  { name: '套管制作与安装', spec: 'DN100', quantity: 18, unit: '个', family: 'count', variantCount: 7 },
  { name: '套管制作与安装', spec: 'DN50', quantity: 4, unit: '个', family: 'count', variantCount: 7 },
  { name: '套管制作与安装', spec: 'DN40', quantity: 11, unit: '个', family: 'count', variantCount: 7 },
  { name: '止水节安装', spec: 'DN100', quantity: 21, unit: '个', family: 'count', variantCount: 2 },
  { name: '止水节安装', spec: 'DN50', quantity: 18, unit: '个', family: 'count', variantCount: 2 },
  { name: '预留孔洞', spec: 'DN100', quantity: 53, unit: '个', family: 'count', variantCount: 5 },
  { name: '预留孔洞', spec: 'DN50', quantity: 42, unit: '个', family: 'count', variantCount: 5 },
  { name: '预留孔洞', spec: 'DN150', quantity: 13, unit: '个', family: 'count', variantCount: 5 },
  { name: '塑料管', spec: 'DN20', quantity: 40, unit: 'm', family: 'length', variantCount: 10 },
  { name: '塑料管', spec: 'DN15', quantity: 171, unit: 'm', family: 'length', variantCount: 10 },
  { name: '塑料管', spec: 'DN40', quantity: 11.6, unit: 'm', family: 'length', variantCount: 10 },
  { name: '复合管', spec: 'DN40', quantity: 136.8, unit: 'm', family: 'length', variantCount: 9 },
  { name: '复合管', spec: 'DN20', quantity: 5.6, unit: 'm', family: 'length', variantCount: 9 },
  { name: '管道消毒冲洗', spec: 'DN40', quantity: 140.4, unit: 'm', family: 'length', variantCount: 8 },
  { name: '管道消毒冲洗', spec: 'DN20', quantity: 40, unit: 'm', family: 'length', variantCount: 8 },
];

/** 归属名册 = materialsPlan **全量**名称（含单规格：荧光灯/工厂灯/装饰灯等——C2 修复点，蓝图实测 289 名） */
const MATERIAL_NAMES = ['普通灯具', '套管制作与安装', '止水节安装', '预留孔洞', '塑料管', '复合管', '管道消毒冲洗', '荧光灯', '工厂灯', '装饰灯'];

/** 清单逐条口径（buildBillFactLock 实跑真值；仅列本文件用到的键） */
const SCOPED_ROWS: Array<[string, number, string, string]> = [
  ['普通灯具\u000014W', 8, '套', '1#厂房安装工程'],
  ['普通灯具\u000014W', 12, '套', '1#厂房安装工程'],
  ['普通灯具\u000014W', 4, '套', '1#厂房安装工程'],
  ['普通灯具\u000014W', 8, '套', '2#门卫安装工程'],
  ['普通灯具\u000014W', 1, '套', '2#门卫安装工程'],
  ['普通灯具\u000014W', 2, '套', '3#门卫安装工程'],
  ['普通灯具\u000018W', 66, '套', '1#厂房安装工程'],
  ['普通灯具\u000018W', 95, '套', '1#厂房安装工程'],
  ['塑料管\u0000DN20', 32, 'm', '1#厂房安装工程'],
  ['塑料管\u0000DN20', 3, 'm', '2#门卫安装工程'],
  ['塑料管\u0000DN20', 5, 'm', '3#门卫安装工程'],
  ['塑料管\u0000DN15', 145, 'm', '1#厂房安装工程'],
  ['塑料管\u0000DN15', 25, 'm', '2#门卫安装工程'],
  ['塑料管\u0000DN15', 1, 'm', '3#门卫安装工程'],
  ['塑料管\u0000DN40', 11, 'm', '2#门卫安装工程'],
  ['塑料管\u0000DN40', 0.6, 'm', '3#门卫安装工程'],
];

function scopedMap(): ResourceBreakdownAuthority['scopedQuantities'] {
  const map: ResourceBreakdownAuthority['scopedQuantities'] = new Map();
  for (const [key, value, unit, scope] of SCOPED_ROWS) {
    map.set(key, [...(map.get(key) ?? []), { value, unit, scope }]);
  }
  return map;
}

const authority = (withScoped = true): ResourceBreakdownAuthority => ({
  composition: [],
  equipment: [],
  materials: MATERIAL_ROWS,
  materialNames: MATERIAL_NAMES,
  scopedQuantities: withScoped ? scopedMap() : new Map(),
});

const materialClaims = (markdown: string, withScoped = true) =>
  scanResourceBreakdownClaims(markdown, authority(withScoped)).filter(claim => claim.kind === 'material');

describe('C2 正向：归属修正后真漂移仍照报（不得借归属闸掩盖真偏离）', () => {
  it('套管制作与安装（DN100）写 19个（逐字 270 行去掉「止水节安装39个，」归属子句 + 单点数字扰动）→ 照报', () => {
    const text = EA_270.replace('止水节安装39个，DN100 21个、DN50 18个', 'DN100 19个、DN50 4个');
    const claims = materialClaims(text);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message).toBe('材料规格拆分数量与蓝图权威不一致：套管制作与安装（DN100）正文 19个，蓝图权威 18个');
  });

  it('止水节安装（DN100）写 25个（逐字 270 行 + 单点数字扰动 21→25）→ 照报', () => {
    const text = EA_270.replace('DN100 21个', 'DN100 25个');
    const claims = materialClaims(text);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message).toBe('材料规格拆分数量与蓝图权威不一致：止水节安装（DN100）正文 25个，蓝图权威 21个');
  });

  it('普通灯具（18W）写 2套（逐字 406 行 + 单点扰动：14W 2套 → 18W 2套）→ 照报（同句的 104 套仍归属荧光灯）', () => {
    const text = EA_406.replace('普通灯具14W 2套', '普通灯具18W 2套');
    const claims = materialClaims(text);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message).toBe('材料规格拆分数量与蓝图权威不一致：普通灯具（18W）正文 2套，蓝图权威 161套');
  });

  it('单体语句写错值 → 以该单体清单逐条口径为期望值（逐字 407 行 + 单体名接回句首 + 5m→6m）', () => {
    // 该行本体属 3#门卫段（真实文档中单体名在上一句），此处把段属单体名接回句首以构成「单体语句」形态
    const text = `3#门卫安装工程${EA_407.split('。')[1]?.replace('DN20 5m', 'DN20 6m')}。`;
    const claims = materialClaims(text);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message).toBe('材料规格拆分数量与清单逐条口径不一致：塑料管（DN20）正文 6m，清单逐条口径 5m（蓝图汇总 40m 为跨单体总量，不得直接引用到单体语句）');
  });
});

describe('C2 反向：三条真实误报各自不得再报（逐字原文，零 claim）', () => {
  it('单管荧光灯1×18W 104套（误报①的最小复现形态）→ 零 claim（18W 归属荧光灯，不再归 普通灯具）', () => {
    expect(materialClaims('照明系统含双管荧光灯LED 2×18W链吊安装距地3.5m、单管荧光灯1×18W 104套。')).toEqual([]);
  });

  it('ea380252 第 406 行逐字 → 零 claim（104套归荧光灯；普通灯具14W 2套 命中 3#门卫 逐条口径）', () => {
    expect(materialClaims(EA_406)).toEqual([]);
  });

  it('ea380252 第 270 行逐字 → 零 claim（21/18 归属止水节安装；55 为套管各规格之和不参与规格比对）', () => {
    expect(materialClaims(EA_270)).toEqual([]);
  });

  it('ea380252 第 407 行逐字 → 零 claim（塑料管 DN15/DN20/DN40 均命中清单逐条口径集）', () => {
    expect(materialClaims(EA_407)).toEqual([]);
  });
});

describe('C2 边界：归属、窗口与名册的边界（防放宽被读成按数字白名单放行）', () => {
  it('归属子句一旦缺失，同样的 21/18 两个数字即照报（归属闸不是数字白名单）', () => {
    const claims = materialClaims('套管制作与安装55个，DN100 21个、DN50 18个。');
    expect(claims.map(claim => claim.message)).toEqual([
      '材料规格拆分数量与蓝图权威不一致：套管制作与安装（DN100）正文 21个，蓝图权威 18个',
      '材料规格拆分数量与蓝图权威不一致：套管制作与安装（DN50）正文 18个，蓝图权威 4个',
    ]);
  });

  it('句中无任何材料名（名称段校验兜底）→ 零 claim（窗口放宽不越过名称段校验）', () => {
    expect(materialClaims('DN100 21个、DN50 18个。')).toEqual([]);
  });

  it('归属名在 200 字窗口之外 → 回退既有口径照报（放宽有界，不是无限回溯）', () => {
    const filler = '施工准备与测量放线'.repeat(24); // 216 字，无句读/无材料名
    const text = `套管制作与安装${filler}，DN100 19个。`;
    const claims = materialClaims(text);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.message).toBe('材料规格拆分数量与蓝图权威不一致：套管制作与安装（DN100）正文 19个，蓝图权威 18个');
  });

  it('单规格材料名可充当归属方但不参与拆分对账（materialNames 全集 vs materials 仅同名多规格）', () => {
    const blueprintData = {
      resources: { labor: { composition: [] }, equipment: [] },
      materialsPlan: [
        { name: '普通灯具', spec: '18W', quantity: 161, unit: '套', basis: '' },
        { name: '普通灯具', spec: '14W', quantity: 35, unit: '套', basis: '' },
        { name: '荧光灯', spec: '18W', quantity: 104, unit: '套', basis: '' },
      ],
    } as unknown as BlueprintData;
    const built = buildResourceBreakdownAuthority(blueprintData)!;
    expect(built.materialNames).toContain('荧光灯');
    expect(built.materials.some(item => item.name === '荧光灯')).toBe(false);
    // 名册里有 荧光灯 → 18W 归属到它 → 104（真值）零 claim；若名册缺它，则旧实现会归到 普通灯具 并报 104 vs 161
    expect(scanResourceBreakdownClaims('单管荧光灯1×18W 104套。', built).filter(claim => claim.kind === 'material')).toEqual([]);
  });
});

describe('C2 不变：既有口径与回退层不得改变', () => {
  it('单规格材料引用（真 406 行悬挂灯 200W 段）→ 零 claim（拆分对账只覆盖同名多规格，既有口径）', () => {
    expect(materialClaims('悬挂灯按实11 LED 200W杆吊，距顶板底1.0米（距地2.6米以上），悬挂灯按实12 LED 200W杆吊，距顶板底1.0米（距地2.6米以上）。')).toEqual([]);
  });

  it('无清单锁时按蓝图汇总照旧比对（407 行 → 2 条「蓝图权威」报文）：分层机制不扩为默认放行', () => {
    const claims = materialClaims(EA_407, false);
    expect(claims.map(claim => claim.message)).toEqual([
      '材料规格拆分数量与蓝图权威不一致：塑料管（DN20）正文 5m，蓝图权威 40m',
      '材料规格拆分数量与蓝图权威不一致：塑料管（DN15）正文 1m，蓝图权威 171m',
    ]);
  });

  it('真实表格行（ea 249 行，桥接词「共」）→ 零 claim（既有量词紧邻口径不变）', () => {
    expect(materialClaims(EA_249_TABLE_ROW)).toEqual([]);
  });

  it('检测零 claim ⇒ 修复零改动（合规原文不得被改写，宁缺毋假）', () => {
    const fixed = fixResourceBreakdownNumbers(EA_270, authority());
    expect(fixed.markdown).toBe(EA_270);
    expect(fixed.fixedCount).toBe(0);
    expect(fixed.residualCount).toBe(0);
  });
});
