import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertStoreRoot, identity } from './store.mjs';

/**
 * Keeps one voice store the same on every machine that uses it, through the store's own git remote.
 *
 * Git sends committed changes. Ghostpen keeps raw drafts and pairs in the local `.cache` directory
 * and refuses to send commits that touch it.
 *
 * Two rules shape everything here. Syncing must never fail or slow down the thing that triggered it, so
 * every network step has a time limit and every failure is a result, not an exception. And it must never
 * choose between two versions of the user's guide: when both machines changed the same file, it puts the
 * store back exactly as it was and says so.
 */

/** @typedef {'ok' | 'no-remote' | 'offline' | 'conflict' | 'dirty' | 'unsafe' | 'busy'} SyncStatus */
/** @typedef {{status: SyncStatus, pulled: number, pushed: number, detail?: string}} SyncResult */
/** @typedef {import('./store.mjs').Store} Store */

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
/** Git must never stop to ask for a password or a host key: nobody is there to answer. */
const QUIET = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes -oConnectTimeout=5' };
const LOCK_STALE_MS = 2 * 60_000;
/** A session-start sync is skipped when the last one was this recent and there is nothing to send. */
export const THROTTLE_MS = 10 * 60_000;

/** @param {string} root @param {string[]} args @param {number} [timeout] */
const git = (root, args, timeout) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, env: { ...process.env, ...QUIET } }).trim();
/** @param {string} root @param {string[]} args @param {number} [timeout] @returns {{ok: true, out: string} | {ok: false, err: string}} */
const attempt = (root, args, timeout) => {
  try { return { ok: true, out: git(root, args, timeout) }; }
  catch (error) { const e = /** @type {any} */ (error); return { ok: false, err: String(e.stderr || e.message || '').trim().split('\n').filter(Boolean).pop() || 'git failed' }; }
};
const count = (/** @type {string} */ root, /** @type {string} */ range) => { const result = attempt(root, ['rev-list', '--count', range]); return result.ok ? Number(result.out) : 0; };

/** @param {Store} store @param {string} [upstream] @param {string} [head] */
export function assertNoOutgoingCache(store, upstream, head = 'HEAD') {
  const range = upstream ? `${upstream}..${head}` : head;
  if (git(store.root, ['log', '--full-history', '-1', '--format=%H', range, '--', '.cache/'])) {
    throw new Error('Outgoing voice store history contains changes to .cache/. Keep that history local.');
  }
}

const statePath = (/** @type {Store} */ store) => path.join(store.cache, 'sync.json');
const lockPath = (/** @type {Store} */ store) => path.join(store.cache, 'sync.lock');

/** What the last sync on this machine did. Machine-local: it sits in the ignored cache folder. @returns {(SyncResult & {at: string}) | null} */
export function lastSync(/** @type {Store} */ store) {
  try { return JSON.parse(fs.readFileSync(statePath(store), 'utf8')); } catch { return null; }
}
const remember = (/** @type {Store} */ store, /** @type {SyncResult} */ result) => {
  try { fs.mkdirSync(store.cache, { recursive: true }); fs.writeFileSync(statePath(store), JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2) + '\n'); } catch { /* a result nobody can read is not worth failing over */ }
  return result;
};

/**
 * Where the store stands against its remote, from what git already knows. No network.
 * @returns {{remote: boolean, branch: string, ahead: number, behind: number}}
 */
export function remoteState(/** @type {Store} */ store) {
  const branch = (() => { const result = attempt(store.root, ['rev-parse', '--abbrev-ref', 'HEAD']); return result.ok ? result.out : 'main'; })();
  if (!attempt(store.root, ['remote', 'get-url', 'origin']).ok) return { remote: false, branch, ahead: 0, behind: 0 };
  const known = attempt(store.root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).ok;
  return { remote: true, branch, ahead: known ? count(store.root, `origin/${branch}..HEAD`) : count(store.root, 'HEAD'), behind: known ? count(store.root, `HEAD..origin/${branch}`) : 0 };
}

/** Takes the lock, or reports that another sync holds it. A lock left by a crashed run expires. */
const lock = (/** @type {Store} */ store) => {
  fs.mkdirSync(store.cache, { recursive: true });
  try { fs.mkdirSync(lockPath(store)); return true; }
  catch {
    try { if (Date.now() - fs.statSync(lockPath(store)).mtimeMs > LOCK_STALE_MS) { fs.rmSync(lockPath(store), { recursive: true, force: true }); fs.mkdirSync(lockPath(store)); return true; } } catch { /* lost the race */ }
    return false;
  }
};

/**
 * Brings in what other machines pushed, then sends what this one committed.
 *
 * Local commits are replayed on top of the remote's, so history stays a straight line. If that replay hits
 * a conflict it is undone completely: the store is left on its own commits, untouched, and the result says
 * `conflict`. Nothing here ever discards a commit, forces a push, or edits a file to settle a difference.
 *
 * @param {Store} store
 * @param {{timeout?: number, push?: boolean}} [options] `timeout` is per network step, in milliseconds.
 * @returns {SyncResult}
 */
