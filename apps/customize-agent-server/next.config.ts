import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  serverExternalPackages: [
    '@customize-agent/knowledge',
    '@customize-agent/llm',
    '@customize-agent/runtime',
    '@customize-agent/types',
    'better-sqlite3',
  ],
  async redirects() {
    return [{ source: '/', destination: '/overview', permanent: true }];
  },
};

export default withNextIntl(nextConfig);
