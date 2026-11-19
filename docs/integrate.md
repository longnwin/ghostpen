# Integrate: add the voice step to the user's own skills

Some of the user's skills tell an agent to write text that is published under the user's name. You are finding
those places so the voice step can be added there. Work only through the `{{GHOSTPEN}}` command. You propose
places; you do not edit any skill file yourself, and nothing is applied without the user's approval.

## 1. Find candidates

Run `{{GHOSTPEN}} integrate candidates`. It lists instruction files in the user's own skills folders whose text
mentions writing comments, descriptions, messages or documents, with the matching lines. Files marked
`integrated` already have the step; skip them.

## 2. Judge each file

Read each candidate file. Propose a place only where the file instructs an agent to compose text that will be
posted, sent or committed as the user: a PR comment or description, a commit message, an issue or ticket, a
spec or document, a message. Do not propose for:

- text written back to the user in chat, or reports and plans kept locally
- reviews and findings that are saved to a file and never posted
- instructions that only read or summarize what someone else wrote
- places where another instruction file already covers the same writing step

Choose the line the step should follow: the line that introduces the writing, so an agent meets the step just
before it starts drafting. One place per file.

## 3. Propose

For each place, run `{{GHOSTPEN}} integrate propose --file <path> --after-line <n> --kind <kind> --note "<one
sentence: what this step writes and where it is published>"`. `--kind` is one of `pr-comment`,
`pr-description`, `commit-message`, `issue`, `document`, `message`, `other`.

## 4. Ask the user

Run `{{GHOSTPEN}} integrate review` and show the user its output: each proposal with the exact lines to be
added. Ask which to apply. For each one they approve run `{{GHOSTPEN}} integrate apply <id>`; for each they
decline run `{{GHOSTPEN}} integrate dismiss <id>`. Do not commit or push the changed files; tell the user
which files changed so they can review and commit them.
