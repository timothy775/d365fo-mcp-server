/**
 * Multi-instance helpers — TypeScript counterpart of instances/*.ps1.
 * An instance is any directory under instances/ holding a d365fo-mcp.json
 * (or a legacy .env from before the setup wizard wrote JSON).
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { settingByPath } from '../config/settings.js';
import { paths } from './context.js';
import { openInstanceStore, readSetting, saveStore, writeSetting } from './settingsStore.js';

const portSetting = settingByPath('server.port')!;

export interface Instance {
  name: string;
  dir: string;
  /** Legacy .env path — may not exist. */
  envFile: string;
  configFile: string;
  port: number | null;
}

export function listInstances(): Instance[] {
  if (!fs.existsSync(paths.instancesDir)) return [];
  return fs.readdirSync(paths.instancesDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const dir = join(paths.instancesDir, e.name);
      return { name: e.name, dir, envFile: join(dir, '.env'), configFile: join(dir, 'd365fo-mcp.json') };
    })
    .filter(i => fs.existsSync(i.configFile) || fs.existsSync(i.envFile))
    .map(i => {
      const value = readSetting(openInstanceStore(i.dir), portSetting);
      return { ...i, port: typeof value === 'number' ? value : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getInstance(name: string): Instance | undefined {
  return listInstances().find(i => i.name === name);
}

/** Next free port: max of existing instance ports + 1, or 3001. */
export function suggestPort(instances: Instance[]): number {
  const used = instances.map(i => i.port).filter((p): p is number => p !== null);
  return used.length > 0 ? Math.max(...used) + 1 : 3001;
}

/**
 * Create instances/<name>/{d365fo-mcp.json,data,metadata} with the port and the
 * instance-local index paths pre-filled; the remaining settings are asked for
 * by the caller. Throws when the instance already exists.
 */
export function createInstance(name: string, port: number): Instance {
  const dir = join(paths.instancesDir, name);
  const envFile = join(dir, '.env');
  const configFile = join(dir, 'd365fo-mcp.json');
  if (fs.existsSync(configFile) || fs.existsSync(envFile)) {
    throw new Error(`Instance '${name}' already exists.`);
  }
  fs.mkdirSync(join(dir, 'data'), { recursive: true });
  fs.mkdirSync(join(dir, 'metadata'), { recursive: true });

  // Relative paths resolve from the config file's directory, so an instance
  // folder can be moved or renamed without touching its configuration.
  const store = openInstanceStore(dir);
  writeSetting(store, portSetting, port);
  writeSetting(store, settingByPath('index.dbPath')!, './data/xpp-metadata.db');
  writeSetting(store, settingByPath('index.labelsDbPath')!, './data/xpp-metadata-labels.db');
  writeSetting(store, settingByPath('index.metadataPath')!, './metadata');
  saveStore(store);

  return { name, dir, envFile, configFile, port };
}
