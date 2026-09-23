/**
 * 4.55.36 批次 2 答疑技术性修正通道单测（正例 / 反例）
 *
 * 回归集 = 巢湖补疑文件（`…编制补疑2026.9.1.docx`，11,115 字 / 54 问答）实测形态：
 * 该文件已入库且被召回，但「雨水口连接管混凝土满包 / 304 不锈钢防滑条 30*1.5mm /
 * 以围墙为分界线（一期已完成）」三类技术性修正终稿零落位——本通道的存在理由。
 */
import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_AMENDMENT_DETECTOR_ID,
  amendmentFormStrength,
  assignClarificationAmendmentChapters,
  clarificationAmendmentIssues,
  clarificationEvidenceBoost,
  clarificationSourceTexts,
  extractClarificationAmendmentLedger,
  extractClarificationAmendments,
  renderClarificationAmendmentBlock,
  segmentClarificationPairs,
} from '@/services/document-workflow/clarificationAmendments';

const 补疑 = '巢湖项目/答疑文件/巢湖市光电新能源产业园项目一东区标准化厂房二标段施工招标工程量清单、最高投标限价编制补疑2026.9.1.docx';

/** 真实形态：答句自成一段 + 问句在上一段（docx 抽取按空行分段） */
const 补疑文本 = [
  '1、设计图纸雨、污水管及雨水口连接管道基础为120°素混凝土管基。具体详见<混凝土排水管道基础及接口04S516，未明确混凝土标号？',
  '',
  '答：改为180°中粗砂基础。并外设土工布。',
  '',
  '2、雨水口连接管是否全部采用混凝土满包处理？',
  '',
  '答：是的',
  '',
  '3、雨水/污水靠墙井与检查井连接管是否需混凝土满包处理？',
  '',
  '答：混凝土满包',
  '',
  '4、地上楼梯间踏步不锈钢防滑条规格？',
  '',
  '答：304不锈钢防滑条30*1.5mm。',
  '',
  '5、室外道排一期是否已建好，二期与一期分界点怎么划分？是否以围墙为分 界点？',
  '',
  '答：以围墙为分界线，一期已完成，二期与一期通过围墙完全分开',
  '',
  '6、ALC墙板钢骨架梁柱等配件要不要做环氧云铁中间漆一遍，刷防火涂料，防火涂料表面再喷涂氯化橡胶面漆两道？',
  '',
  '答：需要，氯化橡胶面漆两道不需要。',
  '',
  '7、机动车地面停车位为植草砖，而设计说明有标线？是否有误？',
  '',
  '答：机动车地面停车位皆为植草砖，取消此划线。',
  '',
  '8、门卫窗下节点缺少结构？',
  '',
  '答：按此做法。',
  '',
  '温馨提示',
  '',
  '1、本工程采用国家2000高程系统,建筑室内±0.000相当于绝对标高为8.00。',
].join('\n');

function 抽取(text = 补疑文本) {
  return extractClarificationAmendmentLedger({ texts: [{ text, source: 补疑 }] });
}

