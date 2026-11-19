import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Version of a single record's shape. */
export const RECORD_VERSION = 1;
export const KINDS = ['pr-comment', 'pr-description', 'commit-message', 'issue', 'document', 'message', 'other'];

/**
 * A logged draft: what an agent wrote on the user's behalf, before the user touched it. Raw text, local only.
 * @typedef {object} Draft
 * @property {string} id
 * @property {number} version
 * @property {string} kind
 * @property {string} body
 * @property {string} target   where it is headed: a URL when known, otherwise a short description
 * @property {string} [path]
 * @property {number} [line]
 * @property {string} createdAt
 * @property {'open'|'paired'|'unposted'} status
 */

/**
 * A raw before/after pair waiting to be sanitized. Local only.
 * @typedef {object} Pair
 * @property {string} id
 * @property {number} version
 * @property {string} kind
 * @property {string} before
 * @property {string} after
 * @property {string} source  pointer to the published text; empty when it was never published
 * @property {number} similarity  0..1, how much of the draft survived
 * @property {string} createdAt
 */

/**
 * A sanitized pair, safe to commit: the shape of the edit without the specifics.
 * @typedef {object} Evidence
 * @property {string} id
 * @property {number} version
 * @property {string} kind
 * @property {string} before
 * @property {string} after
 * @property {string} source
 * @property {number} similarity
 * @property {string} recordedAt
 */

const dirFor = (/** @type {import('./store.mjs').Store} */ store, /** @type {'drafts'|'pairs'} */ name) => path.join(store.cache, name);
/** @template {{id: string}} T @param {string} dir @param {T} record @returns {T} */
const write = (dir, record) => {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return record;
};
/** @template T @param {string} dir @returns {T[]} */
const readAll = dir => !fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort()
  .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));

const kindOf = (/** @type {string} */ kind) => { if (!KINDS.includes(kind)) throw new Error(`Unknown kind "${kind}". Use one of: ${KINDS.join(', ')}.`); return kind; };
const textOf = (/** @type {unknown} */ value, /** @type {string} */ label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is empty.`); return value; };

/** @param {import('./store.mjs').Store} store @param {{kind: string, body: string, target?: string, path?: string, line?: number}} input @returns {Draft} */
export function logDraft(store, input) {
  return write(dirFor(store, 'drafts'), { id: randomUUID(), version: RECORD_VERSION, kind: kindOf(input.kind), body: textOf(input.body, 'Draft'),
    target: input.target || '', ...(input.path ? { path: input.path } : {}), ...(Number.isInteger(input.line) ? { line: input.line } : {}),
    createdAt: new Date().toISOString(), status: /** @type {const} */ ('open') });
}
/** @param {import('./store.mjs').Store} store @returns {Draft[]} */
export const drafts = store => readAll(dirFor(store, 'drafts'));
/** @param {import('./store.mjs').Store} store @param {Draft} draft */
export const saveDraft = (store, draft) => write(dirFor(store, 'drafts'), draft);

/** @param {import('./store.mjs').Store} store @param {{kind: string, before: string, after: string, source?: string, similarity: number}} input @returns {Pair} */
export function addPair(store, input) {
  return write(dirFor(store, 'pairs'), { id: randomUUID(), version: RECORD_VERSION, kind: kindOf(input.kind), before: textOf(input.before, 'Before'),
    after: textOf(input.after, 'After'), source: input.source || '', similarity: input.similarity, createdAt: new Date().toISOString() });
}
/** @param {import('./store.mjs').Store} store @returns {Pair[]} */
export const pairs = store => readAll(dirFor(store, 'pairs'));
/** @param {import('./store.mjs').Store} store @param {string} id */
export const removePair = (store, id) => fs.rmSync(path.join(dirFor(store, 'pairs'), `${id}.json`), { force: true });

/** @param {import('./store.mjs').Store} store @returns {Evidence[]} */
export const evidence = store => readAll(store.evidence);
/** @param {import('./store.mjs').Store} store @param {Evidence} record */
export function saveEvidence(store, record) {
  fs.mkdirSync(store.evidence, { recursive: true });
  fs.writeFileSync(path.join(store.evidence, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n');
  return record;
}
