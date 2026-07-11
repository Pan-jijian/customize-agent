import type { NextApiRequest, NextApiResponse } from 'next';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';

type RegistryRow = Record<string, unknown>;

const agentHome = path.join(os.homedir(), '.customize-agent');
const registryPath = path.join(agentHome, 'projects', 'registry.db');
const promptConfigPath = path.join(agentHome, 'prompts.json');

/** 规范化路径为绝对路径 */
function normalizePath(value: string): string {
  return path.resolve(value);
}

/** 判断项目根目录是否为内部残留项目（非用户项目，应隐藏） */
function isInternalResidualProject(projectRoot: string): boolean {
  const normalized = normalizePath(projectRoot);
  const homeConfig = normalizePath(path.join(os.homedir(), '.customize-agent'));
  const parts = normalized.split(path.sep);
  if (normalized === path.resolve(path.join(os.homedir(), '.customize-agent', 'demo-project'))) return false;
  return normalized === homeConfig
    || normalized.endsWith(`${path.sep}apps${path.sep}server`)
    || normalized.endsWith(`${path.sep}apps${path.sep}cli`)
    || parts.includes('.customize-agent');
}

/** 打开项目注册表数据库 */
function openRegistry(readonly: boolean) {
  return fs.existsSync(registryPath) ? new Database(registryPath, { readonly }) : null;
}

/** 获取所有允许访问的项目根目录集合（排除内部残留项目） */
function allowedProjectRoots(): Set<string> {
  const roots = new Set<string>();
  const currentRoot = normalizePath(process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd());
  if (!isInternalResidualProject(currentRoot)) roots.add(currentRoot);
  const db = openRegistry(true);
  if (!db) return roots;
  try {
    const rows = db.prepare('SELECT project_root FROM project_registry').all() as RegistryRow[];
    for (const row of rows) {
      const root = normalizePath(String(row.project_root));
      if (!isInternalResidualProject(root)) roots.add(root);
    }
  } finally {
    db.close();
  }
  return roots;
}

/** 判断文件路径是否为允许访问的 CUSTOMIZE.md 提示词文件 */
function isAllowedPromptFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (path.basename(normalized) !== 'CUSTOMIZE.md') return false;
  return allowedProjectRoots().has(normalizePath(path.dirname(normalized)));
}

/** 从注册表中清理已不再存在的内部残留项目记录 */
function cleanupResidualProjects(projectIds: string[]): void {
  if (projectIds.length === 0) return;
  const db = openRegistry(false);
  if (!db) return;
  try {
    const deleteStmt = db.prepare('DELETE FROM project_registry WHERE project_id = ?');
    for (const projectId of projectIds) deleteStmt.run(projectId);
  } catch (error) {
    void error;
  } finally {
    db.close();
  }
}

interface PromptProject {
  id: string;
  projectId: string;
  projectRoot?: string;
  projectName: string;
  customizePath: string;
  content: string;
  mtime: string;
  hasFile: boolean;
  isCurrent: boolean;
  selected: boolean;
  source: 'current' | 'project' | 'custom';
}

interface PromptImportItem {
  name?: string;
  content?: string;
  selected?: boolean;
}

interface PromptExportFile {
  version: 1;
  exportedAt: string;
  prompts: Array<{ name: string; content: string; selected: boolean }>;
}