describe('extractClarificationAmendments（真实补疑形态）', () => {
  it('段落切分：答句自成一段、问句取上一段（不串答、不漏问）', () => {
    const pairs = segmentClarificationPairs(补疑文本);
    const 满包 = pairs.find(pair => pair.question.includes('雨水口连接管是否全部采用'));
    expect(满包?.answer).toBe('是的');
    const 基础 = pairs.find(pair => pair.answer.includes('180°中粗砂基础'));
    expect(基础?.question).toContain('120°素混凝土管基');
    // 修正后内容的续句（`并外设土工布`）属同一修正，不得丢
    expect(基础?.answer).toContain('外设土工布');
  });

  it('替换族：改为 → 修正后「180°中粗砂基础。并外设土工布」，修正前「120°素混凝土管基」判 strong', () => {
    const ledger = 抽取();
    const item = ledger.amendments.find(amendment => amendment.kind === 'replace' && amendment.after.includes('中粗砂'));
    expect(item).toBeTruthy();
    expect(item?.after).toContain('并外设土工布');
    expect(item?.object).toContain('管道基础');
    const before = item?.before.find(entry => entry.text.includes('120°素混凝土管基'));
    expect(before?.strength).toBe('strong');
  });

  it('是非问确认：雨水口连接管混凝土满包（用户实测漏项 1）', () => {
    const ledger = 抽取();
    const item = ledger.amendments.find(amendment => amendment.kind === 'confirm' && amendment.after.includes('满包'));
    expect(item?.object).toBe('雨水口连接管');
    expect(item?.action).toBe('是的');
  });

  it('短答族：混凝土满包 / C25 型短答即修正后内容', () => {
    const ledger = extractClarificationAmendmentLedger({
      texts: [{ text: ['1、雨水/污水靠墙井与检查井连接管是否需混凝土满包处理？', '', '答：混凝土满包', '', '2、未见混凝土满包砼标号？', '', '答：C25'].join('\n'), source: 补疑 }],
    });
    expect(ledger.amendments.some(amendment => amendment.after === '混凝土满包')).toBe(true);
    expect(ledger.amendments.some(amendment => amendment.after === 'C25')).toBe(true);
  });

  it('规格短答：304 不锈钢防滑条 30*1.5mm（用户实测漏项 2）', () => {
    const ledger = 抽取();
    const item = ledger.amendments.find(amendment => amendment.after.includes('304不锈钢防滑条'));
    expect(item).toBeTruthy();
    expect(item?.kind).toBe('confirm');
  });

  it('指向族：以围墙为分界线 + 一期已完成（用户实测漏项 3，sibling 子句不得丢）', () => {
    const ledger = 抽取();
    const item = ledger.amendments.find(amendment => amendment.after.includes('以围墙为分界线'));
    expect(item?.kind).toBe('confirm');
    expect(item?.after).toContain('一期已完成');
    expect(item?.after).toContain('完全分开');
  });

  it('一句多答（需要 X，不需要 Y）：X 的确认与 Y 的取消并存，且 X 断言里不得再含 Y', () => {
    const ledger = 抽取();
    const 取消 = ledger.amendments.find(amendment => amendment.kind === 'cancel' && amendment.object.includes('氯化橡胶面漆两道'));
    expect(取消?.after).toContain('不需要');
    expect(取消?.before[0]?.strength).toBe('strong');
    const 需要 = ledger.amendments.find(amendment => amendment.action === '需要');
    expect(需要?.after).toContain('环氧云铁中间漆');
    expect(需要?.after).not.toContain('氯化橡胶面漆');
  });

  it('取消族：取消此划线（问句内对象 + 答句动作）', () => {
    const ledger = 抽取();
    const item = ledger.amendments.find(amendment => amendment.kind === 'cancel' && amendment.after.includes('取消'));
    expect(item?.object).toContain('机动车地面停车位');
  });
});

describe('缺口显式化（never silent）', () => {
  it('未解析短答入账本缺口（不静默丢弃）', () => {
    const ledger = 抽取();
    expect(ledger.unparsedAnswers.some(entry => entry.answer.includes('按此做法'))).toBe(true);
  });

  it('非问答形态的平铺技术陈述入未覆盖清单（±0.000 高程，用户实测漏项 4）', () => {
    const ledger = 抽取();
    expect(ledger.uncoveredStatements.count).toBeGreaterThan(0);
    expect(ledger.uncoveredStatements.samples.some(sample => sample.text.includes('±0.000'))).toBe(true);
    // 判据不抽（无问答结构、无变更动词）：不得凭空造出修正条目
    expect(ledger.amendments.some(amendment => amendment.after.includes('绝对标高'))).toBe(false);
  });

  it('±0.000 高程不得被样本容量挤掉：埋在大段商务陈述之后仍在「量值形态优先」窗口内', () => {
    // 复现真实文件形态：50 条未覆盖陈述（大量带数字的商务条款）+ 尾部温馨提示里的高程口径
    const 商务 = Array.from({ length: 30 }, (_, index) => `${index + 1}、本项目执行第${index + 2}号文，暂列金额为 ${index + 1} 万元，投标人自行踏勘现场，综合考虑报价，中标后量、价不予调整。`);
    const 文本 = [...商务, '', '温馨提示', '', '1、本工程采用国家2000高程系统,建筑室内±0.000相当于绝对标高为8.00。清单对挖基础的深度，是按照现状自然地貌高程挖至设计图纸槽底高程考虑的，投标人自行踏勘现场，不予调整。'].join('\n');
    const ledger = extractClarificationAmendmentLedger({ texts: [{ text: 文本, source: 补疑 }] });
    expect(ledger.uncoveredStatements.count).toBeGreaterThan(30);
    expect(ledger.uncoveredStatements.measureShaped).toBeGreaterThanOrEqual(1);
    // console.warn 只打印前 5 条：技术口径必须落在这个窗口里，否则等于静默
    const window = ledger.uncoveredStatements.samples.slice(0, 5);
    expect(window.some(sample => sample.text.includes('±0.000'))).toBe(true);
  });
});

