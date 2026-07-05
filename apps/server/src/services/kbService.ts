import { MultiProjectManager } from '@customize-agent/knowledge';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'node:child_process';
import * as XLSX from 'xlsx';

let manager: MultiProjectManager | null = null;

function downloadBuffer(url: string) {
  const script = 'import sys,urllib.request; url=sys.argv[1]; req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"}); sys.stdout.buffer.write(urllib.request.urlopen(req,timeout=30).read())';
  return execFileSync('python3', ['-c', script, url], { encoding: 'buffer', maxBuffer: 30 * 1024 * 1024 });
}

function writeBufferFile(file: string, data: Buffer, minSize: number, sourceUrl: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (data.length < minSize) throw new Error(`内置资料下载失败或文件过小：${sourceUrl}`);
  const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tempFile, data);
    fs.renameSync(tempFile, file);
  } catch (error) {
    try {
      if (fs.existsSync(tempFile)) fs.rmSync(tempFile, { force: true });
    } catch {
      console.warn('[builtin-demo] 临时文件清理失败', tempFile);
    }
    throw new Error(`内置资料写入失败：${file}，来源：${sourceUrl}，原因：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!fs.existsSync(file) || fs.statSync(file).size < minSize) {
    throw new Error(`内置资料写入失败或文件过小：${sourceUrl}`);
  }
  try {
    fs.writeFileSync(`${file}.source.txt`, `公开来源：${sourceUrl}\n本地文件：${path.basename(file)}\n文件大小：${fs.statSync(file).size} 字节\n`, 'utf-8');
  } catch {
    // 来源说明写入失败不影响主文件有效性。
  }
}

function downloadPublicFile(url: string, file: string, minSize: number) {
  if (fs.existsSync(file) && fs.statSync(file).size >= minSize) return;
  writeBufferFile(file, downloadBuffer(url), minSize, url);
}

function writeStitchedMapImage(mapName: string, file: string, minSize: number) {
  if (fs.existsSync(file) && fs.statSync(file).size >= minSize) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const script = `
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const fs = require('fs');
const cp = require('child_process');
const mapName = process.argv[1];
const out = process.argv[2];
const zoom = 2;
const tileSize = 256;
const gridSize = 4;
const canvas = createCanvas(tileSize * gridSize, tileSize * gridSize);
const ctx = canvas.getContext('2d');
(async () => {
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const url = \`https://game.gtimg.cn/images/dfm/cp/a20240729directory/img/\${mapName}/\${zoom}_\${x}_\${y}.jpg\`;
      const py = 'import sys,urllib.request; url=sys.argv[1]; req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"}); sys.stdout.buffer.write(urllib.request.urlopen(req,timeout=30).read())';
      const data = cp.execFileSync('python3', ['-c', py, url], { encoding: 'buffer', maxBuffer: 30 * 1024 * 1024 });
      const image = await loadImage(data);
      ctx.drawImage(image, x * tileSize, y * tileSize, tileSize, tileSize);
    }
  }
  fs.writeFileSync(out, canvas.toBuffer('image/jpeg'));
})().catch(error => { console.error(error); process.exit(1); });
`;
  execFileSync(process.execPath, ['-e', script, mapName, file], { cwd: process.cwd(), stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
  if (!fs.existsSync(file) || fs.statSync(file).size < minSize) throw new Error(`完整地图拼接失败：${mapName}`);
  try {
    fs.writeFileSync(`${file}.source.txt`, `公开来源：https://df.qq.com/cp/a20240729directory/\n地图目录：${mapName}\n拼接方式：zoom=2，4x4 官方瓦片完整覆盖\n本地文件：${path.basename(file)}\n文件大小：${fs.statSync(file).size} 字节\n`, 'utf-8');
  } catch {
    // 来源说明写入失败不影响主文件有效性。
  }
}

function writeTextFile(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === content) return;
    fs.writeFileSync(file, content, 'utf-8');
  } catch {
    if (!fs.existsSync(file)) throw new Error(`内置文本资料写入失败：${file}`);
  }
}

function writeWorkbookFile(file: string) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rows = [
    ['干员名称', '定位', '推荐指数', '上手难度', '推荐场景', '队伍职责'],
    ['露娜', '侦察', '5', '中', '信息侦察和路线判断', '开局侦察、标记威胁、辅助路线选择'],
    ['红狼', '突击', '5', '中高', '突破和正面交火', '负责开团突破和正面压制'],
    ['牧羊人', '工程', '4', '中', '防守控场和区域封锁', '负责卡点、防守和限制敌方推进'],
    ['蜂医', '支援', '5', '低', '治疗救援和续航', '负责救援、治疗和提高队伍容错'],
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), '热门干员推荐');
  XLSX.writeFile(workbook, file);
}

function writeDocxFile(file: string, title: string, paragraphs: string[]) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const script = `import sys,zipfile,html
out=sys.argv[1]; title=sys.argv[2]; ps=sys.argv[3:]
def p(t): return '<w:p><w:r><w:t>'+html.escape(t)+'</w:t></w:r></w:p>'
xml='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+p(title)+''.join(p(x) for x in ps)+'<w:sectPr/></w:body></w:document>'
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr('word/document.xml',xml)
`;
  execFileSync('python3', ['-c', script, file, title, ...paragraphs], { stdio: 'pipe' });
}

