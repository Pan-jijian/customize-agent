import type { ConstructionOrgProjectType } from './constructionOrgCatalog';

/**
 * L2 知识引擎：施工工艺标准知识库。
 *
 * 目标：为"项目主要施工内容/主要分部分项工程施工方案"等工作包级小节提供工艺知识卡，
 * 使 LLM 在写作时能够落到工序链、工艺参数、材料规格、检测验收等专业细节，
 * 而不是只写"按规范施工、严格把控质量"式的空话。
 *
 * 覆盖整个建筑领域常见工作包：土方基础、主体结构、防水、装饰、机电安装、
 * 市政道路管网、改造加固、室外工程等。
 */

export interface ProcessKnowledgeCard {
  id: string;
  name: string;
  aliases: string[];
  /** 适用项目类型（空=通用） */
  projectTypes?: ConstructionOrgProjectType[];
  /** 工序链（→ 串联） */
  process: string[];
  /** 工艺参数要点（可写入施工方法的量化参数） */
  params: string[];
  /** 检测与验收要点 */
  acceptance: string[];
  /** 常见规范依据 */
  standards: string[];
}

export const PROCESS_KNOWLEDGE_CARDS: ProcessKnowledgeCard[] = [
  {
    id: 'earthwork-excavation',
    name: '土方开挖',
    aliases: ['土方', '基坑开挖', '土方开挖', '挖土'],
    process: ['测量放线', '标高复核', '分层开挖', '边坡修整', '基底验槽'],
    params: ['分层开挖厚度≤2m', '基底标高偏差0~-50mm', '边坡坡度按土质取1:0.5~1:1', '预留200~300mm人工清底'],
    acceptance: ['基底验槽', '钎探记录', '标高与轴线复核', '隐蔽验收记录'],
    standards: ['GB 50202-2018 建筑地基基础工程施工质量验收标准'],
  },
  {
    id: 'earthwork-backfill',
    name: '土方回填',
    aliases: ['素土回填', '填土碾压', '回填', '余方弃置', '人工清底'],
    process: ['基底隐蔽验收', '分层摊铺', '分层碾压', '压实度检测', '边角补夯', '表面整平'],
    params: ['每层虚铺厚度≤300mm', '填土含水率控制在最优含水率±2%', '压实系数≥0.94', '边角部位采用小型夯实机补夯', '压实度每层每100m²不少于1组检测'],
    acceptance: ['压实度检测报告', '回填土施工记录', '隐蔽验收记录'],
    standards: ['GB 50202-2018 建筑地基基础工程施工质量验收标准', 'GB 50268-2008 给水排水管道工程施工及验收规范'],
  },
  {
    id: 'foundation-pit-support',
    name: '基坑支护',
    aliases: ['基坑支护', '钢板桩', '土钉墙', '支护桩', '冠梁'],
    process: ['测量定位', '支护桩成孔', '钢筋笼制安', '混凝土浇筑', '冠梁施工', '分层开挖', '位移监测'],
    params: ['桩位偏差≤50mm', '垂直度≤1%', '冠梁顶标高偏差±10mm', '监测频率：开挖期每天1次', '报警值按设计位移速率3mm/d'],
    acceptance: ['桩身完整性检测', '锚杆拉拔试验', '基坑监测日报', '专项方案审批记录'],
    standards: ['JGJ 120-2012 建筑基坑支护技术规程', 'GB 50497-2019 建筑基坑工程监测技术标准'],
  },
  {
    id: 'pile-foundation',
    name: '桩基工程',
    aliases: ['桩基', '钻孔灌注桩', '预制桩', '静压桩', 'PHC管桩'],
    process: ['测量定位', '成孔（压桩）', '清孔验收', '钢筋笼制安', '混凝土灌注', '桩身检测'],
    params: ['桩径偏差±5mm', '沉渣厚度≤50mm（端承桩）', '充盈系数≥1.0', '桩顶标高偏差±10mm', '静载试验不少于总桩数1%且≥3根'],
    acceptance: ['桩基静载试验', '低应变/声波透射检测', '成孔记录', '钢筋隐蔽验收'],
    standards: ['JGJ 94-2008 建筑桩基技术规范', 'GB 50202-2018'],
  },
  {
    id: 'rebar-works',
    name: '钢筋工程',
    aliases: ['钢筋', '钢筋绑扎', '钢筋加工', '钢筋连接'],
    process: ['翻样下料', '加工成型', '运输堆放', '绑扎安装', '隐蔽验收'],
    params: ['直螺纹接头拧紧力矩值按规格控制', '接头错开≥35d且≥500mm', '保护层垫块间距≤1m', '绑扎搭接长度按图集16G101'],
    acceptance: ['钢筋原材复试', '接头工艺检验', '隐蔽工程验收记录', '保护层实测'],
    standards: ['GB 50204-2015 混凝土结构工程施工质量验收规范', 'JGJ 18-2012 钢筋焊接及验收规程'],
  },
  {
    id: 'formwork-works',
    name: '模板工程',
    aliases: ['模板', '模板支撑', '高支模', '脚手架模板'],
    process: ['方案编制', '立杆搭设', '主次龙骨铺设', '面板安装', '验收挂牌', '拆模申请'],
    params: ['立杆间距≤900×900mm（危大）', '扫地杆距地≤200mm', '水平杆步距≤1500mm', '剪刀撑连续设置', '拆模强度：板≥75%设计强度'],
    acceptance: ['高支模专项方案论证', '架体验收挂牌', '沉降变形监测', '拆模令'],
    standards: ['JGJ 162-2008 建筑施工模板安全技术规范', 'JGJ 130-2011 建筑施工扣件式钢管脚手架安全技术规范'],
  },
  {
    id: 'concrete-works',
    name: '混凝土工程',
    aliases: ['混凝土', '砼浇筑', '混凝土浇筑', '振捣'],
    process: ['浇筑申请', '坍落度检测', '分层浇筑', '振捣密实', '收面养护', '试块留置'],
    params: ['坍落度按配比±30mm', '分层浇筑厚度≤500mm', '振动棒快插慢拔', '养护≥7d（掺外加剂≥14d）', '标养试块每100m³≥1组'],
    acceptance: ['坍落度检测记录', '试块标养与同条件报告', '混凝土外观检查', '强度评定'],
    standards: ['GB 50204-2015', 'GB/T 50107-2010 混凝土强度检验评定标准'],
  },
  {
    id: 'steel-structure',
    name: '钢结构工程',
    aliases: ['钢结构', '钢构件', '焊接', '高强螺栓'],
    process: ['深化设计', '构件加工', '进场验收', '吊装就位', '校正固定', '焊接/螺栓连接', '涂装'],
    params: ['高强螺栓初拧终拧扭矩比1.1', '焊缝等级按设计一级/二级', '挠度允许值L/400', '防火涂料厚度按耐火极限'],
    acceptance: ['焊缝探伤检测', '高强螺栓扭矩检查', '构件尺寸偏差实测', '防火涂料厚度检测'],
    standards: ['GB 50205-2020 钢结构工程施工质量验收标准', 'JGJ 82-2011 钢结构高强度螺栓连接技术规程'],
  },
  {
    id: 'masonry-works',
    name: '砌体工程',
    aliases: ['砌体', '砌筑', '加气块', '二次结构'],
    process: ['弹线定位', '排砖撂底', '砌筑', '构造柱植筋', '圈梁浇筑', '顶砖处理'],
    params: ['灰缝厚度8~12mm', '垂直度偏差≤5mm（每层）', '拉结筋间距≤500mm', '顶砖间隔7d斜砌'],
    acceptance: ['砌筑砂浆试块', '构造柱钢筋隐蔽验收', '垂直度平整度实测', '拉结筋检测'],
    standards: ['GB 50203-2011 砌体结构工程施工质量验收规范'],
  },
  {
    id: 'waterproofing',
    name: '防水工程',
    aliases: ['防水', '屋面防水', '卫生间防水', '地下防水', '卷材'],
    process: ['基层处理', '阴阳角附加层', '防水层铺贴', '搭接密封', '闭水/淋水试验', '保护层'],
    params: ['卷材搭接宽度≥100mm', '附加层宽度≥500mm', '卫生间闭水试验48h', '屋面蓄水试验24h', '涂膜厚度按设计≥1.5mm'],
    acceptance: ['闭水/蓄水试验记录', '隐蔽验收记录', '防水材料复试', '淋水试验'],
    standards: ['GB 50207-2012 屋面工程质量验收规范', 'GB 50208-2011 地下防水工程质量验收规范'],
  },
  {
    id: 'plastering',
    name: '抹灰工程',
    aliases: ['抹灰', '粉刷', '墙面抹灰', '挂网'],
    process: ['基层处理', '浇水湿润', '打点冲筋', '分层抹灰', '压光', '养护'],
    params: ['不同基体交接处挂网宽≥200mm', '每遍抹灰厚度≤7mm', '平整度偏差≤4mm', '空鼓面积≤400cm²且不连续'],
    acceptance: ['空鼓敲击检查', '平整度垂直度实测', '养护记录'],
    standards: ['GB 50210-2018 建筑装饰装修工程质量验收标准'],
  },
  {
    id: 'tile-paving',
    name: '墙地砖铺贴',
    aliases: ['墙地砖', '瓷砖', '铺贴', '石材'],
    process: ['基层检查', '排砖放线', '选砖泡水', '铺贴', '勾缝', '成品保护'],
    params: ['粘结层厚度≤10mm', '接缝宽度按设计要求', '空鼓率单块≤15%且整面≤5%', '平整度偏差≤2mm'],
    acceptance: ['空鼓锤击检查', '平整度实测', '坡度泼水检查', '成品保护验收'],
    standards: ['GB 50210-2018'],
  },
  {
    id: 'ceil-partition',
    name: '吊顶与轻质隔墙',
    aliases: ['吊顶', '轻钢龙骨', '隔墙', '石膏板'],
    process: ['弹线定位', '龙骨安装', '面板安装', '接缝处理', '面层施工'],
    params: ['主龙骨间距≤1200mm', '吊杆间距≤1000mm', '罩面板接缝错开', '石膏板接缝处粘贴网格布'],
    acceptance: ['龙骨隐蔽验收', '面板平整度实测', '吊顶起拱检查'],
    standards: ['GB 50210-2018'],
  },
  {
    id: 'painting',
    name: '涂饰工程',
    aliases: ['涂料', '油漆', '乳胶漆', '腻子'],
    process: ['基层清理', '刮腻子', '打磨', '底漆', '面漆', '修整'],
    params: ['腻子每遍厚度≤2mm', '底漆1遍面漆2遍', '施工温度5~35℃', '平整度偏差≤2mm'],
    acceptance: ['涂层色泽均匀检查', '无流坠起皮检查', '平整度实测'],
    standards: ['GB 50210-2018'],
  },
  {
    id: 'door-window',
    name: '门窗工程',
    aliases: ['门窗', '铝合金窗', '幕墙', '玻璃'],
    process: ['洞口复核', '安装固定', '缝隙填塞', '打胶密封', '开启调试', '淋水试验'],
    params: ['框与墙间隙≤5mm', '密封胶连续饱满', '窗扇开关力≤50N', '气密水密性能按设计等级'],
    acceptance: ['淋水试验', '开启灵活检查', '垂直度偏差实测', '性能检测报告'],
    standards: ['GB 50210-2018', 'GB/T 7106-2019 建筑外门窗气密水密抗风压性能检测方法'],
  },
  {
    id: 'plumbing',
    name: '给排水工程',
    aliases: ['给排水', '给水管道', '排水管道', '管道安装'],
    process: ['预留预埋', '支架安装', '管道安装', '压力试验', '冲洗消毒', '通水试验'],
    params: ['给水管试验压力为工作压力1.5倍且≥0.6MPa', '排水管坡度按管径DN50~DN200取2.5%~0.8%', '支架间距按管径设置', 'PPR热熔温度260℃'],
    acceptance: ['管道水压试验', '通球试验', '灌水试验', '冲洗消毒记录'],
    standards: ['GB 50242-2002 建筑给水排水及采暖工程施工质量验收规范'],
  },
  {
    id: 'electrical',
    name: '电气工程',
    aliases: ['电气', '配管', '穿线', '桥架', '配电箱', '防雷接地'],
    process: ['预留预埋', '配管桥架', '穿线放缆', '设备安装', '绝缘测试', '通电调试'],
    params: ['管路弯曲半径≥6D（埋地≥10D）', '导线绝缘电阻≥0.5MΩ', '桥架支架间距≤1.5m', '防雷接地电阻≤1Ω'],
    acceptance: ['绝缘电阻测试', '接地电阻测试', '通电试运行', '隐蔽验收记录'],
    standards: ['GB 50303-2015 建筑电气工程施工质量验收规范'],
  },
  {
    id: 'hvac',
    name: '通风空调工程',
    aliases: ['通风空调', '风管', '空调', '新风', '保温'],
    process: ['风管制作', '吊架安装', '风管安装', '设备安装', '严密性试验', '系统调试'],
    params: ['风管支吊架间距≤3m', '中压风管漏光法检测', '保温层厚度按设计', '风口风速按设计值±10%'],
    acceptance: ['风管严密性试验', '风量平衡调试', '设备单机试运行', '系统联动调试'],
    standards: ['GB 50243-2016 通风与空调工程施工质量验收规范'],
  },
  {
    id: 'fire-protection',
    name: '消防工程',
    aliases: ['消防', '消火栓', '喷淋', '火灾报警', '防排烟'],
    process: ['预留预埋', '管道安装', '喷头/探测器安装', '系统试压', '联动调试', '检测验收'],
    params: ['喷淋试验压力≥1.4MPa', '消火栓充实水柱≥10m', '探测器保护半径按类别', '防排烟风管严密性'],
    acceptance: ['消防水压试验', '联动调试记录', '消防检测报告', '竣工验收备案'],
    standards: ['GB 50261-2017 自动喷水灭火系统施工及验收规范', 'GB 50166-2019 火灾自动报警系统施工及验收标准'],
  },
  {
    id: 'weak-current',
    name: '弱电智能化工程',
    aliases: ['弱电', '智能化', '综合布线', '监控', '门禁'],
    process: ['管线预埋', '桥架敷设', '线缆敷设', '设备安装', '单机调试', '系统联调'],
    params: ['双绞线弯曲半径≥4D', '光缆弯曲半径≥15D', '面板安装高度距地300mm', '链路测试按TIA-568'],
    acceptance: ['链路测试报告', '单机调试记录', '系统联调记录', '隐蔽验收'],
    standards: ['GB 50311-2016 综合布线系统工程设计规范', 'GB 50339-2013 智能建筑工程质量验收规范'],
  },
  {
    id: 'municipal-road',
    name: '道路工程',
    aliases: ['道路', '路基', '路面', '水稳', '沥青'],
    process: ['测量放线', '路基处理', '分层碾压', '水稳摊铺', '沥青摊铺', '标线设施'],
    params: ['路基压实度≥93%（路床）', '水稳层7d无侧限抗压强度按设计', '沥青压实度≥96%', '面层平整度≤5mm（3m直尺）'],
    acceptance: ['压实度检测', '弯沉检测', '取芯厚度检测', '平整度实测'],
    standards: ['CJJ 1-2008 城镇道路工程施工与质量验收规范'],
  },
  {
    id: 'municipal-pipe',
    name: '市政管道工程',
    aliases: ['管道', '雨污水', '沟槽', '检查井', '承插管'],
    process: ['测量放线', '沟槽开挖支护', '基础垫层', '管道安装', '接口处理', '闭水试验', '回填'],
    params: ['沟槽开挖放坡按土质1:0.33~1:0.5', '垫层厚度按设计≥100mm', '管道安装轴线偏差≤15mm', '闭水试验渗水量按GB 50268', '回填分层厚度≤250mm'],
    acceptance: ['闭水试验记录', '管内底高程检测', '管道CCTV检测', '回填压实度检测'],
    standards: ['GB 50268-2008 给水排水管道工程施工及验收规范'],
  },
  {
    id: 'demolition',
    name: '拆除工程',
    aliases: ['拆除', '墙体拆除', '结构拆除', '垃圾外运'],
    process: ['方案编制', '围挡隔离', '管线切断', '分层拆除', '垃圾清运', '验收交接'],
    params: ['拆除顺序自上而下', '垃圾清运日产日清', '湿法作业降尘', '既有保留部位防护到位'],
    acceptance: ['拆除专项方案', '既有设施保护检查', '垃圾清运记录'],
    standards: ['JGJ 147-2016 建筑拆除工程安全技术规范'],
  },
  {
    id: 'structural-strengthen',
    name: '结构加固',
    aliases: ['结构加固', '粘钢', '碳纤维', '植筋', '加大截面'],
    process: ['设计交底', '基层处理', '植筋', '粘贴加固', '养护', '检测验收'],
    params: ['植筋锚固深度按设计≥15d', '碳纤维布粘结强度≥2.5MPa', '胶粘剂固化时间按产品说明', '加大截面混凝土强度等级≥C25'],
    acceptance: ['拉拔试验', '粘结密实度检测', '隐蔽验收记录'],
    standards: ['GB 50367-2013 混凝土结构加固设计规范', 'GB 50550-2010 建筑结构加固工程施工质量验收规范'],
  },
  {
    id: 'facade-renovation',
    name: '外立面整治',
    aliases: ['外立面', '立面修补', '真石漆', '外保温'],
    process: ['脚手架搭设', '空鼓铲除', '界面处理', '保温层施工', '面层施工', '验收落架'],
    params: ['保温板粘贴面积≥40%', '锚栓数量每平米≥6个', '抗裂砂浆厚度3~5mm', '面层垂直度偏差≤4mm'],
    acceptance: ['粘结强度现场拉拔', '锚栓拉拔试验', '平整度实测'],
    standards: ['GB 50411-2019 建筑节能工程施工质量验收标准', 'JGJ 144-2019 外墙外保温工程技术标准'],
  },
  {
    id: 'scaffold',
    name: '脚手架工程',
    aliases: ['脚手架', '外架', '落地架', '悬挑架'],
    process: ['方案编制', '基础处理', '立杆搭设', '连墙件设置', '安全网封闭', '验收挂牌', '拆除'],
    params: ['立杆纵距≤1.5m', '连墙件两步三跨', '剪刀撑与地面夹角45°~60°', '悬挑架工字钢锚固长度≥1.25倍悬挑长度', '架体高于作业层1.5m'],
    acceptance: ['架体分段验收', '连墙件检查', '安全网封闭检查'],
    standards: ['JGJ 130-2011 建筑施工扣件式钢管脚手架安全技术规范'],
  },
  {
    id: 'tower-crane',
    name: '起重吊装',
    aliases: ['起重吊装', '塔吊', '吊装', '汽车吊'],
    process: ['方案编制', '设备报验', '基础验收', '安装调试', '检测备案', '日常检查', '拆除'],
    params: ['吊装作业半径内警戒', '吊索具安全系数≥6', '塔吊垂直度≤4‰', '风速≥6级停止吊装'],
    acceptance: ['特种设备检测', '安装验收记录', '司机指挥持证检查'],
    standards: ['JGJ 196-2010 建筑施工塔式起重机安装使用拆卸安全技术规程'],
  },
  {
    id: 'electrical-hookup',
    name: '临时用电',
    aliases: ['临电', '临时用电', '三级配电'],
    process: ['方案编制', '线路敷设', '配电箱设置', '接地保护', '验收送电', '日常巡检'],
    params: ['三级配电两级漏保', '漏电动作电流≤30mA/0.1s', 'PE线截面按相线1/2', '电缆埋深≥0.7m', '配电箱距地1.4~1.6m'],
    acceptance: ['绝缘电阻测试', '接地电阻测试', '验收送电记录'],
    standards: ['JGJ 46-2005 施工现场临时用电安全技术规范'],
  },
];

