'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Drawer, Empty, List, Progress, Tag, Typography } from 'antd';
import { ClockCircleOutlined, CheckCircleOutlined, CloseCircleOutlined, SyncOutlined } from '@ant-design/icons';
import { getJobs, type KbOperationRecord } from '@/lib/api';

function statusColor(status: KbOperationRecord['status']) {
  if (status === 'processing') return 'processing';
  if (status === 'success') return 'success';
  if (status === 'warning') return 'warning';
  return 'error';
}

function statusIcon(status: KbOperationRecord['status']) {
  if (status === 'processing') return <SyncOutlined spin />;
  if (status === 'success') return <CheckCircleOutlined />;
  if (status === 'warning') return <ClockCircleOutlined />;
  return <CloseCircleOutlined />;
}

export function JobStatus() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<KbOperationRecord[]>([]);

  const failureCountRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const loadJobs = async () => {
    const result = await getJobs({ limit: 50 });
    failureCountRef.current = 0;
    setJobs(result.jobs || []);
  };

  useEffect(() => {
    let disposed = false;
    const schedule = (delay: number) => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => { void poll(); }, delay);
    };
    const poll = async () => {
      try {
        await loadJobs();
        if (!disposed) schedule(2000);
      } catch {
        failureCountRef.current += 1;
        const delay = Math.min(30000, 2000 * 2 ** Math.min(4, failureCountRef.current));
        if (!disposed) schedule(delay);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const activeCount = useMemo(() => jobs.filter(job => job.status === 'processing').length, [jobs]);
  const latest = jobs[0];

  return (
    <>
      <Badge count={activeCount} size="small">
        <Button className="topbarBtn" onClick={() => setOpen(true)} icon={activeCount ? <SyncOutlined spin /> : <ClockCircleOutlined />}>
          后台任务
        </Button>
      </Badge>
      {latest && !open && activeCount > 0 && (
        <span style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--colorTextSecondary)' }}>
          {latest.title} · {latest.percent}%
        </span>
      )}
      <Drawer title="后台任务" placement="right" size={460} open={open} onClose={() => setOpen(false)} extra={<Button size="small" onClick={() => void loadJobs()}>刷新</Button>} styles={{ body: { padding: 0 } }}>
        {jobs.length === 0 ? <div className="h-full flex items-start justify-center pt-16"><Empty description="暂无后台任务" /></div> : (
          <List
            className="text-left"
            dataSource={jobs}
            renderItem={job => (
              <List.Item className="!items-start !px-5 !py-4">
                <List.Item.Meta
                  className="!items-start [&_.ant-list-item-meta-content]:min-w-0 [&_.ant-list-item-meta-title]:mb-2 [&_.ant-list-item-meta-description]:text-left"
                  avatar={<span className="mt-1 inline-flex text-base">{statusIcon(job.status)}</span>}
                  title={
                    <div className="flex items-start justify-between gap-3 text-left">
                      <Typography.Text strong className="min-w-0 flex-1 leading-6" ellipsis={{ tooltip: job.title }}>{job.title}</Typography.Text>
                      <Tag color={statusColor(job.status)} className="m-0 shrink-0">{job.status}</Tag>
                    </div>
                  }
                  description={
                    <div className="flex w-full flex-col items-stretch gap-2 text-left">
                      <Typography.Text type={job.status === 'error' ? 'danger' : undefined} className="block whitespace-pre-wrap break-words leading-6">{job.error || job.message}</Typography.Text>
                      <Progress percent={Math.max(0, Math.min(100, Math.round(job.percent || 0)))} status={job.status === 'error' ? 'exception' : job.status === 'success' ? 'success' : 'active'} />
                      {job.chunkCount ? <Typography.Text type="secondary" className="block text-xs">切片数：{job.chunkCount}</Typography.Text> : null}
                      {job.filePath && <Typography.Text type="secondary" className="block text-xs break-all">文件：{job.filePath}</Typography.Text>}
                      <Typography.Text type="secondary" className="block text-xs">更新时间：{new Date(job.updatedAt).toLocaleString()}</Typography.Text>
                    </div>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>
    </>
  );
}
