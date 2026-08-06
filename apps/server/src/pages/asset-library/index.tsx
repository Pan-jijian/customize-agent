import { useEffect, useState } from 'react';
import { App, Button, Dropdown, Empty, Image, Modal, Space, Skeleton, Table, Tag } from 'antd';
import { DeleteOutlined, ExportOutlined, FileOutlined, FolderOpenOutlined, PictureOutlined, CopyOutlined, MoreOutlined } from '@ant-design/icons';
import { useAppTranslations } from '@/components/Layout';
import { deleteGeneratedAsset, getGeneratedAssets, getPromptProjects, openGeneratedAsset, type GeneratedAssetRecord } from '@/lib/api';

const ROLE_COLORS: Record<string, string> = { cover: 'magenta', reference: 'blue', generated: 'purple', attachment: 'cyan', map: 'orange', operator: 'geekblue' };

export default function AssetLibraryPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
  const formatCount = (key: string, count: number | string) => t(key).replace('{count}', String(count));
  const sourceLabel = (source: string) => ({
    knowledge_base: t('assets.sourceKnowledgeBase'),
    generated: t('assets.sourceGenerated'),
    uploaded: t('assets.sourceUploaded'),
    external_url: t('assets.sourceExternalUrl'),
  } as Record<string, string>)[source] || source;
  const [assets, setAssets] = useState<GeneratedAssetRecord[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [projectRoot, setProjectRoot] = useState('');

  const loadAssets = async (root = projectRoot) => {
    try { setAssets((await getGeneratedAssets(root || undefined)).assets); } catch { setAssets([]); }
  };
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void getPromptProjects()
      .then(projects => {
        if (cancelled) return;
        const root = projects.find(item => item.selected)?.projectRoot || projects.find(item => item.isCurrent)?.projectRoot || projects[0]?.projectRoot || '';
        setProjectRoot(root);
        return loadAssets(root);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const copyPath = async (text?: string) => {
    if (!text) return;
    await navigator.clipboard?.writeText(text);
    message.success(t('assets.copiedPath'));
  };

  /** 执行资源操作：打开文件、打开目录、删除 */
  const runAction = async (id: string, action: 'openFile' | 'openDirectory' | 'delete') => {
    try {
      if (action === 'openFile') await openGeneratedAsset(id, 'file', projectRoot || undefined);
      else if (action === 'openDirectory') await openGeneratedAsset(id, 'directory', projectRoot || undefined);
      else if (action === 'delete') { setAssets((await deleteGeneratedAsset(id, projectRoot || undefined)).assets); setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; }); }
    } catch (error) { message.error(error instanceof Error ? error.message : t('assets.operationFailed')); }
  };

  /** 批量删除资源：删除已选或全部 */
  const handleBulkDelete = (mode: 'selected' | 'all') => {
    const targets = mode === 'selected' ? [...selectedIds] : assets.map(a => a.id);
    if (targets.length === 0) return;
    Modal.confirm({
      title: mode === 'all' ? t('assets.deleteAllConfirm') : formatCount('assets.deleteSelectedConfirm', targets.length),
      content: t('assets.deleteIrreversible'),
      okText: t('common.confirm'), cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setLoading(true);
        try { await Promise.all(targets.map(id => deleteGeneratedAsset(id, projectRoot || undefined))); await loadAssets(); setSelectedIds(new Set()); message.success(formatCount('assets.deleted', targets.length)); }
        catch { message.error(t('assets.batchDeleteFailed')); }
        finally { setLoading(false); }
      },
    });
  };

  /** 切换资源选中状态 */
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  /** 获取图片资源的预览 URL */
  const previewSrc = (asset: GeneratedAssetRecord) =>
    asset.type === 'image' && asset.path
      ? `/api/assets/generated/preview?id=${encodeURIComponent(asset.id)}${projectRoot ? `&projectRoot=${encodeURIComponent(projectRoot)}` : ''}`
      : undefined;

  if (loading) return (
    <div className="space-y-5 animateFadeIn">
      <Skeleton active title paragraph={{ rows: 8 }} />
    </div>
  );

  return (
    <div className="space-y-5 animateFadeIn">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h1 className="pageTitle">{t('nav.assetLibrary')}</h1><p className="pageDesc">{t('assets.description')}</p></div>
        <Space size={8}>
          <span style={{ color: 'var(--colorTextSecondary)', fontSize: 12 }}>{formatCount('assets.total', assets.length)}</span>
          <Button danger size="small" disabled={selectedIds.size === 0} icon={<DeleteOutlined />} onClick={() => handleBulkDelete('selected')}>{formatCount('assets.deleteSelected', selectedIds.size || '')}</Button>
          <Button danger size="small" disabled={assets.length === 0} onClick={() => handleBulkDelete('all')}>{t('assets.deleteAll')}</Button>
        </Space>
      </div>

      {assets.length === 0 ? <Empty description={t('assets.empty')} /> : (
        <Table<GeneratedAssetRecord>
          className="modern-table"
          rowKey="id"
          size="middle"
          dataSource={assets}
          pagination={{ pageSize: 12, showSizeChanger: true, pageSizeOptions: [12, 24, 48], showTotal: total => formatCount('assets.total', total) }}
          rowSelection={{
            selectedRowKeys: [...selectedIds],
            onChange: keys => setSelectedIds(new Set(keys.map(String))),
          }}
          columns={[
            {
              title: t('assets.resource'),
              dataIndex: 'name',
              key: 'name',
              width: 360,
              render: (_, asset) => {
                const src = previewSrc(asset);
                return (
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-12 h-12 rounded-lg bg-[var(--colorBgHover)] flex items-center justify-center overflow-hidden shrink-0">
                      {src ? <Image src={src} alt={asset.name} width={48} height={48} style={{ objectFit: 'cover' }} preview={false} /> : asset.type === 'image' ? <PictureOutlined className="text-[var(--colorWarning)]" /> : <FileOutlined className="text-[var(--colorAccent)]" />}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-[var(--colorText)] whitespace-normal break-words leading-snug">{asset.name}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Tag color={ROLE_COLORS[asset.role] || 'blue'} bordered={false} className="m-0">{asset.role}</Tag>
                        <Tag bordered={false} className="m-0">{asset.type}</Tag>
                      </div>
                    </div>
                  </div>
                );
              },
            },
            {
              title: t('assets.path'),
              dataIndex: 'path',
              key: 'path',
              render: path => path ? <span className="font-mono text-xs text-[var(--colorTextSecondary)] whitespace-normal break-all">{path}</span> : <span className="text-[var(--colorTextTertiary)]">-</span>,
            },
            {
              title: t('assets.source'),
              dataIndex: 'source',
              key: 'source',
              width: 110,
              render: source => <Tag bordered={false} className="m-0">{sourceLabel(source)}</Tag>,
            },
            {
              title: t('assets.usedDocuments'),
              dataIndex: 'usedByDocumentIds',
              key: 'usedByDocumentIds',
              width: 100,
              render: ids => <span className="text-[var(--colorTextSecondary)]">{ids.length}</span>,
            },
            {
              title: t('assets.updatedAt'),
              dataIndex: 'updatedAt',
              key: 'updatedAt',
              width: 130,
              render: value => <span className="text-[var(--colorTextSecondary)]">{new Date(value).toLocaleDateString()}</span>,
            },
            {
              title: t('assets.actions'),
              key: 'actions',
              width: 88,
              align: 'right',
              render: (_, asset) => {
                const actionItems = [
                  ...(asset.path ? [{ key: 'copy', icon: <CopyOutlined />, label: t('assets.copyPath'), onClick: () => { void copyPath(asset.path); } }] : []),
                  ...(asset.path ? [{ key: 'open', icon: <ExportOutlined />, label: t('assets.openFile'), onClick: () => { void runAction(asset.id, 'openFile'); } }] : []),
                  ...(asset.path ? [{ key: 'folder', icon: <FolderOpenOutlined />, label: t('assets.openDirectory'), onClick: () => { void runAction(asset.id, 'openDirectory'); } }] : []),
                  { type: 'divider' as const },
                  { key: 'delete', icon: <DeleteOutlined />, label: t('common.delete'), danger: true, onClick: () => { void runAction(asset.id, 'delete'); } },
                ];
                return (
                  <Dropdown menu={{ items: actionItems }} trigger={['click']} placement="bottomRight">
                    <Button type="text" size="small" icon={<MoreOutlined />} onClick={event => event.stopPropagation()} />
                  </Dropdown>
                );
              },
            },
          ]}
        />
      )}
    </div>
  );
}
