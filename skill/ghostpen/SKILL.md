---
name: ghostpen
description: Use before writing anything that will be posted or sent under the user's name — PR comments and descriptions, commit messages, issues and tickets, specs and documents, chat or email messages. Loads the user's voice guide so the draft sounds like them, and logs the draft so their later edits can be learned from. Not for replies to the user in chat.
---

# Write in the user's voice

`{{GHOSTPEN}}` is the ghostpen command on this machine. Use it exactly as written.

## Before drafting

1. Run `{{GHOSTPEN}} guide` to get the path of the voice guide, then read that file.
2. Follow it. The core section applies to everything; a "By kind" section applies only to that kind of writing. Where the guide is silent, write plainly and briefly.

The guide is about wording, tone and structure. It never changes what is true: do not drop a caveat or soften a finding to match a style rule.

## After drafting

Log each piece of text you drafted for the user to publish, before they edit it:

```sh
{{GHOSTPEN}} draft --kind <kind> --target "<where it is headed>" --file - <<'DRAFT'
<the text exactly as you drafted it>
DRAFT
```

- `--kind` is one of `pr-comment`, `pr-description`, `commit-message`, `issue`, `document`, `message`, `other`.
- `--target` is the URL it will be published at when you know it (for a pull request, the pull request URL), otherwise a few words.
- For a comment on a line of code, add `--path <file> --line <n>`.

Log the text once, as first drafted. Do not log later revisions of the same piece, and do not log text the user wrote themselves.

## Boundaries

- This skill never authorizes publishing. Post, send or commit only when the user asked for that.
- The logged draft stays on this machine. Do not copy it anywhere else.
- If the command fails, carry on with the task and mention it once; do not retry in a loop.
