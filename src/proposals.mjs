import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { commit } from './store.mjs';
import { RECORD_VERSION } from './records.mjs';

const hash = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');
const fileFor = (/** @type {import('./store.mjs').Store} */ store, /** @type {string} */ id) => path.join(store.proposals, `${id}.json`);

/**
 * A complete replacement guide waiting for the user's approval.
 * @typedef {{id: string, version: number, summary: string, guide: string, baseHash: string, evidence: string[], createdAt: string}} Proposal
 */

/** @param {import('./store.mjs').Store} store @returns {Proposal[]} */
export const proposals = store => !fs.existsSync(store.proposals) ? [] : fs.readdirSync(store.proposals).filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(fs.readFileSync(path.join(store.proposals, name), 'utf8'))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** @param {import('./store.mjs').Store} store @param {{summary: string, guide: string, evidence?: string[]}} input */
export function addProposal(store, input) {
  if (!input.summary.trim() || !input.guide.trim()) throw new Error('A proposal needs a summary and the full new guide.');
  const current = fs.readFileSync(store.guide, 'utf8');
  if (input.guide.trim() === current.trim()) throw new Error('The proposed guide is the same as the current one.');
  /** @type {Proposal} */
  const proposal = { id: randomUUID(), version: RECORD_VERSION, summary: input.summary.trim(), guide: input.guide.trimEnd() + '\n', baseHash: hash(current), evidence: input.evidence || [], createdAt: new Date().toISOString() };
  fs.mkdirSync(store.proposals, { recursive: true });
  fs.writeFileSync(fileFor(store, proposal.id), JSON.stringify(proposal, null, 2) + '\n');
  commit(store, 'Propose a voice guide change');
  return proposal;
}

const find = (/** @type {import('./store.mjs').Store} */ store, /** @type {string} */ id) => {
  const matches = proposals(store).filter(item => item.id.startsWith(id));
  if (matches.length !== 1) throw new Error(matches.length ? 'More than one proposal starts with that id.' : 'No proposal has that id.');
  return matches[0];
};

/** Applies a proposal. Refuses when the guide changed after the proposal was written, since it would undo that change. */
export function acceptProposal(/** @type {import('./store.mjs').Store} */ store, /** @type {string} */ id) {
  const proposal = find(store, id);
  if (hash(fs.readFileSync(store.guide, 'utf8')) !== proposal.baseHash) throw new Error('The guide has changed since this proposal was written. Reject it and distil again.');
  fs.writeFileSync(store.guide, proposal.guide);
  fs.rmSync(fileFor(store, proposal.id));
  commit(store, `Update voice guide: ${proposal.summary.split('\n')[0].slice(0, 72)}`);
  return proposal;
}
export function rejectProposal(/** @type {import('./store.mjs').Store} */ store, /** @type {string} */ id) {
  const proposal = find(store, id);
  fs.rmSync(fileFor(store, proposal.id));
  commit(store, 'Reject a voice guide proposal');
  return proposal;
}