/** 内置提示词列表，包含三角洲行动相关的各个角色提示词 */
const BUILT_IN_PROMPTS = [
  { id: 'builtin:delta-fact-extraction', name: '内置｜三角洲事实抽取提示词', content: `你是“结构化事实抽取专家”。请从知识库资料中抽取可追溯事实，并严格服务于文档规范包。

抽取范围：
1. 干员名称、定位、核心价值、技能特点、推荐指数、上手难度、推荐场景。
2. 队伍搭配、地图图纸、图片资源、表格字段、模板案例、样式规则、导出门禁。
3. 每条事实必须保留来源文件、文件角色、处理类型和置信度。

规则：
- 只抽取资料明确支持的内容，不能编造。
- 如果多个来源冲突，要保留冲突来源，不能擅自合并。
- 如果规范包字段指定 sourceRoleIds，优先从对应文件角色中抽取。
- 表格类事实要保留字段含义，不能只输出一句摘要。

输出建议：
- 按字段输出 key/value/sourceFile/roleId/processingType/confidence。
- 对缺失字段给出“缺失原因”和“建议补充资料”。` },
  { id: 'builtin:delta-chapter-generation', name: '内置｜三角洲章节生成提示词', content: `你是“可交付文档章节作者”。请基于结构化事实、资源证据和文档规范包生成章节。

章节写法：
1. 先写本章结论，再写依据，最后给操作建议。
2. 每章至少说明 2 类来源：事实文件、表格、文档附件、图片、地图图纸或模板案例。
3. 表格资源要转成可读 Markdown 表格；地图图纸要说明路线/点位/撤离或交战用途；图片要说明与结论的关系。
4. 章节要适合导出 DOCX/PDF：标题稳定、段落短、列表清晰、来源明确。

禁止：
- 不要硬插固定地图或图片。
- 不要把提示词全文写入正文。
- 不要把“资料未提供”当最终结论。
- 不要用没有证据的确定语气。` },
  { id: 'builtin:delta-resource-evidence', name: '内置｜三角洲资源证据使用提示词', content: `你是“资源证据编排专家”。请把不同文件类型转化成正文可用证据。

文件类型使用方式：
- 文本/Markdown：抽取规则、结论和注意事项。
- PDF/Word：抽取正式说明、附件依据和规范约束。
- CSV/XLS/XLSX：形成表格、排序、对比和推荐优先级。
- 图片：说明对象、视觉用途和章节关系。
- 地图图纸：说明区域、路线、点位、撤离/交战路径和队伍分工。
- 模板案例：学习结构、来源清单和表达方式，不能照抄无关内容。
- 导出门禁：只用于检查，不作为正文事实。

引用资源时必须写明：资源类型、来源文件、正文用途。` },
  { id: 'builtin:delta-template-style', name: '内置｜三角洲模板样式提示词', content: `你是“模板样式设计师”。请把生成结果整理成用户能学习、能复用、能导出的内置模板案例。

样式要求：
1. 开头有短导语：适用对象、使用场景、核心结论。
2. 每章采用“本章结论 / 证据依据 / 操作建议 / 资料来源”。
3. 重要建议使用表格、清单、引用块，不堆长段落。
4. 图片和地图必须有说明文字，不做装饰图。
5. 来源清单要区分规则文件、事实文件、表格、图纸、图片、附件和模板案例。
6. 明确体现文档规范包、文件角色、提示词角色如何共同工作。

导出要求：标题不跳级、表格语法正确、图片 alt 完整、正文无提示词全文。` },
  { id: 'builtin:delta-cover-image-generation', name: '内置｜三角洲封面图生成提示词', content: `你是“封面视觉提示词设计师”。请为三角洲行动热门干员攻略生成适合网站和文档封面的图片提示词。

画面要求：
- 主题：战术小队、热门干员、现代战场、科技感 UI。
- 构图：横版封面，中心主体清晰，留出标题空间。
- 风格：真实感、电影级光影、游戏攻略封面质感。
- 禁止：文字水印、Logo、乱码文字、血腥暴力、低清截图。

输出只给图片生成 prompt，不要把 prompt 写入正式正文。` },
  { id: 'builtin:delta-review-optimization', name: '内置｜三角洲 LLM 审查优化提示词', content: `你是“交付审查专家”。请审查生成文档是否满足规范包、文件角色、提示词角色和导出要求。

审查维度：
1. 事实是否有来源，来源角色是否匹配。
2. 章节是否覆盖规范包必填章节和必填事实。
3. 表格、图片、地图、PDF/Word、附件是否被正确使用。
4. 是否存在冲突事实、缺失事实、无证据结论。
5. 是否包含提示词全文、远程临时图片 URL、内部错误、占位语。
6. 是否适合导出 Markdown/HTML/DOCX/PDF。

处理方式：
- 可修复的问题直接优化正文。
- 不能确定的问题写成“需要复核”，不要阻断生成。
- 输出优化后的 Markdown，并保留来源和复核提示。` },
  { id: 'builtin:delta-validation', name: '内置｜三角洲校验提示词', content: `你是“规范包校验员”。请按文档规范包检查生成文档。

检查项：
- 必填事实：攻略目标、干员名称、定位、核心价值、推荐指数、队伍搭配、地图图纸、模板样式规则、导出门禁。
- 必填章节：目标、干员速览、队伍搭配、推荐优先级、地图路线、模板样式和导出检查。
- 必填角色：事实文件、表格文件、图纸文件、模板案例、样式参考、导出门禁、模板样式提示词。
- 禁止内容：提示词全文、临时生成 URL、内部错误、未处理占位语。

输出 error/warning/info，并给出原因和修复建议。warning 不阻断导出，但必须展示给用户。` },
  { id: 'builtin:delta-export-gate', name: '内置｜三角洲导出门禁提示词', content: `你是“导出门禁审核员”。请从 Markdown、HTML、DOCX、PDF 四种格式检查文档。

门禁维度：
1. 结构完整：封面、目录、章节、表格、图片/地图、来源和复核提示。
2. 事实完整：必填事实有来源，冲突事实有提示。
3. 资源完整：图片路径有效，地图图纸来自知识库，表格语法正确。
4. 格式完整：标题层级稳定，列表缩进正确，图片 alt 文本完整。
5. 安全完整：无提示词全文、无内部错误、无远程临时生成 URL。

注意：门禁用于提示和复核，不应直接禁止用户导出。` },
  { id: 'builtin:delta-formatting', name: '内置｜三角洲格式化提示词', content: `你是“正式文档排版编辑”。请整理生成内容，使其适合网页预览和多格式导出。

排版要求：
- H1 只出现一次；H2 对应章节；H3 用于本章结论、证据依据、操作建议。
- 表格使用标准 Markdown 表格，列数控制合理。
- 图片和地图使用 Markdown 图片语法，并补充说明。
- 来源清单统一放在文末，按文件角色分类。
- 复核提示独立成节，不混入正文结论。
- 删除重复标题、空章节、空列表和无意义占位。

不得改写事实来源，不得删除 warning 复核原因。` },
];

