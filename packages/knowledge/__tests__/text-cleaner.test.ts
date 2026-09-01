import { describe, expect, it } from 'vitest';
import { cleanExtractedText } from '../src/cleaning/text-cleaner.js';

function pageRepeat(line: string, count: number): string {
  return Array.from({ length: count }, () => line).join('\n');
}

describe('cleanExtractedText 通用噪声清洗', () => {
  it('删除全文高重复行（页眉/页脚）', () => {
    const body = '第一章 编制依据\n本施工组织设计依据招标文件、施工图纸及国家现行规范编制。\n';
    const text = body + pageRepeat('某某项目施工总承包招标文件', 5);
    const result = cleanExtractedText({ text });
    expect(result.text).not.toContain('某某项目施工总承包招标文件');
    expect(result.text).toContain('第一章 编制依据');
    expect(result.stats.headerFooterLines).toBe(5);
  });

  it('高重复但含表格管道符的行不误删', () => {
    const row = '| 1 | 平整场地 | m2 | 1200 |';
    const text = pageRepeat(row, 6);
    const result = cleanExtractedText({ text });
    expect(result.text).toBe(text);
    expect(result.removedLines).toBe(0);
  });

  it('高重复的列表项不误删', () => {
    const line = '- 安全第一，预防为主';
    const text = pageRepeat(line, 4);
    const result = cleanExtractedText({ text });
    expect(result.text).toBe(text);
  });

  it('删除纯页码行（大文件），小文件保护不删', () => {
    const body = Array.from({ length: 30 }, (_, index) => `正文段落 ${index + 1}：本段为模拟正文内容，用于撑起文档行数。`).join('\n');
    const text = `${body}\n3\n第 4 页\n12 / 45\n`;
    const result = cleanExtractedText({ text });
    expect(result.text).not.toContain('第 4 页');
    expect(result.text).not.toContain('12 / 45');
    expect(result.stats.pageNumberLines).toBeGreaterThanOrEqual(2);
    // 小文件（<20 行）纯数字行保留
    const small = '数据文件\n3\n5\n8\n';
    const smallResult = cleanExtractedText({ text: small });
    expect(smallResult.text).toContain('3');
  });

  it('删除目录区段（目录标题 + 点线行占比 ≥50%），正文不受影响', () => {
    const text = [
      '目录',
      '第一章 编制依据...............1',
      '第一节 编制说明..............1',
      '第二章 工程概况...............5',
      '',
      '第一章 编制依据',
      '本施工组织设计依据招标文件、施工图纸及国家现行规范编制。',
    ].join('\n');
    const result = cleanExtractedText({ text });
    expect(result.text).not.toContain('...............1');
    expect(result.text).not.toContain('...............5');
    expect(result.text).toContain('第一章 编制依据');
    expect(result.text).toContain('本施工组织设计依据招标文件');
    expect(result.stats.tocRegionLines).toBeGreaterThanOrEqual(4);
  });

  it('目录点线占比不足的区段不删', () => {
    const text = [
      '目录',
      '这是正文第一段，内容较长，不应被当作目录点线行删除，因为它没有点线页码模式。',
      '这是正文第二段，同样没有点线模式，目录区段判定应失败并保留全部内容。',
      '这是正文第三段，占比不足条件不成立。',
    ].join('\n');
    const result = cleanExtractedText({ text });
    expect(result.text).toBe(text);
  });

  it('连续空行压缩为两个', () => {
    const text = '段落一\n\n\n\n\n段落二';
    const result = cleanExtractedText({ text });
    const blankCount = result.text.split('\n').filter(line => !line.trim()).length;
    expect(blankCount).toBe(2);
    expect(result.stats.blankLines).toBe(2);
  });
});

