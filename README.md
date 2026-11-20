# ghostpen

Teaches your coding agents to write like you, by learning from how you edit what they draft.

When an agent writes a PR comment, a PR description or a commit message for you, it usually sounds like an agent. You fix it and post it. `ghostpen` keeps the draft, finds what you actually published, and turns the difference into a short voice guide that every agent reads before it writes under your name.

## Install

Needs Node 20 or newer and `git`. The GitHub CLI (`gh`) is needed for the GitHub features.

```sh
npx github:longnwin/ghostpen init
```

`init` asks a few questions and does the wiring itself. You don't edit any files by hand.

1. **Which agents to set up.** It detects Claude Code and Codex and lists each with its skills folder.
2. **Where your voice lives.** A folder for the guide and its evidence, kept as a local git repo.
3. **Whether to create a private GitHub repo for it**, so other machines can use the same voice.
   If the store has a remote, it also asks **whether to keep it in step automatically** (off unless you say yes).
4. **Where the "read my voice guide" line goes.** It looks at what each agent already loads in every session and offers the best place first: a shared notes file if all your agents load one, otherwise each agent's own instructions file.
5. **How voice updates are prepared.** Only the options that exist on your machine: ask at the start of a session, a daily Paseo schedule, or cron.
6. **Whether to build a first guide from what you've already written on GitHub.**
7. **Whether to look through your own skills** for places that write text for you.

Running `init` again is safe. It skips what is already in place.

On a second machine, pass your voice repo:

```sh
npx github:longnwin/ghostpen init --from <your voice repo URL>
```