const CARD_BY_ALIAS = new Map<string, ProcessKnowledgeCard>();
const CARD_BY_ID = new Map<string, ProcessKnowledgeCard>();
for (const card of PROCESS_KNOWLEDGE_CARDS) {
  CARD_BY_ID.set(card.id, card);
  CARD_BY_ALIAS.set(card.name, card);
  for (const alias of card.aliases) CARD_BY_ALIAS.set(alias, card);
}

/** 泛化工作包名（如“安装工程”“结构加固改造工程”）→ 相关工艺卡组合，避免泛化名称无法精确命中别名 */
const BROAD_PACKAGE_CARD_GROUPS: Array<{ pattern: RegExp; cardIds: string[] }> = [
  { pattern: /安装工程|机电安装/u, cardIds: ['electrical', 'plumbing', 'hvac', 'fire-protection', 'weak-current'] },
  { pattern: /结构加固|加固改造/u, cardIds: ['structural-strengthen', 'concrete-works', 'rebar-works', 'formwork-works'] },
  { pattern: /装饰工程|装饰装修/u, cardIds: ['plastering', 'tile-paving', 'ceil-partition', 'painting', 'door-window'] },
  { pattern: /外墙|屋面|立面/u, cardIds: ['facade-renovation', 'waterproofing', 'scaffold'] },
  { pattern: /室外道排|道排|室外管网|雨污水/u, cardIds: ['municipal-pipe', 'municipal-road', 'earthwork-excavation'] },
  { pattern: /智能化/u, cardIds: ['weak-current'] },
  { pattern: /消防/u, cardIds: ['fire-protection'] },
  { pattern: /拆除/u, cardIds: ['demolition'] },
  { pattern: /水电改造/u, cardIds: ['plumbing', 'electrical'] },
];

