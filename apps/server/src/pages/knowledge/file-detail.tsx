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
        setLoadError(error instanceof Error ? error.message : t('knowledge.fileDetailLoadFailed'));
      })
      .finally(() => setLoading(false));
  }, [relativePath, t]);

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
      message.success(t('knowledge.fileReindexed'));
    } finally {
      setReindexing(false);
    }
  };

  const copyText = async (text?: string) => {
    if (!text) return;
    await navigator.clipboard.writeText(text);
    message.success(t('knowledge.copied'));
  };

  const openTarget = async (target: 'file' | 'directory') => {
    if (!relativePath) return;
    await openKbFileTarget(relativePath, target);
    message.success(target === 'file' ? t('knowledge.openFileRequested') : t('knowledge.openDirectoryRequested'));
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
        key: 'table', label: t('knowledge.table'),
        children: <div className="flex flex-col w-full gap-4">
          {tableDescHasData && <Descriptions size="small" column={2} bordered>
            {metaItem(t('knowledge.sheet'), sheetNames, setFilter)}
            {metaItem(t('knowledge.header'), columnNames, setFilter)}
            {metaItem(t('knowledge.rows'), meta.rowCount)}
            {metaItem(t('knowledge.columns'), meta.columnCount)}
            {metaItem(t('knowledge.formulaCount'), meta.formulaCount)}
            {metaItem(t('knowledge.mergeCount'), meta.mergeCount)}
          </Descriptions>}
          {columnTableRows.length > 0 && <Table size="small" pagination={false} rowKey="key" dataSource={columnTableRows} columns={[{ title: t('knowledge.columnName'), dataIndex: 'name', render: (value: unknown) => <Tag className="cursor-pointer m-0 border-0 bg-[var(--colorFillSecondary)] hover:bg-[var(--colorFillAlter)]" onClick={() => setFilter(String(value))}>{String(value)}</Tag> }]} className="custom-table border border-[var(--borderColor)] rounded-xl overflow-hidden" />}
          {rangeRows.length > 0 && <Table size="small" pagination={false} rowKey="key" dataSource={rangeRows} columns={[{ title: t('knowledge.rowRange'), dataIndex: 'name', render: (value: unknown) => <Tag color="gold" className="cursor-pointer m-0 border-0" onClick={() => setFilter(String(value))}>{t('knowledge.rowPrefix')} {String(value)}</Tag> }]} className="custom-table border border-[var(--borderColor)] rounded-xl overflow-hidden" />}
          {gridRows.length > 0 && <Table size="small" rowKey="key" dataSource={gridRows} pagination={{ pageSize: 10 }} columns={[{ title: t('knowledge.tableGridPreview'), dataIndex: 'cells', render: (cells: unknown) => <Space wrap>{(cells as string[]).map((cell, index) => <Tag key={`${cell}-${index}`} className="m-0 border-0 bg-[var(--colorFillSecondary)]">{cell}</Tag>)}</Space> }]} className="custom-table border border-[var(--borderColor)] rounded-xl overflow-hidden" />}
        </div>,
      });
    }

    // ── 图纸 ──
    const drawDescHasData = layerNamesList.length > 0 || blockNames.length > 0 || entityTypes.length > 0 || productNames.length > 0 || materialNames.length > 0 || entityNames.length > 0;
    const combinedDrawRows = [
      ...kvRows(layerNamesList, 'layer').map(row => ({ ...row, type: t('knowledge.layer') })),
      ...kvRows(entityTypes, 'entity').map(row => ({ ...row, type: t('knowledge.entityType') })),
      ...kvRows(blockNames, 'block').map(row => ({ ...row, type: t('knowledge.blockSymbol') })),
    ];
    if (drawDescHasData || layerNamesList.length > 0 || combinedDrawRows.length > 0) {
      items.push({
        key: 'drawing', label: t('knowledge.drawing'),
        children: <div className="flex flex-col w-full gap-4">
          {drawDescHasData && <Descriptions size="small" column={2} bordered>
            {metaItem(t('knowledge.layer'), layerNamesList, setFilter)}
            {metaItem(t('knowledge.blockSymbol'), blockNames, setFilter)}
            {metaItem(t('knowledge.entityType'), entityTypes, setFilter)}
            {metaItem(t('knowledge.productPart'), productNames, setFilter)}
            {metaItem(t('knowledge.material'), materialNames, setFilter)}
            {metaItem(t('knowledge.entityName'), entityNames, setFilter)}
          </Descriptions>}
          {layerNamesList.length > 0 && <Card size="small" title={t('knowledge.layerTogglePreview')} className="rounded-xl border-[var(--borderColor)]">
            <Checkbox.Group value={visibleLayers} options={layerNamesList.map(layer => ({ label: layer, value: layer }))} onChange={values => setVisibleLayers(values.map(String))} />
            <div className={styles.drawingPreview}>{visibleLayers.map(layer => <Tag key={layer} color="blue">{layer}</Tag>)}</div>
          </Card>}
          {combinedDrawRows.length > 0 && <Table size="small" pagination={false} rowKey="key" dataSource={combinedDrawRows} columns={[{ title: t('knowledge.type'), dataIndex: 'type', width: 120 }, { title: t('knowledge.name'), dataIndex: 'name', render: (value: unknown) => <Tag className="cursor-pointer" onClick={() => setFilter(String(value))}>{String(value)}</Tag> }]} className="custom-table border border-[var(--borderColor)] rounded-xl overflow-hidden" />}
        </div>,
      });
    }

    // ── 数据路径 ──
    const dpRows = dataPreviewRows(detail);
    if (dataPaths.length > 0 || dpRows.length > 0) {
      items.push({
        key: 'data', label: t('knowledge.dataPath'),
        children: <div className="flex flex-col w-full gap-4">
          {dataPaths.length > 0 && <div className="bg-[var(--colorFillAlter)] border border-[var(--colorBorderSecondary)] rounded-xl p-3"><Tree defaultExpandAll treeData={pathTree(dataPaths)} onSelect={keys => setFilter(String(keys[0] ?? ''))} className="bg-transparent" /></div>}
          {dpRows.length > 0 && <Table size="small" rowKey="key" dataSource={dpRows} pagination={{ pageSize: 20 }} columns={[{ title: t('knowledge.path'), dataIndex: 'path', width: 260, render: (value: unknown) => <Tag className="cursor-pointer" onClick={() => setFilter(String(value))}>{String(value)}</Tag> }, { title: t('knowledge.value'), dataIndex: 'value', render: (value: unknown) => <span className="break-all">{String(value)}</span> }]} className="custom-table border border-[var(--borderColor)] rounded-xl overflow-hidden" />}
        </div>,
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
        key: 'ocr', label: t('knowledge.ocrPdf'),
        children: <div className="flex flex-col w-full gap-4">
          {ocrDescHasData && <Descriptions size="small" column={2} bordered>
            {metaItem(t('knowledge.ocrRecommended'), meta.ocrRecommended)}
            {metaItem(t('knowledge.ocrReason'), meta.ocrReason)}
            {metaItem(t('knowledge.ocrProvider'), meta.ocrProvider)}
            {metaItem(t('knowledge.ocrLanguages'), meta.ocrLanguages)}
            {metaItem(t('knowledge.ocrTextLength'), meta.ocrTextLength)}
            {metaItem(t('knowledge.pdfPageCount'), meta.pdfPageCount)}
            {metaItem(t('knowledge.pdfTextPages'), meta.textPages)}
            {metaItem(t('knowledge.pdfOcrAugmented'), meta.ocrAugmented)}
            {metaItem(t('knowledge.pdfOcrPages'), Array.isArray(meta.ocrPages) ? meta.ocrPages.join(', ') : meta.ocrPages)}
            {metaItem(t('knowledge.pdfFailedPages'), Array.isArray(meta.failedPages) ? meta.failedPages.map((item: unknown) => JSON.stringify(item)).join('; ') : meta.failedPages)}
            {metaItem(t('knowledge.pdfPageOcrSupported'), meta.pdfPageOcrSupported)}
            {metaItem(t('knowledge.pdfOcrPageCount'), meta.ocrPageCount)}
            {metaItem(t('knowledge.pdfOcrPageLimit'), meta.pdfOcrPageLimit)}
            {metaItem(t('knowledge.pdfRenderer'), meta.pdfRenderer)}
            {metaItem(t('knowledge.imagePreprocessor'), meta.imagePreprocessor)}
          </Descriptions>}
          {isPdf && <div className={styles.pdfPreviewStrip}>
            {Array.from({ length: Math.min(Number(meta.pdfPageCount ?? meta.ocrPageCount ?? 1) || 1, 6) }, (_, index) => <Image key={index} width={220} height={320} src={`/api/kb/files/preview-pdf-page?relativePath=${encodeURIComponent(detail.file.relativePath)}&page=${index + 1}`} alt={`PDF ${t('knowledge.pageNumber')} ${index + 1}`} unoptimized className="border border-[var(--borderColor)] rounded object-cover" />)}
          </div>}
          {ocrRows.length > 0 && <Table size="small" rowKey="key" dataSource={ocrRows} pagination={{ pageSize: 10 }} columns={[{ title: t('knowledge.pageNumber'), dataIndex: 'page', width: 90 }, { title: t('knowledge.ocrText'), dataIndex: 'text', render: (value: unknown) => <Paragraph ellipsis={{ rows: 4, expandable: true, symbol: t('knowledge.openExpand') }}>{String(value)}</Paragraph> }]} className="custom-table border border-[var(--borderColor)] rounded-xl overflow-hidden" />}
        </div>,
      });
    }

    return items;
  }, [meta, detail, visibleLayers]);

  const chunkColumns: ColumnsType<KbStoredChunk> = [
    { title: t('knowledge.index'), key: 'index', width: 70, render: (_: unknown, __: KbStoredChunk, index: number) => index + 1 },
    { title: t('knowledge.chunkIndex'), dataIndex: 'chunkIndex', width: 90, render: (value: unknown) => String(value) },
    { title: t('knowledge.chunkType'), width: 110, render: (_, row) => <Tag>{String(parseJson(row.metadataJson).chunkKind ?? row.category)}</Tag> },
    { title: t('knowledge.sectionOrRange'), width: 220, render: (_, row) => {
      const m = parseJson(row.metadataJson);
      const rowRange = typeof m.rowRange === 'string' ? m.rowRange : undefined;
      return <Space wrap>{row.sectionTitle ? <Tag color="cyan">{row.sectionTitle}</Tag> : null}{rowRange ? <Tag color="gold">{t('knowledge.rowPrefix')} {rowRange}</Tag> : null}</Space>;
    } },
    { title: t('knowledge.tokens'), dataIndex: 'tokenCount', width: 90 },
    { title: t('knowledge.chunkContent'), render: (_, row) => <Paragraph ellipsis={{ rows: 3, expandable: true, symbol: t('knowledge.openExpand') }} className={styles.searchContent}>{highlight(row.content, filter)}</Paragraph> },
  ];

  const parentColumns: ColumnsType<KbParentChunk> = [
    { title: t('knowledge.index'), key: 'index', width: 70, render: (_: unknown, __: KbParentChunk, index: number) => index + 1 },
    { title: t('knowledge.parentChunkId'), dataIndex: 'parentId', width: 260, render: (value: string) => <span className="break-all">{value}</span> },
    { title: t('knowledge.chunkCount'), dataIndex: 'chunkCount', width: 90 },
    { title: t('knowledge.section'), dataIndex: 'sectionTitle', width: 220 },
    { title: t('knowledge.chunkContent'), render: (_, row) => <Paragraph ellipsis={{ rows: 3, expandable: true, symbol: t('knowledge.openExpand') }} className={styles.searchContent}>{highlight(row.content, filter)}</Paragraph> },
  ];

  if (loading) return (
    <div className="space-y-5 animateFadeIn">
      <Skeleton active paragraph={{ rows: 1 }} />
      <Card size="small"><Skeleton active paragraph={{ rows: 6 }} /></Card>
      <Card size="small"><Skeleton active paragraph={{ rows: 4 }} /></Card>
    </div>
  );
  if (loadError) return <Alert type="error" showIcon description={<><div>{t('knowledge.fileDetailLoadFailed')}</div><div>{loadError}</div></>} />;
  if (!detail) return <Empty description={t('knowledge.selectFile')} />;

  return (
    <div className="space-y-5 animateFadeIn">
      <div className="bg-[var(--colorBgContainer)] rounded-2xl overflow-hidden border border-[var(--borderColor)] p-6 mb-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center">
            <Button icon={<ArrowLeftOutlined />} href="/knowledge/files" type="link" className="p-0 mr-4 text-[var(--colorTextSecondary)] hover:text-[var(--colorText)] flex items-center h-auto">{t('knowledge.backToFileList')}</Button>
            <div>
              <h1 className="text-2xl font-bold text-[var(--colorText)] mb-1 flex items-center gap-2">{t('knowledge.fileDetailTitle')}</h1>
              <p className="text-sm text-[var(--colorTextSecondary)] m-0">{t('knowledge.fileDetailDesc')}</p>
            </div>
          </div>
          <Space wrap className="shrink-0">
            <Button size="small" onClick={() => { void copyText(detail?.absolutePath); }}>{t('knowledge.copySourcePath')}</Button>
            <Button size="small" onClick={() => { void copyText(detail?.directory); }}>{t('knowledge.copyDirectory')}</Button>
            <Button size="small" onClick={() => { void openTarget('file'); }}>{t('assets.openFile')}</Button>
            <Button size="small" onClick={() => { void openTarget('directory'); }}>{t('assets.openDirectory')}</Button>
            {detail.file.format === 'pdf' ? <Button size="small" loading={reindexing} onClick={() => { void doReindex(); }}>{t('knowledge.reOcr')}</Button> : null}
            <Button size="small" type="primary" loading={reindexing} onClick={() => { void doReindex(); }}>{t('knowledge.reindexFile')}</Button>
          </Space>
        </div>
      </div>

      <Card size="small" className="rounded-2xl border-[var(--borderColor)]" title={<span className="font-semibold">{t('knowledge.basicInfo')}</span>}>
        <Descriptions size="small" column={{ xxl: 3, xl: 2, lg: 2, md: 1, sm: 1, xs: 1 }} bordered styles={{ label: { width: '120px', background: 'var(--colorFillAlter)', color: 'var(--colorTextSecondary)' } }}>
          <Descriptions.Item label={t('knowledge.path')} span={3}><span className="break-all">{detail.file.relativePath}</span></Descriptions.Item>
          <Descriptions.Item label={t('knowledge.originalFile')} span={3}><span className="break-all">{detail.absolutePath ?? '-'}</span></Descriptions.Item>
          <Descriptions.Item label={t('knowledge.directory')} span={3}><span className="break-all">{detail.directory ?? '-'}</span></Descriptions.Item>
          <Descriptions.Item label={t('knowledge.fileCategory')}><Space size={4}><Tag className="m-0 border-0 bg-[var(--colorFillSecondary)]">{categoryLabel(detail.file.category)}</Tag> <Tag className="m-0 border-0 bg-[var(--colorFillSecondary)]">{detail.file.format}</Tag></Space></Descriptions.Item>
          <Descriptions.Item label={t('knowledge.fileSize')}>{formatBytes(detail.file.fileSize)}</Descriptions.Item>
          <Descriptions.Item label={t('knowledge.chunkCount')}>{detail.file.chunkCount}</Descriptions.Item>
          <Descriptions.Item label={t('knowledge.status')}><Tag color={detail.file.status === 'completed' ? 'success' : detail.file.status === 'failed' ? 'error' : 'processing'} className="m-0">{detail.file.status}</Tag></Descriptions.Item>
          <Descriptions.Item label={t('knowledge.extractionMode')}>{String(meta.extractionMode ?? '-')}</Descriptions.Item>
          <Descriptions.Item label={t('knowledge.contentCoverage')}>{String(meta.contentCoverage ?? '-')}</Descriptions.Item>
          <Descriptions.Item label={t('knowledge.textLength')}>{String(meta.textLength ?? '-')}</Descriptions.Item>
        </Descriptions>
      </Card>

      {structuredItems.length > 0 && (
        <Card size="small" className="rounded-2xl border-[var(--borderColor)]" title={<span className="font-semibold">{t('knowledge.structuredInfo')}</span>}>
          <Tabs items={structuredItems} className="documents-tabs" />
        </Card>
      )}

      <Card size="small" className="rounded-2xl border-[var(--borderColor)]" title={<span className="font-semibold">{t('knowledge.detailFilter')}</span>}>
        <div className="flex flex-col w-full gap-4">
          <Input allowClear size="large" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('knowledge.detailFilterPlaceholder')} className="rounded-xl bg-[var(--colorBgHover)] border-[var(--borderColor)] focus:bg-[var(--colorBgContainer)] hover:bg-[var(--colorBgContainer)] w-full" />
          {filter ? <div className="flex flex-wrap gap-2 items-center bg-[var(--colorFillAlter)] p-3 rounded-xl border border-[var(--colorBorderSecondary)]">
            <span className="text-sm font-medium text-[var(--colorTextSecondary)] mr-2">过滤结果：</span>
            <Tag color="blue" className="m-0 border-0">{t('knowledge.parentMatches')} {filteredParents.length}</Tag>
            <Tag color="green" className="m-0 border-0">{t('knowledge.childMatches')} {filteredChunks.length}</Tag>
            <div className="w-[1px] h-3 bg-[var(--colorBorderSecondary)] mx-1"></div>
            <span className="text-xs text-[var(--colorTextTertiary)]">{t('knowledge.filterTerm')} <strong className="text-[var(--colorText)]">{filter}</strong></span>
          </div> : null}
        </div>
      </Card>

      <Card size="small" className="rounded-2xl border-[var(--borderColor)]" title={<span className="font-semibold">{t('knowledge.parentChunks')} <Tag className="ml-2 border-0 bg-[var(--colorFillSecondary)] text-xs font-normal">{filteredParents.length} / {detail.parents.length}</Tag></span>}>
        <Alert type="info" showIcon description={t('knowledge.parentChunkHint')} className="mb-4 rounded-xl border-blue-200 bg-blue-50/50" />
        <Table rowKey="id" columns={parentColumns} dataSource={filteredParents} pagination={{ pageSize: 10 }} size="small" className="custom-table" />
      </Card>

      <Card size="small" className="rounded-2xl border-[var(--borderColor)]" title={<span className="font-semibold">{t('knowledge.childChunks')} <Tag className="ml-2 border-0 bg-[var(--colorFillSecondary)] text-xs font-normal">{filteredChunks.length} / {detail.chunks.length}</Tag></span>}>
        <Table rowKey="id" columns={chunkColumns} dataSource={filteredChunks} pagination={{ pageSize: 20 }} size="small" className="custom-table" />
      </Card>
    </div>
  );
}
