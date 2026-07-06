import Link from 'next/link';
import { useState } from 'react';
import { Card, Input, Button, Space, Tag, Empty, Typography, Spin, Descriptions, InputNumber, Alert } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { searchKb, type KbSearchResult } from '@/lib/api';
import styles from './style.module.scss';

const { Paragraph } = Typography;

function score(value?: number) {
  return typeof value === 'number' ? value.toFixed(2) : '-';
}

function highlight(text: string, query: string) {
  const terms = [query.trim(), ...query.split(/[\s,，。；;：:、]+/u)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (terms.length === 0) return text;
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'giu');
  return text.split(pattern).map((part, index) => terms.some(term => term.toLowerCase() === part.toLowerCase()) ? <mark key={index}>{part}</mark> : part);
}

export default function KnowledgeSearchPage() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<KbSearchResult[]>([]);
  const [queryTimeMs, setQueryTimeMs] = useState<number>();
  const [debug, setDebug] = useState<{ originalQuery?: string; rewrittenQueries?: string[]; weights?: Record<string, number>; recallCounts?: Record<string, number>; reranker?: string }>();
  const [error, setError] = useState('');
  const [weights, setWeights] = useState({ keyword: 1, vector: 0.9, rewrite: 0.72, hybridBonus: 0.35 });

  const doSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    try {
      const data = await searchKb(q, { limit: 10, weights });
      setResults(data.results);
      setQueryTimeMs(data.queryTimeMs);
      setDebug(data.debug);
    } catch (searchError) {
      setResults([]);
      setError(searchError instanceof Error ? searchError.message : '搜索失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 animateFadeIn">
      <div>
        <h1 className="pageTitle">知识库搜索</h1>
        <p className="pageDesc">查看 hybrid 检索、parent 回填、分块来源和评分明细。</p>
      </div>

      <Card size="small">
        <Space.Compact className="w-full">
          <Input value={query} onChange={event => setQuery(event.target.value)} onPressEnter={() => { void doSearch(); }} placeholder="输入要搜索的知识库内容" />
          <Button type="primary" icon={<SearchOutlined />} loading={loading} onClick={() => { void doSearch(); }}>搜索</Button>
        </Space.Compact>
      </Card>

      <Card size="small" title="召回权重调节">
        <Space wrap>
          <span>Keyword <InputNumber min={0} max={5} step={0.1} value={weights.keyword} onChange={value => setWeights(prev => ({ ...prev, keyword: Number(value ?? 1) }))} /></span>
          <span>Vector <InputNumber min={0} max={5} step={0.1} value={weights.vector} onChange={value => setWeights(prev => ({ ...prev, vector: Number(value ?? 0.9) }))} /></span>
          <span>Rewrite <InputNumber min={0} max={5} step={0.1} value={weights.rewrite} onChange={value => setWeights(prev => ({ ...prev, rewrite: Number(value ?? 0.72) }))} /></span>
          <span>Hybrid Bonus <InputNumber min={0} max={2} step={0.05} value={weights.hybridBonus} onChange={value => setWeights(prev => ({ ...prev, hybridBonus: Number(value ?? 0.35) }))} /></span>
        </Space>
      </Card>

      {debug && <Card size="small" title="检索调试面板">
        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label="原始查询">{debug.originalQuery}</Descriptions.Item>
          <Descriptions.Item label="Reranker">{debug.reranker}</Descriptions.Item>
          <Descriptions.Item label="查询改写" span={2}><Space wrap>{debug.rewrittenQueries?.map(item => <Tag key={item}>{item}</Tag>)}</Space></Descriptions.Item>
          <Descriptions.Item label="召回数量" span={2}><Space wrap>{Object.entries(debug.recallCounts ?? {}).map(([key, value]) => <Tag key={key}>{key}: {value}</Tag>)}</Space></Descriptions.Item>
          <Descriptions.Item label="召回权重" span={2}><Space wrap>{Object.entries(debug.weights ?? {}).map(([key, value]) => <Tag key={key}>{key}: {value}</Tag>)}</Space></Descriptions.Item>
        </Descriptions>
      </Card>}

      <Card size="small" title="搜索结果" extra={typeof queryTimeMs === 'number' ? `${queryTimeMs} ms` : undefined}>
        {error ? <Alert type="error" showIcon message="搜索失败" description={error} className="mb-4" /> : null}
        {loading ? <Spin /> : results.length === 0 ? <Empty description="暂无结果" /> : <div className={styles.searchResultList}>
          {results.map((item, index) => <div key={item.id} className={styles.searchResultItem}>
            <div className={styles.searchResultHeader}>
              <Space size={8} wrap>
                <Tag>序号 {index + 1}</Tag>
                <Tag color={item.source === 'hybrid' ? 'purple' : item.source === 'vector' ? 'blue' : 'green'}>{item.source ?? 'keyword'}</Tag>
                <Tag>{item.scope}</Tag>
                {item.chunkKind && <Tag color="geekblue">{item.chunkKind}</Tag>}
                {item.rowRange && <Tag color="gold">行 {item.rowRange}</Tag>}
                {item.sectionTitle && <Tag color="cyan">{item.sectionTitle}</Tag>}
              </Space>
              <strong>{score(item.score)}</strong>
            </div>
            <div className={styles.statusPath}><Link href={`/knowledge/file-detail?relativePath=${encodeURIComponent(item.filePath)}`}>{item.filePath}</Link>{typeof item.chunkIndex === 'number' ? ` #${item.chunkIndex}` : ''}</div>
            <Paragraph ellipsis={{ rows: 6, expandable: true, symbol: '展开' }} className={styles.searchContent}>{highlight(item.content, query)}</Paragraph>
            {item.facets && Object.keys(item.facets).length > 0 && <div className={styles.statusMeta}>
              {Object.entries(item.facets).slice(0, 8).map(([key, value]) => <span key={key}>{key} <b>{Array.isArray(value) ? value.join(', ') : String(value)}</b></span>)}
            </div>}
            <div className={styles.statusMeta}>
              <span>keyword <b>{score(item.scoreDetails?.keywordScore)}</b></span>
              <span>bm25 <b>{score(item.scoreDetails?.bm25Score)}</b></span>
              <span>vector <b>{score(item.scoreDetails?.vectorScore)}</b></span>
              <span>rerank <b>{score(item.scoreDetails?.rerankBoost)}</b></span>
              <span>hybrid <b>{score(item.scoreDetails?.hybridScore)}</b></span>
            </div>
          </div>)}
        </div>}
      </Card>
    </div>
  );
}