const BUILT_IN_PROMPT_IDS = new Set(BUILT_IN_PROMPTS.map(prompt => prompt.id));

interface PromptConfig {
  selectedIds: string[];
  customPrompts: Array<{ id: string; name: string; content: string; createdAt: string; updatedAt: string }>;
}

function promptIdFromPath(filePath: string): string {
  return `file:${normalizePath(filePath)}`;
}

/** 从磁盘加载提示词配置文件 */
function loadPromptConfig(): PromptConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(promptConfigPath, 'utf-8')) as Partial<PromptConfig>;
    return {
      selectedIds: Array.isArray(parsed.selectedIds) ? parsed.selectedIds.map(String) : [],
      customPrompts: Array.isArray(parsed.customPrompts) ? parsed.customPrompts as PromptConfig['customPrompts'] : [],
    };
  } catch {
    return { selectedIds: [], customPrompts: [] };
  }
}

/** 将提示词配置保存到磁盘 */
function savePromptConfig(config: PromptConfig): void {
  fs.mkdirSync(path.dirname(promptConfigPath), { recursive: true });
  fs.writeFileSync(promptConfigPath, JSON.stringify(config, null, 2), 'utf-8');
}

/** 获取所有有效的提示词 ID 集合（内置 + 自定义） */
function validPromptIds(config: PromptConfig): Set<string> {
  return new Set([...BUILT_IN_PROMPT_IDS, ...config.customPrompts.map(prompt => prompt.id)]);
}

function sanitizePromptName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.slice(0, 120) || '导入提示词';
}

function sanitizePromptContent(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeImportPrompts(value: unknown): PromptImportItem[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { prompts?: unknown }).prompts)
      ? (value as { prompts: unknown[] }).prompts
      : [];
  return raw
    .filter((item): item is PromptImportItem => Boolean(item) && typeof item === 'object')
    .filter(item => Boolean(sanitizePromptContent(item.content).trim()));
}