describe('cleanExtractedText 招标文件噪声清洗', () => {
  it('删除投标函格式模板段（标题 + 盖章标记），正文保留', () => {
    const text = [
      '第一章 招标公告',
      '本招标项目已批准建设，招标人为某某单位。',
      '',
      '投标函格式',
      '致：某某招标代理有限公司',
      '1. 我方投标报价为人民币________元。',
      '投标人：________（盖单位章）',
      '',
      '第三章 技术标准和要求',
      '本项目结构形式为框架剪力墙结构。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目招标文件.pdf' });
    expect(result.text).not.toContain('投标函格式');
    expect(result.text).not.toContain('（盖单位章）');
    expect(result.text).toContain('框架剪力墙结构');
    expect(result.stats.tenderFormatLines).toBeGreaterThan(0);
  });

  it('无盖章标记的格式标题不删', () => {
    const text = '投标函格式\n致：某某单位\n1. 我方投标报价见报价单。';
    const result = cleanExtractedText({ text, fileName: '招标文件.pdf' });
    expect(result.text).toContain('投标函格式');
  });

  it('删除泛化引用行，含实质信息的行保留', () => {
    const text = [
      '详见投标人须知前附表',
      '以招标文件为准',
      '计划工期为 365 日历天，详见投标人须知前附表。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '招标文件.pdf' });
    expect(result.text).not.toContain('详见投标人须知前附表\n');
    expect(result.text).toContain('计划工期为 365 日历天');
    expect(result.stats.tenderGenericLines).toBe(2);
  });
});

describe('cleanExtractedText 补疑文件噪声清洗', () => {
  it('删除零信息回复行，实质回复保留', () => {
    const text = [
      '1. 问：投标保证金金额是否有调整？',
      '答：按招标文件执行',
      '2. 问：计划开工日期是否变更？',
      '答：计划开工日期调整为 2025 年 3 月 1 日。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目补疑文件.pdf' });
    expect(result.text).not.toContain('按招标文件执行');
    expect(result.text).toContain('计划开工日期调整为 2025 年 3 月 1 日');
    expect(result.stats.clarificationLines).toBe(1);
  });

  it('非补疑文件的相同行不删（类型分流）', () => {
    const text = '按招标文件执行\n这是普通文档内容。';
    const result = cleanExtractedText({ text, fileName: '施工方案.docx' });
    expect(result.text).toContain('按招标文件执行');
  });
});

describe('cleanExtractedText 图纸噪声清洗', () => {
  it('删除无汉字纯坐标数字行，含汉字的坐标描述保留', () => {
    const text = [
      '基础平面布置图',
      '12345.678, 23456.789, 34567.890, 45678.901',
      '基础底标高为 -2.500m，坐标见总平面图（X=12345.678）。',
    ].join('\n');
    const result = cleanExtractedText({ text, category: 'cad' });
    expect(result.text).not.toContain('23456.789, 34567.890');
    expect(result.text).toContain('基础底标高');
    expect(result.stats.cadNoiseLines).toBe(1);
  });

  it('非图纸类文件的坐标行不删（类型分流）', () => {
    const text = '测量成果\n12345.678, 23456.789, 34567.890';
    const result = cleanExtractedText({ text, category: 'document' });
    expect(result.text).toContain('12345.678');
  });
});

