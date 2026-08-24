import { describe, expect, it } from 'vitest';
import { matchProcessKnowledgeCards } from '../src/services/document-workflow/constructionProcessKnowledge';
import { repairMajorContentWorkPackageLabels, sectionStructureIssue } from '../src/services/document-workflow/chapterGeneration';

const structuredPackages = '施工工作包结构化数据：[{"name":"安装工程","scope":"含配电箱安装、桥架敷设及智能化面板点位安装","quantities":["消防动力配电总箱1APEza/1APEzb：2台","动力配电总箱1APz：1台","配电箱 非标箱 挂墙安装 2台"],"process":["配电箱安装","挂墙安装","柜内元器件接线","通电调试"],"acceptance":["绝缘电阻测试","通电试运行"]},{"name":"结构加固改造工程","scope":"含砌块墙加固","quantities":["砌块墙（100mm厚，3.6m以内）：19.79m3","砌块墙（200mm厚，3.6m以内）：256.01m3"],"process":["砌筑","墙顶塞缝"],"acceptance":["砌筑砂浆试块"]},{"name":"拆除工程","scope":"楼地面及天棚拆除","quantities":["楼地面、天棚拆除投影面积：4781.59㎡"],"process":["围挡隔离","分层拆除","垃圾清运"],"acceptance":["拆除专项方案"]},{"name":"装饰工程","scope":"墙面抹灰、墙地砖铺贴及吊顶","quantities":["吊顶拆除投影面积：4781.59㎡"],"process":["基层处理","抹灰","铺贴"],"acceptance":["空鼓敲击检查"]},{"name":"室外道排工程","scope":"室外雨污水管网","quantities":["HDPE双壁波纹管DN300：120m"],"process":["沟槽开挖","管道安装","闭水试验","回填"],"acceptance":["闭水试验记录"]},{"name":"智能化工程","scope":"综合布线及面板安装","quantities":["信息面板：24个"],"process":["管线预埋","线缆敷设","面板安装"],"acceptance":["链路测试报告"]}]';
const projectContext = `8.4徽光阁项目施工｜范围：建筑结构加固改造、建筑消防改造、室内装饰改造、室内水电改造、空调通风系统改造、弱电智能化改造、室外道排改造、屋面维修和建筑立面修补｜面积：建筑面积约为4645㎡｜计划工期：45日历天｜质量标准：合格
${structuredPackages}`;

describe('construction process knowledge card matching', () => {
  it('matches generalized package names to broad card groups', () => {
    const cards = matchProcessKnowledgeCards(['安装工程']);
    const names = cards.map(card => card.name);
    expect(names).toContain('电气工程');
    expect(names).toContain('给排水工程');
    expect(names).toContain('通风空调工程');
    expect(names).toContain('消防工程');
  });

  it('matches structural strengthening renovation packages', () => {
    const cards = matchProcessKnowledgeCards(['结构加固改造工程']);
    const names = cards.map(card => card.name);
    expect(names).toContain('结构加固');
  });

  it('matches demolition and outdoor pipeline packages', () => {
    const demolition = matchProcessKnowledgeCards(['拆除工程']).map(card => card.name);
    expect(demolition).toContain('拆除工程');
    const pipes = matchProcessKnowledgeCards(['室外道排工程']).map(card => card.name);
    expect(pipes).toContain('市政管道工程');
  });
});

const buildBlock = (method: string) => `### 项目主要施工内容

#### 安装工程

施工概况：安装工程属于本项目主要施工内容，实施范围为含配电箱安装等。配电箱均为非标箱，采用挂墙安装。本项目已确认的基础条件包括地上三层，三层框架结构，质量标准：合格。

施工流程：配电箱安装→柜内元器件接线→挂墙安装→通电调试。

施工方法：${method}

#### 结构加固改造工程

施工概况：结构加固改造工程属于本项目主要施工内容，实施范围为含砌块墙等。砌块墙为加气混凝土砌块、M5.0混合砂浆，厚度100mm/200mm。

施工流程：墙体厚度按100mm/200mm砌筑→使用M5.0混合砂浆→墙顶塞缝。

施工方法：砌块墙采用加气混凝土砌块与M5.0混合砂浆砌筑，砌筑顺序按基层清理→放线定位→排砖撂底→铺浆砌筑→墙顶塞缝组织，灰缝厚度控制在8~12mm，垂直度偏差≤5mm/层；砌筑砂浆试块留置检验，形成隐蔽验收记录闭环。

#### 拆除工程

施工概况：拆除工程属于本项目主要施工内容，实施范围为楼地面及天棚拆除。

施工流程：围挡隔离→分层拆除→垃圾清运。

施工方法：拆除采用自上而下分层作业，作业顺序按围挡防护→切断连接→分层剔凿→渣土归堆→外运组织，湿法作业降尘，垃圾清运日产日清，形成拆除专项方案与垃圾清运记录。

#### 装饰工程

施工概况：装饰工程属于本项目主要施工内容，实施范围为墙面抹灰、墙地砖铺贴及吊顶。

施工流程：基层处理→抹灰→铺贴。

施工方法：抹灰采用打点冲筋、分层抹灰工艺，作业顺序按基层清理→打点冲筋→分层抹灰→养护检查组织，每遍抹灰厚度≤7mm；墙地砖采用专用粘结剂铺贴，粘结层厚度≤10mm；完成后进行空鼓敲击检查并形成实测记录。

#### 室外道排工程

施工概况：室外道排工程属于本项目主要施工内容，实施范围为室外雨污水管网。

施工流程：沟槽开挖→管道安装→闭水试验→回填。

施工方法：管道安装顺序按沟槽开挖→垫层铺设→管道安装→闭水试验→分层回填组织，安装轴线偏差≤15mm，接口处理后进行闭水试验，渗水量按规范控制，回填分层厚度≤250mm，形成闭水试验记录闭环。
`;

