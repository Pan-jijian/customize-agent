'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Drawer, Empty, List, Progress, Space, Tag, Typography } from 'antd';
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

  const loadJobs = async () => {
    const result = await getJobs({ limit: 50 });
    setJobs(result.jobs || []);
  };

  useEffect(() => {
    void loadJobs().catch(() => {});
    const timer = window.setInterval(() => { void loadJobs().catch(() => {}); }, 2000);
    return () => window.clearInterval(timer);
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
      <Drawer title="后台任务" placement="right" width={420} open={open} onClose={() => setOpen(false)} extra={<Button size="small" onClick={() => void loadJobs()}>刷新</Button>}>
        {jobs.length === 0 ? <Empty description="暂无后台任务" /> : (
          <List
            dataSource={jobs}
            renderItem={job => (
              <List.Item>
                <List.Item.Meta
                  avatar={statusIcon(job.status)}
                  title={
                    <Space>
                      <Typography.Text strong>{job.title}</Typography.Text>
                      <Tag color={statusColor(job.status)}>{job.status}</Tag>
                    </Space>
                  }
                  description={
                    <Space direction="vertical" style={{ width: '100%' }} size={6}>
                      <Typography.Text type={job.status === 'error' ? 'danger' : undefined}>{job.error || job.message}</Typography.Text>
                      <Progress percent={Math.max(0, Math.min(100, Math.round(job.percent || 0)))} status={job.status === 'error' ? 'exception' : job.status === 'success' ? 'success' : 'active'} />
                      {job.chunkCount ? <Typography.Text type="secondary">切片数：{job.chunkCount}</Typography.Text> : null}
                      {job.filePath && <Typography.Text type="secondary">文件：{job.filePath}</Typography.Text>}
                      <Typography.Text type="secondary">更新时间：{new Date(job.updatedAt).toLocaleString()}</Typography.Text>
                    </Space>
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
