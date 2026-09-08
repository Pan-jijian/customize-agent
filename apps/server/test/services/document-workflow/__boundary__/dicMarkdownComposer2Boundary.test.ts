/**
 * t3-mf M2 组：markdownComposer 纯函数族二轮深挖。
 * 覆盖：normalizeTenderSourcePageRefs 全替换谱系（13 规则逐条）/ cleanFormalSourcePhrases 形态族 /
 * sourcePhraseIssues / normalizeProductionText 全谱系 / hasInlineListCollision 单位白名单 /
 * normalizeInlineListBreaks 拆行形态。
 * 全部断言按源码实现逐条推导，真实行为锁定（不修改实现迎合用例）。
 */
import { describe, expect, it } from 'vitest';
import {
  cleanFormalSourcePhrases,
  hasInlineListCollision,
  normalizeInlineListBreaks,
  normalizeProductionText,
  normalizeTenderSourcePageRefs,
  sourcePhraseIssues,
} from '@/services/document-workflow/markdownComposer';

// ═══════ N1 招标页码引用归一全谱系 ═══════
describe('N1 normalizeTenderSourcePageRefs 全谱系', () => {
  it('PDF 第 N 页 → 相关资料（前缀保留）', () => {
    expect(normalizeTenderSourcePageRefs('详见 PDF 第 5 页。')).toBe('详见 相关资料。');
  });

  it('PDF 第 N-M 页 连字符范围 → 相关资料', () => {
    expect(normalizeTenderSourcePageRefs('详见 PDF 第 5-8 页。')).toBe('详见 相关资料。');
  });

  it('PDF 第 N~M 页 波浪线范围 → 相关资料', () => {
    expect(normalizeTenderSourcePageRefs('见 PDF 第 3~5 页')).toBe('见 相关资料');
  });

  it('PDF 第 N 至 M 页 文字范围 → 相关资料', () => {
    expect(normalizeTenderSourcePageRefs('见 PDF 第 3 至 5 页')).toBe('见 相关资料');
  });

  it('小写 pdf 第 N 页 → 相关资料（i 标志）', () => {
    expect(normalizeTenderSourcePageRefs('见 pdf 第 2 页')).toBe('见 相关资料');
  });

  it('PDF 第 残片（无数字）→ 残片删除前缀保留', () => {
    expect(normalizeTenderSourcePageRefs('日期：2026年8月19 日 PDF 第')).toBe('日期：2026年8月19 日 ');
  });

  it('PDF 第 残片后接中文 → 残片删除', () => {
    expect(normalizeTenderSourcePageRefs('依据 PDF 第页执行')).toBe('依据 页执行');
  });

  it('第 N 页/M 页（斜杠直连数字）→ 删除', () => {
    expect(normalizeTenderSourcePageRefs('第 5 页/10 页')).toBe('');
  });

  it('第 N 页 共 M 页（空格共）→ 删除', () => {
    expect(normalizeTenderSourcePageRefs('第 5 页 共 10 页')).toBe('');
  });

  it('第 N 页/共 M 页（共形态）→ 两侧分别归一', () => {
    expect(normalizeTenderSourcePageRefs('第 5 页/共 10 页')).toBe('相关资料/相关资料');
  });

  it('第 N 页 → 相关资料（前缀粘连）', () => {
    expect(normalizeTenderSourcePageRefs('见第 3 页')).toBe('见相关资料');
  });

  it('第 N-M 页 → 相关资料', () => {
    expect(normalizeTenderSourcePageRefs('见第 3-5 页')).toBe('见相关资料');
  });

  it('装饰工程施工图纸 12 页 → 装饰工程施工图纸', () => {
    expect(normalizeTenderSourcePageRefs('装饰工程施工图纸 12 页')).toBe('装饰工程施工图纸');
  });

  it('装饰工程 12 页（无图纸词）→ 装饰工程施工图纸', () => {
    expect(normalizeTenderSourcePageRefs('装饰工程 12 页')).toBe('装饰工程施工图纸');
  });

  it('给排水工程资料（3 页）→ 给排水工程施工图纸', () => {
    expect(normalizeTenderSourcePageRefs('给排水工程资料（3 页）')).toBe('给排水工程施工图纸');
  });

  it('12 页 装饰专业图纸 → 装饰专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('12 页 装饰专业图纸')).toBe('装饰专业图纸');
  });

  it('12 页 装饰图纸（无专业词）→ 装饰专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('12 页 装饰图纸')).toBe('装饰专业图纸');
  });

  it('装饰（5 页）→ 装饰专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('装饰（5 页）')).toBe('装饰专业图纸');
  });

  it('电气专业（8 页）→ 电气专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('电气专业（8 页）')).toBe('电气专业图纸');
  });

  it('给排水（5 页）→ 给排水专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('给排水（5 页）')).toBe('给排水专业图纸');
  });

  it('暖通（5 页）→ 暖通专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('暖通（5 页）')).toBe('暖通专业图纸');
  });

  it('招标文件共 12 页 → 招标文件相关专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('招标文件共 12 页')).toBe('招标文件相关专业图纸');
  });

  it('招标文件多达 8 页 → 招标文件相关专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('招标文件多达 8 页')).toBe('招标文件相关专业图纸');
  });

  it('装饰装修工程（共 5 页）→ 装饰装修工程施工图纸', () => {
    expect(normalizeTenderSourcePageRefs('装饰装修工程（共 5 页）')).toBe('装饰装修工程施工图纸');
  });

  it('土建工程资料（3 页）→ 土建工程施工图纸', () => {
    expect(normalizeTenderSourcePageRefs('土建工程资料（3 页）')).toBe('土建工程施工图纸');
  });

  it('依据图纸（3页）→ 依据施工图纸（工程名规则先行）', () => {
    expect(normalizeTenderSourcePageRefs('依据图纸（3页）执行')).toBe('依据施工图纸执行');
  });

  it('图纸（3页）（无前缀）→ 依据相关专业图纸', () => {
    expect(normalizeTenderSourcePageRefs('图纸（3页）')).toBe('依据相关专业图纸');
  });

  it('依据清单（3页）→ 依据工程量清单', () => {
    expect(normalizeTenderSourcePageRefs('依据清单（3页）填写')).toBe('依据工程量清单填写');
  });

  it('资料（5页）→ 项目资料', () => {
    expect(normalizeTenderSourcePageRefs('资料（5页）')).toBe('项目资料');
  });

  it('兜底：资料词先被 L95 项目资料规则吃掉', () => {
    // 真行为：L95「资料（N页）→项目资料」先于 L96 兜底执行，「设计」前缀游离
    expect(normalizeTenderSourcePageRefs('设计资料 8 页')).toBe('设计项目资料');
  });

  it('兜底：清单词先被 L94 依据工程量清单规则吃掉', () => {
    // 真行为：L94「清单 N页→依据工程量清单」先于 L96 兜底执行，「工程量」前缀游离
    expect(normalizeTenderSourcePageRefs('工程量清单 3 页')).toBe('工程量依据工程量清单');
  });

  it('兜底：图纸词空格形态前缀游离 → 相关资料', () => {
    // 真行为：L96 兜底正则从「12 页」起匹配（「图纸」前缀被空格隔断不入 match）
    expect(normalizeTenderSourcePageRefs('图纸 12 页')).toBe('图纸 相关资料');
  });

  it('兜底：图纸12页（无空格）→ L96 图纸分支真命中', () => {
    expect(normalizeTenderSourcePageRefs('图纸12页')).toBe('相关专业图纸');
  });

  it('重复相关资料归并', () => {
    expect(normalizeTenderSourcePageRefs('详见相关资料 相关资料')).toBe('相关资料');
  });

  it('无页码引用 → 原样', () => {
    expect(normalizeTenderSourcePageRefs('普通正文无页码')).toBe('普通正文无页码');
  });
});

