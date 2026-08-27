import { describe, expect, it } from 'vitest';
import { buildReferenceQualityProfile, suggestProjectType, REFERENCE_PROJECT_TYPES } from '../src/services/document-workflow/referenceQualityProfile';

/** 模拟 PDF 提取文本形态：行首 "## " 前缀、"第X章、"标题、参数、工序链、表格标题行 */
const SAMPLE_PDF_TEXT = [
  '资料类型: document/pdf',
  'MIME: application/pdf',
  '## PDF 第 1 页',
  '# XX项目施工组织设计',
  '## 目录',
  '## 第一章、工程概况 ...................... 1',
  '## 第二章、施工部署 ...................... 5',
  '## PDF 第 2 页',
  '## 第一章、工程概况',
  '## 本工程建筑面积 12000 ㎡，主体结构采用框架结构，层高 3.6m。',
  '## 第一节、基本参数',
  '## 混凝土强度等级 C30，钢筋搭接长度 40d，板厚 120mm。',
  '## 第二节、施工工序',
  '## 施工流程：测量放线→土方开挖→垫层施工→基础施工→主体结构→装饰装修。',
  '## 第二章、施工部署',
  '## 第一节、劳动力计划',
  '## 一、拟投入的劳动力计划表',
  '## 计划投入钢筋工 20 人，木工 30 人，养护人员 5 人。',
  '## 水泥砂浆配合比为 1:3，压实度不低于 93%，坡度控制在 2%。',
  '## 表1-1 主要材料计划表',
  '## 钢材 120t，水泥 500t，砂石 2000t。',
  '## 养护时间不少于 7 天，试验压力 0.6MPa。',
  '## 养护时间不少于 7 天，试验压力 0.6MPa。',
  '## 安徽XX建筑公司—2—',
].join('\n');

