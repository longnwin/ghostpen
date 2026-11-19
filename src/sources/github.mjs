import { execFile } from 'node:child_process';

/** @typedef {(args: string[], input?: string) => Promise<string>} Run */

/** Runs the user's own `gh`, so ghostpen sees exactly what they can already see and nothing more. @returns {Run} */
export function ghRunner(bin = 'gh') {
  return (args, input) => new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' ? 'The GitHub CLI (gh) is not installed.' : (stderr || error.message).trim().slice(0, 600)));
      else resolve(stdout);
    });
    child.stdin?.end(input ?? '');
  });
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

/**
 * Pull requests one person took part in, newest first. `role` is a GitHub search qualifier: `commenter` or `author`.
 * @param {Run} run @param {{login: string, role: 'commenter' | 'author', repos?: string[], before?: string, pages?: number}} options
 * @returns {Promise<{owner: string, repo: string, number: number}[]>}
 */
export async function pullsInvolving(run, { login, role, repos = [], before, pages = 2 }) {
  const scopes = repos.length ? repos : [''];
  const found = new Map();
  for (const repo of scopes) for (let page = 1; page <= pages; page += 1) {
    const query = ['type:pr', `${role}:${login}`, repo ? `repo:${repo}` : '', before ? `created:<${before}` : ''].filter(Boolean).join(' ');
    const listed = rows(await run(['api', '-X', 'GET', 'search/issues', '-f', `q=${query}`, '-f', 'sort=created', '-f', 'per_page=100', '-f', `page=${page}`, '--jq', '.items[] | {url: .html_url}']));
    for (const item of listed) { const pr = parsePullUrl(item.url); if (pr) found.set(item.url, pr); }
    if (listed.length < 100) break;
  }
  return [...found.values()];
}
