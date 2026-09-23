import { describe, expect, it } from 'vitest';
import { MEASURE_UNIT_ALTERNATION, collapseObjectWindowEnd, collapseObjectWindowStart, findTruncationSource, hasTruncatedBracketFragment } from '@/services/document-workflow/factValueNoise';

const TOKEN_RE = new RegExp(String.raw`([一-龥A-Za-z0-9（）()]{1,12}?)(\d+(?:\.\d+)?)\s*(${MEASURE_UNIT_ALTERNATION})([一-龥A-Za-z0-9（）()]{0,8})`, 'gu');

const SAMPLES = [
  '粗粒式沥青混凝土(AC-25C)6cm厚与细粒式改性沥青混凝土面层(AC-13C)4cm厚各13898.51m²',
  '粗粒式沥青混凝土(AC-25C)6cm与细粒式改性沥青混凝土AC-13C)4cm',
  '基层6cm与面层(AC-13C)4cm)',
  '上面层（AC-13C）4cm与AC-25C)6cm厚',
  '基层厚6cm，面层AC-13C)4cm',
];

describe('probe window', () => {
  it('windows', () => {
    for (const line of SAMPLES) {
      for (const match of line.matchAll(new RegExp(TOKEN_RE.source, 'gu'))) {
        const matchStart = match.index || 0;
        const windowStart = collapseObjectWindowStart(line, matchStart);
        const objectWindow = line.slice(windowStart, collapseObjectWindowEnd(line, matchStart + match[0].length, windowStart));
        const fragment = hasTruncatedBracketFragment(objectWindow);
        console.log(JSON.stringify(match[0]), '=>', JSON.stringify(objectWindow), fragment ? `FRAGMENT source=${JSON.stringify(findTruncationSource(line, objectWindow))}` : '');
      }
    }
    expect(true).toBe(true);
  });
});
