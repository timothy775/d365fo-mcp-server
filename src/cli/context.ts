/**
 * CLI context — repo-root resolution shared by all commands.
 *
 * The CLI runs either from src/cli (tsx during development) or dist/cli
 * (built). Both are exactly two levels below the repo root, so resolve
 * relative to this file rather than process.cwd() — developers invoke the
 * CLI from arbitrary directories.
 */
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __cliDir = dirname(fileURLToPath(import.meta.url));

export const repoRoot = resolve(__cliDir, '../..');

export const paths = {
  /** Legacy configuration file — still read as a fallback, no longer written. */
  rootEnv: resolve(repoRoot, '.env'),
  rootConfig: resolve(repoRoot, 'config', 'd365fo-mcp.json'),
  rootSecrets: resolve(repoRoot, 'config', 'secrets.json'),
  instancesDir: resolve(repoRoot, 'instances'),
  distEntry: resolve(repoRoot, 'dist', 'index.js'),
  defaultDb: resolve(repoRoot, 'data', 'xpp-metadata.db'),
  defaultLabelsDb: resolve(repoRoot, 'data', 'xpp-metadata-labels.db'),
  bridgeDir: resolve(repoRoot, 'bridge', 'D365MetadataBridge'),
  bridgeExe: resolve(repoRoot, 'bridge', 'D365MetadataBridge', 'bin', 'Release', 'D365MetadataBridge.exe'),
  extractScript: resolve(repoRoot, 'scripts', 'extract-metadata.ts'),
  buildDbScript: resolve(repoRoot, 'scripts', 'build-database.ts'),
} as const;

export const isWindows = process.platform === 'win32';
