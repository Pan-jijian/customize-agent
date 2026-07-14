import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DocumentTemplate } from './documentWorkflowService';
import type { DocumentRole, ProjectRoleConfig } from './documentRoleService';

export interface QualityBenchmarkRule {
  id: string;
  name: string;
  weight: number;
  level?: 'error' | 'warning' | 'info';
  minCount?: number;
  minRatio?: number;
  keywords?: string[];
  titlePatterns?: string[];
  tableRequired?: boolean;
  suggestion?: string;
}

export interface QualityBenchmarkConfig {
  id: string;
  name: string;
  templateMatchers: string[];
  passScore: number;
  blockBelowScore: number;
  rules: QualityBenchmarkRule[];
}

export interface TechnicalDetailGateConfig {
  templateMatchers: string[];
  minTechnicalFactUsageRate: number;
  minMethodParameterCount: number;
  minQuantitativeFactCount: number;
  minStandardCount: number;
  minProcessActionCount: number;
  minInspectionActionCount: number;
  maxGenericPhraseCountPer1800Chars: number;
  minAssignedFactCountForBlocking: number;
  genericPhrases: string[];
}

export interface AutoSpecGateConfig {
  templateMatchers: string[];
  requiredFacts: string[];
  requiredTexts: string[];
  forbiddenTexts: string[];
  minTables?: number;
}

export interface ChapterTitleFilterConfig {
  templateMatchers: string[];
  forbiddenPatterns: string[];
  requiredPatterns: string[];
  minLength?: number;
  maxLength?: number;
}

export interface ReviewChapterSectionDefaults {
  firstChapterSections: string[];
  chapterSections: string[];
  firstChapterTableSections: string[];
  firstChapterTableRequirements: string[];
}

export interface EngineeringDocumentConfig {
  reviewStandardQueries: string[];
  reviewChapterTemplateMatchers: string[];
  reviewChapterSectionDefaults: ReviewChapterSectionDefaults;
  templates: DocumentTemplate[];
  roles: DocumentRole[];
  roleConfigs: ProjectRoleConfig[];
  qualityBenchmarks: QualityBenchmarkConfig[];
  technicalDetailGate?: TechnicalDetailGateConfig;
  autoSpecGates: AutoSpecGateConfig[];
  chapterTitleFilters: ChapterTitleFilterConfig[];
}

const DEFAULT_REVIEW_CHAPTER_SECTION_DEFAULTS: ReviewChapterSectionDefaults = {
  firstChapterSections: [],
  chapterSections: [],
  firstChapterTableSections: [],
  firstChapterTableRequirements: [],
};

const DEFAULT_CONFIG: EngineeringDocumentConfig = {
  reviewStandardQueries: [],
  reviewChapterTemplateMatchers: [],
  reviewChapterSectionDefaults: DEFAULT_REVIEW_CHAPTER_SECTION_DEFAULTS,
  templates: [],
  roles: [],
  roleConfigs: [],
  qualityBenchmarks: [],
  autoSpecGates: [],
  chapterTitleFilters: [],
};

function configPath() {
  const dir = path.join(os.homedir(), '.customize-agent');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'engineering-document-config.json');
}

function normalizeConfig(config: Partial<EngineeringDocumentConfig>): EngineeringDocumentConfig {
  return {
    reviewStandardQueries: Array.isArray(config.reviewStandardQueries) ? config.reviewStandardQueries.filter(Boolean) : [],
    reviewChapterTemplateMatchers: Array.isArray(config.reviewChapterTemplateMatchers) ? config.reviewChapterTemplateMatchers.filter(Boolean) : [],
    reviewChapterSectionDefaults: {
      firstChapterSections: Array.isArray(config.reviewChapterSectionDefaults?.firstChapterSections) ? config.reviewChapterSectionDefaults.firstChapterSections.filter(Boolean) : [],
      chapterSections: Array.isArray(config.reviewChapterSectionDefaults?.chapterSections) ? config.reviewChapterSectionDefaults.chapterSections.filter(Boolean) : [],
      firstChapterTableSections: Array.isArray(config.reviewChapterSectionDefaults?.firstChapterTableSections) ? config.reviewChapterSectionDefaults.firstChapterTableSections.filter(Boolean) : [],
      firstChapterTableRequirements: Array.isArray(config.reviewChapterSectionDefaults?.firstChapterTableRequirements) ? config.reviewChapterSectionDefaults.firstChapterTableRequirements.filter(Boolean) : [],
    },
    templates: Array.isArray(config.templates) ? config.templates : [],
    roles: Array.isArray(config.roles) ? config.roles : [],
    roleConfigs: Array.isArray(config.roleConfigs) ? config.roleConfigs : [],
    qualityBenchmarks: Array.isArray(config.qualityBenchmarks) ? config.qualityBenchmarks : [],
    technicalDetailGate: config.technicalDetailGate,
    autoSpecGates: Array.isArray(config.autoSpecGates) ? config.autoSpecGates : [],
    chapterTitleFilters: Array.isArray(config.chapterTitleFilters) ? config.chapterTitleFilters : [],
  };
}

export function readEngineeringDocumentConfig(): EngineeringDocumentConfig {
  try {
    const file = configPath();
    if (!fs.existsSync(file)) return DEFAULT_CONFIG;
    return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<EngineeringDocumentConfig>);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeEngineeringDocumentConfig(config: EngineeringDocumentConfig) {
  fs.writeFileSync(configPath(), JSON.stringify(normalizeConfig(config), null, 2), 'utf-8');
}
