import { execFileSync, spawnSync } from 'node:child_process';

/**
 * A way to run the distil step on a schedule. Each one can tell whether it is usable here, set itself up, and remove itself.
 * @typedef {object} Scheduler
 * @property {string} id
 * @property {string} label
 * @property {string} note      what the user should know before choosing it
 * @property {() => boolean} available
 * @property {(context: {command: string, prompt: string, store: string}) => Record<string, string>} install  returns what `remove` needs
 * @property {(state: Record<string, string>) => void} remove
 */

const works = (/** @type {string} */ bin, /** @type {string[]} */ args) => spawnSync(bin, args, { stdio: 'ignore' }).status === 0;
const CRON_TAG = '# ghostpen distil';
const crontab = () => { const result = spawnSync('crontab', ['-l'], { encoding: 'utf8' }); return result.status === 0 ? result.stdout : ''; };
const setCrontab = (/** @type {string} */ text) => execFileSync('crontab', ['-'], { input: text.trim() ? text.replace(/\n*$/, '\n') : '' });

/** @type {Scheduler[]} */
export const schedulers = [
  { id: 'session', label: 'Ask me at the start of a session, when new edits have built up', note: 'Nothing runs in the background.',
    available: () => true, install: () => ({}), remove: () => {} },
  { id: 'paseo', label: 'Paseo schedule, daily', note: 'Runs on this machine through your Paseo daemon, as your default agent.',
    available: () => works('paseo', ['--version']),
    install: ({ prompt, store }) => {
      const created = JSON.parse(execFileSync('paseo', ['schedule', 'create', '--cron', '0 9 * * *', '--name', 'ghostpen-distil', '--cwd', store, '--json', prompt], { encoding: 'utf8' }));
      const id = created.id || created.schedule?.id;
      if (!id) throw new Error('Paseo did not return a schedule id.');
      return { id: String(id) };
    },
    remove: state => { if (state.id) execFileSync('paseo', ['schedule', 'delete', state.id], { stdio: 'ignore' }); } },
  { id: 'cron', label: 'System scheduler (cron), daily', note: 'Runs your agent headlessly on this machine; skipped while the machine is off.',
    available: () => process.platform !== 'win32' && works('sh', ['-c', 'command -v crontab']),
    install: ({ command }) => {
      const kept = crontab().split('\n').filter(line => !line.includes(CRON_TAG)).join('\n');
      setCrontab(`${kept}\n0 9 * * * ${command} distil --run >/dev/null 2>&1 ${CRON_TAG}\n`);
      return {};
    },
    remove: () => setCrontab(crontab().split('\n').filter(line => !line.includes(CRON_TAG)).join('\n')) },
];
/** @param {string} id */
export const schedulerById = id => schedulers.find(item => item.id === id) || (() => { throw new Error(`Unknown schedule option "${id}".`); })();