describe('cleanExtractedText 内容无关数据清洗（K2 章节/段落级）', () => {
  it('删除合同通用条款整章（规模证据），专用条款与协议书保留', () => {
    const general = Array.from({ length: 60 }, (_, i) => `第${i + 1}条 通用条款内容：发包人与承包人按照本合同的约定履行各自义务，未尽事宜按国家法律法规执行。`);
    const special = Array.from({ length: 15 }, (_, i) => `专用条款第 ${i + 1} 条：本项目工期目标为 365 日历天，质量目标为合格，安全目标为零事故。`);
    const text = [
      '第一部分 合同协议书',
      '发包人与承包人签订本协议书，合同价 1.2 亿元。',
      '第二部分 通用合同条款',
      ...general,
      '第三部分 专用合同条款',
      ...special,
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目施工合同.pdf' });
    expect(result.text).not.toContain('通用条款内容');
    expect(result.text).toContain('专用合同条款');
    expect(result.text).toContain('专用条款第 1 条');
    expect(result.stats.contractGeneralClauseLines).toBeGreaterThanOrEqual(60);
  });

  it('合同通用条款章节规模不足不删', () => {
    const text = [
      '通用合同条款',
      '第1条 定义',
      '第2条 发包人义务',
      '第3条 承包人义务',
      '这是正文内容。',
    ].join('\n');
    const result = cleanExtractedText({ text });
    expect(result.text).toContain('通用合同条款');
  });

  it('删除招标公告程序段（获取/递交/开标），招标条件与项目概况保留', () => {
    const text = [
      '第一章 招标公告',
      '一、招标条件',
      '本招标项目已由某某市发改委批准建设，招标人为某某单位。',
      '',
      '四、招标文件的获取',
      '4.1 获取时间：2025年1月10日至2025年1月16日，每天上午9:00至12:00。',
      '4.2 获取地点：某某市公共资源交易中心。',
      '',
      '二、项目概况与招标范围',
      '本工程总建筑面积 50000 平方米，其中地下 12000 平方米。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目招标文件.pdf' });
    expect(result.text).not.toContain('获取时间');
    expect(result.text).not.toContain('获取地点');
    expect(result.text).toContain('本招标项目已由');
    expect(result.text).toContain('总建筑面积 50000 平方米');
    expect(result.stats.announcementProcedureLines).toBe(4);
  });

  it('公告程序段无时间地点证据不删', () => {
    const text = '四、招标文件的获取\n投标人可自行下载招标文件电子版。';
    const result = cleanExtractedText({ text, fileName: '招标文件.pdf' });
    expect(result.text).toContain('招标文件的获取');
  });

  it('删除商务评审细则段，技术评审段保留', () => {
    const text = [
      '评标办法',
      '（一）商务评审',
      '商务得分按投标报价偏差率计算，报价满分 30 分。',
      '',
      '（二）技术评审',
      '施工组织设计评审要点：工期安排合理、质量保证措施完善、安全文明施工达标。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目招标文件.pdf' });
    expect(result.text).not.toContain('商务得分按投标报价偏差率');
    expect(result.text).toContain('施工组织设计评审要点');
    expect(result.stats.businessReviewLines).toBe(3);
  });

  it('商务与技术评审混合段不删（宁多勿丢）', () => {
    const text = '商务评审\n商务得分 40 分，技术得分按施工组织设计评审 60 分。';
    const result = cleanExtractedText({ text, fileName: '招标文件.pdf' });
    expect(result.text).toContain('商务评审');
  });

  it('非招标文件不执行公告程序段与商务评审清洗（类型分流）', () => {
    const text = '四、招标文件的获取\n获取时间：2025年1月10日。';
    const result = cleanExtractedText({ text, fileName: '施工方案.docx' });
    expect(result.text).toContain('招标文件的获取');
  });
});