function writePdfFile(file: string, title: string) {
  if (fs.existsSync(file) && fs.statSync(file).size > 500) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 96>>stream\nBT /F1 18 Tf 72 760 Td (${title.replace(/[()\\]/gu, '')}) Tj 0 -32 Td (Delta Force builtin PDF sample for knowledge workflow.) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
  fs.writeFileSync(file, content, 'binary');
}

export function ensureBuiltInKnowledgeBase(projectRoot = getProjectRoot()): string {
  const root = path.resolve(projectRoot);
  const kbRoot = path.join(root, 'knowledgeBase');
  fs.mkdirSync(kbRoot, { recursive: true });
  for (const stale of [
    '图纸文件/图纸文件-战术路线示意.md',
    '文档资料/PDF资料-三角洲干员攻略摘要.pdf',
    '文档资料/Word资料-三角洲干员打法说明.docx',
    '文档资料/Word资料-队伍搭配说明.doc',
    '图片素材/干员图片/地图图纸-零号大坝-官方地图图纸瓦片.jpg',
    '图片素材/干员图片/地图图纸-航天基地-官方地图图纸瓦片.jpg',
    '图片素材/干员图片/地图图纸-巴克什-官方地图图纸瓦片.jpg',
    '图片素材/干员图片/地图图纸-潮汐监狱-官方地图图纸瓦片.jpg',
    '图片素材/干员图片/地图图纸-AZ3-官方地图图纸瓦片.jpg',
    '图片素材/干员图片/地图图纸-全面战场-攀升官方地图图纸瓦片.jpg',
  ]) {
    const stalePath = path.join(kbRoot, stale);
    try {
      if (fs.existsSync(stalePath)) fs.rmSync(stalePath, { force: true });
    } catch {
      // 旧占位文件删除失败不阻断真实内置资料补齐。
    }
  }

  const files: Record<string, string> = {
    '文档资料/规则文件-攻略写作要求.md': `# 【内置】三角洲热门干员攻略写作要求

公开参考入口：https://df.qq.com/、https://df.qq.com/cp/a20240729directory/、https://playerhub.df.qq.com/

写作要求：
- 面向新手和进阶玩家，语言要直白。
- 必须解释干员定位、技能价值、适用场景和常见误区。
- 地图章节必须引用官方地图工具的地图图纸/底图瓦片来源。
- 不能把没有来源的数据写成确定结论。
- 表格中的推荐指数只能作为示例参考。`,
    '文档资料/项目事实-热门干员资料.md': `# 【内置】三角洲热门干员资料

公开来源：三角洲行动官网 https://df.qq.com/、官方地图工具 https://df.qq.com/cp/a20240729directory/、PlayerHub 干员图片资源。

攻略目标：帮助用户快速理解热门干员怎么选、怎么搭配、怎么上手，并能把干员选择与地图推进、撤离路线和队伍分工结合起来。
适用人群：刚开始游玩三角洲行动的新手，以及希望快速建立队伍分工的进阶玩家。

## 资料使用方式
- 写攻略时先引用本文件确认干员定位，再结合表格数据给出推荐优先级。
- 地图段落必须结合官方地图工具来源，不要把玩家经验写成官方结论。
- 生成内容应区分“适合新手的稳定打法”和“需要配合的进阶打法”。

## 热门干员详解

### 露娜
- 定位：侦察 / 信息位。
- 主要价值：提前发现敌方动向，帮助队伍判断安全路线、交火风险和撤离窗口。
- 推荐指数：5。
- 上手难度：中。
- 适合场景：开局探点、复杂建筑区推进、撤离点前最后确认。
- 常见误区：把侦察位当成单人突击位。露娜的价值不是第一个开枪，而是让队伍更早做出正确决策。

### 红狼
- 定位：突击 / 突破位。
- 主要价值：在队伍已经掌握信息后打开突破口，压制敌方关键角度。
- 推荐指数：5。
- 上手难度：中高。
- 适合场景：门口突破、近中距离强交火、撤离点争夺。
- 常见误区：没有侦察信息就盲目强冲。红狼适合执行突破，不适合代替信息位探路。

### 牧羊人
- 定位：工程 / 控场位。
- 主要价值：限制敌方推进、保护队友换弹/救援/撤离，适合固定入口、楼梯、狭窄通道和撤离路线防守。
- 推荐指数：4。
- 上手难度：中。
- 适合场景：建筑防守、据点争夺、撤离点反打。
- 常见误区：认为控场就是原地不动。优秀的控场应当让敌方不能舒服推进，同时给己方创造转移时间。

### 蜂医
- 定位：支援 / 治疗救援位。
- 主要价值：提高队伍容错，让队伍在一次交火失误后仍然有继续行动的空间。
- 推荐指数：5。
- 上手难度：低。
- 适合场景：新手三排、长线搜资源、撤离前连续交火。
- 常见误区：只在队友倒地后才行动。蜂医应提前判断安全救援位置和撤退路线。

## 队伍搭配建议
| 队伍类型 | 推荐组合 | 适合用户 | 使用要点 |
| --- | --- | --- | --- |
| 新手稳健队 | 露娜 + 蜂医 + 牧羊人 | 刚熟悉地图和撤离机制的玩家 | 先拿信息，再稳步推进，不追求每次强开 |
| 突破压制队 | 露娜 + 红狼 + 蜂医 | 有基本交火能力的玩家 | 露娜给信息，红狼执行突破，蜂医保障容错 |
| 控图防守队 | 露娜 + 牧羊人 + 蜂医 | 喜欢资源控制和防守反打的玩家 | 依靠地图理解和撤离路线控制获胜 |

## 地图事实
官方地图工具提供零号大坝、长弓溪谷、航天基地、巴克什、潮汐监狱、AZ3、攀升、临界点、贯穿、烬区、堑壕战等地图图纸/底图瓦片，并包含物资点、出生点、撤离点、首领、据点、载具、固定弹药箱等坐标信息。

## 实战技巧
- 新手队伍建议至少包含一名侦察和一名支援；进攻队伍可以搭配突击位；防守或卡点时工程位价值更高。
- 进入高风险建筑前，先用信息位确认敌方大致位置，再由突击位执行突破。
- 撤离前优先确认地图上的撤离路线、固定补给点和可能交火区域。
- 如果队伍里有蜂医，不代表可以无视站位；治疗和救援必须建立在安全角度和队友掩护之上。
- 如果队伍里有牧羊人，应提前规划控场位置，而不是交火后临时补救。`,
    '表格数据/表格数据-热门干员推荐.csv': `干员名称,定位,推荐指数,上手难度,推荐场景
露娜,侦察,5,中,信息侦察和路线判断
红狼,突击,5,中高,突破和正面交火
牧羊人,工程,4,中,防守控场和区域封锁
蜂医,支援,5,低,治疗救援和续航`,
    '文档资料/规范文件-攻略结构规范.md': `# 【内置】攻略结构规范

必须包含：攻略目标、热门干员定位、队伍搭配、推荐优先级、地图图纸说明、实战注意事项。
推荐写法：先讲结论，再讲原因，最后给操作建议。
导出前检查：不能出现缺失资料占位语；必须包含至少一张推荐表；必须覆盖露娜、红狼、牧羊人、蜂医；必须引用官方地图工具。`,
  };
  for (const [name, content] of Object.entries(files)) writeTextFile(path.join(kbRoot, name), content);
  writeWorkbookFile(path.join(kbRoot, '表格数据', '表格数据-热门干员推荐.xlsx'));
  writeWorkbookFile(path.join(kbRoot, '表格数据', '表格数据-热门干员推荐.xls'));
  writeTextFile(path.join(kbRoot, '文档资料', 'Word资料-队伍搭配说明.doc'), '【内置 DOC 示例】\n队伍搭配建议：露娜负责侦察和路线判断，蜂医负责治疗和救援，红狼负责突破，牧羊人负责防守控场。\n');
  writeDocxFile(path.join(kbRoot, '文档资料', 'Word资料-队伍搭配说明.docx'), '三角洲行动队伍搭配说明', ['露娜负责侦察和路线判断，蜂医负责治疗和救援。', '红狼适合突破和正面压制，牧羊人适合防守控场。', '内置 DOCX 用于验证 Word 类文件解析、索引、角色绑定和文档生成全流程。']);
  writePdfFile(path.join(kbRoot, '文档资料', 'PDF资料-官方攻略摘录.pdf'), 'Delta Force Builtin PDF Sample');

  const imageUrls: Record<string, string> = {
    '露娜.png': 'https://playerhub.df.qq.com/playerhub/60004/object/p_88000000028.png',
    '红狼.png': 'https://playerhub.df.qq.com/playerhub/60004/object/p_88000000030.png',
    '牧羊人.png': 'https://playerhub.df.qq.com/playerhub/60004/object/p_88000000029.png',
    '蜂医.png': 'https://playerhub.df.qq.com/playerhub/60004/object/p_88000000027.png',
  };
  const imageLines = ['# 【内置】干员图片资料', '', '图片公开来源：PlayerHub / luoy-oss deltaforce_id 公开索引', ''];
  for (const [name, url] of Object.entries(imageUrls)) {
    const file = path.join(kbRoot, '图片素材', '干员图片', name);
    downloadPublicFile(url, file, 1000);
    imageLines.push(`- ${name.replace('.png', '')}：${url}；本地文件：${path.relative(kbRoot, file)}；大小：${fs.statSync(file).size} 字节`);
  }
  writeTextFile(path.join(kbRoot, '图片素材', '图片文件-干员图片来源.md'), imageLines.join('\n'));

  const maps: Record<string, string> = {
    '零号大坝-官方完整地图图纸.jpg': 'map_db',
    '航天基地-官方完整地图图纸.jpg': 'map_htjd',
    '巴克什-官方完整地图图纸.jpg': 'map_bks',
    '潮汐监狱-官方完整地图图纸.jpg': 'map_cxjy',
    'AZ3-官方完整地图图纸.jpg': 'map_az3',
    '全面战场-攀升官方完整地图图纸.jpg': 'map_qhz',
  };
  const mapLines = ['# 【内置】三角洲官方完整地图图纸资料', '', '来源页面：https://df.qq.com/cp/a20240729directory/', '说明：该官方地图工具使用 Leaflet 瓦片图作为地图图纸/底图资源，以下文件不是单瓦片，而是由官方 4x4 瓦片网格拼接得到的完整地图图纸。', ''];
  for (const [name, mapName] of Object.entries(maps)) {
    const file = path.join(kbRoot, '图片素材', '干员图片', `地图图纸-${name}`);
    writeStitchedMapImage(mapName, file, 50000);
    mapLines.push(`- ${name}：官方目录 ${mapName}，来源页面：https://df.qq.com/cp/a20240729directory/；本地文件：${path.relative(kbRoot, file)}；大小：${fs.statSync(file).size} 字节`);
  }
  writeTextFile(path.join(kbRoot, '图纸文件', '图纸文件-官方地图图纸来源.md'), mapLines.join('\n'));
  return root;
}

