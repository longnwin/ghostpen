# Distil: turn edits into voice rules

You are updating one person's voice guide from evidence of how they edit drafts. Work only through the
`{{GHOSTPEN}}` command and the files it names. Do not publish, post or push anything.

## 1. Collect

Run `{{GHOSTPEN}} match` to pair logged drafts with what was actually published, then `{{GHOSTPEN}} pairs`
to list the raw pairs waiting. Each has `before` (the agent's draft) and `after` (what the user published).
If there are none and no evidence has been added since the last accepted proposal, stop.

## 2. Sanitize each pair

Raw pairs contain real names and code and must not be stored. For each pair write a sanitized `before` and
`after` that keep the shape of the edit and lose the specifics:

- Replace identifiers, file paths, ticket keys, product, customer and people names with neutral stand-ins
  ("this function", "the handler", "the config file"). Keep ordinary words exactly as the user wrote them.
- Keep length, sentence structure, punctuation, hedging, greetings and sign-offs faithful. Those are the signal.
- Never invent an edit that did not happen.

Save it with `{{GHOSTPEN}} evidence add --pair <id> --before <file> --after <file>`. The command refuses text
that still contains specifics from the original; rewrite those and try again.

## 3. Propose guide changes

Read the guide (`{{GHOSTPEN}} guide`) and all evidence (`{{GHOSTPEN}} evidence list`). Look for edits the user
makes repeatedly: what they cut, what they add, words they replace, how they open and close, how long they
let things run. A rule needs at least two independent pieces of evidence, or one explicit instruction from
the user. Where evidence contradicts an existing rule, change or remove the rule.

Write the complete new guide to a file:

- Keep it short. One rule per line, stated as what to do, with one brief neutral example where it helps.
- Core holds what is true for every kind of writing. "By kind" holds only what differs for one kind.
- After each rule, note its support in parentheses: how many edits, and which kinds.
- Change as little as the evidence supports. Do not restyle rules that are not affected.

Then run `{{GHOSTPEN}} proposals add --summary "<one or two sentences on what changed and why>" --guide <file>
--evidence <comma-separated evidence ids>`. If nothing should change, add no proposal.

The proposal is not applied. The user reviews and accepts it later.
