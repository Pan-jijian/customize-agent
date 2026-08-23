const FULL_WIDTH_CHARS = /[Ａ-Ｚａ-ｚ０-９％＋－．，]/gu;

function toHalfWidthChar(char: string) {
  const code = char.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  return char;
}

export function normalizeEngineeringMeasure(value: string) {
  return value
    .replace(FULL_WIDTH_CHARS, toHalfWidthChar)
    .replace(/\s+/gu, '')
    .replace(/[×X＊*]/gu, 'x')
    .replace(/[％]/gu, '%')
    .replace(/‰/gu, 'permille')
    .replace(/平方米|平方|平米|m²|㎡/giu, 'm2')
    .replace(/公顷|hm²/giu, 'hm2')
    .replace(/立方米|立方|m³/giu, 'm3')
    .replace(/升/gu, 'l')
    .replace(/毫升/gu, 'ml')
    .replace(/千米|公里/gu, 'km')
    .replace(/毫米/gu, 'mm')
    .replace(/厘米/gu, 'cm')
    .replace(/米/gu, 'm')
    .replace(/千克|公斤/gu, 'kg')
    .replace(/克/gu, 'g')
    .replace(/吨/gu, 't')
    .replace(/人民币万元|万元人民币/gu, '万元')
    .replace(/人民币元|元人民币|¥/gu, '元')
    .replace(/日历天|自然日/gu, '天')
    .replace(/工作日/gu, '工作天')
    .replace(/个月/gu, '月')
    .replace(/小时/gu, 'h')
    .replace(/分钟/gu, 'min')
    .replace(/兆帕/gu, 'mpa')
    .replace(/千帕/gu, 'kpa')
    .replace(/千牛/gu, 'kn')
    .replace(/牛/gu, 'n')
    .replace(/千瓦/gu, 'kw')
    .replace(/兆瓦/gu, 'mw')
    .replace(/瓦/gu, 'w')
    .replace(/千伏/gu, 'kv')
    .replace(/伏/gu, 'v')
    .replace(/毫安/gu, 'ma')
    .replace(/安培|安/gu, 'a')
    .replace(/赫兹/gu, 'hz')
    .replace(/摄氏度/gu, '℃')
    .replace(/百分之\s*(\d+(?:\.\d+)?)/gu, '$1%')
    .replace(/千分之\s*(\d+(?:\.\d+)?)/gu, '$1permille')
    .replace(/直径\s*(\d+(?:\.\d+)?)/gu, 'φ$1')
    .replace(/[Φφ]\s*(\d+(?:\.\d+)?)(?:mm)?/giu, 'φ$1')
    .replace(/DN\s*(\d+)/giu, 'dn$1')
    .replace(/D\s*(\d+)(?=\b|[^a-z0-9])/giu, 'd$1')
    .replace(/\b(KN|MPA|KPA|KW|MW|KV|HZ|DN)\b/giu, item => item.toLowerCase())
    .replace(/[，,、。；;：:|｜()（）【】\]《》<>"“”'‘’[]/gu, '');
}

export function normalizeEngineeringTextForFactMatch(value: string) {
  return normalizeEngineeringMeasure(value).toLowerCase();
}

export function extractEngineeringMeasureTokens(value: string) {
  const normalized = normalizeEngineeringTextForFactMatch(value);
  const tokens = new Set<string>();
  for (const match of normalized.matchAll(/\d+(?:\.\d+)?(?:m2|hm2|亩|m3|l|ml|mm|cm|km|m|kg|g|t|万元|亿元|元|天|工作天|月|年|h|min|%|permille|mpa|kpa|pa|kn|n|kn\/m2|kn\/m|kw|mw|w|kv|v|ma|a|hz|℃|台|套|件|个|根|只|组|项|处|座|栋|层|间|批|次|人|工日|人日)?|dn\d+|φ\d+(?:\.\d+)?|d\d+|c\d{2,}|hrb\d+|q\d{3}[a-z]?|m\d+|\d+(?:\.\d+)?x\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?|[+-]?\d+\.\d{3}|\d+[:/]\d+/giu)) tokens.add(match[0]);
  return [...tokens];
}