describe('cleanExtractedText 图纸/清单专门噪声清洗（K3）', () => {
  it('删除图纸图框标题栏信息行，设计说明等实质内容保留', () => {
    const text = [
      '基础平面布置图',
      '图号 J-01',
      '比例 1:100',
      '设计 王某某',
      '审核 李某某',
      '基础底标高为 -2.500m，混凝土强度等级 C30。',
      '设计说明',
      '本工程基础采用独立基础，垫层厚度 100mm。',
    ].join('\n');
    const result = cleanExtractedText({ text, category: 'cad' });
    expect(result.text).not.toContain('图号 J-01');
    expect(result.text).not.toContain('比例 1:100');
    expect(result.text).not.toContain('设计 王某某');
    expect(result.text).not.toContain('审核 李某某');
    expect(result.text).toContain('设计说明');
    expect(result.text).toContain('混凝土强度等级 C30');
    expect(result.stats.cadTitleBlockLines).toBe(4);
  });

  it('删除 CAD 属性行（图层/颜色/线型），线型说明与图例保留', () => {
    const text = [
      '图层: 0',
      '颜色: 7',
      '线型: Continuous',
      '线型说明：粗实线表示墙体轮廓。',
      '图例',
      '粗实线——墙体',
    ].join('\n');
    const result = cleanExtractedText({ text, category: 'cad' });
    expect(result.text).not.toContain('图层');
    expect(result.text).not.toContain('颜色: 7');
    expect(result.text).not.toContain('Continuous');
    expect(result.text).toContain('粗实线表示墙体轮廓');
    expect(result.text).toContain('粗实线——墙体');
    expect(result.stats.cadAttributeLines).toBe(3);
  });

  it('删除 CAD 图元属性枚举行（管道符表格形态实体罗列），标注文本锚定行保留', () => {
    const text = [
      'CAD 语义标注文本:',
      '图纸节点: 平面图.dwg',
      'B70',
      '| 图层: DIM_IDEN',
      '| 块: *Active',
      '| 实体类型:',
      '| 坐标: (22189.60, -34661.84)',
      '└── 标注文本: 993.76',
      '| 关联对象: 邻近标注',
      '| 状态: 普通标注',
      '结构设计说明：混凝土强度等级 C35。',
    ].join('\n');
    const result = cleanExtractedText({ text, category: 'cad' });
    expect(result.text).not.toContain('| 图层: DIM_IDEN');
    expect(result.text).not.toContain('| 实体类型:');
    expect(result.text).not.toContain('坐标: (22189.60');
    expect(result.text).not.toContain('└── 标注文本:');
    expect(result.text).not.toContain('| 状态: 普通标注');
    // 图纸节点锚定行（文件溯源）与标注文本值、实质说明保留
    expect(result.text).toContain('图纸节点: 平面图.dwg');
    expect(result.text).toContain('B70');
    expect(result.text).toContain('混凝土强度等级 C35');
    expect(result.stats.cadEntityPropertyLines).toBe(7);
  });

  it('非图纸文件的图框信息行不删（类型分流）', () => {
    const text = '图号 J-01\n比例 1:100';
    const result = cleanExtractedText({ text, category: 'document' });
    expect(result.text).toContain('图号 J-01');
  });

  it('删除清单纯报价表格段（费汇总/暂估单价），分部分项清单保留', () => {
    const text = [
      '分部分项工程量清单',
      '| 编码 | 名称 | 特征 | 单位 | 工程量 |',
      '| 010101001001 | 平整场地 | 三类土 | m2 | 1200 |',
      '',
      '单位工程费汇总表',
      '| 序号 | 费用名称 | 金额（元） |',
      '| 1 | 分部分项工程费 | 1234567.89 元 |',
      '| 2 | 措施项目费 | 234567.89 元 |',
      '| 3 | 规费 | 34567.89 元 |',
      '',
      '材料暂估单价一览表',
      '| 材料名称 | 暂估单价（元） |',
      '| 钢材 | 4500 元 |',
      '| 商品混凝土 | 520 元 |',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目工程量清单.xlsx' });
    expect(result.text).not.toContain('单位工程费汇总表');
    expect(result.text).not.toContain('分部分项工程费');
    expect(result.text).not.toContain('材料暂估单价一览表');
    expect(result.text).toContain('平整场地');
    expect(result.text).toContain('010101001001');
    expect(result.stats.billPricingLines).toBeGreaterThanOrEqual(6);
  });

  it('删除清单扉页签章段，分部分项清单保留', () => {
    const text = [
      '工程量清单',
      '招标人：某某单位',
      '编制单位：某某造价咨询有限公司',
      '造价工程师：张某某（执业印章）',
      '',
      '分部分项工程量清单',
      '| 010101001001 | 平整场地 | m2 | 1200 |',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '工程量清单.pdf' });
    expect(result.text).not.toContain('编制单位');
    expect(result.text).not.toContain('执业印章');
    expect(result.text).toContain('平整场地');
    expect(result.stats.billTitlePageLines).toBeGreaterThanOrEqual(3);
  });

  it('报价表标题段无金额行证据不删', () => {
    const text = '单位工程费汇总表\n本表按相关规定编制。';
    const result = cleanExtractedText({ text, fileName: '工程量清单.xlsx' });
    expect(result.text).toContain('单位工程费汇总表');
  });

  it('非清单文件不执行清单清洗（类型分流）', () => {
    const text = '单位工程费汇总表\n| 1 | 分部分项工程费 | 1234567.89 元 |\n| 2 | 措施项目费 | 234567.89 元 |';
    const result = cleanExtractedText({ text, fileName: '施工方案.docx' });
    expect(result.text).toContain('单位工程费汇总表');
  });
});

