/**
 * 结构完整性统一规则单测（V2 方案 · 批1）：
 * - 扫描双域：cleanable（确定性清理：孤立编号/编号重排/孤立列表项/重复表头/重复数据行/重复行/相邻重复句）
 *   与 blocking（阻断重写：表名混入表头/空表/句尾截断/空小节/标点断裂）
 * - 丰乐镇实测形态回归：孤立编号跨节继承（2.10.1「6.」）、列表跳号（缺「4.」）、孤立单项列表、
 *   表头重复（5.2）、表内重复行（8.3）、表名混入表头（8.1.2）、句尾截断（3.1「…含基础9套按」悬挂虚词）、
 *   空小节（2.11.2）、相邻同句连发（2.10.4）、标点断裂（7.1.1「报验。、」）
 * - 误报控制：H3 容器 + H4 子节不判空、引导句（冒号结尾）后单项列表不判孤立、TOC 点导引不判截断
 * - 清理幂等：两轮收敛零残留；写时反馈仅 blocking 触发；终检包装默认含 cleanable（残留暴露不静默）
 */
import { describe, expect, it } from 'vitest';
import {
  cleanStructureDefects,
  scanStructureDefects,
  structureIntegrityFeedback,
  structureIntegrityIssues,
} from '@/services/document-workflow/structureIntegrityRules';

describe('scanStructureDefects 有序列表（编号跳号/孤立编号）', () => {
  it('块内编号缺号（1,2,3,5,6,7,8,9）→ list-numbering（cleanable）', () => {
    const markdown = [
      '施工工艺流程如下：',
      '1. 测量放线并确定开挖边线。',
      '2. 人工配合机械开挖管沟。',
      '3. 铺设中砂垫层并夯实。',
      '5. 安装HDPE双壁波纹管。',
      '6. 砌筑检查井并内外抹面。',
      '7. 闭水试验合格后回填。',
      '8. 分层回填并压实至设计标高。',
      '9. 恢复路面至原状。',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking).toEqual([]);
    const defects = result.cleanable.filter(defect => defect.kind === 'list-numbering');
    expect(defects).toHaveLength(1);
    expect(defects[0]?.line).toBe(2);
  });

  it('孤立编号「6.」（无前序 1.~5.，跨节继承形态保留 2.10.1）→ orphan-list-number（cleanable）', () => {
    const markdown = [
      '### 2.10.1 村道硬化',
      '本工程对村内主干道进行硬化，路面宽度3.5米，厚度18厘米。',
      '6. 混凝土路面浇筑完成后覆盖养护不少于7天。',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking).toEqual([]);
    expect(result.cleanable.map(defect => defect.kind)).toEqual(['orphan-list-number']);
  });

  it('单条「1.」编号不误报（孤立编号仅当 >1）', () => {
    const markdown = '本工程开工前完成下列准备工作。\n1. 完成施工组织设计报审与交底。';
    const result = scanStructureDefects(markdown);
    expect(result.cleanable).toEqual([]);
  });

  it('编号 ≤300 上限：三位大数编号不误报', () => {
    const markdown = '301. 该行是页码或外文编号残留形态之一。';
    expect(scanStructureDefects(markdown).cleanable).toEqual([]);
  });
});

describe('scanStructureDefects 孤立列表项', () => {
  it('单项 bullet 块前后均为正文语境 → orphan-list-item（cleanable）', () => {
    const markdown = [
      '### 1.3.1 编制依据',
      '本施工组织设计依据招标文件、施工图纸及现行国家规范编制。',
      '- 国家现行施工质量验收规范及地方标准。',
      '我公司组织专业技术人员对现场进行了踏勘与调查。',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking).toEqual([]);
    expect(result.cleanable.map(defect => defect.kind)).toEqual(['orphan-list-item']);
  });

  it('引导句（冒号结尾）后的单项列表 → 不误报（引导句豁免）', () => {
    const markdown = [
      '本工程主要周转材料包括：',
      '- 钢管、扣件、模板等周转材料。',
      '以上材料进场后按批次进行验收。',
    ].join('\n');
    expect(scanStructureDefects(markdown).cleanable).toEqual([]);
  });

  it('多项列表块不受孤立判定影响', () => {
    const markdown = ['本工程主要材料包括：', '- 水泥、砂石等主要材料。', '- 钢筋、模板等结构材料。'].join('\n');
    expect(scanStructureDefects(markdown).cleanable.filter(defect => defect.kind === 'orphan-list-item')).toEqual([]);
  });
});

