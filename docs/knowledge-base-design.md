# Customize Agent — 本地知识库系统完整设计方案

> 版本: v3.0  
> 日期: 2026-06-30  
> 状态: 设计阶段

---

## 目录

1. [设计目标与核心理念](#1-设计目标与核心理念)
2. [整体架构](#2-整体架构)
3. [文件类型分类体系](#3-文件类型分类体系)
4. [ChromaDB 多集合架构](#4-chromadb-多集合架构)
5. [增量索引与变更检测机制](#5-增量索引与变更检测机制)
6. [多级去重管线](#6-多级去重管线)
7. [文件关系与补充机制](#7-文件关系与补充机制)
8. [Web 可视化管理界面](#8-web-可视化管理界面)
9. [TUI 终端集成](#9-tui-终端集成)
10. [Agent 运行时集成](#10-agent-运行时集成)
11. [包结构与文件清单](#11-包结构与文件清单)
12. [API 接口完整定义](#12-api-接口完整定义)
13. [数据库 Schema 设计](#13-数据库-schema-设计)
14. [分阶段实施计划](#14-分阶段实施计划)
15. [附录：关键类型定义](#15-附录关键类型定义)

---

## 1. 设计目标与核心理念

### 1.1 核心问题

当前使用通用智能体分析文件时存在以下痛点：

1. **重复上传**：每次执行任务都需要重新上传模板文件（PDF/文档/图片等），占用上下文窗口
2. **上下文膨胀**：大量文件内容直接塞入上下文，很快触发压缩或截断
3. **无法复用**：跨会话的知识无法沉淀，相同分析任务需要重复描述文件内容
4. **管理困难**：大量模板文件散落在不同目录，缺乏统一管理和可视化维护手段

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **声明式管理** | 只需将文件放入 `knowledgeBase/` 文件夹，系统自动感知并处理 |
| **零重复工作** | 已索引文件不会重复向量化；相同内容文件自动去重 |
| **类型感知** | 不同类型文件（PDF/CAD/图片/代码等）进入不同的处理管线 |
| **增量更新** | 启动时仅处理新增/变更文件，无变化时秒级就绪 |
| **全局共享** | 知识库持久化到 `~/.customize-agent/`，跨项目、跨会话可用 |
| **可视化管理** | 提供 Web Dashboard 进行完整的 CRUD、去重管理、关系图谱 |

---

## 2. 整体架构

### 2.1 架构总览图

```
┌──────────────────────────────────────────────────────────────────┐
│                       customize-agent CLI                         │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  ┌──────────────┐  ┌────────────────────┐  ┌──────────────────┐  │
│  │  TUI (REPL)   │  │  Web Dashboard     │  │  Agent Runtime   │  │
│  │  - Banner     │  │  (Express :9730)   │  │  - KB Tools      │  │
│  │  - /kb 命令   │  │  - 文件 CRUD       │  │  - ContextSource │  │
│  │  - 状态显示   │  │  - 去重管理        │  │  - FileWatcher   │  │
│  │              │  │  - 关系图谱        │  │                  │  │
│  └──────┬───────┘  └────────┬───────────┘  └────────┬─────────┘  │
│         │                   │                       │             │
├─────────┴───────────────────┴───────────────────────┴─────────────┤
│                                                                    │
│              @customize-agent/knowledge (新包)                      │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                  KnowledgeBaseManager                        │  │
│  │  - initialize()  - incrementalIndex()  - search()           │  │
│  │  - addFile()     - removeFile()        - getStats()         │  │
│  │  - reindexAll()  - shutdown()                               │  │
│  ├──────────────────────────────────────────────────────────────┤  │
│  │                                                              │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │  │
│  │  │ FileClassifier│  │  Extraction  │  │    Chunking      │   │  │
│  │  │ (类型分类)    │  │  (内容提取)   │  │   (文本分块)     │   │  │
│  │  │ 10大类50+格式 │  │ 按类型分发   │  │  按类型策略      │   │  │
│  │  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │  │
│  │         │                 │                   │              │  │
│  │  ┌──────┴─────────────────┴───────────────────┴──────────┐  │  │
│  │  │                   Dedup Engine                        │  │  │
│  │  │  L1: 字节精确 → L2: 内容归一化 → L3: MinHash近似     │  │  │
│  │  │  → L4: 元数据关系检测                                  │  │  │
│  │  └────────────────────────┬───────────────────────────────┘  │  │
│  │                           │                                  │  │
│  │  ┌────────────────────────┴───────────────────────────────┐  │  │
│  │  │                Vector Store Layer                      │  │  │
│  │  │  ┌──────────────────┐  ┌──────────────────┐           │  │  │
│  │  │  │ ChromaVectorStore│  │ MilvusVectorStore│           │  │  │
│  │  │  │ (默认实现)       │  │ (可选实现)       │           │  │  │
│  │  │  └────────┬─────────┘  └────────┬─────────┘           │  │  │
│  │  │           └──────────┬──────────┘                      │  │  │
│  │  │            VectorStoreInterface (抽象层)               │  │  │
│  │  └──────────────────────┬─────────────────────────────────┘  │  │
│  │                         │                                    │  │
│  │  ┌──────────────────────┴─────────────────────────────────┐  │  │
│  │  │           Federation Search (跨集合联合搜索)            │  │  │
│  │  │  向量搜索 + 关键词重排序 + 跨集合去重 + 加权融合         │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  │                                                              │  │
│  │  ┌──────────────────────────────────────────────────────┐    │  │
│  │  │         Change Tracker (变更追踪)                     │    │  │
│  │  │  SQLite 持久化索引状态 → 启动时快速 diff → 增量处理     │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  │                                                              │  │
│  │  ┌──────────────────────────────────────────────────────┐    │  │
│  │  │       Relationship Manager (关系管理)                  │    │  │
│  │  │  版本链 · 翻译对 · 衍生关系 · 补充关系 · 格式变体       │    │  │
│  │  └──────────────────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│                         External Services                          │
│                                                                    │
│  ┌─────────────────────┐      ┌─────────────────────┐             │
│  │   ChromaDB Server    │  or  │  Milvus Standalone   │             │
│  │   (chroma run)       │      │  (Docker)            │             │
│  │   Port: 8000         │      │  Port: 19530         │             │
│  └─────────────────────┘      └─────────────────────┘             │
│                                                                    │
│  ┌─────────────────────────────────────────────────────┐          │
│  │   SQLite (~/.customize-agent/knowledge.db)           │          │
│  │   - kb_index_state:  索引状态追踪                    │          │
│  │   - kb_file_hashes:  文件哈希索引                    │          │
│  │   - kb_relationships: 文件关系记录                   │          │
│  │   - kb_minhash:      MinHash 签名存储                │          │
│  └─────────────────────────────────────────────────────┘          │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 存储路径规划

```
~/.customize-agent/
├── chroma-data/              ← ChromaDB 持久化数据目录
│   ├── chroma.sqlite3        ← ChromaDB 内部元数据
│   └── */                    ← 各 collection 的向量数据
├── knowledge.db              ← 知识库辅助 SQLite（索引状态、哈希、关系）
├── memory.db                 ← 已有：跨会话记忆
└── config.json               ← 已有：运行配置
```

---

## 3. 文件类型分类体系

### 3.1 分类总览

```
文件类型分类树 (10 大类, 50+ 格式)
════════════════════════════════════════

📄 document（文档类）
├── pdf              .pdf
├── office           .docx .doc .rtf .odt
├── presentation     .pptx .ppt .odp
├── markdown         .md .markdown .mdx
├── plaintext        .txt .rst .asciidoc .tex
└── ebook            .epub .mobi

📊 spreadsheet（表格类）
├── excel            .xlsx .xls .xlsm
├── csv              .csv .tsv .tab
└── opendoc          .ods

🖼️ image（图片类）
├── raster           .png .jpg .jpeg .gif .bmp .webp .tiff .tif
├── vector           .svg .eps
└── raw              .raw .cr2 .nef .dng

🔧 cad（工程图纸类）
├── autocad          .dwg .dxf .dwt
├── step             .step .stp .p21
├── iges             .iges .igs
├── mesh             .stl .obj .3mf .fbx .glb .gltf
└── solidworks       .sldprt .sldasm .slddrw

📝 code（代码类）
├── typescript       .ts .tsx .mts .cts
├── javascript       .js .jsx .mjs .cjs
├── python           .py .pyi .pyx .ipynb
├── java_kotlin      .java .kt .scala
├── c_family         .c .cpp .cc .cxx .h .hpp
├── go               .go
├── rust             .rs
├── ruby             .rb
├── php              .php
├── shell            .sh .bash .zsh .fish
├── sql              .sql
└── config           .toml .ini .cfg .conf .env

🗄️ data（数据类）
├── json             .json .jsonl .json5 .geojson
├── yaml             .yaml .yml
├── xml              .xml .xsd .wsdl
├── protobuf         .proto
└── graphql          .graphql .gql

🌐 web（网页类）
├── html             .html .htm .xhtml
├── stylesheet       .css .scss .sass .less
└── template         .hbs .ejs .pug .j2 .jinja2

🗺️ diagram（图表类）
├── drawio           .drawio .dio
├── visio            .vsdx .vdx
├── plantuml         .puml .plantuml
├── mermaid          .mmd .mermaid
└── excalidraw       .excalidraw

📦 archive（压缩包类）
├── zip              .zip .jar .war .apk
├── tar              .tar .tar.gz .tgz .tar.bz2
└── other            .rar .7z .gz .bz2

📐 other（兜底）
└── unknown          * (未匹配任何已知类型的文件)
```

### 3.2 每个类型的处理策略

| 类型 | 提取策略 | 分块策略 | 额外处理 |
|------|----------|----------|----------|
| **document/pdf** | `pdfjs-dist` 提取文本+表格 | 段落+章节边界, 800 token/块 | 标题/作者/页数/TOC 提取 |
| **document/office** | `mammoth` 提取文本+样式 | 标题层级+段落边界 | 标题/列表/表格结构保留 |
| **document/markdown** | 直接读取, 保留 frontmatter | 按 `##` 标题分块 | YAML frontmatter → 元数据 |
| **document/plaintext** | 直接读取 | 空行+滑动窗口(512 token) | 语言自动检测 |
| **spreadsheet/* ** | `xlsx` 解析→结构化文本 | Sheet→行范围(50行/块) | 列头提取+统计摘要 |
| **image/raster** | OCR(tesseract.js) + Vision API | 单图→单描述块 | 双通道: OCR 文本 + Vision 语义描述 |
| **image/vector** | 提取 SVG 文本节点 | 图层/组 | SVG 内嵌文本 |
| **cad/autocad** | `dxf-parser` 提取图层/标注 | 图层+部件 | 图层名/材料/尺寸/块引用 |
| **cad/step** | STEP 实体+属性解析 | 部件/装配体 | PRODUCT/零件编号/材料 |
| **cad/mesh** | 元数据+文件名分析 | 单文件→单描述块 | 三角面数/体积/包围盒 |
| **code/* ** | tree-sitter AST 感知 | 函数/类/模块边界 + Header Injection | 符号提取+导入关系 |
| **data/json** | 结构化展开: `path.to.key: value` | 顶层 key | JSON Schema 推断 |
| **data/yaml** | 同 JSON | 同 JSON | 配置语义识别 |
| **data/xml** | 提取文本节点+路径 | 一级元素 | XPath 作为元数据 |
| **web/html** | 提取可见文本+meta标签 | `<section>`/`<article>` 边界 | Title/H1/meta description |
| **diagram/* ** | 提取形状文本+连线关系 | 整图→结构化描述 | 图形节点+连线文本 |
| **archive/* ** | 解压→递归索引内部文件 | — | 容器处理,不直接向量化 |
| **other/unknown** | 文件名+元数据+MIME检测 | 尽力而为 | 仅索引可读文本 |

### 3.3 类型分类器实现

```typescript
// packages/knowledge/src/classification/classifier.ts

export interface ClassifiedFile {
  /** 文件绝对路径 */
  absolutePath: string;
  /** 相对 knowledgeBase/ 的路径 */
  relativePath: string;
  /** 一级分类 */
  category: FileCategory;
  /** 二级格式 */
  format: FileFormat;
  /** 文件大小 (bytes) */
  fileSize: number;
  /** 文件修改时间 */
  mtime: number;
  /** MIME 类型 */
  mimeType: string;
}

export type FileCategory =
  | 'document'
  | 'spreadsheet'
  | 'image'
  | 'cad'
  | 'code'
  | 'data'
  | 'web'
  | 'diagram'
  | 'archive'
  | 'other';

export class FileClassifier {
  /** 扩展名 → [Category, Format] 映射表 */
  private extensionMap: Map<string, [FileCategory, string]>;

  constructor() {
    this.extensionMap = this._buildExtensionMap();
  }

  /** 分类单个文件 */
  classify(absolutePath: string, relativePath: string, stat: Stats): ClassifiedFile {
    const ext = path.extname(absolutePath).toLowerCase();
    const [category, format] = this.extensionMap.get(ext) ?? ['other', 'unknown'];

    return {
      absolutePath,
      relativePath,
      category,
      format,
      fileSize: stat.size,
      mtime: stat.mtimeMs,
      mimeType: this._inferMimeType(ext, category),
    };
  }

  /** 按类型分组 */
  groupByCategory(files: ClassifiedFile[]): Map<FileCategory, ClassifiedFile[]> {
    const groups = new Map<FileCategory, ClassifiedFile[]>();
    for (const file of files) {
      const list = groups.get(file.category) ?? [];
      list.push(file);
      groups.set(file.category, list);
    }
    return groups;
  }

  /** 过滤：跳过不应索引的文件 */
  shouldSkip(file: ClassifiedFile): string | null {
    // 大小检查
    if (file.fileSize > 50 * 1024 * 1024) return '文件超过 50MB 限制';
    if (file.fileSize === 0) return '空文件';
    // 黑名单扩展名
    const skipExts = ['.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.pyc', '.o'];
    if (skipExts.includes(path.extname(file.absolutePath).toLowerCase())) {
      return '二进制可执行文件，跳过';
    }
    // 隐藏文件
    if (path.basename(file.absolutePath).startsWith('.') ||
        path.basename(file.absolutePath).startsWith('._')) {
      return '隐藏/系统文件，跳过';
    }
    return null; // 不跳过
  }
}
```

---

## 4. ChromaDB 多集合架构

### 4.1 为什么分集合

| 混合集合的问题 | 分集合的解决方式 |
|----------------|-----------------|
| 不同文件类型的语义空间不同，混在一起向量相似度失真 | 每个类型独立向量空间，语义更纯粹 |
| 搜索"CAD 零件"不应匹配代码中的 part 函数 | 用户可限定搜索范围到特定集合 |
| 不同类型需要不同的 chunk 大小和 overlap | 每个集合独立配置 HNSW 参数 |
| 不同类型有完全不同的 metadata 字段 | 每个集合有独立的 metadata schema |
| 去重只在同类型内有意义 | 同集合内去重，跨集合链接 |

### 4.2 集合定义

```
ChromaDB (http://localhost:8000)
│
├── 📄 kb_documents        ← PDF/DOCX/MD/TXT/PPTX
│   dimension: 1536, metric: cosine
│   chunk_size: 800, overlap: 100
│
├── 📊 kb_spreadsheets     ← XLSX/CSV/TSV/ODS
│   dimension: 1536, metric: cosine
│   chunk_size: 1000, overlap: 200
│
├── 🖼️ kb_images           ← PNG/JPG/GIF/WEBP/SVG
│   dimension: 1536, metric: cosine
│   chunk_size: 512, overlap: 0
│
├── 🔧 kb_cad              ← DWG/DXF/STEP/IGES/STL
│   dimension: 1536, metric: cosine
│   chunk_size: 600, overlap: 100
│
├── 📝 kb_code             ← TS/JS/PY/JAVA/GO/RS/...
│   dimension: 1536, metric: cosine
│   chunk_size: 1000, overlap: 200
│
├── 🗄️ kb_data             ← JSON/YAML/XML/TOML
│   dimension: 1536, metric: cosine
│   chunk_size: 600, overlap: 100
│
├── 🌐 kb_web              ← HTML/CSS/模板
│   dimension: 1536, metric: cosine
│   chunk_size: 800, overlap: 100
│
├── 🗺️ kb_diagrams         ← DrawIO/VSDX/PlantUML
│   dimension: 1536, metric: cosine
│   chunk_size: 512, overlap: 0
│
└── 📦 kb_other            ← 兜底/未识别类型
    dimension: 1536, metric: cosine
    chunk_size: 500, overlap: 50
```

### 4.3 跨集合联合搜索

```typescript
// 当用户不指定集合时，并行搜索所有集合，加权融合结果

class FederationSearch {
  // 默认权重：语义清晰度高的集合权重更高
  private static DEFAULT_WEIGHTS: Record<string, number> = {
    kb_documents: 1.0,
    kb_spreadsheets: 0.8,
    kb_diagrams: 0.75,
    kb_code: 0.6,
    kb_data: 0.6,
    kb_images: 0.5,
    kb_cad: 0.5,
    kb_web: 0.4,
    kb_other: 0.3,
  };

  async search(query: FederatedQuery): Promise<FederatedResult> {
    // 1. 并行搜索所有指定集合（每个召回 3× topK）
    // 2. 按集合权重缩放 score
    // 3. 跨集合去重（同一文件不同格式 → 取最高分）
    // 4. 全局排序 → TopK
  }
}
```

---

## 5. 增量索引与变更检测机制

> **这是整个知识库系统最核心的机制。** 解决"每次启动如何高效判断哪些文件需要处理"的问题。

### 5.1 设计目标

| 场景 | 期望行为 | 耗时目标 |
|------|----------|----------|
| 首次启动（knowledgeBase/ 有 100 个文件） | 全部索引 | < 30s |
| 再次启动（无任何文件变化） | 跳过全部，直接就绪 | < 100ms |
| 新增 3 个文件 | 仅索引这 3 个 | < 5s |
| 修改 2 个文件 | 仅重新索引这 2 个 | < 5s |
| 删除 5 个文件 | 仅清理这 5 个的向量 | < 1s |
| 新增+修改+删除 混合 | 分别处理各自部分 | < 10s |

### 5.2 核心数据结构：索引状态表

```sql
-- ~/.customize-agent/knowledge.db

CREATE TABLE kb_index_state (
  relative_path     TEXT PRIMARY KEY,      -- 相对 knowledgeBase/ 的路径
  category          TEXT NOT NULL,         -- 文件分类
  format            TEXT NOT NULL,         -- 文件格式
  content_hash      TEXT NOT NULL,         -- SHA-256 内容哈希
  file_size         INTEGER NOT NULL,      -- 文件大小 (bytes)
  mtime             INTEGER NOT NULL,      -- 文件修改时间 (ms)
  chunk_count       INTEGER NOT NULL DEFAULT 0, -- 产生的 chunk 数
  collection_name   TEXT NOT NULL,         -- 存储在哪个 ChromaDB 集合
  indexed_at        INTEGER NOT NULL,      -- 首次索引时间 (ms)
  last_verified_at  INTEGER NOT NULL,      -- 上次验证时间 (ms)
  status            TEXT NOT NULL DEFAULT 'active',
    -- 'active'   : 正常
    -- 'outdated' : 文件已变更，需重新索引
    -- 'error'    : 上次索引失败
    -- 'deleted'  : 文件已从磁盘删除
  error_message     TEXT,                  -- 上次错误信息
  metadata_json     TEXT                   -- 类型特定的元数据 JSON
);

CREATE INDEX idx_kb_state_status ON kb_index_state(status);
CREATE INDEX idx_kb_state_category ON kb_index_state(category);
CREATE INDEX idx_kb_state_collection ON kb_index_state(collection_name);
```

### 5.3 启动时的变更检测完整流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLI 启动 → 知识库初始化                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 0: 前置检查                                                  │
│                                                                  │
│ ① knowledgeBase/ 是否存在?                                       │
│   ├─ NO  → 跳过知识库初始化, Banner 显示 "未启用"                  │
│   └─ YES → 继续                                                  │
│                                                                  │
│ ② ChromaDB 是否在运行? (http://localhost:8000/api/v1/heartbeat)  │
│   ├─ YES → 复用现有连接                                          │
│   └─ NO  → spawn 'chroma run' 子进程                            │
│           ├─ chroma 命令可用? → 直接启动                          │
│           └─ 不可用 → 提示用户: pip install chromadb              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 1: 扫描磁盘 (耗时 ~5-50ms, 取决于文件数量)                    │
│                                                                  │
│ 递归扫描 knowledgeBase/, 生成当前文件清单:                         │
│                                                                  │
│   diskFiles: Map<relativePath, { size, mtime }>                  │
│                                                                  │
│ 同时应用 .kbignore 规则过滤                                        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 2: 加载索引状态 (耗时 ~1-5ms, SQLite 查询)                   │
│                                                                  │
│ SELECT relative_path, content_hash, file_size, mtime, status     │
│ FROM kb_index_state WHERE status IN ('active', 'outdated')       │
│                                                                  │
│   indexedFiles: Map<relativePath, IndexedFileRecord>             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 3: Diff 计算 (纯内存操作, < 1ms)                             │
│                                                                  │
│ for each file in diskFiles:                                       │
│   indexed = indexedFiles.get(file.path)                          │
│                                                                  │
│   if indexed == null:                                            │
│     → 分类: NEW_FILE         添加到 indexQueue                    │
│                                                                  │
│   else if file.mtime != indexed.mtime:                           │
│     // mtime 变化, 计算内容哈希确认是否真的变了                     │
│     newHash = sha256(file)                                        │
│     if newHash != indexed.content_hash:                           │
│       → 分类: MODIFIED_FILE   添加到 indexQueue                   │
│     else:                                                        │
│       // mtime 变了但内容没变 (touch 命令等)                       │
│       → 分类: MTIME_ONLY      更新 mtime, 跳过索引                │
│                                                                  │
│   else:                                                          │
│     → 分类: UNCHANGED        跳过, 仅更新 last_verified_at        │
│                                                                  │
│ for each file in indexedFiles not in diskFiles:                   │
│   → 分类: DELETED_FILE      添加到 cleanupQueue                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 4: 输出 Diff 摘要 + 用户确认（可选）                         │
│                                                                  │
│ ┌────────────────────────────────────────────────────┐           │
│ │ [KB] 变更检测完成 (3ms)                              │           │
│ │                                                     │           │
│ │  📁 总文件:    127                                   │           │
│ │  ────────────────────────────────────               │           │
│ │  🆕 新增:      3  (contract_v3.pdf, ...)            │           │
│ │  ✏️  修改:      1  (security_policy.md)              │           │
│ │  🗑️  删除:      2  (old_template.docx, ...)          │           │
│ │  ✅ 无变化:    121                                   │           │
│ │  ⏭️  跳过:      0                                    │           │
│ │                                                     │           │
│ │  [自动处理中...]  [按 Enter 继续]                     │           │
│ └────────────────────────────────────────────────────┘           │
│                                                                  │
│ 如果无任何变更:                                                    │
│ ┌────────────────────────────────────────────────────┐           │
│ │ [KB] 知识库已是最新 (127 文件, 无变更)               │           │
│ └────────────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 5: 执行增量操作                                              │
│                                                                  │
│ ① 处理 cleanupQueue (删除文件):                                   │
│    for each deletedFile:                                         │
│      根据 collection_name 从 ChromaDB 删除对应 chunks             │
│      从 kb_index_state 删除记录                                   │
│      清理 kb_file_hashes / kb_minhash / kb_relationships         │
│                                                                  │
│ ② 处理 indexQueue (新增+修改文件):                                │
│    for each file in indexQueue:                                  │
│      if MODIFIED: 先清理旧 chunks（按 file_path 删除）            │
│      FileClassifier.classify() → category, format                │
│      ContentExtractor.extract() → 纯文本                         │
│      TextChunker.chunk() → chunks[]                              │
│      批量 Embed (每 20 个 chunk 一批)                             │
│      ChromaDB.insert() → 存入对应 collection                     │
│      更新 kb_index_state（content_hash, chunk_count 等）          │
│      更新 kb_file_hashes, kb_minhash                             │
│                                                                  │
│ ③ 增量关系检测:                                                   │
│    仅对新索引的文件执行 L2/L3/L4 去重和关系检测                    │
│    （已有文件之间的关系已在之前计算过）                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Step 6: 完成                                                      │
│                                                                  │
│ 更新 kb_metadata: last_indexed_at, total_chunks                  │
│ Banner 显示: "📚 KB: 127 files · 3,840 chunks · 15.2 MB"         │
└─────────────────────────────────────────────────────────────────┘
```

### 5.4 ChangeTracker 实现概要

```typescript
// packages/knowledge/src/core/change-tracker.ts

export interface IndexStateRecord {
  relativePath: string;
  category: string;
  format: string;
  contentHash: string;
  fileSize: number;
  mtime: number;
  chunkCount: number;
  collectionName: string;
  indexedAt: number;
  lastVerifiedAt: number;
  status: 'active' | 'outdated' | 'error' | 'deleted';
  errorMessage?: string;
}

export interface DiffResult {
  /** 需要新索引的文件 */
  newFiles: ClassifiedFile[];
  /** 需要重新索引的文件（内容已变更） */
  modifiedFiles: ClassifiedFile[];
  /** 需要清理的文件（已从磁盘删除） */
  deletedFiles: IndexStateRecord[];
  /** 无需处理的文件数量 */
  unchangedCount: number;
  /** 仅 mtime 变化但内容未变的文件数量 */
  mtimeOnlyCount: number;
  /** 跳过的文件及原因 */
  skippedFiles: Array<{ file: ClassifiedFile; reason: string }>;
  /** 是否有任何变更 */
  hasChanges: boolean;
  /** Diff 计算耗时 (ms) */
  diffTimeMs: number;
}

export class ChangeTracker {
  private db: Database.Database;

  constructor(storagePath: string) {
    this.db = new Database(path.join(storagePath, 'knowledge.db'));
    this._initTables();
  }

  /**
   * 核心方法：对比磁盘文件与已索引状态，返回变更差异
   */
  async computeDiff(
    diskFiles: Map<string, { size: number; mtime: number }>,
    classifier: FileClassifier,
    kbPath: string,
  ): Promise<DiffResult> {
    const startTime = Date.now();

    // 1. 加载已索引文件记录
    const indexedFiles = this._loadIndexState();

    const newFiles: ClassifiedFile[] = [];
    const modifiedFiles: ClassifiedFile[] = [];
    const deletedFiles: IndexStateRecord[] = [];
    const skippedFiles: Array<{ file: ClassifiedFile; reason: string }> = [];
    let unchangedCount = 0;
    let mtimeOnlyCount = 0;

    // 2. 遍历磁盘文件，分类
    for (const [relativePath, diskStat] of diskFiles) {
      const absolutePath = path.join(kbPath, relativePath);
      const classified = classifier.classify(
        absolutePath, relativePath,
        { size: diskStat.size, mtimeMs: diskStat.mtime } as Stats,
      );

      // 检查是否应跳过
      const skipReason = classifier.shouldSkip(classified);
      if (skipReason) {
        skippedFiles.push({ file: classified, reason: skipReason });
        continue;
      }

      const indexed = indexedFiles.get(relativePath);

      if (!indexed) {
        // 新文件
        newFiles.push(classified);
      } else if (diskStat.mtime !== indexed.mtime) {
        // mtime 变化 → 校验内容哈希
        const newHash = await sha256File(absolutePath);
        if (newHash !== indexed.contentHash) {
          modifiedFiles.push(classified);
        } else {
          // 内容未变，仅更新 mtime
          this._updateMtime(relativePath, diskStat.mtime);
          mtimeOnlyCount++;
        }
      } else {
        unchangedCount++;
        // 异步更新验证时间（不阻塞）
        this._updateVerifiedAt(relativePath);
      }
    }

    // 3. 找出已删除的文件（在索引中但不在磁盘上）
    for (const [path, record] of indexedFiles) {
      if (!diskFiles.has(path) && record.status !== 'deleted') {
        deletedFiles.push(record);
      }
    }

    return {
      newFiles,
      modifiedFiles,
      deletedFiles,
      unchangedCount,
      mtimeOnlyCount,
      skippedFiles,
      hasChanges: newFiles.length + modifiedFiles.length + deletedFiles.length > 0,
      diffTimeMs: Date.now() - startTime,
    };
  }

  /**
   * 更新单个文件的索引状态（索引完成后调用）
   */
  upsertState(record: Omit<IndexStateRecord, 'lastVerifiedAt'>): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO kb_index_state
        (relative_path, category, format, content_hash, file_size,
         mtime, chunk_count, collection_name, indexed_at, last_verified_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      record.relativePath, record.category, record.format,
      record.contentHash, record.fileSize, record.mtime,
      record.chunkCount, record.collectionName,
      record.indexedAt, Date.now(),
    );
  }

  /**
   * 标记文件为已删除
   */
  markDeleted(relativePath: string): void {
    this.db.prepare(`
      UPDATE kb_index_state SET status = 'deleted', last_verified_at = ?
      WHERE relative_path = ?
    `).run(Date.now(), relativePath);
  }

  /**
   * 物理删除记录（清理完成后调用）
   */
  removeRecord(relativePath: string): void {
    this.db.prepare('DELETE FROM kb_index_state WHERE relative_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_file_hashes WHERE file_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_minhash WHERE file_path = ?').run(relativePath);
    this.db.prepare('DELETE FROM kb_relationships WHERE source_file = ? OR target_file = ?')
      .run(relativePath, relativePath);
  }
}
```

### 5.5 文件监听（可选增强）

当用户启用 `watch: true` 时，在初始索引完成后启动 `chokidar` 监听：

```typescript
// packages/knowledge/src/core/file-watcher.ts

export class FileWatcher {
  private watcher: FSWatcher;
  private pendingChanges = new Map<string, DebouncedAction>();
  private debounceMs = 2000; // 2秒防抖

  start(kbPath: string, onChange: (event: WatchEvent) => void): void {
    this.watcher = chokidar.watch(kbPath, {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/.DS_Store',
        '**/Thumbs.db',
      ],
      ignoreInitial: true,       // 不触发初始扫描事件
      awaitWriteFinish: {
        stabilityThreshold: 1000, // 文件写入完成后等待 1s
        pollInterval: 200,
      },
    });

    this.watcher
      .on('add',    (filePath) => this._schedule(filePath, 'added', onChange))
      .on('change', (filePath) => this._schedule(filePath, 'modified', onChange))
      .on('unlink', (filePath) => this._schedule(filePath, 'deleted', onChange));
  }

  // 防抖：2秒内同一文件的多次事件合并为一次
  private _schedule(filePath: string, type: WatchEventType, onChange: (e: WatchEvent) => void) {
    const existing = this.pendingChanges.get(filePath);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.pendingChanges.delete(filePath);
      onChange({ type, filePath, timestamp: Date.now() });
    }, this.debounceMs);

    this.pendingChanges.set(filePath, { timer, type });
  }
}
```

### 5.6 索引状态 SQLite 中的元数据表

```sql
-- 索引元数据
CREATE TABLE kb_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 预置键:
-- 'schema_version'         → '1'
-- 'last_full_index_at'     → '1700000000000'
-- 'last_incremental_index_at' → '1700000000000'
-- 'total_chunks'           → '3840'
-- 'total_files_indexed'    → '127'
-- 'embedding_model'        → 'text-embedding-3-small'
-- 'embedding_dimension'    → '1536'
```

---

## 6. 多级去重管线

### 6.1 四级去重流水线

```
文件进入索引队列
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│ Level 0: 前置过滤 (Pre-index Filter)                          │
│                                                               │
│ 条件检查:                                                      │
│ • 文件大小 > 50MB?            → SKIP (too_large)              │
│ • 文件大小 > 10MB?            → WARN (large, 仍处理)          │
│ • 二进制文件无对应解析器?      → SKIP (no_parser)             │
│ • 扩展名在黑名单?              → SKIP (blocked_ext)           │
│ • 隐藏文件/系统文件?           → SKIP (hidden)                │
│ • .kbignore 规则匹配?         → SKIP (ignored)               │
│ • 空文件?                     → SKIP (empty)                 │
└──────────────────────────┬───────────────────────────────────┘
                           │ 通过过滤
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ Level 1: 字节级精确去重 (Byte-exact Dedup)                     │
│                                                               │
│ 方法: SHA-256 文件内容哈希                                     │
│                                                               │
│ 查询 kb_file_hashes WHERE content_hash = ?                    │
│                                                               │
│ 匹配?                                                         │
│ ├─ 同路径 + 同哈希 → SKIP (not_modified)                      │
│ └─ 不同路径 + 同哈希 → 记录 EXACT_DUPLICATE 关系, SKIP        │
│                                                               │
│ 关系类型: exact_duplicate                                     │
│ 操作: 不重复索引, 搜索时只返回一份                              │
└──────────────────────────┬───────────────────────────────────┘
                           │ 非精确重复
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ Level 2: 归一化内容去重 (Normalized Content Dedup)             │
│                                                               │
│ 方法: 提取文本 → 归一化 → SHA-256                              │
│                                                               │
│ normalize(text):                                              │
│   → 小写化                                                    │
│   → 移除标点 + 压缩空白                                       │
│   → 数字归一化 (2024→YYYY, 12345→#####)                      │
│   → 移除常见停用词                                            │
│                                                               │
│ 匹配?                                                         │
│ → 内容本质相同 (PDF + DOCX 同一份报告 / 中英对照版)            │
│                                                               │
│ 关系类型: format_variant (跨格式) | translation (翻译)         │
│ 操作: 两个格式都保留索引（提取质量不同）                        │
│       搜索结果默认只返回质量最高的那份                          │
│       标记 1 个 primary + N 个 variant                         │
└──────────────────────────┬───────────────────────────────────┘
                           │ 非内容重复
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ Level 3: 语义近似去重 (Semantic Near-Duplicate)                │
│                                                               │
│ 条件: 文本 > 1000 字符                                         │
│ 方法: MinHash + LSH                                            │
│                                                               │
│ • k-shingles = 5 (字符级 n-gram)                              │
│ • 128 hash functions                                           │
│ • LSH bands = 16, rows per band = 8                           │
│                                                               │
│ 阈值:                                                          │
│   Jaccard ≥ 0.95 → NEAR_DUPLICATE    (同模板 + 微调)         │
│   Jaccard ≥ 0.80 → HIGH_SIMILARITY   (同模板 + 大量填充)     │
│   Jaccard ≥ 0.60 → MODERATE_SIMILARITY (同主题)              │
│                                                               │
│ 操作: 记录关系, 不自动删除                                      │
│       用户可在 Dashboard 中手动合并/忽略                        │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│ Level 4: 元数据关系检测 (Metadata Relationship Detection)      │
│                                                               │
│ 文件名模式匹配:                                                │
│ • *_v1.* + *_v2.*           → VERSION_CHAIN                  │
│ • *_cn.* + *_en.*           → TRANSLATION                    │
│ • 同目录 + 同类型 + 相似大小 → 低置信度 SAME_DIR_SAME_TYPE     │
│                                                               │
│ 时间窗口检查:                                                  │
│ • 文件名相似 + 创建时间接近 → POTENTIAL_REVISION              │
│ • 一个大文件 + 多个小文件 → 可能是 MAIN + APPENDICES          │
│                                                               │
│ 操作: 记录关系（置信度 < 1.0），用户可在 Dashboard 中确认/拒绝   │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 去重辅助表结构

```sql
-- 文件哈希表（L1 精确去重）
CREATE TABLE kb_file_hashes (
  content_hash     TEXT PRIMARY KEY,      -- SHA-256
  file_path        TEXT NOT NULL,
  file_size        INTEGER NOT NULL,
  category         TEXT NOT NULL,
  normalized_hash  TEXT,                  -- L2 归一化文本哈希
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- MinHash 签名表（L3 近似去重）
CREATE TABLE kb_minhash (
  file_path        TEXT PRIMARY KEY,
  signature        BLOB NOT NULL,         -- 128×uint32 = 512 bytes
  shingle_count    INTEGER NOT NULL,      -- shingle 总数
  created_at       INTEGER NOT NULL
);

-- 文件关系表
CREATE TABLE kb_relationships (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file       TEXT NOT NULL,
  target_file       TEXT NOT NULL,
  relationship_type TEXT NOT NULL,        -- 见下方枚举
  confidence        REAL NOT NULL DEFAULT 1.0,
  detail            TEXT,
  user_confirmed    INTEGER NOT NULL DEFAULT 0,  -- 0=auto, 1=user confirmed, -1=user rejected
  created_at        INTEGER NOT NULL,
  UNIQUE(source_file, target_file, relationship_type)
);

-- relationship_type 枚举值:
-- 'exact_duplicate'        L1: 字节完全相同
-- 'format_variant'         L2: 内容相同格式不同 (PDF vs DOCX)
-- 'translation'            L2: 不同语言版本
-- 'near_duplicate'         L3: 内容高度相似 (>95%)
-- 'revision'               L3: 同一文件的修订版 (>80%)
-- 'version_chain'          L4: 版本链 (v1→v2→v3)
-- 'derived'                L4: 衍生关系 (模板→实例)
-- 'complementary'          L4: 补充关系 (主报告+附录)

CREATE INDEX idx_rel_source ON kb_relationships(source_file);
CREATE INDEX idx_rel_target ON kb_relationships(target_file);
CREATE INDEX idx_rel_type ON kb_relationships(relationship_type);
```

---

## 7. 文件关系与补充机制

### 7.1 关系类型与处理策略

| 关系类型 | 触发条件 | 系统自动处理 | 用户可选操作 |
|----------|----------|-------------|-------------|
| **exact_duplicate** | SHA-256 完全相同 | 不重复索引，搜索只返回一份 | 解除关联 |
| **format_variant** | 归一化文本相同，格式不同 | 全部索引，搜索返回质量最佳者 | 选择主格式 / 全部保留 |
| **near_duplicate** | Jaccard > 0.95 | 全部索引，搜索返回两份 + 标记相似度 | 合并 / 标记为衍生 / 忽略 |
| **revision** | Jaccard 0.80-0.95 | 全部索引，搜索返回最新版 | 查看差异 / 切换主版本 |
| **version_chain** | 文件名版本模式匹配 | 建立有序链，搜索返回最新版 | 设为当前版本 / 删除旧版 |
| **translation** | 归一化文本相同 + 语言不同 | 全部索引，根据 query 语言选择 | 手动指定语言对 |
| **derived** | 高结构相似 + 不同具体值 | 标注衍生树 | 标记基版 / 断开关联 |
| **complementary** | 文件名/目录/日期模式 | 标记关联组 | 设为项目组 / 解除关联 |

### 7.2 典型场景示例

**场景 1：版本链**

```
knowledgeBase/policies/
├── security_policy_2024.pdf   (42 KB, 2024-03-15)
├── security_policy_2025.pdf   (45 KB, 2025-01-10)  ← latest
└── security_policy_2026.pdf   (48 KB, 2026-02-20)  ← current

系统检测: 文件名模式 *_20{24,25,26}.pdf → VERSION_CHAIN
处理: 建立链 2024 → 2025 → 2026
搜索行为: query="安全政策" → 返回 2026 版 + "另有 2 个历史版本"
Dashboard: 版本时间线展示，可选择查看/恢复旧版
```

**场景 2：跨格式合并引用**

```
knowledgeBase/reports/
├── Q3财务报告.pdf    (2.1 MB, 120 chunks, 高质量提取)
└── Q3财务报告.docx   (1.8 MB, 115 chunks, 中质量提取)

系统检测: 归一化内容匹配 → FORMAT_VARIANT
处理: 两个都索引
      Q3财务报告.pdf → 标记为 primary (提取质量更高)
      Q3财务报告.docx → 标记为 variant
搜索行为: query="Q3财务报告" → 返回 PDF 版本
          + "此文件另有 DOCX 格式"
          + 可展开查看两个版本
Dashboard: 显示格式变体组，可切换主格式
```

**场景 3：补充关系**

```
knowledgeBase/Q3_project/
├── Q3_项目主报告.pdf      (5.2 MB, 2026-09-30)
├── Q3_附录A_财务数据.xlsx (890 KB, 2026-09-28)
└── Q3_附录B_技术方案.pdf  (2.1 MB, 2026-09-29)

系统检测: 同目录 + 文件名前缀 "Q3_" + 日期接近 → COMPLEMENTARY
处理: 建议建立项目组
搜索行为: 命中 Q3_项目主报告.pdf 时，提示 "相关文件: 财务数据, 技术方案"
Dashboard: 关系图谱中显示为一个 cluster
         可手动创建项目组
```

---

## 8. Web 可视化管理界面

### 8.1 启动方式

```bash
# CLI 内启动
> /kb dash
[KB] Dashboard 已启动 → http://localhost:9730
[KB] 浏览器已自动打开

# 命令行参数启动
customize --kb-dashboard           # 仅启动 Dashboard（不进入 REPL）
customize --kb-dashboard --no-open # 启动但不打开浏览器

# 可配置端口
customize --kb-dashboard --kb-port 8080
```

### 8.2 页面结构

Dashboard 为一个 SPA（单页应用），包含 7 个功能区域：

```
┌──────────────────────────────────────────────────────────────────────────┐
│  📚 Customize Agent — Knowledge Base Manager                  [⚙ 设置]   │
├──────────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │  ● ChromaDB Connected   8 collections   1,280 chunks   12.4 MB     │ │
│  │  上次索引: 2026-06-30 10:30    嵌入模型: text-embedding-3-small     │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
├─────────────┬────────────────────────────────────────────────────────────┤
│             │  [全部 127] [文档 42] [表格 5] [图片 12] [CAD 3]            │
│             │  [代码 20] [数据 8] [网页 3] [图表 6] [其他 1]              │
│  ┌────────┐ │                                                            │
│  │🔍 搜索  ││  ┌─────────────────────────────────────────────────────┐   │
│  │[      ]│ │  │ 文件列表                                  排序: 时间▼ │   │
│  │        │ │  ├─────────────────────────────────────────────────────┤   │
│  │📂 文件 │ │  │ ☐ 📄 template-report.pdf       2.4MB  127 chunks   │   │
│  │  浏览器 │ │  │    ✅ 无重复  🔗 DOCX版本  📎 审计报告(补充)       │   │
│  │        │ │  │ ☐ 📄 NDA_标准模板.docx          150KB  34 chunks   │   │
│  │  know- │ │  │    ⚠️ 3个近似文件 (95%) → [查看]                   │   │
│  │  ledge │ │  │ ☐ 📊 2025财报.xlsx              890KB  56 chunks   │   │
│  │  Base/ │ │  │ ☐ 🖼️ 组织架构图.png             420KB  1 chunk     │   │
│  │   ├─te │ │  │    🅞 OCR:23文本块  🅥 Vision:已生成描述            │   │
│  │   ├─po │ │  │ ☐ 🔧 零件A_v3.dxf               3.2MB  18 chunks   │   │
│  │   └─ex │ │  │    📐 v1→v2→v3(当前)                              │   │
│  │        │ │  │ ...                                                │   │
│  │ [+添加]│ │  └─────────────────────────────────────────────────────┘   │
│  │ [📥导入]││                                                            │
│  └────────┘│  ┌─────────────────────────────────────────────────────┐   │
│             │  │ 选中文件详情                              [✕ 关闭]  │   │
│             │  ├─────────────────────────────────────────────────────┤   │
│             │  │ 📄 template-report.pdf                              │   │
│             │  │ ──────────────────────────────────────────────────  │   │
│             │  │ 路径: knowledgeBase/templates/report.pdf            │   │
│             │  │ 大小: 2.4 MB  页数: 45  分块: 127  状态: ✅ Active  │   │
│             │  │ 哈希: a1b2c3d4e5f6...  索引时间: 2026-06-30 10:30  │   │
│             │  │ 标签: [年报] [财务] [2025Q3] [+添加]               │   │
│             │  │                                                     │   │
│             │  │ ── 去重与关系 ────────────────────────────────────  │   │
│             │  │ ✅ 无精确重复                                       │   │
│             │  │ 🔗 跨格式: DOCX版本 (已合并引用, PDF为primary)      │   │
│             │  │ 📎 关联: Q3_审计报告.pdf (补充)                     │   │
│             │  │     Q3_附录A_财务数据.xlsx (补充)                   │   │
│             │  │                                                     │   │
│             │  │ ── 分块预览 ─────────────────────────────────────   │   │
│             │  │ Chunk #0  元数据/标题                               │   │
│             │  │   2025年第三季度财务分析报告                        │   │
│             │  │ Chunk #1  §1 收入分析 (L12-68)                     │   │
│             │  │   本季度营业收入达到 12.8 亿元，同比增长 15.3%...   │   │
│             │  │ Chunk #2  §1 续 (L69-125)                          │   │
│             │  │   ...亚太地区贡献了 42% 的增长...                   │   │
│             │  │                         [加载更多分块]              │   │
│             │  │                                                     │   │
│             │  │ [编辑标签] [查看分块] [重新索引] [删除] [下载原文件] │   │
│             │  └─────────────────────────────────────────────────────┘   │
│             │                                                            │
├─────────────┴────────────────────────────────────────────────────────────┤
│  🛠 快捷操作: [🔄 重建全部索引] [🧹 去重管理] [🕸 关系图谱] [⚙ 集合设置]  │
└──────────────────────────────────────────────────────────────────────────┘
```

### 8.3 子页面功能

**去重管理页** (`/#/dedup`)：
- 按重复类型分组展示：精确重复 / 内容重复 / 近似重复 / 版本链
- 每组显示：文件数、可释放空间、操作按钮
- 批量操作：合并选中 / 忽略全部 / 标记为不同
- 合并后自动更新索引和关系

**关系图谱页** (`/#/graph`)：
- D3.js 力导向图，节点=文件，边=关系类型（颜色+线型区分）
- 点击节点 → 右侧面板显示文件详情
- 拖拽创建手动关系
- 按分类/关系类型筛选
- 导出图谱为 PNG/SVG

**搜索页** (`/#/search`)：
- 语义搜索 + 关键词搜索
- 高级过滤：类型、标签、日期范围、集合选择
- 结果显示匹配块 + 高亮 + 相似度
- 点击跳转到文件详情

**设置页** (`/#/settings`)：
- ChromaDB 连接管理（地址、端口、状态）
- 嵌入模型选择
- .kbignore 规则编辑器
- 集合参数调整
- 自动索引 / 文件监听开关
- 数据导出 / 导入

---

## 9. TUI 终端集成

### 9.1 Banner 显示

```
╭──────────────────────────────────────────────────────────────╮
│              ████  ██  ████  █  █  ███  ████                │
│              █     █   █     █  █  █ █    █                 │
│              █     █   ███   █  █  ███    █                 │
│              █     █   █     █  █  █ █    █                 │
│              ████  ███ ████  ████  █ █    █                 │
│                                                              │
│              Customize Agent v1.1.0                          │
│                                                              │
│              Provider  DeepSeek/deepseek-chat                │
│                                                              │
│  📚 Knowledge Base: 127 files · 3,840 chunks · 15.2 MB      │
│     Vector DB: ChromaDB ●  |  Dashboard: /kb dash           │
│     3 new · 1 modified · 2 deleted · 121 unchanged           │
│                                                              │
│  ▶  Type a task to begin   @ attach files   / commands      │
╰──────────────────────────────────────────────────────────────╯
```

### 9.2 REPL 命令

| 命令 | 功能 |
|------|------|
| `/kb` | 显示知识库概览面板（统计摘要） |
| `/kb status` | 详细统计：文件数/块数/大小/上次索引时间 |
| `/kb list [pattern]` | 列出文件，支持 glob 过滤 |
| `/kb search <query>` | 终端内快速搜索知识库 |
| `/kb add <file>` | 添加单个文件到知识库 |
| `/kb remove <file>` | 从知识库移除文件 |
| `/kb tag <file> <tags>` | 给文件打标签（逗号分隔） |
| `/kb reindex` | 强制重建全部索引 |
| `/kb reindex <file>` | 仅重建指定文件的索引 |
| `/kb dedup` | 显示去重/关系检测摘要 |
| `/kb dash` | 启动 Web Dashboard 并在默认浏览器打开 |
| `/kb dash stop` | 停止 Web Dashboard 服务器 |
| `/kb daemon status` | 查看 ChromaDB 守护进程状态 |
| `/kb daemon start` | 手动启动 ChromaDB |
| `/kb daemon stop` | 手动停止 ChromaDB |
| `/kb collections` | 列出所有 ChromaDB 集合及文档数 |
| `/kb ignore add <pattern>` | 添加 .kbignore 规则 |
| `/kb config` | 显示当前知识库配置 |

---

## 10. Agent 运行时集成

### 10.1 ContextSource：自动注入相关知识

```typescript
// packages/knowledge/src/integration/context-source.ts

export class KnowledgeBaseContextSource implements ContextSource {
  readonly id = 'knowledge_base';
  readonly priority = 8; // system=0, tool_defs=1, kb=8, tool_results=100

  constructor(private kb: KnowledgeBaseManager) {}

  async collect(session: { currentTask?: string }, _round: number): Promise<ContextChunk[]> {
    // 从最近一条用户消息中提取任务描述
    if (!session.currentTask) return [];

    const results = await this.kb.search(session.currentTask, {
      topK: 5,
      // 不限定集合，让 FederationSearch 自动加权
    });

    if (results.length === 0) return [];

    const content = results
      .map((r, i) => `[KB-Ref#${i + 1} | ${r.collection}/${r.filePath} | score: ${r.score.toFixed(2)}]\n${r.content}`)
      .join('\n\n---\n\n');

    return [{
      priority: this.priority,
      content: `── 知识库参考（以下内容来自本地 knowledgeBase/，仅供参考）──\n${content}\n── 知识库参考结束 ──`,
      tokens: estimateTokens(content),
      source: this.id,
      ttl: 3,                       // 保留 3 轮对话
      mergeStrategy: 'replace',     // 新检索结果替换旧的
    }];
  }
}
```

### 10.2 Agent 工具：按需查询知识库

向 ToolRegistry 注册以下工具：

| 工具名 | 描述 | 参数 | 权限 |
|--------|------|------|------|
| `search_knowledge` | 在本地知识库中搜索相关内容 | `query`, `topK?`, `category?`, `tags?` | 无需审批 |
| `list_knowledge_files` | 列出知识库中的文件 | `category?`, `pattern?` | 无需审批 |
| `get_knowledge_file` | 获取知识库文件的完整内容 | `filePath` | 无需审批 |
| `get_knowledge_chunks` | 获取文件的指定分块 | `filePath`, `chunkIndices?` | 无需审批 |
| `get_knowledge_stats` | 获取知识库统计 | 无 | 无需审批 |

### 10.3 两种注入方式的对比

| 方式 | ContextSource | Agent Tool |
|------|--------------|------------|
| 触发时机 | 每轮对话自动注入 | Agent 主动调用 |
| Agent 感知 | 不感知，作为系统提示词后缀 | 感知，作为工具调用 |
| 适合场景 | 背景知识增强 | 精确检索特定信息 |
| 上下文占用 | 低优先级，可被 ContextManager 裁剪 | 作为工具结果保留 |
| 控制粒度 | 粗（自动检索，自动注入） | 细（Agent 决定何时查、查什么） |

---

## 11. 包结构与文件清单

```
packages/knowledge/
├── package.json
│   dependencies:
│     chromadb                      — ChromaDB JS 客户端
│     express                       — Web Dashboard 服务器
│     multer                        — 文件上传处理
│     chokidar                      — 文件系统监听
│     better-sqlite3                — 索引状态 SQLite（复用已有依赖）
│     pdfjs-dist                    — PDF 文本提取
│     mammoth                       — DOCX 文本提取
│     xlsx                          — Excel 表格解析
│     minhash-js                    — MinHash 算法（或自行实现）
│     marked                        — Markdown 解析（复用已有）
│   optionalDependencies:
│     tesseract.js                  — OCR（图片文字识别）
│     dxf-parser                    — DXF 文件解析
│     @zilliz/milvus2-sdk-node     — Milvus SDK（按需切换）
│   peerDependencies:
│     @customize-agent/llm          — 复用 Embed API
│     @customize-agent/engine       — 复用 ContextSource 接口
│     @customize-agent/types        — 复用基础类型
│
├── tsconfig.json
│
├── src/
│   ├── index.ts                         # 包导出入口
│   ├── types.ts                         # 所有公共类型定义
│   │
│   ├── classification/                  # 文件类型分类
│   │   ├── classifier.ts                #   分类器主逻辑
│   │   ├── type-registry.ts            #   类型注册表
│   │   └── configs/                     #   每种类型的配置
│   │       ├── document.config.ts
│   │       ├── spreadsheet.config.ts
│   │       ├── image.config.ts
│   │       ├── cad.config.ts
│   │       ├── code.config.ts
│   │       ├── data.config.ts
│   │       ├── web.config.ts
│   │       ├── diagram.config.ts
│   │       ├── archive.config.ts
│   │       └── other.config.ts
│   │
│   ├── extraction/                      # 内容提取（按类型分发）
│   │   ├── extractor-interface.ts
│   │   ├── extractor-factory.ts
│   │   ├── document-extractor.ts
│   │   ├── spreadsheet-extractor.ts
│   │   ├── image-extractor.ts           #   OCR + Vision 双通道
│   │   ├── cad-extractor.ts
│   │   ├── code-extractor.ts
│   │   ├── data-extractor.ts
│   │   ├── diagram-extractor.ts
│   │   └── fallback-extractor.ts
│   │
│   ├── chunking/                        # 文本分块（按类型策略）
│   │   ├── chunker-interface.ts
│   │   ├── chunker-factory.ts
│   │   ├── semantic-chunker.ts          #   文档/代码：语义边界分块
│   │   ├── sliding-window-chunker.ts    #   通用：滑动窗口
│   │   ├── structured-chunker.ts        #   JSON/CSV：结构化分块
│   │   └── single-chunk.ts              #   图片/图表：单块
│   │
│   ├── dedup/                           # 多级去重引擎
│   │   ├── dedup-engine.ts              #   主管线（四级串联）
│   │   ├── exact-dedup.ts               #   L1: SHA-256 精确去重
│   │   ├── content-dedup.ts             #   L2: 归一化内容去重
│   │   ├── near-dedup.ts                #   L3: MinHash+LSH 近似去重
│   │   ├── relationship-detector.ts     #   L4: 元数据关系检测
│   │   └── minhash.ts                   #   MinHash 实现
│   │
│   ├── relationship/                    # 文件关系管理
│   │   ├── relationship-manager.ts      #   关系 CRUD
│   │   ├── relationship-store.ts        #   SQLite 持久化
│   │   ├── version-chain.ts             #   版本链管理
│   │   └── graph-builder.ts             #   关系图数据构建
│   │
│   ├── vector/                          # 向量存储层
│   │   ├── vector-store-interface.ts    #   抽象接口
│   │   ├── chroma-store.ts              #   ChromaDB 实现
│   │   ├── milvus-store.ts              #   Milvus 实现（可选）
│   │   ├── collection-manager.ts        #   多集合生命周期管理
│   │   └── factory.ts                   #   工厂函数
│   │
│   ├── search/                          # 搜索层
│   │   ├── federation-search.ts         #   跨集合联合搜索
│   │   ├── hybrid-reranker.ts           #   向量+关键词混合重排序
│   │   ├── search-builder.ts            #   搜索条件构建器
│   │   └── context-source.ts            #   ContextSource 实现
│   │
│   ├── daemon/                          # 数据库守护进程管理
│   │   ├── chroma-daemon.ts             #   ChromaDB 进程生命周期
│   │   └── docker-daemon.ts             #   Docker 容器管理（Milvus）
│   │
│   ├── server/                          # Web Dashboard
│   │   ├── index.ts                     #   Express 入口
│   │   ├── routes/
│   │   │   ├── stats.ts                 #   /api/kb/stats
│   │   │   ├── files.ts                 #   /api/kb/files (CRUD)
│   │   │   ├── search.ts                #   /api/kb/search
│   │   │   ├── dedup.ts                 #   /api/kb/dedup
│   │   │   ├── relationships.ts         #   /api/kb/relationships
│   │   │   ├── collections.ts           #   /api/kb/collections
│   │   │   ├── tags.ts                  #   /api/kb/tags
│   │   │   └── versions.ts              #   /api/kb/versions
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   └── error-handler.ts
│   │   └── ui/                          #   前端 SPA (无构建)
│   │       ├── index.html
│   │       ├── css/
│   │       │   └── dashboard.css
│   │       └── js/
│   │           ├── app.js
│   │           ├── api.js
│   │           ├── router.js
│   │           ├── components/
│   │           │   ├── file-tree.js
│   │           │   ├── file-detail.js
│   │           │   ├── chunk-viewer.js
│   │           │   ├── search-bar.js
│   │           │   ├── search-results.js
│   │           │   ├── dedup-panel.js
│   │           │   ├── relationship-graph.js
│   │           │   ├── version-timeline.js
│   │           │   └── stats-bar.js
│   │           └── utils.js
│   │
│   ├── integration/                     # 与 Agent 系统的集成
│   │   ├── agent-tools.ts               #   Agent 工具定义 + handler
│   │   └── context-source.ts            #   ContextSource 实现
│   │
│   ├── core/                            # 核心管理器
│   │   ├── knowledge-base-manager.ts    #   主管理器（对外 API）
│   │   ├── change-tracker.ts            #   变更检测 + Diff 计算
│   │   ├── incremental-indexer.ts       #   增量索引流水线
│   │   ├── file-discovery.ts            #   文件扫描 + .kbignore
│   │   └── file-watcher.ts              #   chokidar 文件监听
│   │
│   └── utils/
│       ├── hash.ts                      #   SHA-256, 归一化哈希
│       ├── text-normalizer.ts           #   文本归一化
│       ├── language-detector.ts         #   语言检测
│       ├── batch.ts                     #   批量处理工具
│       └── timer.ts                     #   计时工具
```

---

## 12. API 接口完整定义

### 12.1 统计

```
GET /api/kb/stats
Response:
{
  "connected": true,
  "vectorDb": "chromadb",
  "version": "1.0.0",
  "fileCount": 127,
  "chunkCount": 3840,
  "totalSizeBytes": 15938304,
  "embeddingModel": "text-embedding-3-small",
  "dimension": 1536,
  "collections": [
    { "name": "kb_documents", "count": 904 },
    { "name": "kb_spreadsheets", "count": 280 },
    ...
  ],
  "lastFullIndexAt": 1700000000000,
  "lastIncrementalIndexAt": 1700000010000,
  "daemonStatus": "running",
  "watchEnabled": true
}
```

### 12.2 文件管理

```
GET /api/kb/files?page=1&size=50&category=document&sort=mtime_desc&search=report
Response:
{
  "total": 127,
  "page": 1,
  "size": 50,
  "items": [
    {
      "relativePath": "templates/report.pdf",
      "category": "document",
      "format": "pdf",
      "fileSize": 2516582,
      "chunkCount": 127,
      "contentHash": "a1b2c3d4...",
      "mtime": 1700000000000,
      "indexedAt": 1700000001000,
      "status": "active",
      "tags": ["年报", "财务", "2025Q3"],
      "relationships": {
        "formatVariants": ["templates/report.docx"],
        "complementary": ["Q3_审计报告.pdf"]
      }
    }
  ]
}

POST /api/kb/files
Content-Type: multipart/form-data
Body: file=<binary>, tags="tag1,tag2"
Response: { "success": true, "file": {...} }

GET /api/kb/files/:encodedPath
Response: { "file": {...}, "chunksPreview": [...], "relationships": {...} }

DELETE /api/kb/files/:encodedPath?removeSource=false
Response: { "success": true, "chunksRemoved": 127 }

PUT /api/kb/files/:encodedPath/reindex
Response: { "success": true, "newChunkCount": 127 }

PUT /api/kb/files/:encodedPath/tags
Body: { "tags": ["年报", "财务", "2026Q1"] }
Response: { "success": true }
```

### 12.3 搜索

```
POST /api/kb/search
Body:
{
  "query": "亚太地区收入增长分析",
  "topK": 10,
  "collections": ["kb_documents", "kb_spreadsheets"],
  "category": "document",
  "tags": ["财务"],
  "dateRange": { "from": 1700000000000, "to": 1800000000000 }
}
Response:
{
  "results": [
    {
      "id": "a1b2c3d4_12",
      "content": "本季度营业收入达到 12.8 亿元...",
      "filePath": "templates/report.pdf",
      "collection": "kb_documents",
      "category": "document",
      "format": "pdf",
      "chunkIndex": 12,
      "score": 0.94,
      "metadata": { ... }
    }
  ],
  "queryTimeMs": 45,
  "collectionsSearched": ["kb_documents", "kb_spreadsheets"],
  "breakdown": {
    "kb_documents": { "searched": 904, "matched": 8 },
    "kb_spreadsheets": { "searched": 280, "matched": 2 }
  }
}
```

### 12.4 去重管理

```
POST /api/kb/dedup/scan
Response:
{
  "groups": [
    {
      "type": "exact_duplicate",
      "files": ["templates/a.pdf", "archive/old/a.pdf"],
      "wastedSpaceBytes": 2516582,
      "canAutoMerge": true
    },
    {
      "type": "near_duplicate",
      "confidence": 0.96,
      "files": ["NDA_标准模板.docx", "NDA_甲方版.docx", "NDA_乙方版.docx"],
      "canAutoMerge": false
    }
  ],
  "totalWastedSpaceBytes": 5242880,
  "totalGroups": 5
}

POST /api/kb/dedup/merge
Body: { "group": {...}, "action": "merge_to_primary", "primaryFile": "..." }
Response: { "success": true, "spaceFreed": 2516582 }
```

### 12.5 关系管理

```
GET /api/kb/relationships/:encodedPath
Response:
{
  "file": "templates/report.pdf",
  "relationships": [
    {
      "type": "format_variant",
      "targetFile": "templates/report.docx",
      "confidence": 1.0,
      "userConfirmed": 0
    },
    {
      "type": "complementary",
      "targetFile": "Q3_审计报告.pdf",
      "confidence": 0.7,
      "userConfirmed": 1
    }
  ]
}

GET /api/kb/relationships/graph?category=document
Response:
{
  "nodes": [
    { "id": "templates/report.pdf", "category": "document", "size": 127 }
  ],
  "edges": [
    { "source": "templates/report.pdf", "target": "templates/report.docx", "type": "format_variant" }
  ]
}

POST /api/kb/relationships
Body: { "sourceFile": "...", "targetFile": "...", "type": "complementary" }
Response: { "success": true }

DELETE /api/kb/relationships/:id
Response: { "success": true }
```

### 12.6 标签与版本

```
GET /api/kb/tags
Response: { "tags": ["年报", "财务", "合规", "2025Q3", "2026Q1", ...] }

GET /api/kb/versions/:encodedPath
Response:
{
  "current": "security_policy_2026.pdf",
  "versions": [
    { "file": "security_policy_2024.pdf", "date": "2024-03-15", "order": 1 },
    { "file": "security_policy_2025.pdf", "date": "2025-01-10", "order": 2 },
    { "file": "security_policy_2026.pdf", "date": "2026-02-20", "order": 3, "current": true }
  ]
}

POST /api/kb/versions/:encodedPath/promote
Response: { "success": true, "newCurrent": "security_policy_2026.pdf" }
```

### 12.7 集合与索引管理

```
GET /api/kb/collections
Response:
{
  "collections": [
    { "name": "kb_documents", "count": 904, "dimension": 1536, "status": "active" }
  ]
}

POST /api/kb/reindex
Body: { "filePath"?: "templates/report.pdf" }  // 可选：只重建指定文件
Response: { "success": true, "chunksProcessed": 3840, "timeMs": 8230 }
```

---

## 13. 数据库 Schema 设计

### 13.1 ChromaDB 向量库（每集合独立）

ChromaDB 自动管理其内部结构，无需手动建表。通过客户端 API 创建集合：

```typescript
const collection = await client.getOrCreateCollection({
  name: 'kb_documents',
  metadata: { 'hnsw:space': 'cosine' },
  embeddingFunction: undefined,  // 我们自己提供 embedding
});
```

### 13.2 SQLite 辅助库 (`~/.customize-agent/knowledge.db`)

```sql
-- ──── 索引状态追踪（增量索引核心） ────

CREATE TABLE kb_index_state (
  relative_path     TEXT PRIMARY KEY,
  category          TEXT NOT NULL,
  format            TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  file_size         INTEGER NOT NULL,
  mtime             INTEGER NOT NULL,
  chunk_count       INTEGER NOT NULL DEFAULT 0,
  collection_name   TEXT NOT NULL,
  indexed_at        INTEGER NOT NULL,
  last_verified_at  INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  error_message     TEXT,
  metadata_json     TEXT
);
CREATE INDEX idx_kb_state_status ON kb_index_state(status);
CREATE INDEX idx_kb_state_category ON kb_index_state(category);
CREATE INDEX idx_kb_state_collection ON kb_index_state(collection_name);

-- ──── 文件哈希索引（L1/L2 去重） ────

CREATE TABLE kb_file_hashes (
  content_hash     TEXT PRIMARY KEY,
  file_path        TEXT NOT NULL,
  file_size        INTEGER NOT NULL,
  category         TEXT NOT NULL,
  normalized_hash  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_kb_hashes_norm ON kb_file_hashes(normalized_hash);

-- ──── MinHash 签名（L3 近似去重） ────

CREATE TABLE kb_minhash (
  file_path        TEXT PRIMARY KEY,
  signature        BLOB NOT NULL,
  shingle_count    INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

-- ──── 文件关系（L1-L4 去重 + 关系检测结果） ────

CREATE TABLE kb_relationships (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file       TEXT NOT NULL,
  target_file       TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  confidence        REAL NOT NULL DEFAULT 1.0,
  detail            TEXT,
  user_confirmed    INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  UNIQUE(source_file, target_file, relationship_type)
);
CREATE INDEX idx_rel_source ON kb_relationships(source_file);
CREATE INDEX idx_rel_target ON kb_relationships(target_file);
CREATE INDEX idx_rel_type ON kb_relationships(relationship_type);

-- ──── 用户标签 ────

CREATE TABLE kb_tags (
  file_path   TEXT NOT NULL,
  tag         TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (file_path, tag)
);
CREATE INDEX idx_tags_tag ON kb_tags(tag);

-- ──── 元数据 ────

CREATE TABLE kb_metadata (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ──── .kbignore 规则 ────

CREATE TABLE kb_ignore_rules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern   TEXT NOT NULL UNIQUE,
  enabled   INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
```

---

## 14. 分阶段实施计划

| 阶段 | 内容 | 核心交付物 | 预估工时 |
|------|------|-----------|----------|
| **Phase 1** | 基础设施 | `FileClassifier` + 类型配置 | 1-2 天 |
| | | `VectorStoreInterface` + `ChromaVectorStore` + `ChromaDaemon` | 1-2 天 |
| | | `change-tracker.ts` + `kb_index_state` 表 | 1 天 |
| **Phase 2** | 内容处理管线 | `ContentExtractor` (5 种核心格式: PDF/DOCX/MD/TXT/XLSX) + 工厂 | 2-3 天 |
| | | `TextChunker` (语义/滑动窗口/结构化) + 工厂 | 1-2 天 |
| | | `ChangeTracker.computeDiff()` + `IncrementalIndexer` 流水线 | 1-2 天 |
| **Phase 3** | 去重 + 关系 | L1 (SHA-256) + L2 (归一化) + `DedupEngine` 主管线 | 1 天 |
| | | L3 (MinHash+LSH) + L4 (relationship-detector) | 2 天 |
| | | `RelationshipManager` + `RelationshipStore` | 1 天 |
| **Phase 4** | 搜索 + Agent 集成 | `FederationSearch` + `HybridReranker` | 1-2 天 |
| | | `KnowledgeBaseManager` 主管理器 | 1 天 |
| | | `ContextSource` + `Agent Tools` 集成 | 1 天 |
| **Phase 5** | Web Dashboard | Express Server + REST API (所有路由) | 2-3 天 |
| | | SPA 前端 (文件列表 + 详情 + 搜索 + 去重面板 + 关系图谱) | 3-5 天 |
| **Phase 6** | CLI 集成 + 完善 | Banner + `/kb` REPL 命令 + `FileWatcher` | 1-2 天 |
| | | 更多提取格式 (CAD/图片OCR/图表) | 2-3 天 |
| | | 测试 + 文档 + 性能优化 | 2-3 天 |

> **总预估**: 4-6 周（全职）；Phase 1-4 为核心功能（2-3 周），Phase 5-6 为增强体验（2-3 周）

---

## 15. 附录：关键类型定义

```typescript
// packages/knowledge/src/types.ts

// ──── 文件分类 ────

export type FileCategory =
  | 'document' | 'spreadsheet' | 'image' | 'cad'
  | 'code' | 'data' | 'web' | 'diagram' | 'archive' | 'other';

export interface ClassifiedFile {
  absolutePath: string;
  relativePath: string;
  category: FileCategory;
  format: string;
  fileSize: number;
  mtime: number;
  mimeType: string;
  contentHash?: string;
}

// ──── 内容提取 ────

export interface ExtractionResult {
  text: string;
  metadata: Record<string, unknown>;
  warnings: string[];
  extractionTimeMs: number;
}

// ──── 文本分块 ────

export interface TextChunk {
  index: number;
  text: string;
  startChar: number;
  endChar: number;
  sectionTitle?: string;
  tokenCount: number;
}

export interface ChunkConfig {
  maxChunkSize: number;       // tokens
  overlap: number;            // tokens
  splitOn?: RegExp[];         // 语义边界正则
  headerInjection?: boolean;  // 是否注入文件路径/章节标题
}

// ──── 向量存储 ────

export interface VectorDocument {
  id: string;
  content: string;
  embedding?: number[];
  metadata: {
    file_path: string;
    file_type: string;
    chunk_index: number;
    start_char: number;
    end_char: number;
    title?: string;
    tags?: string[];
    indexed_at: number;
  };
}

export interface SearchQuery {
  queryEmbedding: number[];
  topK: number;
  where?: Record<string, unknown>;
}

export interface SearchResult {
  document: VectorDocument;
  score: number;
  collection: string;
}

// ──── 去重关系 ────

export type RelationshipType =
  | 'exact_duplicate' | 'format_variant' | 'translation'
  | 'near_duplicate' | 'revision'
  | 'version_chain' | 'derived' | 'complementary';

export interface FileRelationship {
  id?: number;
  sourceFile: string;
  targetFile: string;
  relationshipType: RelationshipType;
  confidence: number;
  detail?: string;
  userConfirmed: number;  // 0=auto, 1=confirmed, -1=rejected
}

// ──── 变更追踪 ────

export interface DiffResult {
  newFiles: ClassifiedFile[];
  modifiedFiles: ClassifiedFile[];
  deletedFiles: IndexStateRecord[];
  unchangedCount: number;
  mtimeOnlyCount: number;
  skippedFiles: Array<{ file: ClassifiedFile; reason: string }>;
  hasChanges: boolean;
  diffTimeMs: number;
}

export interface IndexStateRecord {
  relativePath: string;
  category: string;
  format: string;
  contentHash: string;
  fileSize: number;
  mtime: number;
  chunkCount: number;
  collectionName: string;
  indexedAt: number;
  lastVerifiedAt: number;
  status: 'active' | 'outdated' | 'error' | 'deleted';
  errorMessage?: string;
}

// ──── 知识库统计 ────

export interface KnowledgeBaseStats {
  initialized: boolean;
  fileCount: number;
  chunkCount: number;
  totalSizeBytes: number;
  embeddingModel: string;
  dimension: number;
  collections: CollectionStats[];
  dedupGroups: number;
  wastedSpaceBytes: number;
  lastIndexedAt: number;
  lastIncrementalAt: number;
}

export interface CollectionStats {
  name: string;
  documentCount: number;
  dimension: number;
  status: 'active' | 'error';
}

// ──── 知识库配置 ────

export interface KnowledgeBaseConfig {
  projectRoot: string;
  provider: ILLMProvider;
  collections: Map<FileCategory, VectorStoreInterface>;
  dedup: DedupConfig;
  storageDir: string;
  autoIndex: boolean;
  watch: boolean;
  dashboard?: DashboardConfig;
}

export interface DedupConfig {
  exactDedup: boolean;
  contentDedup: boolean;
  nearDedup: boolean;
  nearDedupThreshold: number;   // 默认 0.85
  relationshipDetection: boolean;
}

export interface DashboardConfig {
  port: number;                  // 默认 9730
  autoStart: boolean;           // CLI 启动时自动启 Dashboard
  openBrowser: boolean;         // 是否自动打开浏览器
  requireAuth: boolean;         // 是否需要 token 认证
}
```

---

## 文档版本

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v3.0 | 2026-06-30 | 完整版：类型分类 + 四级去重 + 关系补充 + 增量索引 |

---