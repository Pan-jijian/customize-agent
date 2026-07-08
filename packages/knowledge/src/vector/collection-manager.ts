import { ALL_CATEGORIES, COLLECTION_CATEGORY_NAMES } from '../constants.js';
import type { FileCategory } from '../types.js';
import type { CollectionClient } from './types.js';

/** 生成项目级 Collection 名称 */
export function projectCollectionName(projectId: string, category: FileCategory): string {
  return `proj_${projectId}_kb_${COLLECTION_CATEGORY_NAMES[category]}`;
}

/** 生成全局 Collection 名称 */
export function globalCollectionName(category: FileCategory): string {
  return `global_kb_${COLLECTION_CATEGORY_NAMES[category]}`;
}

/** Collection 管理器，负责 Vector Collection 的创建和管理 */
export class CollectionManager {
  constructor(private readonly client?: CollectionClient) {}

  async ensureProjectCollections(projectId: string): Promise<void> {
    if (!this.client) return;
    for (const category of ALL_CATEGORIES) {
      await this.client.getOrCreateCollection(projectCollectionName(projectId, category), {
        'hnsw:space': 'cosine',
        project_id: projectId,
        category,
      });
    }
  }

  async ensureGlobalCollections(): Promise<void> {
    if (!this.client) return;
    for (const category of ALL_CATEGORIES) {
      await this.client.getOrCreateCollection(globalCollectionName(category), {
        'hnsw:space': 'cosine',
        scope: 'global',
        category,
      });
    }
  }

  async deleteProjectCollections(projectId: string): Promise<number> {
    if (!this.client) return 0;
    const prefix = `proj_${projectId}_`;
    const collections = await this.client.listCollections();
    let deleted = 0;
    for (const collection of collections) {
      if (collection.name.startsWith(prefix)) {
        await this.client.deleteCollection(collection.name);
        deleted += 1;
      }
    }
    return deleted;
  }

  async listProjectsFromClient(): Promise<string[]> {
    if (!this.client) return [];
    const collections = await this.client.listCollections();
    return this.listProjectsFromCollectionNames(collections.map(collection => collection.name));
  }

  getProjectCollections(projectId: string): string[] {
    return ALL_CATEGORIES.map(category => projectCollectionName(projectId, category));
  }

  getGlobalCollections(): string[] {
    return ALL_CATEGORIES.map(category => globalCollectionName(category));
  }

  getCollectionName(scope: 'project' | 'global', category: FileCategory, projectId?: string): string {
    if (scope === 'global') return globalCollectionName(category);
    if (!projectId) throw new Error('project scope requires projectId');
    return projectCollectionName(projectId, category);
  }

  listProjectsFromCollectionNames(collectionNames: string[]): string[] {
    const projectIds = new Set<string>();
    for (const name of collectionNames) {
      const match = name.match(/^proj_([a-f0-9]{12})_kb_/);
      if (match?.[1]) projectIds.add(match[1]);
    }
    return [...projectIds];
  }
}
