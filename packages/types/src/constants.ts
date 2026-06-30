// @customize-agent/types — 共享常量

/** 已知二进制文件扩展名（read_file 不可读取） */
export const BINARY_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'ico',
  'woff', 'woff2', 'ttf', 'eot',
  'db', 'db-shm', 'db-wal', 'lock', 'log', 'map',
  'docx', 'xlsx', 'pptx',
  'zip', 'tar', 'gz', 'bz2', '7z',
  'mp3', 'mp4', 'avi', 'mov', 'webm', 'webp',
  'wasm',
]);
