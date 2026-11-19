/** Lowercased word pairs; comparing these tolerates reordering less than single words, which is what we want for edits. */
const bigrams = (/** @type {string} */ text) => {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_']+/gu) || [];
  const set = new Set();
  for (let i = 0; i < words.length - 1; i += 1) set.add(`${words[i]} ${words[i + 1]}`);
  if (words.length === 1) set.add(words[0]);
  return set;
};

/** How much two texts share, 0 (nothing) to 1 (same wording). @param {string} a @param {string} b */
export function similarity(a, b) {
  const left = bigrams(a), right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * Pairs each draft with the published text it most likely became. A published text is used once.
 * Location (same file and line) can stand in for wording, since a heavy rewrite keeps its anchor.
 * @template {{body: string, path?: string, line?: number}} D
 * @template {{body: string, path?: string, line?: number}} P
 * @param {D[]} draftList @param {P[]} published @param {{threshold?: number}} [options]
 * @returns {{draft: D, published: P, similarity: number}[]}
 */
export function pairUp(draftList, published, { threshold = 0.3 } = {}) {
  const candidates = [];
  for (const draft of draftList) for (const item of published) {
    const score = similarity(draft.body, item.body);
    const sameSpot = Boolean(draft.path) && draft.path === item.path && draft.line === item.line;
    if (score >= threshold || (sameSpot && score >= threshold / 3)) candidates.push({ draft, published: item, similarity: score, rank: score + (sameSpot ? 0.5 : 0) });
  }
  candidates.sort((a, b) => b.rank - a.rank);
  const usedDrafts = new Set(), usedPublished = new Set(), result = [];
  for (const { rank, ...candidate } of candidates) {
    if (usedDrafts.has(candidate.draft) || usedPublished.has(candidate.published)) continue;
    usedDrafts.add(candidate.draft); usedPublished.add(candidate.published); result.push(candidate);
  }
  return result;
}
