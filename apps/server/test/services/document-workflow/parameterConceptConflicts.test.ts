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
    // 真冲突形态：不同句子各报口径（无总量词/无相加关系），分解句豁免不适用
    embedMock.mockResolvedValue([[1, 0], [1, 0], [0, 1]]);
    const markdown = '其中景观工程部位安装228m。环境整治工程部位安装105m。栏杆高度1.1m。';
    const issues = await parameterConceptConflictIssues(markdown);
    expect(issues.some(issue => issue.message.includes('景观工程部位安装'))).toBe(true);
  });
});
