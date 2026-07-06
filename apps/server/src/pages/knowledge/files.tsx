import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppLocale, useAppTranslations } from '@/components/Layout';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Card, Table, Button, Input, Select, Tag, Modal, Space, App, Progress, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { UploadOutlined, SearchOutlined, DeleteOutlined, FileTextOutlined } from '@ant-design/icons';
import { getKbFiles, getKbOperations, getKbUploadProgress, clearKbOperations, deleteKbFile, deleteKbFiles, deleteAllKbFiles, uploadKbFiles, type KbFileItem, type KbOperationRecord } from '@/lib/api';
import { formatBytes, categoryLabel } from '@/lib/utils';
import styles from './style.module.scss';

const CATEGORIES = ['document', 'spreadsheet', 'image', 'cad', 'code', 'data', 'web', 'diagram', 'archive', 'other'] as const;
type StatusItem = {
  type: 'upload' | 'delete' | 'reindex' | 'error';
  title: string;
  description: string;
  status: 'success' | 'processing' | 'warning' | 'error';
  percent?: number;
  filePath?: string;
  chunkCount?: number;
  textLength?: number;
  extractionMode?: string;
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
  const [statusItems, setStatusItems] = useState<StatusItem[]>([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [page, setPage] = useState(1);
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
    type: record.type,
    title: record.title,
    description: record.message,
    status: record.status,
    percent: record.percent,
    filePath: record.filePath,
    chunkCount: record.chunkCount,
    textLength: record.textLength,
    extractionMode: record.extractionMode,
  });

  const loadOperations = useCallback(async () => {
    try {
      const result = await getKbOperations();
      setStatusItems(result.operations.map(mapOperation));
    } catch { /* ignore operation log load failure */ }
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
    if (uploadFilesList.length === 0) return;
    const titleName = uploadFilesList.length === 1 ? uploadFilesList[0]!.name : `${uploadFilesList.length} 个文件`;
    setUploading(true);
    setStatusItems(items => [{ type: 'upload', title: `上传 ${titleName}`, description: '等待上传、解析、切片和入库', status: 'processing', percent: 10 } satisfies StatusItem, ...items].slice(0, 50));
    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const poll = setInterval(() => {
      void getKbUploadProgress(uploadId).then(progress => {
        setStatusItems(items => [{ type: 'upload', title: `上传 ${titleName}`, description: `${progress.message}${progress.chunkCount ? `，${progress.chunkCount} 个切片` : ''}`, status: progress.stage === 'error' ? 'warning' : 'processing', percent: progress.percent } satisfies StatusItem, ...items.filter(item => item.title !== `上传 ${titleName}`)].slice(0, 50));
      }).catch(() => undefined);
    }, 500);
    try {
      const result = await uploadKbFiles(uploadFilesList, undefined, uploadId);
      clearInterval(poll);
      if (result.vectorStatus?.status === 'error') message.info('文件已上传，正在后台入库');
      else message.success('上传成功');
      setSearchQuery('');
      setCategory('');
      setSelectedRowKeys([]);
      setPage(1);
      categoryRef.current = '';
      const uploadedFiles = result.uploadedFiles?.length ? result.uploadedFiles : result.files?.filter((item: KbFileItem) => item.relativePath === result.relativePath) ?? [];
      const uploaded = uploadedFiles[0];
      const meta = fileMeta(uploaded);
      await loadOperations();
      setStatusItems(items => [{
        type: 'upload',
        title: `上传完成 ${titleName}`,
        description: '解析、分块和入库流程已完成',
        status: 'success',
        filePath: uploaded?.relativePath,
        chunkCount: uploaded?.chunkCount,
        textLength: meta.textLength,
        extractionMode: meta.extractionMode,
      } satisfies StatusItem, ...items.filter(item => item.title !== `上传 ${titleName}`)].slice(0, 50));
      if (uploadedFiles.length > 0) {
        setFiles(items => {
          const next = new Map(items.map(item => [item.relativePath, item]));
          for (const file of uploadedFiles) next.set(file.relativePath, file);
          return Array.from(next.values()).sort((a, b) => b.mtime - a.mtime);
        });
      }
      await loadOperations();
    } catch (error) {
      const description = error instanceof Error ? error.message : '请重试或检查文件格式';
      message.error(description || '上传失败');
      setStatusItems(items => [{ type: 'error', title: `上传失败 ${titleName}`, description, status: 'error' } satisfies StatusItem, ...items].slice(0, 50));
    }
    finally { clearInterval(poll); setUploading(false); }
  };

  const handleDelete = (record: KbFileItem) => {
    Modal.confirm({
      title: t('delete'), content: t('deleteConfirm'), okText: '确认', cancelText: '取消',
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
    const targets = mode === 'selected' ? selectedRowKeys.map(String) : mode === 'filtered' ? filtered.map(file => file.relativePath) : [];
    if (mode !== 'all' && targets.length === 0) return;
    const title = mode === 'all' ? '删除全部文件？' : mode === 'filtered' ? `删除当前筛选结果 ${targets.length} 个文件？` : `删除已选 ${targets.length} 个文件？`;
    Modal.confirm({
      title,
      content: '将同时删除文件、切片、索引和向量记录。此操作不可撤销。',
      okText: '确认删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setStatusItems(items => [{ type: 'delete', title, description: '正在批量删除文件和索引', status: 'processing', percent: 10 } satisfies StatusItem, ...items].slice(0, 50));
        try {
          const result = mode === 'all' ? await deleteAllKbFiles() : await deleteKbFiles(targets);
          const deletedCount = result.deleted ?? targets.length;
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

  const filtered = searchQuery ? files.filter((f) => f.relativePath.toLowerCase().includes(searchQuery.toLowerCase())) : files;

  const columns: ColumnsType<KbFileItem> = [
    { title: '序号', key: 'index', width: 70, render: (_: unknown, __: KbFileItem, index: number) => (page - 1) * 50 + index + 1 },
    { title: t('fileName'), dataIndex: 'relativePath', key: 'name', render: (n: string, r: KbFileItem) => <Space><FileTextOutlined />{r.builtIn && <Tag color="gold">内置</Tag>}<Link className="truncate max-w-[400px] inline-block" href={`/knowledge/file-detail?relativePath=${encodeURIComponent(n)}`}>{n}</Link></Space> },
    { title: t('fileCategory'), dataIndex: 'category', key: 'cat', width: 120, render: (c: string) => <Tag>{categoryLabel(c, locale)}</Tag> },
    { title: t('fileSize'), dataIndex: 'fileSize', key: 'size', width: 100, render: (s: number) => formatBytes(s) },
    { title: '切片', dataIndex: 'chunkCount', key: 'chunks', width: 90, render: (n: number) => <Tag color={n > 1 ? 'green' : 'orange'}>{n}</Tag> },
    { title: '解析状态', dataIndex: 'status', key: 'status', width: 110, render: (status: string, r: KbFileItem) => <Tag color={status === 'active' ? 'green' : 'red'}>{r.errorMessage || status}</Tag> },
    { title: t('fileDate'), dataIndex: 'mtime', key: 'date', width: 140, render: (ts: number) => ts ? new Date(ts).toLocaleDateString(locale) : '—' },
    { title: '', key: 'act', width: 60, render: (_: unknown, r: KbFileItem) => <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(r)} /> },
  ];

  return (
    <div className="space-y-5 animateFadeIn">
      <h2 className="pageTitle">{t('fileList')}</h2>

      <div className="flex flex-wrap items-end gap-3">
        <Input placeholder={t('searchPlaceholder')} prefix={<SearchOutlined />} value={searchQuery} onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }} allowClear className={styles.filterInput} />
        <Select value={category || undefined} onChange={(v) => { setCategory(v || ''); setPage(1); }} placeholder={t('filterCategory')} allowClear className={styles.filterSelect}
          options={[{ label: t('allCategories'), value: '' }, ...CATEGORIES.map((c) => ({ label: categoryLabel(c, locale), value: c }))]} />
        <Button type="primary" icon={<UploadOutlined />} loading={uploading} onClick={() => document.getElementById('kb-file-upload-input')?.click()}>{uploading ? t('uploading') : t('upload')}</Button>
        <Button icon={<UploadOutlined />} loading={uploading} onClick={() => document.getElementById('kb-folder-upload-input')?.click()}>上传文件夹</Button>
        <Button danger disabled={selectedRowKeys.length === 0} icon={<DeleteOutlined />} onClick={() => handleBulkDelete('selected')}>删除已选 {selectedRowKeys.length || ''}</Button>
        <Button danger disabled={filtered.length === 0 || (!searchQuery && !category)} onClick={() => handleBulkDelete('filtered')}>删除筛选结果</Button>
        <Button danger disabled={files.length === 0} onClick={() => handleBulkDelete('all')}>删除全部</Button>
        <input id="kb-file-upload-input" type="file" multiple hidden onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ''; void handleUpload(selected); }} />
        <input id="kb-folder-upload-input" type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={(event) => { const selected = Array.from(event.target.files ?? []); event.target.value = ''; void handleUpload(selected); }} />
      </div>

      <div className={styles.statusPanel}>
        <div className={styles.statusPanelHeader}>
          <Space><FileTextOutlined />文件任务状态</Space>
          <Button size="small" type="text" disabled={statusItems.length === 0} onClick={() => void handleClearOperations()}>清空</Button>
        </div>
        {statusItems.length === 0 ? <div className={styles.statusEmpty}>暂无文件任务。</div> : <div className={styles.statusList}>
          {statusItems.map((item, index) => <div key={`${item.title}-${index}`} className={styles.statusItem}>
            <div className={styles.statusHeader}>
              <Space size={8} wrap>
                <Tag color={item.status === 'success' ? 'green' : item.status === 'error' ? 'red' : item.status === 'warning' ? 'orange' : 'blue'}>{item.type === 'upload' ? '上传' : item.type === 'delete' ? '删除' : item.type === 'reindex' ? '重建' : '失败'}</Tag>
                <Tooltip title={item.title}><strong>{item.title}</strong></Tooltip>
              </Space>
              <Tag color={item.status === 'success' ? 'success' : item.status === 'processing' ? 'processing' : item.status === 'warning' ? 'warning' : 'error'}>{item.status === 'success' ? '完成' : item.status === 'processing' ? '处理中' : item.status === 'warning' ? '需关注' : '失败'}</Tag>
            </div>
            <Tooltip title={item.description}><div className={styles.statusDesc}>{item.description}</div></Tooltip>
            {item.filePath && <Tooltip title={item.filePath}><div className={styles.statusPath}>{item.filePath}</div></Tooltip>}
            <div className={styles.statusMeta}>
              {typeof item.chunkCount === 'number' && <span>切片 <b>{item.chunkCount}</b></span>}
              {typeof item.textLength === 'number' && <span>正文 <b>{item.textLength.toLocaleString(locale)}</b> 字符</span>}
              {item.extractionMode && <span>解析 <b>{item.extractionMode}</b></span>}
            </div>
            {typeof item.percent === 'number' && item.status === 'processing' && <Progress percent={item.percent} size="small" />}
          </div>)}
        </div>}
      </div>

      <Card>
        {loadError && <div className={styles.statusEmpty}>文件列表加载失败：{loadError}</div>}
        <Table rowKey="relativePath" columns={columns} dataSource={filtered} loading={loading} size="middle"
          locale={{ emptyText: loading ? '正在加载文件列表...' : searchQuery ? t('emptySearch') : t('noFiles') }}
          pagination={{ current: page, pageSize: 50, showSizeChanger: false, onChange: setPage }}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }} />
      </Card>
    </div>
  );
}