/** 提示词管理 API：支持内置/项目/自定义提示词的增删改查和选择配置 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      const projects: PromptProject[] = [];
      const residualProjectIds: string[] = [];
      const currentRoot = normalizePath(process.env.CUSTOMIZE_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd());
      const config = loadPromptConfig();
      const currentPromptId = promptIdFromPath(path.join(currentRoot, 'CUSTOMIZE.md'));
      const selectedIds = fs.existsSync(promptConfigPath) && config.selectedIds.length > 0 ? config.selectedIds : [currentPromptId];
      if (req.query.mode === 'export') {
        const selectedSet = new Set(selectedIds);
        const payload: PromptExportFile = {
          version: 1,
          exportedAt: new Date().toISOString(),
          prompts: config.customPrompts.map(prompt => ({ name: prompt.name, content: prompt.content, selected: selectedSet.has(prompt.id) })),
        };
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="customize-prompts-${new Date().toISOString().slice(0, 10)}.json"`);
        return res.status(200).json(payload);
      }
      const db = openRegistry(true);
      if (db) {
        try {
          const rows = db.prepare('SELECT project_id, project_root, project_name FROM project_registry ORDER BY last_opened_at DESC').all() as RegistryRow[];
          for (const row of rows) {
            const root = normalizePath(String(row.project_root));
            if (isInternalResidualProject(root)) {
              residualProjectIds.push(String(row.project_id));
              continue;
            }
            const mdPath = path.join(root, 'CUSTOMIZE.md');
            const hasFile = fs.existsSync(mdPath);
            const id = promptIdFromPath(mdPath);
            projects.push({
              id,
              projectId: String(row.project_id),
              projectRoot: root,
              projectName: String(row.project_name || path.basename(root) || root),
              customizePath: mdPath,
              content: hasFile ? fs.readFileSync(mdPath, 'utf-8') : '',
              mtime: hasFile ? fs.statSync(mdPath).mtime.toISOString() : '',
              hasFile,
              isCurrent: root === currentRoot,
              selected: selectedIds.includes(id),
              source: root === currentRoot ? 'current' : 'project',
            });
          }
        } finally {
          db.close();
        }
      }
      const cwd = currentRoot;
      const cwdMdPath = path.join(cwd, 'CUSTOMIZE.md');
      if (!isInternalResidualProject(cwd) && !projects.some(p => p.projectRoot === cwd)) {
        const hasFile = fs.existsSync(cwdMdPath);
        projects.unshift({
          id: currentPromptId,
          projectId: 'current',
          projectRoot: cwd,
          projectName: path.basename(cwd) || cwd,
          customizePath: cwdMdPath,
          content: hasFile ? fs.readFileSync(cwdMdPath, 'utf-8') : '',
          mtime: hasFile ? fs.statSync(cwdMdPath).mtime.toISOString() : '',
          hasFile,
          isCurrent: true,
          selected: selectedIds.includes(currentPromptId),
          source: 'current',
        });
      }
      for (const builtIn of BUILT_IN_PROMPTS) {
        projects.push({
          id: builtIn.id,
          projectId: builtIn.id,
          projectName: builtIn.name,
          customizePath: builtIn.id,
          content: builtIn.content,
          mtime: '',
          hasFile: true,
          isCurrent: false,
          selected: selectedIds.includes(builtIn.id),
          source: 'custom',
        });
      }
      for (const custom of config.customPrompts) {
        projects.push({
          id: custom.id,
          projectId: custom.id,
          projectName: custom.name,
          customizePath: custom.id,
          content: custom.content,
          mtime: custom.updatedAt,
          hasFile: true,
          isCurrent: false,
          selected: selectedIds.includes(custom.id),
          source: 'custom',
        });
      }
      cleanupResidualProjects(residualProjectIds);
      return res.status(200).json(projects);
    }

    if (req.method === 'POST') {
      const { action, projectRoot, content, name, selectedIds, prompts, mode } = req.body;
      const config = loadPromptConfig();
      if (action === 'import' || mode === 'import') {
        const items = normalizeImportPrompts(prompts ?? req.body);
        if (items.length === 0) return res.status(400).json({ error: '没有可导入的提示词' });
        const now = new Date().toISOString();
        const importedIds: string[] = [];
        for (const item of items) {
          const id = `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          config.customPrompts.push({ id, name: sanitizePromptName(item.name), content: sanitizePromptContent(item.content), createdAt: now, updatedAt: now });
          importedIds.push(id);
        }
        const selectedImportedIds = items.map((item, index) => item.selected ? importedIds[index] : undefined).filter(Boolean) as string[];
        if (selectedImportedIds.length > 0) config.selectedIds = Array.from(new Set([...config.selectedIds, ...selectedImportedIds]));
        savePromptConfig(config);
        return res.status(200).json({ success: true, imported: importedIds.length, ids: importedIds });
      }
      if (action === 'createCustom') {
        const now = new Date().toISOString();
        const id = `custom:${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        config.customPrompts.push({ id, name: String(name || '自定义提示词').trim() || '自定义提示词', content: typeof content === 'string' ? content : '', createdAt: now, updatedAt: now });
        savePromptConfig(config);
        return res.status(200).json({ success: true, id });
      }
      if (action === 'select') {
        const validIds = validPromptIds(config);
        config.selectedIds = Array.isArray(selectedIds) ? selectedIds.map(String).filter(id => validIds.has(id) || id.startsWith('file:')) : [];
        savePromptConfig(config);
        return res.status(200).json({ success: true });
      }
      const root = normalizePath(String(projectRoot || ''));
      if (!root || isInternalResidualProject(root) || !fs.existsSync(root)) return res.status(403).json({ error: 'Invalid project root' });
      const target = path.join(root, 'CUSTOMIZE.md');
      if (action === 'create') {
        if (!fs.existsSync(target)) fs.writeFileSync(target, typeof content === 'string' ? content : '', 'utf-8');
        config.selectedIds = Array.from(new Set([...config.selectedIds, promptIdFromPath(target)]));
        savePromptConfig(config);
        return res.status(200).json({ success: true, customizePath: target, mtime: fs.statSync(target).mtime.toISOString() });
      }
      return res.status(400).json({ error: 'Invalid action' });
    }

    if (req.method === 'PUT') {
      const { filePath, content, name } = req.body;
      if (!filePath || typeof content !== 'string') return res.status(400).json({ error: 'filePath and content required' });
      const idOrPath = String(filePath);
      if (BUILT_IN_PROMPT_IDS.has(idOrPath)) return res.status(403).json({ error: 'Built-in prompt cannot be edited' });
      if (idOrPath.startsWith('custom:')) {
        const config = loadPromptConfig();
        const custom = config.customPrompts.find(item => item.id === idOrPath);
        if (!custom) return res.status(404).json({ error: 'Prompt not found' });
        custom.content = content;
        if (typeof name === 'string' && name.trim()) custom.name = name.trim();
        custom.updatedAt = new Date().toISOString();
        savePromptConfig(config);
        return res.status(200).json({ success: true, mtime: custom.updatedAt });
      }
      const target = normalizePath(idOrPath);
      if (!isAllowedPromptFile(target)) return res.status(403).json({ error: 'Invalid prompt file' });
      const root = path.dirname(target);
      if (!fs.existsSync(root)) return res.status(404).json({ error: 'Project directory not found' });
      fs.writeFileSync(target, content, 'utf-8');
      return res.status(200).json({ success: true, mtime: fs.statSync(target).mtime.toISOString() });
    }

    if (req.method === 'DELETE') {
      const { projectId, filePath } = req.body;
      if (!filePath) return res.status(400).json({ error: 'filePath required' });
      const idOrPath = String(filePath);
      const config = loadPromptConfig();
      if (BUILT_IN_PROMPT_IDS.has(idOrPath)) return res.status(403).json({ error: 'Built-in prompt cannot be deleted' });
      if (idOrPath.startsWith('custom:')) {
        config.customPrompts = config.customPrompts.filter(item => item.id !== idOrPath);
        config.selectedIds = config.selectedIds.filter(id => id !== idOrPath);
        savePromptConfig(config);
        return res.status(200).json({ success: true });
      }
      const target = normalizePath(idOrPath);
      if (!isAllowedPromptFile(target)) return res.status(403).json({ error: 'Invalid prompt file' });
      if (fs.existsSync(target)) fs.unlinkSync(target);
      config.selectedIds = config.selectedIds.filter(id => id !== promptIdFromPath(target));
      savePromptConfig(config);
      if (projectId && projectId !== 'current') {
        const db = openRegistry(false);
        try { db?.prepare('DELETE FROM project_registry WHERE project_id = ?').run(String(projectId)); }
        finally { db?.close(); }
      }
      return res.status(200).json({ success: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (e: unknown) { console.error('[api] prompt', e); res.status(500).json({ error: 'Internal server error' }); }
}
