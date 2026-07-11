import Link from 'next/link';
import { useState } from 'react';
import { App, Card, Input, Button, Space, Tag, Empty, Typography, Spin, Descriptions, InputNumber, Alert } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { useAppTranslations } from '@/components/Layout';
import { searchKb, searchKbFiles, type KbFileItem, type KbSearchResult } from '@/lib/api';
import styles from './style.module.scss';

const { Paragraph } = Typography;

const WEIGHT_KEYS = ['keyword', 'vector', 'rewrite', 'hybridBonus'] as const;
const SCORE_KEYS = ['keywordScore', 'bm25Score', 'vectorScore', 'rerankBoost', 'hybridScore'] as const;

function score(value?: number) {
  return typeof value === 'number' ? value.toFixed(2) : '-';
}

function translatedValue(t: (key: string) => string, key: string, fallback: string) {
  const value = t(key);
  return value === key ? fallback : value;
}

function highlight(text: string, query: string) {
  const terms = [query.trim(), ...query.split(/[\s,，。；;：:、]+/u)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (terms.length === 0) return text;
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'giu');
  return text.split(pattern).map((part, index) => terms.some(term => term.toLowerCase() === part.toLowerCase()) ? <mark key={index}>{part}</mark> : part);
}

export default function KnowledgeSearchPage() {
  const { message } = App.useApp();
  const t = useAppTranslations('knowledge');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<KbSearchResult[]>([]);
  const [fileResults, setFileResults] = useState<KbFileItem[]>([]);
  const [queryTimeMs, setQueryTimeMs] = useState<number>();
  const [debug, setDebug] = useState<{ originalQuery?: string; rewrittenQueries?: string[]; weights?: Record<string, number>; recallCounts?: Record<string, number>; reranker?: string }>();
  const [error, setError] = useState('');
  const [weights, setWeights] = useState({ keyword: 1, vector: 0.9, rewrite: 0.72, hybridBonus: 0.35 });

  const copyEvidencePath = async (filePath: string) => {
    await navigator.clipboard.writeText(filePath);
    message.success(t('copyPriorityEvidenceSuccess'));
  };

  const doSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    try {
      const [data, fileData] = await Promise.all([
        searchKb(q, { limit: 10, weights }),
        searchKbFiles({ query: q, limit: 20, includeContent: true }),
      ]);
      setResults(data.results);
      setFileResults(fileData.files);
      setQueryTimeMs(data.queryTimeMs);
      setDebug(data.debug);
    } catch (searchError) {
      setResults([]);
      setFileResults([]);
      setError(searchError instanceof Error ? searchError.message : t('searchFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 animateFadeIn">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="pageTitle">{t('searchTitle')}</h1>
          <p className="pageDesc">{t('searchDesc')}</p>
        </div>
        <Link href="/documents"><Button>{t('goToDocuments')}</Button></Link>
      </div>

      <Alert type="info" showIcon message={t('autoSearchFirst')} description={t('autoSearchFirstDesc')} />

      <Card size="small">
        <Space.Compact className="w-full">
          <Input value={query} onChange={event => setQuery(event.target.value)} onPressEnter={() => { void doSearch(); }} placeholder={t('searchContentPlaceholder')} />
          <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={() => { void doSearch(); }}>{t('searchAction')}</Button>
        </Space.Compact>
      </Card>

      <Card size="small" title={t('recallWeightTuning')}>
        <Space wrap>
          {WEIGHT_KEYS.map(key => <span key={key}>{translatedValue(t, `weights.${key}`, key)} <InputNumber min={0} max={key === 'hybridBonus' ? 2 : 5} step={key === 'hybridBonus' ? 0.05 : 0.1} value={weights[key]} onChange={value => setWeights(prev => ({ ...prev, [key]: Number(value ?? prev[key]) }))} /></span>)}
        </Space>
      </Card>

      {fileResults.length > 0 && <Card size="small" title="匹配文件" extra={`${fileResults.length} 个`}>
        <div style={{ display: 'grid', gap: 8 }}>
          {fileResults.map(file => <div key={file.relativePath} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'center', padding: '10px 12px', border: '1px solid var(--colorBorderSecondary)', borderRadius: 10 }}>
            <div style={{ minWidth: 0 }}>
              <Space size={8} wrap>
                <Link href={`/knowledge/file-detail?relativePath=${encodeURIComponent(file.relativePath)}`}>{highlight(file.relativePath, query)}</Link>
                <Tag color={file.matchedBy === 'content' ? 'purple' : file.matchedBy === 'disk' ? 'orange' : 'blue'}>{file.matchedBy === 'content' ? '内容匹配' : file.matchedBy === 'disk' ? '磁盘文件' : '文件匹配'}</Tag>
                <Tag>{file.status}</Tag>
                {file.chunkCount === 0 && <Tag color="warning">未切片</Tag>}
              </Space>
              <div style={{ marginTop: 4, color: 'var(--colorTextSecondary)', fontSize: 12 }}>{file.category || '未分类'} · {file.format || '未知格式'} · {Math.round((file.fileSize || 0) / 1024)} KB</div>
            </div>
            <Button size="small" onClick={() => { void copyEvidencePath(file.relativePath); }}>{t('copyAsPriorityEvidence')}</Button>
          </div>)}
        </div>
      </Card>}

      {debug && <Card size="small" title={t('debugPanel')}>
        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label={t('originalQuery')}>{debug.originalQuery}</Descriptions.Item>
          <Descriptions.Item label={t('reranker')}>{debug.reranker}</Descriptions.Item>
          <Descriptions.Item label={t('rewrittenQueries')} span={2}><Space wrap>{debug.rewrittenQueries?.map(item => <Tag key={item}>{item}</Tag>)}</Space></Descriptions.Item>
          <Descriptions.Item label={t('recallCounts')} span={2}><Space wrap>{Object.entries(debug.recallCounts ?? {}).map(([key, value]) => <Tag key={key}>{translatedValue(t, `recallSources.${key}`, key)}: {value}</Tag>)}</Space></Descriptions.Item>
          <Descriptions.Item label={t('recallWeights')} span={2}><Space wrap>{Object.entries(debug.weights ?? {}).map(([key, value]) => <Tag key={key}>{translatedValue(t, `weights.${key}`, key)}: {value}</Tag>)}</Space></Descriptions.Item>
        </Descriptions>
      </Card>}

      <Card size="small" title={t('searchResults')} extra={typeof queryTimeMs === 'number' ? `${queryTimeMs} ms` : undefined}>
        {error ? <Alert type="error" showIcon message={t('searchFailed')} description={error} className="mb-4" /> : null}
        {loading ? <Spin /> : results.length === 0 ? <Empty description={t('noSearchResults')} /> : <div className={styles.searchResultList}>
          {results.map((item, index) => <div key={item.id} className={styles.searchResultItem}>
            <div className={styles.searchResultHeader}>
              <Space size={8} wrap>
                <Tag>{t('resultIndex')} {index + 1}</Tag>
                <Tag color={item.source === 'hybrid' ? 'purple' : item.source === 'vector' ? 'blue' : 'green'}>{translatedValue(t, `recallSources.${item.source ?? 'keyword'}`, item.source ?? 'keyword')}</Tag>
                <Tag>{translatedValue(t, `scopes.${item.scope}`, item.scope)}</Tag>
                {item.chunkKind && <Tag color="geekblue">{item.chunkKind}</Tag>}
                {item.rowRange && <Tag color="gold">{t('rowRange')} {item.rowRange}</Tag>}
                {item.sectionTitle && <Tag color="cyan">{item.sectionTitle}</Tag>}
              </Space>
              <strong>{score(item.score)}</strong>
            </div>
            <div className={styles.statusPath}>
              <Space size={8} wrap>
                <Link href={`/knowledge/file-detail?relativePath=${encodeURIComponent(item.filePath)}`}>{item.filePath}</Link>{typeof item.chunkIndex === 'number' ? ` #${item.chunkIndex}` : ''}
                <Button size="small" onClick={() => { void copyEvidencePath(item.filePath); }}>{t('copyAsPriorityEvidence')}</Button>
              </Space>
            </div>
            <Paragraph ellipsis={{ rows: 6, expandable: true, symbol: t('expand') }} className={styles.searchContent}>{highlight(item.content, query)}</Paragraph>
            {item.facets && Object.keys(item.facets).length > 0 && <div className={styles.statusMeta}>
              {Object.entries(item.facets).slice(0, 8).map(([key, value]) => <span key={key}>{key} <b>{Array.isArray(value) ? value.join(', ') : String(value)}</b></span>)}
            </div>}
            <div className={styles.statusMeta}>
              {SCORE_KEYS.map(key => <span key={key}>{translatedValue(t, `scoreDetails.${key}`, key)} <b>{score(item.scoreDetails?.[key])}</b></span>)}
            </div>
          </div>)}
        </div>}
      </Card>
    </div>
  );
}