// ═══════ N2 来源罗列清洗形态族 ═══════
describe('N2 cleanFormalSourcePhrases 形态族', () => {
  it('正文罗列 → 清洗后直接进入正文', () => {
    // 真行为：SOURCE_ENUMERATION_PHRASE_RE 无锚定+懒匹配 {0,30} 吞掉「任意前缀+根据」
    const cleaned = cleanFormalSourcePhrases('本方案根据招标文件、工程量清单、设计图纸，对主体结构施工作出安排。');
    expect(cleaned).not.toContain('招标文件、工程量清单');
    expect(cleaned).toBe('对主体结构施工作出安排。');
  });

  it('本项目前缀罗列 → 前缀一并删除', () => {
    expect(cleanFormalSourcePhrases('本项目根据招标文件、设计图纸，编制施工方案。')).toBe('编制施工方案。');
  });

  it('编制依据节 → 保留罗列', () => {
    const md = '### 编制依据\n1. 招标文件、补疑澄清文件\n2. 工程量清单';
    expect(cleanFormalSourcePhrases(md)).toContain('招标文件、补疑澄清文件');
  });

  it('编制说明节 → 保留罗列', () => {
    const md = '## 编制说明\n本方案根据招标文件、设计图纸编制。';
    expect(cleanFormalSourcePhrases(md)).toContain('招标文件');
  });

  it('规范标准节 → 保留罗列', () => {
    const md = '### 标准依据\n现行规范与招标文件、澄清文件';
    expect(cleanFormalSourcePhrases(md)).toContain('招标文件');
  });

  it('编制依据节后切换普通节 → 恢复清洗', () => {
    const md = '### 编制依据\n根据招标文件编制。\n### 施工部署\n根据招标文件编制。';
    const cleaned = cleanFormalSourcePhrases(md);
    expect(cleaned).toContain('### 编制依据');
    // 编制依据节内保留，普通节内删除
    expect((cleaned.match(/招标文件/gu) || [])).toHaveLength(1);
  });

  it('表格行 → 跳过清洗', () => {
    const md = '| 依据 | 招标文件、工程量清单 |';
    expect(cleanFormalSourcePhrases(md)).toBe(md);
  });

  it('单来源+编制结尾 → 整行删除', () => {
    expect(cleanFormalSourcePhrases('根据招标文件编制。')).toBe('');
  });

  it('单来源+要求结尾 → 依据短语删除（句尾残留）', () => {
    // 真行为：L247 删除「依据设计图纸要求。」后残留句尾「执行。」
    expect(cleanFormalSourcePhrases('依据设计图纸要求执行。')).toBe('执行。');
  });

  it('单来源非编制结尾（以…为依据）→ 保留', () => {
    // 真行为：L247 要求「编制/确定/要求/为编制基础」结尾词，「为依据」不命中；单来源不满足
    // SOURCE_ENUMERATION_PHRASE_RE 的 {1,} 双词组合 → 整行原样保留
    expect(cleanFormalSourcePhrases('以招标文件为依据')).toBe('以招标文件为依据');
  });

  it('「按照」前缀单来源 → 保留', () => {
    expect(cleanFormalSourcePhrases('按照设计图纸要求执行')).toBe('按照设计图纸要求执行');
  });

  it('本节残留形态 → 残留「本节」', () => {
    expect(cleanFormalSourcePhrases('本节根据招标文件及设计图纸编制。')).toBe('本节');
  });

  it('施工图设计说明组合 → 项目技术文件', () => {
    expect(cleanFormalSourcePhrases('施工图设计说明、工程量清单项目特征')).toBe('项目技术文件');
  });

  it('补充答疑修正口径组合 → 项目技术文件', () => {
    expect(cleanFormalSourcePhrases('补充答疑修正口径、答疑修正口径')).toBe('项目技术文件');
  });

  it('多空格归一', () => {
    expect(cleanFormalSourcePhrases('本方案  严格  执行')).toBe('本方案 严格 执行');
  });

  it('无来源词 → 原样', () => {
    expect(cleanFormalSourcePhrases('普通施工安排正文。')).toBe('普通施工安排正文。');
  });

  it('H3 标题行 → 保留', () => {
    expect(cleanFormalSourcePhrases('### 施工部署\n正文')).toBe('### 施工部署\n正文');
  });

  it('粗体表名行 → 保留（清洗不动粗体）', () => {
    expect(cleanFormalSourcePhrases('**关键节点控制表**')).toBe('**关键节点控制表**');
  });
});

