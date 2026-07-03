import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileClassifier } from '../classification/classifier.js';
import type { DiffResult } from '../types.js';
import type { DiskFileStat } from './file-scanner.js';
import type { IndexStateStore } from './index-state-store.js';

export class ChangeTracker {
  constructor(private readonly store: IndexStateStore) {}

  async computeDiff(
    diskFiles: Map<string, DiskFileStat>,
    classifier: FileClassifier,
    kbPath: string,
  ): Promise<DiffResult> {
    const startTime = Date.now();
    const indexedFiles = this.store.loadActiveRecords();
    const newFiles: DiffResult['newFiles'] = [];
    const modifiedFiles: DiffResult['modifiedFiles'] = [];
    const deletedFiles: DiffResult['deletedFiles'] = [];
    const skippedFiles: DiffResult['skippedFiles'] = [];
    let unchangedCount = 0;
    let mtimeOnlyCount = 0;

    for (const [relativePath, diskStat] of diskFiles) {
      const absolutePath = path.join(kbPath, relativePath);
      const stat = fs.statSync(absolutePath);
      const classified = classifier.classify(absolutePath, relativePath, stat);
      const skipReason = classifier.shouldSkip(classified);
      if (skipReason) {
        skippedFiles.push({ file: classified, reason: skipReason });
        continue;
      }

      const indexed = indexedFiles.get(relativePath);
      if (!indexed) {
        newFiles.push(classified);
        continue;
      }

      const metadata = this.parseMetadata(indexed.metadataJson);
      const needsReindex = indexed.status === 'error'
        || indexed.chunkCount === 0
        || (classified.format === 'pdf' && indexed.chunkCount <= 1)
        || metadata.contentCoverage === 'metadata_filename'
        || metadata.extractionMode === 'pdf_metadata_only';
      if (needsReindex) {
        modifiedFiles.push(classified);
        continue;
      }

      if (Math.round(diskStat.mtime) !== Math.round(indexed.mtime) || diskStat.size !== indexed.fileSize) {
        const contentHash = this.hashFile(absolutePath);
        if (contentHash !== indexed.contentHash) {
          modifiedFiles.push(classified);
        } else {
          mtimeOnlyCount += 1;
          this.store.updateVerified(relativePath, diskStat.mtime);
        }
      } else {
        unchangedCount += 1;
        this.store.updateVerified(relativePath, diskStat.mtime);
      }
    }

    for (const [relativePath, record] of indexedFiles) {
      if (!diskFiles.has(relativePath)) deletedFiles.push(record);
    }

    const hasChanges = newFiles.length > 0 || modifiedFiles.length > 0 || deletedFiles.length > 0;
    return {
      newFiles,
      modifiedFiles,
      deletedFiles,
      unchangedCount,
      mtimeOnlyCount,
      skippedFiles,
      hasChanges,
      diffTimeMs: Date.now() - startTime,
    };
  }

  hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  private parseMetadata(metadataJson?: string | null): Record<string, unknown> {
    if (!metadataJson) return {};
    try {
      const parsed = JSON.parse(metadataJson);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
}
