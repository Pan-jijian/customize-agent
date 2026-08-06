import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppLocale, useAppTranslations } from '@/components/Layout';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Table, Button, Input, Select, Tag, Modal, Space, App, Dropdown } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { SearchOutlined, DeleteOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined, FolderOutlined, FolderOpenOutlined, FileOutlined, FileTextOutlined, FileImageOutlined, FileExcelOutlined, FileWordOutlined, CodeOutlined, GlobalOutlined, DatabaseOutlined, HddOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { getJob, getKbFiles, getKbOperations, clearKbOperations, deleteKbOperation, deleteKbFile, deleteKbFiles, deleteKbSelection, deleteAllKbFiles, uploadKbFiles, reindexKb, reindexKbFile, type KbFileItem, type KbOperationRecord } from '@/lib/api';
import { formatBytes, categoryLabel } from '@/lib/utils';
import styles from './style.module.scss';

const CATEGORIES = ['document', 'spreadsheet', 'image', 'cad', 'code', 'data', 'web', 'diagram', 'other'] as const;
const ARCHIVE_FILE_PATTERN = /\.(zip|jar|war|apk|tar|gz|tgz|bz2|rar|7z)$/iu;
const SKIPPED_UPLOAD_FILE_PATTERN = /(^|\/)\.DS_Store$|(^|\/)Thumbs\.db$|(^|\/)__MACOSX\/|\.bak$/iu;
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
  const [statusCollapsed, setStatusCollapsed] = useState(true);
  const [expandedRowKeys, setExpandedRowKeys] = useState<React.Key[]>([]);
  const [reindexingFiles, setReindexingFiles] = useState<Set<string>>(new Set());
  const categoryRef = useRef(category);

  useEffect(() => { categoryRef.current = category; }, [category]);
  useEffect(() => {
    const nextCategory = typeof router.query.category === 'string' ? router.query.category : '';
    setCategory(nextCategory);
  }, [router.query.category]);

  const loadFiles = useCallback(async (cat?: string, opts?: { silent?: boolean }) => {
    const c = cat ?? categoryRef.current;
    if (!opts?.silent) {
      setLoading(true);
      setLoadError('');
    }
    try {
      const r = await getKbFiles({ category: c || undefined, limit: 5000 });
      setFiles(r.files || []);
      if (r.initializing) {
        window.setTimeout(() => { void loadFiles(c, { silent: true }); }, 3000);
      }
    } catch (error) {
      if (!opts?.silent) {
        setFiles([]);
        setLoadError(error instanceof Error ? error.message : '文件列表加载失败');
      }
    } finally {
      if (!opts?.silent) setLoading(false);
    }
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
        const mergedOperations = operationItems.map(item => {
          const existing = items.find(current => current.id === item.id);
          return existing ? { ...existing, ...item, createdAt: existing.createdAt ?? item.createdAt } : item;
        });
        const localItems = items.filter(item => item.id && !operationIds.has(item.id) && item.status === 'processing');
        return [...mergedOperations, ...localItems].slice(0, 50);
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
    const operationsTimer = window.setInterval(() => { void loadOperations(); }, 2000);
    const filesTimer = window.setInterval(() => { void loadFiles(undefined, { silent: true }); }, 8000);
    return () => {
      window.clearInterval(operationsTimer);
      window.clearInterval(filesTimer);
    };
  }, [loadFiles, loadOperations, statusStats.processing]);

  const filteredStatusItems = statusFilter === 'all'
    ? statusItems
    : statusItems.filter(item => {
        if (statusFilter === 'processing') return item.status === 'processing';
        if (statusFilter === 'success') return item.status === 'success';
        if (statusFilter === 'error') return item.status === 'error' || item.status === 'warning';
        return true;
      });

  const handleUpload = async (uploadFilesList: File[]) => {
    const allowedFiles = uploadFilesList.filter(file => {
      const filePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      return file.size > 0 && !ARCHIVE_FILE_PATTERN.test(file.name) && !SKIPPED_UPLOAD_FILE_PATTERN.test(filePath);
    });
    const skippedCount = uploadFilesList.length - allowedFiles.length;
    if (skippedCount > 0) message.warning(`已跳过 ${skippedCount} 个空文件、系统文件、备份文件或压缩包`);
    if (allowedFiles.length === 0) return;
    const titleName = allowedFiles.length === 1 ? allowedFiles[0]!.name : `${allowedFiles.length} 个文件`;
    setUploading(true);
    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    upsertStatusItem({ id: uploadId, type: 'upload', title: `上传 ${titleName}`, description: '等待上传、解析、切片和入库；同路径文件会更新，其他已有文件不会清除', status: 'processing', percent: 5 });
    try {
      await uploadKbFiles(allowedFiles, undefined, uploadId, progress => {
        upsertStatusItem({
          id: uploadId,
          type: 'upload',
          title: `上传 ${titleName}`,
          description: `正在上传文件：${progress.uploadedFiles}/${progress.totalFiles}，批次 ${progress.batchIndex + 1}/${progress.totalBatches}`,
          status: 'processing',
          percent: Math.min(5, Math.max(1, Math.round((progress.uploadedFiles / Math.max(1, progress.totalFiles)) * 5))),
        });
      });
      message.info('文件已上传，正在后台解析、切片和入库；同路径文件会更新，其他已有文件不会清除，可在顶部“后台任务”查看进度');
      setSearchQuery('');
      setCategory('');
      setSelectedRowKeys([]);
      categoryRef.current = '';
      await loadOperations();
      window.setTimeout(() => { void loadFiles(undefined, { silent: true }); }, 2000);
    } catch (error) {
      const description = error instanceof Error ? error.message : '请重试或检查文件格式';
      message.error(description || '上传失败');
      upsertStatusItem({ id: uploadId, type: 'error', title: `上传失败 ${titleName}`, description, status: 'error', percent: 100 });
    } finally {
      setUploading(false);
    }
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
      ? selectedFileTargets
      : mode === 'filtered' ? filtered.map(file => file.relativePath) : [];
    const fileCount = files.length;
    if (mode !== 'all' && targets.length === 0) { message.info('没有可删除的文件'); return; }
    if (mode === 'all' && fileCount === 0) { message.info('没有可删除的文件'); return; }
    const title = mode === 'all' ? `删除全部文件 ${fileCount} 个？` : mode === 'filtered' ? `删除当前筛选结果中的文件 ${targets.length} 个？` : `删除已选文件 ${targets.length} 个？`;
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
          const deletedCount = result.deleted ?? (mode === 'all' ? fileCount : targets.length);
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

  const filtered = useMemo(() => searchQuery
    ? files.filter((f) => f.relativePath.toLowerCase().includes(searchQuery.toLowerCase()))
    : files, [searchQuery, files]);
  const visibleFileKeys = useMemo(() => new Set(filtered.map(file => file.relativePath)), [filtered]);

  // ── 树形文件列表 ──
  interface FileTreeNode {
    key: string;
    name: string;
    isFolder: boolean;
    fileCount?: number;
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
              ? { file, fileCount: 1, totalSize: file.fileSize, totalChunks: file.chunkCount }
              : { children: [], fileCount: 0, totalSize: 0, totalChunks: 0 }),
          };
          if (parentPath && root[parentPath]?.children) {
            (root[parentPath]!.children as FileTreeNode[]).push(root[path]!);
          }
        } else if (!isLast && !root[path]!.isFolder) {
          // 文件 → 升级为文件夹（发现同名路径下有子文件）
          root[path]!.isFolder = true;
          root[path]!.children = [];
          root[path]!.fileCount = 0;
          root[path]!.totalSize = 0;
          root[path]!.totalChunks = 0;
        } else if (isLast) {
          root[path]!.isFolder = false;
          root[path]!.file = file;
          root[path]!.fileCount = 1;
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
          let fc = 0, ts = 0, tc = 0;
          for (const child of node.children) { fc += child.fileCount ?? 0; ts += child.totalSize ?? 0; tc += child.totalChunks ?? 0; }
          node.fileCount = fc;
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
  const selectedFileTargets = useMemo(() => {
    const targets = new Set<string>();
    for (const key of selectedFilePaths) {
      const file = files.find(item => item.relativePath === key);
      if (file) targets.add(file.relativePath);
    }
    for (const folder of selectedFolderPaths) {
      const prefix = `${folder}/`;
      for (const file of files) {
        if (file.relativePath.startsWith(prefix)) targets.add(file.relativePath);
      }
    }
    return Array.from(targets);
  }, [files, selectedFilePaths, selectedFolderPaths]);
  const selectedFileCount = selectedFileTargets.length;

  useEffect(() => {
    setSelectedRowKeys(keys => keys.filter(key => visibleItemKeys.has(String(key))));
  }, [visibleItemKeys]);

  const defaultExpandedKeys = useMemo(() => {
    if (searchQuery) return allTreeKeys;
    return [];
  }, [searchQuery, allTreeKeys]);

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

  const statusTagColor = (status?: string) => {
    if (status === 'active') return 'green';
    if (status === 'processing' || status === 'indexing') return 'blue';
    if (status === 'error') return 'red';
    return 'orange';
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
              <Link className="min-w-0 max-w-[520px] whitespace-normal break-words leading-relaxed" href={`/knowledge/file-detail?relativePath=${encodeURIComponent(r.key)}`}>{r.name}</Link>
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
      title: t('chunksCount'), dataIndex: 'chunkCount', key: 'chunks', width: 80,
      render: (_: unknown, r: FileTreeNode) => {
        const count = r.isFolder ? (r.totalChunks ?? 0) : (r.file?.chunkCount ?? 0);
        return <Tag color={count > 1 ? 'green' : 'orange'}>{count}</Tag>;
      },
    },
    {
      title: t('parsingStatus'), dataIndex: 'status', key: 'status', width: 100,
      render: (_: unknown, r: FileTreeNode) => r.isFolder
        ? <span style={{ color: 'var(--colorTextQuaternary)' }}>—</span>
        : <Tag color={statusTagColor(r.file?.status)}>{r.file?.errorMessage || r.file?.status || '—'}</Tag>,
    },
    {
      title: t('fileDate'), dataIndex: 'mtime', key: 'date', width: 130,
      render: (_: unknown, r: FileTreeNode) => r.isFolder
        ? <span style={{ color: 'var(--colorTextQuaternary)' }}>—</span>
        : (r.file?.mtime ? new Date(r.file.mtime).toLocaleDateString(locale) : '—'),
    },
    {
      title: t('source'), key: 'source', width: 100,
      render: (_: unknown, r: FileTreeNode) => r.isFolder
        ? <span style={{ color: 'var(--colorTextQuaternary)' }}>—</span>
        : <Tag color="cyan">{t('fileSource')}</Tag>,
    },
    {
      title: '', key: 'act', width: 80, align: 'center',
      render: (_: unknown, r: FileTreeNode) => r.isFolder ? null : (
        <Dropdown menu={{ items: [
          { key: 'reindex', label: t('reindex'), icon: <SyncOutlined />, onClick: () => { void handleReindexFile(r.file!); } },
          { type: 'divider' },
          { key: 'delete', label: t('delete'), icon: <DeleteOutlined />, danger: true, onClick: () => handleDelete(r.file!) },
        ] }} trigger={['click']}>
          <Button type="text" size="small" icon={<MoreOutlined />} />
        </Dropdown>
      ),
    },
  ];

  const headerExtra = (
    <div className="flex flex-1 md:flex-none w-full md:w-auto items-center gap-3">
      <Input placeholder={t('searchPlaceholder')} prefix={<SearchOutlined className="text-[var(--colorTextTertiary)]" />} value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); }} allowClear className="max-w-[300px] flex-1 bg-transparent hover:bg-transparent focus:bg-transparent" bordered={false} style={{ borderBottom: '1px solid var(--borderColor)', borderRadius: 0, paddingLeft: 0, paddingRight: 0 }} />
      <Select value={category || undefined} onChange={(v) => { setCategory(v || ''); }} placeholder={t('filterCategory')} allowClear style={{ width: 140 }} variant="borderless"
        options={[{ label: t('allCategories'), value: '' }, ...CATEGORIES.map((c) => ({ label: categoryLabel(c, locale), value: c }))]} />
      <div className="w-[1px] h-6 bg-[var(--borderColor)] mx-1"></div>
      <Dropdown
        menu={{
          items: [
            { key: 'file', label: t('uploadFiles'), icon: <FileOutlined />, onClick: () => document.getElementById('kb-file-upload-input')?.click() },
            { key: 'folder', label: t('uploadFolder'), icon: <FolderOutlined />, onClick: () => document.getElementById('kb-folder-upload-input')?.click() },
            { type: 'divider' },
            { key: 'reindex', label: t('reindexAll'), icon: <SyncOutlined />, onClick: () => { void handleReindexAll(); }, danger: true },
          ]
        }}
        trigger={['click']}
      >
        <Button type="primary" icon={<PlusOutlined />} loading={uploading || reindexingAll} className="rounded-md px-4">{t('new')}</Button>
      </Dropdown>
      <input id="kb-file-upload-input" type="file" multiple hidden accept=".pdf,.doc,.docx,.txt,.md,.csv,.tsv,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.svg,.dwg,.dxf,.step,.stp,.iges,.igs,.js,.ts,.tsx,.jsx,.py,.go,.java,.cs,.cpp,.c,.h,.json,.jsonl,.yaml,.yml,.xml,.html,.htm,.drawio,.dio,.vsdx,.vdx,.puml,.plantuml,.mmd,.mermaid,.excalidraw" onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ''; void handleUpload(selected); }} />
      <input id="kb-folder-upload-input" type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ''; void handleUpload(selected); }} />
    </div>
  );

  return (
    <div className="h-[calc(100vh-140px)] flex flex-col">
      <div className="bg-[var(--colorBgContainer)] rounded-2xl border border-[var(--borderColor)] p-6 mb-4 shrink-0 animateFadeIn">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-6 border-b border-[var(--borderColor)]">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[var(--colorText)] mb-1 flex items-center gap-2">
              <DatabaseOutlined className="text-[var(--colorAccent)]" />
              {t('files')}
            </h1>
            <p className="text-sm text-[var(--colorTextSecondary)] m-0">{t('manageRawFiles')}</p>
          </div>
          {headerExtra}
        </div>

        {/* 顶部数据概览 (填充空旷感) */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 pt-6 stagger-1">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--colorBgHover)] flex items-center justify-center text-xl text-[var(--colorTextSecondary)]">
              <FolderOpenOutlined />
            </div>
            <div>
              <div className="text-[11px] font-semibold text-[var(--colorTextTertiary)] uppercase tracking-wider mb-1">{t('totalRootFolders')}</div>
              <div className="text-xl font-bold text-[var(--colorText)] leading-none">{treeData.length}</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--colorBgHover)] flex items-center justify-center text-xl text-[var(--colorTextSecondary)]">
              <FileTextOutlined />
            </div>
            <div>
              <div className="text-[11px] font-semibold text-[var(--colorTextTertiary)] uppercase tracking-wider mb-1">{t('totalFilesStats')}</div>
              <div className="text-xl font-bold text-[var(--colorText)] leading-none">{files.length}</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-green-50 dark:bg-green-900/20 flex items-center justify-center text-xl text-green-600 dark:text-green-500">
              <CheckCircleOutlined />
            </div>
            <div>
              <div className="text-[11px] font-semibold text-[var(--colorTextTertiary)] uppercase tracking-wider mb-1">{t('successfullyParsed')}</div>
              <div className="text-xl font-bold text-[var(--colorText)] leading-none">{files.filter(f => f.status === 'success').length}</div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-red-50 dark:bg-red-900/20 flex items-center justify-center text-xl text-red-600 dark:text-red-500">
              <CloseCircleOutlined />
            </div>
            <div>
              <div className="text-[11px] font-semibold text-[var(--colorTextTertiary)] uppercase tracking-wider mb-1">{t('parsingErrors')}</div>
              <div className="text-xl font-bold text-[var(--colorText)] leading-none">{files.filter(f => f.status === 'error').length}</div>
            </div>
          </div>
        </div>
      </div>

      {loadError && <div className="p-4 mb-4 bg-[var(--colorDanger)]/10 text-[var(--colorDanger)] rounded-xl border border-[var(--colorDanger)]/20">{loadError}</div>}

      <div className="flex-1 min-h-0 bg-[var(--colorBgContainer)] rounded-2xl border border-[var(--borderColor)] overflow-hidden flex flex-col animateFadeIn stagger-3" style={{ opacity: 0 }}>
        <div className="flex justify-between items-center p-4 bg-[var(--colorBgHover)] border-b border-[var(--borderColor)] shrink-0">
          <div className="text-xs text-[var(--colorTextSecondary)] font-medium">
            {t('showingMatchingFiles').replace('{count}', String(filtered.length))}
          </div>
          <Space size={8}>
            {selectedFileCount > 0 && (
              <Button danger size="small" icon={<DeleteOutlined />} onClick={() => handleBulkDelete('selected')} className="rounded-lg">
                {t('deleteSelected')} ({selectedFileCount})
              </Button>
            )}
            <Button danger size="small" disabled={files.length === 0} onClick={() => handleBulkDelete('all')} className="rounded-lg">{t('deleteAll')}</Button>
          </Space>
        </div>

        <Table<FileTreeNode>
          rowKey="key"
          columns={columns}
          dataSource={treeData}
          loading={loading && !uploading && !reindexingAll}
          size="middle"
          className="flex-1 custom-table border-0"
          scroll={{ y: 'calc(100vh - 460px)' }}
          expandable={{ 
            expandedRowKeys, 
            onExpand: handleExpand,
            expandIcon: ({ expanded, onExpand, record }) =>
              record.isFolder ? (
                <button type="button" onClick={(e) => onExpand(record, e)} className="w-6 h-6 mr-1 inline-flex items-center justify-center align-middle text-[var(--colorTextTertiary)] hover:text-[var(--colorText)] transition-colors bg-transparent border-0 p-0 leading-none">
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
              ) : <span className="w-6 h-6 inline-flex" />
          }}
          locale={{ emptyText: loading ? t('common.loading') : searchQuery ? t('emptySearch') : t('noFiles') }}
          pagination={false}
          rowClassName={(r) => `hover:bg-[var(--colorBgHover)] transition-colors ${r.isFolder ? 'font-medium bg-[var(--colorBgSecondary)]/30' : ''}`}
          rowSelection={{
            selectedRowKeys,
            onChange: setSelectedRowKeys,
            checkStrictly: false,
            getCheckboxProps: (record) => ({ disabled: record.isFolder ? (record.fileCount ?? 0) === 0 : false }),
          }}
        />
      </div>
    </div>
  );
}
