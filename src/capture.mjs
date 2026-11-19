import { addPair, drafts, saveDraft } from './records.mjs';
import { pairUp } from './match.mjs';
import { currentLogin, parsePullUrl, publishedOnPull } from './sources/github.mjs';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Looks up what the user actually published for each open draft headed to a GitHub pull request, and
 * turns each match into a raw pair. Drafts with nothing published after `giveUpDays` are closed as unposted.
 * @param {import('./store.mjs').Store} store
 * @param {{run: import('./sources/github.mjs').Run, giveUpDays?: number, now?: number}} options
 */
export async function matchGitHub(store, { run, giveUpDays = 14, now = Date.now() }) {
  const open = drafts(store).filter(draft => draft.status === 'open');
  /** @type {Map<string, {pr: {owner: string, repo: string, number: number}, items: typeof open}>} */
  const byPull = new Map();
  for (const draft of open) {
    const pr = parsePullUrl(draft.target);
    if (!pr) continue;
    const key = `${pr.owner}/${pr.repo}#${pr.number}`;
    if (!byPull.has(key)) byPull.set(key, { pr, items: [] });
    byPull.get(key)?.items.push(draft);
  }
  const result = { paired: 0, unposted: 0, waiting: 0 };
  if (!byPull.size) return result;
  const login = await currentLogin(run);
  for (const { pr, items } of byPull.values()) {
    const published = await publishedOnPull(run, pr, login);
    const matched = new Set();
    for (const kind of new Set(items.map(item => item.kind))) {
      for (const match of pairUp(items.filter(item => item.kind === kind), published.filter(item => item.kind === kind))) {
        addPair(store, { kind, before: match.draft.body, after: match.published.body, source: match.published.source, similarity: Number(match.similarity.toFixed(3)) });
        saveDraft(store, { ...match.draft, status: 'paired' }); matched.add(match.draft.id); result.paired += 1;
      }
    }
    for (const draft of items) if (!matched.has(draft.id)) {
      if (now - Date.parse(draft.createdAt) > giveUpDays * DAY) { saveDraft(store, { ...draft, status: 'unposted' }); result.unposted += 1; }
      else result.waiting += 1;
    }
  }
  return result;
}
