/**
 * 青天外部评分脚本（S6d）：用《青天大模型施工组织设计全维度专职校验专员工作规范》(docx)
 * + 本地知识库真实数据（招标文件技术文件详细评审标准 + 工程量清单项目特征）
 * 对生成文档做独立评分评审，输出 100 分制得分 → 5 分制折算（目标 ≥4.5，即优秀档 ≥90 分）。
 *
 * 用法：node scripts/qingtian-score.mjs <draftJsonPath> [--model deepseek-v4-pro]
 * 依赖：/tmp/qingtian-doc.txt（青天规范全文）、/tmp/bill-items.txt（清单项目特征）
 */
import fs from 'node:fs';

const CONFIG = JSON.parse(fs.readFileSync(process.env.HOME + '/.customize-agent/config.json', 'utf8'));
const providerName = 'deepseek-v4-pro';
const provider = CONFIG.providers?.[providerName] || {};
const API_KEY = provider.apiKey;
const BASE_URL = (provider.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
const MODEL = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : providerName;

const QINGTIAN_SPEC = fs.readFileSync('/tmp/qingtian-doc.txt', 'utf8');
// 优先读合肥师范清单；徽光阁清单作为回退（文件名后缀区分）
const billItemsPath = process.argv.includes('--bill')
  ? process.argv[process.argv.indexOf('--bill') + 1]
  : (fs.existsSync('/tmp/hfsf-bill-items.txt') ? '/tmp/hfsf-bill-items.txt' : '/tmp/bill-items.txt');
const BILL_ITEMS = fs.readFileSync(billItemsPath, 'utf8');
const draftPath = process.argv[2];
if (!draftPath || !fs.existsSync(draftPath)) { console.error('用法: node scripts/qingtian-score.mjs <draftJsonPath>'); process.exit(1); }
const draft = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
const markdown = draft.markdown || '';

// 招标文件技术文件详细评审标准（从 kb.db chunk 61/62/71 提取的真实原文）
const TENDER_SCORE_STANDARD = [
  '【本项目评标办法（招标文件第三章）真实标准】',
  '分值构成（100分）：技术文件 5 分 + 商务文件 10 分 + 报价文件 85 分。技术文件详细评审按 100 分制打分，得分×5% 计入总分。',
  '档位判定：一般得 0<F≤60 分；良好得 60<F<90 分；优秀得 90≤F≤100 分。本项满分 100 分，评标委员会结合工程特点，根据施工组织设计的针对性、可行性、语言精练度进行评审；内容未提供或无任何针对性、可行性，本项不得分。以 0.1 分为分割点评分。',
  '技术文件详细评审标准（依据投标人提供的施工组织设计进行评审，包括但不限于以下内容）：',
  '1. 针对工程项目整体理解；',
  '2. 工程重点难点及危大工程的保障体系与措施；',
  '3. 拟采用的新技术、新工艺（如有）；',
  '4. 确保工期与质量的保障体系与措施；',
  '5. 确保人、材、机的保障体系与措施；',
  '6. 确保安全文明生产的管理体系与措施。',
  '编制要求（招标文件原文）：（1）页面排版：A4；行距固定值 22 磅；页边距上 2.5 厘米、其余 2.0 厘米；（2）字体：宋体；标题三号、其他四号；（3）编制篇幅：施工组织设计不超过 50 页（不含封面和目录）；（4）结合工程实际特点，国家及地方现有工法规范已有的内容无需重复编制。',
  '工程概况（招标文件合同协议书原文）：工程名称：合肥师范学院新一代信息技术产教融合实训基地项目施工总承包。工程地点：巢湖市合肥黄麓科教园书香路6号。工程立项批准文号：《安徽省教育厅关于合肥师范学院新一代信息技术产教融合实训基地项目初步设计的批复》皖教秘发〔2026〕158号。资金来源：政府投资。工程内容：项目总占地面积约10970平方米，单体建筑面积28570.36平方米（其中：地上建筑面积24783.39平方米，地下建筑面积3786.97平方米），地上6层，地下1层，建筑消防高度28.90米、建筑规划高度32.85米。本工程有装配式技术要求，装配率为30%。招标范围为建设规模内的全部内容，具体详见图纸及清单。工程承包范围：招标文件约定的全套施工图纸、工程量清单范围内及过程变更的所有内容。质量标准：工程质量符合合格标准。合同价格形式：总价合同。招标人：合肥师范学院。',
  '专用合同条款质量与奖项要求（招标文件原文 5.1.1）：特殊质量标准和要求：确保黄山杯。关于工程奖项的约定：本项目确保获得"黄山杯"。获得"黄山杯"的，支付该项300万元（工程量清单中已单独列项）；自竣工验收合格之日起3年内未获得"黄山杯"的，该项不予支付。关于建造要求：（1）绿色建筑等级要求：达到国标二星级；（2）智慧工地管理要求：基本级。',
].join('\n');

// 6 个评审项 → 文档章节映射（按 markdown 行号切片，合肥师范第五轮 3 章结构：
// L89 第一章 / L305 第二章 / L956 第三章 / 无附录）
const REVIEW_ITEMS = [
  {
    id: 'item1', name: '针对工程项目整体理解', weight: 1,
    sections: [[90, 161]], // 1.1 编制说明与工程概况 + 1.2 编制依据 + 1.3 施工内容与现场条件
  },
  {
    id: 'item2', name: '工程重点难点及危大工程的保障体系与措施', weight: 1,
    sections: [[162, 186], [233, 304]], // 1.4 项目特点重点难点分析 + 1.6 危大工程与安全风险管控体系
  },
  {
    id: 'item3', name: '拟采用的新技术、新工艺（如有）', weight: 1,
    sections: [[734, 785], [578, 589]], // 2.44-2.48 新技术新工艺新材料新设备 + 2.29 智慧工地与在线监测
  },
  {
    id: 'item4', name: '确保工期与质量的保障体系与措施', weight: 1,
    sections: [[329, 366], [367, 517], [786, 824]], // 2.6-2.11 进度 + 2.12-2.22 施工方案与质量 + 2.49-2.52 关键工序/重难点/成品保护/四节一环保
  },
  {
    id: 'item5', name: '确保人、材、机的保障体系与措施', weight: 1,
    sections: [[187, 232], [957, 1132]], // 1.5 施工资源投入与保障计划 + 第三章
  },
  {
    id: 'item6', name: '确保安全文明生产的管理体系与措施', weight: 1,
    sections: [[233, 304], [518, 733]], // 1.6 危大工程与安全风险管控 + 2.23-2.43 文明施工/扬尘/噪声/绿色施工/劳务/应急
  },
];

function sliceSections(md, sections) {
  const lines = md.split('\n');
  const parts = [];
  for (const [start, end] of sections) {
    parts.push(lines.slice(start, Math.min(end, lines.length)).join('\n'));
  }
  return parts.join('\n\n');
}

// 每块正文预算 13000 字，超了按段落切分片
function chunkText(text, maxChars = 13000) {
  const parts = [];
  const paragraphs = text.split(/\n\n+/);
  let buf = '';
  for (const p of paragraphs) {
    if (buf && buf.length + p.length > maxChars) { parts.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) parts.push(buf);
  return parts;
}

const SCORE_SYSTEM = [
  '你是对标合肥青天大模型的施工组织设计全维度专职校验专员（评分评审员），精通青天大模型全维度评审逻辑、扣分规则与模板化降档机制。',
  '仅对标书做客观合规校验、问题定位与量化评分，不润色、不创作、不补充方案内容；所有判定均要有明确依据与原文佐证，不得主观臆断。',
  '',
  '【评分口径（唯一标准，不得自行增减）】',
  TENDER_SCORE_STANDARD,
  '',
  '【全维度评审细则（逐条对标）】',
  QINGTIAN_SPEC,
  '',
  '【评分任务】',
  '对给定评审项对应的正文内容，按以下口径打分（0-100 分，精确到 0.1 分）：',
  '1. 以招标文件技术文件详细评审标准该评审项的针对性、可行性、语言精练度为评分主轴；',
  '2. 结合青天规范十大维度逐条对标：形式格式、内容完整、合规红线、内容质量、数据逻辑、原创围串标、本地适配、正向关键词、反向关键词、模板化套用专项；',
  '3. 检出问题按风险等级计入扣分：否决级直接判不及格（≤60）；高风险（单项扣分≥3 或重度模板化）单处扣 3-5 分；中风险（扣 1-2 分或中度模板化）单处扣 1-2 分；低风险不直接扣分，多项叠加酌情扣 0.5-1 分；',
  '4. 模板化判定必须有量化支撑（通用表述占比、套话占比、专属信息绑定率），不得主观定性；',
  '5. 与本评审项无关的问题不计入本项得分，但可列入问题清单供交叉核验。',
  '',
  '【输出格式（严格 JSON，不得输出其他内容）】',
  '{"score": 数字, "grade": "优秀|良好|一般", "issues": [{"position": "章节/位置", "quote": "原文片段", "dimension": "所属维度", "risk": "否决级|高风险|中风险|低风险", "basis": "对标依据（招标文件条款或青天规范条款）"}], "strengths": ["亮点1", "亮点2"]}',
].join('\n');

async function callLlm(system, prompt) {
  const url = `${BASE_URL}/chat/completions`;
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 16384,
    thinking: { type: 'disabled' },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('空响应');
  return content;
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1];
  const payload = fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(payload);
  } catch (e) {
    // 截断容错：模型 issues 数组超长导致 JSON 被 max_tokens 截断时，score/grade 位于前缀，直接提取
    const score = payload.match(/"score"\s*:\s*([\d.]+)/);
    if (score) {
      return { score: Number(score[1]), grade: payload.match(/"grade"\s*:\s*"([^"]+)"/)?.[1] || '', issues: [], truncated: true };
    }
    throw e;
  }
}

