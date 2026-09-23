/**
 * h13b parameterConceptConflictIssues 单测：纯通用量词过滤 + 极端差异（>4 倍）簇跳过。
 * 语义通道 mock：验证 L1 词面过滤在聚类前生效，bge 仅负责概念聚类。
 * P6 追加：概念黑名单（对象计数类）/ 单位一致性（跨单位不互比）/ 倍数门 4（4~20 倍收口）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parameterConceptConflictIssues } from '@/services/document-workflow/parameterConceptConflicts';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ getLocalSemanticProvider: vi.fn() }));

import { getLocalSemanticProvider } from '@/services/document-workflow/semanticSimilarity';

const providerMock = vi.mocked(getLocalSemanticProvider);
const embedMock = vi.fn<(texts: string[]) => Promise<number[][]>>();

beforeEach(() => {
  vi.clearAllMocks();
  embedMock.mockResolvedValue([]);
  providerMock.mockReturnValue({ embedDocuments: embedMock } as never);
});

describe('parameterConceptConflictIssues（h13b 过滤）', () => {
  it('纯通用量词概念（直径/厚度）全过滤 → 不报且不调用嵌入（不同对象同量词不误聚）', async () => {
    const markdown = '直径22mm的锚杆与直径48.3mm的钢管分别验收。厚度80mm的垫层一次浇筑。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('同簇含极端差异（>4 倍）→ 簇级跳过不报（跨对象 bge 误聚豁免）', async () => {
    embedMock.mockResolvedValue([[1, 0], [1, 0]]);
    const markdown = '围挡高度2.5m。围挡高度1.8m。地下1层。地下80层。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('同簇显著差异（>2% 且 ≤4 倍）→ 正常报冲突', async () => {
    embedMock.mockResolvedValue([[1, 0], [0, 0]]);
    const markdown = '围挡高度2.5m。围挡高度1.8m。喷锚厚度80mm。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => /围挡高度/u.test(issue.message))).toBe(true);
  });

  it('对象计数类概念黑名单（自然村/标段/点位等）→ 聚类前全过滤（run1 实测误报收口）', async () => {
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '本项目涉及13个自然村施工区域。招标范围为本项目分为1个标段。施工区域分布在13个自然村。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    // 全部被黑名单过滤 → 无概念可嵌入，聚类通道不被调用
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('同簇跨单位数值不互比（m/天/台）→ 不报（单位一致性防线，run1 实测误报收口）', async () => {
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '围挡高度不低于2.5m。复查频次每周不少于2天。水泵配置不少于3台。';
    const issues = await parameterConceptConflictIssues(markdown);
    // 簇级 3/2=1.5 倍 < 4 不跳；单位分组后 m{2.5}/天{2}/台{3} 均为单值 → 不报
    expect(issues).toEqual([]);
  });

  it('同簇 4~20 倍差异（跨对象误聚簇）→ 簇级倍数门4 跳过（run1 实测误报收口）', async () => {
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '电缆保护管敷设68993.93m。电力电缆敷设14249.23m。综合管线敷设总量58250m。';
    const issues = await parameterConceptConflictIssues(markdown);
    // 68993.93/14249.23≈4.84 倍：旧 >20 倍门不拦（run1 生产误报现场），倍数门4 整簇跳过
    expect(issues).toEqual([]);
  });

  it('嵌入数量不一致 → 显性 warning 降级跳过（不 throw，finalize 末期不硬停）', async () => {
    embedMock.mockResolvedValue([[1, 0]]);
    const markdown = '围挡高度2.5m。围挡高度1.8m。喷锚厚度80mm。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.severity).toBe('warning');
    expect(issues[0]!.message).toContain('已降级跳过');
    expect(issues[0]!.message).toContain('嵌入数量不一致');
  });

  it('r7 #6 同单位跨维度数值不互比（树穴直径 vs 深度）→ 不报（r6 实机误报收口）', async () => {
    // r6 实机阻断：树穴「直径…」与「深度…」被 bge 聚同簇，同单位数值差异互斥误报——
    // 全部 token 命中维度词且 ≥2 种维度时按维度隔离判定（各维度组单 token 自然跳过）
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '树穴直径0.8m。树穴深度0.6m。围挡高度2.5m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('r7 #6 反例：同维度多口径真冲突不受维度隔离影响（仍报）', async () => {
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '踢脚线高度15mm。踢脚线高度25mm。门洞宽度0.9m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('踢脚线高度'))).toBe(true);
  });

  it('r14 丰乐镇 E14「按每」频率基数豁免：不同任务各自频率（实况复刻）→ 不报', async () => {
    // 「质检员按每100m³」（混凝土试件留置频次）与「管道闭水试验按每200m一段」（闭水试验分段）
    // 是不同任务各自的频率基数，bge 因共同词「按每」误聚同簇；各 token「按每」前主体词面
    // 两两互不包含（含空主体）→ 不同任务频率参数，跳过
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '质检员按每100m³且每个浇筑部位不少于1组标准养护试件留置。管道闭水试验按每200m一段划分约82段。按每200m一段分段检验。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('r14 丰乐镇 E14 反例：「按每」主体互为包含（管道闭水试验 vs 闭水试验）仍判冲突', async () => {
    // 主体互为包含归同一任务的不同口径（非不同任务）——豁免不适用，多口径数值差异照报
    embedMock.mockResolvedValue([[1, 0], [1, 0]]);
    const markdown = '管道闭水试验按每200m一段分段检验。闭水试验按每300m一段分段检验。管道闭水试验按每400m一段分段检验。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('管道闭水试验'))).toBe(true);
  });

  it('r14 丰乐镇 B2 泛量词扩表（总长/全长）：逗号截断的光杆「总长」过滤后不误聚（实况复刻）', async () => {
    // r14 实机阻断：「排水管道采用塑料管材，总长8205.53m」的 concept=「总长」（逗号截断无对象前缀）
    // 与「砌筑渠道总长4800m」bge 误聚同簇（mock 同向量复刻）→ 旧行为报冲突；扩表过滤光杆量的后
    // tokens 不足阈值静默——不再调用嵌入（反向断言：未过滤时 mock 聚类必报）
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '排水管道采用塑料管材，总长8205.53m。砌筑渠道总长4800m。汛期巡查不少于28天。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('r14 丰乐镇 B2 反例：带对象前缀的「砌筑渠道总长」仍参与聚类（多口径真冲突照报）', async () => {
    // 扩表只过滤光杆量词（归一化后仅量词本身）：带对象的「砌筑渠道总长」照常进入聚类，
    // 同对象多口径（4800m vs 4200m）差异 >2% 仍判冲突（防扩表误伤）
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '砌筑渠道总长4800m。砌筑渠道总长4200m。汛期巡查不少于28天。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('砌筑渠道总长'))).toBe(true);
  });

  it('r15 丰乐镇 B1 引导语剥离：共享「主要作业对象为」的跨对象 token 剥离后再聚类（实况复刻）', async () => {
    // r15 实机阻断：剥离前 bge 对「主要作业对象为塑料管铺设」×「主要作业对象为菜园围栏」余弦 0.687
    //（mock 同向量复刻旧误聚）→ 8205.53 vs 2360 误报口径冲突；剥离后 concepts=「塑料管铺设/
    // 塑料管铺设总量/菜园围栏」——前两者同值 8205.53 聚簇无冲突、后者独立单 token
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '主要作业对象为塑料管铺设8205.53m。塑料管铺设总量8205.53m。主要作业对象为菜园围栏2360m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    expect(embedMock).toHaveBeenCalledWith(['塑料管铺设', '塑料管铺设总量', '菜园围栏']);
  });

  it('r15 B1 反例：剥离后同对象多口径仍判冲突（防剥离误放行）', async () => {
    // 引导语剥离不改同对象聚类：剥离后均为「塑料管铺设」的同对象多值（8205.53 vs 9500）仍报冲突
    embedMock.mockResolvedValue([[1, 0], [1, 0]]);
    const markdown = '主要作业对象为塑料管铺设8205.53m。塑料管铺设总量8205.53m。主要作业对象为塑料管铺设9500m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('塑料管铺设'))).toBe(true);
  });

  it('r16 丰乐镇 B2 任务时限框架剥离：「由责任X在内完成」跨主体时限不误聚（实况复刻）', async () => {
    // r16 实机阻断：「由责任班组在7日内完成修复」×「由责任岗位在2日内完成补录或纠正」共享
    // 「由责任X在内完成」框架致 bge 误聚同簇（实机余弦 0.755）→ 7 vs 2 假口径冲突；
    // 剥离框架后「修复」×「补录或纠正」不聚簇（实机余弦 0.583）——mock 非同向量复刻剥离后实况
    embedMock.mockResolvedValue([[1, 0], [0, 1], [0, 1]]);
    const markdown = '发现缺陷时，由责任班组在7日内完成修复。发现缺项时，由责任岗位在2日内完成补录或纠正。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    // 剥离生效断言：进入聚类的概念已是剥离框架后的任务词
    const concepts = embedMock.mock.calls[0]?.[0] as string[];
    expect(concepts).toContain('修复');
    expect(concepts).toContain('补录或纠正');
  });

  it('r16 B2 反例：同主体同任务时限多口径（修复7日 vs 修复2日）仍判冲突', async () => {
    // 剥离只去管理框架词：同主体同任务的多口径剥离后概念同形仍聚簇，数值差异照报（防误放行）
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '发现缺陷时，由责任班组在7日内完成修复。发现缺陷时，由责任班组在2日内完成修复。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('修复'))).toBe(true);
  });

  it('r16 丰乐镇 B2 实例序号差异豁免：「景墙一4m、景墙二12.2m」并列实例不误聚（实况复刻）', async () => {
    // r16 实机阻断：「景墙一4m」×「景墙二12.2m」bge 因主干词「景墙」误聚同簇（实机余弦 0.866）
    // → 4 vs 12.2 假口径冲突；同组全部 token 可拆「主干+尾序号」且主干全同、序号互异（并列实例）
    // 判豁免——mock 同向量复刻误聚，豁免路径生效则零输出
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '最后砌筑景墙，景墙一4m、景墙二12.2m，栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('r16 B2 反例：同实例多口径（景墙一4m vs 景墙一12.2m）仍判冲突', async () => {
    // 序号互异是豁免前提：同一实例（序号相同）的多口径不豁免，数值差异照报（防误放行）
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '最后砌筑景墙，景墙一4m、景墙一12.2m，栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('景墙一'))).toBe(true);
  });

  it('r18 丰乐镇 B2 责任框架剥离扩围：「责任X在内完成」无「由」前缀同样剥离（实况复刻）', async () => {
    // r18 根因链：窗口位移致链式聚类分裂后，「责任施工员在5日内完成修复」类无「由」句未剥离框架
    // 会与其他「责任X在内完成」句误聚；「由」改可选后剥离为任务词「修复」/「补录或纠正」（mock 非同向量）
    embedMock.mockResolvedValue([[1, 0], [0, 1], [0, 1]]);
    const markdown = '发现缺陷时，责任班组在7日内完成修复。发现缺项时，责任岗位在2日内完成补录或纠正。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    // 剥离生效断言：进入聚类的概念已是剥离框架后的任务词
    const concepts = embedMock.mock.calls[0]?.[0] as string[];
    expect(concepts).toContain('修复');
    expect(concepts).toContain('补录或纠正');
  });

  it('r18 丰乐镇 B2 前缀尾随数字并回：「、15cm厚C30」不再误生 5cm 假口径（实况复刻）', async () => {
    // r18 根因链：PARAM_TOKEN_RE 前缀字符类含数字且惰性，顿号/句首「15cm」的「1」被吞入前缀、
    // 值误取 5（15cm 误生 5cm）——修复后两处 15cm 同值不报（修复前 5≠15 假冲突必报）
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '混凝土面层做法：、15cm厚C30水泥混凝土面层一次浇筑成型。面层采用15cm厚C30水泥混凝土分层摊铺作业。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('r18 B2 反例：前缀并回后正确值参与口径比较（、20cm 场景值 20 成立即报冲突）', async () => {
    // 并回前「、20cm」值误取 0 被 token 过滤（值>0 前提）整条消失；并回后值 20 与另一口径 15
    // 差异 33% >2% 照报——锁定「值修复后参与聚类比较」而非仅消除假冲突（防过滤式假修复）
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '面层做法：、15cm厚C30水泥混凝土面层一次浇筑成型。面层做法：、20cm厚C30水泥混凝土面层一次浇筑成型。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('C30水泥混凝'))).toBe(true);
  });

  it('r18 丰乐镇 B2b 总量分解句豁免：总量与分项相加分解（333=228+105）不报（实况复刻）', async () => {
    // r18 实机：「仿木护栏总量333m，其中景观工程部位安装228m，环境整治工程部位安装105m」被 bge
    // 误聚同簇（228≠105 假口径）；同一句内存在数值≈组内各值之和（333=228+105）——相加分解豁免
    embedMock.mockResolvedValue([[0, 1], [1, 0], [1, 0]]);
    const markdown = '仿木护栏总量333m，其中景观工程部位安装228m，环境整治工程部位安装105m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('r18 B2b 反例：无总量分解关系的多口径照报（防豁免过宽）', async () => {
    // 真冲突形态：同对象不同句子各报口径（无总量词/无相加关系），分解句豁免不适用；
    // r23 调整：「景观/环境整治工程部位」属对象限定词不相容豁免（不同部位各自量值），
    // 改用同对象同概念数据锁定分解句豁免本身不过宽
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '仿木护栏安装228m。仿木护栏安装105m。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('仿木护栏安装'))).toBe(true);
  });

  it('r22 P3a 公差「±」虚词坍缩跳过：±20mm/±10mm 以内不误聚（实况复刻）', async () => {
    // r22 实测误报：PARAM_TOKEN_RE 前缀字符类不含「±」，数字前导经 trailingDigits 并回后前缀
    // 坍缩为空——「槽底标高偏差控制在±20mm以内」×「…±10mm以内」concept 同坍缩为「以内」必聚簇
    // 误报口径冲突；坍缩 token 在聚类前已被纯边界虚词表过滤（不同对象公差本可并存，不参与互斥）
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '沟槽开挖时槽底标高偏差控制在±20mm以内。垫层施工时管底垫层顶面标高偏差控制在±10mm以内。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    // 坍缩虚词 tokens 在聚类前全部过滤（仅剩「栏杆高度」单 token 不成簇）→ 嵌入通道不被调用
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('r22 P3a 枚举前窗对称化：「300断面3003m、500×600断面1797m」尾成员由前窗顿号补足（实况复刻）', async () => {
    // r22 实测误报：枚举判定原仅查后窗——链尾成员「600断面1797m」后窗无顿号致 enumerations=1
    // <2 未豁免，「300断面」vs「600断面」误报多口径（300×300/500×600 断面清单枚举）；
    // 前窗 12 字对称判定后尾成员由「、500×」补足 → 双 token 均属枚举 → 整簇豁免
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '然后砌筑渠道，300×300断面3003m、500×600断面1797m，最后回填良质素土并分层夯实。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('r22 P3a 反例：非枚举链的断面多口径仍判冲突（前窗豁免不过宽）', async () => {
    // 前窗/后窗均无「、数字」枚举标记 → 不属规格枚举声明，同概念多口径照报（防豁免过宽）；
    // r23 调整：原数据「渠道/支渠」两主体属对象限定词不相容豁免（不同对象各自量），改用同
    // 主体同概念数据锁定枚举豁免本身不过宽
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '渠道砌筑300断面3003m。渠道砌筑300断面5000m。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('断面'))).toBe(true);
  });

  it('r23 P3b 对象限定词不相容豁免：不同脚手架对象各自搭设面积不误聚（跨对象误聚实况复刻）', async () => {
    // 实测：「工具式脚手架搭设面积76.62m²」与「外脚手架搭设面积122.36m²」是不同脚手架对象各自
    // 参量，bge 因共享核心词「脚手架搭设面积」误聚同簇（mock 同向量复刻）——扣除公共子串后
    // 限定词「工具式」vs「外」均非空且互不包含 → 不同对象豁免；同概念多口径仍判冲突（见反例）
    embedMock.mockResolvedValue([[1, 0], [1, 0]]);
    const markdown = '公厕主体结构施工采用工具式脚手架与外脚手架配合组织，工具式脚手架搭设面积76.62m²，外脚手架搭设面积122.36m²，架体随砌筑与混凝土浇筑进度分层搭设。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('r23 P3b 反例：同对象多口径（残留全空）不受对象限定词豁免影响 → 照报', async () => {
    // 概念完全相同（扣除公共子串后残留全空）不属「不同对象」形态 → 对象豁免不适用，多口径照报
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '脚手架搭设面积76.62m²。脚手架搭设面积122.36m²。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('脚手架搭设面积'))).toBe(true);
  });

  it('r23 P3b 村组分组名（X组）形态 → 聚类前过滤（r22 实况复刻）', async () => {
    // r22 实测误报：「总工程量2360m，分布于9个自然村分组，其中马老郢组800m、夏岗组250m…」——
    // 各村组各自围栏长度被 bge 误聚同簇报多口径；「X组」结尾是对象分组名概念（村组/作业组/
    // 班组等），各分组量值天然异构，不参与参数口径互斥；过滤后仅剩「总工程量」单 token 不足
    // 阈值3 → 聚类通道不被调用
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '小菜园工程以菜园围栏为主，总工程量2360m，分布于9个自然村分组，其中马老郢组800m、夏岗组250m、侯岗组180m、方岗组150m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('r23 P3b 反例：「组」非尾字的概念（模板组合）不误伤 → 多口径照报', async () => {
    // 尾锚「组$」只命中分组名形态；「组合」尾字「合」不命中 → 正常参与聚类，真多口径照报
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '模板组合500套。模板组合600套。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('模板组合'))).toBe(true);
  });

  it('r28 同值对豁免：同值异述对不打断跨对象分辨（r27b 实况复刻，「其中」残留形态）', async () => {
    // r27b 实机误报：审计原文「“其中道路硬化面积约”出现多个口径：其中道路硬化面积约2783㎡、
    // 公厕及附属设施改造面积约1757㎡、道路硬化面积约2783㎡」——「其中道路硬化面积约2783㎡」与
    // 「道路硬化面积约2783㎡」共享核心 LCS「道路硬化面积约」，扣除后左侧残留「其中」、右侧残留空，
    // every 被同值对打断致跨对象豁免失效；同值对是同一数值的不同表述不构成口径冲突，取值相同的
    // 两 token 不参与跨对象分辨（冲突判定仍由全部异值对承载，见反例）
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '其中道路硬化面积约2783㎡，村内公厕及附属设施改造面积约1757㎡；道路硬化面积约2783㎡，按通行条件分段组织施工。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('r28 同值豁免不越界：同对象异值对（道路硬化面积 2783 vs 2500）不受影响 → 照报', async () => {
    // 同值豁免仅放行 left.value === right.value 的对；同对象真异值对仍走 LCS 残留判定
    //（「其中道路硬化面积约」vs「道路硬化面积约」残留「其中」vs 空 → 非不同对象）→ 照常报出多口径
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '其中道路硬化面积约2783㎡，村内公厕及附属设施改造面积约1757㎡，道路硬化面积约2500㎡。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('道路硬化面积'))).toBe(true);
  });

  it('r28f 丰乐镇 B2 后缀相邻枚举项截断：健身器材/石桌石凳不桥接聚类（实况复刻）', async () => {
    // r28e 实机阻断：「健身器材17个与石桌石凳8个基础采用…」首 token 后缀吞入「与石桌石凳8个基」
    // （concept=「健身器材与石桌石凳8个基」）→ bge 桥接聚类把健身器材(17)与石桌石凳(8)误聚同簇；
    // 后缀在「与+≤12字+数字」处截断后 concepts=「健身器材/石桌石凳」两个独立概念（非同向量）→ 零冲突
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '健身器材17个与石桌石凳8个基础采用C20混凝土浇筑。石桌石凳8个，健身器材17个，按设计点位安装到位。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    // 截断生效断言：进入聚类的概念是清洁对象词（相邻枚举项不再并入首概念）
    const concepts = embedMock.mock.calls[0]?.[0] as string[];
    expect(concepts).toEqual(['健身器材', '石桌石凳']);
  });

  it('r28f B2 反例：连接词后无数字的语境后缀不截断（对象语境完整保留）', async () => {
    // 截断仅针对「连接词+…+数字」的相邻枚举项形态：连接词后无数字的语境后缀照常保留，
    // 避免误削概念信息（concepts 含完整语境「消防泵与稳压装置安装」）
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '消防泵2台与稳压装置安装。消防泵2台与稳压装置调试。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    const concepts = embedMock.mock.calls[0]?.[0] as string[];
    expect(concepts).toContain('消防泵与稳压装置安装');
    expect(concepts).toContain('消防泵与稳压装置调试');
  });

  it('r28m M24a F1 单体属性黑名单：地上层数/建筑高度不同单体天然异构 → 过滤不报', async () => {
    // s28k/s28l 实机归因：「地上2层、地上1层」「门卫建筑高度3m」——不同单体（门卫/配套用房）的
    // 层数/高度天然不同，无清单条目可裁决，参与互斥必误报；黑名单过滤后无概念可聚类
    const markdown = '门卫地上2层。配套用房地上1层。管理用房建筑高度3.5m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('r28m M24a F2 变体限定词退聚：局部厚度8cm 的子集口径不与整体 10cm 互斥', async () => {
    // r28k/s28k 实机归因：「厚度10cm，局部厚度8cm」——带「局部/个别/少数/多数/大部分」限定词的
    // 数值是子集/局部口径，与整体口径不可互斥；退聚后不足阈值 3 → 聚类通道不被调用
    const markdown = '垫层厚度10cm。局部厚度8cm。喷锚厚度80mm。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('r28m M24a F2 反例：退聚只作用于限定词 token，同概念多口径照常聚簇照报', async () => {
    // 「局部厚度8cm」退聚后其余 3 个 token 照常聚类（concepts 去重后 2 个 → mock 2 向量）：
    // 垫层厚度 10 vs 12 差异 >2% 仍判冲突（防豁免过宽）
    embedMock.mockResolvedValue([[1, 0], [0, 1]]);
    const markdown = '垫层厚度10cm。垫层厚度12cm。局部厚度8cm。喷锚厚度80mm。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('垫层厚度'))).toBe(true);
  });
});

describe('C5 构件细分后缀豁免（r28l/s28l 实机误报：分构件保护层按构件区分取值）', () => {
  it('C5-1 正样本：构件细分概念后缀包含形态 → 各自取值不互斥（基础底板/柱梁/板保护层 40/25/15mm）', async () => {
    // r28l/s28l 实机误报：「基础底板钢筋保护层厚度40mm、柱梁钢筋保护层厚度25mm、板钢筋保护层
    // 厚度15mm」——LCS 吞并「板」字后短方「板钢筋保护层厚度」恰为长方后缀子串，原互不包含
    // 判定返 false 致误报；构件细分各自参量是按构件类别区分的规范正确取值（非同参数多口径）
    embedMock.mockResolvedValue([[1, 0], [1, 0], [1, 0]]);
    const markdown = '基础底板钢筋保护层厚度40mm，柱梁钢筋保护层厚度25mm，板钢筋保护层厚度15mm，均按规范要求控制。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
  });

  it('C5-2 反例：同对象蕴含形态不豁免（闭水试验短方首字非构件语素 → 照报）', async () => {
    // 「管道闭水试验」vs「闭水试验」同为后缀包含形态，但短方首字「闭」非构件语素——
    // 是同一对象的简称复述而非构件细分，值不同仍判冲突（防豁免过宽）
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '管道闭水试验200m。闭水试验100m。喷锚厚度80mm。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('闭水试验'))).toBe(true);
  });

  it('C5-3 反例：短方长度 <4 字不豁免（板厚度 3 字 → 照报）', async () => {
    // 后缀豁免要求短方为独立构件的完整概念（含参量词尾，≥4 字）；「板厚度」3 字过短，
    // 与「钢筋混凝土板厚度」的后缀包含可能是同对象简称复述 → 保持互斥判定照报
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '钢筋混凝土板厚度120mm。板厚度180mm。喷锚厚度80mm。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('板厚度'))).toBe(true);
  });
});

describe('C8 S4-①a 层数概念词面直比豁免（s28m\' 实机：「层数2层、层数1层」两单体误报阻断）', () => {
  it('正样本：裸量词「层数」经 normalizeConcept 剥「层」与量词表失配 → 原词面直比前置消解，两单体不互斥', async () => {
    // s28m' 实锤：normalizeConcept 单位剥离表含「层」——「层数」归一后被剥成「数」，与
    // GENERIC_MEASURE_WORDS 登记形态「层数」失配恒 false；原词面直比前置后跳过度量词聚类
    embedMock.mockResolvedValue([[1, 0], [1, 0]]);
    const markdown = '本工程各单体设计如下。层数2层、层数1层，均按图纸施工。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    // 直比豁免在聚类前生效：两 token 均被过滤，无概念可嵌入
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('反例：带对象前缀的层数概念仍走归一后比较（真多口径照报，防豁免过宽）', async () => {
    // 直比豁免只作用于裸量词概念「层数」本体：「主楼结构层数」归一后为「主楼结构数」，
    // 不在量词表 → 照常进入聚类，同对象多口径（2层 vs 3层）仍报；「栏杆高度」为凑
    // 第三 token（聚类阈值 3）的无关量，mock 同向量复刻误聚后单位分组隔离（m 组单值不报）
    embedMock.mockResolvedValue([[1, 0], [1, 0]]);
    const markdown = '主楼结构层数2层。主楼结构层数3层。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('主楼结构层数'))).toBe(true);
  });
});

describe('C8-7 日期时间锚豁免（r28m\' 组7：「开工日期为2026年9月24日」日值入池误报）', () => {
  it('正样本：月份日期日值退出参数池 → 与工期天数不聚簇（实机形态零冲突复刻）', async () => {
    // r28m' 实锤：「开工日期为2026年9月24日」被 token 化为 prefix「…2026年9月」+值 24+单位「日」，
    // 经 bge 桥接与「计划工期90日历天」聚簇误报多口径；月锚豁免后池内剩同值工期 token（<3 不聚类）
    const markdown = '计划工期90日历天，开工日期为2026年9月24日，本工程计划工期90日历天。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    // 日期 token 在池外：token 数不足聚类门槛，嵌入通道不被调用（强证明退出而非聚类巧合）
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('正样本：多个月份日期并存全退出（9月24日/12月8日不互比）→ 不报', async () => {
    // 豁免按「值前紧邻月字」逐 token 生效（两个日期各自退出）；嵌入若被调用（豁免失效场景）
    // 日组将出现 90/24/8 多值误报——本断言同时守护逐 token 退出完整性
    const markdown = '开工日期为2026年9月24日。竣工日期为2026年12月8日。计划工期90日历天。本工程计划工期90日历天。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues).toEqual([]);
    expect(embedMock).not.toHaveBeenCalled();
  });

  it('反例：真工期多口径（90 vs 60 日历天）照报——日期豁免不掩盖真冲突（零放松）', async () => {
    // 围挡 2.5m 与工期不同簇（[0,1] 向量）——同簇会触发簇级倍数门（90 > 2.5×4）整簇跳过，
    // 与本用例意图无关；工期两 token 同簇（1.5 倍 < 4 门）→ 同单位日组多值照报
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '计划工期90日历天，开工日期为2026年9月24日。本工程计划工期60日历天。围挡高度2.5m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => /工期/u.test(issue.message))).toBe(true);
  });
});

describe('4.55.32 异名成员枚举豁免（#4 概念边界：分对象列举不得判同一概念多口径）', () => {
  /** 真机 doc-1790132484476-29b74c88 原句抽出的概念 → 按簇给向量（复刻 bge 两簇误聚） */
  const TAI = new Set(['塔式起重机配混凝土输送泵作业', '塔式起重机（QTZ63）', '电焊机', '混凝土输送泵配置']);
  const DUN = new Set(['钢结构吊装按钢柱', '钢梁', '钢吊车梁分区分段组织']);
  const cluster = () => embedMock.mockImplementation(async (texts: string[]) => texts.map(text => (TAI.has(text) ? [1, 0] : DUN.has(text) ? [0, 1] : [0, 0, 1])));

  it('正样本：塔式起重机（QTZ63）2台、电焊机2台、混凝土输送泵3台配置 —— 各设备各自成量不判冲突', async () => {
    // 真机原句（bge 因共享「塔式起重机/混凝土输送泵」词面把三台设备的台数误聚同簇）：
    // 「…钢结构吊装以QTZ63塔式起重机配混凝土输送泵2台作业…主要施工机械按塔式起重机（QTZ63）2台、
    //   电焊机2台、混凝土输送泵3台配置」——顿号链上每个成员各自带台数，属分对象列举
    cluster();
    const markdown = '土方作业以挖掘机配自卸汽车开挖外运，钢结构吊装以QTZ63塔式起重机配混凝土输送泵2台作业，各工序经施工员自检、质检员复检并报监理验收后进入下道工序。主要施工机械按塔式起重机（QTZ63）2台、电焊机2台、混凝土输送泵3台配置。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.filter(issue => /塔式起重机|混凝土输送泵|电焊机/u.test(issue.message))).toEqual([]);
  });

  it('正样本：钢结构吊装按钢柱1228.24t、钢梁1591.306t、钢吊车梁623.564t —— 三构件分列成量不判冲突', async () => {
    // 真机原句：钢柱/钢梁/钢吊车梁是三个不同构件的工程量（清单各行独立），bge 因共享「钢」字误聚
    cluster();
    const markdown = '钢结构吊装按钢柱1228.24t、钢梁1591.306t、钢吊车梁623.564t分区分段组织。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.filter(issue => /钢柱|钢梁|钢吊车梁/u.test(issue.message))).toEqual([]);
  });

  it('反例：同对象两句各自成量（无并列链）必须照报', async () => {
    embedMock.mockImplementation(async (texts: string[]) => texts.map(text => (text === '钢结构吊装按钢柱组织' ? [1, 0] : [0, 0, 1])));
    const issues = await parameterConceptConflictIssues('钢结构吊装按钢柱1228.24t组织。钢结构吊装按钢柱1591.306t组织。高强螺栓40158套按节点配套供应。');
    expect(issues.some(issue => /钢柱/u.test(issue.message))).toBe(true);
  });

  it('反例：同一设备在同一并列链上两个矛盾台数（同名成员）必须照报', async () => {
    // 同名成员（成员名 = 本概念）不属异名列举：「混凝土输送泵2台、混凝土输送泵3台」是同一参数两个口径
    embedMock.mockImplementation(async (texts: string[]) => texts.map(text => (text === '混凝土输送泵' ? [1, 0] : [0, 0, 1])));
    const issues = await parameterConceptConflictIssues('混凝土输送泵2台、混凝土输送泵3台、电焊机2台。');
    expect(issues.some(issue => /混凝土输送泵/u.test(issue.message))).toBe(true);
  });
});
