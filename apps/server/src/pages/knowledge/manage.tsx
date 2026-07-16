import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale, useAppTranslations } from '@/components/Layout';
import { Card, Button, Row, Col, Statistic, Tag, App, Select, Descriptions, Space } from 'antd';
import { DatabaseOutlined, FileOutlined, HddOutlined, ClockCircleOutlined, ReloadOutlined, FolderOutlined, SearchOutlined, ApartmentOutlined, BlockOutlined, MergeCellsOutlined, ScissorOutlined } from '@ant-design/icons';
import { useKbStats, useKbFeatures, useReindex } from '@/hooks/useKbData';
import { getKbFiles } from '@/lib/api';
import { categoryLabel, formatBytes, formatRelativeTime } from '@/lib/utils';

const ALL_CATEGORY_KEYS = ['document', 'spreadsheet', 'image', 'cad', 'code', 'data', 'web', 'diagram', 'archive', 'other'] as const;

export default function KnowledgeManagePage() {
  const t = useAppTranslations();
  const { locale } = useAppLocale();
  const router = useRouter();
  const { stats, loading, reload } = useKbStats();
  const features = useKbFeatures();
  const { reindexing, reindex } = useReindex();
  const [category, setCategory] = useState('document');
  const [catStats, setCatStats] = useState<{ count: number; totalSize: number; totalChunks: number }>({ count: 0, totalSize: 0, totalChunks: 0 });
  const { message } = App.useApp();

  const loadCatStats = useCallback(async (cat: string) => {
    try {
      const files = await getKbFiles({ category: cat, limit: 10000 });
      let totalSize = 0, totalChunks = 0;
      if (Array.isArray(files.files)) {
        for (const f of files.files) { totalSize += f.fileSize || 0; totalChunks += f.chunkCount || 0; }
      }
      setCatStats({ count: files.total || 0, totalSize, totalChunks });
    } catch { setCatStats({ count: 0, totalSize: 0, totalChunks: 0 }); }
  }, []);

  useEffect(() => { void loadCatStats(category); }, [category, loadCatStats]);

  const handleReindex = async () => {
    const ok = await reindex();
    if (ok) {
      await Promise.all([reload(), loadCatStats(category)]);
    } else {
      message.error(t('common.error'));
    }
  };

  return (
    <div className="space-y-6 animateFadeIn">
      <div className="flex items-center justify-between">
        <div><h1 className="pageTitle">{t('knowledge.manageTitle')}</h1><p className="pageDesc">{t('knowledge.manageDesc')}</p></div>
        <Space>
          <Button icon={<FolderOutlined />} onClick={() => router.push('/knowledge/files')}>{t('knowledge.files')}</Button>
          <Button icon={<SearchOutlined />} onClick={() => router.push('/knowledge/search')}>{t('knowledge.search')}</Button>
          <Button icon={<ReloadOutlined />} loading={reindexing} onClick={() => { void handleReindex(); }}>{t('knowledge.reindex')}</Button>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        {[
          { icon: <FileOutlined />, label: t('knowledge.totalFiles'), value: stats?.fileCount ?? 0 },
          { icon: <DatabaseOutlined />, label: t('knowledge.totalChunks'), value: stats?.chunkCount ?? 0 },
          { icon: <HddOutlined />, label: t('knowledge.totalSize'), value: formatBytes(stats?.totalSizeBytes ?? 0) },
          { icon: <ClockCircleOutlined />, label: t('knowledge.lastIndexed'), value: stats?.lastIndexedAt ? formatRelativeTime(stats.lastIndexedAt, locale) : t('common.never') },
        ].map((item, i) => (
          <Col xs={12} sm={6} key={i}>
            <Card size="small" loading={loading && !stats}><Statistic title={item.label} value={item.value} prefix={item.icon} /></Card>
          </Col>
        ))}
      </Row>

      <Card title={t('knowledge.categories')} size="small">
        <Select
          value={category}
          onChange={(v) => setCategory(v)}
          options={ALL_CATEGORY_KEYS.map(k => ({ label: categoryLabel(k, locale), value: k }))}
          style={{ width: 160, marginBottom: 16 }}
        />
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={6}><Statistic title={t('knowledge.fileCount')} value={catStats.count} prefix={<FileOutlined style={{ color: 'var(--colorAccent)' }} />} /></Col>
          <Col xs={12} sm={6}><Statistic title={t('knowledge.totalSize')} value={formatBytes(catStats.totalSize)} prefix={<HddOutlined style={{ color: 'var(--colorWarning)' }} />} /></Col>
          <Col xs={12} sm={6}><Statistic title="切片数" value={catStats.totalChunks} prefix={<BlockOutlined style={{ color: 'var(--colorOk)' }} />} /></Col>
          <Col xs={12} sm={6}><Statistic title="平均大小" value={catStats.count > 0 ? formatBytes(catStats.totalSize / catStats.count) : '—'} prefix={<DatabaseOutlined style={{ color: 'var(--colorDanger)' }} />} /></Col>
        </Row>
      </Card>

      {features && (
        <Card title={t('knowledge.features')} size="small">
          <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
            <Descriptions.Item label={<><ApartmentOutlined style={{ marginRight: 4 }} />Vector Store</>}>
              <Tag color="blue">{features.vectorStore}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label={<><BlockOutlined style={{ marginRight: 4 }} />Embedding</>}>
              <Tag color="purple">{features.embeddingProvider}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label={<><MergeCellsOutlined style={{ marginRight: 4 }} />{t('knowledge.featureDedup')}</>}>
              <Tag color="green">{features.dedupEngine}</Tag>
              <div className="text-xs" style={{ color: 'var(--colorTextSecondary)', marginTop: 2 }}>{t('knowledge.featureDedupDesc')}</div>
            </Descriptions.Item>
            <Descriptions.Item label={<><ScissorOutlined style={{ marginRight: 4 }} />{t('knowledge.featureChunker')}</>}>
              <Tag color="orange">{features.chunker}</Tag>
              <div className="text-xs" style={{ color: 'var(--colorTextSecondary)', marginTop: 2 }}>{t('knowledge.featureChunkerDesc')}</div>
            </Descriptions.Item>
            {features.builtinExtractors?.length > 0 && (
              <Descriptions.Item label="内置提取器" span={2}>
                <Space wrap>{features.builtinExtractors.map(e => <Tag key={e} color="cyan">{e}</Tag>)}</Space>
              </Descriptions.Item>
            )}
          </Descriptions>
        </Card>
      )}
    </div>
  );
}