// ═══════ N3 来源罗列检测 ═══════
describe('N3 sourcePhraseIssues', () => {
  it('来源罗列 → blocker（style）', () => {
    const issues = sourcePhraseIssues('本方案根据招标文件、工程量清单及设计图纸，作出施工安排。');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('blocker');
    expect(issues[0].category).toBe('style');
    expect(issues[0].message).toContain('第 1 行');
  });

  it('第 2 行罗列 → 行号准确', () => {
    const issues = sourcePhraseIssues('标题\n根据招标文件、设计图纸，安排');
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('第 2 行');
  });

  it('多处罗列 → 多条', () => {
    const md = '根据招标文件、设计图纸，安排。\n依据工程量清单、答疑文件，执行。';
    expect(sourcePhraseIssues(md)).toHaveLength(2);
  });

  it('句号结尾罗列（无逗号）→ 不报', () => {
    // 真行为：SOURCE_ENUMERATION_PHRASE_RE 尾部要求 [，,]，句号形态不命中
    expect(sourcePhraseIssues('本方案根据招标文件及设计图纸。')).toEqual([]);
  });

  it('答疑回复文件词 → 罗列 blocker', () => {
    const issues = sourcePhraseIssues('根据答疑回复文件、澄清文件，执行。');
    expect(issues).toHaveLength(1);
  });

  it('编制依据节 → 豁免', () => {
    expect(sourcePhraseIssues('### 编制依据\n1. 招标文件、补疑澄清文件')).toEqual([]);
  });

  it('表格行 → 跳过', () => {
    expect(sourcePhraseIssues('| 依据 | 招标文件、工程量清单 |')).toEqual([]);
  });

  it('粗体表名 → format blocker', () => {
    const issues = sourcePhraseIssues('**关键节点控制表**');
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('format');
    expect(issues[0].severity).toBe('blocker');
  });

  it('上限 20 条', () => {
    const md = Array.from({ length: 25 }, () => '本方案根据招标文件及设计图纸，作出安排。').join('\n');
    expect(sourcePhraseIssues(md)).toHaveLength(20);
  });

  it('无命中 → 空', () => {
    expect(sourcePhraseIssues('普通施工安排正文。')).toEqual([]);
  });

  it('编制依据节切换后恢复检测', () => {
    const md = '### 编制依据\n根据招标文件编制。\n### 施工部署\n根据招标文件、设计图纸，安排。';
    const issues = sourcePhraseIssues(md);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('第 4 行');
  });

  it('表格行内粗体表名 → 不报 format', () => {
    expect(sourcePhraseIssues('| 表名 | **节点表** |')).toEqual([]);
  });
});

