/**
 * emergencySectionDepth F3/F2 单测：
 * F3 应急物资复检口径——「物资名+配备词」确定性兜底，补写已落位不再判缺失；
 * F2 缺陷附 sectionTitle 小节锚点供修复循环直连定位。
 * 语义通道全部 mock（避免测试加载 Transformers.js 重依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emergencySectionDepthIssues } from '@/services/document-workflow/emergencySectionDepth';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

import { buildSemanticSimilarity } from '@/services/document-workflow/semanticSimilarity';

const buildSimilarityMock = vi.mocked(buildSemanticSimilarity);

type SimilarityFn = (left: string, right: string) => number;

/**
 * 应急语义 gate 注入的确定性嵌入（标题分类与物资兜底共用）：
 * 预案/处置/物资类词面 → [1,0] 命中正例原型；
 * 应急照明/应急电源类词面 → [0,1] 命中负例原型（放行，不误归应急区/物资保障）；
 * 其余 → [0,0]。
 */
const embedDocuments = async (texts: string[]) => texts.map(text => {
  const legalLike = /应急照明|应急电源|灯具|回路|电气/u.test(text);
  const emergencyLike = !legalLike && /应急预案|应急处置|应急救援|应急物资|应急器材|抢险|疏散/u.test(text);
  return [emergencyLike ? 1 : 0, legalLike ? 1 : 0];
});

/** 应急小节正文（≥300 字）：组织/程序句由语义判定（mock 恒 0.1 即缺失），物资句走确定性兜底 */
const EMERGENCY_BODY = [
  '本工程设置应急管理领导小组，由项目经理任组长，明确抢险救援、医疗救护、后勤保障各岗位的职责分工与通讯联络方式。',
  '应急响应按事件危害程度分级启动，各级别明确处置程序、上报时限与外部救援衔接要求。',
  '项目部每年组织不少于两次综合应急演练，演练结束后对响应速度与处置效果进行评估并修订预案。',
  '应急物资保障：现场配备急救箱 4 个、灭火器 20 具、对讲机 10 台、发电机 2 台，由专职安全员每月检查并补充更新台账。',
  '各施工区域设置应急疏散通道与集结点，通道保持畅通，夜间设置应急照明并定期检查。',
  '抢险人员统一配备防护服、安全帽与救援绳，物资仓库实行专人保管与领用登记制度。',
  '针对基坑坍塌、高处坠落、触电与火灾四类主要风险分别制定现场处置卡，明确先期处置步骤。',
  '汛期前组织防汛专项检查，储备沙袋、水泵等防汛物资并指定存放位置与调用责任人。',
].join('\n');

function mockSimilarity(score: number): void {
  buildSimilarityMock.mockResolvedValue((() => score) as SimilarityFn);
}

describe('emergencySectionDepthIssues（F3 应急物资复检口径 + F2 小节锚点）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('F3：物资名+配备词确定性兜底——语义全不命中时不再判「应急物资保障」缺失', async () => {
    mockSimilarity(0.1);
    const issues = await emergencySectionDepthIssues(`## 应急预案与响应措施\n${EMERGENCY_BODY}`, embedDocuments);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).not.toContain('应急物资保障');
    expect(issues[0].message).toContain('应急组织体系');
    expect(issues[0].message).toContain('应急处置程序/演练');
  });

  it('F3：正文无物资名时「应急物资保障」照常判缺失', async () => {
    mockSimilarity(0.1);
    // 去掉全部物资名词（急救箱/灭火器/沙袋…），配备/保障等动词仍在但无物资名不触发确定性兜底
    const bodyWithoutResource = EMERGENCY_BODY.replace(/急救箱|灭火器|对讲机|发电机|沙袋|水泵|防护服|救援绳|应急照明|应急物资/gu, '');
    const issues = await emergencySectionDepthIssues(`## 应急预案与响应措施\n${bodyWithoutResource}`, embedDocuments);
    expect(issues[0].message).toContain('应急物资保障');
  });

  it('F2：缺陷附 sectionTitle 小节锚点（首个应急小节标题）', async () => {
    mockSimilarity(0.1);
    const issues = await emergencySectionDepthIssues(`## 应急预案与响应措施\n${EMERGENCY_BODY}`, embedDocuments);
    expect(issues[0].sectionTitle).toBe('应急预案与响应措施');
  });

  it('弱词根标题语义扩围：抢险救援类变体标题纳入应急区并报深度不足', async () => {
    mockSimilarity(0.1);
    const issues = await emergencySectionDepthIssues(`## 抢险救援措施\n现场配备急救箱 2 个。`, embedDocuments);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].sectionTitle).toBe('抢险救援措施');
  });

  it('弱词根标题负例保护：应急照明系统小节不误归应急区', async () => {
    mockSimilarity(0.1);
    const issues = await emergencySectionDepthIssues(`## 应急照明系统\n应急照明灯具按回路配置。`, embedDocuments);
    expect(issues).toHaveLength(0);
  });

  it('物资兜底负例保护：应急照明灯具配置句不判物资保障', async () => {
    mockSimilarity(0.1);
    const issues = await emergencySectionDepthIssues(`## 应急预案与响应措施\n应急照明灯具按回路配置，每个疏散口设置应急灯 2 套。`, embedDocuments);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('应急物资保障');
  });
});
