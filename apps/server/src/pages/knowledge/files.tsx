import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppLocale, useAppTranslations } from '@/components/Layout';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Card, Table, Button, Input, Select, Tag, Modal, Space, App, Progress, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { UploadOutlined, SearchOutlined, DeleteOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, FolderOutlined, FolderOpenOutlined, FileOutlined, FileTextOutlined, FileImageOutlined, FileExcelOutlined, FileWordOutlined, CodeOutlined, GlobalOutlined, DatabaseOutlined, HddOutlined } from '@ant-design/icons';
import { getJob, getKbFiles, getKbOperations, getKbUploadProgress, clearKbOperations, deleteKbOperation, deleteKbFile, deleteKbFiles, deleteKbSelection, deleteAllKbFiles, uploadKbFiles, reindexKb, reindexKbFile, type KbFileItem, type KbOperationRecord } from '@/lib/api';
import { formatBytes, categoryLabel } from '@/lib/utils';
import styles from './style.module.scss';

const CATEGORIES = ['document', 'spreadsheet', 'image', 'cad', 'code', 'data', 'web', 'diagram', 'other'] as const;
const ARCHIVE_FILE_PATTERN = /\.(zip|jar|war|apk|tar|gz|tgz|bz2|rar|7z)$/iu;
type StatusItem = {
  id?: string;
  type: 'upload' | 'delete' | 'reindex' | 'error';
  title: string;
  description: string;
  status: 'success' | 'processing' | 'warning' | 'error';
  percent?: number;
  filePath?: string;
  chunkCount?: number;
  textLength?: number;
  extractionMode?: string;
  error?: string;
  createdAt?: number;
};

