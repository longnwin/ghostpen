import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { commit, createStore, storeAt } from '../src/store.mjs';
import { describe, due, lastSync, remoteState, sync, THROTTLE_MS } from '../src/sync.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpen-sync-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

/** Two machines sharing one voice store through a remote: `a` created it, `b` cloned it. */
function twoMachines(t) {
  const dir = temp(t), remote = path.join(dir, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  const a = createStore(path.join(dir, 'a', 'voice'));
  git(a.root, 'remote', 'add', 'origin', remote);
  assert.deepEqual(sync(a), { status: 'ok', pulled: 0, pushed: 1 }, 'the first sync fills an empty remote');
  execFileSync('git', ['clone', '-q', remote, path.join(dir, 'b', 'voice')]);
  return { dir, remote, a, b: storeAt(path.join(dir, 'b', 'voice')) };
}
const addEvidence = (store, name) => {
  const file = path.join(store.evidence, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify({ id: name }) + '\n');
  commit(store, `Add ${name}`, file);
};
const setGuide = (store, text) => { fs.writeFileSync(store.guide, text); commit(store, 'Update voice guide', store.guide); };

test('a store with no remote has nothing to sync with, and says so without failing', t => {
  const store = createStore(path.join(temp(t), 'voice'));
  assert.deepEqual(sync(store), { status: 'no-remote', pulled: 0, pushed: 0 });
  assert.equal(remoteState(store).remote, false);
  assert.match(describe(store, sync(store)), /no remote/);
});

test('what one machine commits reaches the other, and a second sync has nothing left to do', t => {
  const { a, b } = twoMachines(t);
  addEvidence(a, 'one'); addEvidence(a, 'two');
  assert.equal(remoteState(a).ahead, 2);
  assert.deepEqual(sync(a), { status: 'ok', pulled: 0, pushed: 2 });
  assert.deepEqual(sync(b), { status: 'ok', pulled: 2, pushed: 0 });
  assert.ok(fs.existsSync(path.join(b.evidence, 'two.json')));
  assert.deepEqual(sync(b), { status: 'ok', pulled: 0, pushed: 0 });
  assert.equal(describe(b, sync(b)), 'Voice store is up to date.');
  assert.equal(lastSync(b)?.status, 'ok');
});

test('both machines adding different evidence end up with all of it, in one line of history', t => {
  const { a, b } = twoMachines(t);
  addEvidence(a, 'from-a'); addEvidence(b, 'from-b');
  sync(a);
  assert.deepEqual(sync(b), { status: 'ok', pulled: 1, pushed: 1 });
  assert.deepEqual(sync(a), { status: 'ok', pulled: 1, pushed: 0 });
  for (const store of [a, b]) for (const name of ['from-a', 'from-b']) assert.ok(fs.existsSync(path.join(store.evidence, `${name}.json`)), `${name} in ${store.root}`);
  assert.equal(git(a.root, 'rev-parse', 'HEAD'), git(b.root, 'rev-parse', 'HEAD'));
  assert.equal(git(a.root, 'rev-list', '--merges', '--count', 'HEAD'), '0', 'no merge commits');
});

test('when both machines changed the guide, neither version is chosen and nothing is lost', t => {
  const { a, b, remote } = twoMachines(t);
  setGuide(a, '# Voice\n\nRule from machine A.\n'); sync(a);
  setGuide(b, '# Voice\n\nRule from machine B.\n');
  const mine = git(b.root, 'rev-parse', 'HEAD');

  const result = sync(b);
  assert.equal(result.status, 'conflict');
  assert.equal(result.pushed, 0);
  assert.equal(git(b.root, 'rev-parse', 'HEAD'), mine, 'this machine is still on its own commit');
  assert.match(fs.readFileSync(b.guide, 'utf8'), /machine B/, 'its guide is untouched');
  assert.equal(git(b.root, 'status', '--porcelain'), '', 'no half-finished rebase is left behind');
  assert.ok(!fs.existsSync(path.join(b.root, '.git', 'rebase-merge')) && !fs.existsSync(path.join(b.root, '.git', 'rebase-apply')));
  assert.match(execFileSync('git', ['--git-dir', remote, 'show', 'main:VOICE.md'], { encoding: 'utf8' }), /machine A/, 'the remote still has the other version');
  assert.match(describe(b, result), /Nothing was lost or overwritten.*git pull --rebase/s);
  assert.equal(lastSync(b)?.status, 'conflict');

  // Settled by hand, the next sync goes through and both machines agree.
  git(b.root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'pull', '-q', '--rebase', '-X', 'theirs');
  assert.equal(sync(b).status, 'ok');
  assert.equal(sync(a).status, 'ok');
  assert.equal(git(a.root, 'rev-parse', 'HEAD'), git(b.root, 'rev-parse', 'HEAD'));
});

test('an unreachable remote is a result, not an error, and local commits wait for next time', t => {
  const { a, remote } = twoMachines(t);
  addEvidence(a, 'kept');
  fs.renameSync(remote, `${remote}.gone`);
  const result = sync(a, { timeout: 5000 });
  assert.equal(result.status, 'offline');
  assert.equal(remoteState(a).ahead, 1);
  assert.match(describe(a, result), /Nothing was lost/);
  fs.renameSync(`${remote}.gone`, remote);
  assert.deepEqual(sync(a), { status: 'ok', pulled: 0, pushed: 1 });
});

test('uncommitted changes to tracked files stop a sync before it touches anything', t => {
  const { a, b } = twoMachines(t);
  addEvidence(a, 'incoming'); sync(a);
  fs.writeFileSync(b.guide, '# Voice\n\nHalf-written.\n');
  const result = sync(b);
  assert.equal(result.status, 'dirty');
  assert.match(fs.readFileSync(b.guide, 'utf8'), /Half-written/);
  assert.ok(!fs.existsSync(path.join(b.evidence, 'incoming.json')));
});

test('sync refuses to push commits that touched the raw cache even if it was removed', t => {
  const { a, remote } = twoMachines(t);
  const remoteHead = git(remote, 'rev-parse', 'HEAD');
  const raw = path.join(a.cache, 'raw.txt');
  fs.writeFileSync(raw, 'Fictional raw writing.');
  git(a.root, 'add', '-f', '--', raw);
  git(a.root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'Older cache commit');
  git(a.root, 'rm', '--', raw);
  git(a.root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', 'Remove cache file');
  const result = sync(a);
  assert.equal(result.status, 'unsafe');
  assert.match(describe(a, result), /history contains changes to \.cache\//);
  assert.equal(git(remote, 'rev-parse', 'HEAD'), remoteHead);
  assert.equal(lastSync(a)?.status, 'unsafe');
});

test('a second sync cannot start while one holds the lock, and a stale lock expires', t => {
  const { a } = twoMachines(t);
  const lock = path.join(a.cache, 'sync.lock');
  fs.mkdirSync(lock, { recursive: true });
  assert.equal(sync(a).status, 'busy');
  const old = new Date(Date.now() - 10 * 60_000); fs.utimesSync(lock, old, old);
  assert.equal(sync(a).status, 'ok');
  assert.ok(!fs.existsSync(lock));
});

test('a session-start sync is skipped when one just ran, unless there is something to send', t => {
  const { a } = twoMachines(t);
  assert.equal(due(a), false, 'synced a moment ago, nothing to send');
  assert.equal(due(a, Date.now() + THROTTLE_MS + 1), true, 'long enough ago');
  addEvidence(a, 'unsent');
  assert.equal(due(a), true, 'a local commit is waiting');
});

test('the command reports a sync, can be switched to automatic, and the session hook passes on a conflict', t => {
  const { dir, a, b } = twoMachines(t);
  const env = { ...process.env, GHOSTPEN_CONFIG_DIR: path.join(dir, 'config'), GHOSTPEN_NO_BACKGROUND: '1' };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--store', b.root], { encoding: 'utf8', env });

  addEvidence(a, 'shared'); sync(a);
  const first = run('sync');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /received 1 change/);
  assert.equal(run('sync', '--quiet').stdout, '');

  assert.match(run('sync', 'auto').stdout, /on its own/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config', 'ghostpen', 'config.json'), 'utf8')).sync, 'auto');
  assert.equal(JSON.parse(run('status').stdout).sync.automatic, true);
  assert.doesNotMatch(run('hook', 'session-start').stdout, /could not sync/);

  setGuide(a, '# Voice\n\nA.\n'); sync(a);
  setGuide(b, '# Voice\n\nB.\n');
  const clash = run('sync');
  assert.equal(clash.status, 1);
  assert.match(clash.stdout, /Nothing was lost or overwritten/);
  assert.match(run('hook', 'session-start').stdout, /could not sync the user's voice store.*Nothing was lost or overwritten/s);

  assert.match(run('sync', 'off').stdout, /off on this machine/);
  assert.doesNotMatch(run('hook', 'session-start').stdout, /could not sync/, 'with syncing off, the hook stays quiet about it');
});

test('with automatic syncing on, a change is sent in the background without the command waiting for it', async t => {
  const { dir, a, remote } = twoMachines(t);
  const env = { ...process.env, GHOSTPEN_CONFIG_DIR: path.join(dir, 'config') };
  delete env.GHOSTPEN_NO_BACKGROUND;
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args, '--store', a.root], { encoding: 'utf8', env });
  run('sync', 'auto');
  const guide = path.join(dir, 'new-guide.md'); fs.writeFileSync(guide, '# Voice\n\nA proposed rule.\n');
  const added = run('proposals', 'add', '--summary', 'A fictional change', '--guide', guide);
  assert.equal(added.status, 0, added.stderr);
  const head = git(a.root, 'rev-parse', 'HEAD');
  const onRemote = () => { try { return execFileSync('git', ['--git-dir', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
  for (let waited = 0; waited < 10_000 && onRemote() !== head; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(onRemote(), head, 'the proposal reached the remote on its own');
});

test('init on a second machine clones the store and remembers the choice to sync automatically', t => {
  const { dir, a, remote } = twoMachines(t);
  addEvidence(a, 'already-there'); sync(a);
  const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GHOSTPEN_HOME: home, GHOSTPEN_CONFIG_DIR: path.join(home, '.config'), GHOSTPEN_DATA_DIR: path.join(home, '.local', 'share', 'ghostpen'),
    GHOSTPEN_NO_BACKGROUND: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });

  const result = run('init', '--yes', '--from', remote, '--schedule', 'session', '--sync', 'auto', '--instructions', 'none');
  assert.equal(result.status, 0, result.stderr);
  const store = path.join(home, '.ghostpen', 'voice');
  assert.ok(fs.existsSync(path.join(store, 'evidence', 'already-there.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.config', 'ghostpen', 'config.json'), 'utf8')).sync, 'auto');
  const doctor = run('doctor');
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.match(doctor.stdout, /ok\s+Sync: automatic; 0 not sent, 0 not received/);

  // Without the answer, a fresh machine does not start sending anything.
  const other = path.join(dir, 'home2'); fs.mkdirSync(path.join(other, '.claude'), { recursive: true });
  const env2 = { ...env, HOME: other, GHOSTPEN_HOME: other, GHOSTPEN_CONFIG_DIR: path.join(other, '.config'), GHOSTPEN_DATA_DIR: path.join(other, '.local', 'share', 'ghostpen') };
  const quiet = spawnSync(process.execPath, [CLI, 'init', '--yes', '--from', remote, '--schedule', 'session', '--instructions', 'none'], { encoding: 'utf8', env: env2 });
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(other, '.config', 'ghostpen', 'config.json'), 'utf8')).sync, 'off');
});
