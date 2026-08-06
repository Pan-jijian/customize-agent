import React from 'react';
import { Space, Typography } from 'antd';

const { Title, Text } = Typography;

interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  extra?: React.ReactNode;
  bottomContent?: React.ReactNode;
}

/**
 * 统一的页面头部组件
 * 规范页面的标题、描述和主要操作区（Action Bar）
 */
export function PageHeader({ title, description, extra, bottomContent }: PageHeaderProps) {
  return (
    <div className="mb-6 animateFadeIn">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <Title level={4} style={{ margin: 0, fontWeight: 700, letterSpacing: '-0.01em' }}>
            {title}
          </Title>
          {description && (
            <Text type="secondary" className="mt-1 block text-sm">
              {description}
            </Text>
          )}
        </div>
        {extra && (
          <Space className="w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0" size="middle" wrap={false}>
            {extra}
          </Space>
        )}
      </div>
      {bottomContent && <div className="mt-4">{bottomContent}</div>}
    </div>
  );
}