export function sync(store, { timeout = 15_000, push = true } = {}) {
  const { remote, branch } = remoteState(store);
  if (!remote) return { status: 'no-remote', pulled: 0, pushed: 0 };
  try { assertStoreRoot(store); } catch {
    return { status: 'unsafe', pulled: 0, pushed: 0, detail: 'The voice store must be the root of its own Git repository.' };
  }
  if (!lock(store)) return { status: 'busy', pulled: 0, pushed: 0 };
  let pulled = 0, pushed = 0;
  const done = (/** @type {SyncStatus} */ status, /** @type {string} */ detail = '') => remember(store, { status, pulled, pushed, ...(detail ? { detail } : {}) });
  try {
    // A commit made while this runs is picked up by going round again, so nothing waits for the next trigger.
    for (let round = 0; round < 3; round++) {
      if (git(store.root, ['status', '--porcelain', '--untracked-files=no'])) return done('dirty', 'The voice store has uncommitted changes to tracked files.');
      const fetched = attempt(store.root, ['fetch', '-q', 'origin', branch], timeout);
      const known = attempt(store.root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]).ok;
      // A remote that has no such branch yet is an empty repository waiting for its first push, not a failure.
      if (!fetched.ok && known) return done('offline', fetched.err);
      if (!fetched.ok && !/couldn't find remote ref|could not find remote ref/i.test(fetched.err)) return done('offline', fetched.err);

      const behind = known ? count(store.root, `HEAD..origin/${branch}`) : 0;
      const ahead = known ? count(store.root, `origin/${branch}..HEAD`) : count(store.root, 'HEAD');
      if (behind) {
        const moved = ahead ? attempt(store.root, [...identity(store.root), 'rebase', '-q', `origin/${branch}`]) : attempt(store.root, ['merge', '-q', '--ff-only', `origin/${branch}`]);
        if (!moved.ok) {
          attempt(store.root, ['rebase', '--abort']);
          return done('conflict', 'This machine and another both changed the same part of the voice store.');
        }
        pulled += behind;
      }
      if (!push || !ahead) return done('ok');
      const head = git(store.root, ['rev-parse', 'HEAD']);
      try { assertNoOutgoingCache(store, known ? `origin/${branch}` : undefined, head); }
      catch (error) { return done('unsafe', /** @type {Error} */ (error).message); }
      const sent = attempt(store.root, ['push', '-q', 'origin', `${head}:refs/heads/${branch}`], timeout);
      if (sent.ok) { pushed += ahead; if (!count(store.root, `origin/${branch}..HEAD`)) return done('ok'); continue; }
      // Rejected because another machine pushed in the meantime: go round and take theirs first.
      if (!/rejected|non-fast-forward|fetch first/i.test(sent.err)) return done('offline', sent.err);
    }
    return done('offline', 'The remote kept changing while syncing. It will be tried again.');
  } catch (error) {
    return done('offline', /** @type {Error} */ (error).message.split('\n')[0]);
  } finally {
    fs.rmSync(lockPath(store), { recursive: true, force: true });
  }
}

/** One sentence for a person, for each way a sync can end. */
export function describe(/** @type {Store} */ store, /** @type {SyncResult} */ result) {
  const moved = [result.pulled && `received ${result.pulled} change${result.pulled === 1 ? '' : 's'}`, result.pushed && `sent ${result.pushed}`].filter(Boolean).join(' and ');
  switch (result.status) {
    case 'ok': return moved ? `Voice store synced: ${moved}.` : 'Voice store is up to date.';
    case 'no-remote': return 'This voice store has no remote, so there is nothing to sync with. Run `ghostpen init` to create one.';
    case 'busy': return 'Another sync is already running.';
    case 'offline': return `Could not reach the voice store's remote${moved ? ` (after it ${moved})` : ''}: ${result.detail}. Nothing was lost; it will be tried again.`;
    case 'unsafe': return `Voice store sync stopped. ${result.detail}`;
    case 'dirty': return `${result.detail} Commit or discard them in ${store.root}, then run \`ghostpen sync\`.`;
    case 'conflict': return `${result.detail} Nothing was lost or overwritten: this machine's changes are still here and the other machine's are still on the remote. `
      + `Settle it by hand in ${store.root} with \`git pull --rebase\`, then run \`ghostpen sync\`.`;
  }
}

/**
 * Whether a sync at session start is worth starting. One was either never run, ran long enough ago, or
 * this machine has commits the remote has not seen.
 */
export function due(/** @type {Store} */ store, now = Date.now()) {
  const last = lastSync(store);
  if (!last) return true;
  if (now - Date.parse(last.at) >= THROTTLE_MS) return true;
  return remoteState(store).ahead > 0 && last.status !== 'conflict' && last.status !== 'dirty' && last.status !== 'unsafe';
}

/**
 * Starts a sync that outlives the caller and reports nothing. Used from the session hook and after commits,
 * where waiting on the network would slow the user down and a failure must not surface as an error.
 */
export function syncInBackground(/** @type {Store} */ store) {
  if (process.env.GHOSTPEN_NO_BACKGROUND) return false;
  try {
    spawn(process.execPath, [CLI, 'sync', '--quiet', '--store', store.root], { detached: true, stdio: 'ignore', env: process.env }).unref();
    return true;
  } catch { return false; }
}
