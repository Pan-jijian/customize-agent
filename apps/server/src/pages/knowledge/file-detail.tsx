import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/router';
import { Alert, Button, Card, Checkbox, Descriptions, Empty, Input, message, Skeleton, Space, Tag, Tabs, Table, Tree, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { getKbFileDetail, openKbFileTarget, reindexKbFile, type KbFileDetail, type KbStoredChunk, type KbParentChunk } from '@/lib/api';
import { useAppTranslations } from '@/components/Layout';
import { formatBytes, categoryLabel } from '@/lib/utils';
import styles from './style.module.scss';

const { Paragraph } = Typography;

type Meta = Record<string, unknown>;

function parseJson(value?: string): Meta {
  if (!value) return {};
  try { return JSON.parse(value) as Meta; } catch { return {}; }
}

function extractionMeta(detail?: KbFileDetail): Meta {
  const raw = parseJson(detail?.file.metadataJson);
  return typeof raw.extraction === 'object' && raw.extraction ? raw.extraction as Meta : raw;
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 30) as string[] : [];
}

function highlight(text: string, query: string) {
  const terms = query.trim() ? [query.trim(), ...query.split(/[\s,，。；;：:、]+/u)].filter(Boolean).sort((a, b) => b.length - a.length) : [];
  if (terms.length === 0) return text;
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})`, 'giu');
  return text.split(pattern).map((part, index) => terms.some(term => term.toLowerCase() === part.toLowerCase()) ? <mark key={index}>{part}</mark> : part);
}

function metaItem(label: string, value: unknown, onFilter?: (value: string) => void) {
  if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
  return <Descriptions.Item label={label}>{Array.isArray(value) ? <Space wrap>{value.map(item => <Tag className="cursor-pointer" key={String(item)} onClick={() => onFilter?.(String(item))}>{String(item)}</Tag>)}</Space> : String(value)}</Descriptions.Item>;
}

function kvRows(values: string[], name = 'value') {
  return values.map((value, index) => ({ key: `${name}-${index}`, name: value }));
}

function tableGridRows(detail?: KbFileDetail) {
  const lines = (detail?.chunks ?? []).flatMap(chunk => chunk.content.split(/\r?\n/u)).map(line => line.trim()).filter(line => line.includes('|'));
  return lines.slice(0, 80).map((line, index) => ({ key: `grid-${index}`, cells: line.split('|').map(cell => cell.trim()).filter(Boolean) }));
}

function rowRangeRows(detail?: KbFileDetail) {
  return (detail?.chunks ?? []).map(chunk => parseJson(chunk.metadataJson).rowRange).filter((value): value is string => typeof value === 'string').map((value, index) => ({ key: `row-${index}`, name: value }));
}

function ocrPageRows(detail?: KbFileDetail) {
  const content = (detail?.chunks ?? []).map(chunk => chunk.content).join('\n\n');
  return content.split(/PDF OCR 第\s*(\d+)\s*页[:：]/u).slice(1).reduce<Array<{ key: string; page: string; text: string }>>((rows, value, index, parts) => {
    if (index % 2 === 0) rows.push({ key: `page-${value}`, page: value, text: parts[index + 1]?.split(/PDF OCR 第\s*\d+\s*页[:：]/u)[0]?.trim() ?? '' });
    return rows;
  }, []);
}

function dataPreviewRows(detail?: KbFileDetail) {
  return (detail?.chunks ?? [])
    .flatMap(chunk => chunk.content.split(/\r?\n/u))
    .map(line => line.trim())
    .filter(line => /^[\w.[\]-]+\s*[:=]/u.test(line))
    .slice(0, 200)
    .map((line, index) => {
      const match = /^([^:=]+)\s*[:=]\s*(.*)$/u.exec(line);
      return { key: `data-${index}`, path: match?.[1]?.trim() ?? line, value: match?.[2]?.trim() ?? '' };
    });
}

function pathTree(paths: string[]) {
  const root = new Map<string, any>();
  for (const path of paths) {
    let node = root;
    const parts = path.replace(/\[(\d+)\]/gu, '.$1').split('.').filter(Boolean);
    for (const part of parts) {
      if (!node.has(part)) node.set(part, new Map<string, any>());
      node = node.get(part);
    }
  }
  const toNodes = (map: Map<string, any>, prefix = ''): any[] => [...map.entries()].map(([key, child]) => ({
    title: key,
    key: prefix ? `${prefix}.${key}` : key,
    children: toNodes(child, prefix ? `${prefix}.${key}` : key),
  }));
  return toNodes(root);
}

export default function KnowledgeFileDetailPage() {
  const t = useAppTranslations();
  const router = useRouter();
  const relativePath = typeof router.query.relativePath === 'string' ? router.query.relativePath : '';
  const [detail, setDetail] = useState<KbFileDetail>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [reindexing, setReindexing] = useState(false);
  const [filter, setFilter] = useState('');
  const [visibleLayers, setVisibleLayers] = useState<string[]>([]);

  useEffect(() => {
    if (!relativePath) return;
    setLoading(true);
    setLoadError('');
    void getKbFileDetail(relativePath)
      .then(setDetail)
      .catch(error => {
        setDetail(undefined);
        setLoadError(error instanceof Error ? error.message : '文件详情加载失败');
      })
      .finally(() => setLoading(false));
  }, [relativePath]);

  const meta = useMemo(() => extractionMeta(detail), [detail]);
  const layerNames = asList(meta.layerNames);
  useEffect(() => {
    setVisibleLayers(layerNames);
  }, [detail?.file.relativePath, layerNames.join('|')]);
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredChunks = useMemo(() => {
    if (!detail || !normalizedFilter) return detail?.chunks ?? [];
    return detail.chunks.filter(chunk => {
      const metadata = parseJson(chunk.metadataJson);
      return [chunk.content, chunk.sectionTitle, metadata.rowRange, metadata.chunkKind, metadata.parentId, JSON.stringify(metadata)]
        .some(value => String(value ?? '').toLowerCase().includes(normalizedFilter));
    });
  }, [detail, normalizedFilter]);
  const filteredParents = useMemo(() => {
    if (!detail || !normalizedFilter) return detail?.parents ?? [];
    return detail.parents.filter(parent => [parent.content, parent.sectionTitle, parent.parentId, parent.metadataJson]
      .some(value => String(value ?? '').toLowerCase().includes(normalizedFilter)));
  }, [detail, normalizedFilter]);

  const doReindex = async () => {
    if (!relativePath) return;
    setReindexing(true);
    try {
      const result = await reindexKbFile(relativePath);
      if (result.detail) setDetail(result.detail);
      message.success('文件索引已重建');
    } finally {
      setReindexing(false);
    }
  };

  const copyText = async (text?: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    message.success('已复制');
  };

  const openTarget = async (target: 'file' | 'directory') => {
    if (!relativePath) return;
    await openKbFileTarget(relativePath, target);
    message.success(target === 'file' ? '已请求打开文件' : '已请求打开目录');
  };

  const structuredItems = useMemo(() => {
    const items: Array<{ key: string; label: string; children: React.ReactNode }> = [];

    const sheetNames = asList(meta.sheetNames);
    const columnNames = asList(meta.columnNames);
    const layerNamesList = asList(meta.layerNames);
    const blockNames = asList(meta.blockNames);
    const entityTypes = asList(meta.entityTypes);
    const productNames = asList(meta.productNames);
    const materialNames = asList(meta.materialNames);
    const entityNames = asList(meta.entityNames);
    const dataPaths = asList(meta.dataPaths);

    // ── 表格 ──
    const tableDescHasData = sheetNames.length > 0 || columnNames.length > 0 || meta.rowCount != null || meta.columnCount != null || meta.formulaCount != null || meta.mergeCount != null;
    const columnTableRows = kvRows(columnNames, 'column');
    const rangeRows = rowRangeRows(detail);
    const gridRows = tableGridRows(detail);
    if (tableDescHasData || columnTableRows.length > 0 || rangeRows.length > 0 || gridRows.length > 0) {
      items.push({
        key: 'table', label: '表格',
        children: <Space direction="vertical" className="w-full">
          {tableDescHasData && <Descriptions size="small" column={2} bordered>
            {metaItem('Sheet', sheetNames, setFilter)}
            {metaItem('表头', columnNames, setFilter)}
            {metaItem('行数', meta.rowCount)}
            {metaItem('列数', meta.columnCount)}
            {metaItem('公式数', meta.formulaCount)}
            {metaItem('合并单元格', meta.mergeCount)}
          </Descriptions>}
          {columnTableRows.length > 0 && <Table size="small" pagination={false} rowKey="key" dataSource={columnTableRows} columns={[{ title: '列名', dataIndex: 'name', render: (value: unknown) => <Tag className="cursor-pointer" onClick={() => setFilter(String(value))}>{String(value)}</Tag> }]} />}
          {rangeRows.length > 0 && <Table size="small" pagination={false} rowKey="key" dataSource={rangeRows} columns={[{ title: '行范围', dataIndex: 'name', render: (value: unknown) => <Tag color="gold" className="cursor-pointer" onClick={() => setFilter(String(value))}>行 {String(value)}</Tag> }]} />}
          {gridRows.length > 0 && <Table size="small" rowKey="key" dataSource={gridRows} pagination={{ pageSize: 10 }} columns={[{ title: '表格网格预览', dataIndex: 'cells', render: (cells: unknown) => <Space wrap>{(cells as string[]).map((cell, index) => <Tag key={`${cell}-${index}`}>{cell}</Tag>)}</Space> }]} />}
        </Space>,
      });
    }

    // ── 图纸 ──
    const drawDescHasData = layerNamesList.length > 0 || blockNames.length > 0 || entityTypes.length > 0 || productNames.length > 0 || materialNames.length > 0 || entityNames.length > 0;
    const combinedDrawRows = [
      ...kvRows(layerNamesList, 'layer').map(row => ({ ...row, type: '图层' as const })),
      ...kvRows(entityTypes, 'entity').map(row => ({ ...row, type: '实体类型' as const })),
      ...kvRows(blockNames, 'block').map(row => ({ ...row, type: '块/符号' as const })),
    ];
    if (drawDescHasData || layerNamesList.length > 0 || combinedDrawRows.length > 0) {
      items.push({
        key: 'drawing', label: '图纸',
        children: <Space direction="vertical" className="w-full">
          {drawDescHasData && <Descriptions size="small" column={2} bordered>
            {metaItem('图层', layerNamesList, setFilter)}
            {metaItem('块/符号', blockNames, setFilter)}
            {metaItem('实体类型', entityTypes, setFilter)}
            {metaItem('产品/零件', productNames, setFilter)}
            {metaItem('材料', materialNames, setFilter)}
            {metaItem('实体名称', entityNames, setFilter)}
          </Descriptions>}
          {layerNamesList.length > 0 && <Card size="small" title="图层开关 / 图纸预览">
            <Checkbox.Group value={visibleLayers} options={layerNamesList.map(layer => ({ label: layer, value: layer }))} onChange={values => setVisibleLayers(values.map(String))} />
            <div className={styles.drawingPreview}>{visibleLayers.map(layer => <Tag key={layer} color="blue">{layer}</Tag>)}</div>
          </Card>}
          {combinedDrawRows.length > 0 && <Table size="small" pagination={false} rowKey="key" dataSource={combinedDrawRows} columns={[{ title: '类型', dataIndex: 'type', width: 120 }, { title: '名称', dataIndex: 'name', render: (value: unknown) => <Tag className="cursor-pointer" onClick={() => setFilter(String(value))}>{String(value)}</Tag> }]} />}
        </Space>,
      });
    }

    // ── 数据路径 ──
    const dpRows = dataPreviewRows(detail);
    if (dataPaths.length > 0 || dpRows.length > 0) {
      items.push({
        key: 'data', label: '数据路径',
        children: <Space direction="vertical" className="w-full">
          {dataPaths.length > 0 && <Tree defaultExpandAll treeData={pathTree(dataPaths)} onSelect={keys => setFilter(String(keys[0] ?? ''))} />}
          {dpRows.length > 0 && <Table size="small" rowKey="key" dataSource={dpRows} pagination={{ pageSize: 20 }} columns={[{ title: 'Path', dataIndex: 'path', width: 260, render: (value: unknown) => <Tag className="cursor-pointer" onClick={() => setFilter(String(value))}>{String(value)}</Tag> }, { title: 'Value', dataIndex: 'value', render: (value: unknown) => <span className="break-all">{String(value)}</span> }]} />}
        </Space>,
      });
    }

    // ── OCR/PDF ──
    const ocrDescHasData = [
      meta.ocrRecommended,
      meta.ocrReason,
      meta.ocrProvider,
      meta.ocrLanguages,
      meta.ocrTextLength,
      meta.pdfPageOcrSupported,
      meta.ocrPageCount,
      meta.pdfOcrPageLimit,
      meta.pdfRenderer,
      meta.pdfPageCount,
      meta.textPages,
      meta.ocrAugmented,
      meta.ocrPages,
      meta.failedPages,
      meta.imagePreprocessor,
    ].some(value => value != null);
    const ocrRows = ocrPageRows(detail);
    const isPdf = detail?.file.format === 'pdf';
    if (ocrDescHasData || isPdf || ocrRows.length > 0) {
      items.push({
        key: 'ocr', label: 'OCR/PDF',
        children: <Space direction="vertical" className="w-full">
          {ocrDescHasData && <Descriptions size="small" column={2} bordered>
            {metaItem('OCR 建议', meta.ocrRecommended)}
            {metaItem('OCR 原因', meta.ocrReason)}
            {metaItem('OCR 引擎', meta.ocrProvider)}
            {metaItem('OCR 语言', meta.ocrLanguages)}
            {metaItem('OCR 文本长度', meta.ocrTextLength)}
            {metaItem('PDF 总页数', meta.pdfPageCount)}
            {metaItem('PDF 文本页数', meta.textPages)}
            {metaItem('PDF 已 OCR 增强', meta.ocrAugmented)}
            {metaItem('PDF OCR 页码', Array.isArray(meta.ocrPages) ? meta.ocrPages.join(', ') : meta.ocrPages)}
            {metaItem('PDF 失败页', Array.isArray(meta.failedPages) ? meta.failedPages.map((item: unknown) => JSON.stringify(item)).join('; ') : meta.failedPages)}
            {metaItem('PDF 页面 OCR 支持', meta.pdfPageOcrSupported)}
            {metaItem('PDF OCR 页数', meta.ocrPageCount)}
            {metaItem('PDF OCR 页数上限', meta.pdfOcrPageLimit)}
            {metaItem('PDF 渲染器', meta.pdfRenderer)}
            {metaItem('图像预处理', meta.imagePreprocessor)}
          </Descriptions>}
          {isPdf && <div className={styles.pdfPreviewStrip}>
            {Array.from({ length: Math.min(Number(meta.pdfPageCount ?? meta.ocrPageCount ?? 1) || 1, 6) }, (_, index) => <Image key={index} width={220} height={320} src={`/api/kb/files/preview-pdf-page?relativePath=${encodeURIComponent(detail.file.relativePath)}&page=${index + 1}`} alt={`PDF 第 ${index + 1} 页`} unoptimized />)}
          </div>}
          {ocrRows.length > 0 && <Table size="small" rowKey="key" dataSource={ocrRows} pagination={{ pageSize: 10 }} columns={[{ title: '页码', dataIndex: 'page', width: 90 }, { title: 'OCR 文本', dataIndex: 'text', render: (value: unknown) => <Paragraph ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}>{String(value)}</Paragraph> }]} />}
        </Space>,
      });
    }

    return items;
  }, [meta, detail, visibleLayers]);

  const chunkColumns: ColumnsType<KbStoredChunk> = [
    { title: '序号', key: 'index', width: 70, render: (_: unknown, __: KbStoredChunk, index: number) => index + 1 },
    { title: t('knowledge.chunkIndex'), dataIndex: 'chunkIndex', width: 90, render: (value: unknown) => String(value) },
    { title: t('knowledge.chunkType'), width: 110, render: (_, row) => <Tag>{String(parseJson(row.metadataJson).chunkKind ?? row.category)}</Tag> },
    { title: t('knowledge.sectionOrRange'), width: 220, render: (_, row) => {
      const m = parseJson(row.metadataJson);
      const rowRange = typeof m.rowRange === 'string' ? m.rowRange : undefined;
      return <Space wrap>{row.sectionTitle ? <Tag color="cyan">{row.sectionTitle}</Tag> : null}{rowRange ? <Tag color="gold">行 {rowRange}</Tag> : null}</Space>;
    } },
    { title: 'Token', dataIndex: 'tokenCount', width: 90 },
    { title: t('knowledge.chunkContent'), render: (_, row) => <Paragraph ellipsis={{ rows: 3, expandable: true, symbol: '展开' }} className={styles.searchContent}>{highlight(row.content, filter)}</Paragraph> },
  ];

  const parentColumns: ColumnsType<KbParentChunk> = [
    { title: '序号', key: 'index', width: 70, render: (_: unknown, __: KbParentChunk, index: number) => index + 1 },
    { title: t('knowledge.parentChunkId'), dataIndex: 'parentId', width: 260, render: (value: string) => <span className="break-all">{value}</span> },
    { title: '切片数', dataIndex: 'chunkCount', width: 90 },
    { title: '章节', dataIndex: 'sectionTitle', width: 220 },
    { title: t('knowledge.chunkContent'), render: (_, row) => <Paragraph ellipsis={{ rows: 3, expandable: true, symbol: '展开' }} className={styles.searchContent}>{highlight(row.content, filter)}</Paragraph> },
  ];

  if (loading) return (
    <div className="space-y-5 animateFadeIn">
      <Skeleton active paragraph={{ rows: 1 }} />
      <Card size="small"><Skeleton active paragraph={{ rows: 6 }} /></Card>
      <Card size="small"><Skeleton active paragraph={{ rows: 4 }} /></Card>
    </div>
  );
  if (loadError) return <Alert type="error" showIcon message="文件详情加载失败" description={loadError} />;
  if (!detail) return <Empty description="请选择文件" />;

  return (
    <div className="space-y-5 animateFadeIn">
      <div>
        <Button icon={<ArrowLeftOutlined />} href="/knowledge/files" size="small" style={{ marginBottom: 12 }}>返回文件列表</Button>
        <div className={styles.searchResultHeader}>
          <div>
            <h1 className="pageTitle">文件详情</h1>
            <p className="pageDesc">查看解析结果、图纸/表格/数据结构化字段、parent chunk 和 child chunk。</p>
          </div>
          <Space>
            <Button onClick={() => { void copyText(detail?.absolutePath); }}>复制原文件路径</Button>
            <Button onClick={() => { void copyText(detail?.directory); }}>复制所在目录</Button>
            <Button onClick={() => { void openTarget('file'); }}>打开文件</Button>
            <Button onClick={() => { void openTarget('directory'); }}>打开目录</Button>
            {detail.file.format === 'pdf' ? <Button loading={reindexing} onClick={() => { void doReindex(); }}>重新 OCR</Button> : null}
            <Button type="primary" loading={reindexing} onClick={() => { void doReindex(); }}>重建该文件索引</Button>
          </Space>
        </div>
      </div>

      <Card size="small" title="基础信息">
        <Descriptions size="small" column={2} bordered>
          <Descriptions.Item label="路径">{detail.file.relativePath}</Descriptions.Item>
          <Descriptions.Item label="原文件">{detail.absolutePath ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="所在目录">{detail.directory ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="分类"><Tag>{categoryLabel(detail.file.category)}</Tag> <Tag>{detail.file.format}</Tag></Descriptions.Item>
          <Descriptions.Item label="大小">{formatBytes(detail.file.fileSize)}</Descriptions.Item>
          <Descriptions.Item label="切片数">{detail.file.chunkCount}</Descriptions.Item>
          <Descriptions.Item label="状态">{detail.file.status}</Descriptions.Item>
          <Descriptions.Item label="解析模式">{String(meta.extractionMode ?? '-')}</Descriptions.Item>
          <Descriptions.Item label="覆盖范围">{String(meta.contentCoverage ?? '-')}</Descriptions.Item>
          <Descriptions.Item label="正文长度">{String(meta.textLength ?? '-')}</Descriptions.Item>
        </Descriptions>
      </Card>

      {structuredItems.length > 0 && (
        <Card size="small" title="结构化信息">
          <Tabs items={structuredItems} />
        </Card>
      )}

      <Card size="small" title="详情筛选">
        <Space direction="vertical" className="w-full">
          <Input allowClear value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选 rowRange、图层、实体、data path、section、chunk 内容" />
          {filter ? <Space wrap>
            <Tag color="blue">{t('knowledge.parentMatches')} {filteredParents.length}</Tag>
            <Tag color="green">{t('knowledge.childMatches')} {filteredChunks.length}</Tag>
            <Tag color="purple">{t('knowledge.filterTerm')} {filter}</Tag>
          </Space> : null}
        </Space>
      </Card>

      <Card size="small" title={`${t('knowledge.parentChunks')} (${filteredParents.length}/${detail.parents.length})`}>
        <Alert type="info" showIcon message={t('knowledge.parentChunkHint')} style={{ marginBottom: 12 }} />
        <Table rowKey="id" columns={parentColumns} dataSource={filteredParents} pagination={{ pageSize: 10 }} size="small" />
      </Card>

      <Card size="small" title={`${t('knowledge.childChunks')} (${filteredChunks.length}/${detail.chunks.length})`}>
        <Table rowKey="id" columns={chunkColumns} dataSource={filteredChunks} pagination={{ pageSize: 20 }} size="small" />
      </Card>
    </div>
  );
}
