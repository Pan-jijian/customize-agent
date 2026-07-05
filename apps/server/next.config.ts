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
  generateBuildId() {
    return 'customize-agent-dashboard';
  },
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
        source: '/((?!_next/static|_next/image|favicon.ico).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/_next/static/:buildId/_buildManifest.js', destination: '/_next/static/customize-agent-dashboard/_buildManifest.js' },
        { source: '/_next/static/:buildId/_ssgManifest.js', destination: '/_next/static/customize-agent-dashboard/_ssgManifest.js' },
      ],
    };
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
