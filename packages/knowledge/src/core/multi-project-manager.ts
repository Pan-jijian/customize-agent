import * as os from 'node:os';
import * as path from 'node:path';
import { USER_DATA_DIR } from '../constants.js';
import type { FederatedResult, RetrievalWeights, SearchFilters, SearchScope } from '../search/federation-search.js';
import { FederationSearch } from '../search/federation-search.js';
import type { CrossProjectDuplicate, ProjectInfo } from '../types.js';
import { KnowledgeBaseManager } from './knowledge-base-manager.js';
import { computeProjectId } from './project-id.js';
import { getProjectKbPath, ProjectConfigManager } from './project-config.js';
import { ProjectRegistry } from './project-registry.js';
import type { LLMSearchProvider } from '../llm/llm-search-provider.js';

/** 多项目管理器，管理多个项目的知识库并支持跨项目搜索 */
export class MultiProjectManager {
  private readonly storageRoot: string;
  private readonly llmProvider?: LLMSearchProvider;
  private readonly registry: ProjectRegistry;
  private readonly configManager: ProjectConfigManager;
  private readonly projects = new Map<string, KnowledgeBaseManager>();
  private globalKB?: KnowledgeBaseManager;

  constructor(storageRoot = path.join(os.homedir(), USER_DATA_DIR), llmProvider?: LLMSearchProvider) {
    this.storageRoot = storageRoot;
    this.llmProvider = llmProvider;
    this.registry = new ProjectRegistry(path.join(storageRoot, 'projects', 'registry.db'));
    this.configManager = new ProjectConfigManager(storageRoot);
  }

  /**
   * 获取或创建指定项目的知识库管理器
   * @param projectRoot 项目根目录
   */
  async getProject(projectRoot: string): Promise<KnowledgeBaseManager> {
    const resolvedRoot = path.resolve(projectRoot);
    const projectId = computeProjectId(resolvedRoot);
    const existing = this.projects.get(projectId);
    if (existing) return existing;

    const config = this.configManager.loadOrCreate(resolvedRoot);
    const manager = new KnowledgeBaseManager({
      scope: 'project',
      projectRoot: resolvedRoot,
      projectId,
      kbPath: getProjectKbPath(resolvedRoot, this.storageRoot),
      storageRoot: this.storageRoot,
      llmProvider: this.llmProvider,
    });

    manager.initialize();

    this.projects.set(projectId, manager);
    this.updateRegistry(manager, resolvedRoot, config.projectName, config.lastOpenedAt);
    return manager;
  }

  /**
   * 获取或初始化全局知识库
   */
  async getGlobalKB(): Promise<KnowledgeBaseManager> {
    if (this.globalKB) return this.globalKB;

    const manager = new KnowledgeBaseManager({ scope: 'global', storageRoot: this.storageRoot, llmProvider: this.llmProvider });
    manager.initialize();
    this.globalKB = manager;
    return manager;
  }

  async listProjects(): Promise<ProjectInfo[]> {
    return this.registry.list();
  }

  async search(projectRoot: string, query: string, options: { limit?: number; scope?: SearchScope; filters?: SearchFilters; weights?: RetrievalWeights; generationMode?: boolean; disableReranker?: boolean } = {}): Promise<FederatedResult> {
    const limit = Number.isFinite(options.limit) && options.limit! > 0 ? Math.ceil(options.limit!) : undefined;
    const scope = options.scope ?? 'project';
    const project = await this.getProject(projectRoot);

    if (scope === 'project') return project.hybridSearch(query, { limit, filters: options.filters, weights: options.weights, generationMode: options.generationMode, disableReranker: options.disableReranker });

    const projectResults = scope === 'all'
      ? await project.hybridSearch(query, { limit, filters: options.filters, weights: options.weights, generationMode: options.generationMode, disableReranker: options.disableReranker })
      : { results: [], scopesSearched: [], queryTimeMs: 0 } as FederatedResult;

    if (scope === 'global') {
      const global = await this.getGlobalKB();
      return global.hybridSearch(query, { limit, filters: options.filters, weights: options.weights, generationMode: options.generationMode, disableReranker: options.disableReranker });
    }

    const global = await this.getGlobalKB();
    const globalResults = await global.hybridSearch(query, { limit, filters: options.filters, weights: options.weights, generationMode: options.generationMode, disableReranker: options.disableReranker });
    const mergeLimit = limit ?? (projectResults.results.length + globalResults.results.length);
    const merged = new FederationSearch().merge([...projectResults.results, ...globalResults.results], mergeLimit, 'all');
    return {
      ...merged,
      debug: this.mergeDebug(projectResults.debug, globalResults.debug),
    };
  }

