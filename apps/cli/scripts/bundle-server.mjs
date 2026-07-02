import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(__dirname, '..');
const serverDir = resolve(cliDir, '..', 'server');
const standaloneDir = resolve(serverDir, '.next', 'standalone');
const destDir = resolve(cliDir, 'dist', 'server');

if (!existsSync(standaloneDir)) {
  console.log('[bundle-server] Standalone output not found, skipping (server not built)');
  process.exit(0);
}

// Clean and copy
if (existsSync(destDir)) rmSync(destDir, { recursive: true });
mkdirSync(destDir, { recursive: true });
cpSync(standaloneDir, destDir, { recursive: true });

// Create marker file for findDashboardServerDir detection
writeFileSync(resolve(destDir, '.dashboard-bundled'), '');

console.log('[bundle-server] Server bundled into dist/server/');
