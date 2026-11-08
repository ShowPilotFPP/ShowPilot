# Writing ShowPilot help pages

Help pages are Markdown files in `public/admin/help/`, listed in
`manifest.json`, shown by `help.js` in the F1 panel (460 px wide) and on the
full docs page (`/admin/help/`). Readers are light-show owners: comfortable
with computers, not programmers.

## Rules

- **Only document what exists.** Read the admin's markup (`public/admin/index.html`,
  the matching `data-pane` / `data-subtab` section), the JavaScript that saves
  each setting, and the server route that uses it before describing it. Never
  invent a setting, default, limit or behaviour. If unsure, leave it out.
- **Use the exact on-screen names** for pages, tabs, buttons and settings, in
  **bold** the first time.
- **Plain English, second person, present tense.** "Turn this on to…", "When
  a viewer taps…". No internal names (no function names, table names, config
  keys) unless the user has to type them (e.g. a template placeholder, a file
  path they edit).
- **Explain why and when**, not just what: what changes for viewers, sensible
  values, what to watch out for.
- Never mention any hosting company, product or plan names. If a setting is
  hidden or locked "by the server's host", say that generically.
- Don't document version history ("since v0.33.x").

## Shape of a page

```
# Page title                      ← one H1, e.g. "Settings › Audio"

One or two sentences: what this page is for.

## First setting or area name     ← H2 per setting or group, exact on-screen label

What it does. When to change it. Default if visible in the code.

> **Tip:** short practical advice.
> **Careful:** something that can go wrong (use Careful/Warning/Important for warnings).

## Next setting…
```

- Group small related settings under one H2 with a short list or a table
  (`| Setting | What it does |`).
- Link to other help pages with `[text](help:doc-id)` or
  `[text](help:doc-id#heading-slug)` (slug = heading lower-cased, spaces and
  punctuation → `-`).
- Supported Markdown: `#`/`##`/`###`, paragraphs, `-` and `1.` lists, **bold**,
  *italic*, `code`, fenced code blocks, `>` notes, `|` tables, links. Nothing
  else (no images, no HTML).
- Length: as long as the page needs, usually 400–1,200 words. Settings pages
  cover every setting on that page.
