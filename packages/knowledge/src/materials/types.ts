/**
 * 资料知识层的**目标模型**（4.61）。
 *
 * ## 为什么要有这一层
 *
 * 现行链路的病根只有一条：**在信息最全的地方（资料解析）不做判断，在信息被剥光的地方
 * （拍平后的文本）反复猜**。具体表现：
 *
 * - `content-extractor.CadAnnotation` 已经抽出 `{ text, x, y, layer, block, entityType }`，
 *   紧接着 `layoutCadAnnotations(annotations): string[]` 把图层、坐标、实体类型全部丢弃——
 *   DXF 的 `DIMENSION` 实体自带被标注两点与测量值、`LEADER` 天然连接文字与图形、
 *   图层名（`砼梁`/`楼板负筋文字`/`基础集中标注`）本身就是分类语义，**绑定所需的信息全在，
 *   是我们的返回类型把它丢了**。于是下游出现「尺寸绑不上」「无主数值」。
 * - 表格被拍平成文本 → 清单项目特征串行错位。
 * - 载体不分 → 图纸设计说明（对施工方提要求）混进招标要求池（对投标人提要求），
 *   产出大量**永远无法被响应**的锚点（实测 1076 条池子里 262 条不可响应，其中 69% 是残片形态）。
 * - 权威用一条**全局梯**（答疑 > 澄清 > 招标正文 > 清单 > 图纸）套所有语义域 →
 *   跨域互比（「套管 DN100 正文 55 个 vs 蓝图 18 个」＝清单工程量与图纸规格互比）。
 *
 * ## 三条第一性原理
 *
 * 1. **结构不可再生**：文件原生结构（坐标/图层/行列/编号/图框）一旦拍平即永久丢失，
 *    下游只能用形状猜。禁止任何层把结构化对象降级为字符串。
 * 2. **语义由载体决定，不由内容决定**：同一句「保护层不小于30mm」，在图纸设计说明里是
 *    设计事实，在评标办法里是编制义务。任何语义判定必须在知道载体之后做。
 * 3. **绑定是解析完备性的责任**：绑定失败＝解析器缺陷，必须作为质量指标上报，
 *    禁止写成规则例外静默吞掉。
 */

// ─────────────────────────── 语义域与权威载体 ───────────────────────────

/**
 * 语义域：决定「冲突时按哪一条权威序裁决」。
 *
 * 域是权威的单位——**不存在一条全局权威梯**。同一份图纸里「设计说明」与「图签」的权威不同，
 * 同一份清单里「工程量」与「项目特征」的权威也不同；「图纸大还是清单大」这个问题
 * 只有在给定语义域之后才有答案。
 */
export type FactDomain =
  /** 几何空间：标高、尺寸、位置、轴线、坡度 */
  | 'geometry'
  /** 材料与构造：规格、牌号、强度等级、做法层次、厚度 */
  | 'material'
  /** 设备与系统：型号、参数、系统构成、控制逻辑 */
  | 'equipment'
  /** 性能指标：强度、电阻、照度、耐火极限、节能指标 */
  | 'performance'
  /** 工程量：数量、面积、体积、长度、时长 */
  | 'quantity'
  /** 契约口径：工期、地点、质量目标、计价规则、责任划分 */
  | 'caliber';

/**
 * 权威载体：事实的**来源角色**。
 *
 * 比「文件」细一层——这是关键：`drawing` 作为一个整体不构成权威等级，
 * 图纸里的「设计说明」「标注」「材料表」三者的权威强度并不相同。
 */
export type AuthorityCarrier =
  /** 图纸设计说明/总说明（设计意志的正式表述） */
  | 'drawing-note'
  /** 图纸标注：尺寸、标高、引线注释 */
  | 'drawing-annotation'
  /** 图纸材料表/门窗表/设备表 */
  | 'drawing-schedule'
  /** 现行规范/标准（公共知识，带编号） */
  | 'code'
  /** 清单项目特征描述 */
  | 'boq-feature'
  /** 清单工程量 */
  | 'boq-quantity'
  /** 招标文件正文条款 */
  | 'tender-clause'
  /** 答疑/澄清/补遗 */
  | 'clarification'
  /** 评标办法/评分细则 */
  | 'evaluation-rule';

// ─────────────────────────── 出处坐标 ───────────────────────────

/**
 * 出处坐标：可回指到**源结构**的定位（不是"哪个文件"，而是"文件里的哪一处结构"）。
 *
 * 不变式 1（结构守恒）要求：每条知识都能回指到这里声明的字段。
 * 缺失 `position` 的知识不得进入权威层——因为无法参与「谁的哪一处与谁冲突」的裁决。
 */
export interface SourceAnchor {
  filePath: string;
  /** 载体角色（由解析层确定，下游不得重新推断） */
  carrier: AuthorityCarrier;
  /** 文件内分区：图框名/图号（DWG）、页码（PDF）、工作表名（XLS） */
  sheet?: string;
  /** DWG：图层名（分类语义）；PDF：栏目；XLS：无 */
  layer?: string;
  /** 实体类型：DWG 为 TEXT/MTEXT/DIMENSION/LEADER/ATTRIB/TABLE；XLS 为 ROW；PDF 为 PARAGRAPH/TABLE_ROW */
  entityType?: string;
  /** 空间或结构位置：DWG 用 x/y，表格用 row/col，文本用字符区间 */
  position?: {
    x?: number;
    y?: number;
    row?: number;
    col?: number;
    start?: number;
    end?: number;
  };
  /** 条款编号（招标文件/设计说明的编号体系：第X条 / 8.13 / (4) / 一、） */
  clauseNo?: string;
}

// ─────────────────────────── 两类一等对象 ───────────────────────────