describe('scanStructureDefects 表格缺陷', () => {
  it('表名混入表头（8.1.2 形态）→ table-title-in-header（blocking）', () => {
    const markdown = [
      '| 材料进场与工期匹配计划表 | 计划进场时间 | 责任人 |',
      '| --- | --- | --- |',
      '| 道牙石 | 第45日 | 张工 |',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking.map(defect => defect.kind)).toEqual(['table-title-in-header']);
    expect(result.cleanable).toEqual([]);
  });

  it('短词「报表」类首格不误报表名混入（汉字数 <8）', () => {
    const markdown = ['| 日进度报表 | 完成量 | 备注 |', '| --- | --- | --- |', '| 第1日 | 120米 | 正常 |'].join('\n');
    expect(scanStructureDefects(markdown).blocking).toEqual([]);
  });

  it('空表（仅表头与分隔线）→ table-empty（blocking）', () => {
    const markdown = ['| 检查项目 | 检查频次 | 责任人 |', '| --- | --- | --- |'].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking.map(defect => defect.kind)).toEqual(['table-empty']);
  });

  it('重复表头行（5.2 形态）→ table-header-duplicate（cleanable，不双报 row-duplicate）', () => {
    const markdown = [
      '| 工种 | 人数 | 职责分工 |',
      '| --- | --- | --- |',
      '| 工种 | 人数 | 职责分工 |',
      '| 普工 | 45 | 场地清杂与材料转运 |',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking).toEqual([]);
    expect(result.cleanable.map(defect => defect.kind)).toEqual(['table-header-duplicate']);
  });

  it('表内数据行完全重复（8.3 形态）→ table-row-duplicate（cleanable）', () => {
    const markdown = [
      '| 工种 | 人数 | 职责分工 |',
      '| --- | --- | --- |',
      '| 普工 | 45 | 场地清杂与材料转运 |',
      '| 普工 | 45 | 场地清杂与材料转运 |',
      '| 混凝土工 | 88 | 结构浇筑与振捣 |',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking).toEqual([]);
    const defects = result.cleanable.filter(defect => defect.kind === 'table-row-duplicate');
    expect(defects).toHaveLength(1);
    expect(defects[0]?.line).toBe(4);
  });
});

describe('scanStructureDefects 截断/空节/断裂（blocking 域）', () => {
  it('句尾截断（后接标题边界，2.10.2「…短边搭」形态）→ truncated-line', () => {
    const markdown = [
      '### 2.10.2 路肩培土',
      '路肩培土采用人工配合小型机械进行，培土宽度与厚度按设计要求控制，边坡应顺直，边缘应整齐平顺，夯实时预留短路肩短边搭',
      '### 2.10.3 错车道设置',
      '每200米设置一处错车道，路面宽度加宽至6米。',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking.map(defect => defect.kind)).toEqual(['truncated-line']);
    expect(result.blocking[0]?.line).toBe(2);
  });

  it('悬挂虚词截断（无边界证据，3.1「…含基础9套按」形态）→ truncated-line', () => {
    const markdown = [
      '### 3.1 施工设备配置',
      '施工准备阶段按计划投入全部机械设备，其中基础浇筑设备含基础9套按',
      '本工程道路照明工程采用分区分段流水施工组织方式推进。',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking.map(defect => defect.kind)).toEqual(['truncated-line']);
  });

  it('以句末标点结尾的正常句不误报截断', () => {
    const markdown = [
      '### 3.2 灯杆安装',
      '灯杆安装前复核基础预埋螺栓位置与标高，偏差超标时进行校正处理。',
      '### 3.3 灯具安装',
      '灯具安装后逐灯通电试亮，确认眩光控制措施有效。',
    ].join('\n');
    expect(scanStructureDefects(markdown).blocking).toEqual([]);
  });

  it('表题（以表结尾）不误报截断', () => {
    const markdown = [
      '### 8.3 劳动力使用计划',
      '劳动力月度投入计划表',
      '| 月份 | 人数 | 备注 |',
      '| --- | --- | --- |',
      '| 3月 | 120 | 结构施工 |',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking.filter(defect => defect.kind === 'truncated-line')).toEqual([]);
  });

  it('r26 B2：题注行（表N-N 前缀）后接表格不误报截断', () => {
    const markdown = [
      '### 10.2 材料堆场与加工区落实',
      '施工总平面布置要素与控制标准如下表所示。',
      '表10-1 施工总平面布置要素与控制标准',
      '',
      '| 布置要素 | 设置位置 | 控制标准 | 责任岗位 | 检查频次 |',
      '| --- | --- | --- | --- | --- |',
      '| 级配碎石堆场 | 各村施工段端头 | 堆高≤1.5m | 材料员 | 每日1次 |',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking.filter(defect => defect.kind === 'truncated-line')).toEqual([]);
  });

  it('r28h 扩围：引导句与表题同行（「……核对。表3-4 题名」+下接表格）不误报截断', () => {
    // r28h2 实机 4 处误报均为该形态：行尾为表题名（题名内无句末标点）属「引导句+表题+表格」
    // 正常结构，原豁免只覆盖行首独立题注行、同行形态被判句尾截断直坠终门禁
    const markdown = [
      '### 4.4 物资进场检验与存放',
      '物资按批次逐班核对。表3-4 物资进场检验与存放管理台账',
      '',
      '| 物资名称 | 检验项目 | 频次 |',
      '| --- | --- | --- |',
      '| 碎石 | 级配 | 每批 |',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking.filter(defect => defect.kind === 'truncated-line')).toEqual([]);
  });

  it('空小节（2.11.2 后直落同级标题）→ empty-subsection', () => {
    const markdown = [
      '### 2.11.1 施工准备措施',
      '本工程开工前组织人员机具进场，完成临时设施搭建与水电接驳。',
      '### 2.11.2 质量保证措施',
      '### 2.11.3 安全文明措施',
      '现场设置安全警示标识，实行封闭管理与出入登记。',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking.map(defect => defect.kind)).toEqual(['empty-subsection']);
    expect(result.blocking[0]?.line).toBe(3);
  });

  it('H3 容器 + H4 子节（5.1 → 5.1.1）不误报空节', () => {
    const markdown = [
      '### 5.1 劳动力配置',
      '#### 5.1.1 工种构成',
      '本工程按普工、混凝土工、管道工、绿化工四类工种组织。',
    ].join('\n');
    expect(scanStructureDefects(markdown).blocking).toEqual([]);
  });

  it('标点断裂（7.1.1「报验。、」形态）→ sentence-fracture', () => {
    const markdown = [
      '### 7.1.1 验收程序',
      '分项工程完工后组织自检并填写检验批记录，报验。、公厕砌筑与装修工程单独组织验收。',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking.map(defect => defect.kind)).toEqual(['sentence-fracture']);
  });
});

