import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parameterConceptConflictIssues } from '@/services/document-workflow/parameterConceptConflicts';

vi.mock('@/services/document-workflow/semanticSimilarity', () => ({ getLocalSemanticProvider: vi.fn() }));
import { getLocalSemanticProvider } from '@/services/document-workflow/semanticSimilarity';

const providerMock = vi.mocked(getLocalSemanticProvider);
const embedMock = vi.fn<(texts: string[]) => Promise<number[][]>>();

beforeEach(() => {
  vi.clearAllMocks();
  providerMock.mockReturnValue({ embedDocuments: embedMock } as never);
});

describe('probe', () => {
  it('real doc sentences: all concepts in one cluster', async () => {
    embedMock.mockImplementation(async (texts: string[]) => texts.map(() => [1, 0]));
    const markdown = [
      '路面结构层按“路床碾压检验→塘渣石垫层摊铺→水泥稳定碎（砾）石基层摊铺→透层与粘层喷洒→沥青混凝土面层铺筑→侧平石安砌→绿化种植”的顺序推进，路床碾压检验、塘渣石垫层、水泥稳定碎（砾）石按5%厂拌水泥含量控制、洒水车养护不少于7天，粗粒式沥青混凝土(AC-25C)6cm厚与细粒式改性沥青混凝土面层(AC-13C)4cm厚各13898.51m²，压实度不小于95%、顶面容许回弹弯沉值不大于1.1mm；侧平石安砌前先浇筑C15侧缘石垫层。',
      '基层验收后依次喷洒透层13898.51m²（慢裂型乳化沥青，喷油量1.0L/m²）与粘层（快裂型乳化沥青，喷油量0.5L/m²），再铺筑粗粒式普通沥青混凝土(AC-25C)6cm厚13898.51m²、细粒式改性沥青混凝土面层(AC-13C)4cm，压实度按不小于95%控制，顶面容许回弹弯沉值不大于1.1mm。',
    ].join('\n');
    const issues = await parameterConceptConflictIssues(markdown);
    console.log(JSON.stringify(issues, null, 2));
    expect(issues).toBeDefined();
  });
});
