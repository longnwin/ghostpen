import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createStore } from '../src/store.mjs';
import { addPair, drafts, evidence, logDraft, pairs } from '../src/records.mjs';
import { pairUp, similarity } from '../src/match.mjs';
import { leakedSpecifics } from '../src/leaks.mjs';
import { matchGitHub } from '../src/capture.mjs';

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpen-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const cli = (dir, args, input) => execFileSync(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, ...args],
  { encoding: 'utf8', input, env: { ...process.env, GHOSTPEN_CONFIG_DIR: path.join(dir, 'config') } });

test('a new store has a guide, history, and keeps raw text out of git; reopening it changes nothing', t => {
  const root = path.join(temp(t), 'voice');
  const store = createStore(root);
  assert.match(fs.readFileSync(store.guide, 'utf8'), /^# Voice/);
  logDraft(store, { kind: 'pr-comment', body: 'A fictional draft.' });
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  fs.writeFileSync(store.guide, '# Voice\n\nMy own rule.\n');
  assert.equal(createStore(root).root, store.root);
  assert.match(fs.readFileSync(store.guide, 'utf8'), /My own rule/);
  const occupied = path.join(temp(t), 'notes'); fs.mkdirSync(occupied); fs.writeFileSync(path.join(occupied, 'a.txt'), 'x');
  assert.throws(() => createStore(occupied), /not a voice store/);
});

test('similarity tracks how much wording survived, and pairing prefers the closest text once', () => {
  assert.equal(similarity('lock the row before writing', 'lock the row before writing'), 1);
  assert.equal(similarity('lock the row before writing', 'rename this variable please'), 0);
  const draftList = [{ body: 'Consider locking the row before the write so two requests cannot overlap.' }, { body: 'This name is unclear, consider renaming it.' }];
  const published = [{ body: 'Rename this: the name is unclear.' }, { body: 'Lock the row before the write. Two requests can overlap here.' }, { body: 'Unrelated remark about tests.' }];
  const result = pairUp(draftList, published);
  assert.equal(result.length, 2);
  assert.equal(result.find(r => r.draft === draftList[0]).published, published[1]);
  assert.equal(result.find(r => r.draft === draftList[1]).published, published[0]);
});

test('a heavy rewrite still pairs when it sits on the same file and line', () => {
  const draftList = [{ body: 'It may be worth considering whether this handler should validate the payload first.', path: 'src/handler.ts', line: 10 }];
  const published = [{ body: 'Validate the payload first.', path: 'src/handler.ts', line: 10 }, { body: 'Validate the payload first, maybe.', path: 'src/other.ts', line: 3 }];
  const [match] = pairUp(draftList, published, { threshold: 0.6 });
  assert.equal(match.published, published[0]);
});

test('the leak check flags identifiers, paths and ticket keys that survive sanitizing, not ordinary words', () => {
  const raw = ['`bookSlotForUser` in src/booking/slots.ts ignores the timezone (ABC-1234).'];
  assert.deepEqual(leakedSpecifics(raw, ['This function ignores the timezone the caller passed.']), []);
  assert.deepEqual(leakedSpecifics(raw, ['`bookSlotForUser` ignores the timezone, see ABC-1234.']), ['ABC-1234', 'bookSlotForUser']);
});

test('drafts headed to a pull request pair with what the user published there; stale ones close as unposted', async t => {
  const store = createStore(path.join(temp(t), 'voice'));
  const target = 'https://github.com/fictional/repo/pull/7';
  logDraft(store, { kind: 'pr-comment', body: 'Consider locking the row before the write so two requests cannot overlap.', target, path: 'src/a.ts', line: 4 });
  logDraft(store, { kind: 'pr-comment', body: 'A draft that was never posted anywhere at all.', target });
  logDraft(store, { kind: 'message', body: 'Not headed to GitHub.', target: 'team chat' });
  const run = async args => {
    const route = args.find(a => a === 'user' || a.startsWith('repos/'));
    if (route === 'user') return 'fictional-user\n';
    if (route.includes('/pulls/7/comments')) return JSON.stringify({ body: 'Lock the row before the write. Two requests can overlap.', source: 'https://github.com/fictional/repo/pull/7#discussion_r1', path: 'src/a.ts', line: 4 }) + '\n';
    return '';
  };
  assert.deepEqual(await matchGitHub(store, { run }), { paired: 1, unposted: 0, waiting: 1 });
  const [pair] = pairs(store);
  assert.equal(pair.source, 'https://github.com/fictional/repo/pull/7#discussion_r1');
  assert.ok(pair.similarity > 0.3 && pair.similarity < 1);
  assert.deepEqual(await matchGitHub(store, { run, now: Date.now() + 30 * 24 * 60 * 60 * 1000 }), { paired: 0, unposted: 1, waiting: 0 });
  assert.deepEqual(drafts(store).map(d => d.status).sort(), ['open', 'paired', 'unposted']);
});

test('cli: a pair becomes committed evidence only once its specifics are rewritten', t => {
  const dir = temp(t), root = path.join(dir, 'voice');
  cli(dir, ['store', 'create', root]);
  const file = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  const { id } = JSON.parse(cli(dir, ['record', '--kind', 'pr-comment', '--source', 'https://example.test/c/1',
    '--before', file('b.md', 'Consider whether `bookSlot` should lock the row.'), '--after', file('a.md', '`bookSlot` must lock the row.')]));
  assert.throws(() => cli(dir, ['evidence', 'add', '--pair', id, '--before', file('sb.md', 'Consider whether `bookSlot` should lock.'), '--after', file('sa.md', 'This must lock.')]), /bookSlot/);
  cli(dir, ['evidence', 'add', '--pair', id, '--before', file('sb.md', 'Consider whether this function should lock the row.'), '--after', file('sa.md', 'This function must lock the row.')]);
  const status = JSON.parse(cli(dir, ['status']));
  assert.deepEqual([status.pairsWaiting, status.evidence], [0, 1]);
  const [saved] = evidence({ evidence: path.join(root, 'evidence') });
  assert.equal(saved.source, 'https://example.test/c/1');
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'evidence', `${saved.id}.json`), 'utf8'), /bookSlot/);
  assert.match(execFileSync('git', ['-C', root, 'log', '--oneline'], { encoding: 'utf8' }), /Add pr-comment evidence/);
});