describe('scanStructureDefects 重复行/重复句', () => {
  const longLine = '本工程严格执行材料进场验收制度，所有材料必须具备出厂合格证与检测报告，并经监理见证取样复试合格后方可使用。';

  it('完全重复行（≥40 字）→ duplicate-line（cleanable）', () => {
    const markdown = [longLine, '中间隔一行其他内容用于形态隔离。', longLine].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking).toEqual([]);
    expect(result.cleanable.map(defect => defect.kind)).toEqual(['duplicate-line']);
    expect(result.cleanable[0]?.line).toBe(3);
  });

  it('短重复行不误报（<40 字）', () => {
    const markdown = ['合格。', '中间隔一行用于形态隔离。', '合格。'].join('\n');
    expect(scanStructureDefects(markdown).cleanable).toEqual([]);
  });

  it('相邻同句连发（2.10.4 形态）→ duplicate-sentence-adjacent（cleanable）', () => {
    const sentence = '混凝土路面浇筑完成后应及时覆盖麻袋并洒水养护，养护期不少于7天。';
    const markdown = `### 2.10.4 养护与成品保护\n${sentence}${sentence}当日平均气温低于5℃时不得洒水养护。`;
    const result = scanStructureDefects(markdown);
    expect(result.blocking).toEqual([]);
    expect(result.cleanable.map(defect => defect.kind)).toEqual(['duplicate-sentence-adjacent']);
  });
});

