import fs from 'node:fs';
import { describe, it } from 'vitest';
import { AUXILIARY_DETECTORS, FULL_VALIDATION_DETECTORS, STANDARD_FINAL_DETECTORS } from '@/services/document-workflow/detectorFixerRegistry';

const SRC_ROOT = '/Users/pan/Desktop/codeing/customize-agent/apps/server/src';
const USED = new Set(fs.readFileSync('/tmp/used_ids.txt', 'utf8').split('\n').map(s => s.trim()).filter(Boolean));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('registration vs call site', () => {
  it('lists declared detectors without det() call sites', () => {
    for (const [group, entries] of [['full-validation', FULL_VALIDATION_DETECTORS], ['standard-final', STANDARD_FINAL_DETECTORS], ['auxiliary', AUXILIARY_DETECTORS]] as const) {
      const missing = entries.filter(e => !USED.has(e.id)).map(e => `${e.id}(${e.fixerDisposition ?? '-'})`);
      console.log(`[${group}] declared=${entries.length} missing=${missing.length}: ${missing.join(', ')}`);
    }
    const files = walk(SRC_ROOT);
    console.log('source files scanned:', files.length);
  });
});