describe('反例：不得误判', () => {
  it('非答疑来源（招标正文）不入本通道', () => {
    const ledger = extractClarificationAmendmentLedger({ texts: [{ text: 补疑文本, source: '巢湖项目/招标文件/招标正文.docx' }] });
    expect(ledger.amendments).toEqual([]);
    expect(ledger.sourceCount).toBe(0);
  });

  it('答疑中未被修正的技术陈述不得被当成「修正前」', () => {
    const amendments = extractClarificationAmendments({ texts: [{ text: 补疑文本, source: 补疑 }] });
    const markdown = '本工程雨水管道基础按设计图纸施工，管道接口做法详见相关图集；素混凝土垫层厚度按设计。';
    const issues = clarificationAmendmentIssues(markdown, amendments);
    expect(issues.filter(issue => issue.message.includes('被取代形态残留'))).toEqual([]);
  });

  it('变更过程陈述语境豁免：原为X，经答疑修正为Y 不判残留', () => {
    const amendments = extractClarificationAmendments({ texts: [{ text: 补疑文本, source: 补疑 }] });
    const markdown = '原设计雨水管道基础为120°素混凝土管基，经答疑修正为180°中粗砂基础并外设土工布，据此施工。';
    const issues = clarificationAmendmentIssues(markdown, amendments);
    expect(issues.filter(issue => issue.message.includes('被取代形态残留'))).toEqual([]);
  });

  it('合法并行（需要 X，不需要 Y）：只写 X 不报错', () => {
    const amendments = extractClarificationAmendments({ texts: [{ text: 补疑文本, source: 补疑 }] })
      .filter(item => item.after.includes('环氧云铁') || item.object.includes('氯化橡胶面漆'));
    expect(amendments.length).toBeGreaterThanOrEqual(2);
    const markdown = 'ALC墙板钢骨架梁柱等配件做环氧云铁中间漆一遍，刷防火涂料。';
    expect(clarificationAmendmentIssues(markdown, amendments)).toEqual([]);
  });
});

