import { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card, Button, Row, Col, Spin, Statistic, Table, Tag, App, Segmented } from 'antd';
import { DatabaseOutlined, FileOutlined, HddOutlined, ClockCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useKbStats, useKbFeatures, useReindex } from '@/hooks/useKbData';
import { getKbFiles } from '@/lib/api';
import { formatBytes, formatRelativeTime } from '@/lib/utils';

const CATEGORY_LABELS: Record<string, string> = {
  document: '文档', spreadsheet: '表格', image: '图片', cad: 'CAD',
  code: '代码', data: '数据', web: '网页', diagram: '图表',
  archive: '压缩包', other: '其他',
};

const ALL_CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);

export default function KnowledgeManagePage() {
  const t = useTranslations();
  const { stats, loading } = useKbStats();
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

  if (loading && !stats) return <div className="flex justify-center py-16"><Spin size="large" /></div>;

  return (
    <div className="space-y-6 animateFadeIn">
      <div className="flex items-center justify-between">
        <div><h1 className="pageTitle">{t('knowledge.manageTitle')}</h1><p className="pageDesc">{t('knowledge.manageDesc')}</p></div>
        <Button icon={<ReloadOutlined />} loading={reindexing} onClick={() => reindex()}>{t('knowledge.reindex')}</Button>
      </div>

      <Row gutter={[16, 16]}>
        {[
          { icon: <FileOutlined />, label: t('knowledge.totalFiles'), value: stats?.fileCount ?? 0 },
          { icon: <DatabaseOutlined />, label: t('knowledge.totalChunks'), value: stats?.chunkCount ?? 0 },
          { icon: <HddOutlined />, label: t('knowledge.totalSize'), value: formatBytes(stats?.totalSizeBytes ?? 0) },
          { icon: <ClockCircleOutlined />, label: t('knowledge.lastIndexed'), value: stats?.lastIndexedAt ? formatRelativeTime(stats.lastIndexedAt) : t('common.never') },
        ].map((item, i) => (
          <Col xs={12} sm={6} key={i}>
            <Card size="small"><Statistic title={item.label} value={item.value} prefix={item.icon} /></Card>
          </Col>
        ))}
      </Row>

      <Card title={t('knowledge.categories')} size="small">
        <Segmented
          value={category}
          onChange={(v) => setCategory(String(v))}
          options={ALL_CATEGORY_KEYS.map(k => ({ label: CATEGORY_LABELS[k] || k, value: k }))}
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