describe('buildReferenceQualityProfile', () => {
  it('提取字数、参数密度与参数命中数', () => {
    const profile = buildReferenceQualityProfile(SAMPLE_PDF_TEXT);
    expect(profile.wordCount).toBeGreaterThan(200);
    expect(profile.paramCount).toBeGreaterThanOrEqual(5);
    expect(profile.paramDensity).toBeGreaterThan(0);
  });

  it('统计工序链覆盖率（含"→"段落占比）', () => {
    const profile = buildReferenceQualityProfile(SAMPLE_PDF_TEXT);
    expect(profile.arrowChainCoverage).toBeGreaterThan(0);
    expect(profile.arrowChainCoverage).toBeLessThanOrEqual(1);
  });

  it('识别重复段落（重复率大于 0）', () => {
    const profile = buildReferenceQualityProfile(SAMPLE_PDF_TEXT);
    expect(profile.duplicationRate).toBeGreaterThan(0);
  });

  it('提取章节标题结构（容忍 "## " 前缀与"第X章、"格式，过滤目录点线行与页码行）', () => {
    const profile = buildReferenceQualityProfile(SAMPLE_PDF_TEXT);
    expect(profile.headingStructure).toContain('工程概况');
    expect(profile.headingStructure).toContain('施工部署');
    // 目录行带点线页码，不应重复计入
    expect(profile.headingStructure.filter(title => title === '工程概况').length).toBe(1);
    expect(profile.sectionCount).toBeGreaterThanOrEqual(2);
  });

  it('统计表格标题行（"XX表"/"表X-X"结尾）', () => {
    const profile = buildReferenceQualityProfile(SAMPLE_PDF_TEXT);
    expect(profile.tableCount).toBeGreaterThanOrEqual(2);
  });

  it('分层统计小节与子目（"第X节"计小节、"一、"计子目，不混级）', () => {
    const profile = buildReferenceQualityProfile(SAMPLE_PDF_TEXT);
    expect(profile.subsectionCount).toBeGreaterThanOrEqual(3);
    expect(profile.subitemCount).toBeGreaterThanOrEqual(1);
  });

  it('空文本返回零画像', () => {
    const profile = buildReferenceQualityProfile('');
    expect(profile.wordCount).toBe(0);
    expect(profile.paramCount).toBe(0);
    expect(profile.headingStructure).toEqual([]);
  });

  it('中文单位参数命中（米/厘米/吨/平方米等，允许后跟量词）', () => {
    const text = '基坑深度 5 米，桩长 12 米，混凝土厚度 200 毫米，水泥用量 300 吨，建筑面积 8000 平方米，基坑深 6 米。';
    const profile = buildReferenceQualityProfile(text);
    expect(profile.paramCount).toBeGreaterThanOrEqual(6);
    expect(profile.paramDensity).toBeGreaterThan(0);
    // 中文单位应归并入数值参数词条
    const numeric = profile.paramTokens.find(item => item.token === '数值参数（数字+单位）');
    expect(numeric?.count).toBeGreaterThanOrEqual(6);
  });

  it('标题清洗：PDF 断字空白去除、目录行尾部页码剥离、与正文标题去重', () => {
    const text = [
      '## 第一章、工程概况 12',
      '## 第一章、工程概况',
      '## 第二章、确 保工期与质量的保障体系 35',
      '## 第二章、确保工期与质量的保障体系',
    ].join('\n');
    const profile = buildReferenceQualityProfile(text);
    expect(profile.headingStructure).toContain('工程概况');
    expect(profile.headingStructure).toContain('确保工期与质量的保障体系');
    // 目录行与正文标题应归一为同一条
    expect(profile.headingStructure.filter(title => title === '工程概况').length).toBe(1);
    expect(profile.headingStructure.filter(title => title === '确保工期与质量的保障体系').length).toBe(1);
    expect(profile.sectionCount).toBe(2);
  });

  it('章标题含顿号（组合标题"新技术、新工艺"）不误杀', () => {
    const text = '## 第一章、拟采用的新技术、新工艺\n## 第二章、确保人、材、机的保障体系与措施';
    const profile = buildReferenceQualityProfile(text);
    expect(profile.headingStructure).toEqual(['拟采用的新技术、新工艺', '确保人、材、机的保障体系与措施']);
    expect(profile.sectionCount).toBe(2);
  });

  it('同章号目录行与正文行去重取正文（末次出现，含目录行被 PDF 截断无点线形态）', () => {
    const text = [
      '## 第二章确保工期与质量的保障体系与措施、确保安全文明生产的管理体系与措',
      '## 第二章 确保工期与质量的保障体系与措施、确保安全文明生产的管理',
    ].join('\n');
    const profile = buildReferenceQualityProfile(text);
    expect(profile.headingStructure).toEqual(['确保工期与质量的保障体系与措施、确保安全文明生产的管理']);
    expect(profile.sectionCount).toBe(1);
  });

  it('目录截断行先出现时章号仍按数值排序（第一章在前）', () => {
    const text = [
      '## 第二章确保工期与质量的保障体系与措施、确保安全文明生产的管理体系与措',
      '## 第一章 工程重点难点及危大工程保障体系',
      '## 第二章 确保工期与质量的保障体系与措施、确保安全文明生产的管理',
      '## 第三章 人材机保障体系与措施',
    ].join('\n');
    const profile = buildReferenceQualityProfile(text);
    expect(profile.headingStructure).toEqual([
      '工程重点难点及危大工程保障体系',
      '确保工期与质量的保障体系与措施、确保安全文明生产的管理',
      '人材机保障体系与措施',
    ]);
    expect(profile.sectionCount).toBe(3);
  });

  it('PDF 断行截断的长标题自动续接下一短行', () => {
    const text = [
      '# 第三章、确保工期与质量的保障体系与措施、确保安全文明生产的管',
      '## 理体系与措施',
      '## 本工程建筑面积 12000 ㎡。',
    ].join('\n');
    const profile = buildReferenceQualityProfile(text);
    expect(profile.headingStructure).toEqual(['确保工期与质量的保障体系与措施、确保安全文明生产的管理体系与措施']);
    expect(profile.sectionCount).toBe(1);
  });

  it('正文行以"第X章"开头引用章节（含逗号/句号）不误捕为标题', () => {
    const text = [
      '## 第一章、工程概况',
      '## 第七章一致，不含雨水箱涵基坑）。①桥梁承台基坑：C30 承台 148.1m³，按设计开挖深度',
      '## 第二章、施工部署',
    ].join('\n');
    const profile = buildReferenceQualityProfile(text);
    expect(profile.headingStructure).toEqual(['工程概况', '施工部署']);
    expect(profile.sectionCount).toBe(2);
  });

  it('多级编号"1.1"不误判为一级章节（仅单级数字编号为一级；1.1 计子目不计小节）', () => {
    const text = '## 1.1 工程概况\n## 1.1.2 详细参数\n## 3. 编制依据\n## 5. 施工部署\n## 6. 质量保证措施';
    const profile = buildReferenceQualityProfile(text);
    expect(profile.headingStructure).toEqual(['编制依据', '施工部署', '质量保证措施']);
    expect(profile.sectionCount).toBe(3);
    expect(profile.subsectionCount).toBe(0);
    expect(profile.subitemCount).toBe(2);
  });

  it('无"第X章/编号"格式时中文序号"一、"降级为一级章节且不再计入子目', () => {
    const text = '## 一、工程概况\n## 二、施工部署\n## 三、质量措施\n## （一）劳动力计划\n## 1.1 基本参数';
    const profile = buildReferenceQualityProfile(text);
    expect(profile.headingStructure).toEqual(['工程概况', '施工部署', '质量措施']);
    expect(profile.sectionCount).toBe(3);
    // "（一）/1.1" 计子目；"一、"已提升为章节，不重复计
    expect(profile.subsectionCount).toBe(0);
    expect(profile.subitemCount).toBe(2);
  });

  it('表格识别覆盖"XX清单"标题（清单/计划类表格）', () => {
    const text = '## 主要工程量清单\n## 施工机械设备配置表\n## 材料进场计划';
    const profile = buildReferenceQualityProfile(text);
    expect(profile.tableCount).toBeGreaterThanOrEqual(2);
    expect(profile.tableTitles).toContain('主要工程量清单');
    expect(profile.tableTitles).toContain('施工机械设备配置表');
  });

  it('正文有效字数口径：密度分母为有效段落字数而非全文（含噪声）', () => {
    const text = [
      '## 目录',
      '## 第一章、工程概况 ...................... 1',
      '## 第一章、工程概况',
      '## 本工程建筑面积 12000 ㎡，基坑深度 5 米，混凝土强度等级 C30，板厚 120mm，压实度不低于 93%。',
    ].join('\n');
    const profile = buildReferenceQualityProfile(text);
    expect(profile.effectiveWordCount).toBeGreaterThan(0);
    expect(profile.effectiveWordCount).toBeLessThan(profile.wordCount);
    expect(profile.paramDensity).toBeGreaterThan(0);
  });
});

