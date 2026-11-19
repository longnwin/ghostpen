import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStore } from '../src/store.mjs';
import { drafts, logDraft, samples } from '../src/records.mjs';
import { collectSamples, isUsable, spread } from '../src/seed.mjs';
import { matchGitHub } from '../src/capture.mjs';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpen-seed-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

test('seeding skips text an agent or bot wrote, and anything too short to show a voice', () => {
  assert.equal(isUsable('This throws when the list is empty. Guard it before reading the first item.'), true);
  assert.equal(isUsable('Adds the matcher.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)'), false);
  assert.equal(isUsable('Fix the race.\n\nCo-Authored-By: Claude <noreply@anthropic.com>'), false);
  assert.equal(isUsable('<!-- stack-comment -->\nThis stack of pull requests is managed by a tool, please do not merge it by hand.'), false);
  assert.equal(isUsable('LGTM'), false);
  assert.equal(isUsable('```ts\nconst a = 1; const b = 2; const c = 3; const d = 4;\n```\nNice.'), false);
});

test('samples are spread across time instead of taken from the newest block', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ at: `2024-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z`, n: i }));
  const picked = spread(items, 10);
  assert.equal(picked.length, 10);
  assert.ok(new Set(picked.map(item => item.at.slice(0, 10))).size >= 8);
  assert.equal(spread(items.slice(0, 3), 10).length, 3);
});

/** A fictional GitHub: one page of pull requests the user reviewed or commented on, and one page they opened. */
const fakeGitHub = ({ fail = () => false } = {}) => {
  const calls = [];
  const run = async args => {
    calls.push(args);
    const what = args.includes('graphql') ? 'comments' : args.includes('search/issues') ? 'search' : 'user';
    if (fail(what)) throw new Error('GitHub did not answer in time.');
    if (what === 'user') return 'fictional-user\n';
    if (what === 'comments') {
      const reviewed = args.some(a => a.startsWith('search=') && a.includes('reviewed-by:fictional-user'));
      const comment = (body, createdAt, repo = 'fictional/repo') => ({ body, url: `https://github.com/${repo}/pull/7#r${createdAt}`, createdAt, path: 'a.ts', line: 1, originalLine: 1 });
      const nodes = reviewed ? [{ reviews: { nodes: [{ body: '', url: 'https://github.com/fictional/repo/pull/7#review1', submittedAt: '2024-03-01T00:00:00Z', comments: { nodes: [
          comment('This throws when the list is empty. Guard it before reading the first item.', '2024-03-01T00:00:00Z'),
          comment('This throws when the list is empty. Guard it before reading the first item.', '2024-03-02T00:00:00Z'),
          comment('LGTM', '2024-03-03T00:00:00Z'),
          comment('Please rename this so the unit is in the name; minutes and seconds get mixed up here.', '2025-06-01T00:00:00Z'),
          comment('In another repository entirely, this loop reads one item past the end of the list.', '2024-04-01T00:00:00Z', 'elsewhere/thing'),
        ] } }] }, comments: { nodes: [] } }]
        : [{ reviews: { nodes: [] }, comments: { nodes: [
          { author: { login: 'fictional-user' }, body: 'I would split this into two changes so the rename can land on its own first.', url: 'https://github.com/fictional/repo/pull/8#c1', createdAt: '2024-05-01T00:00:00Z' },
          { author: { login: 'someone-else' }, body: 'A comment by another person on the same pull request, which is not the user’s writing.', url: 'https://github.com/fictional/repo/pull/8#c2', createdAt: '2024-05-02T00:00:00Z' },
        ] } }, {}];
      return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }
    return JSON.stringify({ body: 'Adds retry to the uploader.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)', source: 'https://github.com/fictional/repo/pull/7', at: '2024-02-01T00:00:00Z' }) + '\n'
      + JSON.stringify({ body: 'Retries the upload three times before giving up, because the storage service drops one request in fifty.', source: 'https://github.com/fictional/repo/pull/6', at: '2024-01-01T00:00:00Z' }) + '\n';
  };
  return { run, calls };
};

