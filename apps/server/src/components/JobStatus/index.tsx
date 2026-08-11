'use client';

import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined, SyncOutlined } from '@ant-design/icons';
import { Badge, Button, Drawer, Empty, Progress, Tag, Typography } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
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

function jobTypeLabel(type: KbOperationRecord['type']) {
  if (type === 'document') return '文档生成';
  if (type === 'upload') return '文件上传';
  if (type === 'reindex') return '重新解析';
  if (type === 'delete') return '删除';
  return type;
}

function JobMetaRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex gap-3 text-xs text-slate-500">
      <span className="w-16 shrink-0">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  );
}

function JobCard({ job, mounted }: { job: KbOperationRecord; mounted: boolean }) {
  const percent = Math.max(0, Math.min(100, Math.round(job.percent || 0)));
  const progressStatus = job.status === 'error' ? 'exception' : job.status === 'success' ? 'success' : 'active';
  const details = job.details?.slice(0, 40) || [];
  const updatedAt = mounted ? new Date(job.updatedAt).toLocaleString() : String(job.updatedAt);

  return (
    <div className="border-b border-slate-100 px-5 py-4">
      <div className="flex items-start gap-3 text-left">
        <span className="mt-1 inline-flex text-base">{statusIcon(job.status)}</span>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-start justify-between gap-3">
            <Typography.Text strong className="min-w-0 flex-1 leading-6" ellipsis={{ tooltip: job.title }}>
              {job.title}
            </Typography.Text>
            <Tag color={statusColor(job.status)} className="m-0 shrink-0">
              {job.status}
            </Tag>
          </div>
          <div className="flex flex-col gap-2">
            <Typography.Text type={job.status === 'error' ? 'danger' : undefined} className="block whitespace-pre-wrap break-words leading-6">
              {job.error || job.message}
            </Typography.Text>
            <Progress percent={percent} status={progressStatus} />
            <div className="flex flex-col gap-1">
              <JobMetaRow label="类型" value={jobTypeLabel(job.type)} />
              <JobMetaRow label="阶段" value={job.stage} />
              {job.chunkCount ? <JobMetaRow label="切片数" value={job.chunkCount} /> : null}
              {job.filePath ? <JobMetaRow label="文件" value={job.filePath} /> : null}
              <JobMetaRow label="更新时间" value={updatedAt} />
            </div>
            {details.length > 0 ? (
              <div className="rounded border border-slate-100 bg-slate-50 p-2">
                <Typography.Text type="secondary" className="block text-xs">
                  诊断详情
                </Typography.Text>
                <ul className="m-0 mt-1 max-h-52 overflow-auto pl-4 text-xs leading-5 text-slate-500">
                  {details.map((detail, index) => (
                    <li key={`${job.id}-${index}`} className="break-words">
                      {detail}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function JobStatus() {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<KbOperationRecord[]>([]);
  const [mounted, setMounted] = useState(false);
  const failureCountRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const jobsRef = useRef<KbOperationRecord[]>([]);

  const loadJobs = async () => {
    const result = await getJobs({ limit: 50 });
    failureCountRef.current = 0;
    jobsRef.current = result.jobs || [];
    setJobs(result.jobs || []);
  };

  useEffect(() => {
    setMounted(true);
    let disposed = false;

    const schedule = (delay: number) => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        void poll();
      }, delay);
    };

    const poll = async () => {
      try {
        await loadJobs();
        const hasActive = jobsRef.current.some(job => job.status === 'processing');
        if (!disposed) schedule(hasActive ? 2000 : 30000);
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

  const activeJobs = useMemo(() => jobs.filter(job => job.status === 'processing'), [jobs]);
  const activeCount = activeJobs.length;
  const latest = activeJobs[0];

  return (
    <>
      <Badge count={activeCount} size="small">
        <Button className="topbarBtn" onClick={() => setOpen(true)} icon={activeCount ? <SyncOutlined spin /> : <ClockCircleOutlined />}>
          后台任务
        </Button>
      </Badge>
      {latest && !open && activeCount > 0 ? (
        <span style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--colorTextSecondary)' }}>
          {latest.title} · {latest.percent}%
        </span>
      ) : null}
      <Drawer
        title="后台任务"
        placement="right"
        size="large"
        open={open}
        onClose={() => setOpen(false)}
        extra={<Button size="small" onClick={() => void loadJobs()}>刷新</Button>}
        styles={{ body: { padding: 0 } }}
      >
        {jobs.length === 0 ? (
          <div className="flex h-full items-start justify-center pt-16">
            <Empty description="暂无后台任务" />
          </div>
        ) : (
          <div className="text-left">
            {jobs.map(job => <JobCard key={job.id} job={job} mounted={mounted} />)}
          </div>
        )}
      </Drawer>
    </>
  );
}
