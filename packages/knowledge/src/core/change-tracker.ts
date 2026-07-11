import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import type { FileClassifier } from '../classification/classifier.js';
import type { DiffResult } from '../types.js';
import type { DiskFileStat } from './file-scanner.js';
import type { IndexStateStore } from './index-state-store.js';

/** 文件变更追踪器，用于比对磁盘文件与索引状态之间的差异 */
export class ChangeTracker {
  constructor(private readonly store: IndexStateStore) {}

  /**
   * 计算磁盘文件与索引状态之间的差异
   * @param diskFiles 磁盘上的文件列表
   * @param classifier 文件分类器
   * @param kbPath 知识库路径
   * @returns 文件差异对比结果
   */
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
      const extraction = metadata.extraction && typeof metadata.extraction === 'object' ? metadata.extraction as Record<string, unknown> : {};
      const contentCoverage = metadata.contentCoverage ?? extraction.contentCoverage;
      const extractionMode = metadata.extractionMode ?? extraction.extractionMode;
      const needsReindex = indexed.status === 'error'
        || indexed.chunkCount === 0
        || (classified.format === 'pdf' && indexed.chunkCount <= 1)
        || contentCoverage === 'metadata_filename'
        || extractionMode === 'pdf_metadata_only';
      if (needsReindex) {
        modifiedFiles.push(classified);
        continue;
      }

      if (Math.round(diskStat.mtime) !== Math.round(indexed.mtime) || diskStat.size !== indexed.fileSize) {
        const contentHash = await this.hashFile(absolutePath);
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

  /**
   * 计算文件的 SHA-256 哈希值
   * @param filePath 文件路径
   * @returns SHA-256 哈希字符串
   */
  async hashFile(filePath: string): Promise<string> {
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return hash.digest('hex');
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
