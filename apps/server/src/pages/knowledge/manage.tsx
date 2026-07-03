import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAppLocale, useAppTranslations } from '@/components/Layout';
import { Card, Button, Row, Col, Statistic, Table, Tag, App, Segmented, Space } from 'antd';
import { DatabaseOutlined, FileOutlined, HddOutlined, ClockCircleOutlined, ReloadOutlined, FolderOutlined, SearchOutlined } from '@ant-design/icons';
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
  const [catStats, setCatStats] = useState<{ count: number; totalSize: number }>({ count: 0, totalSize: 0 });
  const { message } = App.useApp();

  const loadCatStats = useCallback(async (cat: string) => {
    try {
      const files = await getKbFiles({ category: cat, limit: 10000 });
      let totalSize = 0;
      if (Array.isArray(files.files)) {
        for (const f of files.files) totalSize += f.fileSize || 0;
      }
      setCatStats({ count: files.total || 0, totalSize });
    } catch { setCatStats({ count: 0, totalSize: 0 }); }
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
        <Segmented
          value={category}
          onChange={(v) => setCategory(String(v))}
          options={ALL_CATEGORY_KEYS.map(k => ({ label: categoryLabel(k, locale), value: k }))}
          className="mb-4"
        />
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={8}><Statistic title={t('knowledge.fileCount')} value={catStats.count} prefix={<FileOutlined />} /></Col>
          <Col xs={12} sm={8}><Statistic title={t('knowledge.totalSize')} value={formatBytes(catStats.totalSize)} prefix={<HddOutlined />} /></Col>
        </Row>
      </Card>

      {features && (
        <Card title={t('knowledge.features')} size="small">
          <Table
            dataSource={[
              { key: 'vectorStore', label: 'Vector Store', desc: t('knowledge.featureVectorStoreDesc'), value: features.vectorStore },
              { key: 'embedding', label: 'Embedding', desc: t('knowledge.featureEmbeddingDesc'), value: features.embeddingProvider },
              { key: 'dedup', label: t('knowledge.featureDedup'), desc: t('knowledge.featureDedupDesc'), value: features.dedupEngine },
              { key: 'chunker', label: t('knowledge.featureChunker'), desc: t('knowledge.featureChunkerDesc'), value: features.chunker },
            ]}
            columns={[
              { title: t('knowledge.featureName'), dataIndex: 'label', key: 'label', width: 120 },
              { title: t('knowledge.featureDesc'), dataIndex: 'desc', key: 'desc' },
              { title: t('knowledge.featureValue'), dataIndex: 'value', key: 'value', render: (v: string) => <Tag color="blue">{v}</Tag> },
            ]}
            pagination={false}
            size="small"
          />
        </Card>
      )}
    </div>
  );
}