describe('suggestProjectType', () => {
  it('老旧小区改造判市政（优先于大量房建通用词）', () => {
    const text = '本工程为老旧小区改造提升项目，涉及多栋住宅楼外立面整治、屋面防水、楼道改造、雨污分流管网改造、海绵城市建设。楼栋共 32 栋，建筑面积约 20 万㎡。';
    expect(suggestProjectType(text)).toBe('市政');
  });

  it('含桥梁隧道桩号判公路', () => {
    const text = '本项目桥梁 3 座、隧道 2 座，桩号 K0+000 至 K5+200，设互通 2 处、匝道 4 条。路面结构采用沥青混凝土。';
    expect(suggestProjectType(text)).toBe('公路');
  });

  it('普通房建判房建（沥青/路面仅室外配套不误判）', () => {
    const text = '本项目为医疗业务用房建设工程，主体为框架结构，层高 3.6 米，室外配套含沥青路面道路。建筑面积约 8000㎡，基坑深度 5 米。';
    expect(suggestProjectType(text)).toBe('房建');
  });

  it('水利关键词判水利水电（13 类扩展后）', () => {
    const text = '本项目包含泵站 2 座、节制闸 3 座、堤防加固 5km，疏浚河道 10km。';
    expect(suggestProjectType(text)).toBe('水利水电');
  });

  it('桥隧专有工程判桥梁与隧道（优先于公路通用词）', () => {
    const text = '本项目为特大桥及长隧道工程，主桥采用斜拉桥，主跨 420 米，隧道长度 3.2km，含锚碇、索塔与衬砌施工。';
    expect(suggestProjectType(text)).toBe('桥梁与隧道');
  });

  it('发电输电工程判电力', () => {
    const text = '本项目新建 110kV 变电站一座，架设输电线路 12km，安装主变压器 2 台，含电缆敷设与接地网施工。';
    expect(suggestProjectType(text)).toBe('电力');
  });

  it('装修改造项目水电章节配电词密集仍判房建（密度仲裁修正强判别误判）', () => {
    const text = '本项目为既有建筑装修改造工程，主体为三层框架结构建筑，总建筑面积约4600平方米，层高3.6米。工程内容包括室内装饰装修、结构加固、水电改造、消防改造、通风空调、室外道排等。配电箱共64个、配电回路128路、配电系统按三级保护配置，电缆总长8600米。装饰装修面积3800平方米，拆除垃圾外运160吨，结构加固采用碳纤维布1200平方米。营业商铺位于沿街建筑一层，建筑外立面同步翻新，主体结构为框架结构，楼内管线密集，属公共建筑改造范畴。';
    expect(suggestProjectType(text)).toBe('房建');
  });

  it('变电站工程判别词与密度词同向仍判电力（不误伤真电力项目）', () => {
    const text = '本项目新建110kV变电站一座，变电站围墙内设主变区、配电装置区，配电装置采用GIS设备，架设输电线路12公里，电缆敷设8公里，架空线路沿线设铁塔。设备安装调试后送电。';
    expect(suggestProjectType(text)).toBe('电力');
  });

  it('港航工程判港口与航道', () => {
    const text = '本项目新建码头泊位 3 个，疏浚航道 5km，建设防波堤与护岸工程，含水工建筑物施工。';
    expect(suggestProjectType(text)).toBe('港口与航道');
  });

  it('无信号文本返回其他', () => {
    expect(suggestProjectType('这是一段没有任何工程类型信号的文字。')).toBe('其他');
  });

  it('返回类型在合法枚举内', () => {
    expect(REFERENCE_PROJECT_TYPES).toContain(suggestProjectType(SAMPLE_PDF_TEXT));
  });
});