/** 按工作包名匹配工艺知识卡：精确别名 → 包含匹配 → 泛化工作包分组 */
export function matchProcessKnowledgeCards(workPackageNames: string[], projectTypes: ConstructionOrgProjectType[] = []): ProcessKnowledgeCard[] {
  const matched = new Set<ProcessKnowledgeCard>();
  for (const name of workPackageNames) {
    const direct = CARD_BY_ALIAS.get(name);
    if (direct) matched.add(direct);
    // 包含匹配：工作包名包含别名关键词（如“室外道排工程”含“道排”）
    for (const [alias, card] of CARD_BY_ALIAS) {
      if (alias.length >= 3 && name.includes(alias)) matched.add(card);
    }
    // 泛化工作包名 → 卡片组
    for (const group of BROAD_PACKAGE_CARD_GROUPS) {
      if (group.pattern.test(name)) {
        for (const cardId of group.cardIds) {
          const card = CARD_BY_ID.get(cardId);
          if (card) matched.add(card);
        }
      }
    }
  }
  // 按项目类型补充适用卡
  for (const card of PROCESS_KNOWLEDGE_CARDS) {
    if (matched.size >= 16) break;
    if (!card.projectTypes || card.projectTypes.some(type => projectTypes.includes(type))) matched.add(card);
  }
  return [...matched].slice(0, 16);
}

