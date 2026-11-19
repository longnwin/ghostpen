import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const CLI = new URL('../src/cli.mjs', import.meta.url).pathname;

/** A fictional home folder with two agents whose instructions both point at one shared notes file. */
function fakeHome(t, { sharedSkills = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ghostpen-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const notes = path.join(home, 'notes');
  fs.mkdirSync(notes); fs.mkdirSync(path.join(home, '.claude')); fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(notes, 'NOTES.md'), '# Notes\n\nShared operating notes.\n');
  execFileSync('git', ['-C', notes, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', notes, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'add', '-A']);
  execFileSync('git', ['-C', notes, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'notes']);
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), `# Global\n\nAt the start of every session, read:\n- ${notes}/NOTES.md (operating notes)\n`);
  fs.writeFileSync(path.join(home, '.codex', 'AGENTS.md'), `Read ~/notes/NOTES.md first.\n`);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } }));
  if (sharedSkills) { fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true }); fs.symlinkSync(path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills')); }
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GHOSTPEN_HOME: home, GHOSTPEN_CONFIG_DIR: path.join(home, '.config'), GHOSTPEN_DATA_DIR: path.join(home, '.local', 'share', 'ghostpen'),
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, input });
  return { home, notes, run };
}

test('init wires both agents with no hand edits, puts the voice line in the shared notes file, and doctor confirms it', t => {
  const h = fakeHome(t);
  const result = h.run(['init', '--yes', '--remote', '', '--schedule', 'session']);
  assert.equal(result.status, 0, result.stderr);
  const store = path.join(h.home, '.ghostpen', 'voice');
  assert.match(fs.readFileSync(path.join(store, 'VOICE.md'), 'utf8'), /^# Voice/);
  for (const dir of ['.claude/skills/ghostpen', '.agents/skills/ghostpen']) {
    const skill = fs.readFileSync(path.join(h.home, dir, 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname: ghostpen\ndescription: /);
    assert.doesNotMatch(skill, /\{\{GHOSTPEN\}\}/);
    assert.ok(skill.includes(path.join(h.home, '.local/share/ghostpen/app/src/cli.mjs')));
  }
  const settings = JSON.parse(fs.readFileSync(path.join(h.home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.hooks.Stop.length, 1);
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, / hook session-start$/);
  assert.match(JSON.parse(fs.readFileSync(path.join(h.home, '.codex', 'hooks.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command, / hook session-start$/);
  const notes = fs.readFileSync(path.join(h.notes, 'NOTES.md'), 'utf8');
  assert.match(notes, /<!-- ghostpen:start -->\n## Voice\n[\s\S]*VOICE\.md[\s\S]*<!-- ghostpen:end -->/);
  assert.doesNotMatch(fs.readFileSync(path.join(h.home, '.claude', 'CLAUDE.md'), 'utf8'), /ghostpen:start/);
  assert.match(execFileSync('git', ['-C', h.notes, 'log', '--oneline'], { encoding: 'utf8' }), /Add ghostpen voice line/);
  assert.match(result.stdout, /One step left for you: Codex ignores new hooks until you trust them/);
  const doctor = h.run(['doctor']);
  assert.equal(doctor.status, 0, doctor.stdout);
  assert.doesNotMatch(doctor.stdout, /MISSING/);
  const hook = h.run(['hook', 'session-start']);
  assert.match(hook.stdout, new RegExp(`read ${store}/VOICE\\.md and follow it`));

  const again = h.run(['init', '--yes', '--remote', '', '--schedule', 'session']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Voice line already present/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart.length, 1);
  assert.equal(fs.readFileSync(path.join(h.notes, 'NOTES.md'), 'utf8').match(/ghostpen:start/g).length, 1);
});

test('uninstall removes every piece init added and keeps the voice store and the user’s other settings', t => {
  const h = fakeHome(t);
  assert.equal(h.run(['init', '--yes', '--remote', '', '--schedule', 'session']).status, 0);
  fs.rmSync(path.join(h.home, '.agents/skills/ghostpen'), { recursive: true });
  const broken = h.run(['doctor']);
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /MISSING\s+Codex skill/);
  const removed = h.run(['uninstall']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(path.join(h.home, '.claude/skills/ghostpen')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.home, '.claude', 'settings.json'), 'utf8')), { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.home, '.codex', 'hooks.json'), 'utf8')), {});
  assert.equal(fs.readFileSync(path.join(h.notes, 'NOTES.md'), 'utf8'), '# Notes\n\nShared operating notes.\n');
  assert.ok(fs.existsSync(path.join(h.home, '.ghostpen', 'voice', 'VOICE.md')));
  assert.equal(h.run(['hook', 'session-start']).stdout, '');
});

test('agents that share one skills folder get one copy; choosing one agent and its own file leaves the other untouched', t => {
  const shared = fakeHome(t, { sharedSkills: true });
  assert.equal(shared.run(['init', '--yes', '--remote', '', '--schedule', 'session']).status, 0);
  assert.equal(fs.readdirSync(path.join(shared.home, '.agents', 'skills')).join(), 'ghostpen');
  const solo = fakeHome(t);
  const result = solo.run(['init', '--yes', '--agents', 'claude', '--instructions', 'each', '--remote', '', '--schedule', 'session', '--store', path.join(solo.home, 'my voice')]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(solo.home, '.claude', 'CLAUDE.md'), 'utf8'), /ghostpen:start[\s\S]*my voice\/VOICE\.md/);
  assert.equal(fs.existsSync(path.join(solo.home, '.codex', 'hooks.json')), false);
  assert.equal(fs.existsSync(path.join(solo.home, '.agents', 'skills', 'ghostpen')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(solo.notes, 'NOTES.md'), 'utf8'), /ghostpen:start/);
});

test('a proposal changes the guide only when accepted, is announced at session start, and goes stale if the guide moved', t => {
  const h = fakeHome(t);
  assert.equal(h.run(['init', '--yes', '--remote', '', '--schedule', 'session']).status, 0);
  const store = path.join(h.home, '.ghostpen', 'voice'), guide = path.join(store, 'VOICE.md');
  const draft = path.join(h.home, 'new.md'); fs.writeFileSync(draft, '# Voice\n\n## Core\n\n- Lead with the consequence. (3 edits, pr-comment)\n');
  const added = h.run(['proposals', 'add', '--summary', 'Lead with the consequence.', '--guide', draft]);
  assert.equal(added.status, 0, added.stderr);
  const id = JSON.parse(added.stdout).id;
  assert.doesNotMatch(fs.readFileSync(guide, 'utf8'), /Lead with the consequence/);
  assert.match(h.run(['hook', 'session-start']).stdout, /1 proposed change to the user's voice guide is waiting/);
  assert.equal(h.run(['proposals', 'accept', id.slice(0, 8)]).status, 0);
  assert.match(fs.readFileSync(guide, 'utf8'), /Lead with the consequence/);
  assert.match(execFileSync('git', ['-C', store, 'log', '--oneline'], { encoding: 'utf8' }), /Update voice guide: Lead with the consequence/);
  fs.writeFileSync(draft, '# Voice\n\n## Core\n\n- Another rule.\n');
  const second = JSON.parse(h.run(['proposals', 'add', '--summary', 'Another rule.', '--guide', draft]).stdout).id;
  fs.appendFileSync(guide, '\n- A rule I typed myself.\n');
  const stale = h.run(['proposals', 'accept', second]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /has changed since this proposal was written/);
  assert.equal(h.run(['proposals', 'reject', second]).status, 0);
  assert.match(fs.readFileSync(guide, 'utf8'), /A rule I typed myself/);
});

test('a schedule that cannot be set up falls back without losing the install; Paseo is given the chosen agent and a short prompt', t => {
  const h = fakeHome(t);
  const bin = path.join(h.home, 'bin'), calls = path.join(h.home, 'paseo-calls.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'paseo'), `#!/bin/sh
printf '%s\\n' "$*" >> ${calls}
case "$1 $2" in
  "--version "*) exit 0 ;;
  "provider ls") echo '[{"provider":"claude","label":"Claude","status":"available"},{"provider":"other","label":"Other","status":"unavailable"}]' ;;
  "schedule create") case "$*" in *"--provider claude"*) echo '{"id":"sch_1"}' ;; *) echo '{"error":{"message":"Provider is required"}}'; exit 1 ;; esac ;;
  "schedule delete") exit 0 ;;
