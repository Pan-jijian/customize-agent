import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  eslint: {
    ignoreDuringBuilds: true,
  },
  serverExternalPackages: [
    '@customize-agent/knowledge',
    '@customize-agent/llm',
    '@customize-agent/runtime',
    '@customize-agent/types',
    'better-sqlite3',
  ],
  async headers() {
    return [
      {
        source: '/:path((?!_next/static).*)',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
      {
        source: '/_next/static/:buildId(_[^/]+)/(.*Manifest.js)',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ];
  },
  async redirects() {
    return [
      { source: '/', destination: '/overview', permanent: false },
      { source: '/dashboard', destination: '/overview', permanent: false },
      { source: '/console', destination: '/overview', permanent: false },
      { source: '/admin', destination: '/overview', permanent: false },
    ];
  },
};

export default nextConfig;
