/** 将字节数转换为可读的存储单位字符串（B/KB/MB/GB/TB） */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 将时间戳转换为相对时间描述（如「3 分钟前」「2d ago」），支持中英文 */
export function formatRelativeTime(timestamp: number, locale = 'zh-CN'): string {
  if (!timestamp || timestamp <= 0) return locale === 'en-US' ? 'Never' : '从未';
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 30) return new Date(timestamp).toLocaleDateString(locale);
  if (locale === 'en-US') {
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  }
  if (days > 0) return `${days} 天前`;
  if (hours > 0) return `${hours} 小时前`;
  if (minutes > 0) return `${minutes} 分钟前`;
  return '刚刚';
}

const CATEGORY_LABELS_ZH: Record<string, string> = {
  document: '文档', spreadsheet: '表格', image: '图片', cad: '图纸',
  code: '代码', data: '数据', web: '网页', diagram: '图表',
  archive: '压缩包', other: '其他',
};

const CATEGORY_LABELS_EN: Record<string, string> = {
  document: 'Document', spreadsheet: 'Spreadsheet', image: 'Image', cad: 'CAD',
  code: 'Code', data: 'Data', web: 'Web', diagram: 'Diagram',
  archive: 'Archive', other: 'Other',
};

/** 根据区域设置获取文件分类的中文或英文标签 */
export function categoryLabel(category: string, locale = 'zh-CN'): string {
  const map = locale === 'en-US' ? CATEGORY_LABELS_EN : CATEGORY_LABELS_ZH;
  return map[category] ?? category;
}