esac
`, { mode: 0o755 });
  const withPaseo = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: h.home, GHOSTPEN_HOME: h.home,
    GHOSTPEN_CONFIG_DIR: path.join(h.home, '.config'), GHOSTPEN_DATA_DIR: path.join(h.home, '.local', 'share', 'ghostpen'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' } });
  const config = () => JSON.parse(fs.readFileSync(path.join(h.home, '.config', 'ghostpen', 'config.json'), 'utf8'));

  const missing = withPaseo(['init', '--yes', '--remote', '', '--schedule', 'paseo']);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /Could not set up "Paseo schedule, daily": a Paseo schedule needs an agent to run as/);
  assert.doesNotMatch(missing.stdout + missing.stderr, /Distil: turn edits into voice rules/);
  assert.equal(config().schedule.id, 'session');
  assert.equal(withPaseo(['doctor']).status, 0);

  const chosen = withPaseo(['init', '--yes', '--remote', '', '--schedule', 'paseo', '--provider', 'claude']);
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.deepEqual(config().schedule, { id: 'paseo', state: { id: 'sch_1' } });
  const created = fs.readFileSync(calls, 'utf8').split('\n').filter(line => line.startsWith('schedule create')).at(-1);
  assert.match(created, /--provider claude --json Update my voice guide from recent edits: run .* distil --print/);
  assert.ok(created.length < 600);
  assert.equal(withPaseo(['uninstall']).status, 0);
  assert.match(fs.readFileSync(calls, 'utf8'), /schedule delete sch_1/);
});
