import type { NextConfig } from 'next';

/** 需要在服务端而非客户端打包的外部依赖（原生模块/大型库） */
const serverExternalPackages = [
  '@customize-agent/knowledge',
  '@customize-agent/llm',
  '@customize-agent/runtime',
  '@customize-agent/types',
  '@napi-rs/canvas',
  'better-sqlite3',
  'jszip',
  'mammoth',
  'pdf-parse',
  'pdfjs-dist',
  'tesseract.js',
  'xlsx',
];

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverExternalPackages,
  webpack(config, { isServer }) {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        ...serverExternalPackages,
      ];
    }
    return config;
  },
  async headers() {
    return [
      {
        // 对所有非静态资源路由设置禁止缓存，确保内容实时更新
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // 将多个入口路径统一重定向到 /overview
      { source: '/', destination: '/overview', permanent: false },
      { source: '/dashboard', destination: '/overview', permanent: false },
      { source: '/console', destination: '/overview', permanent: false },
      { source: '/admin', destination: '/overview', permanent: false },
    ];
  },
};

export default nextConfig;
