import { execFile } from 'node:child_process';

/** @typedef {(args: string[], input?: string) => Promise<string>} Run */

/** Runs the user's own `gh`, so ghostpen sees exactly what they can already see and nothing more. @returns {Run} */
export function ghRunner(bin = 'gh', { timeout = 20000, attempts = 3 } = {}) {
  const once = (/** @type {string[]} */ args, /** @type {string | undefined} */ input) => new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const failure = /** @type {NodeJS.ErrnoException & {killed?: boolean}} */ (error);
      reject(Object.assign(new Error(failure.code === 'ENOENT' ? 'The GitHub CLI (gh) is not installed.' : failure.killed ? 'GitHub did not answer in time.' : (stderr || error.message).trim().slice(0, 600)), { timedOut: Boolean(failure.killed) }));
    });
    child.stdin?.end(input ?? '');
  });
  // A read that stalls is retried; anything GitHub actually refused is reported as is. Writes are never retried.
  return async (args, input) => {
    const readOnly = !args.includes('--method') || args[args.indexOf('--method') + 1] === 'GET';
    for (let attempt = 1; ; attempt += 1) {
      try { return /** @type {string} */ (await once(args, input)); }
      catch (error) { if (!(/** @type {{timedOut?: boolean}} */ (error).timedOut) || !readOnly || attempt >= attempts) throw error; }
    }
  };
}

/** @param {string} value @returns {{owner: string, repo: string, number: number} | null} */
export function parsePullUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url.pathname);
  return url.hostname === 'github.com' && match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
}

const rows = (/** @type {string} */ output) => output.split('\n').filter(row => row.trim()).map(row => JSON.parse(row));

/** @param {Run} run */
export const currentLogin = async run => (await run(['api', 'user', '--jq', '.login'])).trim();

/**
 * Everything one person published on a pull request: line comments, conversation comments, review summaries and the description.
 * @param {Run} run @param {{owner: string, repo: string, number: number}} pr @param {string} login
 * @returns {Promise<{kind: string, body: string, source: string, at?: string, path?: string, line?: number}[]>}
 */
export async function publishedOnPull(run, pr, login) {
  const base = `repos/${pr.owner}/${pr.repo}`;
  const mine = `select(.user.login == "${login.replace(/[^\w-]/g, '')}")`;
  const [line, conversation, reviews, description] = await Promise.all([
    run(['api', '--paginate', `${base}/pulls/${pr.number}/comments?per_page=100`, '--jq', `.[] | ${mine} | {body, source: .html_url, at: .created_at, path, line: (.line // .original_line)}`]),
    run(['api', '--paginate', `${base}/issues/${pr.number}/comments?per_page=100`, '--jq', `.[] | ${mine} | {body, source: .html_url, at: .created_at}`]),
    run(['api', '--paginate', `${base}/pulls/${pr.number}/reviews?per_page=100`, '--jq', `.[] | ${mine} | select(.body != "") | {body, source: .html_url, at: .submitted_at}`]),
    run(['api', `${base}/pulls/${pr.number}`, '--jq', `${mine} | select(.body != null and .body != "") | {body, source: .html_url, at: .created_at}`]),
  ]);
  return [
    ...rows(line).map(item => ({ kind: 'pr-comment', ...item, line: item.line ?? undefined })),
    ...rows(conversation).map(item => ({ kind: 'pr-comment', ...item })),
    ...rows(reviews).map(item => ({ kind: 'pr-comment', ...item })),
    ...rows(description).map(item => ({ kind: 'pr-description', ...item })),
  ];
}

/** @typedef {{kind: string, body: string, source: string, at?: string, path?: string, line?: number}} Published */

const INVOLVED = `query($search: String!, $login: String!, $cursor: String) { search(query: $search, type: ISSUE, first: 25, after: $cursor) {
  pageInfo { hasNextPage endCursor } nodes { ... on PullRequest {
    reviews(author: $login, first: 10) { nodes { body url submittedAt comments(first: 20) { nodes { body url createdAt path line originalLine } } } }
    comments(first: 40) { nodes { author { login } body url createdAt } } } } } }`;

/**
 * What one person wrote on pull requests they reviewed or commented on: review summaries, line comments and
 * conversation comments. Read 25 pull requests per request, since one request per pull request stalls too often.
 * @param {Run} run @param {{login: string, repos?: string[], before?: string, pages?: number}} options @returns {Promise<Published[]>}
 */
export async function commentWriting(run, { login, repos = [], before, pages = 4 }) {
  /** @type {Map<string, Published>} */
  const found = new Map();
  for (const role of ['reviewed-by', 'commenter']) for (const repo of repos.length ? repos : ['']) {
    const search = ['type:pr', `${role}:${login}`, repo ? `repo:${repo}` : '', before ? `created:<${before}` : '', 'sort:created-desc'].filter(Boolean).join(' ');
    /** @type {string | undefined} */
    let cursor;
    for (let page = 0; page < pages; page += 1) {
      const batch = JSON.parse(await run(['api', 'graphql', '-f', `query=${INVOLVED}`, '-f', `search=${search}`, '-f', `login=${login}`, ...(cursor ? ['-f', `cursor=${cursor}`] : [])])).data.search;
      for (const pull of batch.nodes) {
        for (const review of pull.reviews?.nodes || []) {
          if (review.body) found.set(review.url, { kind: 'pr-comment', body: review.body, source: review.url, at: review.submittedAt });
          for (const comment of review.comments.nodes) found.set(comment.url, { kind: 'pr-comment', body: comment.body, source: comment.url, at: comment.createdAt, path: comment.path, line: comment.line ?? comment.originalLine ?? undefined });
        }
        for (const comment of pull.comments?.nodes || []) if (comment.author?.login === login) found.set(comment.url, { kind: 'pr-comment', body: comment.body, source: comment.url, at: comment.createdAt });
      }
      if (!batch.pageInfo.hasNextPage) break;
      cursor = batch.pageInfo.endCursor;
    }
  }
  return [...found.values()];
}

/** Descriptions of pull requests the user opened. The search results carry the text, so there is no call per pull request. @param {Run} run @param {{login: string, repos?: string[], before?: string, pages?: number}} options @returns {Promise<Published[]>} */
export async function descriptionWriting(run, { login, repos = [], before, pages = 2 }) {
  /** @type {Published[]} */
  const found = [];
  for (const repo of repos.length ? repos : ['']) for (let page = 1; page <= pages; page += 1) {
    const query = ['type:pr', `author:${login}`, repo ? `repo:${repo}` : '', before ? `created:<${before}` : ''].filter(Boolean).join(' ');
    const listed = rows(await run(['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'sort=created', '-f', 'per_page=100', '-f', `page=${page}`, '--jq', '.items[] | select(.body != null and .body != "") | {body, source: .html_url, at: .created_at}']));
    found.push(...listed.map(item => ({ kind: 'pr-description', ...item })));
    if (listed.length < 100) break;
  }
  return found;
}
