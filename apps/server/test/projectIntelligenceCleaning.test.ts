import { constructionOrganizationPrompt, type ConstructionOrganizationGraph } from '../src/services/document-workflow/projectIntelligence';
import { dedupeQuantityFacts, filterConstructionSteps } from '../src/services/document-workflow/chapterGeneration';

// 真实生成（real-gen-19 缓存）暴露的脏数据形态：
// 1) 同一设备以“名称：数量”“名称 参数 数量”“名称｜规格”三种格式重复进入 quantities/materials/methods
// 2) process 混入设备型号条目（“XX总箱1APEza 2台 非标箱 挂墙安装”）与残尾（“配电箱”）
// 3) 异包清单条目串入 acceptance（门窗五金内容混入结构加固验收）
const dirtyGraph: ConstructionOrganizationGraph = {
  workPackages: [
    {
      name: '安装工程',
      scope: '含配电箱安装等。配电箱均为非标箱，柜内元器件购、安，挂墙安装。',
      quantities: [
        '消防动力配电总箱1APEza/1APEzb：2台',
        '消防动力配电总箱1APEza/1APEzb 2台 非标箱 挂墙安装',
        '配电箱：消防动力配电总箱1APEza/1APEzb，非标箱，柜内元器件购、安，挂墙安装，2台',
      ],
      materials: ['消防动力配电总箱1APEza/1APEzb｜非标箱；柜内元器件购、安；挂墙安装'],
      process: ['安装消防动力配电总箱1APEza/1APEzb、消防风机配电箱3APpy等非标配电箱', '柜内元器件购置与安装', '挂墙安装', '消防动力配电总箱1APEza/1APEzb 2台 非标箱 挂墙安装', '配电箱'],
      methods: ['配电箱安装', '消防动力配电总箱1APEza/1APEzb 2台 非标箱 挂墙安装'],
      acceptance: ['绝缘电阻测试', '通电试运行'],
      sourceFiles: [],
    },
    {
      name: '结构加固改造工程',
      scope: '含砌块墙等。',
      quantities: ['砌块墙（100mm厚，3.6m以内）：19.79m3', '砌块墙 100mm 高度3.6m以内 19.79m3'],
      materials: ['砌块墙（100mm厚，3.6m以内）｜加气混凝土砌块；M5.0混合砂浆'],
      process: ['砌筑', '墙顶塞缝'],
      methods: ['加气混凝土砌块墙砌筑'],
      acceptance: ['砌筑砂浆试块', '木质门五金品种、规格：满足规范要求及设计图纸；成品胶板隔声木门，含门套、门楣、配套五金等'],
      sourceFiles: [],
    },
    {
      name: '装饰工程',
      scope: '墙面抹灰、墙地砖铺贴及吊顶',
      quantities: ['人工清底（装饰工程）：249.8m2', '人工清底 249.8m2', '吊顶拆除投影面积：4781.59㎡'],
      materials: [],
      process: ['基层处理', '抹灰', '铺贴'],
      methods: ['抹灰', '墙地砖铺贴'],
      acceptance: ['空鼓敲击检查'],
      sourceFiles: [],
    },
  ],
  controlMatrix: [],
  qualityControls: [],
  safetyControls: [],
  resourcePlans: [],
  acceptanceRecords: [],
  evidenceRankingHints: [],
};

describe('constructionOrganizationPrompt dirty data cleaning', () => {
  it('dedupes multi-format quantities and drops device entries from process in prompt', () => {
    const prompt = constructionOrganizationPrompt(dirtyGraph);
    // 同一型号串在结构化数据中只保留一条
    const structured = JSON.parse(prompt.match(/施工工作包结构化数据：\s*(\[[^\n]*\])/u)![1]) as Array<{ name: string; quantities: string[]; process: string[] }>;
    const install = structured.find(item => item.name === '安装工程')!;
    expect(JSON.stringify(install.quantities).split('1APEza/1APEzb').length - 1).toBe(1);
    // 流程不得含设备型号条目与残尾
    expect(install.process.join('→')).not.toMatch(/1APEza|3APpy|配电箱/u);
    // 短工序词（挂墙安装）必须保留
    expect(install.process).toContain('挂墙安装');
    // 无数量重复的双格式条目（人工清底）也应去重
    const decor = structured.find(item => item.name === '装饰工程')!;
    expect(JSON.stringify(decor.quantities).split('249.8m2').length - 1).toBe(1);
  });

  it('merges same-object entries sharing model token when word order differs', () => {
    const merged = dedupeQuantityFacts([
      '消防动力配电总箱1APEza/1APEzb：2台',
      '消防动力配电总箱1APEza/1APEzb 2台 非标箱 挂墙安装',
      '配电箱：消防动力配电总箱1APEza/1APEzb，非标箱，柜内元器件购、安，挂墙安装，2台',
      '消防动力配电总箱1APEza/1APEzb｜非标箱；柜内元器件购、安；挂墙安装',
    ]);
    expect(merged.filter(item => item.includes('1APEza')).length).toBe(1);
    // 保留词集合最全的条目
    expect(merged[0]).toContain('柜内元器件购');
  });

  it('keeps short process words but drops bare list tail residues', () => {
    const quantities = [
      '消防动力配电总箱1APEza/1APEzb 2台 非标箱 挂墙安装',
      '配电箱：消防动力配电总箱1APEza/1APEzb，非标箱，柜内元器件购、安，挂墙安装，2台',
    ];
    const steps = filterConstructionSteps(['挂墙安装', '配电箱', '砌筑', '消防动力配电总箱1APEza/1APEzb 2台 非标箱 挂墙安装'], quantities);
    expect(steps).toContain('挂墙安装');
    expect(steps).toContain('砌筑');
    expect(steps).not.toContain('配电箱');
    expect(steps.some(step => step.includes('2台'))).toBe(false);
  });
});
