import { ALL_CATEGORIES } from '../constants.js';
import { globalCollectionName, projectCollectionName } from '../vector/collection-manager.js';
import type { VectorSearchResult, VectorStoreInterface } from '../vector/types.js';

export type SearchScope = 'project' | 'global' | 'all';

export interface FederatedSearchItem {
  id: string;
  content: string;
  filePath: string;
  scope: 'project' | 'global';
  collection: string;
  score: number;
  contentHash?: string;
  chunkIndex?: number;
  parentId?: string;
  source?: 'keyword' | 'vector' | 'hybrid';
  sectionTitle?: string;
  rowRange?: string;
  chunkKind?: string;
  scoreDetails?: {
    keywordScore?: number;
    bm25Score?: number;
    vectorScore?: number;
    hybridScore?: number;
    exactPhraseBoost?: number;
    rerankBoost?: number;
    llmRelevanceScore?: number;
  };
  facets?: Record<string, string | number | string[]>;
}

export interface FederatedResult {
  results: FederatedSearchItem[];
  scopesSearched: Array<'project' | 'global'>;
  queryTimeMs: number;
  debug?: {
    originalQuery?: string;
    rewrittenQueries?: string[];
    weights?: Record<string, number>;
    recallCounts?: Record<string, number>;
    reranker?: string;
  };
}

export interface SearchFilters {
  category?: string;
  filePath?: string;
}

export interface RetrievalWeights {
  keyword?: number;
  vector?: number;
  rewrite?: number;
  hybridBonus?: number;
}

export interface FederatedQuery {
  query: string;
  queryEmbedding: number[];
  topK: number;
  scope: SearchScope;
  projectId?: string;
  collections?: string[];
  filters?: SearchFilters;
}

export class FederationSearch {
  static readonly SCOPE_WEIGHTS: Record<'project' | 'global', number> = {
    project: 1.0,
    global: 0.7,
  };

  constructor(private readonly vectorStores = new Map<string, VectorStoreInterface>()) {}

  async search(query: FederatedQuery): Promise<FederatedResult> {
    const start = Date.now();
    const collectionNames = this.resolveCollectionsForQuery(query);
    const where = this.buildFilter(query.filters);
    const perCollection = await Promise.all(collectionNames.map(async collectionName => {
      const store = this.vectorStores.get(collectionName);
      if (!store) return [];

      const results = await store.search({
        queryEmbedding: query.queryEmbedding,
        topK: query.topK * 3,
        where,
      });
      const scope = collectionName.startsWith('proj_') ? 'project' as const : 'global' as const;
      return results.map(result => this.toFederatedItem(result, scope));
    }));

    const merged = this.merge(perCollection.flat(), query.topK, query.scope);
    return { ...merged, queryTimeMs: Date.now() - start };
  }

  merge(results: FederatedSearchItem[], topK: number, scope: SearchScope = 'all'): FederatedResult {
    const start = Date.now();
    const allowedScopes = this.resolveScopes(scope);
    const weighted = results
      .filter(result => allowedScopes.includes(result.scope))
      .map(result => ({
        ...result,
        score: result.score * FederationSearch.SCOPE_WEIGHTS[result.scope],
      }));

    const deduped = this.crossScopeDedup(weighted);
    return {
      results: deduped.sort((a, b) => b.score - a.score).slice(0, topK),
      scopesSearched: allowedScopes,
      queryTimeMs: Date.now() - start,
    };
  }

  private resolveCollectionsForQuery(query: FederatedQuery): string[] {
    const names: string[] = [];

    if (query.scope === 'project' || query.scope === 'all') {
      if (!query.projectId) throw new Error('project scope requires projectId');
      for (const category of ALL_CATEGORIES) {
        names.push(projectCollectionName(query.projectId, category));
      }
    }

    if (query.scope === 'global' || query.scope === 'all') {
      for (const category of ALL_CATEGORIES) {
        names.push(globalCollectionName(category));
      }
    }

    return query.collections ? names.filter(name => query.collections?.includes(name)) : names;
  }

  private buildFilter(filters?: SearchFilters): Record<string, string | number | boolean> | undefined {
    if (!filters) return undefined;
    const where: Record<string, string | number | boolean> = {};
    if (filters.category) where.category = filters.category;
    if (filters.filePath) where.file_path = filters.filePath;
    return Object.keys(where).length > 0 ? where : undefined;
  }

  private toFederatedItem(result: VectorSearchResult, scope: 'project' | 'global'): FederatedSearchItem {
    return {
      id: result.document.id,
      content: result.document.content,
      filePath: String(result.document.metadata.file_path ?? ''),
      scope,
      collection: result.collection,
      score: result.score,
      contentHash: typeof result.document.metadata.content_hash === 'string' ? result.document.metadata.content_hash : undefined,
      chunkIndex: typeof result.document.metadata.chunk_index === 'number' ? result.document.metadata.chunk_index : undefined,
      parentId: typeof result.document.metadata.parent_id === 'string' ? result.document.metadata.parent_id : undefined,
      source: 'vector',
      sectionTitle: typeof result.document.metadata.section_title === 'string' ? result.document.metadata.section_title : undefined,
      rowRange: typeof result.document.metadata.row_range === 'string' ? result.document.metadata.row_range : undefined,
      chunkKind: typeof result.document.metadata.chunk_kind === 'string' ? result.document.metadata.chunk_kind : undefined,
      scoreDetails: { vectorScore: result.score },
    };
  }

  private resolveScopes(scope: SearchScope): Array<'project' | 'global'> {
    if (scope === 'project') return ['project'];
    if (scope === 'global') return ['global'];
    return ['project', 'global'];
  }

  private crossScopeDedup(results: FederatedSearchItem[]): FederatedSearchItem[] {
    const byKey = new Map<string, FederatedSearchItem>();
    for (const result of results) {
      const key = result.contentHash ?? `${result.filePath}#${result.parentId ?? result.chunkIndex ?? result.id}`;
      const existing = byKey.get(key);
      if (!existing || (existing.scope === 'global' && result.scope === 'project')) {
        byKey.set(key, result);
      }
    }
    return [...byKey.values()];
  }
}