/**
 * 生成工作包写作知识卡提示：注入给 LLM，使其能落到工序链、工艺参数与检测验收。
 * 知识卡仅作为工艺写作参考，项目特有数据必须来自绑定资料；资料未提供的参数不得编造。
 */
export function buildProcessKnowledgePrompt(cards: ProcessKnowledgeCard[], packageNames: string[]): string {
  if (cards.length === 0) return '';
  const cardLines = cards.map(card => {
    const isDirect = packageNames.some(name => card.aliases.includes(name) || name === card.name);
    return [
      `${isDirect ? '【直接匹配】' : '【项目类型通用】'}${card.name}：`,
      `- 工序链：${card.process.join('→')}`,
      `- 工艺参数（参考）：${card.params.join('；')}`,
      `- 检测验收：${card.acceptance.join('；')}`,
      `- 规范依据：${card.standards.join('；')}`,
    ].join('\n');
  });
  return [
    '【施工工艺知识卡】',
    '以下为本领域常见工作包的工艺参考。写作"施工概况/施工流程/施工方法"时：',
    '1) 工序链必须与本项目资料确认的对象匹配，可裁剪但不得照搬无关工序；',
    '2) 工艺参数仅作为专业表达参考，只有在绑定资料明确时才写入具体数值，否则写控制方向（如"按规范控制桩位偏差"）而非编造数字；',
    '3) 检测验收必须落到记录名称（如"闭水试验记录、隐蔽验收记录、静载试验报告"）。',
    ...cardLines,
  ].join('\n');
}
