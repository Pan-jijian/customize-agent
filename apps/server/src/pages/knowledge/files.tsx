import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppLocale, useAppTranslations } from '@/components/Layout';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Card, Table, Button, Input, Select, Tag, Modal, Space, Upload, App, Progress } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { UploadOutlined, SearchOutlined, DeleteOutlined, FileTextOutlined } from '@ant-design/icons';
import { getKbFiles, getKbOperations, getKbUploadProgress, deleteKbFile, uploadKbFile, reindexKb, type KbFileItem, type KbOperationRecord } from '@/lib/api';
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
  const searchParams = useSearchParams();
  const initialCategory = searchParams.get('category') || '';

  const [files, setFiles] = useState<KbFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState(initialCategory);
  const [uploading, setUploading] = useState(false);
  const [statusItems, setStatusItems] = useState<StatusItem[]>([]);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [page, setPage] = useState(1);
  const categoryRef = useRef(category);

  useEffect(() => { categoryRef.current = category; }, [category]);

  const loadFiles = useCallback(async (cat?: string) => {
    const c = cat ?? categoryRef.current;
    setLoading(true);
    try {
      const r = await getKbFiles({ category: c || undefined, limit: 200 });
      setFiles(r.files || []);
    } catch { setFiles([]); }
    finally { setLoading(false); }
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

  const handleUpload = async (file: File) => {
    setUploading(true);
    setStatusItems(items => [{ type: 'upload', title: `上传 ${file.name}`, description: '等待上传、解析、切片和入库', status: 'processing', percent: 10 } satisfies StatusItem, ...items].slice(0, 50));
    const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const poll = setInterval(() => {
      void getKbUploadProgress(uploadId).then(progress => {
        setStatusItems(items => [{ type: 'upload', title: `上传 ${file.name}`, description: `${progress.message}${progress.chunkCount ? `，${progress.chunkCount} 个切片` : ''}`, status: progress.stage === 'error' ? 'warning' : 'processing', percent: progress.percent } satisfies StatusItem, ...items.filter(item => item.title !== `上传 ${file.name}`)].slice(0, 50));
      }).catch(() => undefined);
    }, 500);
    try {
      const result = await uploadKbFile(file, undefined, uploadId);
      clearInterval(poll);
      if (result.vectorStatus?.status === 'error') message.info('文件已上传，正在后台入库');
      else message.success('上传成功');
      setSearchQuery('');
      setCategory('');
      setSelectedRowKeys([]);
      setPage(1);
      categoryRef.current = '';
      const uploaded = result.files?.find(item => item.relativePath === result.relativePath);
      const meta = fileMeta(uploaded);
      await loadOperations();
      setStatusItems(items => [{
        type: 'upload',
        title: `上传完成 ${file.name}`,
        description: uploaded ? '解析、分块和入库流程已完成' : '文件已上传',
        status: uploaded?.chunkCount === 1 ? 'warning' : 'success',
        filePath: uploaded?.relativePath,
        chunkCount: uploaded?.chunkCount,
        textLength: meta.textLength,
        extractionMode: meta.extractionMode,
      } satisfies StatusItem, ...items.filter(item => item.title !== `上传 ${file.name}`)].slice(0, 50));
      if (Array.isArray(result.files)) {
        setFiles(result.files);
      } else {
        await reindexKb();
        await loadFiles('');
        await loadOperations();
      }
    } catch { message.error('上传失败'); setStatusItems(items => [{ type: 'error', title: `上传失败 ${file.name}`, description: '请重试或检查文件格式', status: 'error' } satisfies StatusItem, ...items].slice(0, 50)); }
    finally { clearInterval(poll); setUploading(false); }
    return false;
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
          await loadFiles();
          await loadOperations();
        }
        catch { message.error('删除失败'); setStatusItems(items => [{ type: 'error', title: `删除失败 ${record.relativePath}`, description: '请重试', status: 'error' } satisfies StatusItem, ...items].slice(0, 50)); }
      },
    });
  };

  const filtered = searchQuery ? files.filter((f) => f.relativePath.toLowerCase().includes(searchQuery.toLowerCase())) : files;

  const columns: ColumnsType<KbFileItem> = [
    { title: t('fileName'), dataIndex: 'relativePath', key: 'name', render: (n: string) => <Space><FileTextOutlined /><Link className="truncate max-w-[400px] inline-block" href={`/knowledge/file-detail?relativePath=${encodeURIComponent(n)}`}>{n}</Link></Space> },
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
        <Upload showUploadList={false} beforeUpload={(f) => { void handleUpload(f); return false; }}>
          <Button type="primary" icon={<UploadOutlined />} loading={uploading}>{uploading ? t('uploading') : t('upload')}</Button>
        </Upload>
      </div>

      <Card size="small" className={styles.statusCard} title={<Space><FileTextOutlined />文件任务状态</Space>}>
        {statusItems.length === 0 ? <div className={styles.statusEmpty}>暂无文件任务。上传、删除、解析、分块和入库结果会显示在这里。</div> : <div className={styles.statusList}>
          {statusItems.map((item, index) => <div key={`${item.title}-${index}`} className={styles.statusItem}>
            <div className={styles.statusHeader}>
              <Space size={8} wrap>
                <Tag color={item.status === 'success' ? 'green' : item.status === 'error' ? 'red' : item.status === 'warning' ? 'orange' : 'blue'}>{item.type === 'upload' ? '上传' : item.type === 'delete' ? '删除' : item.type === 'reindex' ? '重建' : '失败'}</Tag>
                <strong>{item.title}</strong>
              </Space>
              <Tag color={item.status === 'success' ? 'success' : item.status === 'processing' ? 'processing' : item.status === 'warning' ? 'warning' : 'error'}>{item.status === 'success' ? '完成' : item.status === 'processing' ? '处理中' : item.status === 'warning' ? '需关注' : '失败'}</Tag>
            </div>
            <div className={styles.statusDesc}>{item.description}</div>
            {item.filePath && <div className={styles.statusPath}>{item.filePath}</div>}
            <div className={styles.statusMeta}>
              {typeof item.chunkCount === 'number' && <span>切片 <b>{item.chunkCount}</b></span>}
              {typeof item.textLength === 'number' && <span>正文 <b>{item.textLength.toLocaleString(locale)}</b> 字符</span>}
              {item.extractionMode && <span>解析 <b>{item.extractionMode}</b></span>}
            </div>
            {typeof item.percent === 'number' && item.status === 'processing' && <Progress percent={item.percent} size="small" />}
          </div>)}
        </div>}
      </Card>

      <Card>
        <Table rowKey="relativePath" columns={columns} dataSource={filtered} loading={loading} size="middle"
          locale={{ emptyText: searchQuery ? t('emptySearch') : t('noFiles') }}
          pagination={{ current: page, pageSize: 50, showSizeChanger: false, onChange: setPage }}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }} />
      </Card>
    </div>
  );
}
