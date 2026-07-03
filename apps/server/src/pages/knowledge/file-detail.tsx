import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Button, Card, Checkbox, Descriptions, Empty, Input, message, Space, Spin, Tag, Tabs, Table, Tree, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { getKbFileDetail, openKbFileTarget, reindexKbFile, type KbFileDetail, type KbStoredChunk, type KbParentChunk } from '@/lib/api';
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
  const router = useRouter();
  const relativePath = typeof router.query.relativePath === 'string' ? router.query.relativePath : '';
  const [detail, setDetail] = useState<KbFileDetail>();
  const [loading, setLoading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [filter, setFilter] = useState('');
  const [visibleLayers, setVisibleLayers] = useState<string[]>([]);

  useEffect(() => {
    if (!relativePath) return;
    setLoading(true);
    void getKbFileDetail(relativePath).then(setDetail).finally(() => setLoading(false));
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

  const structuredItems = [
    {
      key: 'table',
      label: '表格',
      children: <Space direction="vertical" className="w-full">
        <Descriptions size="small" column={2} bordered>
          {metaItem('Sheet', asList(meta.sheetNames), setFilter)}
          {metaItem('表头', asList(meta.columnNames), setFilter)}
          {metaItem('行数', meta.rowCount)}
          {metaItem('列数', meta.columnCount)}
          {metaItem('公式数', meta.formulaCount)}
          {metaItem('合并单元格', meta.mergeCount)}
        </Descriptions>
        <Table size="small" pagination={false} rowKey="key" dataSource={kvRows(asList(meta.columnNames), 'column')} columns={[{ title: '列名', dataIndex: 'name', render: value => <Tag className="cursor-pointer" onClick={() => setFilter(String(value))}>{String(value)}</Tag> }]} />
        <Table size="small" pagination={false} rowKey="key" dataSource={rowRangeRows(detail)} columns={[{ title: '行范围', dataIndex: 'name', render: value => <Tag color="gold" className="cursor-pointer" onClick={() => setFilter(String(value))}>行 {String(value)}</Tag> }]} />
        <Table size="small" rowKey="key" dataSource={tableGridRows(detail)} pagination={{ pageSize: 10 }} columns={[{ title: '表格网格预览', dataIndex: 'cells', render: cells => <Space wrap>{(cells as string[]).map((cell, index) => <Tag key={`${cell}-${index}`}>{cell}</Tag>)}</Space> }]} />
      </Space>,
    },
    {
      key: 'drawing',
      label: '图纸',
      children: <Space direction="vertical" className="w-full">
        <Descriptions size="small" column={2} bordered>
          {metaItem('图层', asList(meta.layerNames), setFilter)}
          {metaItem('块/符号', asList(meta.blockNames), setFilter)}
          {metaItem('实体类型', asList(meta.entityTypes), setFilter)}
          {metaItem('产品/零件', asList(meta.productNames), setFilter)}
          {metaItem('材料', asList(meta.materialNames), setFilter)}
          {metaItem('实体名称', asList(meta.entityNames), setFilter)}
        </Descriptions>
        {layerNames.length > 0 ? <Card size="small" title="图层开关 / 图纸预览">
          <Checkbox.Group value={visibleLayers} options={layerNames.map(layer => ({ label: layer, value: layer }))} onChange={values => setVisibleLayers(values.map(String))} />
          <div className={styles.drawingPreview}>{visibleLayers.map(layer => <Tag key={layer} color="blue">{layer}</Tag>)}</div>
        </Card> : null}
        <Table size="small" pagination={false} rowKey="key" dataSource={[
          ...kvRows(layerNames, 'layer').map(row => ({ ...row, type: '图层' })),
          ...kvRows(asList(meta.entityTypes), 'entity').map(row => ({ ...row, type: '实体类型' })),
          ...kvRows(asList(meta.blockNames), 'block').map(row => ({ ...row, type: '块/符号' })),
        ]} columns={[{ title: '类型', dataIndex: 'type', width: 120 }, { title: '名称', dataIndex: 'name', render: value => <Tag className="cursor-pointer" onClick={() => setFilter(String(value))}>{String(value)}</Tag> }]} />
      </Space>,
    },
    {
      key: 'data',
      label: '数据路径',
      children: <Space direction="vertical" className="w-full">
        {asList(meta.dataPaths).length > 0 ? <Tree defaultExpandAll treeData={pathTree(asList(meta.dataPaths))} onSelect={keys => setFilter(String(keys[0] ?? ''))} /> : <Empty description="暂无数据路径" />}
        <Table size="small" rowKey="key" dataSource={dataPreviewRows(detail)} pagination={{ pageSize: 20 }} columns={[{ title: 'Path', dataIndex: 'path', width: 260, render: value => <Tag className="cursor-pointer" onClick={() => setFilter(String(value))}>{String(value)}</Tag> }, { title: 'Value', dataIndex: 'value', render: value => <span className="break-all">{String(value)}</span> }]} />
      </Space>,
    },
    {
      key: 'ocr',
      label: 'OCR/PDF',
      children: <Space direction="vertical" className="w-full">
        <Descriptions size="small" column={2} bordered>
          {metaItem('OCR 建议', meta.ocrRecommended)}
          {metaItem('OCR 原因', meta.ocrReason)}
          {metaItem('OCR 引擎', meta.ocrProvider)}
          {metaItem('OCR 语言', meta.ocrLanguages)}
          {metaItem('OCR 文本长度', meta.ocrTextLength)}
          {metaItem('PDF 页面 OCR 支持', meta.pdfPageOcrSupported)}
          {metaItem('PDF OCR 页数', meta.ocrPageCount)}
          {metaItem('PDF OCR 页数上限', meta.pdfOcrPageLimit)}
          {metaItem('PDF 渲染器', meta.pdfRenderer)}
        </Descriptions>
        {detail?.file.format === 'pdf' ? <div className={styles.pdfPreviewStrip}>
          {Array.from({ length: Math.min(Number(meta.ocrPageCount ?? 1) || 1, 6) }, (_, index) => <Image key={index} width={220} height={320} src={`/api/kb/files/preview-pdf-page?relativePath=${encodeURIComponent(detail.file.relativePath)}&page=${index + 1}`} alt={`PDF 第 ${index + 1} 页`} unoptimized />)}
        </div> : null}
        <Table size="small" rowKey="key" dataSource={ocrPageRows(detail)} pagination={{ pageSize: 10 }} columns={[{ title: '页码', dataIndex: 'page', width: 90 }, { title: 'OCR 文本', dataIndex: 'text', render: value => <Paragraph ellipsis={{ rows: 4, expandable: true, symbol: '展开' }}>{String(value)}</Paragraph> }]} />
      </Space>,
    },
  ];

  const chunkColumns: ColumnsType<KbStoredChunk> = [
    { title: '#', dataIndex: 'chunkIndex', width: 70, render: (value: unknown) => String(value) },
    { title: '类型', width: 110, render: (_, row) => <Tag>{String(parseJson(row.metadataJson).chunkKind ?? row.category)}</Tag> },
    { title: '章节/范围', width: 220, render: (_, row) => {
      const m = parseJson(row.metadataJson);
      const rowRange = typeof m.rowRange === 'string' ? m.rowRange : undefined;
      return <Space wrap>{row.sectionTitle ? <Tag color="cyan">{row.sectionTitle}</Tag> : null}{rowRange ? <Tag color="gold">行 {rowRange}</Tag> : null}</Space>;
    } },
    { title: 'Token', dataIndex: 'tokenCount', width: 90 },
    { title: '内容', render: (_, row) => <Paragraph ellipsis={{ rows: 3, expandable: true, symbol: '展开' }} className={styles.searchContent}>{highlight(row.content, filter)}</Paragraph> },
  ];

  const parentColumns: ColumnsType<KbParentChunk> = [
    { title: 'Parent', dataIndex: 'parentId', width: 260, render: (value: string) => <span className="break-all">{value}</span> },
    { title: '切片数', dataIndex: 'chunkCount', width: 90 },
    { title: '章节', dataIndex: 'sectionTitle', width: 220 },
    { title: '内容', render: (_, row) => <Paragraph ellipsis={{ rows: 3, expandable: true, symbol: '展开' }} className={styles.searchContent}>{highlight(row.content, filter)}</Paragraph> },
  ];

  if (loading) return <Spin />;
  if (!detail) return <Empty description="请选择文件" />;

  return (
    <div className="space-y-5 animateFadeIn">
      <div>
        <Link href="/knowledge/files">返回文件列表</Link>
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

      <Card size="small" title="结构化信息">
        <Tabs items={structuredItems} />
      </Card>

      <Card size="small" title="详情筛选">
        <Space direction="vertical" className="w-full">
          <Input allowClear value={filter} onChange={event => setFilter(event.target.value)} placeholder="筛选 rowRange、图层、实体、data path、section、chunk 内容" />
          {filter ? <Space wrap>
            <Tag color="blue">Parent 命中 {filteredParents.length}</Tag>
            <Tag color="green">Child 命中 {filteredChunks.length}</Tag>
            <Tag color="purple">筛选词 {filter}</Tag>
          </Space> : null}
        </Space>
      </Card>

      <Card size="small" title={`Parent Chunks (${filteredParents.length}/${detail.parents.length})`}>
        <Table rowKey="id" columns={parentColumns} dataSource={filteredParents} pagination={{ pageSize: 10 }} size="small" />
      </Card>

      <Card size="small" title={`Child Chunks (${filteredChunks.length}/${detail.chunks.length})`}>
        <Table rowKey="id" columns={chunkColumns} dataSource={filteredChunks} pagination={{ pageSize: 20 }} size="small" />
      </Card>
    </div>
  );
}
