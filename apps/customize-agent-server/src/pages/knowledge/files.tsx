import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Card, Table, Button, Input, Select, Tag, Modal, Space, Upload, App } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { UploadOutlined, SearchOutlined, DeleteOutlined, FileTextOutlined } from '@ant-design/icons';
import { getKbFiles, deleteKbFile, uploadKbFile, type KbFileItem } from '@/lib/api';
import { formatBytes, categoryLabel } from '@/lib/utils';
import styles from './style.module.scss';

const CATEGORIES = ['document', 'spreadsheet', 'image', 'cad', 'code', 'data', 'web', 'diagram', 'archive', 'other'] as const;

export default function FilesPage() {
  const t = useTranslations('knowledge');
  const { message } = App.useApp();
  const searchParams = useSearchParams();
  const initialCategory = searchParams.get('category') || '';

  const [files, setFiles] = useState<KbFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [category, setCategory] = useState(initialCategory);
  const [uploading, setUploading] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const categoryRef = useRef(category);

  // 保持 ref 同步，供上传回调使用最新值
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

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      await uploadKbFile(file);
      message.success('上传成功');
      // 上传成功后立即重载，如果当前有分类筛选则切换到全部以展示新文件
      if (categoryRef.current) {
        setCategory('');
        // setCategory 触发的 useEffect 会调用 loadFiles
      } else {
        await loadFiles();
      }
    } catch { message.error('上传失败'); }
    finally { setUploading(false); }
    return false;
  };

  const handleDelete = (record: KbFileItem) => {
    Modal.confirm({
      title: t('delete'), content: t('deleteConfirm'), okText: '确认', cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        try { await deleteKbFile(record.relativePath); message.success('已删除'); await loadFiles(); }
        catch { message.error('删除失败'); }
      },
    });
  };

  const filtered = searchQuery ? files.filter((f) => f.relativePath.toLowerCase().includes(searchQuery.toLowerCase())) : files;

  const columns: ColumnsType<KbFileItem> = [
    { title: t('fileName'), dataIndex: 'relativePath', key: 'name', render: (n: string) => <Space><FileTextOutlined /><span className="truncate max-w-[400px] inline-block">{n}</span></Space> },
    { title: t('fileCategory'), dataIndex: 'category', key: 'cat', width: 120, render: (c: string) => <Tag>{categoryLabel(c)}</Tag> },
    { title: t('fileSize'), dataIndex: 'fileSize', key: 'size', width: 100, render: (s: number) => formatBytes(s) },
    { title: t('fileDate'), dataIndex: 'mtime', key: 'date', width: 140, render: (ts: number) => ts ? new Date(ts).toLocaleDateString('zh-CN') : '—' },
    { title: '', key: 'act', width: 60, render: (_: unknown, r: KbFileItem) => <Button type="text" danger size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(r)} /> },
  ];

  return (
    <div className="space-y-5 animateFadeIn">
      <h2 className="pageTitle">{t('fileList')}</h2>

      <div className="flex flex-wrap items-end gap-3">
        <Input placeholder={t('searchPlaceholder')} prefix={<SearchOutlined />} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} allowClear className={styles.filterInput} />
        <Select value={category || undefined} onChange={(v) => setCategory(v || '')} placeholder={t('filterCategory')} allowClear className={styles.filterSelect}
          options={[{ label: t('allCategories'), value: '' }, ...CATEGORIES.map((c) => ({ label: categoryLabel(c), value: c }))]} />
        <Upload showUploadList={false} beforeUpload={(f) => { void handleUpload(f); return false; }}>
          <Button type="primary" icon={<UploadOutlined />} loading={uploading}>{uploading ? t('uploading') : t('upload')}</Button>
        </Upload>
      </div>

      <Card>
        <Table rowKey="relativePath" columns={columns} dataSource={filtered} loading={loading} size="medium"
          locale={{ emptyText: searchQuery ? t('emptySearch') : t('noFiles') }}
          pagination={{ pageSize: 50, showSizeChanger: false }}
          rowSelection={{ selectedRowKeys, onChange: setSelectedRowKeys }} />
      </Card>
    </div>
  );
}