  async semanticSearch(projectRoot: string, query: string, options: { limit?: number; scope?: SearchScope; filters?: SearchFilters; collections?: string[] } = {}): Promise<FederatedResult> {
    const scope = options.scope ?? 'project';
    const project = await this.getProject(projectRoot);
    if (scope === 'project') {
      return project.semanticSearch(query, options);
    }

    const projectResults = scope === 'all'
      ? await project.semanticSearch(query, options)
      : { results: [], scopesSearched: [], queryTimeMs: 0 } as FederatedResult;

    if (scope === 'global') {
      const global = await this.getGlobalKB();
      return global.semanticSearch(query, options);
    }

    const global = await this.getGlobalKB();
    const globalResults = await global.semanticSearch(query, options);
    const mergeLimit = Number.isFinite(options.limit) && options.limit! > 0 ? Math.ceil(options.limit!) : projectResults.results.length + globalResults.results.length;
    return new FederationSearch().merge([...projectResults.results, ...globalResults.results], mergeLimit, 'all');
  }

  async findCrossProjectDuplicates(): Promise<CrossProjectDuplicate[]> {
    const projects = this.registry.list();
    const byHash = new Map<string, CrossProjectDuplicate>();

    for (const project of projects) {
      const manager = this.projects.get(project.projectId) ?? new KnowledgeBaseManager({
        scope: 'project',
        projectRoot: project.projectRoot,
        projectId: project.projectId,
        kbPath: getProjectKbPath(project.projectRoot, this.storageRoot),
        storageRoot: this.storageRoot,
        llmProvider: this.llmProvider,
      });

      for (const item of manager.store.listContentHashes()) {
        const duplicate = byHash.get(item.contentHash) ?? { contentHash: item.contentHash, files: [] };
        duplicate.files.push({
          projectId: project.projectId,
          projectRoot: project.projectRoot,
          relativePath: item.relativePath,
        });
        byHash.set(item.contentHash, duplicate);
      }

      if (!this.projects.has(project.projectId)) manager.close();
    }

    return [...byHash.values()].filter(item => item.files.length > 1);
  }

  async forgetProject(projectId: string): Promise<void> {
    const manager = this.projects.get(projectId);
    if (manager) {
      manager.close();
      this.projects.delete(projectId);
    }
    this.registry.forget(projectId);
  }

  async closeProject(projectId: string): Promise<void> {
    const manager = this.projects.get(projectId);
    if (!manager) return;
    manager.close();
    this.projects.delete(projectId);
  }

  async shutdown(): Promise<void> {
    for (const manager of this.projects.values()) {
      manager.close();
    }
    this.projects.clear();
    this.globalKB?.close();
    this.globalKB = undefined;
    this.registry.close();
  }


  private mergeDebug(projectDebug: FederatedResult['debug'], globalDebug: FederatedResult['debug']): FederatedResult['debug'] {
    if (!projectDebug && !globalDebug) return undefined;
    return {
      originalQuery: projectDebug?.originalQuery ?? globalDebug?.originalQuery,
      rewrittenQueries: [...new Set([...(projectDebug?.rewrittenQueries ?? []), ...(globalDebug?.rewrittenQueries ?? [])])],
      weights: projectDebug?.weights ?? globalDebug?.weights,
      recallCounts: {
        keyword: (projectDebug?.recallCounts?.keyword ?? 0) + (globalDebug?.recallCounts?.keyword ?? 0),
        vector: (projectDebug?.recallCounts?.vector ?? 0) + (globalDebug?.recallCounts?.vector ?? 0),
        merged: (projectDebug?.recallCounts?.merged ?? 0) + (globalDebug?.recallCounts?.merged ?? 0),
      },
      reranker: projectDebug?.reranker ?? globalDebug?.reranker,
    };
  }

  private updateRegistry(manager: KnowledgeBaseManager, projectRoot: string, projectName: string | undefined, lastOpenedAt: number): void {
    const stats = manager.getStats();
    if (!manager.projectId) throw new Error('project manager missing projectId');

    this.registry.upsert({
      projectId: manager.projectId,
      projectRoot,
      projectName,
      kbPath: manager.kbPath,
      fileCount: stats.fileCount,
      chunkCount: stats.chunkCount,
      totalSizeBytes: stats.totalSizeBytes,
      lastIndexedAt: stats.lastIndexedAt,
      lastOpenedAt,
      status: 'active',
    });
  }
}