test('collecting keeps only the user’s own usable writing, honours scope and cutoff, uses a few bulk reads, and replaces earlier samples', async t => {
  const store = createStore(path.join(temp(t), 'voice'));
  const github = fakeGitHub();
  const result = await collectSamples(store, { run: github.run, repos: ['fictional/repo'], before: '2025-01-01' });
  assert.deepEqual(result.saved, { 'pr-comment': 2, 'pr-description': 1 });
  assert.deepEqual(result.failed, []);
  assert.ok(github.calls.length <= 8, `${github.calls.length} calls`);
  const search = github.calls.find(args => args.includes('search/issues')).find(a => a.startsWith('q='));
  assert.ok(search.includes('author:fictional-user') && search.includes('repo:fictional/repo') && search.includes('created:<2025-01-01'));
  assert.deepEqual(samples(store).map(s => s.body.slice(0, 20)).sort(), ['I would split this i', 'Retries the upload t', 'This throws when the']);
  const wider = await collectSamples(store, { run: fakeGitHub().run });
  assert.deepEqual(wider.saved, { 'pr-comment': 4, 'pr-description': 1 });
  assert.equal(spawnSync('git', ['-C', store.root, 'status', '--porcelain'], { encoding: 'utf8' }).stdout, '');
});

test('one source failing is reported and the rest still count; all failing is an error', async t => {
  const store = createStore(path.join(temp(t), 'voice'));
  const partial = await collectSamples(store, { run: fakeGitHub({ fail: what => what === 'comments' }).run });
  assert.deepEqual(partial.saved, { 'pr-comment': 0, 'pr-description': 1 });
  assert.match(partial.failed.join(), /review and conversation comments: GitHub did not answer in time/);
  await assert.rejects(collectSamples(store, { run: fakeGitHub({ fail: what => what !== 'user' }).run }), /could not be read from GitHub/);
});

test('several logged versions for one spot pair once; the others close as superseded', async t => {
  const store = createStore(path.join(temp(t), 'voice'));
  const target = 'https://github.com/fictional/repo/pull/7';
  logDraft(store, { kind: 'pr-comment', body: 'It might be worth considering a guard here before reading the first item of the list.', target, path: 'a.ts', line: 1 });
  logDraft(store, { kind: 'pr-comment', body: 'This throws when the list is empty, so guard it before reading the first item.', target, path: 'a.ts', line: 1 });
  const run = async args => {
    const route = args.find(a => a === 'user' || a.startsWith('repos/'));
    if (route === 'user') return 'fictional-user\n';
    if (route.includes('/pulls/7/comments')) return JSON.stringify({ body: 'This throws when the list is empty. Guard it before reading the first item.', source: 'https://github.com/fictional/repo/pull/7#r1', path: 'a.ts', line: 1 }) + '\n';
    return '';
  };
  assert.deepEqual(await matchGitHub(store, { run }), { paired: 1, unposted: 0, waiting: 0 });
  assert.deepEqual(drafts(store).map(d => d.status).sort(), ['paired', 'superseded']);
});

/** A fictional home with ghostpen installed and three skills: one that writes for the user, one that does not, and ghostpen's own. */
function installed(t) {
  const home = temp(t);
  fs.mkdirSync(path.join(home, '.claude'));
  const skills = path.join(home, '.claude', 'skills');
  const skill = (name, files) => { for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(skills, name, file)), { recursive: true }); fs.writeFileSync(path.join(skills, name, file), text); } };
  skill('ship', { 'SKILL.md': '---\nname: ship\n---\n\n# Ship\n\n1. Run the tests.\n2. Write the PR description from the diff.\n3. Push.\n' });
  skill('review-tool', { 'SKILL.md': '---\nname: review-tool\n---\n\nOpens a workspace.\n', 'references/worker.md': '# Worker\n\n## Draft a PR comment\n\nWrite it as the user would.\n\n## Other\n\nNothing.\n' });
  skill('synced', { 'abc/notes/SKILL.md': '---\nname: notes\n---\n\nWrite the PR description for the user.\n' });
  skill('lint', { 'SKILL.md': '---\nname: lint\n---\n\nRun the linter and report results to the user.\n' });
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GHOSTPEN_HOME: home, GHOSTPEN_CONFIG_DIR: path.join(home, '.config'), GHOSTPEN_DATA_DIR: path.join(home, '.local', 'share', 'ghostpen'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, input });
  const init = run(['init', '--yes', '--remote', '', '--schedule', 'session', '--instructions', 'each', '--integrate', 'yes']);
  assert.equal(init.status, 0, init.stderr);
  return { home, skills, run };
}