// ═══════ N4 产出文本归一全谱系 ═══════
describe('N4 normalizeProductionText 全谱系', () => {
  it('大写 M2 → 平方米（i 标志）', () => {
    expect(normalizeProductionText('面积 20 M2')).toBe('面积 20 平方米');
  });

  it('单 ㎡（无 2 后缀）→ 原样', () => {
    expect(normalizeProductionText('面积 20㎡')).toBe('面积 20㎡');
  });

  it('空格+㎡2 → 原样（空格与 ㎡ 之间无词边界）', () => {
    // 真行为：\b 要求一侧 \w 一侧非 \w，「空格|㎡」两侧均非 \w 无边界；数字紧贴形态「20㎡2」才转换
    expect(normalizeProductionText('面积 20 ㎡2')).toBe('面积 20 ㎡2');
  });

  it('空格 m ² 上标形态 → 原样（² 后无词边界）', () => {
    expect(normalizeProductionText('面积 80 m²')).toBe('面积 80 m²');
  });

  it('空格 m ³ 上标形态 → 原样', () => {
    expect(normalizeProductionText('土方 100 m ³')).toBe('土方 100 m ³');
  });

  it('数字紧贴 m2/m3 → 原样（无词边界）', () => {
    expect(normalizeProductionText('面积 100m2、土方 50m3')).toBe('面积 100m2、土方 50m3');
  });

  it('词中 m2（dm2）→ 原样', () => {
    expect(normalizeProductionText('单位 dm2')).toBe('单位 dm2');
  });

  it('2.5平方 → 2.5平方米', () => {
    expect(normalizeProductionText('约2.5平方')).toBe('约2.5平方米');
  });

  it('120平方3 → 120平方米', () => {
    expect(normalizeProductionText('面积120平方3')).toBe('面积120平方米');
  });

  it('平方后接普通字 → 原样（lookahead 不命中）', () => {
    expect(normalizeProductionText('20平方偏差')).toBe('20平方偏差');
  });

  it('原则上剔除', () => {
    expect(normalizeProductionText('原则上按规范执行')).toBe('按规范执行');
  });

  it('多处原则上剔除', () => {
    expect(normalizeProductionText('原则上先测，原则上后量')).toBe('先测，后量');
  });

  it('×≤≥± 两侧空白归一', () => {
    expect(normalizeProductionText('a × b ≤ c ≥ d ± e')).toBe('a×b≤c≥d±e');
  });

  it('已合法平方米不重复替换', () => {
    expect(normalizeProductionText('面积120平方米')).toBe('面积120平方米');
  });

  it('多行组合转换', () => {
    expect(normalizeProductionText('面积 20 m2\n土方 30 m3')).toBe('面积 20 平方米\n土方 30 立方米');
  });

  it('无变化输入原样返回', () => {
    expect(normalizeProductionText('普通正文')).toBe('普通正文');
  });
});