describe('clarificationAmendmentIssues（2-3 义务与检测）', () => {
  it('修正前形态作为现行做法 → blocker（provenance 单源）', () => {
    const amendments = extractClarificationAmendments({ texts: [{ text: 补疑文本, source: 补疑 }] });
    const markdown = '管道基础采用120°素混凝土管基，管座混凝土强度等级按设计要求。';
    const issues = clarificationAmendmentIssues(markdown, amendments);
    const blocker = issues.find(issue => issue.message.includes('被取代形态残留'));
    expect(blocker?.severity).toBe('blocker');
    expect(blocker?.level).toBe('error');
    expect(blocker?.provenance?.detectorId).toBe(CLARIFICATION_AMENDMENT_DETECTOR_ID);
    expect(blocker?.message).toContain('180°中粗砂基础');
  });

  it('修正后内容未落位 → warning（不足额）', () => {
    const amendments = extractClarificationAmendments({ texts: [{ text: 补疑文本, source: 补疑 }] });
    const issues = clarificationAmendmentIssues('本章仅说明一般性施工准备与资源配置。', amendments);
    const warning = issues.find(issue => issue.message.includes('304不锈钢防滑条30*1.5mm'));
    expect(warning?.severity).toBe('warning');
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toContain('答疑修正未落位');
    // 漏项 1（满包）与漏项 3（围墙）同样以不足额报出：
    expect(issues.some(issue => issue.message.includes('混凝土满包'))).toBe(true);
    expect(issues.some(issue => issue.message.includes('一期已完成'))).toBe(true);
  });

  it('明确对立（答疑要求做、正文写不做）→ blocker', () => {
    const amendments = extractClarificationAmendments({ texts: [{ text: 补疑文本, source: 补疑 }] });
    const issues = clarificationAmendmentIssues('雨水口连接管不采用混凝土满包处理，按普通砂石基础施工。', amendments);
    expect(issues.some(issue => issue.severity === 'blocker' && issue.message.includes('明确对立'))).toBe(true);
  });

  it('空账本与空正文恒返回空（不得凭空报缺陷）', () => {
    expect(clarificationAmendmentIssues('任何正文', [])).toEqual([]);
    expect(clarificationAmendmentIssues('', extractClarificationAmendments({ texts: [{ text: 补疑文本, source: 补疑 }] }))).toEqual([]);
  });
});

describe('写作注入与检索加权', () => {
  it('按章归属：本章条目进本章块，未归属条目并入「全文适用」段（不得丢弃）', () => {
    const amendments = extractClarificationAmendments({ texts: [{ text: 补疑文本, source: 补疑 }] });
    const block = renderClarificationAmendmentBlock(amendments, { chapterTitle: '管道工程施工方法' });
    expect(block).toContain('【答疑修正（必须按修正后写，不得写修正前）】');
    expect(block).toContain('全文适用');
    // 未归属条目仍在块内（归属失败不丢修正）
    expect(block).toContain('304不锈钢防滑条');
    const 无章归属 = renderClarificationAmendmentBlock(amendments.map(item => ({ ...item, chapterTitle: undefined })));
    expect(无章归属).toContain('混凝土满包');
  });

  it('章归属复用清单事实锁单源（对象命中章标题/小节 token 即归属）', () => {
    const amendments = extractClarificationAmendments({ texts: [{ text: 补疑文本, source: 补疑 }] });
    const assigned = assignClarificationAmendmentChapters(amendments, [
      { title: '雨水管道工程施工方法', sections: ['雨水口及连接管施工', '管道基础与管座'] },
    ]);
    expect(assigned.some(item => item.chapterTitle)).toBe(true);
  });

  it('答疑载体检索加权 >1（变更优先），非答疑载体为 1', () => {
    expect(clarificationEvidenceBoost(补疑)).toBeGreaterThan(1);
    expect(clarificationEvidenceBoost('巢湖项目/招标文件/招标正文.docx')).toBe(1);
  });

  it('有序全文读取：只取答疑来源、按切片顺序拼接（问句紧邻答句）', () => {
    const texts = clarificationSourceTexts(
      [补疑, '巢湖项目/招标文件/招标正文.docx', 补疑],
      () => ({ file: { relativePath: 补疑 }, chunks: [{ content: '1、雨水口连接管是否全部采用混凝土满包处理？' }, { content: '答：是的' }] }),
    );
    expect(texts).toHaveLength(1);
    expect(texts[0]?.text.indexOf('雨水口连接管')).toBeLessThan(texts[0]!.text.indexOf('答：是的'));
  });
});

describe('amendmentFormStrength（残留判 blocker 的形态闸）', () => {
  it('携带量值/规格 → strong；纯词面短语 → weak', () => {
    expect(amendmentFormStrength('120°素混凝土管基')).toBe('strong');
    expect(amendmentFormStrength('304不锈钢防滑条30*1.5mm')).toBe('strong');
    expect(amendmentFormStrength('氯化橡胶面漆两道')).toBe('strong');
    expect(amendmentFormStrength('原土回填')).toBe('weak');
  });
});