test('integrate finds the user’s skills that write for them, including reference files, and ignores the rest', t => {
  const h = installed(t);
  assert.match(h.run(['hook', 'session-start']).stdout, /asked to have their own skills checked/);
  const found = JSON.parse(h.run(['integrate', 'candidates']).stdout);
  assert.deepEqual(found.map(item => path.relative(h.skills, item.file)).sort(), ['review-tool/references/worker.md', 'ship/SKILL.md']);
  assert.equal(found.find(item => item.skill === 'ship').hits[0].line, 8);
  assert.match(h.run(['integrate', '--print']).stdout, /Integrate: add the voice step/);
});

test('a proposed step is shown first, applied only on request with fixed text, tracked by doctor, and removed by uninstall', t => {
  const h = installed(t);
  const worker = path.join(h.skills, 'review-tool', 'references', 'worker.md'), original = fs.readFileSync(worker, 'utf8');
  assert.equal(h.run(['integrate', 'propose', '--file', path.join(h.home, '.claude', 'CLAUDE.md'), '--after-line', '1', '--kind', 'pr-comment', '--note', 'x']).status, 1);
  const proposed = h.run(['integrate', 'propose', '--file', worker, '--after-line', '3', '--kind', 'pr-comment', '--note', 'Drafts the PR comment the user posts.']);
  assert.equal(proposed.status, 0, proposed.stderr);
  const { id } = JSON.parse(proposed.stdout);
  assert.equal(fs.readFileSync(worker, 'utf8'), original);
  const review = h.run(['integrate', 'review']).stdout;
  assert.match(review, /Why: Drafts the PR comment the user posts\./);
  assert.match(review, /\+ \*\*Voice\.\*\* This step writes text that goes out under the user's name/);
  assert.match(h.run(['hook', 'session-start']).stdout, /1 proposed skill change is waiting/);
  assert.equal(h.run(['integrate', 'apply', id]).status, 0);
  const changed = fs.readFileSync(worker, 'utf8');
  assert.match(changed, /## Draft a PR comment\n\n<!-- ghostpen:step:start -->\n\*\*Voice\.\*\*[^\n]*draft --kind pr-comment[^\n]*\n<!-- ghostpen:step:end -->\n\nWrite it as the user would\./);
  assert.equal(h.run(['integrate', 'propose', '--file', worker, '--after-line', '3', '--kind', 'pr-comment', '--note', 'again']).status, 1);
  assert.equal(JSON.parse(h.run(['integrate', 'candidates']).stdout).find(item => item.skill === 'review-tool').integrated, true);
  assert.match(h.run(['doctor']).stdout, /ok\s+Voice step in skill: .*worker\.md/);
  assert.doesNotMatch(h.run(['hook', 'session-start']).stdout, /skills checked|skill change/);
  assert.equal(h.run(['uninstall']).status, 0);
  assert.equal(fs.readFileSync(worker, 'utf8'), original);
});

test('a writing sample becomes evidence only once sanitized, and the offer to seed stops after that', t => {
  const h = installed(t);
  const store = createStore(path.join(h.home, '.ghostpen', 'voice'));
  const dir = path.join(store.cache, 'samples'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's1.json'), JSON.stringify({ id: 's1', version: 1, kind: 'pr-comment', body: '`bookSlot` throws when the list is empty. Guard it first.', source: 'https://example.test/c/1', at: '2024-01-01T00:00:00Z' }));
  assert.match(h.run(['hook', 'session-start']).stdout, /1 samples of the user's past writing are ready/);
  const file = (name, text) => { const p = path.join(h.home, name); fs.writeFileSync(p, text); return p; };
  assert.equal(h.run(['evidence', 'add-sample', '--sample', 's1', '--text', file('raw.md', '`bookSlot` throws when the list is empty.')]).status, 1);
  assert.equal(h.run(['evidence', 'add-sample', '--sample', 's1', '--text', file('clean.md', 'This function throws when the list is empty. Guard it first.')]).status, 0);
  const [saved] = JSON.parse(h.run(['evidence', 'list']).stdout);
  assert.deepEqual([saved.origin, saved.before, saved.source], ['sample', '', 'https://example.test/c/1']);
  assert.doesNotMatch(h.run(['hook', 'session-start']).stdout, /samples of the user's past writing/);
  assert.match(h.run(['seed', '--print']).stdout, /Seed: a first voice guide from past writing/);
});