// ═══════ N5 行内列表冲突判定 ═══════
describe('N5 hasInlineListCollision', () => {
  it('两处编号列表 → 冲突', () => {
    expect(hasInlineListCollision('首先完成检查。1. 开始铺设。2. 进行碾压')).toBe(true);
  });

  it('行首编号开头无前置句 → 不冲突', () => {
    // 真行为：第一个 MARKER 前需要 \S.+(?:\s|[。；;]) 前置，行首「1. 」无前置内容
    expect(hasInlineListCollision('1. 甲 2. 乙')).toBe(false);
  });

  it('编号前无标点/空格（步骤1.）→ 不冲突', () => {
    // 真行为：MARKER 前须紧邻空白或句末标点，「步骤1.」粘连形态不成立
    expect(hasInlineListCollision('步骤1. 甲。步骤2. 乙')).toBe(false);
  });

  it('编号前有空格（步骤 1.）→ 冲突', () => {
    expect(hasInlineListCollision('步骤 1. 甲。步骤 2. 乙')).toBe(true);
  });

  it('（1）（2）形态 → 冲突', () => {
    expect(hasInlineListCollision('完成检查。（1）开始铺设。（2）进行碾压')).toBe(true);
  });

  it('连字符列表 → 冲突', () => {
    expect(hasInlineListCollision('完成检查。- 开始铺设。- 进行碾压')).toBe(true);
  });

  it('粗体编号列表 → 冲突', () => {
    expect(hasInlineListCollision('完成检查。1. **开始铺设**。2. **进行碾压**')).toBe(true);
  });

  it('单处编号 → 不冲突', () => {
    expect(hasInlineListCollision('完成检查。1. 开始铺设')).toBe(false);
  });

  it('1.2mm 单位保护 → 不冲突', () => {
    expect(hasInlineListCollision('厚度 1.2mm 与 2.5MPa 控制')).toBe(false);
  });

  it('1.5cm 单位保护 → 不冲突', () => {
    expect(hasInlineListCollision('宽度 1.5cm 与 3.2m 控制')).toBe(false);
  });

  it('2.5MPa/kPa 保护 → 不冲突', () => {
    expect(hasInlineListCollision('压力 2.5MPa 与 3.6kPa')).toBe(false);
  });

  it('3.5t 保护 → 不冲突', () => {
    expect(hasInlineListCollision('重量 3.5t 与 1.2kg')).toBe(false);
  });

  it('220V/10kV/0.5A 保护 → 不冲突', () => {
    expect(hasInlineListCollision('电压 220V 与 10kV 电流 0.5A')).toBe(false);
  });

  it('表格行含编号 → 不冲突（竖线干扰 MARKER 前置对齐）', () => {
    // 真行为：竖线阻断 \S.+ 与 MARKER 前空白/标点的对齐，整行判定 false
    expect(hasInlineListCollision('| 1. 内容 | 2. 内容 |')).toBe(false);
  });

  it('行首编号多编号 → 不冲突（首 MARKER 无前置）', () => {
    expect(hasInlineListCollision('1. 甲。2. 乙。3. 丙')).toBe(false);
  });

  it('句号分隔双编号单字内容 → 不冲突（\S 吃单字后 .+ 无法对齐 MARKER）', () => {
    // 真行为：\S 吃掉单字「甲」后，.+ 从「。2. 乙」回溯，MARKER 前需要恰好一个
    // (?:\s|[。；;]) 字符对齐，「。2」之间无空白/标点 → 整体不命中
    expect(hasInlineListCollision('完成检查。1. 甲。2. 乙')).toBe(false);
  });

  it('句号分隔双编号多字内容 → 冲突', () => {
    expect(hasInlineListCollision('完成检查。1. 甲内容。2. 乙内容')).toBe(true);
  });
});

