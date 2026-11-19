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
 * @returns {Promise<{kind: string, body: string, source: string, path?: string, line?: number}[]>}
 */
export async function publishedOnPull(run, pr, login) {
  const base = `repos/${pr.owner}/${pr.repo}`;
  const mine = `select(.user.login == "${login.replace(/[^\w-]/g, '')}")`;
  const [line, conversation, reviews, description] = await Promise.all([
    run(['api', '--paginate', `${base}/pulls/${pr.number}/comments?per_page=100`, '--jq', `.[] | ${mine} | {body, source: .html_url, path, line: (.line // .original_line)}`]),
    run(['api', '--paginate', `${base}/issues/${pr.number}/comments?per_page=100`, '--jq', `.[] | ${mine} | {body, source: .html_url}`]),
    run(['api', '--paginate', `${base}/pulls/${pr.number}/reviews?per_page=100`, '--jq', `.[] | ${mine} | select(.body != "") | {body, source: .html_url}`]),
    run(['api', `${base}/pulls/${pr.number}`, '--jq', `${mine} | select(.body != null and .body != "") | {body, source: .html_url}`]),
  ]);
  return [
    ...rows(line).map(item => ({ kind: 'pr-comment', ...item, line: item.line ?? undefined })),
    ...rows(conversation).map(item => ({ kind: 'pr-comment', ...item })),
    ...rows(reviews).map(item => ({ kind: 'pr-comment', ...item })),
    ...rows(description).map(item => ({ kind: 'pr-description', ...item })),
  ];
}
