import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './paths.mjs';

/**
 * What ghostpen needs to know to wire itself into one coding agent.
 * @typedef {object} Agent
 * @property {string} id
 * @property {string} name
 * @property {boolean} present
 * @property {string} skillsDir      user-level skills folder
 * @property {string} instructions   file the agent reads at the start of every session
 * @property {string} hooksFile      JSON file holding user-level hooks
 * @property {string} [hooksNote]    what the user still has to do before hooks run
 */

/** @returns {Agent[]} */
export function knownAgents() {
  const home = homeDir(), claude = path.join(home, '.claude'), codex = path.join(home, '.codex');
  return [
    { id: 'claude', name: 'Claude Code', present: fs.existsSync(claude), skillsDir: path.join(claude, 'skills'),
      instructions: path.join(claude, 'CLAUDE.md'), hooksFile: path.join(claude, 'settings.json') },
    { id: 'codex', name: 'Codex', present: fs.existsSync(codex), skillsDir: path.join(home, '.agents', 'skills'),
      instructions: path.join(codex, 'AGENTS.md'), hooksFile: path.join(codex, 'hooks.json'),
      hooksNote: 'Codex ignores new hooks until you trust them: open Codex, run /hooks, and trust the ghostpen entry.' },
  ];
}

const MARKER = '.ghostpen-skill';

/**
 * Copies the skill into a skills folder. Two agents sharing one real folder get one copy.
 * @param {string} skillsDir @param {string} source folder holding SKILL.md @param {string} command the ghostpen command to write into the skill
 * @returns {string} the installed folder
 */
export function installSkill(skillsDir, source, command) {
  fs.mkdirSync(skillsDir, { recursive: true });
  const target = path.join(fs.realpathSync(skillsDir), 'ghostpen');
  if (fs.existsSync(target) && !fs.existsSync(path.join(target, MARKER))) throw new Error(`${target} already exists and was not installed by ghostpen. Move it aside and run init again.`);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8').replaceAll('{{GHOSTPEN}}', command));
  fs.writeFileSync(path.join(target, MARKER), 'Installed by ghostpen. Removed by `ghostpen uninstall`.\n');
  return target;
}
/** @param {string} target */
export function removeSkill(target) {
  if (fs.existsSync(path.join(target, MARKER))) fs.rmSync(target, { recursive: true, force: true });
}

const readJson = (/** @type {string} */ file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return {}; throw new Error(`${file} is not valid JSON, so ghostpen left it alone.`); } };
const isOurs = (/** @type {any} */ entry) => Array.isArray(entry?.hooks) && entry.hooks.some((/** @type {any} */ hook) => typeof hook?.command === 'string' && hook.command.includes(' hook session-start'));

/**
 * Adds ghostpen's session-start hook, keeping every other setting in the file.
 * @param {string} file @param {string} command
 */
export function installHook(file, command) {
  const settings = readJson(file);
  settings.hooks ||= {};
  const others = (Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : []).filter((/** @type {any} */ entry) => !isOurs(entry));
  settings.hooks.SessionStart = [...others, { hooks: [{ type: 'command', command: `${command} hook session-start`, timeout: 10 }] }];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
/** @param {string} file */
export function removeHook(file) {
  if (!fs.existsSync(file)) return;
  const settings = readJson(file);
  if (!Array.isArray(settings.hooks?.SessionStart)) return;
  settings.hooks.SessionStart = settings.hooks.SessionStart.filter((/** @type {any} */ entry) => !isOurs(entry));
  if (!settings.hooks.SessionStart.length) delete settings.hooks.SessionStart;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
/** @param {string} file */
export const hasHook = file => { try { return (readJson(file).hooks?.SessionStart || []).some(isOurs); } catch { return false; } };
