import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { homeDir } from './paths.mjs';

const START = '<!-- ghostpen:start -->', END = '<!-- ghostpen:end -->';
const expand = (/** @type {string} */ value, /** @type {string} */ from) => path.resolve(path.dirname(from), value.startsWith('~/') ? path.join(homeDir(), value.slice(2)) : value);
const read = (/** @type {string} */ file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/**
 * Files a session is told to load, starting from an agent's instructions file: `@path` imports, and
 * Markdown files it names by absolute or `~/` path (how people point every session at a shared notes store).
 * @param {string} file @returns {string[]} real paths, the starting file first
 */
export function loadedFrom(file, depth = 4, seen = new Set()) {
  const text = read(file);
  if (text === null) return [];
  const real = fs.realpathSync(file);
  if (seen.has(real)) return [];
  seen.add(real);
  if (depth === 0) return [real];
  const named = [...text.matchAll(/(?:^|[\s(`"'])@?((?:~|\/)[\w./@+-]*\.md)\b/gm)].map(match => expand(match[1], file));
  const imported = [...text.matchAll(/(?:^|\s)@(\.{1,2}\/[\w./@+-]*\.md)\b/gm)].map(match => expand(match[1], file));
  return [real, ...[...named, ...imported].flatMap(next => loadedFrom(next, depth - 1, seen))];
}

/**
 * Where the voice line should live. A file every selected agent already loads is best: one place, all tools.
 * Otherwise each agent's own instructions file.
 * @param {{id: string, instructions: string}[]} agents
 * @returns {{present: string[], shared: string[], perAgent: string[]}}
 */
export function instructionHomes(agents) {
  const chains = agents.map(agent => loadedFrom(agent.instructions));
  const everything = [...new Set(chains.flat())];
  const own = new Set(agents.map(agent => { try { return fs.realpathSync(agent.instructions); } catch { return path.resolve(agent.instructions); } }));
  return {
    present: everything.filter(file => (read(file) || '').includes(START)),
    shared: agents.length > 1 ? everything.filter(file => !own.has(file) && chains.every(chain => chain.includes(file))) : [],
    perAgent: agents.map(agent => agent.instructions),
  };
}

/** @param {string} guide */
export const voiceBlock = guide => `${START}
## Voice
Before writing anything that will be posted or sent under the user's name (PR comments and
descriptions, commit messages, issues, specs and documents, messages), read ${guide} and follow it.
This applies in every session and project. It covers writing as the user, not replies to the user.
${END}`;

/** Commits one file when it lives in a git repo, so stores that keep history stay consistent. */
function commitIfTracked(/** @type {string} */ file, /** @type {string} */ message) {
  try {
    const dir = path.dirname(file);
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'add', '--', file], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', message, '--', file], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/** @param {string} file @param {string} guide @returns {{file: string, committed: boolean}} */
export function addVoiceLine(file, guide) {
  const current = read(file) ?? '';
  const without = current.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`), '').replace(/\s+$/, '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${without}${without ? '\n\n' : ''}${voiceBlock(guide)}\n`);
  return { file, committed: commitIfTracked(file, 'Add ghostpen voice line') };
}
/** @param {string} file */
export function removeVoiceLine(file) {
  const current = read(file);
  if (current === null || !current.includes(START)) return false;
  fs.writeFileSync(file, current.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`), '\n').replace(/\s+$/, '') + '\n');
  commitIfTracked(file, 'Remove ghostpen voice line');
  return true;
}
