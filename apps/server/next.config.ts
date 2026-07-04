import path from 'node:path';
import type { NextConfig } from 'next';

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
  output: 'standalone',
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
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
