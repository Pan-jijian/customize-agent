import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GeneratedDocumentDraft } from './documentWorkflowService';

export interface StoredDocumentDraft extends GeneratedDocumentDraft {
  id: string;
  updatedAt: number;
}

function storeDir() {
  const dir = path.join(os.homedir(), '.customize-agent', 'documents');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function draftPath(id: string) {
  return path.join(storeDir(), `${id}.json`);
}

function safeId(input?: string) {
  return (input || `draft-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/gu, '-').slice(0, 80);
}

export function saveDocumentDraft(draft: GeneratedDocumentDraft, id?: string): StoredDocumentDraft {
  const stored: StoredDocumentDraft = { ...draft, id: safeId(id), updatedAt: Date.now() };
  fs.writeFileSync(draftPath(stored.id), JSON.stringify(stored, null, 2), 'utf-8');
  return stored;
}

export function listDocumentDrafts(): StoredDocumentDraft[] {
  return fs.readdirSync(storeDir())
    .filter(file => file.endsWith('.json'))
    .map(file => {
      try { return JSON.parse(fs.readFileSync(path.join(storeDir(), file), 'utf-8')) as StoredDocumentDraft; } catch { return undefined; }
    })
    .filter((item): item is StoredDocumentDraft => !!item)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getDocumentDraft(id: string): StoredDocumentDraft | undefined {
  const file = draftPath(safeId(id));
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredDocumentDraft;
}