describe('sectionStructureIssue construction method check', () => {
  it('flags bare parameter listing as weak construction method', () => {
    const issue = sectionStructureIssue('项目主要施工内容', buildBlock('配电箱安装与设备安装、工程改造及设备安装流程按开箱检查→定位放线→固定→接线组织，各工程部位安装按设备清单推进。'));
    expect(issue).toContain('施工方法过弱');
  });

  it('accepts narrational construction methods with process actions and parameters', () => {
    const issue = sectionStructureIssue('项目主要施工内容', buildBlock('配电箱采用挂墙方式安装，箱体安装牢固、盘面垂直；安装顺序按箱位定位→弹线钻孔→膨胀螺栓固定→箱体找正组织；柜内元器件按系统图接线，导线分色标识；安装完成后进行绝缘电阻测试与通电试运行，形成检测记录闭环。'));
    expect(issue).toBe('');
  });
});

describe('repairMajorContentWorkPackageLabels deterministic label repair', () => {
  it('adds missing 施工方法 label from unlabeled trailing text and passes structure gate', () => {
    const content = `### 项目主要施工内容

#### 安装工程

施工概况：安装工程实施范围为配电箱安装。配电箱采用挂墙方式安装。

施工流程：配电箱安装→柜内元器件接线→挂墙安装→通电调试。

配电箱采用挂墙方式安装，安装顺序按箱位定位→弹线钻孔→膨胀螺栓固定→箱体找正组织，柜内元器件按系统图接线，导线分色标识，完成后进行绝缘电阻测试与通电试运行并形成检测记录闭环。

#### 拆除工程

施工概况：拆除工程实施范围为楼地面及天棚拆除。

施工流程：围挡隔离→分层拆除→垃圾清运。

施工方法：拆除采用自上而下分层作业，作业顺序按围挡防护→切断连接→分层剔凿→渣土归堆→外运组织，湿法作业降尘，垃圾清运日产日清，形成拆除专项方案与垃圾清运记录。

#### 装饰工程

施工概况：装饰工程实施范围为墙面抹灰、墙地砖铺贴及吊顶。

施工流程：基层处理→抹灰→铺贴。

施工方法：抹灰采用打点冲筋、分层抹灰工艺，作业顺序按基层清理→打点冲筋→分层抹灰→养护检查组织，每遍抹灰厚度≤7mm，完成后进行空鼓敲击检查并形成实测记录。
`;
    const repaired = repairMajorContentWorkPackageLabels(content);
    expect(repaired).toContain('施工方法：配电箱采用挂墙方式安装');
    const issue = sectionStructureIssue('项目主要施工内容', repaired);
    expect(issue).toBe('');
  });

  it('adds missing 施工概况 label from first unlabeled line', () => {
    const content = `### 项目主要施工内容

#### 拆除工程

拆除作业覆盖楼地面及天棚，投影面积4781.59㎡。

施工流程：围挡隔离→分层拆除→垃圾清运。

施工方法：拆除采用自上而下分层作业，作业顺序按围挡防护→切断连接→分层剔凿→渣土归堆→外运组织，湿法作业降尘，垃圾清运日产日清，形成拆除专项方案与垃圾清运记录。
`;
    const repaired = repairMajorContentWorkPackageLabels(content);
    expect(repaired).toContain('施工概况：拆除作业覆盖楼地面及天棚');
    expect(repaired).toContain('施工流程：围挡隔离→分层拆除→垃圾清运');
  });

  it('does not touch #### blocks outside 项目主要施工内容 section', () => {
    const content = `### 项目特点、重点、难点分析

#### 施工难点与应对措施

带营业改造是本项目核心难点，需分区围挡。

### 项目主要施工内容

#### 拆除工程

施工概况：拆除工程实施范围为楼地面及天棚拆除。

施工流程：围挡隔离→分层拆除→垃圾清运。

施工方法：拆除采用自上而下分层作业，湿法作业降尘，形成拆除专项方案与垃圾清运记录。
`;
    const repaired = repairMajorContentWorkPackageLabels(content);
    // 非主要施工内容小节的块保持原样，不得被补标签
    expect(repaired).toContain('带营业改造是本项目核心难点，需分区围挡。');
    expect(repaired).not.toContain('施工概况：带营业改造是本项目核心难点');
  });

  it('is idempotent for blocks with all three labels present', () => {
    const content = buildBlock('配电箱采用挂墙方式安装，安装顺序按箱位定位→弹线钻孔→膨胀螺栓固定→箱体找正组织，完成后进行绝缘电阻测试与通电试运行并形成检测记录闭环。');
    const once = repairMajorContentWorkPackageLabels(content);
    const twice = repairMajorContentWorkPackageLabels(once);
    expect(twice).toBe(once);
  });
});
