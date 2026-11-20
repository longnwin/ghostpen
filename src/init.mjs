import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { binDir, dataDir, homeDir, quote } from './paths.mjs';
import { readConfig, writeConfig, configPath } from './config.mjs';
import { createStore, storeAt } from './store.mjs';
import { hasHook, installHook, installSkill, knownAgents, removeHook, removeSkill } from './agents.mjs';
import { addVoiceLine, instructionHomes, removeVoiceLine } from './instructions.mjs';
import { schedulerById, schedulers } from './schedulers.mjs';
import { clearPending, hasStep, refreshStep, removeStep } from './integrate.mjs';
import { collectSamples } from './seed.mjs';
import { ghRunner } from './sources/github.mjs';
import { describe, lastSync, remoteState, sync } from './sync.mjs';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

/**
 * One question to the user. `choices` makes it a pick-one (or pick-many with `many`); otherwise free text.
 * @typedef {(question: {id: string, text: string, choices?: {value: string, label: string}[], many?: boolean, allowText?: boolean, fallback: string}) => Promise<string>} Ask
 */

/** Copies ghostpen somewhere that outlives `npx`, so hooks, skills and schedules have a stable command to call. */
function installApp() {
  const app = path.join(dataDir(), 'app');
  if (path.resolve(PACKAGE) !== app) {
    fs.rmSync(app, { recursive: true, force: true });
    for (const item of ['src', 'skill', 'docs', 'package.json']) fs.cpSync(path.join(PACKAGE, item), path.join(app, item), { recursive: true });
  }
  // A launcher with a fixed name, so nothing written into skills, hooks or schedules names a Node version or a long path.
  // It prefers whatever `node` is on the PATH and falls back to the one that ran init, for environments with a bare PATH.
  const launcher = path.join(binDir(), 'ghostpen');
  if (fs.existsSync(launcher) && !fs.readFileSync(launcher, 'utf8').includes(LAUNCHER_MARK)) throw new Error(`${launcher} already exists and was not installed by ghostpen. Move it aside and run init again.`);
  fs.mkdirSync(binDir(), { recursive: true });
  fs.writeFileSync(launcher, `#!/bin/sh\n${LAUNCHER_MARK}\nAPP=${quote(path.join(app, 'src', 'cli.mjs'))}\nif command -v node >/dev/null 2>&1; then exec node "$APP" "$@"; fi\nexec ${quote(process.execPath)} "$APP" "$@"\n`, { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  // In text that may be shared between machines, name it relative to the home folder; a shell expands the tilde.
  const relative = path.relative(homeDir(), launcher);
  const say = !relative.startsWith('..') && /^[\w./-]+$/.test(relative) ? `~/${relative}` : quote(launcher);
  return { app, launcher, command: quote(launcher), say, onPath: (process.env.PATH || '').split(path.delimiter).includes(binDir()) };
}
const LAUNCHER_MARK = '# Installed by ghostpen init. Removed by ghostpen uninstall.';

const LEADS = { distil: 'Update my voice guide from recent edits.', seed: 'Build my first voice guide from my past writing.', integrate: 'Find where my own skills write text for me, and propose adding the voice step there.' };
/** The instructions for one agent-run job, with this machine's ghostpen command filled in. @param {string} app @param {string} command @param {string} job */
export const instructionsPrompt = (app, command, job) =>
  `${LEADS[/** @type {keyof typeof LEADS} */ (job)]} Follow these instructions exactly:\n\n${fs.readFileSync(path.join(app, 'docs', `${job}.md`), 'utf8').replaceAll('{{GHOSTPEN}}', command)}`;
export const distilPrompt = (/** @type {string} */ app, /** @type {string} */ command) => instructionsPrompt(app, command, 'distil');

/** @param {{ask: Ask, from?: string, log?: (line: string) => void}} options */
export async function init({ ask, from, log = console.log }) {
  const previous = readConfig();
  const manual = [];

  // 1. Which agents to wire.
  const found = knownAgents().filter(agent => agent.present);
  if (!found.length) throw new Error('No supported coding agent was found (looked for Claude Code and Codex).');
  const chosenIds = (await ask({ id: 'agents', text: 'Which agents should write in your voice?', many: true, fallback: found.map(a => a.id).join(','),
    choices: found.map(agent => ({ value: agent.id, label: `${agent.name} (skills in ${agent.skillsDir})` })) })).split(',').map(id => id.trim()).filter(Boolean);
  const agents = found.filter(agent => chosenIds.includes(agent.id));
  if (!agents.length) throw new Error('No agent was selected.');

  // 2. The voice store: clone an existing one, or create it.
  const root = path.resolve((await ask({ id: 'store', text: 'Where should your voice live on this machine?', fallback: String(previous.store || path.join(homeDir(), '.ghostpen', 'voice')) })).replace(/^~(?=\/)/, homeDir()));
  if (from && !fs.existsSync(path.join(root, 'ghostpen.json'))) execFileSync('git', ['clone', '-q', from, root], { stdio: ['ignore', 'ignore', 'inherit'] });
  const store = createStore(root);
  log(`Voice store: ${store.root}`);

  // 3. A private remote, only on an explicit yes.
  const hasRemote = spawnSync('git', ['-C', store.root, 'remote', 'get-url', 'origin'], { stdio: 'ignore' }).status === 0;
  if (!hasRemote && spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0) {
    const name = (await ask({ id: 'remote', text: 'Create a private GitHub repository for it, so other machines can use the same voice? Type a repository name, or leave empty to skip.', fallback: '' })).trim();
    if (name) { execFileSync('gh', ['repo', 'create', name, '--private', '--source', store.root, '--push'], { stdio: ['ignore', 'ignore', 'inherit'] }); log(`Created private repository ${name}.`); }
  }

  // 3b. Keeping it the same across machines. Sending evidence to the remote is a choice, never a default.
  let syncMode = 'off';
  if (spawnSync('git', ['-C', store.root, 'remote', 'get-url', 'origin'], { stdio: 'ignore' }).status === 0) {
    syncMode = await ask({ id: 'sync', text: 'Keep this voice store in step with your other machines automatically? It pulls when a session starts and pushes after each change. Only the guide, sanitized evidence and proposals are in the repository; raw drafts never leave this machine.',
      choices: [{ value: 'auto', label: 'Yes, sync automatically' }, { value: 'off', label: 'No, I will run `ghostpen sync` myself' }], fallback: previous.sync === 'auto' ? 'auto' : 'off' });
    if (syncMode !== 'auto') syncMode = 'off';
    if (syncMode === 'auto') { const result = sync(store); log(describe(store, result)); }
  }

  // 4. Skill and hook for each agent.
  const { app, launcher, command, say, onPath } = installApp();
  log(`Command: ${launcher}${onPath ? '' : ` (add ${binDir()} to your PATH to type just "ghostpen")`}`);
  for (const file of /** @type {string[]} */ (Array.isArray(previous.integrations) ? previous.integrations : [])) refreshStep(file, say);
  const wired = [];
  for (const agent of agents) {
    const skill = installSkill(agent.skillsDir, path.join(app, 'skill', 'ghostpen'), say);
    installHook(agent.hooksFile, command);
    if (agent.hooksNote) manual.push(agent.hooksNote);
    wired.push({ id: agent.id, name: agent.name, skill, hooksFile: agent.hooksFile });
    log(`${agent.name}: skill and session hook installed.`);
  }

  // 5. The instruction line, in the best place that every session already loads.
  const homes = instructionHomes(agents);
  let instructions = /** @type {string[]} */ (Array.isArray(previous.instructions) ? previous.instructions : []);
  if (homes.present.length) { instructions = homes.present; log(`Voice line already present in ${homes.present.join(', ')}.`); }
  else {
    const choices = [
      ...homes.shared.map(file => ({ value: file, label: `${file} (already loaded by every selected agent)` })),
      { value: 'each', label: `Each agent's own instructions file (${homes.perAgent.join(', ')})` },
      { value: 'none', label: 'Nowhere; rely on the session hook and the skill' },
    ];
    const choice = await ask({ id: 'instructions', text: 'Where should the "read my voice guide" line go?', choices, fallback: choices[0].value });
    const files = choice === 'none' ? [] : choice === 'each' ? homes.perAgent : [choice];
    instructions = files.map(file => addVoiceLine(file, store.guide).file);
    if (files.length) log(`Voice line added to ${files.join(', ')}.`);
  }

  // 6. How distilling runs. Running setup again keeps the schedule already in place unless another is chosen.
  const old = previous.schedule && typeof previous.schedule === 'object' ? /** @type {{id: string, state: Record<string, string>}} */ (previous.schedule) : null;
  const options = schedulers.filter(item => item.available());
  const scheduleId = await ask({ id: 'schedule', text: 'How should voice updates be prepared? They are always proposed for your approval, never applied on their own.',
    choices: options.map(item => ({ value: item.id, label: `${item.label}. ${item.note}` })), fallback: old && options.some(item => item.id === old.id) ? old.id : 'session' });
  // A scheduler may ask the same thing while checking what is in place and again while setting up; ask the user once.
  const answers = new Map();
  /** @type {Ask} */
  const askOnce = async question => { if (!answers.has(question.id)) answers.set(question.id, await ask(question)); return answers.get(question.id); };
  /** @type {Record<string, string> | null} */
  let kept = null;
  if (old && old.id === scheduleId) { try { kept = await schedulerById(scheduleId).current?.(old.state || {}, { ask: askOnce }) ?? null; } catch { kept = null; } }
  if (!kept && old) { try { schedulerById(old.id).remove(old.state || {}); } catch { /* already gone */ } }
  // Everything above is recorded first, so a schedule that fails to set up never leaves an install that doctor and uninstall cannot see.
  writeConfig({ store: store.root, app, launcher, command, say, agents: wired, instructions, sync: syncMode, schedule: kept ? { id: scheduleId, state: kept } : { id: 'session', state: {} } });
  let schedule = { id: scheduleId, state: kept || /** @type {Record<string, string>} */ ({}) };
  if (!kept) {
    try {
      schedule.state = await schedulerById(scheduleId).install({ command, store: store.root, ask: askOnce, previous: old && old.id === scheduleId ? old.state : undefined,
        prompt: `Update my voice guide from recent edits: run \`${say} distil --print\` and follow the instructions it prints exactly. Do not publish, post or push anything.` });
    } catch (error) {
      log(`Could not set up "${schedulerById(scheduleId).label}": ${/** @type {Error} */ (error).message}. Using "ask me at the start of a session" for now; run init again to change it.`);
      schedule = { id: 'session', state: {} };
    }
  }
  log(`Schedule: ${schedulerById(schedule.id).label}.`);

  writeConfig({ schedule });

  // 7. A first guide from past writing. Collecting is plain code; turning samples into rules needs the user's agent.
  const guideIsEmpty = fs.readFileSync(store.guide, 'utf8').includes('_No rules yet.');
  if (guideIsEmpty && spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0) {
    const scope = (await ask({ id: 'seed', text: 'Build a first guide from what you have already written on GitHub (review comments and PR descriptions)? Text written by agents is skipped, and samples stay on this machine.',
      choices: [{ value: 'all', label: 'Yes, from everything I have written' }, { value: 'none', label: 'No, start empty and learn from my edits' }], allowText: true, fallback: 'none' })).trim();
    if (scope && scope !== 'none') {
      const before = (await ask({ id: 'seed-before', text: 'Only use writing from before a date? Useful if agents have drafted for you recently. Type YYYY-MM-DD, or leave empty for no cutoff.', fallback: '' })).trim();
      try {
        const result = await collectSamples(store, { run: ghRunner(), repos: scope === 'all' ? [] : scope.split(',').map(r => r.trim()).filter(Boolean), before: before || undefined });
        writeConfig({ seed: 'collected' });
        log(`Collected ${result.saved['pr-comment']} review comments and ${result.saved['pr-description']} PR descriptions. Your agent will offer to build the guide from them at the start of your next session, or run \`${say} seed --run\` now.`);
      } catch (error) { log(`Could not collect past writing: ${/** @type {Error} */ (error).message}. You can try again with \`${say} seed collect\`.`); }
    }
  }

  // 8. The user's own skills that write for them.
  const wantsIntegrate = await ask({ id: 'integrate', text: 'Look through your own skills for places that write text for you, and propose adding the voice step there? Nothing is changed without your approval.',
    choices: [{ value: 'yes', label: 'Yes, at the start of my next session' }, { value: 'no', label: 'No' }], fallback: 'no' });
  if (wantsIntegrate === 'yes') { writeConfig({ integrate: 'wanted' }); log('Your agent will offer to check your skills at the start of your next session.'); }

  return { store: store.root, agents: wired, instructions, schedule: schedule.id, manual };
}

/** Checks that everything init set up is still in place. */
export function doctor() {
  const config = /** @type {any} */ (readConfig());
  if (!config.store) return [{ ok: false, item: 'Setup', detail: 'ghostpen has not been set up on this machine. Run `ghostpen init`.' }];
  const checks = [{ ok: fs.existsSync(storeAt(config.store).guide), item: 'Voice guide', detail: storeAt(config.store).guide }];
  for (const agent of config.agents || []) {
    checks.push({ ok: fs.existsSync(path.join(agent.skill, 'SKILL.md')), item: `${agent.name} skill`, detail: agent.skill });
    checks.push({ ok: hasHook(agent.hooksFile), item: `${agent.name} session hook`, detail: agent.hooksFile });
  }
  for (const file of config.instructions || []) checks.push({ ok: (() => { try { return fs.readFileSync(file, 'utf8').includes('ghostpen:start'); } catch { return false; } })(), item: 'Voice line', detail: file });
  for (const file of config.integrations || []) checks.push({ ok: hasStep(file), item: 'Voice step in skill', detail: file });
  checks.push({ ok: fs.existsSync(path.join(config.app || '', 'src', 'cli.mjs')) && fs.existsSync(config.launcher || ''), item: 'ghostpen command', detail: config.launcher || config.command || '' });
  checks.push({ ok: Boolean(config.schedule?.id), item: 'Schedule', detail: config.schedule?.id || 'none' });
  const voice = storeAt(config.store), { remote, ahead, behind } = remoteState(voice), last = lastSync(voice);
  const stuck = config.sync === 'auto' && (last?.status === 'conflict' || last?.status === 'dirty');
  checks.push({ ok: !stuck, item: 'Sync', detail: !remote ? 'no remote; this store lives on this machine only'
    : stuck && last ? describe(voice, last)
    : `${config.sync === 'auto' ? 'automatic' : 'manual (run `ghostpen sync`)'}; ${ahead} not sent, ${behind} not received as of the last check${last ? `; last sync ${last.status} at ${last.at}` : ''}` });
  return checks;
}

/** Removes everything init wired up. The voice store itself is kept. */
export function uninstall() {
  const config = /** @type {any} */ (readConfig());
  for (const agent of config.agents || []) { removeSkill(agent.skill); removeHook(agent.hooksFile); }
  for (const file of config.instructions || []) removeVoiceLine(file);
  for (const file of config.integrations || []) removeStep(file);
  clearPending();
  if (config.schedule?.id) { try { schedulerById(config.schedule.id).remove(config.schedule.state || {}); } catch { /* already gone */ } }
  if (config.app && config.app.startsWith(dataDir())) fs.rmSync(config.app, { recursive: true, force: true });
  if (config.launcher && fs.existsSync(config.launcher) && fs.readFileSync(config.launcher, 'utf8').includes(LAUNCHER_MARK)) fs.rmSync(config.launcher);
  fs.rmSync(configPath(), { force: true });
  return { kept: config.store || null };
}
