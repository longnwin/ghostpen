import os from 'node:os';
import path from 'node:path';

/** Overridable so tests and unusual setups never touch the real home folder. */
export const homeDir = () => process.env.GHOSTPEN_HOME || os.homedir();
export const dataDir = () => process.env.GHOSTPEN_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(homeDir(), '.local', 'share'), 'ghostpen');
/** Where the `ghostpen` launcher goes: the usual per-user folder for commands. */
export const binDir = () => process.env.GHOSTPEN_BIN_DIR || path.join(homeDir(), '.local', 'bin');
/** Shell-quotes one argument for the commands ghostpen writes into hooks, schedules and skill text. */
export const quote = (/** @type {string} */ value) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
