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
    return store;
  }
  if (fs.existsSync(store.root) && fs.readdirSync(store.root).length) throw new Error(`${store.root} exists and is not a voice store. Choose an empty folder.`);
  for (const dir of [store.evidence, store.proposals]) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.gitkeep'), ''); }
  fs.writeFileSync(store.guide, STARTER_GUIDE);
  fs.writeFileSync(marker, JSON.stringify({ version: STORE_VERSION }, null, 2) + '\n');
  fs.writeFileSync(path.join(store.root, '.gitignore'), '.cache/\n');
  git(store.root, ['init', '-q', '-b', 'main']);
  commit(store, 'Create voice store');
  return store;
}

/**
 * Commits everything tracked in the store. Uses a fallback identity so a machine without git config still gets history.
 * @param {Store} store @param {string} message
 */
export function commit(store, message) {
  git(store.root, ['add', '-A']);
  if (!git(store.root, ['status', '--porcelain']).trim()) return false;
  const identity = (() => { try { return git(store.root, ['config', 'user.email']).trim() ? [] : null; } catch { return null; } })()
    ?? ['-c', 'user.name=ghostpen', '-c', 'user.email=ghostpen@localhost'];
  git(store.root, [...identity, 'commit', '-q', '-m', message]);
  return true;
}