describe('cleanExtractedText 保护机制与开关', () => {
  it('清洗掉超过 70% 时整体回退原文（宁多勿丢）', () => {
    const body = '这是唯一一段正文。';
    // 构造噪声占比远超 70% 的文本
    const text = Array.from({ length: 400 }, () => 'XX项目招标文件').join('\n') + `\n${body}`;
    const result = cleanExtractedText({ text });
    expect(result.text).toBe(text);
    expect(result.removedLines).toBe(0);
  });

  it('KB_TEXT_CLEANING=0 关闭清洗', () => {
    process.env.KB_TEXT_CLEANING = '0';
    try {
      const text = '正文\n' + pageRepeat('某某项目招标文件', 5);
      const result = cleanExtractedText({ text });
      expect(result.text).toBe(text);
      expect(result.removedLines).toBe(0);
    } finally {
      delete process.env.KB_TEXT_CLEANING;
    }
  });

  it('显式 enabled:false 关闭清洗', () => {
    const text = '正文\n' + pageRepeat('某某项目招标文件', 5);
    const result = cleanExtractedText({ text, enabled: false });
    expect(result.text).toBe(text);
  });
});

describe('CAD 文本格式控制码还原与电子投标程序句清洗', () => {
  it('CAD 控制码还原：%%U 格式开关删除、%%% 转义为百分号，正文保留', () => {
    const text = [
      '本工程叠合板均按%%U %%U设计，板端%%U %%U长度详见节点大样图。',
      '素水泥浆一道（掺801胶5%%%）修补。',
      '等电位接地 %%UI-I部面 暗接线盒。',
    ].join('\n');
    const result = cleanExtractedText({ text, category: 'cad' });
    expect(result.text).toContain('本工程叠合板均按 设计');
    expect(result.text).toContain('（掺801胶5%）');
    expect(result.text).toContain('I-I部面');
    expect(result.text).not.toContain('%%');
  });

  it('非 CAD 文件的 %% 串不处理（类型分流）', () => {
    const text = '打印格式说明：使用 %%U 表示下划线。';
    const result = cleanExtractedText({ text, category: 'document' });
    expect(result.text).toContain('%%U');
  });

  it('纯图纸行级清洗触发回退保护时，CAD 控制码还原仍然生效', () => {
    // 噪音行占比 >70% 触发整体回退，但控制码还原是确定性无损替换，必须始终生效
    const noise = Array.from({ length: 300 }, (_, i) => `第${i}号桩基坐标 坐标值 ${i}.500`).join('\n');
    const text = `${noise}\n本工程叠合板均按%%U %%U设计，板端%%U %%U长度详见大样图。`;
    const result = cleanExtractedText({ text, category: 'cad' });
    expect(result.removedChars).toBe(0);
    expect(result.text).not.toContain('%%U');
    expect(result.text).toContain('本工程叠合板均按 设计');
  });

  it('删除招标文件电子投标程序句（加密/解密/上传/撤回/提交/开标等），技术条款保留', () => {
    const text = [
      '投标人须知',
      '4.2.3 投标截止时间前通过电子交易系统完成上传。',
      '投标人对加密的投标文件进行撤回的，应通过电子交易系统在投标截止时间前进行撤回操作。',
      '第十四条投标截止时间以电子交易系统显示的时间为准，逾期系统将自动关闭。',
      '投标人应通过电子交易系统在线获取招标文件。',
      '澄清及修改等相关资料均通过电子交易系统发布。',
      '评标委员会通过电子交易系统将需要澄清的内容以询标函的形式发送。',
      '应在本招标项目澄清提出的截止时间前通过电子交易系统提交。',
      '招标人在投标人须知前附表规定的开标时间和地点通过电子交易系统开标。',
      '若电子交易系统识别出非加密投标文件和加密投标文件识别码不一致，电子交易系统将拒绝导入。',
      '投标文件由投标人使用电子交易系统提供的“投标文件制作工具”制作。',
      '电子交易系统无法正常运行的，招标人或招标代理机构可暂时中断开评标程序。',
      '投标人应安排专人登录电子交易系统并保持在线状态。',
      '则须在本条第4.1款规定的招标文件获取时间内通过电子交易系统【新版】（https: //jyxt.hfztb.cn/sso/）获取招标文件。',
      '',
      '1.3.2 计划工期 540 个日历天。',
      '本工程总建筑面积 50000 平方米。',
      '本项目开标时间：2026年8月20日9时00分。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目招标文件.pdf' });
    expect(result.text).not.toContain('电子交易系统');
    expect(result.text).not.toContain('自动关闭');
    expect(result.text).not.toContain('开标时间和地点');
    expect(result.text).toContain('计划工期 540');
    expect(result.text).toContain('总建筑面积 50000');
    expect(result.text).toContain('本项目开标时间：2026年8月20日9时00分');
    expect(result.stats.tenderEprocedureLines).toBe(13);
  });

  it('电子投标程序句无程序对象信号不删（防误删技术句）', () => {
    const text = '施工过程中如需加密资料，应报监理工程师审批。';
    const result = cleanExtractedText({ text, fileName: '某某项目招标文件.pdf' });
    expect(result.text).toContain('加密资料');
  });

  it('PDF 折行程序句跨行拼接删除（行间夹空行），具体时间行保留', () => {
    const text = [
      '### 投标文件递交的截止时间（投标截止时间，下同）为2026年9月4日9时30',
      '',
      '### 分，投标人应在投标截止时间前通过电子交易系统【新',
      '',
      '版】（https: //jyxt.hfztb.cn/sso/）递交电子投标文件。',
      '',
      '### 第十一条澄清、修改文件应由招标人或招标代理机构在电子交易系统和安徽',
      '',
      '徽合肥公共资源交易中心网站发布，投标人应及时查阅。',
      '',
      '### 第二十条招标人或招标代理机构应在电子交易系统和安徽合肥公共资源交易',
      '',
      '中心网站公示中标候选人及中标结果。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目招标文件.pdf' });
    expect(result.text).not.toContain('递交电子投标文件');
    expect(result.text).not.toContain('网站发布');
    expect(result.text).not.toContain('公示中标候选人');
    // 含具体截止时间的行保留
    expect(result.text).toContain('为2026年9月4日9时30');
    expect(result.stats.tenderEprocedureLines).toBe(6);
  });

  it('跨行拼接不吞实质信息：拼接后含具体时间/地点不删', () => {
    const text = [
      '投标人应通过电子交易系统',
      '',
      '开标地点：合肥市滨湖新区交易中心三楼。',
      '',
      '投标截止时间：2026年9月4日9时30分。',
    ].join('\n');
    const result = cleanExtractedText({ text, fileName: '某某项目招标文件.pdf' });
    expect(result.text).toContain('开标地点');
    expect(result.text).toContain('投标截止时间：2026年9月4日9时30分');
  });
});
