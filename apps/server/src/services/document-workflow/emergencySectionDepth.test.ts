/**
 * emergencySectionDepth F3/F2 单测：
 * F3 应急物资复检口径——「物资名+配备词」确定性兜底，补写已落位不再判缺失；
 * F2 缺陷附 sectionTitle 小节锚点供修复循环直连定位。
 * 语义通道全部 mock（避免测试加载 Transformers.js 重依赖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emergencySectionDepthIssues } from './emergencySectionDepth';

vi.mock('./semanticSimilarity', () => ({ buildSemanticSimilarity: vi.fn(), SEMANTIC_COVERAGE_THRESHOLD: 0.6 }));

import { buildSemanticSimilarity } from './semanticSimilarity';

const buildSimilarityMock = vi.mocked(buildSemanticSimilarity);

type SimilarityFn = (left: string, right: string) => number;

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
    const issues = await emergencySectionDepthIssues(`## 应急预案与响应措施\n${EMERGENCY_BODY}`);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).not.toContain('应急物资保障');
    expect(issues[0].message).toContain('应急组织体系');
    expect(issues[0].message).toContain('应急处置程序/演练');
  });

  it('F3：正文无物资名时「应急物资保障」照常判缺失', async () => {
    mockSimilarity(0.1);
    // 去掉全部物资名词（急救箱/灭火器/沙袋…），配备/保障等动词仍在但无物资名不触发确定性兜底
    const bodyWithoutResource = EMERGENCY_BODY.replace(/急救箱|灭火器|对讲机|发电机|沙袋|水泵|防护服|救援绳|应急照明|应急物资/gu, '');
    const issues = await emergencySectionDepthIssues(`## 应急预案与响应措施\n${bodyWithoutResource}`);
    expect(issues[0].message).toContain('应急物资保障');
  });

  it('F2：缺陷附 sectionTitle 小节锚点（首个应急小节标题）', async () => {
    mockSimilarity(0.1);
    const issues = await emergencySectionDepthIssues(`## 应急预案与响应措施\n${EMERGENCY_BODY}`);
    expect(issues[0].sectionTitle).toBe('应急预案与响应措施');
  });
});
