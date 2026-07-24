import { useEffect, useState } from 'react';
import { App, Button, Card, Col, Dropdown, Empty, Image, Modal, Row, Space, Skeleton, Tag } from 'antd';
import { DeleteOutlined, ExportOutlined, FileOutlined, FolderOpenOutlined, PictureOutlined, CopyOutlined, DatabaseOutlined, MoreOutlined } from '@ant-design/icons';
import { useAppTranslations } from '@/components/Layout';
import { deleteGeneratedAsset, getGeneratedAssets, getPromptProjects, indexGeneratedAsset, openGeneratedAsset, type GeneratedAssetRecord } from '@/lib/api';

const SOURCE_LABELS: Record<string, string> = { knowledge_base: '知识库', generated: 'AI生成', uploaded: '上传', external_url: '外部URL' };
const ROLE_COLORS: Record<string, string> = { cover: 'magenta', reference: 'blue', generated: 'purple', attachment: 'cyan', map: 'orange', operator: 'geekblue' };

export default function AssetLibraryPage() {
  const t = useAppTranslations();
  const { message } = App.useApp();
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
    message.success('已复制路径');
  };

  /** 执行资源操作：加入知识库索引、打开文件、打开目录、删除 */
  const runAction = async (id: string, action: 'index' | 'openFile' | 'openDirectory' | 'delete') => {
    try {
      if (action === 'index') { setAssets((await indexGeneratedAsset(id, projectRoot || undefined)).assets); message.success('已加入知识库索引'); }
      else if (action === 'openFile') await openGeneratedAsset(id, 'file', projectRoot || undefined);
      else if (action === 'openDirectory') await openGeneratedAsset(id, 'directory', projectRoot || undefined);
      else if (action === 'delete') { setAssets((await deleteGeneratedAsset(id, projectRoot || undefined)).assets); setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n; }); }
    } catch (error) { message.error(error instanceof Error ? error.message : '操作失败'); }
  };

  /** 批量删除资源：删除已选或全部 */
  const handleBulkDelete = (mode: 'selected' | 'all') => {
    const targets = mode === 'selected' ? [...selectedIds] : assets.map(a => a.id);
    if (targets.length === 0) return;
    Modal.confirm({
      title: mode === 'all' ? '删除全部资源？' : `删除已选 ${targets.length} 个资源？`,
      content: '此操作不可撤销。',
      okText: t('common.confirm'), cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        setLoading(true);
        try { await Promise.all(targets.map(id => deleteGeneratedAsset(id, projectRoot || undefined))); await loadAssets(); setSelectedIds(new Set()); message.success(`已删除 ${targets.length} 个资源`); }
        catch { message.error('批量删除失败'); }
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
      <Skeleton active title paragraph={{ rows: 1 }} />
      <Row gutter={[12, 12]}>
        {Array.from({ length: 6 }).map((_, i) => (
          <Col xs={24} sm={12} md={8} xl={6} key={i}><Card size="small"><Skeleton active paragraph={{ rows: 3 }} /></Card></Col>
        ))}
      </Row>
    </div>
  );

  return (
    <div className="space-y-5 animateFadeIn">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h1 className="pageTitle">{t('nav.assetLibrary')}</h1><p className="pageDesc">管理模板运行生成的文档、图片和附件。生成结果默认不进入知识库，需要复用时可手动加入知识库。</p></div>
        <Space size={8}>
          <span style={{ color: 'var(--colorTextSecondary)', fontSize: 12 }}>共 {assets.length} 个资源</span>
          <Button danger size="small" disabled={selectedIds.size === 0} icon={<DeleteOutlined />} onClick={() => handleBulkDelete('selected')}>删除已选 {selectedIds.size || ''}</Button>
          <Button danger size="small" disabled={assets.length === 0} onClick={() => handleBulkDelete('all')}>删除全部</Button>
        </Space>
      </div>

      {assets.length === 0 ? <Empty description="暂无生成资源" /> : (
        <Row gutter={[12, 12]}>
          {assets.map((asset, index) => {
            const src = previewSrc(asset);
            const isSelected = selectedIds.has(asset.id);
            const actionItems = [
              ...(asset.path ? [{ key: 'copy', icon: <CopyOutlined />, label: '复制路径', onClick: () => { void copyPath(asset.path); } }] : []),
              ...(asset.path ? [{ key: 'open', icon: <ExportOutlined />, label: '打开文件', onClick: () => { void runAction(asset.id, 'openFile'); } }] : []),
              ...(asset.path ? [{ key: 'folder', icon: <FolderOpenOutlined />, label: '打开目录', onClick: () => { void runAction(asset.id, 'openDirectory'); } }] : []),
              ...(!asset.indexed && asset.path ? [{ key: 'index', icon: <DatabaseOutlined />, label: '加入知识库', onClick: () => { void runAction(asset.id, 'index'); } }] : []),
              { type: 'divider' as const },
              { key: 'delete', icon: <DeleteOutlined />, label: t('common.delete'), danger: true, onClick: () => { void runAction(asset.id, 'delete'); } },
            ];
            return (
              <Col xs={24} sm={12} md={8} xl={6} key={asset.id}>
                <Card
                  size="small"
                  hoverable
                  styles={{ body: { padding: 12 } }}
                  style={{ border: isSelected ? '2px solid #1677ff' : undefined, cursor: 'pointer', position: 'relative' }}
                  onClick={() => toggleSelect(asset.id)}
                >
                  {/* 复选框 — 左上角，始终可见 */}
                  <div
                    onClick={(e) => { e.stopPropagation(); toggleSelect(asset.id); }}
                    style={{
                      position: 'absolute', top: 8, left: 8, zIndex: 2,
                      width: 22, height: 22, borderRadius: 5,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', transition: 'all 0.15s',
                      background: isSelected ? '#1677ff' : 'rgba(0,0,0,0.6)',
                      color: '#fff',
                      fontSize: 12, fontWeight: 700,
                    }}
                  >
                    {isSelected ? '✓' : ''}
                  </div>

                  {/* 更多按钮 — 右上角 */}
                  <Dropdown menu={{ items: actionItems }} trigger={['click']} placement="bottomRight">
                    <Button type="text" size="small" icon={<MoreOutlined />}
                      style={{ position: 'absolute', top: 6, right: 6, zIndex: 2, width: 24, height: 24, padding: 0, background: 'var(--colorBgContainer)', borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
                      onClick={(e) => e.stopPropagation()} />
                  </Dropdown>

                  {/* 预览图片 */}
                  {src && (
                    <div style={{ margin: '-12px -12px 10px -12px', borderRadius: '10px 10px 0 0', overflow: 'hidden', height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--colorFillAlter)' }}>
                      <Image src={src} alt={asset.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} onClick={(e) => e.stopPropagation()} />
                    </div>
                  )}

                  {/* 标题行 */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
                      {!src && (asset.type === 'image' ? <PictureOutlined style={{ color: 'var(--colorWarning)', fontSize: 15, flexShrink: 0 }} /> : <FileOutlined style={{ color: 'var(--colorAccent)', fontSize: 15, flexShrink: 0 }} />)}
                      <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asset.name}</span>
                    </div>
                  </div>

                  {/* 标签 */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                    <Tag color={asset.indexed ? 'success' : 'default'} style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{asset.indexed ? '已入库' : '未入库'}</Tag>
                    <Tag color={ROLE_COLORS[asset.role] || 'blue'} style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{asset.role}</Tag>
                    <Tag style={{ margin: 0, fontSize: 10, lineHeight: '16px' }}>{asset.type}</Tag>
                  </div>

                  {/* 元信息 */}
                  <div style={{ fontSize: 12, color: 'var(--colorTextSecondary)', lineHeight: 1.5, marginBottom: 6 }}>
                    {asset.path && (
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 11 }}>
                        {asset.path}
                      </div>
                    )}
                    <div>{SOURCE_LABELS[asset.source] || asset.source} · {asset.usedByDocumentIds.length} 个文档 · {new Date(asset.updatedAt).toLocaleDateString()}</div>
                  </div>

                </Card>
              </Col>
            );
          })}
        </Row>
      )}
    </div>
  );
}