describe('cleanStructureDefects 确定性清理（只清不写）', () => {
  it('孤立编号去号转正文', () => {
    const markdown = '### 2.10.1 村道硬化\n本工程对村内主干道进行硬化。\n6. 混凝土路面浇筑完成后覆盖养护不少于7天。';
    const result = cleanStructureDefects(markdown);
    expect(result.markdown).toContain('混凝土路面浇筑完成后覆盖养护不少于7天。');
    expect(result.markdown).not.toContain('6. ');
    expect(result.cleaned.some(item => item.includes('孤立编号去号'))).toBe(true);
  });

  it('编号重排为 1..n 连续', () => {
    const markdown = ['1. 甲项工序内容描述。', '2. 乙项工序内容描述。', '4. 丙项工序内容描述。'].join('\n');
    const result = cleanStructureDefects(markdown);
    expect(result.markdown).toBe(['1. 甲项工序内容描述。', '2. 乙项工序内容描述。', '3. 丙项工序内容描述。'].join('\n'));
  });

  it('r6 护栏：内联首项粘连残段跳过重排（防双 1. 编号错位）', () => {
    const markdown = ['施工按以下编号步骤组织：1. 房前屋后杂物清理；', '2. 测量放线；', '3. 铺装施工。'].join('\n');
    const result = cleanStructureDefects(markdown);
    expect(result.markdown).toBe(markdown);
  });

  it('r6 护栏：无粘连标记的真缺号块仍重排 1..n', () => {
    const markdown = ['施工按以下步骤组织：', '2. 测量放线；', '3. 铺装施工。'].join('\n');
    const result = cleanStructureDefects(markdown);
    expect(result.markdown).toBe(['施工按以下步骤组织：', '1. 测量放线；', '2. 铺装施工。'].join('\n'));
  });

  it('孤立列表项去号并入正文 + 重复表头行删除 + 表内重复行删除 + 相邻重复句去重', () => {
    const sentence = '混凝土路面浇筑完成后应及时覆盖麻袋并洒水养护，养护期不少于7天。';
    const markdown = [
      '本施工组织设计依据招标文件与现行规范编制。',
      '- 国家现行施工质量验收规范及地方标准。',
      '我公司组织专业技术人员对现场进行了踏勘与调查。',
      '',
      '| 工种 | 人数 | 职责分工 |',
      '| --- | --- | --- |',
      '| 工种 | 人数 | 职责分工 |',
      '| 普工 | 45 | 场地清杂与材料转运 |',
      '| 普工 | 45 | 场地清杂与材料转运 |',
      '',
      `${sentence}${sentence}当日平均气温低于5℃时不得洒水养护。`,
    ].join('\n');
    const result = cleanStructureDefects(markdown);
    expect(result.markdown).toContain('国家现行施工质量验收规范及地方标准。');
    expect(result.markdown).not.toContain('- 国家现行施工质量验收规范');
    expect(result.markdown.match(/\| 工种 \| 人数 \| 职责分工 \|/gu)).toHaveLength(1);
    expect(result.markdown.match(/\| 普工 \| 45 \| 场地清杂与材料转运 \|/gu)).toHaveLength(1);
    expect(result.markdown.match(/养护期不少于7天。/gu)).toHaveLength(1);
    const rescan = scanStructureDefects(result.markdown);
    expect(rescan.cleanable).toEqual([]);
  });

  it('幂等：清理后重跑零命中、零改动', () => {
    const dupLine = '本工程实行工序交接检查制度，上道工序未经验收合格不得进入下道工序施工，隐蔽工程必须留存影像资料。';
    const markdown = [
      '1. 甲项工序内容描述。',
      '2. 乙项工序内容描述。',
      '5. 丙项工序内容描述。',
      '- 孤立列表项内容并入正文。',
      dupLine,
      dupLine,
    ].join('\n');
    const first = cleanStructureDefects(markdown);
    const second = cleanStructureDefects(first.markdown);
    expect(second.cleaned).toEqual([]);
    expect(second.markdown).toBe(first.markdown);
  });

  it('blocking 类缺陷不被清理器误删（截断/空节原样保留）', () => {
    const markdown = [
      '### 2.11.1 施工准备措施',
      '本工程开工前组织人员机具进场，完成临时设施搭建与水电接驳。',
      '### 2.11.2 质量保证措施',
      '### 2.11.3 安全文明措施',
    ].join('\n');
    const result = cleanStructureDefects(markdown);
    expect(result.markdown).toBe(markdown);
    expect(result.cleaned).toEqual([]);
  });
});

describe('structureIntegrityFeedback / structureIntegrityIssues 接线口径', () => {
  it('feedback：存在 blocking → 返回反馈文本；仅 cleanable → undefined', () => {
    const blockingFixture = '### 2.11.2 质量保证措施\n### 2.11.3 安全文明措施\n本工程落实三级质量巡查制度。';
    const feedback = structureIntegrityFeedback(scanStructureDefects(blockingFixture), '2.11 质量保证措施');
    expect(feedback).toContain('结构完整性未通过');
    expect(feedback).toContain('2.11 质量保证措施');

    const cleanableFixture = '孤立编号场景：\n6. 该行存在跨节继承编号。';
    expect(structureIntegrityFeedback(scanStructureDefects(cleanableFixture))).toBeUndefined();
  });

  it('issues：默认含 cleanable；includeCleanable=false 时仅 blocking；字段口径统一', () => {
    const markdown = ['1. 甲项工序内容描述。', '3. 乙项工序内容描述。'].join('\n');
    const all = structureIntegrityIssues(markdown);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every(issue => issue.level === 'error' && issue.severity === 'blocker' && issue.category === 'structure')).toBe(true);
    expect(all[0]?.message).toContain('结构完整性缺陷');
    expect(structureIntegrityIssues(markdown, { includeCleanable: false })).toEqual([]);
  });

  it('合法文档 → 双域零检出', () => {
    const markdown = [
      '### 5.1 劳动力配置',
      '#### 5.1.1 工种构成',
      '本工程按普工、混凝土工、管道工、绿化工四类工种组织，高峰期投入168人。',
      '',
      '施工工艺流程如下：',
      '1. 测量放线并确定开挖边线。',
      '2. 人工配合机械开挖管沟。',
      '3. 铺设中砂垫层并夯实。',
    ].join('\n');
    const result = scanStructureDefects(markdown);
    expect(result.blocking).toEqual([]);
    expect(result.cleanable).toEqual([]);
  });
});
