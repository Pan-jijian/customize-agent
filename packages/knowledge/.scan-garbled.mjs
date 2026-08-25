/**
 * 一次性诊断脚本：全面扫描知识库数据库中的疑似乱码 chunk
 * 用法：node .scan-garbled.mjs [minScore]
 */
import Database from 'better-sqlite3';

const DB = '/Users/pan/.customize-agent/projects/3c3f04667c69/kb.db';
const db = new Database(DB, { readonly: true });

// 乱码信号（比单字符正则更全面）
const GARBLED_CHAR_RE = /[\u3400-\u4DBF\u{20000}-\u{2FA1F}\uE000-\uF8FF]/gu; // Ext A/B + 私用区
const LETTER_RE = /\p{Letter}/gu; // 任意字母
const CJK_LATIN_GREEK_RE = /[\p{Script=Han}\p{Script=Latin}\p{Script=Greek}]/u;
const KNOWN_GARBLED_CHARS = /[罍眄簃锟鈉絙铖鋿䱠䏳䵳䑿䵀]/gu;
const SYMBOL_GARBLE_RE = /[\uFFFD\uFFFF-\uFFFF]|[\x80-\x9F]/gu; // 替换符/控制区
// Latin-1 扩展字母/符号（GBK 中文被 Latin-1 误读的产物：ÉÏ="上"、¹ñ="柜"）
const LATIN_EXTENDED_RE = /[\u00C0-\u00FF]/gu;

function analyze(text) {
  if (!text) return null;
  const chars = [...text];
  const total = chars.length;
  // 1. 字符类信号
  const rareCjk = (text.match(GARBLED_CHAR_RE) ?? []).length;
  const foreignLetters = [...new Set(text.match(LETTER_RE) ?? [])].filter(ch => !CJK_LATIN_GREEK_RE.test(ch)).length;
  const known = (text.match(KNOWN_GARBLED_CHARS) ?? []).length;
  const symbols = (text.match(SYMBOL_GARBLE_RE) ?? []).length;
  const latinExt = (text.match(LATIN_EXTENDED_RE) ?? []).filter(ch => !/[°±×÷·µ²³Ø]/.test(ch)).length;
  // GBK 误读行：含 Latin-1 扩展字符且不是合法工程符号（°±×÷·µ²³Ø；¼½¾¹ 属误读产物）的短行
  const gbkMisreadLines = text.split('\n').filter(line => {
    const bad = [...line].filter(ch => /[\u00C0-\u00FF]/u.test(ch) && !/[°±×÷·µ²³Ø]/.test(ch)).length;
    const han = (line.match(/\p{Script=Han}/gu) ?? []).length;
    return bad >= 1 && han === 0;
  }).length;
  // 2. 统计类信号：单字符高频
  const charCounts = new Map();
  for (const ch of chars) charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
  let mostCommon = ''; let mostCount = 0;
  for (const [ch, n] of charCounts) if (n > mostCount) { mostCommon = ch; mostCount = n; }
  const dominance = total >= 10 ? mostCount / total : 0;
  // 3. 行结构信号：超长无句读行
  const lines = text.split('\n').filter(Boolean);
  const maxLine = Math.max(0, ...lines.map(l => l.length));
  const hasSentencePunct = /[。，；：？！、,.!?;:]/.test(text);
  // 4. 汉字数量（判断是否中文语境）
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  let score = 0;
  const flags = [];
  if (rareCjk >= 2 && rareCjk / Math.max(1, total) >= 0.1) { score += 40; flags.push(`rareCjk=${rareCjk}`); }
  else if (rareCjk >= 1 && rareCjk / Math.max(1, total) >= 0.2) { score += 40; flags.push(`rareCjk=${rareCjk}`); }
  if (known >= 2) { score += 30; flags.push(`known=${known}`); }
  if (foreignLetters >= 1 && han > 0) { score += 30; flags.push(`foreign=${foreignLetters}`); }
  if (symbols >= 1) { score += 20; flags.push(`sym=${symbols}`); }
  if (latinExt >= 2) { score += 25; flags.push(`latinExt=${latinExt}`); }
  if (gbkMisreadLines >= 1) { score += 35; flags.push(`gbkLines=${gbkMisreadLines}`); }
  if (total >= 40 && maxLine > 400 && !hasSentencePunct) { score += 30; flags.push(`longLine=${maxLine}`); }
  if (total >= 20 && dominance > 0.2 && /[\p{Script=Han}]/u.test(mostCommon)) { score += 30; flags.push(`dom=${mostCommon}x${mostCount}/${total}`); }
  return score > 0 ? { score, flags, total, han, maxLine, dominance: dominance.toFixed(2) } : null;
}

const rows = db.prepare(`
  SELECT id, relative_path, chunk_index, content, category, format, metadata_json
  FROM kb_chunks
`).all();

console.log(`共扫描 ${rows.length} 个 chunk\n`);
const suspicious = [];
for (const row of rows) {
  const a = analyze(row.content);
  if (a && a.score >= 20) suspicious.push({ ...row, ...a });
}
suspicious.sort((x, y) => y.score - x.score);
console.log(`疑似乱码 chunk: ${suspicious.length} 个\n`);
for (const s of suspicious) {
  const preview = s.content.replace(/\s+/g, ' ').slice(0, 120);
  console.log(`[score=${s.score}] ${s.relative_path} (${s.category}/${s.format}) seq=${s.chunk_index} chars=${s.total} han=${s.han} ${s.flags.join(' ')}`);
  console.log(`   ${preview}`);
  console.log('');
}
db.close();
