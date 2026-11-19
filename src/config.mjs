import fs from 'node:fs';
import { homeDir } from './paths.mjs';
import path from 'node:path';

/** Machine-local settings: where this machine's voice store is and what init wired up here. Not part of the store. */
export const configPath = () => path.join(process.env.GHOSTPEN_CONFIG_DIR || process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config'), 'ghostpen', 'config.json');

/** @returns {{store?: string, [key: string]: unknown}} */
export function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}
/** @param {Record<string, unknown>} changes */
export function writeConfig(changes) {
  const next = { ...readConfig(), ...changes };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}
