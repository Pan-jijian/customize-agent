import * as path from 'node:path';
import type { ClassifiedFile, IndexStateRecord } from '../types.js';
import type { FileRelationship } from '../core/index-state-store.js';

export class RelationshipDetector {
  detect(file: ClassifiedFile, indexedRecords: IndexStateRecord[]): Array<Omit<FileRelationship, 'id' | 'createdAt'>> {
    const relationships: Array<Omit<FileRelationship, 'id' | 'createdAt'>> = [];

    for (const record of indexedRecords) {
      if (record.relativePath === file.relativePath) continue;

      const version = this.detectVersionChain(file.relativePath, record.relativePath);
      if (version) relationships.push(version);

      const translation = this.detectTranslation(file.relativePath, record.relativePath);
      if (translation) relationships.push(translation);

      const complementary = this.detectSameDirectoryComplement(file, record);
      if (complementary) relationships.push(complementary);
    }

    return relationships;
  }

  private detectVersionChain(source: string, target: string): Omit<FileRelationship, 'id' | 'createdAt'> | undefined {
    const sourceVersion = this.parseVersion(source);
    const targetVersion = this.parseVersion(target);
    if (!sourceVersion || !targetVersion) return undefined;
    if (sourceVersion.base !== targetVersion.base) return undefined;

    return {
      sourceFile: source,
      targetFile: target,
      relationshipType: 'version_chain',
      confidence: 0.9,
      detail: `版本链: v${targetVersion.version} → v${sourceVersion.version}`,
      userConfirmed: 0,
    };
  }

  private detectTranslation(source: string, target: string): Omit<FileRelationship, 'id' | 'createdAt'> | undefined {
    const sourceLang = this.parseLanguageSuffix(source);
    const targetLang = this.parseLanguageSuffix(target);
    if (!sourceLang || !targetLang) return undefined;
    if (sourceLang.base !== targetLang.base || sourceLang.lang === targetLang.lang) return undefined;

    return {
      sourceFile: source,
      targetFile: target,
      relationshipType: 'translation',
      confidence: 0.85,
      detail: `语言版本: ${targetLang.lang} ↔ ${sourceLang.lang}`,
      userConfirmed: 0,
    };
  }

  private detectSameDirectoryComplement(file: ClassifiedFile, record: IndexStateRecord): Omit<FileRelationship, 'id' | 'createdAt'> | undefined {
    if (path.dirname(file.relativePath) !== path.dirname(record.relativePath)) return undefined;
    if (file.category !== record.category) return undefined;

    const max = Math.max(file.fileSize, record.fileSize);
    const min = Math.min(file.fileSize, record.fileSize);
    if (max === 0 || min / max < 0.6) return undefined;

    return {
      sourceFile: file.relativePath,
      targetFile: record.relativePath,
      relationshipType: 'complementary',
      confidence: 0.45,
      detail: '同目录、同类型且文件大小相近',
      userConfirmed: 0,
    };
  }

  private parseVersion(filePath: string): { base: string; version: number } | undefined {
    const parsed = path.parse(filePath);
    const match = parsed.name.match(/^(.*?)(?:[_-]?v)(\d+)$/iu);
    if (!match?.[1] || !match[2]) return undefined;
    return { base: path.join(parsed.dir, match[1]).toLowerCase(), version: Number(match[2]) };
  }

  private parseLanguageSuffix(filePath: string): { base: string; lang: string } | undefined {
    const parsed = path.parse(filePath);
    const match = parsed.name.match(/^(.*?)[_-](cn|zh|en)$/iu);
    if (!match?.[1] || !match[2]) return undefined;
    return { base: path.join(parsed.dir, match[1]).toLowerCase(), lang: match[2].toLowerCase() };
  }
}