describe('tableCount 分块计数口径（P2-6）', () => {
  it('连续管道表格行块整块计 1 张（历史口径逐行计数虚高）', () => {
    const text = [
      '| 序号 | 设备名称 | 数量 |',
      '|---|---|---|',
      '| 1 | 塔吊 | 2 台 |',
      '| 2 | 挖机 | 3 台 |',
      '| 3 | 泵车 | 1 台 |',
    ].join('\n');
    expect(buildReferenceQualityProfile(text).tableCount).toBe(1);
  });

  it('表格标题行与紧随的管道表块不重复计数', () => {
    const text = [
      '## 主要施工机械设备配置表',
      '| 序号 | 设备名称 | 数量 |',
      '|---|---|---|',
      '| 1 | 塔吊 | 2 台 |',
      '',
      '## 劳动力计划表',
      '| 工种 | 人数 | 进场时间 |',
      '|---|---|---|',
      '| 木工 | 20 | 第 10 天 |',
    ].join('\n');
    expect(buildReferenceQualityProfile(text).tableCount).toBe(2);
  });

  it('被正文分隔的多个管道表块分别计数', () => {
    const text = [
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '表格后的正文说明段落。',
      '',
      '| C | D |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n');
    expect(buildReferenceQualityProfile(text).tableCount).toBe(2);
  });
});
