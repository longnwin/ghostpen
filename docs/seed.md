# Seed: a first voice guide from past writing

You are writing the first version of one person's voice guide from samples of what they published themselves.
Work only through the `{{GHOSTPEN}}` command and the files it names. Do not publish, post or push anything.

## 1. Read the samples

Run `{{GHOSTPEN}} seed samples`. Each sample has a `kind`, the text, and where it was published. Text written by
agents or bots was filtered out already; if a sample still reads as machine-written or as a pasted template, ignore it.

## 2. Find the habits

Look for what holds across many samples, not what one sample happens to do:

- length, and how much they say before stopping
- how they open and close; greetings, sign-offs, thanks
- directness: do they assert, ask, or hedge, and with which words
- words and phrases they favour, and ones that never appear
- punctuation, capitalisation, lists versus sentences, use of code formatting
- how they phrase a request for a change

A habit needs support from at least five samples to become a rule. Describe what they do; do not improve on it.

## 3. Save a few examples as evidence

Pick eight to twelve samples that show the habits clearly. For each, write a sanitized copy: replace identifiers,
file paths, ticket keys and product, customer and people names with neutral stand-ins, and keep everything else,
including length and punctuation, as written. Save it with
`{{GHOSTPEN}} evidence add-sample --sample <id> --text <file>`. The command refuses text that still contains
specifics from the original.

## 4. Propose the guide

Read the current guide (`{{GHOSTPEN}} guide`). Write the complete new guide to a file:

- Keep its `# Voice`, `## Core` and `## By kind` headings. One rule per line, stated as what to do, with a
  short neutral example where it helps.
- Core holds what is true across kinds. "By kind" holds only what differs for one kind.
- End each rule with its support, for example "(seeded, 23 samples, pr-comment)". Seeded rules are provisional:
  they come from what the person wrote, not from what they changed, and later edits may overturn them.
- Aim for fifteen rules or fewer. A short guide that is right beats a long one that guesses.

Then run `{{GHOSTPEN}} proposals add --summary "First guide, seeded from <n> samples of past writing." --guide <file>
--evidence <comma-separated evidence ids>`.

The proposal is not applied. Tell the user it is ready and that `{{GHOSTPEN}} proposals` lists it.
