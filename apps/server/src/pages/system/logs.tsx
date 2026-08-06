import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Popconfirm, Skeleton, Space, Table, Tag, Typography, message } from 'antd';
import { ReloadOutlined, DeleteOutlined, SearchOutlined, ExceptionOutlined, InfoCircleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useAppTranslations } from '@/components/Layout';
import { PageHeader } from '@/components/PageHeader';
import { clearErrorLogs, getErrorLogs, type ErrorLogEntry } from '@/lib/api';

const { Text, Paragraph } = Typography;

/** 根据日志级别返回对应的标签颜色 */
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

  /** 加载最近的错误日志 */
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
    { title: t('logs.time'), dataIndex: 'createdAt', width: 160, render: value => <span className="text-xs text-[var(--colorTextSecondary)] font-mono">{new Date(value).toLocaleString()}</span> },
    { title: t('logs.level'), dataIndex: 'level', width: 80, render: level => <Tag color={levelColor(level)} bordered={false} className="m-0 text-[10px] uppercase tracking-wider">{level}</Tag> },
    { title: t('logs.source'), dataIndex: 'source', width: 220, render: value => <span className="text-xs font-mono text-[var(--colorTextSecondary)] break-all">{value}</span> },
    { title: t('logs.message'), dataIndex: 'message',
      render: value => <div className="text-sm text-[var(--colorText)] max-w-3xl whitespace-normal break-words leading-relaxed" title={value}>{value}</div>,
    },
    { title: t('logs.requestId'), dataIndex: 'id', width: 120, render: value => <Text copyable className="text-[10px] font-mono text-[var(--colorTextTertiary)]">{value.slice(0, 8)}</Text> },
  ];

  if (loading && logs.length === 0) return (
    <div className="space-y-8 animateFadeIn">
      <Skeleton active title paragraph={{ rows: 1 }} />
      <Skeleton active paragraph={{ rows: 12 }} />
    </div>
  );

  return (
    <div className="h-[calc(100vh-140px)] flex flex-col">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[var(--borderColor)] shrink-0 animateFadeIn">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--colorText)] mb-1">{t('nav.systemLogs')}</h1>
          <p className="text-xs text-[var(--colorTextSecondary)]">{t('logs.monitorSystem')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Input placeholder={t('logs.searchLogs')} prefix={<SearchOutlined className="text-[var(--colorTextTertiary)]" />} value={keyword} onChange={e => setKeyword(e.target.value)} allowClear className="w-[260px] bg-[var(--colorBgHover)] border-transparent" />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} className="shadow-none">{t('logs.refresh')}</Button>
          <Popconfirm title={t('logs.clearConfirm')} onConfirm={() => { void (async () => { await clearErrorLogs(); message.success(t('common.success')); await load(); })(); }}>
            <Button danger icon={<DeleteOutlined />} className="shadow-none border-transparent">{t('logs.clear')}</Button>
          </Popconfirm>
        </div>
      </div>

      <div className="flex items-center gap-2 py-3 px-1 text-xs text-[var(--colorTextTertiary)] shrink-0 animateFadeIn stagger-1">
        <InfoCircleOutlined /> {t('logs.logStorageInfo')} <code className="bg-[var(--colorBgHover)] px-1 rounded">~/.customize-agent/logs/errors.jsonl</code>. {t('logs.maxLoaded')}
      </div>

      <div className="flex-1 overflow-hidden bg-[var(--colorBg)] rounded-lg animateFadeIn stagger-2">
        <Table
          rowKey="id"
          loading={loading}
          dataSource={filtered}
          columns={columns}
          size="middle"
          className="h-full modern-table"
          scroll={{ y: 'calc(100vh - 280px)' }}
          locale={{ emptyText: <Empty description={t('logs.noLogsFound')} className="py-20" /> }}
          pagination={false}
          rowClassName="hover:bg-[var(--colorBgHover)] transition-colors cursor-pointer"
          expandable={{
            expandedRowRender: record => (
              <div className="flex flex-col gap-4 p-4 bg-[var(--colorBgHover)]/50 border-t border-[var(--borderColor)]">
                {record.functionName && (
                  <div className="text-xs text-[var(--colorTextSecondary)]">
                    <span className="font-semibold uppercase tracking-wider text-[var(--colorTextTertiary)] mr-2">{t('logs.function')}</span>
                    <code className="font-mono bg-[var(--colorBgElevated)] px-2 py-1 rounded">{record.functionName}</code>
                  </div>
                )}
                {record.request && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--colorTextTertiary)] mb-2">{t('logs.requestContext')}</div>
                    <pre className="text-xs font-mono bg-[var(--colorBgElevated)] p-3 rounded-md border border-[var(--borderColor)] whitespace-pre-wrap break-all m-0 text-[var(--colorTextSecondary)]">{JSON.stringify(record.request, null, 2)}</pre>
                  </div>
                )}
                {record.meta !== undefined && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--colorTextTertiary)] mb-2">{t('logs.metadata')}</div>
                    <pre className="text-xs font-mono bg-[var(--colorBgElevated)] p-3 rounded-md border border-[var(--borderColor)] whitespace-pre-wrap break-all m-0 text-[var(--colorTextSecondary)]">{JSON.stringify(record.meta, null, 2)}</pre>
                  </div>
                )}
                {record.stack && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--colorTextTertiary)] mb-2">{t('logs.stackTrace')}</div>
                    <pre className="text-[11px] font-mono bg-[#1e1e1e] text-[#d4d4d4] p-3 rounded-md overflow-x-auto m-0 leading-relaxed">{record.stack}</pre>
                  </div>
                )}
              </div>
            ),
          }}
        />
      </div>
    </div>
  );
}
