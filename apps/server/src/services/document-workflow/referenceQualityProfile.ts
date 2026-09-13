/**
 * 工程类型判别（纯函数，无 IO）。
 * 现役职责：为蓝图推导策略路由（village-municipal/building/general 等）提供
 * 模板/资料/清单文本 → 工程类型的 13 类竞争制判别。
 * 历史沿革：4.26.0 起模板参考库（样本质量画像对标）已整体移除，
 * 本文件仅保留类型判别能力，不再承载画像提取（buildReferenceQualityProfile 已删除）。
 */

/** 参考文件支持的工程类型（覆盖建筑行业主要招标类型） */
export const REFERENCE_PROJECT_TYPES = ['房建', '市政', '公路', '桥梁与隧道', '水利水电', '电力', '机电安装', '装饰装修', '园林绿化', '铁路', '港口与航道', '矿山冶金', '其他'] as const;
export type ReferenceProjectType = (typeof REFERENCE_PROJECT_TYPES)[number];

/** 工程类型自动分类建议：强判别词竞争制 + 密度兜底仲裁 */
export function suggestProjectType(text: string): ReferenceProjectType {
  const head = text;
  // 密度兜底先算（仲裁依据）：房建含大量通用词（楼/结构/主体），放最后避免抢占其他类型
  const signals: Array<[ReferenceProjectType, RegExp]> = [
    ['市政', /市政|管网|排水|给水|雨污|污水|燃气/gu],
    ['公路', /公路|路基|路面|沥青/gu],
    ['桥梁与隧道', /桥梁|隧道/gu],
    ['水利水电', /水利|河道|灌溉|防洪/gu],
    ['电力', /电力|供配电|电压|电缆/gu],
    ['机电安装', /机电|暖通|通风|空调|消防|给排水|智能化|电梯/gu],
    ['装饰装修', /装饰|装修|幕墙/gu],
    ['园林绿化', /园林|绿化|景观|苗木/gu],
    ['铁路', /铁路|轨道/gu],
    ['港口与航道', /港口|航道/gu],
    ['矿山冶金', /矿山|冶金/gu],
    ['房建', /房建|建筑|住宅|楼|结构|砌体|基坑|地下室|主体|层高|户型|公共建筑|产业园|厂房/gu],
  ];
  const scores = signals.map(([type, re]) => {
    re.lastIndex = 0;
    const count = (head.match(re) || []).length;
    return { type, count };
  }).sort((a, b) => b.count - a.count);
  const densityBest = scores[0];
  // 强判别词竞争制：部分类型文件大量使用其他类型的通用词（如产业园项目含"跨线桥"、
  // 卫生院项目含"沥青路面"），顺序短路会误判；改为各组计数、命中 ≥3 次且频次最高者胜出。
  // 房建专有词（产业园/厂房/卫生院等）放最前，防止被"桥梁/沥青"等通用词抢占
  const strongSignals: Array<[ReferenceProjectType, RegExp]> = [
    ['房建', /产业园|标准厂房|安置房|住宅小区|保障房|卫生院|门诊楼|办公楼/gu],
    ['市政', /老旧小区|海绵城市|雨污分流|管网改造|管廊/gu],
    ['桥梁与隧道', /桥梁|隧道|盾构|箱梁|斜拉|悬索|涵洞/gu],
    ['公路', /公路|路基|路面|沥青|桩号|互通|匝道/gu],
    ['水利水电', /堤防|水库|泵站|水闸|疏浚|节制闸|水电站|大坝|围堰/gu],
    ['电力', /变电站|输电线路|配电|GIS设备|电缆|架空线路|铁塔|箱变/gu],
    ['铁路', /铁路|轨道|道床|站台|信号机|接触网/gu],
    ['港口与航道', /港口|码头|航道|护岸|堆场|泊位/gu],
    ['矿山冶金', /矿山|矿井|选矿|冶炼|尾矿|轧钢/gu],
  ];
  let bestType: ReferenceProjectType | undefined;
  let bestCount = 0;
  let secondCount = 0;
  for (const [type, re] of strongSignals) {
    re.lastIndex = 0;
    const count = (head.match(re) || []).length;
    if (count >= 3 && count > bestCount) { secondCount = bestCount; bestType = type; bestCount = count; }
    else if (count > secondCount) secondCount = count;
  }
  if (bestType) {
    // 竞争接近（冠军不足亚军 2 倍）且密度兜底存在显著更强的类型信号时，以密度兜底为准，
    // 修正综合体项目（卫生院配套道路、园区基础设施）被通用词带偏的误判
    if (secondCount > 0 && bestCount < secondCount * 2 && densityBest && densityBest.count > bestCount) return densityBest.type;
    // 强判别冠军与密度兜底冲突仲裁：密度最佳类型异于冠军，且密度信号同时显著强于
    // 冠军类型自身密度信号（2 倍）与冠军判别词频次（2 倍）时改判密度最佳，
    // 修正装修/房建改造项目水电章节的"配电/电缆"子专业词被电力强判别词带偏的误判
    // （真实生成缺陷：徽光阁既有建筑改造项目被判电力，对标基准与蓝图注入全链路错位）
    const championDenseCount = scores.find(item => item.type === bestType)?.count || 0;
    if (densityBest && densityBest.type !== bestType && densityBest.count > championDenseCount * 2 && densityBest.count >= bestCount * 2) return densityBest.type;
    return bestType;
  }
  return densityBest && densityBest.count > 0 ? densityBest.type : '其他';
}