Add `--sync auto` to have that machine pull and push by itself; see [More than one machine](#more-than-one-machine).

Codex ignores new hooks until you trust them. After `init`, open Codex, run `/hooks`, and trust the `SessionStart` entry whose command ends in `hook session-start`.

### Have your agent install it

`init` asks its questions in a terminal. An agent has no terminal, so `init` takes every default without
asking, and the defaults are the cautious ones: a new store in `~/.ghostpen/voice`, no GitHub repo, no
syncing, no schedule, no seeding. Pass the answers you want as flags.

Paste this to your coding agent, with the command edited to suit:

```text
Set up ghostpen on this machine. Do exactly these steps and stop if one fails.

1. Check `node --version` (20 or newer) and `git --version`. Do not install or upgrade anything.
2. Run:

   npx --yes github:longnwin/ghostpen init --yes --schedule session

3. Run `~/.local/bin/ghostpen doctor` and show me all of its output.
4. Tell me which files it changed outside the voice store, and repeat any
   "one step left for you" line it printed, word for word.

Do not create or change credentials. Do not run `ghostpen seed`, `distil` or
`integrate`, and do not edit my skills or settings yourself.
```

| Flag | Answers | Without it |
| --- | --- | --- |
| `--from <git url>` | Use an existing voice repo (a second machine) | Creates a new store |
| `--store <folder>` | Where the store lives | `~/.ghostpen/voice` |
| `--agents claude,codex` | Which agents to set up | Every agent it finds |
| `--remote <name>` | Create a private GitHub repo with this name (needs `gh`) | No repo |
| `--sync auto` | Pull and push by itself | Off, or what the machine already has |
| `--instructions <file>`, `each` or `none` | Where the "read my voice guide" line goes | The best shared file it finds |
| `--schedule session`, `paseo` or `cron` | How voice updates are prepared | `session`, or what the machine already has |
| `--provider <provider>` or `<provider>/<model>` | The agent a Paseo schedule runs as | Required the first time with `--schedule paseo` |
| `--seed all` or `<owner/repo,...>` | Collect your past writing for a first guide (needs `gh`) | Starts empty |
| `--seed-before <YYYY-MM-DD>` | Only writing from before this date | No cutoff |
| `--integrate yes` | Offer to check your skills at your next session | No |

Running `init` again is how a machine picks up a newer ghostpen, and how you change an answer. It keeps what
you chose before: the store, the agents, the sync setting and the schedule. A schedule that is already in
place is left alone unless you pass a different `--schedule` or `--provider`.

## How it works

**The guide.** One file, `VOICE.md`, with a core section that applies to everything and short sections for what differs by kind of writing. Agents read it before drafting. It's plain Markdown, so you can edit it yourself.

**Capture.** A skill tells the agent to log each draft it hands you. Later, `ghostpen match` fetches what you published on GitHub under your own account and pairs it with the draft. Nothing has to report back when you post.

**Distil.** Your agent reads the new pairs, rewrites each one with the specifics removed, and proposes changes to the guide. A rule needs at least two pieces of evidence.

**Approval.** Proposals never apply themselves. You read one and accept or reject it.

```sh
ghostpen proposals
ghostpen proposals show <id>
ghostpen proposals accept <id>
```

## More than one machine

The voice store is a git repository, so machines share it through its remote. By default nothing is sent or
fetched unless you ask:

```sh
ghostpen sync          # pull what other machines pushed, then push what this one committed
ghostpen sync auto     # have this machine do that by itself from now on
ghostpen sync off      # back to doing it by hand
```

With automatic syncing on, a machine pulls in the background when an agent session starts and pushes after
each change to the store (new evidence, a proposal, an accepted or rejected proposal). It also pulls before
distilling, so a voice update works from everything every machine has gathered.

- **What travels:** the guide, sanitized evidence and proposals. Raw drafts, unsanitized pairs and writing
  samples stay in `.cache`, which git ignores. They never leave the machine.
- **It never gets in the way.** Network steps are time-limited and run in the background. Being offline is
  not an error; the commits wait and go out next time.
- **It never picks a winner.** If two machines changed the same part of the store, typically by accepting
  different proposals, the sync stops, leaves both versions exactly as they were, and tells you at the start
  of your next session. Settle it in the store with `git pull --rebase`, then run `ghostpen sync`.
- **It never forces.** No force-push, no discarded commits, no merge commits: local commits are replayed on
  top of the remote's.

`ghostpen doctor` and `ghostpen status` show whether a machine syncs automatically and how many changes are
waiting in each direction.

Let one machine prepare voice updates on a schedule and leave the others on "ask at the start of a session".
Two machines distilling the same evidence on the same day can each propose the same change.

## A first guide from past writing

Without this, the guide starts empty and fills in slowly.

```sh
ghostpen seed collect --before 2025-06-01
ghostpen seed --run
```

`seed collect` gathers your own review comments and PR descriptions. It skips text that an agent or bot wrote, one-liners and duplicates, and samples evenly across time. Use `--before` with a date from before agents started drafting for you, otherwise the guide learns their voice instead of yours. `--repo owner/name` limits it to certain repositories.

`seed --run` has your agent turn the samples into a proposal. Rules from seeding are marked as seeded: they come from what you wrote, not from what you changed, so later edits can overturn them.

## Your own skills

If you have skills that draft text for you, `integrate` adds a short step to them: read the guide before writing, log the draft after.

```sh
ghostpen integrate --run
```

Your agent finds the places and proposes each one, then the command shows you each proposal and asks whether to add it. `ghostpen` writes the inserted text, so the agent only chooses where it goes. Nothing is committed for you. `ghostpen integrate decide` asks again about anything you skipped. Only skills in your own user-level skills folder are considered.

## What is stored, and where

| What | Where | In git? |
| --- | --- | --- |
| The guide | `VOICE.md` in your voice store | Yes |
| Sanitized examples, with a link to the original | `evidence/` | Yes |
| Proposals waiting for you | `proposals/` | Yes |
| Raw drafts, raw pairs and writing samples | `.cache/` | No, never |
| What `init` set up on this machine | `~/.config/ghostpen/config.json` | No |

Raw text stays on the machine it was captured on. Before an example is saved, identifiers, file paths, ticket keys and names are rewritten into neutral stand-ins, and the save is refused if any of them survive. That check is mechanical and can miss things, which is one reason you approve proposals yourself.

The links kept with each example name the repository and pull request they came from. If your voice repo is ever shared, those names are visible even though the text is not.

`ghostpen` uses your own `gh` login and your own agents. It has no service of its own and sends nothing anywhere else.

## Commands

```
ghostpen init [--from <git url>]     Set up this machine
ghostpen doctor                      Check that everything init set up is still in place
ghostpen uninstall                   Remove what init wired up; your voice store is kept
ghostpen status                      Counts of drafts, pairs and evidence
ghostpen guide                       Print where the voice guide lives
ghostpen match                       Pair logged drafts with what you published on GitHub
ghostpen distil [--print | --run]    Propose guide changes from new edits
ghostpen seed collect | --run        Build a first guide from past writing
ghostpen integrate --run             Add the voice step to your own skills
ghostpen proposals [show|accept|reject <id>]
```

`ghostpen help` lists the rest, including the commands agents use to log drafts and save evidence.

`init` installs the command as `~/.local/bin/ghostpen`. If that folder is on your PATH you can type `ghostpen`; `init` tells you when it isn't. Skills and steps refer to it as `~/.local/bin/ghostpen`, so the same text works on every machine you set up.

## Limits

- **GitHub only.** Matching and seeding read GitHub. Text you publish elsewhere is learned from only if a tool records the draft and the final with `ghostpen record`.
- **Pull requests only, for now.** Commit messages and issues have kinds but nothing fetches them yet.
- **Agents have to cooperate.** Logging depends on the agent following the skill. `integrate` makes that dependable for your own skills.
- **A proposal is a whole new guide.** You accept or reject it as one piece.
- **Unix.** Tested on Linux. The cron option does not exist on Windows.

## Development

```sh
npm test
npm run typecheck
```

Plain JavaScript with types checked from comments. There is no build step, and tests use fictional fixtures only.

## License

MIT
