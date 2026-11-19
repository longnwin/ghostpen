#!/usr/bin/env node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readConfig, writeConfig } from './config.mjs';
import { commit, createStore, storeAt } from './store.mjs';
import { RECORD_VERSION, addPair, drafts, evidence, logDraft, pairs, removePair, samples, saveEvidence } from './records.mjs';
import fsp from 'node:path';
import { collectSamples } from './seed.mjs';
import { apply, candidates, dismiss, pending, preview, propose } from './integrate.mjs';
import { similarity } from './match.mjs';
import { leakedSpecifics } from './leaks.mjs';
import { matchGitHub } from './capture.mjs';
import { ghRunner } from './sources/github.mjs';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { addProposal, acceptProposal, proposals, rejectProposal } from './proposals.mjs';
import { distilPrompt, doctor, init, instructionsPrompt, uninstall } from './init.mjs';

const [command, ...args] = process.argv.slice(2);
const flag = (/** @type {string} */ name) => args.includes(`--${name}`);
const option = (/** @type {string} */ name) => flag(name) ? args[args.indexOf(`--${name}`) + 1] : undefined;
const required = (/** @type {string} */ name) => option(name) ?? (() => { throw new Error(`Missing --${name}`); })();
const readText = (/** @type {string} */ file) => fs.readFileSync(file === '-' ? 0 : file, 'utf8');
const print = (/** @type {unknown} */ value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const store = () => {
  const root = option('store') || process.env.GHOSTPEN_STORE || readConfig().store;
  if (!root) throw new Error('No voice store is set up on this machine. Run `ghostpen init` first.');
  return storeAt(root);
};

/** Runs one set of instructions with the user's own agent, headlessly, in the voice store. */
const runAgent = (/** @type {any} */ config, /** @type {string} */ prompt) => {
  const agent = (config.agents || [])[0]?.id;
  const run = agent === 'codex' ? spawnSync('codex', ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', store().root, prompt], { stdio: 'inherit' })
    : spawnSync('claude', ['-p', prompt, '--allowedTools', 'Read,Write,Bash'], { stdio: 'inherit', cwd: store().root });
  return run.status ?? 1;
};

/** Applies one proposed skill change and records it, so doctor and uninstall know about it. */
const applyOne = (/** @type {string} */ id) => {
  const config = /** @type {any} */ (readConfig());
  const file = apply(id, said(config));
  writeConfig({ integrations: [...new Set([...(config.integrations || []), file])], integrate: 'done' });
  return file;
};
/** Walks the user through each waiting skill change. Without a terminal it only lists them. */
async function decide(/** @type {any} */ config) {
  const list = pending();
  if (!list.length) return print('No skill changes are waiting.');
  if (!process.stdin.isTTY) return print(`${list.map(item => preview(item, said(config))).join('\n\n')}\n\n${list.length} skill change${list.length === 1 ? ' is' : 's are'} waiting. Run \`ghostpen integrate decide\` in a terminal, or apply one with \`ghostpen integrate apply <id>\`.`);
  const io = readline.createInterface({ input: process.stdin, output: process.stdout });
  const changed = [];
  try {
    for (const [index, item] of list.entries()) {
      console.log(`\n(${index + 1} of ${list.length})\n${preview(item, said(config))}`);
      const answer = (await io.question('Add this step? [y] yes  [n] no, discard  [s] skip for now > ')).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') changed.push(applyOne(item.id));
      else if (answer === 'n' || answer === 'no') dismiss(item.id);
    }
  } finally { io.close(); }
  writeConfig({ integrate: 'done' });
  console.log(changed.length ? `\nChanged, not committed:\n${changed.map(file => `  ${file}`).join('\n')}` : '\nNo files were changed.');
}

/** The command as it should appear in text an agent reads. */
const said = (/** @type {any} */ config) => config.say || config.command;

const HELP = `ghostpen — teaches your coding agents to write like you.

  ghostpen store create <folder>     Create a voice store, or adopt the one in <folder>
  ghostpen guide                     Print where the voice guide lives
  ghostpen draft --kind <kind> --file <path|-> [--target <url>] [--path <file> --line <n>]
                                     Log what an agent drafted on your behalf
  ghostpen record --kind <kind> --before <path> --after <path> [--source <url>]
                                     Record a draft and what you actually published
  ghostpen match                     Pair logged drafts with what you published on GitHub
  ghostpen pairs                     List raw pairs waiting to be sanitized (local only)
  ghostpen evidence add --pair <id> --before <path> --after <path>
                                     Save the sanitized version of a pair into the store
  ghostpen evidence list             Print all sanitized evidence
  ghostpen evidence add-sample --sample <id> --text <path>
                                     Save the sanitized version of one writing sample
  ghostpen seed collect [--repo <owner/repo,...>] [--before <YYYY-MM-DD>]
                                     Gather your own past writing from GitHub (stays on this machine)
  ghostpen seed [samples | --print | --run]
                                     List the samples, or print / run the steps that turn them into a first guide
  ghostpen integrate [candidates | review | decide | apply <id> | dismiss <id> | --print | --run]
                                     Add the voice step to your own skills that write text for you
  ghostpen integrate propose --file <path> --after-line <n> --kind <kind> --note <text>
  ghostpen distil [--print | --run]  Print the distil instructions, or run them with your agent headlessly
  ghostpen proposals [show <id> | accept <id> | reject <id>]
                                     Review proposed changes to your voice guide
  ghostpen proposals add --summary <text> --guide <path> [--evidence <ids>]
  ghostpen status                    Counts of drafts, pairs and evidence
  ghostpen init [--from <git url>] [--yes]   Set up ghostpen on this machine
  ghostpen doctor                    Check that everything init set up is still in place
  ghostpen uninstall                 Remove what init wired up; your voice store is kept
`;

try {
  if (command === 'store' && args[0] === 'create') {
    const created = createStore(args[1] ?? (() => { throw new Error('Give the folder for the voice store.'); })());
    writeConfig({ store: created.root }); print({ store: created.root, guide: created.guide });
  } else if (command === 'guide') {
    print(store().guide);
  } else if (command === 'draft') {
    const line = option('line');
    const draft = logDraft(store(), { kind: required('kind'), body: readText(required('file')), target: option('target'), path: option('path'), line: line ? Number(line) : undefined });
    print({ id: draft.id });
  } else if (command === 'record') {
    const before = readText(required('before')), after = readText(required('after'));
    print({ id: addPair(store(), { kind: required('kind'), before, after, source: option('source'), similarity: Number(similarity(before, after).toFixed(3)) }).id });
  } else if (command === 'match') {
    print(await matchGitHub(store(), { run: ghRunner() }));
  } else if (command === 'pairs') {
    print(pairs(store()));
  } else if (command === 'evidence' && args[0] === 'add') {
    const target = store(), pair = pairs(target).find(item => item.id === required('pair'));
    if (!pair) throw new Error('No waiting pair has that id.');
    const before = readText(required('before')).trim(), after = readText(required('after')).trim();
    const leaks = leakedSpecifics([pair.before, pair.after], [before, after]);
    if (leaks.length && !flag('allow-specifics')) throw new Error(`The sanitized text still contains specifics from the original: ${leaks.slice(0, 12).join(', ')}. Rewrite them, or pass --allow-specifics if they are generic.`);
    saveEvidence(target, { id: randomUUID(), version: RECORD_VERSION, kind: pair.kind, before, after, source: pair.source, similarity: pair.similarity, recordedAt: new Date().toISOString() });
    removePair(target, pair.id); commit(target, `Add ${pair.kind} evidence`);
    print({ saved: true });
  } else if (command === 'evidence' && args[0] === 'add-sample') {
    const target = store(), sample = samples(target).find(item => item.id === required('sample'));
    if (!sample) throw new Error('No sample has that id.');
    const text = readText(required('text')).trim();
    const leaks = leakedSpecifics([sample.body], [text]);
    if (leaks.length && !flag('allow-specifics')) throw new Error(`The sanitized text still contains specifics from the original: ${leaks.slice(0, 12).join(', ')}. Rewrite them, or pass --allow-specifics if they are generic.`);
    const saved = saveEvidence(target, { id: randomUUID(), version: RECORD_VERSION, kind: sample.kind, before: '', after: text, source: sample.source, similarity: 0, recordedAt: new Date().toISOString(), origin: 'sample' });
    commit(target, `Add ${sample.kind} sample evidence`);
    print({ id: saved.id });
  } else if (command === 'seed' && args[0] === 'collect') {
    const result = await collectSamples(store(), { run: ghRunner(), repos: (option('repo') || '').split(',').map(r => r.trim()).filter(Boolean), before: option('before') });
    writeConfig({ seed: 'collected' }); print(result);
  } else if (command === 'seed' && args[0] === 'samples') {
    print(samples(store()));
  } else if (command === 'seed' || (command === 'integrate' && (!args[0] || args[0].startsWith('--')))) {
    const config = /** @type {any} */ (readConfig());
    if (!config.app) throw new Error('Run `ghostpen init` first.');
    const prompt = instructionsPrompt(config.app, said(config), command);
    if (!flag('run')) print(prompt);
    else {
      // A headless agent cannot wait for an answer, so it only finds and proposes; the questions are asked here.
      process.exitCode = runAgent(config, `${prompt}\n\nThis is an unattended run: nobody can answer questions. Do not ask anything. Finish every step that needs no answer, then stop.`);
      if (command === 'integrate') await decide(config);
    }
  } else if (command === 'integrate' && args[0] === 'decide') {
    await decide(/** @type {any} */ (readConfig()));
  } else if (command === 'integrate') {
    const config = /** @type {any} */ (readConfig());
    if (!config.command) throw new Error('Run `ghostpen init` first.');
    const dirs = (config.agents || []).map((/** @type {{skill: string}} */ agent) => fsp.dirname(agent.skill));
    if (args[0] === 'candidates') print(candidates(dirs));
    else if (args[0] === 'propose') print(propose({ file: required('file'), afterLine: Number(required('after-line')), kind: required('kind'), note: required('note') }, dirs));
    else if (args[0] === 'review') { const list = pending(); print(list.length ? list.map(item => preview(item, said(config))).join('\n\n') : 'No integrations are waiting.'); }
    else if (args[0] === 'apply') print(`Added the voice step to ${applyOne(args[1] || '')}. The change is not committed.`);
    else if (args[0] === 'dismiss') { dismiss(args[1] || ''); print('Dismissed.'); }
    else throw new Error('Use: ghostpen integrate [candidates | propose | review | decide | apply <id> | dismiss <id> | --print | --run]');
  } else if (command === 'evidence' && args[0] === 'list') {
    print(evidence(store()));
  } else if (command === 'init') {
    const scripted = flag('yes') || !process.stdin.isTTY;
    const io = scripted ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
    /** @type {import('./init.mjs').Ask} */
    const ask = async question => {
      const preset = option(question.id);
      if (preset !== undefined) return preset;
      if (!io) return question.fallback;
      console.log(`\n${question.text}`);
      (question.choices || []).forEach((choice, index) => console.log(`  ${index + 1}. ${choice.label}`));
      const fallbackIndex = (question.choices || []).findIndex(choice => choice.value === question.fallback);
      const hint = question.choices ? (question.many ? 'numbers separated by commas, Enter for all' : fallbackIndex >= 0 ? `number, Enter for ${fallbackIndex + 1}` : question.allowText ? 'number, or type it' : 'number')
        : (question.fallback ? `Enter for ${question.fallback}` : 'Enter to skip');
      const answer = (await io.question(`(${hint}) > `)).trim();
      if (!answer) return question.fallback;
      if (!question.choices) return answer;
      if (question.allowText && !/^[\d,\s]+$/.test(answer)) return answer;
      const picked = answer.split(',').map(part => question.choices?.[Number(part.trim()) - 1]?.value).filter(Boolean);
      if (!picked.length) throw new Error('That is not one of the options.');
      return question.many ? picked.join(',') : String(picked[0]);
    };
    try {
      const result = await init({ ask, from: option('from') });
      console.log('\nghostpen is set up. New agent sessions will read your voice guide and log what they draft for you.');
      for (const step of result.manual) console.log(`\nOne step left for you: ${step}`);
    } finally { io?.close(); }
  } else if (command === 'doctor') {
    const checks = doctor();
    for (const check of checks) console.log(`${check.ok ? 'ok     ' : 'MISSING'}  ${check.item}: ${check.detail}`);
    if (checks.some(check => !check.ok)) process.exitCode = 1;
  } else if (command === 'uninstall') {
    const { kept } = uninstall();
    print(kept ? `Removed ghostpen's skill, hooks, voice line and schedule. Your voice store is untouched at ${kept}.` : 'ghostpen was not set up on this machine.');
  } else if (command === 'distil') {
    const config = /** @type {any} */ (readConfig());
    if (!config.app) throw new Error('Run `ghostpen init` first.');
    const prompt = distilPrompt(config.app, said(config));
    if (!flag('run')) print(prompt); else process.exitCode = runAgent(config, prompt);
  } else if (command === 'proposals') {
    const target = store();
    if (args[0] === 'add') print({ id: addProposal(target, { summary: required('summary'), guide: readText(required('guide')), evidence: (option('evidence') || '').split(',').map(id => id.trim()).filter(Boolean) }).id });
    else if (args[0] === 'accept') print(`Voice guide updated: ${acceptProposal(target, args[1] || '').summary}`);
    else if (args[0] === 'reject') print(`Rejected: ${rejectProposal(target, args[1] || '').summary}`);
    else if (args[0] === 'show') { const found = proposals(target).filter(item => item.id.startsWith(args[1] || ' ')); if (found.length !== 1) throw new Error('No single proposal has that id.'); print(`${found[0].summary}\n\n--- proposed guide ---\n${found[0].guide}`); }
    else print(proposals(target).map(item => ({ id: item.id.slice(0, 8), createdAt: item.createdAt, summary: item.summary })));
  } else if (command === 'hook' && args[0] === 'session-start') {
    // Runs at the start of every session, so it must be quick and must never fail the session.
    try {
      const target = store(), waiting = proposals(target).length, raw = pairs(target).length, config = /** @type {any} */ (readConfig());
      const lines = [`ghostpen: before writing anything that will be posted or sent under the user's name, read ${target.guide} and follow it, and log the draft as the ghostpen skill describes.`];
      if (waiting) lines.push(`${waiting} proposed change${waiting === 1 ? '' : 's'} to the user's voice guide ${waiting === 1 ? 'is' : 'are'} waiting. Early in this session, ask the user whether to review ${waiting === 1 ? 'it' : 'them'} (\`${said(config)} proposals\`).`);
      const seeded = evidence(target).some(item => item.origin === 'sample'), sampleCount = seeded || waiting ? 0 : samples(target).length;
      if (sampleCount) lines.push(`${sampleCount} samples of the user's past writing are ready. Early in this session, ask the user whether to build their first voice guide from them now (\`${said(config)} seed --print\` gives the steps).`);
      if (config.integrate === 'wanted') lines.push(`The user asked to have their own skills checked for places that write text for them. Early in this session, ask whether to do that now (\`${said(config)} integrate --print\` gives the steps).`);
      if (pending().length) lines.push(`${pending().length} proposed skill change${pending().length === 1 ? ' is' : 's are'} waiting for the user's decision (\`${said(config)} integrate review\`).`);
      if (waiting) { /* said above */ }
      else if (raw >= 5 && config.schedule?.id === 'session') lines.push(`${raw} of the user's edits have not been learned from yet. Early in this session, ask the user whether to update their voice guide now (\`${said(config)} distil --print\` gives the steps).`);
      console.log(lines.join('\n'));
    } catch { /* not set up, or store missing: say nothing */ }
  } else if (command === 'status') {
    const target = store(), all = drafts(target);
    print({ store: target.root, drafts: { open: all.filter(d => d.status === 'open').length, paired: all.filter(d => d.status === 'paired').length, unposted: all.filter(d => d.status === 'unposted').length },
      pairsWaiting: pairs(target).length, evidence: evidence(target).length });
  } else { print(HELP); if (command && command !== 'help') process.exitCode = 1; }
} catch (error) { console.error(/** @type {Error} */ (error).message); process.exitCode = 1; }
