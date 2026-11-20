import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Layout version of a voice store. Bump when a change needs a migration. */
export const STORE_VERSION = 1;

const STARTER_GUIDE = `# Voice

How I write when something goes out under my name. Agents read this before drafting.

## Core

_No rules yet. Rules are added from how I edit drafts, and each one is approved before it lands here._

## By kind

_Only what differs from the core for one kind of writing._
`;

/**
 * @typedef {object} Store
 * @property {string} root
 * @property {string} guide    VOICE.md, the only file agents need to read
 * @property {string} evidence sanitized before/after pairs, one file per record
 * @property {string} proposals guide changes waiting for approval
 * @property {string} cache    raw, unsanitized text; never committed
 */

/** @param {string} root @returns {Store} */
export function storeAt(root) {
  const resolved = path.resolve(root);
  return { root: resolved, guide: path.join(resolved, 'VOICE.md'), evidence: path.join(resolved, 'evidence'),
    proposals: path.join(resolved, 'proposals'), cache: path.join(resolved, '.cache') };
}

const git = (/** @type {string} */ root, /** @type {string[]} */ args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Creates a voice store, or adopts the one already at `root`. Never overwrites an existing guide.
 * @param {string} root
 * @returns {Store}
 */
export function createStore(root) {
  const store = storeAt(root);
  const marker = path.join(store.root, 'ghostpen.json');
  if (fs.existsSync(marker)) {
    const { version } = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (version !== STORE_VERSION) throw new Error(`This voice store uses layout version ${version}; this ghostpen understands version ${STORE_VERSION}.`);
    assertStoreRoot(store);
    return store;
  }
  if (fs.existsSync(store.root) && fs.readdirSync(store.root).length) throw new Error(`${store.root} exists and is not a voice store. Choose an empty folder.`);
  for (const dir of [store.evidence, store.proposals]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.gitkeep'), ''); }
  fs.writeFileSync(store.guide, STARTER_GUIDE);
  fs.writeFileSync(marker, JSON.stringify({ version: STORE_VERSION }, null, 2) + '\n');
  fs.writeFileSync(path.join(store.root, '.gitignore'), '.cache/\n');
  git(store.root, ['init', '-q', '-b', 'main']);
  commit(store, 'Create voice store', store.guide, marker, path.join(store.root, '.gitignore'),
    path.join(store.evidence, '.gitkeep'), path.join(store.proposals, '.gitkeep'));
  return store;
}

/** @param {Store} store */
export function assertStoreRoot(store) {
  if (git(store.root, ['rev-parse', '--show-prefix']).trim() !== '') {
    throw new Error(`${store.root} must be the root of its own Git repository.`);
  }
}

/**
 * Commits only the files written by the current operation and keeps unrelated staged changes.
 * @param {Store} store @param {string} message @param {string[]} files
 */
export function commit(store, message, ...files) {
  if (!files.length) return false;
  assertStoreRoot(store);
  const paths = files.map(file => path.relative(store.root, file));
  git(store.root, ['--literal-pathspecs', 'add', '-A', '--', ...paths]);
  if (!git(store.root, ['--literal-pathspecs', 'diff', '--cached', '--name-only', '--', ...paths]).trim()) return false;
  git(store.root, ['--literal-pathspecs', ...identity(store.root), 'commit', '-q', '--only', '-m', message, '--', ...paths]);
  return true;
}

/** Git arguments that supply an author when the machine has none configured. Empty when it has. @param {string} root */
export function identity(root) {
  try { if (git(root, ['config', 'user.email']).trim()) return []; } catch { /* not configured */ }
  return ['-c', 'user.name=ghostpen', '-c', 'user.email=ghostpen@localhost'];
}