/** 值的关系形态：约束型事实（`>=`/`<=`/`range`）与赋值型事实同样是一等公民 */
export type FactRelation = '=' | '>=' | '<=' | 'range' | 'enum' | 'text';

/**
 * 设计事实：**这个工程是什么**。
 *
 * 来源可以是图纸设计说明、图纸标注、图纸材料表、清单、规范。工程约束
 * （「保护层不小于30mm」）**不是第三类对象**，它就是 `relation ∈ {>=,<=,range}` 的
 * DesignFact——单列会造成同一事实两处存放、两处漂移。
 */
export interface DesignFact {
  id: string;
  /** 对象：构件/材料/设备/系统/部位（如「屋面接闪带」「人工接地体」「防水层」） */
  subject: string;
  /** 属性：厚度/规格/强度等级/标高/数量/型号/电阻/… */
  attribute: string;
  /** 值（原样保留，不做单位换算） */
  value: string;
  unit?: string;
  relation: FactRelation;
  domain: FactDomain;
  carrier: AuthorityCarrier;
  anchor: SourceAnchor;
  /**
   * 裁决键：`domain\0subject\0attribute` 的归一化形式。
   * 只有同键的事实才允许互相比较——**跨域禁止互比**（不变式 4）。
   */
  key: string;
}

/**
 * 编制义务：**投标文件必须怎么写**。
 *
 * 与 DesignFact 的判别式是**收件人**，不是"义务性"——图纸设计说明也全是「应」「不应」，
 * 但收件人是施工方。收件人为投标人/投标文件的才进要求池。
 */
export interface BidObligation {
  id: string;
  text: string;
  /** 条款编号：**必填**。没有编号体系的载体不产生 BidObligation（不变式 5） */
  clauseNo: string;
  /** 只可能是 tender-clause / clarification / evaluation-rule 三者之一 */
  carrier: Extract<AuthorityCarrier, 'tender-clause' | 'clarification' | 'evaluation-rule'>;
  category: string;
  /** 可响应锚点（核心词、数值、专名） */
  anchors: string[];
  anchorSource: SourceAnchor;
}

// ─────────────────────────── 权威格（按域，无全局梯） ───────────────────────────

/**
 * 权威序：**按语义域给出**，从左到右递减。
 *
 * 「企业经验」已按业务要求整体移除——它不是权威来源，是写作风格来源，
 * 混入权威序会让"以前这么写过"变成"数据依据"。
 */
/**
 * 权威格：**每个域都是全域排列**（九个载体全在），位置即冲突优先级。
 *
 * ## 两条构造规则
 *
 * 1. **答疑/澄清在每个域都排第一**。这不是"来源归属"而是"冲突优先级"：答疑是招标人对
 *    全部文件的**最终意思表示**，它修正的对象不限于条款——把「窗材质改为2.5mm」写在答疑里，
 *    它就压过图纸与清单。域差异体现在**答疑之后**的顺序。
 *    （初版把 clarification 排在 material 域第 7 位，等于说"图纸说明比答疑权威"，
 *    实机回归立刻以「变更链被吞、清单值胜出」的形式暴露出来。）
 * 2. 答疑之后的顺序按**该域的自然载体**排：设计参数看图纸、工程量看清单、几何看标注。
 *    「图纸 vs 清单」这个常见问题由此有了域相关的答案——设计参数域图纸大、工程量域清单大。
 */
export const AUTHORITY_LATTICE: Readonly<Record<FactDomain, readonly AuthorityCarrier[]>> = {
  // 设计参数：图纸是设计意志的唯一载体，清单项目特征是它的摘要（实测巢湖清单 995 条切片中
  // 646 条（65%）在项目特征里写「未尽事宜：详见施工图纸」——清单自己承认规格在图纸里）
  material: ['clarification', 'drawing-note', 'drawing-schedule', 'drawing-annotation', 'boq-feature', 'code', 'tender-clause', 'evaluation-rule', 'boq-quantity'],
  // 性能指标：设计说明给设计值、规范给限值，两者同域可比且都强于摘要性描述
  performance: ['clarification', 'drawing-note', 'code', 'drawing-schedule', 'boq-feature', 'drawing-annotation', 'tender-clause', 'evaluation-rule', 'boq-quantity'],
  // 设备与系统：设备表（材料表/设备表）是设备参数的直接载体，系统图次之
  equipment: ['clarification', 'drawing-schedule', 'drawing-note', 'drawing-annotation', 'boq-feature', 'code', 'tender-clause', 'evaluation-rule', 'boq-quantity'],
  // 几何空间：标注（尺寸/标高）比说明文字更精确
  geometry: ['clarification', 'drawing-annotation', 'drawing-note', 'drawing-schedule', 'boq-feature', 'code', 'tender-clause', 'evaluation-rule', 'boq-quantity'],
  // 工程量：清单是法定计价口径，图纸算量属推导
  quantity: ['clarification', 'boq-quantity', 'boq-feature', 'drawing-schedule', 'drawing-note', 'drawing-annotation', 'tender-clause', 'evaluation-rule', 'code'],
  // 契约口径：本身就是契约问题，答疑之后按招标文件效力递减
  caliber: ['clarification', 'tender-clause', 'evaluation-rule', 'boq-feature', 'boq-quantity', 'drawing-note', 'drawing-schedule', 'drawing-annotation', 'code'],
};

/** 某载体在某域中的权威强度（越小越权威）；不在该域序列中的载体返回 Infinity（不参与该域裁决） */
export function authorityRank(domain: FactDomain, carrier: AuthorityCarrier): number {
  const index = AUTHORITY_LATTICE[domain].indexOf(carrier);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}
