export const CAD_ENTITY_TOKEN_RE = /\b(?:TDbPipe|TDbPipeValve|TDbPipeFitting|TDbWellh|AcDb\w+|Dwg\w+|Polyline|Hatch|Layer|BlockReference)\b/giu;
// 字符类收敛（M1 组实测真实缺陷）：原形态含 \s 与中英文括号，跨行贪婪吃掉文件名前文本
// （「正文\n招标文件.pdf\n后文」被洗成「后文」），且匹配 Markdown 图片行时把 alt 文本与左括号
// 一并吞掉（「![总平面图](p.png)」被破坏为「![总平面图])」），导致 forbidDrawingImages 的整行
// 图片清理正则（要求完整括号对）失效、图纸图残留正文。文件名清洗只应命中「名称+扩展名」本身。
export const FILE_NAME_RE = /[\w\u4e00-\u9fa5\-—_+]+\.(?:pdf|dwg|docx?|xlsx?|xls|csv|png|jpe?g|webp)\b/giu;
export const CN_NUMERAL_RE = '[零〇一二三四五六七八九十百千万两]+';
