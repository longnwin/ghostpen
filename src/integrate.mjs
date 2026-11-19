import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from './paths.mjs';
import { KINDS } from './records.mjs';

const START = '<!-- ghostpen:step:start -->', END = '<!-- ghostpen:step:end -->';
const BLOCK = new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, 'g');
/** Phrases that suggest an instruction file tells an agent to write something the user will publish. */
const WRITES = /\b(pr|pull request) (description|body|title|comment)|commit message|review comment|draft(s|ed|ing)? (a |an |the )?(pr |review )?(comment|reply|message|description|spec|email|ticket|issue|post)|(post|leave|add|write)(s|ing)? (a |an |the )?(pr |review |inline )?(comment|reply)|writ(e|es|ing) (a |an |the )?(spec|ticket|issue|description|summary|announcement|release notes?|changelog)|release notes|engineering spec|linear (ticket|issue)s?\b/i;

const pendingFile = () => path.join(dataDir(), 'integrations-pending.json');
/** @returns {Proposal[]} */
const readPending = () => { try { return JSON.parse(fs.readFileSync(pendingFile(), 'utf8')); } catch { return []; } };
const writePending = (/** @type {Proposal[]} */ list) => { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(pendingFile(), JSON.stringify(list, null, 2) + '\n'); };

/**
 * A place in one of the user's own skills where the voice step would go. Waiting for the user's approval.
 * @typedef {{id: string, file: string, afterLine: number, kind: string, note: string, createdAt: string}} Proposal
 */

function markdownFiles(/** @type {string} */ dir, depth = 3) {
  /** @type {string[]} */
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'tests', 'test'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...markdownFiles(full, depth - 1));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

/**
 * Instruction files in the user's own skills that look like they tell an agent to write text for publishing.
 * Only user-level skills folders are read, so team-owned and plugin-installed skills are never candidates.
 * @param {string[]} skillsDirs
 * @returns {{file: string, skill: string, integrated: boolean, hits: {line: number, text: string}[]}[]}
 */
export function candidates(skillsDirs) {
  const roots = [...new Set(skillsDirs.filter(dir => fs.existsSync(dir)).map(dir => fs.realpathSync(dir)))];
  const result = [];
  for (const root of roots) for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const skillDir = path.join(root, entry.name);
    // 'synced' holds skills an agent syncs from the user's account; they are replaced on sync, so they are not the user's to edit here.
    if (entry.name === 'synced' || entry.name.startsWith('.') || entry.name.startsWith('_') || !fs.statSync(skillDir).isDirectory() || fs.existsSync(path.join(skillDir, '.ghostpen-skill'))) continue;
    for (const file of markdownFiles(skillDir)) {
      const text = fs.readFileSync(file, 'utf8');
      const hits = text.split('\n').map((line, index) => ({ line: index + 1, text: line.trim().slice(0, 160) })).filter(row => WRITES.test(row.text));
      if (hits.length) result.push({ file, skill: entry.name, integrated: text.includes(START), hits: hits.slice(0, 6) });
    }
  }
  return result;
}

/** The step itself. ghostpen writes this text, not the agent proposing where it goes, so nothing else can be slipped into a skill. */
export const stepBlock = (/** @type {string} */ command, /** @type {string} */ kind) => `${START}
**Voice.** This step writes text that goes out under the user's name. Before writing it, run \`${command} guide\`, read that file, and follow it. After writing it, log the text exactly as drafted, passing it on standard input: \`${command} draft --kind ${kind} --target "<URL it will be published at, or a few words>" --file -\` (add \`--path <file> --line <n>\` for a comment on a line of code). Logging stays on this machine and is not publishing.
${END}`;

/** @param {{file: string, afterLine: number, kind: string, note: string}} input @param {string[]} skillsDirs */
export function propose(input, skillsDirs) {
  const file = fs.realpathSync(path.resolve(input.file));
  if (!candidates(skillsDirs).some(item => item.file === file) && !skillsDirs.some(dir => fs.existsSync(dir) && file.startsWith(fs.realpathSync(dir) + path.sep))) throw new Error('That file is not in one of your own skills folders.');
  if (!KINDS.includes(input.kind)) throw new Error(`Unknown kind "${input.kind}". Use one of: ${KINDS.join(', ')}.`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (!Number.isInteger(input.afterLine) || input.afterLine < 1 || input.afterLine > lines.length) throw new Error(`--after-line must be between 1 and ${lines.length}.`);
  if (fs.readFileSync(file, 'utf8').includes(START)) throw new Error('That file already has the voice step.');
  const pending = readPending().filter(item => item.file !== file);
  const proposal = { id: randomUUID().slice(0, 8), file, afterLine: input.afterLine, kind: input.kind, note: input.note.trim(), createdAt: new Date().toISOString() };
  writePending([...pending, proposal]);
  return proposal;
}
export const pending = readPending;

/** What applying a proposal would add, with the lines around it, for the user to judge. */
export function preview(/** @type {Proposal} */ proposal, /** @type {string} */ command) {
  const lines = fs.readFileSync(proposal.file, 'utf8').split('\n');
  const before = lines.slice(Math.max(0, proposal.afterLine - 3), proposal.afterLine).map(line => `  ${line}`);
  const after = lines.slice(proposal.afterLine, proposal.afterLine + 2).map(line => `  ${line}`);
  return [`${proposal.id}  ${proposal.file} (after line ${proposal.afterLine})`, `Why: ${proposal.note}`, ...before, ...stepBlock(command, proposal.kind).split('\n').map(line => `+ ${line}`), ...after].join('\n');
}

/** Inserts the step. Returns the file so the caller can record it. Never commits. */
export function apply(/** @type {string} */ id, /** @type {string} */ command) {
  const list = readPending(), proposal = list.find(item => item.id === id);
  if (!proposal) throw new Error('No waiting integration has that id.');
  const lines = fs.readFileSync(proposal.file, 'utf8').split('\n');
  lines.splice(proposal.afterLine, 0, '', ...stepBlock(command, proposal.kind).split('\n'), '');
  fs.writeFileSync(proposal.file, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
  writePending(list.filter(item => item.id !== id));
  return proposal.file;
}
export function dismiss(/** @type {string} */ id) {
  const list = readPending();
  if (!list.some(item => item.id === id)) throw new Error('No waiting integration has that id.');
  writePending(list.filter(item => item.id !== id));
}
export const hasStep = (/** @type {string} */ file) => { try { return fs.readFileSync(file, 'utf8').includes(START); } catch { return false; } };
export function removeStep(/** @type {string} */ file) {
  if (!hasStep(file)) return false;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(BLOCK, '\n').replace(/\n{3,}/g, '\n\n'));
  return true;
}
/** Rewrites a step already in a skill so it names the current command, keeping its place and kind. */
export function refreshStep(/** @type {string} */ file, /** @type {string} */ command) {
  if (!hasStep(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(new RegExp(`${START}[\\s\\S]*?${END}`, 'g'), block => stepBlock(command, (/--kind ([\w-]+)/.exec(block) || [])[1] || 'other'));
  if (next !== text) fs.writeFileSync(file, next);
  return next !== text;
}
export const clearPending = () => fs.rmSync(pendingFile(), { force: true });
