import { useEffect, useState } from 'react';
import { App, Button, Card, Empty, Image, List, Popconfirm, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, ExportOutlined, FileOutlined, FolderOpenOutlined, PictureOutlined, CopyOutlined, DatabaseOutlined } from '@ant-design/icons';
import { deleteGeneratedAsset, getGeneratedAssets, indexGeneratedAsset, openGeneratedAsset, type GeneratedAssetRecord } from '@/lib/api';

const { Text, Paragraph } = Typography;

export default function AssetLibraryPage() {
  const { message } = App.useApp();
  const [assets, setAssets] = useState<GeneratedAssetRecord[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const loadAssets = async () => {
    try { setAssets((await getGeneratedAssets()).assets); } catch { setAssets([]); }
  };

  useEffect(() => { void loadAssets(); }, []);

  const copyPath = async (pathText?: string) => {
    if (!pathText) return;
    await navigator.clipboard?.writeText(pathText);
    message.success('已复制路径');
  };

  const runAssetAction = async (id: string, action: 'index' | 'openFile' | 'openDirectory' | 'delete') => {
    setLoadingId(id);
    try {
      if (action === 'index') setAssets((await indexGeneratedAsset(id)).assets);
      if (action === 'openFile') await openGeneratedAsset(id, 'file');
      if (action === 'openDirectory') await openGeneratedAsset(id, 'directory');
      if (action === 'delete') setAssets((await deleteGeneratedAsset(id)).assets);
      if (action === 'index') message.success('已加入知识库索引');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setLoadingId(null);
    }
  };

  const previewSrc = (asset: GeneratedAssetRecord) => asset.type === 'image' && asset.path?.startsWith('generatedDocuments/assets/') ? `/api/assets/generated/preview?id=${encodeURIComponent(asset.id)}` : undefined;

  return (
    <div className="page-shell">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">生成资源</h1>
        <p className="text-[var(--colorTextSecondary)]">管理文档生成产生的本地资源。生成资源默认不进入知识库，可在后续操作中手动加入知识库。</p>
      </div>
      <Card>
        <List
          dataSource={assets}
          locale={{ emptyText: <Empty description="暂无生成资源" /> }}
          renderItem={(asset, index) => (
            <List.Item
              actions={[
                asset.path ? <Button key="copy" icon={<CopyOutlined />} onClick={() => { void copyPath(asset.path); }}>复制路径</Button> : null,
                asset.path ? <Button key="open" icon={<ExportOutlined />} loading={loadingId === asset.id} onClick={() => { void runAssetAction(asset.id, 'openFile'); }}>打开</Button> : null,
                asset.path ? <Button key="folder" icon={<FolderOpenOutlined />} loading={loadingId === asset.id} onClick={() => { void runAssetAction(asset.id, 'openDirectory'); }}>目录</Button> : null,
                !asset.indexed && asset.path ? <Button key="index" icon={<DatabaseOutlined />} loading={loadingId === asset.id} onClick={() => { void runAssetAction(asset.id, 'index'); }}>加入知识库</Button> : null,
                <Popconfirm key="delete" title="确认删除该生成资源记录？" onConfirm={() => { void runAssetAction(asset.id, 'delete'); }}><Button danger icon={<DeleteOutlined />} loading={loadingId === asset.id}>删除</Button></Popconfirm>,
              ]}
            >
              <List.Item.Meta
                avatar={previewSrc(asset) ? <Image width={64} height={40} src={previewSrc(asset)} alt={asset.name} style={{ objectFit: 'cover' }} /> : asset.type === 'image' ? <PictureOutlined /> : <FileOutlined />}
                title={<Space wrap><Tag>序号 {index + 1}</Tag><span>{asset.name}</span><Tag>{asset.type}</Tag><Tag color={asset.indexed ? 'success' : 'default'}>{asset.indexed ? '已入库' : '未入库'}</Tag><Tag color="blue">{asset.role}</Tag></Space>}
                description={(
                  <Space direction="vertical" size={2} className="w-full">
                    <Text type="secondary">路径：{asset.path || asset.url || '—'}</Text>
                    <Text type="secondary">来源：{asset.source} · 使用文档：{asset.usedByDocumentIds.length} · 更新时间：{new Date(asset.updatedAt).toLocaleString()}</Text>
                    {asset.prompt && <Paragraph ellipsis={{ rows: 2, expandable: true }} className="!mb-0">提示词：{asset.prompt}</Paragraph>}
                  </Space>
                )}
              />
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
}
