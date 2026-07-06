import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Empty, Input, Popconfirm, Skeleton, Space, Table, Tag, Typography, message } from 'antd';
import { ReloadOutlined, DeleteOutlined, DownOutlined, UpOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useAppTranslations } from '@/components/Layout';
import { clearErrorLogs, getErrorLogs, type ErrorLogEntry } from '@/lib/api';

const { Text, Paragraph } = Typography;

function levelColor(level: ErrorLogEntry['level']) {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warning';
  return 'blue';
}

export default function SystemLogsPage() {
  const t = useAppTranslations();
  const [logs, setLogs] = useState<ErrorLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [guideExpanded, setGuideExpanded] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setLogs((await getErrorLogs(500)).logs); }
    catch (error) { message.error(error instanceof Error ? error.message : '加载日志失败'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!text) return logs;
    return logs.filter(item =>
      [item.id, item.level, item.source, item.functionName, item.message, item.stack]
        .filter(Boolean).some(value => String(value).toLowerCase().includes(text))
    );
  }, [keyword, logs]);

  const columns: ColumnsType<ErrorLogEntry> = [
    { title: '序号', key: 'index', width: 70, render: (_: unknown, __: ErrorLogEntry, index: number) => index + 1 },
    { title: '时间', dataIndex: 'createdAt', width: 170, render: value => new Date(value).toLocaleString() },
    { title: '级别', dataIndex: 'level', width: 80, render: level => <Tag color={levelColor(level)} style={{ margin: 0 }}>{level}</Tag> },
    { title: '来源', dataIndex: 'source', width: 200, render: value => <Text code style={{ fontSize: 12 }}>{value}</Text> },
    { title: '函数', dataIndex: 'functionName', width: 160, render: value => value ? <Text code style={{ fontSize: 12 }}>{value}</Text> : <Text type="secondary">-</Text> },
    {
      title: '错误信息', dataIndex: 'message',
      render: value => <Paragraph style={{ maxWidth: 480, overflowWrap: 'anywhere', wordBreak: 'break-all', marginBottom: 0, fontSize: 12 }} ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}>{value}</Paragraph>,
    },
    { title: 'Request ID', dataIndex: 'id', width: 200, render: value => <Text copyable code style={{ fontSize: 12 }}>{value.slice(0, 8)}</Text> },
  ];

  if (loading && logs.length === 0) return (
    <div className="space-y-5 animateFadeIn">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <Skeleton active paragraph={{ rows: 12 }} />
    </div>
  );

  return (
    <div className="space-y-5 animateFadeIn">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div><h1 className="pageTitle">{t('nav.systemLogs')}</h1><p className="pageDesc">查看 API 异常、模型健康检查失败、PDF 降级等运行时问题。</p></div>
        <Space>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新</Button>
          <Popconfirm title="确认清空所有错误日志？" onConfirm={() => { void (async () => { await clearErrorLogs(); message.success('已清空'); await load(); })(); }}>
            <Button danger icon={<DeleteOutlined />}>清空日志</Button>
          </Popconfirm>
        </Space>
      </div>

      <Alert type="info" showIcon
        message={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>日志保存在本机 ~/.customize-agent/logs/errors.jsonl，最多读取最近 500 条。</span>
            <Button type="link" size="small" icon={guideExpanded ? <UpOutlined /> : <DownOutlined />}
              onClick={() => setGuideExpanded(!guideExpanded)} style={{ padding: '0 4px' }}>
              {guideExpanded ? '收起' : '展开'}
            </Button>
          </div>
        }
        description={guideExpanded ? '系统自动记录未捕获的异常、API 错误、模型健康检查失败等运行时问题。日志文件超过 2MB 会自动轮转。' : undefined}
      />

      <Input.Search allowClear placeholder="搜索 requestId / source / function / message / stack" value={keyword} onChange={event => setKeyword(event.target.value)} style={{ maxWidth: 480 }} />

      <Table
        rowKey="id"
        loading={loading}
        dataSource={filtered}
        columns={columns}
        size="middle"
        locale={{ emptyText: <Empty description="暂无错误日志" /> }}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: total => `共 ${total} 条` }}
        expandable={{
          expandedRowRender: record => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
              {record.request && (
                <div>
                  <Text strong style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>Request</Text>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, padding: 10, background: 'var(--colorFillAlter)', borderRadius: 8, fontSize: 12, lineHeight: 1.5 }}>{JSON.stringify(record.request, null, 2)}</pre>
                </div>
              )}
              {record.meta !== undefined && (
                <div>
                  <Text strong style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>Meta</Text>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, padding: 10, background: 'var(--colorFillAlter)', borderRadius: 8, fontSize: 12, lineHeight: 1.5 }}>{JSON.stringify(record.meta, null, 2)}</pre>
                </div>
              )}
              {record.stack && (
                <div>
                  <Text strong style={{ fontSize: 12, marginBottom: 4, display: 'block' }}>Stack</Text>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, padding: 10, background: 'var(--colorFillAlter)', borderRadius: 8, fontSize: 12, lineHeight: 1.5, maxHeight: 300, overflow: 'auto' }}>{record.stack}</pre>
                </div>
              )}
            </div>
          ),
        }}
      />
    </div>
  );
}
