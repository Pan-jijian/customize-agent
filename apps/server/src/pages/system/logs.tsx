import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Popconfirm, Space, Table, Tag, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { clearErrorLogs, getErrorLogs, type ErrorLogEntry } from '@/lib/api';

const { Text, Paragraph } = Typography;

function levelColor(level: ErrorLogEntry['level']) {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warning';
  return 'blue';
}

export default function SystemLogsPage() {
  const [logs, setLogs] = useState<ErrorLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const data = await getErrorLogs(500);
      setLogs(data.logs);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载日志失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const filtered = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!text) return logs;
    return logs.filter(item => [item.id, item.level, item.source, item.functionName, item.message, item.stack].filter(Boolean).some(value => String(value).toLowerCase().includes(text)));
  }, [keyword, logs]);

  const columns: ColumnsType<ErrorLogEntry> = [
    { title: '序号', key: 'index', width: 70, render: (_: unknown, __: ErrorLogEntry, index: number) => index + 1 },
    { title: '时间', dataIndex: 'createdAt', width: 180, render: value => new Date(value).toLocaleString() },
    { title: '级别', dataIndex: 'level', width: 90, render: level => <Tag color={levelColor(level)}>{level}</Tag> },
    { title: '来源', dataIndex: 'source', width: 220, render: value => <Text code>{value}</Text> },
    { title: '函数', dataIndex: 'functionName', width: 180, render: value => value ? <Text code>{value}</Text> : <Text type="secondary">-</Text> },
    { title: '错误信息', dataIndex: 'message', render: value => <Paragraph className="mb-0" style={{ maxWidth: 520, overflowWrap: 'anywhere', wordBreak: 'break-all' }} ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}>{value}</Paragraph> },
    { title: 'Request ID', dataIndex: 'id', width: 210, render: value => <Text copyable code>{value}</Text> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="pageTitle">系统日志</h1>
          <p className="pageDesc">查看 API 异常、模型健康检查失败、PDF 降级等运行时问题。</p>
        </div>
        <Space wrap>
          <Button onClick={() => void load()} loading={loading}>刷新</Button>
          <Popconfirm title="确认清空所有错误日志？" onConfirm={() => { void (async () => { await clearErrorLogs(); message.success('已清空'); await load(); })(); }}>
            <Button danger>清空日志</Button>
          </Popconfirm>
        </Space>
      </div>

      <Alert type="info" showIcon message="日志保存在本机 ~/.customize-agent/logs/errors.jsonl，最多读取最近 500 条。" />

      <Card size="small">
        <Space direction="vertical" className="w-full" size="middle">
          <Input.Search allowClear placeholder="搜索 requestId / source / function / message / stack" value={keyword} onChange={event => setKeyword(event.target.value)} />
          <Table
            rowKey="id"
            loading={loading}
            dataSource={filtered}
            columns={columns}
            locale={{ emptyText: <Empty description="暂无错误日志" /> }}
            pagination={{ pageSize: 20, showSizeChanger: true }}
            expandable={{
              expandedRowRender: record => (
                <Space direction="vertical" className="w-full" size="small">
                  {record.request && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{JSON.stringify(record.request, null, 2)}</pre>}
                  {record.meta !== undefined && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{JSON.stringify(record.meta, null, 2)}</pre>}
                  {record.stack && <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }}>{record.stack}</pre>}
                </Space>
              ),
            }}
          />
        </Space>
      </Card>
    </div>
  );
}