function billItemsFor(item) {
  // 清单项目特征：按评审项关键词过滤相关分部条目 + 分部目录全量（合肥师范土建清单 90KB，
  // 全量塞入超上下文预算；盲取前 N 行会漏掉主体结构/装饰等后部分部）
  const lines = BILL_ITEMS.split('\n');
  const kwMap = {
    item1: ['土石方', '地基', '混凝土', '钢筋', '装配式', '砌筑'],
    item2: ['土石方', '基坑', '支护', '降水', '人防', '地下室'],
    item3: ['装配式', '混凝土', '钢筋', '金属', '新技术'],
    item4: ['混凝土', '钢筋', '砌筑', '防水', '屋面', '抹灰', '模板'],
    item5: ['钢筋', '混凝土', '砌筑', '门窗', '装饰', '幕墙'],
    item6: ['脚手架', '安全', '扬尘', '围挡', '临边', '土石方'],
  };
  const kws = kwMap[item.id] || [];
  const dirLines = lines.filter(l => /工程\s*\|/.test(l));
  const related = lines.filter(l => kws.some(k => l.includes(k)));
  // 目录全量 + 相关条目（上限约 60 行，防超预算）
  const picked = [...new Set([...dirLines, ...related])].slice(0, 60);
  return picked.join('\n') || lines.slice(0, 40).join('\n');
}