export default function FilesPage() {
  const t = useAppTranslations('knowledge');
  const { locale } = useAppLocale();
  const { message } = App.useApp();
  const router = useRouter();
  const initialCategory = typeof router.query.category === 'string' ? router.query.category : '';

  const [files, setFiles] = useState<KbFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState(initialCategory);
  const [uploading, setUploading] = useState(false);
  const [reindexingAll, setReindexingAll] = useState(false);
  const [statusItems, setStatusItems] = useState<StatusItem[]>([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [statusFilter, setStatusFilter] = useState<'all' | 'processing' | 'success' | 'error'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'user' | 'builtIn'>('user');
  const [statusCollapsed, setStatusCollapsed] = useState(true);
  const [expandedRowKeys, setExpandedRowKeys] = useState<React.Key[]>([]);
  const [reindexingFiles, setReindexingFiles] = useState<Set<string>>(new Set());
  const categoryRef = useRef(category);

  useEffect(() => { categoryRef.current = category; }, [category]);
  useEffect(() => {
    const nextCategory = typeof router.query.category === 'string' ? router.query.category : '';
    setCategory(nextCategory);
  }, [router.query.category]);

  const loadFiles = useCallback(async (cat?: string) => {
    const c = cat ?? categoryRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const r = await getKbFiles({ category: c || undefined, limit: 200 });
      setFiles(r.files || []);
      if (r.initializing) {
        window.setTimeout(() => { void loadFiles(c); }, 1500);
      }
    } catch (error) {
      setFiles([]);
      setLoadError(error instanceof Error ? error.message : '文件列表加载失败');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadFiles(category); }, [category, loadFiles]);

  const mapOperation = (record: KbOperationRecord): StatusItem => ({
    id: record.id,
    type: record.type,
    title: record.title,
    description: record.message,
    status: record.status,
    percent: record.percent,
    filePath: record.filePath,
    chunkCount: record.chunkCount,
    textLength: record.textLength,
    extractionMode: record.extractionMode,
    error: record.error,
    createdAt: record.createdAt,
  });

  const loadOperations = useCallback(async () => {
    try {
      const result = await getKbOperations();
      const operationItems = result.operations.map(mapOperation);
      setStatusItems(items => {
        const operationIds = new Set(operationItems.map(item => item.id).filter(Boolean));
        const localItems = items.filter(item => item.id && !operationIds.has(item.id) && item.status === 'processing');
        return [...operationItems, ...localItems].slice(0, 50);
      });
    } catch { /* ignore operation log load failure */ }
  }, []);

  const upsertStatusItem = useCallback((next: StatusItem, aliases: string[] = []) => {
    setStatusItems(items => {
      const index = items.findIndex(item => (next.id && item.id === next.id) || aliases.includes(item.title));
      if (index >= 0) {
        const updated = [...items];
        updated[index] = { ...items[index], ...next, createdAt: items[index]!.createdAt ?? next.createdAt };
        return updated;
      }
      return [next, ...items].slice(0, 50);
    });
  }, []);

  useEffect(() => { void loadOperations(); }, [loadOperations]);

  const handleClearOperations = async () => {
    try {
      await clearKbOperations();
      setStatusItems([]);
      message.success('任务状态已清空');
    } catch {
      message.error('清空任务状态失败');
    }
  };

  const toggleExpand = (key: string) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const dismissItem = async (item: StatusItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.id) {
      try { await deleteKbOperation(item.id); } catch { /* ignore */ }
    }
    setStatusItems(prev => prev.filter(s => s !== item));
  };

  const statusStats = useMemo(() => {
    let processing = 0, success = 0, error = 0;
    for (const item of statusItems) {
      if (item.status === 'processing') processing++;
      else if (item.status === 'success') success++;
      else if (item.status === 'error' || item.status === 'warning') error++;
    }
    return { processing, success, error };
  }, [statusItems]);

  useEffect(() => {
    if (statusStats.processing > 0) setStatusCollapsed(false);
  }, [statusStats.processing]);
  useEffect(() => {
    if (statusStats.processing === 0) return;
    const timer = window.setInterval(() => {
      void loadOperations();
      void loadFiles();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadFiles, loadOperations, statusStats.processing]);

  const filteredStatusItems = statusFilter === 'all'
    ? statusItems
    : statusItems.filter(item => {
        if (statusFilter === 'processing') return item.status === 'processing';
        if (statusFilter === 'success') return item.status === 'success';
        if (statusFilter === 'error') return item.status === 'error' || item.status === 'warning';
        return true;
      });

  const fileMeta = (item?: KbFileItem) => {
    if (!item) return {};
    let meta: Record<string, unknown> = {};
    try { meta = item.metadataJson ? JSON.parse(item.metadataJson) as Record<string, unknown> : {}; } catch { /* ignore */ }
    const extraction = typeof meta.extraction === 'object' && meta.extraction ? meta.extraction as Record<string, unknown> : meta;
    return {
      textLength: typeof extraction.textLength === 'number' ? extraction.textLength : undefined,
      extractionMode: typeof extraction.extractionMode === 'string' ? extraction.extractionMode : undefined,
    };
  };

  const handleUpload = async (uploadFilesList: File[]) => {
    const allowedFiles = uploadFilesList.filter(file => !ARCHIVE_FILE_PATTERN.test(file.name));
    const skippedCount = uploadFilesList.length - allowedFiles.length;
    if (skippedCount > 0) message.warning(`已跳过 ${skippedCount} 个压缩包，请解压后上传内部文件`);
    if (allowedFiles.length === 0) return;
    const titleName = allowedFiles.length === 1 ? allowedFiles[0]!.name : `${allowedFiles.length} 个文件`;
    setUploading(true);
    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    upsertStatusItem({ id: uploadId, type: 'upload', title: `上传 ${titleName}`, description: '等待上传、解析、切片和入库', status: 'processing', percent: 5 });
    let done = false;
    let progressFailureCount = 0;
    const refreshProgress = async () => {
      const progress = await getKbUploadProgress(uploadId);
      progressFailureCount = 0;
      const status = progress.stage === 'error' ? 'error' : progress.stage === 'done' ? 'success' : 'processing';
      upsertStatusItem({ id: uploadId, type: status === 'error' ? 'error' : 'upload', title: status === 'success' ? `上传完成 ${titleName}` : `上传 ${titleName}`, description: `${progress.message}${progress.chunkCount ? `，${progress.chunkCount} 个切片` : ''}`, status, percent: progress.percent });
      if (progress.stage === 'done' || progress.stage === 'error') done = true;
      return progress;
    };
    const handleProgressError = (error: unknown) => {
      progressFailureCount += 1;
      if (progressFailureCount >= 5) {
        done = true;
        const description = error instanceof Error ? error.message : '进度查询失败';
        upsertStatusItem({ id: uploadId, type: 'error', title: `上传失败 ${titleName}`, description, status: 'error', percent: 100 });
      }
    };
    const poll = setInterval(() => { void refreshProgress().catch(handleProgressError); }, 700);
    try {
      await uploadKbFiles(allowedFiles, undefined, uploadId);
      message.info('文件已上传，正在后台解析、切片和入库');
      for (let i = 0; i < 240 && !done; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        await refreshProgress().catch(handleProgressError);
      }
      setSearchQuery('');
      setCategory('');
      setSelectedRowKeys([]);
      categoryRef.current = '';
      await loadFiles();
      await loadOperations();
      if (done) message.success('上传索引流程已完成');
    } catch (error) {
      const description = error instanceof Error ? error.message : '请重试或检查文件格式';
      message.error(description || '上传失败');
      upsertStatusItem({ id: uploadId, type: 'error', title: `上传失败 ${titleName}`, description, status: 'error', percent: 100 });
    }
    finally { clearInterval(poll); setUploading(false); }
  };

  const handleReindexAll = async () => {
    setReindexingAll(true);
    const localReindexId = `reindex-ui-${Date.now()}`;
    upsertStatusItem({ id: localReindexId, type: 'reindex', title: '重新解析入库', description: '正在提交后台任务', status: 'processing', percent: 5 });
    try {
      const result = await reindexKb();
      const reindexId = result.operationId || localReindexId;
      const initialJob = result.job;
      message.info(result.alreadyRunning ? '已有重新解析任务正在后台执行' : '已提交重新解析入库任务，可在顶部“后台任务”查看进度');
      upsertStatusItem({
        id: reindexId,
        type: 'reindex',
        title: initialJob?.title || '重新解析入库',
        description: initialJob?.message || '后台将重新扫描文件、解析、切片并重建索引',
        status: initialJob?.status || 'processing',
        percent: initialJob?.percent ?? 10,
        error: initialJob?.error,
      }, ['重新解析入库']);

      for (let i = 0; i < 360; i++) {
        const current = await getJob(reindexId).then(response => response.job).catch(async () => {
          const operations = await getKbOperations();
          return operations.operations.find(item => item.id === reindexId);
        });
        if (current) {
          const done = current.status === 'success' || current.status === 'error';
          upsertStatusItem({
            id: reindexId,
            type: current.status === 'error' ? 'error' : 'reindex',
            title: current.status === 'success' ? '重新解析入库完成' : current.status === 'error' ? '重新解析入库失败' : current.title,
            description: current.error || current.message,
            status: current.status,
            percent: current.percent,
            filePath: current.filePath,
            chunkCount: current.chunkCount,
            error: current.error,
          });
          if (done) {
            if (current.status === 'success') message.success(current.message || '重新解析入库完成');
            else message.error(current.error || current.message || '重新解析入库失败');
            break;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await loadFiles();
      await loadOperations();
    } catch (error) {
      const description = error instanceof Error ? error.message : '重新解析入库失败';
      message.error(description);
      upsertStatusItem({ id: localReindexId, type: 'error', title: '重新解析入库失败', description, status: 'error', percent: 100 }, ['重新解析入库', '重新解析入库完成', '重新解析入库失败']);
    } finally {
      setReindexingAll(false);
    }
  };

  const handleReindexFile = async (record: KbFileItem) => {
    if (record.builtIn) {
      message.info('内置示例资料不可重新解析');
      return;
    }
    const localId = `file-reindex-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setReindexingFiles(prev => new Set(prev).add(record.relativePath));
    upsertStatusItem({ id: localId, type: 'reindex', title: `重新解析 ${record.relativePath}`, description: '正在提交单文件后台任务', status: 'processing', percent: 5, filePath: record.relativePath });
    try {
      const result = await reindexKbFile(record.relativePath);
      const operationId = result.operationId || localId;
      const initialJob = result.job;
      message.info(result.alreadyRunning ? '已有知识库任务正在后台执行' : '已提交单文件重新解析任务');
      upsertStatusItem({
        id: operationId,
        type: 'reindex',
        title: initialJob?.title || `重新解析 ${record.relativePath}`,
        description: initialJob?.message || '后台将重新解析、分块并入库该文件',
        status: initialJob?.status || 'processing',
        percent: initialJob?.percent ?? 10,
        filePath: initialJob?.filePath || record.relativePath,
        chunkCount: initialJob?.chunkCount,
        error: initialJob?.error,
      }, [`重新解析 ${record.relativePath}`]);

      for (let i = 0; i < 240; i++) {
        const current = await getJob(operationId).then(response => response.job).catch(async () => {
          const operations = await getKbOperations();
          return operations.operations.find(item => item.id === operationId);
        });
        if (current) {
          const done = current.status === 'success' || current.status === 'error';
          upsertStatusItem({
            id: operationId,
            type: current.status === 'error' ? 'error' : 'reindex',
            title: current.status === 'success' ? `重新解析完成 ${record.relativePath}` : current.status === 'error' ? `重新解析失败 ${record.relativePath}` : current.title,
            description: current.error || current.message,
            status: current.status,
            percent: current.percent,
            filePath: current.filePath || record.relativePath,
            chunkCount: current.chunkCount,
            error: current.error,
          });
          await loadFiles();
          if (done) {
            if (current.status === 'success') message.success(current.message || '单文件重新解析完成');
            else message.error(current.error || current.message || '单文件重新解析失败');
            break;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await loadFiles();
      await loadOperations();
    } catch (error) {
      const description = error instanceof Error ? error.message : '单文件重新解析失败';
      message.error(description);
      upsertStatusItem({ id: localId, type: 'error', title: `重新解析失败 ${record.relativePath}`, description, status: 'error', percent: 100, filePath: record.relativePath }, [`重新解析 ${record.relativePath}`]);
    } finally {
      setReindexingFiles(prev => {
        const next = new Set(prev);
        next.delete(record.relativePath);
        return next;
      });
    }
  };

  const handleDelete = (record: KbFileItem) => {
    if (record.builtIn) {
      message.info('内置示例资料不可删除');
      return;
    }
    Modal.confirm({
      title: t('delete'),
      content: t('deleteConfirm'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setStatusItems(items => [{ type: 'delete', title: `删除 ${record.relativePath}`, description: '正在删除文件记录', status: 'processing' } satisfies StatusItem, ...items].slice(0, 50));
        try {
          await deleteKbFile(record.relativePath);
          message.success('已删除');
          setStatusItems(items => [{ type: 'delete', title: `删除完成 ${record.relativePath}`, description: '文件和索引记录已移除', status: 'success' } satisfies StatusItem, ...items].slice(0, 50));
          setSelectedRowKeys(keys => keys.filter(key => key !== record.relativePath));
          await loadFiles();
          await loadOperations();
        }
        catch { message.error('删除失败'); setStatusItems(items => [{ type: 'error', title: `删除失败 ${record.relativePath}`, description: '请重试', status: 'error' } satisfies StatusItem, ...items].slice(0, 50)); }
      },
    });
  };

  const handleBulkDelete = (mode: 'selected' | 'filtered' | 'all') => {
    const targets = mode === 'selected'
      ? selectedUserTargets
      : mode === 'filtered' ? filtered.filter(file => !file.builtIn).map(file => file.relativePath) : [];
    const userFileCount = files.filter(file => !file.builtIn).length;
    if (mode !== 'all' && targets.length === 0) { message.info('没有可删除的用户文件'); return; }
    if (mode === 'all' && userFileCount === 0) { message.info('没有可删除的用户文件'); return; }
    const title = mode === 'all' ? `删除全部用户文件 ${userFileCount} 个？` : mode === 'filtered' ? `删除当前筛选结果中的用户文件 ${targets.length} 个？` : `删除已选用户文件 ${targets.length} 个？`;
    Modal.confirm({
      title,
      content: '将同时删除文件、切片、索引和向量记录。此操作不可撤销。',
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setStatusItems(items => [{ type: 'delete', title, description: '正在批量删除文件和索引', status: 'processing', percent: 10 } satisfies StatusItem, ...items].slice(0, 50));
        try {
          const result = mode === 'all' ? await deleteAllKbFiles() : mode === 'selected' ? await deleteKbSelection(selectedFilePaths, selectedFolderPaths) : await deleteKbFiles(targets);
          const deletedCount = result.deleted ?? (mode === 'all' ? userFileCount : targets.length);
          message.success(`已删除 ${deletedCount} 个文件`);
          setSelectedRowKeys([]);
          setStatusItems(items => [{ type: 'delete', title: '批量删除完成', description: `已删除 ${deletedCount} 个文件、切片和索引`, status: 'success' } satisfies StatusItem, ...items].slice(0, 50));
          await loadFiles();
          await loadOperations();
        } catch {
          message.error('批量删除失败');
          setStatusItems(items => [{ type: 'error', title: '批量删除失败', description: '请重试', status: 'error' } satisfies StatusItem, ...items].slice(0, 50));
        }
      },
    });
  };

  const sourceFiltered = useMemo(() => sourceFilter === 'all'
    ? files
    : files.filter(file => sourceFilter === 'builtIn' ? file.builtIn : !file.builtIn), [files, sourceFilter]);
  const filtered = useMemo(() => searchQuery
    ? sourceFiltered.filter((f) => f.relativePath.toLowerCase().includes(searchQuery.toLowerCase()))
    : sourceFiltered, [searchQuery, sourceFiltered]);
  const userFiles = useMemo(() => files.filter(file => !file.builtIn), [files]);
  const builtInFiles = useMemo(() => files.filter(file => file.builtIn), [files]);
  const filteredUserFiles = useMemo(() => filtered.filter(file => !file.builtIn), [filtered]);
  const filteredBuiltInFiles = useMemo(() => filtered.filter(file => file.builtIn), [filtered]);
  const visibleFileKeys = useMemo(() => new Set(filtered.map(file => file.relativePath)), [filtered]);

  // ── 树形文件列表 ──
  interface FileTreeNode {
    key: string;
    name: string;
    isFolder: boolean;
    fileCount?: number;
    userFileCount?: number;
    totalSize?: number;
    totalChunks?: number;
    children?: FileTreeNode[];
    file?: KbFileItem;
  }

  const treeData = useMemo<FileTreeNode[]>(() => {
    const root: Record<string, FileTreeNode> = {};
    const sorted = [...filtered].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    for (const file of sorted) {
      const parts = file.relativePath.split('/');
      let path = '';
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i]!;
        const parentPath = path;
        path = path ? `${path}/${seg}` : seg;
        const isLast = i === parts.length - 1;

        if (!root[path]) {
          root[path] = {
            key: path, name: seg, isFolder: !isLast,
            ...(isLast
              ? { file, fileCount: 1, userFileCount: file.builtIn ? 0 : 1, totalSize: file.fileSize, totalChunks: file.chunkCount }
              : { children: [], fileCount: 0, userFileCount: 0, totalSize: 0, totalChunks: 0 }),
          };
          if (parentPath && root[parentPath]?.children) {
            (root[parentPath]!.children as FileTreeNode[]).push(root[path]!);
          }
        } else if (!isLast && !root[path]!.isFolder) {
          // 文件 → 升级为文件夹（发现同名路径下有子文件）
          root[path]!.isFolder = true;
          root[path]!.children = [];
          root[path]!.fileCount = 0;
          root[path]!.userFileCount = 0;
          root[path]!.totalSize = 0;
          root[path]!.totalChunks = 0;
        } else if (isLast) {
          root[path]!.isFolder = false;
          root[path]!.file = file;
          root[path]!.fileCount = 1;
          root[path]!.userFileCount = file.builtIn ? 0 : 1;
          root[path]!.totalSize = file.fileSize;
          root[path]!.totalChunks = file.chunkCount;
        }
      }
    }

    // 向上聚合文件夹统计
    const aggregate = (nodes: FileTreeNode[]) => {
      for (const node of nodes) {
        if (node.children) {
          aggregate(node.children);
          let fc = 0, ufc = 0, ts = 0, tc = 0;
          for (const child of node.children) { fc += child.fileCount ?? 0; ufc += child.userFileCount ?? 0; ts += child.totalSize ?? 0; tc += child.totalChunks ?? 0; }
          node.fileCount = fc;
          node.userFileCount = ufc;
          node.totalSize = ts;
          node.totalChunks = tc;
        }
      }
    };
    const pruneEmptyFolders = (nodes: FileTreeNode[]): FileTreeNode[] => nodes
      .map(node => node.children ? { ...node, children: pruneEmptyFolders(node.children) } : node)
      .filter(node => !node.isFolder || ((node.fileCount ?? 0) > 0 && (node.children?.length ?? 0) > 0));
    const topLevel = Object.values(root).filter(n => !n.key.includes('/'));
    aggregate(topLevel);
    return pruneEmptyFolders(topLevel);
  }, [filtered]);

  const allTreeKeys = useMemo(() => {
    const keys: string[] = [];
    const walk = (nodes: FileTreeNode[]) => {
      for (const n of nodes) { keys.push(n.key); if (n.children) walk(n.children); }
    };
    walk(treeData);
    return keys;
  }, [treeData]);
  const visibleItemKeys = useMemo(() => new Set([...visibleFileKeys, ...allTreeKeys]), [allTreeKeys, visibleFileKeys]);
  const selectedFolderPaths = useMemo(() => selectedRowKeys.map(String).filter(key => !visibleFileKeys.has(key) && allTreeKeys.includes(key)), [allTreeKeys, selectedRowKeys, visibleFileKeys]);
  const selectedFilePaths = useMemo(() => selectedRowKeys.map(String).filter(key => visibleFileKeys.has(key)), [selectedRowKeys, visibleFileKeys]);
  const selectedUserTargets = useMemo(() => {
    const targets = new Set<string>();
    for (const key of selectedFilePaths) {
      const file = files.find(item => item.relativePath === key);
      if (file && !file.builtIn) targets.add(file.relativePath);
    }
    for (const folder of selectedFolderPaths) {
      const prefix = `${folder}/`;
      for (const file of files) {
        if (!file.builtIn && file.relativePath.startsWith(prefix)) targets.add(file.relativePath);
      }
    }
    return Array.from(targets);
  }, [files, selectedFilePaths, selectedFolderPaths]);
  const selectedUserCount = selectedUserTargets.length;

  useEffect(() => {
    setSelectedRowKeys(keys => keys.filter(key => visibleItemKeys.has(String(key))));
  }, [visibleItemKeys]);

  const defaultExpandedKeys = useMemo(() => {
    if (searchQuery) return allTreeKeys;
    return treeData.map(n => n.key);
  }, [searchQuery, allTreeKeys, treeData]);

  useEffect(() => { setExpandedRowKeys(defaultExpandedKeys); }, [defaultExpandedKeys]);

  const handleExpand = (expanded: boolean, record: FileTreeNode) => {
    setExpandedRowKeys(prev => expanded ? [...prev, record.key] : prev.filter(k => k !== record.key));
  };

  const getFileIcon = (file?: KbFileItem) => {
    if (!file) return <FileOutlined style={{ fontSize: 15 }} />;
    const cat = file.category;
    if (cat === 'image') return <FileImageOutlined style={{ color: '#eb2f96', fontSize: 15 }} />;
    if (cat === 'spreadsheet') return <FileExcelOutlined style={{ color: '#52c41a', fontSize: 15 }} />;
    if (cat === 'document') return <FileWordOutlined style={{ color: '#1677ff', fontSize: 15 }} />;
    if (cat === 'code') return <CodeOutlined style={{ color: '#fa8c16', fontSize: 15 }} />;
    if (cat === 'archive') return <HddOutlined style={{ color: '#8c8c8c', fontSize: 15 }} />;
    if (cat === 'web') return <GlobalOutlined style={{ color: '#13c2c2', fontSize: 15 }} />;
    if (cat === 'data') return <DatabaseOutlined style={{ color: '#722ed1', fontSize: 15 }} />;
    if (cat === 'cad') return <FolderOutlined style={{ color: '#fa541c', fontSize: 15 }} />;
    if (cat === 'diagram') return <FileImageOutlined style={{ color: '#a0d911', fontSize: 15 }} />;
    return <FileTextOutlined style={{ fontSize: 15 }} />;
  };

  const getFolderIcon = (node: FileTreeNode) => {
    const children = node.children;
    if (!children || children.length === 0) return <FolderOutlined style={{ color: '#fa8c16', fontSize: 15 }} />;
    return <FolderOpenOutlined style={{ color: '#fa8c16', fontSize: 15 }} />;
  };

  const columns: ColumnsType<FileTreeNode> = [
    {
      title: t('fileName'), dataIndex: 'name', key: 'name',
      render: (_: string, r: FileTreeNode) => (
        <span className={styles.fileNameCell}>
          {r.isFolder ? (
            <span style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); handleExpand(!expandedRowKeys.includes(r.key), r); }}>
              {getFolderIcon(r)}
            </span>
          ) : getFileIcon(r.file)}
          {r.isFolder ? (
            <span className={styles.folderName} onClick={(e) => { e.stopPropagation(); handleExpand(!expandedRowKeys.includes(r.key), r); }}>{r.name}</span>
          ) : (
            <>
              {r.file?.builtIn && <Tag color="gold" style={{ fontSize: 11, lineHeight: '18px' }}>内置</Tag>}
              <Link className="truncate max-w-[380px] inline-block" href={`/knowledge/file-detail?relativePath=${encodeURIComponent(r.key)}`}>{r.name}</Link>
            </>
          )}
        </span>
      ),
    },
    {
      title: t('fileCategory'), dataIndex: 'category', key: 'cat', width: 110,
      render: (_: unknown, r: FileTreeNode) => r.isFolder
        ? <span style={{ color: 'var(--colorTextQuaternary)' }}>—</span>
        : <Tag>{categoryLabel(r.file?.category ?? '', locale)}</Tag>,
    },
    {
      title: t('fileSize'), dataIndex: 'fileSize', key: 'size', width: 90,
      render: (_: unknown, r: FileTreeNode) => formatBytes(r.isFolder ? (r.totalSize ?? 0) : (r.file?.fileSize ?? 0)),
    },
    {
      title: '切片', dataIndex: 'chunkCount', key: 'chunks', width: 80,
      render: (_: unknown, r: FileTreeNode) => {
        const count = r.isFolder ? (r.totalChunks ?? 0) : (r.file?.chunkCount ?? 0);
        return <Tag color={count > 1 ? 'green' : 'orange'}>{count}</Tag>;
      },
    },
    {
      title: '解析状态', dataIndex: 'status', key: 'status', width: 100,
      render: (_: unknown, r: FileTreeNode) => r.isFolder
        ? <span style={{ color: 'var(--colorTextQuaternary)' }}>—</span>
        : <Tag color={r.file?.status === 'active' ? 'green' : 'red'}>{r.file?.errorMessage || r.file?.status || '—'}</Tag>,
    },
    {
      title: t('fileDate'), dataIndex: 'mtime', key: 'date', width: 130,
      render: (_: unknown, r: FileTreeNode) => r.isFolder
        ? <span style={{ color: 'var(--colorTextQuaternary)' }}>—</span>
        : (r.file?.mtime ? new Date(r.file.mtime).toLocaleDateString(locale) : '—'),
    },
    {
      title: '来源', key: 'source', width: 100,
      render: (_: unknown, r: FileTreeNode) => r.isFolder
        ? <span style={{ color: 'var(--colorTextQuaternary)' }}>—</span>
        : r.file?.builtIn ? <Tag color="gold">内置示例</Tag> : <Tag color="cyan">我的文件</Tag>,
    },
    {
      title: '', key: 'act', width: 100,
      render: (_: unknown, r: FileTreeNode) => r.isFolder ? null : (
        <Space size={4}>
          <Tooltip title="重新解析、分块并入库">
            <Button type="text" size="small" disabled={r.file?.builtIn} loading={Boolean(r.file && reindexingFiles.has(r.file.relativePath))} icon={<SyncOutlined />} onClick={() => { void handleReindexFile(r.file!); }} />
          </Tooltip>
          <Button type="text" danger size="small" disabled={r.file?.builtIn} icon={<DeleteOutlined />} onClick={() => handleDelete(r.file!)} />
        </Space>
      ),
    },
  ];

  return (
    <div className="space-y-5 animateFadeIn">
      <h2 className="pageTitle">{t('files')}</h2>

      <div className="flex flex-wrap items-end gap-3">
        <Input placeholder={t('searchPlaceholder')} prefix={<SearchOutlined />} value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); }} allowClear className={styles.filterInput} />
        <Select value={category || undefined} onChange={(v) => { setCategory(v || ''); }} placeholder={t('filterCategory')} allowClear className={styles.filterSelect}
          options={[{ label: t('allCategories'), value: '' }, ...CATEGORIES.map((c) => ({ label: categoryLabel(c, locale), value: c }))]} />
        <Select value={sourceFilter} onChange={setSourceFilter} className={styles.filterSelect}
          options={[{ label: `全部来源 (${files.length})`, value: 'all' }, { label: `我的文件 (${userFiles.length})`, value: 'user' }, { label: `内置示例 (${builtInFiles.length})`, value: 'builtIn' }]} />
        <Button type="primary" icon={<UploadOutlined />} loading={uploading} onClick={() => document.getElementById('kb-file-upload-input')?.click()}>{uploading ? t('uploading') : t('upload')}</Button>
        <Button icon={<UploadOutlined />} loading={uploading} onClick={() => document.getElementById('kb-folder-upload-input')?.click()}>上传文件夹</Button>
        <Button icon={<SyncOutlined />} loading={reindexingAll} onClick={() => { void handleReindexAll(); }}>重新解析入库</Button>
        <input id="kb-file-upload-input" type="file" multiple hidden accept=".pdf,.doc,.docx,.txt,.md,.csv,.tsv,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.svg,.dwg,.dxf,.step,.stp,.iges,.igs,.js,.ts,.tsx,.jsx,.py,.go,.java,.cs,.cpp,.c,.h,.json,.jsonl,.yaml,.yml,.xml,.html,.htm,.drawio,.dio,.vsdx,.vdx,.puml,.plantuml,.mmd,.mermaid,.excalidraw" onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ''; void handleUpload(selected); }} />
        <input id="kb-folder-upload-input" type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ''; void handleUpload(selected); }} />
      </div>

      {/* 可折叠的状态卡片 */}
      <Card size="small" className={styles.statusCard} styles={{ body: { padding: 0 } }}>
        <div className={styles.statusSummary} onClick={() => setStatusCollapsed(!statusCollapsed)}>
          <span className={styles.statusSummaryText}>
            {statusItems.length === 0 ? '暂无文件任务' : (
              <Space size={6}>
                {statusStats.processing > 0 && <Tag color="processing" style={{ margin: 0 }} icon={<SyncOutlined spin />}>处理中 {statusStats.processing}</Tag>}
                <Tag color="success" style={{ margin: 0 }} icon={<CheckCircleOutlined />}>已完成 {statusStats.success}</Tag>
                <Tag color="error" style={{ margin: 0 }} icon={<CloseCircleOutlined />}>失败 {statusStats.error}</Tag>
              </Space>
            )}
          </span>
          {statusItems.length > 0 && (
            <Space size={6}>
              <Button size="small" className={styles.statusClearBtn} onClick={(e) => { e.stopPropagation(); void handleClearOperations(); }}>清空</Button>
              <Button size="small" className={styles.statusExpandBtn} onClick={(e) => { e.stopPropagation(); setStatusCollapsed(!statusCollapsed); }}>
                {statusCollapsed ? '展开' : '收起'}
              </Button>
            </Space>
          )}
        </div>

        {!statusCollapsed && statusItems.length > 0 && (
          <div className={styles.statusPanel}>
            <div className={styles.statusFilters}>
              <span className={`${styles.filterPill} ${statusFilter === 'all' ? styles.filterPillActive : ''}`} style={statusFilter === 'all' ? { color: '#1677ff' } : undefined} onClick={() => setStatusFilter('all')}>全部 <b>{statusItems.length}</b></span>
              <span className={`${styles.filterPill} ${statusFilter === 'processing' ? styles.filterPillActive : ''}`} style={statusFilter === 'processing' ? { color: '#1677ff' } : undefined} onClick={() => setStatusFilter('processing')}><SyncOutlined spin={statusStats.processing > 0} /> 处理中 <b>{statusStats.processing}</b></span>
              <span className={`${styles.filterPill} ${statusFilter === 'success' ? styles.filterPillActive : ''}`} style={statusFilter === 'success' ? { color: '#52c41a' } : undefined} onClick={() => setStatusFilter('success')}><CheckCircleOutlined /> 已完成 <b>{statusStats.success}</b></span>
              <span className={`${styles.filterPill} ${statusFilter === 'error' ? styles.filterPillActive : ''}`} style={statusFilter === 'error' ? { color: '#ff4d4f' } : undefined} onClick={() => setStatusFilter('error')}><CloseCircleOutlined /> 失败 <b>{statusStats.error}</b></span>
            </div>
            <div className={styles.timelineList}>
              {filteredStatusItems.length === 0 ? (
                <div className={styles.statusEmpty}>没有匹配的任务</div>
              ) : (
                filteredStatusItems.map((item, idx) => {
                  const key = item.id || `${item.type}-${item.createdAt ?? item.title}-${idx}`;
                  const expanded = expandedItems.has(key);
                  return (
                    <div key={key} className={styles.timelineItem}>
                      <div className={styles.timelineRow} onClick={() => toggleExpand(key)}>
                        <span className={styles.timelineStatusIcon}>
                          {item.status === 'success' ? <CheckCircleOutlined style={{ color: '#52c41a' }} />
                            : item.status === 'processing' ? <SyncOutlined spin style={{ color: '#1677ff' }} />
                            : item.status === 'error' ? <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
                            : <span style={{ color: '#fa8c16', fontWeight: 700 }}>!</span>}
                        </span>
                        <span className={styles.timelineTitle}>{item.title}</span>
                        {typeof item.percent === 'number' && item.status === 'processing' && (
                          <span className={styles.timelinePercent}>{item.percent}%</span>
                        )}
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} style={{ width: 22, height: 22, padding: 0, fontSize: 12 }} onClick={(e) => { void dismissItem(item, e); }} />
                      </div>
                      {expanded && (
                        <div className={styles.timelineDetail}>
                          {typeof item.percent === 'number' && item.status === 'processing' && <Progress percent={item.percent} size="small" strokeColor="#1677ff" />}
                          {item.description && <div className={styles.timelineDesc}>{item.description}</div>}
                          {item.error && <div style={{ color: 'var(--colorError)', fontSize: 12, wordBreak: 'break-word' }}>{item.error}</div>}
                          {item.filePath && <Tooltip title={item.filePath}><div className={styles.timelinePath}>{item.filePath}</div></Tooltip>}
                          <div className={styles.timelineMeta}>
                            {typeof item.chunkCount === 'number' && <span className={styles.timelineMetaTag}>切片 <b>{item.chunkCount}</b></span>}
                            {typeof item.textLength === 'number' && <span className={styles.timelineMetaTag}>正文 <b>{item.textLength.toLocaleString(locale)}</b> 字符</span>}
                            {item.extractionMode && <span className={styles.timelineMetaTag}>解析 <b>{item.extractionMode}</b></span>}
                          </div>
                          {item.status === 'error' && <div style={{ color: 'var(--colorError)', fontSize: 12 }}>此任务失败，请重新上传文件或重试操作</div>}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </Card>

      <Card
        title="文件列表"
        extra={
          <Space size={8}>
            <Button danger size="small" disabled={selectedUserCount === 0} icon={<DeleteOutlined />} onClick={() => handleBulkDelete('selected')}>
              删除已选 {selectedUserCount || ''}
            </Button>
            <Button danger size="small" disabled={userFiles.length === 0} onClick={() => handleBulkDelete('all')}>删除全部用户文件</Button>
          </Space>
        }
      >
        {loadError && <div className={styles.statusEmpty}>文件列表加载失败：{loadError}</div>}
        <Table<FileTreeNode> rowKey="key" columns={columns} dataSource={treeData} loading={loading} size="middle"
          expandable={{ expandedRowKeys, onExpand: handleExpand, childrenColumnName: 'children' }}
          locale={{ emptyText: loading ? '正在加载文件列表...' : searchQuery ? t('emptySearch') : t('noFiles') }}
          pagination={false}
          rowClassName={(r) => r.isFolder ? styles.folderRow : ''}
          rowSelection={{
            selectedRowKeys,
            onChange: setSelectedRowKeys,
            checkStrictly: false,
            getCheckboxProps: (record) => ({ disabled: record.isFolder ? (record.userFileCount ?? 0) === 0 : Boolean(record.file?.builtIn) }),
          }}
          footer={() => (
            <div style={{ color: 'var(--colorTextSecondary)', fontSize: 12 }}>
              当前展示 {filtered.length} 个文件，其中我的文件 {filteredUserFiles.length} 个、内置示例 {filteredBuiltInFiles.length} 个；全部我的文件 {userFiles.length} 个、内置示例 {builtInFiles.length} 个；{treeData.length} 个顶层目录
            </div>
          )} />
      </Card>
    </div>
  );
}
