export const CAD_ENTITY_TOKEN_RE = /\b(?:TDbPipe|TDbPipeValve|TDbPipeFitting|TDbWellh|AcDb\w+|Dwg\w+|Polyline|Hatch|Layer|BlockReference)\b/giu;
export const FILE_NAME_RE = /[\w\u4e00-\u9fa5（）()\-—_+\s]+\.(?:pdf|dwg|docx?|xlsx?|xls|csv|png|jpe?g|webp)\b/giu;
export const CN_NUMERAL_RE = '[零〇一二三四五六七八九十百千万两]+';