async function main() {
  console.log(`青天外部评分：${draft.id}，模型 ${MODEL}，正文 ${markdown.length} 字\n`);
  const results = [];
  for (const item of REVIEW_ITEMS) {
    const sectionText = sliceSections(markdown, item.sections);
    const chunks = chunkText(sectionText);
    console.log(`[${item.id}] ${item.name}：内容 ${sectionText.length} 字 → ${chunks.length} 个子块`);
    const itemIssues = [];
    const itemScores = [];
    for (let ci = 0; ci < chunks.length; ci += 1) {
      const prompt = [
        `评审对象：合肥师范学院新一代信息技术产教融合实训基地项目施工组织设计（${item.name}）`,
        `本块为该评审项第 ${ci + 1}/${chunks.length} 子块。`,
        '',
        '【清单项目特征（真实数据，用于术语匹配与工艺对标）】',
        billItemsFor(item),
        '',
        `【待评审正文（${item.name}）】`,
        '<正文块>',
        chunks[ci],
        '</正文块>',
      ].join('\n');
      const raw = await callLlm(SCORE_SYSTEM, prompt);
      let parsed;
      try { parsed = extractJson(raw); } catch (e) {
        console.error(`  ✗ 子块 ${ci + 1} JSON 解析失败: ${e.message}，原文前 200 字：${raw.slice(0, 200)}`);
        continue;
      }
      itemScores.push(Number(parsed.score) || 0);
      itemIssues.push(...(Array.isArray(parsed.issues) ? parsed.issues : []));
      console.log(`  ✓ 子块 ${ci + 1}: ${parsed.score} 分（${parsed.grade}），问题 ${(parsed.issues || []).length} 条`);
    }
    // 多子块：得分取子块均值（近似），问题全量
    const avg = itemScores.length ? itemScores.reduce((a, b) => a + b, 0) / itemScores.length : 0;
    results.push({ ...item, score: Math.round(avg * 10) / 10, issues: itemIssues });
    console.log(`  汇总: ${Math.round(avg * 10) / 10} 分\n`);
  }
  const total = results.reduce((a, r) => a + r.score * r.weight, 0) / results.reduce((a, r) => a + r.weight, 0);
  const fiveScale = Math.round((total / 20) * 10) / 10;
  console.log('='.repeat(60));
  console.log('青天外部评分汇总（100 分制 → 5 分制）');
  for (const r of results) console.log(`  ${r.name}: ${r.score} 分（${r.score >= 90 ? '优秀' : r.score >= 60 ? '良好' : '一般'}），问题 ${r.issues.length} 条`);
  console.log(`  技术文件总得分: ${Math.round(total * 10) / 10}/100 → 5 分制 ${fiveScale}/5`);
  console.log(`  与 4.5 分（优秀线 90 分）差距: ${fiveScale >= 4.5 ? '✅ 达标' : '❌ 差 ' + (4.5 - fiveScale).toFixed(1) + ' 分'}（100 分制差 ${(90 - total).toFixed(1)} 分）`);
  const allIssues = results.flatMap(r => r.issues.map(i => ({ ...i, item: r.name })));
  fs.writeFileSync('/tmp/qingtian-score-result.json', JSON.stringify({ docId: draft.id, results, total, fiveScale, issues: allIssues }, null, 2), 'utf8');
  console.log('\n问题清单已写入 /tmp/qingtian-score-result.json');
  const high = allIssues.filter(i => ['否决级', '高风险'].includes(i.risk));
  console.log(`\n否决级/高风险问题（${high.length} 条）：`);
  for (const i of high) console.log(`  [${i.risk}] ${i.item} | ${i.position}: ${i.quote?.slice(0, 60)}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