// ═══════ N6 行内列表拆行 ═══════
describe('N6 normalizeInlineListBreaks', () => {
  it('句末标点+编号 → 拆行', () => {
    expect(normalizeInlineListBreaks('完成检查；1. 开始铺设。')).toBe('完成检查；\n1. 开始铺设。');
  });

  it('句末标点+空格+编号 → 拆行（空格吃掉）', () => {
    expect(normalizeInlineListBreaks('完成检查。 1. 开始铺设。')).toBe('完成检查。\n1. 开始铺设。');
  });

  it('（1）形态拆行', () => {
    expect(normalizeInlineListBreaks('完成检查。（1）开始铺设。')).toBe('完成检查。\n（1）开始铺设。');
  });

  it('连字符列表拆行', () => {
    expect(normalizeInlineListBreaks('完成检查；- 开始铺设。')).toBe('完成检查；\n- 开始铺设。');
  });

  it('粗体编号拆行（标点前置）', () => {
    expect(normalizeInlineListBreaks('完成检查。1. **开始铺设**。')).toBe('完成检查。\n1. **开始铺设**。');
  });

  it('粗体编号拆行（空格前置无标点）', () => {
    expect(normalizeInlineListBreaks('内容 1. **开始铺设**。')).toBe('内容\n1. **开始铺设**。');
  });

  it('编号后无内容 → 不拆', () => {
    expect(normalizeInlineListBreaks('完成检查。1.')).toBe('完成检查。1.');
  });

  it('多处拆行', () => {
    expect(normalizeInlineListBreaks('甲。1. 乙。2. 丙')).toBe('甲。\n1. 乙。\n2. 丙');
  });

  it('多行逐行处理', () => {
    expect(normalizeInlineListBreaks('甲。1. 乙\n丙。2. 丁')).toBe('甲。\n1. 乙\n丙。\n2. 丁');
  });

  it('表格行不拆', () => {
    const md = '| 步骤 | 1. 内容 |';
    expect(normalizeInlineListBreaks(md)).toBe(md);
  });

  it('分隔线行不拆', () => {
    expect(normalizeInlineListBreaks('|---|---|')).toBe('|---|---|');
  });

  it('3 连空行归一为双换行', () => {
    expect(normalizeInlineListBreaks('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('CRLF 输入归一 LF', () => {
    expect(normalizeInlineListBreaks('甲。\r\n1. 乙')).toBe('甲。\n1. 乙');
  });
});
