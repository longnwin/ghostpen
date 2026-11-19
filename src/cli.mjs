#!/usr/bin/env node
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readConfig, writeConfig } from './config.mjs';
import { commit, createStore, storeAt } from './store.mjs';
import { RECORD_VERSION, addPair, drafts, evidence, logDraft, pairs, removePair, saveEvidence } from './records.mjs';
import { similarity } from './match.mjs';
import { leakedSpecifics } from './leaks.mjs';
import { matchGitHub } from './capture.mjs';
import { ghRunner } from './sources/github.mjs';

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
  ghostpen status                    Counts of drafts, pairs and evidence
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
  } else if (command === 'status') {
    const target = store(), all = drafts(target);
    print({ store: target.root, drafts: { open: all.filter(d => d.status === 'open').length, paired: all.filter(d => d.status === 'paired').length, unposted: all.filter(d => d.status === 'unposted').length },
      pairsWaiting: pairs(target).length, evidence: evidence(target).length });
  } else { print(HELP); if (command && command !== 'help') process.exitCode = 1; }
} catch (error) { console.error(/** @type {Error} */ (error).message); process.exitCode = 1; }