function getWorkspaceRoot(): string {
  return process.env.INIT_CWD && !isInternalResidualProject(process.env.INIT_CWD)
    ? process.env.INIT_CWD
    : path.resolve(process.cwd(), '../..');
}

export function getStorageRoot(): string {
  return path.join(os.homedir(), '.customize-agent');
}

export function getMultiProjectManager(): MultiProjectManager {
  if (!manager) manager = new MultiProjectManager(getStorageRoot());
  return manager;
}

function isInternalResidualProject(projectRoot: string): boolean {
  const normalized = path.resolve(projectRoot);
  const homeConfig = path.resolve(path.join(os.homedir(), '.customize-agent'));
  if (fs.existsSync(path.join(normalized, 'pnpm-workspace.yaml')) && fs.existsSync(path.join(normalized, 'apps', 'server'))) return false;
  return normalized === homeConfig
    || normalized.includes(`${path.sep}.customize-agent${path.sep}`)
    || normalized.endsWith(`${path.sep}apps${path.sep}server`)
    || normalized.endsWith(`${path.sep}apps${path.sep}cli`);
}

export function getKnownProjectRoots(): string[] {
  const registryPath = path.join(getStorageRoot(), 'projects', 'registry.db');
  if (!fs.existsSync(registryPath)) return [];
  const db = new Database(registryPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT project_root FROM project_registry ORDER BY last_opened_at DESC').all() as Array<{ project_root: string }>;
    return rows.map(r => path.resolve(r.project_root)).filter(root => !isInternalResidualProject(root));
  } finally { db.close(); }
}

export function getProjectRoot(): string {
  const envRoot = process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD;
  if (envRoot && fs.existsSync(envRoot) && !isInternalResidualProject(envRoot)) return path.resolve(envRoot);
  const known = getKnownProjectRoots();
  if (known.length > 0) return known[0]!;
  return getWorkspaceRoot();
}

export function resolveProjectRoot(queryRoot?: string): string | null {
  if (queryRoot) {
    const resolved = path.resolve(queryRoot);
    return fs.existsSync(resolved) && !isInternalResidualProject(resolved) ? resolved : null;
  }
  return getProjectRoot();
}

export async function shutdownKbService(): Promise<void> {
  if (manager) { await manager.shutdown(); manager = null; }
}
