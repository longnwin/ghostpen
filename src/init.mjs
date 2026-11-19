import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, homeDir, quote } from './paths.mjs';
import { readConfig, writeConfig, configPath } from './config.mjs';
import { createStore, storeAt } from './store.mjs';
import { hasHook, installHook, installSkill, knownAgents, removeHook, removeSkill } from './agents.mjs';
import { addVoiceLine, instructionHomes, removeVoiceLine } from './instructions.mjs';
import { schedulerById, schedulers } from './schedulers.mjs';

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
  return { app, command: `${quote(process.execPath)} ${quote(path.join(app, 'src', 'cli.mjs'))}` };
}

export const distilPrompt = (/** @type {string} */ app, /** @type {string} */ command) =>
  `Update my voice guide from recent edits. Follow these instructions exactly:\n\n${fs.readFileSync(path.join(app, 'docs', 'distil.md'), 'utf8').replaceAll('{{GHOSTPEN}}', command)}`;

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

  // 4. Skill and hook for each agent.
  const { app, command } = installApp();
  const wired = [];
  for (const agent of agents) {
    const skill = installSkill(agent.skillsDir, path.join(app, 'skill', 'ghostpen'), command);
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

  // 6. How distilling runs.
  if (previous.schedule && typeof previous.schedule === 'object') { const old = /** @type {{id: string, state: Record<string, string>}} */ (previous.schedule); try { schedulerById(old.id).remove(old.state || {}); } catch { /* already gone */ } }
  const options = schedulers.filter(item => item.available());
  const scheduleId = await ask({ id: 'schedule', text: 'How should voice updates be prepared? They are always proposed for your approval, never applied on their own.',
    choices: options.map(item => ({ value: item.id, label: `${item.label}. ${item.note}` })), fallback: 'session' });
  // Everything above is recorded first, so a schedule that fails to set up never leaves an install that doctor and uninstall cannot see.
  writeConfig({ store: store.root, app, command, agents: wired, instructions, schedule: { id: 'session', state: {} } });
  let schedule = { id: scheduleId, state: /** @type {Record<string, string>} */ ({}) };
  try {
    schedule.state = await schedulerById(scheduleId).install({ command, store: store.root, ask,
      prompt: `Update my voice guide from recent edits: run \`${command} distil --print\` and follow the instructions it prints exactly. Do not publish, post or push anything.` });
  } catch (error) {
    log(`Could not set up "${schedulerById(scheduleId).label}": ${/** @type {Error} */ (error).message}. Using "ask me at the start of a session" for now; run init again to change it.`);
    schedule = { id: 'session', state: {} };
  }
  log(`Schedule: ${schedulerById(schedule.id).label}.`);

  writeConfig({ schedule });
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
  checks.push({ ok: fs.existsSync(path.join(config.app || '', 'src', 'cli.mjs')), item: 'ghostpen command', detail: config.command || '' });
  checks.push({ ok: Boolean(config.schedule?.id), item: 'Schedule', detail: config.schedule?.id || 'none' });
  return checks;
}

/** Removes everything init wired up. The voice store itself is kept. */
export function uninstall() {
  const config = /** @type {any} */ (readConfig());
  for (const agent of config.agents || []) { removeSkill(agent.skill); removeHook(agent.hooksFile); }
  for (const file of config.instructions || []) removeVoiceLine(file);
  if (config.schedule?.id) { try { schedulerById(config.schedule.id).remove(config.schedule.state || {}); } catch { /* already gone */ } }
  if (config.app && config.app.startsWith(dataDir())) fs.rmSync(config.app, { recursive: true, force: true });
  fs.rmSync(configPath(), { force: true });
  return { kept: config.store || null };
}
